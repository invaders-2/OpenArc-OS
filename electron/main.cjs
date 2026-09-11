const { app, BrowserWindow, ipcMain, safeStorage, screen, Menu, nativeImage, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { safeURL } = require("./policy.cjs");
const geometry = require("./geometry.cjs");
const { NativeViewController } = require("./native-view-controller.cjs");
const { createIdentityService, registerIdentityIpc } = require("./identity-bootstrap.cjs");
const { createFileService } = require("./file-service.cjs");

let win;
let controller;
let identity;
let files;

/**
 * 只读文件协议（Quick Look 的流式媒体源）。
 * 必须在 app ready **之前**登记为 privileged —— 否则 <video> 不能 seek/stream，
 * 大视频只能塞 data URL（内存爆）。它只服务 openarc-file://media/<folderId>/<id>，
 * 路径解析走 file-service 的白名单，且只注册在默认 session：
 * 原生网页视图用的是独立 partition，**够不到这个协议**。
 */
// 真实启动路径：本模块在 app ready 之前被 require，注册一定生效。
// 安全探针等 harness 会在 ready 之后才 require 本模块，那时再调会抛错 —— 显式跳过，
// 探针本身不测这个协议（它测的是 preload 暴露面与 IPC 通道）。
if (!app.isReady()) {
  protocol.registerSchemesAsPrivileged([
    { scheme: "openarc-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

const uiURL = pathToFileURL(path.join(__dirname, "../dist/index.html")).href;

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

app.whenReady().then(() => {
  installApplicationMenu();
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
      ? { titleBarStyle: "hidden", trafficLightPosition: { x: 20, y: 16 } }
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
    // admin / 测试夹具命令默认关闭：产品 UI 里没有入口，也不该有。
    // 只有显式置 OPENARC_IDENTITY_ADMIN=1 才放行（探针与未来的管理端用）。
    allowAdmin: process.env.OPENARC_IDENTITY_ADMIN === "1",
  });
  registerIdentityIpc({
    ipcMain,
    service: identity.service,
    isTrusted: trusted,
    send: (event) => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
      win.webContents.send("identity:event", event);
    },
  });

  // ---------------------------------------------------------------------------
  // D3-04 · 本地文件服务。和身份服务同一原则：能力在**主进程**，
  // 渲染进程只拿到"条目索引"，拿不到任意路径读写。
  // ---------------------------------------------------------------------------
  files = createFileService({ userDataDir: app.getPath("userData") });

  protocol.handle("openarc-file", async (request) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      const hit = files.resolve(decodeURIComponent(parts[0] || ""), decodeURIComponent(parts[1] || ""));
      if (!hit) return new Response("Not Found", { status: 404 });
      return await net.fetch(pathToFileURL(hit.path).toString());
    } catch {
      return new Response("Error", { status: 500 });
    }
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
    try {
      const img = await nativeImage.createThumbnailFromPath(hit.path, { width: 160, height: 160 });
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
    identity?.store?.close();
  } catch {
    /* 已关闭 */
  }
});
