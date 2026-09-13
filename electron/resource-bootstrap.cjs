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
]);

/**
 * @param opts.storeRoot  <userData>/library（由主进程按平台规范给出）
 */
function createResourceBundle({ identityStore, authorization, authStore = null, deviceService = null, storeRoot, logger = null, clock = null } = {}) {
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
  return { resourceService, resourceStore, managedStore };
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
function registerResourceIpc({ ipcMain, service, identity, isTrusted, dialog = null, BrowserWindow = null }) {
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
