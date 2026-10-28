/**
 * P2 · 任务表物理合并迁移的测试夹具。
 *
 * 关键点：v28 库**不是手写 DDL**，而是让 IdentityStore 走完整迁移链建出来 ——
 * 这样测的是产品真实库形态（131 张表、9 张 FK 指向 tasks、WAL、user_version=28）。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { IdentityStore } = require("../electron/identity-store.cjs");

/** 合并迁移直接涉及的三张父表 + 三张旧 dx_ 入口。 */
export const MERGE_TABLES = Object.freeze(["tasks", "task_steps", "task_events"]);
export const DX_TABLES = Object.freeze(["dx_tasks", "dx_task_steps", "dx_task_events"]);

/** 9 张 FK 指向 tasks(task_id) 的表（方案 §1.1.1 实测图）。 */
export const TASKS_CHILD_TABLES = Object.freeze([
  "task_steps",
  "task_events",
  "task_model_calls",
  "task_harness_runs",
  "task_artifacts",
  "task_verifications",
  "task_tool_proposals",
  "side_effect_calls",
  "task_budgets",
]);

const SEED_NOW = 1700000000000;

export function makeTempDir(prefix = "oa-task-merge-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 9 张子表里，除 task_steps/task_events 之外的 7 张（重建父表时最容易被 CASCADE 误删的那批）。 */
export const OTHER_CHILD_TABLES = Object.freeze([
  "task_model_calls",
  "task_harness_runs",
  "task_artifacts",
  "task_verifications",
  "task_tool_proposals",
  "side_effect_calls",
  "task_budgets",
]);

/** 在已建好的 v28 连接上播种：core 1 任务/1 步/1 事件，dx 1 任务/1 步/2 事件，7 张外围子表各 1 行。 */
export function seedStandard(db, { now = SEED_NOW } = {}) {
  db.prepare(
    "INSERT INTO tasks (task_id,user_id,app_id,status,goal,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run("core_t1", "usr_core", "ai", "RUNNING", "core 目标", now, now);
  db.prepare(
    "INSERT INTO dx_tasks(id,project_id,thread_id,title,instruction,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("dx_t1", "proj_1", "thr_1", "DX 标题", "DX 指令", "running", now, now);
  db.prepare(
    "INSERT INTO task_steps(step_id,task_id,sequence,kind,status,input,output_ref,attempt,max_attempts) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run("core_s1", "core_t1", 1, "model", "RUNNING", "{}", "ref-1", 1, 1);
  db.prepare(
    "INSERT INTO dx_task_steps(id,task_id,ordinal,title,tool_name,input_json,status,output_json,operation_id,created_at,plan_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run("dx_s1", "dx_t1", 1, "步骤一", "tool.read", "{}", "queued", null, "op_dx_1", now, 1);
  db.prepare(
    "INSERT INTO task_events(event_id,task_id,sequence,event_type,created_at,safe_payload) VALUES (?,?,?,?,?,?)",
  ).run("core_e1", "core_t1", 1, "task.created", now, "{}");
  // dx 事件显式 id 1/2：合并后 sqlite_sequence 必须抬到 2，新事件从 3 开始
  for (const [id, sequence, type] of [[1, 1, "task.started"], [2, 2, "task.step"]]) {
    db.prepare(
      "INSERT INTO dx_task_events(id,task_id,sequence,type,message,data_json,created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, "dx_t1", sequence, type, "消息 " + id, "{}", now);
  }

  db.prepare("INSERT INTO task_model_calls(call_id,task_id,status,started_at) VALUES (?,?,?,?)").run(
    "mc1", "core_t1", "STARTED", now,
  );
  db.prepare("INSERT INTO task_harness_runs(run_id,task_id,status,started_at) VALUES (?,?,?,?)").run(
    "hr1", "core_t1", "STARTING", now,
  );
  db.prepare("INSERT INTO task_artifacts(artifact_id,task_id,type,created_at) VALUES (?,?,?,?)").run(
    "af1", "core_t1", "text", now,
  );
  db.prepare(
    "INSERT INTO task_verifications(verification_id,artifact_id,task_id,type,status,created_at) VALUES (?,?,?,?,?,?)",
  ).run("vf1", "af1", "core_t1", "schema", "PASS", now);
  db.prepare(
    "INSERT INTO task_tool_proposals(proposal_id,task_id,tool_id,tool_version,status,created_at) VALUES (?,?,?,?,?,?)",
  ).run("tp1", "core_t1", "tool.read", 1, "PROPOSED", now);
  db.prepare(
    "INSERT INTO side_effect_calls(call_id,task_id,tool_id,tool_version,effect_class,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("se1", "core_t1", "tool.read", 1, "REVERSIBLE_WRITE", "PLANNED", now, now);
  db.prepare("INSERT INTO task_budgets(task_id,kind,authorized) VALUES (?,?,?)").run("core_t1", "MODEL_CALLS", 10);

  // DX→core 身份桥**不参与合并**（方案 §2.3 "不参与合并"），但按值引用 dx id；
  // 播种一行，用来验证重建父表不会误删这张无外键的桥表，且 dx id 仍可解析。
  db.prepare(
    "INSERT INTO dx_task_approval_bridge(dx_task_id,dx_step_id,dx_run_id,core_task_id,core_step_id,core_run_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("dx_t1", "dx_s1", "dx_run_1", "core_t1", "core_s1", "core_run_1", now, now);
}

/** 建一个真实 v28 库（走完整迁移链）并播种标准数据；返回库文件路径。 */
export function createSeededV28(dir, { now = SEED_NOW } = {}) {
  const dbPath = path.join(dir, "identity.db");
  const store = new IdentityStore({ path: dbPath }).open();
  try {
    store.connection.exec("PRAGMA user_version = 28");
    if (store.schemaVersion !== 28) throw new Error("夹具期望 v28，实际 " + store.schemaVersion);
    seedStandard(store.connection, { now });
  } finally {
    store.close();
  }
  return dbPath;
}

/** 批量播种核心任务（用于万行级性能验证）；每任务 1 步 1 事件。 */
export function seedBulkCore(db, count, { now = SEED_NOW } = {}) {
  const task = db.prepare(
    "INSERT INTO tasks (task_id,user_id,app_id,status,goal,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  );
  const step = db.prepare("INSERT INTO task_steps(step_id,task_id,sequence,kind,status) VALUES (?,?,?,?,?)");
  const event = db.prepare("INSERT INTO task_events(event_id,task_id,sequence,event_type,created_at) VALUES (?,?,?,?,?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let i = 0; i < count; i += 1) {
      const id = "bulk_t_" + i;
      task.run(id, "usr_bulk", "ai", "RUNNING", "bulk-" + i, now, now);
      step.run("bulk_s_" + i, id, 1, "model", "RUNNING");
      event.run("bulk_e_" + i, id, 1, "task.created", now);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 只读打开一个库，数给定表的行数。 */
export function tableCounts(dbPath, tables) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const out = {};
    for (const table of tables) out[table] = db.prepare("SELECT COUNT(*) AS c FROM " + table).get().c;
    return out;
  } finally {
    db.close();
  }
}

/** 迁移前的完整快照：行数 + user_version + 9 张子表行数。 */
export function snapshotV28(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const counts = {};
    for (const table of [...MERGE_TABLES, ...DX_TABLES, ...TASKS_CHILD_TABLES]) {
      counts[table] = db.prepare("SELECT COUNT(*) AS c FROM " + table).get().c;
    }
    return {
      userVersion: db.prepare("PRAGMA user_version").get().user_version,
      tasksColumns: db.prepare("PRAGMA table_info(tasks)").all().length,
      counts,
      dxTasksType: db.prepare("SELECT type FROM sqlite_master WHERE name='dx_tasks'").get().type,
    };
  } finally {
    db.close();
  }
}
