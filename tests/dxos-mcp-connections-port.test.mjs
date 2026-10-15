/**
 * Y4 · 生产 connections 端口 + 生产装配 + normalizeMcpList serverKey（全离线）。
 *
 * 覆盖任务书验收点：
 *   ① 既有 MCP 存储/服务之上的 list/save/connect/disconnect/remove 端口（不新造第二套配置文件）；
 *   ② developer-domain.normalizeMcpList 保留白名单 serverKey、不保留 command/args；
 *   ③ 白名单内 stdio 声明 → 注册成功 + App 启用后连接 + 禁用后断开；
 *   ④ 白名单外 / App 自带 command → 整批拒绝且 0 次 save / 0 次 connect；
 *   ⑤ http 声明按既有 validateRemoteEndpoint 策略通过 / 拒绝；
 *   ⑥ 未装配 registry → 既有结构化降级逐字不变；
 *   ⑦ main.cjs / developer-service.cjs 生产装配（源码级）+ registry 缺失不崩。
 *
 * 全程离线：不 spawn 进程、不联网（把 globalThis.fetch 换成会抛错的计数器再断言 0 次）、
 * 不 npm install、不跑 build。被测算的是产品代码，不是测试自造的复制品。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMcpConnectionsPort, constructOrDegrade, MANAGED_KEY, PORT_ERROR } = require("../electron/mcp-connections-port.cjs");
const { createAppManagedMcpRegistry, APP_MCP_ERROR, POLICY } = require("../electron/mcp-app-registry.cjs");
const { createMcpAgentBridge } = require("../electron/mcp-agent-bridge.cjs");
const { createMcpAgentTools, AGENT_DEPENDENCY_UNAVAILABLE } = require("../electron/mcp-agent-tools.cjs");
const { collectCapabilities } = require("../electron/developer-domain.cjs");
const { createDeveloperBundle } = require("../electron/developer-service.cjs");
const { IdentityStore } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const { writeZip } = require("../electron/canvas-dxos-zip.cjs");

const MAIN_PATH = path.join(process.cwd(), "electron", "main.cjs");
const SERVICE_PATH = path.join(process.cwd(), "electron", "developer-service.cjs");
const DOMAIN_PATH = path.join(process.cwd(), "electron", "developer-domain.cjs");

/** 网络守卫：Y4 的端口/注册表/生命周期都不该发网络；断言期间任何 fetch 都会被记录并抛错。 */
function guardNetwork() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(args); throw new Error("Y4-test-network-blocked"); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 既有 mcp_connections 表的内存替身（只实现端口真正用到的读写）。 */
function makeStore(initial = []) {
  const rows = new Map();
  for (const row of initial) rows.set(String(row.connection_id), { enabled: 0, status: "DISABLED", ...row });
  const calls = { insert: [], update: [], delete: [] };
  return {
    rows,
    calls,
    connectionById(id) { return rows.get(String(id)) || null; },
    insertConnection(input) {
      const row = {
        connection_id: String(input.connectionId), organization_id: String(input.organizationId),
        owner_user_id: input.ownerUserId, visibility: input.visibility, name: input.name,
        transport: input.transport, location: input.location, endpoint_json: input.endpointJson,
        auth_mode: "NONE", credential_ref: null, enabled: input.enabled ? 1 : 0, status: input.status,
      };
      rows.set(row.connection_id, row);
      calls.insert.push(row);
      return row;
    },
    updateConnection(id, patch) {
      const current = rows.get(String(id));
      if (!current) return null;
      const next = { ...current };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.transport !== undefined) next.transport = patch.transport;
      if (patch.location !== undefined) next.location = patch.location;
      if (patch.endpointJson !== undefined) next.endpoint_json = patch.endpointJson;
      if (patch.enabled !== undefined) next.enabled = patch.enabled ? 1 : 0;
      if (patch.status !== undefined) next.status = patch.status;
      rows.set(String(id), next);
      calls.update.push({ id: String(id), patch });
      return next;
    },
    deleteConnection(id) { const changed = rows.delete(String(id)); calls.delete.push(String(id)); return { changed }; },
  };
}

