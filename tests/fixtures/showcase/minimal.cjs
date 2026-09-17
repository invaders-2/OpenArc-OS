/** 最小对照：不含项目任何代码，Electron 官方用法挂 WebContentsView。 */
const { app, BrowserWindow, WebContentsView } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const out = (l) => process.stdout.write(l + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.DIAG_NO_GPU === "1") app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const winOpts = { width: 1000, height: 700, show: true };
  if (process.env.DIAG_HOST_SANDBOX === "1")
    winOpts.webPreferences = { nodeIntegration: false, contextIsolation: true, sandbox: true };
  const win = new BrowserWindow(winOpts);
  const viewOpts = {};
  if (process.env.DIAG_PARTITION === "1") {
    const { session } = require("electron");
    const sess = session.fromPartition("openarc-app-browser");
    sess.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    sess.setPermissionCheckHandler(() => false);
    viewOpts.webPreferences = { session: sess, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true };
    out("PARTITION on");
  }
  const view = new WebContentsView(viewOpts);
  win.contentView.addChildView(view);
  view.setBounds({ x: 50, y: 50, width: 800, height: 500 });
  if (process.env.DIAG_RADIUS === "1") {
    try {
      view.setBorderRadius(10);
      out("SET_RADIUS ok");
    } catch (e) {
      out("SET_RADIUS failed " + e.message);
    }
  }
  if (process.env.DIAG_BG === "1") {
    try {
      view.setBackgroundColor("#00000000");
      out("SET_BG ok");
    } catch (e) {
      out("SET_BG failed " + e.message);
    }
  }
  if (process.env.DIAG_HIDE_SHOW === "1") {
    view.setVisible(false);
    out("HIDE at create");
  }
  await view.webContents.loadURL("https://example.com");
  if (process.env.DIAG_HIDE_SHOW === "1") {
    await sleep(800);
    view.setVisible(true);
    out("SHOW after load");
    await sleep(800);
  }
  if (process.env.DIAG_ALWAYS_ON_TOP === "1") win.setAlwaysOnTop(true, "screen-saver");
  if (process.env.DIAG_LISTENERS === "1") {
    for (const name of ["did-navigate", "did-navigate-in-page", "did-start-loading", "did-stop-loading", "page-title-updated", "did-finish-load"])
      view.webContents.on(name, () => {});
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const name of ["will-navigate", "will-redirect"])
      view.webContents.on(name, (e, url) => {
        if (!/^https?:/i.test(url)) e.preventDefault();
      });
    view.webContents.on("will-attach-webview", (e) => e.preventDefault());
  }
  await view.webContents.loadURL("https://example.com");
  if (process.env.DIAG_DOUBLE_LOAD === "1") {
    view.webContents.loadURL("https://example.com").catch(() => {});
    out("DOUBLE_LOAD issued");
  }
  await sleep(1500);
  out("STATE " + JSON.stringify({
    url: view.webContents.getURL(),
    title: view.webContents.getTitle(),
    bounds: view.getBounds(),
    children: win.contentView.children.length,
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-min-"));
  try {
    const img = await view.webContents.capturePage();
    fs.writeFileSync(path.join(dir, "view.png"), img.toPNG());
    out("VIEW_CAPTURE_OK " + path.join(dir, "view.png"));
  } catch (e) {
    out("VIEW_CAPTURE_FAILED " + e.message);
  }
  app.exit(0);
});
