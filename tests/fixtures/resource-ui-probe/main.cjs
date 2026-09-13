/**
 * D3-04A UI 探针宿主（真实 Electron + 产品真实页面 / preload / 资源装配）。
 *
 * 用 stub dialog 驱动 resource/pickImport 与 resource/pickLink：
 * 文件选择发生在主进程，渲染进程只拿到 safe descriptor，绝对路径不出现。
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));

const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";

const report = { checks: [], errors: [], versions: {} };
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win;
let userData = null;

const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const text = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.textContent || ''");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");

async function waitGate(want, timeout = 30000) {
  const t0 = Date.now();
  let last = "?";
  while (Date.now() - t0 < timeout) {
    try {
      last = await gate();
      if (last === want) return last;
    } catch {
      /* navigating */
    }
    await sleep(120);
  }
  return "TIMEOUT(last=" + last + ")";
}
async function waitSel(sel, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await has(sel)) return true;
    await sleep(100);
  }
  return false;
}
const setInput = (sel, value) =>
  js(
    "const el = document.querySelector(" + JSON.stringify(sel) + ");" +
      "if (!el) return 'missing';" +
      "const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;" +
      "setter.call(el, " + JSON.stringify(value) + ");" +
      "el.dispatchEvent(new Event('input', { bubbles: true }));" +
      "return 'ok';",
  );
const click = (sel) =>
  js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");

app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));

    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-04a-ui-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });

    const fixtureFile = path.join(userData, "ui-import-me.txt");
    fs.writeFileSync(fixtureFile, "ui import content");
    const stubDialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [fixtureFile] }) };

    win = new BrowserWindow({
      width: 1280,
      height: 860,
      show: false,
      webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    registerIdentityIpc({
      ipcMain,
      service: identity.service,
      authorization: identity.authorization,
      device: identity.deviceService,
      resource: identity.resourceService,
      dialog: stubDialog,
      BrowserWindow,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: (event) => {
        if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("identity:event", event);
      },
    });

    await win.loadURL(uiURL);
    await sleep(500);

    let g = await waitGate("unauthenticated");
    check("U1 · 已初始化 -> 登录页", g === "unauthenticated", "gate=" + g);
    await setInput('[data-d3-id="login-identifier"]', ADMIN);
    await setInput('[data-d3-id="login-password"]', PW);
    await sleep(80);
    await click('[data-d3-id="login-submit"]');
    g = await waitGate("ready");
    check("U2 · 登录进入桌面", g === "ready", "gate=" + g);

    check("U3 · resource 桥只有 command（无 raw fs）", await js("return !!window.openarc.resource && Object.keys(window.openarc.resource).join() === 'command'"), "");

    await click('[data-app-id="resource-library"]');
    const panel = await waitSel('[data-d3-04a="resource-library"]');
    check("U4 · 打开资源库 App 面板", panel, "panel");
    check("U5 · 初始为空状态", await has('[data-d3-04a-empty]'), "");

    await click('[data-d3-04a-action="import"]');
    const firstItem = await waitSel('[data-d3-04a-item]');
    check("U6 · Import File 后出现资源条目", firstItem, "");
    const itemText = await text('[data-d3-04a-item]');
    check("U7 · 条目显示 ResourceRef / Managed / size", itemText.includes("resource://res_") && itemText.includes("MANAGED") && itemText.includes("bytes"), itemText.replace(/\s+/g, " ").slice(0, 160));

    const dom = await js("return document.body.innerHTML");
    check("U8 · 页面不泄漏源文件绝对路径", dom.includes(fixtureFile) === false && dom.includes(userData) === false, "path hidden");

    await click('[data-d3-04a-action="link"]');
    await sleep(600);
    const linkText = await js("return Array.from(document.querySelectorAll('[data-d3-04a-item]')).map((el) => el.textContent).join('|')");
    check("U9 · Link File 后出现 LINKED 条目", linkText.includes("LINKED"), linkText.replace(/\s+/g, " ").slice(0, 200));

    const list = identity.resourceService.list({ context: { sessionRef: identity.service.current, appId: "resource-library" } });
    check("U10 · 主进程 list 计数为 2", list.ok && list.count === 2, "count=" + (list && list.count));
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
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
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
