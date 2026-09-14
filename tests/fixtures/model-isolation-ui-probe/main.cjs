/**
 * D4-01 Closure F · User B UI isolation + Organization boundary + Models a11y smoke（真实 Electron）。
 *
 * 关闭 Closure C 遗留的 "User B UI isolation = PARTIAL / NOT VERIFIED"：
 *   · User A 建 Personal Provider/Model 与 Organization Provider/Model；
 *   · User B 真实 logout/login 后打开 Settings → Models；
 *   · B 看不到 A 的 private，能看到 Organization 安全 metadata；
 *   · B 不能修改 A config / 不能调用 A credential / Organization mutation DENY；
 *   · Models Settings 键盘/标签/focus-visible/a11y smoke。
 *
 * raw secret 由 harness 经 env 注入（测试 setup 内存），绝不写入任何落盘产物。
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const ROOT = path.resolve(__dirname, "../../..");
const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const uiURL = pathToFileURL(path.join(ROOT, "dist/index.html")).href;
const ADMIN = "admin@openarc.test"; const PW = "admin-password-1";
const USERB = "userb@openarc.test"; const B_PW = "userb-password-1";
const SECRET = process.env.OA_FULLSCAN_SECRET || "";
const FAKE = process.env.OA_FAKE_BASE_URL;
const report = { checks: [], errors: [], responses: [], scans: {} };
const out = (l) => process.stdout.write(l + "\n");
const check = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail).slice(0, 300) }); out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win;
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const setValue = (sel, value) => js("const el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing'; const proto = el.tagName==='SELECT'?HTMLSelectElement.prototype:(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype); const setter=Object.getOwnPropertyDescriptor(proto,'value').set; setter.call(el," + JSON.stringify(value) + "); el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})); return 'ok';");
const click = (sel) => js("const el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return 'missing'; el.click(); return 'ok';");
const txt = (sel) => js("return (document.querySelector(" + JSON.stringify(sel) + ")?.textContent || '').trim()");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
async function waitGate(want, timeout = 30000) { const t0 = Date.now(); let last = "?"; while (Date.now() - t0 < timeout) { try { last = await gate(); if (last === want) return last; } catch { /* nav */ } await sleep(120); } return "TIMEOUT(" + last + ")"; }
async function waitSel(sel, timeout = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { if (await js("return !!document.querySelector(" + JSON.stringify(sel) + ")")) return true; await sleep(100); } return false; }
async function waitFn(expr, timeout = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await js("return (" + expr + ")")) return true; } catch { /* ignore */ } await sleep(100); } return false; }
const callCommand = (command, payload) => js("return await window.openarc.model.command(" + JSON.stringify({ command, payload }) + ")");
const sendKey = (keyCode) => { win.webContents.sendInputEvent({ type: "keyDown", keyCode }); win.webContents.sendInputEvent({ type: "keyUp", keyCode }); };

const modelResponses = [];
const origHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => {
  if (channel !== "model:command") return origHandle(channel, fn);
  return origHandle(channel, async (e, raw) => {
    const res = await fn(e, raw);
    modelResponses.push({ command: raw && typeof raw === "object" ? (raw.command || raw.type || null) : null, response: res });
    return res;
  });
};
const hitsSecret = (v) => { const t = typeof v === "string" ? v : JSON.stringify(v ?? null); return t != null && t.includes(SECRET); };

async function login(id, pw) {
  await setValue('[data-d3-id="login-identifier"]', id);
  await setValue('[data-d3-id="login-password"]', pw);
  await click('[data-d3-id="login-submit"]');
  return waitGate("ready");
}
async function openModels() {
  await click('[data-app-id="settings"]');
  await waitSel('[data-settings-pane="model"]');
  await click('[data-settings-pane="model"]');
  return waitSel('[data-d4-01="settings"]');
}

