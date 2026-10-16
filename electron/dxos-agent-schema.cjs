/**
 * P1/B3a · DX OS 0.5.1 任务域表结构抽取（机械生成，勿手改）。
 *
 * 生成脚本：scripts/extract-dxos-agent-schema.mjs
 *   node scripts/extract-dxos-agent-schema.mjs
 * 源文件：<DX OS.app>/Contents/Resources/app.asar.unpacked/server/ccsDb.ts
 *
 * ## 抽取方法
 *   1. 取基础 CREATE TABLE（源行号如下），拆成列定义与表级约束；
 *   2. 把该表全部 ALTER TABLE ADD COLUMN 折叠进列区（放在表级约束之前）；
 *   3. 去掉每个列定义里的 REFERENCES ... ON DELETE/UPDATE ... 外键（P1 既定做法：跨域只留列）；
 *   4. 表名加 dx_ 前缀，索引名加 dx_ 前缀并指向 dx_ 表；全部 CREATE ... IF NOT EXISTS。
 *
 * ## 源行号（本脚本 grep 所得，不手抄）
 *   tasks: CREATE TABLE 46-65；ALTER ADD COLUMN 21 处，行 [140,181,220,221,222,223,354,360,361,362,363,672,673,674,675,676,677,678,679,908,909]
 *   task_steps: CREATE TABLE 75-89；ALTER ADD COLUMN 3 处，行 [160,161,162]
 *   task_events: CREATE TABLE 90-97；ALTER ADD COLUMN 1 处，行 [163]
 *   索引 9 条，行 [123,124,125,126,142,167,182,681,682]
 *
 * ## 自检（列数 / 关键列）
 *   dx_tasks: 39 列，表级约束 0 条，外键 0 条
 *   dx_task_steps: 15 列，表级约束 1 条，外键 0 条
 *   dx_task_events: 7 列，表级约束 0 条，外键 0 条
 *
 * ## OpenArc 桥接表（非抽取，见下方常量注释）
 *   dx_project_roots —— 承接 DX projects.root_node_id 语义。
 */
"use strict";

/** dx_ 前缀的三张任务域表（DX 原文为 tasks / task_steps / task_events）。 */
const DXOS_AGENT_TABLES = Object.freeze(["dx_tasks", "dx_task_steps", "dx_task_events"]);

/** 每张表的最终列数（抽取自检基线）。 */
const DXOS_AGENT_COLUMN_COUNTS = Object.freeze({ "dx_tasks": 39, "dx_task_steps": 15, "dx_task_events": 7 });

/** 关键列存在性自检基线（抽样覆盖后续迁移追加的列）。 */
const DXOS_AGENT_KEY_COLUMNS = Object.freeze({

  "dx_tasks": Object.freeze(["id", "project_id", "thread_id", "status", "worker_id", "lease_until", "lease_token", "attempt_no", "mode", "model_calls", "tool_calls", "waiting_question", "execution_profile", "parent_task_id", "root_task_id", "depends_on_json", "delegation_depth", "legacy_source_id", "preferred_llm_model"]),
  "dx_task_steps": Object.freeze(["id", "task_id", "ordinal", "operation_id", "plan_version", "expected_output", "result_summary"]),
  "dx_task_events": Object.freeze(["id", "task_id", "sequence", "type", "message", "data_json"]),
});

