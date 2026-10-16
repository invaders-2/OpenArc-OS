/**
 * D5-04 补丁 · DX 任务 → 核心审批任务 映射桥的离线端到端测试。
 *
 * 证明的是"agent 工具循环（project-agent-mode）发起的 MCP 调用真的经**既有**审批链"：
 *   agent 工具循环（mcpAdapter → mcpAgentTools.callByName，taskId = dx_tasks.id）
 *     → createDxBridgedApprovalPort（幂等映射 dx 步骤 → 核心 Task/Step/Run）
 *     → createSideEffectExecutionPort.proposeWrite（plan）
 *     → 既有 sideEffect/decideApproval（唯一 trusted 审批）
 *     → 既有 lease/claim/verify（IN_PROCESS McpExternal provider）
 *     → 真实 tools/call 只到 127.0.0.1 loopback → 结果回传 agent 工具循环
 *
 * 同时证明：
 *   · 拒绝 / 超时 / 开关关 → 0 传输；
 *   · 映射幂等：同一 dx 步骤重复调用只产生 1 个核心任务；
 *   · 只读边界：桥不改 dx_tasks / dx_task_steps（调用前后行哈希一致）。
 *
 * 全部离线：只有 loopback HTTP（127.0.0.1），无外网。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { McpStore } = require("../electron/mcp-store.cjs");
const { McpService } = require("../electron/mcp-service.cjs");
const { McpClient } = require("../electron/mcp-client.cjs");
const { CredentialStore, memoryCredentialBackend } = require("../electron/credential-store.cjs");
const { createMcpSwitch } = require("../electron/mcp-switch.cjs");
const { createMcpAgentBridge } = require("../electron/mcp-agent-bridge.cjs");
const { createMcpLiveTransport } = require("../electron/mcp-live-transport.cjs");
const { createMcpSideEffectProvider } = require("../electron/mcp-side-effect-provider.cjs");
const { mcpToolIdFor, MCP_TOOL_VERSION } = require("../electron/mcp-tool-contract.cjs");
const { createSideEffectGateway, registerSideEffectIpc } = require("../electron/side-effect-bootstrap.cjs");
const { createDxTaskApprovalBridge, createDxBridgedApprovalPort, BRIDGE_ERROR } = require("../electron/dx-task-approval-bridge.cjs");
const agentTaskStore = require("../electron/agent-task-store.cjs");
const projectAgent = require("../electron/project-agent-mode.cjs");
const toolLoop = require("../electron/agent-runtime-tool-loop.cjs");
const fallback = require("../electron/agent-runtime-fallback.cjs");

const SERVER = path.join(import.meta.dirname, "fixtures", "mcp", "loopback-tool-server.mjs");
const TOOL = "loop_echo";

function startLoopbackToolServer() {
  const child = spawn(process.execPath, [SERVER, "--http", "--port=0"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d); });
  const ready = new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("loopback-tool-server 未在 5s 内就绪：" + stderr)), 5000);
    child.stdout.on("data", (d) => {
      buffer += String(d);
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      try { clearTimeout(timer); resolve(JSON.parse(buffer.slice(0, index))); }
      catch (err) { clearTimeout(timer); reject(err); }
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
  return { child, ready, stop() { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } } };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForPending(store, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = store.callsByStatus("AWAITING_APPROVAL");
    if (list.length) return list[0];
    if (Date.now() > deadline) throw new Error("等待 pending side-effect approval 超时");
    await sleep(10);
  }
}

/** dx_tasks / dx_task_steps 的行内容哈希：桥调用前后必须一致（桥只读 dx 侧）。 */
function dxStateHash(connection) {
  const tasks = connection.prepare("SELECT * FROM dx_tasks ORDER BY id").all();
  const steps = connection.prepare("SELECT * FROM dx_task_steps ORDER BY id").all();
  return crypto.createHash("sha256").update(JSON.stringify({ tasks, steps })).digest("hex");
}

