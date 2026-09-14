/**
 * D3-04A · Resource 装配 + IPC（与 identity / authorization / device 同一条接线）。
 *
 * 渲染进程桥只暴露**受控 Resource Commands**：
 *   - 没有 readFile(path) / writeFile(path) / deleteFile(path) 这类通用 fs 能力（§64）；
 *   - 手动导入与链接通过主进程 dialog 选择文件，路径**从不**回到渲染进程（§66 §14）；
 *   - 返回值恒为 safe descriptor（ResourceRef + metadata + availability）。
 */
"use strict";

const path = require("node:path");
const { ResourceStore } = require("./resource-store.cjs");
const { ManagedStore } = require("./resource-fs.cjs");
const { ResourceService } = require("./resource-service.cjs");
const { SearchStore } = require("./search-store.cjs");
const { SearchService } = require("./search-service.cjs");
const { PreviewService } = require("./preview-service.cjs");

/** 渲染进程可下发的资源命令白名单。新增能力必须在此显式登记。 */
const RENDERER_COMMANDS = Object.freeze([
  "resource/list",
  "resource/get",
  "resource/readText",
  "resource/delete",
  "resource/restore",
  "resource/permanentDelete",
  "resource/verifyIntegrity",
  "resource/relations",
  "resource/incomingReferences",
  "resource/job",
  "resource/pickImport",
  "resource/pickLink",
  "resource/query",
  "resource/inspector",
  "resource/create",
  "resource/updateMetadata",
  "resource/setCollection",
  "resource/listCollections",
  "resource/createCollection",
  "resource/updateCollection",
  "resource/deleteCollection",
  "resource/getCollection",
  "resource/listTags",
  "resource/createTag",
  "resource/assignTag",
  "resource/removeTag",
  "resource/renameTag",
  "resource/deleteTag",
  "resource/listResourceTags",
  "resource/setFavorite",
  "resource/listFavorites",
  "resource/touchRecent",
  "resource/listRecent",
  "resource/listVersions",
  "resource/replaceText",
  "resource/restoreVersion",
  "resource/search",
  "resource/indexStatus",
  "resource/reindex",
  "resource/preview",
  "resource/thumbnail",
  // D3-04D：集成 / Picker / Export
  "resource/export",
  "resource/revealSource",
  "resource/pickerQuery",
  "resource/pickerChoose",
  "resource/pickerValidate",
  "resource/listProjects",
  "resource/getProject",
  "resource/createProject",
  "resource/addProjectMember",
  "resource/removeProjectMember",
  "resource/addProjectResource",
  "resource/removeProjectResource",
  "resource/listProjectResources",
  "resource/listBoards",
  "resource/createBoard",
  "resource/getBoard",
  "resource/addCanvasResource",
  "resource/updateCanvasNode",
  "resource/moveCanvasNode",
  "resource/deleteCanvasNode",
]);

/**
 * @param opts.storeRoot  <userData>/library（由主进程按平台规范给出）
 */
function createResourceBundle({ identityStore, authorization, authStore = null, deviceService = null, storeRoot, logger = null, clock = null, nativeImage = null } = {}) {
  if (!identityStore) throw new Error("createResourceBundle 需要 identityStore");
  if (!storeRoot) throw new Error("createResourceBundle 需要 storeRoot");
  const managedStore = new ManagedStore({ root: path.resolve(storeRoot) });
  managedStore.ensureLayout();
  const resourceStore = new ResourceStore({ identity: identityStore, clock });
  const resourceService = new ResourceService({
    identity: identityStore,
    resourceStore,
    managedStore,
    authService: authorization,
    authStore,
    deviceService,
    logger,
    clock,
  });
  // D3-04C：本地索引与安全预览（派生数据，复用同一连接）。
  const searchStore = new SearchStore({ identity: identityStore, clock });
  const searchService = new SearchService({
    identity: identityStore,
    resourceStore,
    searchStore,
    managedStore,
    authService: authorization,
    authStore,
    deviceService,
    clock,
    logger,
  });
  const previewService = new PreviewService({
    identity: identityStore,
    resourceStore,
    searchStore,
    managedStore,
    authService: authorization,
    deviceService,
    clock,
    nativeImage,
    logger,
  });
  return { resourceService, resourceStore, managedStore, searchStore, searchService, previewService };
}

