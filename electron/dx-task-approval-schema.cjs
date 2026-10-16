/**
 * B3a/D5-04 补丁 · DX 任务 → 核心审批任务 的**幂等映射桥**表结构（只新增，不改既有表）。
 *
 * 迁移框架：本仓只有 identity-store.cjs 的 MIGRATIONS 一条迁移链（本文件接入后 SCHEMA_VERSION=26）。
 *   ① 导出 applyDxTaskApprovalLayer(db) —— 放进 MIGRATIONS 的 v26 迁移函数；
 *   ② 导出 DX_TASK_APPROVAL_MIGRATION = { version: 26, run: applyDxTaskApprovalLayer }；
 *   ③ ensureDxTaskApprovalSchema(identity) —— 直接调用方（测试夹具）在 v26 之外补建时的落点。
 * 三级都指向同一份 DDL，不存在第二份 schema 真值；DDL 全部 IF NOT EXISTS，可重放。
 *
 * 为什么新增一张映射表而不是合并表：
 *   DX 任务域（dx_tasks / dx_task_steps）与核心审批域（tasks / task_steps / task_harness_runs）
 *   是两套各自独立的身份与状态机；硬约束禁止表级合并、禁止改既有表结构。
 *   因此只新增本映射表，把"某条 dx 任务步骤 ↔ 某个核心审批任务/步骤/运行"这一条**身份关系**
 *   持久化下来；审批状态机（approval / lease / claim / verify / audit）仍由既有
 *   SideEffectAuthority 与 Task Runtime 唯一裁决，本表不复制任何审批状态。
 *
 * 幂等键：(dx_task_id, dx_step_id)。dx_step_id 缺省用 ''（SQLite 主键里 NULL 互不相等，
 * 会让同一 dx 任务重复建行）；反向查找靠 core_task_id / core_step_id / core_run_id 的 UNIQUE。
 */
"use strict";

const DX_TASK_APPROVAL_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS dx_task_approval_bridge (" +
  "\n  dx_task_id   TEXT NOT NULL," +
  "\n  dx_step_id   TEXT NOT NULL DEFAULT ''," +
  "\n  dx_run_id    TEXT," +
  "\n  core_task_id TEXT NOT NULL UNIQUE," +
  "\n  core_step_id TEXT NOT NULL UNIQUE," +
  "\n  core_run_id  TEXT NOT NULL UNIQUE," +
  "\n  created_at   INTEGER NOT NULL," +
  "\n  updated_at   INTEGER NOT NULL," +
  "\n  PRIMARY KEY (dx_task_id, dx_step_id)" +
  "\n)",
  "CREATE INDEX IF NOT EXISTS idx_dx_task_approval_bridge_dx ON dx_task_approval_bridge(dx_task_id, dx_step_id)",
]);

/** 幂等 DDL 应用：只建本桥接表（与其它 *-schema.cjs 同一做法）。 */
function applyDxTaskApprovalLayer(db) {
  if (!db || typeof db.exec !== "function") throw new Error("applyDxTaskApprovalLayer 需要 sqlite 连接");
  for (const statement of DX_TASK_APPROVAL_DDL) db.exec(statement);
}

/** 幂等自建：直接调用方（测试夹具）在 v26 迁移之外补建时的落点；已建过时是一次空跑。 */
function ensureDxTaskApprovalSchema(identity) {
  if (!identity || typeof identity.transactSync !== "function" || !identity.connection) throw new Error("ensureDxTaskApprovalSchema 需要 IdentityStore");
  return identity.transactSync(() => applyDxTaskApprovalLayer(identity.connection));
}

/** v26 迁移条目（identity-store.MIGRATIONS 直接引用；DDL 可重放，改号不丢数据）。 */
const DX_TASK_APPROVAL_MIGRATION = Object.freeze({ version: 26, run: applyDxTaskApprovalLayer });

module.exports = { DX_TASK_APPROVAL_DDL, applyDxTaskApprovalLayer, ensureDxTaskApprovalSchema, DX_TASK_APPROVAL_MIGRATION };