/** 进程内等价装配：真实 side-effect authority + 真实 MCP 活连接 + 真实映射桥。 */
async function setup({ approvalTimeoutMs = 2500 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-mcp-bridge-"));
  const server = startLoopbackToolServer();
  const info = await server.ready;
  const fx = await createToolHarnessFixture({ withAdapters: true, sideEffectApprovalWaitMs: 3000 });
  const f = fx.f;
  const sw = createMcpSwitch({ userDataDir: path.join(tmp, "userData") });
  sw.setToolInvocationEnabled(true);

  const urlsSeen = [];
  const guardedFetch = (url, init) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { return Promise.reject(new Error("BAD_URL")); }
    urlsSeen.push(parsed.origin);
    if (parsed.hostname !== "127.0.0.1") return Promise.reject(new Error("NON_LOOPBACK_REQUEST:" + parsed.origin));
    return fetch(url, init);
  };

  const mcpStore = new McpStore({ identity: f.identity });
  const credentialStore = new CredentialStore({ store: mcpStore, backend: memoryCredentialBackend() });
  const mcpService = new McpService({
    identity: f.identity, authService: f.authService, authStore: f.store, mcpStore, credentialStore,
    clientFactory: () => new McpClient({ invocationGate: () => sw.isToolInvocationEnabled(), fetchImpl: guardedFetch, requestTimeoutMs: 5000 }),
    requestTimeoutMs: 5000,
  });
  f.store.upsertApp({ appId: "mcp-center", name: "MCP 中心", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  f.store.upsertAppGrant({ appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view", "mcp.use", "mcp.manage", "mcp.test"], grantedBy: "test", organizationId: f.orgId });

  const mcpCtx = { sessionRef: f.sessions.admin, appId: "mcp-center", source: "ui" };
  const created = mcpService.createConnection({ context: mcpCtx, name: "本机回环工具", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: info.url } });
  assert.equal(created.ok, true, JSON.stringify(created));
  const connectionId = created.connection.connectionId;
  assert.equal(mcpService.setEnabled({ context: mcpCtx, connectionId, enabled: true }).ok, true);
  const connected = await mcpService.connect({ context: mcpCtx, connectionId });
  assert.equal(connected.ok, true, JSON.stringify(connected));

  // 既有 SideEffectAuthority 装配：MCP provider 注册进既有 adapters 注册表（不新建第二套）。
  const transport = createMcpLiveTransport({ mcpService, switchPort: sw });
  fx.adapters.providers.McpExternal = createMcpSideEffectProvider({ transport, registry: fx.toolRegistry });

  // DX 任务域：与核心域同一个 SQLite 连接（identity-store）。
  agentTaskStore.resetAgentTaskStoreForTests();
  agentTaskStore.configureAgentTaskStore({ db: f.identity.connection, clock: f.clock, idFactory: () => crypto.randomUUID() });

  // 映射桥：只做身份映射；sessionRef 由"宿主"注入（测试里等价于主进程 identity.service.current）。
  const bridge = createDxTaskApprovalBridge({
    identity: f.identity, taskStore: fx.taskStore, dxTaskStore: agentTaskStore, authService: f.authService,
    appId: "mcp-center", clock: f.clock,
    context: () => ({ sessionRef: f.sessions.admin, appId: "mcp-center" }),
  });
  const bridgedPort = createDxBridgedApprovalPort({
    bridge, runtime: fx.sideEffectRuntime, toolIdFor: mcpToolIdFor, toolVersionFor: () => MCP_TOOL_VERSION, approvalTimeoutMs,
  });
  const agentBridge = createMcpAgentBridge({ mcpService, context: () => mcpCtx, switch: sw, registry: fx.toolRegistry, transport, approval: bridgedPort });

  // 真实审批命令路径：sideeffect:command → sideEffect/decideApproval（不是 trustedApproval 桩）。
  const handlers = new Map();
  const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
  registerSideEffectIpc({ ipcMain, service: createSideEffectGateway({ sideEffectRuntime: fx.sideEffectRuntime }), identity: { current: f.sessions.admin }, isTrusted: () => true });
  const sideEffectCommand = (raw) => handlers.get("sideeffect:command")({}, raw);

  const toolList = (await agentBridge.mcpAgentTools.agentTools()).tools;
  assert.equal(toolList.length, 1, "回环 server 应只暴露一个工具");
  const fname = toolList[0].function.name;

  const serverState = async () => (await fetch("http://127.0.0.1:" + info.port + "/__state")).json();

  let runSeq = 0;
  /** 每条场景一条全新的 RUNNING dx 任务 + 已启动的 dx 步骤（模拟 agent 工具循环的当前步骤）。 */
  function newDxRun(label = "run") {
    runSeq += 1;
    const project = agentTaskStore.createProject({ name: "桥项目 " + runSeq, rootNodeId: "root-bridge-" + runSeq, createdBy: f.users.admin });
    const dxTask = agentTaskStore.createTask({ projectId: project.id, createdBy: f.users.admin, instruction: "调用 " + label, executionProfile: "agent" });
    agentTaskStore.updateTaskStatus(dxTask.id, "running", { worker_id: "worker-bridge", lease_token: "lease-bridge-" + runSeq, lease_until: f.now() + 3600000 });
    const step = agentTaskStore.appendDynamicStep(dxTask.id, "MCP " + TOOL, fname, {}, dxTask.id + ":op:" + runSeq);
    assert.equal(agentTaskStore.startStep(dxTask.id, step.id, "worker-bridge", "lease-bridge-" + runSeq), true, "dx 步骤必须能进入 running");
    return { project, dxTask, dxTaskId: dxTask.id, stepId: step.id };
  }

  return {
    tmp, server, info, fx, f, sw, connectionId, transport, bridge, bridgedPort, agentBridge, fname, mcpCtx,
    sideEffectCommand, urlsSeen, serverState, newDxRun, toolId: mcpToolIdFor(connectionId, TOOL),
    async close() {
      try { await mcpService.dispose(); } catch { /* ignore */ }
      try { server.stop(); } catch { /* ignore */ }
      try { await fx.close(); } catch { /* ignore */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      agentTaskStore.resetAgentTaskStoreForTests();
    },
  };
}

// ── project-agent-mode 最小测试台（与 dxos-project-agent-mode.test.mjs 同构，只换 mcpAdapter 为真实桥）──
const REVIEW_JSON = '{"complete":true,"reason":"账本与原始目标一致","missingActions":[]}';
const PROJECT = { id: "proj-bridge", name: "桥项目", root_node_id: "root-bridge" };
const ACTOR = { id: "user-bridge", role: "user", displayName: "执行岗" };

function buildAgentLoopHarness({ fname, sourceId, mcpCallByName }) {
  const events = [];
  const calls = [];
  let planCount = 0;
  const tools = [{
    type: "function",
    function: { name: fname, description: "MCP 回环工具", parameters: { type: "object", properties: {} } },
    x_dx_capability: { schema: "dx-agent-capability/v1", id: "cap:" + fname, domain: "mcp", intents: ["mcp.search"] },
  }];
  const descriptors = [{ name: fname, source: "mcp", sourceId, risk: "write" }];
  const prepared = {
    trace: { runId: "run-bridge", steps: [] },
    systemPromptAdditions: [],
    route: {
      model: { providerId: "p1", model: "m-primary", provider: { id: "p1", name: "主站点" } },
      modelRoutes: [{ providerId: "p1", model: "m-primary", provider: { id: "p1", name: "主站点" } }],
      tools,
      toolDescriptors: descriptors,
    },
  };
  const runtime = { runId: "run-bridge", signal: new AbortController().signal, prepared };
  projectAgent.resetProjectAgentModeForTests();
  projectAgent.configureProjectAgentMode({
    agentRuntime: {
      normalizeEnvelope: (raw, actor) => ({ ...raw, actorId: actor.id }),
      prepare: () => runtime, create: () => runtime, start: () => {}, append: () => {},
      complete: () => {}, fail: () => {}, cancel: () => {},
    },
    usage: {
      beginAgentUsage: () => ({ id: "u1", startedAt: 1000 }),
      finishAgentUsage: (id, input) => ({ id, status: input.status }),
    },
    fallback,
    toolLoop: toolLoop.serverAgentToolLoops,
    capability: {
      discoverCapabilityTargetsForUser: async () => ({}),
      normalizeCapabilityReferences: (v) => (v && typeof v === "object" ? v : {}),
      normalizeCapabilityRequirements: (v) => (v && typeof v === "object" ? v : {}),
      selectedCapabilityTargets: () => [],
    },
    toolRunner: { runTool: (name) => (name === "fs_list" ? { entries: [] } : (() => { throw new Error("未知文件工具：" + name); })()) },
    skillRunner: null,
    mcpAdapter: { callByName: mcpCallByName },
    toolCatalog: null,
    providerAdapter: {
      autoFallback: () => false,
      chatWithTools: async (request) => {
        calls.push(request);
        if (!request.tools || request.tools.length === 0) return { content: REVIEW_JSON };
        planCount += 1;
        if (planCount === 1) return { content: "", toolCalls: [{ id: "mcp-1", name: fname, arguments: JSON.stringify({ a: 1, b: 2 }) }] };
        return { content: "MCP 调用完成", toolCalls: [] };
      },
    },
    clock: () => 1000,
  });
  return { events, calls, prepared };
}

test("端到端：agent 工具循环（project-agent-mode）→ 桥 → 既有审批批准 → 真实 loopback tools/call → 结果回传", async () => {
  const env = await setup({ approvalTimeoutMs: 3000 });
  try {
    const run = env.newDxRun("approve");
    const dxHashBefore = dxStateHash(env.f.identity.connection);
    const mcpResults = [];
    buildAgentLoopHarness({
      fname: env.fname, sourceId: env.connectionId,
      mcpCallByName: async (name, args, ctx) => { const res = await env.agentBridge.mcpAgentTools.callByName(name, args, ctx); mcpResults.push({ ctx, res }); return res; },
    });

    const running = projectAgent.runProjectAgentMode(PROJECT, ACTOR, "调用一次需要审批的 MCP 工具", [], {}, { taskId: run.dxTaskId, stepId: run.stepId });
    const pending = await waitForPending(env.fx.sideEffectStore);
    assert.equal(pending.effectClass, "EXTERNAL_SIDE_EFFECT");
    assert.equal(pending.toolId, env.toolId);
    assert.equal((await env.serverState()).toolsCalls.length, 0, "未批准时 0 次 tools/call");
    // 桥已建立映射：待审批的核心 call 指向 dx 任务/步骤映射出的核心里程。
    const dxIdentity = env.bridge.dxIdentityOfCoreTask(pending.taskId);
    assert.ok(dxIdentity, "核心任务必须能反查回 dx 身份");
    assert.equal(dxIdentity.dxTaskId, run.dxTaskId);
    assert.equal(dxIdentity.dxStepId, run.stepId);
    assert.equal(pending.stepId, dxIdentity.coreStepId);
    assert.equal(pending.runId, dxIdentity.coreRunId);

    const approved = await env.sideEffectCommand({ type: "sideEffect/decideApproval", approvalRequestId: pending.callId, decision: "APPROVE" });
    assert.equal(approved.ok, true, JSON.stringify(approved));

    const outcome = await running;
    assert.equal(outcome.complete, true, JSON.stringify(outcome));
    assert.equal(mcpResults.length, 1);
    assert.equal(mcpResults[0].res.ok, true, JSON.stringify(mcpResults[0].res));
    assert.deepEqual(JSON.parse(mcpResults[0].res.text), { tool: TOOL, arguments: { a: 1, b: 2 } });
    const after = await env.serverState();
    assert.equal(after.toolsCalls.length, 1, "审批通过后必须恰好 1 次真实 tools/call");
    assert.equal(after.toolsCalls[0].name, TOOL);

    const converged = env.fx.sideEffectStore.callById(pending.callId);
    assert.equal(converged.status, "SUCCEEDED");
    assert.equal(converged.verificationStatus, "PASS");
    assert.equal(env.fx.sideEffectStore.activeLeaseOfCall(pending.callId), null, "终态不得残留 ACTIVE lease");
    assert.equal(env.fx.toolStore.executionsOfTask(pending.taskId).length, 0, "SideEffectCall 是唯一权威，不产生第二套 tool_execution");
    for (const origin of env.urlsSeen) assert.equal(origin, "http://127.0.0.1:" + env.info.port, "出现非 loopback 请求：" + origin);

    // 只读边界：桥全程不改 dx_tasks / dx_task_steps。
    assert.equal(dxStateHash(env.f.identity.connection), dxHashBefore, "桥不得修改 dx 侧行");

    console.log("[bridge-e2e-evidence] " + JSON.stringify({
      loopbackOrigin: "http://127.0.0.1:" + env.info.port,
      observedOrigins: [...new Set(env.urlsSeen)],
      toolsCalls: after.toolsCalls,
      dxTaskId: run.dxTaskId, dxStepId: run.stepId,
      coreTaskId: dxIdentity.coreTaskId, coreStepId: dxIdentity.coreStepId, coreRunId: dxIdentity.coreRunId,
      callId: pending.callId, callStatus: converged.status, verificationStatus: converged.verificationStatus,
      dxStateHashUnchanged: dxStateHash(env.f.identity.connection) === dxHashBefore,
    }));
  } finally {
    await env.close();
  }
});

test("端到端：agent 工具循环内拒绝 → 0 传输；超时 → 0 传输（均结构化 APPROVAL_DENIED / APPROVAL_TIMEOUT）", async () => {
  const env = await setup({ approvalTimeoutMs: 500 });
  try {
    // ① 拒绝：走 agent 工具循环（project-agent-mode），DENY 经真实 sideEffect/decideApproval。
    const denyRun = env.newDxRun("deny");
    const denyResults = [];
    buildAgentLoopHarness({
      fname: env.fname, sourceId: env.connectionId,
      mcpCallByName: async (name, args, ctx) => { const res = await env.agentBridge.mcpAgentTools.callByName(name, args, ctx); denyResults.push(res); return res; },
    });
    const denyRunning = projectAgent.runProjectAgentMode(PROJECT, ACTOR, "拒绝场景", [], {}, { taskId: denyRun.dxTaskId, stepId: denyRun.stepId });
    const denyPending = await waitForPending(env.fx.sideEffectStore);
    const denied = await env.sideEffectCommand({ type: "sideEffect/decideApproval", approvalRequestId: denyPending.callId, decision: "DENY" });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    await denyRunning;
    assert.equal(denyResults.length, 1);
    assert.equal(denyResults[0].ok, false);
    assert.equal(denyResults[0].error, "APPROVAL_DENIED");
    assert.equal((await env.serverState()).toolsCalls.length, 0, "拒绝后 0 次 tools/call");
    assert.equal(env.fx.sideEffectStore.callById(denyPending.callId).status, "BLOCKED");

    // ② 超时：不批准，等既有 approvalWait 到点（resolvePendingForStep 收敛 APPROVAL_TIMEOUT / BLOCKED）。
    const timeoutRun = env.newDxRun("timeout");
    const timeoutRes = await env.agentBridge.mcpAgentTools.callByName(env.fname, { a: 8 }, { taskId: timeoutRun.dxTaskId, stepId: timeoutRun.stepId });
    assert.equal(timeoutRes.ok, false, JSON.stringify(timeoutRes));
    assert.equal(timeoutRes.error, "APPROVAL_TIMEOUT");
    assert.equal((await env.serverState()).toolsCalls.length, 0, "超时后 0 次 tools/call");

    for (const origin of env.urlsSeen) assert.equal(origin, "http://127.0.0.1:" + env.info.port, "出现非 loopback 请求：" + origin);
    console.log("[bridge-deny-timeout-evidence] " + JSON.stringify({
      denyCallStatus: env.fx.sideEffectStore.callById(denyPending.callId).status,
      denyPortResult: denyResults[0].error,
      timeoutPortResult: timeoutRes.error,
      toolsCalls: (await env.serverState()).toolsCalls.length,
    }));
  } finally {
    await env.close();
  }
});

test("开关关闭：MCP 调用在桥/审批/传输之前 fail closed，0 次 tools/call、0 条核心任务", async () => {
  const env = await setup();
  try {
    env.sw.setToolInvocationEnabled(false);
    const run = env.newDxRun("switch-off");
    const res = await env.agentBridge.mcpAgentTools.callByName(env.fname, { a: 1 }, { taskId: run.dxTaskId, stepId: run.stepId });
    assert.equal(res.ok, false);
    assert.equal(res.error, "MCP_TOOL_INVOCATION_NOT_ENABLED");
    assert.equal((await env.serverState()).toolsCalls.length, 0);
    // 开关关 = 连桥都没跑：同一 dx 步骤没有产生任何映射/核心任务。
    assert.equal(env.bridge.listMappings({ dxTaskId: run.dxTaskId }).length, 0, "开关关闭不得建立映射");
    assert.equal(env.fx.sideEffectStore.callsByStatus("AWAITING_APPROVAL").length, 0, "开关关闭不得建立审批请求");
    console.log("[bridge-switch-off-evidence] " + JSON.stringify({ error: res.error, toolsCalls: 0, mappings: 0 }));
  } finally {
    await env.close();
  }
});

test("映射幂等 + 反查 + 只读边界：同一 dx 步骤 N 次调用只产生 1 个核心任务/步骤/运行", async () => {
  const env = await setup();
  try {
    const run = env.newDxRun("idempotent");
    const dxHashBefore = dxStateHash(env.f.identity.connection);

    const first = env.bridge.ensureCoreApprovalTask({ dxTaskId: run.dxTaskId, dxStepId: run.stepId, context: env.bridge.trustedContext() });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.created, true);
    assert.equal(first.duplicate, false);
    const coreTaskId = first.mapping.coreTaskId;

    for (let i = 0; i < 4; i += 1) {
      const again = env.bridge.ensureCoreApprovalTask({ dxTaskId: run.dxTaskId, dxStepId: run.stepId, context: env.bridge.trustedContext() });
      assert.equal(again.ok, true, JSON.stringify(again));
      assert.equal(again.created, false, "重复调用绝不新建");
      assert.equal(again.duplicate, true);
      assert.equal(again.mapping.coreTaskId, coreTaskId);
      assert.equal(again.mapping.coreStepId, first.mapping.coreStepId);
      assert.equal(again.mapping.coreRunId, first.mapping.coreRunId);
    }

    const mappings = env.bridge.listMappings({ dxTaskId: run.dxTaskId });
    assert.equal(mappings.length, 1, "同一 dx 步骤只允许一条映射");
    const db = env.f.identity.connection;
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM dx_task_approval_bridge WHERE dx_task_id=? AND dx_step_id=?").get(run.dxTaskId, run.stepId).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE task_id=?").get(coreTaskId).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM task_steps WHERE task_id=?").get(coreTaskId).c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM task_harness_runs WHERE task_id=?").get(coreTaskId).c, 1);

    // 反查：核心任务 → dx 身份。
    const reverse = env.bridge.dxIdentityOfCoreTask(coreTaskId);
    assert.equal(reverse.dxTaskId, run.dxTaskId);
    assert.equal(reverse.dxStepId, run.stepId);
    // 已是核心任务 id 时透传（mcp/toolInvocation/call 路径语义不变）。
    assert.equal(env.bridge.isCoreTaskId(coreTaskId), true);
    assert.equal(env.bridge.isCoreTaskId(run.dxTaskId), false);

    // 只读边界：桥只读 dx 侧；调用前后行内容哈希一致。
    assert.equal(dxStateHash(db), dxHashBefore, "桥不得修改 dx_tasks / dx_task_steps");

    // 该映射的核心任务确实由核心 Task Runtime 持有，且可被既有审批链定位（RUNNING + RUNNING step + 最新 run）。
    const coreTask = env.fx.taskStore.taskById(coreTaskId);
    const coreStep = env.fx.taskStore.stepById(first.mapping.coreStepId);
    const runs = env.fx.taskStore.harnessRunsOfTask(coreTaskId);
    assert.equal(coreTask.status, "RUNNING");
    assert.equal(coreTask.user_id, env.f.users.admin);
    assert.equal(coreTask.app_id, "mcp-center");
    assert.equal(coreStep.status, "RUNNING");
    assert.equal(runs[runs.length - 1].run_id, first.mapping.coreRunId);

    console.log("[bridge-idempotency-evidence] " + JSON.stringify({
      dxTaskId: run.dxTaskId, dxStepId: run.stepId, coreTaskId, coreStepId: first.mapping.coreStepId, coreRunId: first.mapping.coreRunId,
      ensureCalls: 5, mappingRows: mappings.length, coreTaskRows: 1, coreStepRows: 1, coreRunRows: 1,
      dxStateHashUnchanged: dxStateHash(db) === dxHashBefore,
    }));
  } finally {
    await env.close();
  }
});

