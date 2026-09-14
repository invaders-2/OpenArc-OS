/** D4-02A · Task Domain（状态机 / revision 并发 / event / 隔离 / 无自动 retry）。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createTaskFixture } from "./task-fixtures.mjs";
import { startFakeProvider } from "./model-fake-provider.mjs";

const require = createRequire(import.meta.url);
const domain = require("../electron/task-domain.cjs");
const { TaskService } = require("../electron/task-service.cjs");

const providers = [];
const f = await createTaskFixture();
after(async () => { for (const p of providers) { try { await p.close(); } catch { /* ignore */ } } f.close(); });

const A = f.ctx("admin", f.APPS.A);
const B_TASK = f.ctx("alice", f.APPS.A);

async function newModel(scope = "PERSONAL") {
  const fp = await startFakeProvider({ behavior: "success" });
  providers.push(fp);
  const p = f.modelService.createProvider({ context: A, displayName: "TaskFake", baseUrl: fp.baseUrl, scope, credentialSecret: "FAKE_PROVIDER_CRED_TASK_D4_02A" });
  assert.equal(p.ok, true, JSON.stringify(p));
  const m = f.modelService.createModel({ context: A, providerId: p.provider.providerId, remoteModelId: "fake-1", capabilities: ["chat"], scope });
  assert.equal(m.ok, true, JSON.stringify(m));
  return m.model.configId;
}
async function runningTask(goal = "do the thing") {
  const modelConfigId = await newModel();
  const c = f.taskService.createTask({ context: A, goal, modelConfigId, budgetSnapshot: { maxSteps: 8 }, permissionSnapshotRef: "perm_snap_1" });
  assert.equal(c.ok, true, JSON.stringify(c));
  const s = f.taskService.startTask({ context: A, taskId: c.task.taskId, expectedRevision: c.task.revision });
  assert.equal(s.ok, true, JSON.stringify(s));
  return { task: s.task, modelConfigId };
}

test("TD1 · createTask：PENDING / revision=1 / cancelRequested=false / task.created event", () => {
  const c = f.taskService.createTask({ context: A, goal: "hello", budgetSnapshot: { a: 1 }, permissionSnapshotRef: "p1" });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.task.status, "PENDING");
  assert.equal(c.task.revision, 1);
  assert.equal(c.task.cancelRequested, false);
  assert.equal(c.task.appId, f.APPS.A);
  assert.deepEqual(c.task.budgetSnapshot, { a: 1 });
  assert.equal(c.task.permissionSnapshotRef, "p1");
  assert.equal("sessionRef" in c.task, false, "safeTask 不得暴露 sessionRef");
  const e = f.taskService.getEvents({ context: A, taskId: c.task.taskId });
  assert.deepEqual(e.items.map((x) => x.eventType), ["task.created"]);
  assert.deepEqual(e.items.map((x) => x.sequence), [1]);
});

test("TD2 · startTask：PENDING→RUNNING，revision++，task.started event", () => {
  const c = f.taskService.createTask({ context: A, goal: "run" });
  const s = f.taskService.startTask({ context: A, taskId: c.task.taskId, expectedRevision: 1 });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.task.status, "RUNNING");
  assert.equal(s.task.revision, 2);
  assert.equal(typeof s.task.startedAt, "number");
  assert.deepEqual(f.taskService.getEvents({ context: A, taskId: c.task.taskId }).items.map((x) => x.eventType), ["task.created", "task.started"]);
});

test("TD3 · Step：create→start→complete；attempt=1 / maxAttempts=1", async () => {
  const { task } = await runningTask();
  const cs = f.taskService.createStep({ context: A, taskId: task.taskId, kind: "model", input: { promptRef: "x" }, expectedRevision: task.revision });
  assert.equal(cs.ok, true, JSON.stringify(cs));
  assert.equal(cs.step.status, "PENDING");
  assert.equal(cs.step.sequence, 1);
  assert.equal(cs.step.attempt, 1);
  assert.equal(cs.step.maxAttempts, 1);
  const ss = f.taskService.startStep({ context: A, taskId: task.taskId, stepId: cs.step.stepId, expectedRevision: cs.task.revision });
  assert.equal(ss.ok, true, JSON.stringify(ss));
  assert.equal(ss.step.status, "RUNNING");
  assert.equal(ss.task.currentStepId, cs.step.stepId);
  const done = f.taskService.completeStep({ context: A, taskId: task.taskId, stepId: cs.step.stepId, outputRef: "artifact://a1", expectedRevision: ss.task.revision });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.step.status, "SUCCEEDED");
  assert.equal(done.step.outputRef, "artifact://a1");
  assert.equal(done.task.currentStepId, null);
  const types = f.taskService.getEvents({ context: A, taskId: task.taskId }).items.map((x) => x.eventType);
  assert.deepEqual(types.slice(-3), ["step.created", "step.started", "step.succeeded"]);
});

