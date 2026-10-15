/**
 * B4 收口 · MCP → Agent 工具目录装配（mcp-agent-bridge.cjs）离线测试。
 *
 * 覆盖父任务第 1 条的四项断言（全部离线，不启动 Electron、不联网）：
 *   (a) 注入假 mcp bundle 后 catalog 的 sources.mcp 有真实描述符；未注入时仍是 available:false；
 *   (b) 未连接 / 停用 server 不产生可执行工具（callByName 也拒绝）；
 *   (c) IPC 的 mcp/callTool 仍回 MCP_TOOL_INVOCATION_NOT_ENABLED（产品边界不放宽）；
 *   (d) 审批未通过 / 未注入审批端口时 0 次远端传输（B4d fail closed）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMcpAgentBridge, projectMcpServer, MCP_HOST_APP_ID } = require("../electron/mcp-agent-bridge.cjs");
const { createAgentBundle } = require("../electron/agent-service.cjs");
const { registerMcpIpc } = require("../electron/mcp-bootstrap.cjs");
const catalog = require("../electron/agent-tool-catalog.cjs");

/** McpService.listConnections 的投影形状（mcp-domain.cjs:281-307 projectConnection）。 */
const CONNECTED = {
  connectionId: "mcp_echo", name: "回显服务", serverName: "echo", enabled: true, status: "READY",
  tools: [{ name: "echo_sum", description: "求和", inputSchemaSummary: "type=object; properties: a:number" }],
  toolsHidden: false,
};
const OFFLINE = {
  connectionId: "mcp_off", name: "离线服务", serverName: "off", enabled: true, status: "ERROR",
  tools: [{ name: "do_thing", description: "离线工具" }], toolsHidden: false,
};
const DISABLED = {
  connectionId: "mcp_off2", name: "停用服务", enabled: false, status: "DISABLED",
  tools: [{ name: "nope", description: "停用工具" }], toolsHidden: false,
};
/** 只有 mcp.view 没有 mcp.use：连接可见但工具隐藏（mcp-service.cjs:95-108）。 */
const HIDDEN = {
  connectionId: "mcp_hidden", name: "只读服务", enabled: true, status: "READY", tools: [], toolsHidden: true,
};

/** 假 mcp bundle：只实现 bridge 需要的那一个同步方法，记录被查询到的 context。 */
function fakeMcpService(items, { result = null, contexts = [] } = {}) {
  return {
    contexts,
    listConnections({ context } = {}) {
      contexts.push(context);
      return result || { ok: true, items, total: items.length };
    },
  };
}

const authorization = { resolveActor: () => ({ ok: true, user: { id: "u1", role: "ADMIN", team_id: "org1" }, organizationId: "org1" }) };
const authStore = { appGrantsForApp: () => [] };

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, raw) { return handlers.get(channel)(event, raw); },
  };
}

test("bridge 形状：McpService 投影翻译为 catalog/createMcpAgentTools 的行，READY→connected", () => {
  assert.equal(createMcpAgentBridge(), null, "没有 mcpService 时必须返回 null（不伪造来源）");
  assert.equal(createMcpAgentBridge({ mcpService: {} }), null, "形状不符同样返回 null");

  assert.equal(projectMcpServer(null), null);
  assert.equal(projectMcpServer({ name: "无 id" }), null);
  const row = projectMcpServer(CONNECTED);
  assert.equal(row.id, "mcp_echo");
  assert.equal(row.status, "connected");
  assert.equal(row.enabled, true);
  assert.equal(row.tools.length, 1);
  assert.equal(row.tools[0].name, "echo_sum");
  // 完整 inputSchema 不在投影里（mcp-domain.cjs:157-177 只存 summary）→ 不补、不猜。
  assert.equal(row.tools[0].inputSchema, undefined);
  assert.equal(row.tools[0].inputSchemaSummary.includes("properties"), true);
  // 非就绪态照实翻译，不硬改 semantic。
  assert.equal(projectMcpServer(OFFLINE).status, "ERROR");
  assert.equal(projectMcpServer(DISABLED).status, "DISABLED");
  // toolsHidden=true 时不产出任何工具行。
  assert.equal(projectMcpServer(HIDDEN).tools.length, 0);
  assert.equal(projectMcpServer(HIDDEN).toolsVisible, false);
});

