/**
 * D3-04C · SearchService —— 本地索引生命周期与**服务端授权**全文搜索。
 *
 * 索引是派生数据；Authorization 永远实时发生在这里（D3-02 authorizeMany），
 * 绝不把 FTS 全量结果交给 Renderer / Agent 再过滤。
 */
"use strict";

const fs = require("node:fs");
const domain = require("./search-domain.cjs");
const resDomain = require("./resource-domain.cjs");
const authz = require("./authorization-domain.cjs");
const { ResourceExtractorRegistry } = require("./extractors.cjs");

const STORED_CONTENT_LIMIT = 32 * 1024;
const DEFAULT_RECONCILE_LIMIT = 100;

class SearchService {
  constructor({ identity, resourceStore, searchStore, managedStore, authService, authStore = null, deviceService = null, clock = null, extractors = null, logger = null } = {}) {
    if (!identity) throw new Error("SearchService 需要 IdentityStore");
    if (!resourceStore) throw new Error("SearchService 需要 ResourceStore");
    if (!searchStore) throw new Error("SearchService 需要 SearchStore");
    if (!authService) throw new Error("SearchService 需要 AuthorizationService");
    this.identity = identity;
    this.resourceStore = resourceStore;
    this.searchStore = searchStore;
    this.managedStore = managedStore;
    this.authService = authService;
    this.authStore = authStore;
    this.deviceService = deviceService;
    this.clock = typeof clock === "function" ? clock : identity.clock;
    this.extractors = extractors || new ResourceExtractorRegistry();
    this.logger = logger;
  }