/** 既有 McpService 的内存替身：list 只回可见行，connect/setEnabled/delete 记录调用。 */
function makeService(store, { listResult = null } = {}) {
  const calls = { list: [], connect: [], setEnabled: [], delete: [] };
  return {
    store,
    calls,
    authService: {
      resolveActor: ({ context } = {}) => (context && context.sessionRef
        ? { ok: true, user: { id: "u1", role: "ADMIN" }, organizationId: "org1" }
        : { ok: false, error: "no-session" }),
    },
    listConnections({ context } = {}) {
      calls.list.push(context);
      if (listResult) return listResult;
      return {
        ok: true,
        items: [...store.rows.values()].map((row) => ({
          connectionId: row.connection_id, name: row.name, enabled: row.enabled === 1,
          status: row.status, tools: [], toolsHidden: false,
        })),
      };
    },
    async connect({ context, connectionId } = {}) {
      calls.connect.push({ context, connectionId });
      const row = store.connectionById(connectionId);
      if (row) row.status = "READY";
      return { ok: true, reused: false };
    },
    setEnabled({ context, connectionId, enabled } = {}) {
      calls.setEnabled.push({ context, connectionId, enabled });
      const row = store.connectionById(connectionId);
      if (row) { row.enabled = enabled ? 1 : 0; row.status = enabled ? "READY" : "DISABLED"; }
      return { ok: true };
    },
    deleteConnection({ context, connectionId } = {}) {
      calls.delete.push({ context, connectionId });
      const res = store.deleteConnection(connectionId);
      return { ok: true, changed: res.changed };
    },
  };
}

function makePort(store, service, extra = {}) {
  return createMcpConnectionsPort({
    mcpService: service,
    mcpStore: store,
    context: () => ({ sessionRef: "sess-y4" }),
    ...extra,
  });
}

const capsOf = (mcp) => collectCapabilities([], { id: "demo", name: "Demo", mcp });

// ─────────────────────────────────────────────────────────────────────────────
// ① connections 端口形状 + 读写落点
// ─────────────────────────────────────────────────────────────────────────────
test("① connections 端口：list/save/connect/disconnect/remove 架在既有存储上，0 网络", async () => {
  const net = guardNetwork();
  try {
    const store = makeStore();
    const service = makeService(store);
    const port = makePort(store, service);
    for (const method of ["list", "save", "connect", "disconnect", "remove"]) {
      assert.equal(typeof port[method], "function", method);
    }

    const saved = port.save({
      id: "echo", name: "回显", transport: "stdio", location: "LOCAL_DEVICE",
      endpoint: { serverKey: "openarc-test-echo" }, managedByAppId: "dev-a",
      enabled: true, status: "CONNECTING",
    });
    assert.equal(saved.id, "echo");
    assert.equal(saved.managedByAppId, "dev-a");
    assert.equal(saved.transport, "stdio");
    const raw = store.connectionById("echo");
    assert.deepEqual(JSON.parse(raw.endpoint_json), { serverKey: "openarc-test-echo", [MANAGED_KEY]: "dev-a" });
    assert.equal(store.calls.insert.length, 1, "新记录落在既有表（0 次新配置文件）");

    const listed = port.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "echo");
    assert.equal(listed[0].managedByAppId, "dev-a");
    assert.deepEqual(listed[0].endpoint, { serverKey: "openarc-test-echo" });
    assert.equal(listed[0].appManaged, true);

    // 同 id 幂等更新，不新增第二行。
    const updated = port.save({ ...saved, status: "READY", enabled: true });
    assert.equal(updated.status, "READY");
    assert.equal(store.rows.size, 1);
    assert.equal(store.calls.insert.length, 1);

    await port.connect({ id: "echo" });
    assert.equal(service.calls.connect.length, 1);
    assert.equal(service.calls.connect[0].connectionId, "echo");
    assert.equal(service.calls.connect[0].context.sessionRef, "sess-y4");

    port.disconnect("echo");
    assert.deepEqual(service.calls.setEnabled, [{ context: { sessionRef: "sess-y4", appId: "mcp-center" }, connectionId: "echo", enabled: false }]);

    port.remove("echo");
    assert.equal(service.calls.delete[0].connectionId, "echo");
    assert.equal(store.connectionById("echo"), null);

    assert.equal(net.calls.length, 0, "connections 端口不得发网络（0 次 fetch）");
  } finally { net.restore(); }
});

