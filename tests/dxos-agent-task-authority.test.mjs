/**
 * P1 · 任务域单一写入口（task-authority）回归（全离线；不联网、不新增依赖）。
 *
 * 覆盖任务书第 2 条：
 *   · 路由正确性：core 走 TaskStore、dx 走 agent-task-store；
 *   · 校验：source / 入参 / core 迁移表 / dx 已知状态；
 *   · 审计：每条写操作留一条不可变记录，可选审计回调也收到；
 *   · 幂等：同一 (source, operation, key) 只执行一次，重复直接回放；
 *   · 错误码风格：全部结构化 code，调用方不解析 message。
 *
 * 真实依赖：IdentityStore（:memory:）+ TaskStore + agent-task-store。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createTaskFixture } from "./task-fixtures.mjs";

const require = createRequire(import.meta.url);
const agentTaskStore = require("../electron/agent-task-store.cjs");
const { createTaskAuthority, TASK_AUTHORITY_ERR, isTaskAuthorityError } = require("../electron/task-authority.cjs");

const USER = "u_authority";
const fixtures = [];
after(() => { for (const f of fixtures) { try { f.identity.close(); } catch { /* 已关闭 */ } } });

async function setup() {
  const f = await createTaskFixture({ dbPath: ":memory:" });
  fixtures.push(f);
  agentTaskStore.resetAgentTaskStoreForTests();
  agentTaskStore.configureAgentTaskStore({ db: f.identity.connection, clock: f.clock, idFactory: () => crypto.randomUUID() });
  const project = agentTaskStore.createProject({ name: "authority 项目", rootNodeId: "root_auth", createdBy: USER });
  const authority = createTaskAuthority({ coreStore: f.taskStore, dxStore: agentTaskStore, clock: f.clock });
  return { ...f, project, authority };
}

function codeIs(code) {
  return (error) => {
    assert.ok(isTaskAuthorityError(error), "必须是 TaskAuthorityError：" + String(error && error.message));
    assert.equal(error.code, code);
    return true;
  };
}

// ---------------------------------------------------------------------------
// 路由：core / dx
// ---------------------------------------------------------------------------

test("路由：core 任务经 authority 落 TaskStore，dx 任务经 authority 落 agent-task-store", async () => {
  const s = await setup();
  const coreTask = s.authority.createTask({ source: "core", input: { taskId: "core-auth-1", userId: USER, appId: "ai", status: "PENDING", goal: "core authority 任务" } });
  assert.equal(coreTask.task_id, "core-auth-1");
  assert.equal(s.taskStore.taskById("core-auth-1").goal, "core authority 任务");

  const dxTask = s.authority.createTask({
    source: "dx",
    input: { projectId: s.project.id, instruction: "写「auth.txt」", createdBy: USER, title: "dx authority 任务", executionProfile: "thinking", actions: [{ tool: "file.create", path: "auth.txt" }] },
  });
  assert.equal(dxTask.title, "dx authority 任务");
  assert.equal(dxTask.status, "queued");
  assert.equal(agentTaskStore.getTask(dxTask.id).id, dxTask.id);
  // 两套表的 id 命名空间独立：同名也能各落一条。
  const shared = "shared-id";
  s.authority.createTask({ source: "core", input: { taskId: shared, userId: USER, appId: "ai", status: "PENDING", goal: "core 同名" } });
  const dxShared = s.authority.createTask({ source: "dx", input: { projectId: s.project.id, instruction: "dx 同名", createdBy: USER, title: "dx 同名" } });
  assert.notEqual(dxShared.id, shared);
});

test("校验：source / 入参 / 状态非法一律结构化错误，不落任何数据", async () => {
  const s = await setup();
  assert.throws(() => s.authority.createTask({ source: "nope", input: {} }), codeIs(TASK_AUTHORITY_ERR.UNKNOWN_SOURCE));
  assert.throws(() => s.authority.createTask({ source: "core", input: { taskId: "x", userId: USER, appId: "ai", status: "NOT_A_STATUS", goal: "g" } }), codeIs(TASK_AUTHORITY_ERR.INVALID_INPUT));
  assert.throws(() => s.authority.createTask({ source: "core", input: { taskId: "x", userId: "", appId: "ai", goal: "g" } }), codeIs(TASK_AUTHORITY_ERR.INVALID_INPUT));
  assert.throws(() => s.authority.createTask({ source: "dx", input: { projectId: s.project.id } }), codeIs(TASK_AUTHORITY_ERR.INVALID_INPUT));
  assert.equal(s.taskStore.taskById("x"), null);
});

// ---------------------------------------------------------------------------
// 状态迁移：core 复用 task-domain 迁移表；dx 路由到 store 自带校验函数
// ---------------------------------------------------------------------------

