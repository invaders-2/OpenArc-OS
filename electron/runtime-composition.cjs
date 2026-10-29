/**
 * 主进程 runtime 组合，不实现领域规则。
 * runtime-boot.cjs 独占 identity → modelProxy.start 顺序；本模块只创建和注册一次各共享实例。
 * files、MCP bridge、DX fs、canvas/developer 等晚绑定都经共享 context 或既有 configure/attach 完成，
 * 不得为了拆文件复制服务、提前构造依赖或把 sessionRef 改由 renderer 自报。
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  nativeImage,
  session,
  protocol,
  dialog,
  shell,
  Notification,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { registerIdentityIpc, resolveSessionTtlOverride } = require("./identity-bootstrap.cjs");
const { registerCanvasIpc } = require("./canvas-bootstrap.cjs");
const { registerTaskIpc } = require("./task-bootstrap.cjs");
const { wireModelEvents } = require("./model-bootstrap.cjs");
const { createEgressFetch } = require("./net-egress.cjs");
const { createAgentBundle, createDxosFsAdapterForUserData } = require("./agent-service.cjs");
const { registerAgentIpc } = require("./agent-bootstrap.cjs");
const { createSkillBundle } = require("./skill-service.cjs");
const { registerSkillIpc } = require("./skill-bootstrap.cjs");
const {
  createMediaBundle,
  createMediaProviderStore,
  createMediaModelGateway,
  createGuardedFetch,
  probeIllustratorAvailability,
  probeOnnxAvailability,
} = require("./media-service.cjs");
const { registerMediaIpc } = require("./media-bootstrap.cjs");
const { createCalendarBundle } = require("./calendar-service.cjs");
const { registerCalendarIpc } = require("./calendar-bootstrap.cjs");
const { createLitterboxUploader } = require("./media-litterbox.cjs");
const { createUploadConsentService } = require("./upload-consent-service.cjs");
const { registerUploadConsentIpc } = require("./upload-consent-bootstrap.cjs");
const { createAssetPublicUrl, createImportRemote } = require("./canvas-asset-public-url.cjs");
const { downloadProtocolArtifact } = require("./protocol-engine/artifactDownload.cjs");
const { createMediaResourceRegistrar } = require("./media-resource-registrar.cjs");
const { createAutomationBundle } = require("./automation-service.cjs");
const { registerAutomationIpc } = require("./automation-bootstrap.cjs");
const { createDesktopExecutor, createSystemMusicController, MAC_SYSTEM_APPS } = require("./desktop-executor.cjs");
const { createPlatformBundle } = require("./platform-service.cjs");
const { registerPlatformIpc } = require("./platform-bootstrap.cjs");
const { createDeveloperBundle } = require("./developer-service.cjs");
const { registerDeveloperIpc } = require("./developer-bootstrap.cjs");
const { createDeveloperStore } = require("./developer-store.cjs");
const { createCanvasPluginHost } = require("./canvas-dxos-plugins.cjs");
const { runCatalogTool } = require("./agent-tool-catalog.cjs");
const { createDeveloperDomainExtensions, DeveloperLab } = require("./developer-lab.cjs");
const { DeveloperCollabProjects } = require("./developer-collab.cjs");
const { DeveloperMigrationSnapshotStore } = require("./developer-migrations.cjs");
const { DeveloperRealtimeHub } = require("./developer-realtime.cjs");
const { createPluginBundle } = require("./plugin-service.cjs");
const { createMarketBundle } = require("./market-service.cjs");
const { createMarketUpdateBundle } = require("./market-update-service.cjs");
const { createCanvasBundleResolver } = require("./canvas-package-resolver.cjs");
const { createAppPackageResolver } = require("./app-package-resolver.cjs");
const { createThirdPartyRegistry, createThirdPartyMarket } = require("./market-third-party-service.cjs");
const { registerIntegrationIpc, registerMarketIpc } = require("./plugin-bootstrap.cjs");
const { createProviderAdapter } = require("./provider-adapter-bridge.cjs");
const { registerMcpIpc } = require("./mcp-bootstrap.cjs");
const { createMcpAgentBridge } = require("./mcp-agent-bridge.cjs");
const { createMcpConnectionsPort, constructOrDegrade } = require("./mcp-connections-port.cjs");
const { createAppManagedMcpRegistry } = require("./mcp-app-registry.cjs");
const { createMcpSwitch } = require("./mcp-switch.cjs");
const { createMcpLiveTransport } = require("./mcp-live-transport.cjs");
const { mcpToolIdFor, MCP_TOOL_VERSION } = require("./mcp-tool-contract.cjs");
const { createDxTaskApprovalBridge, createDxBridgedApprovalPort } = require("./dx-task-approval-bridge.cjs");
const { createMcpSideEffectProvider } = require("./mcp-side-effect-provider.cjs");
const { createDefaultExecutorLauncher } = require("./executor-launcher.cjs");
const { createOpenArcRuntime } = require("./runtime-boot.cjs");
const { createSystemFontsBundle, registerSystemFontsIpc } = require("./system-fonts-bootstrap.cjs");
const { createOcrBundle } = require("./ocr-service.cjs");
const { registerOcrIpc } = require("./ocr-bootstrap.cjs");
const { createFileTransferBundle } = require("./file-transfer-service.cjs");
const { registerFileTransferIpc } = require("./file-transfer-bootstrap.cjs");
const { createCodexCanvasDomain, registerCodexCanvasIpc } = require("./codex-canvas-bootstrap.cjs");
const { createLocalProxyService } = require("./local-proxy-service.cjs");
const { createChatPreview, createVoiceTranscriber, registerChatIpc } = require("./chat-preview.cjs");
const { createChatPrefs } = require("./chat-prefs.cjs");
const { registerLocalProxyIpc } = require("./local-proxy-bootstrap.cjs");
const { createDesktopCacheService } = require("./desktop-cache-service.cjs");
const { createDesktopUpdateService } = require("./desktop-update-service.cjs");
const { createLanCollabService } = require("./lan-collab-service.cjs");
const { createPhotosBundle } = require("./photos-service.cjs");
const { createPhotosShareAccess } = require("./photos-share-access.cjs");
const { registerPhotosIpc } = require("./photos-bootstrap.cjs");
const { createPhotocraftBundle } = require("./photocraft-service.cjs");
const { registerPhotocraftIpc } = require("./photocraft-bootstrap.cjs");
const { createAppExchangeBundle } = require("./app-exchange-service.cjs");
const { registerAppExchangeIpc } = require("./app-exchange-bootstrap.cjs");
const { createCanvasExchangePorts } = require("./canvas-exchange-ports.cjs");
const { createCliBundle } = require("./cli-service.cjs");
const { registerCliIpc } = require("./cli-bootstrap.cjs");
const { BrowserControlAuthority } = require("./browser-control-authority.cjs");

let win;
// 全局 AI 后台任务：窗口不在前台时，任务跑完 / 需要确认就发系统通知；点通知回到对应对话。
let agentNotifier = null;
function getAgentNotifier() {
  if (!agentNotifier) {
    agentNotifier = require("./agent-notify.cjs").createAgentNotifier({
      Notification,
      getWindow: () => win,
      sendTaskEvent: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("task:event", event); },
    });
  }
  return agentNotifier;
}
let trusted;
let identity;
let mcpAgentBridge = null;
let mcpSwitch = null;
let identityBootFailure = null;
let canvasBundle;
let agentBundle;
let skillBundle;
let mediaBundle;
let automationBundle;
/**
 * 自动化 → 全局 AI：到点时以当前登录用户新开一段对话执行提示词。
 * 等这一轮跑完（最多 8 分钟，短于自动化 10 分钟的僵尸判定），之后的进度在对话里看。
 * 对话标题记成「自动化名 · 月/日 时:分」，方便在列表里认出来。
 */