const pickerArgs = (command) => ({
  name: command.name ? String(command.name) : undefined,
  description: command.description ? String(command.description) : "",
  resourceType: command.resourceType ? String(command.resourceType) : null,
  scope: command.scope ? String(command.scope) : "PERSONAL",
  departmentId: command.departmentId ? String(command.departmentId) : null,
  collectionId: command.collectionId ? String(command.collectionId) : null,
  tags: Array.isArray(command.tags) ? command.tags.map(String) : [],
});

/**
 * 注册 resource:command。
 * 通道名必须是**字面量**（安全回归探针按字面量扫描 IPC 暴露面）。
 */
function registerResourceIpc({ ipcMain, service, search = null, preview = null, projects = null, canvas = null, picker = null, identity, isTrusted, dialog = null, BrowserWindow = null, shell = null }) {
  ipcMain.handle("resource:command", async (e, command) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!service) return { ok: false, error: "INTERNAL_ERROR", detail: "resource-not-ready" };
    if (!command || typeof command !== "object") return { ok: false, error: "INVALID_INPUT" };
    const type = String(command.type || "");
    if (!RENDERER_COMMANDS.includes(type)) return { ok: false, error: "INVALID_INPUT" };
    const context = { sessionRef: identity?.current ?? null, appId: command.appId ? String(command.appId) : "resource-library", source: "ui", requestId: command.requestId };
    const resourceRef = command.resourceRef || command.resourceId || null;
    const pickFile = async () => {
      if (!dialog || typeof dialog.showOpenDialog !== "function") return { canceled: true, filePaths: [] };
      const parent = BrowserWindow && e && e.sender ? BrowserWindow.fromWebContents(e.sender) : null;
      const result = parent ? await dialog.showOpenDialog(parent, { properties: ["openFile"] }) : await dialog.showOpenDialog({ properties: ["openFile"] });
      return result || { canceled: true, filePaths: [] };
    };
    try {
      switch (type) {
        case "resource/list":
          return service.list({ context, includeTrashed: !!command.includeTrashed, filter: command.filter || {} });
        case "resource/get":
          return service.get({ context, resourceRef });
        case "resource/readText":
          return service.readText({ context, resourceRef, maxBytes: Number(command.maxBytes) || undefined });
        case "resource/delete":
          return service.delete({ context, resourceRef });
        case "resource/restore":
          return service.restore({ context, resourceRef });
        case "resource/permanentDelete":
          return service.permanentDelete({ context, resourceRef });
        case "resource/verifyIntegrity":
          return service.verifyIntegrity({ context, resourceRef });
        case "resource/relations":
          return service.listRelations({ context, resourceRef });
        case "resource/incomingReferences":
          return service.incomingReferences({ context, resourceRef });
        case "resource/job":
          return service.getJob({ context, jobId: command.jobId });
        case "resource/pickImport": {
          const picked = await pickFile();
          if (!picked || picked.canceled || !picked.filePaths || !picked.filePaths.length) return { ok: false, error: "CANCELLED" };
          return service.importManaged({ context, sourcePath: picked.filePaths[0], ...pickerArgs(command) });
        }
        case "resource/pickLink": {
          const picked = await pickFile();
          if (!picked || picked.canceled || !picked.filePaths || !picked.filePaths.length) return { ok: false, error: "CANCELLED" };
          return service.createLinked({ context, sourcePath: picked.filePaths[0], ...pickerArgs(command) });
        }
        case "resource/query":
          return service.queryResources({
            context,
            category: command.category ? String(command.category) : "all",
            filter: command.filter || {},
            sort: command.sort ? String(command.sort) : "updated",
            direction: command.direction ? String(command.direction) : "desc",
            limit: Number(command.limit) || undefined,
            offset: Number(command.offset) || 0,
          });
        case "resource/inspector":
          return service.getInspector({ context, resourceRef });
        case "resource/create":
          return service.createResource({
            context,
            resourceType: command.resourceType ? String(command.resourceType) : "text",
            name: command.name ? String(command.name) : undefined,
            description: command.description ? String(command.description) : "",
            content: typeof command.content === "string" ? command.content : "",
            memorySubtype: command.memorySubtype ? String(command.memorySubtype) : null,
            language: command.language ? String(command.language) : null,
            attributes: command.attributes || null,
            tags: Array.isArray(command.tags) ? command.tags.map(String) : [],
            collectionId: command.collectionId ? String(command.collectionId) : null,
          });
        case "resource/updateMetadata":
          return service.updateMetadata({
            context,
            resourceRef,
            name: command.name,
            description: command.description,
            collectionId: command.collectionId,
            memorySubtype: command.memorySubtype,
            language: command.language,
            attributes: command.attributes,
          });
        case "resource/setCollection":
          return service.setCollection({ context, resourceRef, collectionId: command.collectionId == null ? null : String(command.collectionId) });
        case "resource/listCollections":
          return service.listCollections({ context });
        case "resource/createCollection":
          return service.createCollection({ context, name: command.name, description: command.description });
        case "resource/updateCollection":
          return service.updateCollection({ context, collectionId: command.collectionId, name: command.name, description: command.description });
        case "resource/deleteCollection":
          return service.deleteCollection({ context, collectionId: command.collectionId });
        case "resource/getCollection":
          return service.getCollection({ context, collectionId: command.collectionId });
        case "resource/listTags":
          return service.listTags({ context });
        case "resource/createTag":
          return service.createTag({ context, name: command.name });
        case "resource/assignTag":
          return service.assignTag({ context, resourceRef, name: command.name, tagId: command.tagId });
        case "resource/removeTag":
          return service.removeTag({ context, resourceRef, tagId: command.tagId });
        case "resource/renameTag":
          return service.renameTag({ context, tagId: command.tagId, name: command.name });
        case "resource/deleteTag":
          return service.deleteTag({ context, tagId: command.tagId });
        case "resource/listResourceTags":
          return service.listResourceTags({ context, resourceRef });
        case "resource/setFavorite":
          return service.setFavorite({ context, resourceRef, favorite: command.favorite !== false });
        case "resource/listFavorites":
          return service.listFavorites({ context });
        case "resource/touchRecent":
          return service.touchRecent({ context, resourceRef });
        case "resource/listRecent":
          return service.listRecent({ context, limit: Number(command.limit) || undefined });
        case "resource/listVersions":
          return service.listVersions({ context, resourceRef });
        case "resource/replaceText":
          return service.replaceText({
            context,
            resourceRef,
            text: typeof command.content === "string" ? command.content : "",
            expectedVersion: command.expectedVersion == null ? null : Number(command.expectedVersion),
            language: command.language,
            mimeType: command.mimeType ? String(command.mimeType) : "text/plain",
          });
        case "resource/restoreVersion":
          return service.restoreVersion({ context, resourceRef, version: Number(command.version), expectedVersion: command.expectedVersion == null ? null : Number(command.expectedVersion) });
        case "resource/search":
          if (!search) return { ok: false, error: "SEARCH_UNAVAILABLE", items: [], total: 0 };
          return search.search({
            context,
            query: typeof command.query === "string" ? command.query : "",
            filter: command.filter || {},
            agent: !!command.agentSessionId,
            limit: Number(command.limit) || undefined,
            offset: Number(command.offset) || 0,
          });
        case "resource/indexStatus":
          if (!search) return { ok: false, error: "SEARCH_UNAVAILABLE" };
          return search.indexStatus({ context, resourceRef });
        case "resource/reindex":
          if (!search) return { ok: false, error: "SEARCH_UNAVAILABLE" };
          if (command.mode === "all") return search.reindexAll({ context, limit: Number(command.limit) || undefined });
          return search.reindex({ context, resourceRef });
        case "resource/preview":
          if (!preview) return { ok: false, error: "PREVIEW_UNAVAILABLE" };
          return preview.preview({ context, resourceRef });
        case "resource/thumbnail":
          if (!preview) return { ok: false, error: "PREVIEW_UNAVAILABLE" };
          return preview.thumbnail({ context, resourceRef });
        // ---- D3-04D：Resource Picker ----
        case "resource/pickerQuery":
          if (!picker) return { ok: false, error: "PICKER_UNAVAILABLE", items: [] };
          return picker.query({ context, appId: command.pickerAppId || command.appId, resourceTypes: command.resourceTypes, requestedActions: command.requestedActions, collectionId: command.collectionId, departmentId: command.departmentId, query: typeof command.query === "string" ? command.query : "", limit: Number(command.limit) || undefined, offset: Number(command.offset) || 0 });
        case "resource/pickerChoose":
          if (!picker) return { ok: false, error: "PICKER_UNAVAILABLE" };
          return picker.choose({ context, appId: command.pickerAppId || command.appId, resourceRef, requestedActions: command.requestedActions });
        case "resource/pickerValidate":
          if (!picker) return { ok: false, error: "PICKER_UNAVAILABLE" };
          return picker.validateSelection({ context, selectionToken: command.selectionToken, action: command.action });
        // ---- D3-04D：Projects ----
        case "resource/listProjects":
          if (!projects) return { ok: false, error: "INTEGRATION_UNAVAILABLE", items: [] };
          return projects.listProjects({ context });
        case "resource/getProject":
          if (!projects) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return projects.getProject({ context, projectId: command.projectId });
        case "resource/createProject":
          if (!projects) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return projects.createProject({ context, name: command.name, description: command.description, departmentId: command.departmentId, scope: command.scope });
        case "resource/addProjectMember":
          if (!projects) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return projects.addMember({ context, projectId: command.projectId, userId: command.userId, role: command.role });
        case "resource/removeProjectMember":
          if (!projects) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return projects.removeMember({ context, projectId: command.projectId, userId: command.userId });
        case "resource/addProjectResource":
          if (!projects) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return projects.addResource({ context, projectId: command.projectId, resourceRef });
        case "resource/removeProjectResource":
          if (!projects) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return projects.removeResource({ context, projectId: command.projectId, resourceRef });
        case "resource/listProjectResources":
          if (!projects) return { ok: false, error: "INTEGRATION_UNAVAILABLE", items: [] };
          return projects.listProjectResources({ context, projectId: command.projectId });
        // ---- D3-04D：Canvas ----
        case "resource/listBoards":
          if (!canvas) return { ok: false, error: "INTEGRATION_UNAVAILABLE", items: [] };
          return canvas.listBoards({ context });
        case "resource/createBoard":
          if (!canvas) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return canvas.createBoard({ context, name: command.name });
        case "resource/getBoard":
          if (!canvas) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return canvas.getBoard({ context, boardId: command.boardId });
        case "resource/addCanvasResource":
          if (!canvas) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return canvas.addResourceNode({ context, boardId: command.boardId, resourceRef, versionMode: command.versionMode, x: command.x, y: command.y });
        case "resource/updateCanvasNode":
          if (!canvas) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return canvas.updateNodeToLatest({ context, nodeId: command.nodeId });
        case "resource/moveCanvasNode":
          if (!canvas) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return canvas.moveNode({ context, nodeId: command.nodeId, x: command.x, y: command.y });
        case "resource/deleteCanvasNode":
          if (!canvas) return { ok: false, error: "INTEGRATION_UNAVAILABLE" };
          return canvas.deleteNode({ context, nodeId: command.nodeId });
        // ---- D3-04D：Export / Reveal（路径只经主进程 dialog / OS action） ----
        case "resource/export": {
          if (!dialog || typeof dialog.showSaveDialog !== "function") return { ok: false, error: "EXPORT_UNAVAILABLE" };
          const meta = service.get({ context, resourceRef });
          const suggested = meta && meta.ok && meta.resource ? String(meta.resource.name || "resource") : "resource";
          const parent = BrowserWindow && e && e.sender ? BrowserWindow.fromWebContents(e.sender) : null;
          const picked = parent ? await dialog.showSaveDialog(parent, { defaultPath: suggested }) : await dialog.showSaveDialog({ defaultPath: suggested });
          if (!picked || picked.canceled || !picked.filePath) return { ok: false, error: "CANCELLED" };
          return service.exportToFile({ context, resourceRef, targetPath: picked.filePath });
        }
        case "resource/revealSource": {
          if (!shell || typeof shell.showItemInFolder !== "function") return { ok: false, error: "REVEAL_UNAVAILABLE" };
          const resolved = service.resolveRevealPath({ context, resourceRef });
          if (!resolved.ok) return resolved;
          shell.showItemInFolder(resolved.path);
          return { ok: true, revealed: true };
        }
        default:
          return { ok: false, error: "INVALID_INPUT" };
      }
    } catch {
      // 异常文本可能夹带路径 / SQL / 参数值，一律收敛（§14 §64）。
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
}

module.exports = { createResourceBundle, registerResourceIpc, RENDERER_COMMANDS };