test("TD4 · completeTask：RUNNING→SUCCEEDED；SUCCEEDED 后不可再 start", async () => {
  const { task } = await runningTask();
  const done = f.taskService.completeTask({ context: A, taskId: task.taskId, expectedRevision: task.revision });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.task.status, "SUCCEEDED");
  const again = f.taskService.startTask({ context: A, taskId: task.taskId, expectedRevision: done.task.revision });
  assert.equal(again.ok, false);
  assert.equal(again.error, "TASK_INVALID_STATE");
  const completeAgain = f.taskService.completeTask({ context: A, taskId: task.taskId, expectedRevision: done.task.revision });
  assert.equal(completeAgain.error, "TASK_INVALID_STATE");
});

test("TD5 · failTask：RUNNING→FAILED；FAILED 不可变 SUCCEEDED", async () => {
  const { task } = await runningTask();
  const failed = f.taskService.failTask({ context: A, taskId: task.taskId, errorCode: "PROVIDER_UNAVAILABLE", expectedRevision: task.revision });
  assert.equal(failed.ok, true, JSON.stringify(failed));
  assert.equal(failed.task.status, "FAILED");
  assert.equal(f.taskService.completeTask({ context: A, taskId: task.taskId, expectedRevision: failed.task.revision }).error, "TASK_INVALID_STATE");
  const events = f.taskService.getEvents({ context: A, taskId: task.taskId }).items;
  const last = events[events.length - 1];
  assert.equal(last.eventType, "task.failed");
  assert.equal(last.safePayload.errorCode, "PROVIDER_UNAVAILABLE");
});

test("TD6 · cancelTask：持久 cancelRequested + cancel_requested/cancelled 两个 event；重复 cancel 幂等", async () => {
  const { task } = await runningTask();
  const c1 = f.taskService.cancelTask({ context: A, taskId: task.taskId, expectedRevision: task.revision });
  assert.equal(c1.ok, true, JSON.stringify(c1));
  assert.equal(c1.task.status, "CANCELLED");
  assert.equal(c1.task.cancelRequested, true);
  const types = f.taskService.getEvents({ context: A, taskId: task.taskId }).items.map((x) => x.eventType);
  assert.deepEqual(types.slice(-2), ["task.cancel_requested", "task.cancelled"]);
  const c2 = f.taskService.cancelTask({ context: A, taskId: task.taskId, expectedRevision: c1.task.revision });
  assert.equal(c2.ok, true);
  assert.equal(c2.changed, false);
  assert.equal(f.taskStore.taskById(task.taskId).revision, c1.task.revision, "重复 cancel 不再 bump revision");
});

test("TD7 · invalid transitions 全部 DENY（显式 transition table）", async () => {
  const pending = f.taskService.createTask({ context: A, goal: "p" });
  assert.equal(f.taskService.completeTask({ context: A, taskId: pending.task.taskId, expectedRevision: 1 }).error, "TASK_INVALID_STATE");
  assert.equal(f.taskService.failTask({ context: A, taskId: pending.task.taskId, expectedRevision: 1 }).error, "TASK_INVALID_STATE");
  assert.equal(f.taskService.createStep({ context: A, taskId: pending.task.taskId, expectedRevision: 1 }).error, "TASK_INVALID_STATE");
  const cancelled = f.taskService.cancelTask({ context: A, taskId: pending.task.taskId, expectedRevision: 1 });
  assert.equal(cancelled.task.status, "CANCELLED");
  assert.equal(f.taskService.startTask({ context: A, taskId: pending.task.taskId, expectedRevision: cancelled.task.revision }).error, "TASK_CANCELLED");
  // transition table 本身
  assert.equal(domain.canTransitionTask("PENDING", "RUNNING"), true);
  for (const [from, to] of [["SUCCEEDED", "RUNNING"], ["FAILED", "SUCCEEDED"], ["CANCELLED", "RUNNING"]]) {
    assert.equal(domain.canTransitionTask(from, to), false, from + "→" + to);
  }
});

