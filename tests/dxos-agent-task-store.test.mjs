/**
 * B3a · DX 任务域状态机与租约回归测试（agent-task-store.cjs）。
 *
 * 覆盖：11 态与非法转移、createTask→claim→heartbeat→complete 全链路、lease 过期恢复、
 * worker 注册/心跳/健康、budget 消耗与超限、计划/步骤/事件 sequence、检查点与
 * latestResumableAgentTurn 断点续跑、waitForUser/answerTask/continueTask、deliverables 与
 * observation upsert、pause/cancel/resume/delete、工具操作、项目权限映射、verifyTask 缺 fs
 * 适配器、项目快照。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const ats = require("../electron/agent-task-store.cjs");
const snapshot = require("../electron/agent-project-snapshot.cjs");

const dirs = [];
after(() => {
  ats.resetAgentTaskStoreForTests();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-b3a-store-"));
  dirs.push(dir);
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  let nowValue = 1700000000000;
  let seq = 0;
  ats.resetAgentTaskStoreForTests();
  ats.configureAgentTaskStore({ db: store.connection, clock: () => nowValue, idFactory: () => "id" + String(++seq).padStart(5, "0") });
  return {
    store,
    db: store.connection,
    now: () => nowValue,
    advance(ms) { nowValue += ms; },
    project(name) { return ats.createProject({ name: name || "项目", rootNodeId: "root_" + (++seq), createdBy: "u1" }); },
    close() { try { store.close(); } catch { /* 已关闭 */ } ats.resetAgentTaskStoreForTests(); },
  };
}

function createActionsTask(project, actions) {
  return ats.createTask({
    projectId: project.id,
    createdBy: "u1",
    instruction: "创建文件 a.txt",
    actions: actions || [{ tool: "file.create", path: "a.txt", content: "hi" }],
  });
}
function createReactTask(project, extra) {
  return ats.createTask(Object.assign({ projectId: project.id, createdBy: "u1", instruction: "思考并执行" }, extra || {}));
}
function runToVerified(fx, task) {
  const claimed = ats.claimNextTask("w1", 5000);
  const step = ats.nextQueuedStep(task.id);
  ats.startStep(task.id, step.id, "w1", claimed.lease_token);
  ats.completeStep(task.id, step.id, "w1", { nodeId: "n1", message: "ok" }, null, claimed.lease_token);
  ats.enterVerification(task.id, "w1", claimed.lease_token);
  ats.completeVerifiedTask(task.id, "w1", "done", claimed.lease_token);
  return { claimed, step };
}

function fakeFs(rootId) {
  const nodes = new Map();
  let seq = 0;
  nodes.set(rootId, { id: rootId, name: "root", type: "folder", parentId: null, content: "", trashed: false });
  return {
    nodes,
    createNode(input) {
      const id = "n" + (++seq);
      const node = { id, name: input.name, type: input.type, parentId: input.parentId || null, content: input.content || "", trashed: false };
      nodes.set(id, node);
      return node;
    },
    findByPath(dirId, name) {
      for (const node of nodes.values()) if (node.parentId === dirId && node.name === name) return node;
      return null;
    },
    getNode(id) { return nodes.get(id) || null; },
    setContent(id, content) { nodes.get(id).content = content; },
    isWithinRoot() { return true; },
  };
}

test("状态机：TaskStatus 恰为 11 态，非法转移被拒绝", () => {
  const fx = fixture();
  try {
    assert.deepEqual([...ats.TASK_STATUSES], ["queued", "planning", "running", "verifying", "completed", "waiting_user", "waiting_children", "paused", "interrupted", "failed", "cancelled"]);
    const project = fx.project();
    const actions = createActionsTask(project);
    assert.throws(() => ats.resumeTask(actions.id), /不能恢复/);
    assert.throws(() => ats.answerTask(actions.id, "u1", "答案"), /不在等待回答/);
    assert.throws(() => ats.continueTask(actions.id, "u1", "追加"), /固定步骤/);
    ats.pauseTask(actions.id);
    assert.throws(() => ats.pauseTask(actions.id), /不能暂停/);
    const react = createReactTask(project);
    ats.cancelTask(react.id);
    assert.equal(ats.getTask(react.id).status, "cancelled");
    assert.throws(() => ats.cancelTask(react.id), /不能取消/);
  } finally {
    fx.close();
  }
});

