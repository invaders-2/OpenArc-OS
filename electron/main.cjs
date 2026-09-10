const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  screen,
} = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { safeURL, safeBounds } = require("./policy.cjs");
const geometry = require("./geometry.cjs");
let win, view;
const uiURL = pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
function trusted(event) {
  return event.sender === win?.webContents && event.senderFrame?.url === uiURL;
}
function publish(error = "") {
  if (win && !win.isDestroyed() && view && !view.webContents.isDestroyed())
    win.webContents.send("browser:state", {
      url: view.webContents.getURL(),
      loading: view.webContents.isLoading(),
      title: view.webContents.getTitle(),
      error,
    });
}
const isMac = process.platform === "darwin";
const glass = isMac
  ? {
      transparent: true,
      vibrancy: "under-window",
      backgroundColor: "#00000000",
    }
  : { backgroundMaterial: "mica", backgroundColor: "#00000000" };
app.whenReady().then(() => {
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
  // A05：显示器变化后必须把原生窗口拉回可见工作区。
  // Electron 的 setBounds 不做可见性校验，窗口落在已拔掉的屏幕上不会被自动归位。
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
  const publishDisplays = () => {
    if (win && !win.isDestroyed())
      win.webContents.send("display:changed", displayInfo());
  };
  for (const event of [
    "display-added",
    "display-removed",
    "display-metrics-changed",
  ])
    screen.on(event, () => {
      ensureWindowVisible();
      publishDisplays();
    });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== uiURL) e.preventDefault();
  });
  const isolated = session.fromPartition("openarc-browser-d1");
  isolated.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on("will-download", (e) => {
    e.preventDefault();
    publish("D1 尚未启用下载管理，下载已阻止。");
  });
  view = new WebContentsView({
    webPreferences: {
      session: isolated,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.contentView.addChildView(view);
  view.setVisible(false);
  view.webContents.setWindowOpenHandler(() => {
    publish("弹出窗口已阻止，请在地址栏打开链接。");
    return { action: "deny" };
  });
  for (const name of ["will-navigate", "will-redirect"])
    view.webContents.on(name, (e, url) => {
      if (!safeURL(url)) {
        e.preventDefault();
        publish("仅允许 HTTP / HTTPS 网页。");
      }
    });
  view.webContents.on("will-attach-webview", (e) => e.preventDefault());
  for (const name of [
    "did-navigate",
    "did-navigate-in-page",
    "did-start-loading",
    "did-stop-loading",
    "page-title-updated",
  ])
    view.webContents.on(name, () => publish());
  view.webContents.on("did-fail-load", (_e, code, description, _url, main) => {
    if (main && code !== -3) publish(`网页加载失败：${description}`);
  });
  ipcMain.handle("browser:navigate", async (e, url) => {
    if (!trusted(e)) throw Error("Forbidden");
    const valid = typeof url === "string" && safeURL(url);
    if (!valid)
      return {
        error: "请输入完整 HTTP / HTTPS 地址，不支持其他协议或含凭据的网址。",
      };
    try {
      await view.webContents.loadURL(valid);
      return { ok: true };
    } catch {
      return { error: "网页加载失败，请检查网络或地址。" };
    }
  });
  ipcMain.handle("browser:layout", (e, p) => {
    if (!trusted(e)) throw Error("Forbidden");
    const b = safeBounds(p?.bounds, win.getContentSize());
    if (!b || !p.visible) {
      view.setVisible(false);
      return;
    }
    view.setBounds(b);
    view.setVisible(b.width > 0 && b.height > 0);
  });
  ipcMain.handle("browser:action", (e, action) => {
    if (!trusted(e)) throw Error("Forbidden");
    const h = view.webContents.navigationHistory;
    if (action === "back" && h.canGoBack()) h.goBack();
    if (action === "forward" && h.canGoForward()) h.goForward();
    if (action === "reload") view.webContents.reload();
  });
  win.on("closed", () => {
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    win = null;
  });
  win.loadURL(uiURL);
  win.webContents.once("did-finish-load", publishDisplays);
});
app.on("window-all-closed", () => app.quit());
