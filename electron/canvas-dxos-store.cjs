/**
 * B5c · 画布域新增表的持久层（素材库 / 素材条目 / Agent 附件挂载）。
 *
 * 与 canvas-store.cjs / resource-store.cjs 同一纪律：
 *   · 复用 IdentityStore 的同一条连接与同一个事务队列（不另开库）；
 *   · 只读写本域新增的 canvas_dxos_* 表；素材字节一律在 resource_* 表，
 *     这里只做索引与元数据（避免第二套素材系统）。
 */
"use strict";

const { ensureCanvasDxosSchema } = require("./canvas-dxos-schema.cjs");

const SQL = {
  // ---- 素材库 ----
  insertLibrary:
    "INSERT INTO canvas_dxos_asset_libraries (id, organization_id, owner_user_id, name, format, visibility, public_access, version, deleted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,?,?)",
  libraryById: "SELECT * FROM canvas_dxos_asset_libraries WHERE id = ?",
  librariesOwned: "SELECT * FROM canvas_dxos_asset_libraries WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id",
  librariesOrg: "SELECT * FROM canvas_dxos_asset_libraries WHERE organization_id = ? AND visibility IN ('ORGANIZATION','PUBLIC') AND deleted_at IS NULL ORDER BY updated_at DESC, id",
  librariesByMember:
    "SELECT l.* FROM canvas_dxos_asset_libraries l JOIN canvas_dxos_asset_library_members m ON m.library_id = l.id WHERE m.user_id = ? AND l.deleted_at IS NULL ORDER BY l.updated_at DESC, l.id",
  touchLibrary: "UPDATE canvas_dxos_asset_libraries SET name = ?, visibility = ?, public_access = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
  memberOfLibrary: "SELECT * FROM canvas_dxos_asset_library_members WHERE library_id = ? AND user_id = ?",
  membersOfLibrary: "SELECT * FROM canvas_dxos_asset_library_members WHERE library_id = ? ORDER BY role, user_id",
  upsertMember: "INSERT INTO canvas_dxos_asset_library_members (library_id, user_id, role, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(library_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at",
  deleteMember: "DELETE FROM canvas_dxos_asset_library_members WHERE library_id = ? AND user_id = ?",
  deleteMembersOfLibrary: "DELETE FROM canvas_dxos_asset_library_members WHERE library_id = ?",
  softDeleteLibrary: "UPDATE canvas_dxos_asset_libraries SET deleted_at = ?, updated_at = ? WHERE id = ?",
  restoreLibrary: "UPDATE canvas_dxos_asset_libraries SET deleted_at = NULL, updated_at = ? WHERE id = ?",
  purgeLibrary: "DELETE FROM canvas_dxos_asset_libraries WHERE id = ?",

  // ---- 素材条目 ----
  insertItem:
    "INSERT INTO canvas_dxos_asset_items (id, library_id, kind, title, group_name, relation_id, relation_name, relation_role, relation_primary, relation_prompt, prompt, model, category, source, source_key, tags_json, skill_id, prompt_role, media_kind, resource_ref, checksum, mime, bytes, cover_ref, workflow_json, versions_json, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  itemById: "SELECT * FROM canvas_dxos_asset_items WHERE id = ?",
  itemsOfLibrary: "SELECT * FROM canvas_dxos_asset_items WHERE library_id = ? ORDER BY updated_at DESC, id",
  itemBySourceKey: "SELECT * FROM canvas_dxos_asset_items WHERE library_id = ? AND source_key = ?",
  itemByResourceRef: "SELECT * FROM canvas_dxos_asset_items WHERE library_id = ? AND resource_ref = ? ORDER BY created_at, id LIMIT 1",
  deleteItem: "DELETE FROM canvas_dxos_asset_items WHERE id = ?",
  deleteItemsOfLibrary: "DELETE FROM canvas_dxos_asset_items WHERE library_id = ?",
  countItems: "SELECT COUNT(*) AS c FROM canvas_dxos_asset_items WHERE library_id = ?",
  countResourceRefs: "SELECT COUNT(*) AS c FROM canvas_dxos_asset_items WHERE resource_ref = ?",
  resourceRefsOfLibrary: "SELECT DISTINCT resource_ref FROM canvas_dxos_asset_items WHERE library_id = ? AND resource_ref IS NOT NULL",

  // ---- 资源域只读查询（去重的依据；不写 resource_* 表）----
  resourceByChecksum:
    "SELECT l.resource_id AS resource_id, l.name AS name, l.mime_type AS mime_type, l.size AS size, l.version AS version, " +
    "r.owner_user_id AS owner_user_id, r.organization_id AS organization_id, r.status AS registry_status " +
    "FROM library_resources l JOIN resource_registry r ON r.resource_id = l.resource_id " +
    "WHERE l.checksum = ? AND l.size = ? AND l.trash_state = 'ACTIVE' AND r.status = 'active' " +
    "ORDER BY l.created_at, l.resource_id LIMIT 1",

  // ---- Agent 附件 ----
  insertAttachment:
    "INSERT INTO canvas_dxos_agent_attachments (id, canvas_id, node_id, resource_ref, name, mime, bytes, content_chars, truncated, parse_error, run_id, mounted_by, created_at, removed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
  attachmentById: "SELECT * FROM canvas_dxos_agent_attachments WHERE id = ?",
  attachmentsOfCanvas: "SELECT * FROM canvas_dxos_agent_attachments WHERE canvas_id = ? AND (? = 1 OR removed_at IS NULL) ORDER BY created_at DESC, id",
  markAttachmentRemoved: "UPDATE canvas_dxos_agent_attachments SET removed_at = ? WHERE id = ? AND removed_at IS NULL",
  deleteAttachment: "DELETE FROM canvas_dxos_agent_attachments WHERE id = ?",
};

