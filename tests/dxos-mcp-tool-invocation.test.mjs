/**
 * B4e · MCP 工具调用能力（只读聚合命令 + Registry 合同 + 显式开关门）离线测试。
 *
 * 全程离线：不 spawn 进程、不联网、不 npm install；被测算的都是产品模块：
 *   · electron/mcp-bootstrap.cjs   —— mcp/agentTools 只读聚合命令（trusted + 白名单 + 脱敏）
 *   · electron/mcp-tool-contract.cjs —— MCP 工具 → ToolRegistry contract（EXTERNAL_SIDE_EFFECT）
 *   · electron/mcp-switch.cjs      —— <userData>/dxos/mcp.json 显式开关（默认关闭）
 *   · electron/mcp-agent-tools.cjs —— 开关门：关闭 → MCP_TOOL_INVOCATION_NOT_ENABLED，0 次传输
 *   · electron/mcp-agent-bridge.cjs —— 生产装配：switch + registry + 既有审批适配器
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMcpAgentTools, MCP_AGENT_ERROR } = require("../electron/mcp-agent-tools.cjs");
const { mcpToolIdFor, buildMcpToolContract, registerMcpToolContracts, paramSummaryText } = require("../electron/mcp-tool-contract.cjs");
const { createMcpSwitch, defaultState } = require("../electron/mcp-switch.cjs");
const { ToolRegistry } = require("../electron/tool-registry.cjs");
const { createMcpAgentBridge } = require("../electron/mcp-agent-bridge.cjs");
const { registerMcpIpc, MCP_COMMANDS } = require("../electron/mcp-bootstrap.cjs");

// ── 夹具 ──────────────────────────────────────────────────────────────
function makeServers(initial = []) {
  const state = new Map();
  for (const s of initial) state.set(s.id, { status: "connected", tools: [], enabled: true, ...s });
  return { list: () => [...state.values()].map((s) => ({ ...s, tools: (s.tools || []).map((t) => ({ ...t })) })) };
}
function makeTransport(handler) {
  const calls = [];
  return { calls, async callTool(req) { calls.push(req); return handler ? handler(req, calls.length) : { content: [{ type: "text", text: "ok" }] }; } };
}
function makeGate(decision) {
  const calls = [];
  return { calls, async authorize(req) { calls.push(req); return typeof decision === "function" ? decision(req, calls.length) : decision; } };
}
function fakeIpcMain() {
  const handlers = new Map();
  return { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c), invoke: (c, e, raw) => handlers.get(c)(e, raw) };
}
const TEXT_OK = (text) => ({ content: [{ type: "text", text }] });
const SERVER_TOOL = (name, description = "", extra = {}) => ({ name, description, ...extra });

// ── ① 只读聚合命令：字段契约 + 脱敏 ─────────────────────────────────────
test("mcp/agentTools：命名空间聚合 + 字段契约 + 主进程脱敏（不泄漏 secret / 本机路径）", async () => {
  const rows = [
    { id: "alpha", name: "Alpha", enabled: true, connected: true, status: "connected", tools: [
      SERVER_TOOL("echo_sum", "求和 Bearer abcdefghijklmnop 来自 /Users/secret/x.js", { inputSchemaSummary: "type=object; properties: a:number(required)" }),
    ] },
    { id: "beta", name: "Beta", enabled: true, connected: true, status: "connected", tools: [
      SERVER_TOOL("empty_schema", "无参数", { inputSchemaSummary: "" }),
      SERVER_TOOL("none_schema", "空对象", { inputSchemaSummary: "type=object; properties: none" }),
    ] },
    { id: "off", name: "Off", enabled: false, connected: false, status: "DISABLED", tools: [SERVER_TOOL("ghost")] },
  ];
  const api = createMcpAgentTools({ servers: makeServers(rows) });
  const ipcMain = fakeIpcMain();
  registerMcpIpc({
    ipcMain,
    service: { listConnections: () => ({ ok: true, items: [] }) },
    identity: { current: "s1" },
    isTrusted: () => true,
    agentTools: () => api,
    mcpServersSnapshot: () => rows,
    toolInvocationEnabled: () => false,
  });

  const res = await ipcMain.invoke("mcp:command", {}, { command: "mcp/agentTools", payload: {} });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.enabled, false, "开关关闭时 enabled 必须是 false");
  assert.equal(res.count, 3);
  assert.equal(res.connectedServers, 2, "只有 enabled+connected 的 server 计入");
  assert.equal(res.truncated, false);
  assert.deepEqual(res.tools.map((t) => t.fname).sort(), ["mcp__alpha__echo_sum", "mcp__beta__empty_schema", "mcp__beta__none_schema"]);
  const echo = res.tools.find((t) => t.fname === "mcp__alpha__echo_sum");
  assert.equal(echo.serverId, "alpha");
  assert.equal(echo.serverName, "Alpha");
  assert.equal(echo.toolName, "echo_sum");
  assert.equal(echo.status, "connected");
  assert.equal(echo.riskClass, "EXTERNAL_SIDE_EFFECT");
  assert.equal(echo.requiresApproval, true);
  // 脱敏：secret 形态与本机路径都不出主进程
  assert.equal(JSON.stringify(res).includes("abcdefghijklmnop"), false, "不得泄漏 Bearer token");
  assert.equal(JSON.stringify(res).includes("/Users/secret"), false, "不得泄漏本机绝对路径");
  // 参数摘要三种情况照实
  assert.equal(echo.paramText, "type=object; properties: a:number(required)");
  assert.equal(res.tools.find((t) => t.toolName === "empty_schema").paramText, "未返回参数摘要（服务端未提供 inputSchema）");
  assert.equal(res.tools.find((t) => t.toolName === "none_schema").paramText, "type=object; properties: none（参数为空对象）");

  // 过滤：serverId / search
  const one = await ipcMain.invoke("mcp:command", {}, { command: "mcp/agentTools", payload: { serverId: "beta" } });
  assert.deepEqual(one.tools.map((t) => t.toolName).sort(), ["empty_schema", "none_schema"]);
});

test("mcp/agentTools：未注入 agent-tools 端口 → 结构化 MCP_TOOL_DISCOVERY_FAILED；调用命令仍被拒", async () => {
  const ipcMain = fakeIpcMain();
  registerMcpIpc({ ipcMain, service: { listConnections: () => ({ ok: true, items: [] }) }, identity: { current: "s1" }, isTrusted: () => true });
  const res = await ipcMain.invoke("mcp:command", {}, { command: "mcp/agentTools", payload: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, "MCP_TOOL_DISCOVERY_FAILED");
  assert.deepEqual(res.tools, []);
  // 聚合命令不是调用入口；调用命令仍回既有产品边界码
  assert.equal(MCP_COMMANDS.includes("mcp/agentTools"), true);
  const invoke = await ipcMain.invoke("mcp:command", {}, { command: "mcp/callTool", payload: {} });
  assert.equal(invoke.error, "MCP_TOOL_INVOCATION_NOT_ENABLED");
});

test("mcp/agentTools：search=true 走 searchAgentTools，只回搜索/浏览类工具", async () => {
  const rows = [{ id: "alpha", name: "Alpha", enabled: true, connected: true, status: "connected", tools: [
    SERVER_TOOL("echo_sum", "求和"), SERVER_TOOL("web_search", "联网搜索"), SERVER_TOOL("read_file", "读取文件"),
  ] }];
  const api = createMcpAgentTools({ servers: makeServers(rows) });
  const ipcMain = fakeIpcMain();
  registerMcpIpc({ ipcMain, service: { listConnections: () => ({ ok: true, items: [] }) }, identity: { current: "s1" }, isTrusted: () => true, agentTools: () => api, mcpServersSnapshot: () => rows });
  const res = await ipcMain.invoke("mcp:command", {}, { command: "mcp/agentTools", payload: { search: true } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.tools.map((t) => t.toolName), ["web_search"]);
});

// ── ② ToolRegistry contract：EXTERNAL_SIDE_EFFECT + 强制审批 ─────────────
test("MCP 工具合同：risk=EXTERNAL_SIDE_EFFECT 由 Registry 推导 sideEffect/requiresApproval，幂等登记", () => {
  const registry = new ToolRegistry();
  const descriptors = [
    { serverId: "2fa server", serverName: "双因子", toolName: "read.file", description: "读文件", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  ];
  const first = registerMcpToolContracts(registry, descriptors);
  assert.equal(first.ok, true, JSON.stringify(first));
  const id = mcpToolIdFor("2fa server", "read.file");
  assert.equal(id, "mcp.s2fa.server.read.file", "toolId 段只允许 [a-z][a-z0-9]*：下划线要切段、数字开头补 s");
  assert.deepEqual(first.registered, [id]);
  const contract = registry.get(id, 1);
  assert.equal(contract.riskClass, "EXTERNAL_SIDE_EFFECT");
  assert.equal(contract.sideEffect, "EXTERNAL", "由 risk 推导，不手写");
  assert.equal(contract.requiresApproval, true, "外部副作用必须审批");
  assert.equal(contract.executionProvider, "McpExternal");
  assert.equal(contract.inputSchema.type, "object");

  const second = registerMcpToolContracts(registry, descriptors);
  assert.deepEqual(second.registered, []);
  assert.deepEqual(second.skipped, [id]);

  // 无 schema 时不伪造参数：落到空 object schema
  const empty = buildMcpToolContract({ serverId: "a", toolName: "b" });
  assert.deepEqual(empty.inputSchema, { type: "object", additionalProperties: true, properties: {} });
  // 未注入 Registry → 结构化不可用
  assert.equal(registerMcpToolContracts(null, descriptors).error, "MCP_REGISTRY_UNAVAILABLE");
});

// ── ③ 显式开关：默认关闭、持久化、读坏 fail closed ─────────────────────
test("mcp-switch：默认 false；写入 <userData>/dxos/mcp.json；保留未知键；缺 userDataDir 不可持久化", () => {
  assert.deepEqual(defaultState(), { version: 1, tools: { invocationEnabled: false } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-mcp-switch-"));
  try {
    const sw = createMcpSwitch({ userDataDir: dir });
    assert.equal(sw.isToolInvocationEnabled(), false, "文件不存在 = 默认关闭");
    assert.deepEqual(sw.snapshot(), { enabled: false, version: 1 });
    const set = sw.setToolInvocationEnabled(true);
    assert.equal(set.ok, true);
    assert.equal(set.enabled, true);
    assert.equal(path.basename(sw.filePath), "mcp.json");
    assert.equal(sw.filePath.startsWith(path.join(dir, "dxos")), true, "路径由 dxos-foundation-paths 解析");
    const raw = JSON.parse(fs.readFileSync(sw.filePath, "utf8"));
    assert.equal(raw.tools.invocationEnabled, true);

    // 未知顶层键与 tools 下未知键原样保留
    fs.writeFileSync(sw.filePath, JSON.stringify({ version: 1, keep: "x", tools: { invocationEnabled: false, other: 7 } }));
    const sw2 = createMcpSwitch({ userDataDir: dir });
    assert.equal(sw2.isToolInvocationEnabled(), false);
    sw2.setToolInvocationEnabled(true);
    const raw2 = JSON.parse(fs.readFileSync(sw2.filePath, "utf8"));
    assert.equal(raw2.keep, "x");
    assert.equal(raw2.tools.other, 7);

    // 读坏（非 JSON）不崩、不打开
    fs.writeFileSync(sw.filePath, "{ 坏 JSON");
    assert.equal(createMcpSwitch({ userDataDir: dir }).isToolInvocationEnabled(), false);
    // 旧版数组形状不静默覆盖
    fs.writeFileSync(sw.filePath, JSON.stringify([{ id: "legacy" }]));
    const sw3 = createMcpSwitch({ userDataDir: dir });
    assert.equal(sw3.isToolInvocationEnabled(), false);
    assert.deepEqual(sw3.readState().legacy, [{ id: "legacy" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const none = createMcpSwitch({});
  assert.equal(none.isToolInvocationEnabled(), false);
  const failed = none.setToolInvocationEnabled(true);
  assert.equal(failed.ok, false);
  assert.equal(failed.persisted, false);
});

// ── ④ 开关门：关闭不传输；打开但未审批也不传输 ──────────────────────────
test("开关关闭：callByName/callDirect 回 MCP_TOOL_INVOCATION_NOT_ENABLED，0 次审批、0 次传输", async () => {
  const servers = makeServers([{ id: "alpha", name: "Alpha", status: "connected", tools: [{ name: "echo_sum" }] }]);
  const transport = makeTransport();
  const gate = makeGate({ decisionStatus: "ALLOWED" });
  const api = createMcpAgentTools({ servers, transport, approval: gate, switch: { isEnabled: () => false } });
  assert.equal(api.toolInvocationEnabled(), false);

  const byName = await api.callByName("mcp__alpha__echo_sum", { a: 1 });
  assert.equal(byName.ok, false);
  assert.equal(byName.error, MCP_AGENT_ERROR.MCP_TOOL_INVOCATION_NOT_ENABLED);
  const direct = await api.callDirect("alpha", "echo_sum", {});
  assert.equal(direct.error, MCP_AGENT_ERROR.MCP_TOOL_INVOCATION_NOT_ENABLED);
  assert.equal(gate.calls.length, 0, "开关关闭时连审批都不该跑");
  assert.equal(transport.calls.length, 0, "开关关闭时绝不传输");
});

test("开关打开：未审批 → APPROVAL_REQUIRED；审批拒绝 → APPROVAL_DENIED；均 0 次传输", async () => {
  const servers = makeServers([{ id: "alpha", name: "Alpha", status: "connected", tools: [{ name: "echo_sum" }] }]);
  const on = { isEnabled: () => true };

  const pendingTransport = makeTransport();
  const pending = createMcpAgentTools({ servers, transport: pendingTransport, approval: makeGate({ decisionStatus: "APPROVAL_REQUIRED", approvalRequestId: "appr-1" }), switch: on });
  const pendingRes = await pending.callByName("mcp__alpha__echo_sum", {});
  assert.equal(pendingRes.error, "APPROVAL_REQUIRED");
  assert.equal(pendingRes.approvalRequestId, "appr-1");
  assert.equal(pendingTransport.calls.length, 0);

  const deniedTransport = makeTransport();
  const denied = createMcpAgentTools({ servers, transport: deniedTransport, approval: makeGate({ decisionStatus: "DENIED", reasonCode: "TOOL_FORBIDDEN" }), switch: on });
  const deniedRes = await denied.callByName("mcp__alpha__echo_sum", {});
  assert.equal(deniedRes.error, "APPROVAL_DENIED");
  assert.equal(deniedRes.reasonCode, "TOOL_FORBIDDEN");
  assert.equal(deniedTransport.calls.length, 0);
});

test("开关打开 + 审批通过：走注入的 transport 并回结果", async () => {
  const servers = makeServers([{ id: "alpha", name: "Alpha", status: "connected", tools: [{ name: "echo_sum" }] }]);
  const transport = makeTransport(async (req) => TEXT_OK(JSON.stringify(req.arguments)));
  const gate = makeGate({ decisionStatus: "ALLOWED" });
  const api = createMcpAgentTools({ servers, transport, approval: gate, switch: { isEnabled: () => true } });
  assert.equal(api.toolInvocationEnabled(), true);
  const res = await api.callDirect("alpha", "echo_sum", { a: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.text, JSON.stringify({ a: 1 }));
  assert.equal(gate.calls.length, 1);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].toolName, "echo_sum");
});

test("未注入 switch 端口：保持 B4d 既有组合语义（审批 → 注入传输），toolInvocationEnabled() 返回 null", async () => {
  const servers = makeServers([{ id: "alpha", name: "Alpha", status: "connected", tools: [{ name: "echo_sum" }] }]);
  const transport = makeTransport(async () => TEXT_OK("legacy"));
  const api = createMcpAgentTools({ servers, transport, approval: makeGate({ decisionStatus: "ALLOWED" }) });
  assert.equal(api.toolInvocationEnabled(), null);
  const res = await api.callByName("mcp__alpha__echo_sum", {});
  assert.equal(res.ok, true);
  assert.equal(transport.calls.length, 1);
});

// ── ⑤ 生产装配桥：switch + registry + 既有审批适配器 ─────────────────────
test("bridge：开关关闭 0 传输；注入 registry 后合同落地；proxy+taskId 自动接既有 ControlledToolProxy 适配器", async () => {
  const CONNECTED = { connectionId: "mcp_echo", name: "回显服务", serverName: "echo", enabled: true, status: "READY", tools: [{ name: "echo_sum", description: "求和", inputSchemaSummary: "type=object; properties: a:number" }], toolsHidden: false };
  const mcpService = { listConnections: () => ({ ok: true, items: [CONNECTED] }) };
  const registry = new ToolRegistry();

  const offTransport = makeTransport();
  const off = createMcpAgentBridge({ mcpService, switch: { isEnabled: () => false }, transport: offTransport, registry });
  off.mcpServersSnapshot();
  const expectedId = mcpToolIdFor("mcp_echo", "echo_sum");
  assert.ok(off.listToolContracts().includes(expectedId), "快照时应把已连接工具登记进 Registry");
  assert.equal(registry.get(expectedId, 1).riskClass, "EXTERNAL_SIDE_EFFECT");
  const offRes = await off.mcpAgentTools.callByName("mcp__mcp_echo__echo_sum", { a: 1 });
  assert.equal(offRes.error, "MCP_TOOL_INVOCATION_NOT_ENABLED");
  assert.equal(offTransport.calls.length, 0);

  // 开关打开 + ControlledToolProxy 返回 APPROVAL_REQUIRED：0 传输，approvalPort 类型如实
  const seen = [];
  const proxy = { propose(req) { seen.push(req); return { ok: true, decisionStatus: "APPROVAL_REQUIRED", reasonCode: "TOOL_APPROVAL_REQUIRED", proposal: { proposalId: "p1" } }; } };
  const pendingTransport = makeTransport();
  const pending = createMcpAgentBridge({ mcpService, switch: { isEnabled: () => true }, transport: pendingTransport, registry, proxy, taskId: "task_1" });
  assert.equal(pending.approvalPortKind, "controlled-tool-proxy");
  const pendingRes = await pending.mcpAgentTools.callByName("mcp__mcp_echo__echo_sum", { a: 1 });
  assert.equal(pendingRes.error, "APPROVAL_REQUIRED");
  assert.equal(pendingRes.approvalRequestId, "p1");
  assert.equal(pendingTransport.calls.length, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toolId, expectedId, "审批链必须拿到已登记的 toolId");

  // 开关打开 + 审批通过：注入的 transport 收到调用
  const okTransport = makeTransport(async () => TEXT_OK("done"));
  const ok = createMcpAgentBridge({ mcpService, switch: { isEnabled: () => true }, transport: okTransport, registry, approval: { authorize: async () => ({ decisionStatus: "ALLOWED" }) } });
  const okRes = await ok.mcpAgentTools.callByName("mcp__mcp_echo__echo_sum", { a: 1 });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.text, "done");
  assert.equal(okTransport.calls.length, 1);
});

test("paramSummaryText：三种情况与 UI-2 旧派生逐字一致", () => {
  assert.equal(paramSummaryText(undefined), "未返回参数摘要（服务端未提供 inputSchema）");
  assert.equal(paramSummaryText("  "), "未返回参数摘要（服务端未提供 inputSchema）");
  assert.equal(paramSummaryText("type=object; properties: none"), "type=object; properties: none（参数为空对象）");
  assert.equal(paramSummaryText("type=object; properties: a:number"), "type=object; properties: a:number");
});
