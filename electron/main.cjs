const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  screen,
  session,
  Menu,
  nativeImage,
  protocol,
  net,
  dialog,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const { safeURL } = require("./policy.cjs");
const geometry = require("./geometry.cjs");
const { NativeViewController } = require("./native-view-controller.cjs");
const { BrowserControlAuthority } = require("./browser-control-authority.cjs");
const { registerIdentityIpc, resolveSessionTtlOverride } = require("./identity-bootstrap.cjs");
// D5-02：无限画布的宿主命令面（文档层实例由 identity-bootstrap 装配，AI 工具用同一个）。
const { registerCanvasIpc } = require("./canvas-bootstrap.cjs");
const { registerTaskIpc } = require("./task-bootstrap.cjs");
// W5：模型流式下行事件（model:event）的宿主桥接（model:command 仍由 identity-bootstrap 注册）。
const { wireModelEvents } = require("./model-bootstrap.cjs");
// 模型/协议出口的可选代理（HTTP CONNECT 隧道；默认关闭）。
const { createEgressFetch } = require("./net-egress.cjs");
// B3：Agent 域装配（真实 SQLite = identity 的连接）与 agent:command / agent:event 通道。
// B6d：createDxosFsAdapterForUserData 把 <userData>/dxos/fs 装配成 B3/B4 共用的 fsAdapter。
const { createAgentBundle, createDxosFsAdapterForUserData } = require("./agent-service.cjs");
const { registerAgentIpc } = require("./agent-bootstrap.cjs");
// B4：技能域装配（<userData>/dxos 下的技能目录 / 技能包 / 执行器）与 skill:command / skill:event 通道。
const { createSkillBundle } = require("./skill-service.cjs");
const { registerSkillIpc } = require("./skill-bootstrap.cjs");
// B5a：媒体域装配（<userData>/dxos/media 下的渲染作业 / 探测 / 封面）与 media:command / media:event 通道。
const {
  createMediaBundle,
  // B5f：媒体域扩展依赖的真实装配件（复用既有模块 / B2 出口 / 依赖探测）。
  createMediaProviderStore,
  createMediaModelGateway,
  createGuardedFetch,
  probeIllustratorAvailability,
  probeOnnxAvailability,
} = require("./media-service.cjs");
const { registerMediaIpc } = require("./media-bootstrap.cjs");
// 公共媒体上传出口：临时图床协议 / 域名校验只在本文件，media 域通过注入的 uploader 调用。
const { createLitterboxUploader } = require("./media-litterbox.cjs");
const { createAssetPublicUrl, createImportRemote } = require("./canvas-asset-public-url.cjs");
// 媒体 → 资源库登记桥（短剧出图 / 成片导出共用；只经 resourceService.importManaged 入库）。
const { createMediaResourceRegistrar } = require("./media-resource-registrar.cjs");
// B6a：自动化域装配（定义 / 运行记录 / 主进程内调度器，无云依赖）与 automation:command / automation:event 通道。
const { createAutomationBundle } = require("./automation-service.cjs");
const { registerAutomationIpc } = require("./automation-bootstrap.cjs");
// B7j+：桌面执行端（music_play / music_control / open_app）：受控系统 API + 应用白名单。
const { createDesktopExecutor, createSystemMusicController, MAC_SYSTEM_APPS } = require("./desktop-executor.cjs");
// B6c：平台域装配（诊断 / 数据保护 / 网络安全 / 供应商测试安全）与 platform:command 通道。
const { createPlatformBundle } = require("./platform-service.cjs");
const { registerPlatformIpc } = require("./platform-bootstrap.cjs");
// B7a：开发者平台（本地 App 装载 / 启用 / 禁用 / 回滚 / 卸载 + 出网治理）与 developer:command 通道。
const { createDeveloperBundle } = require("./developer-service.cjs");
const { registerDeveloperIpc } = require("./developer-bootstrap.cjs");
// B7j：自动化域 developerApps 适配器读取的是 developer-service 的同一份本地装载态
// （app_market_releases / user_installed_apps + <userData>/dxos/developer-apps 包清单）。
const { createDeveloperStore } = require("./developer-store.cjs");
// 画布插件宿主（数据 / 受控网络）：依赖 developerBundle，装配后晚绑定到 canvas 扩展。
const { createCanvasPluginHost } = require("./canvas-dxos-plugins.cjs");
// B7j：自动化域 toolCatalog 适配器复用 agent 工具目录的唯一执行入口（与 agent 域同一套权限判定）。
const { runCatalogTool } = require("./agent-tool-catalog.cjs");
// B7f：B7b 四张命令切片（lab / collab / migrations / realtime）合流到唯一 developer:command。
//   DeveloperLab：草稿 / 示例工程 / 离线文档 / 图标；
//   DeveloperCollabProjects：协同项目（落既有 projects，owner 为当前会话用户）；
//   DeveloperMigrationSnapshotStore：声明式数据迁移快照（安装 / 升级 / 回滚用）；
//   DeveloperRealtimeHub：本机 / 局域网实时房间（缺 authorize 即结构化拒绝，不假连接）。
const { createDeveloperDomainExtensions, DeveloperLab } = require("./developer-lab.cjs");
const { DeveloperCollabProjects } = require("./developer-collab.cjs");
const { DeveloperMigrationSnapshotStore } = require("./developer-migrations.cjs");
const { DeveloperRealtimeHub } = require("./developer-realtime.cjs");
// B7c：可选插件框架（钉钉 / 天气 / 黄历，默认全关）与本地市场目录（只读本地清单，不联网）。
const { createPluginBundle } = require("./plugin-service.cjs");
const { createMarketBundle } = require("./market-service.cjs");
// Stage 1：无限画布在线更新（market/update/* 的真实执行端；走既有 market:command 通道）。
const { createMarketUpdateBundle } = require("./market-update-service.cjs");
const { createCanvasBundleResolver } = require("./canvas-package-resolver.cjs");
// task-19 A：全部已注册应用的已安装包解析 + 通用只读协议 openarc-app://<appId>/。
const { createAppPackageResolver } = require("./app-package-resolver.cjs");
// task-19 B：第三方应用目录（本地 + 在线源）/ 安装 / 回滚，安装后复用同一条包加载路径。
const { createThirdPartyRegistry, createThirdPartyMarket } = require("./market-third-party-service.cjs");
const { registerIntegrationIpc, registerMarketIpc } = require("./plugin-bootstrap.cjs");
// B4 · providerAdapter 桥：把 B2 的 provider-protocol store/service 投影成 B4 执行器要的只读适配器
// （firstUsable/all/autoFallback/revealProvider/call）；只读投影绝不返回 api_key/credentialRef。
const { createProviderAdapter } = require("./provider-adapter-bridge.cjs");
// D5-03：MCP 中心的宿主命令面（连接管理 + 能力发现；工具调用默认关闭，开启后仍需逐次审批）。
const { registerMcpIpc } = require("./mcp-bootstrap.cjs");
// B4 收口：把已装配的 MCP 连接目录（identity.mcpService）只读投影成 agent 工具目录的 mcp 来源。
const { createMcpAgentBridge } = require("./mcp-agent-bridge.cjs");
// Y4：既有 MCP 存储/服务之上的可写 connections 端口（供宿主侧 App 托管注册表读写既有记录）。
//   constructOrDegrade：可选项构造抛错 → null + 如实日志，不把主进程启动链拖死（见本块装配注释）。
const { createMcpConnectionsPort, constructOrDegrade } = require("./mcp-connections-port.cjs");
// Y4：宿主侧 App 托管 MCP 注册表（归属 + 连接生命周期；策略门不放宽）。
const { createAppManagedMcpRegistry } = require("./mcp-app-registry.cjs");
// B4e：MCP 工具调用显式开关（<userData>/dxos/mcp.json，默认关闭）。
const { createMcpSwitch } = require("./mcp-switch.cjs");
// B4e 收口：生产真实 tools/call 传输（McpService 的活连接）+ 任务内审批端口（ControlledToolProxy）。
const { createMcpLiveTransport } = require("./mcp-live-transport.cjs");
const { mcpToolIdFor, MCP_TOOL_VERSION } = require("./mcp-tool-contract.cjs");
// D5-04 补丁：DX 任务 → 核心审批任务的幂等身份映射桥（桥只映射身份，不复制审批状态机）。
const { createDxTaskApprovalBridge, createDxBridgedApprovalPort } = require("./dx-task-approval-bridge.cjs");
// D5-04：MCP 外部工具 → 既有 SideEffectAuthority 的 provider（plan / execute 两个方向）。
const { createMcpSideEffectProvider } = require("./mcp-side-effect-provider.cjs");
// D5-03 第十一批：关应用的唯一收尾顺序（MCP → Harness → modelProxy → store）。
const { disposeAppResources } = require("./app-shutdown.cjs");
const { createDefaultExecutorLauncher } = require("./executor-launcher.cjs");
const { createOpenArcRuntime } = require("./runtime-boot.cjs");
const { createFileService } = require("./file-service.cjs");
const { createWeatherService } = require("./weather-service.cjs");
const { createVideoService } = require("./video-service.cjs");
const { declareImage } = require("./xmp-service.cjs");
// 0.6.1 · 本轮新增五域（系统字体 / OCR / 文件传输 / codex-canvas / 本机代理探测）。
//   · bootstrap 只承担 trusted 边界 + 命令白名单；装配参数由本文件注入（与 media / platform 同一接线口径）。
//   · 字体 / OCR / 文件传输的 I/O 都在主进程内完成，渲染层只拿受控投影，绝不接触绝对路径或凭据。
//   · 与 canvas:command / platform:command 的并入诉求：两条既有通道的 RENDERER_COMMANDS /
//     PLATFORM_COMMANDS 都是冻结白名单，且在扩展分发之前拦截；不改那三个域实现无法并入，
//     因此本轮保留独立通道（理由见下方注册块注释）。
const { createSystemFontsBundle, registerSystemFontsIpc } = require("./system-fonts-bootstrap.cjs");
const { createOcrBundle } = require("./ocr-service.cjs");
const { registerOcrIpc } = require("./ocr-bootstrap.cjs");
const { createFileTransferBundle } = require("./file-transfer-service.cjs");
const { registerFileTransferIpc } = require("./file-transfer-bootstrap.cjs");
const { createCodexCanvasDomain, registerCodexCanvasIpc } = require("./codex-canvas-bootstrap.cjs");
const { createLocalProxyService } = require("./local-proxy-service.cjs");
const { registerLocalProxyIpc } = require("./local-proxy-bootstrap.cjs");
// task-22：设置页真实能力（缓存清理 / 系统更新检查，均挂 desktop:command）。
const { createDesktopCacheService } = require("./desktop-cache-service.cjs");
const { createDesktopUpdateService } = require("./desktop-update-service.cjs");
// task-8 A：局域网协作（opt-in；0.0.0.0 + 随机端口；配对码/令牌）。
const { createLanCollabService } = require("./lan-collab-service.cjs");
// task-21：窗口标签组命令批处理（复用既有 windows:sync 通道，不新增 preload 成员）。
const { applyWindowCommandBatch } = require("./window-command-ipc.cjs");
// 0.6.2 · 三个新域接线（photos / photocraft / app-exchange）：bootstrap 只承担 trusted 边界 + 命令白名单，
//   装配参数由本文件注入（与 0.6.1 五域同一接线口径）；命令表本身即白名单，未登记命令一律 *_COMMAND_NOT_ALLOWED。
const { createPhotosBundle } = require("./photos-service.cjs");
const { createPhotosShareAccess } = require("./photos-share-access.cjs");
const { registerPhotosIpc } = require("./photos-bootstrap.cjs");
const { createPhotocraftBundle } = require("./photocraft-service.cjs");
const { registerPhotocraftIpc } = require("./photocraft-bootstrap.cjs");
const { createAppExchangeBundle } = require("./app-exchange-service.cjs");
const { registerAppExchangeIpc } = require("./app-exchange-bootstrap.cjs");
// 0.6.3 · canvas × photos / app-exchange 端口适配层：把既有画布 / 资源 / fs / 授权能力
//   投影成 app-exchange 的 canvas target ports 与 photos 的 importer（双方都不改自身实现）。
const { createCanvasExchangePorts } = require("./canvas-exchange-ports.cjs");
// CLI 域（对齐 DX OS 0.6.1 的 /api/cli/*）：把既有 agent-cli-bridge / agent-cli-tools /
//   agent-pippit-tools 的探测与执行出口接成 cli:command，只转发不重写。
const { createCliBundle } = require("./cli-service.cjs");
const { registerCliIpc } = require("./cli-bootstrap.cjs");

let win;
let controller;
let identity;
let files;
// B4e：MCP → Agent 桥在 registerMcpIpc 之后才装配；先声明，聚合命令经 getter 晚绑定。
let mcpAgentBridge = null;
// B4e 收口：显式开关实例在 identity 创建**之前**建立并注入每个真实 McpClient（默认关闭）。
let mcpSwitch = null;
/** 身份服务创建失败时的人话原因；渲染层经 identity:command 的既有通道拿到它。 */
let identityBootFailure = null;
/** D5-02：画布文档服务（AI 编辑工具的执行端与渲染层命令共用同一个实例）。*/
let canvasBundle;
/** B3：Agent 域 bundle（createAgentBundle 的唯一实例；无身份服务时为 undefined）。 */
let agentBundle;
/** B4：技能域 bundle（createSkillBundle 的唯一实例；无身份服务时为 undefined）。 */
let skillBundle;
/** B5a：媒体域 bundle（createMediaBundle 的唯一实例；无身份服务时为 undefined）。 */
let mediaBundle;
/** B6a：自动化域 bundle（createAutomationBundle 的唯一实例；无身份服务时为 undefined）。 */
let automationBundle;
/** B6c：平台域 bundle（createPlatformBundle 的唯一实例；无身份服务时为 undefined）。 */
let platformBundle;
/** B7a：开发者平台 bundle（createDeveloperBundle 的唯一实例；无身份服务时为 undefined）。 */
let developerBundle;
/** B7c：可选插件 bundle（createPluginBundle 的唯一实例；无身份服务时为 undefined）。 */
let pluginBundle;
/** B7c：本地市场 bundle（createMarketBundle 的唯一实例）。 */
let marketBundle;
/** Stage 1：画布在线更新 bundle（market/update/* 的执行端；装配失败为 null → MARKET_UPDATE_NOT_READY）。 */
let marketUpdateBundle;
/** task-19 A：通用已安装包解析器（market install 的加载复核 + openarc-app:// 协议共用同一实例）。 */
let appPackageResolver = null;
/** task-19 B：第三方应用注册表 / 目录安装服务（market/thirdparty/*）。 */
let thirdPartyRegistry = null;
let thirdPartyMarket = null;
/** 模型/协议出口的**可选**代理 fetchImpl（只注入模型域；不写 globalThis，不影响其它出网）。 */
let modelEgressFetch = null;
/** D5-01 Closure-2：受控浏览器目标（用户显式授权）。宿主持有唯一实例，工具链与 UI 共用同一个。 */
let browserControl;