test("全链路：createTask → claim → heartbeat → start/complete step → verify → completed", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createActionsTask(project);
    assert.equal(task.status, "queued");
    assert.equal(task.mode, "actions");
    assert.equal(task.steps.length, 1);
    assert.equal(task.steps[0].ordinal, 1);
    assert.equal(task.steps[0].operation_id, task.id + ":1");
    assert.deepEqual(JSON.parse(task.plan.acceptance), ["完成 file.create a.txt"]);
    assert.equal(task.events[0].type, "task.created");

    const claimed = ats.claimNextTask("w1", 5000);
    assert.equal(claimed.id, task.id);
    assert.equal(claimed.status, "running");
    assert.equal(claimed.worker_id, "w1");
    assert.ok(claimed.lease_token);
    assert.equal(ats.taskIsRunning(task.id, "w1", claimed.lease_token), true);
    assert.equal(ats.heartbeatTask(task.id, "w1", 9000, claimed.lease_token), true);
    const attempt = fx.db.prepare("SELECT * FROM task_attempts WHERE task_id=?").get(task.id);
    assert.equal(attempt.status, "running");
    assert.equal(attempt.attempt_no, 1);

    const step = ats.nextQueuedStep(task.id);
    assert.equal(ats.startStep(task.id, step.id, "w1", claimed.lease_token), true);
    assert.equal(ats.getTask(task.id).current_step_id, step.id);
    assert.equal(ats.completeStep(task.id, step.id, "w1", { nodeId: "n1", message: "写好了" }, { projectId: project.id, nodeId: "n1", name: "a.txt" }, claimed.lease_token), true);
    assert.equal(ats.getTask(task.id).observations.length, 1);
    assert.equal(ats.getTask(task.id).deliverables.length, 1);
    assert.equal(ats.enterVerification(task.id, "w1", claimed.lease_token), true);
    assert.equal(ats.completeVerifiedTask(task.id, "w1", "全部完成", claimed.lease_token), true);
    const done = ats.getTask(task.id);
    assert.equal(done.status, "completed");
    assert.equal(done.result, "全部完成");
    assert.ok(done.completed_at);
    assert.equal(fx.db.prepare("SELECT verification_status FROM deliverables WHERE task_id=?").get(task.id).verification_status, "verified");
    const sequences = done.events.map((e) => e.sequence);
    assert.deepEqual(sequences, sequences.slice().sort((a, b) => a - b));
    assert.equal(new Set(sequences).size, sequences.length, "事件 sequence 必须唯一");
  } finally {
    fx.close();
  }
});

test("租约：过期 recoverExpiredTasks 置 interrupted、步骤回队、attempt 记 interrupted", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createActionsTask(project);
    const claimed = ats.claimNextTask("w1", 1000);
    const step = ats.nextQueuedStep(task.id);
    ats.startStep(task.id, step.id, "w1", claimed.lease_token);
    fx.advance(2000);
    assert.equal(ats.recoverExpiredTasks(), 1);
    const recovered = ats.getTask(task.id);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.worker_id, null);
    assert.equal(ats.getTask(task.id).steps[0].status, "queued");
    assert.equal(fx.db.prepare("SELECT status FROM task_attempts WHERE lease_token=?").get(claimed.lease_token).status, "interrupted");
    assert.ok(recovered.events.some((e) => e.type === "task.interrupted"));
    assert.equal(ats.recoverExpiredTasks(), 0, "二次调用必须幂等");
  } finally {
    fx.close();
  }
});

