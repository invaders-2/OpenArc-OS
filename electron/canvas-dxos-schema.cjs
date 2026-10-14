/**
 * B5c · 画布域新增表的 DDL 与迁移函数。
 *
 * 迁移框架：本仓只有 identity-store.cjs 的 MIGRATIONS 一条迁移链（B5d 收口后 SCHEMA_VERSION=25）。
 * B5a（媒体域）与本域同批落地，版本号由 Lead 统一编号：
 *   ① 导出 applyCanvasDxosLayer(db) —— 放进 MIGRATIONS 的 v25 迁移函数；
 *   ② 导出 CANVAS_DXOS_MIGRATION = { version: 25, run: applyCanvasDxosLayer } —— 已固定的版本号
 *      （v24 已被 B5a 的 applyDxosMediaLayer 占用）；DDL 全部 IF NOT EXISTS，可重放；
 *   ③ CanvasDxosStore 构造时调用 ensureCanvasDxosSchema(db) 幂等自建（新库/已迁移库都安全）。
 * 三级都指向同一份 DDL，不存在第二份 schema 真值。
 *
 * 为什么新增表而不复用既有画布表：
 *   · 素材库条目（prompt/workflow/asset 三种 kind + 版本历史）在 canvas_boards.doc 里放不住 ——
 *     canvas-domain.normalizeDoc 只保留 nodes/connections/viewport/logs，会静默丢字段；
 *   · Agent 附件需要「挂载/卸载」的独立生命周期，塞进节点字段会让画布文档承担审计职责。
 *   **素材字节仍然只在 resource_* 表**（content_objects / library_resources / resource_registry），
 *   这里只存索引与元数据，不建第二套素材系统。
 */
"use strict";

const CANVAS_DXOS_DDL = Object.freeze([
  // 素材库（一个用户可以有多个；默认库名沿用源 canvasAssetLibrary.ts:21 的「我的资产库」）
  "CREATE TABLE IF NOT EXISTS canvas_dxos_asset_libraries (\n" +
  "  id              TEXT PRIMARY KEY,\n" +
  "  organization_id TEXT NOT NULL,\n" +
  "  owner_user_id   TEXT NOT NULL,\n" +
  "  name            TEXT NOT NULL,\n" +
  "  format          TEXT NOT NULL,\n" +
  "  visibility      TEXT NOT NULL DEFAULT 'PRIVATE',\n" +
  "  version         INTEGER NOT NULL DEFAULT 1,\n" +
  "  deleted_at      INTEGER,\n" +
  "  created_at      INTEGER NOT NULL,\n" +
  "  updated_at      INTEGER NOT NULL\n" +
  ")",
  "CREATE INDEX IF NOT EXISTS idx_canvas_dxos_libraries_owner ON canvas_dxos_asset_libraries(owner_user_id, deleted_at, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_canvas_dxos_libraries_org ON canvas_dxos_asset_libraries(organization_id, visibility, deleted_at)",
  // 素材库条目（asset / prompt / workflow，字段对齐源 shared/canvasAssetLibrary.ts:33-67）
  "CREATE TABLE IF NOT EXISTS canvas_dxos_asset_items (\n" +
  "  id            TEXT PRIMARY KEY,\n" +
  "  library_id    TEXT NOT NULL,\n" +
  "  kind          TEXT NOT NULL,\n" +
  "  title         TEXT NOT NULL,\n" +
  "  group_name    TEXT,\n" +
  "  prompt        TEXT NOT NULL DEFAULT '',\n" +
  "  model         TEXT,\n" +
  "  category      TEXT,\n" +
  "  source        TEXT,\n" +
  "  source_key    TEXT,\n" +
  "  tags_json     TEXT NOT NULL DEFAULT '[]',\n" +
  "  skill_id      TEXT,\n" +
  "  prompt_role   TEXT,\n" +
  "  media_kind    TEXT,\n" +
  "  resource_ref  TEXT,\n" +
  "  checksum      TEXT,\n" +
  "  mime          TEXT,\n" +
  "  bytes         INTEGER,\n" +
  "  cover_ref     TEXT,\n" +
  "  workflow_json TEXT,\n" +
  "  versions_json TEXT,\n" +
  "  created_by    TEXT NOT NULL,\n" +
  "  created_at    INTEGER NOT NULL,\n" +
  "  updated_at    INTEGER NOT NULL\n" +
  ")",
  "CREATE INDEX IF NOT EXISTS idx_canvas_dxos_items_library ON canvas_dxos_asset_items(library_id, updated_at DESC, id)",
  "CREATE INDEX IF NOT EXISTS idx_canvas_dxos_items_resource ON canvas_dxos_asset_items(resource_ref)",
  "CREATE INDEX IF NOT EXISTS idx_canvas_dxos_items_checksum ON canvas_dxos_asset_items(checksum)",
  // 源 canvasAssetLibrary.ts:174-178 用 sourceKey 去重同一份外部来源；这里落成库内唯一键
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_dxos_items_source_key ON canvas_dxos_asset_items(library_id, source_key) WHERE source_key IS NOT NULL",
  // Agent 附件挂载（源 canvasAgentAttachments.ts:80-104 只做文本抽取；挂载生命周期是本仓新增语义）
  "CREATE TABLE IF NOT EXISTS canvas_dxos_agent_attachments (\n" +
  "  id            TEXT PRIMARY KEY,\n" +
  "  canvas_id     TEXT NOT NULL,\n" +
  "  node_id       TEXT,\n" +
  "  resource_ref  TEXT,\n" +
  "  name          TEXT NOT NULL,\n" +
  "  mime          TEXT NOT NULL,\n" +
  "  bytes         INTEGER NOT NULL DEFAULT 0,\n" +
  "  content_chars INTEGER NOT NULL DEFAULT 0,\n" +
  "  truncated     INTEGER NOT NULL DEFAULT 0,\n" +
  "  parse_error   TEXT,\n" +
  "  run_id        TEXT,\n" +
  "  mounted_by    TEXT NOT NULL,\n" +
  "  created_at    INTEGER NOT NULL,\n" +
  "  removed_at    INTEGER\n" +
  ")",
  "CREATE INDEX IF NOT EXISTS idx_canvas_dxos_attachments_canvas ON canvas_dxos_agent_attachments(canvas_id, removed_at, created_at DESC)",
]);

function canvasDxosDdl() {
  return [...CANVAS_DXOS_DDL];
}

/** 迁移函数：整级随外层事务回滚，可重放（全部 IF NOT EXISTS）。 */
function applyCanvasDxosLayer(db) {
  if (!db || typeof db.exec !== "function") throw new Error("applyCanvasDxosLayer 需要 sqlite 连接");
  for (const statement of CANVAS_DXOS_DDL) db.exec(statement);
}

/**
 * 幂等自建：直接调用方（如测试夹具）在 v25 迁移之外补建时的落点。已建过时是一次空跑。
 */
function ensureCanvasDxosSchema(identity) {
  if (!identity || typeof identity.transactSync !== "function" || !identity.connection) throw new Error("ensureCanvasDxosSchema 需要 IdentityStore");
  return identity.transactSync(() => applyCanvasDxosLayer(identity.connection));
}

/** v25 迁移条目（identity-store.MIGRATIONS 直接引用；DDL 可重放，改号不丢数据）。 */
const CANVAS_DXOS_MIGRATION = Object.freeze({ version: 25, run: applyCanvasDxosLayer });

module.exports = { CANVAS_DXOS_DDL, canvasDxosDdl, applyCanvasDxosLayer, ensureCanvasDxosSchema, CANVAS_DXOS_MIGRATION };
