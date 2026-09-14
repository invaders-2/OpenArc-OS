/** D4-02A · Restart recovery：RUNNING Task/Step 不得自动重放，一律 BLOCKED + RECOVERY_REQUIRED。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createTaskFixture, reopenTaskRuntime } from "./task-fixtures.mjs";
import { tempDbPath } from "./authorization-fixtures.mjs";
import { startFakeProvider } from "./model-fake-provider.mjs";

const providers = [];
const cleanup = [];
process.on("exit", () => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
after(async () => { for (const p of providers) { try { await p.close(); } catch { /* ignore */ } } });

async function mkModel(f, ctx) {
  const fp = await startFakeProvider({ behavior: "success" });
  providers.push(fp);
  const p = f.modelService.createProvider({ context: ctx, displayName: "RecFake", baseUrl: fp.baseUrl, credentialSecret: "FAKE_PROVIDER_CRED_TASK_REC" });
  const m = f.modelService.createModel({ context: ctx, providerId: p.provider.providerId, remoteModelId: "fake-1", capabilities: ["chat"] });
  return m.model.configId;
}

test("TR1 · RUNNING task + RUNNING step + 进程重启 → BLOCKED / RECOVERY_REQUIRED，0 replay / 0 retry", async () => {
  const { dir, dbPath } = tempDbPath("oa-d4-02a-recovery");
  cleanup.push(dir);
  const f = await createTaskFixture({ dbPath });
  cleanup.push(f.storeRoot, f.sourceDir);
  const A = f.ctx("admin", "ai");
  const modelConfigId = await mkModel(f, A);
  const c = f.taskService.createTask({ context: A, goal: "recover me", modelConfigId });
  const s = f.taskService.startTask({ context: A, taskId: c.task.taskId, expectedRevision: c.task.revision });
  const cs = f.taskService.createStep({ context: A, taskId: c.task.taskId, kind: "model", expectedRevision: s.task.revision });
  const ss = f.taskService.startStep({ context: A, taskId: c.task.taskId, stepId: cs.step.stepId, expectedRevision: cs.task.revision });
  const revisionBefore = ss.task.revision;
  const callsBefore = f.taskStore.callsOfTask(c.task.taskId).length;
  f.identity.close();

  const rt = reopenTaskRuntime({ dbPath, clock: f.clock });
  try {
    const ctx2 = { sessionRef: f.sessions.admin, appId: "ai" };
    // 直接重开时：Task 仍是 RUNNING（recovery 尚未执行）
    assert.equal(rt.taskService.getTask({ context: ctx2, taskId: c.task.taskId }).task.status, "RUNNING");
    const rec = rt.taskService.recoverRunning();
    assert.equal(rec.ok, true);
    assert.equal(rec.recovered, 1);
    assert.deepEqual(rec.taskIds, [c.task.taskId]);

    const task = rt.taskService.getTask({ context: ctx2, taskId: c.task.taskId }).task;
    assert.equal(task.status, "BLOCKED");
    assert.equal(task.revision, revisionBefore + 1);
    assert.equal(task.cancelRequested, false);
    const step = rt.taskService.getSteps({ context: ctx2, taskId: c.task.taskId }).items[0];
    assert.equal(step.status, "BLOCKED");
    const events = rt.taskService.getEvents({ context: ctx2, taskId: c.task.taskId }).items;
    const types = events.map((x) => x.eventType);
    assert.ok(types.includes("step.recovery_blocked"), JSON.stringify(types));
    assert.ok(types.includes("task.recovery_blocked"), JSON.stringify(types));
    const recEvent = events.find((x) => x.eventType === "task.recovery_blocked");
    assert.equal(recEvent.safePayload.reason, "RECOVERY_REQUIRED");
    // 0 replay / 0 retry：不得出现新 call、不得自动继续执行
    assert.equal(rt.taskStore.callsOfTask(c.task.taskId).length, callsBefore);
    assert.equal(rt.taskStore.callsOfTask(c.task.taskId).length, 0);
    // recovery 幂等
    assert.equal(rt.taskService.recoverRunning().recovered, 0);
    // BLOCKED 是合法 fault state：可显式 resume（BLOCKED→RUNNING），但执行前不得静默跑
    const blocked = rt.taskService.getTask({ context: ctx2, taskId: c.task.taskId }).task;
    assert.equal(rt.taskService.startModelCall({ context: ctx2, taskId: c.task.taskId, expectedRevision: blocked.revision }).error, "TASK_INVALID_STATE");
    const resumed = rt.taskService.startTask({ context: ctx2, taskId: c.task.taskId, expectedRevision: blocked.revision });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.task.status, "RUNNING");
  } finally {
    rt.close();
  }
});

test("TR2 · task RUNNING 但 step 已 SUCCEEDED：只 block task，不动已完成的 step", async () => {
  const { dir, dbPath } = tempDbPath("oa-d4-02a-recovery2");
  cleanup.push(dir);
  const f = await createTaskFixture({ dbPath });
  cleanup.push(f.storeRoot, f.sourceDir);
  const A = f.ctx("admin", "ai");
  const modelConfigId = await mkModel(f, A);
  const c = f.taskService.createTask({ context: A, goal: "recover2", modelConfigId });
  const s = f.taskService.startTask({ context: A, taskId: c.task.taskId, expectedRevision: c.task.revision });
  const cs = f.taskService.createStep({ context: A, taskId: c.task.taskId, kind: "model", expectedRevision: s.task.revision });
  const ss = f.taskService.startStep({ context: A, taskId: c.task.taskId, stepId: cs.step.stepId, expectedRevision: cs.task.revision });
  f.taskService.completeStep({ context: A, taskId: c.task.taskId, stepId: cs.step.stepId, expectedRevision: ss.task.revision });
  f.identity.close();

  const rt = reopenTaskRuntime({ dbPath, clock: f.clock });
  try {
    const ctx2 = { sessionRef: f.sessions.admin, appId: "ai" };
    assert.equal(rt.taskService.recoverRunning().recovered, 1);
    assert.equal(rt.taskService.getTask({ context: ctx2, taskId: c.task.taskId }).task.status, "BLOCKED");
    assert.equal(rt.taskService.getSteps({ context: ctx2, taskId: c.task.taskId }).items[0].status, "SUCCEEDED");
    const types = rt.taskService.getEvents({ context: ctx2, taskId: c.task.taskId }).items.map((x) => x.eventType);
    assert.equal(types.filter((t) => t === "step.recovery_blocked").length, 0);
    assert.equal(types.filter((t) => t === "task.recovery_blocked").length, 1);
  } finally {
    rt.close();
  }
});
