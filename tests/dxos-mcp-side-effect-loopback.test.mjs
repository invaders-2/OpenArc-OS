/**
 * D5-04 · MCP 外部工具经**既有 SideEffectAuthority** 的离线端到端测试。
 *
 * 证明的是"生产路径真的走既有权威"，不是注入 trustedApproval 桩：
 *   loopback MCP 服务（只监听 127.0.0.1）
 *     ← electron/mcp-live-transport.cjs（McpService 活连接）
 *     ← electron/mcp-side-effect-provider.cjs（plan / execute / verify，注册进既有 adapters）
 *     ← electron/side-effect-authority.cjs（唯一审批/lease/claim/verify/audit 权威）
 *     ← electron/side-effect-runtime.cjs（proposeWrite + resolvePendingForStep）
 *     ← 真实审批命令 sideeffect:command → sideEffect/decideApproval（electron/side-effect-bootstrap.cjs）
 *
 * 装配限制（如实标注）：Test Harness 不起真实 Electron 主进程；本测试用**进程内等价装配**
 * （同一个 SideEffectAuthority / SideEffectRuntime / 真实 IPC handler 形状）跑到同一条链。
 * 未覆盖的是"真实渲染层按钮 → ipcRenderer.invoke('sideeffect:command')"这一段 UI 传输。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const { createSideEffectExecutionPort } = require("../electron/mcp-agent-tools.cjs");
const { createMcpSideEffectProvider } = require("../electron/mcp-side-effect-provider.cjs");
const { mcpToolIdFor, MCP_TOOL_VERSION } = require("../electron/mcp-tool-contract.cjs");
const { createSideEffectGateway, registerSideEffectIpc } = require("../electron/side-effect-bootstrap.cjs");

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
      try {
        const info = JSON.parse(buffer.slice(0, index));
        clearTimeout(timer);
        resolve(info);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
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

/** 进程内等价装配：真实 SideEffectAuthority/Runtime + 真实 McpService/McpClient + 真实 IPC handler。 */
async function setup({ approvalTimeoutMs = 2500 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-mcp-side-effect-"));
  const server = startLoopbackToolServer();
  const info = await server.ready;
  const fx = await createToolHarnessFixture({ withAdapters: true });
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
    identity: f.identity,
    authService: f.authService,
    authStore: f.store,
    mcpStore,
    credentialStore,
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

  // 既有的 SideEffectAuthority 装配：把 MCP provider 注册进既有 adapters 注册表（不新建第二套）。
  const transport = createMcpLiveTransport({ mcpService, switchPort: sw });
  fx.adapters.providers.McpExternal = createMcpSideEffectProvider({ transport, registry: fx.toolRegistry });
  const approval = createSideEffectExecutionPort({ runtime: fx.sideEffectRuntime, toolIdFor: mcpToolIdFor, toolVersionFor: () => MCP_TOOL_VERSION, approvalTimeoutMs });
  const bridge = createMcpAgentBridge({ mcpService, context: () => mcpCtx, switch: sw, registry: fx.toolRegistry, transport, approval });

  // 真实审批命令路径：sideeffect:command → sideEffect/decideApproval（不是 trustedApproval 桩）。
  const handlers = new Map();
  const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
  registerSideEffectIpc({ ipcMain, service: createSideEffectGateway({ sideEffectRuntime: fx.sideEffectRuntime }), identity: { current: f.sessions.admin }, isTrusted: () => true });
  const sideEffectCommand = (raw) => handlers.get("sideeffect:command")({}, raw);

  // RUNNING 的真实 Task + RUNNING step + 最新 harness run（authority 的 eligibility 要求 step/run 绑定）。
  const run = fx.dshRunSetup();
  assert.ok(run.taskId && run.stepId && run.runId, "dshRunSetup 必须给出真实 task/step/run");
  const taskId = run.taskId;
  const taskCtx = { sessionRef: f.sessions.admin, appId: "ai", source: "ui" };

  const serverState = async () => (await fetch("http://127.0.0.1:" + info.port + "/__state")).json();

  return {
    tmp, server, info, fx, f, sw, connectionId, transport, bridge, taskId, taskCtx, sideEffectCommand, urlsSeen, serverState, sleep,
    freshRun: () => fx.dshRunSetup(),
    toolId: mcpToolIdFor(connectionId, TOOL),
    async close() {
      try { await mcpService.dispose(); } catch { /* ignore */ }
      try { server.stop(); } catch { /* ignore */ }
      try { await fx.close(); } catch { /* ignore */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

test("端到端：提议→既有 sideEffect/decideApproval 批准→真实 tools/call 到达 loopback→回结果（只走 127.0.0.1）", async () => {
  const env = await setup();
  try {
    const { fx, bridge, connectionId, taskId, taskCtx, sideEffectCommand, serverState } = env;
    const args = { a: 1, b: 2, text: "SECRET_VALUE_SHOULD_NOT_PERSIST" };

    // ① 发起调用：审批端口内部 proposeWrite（plan）→ AWAITING_APPROVAL（真实 SideEffectCall）。
    const running = bridge.mcpAgentTools.callDirect(connectionId, TOOL, args, { context: taskCtx, taskId });
    const pending = await waitForPending(fx.sideEffectStore);
    assert.equal(pending.effectClass, "EXTERNAL_SIDE_EFFECT");
    assert.equal(pending.toolId, env.toolId);
    assert.equal(pending.toolVersion, 1);
    assert.equal((await serverState()).toolsCalls.length, 0, "未批准时 0 次 tools/call");
    // 参数摘要脱敏：原始值绝不落库（只有 hash + 字段名/类型摘要）。
    const callRow = JSON.stringify(fx.sideEffectStore.callById(pending.callId));
    assert.equal(callRow.includes("SECRET_VALUE_SHOULD_NOT_PERSIST"), false, "原始参数值不得落库：" + callRow.slice(0, 300));
    const summary = pending.expectedEffectsSafe[0].argsSummary;
    assert.equal(summary.includes("SECRET_VALUE_SHOULD_NOT_PERSIST"), false, "摘要不得回值");
    assert.match(summary, /a\(number\)/);
    assert.match(summary, /b\(number\)/);
    assert.match(summary, /text\(string:\d+\)/);

    // 既有 sideEffect 审批 UI（同一 listPending/approvalSnapshot 通道）必须能看到这条 MCP 调用。
    const pendingList = fx.sideEffectRuntime.listPendingApprovals({ context: { sessionRef: env.f.sessions.admin } });
    const snap = pendingList.items.find((it) => it.approvalRequestId === pending.callId);
    assert.ok(snap, "既有审批通道必须能看到 MCP 调用：" + JSON.stringify(pendingList));
    assert.equal(snap.riskClass, "EXTERNAL_SIDE_EFFECT");
    assert.equal(snap.requiresApproval, true);
    assert.match(snap.toolDisplayName, /^MCP /);
    assert.equal(snap.targetDisplayName, "MCP " + connectionId + " · " + TOOL);
    assert.equal(JSON.stringify(snap).includes("SECRET_VALUE_SHOULD_NOT_PERSIST"), false, "审批快照不得回原始参数值");

    // ② 走**真实审批命令**批准。
    const approved = await sideEffectCommand({ type: "sideEffect/decideApproval", approvalRequestId: pending.callId, decision: "APPROVE" });
    assert.equal(approved.ok, true, JSON.stringify(approved));

    // ③ 既有 authority 完成 lease/claim/verify，真实 tools/call 到达 loopback，结果回给调用方。
    const res = await running;
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(JSON.parse(res.text), { tool: TOOL, arguments: args });
    const after = await serverState();
    assert.equal(after.toolsCalls.length, 1, "审批通过后必须恰好 1 次真实 tools/call");
    assert.equal(after.toolsCalls[0].name, TOOL);
    assert.deepEqual(after.toolsCalls[0].arguments, args);

    // ④ 执行确实由既有 SideEffectAuthority 收敛（不是 MCP 层自己发完就算）。
    const converged = fx.sideEffectStore.callById(pending.callId);
    assert.equal(converged.status, "SUCCEEDED");
    assert.equal(converged.verificationStatus, "PASS");
    assert.equal(fx.sideEffectStore.activeLeaseOfCall(pending.callId), null, "终态不得残留 ACTIVE lease");
    assert.equal(fx.toolStore.executionsOfTask(taskId).length, 0, "SideEffectCall 是唯一权威，不产生第二套 tool_execution");
    const audit = fx.f.identity.connection.prepare("SELECT action, decision, reason_code FROM authorization_audit").all();
    const actions = audit.map((r) => r.action);
    for (const act of ["side_effect.planned", "side_effect.approved", "side_effect.execution_placement", "side_effect.execution_started", "side_effect.verification_passed", "side_effect.succeeded"]) {
      assert.ok(actions.includes(act), "缺少既有权威审计 " + act + "：" + JSON.stringify(actions));
    }
    const placement = audit.find((r) => r.action === "side_effect.execution_placement");
    assert.equal(placement.decision, "IN_PROCESS", "MCP 走显式 in-process 执行位");
    assert.equal(placement.reason_code, "PROCESS_LOCAL_DOMAIN");

    // ⑤ 全程只有 loopback。
    assert.ok(env.urlsSeen.length > 0);
    for (const origin of env.urlsSeen) assert.equal(origin, "http://127.0.0.1:" + env.info.port, "出现非 loopback 请求：" + origin);
    console.log("[mcp-side-effect-evidence] " + JSON.stringify({
      loopbackOrigin: "http://127.0.0.1:" + env.info.port,
      observedOrigins: [...new Set(env.urlsSeen)],
      serverByMethod: after.byMethod,
      toolsCalls: after.toolsCalls,
      taskId, toolId: env.toolId,
      callId: pending.callId, callStatus: converged.status, verificationStatus: converged.verificationStatus,
      expectedEffects: converged.expectedEffectsSafe,
    }));
  } finally {
    await env.close();
  }
});

test("端到端：拒绝 → 0 传输；超时 → 0 传输；均结构化回 APPROVAL_DENIED / APPROVAL_TIMEOUT", async () => {
  const env = await setup({ approvalTimeoutMs: 400 });
  try {
    const { fx, bridge, connectionId, taskId, taskCtx, sideEffectCommand, serverState } = env;

    // ① 拒绝：真实 sideEffect/decideApproval DENY。每个场景一条全新 RUNNING task/step/run（拒绝会把 step 收敛 BLOCKED）。
    const denyRun = env.freshRun();
    const denyCall = bridge.mcpAgentTools.callDirect(connectionId, TOOL, { a: 7 }, { context: taskCtx, taskId: denyRun.taskId });
    const denyPending = await waitForPending(fx.sideEffectStore);
    const denied = await sideEffectCommand({ type: "sideEffect/decideApproval", approvalRequestId: denyPending.callId, decision: "DENY" });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    const denyRes = await denyCall;
    assert.equal(denyRes.ok, false, JSON.stringify(denyRes));
    assert.equal(denyRes.error, "APPROVAL_DENIED");
    assert.equal((await serverState()).toolsCalls.length, 0, "拒绝后 0 次 tools/call");
    assert.equal(fx.sideEffectStore.callById(denyPending.callId).status, "BLOCKED");

    // ② 超时：不批准，等既有 approvalWait 到点（resolvePendingForStep 收敛 APPROVAL_TIMEOUT / BLOCKED）。
    const timeoutRun = env.freshRun();
    const timeoutRes = await bridge.mcpAgentTools.callDirect(connectionId, TOOL, { a: 8 }, { context: taskCtx, taskId: timeoutRun.taskId });
    assert.equal(timeoutRes.ok, false, JSON.stringify(timeoutRes));
    assert.equal(timeoutRes.error, "APPROVAL_TIMEOUT");
    assert.equal((await serverState()).toolsCalls.length, 0, "超时后 0 次 tools/call");

    // 全程只有 loopback（连连接握手也只在本机）。
    for (const origin of env.urlsSeen) assert.equal(origin, "http://127.0.0.1:" + env.info.port, "出现非 loopback 请求：" + origin);
  } finally {
    await env.close();
  }
});

test("开关关闭：MCP 调用在审批与传输之前 fail closed，0 次 tools/call", async () => {
  const env = await setup();
  try {
    env.sw.setToolInvocationEnabled(false);
    const res = await env.bridge.mcpAgentTools.callDirect(env.connectionId, TOOL, { a: 1 }, { context: env.taskCtx, taskId: env.taskId });
    assert.equal(res.ok, false);
    assert.equal(res.error, "MCP_TOOL_INVOCATION_NOT_ENABLED");
    assert.equal((await env.serverState()).toolsCalls.length, 0);
  } finally {
    await env.close();
  }
});