test("worker：注册 / 心跳 / 陈旧清理 / 健康判定", () => {
  const fx = fixture();
  try {
    ats.registerWorker("w1", 111, 30000);
    assert.equal(ats.workerHealth(5000).available, true);
    fx.advance(6000);
    assert.equal(ats.workerHealth(5000).available, false, "心跳过期后不可用");
    assert.equal(ats.heartbeatWorker("w1"), true);
    assert.equal(ats.workerHealth(5000).available, true);
    fx.advance(31000);
    ats.registerWorker("w2", 222, 30000);
    assert.equal(fx.db.prepare("SELECT status FROM worker_instances WHERE id=?").get("w1").status, "stopped", "注册新 worker 时清理陈旧 running");
    ats.stopWorker("w2");
    assert.equal(fx.db.prepare("SELECT status FROM worker_instances WHERE id=?").get("w2").status, "stopped");
    assert.equal(ats.heartbeatWorker("w2"), false, "停止后不再心跳");
  } finally {
    fx.close();
  }
});

test("预算：单任务上限与整棵树树上限，超限返回 false", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createActionsTask(project);
    assert.equal(ats.consumeBudget(task.id, "model", { maxModelCalls: 2, maxToolCalls: null }), true);
    assert.equal(ats.consumeBudget(task.id, "model", { maxModelCalls: 2, maxToolCalls: null }), true);
    assert.equal(ats.consumeBudget(task.id, "model", { maxModelCalls: 2, maxToolCalls: null }), false);
    assert.equal(fx.db.prepare("SELECT model_calls FROM dx_tasks WHERE id=?").get(task.id).model_calls, 2);
    // 树上限 40：手工塞满后必须拒绝
    fx.db.prepare("UPDATE dx_tasks SET model_calls=40 WHERE id=?").run(task.id);
    assert.equal(ats.consumeBudget(task.id, "model", ats.DEFAULT_BUDGET), false);
    assert.deepEqual({ ...ats.DEFAULT_TREE_BUDGET }, { maxModelCalls: 40, maxToolCalls: 120 });
  } finally {
    fx.close();
  }
});

test("计划 / 步骤 / 事件：ordinal 与 operation_id 唯一、动态步骤幂等、事件序号单调", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createActionsTask(project, [
      { tool: "file.create", path: "a.txt", content: "1" },
      { tool: "file.write", path: "b.txt", content: "2" },
    ]);
    assert.deepEqual(task.steps.map((s) => s.ordinal), [1, 2]);
    assert.deepEqual(task.steps.map((s) => s.operation_id), [task.id + ":1", task.id + ":2"]);
    const opIds = new Set(task.steps.map((s) => s.operation_id));
    assert.equal(opIds.size, 2);
    assert.throws(() => fx.db.prepare("INSERT INTO dx_task_steps(id,task_id,ordinal,title,tool_name,input_json,status,operation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("dup_step", task.id, 3, "x", "y", "{}", "queued", task.steps[0].operation_id, 1), /UNIQUE/);

    const dynamic = ats.appendDynamicStep(task.id, "读取", "fs_read", { path: "x" }, "op-stable");
    assert.equal(dynamic.ordinal, 3);
    const again = ats.appendDynamicStep(task.id, "读取", "fs_read", { path: "x" }, "op-stable");
    assert.equal(again.id, dynamic.id, "相同 stableOperationId 必须幂等");
    assert.equal(ats.getTask(task.id).steps.length, 3);

    ats.savePlan(task.id, { goal: "新目标", assumptions: ["a"], acceptance: ["b"] });
    assert.equal(ats.getTask(task.id).plan.goal, "新目标");
    const events = ats.getTask(task.id).events;
    assert.equal(events.at(-1).type, "task.planned");
    assert.equal(ats.listTaskEvents(task.id, events[0].sequence).length, events.length - 1);
  } finally {
    fx.close();
  }
});

