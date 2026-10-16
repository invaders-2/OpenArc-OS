/**
 * PhotoCraft 域 · 服务层（业务操作 + 唯一命令分发 + 会话解析）。
 *
 * 逐段移植自只读源（行号为源行号）：
 *   · server/photocraftProjects.ts:51-59    应用根 / 分组根 / 缓存根 / 默认分组 / 缓存目录
 *   · :61-75        summary 投影（ownerName / previewUrl / source* 字段）
 *   · :77-102       分组列表 / 新建分组 / 删除分组（项目回退默认分组）
 *   · :104-110      可见项目列表（owner / public / restricted+成员 三路 SQL）
 *   · :112-127      saveSource（覆盖既有源文件或新建）
 *   · :129-140      新建项目（UUID + 私有 + 可选源文件）
 *   · :142-155      取详情 / 读源文件
 *   · :157-172      仅 owner：改名 / 换分组 / visibility / 成员整表替换
 *   · :174-195      导出产物 / 剪贴板临时（同名覆盖）
 *   · :245-265      回收站软删 → 恢复 → 彻底删除（文件走 dxos-fs 自己的 trashed）
 *   · :267-312      fs 根级联（trash / restore / delete）
 *   · :314-319      canViewPhotoCraftFile 及其 owner 版 canEditPhotoCraftFile
 *
 * 权限口径（源 :38-50）：
 *   · requireOwnerRow —— 项目不存在 → NOT_FOUND；存在但非 owner → FORBIDDEN（源把两者折成一条
 *     中文消息，这里按 IPC 契约拆成两个稳定错误码，便于渲染层区分"找不到"与"没权限"）；
 *   · requireViewRow  —— 不存在 / 已删除 → NOT_FOUND；存在但无可见性 → FORBIDDEN。
 *
 * 边界：save-bundle 是 file-transfer 域消费者（源 index.ts:5750 的 registerFileTransferRoutes），
 * 本域只回结构化 PHOTOCRAFT_UNSUPPORTED，绝不重写传输层。
 *
 * 落盘根：dxos-fs 虚拟树 <userData>/dxos/fs（dxos-foundation-paths.cjs:45-47）。项目文件与回收站
 * 全部走这一套，不另建垃圾箱、不写真实磁盘路径。
 */
"use strict";

const nodeFs = require("node:fs");
const { randomUUID, createHash } = require("node:crypto");
const domain = require("./photocraft-domain.cjs");
const { PhotocraftStore } = require("./photocraft-store.cjs");
const { resolveDxosFsDir } = require("./dxos-foundation-paths.cjs");
const { createDxosFsAdapter } = require("./dxos-fs-adapter.cjs");

const HOST_APP_ID = "photocraft";

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** <userData>/dxos/fs 的 dxos-fs 适配器（与 agent-service.cjs:322-333 同一装配口径）。 */
function createPhotocraftFsForUserData(userDataDir, options = {}) {
  if (typeof userDataDir !== "string" || !userDataDir.trim()) throw new Error("createPhotocraftFsForUserData 需要 userDataDir");
  const dir = resolveDxosFsDir(userDataDir);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.accessSync(dir, nodeFs.constants.W_OK);
  return createDxosFsAdapter(Object.assign(
    { dataDir: dir },
    typeof options.clock === "function" ? { clock: options.clock } : {},
    typeof options.idFactory === "function" ? { idFactory: options.idFactory } : {},
  ));
}

class PhotocraftService {
  constructor({ identity, fs, clock, idFactory, logger } = {}) {
    this.store = new PhotocraftStore({ identity, fs, clock, idFactory });
    this.fs = this.store.fs;
    this.logger = logger || null;
  }

  now() {
    return this.store.now();
  }

  // ── 权限（源 :38-50、:314-319）──────────────────────────────────────────
  canView(row, viewerId) {
    return domain.canViewProject(row, viewerId, this.store.membersOf(row.id));
  }

