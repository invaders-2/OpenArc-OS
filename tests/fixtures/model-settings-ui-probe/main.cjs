/** D4-01 Closure C · Settings → Models UI 真实 Electron 探针宿主。 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test"; const PW = "admin-password-1";
const SECRET = "FAKE_PROVIDER_SECRET_UI_CLOSURE_C";
const SECRET2 = "FAKE_PROVIDER_SECRET_UI_CLOSURE_C_V2";
const FAKE = process.env.D4_FAKE_BASE_URL;
const report = { checks: [], errors: [] };
const out = (l) => process.stdout.write(l + "\n");
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail) }); out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win; let userData = null;
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const setValue = (sel, value) => js("const el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing'; const proto = el.tagName==='SELECT'?HTMLSelectElement.prototype:(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); const setter=Object.getOwnPropertyDescriptor(proto,'value').set; setter.call(el," + JSON.stringify(value) + "); el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})); return 'ok';");
const click = (sel) => js("const el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing'; el.click(); return 'ok';");
const txt = (sel) => js("return (document.querySelector(" + JSON.stringify(sel) + ")?.textContent || '').trim()");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
async function waitGate(want, timeout = 30000) { const t0 = Date.now(); let last = "?"; while (Date.now() - t0 < timeout) { try { last = await gate(); if (last === want) return last; } catch { /* nav */ } await sleep(120); } return "TIMEOUT(" + last + ")"; }
async function waitSel(sel, timeout = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await js("return !!document.querySelector(" + JSON.stringify(sel) + ")")) return true; await sleep(100); } return false; }
async function waitFn(expr, timeout = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await js("return (" + expr + ")")) return true; } catch { /* ignore */ } await sleep(100); } return false; }

