/**
 * D5-03 第一批 · 边界：工具调用不开放 / 凭据不回渲染层 / 无权不暴露工具描述 / 审计留痕。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createMcpFixture, ECHO, domain, McpClient, MCP_TOOL_INVOCATION_COMMANDS } from "./mcp-fixtures.mjs";

async function withFixture(fn, options = {}) {
  const fx = await createMcpFixture(options);
  try {
    return await fn(fx);
  } finally {
    await fx.close();
  }
}

const recordOf = (fx, id) => fx.identity.connection.prepare("SELECT * FROM mcp_connections WHERE connection_id = ?").get(id);
const modulePath = (name) => fileURLToPath(new URL("../electron/" + name, import.meta.url));

test("C1 · 第一批不开放工具调用：客户端没有调用路径，任何入口都回 MCP_TOOL_INVOCATION_NOT_ENABLED", async () => {
  // 客户端源码里没有任何 tools/call 请求字面量（只有注释说明"不实现"）
  for (const file of ["mcp-client.cjs", "mcp-service.cjs", "mcp-bootstrap.cjs", "mcp-domain.cjs"]) {
    const text = fs.readFileSync(modulePath(file), "utf8");
    assert.equal(/["']tools\/call["']/.test(text), false, file + " 不得出现 tools/call 请求字面量");
  }
  // 客户端对象的调用入口明确拒绝
  const client = new McpClient({});
  assert.deepEqual(client.callTool({ name: "echo_sum" }), { ok: false, error: "MCP_TOOL_INVOCATION_NOT_ENABLED" });
  assert.equal(typeof McpClient.prototype["#" + "request"], "undefined");
  await withFixture(async (fx) => {
    assert.deepEqual(fx.mcpService.invokeTool({ connectionId: "mcp_x", name: "echo_sum" }), { ok: false, error: "MCP_TOOL_INVOCATION_NOT_ENABLED" });
    for (const command of MCP_TOOL_INVOCATION_COMMANDS) {
      const res = await fx.invoke({ command, connectionId: "mcp_x", name: "echo_sum", args: { a: 1, b: 2 } });
      assert.equal(res.ok, false, command);
      assert.equal(res.error, "MCP_TOOL_INVOCATION_NOT_ENABLED", command);
    }
    // 未登记的命令仍然只是"通道白名单拒绝"，与工具调用边界的错误码区分开
    const unknown = await fx.invoke({ command: "mcp/toolsInvoke" });
    assert.equal(unknown.error, "MCP_COMMAND_NOT_ALLOWED");
  });
});

test("C2 · 凭据不回渲染层：所有命令返回体 / 数据库表 / 日志都不含明文 secret", async () => {
  const secret = "oa-super-secret-3f9a2b7c";
  await withFixture(async (fx) => {
    const created = await fx.invoke({ command: "mcp/create", name: "远程带密钥", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: "https://mcp.example.com/mcp" }, authMode: "BEARER", credentialSecret: secret, visibility: "PERSONAL" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    await fx.invoke({ command: "mcp/connect", connectionId: id }); // 连不上是另一件事；返回体依然不得带密钥
    const responses = [
      created,
      await fx.invoke({ command: "mcp/list" }),
      await fx.invoke({ command: "mcp/get", connectionId: id }),
      await fx.invoke({ command: "mcp/update", connectionId: id, patch: { name: "改名" } }),
      await fx.invoke({ command: "mcp/test", connectionId: id }),
      await fx.invoke({ command: "mcp/reconnect", connectionId: id }),
      await fx.invoke({ command: "mcp/testLog", connectionId: id, limit: 50 }),
      await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: false }),
    ];
    for (const res of responses) {
      const text = JSON.stringify(res);
      assert.equal(text.includes(secret), false, "响应体泄漏 secret：" + text.slice(0, 200));
      assert.equal(text.includes("cred_"), false, "响应体泄漏 credentialRef：" + text.slice(0, 200));
      assert.equal(text.includes("credentialRef"), false, "响应体出现 credentialRef 字段名");
    }
    // 库里与凭据后端：只有 ref / 密文，没有明文
    for (const table of ["mcp_connections", "mcp_credentials", "mcp_connection_logs", "authorization_audit"]) {
      const rows = JSON.stringify(fx.identity.connection.prepare("SELECT * FROM " + table).all());
      assert.equal(rows.includes(secret), false, table + " 落盘了明文 secret");
    }
    const ref = recordOf(fx, id).credential_ref;
    assert.equal(String(ref).startsWith("cred_"), true);
    // 凭据解析只允许主进程内部使用（renderer 拿不到这个方法）
    const resolved = fx.credentialStore.resolveInternalSync({ credentialRef: ref });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.secret, secret, "内部解析仍能拿到（连接时才用）");
  });
});

test("C3 · 无权不暴露工具描述：只有 mcp.view 的 App 看到状态但看不到工具目录", async () => {
  await withFixture(async (fx) => {
    // 团队连接（Super Admin 建）并真实发现工具
    const created = await fx.invoke({ command: "mcp/create", name: "团队回显", transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: ECHO.serverKey }, visibility: "ORGANIZATION" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const connected = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.deepEqual(connected.connection.tools.map((t) => t.name), ECHO.tools);

    // admin（mcp-center，含 mcp.use）：工具目录可见
    const adminView = await fx.invoke({ command: "mcp/get", connectionId: id });
    assert.equal(adminView.connection.toolsHidden, false);
    assert.equal(adminView.connection.tools.length, 2);

    // alice + resource-library（只有 mcp.view）：状态可见，工具描述不可见
    const roCtx = { sessionRef: fx.sessions.alice, appId: "resource-library", source: "ui" };
    const roView = fx.mcpService.getConnection({ context: roCtx, connectionId: id });
    assert.equal(roView.ok, true);
    assert.equal(roView.connection.status, "READY");
    assert.equal(roView.connection.toolsHidden, true);
    assert.deepEqual(roView.connection.tools, []);
    assert.equal(roView.connection.toolsHash, null);
    assert.equal(JSON.stringify(roView).includes("echo_sum"), false, "无权时连工具名都不出现");
    assert.equal(JSON.stringify(roView).includes("describe_self"), false);
    const roList = fx.mcpService.listConnections({ context: roCtx });
    assert.equal(roList.ok, true);
    assert.equal(roList.items.length, 1, "团队连接对组织成员可见");
    assert.equal(JSON.stringify(roList).includes("echo_sum"), false);
    // 无权时也不能连接 / 测试 / 改 / 删
    assert.equal(fx.mcpService.setEnabled({ context: roCtx, connectionId: id, enabled: false }).error, "MCP_UNAUTHORIZED");
    assert.equal(fx.mcpService.deleteConnection({ context: roCtx, connectionId: id }).error, "MCP_UNAUTHORIZED");
    assert.equal((await fx.mcpService.connect({ context: roCtx, connectionId: id })).error, "MCP_UNAUTHORIZED");
    assert.equal((await fx.mcpService.test({ context: roCtx, connectionId: id })).error, "MCP_UNAUTHORIZED");

    // alice + mcp-center（同组织基线，含 mcp.use）：同一连接工具可见
    const aliceCtx = { sessionRef: fx.sessions.alice, appId: "mcp-center", source: "ui" };
    const aliceView = fx.mcpService.getConnection({ context: aliceCtx, connectionId: id });
    assert.equal(aliceView.ok, true);
    assert.equal(aliceView.connection.toolsHidden, false);
    assert.deepEqual(aliceView.connection.tools.map((t) => t.name), ECHO.tools);
    assert.equal(aliceView.connection.access.canManage, false, "团队连接只有 Super Admin 能管");
  });
});

test("C4 · 停用后的连接不再接受连接/测试，记录仍是 DISABLED 而不是 READY", async () => {
  await withFixture(async (fx) => {
    const created = await fx.createLocal();
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(recordOf(fx, id).status, "READY");
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: false });
    assert.equal(recordOf(fx, id).status, "DISABLED");
    assert.equal(recordOf(fx, id).last_error_code, null);
    assert.equal((await fx.invoke({ command: "mcp/connect", connectionId: id })).error, "MCP_CONNECTION_DISABLED");
    assert.equal((await fx.invoke({ command: "mcp/reconnect", connectionId: id })).error, "MCP_CONNECTION_DISABLED");
    assert.equal((await fx.invoke({ command: "mcp/test", connectionId: id })).error, "MCP_CONNECTION_DISABLED");
    // 工具快照保留（能力目录不因停用丢失），但状态如实显示未连接
    const got = await fx.invoke({ command: "mcp/get", connectionId: id });
    assert.equal(got.connection.tools.length, 2);
  });
});

test("C5 · 管理动作与拒绝都进 authorization_audit（沿用 D3-02 审计表）", async () => {
  await withFixture(async (fx) => {
    const created = await fx.createLocal();
    const id = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    await fx.invoke({ command: "mcp/delete", connectionId: id });
    fx.as("alice");
    const denied = await fx.invoke({ command: "mcp/create", name: "越权", transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: ECHO.serverKey }, visibility: "ORGANIZATION" });
    assert.equal(denied.ok, false);
    const rows = fx.identity.connection.prepare("SELECT action, decision, reason_code, actor_user_id FROM authorization_audit WHERE action LIKE 'mcp.%' ORDER BY id").all();
    const actions = rows.map((r) => r.action);
    assert.equal(actions.includes("mcp.connectionCreated"), true, JSON.stringify(rows));
    assert.equal(actions.includes("mcp.connectionEnabled"), true);
    assert.equal(actions.includes("mcp.connectionDeleted"), true);
    const deny = rows.find((r) => r.decision === "DENY");
    assert.equal(!!deny, true, "拒绝必须留痕");
    assert.equal(deny.reason_code, "org-create-requires-super-admin");
    assert.equal(rows.every((r) => typeof r.reason_code === "string" && r.reason_code.length > 0), true);
  });
});

test("C6 · 没有 safeStorage（无明文 fallback）时 BEARER 连接明确拒绝", async () => {
  const unavailable = { kind: "unavailable", available: () => false, put: () => false, get: () => null, delete: () => true, has: () => false };
  await withFixture(async (fx) => {
    assert.equal(fx.credentialStore.available(), false);
    const res = await fx.invoke({ command: "mcp/create", name: "无安全后端", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: "https://mcp.example.com/mcp" }, authMode: "BEARER", credentialSecret: "oa-secret-token-1234", visibility: "PERSONAL" });
    assert.equal(res.ok, false);
    assert.equal(res.error, "MCP_CREDENTIAL_STORE_UNAVAILABLE");
    assert.equal(fx.identity.connection.prepare("SELECT COUNT(*) c FROM mcp_connections").get().c, 0, "失败不得留下半条记录");
    // NONE 模式不依赖凭据存储，仍可用
    const plain = await fx.invoke({ command: "mcp/create", name: "无需凭据", transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: ECHO.serverKey }, visibility: "PERSONAL" });
    assert.equal(plain.ok, true);
  }, { credentialBackend: unavailable });
});

test("C7 · 输入一律参数化：注入串既不能越权也不能改到别的记录", async () => {
  await withFixture(async (fx) => {
    const a = await fx.createLocal({ name: "A" });
    const b = await fx.createLocal({ name: "B" });
    const injected = { command: "mcp/update", connectionId: a.connection.connectionId, patch: { name: "x'; DROP TABLE mcp_connections; --" } };
    const res = await fx.invoke(injected);
    assert.equal(res.ok, true);
    assert.equal(res.connection.name, "x'; DROP TABLE mcp_connections; --", "名字按字面保存");
    assert.equal(fx.identity.connection.prepare("SELECT COUNT(*) c FROM mcp_connections").get().c, 2);
    const notFound = await fx.invoke({ command: "mcp/get", connectionId: "' OR 1=1 --" });
    assert.equal(notFound.ok, false);
    assert.equal(notFound.error, "MCP_CONNECTION_NOT_FOUND");
    assert.equal(recordOf(fx, b.connection.connectionId).name, "B");
  });
});

test("C8 · §22 页面状态可由真实投影推出：无连接 / 发现工具中 / 认证失败需重授权 / 无权不暴露工具", async () => {
  let fxRef = null;
  let sawConnecting = false;
  const probeFactory = () => {
    const client = new McpClient({ launcher: new (await_launcher())(), requestTimeoutMs: 4000 });
    const originalInitialize = client.initialize.bind(client);
    client.initialize = async (opts) => {
      const row = fxRef.mcpStore.connectionById(connectingId);
      if (row && row.status === "CONNECTING") sawConnecting = true;
      return originalInitialize(opts);
    };
    return client;
  };
  let connectingId = null;
  function await_launcher() {
    // 白名单程序仍由受控 launcher 启动
    return McpFixtureLauncher;
  }
  const { NodeChildProcessLauncher } = await import("../electron/executor-launcher.cjs").then((m) => m.default || m);
  const McpFixtureLauncher = NodeChildProcessLauncher;
  await withFixture(async (fx) => {
    fxRef = fx;
    // 空状态
    const empty = await fx.invoke({ command: "mcp/list" });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.items, []);
    // 发现工具中：握手期间记录必须是 CONNECTING
    const created = await fx.createLocal();
    connectingId = created.connection.connectionId;
    await fx.invoke({ command: "mcp/setEnabled", connectionId: connectingId, enabled: true });
    const connected = await fx.invoke({ command: "mcp/connect", connectionId: connectingId });
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.equal(sawConnecting, true, "握手中必须出现 CONNECTING 状态");
    assert.equal(fx.mcpStore.connectionById(connectingId).status, "READY");
    // 认证失败需重授权：凭据缺失的连接
    const bearer = await fx.invoke({ command: "mcp/create", name: "需要鉴权", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: "https://mcp.example.com/mcp" }, authMode: "BEARER", credentialSecret: "oa-secret-token-xyz", visibility: "PERSONAL" });
    const id = bearer.connection.connectionId;
    fx.credentialStore.deleteSync({ credentialRef: fx.mcpStore.connectionById(id).credential_ref });
    await fx.invoke({ command: "mcp/setEnabled", connectionId: id, enabled: true });
    const failed = await fx.invoke({ command: "mcp/connect", connectionId: id });
    assert.equal(failed.error, "MCP_CREDENTIAL_MISSING");
    assert.equal(fx.mcpStore.connectionById(id).status, "AUTH_REQUIRED", "需要重新授权而不是普通错误");
    const view = await fx.invoke({ command: "mcp/get", connectionId: id });
    assert.equal(view.connection.status, "AUTH_REQUIRED");
    assert.equal(view.connection.credentialConfigured, true);
  }, { clientFactory: probeFactory });
});
