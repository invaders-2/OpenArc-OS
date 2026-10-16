/**
 * Vue 壳层接线截图（真实 Electron，窗口尺寸与 identity 探针一致 1280×860）。
 *
 * 与探针同一条装配：electron/preload.cjs + electron/identity-bootstrap.cjs，
 * 页面是 dist/vue.html；只是把流程走到"登录态 / 桌面态"各抓一张。
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/vue.html")).href;
const OUT = path.join(ROOT, "artifacts", "vue-wiring");
const IDENT = "vue-shot@openarc.local";
const PW = "vue-shot-password-1";
const NAME = "Vue Shot";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
let userData = null;

const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const has = (sel) => js(`return !!document.querySelector(${JSON.stringify(sel)})`);

async function waitGate(want, timeout = 30000) {
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeout) {
    try {
      last = await gate();
      if (last === want) return last;
    } catch {
      /* 导航中 */
    }
    await sleep(120);
  }
  throw new Error(`等待 gate=${want} 超时（last=${last}）`);
}

async function waitEnabled(sel, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const disabled = await js(`return !!document.querySelector(${JSON.stringify(sel)})?.disabled`);
    if (disabled === false) return true;
    await sleep(80);
  }
  return false;
}

async function waitFor(sel, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await has(sel)) return true;
    await sleep(60);
  }
  return false;
}

const setInput = (sel, value) =>
  js(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  `);

const click = (sel) =>
  js(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    el.click();
    return 'ok';
  `);

async function shoot(name) {
  await sleep(500);
  const image = await win.webContents.capturePage();
  const file = path.join(OUT, name);
  fs.writeFileSync(file, image.toPNG());
  process.stdout.write("SHOT " + file + " " + image.getSize().width + "x" + image.getSize().height + "\n");
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-vue-shots-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });

    win = new BrowserWindow({
      width: 1280,
      height: 860,
      show: false,
      webPreferences: {
        preload: path.join(ROOT, "electron/preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));

    registerIdentityIpc({
      ipcMain,
      service: identity.service,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event);
      },
    });

    await win.loadURL(uiURL);
    await waitGate("uninitialized");

    // 初始化三步 → 登录态
    await setInput('[data-d3-id="setup-name"]', NAME);
    await waitEnabled('[data-d3-id="setup-next"]');
    await click('[data-d3-id="setup-next"]');
    await waitFor('[data-d3-id="setup-identifier"]');
    await setInput('[data-d3-id="setup-identifier"]', IDENT);
    await waitEnabled('[data-d3-id="setup-next"]');
    await click('[data-d3-id="setup-next"]');
    await waitFor('[data-d3-id="setup-password"]');
    await setInput('[data-d3-id="setup-password"]', PW);
    await setInput('[data-d3-id="setup-confirm"]', PW);
    await waitEnabled('[data-d3-id="setup-submit"]');
    await click('[data-d3-id="setup-submit"]');

    await waitGate("unauthenticated");
    await shoot("login.png");

    // 登录 → 桌面态
    await setInput('[data-d3-id="login-identifier"]', IDENT);
    await setInput('[data-d3-id="login-password"]', PW);
    await waitEnabled('[data-d3-id="login-submit"]');
    await click('[data-d3-id="login-submit"]');
    await waitGate("ready");
    await waitFor(".topbar");
    await waitFor(".dock");
    await shoot("desktop.png");
  } catch (e) {
    process.stdout.write("SHOT_ERROR " + String((e && e.stack) || e) + "\n");
    process.exitCode = 1;
  } finally {
    try {
      win?.destroy();
    } catch {
      /* ignore */
    }
    if (userData) {
      try {
        fs.rmSync(userData, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    app.quit();
  }
});
