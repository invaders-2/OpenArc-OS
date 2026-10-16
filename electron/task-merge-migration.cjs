/**
 * P2 · dx_* 与 tasks 三张表**物理合并迁移**（默认不启用）。
 *
 * 来源方案：docs/dxos-port/Dx-TASK-MERGE-PLAN.md §2（目标 schema）、§3（迁移步骤）。
 * schema 真值：core 三表在 identity-store.cjs:852（SCHEMA_V9_SQL；tasks:853 / task_steps:875 /
 *             task_events:906）；dx 三表在 dxos-agent-schema.cjs:66-68。
 * 执行器：identity-store.cjs:1798（#migrate）、1812（#applyMigration）、1855（#backupBeforeMigration）、
 *        1886（applyExplicitMigration）提供 backupBefore / foreignKeysOff / foreignKeyCheck 三个能力；
 *        本文件只提供"迁移体"与描述符，不接进 identity-store.cjs:1583 的 MIGRATIONS。
 *
 * ## 为什么默认不启用
 *   合并会重建 tasks / task_steps / task_events 三张父表并 DROP 旧 dx_ 表，
 *   还会把 user_version 推到 29；生产 SCHEMA_VERSION 仍是 28，版本冻结断言不动。
 *   本阶段只在**库副本**上验证，由调用方显式 `store.applyExplicitMigration(taskMergeMigration)` 触发。
 *
 * ## 安全前置（缺一不可，全部由执行器承担）
 *   1. backupBefore：事务外 `VACUUM INTO`（Node 22 无 DatabaseSync.backup；事务内 VACUUM 直接报错）；
 *   2. foreignKeysOff：**BEGIN 之前**关 FK。FK=ON 时 `DROP TABLE tasks` 会按
 *      ON DELETE CASCADE 静默删光 9 张子表；且 `PRAGMA foreign_keys` 在事务内是 no-op；
 *   3. foreignKeyCheck：事务内 `PRAGMA foreign_key_check` 必须为空，否则整级回滚。
 *
 * ## 幂等 / 可重放
 *   守卫看 sqlite_master 里 dx_tasks 的类型：已是 view 即本层已应用，直接返回。
 *   因此"把 user_version 人为降回 28 再执行"不会重复搬行。
 *
 * ## 状态列的处理（与方案 §1.4 / §2.5 一致）
 *   物理合并后 status 只保留**原始值**：core 行是大写 7 态、dx 行是小写 11 态，
 *   靠 record_source 判别，并各自受分源 CHECK 约束。原因：核心 7 态与 DX 11 态是
 *   多对一的（planning/running/verifying 都归 RUNNING），回写不可逆；
 *   统一词汇只能在只读投影层推导，不能落成物理列。
 */
"use strict";

/** 合并后的目标版本号（**不是** SCHEMA_VERSION；生产仍是 28）。 */
const TASK_MERGE_VERSION = 29;

/** 合并后三张表的列数基线（PRAGMA table_info 计数，含判别列 record_source）。 */
const TASK_MERGE_COLUMN_COUNTS = Object.freeze({ tasks: 50, task_steps: 22, task_events: 11 });

