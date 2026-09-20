const { app, BrowserWindow, ipcMain, safeStorage, screen, dialog, protocol, nativeImage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { safeURL } = require("./policy.cjs");
const geometry = require("./geometry.cjs");
const { NativeViewController } = require("./native-view-controller.cjs");
const { BrowserControlAuthority } = require("./browser-control-authority.cjs");
const { registerIdentityIpc } = require("./identity-bootstrap.cjs");
// D5-02：无限画布的宿主命令面（文档层实例由 identity-bootstrap 装配，AI 工具用同一个）。
const { registerCanvasIpc } = require("./canvas-bootstrap.cjs");
const { registerTaskIpc } = require("./task-bootstrap.cjs");
const { createDefaultExecutorLauncher } = require("./executor-launcher.cjs");
const { createOpenArcRuntime } = require("./runtime-boot.cjs");

let win;
let controller;
let identity;
/** D5-02：画布文档服务（AI 编辑工具的执行端与渲染层命令共用同一个实例）。*/
let canvasBundle;
/** D5-01 Closure-2：受控浏览器目标（用户显式授权）。宿主持有唯一实例，工具链与 UI 共用同一个。 */
let browserControl;

const uiURL = pathToFileURL(path.join(__dirname, "../dist/index.html")).href;

// D3-04C：安全预览自定义协议。**必须在 app ready 之前**注册 privileges。
// Renderer 只能拿到 openarc-resource:// 短时 capability URL，绝不接触本地路径。
protocol.registerSchemesAsPrivileged([
  { scheme: "openarc-resource", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
  // D5-02：无限画布 bundle 的自定义协议（iframe 用；**只读**目录白名单，无目录穿越）。
  // corsEnabled：画布 iframe 是 opaque origin，字体等子资源必须能跨源取（静态只读 bundle）。
  { scheme: "openarc-canvas", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

/**
 * D5-02 · 画布 bundle 的只读协议 handler。
 *
 * 画布页面跑在 sandbox iframe（allow-scripts，opaque origin）里，不接触 file:// 与用户目录：
 * 它只能读到 dist/novai-canvas 下白名单扩展名的文件（其余 403/404）。
 */
const CANVAS_MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf", ".woff": "font/woff", ".ico": "image/x-icon" };
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
  return event.sender === win?.webContents && event.senderFrame?.url === uiURL;
}

const isMac = process.platform === "darwin";
const glass = isMac
  ? { transparent: true, vibrancy: "under-window", backgroundColor: "#00000000" }
  : { backgroundMaterial: "mica", backgroundColor: "#00000000" };

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
  const runtime = await createOpenArcRuntime({
    userDataDir: app.getPath("userData"),
    safeStorage,
    nativeImage,
    // production executor 由 Electron utilityProcess.fork 启动（Node-enabled child，
    // 不依赖 ELECTRON_RUN_AS_NODE / runAsNode fuse）；生命周期权威仍是 RuntimeSupervisor。
    executorLauncher: createDefaultExecutorLauncher(),
    // admin / 测试夹具命令默认关闭：产品 UI 里没有入口，也不该有。
    // 只有显式置 OPENARC_IDENTITY_ADMIN=1 才放行（探针与未来的管理端用）。
    allowAdmin: process.env.OPENARC_IDENTITY_ADMIN === "1",
    // Control Service 身份（§60）：未配置时配对会因 SERVICE_IDENTITY_MISMATCH 被拒 —— 失败关闭。
    serviceIdentity: process.env.OPENARC_SERVICE_IDENTITY || null,
    browserControl,
  });
  identity = runtime.identity;

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
    if (url !== uiURL) e.preventDefault();
  });

  // ---------------------------------------------------------------------------
  // D3-01 · 身份服务（唯一权威，§25）已在 runtime boot 中创建；
  // 接下来只注册 IPC：渲染进程只能通过 `identity:command` 派发命令，
  // 拿回 sanitize 过的快照。session token 从未越过这条边界。
  // ---------------------------------------------------------------------------
  registerIdentityIpc({
    ipcMain,
    service: identity.service,
    authorization: identity.authorization,
    device: identity.deviceService,
    // D3-04A：资源命令。导入/链接的文件选择在主进程完成，路径不回渲染进程。
    resource: identity.resourceService,
    resourceSearch: identity.searchService,
    resourcePreview: identity.previewService,
    // D3-04D：治理 / Projects / Canvas / Picker。
    governance: identity.governanceService,
    projects: identity.projectService,
    canvas: identity.canvasService,
    picker: identity.pickerService,
    // D4-01：模型命令（Settings → Models；无 raw credential / proxy capability）。
    model: identity.modelService,
    // D4-03C4：Trusted Approval Gateway（只暴露安全 approval 投影 + trusted user decision）。
    sideEffect: identity.sideEffectGateway,
    dialog,
    shell,
    BrowserWindow,
    isTrusted: trusted,
    send: (event) => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send("identity:event", event);
    },
    sendSideEffect: (event) => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send("sideeffect:event", event);
    },
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

  // D3-04C：注册安全预览协议 handler（每次请求重新授权 + Range 流式返回）。
  protocol.handle("openarc-resource", (request) => identity.previewService.handleProtocolRequest(request));
  // D5-02：画布 bundle（只读、白名单扩展名、无目录穿越）。
  protocol.handle("openarc-canvas", (request) => handleCanvasProtocol(request));

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
  identity.service.onEvent(() => {
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
});

app.on("window-all-closed", () => app.quit());

// SQLite 的连接必须在进程退出前关闭，否则 WAL 里未 checkpoint 的事务会丢
app.on("will-quit", () => {
  try {
    identity?.modelProxy?.stop();
  } catch {
    /* 已关闭 */
  }
  try {
    identity?.store?.close();
  } catch {
    /* 已关闭 */
  }
});
