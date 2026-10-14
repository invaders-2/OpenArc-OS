/**
 * B4 收口 · 项目级 Agent 模式（agent/project/run）IPC 集成测试（全离线）。
 *
 * 覆盖父任务第 2 条：
 *   ① agent/project/run 经 agent:command 白名单 → agent-service 分发 → runProjectAgentMode
 *      真实跑完一轮"能力发现 → 工具执行 → 结果回填 → 完成验收"，并回填 Agent Run 事件；
 *   ② 未注入适配器时结构化 AGENT_DEPENDENCY_UNAVAILABLE（不伪造成功）；
 *   ③ 返回值脱敏（无绝对路径 / 密钥）；
 *   ④ 命令表 risk=use / credential=true（详细断言见 tests/dxos-agent-ipc.test.mjs）。
 *
 * 适配器全部注入假实现（agentRuntime / usage / capability / toolRunner / providerAdapter），
 * 只保留真实的 fallback 与 toolLoop —— 它们无外部依赖，能验证"真的一轮循环"而不是桩打桩。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const agentDomain = require("../electron/agent-domain.cjs");
const { createAgentBundle } = require("../electron/agent-service.cjs");
const { registerAgentIpc } = require("../electron/agent-bootstrap.cjs");
const toolLoop = require("../electron/agent-runtime-tool-loop.cjs");
const fallback = require("../electron/agent-runtime-fallback.cjs");

const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

const REVIEW_JSON = '{"complete":true,"reason":"账本与原始目标一致","missingActions":[]}';

function capTool(name, intent, domain) {
  return {
    type: "function",
    function: { name, description: name + " 工具说明", parameters: { type: "object", properties: {} } },
    x_dx_capability: { schema: "dx-agent-capability/v1", id: "cap:" + name, domain, intents: [intent] },
  };
}
const TOOLS = [capTool("fs_list", "file.read", "file-system"), capTool("fs_read", "file.read", "file-system")];
const DESCRIPTORS = [
  { name: "fs_list", source: "file", risk: "read" },
  { name: "fs_read", source: "file", risk: "read" },
];

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { if (handlers.has(channel)) throw new Error("重复注册 handler：" + channel); handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, event, raw) { return handlers.get(channel)(event, raw); },
  };
}

let runSeq = 0;
/** 装配测试台：真实 SQLite（临时库）+ 假 authorization + 假项目 Agent 适配器。 */
function setup({ projectAgent = undefined, planCalls = null, tools = TOOLS, descriptors = DESCRIPTORS, bundleExtras = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-b4-project-run-"));
  dirs.push(dir);
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  let tick = 1_700_000_000_000;
  const clock = () => { tick += 1; return tick; };
  const authorization = { resolveActor: () => ({ ok: true, user: { id: "u1", role: "ADMIN", team_id: "org1" }, organizationId: "org1" }) };
  const authStore = { appGrantsForApp: () => [{ appId: "ai", actions: ["files.read", "files.write"] }] };

  runSeq += 1;
  const runId = "run-" + runSeq;
  const events = [];
  const usageEvents = [];
  const toolCalls = [];
  const prepared = {
    trace: { runId, steps: [], note: "/Users/wepingli/secret.txt" },
    systemPromptAdditions: ["附加系统提示"],
    route: {
      model: { providerId: "p1", model: "m-primary", provider: { id: "p1", name: "主站点" } },
      modelRoutes: [{ providerId: "p1", model: "m-primary", provider: { id: "p1", name: "主站点" } }],
      tools,
      toolDescriptors: descriptors,
    },
  };
  const runtime = { runId, signal: new AbortController().signal, prepared };

  const agentRuntime = {
    normalizeEnvelope: (raw, actor) => ({ ...raw, actorId: actor.id }),
    prepare: () => runtime,
    create: () => runtime,
    start: (id) => events.push(["start", id]),
    append: (id, type, data) => events.push([type, data]),
    complete: (id, result) => events.push(["complete", result]),
    fail: (id, error) => events.push(["fail", String((error && error.message) || error)]),
    cancel: (id) => events.push(["cancel", id]),
  };
  const usage = {
    beginAgentUsage: (input) => { const id = "u" + (usageEvents.length + 1); usageEvents.push({ id, input, finished: null }); return { id, startedAt: 1000 }; },
    finishAgentUsage: (id, input) => { const record = usageEvents.find((item) => item.id === id); if (record) record.finished = input; return { id, status: input.status }; },
  };
  const capability = {
    discoverCapabilityTargetsForUser: async (userId, intents) => {
      const targets = {};
      for (const intent of intents) targets[intent] = [{ providerName: "本地", model: "m-fast", operationId: "op-" + intent }];
      return targets;
    },
    normalizeCapabilityReferences: (value) => (value && typeof value === "object" ? value : {}),
    normalizeCapabilityRequirements: (value) => (value && typeof value === "object" ? value : {}),
    selectedCapabilityTargets: (targets) => Object.entries(targets).flatMap(([intent, candidates]) => (candidates[0] ? [{ intent, ...candidates[0] }] : [])),
  };
  const toolRunner = {
    runTool: (name, ctx, args) => {
      toolCalls.push({ name, ctx, args });
      if (name === "fs_list") return { entries: [{ name: "a.txt", type: "file" }] };
      if (name === "fs_read") return { nodeId: "n1", name: "a.txt", content: "hello" };
      throw new Error("未知文件工具：" + name);
    },
  };
  const plan = planCalls || [
    { content: "", toolCalls: [{ id: "c1", name: "fs_read", arguments: JSON.stringify({ path: "a.txt" }) }] },
    { content: "已读取 a.txt", toolCalls: [] },
  ];
  const requests = [];
  let planIndex = 0;
  const providerAdapter = {
    autoFallback: () => false,
    chatWithTools: async (request) => {
      requests.push(request);
      if (!request.tools || request.tools.length === 0) return { content: REVIEW_JSON };
      const response = plan[planIndex] || { content: "已完成", toolCalls: [] };
      planIndex += 1;
      return response;
    },
  };

  const bundle = createAgentBundle({
    identityStore: store, authorization, authStore, modelService: null,
    userDataDir: dir, clock, dbPath: path.join(dir, "identity.db"),
    projectAgent: projectAgent === undefined
      ? { agentRuntime, usage, capability, toolRunner, providerAdapter }
      : projectAgent,
    ...bundleExtras,
  });
  const ipcMain = fakeIpcMain();
  const agentEvents = [];
  registerAgentIpc({ ipcMain, bundle, isTrusted: (event) => !!event && event.sender === "shell", identity: { current: "session-1" }, send: (event) => agentEvents.push(event) });
  const okEvent = { sender: "shell", senderFrame: { url: "file:///app/dist/index.html" } };
  const call = (command, payload) => ipcMain.invoke("agent:command", okEvent, { command, payload });
  return {
    dir, store, bundle, events, usageEvents, toolCalls, requests, agentEvents, call,
    close: () => { try { store.close(); } catch { /* 已关闭 */ } },
  };
}

async function makeProject(s) {
  const created = await s.call("agent/project/create", { name: "项目模式项目", rootNodeId: "root-run" });
  assert.equal(created.ok, true);
  return created.value.project.id;
}

function findEvent(events, name) { return events.find((event) => event[0] === name); }

// ---------------------------------------------------------------------------
// ① 一轮真实循环 + 事件回填
// ---------------------------------------------------------------------------

test("agent/project/run：经 agent:command 白名单跑完一轮（能力发现→fs_read→回填→完成验收）", async () => {
  const s = setup();
  const projectId = await makeProject(s);
  const res = await s.call("agent/project/run", { projectId, instruction: "读取 a.txt" });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.projectId, projectId);
  assert.equal(res.value.outcome.complete, true);
  assert.equal(res.value.outcome.text, "已读取 a.txt");
  assert.equal(res.value.outcome.filesChanged, false, "fs_read 是只读工具，不得标记文件变更");

  // 真的到了 project-agent-mode：初始 fs_list + 循环内 fs_read 都经注入的 toolRunner。
  assert.deepEqual(s.toolCalls.map((item) => item.name), ["fs_list", "fs_read"]);
  assert.equal(s.toolCalls[0].ctx.rootNodeId, "root-run");
  assert.equal(s.toolCalls[0].ctx.userId, "u1");

  // 事件回填：能力开始/完成 + 完成验收 + Run complete。
  assert.ok(s.events.some((event) => event[0] === "capability.started" && event[1].toolName === "fs_read"), "缺 capability.started");
  assert.ok(s.events.some((event) => event[0] === "capability.completed" && event[1].toolName === "fs_read"), "缺 capability.completed");
  assert.ok(s.events.some((event) => event[0] === "capability.completed" && event[1].toolName === "capability_discover"), "缺能力发现完成事件");
  const review = findEvent(s.events, "planned");
  assert.ok(review && review[1].phase === "completion-review" && review[1].complete === true, "缺完成验收事件");
  assert.ok(findEvent(s.events, "start") && findEvent(s.events, "complete"), "Run 生命周期事件缺失");

  // 工具 observation 回填给模型（第二次计划调用的 messages 里有 tool 消息，内容含真实读取结果）。
  const planning = s.requests.filter((request) => request.tools && request.tools.length);
  assert.equal(planning.length, 2, "应有两次计划调用（首次调用工具 + 回填后再规划）");
  const backfilled = planning[1].messages.find((message) => message.role === "tool" && message.tool_call_id === "c1");
  assert.ok(backfilled, "工具结果必须作为 tool 消息回填");
  assert.match(backfilled.content, /hello/);

  // 用量账目：model 与 tool 两类都记账。
  assert.ok(s.usageEvents.some((item) => item.input.kind === "model"));
  assert.ok(s.usageEvents.some((item) => item.input.kind === "tool" && item.input.toolName === "fs_read"));
  assert.equal(s.usageEvents.filter((item) => item.input.toolName === "fs_read").length, 1);

  // 脱敏：agentTrace 里塞的绝对路径被替换，返回值不含 /Users/。
  const payload = JSON.stringify(res.value);
  assert.equal(payload.includes("/Users/"), false, "返回值带出了绝对路径");
  assert.match(payload, /<path>/);
  assert.equal(payload.includes("secret.txt"), false);

  s.close();
});

