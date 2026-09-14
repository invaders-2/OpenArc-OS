/**
 * D3-04A · Resource Service —— 本地资源对象的唯一领域服务。
 *
 * 授权继续复用 D3-02（authorize / authorizeCreate / getCapabilities）：
 *   - Create 针对 **target container / scope** 授权，而不是拿还不存在的 resourceId；
 *   - Read/Edit/Delete 等动作仍走统一 authorize，User ∩ App 同时成立；
 *   - LINKED Resource 额外经过 D3-03 的 Device 可用性（Resource × Device 交集）。
 *
 * UI / 未来 AI / App 共用这一条命令层；preload 不暴露任何 raw fs。
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const domain = require("./resource-domain.cjs");
const authz = require("./authorization-domain.cjs");

const { ok, fail, REASON, STORAGE_MODE, AVAILABILITY, IMPORT_PHASE, TRASH_STATE, CONTENT_STATUS, SOURCE, INDEX_STATUS, LOCAL_DEVICE_ID, TAG_SOURCE, CATEGORY } = domain;

/**
 * 内置 App 的默认 Resource 权限清单（显式系统策略）。
 *
 * 为什么需要它：§26 要求不能因为它是系统 App 就跳过 App Authorization。
 * 因此内置 App 也必须真实拥有 app grant，否则连资源库自身都导入不了。
 * 这批 grant 由系统策略写入，granted_by = system:builtin-policy，并在 ADR 中登记。
 * 全局 grant 不覆盖 memory（D3-02 §25 的保护语义保持不变）。
 */
const READ_ACTIONS = ["resource.view", "resource.search", "resource.preview", "resource.read"];
const BUILTIN_APP_BASELINE = Object.freeze({
  "resource-library": { actions: [...authz.RESOURCE_ACTIONS], scoped: [{ resourceType: "memory", actions: [...authz.RESOURCE_ACTIONS] }] },
  canvas: { actions: READ_ACTIONS },
  browser: { actions: READ_ACTIONS },
  ai: { actions: [...READ_ACTIONS, "resource.useByAgent"] },
  "image-generator": { actions: ["resource.view", "resource.preview", "resource.read"] },
  "video-generator": { actions: ["resource.view", "resource.preview", "resource.read"] },
  photoshop: { actions: [...READ_ACTIONS, "resource.edit"] },
  illustrator: { actions: [...READ_ACTIONS, "resource.edit"] },
  "mcp-center": { actions: ["resource.view", "resource.read"] },
  "skill-runtime": { actions: ["resource.view", "resource.read", "resource.useByAgent"] },
});

function resourceTypeFromMime(mime, filename) {
  const m = String(mime || "");
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "document";
  if (m === "application/json") return "code";
  if (m.startsWith("text/")) {
    const ext = domain.extensionOf(filename);
    if (["md", "markdown"].includes(ext)) return "document";
    if (["json", "js", "mjs", "cjs", "ts", "tsx", "css", "html", "xml", "yml", "yaml", "sh", "py", "rb", "go", "rs", "java", "c", "h", "cpp"].includes(ext)) return "code";
    return "text";
  }
  return "file";
}

class ResourceService {
  constructor({ identity, resourceStore, managedStore, authService, authStore = null, deviceService = null, logger = null, clock = null } = {}) {
    if (!identity) throw new Error("ResourceService 需要 IdentityStore");
    if (!resourceStore) throw new Error("ResourceService 需要 ResourceStore");
    if (!managedStore) throw new Error("ResourceService 需要 ManagedStore");
    if (!authService) throw new Error("ResourceService 需要 AuthorizationService");
    this.identity = identity;
    this.store = resourceStore;
    this.fs = managedStore;
    this.authService = authService;
    this.authStore = authStore;
    this.deviceService = deviceService;
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : identity.clock;
    this.#builtinEnsured = new Set();
    this.#running = new Map();
    this.#progress = new Map();
  }

  #builtinEnsured;
  #running;
  #progress;