test("(a) 未注入 → catalog mcp 来源 available:false；注入假 mcp bundle → 出现真实描述符", async () => {
  catalog.resetToolCatalogForTests();
  // 未注入：mcp_registry 的 unavailable fallback（agent-tool-catalog.cjs:83-87）。
  let snapshot = catalog.toolCatalogSnapshot({});
  assert.deepEqual(snapshot.descriptors.filter((d) => d.source === "mcp").map((d) => d.status), ["unavailable"]);
  assert.equal(snapshot.summary.sources.mcp, 1);

  const mcpService = fakeMcpService([CONNECTED, OFFLINE, DISABLED, HIDDEN]);
  const bridge = createMcpAgentBridge({ mcpService });
  assert.ok(bridge && bridge.mcpAgentTools && typeof bridge.mcpServersSnapshot === "function");
  createAgentBundle({ toolCatalog: catalog, authorization, authStore, mcpAgentTools: bridge.mcpAgentTools, mcpServersSnapshot: bridge.mcpServersSnapshot });

  snapshot = catalog.toolCatalogSnapshot({});
  const mcpDescriptors = snapshot.descriptors.filter((d) => d.source === "mcp");
  assert.equal(mcpDescriptors.some((d) => d.name === "mcp_registry"), false, "注入后不能再给 unavailable fallback");
  const connected = mcpDescriptors.find((d) => d.name === "mcp__mcp_echo__echo_sum");
  assert.ok(connected, "已连接 server 的工具必须成为真实描述符");
  assert.equal(connected.status, "ready");
  assert.equal(connected.enabled, true);
  assert.equal(connected.executable, true);
  assert.equal(connected.handler.type, "mcp-tool");
  assert.equal(connected.handler.serverId, "mcp_echo");
  assert.equal(connected.handler.toolName, "echo_sum");
  assert.ok(connected.description.includes("回显服务"));
  assert.ok(snapshot.summary.sources.mcp >= 3, "连接/离线/停用 server 都应在目录中如实出现");

  // 经 agent:command 白名单路径同样能拿到真实 mcp 描述符（source 过滤 + 默认 executableOnly）。
  const bundleResult = await (async () => {
    const bundle = createAgentBundle({ toolCatalog: catalog, authorization, authStore, mcpAgentTools: bridge.mcpAgentTools, mcpServersSnapshot: bridge.mcpServersSnapshot });
    return bundle.execute("agent/tool/catalog", { source: "mcp" }, { sessionRef: "s1" });
  })();
  assert.equal(bundleResult.ok, true);
  assert.deepEqual(bundleResult.value.descriptors.map((d) => d.name).sort(), ["mcp__mcp_echo__echo_sum"]);
});

test("(b) 未连接 / 停用 server 不产生可执行工具，callByName 也拒绝", async (t) => {
  const mcpService = fakeMcpService([CONNECTED, OFFLINE, DISABLED, HIDDEN]);
  const bridge = createMcpAgentBridge({ mcpService });

  catalog.configureToolCatalog({ sources: { mcp: { list: bridge.mcpServersSnapshot, call: () => {} } }, auth: null, weather: null, clock: null });
  const snapshot = catalog.toolCatalogSnapshot({});
  const offline = snapshot.descriptors.find((d) => d.name === "mcp__mcp_off__do_thing");
  assert.ok(offline, "离线 server 的登记工具仍要如实出现（不是消失）");
  assert.equal(offline.enabled, false);
  assert.equal(offline.executable, false);
  assert.equal(offline.status, "unavailable");
  assert.match(offline.statusText, /ERROR/);
  const disabled = snapshot.descriptors.find((d) => d.name === "mcp__mcp_off2__nope");
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.executable, false);
  assert.equal(snapshot.descriptors.some((d) => d.source === "mcp" && d.sourceId === "mcp_hidden" && d.executable), false);

  // executableOnly：只有真正 connected 的工具进模型可见列表（agent/tool/catalog 的默认口径）。
  const exec = catalog.toolCatalogSnapshot({ source: "mcp", executableOnly: true });
  assert.deepEqual(exec.descriptors.map((d) => d.name), ["mcp__mcp_echo__echo_sum"]);

  // 未连接的工具不在 createMcpAgentTools 的索引里 → 结构化 UNKNOWN_MCP_TOOL。
  const unknown = await bridge.mcpAgentTools.callByName("mcp__mcp_off__do_thing", {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "UNKNOWN_MCP_TOOL");
});

