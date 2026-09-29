/** D4-02C · Cancel：用户取消 → ACP cancel → Provider abort → capability revoke → Step/Task CANCELLED；Cancel Race。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createTaskHarnessFixture, EXACT } from "./fixtures/harness-acp/task-harness-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等待上界 = **产品自己的启动预算**（orchestrator DEFAULT_START_TIMEOUT_MS=30000）+ 余量。
 * 原实现的固定 20s 魔数窗在满载时会先于 harness 启动完成到期：cancel 先落地、请求从未发起，
 * 断言退化成 "0 !== 1"（W49 实测 1/5，duration 51723ms）。
 */
const PRODUCT_START_TIMEOUT_MS = 30000;
const START_MARGIN_MS = 15000;
const WAIT_LIMIT_MS = PRODUCT_START_TIMEOUT_MS + START_MARGIN_MS;
const PHASE_POLL_MS = 10;

/** 单调时钟阶段时间线：相对 t0 的毫秒，绝不用墙钟（不受系统时间调整影响）。 */
function makeTimeline() {
  const t0 = process.hrtime.bigint();
  const marks = [];
  const at = () => Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    mark(name, detail = null) { const m = { name, detail, atMs: at() }; marks.push(m); return m; },
    get elapsedMs() { return at(); },
    format() { return marks.map((m) => "+" + m.atMs.toFixed(1) + "ms " + m.name + (m.detail == null ? "" : " " + m.detail)).join(" | "); },
  };
}

