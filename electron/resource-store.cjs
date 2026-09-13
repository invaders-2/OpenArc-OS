/**
 * D3-04A · Resource Store 持久层。
 *
 * **不是第二套数据库权威**：复用 IdentityStore 的同一条连接与同一个事务队列。
 * resource_registry 仍是逻辑身份 / 授权权威；library_resources 只承载存储语义。
 *
 * 这里绝不写 "DB + filesystem atomic transaction"：FS 的 promote 与 DB 的 commit
 * 是两个独立边界，中间的孤儿由 recovery / GC 处理（§20 §54）。
 */
"use strict";

const domain = require("./resource-domain.cjs");
const authz = require("./authorization-domain.cjs");

const { ok, fail, REASON } = domain;

const LIB_SELECT =
  "SELECT r.resource_id AS resource_id, r.resource_type AS resource_type, r.owner_user_id AS owner_user_id, " +
  "r.organization_id AS organization_id, r.department_id AS department_id, r.collection_id AS collection_id, " +
  "r.scope AS scope, r.parent_resource_id AS parent_resource_id, r.name AS name, r.description AS description, " +
  "r.tags AS tags, r.status AS registry_status, r.created_at AS created_at, r.updated_at AS updated_at, " +
  "l.mime_type AS mime_type, l.storage_mode AS storage_mode, l.content_object_id AS content_object_id, " +
  "l.checksum AS checksum, l.size AS size, l.source AS source, l.version AS version, " +
  "l.storage_device_id AS storage_device_id, l.source_locator AS source_locator, l.source_identity AS source_identity, " +
  "l.observed_size AS observed_size, l.observed_mtime AS observed_mtime, l.index_status AS index_status, " +
  "l.trash_state AS trash_state, l.deleted_at AS deleted_at, l.deleted_by AS deleted_by, " +
  "l.generated_source_task_id AS generated_source_task_id, l.generated_source_call_id AS generated_source_call_id, " +
  "l.generated_source_model AS generated_source_model, l.memory_subtype AS memory_subtype, l.language AS language, l.attributes AS attributes, " +
  "l.created_at AS library_created_at, l.updated_at AS library_updated_at " +
  "FROM resource_registry r LEFT JOIN library_resources l ON l.resource_id = r.resource_id";