test("① connections 端口：非白名单 serverKey / 明文远程 直接拒绝且 0 落盘", () => {
  const store = makeStore();
  const service = makeService(store);
  const port = makePort(store, service);

  assert.throws(
    () => port.save({ id: "evil", transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: "/bin/sh" }, enabled: true }),
    (error) => error.code === "MCP_LOCAL_SERVER_NOT_ALLOWED",
  );
  assert.throws(
    () => port.save({ id: "plain", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: "http://example.com/mcp" }, enabled: true }),
    (error) => error.code === "MCP_ENDPOINT_BLOCKED",
  );
  // App 自带的 command/args 不是端点：即使一起传，也不会被落库。
  const viaCommand = port.save({ id: "cmd", transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: "openarc-test-echo" }, command: "/bin/sh", args: ["-c", "id"], enabled: false });
  assert.deepEqual(viaCommand.endpoint, { serverKey: "openarc-test-echo" });
  assert.equal(JSON.stringify(store.connectionById("cmd").endpoint_json).includes("/bin/sh"), false);

  assert.equal(store.calls.insert.length, 1, "只有白名单那条落地：拒绝路径 0 次 save");
  assert.equal(service.calls.connect.length, 0, "拒绝路径 0 次 connect");
});

test("① connections 端口：缺存储 / 缺服务 / 无会话一律结构化失败（不静默）", async () => {
  // 缺存储：list/save 都必须抛带 code 的结构化错误，不能静默返回空目录或假成功。
  const noStore = createMcpConnectionsPort({});
  for (const [label, call] of [
    ["缺存储 list", () => noStore.list()],
    ["缺存储 save", () => noStore.save({ id: "x", transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: "openarc-test-echo" } })],
  ]) {
    assert.throws(call, (error) => error.code === AGENT_DEPENDENCY_UNAVAILABLE, label);
  }

  // 缺服务：有既有存储但没有既有 MCP 服务（listConnections）→ 同样结构化失败。
  const store = makeStore();
  const noService = createMcpConnectionsPort({ mcpStore: store });
  assert.throws(() => noService.list(), (error) => error.code === AGENT_DEPENDENCY_UNAVAILABLE, "缺服务 list");

  // 无会话：服务如实回授权失败，端口不得吞成空列表/假成功；save 不得静默落盘。
  const service = makeService(store, { listResult: { ok: false, error: "MCP_UNAUTHORIZED", reason: "no-session" } });
  const noSession = createMcpConnectionsPort({ mcpService: service, mcpStore: store, context: () => ({}) });
  assert.throws(() => noSession.list(), (error) => error.code === "MCP_UNAUTHORIZED", "无会话 list");
  assert.throws(() => noSession.save({ id: "x", transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: "openarc-test-echo" } }), (error) => error.code === PORT_ERROR.UNAUTHORIZED, "无会话 save");
  assert.equal(store.calls.insert.length, 0, "无会话不得静默落盘");
});

// ─────────────────────────────────────────────────────────────────────────────
// ② normalizeMcpList
// ─────────────────────────────────────────────────────────────────────────────
test("② normalizeMcpList：保留白名单 serverKey（平铺 / endpoint 两种声明），不保留 command/args", () => {
  const flat = capsOf([{ id: "echo", name: "回显", serverKey: "openarc-test-echo", command: "/bin/sh", args: ["-c", "id"], autoStart: true }]).mcp;
  assert.equal(flat.length, 1);
  assert.equal(flat[0].serverKey, "openarc-test-echo");
  assert.equal(flat[0].transport, "stdio");
  assert.equal("command" in flat[0], false, "App 自带 command 不得保留");
  assert.equal("args" in flat[0], false, "App 自带 args 不得保留");

  const nested = capsOf([{ id: "e2", name: "嵌套", endpoint: { serverKey: "openarc-test-echo" } }]).mcp;
  assert.equal(nested[0].serverKey, "openarc-test-echo", "endpoint.serverKey 声明同样归一化");

  const remote = capsOf([{ id: "r1", name: "远端", transport: "http", url: "https://mcp.example.com/rpc" }]).mcp;
  assert.equal(remote[0].transport, "http");
  assert.equal(remote[0].url, "https://mcp.example.com/rpc");
  assert.equal(remote[0].serverKey, undefined);

  const commandOnly = capsOf([{ id: "evil", name: "任意命令", transport: "stdio", command: "/bin/sh", args: ["-c", "id"] }]).mcp;
  assert.equal(commandOnly[0].serverKey, undefined, "只有 command 的声明没有 serverKey → 下游必然拒绝");
});