/** 失败诊断的宿主负载快照：最简指标，取不到就是 null，绝不因此再失败一次。 */
function hostLoadSnapshot() {
  let processCount = null;
  try {
    const out = execFileSync("/bin/ps", ["-axo", "pid="], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
    processCount = out.split("\n").filter((l) => l.trim()).length;
  } catch { processCount = null; }
  return {
    loadavg: os.loadavg().map((v) => Number(v.toFixed(2))),
    cpuCount: os.cpus().length,
    processCount,
    freeMemMB: Math.round(os.freemem() / 1048576),
    totalMemMB: Math.round(os.totalmem() / 1048576),
  };
}

/** 真实 adapter 外包一层：只记录调用次数与单调时钟阶段，不改任何行为。 */
function instrumentFactory(baseFactory, tl, counter) {
  return (opts) => {
    const adapter = baseFactory(opts);
    counter.adapter = adapter;
    const start = adapter.start.bind(adapter);
    const prompt = adapter.prompt.bind(adapter);
    const cancel = adapter.cancel.bind(adapter);
    const code = (e) => String((e && e.code) || (e && e.message) || e);
    adapter.start = async (a) => {
      counter.starts += 1; tl.mark("adapter:start:begin");
      try { const r = await start(a); tl.mark("adapter:start:done"); return r; }
      catch (e) { tl.mark("adapter:start:error", code(e)); throw e; }
    };
    adapter.prompt = async (text, o) => {
      counter.prompts += 1; tl.mark("adapter:prompt:begin");
      try { const r = await prompt(text, o); tl.mark("adapter:prompt:done"); return r; }
      catch (e) { tl.mark("adapter:prompt:error", code(e)); throw e; }
    };
    adapter.cancel = async () => {
      tl.mark("adapter:cancel:begin");
      try { const r = await cancel(); tl.mark("adapter:cancel:done"); return r; }
      catch (e) { tl.mark("adapter:cancel:error", code(e)); throw e; }
    };
    return adapter;
  };
}

async function cancelWithRetry(fx, orch, ctx, taskId) {
  for (let i = 0; i < 30; i += 1) {
    const t = fx.taskService.getTask({ context: ctx, taskId });
    const r = await orch.cancel({ context: ctx, taskId, expectedRevision: t.task.revision });
    if (r.ok || r.error !== "TASK_REVISION_CONFLICT") return r;
    await sleep(10);
  }
  throw new Error("cancel retry exhausted");
}

/**
 * 等到**产品可观察**的「模型请求已发起」阶段；超上界或产品自己先收敛都算失败，
 * 但必须带阶段时间线 + 宿主负载 + 产品状态，绝不静默失败。
 */
async function waitForProviderRequest({ fx, ctx, taskId, tl, counter }) {
  const seen = { spawned: false, session: false, running: false };
  for (;;) {
    const elapsed = tl.elapsedMs;
    const adapter = counter.adapter;
    if (adapter && adapter.child && !seen.spawned) { seen.spawned = true; tl.mark("phase:child-spawned(observed)"); }
    if (adapter && adapter.sessionId && !seen.session) { seen.session = true; tl.mark("phase:session-created(observed)"); }
    if (fx.fp.state.requests >= 1) { tl.mark("phase:provider-request"); return { ok: true, elapsedMs: elapsed }; }
    const runs = fx.taskService.getHarnessRuns({ context: ctx, taskId });
    const items = runs.ok ? runs.items : [];
    const run = items.length ? items[items.length - 1] : null;
    if (run && run.status === "RUNNING" && !seen.running) { seen.running = true; tl.mark("phase:harness-running"); }
    const task = fx.taskService.getTask({ context: ctx, taskId });
    const taskView = task.ok ? task.task : null;
    if (run && ["BLOCKED", "CANCELLED", "FAILED"].includes(run.status)) {
      tl.mark("phase:run-terminal:" + run.status);
      return { ok: false, reason: "PRODUCT_CONVERGED_BEFORE_REQUEST", run, task: taskView, elapsedMs: elapsed };
    }
    if (elapsed >= WAIT_LIMIT_MS) {
      tl.mark("phase:wait-limit");
      return { ok: false, reason: "WAIT_LIMIT", run, task: taskView, elapsedMs: elapsed };
    }
    await sleep(PHASE_POLL_MS);
  }
}

function failWithTimeline(tl, waited, extra = {}) {
  assert.fail([
    "等待可观察阶段失败：" + waited.reason,
    "上界 = 产品启动预算 " + PRODUCT_START_TIMEOUT_MS + "ms + 余量 " + START_MARGIN_MS + "ms = " + WAIT_LIMIT_MS + "ms；实际等待 " + tl.elapsedMs.toFixed(1) + "ms",
    "阶段时间线：" + tl.format(),
    "宿主负载：" + JSON.stringify(hostLoadSnapshot()),
    "产品状态：" + JSON.stringify(Object.assign({
      task: waited.task ? { status: waited.task.status, cancelRequested: waited.task.cancelRequested } : null,
      run: waited.run || null,
    }, extra)),
  ].join("\n"));
}

test("Cancel E2E：真实 slow provider → 用户取消 → 0 retry + capability revoked + CANCELLED", async (t) => {
  const fx = await createTaskHarnessFixture({ behavior: "slow" });
  const tl = makeTimeline();
  const counter = { starts: 0, prompts: 0, adapter: null };
  let orch = null;
  try {
    const ctx = fx.ctx();
    const task = fx.createTask();
    orch = fx.makeOrchestrator(instrumentFactory(fx.realAgentFactory(), tl, counter));
    tl.mark("run:dispatch");
    const runPromise = orch.runTask({ context: ctx, taskId: task.task.taskId, expectedRevision: task.task.revision });
    const waited = await waitForProviderRequest({ fx, ctx, taskId: task.task.taskId, tl, counter });
    if (!waited.ok) failWithTimeline(tl, waited, { stage: "wait-provider-request" });

    tl.mark("cancel:begin");
    const c = await cancelWithRetry(fx, orch, ctx, task.task.taskId);
    tl.mark("cancel:done");
    assert.ok(c.ok, JSON.stringify(c));
    const r = await runPromise;
    tl.mark("run:converged", String((r && r.error) || ""));
    assert.equal(r.ok, false);
    assert.ok(r.cancelled || r.error === "HARNESS_CANCELLED" || r.error === "TASK_CANCELLED", JSON.stringify(r));

    const got = fx.taskService.getTask({ context: ctx, taskId: task.task.taskId });
    assert.equal(got.task.status, "CANCELLED");
    assert.equal(got.task.cancelRequested, true);
    const steps = fx.taskService.getSteps({ context: ctx, taskId: task.task.taskId });
    assert.equal(steps.items[0].status, "CANCELLED");
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: task.task.taskId }).items.length, 0);

    // provider 连接关闭有自己的 5s 窗口（slow provider 的响应延迟），与 harness 启动预算无关。
    const deadline2 = Date.now() + 5000;
    while (fx.fp.state.closed < 1 && Date.now() < deadline2) await sleep(20);
    assert.ok(fx.fp.state.closed >= 1, "Provider 连接被 abort");
    assert.equal(fx.fp.state.requests, 1, "0 retry");

    const runs = fx.taskService.getHarnessRuns({ context: ctx, taskId: task.task.taskId });
    assert.equal(runs.items[0].status, "CANCELLED");
    for (const cap of fx.proxy.capabilities.values()) assert.equal(cap.state, "REVOKED", "capability 立即 revoke");
    if (process.env.OPENARC_PHASE_TIMELINE === "1") t.diagnostic("成功时间线：" + tl.format());
  } finally { tl.mark("exit"); try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});