test("TD8 · revision concurrency：stale revision → TASK_REVISION_CONFLICT，state 不变", async () => {
  const { task } = await runningTask();
  const stale = task.revision;
  const first = f.taskService.createStep({ context: A, taskId: task.taskId, expectedRevision: stale });
  assert.equal(first.ok, true);
  const second = f.taskService.createStep({ context: A, taskId: task.taskId, expectedRevision: stale });
  assert.equal(second.ok, false);
  assert.equal(second.error, "TASK_REVISION_CONFLICT");
  assert.equal(second.current, first.task.revision);
  assert.equal(f.taskStore.stepsOfTask(task.taskId).length, 1, "冲突 mutation 不得留下副作用");
  // 缺少 expectedRevision → INVALID_INPUT（不允许 silent last-write-wins）
  assert.equal(f.taskService.startTask({ context: A, taskId: task.taskId }).error, "INVALID_INPUT");
});

test("TD9 · event sequence 严格递增；state 与 event 一致（无 event 的 mutation 不存在）", async () => {
  const { task } = await runningTask();
  const cs = f.taskService.createStep({ context: A, taskId: task.taskId, kind: "model", expectedRevision: task.revision });
  const ss = f.taskService.startStep({ context: A, taskId: task.taskId, stepId: cs.step.stepId, expectedRevision: cs.task.revision });
  f.taskService.completeStep({ context: A, taskId: task.taskId, stepId: cs.step.stepId, expectedRevision: ss.task.revision });
  const events = f.taskService.getEvents({ context: A, taskId: task.taskId }).items;
  for (let i = 0; i < events.length; i += 1) assert.equal(events[i].sequence, i + 1);
  const types = events.map((x) => x.eventType);
  assert.deepEqual(types, ["task.created", "task.started", "step.created", "step.started", "step.succeeded"]);
  // 非法 transition 不产生 event、不 bump revision
  const before = f.taskStore.taskById(task.taskId).revision;
  const beforeEvents = f.taskStore.eventsOfTask(task.taskId).length;
  assert.equal(f.taskService.completeTask({ context: A, taskId: task.taskId, expectedRevision: before - 1 }).error, "TASK_REVISION_CONFLICT");
  assert.equal(f.taskStore.taskById(task.taskId).revision, before);
  assert.equal(f.taskStore.eventsOfTask(task.taskId).length, beforeEvents);
});

test("TD10 · User isolation：User B 对 A 的 Task get/list/start/cancel 全部 DENY", async () => {
  const { task } = await runningTask();
  assert.equal(f.taskService.getTask({ context: B_TASK, taskId: task.taskId }).error, "TASK_FORBIDDEN");
  assert.equal(f.taskService.startTask({ context: B_TASK, taskId: task.taskId, expectedRevision: task.revision }).error, "TASK_FORBIDDEN");
  assert.equal(f.taskService.cancelTask({ context: B_TASK, taskId: task.taskId, expectedRevision: task.revision }).error, "TASK_FORBIDDEN");
  assert.equal(f.taskService.getEvents({ context: B_TASK, taskId: task.taskId }).error, "TASK_FORBIDDEN");
  const list = f.taskService.listTasks({ context: B_TASK });
  assert.equal(list.ok, true);
  assert.equal(list.items.some((x) => x.taskId === task.taskId), false);
});

test("TD11 · App isolation：同 User 的另一 App 不能接管该 Task", async () => {
  const { task } = await runningTask();
  const appB = f.ctx("admin", f.APPS.B);
  assert.equal(f.taskService.getTask({ context: appB, taskId: task.taskId }).error, "TASK_FORBIDDEN");
  assert.equal(f.taskService.startTask({ context: appB, taskId: task.taskId, expectedRevision: task.revision }).error, "TASK_FORBIDDEN");
  const list = f.taskService.listTasks({ context: appB });
  assert.equal(list.items.some((x) => x.taskId === task.taskId), false, "App B 的 list 不得包含 App A 的 Task");
});

