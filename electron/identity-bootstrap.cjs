/**
 * D3-01 · 身份装配（**唯一**的一条接线路径）。
 *
 * 为什么要单独成文件：
 *   产品主进程与 UI 探针夹具都要装这套东西。若各装一遍，
 *   "验证过的那条线与产品跑的那条线"就不是同一条 —— 这正是 D1 反复踩过的坑。
 *   因此装配与 IPC 注册都在这里，两处调用方共享同一份实现。
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { IdentityStore } = require("./identity-store.cjs");
const { IdentityService } = require("./identity-service.cjs");
const { IdentityLogger } = require("./identity-log.cjs");
const { SessionSecretStore, safeStorageBackend, plainFileBackend } = require("./session-secret-store.cjs");
const { createAuthorizationService, registerAuthorizationIpc } = require("./authorization-bootstrap.cjs");
const { createDeviceBundle, registerDeviceIpc } = require("./device-bootstrap.cjs");
const { createResourceBundle, registerResourceIpc } = require("./resource-bootstrap.cjs");
const { createGovernanceBundle, registerGovernanceIpc } = require("./governance-bootstrap.cjs");

/**
 * @param opts.userDataDir 数据目录（identity.db 与受保护存储落在这里）
 * @param opts.safeStorage Electron safeStorage（macOS Keychain / Windows DPAPI）
 * @param opts.allowAdmin  是否放行 admin / 测试夹具命令
 * @param opts.logger      可选，注入外部 logger（探针用）
 */
function createIdentityService({ userDataDir, safeStorage, allowAdmin = false, logger, serviceIdentity = null, nativeImage = null } = {}) {
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const log = logger || new IdentityLogger();
  const store = new IdentityStore({
    path: path.join(userDataDir, "identity.db"),
    onAudit: (r) => log.log(r),
  }).open();

  let backend;
  if (safeStorage && safeStorage.isEncryptionAvailable()) backend = safeStorageBackend({ safeStorage, dir: userDataDir });
  else backend = plainFileBackend({ dir: userDataDir });

  if (backend.downgraded) {
    // 降级**必须留痕**：静默降级等于让"token 明文落盘"这件事无人知晓。
    log.log({ event: "secret-backend", result: "DENY", error_code: "DOWNGRADED", detail: backend.kind });
  }
  const secrets = new SessionSecretStore(backend);
  const service = new IdentityService({ store, secrets, logger: log, allowAdmin });
  // D3-02：对象授权与身份共用同一条 SQLite 连接与同一套命令接线。
  const { authorization, authStore } = createAuthorizationService({ identityStore: store, logger: log });
  // D3-03：设备域挂在**同一条** SQLite 连接与事务队列上（迁移 v3 已在 open() 里完成）。
  const { deviceService, deviceStore } = createDeviceBundle({ identityStore: store, authorization, logger: log, serviceIdentity });
  // D3-04A：本地资源对象与 Managed Store（<userData>/library）。启动时做可解释 recovery。
  const { resourceService, resourceStore, managedStore, searchStore, searchService, previewService } = createResourceBundle({
    identityStore: store,
    authorization,
    authStore,
    deviceService,
    storeRoot: path.join(userDataDir, "library"),
    logger: log,
    nativeImage,
  });
  resourceService.recoverStartup();
  searchService.recoverStartup();
  previewService.maintenance();
  // D3-04D：治理 / Projects / Canvas / Picker（复用同一连接与同一 AuthorizationService）。
  const { integrationStore, projectService, canvasService, governanceService, pickerService } = createGovernanceBundle({
    identityStore: store,
    authorization,
    authStore,
    resourceStore,
    searchService,
    logger: log,
  });
  return { service, store, secrets, logger: log, backend, downgraded: !!backend.downgraded, authorization, authStore, deviceService, deviceStore, resourceService, resourceStore, managedStore, searchStore, searchService, previewService, integrationStore, projectService, canvasService, governanceService, pickerService };
}

/**
 * 注册 `identity:command`。
 *
 * @param opts.isTrusted (event) => boolean —— 与 windows:sync 同一条信任判据
 * @param opts.send      (payload) => void —— 把身份事件推给渲染进程
 */
function registerIdentityIpc({ ipcMain, service, authorization, device, resource, resourceSearch, resourcePreview, governance, governanceService, projects, canvas, picker, dialog, BrowserWindow, shell = null, isTrusted, send }) {
  ipcMain.handle("identity:command", async (e, command) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!service) return { ok: false, error: "INTERNAL_ERROR", detail: "identity-not-ready" };
    if (!command || typeof command !== "object") return { ok: false, error: "INVALID_INPUT" };
    try {
      return await service.dispatch(command);
    } catch {
      // 任何异常都收敛成 INTERNAL_ERROR：异常文本可能夹带路径、SQL、参数值
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
  if (send) service.onEvent((event) => send(event));
  // D3-02：同一处注册对象授权只读命令（sessionRef 取自 IdentityService 当前会话）。
  if (authorization) registerAuthorizationIpc({ ipcMain, service: authorization, identity: service, isTrusted });
  // D3-03：设备域（含管理写操作；授权判断在 DeviceService 内，见 device-bootstrap 顶部注释）。
  if (device) registerDeviceIpc({ ipcMain, service: device, identity: service, isTrusted });
  // D3-04A：资源命令（无 raw fs；导入/链接经主进程 dialog）。
  if (resource) registerResourceIpc({ ipcMain, service: resource, search: resourceSearch || null, preview: resourcePreview || null, projects: projects || null, canvas: canvas || null, picker: picker || null, identity: service, isTrusted, dialog: dialog || null, BrowserWindow: BrowserWindow || null, shell });
  // D3-04D：治理命令（Users / Departments / Apps / Audit / Scope / Ownership / Bulk）。
  if (governance || governanceService) registerGovernanceIpc({ ipcMain, service: governance || governanceService, authorization, identity: service, isTrusted });
}

module.exports = { createIdentityService, registerIdentityIpc };
