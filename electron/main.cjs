const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  screen,
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
// B3：Agent 域装配（真实 SQLite = identity 的连接）与 agent:command / agent:event 通道。
const { createAgentBundle } = require("./agent-service.cjs");
const { registerAgentIpc } = require("./agent-bootstrap.cjs");
// B4：技能域装配（<userData>/dxos 下的技能目录 / 技能包 / 执行器）与 skill:command / skill:event 通道。
const { createSkillBundle } = require("./skill-service.cjs");
const { registerSkillIpc } = require("./skill-bootstrap.cjs");
// B4 · providerAdapter 桥：把 B2 的 provider-protocol store/service 投影成 B4 执行器要的只读适配器
// （firstUsable/all/autoFallback/revealProvider/call）；只读投影绝不返回 api_key/credentialRef。
const { createProviderAdapter } = require("./provider-adapter-bridge.cjs");
// D5-03：MCP 中心的宿主命令面（连接管理 + 能力发现；本批不开放工具调用）。
const { registerMcpIpc } = require("./mcp-bootstrap.cjs");
// B4 收口：把已装配的 MCP 连接目录（identity.mcpService）只读投影成 agent 工具目录的 mcp 来源。
const { createMcpAgentBridge } = require("./mcp-agent-bridge.cjs");
// D5-03 第十一批：关应用的唯一收尾顺序（MCP → Harness → modelProxy → store）。
const { disposeAppResources } = require("./app-shutdown.cjs");
const { createDefaultExecutorLauncher } = require("./executor-launcher.cjs");
const { createOpenArcRuntime } = require("./runtime-boot.cjs");
const { createFileService } = require("./file-service.cjs");

let win;
let controller;
let identity;
let files;
/** 身份服务创建失败时的人话原因；渲染层经 identity:command 的既有通道拿到它。 */
let identityBootFailure = null;
/** D5-02：画布文档服务（AI 编辑工具的执行端与渲染层命令共用同一个实例）。*/
let canvasBundle;
/** B3：Agent 域 bundle（createAgentBundle 的唯一实例；无身份服务时为 undefined）。 */
let agentBundle;
/** B4：技能域 bundle（createSkillBundle 的唯一实例；无身份服务时为 undefined）。 */
let skillBundle;
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
const uiURL = devURL || pathToFileURL(path.join(__dirname, "../dist/index.html")).href;

if (devURL) console.log("[openarc] 开发预览：加载 " + devURL + "（OA_DEV_SERVER 已设置）");