const SQL = {
  insertContent:
    "INSERT OR IGNORE INTO content_objects (content_id, checksum_algorithm, checksum, size, internal_key, ref_count, status, organization_id, created_at, updated_at) VALUES (?,?,?,?,?,?, 'OBJECT_READY', ?,?,?)",
  contentById: "SELECT * FROM content_objects WHERE content_id = ?",
  contentByChecksum: "SELECT * FROM content_objects WHERE checksum_algorithm = ? AND checksum = ? AND size = ?",
  contentByInternalKey: "SELECT * FROM content_objects WHERE internal_key = ?",
  setContentStatus: "UPDATE content_objects SET status = ?, updated_at = ? WHERE content_id = ?",
  setContentRefCount: "UPDATE content_objects SET ref_count = ?, updated_at = ? WHERE content_id = ?",
  allContent: "SELECT * FROM content_objects ORDER BY created_at, content_id",
  orphanContent:
    "SELECT c.* FROM content_objects c WHERE c.status = 'OBJECT_READY' " +
    "AND NOT EXISTS (SELECT 1 FROM library_resources l WHERE l.content_object_id = c.content_id) " +
    "AND NOT EXISTS (SELECT 1 FROM resource_versions v WHERE v.content_object_id = c.content_id)",

  insertLibrary:
    "INSERT INTO library_resources (resource_id, resource_type, mime_type, name, description, storage_mode, content_object_id, checksum, size, source, version, storage_device_id, source_locator, source_identity, observed_size, observed_mtime, generated_source_task_id, generated_source_call_id, generated_source_model, memory_subtype, language, attributes, index_status, trash_state, deleted_at, deleted_by, created_at, updated_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  libraryById: "SELECT * FROM library_resources WHERE resource_id = ?",
  deleteLibrary: "DELETE FROM library_resources WHERE resource_id = ?",
  nextVersionNumber: "SELECT COALESCE(MAX(version), 0) AS max_version FROM resource_versions WHERE resource_id = ?",

  insertVersion:
    "INSERT INTO resource_versions (id, resource_id, version, content_object_id, checksum, size, storage_mode, storage_device_id, source_locator, source, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  versionByNumber: "SELECT * FROM resource_versions WHERE resource_id = ? AND version = ?",
  versionsOf: "SELECT * FROM resource_versions WHERE resource_id = ? ORDER BY version ASC",
  versionsByContent: "SELECT * FROM resource_versions WHERE content_object_id = ?",
  contentRefResources: "SELECT resource_id FROM resource_versions WHERE content_object_id = ?",
  contentRefLibrary: "SELECT resource_id FROM library_resources WHERE content_object_id = ?",

  insertRelation:
    "INSERT OR IGNORE INTO resource_relations (id, organization_id, from_resource_id, to_resource_id, relation_type, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
  relationsFrom: "SELECT * FROM resource_relations WHERE from_resource_id = ? ORDER BY created_at, id",
  relationsTo: "SELECT * FROM resource_relations WHERE to_resource_id = ? ORDER BY created_at, id",

  insertJob:
    "INSERT INTO resource_import_jobs (id, organization_id, actor_user_id, app_id, storage_mode, phase, staging_key, source_locator, checksum, size, bytes_total, bytes_processed, resource_id, error_code, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  jobById: "SELECT * FROM resource_import_jobs WHERE id = ?",
  updateJob: "UPDATE resource_import_jobs SET phase = ?, staging_key = ?, checksum = ?, size = ?, bytes_total = ?, bytes_processed = ?, resource_id = ?, error_code = ?, updated_at = ? WHERE id = ?",
  unfinishedJobs: "SELECT * FROM resource_import_jobs WHERE phase NOT IN ('AVAILABLE','FAILED','CANCELLED','ORPHANED') ORDER BY created_at, id",
  allJobs: "SELECT * FROM resource_import_jobs ORDER BY created_at, id",

  insertRegistry:
    "INSERT INTO resource_registry (resource_id, resource_type, owner_user_id, organization_id, department_id, collection_id, scope, parent_resource_id, name, description, tags, version, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?,?)",
  updateRegistryVersion: "UPDATE resource_registry SET version = ?, updated_at = ? WHERE resource_id = ?",
  updateRegistryName: "UPDATE resource_registry SET name = ?, description = ?, updated_at = ? WHERE resource_id = ?",
  setRegistryStatus: "UPDATE resource_registry SET status = ?, updated_at = ? WHERE resource_id = ?",
  deleteRegistry: "DELETE FROM resource_registry WHERE resource_id = ?",
  updateRegistryMetadata: "UPDATE resource_registry SET name = ?, description = ?, collection_id = ?, updated_at = ? WHERE resource_id = ?",
  setRegistryTags: "UPDATE resource_registry SET tags = ?, updated_at = ? WHERE resource_id = ?",

  insertTag:
    "INSERT INTO tags (id, organization_id, name, normalized_name, source, created_by, status, created_at, updated_at) VALUES (?,?,?,?,?,?, 'active', ?,?)",
  tagById: "SELECT * FROM tags WHERE id = ?",
  tagByNormalized: "SELECT * FROM tags WHERE organization_id = ? AND normalized_name = ?",
  tagsOfOrg: "SELECT * FROM tags WHERE organization_id = ? AND status = 'active' ORDER BY normalized_name, id",
  updateTagName: "UPDATE tags SET name = ?, normalized_name = ?, updated_at = ? WHERE id = ?",
  setTagStatus: "UPDATE tags SET status = ?, updated_at = ? WHERE id = ?",

  insertResourceTag:
    "INSERT OR IGNORE INTO resource_tags (id, resource_id, tag_id, organization_id, source, assigned_by, created_at) VALUES (?,?,?,?,?,?,?)",
  deleteResourceTag: "DELETE FROM resource_tags WHERE resource_id = ? AND tag_id = ?",
  tagsOfResource:
    "SELECT t.*, rt.source AS assignment_source, rt.assigned_by, rt.created_at AS assigned_at FROM resource_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.resource_id = ? ORDER BY t.normalized_name, t.id",
  resourcesOfTag: "SELECT resource_id FROM resource_tags WHERE tag_id = ?",
  countResourceTags: "SELECT COUNT(*) AS c FROM resource_tags WHERE resource_id = ?",

  upsertFavorite: "INSERT OR IGNORE INTO resource_favorites (user_id, resource_id, organization_id, created_at) VALUES (?,?,?,?)",
  deleteFavorite: "DELETE FROM resource_favorites WHERE user_id = ? AND resource_id = ?",
  favoriteOf: "SELECT * FROM resource_favorites WHERE user_id = ? AND resource_id = ?",
  favoritesOfUser: "SELECT resource_id, created_at FROM resource_favorites WHERE user_id = ? ORDER BY created_at DESC",

  upsertRecent:
    "INSERT INTO resource_recent (user_id, resource_id, organization_id, last_opened_at, open_count) VALUES (?,?,?,?,1) ON CONFLICT(user_id, resource_id) DO UPDATE SET last_opened_at = excluded.last_opened_at, open_count = resource_recent.open_count + 1",
  recentOfUser: "SELECT resource_id, last_opened_at, open_count FROM resource_recent WHERE user_id = ? ORDER BY last_opened_at DESC LIMIT ?",
  deleteRecent: "DELETE FROM resource_recent WHERE user_id = ? AND resource_id = ?",

  clearCollectionForResources: "UPDATE resource_registry SET collection_id = NULL, updated_at = ? WHERE collection_id = ?",
  countCollectionResources: "SELECT COUNT(*) AS c FROM resource_registry WHERE collection_id = ? AND status <> 'deleted'",
  resourcesInCollection: "SELECT resource_id FROM resource_registry WHERE collection_id = ?",
};

