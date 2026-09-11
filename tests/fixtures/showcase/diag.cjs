/** 诊断：WebContentsView 到底有没有真实显示在窗口上（像素级）。 */
const { app, BrowserWindow, ipcMain } = require("electron");
const { execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { NativeViewController } = require(path.join(ROOT, "electron/native-view-controller.cjs"));
const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const OUT = path.join(ROOT, "artifacts", "showcase");

const out = (l) => process.stdout.write(l + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.DIAG_NO_GPU === "1") app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const transparent = process.env.DIAG_TRANSPARENT === "1";
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    transparent,
    vibrancy: transparent ? "under-window" : undefined,
    backgroundColor: transparent ? "#00000000" : "#ffffff",
    webPreferences: {
      preload: process.env.DIAG_NO_PRELOAD === "1" ? undefined : path.join(ROOT, "electron/preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const controller = new NativeViewController({ parent: win.contentView, onEvent: (e) => out("EVENT " + JSON.stringify(e)) });
  ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
  ipcMain.handle("browser:navigate", async () => ({ ok: true }));
  ipcMain.handle("browser:action", async () => ({ ok: true }));

  if (process.env.DIAG_SKIP_UI === "1") await win.loadURL("about:blank");
  else await win.loadURL(uiURL);
  win.show();
  win.focus();
  win.setAlwaysOnTop(true, "screen-saver");
  await sleep(600);

  // 不经过 DOM 窗口系统，直接挂一个原生视图在固定 bounds 上 ——
  // 目的：隔离「视图本身能不能显示」与「DOM 下发的 viewport/遮挡结算」两个变量。
  const intent = {
    windowId: "diag-browser",
    kind: "browser",
    present: true,
    url: "https://example.com",
    viewport: { x: 100, y: 100, width: 800, height: 500 },
    occluders: [],
  };
  await controller.sync([intent], { overlayOpen: false, interactive: true });
  await sleep(400);
  await controller.navigate("diag-browser", "https://example.com");

  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const e = controller.entries.get("diag-browser");
    const wc = e?.view?.webContents;
    if (wc && !wc.isDestroyed() && !wc.isLoading() && wc.getURL().startsWith("https://")) break;
    await sleep(200);
  }
  await sleep(1500);

  const e = controller.entries.get("diag-browser");
  const wc = e?.view?.webContents;
  const info = {
    url: wc?.getURL(),
    title: wc?.getTitle(),
    viewVisible: (() => {
      try {
        return e?.view?.getVisible?.() ?? "n/a";
      } catch {
        return "n/a";
      }
    })(),
    viewBounds: e?.view?.getBounds(),
    winBounds: win.getBounds(),
    winContent: win.getContentBounds(),
  };
  out("INFO " + JSON.stringify(info));

  const shotFile = path.join(OUT, "diag-direct.png");
  const b = win.getBounds();
  await new Promise((r) => execFile("screencapture", ["-x", "-R", `${b.x},${b.y},${b.width},${b.height}`, shotFile], () => r()));
  out("SHOT " + shotFile);
  try {
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(OUT, "diag-view.png"), img.toPNG());
    out("VIEW_CAPTURE " + JSON.stringify({ size: img.getSize() }));
  } catch (err) {
    out("VIEW_CAPTURE_FAILED " + err.message);
  }
  app.exit(0);
});