const CHAT_TASK_WAIT_MS = 8 * 60000;
const CHAT_TASK_ERRORS = {
  TASK_NOT_SIGNED_IN: "需要登录创建这条自动化的账号，OpenArc 才能替你执行",
  MODEL_CONFIG_UNAVAILABLE: "没有可用的对话模型（或选的模型已停用）",
  CAPABILITY_UNAVAILABLE: "选的模型不支持对话",
  TASK_FORBIDDEN: "当前身份无权使用全局 AI",
  INVALID_INPUT: "提示词为空",
};
function createChatTaskAutomationAdapter() {
  return {
    async run(prompt, options = {}) {
      const started = chatTaskRunner.runAsCurrentUser({ userId: options.userId, goal: prompt, modelConfigId: options.modelConfigId || null });
      if (!started || !started.ok) {
        const code = (started && started.error) || "INTERNAL_ERROR";
        const error = new Error(CHAT_TASK_ERRORS[code] || ("全局 AI 没有启动（" + code + "）"));
        error.code = code;
        throw error;
      }
      if (options.title) {
        const d = new Date();
        const stamp = (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
        try { getChatPrefs().update({ userId: options.userId, taskId: started.taskId, action: "rename", title: String(options.title).slice(0, 60) + " · " + stamp }); } catch { /* 标题写不进去不影响执行 */ }
      }
      let timer = null;
      const result = await Promise.race([
        started.settled,
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), CHAT_TASK_WAIT_MS); if (timer.unref) timer.unref(); }),
      ]);
      if (timer) clearTimeout(timer);
      const status = result && result.task ? result.task.status : "RUNNING";
      const text = result && result.artifact && result.artifact.content != null ? String(result.artifact.content) : "";
      return { taskId: started.taskId, status, text };
    },
  };
}
/** 对话列表偏好（重命名 / 置顶 / 隐藏）：对话 IPC 与「自动化」共用同一个实例，避免两份缓存互相覆盖。 */
let chatPrefsStore = null;
function getChatPrefs() {
  if (!chatPrefsStore) chatPrefsStore = createChatPrefs({ file: path.join(app.getPath("userData"), "chat-prefs.json") });
  return chatPrefsStore;
}
/** 全局 AI 对话的「以当前登录用户开新对话」入口（registerTaskIpc 返回），供自动化到点时调用。 */
let chatTaskRunner = null;
let platformBundle;
let developerBundle;
let pluginBundle;
let marketBundle;
let marketUpdateBundle;
let appPackageResolver = null;
let thirdPartyRegistry = null;
let thirdPartyMarket = null;
let modelEgressFetch = null;
let browserControl;

function syncContext(context) {
  Object.assign(context, {
    identity, mcpAgentBridge, mcpSwitch, identityBootFailure, canvasBundle, agentBundle, skillBundle,
    mediaBundle, automationBundle, platformBundle, developerBundle, pluginBundle, marketBundle,
    marketUpdateBundle, appPackageResolver, thirdPartyRegistry, thirdPartyMarket, modelEgressFetch, browserControl,
  });
}

function collectSupervisedProcesses(identityRef) {
  try {
    const supervisor = identityRef && identityRef.supervisor;
    const rows = supervisor && typeof supervisor.snapshot === "function" ? supervisor.snapshot() : null;
    return Array.isArray(rows) ? rows.slice(0, 100).map((row) => ({
      source: "runtime-supervisor",
      instanceId: row && row.instanceId != null ? String(row.instanceId) : null,
      status: row && row.status != null ? String(row.status) : null,
      startedAt: row && Number.isFinite(row.startedAt) ? row.startedAt : null,
      endedAt: row && Number.isFinite(row.endedAt) ? row.endedAt : null,
      exitCode: row && Number.isFinite(row.exitCode) ? row.exitCode : null,
      signal: row && row.signal != null ? String(row.signal) : null,
    })) : [];
  } catch { return []; }
}

function automationAdapterError(code, message, detail) {
  const error = new Error(String(message || code));
  error.name = "AutomationAdapterError";
  error.code = String(code);
  if (detail !== undefined) error.detail = detail;
  return error;
}

function createAutomationDeveloperAppsAdapter({ db, userDataDir, clock, runTool }) {
  const developerDomain = require("./developer-domain.cjs");
  const developerStore = createDeveloperStore({ db, dataRoot: path.join(userDataDir, "dxos"), clock });
  return developerDomain.createDeveloperAppActionAdapter({ store: developerStore, runTool, createError: automationAdapterError });
}

function createAutomationIntegrationsAdapter({ pluginBundle }) {
  if (!pluginBundle) return null;
  const registry = pluginBundle.registry && typeof pluginBundle.registry.get === "function" ? pluginBundle.registry : null;
  function requireEnabled(pluginId) {
    const plugin = registry ? registry.get(pluginId) : null;
    if (!plugin) throw automationAdapterError("INTEGRATION_NOT_ENABLED", "集成插件未登记：" + pluginId);
    if (!plugin.enabled) throw automationAdapterError("INTEGRATION_NOT_ENABLED", "集成插件「" + plugin.name + "」未启用（integration/plugins/enable，id=" + pluginId + "）");
    return plugin;
  }
  function requireOk(result, fallback) {
    if (!result || result.ok !== true) throw automationAdapterError((result && result.error) || "INTEGRATION_UNAVAILABLE", (result && (result.detail || result.error)) || fallback);
    return result.value !== undefined ? result.value : result;
  }
  return {
    async lingxingCacheSync(args) {
      requireEnabled("lingxing");
      const job = pluginBundle.lingxing.startLingxingCacheSync(args && args.days);
      return "领星缓存同步作业已启动：" + String(job && job.id ? job.id : "") + "（" + String(job && job.cacheDays ? job.cacheDays : "") + " 天）";
    },
    async ziniaoDownload(args) {
      requireEnabled("ziniao");
      const job = pluginBundle.ziniao.startZiniaoDownloadJob(Object.assign({}, args || {}));
      return "紫鸟下载作业已启动：" + String(job && job.id ? job.id : "") + "（店铺 " + String(job && Array.isArray(job.stores) ? job.stores.length : 0) + " 个）";
    },
    async dingtalkGroupNotify(channelId, message) {
      requireEnabled("dingtalk");
      const sent = await pluginBundle.dingtalk.send({ channelId: channelId, msg: { text: message && message.text } });
      if (!sent || sent.ok !== true) return { ok: false, error: (sent && sent.error) || "INTEGRATION_SEND_FAILED", detail: (sent && (sent.detail || sent.error)) || "钉钉群机器人发送失败" };
      const value = sent.value || {};
      return { ok: true, channel: value.channel || null };
    },
    async dingtalkPersonNotify(recipient, text) {
      requireEnabled("dingtalk");
      return requireOk(await pluginBundle.dingtalk.sendToUser({ userId: recipient, text: text }), "钉钉个人消息发送失败");
    },
  };
}

