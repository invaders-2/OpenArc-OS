const { app, ipcMain, screen } = require("electron");
const geometry = require("./geometry.ts");
const { safeURL } = require("./policy.cjs");
const { NativeViewController } = require("./native-view-controller.cjs");
const { applyWindowCommandBatch } = require("./window-command-ipc.cjs");

let win;

function installDisplayHandlers(context) {
  win = context.win;
  const displayInfo = () => screen.getAllDisplays().map((display) => ({
    id: display.id,
    scaleFactor: display.scaleFactor,
    workArea: display.workArea,
    internal: display.internal,
    primary: display.id === screen.getPrimaryDisplay().id,
  }));
  const ensureWindowVisible = () => {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const areas = screen.getAllDisplays().map((display) => display.workArea);
    if (areas.some((area) => geometry.intersects(bounds, area))) return;
    const primary = screen.getPrimaryDisplay().workArea;
    win.setBounds({
      x: primary.x + 40,
      y: primary.y + 40,
      width: Math.max(geometry.MIN_W, Math.min(bounds.width, primary.width - 80)),
      height: Math.max(geometry.MIN_H, Math.min(bounds.height, primary.height - 80)),
    });
  };
  for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
    screen.on(event, () => {
      ensureWindowVisible();
      if (win && !win.isDestroyed()) win.webContents.send("display:changed", displayInfo());
    });
  }
  context.displayInfo = displayInfo;
}

function registerWindowBrowserIpc(context) {
  const { trusted, identity, browserControl } = context;
  win = context.win;
  const controller = new NativeViewController({
    parent: win.contentView,
    onFocusShell: () => {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.focus();
    },
    onEvent: (payload) => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send("native:state", payload);
    },
    downloadsDir: process.env.OPENARC_DOWNLOADS_DIR || app.getPath("downloads"),
  });
  context.controller = controller;
  browserControl.attachController(controller);
  browserControl.setSession((identity?.service?.snapshot?.userId) || null);

  // 会话键只从已认证 identity 推导；切账号先释放上一用户的原生视图和浏览器控制目标。
  const sessionKeyNow = () => {
    const snapshot = identity?.service?.snapshot;
    return snapshot && snapshot.userId ? String(snapshot.userId) : null;
  };
  let sessionKey = sessionKeyNow();
  identity?.service?.onEvent(() => {
    const next = sessionKeyNow();
    if (next === sessionKey) return;
    sessionKey = next;
    try { context.controller?.releaseAll(); } catch { /* 视图可能已随窗口销毁 */ }
    try { browserControl?.setSession(next); } catch { /* 控制器可能已随窗口销毁 */ }
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("native:state", { type: "session-changed", sessionKey: next });
    }
  });

  ipcMain.handle("windows:sync", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
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
    const results = await context.controller.sync(intents, {
      overlayOpen: !!payload?.overlayOpen,
      interactive: payload?.interactive !== false,
      sessionKey,
    });
    try { browserControl?.pruneDead(); } catch { /* ignore */ }
    return windowBatch ? { ok: true, results, windowBatch } : { ok: true, results };
  });

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
    if (!WINDOW_CONTROL_ACTIONS.includes(action)) {
      return { ok: false, error: "WINDOW_CONTROL_UNKNOWN_ACTION", message: "未知窗口命令" };
    }
    if (!win || win.isDestroyed()) {
      return { ok: false, error: "WINDOW_CONTROL_UNAVAILABLE", message: "窗口不可用" };
    }
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
    await new Promise((resolve) => setImmediate(resolve));
    const state = pushWindowState();
    console.log("[openarc] 窗口命令 " + action + " → " + JSON.stringify(state));
    return { ok: true, value: { ...state, closing: false } };
  });
  for (const event of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "minimize", "restore", "focus", "blur"]) {
    win.on(event, pushWindowState);
  }

  ipcMain.handle("browser:command", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const type = String(payload?.type || "");
    if (type === "browser/downloads") {
      const action = String(payload?.action || "list");
      if (action === "list") return { ok: true, items: context.controller.listDownloads(sessionKey) };
      if (action === "clear") {
        context.controller.clearDownloads(sessionKey);
        return { ok: true, items: context.controller.listDownloads(sessionKey) };
      }
      const result = context.controller.downloadAction(action, payload?.downloadId, sessionKey);
      return { ...result, items: context.controller.listDownloads(sessionKey) };
    }
    if (type === "browser/controlList") {
      return { ok: true, targets: browserControl.list({ userId: sessionKeyNow(), appId: "ai" }) };
    }
    if (type === "browser/controlSelect" || type === "browser/controlRelease") {
      const windowId = String(payload?.windowId ?? "");
      const tabId = payload?.tabId == null ? "" : String(payload.tabId);
      if (!windowId || !tabId) return { error: "未知命令" };
      const args = { context: { source: "user" }, userId: sessionKeyNow(), appId: "ai", windowId, tabId };
      const result = type === "browser/controlSelect" ? browserControl.select(args) : browserControl.release(args);
      return { ...result, targets: browserControl.list({ userId: sessionKeyNow(), appId: "ai" }) };
    }
    if (type === "browser/openExternal") {
      const url = String(payload?.url || "");
      const scheme = url.split(":")[0].toLowerCase();
      if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || ["file", "javascript", "data", "vbscript", "blob", "about", "chrome"].includes(scheme)) {
        return { error: "不支持的协议" };
      }
      return context.controller.openExternal(url);
    }
    return { error: "未知命令" };
  });

  ipcMain.handle("browser:navigate", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const windowId = String(payload?.windowId ?? "");
    const tabId = payload?.tabId == null ? null : String(payload.tabId);
    const url = payload?.url;
    if (typeof url !== "string" || !safeURL(url)) {
      return { error: "请输入完整 HTTP / HTTPS 地址，不支持其他协议或含凭据的网址。" };
    }
    const result = context.controller.navigate(windowId, url, tabId);
    return result.error ? result : { ok: true };
  });

  ipcMain.handle("browser:action", async (e, payload) => {
    if (!trusted(e)) throw Error("Forbidden");
    const tabId = payload?.tabId == null ? null : String(payload.tabId);
    return context.controller.act(String(payload?.windowId ?? ""), String(payload?.action ?? ""), tabId);
  });
}

module.exports = { installDisplayHandlers, registerWindowBrowserIpc };
