/**
 * D3-04C · PreviewService —— 受控 Preview Capability + 安全交付。
 *
 * Renderer 永远不拼本地路径：主进程在通过 Authorization 后签发**短时 capability**，
 * Renderer 只拿到 openarc-resource:// URL；protocol handler 每次请求都重新授权并按 Range 流式返回。
 * Preview Cache 只是派生数据；缓存存在 ≠ 有权读。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const domain = require("./search-domain.cjs");
const resDomain = require("./resource-domain.cjs");
const authz = require("./authorization-domain.cjs");

const SCHEME = "openarc-resource";

function previewKindOf(row) {
  if (!row) return domain.PREVIEW_KIND.UNSUPPORTED;
  const mime = String(row.mime_type || "").toLowerCase();
  const type = String(row.resource_type || "");
  if (mime === "application/pdf") return domain.PREVIEW_KIND.PDF;
  if (mime.startsWith("image/")) return domain.PREVIEW_KIND.IMAGE;
  if (mime.startsWith("video/")) return domain.PREVIEW_KIND.VIDEO;
  if (mime.startsWith("audio/")) return domain.PREVIEW_KIND.AUDIO;
  if (["memory", "text", "code", "prompt"].includes(type) || mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") return domain.PREVIEW_KIND.TEXT;
  return domain.PREVIEW_KIND.UNSUPPORTED;
}

class PreviewService {
  constructor({ identity, resourceStore, searchStore = null, managedStore, authService, deviceService = null, clock = null, nativeImage = null, thumbnailDir = null, logger = null } = {}) {
    if (!identity) throw new Error("PreviewService 需要 IdentityStore");
    if (!resourceStore) throw new Error("PreviewService 需要 ResourceStore");
    if (!authService) throw new Error("PreviewService 需要 AuthorizationService");
    this.identity = identity;
    this.resourceStore = resourceStore;
    this.searchStore = searchStore;
    this.managedStore = managedStore;
    this.authService = authService;
    this.deviceService = deviceService;
    this.clock = typeof clock === "function" ? clock : identity.clock;
    this.nativeImage = nativeImage;
    this.thumbnailDir = thumbnailDir || (managedStore ? path.join(managedStore.root, "thumbnails") : null);
    this.logger = logger;
    this.capabilities = new Map();
  }

  #now() {
    return this.clock();
  }

  #actor(context) {
    const v = this.identity.validateSession(context && context.sessionRef, { sensitive: false });
    if (!v.ok) return { ok: false, error: domain.REASON.NOT_FOUND_OR_FORBIDDEN };
    return { ok: true, user: v.user };
  }

  #row(resourceRef) {
    const id = typeof resourceRef === "string" ? authz.parseResourceRef(resourceRef) : resourceRef && resourceRef.resourceId;
    if (!id) return null;
    return this.resourceStore.resourceRowById(id);
  }

  #contentPath(row) {
    if (!row) return null;
    if (row.storage_mode === "MANAGED") return this.managedStore ? this.managedStore.objectPath(row.checksum) : null;
    const deviceId = row.storage_device_id || "local";
    if (deviceId !== "local") return null;
    return row.source_locator || null;
  }

  #availability(row) {
    if (!row) return "UNKNOWN";
    if (row.trash_state === "TRASHED" || row.registry_status !== "active") return "TRASHED";
    if (row.storage_mode === "MANAGED") {
      const st = this.managedStore ? this.managedStore.objectStat(row.checksum) : { exists: false };
      return st.exists ? "AVAILABLE" : "INTEGRITY_FAILED";
    }
    const deviceId = row.storage_device_id || "local";
    if (deviceId !== "local") {
      if (!this.deviceService) return "DEVICE_UNKNOWN";
      const loc = this.deviceService.resolveResourceLocation({ context: {}, deviceId });
      if (!loc.ok) return "DEVICE_UNKNOWN";
      const mapped = resDomain.availabilityFromDevice(loc.location);
      return mapped || "AVAILABLE";
    }
    if (!row.source_locator) return "SOURCE_MISSING";
    try {
      return fs.statSync(row.source_locator).isFile() ? "AVAILABLE" : "SOURCE_MISSING";
    } catch {
      return "SOURCE_MISSING";
    }
  }

  #authorizePreview({ context, row }) {
    // DEFAULT DENY：已删除（Trash）资源的内容永不经 preview 交付，即使调用方显式传 includeTrashed。
    if (row.trash_state === "TRASHED" || row.registry_status !== "active") {
      return { ok: false, error: "RESOURCE_TRASHED", availability: "TRASHED" };
    }
    const caps = this.authService.getCapabilities({ context, resource: row.resource_id, allowInactiveResource: false });
    if (!caps.ok) return { ok: false, error: domain.REASON.NOT_FOUND_OR_FORBIDDEN };
    if (!caps.capabilities.canPreview && !caps.capabilities.canRead) return { ok: false, error: domain.REASON.PREVIEW_UNSUPPORTED };
    return { ok: true, caps };
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
    } catch {
      return { ok: false, error: domain.REASON.PREVIEW_UNAVAILABLE };
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

  mintCapability({ context, row, kind, action = authz.ACTION.PREVIEW, storageKey = null, mimeType = null, size = null }) {
    const capabilityId = "cap_" + crypto.randomBytes(18).toString("base64url");
    const nonce = crypto.randomBytes(12).toString("base64url");
    const issuedAt = this.#now();
    const capability = {
      capabilityId,
      nonce,
      userId: context && context.userId ? String(context.userId) : null,
      sessionRef: context && context.sessionRef ? String(context.sessionRef) : null,
      appId: context && context.appId ? String(context.appId) : "resource-library",
      resourceId: row ? row.resource_id : null,
      resourceVersion: row ? Number(row.version || 1) : null,
      checksum: row ? row.checksum || null : null,
      kind,
      action,
      storageKey,
      mimeType,
      size,
      issuedAt,
      expiresAt: issuedAt + domain.PREVIEW_CAPABILITY_TTL_MS,
    };
    this.capabilities.set(capabilityId, capability);
    return { capability, url: SCHEME + "://preview/" + capabilityId };
  }

  validateCapability(capabilityId) {
    const cap = this.capabilities.get(String(capabilityId || ""));
    if (!cap) return { ok: false, error: domain.REASON.CAPABILITY_INVALID };
    if (this.#now() >= cap.expiresAt) {
      this.capabilities.delete(cap.capabilityId);
      return { ok: false, error: domain.REASON.CAPABILITY_EXPIRED };
    }
    return { ok: true, capability: cap };
  }

  async preview({ context, resourceRef } = {}) {
    const row = this.#row(resourceRef);
    if (!row) return { ok: false, error: domain.REASON.NOT_FOUND_OR_FORBIDDEN };
    const auth = this.#authorizePreview({ context, row });
    if (!auth.ok) return auth;
    const availability = this.#availability(row);
    const kind = previewKindOf(row);
    const base = { resourceRef: authz.toResourceRef(row.resource_id), resourceId: row.resource_id, kind, availability, mimeType: row.mime_type, size: row.size == null ? null : Number(row.size), version: Number(row.version || 1), storageMode: row.storage_mode };
    if (availability !== "AVAILABLE") return { ok: false, error: availability, ...base };
    if (kind === domain.PREVIEW_KIND.UNSUPPORTED) return { ok: true, ...base, error: domain.REASON.PREVIEW_UNSUPPORTED };
    if (kind === domain.PREVIEW_KIND.TEXT) {
      const p = this.#contentPath(row);
      if (!p) return { ok: false, error: domain.REASON.PREVIEW_UNAVAILABLE, ...base };
      const read = this.#readBounded(p, domain.LIMITS.MAX_PREVIEW_TEXT_BYTES);
      if (!read.ok) return { ok: false, error: read.error, ...base };
      return { ok: true, ...base, text: read.text, truncated: read.truncated };
    }
    const minted = this.mintCapability({ context: { ...context, userId: auth.caps.userId || (context && context.userId) }, row, kind, action: authz.ACTION.PREVIEW, mimeType: row.mime_type, size: Number(row.size || 0) });
    return { ok: true, ...base, url: minted.url, capabilityId: minted.capability.capabilityId, expiresAt: minted.capability.expiresAt, supportsRange: true };
  }

  /** Image Thumbnail：用 Electron nativeImage 本地生成（无外部依赖）；Node 测试环境返回 UNSUPPORTED。 */
  async thumbnail({ context, resourceRef } = {}) {
    const row = this.#row(resourceRef);
    if (!row) return { ok: false, error: domain.REASON.NOT_FOUND_OR_FORBIDDEN };
    const auth = this.#authorizePreview({ context, row });
    if (!auth.ok) return auth;
    if (previewKindOf(row) !== domain.PREVIEW_KIND.IMAGE) return { ok: false, error: domain.REASON.PREVIEW_UNSUPPORTED };
    if (this.#availability(row) !== "AVAILABLE") return { ok: false, error: this.#availability(row) };
    const key = domain.previewCacheKey({ resourceId: row.resource_id, resourceVersion: row.version, checksum: row.checksum, kind: "thumbnail" });
    const cached = this.searchStore ? this.searchStore.previewByKey(key) : null;
    if (cached && cached.storage_key && fs.existsSync(cached.storage_key)) {
      const minted = this.mintCapability({ context: { ...context, userId: auth.caps.userId || (context && context.userId) }, row, kind: "thumbnail", action: authz.ACTION.PREVIEW, storageKey: cached.storage_key, mimeType: "image/png", size: cached.size });
      return { ok: true, cached: true, url: minted.url, width: 256 };
    }
    if (!this.nativeImage || typeof this.nativeImage.createFromPath !== "function") return { ok: false, error: domain.REASON.PREVIEW_UNSUPPORTED, node: true };
    const src = this.#contentPath(row);
    if (!src) return { ok: false, error: domain.REASON.PREVIEW_UNAVAILABLE };
    try {
      const img = this.nativeImage.createFromPath(src);
      if (!img || img.isEmpty()) return { ok: false, error: domain.REASON.PREVIEW_UNAVAILABLE };
      const resized = img.resize({ width: 256, height: 256, quality: "good" });
      const png = resized.toPNG();
      fs.mkdirSync(this.thumbnailDir, { recursive: true, mode: 0o700 });
      const storageKey = path.join(this.thumbnailDir, key + ".png");
      fs.writeFileSync(storageKey, png, { mode: 0o600 });
      if (this.searchStore) this.searchStore.upsertPreview({ cacheKey: key, resourceId: row.resource_id, resourceVersion: row.version, contentChecksum: row.checksum, previewKind: "thumbnail", storageKey, size: png.length, mimeType: "image/png", status: "READY" });
      const minted = this.mintCapability({ context: { ...context, userId: auth.caps.userId || (context && context.userId) }, row, kind: "thumbnail", action: authz.ACTION.PREVIEW, storageKey, mimeType: "image/png", size: png.length });
      return { ok: true, cached: false, url: minted.url, width: 256 };
    } catch {
      return { ok: false, error: domain.REASON.PREVIEW_UNAVAILABLE };
    }
  }

  async handleProtocolRequest(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const capabilityId = url.hostname === "preview" ? url.pathname.replace(/^\//, "") : "";
    const check = this.validateCapability(capabilityId);
    if (!check.ok) return new Response(check.error, { status: check.error === domain.REASON.CAPABILITY_EXPIRED ? 410 : 403 });
    const cap = check.capability;
    // 每次请求重新授权：revoke 立即生效。
    if (cap.resourceId) {
      const reauth = this.authService.getCapabilities({ context: { sessionRef: cap.sessionRef, appId: cap.appId }, resource: cap.resourceId });
      if (!reauth.ok || (!reauth.capabilities.canPreview && !reauth.capabilities.canRead)) return new Response("forbidden", { status: 403 });
    }
    let filePath = cap.storageKey;
    let mime = cap.mimeType || "application/octet-stream";
    let size = cap.size;
    if (!filePath && cap.resourceId) {
      const row = this.resourceStore.resourceRowById(cap.resourceId);
      if (!row) return new Response("not found", { status: 404 });
      if (Number(row.version || 1) !== Number(cap.resourceVersion)) return new Response("stale", { status: 409 });
      filePath = this.#contentPath(row);
      mime = row.mime_type || mime;
      size = row.size == null ? null : Number(row.size);
    }
    if (!filePath || !fs.existsSync(filePath)) return new Response("not found", { status: 404 });
    if (size == null) {
      try {
        size = fs.statSync(filePath).size;
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
    const rangeHeader = request.headers && typeof request.headers.get === "function" ? request.headers.get("range") : null;
    const parsedRange = domain.parseRange(rangeHeader, size);
    if (!parsedRange.ok) return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": "bytes */" + size } });
    const headers = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
    let status = 200;
    let stream;
    if (parsedRange.range) {
      const { start, end } = parsedRange.range;
      status = 206;
      headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
      headers["Content-Length"] = String(end - start + 1);
      stream = fs.createReadStream(filePath, { start, end });
    } else {
      headers["Content-Length"] = String(size);
      stream = fs.createReadStream(filePath);
    }
    return new Response(Readable.toWeb(stream), { status, headers });
  }

  cleanupForResource(resourceId) {
    if (this.searchStore) {
      for (const row of this.searchStore.previewByResource(resourceId)) {
        try {
          if (row.storage_key) fs.rmSync(row.storage_key, { force: true });
        } catch {
          /* ignore */
        }
      }
      this.searchStore.deletePreviewByResource(resourceId);
    }
    return { ok: true };
  }

  maintenance() {
    let removed = 0;
    if (this.searchStore) {
      for (const row of this.searchStore.allPreview()) {
        if (!this.resourceStore.resourceRowById(row.resource_id)) {
          try {
            if (row.storage_key) fs.rmSync(row.storage_key, { force: true });
          } catch {
            /* ignore */
          }
          this.searchStore.deletePreviewByResource(row.resource_id);
          removed += 1;
        }
      }
    }
    return { ok: true, removed };
  }
}

module.exports = { PreviewService, SCHEME, previewKindOf };
