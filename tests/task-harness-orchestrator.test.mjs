/** D4-02C · Orchestrator 领域单测：ACP mapping / prompt / block / 原子提交 / 0 execution。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createTaskHarnessFixture, EXACT } from "./fixtures/harness-acp/task-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { mapAcpEvents, buildPrompt, PROMPT_SCHEMA_VERSION, classifyHarnessError } = require("../electron/task-harness-orchestrator.cjs");
const { ERROR } = require("../electron/task-domain.cjs");
const { registerTaskIpc } = require("../electron/task-bootstrap.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真实 adapter 的 start/prompt 调用计数：0 重试不能只看终态，必须看真实调用次数。 */
function countingFactory(baseFactory, counter) {
  return (opts) => {
    const adapter = baseFactory(opts);
    const start = adapter.start.bind(adapter);
    const prompt = adapter.prompt.bind(adapter);
    adapter.start = async (a) => { counter.starts += 1; return await start(a); };
    adapter.prompt = async (text, o) => { counter.prompts += 1; return await prompt(text, o); };
    return adapter;
  };
}

function stubFactory({ modelConfigVersion, text = EXACT, behavior = "ok" }) {
  return {
    lastText: null,
    async start() { return { capabilityId: "mcap_stub", modelConfigVersion, dshVersion: "stub-0", sdkVersion: "0.0.0", protocolVersion: 1 }; },
    async prompt(p) {
      this.lastText = p;
      if (behavior === "crash") throw Object.assign(new Error("HARNESS_PROCESS_EXITED"), { code: "HARNESS_PROCESS_EXITED" });
      if (behavior === "timeout") throw Object.assign(new Error("HARNESS_TURN_TIMEOUT"), { code: "HARNESS_TURN_TIMEOUT" });
      const events = [{ type: "text.delta", text }];
      if (behavior === "tool") events.push({ type: "tool.proposed", toolCallId: "tc_stub" });
      if (behavior === "permission") events.push({ type: "permission.requested" });
      return { ok: true, stopReason: "end_turn", text, events };
    },
    async cancel() {},
    revokeModelCapability() {},
    async dispose() {},
  };
}

test("ACP → TaskEvent mapping 显式、聚合 text、丢 reasoning、洪泛有上限", () => {
  const events = [
    { type: "text.delta", text: "OPEN" },
    { type: "text.delta", text: "ARC" },
    { type: "reasoning.delta", text: "private chain of thought" },
    { type: "tool.proposed", toolCallId: "tc1" },
    { type: "plan" },
    { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    { type: "permission.requested" },
    { type: "totally.unknown" },
  ];
  const m = mapAcpEvents(events, { maxPersisted: 32 });
  const types = m.events.map((e) => e.eventType);
  assert.ok(types.includes("harness.text.delta"));
  assert.ok(types.includes("harness.tool_proposed"));
  assert.ok(types.includes("harness.plan"));
  assert.ok(types.includes("harness.usage"));
  assert.ok(types.includes("harness.permission_requested"));
  assert.ok(types.includes("harness.permission_rejected"));
  assert.ok(!m.events.some((e) => JSON.stringify(e).includes("private chain of thought")), "reasoning 不得落库");
  const textEv = m.events.find((e) => e.eventType === "harness.text.delta");
  assert.equal(textEv.safePayload.chars, 7);
  assert.equal(textEv.safePayload.chunks, 2);
  assert.ok(m.dropped >= 1, "未知事件被丢弃");

  const flood = mapAcpEvents(Array.from({ length: 200 }, (_, i) => ({ type: "tool.proposed", toolCallId: "tc" + i })), { maxPersisted: 5 });
  assert.ok(flood.events.length <= 5);
  assert.ok(flood.dropped >= 195);
});

test("prompt 只含 goal + safe input，且 schema 版本冻结", () => {
  const p = buildPrompt({ goal: "Return exactly: " + EXACT, stepInput: { a: 1 } });
  assert.ok(p.includes(EXACT));
  assert.ok(!/authorization|bearer|api[_-]?key|provider secret/i.test(p));
  assert.equal(typeof PROMPT_SCHEMA_VERSION, "number");
});

test("turn 成功：Artifact + Verification PASS → Step/Task SUCCEEDED", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    assert.ok(t.ok, JSON.stringify(t));
    const orch = fx.makeOrchestrator(stubFactory);
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.equal(r.step.status, "SUCCEEDED");
    assert.equal(r.artifact.content, EXACT);
    assert.equal(r.verification.status, "PASS");
    const arts = fx.taskService.getArtifacts({ context: fx.ctx(), taskId: t.task.taskId });
    assert.equal(arts.items.length, 1);
    assert.equal(arts.items[0].checksum, r.artifact.checksum);
    const runs = fx.taskService.getHarnessRuns({ context: fx.ctx(), taskId: t.task.taskId });
    assert.equal(runs.items.length, 1);
    assert.equal(runs.items[0].status, "SUCCEEDED");
    assert.equal(orch.lastEvidence.runId, runs.items[0].runId);
  } finally { await fx.close(); }
});