test("core 迁移：PENDING→RUNNING 合法；PENDING→SUCCEEDED 非法；revision 递增", async () => {
  const s = await setup();
  s.authority.createTask({ source: "core", input: { taskId: "core-t1", userId: USER, appId: "ai", status: "PENDING", goal: "g1" } });
  s.authority.createTask({ source: "core", input: { taskId: "core-t2", userId: USER, appId: "ai", status: "PENDING", goal: "g2" } });
  assert.throws(
    () => s.authority.updateTaskStatus({ source: "core", taskId: "core-t2", to: "SUCCEEDED" }),
    (error) => {
      assert.equal(error.code, TASK_AUTHORITY_ERR.INVALID_TRANSITION);
      assert.equal(error.detail.from, "PENDING");
      assert.equal(error.detail.to, "SUCCEEDED");
      return true;
    },
  );
  assert.equal(s.taskStore.taskById("core-t2").status, "PENDING", "非法迁移不得落库");
  const running = s.authority.updateTaskStatus({ source: "core", taskId: "core-t1", to: "RUNNING" });
  assert.equal(running.status, "RUNNING");
  assert.equal(running.revision, 2);
  const done = s.authority.updateTaskStatus({ source: "core", taskId: "core-t1", to: "SUCCEEDED", extras: { completed_at: 12345 } });
  assert.equal(done.status, "SUCCEEDED");
  assert.equal(done.completed_at, 12345);
  assert.throws(() => s.authority.updateTaskStatus({ source: "core", taskId: "missing", to: "RUNNING" }), codeIs(TASK_AUTHORITY_ERR.TASK_NOT_FOUND));
});

test("dx 迁移：paused / queued / cancelled 路由到 store 的生命周期函数，非法状态拒绝", async () => {
  const s = await setup();
  const task = s.authority.createTask({ source: "dx", input: { projectId: s.project.id, instruction: "暂停恢复取消", createdBy: USER, title: "dx 生命周期" } });
  assert.equal(agentTaskStore.getTask(task.id).status, "queued");
  s.authority.updateTaskStatus({ source: "dx", taskId: task.id, to: "paused" });
  assert.equal(agentTaskStore.getTask(task.id).status, "paused");
  s.authority.updateTaskStatus({ source: "dx", taskId: task.id, to: "queued" });
  assert.equal(agentTaskStore.getTask(task.id).status, "queued");
  s.authority.updateTaskStatus({ source: "dx", taskId: task.id, to: "cancelled" });
  assert.equal(agentTaskStore.getTask(task.id).status, "cancelled");
  assert.throws(() => s.authority.updateTaskStatus({ source: "dx", taskId: task.id, to: "mystery" }), codeIs(TASK_AUTHORITY_ERR.INVALID_INPUT));
});

// ---------------------------------------------------------------------------
// 事件 / 步骤 / 步骤产物写回
// ---------------------------------------------------------------------------

test("事件：两套 store 各自落库；步骤：core 走 insertStep、dx 走 appendDynamicStep", async () => {
  const s = await setup();
  s.authority.createTask({ source: "core", input: { taskId: "core-e1", userId: USER, appId: "ai", status: "PENDING", goal: "g" } });
  s.authority.appendEvent({ source: "core", taskId: "core-e1", eventType: "task.started", payload: { message: "core 事件" } });
  assert.equal(s.taskStore.eventsOfTask("core-e1").filter((event) => event.event_type === "task.started").length, 1);

  const dxTask = s.authority.createTask({ source: "dx", input: { projectId: s.project.id, instruction: "事件", createdBy: USER, title: "dx 事件" } });
  s.authority.appendEvent({ source: "dx", taskId: dxTask.id, eventType: "authority.test", message: "dx 事件", payload: { n: 1 } });
  assert.equal(agentTaskStore.listTaskEvents(dxTask.id, 0).filter((event) => event.type === "authority.test").length, 1);

  const coreStep = s.authority.appendStep({ source: "core", taskId: "core-e1", status: "RUNNING", step: { kind: "model", input: { prompt: "hi" } } });
  assert.equal(coreStep.status, "RUNNING");
  assert.equal(s.taskStore.stepById(coreStep.step_id).kind, "model");

  const dxStep = s.authority.appendStep({ source: "dx", taskId: dxTask.id, title: "写 auth.txt", toolName: "file.write", args: { path: "auth.txt" }, stableOperationId: "auth-op-1" });
  assert.ok(dxStep.id);
  assert.equal(agentTaskStore.getTask(dxTask.id).steps.find((step) => step.id === dxStep.id).tool_name, "file.write");
});