app.whenReady().then(async () => {
  try {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-01-c-"));
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    win = new BrowserWindow({ width: 1300, height: 900, show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    registerIdentityIpc({
      ipcMain, service: identity.service, authorization: identity.authorization, device: identity.deviceService,
      resource: identity.resourceService, resourceSearch: identity.searchService, resourcePreview: identity.previewService,
      governance: identity.governanceService, projects: identity.projectService, canvas: identity.canvasService, picker: identity.pickerService,
      model: identity.modelService, dialog: null, BrowserWindow: win,
      isTrusted: (e) => e.sender === win.webContents && e.senderFrame?.url === uiURL, send: () => {},
    });
    await win.loadURL(uiURL);
    await sleep(400);
    await setValue('[data-d3-id="login-identifier"]', ADMIN);
    await setValue('[data-d3-id="login-password"]', PW);
    await click('[data-d3-id="login-submit"]');
    check("C1 · 登录", (await waitGate("ready")) === "ready", "");
    await click('[data-app-id="settings"]');
    await waitSel('[data-settings-pane="model"]');
    await click('[data-settings-pane="model"]');
    check("C2 · 打开 Settings → 模型 / AI", await waitSel('[data-d4-01="settings"]'), "");
    check("C3 · 空态 Providers", await waitFn("!!document.querySelector('[data-d4-01-providers-empty]')"), "");
    // create provider with credential
    await setValue('[data-d4-01-provider-name]', "UI Provider");
    await setValue('[data-d4-01-provider-url]', FAKE);
    await setValue('[data-d4-01-provider-secret]', SECRET);
    await click('[data-d4-01-provider-create]');
    check("C4 · 创建 Provider", await waitSel('[data-d4-01-provider]'), "");
    const pid = await js("return document.querySelector('[data-d4-01-provider]').getAttribute('data-d4-01-provider')");
    check("C5 · Credential Status = Configured", await waitFn("document.querySelector('[data-d4-01-cred-status=\"" + pid + "\"]')?.textContent==='Configured'"), await txt('[data-d4-01-cred-status="' + pid + '"]'));
    check("C6 · 保存后密钥输入框清空（write-only）", (await js("return document.querySelector('[data-d4-01-provider-secret]').value")) === "", "");
    // model
    await click('[data-d4-01-tab="models"]');
    await waitSel('[data-d4-01-pane="models"]');
    await setValue('[data-d4-01-model-provider]', pid);
    await setValue('[data-d4-01-model-remote]', "fake-1");
    await setValue('[data-d4-01-model-name]', "UI Model");
    await click('[data-d4-01-model-create]');
    check("C7 · 注册 Model", await waitSel('[data-d4-01-model]'), "");
    const cid = await js("return document.querySelector('[data-d4-01-model]').getAttribute('data-d4-01-model')");
    const declared = await txt('[data-d4-01-model-declared="' + cid + '"]');
    const verified = await txt('[data-d4-01-model-verified="' + cid + '"]');
    check("C8 · Declared 与 Verified 分开显示", declared.includes("chat") && verified.includes("-") && verified.includes("Verified"), declared + " / " + verified);
    // defaults
    await click('[data-d4-01-tab="defaults"]');
    await waitSel('[data-d4-01-pane="defaults"]');
    await setValue('[data-d4-01-default-personal-chat]', cid);
    await waitFn("document.querySelector('[data-d4-01-default-personal-chat]').value===" + JSON.stringify(cid));
    check("C9 · Personal Chat Default 保存", (await js("return document.querySelector('[data-d4-01-default-personal-chat]').value")) === cid, "");
    await setValue('[data-d4-01-default-org-chat]', cid);
    await waitFn("document.querySelector('[data-d4-01-default-org-chat]').value===" + JSON.stringify(cid));
    check("C10 · Organization Chat Default 保存（admin）", (await js("return document.querySelector('[data-d4-01-default-org-chat]').value")) === cid, "");
    // connection test
    await click('[data-d4-01-tab="providers"]');
    await waitSel('[data-d4-01-pane="providers"]');
    await click('[data-d4-01-test="' + pid + '"]');
    check("C11 · Connection Test 分阶段结果（Inference PASS）", await waitFn("(document.querySelector('[data-d4-01-test-result=\"" + pid + "\"]')?.textContent||'').indexOf('Inference:PASS')>=0"), await txt('[data-d4-01-test-result="' + pid + '"]'));
    // disable/enable model
    await click('[data-d4-01-tab="models"]');
    await waitSel('[data-d4-01-pane="models"]');
    await click('[data-d4-01-model-disable="' + cid + '"]');
    check("C12 · 禁用 Model 真实生效", await waitFn("!!document.querySelector('[data-d4-01-model-enable=\"" + cid + "\"]')"), "");
    await click('[data-d4-01-model-enable="' + cid + '"]');
    await waitFn("!!document.querySelector('[data-d4-01-model-disable=\"" + cid + "\"]')");
    // replace credential
    await click('[data-d4-01-tab="providers"]');
    await waitSel('[data-d4-01-pane="providers"]');
    await setValue('[data-d4-01-cred-input="' + pid + '"]', SECRET2);
    await click('[data-d4-01-cred-replace="' + pid + '"]');
    check("C13 · Replace Credential 后输入清空", await waitFn("document.querySelector('[data-d4-01-cred-input=\"" + pid + "\"]').value===''"), "");
    // delete credential
    await click('[data-d4-01-cred-delete="' + pid + '"]');
    check("C14 · Delete Credential → Missing", await waitFn("document.querySelector('[data-d4-01-cred-status=\"" + pid + "\"]')?.textContent==='Missing'"), await txt('[data-d4-01-cred-status="' + pid + '"]'));
    // URL attack
    await setValue('[data-d4-01-provider-name]', "Attack");
    await setValue('[data-d4-01-provider-url]', "file:///etc/passwd");
    await click('[data-d4-01-provider-create]');
    check("C15 · file:// Endpoint DENY（ENDPOINT_BLOCKED）", await waitFn("(document.querySelector('[data-d4-01-error]')?.textContent||'').indexOf('ENDPOINT_BLOCKED')>=0"), await txt('[data-d4-01-error]'));
    // DOM secret scan
    const dom = await js("return document.body.innerText + ' | ' + Array.from(document.querySelectorAll('input')).map(function(i){return i.value;}).join(' | ') + ' | ' + document.body.innerHTML");
    check("C16 · DOM / input 值不含 raw secret", !dom.includes(SECRET) && !dom.includes(SECRET2), "");
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