// ─────────────────────────────────────────────────────────────────────────────
// ③④⑤ 注册表 + 生产端口 端到端（离线）
// ─────────────────────────────────────────────────────────────────────────────
test("③ 白名单 stdio：注册成功 → 启用连接 → 禁用断开 → 卸载清理（0 网络）", async () => {
  const net = guardNetwork();
  try {
    const store = makeStore();
    const service = makeService(store);
    const port = makePort(store, service);
    const appState = { enabled: true, isEnabled() { return this.enabled; } };
    const registry = createAppManagedMcpRegistry({ connections: port, appState });
    const declarations = capsOf([{ id: "echo", name: "回显", serverKey: "openarc-test-echo", autoStart: true, command: "/bin/sh", args: ["-c", "id"] }]).mcp;

    const synced = await registry.sync("dev-demo", "", declarations);
    assert.equal(synced.ok, true, JSON.stringify(synced));
    assert.deepEqual(synced.connected, ["echo"]);
    assert.equal(store.calls.insert.length, 1);
    const stored = JSON.parse(store.connectionById("echo").endpoint_json);
    assert.deepEqual(stored, { serverKey: "openarc-test-echo", [MANAGED_KEY]: "dev-demo" });
    assert.equal(JSON.stringify(stored).includes("/bin/sh"), false, "App 命令不生效");
    assert.equal(service.calls.connect.length, 1);

    const off = await registry.setAppEnabled("dev-demo", false);
    assert.deepEqual(off.disabled, ["echo"]);
    assert.equal(store.connectionById("echo").enabled, 0);
    assert.equal(store.connectionById("echo").status, "DISABLED");
    assert.ok(service.calls.setEnabled.some((call) => call.enabled === false));

    const on = await registry.setAppEnabled("dev-demo", true);
    assert.deepEqual(on.connected, ["echo"]);
    assert.equal(store.connectionById("echo").enabled, 1);

    const removed = await registry.remove("dev-demo");
    assert.equal(removed.count, 1);
    assert.equal(store.connectionById("echo"), null);
    assert.equal(net.calls.length, 0);
  } finally { net.restore(); }
});

test("④ 白名单外 / App 自带 command：整批拒绝且 0 次 save / 0 次 connect", async () => {
  const net = guardNetwork();
  try {
    // 只有 command（normalizeMcpList 已丢掉它）→ 没有 serverKey → 整批拒绝。
    const onlyCommand = capsOf([{ id: "evil", name: "任意命令", transport: "stdio", command: "/bin/sh", args: ["-c", "id"], autoStart: true }]).mcp;
    const unknownKey = capsOf([{ id: "x", name: "未知 key", serverKey: "some-other-server", autoStart: true }]).mcp;
    // 混合批次：允许的那条也不落盘（fail-fast）。
    const mixed = [...capsOf([{ id: "echo", name: "回显", serverKey: "openarc-test-echo", autoStart: true }]).mcp, ...unknownKey];

    for (const [label, declarations, expected] of [
      ["only-command", onlyCommand, APP_MCP_ERROR.LOCAL_POLICY],
      ["unknown-key", unknownKey, APP_MCP_ERROR.LOCAL_POLICY],
      ["mixed", mixed, APP_MCP_ERROR.LOCAL_POLICY],
    ]) {
      const store = makeStore();
      const service = makeService(store);
      const registry = createAppManagedMcpRegistry({ connections: makePort(store, service), appState: { isEnabled: () => true } });
      const res = await registry.sync("dev-evil", "", declarations);
      assert.equal(res.ok, false, label);
      assert.equal(res.error, expected, label);
      assert.equal(res.policy, POLICY.LOCAL_SERVERS, label);
      assert.equal(store.calls.insert.length, 0, label + "：0 次落盘");
      assert.equal(store.calls.update.length, 0, label);
      assert.equal(service.calls.connect.length, 0, label + "：0 次连接");
    }
    assert.equal(net.calls.length, 0);
  } finally { net.restore(); }
});