test("步骤产物写回：dx 写 output_json、core 写 output_ref；目标不存在必须报错", async () => {
  const s = await setup();
  s.authority.createTask({ source: "core", input: { taskId: "core-w1", userId: USER, appId: "ai", status: "PENDING", goal: "g" } });
  const coreStep = s.authority.appendStep({ source: "core", taskId: "core-w1", status: "RUNNING", step: { kind: "model", input: {} } });
  assert.equal(s.authority.writeStepOutput({ source: "core", taskId: "core-w1", stepId: coreStep.step_id, output: { nodeId: "node-core" } }), true);
  assert.deepEqual(JSON.parse(s.taskStore.stepById(coreStep.step_id).output_ref), { nodeId: "node-core" });

  const dxTask = s.authority.createTask({
    source: "dx",
    input: { projectId: s.project.id, instruction: "产物", createdBy: USER, title: "dx 产物", actions: [{ tool: "file.create", path: "artifact.txt" }] },
  });
  const dxStep = agentTaskStore.getTask(dxTask.id).steps[0];
  assert.equal(s.authority.writeStepOutput({ source: "dx", taskId: dxTask.id, stepId: dxStep.id, output: { nodeId: "node-dx", name: "artifact.txt" } }), true);
  assert.deepEqual(JSON.parse(agentTaskStore.getTask(dxTask.id).steps[0].output_json), { nodeId: "node-dx", name: "artifact.txt" });

  assert.throws(() => s.authority.writeStepOutput({ source: "dx", taskId: dxTask.id, stepId: "no-such-step", output: {} }), codeIs(TASK_AUTHORITY_ERR.STEP_NOT_FOUND));
  assert.throws(() => s.authority.writeStepOutput({ source: "core", taskId: "core-w1", stepId: "no-such-step", output: {} }), codeIs(TASK_AUTHORITY_ERR.STEP_NOT_FOUND));
});

// ---------------------------------------------------------------------------
// 审计 / 幂等 / 依赖
// ---------------------------------------------------------------------------

test("审计：每次写留一条记录，注入的 audit 回调也能收到", async () => {
  const s = await setup();
  const seen = [];
  const authority = createTaskAuthority({ coreStore: s.taskStore, dxStore: agentTaskStore, clock: s.clock, audit: (record) => seen.push(record) });
  s.authority.createTask({ source: "core", input: { taskId: "core-a1", userId: USER, appId: "ai", status: "PENDING", goal: "g" } });
  authority.appendEvent({ source: "core", taskId: "core-a1", eventType: "task.started" });
  const records = authority.auditLog();
  assert.equal(records.length, 1);
  assert.equal(records[0].source, "core");
  assert.equal(records[0].operation, "appendEvent");
  assert.equal(records[0].outcome, "accepted");
  assert.equal(records[0].targetId, "core-a1");
  assert.equal(typeof records[0].at, "number");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], records[0]);
  assert.ok(Object.isFrozen(records[0]), "审计记录必须不可变");
});

test("幂等：同一 key 只落一条事件；重复调用回放首次结果并留 duplicate 审计", async () => {
  const s = await setup();
  const dxTask = s.authority.createTask({ source: "dx", input: { projectId: s.project.id, instruction: "幂等", createdBy: USER, title: "dx 幂等" } });
  const before = agentTaskStore.listTaskEvents(dxTask.id, 0).length;
  const first = s.authority.appendEvent({ source: "dx", taskId: dxTask.id, eventType: "authority.idem", message: "一次", idempotencyKey: "key-1" });
  const second = s.authority.appendEvent({ source: "dx", taskId: dxTask.id, eventType: "authority.idem", message: "一次", idempotencyKey: "key-1" });
  assert.equal(second, first, "重复调用必须回放同一个结果");
  assert.equal(agentTaskStore.listTaskEvents(dxTask.id, 0).length, before + 1, "幂等键不得二次落库");
  assert.ok(s.authority.auditLog().some((record) => record.operation === "appendEvent" && record.outcome === "duplicate"), "重复调用必须留 duplicate 审计");
  assert.equal(s.authority.idempotencySize(), 1);
});

test("依赖：未注入 coreStore 时 core 操作结构化 DEPENDENCY_UNAVAILABLE，dx 不受影响", async () => {
  const s = await setup();
  const noCore = createTaskAuthority({ dxStore: agentTaskStore, clock: s.clock });
  assert.throws(() => noCore.createTask({ source: "core", input: { taskId: "x", userId: USER, appId: "ai", goal: "g" } }), codeIs(TASK_AUTHORITY_ERR.DEPENDENCY_UNAVAILABLE));
  assert.throws(() => noCore.updateTaskStatus({ source: "core", taskId: "x", to: "RUNNING" }), codeIs(TASK_AUTHORITY_ERR.DEPENDENCY_UNAVAILABLE));
  const dxTask = noCore.createTask({ source: "dx", input: { projectId: s.project.id, instruction: "无 core 也能建 dx", createdBy: USER, title: "dx only" } });
  assert.ok(dxTask.id);
});
