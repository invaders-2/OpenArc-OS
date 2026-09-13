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

const { ok, fail, REASON, STORAGE_MODE, AVAILABILITY, IMPORT_PHASE, TRASH_STATE, CONTENT_STATUS, SOURCE, INDEX_STATUS, LOCAL_DEVICE_ID } = domain;

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

  #descriptor(row, context) {
    const avail = this.#availability(row, context);
    const descriptor = domain.descriptorProjection(row, { availability: avail.availability });
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

  async importText({ context, text, name = "untitled.txt", description = "", resourceType = "text", scope = "PERSONAL", departmentId = null, collectionId = null, tags = [], source = SOURCE.USER, generated = null, onProgress = null } = {}) {
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
    return ok({ resource: this.#descriptor(row, context), location: this.#location(row, context) });
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
}

module.exports = { ResourceService, BUILTIN_APP_BASELINE };