function createAutomationDesktopAdapter() {
  const apps = process.platform === "darwin"
    ? MAC_SYSTEM_APPS.filter((app) => { try { return fs.existsSync(app.path); } catch { return false; } })
    : [];
  const musicController = createSystemMusicController({ platform: process.platform });
  return createDesktopExecutor({ shell, apps, musicController });
}

function createAutomationToolCatalogAdapter() {
  return {
    runTool: (toolName, values, actor, options) => runCatalogTool(String(toolName), values && typeof values === "object" ? values : {}, actor, options && typeof options === "object" ? options : {}),
  };
}

function describeStartupFailure(error) {
  if (error && error.code === "SCHEMA_TOO_NEW") {
    return `本机身份库版本（schema ${error.found}）高于当前程序支持的版本（${error.supported}），这个构建打不开它。本机数据未被改动。`;
  }
  return `启动失败：${String((error && error.message) || error || "未知错误")}`;
}

async function bootRuntime(context) {
  browserControl = new BrowserControlAuthority({
    audit: (record) => {
      try {
        identity?.toolStore?.insertToolAudit?.({
          at: Date.now(), actorUserId: record.actorUserId || null, appId: record.appId || null, toolRef: record.toolRef || null,
          action: String(record.action || "").slice(0, 80), decision: record.decision == null ? null : String(record.decision).slice(0, 120),
          reasonCode: record.reasonCode == null ? null : String(record.reasonCode).slice(0, 120), requestId: null,
        });
      } catch { /* audit 失败不改变业务结果 */ }
    },
    log: () => {},
  });

  let runtime = null;
  try {
    const sessionTtl = resolveSessionTtlOverride({ env: process.env });
    for (const record of sessionTtl.records) console.log("[openarc] " + record.message);
    mcpSwitch = createMcpSwitch({ userDataDir: app.getPath("userData") });
    runtime = await createOpenArcRuntime({
      userDataDir: app.getPath("userData"),
      safeStorage,
      nativeImage,
      sessionTtlMs: sessionTtl.sessionTtlMs,
      sessionIdleMs: sessionTtl.sessionIdleMs,
      executorLauncher: createDefaultExecutorLauncher(),
      allowAdmin: process.env.OPENARC_IDENTITY_ADMIN === "1",
      serviceIdentity: process.env.OPENARC_SERVICE_IDENTITY || null,
      browserControl,
      mcpInvocationSwitch: mcpSwitch,
      // 全局 AI 工作文件夹：放在用户主目录下好找（可用 OPENARC_WORKSPACE_DIR 覆盖）。
      workspaceDir: require("./agent-workspace.cjs").defaultWorkspaceDir(),
    });
    identity = runtime.identity;
  } catch (error) {
    identityBootFailure = describeStartupFailure(error);
    console.error("[openarc] 身份服务启动失败：" + identityBootFailure);
  }

  if (process.env.OPENARC_E2E_OBSERVE === "1") {
    try { fs.writeFileSync(path.join(app.getPath("userData"), "openarc-e2e-boot.json"), JSON.stringify(runtime.snapshot())); } catch {}
  }
  syncContext(context);
}