/**
 * 只读文件协议（Quick Look 的流式媒体源）。
 * 必须在 app ready **之前**登记为 privileged —— 否则 <video> 不能 seek/stream，
 * 大视频只能塞 data URL（内存爆）。它服务两个来源：
 *   openarc-file://media/<folderId>/<id>   路径解析走 file-service 的白名单
 *   openarc-file://native/<name>           只认下面 NATIVE_RESOURCES 里写死的逻辑名
 * 两个来源都拿不到任意路径。且只注册在默认 session：
 * 原生网页视图用的是独立 partition，**够不到这个协议**。
 */
// 真实启动路径：本模块在 app ready 之前被 require，注册一定生效。
// 安全探针等 harness 会在 ready 之后才 require 本模块，那时再调会抛错 —— 显式跳过，
// 探针本身不测这个协议（它测的是 preload 暴露面与 IPC 通道）。
if (!app.isReady()) {
  protocol.registerSchemesAsPrivileged([
    // corsEnabled：渲染层要把原生视频画进 canvas 再读像素（抠黑），不走 CORS 的话画布会被污染。
    { scheme: "openarc-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

/**
 * 外壳页地址。
 *
 * 只认显式给出的 `OA_DEV_SERVER`：设了才加载 Vite dev server（实时预览用），
 * 没设就是原来的构建产物 file:// 路径 —— 产品构建 / `npm run oa:app` 的行为逐字节不变。
 * 归一化成 URL.href（补尾斜杠），与 senderFrame.url / will-navigate 报的形态对齐。
 */
const devURL = process.env.OA_DEV_SERVER ? new URL(process.env.OA_DEV_SERVER).href : null;
const devOrigin = devURL ? new URL(devURL).origin : null;
/**
 * 外壳入口（10-15）：默认加载新壳层 dist/vue.html（Vue，按 10-15 界面原型升级）；
 * 设 OA_UI=react 回到旧版 dist/index.html。导航白名单 / 可信发送方判定都只认这一个 uiURL，
 * 两个入口不会同时被信任。
 */
const UI_ENTRY = process.env.OA_UI === "react" ? "index.html" : "vue.html";
const uiURL = devURL || pathToFileURL(path.join(__dirname, "../dist/" + UI_ENTRY)).href;

if (devURL) console.log("[openarc] 开发预览：加载 " + devURL + "（OA_DEV_SERVER 已设置）");

// D3-04C：安全预览自定义协议。**必须在 app ready 之前**注册 privileges。
// Renderer 只能拿到 openarc-resource:// 短时 capability URL，绝不接触本地路径。
protocol.registerSchemesAsPrivileged([
  { scheme: "openarc-resource", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
  // D5-02：无限画布 bundle 的自定义协议（iframe 用；**只读**目录白名单，无目录穿越）。
  // corsEnabled：画布 iframe 是 opaque origin，字体等子资源必须能跨源取（静态只读 bundle）。
  { scheme: "openarc-canvas", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  // task-19 A：通用已安装应用包协议（只读；每次请求重新读 current.json，安装/回滚立即生效）。
  { scheme: "openarc-app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

/**
 * 本机原生资源白名单（逻辑名 → 绝对路径）。渲染进程只能报名字，报不出路径 ——
 * 任意路径读取仍然没有入口。Siri Blob 是 Apple 的版权素材，只在运行时从系统读取，
 * 不随仓库 / dist / 安装包分发。
 */
const NATIVE_RESOURCES = {
  "siri-blob": "/System/Library/PrivateFrameworks/SiriUI.framework/Versions/A/Resources/Siri Blob.mov",
};
const NATIVE_TYPES = { ".mov": "video/quicktime", ".mp4": "video/mp4", ".m4v": "video/x-m4v" };
const MEDIA_TYPES = { ...NATIVE_TYPES, ".webm": "video/webm", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac" };

/**
 * D5-02 / Stage 2 · 画布 bundle 的只读协议：实现整体在 canvas-package-resolver.cjs
 * （生效顺序：已安装版本 → dist/novai-canvas → public/novai-canvas）。
 */

/**
 * B6c：受监督子进程清单（只取 safe 记录，绝不带 executable path / pid / env）。
 * 数据来源只有 RuntimeSupervisor.snapshot()（runtime-supervisor.cjs:466 的 safe 投影）；
 * media runner / MCP stdio 等通道当前不暴露可枚举句柄 —— 那就返回空列表，绝不伪造条目。
 */
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

/** 只接受来自本应用外壳页的调用。
 * 双重条件（sender + senderFrame.url）在 D1-05 冻结，本阶段不放宽。
 */
function trusted(event) {
  if (event.sender !== win?.webContents) return false;
  const url = event.senderFrame?.url;
  if (url === uiURL) return true;
  // 开发预览：HMR 可能把文档地址带上 query/hash，按来源放行整棵同源页面。
  // devOrigin 只在 OA_DEV_SERVER 显式开启时才非空，所以产品路径上这段永远不成立。
  return devOrigin !== null && typeof url === "string" && url.startsWith(devOrigin + "/");
}

const isMac = process.platform === "darwin";
/**
 * 仅测试用的平台覆盖（截图 / 自动化验收）：在任意宿主上渲染指定平台的窗口 chrome。
 *
 * 只认 win32 / darwin 两个字面值，其它值一律忽略；不设置时等于真实平台，
 * 所以生产路径与改动前完全等价（tests/win-titlebar.test.mjs 锁住这一点）。
 * 它只决定**窗口 chrome 与上报的平台**；应用菜单的角色跟随真实 OS（那是系统级行为），
 * 玻璃材质也跟随真实 OS（mica 只有 Windows 有）。
 */
const FORCED_PLATFORM =
  process.env.OA_FORCE_PLATFORM === "win32" || process.env.OA_FORCE_PLATFORM === "darwin"
    ? process.env.OA_FORCE_PLATFORM
    : "";
const uiPlatform = FORCED_PLATFORM || process.platform;
const isMacChrome = uiPlatform === "darwin";
if (FORCED_PLATFORM)
  console.warn("[openarc] OA_FORCE_PLATFORM=" + FORCED_PLATFORM + "（仅测试用平台覆盖；真实平台 " + process.platform + "）");
const glass = isMac
  ? { transparent: true, vibrancy: "under-window", backgroundColor: "#00000000" }
  : { backgroundMaterial: "mica", backgroundColor: "#00000000" };

/**
 * 应用菜单。Electron 默认菜单带 Reload / Toggle Developer Tools，属开发项、不属于产品；
 * 这里换成最小产品菜单（必须保留 editMenu 角色，否则 macOS 上复制粘贴快捷键失效）。
 * 开发期（electron . 未打包）额外挂 Developer 子菜单，打包后不出现。
 */
function installApplicationMenu() {
  const template = [
    isMac ? { role: "appMenu" } : { role: "fileMenu" },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
  if (!app.isPackaged) {
    template.push({
      label: "Developer",
      submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }],
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 启动失败 → 渲染层文案。
 *
 * schema 高于支持版本是**明确的、用户能理解的故障**：不迁移、不降级、不重置，
 * 只如实说明。其它失败原因照抄异常文本（它是主进程自己抛的，不含用户数据）。
 */
function describeStartupFailure(error) {
  if (error && error.code === "SCHEMA_TOO_NEW")
    return `本机身份库版本（schema ${error.found}）高于当前程序支持的版本（${error.supported}），这个构建打不开它。本机数据未被改动。`;
  return `启动失败：${String((error && error.message) || error || "未知错误")}`;
}

/**
 * 启动链兜底：`app.whenReady()` 回调里任何抛出都会变成未处理的 rejection，
 * 窗口就停在「已打开、页面没加载」的空白态。这里保证界面照常加载，
 * 并把原因登记到身份命令通道 —— 渲染层因此走的是**已有的** BootRetry 界面。
 */
function recoverFromStartupFailure(error) {
  identityBootFailure = describeStartupFailure(error);
  console.error("[openarc] 启动失败：" + identityBootFailure);
  try {
    ipcMain.removeHandler("identity:command");
  } catch {
    /* 尚未注册 */
  }
  registerIdentityIpc({ ipcMain, service: null, isTrusted: trusted, bootError: identityBootFailure });
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    const current = win.webContents.getURL();
    if (!current || current === "about:blank") win.loadURL(uiURL);
  }
}

/**
 * D5-01 Closure-2 · **产品就绪信号**（探针/门禁同步的唯一判据）。
 *
 * 就绪定义（本进程内的确定事实，不是时间猜测）：
 *   ① 外壳窗口已创建；② 全部 IPC handler 已注册；③ 外壳页已开始加载。
 * 探针原先"等 8 秒再找窗口"在 D4 runtime boot 变长后必然假失败 —— 那是仪器时序缺陷，
 * 不是产品缺陷；修法只能是把判据换成这个信号，绝不改成"等更久"。
 */
function markProductReady() {
  const state = {
    at: Date.now(),
    pid: process.pid,
    shellWindow: !!(win && !win.isDestroyed()),
    ipcRegistered: true,
    uiURL,
  };
  globalThis.__OPENARC_PRODUCT_READY__ = state;
  try { app.emit("openarc:product-ready", state); } catch { /* 没有监听者也要能启动 */ }
  return state;
}

// ---------------------------------------------------------------------------
// B7j · 自动化域适配器（只接线，不新增业务实现）
//   · developerApps ← developer-service 的本地装载态（同一 db + <userData>/dxos）；
//     B7x 起按已安装 App 的真实 capabilities.tools / capabilities.canvas 声明投影可执行动作
//     （canvas 只投影 agent-tool 执行器的 run 动作）；没有可用动作时 actions 为空，绝不伪造。
//   · integrations  ← plugin-service（钉钉 / 领星 / 紫鸟）；未启用 / 未注入 transport 时抛
//     INTEGRATION_*，由 automation-service 归一成结构化 AGENT_DEPENDENCY_UNAVAILABLE。
//   · toolCatalog   ← agent 工具目录的唯一执行入口（与 agent 域共用权限判定）。
//   · agent         ← agent-service.runInstruction（project agent mode 同一真值路径）。
//   · desktop       ← desktop-executor.cjs（受控系统 API + 应用白名单）；装配失败保留 null
//     并把可读原因写进 automation/health.dependencyDetails，绝不假装可用。
// ---------------------------------------------------------------------------

/** 适配器层的结构化错误；code 会被 automation-service 归一成依赖缺失码。 */
function automationAdapterError(code, message, detail) {
  const error = new Error(String(message || code));
  error.name = "AutomationAdapterError";
  error.code = String(code);
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** 自动化域 developerApps 适配器：只读 developer-store 的本地装载态，不做第二份数据。 */
function createAutomationDeveloperAppsAdapter({ db, userDataDir, clock, runTool }) {
  // B7x：投影规则（真实 capabilities.tools + capabilities.canvas）与适配器契约都在
  // developer-domain.cjs（store 注入），主进程只做接线，不在这里另造一套动作判定。
  const developerDomain = require("./developer-domain.cjs");
  const developerStore = createDeveloperStore({ db, dataRoot: path.join(userDataDir, "dxos"), clock });
  return developerDomain.createDeveloperAppActionAdapter({ store: developerStore, runTool, createError: automationAdapterError });
}

/** 自动化域 integrations 适配器：plugin-service 的真实集成实例。 */
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
      // 业务失败原样回传 { ok:false }，由 automation-service 记 AUTOMATION_UNAVAILABLE；
      // 依赖缺失（未启用 / 无凭据）在 requireEnabled / requireOk 处抛，归一成依赖缺失码。
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

/**
 * 自动化域 desktop 适配器：受控系统 API（shell.openPath / 固定 AppleScript）+ 应用白名单。
 *   · 白名单只收当前平台真实存在的系统应用（macOS 路径见 desktop-executor.cjs 的 MAC_SYSTEM_APPS）；
 *   · 音乐控制器只在 macOS 构造（固定脚本 + argv，不经 shell）；
 *   · 构造失败由调用方降级为 null + 可读原因（进 automation/health.dependencyDetails），不拖死启动链。
 */
function createAutomationDesktopAdapter() {
  const apps = process.platform === "darwin"
    ? MAC_SYSTEM_APPS.filter((app) => { try { return fs.existsSync(app.path); } catch { return false; } })
    : [];
  const musicController = createSystemMusicController({ platform: process.platform });
  return createDesktopExecutor({ shell, apps, musicController });
}

/** 自动化域 toolCatalog 适配器：复用 agent 工具目录的唯一执行入口。 */
function createAutomationToolCatalogAdapter() {
  return {
    runTool: (toolName, values, actor, options) => runCatalogTool(String(toolName), values && typeof values === "object" ? values : {}, actor, options && typeof options === "object" ? options : {}),
  };
}

app.whenReady().then(async () => {
  installApplicationMenu();
  // ---------------------------------------------------------------------------
  // D4-04 Closure-2 · 唯一 production runtime boot（与 D4-04 probe 共享同一 helper）。
  //
  // 永久规则：No Task admission before Model Proxy boot has been attempted
  // against the actual created identity runtime.
  // identity 必须先于 modelProxy.start() 创建；顺序错误一律 loud fail，绝不静默吞掉。
  // ---------------------------------------------------------------------------
  browserControl = new BrowserControlAuthority({
    // 审计进**同一张** authorization_audit：受控浏览器的授权/撤销与工具调用同源可查。
    audit: (r) => {
      try {
        identity?.toolStore?.insertToolAudit?.({
          at: Date.now(), actorUserId: r.actorUserId || null, appId: r.appId || null, toolRef: r.toolRef || null,
          action: String(r.action || "").slice(0, 80), decision: r.decision == null ? null : String(r.decision).slice(0, 120),
          reasonCode: r.reasonCode == null ? null : String(r.reasonCode).slice(0, 120), requestId: null,
        });
      } catch { /* audit 失败不改变业务结果 */ }
    },
    log: () => {},
  });

  // runtime 在 try 之外声明：下面的 OPENARC_E2E_OBSERVE 观测块要用 runtime.snapshot()，
  // 而"身份库打不开"是可恢复的启动失败（见 catch）—— 两条路径都得能引用到这个名字。
  let runtime = null;
  try {
    // 短有效期覆写：**双重开关**（OPENARC_ALLOW_SESSION_TTL_OVERRIDE=1 + 具体值）才生效。
    // 默认路径不读、不用这些变量；生效时打一条含生效值与原因的可见日志。
    const sessionTtl = resolveSessionTtlOverride({ env: process.env });
    for (const record of sessionTtl.records) console.log("[openarc] " + record.message);
    // B4e 收口：开关实例必须先于 identity 存在 —— 每个真实 McpClient 在构造时拿到同一个 gate。
    mcpSwitch = createMcpSwitch({ userDataDir: app.getPath("userData") });
    runtime = await createOpenArcRuntime({
      userDataDir: app.getPath("userData"),
      safeStorage,
      nativeImage,
      sessionTtlMs: sessionTtl.sessionTtlMs,
      sessionIdleMs: sessionTtl.sessionIdleMs,
      // production executor 由 Electron utilityProcess.fork 启动（Node-enabled child，
      // 不依赖 ELECTRON_RUN_AS_NODE / runAsNode fuse）；生命周期权威仍是 RuntimeSupervisor。
      executorLauncher: createDefaultExecutorLauncher(),
      // admin / 测试夹具命令默认关闭：产品 UI 里没有入口，也不该有。
      // 只有显式置 OPENARC_IDENTITY_ADMIN=1 才放行（探针与未来的管理端用）。
      allowAdmin: process.env.OPENARC_IDENTITY_ADMIN === "1",
      // Control Service 身份（§60）：未配置时配对会因 SERVICE_IDENTITY_MISMATCH 被拒 —— 失败关闭。
      serviceIdentity: process.env.OPENARC_SERVICE_IDENTITY || null,
      // D5-01 Closure-2：受控浏览器目标的唯一实例（审计进同一张 authorization_audit）。
      browserControl,
      // B4e 收口：MCP 工具调用显式开关（默认关闭；<userData>/dxos/mcp.json）。
      mcpInvocationSwitch: mcpSwitch,
    });
    identity = runtime.identity;
  } catch (error) {
    // 打不开身份库（schema 过新 / 钥匙串被拒 …）不是崩溃，而是**要说出来的启动失败**：
    // 记下原因后继续把窗口与只读能力装配完，registerIdentityIpc 以 service:null + bootError
    // 交回渲染层，界面走已有的 BootRetry。
    identityBootFailure = describeStartupFailure(error);
    console.error("[openarc] 身份服务启动失败：" + identityBootFailure);
  }

  // D4 main-entry E2E：唯一一处默认关闭的只读 boot 观测。仅把 safe boot snapshot 写到隔离
  // userData，供真实 electron/main.cjs 启动的测试断言 boot 顺序；不改任何服务/权限/执行链。
  if (process.env.OPENARC_E2E_OBSERVE === "1") {
    try { fs.writeFileSync(path.join(app.getPath("userData"), "openarc-e2e-boot.json"), JSON.stringify(runtime.snapshot())); } catch {}
  }

  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 700,
    title: "OpenArc OS",
    // 自绘 chrome：产品顶栏与窗口标题栏都是 DOM，不能留原生标题栏 ——
    // transparent 下它会变成一条透出后方的空带，并把内容整体下推 32px（实测 inset=32）。
    // macOS 用 titleBarStyle:"hidden"：内容仍全屏铺满（实测 inset 0），但**保留原生红绿灯**，
    // 它们操作 OpenArc 窗口本身（关闭/最小化/缩放），DOM 顶栏左侧相应留出位置。
    // Windows 没有等价"保留控件"的方式，直接 frame:false，caption 由 DOM 自绘
    // （TopBar.vue 的 .topbar-caption → windowControl 桥）。
    // isMacChrome 而非 isMac：仅测试用的 OA_FORCE_PLATFORM 也要能切换窗口 chrome，
    // 否则在 macOS 上截出来的"Windows 布局"会同时带真实红绿灯与自绘按钮。
    ...(isMacChrome
      // 灯组 y 的三次实测口径（顶栏 38px，DOM 内容中心实测 = 19）：
      //   y=16 → 灯心 22（偏低 3px，用户第一次反馈"没居中"）
      //   y=13 → 灯心 19（几何正中，用户第二次反馈"有点偏上"）
      //   y=15 → 低 2px；y=17 → **实测偏低 5px**（用户截图量出：彩点中心 41.5 vs 图标 31.5 @2x）
      //   y=12 → 反推回正（= macOS 14px 按钮框的几何值 (38-14)/2）—— 当前值。
      // 教训：这类"看起来正不正"的问题必须用**用户真实窗口的截图**量，不能靠几何推算。
      ? { titleBarStyle: "hidden", trafficLightPosition: { x: 20, y: 12 } }
      : { frame: false }),
    ...glass,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // ---------------------------------------------------------------------------
  // A05：显示器变化后必须把原生窗口拉回可见工作区。
  // Electron 的 setBounds 不做可见性校验，窗口落在已拔掉的屏幕上不会被自动归位。
  // ---------------------------------------------------------------------------
  const displayInfo = () =>
    screen.getAllDisplays().map((d) => ({
      id: d.id,
      scaleFactor: d.scaleFactor,
      workArea: d.workArea,
      internal: d.internal,
      primary: d.id === screen.getPrimaryDisplay().id,
    }));
  const ensureWindowVisible = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const areas = screen.getAllDisplays().map((d) => d.workArea);
    if (areas.some((a) => geometry.intersects(b, a))) return;
    const p = screen.getPrimaryDisplay().workArea;
    win.setBounds({
      x: p.x + 40,
      y: p.y + 40,
      width: Math.max(geometry.MIN_W, Math.min(b.width, p.width - 80)),
      height: Math.max(geometry.MIN_H, Math.min(b.height, p.height - 80)),
    });
  };
  for (const event of ["display-added", "display-removed", "display-metrics-changed"])
    screen.on(event, () => {
      ensureWindowVisible();
      if (win && !win.isDestroyed()) win.webContents.send("display:changed", displayInfo());
    });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (url === uiURL) return;
    if (devOrigin !== null && url.startsWith(devOrigin + "/")) return;
    e.preventDefault();
    // 主进程侧留证：外壳页顶层的导航出网也由宿主拦下（CSP 管不到顶层导航）。
    try { console.warn("[openarc] 已拦截应用内导航出网（主框架）：", String(url).slice(0, 300)); } catch { /* ignore */ }
    globalThis.__OPENARC_BLOCKED_NAVIGATIONS__ = (globalThis.__OPENARC_BLOCKED_NAVIGATIONS__ || []).concat([{ url: String(url).slice(0, 300), isMainFrame: true, at: Date.now() }]);
  });

  /**
   * 权限边界：**只有本应用自己的页面**能要麦克风，而且只要 audio（不要 video）。
   *
   * 不写这张表的话 Electron 默认放行一切 —— 浏览器窗口里那些不受信网页也能顺手开麦
   * （A13 的反面：不可信网页不得拿到系统能力）。其余权限维持原有行为，不额外扩张。
   */
  const appDir = pathToFileURL(path.join(__dirname, "..", "dist")).toString();
  const isAppPage = (url) => {
    if (typeof url !== "string") return false;
    if (url.startsWith(appDir)) return true;
    // 开发预览下外壳页是 dev server 同源页面，麦克风权限同样只给这一来源。
    return devOrigin !== null && url.startsWith(devOrigin + "/");
  };
  const micOnly = (url, mediaTypes) => {
    const types = Array.isArray(mediaTypes) && mediaTypes.length ? mediaTypes : ["audio"];
    return isAppPage(url) && types.includes("audio") && !types.includes("video");
  };
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== "media") return callback(true);
    callback(micOnly(details?.requestingUrl || wc?.getURL?.(), details?.mediaTypes));
  });
  win.webContents.session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    if (permission !== "media") return true;
    return micOnly(details?.requestingUrl || requestingOrigin || wc?.getURL?.(), details?.mediaTypes);
  });

  // ---------------------------------------------------------------------------
  // D5-02 Full-App · **宿主级导航出网拦截**（不是靠页面 CSP / fetch 替换）。
  //
  // 画布应用（外壳 + 14 个子页）在 sandbox iframe 里；页面里的 location.href 自我导航
  // 无法被 CSP 关掉（Chromium 没有 navigate-to），所以在这里按帧拦：
  //   允许：dist/index.html（本应用外壳）、openarc-canvas://bundle/**（bundle 内部的产品导航）；
  //   其余（http/https/file/自造 scheme/其他）一律 preventDefault + 审计 + 通知渲染层。
  // ---------------------------------------------------------------------------
  const NAV_ALLOWED = (url) => {
    const u = String(url || "");
    if (u === uiURL) return true;
    if (u === "about:blank") return true;
    if (u.startsWith("openarc-canvas://bundle/")) return true;
    return false;
  };
  const blockedNavigations = [];
  const onFrameNavigate = (...args) => {
    // will-frame-navigate 的签名随 Electron 版本变化：新版 (details{url,isMainFrame,preventDefault})，
    // 旧版 (event, url, isInPlace, isMainFrame, ...)。两种都支持，不猜测版本。
    const first = args[0];
    const isDetails = !!first && typeof first === "object" && typeof first.url === "string";
    const event = first;
    const url = isDetails ? first.url : args[1];
    const isMainFrame = isDetails ? !!first.isMainFrame : !!args[3];
    if (NAV_ALLOWED(String(url))) return;
    try { if (event && typeof event.preventDefault === "function") event.preventDefault(); } catch { /* 拦不住也要留证 */ }
    const row = { url: String(url).slice(0, 300), isMainFrame, at: Date.now() };
    blockedNavigations.push(row);
    if (blockedNavigations.length > 50) blockedNavigations.shift();
    globalThis.__OPENARC_BLOCKED_NAVIGATIONS__ = blockedNavigations;
    // 主进程侧留证（门禁读 stderr 就能证明"是宿主拦的"，不是页面 CSP 声明）：
    try { console.warn("[openarc] 已拦截应用内导航出网：", row.url); } catch { /* ignore */ }
    // 同时经既有 native:state 只读通道告知渲染层（类型未知的载荷既有逻辑会忽略）。
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("native:state", { type: "canvas-navigation-blocked", url: row.url, isMainFrame: row.isMainFrame, at: row.at });
    }
  };
  if (typeof win.webContents.on === "function") {
    try { win.webContents.on("will-frame-navigate", (...args) => onFrameNavigate(...args)); } catch { /* 旧版本没有该事件 */ }
  }
  globalThis.__OPENARC_BLOCKED_NAVIGATIONS__ = blockedNavigations;

  // ---------------------------------------------------------------------------
  // D3-01 · 身份服务（唯一权威，§25）已在 runtime boot 中创建；
  // 接下来只注册 IPC：渲染进程只能通过 `identity:command` 派发命令，
  // 拿回 sanitize 过的快照。session token 从未越过这条边界。
  // ---------------------------------------------------------------------------
  registerIdentityIpc({
    ipcMain,
    service: identity?.service,
    authorization: identity?.authorization,
    device: identity?.deviceService,
    // D3-04A：资源命令。导入/链接的文件选择在主进程完成，路径不回渲染进程。
    resource: identity?.resourceService,
    resourceSearch: identity?.searchService,
    resourcePreview: identity?.previewService,
    // D3-04D：治理 / Projects / Canvas / Picker。
    governance: identity?.governanceService,
    projects: identity?.projectService,
    canvas: identity?.canvasService,
    picker: identity?.pickerService,
    // D4-01：模型命令（Settings → Models；无 raw credential / proxy capability）。
    model: identity?.modelService,
    // D4-03C4：Trusted Approval Gateway（只暴露安全 approval 投影 + trusted user decision）。
    sideEffect: identity?.sideEffectGateway ?? null,
    dialog,
    shell,
    BrowserWindow,
    // Z2：访达窗口把选中条目加入资源库时，磁盘路径只在主进程解析。
    // file-service.resolve() 刻意不挂 preload（file-service.cjs "只给主进程用"），
    // 这里只把 { path, name } 交给 ResourceService，渲染层仍只给 folderId + 条目 id。
    resolveFile: (folderId, id) => {
      if (!files) return null;
      const hit = files.resolve(String(folderId || ""), String(id || ""));
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
    },
  });

  // D5-03：MCP 中心（mcp:command 单一通道；sessionRef/appId 由主进程注入）。
  // B4e：工具调用默认关闭 —— mcpSwitch 读 <userData>/dxos/mcp.json（缺省 / 读坏 / 缺 userData 一律 false）；
  // mcp/agentTools 只读，mcp/toolInvocation/set 是唯一写入口（trusted + mcp.manage + 审计）。
  if (!mcpSwitch) mcpSwitch = createMcpSwitch({ userDataDir: app.getPath("userData") });
  /** B4e：开关变更审计进既有 authorization_audit（与工具调用同源可查）。审计不可用返回 false。 */
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
  /**
   * B4e：任务内 MCP 调用的可信 taskId 解析。
   * taskId 只用来**定位**真实 Task；归属（user/app）由这里用已认证 session + Task row 判定，
   * 再由 ControlledToolProxy.propose 二次校验，渲染层自报的 appId/userId 一律不参与。
   */
  const resolveMcpTaskContext = ({ context, taskId } = {}) => {
    if (!identity || !identity.taskStore || typeof identity.taskStore.taskById !== "function") {
      return { ok: false, error: "MCP_TASK_CONTEXT_UNAVAILABLE" };
    }
    const task = identity.taskStore.taskById(String(taskId || ""));
    if (!task) return { ok: false, error: "MCP_INVALID_INPUT", detail: "task-not-found" };
    const sessionRef = context && context.sessionRef;
    const session = identity.store && typeof identity.store.validateSession === "function" ? identity.store.validateSession(sessionRef, { sensitive: false }) : null;
    if (!session || session.ok !== true) return { ok: false, error: "MCP_UNAUTHORIZED", detail: "no-session" };
    const sessionUserId = session.user && session.user.id != null ? session.user.id : null;
    if (!sessionUserId || String(sessionUserId) !== String(task.user_id)) return { ok: false, error: "MCP_UNAUTHORIZED", detail: "task-not-owner" };
    return { ok: true, taskId: task.task_id, appId: task.app_id, stepId: null, runId: null };
  };
  // boot 失败时以 service:null 注册，渲染层拿到 mcp-not-ready 的稳定错误，而不是 "No handler registered"。
  registerMcpIpc({
    ipcMain,
    service: identity?.mcpService ?? null,
    identity: identity?.service ?? null,
    isTrusted: trusted,
    // B4e：聚合端口晚绑定到下面装配的 bridge（IPC 调用发生时 bridge 必已初始化）。
    agentTools: () => (mcpAgentBridge ? mcpAgentBridge.mcpAgentTools : null),
    mcpServersSnapshot: () => (mcpAgentBridge ? mcpAgentBridge.mcpServersSnapshot() : []),
    toolInvocationEnabled: () => mcpSwitch.isToolInvocationEnabled(),
    // B4e 收口：唯一开关写入口 + 任务内调用端口（晚绑定 bridge）。
    toolInvocationSwitch: () => mcpSwitch,
    audit: mcpAudit,
    resolveTaskContext: resolveMcpTaskContext,
    toolInvocation: () => (mcpAgentBridge && mcpAgentBridge.mcpAgentTools ? {
      callByName: (fname, args, options) => mcpAgentBridge.mcpAgentTools.callByName(fname, args, options),
      callDirect: (serverId, toolName, args, options) => mcpAgentBridge.mcpAgentTools.callDirect(serverId, toolName, args, options),
    } : null),
  });

  // 身份 runtime 存在时才注册依赖它的能力；boot 失败时窗口仍照常加载并走 BootRetry。
  if (identity) {
    // W5：把 provider-protocol 的流式事件接到 model:event。与 identity:event / task:event /
    // sideeffect:event 同一条 trusted(event) 边界；send 只转发主进程已封装的 P1 信封。
    wireModelEvents({
      service: identity.modelService,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("model:event", event); },
    });

    // 模型/协议出口的**可选**代理：只注入 ModelService 与 provider-protocol-service（各 provider 适配器
    // 都从这两处按调用取 fetchImpl），绝不写 globalThis，也不碰 market-update / developer / 集成等出口。
    // getConfig 每次请求现读 system_preferences，因此改配置无需重启。
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

    // ---------------------------------------------------------------------------
    // D5-02 · 无限画布：文档层 + 资源可用性 + 命令层。
    // 画布页面运行在 sandbox iframe 里（无 openarc 桥 / 无 IPC / 无 fs / 无凭据），
    // 它的全部请求都由宿主渲染层经 canvas:command 转发到这里。
    // ---------------------------------------------------------------------------
    canvasBundle = { service: identity.canvasDocService };
    // B5d：画布域扩展命令（素材库 / 协作 / 内核能力 / Agent 附件 / .dxcanvas）接在同一个 canvas:command；
    // 未装配扩展时白名单内的扩展命令回落 CANVAS_COMMAND_NOT_ALLOWED，不新建第二套画布通道。
    // 10-23：canvas/assetPublicUrl —— 画布素材 → Litterbox 24h 直链（复用媒体域上传器的域名白名单与直链复验）
    const canvasAssetPublicUrl = createAssetPublicUrl(identity.canvasDocService, {
      uploader: createLitterboxUploader({ fetchImpl: createGuardedFetch(typeof fetch === "function" ? fetch : null), retention: "24h", maxBytes: 200 * 1024 * 1024 }),
    });
    // 下载模型结果属于模型出口：走模型出网代理（与生成请求同一条网络路径，服务商 CDN 才连得上）
    const canvasImportRemote = createImportRemote(identity.canvasDocService, { fetchImpl: createGuardedFetch(modelEgressFetch || (typeof fetch === "function" ? fetch : null)) });
    registerCanvasIpc({ ipcMain, service: identity.canvasDocService, identity: identity.service, isTrusted: trusted, extension: identity.canvasDxosExtension, assetPublicUrl: canvasAssetPublicUrl, importRemote: canvasImportRemote });

    // D4-04：Renderer 可发起真实 AI Task（Task Runtime + official dsh + Tool Facade），
    // sessionRef/appId 由主进程注入；进度经 task:event 推送。
    registerTaskIpc({
      ipcMain,
      taskService: identity.taskService,
      orchestrator: identity.orchestrator,
      identity: identity.service,
      isTrusted: trusted,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("task:event", event); },
    });

    // B6d：DX 虚拟文件树（<userData>/dxos/fs）→ B3/B4 共用的 fsAdapter 注入面。
    //   · 构造走 createDxosFsAdapterForUserData（解析路径 + 建目录 + 可写探测 + 构造适配器）；
    //   · 装配失败（目录建不出 / 不可写等）→ 保持 null：健康报告如实 false，命令侧继续结构化
    //     AGENT_DEPENDENCY_UNAVAILABLE，绝不假装可用；
    //   · 同一份实例同时喂 createSkillBundle 与 createAgentBundle，两个域看到同一棵虚拟树。
    let dxosFsAdapter = null;
    try {
      dxosFsAdapter = createDxosFsAdapterForUserData(app.getPath("userData"));
    } catch (error) {
      console.warn("[openarc] DX 虚拟文件树装配失败，文件工具将保持结构化依赖缺失：" + ((error && error.message) || error));
    }
    // 画布素材库的 sync-sources 需要读 DX 虚拟文件树的"文件节点"：画布域创建早于 fsAdapter，
    // 这里晚绑定同一个 store（未装配时 sync-sources 对文件节点如实结构化不可用）。
    try {
      if (identity.canvasAssetLibrary && typeof identity.canvasAssetLibrary.configureFs === "function") {
        identity.canvasAssetLibrary.configureFs(dxosFsAdapter ? dxosFsAdapter.store : null);
      }
    } catch (error) {
      console.warn("[openarc] 画布素材库文件节点同步未接上 DX 虚拟文件树：" + ((error && error.message) || error));
    }

    // B4：技能域。
    //   · <userData>/dxos 注入 configureSkillStore / configureSkillPack / configureSkillRunner / configureSkillAnalyzer /
    //     configureSkillWorkspace（路径由 dxos-foundation-paths.cjs 统一解析）；
    //   · providerAdapter 由 B2 的 provider-protocol store/service 组装（provider-adapter-bridge.cjs）；
    //     cliRuntime / mediaAdapter（B7/B5 未落地）→ 传 null，命令侧保持结构化依赖缺失（绝不伪造）；
    //     fsAdapter 由上面的 DX 虚拟文件树提供（产物落盘）；
    //     modelAdapter 走 provider-protocol-service.call（唯一模型出口）；
    //   · skill:event 与 model:event / task:event / agent:event 同一条 trusted(event) 边界，renderer 只能订阅。
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
    registerSkillIpc({
      ipcMain,
      bundle: skillBundle,
      identity: identity.service,
      isTrusted: trusted,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("skill:event", event); },
    });

    // B3：Agent 域。
    //   · 任务/运行/工具/项目/记忆全部落到 identity-store 的同一 SQLite 连接（agent_* 表 v23 迁移已建）；
    //   · modelAdapter 走 provider-protocol-service.call（唯一模型出口）；
    //   · providerAdapter 复用上面 B2 组装的只读桥（模型执行出口；密钥只在 service 内部解出）；
    //   · fsAdapter 复用上面已装配的 DX 虚拟文件树（装配失败即为 null）；
    //     workspaceAdapter 仍由 agent-runtime-workspace.cjs 提供；任一缺失 → 命令侧保持结构化
    //     AGENT_DEPENDENCY_UNAVAILABLE，绝不假装可用；
    //   · agent:event 与 model:event / task:event 同一条 trusted(event) 边界，renderer 只能订阅。
    // B4 收口：MCP → Agent 工具目录的只读桥。
    //   · 目录：mcpService.listConnections（appId=mcp-center 基线授权）→ 只列用户/组织真实可见的 server；
    //     未连接/停用/无工具一律照实投影（status 非 connected、executable:false），不伪造 connected。
    //   · 调用（B4e 收口）：真实传输 = McpService 已建立的活连接（electron/mcp-live-transport.cjs），
    //     不再依赖测试注入的假对象；审批 = ControlledToolProxy.propose，taskId 逐调用由可信上下文解析。
    //     开关未打开 → 0 审批 0 传输；未审批 → APPROVAL_REQUIRED（0 传输）；审批通过才发真实 tools/call。
    // Y4：宿主侧 App 托管 MCP 的 connections 端口 + 注册表（策略门沿用 mcp-domain 白名单 / SSRF 口径）。
    //   · connections 端口的 list 走 McpService.listConnections（app grant + 可见性判定），
    //     绝不把原始数据库行直接交给调用方；save/connect/disconnect/remove 落在既有 mcp_connections 表；
    //   · appState 来自 developer 的启用状态（user_installed_apps；无会话 = 未启用，fail-closed）；
    //   · identity.mcpService 未装起来时不建端口 / 注册表，全部保持结构化降级，main 装配不崩。
    // Y4 降级口径：端口 / 注册表都是可选能力。构造抛错时降到 null + 记一条原因，绝不把启动链拖死；
    // 上层（developer bundle / mcp-agent-bridge）拿到 null 后保持既有的结构化 AGENT_DEPENDENCY_UNAVAILABLE。
    const mcpWiringLog = (event, detail) => { try { console.warn("[openarc] " + String(event) + " " + JSON.stringify(detail)); } catch { /* 日志失败不影响主流程 */ } };
    const mcpConnectionsPort = identity.mcpService
      ? constructOrDegrade("MCP connections 端口", () => createMcpConnectionsPort({
          mcpService: identity.mcpService,
          mcpStore: identity.mcpStore || null,
          context: () => ({ sessionRef: (identity.service && identity.service.current) || null, appId: "mcp-center" }),
          logger: mcpWiringLog,
        }), mcpWiringLog).value
      : null;
    // appState 的真实来源 = developer 的启用状态（user_installed_apps）。无会话 / 无库 / 查询失败一律
    // fail-closed（未启用），不因为读不到就默认放行连接。
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
    // D5-04：把 MCP 接成**既有 SideEffectAuthority** 的 provider（plan/execute 两个方向），不新建第二套审批权威。
    //   · provider 挂到既有 adapters.providers 注册表（tool-adapters.cjs adapterFor 解析）；活性由
    //     side-effect-runtime.cjs 的 IN_PROCESS_EXECUTION_PROVIDERS 白名单认定（MCP 活连接只在 main 进程）；
    //   · 审批端口 = createSideEffectExecutionPort（经 DX 身份映射桥包一层）：proposeWrite(plan) →
    //     既有 sideEffect/decideApproval 作出 trusted 决定 → 既有 lease/claim/verify 真实执行 → 结果回传。
    //     未批准/被拒/超时 0 传输。
    const mcpSideEffectProvider = createMcpSideEffectProvider({ transport: mcpLiveTransport, registry: identity.toolRegistry || null });
    if (identity.adapters && identity.adapters.providers && typeof identity.adapters.providers === "object") {
      identity.adapters.providers.McpExternal = mcpSideEffectProvider;
    }
    // D5-04 补丁：agent 工具循环（project-agent-mode / react-driver）给出的 taskId 属于 dx_tasks，
    // 而既有审批链按核心 tasks 定位 Task/Step/Run。桥只负责把 dx 任务步骤**幂等**映射成核心审批
    // 任务/步骤/运行（同一 dx 步骤只产生一个核心任务），approval/lease/claim/verify/audit 仍由同一个
    // SideEffectAuthority 裁决；sessionRef 只由主进程从已认证身份推导，渲染层 / Harness 给不了。
    // 已是核心 taskId 的调用（mcp/toolInvocation/call）由桥原样透传，既有语义不变。
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
          // sessionRef 只由主进程从已认证身份推导（渲染层给不了）；appId 用 MCP 中心的承载 Principal。
          context: () => ({ sessionRef: (identity.service && identity.service.current) || null, appId: "mcp-center" }),
          // B4e：默认关闭的显式开关（<userData>/dxos/mcp.json）+ 共享 ToolRegistry。
          // 注入 registry 后，已连接 server 的 MCP 工具被幂等登记为 EXTERNAL_SIDE_EFFECT（requiresApproval）。
          switch: mcpSwitch,
          registry: identity.toolRegistry || null,
          // Y4：配置读写接既有 connections 端口（只读 list 仍是授权后的投影）；
          // Y1 的 App 托管注册表原样转交 createMcpAgentTools 的三个入口。
          connections: mcpConnectionsPort,
          appRegistry: appManagedMcpRegistry,
          transport: mcpLiveTransport,
          approval: mcpApprovalPort,
        })
      : null;
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
      // B4：把技能来源接进工具目录（listSkills + runSkill）；未装配时为 null，catalog 保持 available:false。
      skillSource: skillBundle ? skillBundle.skillSource : null,
      // B4 收口：mcp 工具目录来源（同一快照同时喂 catalog 与 createMcpAgentTools 的可调用索引）。
      mcpAgentTools: mcpAgentBridge ? mcpAgentBridge.mcpAgentTools : null,
      mcpServersSnapshot: mcpAgentBridge ? mcpAgentBridge.mcpServersSnapshot : null,
      // B5d：画布内核能力进工具目录（来源由 canvas-dxos-capabilities 投影；未装配时 catalog 保持 available:false）。
      canvasExtension: identity.canvasDxosExtension || null,
      // B6d：DX 虚拟文件树（文件工具 / project snapshot / fs_list 的真值通道）。
      fsAdapter: dxosFsAdapter,
    });
    registerAgentIpc({
      ipcMain,
      bundle: agentBundle,
      identity: identity.service,
      isTrusted: trusted,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("agent:event", event); },
    });

    // B5a：媒体域。
    //   · 重活（ffmpeg 渲染 / ffprobe 探测 / 封面）全部走受监督子进程模板：
    //     dxos-foundation-runner.cjs（超时 / 取消 / 输出上限）+ video-render-worker.cjs（唯一 worker 入口）；
    //   · 渲染作业落 identity-store 同一 SQLite 连接（v24 迁移已建 video_* 表）；
    //   · 曲目 / 素材 / 封面缓存全部在 <userData>/dxos/media 下，绝对路径不出主进程；
    //   · media:event 与 model:event / task:event / agent:event / skill:event 同一条 trusted(event) 边界。
    // B5f：把上面已经装配好的真实依赖接进媒体域（只接线，不新增实现）。
    //   · fsAdapter     复用 B6d 的 DX 虚拟文件树（同一份实例；短剧画布 / 素材按节点落 <userData>/dxos/fs）；
    //   · fetchImpl     主进程全局 fetch + 出口护栏（拒绝云端点 dx-os.com，只用本地 / 用户自配端点）；
    //   · providerStore / modelGateway 复用 B2 provider-protocol 的 store/service（模型唯一出口，不新造协议层）；
    //   · viteBuild     本仓没有随包可用的 Vite 构建器（vite 只在 devDependencies）→ 保持 null，
    //                   Figma 预览构建继续结构化不可用，不假接；
    //   · illustratorAvailable / onnx 探测：探测不到就如实传 false / null，不放松命令侧的结构化失败。
    const mediaFetchImpl = createGuardedFetch(typeof fetch === "function" ? fetch : null);
    const mediaProviderStore = createMediaProviderStore({ providerProtocol: providerProtocol, providerAdapter: providerAdapter });
    const mediaModelGateway = createMediaModelGateway({
      providerProtocol: providerProtocol,
      mediaDir: path.join(app.getPath("userData"), "dxos", "media"),
    });
    const mediaOnnxProbe = probeOnnxAvailability({ modelDir: path.join(app.getPath("userData"), "dxos", "media", "background-removal") });
    // 短剧出图 / 成片导出 → OpenArc 资源库（幂等：同 checksum 复用既有 active 资源）。
    // resourceStore 只读查询用于去重；session 身份由 media-service 的可信 context 提供。
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
      // B5f：真实依赖注入面（未就绪项保持 null / false，命令侧仍 MEDIA_DEPENDENCY_UNAVAILABLE）。
      fsAdapter: dxosFsAdapter,
      fetchImpl: mediaFetchImpl,
      providerStore: mediaProviderStore,
      modelGateway: mediaModelGateway,
      modelDir: mediaOnnxProbe.modelDir,
      modelPath: mediaOnnxProbe.modelPath,
      onnxRuntime: mediaOnnxProbe.runtime,
      illustratorAvailable: probeIllustratorAvailability(),
      // 本仓无随包 Vite 构建器（vite 仅 devDependency）→ 如实 null。
      viteBuild: null,
      // 公共媒体上传：图床只经注入的 uploader；media-public-media.cjs 不内置图床地址。
      publicMediaUploader: createLitterboxUploader({ fetchImpl: mediaFetchImpl }),
      // 出图 / 成片导出 → 资源库（未装配时命令侧如实回 MEDIA_DEPENDENCY_UNAVAILABLE）。
      resourceRegistrar: mediaResourceRegistrar,
      // 导出到访达：绝对路径只交给 shell.showItemInFolder，渲染层只拿 relativePath。
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

    // B6a：自动化域装配已下移到 agent / developer / plugin 之后（见下方「B7j：自动化域装配」）。
    // B6c：平台域。
    //   · 快照落 <userData>/dxos/backups（排除 credentials 目录，绝不含明文密钥）；
    //   · 诊断只读 process.env 之外的进程事实，环境变量与绝对路径都不出主进程；
    //   · 网络判定复用 networkSafety 口径（HTTPS + 域白名单 + DNS 公网校验），不另造一套；
    //   · platform:command 与 model / task / agent / skill / media 同一条 trusted(event) 边界。
    platformBundle = createPlatformBundle({
      userDataDir: app.getPath("userData"),
      identityStore: identity.store,
      authorization: identity.authorization,
      appVersion: app.getVersion(),
      appName: "OpenArc OS",
      environment: { locale: app.getLocale(), build: null },
      // 受监督子进程清单：只取 RuntimeSupervisor 的 safe snapshot；不暴露 pid / 路径。
      processes: () => collectSupervisedProcesses(identity),
      // 共享盘 / 部门盘 / 子树快照 / 搜索 / 统计：复用同一棵 DX 虚拟文件树（只读桥，不返回绝对路径）。
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

    // B7a：开发者平台（本地 App 生命周期）。
    //   · 六张表沿用 v22（user_installed_apps / user_app_install_state / app_market_releases /
    //     app_credential_bindings / app_runtime_events / app_network_audit），零 CREATE / ALTER；
    //   · 包字节落 <userData>/dxos/developer-apps/packages（清单缓存与当前版本指针在 app_market_releases）；
    //   · 出网沿用 developerNetwork 口径（HTTPS + 域白名单 + DNS 公网校验 + 每分钟 60 次限流 + 审计）；
    //     未注入 lookup / fetch 时走 node:dns 与 globalThis.fetch；测试全部注入假实现（离线）；
    //   · developer:command 与 platform / automation 同一条 trusted(event) 边界。
    // B7f：安装 / 升级 / 回滚的声明式迁移注入面。
    //   · 迁移引擎需要 snapshotSubtree / restoreSubtreeSnapshot，只有 dxos-fs 完整实例有，
    //     B6b 的窄适配器面没有；因此取 .store（同一棵树，不新建第二份数据目录）；
    //   · snapshotRoot = <userData>/dxos/developer-apps/migrations（任务书 item 2）。
    const userData = app.getPath("userData");
    const developerMigrationFs = dxosFsAdapter ? dxosFsAdapter.store : null;
    const developerMigrationSnapshotRoot = path.join(userData, "dxos", "developer-apps", "migrations");
    // 实时房间 authorize：只认主进程会话推导出的 userId，payload 自报的 userId 必须与之一致。
    const developerRealtimeAuthorize = ({ userId } = {}) => {
      const sessionRef = identity.service ? identity.service.current : null;
      if (!sessionRef) return { ok: false, error: "UNAUTHORIZED", detail: "no-session" };
      const session = identity.store && typeof identity.store.validateSession === "function" ? identity.store.validateSession(sessionRef, { sensitive: false }) : null;
      if (!session || session.ok !== true) return { ok: false, error: "UNAUTHORIZED", detail: "invalid-session" };
      const sessionUserId = session.user && session.user.id != null ? session.user.id : null;
      if (!sessionUserId || (userId && String(userId) !== String(sessionUserId))) return { ok: false, error: "FORBIDDEN", detail: "user-mismatch" };
      return { ok: true };
    };
    // B7h：逐切片装配并登记状态。任何一片失败只降级该片（不是整批静默消失）：
    //   · 失败原因收集进 developerExtensionNotes，随 extensionStatus 交给 developer-bootstrap，
    //     最终出现在 developer/health 的 degraded / degradedReason / extensions 里；
    //   · health 的 commands 报"实际可达数"（16 基座 + 真正装配上的切片命令），不再报静态白名单 70。
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
      // 迁移引擎需要 B6 完整文件树；缺 fs 时切片仍登记，但命令会返回结构化不可用 → degraded。
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
      // X7：开发者 App 安装/启用时幂等登记 app_principals（agent-bundle 同一写入通道）。
      authStore: identity.authStore,
      // Y4：启用 / 禁用 / 卸载绑定宿主侧 App 托管 MCP 注册表（未装起来时为 null，保持既有降级）。
      appMcpRegistry: appManagedMcpRegistry,
      systemVersion: app.getVersion(),
      migrationFs: developerMigrationFs,
      migrationSnapshotRoot: developerMigrationSnapshotRoot,
      clock: null,
      logger: null,
    });
    // task-34 F04：agent bundle 早于 developer 创建；这里晚绑定 App Agent 的清单/权限真值来源。
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
    // 画布插件宿主：只读复用 developer-store 的已安装版本/清单；网络委托 developer/network/request。
    // 晚绑定到 canvas 扩展（canvas 域创建早于 developerBundle）；未绑定则 canvas/plugins/* 结构化不可用。
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
    // B4e 收口：把 developer App 目录投影晚绑定给本地账号服务。
    //   · identity 在 runtime-boot.cjs 里先建，developerBundle 后建，构造期无法注入；
    //   · 数据仍是同一份（identity SQLite + <userData>/dxos），这里只做只读投影，不新建第二份目录；
    //   · 未装配时保持 local-account 既有降级（developerApps.available=false），不伪造清单。
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

    // B7c：可选插件框架 + 本地市场。
    //   · 三个插件（钉钉 / 天气 / 黄历）默认全关；开关落 <userData>/dxos/integrations.json；
    //   · 钉钉 webhook / 加签密钥 / clientSecret 走 credential-store 的 safeStorage 后端，明文不落盘；
    //   · 天气 / 黄历网络经注入 fetch（本机离线时不注入即结构化 INTEGRATION_UNAVAILABLE，不假实现）；
    //   · 本地市场只读 catalog.json（随包 resources/market 或 <userData>/dxos/market），不联网、不下载；
    //     云发布 / 审核 / 灰度 / api.dx-os.com 一律 OUT（任务书硬约束）；
    //   · integration:command / market:command 与 platform / automation 同一条 trusted(event) 边界。
    pluginBundle = createPluginBundle({
      userDataDir: app.getPath("userData"),
      safeStorage,
      fetch: typeof fetch === "function" ? fetch.bind(globalThis) : null,
      logger: null,
      clock: null,
      // Z1（产品已批准「定义即授权」）：把**既有 MCP 活连接**端口注入集成域，使自动化同步动作
      // 在「定义已授权 + 插件启用 + 依赖就绪」时真正走既有 tools/call 通道（不另造通道）。
      // 定义授权闸门在 automation-service（执行前校验 authorization_audit 的定义授权记录）；
      // MCP 客户端「开关 + 审批决定」双条件保持不变，不新建第二套审批权威。
      mcpTransport: mcpLiveTransport,
    });
    registerIntegrationIpc({
      ipcMain,
      bundle: pluginBundle,
      identity: identity.service,
      isTrusted: trusted,
    });

    // B7j：自动化域装配（agent / developer / plugin 均已就绪后才装配，保证适配器非空）。
    //   · 定义 / 运行记录落 identity-store 同一 SQLite 连接（v22 迁移已建 automations / automation_runs，不改表）；
    //   · 调度器在主进程内（无云依赖）：到点领取并在异步路径执行，长动作不阻塞主线程；
    //   · 业务动作依赖全部来自真实实现：
    //       developerApps ← developer-store（已安装 App / 本地装载清单）
    //       integrations  ← plugin-service（钉钉 / 领星 / 紫鸟；默认关，未启用 / 无 transport 结构化不可用）
    //       toolCatalog   ← agent 工具目录唯一执行入口
    //       agent         ← agent-service.runInstruction（project agent mode 同一路径）
    //       desktop       ← desktop-executor.cjs（musicPlay / musicControl / openApp；受控系统 API）
    //   · automation:event 与 model:event / task:event / agent:event / skill:event / media:event 同一条 trusted(event) 边界。
    const automationToolCatalog = createAutomationToolCatalogAdapter();
    const automationDeveloperApps = createAutomationDeveloperAppsAdapter({
      db: identity.store ? identity.store.connection || identity.store.db || null : null,
      userDataDir: userData,
      clock: () => Date.now(),
      runTool: automationToolCatalog.runTool,
    });
    // X4：integrations 只取 plugin-service 的唯一真值 bundle.automationAdapter（含 ziniao_data_sync
    // 与"建 job 前先过健康闸门"）；该对象缺失才回落本文件的旧实现，且必须出声记录（不静默）。
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
    // B7j+：桌面执行端（music_play / music_control / open_app）——受控系统 API，不是任意命令。
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
      toolCatalog: automationToolCatalog,
      // 未装配适配器的可读原因，直接进 automation/health.dependencyDetails。
      adapterNotes: {
        desktop: automationDesktopNote,
        integrations: automationIntegrationsNote,
        agent: agentBundle ? null : "agent-service 未装配",
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

    // Stage 1：画布在线更新服务（用户显式触发才下载 / 安装；装配失败只降级本命令族）。
    //   · 公钥来源 resources/app-update-keys.json；私钥永不进主进程；
    //   · 网络只在用户触发 check/install 时发生，且只访问所选源自己的白名单主机（github-releases / modelscope-repo 各一份，互不通用）；
    //   · 审计沿用 identity.authorization.store.auditAuthorization（与 model / mcp 同一张表）。
    // task-19 B：第三方注册表先建；A 的解析器与更新服务都通过它动态识别第三方 appId。
    try {
      thirdPartyRegistry = createThirdPartyRegistry({ userDataDir: app.getPath("userData"), clock: null });
    } catch (error) {
      thirdPartyRegistry = null;
      console.warn("[openarc] 第三方应用注册表装配失败，market/thirdparty/* 保持结构化不可用：" + String((error && error.message) || error));
    }
    // task-19 A：通用包加载路径先装配；market install 的加载复核与 openarc-app:// 协议共用同一实例。
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
    // task-19 B：第三方目录 / 安装（本地 catalog + 在线源）；复用 updateService 的签名/摘要/原子切换/回滚。
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

    // ---------------------------------------------------------------------------
    // 0.6.1 · 本轮新增五域接线：系统字体 / OCR / 文件传输 / codex-canvas / 本机代理探测。
    //
    // 为什么放在这个位置：
    //   · 五域都复用本文件唯一的 trusted(event) 与已认证身份 identity.service；其中 OCR 另需
    //     providerProtocol.store（B2 供应商存储，上方已装配）、文件传输需 identity.authorization、
    //     codex-canvas 需 identity.canvasDocService（与 canvas:command 同一实例）—— 都是 identity
    //     就绪后才存在的依赖，所以统一放在既有各域注册之后、`if (identity)` 收口之前；
    //   · 新通道只追加，不改既有通道，也不动既有注册顺序语义；
    //   · 每域各自 try/catch：装配/注册失败只降级该域（仍以未装配状态注册，回稳定的 *_NOT_READY，
    //     而不是 "No handler registered"），绝不拖死整个 app 启动（同 registerIdentityIpc 启动失败
    //     时以 service:null + bootError 交回渲染层的口径）。
    //
    // 并入既有顶层域的结论（逐条给理由）：
    //   · 本机代理探测 → 优先并入 platform:command：**不可行**。platform-bootstrap.cjs 先按
    //     platform-domain.cjs 的冻结白名单 PLATFORM_COMMANDS 拒绝未知命令，platform-service 的
    //     dispatch 也只认这份表；且 local-proxy-domain 的命令表只有 "desktop/proxy/detect"。
    //     要并必须改 platform-domain.cjs / platform-service.cjs / local-proxy-domain.cjs —— 均超出
    //     本轮授权写入范围且改动面显著扩大，故保留 desktop:command。
    //   · codex-canvas → 优先并入 canvas:command：**不可行**。canvas-bootstrap.cjs 的
    //     RENDERER_COMMANDS 是 Object.freeze 白名单，且白名单校验在 extension.dispatch 之前拦截；
    //     codex-canvas-bootstrap 又硬编码 codexCanvas:command。要并必须改 canvas-bootstrap.cjs /
    //     canvas-dxos-commands.cjs / codex-canvas-bootstrap.cjs —— 同样超出授权范围，故保留
    //     codexCanvas:command（+ 下行 codexCanvas:event）。
    // ---------------------------------------------------------------------------

    /** 单域降级：装配/注册抛错只把该域降为"未装配状态"，通道仍可达并回稳定 *_NOT_READY。 */
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

    // 系统字体：读本机字体目录清单 + 按 id 读字节（扫描惰性，启动期不扫盘）；命令/事件通道由 bootstrap 固定。
    registerDomainOrDegrade("systemFonts", (degraded) => {
      registerSystemFontsIpc(ipcMain, {
        bundle: degraded ? null : createSystemFontsBundle({}),
        isTrusted: trusted,
        identity: identity.service,
        hostAppId: "ai",
        send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("systemFonts:event", event); },
      });
    });

    // OCR：供应商只取 B2 provider-protocol 的既有 store（providers.json + safeStorage），不新建存储；
    // sharp 不注入（服务内惰性 require，缺失即结构化 OCR_DEPENDENCY_UNAVAILABLE，绝不用假图兜底）。
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

    // 文件传输：落盘根固定 <userData>/dxos/file-transfers；身份取自 identity.authorization，payload 身份字段一律忽略。
    registerDomainOrDegrade("fileTransfer", (degraded) => {
      registerFileTransferIpc(ipcMain, {
        bundle: degraded ? null : createFileTransferBundle({ userDataDir: app.getPath("userData"), authorization: identity.authorization }),
        identity: identity.service,
        isTrusted: trusted,
        hostAppId: "file-transfer",
      });
    });

    // codex-canvas：中继落到进程内的既有 canvasDocService（唯一实例），不新建画布、不自起 HTTP、不实现云能力。
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

    // 本机代理探测 + task-22 设置能力：手动代理（落 userData/settings）、缓存清理、系统更新检查。
    //   · 手动代理配置写 <userData>/dxos/settings/proxy.json；safeStorage 可用时加密，否则明文 JSON；
    //   · applyProxy 尽力作用到 Electron 网络栈（session.setProxy）；模型域仍有自己的 model/proxy/set，
    //     状态里如实区分 appliedScope；没有适配器时标 registration-only；
    //   · 缓存清理只删 dxos 下 cache/temp/tmp 内容，跳过凭据/数据库/备份；
    //   · 系统更新只检查/下载到 dxos/updates/downloads，不执行、不安装。
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
        // 启动时把已保存配置重新应用到 Electron 网络栈；失败只记录，不阻断启动。
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

    // ---------------------------------------------------------------------------
    // 0.6.2 · photos / photocraft / app-exchange 三域接线。
    //
    // 与 0.6.1 五域同一收口口径：都放在既有各域注册之后、`if (identity)` 收口之前，
    // 每域各自 try/catch（registerDomainOrDegrade），装配失败只把该域降为未装配态并回稳定
    // *_NOT_READY，绝不拖死 app 启动；命令面全部过唯一 trusted(event) 与 identity.service。
    //
    // 身份 / 落盘注入（与各 service 的真实契约对齐，不是照抄调用形状）：
    //   · photos.db    = identity.store.connection（v27 已建视觉特征两张表）；
    //   · photocraft   = identity.store（IdentityStore：photocraft-service 读 .connection /
    //                    .transactSync；传 IdentityService 会因缺 .connection 在装配时直接抛错）；
    //   · app-exchange = identity.store（同上；app_exchanges 表 v27 已建）。
    //   渲染层自报的 userId / owner / appId 一律忽略：bootstrap 的 sessionRef 只来自
    //   identity.service.current（主进程可信身份）。
    // ---------------------------------------------------------------------------

    let photocraftBundle = null;

    // 0.6.3 · canvas-exchange 端口适配层（唯一实例，photos 与 appExchange 共用同一份既有能力）：
    //   · 画布文档 / 权限 / 版本检查 ← identity.canvasDocService（与 canvas:command 同一实例）；
    //   · 素材库导入（checksum 去重） ← identity.canvasAssetLibrary；
    //   · 资源域 ← identity.resourceService / resourceStore；
    //   · fs 虚拟树共享区可见性 ← dxosFsAdapter（B6d 同一棵 <userData>/dxos/fs）；
    //   · sessionRef 只取 identity.service.current（主进程可信身份，不经渲染层）。
    // 构造期不抛错；缺哪个依赖就在用到它的端口上结构化依赖不可用。
    const canvasExchange = createCanvasExchangePorts({
      canvasService: identity.canvasDocService || null,
      assetLibrary: identity.canvasAssetLibrary || null,
      resourceService: identity.resourceService || null,
      resourceStore: identity.resourceStore || null,
      canvasDxosStore: identity.canvasDxosStore || null,
      fsStore: dxosFsAdapter,
      sessionRef: () => (identity.service && identity.service.current ? identity.service.current : null),
    });

    // photos：来源 / 虚拟文件夹 / 图库 / 视觉特征 / 反向提示词 / 抠图 / 缩略图。
    //   · fsImpl = dxosFsAdapter（B6d 的同一棵 <userData>/dxos/fs 虚拟树，只读投影）；
    //   · providerStore = B2 provider-protocol.store（唯一供应商来源）；
    //   · importer = canvas-exchange 适配层（canvas 节点 / 素材库条目，见 0.6.3）；videoPoster /
    //     shareAccess / sharpLoader 未装配，真实原因见各字段处注释，缺失时由 service 回结构化
    //     PHOTOS_DEPENDENCY_UNAVAILABLE，绝不用假实现兜底。
    registerDomainOrDegrade("photos", (degraded) => {
      registerPhotosIpc(ipcMain, {
        bundle: degraded ? null : createPhotosBundle({
          userDataDir: app.getPath("userData"),
          authorization: identity.authorization,
          db: identity.store.connection,
          providerStore: providerProtocol ? providerProtocol.store : null,
          fsImpl: dxosFsAdapter,
          // task-25 B02：shareZoneOf → canSeeShare 的等价判定；canvas: / asset-library: 两区
          // 分别复用 board 共享与素材库 ACL，不新造第二套权限模型。
          shareAccess: createPhotosShareAccess({
            canvasStore: identity.canvasDocService && identity.canvasDocService.store ? identity.canvasDocService.store : null,
            assetLibraryStore: identity.canvasDxosStore || null,
          }),
          // videoPoster：本仓不自带 ffmpeg 封面缓存，视频缩略图保持结构化依赖缺失。
          videoPoster: null,
          // importer：canvas 落点走 canvas-service.importAsset（字节进资源域）+ canvas-domain 的
          // node.add（文档只存 openarc-asset 引用）；library 落点走 canvas-dxos-asset-library
          // 的 importAssetItem（checksum 去重）。都是既有能力，不新造导入器。
          importer: canvasExchange.importer,
          // sharpLoader：不注入，service 内惰性 require("sharp") 就是本仓真实装载路径。
          sharpLoader: null,
          fetchImpl: typeof fetch === "function" ? fetch : null,
        }),
        identity: identity.service,
        isTrusted: trusted,
        hostAppId: "photos",
      });
    });

    // photocraft：项目 / 分组 / 源文件 / 导出 / 剪贴板 / 回收站。
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

    // appExchange：应用互传（targets / get / inspect / exchange / appExchange-images）。
    //   端口逐个按 app-exchange-service.cjs 文件头 JSDoc + 真实 requirePort 调用面注入；
    //   本仓没有对应能力的端口一律留空（不注入 = 用到时结构化 APP_EXCHANGE_DEPENDENCY_UNAVAILABLE）。
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
        // —— canvas target 端口（0.6.3 适配层，同一份既有能力）——
        //    getCanvas / canEditCanvas / canvasFolder / createCanvasCard / findNearestCanvasPlacement /
        //    syncCanvas / canViewCanvasMedia / canRead；权限一律走 CanvasService.evaluateCanvasAccess
        //    与 dxos-fs 共享区，不新增判定。
        ...canvasExchange.ports,
        // —— fs：同一棵 dxos 虚拟树（读引用 + 落副本）——
        getNode: fsStore ? (id) => fsStore.getNode(id) : undefined,
        readBlob: fsStore ? (id) => fsStore.readBlob(id) : undefined,
        saveBlob: fsStore ? (id, bytes) => fsStore.saveBlob(id, bytes) : undefined,
        createNode: fsStore ? (input) => fsStore.createNode(input) : undefined,
        isInTrash: fsStore && fsStore.store ? (id) => fsStore.store.isInTrash(id) : undefined,
        purgeNode: fsStore && fsStore.store ? (id) => fsStore.store.purgeNode(id) : undefined,
        ensureCanvasRoot: fsStore && fsStore.store ? (ownerId) => fsStore.store.ensureCanvasRoot(ownerId) : undefined,
        ensureFolder: fsStore ? (name, parentId, ownerId) => fsStore.ensureFolder(name, parentId, ownerId) : undefined,
        // —— 权限：应用打开判定复用既有 LocalAccountService.canOpenApp（同 requireAppOpen 口径）——
        canOpen: localAccount ? (viewer, appId) => localAccount.canOpenApp(viewer, appId) : undefined,
        // —— 图像工坊等价物：photocraft 域的同一份 bundle ——
        createPhotoCraftProject: photocraftBundle && photocraftBundle.service
          ? (viewer, input) => photocraftBundle.service.createProject(String(viewer.id), { name: input.name, mime: input.mime, content: input.content })
          : undefined,
        canViewPhotoCraftFile: photocraftBundle && typeof photocraftBundle.canViewPhotoCraftFile === "function"
          ? (nodeId, viewer, projectId) => photocraftBundle.canViewPhotoCraftFile(nodeId, viewer && viewer.id, projectId)
          : undefined,
        // —— 画布只读清单：CanvasService.listCanvases 的真实只读投影（只回可编辑画布）——
        listCanvases: canvasDoc ? () => {
          const view = canvasDoc.listCanvases({ context: canvasContext() });
          const items = view && view.ok === true && Array.isArray(view.items) ? view.items : [];
          return items
            .filter((item) => item && item.access && item.access.canEdit === true)
            .map((item) => ({ id: item.canvasId, title: item.title, access: "write" }));
        } : undefined,
        // —— changed：提交成功后把变更推给渲染层（appExchange:event；preload 暂未订阅 onEvent）——
        changed: (canvasId, patch) => {
          if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send("appExchange:event", { type: "changed", canvasId: canvasId == null ? null : String(canvasId), patch: patch == null ? null : patch, at: Date.now() });
          }
        },
        // sharpLoader 不注入：service 内部惰性 require("sharp") 即真实装载路径（缺依赖即结构化不可用）。
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

    // CLI 域（对齐 DX OS 0.6.1 的 /api/cli/* 命令出口）。
    //   · bundle 缺省即复用三个既有 CLI 出口：agent-cli-bridge（codex / gemini）、
    //     agent-cli-tools（即梦）、agent-pippit-tools（小云雀）——只转发，不重写探测 / 执行；
    //   · 未安装 → CLI_UNAVAILABLE（detail 保留既有探测说明）；工具不具备的子能力 → CLI_UNSUPPORTED；
    //   · trusted 与 sessionRef 由本文件注入，渲染层自报身份一概忽略。
    registerDomainOrDegrade("cli", (degraded) => {
      registerCliIpc(ipcMain, {
        bundle: degraded ? null : createCliBundle({}),
        identity: identity.service,
        isTrusted: trusted,
        hostAppId: "cli",
      });
    });

    // D3-04C：注册安全预览协议 handler（每次请求重新授权 + Range 流式返回）。
    protocol.handle("openarc-resource", (request) => identity.previewService.handleProtocolRequest(request));
    // D5-02 / Stage 2：画布 bundle（只读、白名单扩展名、无目录穿越）。
    //   生效顺序：已安装版本（<userData>/dxos/apps/canvas/current.json 指向，整包验签 + 逐文件摘要）
    //   → dist/novai-canvas → public/novai-canvas；任何一步失败都结构化回退并打日志，绝不静默 500/白屏。
    const canvasBundleResolver = createCanvasBundleResolver({
      userDataDir: app.getPath("userData"),
      logger: (record) => console.log("[openarc] canvas-bundle " + JSON.stringify(record)),
    });
    protocol.handle("openarc-canvas", (request) => canvasBundleResolver.handle(request));
    // task-19 A：全部已注册应用的已安装包只读协议（未安装 / 校验失败回 404，渲染层回退内置应用）。
    if (appPackageResolver) {
      protocol.handle("openarc-app", (request) => appPackageResolver.handle(request));
    }
  }

  // ---------------------------------------------------------------------------
  // D3-04 · 本地文件服务。和身份服务同一原则：能力在**主进程**，
  // 渲染进程只拿到"条目索引"，拿不到任意路径读写。
  // ---------------------------------------------------------------------------
  files = createFileService({ userDataDir: app.getPath("userData") });

  protocol.handle("openarc-file", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname === "native") {
        const abs = NATIVE_RESOURCES[url.pathname.replace(/^\/+/, "")];
        if (!abs || !fs.existsSync(abs)) return new Response("Not Found", { status: 404 });
        // 自己回 Range：net.fetch(file://) 既不认 Range 也不给 Content-Length，
        // 媒体因此不可 seek（实测 <video>.seekable 恒为 [0,0]），"减少动态效果"就取不到非黑帧。
        const size = fs.statSync(abs).size;
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
        const start = range?.[1] ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end) return new Response("Range Not Satisfiable", { status: 416 });
        const headers = {
          "Content-Type": NATIVE_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream",
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          // <video crossorigin="anonymous"> 下跨源媒体要能读像素，必须带这个头。
          "Access-Control-Allow-Origin": "*",
        };
        if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
        const body = Readable.toWeb(fs.createReadStream(abs, { start, end }));
        return new Response(body, { status: range ? 206 : 200, headers });
      }
      const parts = url.pathname.split("/").filter(Boolean);
      const hit = files.resolve(decodeURIComponent(parts[0] || ""), decodeURIComponent(parts[1] || ""));
      if (!hit) return new Response("Not Found", { status: 404 });
      // 视频 / 音频（10-15 视频剪辑预览要能拖动进度）：同 native 分支自己回 Range；其它类型照旧。
      const mediaType = MEDIA_TYPES[path.extname(hit.path).toLowerCase()];
      if (mediaType) {
        const size = fs.statSync(hit.path).size;
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
        const start = range?.[1] ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end) return new Response("Range Not Satisfiable", { status: 416 });
        const headers = { "Content-Type": mediaType, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1) };
        if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
        return new Response(Readable.toWeb(fs.createReadStream(hit.path, { start, end })), { status: range ? 206 : 200, headers });
      }
      return await net.fetch(pathToFileURL(hit.path).toString());
    } catch {
      return new Response("Error", { status: 500 });
    }
  });

  // 图片信息（分辨率）：交给 Chromium 的图像解码器，读不出来就说读不出来。
  ipcMain.handle("files:info", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const hit = files.resolve(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
    if (!hit) return { ok: false, error: "NOT_FOUND" };
    try {
      const img = nativeImage.createFromPath(hit.path);
      if (!img || img.isEmpty()) return { ok: false, error: "NO_INFO" };
      const s = img.getSize();
      return { ok: true, width: s.width, height: s.height };
    } catch {
      return { ok: false, error: "NO_INFO" };
    }
  });
  // 拖出到系统（Finder / 桌面）：走 Electron 原生 startDrag，**不是** HTML5 拖拽。
  // 说明：原生拖拽与页面内 HTML5 拖拽互斥，所以它挂在"按住 ⌘ 拖动"上（见渲染层）。
  ipcMain.on("files:startDrag", async (event, payload) => {
    if (!trusted(event)) return;
    const hit = files.resolve(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
    if (!hit) return;
    try {
      const thumb = await nativeImage.createThumbnailFromPath(hit.path, { width: 64, height: 64 });
      event.sender.startDrag({
        file: hit.path,
        icon: thumb && !thumb.isEmpty() ? thumb : nativeImage.createEmpty(),
      });
    } catch {
      /* 拖拽启动失败就当作没有发生 */
    }
  });
  ipcMain.handle("files:copy", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.copy(String(payload?.folderId ?? ""), payload?.ids, String(payload?.toFolderId ?? ""));
  });
  ipcMain.handle("files:move", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.move(String(payload?.folderId ?? ""), payload?.ids, String(payload?.toFolderId ?? ""));
  });
  // 导出到电脑：让用户挑一个**真实目录**，把条目复制出去（不动我们自己的存储）。
  ipcMain.handle("files:export", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const folderId = String(payload?.folderId ?? "");
    const ids = Array.isArray(payload?.ids) ? payload.ids.map(String) : [];
    const picks = ids.map((id) => files.resolve(folderId, id)).filter(Boolean);
    if (!picks.length) return { ok: false, error: "NOT_FOUND" };
    const host = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(host, {
      title: "导出到电脑",
      buttonLabel: "导出到此处",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths?.[0]) return { ok: false, error: "CANCELED" };
    const dest = res.filePaths[0];
    const used = new Set();
    let count = 0;
    for (const hit of picks) {
      try {
        const base = path.basename(hit.path);
        const dot = base.lastIndexOf(".");
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : "";
        let name = base;
        // 不覆盖同名的既有文件：沿用" 2 / 3"的习惯
        for (let i = 2; used.has(name) || fs.existsSync(path.join(dest, name)); i += 1) name = stem + " " + i + ext;
        used.add(name);
        fs.copyFileSync(hit.path, path.join(dest, name));
        count += 1;
      } catch {
        /* 单个失败不影响整批 */
      }
    }
    return { ok: true, count, dest };
  });
  ipcMain.handle("files:import", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const folderId = String(payload && payload.folderId ? payload.folderId : "");
    const paths = Array.isArray(payload && payload.paths) ? payload.paths.slice(0, 200) : [];
    return files.importPaths(folderId, paths);
  });
  ipcMain.handle("files:list", async (e, folderId) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.list(String(folderId ?? ""));
  });
  ipcMain.handle("files:rename", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.rename(String(payload?.folderId ?? ""), String(payload?.id ?? ""), String(payload?.name ?? ""));
  });
  ipcMain.handle("files:remove", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.remove(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
  });
  // 系统级回收站（软删除）。与 remove 的永久删除分开：删除入口走这些通道。
  ipcMain.handle("files:trash", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.trash(String(payload?.folderId ?? ""), String(payload?.id ?? ""), payload?.groupId);
  });
  ipcMain.handle("files:trashList", async (e) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.listTrash();
  });
  ipcMain.handle("files:trashRestore", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.restore(String(payload?.id ?? ""));
  });
  ipcMain.handle("files:trashPurge", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.purge(String(payload?.id ?? ""));
  });
  ipcMain.handle("files:trashEmpty", async (e) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.empty();
  });
  // 视频剪辑（10-15）：本机 FFmpeg。渲染层只给条目引用 + 入出点，路径在这里解析、媒体信息在服务里重新探测。
  const video = createVideoService();
  ipcMain.handle("video:status", async (e) => {
    if (!trusted(e)) throw Error("Forbidden");
    return video.status();
  });
  ipcMain.handle("video:probe", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const hit = files.resolve(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
    if (!hit) return { ok: false, error: "NOT_FOUND" };
    return video.probePath(hit.path);
  });
  ipcMain.handle("video:export", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const outFolder = String(payload?.folderId ?? "");
    const refs = [];
    for (const c of Array.isArray(payload?.clips) ? payload.clips.slice(0, 51) : []) {
      const hit = files.resolve(String(c?.folderId ?? ""), String(c?.id ?? ""));
      if (!hit) return { ok: false, error: "NOT_FOUND" };
      refs.push({ path: hit.path, start: Number(c?.start), end: Number(c?.end) });
    }
    const send = (ev) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("video:progress", ev); };
    const r = await video.exportClips(refs, {
      resolution: String(payload?.resolution ?? "source"),
      name: String(payload?.name ?? ""),
      onProgress: (ratio) => send({ ratio }),
    });
    if (!r.ok) return r;
    try {
      const imported = files.importPaths(outFolder, [r.outPath]);
      const entry = imported.ok && imported.added && imported.added[0];
      return entry ? { ok: true, entry, duration: r.duration } : { ok: false, error: "IMPORT_FAILED" };
    } finally {
      try { fs.rmSync(r.dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无所谓 */ }
    }
  });
  ipcMain.handle("video:cancel", async (e) => {
    if (!trusted(e)) throw Error("Forbidden");
    return video.cancel();
  });
  // 图片声明（10-15）：给访达里的 PNG / JPEG 写入 IPTC 数字来源类型（XMP），原图不动、另存副本到同一文件夹。
  ipcMain.handle("image:declare", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const kind = payload?.kind === "mix" ? "mix" : payload?.kind === "ai" ? "ai" : null;
    if (!kind) return { ok: false, error: "INVALID_INPUT" };
    const items = Array.isArray(payload?.items) ? payload.items.slice(0, 100) : [];
    const results = [];
    for (const it of items) {
      const folderId = String(it?.folderId ?? "");
      const hit = files.resolve(folderId, String(it?.id ?? ""));
      if (!hit) {
        results.push({ id: it?.id, ok: false, error: "NOT_FOUND" });
        continue;
      }
      let dir = null;
      try {
        const ext = path.extname(hit.path).slice(1).toLowerCase();
        const r = declareImage(fs.readFileSync(hit.path), ext, kind);
        if (!r.ok) {
          results.push({ id: it.id, ok: false, error: r.error });
          continue;
        }
        const base = String(hit.entry.name || "图片").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "").slice(0, 80) || "图片";
        dir = fs.mkdtempSync(path.join(app.getPath("temp"), "openarc-declare-"));
        const out = path.join(dir, base + "（来源声明）." + ext);
        fs.writeFileSync(out, r.buffer);
        const imp = files.importPaths(folderId, [out]);
        const entry = imp.ok && imp.added && imp.added[0];
        results.push(entry ? { id: it.id, ok: true, entry, replaced: !!r.replaced } : { id: it.id, ok: false, error: "IMPORT_FAILED" });
      } catch {
        results.push({ id: it.id, ok: false, error: "INTERNAL_ERROR" });
      } finally {
        if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
    return { ok: true, results };
  });
  // 系统信息 / 磁盘空间（10-15，系统设置用）：只读；只回汇总数字，不回路径。
  ipcMain.handle("system:info", async (e) => {
    if (!trusted(e)) throw Error("Forbidden");
    const os = require("node:os");
    const dataDir = app.getPath("userData");
    let disk = null;
    try {
      const st = await fs.promises.statfs(dataDir);
      disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
    } catch {
      disk = null;
    }
    // OpenArc 数据占用：逐层累加文件大小，最多 20000 个条目，超出如实标出
    let used = 0;
    let count = 0;
    let truncated = false;
    const walk = async (dir) => {
      let list = [];
      try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const d of list) {
        if (count >= 20000) { truncated = true; return; }
        count += 1;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) await walk(full);
        else if (d.isFile()) { try { used += (await fs.promises.stat(full)).size; } catch { /* ignore */ } }
      }
    };
    await walk(dataDir);
    return {
      ok: true,
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      // 真实平台；只有测试用 OA_FORCE_PLATFORM 会让它等于被覆盖的平台。
      platform: uiPlatform,
      arch: process.arch,
      osRelease: os.release(),
      cpus: os.cpus().length,
      memory: os.totalmem(),
      disk,
      data: { used, truncated },
    };
  });
  // 天气（10-15）：只经主进程访问 Open-Meteo 两个固定主机；是否联网由用户在天气应用里开启。
  const weather = createWeatherService({ fetchImpl: (url, opts) => net.fetch(url, opts) });
  ipcMain.handle("weather:geocode", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return weather.geocode(String(payload?.name ?? ""));
  });
  ipcMain.handle("weather:forecast", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return weather.forecast(payload?.lat, payload?.lon);
  });
  ipcMain.handle("files:writeText", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.writeText(
      String(payload?.folderId ?? ""),
      payload?.id ? String(payload.id) : "",
      String(payload?.name ?? ""),
      typeof payload?.text === "string" ? payload.text : "",
    );
  });
  ipcMain.handle("files:read", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return files.read(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
  });
  // 缩略图：用 Electron 原生缩略图（macOS/Windows 支持），只回 data URL。
  // 路径解析在 file-service 内部完成，**渲染进程仍然拿不到任何路径**。
  // 系统对"没有缩略器"的类型会返回**通用文档图标**（一张白页）。它不是内容，
  // 渲染层宁愿用自己的线性图标，所以这里先生成一次通用图标做基准、逐次比对拦截。
  let genericIconPng = null;
  async function genericIcon() {
    if (genericIconPng) return genericIconPng;
    try {
      const probe = path.join(app.getPath("temp"), "openarc-generic-probe.zzz");
      fs.writeFileSync(probe, "x");
      const img = await nativeImage.createThumbnailFromPath(probe, { width: 160, height: 160 });
      genericIconPng = img.toPNG();
      try {
        fs.unlinkSync(probe);
      } catch {
        /* 清理失败无所谓 */
      }
    } catch {
      genericIconPng = Buffer.alloc(0);
    }
    return genericIconPng;
  }

  ipcMain.handle("files:thumb", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const hit = files.resolve(String(payload?.folderId ?? ""), String(payload?.id ?? ""));
    if (!hit) return { ok: false, error: "NOT_FOUND" };
    // size 可调：列表缩略图 160，psd/ai 这类浏览器渲染不了的格式在 Quick Look 里要 1024
    const size = Math.min(1024, Math.max(32, Number(payload?.size) || 160));
    try {
      const img = await nativeImage.createThumbnailFromPath(hit.path, { width: size, height: size });
      if (!img || img.isEmpty()) return { ok: false, error: "NO_THUMBNAIL" };
      const png = img.toPNG();
      const generic = await genericIcon();
      if (generic.length && png.equals(generic)) return { ok: false, error: "GENERIC_ICON" };
      return { ok: true, dataUrl: "data:image/png;base64," + png.toString("base64") };
    } catch {
      return { ok: false, error: "NO_THUMBNAIL" };
    }
  });

  // ---------------------------------------------------------------------------
  // 原生视图控制器。它不拥有任何 Window domain 业务规则 ——
  // 窗口该不该存在、谁被聚焦、层级如何，全部由渲染进程的 Window Manager 决定，
  // 通过 windows:sync 把"意图"传下来（ADR §35 / §36）。
  // ---------------------------------------------------------------------------
  controller = new NativeViewController({
    parent: win.contentView,
    // 事实：隐藏视图只让焦点落空、不交还外壳。必须显式移交，否则"键盘没有人收到"。
    onFocusShell: () => {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.focus();
    },
    onEvent: (payload) => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send("native:state", payload);
    },
    // D5-01：下载默认落在系统下载目录；隔离运行（探针/E2E）用 OPENARC_DOWNLOADS_DIR 覆盖，
    // 绝不为了让测试好看而改产品默认值。
    downloadsDir: process.env.OPENARC_DOWNLOADS_DIR || app.getPath("downloads"),
  });
  // 晚绑定：受控浏览器能力的**唯一**原生执行入口就是上面这个控制器。
  browserControl.attachController(controller);
  browserControl.setSession((identity?.service?.snapshot?.userId) || null);

  // ---------------------------------------------------------------------------
  // D5-01 · 会话键（A04）。
  //
  // **它由主进程从已认证 session 推导，渲染进程自报的 userId 一律无效。**
  // 会话键是原生分区名的一部分：切账号 → 另一个分区 → Cookie / 存储 / 下载记录不跨用户。
  // 会话一旦变化，上一个用户的全部网页视图立即释放（绝不留在屏幕上或内存里）。
  // ---------------------------------------------------------------------------
  const sessionKeyNow = () => {
    const s = identity?.service?.snapshot;
    return s && s.userId ? String(s.userId) : null;
  };
  let sessionKey = sessionKeyNow();
  // boot 失败（identityBootFailure）时没有身份服务：不注册这条监听，窗口与文件能力照常可用。
  identity?.service?.onEvent(() => {
    const next = sessionKeyNow();
    if (next === sessionKey) return;
    sessionKey = next;
    try { controller?.releaseAll(); } catch { /* 视图可能已随窗口销毁 */ }
    // 登出 / 切账号：控制目标一律失效，绝不跨用户保留（也绝不改绑到别的标签）。
    try { browserControl?.setSession(next); } catch { /* 控制器可能已随窗口销毁 */ }
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send("native:state", { type: "session-changed", sessionKey: next });
  });

  ipcMain.handle("windows:sync", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    // task-21：标签组命令批处理。沿用既有通道，输入输出都是窗口域的 persisted 形态；
    // 没有 commands 时行为与既有 windows:sync 完全一致（空 intents 契约不变）。
    let windowBatch = null;
    if (Array.isArray(payload?.commands)) {
      windowBatch = applyWindowCommandBatch({
        state: payload.windowState !== undefined ? payload.windowState : payload.state,
        commands: payload.commands,
        areas: Array.isArray(payload.areas) ? payload.areas : null,
      });
      if (!windowBatch.ok) return windowBatch;
    }
    const intents = Array.isArray(payload?.intents) ? payload.intents : [];
    if (intents.length > 32) return { error: "窗口数量超出上限" };
    const results = await controller.sync(intents, {
      overlayOpen: !!payload?.overlayOpen,
      interactive: payload?.interactive !== false,
      // 会话键只来自主进程：renderer 传什么都不看。
      sessionKey,
    });
    // 标签关闭 / 被替换：把死掉的目标从授权表摘掉（绝不是"换个标签继续"）。
    try { browserControl?.pruneDead(); } catch { /* ignore */ }
    return windowBatch ? { ok: true, results, windowBatch } : { ok: true, results };
  });

  // ---------------------------------------------------------------------------
  // 窗口控制（Windows 自绘 caption，方案 B）。
  //
  //   · 动作是冻结白名单：state / minimize / toggleMaximize / close；
  //     renderer 给不出别的，也没有 BrowserWindow / ipcRenderer 句柄。
  //   · close 只调 win.close()：与既有退出路径**完全等价**（本文件末尾只监听 closed，
  //     不拦截 close、不弹确认框，随后 window-all-closed → app.quit()）。
  //     回包先发出、关闭放到 setImmediate：否则窗口先销毁会把这次 invoke 的回包吞掉。
  //   · 状态由主进程主动推 window:state（maximize / unmaximize / 全屏 / 最小化 / 焦点），
  //     渲染层不轮询；查询与推送同形。
  // ---------------------------------------------------------------------------
  const windowState = () => ({
    maximized: !!win && !win.isDestroyed() && win.isMaximized(),
    fullScreen: !!win && !win.isDestroyed() && win.isFullScreen(),
    minimized: !!win && !win.isDestroyed() && win.isMinimized(),
    focused: !!win && !win.isDestroyed() && win.isFocused(),
  });
  const pushWindowState = () => {
    const state = windowState();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      try { win.webContents.send("window:state", state); } catch { /* 窗口正在销毁 */ }
    }
    return state;
  };
  const WINDOW_CONTROL_ACTIONS = Object.freeze(["state", "minimize", "toggleMaximize", "close"]);
  ipcMain.handle("window:control", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const action = typeof payload?.action === "string" ? payload.action : "";
    if (!WINDOW_CONTROL_ACTIONS.includes(action))
      return { ok: false, error: "WINDOW_CONTROL_UNKNOWN_ACTION", message: "未知窗口命令" };
    if (!win || win.isDestroyed())
      return { ok: false, error: "WINDOW_CONTROL_UNAVAILABLE", message: "窗口不可用" };
    if (action === "state") return { ok: true, value: windowState() };
    if (action === "close") {
      const before = windowState();
      console.log("[openarc] 窗口命令 close → " + JSON.stringify(before));
      setImmediate(() => {
        try { if (win && !win.isDestroyed()) win.close(); } catch { /* 已关闭 */ }
      });
      return { ok: true, value: { ...before, closing: true } };
    }
    if (action === "minimize") win.minimize();
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    // maximize / unmaximize 的回调会再推一次；这里等一个 tick 让宿主先落定再取快照。
    await new Promise((resolve) => setImmediate(resolve));
    const state = pushWindowState();
    console.log("[openarc] 窗口命令 " + action + " → " + JSON.stringify(state));
    return { ok: true, value: { ...state, closing: false } };
  });
  for (const event of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "minimize", "restore", "focus", "blur"])
    win.on(event, pushWindowState);

  // ---------------------------------------------------------------------------
  // D5-01 · 浏览器命令面（受控白名单）。
  // 只有"下载记录操作"与"用户确认后的外部打开"两类；没有通用 shell / fs / 任意 IPC。
  // ---------------------------------------------------------------------------
  ipcMain.handle("browser:command", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const type = String(payload?.type || "");
    if (type === "browser/downloads") {
      const action = String(payload?.action || "list");
      if (action === "list") return { ok: true, items: controller.listDownloads(sessionKey) };
      if (action === "clear") {
        controller.clearDownloads(sessionKey);
        return { ok: true, items: controller.listDownloads(sessionKey) };
      }
      const res = controller.downloadAction(action, payload?.downloadId, sessionKey);
      return { ...res, items: controller.listDownloads(sessionKey) };
    }
    // -------------------------------------------------------------------------
    // D5-01 Closure-2 · "允许 AI 控制这个标签"（**用户**在渲染层显式选择）。
    // 复用既有 browser:command 通道：不新增桥键、不新增 IPC 通道、不扩大暴露面。
    // userId 由主进程从已认证 session 推导；renderer 只能给 windowId/tabId，
    // 归属（分区 sessionKey）与存活一律由 BrowserControlAuthority 校验。
    // -------------------------------------------------------------------------
    if (type === "browser/controlList") {
      return { ok: true, targets: browserControl.list({ userId: sessionKeyNow(), appId: "ai" }) };
    }
    if (type === "browser/controlSelect" || type === "browser/controlRelease") {
      const windowId = String(payload?.windowId ?? "");
      const tabId = payload?.tabId == null ? "" : String(payload.tabId);
      if (!windowId || !tabId) return { error: "未知命令" };
      const args = { context: { source: "user" }, userId: sessionKeyNow(), appId: "ai", windowId, tabId };
      const res = type === "browser/controlSelect" ? browserControl.select(args) : browserControl.release(args);
      return { ...res, targets: browserControl.list({ userId: sessionKeyNow(), appId: "ai" }) };
    }
    if (type === "browser/openExternal") {
      // 用户已在 UI 上明确确认；这里仍然拒绝已知危险的 scheme（file/javascript/data/...）。
      const url = String(payload?.url || "");
      const scheme = url.split(":")[0].toLowerCase();
      if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || ["file", "javascript", "data", "vbscript", "blob", "about", "chrome"].includes(scheme))
        return { error: "不支持的协议" };
      return controller.openExternal(url);
    }
    return { error: "未知命令" };
  });

  /**
   * D3-01 身份命令入口 —— 注册在 electron/identity-bootstrap.cjs，
   * 与 UI 探针共用同一份实现（验证的那条线就是产品跑的那条线）。
   */

  ipcMain.handle("browser:navigate", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const windowId = String(payload?.windowId ?? "");
    const tabId = payload?.tabId == null ? null : String(payload.tabId);
    const url = payload?.url;
    if (typeof url !== "string" || !safeURL(url))
      return { error: "请输入完整 HTTP / HTTPS 地址，不支持其他协议或含凭据的网址。" };
    const res = controller.navigate(windowId, url, tabId);
    return res.error ? res : { ok: true };
  });

  ipcMain.handle("browser:action", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const tabId = payload?.tabId == null ? null : String(payload.tabId);
    return controller.act(String(payload?.windowId ?? ""), String(payload?.action ?? ""), tabId);
  });

  // ---------------------------------------------------------------------------
  // D5-01 · 证书错误处理（fail closed，无"继续访问"旁路）。
  //
  // Electron 默认行为不能当作结论：这里显式 preventDefault + callback(false)，
  // 把失败原因回报给 UI（页面本身会以 did-fail-load 收敛到错误页）。
  // 没有"信任一次"的入口 —— 这是刻意的：一个"继续访问"按钮就是 MITM 的入口。
  // ---------------------------------------------------------------------------
  app.on("certificate-error", (event, _wc, url, error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send("native:state", { type: "certificate-error", url: String(url || ""), error: String(error || "") });
  });

  win.on("closed", () => {
    controller?.destroyAll();
    controller = null;
    win = null;
  });

  win.loadURL(uiURL);
  markProductReady();
  win.webContents.once("did-finish-load", () => {
    if (win && !win.isDestroyed()) win.webContents.send("display:changed", displayInfo());
  });
}).catch(recoverFromStartupFailure);