test("Cancel Race：cancel 先行 → 绝不 Task CANCELLED + Step SUCCEEDED", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    let release;
    const gate = new Promise((r) => { release = r; });
    let promptEntered = false;
    const factory = ({ modelConfigVersion }) => ({
      async start() { return { capabilityId: "mcap_race", modelConfigVersion, dshVersion: "stub", sdkVersion: "0", protocolVersion: 1 }; },
      async prompt() { promptEntered = true; await gate; return { ok: true, stopReason: "end_turn", text: EXACT, events: [{ type: "text.delta", text: EXACT }] }; },
      async cancel() {}, revokeModelCapability() {}, async dispose() {},
    });
    const orch = fx.makeOrchestrator(factory);
    const runPromise = orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    const deadline = Date.now() + 5000;
    while (!promptEntered && Date.now() < deadline) await sleep(5);
    assert.ok(promptEntered, "prompt 已开始");
    // cancel 先行：持久 cancel_requested=1，然后 release 让 turn 完成，二者竞争
    const c = await cancelWithRetry(fx, orch, ctx, t.task.taskId);
    assert.ok(c.ok, JSON.stringify(c));
    release();
    const r = await runPromise;
    const task = fx.taskService.getTask({ context: ctx, taskId: t.task.taskId });
    const step = fx.taskService.getSteps({ context: ctx, taskId: t.task.taskId }).items[0];
    if (task.task.status === "SUCCEEDED") assert.equal(step.status, "SUCCEEDED");
    else assert.equal(task.task.status, "CANCELLED");
    assert.ok(!(task.task.status === "CANCELLED" && step.status === "SUCCEEDED"), "矛盾终态禁止");
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0);
    void r;
  } finally { await fx.close(); }
});

test("Cancel 后不存在 Provider retry：abort 只发生一次", async (t) => {
  const fx = await createTaskHarnessFixture({ behavior: "slow" });
  const tl = makeTimeline();
  const counter = { starts: 0, prompts: 0, adapter: null };
  let orch = null;
  try {
    const ctx = fx.ctx();
    const task = fx.createTask();
    orch = fx.makeOrchestrator(instrumentFactory(fx.realAgentFactory(), tl, counter));
    tl.mark("run:dispatch");
    const runPromise = orch.runTask({ context: ctx, taskId: task.task.taskId, expectedRevision: task.task.revision });
    // 旧实现：固定 20s 窗轮询；超窗后**没等任何阶段**就继续 cancel，最终断言 0 !== 1。
    const waited = await waitForProviderRequest({ fx, ctx, taskId: task.task.taskId, tl, counter });
    if (!waited.ok) failWithTimeline(tl, waited, { stage: "wait-provider-request" });

    tl.mark("cancel:begin");
    const c = await cancelWithRetry(fx, orch, ctx, task.task.taskId);
    tl.mark("cancel:done");
    assert.ok(c.ok, JSON.stringify(c));
    await runPromise;
    tl.mark("run:converged");
    await sleep(300);
    tl.mark("settle:300ms");
    assert.equal(fx.fp.state.requests, 1, "恰好 1 次 provider 请求（0 retry）");
    assert.equal(fx.taskService.getCalls({ context: ctx, taskId: task.task.taskId }).items.length, 1, "0 retry / 0 二次 call");
    if (process.env.OPENARC_PHASE_TIMELINE === "1") t.diagnostic("成功时间线：" + tl.format());
  } finally { tl.mark("exit"); try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});