function registerRuntimeDomains(context) {
  trusted = context.trusted;
  win = context.win;
  registerIdentityIpc({
    ipcMain,
    service: identity?.service,
    authorization: identity?.authorization,
    device: identity?.deviceService,
    resource: identity?.resourceService,
    resourceSearch: identity?.searchService,
    resourcePreview: identity?.previewService,
    governance: identity?.governanceService,
    projects: identity?.projectService,
    canvas: identity?.canvasService,
    picker: identity?.pickerService,
    model: identity?.modelService,
    sideEffect: identity?.sideEffectGateway ?? null,
    dialog,
    shell,
    BrowserWindow,
    resolveFile: (folderId, id) => {
      if (!context.files) return null;
      const hit = context.files.resolve(String(folderId || ""), String(id || ""));
      return hit ? { path: hit.path, name: hit.entry ? hit.entry.name : "" } : null;
    },
    isTrusted: trusted,
    bootError: identityBootFailure,
    send: (event) => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send("identity:event", event);
    },
    sendSideEffect: (event) => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send("sideeffect:event", event);
      if (event && event.type === "sideEffect/approvalRequested") { try { getAgentNotifier().approvalNeeded(event.request); } catch { /* 通知失败不影响审批 */ } }
    },
  });

  if (!mcpSwitch) mcpSwitch = createMcpSwitch({ userDataDir: app.getPath("userData") });
  const mcpAudit = (entry) => {
    const store = identity && identity.toolStore;
    if (!store || typeof store.insertToolAudit !== "function") return false;
    try {
      store.insertToolAudit({
        at: Date.now(),
        actorUserId: (identity.service && identity.service.snapshot && identity.service.snapshot.userId) || null,
        appId: "mcp-center",
        toolRef: "mcp.toolInvocation",
        action: entry && entry.action ? String(entry.action).slice(0, 80) : "mcp.toolInvocation.set",
        decision: entry && entry.decision ? String(entry.decision).slice(0, 120) : null,
        reasonCode: entry && entry.reasonCode ? String(entry.reasonCode).slice(0, 120) : null,
        requestId: (entry && entry.requestId) || null,
      });
      return true;
    } catch {
      return false;
    }
  };
  const resolveMcpTaskContext = ({ context: commandContext, taskId } = {}) => {
    if (!identity || !identity.taskStore || typeof identity.taskStore.taskById !== "function") return { ok: false, error: "MCP_TASK_CONTEXT_UNAVAILABLE" };
    const task = identity.taskStore.taskById(String(taskId || ""));
    if (!task) return { ok: false, error: "MCP_INVALID_INPUT", detail: "task-not-found" };
    const sessionRef = commandContext && commandContext.sessionRef;
    const session = identity.store && typeof identity.store.validateSession === "function" ? identity.store.validateSession(sessionRef, { sensitive: false }) : null;
    if (!session || session.ok !== true) return { ok: false, error: "MCP_UNAUTHORIZED", detail: "no-session" };
    const sessionUserId = session.user && session.user.id != null ? session.user.id : null;
    if (!sessionUserId || String(sessionUserId) !== String(task.user_id)) return { ok: false, error: "MCP_UNAUTHORIZED", detail: "task-not-owner" };
    return { ok: true, taskId: task.task_id, appId: task.app_id, stepId: null, runId: null };
  };
  registerMcpIpc({
    ipcMain,
    service: identity?.mcpService ?? null,
    identity: identity?.service ?? null,
    isTrusted: trusted,
    agentTools: () => (mcpAgentBridge ? mcpAgentBridge.mcpAgentTools : null),
    mcpServersSnapshot: () => (mcpAgentBridge ? mcpAgentBridge.mcpServersSnapshot() : []),
    toolInvocationEnabled: () => mcpSwitch.isToolInvocationEnabled(),
    toolInvocationSwitch: () => mcpSwitch,
    audit: mcpAudit,
    resolveTaskContext: resolveMcpTaskContext,
    toolInvocation: () => (mcpAgentBridge && mcpAgentBridge.mcpAgentTools ? {
      callByName: (fname, args, options) => mcpAgentBridge.mcpAgentTools.callByName(fname, args, options),
      callDirect: (serverId, toolName, args, options) => mcpAgentBridge.mcpAgentTools.callDirect(serverId, toolName, args, options),
    } : null),
  });

  if (identity) {
    wireModelEvents({
      service: identity.modelService,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("model:event", event); },
    });

    try {
      modelEgressFetch = createEgressFetch({
        getConfig: () => identity.modelService.readEgressProxy(),
        baseFetch: typeof fetch === "function" ? fetch.bind(globalThis) : null,
        logger: null,
      });
      identity.modelService.fetchImpl = modelEgressFetch;
      const providerProtocolService = identity.modelService.providerProtocol && identity.modelService.providerProtocol.service
        ? identity.modelService.providerProtocol.service
        : null;
      if (providerProtocolService) providerProtocolService.fetchImpl = modelEgressFetch;
      console.log("[openarc] 模型出网代理已装配（" + JSON.stringify(modelEgressFetch.describe()) + "），仅作用于模型/协议出口");
    } catch (error) {
      modelEgressFetch = null;
      console.error("[openarc] 模型出网代理装配失败，模型出口保持直连：" + String((error && error.message) || error));
    }

    canvasBundle = { service: identity.canvasDocService };
    const uploadConsent = createUploadConsentService({ identityStore: identity.store, authorization: identity.authorization });
    const litterboxUploader = createLitterboxUploader({ fetchImpl: createGuardedFetch(typeof fetch === "function" ? fetch : null), retention: "24h", maxBytes: 200 * 1024 * 1024 });
    const canvasAssetPublicUrl = createAssetPublicUrl(identity.canvasDocService, {
      authorize: (context) => uploadConsent.assertAllowed(context),
      uploader: (context, input) => uploadConsent.authorizedUpload(context, input, litterboxUploader),
    });
    const canvasImportRemote = createImportRemote(identity.canvasDocService, {
      downloadImpl: (url, options) => {
        const proxyEnabled = modelEgressFetch && typeof modelEgressFetch.describe === "function" && modelEgressFetch.describe().enabled === true;
        return downloadProtocolArtifact(url, { ...options, fetchImpl: proxyEnabled ? createGuardedFetch(modelEgressFetch) : undefined });
      },
    });
    registerUploadConsentIpc({ ipcMain, service: uploadConsent, identity: identity.service, isTrusted: trusted });
    registerCanvasIpc({ ipcMain, service: identity.canvasDocService, identity: identity.service, isTrusted: trusted, extension: identity.canvasDxosExtension, assetPublicUrl: canvasAssetPublicUrl, importRemote: canvasImportRemote });

    chatTaskRunner = registerTaskIpc({
      ipcMain,
      taskService: identity.taskService,
      orchestrator: identity.orchestrator,
      identity: identity.service,
      canvasService: identity.canvasDocService,
      isTrusted: trusted,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("task:event", event); },
      onResult: (r) => { try { getAgentNotifier().taskFinished(r); } catch { /* 通知失败不影响结果 */ } },
    });

    let dxosFsAdapter = null;
    try {
      dxosFsAdapter = createDxosFsAdapterForUserData(app.getPath("userData"));
    } catch (error) {
      console.warn("[openarc] DX 虚拟文件树装配失败，文件工具将保持结构化依赖缺失：" + ((error && error.message) || error));
    }
    try {
      if (identity.canvasAssetLibrary && typeof identity.canvasAssetLibrary.configureFs === "function") {
        identity.canvasAssetLibrary.configureFs(dxosFsAdapter ? dxosFsAdapter.store : null);
      }
    } catch (error) {
      console.warn("[openarc] 画布素材库文件节点同步未接上 DX 虚拟文件树：" + ((error && error.message) || error));
    }

    const providerProtocol = identity.modelService && identity.modelService.providerProtocol ? identity.modelService.providerProtocol : null;
    const providerAdapter = providerProtocol && providerProtocol.store && providerProtocol.service
      ? createProviderAdapter({ store: providerProtocol.store, service: providerProtocol.service })
      : null;
    const skillModelAdapter = providerProtocol && providerProtocol.service
      ? { call: (input) => providerProtocol.service.call(input || {}) }
      : null;
    skillBundle = createSkillBundle({
      userDataDir: app.getPath("userData"),
      identityStore: identity.store,
      authorization: identity.authorization,
      providerAdapter: providerAdapter,
      modelAdapter: skillModelAdapter,
      cliRuntime: null,
      mediaAdapter: null,
      fsAdapter: dxosFsAdapter,
      logger: null,
      clock: null,
    });
    // 全局 AI 第 2 期：技能中心接给全局 AI（只读：列出 / 读取已启用技能；首轮提示带技能目录）。
    try {
      const { createSkillCatalog, createSkillCatalogProvider } = require("./agent-skill-catalog.cjs");
      const skillCatalog = createSkillCatalog({ listSkills: () => require("./skill-store.cjs").listSkills() });
      if (identity.adapters && identity.adapters.providers && typeof identity.adapters.providers === "object") {
        identity.adapters.providers.SkillCatalog = createSkillCatalogProvider({ catalog: skillCatalog });
      }
      if (identity.orchestrator && typeof identity.orchestrator.setSkillCatalog === "function") {
        identity.orchestrator.setSkillCatalog((userId) => skillCatalog.promptCatalog({ userId }));
      }
    } catch (error) {
      console.warn("[openarc] 技能目录未接上全局 AI：" + ((error && error.message) || error));
    }
    registerSkillIpc({
      ipcMain,
      bundle: skillBundle,
      identity: identity.service,
      isTrusted: trusted,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("skill:event", event); },
    });

    const mcpWiringLog = (event, detail) => { try { console.warn("[openarc] " + String(event) + " " + JSON.stringify(detail)); } catch { /* 日志失败不影响主流程 */ } };
    const mcpConnectionsPort = identity.mcpService
      ? constructOrDegrade("MCP connections 端口", () => createMcpConnectionsPort({
          mcpService: identity.mcpService,
          mcpStore: identity.mcpStore || null,
          context: () => ({ sessionRef: (identity.service && identity.service.current) || null, appId: "mcp-center" }),
          logger: mcpWiringLog,
        }), mcpWiringLog).value
      : null;
    const developerEnabledStore = identity.store
      ? constructOrDegrade("developer 启用态存储", () => createDeveloperStore({ db: identity.store.connection }), mcpWiringLog).value
      : null;
    const mcpAppState = {
      isEnabled: (appId) => {
        const snap = identity.service && identity.service.snapshot;
        const userId = snap && snap.userId != null ? String(snap.userId) : null;
        if (!userId || !developerEnabledStore) return false;
        try { return !!developerEnabledStore.getInstalled(userId, String(appId)); } catch { return false; }
      },
    };
    const appManagedMcpRegistry = mcpConnectionsPort
      ? constructOrDegrade("App 托管 MCP 注册表", () => createAppManagedMcpRegistry({
          connections: mcpConnectionsPort,
          appState: mcpAppState,
          logger: mcpWiringLog,
        }), mcpWiringLog).value
      : null;
    const mcpLiveTransport = createMcpLiveTransport({ mcpService: identity.mcpService, switchPort: mcpSwitch });
    const mcpSideEffectProvider = createMcpSideEffectProvider({ transport: mcpLiveTransport, registry: identity.toolRegistry || null });
    if (identity.adapters && identity.adapters.providers && typeof identity.adapters.providers === "object") {
      identity.adapters.providers.McpExternal = mcpSideEffectProvider;
    }
    const dxTaskApprovalBridge = identity.store && identity.taskStore
      ? createDxTaskApprovalBridge({
          identity: identity.store,
          taskStore: identity.taskStore,
          dxTaskStore: require("./agent-task-store.cjs"),
          authService: identity.authorization,
          appId: "mcp-center",
          context: () => ({ sessionRef: (identity.service && identity.service.current) || null, appId: "mcp-center" }),
        })
      : null;
    const mcpApprovalPort = identity.sideEffectRuntime && dxTaskApprovalBridge
      ? createDxBridgedApprovalPort({ bridge: dxTaskApprovalBridge, runtime: identity.sideEffectRuntime, toolIdFor: mcpToolIdFor, toolVersionFor: () => MCP_TOOL_VERSION })
      : null;
    mcpAgentBridge = identity.mcpService
      ? createMcpAgentBridge({
          mcpService: identity.mcpService,
          context: () => ({ sessionRef: (identity.service && identity.service.current) || null, appId: "mcp-center" }),
          switch: mcpSwitch,
          registry: identity.toolRegistry || null,
          connections: mcpConnectionsPort,
          appRegistry: appManagedMcpRegistry,
          transport: mcpLiveTransport,
          approval: mcpApprovalPort,
        })
      : null;
    // 全局 AI：打开了「允许 AI 调用 MCP 工具」时，每轮把已连接服务器的 MCP 工具交给 AI（一律先审批再执行）。
    if (mcpAgentBridge && identity.orchestrator && typeof identity.orchestrator.setDynamicWriteTools === "function") {
      identity.orchestrator.setDynamicWriteTools(() => {
        if (!mcpSwitch || typeof mcpSwitch.isToolInvocationEnabled !== "function" || mcpSwitch.isToolInvocationEnabled() !== true) return [];
        const snap = mcpAgentBridge.snapshot();
        if (!snap || snap.ok !== true) return [];
        const report = mcpAgentBridge.toolContractReport();
        return report && Array.isArray(report.toolIds) ? report.toolIds : [];
      });
    }
    agentBundle = createAgentBundle({
      identityStore: identity.store,
      authorization: identity.authorization,
      authStore: identity.authStore,
      modelService: identity.modelService,
      providerAdapter: providerAdapter,
      userDataDir: app.getPath("userData"),
      logger: null,
      clock: null,
      dbPath: path.join(app.getPath("userData"), "identity.db"),
      skillSource: skillBundle ? skillBundle.skillSource : null,
      mcpAgentTools: mcpAgentBridge ? mcpAgentBridge.mcpAgentTools : null,
      mcpServersSnapshot: mcpAgentBridge ? mcpAgentBridge.mcpServersSnapshot : null,
      canvasExtension: identity.canvasDxosExtension || null,
      fsAdapter: dxosFsAdapter,
    });
    registerAgentIpc({
      ipcMain,
      bundle: agentBundle,
      identity: identity.service,
      isTrusted: trusted,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("agent:event", event); },
    });

    const mediaFetchImpl = createGuardedFetch(typeof fetch === "function" ? fetch : null);
    const mediaProviderStore = createMediaProviderStore({ providerProtocol: providerProtocol, providerAdapter: providerAdapter });
    const mediaModelGateway = createMediaModelGateway({
      providerProtocol: providerProtocol,
      mediaDir: path.join(app.getPath("userData"), "dxos", "media"),
    });
    const mediaOnnxProbe = probeOnnxAvailability({ modelDir: path.join(app.getPath("userData"), "dxos", "media", "background-removal") });
    const mediaResourceRegistrar = createMediaResourceRegistrar({
      resourceService: identity.resourceService || null,
      resourceStore: identity.resourceStore || null,
      identity: identity.store || null,
      tempDir: path.join(app.getPath("userData"), "dxos", "media", "tmp"),
      clock: () => Date.now(),
    });
    mediaBundle = createMediaBundle({
      userDataDir: app.getPath("userData"),
      identityStore: identity.store,
      authorization: identity.authorization,
      logger: null,
      clock: null,
      fsAdapter: dxosFsAdapter,
      fetchImpl: mediaFetchImpl,
      providerStore: mediaProviderStore,
      modelGateway: mediaModelGateway,
      modelDir: mediaOnnxProbe.modelDir,
      modelPath: mediaOnnxProbe.modelPath,
      onnxRuntime: mediaOnnxProbe.runtime,
      illustratorAvailable: probeIllustratorAvailability(),
      viteBuild: null,
      publicMediaUploader: (input) => uploadConsent.authorizedUpload({ sessionRef: identity.service.current, appId: "ai" }, input, litterboxUploader),
      resourceRegistrar: mediaResourceRegistrar,
      revealExport: (absolutePath) => {
        try { shell.showItemInFolder(String(absolutePath)); return true; } catch { return false; }
      },
    });
    registerMediaIpc({
      ipcMain,
      bundle: mediaBundle,
      identity: identity.service,
      isTrusted: trusted,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("media:event", event); },
    });
    const calendarBundle = createCalendarBundle({ identityStore: identity.store, authorization: identity.authorization });
    registerCalendarIpc({ ipcMain, bundle: calendarBundle, identity: identity.service, isTrusted: trusted });

    platformBundle = createPlatformBundle({
      userDataDir: app.getPath("userData"),
      identityStore: identity.store,
      authorization: identity.authorization,
      appVersion: app.getVersion(),
      appName: "OpenArc OS",
      environment: { locale: app.getLocale(), build: null },
      processes: () => collectSupervisedProcesses(identity),
      fsStore: dxosFsAdapter ? dxosFsAdapter.store : null,
      clock: null,
      logger: null,
    });
    try { platformBundle.startProcessMonitor("main"); } catch { /* 诊断落盘失败不阻断启动 */ }
    registerPlatformIpc({
      ipcMain,
      bundle: platformBundle,
      identity: identity.service,
      isTrusted: trusted,
    });

    const userData = app.getPath("userData");
    const developerMigrationFs = dxosFsAdapter ? dxosFsAdapter.store : null;
    const developerMigrationSnapshotRoot = path.join(userData, "dxos", "developer-apps", "migrations");
    const developerRealtimeAuthorize = ({ userId } = {}) => {
      const sessionRef = identity.service ? identity.service.current : null;
      if (!sessionRef) return { ok: false, error: "UNAUTHORIZED", detail: "no-session" };
      const session = identity.store && typeof identity.store.validateSession === "function" ? identity.store.validateSession(sessionRef, { sensitive: false }) : null;
      if (!session || session.ok !== true) return { ok: false, error: "UNAUTHORIZED", detail: "invalid-session" };
      const sessionUserId = session.user && session.user.id != null ? session.user.id : null;
      if (!sessionUserId || (userId && String(userId) !== String(sessionUserId))) return { ok: false, error: "FORBIDDEN", detail: "user-mismatch" };
      return { ok: true };
    };
    const developerExtensionState = { lab: "missing", collab: "missing", migrations: "missing", realtime: "missing" };
    const developerExtensionNotes = [];
    const noteSlice = (slice, status, error) => {
      developerExtensionState[slice] = status;
      const detail = String((error && error.message) || error);
      developerExtensionNotes.push(slice + "(" + status + "): " + detail);
      console.warn("[openarc] 开发者扩展切片装配失败（" + slice + "）：" + detail);
    };
    let developerLab = null;
    try { developerLab = new DeveloperLab({ rootDir: path.join(userData, "dxos", "developer-lab") }); developerExtensionState.lab = "ok"; }
    catch (error) { developerLab = null; noteSlice("lab", "degraded", error); }
    let developerCollab = null;
    try { developerCollab = new DeveloperCollabProjects({ identity: identity.store, store: identity.integrationStore, authService: identity.authorization }); developerExtensionState.collab = "ok"; }
    catch (error) { developerCollab = null; noteSlice("collab", "missing", error); }
    let developerMigrationStore = null;
    try {
      developerMigrationStore = new DeveloperMigrationSnapshotStore({ snapshotRoot: developerMigrationSnapshotRoot });
      developerExtensionState.migrations = developerMigrationFs ? "ok" : "degraded";
      if (!developerMigrationFs) developerExtensionNotes.push("migrations(degraded): 缺少 B6 虚拟文件树");
    } catch (error) { developerMigrationStore = null; noteSlice("migrations", "missing", error); }
    let developerRealtimeHub = null;
    try { developerRealtimeHub = new DeveloperRealtimeHub({ authorize: developerRealtimeAuthorize }); developerExtensionState.realtime = "ok"; }
    catch (error) { developerRealtimeHub = null; noteSlice("realtime", "missing", error); }
    let developerDomainExtensions = null;
    try {
      developerDomainExtensions = createDeveloperDomainExtensions({
        lab: developerLab,
        docsDir: null,
        collab: developerCollab,
        migrationStore: developerMigrationStore,
        migrationFs: developerMigrationFs,
        realtimeHub: developerRealtimeHub,
      });
    } catch (error) {
      developerDomainExtensions = null;
      for (const slice of Object.keys(developerExtensionState)) developerExtensionState[slice] = "missing";
      const detail = String((error && error.message) || error);
      developerExtensionNotes.push("assembly(missing): " + detail);
      console.warn("[openarc] 开发者扩展切片合流装配失败，developer:command 仅保留基座：" + detail);
    }
    developerBundle = createDeveloperBundle({
      userDataDir: userData,
      identityStore: identity.store,
      authorization: identity.authorization,
      authStore: identity.authStore,
      appMcpRegistry: appManagedMcpRegistry,
      systemVersion: app.getVersion(),
      migrationFs: developerMigrationFs,
      migrationSnapshotRoot: developerMigrationSnapshotRoot,
      clock: null,
      logger: null,
    });
    try { if (agentBundle && typeof agentBundle.configureDeveloperService === "function") agentBundle.configureDeveloperService(developerBundle); } catch { /* agent bundle 未就绪时保持结构化依赖缺失 */ }
    registerDeveloperIpc({
      ipcMain,
      bundle: developerBundle,
      domainExtensions: developerDomainExtensions,
      extensionStatus: { extensions: developerExtensionState, error: developerExtensionNotes.length ? developerExtensionNotes.join("; ") : null },
      identity: identity.service,
      isTrusted: trusted,
      hostAppId: "ai",
    });
    try {
      const canvasPluginStore = createDeveloperStore({
        db: identity.store ? identity.store.connection || identity.store.db || null : null,
        dataRoot: path.join(app.getPath("userData"), "dxos"),
        clock: () => Date.now(),
      });
      const canvasPluginHost = createCanvasPluginHost({
        developerStore: canvasPluginStore,
        developerService: developerBundle,
        dataRoot: path.join(app.getPath("userData"), "dxos"),
        clock: () => Date.now(),
      });
      if (identity.canvasDxosExtension && typeof identity.canvasDxosExtension.configurePlugins === "function") {
        identity.canvasDxosExtension.configurePlugins({ pluginHost: canvasPluginHost });
      }
    } catch (error) {
      console.warn("[openarc] 画布插件宿主装配失败，canvas/plugins/* 保持结构化不可用：" + ((error && error.message) || error));
    }
    try {
      const developerCatalogDomain = require("./developer-domain.cjs");
      const appCatalogStore = createDeveloperStore({
        db: identity.store ? identity.store.connection || identity.store.db || null : null,
        dataRoot: path.join(userData, "dxos"),
        clock: () => Date.now(),
      });
      const appCatalog = developerCatalogDomain.createDeveloperAppCatalogAdapter({ store: appCatalogStore });
      const attached = identity.localAccountService ? identity.localAccountService.attachAppCatalog(appCatalog) : false;
      if (!attached) console.warn("[openarc] 开发者 App 目录未接入本地账号服务（identity 未装配 localAccountService）");
    } catch (error) {
      console.warn("[openarc] 开发者 App 目录接入本地账号服务失败：" + String((error && error.message) || error));
    }

    pluginBundle = createPluginBundle({
      userDataDir: app.getPath("userData"),
      safeStorage,
      fetch: typeof fetch === "function" ? fetch.bind(globalThis) : null,
      logger: null,
      clock: null,
      mcpTransport: mcpLiveTransport,
    });
    registerIntegrationIpc({
      ipcMain,
      bundle: pluginBundle,
      identity: identity.service,
      isTrusted: trusted,
    });

    const automationToolCatalog = createAutomationToolCatalogAdapter();
    const automationDeveloperApps = createAutomationDeveloperAppsAdapter({
      db: identity.store ? identity.store.connection || identity.store.db || null : null,
      userDataDir: userData,
      clock: () => Date.now(),
      runTool: automationToolCatalog.runTool,
    });
    let automationIntegrationsNote = pluginBundle ? null : "plugin-service 未装配";
    let automationIntegrations = null;
    if (pluginBundle) {
      if (pluginBundle.automationAdapter) {
        automationIntegrations = pluginBundle.automationAdapter;
      } else {
        automationIntegrations = createAutomationIntegrationsAdapter({ pluginBundle });
        automationIntegrationsNote = "plugin-service 未导出 automationAdapter，integrations 已回落旧适配器（缺 ziniao_data_sync 与建 job 前健康闸门）";
        try { console.warn("[openarc] " + automationIntegrationsNote); } catch { /* 日志失败不改装配结果 */ }
      }
    }
    let automationDesktop = null;
    let automationDesktopNote = null;
    try {
      automationDesktop = createAutomationDesktopAdapter();
    } catch (error) {
      automationDesktopNote = "桌面执行端装配失败：" + String((error && error.message) || error);
      try { console.warn("[openarc] " + automationDesktopNote); } catch { /* 日志失败不改装配结果 */ }
    }
    automationBundle = createAutomationBundle({
      identityStore: identity.store,
      authorization: identity.authorization,
      localAccounts: identity.localAccountService
        ? { findUser: (userId) => { const res = identity.localAccountService.listAuthUsers(); const items = res && res.ok && Array.isArray(res.items) ? res.items : []; return items.find((user) => user.id === userId) || null; } }
        : null,
      developerApps: automationDeveloperApps,
      integrations: automationIntegrations,
      desktop: automationDesktop,
      agent: agentBundle && typeof agentBundle.runInstruction === "function"
        ? { runInstruction: (instruction, options) => agentBundle.runInstruction(instruction, options) }
        : null,
      chatTask: chatTaskRunner ? createChatTaskAutomationAdapter() : null,
      toolCatalog: automationToolCatalog,
      adapterNotes: {
        desktop: automationDesktopNote,
        integrations: automationIntegrationsNote,
        agent: agentBundle ? null : "agent-service 未装配",
        chatTask: chatTaskRunner ? null : "全局 AI 对话任务未装配",
      },
      logger: null,
      clock: null,
    });
    registerAutomationIpc({
      ipcMain,
      bundle: automationBundle,
      identity: identity.service,
      isTrusted: trusted,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("automation:event", event); },
    });
    automationBundle.startScheduler();

    try {
      thirdPartyRegistry = createThirdPartyRegistry({ userDataDir: app.getPath("userData"), clock: null });
    } catch (error) {
      thirdPartyRegistry = null;
      console.warn("[openarc] 第三方应用注册表装配失败，market/thirdparty/* 保持结构化不可用：" + String((error && error.message) || error));
    }
    try {
      appPackageResolver = createAppPackageResolver({
        userDataDir: app.getPath("userData"),
        appDir: path.join(__dirname, ".."),
        isKnownApp: (value) => (thirdPartyRegistry && thirdPartyRegistry.has(value) ? String(value) : null),
      });
    } catch (error) {
      appPackageResolver = null;
      console.warn("[openarc] 通用应用包解析器装配失败，openarc-app:// 与安装后加载复核保持不可用：" + String((error && error.message) || error));
    }
    try {
      marketUpdateBundle = createMarketUpdateBundle({
        userDataDir: app.getPath("userData"),
        appDir: path.join(__dirname, ".."),
        authorization: identity.authorization,
        fetchImpl: typeof fetch === "function" ? fetch : null,
        packageResolver: appPackageResolver,
        isKnownApp: (value) => (thirdPartyRegistry && thirdPartyRegistry.has(value) ? String(value) : null),
        extraAppIds: thirdPartyRegistry ? thirdPartyRegistry.ids() : [],
        logger: null,
        clock: null,
      });
    } catch (error) {
      marketUpdateBundle = null;
      console.error("[openarc] 画布在线更新服务装配失败，market/update/* 回 MARKET_UPDATE_NOT_READY：" + String((error && error.message) || error));
    }
    try {
      thirdPartyMarket = createThirdPartyMarket({
        userDataDir: app.getPath("userData"),
        appDir: path.join(__dirname, ".."),
        updateService: marketUpdateBundle,
        registry: thirdPartyRegistry,
        fetchImpl: typeof fetch === "function" ? fetch : null,
        authorization: identity.authorization,
        systemVersion: app.getVersion(),
        clock: null,
      });
    } catch (error) {
      thirdPartyMarket = null;
      console.warn("[openarc] 第三方应用市场装配失败，market/thirdparty/* 保持结构化不可用：" + String((error && error.message) || error));
    }
    marketBundle = createMarketBundle({
      userDataDir: app.getPath("userData"),
      appDir: path.join(__dirname, ".."),
      logger: null,
      clock: null,
      updateService: marketUpdateBundle,
      thirdPartyService: thirdPartyMarket,
    });
    registerMarketIpc({
      ipcMain,
      bundle: marketBundle,
      identity: identity.service,
      isTrusted: trusted,
    });

    /** 单域失败仍注册降级通道，不把整个启动链拖死。 */
    const registerDomainOrDegrade = (label, register) => {
      try {
        register(false);
      } catch (error) {
        console.error("[openarc] " + label + " 域装配/注册失败，降级为未装配：" + String((error && error.message) || error));
        try { register(true); } catch (error2) {
          console.error("[openarc] " + label + " 域降级注册也失败，保持既有启动链：" + String((error2 && error2.message) || error2));
        }
      }
    };

    registerDomainOrDegrade("systemFonts", (degraded) => {
      registerSystemFontsIpc(ipcMain, {
        bundle: degraded ? null : createSystemFontsBundle({}),
        isTrusted: trusted,
        identity: identity.service,
        hostAppId: "ai",
        send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("systemFonts:event", event); },
      });
    });

    registerDomainOrDegrade("ocr", (degraded) => {
      registerOcrIpc({
        ipcMain,
        bundle: degraded ? null : createOcrBundle({
          providerStore: providerProtocol ? providerProtocol.store : null,
          fetchImpl: typeof fetch === "function" ? fetch : null,
          authorization: identity.authorization,
        }),
        isTrusted: trusted,
        identity: identity.service,
        send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("ocr:event", event); },
      });
    });

    registerDomainOrDegrade("fileTransfer", (degraded) => {
      registerFileTransferIpc(ipcMain, {
        bundle: degraded ? null : createFileTransferBundle({ userDataDir: app.getPath("userData"), authorization: identity.authorization }),
        identity: identity.service,
        isTrusted: trusted,
        hostAppId: "file-transfer",
      });
    });

    registerDomainOrDegrade("codexCanvas", (degraded) => {
      const domain = degraded ? null : createCodexCanvasDomain({ identity: identity.service, canvasService: identity.canvasDocService });
      registerCodexCanvasIpc({
        ipcMain,
        domain,
        isTrusted: trusted,
        identity: identity.service,
        send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("codexCanvas:event", event); },
      });
    });

    registerDomainOrDegrade("localProxy", (degraded) => {
      let service = null;
      if (!degraded) {
        const cacheService = createDesktopCacheService({ userDataDir: app.getPath("userData") });
        const updateService = createDesktopUpdateService({
          userDataDir: app.getPath("userData"),
          currentVersion: app.getVersion(),
          fetchImpl: typeof fetch === "function" ? fetch : null,
        });
        const lanService = createLanCollabService({
          canvasService: identity.canvasDocService || null,
          assetLibrary: identity.canvasAssetLibrary || null,
          authorization: identity.authorization,
        });
        app.once("before-quit", () => { try { lanService.dispose(); } catch { /* 已关闭 */ } });
        service = createLocalProxyService({
          userDataDir: app.getPath("userData"),
          safeStorage,
          cacheService,
          updateService,
          lanService,
          applyProxy: async ({ url, enabled }) => {
            try {
              const target = session && session.defaultSession ? session.defaultSession : null;
              if (!target || typeof target.setProxy !== "function") {
                return { applied: false, scope: "electron-session", note: "当前 Electron 运行时不支持 session.setProxy" };
              }
              await target.setProxy(enabled && url ? { proxyRules: url, proxyBypassRules: "<local>" } : { mode: "direct" });
              return { applied: true, scope: "electron-session", note: "已应用到 Electron 网络栈（模型域走 model/proxy/set）" };
            } catch (error) {
              return { applied: false, scope: "electron-session", note: "应用代理失败：" + String((error && error.message) || error).slice(0, 120) };
            }
          },
        });
        service.applyPersistedProxy().catch((error) => {
          console.warn("[openarc] 已保存的手动代理未能应用：" + String((error && error.message) || error));
        });
      }
      registerLocalProxyIpc({
        ipcMain,
        service,
        isTrusted: trusted,
        identity: identity.service,
        appId: "ai",
      });
    });

    let photocraftBundle = null;
    const canvasExchange = createCanvasExchangePorts({
      canvasService: identity.canvasDocService || null,
      assetLibrary: identity.canvasAssetLibrary || null,
      resourceService: identity.resourceService || null,
      resourceStore: identity.resourceStore || null,
      canvasDxosStore: identity.canvasDxosStore || null,
      fsStore: dxosFsAdapter,
      sessionRef: () => (identity.service && identity.service.current ? identity.service.current : null),
    });

    registerDomainOrDegrade("photos", (degraded) => {
      registerPhotosIpc(ipcMain, {
        bundle: degraded ? null : createPhotosBundle({
          userDataDir: app.getPath("userData"),
          authorization: identity.authorization,
          db: identity.store.connection,
          providerStore: providerProtocol ? providerProtocol.store : null,
          fsImpl: dxosFsAdapter,
          shareAccess: createPhotosShareAccess({
            canvasStore: identity.canvasDocService && identity.canvasDocService.store ? identity.canvasDocService.store : null,
            assetLibraryStore: identity.canvasDxosStore || null,
          }),
          videoPoster: null,
          importer: canvasExchange.importer,
          sharpLoader: null,
          fetchImpl: typeof fetch === "function" ? fetch : null,
        }),
        identity: identity.service,
        isTrusted: trusted,
        hostAppId: "photos",
      });
    });

    registerDomainOrDegrade("photocraft", (degraded) => {
      photocraftBundle = degraded ? null : createPhotocraftBundle({
        userDataDir: app.getPath("userData"),
        identity: identity.store,
        authorization: identity.authorization,
      });
      registerPhotocraftIpc(ipcMain, {
        bundle: photocraftBundle,
        identity: identity.service,
        isTrusted: trusted,
        hostAppId: "photocraft",
      });
    });

    registerDomainOrDegrade("appExchange", (degraded) => {
      const fsStore = dxosFsAdapter;
      const localAccount = identity.localAccountService || null;
      const canvasDoc = identity.canvasDocService || null;
      const canvasContext = () => ({
        sessionRef: identity.service && identity.service.current ? identity.service.current : null,
        appId: "app-exchange",
        source: "app-exchange",
      });
      const appExchangePorts = degraded ? null : {
        ...canvasExchange.ports,
        getNode: fsStore ? (id) => fsStore.getNode(id) : undefined,
        readBlob: fsStore ? (id) => fsStore.readBlob(id) : undefined,
        saveBlob: fsStore ? (id, bytes) => fsStore.saveBlob(id, bytes) : undefined,
        createNode: fsStore ? (input) => fsStore.createNode(input) : undefined,
        isInTrash: fsStore && fsStore.store ? (id) => fsStore.store.isInTrash(id) : undefined,
        purgeNode: fsStore && fsStore.store ? (id) => fsStore.store.purgeNode(id) : undefined,
        ensureCanvasRoot: fsStore && fsStore.store ? (ownerId) => fsStore.store.ensureCanvasRoot(ownerId) : undefined,
        ensureFolder: fsStore ? (name, parentId, ownerId) => fsStore.ensureFolder(name, parentId, ownerId) : undefined,
        canOpen: localAccount ? (viewer, appId) => localAccount.canOpenApp(viewer, appId) : undefined,
        createPhotoCraftProject: photocraftBundle && photocraftBundle.service
          ? (viewer, input) => photocraftBundle.service.createProject(String(viewer.id), { name: input.name, mime: input.mime, content: input.content })
          : undefined,
        canViewPhotoCraftFile: photocraftBundle && typeof photocraftBundle.canViewPhotoCraftFile === "function"
          ? (nodeId, viewer, projectId) => photocraftBundle.canViewPhotoCraftFile(nodeId, viewer && viewer.id, projectId)
          : undefined,
        listCanvases: canvasDoc ? () => {
          const view = canvasDoc.listCanvases({ context: canvasContext() });
          const items = view && view.ok === true && Array.isArray(view.items) ? view.items : [];
          return items
            .filter((item) => item && item.access && item.access.canEdit === true)
            .map((item) => ({ id: item.canvasId, title: item.title, access: "write" }));
        } : undefined,
        changed: (canvasId, patch) => {
          if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send("appExchange:event", { type: "changed", canvasId: canvasId == null ? null : String(canvasId), patch: patch == null ? null : patch, at: Date.now() });
          }
        },
      };
      registerAppExchangeIpc(ipcMain, {
        bundle: degraded ? null : createAppExchangeBundle({
          identity: identity.store,
          authorization: identity.authorization,
          ports: appExchangePorts,
          clock: null,
          logger: null,
        }),
        identity: identity.service,
        isTrusted: trusted,
        hostAppId: "app-exchange",
      });
    });

    registerDomainOrDegrade("cli", (degraded) => {
      registerCliIpc(ipcMain, {
        bundle: degraded ? null : createCliBundle({}),
        identity: identity.service,
        isTrusted: trusted,
        hostAppId: "cli",
      });
    });

    protocol.handle("openarc-resource", (request) => identity.previewService.handleProtocolRequest(request));
    // 全局 AI 对话：预览侧栏（网页 / http 文件 / 工作文件夹文件 / 生成的 HTML）与附件上传。
    const chatPreview = createChatPreview({
      getWorkspaceDir: () => (identity.agentWorkspace && identity.agentWorkspace.dir) || require("./agent-workspace.cjs").defaultWorkspaceDir(),
      getWebAccess: () => identity.webAccess || null,
    });
    protocol.handle(chatPreview.scheme, (request) => chatPreview.handle(request));
    registerChatIpc({
      ipcMain, preview: chatPreview, isTrusted: trusted, shell,
      prefs: getChatPrefs(),
      getUserId: () => { try { const s = identity.service && identity.service.snapshot; return (s && (typeof s === "function" ? s.call(identity.service) : s).userId) || null; } catch { return null; } },
      voice: createVoiceTranscriber({
        getStore: () => (identity.modelService && identity.modelService.providerProtocol && identity.modelService.providerProtocol.store) || null,
        getService: () => (identity.modelService && identity.modelService.providerProtocol && identity.modelService.providerProtocol.service) || null,
      }),
    });
    const canvasBundleResolver = createCanvasBundleResolver({
      userDataDir: app.getPath("userData"),
      logger: (record) => console.log("[openarc] canvas-bundle " + JSON.stringify(record)),
    });
    protocol.handle("openarc-canvas", (request) => canvasBundleResolver.handle(request));
    if (appPackageResolver) {
      protocol.handle("openarc-app", (request) => appPackageResolver.handle(request));
    }
  }
  syncContext(context);
}

module.exports = { bootRuntime, registerRuntimeDomains, describeStartupFailure };
