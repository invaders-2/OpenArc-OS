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
const { IdentityStore, DEFAULT_TTL_MS, DEFAULT_IDLE_MS } = require("./identity-store.cjs");
// task-8 B：任务双表 v29 合并的启动开关与安全执行器（默认关闭；失败不阻断启动）。
const { applyTaskMergeAtStartup } = require("./task-merge-migration.cjs");
const { IdentityService } = require("./identity-service.cjs");
// B4 · 本地账号服务（部门 / 用户 / APP 访问 / 审计）：复用既有表与既有身份命令层。
const { LocalAccountService } = require("./local-account-service.cjs");
const { IdentityLogger } = require("./identity-log.cjs");
const { SessionSecretStore, safeStorageBackend, plainFileBackend } = require("./session-secret-store.cjs");
const { createAuthorizationService, registerAuthorizationIpc } = require("./authorization-bootstrap.cjs");
const { createDeviceBundle, registerDeviceIpc } = require("./device-bootstrap.cjs");
const { createResourceBundle, registerResourceIpc } = require("./resource-bootstrap.cjs");
const { createGovernanceBundle, registerGovernanceIpc } = require("./governance-bootstrap.cjs");
const { createModelBundle, registerModelIpc } = require("./model-bootstrap.cjs");
const { createMcpBundle, attachMcpSessionLifecycle, attachMcpAppGrantRevocation } = require("./mcp-bootstrap.cjs");
const { seedBuiltinAppToolGrants } = require("./builtin-app-grants.cjs");
const { createCanvasBundle } = require("./canvas-bootstrap.cjs");
// B5d · 画布域扩展（素材库 / 协作 / 内核能力 / Agent 附件 / .dxcanvas）：复用同一条 identity 连接。
const { CanvasDxosStore } = require("./canvas-dxos-store.cjs");
const { CanvasAssetLibraryService } = require("./canvas-dxos-asset-library.cjs");
const { CanvasAgentAttachmentService } = require("./canvas-dxos-agent-attachments.cjs");
const { createCanvasDxosExtension } = require("./canvas-dxos-commands.cjs");
const { createTaskBundle } = require("./task-bootstrap.cjs");
const { createWebAccess } = require("./web-access.cjs");
const { createSideEffectGateway, registerSideEffectIpc } = require("./side-effect-bootstrap.cjs");

// ---------------------------------------------------------------------------
// 短有效期覆写（验收用）：**默认路径完全不经过这里**
// ---------------------------------------------------------------------------

/** 双重开关与边界。MIN_MS 是下限保护：比它更短的有效期不是"测试方便"，是把会话变成噪声。 */
const SESSION_TTL_OVERRIDE = Object.freeze({
  ACK_ENV: "OPENARC_ALLOW_SESSION_TTL_OVERRIDE",
  IDLE_ENV: "OPENARC_SESSION_IDLE_MS",
  TTL_ENV: "OPENARC_SESSION_TTL_MS",
  MIN_MS: 2000,
});

const TTL_OVERRIDE_VALUE_RE = /^[0-9]+$/;

/**
 * 短有效期覆写的**唯一**解析入口。生效需要**同时**满足两件事：
 *   ① OPENARC_ALLOW_SESSION_TTL_OVERRIDE=1 —— 显式承认"这不是产品默认值"
 *   ② OPENARC_SESSION_IDLE_MS / OPENARC_SESSION_TTL_MS 是 >= 2000 的十进制整数
 *
 * 缺一个就整体忽略并留痕（ack 缺失与值非法分开记），**绝不静默**，
 * 也绝不把非法值折算成任何东西 —— 没被接受的那一项继续走产品默认值。
 *
 * @returns {{ applied: boolean, sessionIdleMs?: number, sessionTtlMs?: number,
 *             records: Array<{ event: string, result: string, error_code?: string, detail: object, message: string }> }}
 *          records 由调用方（main 的启动路径）打到可见日志里，人一眼能看出"这不是产品默认值"。
 */
