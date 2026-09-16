const { app, BrowserWindow, ipcMain, safeStorage, screen, dialog, protocol, nativeImage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { safeURL } = require("./policy.cjs");
const geometry = require("./geometry.cjs");
const { NativeViewController } = require("./native-view-controller.cjs");
const { createIdentityService, registerIdentityIpc } = require("./identity-bootstrap.cjs");
const { registerTaskIpc } = require("./task-bootstrap.cjs");

let win;
let controller;
let identity;

const uiURL = pathToFileURL(path.join(__dirname, "../dist/index.html")).href;

// D3-04C：安全预览自定义协议。**必须在 app ready 之前**注册 privileges。
// Renderer 只能拿到 openarc-resource:// 短时 capability URL，绝不接触本地路径。
protocol.registerSchemesAsPrivileged([
  { scheme: "openarc-resource", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
]);

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

app.whenReady().then(async () => {
  // D4-04：Model Proxy 是 Harness Model Adapter 的上游；必须在任何 Task 之前启动。
  // 否则 Harness 会得到 HARNESS_MODEL_PROXY_UNAVAILABLE（fail closed）。
  try { await identity.modelProxy.start(); } catch { /* proxy 启动失败时 Harness fail closed */ }
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
  // D3-01 · 身份服务（唯一权威，§25）
  //
  // 它住在**主进程**：渲染进程只能通过 `identity:command` 派发命令，
  // 拿回 sanitize 过的快照。session token 从未越过这条边界。
  // ---------------------------------------------------------------------------
  identity = createIdentityService({
    userDataDir: app.getPath("userData"),
    safeStorage,
    nativeImage,
    // admin / 测试夹具命令默认关闭：产品 UI 里没有入口，也不该有。
    // 只有显式置 OPENARC_IDENTITY_ADMIN=1 才放行（探针与未来的管理端用）。
    allowAdmin: process.env.OPENARC_IDENTITY_ADMIN === "1",
    // Control Service 身份（§60）：New Device 配对此前必须先能确认"这是我要加入的服务"。
    // 未配置时配对会因 SERVICE_IDENTITY_MISMATCH 被拒 —— 失败关闭，不做 TOFU。
    serviceIdentity: process.env.OPENARC_SERVICE_IDENTITY || null,
  });
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
  });

  ipcMain.handle("windows:sync", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const intents = Array.isArray(payload?.intents) ? payload.intents : [];
    if (intents.length > 32) return { error: "窗口数量超出上限" };
    const results = await controller.sync(intents, {
      overlayOpen: !!payload?.overlayOpen,
      interactive: payload?.interactive !== false,
    });
    return { ok: true, results };
  });

  /**
   * D3-01 身份命令入口 —— 注册在 electron/identity-bootstrap.cjs，
   * 与 UI 探针共用同一份实现（验证的那条线就是产品跑的那条线）。
   */

  ipcMain.handle("browser:navigate", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const windowId = String(payload?.windowId ?? "");
    const url = payload?.url;
    if (typeof url !== "string" || !safeURL(url))
      return { error: "请输入完整 HTTP / HTTPS 地址，不支持其他协议或含凭据的网址。" };
    const res = controller.navigate(windowId, url);
    return res.error ? res : { ok: true };
  });

  ipcMain.handle("browser:action", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    return controller.act(String(payload?.windowId ?? ""), String(payload?.action ?? ""));
  });

  win.on("closed", () => {
    controller?.destroyAll();
    controller = null;
    win = null;
  });

  win.loadURL(uiURL);
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
