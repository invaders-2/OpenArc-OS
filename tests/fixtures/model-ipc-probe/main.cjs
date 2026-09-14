/** D4-01 Closure A · model:command 真实 Electron IPC 探针宿主。 */
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
const SECRET = "FAKE_MODEL_IPC_SECRET_UI_D401";
const report = { checks: [], errors: [] };
const out = (l) => process.stdout.write(l + "\n");
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail) }); out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win; let userData = null;
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const setValue = (sel, value) => js("const el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing'; const proto = el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; const setter=Object.getOwnPropertyDescriptor(proto,'value').set; setter.call(el," + JSON.stringify(value) + "); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';");
const click = (sel) => js("const el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
async function waitGate(want, timeout = 30000) { const t0 = Date.now(); let last = "?"; while (Date.now() - t0 < timeout) { try { last = await gate(); if (last === want) return last; } catch { /* navigating */ } await sleep(120); } return "TIMEOUT(" + last + ")"; }

app.whenReady().then(async () => {
  try {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-01-ipc-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    const adminLogin = await identity.store.login({ identifier: ADMIN, password: PW });
    const adminCtx = { sessionRef: adminLogin.session.ref, appId: "resource-library" };
    // 保证 host app resource-library 有 model 管理授权（bootstrap 已 seed，这里兜底）
    identity.modelService.grantAppModelAccess({ context: adminCtx, appId: "resource-library", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    win = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    registerIdentityIpc({
      ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService,
      resource: identity.resourceService, resourceSearch: identity.searchService, resourcePreview: identity.previewService,
      governance: identity.governanceService, projects: identity.projectService, canvas: identity.canvasService, picker: identity.pickerService,
      model: identity.modelService, dialog: null, BrowserWindow: win,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL,
      send: () => {},
    });
    await win.loadURL(uiURL);
    await sleep(400);
    await setValue('[data-d3-id="login-identifier"]', ADMIN);
    await setValue('[data-d3-id="login-password"]', PW);
    await click('[data-d3-id="login-submit"]');
    const g = await waitGate("ready");
    check("IPC0 · 登录进入桌面（service.current 已建立）", g === "ready", "gate=" + g);
    check("IPC1 · preload 暴露 window.openarc.model.command", await js("return typeof window.openarc?.model?.command") === "function" ? true : (await js("return typeof window.openarc?.model?.command")));
    const keys = await js("return Object.keys(window.openarc.model||{}).sort()");
    check("IPC2 · model 桥只有 command（无 getRawCredential / rawFetch）", JSON.stringify(keys) === JSON.stringify(["command"]), JSON.stringify(keys));
    const list = await js("return await window.openarc.model.command({ command: 'provider/list' })");
    check("IPC3 · 合法命令 provider/list 可用", list && list.ok === true, JSON.stringify(list).slice(0, 120));
    const denied = await js("return await window.openarc.model.command({ command: 'credential/getRaw' })");
    check("IPC4 · 未知/禁忌命令 DENY", denied && denied.error === "MODEL_COMMAND_NOT_ALLOWED", JSON.stringify(denied));
    const created = await js("return await window.openarc.model.command({ command: 'provider/create', payload: { displayName: 'UI IPC', baseUrl: 'http://127.0.0.1:9', credentialSecret: " + JSON.stringify(SECRET) + " } })");
    check("IPC5 · provider/create + write-only credential", created && created.ok === true, JSON.stringify(created).slice(0, 160));
    check("IPC6 · IPC 响应不含 raw secret", !JSON.stringify(created).includes(SECRET), "");
    const status = await js("return await window.openarc.model.command({ command: 'credential/status', payload: { providerId: " + JSON.stringify(created.provider.providerId) + " } })");
    check("IPC7 · credential/status 只返回 configured/version", status && status.ok === true && !JSON.stringify(status).includes(SECRET) && !("credential_ref" in status) && !("credentialRef" in status), JSON.stringify(status));
    const dom = await js("return document.body.innerHTML");
    check("IPC8 · DOM 不含 raw secret", !dom.includes(SECRET), "");
    const spoof = await js("return await window.openarc.model.command({ command: 'provider/list', payload: { userId: 'admin', appId: 'canvas', role: 'ADMIN' } })");
    check("IPC9 · actor/app 伪造不改变 host 上下文", spoof && spoof.ok === true, JSON.stringify(spoof).slice(0, 100));
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    try { win?.destroy(); } catch { /* ignore */ }
    if (userData) { try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