function resolveSessionTtlOverride({ env = process.env } = {}) {
  const read = (name) => (env && env[name] != null ? String(env[name]).trim() : "");
  const requested = [
    ["idleMs", SESSION_TTL_OVERRIDE.IDLE_ENV, read(SESSION_TTL_OVERRIDE.IDLE_ENV)],
    ["ttlMs", SESSION_TTL_OVERRIDE.TTL_ENV, read(SESSION_TTL_OVERRIDE.TTL_ENV)],
  ].filter(([, , value]) => value !== "");
  const acknowledged = read(SESSION_TTL_OVERRIDE.ACK_ENV) === "1";
  // 一个值都没给：既没有覆写请求，也没有需要留痕的东西（ack 单独给出不改变任何行为）。
  if (!requested.length) return { applied: false, records: [] };

  const event = "session-ttl-override";
  if (!acknowledged) {
    const ignored = requested.map(([, name]) => name);
    return {
      applied: false,
      records: [{
        event,
        result: "DENY",
        error_code: "OVERRIDE_NOT_ACKNOWLEDGED",
        detail: { ackEnv: SESSION_TTL_OVERRIDE.ACK_ENV, ignored },
        message: "忽略 " + ignored.join(" / ") + "：必须同时设置 " + SESSION_TTL_OVERRIDE.ACK_ENV + "=1（显式承认这不是产品默认值）才生效，本次沿用默认有效期。",
      }],
    };
  }

  const accepted = {};
  const rejected = [];
  for (const [key, name, value] of requested) {
    const parsed = TTL_OVERRIDE_VALUE_RE.test(value) ? Number(value) : NaN;
    // 十进制整数 + 安全整数（SQLite INTEGER 落得进去）+ 下限保护，三者缺一即忽略。
    if (!Number.isSafeInteger(parsed) || parsed < SESSION_TTL_OVERRIDE.MIN_MS) rejected.push({ env: name, value });
    else accepted[key] = parsed;
  }
  if (!Object.keys(accepted).length) {
    return {
      applied: false,
      records: [{
        event,
        result: "DENY",
        error_code: "OVERRIDE_VALUE_INVALID",
        detail: { minMs: SESSION_TTL_OVERRIDE.MIN_MS, rejected },
        message: "忽略 " + rejected.map((r) => r.env).join(" / ") + "：值必须是不小于 " + SESSION_TTL_OVERRIDE.MIN_MS + " 的十进制整数（收到 " + rejected.map((r) => JSON.stringify(r.value)).join(" / ") + "），本次沿用默认有效期。",
      }],
    };
  }

  const effective = { idleMs: accepted.idleMs ?? DEFAULT_IDLE_MS, ttlMs: accepted.ttlMs ?? DEFAULT_TTL_MS };
  return {
    applied: true,
    sessionIdleMs: accepted.idleMs,
    sessionTtlMs: accepted.ttlMs,
    records: [{
      event,
      result: "OK",
      detail: {
        ackEnv: SESSION_TTL_OVERRIDE.ACK_ENV,
        applied: { idleMs: accepted.idleMs ?? null, ttlMs: accepted.ttlMs ?? null },
        defaults: { idleMs: DEFAULT_IDLE_MS, ttlMs: DEFAULT_TTL_MS },
        effective,
        ...(rejected.length ? { rejected } : {}),
      },
      message: "会话有效期覆写生效（非产品默认值；原因：" + SESSION_TTL_OVERRIDE.ACK_ENV + "=1 且显式给出 " + requested.map(([, name]) => name).join(" / ") + "）：idleMs " + DEFAULT_IDLE_MS + " → " + effective.idleMs + "，ttlMs " + DEFAULT_TTL_MS + " → " + effective.ttlMs + "。不给开关的默认路径不受影响。",
    }],
  };
}

/**
 * @param opts.userDataDir 数据目录（identity.db 与受保护存储落在这里）
 * @param opts.safeStorage Electron safeStorage（macOS Keychain / Windows DPAPI）
 * @param opts.allowAdmin  是否放行 admin / 测试夹具命令
 * @param opts.logger      可选，注入外部 logger（探针用）
 * @param opts.sessionTtlMs   可选，绝对有效期（**只有显式注入才改**；默认 DEFAULT_TTL_MS）
 * @param opts.sessionIdleMs  可选，空闲有效期（**只有显式注入才改**；默认 DEFAULT_IDLE_MS）
 * @param opts.timers         可选，到期调度用的 { setTimeout, clearTimeout }（测试注入）
 */