const TASKS_V29_DDL = `CREATE TABLE tasks_v29 (
  -- core 侧 17 列
  task_id                 TEXT PRIMARY KEY,
  user_id                 TEXT,
  session_ref             TEXT,
  app_id                  TEXT,
  status                  TEXT NOT NULL,
  goal                    TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  started_at              INTEGER,
  completed_at            INTEGER,
  model_config_id         TEXT,
  model_config_version    INTEGER,
  current_step_id         TEXT,
  revision                INTEGER NOT NULL DEFAULT 1,
  cancel_requested        INTEGER NOT NULL DEFAULT 0,
  budget_snapshot         TEXT,
  permission_snapshot_ref TEXT,
  -- dx 侧 32 列（去重后；dx 的 id 由只读视图别名提供，不物理存在）
  project_id              TEXT,
  thread_id               TEXT,
  title                   TEXT,
  instruction             TEXT,
  worker_id               TEXT,
  lease_until             INTEGER,
  heartbeat_at            INTEGER,
  result                  TEXT,
  error_code              TEXT,
  error_message           TEXT,
  resume_safe             INTEGER NOT NULL DEFAULT 1,
  created_by              TEXT,
  legacy_source_id        TEXT,
  mode                    TEXT NOT NULL DEFAULT 'actions',
  model_calls             INTEGER NOT NULL DEFAULT 0,
  tool_calls              INTEGER NOT NULL DEFAULT 0,
  waiting_question        TEXT,
  execution_profile       TEXT NOT NULL DEFAULT 'expert',
  preferred_provider_id   TEXT,
  preferred_llm_model     TEXT,
  preferred_image_provider_id TEXT,
  preferred_image_model   TEXT,
  parent_task_id          TEXT,
  root_task_id            TEXT,
  agent_profile_id        TEXT,
  delegated_by_run_id     TEXT,
  depends_on_json         TEXT NOT NULL DEFAULT '[]',
  expected_output_schema  TEXT,
  permission_grant_json   TEXT NOT NULL DEFAULT '[]',
  delegation_depth        INTEGER NOT NULL DEFAULT 0,
  lease_token             TEXT,
  attempt_no              INTEGER NOT NULL DEFAULT 0,
  -- 合并新增：来源判别 + 分源状态 CHECK（两套状态机在库层各自保住）
  record_source           TEXT NOT NULL DEFAULT 'core' CHECK (record_source IN ('core','dx')),
  CHECK (
    (record_source = 'core' AND status IN ('PENDING','RUNNING','WAITING','SUCCEEDED','FAILED','CANCELLED','BLOCKED'))
    OR
    (record_source = 'dx'   AND status IN ('queued','planning','running','verifying','completed',
                                           'waiting_user','waiting_children','paused','interrupted','failed','cancelled'))
  )
)`;

const TASK_STEPS_V29_DDL = `CREATE TABLE task_steps_v29 (
  step_id         TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  sequence        INTEGER,
  ordinal         INTEGER,
  kind            TEXT,
  tool_name       TEXT,
  title           TEXT,
  status          TEXT NOT NULL,
  input           TEXT,
  input_json      TEXT,
  output_ref      TEXT,
  output_json     TEXT,
  operation_id    TEXT UNIQUE,
  attempt         INTEGER NOT NULL DEFAULT 1,
  max_attempts    INTEGER NOT NULL DEFAULT 1,
  plan_version    INTEGER NOT NULL DEFAULT 1,
  expected_output TEXT,
  result_summary  TEXT,
  created_at      INTEGER,
  started_at      INTEGER,
  completed_at    INTEGER,
  record_source   TEXT NOT NULL DEFAULT 'core' CHECK (record_source IN ('core','dx')),
  UNIQUE (task_id, sequence),
  UNIQUE (task_id, ordinal),
  CHECK (
    (record_source = 'core' AND status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED','BLOCKED'))
    OR
    (record_source = 'dx'   AND status IN ('queued','running','completed','failed'))
  )
)`;

const TASK_EVENTS_V29_DDL = `CREATE TABLE task_events_v29 (
  -- DX 的 AUTOINCREMENT 身份必须物理保留：AUTOINCREMENT 只能落在 INTEGER PRIMARY KEY
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id      TEXT UNIQUE,
  task_id       TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  sequence      INTEGER NOT NULL,
  event_type    TEXT,
  type          TEXT,
  message       TEXT,
  safe_payload  TEXT,
  data_json     TEXT,
  created_at    INTEGER NOT NULL,
  record_source TEXT NOT NULL DEFAULT 'core' CHECK (record_source IN ('core','dx')),
  UNIQUE (task_id, sequence)
)`;

/** core 行原样搬（status 大写 7 态）。 */
const INSERT_TASKS_CORE_SQL = `INSERT INTO tasks_v29 (
  task_id, user_id, session_ref, app_id, status, goal, created_at, updated_at, started_at, completed_at,
  model_config_id, model_config_version, current_step_id, revision, cancel_requested, budget_snapshot,
  permission_snapshot_ref, record_source
) SELECT
  task_id, user_id, session_ref, app_id, status, goal, created_at, updated_at, started_at, completed_at,
  model_config_id, model_config_version, current_step_id, revision, cancel_requested, budget_snapshot,
  permission_snapshot_ref, 'core'
FROM tasks`;