app.on("window-all-closed", () => app.quit());

// SQLite 的连接必须在进程退出前关闭，否则 WAL 里未 checkpoint 的事务会丢。
// D5-03 第三批：关闭应用时 MCP 的 GET 流与在途请求也要及时结束。
// D5-03 第十一批：**Harness 也在途**——退出时必须先停下 Harness 的启动 / 执行、撤销模型与
// 工具能力、回收 harness 子进程与 bridge，然后才停 modelProxy / 关 store；
// 顺序与有界收尾只在 app-shutdown.cjs 里存在一份（真实 main 与验收 probe 共用，避免漂移）。
// 应用退出不是用户取消：只收资源，绝不写 Task/Step/Run 状态（重启后仍走既有 RECOVERY_REQUIRED）。
//
// 退出序列踩过的坑（实测 Electron 44）：在 `.then()` 微任务里再调 app.quit() **不会**让退出
// 序列继续 —— 事件停在 will-quit，进程只能被外部杀掉（最小复现：同样两段代码，微任务挂住、
// 宏任务正常退出）。所以收尾完成后必须把 app.quit() 放到宏任务里；再加一道有界保险丝，
// 万一退出序列仍不推进就显式 exit，绝不把「关不掉的应用」留给用户。
let quitting = false;
app.on("will-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  // B5a：先停媒体子进程（绝不写 Job 状态），再走既有的 MCP → Harness → modelProxy → store 收尾。
  try { if (mediaBundle && typeof mediaBundle.dispose === "function") mediaBundle.dispose(); } catch { /* 已停 */ }
  // B6c：停平台域的进程诊断计时器（不再写磁盘）。
  try { if (platformBundle && typeof platformBundle.dispose === "function") platformBundle.dispose(); } catch { /* 已停 */ }
  // B6a：只停调度器，绝不写运行状态（退出不是用户取消；遗留 running 由下次启动 recoverInterruptedRuns 置 failed）。
  try { if (automationBundle && typeof automationBundle.stopScheduler === "function") automationBundle.stopScheduler(); } catch { /* 已停 */ }
  disposeAppResources({ identity, log: (line) => console.log(line) }).then((res) => {
    try {
      console.log("[openarc] 退出收尾：" + JSON.stringify({ ok: res.ok, harness: res.harness, mcp: res.mcp, proxyStopped: res.proxyStopped, storeClosed: res.storeClosed }));
    } catch { /* 日志失败不阻塞退出 */ }
    setImmediate(() => {
      app.quit();
      setTimeout(() => {
        console.error("[openarc] 退出序列未推进，显式退出");
        app.exit(0);
      }, 3000).unref?.();
    });
  });
});