/** dx_ 索引（名称与目标表都加了 dx_ 前缀，避免与 OpenArc 既有索引撞名）。 */
const DXOS_AGENT_INDEXES = Object.freeze([
  "CREATE INDEX IF NOT EXISTS dx_idx_tasks_queue ON dx_tasks(status, lease_until, created_at)",
  "CREATE INDEX IF NOT EXISTS dx_idx_tasks_project ON dx_tasks(project_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS dx_idx_events_task ON dx_task_events(task_id, id)",
  "CREATE INDEX IF NOT EXISTS dx_idx_steps_task ON dx_task_steps(task_id, ordinal)",
  "CREATE INDEX IF NOT EXISTS dx_idx_tasks_creator ON dx_tasks(created_by, created_at DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS dx_idx_events_task_sequence ON dx_task_events(task_id, sequence)",
  "CREATE UNIQUE INDEX IF NOT EXISTS dx_idx_tasks_legacy_source ON dx_tasks(created_by, legacy_source_id) WHERE legacy_source_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS dx_idx_tasks_parent ON dx_tasks(parent_task_id, created_at)",
  "CREATE INDEX IF NOT EXISTS dx_idx_tasks_root_status ON dx_tasks(root_task_id, status, created_at)",
]);

/**
 * OpenArc 桥接表：**不是**从 ccsDb.ts 抽取的。
 * OpenArc 既有 projects 没有 root_node_id 列，而硬约束禁止改既有表结构；
 * 这里只新增一张映射表承接 DX projects.root_node_id 语义，createProject/projectForRoot 用它落位。
 */
const DXOS_PROJECT_BRIDGE_DDL = Object.freeze(["CREATE TABLE IF NOT EXISTS dx_project_roots (\n  project_id   TEXT PRIMARY KEY,\n  root_node_id TEXT NOT NULL UNIQUE,\n  created_at   INTEGER NOT NULL\n)"]);

/** 幂等 DDL：三张表 + 全部索引 + 桥接表（表先于索引）。 */
const DXOS_AGENT_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS dx_tasks (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL,\n  thread_id TEXT NOT NULL,\n  title TEXT NOT NULL,\n  instruction TEXT NOT NULL,\n  status TEXT NOT NULL,\n  worker_id TEXT,\n  lease_until INTEGER,\n  heartbeat_at INTEGER,\n  current_step_id TEXT,\n  result TEXT,\n  error_code TEXT,\n  error_message TEXT,\n  resume_safe INTEGER NOT NULL DEFAULT 1,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  started_at INTEGER,\n  completed_at INTEGER,\n  created_by TEXT,\n  legacy_source_id TEXT,\n  mode TEXT NOT NULL DEFAULT 'actions',\n  model_calls INTEGER NOT NULL DEFAULT 0,\n  tool_calls INTEGER NOT NULL DEFAULT 0,\n  waiting_question TEXT,\n  execution_profile TEXT NOT NULL DEFAULT 'expert',\n  preferred_provider_id TEXT,\n  preferred_llm_model TEXT,\n  preferred_image_provider_id TEXT,\n  preferred_image_model TEXT,\n  parent_task_id TEXT,\n  root_task_id TEXT,\n  agent_profile_id TEXT,\n  delegated_by_run_id TEXT,\n  depends_on_json TEXT NOT NULL DEFAULT '[]',\n  expected_output_schema TEXT,\n  permission_grant_json TEXT NOT NULL DEFAULT '[]',\n  delegation_depth INTEGER NOT NULL DEFAULT 0,\n  lease_token TEXT,\n  attempt_no INTEGER NOT NULL DEFAULT 0\n)",
  "CREATE TABLE IF NOT EXISTS dx_task_steps (\n  id TEXT PRIMARY KEY,\n  task_id TEXT NOT NULL,\n  ordinal INTEGER NOT NULL,\n  title TEXT NOT NULL,\n  tool_name TEXT NOT NULL,\n  input_json TEXT NOT NULL,\n  status TEXT NOT NULL DEFAULT 'queued',\n  output_json TEXT,\n  operation_id TEXT NOT NULL UNIQUE,\n  started_at INTEGER,\n  completed_at INTEGER,\n  created_at INTEGER NOT NULL,\n  plan_version INTEGER NOT NULL DEFAULT 1,\n  expected_output TEXT,\n  result_summary TEXT,\n  UNIQUE(task_id, ordinal)\n)",
  "CREATE TABLE IF NOT EXISTS dx_task_events (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  task_id TEXT NOT NULL,\n  type TEXT NOT NULL,\n  message TEXT NOT NULL,\n  data_json TEXT,\n  created_at INTEGER NOT NULL,\n  sequence INTEGER\n)",
  "CREATE INDEX IF NOT EXISTS dx_idx_tasks_queue ON dx_tasks(status, lease_until, created_at)",
  "CREATE INDEX IF NOT EXISTS dx_idx_tasks_project ON dx_tasks(project_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS dx_idx_events_task ON dx_task_events(task_id, id)",
  "CREATE INDEX IF NOT EXISTS dx_idx_steps_task ON dx_task_steps(task_id, ordinal)",
  "CREATE INDEX IF NOT EXISTS dx_idx_tasks_creator ON dx_tasks(created_by, created_at DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS dx_idx_events_task_sequence ON dx_task_events(task_id, sequence)",
  "CREATE UNIQUE INDEX IF NOT EXISTS dx_idx_tasks_legacy_source ON dx_tasks(created_by, legacy_source_id) WHERE legacy_source_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS dx_idx_tasks_parent ON dx_tasks(parent_task_id, created_at)",
  "CREATE INDEX IF NOT EXISTS dx_idx_tasks_root_status ON dx_tasks(root_task_id, status, created_at)",
  "CREATE TABLE IF NOT EXISTS dx_project_roots (\n  project_id   TEXT PRIMARY KEY,\n  root_node_id TEXT NOT NULL UNIQUE,\n  created_at   INTEGER NOT NULL\n)",
]);