  #now() {
    return this.clock();
  }

  #actor(context) {
    const v = this.identity.validateSession(context && context.sessionRef, { sensitive: false });
    if (!v.ok) return { ok: false, error: domain.REASON.NOT_FOUND_OR_FORBIDDEN };
    return { ok: true, user: v.user };
  }

  #readBounded(filePath, maxBytes) {
    let fd;
    try {
      fd = fs.openSync(filePath, "r");
      const st = fs.fstatSync(fd);
      const toRead = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, 0);
      return { ok: true, text: buf.subarray(0, bytesRead).toString("utf8"), truncated: st.size > maxBytes, size: st.size };
    } catch (e) {
      return { ok: false, error: domain.REASON.PREVIEW_UNAVAILABLE, detail: String(e && e.code) };
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  #contentPath(row) {
    if (!row) return null;
    if (row.storage_mode === "MANAGED") return this.managedStore ? this.managedStore.objectPath(row.checksum) : null;
    const deviceId = row.storage_device_id || "local";
    if (deviceId !== "local") return null; // 远程内容 transport 未实现（D3-04A 冻结）
    return row.source_locator || null;
  }

  async #readContent(row, { maxBytes }) {
    const p = this.#contentPath(row);
    if (!p) return { ok: false, error: row.storage_mode === "LINKED" ? domain.REASON.PREVIEW_UNAVAILABLE : domain.REASON.NO_TEXT };
    return this.#readBounded(p, maxBytes || domain.LIMITS.MAX_INDEX_TEXT_BYTES);
  }

  /** 索引单个 Resource（派生数据，可重复调用）。 */
  async indexResource(resourceId, { statusHint } = {}) {
    const row = this.resourceStore.resourceRowById(resourceId);
    if (!row || row.registry_status !== "active") {
      this.searchStore.deleteDocument(resourceId);
      return { ok: true, resourceId, status: "DELETED" };
    }
    const tags = this.resourceStore.tagsOfResource(resourceId).map((t) => t.name);
    const collection = row.collection_id && this.authStore ? this.authStore.collectionById(row.collection_id) : null;
    let extraction;
    try {
      extraction = await this.extractors.extract({ row, readContent: (o) => this.#readContent(row, o) });
    } catch (e) {
      extraction = { hasText: false, contentText: "", truncated: false, errorCode: domain.REASON.INDEX_FAILED, error: String(e && e.message) };
    }
    const status = extraction.hasText ? domain.INDEX_STATUS.READY : domain.INDEX_STATUS.NO_TEXT;
    const errorCode = extraction.errorCode || (extraction.unsupportedText ? "UNSUPPORTED_TEXT_EXTRACTION" : null);
    const tokens = {
      name: domain.indexTokenString(row.name),
      description: domain.indexTokenString(row.description),
      tag: domain.indexTokenString(tags.join(" ")),
      collection: domain.indexTokenString(collection ? collection.name : ""),
      content: domain.indexTokenString(extraction.contentText),
    };
    this.searchStore.replaceDocument({
      resourceId,
      resourceVersion: Number(row.version || 1),
      contentChecksum: row.checksum || null,
      status: statusHint && !extraction.hasText ? statusHint : status,
      name: row.name,
      description: row.description,
      tagsText: tags.join(" "),
      collectionName: collection ? collection.name : "",
      contentText: String(extraction.contentText || "").slice(0, STORED_CONTENT_LIMIT),
      contentTruncated: !!extraction.truncated,
      errorCode,
      tokens,
    });
    return { ok: true, resourceId, status: extraction.hasText ? status : domain.INDEX_STATUS.NO_TEXT, extractor: extraction.extractor, errorCode };
  }

  /** 搜索前对齐索引（内容 / metadata 变化通过 updated_at > indexed_at 判定 STALE）。 */
  async #reconcile(organizationId, limit = DEFAULT_RECONCILE_LIMIT) {
    const stale = this.searchStore.staleDocuments(organizationId, limit);
    const ids = stale.map((d) => d.resource_id);
    if (ids.length < limit) {
      for (const m of this.searchStore.missingDocuments(organizationId, limit - ids.length)) ids.push(m.resource_id);
    }
    let processed = 0;
    for (const id of ids) {
      await this.indexResource(id);
      processed += 1;
    }
    for (const id of this.searchStore.ftsResourceIds()) {
      if (!this.resourceStore.resourceRowById(id)) this.searchStore.deleteDocument(id);
    }
    return { processed };
  }

  async reindexAll({ context, limit = 200 } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    if (actor.user.role !== "ADMIN") return { ok: false, error: domain.REASON.NOT_FOUND_OR_FORBIDDEN };
    const all = this.searchStore.activeResourceIds(actor.user.team_id);
    const slice = all.slice(0, Math.max(1, Number(limit) || 200));
    let processed = 0;
    for (const id of slice) {
      await this.indexResource(id);
      processed += 1;
    }
    return { ok: true, processed, remaining: Math.max(0, all.length - slice.length), total: all.length };
  }

  async reindex({ context, resourceRef } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const id = typeof resourceRef === "string" ? authz.parseResourceRef(resourceRef) : resourceRef && resourceRef.resourceId;
    if (!id) return { ok: false, error: domain.REASON.INVALID_INPUT };
    const auth = this.authService.authorize({ context, action: authz.ACTION.EDIT, resource: id });
    if (auth.decision !== "ALLOW") return { ok: false, error: auth.reasonCode || domain.REASON.NOT_FOUND_OR_FORBIDDEN };
    return this.indexResource(id);
  }

  #passesFilters(row, filter = {}) {
    const categoryTypes = filter.category ? resDomain.categoryTypes(filter.category) : null;
    if (categoryTypes && !categoryTypes.includes(row.resource_type)) return false;
    if (filter.resourceType && row.resource_type !== filter.resourceType) return false;
    if (filter.memorySubtype && row.memory_subtype !== filter.memorySubtype) return false;
    if (filter.storageMode && row.storage_mode !== filter.storageMode) return false;
    if (filter.collectionId === "unfiled" ? !!row.collection_id : filter.collectionId && row.collection_id !== filter.collectionId) return false;
    if (filter.departmentId && row.department_id !== filter.departmentId) return false;
    if (filter.tagId) {
      const has = this.resourceStore.tagsOfResource(row.resource_id).some((t) => t.id === filter.tagId);
      if (!has) return false;
    }
    return true;
  }

  #availability(row) {
    if (!row) return "UNKNOWN";
    if (row.trash_state === "TRASHED" || row.registry_status !== "active") return "TRASHED";
    if (row.storage_mode === "MANAGED") {
      const st = this.managedStore ? this.managedStore.objectStat(row.checksum) : { exists: false };
      return st.exists ? "AVAILABLE" : "INTEGRITY_FAILED";
    }
    const deviceId = row.storage_device_id || "local";
    if (deviceId !== "local") return "DEVICE_UNKNOWN";
    if (!row.source_locator) return "SOURCE_MISSING";
    try {
      return fs.statSync(row.source_locator).isFile() ? "AVAILABLE" : "SOURCE_MISSING";
    } catch {
      return "SOURCE_MISSING";
    }
  }

  #resultItem(c) {
    const { row, doc, fields, snippet, score } = c;
    return {
      resourceId: row.resource_id,
      resourceRef: authz.toResourceRef(row.resource_id),
      name: row.name,
      resourceType: row.resource_type,
      mimeType: row.mime_type,
      storageMode: row.storage_mode,
      collectionId: row.collection_id ?? null,
      departmentId: row.department_id ?? null,
      version: Number(row.version || 1),
      updatedAt: row.updated_at,
      availability: this.#availability(row),
      matchedFields: fields,
      snippet,
      score,
      indexStatus: doc.index_status,
    };
  }

  /**
   * 服务端授权搜索。FTS 只给候选；每一批都经 authorizeMany 实时授权，
   * 只有 authorized 结果才会离开服务边界；total 只统计 authorized。
   * 带扫描预算，防止极端 ACL 造成无限扫描。
   */
  async search({ context, query, filter = {}, agent, limit = 40, offset = 0, reconcile = true } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: domain.REASON.NOT_FOUND_OR_FORBIDDEN, items: [], total: 0 };
    const parsed = domain.parseQuery(query);
    if (!parsed.ok) return { ok: false, error: parsed.error, items: [], total: 0 };
    if (!this.searchStore.ftsAvailable()) return { ok: false, error: domain.REASON.SEARCH_UNAVAILABLE, items: [], total: 0 };
    if (reconcile) await this.#reconcile(actor.user.team_id, DEFAULT_RECONCILE_LIMIT);
    const pageSize = Math.min(domain.LIMITS.MAX_SCAN, Math.max(1, Number(limit) || 40));
    const pageOffset = Math.max(0, Number(offset) || 0);
    const need = pageOffset + pageSize + 1;
    const fts = domain.buildFtsQuery(parsed.tokens);
    const collected = [];
    let scanned = 0;
    while (scanned < domain.LIMITS.MAX_SCAN && collected.length < need) {
      let rows;
      try {
        rows = this.searchStore.queryFts(fts, { limit: domain.LIMITS.FTS_BATCH, offset: scanned });
      } catch {
        return { ok: false, error: domain.REASON.SEARCH_UNAVAILABLE, items: [], total: 0 };
      }
      if (!rows.length) break;
      scanned += rows.length;
      const ids = rows.map((r) => r.resource_id);
      const rankById = new Map(rows.map((r) => [r.resource_id, r.rank]));
      const authRes = this.authService.authorizeMany({ context, action: authz.ACTION.SEARCH, resources: ids, agent });
      if (!authRes.ok) return { ok: false, error: authRes.error, items: [], total: 0 };
      const allowed = new Set(authRes.results.filter((r) => r.decision === "ALLOW").map((r) => r.resourceId));
      for (const id of ids) {
        if (!allowed.has(id)) continue;
        const row = this.resourceStore.resourceRowById(id);
        const doc = this.searchStore.documentById(id);
        if (!row || !doc || row.registry_status !== "active") continue;
        if (!this.#passesFilters(row, filter)) continue;
        const fields = domain.matchedFields(doc, parsed.displayTerms);
        const snippet = domain.buildSnippet(doc.content_text || doc.description || doc.name, parsed.displayTerms);
        const score = domain.computeScore({ bm25: rankById.get(id), fields, updatedAt: row.updated_at });
        collected.push({ row, doc, fields, snippet, score });
      }
      if (rows.length < domain.LIMITS.FTS_BATCH) break;
    }
    collected.sort((a, b) => (b.score - a.score) || (a.row.resource_id < b.row.resource_id ? -1 : 1));
    const page = collected.slice(pageOffset, pageOffset + pageSize);
    return {
      ok: true,
      items: page.map((c) => this.#resultItem(c)),
      total: collected.length,
      totalIsLowerBound: scanned >= domain.LIMITS.MAX_SCAN,
      scanned,
      limit: pageSize,
      offset: pageOffset,
      hasMore: collected.length > pageOffset + pageSize,
      query: parsed.normalized,
    };
  }

  /** 兼容 D3-04B 结构化浏览：query 为空时切换为 authorized metadata query。 */
  indexStatus({ context, resourceRef } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const id = typeof resourceRef === "string" ? authz.parseResourceRef(resourceRef) : resourceRef && resourceRef.resourceId;
    if (!id) return { ok: false, error: domain.REASON.INVALID_INPUT };
    const auth = this.authService.authorize({ context, action: authz.ACTION.VIEW, resource: id });
    if (auth.decision !== "ALLOW") return { ok: false, error: domain.REASON.NOT_FOUND_OR_FORBIDDEN };
    const row = this.resourceStore.resourceRowById(id);
    const doc = this.searchStore.documentById(id);
    return {
      ok: true,
      resourceRef: authz.toResourceRef(id),
      indexStatus: doc ? doc.index_status : domain.INDEX_STATUS.PENDING,
      indexedAt: doc ? doc.indexed_at : null,
      documentVersion: doc ? doc.resource_version : null,
      resourceVersion: row ? Number(row.version || 1) : null,
      stale: !doc || doc.resource_version !== Number(row.version || 1) || (doc.indexed_at != null && Number(row.updated_at) > Number(doc.indexed_at)),
    };
  }

  recoverStartup() {
    this.searchStore.recoverInterrupted();
    return { ok: true, recovered: true, documents: this.searchStore.countDocuments() };
  }

  rebuildFromAuthoritative({ organizationId, limit = null } = {}) {
    // 证明 Index 只是 derived state：清掉后可从权威表重建。
    const ids = this.searchStore.activeResourceIds(organizationId);
    const slice = limit == null ? ids : ids.slice(0, limit);
    // deleteDocument 自带事务；这里不能再包一层 transactSync（会嵌套 BEGIN IMMEDIATE）。
    for (const id of slice) this.searchStore.deleteDocument(id);
    return { ok: true, cleared: slice.length };
  }
}

module.exports = { SearchService, STORED_CONTENT_LIMIT, DEFAULT_RECONCILE_LIMIT };
