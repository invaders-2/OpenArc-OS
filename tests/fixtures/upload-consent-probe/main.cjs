const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ROOT = path.resolve(__dirname, "../../..");
const { createOpenArcRuntime } = require(path.join(ROOT, "electron/runtime-boot.cjs"));
const { registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { registerCanvasIpc } = require(path.join(ROOT, "electron/canvas-bootstrap.cjs"));
const { createAssetPublicUrl } = require(path.join(ROOT, "electron/canvas-asset-public-url.cjs"));
const { createUploadConsentService } = require(path.join(ROOT, "electron/upload-consent-service.cjs"));
const { registerUploadConsentIpc } = require(path.join(ROOT, "electron/upload-consent-bootstrap.cjs"));
const { createSystemFontsBundle, registerSystemFontsIpc } = require(path.join(ROOT, "electron/system-fonts-bootstrap.cjs"));
const { registerLocalProxyIpc } = require(path.join(ROOT, "electron/local-proxy-bootstrap.cjs"));
const uiURL = pathToFileURL(path.join(ROOT, "dist/vue.html")).href;
const OUT = path.join(ROOT, "artifacts/upload-consent-gate");
const report = { checks: [], errors: [], screenshots: [] };
let win; let runtime; let userData; let calls = 0; let failUpload = false;
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); out((ok ? "PASS " : "FAIL ") + name + (detail ? " :: " + detail : "")); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const has = (sel) => js("return Array.from(document.querySelectorAll(" + JSON.stringify(sel) + ")).some((el)=>el.getClientRects().length>0)");
const text = (sel) => js("const el=Array.from(document.querySelectorAll(" + JSON.stringify(sel) + ")).find((el)=>el.getClientRects().length>0);return el?.textContent || ''");
const click = (sel) => js("const el=Array.from(document.querySelectorAll(" + JSON.stringify(sel) + ")).find((el)=>el.getClientRects().length>0);if(!el)return 'missing';if(el.disabled)return 'disabled';el.click();return 'ok'");
const setInput = (sel, value) => js("const el=Array.from(document.querySelectorAll(" + JSON.stringify(sel) + ")).find((el)=>el.getClientRects().length>0);if(!el)return 'missing';Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el," + JSON.stringify(value) + ");el.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'");
async function waitFor(fn, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await Promise.resolve(fn())) return true; await sleep(80); } return false; }
async function login() {
  await waitFor(() => has('[data-d3-id="login-identifier"]'));
  await setInput('[data-d3-id="login-identifier"]', "admin@openarc.test");
  await setInput('[data-d3-id="login-password"]', "admin-password-1");
  await click('[data-d3-id="login-submit"]');
  if (!(await waitFor(async () => (await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate')")) === "ready"))) throw new Error("login failed");
}
async function theme(value) {
  await js("localStorage.setItem('oa-theme'," + JSON.stringify(value) + ");localStorage.setItem('oa-motion','true')");
  await js("location.reload()");
  await waitFor(async () => (await js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate')")) === "ready");
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  if (!(await js("return matchMedia('(prefers-reduced-motion: reduce)').matches"))) throw new Error("reduced motion inactive");
}
async function openNetwork() {
  await click('[data-dock-id="settings"]');
  await waitFor(() => has('[data-settings-pane="network"]'));
  await click('[data-settings-pane="network"]');
  await waitFor(() => has("[data-upload-consent]"));
  await sleep(400);
}
async function screenshot(name) {
  fs.mkdirSync(OUT, { recursive: true });
  await sleep(300);
  const file = path.join(OUT, name);
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  report.screenshots.push(file);
}
async function upload(data) {
  return js("return window.openarc.canvas.command({type:'canvas/assetPublicUrl',canvasId:'canvas-1',dataUrl:" + JSON.stringify(data) + "})");
}

app.whenReady().then(async () => {
  try {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-upload-consent-electron-"));
    runtime = await createOpenArcRuntime({ userDataDir: userData, safeStorage, allowAdmin: true });
    const identity = runtime.identity;
    await identity.store.initialize({ identifier: "admin@openarc.test", password: "admin-password-1", displayName: "Admin" });
    win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const trusted = (event) => event.sender === win.webContents && event.senderFrame?.url === uiURL;
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("system:info", async () => ({ ok: true, platform: process.platform, arch: process.arch }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    ipcMain.handle("browser:command", async () => ({ ok: false, error: "BROWSER_UNAVAILABLE" }));
    ipcMain.handle("files:list", async () => ({ ok: true, entries: [] }));
    ipcMain.handle("files:trashList", async () => ({ ok: true, entries: [] }));
    registerSystemFontsIpc({ ipcMain, bundle: createSystemFontsBundle({ roots: [] }), isTrusted: trusted, identity: identity.service });
    registerLocalProxyIpc({ ipcMain, service: { execute: async () => ({ ok: false, error: "LOCAL_PROXY_UNAVAILABLE", message: "隔离探针未配置本机代理" }) }, isTrusted: trusted, identity: identity.service });
    registerIdentityIpc({ ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService, resource: identity.resourceService, resourceSearch: identity.searchService, governance: identity.governanceService, model: identity.modelService, sideEffect: identity.sideEffectGateway, BrowserWindow, isTrusted: trusted, send: (event) => { if (win && !win.isDestroyed()) win.webContents.send("identity:event", event); }, sendSideEffect: (event) => { if (win && !win.isDestroyed()) win.webContents.send("sideeffect:event", event); } });
    const consent = createUploadConsentService({ identityStore: identity.store, authorization: identity.authorization });
    const rawUpload = async () => {
      calls += 1;
      if (failUpload) throw new Error("injected upload failure without asset data");
      return { url: "https://litter.catbox.moe/authorized-proof", expiresAt: Date.now() + 86400000, service: "litterbox" };
    };
    const assetPublicUrl = createAssetPublicUrl(identity.canvasDocService, { authorize: consent.assertAllowed, uploader: (context, input) => consent.authorizedUpload(context, input, rawUpload) });
    registerUploadConsentIpc({ ipcMain, service: consent, identity: identity.service, isTrusted: trusted });
    registerCanvasIpc({ ipcMain, service: identity.canvasDocService, identity: identity.service, isTrusted: trusted, assetPublicUrl });
    await win.loadURL(uiURL);
    await login();
    await theme("light");
    const first = await upload("data:image/png;base64," + Buffer.from("first").toString("base64"));
    check("未授权 Canvas 上传入口 0 请求", first.ok === false && first.error === "UPLOAD_CONSENT_REQUIRED" && calls === 0, JSON.stringify(first));
    await openNetwork();
    const initialText = await text("[data-upload-consent]");
    check("设置显示目的地、24h、200MB 和未授权状态", initialText.includes("Litterbox") && initialText.includes("24h") && initialText.includes("200.0 MB") && initialText.includes("模型服务授权不等于图床授权"), initialText);
    check("设置页 reduced-motion 生效", await js("return matchMedia('(prefers-reduced-motion: reduce)').matches"));
    await screenshot("01-unauthorized-light.png");

    await click("[data-upload-consent-toggle]");
    await waitFor(async () => (await js("return document.querySelector('[data-upload-consent-toggle]').getAttribute('aria-checked')")) === "true");
    const allowed = await upload("data:image/png;base64," + Buffer.from("first").toString("base64"));
    check("明确授权后真实产品入口上传", allowed.ok === true && calls === 1, JSON.stringify(allowed));
    failUpload = true;
    const failed = await upload("data:image/png;base64," + Buffer.from("second").toString("base64"));
    check("上传失败进入后端失败状态", failed.ok === false && calls === 2, JSON.stringify(failed));
    await theme("dark");
    await openNetwork();
    check("深色设置显示最近失败且保留目的地", (await text("[data-upload-consent]")).includes("最近上传失败") && (await text("[data-upload-consent]")).includes("24h"), await text("[data-upload-consent]"));
    await screenshot("02-failed-dark.png");

    await click("[data-upload-consent-toggle]");
    await waitFor(async () => (await js("return document.querySelector('[data-upload-consent-toggle]').getAttribute('aria-checked')")) === "false");
    const revoked = await upload("data:image/png;base64," + Buffer.from("first").toString("base64"));
    check("撤权后缓存也不返回 URL 且 0 新请求", revoked.ok === false && revoked.error === "UPLOAD_CONSENT_REQUIRED" && calls === 2, JSON.stringify(revoked));
    const audit = JSON.stringify(identity.store.connection.prepare("SELECT * FROM app_network_audit").all());
    check("审计不含素材正文、密钥或公开 URL", !audit.includes("authorized-proof") && !audit.includes("first") && !audit.includes("second") && !audit.includes("api_key"));
  } catch (error) {
    report.errors.push(String(error && error.stack || error));
    check("探针整体未抛异常", false, String(error && error.message || error));
  } finally {
    try { win?.destroy(); } catch {}
    try { await runtime?.identity?.modelProxy?.stop(); } catch {}
    try { runtime?.identity?.store?.close(); } catch {}
    if (userData) fs.rmSync(userData, { recursive: true, force: true });
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