test("agent/project/run：mcp 工具经注入的 mcpAgentTools.callByName 路由（不直连 mcp-client）", async () => {
  const mcpCalls = [];
  const MCP_TOOLS = [capTool("fs_list", "file.read", "file-system"), capTool("mcp__search", "mcp.search", "mcp")];
  const MCP_DESCRIPTORS = [
    { name: "fs_list", source: "file", risk: "read" },
    { name: "mcp__search", source: "mcp", sourceId: "srv-1", risk: "read" },
  ];
  const s = setup({
    tools: MCP_TOOLS,
    descriptors: MCP_DESCRIPTORS,
    planCalls: [
      { content: "", toolCalls: [{ id: "d1", name: "capability_discover", arguments: JSON.stringify({ intents: ["mcp.search"] }) }] },
      { content: "", toolCalls: [{ id: "m1", name: "mcp__search", arguments: JSON.stringify({ q: "x" }) }] },
      { content: "搜索完成", toolCalls: [] },
    ],
    bundleExtras: { mcpAgentTools: { callByName: async (name, args) => { mcpCalls.push({ name, args }); return { ok: true, text: "结果" }; } } },
  });
  const projectId = await makeProject(s);
  const res = await s.call("agent/project/run", { projectId, instruction: "搜索一下" });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.outcome.complete, true);
  assert.equal(res.value.outcome.text, "搜索完成");
  // descriptor.source === "mcp" 走注入的 mcpAgentTools.callByName（不是 mcp-client 直连）。
  assert.deepEqual(mcpCalls, [{ name: "mcp__search", args: { q: "x" } }]);
  assert.ok(s.events.some((event) => event[0] === "capability.started" && event[1].toolName === "mcp__search"));
  assert.ok(s.events.some((event) => event[0] === "capability.completed" && event[1].toolName === "mcp__search"));
  s.close();
});