test("检查点：persistAgentTurn / advanceAgentTurn / completeAgentTurn 断点续跑", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createReactTask(project);
    const claimed = ats.claimNextTask("w1", 5000);
    assert.equal(ats.latestResumableAgentTurn(task.id), undefined);
    // persistAgentTurn 的 run_id 有外键，先造 agent_runs 行
    fx.db.prepare("INSERT INTO agent_runs(id,correlation_id,entry_point,status,goal,created_at,updated_at,task_id) VALUES (?,?,?,?,?,?,?,?)").run(
      "run1", "corr1", "entry", "running", "goal", fx.now(), fx.now(), task.id,
    );
    const turn = ats.persistAgentTurn({
      runId: "run1",
      taskId: task.id,
      attemptNo: claimed.attempt_no,
      workerId: "w1",
      leaseToken: claimed.lease_token,
      requestHash: "hash1",
      content: "模型回答",
      toolCalls: [{ id: "t1", name: "fs_read", arguments: "{}" }],
    });
    assert.equal(turn.status, "responded");
    assert.equal(turn.iteration, 1);
    const latest = ats.latestResumableAgentTurn(task.id);
    assert.equal(latest.id, turn.id);
    const cp = fx.db.prepare("SELECT * FROM agent_checkpoints WHERE task_id=? ORDER BY sequence").all(task.id);
    assert.equal(cp[0].phase, "model_response_persisted");
    assert.equal(cp[0].schema_version, "dx-agent-checkpoint/v1");
    assert.equal(ats.advanceAgentTurn(turn.id, 1, { runId: "run1", taskId: task.id, attemptNo: claimed.attempt_no, workerId: "wX", leaseToken: claimed.lease_token }), false, "错误 worker 不能推进");
    assert.equal(ats.advanceAgentTurn(turn.id, 1, { runId: "run1", taskId: task.id, attemptNo: claimed.attempt_no, workerId: "w1", leaseToken: claimed.lease_token, state: { iteration: 1 } }), true);
    assert.equal(fx.db.prepare("SELECT next_tool_index FROM agent_turns WHERE id=?").get(turn.id).next_tool_index, 1);
    assert.equal(fx.db.prepare("SELECT phase FROM agent_checkpoints WHERE task_id=? ORDER BY sequence DESC LIMIT 1").get(task.id).phase, "tool_progress");
    assert.equal(ats.completeAgentTurn(turn.id, "w1", claimed.lease_token), true);
    assert.equal(ats.latestResumableAgentTurn(task.id), undefined, "完成后不可恢复");
  } finally {
    fx.close();
  }
});

test("等待与续跑：waitForUser → answerTask；continueTask 追加要求回队", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createReactTask(project);
    const claimed = ats.claimNextTask("w1", 5000);
    assert.equal(ats.waitForUser(task.id, "w1", "请问要哪个文件？", claimed.lease_token), true);
    const waiting = ats.getTask(task.id);
    assert.equal(waiting.status, "waiting_user");
    assert.equal(waiting.waiting_question, "请问要哪个文件？");
    assert.equal(ats.answerTask(task.id, "u1", "a.txt"), undefined);
    const answered = ats.getTask(task.id);
    assert.equal(answered.status, "queued");
    assert.equal(answered.waiting_question, null);
    const claim2 = ats.claimNextTask("w2", 5000);
    assert.equal(claim2.id, task.id);
    assert.equal(ats.waitForUser(task.id, "w2", "再问一次", claim2.lease_token), true);
    ats.continueTask(task.id, "u1", "改成 b.txt");
    assert.equal(ats.getTask(task.id).status, "queued");
    const events = ats.getTask(task.id).events.map((e) => e.type);
    assert.ok(events.includes("task.answered"));
    assert.ok(events.includes("task.continued"));
  } finally {
    fx.close();
  }
});

test("观测：失败 step 后再完成，observation 按 operation_id upsert", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createReactTask(project);
    const claimed = ats.claimNextTask("w1", 5000);
    const step = ats.appendDynamicStep(task.id, "读取", "fs_read", { path: "x" }, "op-1");
    assert.equal(ats.startStep(task.id, step.id, "w1", claimed.lease_token), true);
    assert.equal(ats.failStep(task.id, step.id, "w1", "读取失败", claimed.lease_token), true);
    assert.equal(ats.getTask(task.id).observations[0].status, "failed");
    assert.equal(ats.requeueReactStepForResume(task.id, step.id, "w1", claimed.lease_token), true);
    assert.equal(ats.startStep(task.id, step.id, "w1", claimed.lease_token), true);
    assert.equal(ats.completeStep(task.id, step.id, "w1", { nodeId: "n9", message: "成功" }, { projectId: project.id, nodeId: "n9", name: "r.txt" }, claimed.lease_token), true);
    const task2 = ats.getTask(task.id);
    assert.equal(task2.observations.length, 1, "同一 operation_id 只保留一行");
    assert.equal(task2.observations[0].status, "completed");
    assert.equal(task2.deliverables.length, 1);
    assert.equal(task2.checkpoints.length, 1, "完成步骤写一条 checkpoint");
  } finally {
    fx.close();
  }
});