/** @returns {string[]} DDL 语句副本。 */
function dxosAgentDdl() {
  return DXOS_AGENT_DDL.slice();
}

/** 抽取正确性自检：列数、关键列、外键已去。返回 true 或抛错。 */
function dxosAgentSchemaSelfCheck() {
  const tables = {};
  for (const statement of DXOS_AGENT_DDL) {
    const prefix = 'CREATE TABLE IF NOT EXISTS ';
    if (statement.indexOf(prefix) !== 0) continue;
    const open = statement.indexOf('(');
    const name = statement.slice(prefix.length, statement.indexOf(' (', prefix.length));
    const entries = statement.slice(open + 1, statement.length - 1).split(String.fromCharCode(10)).map((line) => line.trim()).filter((line) => line.length > 0).map((line) => (line.charAt(line.length - 1) === ',' ? line.slice(0, -1).trim() : line));
    const isConstraint = (c) => ['UNIQUE', 'PRIMARY KEY', 'FOREIGN KEY', 'CHECK', 'CONSTRAINT'].some((p) => c.indexOf(p) === 0);
    tables[name] = { columns: entries, defs: entries.filter((c) => !isConstraint(c)) };
  }
  for (const [table, expected] of Object.entries(DXOS_AGENT_COLUMN_COUNTS)) {
    const found = tables[table];
    if (!found) throw new Error('缺少表 ' + table);
    if (found.defs.length !== expected) throw new Error(table + ' 列数不符：' + found.defs.length + ' != ' + expected);
    const names = found.defs.map((c) => c.slice(0, c.indexOf(' ')));
    for (const key of DXOS_AGENT_KEY_COLUMNS[table]) if (!names.includes(key)) throw new Error(table + ' 缺少关键列 ' + key);
    for (const def of found.columns) if (def.indexOf('REFERENCES') !== -1) throw new Error(table + ' 仍有外键：' + def);
  }
  return true;
}

module.exports = {
  DXOS_AGENT_TABLES,
  DXOS_AGENT_COLUMN_COUNTS,
  DXOS_AGENT_KEY_COLUMNS,
  DXOS_AGENT_INDEXES,
  DXOS_PROJECT_BRIDGE_DDL,
  DXOS_AGENT_DDL,
  dxosAgentDdl,
  dxosAgentSchemaSelfCheck,
};
