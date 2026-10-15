/**
 * Y1 · 宿主侧 App 托管 MCP 注册表 离线测试。
 *
 * 被测算的是产品代码：electron/mcp-app-registry.cjs + electron/mcp-agent-tools.cjs 的三个入口，
 * 不是测试自造的复制品。全程离线：只用内存版"既有 MCP 配置来源/连接目录"端口，
 * 不 spawn 进程、不联网、不落盘、不 npm install。
 *
 * 覆盖任务要求：
 *   ① 白名单允许的 App 服务 → 可注册 / 连接 / 移除；
 *   ② 不在白名单或违反策略 → 结构化拒绝且 0 次 save / 0 次 connect；
 *   ③ App 禁用 → 其托管服务不可用 / 断开；启用 → 按白名单与策略重新判定；
 *   ④ 重复注册幂等；
 *   ⑤ 卸载清理（别的 App / 手动连接不受影响）；
 *   ⑥ 未装配注册表时既有结构化降级不变。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const registryMod = require("../electron/mcp-app-registry.cjs");
const toolsMod = require("../electron/mcp-agent-tools.cjs");
const { createAppManagedMcpRegistry, APP_MCP_ERROR, POLICY } = registryMod;
const { createMcpAgentTools, AGENT_DEPENDENCY_UNAVAILABLE } = toolsMod;

// ── 夹具：既有 MCP 配置来源 + 连接生命周期端口（内存实现，记录每次副作用）──────
function makeConnections(initial = []) {
  const state = new Map();
  for (const row of initial) state.set(String(row.id), { status: "DISABLED", enabled: false, ...row });
  const calls = { save: [], connect: [], disconnect: [], remove: [] };
  return {
    state,
    calls,
    list() { return [...state.values()].map((row) => ({ ...row })); },
    save(cfg) {
      const id = String(cfg.id);
      const next = { ...(state.get(id) || {}), ...cfg, id };
      state.set(id, next);
      calls.save.push({ ...next });
      return { ...next };
    },
    connect(cfg) {
      const id = String(cfg.id);
      calls.connect.push(id);
      const cur = state.get(id);
      if (cur) cur.status = "connected";
      return cur || null;
    },
    disconnect(id) {
      calls.disconnect.push(String(id));
      const cur = state.get(String(id));
      if (cur) cur.status = "DISABLED";
    },
    remove(id) {
      calls.remove.push(String(id));
      state.delete(String(id));
    },
  };
}

/** 白名单允许的本地声明（serverKey 命中 mcp-domain.cjs:72 LOCAL_SERVERS）。 */
const ALLOWED_LOCAL = { id: "echo", name: "回显", serverKey: "openarc-test-echo", autoStart: true };
/** 越权声明：App 自带任意 stdio 命令 —— 既有白名单不接受。 */
const ARBITRARY_COMMAND = { id: "evil", name: "任意命令", transport: "stdio", command: "/bin/sh", args: ["-c", "id"], autoStart: true };

function makeApi(connections, options = {}) {
  const registry = createAppManagedMcpRegistry({ connections, ...options });
  const api = createMcpAgentTools({ servers: connections, appRegistry: registry });
  return { registry, api };
}

