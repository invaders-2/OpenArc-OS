/**
 * P1 · 任务域**只读统一视图**结构（两套任务表的 SQL 层公共读形状）。
 *
 * ## 边界（与 task-unified-view.cjs 的边界同源）
 *   · 只新增视图，**不改**任一物理表、不搬一行数据、不复制任一状态机；
 *   · 视图是纯投影：core 7 态与 DX 11 态都原样落在 status 列，统一词汇仍在读模型层推导；
 *   · 视图只读（SQLite 视图不可写，已由 tests/dxos-task-unified-views.test.mjs 断言）。
 *
 * ## 为什么用独立 ensure 而不是接进 identity-store.MIGRATIONS
 *   Dx-TASK-MERGE-PLAN.md §5.2（替代方案 A）明确：建视图可走 v27，也可走幂等 ensure。
 *   接进 MIGRATIONS 会把 SCHEMA_VERSION 从 26 推到 27，牵动 12 个测试文件的 37 处版本冻结断言
 *   （同文档 R2）；本任务取低风险路径，只做幂等 ensure，不动 SCHEMA_VERSION，
 *   也不改 identity-store.cjs。ensure 的调用点是 agent-task-store.cjs 的 configureAgentTaskStore
 *   —— 它是生产链路（agent-service.createAgentBundle）里读模型使用前必经的装配点。
 *
 * ## 幂等 / 可重放
 *   三条 CREATE VIEW IF NOT EXISTS：重复执行是空跑；新库、旧库补建结果一致。
 *   视图定义变更需要新的迁移版本或显式重建，IF NOT EXISTS 不会覆盖旧定义。
 *
 * ## 视图列（与 task-unified-view.cjs 现有投影一一对应）
 *   v_task_unified        source / id / title / status / created_at / updated_at / started_at /
 *                         completed_at / step_count / event_count / last_event_type /
 *                         last_event_message / last_event_at / owner_id
 *   v_task_step_unified   source / task_id / step_id / ordinal / title / tool_name / status /
 *                         input_json / output_json / output_ref / operation_id / created_at /
 *                         started_at / completed_at / attempt / max_attempts
 *   v_task_event_unified  source / task_id / event_id / sequence / type / message /
 *                         payload_json / created_at
 */
"use strict";

/** 三条只读视图名（唯一真值；读模型侧的名称漂移由测试对齐）。 */
const TASK_UNIFIED_VIEW_NAMES = Object.freeze(["v_task_unified", "v_task_step_unified", "v_task_event_unified"]);

/**
 * v_task_unified：任务级 UNION ALL。
 *   · core 侧 title 取既有语义最贴近的 goal；owner_id 取 user_id；
 *   · dx 侧 title/created_by 直用；最近事件按 dx_task_events.id DESC（AUTOINCREMENT，插入序），
 *     core 按 task_events.sequence DESC；
 *   · core 的 safe_payload 用 json_valid 守卫后再取 $.message（坏 JSON 返回 NULL，不抛错）。
 */
const TASK_VIEW_TASK_SQL = `CREATE VIEW IF NOT EXISTS v_task_unified AS
SELECT
  'core' AS source,
  t.task_id AS id,
  t.goal AS title,
  t.status AS status,
  t.created_at AS created_at,
  t.updated_at AS updated_at,
  t.started_at AS started_at,
  t.completed_at AS completed_at,
  (SELECT COUNT(*) FROM task_steps s WHERE s.task_id = t.task_id) AS step_count,
  (SELECT COUNT(*) FROM task_events e WHERE e.task_id = t.task_id) AS event_count,
  (SELECT e.event_type FROM task_events e WHERE e.task_id = t.task_id ORDER BY e.sequence DESC LIMIT 1) AS last_event_type,
  (SELECT CASE WHEN json_valid(e.safe_payload) THEN json_extract(e.safe_payload, '$.message') ELSE NULL END
     FROM task_events e WHERE e.task_id = t.task_id ORDER BY e.sequence DESC LIMIT 1) AS last_event_message,
  (SELECT e.created_at FROM task_events e WHERE e.task_id = t.task_id ORDER BY e.sequence DESC LIMIT 1) AS last_event_at,
  t.user_id AS owner_id
FROM tasks t
UNION ALL
SELECT
  'dx' AS source,
  t.id AS id,
  t.title AS title,
  t.status AS status,
  t.created_at AS created_at,
  t.updated_at AS updated_at,
  t.started_at AS started_at,
  t.completed_at AS completed_at,
  (SELECT COUNT(*) FROM dx_task_steps s WHERE s.task_id = t.id) AS step_count,
  (SELECT COUNT(*) FROM dx_task_events e WHERE e.task_id = t.id) AS event_count,
  (SELECT e.type FROM dx_task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS last_event_type,
  (SELECT e.message FROM dx_task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS last_event_message,
  (SELECT e.created_at FROM dx_task_events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS last_event_at,
  t.created_by AS owner_id
FROM dx_tasks t`;