test("生命周期：pause / resume / cancel / delete 与 resume 无步骤拒绝", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createActionsTask(project);
    ats.pauseTask(task.id);
    assert.equal(ats.getTask(task.id).status, "paused");
    ats.resumeTask(task.id);
    assert.equal(ats.getTask(task.id).status, "queued");
    ats.cancelTask(task.id);
    assert.equal(ats.getTask(task.id).status, "cancelled");
    assert.throws(() => ats.cancelTask(task.id), /不能取消/);
    ats.deleteTask(task.id);
    assert.equal(ats.getTask(task.id), undefined);
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS c FROM dx_task_steps WHERE task_id=?").get(task.id).c, 0);
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS c FROM dx_task_events WHERE task_id=?").get(task.id).c, 0);

    // react 任务无步骤时 resumeTask 不应报“没有可恢复的步骤”（走 sealStaleReactSteps 分支）
    const react = createReactTask(project);
    ats.pauseTask(react.id);
    ats.resumeTask(react.id);
    assert.equal(ats.getTask(react.id).status, "queued");
  } finally {
    fx.close();
  }
});

test("工具操作：beginOperation / findOperation / finishOperation 围栏", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createActionsTask(project);
    const claimed = ats.claimNextTask("w1", 5000);
    const step = ats.nextQueuedStep(task.id);
    assert.equal(ats.beginOperation(step.operation_id, task.id, step.tool_name, "w1", claimed.lease_token), true);
    const running = ats.findOperation(step.operation_id);
    assert.equal(running.status, "running");
    assert.equal(ats.finishOperation(step.operation_id, { ok: true }, task.id, "w1", claimed.lease_token), true);
    assert.equal(ats.findOperation(step.operation_id).status, "completed");
    // 错误 worker 不能 begin
    assert.equal(ats.beginOperation("op_new", task.id, "fs_read", "wX", claimed.lease_token), false);
  } finally {
    fx.close();
  }
});

test("项目权限映射：DX owner→manager、member→editor，can_create_tasks 由 role 推导", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createActionsTask(project);
    assert.equal(ats.canWorkerRunTask(task.id), true);
    assert.deepEqual({ ...ats.projectPermission(project.id, "u1") }, { role: "owner", can_create_tasks: 1 });
    ats.ensureProjectMember(project.id, "u2", "member");
    assert.deepEqual({ ...ats.projectPermission(project.id, "u2") }, { role: "member", can_create_tasks: 1 });
    fx.db.prepare("INSERT INTO project_members(project_id,user_id,role,created_at) VALUES (?,?,?,?)").run(project.id, "u3", "viewer", fx.now());
    assert.deepEqual({ ...ats.projectPermission(project.id, "u3") }, { role: "member", can_create_tasks: 0 });
    assert.throws(() => ats.requireProjectAccess(project.id, "nobody", true), /没有该项目的任务权限/);
    assert.equal(ats.projectForRoot(project.root_node_id).id, project.id);
    assert.equal(ats.listProjects("u1").length, 1);
  } finally {
    fx.close();
  }
});