describe("Y1 · App 托管 MCP 注册表", () => {
  it("① 白名单允许的 App 服务：可注册 / 连接 / 移除（归属落在既有配置记录上）", async () => {
    const connections = makeConnections();
    const { registry, api } = makeApi(connections);

    const gate = await api.assertAppManagedMcpAvailable("dev-a", [ALLOWED_LOCAL]);
    assert.equal(gate.ok, true, JSON.stringify(gate));
    assert.deepEqual(gate.plans.map((p) => p.id), ["echo"]);

    const synced = await api.syncAppManagedMcpServers("dev-a", "/apps/a", [ALLOWED_LOCAL]);
    assert.equal(synced.ok, true, JSON.stringify(synced));
    assert.deepEqual(synced.connected, ["echo"]);
    assert.deepEqual(synced.removed, []);
    const row = connections.state.get("echo");
    assert.equal(row.managedByAppId, "dev-a", "归属必须落在既有配置记录上，不新造配置文件");
    assert.equal(row.enabled, true);
    assert.equal(row.transport, "stdio");
    assert.deepEqual(row.endpoint, { serverKey: "openarc-test-echo" });
    assert.equal(connections.calls.connect.length, 1);

    const owned = await registry.listOwned("dev-a");
    assert.equal(owned.servers.length, 1);

    const removed = await api.removeAppManagedMcpServers("dev-a");
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(removed.count, 1);
    assert.equal(connections.state.has("echo"), false);
    assert.deepEqual(connections.calls.remove, ["echo"]);
  });

  it("① 远程 https 声明同样走既有 endpoint 策略后可注册并连接", async () => {
    const connections = makeConnections();
    const { api } = makeApi(connections);
    const decl = { id: "remote", name: "远端", transport: "http", url: "https://mcp.example.com/rpc", autoStart: true };
    const synced = await api.syncAppManagedMcpServers("dev-a", "/apps/a", [decl]);
    assert.equal(synced.ok, true, JSON.stringify(synced));
    assert.deepEqual(synced.connected, ["remote"]);
    const row = connections.state.get("remote");
    assert.equal(row.transport, "http");
    assert.equal(row.location, "REMOTE_SERVICE");
    assert.equal(row.endpoint.url, "https://mcp.example.com/rpc");
  });

  it("② 越权 stdio（App 自带任意命令）→ 结构化拒绝且 0 次 save / 0 次 connect", async () => {
    const connections = makeConnections();
    const { api } = makeApi(connections);
    const res = await api.syncAppManagedMcpServers("dev-evil", "/apps/e", [ARBITRARY_COMMAND]);
    assert.equal(res.ok, false);
    assert.equal(res.error, APP_MCP_ERROR.LOCAL_POLICY);
    assert.equal(res.policy, POLICY.LOCAL_SERVERS, "必须说明卡在既有白名单这条策略上");
    assert.match(res.detail, /LOCAL_SERVERS|白名单/);
    assert.equal(connections.calls.save.length, 0);
    assert.equal(connections.calls.connect.length, 0);
    assert.equal(connections.state.size, 0);
  });

  it("② 未知本地 serverKey → 结构化拒绝（不猜测、不回落默认程序）", async () => {
    const connections = makeConnections();
    const { api } = makeApi(connections);
    const res = await api.assertAppManagedMcpAvailable("dev-a", [{ id: "x", serverKey: "some-other-server" }]);
    assert.equal(res.ok, false);
    assert.equal(res.error, APP_MCP_ERROR.LOCAL_POLICY);
    assert.equal(res.policy, POLICY.LOCAL_SERVERS);
  });

  it("② 明文远程 / metadata IP → 结构化拒绝且 0 次 save / 0 次 connect", async () => {
    const connections = makeConnections();
    const { api } = makeApi(connections);
    const plain = await api.syncAppManagedMcpServers("dev-a", "/apps/a", [{ id: "plain", transport: "http", url: "http://example.com/mcp", autoStart: true }]);
    assert.equal(plain.ok, false);
    assert.equal(plain.error, APP_MCP_ERROR.REMOTE_POLICY);
    assert.equal(plain.policy, POLICY.REMOTE_ENDPOINT);
    assert.match(plain.detail, /validateRemoteEndpoint|remote-requires-https/);

    const metadata = await api.syncAppManagedMcpServers("dev-a", "/apps/a", [{ id: "meta", transport: "http", url: "http://169.254.169.254/latest/meta-data", autoStart: true }]);
    assert.equal(metadata.ok, false);
    assert.equal(metadata.error, APP_MCP_ERROR.REMOTE_POLICY);
    assert.match(metadata.detail, /metadata/);

    assert.equal(connections.calls.save.length, 0);
    assert.equal(connections.calls.connect.length, 0);
    assert.equal(connections.state.size, 0);
  });

  it("② 混合批次任一声明越权 → 整批拒绝（fail-fast，允许的那条也不落盘）", async () => {
    const connections = makeConnections();
    const { api } = makeApi(connections);
    const res = await api.syncAppManagedMcpServers("dev-mix", "/apps/m", [ALLOWED_LOCAL, ARBITRARY_COMMAND]);
    assert.equal(res.ok, false);
    assert.equal(res.error, APP_MCP_ERROR.LOCAL_POLICY);
    assert.equal(connections.calls.save.length, 0);
    assert.equal(connections.calls.connect.length, 0);
    assert.equal(connections.state.size, 0);
  });

  it("② ID 已被别的 App / 用户占用 → 结构化冲突，0 次 save", async () => {
    const connections = makeConnections([{ id: "taken", managedByAppId: "dev-b", enabled: true, status: "connected" }]);
    const { api } = makeApi(connections);
    const res = await api.syncAppManagedMcpServers("dev-a", "/apps/a", [{ id: "taken", serverKey: "openarc-test-echo", autoStart: true }]);
    assert.equal(res.ok, false);
    assert.equal(res.error, APP_MCP_ERROR.SERVER_ID_CONFLICT);
    assert.equal(res.owner, "dev-b");
    assert.equal(connections.calls.save.length, 0);
    assert.equal(connections.calls.connect.length, 0);

    const userOwned = makeConnections([{ id: "manual", name: "手动", transport: "http", endpoint: { url: "https://x.example.com/mcp" }, enabled: true, status: "READY" }]);
    const userRes = await createMcpAgentTools({ servers: userOwned, appRegistry: createAppManagedMcpRegistry({ connections: userOwned }) })
      .syncAppManagedMcpServers("dev-a", "/apps/a", [{ id: "manual", serverKey: "openarc-test-echo", autoStart: true }]);
    assert.equal(userRes.ok, false);
    assert.equal(userRes.owner, "user");
  });

  it("③ App 禁用：其托管连接断开并不可用；启用：重新判定后连接", async () => {
    const connections = makeConnections();
    const appState = { enabled: true, isEnabled() { return this.enabled; } };
    const { registry, api } = makeApi(connections, { appState });
    await api.syncAppManagedMcpServers("dev-a", "/apps/a", [ALLOWED_LOCAL]);
    assert.equal(connections.state.get("echo").enabled, true);

    const off = await registry.setAppEnabled("dev-a", false);
    assert.equal(off.ok, true);
    assert.equal(off.enabled, false);
    assert.deepEqual(off.disabled, ["echo"]);
    const disabledRow = connections.state.get("echo");
    assert.equal(disabledRow.enabled, false);
    assert.equal(disabledRow.status, "DISABLED");
    assert.ok(connections.calls.disconnect.includes("echo"));

    // 既有语义直接让调用不可用（审批与传输之前就拒绝），聚合也不再出现该服务。
    const call = await api.callDirect("echo", "echo_tool", {});
    assert.equal(call.error, "MCP_SERVER_NOT_CONNECTED");
    const tools = await api.agentToolsForServer("echo");
    assert.deepEqual(tools.tools, []);

    appState.enabled = true;
    const on = await registry.setAppEnabled("dev-a", true);
    assert.equal(on.ok, true, JSON.stringify(on));
    assert.deepEqual(on.connected, ["echo"]);
    assert.equal(connections.state.get("echo").enabled, true);
    assert.equal(connections.state.get("echo").status, "connected");
  });

  it("③ App 处于禁用态时 sync 只登记不连接（不因为 autoStart 偷偷连上）", async () => {
    const connections = makeConnections();
    const { api } = makeApi(connections, { appState: { isEnabled: () => false } });
    const synced = await api.syncAppManagedMcpServers("dev-a", "/apps/a", [ALLOWED_LOCAL]);
    assert.equal(synced.ok, true);
    assert.deepEqual(synced.connected, []);
    assert.deepEqual(synced.skipped, [{ id: "echo", reason: "APP_DISABLED" }]);
    assert.equal(connections.calls.connect.length, 0);
    assert.equal(connections.state.get("echo").enabled, false);
  });

  it("④ 重复注册幂等：同 id 只保留一条记录，不产生第二份", async () => {
    const connections = makeConnections();
    const { api } = makeApi(connections);
    await api.syncAppManagedMcpServers("dev-a", "/apps/a", [ALLOWED_LOCAL]);
    assert.deepEqual([...connections.state.keys()], ["echo"]);
    const second = await api.syncAppManagedMcpServers("dev-a", "/apps/a", [ALLOWED_LOCAL]);
    assert.equal(second.ok, true);
    assert.deepEqual([...connections.state.keys()], ["echo"]);
    assert.equal(connections.state.size, 1);
  });

  it("④ 同 App 去掉声明 → 该条断开并清理；保留的声明更新不重复", async () => {
    const connections = makeConnections();
    const { api } = makeApi(connections);
    const two = [ALLOWED_LOCAL, { id: "echo2", serverKey: "openarc-test-echo", autoStart: true }];
    await api.syncAppManagedMcpServers("dev-a", "/apps/a", two);
    assert.equal(connections.state.size, 2);
    const res = await api.syncAppManagedMcpServers("dev-a", "/apps/a", [ALLOWED_LOCAL]);
    assert.deepEqual(res.removed, ["echo2"]);
    assert.equal(connections.state.has("echo2"), false);
    assert.equal(connections.state.has("echo"), true);
  });

  it("⑤ 卸载清理：只清该 App 的托管记录，手动连接不受影响；无托管时幂等成功", async () => {
    const connections = makeConnections([{ id: "manual", name: "手动", transport: "http", endpoint: { url: "https://x.example.com/mcp" }, enabled: true, status: "READY" }]);
    const { api } = makeApi(connections);
    await api.syncAppManagedMcpServers("dev-a", "/apps/a", [ALLOWED_LOCAL]);
    const res = await api.removeAppManagedMcpServers("dev-a");
    assert.equal(res.ok, true);
    assert.equal(res.count, 1);
    assert.equal(connections.state.has("echo"), false);
    assert.equal(connections.state.has("manual"), true, "别的连接不能被连带清理");
    const again = await api.removeAppManagedMcpServers("dev-a");
    assert.equal(again.ok, true);
    assert.equal(again.count, 0);
  });

  it("⑤ 端口缺 remove 时卸载清理结构化失败，不做半断开的部分副作用", async () => {
    const connections = makeConnections([{ id: "echo", managedByAppId: "dev-a", enabled: true, status: "connected", endpoint: { serverKey: "openarc-test-echo" } }]);
    delete connections.remove;
    const { api } = makeApi(connections);
    const res = await api.removeAppManagedMcpServers("dev-a");
    assert.equal(res.ok, false);
    assert.equal(res.error, AGENT_DEPENDENCY_UNAVAILABLE);
    assert.equal(res.dependency, "connections.remove");
    assert.equal(connections.calls.disconnect.length, 0);
    assert.equal(connections.state.has("echo"), true);
  });

  it("⑥ 未装配注册表：实例与模块级三个入口都保持既有结构化降级（0 次落盘）", async () => {
    const connections = makeConnections();
    const api = createMcpAgentTools({ servers: connections });
    const results = [
      api.assertAppManagedMcpAvailable("dev-a", [ALLOWED_LOCAL]),
      api.syncAppManagedMcpServers("dev-a", "/apps/a", [ALLOWED_LOCAL]),
      api.removeAppManagedMcpServers("dev-a"),
      toolsMod.assertAppManagedMcpAvailable("dev-a", [ALLOWED_LOCAL]),
      toolsMod.syncAppManagedMcpServers("dev-a", "/apps/a", [ALLOWED_LOCAL]),
      toolsMod.removeAppManagedMcpServers("dev-a"),
    ];
    for (const res of results) {
      assert.equal(res.ok, false);
      assert.equal(res.error, AGENT_DEPENDENCY_UNAVAILABLE);
      assert.equal(res.dependency, "developerApps");
    }
    assert.equal(connections.calls.save.length, 0);
    assert.equal(connections.calls.connect.length, 0);
  });

  it("⑥ 模块级三个入口显式传入注册表时同样按真实能力工作", async () => {
    const connections = makeConnections();
    const registry = createAppManagedMcpRegistry({ connections });
    const gate = await toolsMod.assertAppManagedMcpAvailable("dev-a", [ALLOWED_LOCAL], registry);
    assert.equal(gate.ok, true);
    const synced = await toolsMod.syncAppManagedMcpServers("dev-a", "/apps/a", [ALLOWED_LOCAL], registry);
    assert.equal(synced.ok, true);
    assert.deepEqual(synced.connected, ["echo"]);
    const removed = await toolsMod.removeAppManagedMcpServers("dev-a", registry);
    assert.equal(removed.ok, true);
  });

  it("⑥ 注册表缺连接目录端口：结构化不可用，精确到方法", async () => {
    const registry = createAppManagedMcpRegistry({});
    const res = await registry.sync("dev-a", "/apps/a", [ALLOWED_LOCAL]);
    assert.equal(res.ok, false);
    assert.equal(res.error, AGENT_DEPENDENCY_UNAVAILABLE);
    assert.equal(res.dependency, "connections.list");
  });
});
