/**
 * D3-04C · Search / Index / Preview 持久层（**派生数据**，复用 IdentityStore 同一连接）。
 *
 * resource_search_docs / resource_search_fts / resource_index_jobs / resource_preview_cache
 * 都不是 Resource Identity 权威，可随时从 D3-04A/B 的权威表重建。
 */
"use strict";

const domain = require("./search-domain.cjs");

const SQL = {
  insertDoc:
    "INSERT OR REPLACE INTO resource_search_docs (resource_id, resource_version, content_checksum, index_version, index_status, name, description, tags_text, collection_name, content_text, content_truncated, indexed_at, error_code, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  deleteDoc: "DELETE FROM resource_search_docs WHERE resource_id = ?",
  docById: "SELECT * FROM resource_search_docs WHERE resource_id = ?",
  setDocStatus: "UPDATE resource_search_docs SET index_status = ?, error_code = ?, updated_at = ? WHERE resource_id = ?",
  syncLibraryStatus: "UPDATE library_resources SET index_status = ?, updated_at = ? WHERE resource_id = ?",
  countDocs: "SELECT COUNT(*) AS c FROM resource_search_docs",

  insertFts:
    "INSERT INTO resource_search_fts (resource_id, index_version, name_tokens, description_tokens, tag_tokens, collection_tokens, content_tokens) VALUES (?,?,?,?,?,?,?)",
  deleteFts: "DELETE FROM resource_search_fts WHERE resource_id = ?",
  queryFts:
    "SELECT resource_id, bm25(resource_search_fts, 0.0, 0.0, 8.0, 3.0, 6.0, 2.0, 1.0) AS rank FROM resource_search_fts WHERE resource_search_fts MATCH ? ORDER BY rank ASC LIMIT ? OFFSET ?",
  ftsCount: "SELECT COUNT(*) AS c FROM resource_search_fts",
  ftsIds: "SELECT resource_id FROM resource_search_fts",

  staleDocs:
    "SELECT d.resource_id, d.resource_version AS indexed_version, d.indexed_at, r.version AS current_version, r.updated_at FROM resource_search_docs d " +
    "JOIN resource_registry r ON r.resource_id = d.resource_id WHERE r.organization_id = ? " +
    "AND (d.indexed_at IS NULL OR r.updated_at > d.indexed_at OR d.resource_version <> r.version OR d.index_status IN ('PENDING','STALE','FAILED','INDEXING')) " +
    "ORDER BY r.updated_at DESC LIMIT ?",
  missingDocs:
    "SELECT r.resource_id, r.version FROM resource_registry r LEFT JOIN resource_search_docs d ON d.resource_id = r.resource_id " +
    "WHERE r.organization_id = ? AND r.status = 'active' AND d.resource_id IS NULL ORDER BY r.created_at LIMIT ?",
  activeIds: "SELECT resource_id FROM resource_registry WHERE organization_id = ? AND status = 'active' ORDER BY created_at",

  enqueueJob:
    "INSERT OR IGNORE INTO resource_index_jobs (id, resource_id, resource_version, state, attempts, created_at, updated_at) VALUES (?,?,?, 'QUEUED', 0, ?, ?)",
  jobByResource: "SELECT * FROM resource_index_jobs WHERE resource_id = ? AND resource_version = ?",
  nextJobs: "SELECT * FROM resource_index_jobs WHERE state = 'QUEUED' ORDER BY created_at LIMIT ?",
  updateJob: "UPDATE resource_index_jobs SET state = ?, attempts = attempts + 1, error_code = ?, updated_at = ? WHERE id = ?",
  recoverJobs: "UPDATE resource_index_jobs SET state = 'QUEUED', updated_at = ? WHERE state = 'RUNNING'",
  recoverDocs: "UPDATE resource_search_docs SET index_status = 'PENDING', updated_at = ? WHERE index_status = 'INDEXING'",
  runningDocs: "SELECT resource_id FROM resource_search_docs WHERE index_status = 'INDEXING'",

  upsertPreview:
    "INSERT OR REPLACE INTO resource_preview_cache (cache_key, resource_id, resource_version, content_checksum, preview_kind, preview_version, storage_key, size, mime_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  previewByKey: "SELECT * FROM resource_preview_cache WHERE cache_key = ?",
  previewByResource: "SELECT * FROM resource_preview_cache WHERE resource_id = ?",
  deletePreviewByResource: "DELETE FROM resource_preview_cache WHERE resource_id = ?",
  allPreview: "SELECT * FROM resource_preview_cache",
};

class SearchStore {
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("SearchStore 需要 IdentityStore");
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

  /** FTS5 是否真的可用（表存在）。 */
  ftsAvailable() {
    try {
      return !!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_search_fts'").get();
    } catch {
      return false;
    }
  }