/** dx 行搬入并打 record_source='dx'；dx 的 id → 规范主键 task_id。 */
const INSERT_TASKS_DX_SQL = `INSERT INTO tasks_v29 (
  task_id, project_id, thread_id, title, instruction, status, worker_id, lease_until, heartbeat_at,
  current_step_id, result, error_code, error_message, resume_safe, created_at, updated_at, started_at,
  completed_at, created_by, legacy_source_id, mode, model_calls, tool_calls, waiting_question,
  execution_profile, preferred_provider_id, preferred_llm_model, preferred_image_provider_id,
  preferred_image_model, parent_task_id, root_task_id, agent_profile_id, delegated_by_run_id,
  depends_on_json, expected_output_schema, permission_grant_json, delegation_depth, lease_token,
  attempt_no, record_source
) SELECT
  id, project_id, thread_id, title, instruction, status, worker_id, lease_until, heartbeat_at,
  current_step_id, result, error_code, error_message, resume_safe, created_at, updated_at, started_at,
  completed_at, created_by, legacy_source_id, mode, model_calls, tool_calls, waiting_question,
  execution_profile, preferred_provider_id, preferred_llm_model, preferred_image_provider_id,
  preferred_image_model, parent_task_id, root_task_id, agent_profile_id, delegated_by_run_id,
  depends_on_json, expected_output_schema, permission_grant_json, delegation_depth, lease_token,
  attempt_no, 'dx'
FROM dx_tasks`;

const INSERT_STEPS_CORE_SQL = `INSERT INTO task_steps_v29 (
  step_id, task_id, sequence, kind, status, input, output_ref, started_at, completed_at,
  attempt, max_attempts, record_source
) SELECT
  step_id, task_id, sequence, kind, status, input, output_ref, started_at, completed_at,
  attempt, max_attempts, 'core'
FROM task_steps`;

const INSERT_STEPS_DX_SQL = `INSERT INTO task_steps_v29 (
  step_id, task_id, ordinal, title, tool_name, input_json, status, output_json, operation_id,
  started_at, completed_at, created_at, plan_version, expected_output, result_summary, record_source
) SELECT
  id, task_id, ordinal, title, tool_name, input_json, status, output_json, operation_id,
  started_at, completed_at, created_at, plan_version, expected_output, result_summary, 'dx'
FROM dx_task_steps`;

/**
 * 事件表必须**先搬 dx 行（显式 id）再搬 core 行**：
 * 反过来的话 core 先占 id 1..N，会和 dx 的显式 id 撞 UNIQUE（方案 §3.3 实测）。
 * 显式 id 插入会把 sqlite_sequence 抬到 dx 的最大 id，core 行随后自然续号。
 */
const INSERT_EVENTS_DX_SQL = `INSERT INTO task_events_v29 (
  id, task_id, sequence, type, message, data_json, created_at, record_source
) SELECT
  id, task_id, sequence, type, message, data_json, created_at, 'dx'
FROM dx_task_events`;

const INSERT_EVENTS_CORE_SQL = `INSERT INTO task_events_v29 (
  event_id, task_id, sequence, event_type, created_at, safe_payload, record_source
) SELECT
  event_id, task_id, sequence, event_type, created_at, safe_payload, 'core'
FROM task_events`;

/**
 * 过渡期**只读**兼容视图：列名与旧 dx_ 表逐字一致，旧读路径（SELECT）可零改动。
 * 本阶段不提供 INSTEAD OF 触发器 —— 写入兼容是方案 §4 阶段 2 的事，
 * 这里刻意只开读，避免"看起来能写、实际绕过合并表约束"的假兼容。
 */
