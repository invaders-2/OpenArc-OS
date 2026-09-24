/**
 * D5-03 第一批 · MCP 连接管理（CRUD / 启停 / 白名单 / URL 校验 / 凭据边界 / 授权）。
 *
 * 全部走真实链路：真实 IdentityStore + AuthorizationService + McpStore + mcp:command IPC。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createMcpFixture, ECHO, domain, MCP_COMMANDS, MCP_TOOL_INVOCATION_COMMANDS } from "./mcp-fixtures.mjs";

async function withFixture(fn, options = {}) {
  const fx = await createMcpFixture(options);
  try {
    return await fn(fx);
  } finally {
    await fx.close();
  }
}

test("A1 · mcp:command 单一通道 + 显式白名单 + 工具调用入口明确拒绝", async () => {
  await withFixture(async (fx) => {
    assert.equal(typeof fx.ipc.handlers.get("mcp:command"), "function");
    assert.equal(domain.ERROR_CODE.MCP_COMMAND_NOT_ALLOWED, "MCP_COMMAND_NOT_ALLOWED");
    for (const bogus of ["mcp/nope", "mcp/", "authorization/authorize", ""]) {
      const res = await fx.invoke({ command: bogus });
      assert.equal(res.ok, false);
      assert.equal(res.error, domain.ERROR_CODE.MCP_COMMAND_NOT_ALLOWED);
    }
    // 任何工具调用入口都必须明确回 MCP_TOOL_INVOCATION_NOT_ENABLED（不是"未知命令"）
    for (const command of [...MCP_TOOL_INVOCATION_COMMANDS, "mcp/callTool"]) {
      const res = await fx.invoke({ command, connectionId: "mcp_x", name: "echo_sum" });
      assert.equal(res.ok, false);
      assert.equal(res.error, "MCP_TOOL_INVOCATION_NOT_ENABLED", command);
    }
    assert.equal(fx.mcpService.invokeTool({}).error, "MCP_TOOL_INVOCATION_NOT_ENABLED");
    // 白名单就是产品声明的那 10 条
    assert.deepEqual([...MCP_COMMANDS], ["mcp/list", "mcp/get", "mcp/create", "mcp/update", "mcp/delete", "mcp/setEnabled", "mcp/connect", "mcp/reconnect", "mcp/test", "mcp/testLog"]);
  });
});

test("A2 · 非信任调用被拒；service 未装配时回 mcp-not-ready", async () => {
  const fx = await createMcpFixture();
  try {
    const handlers = new Map();
    const { registerMcpIpc } = await import("../electron/mcp-bootstrap.cjs").then((m) => m.default || m);
    registerMcpIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: () => {} }, service: fx.mcpService, identity: fx.identityRef, isTrusted: () => false });
    await assert.rejects(() => handlers.get("mcp:command")({}, { command: "mcp/list" }), /Forbidden/);
    registerMcpIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn), removeHandler: () => {} }, service: null, identity: fx.identityRef, isTrusted: () => true });
    const res = await handlers.get("mcp:command")({}, { command: "mcp/list" });
    assert.equal(res.ok, false);
    assert.equal(res.detail, "mcp-not-ready");
  } finally {
    await fx.close();
  }
});

test("A3 · 自报身份被忽略：sessionRef/appId 由主进程注入", async () => {
  await withFixture(async (fx) => {
    const created = await fx.invoke({
      command: "mcp/create",
      sessionRef: fx.sessions.alice,
      userId: fx.users.alice,
      appId: "resource-library",
      role: "ADMIN",
      name: "自报身份",
      transport: "stdio",
      location: "LOCAL_DEVICE",
      endpoint: { serverKey: ECHO.serverKey },
      visibility: "PERSONAL",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.connection.ownerUserId, fx.users.admin, "owner 必须是注入会话的用户");
    const listed = await fx.invoke({ command: "mcp/list" });
    assert.equal(listed.ok, true);
    assert.equal(listed.items.length, 1);
  });
});

test("A4 · CRUD：创建 / 读取 / 更新 / 删除，且投影不含 credentialRef", async () => {
  await withFixture(async (fx) => {
    const created = await fx.createLocal({ name: "回显服务器" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.connection.connectionId;
    assert.equal(created.connection.transport, "stdio");
    assert.equal(created.connection.location, "LOCAL_DEVICE");
    assert.deepEqual(created.connection.endpoint, { serverKey: ECHO.serverKey });
    assert.equal(created.connection.enabled, false);
    assert.equal(created.connection.status, "DISABLED");
    assert.equal(created.connection.credentialConfigured, false);
    assert.equal("credentialRef" in created.connection, false);
    assert.equal("credential_ref" in created.connection, false);
    assert.equal(JSON.stringify(created).includes("credentialRef"), false, "投影里不该出现 credentialRef");
    assert.equal(JSON.stringify(created).includes("cred_"), false, "投影里不该出现凭据引用值");

    const got = await fx.invoke({ command: "mcp/get", connectionId: id });
    assert.equal(got.ok, true);
    assert.equal(got.connection.name, "回显服务器");

    const updated = await fx.invoke({ command: "mcp/update", connectionId: id, patch: { name: "改名后", ownerUserId: "hacker", organizationId: "org_hack", status: "READY" } });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.connection.name, "改名后");
    assert.equal(updated.connection.ownerUserId, fx.users.admin);
    assert.equal(updated.connection.organizationId, fx.orgId);
    assert.equal(updated.connection.status, "DISABLED");

    const listed = await fx.invoke({ command: "mcp/list" });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].name, "改名后");

    const deleted = await fx.invoke({ command: "mcp/delete", connectionId: id });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.changed, true);
    const gone = await fx.invoke({ command: "mcp/get", connectionId: id });
    assert.equal(gone.ok, false);
    assert.equal(gone.error, domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND);
  });
});

test("A5 · 本地白名单：任意命令/任意路径一律 MCP_LOCAL_SERVER_NOT_ALLOWED", async () => {
  await withFixture(async (fx) => {
    const bad = [
      { serverKey: "rm -rf /" },
      { serverKey: "openarc-test-echo; rm -rf /" },
      { serverKey: "/bin/sh" },
      { serverKey: "../../../bin/node" },
      { serverKey: "openarc-test-echo-2" },
      {},
      { serverKey: "" },
    ];
    for (const endpoint of bad) {
      const res = await fx.invoke({ command: "mcp/create", name: "坏连接", transport: "stdio", location: "LOCAL_DEVICE", endpoint, visibility: "PERSONAL" });
      assert.equal(res.ok, false, JSON.stringify(endpoint));
      assert.equal(res.error, domain.ERROR_CODE.MCP_LOCAL_SERVER_NOT_ALLOWED, JSON.stringify(endpoint));
    }
    const allowed = domain.validateLocalEndpoint({ serverKey: ECHO.serverKey });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.entry.endsWith("tests/fixtures/mcp/echo-server.mjs"), true);
    assert.deepEqual(allowed.args, ["--stdio"]);
    // 渲染层给不了 env / args / entry：domain 的白名单映射是主进程唯一来源
    assert.deepEqual(domain.localServerEnv({ PATH: "/usr/bin", SECRET: "evil", NODE_OPTIONS: "--require=/tmp/x" }), { PATH: "/usr/bin" });
    // location 与 transport 必须自洽
    const mixed1 = await fx.invoke({ command: "mcp/create", name: "混合", transport: "http", location: "LOCAL_DEVICE", endpoint: { url: "http://127.0.0.1:9/mcp" }, visibility: "PERSONAL" });
    assert.equal(mixed1.error, domain.ERROR_CODE.MCP_INVALID_INPUT);
    assert.equal(mixed1.detail, "local-requires-stdio");
    const mixed2 = await fx.invoke({ command: "mcp/create", name: "混合", transport: "stdio", location: "REMOTE_SERVICE", endpoint: { serverKey: ECHO.serverKey }, visibility: "PERSONAL" });
    assert.equal(mixed2.error, domain.ERROR_CODE.MCP_INVALID_INPUT);
    assert.equal(mixed2.detail, "remote-requires-http");
  });
});

test("A6 · 远程 URL 校验：file:// / metadata IP / 内嵌凭据 / 明文远程一律拒绝", async () => {
  await withFixture(async (fx) => {
    const cases = [
      ["file:///etc/passwd", "protocol:file:"],
      ["http://169.254.169.254/latest/meta-data/", "metadata-endpoint"],
      ["http://metadata.google.internal/mcp", "metadata-endpoint"],
      ["https://user:pass@mcp.example.com/mcp", "url-credentials"],
      ["http://mcp.example.com/mcp", "remote-requires-https"],
      ["https://mcp.example.com/mcp?token=abc", "secret-in-query"],
      ["gopher://mcp.example.com/", "protocol:gopher:"],
    ];
    for (const [url, reason] of cases) {
      const res = await fx.invoke({ command: "mcp/create", name: "远程", transport: "http", location: "REMOTE_SERVICE", endpoint: { url }, visibility: "PERSONAL" });
      assert.equal(res.ok, false, url);
      assert.equal(res.error, domain.ERROR_CODE.MCP_ENDPOINT_BLOCKED, url);
      assert.equal(res.detail, reason, url);
    }
    // localhost 明文 http 是本批允许的（沿用模型服务 LOCALHOST 口径）；建连接不发起连接，端口不通不该让创建失败
    const localHttp = await fx.invoke({ command: "mcp/create", name: "本地 HTTP", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: "http://127.0.0.1:9/mcp" }, visibility: "PERSONAL" });
    assert.equal(localHttp.ok, true, JSON.stringify(localHttp));
    assert.deepEqual(localHttp.connection.endpoint, { url: "http://127.0.0.1:9/mcp", endpointScope: "LOCALHOST" });
    const localhost = domain.validateRemoteEndpoint("http://127.0.0.1:8080/mcp");
    assert.equal(localhost.ok, true);
    assert.equal(localhost.endpointScope, "LOCALHOST");
  });
});

test("A7 · 凭据边界：BEARER 必须给 secret；secret 只在 OS 后端，响应体里没有", async () => {
  await withFixture(async (fx) => {
    const missing = await fx.invoke({ command: "mcp/create", name: "无密钥", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: "https://mcp.example.com/mcp" }, authMode: "BEARER", visibility: "PERSONAL" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, domain.ERROR_CODE.MCP_CREDENTIAL_MISSING);

    const stray = await fx.invoke({ command: "mcp/create", name: "多余密钥", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: "https://mcp.example.com/mcp" }, authMode: "NONE", credentialSecret: "should-not-be-here", visibility: "PERSONAL" });
    assert.equal(stray.ok, false);
    assert.equal(stray.error, domain.ERROR_CODE.MCP_INVALID_INPUT);

    const secret = "oa-secret-token-9f3c1d";
    const created = await fx.invoke({ command: "mcp/create", name: "带密钥", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: "https://mcp.example.com/mcp" }, authMode: "BEARER", credentialSecret: secret, visibility: "PERSONAL" });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.connection.credentialConfigured, true);
    assert.equal(JSON.stringify(created).includes(secret), false, "响应体不得含明文 secret");
    assert.equal(JSON.stringify(created).includes("cred_"), false, "响应体不得含 credentialRef");

    const id = created.connection.connectionId;
    const listed = await fx.invoke({ command: "mcp/list" });
    assert.equal(JSON.stringify(listed).includes(secret), false);
    assert.equal(JSON.stringify(listed).includes("cred_"), false);
    const log = await fx.invoke({ command: "mcp/testLog", connectionId: id });
    assert.equal(log.ok, true);
    assert.equal(JSON.stringify(log).includes(secret), false);

    // 库里只有 credential_ref，没有 secret 明文（raw secret 只在 CredentialStore 后端）
    const row = fx.identity.connection.prepare("SELECT * FROM mcp_connections WHERE connection_id = ?").get(id);
    assert.equal(String(row.credential_ref).startsWith("cred_"), true);
    assert.equal(JSON.stringify(row).includes(secret), false);
    const allRows = JSON.stringify(fx.identity.connection.prepare("SELECT * FROM mcp_credentials").all());
    assert.equal(allRows.includes(secret), false);
  });
});

test("A8 · 启停：启用只打开意图，未连接前状态仍是 DISABLED；停用必须回到 DISABLED", async () => {
  await withFixture(async (fx) => {
    const created = await fx.createLocal();
    const id = created.connection.connectionId;
    const enabled = await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.connection.enabled, true);
    assert.equal(enabled.connection.status, "DISABLED", "未连接前不得写成 READY");
    const disabled = await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: false });
    assert.equal(disabled.connection.enabled, false);
    assert.equal(disabled.connection.status, "DISABLED");
    // 停用后 connect/test 明确拒绝
    const connect = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(connect.ok, false);
    assert.equal(connect.error, domain.ERROR_CODE.MCP_CONNECTION_DISABLED);
    const test_ = await fx.invoke({ command: "mcp/test", connectionId: id });
    assert.equal(test_.error, domain.ERROR_CODE.MCP_CONNECTION_DISABLED);
    // update 不能偷改 enabled：IPC 白名单里根本没有这个键；服务层直接调用也会被明确拒绝
    const sneaky = await fx.invoke({ command: "mcp/update", connectionId: id, patch: { enabled: true, status: "READY" } });
    assert.equal(sneaky.ok, true);
    assert.equal(sneaky.connection.enabled, false);
    assert.equal(sneaky.connection.status, "DISABLED");
    const direct = fx.mcpService.updateConnection({ context: fx.mcpCtx(), connectionId: id, patch: { enabled: true } });
    assert.equal(direct.ok, false);
    assert.equal(direct.detail, "use-setEnabled");
  });
});

test("A9 · 删除连接同时删除凭据元数据（不留可被复用的 ref）", async () => {
  await withFixture(async (fx) => {
    const created = await fx.invoke({ command: "mcp/create", name: "带密钥", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: "https://mcp.example.com/mcp" }, authMode: "BEARER", credentialSecret: "oa-secret-token-abcdef", visibility: "PERSONAL" });
    const id = created.connection.connectionId;
    const ref = fx.identity.connection.prepare("SELECT credential_ref FROM mcp_connections WHERE connection_id = ?").get(id).credential_ref;
    assert.equal(String(ref).startsWith("cred_"), true);
    const del = await fx.invoke({ command: "mcp/delete", connectionId: id });
    assert.equal(del.ok, true);
    const meta = fx.mcpStore.credentialByRef(ref);
    assert.equal(meta.status, "DELETED");
    assert.equal(fx.credentialStore.has({ credentialRef: ref }).configured, false);
    assert.equal(fx.identity.connection.prepare("SELECT COUNT(*) c FROM mcp_connection_logs WHERE connection_id = ?").get(id).c, 0);
  });
});

test("A10 · 授权：别人的个人连接不可见；无 mcp.manage 的 App 不能建/改/删；跨组织越权被拒", async () => {
  await withFixture(async (fx) => {
    const created = await fx.createLocal({ name: "admin 个人连接" });
    const id = created.connection.connectionId;

    // alice：mcp-center 没有她的组织授权吗？有（同组织基线），但这是 admin 的 PERSONAL 连接
    fx.as("alice");
    const aliceGetReal = await fx.invoke({ command: "mcp/get", connectionId: id });
    assert.equal(aliceGetReal.ok, false);
    assert.equal(aliceGetReal.error, domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND, "不得暴露存在性");
    const aliceList = await fx.invoke({ command: "mcp/list" });
    assert.equal(aliceList.ok, true);
    assert.equal(aliceList.items.length, 0);

    // 只读 App（resource-library 只有 mcp.view）不能建/改/删 —— IPC 固定 hostAppId，这里直接打同一条服务链
    const roCtx = (key) => ({ sessionRef: fx.sessions[key], appId: "resource-library", source: "ui" });
    const roCreate = fx.mcpService.createConnection({ context: roCtx("alice"), name: "越权", transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: ECHO.serverKey }, visibility: "PERSONAL" });
    assert.equal(roCreate.ok, false);
    assert.equal(roCreate.error, domain.ERROR_CODE.MCP_UNAUTHORIZED);
    assert.equal(roCreate.reason, "app-action-missing");
    const roGet = fx.mcpService.getConnection({ context: roCtx("alice"), connectionId: id });
    assert.equal(roGet.ok, false);
    assert.equal(roGet.error, domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND, "别人的个人连接连存在性都不暴露");
    const roList = fx.mcpService.listConnections({ context: roCtx("alice") });
    assert.equal(roList.ok, true);
    assert.equal(roList.items.length, 0);

    // 跨组织：bob（另一个组织）看不到任何东西，也没有该组织的 mcp 授权
    fx.as("bob");
    const bobList = await fx.invoke({ command: "mcp/list" });
    assert.equal(bobList.ok, false);
    assert.equal(bobList.error, domain.ERROR_CODE.MCP_UNAUTHORIZED);
    const bobGet = await fx.invoke({ command: "mcp/get", connectionId: id });
    assert.equal(bobGet.ok, false);

    // 团队连接：非 Super Admin 不能建
    fx.as("alice");
    const orgCreate = await fx.invoke({ command: "mcp/create", name: "团队", transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: ECHO.serverKey }, visibility: "ORGANIZATION" });
    assert.equal(orgCreate.ok, false);
    assert.equal(orgCreate.error, domain.ERROR_CODE.MCP_UNAUTHORIZED);
    assert.equal(orgCreate.reason, "org-create-requires-super-admin");
    assert.equal(aliceGetReal.error, domain.ERROR_CODE.MCP_CONNECTION_NOT_FOUND);
  });
});

test("A11 · 状态机：不允许的迁移被明确判定为非法", () => {
  assert.equal(domain.canTransition("DISABLED", "CONNECTING"), true);
  assert.equal(domain.canTransition("CONNECTING", "READY"), true);
  assert.equal(domain.canTransition("CONNECTING", "AUTH_REQUIRED"), true);
  assert.equal(domain.canTransition("CONNECTING", "ERROR"), true);
  assert.equal(domain.canTransition("DISABLED", "READY"), false);
  assert.equal(domain.canTransition("DISABLED", "AUTH_REQUIRED"), false);
  assert.equal(domain.canTransition("READY", "READY"), false);
  assert.equal(domain.canTransition("NOPE", "READY"), false);
  assert.equal(domain.ERROR_CODE.MCP_STATE_INVALID, "MCP_STATE_INVALID");
});