// ---------------------------------------------------------------------------
// ② 未注入适配器 → 结构化 AGENT_DEPENDENCY_UNAVAILABLE
// ---------------------------------------------------------------------------

test("agent/project/run：显式置空 fallback 时结构化拒绝，且不产生工具调用", async () => {
  const s = setup({ projectAgent: { fallback: null } });
  const projectId = await makeProject(s);
  const res = await s.call("agent/project/run", { projectId, instruction: "读取 a.txt" });

  assert.equal(res.ok, false);
  assert.equal(res.error, agentDomain.AGENT_ERR_DEPENDENCY_UNAVAILABLE);
  assert.equal(res.detail.dependency, "fallback.runWithAgentModelFallback");
  assert.equal(s.toolCalls.length, 0, "依赖缺失必须在任何工具调用之前失败");
  assert.equal(s.events.length, 0);
  s.close();
});

test("agent/project/run：真实默认适配器下 providerAdapter 未装配 → 结构化 providerAdapter 缺失", async () => {
  // 不传 projectAgent：agentRuntime/usage/fallback/toolLoop/capability 用真实模块，
  // providerAdapter 由项目 bundle 的 providerAdapter 参数决定 —— 这里为 null → 依赖不可用。
  const s = setup({ projectAgent: null });
  const projectId = await makeProject(s);
  const res = await s.call("agent/project/run", { projectId, instruction: "读取 a.txt" });

  assert.equal(res.ok, false);
  assert.equal(res.error, agentDomain.AGENT_ERR_DEPENDENCY_UNAVAILABLE);
  assert.equal(res.detail.dependency, "providerAdapter");
  s.close();
});

// ---------------------------------------------------------------------------
// ③ 入参校验与命令表
// ---------------------------------------------------------------------------

test("agent/project/run：projectId / instruction 必填；未知项目给 AGENT_NOT_FOUND", async () => {
  const s = setup();
  const missing = await s.call("agent/project/run", { projectId: "", instruction: "" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, agentDomain.AGENT_ERR_INVALID_INPUT);

  const notFound = await s.call("agent/project/run", { projectId: "proj-not-exist", instruction: "读取" });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.error, agentDomain.AGENT_ERR_NOT_FOUND);
  s.close();
});

test("命令表：agent/project/run 的 risk=use、credential=true、摘要为中文", () => {
  assert.equal(agentDomain.agentCommandRisk("agent/project/run"), "use");
  assert.equal(agentDomain.agentCommandRequiresCredential("agent/project/run"), true);
  assert.match(agentDomain.AGENT_COMMANDS["agent/project/run"].summary, /[\u4e00-\u9fa5]/);
});