test("verifyTask：缺 fsAdapter 返回 AGENT_DEPENDENCY_UNAVAILABLE；注入后可验证交付物", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createActionsTask(project);
    const claimed = ats.claimNextTask("w1", 5000);
    const step = ats.nextQueuedStep(task.id);
    ats.startStep(task.id, step.id, "w1", claimed.lease_token);
    ats.completeStep(task.id, step.id, "w1", { nodeId: "n1", message: "ok" }, null, claimed.lease_token);
    const unavailable = ats.verifyTask(task.id);
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.code, ats.AGENT_DEPENDENCY_UNAVAILABLE);

    const fs2 = fakeFs(project.root_node_id);
    fs2.nodes.set("n1", { id: "n1", name: "a.txt", type: "file", parentId: project.root_node_id, content: "hi", trashed: false });
    ats.configureAgentTaskStore({ fsAdapter: fs2 });
    assert.equal(ats.verifyTaskReadiness(task.id).ok, true);
    assert.equal(ats.verifyTask(task.id).ok, true);
    fs2.nodes.delete("n1");
    const missing = ats.verifyTask(task.id);
    assert.equal(missing.ok, false);
    assert.match(missing.message, /交付物缺失/);
  } finally {
    fx.close();
  }
});

test("项目快照：注入 fs 适配器写出 .ccs-ai；未注入抛结构化错误", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const fs2 = fakeFs(project.root_node_id);
    ats.configureAgentTaskStore({ fsAdapter: fs2 });
    snapshot.writeProjectSnapshot(project.id);
    let dir = null;
    for (const node of fs2.nodes.values()) if (node.name === ".ccs-ai") dir = node;
    assert.ok(dir && dir.type === "folder");
    const files = {};
    for (const node of fs2.nodes.values()) if (node.parentId === dir.id) files[node.name] = node.content;
    assert.ok(files["project.json"]);
    assert.equal(JSON.parse(files["project.json"]).projectId, project.id);
    assert.match(files["memory.md"], /项目记忆/);
    assert.match(files["tasks.md"], /任务历史/);
    ats.addMemory({ projectId: project.id, content: "记住这件事" });
    snapshot.writeProjectSnapshot(project.id);
    const memoryNode = fs2.findByPath(dir.id, "memory.md");
    assert.match(memoryNode.content, /记住这件事/);

    ats.resetAgentTaskStoreForTests();
    ats.configureAgentTaskStore({ db: fx.db });
    assert.throws(() => snapshot.writeProjectSnapshot(project.id), (error) => error.code === ats.AGENT_DEPENDENCY_UNAVAILABLE);
  } finally {
    fx.close();
  }
});

test("统计：taskStats / taskTrace / findResumableTasks", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const task = createActionsTask(project);
    runToVerified(fx, task);
    const stats = ats.taskStats("u1");
    assert.deepEqual(stats.byStatus.map((r) => r.key), ["completed"]);
    assert.equal(stats.usage.tasks, 1);
    const trace = ats.taskTrace(task.id, "u1");
    assert.equal(trace.status, "completed");
    assert.equal(trace.stepCounts.completed, 1);
    assert.equal(trace.deliverables, 0);
    const react = createReactTask(project);
    ats.pauseTask(react.id);
    const resumable = ats.findResumableTasks("u1", { projectId: project.id });
    assert.deepEqual(resumable.map((t) => t.id), [react.id]);
  } finally {
    fx.close();
  }
});

test("父子任务：waitForChildren 后全部子任务返回，父任务被重新排队", () => {
  const fx = fixture();
  try {
    const project = fx.project();
    const parent = createReactTask(project);
    const claimed = ats.claimNextTask("w1", 5000);
    assert.equal(ats.waitForChildren(parent.id, "w1", 1, claimed.lease_token), true);
    assert.equal(ats.getTask(parent.id).status, "waiting_children");
    const child = createReactTask(project, { parentTaskId: parent.id, instruction: "子任务" });
    assert.equal(child.root_task_id, parent.id);
    assert.equal(child.delegation_depth, 1);
    const childClaim = ats.claimNextTask("w2", 5000);
    assert.equal(childClaim.id, child.id);
    ats.updateTaskStatus(child.id, "completed", { completed_at: fx.now() });
    const claimedParent = ats.claimNextTask("w3", 5000);
    assert.equal(claimedParent.id, parent.id);
    assert.ok(ats.getTask(parent.id).events.some((e) => e.type === "supervisor.children_completed"));
  } finally {
    fx.close();
  }
});