test("⑤ http 声明：https 按既有策略通过，明文远程 / metadata IP 拒绝且 0 落盘", async () => {
  const store = makeStore();
  const service = makeService(store);
  const port = makePort(store, service);
  const registry = createAppManagedMcpRegistry({ connections: port, appState: { isEnabled: () => true } });

  const okDecl = capsOf([{ id: "remote", name: "远端", transport: "http", url: "https://mcp.example.com/rpc", autoStart: true, command: "/bin/sh" }]).mcp;
  const synced = await registry.sync("dev-a", "", okDecl);
  assert.equal(synced.ok, true, JSON.stringify(synced));
  assert.deepEqual(synced.connected, ["remote"]);
  const row = store.connectionById("remote");
  assert.equal(row.transport, "http");
  assert.equal(row.location, "REMOTE_SERVICE");
  // endpointScope 取既有 model-domain.validateEndpoint 的真实 scope（REMOTE_HTTPS，不存在 "REMOTE"）；
  // 归属键 managedByAppId 与 stdio 路径一致，落在同一 endpoint_json（不新开字段/表）。
  assert.deepEqual(JSON.parse(row.endpoint_json), { url: "https://mcp.example.com/rpc", endpointScope: "REMOTE_HTTPS", [MANAGED_KEY]: "dev-a" });

  for (const url of ["http://example.com/mcp", "http://169.254.169.254/latest/meta-data"]) {
    const badStore = makeStore();
    const badService = makeService(badStore);
    const badRegistry = createAppManagedMcpRegistry({ connections: makePort(badStore, badService), appState: { isEnabled: () => true } });
    const res = await badRegistry.sync("dev-a", "", capsOf([{ id: "plain", name: "明文", transport: "http", url, autoStart: true }]).mcp);
    assert.equal(res.ok, false, url);
    assert.equal(res.error, APP_MCP_ERROR.REMOTE_POLICY, url);
    assert.equal(res.policy, POLICY.REMOTE_ENDPOINT, url);
    assert.equal(badStore.calls.insert.length, 0, url + "：0 次落盘");
    assert.equal(badService.calls.connect.length, 0, url + "：0 次连接");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ bridge：serversPort 接入写端口，只读 list 兼容
// ─────────────────────────────────────────────────────────────────────────────
test("⑥ bridge：注入 connections 时写端口生效，list 仍是授权投影；未注入时形状逐字不变", async () => {
  const store = makeStore();
  const service = makeService(store);
  const sentinel = [{ id: "sentinel", name: "不该出现在只读 list", enabled: true, status: "connected", tools: [] }];
  const connections = { list: () => sentinel, save: () => {}, connect: async () => {}, disconnect: () => {}, remove: () => {} };

  const fakeMcpService = {
    listConnections: () => ({ ok: true, items: [{ connectionId: "mcp_echo", name: "回显", enabled: true, status: "READY", tools: [], toolsHidden: false }] }),
  };
  const bridge = createMcpAgentBridge({ mcpService: fakeMcpService, connections });
  assert.equal(typeof bridge.serversPort.save, "function");
  assert.equal(typeof bridge.serversPort.connect, "function");
  assert.equal(typeof bridge.serversPort.disconnect, "function");
  assert.equal(typeof bridge.serversPort.remove, "function");
  const rows = bridge.serversPort.list();
  assert.equal(rows[0].id, "mcp_echo", "只读 list 仍是 McpService 授权投影，不是 connections 的原始 list");
  assert.notEqual(rows, sentinel);

  const readOnly = createMcpAgentBridge({ mcpService: fakeMcpService });
  assert.equal(readOnly.serversPort.save, undefined, "未注入 connections：写方法不存在（既有降级）");
  assert.equal(typeof readOnly.serversPort.list, "function");

  // 写路径真的接到了 connections 端口（不落第二套状态）。
  let saved = null;
  const spyBridge = createMcpAgentBridge({
    mcpService: fakeMcpService,
    connections: { list: () => [], save: (cfg) => { saved = cfg; return cfg; }, connect: async () => {}, disconnect: () => {}, remove: () => {} },
  });
  await spyBridge.serversPort.save({ id: "echo", enabled: false });
  assert.deepEqual(saved, { id: "echo", enabled: false });
});

test("⑥ 未装配 registry：既有结构化降级逐字不变，0 次落盘 / 0 次连接", () => {
  const store = makeStore();
  const service = makeService(store);
  const api = createMcpAgentTools({ servers: makePort(store, service) });
  const results = [
    api.assertAppManagedMcpAvailable("dev-a", []),
    api.syncAppManagedMcpServers("dev-a", "", []),
    api.removeAppManagedMcpServers("dev-a"),
  ];
  for (const res of results) {
    assert.equal(res.ok, false);
    assert.equal(res.error, AGENT_DEPENDENCY_UNAVAILABLE);
    assert.equal(res.dependency, "developerApps");
  }
  assert.equal(store.calls.insert.length, 0);
  assert.equal(service.calls.connect.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ developer-service 生命周期绑定（真 bundle + spy registry，离线）
// ─────────────────────────────────────────────────────────────────────────────
function buildPackage(overrides = {}) {
  const manifest = Object.assign({
    format: "dx-app/v2", id: "demo", name: "Demo App", description: "a demo app",
    version: "1.0.0", build: 1,
    mcp: [{ id: "echo", name: "回显", serverKey: "openarc-test-echo", autoStart: true }],
  }, overrides);
  return writeZip([
    { name: "dx-app.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "index.html", data: Buffer.from("<html><body>demo</body></html>") },
  ]).toString("base64");
}

function openBundle(appMcpRegistry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-y4-"));
  const clock = () => 1_700_000_000_000;
  const identity = new IdentityStore({ path: path.join(dir, "identity.db"), clock }).open();
  const authStore = new AuthorizationStore({ identity, clock });
  const authorization = { resolveActor: () => ({ ok: true, user: { id: "u1", role: "ADMIN", team_id: "org1" }, organizationId: "org1" }) };
  const developer = createDeveloperBundle({
    userDataDir: dir, identityStore: identity, authorization, authStore, clock,
    lookup: async () => [], fetchImpl: async () => { throw new Error("本测试不联网"); },
    appMcpRegistry,
  });
  return { dir, identity, developer };
}

function makeRegistrySpy(overrides = {}) {
  const calls = { sync: [], setAppEnabled: [], remove: [] };
  return {
    calls,
    async sync(appId, sourceRoot, declarations) {
      calls.sync.push({ appId, sourceRoot, declarations });
      if (typeof overrides.sync === "function") return overrides.sync(appId, declarations);
      return { ok: true, connected: declarations.map((item) => item.id), servers: declarations, removed: [], skipped: [] };
    },
    async setAppEnabled(appId, enabled) {
      calls.setAppEnabled.push({ appId, enabled });
      if (typeof overrides.setAppEnabled === "function") return overrides.setAppEnabled(appId, enabled);
      return { ok: true, appId, enabled, connected: enabled ? [] : [], disabled: [] };
    },
    async remove(appId) {
      calls.remove.push({ appId });
      if (typeof overrides.remove === "function") return overrides.remove(appId);
      return { ok: true, appId, count: 0, removed: [] };
    },
  };
}

const callDev = (fx, command, payload) => fx.developer.execute(command, payload || {}, { sessionRef: "sess-y4", requestId: "req-y4" });

test("⑦ developer-service：安装注册声明 / 禁用断开 / 启用重判 / 卸载清理；失败降级不静默", async () => {
  const net = guardNetwork();
  try {
    const spy = makeRegistrySpy();
    const fx = openBundle(spy);
    try {
      const installed = await callDev(fx, "developer/install", { package: buildPackage() });
      assert.equal(installed.ok, true, JSON.stringify(installed));
      assert.equal(fx.developer.dependencies.appMcpRegistry, true);
      assert.equal(spy.calls.sync.length, 1, "安装即注册 App 声明");
      assert.equal(spy.calls.sync[0].appId, "dev-demo");
      assert.equal(spy.calls.sync[0].declarations[0].serverKey, "openarc-test-echo");
      assert.equal("command" in spy.calls.sync[0].declarations[0], false);

      const disabled = await callDev(fx, "developer/disable", { appId: "dev-demo" });
      assert.equal(disabled.ok, true, JSON.stringify(disabled));
      assert.deepEqual(spy.calls.setAppEnabled, [{ appId: "dev-demo", enabled: false }]);

      const enabled = await callDev(fx, "developer/enable", { appId: "dev-demo" });
      assert.equal(enabled.ok, true, JSON.stringify(enabled));
      assert.deepEqual(spy.calls.setAppEnabled[1], { appId: "dev-demo", enabled: true });

      const uninstalled = await callDev(fx, "developer/uninstall", { appId: "dev-demo" });
      assert.equal(uninstalled.ok, true, JSON.stringify(uninstalled));
      assert.deepEqual(spy.calls.remove, [{ appId: "dev-demo" }]);
      assert.equal(net.calls.length, 0, "生命周期不得发网络");
    } finally {
      try { fx.identity.close(); } catch { /* ignore */ }
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  } finally { net.restore(); }
});

test("⑦ developer-service：注册表失败 → 安装仍成功，原因记录进 app_runtime_events（不静默）", async () => {
  const spy = makeRegistrySpy({ sync: () => ({ ok: false, error: "MCP_APP_LOCAL_POLICY_REJECTED", policy: "LOCAL_SERVERS_WHITELIST", detail: "serverKey 不在白名单" }) });
  const fx = openBundle(spy);
  try {
    const installed = await callDev(fx, "developer/install", { package: buildPackage() });
    assert.equal(installed.ok, true, "MCP 注册失败不回滚安装本身");
    assert.equal(installed.value.mcp && installed.value.mcp.ok, false);
    const events = fx.identity.connection.prepare("SELECT event_type AS type FROM app_runtime_events WHERE app_id='dev-demo'").all().map((row) => row.type);
    assert.ok(events.includes("app.mcp.sync.error"), "失败必须留痕：" + JSON.stringify(events));
  } finally {
    try { fx.identity.close(); } catch { /* ignore */ }
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("⑦ developer-service：未注入注册表 → 生命周期调用全部跳过，既有返回形状不变", async () => {
  const fx = openBundle(null);
  try {
    assert.equal(fx.developer.dependencies.appMcpRegistry, false);
    const installed = await callDev(fx, "developer/install", { package: buildPackage() });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.equal(installed.value.mcp, undefined, "未装配时不得新增返回字段");
    const disabled = await callDev(fx, "developer/disable", { appId: "dev-demo" });
    assert.equal(disabled.ok, true);
    assert.equal(disabled.value.mcp, undefined);
    const enabled = await callDev(fx, "developer/enable", { appId: "dev-demo" });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.value.mcp, undefined);
    const uninstalled = await callDev(fx, "developer/uninstall", { appId: "dev-demo" });
    assert.equal(uninstalled.ok, true);
    assert.equal(uninstalled.value.mcp, undefined);
  } finally {
    try { fx.identity.close(); } catch { /* ignore */ }
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 源码级：main.cjs / developer-service.cjs 生产装配
// ─────────────────────────────────────────────────────────────────────────────
test("⑦ main.cjs 源码级：装配 connections 端口 + registry + appState，并传给 bridge/developer", () => {
  const main = fs.readFileSync(MAIN_PATH, "utf8");
  assert.ok(main.includes('require("./mcp-connections-port.cjs")'), "main 必须 require 生产 connections 端口");
  assert.ok(main.includes('require("./mcp-app-registry.cjs")'), "main 必须 require App 托管注册表");
  assert.ok(main.includes("createMcpConnectionsPort({"), "main 必须创建 connections 端口");
  assert.ok(main.includes("createAppManagedMcpRegistry({"), "main 必须创建 App 托管注册表");
  assert.ok(main.includes("connections: mcpConnectionsPort"), "registry/bridge 必须拿到同一个 connections 端口");
  assert.ok(main.includes("appRegistry: appManagedMcpRegistry"), "appRegistry 必须转交 createMcpAgentBridge/createMcpAgentTools");
  assert.ok(main.includes("appMcpRegistry: appManagedMcpRegistry"), "developer bundle 必须拿到 registry");
  assert.ok(main.includes("appState: mcpAppState"), "registry 必须拿到 developer 启用态 appState 端口");
  assert.ok(main.includes("getInstalled(userId, String(appId))"), "appState 必须来自 developer 的启用状态");
  // registry 缺失（identity.mcpService 未装起来）时必须是 null 而不是抛错。
  assert.ok(/const mcpConnectionsPort = identity\.mcpService[\s\S]*?: null;/.test(main), "端口创建必须有 null 降级分支");
  assert.ok(/const appManagedMcpRegistry = mcpConnectionsPort[\s\S]*?: null;/.test(main), "registry 创建必须有 null 降级分支");
  // 构造抛错也必须降级：两处构造点走同一个守卫，不能只判"依赖缺失"。
  assert.ok(main.includes("constructOrDegrade("), "端口/注册表构造必须走防崩守卫（构造失败不崩）");
  assert.ok(/const mcpConnectionsPort = identity\.mcpService[\s\S]*?constructOrDegrade\([\s\S]*?: null;/.test(main), "端口构造抛错必须降级为 null");
  assert.ok(/const appManagedMcpRegistry = mcpConnectionsPort[\s\S]*?constructOrDegrade\([\s\S]*?: null;/.test(main), "注册表构造抛错必须降级为 null");
});

test("⑦ 装配守卫：可选项构造抛错 → null + 结构化原因 + 一条降级日志，不把异常抛给启动链", () => {
  const events = [];
  const log = (event, detail) => events.push({ event, detail });
  const failed = constructOrDegrade("registry", () => { throw new Error("boom"); }, log);
  assert.equal(failed.ok, false);
  assert.equal(failed.value, null);
  assert.equal(failed.error, "CONSTRUCTION_FAILED");
  assert.equal(failed.label, "registry");
  assert.match(failed.detail, /boom/);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "mcp-wiring-construct-failed");
  assert.equal(events[0].detail.label, "registry");

  const ok = constructOrDegrade("port", () => ({ ready: true }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { ready: true });
  assert.equal(constructOrDegrade("x", null).ok, false, "缺 builder 也算构造失败（不静默成功）");
});

test("⑦ 连接失败如实归类：连不上的服务不得报成 connected（0 次假成功）", async () => {
  const net = guardNetwork();
  try {
    const store = makeStore();
    const service = makeService(store);
    service.connect = async () => ({ ok: false, error: "MCP_UNREACHABLE", detail: "spawn-failed" });
    const port = makePort(store, service);
    const registry = createAppManagedMcpRegistry({ connections: port, appState: { isEnabled: () => true } });
    const declarations = capsOf([{ id: "echo", name: "回显", serverKey: "openarc-test-echo", autoStart: true }]).mcp;

    const synced = await registry.sync("dev-a", "", declarations);
    assert.equal(synced.ok, false, "连接失败必须让结果 ok:false（不静默）");
    assert.deepEqual(synced.connected, [], "绝不把连不上的服务报成 connected");
    assert.deepEqual(synced.failed, [{ id: "echo", error: "MCP_UNREACHABLE", detail: "spawn-failed" }]);

    const on = await registry.setAppEnabled("dev-a", true);
    assert.equal(on.ok, false);
    assert.deepEqual(on.connected, []);
    assert.deepEqual(on.rejected, [{ id: "echo", error: "MCP_UNREACHABLE", policy: null, detail: "spawn-failed" }]);
    assert.equal(net.calls.length, 0);
  } finally { net.restore(); }
});

test("⑦ developer-service 源码级：启用/禁用/卸载绑定注册表，失败记录不静默", () => {
  const service = fs.readFileSync(SERVICE_PATH, "utf8");
  assert.ok(service.includes("appMcpRegistry.sync("));
  assert.ok(service.includes("appMcpRegistry.setAppEnabled("));
  assert.ok(service.includes("appMcpRegistry.remove("));
  assert.ok(service.includes('"app.mcp.sync.error"'));
  assert.ok(service.includes('"app.mcp.lifecycle.error"'));
  const domain = fs.readFileSync(DOMAIN_PATH, "utf8");
  assert.ok(domain.includes("不保留 command / args"), "normalizeMcpList 注释必须写清不保留自带的命令");
});