test("(c) IPC mcp/callTool 仍回 MCP_TOOL_INVOCATION_NOT_ENABLED（产品边界未放宽）", async () => {
  // 用一个"随便调用就成功"的假 service：若注册路径放行，这里会暴露出来。
  const service = { listConnections: () => ({ ok: true, items: [] }), invokeTool: () => ({ ok: true, fake: true }) };
  const ipcMain = fakeIpcMain();
  registerMcpIpc({ ipcMain, service, identity: { current: "s1" }, isTrusted: () => true });
  for (const command of ["mcp/callTool", "mcp/call", "mcp/invoke", "mcp/invokeTool", "mcp/toolCall"]) {
    const res = await ipcMain.invoke("mcp:command", {}, { command, payload: { connectionId: "mcp_echo", name: "echo_sum" } });
    assert.deepEqual(res, { ok: false, error: "MCP_TOOL_INVOCATION_NOT_ENABLED" }, command + " 必须被拒");
  }
  // 未登记的命令仍是 COMMAND_NOT_ALLOWED（不是 invocation 边界）。
  const other = await ipcMain.invoke("mcp:command", {}, { command: "mcp/unknown", payload: {} });
  assert.equal(other.error, "MCP_COMMAND_NOT_ALLOWED");
});

test("(d) 审批未通过 / 未注入时 0 次远端传输；未注入 approval 时 fail closed", async () => {
  const mcpService = fakeMcpService([CONNECTED]);
  function countingTransport() {
    const calls = [];
    return { calls, async callTool(input) { calls.push(input); return { content: [{ type: "text", text: "should-not-happen" }] }; } };
  }

  // 未注入 approval：结构化 AGENT_DEPENDENCY_UNAVAILABLE，传输 0 次。
  const noApprovalTransport = countingTransport();
  const noApproval = createMcpAgentBridge({ mcpService, transport: noApprovalTransport });
  const deniedByDefault = await noApproval.mcpAgentTools.callByName("mcp__mcp_echo__echo_sum", { a: 1 });
  assert.equal(deniedByDefault.ok, false);
  assert.equal(deniedByDefault.error, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(deniedByDefault.dependency, "mcpApproval");
  assert.equal(noApprovalTransport.calls.length, 0, "审批链未注入时绝不允许传输");

  // 审批 DENIED：0 次传输。
  const deniedTransport = countingTransport();
  const denied = createMcpAgentBridge({ mcpService, transport: deniedTransport, approval: { authorize: async () => ({ decisionStatus: "DENIED", reasonCode: "TOOL_DENIED" }) } });
  const deniedRes = await denied.mcpAgentTools.callByName("mcp__mcp_echo__echo_sum", { a: 1 });
  assert.equal(deniedRes.ok, false);
  assert.equal(deniedRes.error, "APPROVAL_DENIED");
  assert.equal(deniedTransport.calls.length, 0);

  // 审批 APPROVAL_REQUIRED（等待可信用户）：仍 0 次传输，并把审批请求号如实带回。
  const pendingTransport = countingTransport();
  const pending = createMcpAgentBridge({ mcpService, transport: pendingTransport, approval: { authorize: async () => ({ decisionStatus: "APPROVAL_REQUIRED", approvalRequestId: "appr-1" }) } });
  const pendingRes = await pending.mcpAgentTools.callByName("mcp__mcp_echo__echo_sum", { a: 1 });
  assert.equal(pendingRes.ok, false);
  assert.equal(pendingRes.error, "APPROVAL_REQUIRED");
  assert.equal(pendingRes.approvalRequestId, "appr-1");
  assert.equal(pendingTransport.calls.length, 0);
});

test("真实 McpService：投影字段与授权可见性对齐 D5-03（未连接 → DISABLED / 无工具）", async () => {
  const { createMcpFixture } = await import("./mcp-fixtures.mjs");
  const fx = await createMcpFixture();
  try {
    const created = await fx.createLocal({ name: "本地回显" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const connectionId = created.connection.connectionId;

    const bridge = createMcpAgentBridge({ mcpService: fx.mcpService, context: () => ({ sessionRef: fx.sessions.admin, appId: "mcp-center" }) });
    const rows = bridge.mcpServersSnapshot();
    const row = rows.find((item) => item.id === connectionId);
    assert.ok(row, "真实 listConnections 的 connectionId 必须被投影成 id");
    assert.equal(row.name, "本地回显");
    assert.equal(row.enabled, false, "创建后默认未启用（mcp-service.cjs:189 enabled:false）");
    assert.equal(row.connected, false);
    assert.equal(row.status, "DISABLED");
    assert.deepEqual(row.tools, [], "未握手就没有工具：不凭空产生描述符");

    // 真实 McpService + catalog：未连接 server 在 executableOnly 下不产生可执行工具。
    catalog.configureToolCatalog({ sources: { mcp: { list: bridge.mcpServersSnapshot, call: () => {} } }, auth: null, weather: null, clock: null });
    assert.deepEqual(catalog.toolCatalogSnapshot({ source: "mcp", executableOnly: true }).descriptors, []);

    // 只有 mcp.view 的 App（resource-library）能看到连接但看不到工具（toolsHidden → tools 置空）。
    const viewOnly = createMcpAgentBridge({ mcpService: fx.mcpService, hostAppId: "resource-library", context: () => ({ sessionRef: fx.sessions.admin }) });
    const hidden = viewOnly.mcpServersSnapshot().find((item) => item.id === connectionId);
    assert.ok(hidden);
    assert.equal(hidden.toolsVisible, false);
    assert.deepEqual(hidden.tools, []);
  } finally {
    await fx.close();
  }
});

test("授权上下文：appId 用 MCP 中心 Principal，sessionRef 由宿主提供，结果为空时返回空列表", () => {
  const contexts = [];
  const mcpService = fakeMcpService([CONNECTED], { contexts });
  const bridge = createMcpAgentBridge({ mcpService, context: () => ({ sessionRef: "sess-1" }) });
  bridge.mcpServersSnapshot();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].appId, MCP_HOST_APP_ID);
  assert.equal(contexts[0].sessionRef, "sess-1");

  const unauthorized = createMcpAgentBridge({ mcpService: fakeMcpService([], { result: { ok: false, error: "MCP_UNAUTHORIZED" } }) });
  assert.deepEqual(unauthorized.mcpServersSnapshot(), []);
  assert.equal(unauthorized.statusReason(), "MCP_UNAUTHORIZED");
});

test("真实 McpService：updateConnection 重写端点保留托管归属键 managedByAppId（不改表结构）", async () => {
  const { createMcpFixture, ECHO } = await import("./mcp-fixtures.mjs");
  const fx = await createMcpFixture();
  try {
    const created = await fx.createLocal({ name: "归属保留" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = created.connection.connectionId;
    // 模拟 Y4 端口落归属：同一 endpoint_json 的附加键，不加列、不建表。
    fx.mcpStore.updateConnection(id, { endpointJson: JSON.stringify({ serverKey: ECHO.serverKey, managedByAppId: "dev-a" }) });

    const updated = await fx.mcpService.updateConnection({ context: fx.mcpCtx(), connectionId: id, patch: { endpoint: { serverKey: ECHO.serverKey } } });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const parsed = JSON.parse(fx.mcpStore.connectionById(id).endpoint_json);
    assert.equal(parsed.managedByAppId, "dev-a", "通用编辑重写端点不得丢归属键");
    assert.equal(parsed.serverKey, ECHO.serverKey);
    // 归属键不进入渲染层：projectEndpoint 只回 serverKey / url。
    assert.equal(Object.prototype.hasOwnProperty.call(updated.connection.endpoint, "managedByAppId"), false);

    // 无归属的普通连接不受影响：不得凭空生成归属键。
    const plain = await fx.createLocal({ name: "普通连接" });
    const plainId = plain.connection.connectionId;
    const before = fx.mcpStore.connectionById(plainId).endpoint_json;
    const after = await fx.mcpService.updateConnection({ context: fx.mcpCtx(), connectionId: plainId, patch: { endpoint: { serverKey: ECHO.serverKey } } });
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.equal(fx.mcpStore.connectionById(plainId).endpoint_json, before, "没有归属时不得凭空添加键");
  } finally {
    await fx.close();
  }
});