const COMPAT_VIEWS_SQL = [
  `CREATE VIEW dx_tasks AS
SELECT task_id AS id, project_id, thread_id, title, instruction, status, worker_id, lease_until,
       heartbeat_at, current_step_id, result, error_code, error_message, resume_safe, created_at,
       updated_at, started_at, completed_at, created_by, legacy_source_id, mode, model_calls,
       tool_calls, waiting_question, execution_profile, preferred_provider_id, preferred_llm_model,
       preferred_image_provider_id, preferred_image_model, parent_task_id, root_task_id,
       agent_profile_id, delegated_by_run_id, depends_on_json, expected_output_schema,
       permission_grant_json, delegation_depth, lease_token, attempt_no
FROM tasks WHERE record_source = 'dx'`,
  `CREATE VIEW dx_task_steps AS
SELECT step_id AS id, task_id, ordinal, title, tool_name, input_json, status, output_json,
       operation_id, started_at, completed_at, created_at, plan_version, expected_output, result_summary
FROM task_steps WHERE record_source = 'dx'`,
  `CREATE VIEW dx_task_events AS
SELECT id, task_id, type, message, data_json, created_at, sequence
FROM task_events WHERE record_source = 'dx'`,
];

/** 合并表上的索引：core / dx 两侧原索引名与语义都保留（dx 的 UNIQUE 事件序列由表级 UNIQUE 承担）。 */
const TASK_MERGE_INDEXES = [
  "CREATE INDEX idx_tasks_user_status ON tasks(user_id, status)",
  "CREATE INDEX idx_tasks_app ON tasks(app_id)",
  "CREATE INDEX dx_idx_tasks_queue ON tasks(status, lease_until, created_at)",
  "CREATE INDEX dx_idx_tasks_project ON tasks(project_id, created_at)",
  "CREATE INDEX dx_idx_tasks_creator ON tasks(created_by, created_at)",
  "CREATE UNIQUE INDEX dx_idx_tasks_legacy_source ON tasks(created_by, legacy_source_id) WHERE legacy_source_id IS NOT NULL",
  "CREATE INDEX dx_idx_tasks_parent ON tasks(parent_task_id, created_at)",
  "CREATE INDEX dx_idx_tasks_root_status ON tasks(root_task_id, status, created_at)",
  "CREATE INDEX idx_tasks_record_source ON tasks(record_source, created_at)",
  "CREATE INDEX idx_task_steps_task_seq ON task_steps(task_id, sequence)",
  "CREATE INDEX idx_task_steps_task_ordinal ON task_steps(task_id, ordinal)",
  "CREATE INDEX idx_task_events_task_seq ON task_events(task_id, sequence)",
  "CREATE INDEX idx_task_events_task_id ON task_events(task_id, id)",
];

function schemaType(db, name) {
  const row = db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(name);
  return row ? String(row.type) : null;
}

/** 本层是否已应用：dx_tasks 已变成视图 = 已合并。 */
function isTaskMergeApplied(db) {
  return schemaType(db, "dx_tasks") === "view";
}

/**
 * 同名 id 预检：core 与 dx 的 id 命名空间独立，合并后同一个主键只能有一条。
 * 非空即 fail closed —— **不自动改 id**（dx_task_approval_bridge / deliverables.task_id /
 * agent_runs.task_id 等外围数据按值引用，改名会让它们失联，方案 §5.1 R6）。
 */
function findTaskMergeConflicts(db) {
  const tasks = db
    .prepare("SELECT t.task_id FROM tasks t JOIN dx_tasks d ON d.id = t.task_id ORDER BY t.task_id")
    .all()
    .map((r) => String(r.task_id));
  const steps = db
    .prepare("SELECT s.step_id FROM task_steps s JOIN dx_task_steps d ON d.id = s.step_id ORDER BY s.step_id")
    .all()
    .map((r) => String(r.step_id));
  return { tasks, steps };
}

/** 组合一条"预检失败"的错误信息（含前若干条冲突 id，便于人工处置）。 */
function conflictError(conflicts) {
  const parts = [];
  if (conflicts.tasks.length) parts.push(`tasks 主键冲突 ${conflicts.tasks.length} 条：${conflicts.tasks.slice(0, 10).join(", ")}`);
  if (conflicts.steps.length) parts.push(`task_steps 主键冲突 ${conflicts.steps.length} 条：${conflicts.steps.slice(0, 10).join(", ")}`);
  return new Error("task-merge 预检未通过（不自动改 id）：" + parts.join("；"));
}

/**
 * 迁移体：在**调用方已经 BEGIN 的事务内**执行（执行器负责 backup/FK/自检/版本）。
 * 幂等：已合并（dx_tasks 是视图）直接返回；可重放：不会重复搬行。
 *
 * @returns {{applied: boolean, reason?: string}}
 */