/**
 * v_task_step_unified：步骤级 UNION ALL。
 *   core 的 output_ref 与 dx 的 output_json 是两套列语义，各自保留，不做猜测性互相填充。
 */
const TASK_VIEW_STEP_SQL = `CREATE VIEW IF NOT EXISTS v_task_step_unified AS
SELECT
  'core' AS source,
  s.task_id AS task_id,
  s.step_id AS step_id,
  s.sequence AS ordinal,
  s.kind AS title,
  s.kind AS tool_name,
  s.status AS status,
  s.input AS input_json,
  NULL AS output_json,
  s.output_ref AS output_ref,
  NULL AS operation_id,
  NULL AS created_at,
  s.started_at AS started_at,
  s.completed_at AS completed_at,
  s.attempt AS attempt,
  s.max_attempts AS max_attempts
FROM task_steps s
UNION ALL
SELECT
  'dx' AS source,
  s.task_id AS task_id,
  s.id AS step_id,
  s.ordinal AS ordinal,
  s.title AS title,
  s.tool_name AS tool_name,
  s.status AS status,
  s.input_json AS input_json,
  s.output_json AS output_json,
  NULL AS output_ref,
  s.operation_id AS operation_id,
  s.created_at AS created_at,
  s.started_at AS started_at,
  s.completed_at AS completed_at,
  NULL AS attempt,
  NULL AS max_attempts
FROM dx_task_steps s`;

/** v_task_event_unified：事件级 UNION ALL（dx 的 AUTOINCREMENT id 以文本 event_id 暴露）。 */
const TASK_VIEW_EVENT_SQL = `CREATE VIEW IF NOT EXISTS v_task_event_unified AS
SELECT
  'core' AS source,
  e.task_id AS task_id,
  e.event_id AS event_id,
  e.sequence AS sequence,
  e.event_type AS type,
  CASE WHEN json_valid(e.safe_payload) THEN json_extract(e.safe_payload, '$.message') ELSE NULL END AS message,
  e.safe_payload AS payload_json,
  e.created_at AS created_at
FROM task_events e
UNION ALL
SELECT
  'dx' AS source,
  e.task_id AS task_id,
  CAST(e.id AS TEXT) AS event_id,
  e.sequence AS sequence,
  e.type AS type,
  e.message AS message,
  e.data_json AS payload_json,
  e.created_at AS created_at
FROM dx_task_events e`;

/** 幂等 DDL：只三条 CREATE VIEW IF NOT EXISTS。 */
const TASK_UNIFIED_VIEW_DDL = Object.freeze([TASK_VIEW_TASK_SQL, TASK_VIEW_STEP_SQL, TASK_VIEW_EVENT_SQL]);

/** 幂等应用：只建三条视图；传入的连接必须可用（失败大声抛，不静默）。 */
function applyTaskUnifiedViewLayer(db) {
  if (!db || typeof db.exec !== "function") throw new Error("applyTaskUnifiedViewLayer 需要 sqlite 连接");
  for (const statement of TASK_UNIFIED_VIEW_DDL) db.exec(statement);
}

/**
 * 幂等自建入口：接受裸 sqlite 连接（agent-task-store.configureAgentTaskStore 传的就是它），
 * 也接受 IdentityStore（走它的 transactSync，保持与其它 *-schema.cjs 同形）。
 */
function ensureTaskUnifiedViews(target) {
  if (target && typeof target.exec === "function") {
    applyTaskUnifiedViewLayer(target);
    return true;
  }
  const connection = target && target.connection;
  if (connection && typeof connection.exec === "function") {
    if (typeof target.transactSync === "function") target.transactSync(() => applyTaskUnifiedViewLayer(connection));
    else applyTaskUnifiedViewLayer(connection);
    return true;
  }
  throw new Error("ensureTaskUnifiedViews 需要 sqlite 连接或 IdentityStore");
}

/**
 * 预留迁移描述符（version 27）。**刻意不接进** identity-store.MIGRATIONS：
 * 接入即 SCHEMA_VERSION=27，会改动冻结版本基线；本任务取 §5.2 的独立 ensure 路径。
 */
const TASK_UNIFIED_VIEW_MIGRATION = Object.freeze({ version: 27, run: applyTaskUnifiedViewLayer });

module.exports = {
  TASK_UNIFIED_VIEW_NAMES,
  TASK_UNIFIED_VIEW_DDL,
  applyTaskUnifiedViewLayer,
  ensureTaskUnifiedViews,
  TASK_UNIFIED_VIEW_MIGRATION,
};