function createIdentityService({ userDataDir, safeStorage, allowAdmin = false, logger, serviceIdentity = null, nativeImage = null, executorLauncher = null, executorTestHook = null, browserControl = null, sessionTtlMs = null, sessionIdleMs = null, timers = null, mcpInvocationSwitch = null, taskMergeV29 = null, workspaceDir = null } = {}) {
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const log = logger || new IdentityLogger();
  const store = new IdentityStore({
    path: path.join(userDataDir, "identity.db"),
    // task-8 B：迁移前备份统一落 <userData>/dxos/backups（VACUUM INTO；普通迁移默认无 backupBefore）。
    backupDir: path.join(userDataDir, "dxos", "backups"),
    // 已合并库（v29 + dx_tasks 视图）允许打开；直接 new IdentityStore() 仍保持 fail closed。
    allowMergedV29: true,
    // 非有限值（未注入 / null / 非法）一律落回 store 的默认有效期 —— 默认路径一个字节都不变。
    ttlMs: Number.isFinite(sessionTtlMs) ? sessionTtlMs : undefined,
    idleMs: Number.isFinite(sessionIdleMs) ? sessionIdleMs : undefined,
    onAudit: (r) => log.log(r),
  }).open();

  // task-8 B：v29 任务表合并（默认关闭）。失败只记录，不阻断启动；库保持 v28 + 备份可恢复。
  let taskMergeV29Result = null;
  try {
    taskMergeV29Result = applyTaskMergeAtStartup({
      store,
      userDataDir,
      enabled: taskMergeV29,
      logger: (event) => log.log(event),
    });
  } catch (error) {
    taskMergeV29Result = {
      enabled: typeof taskMergeV29 === "boolean" ? taskMergeV29 : false,
      applied: false, state: "unknown", reason: "startup-helper-failed",
      error: { code: "TASK_MERGE_STARTUP_FAILED", message: String((error && error.message) || error).slice(0, 300) },
    };
  }

  let backend;
  if (safeStorage && safeStorage.isEncryptionAvailable()) backend = safeStorageBackend({ safeStorage, dir: userDataDir });
  else backend = plainFileBackend({ dir: userDataDir });

  if (backend.downgraded) {
    // 降级**必须留痕**：静默降级等于让"token 明文落盘"这件事无人知晓。
    log.log({ event: "secret-backend", result: "DENY", error_code: "DOWNGRADED", detail: backend.kind });
  }
  const secrets = new SessionSecretStore(backend);
  const service = new IdentityService({ store, secrets, logger: log, allowAdmin, timers });
  // D3-02：对象授权与身份共用同一条 SQLite 连接与同一套命令接线。
  const { authorization, authStore } = createAuthorizationService({ identityStore: store, logger: log });
  // task-68：已有安装启动时立即补内置工具基线（不依赖用户重新登录）；新安装由登录事件补。
  try {
    const bootAdmin = store.allUsers().find((user) => user.role === "ADMIN" && user.team_id) || null;
    if (bootAdmin) seedBuiltinAppToolGrants({ authStore, organizationId: bootAdmin.team_id, grantedBy: bootAdmin.id });
  } catch { /* 基线失败不阻塞启动；登录事件会再尝试 */ }
  // B4：本地账号管理命令（identity/departments-list … identity/local-account-info）走同一条
  // identity:command；认证与超级管理员判定在 identity-service.cjs / local-account-service.cjs 既有实现里。
  const localAccountService = new LocalAccountService({ identity: store, authStore, authorization, identityService: service });
  service.attachLocalAccount(localAccountService);
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
    // 共享/可见性/转移的审计与治理域共用同一个 AuthorizationStore 实例（同一条连接/事务）。
    authStore,
    logger: log,
  });
  // B5d：画布域扩展。与文档层共用同一条 identity 连接与同一个 canvasDocService；
  // 命令面仍只有 canvas:command 一条（由 main.cjs 用 extension 挂上，不新建通道）。
  const canvasDxosTempDir = path.join(userDataDir, "tmp", "canvas-dxos");
  const canvasDxosStore = new CanvasDxosStore({ identity: store });
  const canvasAssetLibrary = new CanvasAssetLibraryService({
    identity: store, store: canvasDxosStore, resourceService, resourceStore,
    canvasService: canvasDocService,
    // sync-sources 的部门盘可见性需要真实成员关系（AuthorizationService.resolveActor）；
    // dxos-fs 晚绑定由 main.cjs 在 createDxosFsAdapter 之后调用 configureFs。
    authorization,
    tempDir: () => canvasDxosTempDir,
  });
  const canvasAgentAttachments = new CanvasAgentAttachmentService({
    identity: store, store: canvasDxosStore, canvasService: canvasDocService,
    resourceService, tempDir: () => canvasDxosTempDir,
  });
  const canvasDxosExtension = createCanvasDxosExtension({
    identity: store, store: canvasDxosStore, canvasService: canvasDocService,
    resourceService, assetLibrary: canvasAssetLibrary, attachments: canvasAgentAttachments,
    tempDir: () => canvasDxosTempDir,
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
  // D5-03 第一批：MCP 中心（连接记录 + 凭据元数据 + 会话日志；复用同一连接与 AuthorizationService）。
  // 真实握手用的受控 launcher 由 mcp-bootstrap 按运行环境选择
  // （Electron main = Electron 运行时 + ELECTRON_RUN_AS_NODE，stdio 需要真 stdin）。
  const { mcpStore, mcpService, seedMcpAppPolicy } = createMcpBundle({
    identityStore: store,
    authorization,
    authStore,
    userDataDir,
    safeStorage,
    logger: log,
    // B4e 收口：显式开关的**同一实例**注入到每个真实 McpClient（默认关闭）。
    invocationGate: mcpInvocationSwitch ? () => mcpInvocationSwitch.isToolInvocationEnabled() === true : null,
  });
  // D5-03 第三批 · 生命周期接线（唯一装配路径，产品与探针共用）：
  //   · 登出 / 锁屏（identity/logged-out | identity/locked）→ 收掉活连接与在途握手；
  //   · 撤销 App 的 mcp.* 授权 → 立刻收掉该组织下的活连接。
  // 两者都不改写 enabled，重新登录 / 重授后 connect 照常可用。
  attachMcpSessionLifecycle({ identityService: service, mcpService, logger: log });
  attachMcpAppGrantRevocation({ authorization, mcpService });
  // D4-02A：Task Runtime 持久权威（复用同一连接与 AuthorizationService；启动即 recovery）。
  // D4-03C4：唯一 side-effect production assembly（Registry → Proxy → Authority → Supervisor → Runtime）。
  // 全局 AI 联网（只读搜索 / 抓取）：出网 fetch 晚绑定到模型出网代理（runtime-composition 装配后才有），
  // 用户配了代理就走代理；同一实例同时给对话工具链和画布联网开关用。
  const webAccess = createWebAccess({
    getFetch: () => (modelService && typeof modelService.fetchImpl === "function" ? modelService.fetchImpl : null),
    isProxied: () => { try { return !!(modelService && modelService.readEgressProxy().enabled); } catch { return false; } },
    logger: log,
  });
  const { taskStore, taskService, taskRecovery, toolStore, toolRegistry, toolProxy, adapters, workspace: agentWorkspace, supervisor, sideEffectStore, sideEffectAuthority, sideEffectRuntime, sideEffectRecovery, sideEffectReady, orchestrator } = createTaskBundle({
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
    webAccess,
    dbPath: path.join(userDataDir, "identity.db"),
    storeRoot: path.join(userDataDir, "library"),
    runtimeDir: path.join(userDataDir, "runtime", "side-effects"),
    // D4-04 Closure：executor launcher 与 test-only fault seam 由 host 注入；
    // Renderer / Harness / ACP / Tool args 一律无法选择 launcher。
    executorLauncher,
    executorTestHook,
    // 全局 AI 会话化：每个对话一个持久 dsh 会话目录（多轮接着上下文）。
    // 第 2 期：AI 工作文件夹（读写 / 运行命令只限这里；写和命令都要审批）。
    agentSession: { sessionRoot: path.join(userDataDir, "agent-sessions"), workspaceDir: workspaceDir || path.join(userDataDir, "workspace") },
  });
  // D5-02 Closure：拿到会话时对该会话的组织再 seed 一次内置 Model App baseline
  // （首次运行是"先建库、后注册管理员"，一次性 seed 时还没有组织）。upsert 幂等。
  try {
    service.onEvent((event) => {
      const teamId = event && event.snapshot && event.snapshot.teamId ? String(event.snapshot.teamId) : null;
      if (!teamId) return;
      const admin = store.allUsers().find((u) => u.role === "ADMIN" && u.team_id === teamId) || null;
      seedModelAppPolicy({ organizationId: teamId, grantedBy: admin ? admin.id : "system:model-baseline" });
      seedMcpAppPolicy({ organizationId: teamId, grantedBy: admin ? admin.id : "system:mcp-baseline" });
      // task-68：AI/画布/文件/MCP 等内置工具基线权限（只补 grant；审批/lease 不在这里）。
      seedBuiltinAppToolGrants({ authStore, organizationId: teamId, grantedBy: admin ? admin.id : "system:builtin-tool-baseline" });
    });
  } catch { /* ignore */ }

  // D5-02 Closure：画布生成运行需要任务层（预算/停止/账本）与模型层 —— 装配完成后晚绑定同一实例。
  canvasDocService.attachRuntime({ taskService, modelService, webAccess, tempDir: path.join(userDataDir, "tmp", "canvas-imports") });
  try { require("node:fs").mkdirSync(path.join(userDataDir, "tmp", "canvas-imports"), { recursive: true }); } catch { /* ignore */ }
  try { require("node:fs").mkdirSync(canvasDxosTempDir, { recursive: true }); } catch { /* ignore */ }

  // Trusted Approval Gateway：Renderer 只能经此通道看到安全投影并提交 decision。
  const sideEffectGateway = createSideEffectGateway({ sideEffectRuntime });
  return { service, store, secrets, logger: log, webAccess, backend, downgraded: !!backend.downgraded, authorization, authStore, deviceService, deviceStore, resourceService, resourceStore, managedStore, searchStore, searchService, previewService, integrationStore, projectService, canvasService, governanceService, pickerService, modelStore, credentialStore, modelService, modelProxy, mcpStore, mcpService, taskStore, taskService, taskRecovery, toolStore, toolRegistry, toolProxy, adapters, agentWorkspace, supervisor, sideEffectStore, sideEffectAuthority, sideEffectRuntime, sideEffectRecovery, sideEffectReady, sideEffectGateway, orchestrator, browserControl, canvasDocService, localAccountService, canvasDxosStore, canvasAssetLibrary, canvasAgentAttachments, canvasDxosExtension, taskMergeV29: taskMergeV29Result };
}

/**
 * 注册 `identity:command`。
 *
 * @param opts.isTrusted (event) => boolean —— 与 windows:sync 同一条信任判据
 * @param opts.send      (payload) => void —— 把身份事件推给渲染进程
 * @param opts.bootError 身份服务创建失败时的人话原因；有它时 service 必须为 null，
 *                       启动询问会拿到 BOOT_FAILED，渲染层据此走已有的 BootRetry
 */
function registerIdentityIpc({ ipcMain, service, authorization, device, resource, resourceSearch, resourcePreview, governance, governanceService, projects, canvas, picker, model, sideEffect = null, dialog, BrowserWindow, shell = null, resolveFile = null, isTrusted, send, sendSideEffect = null, bootError = null }) {
  ipcMain.handle("identity:command", async (e, command) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!service)
      return bootError
        ? { ok: false, error: "BOOT_FAILED", detail: String(bootError) }
        : { ok: false, error: "INTERNAL_ERROR", detail: "identity-not-ready" };
    if (!command || typeof command !== "object") return { ok: false, error: "INVALID_INPUT" };
    try {
      return await service.dispatch(command);
    } catch {
      // 任何异常都收敛成 INTERNAL_ERROR：异常文本可能夹带路径、SQL、参数值
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
  if (send && service) service.onEvent((event) => send(event));
  // D3-02：同一处注册对象授权只读命令（sessionRef 取自 IdentityService 当前会话）。
  if (authorization) registerAuthorizationIpc({ ipcMain, service: authorization, identity: service, isTrusted });
  // D3-03：设备域（含管理写操作；授权判断在 DeviceService 内，见 device-bootstrap 顶部注释）。
  if (device) registerDeviceIpc({ ipcMain, service: device, identity: service, isTrusted });
  // D3-04A：资源命令（无 raw fs；导入/链接经主进程 dialog）。
  // Z2：resolveFile 由 main.cjs 注入（file-service.resolve 的窄投影），访达选中项据此加入资源库。
  if (resource) registerResourceIpc({ ipcMain, service: resource, search: resourceSearch || null, preview: resourcePreview || null, projects: projects || null, canvas: canvas || null, picker: picker || null, identity: service, isTrusted, dialog: dialog || null, BrowserWindow: BrowserWindow || null, shell, resolveFile });
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

module.exports = { createIdentityService, registerIdentityIpc, resolveSessionTtlOverride, SESSION_TTL_OVERRIDE };