function applyTaskTableMergeLayer(db) {
  if (!db || typeof db.exec !== "function") throw new Error("applyTaskTableMergeLayer 需要 sqlite 连接。");
  const dxKind = schemaType(db, "dx_tasks");
  if (dxKind === "view") return { applied: false, reason: "already-merged" };
  if (dxKind !== "table") {
    throw new Error("task-merge 期望 v28 双表形态（dx_tasks 为表），当前为：" + (dxKind || "缺失"));
  }
  // 步骤表身份也要预检：合并后 step_id 是同一个主键空间。
  if (schemaType(db, "task_steps") !== "table" || schemaType(db, "dx_task_steps") !== "table") {
    throw new Error("task-merge 期望 tasks 与 dx_ 两侧三表齐备。");
  }

  const conflicts = findTaskMergeConflicts(db);
  if (conflicts.tasks.length || conflicts.steps.length) throw conflictError(conflicts);

  // 父表先重建，再重建子表：子表 FK 指向的 tasks 在重建期间必须先存在。
  db.exec(TASKS_V29_DDL);
  db.exec(INSERT_TASKS_CORE_SQL);
  db.exec(INSERT_TASKS_DX_SQL);
  db.exec("DROP TABLE tasks");
  db.exec("ALTER TABLE tasks_v29 RENAME TO tasks");

  db.exec(TASK_STEPS_V29_DDL);
  db.exec(INSERT_STEPS_CORE_SQL);
  db.exec(INSERT_STEPS_DX_SQL);
  db.exec("DROP TABLE task_steps");
  db.exec("ALTER TABLE task_steps_v29 RENAME TO task_steps");

  // 事件表：先 dx（显式 id，抬高 sqlite_sequence）再 core（自然续号）。
  db.exec(TASK_EVENTS_V29_DDL);
  db.exec(INSERT_EVENTS_DX_SQL);
  db.exec(INSERT_EVENTS_CORE_SQL);
  db.exec("DROP TABLE task_events");
  db.exec("ALTER TABLE task_events_v29 RENAME TO task_events");

  // 旧 dx_ 真表落掉，换成同名只读视图（DROP 必须在 CREATE VIEW 之前）。
  db.exec("DROP TABLE dx_tasks");
  db.exec("DROP TABLE dx_task_steps");
  db.exec("DROP TABLE dx_task_events");
  for (const statement of COMPAT_VIEWS_SQL) db.exec(statement);
  for (const statement of TASK_MERGE_INDEXES) db.exec(statement);

  // 列数基线自检：能挡住"DDL 漏列"这种最隐蔽的回归。
  const counts = {};
  for (const table of Object.keys(TASK_MERGE_COLUMN_COUNTS)) {
    counts[table] = db.prepare("PRAGMA table_info(" + table + ")").all().length;
    if (counts[table] !== TASK_MERGE_COLUMN_COUNTS[table]) {
      throw new Error(`task-merge 列数自检失败：${table} = ${counts[table]}，期望 ${TASK_MERGE_COLUMN_COUNTS[table]}`);
    }
  }
  return { applied: true, counts };
}

/**
 * 默认不启用的迁移描述符。执行器看到 foreignKeysOff / backupBefore / foreignKeyCheck 才会
 * 打开对应安全能力；它**不在** identity-store.cjs 的 MIGRATIONS 里。
 */
const taskMergeMigration = Object.freeze({
  version: TASK_MERGE_VERSION,
  run: applyTaskTableMergeLayer,
  foreignKeysOff: true,
  backupBefore: true,
  foreignKeyCheck: true,
});

module.exports = {
  TASK_MERGE_VERSION,
  TASK_MERGE_COLUMN_COUNTS,
  TASKS_V29_DDL,
  TASK_STEPS_V29_DDL,
  TASK_EVENTS_V29_DDL,
  COMPAT_VIEWS_SQL,
  TASK_MERGE_INDEXES,
  applyTaskTableMergeLayer,
  findTaskMergeConflicts,
  isTaskMergeApplied,
  taskMergeMigration,
};