const asInt = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

class CanvasDxosStore {
  constructor({ identity, clock } = {}) {
    if (!identity || !identity.connection) throw new Error("CanvasDxosStore 需要 IdentityStore");
    this.identity = identity;
    this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
    ensureCanvasDxosSchema(identity);
  }

  transactSync(fn) { return this.identity.transactSync(fn); }
  now() { return Number(this.clock()); }

  // -------------------------------------------------------------- 素材库

  insertLibrary({ id, organizationId, ownerUserId, name, format, visibility = "PRIVATE", publicAccess = "read" }) {
    const now = this.now();
    this.db.prepare(SQL.insertLibrary).run(String(id), String(organizationId), String(ownerUserId), String(name), String(format), String(visibility), String(publicAccess), 1, now, now);
    return this.libraryById(id);
  }
  libraryById(id) { return this.db.prepare(SQL.libraryById).get(String(id || "")) || null; }
  librariesOwned(userId) { return this.db.prepare(SQL.librariesOwned).all(String(userId)); }
  librariesOrg(organizationId) { return this.db.prepare(SQL.librariesOrg).all(String(organizationId)); }
  librariesByMember(userId) { return this.db.prepare(SQL.librariesByMember).all(String(userId)); }

  /** 基准版本检查写（与 canvas-store.updateDoc 同一纪律：changes=0 即冲突，返回 null）。 */
  touchLibrary({ id, name, visibility, publicAccess, baseVersion }) {
    const result = this.db.prepare(SQL.touchLibrary).run(String(name), String(visibility), String(publicAccess), this.now(), String(id), Number(baseVersion));
    return Number(result.changes) > 0 ? this.libraryById(id) : null;
  }

  memberOfLibrary(libraryId, userId) { return this.db.prepare(SQL.memberOfLibrary).get(String(libraryId), String(userId)) || null; }
  membersOfLibrary(libraryId) { return this.db.prepare(SQL.membersOfLibrary).all(String(libraryId)); }
  upsertMember({ libraryId, userId, role }) {
    const now = this.now();
    this.db.prepare(SQL.upsertMember).run(String(libraryId), String(userId), String(role), now, now);
    return this.memberOfLibrary(libraryId, userId);
  }
  deleteMember({ libraryId, userId }) { return this.db.prepare(SQL.deleteMember).run(String(libraryId), String(userId)).changes > 0; }
  softDeleteLibrary({ id }) { this.db.prepare(SQL.softDeleteLibrary).run(this.now(), this.now(), String(id)); return this.libraryById(id); }
  restoreLibrary({ id }) { this.db.prepare(SQL.restoreLibrary).run(this.now(), String(id)); return this.libraryById(id); }
  purgeLibrary({ id }) { this.transactSync(() => { this.db.prepare(SQL.deleteItemsOfLibrary).run(String(id)); this.db.prepare(SQL.deleteMembersOfLibrary).run(String(id)); this.db.prepare(SQL.purgeLibrary).run(String(id)); }); return true; }

  // -------------------------------------------------------------- 素材条目