app.whenReady().then(async () => {
  try {
    if (process.env.OA_USERDATA) app.setPath("userData", process.env.OA_USERDATA);
    const identity = createIdentityService({ userDataDir: process.env.OA_USERDATA, safeStorage, allowAdmin: true });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    const adminUser = identity.store.allUsers().find((u) => u.role === "ADMIN");
    const created = await identity.store.createUser({ identifier: USERB, password: B_PW, displayName: "User B", teamId: adminUser.team_id });
    check("ISOUI1 · 创建 User B（MEMBER）", created.ok === true, JSON.stringify(created).slice(0, 120));
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

    // ---- A: 建 private + organization ----
    check("ISOUI2 · A 登录", (await login(ADMIN, PW)) === "ready", "");
    check("ISOUI3 · A 打开 Settings → Models", await openModels(), "");
    await setValue('[data-d4-01-provider-name]', "A-Private-Provider");
    await setValue('[data-d4-01-provider-url]', FAKE);
    await setValue('[data-d4-01-provider-secret]', SECRET);
    await click('[data-d4-01-provider-create]');
    await waitFn("document.querySelectorAll('[data-d4-01-provider]').length>=1");
    const aProviderId = await js("return Array.from(document.querySelectorAll('[data-d4-01-provider]')).map(function(e){return e.getAttribute('data-d4-01-provider');}).find(function(id){return document.querySelector('[data-d4-01-provider=\"'+id+'\"] .d401-name').textContent==='A-Private-Provider';})");
    check("ISOUI4 · A 建 private provider", !!aProviderId, String(aProviderId));

    // organization provider
    await setValue('[data-d4-01-provider-name]', "Org-Shared-Provider");
    await setValue('[data-d4-01-provider-url]', FAKE);
    await setValue('[data-d4-01-provider-scope]', "ORGANIZATION");
    await setValue('[data-d4-01-provider-secret]', SECRET);
    await click('[data-d4-01-provider-create]');
    await waitFn("Array.from(document.querySelectorAll('.d401-name')).some(function(e){return e.textContent==='Org-Shared-Provider';})");
    const orgProviderId = await js("return Array.from(document.querySelectorAll('[data-d4-01-provider]')).map(function(e){return e.getAttribute('data-d4-01-provider');}).find(function(id){return document.querySelector('[data-d4-01-provider=\"'+id+'\"] .d401-name').textContent==='Org-Shared-Provider';})");
    check("ISOUI5 · A 建 organization provider", !!orgProviderId, String(orgProviderId));

    // models
    await click('[data-d4-01-tab="models"]');
    await waitSel('[data-d4-01-pane="models"]');
    await setValue('[data-d4-01-model-provider]', aProviderId);
    await setValue('[data-d4-01-model-remote]', "fake-a");
    await setValue('[data-d4-01-model-name]', "A-Private-Model");
    await click('[data-d4-01-model-create]');
    await waitFn("Array.from(document.querySelectorAll('.d401-name')).some(function(e){return e.textContent==='A-Private-Model';})");
    const aConfigId = await js("return Array.from(document.querySelectorAll('[data-d4-01-model]')).map(function(e){return e.getAttribute('data-d4-01-model');}).find(function(id){return document.querySelector('[data-d4-01-model=\"'+id+'\"] .d401-name').textContent==='A-Private-Model';})");
    await setValue('[data-d4-01-model-provider]', orgProviderId);
    await setValue('[data-d4-01-model-remote]', "fake-org");
    await setValue('[data-d4-01-model-name]', "Org-Shared-Model");
    await setValue('[data-d4-01-model-scope]', "ORGANIZATION");
    await click('[data-d4-01-model-create]');
    await waitFn("Array.from(document.querySelectorAll('.d401-name')).some(function(e){return e.textContent==='Org-Shared-Model';})");
    const orgConfigId = await js("return Array.from(document.querySelectorAll('[data-d4-01-model]')).map(function(e){return e.getAttribute('data-d4-01-model');}).find(function(id){return document.querySelector('[data-d4-01-model=\"'+id+'\"] .d401-name').textContent==='Org-Shared-Model';})");
    check("ISOUI6 · A 建 private + organization model", !!aConfigId && !!orgConfigId, String(aConfigId) + "/" + String(orgConfigId));
    const testA = await callCommand("model/test", { configId: aConfigId });
    check("ISOUI6b · A 对 private model 连接测试 PASS（真实调用，Provider 收到 key）", testA.ok === true && testA.inference === true, JSON.stringify(testA).slice(0, 160));

    // ---- logout A / login B ----
    await click('[data-d3-id="topbar-logout"]');
    check("ISOUI7 · A logout 回到未登录", (await waitGate("unauthenticated")) === "unauthenticated", "");
    check("ISOUI8 · B 登录", (await login(USERB, B_PW)) === "ready", "");
    check("ISOUI9 · B 打开 Settings → Models", await openModels(), "");
    await waitFn("document.querySelectorAll('[data-d4-01-provider]').length>=1");

    // ---- B 看不到 A private，看得到 org ----
    const providerNames = await js("return Array.from(document.querySelectorAll('[data-d4-01-provider] .d401-name')).map(function(e){return e.textContent;});");
    await click('[data-d4-01-tab="models"]');
    await waitSel('[data-d4-01-pane="models"]');
    const modelNames = await js("return Array.from(document.querySelectorAll('[data-d4-01-model] .d401-name')).map(function(e){return e.textContent;});");
    const names = providerNames.concat(modelNames);
    check("ISOUI10 · B DOM 不含 A 的 private Provider/Model", !names.includes("A-Private-Provider") && !names.includes("A-Private-Model"), JSON.stringify(names));
    check("ISOUI11 · B DOM 含 Organization Provider/Model 安全 metadata", providerNames.includes("Org-Shared-Provider") && modelNames.includes("Org-Shared-Model"), JSON.stringify({ providers: providerNames, models: modelNames }));
    const listP = await callCommand("provider/list");
    const listM = await callCommand("model/list");
    check("ISOUI12 · B provider/list 不含 A private，含 org", listP.items.map((p) => p.providerId).includes(aProviderId) === false && listP.items.map((p) => p.providerId).includes(orgProviderId) === true, "");
    check("ISOUI13 · B model/list 不含 A private，含 org", listM.items.map((m) => m.configId).includes(aConfigId) === false && listM.items.map((m) => m.configId).includes(orgConfigId) === true, "");

    // ---- B 不能改 / 不能调用 ----
    const upd = await callCommand("model/update", { configId: aConfigId, displayName: "hijack" });
    const st = await callCommand("model/setStatus", { configId: aConfigId, status: "disabled" });
    const tst = await callCommand("model/test", { configId: aConfigId });
    const rep = await callCommand("credential/replace", { providerId: aProviderId, secret: SECRET });
    const del = await callCommand("credential/delete", { providerId: aProviderId });
    const orgUpd = await callCommand("provider/update", { providerId: orgProviderId, displayName: "hijack-org" });
    const orgDel = await callCommand("credential/delete", { providerId: orgProviderId });
    const orgDef = await callCommand("defaults/set", { capability: "chat", configId: orgConfigId, scope: "ORGANIZATION" });
    const denied = [upd, st, tst, rep, del, orgUpd, orgDel, orgDef];
    check("ISOUI14 · B 对 A private 的改/删/调用全部 DENY", [upd, st, tst, rep, del].every((r) => r.ok === false), JSON.stringify(denied.slice(0, 5).map((r) => r.error)));
    check("ISOUI15 · B 对 Organization mutation 全部 DENY", [orgUpd, orgDel, orgDef].every((r) => r.ok === false), JSON.stringify([orgUpd.error, orgDel.error, orgDef.error]));
    const credA = await callCommand("credential/status", { providerId: aProviderId });
    const credOrg = await callCommand("credential/status", { providerId: orgProviderId });
    check("ISOUI16 · B credential/status 不泄漏 secure backend metadata", credA.manageable === false && credA.credentialVersion == null && credOrg.manageable === false && credOrg.credentialVersion == null, JSON.stringify({ credA, credOrg }));
    await click('[data-d4-01-tab="providers"]');
    await waitSel('[data-d4-01-pane="providers"]');
    const orgCredLabel = await js("return (document.querySelector('[data-d4-01-cred-status=\"" + orgProviderId + "\"]')?.textContent || '').trim()");
    check("ISOUI17 · B 界面 Organization credential 显示为不可见（—）", orgCredLabel === "—", orgCredLabel);

    // ---- a11y smoke ----
    // 键盘事件与 :focus-visible 需要窗口真实获得焦点（show:false 下 Chromium 不派发键盘事件）
    win.show();
    win.focus();
    win.webContents.focus();
    await sleep(400);
    const a11y = await js("function acc(el){ const al=el.getAttribute('aria-label'); if(al&&al.trim())return al.trim(); const lb=el.getAttribute('aria-labelledby'); if(lb){const t=lb.split(/\s+/).map(function(id){var e=document.getElementById(id);return e?e.textContent.trim():'';}).filter(Boolean).join(' '); if(t)return t;} var w=el.closest('label'); if(w&&w.textContent.trim())return w.textContent.trim(); return '';} var els=Array.from(document.querySelectorAll('[data-d4-01=\"settings\"] input, [data-d4-01=\"settings\"] select, [data-d4-01=\"settings\"] textarea')); return JSON.stringify({ total: els.length, unlabeled: els.filter(function(e){return !acc(e);}).map(function(e){return e.getAttribute('data-d4-01-provider-name')||e.getAttribute('data-d4-01-model-remote')||e.tagName;}), positiveTabindex: Array.from(document.querySelectorAll('[tabindex]')).filter(function(e){return Number(e.getAttribute('tabindex'))>0;}).length });");
    const a11yObj = JSON.parse(a11y);
    check("ISOUI18 · Models Settings 所有表单控件有可访问名", a11yObj.total > 0 && a11yObj.unlabeled.length === 0, "total=" + a11yObj.total);
    check("ISOUI19 · 无 positive tabindex", a11yObj.positiveTabindex === 0, String(a11yObj.positiveTabindex));
    await click('[data-d4-01-tab="providers"]');
    await waitSel('[data-d4-01-pane="providers"]');
    const focusSeq = [];
    await js("document.querySelector('[data-d4-01-tab=\"providers\"]').focus(); return 'ok';");
    for (let i = 0; i < 6; i += 1) { sendKey("Tab"); await sleep(60); focusSeq.push(await js("var a=document.activeElement; return (a&&a.tagName)+':' + (a&&a.getAttribute&&(a.getAttribute('data-d4-01-tab')||a.getAttribute('data-d4-01-provider-name')||a.getAttribute('data-d4-01-provider-url')||a.getAttribute('data-d4-01-provider-scope')||a.getAttribute('data-d4-01-provider-secret')||a.getAttribute('data-d4-01-provider-create')||a.getAttribute('data-d3-id')||''));")); }
    check("ISOUI20 · Tab 键真实移动焦点（≥3 个不同元素）", new Set(focusSeq).size >= 3, JSON.stringify(focusSeq));
    const focusVisible = await js("var a=document.activeElement; return JSON.stringify({ tag: a&&a.tagName, fv: !!(a&&a.matches&&a.matches(':focus-visible')) });");
    check("ISOUI21 · 键盘焦点匹配 :focus-visible", JSON.parse(focusVisible).fv === true, focusVisible);
    await js("document.querySelector('[data-d4-01-tab=\"models\"]').focus(); return 'ok';");
    const focusedTab = await js("return document.activeElement && document.activeElement.getAttribute('data-d4-01-tab');");
    sendKey("Enter"); await sleep(250);
    let switched = await waitFn("!!document.querySelector('[data-d4-01-pane=\"models\"]')", 800);
    if (!switched) { sendKey("Space"); await sleep(250); switched = await waitFn("!!document.querySelector('[data-d4-01-pane=\"models\"]')", 800); }
    check("ISOUI22 · 键盘 Enter/Space 可切换 Tab（basic keyboard operation）", switched, "focusedTab=" + focusedTab);

    // ---- raw secret 兜底 ----
    const domBlob = await js("return document.documentElement.outerHTML + ' ' + Array.from(document.querySelectorAll('input,textarea')).map(function(e){return e.value;}).join(' ');");
    check("ISOUI23 · User B 流程 DOM / input 无 raw secret", !domBlob.includes(SECRET), "bytes=" + domBlob.length);
    const responseHit = modelResponses.some((r) => hitsSecret(r.response));
    check("ISOUI24 · 全部 preload responses 无 raw secret / 无 credentialRef", !responseHit && !JSON.stringify(modelResponses).includes('"cred_'), "responses=" + modelResponses.length);
    report.responses = modelResponses.map((r) => r.command);
    report.scans = { a11y: a11yObj, focusSeq, responseHit, names };
    report.selfHit = JSON.stringify(report).includes(SECRET);
    check("ISOUI25 · report 自身不含 raw secret", report.selfHit === false, "");
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    try { win?.destroy(); } catch { /* ignore */ }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
