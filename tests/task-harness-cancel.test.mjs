/** D4-02C · Cancel：用户取消 → ACP cancel → Provider abort → capability revoke → Step/Task CANCELLED；Cancel Race。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskHarnessFixture, EXACT } from "./fixtures/harness-acp/task-harness-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cancelWithRetry(fx, orch, ctx, taskId) {
  for (let i = 0; i < 30; i += 1) {
    const t = fx.taskService.getTask({ context: ctx, taskId });
    const r = await orch.cancel({ context: ctx, taskId, expectedRevision: t.task.revision });
    if (r.ok || r.error !== "TASK_REVISION_CONFLICT") return r;
    await sleep(10);
  }
  throw new Error("cancel retry exhausted");
}

test("Cancel E2E：真实 slow provider → 用户取消 → 0 retry + capability revoked + CANCELLED", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "slow" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const runPromise = fx.orchestrator.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const deadline = Date.now() + 20000;
    while (fx.fp.state.requests < 1 && Date.now() < deadline) await sleep(25);
    assert.ok(fx.fp.state.requests >= 1, "provider 已被请求");
    const c = await cancelWithRetry(fx, fx.orchestrator, ctx, t.task.taskId);
    assert.ok(c.ok, JSON.stringify(c));
    const r = await runPromise;
    assert.equal(r.ok, false);
    assert.ok(r.cancelled || r.error === "HARNESS_CANCELLED" || r.error === "TASK_CANCELLED", JSON.stringify(r));

    const task = fx.taskService.getTask({ context: ctx, taskId: t.task.taskId });
    assert.equal(task.task.status, "CANCELLED");
    assert.equal(task.task.cancelRequested, true);
    const steps = fx.taskService.getSteps({ context: ctx, taskId: t.task.taskId });
    assert.equal(steps.items[0].status, "CANCELLED");
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0);

    const deadline2 = Date.now() + 5000;
    while (fx.fp.state.closed < 1 && Date.now() < deadline2) await sleep(20);
    assert.ok(fx.fp.state.closed >= 1, "Provider 连接被 abort");
    assert.equal(fx.fp.state.requests, 1, "0 retry");

    const runs = fx.taskService.getHarnessRuns({ context: ctx, taskId: t.task.taskId });
    assert.equal(runs.items[0].status, "CANCELLED");
    for (const cap of fx.proxy.capabilities.values()) assert.equal(cap.state, "REVOKED", "capability 立即 revoke");
  } finally { await fx.close(); }
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

test("Cancel 后不存在 Provider retry：abort 只发生一次", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "slow" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const runPromise = fx.orchestrator.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const deadline = Date.now() + 20000;
    while (fx.fp.state.requests < 1 && Date.now() < deadline) await sleep(25);
    const c = await cancelWithRetry(fx, fx.orchestrator, ctx, t.task.taskId);
    assert.ok(c.ok, JSON.stringify(c));
    await runPromise;
    await sleep(300);
    assert.equal(fx.fp.state.requests, 1);
    assert.equal(fx.taskService.getCalls({ context: ctx, taskId: t.task.taskId }).items.length, 1, "0 retry / 0 二次 call");
  } finally { await fx.close(); }
});