const UPDATABLE_LIBRARY_COLUMNS = Object.freeze([
  "mime_type",
  "name",
  "description",
  "content_object_id",
  "checksum",
  "size",
  "storage_mode",
  "storage_device_id",
  "source_locator",
  "source_identity",
  "observed_size",
  "observed_mtime",
  "index_status",
  "memory_subtype",
  "language",
  "attributes",
  "version",
  "trash_state",
  "deleted_at",
  "deleted_by",
  "updated_at",
]);

class ResourceStore {
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("ResourceStore 需要 IdentityStore");
    this.identity = identity;
    this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
  }

  transact(fn) {
    return this.identity.transact(fn);
  }
  transactSync(fn) {
    return this.identity.transactSync(fn);
  }

  // --- content objects ------------------------------------------------------

  insertContentObject({ checksum, size, internalKey, organizationId, algorithm = "sha256" }) {
    const id = domain.contentIdFor(checksum);
    const now = this.clock();
    this.db.prepare(SQL.insertContent).run(id, algorithm, checksum, size, internalKey, 0, organizationId, now, now);
    return this.contentObjectById(id);
  }

  contentObjectById(id) {
    return this.db.prepare(SQL.contentById).get(String(id || "")) || null;
  }

  contentObjectByChecksum(checksum, size, algorithm = "sha256") {
    return this.db.prepare(SQL.contentByChecksum).get(algorithm, String(checksum || ""), size) || null;
  }

  contentObjectByInternalKey(internalKey) {
    return this.db.prepare(SQL.contentByInternalKey).get(String(internalKey || "")) || null;
  }

  allContentObjects() {
    return this.db.prepare(SQL.allContent).all();
  }

  setContentStatus(contentId, status) {
    const res = this.db.prepare(SQL.setContentStatus).run(String(status), this.clock(), String(contentId));
    return { changed: res.changes > 0 };
  }

  /** 引用数**按关系计算**，不是唯一真相（§19）。 */
  contentReferenceCount(contentId) {
    const versions = this.db.prepare(SQL.contentRefResources).all(String(contentId || ""));
    const library = this.db.prepare(SQL.contentRefLibrary).all(String(contentId || ""));
    const ids = new Set([...versions, ...library].map((r) => r.resource_id));
    return ids.size;
  }

  refreshContentRefCount(contentId) {
    const count = this.contentReferenceCount(contentId);
    this.db.prepare(SQL.setContentRefCount).run(count, this.clock(), String(contentId));
    return count;
  }

  orphanContentObjects() {
    return this.db.prepare(SQL.orphanContent).all();
  }

  // --- library resources ----------------------------------------------------

  insertLibraryResource(row) {
    const now = this.clock();
    this.db
      .prepare(SQL.insertLibrary)
      .run(
        row.resourceId,
        row.resourceType,
        row.mimeType || "application/octet-stream",
        row.name || "",
        row.description || "",
        row.storageMode,
        row.contentObjectId ?? null,
        row.checksum ?? null,
        row.size ?? null,
        row.source || "user",
        Number(row.version || 1),
        row.storageDeviceId ?? null,
        row.sourceLocator ?? null,
        row.sourceIdentity ?? null,
        row.observedSize ?? null,
        row.observedMtime ?? null,
        row.generatedSourceTaskId ?? null,
        row.generatedSourceCallId ?? null,
        row.generatedSourceModel ?? null,
        row.memorySubtype ?? null,
        row.language ?? null,
        JSON.stringify(row.attributes && typeof row.attributes === "object" ? row.attributes : {}),
        row.indexStatus || "NOT_INDEXED",
        row.trashState || "ACTIVE",
        row.deletedAt ?? null,
        row.deletedBy ?? null,
        now,
        now,
      );
    return this.libraryResourceById(row.resourceId);
  }

  // --- resource_registry（逻辑身份 / 授权权威；在 D3-02 authorizeCreate 通过后由本服务写入同一事务） ---

  insertRegistryResource({ resourceId = null, resourceType, ownerUserId = null, organizationId, departmentId = null, collectionId = null, scope, parentResourceId = null, name = "", description = "", tags = [], version = 1 }) {
    const id = resourceId || authz.newId("RESOURCE");
    const now = this.clock();
    this.db
      .prepare(SQL.insertRegistry)
      .run(id, String(resourceType), ownerUserId, String(organizationId), departmentId, collectionId, String(scope), parentResourceId, String(name), String(description), JSON.stringify(tags || []), Number(version || 1), now, now);
    return this.identity.connection.prepare("SELECT * FROM resource_registry WHERE resource_id = ?").get(id) || null;
  }

  updateRegistryVersion(resourceId, version) {
    const res = this.db.prepare(SQL.updateRegistryVersion).run(Number(version), this.clock(), String(resourceId));
    return { changed: res.changes > 0 };
  }

  updateRegistryName(resourceId, name, description) {
    const res = this.db.prepare(SQL.updateRegistryName).run(String(name || ""), String(description || ""), this.clock(), String(resourceId));
    return { changed: res.changes > 0 };
  }

  setRegistryStatus(resourceId, status) {
    const res = this.db.prepare(SQL.setRegistryStatus).run(String(status), this.clock(), String(resourceId));
    return { changed: res.changes > 0 };
  }

  libraryResourceById(resourceId) {
    return this.db.prepare(SQL.libraryById).get(String(resourceId || "")) || null;
  }

  /** registry + library 的扁平行（授权元数据 + 存储语义）。 */
  resourceRowById(resourceId) {
    return this.db.prepare(LIB_SELECT + " WHERE r.resource_id = ?").get(String(resourceId || "")) || null;
  }

  resourceRowsByOrg(organizationId) {
    return this.db.prepare(LIB_SELECT + " WHERE r.organization_id = ? ORDER BY r.created_at, r.resource_id").all(String(organizationId || ""));
  }

  updateLibraryResource(resourceId, patch = {}) {
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!UPDATABLE_LIBRARY_COLUMNS.includes(key)) continue;
      sets.push(key + " = ?");
      values.push(value);
    }
    if (!sets.length) return { changed: false };
    sets.push("updated_at = ?");
    values.push(this.clock());
    values.push(String(resourceId));
    const res = this.db.prepare("UPDATE library_resources SET " + sets.join(", ") + " WHERE resource_id = ?").run(...values);
    return { changed: res.changes > 0 };
  }

  setTrashState(resourceId, { trashed, by = null } = {}) {
    const now = this.clock();
    const res = this.db
      .prepare("UPDATE library_resources SET trash_state = ?, deleted_at = ?, deleted_by = ?, updated_at = ? WHERE resource_id = ?")
      .run(trashed ? "TRASHED" : "ACTIVE", trashed ? now : null, trashed ? by : null, now, String(resourceId));
    return { changed: res.changes > 0 };
  }

  deleteRegistryRow(resourceId) {
    const res = this.db.prepare(SQL.deleteRegistry).run(String(resourceId || ""));
    return { changed: res.changes > 0 };
  }

  // --- versions -------------------------------------------------------------

  insertVersion(row) {
    const id = row.id || domain.newVersionId();
    this.db
      .prepare(SQL.insertVersion)
      .run(
        id,
        row.resourceId,
        Number(row.version),
        row.contentObjectId ?? null,
        row.checksum ?? null,
        row.size ?? null,
        row.storageMode,
        row.storageDeviceId ?? null,
        row.sourceLocator ?? null,
        row.source || "user",
        row.createdBy ?? null,
        row.createdAt ?? this.clock(),
      );
    return this.db.prepare(SQL.versionByNumber).get(String(row.resourceId), Number(row.version)) || null;
  }

  nextVersionNumber(resourceId) {
    return Number(this.db.prepare(SQL.nextVersionNumber).get(String(resourceId)).max_version || 0) + 1;
  }

  versionByNumber(resourceId, version) {
    return this.db.prepare(SQL.versionByNumber).get(String(resourceId), Number(version)) || null;
  }

  versionsOf(resourceId) {
    return this.db.prepare(SQL.versionsOf).all(String(resourceId || ""));
  }

  // --- relations ------------------------------------------------------------

  insertRelation({ organizationId, fromResourceId, toResourceId, relationType, createdBy = null }) {
    const id = domain.newRelationId();
    this.db.prepare(SQL.insertRelation).run(id, organizationId, fromResourceId, toResourceId, relationType, createdBy, this.clock());
    return { id };
  }

  relationsFrom(resourceId) {
    return this.db.prepare(SQL.relationsFrom).all(String(resourceId || ""));
  }

  /** incoming references：永久删除前的影响面查询（§47）。 */
  relationsTo(resourceId) {
    return this.db.prepare(SQL.relationsTo).all(String(resourceId || ""));
  }

  // --- import jobs ----------------------------------------------------------

  createImportJob({ id = domain.newImportJobId(), organizationId, actorUserId = null, appId = null, storageMode, stagingKey = null, sourceLocator = null, bytesTotal = null }) {
    const now = this.clock();
    this.db.prepare(SQL.insertJob).run(id, organizationId, actorUserId, appId, storageMode, domain.IMPORT_PHASE.STAGING, stagingKey, sourceLocator, null, null, bytesTotal, 0, null, null, now, now);
    return this.importJobById(id);
  }

  importJobById(id) {
    return this.db.prepare(SQL.jobById).get(String(id || "")) || null;
  }

  updateImportJob(id, patch = {}) {
    const current = this.importJobById(id);
    if (!current) return null;
    this.db
      .prepare(SQL.updateJob)
      .run(
        patch.phase ?? current.phase,
        patch.stagingKey !== undefined ? patch.stagingKey : current.staging_key,
        patch.checksum !== undefined ? patch.checksum : current.checksum,
        patch.size !== undefined ? patch.size : current.size,
        patch.bytesTotal !== undefined ? patch.bytesTotal : current.bytes_total,
        patch.bytesProcessed !== undefined ? patch.bytesProcessed : current.bytes_processed,
        patch.resourceId !== undefined ? patch.resourceId : current.resource_id,
        patch.errorCode !== undefined ? patch.errorCode : current.error_code,
        this.clock(),
        String(id),
      );
    return this.importJobById(id);
  }

  unfinishedImportJobs() {
    return this.db.prepare(SQL.unfinishedJobs).all();
  }

  allImportJobs() {
    return this.db.prepare(SQL.allJobs).all();
  }

  // --- D3-04B · metadata / tags / favorites / recent -----------------------

  updateRegistryMetadata(resourceId, { name, description, collectionId } = {}) {
    const current = this.identity.connection.prepare("SELECT * FROM resource_registry WHERE resource_id = ?").get(String(resourceId)) || null;
    if (!current) return { changed: false };
    const nextName = name == null ? current.name : String(name);
    const nextDesc = description == null ? current.description : String(description);
    const nextCollection = collectionId === undefined ? current.collection_id : collectionId;
    const res = this.db
      .prepare(SQL.updateRegistryMetadata)
      .run(nextName, nextDesc, nextCollection == null ? null : String(nextCollection), this.clock(), String(resourceId));
    return { changed: res.changes > 0 };
  }

  setRegistryTags(resourceId, tags) {
    const res = this.db.prepare(SQL.setRegistryTags).run(JSON.stringify(tags || []), this.clock(), String(resourceId));
    return { changed: res.changes > 0 };
  }

  insertTag({ tagId = null, organizationId, name, normalizedName, source = "user", createdBy = null }) {
    const id = tagId || authz.newId("GRANT").replace("grant_", "tag_");
    const now = this.clock();
    this.db.prepare(SQL.insertTag).run(id, String(organizationId), String(name), String(normalizedName), String(source), createdBy, now, now);
    return this.tagById(id);
  }

  tagById(id) {
    return this.db.prepare(SQL.tagById).get(String(id || "")) || null;
  }

  tagByNormalized(organizationId, normalizedName) {
    return this.db.prepare(SQL.tagByNormalized).get(String(organizationId || ""), String(normalizedName || "")) || null;
  }

  tagsOfOrg(organizationId) {
    return this.db.prepare(SQL.tagsOfOrg).all(String(organizationId || ""));
  }

  updateTagName(tagId, name, normalizedName) {
    const res = this.db.prepare(SQL.updateTagName).run(String(name), String(normalizedName), this.clock(), String(tagId));
    return { changed: res.changes > 0 };
  }

  setTagStatus(tagId, status) {
    const res = this.db.prepare(SQL.setTagStatus).run(String(status), this.clock(), String(tagId));
    return { changed: res.changes > 0 };
  }

  insertResourceTag({ resourceId, tagId, organizationId, source = "user", assignedBy = null }) {
    const id = "rtag_" + require("node:crypto").randomBytes(12).toString("base64url");
    const res = this.db.prepare(SQL.insertResourceTag).run(id, String(resourceId), String(tagId), String(organizationId), String(source), assignedBy, this.clock());
    return { changed: res.changes > 0, id };
  }

  deleteResourceTag(resourceId, tagId) {
    const res = this.db.prepare(SQL.deleteResourceTag).run(String(resourceId), String(tagId));
    return { changed: res.changes > 0 };
  }

  tagsOfResource(resourceId) {
    return this.db.prepare(SQL.tagsOfResource).all(String(resourceId || ""));
  }

  resourcesOfTag(tagId) {
    return this.db.prepare(SQL.resourcesOfTag).all(String(tagId || ""));
  }

  countResourceTags(resourceId) {
    return Number(this.db.prepare(SQL.countResourceTags).get(String(resourceId || "")).c || 0);
  }

  setFavorite({ userId, resourceId, organizationId, favorite }) {
    if (favorite) {
      const res = this.db.prepare(SQL.upsertFavorite).run(String(userId), String(resourceId), String(organizationId), this.clock());
      return { changed: res.changes > 0, favorite: true };
    }
    const res = this.db.prepare(SQL.deleteFavorite).run(String(userId), String(resourceId));
    return { changed: res.changes > 0, favorite: false };
  }

  isFavorite(userId, resourceId) {
    return !!this.db.prepare(SQL.favoriteOf).get(String(userId), String(resourceId));
  }

  favoritesOfUser(userId) {
    return this.db.prepare(SQL.favoritesOfUser).all(String(userId || ""));
  }

  touchRecent({ userId, resourceId, organizationId }) {
    this.db.prepare(SQL.upsertRecent).run(String(userId), String(resourceId), String(organizationId), this.clock());
    return this.db.prepare(SQL.recentOfUser).get(String(userId), 1);
  }

  recentOfUser(userId, limit = 60) {
    return this.db.prepare(SQL.recentOfUser).all(String(userId || ""), Math.max(1, Number(limit) || 60));
  }

  deleteRecent(userId, resourceId) {
    const res = this.db.prepare(SQL.deleteRecent).run(String(userId), String(resourceId));
    return { changed: res.changes > 0 };
  }

  clearCollection(collectionId) {
    const res = this.db.prepare(SQL.clearCollectionForResources).run(this.clock(), String(collectionId || ""));
    return { changed: res.changes > 0 };
  }

  countCollectionResources(collectionId) {
    return Number(this.db.prepare(SQL.countCollectionResources).get(String(collectionId || "")).c || 0);
  }

  resourcesInCollection(collectionId) {
    return this.db.prepare(SQL.resourcesInCollection).all(String(collectionId || ""));
  }
}

module.exports = { ResourceStore, LIB_SELECT };