test("TD12 · 不可信 context / disabled App 一律拒绝", async () => {
  assert.equal(f.taskService.createTask({ context: { sessionRef: "sess_not_real", appId: f.APPS.A }, goal: "x" }).error, "TASK_FORBIDDEN");
  assert.equal(f.taskService.createTask({ context: { appId: f.APPS.A }, goal: "x" }).error, "TASK_FORBIDDEN");
  f.store.upsertApp({ appId: "disabled-app", name: "d", publisher: "t", status: "disabled", builtIn: 0 });
  assert.equal(f.taskService.createTask({ context: { sessionRef: f.sessions.admin, appId: "disabled-app" }, goal: "x" }).error, "TASK_FORBIDDEN");
});

test("TD13 · ModelCall：start→complete 只落一条 call；fail 不自动 retry（AUTO_RETRY=0）", async () => {
  const { task } = await runningTask();
  const start = f.taskService.startModelCall({ context: A, taskId: task.taskId, requestId: "mreq_1", expectedRevision: task.revision });
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal(start.call.status, "STARTED");
  assert.equal(start.call.modelConfigVersion, f.modelStore.configById(task.modelConfigId).version);
  const done = f.taskService.completeModelCall({ context: A, taskId: task.taskId, callId: start.call.callId, usage: { totalTokens: 7 }, expectedRevision: start.task.revision });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.call.status, "SUCCEEDED");
  assert.deepEqual(done.call.usage, { totalTokens: 7 });
  assert.equal(f.taskStore.callsOfTask(task.taskId).length, 1);
  const types = f.taskService.getEvents({ context: A, taskId: task.taskId }).items.map((x) => x.eventType);
  assert.deepEqual(types.slice(-2), ["model.call.started", "model.call.completed"]);
  // fail 路径不创建新 call
  const { task: t2 } = await runningTask();
  const s2 = f.taskService.startModelCall({ context: A, taskId: t2.taskId, expectedRevision: t2.revision });
  const failedCall = f.taskService.failModelCall({ context: A, taskId: t2.taskId, callId: s2.call.callId, providerErrorCode: "PROVIDER_UNAVAILABLE", expectedRevision: s2.task.revision });
  assert.equal(failedCall.ok, true);
  assert.equal(failedCall.call.status, "FAILED");
  assert.equal(f.taskStore.callsOfTask(t2.taskId).length, 1, "失败不得自动重试（不得出现第二条 call）");
});

test("TD14 · 冻结策略 / 错误码 / event 类型 / DB 无第二权限系统", () => {
  assert.equal(TaskService.policy.autoRetry, 0);
  assert.equal(TaskService.policy.defaultMaxAttempts, 1);
  assert.equal(TaskService.policy.toolExecution, "FORBIDDEN");
  for (const code of ["TASK_NOT_FOUND", "TASK_FORBIDDEN", "TASK_INVALID_STATE", "TASK_REVISION_CONFLICT", "TASK_CANCELLED", "MODEL_CONFIG_CHANGED", "RECOVERY_REQUIRED"]) {
    assert.equal(domain.ERROR[code], code);
  }
  const tables = f.identity.connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.equal(tables.some((t) => /task_acl|task_role|task_permissions/.test(t)), false, "禁止第二套 Task 权限系统");
  // event payload 脱敏：敏感 key 打码
  const sanitized = domain.sanitizeEventPayload({ authorization: "Bearer abc", nested: { secret: "x" }, ok: 1 });
  assert.equal(sanitized.authorization, "[REDACTED]");
  assert.equal(sanitized.nested.secret, "[REDACTED]");
  assert.equal(sanitized.ok, 1);
});

test("TD15 · DB 不含 raw secret / Authorization（Task 层只存安全 metadata）", () => {
  const dump = JSON.stringify(f.taskStore.allTasks()) + JSON.stringify(f.taskStore.eventsOfTask(f.taskStore.allTasks()[0]?.task_id || ""));
  assert.equal(/Bearer\s/.test(dump), false);
  assert.equal(dump.includes("FAKE_PROVIDER_CRED_TASK_D4_02A"), false);
});