  requireOwnerRow(id, viewerId) {
    const row = this.store.getProject(id);
    if (!row) throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_NOT_FOUND, "PhotoCraft 项目不存在", { projectId: id });
    if (row.owner_id !== viewerId) throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_FORBIDDEN, "PhotoCraft 项目不存在或没有管理权限", { projectId: id });
    return row;
  }

  requireViewRow(id, viewerId) {
    const row = this.store.getProject(id);
    if (!row || row.deleted_at !== null) throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_NOT_FOUND, "PhotoCraft 项目不存在或已删除", { projectId: id });
    if (!this.canView(row, viewerId)) throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_FORBIDDEN, "没有访问该 PhotoCraft 项目的权限", { projectId: id });
    return row;
  }

  requireGroup(groupId, ownerId) {
    const node = this.fs.getNode(groupId);
    if (!node || node.type !== "folder" || node.ownerId !== ownerId || this.fs.isInTrash(node.id)) {
      throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_NOT_FOUND, "PhotoCraft 分组不存在", { groupId: groupId });
    }
    return node;
  }

  summary(row, viewerId) {
    return domain.buildProjectSummary(row, {
      ownerName: this.store.userName(row.owner_id),
      members: this.store.membersOf(row.id),
      source: row.source_node_id ? this.fs.getNode(row.source_node_id) : null,
      preview: row.preview_node_id ? this.fs.getNode(row.preview_node_id) : null,
      viewerId: viewerId,
    });
  }

  // ── 分组（源 :77-102）───────────────────────────────────────────────────
  listGroups(viewerId) {
    this.store.defaultGroup(viewerId);
    const own = this.fs.listChildren(this.store.groupsRoot(viewerId)).nodes
      .filter((node) => node.type === "folder" && !this.fs.isInTrash(node.id))
      .map((node) => ({ id: node.id, name: node.name, mine: true, isDefault: node.name === domain.PHOTOCRAFT_DEFAULT_GROUP }));
    const result = new Map(own.map((group) => [group.id, group]));
    for (const project of this.listProjects(viewerId, false)) {
      if (result.has(project.groupId)) continue;
      result.set(project.groupId, {
        id: project.groupId,
        name: project.mine ? "未命名分组" : project.ownerName + "的共享项目",
        mine: false,
        isDefault: false,
      });
    }
    return [...result.values()];
  }

  createGroup(viewerId, name) {
    const title = domain.cleanTitle(name, domain.PHOTOCRAFT_DEFAULT_GROUP_NAME);
    const rootId = this.store.groupsRoot(viewerId);
    const existing = this.fs.listChildren(rootId).nodes.find((node) => node.type === "folder" && node.name === title && !this.fs.isInTrash(node.id));
    const group = existing || this.fs.createNode({ name: title, type: "folder", parentId: rootId, ownerId: viewerId });
    return { group: group };
  }

  deleteGroup(viewerId, groupId) {
    const group = this.fs.getNode(groupId);
    if (!group || group.type !== "folder" || group.ownerId !== viewerId || this.fs.isInTrash(group.id)) {
      throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_NOT_FOUND, "PhotoCraft 分组不存在", { groupId: groupId });
    }
    if (group.name === domain.PHOTOCRAFT_DEFAULT_GROUP) {
      throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_CONFLICT, "默认分组不能删除", { groupId: group.id });
    }
    const fallbackGroupId = this.store.defaultGroup(viewerId);
    const ts = this.now();
    const moved = this.store.transact(() => this.store.moveProjectsToGroup({ toGroupId: fallbackGroupId, ownerId: viewerId, fromGroupId: group.id, updatedAt: ts }));
    this.fs.removeNode(group.id);
    return { deleted: group.id, moved: moved, fallbackGroupId: fallbackGroupId };
  }

  // ── 项目（源 :104-172）──────────────────────────────────────────────────
  listProjects(viewerId, trashed) {
    return this.store.listProjects(viewerId, !!trashed).map((row) => this.summary(row, viewerId));
  }

  listWorkspace(viewerId) {
    return { projects: this.listProjects(viewerId, false), groups: this.listGroups(viewerId) };
  }

  createProject(viewerId, input) {
    const groupId = input.groupId == null || input.groupId === ""
      ? this.store.defaultGroup(viewerId)
      : domain.requirePhotocraftId(String(input.groupId), "分组 ID");
    this.requireGroup(groupId, viewerId);
    // 源 index.ts:5778 在路由层先 developerBase64 再建项目；这里同样先解码，
    // 非法 base64 不得留下半建的项目行。
    const content = domain.decodeContentBytes(input, domain.PHOTOCRAFT_MAX_INLINE_BYTES, "源文件");
    const id = String(this.store.idFactory());
    const ts = this.now();
    this.store.insertProject({
      id: id,
      groupId: groupId,
      ownerId: viewerId,
      title: domain.cleanTitle(input.title || input.name),
      visibility: domain.PHOTOCRAFT_DEFAULT_VISIBILITY,
      createdAt: ts,
      updatedAt: ts,
    });
    let source = null;
    if (content) source = this.saveSource(this.store.getProject(id), { name: input.name, mime: input.mime, content: content });
    return { project: this.summary(this.store.getProject(id), viewerId), source: source };
  }

  getProject(id, viewerId) {
    const row = this.requireViewRow(id, viewerId);
    const summary = this.summary(row, viewerId);
    const source = row.source_node_id ? this.fs.getNode(row.source_node_id) : null;
    summary.sourceUrl = source ? "/api/fs/raw/" + source.id + "?photocraft=" + row.id : "";
    return { project: summary };
  }

  updateProject(id, viewerId, input) {
    const row = this.requireOwnerRow(id, viewerId);
    const nextGroupId = input.groupId === undefined ? row.group_id : domain.requirePhotocraftId(String(input.groupId), "分组 ID");
    this.requireGroup(nextGroupId, viewerId);
    const nextVisibility = input.visibility === undefined ? row.visibility : domain.normalizeVisibility(input.visibility);
    // 源 :163：非 restricted（或没给 members 数组）时成员表被清空 —— 逐字对齐，不"顺手修正"。
    const nextMembers = nextVisibility === "restricted" ? domain.normalizeMemberIds(input.members, viewerId) : [];
    const ts = this.now();
    this.store.transact(() => {
      this.store.updateProjectMeta({ id: id, groupId: nextGroupId, title: domain.cleanTitle(input.title, row.title), visibility: nextVisibility, updatedAt: ts });
      this.store.replaceMembers(id, nextMembers);
    });
    return { project: this.summary(this.store.getProject(id), viewerId) };
  }

  // ── 源文件 / 导出 / 剪贴板（源 :112-127、:174-201）──────────────────────
  saveSource(row, input) {
    const folderId = this.store.cacheFolder(row.owner_id, row.id);
    const name = domain.cleanTitle(input.name, domain.PHOTOCRAFT_DEFAULT_SOURCE_NAME);
    const mime = String(input.mime || domain.PHOTOCRAFT_DEFAULT_MIME).slice(0, domain.PHOTOCRAFT_MAX_MIME);
    let node = row.source_node_id ? this.fs.getNode(row.source_node_id) : null;
    if (node && node.type === "file") {
      node = this.fs.setBinaryContent(node.id, input.content, mime);
      if (node.name !== name) node = this.fs.renameNode(node.id, name);
    } else {
      node = this.fs.createNode({ name: name, type: "file", parentId: folderId, ownerId: row.owner_id, mime: mime, size: input.content.byteLength });
      this.fs.saveBlob(node.id, input.content);
    }
    this.store.updateSource({ id: row.id, sourceNodeId: node.id, title: domain.cleanTitle(name.replace(/\.[^.]+$/, ""), row.title), updatedAt: this.now() });
    return node;
  }

  readSource(id, viewerId) {
    const row = this.requireViewRow(id, viewerId);
    const source = row.source_node_id ? this.fs.getNode(row.source_node_id) : null;
    if (!source || source.type !== "file") throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_NOT_FOUND, "项目源文件不存在", { projectId: id });
    const data = source.content !== undefined ? Buffer.from(source.content, "utf8") : this.fs.readBlob(source.id);
    if (!data) throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_NOT_FOUND, "项目源文件内容不存在", { projectId: id });
    domain.assertPhotocraftSize(data, domain.PHOTOCRAFT_MAX_INLINE_BYTES, "源文件");
    return {
      name: source.name,
      mime: source.mime || domain.PHOTOCRAFT_DEFAULT_MIME,
      size: data.byteLength,
      sha256: source.blobSha256 || sha256Hex(data),
      base64: data.toString("base64"),
    };
  }

  writeSource(id, viewerId, input) {
    const row = this.requireOwnerRow(id, viewerId);
    const content = domain.decodeContentBytes(input, domain.PHOTOCRAFT_MAX_INLINE_BYTES, "源文件");
    if (!content) throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_INVALID_INPUT, "源文件内容必填");
    const node = this.saveSource(row, { name: input.name, mime: input.mime, content: content });
    return { node: node, project: this.summary(this.store.getProject(id), viewerId) };
  }

  saveExport(id, viewerId, input) {
    const row = this.requireOwnerRow(id, viewerId);
    const content = domain.decodeContentBytes(input, domain.PHOTOCRAFT_MAX_INLINE_BYTES, "导出产物");
    if (!content) throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_INVALID_INPUT, "导出产物内容必填");
    const folderId = this.fs.ensureFolder(domain.PHOTOCRAFT_EXPORT_FOLDER, this.store.cacheFolder(row.owner_id, row.id), row.owner_id);
    const name = domain.cleanTitle(input.name, domain.PHOTOCRAFT_DEFAULT_EXPORT_NAME);
    // 源 :178 未截断 mime；任务要求"所有输入做长度校验"，这里补 160 上限（与 saveSource :115 同口径）。
    const mime = String(input.mime || domain.PHOTOCRAFT_DEFAULT_MIME).slice(0, domain.PHOTOCRAFT_MAX_MIME);
    const node = this.fs.createNode({ name: name, type: "file", parentId: folderId, ownerId: row.owner_id, mime: mime, size: content.byteLength });
    this.fs.saveBlob(node.id, content);
    const previewNodeId = mime.indexOf("image/") === 0 ? node.id : row.preview_node_id;
    this.store.updatePreview({ id: id, previewNodeId: previewNodeId, updatedAt: this.now() });
    return { node: node, project: this.summary(this.store.getProject(id), viewerId) };
  }

  saveClipboardTemp(id, viewerId, input) {
    const row = this.requireOwnerRow(id, viewerId);
    const content = domain.decodeContentBytes(input, domain.PHOTOCRAFT_MAX_INLINE_BYTES, "剪贴板内容");
    if (!content) throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_INVALID_INPUT, "剪贴板内容必填");
    const folderId = this.fs.ensureFolder(domain.PHOTOCRAFT_TEMP_FOLDER, this.store.cacheFolder(row.owner_id, row.id), row.owner_id);
    const name = domain.cleanTitle(input.name, domain.PHOTOCRAFT_DEFAULT_CLIPBOARD_NAME);
    const mime = String(input.mime || domain.PHOTOCRAFT_DEFAULT_CLIPBOARD_MIME).slice(0, domain.PHOTOCRAFT_MAX_MIME);
    const existing = this.fs.listChildren(folderId).nodes.find((node) => node.type === "file" && node.name === name && !this.fs.isInTrash(node.id));
    if (existing) return { node: this.fs.setBinaryContent(existing.id, content, mime) };
    const node = this.fs.createNode({ name: name, type: "file", parentId: folderId, ownerId: row.owner_id, mime: mime, size: content.byteLength });
    this.fs.saveBlob(node.id, content);
    return { node: node };
  }

  // ── 回收站（源 :245-265）────────────────────────────────────────────────
  trashProject(id, viewerId) {
    const row = this.requireOwnerRow(id, viewerId);
    if (row.deleted_at !== null) return {};
    const folder = this.store.existingCacheFolder(row.owner_id, row.id);
    if (folder && !this.fs.isInTrash(folder.id)) this.fs.removeNode(folder.id);
    this.store.trashProject({ id: id, at: this.now() });
    return {};
  }

  restoreProject(id, viewerId) {
    const row = this.requireOwnerRow(id, viewerId);
    if (row.deleted_at === null) return {};
    const folder = this.store.existingCacheFolder(row.owner_id, row.id);
    if (folder && this.fs.isInTrash(folder.id)) this.fs.restoreNode(folder.id);
    this.store.restoreProject({ id: id, at: this.now() });
    return {};
  }

  purgeProject(id, viewerId) {
    const row = this.requireOwnerRow(id, viewerId);
    if (row.deleted_at === null) throw domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_CONFLICT, "项目尚未进入回收站", { projectId: id });
    const folder = this.store.existingCacheFolder(row.owner_id, row.id);
    if (folder) this.fs.purgeNode(folder.id);
    this.store.purgeProject(id);
    return {};
  }

  // ── 文件级可见性（源 :314-319）──────────────────────────────────────────
  canViewFile(nodeId, viewerId, projectId) {
    const rows = projectId ? [this.store.getProject(projectId)].filter(Boolean) : this.store.liveProjects();
    return rows.some((row) => row.deleted_at === null && this.canView(row, viewerId) && (row.source_node_id === nodeId || row.preview_node_id === nodeId));
  }

  /** 源没有这个函数：编辑严格等价 owner（对照 :41-45 requireOwner）。 */
  canEditFile(nodeId, viewerId, projectId) {
    const rows = projectId ? [this.store.getProject(projectId)].filter(Boolean) : this.store.liveProjects();
    return rows.some((row) => row.deleted_at === null && row.owner_id === viewerId && (row.source_node_id === nodeId || row.preview_node_id === nodeId));
  }

  // ── fs 根级联（源 :267-312）─────────────────────────────────────────────
  projectIdsWithinFsRoot(rootId) {
    const nodes = this.store.readNodesSnapshot();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const rows = this.store.allProjectIds();
    const isWithin = (nodeId) => {
      let current = byId.get(nodeId);
      const seen = new Set();
      while (current && !seen.has(current.id)) {
        if (current.id === rootId) return true;
        seen.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return false;
    };
    return rows
      .filter((item) => nodes.some((node) => node.type === "folder" && node.name === item.id && node.ownerId === item.owner_id && isWithin(node.id)))
      .map((item) => item.id);
  }

  trashForFsRoot(rootId) {
    const ids = this.projectIdsWithinFsRoot(rootId);
    if (!ids.length) return 0;
    const ts = this.now();
    this.store.transact(() => { for (const id of ids) this.store.markTrashedForFsRoot(id, ts); });
    return ids.length;
  }

  restoreForFsRoot(rootId) {
    const ids = this.projectIdsWithinFsRoot(rootId);
    if (!ids.length) return 0;
    const ts = this.now();
    this.store.transact(() => { for (const id of ids) this.store.clearTrashedForFsRoot(id, ts); });
    return ids.length;
  }

  deleteForFsRoot(rootId) {
    const ids = this.projectIdsWithinFsRoot(rootId);
    if (!ids.length) return 0;
    this.store.transact(() => { for (const id of ids) this.store.deleteForFsRoot(id); });
    return ids.length;
  }

  /** save-bundle 是 file-transfer 域消费者；本域只做结构化不支持。 */
  saveBundle() {
    throw domain.createPhotocraftError(
      domain.PHOTOCRAFT_ERR_UNSUPPORTED,
      "save-bundle 由 file-transfer 域承接，PhotoCraft 域不再实现传输层",
      { delegate: "fileTransfer", commands: ["fileTransfer/begin", "fileTransfer/chunk", "fileTransfer/complete"] },
    );
  }
}