test("成功必须 Verification PASS：文本不符 → BLOCKED 且 0 artifact", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    const orch = fx.makeOrchestrator((opts) => stubFactory({ ...opts, text: "WRONG" }));
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    assert.equal(r.ok, false);
    assert.equal(r.error, "VERIFICATION_FAILED");
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(fx.taskService.getArtifacts({ context: fx.ctx(), taskId: t.task.taskId }).items.length, 0);
  } finally { await fx.close(); }
});

test("Artifact 写入失败：Step/Task 绝不 SUCCEEDED，且无 artifact（失败原子性）", async () => {
  let boom = false;
  const fx = await createTaskHarnessFixture({ hooks: { beforeArtifactInsert() { if (boom) throw new Error("injected artifact write failure"); } } });
  try {
    const t = fx.createTask();
    boom = true;
    const orch = fx.makeOrchestrator(stubFactory);
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    assert.equal(r.ok, false);
    assert.notEqual(r.task.status, "SUCCEEDED");
    const task = fx.taskService.getTask({ context: fx.ctx(), taskId: t.task.taskId });
    assert.notEqual(task.task.status, "SUCCEEDED");
    const steps = fx.taskService.getSteps({ context: fx.ctx(), taskId: t.task.taskId });
    assert.notEqual(steps.items[0].status, "SUCCEEDED");
    assert.equal(fx.taskService.getArtifacts({ context: fx.ctx(), taskId: t.task.taskId }).items.length, 0);
  } finally { await fx.close(); }
});

test("Harness crash → BLOCKED + HARNESS_PROCESS_EXITED，0 respawn", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    const orch = fx.makeOrchestrator((opts) => stubFactory({ ...opts, behavior: "crash" }));
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.ok, false);
    assert.equal(r.error, "HARNESS_PROCESS_EXITED");
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(r.task.status, "BLOCKED");
    const runs = fx.taskService.getHarnessRuns({ context: fx.ctx(), taskId: t.task.taskId });
    assert.equal(runs.items.length, 1, "0 respawn / 0 rerun");
    assert.equal(runs.items[0].status, "BLOCKED");
  } finally { await fx.close(); }
});

test("turn timeout → BLOCKED + HARNESS_TURN_TIMEOUT，0 第二次 prompt", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    const orch = fx.makeOrchestrator((opts) => stubFactory({ ...opts, behavior: "timeout" }));
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.error, "HARNESS_TURN_TIMEOUT");
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(fx.taskService.getHarnessRuns({ context: fx.ctx(), taskId: t.task.taskId }).items.length, 1);
  } finally { await fx.close(); }
});

test("Tool proposal → 0 execution + BLOCKED TOOL_EXECUTION_NOT_AVAILABLE", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    const orch = fx.makeOrchestrator((opts) => stubFactory({ ...opts, behavior: "tool" }));
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.error, "TOOL_EXECUTION_NOT_AVAILABLE");
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(fx.taskService.getArtifacts({ context: fx.ctx(), taskId: t.task.taskId }).items.length, 0);
    const events = fx.taskService.getEvents({ context: fx.ctx(), taskId: t.task.taskId }).items.map((e) => e.eventType);
    assert.ok(events.includes("harness.tool_proposed"));
    assert.ok(!events.includes("step.succeeded"));
  } finally { await fx.close(); }
});