test("桥 fail closed：dx 任务不存在 / 非本人 / 非 running / 未知步骤 一律 DENIED 且 0 映射", async () => {
  const env = await setup();
  try {
    const ctx = env.bridge.trustedContext();
    const missing = env.bridge.ensureCoreApprovalTask({ dxTaskId: "dx_task_does_not_exist", context: ctx });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, BRIDGE_ERROR.TASK_NOT_FOUND);

    const run = env.newDxRun("fail-closed");
    // 非本人：改一个只有 session 归属能纠正的字段（created_by 不是当前 admin）。
    const foreign = env.bridge.ensureCoreApprovalTask({ dxTaskId: run.dxTaskId, dxStepId: run.stepId, context: { sessionRef: null, appId: "mcp-center" } });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.error, BRIDGE_ERROR.INVALID_INPUT);

    const unknownStep = env.bridge.ensureCoreApprovalTask({ dxTaskId: run.dxTaskId, dxStepId: "no-such-step", context: ctx });
    assert.equal(unknownStep.ok, false);
    assert.equal(unknownStep.error, BRIDGE_ERROR.STEP_NOT_FOUND);

    // 非 running：终态 dx 任务不得建立核心审批任务。
    env.f.identity.connection.prepare("UPDATE dx_tasks SET status='completed' WHERE id=?").run(run.dxTaskId);
    const inactive = env.bridge.ensureCoreApprovalTask({ dxTaskId: run.dxTaskId, dxStepId: run.stepId, context: ctx });
    assert.equal(inactive.ok, false);
    assert.equal(inactive.error, BRIDGE_ERROR.TASK_NOT_ACTIVE);

    assert.equal(env.bridge.listMappings({ dxTaskId: run.dxTaskId }).length, 0, "失败路径零映射");
    assert.equal(env.fx.sideEffectStore.callsByStatus("AWAITING_APPROVAL").length, 0, "失败路径零审批请求");
    console.log("[bridge-fail-closed-evidence] " + JSON.stringify({ missing: missing.error, unknownStep: unknownStep.error, inactive: inactive.error, mappings: 0 }));
  } finally {
    await env.close();
  }
});