/**
 * 装配 PhotoCraft 域。
 * @param userDataDir   Electron app.getPath("userData")；虚拟树固定 <userData>/dxos/fs
 * @param identity       IdentityStore（提供 photocraft_* 表连接、事务与 ownerName）
 * @param authorization  授权服务：resolveActor({context}) → {ok,user}（与 file-transfer-service.cjs:262-271 同形）
 * @param fsAdapter       可选注入的 dxos-fs 适配器（测试/复用宿主实例）；缺省自建
 * @param clock/idFactory 可选注入（测试确定性）
 * @returns { execute, service, store, root, dependencies, canViewPhotoCraftFile, canEditPhotoCraftFile, cascade, dispose }
 */
function createPhotocraftBundle({ userDataDir, identity, authorization = null, fsAdapter = null, clock = null, idFactory = null, logger = null } = {}) {
  if (!identity || !identity.connection) throw new Error("createPhotocraftBundle 需要 IdentityStore");
  const now = typeof clock === "function" ? clock : typeof identity.clock === "function" ? identity.clock : () => Date.now();
  const makeId = typeof idFactory === "function" ? idFactory : randomUUID;
  const adapter = fsAdapter || createPhotocraftFsForUserData(userDataDir, { clock: now, idFactory: makeId });
  const service = new PhotocraftService({ identity: identity, fs: adapter.store, clock: now, idFactory: makeId, logger: logger });

  const asStr = (value, max) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));

  /** sessionRef → actor；不可解析即 { ok:false }，绝不伪造身份。 */
  function resolveActor(context) {
    if (authorization && typeof authorization.resolveActor === "function") {
      try {
        const result = authorization.resolveActor({ context: context });
        if (!result || result.ok !== true || !result.user || result.user.id == null) {
          return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
        }
        return { ok: true, user: result.user };
      } catch (error) {
        return { ok: false, message: String((error && error.message) || error) };
      }
    }
    if (typeof identity.validateSession === "function") {
      try {
        const view = identity.validateSession(context.sessionRef, { sensitive: false });
        if (view && view.ok === true && view.user && view.user.id != null) return { ok: true, user: view.user };
        return { ok: false, message: (view && (view.error || view.reason)) || "会话无效" };
      } catch (error) {
        return { ok: false, message: String((error && error.message) || error) };
      }
    }
    return { ok: false, message: "授权服务未装配" };
  }

  async function dispatch(command, payload, userId) {
    switch (command) {
      case "photocraft/projects/list":
        return service.listWorkspace(userId);
      case "photocraft/projects/create":
        return service.createProject(userId, payload);
      case "photocraft/projects/get":
        return service.getProject(domain.requirePhotocraftId(payload.id, "项目 ID"), userId);
      case "photocraft/projects/update":
        return service.updateProject(domain.requirePhotocraftId(payload.id, "项目 ID"), userId, payload);
      case "photocraft/projects/trash":
        return service.trashProject(domain.requirePhotocraftId(payload.id, "项目 ID"), userId);
      case "photocraft/projects/restore":
        return service.restoreProject(domain.requirePhotocraftId(payload.id, "项目 ID"), userId);
      case "photocraft/projects/purge":
        return service.purgeProject(domain.requirePhotocraftId(payload.id, "项目 ID"), userId);
      case "photocraft/projects/readSource":
        return service.readSource(domain.requirePhotocraftId(payload.id, "项目 ID"), userId);
      case "photocraft/projects/writeSource":
        return service.writeSource(domain.requirePhotocraftId(payload.id, "项目 ID"), userId, payload);
      case "photocraft/projects/export":
        return service.saveExport(domain.requirePhotocraftId(payload.id, "项目 ID"), userId, payload);
      case "photocraft/projects/saveClipboardTemp":
        return service.saveClipboardTemp(domain.requirePhotocraftId(payload.id, "项目 ID"), userId, payload);
      case "photocraft/trash/list":
        return { projects: service.listProjects(userId, true) };
      case "photocraft/groups/create":
        return service.createGroup(userId, payload.name);
      case "photocraft/groups/remove":
        return service.deleteGroup(userId, domain.requirePhotocraftId(payload.id, "分组 ID"));
      case "photocraft/projects/saveBundle":
      case "photocraft/projects/save-bundle":
        return service.saveBundle();
      default:
        throw domain.photocraftCommandNotAllowed(command);
    }
  }

  /** 唯一命令入口：白名单 → actor 解析 → dispatch → 脱敏；失败统一 normalizePhotocraftError。 */
  async function execute(command, payload, ctx = {}) {
    if (!domain.isPhotocraftCommand(command)) return domain.normalizePhotocraftError(domain.photocraftCommandNotAllowed(command));
    const context = {
      sessionRef: asStr(ctx && ctx.sessionRef, 160),
      appId: asStr(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: "photocraft",
      requestId: asStr(ctx && ctx.requestId, 100),
    };
    const actor = resolveActor(context);
    if (!actor.ok) {
      return domain.normalizePhotocraftError(domain.createPhotocraftError(domain.PHOTOCRAFT_ERR_UNAUTHENTICATED, actor.message || "当前会话未认证，photocraft 命令被拒绝"));
    }
    const userId = String(actor.user.id);
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    try {
      const value = await dispatch(command, body, userId);
      return { ok: true, value: domain.redactPhotocraftValue(value) };
    } catch (error) {
      return domain.normalizePhotocraftError(error);
    }
  }

  return {
    execute: execute,
    service: service,
    store: service.store,
    root: adapter.dataDir,
    dependencies: Object.freeze({ userDataDir: !!userDataDir, identity: true, authorization: !!authorization, fs: !!adapter.store }),
    canViewPhotoCraftFile: (nodeId, viewerId, projectId) => service.canViewFile(nodeId, viewerId, projectId),
    canEditPhotoCraftFile: (nodeId, viewerId, projectId) => service.canEditFile(nodeId, viewerId, projectId),
    cascade: {
      trashForFsRoot: (rootId) => service.trashForFsRoot(rootId),
      restoreForFsRoot: (rootId) => service.restoreForFsRoot(rootId),
      deleteForFsRoot: (rootId) => service.deleteForFsRoot(rootId),
    },
    dispose: () => undefined,
  };
}

module.exports = {
  PhotocraftService,
  createPhotocraftBundle,
  createPhotocraftFsForUserData,
  sha256Hex,
  HOST_APP_ID,
};
