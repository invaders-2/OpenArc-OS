/** D4-02C · Orchestrator 领域单测：ACP mapping / prompt / block / 原子提交 / 0 execution。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

test("启动预算覆盖整段 session/new：initialize 正常回应但 session/new 永不回应 → HARNESS_START_TIMEOUT · BLOCKED · 子进程与能力全收干净", async () => {
  const fx = await createTaskHarnessFixture();
  let orch = null;
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const realCalls = { starts: 0, prompts: 0 };
    orch = fx.makeOrchestrator(countingFactory(fx.agentFactory("session-new-hold-agent.mjs"), realCalls), { startTimeoutMs: 700, turnTimeoutMs: 60000 });
    const t0 = Date.now();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const elapsedMs = Date.now() - t0;

    // R1：initialize 成功之后的这段启动同样必须有上界，且归因为启动超时。
    assert.equal(r.error, "HARNESS_START_TIMEOUT", JSON.stringify(r));
    assert.equal(r.ok, false);
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(r.run.status, "BLOCKED");
    assert.equal(r.run.errorCode, "HARNESS_START_TIMEOUT");
    assert.equal(realCalls.starts, 1, "0 第二次 start");
    assert.equal(realCalls.prompts, 0, "启动未成功 → 0 prompt");

    const runs = fx.taskService.getHarnessRuns({ context: ctx, taskId: t.task.taskId });
    assert.equal(runs.items.length, 1, "0 respawn / 0 rerun");
    assert.equal(runs.items[0].status, "BLOCKED");
    assert.equal(runs.items[0].errorCode, "HARNESS_START_TIMEOUT");
    assert.equal(runs.items[0].stopReason, "blocked");
    assert.equal(fx.fp.state.requests, 0, "0 provider 请求");
    assert.equal(fx.taskService.getCalls({ context: ctx, taskId: t.task.taskId }).items.length, 0, "0 模型调用");

    const events = fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).items;
    assert.equal(events.find((e) => e.eventType === "step.blocked").safePayload.reason, "HARNESS_START_TIMEOUT");
    assert.equal(events.find((e) => e.eventType === "harness.run.blocked").safePayload.errorCode, "HARNESS_START_TIMEOUT");

    const caps = [...fx.proxy.capabilities.values()];
    assert.ok(caps.length >= 1, "启动前已签发 capability");
    for (const cap of caps) assert.equal(cap.state, "REVOKED", "收敛后两类能力立即撤销");
    const held = orch.registry.get(runs.items[0].runId);
    assert.equal(held, undefined, "启动段收敛后不残留 registry 登记");
    assert.ok(elapsedMs < 700 + 15000, "有界停止，实际 " + elapsedMs + "ms");
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});

test("共享绝对截止时间：initialize 吃掉 600/700 预算后，session/new 只剩剩余预算（不重新获得 700ms）", async () => {
  const fx = await createTaskHarnessFixture();
  let orch = null;
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const realCalls = { starts: 0, prompts: 0 };
    const budgetMs = 700;
    const spentMs = 600;
    const t0 = Date.now();
    let currentNow = t0;
    let deadlineAt = null;
    let startCalledAt = null;
    let sessionRemainingMs = null;
    // session/new 永不回应（延迟 0）；initialize 的耗时只记进注入时钟（真实时钟仍在走）。
    const baseFactory = countingFactory(fx.agentFactory("session-new-hold-agent.mjs"), realCalls);
    orch = fx.makeOrchestrator((opts) => {
      const adapter = baseFactory(opts);
      adapter.clock = () => currentNow;
      const start = adapter.start.bind(adapter);
      adapter.start = async (a) => {
        startCalledAt = Date.now();
        deadlineAt = currentNow + Math.max(1, a.startTimeoutMs);
        return await start(a);
      };
      // initialize 已回应、session/new 刚发出：这一刻把 600ms 记进注入时钟。
      let conn = null;
      Object.defineProperty(adapter, "conn", {
        configurable: true,
        get() { return conn; },
        set(value) {
          conn = value;
          if (value) {
            const newSession = value.newSession.bind(value);
            value.newSession = (params) => {
              currentNow = startCalledAt + spentMs;
              sessionRemainingMs = deadlineAt - currentNow;
              return newSession(params);
            };
          }
        },
      });
      return adapter;
    }, { startTimeoutMs: budgetMs, turnTimeoutMs: 60000 });

    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });

    assert.equal(r.error, "HARNESS_START_TIMEOUT", JSON.stringify(r));
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(r.run.errorCode, "HARNESS_START_TIMEOUT");
    assert.equal(realCalls.prompts, 0, "0 prompt");
    assert.equal(fx.fp.state.requests, 0, "0 provider 请求");
    // 决定性判据：session/new 发出时用的仍是**同一个**绝对截止时间，只剩 ~100ms 剩余预算
    // （放宽到「≤ 已花掉的 600ms」以吸收 initialize 的真实耗时），旧行为必然重新获得 700ms。
    assert.ok(sessionRemainingMs > 0, "session/new 必须仍有剩余预算，实际 " + sessionRemainingMs + "ms");
    assert.ok(sessionRemainingMs <= spentMs, "session/new 绝不重新获得整份预算，实际 " + sessionRemainingMs + "ms");
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});

test("迟到 session/new 响应：截止时间后到达 → 绝不复活 run、绝不触发 prompt、0 provider 请求", async () => {
  const fx = await createTaskHarnessFixture();
  let orch = null;
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const realCalls = { starts: 0, prompts: 0 };
    // 探查探针：session/new 延迟 1800ms 回应；启动预算 700ms 先到期。
    const probeFactory = (opts) => fx.agentFactory("session-new-hold-agent.mjs")(opts);
    const baseFactory = (opts) => {
      const adapter = probeFactory(opts);
      adapter.dshArgs = [adapter.dshArgs[0], "1800"];
      return adapter;
    };
    orch = fx.makeOrchestrator(countingFactory(baseFactory, realCalls), { startTimeoutMs: 700, turnTimeoutMs: 60000 });
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.error, "HARNESS_START_TIMEOUT", JSON.stringify(r));
    const runs = fx.taskService.getHarnessRuns({ context: ctx, taskId: t.task.taskId });
    assert.equal(runs.items.length, 1);

    // 等到迟到响应窗口之后：run 必须还是同一条 BLOCKED，绝不复活成 RUNNING。
    await sleep(2600);
    const after = fx.taskService.getHarnessRuns({ context: ctx, taskId: t.task.taskId });
    assert.equal(after.items.length, 1, "迟到响应绝不新建 run");
    assert.equal(after.items[0].status, "BLOCKED");
    assert.equal(after.items[0].errorCode, "HARNESS_START_TIMEOUT");
    const task = fx.taskService.getTask({ context: ctx, taskId: t.task.taskId });
    assert.equal(task.task.status, "BLOCKED");
    assert.equal(task.task.cancelRequested, false);
    assert.equal(fx.taskService.getCalls({ context: ctx, taskId: t.task.taskId }).items.length, 0, "迟到响应绝不产生模型调用");
    assert.equal(realCalls.prompts, 0, "迟到响应绝不触发 prompt");
    assert.equal(fx.fp.state.requests, 0, "迟到响应绝不产生 provider 请求");
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0);
    const events = fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).items.map((e) => e.eventType);
    assert.equal(events.filter((e) => e === "harness.run.started").length, 1, "只有一次 run");
    assert.ok(!events.includes("harness.run.succeeded"), "绝不因迟到响应成功");
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});

test("adapter 级：启动失败自清理——子进程退出、临时目录删除、能力撤销、sessionId 保持 null", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const ctx = fx.ctx();
    const adapter = fx.agentFactory("session-new-hold-agent.mjs")({ context: ctx, taskId: "t", stepId: "s", runId: "r", modelConfigId: fx.modelConfigId, modelConfigVersion: null });
    const issued = fx.proxy.capabilities.size;
    let code = null;
    try { await adapter.start({ context: ctx, modelConfigId: fx.modelConfigId, maxCalls: 4, ttlMs: 120000, startTimeoutMs: 700 }); }
    catch (e) { code = e.code; }
    assert.equal(code, "HARNESS_START_TIMEOUT");
    assert.equal(adapter.sessionId, null, "启动未完成 → 绝不持有 session");
    assert.equal(adapter.processExited, true, "启动失败必须回收子进程");
    assert.equal(adapter.bridge, null, "bridge 已关闭");
    if (adapter.root) assert.equal(fs.existsSync(adapter.root), false, "临时目录已删除");
    const caps = [...fx.proxy.capabilities.values()];
    assert.ok(caps.length > issued, "启动前已签发 capability");
    for (const cap of caps) assert.equal(cap.state, "REVOKED", "启动失败即撤销能力");
    // dispose 幂等：重复收尾不得改变结果形状。
    const again = await adapter.dispose();
    assert.equal(again.ok, true);
    assert.equal(again.exited, true);
  } finally { await fx.close(); }
});