test("Permission request → reject + BLOCKED PERMISSION_NOT_AVAILABLE，0 execution", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    const orch = fx.makeOrchestrator((opts) => stubFactory({ ...opts, behavior: "permission" }));
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.error, "PERMISSION_NOT_AVAILABLE");
    assert.equal(r.step.status, "BLOCKED");
    const events = fx.taskService.getEvents({ context: fx.ctx(), taskId: t.task.taskId }).items.map((e) => e.eventType);
    assert.ok(events.includes("harness.permission_requested"));
    assert.ok(events.includes("harness.permission_rejected"));
  } finally { await fx.close(); }
});

test("classifyHarnessError：启动超时 / 执行超时各自映射，绝不互相改写", () => {
  assert.equal(classifyHarnessError({ code: "HARNESS_START_TIMEOUT" }), "HARNESS_START_TIMEOUT");
  assert.equal(classifyHarnessError({ code: "HARNESS_TURN_TIMEOUT" }), "HARNESS_TURN_TIMEOUT");
  assert.equal(ERROR.HARNESS_START_TIMEOUT, "HARNESS_START_TIMEOUT");
  assert.notEqual(classifyHarnessError({ code: "HARNESS_START_TIMEOUT" }), ERROR.HARNESS_TURN_TIMEOUT);
});

test("启动超时（真实 adapter + 可控阻塞 initialize）→ HARNESS_START_TIMEOUT · BLOCKED · capability 撤销 · 0 重试", async () => {
  const fx = await createTaskHarnessFixture();
  let orch = null;
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const realCalls = { starts: 0, prompts: 0 };
    // 预算仍是产品默认 30s/180s，这里只**注入**更小的启动预算让真实超时快速触发。
    orch = fx.makeOrchestrator(countingFactory(fx.agentFactory("start-hang-agent.mjs"), realCalls), { startTimeoutMs: 700, turnTimeoutMs: 60000 });
    const t0 = Date.now();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const elapsedMs = Date.now() - t0;

    assert.equal(r.error, "HARNESS_START_TIMEOUT", JSON.stringify(r));
    assert.notEqual(r.error, "HARNESS_TURN_TIMEOUT", "启动超时不得被改写成执行超时");
    assert.equal(r.ok, false);
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(realCalls.starts, 1, "0 第二次 start");
    assert.equal(realCalls.prompts, 0, "启动未成功 → 绝不进入 prompt");

    const runs = fx.taskService.getHarnessRuns({ context: ctx, taskId: t.task.taskId });
    assert.equal(runs.items.length, 1, "0 respawn / 0 rerun");
    assert.equal(runs.items[0].status, "BLOCKED");
    assert.equal(runs.items[0].errorCode, "HARNESS_START_TIMEOUT");
    assert.equal(runs.items[0].stopReason, "blocked");
    assert.equal(fx.taskService.getCalls({ context: ctx, taskId: t.task.taskId }).items.length, 0, "0 模型调用 / 0 二次 call");
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0);

    const caps = [...fx.proxy.capabilities.values()];
    assert.ok(caps.length >= 1, "启动前已签发 capability");
    for (const cap of caps) assert.equal(cap.state, "REVOKED", "run 一结束立即撤销能力");

    const events = fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).items;
    assert.equal(events.find((e) => e.eventType === "step.blocked").safePayload.reason, "HARNESS_START_TIMEOUT");
    assert.equal(events.find((e) => e.eventType === "harness.run.blocked").safePayload.errorCode, "HARNESS_START_TIMEOUT");
    assert.ok(elapsedMs < 700 + 15000, "有界停止，实际 " + elapsedMs + "ms");
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});