  insertItem(row) {
    this.db.prepare(SQL.insertItem).run(
      String(row.id), String(row.libraryId), String(row.kind), String(row.title),
      row.group == null ? null : String(row.group),
      row.relationId == null ? null : String(row.relationId), row.relationName == null ? null : String(row.relationName),
      row.relationRole == null ? null : String(row.relationRole), row.relationPrimary ? 1 : null,
      row.relationPrompt == null ? null : String(row.relationPrompt),
      String(row.prompt || ""),
      row.model == null ? null : String(row.model), row.category == null ? null : String(row.category),
      row.source == null ? null : String(row.source), row.sourceKey == null ? null : String(row.sourceKey),
      JSON.stringify(Array.isArray(row.tags) ? row.tags : []), row.skillId == null ? null : String(row.skillId),
      row.promptRole == null ? null : String(row.promptRole), row.mediaKind == null ? null : String(row.mediaKind),
      row.resourceRef == null ? null : String(row.resourceRef), row.checksum == null ? null : String(row.checksum),
      row.mime == null ? null : String(row.mime), asInt(row.bytes), row.coverRef == null ? null : String(row.coverRef),
      row.workflow === undefined ? null : JSON.stringify(row.workflow),
      row.versions === undefined ? null : JSON.stringify(row.versions),
      String(row.createdBy), Number(row.createdAt) || this.now(), Number(row.updatedAt) || this.now(),
    );
    return this.itemById(row.id);
  }
  itemById(id) { return this.db.prepare(SQL.itemById).get(String(id || "")) || null; }
  itemsOfLibrary(libraryId) { return this.db.prepare(SQL.itemsOfLibrary).all(String(libraryId)); }
  itemBySourceKey(libraryId, sourceKey) { return this.db.prepare(SQL.itemBySourceKey).get(String(libraryId), String(sourceKey)) || null; }
  itemByResourceRef(libraryId, resourceRef) { return this.db.prepare(SQL.itemByResourceRef).get(String(libraryId), String(resourceRef)) || null; }
  countItems(libraryId) { const row = this.db.prepare(SQL.countItems).get(String(libraryId)); return row ? Number(row.c) : 0; }
  countResourceRefs(resourceRef) { const row = this.db.prepare(SQL.countResourceRefs).get(String(resourceRef)); return row ? Number(row.c) : 0; }
  resourceRefsOfLibrary(libraryId) { return this.db.prepare(SQL.resourceRefsOfLibrary).all(String(libraryId)).map((row) => row.resource_ref); }

  /** 只更新"元数据"列，不做基准版本检查（条目级并发由 sourceKey 唯一键兜底）。 */
  updateItem(id, patch = {}) {
    const allowed = {
      title: "title", group: "group_name", prompt: "prompt", model: "model", category: "category",
      source: "source", sourceKey: "source_key", skillId: "skill_id", promptRole: "prompt_role",
      mediaKind: "media_kind", resourceRef: "resource_ref", checksum: "checksum", mime: "mime",
      bytes: "bytes", coverRef: "cover_ref",
      relationId: "relation_id", relationName: "relation_name", relationRole: "relation_role",
      relationPrompt: "relation_prompt",
    };
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(allowed)) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      sets.push(column + " = ?");
      values.push(patch[key] == null ? null : patch[key]);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "tags")) { sets.push("tags_json = ?"); values.push(JSON.stringify(Array.isArray(patch.tags) ? patch.tags : [])); }
    // relation_primary 是布尔语义，不能直接绑 boolean（node:sqlite 只收 null/number/bigint/string/Buffer）。
    if (Object.prototype.hasOwnProperty.call(patch, "relationPrimary")) { sets.push("relation_primary = ?"); values.push(patch.relationPrimary ? 1 : null); }
    // undefined 必须落成 NULL：JSON.stringify(undefined) 本身是 undefined，直接绑定会抛 ERR_INVALID_ARG_TYPE。
    if (Object.prototype.hasOwnProperty.call(patch, "workflow")) { sets.push("workflow_json = ?"); values.push(patch.workflow == null ? null : JSON.stringify(patch.workflow)); }
    if (Object.prototype.hasOwnProperty.call(patch, "versions")) { sets.push("versions_json = ?"); values.push(patch.versions == null ? null : JSON.stringify(patch.versions)); }
    sets.push("updated_at = ?");
    values.push(this.now());
    values.push(String(id));
    this.db.prepare("UPDATE canvas_dxos_asset_items SET " + sets.join(", ") + " WHERE id = ?").run(...values);
    return this.itemById(id);
  }
  deleteItem(id) { this.db.prepare(SQL.deleteItem).run(String(id)); return true; }

  /** 资源域去重查询：同 checksum+size 且未被回收的既有资源。 */
  resourceByChecksum(checksum, size) {
    if (!checksum || !Number.isFinite(Number(size))) return null;
    return this.db.prepare(SQL.resourceByChecksum).get(String(checksum), Number(size)) || null;
  }

  // -------------------------------------------------------------- Agent 附件

  insertAttachment(row) {
    this.db.prepare(SQL.insertAttachment).run(
      String(row.id), String(row.canvasId), row.nodeId == null ? null : String(row.nodeId),
      row.resourceRef == null ? null : String(row.resourceRef), String(row.name), String(row.mime),
      Number(row.bytes) || 0, Number(row.contentChars) || 0, row.truncated ? 1 : 0,
      row.parseError == null ? null : String(row.parseError), row.runId == null ? null : String(row.runId),
      String(row.mountedBy), this.now(),
    );
    return this.attachmentById(row.id);
  }
  attachmentById(id) { return this.db.prepare(SQL.attachmentById).get(String(id || "")) || null; }
  attachmentsOfCanvas(canvasId, includeRemoved = false) { return this.db.prepare(SQL.attachmentsOfCanvas).all(String(canvasId), includeRemoved ? 1 : 0); }
  markAttachmentRemoved(id) { this.db.prepare(SQL.markAttachmentRemoved).run(this.now(), String(id)); return this.attachmentById(id); }
  deleteAttachment(id) { this.db.prepare(SQL.deleteAttachment).run(String(id)); return true; }
}

module.exports = { CanvasDxosStore, SQL };