  replaceDocument({ resourceId, resourceVersion, contentChecksum, indexVersion = domain.INDEX_VERSION, status, name, description, tagsText, collectionName, contentText, contentTruncated, errorCode = null, tokens }) {
    const now = this.clock();
    return this.transactSync(() => {
      this.db.prepare(SQL.deleteFts).run(String(resourceId));
      this.db.prepare(SQL.insertDoc).run(
        String(resourceId), Number(resourceVersion), contentChecksum || null, Number(indexVersion), String(status),
        String(name || ""), String(description || ""), String(tagsText || ""), String(collectionName || ""),
        String(contentText || ""), contentTruncated ? 1 : 0, now, errorCode, now,
      );
      if (tokens && this.ftsAvailable()) {
        this.db.prepare(SQL.insertFts).run(String(resourceId), Number(indexVersion), String(tokens.name || ""), String(tokens.description || ""), String(tokens.tag || ""), String(tokens.collection || ""), String(tokens.content || ""));
      }
      this.db.prepare(SQL.syncLibraryStatus).run(String(status), now, String(resourceId));
      return { changed: true };
    });
  }

  documentById(resourceId) {
    return this.db.prepare(SQL.docById).get(String(resourceId || "")) || null;
  }

  countDocuments() {
    return Number(this.db.prepare(SQL.countDocs).get().c || 0);
  }

  deleteDocument(resourceId) {
    return this.transactSync(() => {
      this.db.prepare(SQL.deleteFts).run(String(resourceId || ""));
      this.db.prepare(SQL.deleteDoc).run(String(resourceId || ""));
      return { changed: true };
    });
  }

  setDocumentStatus(resourceId, status, errorCode = null) {
    const now = this.clock();
    return this.transactSync(() => {
      this.db.prepare(SQL.setDocStatus).run(String(status), errorCode, now, String(resourceId));
      this.db.prepare(SQL.syncLibraryStatus).run(String(status), now, String(resourceId));
      return { changed: true };
    });
  }

  queryFts(match, { limit = 200, offset = 0 } = {}) {
    return this.db.prepare(SQL.queryFts).all(String(match), Math.max(1, Number(limit) || 200), Math.max(0, Number(offset) || 0));
  }

  ftsCount() {
    return Number(this.db.prepare(SQL.ftsCount).get().c || 0);
  }

  staleDocuments(organizationId, limit = 100) {
    return this.db.prepare(SQL.staleDocs).all(String(organizationId || ""), Math.max(1, Number(limit) || 100));
  }

  missingDocuments(organizationId, limit = 100) {
    return this.db.prepare(SQL.missingDocs).all(String(organizationId || ""), Math.max(1, Number(limit) || 100));
  }

  activeResourceIds(organizationId) {
    return this.db.prepare(SQL.activeIds).all(String(organizationId || "")).map((r) => r.resource_id);
  }

  ftsResourceIds() {
    return this.db.prepare(SQL.ftsIds).all().map((r) => r.resource_id);
  }

  enqueueJob({ resourceId, resourceVersion, id }) {
    const now = this.clock();
    const jobId = id || "idx_" + require("node:crypto").randomBytes(12).toString("base64url");
    this.db.prepare(SQL.enqueueJob).run(jobId, String(resourceId), Number(resourceVersion), now, now);
    return this.db.prepare(SQL.jobByResource).get(String(resourceId), Number(resourceVersion)) || null;
  }

  nextJobs(limit = 20) {
    return this.db.prepare(SQL.nextJobs).all(Math.max(1, Number(limit) || 20));
  }

  updateJob(id, state, errorCode = null) {
    const res = this.db.prepare(SQL.updateJob).run(String(state), errorCode, this.clock(), String(id));
    return { changed: res.changes > 0 };
  }

  recoverInterrupted() {
    const now = this.clock();
    this.db.prepare(SQL.recoverJobs).run(now);
    this.db.prepare(SQL.recoverDocs).run(now);
    return { recoveredAt: now };
  }

  // --- preview cache metadata ---

  upsertPreview(row) {
    const now = this.clock();
    this.db.prepare(SQL.upsertPreview).run(
      row.cacheKey, row.resourceId, Number(row.resourceVersion), row.contentChecksum || null, row.previewKind,
      Number(row.previewVersion || domain.PREVIEW_VERSION), row.storageKey, row.size ?? null, row.mimeType || null, row.status || "READY", now, now,
    );
    return this.previewByKey(row.cacheKey);
  }

  previewByKey(cacheKey) {
    return this.db.prepare(SQL.previewByKey).get(String(cacheKey || "")) || null;
  }

  previewByResource(resourceId) {
    return this.db.prepare(SQL.previewByResource).all(String(resourceId || ""));
  }

  deletePreviewByResource(resourceId) {
    const res = this.db.prepare(SQL.deletePreviewByResource).run(String(resourceId || ""));
    return { changed: res.changes > 0 };
  }

  allPreview() {
    return this.db.prepare(SQL.allPreview).all();
  }
}

module.exports = { SearchStore, SQL };