test("执行超时（真实 adapter + 可控阻塞 prompt）→ HARNESS_TURN_TIMEOUT · BLOCKED · capability 撤销 · 恰好 1 次 prompt", async () => {
  const fx = await createTaskHarnessFixture();
  let orch = null;
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const realCalls = { starts: 0, prompts: 0 };
    // 启动预算放宽（该探针 start 正常），执行预算注入小值触发真实 turn 超时。
    orch = fx.makeOrchestrator(countingFactory(fx.agentFactory("turn-hang-agent.mjs"), realCalls), { startTimeoutMs: 20000, turnTimeoutMs: 700 });
    const t0 = Date.now();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const elapsedMs = Date.now() - t0;

    assert.equal(r.error, "HARNESS_TURN_TIMEOUT", JSON.stringify(r));
    assert.notEqual(r.error, "HARNESS_START_TIMEOUT", "执行超时不得被改写成启动超时");
    assert.equal(r.ok, false);
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(realCalls.starts, 1, "0 第二次 start");
    assert.equal(realCalls.prompts, 1, "0 第二次 prompt / 0 自动重试");

    const runs = fx.taskService.getHarnessRuns({ context: ctx, taskId: t.task.taskId });
    assert.equal(runs.items.length, 1, "0 respawn / 0 rerun");
    assert.equal(runs.items[0].status, "BLOCKED");
    assert.equal(runs.items[0].errorCode, "HARNESS_TURN_TIMEOUT");
    const calls = fx.taskService.getCalls({ context: ctx, taskId: t.task.taskId }).items;
    assert.equal(calls.length, 1, "恰好 1 次 call / 0 二次 call");
    assert.equal(calls[0].status, "FAILED");
    assert.equal(calls[0].providerErrorCode, "HARNESS_TURN_TIMEOUT");
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0);

    const caps = [...fx.proxy.capabilities.values()];
    assert.ok(caps.length >= 1, "启动前已签发 capability");
    for (const cap of caps) assert.equal(cap.state, "REVOKED", "run 一结束立即撤销能力");

    const events = fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).items;
    assert.equal(events.find((e) => e.eventType === "step.blocked").safePayload.reason, "HARNESS_TURN_TIMEOUT");
    assert.equal(events.find((e) => e.eventType === "harness.run.blocked").safePayload.errorCode, "HARNESS_TURN_TIMEOUT");
    assert.ok(elapsedMs < 700 + 20000, "有界停止，实际 " + elapsedMs + "ms");
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});

test("真实 IPC 入口：启动超时 → task/result.error 与 task/get.stopReason 都是 HARNESS_START_TIMEOUT", async () => {
  const fx = await createTaskHarnessFixture();
  let orch = null;
  try {
    // 产品入口 task/run 只按后端默认配置建任务，这里显式把夹具模型设为默认。
    fx.f.modelService.setDefault({ context: fx.ctx(), capability: "chat", configId: fx.modelConfigId });
    const realCalls = { starts: 0, prompts: 0 };
    orch = fx.makeOrchestrator(countingFactory(fx.agentFactory("start-hang-agent.mjs"), realCalls), { startTimeoutMs: 700 });
    const events = [];
    const handlers = new Map();
    registerTaskIpc({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: () => {} },
      taskService: fx.taskService, orchestrator: orch,
      identity: { current: fx.f.sessions.admin }, send: (ev) => events.push(ev), hostAppId: "ai",
    });
    const command = handlers.get("task:command");
    const started = await command(null, { command: "task/run", goal: "Return exactly: " + EXACT });
    assert.ok(started.ok, JSON.stringify(started));
    for (let i = 0; i < 200 && !events.some((e) => e.type === "task/result"); i += 1) await sleep(25);
    const result = events.find((e) => e.type === "task/result");
    assert.ok(result, "task/result 已推送");
    // components.tsx:939 setError(ev.error) → :1010 [data-ai-error] 原样渲染该字符串。
    assert.equal(result.error, "HARNESS_START_TIMEOUT");
    assert.equal(result.status, "BLOCKED");
    const got = await command(null, { command: "task/get", taskId: started.taskId });
    assert.equal(got.stopReason, "HARNESS_START_TIMEOUT");
    // components.tsx:1012 起 [data-ai-stop-reason] 只在 resumable 时渲染；启动超时不是预算停止。
    assert.equal(got.resumable, false);
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});