  #now() {
    return this.clock();
  }

  /**
   * 先把 content_objects 行**独立提交**，再提交引用它的 Resource。
   * 这样"object 已 promote、DB commit 失败"会留下一条 ref_count=0 的可检测孤儿，
   * 由 recoverStartup / GC 清理；而不是一个无人知晓的磁盘文件（§54）。
   */
  #ensureContentObject(checksum, size, organizationId) {
    return this.store.contentObjectByChecksum(checksum, size) || this.store.insertContentObject({ checksum, size, internalKey: domain.contentInternalKey(checksum), organizationId });
  }

  #ensureBuiltinPolicy(context) {
    const ref = context && context.sessionRef;
    if (!ref || !this.authStore) return;
    const v = this.identity.validateSession(ref, { sensitive: false });
    if (!v.ok) return;
    const organizationId = v.user.team_id;
    if (this.#builtinEnsured.has(organizationId)) return;
    const admin = this.identity.allUsers().find((u) => u.role === "ADMIN" && u.team_id === organizationId) || null;
    const grantedBy = admin ? admin.id : "system:builtin-policy";
    try {
      this.store.transactSync(() => {
        for (const [appId, spec] of Object.entries(BUILTIN_APP_BASELINE)) {
          if (!this.authStore.appById(appId)) continue;
          this.authStore.upsertAppGrant({ appId, actions: spec.actions, grantedBy, organizationId });
          for (const extra of spec.scoped || []) {
            this.authStore.upsertAppGrant({ appId, ...extra, grantedBy, organizationId });
          }
        }
      });
    } catch {
      return;
    }
    this.#builtinEnsured.add(organizationId);
  }

  #validateTarget({ organizationId, scope, departmentId, collectionId }) {
    if (!authz.ALL_SCOPES.includes(String(scope || ""))) return fail(REASON.INVALID_INPUT, "scope");
    if (scope === "DEPARTMENT") {
      const dept = this.authStore ? this.authStore.departmentById(departmentId) : null;
      if (!dept || dept.organization_id !== organizationId) return fail(REASON.INVALID_INPUT, "department");
      if (dept.status !== "ACTIVE") return fail(REASON.INVALID_INPUT, "department-status");
    }
    if (collectionId) {
      const col = this.authStore ? this.authStore.collectionById(collectionId) : null;
      if (!col || col.organization_id !== organizationId) return fail(REASON.INVALID_INPUT, "collection");
    }
    return ok({});
  }

  #actor(context) {
    const v = this.identity.validateSession(context && context.sessionRef, { sensitive: false });
    if (!v.ok) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    return ok({ user: v.user });
  }

  #parseRef(resourceRef) {
    if (typeof resourceRef === "string") return authz.parseResourceRef(resourceRef);
    if (resourceRef && resourceRef.resourceId) return authz.parseResourceRef(resourceRef.resourceId);
    return null;
  }

  #resolveRow(resourceRef) {
    const id = this.#parseRef(resourceRef);
    return id ? this.store.resourceRowById(id) : null;
  }

  #realSource(sourcePath, { rejectSymlink = false } = {}) {
    if (typeof sourcePath !== "string" || !sourcePath || sourcePath.includes("\u0000")) return fail(REASON.INVALID_INPUT, "source");
    let lst;
    try {
      lst = fs.lstatSync(sourcePath);
    } catch {
      return fail(REASON.SOURCE_MISSING);
    }
    if (rejectSymlink && lst.isSymbolicLink()) return fail(REASON.LINKED_SYMLINK_REJECTED);
    let realPath;
    try {
      realPath = fs.realpathSync(sourcePath);
    } catch {
      return fail(REASON.SOURCE_MISSING);
    }
    let st;
    try {
      st = fs.statSync(realPath);
    } catch {
      return fail(REASON.SOURCE_MISSING);
    }
    if (!st.isFile()) return fail(REASON.SOURCE_NOT_REGULAR);
    try {
      fs.accessSync(realPath, fs.constants.R_OK);
    } catch {
      return fail(REASON.SOURCE_UNREADABLE);
    }
    return ok({ realPath, stat: st, originalPath: sourcePath, isSymlink: lst.isSymbolicLink() });
  }

  async #sniffFile(realPath, filename) {
    let fd;
    try {
      fd = await fsp.open(realPath, "r");
      const buf = Buffer.alloc(64);
      const { bytesRead } = await fd.read(buf, 0, 64, 0);
      return domain.sniffMime(buf.subarray(0, bytesRead), filename);
    } catch {
      return "application/octet-stream";
    } finally {
      if (fd) await fd.close().catch(() => {});
    }
  }

  #availability(row, context) {
    if (!row) return { availability: AVAILABILITY.UNKNOWN, reason: REASON.CONTENT_OBJECT_UNKNOWN };
    if (row.trash_state === TRASH_STATE.TRASHED) return { availability: AVAILABILITY.TRASHED, reason: null };
    if (row.storage_mode === STORAGE_MODE.MANAGED) {
      if (!row.checksum) return { availability: AVAILABILITY.INTEGRITY_FAILED, reason: REASON.CONTENT_OBJECT_UNKNOWN };
      const st = this.fs.objectStat(row.checksum);
      if (!st.exists) return { availability: AVAILABILITY.INTEGRITY_FAILED, reason: REASON.OBJECT_MISSING };
      if (row.size != null && Number(st.size) !== Number(row.size)) return { availability: AVAILABILITY.INTEGRITY_FAILED, reason: REASON.OBJECT_SIZE_MISMATCH };
      return { availability: AVAILABILITY.AVAILABLE, reason: null };
    }
    const deviceId = row.storage_device_id || LOCAL_DEVICE_ID;
    if (deviceId !== LOCAL_DEVICE_ID && this.deviceService) {
      const loc = this.deviceService.resolveResourceLocation({ context, deviceId });
      if (!loc.ok) return { availability: AVAILABILITY.DEVICE_UNKNOWN, reason: loc.error };
      const mapped = domain.availabilityFromDevice(loc.location);
      if (mapped) return { availability: mapped, reason: mapped };
      return { availability: AVAILABILITY.AVAILABLE, reason: null, remote: true };
    }
    if (!row.source_locator) return { availability: AVAILABILITY.SOURCE_MISSING, reason: REASON.SOURCE_MISSING };
    let st;
    try {
      st = fs.statSync(row.source_locator);
    } catch {
      return { availability: AVAILABILITY.SOURCE_MISSING, reason: REASON.SOURCE_MISSING };
    }
    if (!st.isFile()) return { availability: AVAILABILITY.SOURCE_MISSING, reason: REASON.SOURCE_NOT_REGULAR };
    if (row.observed_size != null && Number(st.size) !== Number(row.observed_size)) return { availability: AVAILABILITY.SOURCE_CHANGED, reason: REASON.SOURCE_CHANGED };
    if (row.observed_mtime != null && Math.abs(Number(st.mtimeMs) - Number(row.observed_mtime)) > 2) return { availability: AVAILABILITY.SOURCE_CHANGED, reason: REASON.SOURCE_CHANGED };
    return { availability: AVAILABILITY.AVAILABLE, reason: null };
  }

  #descriptor(row, context, extras = {}) {
    const avail = this.#availability(row, context);
    const descriptor = domain.descriptorProjection(row, { availability: avail.availability, favorite: extras.favorite, recentAt: extras.recentAt });
    descriptor.source = domain.presentSource({ storageMode: row.storage_mode, storageDeviceId: row.storage_device_id });
    descriptor.remoteContent = !!avail.remote;
    return descriptor;
  }

  #location(row, context) {
    const avail = this.#availability(row, context);
    return {
      storageMode: row.storage_mode,
      deviceId: row.storage_device_id || (row.storage_mode === STORAGE_MODE.MANAGED ? LOCAL_DEVICE_ID : null),
      availability: avail.availability,
      reason: avail.reason || null,
      checkedAt: this.#now(),
    };
  }

  #load({ context, resourceRef, action, allowInactiveResource = false, agent = undefined, opaque = false }) {
    const row = this.#resolveRow(resourceRef);
    if (!row) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const decision = this.authService.authorize({ context, action, resource: row.resource_id, allowInactiveResource, agent });
    if (decision.decision !== "ALLOW") return fail(opaque ? REASON.NOT_FOUND_OR_FORBIDDEN : decision.reasonCode || REASON.NOT_FOUND_OR_FORBIDDEN);
    return ok({ row });
  }

  #newProgressCallback(jobId, onProgress) {
    return (p) => {
      const record = { jobId, phase: p.phase, bytesTotal: p.bytesTotal == null ? null : Number(p.bytesTotal), bytesProcessed: Number(p.bytesProcessed || 0) };
      this.#progress.set(jobId, record);
      if (onProgress) {
        try {
          onProgress(record);
        } catch {
          /* 进度回调失败不得影响导入 */
        }
      }
    };
  }

  #linkSignal(jobId, signal) {
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    this.#running.set(jobId, controller);
    return controller;
  }

  #finishJob(jobId) {
    this.#running.delete(jobId);
  }

  async importManaged({ context, sourcePath, name, description = "", resourceType = null, mimeType = null, scope = "PERSONAL", departmentId = null, collectionId = null, ownerUserId = null, tags = [], source = SOURCE.IMPORT, generated = null, onProgress = null, signal = null } = {}) {
    this.#ensureBuiltinPolicy(context);
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const user = actor.user;
    const src = this.#realSource(sourcePath, { rejectSymlink: false });
    if (!src.ok) return src;
    const target = this.#validateTarget({ organizationId: user.team_id, scope, departmentId, collectionId });
    if (!target.ok) return target;
    const providedName = name || path.basename(src.originalPath);
    const mime = mimeType || (await this.#sniffFile(src.realPath, providedName));
    const resType = resourceType || resourceTypeFromMime(mime, providedName);
    if (!authz.RESOURCE_TYPES.includes(resType)) return fail(REASON.INVALID_INPUT, "resource-type");
    const appId = (context && context.appId) || "resource-library";
    const create = this.authService.authorizeCreate({ context, application: { appId }, scope, departmentId, collectionId, resourceType: resType });
    if (create.decision !== "ALLOW") return fail(create.reasonCode || REASON.NOT_FOUND_OR_FORBIDDEN);
    const space = this.fs.hasSpaceFor(src.stat.size);
    if (space.checked && !space.ok) return fail(REASON.DISK_SPACE_INSUFFICIENT, "free=" + space.free + " required=" + space.required);

    const job = this.store.transactSync(() =>
      this.store.createImportJob({ organizationId: user.team_id, actorUserId: user.id, appId, storageMode: STORAGE_MODE.MANAGED, bytesTotal: src.stat.size }),
    );
    const jobId = job.id;
    const controller = this.#linkSignal(jobId, signal);
    try {
      const progress = this.#newProgressCallback(jobId, onProgress);
      const staged = await this.fs.stageFromFile(jobId, src.realPath, { sourceSize: src.stat.size, onProgress: progress, signal: controller.signal });
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.HASHED, checksum: staged.checksum, size: staged.size, stagingKey: domain.stagingKeyFor(jobId) }));
      const promote = await this.fs.promoteStaging(jobId, staged.checksum);
      if (!promote.ok) throw Object.assign(new Error(promote.error), { code: promote.error });
      this.store.transactSync(() => this.#ensureContentObject(staged.checksum, staged.size, user.team_id));
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.OBJECT_READY }));
      const committed = this.#commitResource({
        context, jobId, user, resourceType: resType, mimeType: mime, name: providedName, description,
        storageMode: STORAGE_MODE.MANAGED, checksum: staged.checksum, size: staged.size, storageDeviceId: LOCAL_DEVICE_ID,
        sourceLocator: null, sourceIdentity: null, observedSize: null, observedMtime: null, sourceLabel: source,
        ownerUserId: ownerUserId || user.id, scope, departmentId, collectionId, tags, generated, version: 1,
      });
      if (!committed.ok) throw Object.assign(new Error(committed.error), { code: committed.error });
      this.fs.removeStaging(jobId);
      this.#finishJob(jobId);
      return ok({ resource: this.#descriptor(this.store.resourceRowById(committed.resourceId), context), jobId });
    } catch (err) {
      const cancelled = controller.signal.aborted || (err && err.code === REASON.IMPORT_CANCELLED) || (err && err.name === "AbortError");
      this.fs.removeStaging(jobId);
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: cancelled ? IMPORT_PHASE.CANCELLED : IMPORT_PHASE.FAILED, errorCode: cancelled ? REASON.IMPORT_CANCELLED : (err && err.code) || REASON.IMPORT_FAILED }));
      this.#finishJob(jobId);
      return fail(cancelled ? REASON.IMPORT_CANCELLED : (err && err.code) || REASON.IMPORT_FAILED);
    }
  }

  async importText({ context, text, name = "untitled.txt", description = "", resourceType = "text", memorySubtype = null, language = null, attributes = null, scope = "PERSONAL", departmentId = null, collectionId = null, tags = [], source = SOURCE.USER, generated = null, onProgress = null } = {}) {
    this.#ensureBuiltinPolicy(context);
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const user = actor.user;
    const target = this.#validateTarget({ organizationId: user.team_id, scope, departmentId, collectionId });
    if (!target.ok) return target;
    const buf = Buffer.from(String(text == null ? "" : text), "utf8");
    const resType = resourceType || "text";
    if (!authz.RESOURCE_TYPES.includes(resType)) return fail(REASON.INVALID_INPUT, "resource-type");
    const appId = (context && context.appId) || "resource-library";
    const create = this.authService.authorizeCreate({ context, application: { appId }, scope, departmentId, collectionId, resourceType: resType });
    if (create.decision !== "ALLOW") return fail(create.reasonCode || REASON.NOT_FOUND_OR_FORBIDDEN);
    const job = this.store.transactSync(() =>
      this.store.createImportJob({ organizationId: user.team_id, actorUserId: user.id, appId, storageMode: STORAGE_MODE.MANAGED, bytesTotal: buf.length }),
    );
    const jobId = job.id;
    try {
      const progress = this.#newProgressCallback(jobId, onProgress);
      const staged = await this.fs.stageFromBuffer(jobId, buf, { onProgress: progress });
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.HASHED, checksum: staged.checksum, size: staged.size, stagingKey: domain.stagingKeyFor(jobId) }));
      const promote = await this.fs.promoteStaging(jobId, staged.checksum);
      if (!promote.ok) throw Object.assign(new Error(promote.error), { code: promote.error });
      this.store.transactSync(() => this.#ensureContentObject(staged.checksum, staged.size, user.team_id));
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.OBJECT_READY }));
      const committed = this.#commitResource({
        context, jobId, user, resourceType: resType, mimeType: "text/plain", name, description,
        storageMode: STORAGE_MODE.MANAGED, checksum: staged.checksum, size: staged.size, storageDeviceId: LOCAL_DEVICE_ID,
        sourceLabel: source, ownerUserId: user.id, scope, departmentId, collectionId, tags, generated, version: 1,
        memorySubtype: resType === "memory" ? memorySubtype : null, language, attributes,
      });
      if (!committed.ok) throw Object.assign(new Error(committed.error), { code: committed.error });
      this.fs.removeStaging(jobId);
      return ok({ resource: this.#descriptor(this.store.resourceRowById(committed.resourceId), context), jobId });
    } catch (err) {
      this.fs.removeStaging(jobId);
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.FAILED, errorCode: (err && err.code) || REASON.IMPORT_FAILED }));
      return fail((err && err.code) || REASON.IMPORT_FAILED);
    }
  }

  #commitResource(args) {
    const { jobId, user, resourceType, mimeType, name, description, storageMode, checksum, size, storageDeviceId, sourceLocator, sourceIdentity, observedSize, observedMtime, sourceLabel, ownerUserId, scope, departmentId, collectionId, tags, generated, version } = args;
    const now = this.#now();
    try {
      const result = this.store.transactSync(() => {
        if (jobId) this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.COMMITTING });
        const registry = this.store.insertRegistryResource({
          resourceId: args.resourceId || null,
          resourceType,
          ownerUserId,
          organizationId: user.team_id,
          departmentId,
          collectionId,
          scope,
          name,
          description,
          tags,
          version,
        });
        let content = null;
        if (checksum) {
          content = this.store.contentObjectByChecksum(checksum, size) || this.store.insertContentObject({ checksum, size, internalKey: domain.contentInternalKey(checksum), organizationId: user.team_id });
        }
        this.store.insertLibraryResource({
          resourceId: registry.resource_id, resourceType, mimeType, name, description, storageMode,
          contentObjectId: content ? content.content_id : null, checksum, size, source: sourceLabel || SOURCE.USER,
          version, storageDeviceId, sourceLocator, sourceIdentity, observedSize, observedMtime,
          generatedSourceTaskId: generated ? generated.taskId || null : null,
          generatedSourceCallId: generated ? generated.callId || null : null,
          generatedSourceModel: generated ? generated.model || null : null,
          memorySubtype: args.memorySubtype || null,
          language: args.language || null,
          attributes: args.attributes || null,
          indexStatus: INDEX_STATUS.NOT_INDEXED,
        });
        this.store.insertVersion({ resourceId: registry.resource_id, version, contentObjectId: content ? content.content_id : null, checksum, size, storageMode, storageDeviceId, sourceLocator, source: sourceLabel || SOURCE.USER, createdBy: user.id, createdAt: now });
        if (content) this.store.refreshContentRefCount(content.content_id);
        if (jobId) this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.AVAILABLE, resourceId: registry.resource_id });
        return { resourceId: registry.resource_id };
      });
      return ok(result);
    } catch (err) {
      return fail(REASON.INTERNAL_ERROR, err && err.message);
    }
  }

  createLinked({ context, sourcePath, name, description = "", resourceType = null, mimeType = null, scope = "PERSONAL", departmentId = null, collectionId = null, tags = [], storageDeviceId = LOCAL_DEVICE_ID, ownerUserId = null, source = SOURCE.USER } = {}) {
    this.#ensureBuiltinPolicy(context);
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const user = actor.user;
    const src = this.#realSource(sourcePath, { rejectSymlink: true });
    if (!src.ok) return src;
    const target = this.#validateTarget({ organizationId: user.team_id, scope, departmentId, collectionId });
    if (!target.ok) return target;
    const providedName = name || path.basename(src.originalPath);
    const mime = mimeType || domain.sniffMime(Buffer.alloc(0), providedName);
    const resType = resourceType || resourceTypeFromMime(mime, providedName);
    if (!authz.RESOURCE_TYPES.includes(resType)) return fail(REASON.INVALID_INPUT, "resource-type");
    const appId = (context && context.appId) || "resource-library";
    const create = this.authService.authorizeCreate({ context, application: { appId }, scope, departmentId, collectionId, resourceType: resType });
    if (create.decision !== "ALLOW") return fail(create.reasonCode || REASON.NOT_FOUND_OR_FORBIDDEN);
    const committed = this.#commitResource({
      context, jobId: null, user, resourceType: resType, mimeType: mime, name: providedName, description,
      storageMode: STORAGE_MODE.LINKED, checksum: null, size: src.stat.size, storageDeviceId: storageDeviceId || LOCAL_DEVICE_ID,
      sourceLocator: src.realPath, sourceIdentity: src.realPath, observedSize: src.stat.size, observedMtime: src.stat.mtimeMs,
      sourceLabel: source, ownerUserId: ownerUserId || user.id, scope, departmentId, collectionId, tags, generated: null, version: 1,
    });
    if (!committed.ok) return committed;
    return ok({ resource: this.#descriptor(this.store.resourceRowById(committed.resourceId), context) });
  }

  get({ context, resourceRef } = {}) {
    this.#ensureBuiltinPolicy(context);
    const id = this.#parseRef(resourceRef);
    const row = id ? this.store.resourceRowById(id) : null;
    if (!row) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const trashed = row.trash_state === TRASH_STATE.TRASHED;
    const caps = this.authService.getCapabilities({ context, resource: row.resource_id, allowInactiveResource: trashed });
    if (!caps.ok) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const actor = this.#actor(context);
    const favorite = actor.ok ? this.store.isFavorite(actor.user.id, row.resource_id) : false;
    return ok({ resource: this.#descriptor(row, context, { favorite }), location: this.#location(row, context) });
  }

  read({ context, resourceRef, version = null } = {}) {
    this.#ensureBuiltinPolicy(context);
    const id = this.#parseRef(resourceRef);
    const row = id ? this.store.resourceRowById(id) : null;
    if (!row) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const trashed = row.trash_state === TRASH_STATE.TRASHED;
    const caps = this.authService.getCapabilities({ context, resource: row.resource_id, allowInactiveResource: trashed });
    if (!caps.ok) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    if (!caps.capabilities.canRead) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    if (trashed) return fail(REASON.RESOURCE_TRASHED);
    let effective = row;
    if (version != null) {
      const v = this.store.versionByNumber(row.resource_id, version);
      if (!v) return fail(REASON.INVALID_INPUT, "version");
      effective = { ...row, content_object_id: v.content_object_id, checksum: v.checksum, size: v.size, storage_mode: v.storage_mode, storage_device_id: v.storage_device_id, source_locator: v.source_locator };
    }
    if (effective.storage_mode === STORAGE_MODE.MANAGED) {
      const stream = this.fs.readObject(effective.checksum);
      if (!stream) return fail(REASON.OBJECT_MISSING);
      return ok({ stream, size: effective.size, mimeType: row.mime_type, checksum: effective.checksum, storageMode: STORAGE_MODE.MANAGED, deviceId: LOCAL_DEVICE_ID });
    }
    const avail = this.#availability(effective, context);
    if (avail.availability !== AVAILABILITY.AVAILABLE) return fail(avail.reason || avail.availability);
    if (avail.remote) return fail(REASON.REMOTE_DEVICE_CONTENT_UNSUPPORTED);
    const stream = fs.createReadStream(effective.source_locator, { highWaterMark: 1024 * 1024 });
    return ok({ stream, size: effective.size, mimeType: row.mime_type, checksum: null, storageMode: STORAGE_MODE.LINKED, deviceId: effective.storage_device_id || LOCAL_DEVICE_ID });
  }

  /**
   * D3-04D：受控 Export。**同时**要求 resource.export 与 canRead（read() 内校验），
   * 因此 App 不能借 Export 绕过 read 权限。targetPath 只能来自主进程 dialog，不来自 Renderer。
   */
  async exportToFile({ context, resourceRef, targetPath } = {}) {
    this.#ensureBuiltinPolicy(context);
    const id = this.#parseRef(resourceRef);
    const row = id ? this.store.resourceRowById(id) : null;
    if (!row) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const exportAuth = this.authService.authorize({ context, action: authz.ACTION.EXPORT, resource: id });
    if (exportAuth.decision !== "ALLOW") return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    if (!targetPath) return fail(REASON.INVALID_INPUT, "target");
    const r = this.read({ context, resourceRef });
    if (!r.ok) return r;
    const { pipeline } = require("node:stream/promises");
    const { Transform } = require("node:stream");
    let bytes = 0;
    try {
      await pipeline(
        r.stream,
        new Transform({ transform(chunk, _enc, cb) { bytes += chunk.length; cb(null, chunk); } }),
        fs.createWriteStream(String(targetPath)),
      );
    } catch {
      return fail(REASON.INTERNAL_ERROR, "export-failed");
    }
    return ok({ bytes, mimeType: r.mimeType, size: bytes });
  }

  /** D3-04D：LINKED Resource 的受控 Reveal Source（路径只在本方法内返回给主进程，绝不回 Renderer）。 */
  resolveRevealPath({ context, resourceRef } = {}) {
    this.#ensureBuiltinPolicy(context);
    const id = this.#parseRef(resourceRef);
    const row = id ? this.store.resourceRowById(id) : null;
    if (!row) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const auth = this.authService.authorize({ context, action: authz.ACTION.READ, resource: id });
    if (auth.decision !== "ALLOW") return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    if (row.storage_mode !== STORAGE_MODE.LINKED) return fail(REASON.PREVIEW_UNSUPPORTED, "not-linked");
    if ((row.storage_device_id || LOCAL_DEVICE_ID) !== LOCAL_DEVICE_ID) return fail(REASON.REMOTE_DEVICE_CONTENT_UNSUPPORTED);
    const avail = this.#availability(row, context);
    if (avail.availability !== AVAILABILITY.AVAILABLE) return fail(avail.reason || avail.availability);
    if (!row.source_locator) return fail(REASON.SOURCE_MISSING);
    return ok({ path: row.source_locator });
  }

  async readText({ context, resourceRef, maxBytes = domain.MAX_READ_TEXT_BYTES } = {}) {
    const res = this.read({ context, resourceRef });
    if (!res.ok) return res;
    const chunks = [];
    let total = 0;
    for await (const chunk of res.stream) {
      total += chunk.length;
      if (total > maxBytes) {
        res.stream.destroy();
        return fail(REASON.CONTENT_TOO_LARGE, "size=" + total);
      }
      chunks.push(chunk);
    }
    return ok({ text: Buffer.concat(chunks).toString("utf8"), size: total, mimeType: res.mimeType });
  }

  async replaceContent({ context, resourceRef, sourcePath, expectedVersion = null, onProgress = null, signal = null } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.EDIT, opaque: true });
    if (!load.ok) return load;
    const row = load.row;
    if (row.trash_state === TRASH_STATE.TRASHED) return fail(REASON.RESOURCE_TRASHED);
    const conflict = domain.evaluateVersionConflict({ expectedVersion, currentVersion: row.version });
    if (!conflict.ok) return conflict;
    const src = this.#realSource(sourcePath, { rejectSymlink: false });
    if (!src.ok) return src;
    const space = this.fs.hasSpaceFor(src.stat.size);
    if (space.checked && !space.ok) return fail(REASON.DISK_SPACE_INSUFFICIENT);
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const mime = await this.#sniffFile(src.realPath, row.name);
    const job = this.store.transactSync(() => this.store.createImportJob({ organizationId: row.organization_id, actorUserId: actor.user.id, appId: (context && context.appId) || "resource-library", storageMode: STORAGE_MODE.MANAGED, bytesTotal: src.stat.size }));
    const jobId = job.id;
    const controller = this.#linkSignal(jobId, signal);
    try {
      const progress = this.#newProgressCallback(jobId, onProgress);
      const staged = await this.fs.stageFromFile(jobId, src.realPath, { sourceSize: src.stat.size, onProgress: progress, signal: controller.signal });
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.HASHED, checksum: staged.checksum, size: staged.size, stagingKey: domain.stagingKeyFor(jobId) }));
      const promote = await this.fs.promoteStaging(jobId, staged.checksum);
      if (!promote.ok) throw Object.assign(new Error(promote.error), { code: promote.error });
      this.store.transactSync(() => this.#ensureContentObject(staged.checksum, staged.size, row.organization_id));
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.OBJECT_READY }));
      const committed = this.#commitNewVersion({ row, user: actor.user, checksum: staged.checksum, size: staged.size, mimeType: mime, jobId });
      if (!committed.ok) throw Object.assign(new Error(committed.error), { code: committed.error });
      this.fs.removeStaging(jobId);
      this.#finishJob(jobId);
      return ok({ resource: this.#descriptor(this.store.resourceRowById(row.resource_id), context), previousContentId: committed.previousContentId });
    } catch (err) {
      const cancelled = controller.signal.aborted || (err && err.code === REASON.IMPORT_CANCELLED);
      this.fs.removeStaging(jobId);
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: cancelled ? IMPORT_PHASE.CANCELLED : IMPORT_PHASE.FAILED, errorCode: cancelled ? REASON.IMPORT_CANCELLED : (err && err.code) || REASON.IMPORT_FAILED }));
      this.#finishJob(jobId);
      return fail(cancelled ? REASON.IMPORT_CANCELLED : (err && err.code) || REASON.IMPORT_FAILED);
    }
  }

  /** D3-04B：文本内容编辑（Memory / Text / Code / Prompt）。同样走 version + expectedVersion。 */
  async replaceText({ context, resourceRef, text, expectedVersion = null, language = undefined, mimeType = "text/plain" } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.EDIT, opaque: true });
    if (!load.ok) return load;
    const row = load.row;
    if (row.trash_state === TRASH_STATE.TRASHED) return fail(REASON.RESOURCE_TRASHED);
    const conflict = domain.evaluateVersionConflict({ expectedVersion, currentVersion: row.version });
    if (!conflict.ok) return conflict;
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const buf = Buffer.from(String(text == null ? "" : text), "utf8");
    const job = this.store.transactSync(() => this.store.createImportJob({ organizationId: row.organization_id, actorUserId: actor.user.id, appId: (context && context.appId) || "resource-library", storageMode: STORAGE_MODE.MANAGED, bytesTotal: buf.length }));
    const jobId = job.id;
    try {
      const staged = await this.fs.stageFromBuffer(jobId, buf, {});
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.HASHED, checksum: staged.checksum, size: staged.size, stagingKey: domain.stagingKeyFor(jobId) }));
      const promote = await this.fs.promoteStaging(jobId, staged.checksum);
      if (!promote.ok) throw Object.assign(new Error(promote.error), { code: promote.error });
      this.store.transactSync(() => this.#ensureContentObject(staged.checksum, staged.size, row.organization_id));
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.OBJECT_READY }));
      const committed = this.#commitNewVersion({ row, user: actor.user, checksum: staged.checksum, size: staged.size, mimeType, jobId });
      if (!committed.ok) throw Object.assign(new Error(committed.error), { code: committed.error });
      if (language !== undefined) this.store.transactSync(() => this.store.updateLibraryResource(row.resource_id, { language: language == null ? null : String(language) }));
      this.fs.removeStaging(jobId);
      this.#finishJob(jobId);
      return ok({ resource: this.#descriptor(this.store.resourceRowById(row.resource_id), context) });
    } catch (err) {
      this.fs.removeStaging(jobId);
      this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.FAILED, errorCode: (err && err.code) || REASON.IMPORT_FAILED }));
      this.#finishJob(jobId);
      return fail((err && err.code) || REASON.IMPORT_FAILED);
    }
  }

  #commitNewVersion({ row, user, checksum, size, mimeType, jobId }) {
    try {
      const out = this.store.transactSync(() => {
        const content = this.store.contentObjectByChecksum(checksum, size) || this.store.insertContentObject({ checksum, size, internalKey: domain.contentInternalKey(checksum), organizationId: row.organization_id });
        const next = this.store.nextVersionNumber(row.resource_id);
        this.store.insertVersion({ resourceId: row.resource_id, version: next, contentObjectId: content.content_id, checksum, size, storageMode: STORAGE_MODE.MANAGED, storageDeviceId: LOCAL_DEVICE_ID, source: SOURCE.USER, createdBy: user.id });
        this.store.updateLibraryResource(row.resource_id, { content_object_id: content.content_id, checksum, size, version: next, mime_type: mimeType, storage_mode: STORAGE_MODE.MANAGED, storage_device_id: LOCAL_DEVICE_ID, source_locator: null, observed_size: null, observed_mtime: null });
        this.store.updateRegistryVersion(row.resource_id, next);
        if (row.content_object_id) this.store.refreshContentRefCount(row.content_object_id);
        this.store.refreshContentRefCount(content.content_id);
        if (jobId) this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.AVAILABLE, resourceId: row.resource_id });
        return { previousContentId: row.content_object_id || null };
      });
      return ok(out);
    } catch (err) {
      return fail(REASON.INTERNAL_ERROR, err && err.message);
    }
  }

  restoreVersion({ context, resourceRef, version, expectedVersion = null } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.EDIT, opaque: true });
    if (!load.ok) return load;
    const row = load.row;
    if (row.trash_state === TRASH_STATE.TRASHED) return fail(REASON.RESOURCE_TRASHED);
    const conflict = domain.evaluateVersionConflict({ expectedVersion, currentVersion: row.version });
    if (!conflict.ok) return conflict;
    const old = this.store.versionByNumber(row.resource_id, version);
    if (!old) return fail(REASON.INVALID_INPUT, "version");
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    try {
      this.store.transactSync(() => {
        const next = this.store.nextVersionNumber(row.resource_id);
        this.store.insertVersion({ resourceId: row.resource_id, version: next, contentObjectId: old.content_object_id, checksum: old.checksum, size: old.size, storageMode: old.storage_mode, storageDeviceId: old.storage_device_id, sourceLocator: old.source_locator, source: "restore", createdBy: actor.user.id });
        this.store.updateLibraryResource(row.resource_id, { content_object_id: old.content_object_id, checksum: old.checksum, size: old.size, version: next, storage_mode: old.storage_mode, storage_device_id: old.storage_device_id, source_locator: old.source_locator });
        this.store.updateRegistryVersion(row.resource_id, next);
        if (old.content_object_id) this.store.refreshContentRefCount(old.content_object_id);
      });
    } catch (err) {
      return fail(REASON.INTERNAL_ERROR, err && err.message);
    }
    return ok({ resource: this.#descriptor(this.store.resourceRowById(row.resource_id), context), restoredFrom: Number(version) });
  }

  delete({ context, resourceRef } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.DELETE });
    if (!load.ok) return load;
    const row = load.row;
    if (row.trash_state === TRASH_STATE.TRASHED) return ok({ changed: false, reasonCode: REASON.NO_CHANGE });
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    this.store.transactSync(() => {
      this.store.setTrashState(row.resource_id, { trashed: true, by: actor.user.id });
      this.store.setRegistryStatus(row.resource_id, "deleted");
    });
    return ok({ changed: true, resource: this.#descriptor(this.store.resourceRowById(row.resource_id), context) });
  }

  restore({ context, resourceRef } = {}) {
    this.#ensureBuiltinPolicy(context);
    const id = this.#parseRef(resourceRef);
    const row = id ? this.store.resourceRowById(id) : null;
    if (!row) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    if (row.trash_state !== TRASH_STATE.TRASHED) return ok({ changed: false, reasonCode: REASON.NO_CHANGE });
    const load = this.#load({ context, resourceRef, action: authz.ACTION.RESTORE, allowInactiveResource: true, opaque: true });
    if (!load.ok) return load;
    this.store.transactSync(() => {
      this.store.setTrashState(row.resource_id, { trashed: false });
      this.store.setRegistryStatus(row.resource_id, "active");
    });
    return ok({ changed: true, resource: this.#descriptor(this.store.resourceRowById(row.resource_id), context) });
  }

  permanentDelete({ context, resourceRef } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.PERMANENT_DELETE, allowInactiveResource: true, opaque: true });
    if (!load.ok) return load;
    const row = load.row;
    const contentId = row.content_object_id;
    const checksum = row.checksum;
    const incoming = this.store.relationsTo(row.resource_id).length;
    this.store.transactSync(() => {
      if (this.authStore) {
        this.authStore.deleteGrantsForResource(row.resource_id);
        this.authStore.deleteAppGrantsForResource(row.resource_id);
      }
      this.store.deleteRegistryRow(row.resource_id);
      if (contentId) this.store.refreshContentRefCount(contentId);
    });
    let gc = { removed: false, contentId: null, refs: null };
    if (contentId) {
      const refs = this.store.contentReferenceCount(contentId);
      if (refs === 0) {
        this.store.setContentStatus(contentId, CONTENT_STATUS.GC_PENDING);
        const removed = checksum ? this.fs.removeObject(checksum).removed : false;
        this.store.setContentStatus(contentId, CONTENT_STATUS.DELETED);
        gc = { removed, contentId, refs: 0 };
      } else {
        // §45：还有其它 Resource / Version 引用 -> 物理对象必须保留。
        gc = { removed: false, contentId, refs };
      }
    }
    return ok({ changed: true, resourceRef: authz.toResourceRef(row.resource_id), contentGc: gc, incomingReferences: incoming });
  }

  list({ context, includeTrashed = false, filter = {} } = {}) {
    this.#ensureBuiltinPolicy(context);
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: REASON.NOT_FOUND_OR_FORBIDDEN, items: [], count: 0 };
    const rows = this.store.resourceRowsByOrg(actor.user.team_id);
    const items = [];
    for (const row of rows) {
      if (!includeTrashed && row.trash_state === TRASH_STATE.TRASHED) continue;
      if (filter.resourceType && row.resource_type !== filter.resourceType) continue;
      if (filter.storageMode && row.storage_mode !== filter.storageMode) continue;
      if (filter.departmentId && row.department_id !== filter.departmentId) continue;
      if (filter.collectionId && row.collection_id !== filter.collection_id) continue;
      const caps = this.authService.getCapabilities({ context, resource: row.resource_id, allowInactiveResource: includeTrashed });
      if (!caps.ok) continue;
      items.push(this.#descriptor(row, context));
    }
    return { ok: true, items, count: items.length, includeTrashed: !!includeTrashed };
  }

  addRelation({ context, fromRef, toRef, relationType } = {}) {
    this.#ensureBuiltinPolicy(context);
    const type = domain.validateRelationType(relationType);
    if (!type.ok) return type;
    const from = this.#load({ context, resourceRef: fromRef, action: authz.ACTION.VIEW, opaque: true });
    if (!from.ok) return from;
    const to = this.#load({ context, resourceRef: toRef, action: authz.ACTION.VIEW, opaque: true });
    if (!to.ok) return to;
    try {
      const actor = this.#actor(context);
      const rel = this.store.transactSync(() => this.store.insertRelation({ organizationId: from.row.organization_id, fromResourceId: from.row.resource_id, toResourceId: to.row.resource_id, relationType, createdBy: actor.ok ? actor.user.id : null }));
      return ok({ relation: rel });
    } catch (err) {
      return fail(REASON.INTERNAL_ERROR, err && err.message);
    }
  }

  listRelations({ context, resourceRef } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.VIEW, opaque: true });
    if (!load.ok) return load;
    return ok({ outgoing: this.store.relationsFrom(load.row.resource_id), incoming: this.store.relationsTo(load.row.resource_id) });
  }

  incomingReferences({ context, resourceRef } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.VIEW, opaque: true });
    if (!load.ok) return load;
    return ok({ items: this.store.relationsTo(load.row.resource_id) });
  }

  async verifyIntegrity({ context, resourceRef } = {}) {
    this.#ensureBuiltinPolicy(context);
    const id = this.#parseRef(resourceRef);
    const row = id ? this.store.resourceRowById(id) : null;
    if (!row) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const trashed = row.trash_state === TRASH_STATE.TRASHED;
    const caps = this.authService.getCapabilities({ context, resource: row.resource_id, allowInactiveResource: trashed });
    if (!caps.ok) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    if (trashed) return ok({ integrity: { status: AVAILABILITY.TRASHED, checks: ["trashed"] }, availability: AVAILABILITY.TRASHED });
    if (row.storage_mode === STORAGE_MODE.MANAGED) {
      const st = this.fs.objectStat(row.checksum);
      if (!st.exists) return ok({ integrity: { status: AVAILABILITY.INTEGRITY_FAILED, reason: REASON.OBJECT_MISSING, checks: ["object-missing"] }, availability: AVAILABILITY.INTEGRITY_FAILED });
      if (row.size != null && Number(st.size) !== Number(row.size)) return ok({ integrity: { status: AVAILABILITY.INTEGRITY_FAILED, reason: REASON.OBJECT_SIZE_MISMATCH, checks: ["size-mismatch"] }, availability: AVAILABILITY.INTEGRITY_FAILED });
      const hashed = await this.fs.hashObject(row.checksum);
      const status = hashed.ok ? AVAILABILITY.AVAILABLE : AVAILABILITY.INTEGRITY_FAILED;
      return ok({ integrity: { status, reason: hashed.error || null, checks: ["object-exists", "size", "sha256"] }, availability: status });
    }
    const avail = this.#availability(row, context);
    return ok({ integrity: { status: avail.availability, reason: avail.reason || null, checks: ["device", "source", "observed-size", "observed-mtime"] }, availability: avail.availability });
  }

  progressOf(jobId) {
    return this.#progress.get(jobId) || null;
  }

  getJob({ context, jobId } = {}) {
    this.#ensureBuiltinPolicy(context);
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const job = this.store.importJobById(jobId);
    if (!job) return fail(REASON.INVALID_INPUT, "job");
    if (job.organization_id !== actor.user.team_id) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    return ok({ job: { id: job.id, phase: job.phase, bytesTotal: job.bytes_total, bytesProcessed: job.bytes_processed, resourceId: job.resource_id, errorCode: job.error_code } });
  }

  cancelImport({ context, jobId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const job = this.store.importJobById(jobId);
    if (!job || job.organization_id !== actor.user.team_id) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const controller = this.#running.get(jobId);
    if (controller) {
      controller.abort();
      return ok({ cancelled: true, jobId });
    }
    if (domain.TERMINAL_IMPORT_PHASES.includes(job.phase)) return ok({ cancelled: false, reasonCode: REASON.NO_CHANGE });
    this.store.transactSync(() => this.store.updateImportJob(jobId, { phase: IMPORT_PHASE.CANCELLED }));
    return ok({ cancelled: true, jobId });
  }

  recoverStartup() {
    const report = { jobs: [], stagingOrphans: [], objectMismatches: [], gc: [] };
    for (const job of this.store.unfinishedImportJobs()) {
      if (job.resource_id && this.store.libraryResourceById(job.resource_id)) {
        this.store.transactSync(() => this.store.updateImportJob(job.id, { phase: IMPORT_PHASE.AVAILABLE }));
        report.jobs.push({ jobId: job.id, action: "marked-available" });
        continue;
      }
      this.fs.removeStaging(job.id);
      this.store.transactSync(() => this.store.updateImportJob(job.id, { phase: IMPORT_PHASE.ORPHANED, errorCode: "RECOVERED_INCOMPLETE" }));
      report.jobs.push({ jobId: job.id, action: "orphaned" });
    }
    const knownStaging = new Set(this.store.allImportJobs().map((j) => j.staging_key).filter(Boolean));
    for (const file of this.fs.listStaging()) {
      if (!knownStaging.has("staging/" + file)) {
        try {
          fs.rmSync(path.join(this.fs.root, "staging", file), { force: true });
          report.stagingOrphans.push(file);
        } catch {
          /* ignore */
        }
      }
    }
    for (const content of this.store.allContentObjects()) {
      const st = this.fs.objectStat(content.checksum);
      if (!st.exists) report.objectMismatches.push({ contentId: content.content_id, reason: REASON.OBJECT_MISSING });
      else if (Number(st.size) !== Number(content.size)) report.objectMismatches.push({ contentId: content.content_id, reason: REASON.OBJECT_SIZE_MISMATCH });
    }
    for (const content of this.store.orphanContentObjects()) {
      this.fs.removeObject(content.checksum);
      this.store.transactSync(() => this.store.setContentStatus(content.content_id, CONTENT_STATUS.DELETED));
      report.gc.push(content.content_id);
    }
    return ok({ report });
  }

  gcOrphanObjects({ context } = {}) {
    const gate = this.#actor(context);
    if (!gate.ok || gate.user.role !== "ADMIN") return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const orphans = this.store.orphanContentObjects();
    const removed = [];
    for (const content of orphans) {
      this.fs.removeObject(content.checksum);
      this.store.transactSync(() => this.store.setContentStatus(content.content_id, CONTENT_STATUS.DELETED));
      removed.push(content.content_id);
    }
    return ok({ removed, count: removed.length });
  }

  // -------------------------------------------------------------------------
  // D3-04B · Create / Metadata / Collection / Tag / Favorite / Recent / Query
  // -------------------------------------------------------------------------

  /** 新建 Memory / Text / Code / Prompt。内容真实走 importText（形成 v1）。 */
  async createResource({ context, resourceType = "text", name, description = "", content = "", memorySubtype = null, language = null, attributes = null, tags = [], collectionId = null, scope = "PERSONAL", departmentId = null } = {}) {
    const type = String(resourceType || "text");
    if (!["memory", "text", "code", "prompt"].includes(type)) return fail(REASON.INVALID_INPUT, "create-type");
    if (type === "memory") {
      const check = domain.validateMemorySubtype(memorySubtype);
      if (!check.ok) return check;
    }
    const created = await this.importText({
      context, text: content, name, description, resourceType: type,
      memorySubtype: type === "memory" ? memorySubtype : null, language, attributes,
      scope, departmentId, collectionId: null, tags: [], source: SOURCE.USER,
    });
    if (!created.ok) return created;
    const resourceId = created.resource.resourceId;
    if (collectionId) this.setCollection({ context, resourceRef: resourceId, collectionId });
    for (const t of Array.isArray(tags) ? tags : []) {
      if (typeof t === "string" && t.trim()) this.assignTag({ context, resourceRef: resourceId, name: t });
    }
    return this.get({ context, resourceRef: resourceId });
  }

  /** Metadata 修改（name / description / collection / memory subtype / language / attributes）。不产生内容 version。 */
  updateMetadata({ context, resourceRef, name, description, collectionId, memorySubtype, language, attributes } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.EDIT, opaque: true });
    if (!load.ok) return load;
    const row = load.row;
    if (row.trash_state === TRASH_STATE.TRASHED) return fail(REASON.RESOURCE_TRASHED);
    if (collectionId !== undefined && collectionId !== null) {
      const col = this.authStore ? this.authStore.collectionById(collectionId) : null;
      if (!col || col.organization_id !== row.organization_id || col.status !== "active") return fail(REASON.INVALID_INPUT, "collection");
    }
    let sub;
    if (memorySubtype !== undefined) {
      const check = domain.validateMemorySubtype(memorySubtype);
      if (!check.ok) return check;
      sub = check.memorySubtype;
    }
    const patch = {};
    if (name !== undefined) patch.name = String(name);
    if (description !== undefined) patch.description = String(description);
    if (sub !== undefined) patch.memory_subtype = sub;
    if (language !== undefined) patch.language = language == null ? null : String(language);
    if (attributes !== undefined) patch.attributes = JSON.stringify(attributes && typeof attributes === "object" ? attributes : {});
    this.store.transactSync(() => {
      this.store.updateRegistryMetadata(row.resource_id, { name, description, collectionId });
      if (Object.keys(patch).length) this.store.updateLibraryResource(row.resource_id, patch);
    });
    return this.get({ context, resourceRef: row.resource_id });
  }

  /** 移动 Resource 到 Collection（primary Collection）。null = Unfiled。 */
  setCollection({ context, resourceRef, collectionId = null } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.MOVE, opaque: true });
    if (!load.ok) return load;
    const row = load.row;
    if (collectionId != null) {
      const col = this.authStore ? this.authStore.collectionById(collectionId) : null;
      if (!col || col.organization_id !== row.organization_id || col.status !== "active") return fail(REASON.INVALID_INPUT, "collection");
    }
    this.store.transactSync(() => this.store.updateRegistryMetadata(row.resource_id, { collectionId: collectionId == null ? null : String(collectionId) }));
    return this.get({ context, resourceRef: row.resource_id });
  }

  // --- Collections ----------------------------------------------------------

  #collectionView(col, userId) {
    return {
      collectionId: col.id,
      name: col.name,
      description: col.description,
      scope: col.scope,
      ownerUserId: col.owner_user_id,
      departmentId: col.department_id ?? null,
      status: col.status,
      resourceCount: this.store.countCollectionResources(col.id),
      editable: col.owner_user_id === userId,
      createdAt: col.created_at,
      updatedAt: col.updated_at,
    };
  }

  #authorizeCollection({ context, collection }) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    if (!collection || collection.organization_id !== actor.user.team_id) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    if (actor.user.role === "ADMIN") return ok({ user: actor.user, source: "SUPER_ADMIN" });
    if (collection.owner_user_id === actor.user.id) return ok({ user: actor.user, source: "OWNER_POLICY" });
    if (collection.scope === "DEPARTMENT" && collection.department_id && this.authStore) {
      const m = this.authStore.membershipByPair(collection.department_id, actor.user.id);
      if (m && m.status === "ACTIVE" && m.membership_role === "department-admin") return ok({ user: actor.user, source: "DEPARTMENT_ADMIN" });
    }
    return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
  }

  createCollection({ context, name, description = "" } = {}) {
    this.#ensureBuiltinPolicy(context);
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const nm = String(name || "").trim();
    if (!nm) return fail(REASON.INVALID_INPUT, "collection-name");
    const create = this.authService.authorizeCreate({ context, application: { appId: (context && context.appId) || "resource-library" }, scope: "PERSONAL", resourceType: "collection" });
    if (create.decision !== "ALLOW") return fail(create.reasonCode || REASON.NOT_FOUND_OR_FORBIDDEN);
    const col = this.store.transactSync(() =>
      this.authStore.insertCollection({ organizationId: actor.user.team_id, ownerUserId: actor.user.id, name: nm, description: String(description || ""), scope: "PERSONAL" }),
    );
    return ok({ collection: this.#collectionView(col, actor.user.id) });
  }

  listCollections({ context } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const deptIds = new Set(this.authStore.membershipsOfUser(actor.user.id).filter((m) => m.status === "ACTIVE").map((m) => m.department_id));
    const cols = this.authStore
      .collectionsOfOrg(actor.user.team_id)
      .filter((c) => c.status === "active" && (c.owner_user_id === actor.user.id || c.scope === "ORGANIZATION" || (c.scope === "DEPARTMENT" && deptIds.has(c.department_id))));
    const items = cols.map((c) => this.#collectionView(c, actor.user.id));
    return ok({ items, count: items.length });
  }

  updateCollection({ context, collectionId, name, description } = {}) {
    const col = this.authStore ? this.authStore.collectionById(collectionId) : null;
    const auth = this.#authorizeCollection({ context, collection: col });
    if (!auth.ok) return auth;
    if (name != null && !String(name).trim()) return fail(REASON.INVALID_INPUT, "collection-name");
    const updated = this.store.transactSync(() => this.authStore.updateCollection(col.id, { name, description }));
    return ok({ collection: this.#collectionView(updated.collection || this.authStore.collectionById(col.id), auth.user.id) });
  }

  /** 删除 Collection：Resource 绝不级联删除，统一回 Unfiled。 */
  deleteCollection({ context, collectionId } = {}) {
    const col = this.authStore ? this.authStore.collectionById(collectionId) : null;
    const auth = this.#authorizeCollection({ context, collection: col });
    if (!auth.ok) return auth;
    const count = this.store.countCollectionResources(col.id);
    this.store.transactSync(() => {
      this.store.clearCollection(col.id);
      this.authStore.setCollectionStatus(col.id, "deleted");
    });
    return ok({ deleted: true, collectionId: col.id, movedToUnfiled: count });
  }

  getCollection({ context, collectionId } = {}) {
    const col = this.authStore ? this.authStore.collectionById(collectionId) : null;
    const auth = this.#authorizeCollection({ context, collection: col });
    if (!auth.ok) return auth;
    return ok({ collection: this.#collectionView(col, auth.user.id) });
  }

  // --- Tags -----------------------------------------------------------------

  createTag({ context, name } = {}) {
    this.#ensureBuiltinPolicy(context);
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const norm = domain.normalizeTagName(name);
    if (!norm.ok) return norm;
    const create = this.authService.authorizeCreate({ context, application: { appId: (context && context.appId) || "resource-library" }, scope: "PERSONAL", resourceType: "other", action: authz.ACTION.TAG });
    if (create.decision !== "ALLOW") return fail(create.reasonCode || REASON.NOT_FOUND_OR_FORBIDDEN);
    const existing = this.store.tagByNormalized(actor.user.team_id, norm.normalizedName);
    let tag;
    this.store.transactSync(() => {
      if (existing) {
        if (existing.status !== "active") this.store.setTagStatus(existing.id, "active");
        if (existing.name !== norm.name) this.store.updateTagName(existing.id, norm.name, norm.normalizedName);
        tag = this.store.tagById(existing.id);
      } else {
        tag = this.store.insertTag({ organizationId: actor.user.team_id, name: norm.name, normalizedName: norm.normalizedName, source: TAG_SOURCE.USER, createdBy: actor.user.id });
      }
    });
    return ok({ tag, created: !existing });
  }

  listTags({ context } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const items = this.store.tagsOfOrg(actor.user.team_id).map((t) => ({ tagId: t.id, name: t.name, normalizedName: t.normalized_name, source: t.source, createdBy: t.created_by, createdAt: t.created_at }));
    return ok({ items, count: items.length });
  }

  #refreshRegistryTags(resourceId) {
    const names = this.store.tagsOfResource(resourceId).map((t) => t.name);
    this.store.setRegistryTags(resourceId, names);
    return names;
  }

  assignTag({ context, resourceRef, name, tagId } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.TAG, opaque: true });
    if (!load.ok) return load;
    const row = load.row;
    if (this.store.countResourceTags(row.resource_id) >= domain.MAX_TAG_COUNT_PER_RESOURCE) return fail(REASON.INVALID_INPUT, "tag-limit");
    let tag = tagId ? this.store.tagById(tagId) : null;
    if (!tag && name) {
      const norm = domain.normalizeTagName(name);
      if (!norm.ok) return norm;
      tag = this.store.tagByNormalized(row.organization_id, norm.normalizedName);
      if (!tag) {
        const actor = this.#actor(context);
        tag = this.store.transactSync(() => this.store.insertTag({ organizationId: row.organization_id, name: norm.name, normalizedName: norm.normalizedName, source: TAG_SOURCE.USER, createdBy: actor.ok ? actor.user.id : null }));
      }
    }
    if (!tag || tag.organization_id !== row.organization_id) return fail(REASON.INVALID_INPUT, "tag");
    const actor = this.#actor(context);
    this.store.transactSync(() => {
      this.store.insertResourceTag({ resourceId: row.resource_id, tagId: tag.id, organizationId: row.organization_id, source: TAG_SOURCE.USER, assignedBy: actor.ok ? actor.user.id : null });
      this.#refreshRegistryTags(row.resource_id);
    });
    return ok({ tags: this.store.tagsOfResource(row.resource_id) });
  }

  removeTag({ context, resourceRef, tagId } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.TAG, opaque: true });
    if (!load.ok) return load;
    const row = load.row;
    this.store.transactSync(() => {
      this.store.deleteResourceTag(row.resource_id, tagId);
      this.#refreshRegistryTags(row.resource_id);
    });
    return ok({ tags: this.store.tagsOfResource(row.resource_id) });
  }

  listResourceTags({ context, resourceRef } = {}) {
    const load = this.#load({ context, resourceRef, action: authz.ACTION.VIEW, opaque: true });
    if (!load.ok) return load;
    return ok({ items: this.store.tagsOfResource(load.row.resource_id) });
  }

  renameTag({ context, tagId, name } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const tag = this.store.tagById(tagId);
    if (!tag || tag.organization_id !== actor.user.team_id) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    if (tag.source !== TAG_SOURCE.USER && actor.user.role !== "ADMIN") return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const norm = domain.normalizeTagName(name);
    if (!norm.ok) return norm;
    const clash = this.store.tagByNormalized(actor.user.team_id, norm.normalizedName);
    if (clash && clash.id !== tag.id) return fail(REASON.INVALID_INPUT, "tag-duplicate");
    this.store.transactSync(() => {
      this.store.updateTagName(tag.id, norm.name, norm.normalizedName);
      for (const r of this.store.resourcesOfTag(tag.id)) this.#refreshRegistryTags(r.resource_id);
    });
    return ok({ tag: this.store.tagById(tag.id) });
  }

  deleteTag({ context, tagId } = {}) {
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const tag = this.store.tagById(tagId);
    if (!tag || tag.organization_id !== actor.user.team_id) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    if (tag.source !== TAG_SOURCE.USER && actor.user.role !== "ADMIN") return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const affected = this.store.resourcesOfTag(tag.id).map((r) => r.resource_id);
    this.store.transactSync(() => {
      this.store.setTagStatus(tag.id, "deleted");
      for (const rid of affected) this.#refreshRegistryTags(rid);
    });
    return ok({ deleted: true, tagId: tag.id, affectedResources: affected.length });
  }

  // --- Favorites / Recent ---------------------------------------------------

  setFavorite({ context, resourceRef, favorite = true } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.VIEW, opaque: true });
    if (!load.ok) return load;
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const res = this.store.transactSync(() => this.store.setFavorite({ userId: actor.user.id, resourceId: load.row.resource_id, organizationId: load.row.organization_id, favorite: !!favorite }));
    return ok({ favorite: res.favorite, resourceRef: authz.toResourceRef(load.row.resource_id) });
  }

  listFavorites({ context } = {}) {
    this.#ensureBuiltinPolicy(context);
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const items = [];
    for (const fav of this.store.favoritesOfUser(actor.user.id)) {
      const row = this.store.resourceRowById(fav.resource_id);
      if (!row || row.trash_state === TRASH_STATE.TRASHED) continue;
      const caps = this.authService.getCapabilities({ context, resource: row.resource_id });
      if (!caps.ok) continue;
      items.push(this.#descriptor(row, context, { favorite: true }));
    }
    return ok({ items, count: items.length });
  }

  touchRecent({ context, resourceRef } = {}) {
    this.#ensureBuiltinPolicy(context);
    const load = this.#load({ context, resourceRef, action: authz.ACTION.VIEW, opaque: true });
    if (!load.ok) return load;
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    this.store.transactSync(() => this.store.touchRecent({ userId: actor.user.id, resourceId: load.row.resource_id, organizationId: load.row.organization_id }));
    return ok({ touched: true });
  }

  listRecent({ context, limit = 60 } = {}) {
    this.#ensureBuiltinPolicy(context);
    const actor = this.#actor(context);
    if (!actor.ok) return actor;
    const items = [];
    for (const rec of this.store.recentOfUser(actor.user.id, limit)) {
      const row = this.store.resourceRowById(rec.resource_id);
      if (!row || row.trash_state === TRASH_STATE.TRASHED) continue;
      const caps = this.authService.getCapabilities({ context, resource: row.resource_id });
      if (!caps.ok) continue;
      items.push(this.#descriptor(row, context, { recentAt: rec.last_opened_at }));
    }
    return ok({ items, count: items.length });
  }

  // --- Authorized query (structured filter / sort / pagination) -------------

  queryResources({ context, category = CATEGORY.ALL, filter = {}, sort = "updated", direction = "desc", limit = domain.DEFAULT_PAGE_LIMIT, offset = 0 } = {}) {
    this.#ensureBuiltinPolicy(context);
    const actor = this.#actor(context);
    if (!actor.ok) return { ok: false, error: REASON.NOT_FOUND_OR_FORBIDDEN, items: [], total: 0 };
    const page = domain.normalizePage({ limit, offset });
    if (!page.ok) return page;
    const sortSpec = domain.normalizeSort({ sort, direction });
    if (!sortSpec.ok) return sortSpec;
    const cat = String(category || CATEGORY.ALL);
    const includeTrashed = cat === CATEGORY.TRASH;
    const types = domain.categoryTypes(cat);
    const favorites = new Map(this.store.favoritesOfUser(actor.user.id).map((f) => [f.resource_id, f.created_at]));
    const recent = new Map(this.store.recentOfUser(actor.user.id, 1000).map((r) => [r.resource_id, r.last_opened_at]));
    let tagFilterIds = null;
    if (filter.tagId) {
      tagFilterIds = new Set(this.store.resourcesOfTag(filter.tagId).map((r) => r.resource_id));
    }
    let rows = this.store.resourceRowsByOrg(actor.user.team_id);
    rows = rows.filter((row) => {
      const trashed = row.trash_state === TRASH_STATE.TRASHED;
      if (includeTrashed ? !trashed : trashed) return false;
      if (types && !types.includes(row.resource_type)) return false;
      if (cat === CATEGORY.FAVORITES && !favorites.has(row.resource_id)) return false;
      if (cat === CATEGORY.RECENT && !recent.has(row.resource_id)) return false;
      if (filter.resourceType && row.resource_type !== filter.resourceType) return false;
      if (filter.memorySubtype && row.memory_subtype !== filter.memorySubtype) return false;
      if (filter.storageMode && row.storage_mode !== filter.storageMode) return false;
      if (filter.departmentId && row.department_id !== filter.departmentId) return false;
      if (filter.collectionId === "unfiled" ? !!row.collection_id : filter.collectionId && row.collection_id !== filter.collectionId) return false;
      if (filter.tagId && (!tagFilterIds || !tagFilterIds.has(row.resource_id))) return false;
      if (filter.favorite === true && !favorites.has(row.resource_id)) return false;
      if (filter.name && !String(row.name || "").toLowerCase().includes(String(filter.name).toLowerCase())) return false;
      if (filter.availability && this.#availability(row, context).availability !== filter.availability) return false;
      const caps = this.authService.getCapabilities({ context, resource: row.resource_id, allowInactiveResource: includeTrashed });
      return !!caps.ok;
    });
    const dir = sortSpec.direction === "asc" ? 1 : -1;
    if (cat === CATEGORY.RECENT) {
      rows.sort((a, b) => (recent.get(b.resource_id) || 0) - (recent.get(a.resource_id) || 0));
    } else {
      rows.sort((a, b) => {
        if (sortSpec.sort === "name") return dir * String(a.name || "").localeCompare(String(b.name || ""));
        if (sortSpec.sort === "size") return dir * ((Number(a.size) || 0) - (Number(b.size) || 0));
        if (sortSpec.sort === "created") return dir * ((Number(a.created_at) || 0) - (Number(b.created_at) || 0));
        return dir * ((Number(a.updated_at) || 0) - (Number(b.updated_at) || 0));
      });
    }
    const total = rows.length;
    const pageRows = rows.slice(page.offset, page.offset + page.limit);
    const items = pageRows.map((row) => this.#descriptor(row, context, { favorite: favorites.has(row.resource_id), recentAt: recent.get(row.resource_id) || null }));
    return { ok: true, items, total, offset: page.offset, limit: page.limit, hasMore: page.offset + page.limit < total, category: cat, sort: sortSpec.sort, direction: sortSpec.direction };
  }

  // --- Inspector / Versions -------------------------------------------------

  getInspector({ context, resourceRef } = {}) {
    this.#ensureBuiltinPolicy(context);
    const id = this.#parseRef(resourceRef);
    const row = id ? this.store.resourceRowById(id) : null;
    if (!row) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const trashed = row.trash_state === TRASH_STATE.TRASHED;
    const caps = this.authService.getCapabilities({ context, resource: row.resource_id, allowInactiveResource: trashed });
    if (!caps.ok) return fail(REASON.NOT_FOUND_OR_FORBIDDEN);
    const actor = this.#actor(context);
    const breakdown = this.authService.getCapabilityBreakdown({ context, resource: row.resource_id });
    const favorite = actor.ok ? this.store.isFavorite(actor.user.id, row.resource_id) : false;
    const recentRow = actor.ok ? this.store.recentOfUser(actor.user.id, 1).find((r) => r.resource_id === row.resource_id) : null;
    const collection = row.collection_id && this.authStore ? this.authStore.collectionById(row.collection_id) : null;
    const versions = this.store.versionsOf(row.resource_id).map((v) => ({ version: v.version, size: v.size, checksum: v.checksum, storageMode: v.storage_mode, createdBy: v.created_by, createdAt: v.created_at }));
    return ok({
      resource: this.#descriptor(row, context, { favorite, recentAt: recentRow ? recentRow.last_opened_at : null }),
      location: this.#location(row, context),
      capabilities: {
        effective: caps.capabilities,
        effectiveActions: caps.allowedActions,
        userActions: breakdown.ok ? breakdown.userActions : [],
        appActions: breakdown.ok ? breakdown.appActions : [],
        userDenied: breakdown.ok ? breakdown.userDenied : null,
        appDenied: breakdown.ok ? breakdown.appDenied : null,
      },
      tags: this.store.tagsOfResource(row.resource_id).map((t) => ({ tagId: t.id, name: t.name, source: t.assignment_source })),
      collection: collection ? this.#collectionView(collection, actor.ok ? actor.user.id : null) : null,
      versions,
      relations: { outgoing: this.store.relationsFrom(row.resource_id).length, incoming: this.store.relationsTo(row.resource_id).length },
      provenance: {
        source: row.source,
        generatedSourceTaskId: row.generated_source_task_id ?? null,
        generatedSourceCallId: row.generated_source_call_id ?? null,
        generatedSourceModel: row.generated_source_model ?? null,
        memorySubtype: row.memory_subtype ?? null,
        language: row.language ?? null,
      },
      trashed,
      favorite,
    });
  }

  listVersions({ context, resourceRef } = {}) {
    const load = this.#load({ context, resourceRef, action: authz.ACTION.VIEW, opaque: true });
    if (!load.ok) return load;
    const items = this.store.versionsOf(load.row.resource_id).map((v) => ({ version: v.version, size: v.size, storageMode: v.storage_mode, source: v.source, createdBy: v.created_by, createdAt: v.created_at }));
    return ok({ items, count: items.length, currentVersion: Number(load.row.version || 1) });
  }
}

module.exports = { ResourceService, BUILTIN_APP_BASELINE };