// D3-04C：安全预览自定义协议。**必须在 app ready 之前**注册 privileges。
// Renderer 只能拿到 openarc-resource:// 短时 capability URL，绝不接触本地路径。
protocol.registerSchemesAsPrivileged([
  { scheme: "openarc-resource", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
  // D5-02：无限画布 bundle 的自定义协议（iframe 用；**只读**目录白名单，无目录穿越）。
  // corsEnabled：画布 iframe 是 opaque origin，字体等子资源必须能跨源取（静态只读 bundle）。
  { scheme: "openarc-canvas", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
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

/**
 * D5-02 · 画布 bundle 的只读协议 handler。
 *
 * 画布页面跑在 sandbox iframe（allow-scripts，opaque origin）里，不接触 file:// 与用户目录：
 * 它只能读到 dist/novai-canvas 下白名单扩展名的文件（其余 403/404）。
 */
const CANVAS_MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".woff2": "font/woff2", ".ttf": "font/ttf", ".woff": "font/woff", ".ico": "image/x-icon" };
function handleCanvasProtocol(request) {
  let url;
  try { url = new URL(request.url); } catch { return new Response("bad request", { status: 400 }); }
  const rel = decodeURIComponent(url.pathname).replace(/^[/]+/, "");
  if (!rel || rel.includes("..") || rel.includes("\\") || rel.includes('\0')) return new Response("forbidden", { status: 403 });
  const ext = path.extname(rel).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(CANVAS_MIME, ext)) return new Response("forbidden", { status: 403 });
  const distRoot = path.join(__dirname, "../dist/novai-canvas");
  const publicRoot = path.join(__dirname, "../public/novai-canvas");
  const base = fs.existsSync(distRoot) ? distRoot : publicRoot;
  const file = path.resolve(base, rel);
  if (!file.startsWith(path.resolve(base) + path.sep)) return new Response("forbidden", { status: 403 });
  if (!fs.existsSync(file)) return new Response("not found", { status: 404 });
  // 画布跑在 opaque origin（sandbox allow-scripts）里：字体等子资源需要 CORS 头才能加载。
  // 这是**只读静态 bundle**、无凭据、无用户数据，因此允许任意来源读取。
  return new Response(fs.readFileSync(file), { status: 200, headers: { "content-type": CANVAS_MIME[ext], "access-control-allow-origin": "*" } });
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
    // Windows 没有等价"保留控件"的方式，直接 frame:false（Windows 尚未验证）。
    ...(isMac
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

  // D5-03：MCP 中心（mcp:command 单一通道；sessionRef/appId 由主进程注入，本批不开放工具调用）。
  // boot 失败时以 service:null 注册，渲染层拿到 mcp-not-ready 的稳定错误，而不是 "No handler registered"。
  registerMcpIpc({ ipcMain, service: identity?.mcpService ?? null, identity: identity?.service ?? null, isTrusted: trusted });

  // 身份 runtime 存在时才注册依赖它的能力；boot 失败时窗口仍照常加载并走 BootRetry。
  if (identity) {
    // W5：把 provider-protocol 的流式事件接到 model:event。与 identity:event / task:event /
    // sideeffect:event 同一条 trusted(event) 边界；send 只转发主进程已封装的 P1 信封。
    wireModelEvents({
      service: identity.modelService,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("model:event", event); },
    });

    // ---------------------------------------------------------------------------
    // D5-02 · 无限画布：文档层 + 资源可用性 + 命令层。
    // 画布页面运行在 sandbox iframe 里（无 openarc 桥 / 无 IPC / 无 fs / 无凭据），
    // 它的全部请求都由宿主渲染层经 canvas:command 转发到这里。
    // ---------------------------------------------------------------------------
    canvasBundle = { service: identity.canvasDocService };
    registerCanvasIpc({ ipcMain, service: identity.canvasDocService, identity: identity.service, isTrusted: trusted });

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

    // B4：技能域。
    //   · <userData>/dxos 注入 configureSkillStore / configureSkillPack / configureSkillRunner / configureSkillAnalyzer /
    //     configureSkillWorkspace（路径由 dxos-foundation-paths.cjs 统一解析）；
    //   · providerAdapter 由 B2 的 provider-protocol store/service 组装（provider-adapter-bridge.cjs）；
    //     cliRuntime / mediaAdapter / fsAdapter 属 B3/B5/B6，未落地 → 传 null，命令侧保持结构化依赖缺失（绝不伪造）；
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
      fsAdapter: null,
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
    //   · fsAdapter / workspaceAdapter 属 B6，未落地 → 命令侧保持结构化 AGENT_DEPENDENCY_UNAVAILABLE；
    //   · agent:event 与 model:event / task:event 同一条 trusted(event) 边界，renderer 只能订阅。
    // B4 收口：MCP → Agent 工具目录的只读桥。
    //   · 目录：mcpService.listConnections（appId=mcp-center 基线授权）→ 只列用户/组织真实可见的 server；
    //     未连接/停用/无工具一律照实投影（status 非 connected、executable:false），不伪造 connected。
    //   · 调用：不注入 approval / transport —— createMcpAgentTools 会先 fail closed（审批缺失，0 次传输），
    //     即便放行也回 MCP_TOOL_INVOCATION_NOT_ENABLED（mcp-client.cjs:832-834 的产品边界未放宽）。
    const mcpAgentBridge = identity.mcpService
      ? createMcpAgentBridge({
          mcpService: identity.mcpService,
          // sessionRef 只由主进程从已认证身份推导（渲染层给不了）；appId 用 MCP 中心的承载 Principal。
          context: () => ({ sessionRef: (identity.service && identity.service.current) || null, appId: "mcp-center" }),
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
    });
    registerAgentIpc({
      ipcMain,
      bundle: agentBundle,
      identity: identity.service,
      isTrusted: trusted,
      send: (event) => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("agent:event", event); },
    });

    // D3-04C：注册安全预览协议 handler（每次请求重新授权 + Range 流式返回）。
    protocol.handle("openarc-resource", (request) => identity.previewService.handleProtocolRequest(request));
    // D5-02：画布 bundle（只读、白名单扩展名、无目录穿越）。
    protocol.handle("openarc-canvas", (request) => handleCanvasProtocol(request));
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
    return { ok: true, results };
  });

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
