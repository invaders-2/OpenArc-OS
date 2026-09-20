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
const { createModelBundle, registerModelIpc } = require("./model-bootstrap.cjs");
const { createCanvasBundle } = require("./canvas-bootstrap.cjs");
const { createTaskBundle } = require("./task-bootstrap.cjs");
const { createSideEffectGateway, registerSideEffectIpc } = require("./side-effect-bootstrap.cjs");

/**
 * @param opts.userDataDir 数据目录（identity.db 与受保护存储落在这里）
 * @param opts.safeStorage Electron safeStorage（macOS Keychain / Windows DPAPI）
 * @param opts.allowAdmin  是否放行 admin / 测试夹具命令
 * @param opts.logger      可选，注入外部 logger（探针用）
 */
function createIdentityService({ userDataDir, safeStorage, allowAdmin = false, logger, serviceIdentity = null, nativeImage = null, executorLauncher = null, executorTestHook = null, browserControl = null } = {}) {
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
  // D5-02：无限画布的**文档层**。board 身份与资源引用沿用 D3-04D 的 canvasService，
  // 这里只加"可编辑文档 + 版本检查 + 命令层"（AI 工具与画布宿主共用同一个实例）。
  const { service: canvasDocService } = createCanvasBundle({
    identityStore: store,
    resourceStore,
    resourceService,
    authService: authorization,
    logger: log,
  });
  // D4-01：模型 Provider / Credential / Config / Default（复用同一连接与 AuthorizationService）。
  const { modelStore, credentialStore, modelService, modelProxy, seedModelAppPolicy } = createModelBundle({
    identityStore: store,
    authorization,
    authStore,
    userDataDir,
    safeStorage,
    logger: log,
  });
  // D4-02A：Task Runtime 持久权威（复用同一连接与 AuthorizationService；启动即 recovery）。
  // D4-03C4：唯一 side-effect production assembly（Registry → Proxy → Authority → Supervisor → Runtime）。
  const { taskStore, taskService, taskRecovery, toolStore, toolRegistry, toolProxy, adapters, supervisor, sideEffectStore, sideEffectAuthority, sideEffectRuntime, sideEffectRecovery, sideEffectReady, orchestrator } = createTaskBundle({
    identityStore: store,
    authorization,
    authStore,
    modelService,
    modelProxy,
    logger: log,
    resourceService,
    searchService,
    // D5-01 Closure-2：受控浏览器目标是**宿主（真实 main）持有**的对象：原生视图控制器晚绑定，
    // 这里只把同一实例接进唯一工具链，绝不在装配层再造一个。
    browserControl,
    // D5-02：AI 编辑画布的执行端（与手工路径同一命令层 + 版本检查 + 权限规则）。
    canvasService: canvasDocService,
    dbPath: path.join(userDataDir, "identity.db"),
    storeRoot: path.join(userDataDir, "library"),
    runtimeDir: path.join(userDataDir, "runtime", "side-effects"),
    // D4-04 Closure：executor launcher 与 test-only fault seam 由 host 注入；
    // Renderer / Harness / ACP / Tool args 一律无法选择 launcher。
    executorLauncher,
    executorTestHook,
  });
  // D5-02 Closure：拿到会话时对该会话的组织再 seed 一次内置 Model App baseline
  // （首次运行是"先建库、后注册管理员"，一次性 seed 时还没有组织）。upsert 幂等。
  try {
    service.onEvent((event) => {
      const teamId = event && event.snapshot && event.snapshot.teamId ? String(event.snapshot.teamId) : null;
      if (!teamId) return;
      const admin = store.allUsers().find((u) => u.role === "ADMIN" && u.team_id === teamId) || null;
      seedModelAppPolicy({ organizationId: teamId, grantedBy: admin ? admin.id : "system:model-baseline" });
    });
  } catch { /* ignore */ }

  // D5-02 Closure：画布生成运行需要任务层（预算/停止/账本）与模型层 —— 装配完成后晚绑定同一实例。
  canvasDocService.attachRuntime({ taskService, modelService, tempDir: path.join(userDataDir, "tmp", "canvas-imports") });
  try { require("node:fs").mkdirSync(path.join(userDataDir, "tmp", "canvas-imports"), { recursive: true }); } catch { /* ignore */ }

  // Trusted Approval Gateway：Renderer 只能经此通道看到安全投影并提交 decision。
  const sideEffectGateway = createSideEffectGateway({ sideEffectRuntime });
  return { service, store, secrets, logger: log, backend, downgraded: !!backend.downgraded, authorization, authStore, deviceService, deviceStore, resourceService, resourceStore, managedStore, searchStore, searchService, previewService, integrationStore, projectService, canvasService, governanceService, pickerService, modelStore, credentialStore, modelService, modelProxy, taskStore, taskService, taskRecovery, toolStore, toolRegistry, toolProxy, adapters, supervisor, sideEffectStore, sideEffectAuthority, sideEffectRuntime, sideEffectRecovery, sideEffectReady, sideEffectGateway, orchestrator, browserControl, canvasDocService };
}

/**
 * 注册 `identity:command`。
 *
 * @param opts.isTrusted (event) => boolean —— 与 windows:sync 同一条信任判据
 * @param opts.send      (payload) => void —— 把身份事件推给渲染进程
 */
function registerIdentityIpc({ ipcMain, service, authorization, device, resource, resourceSearch, resourcePreview, governance, governanceService, projects, canvas, picker, model, sideEffect = null, dialog, BrowserWindow, shell = null, isTrusted, send, sendSideEffect = null }) {
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
  // D4-01：模型管理命令（actor sessionRef / appId 由主进程决定；无 raw credential / proxy capability）。
  if (model) registerModelIpc({ ipcMain, service: model, identity: service, isTrusted });
  // D4-03C4：Trusted Approval Gateway（唯一 approval 通道；sessionRef 由主进程注入）。
  if (sideEffect) {
    if (typeof sideEffect === "object" && typeof sendSideEffect === "function" && sideEffect.runtime) {
      // §44 对推送同样成立：runtime 推来的快照没有 context，直接转发会把**别人任务**的
      // approval 投影送进当前窗口，所以按当前 authenticated session 重新投影，不属于本会话就静默丢弃。
      sideEffect.runtime.onApprovalRequested = (request) => {
        const current = (service && service.current) || null;
        if (!current) return;
        const snapshot = sideEffect.runtime.approvalSnapshot({ approvalRequestId: request && request.approvalRequestId, context: { sessionRef: current } });
        if (snapshot) sendSideEffect({ type: "sideEffect/approvalRequested", request: snapshot });
      };
    }
    registerSideEffectIpc({ ipcMain, service: sideEffect, identity: service, isTrusted, send: sendSideEffect });
  }
}

module.exports = { createIdentityService, registerIdentityIpc };
