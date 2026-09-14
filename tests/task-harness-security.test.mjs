/** D4-02C · Security：Provider Secret / capability 0 forbidden persistence；User/App/Artifact isolation；执行绑定。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createTaskHarnessFixture, EXACT, PROVIDER_SECRET } from "./fixtures/harness-acp/task-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { HarnessModelAdapter } = require("../electron/harness-model-adapter.cjs");

const TABLES = ["tasks", "task_steps", "task_model_calls", "task_events", "task_harness_runs", "task_artifacts", "task_verifications"];
function dumpTaskDb(identity) {
  let text = "";
  for (const table of TABLES) {
    try { for (const row of identity.connection.prepare("SELECT * FROM " + table).all()) text += JSON.stringify(row) + "\n"; } catch { /* ignore */ }
  }
  return text;
}

test("Provider Secret / proxy capability 0 forbidden persistence（Task DB / Event / Artifact）", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "exact" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const r = await fx.orchestrator.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(fx.fp.state.authHeaders[0], "Bearer " + PROVIDER_SECRET);
    const dump = dumpTaskDb(fx.f.identity);
    assert.ok(!dump.includes(PROVIDER_SECRET), "Provider Secret 不得落 Task DB");
    assert.ok(!dump.includes("mpx_"), "proxy capability token 不得落库");
    for (const token of fx.proxy.capabilities.keys()) assert.ok(!dump.includes(token), "capability 不得落库");
    const events = fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).items;
    assert.ok(!JSON.stringify(events).includes(PROVIDER_SECRET));
  } finally { await fx.close(); }
});

test("User / App / Artifact isolation：非 owner 或非 owner App 不能 run / read", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "exact" });
  try {
    const admin = fx.ctx();
    const t = fx.createTask();
    const ok = await fx.orchestrator.runTask({ context: admin, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    assert.ok(ok.ok, JSON.stringify(ok));

    const alice = { sessionRef: fx.f.sessions.alice, appId: "ai", source: "test" };
    const bob = { sessionRef: fx.f.sessions.bob, appId: "ai", source: "test" };
    const canvas = fx.ctx("admin", "canvas");
    for (const ctx of [alice, bob, canvas]) {
      assert.equal(fx.taskService.getTask({ context: ctx, taskId: t.task.taskId }).error, "TASK_FORBIDDEN");
      assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).error, "TASK_FORBIDDEN");
      assert.equal(fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).error, "TASK_FORBIDDEN");
      assert.equal(fx.taskService.getHarnessRuns({ context: ctx, taskId: t.task.taskId }).error, "TASK_FORBIDDEN");
      const rr = await fx.orchestrator.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: 1 });
      assert.equal(rr.error, "TASK_FORBIDDEN");
      const cr = await fx.orchestrator.cancel({ context: ctx, taskId: t.task.taskId, expectedRevision: 1 });
      assert.equal(cr.error, "TASK_FORBIDDEN");
    }
    assert.equal(fx.taskService.getArtifacts({ context: admin, taskId: t.task.taskId }).items.length, 1);
  } finally { await fx.close(); }
});

test("capability 执行绑定：run A 的 token 不能用于 run B（401），绑定含 task/step/run", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const ctx = fx.ctx();
    const capA = fx.proxy.issueCapability({ context: ctx, configId: fx.modelConfigId, maxCalls: 2, binding: { taskId: "taskA", stepId: "stepA", runId: "runA" } });
    const capB = fx.proxy.issueCapability({ context: ctx, configId: fx.modelConfigId, maxCalls: 2, binding: { taskId: "taskB", stepId: "stepB", runId: "runB" } });
    assert.ok(capA.ok && capB.ok, JSON.stringify({ capA, capB }));
    assert.deepEqual(capA.capability.executionBinding, { taskId: "taskA", stepId: "stepA", runId: "runA" });
    const bridgeB = new HarnessModelAdapter({ modelProxy: fx.proxy, expectedToken: capB.capability.token });
    await bridgeB.start();
    const post = (token) => fetch(bridgeB.baseUrl + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    const cross = await post(capA.capability.token);
    assert.equal(cross.status, 401, "run A token 不得用于 run B");
    const own = await post(capB.capability.token);
    assert.equal(own.status, 200);
    await bridgeB.stop();
  } finally { await fx.close(); }
});
