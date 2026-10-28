const { app, BrowserWindow, ipcMain, Menu } = require("electron");
const path = require("node:path");
const { registerIdentityIpc } = require("./identity-bootstrap.cjs");
const { disposeAppResources } = require("./app-shutdown.cjs");
const { describeStartupFailure } = require("./runtime-composition.cjs");

function installApplicationMenu({ isMac }) {
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

function createShellWindow(context) {
  const { isMacChrome, glass } = context;
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 700,
    title: "OpenArc OS",
    ...(isMacChrome
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
  context.win = win;
  return win;
}

function recoverFromStartupFailure(context, error) {
  context.identityBootFailure = describeStartupFailure(error);
  console.error("[openarc] 启动失败：" + context.identityBootFailure);
  try { ipcMain.removeHandler("identity:command"); } catch { /* 尚未注册 */ }
  registerIdentityIpc({ ipcMain, service: null, isTrusted: context.trusted, bootError: context.identityBootFailure });
  const win = context.win;
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    const current = win.webContents.getURL();
    if (!current || current === "about:blank") win.loadURL(context.uiURL);
  }
}

function markProductReady(context) {
  const state = {
    at: Date.now(),
    pid: process.pid,
    shellWindow: !!(context.win && !context.win.isDestroyed()),
    ipcRegistered: true,
    uiURL: context.uiURL,
  };
  globalThis.__OPENARC_PRODUCT_READY__ = state;
  try { app.emit("openarc:product-ready", state); } catch { /* 没有监听者也要能启动 */ }
  return state;
}

function installWindowClosedHandler(context) {
  const win = context.win;
  win.on("closed", () => {
    context.controller?.destroyAll();
    context.controller = null;
    context.win = null;
  });
}

function loadShell(context) {
  const win = context.win;
  win.loadURL(context.uiURL);
  markProductReady(context);
  win.webContents.once("did-finish-load", () => {
    if (context.win && !context.win.isDestroyed()) context.win.webContents.send("display:changed", context.displayInfo());
  });
}

function installAppLifecycle(context) {
  app.on("window-all-closed", () => app.quit());

  // 退出不是用户取消：不改 Task/Step/Run 状态；资源顺序仍由 app-shutdown.cjs 唯一持有。
  let quitting = false;
  app.on("will-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    try { if (context.mediaBundle && typeof context.mediaBundle.dispose === "function") context.mediaBundle.dispose(); } catch { /* 已停 */ }
    try { if (context.platformBundle && typeof context.platformBundle.dispose === "function") context.platformBundle.dispose(); } catch { /* 已停 */ }
    try { if (context.automationBundle && typeof context.automationBundle.stopScheduler === "function") context.automationBundle.stopScheduler(); } catch { /* 已停 */ }
    disposeAppResources({ identity: context.identity, log: (line) => console.log(line) }).then((result) => {
      try {
        console.log("[openarc] 退出收尾：" + JSON.stringify({ ok: result.ok, harness: result.harness, mcp: result.mcp, proxyStopped: result.proxyStopped, storeClosed: result.storeClosed }));
      } catch { /* 日志失败不阻塞退出 */ }
      // Electron 44 需要从宏任务继续退出序列；保留有界保险丝。
      setImmediate(() => {
        app.quit();
        setTimeout(() => {
          console.error("[openarc] 退出序列未推进，显式退出");
          app.exit(0);
        }, 3000).unref?.();
      });
    });
  });
}

module.exports = {
  installApplicationMenu,
  createShellWindow,
  recoverFromStartupFailure,
  installWindowClosedHandler,
  loadShell,
  installAppLifecycle,
};
