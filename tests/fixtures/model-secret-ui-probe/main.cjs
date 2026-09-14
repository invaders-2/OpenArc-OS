/**
 * D4-01 Closure E · Full Secret Scan（真实 Electron 侧）。
 *
 * 覆盖只有真实 Electron 才能验证的面：
 *   · Renderer DOM / input / textarea / dataset / data-* 属性
 *   · preload 可观察的 model:command response
 *   · IPC 错误投影（invalid endpoint / 401 / 500 / provider error echo）
 *   · 真实 safeStorage 加密 blob（credentials/<ref>.bin）不含 raw secret
 *   · 整个 userData 递归字节扫描
 *   · IdentityLogger 泄漏扫描
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
const ADMIN = "admin@openarc.test";
const PW = "admin-password-1";
const SECRET = process.env.OA_FULLSCAN_SECRET || "";
const FAKE = process.env.OA_FAKE_BASE_URL;
const ECHO = process.env.OA_ECHO_BASE_URL;
const ERR = process.env.OA_ERR_BASE_URL;
const userData = process.env.OA_USERDATA;
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

// 记录 Renderer 可观察的 model:command response（不改变行为）
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

function hitsIn(value) { const t = typeof value === "string" ? value : JSON.stringify(value ?? null); return t != null && t.includes(SECRET); }
function walkFiles(dir) {
  const out2 = [];
  const visit = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const p = path.join(d, e.name); if (e.isDirectory()) visit(p); else out2.push(p); }
  };
  visit(dir);
  return out2;
}

if (userData) app.setPath("userData", userData);
app.whenReady().then(async () => {
  try {
    const identity = createIdentityService({ userDataDir: userData, safeStorage, allowAdmin: true });
    await identity.store.initialize({ identifier: ADMIN, password: PW, displayName: "Admin" });
    identity.logger.registerSecret(SECRET);
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
    check("UI1 · 真实 safeStorage 可用（electron-safe-storage）", identity.credentialStore.available() === true && identity.credentialStore.backend.kind === "electron-safe-storage", identity.credentialStore.backend.kind);
    await setValue('[data-d3-id="login-identifier"]', ADMIN);
    await setValue('[data-d3-id="login-password"]', PW);
    await click('[data-d3-id="login-submit"]');
    check("UI2 · 登录", (await waitGate("ready")) === "ready", "");
    await click('[data-app-id="settings"]');
    await waitSel('[data-settings-pane="model"]');
    await click('[data-settings-pane="model"]');
    check("UI3 · 打开 Settings → 模型 / AI", await waitSel('[data-d4-01="settings"]'), "");

    // ---- 正常流程：创建 provider（secret）+ model + default + test ----
    await setValue('[data-d4-01-provider-name]', "ScanSuccess");
    await setValue('[data-d4-01-provider-url]', FAKE);
    await setValue('[data-d4-01-provider-secret]', SECRET);
    await click('[data-d4-01-provider-create]');
    check("UI4 · 创建 Provider", await waitSel('[data-d4-01-provider]'), "");
    const pid = await js("return document.querySelector('[data-d4-01-provider]').getAttribute('data-d4-01-provider')");
    check("UI5 · 保存后密钥输入框清空（write-only）", (await js("return document.querySelector('[data-d4-01-provider-secret]').value")) === "", "");
    await click('[data-d4-01-tab="models"]');
    await waitSel('[data-d4-01-pane="models"]');
    await setValue('[data-d4-01-model-provider]', pid);
    await setValue('[data-d4-01-model-remote]', "fake-1");
    await setValue('[data-d4-01-model-name]', "ScanModel");
    await click('[data-d4-01-model-create]');
    check("UI6 · 注册 Model", await waitSel('[data-d4-01-model]'), "");
    const cid = await js("return document.querySelector('[data-d4-01-model]').getAttribute('data-d4-01-model')");
    await click('[data-d4-01-tab="defaults"]');
    await waitSel('[data-d4-01-pane="defaults"]');
    await setValue('[data-d4-01-default-personal-chat]', cid);
    await waitFn("document.querySelector('[data-d4-01-default-personal-chat]').value===" + JSON.stringify(cid));
    await click('[data-d4-01-tab="providers"]');
    await waitSel('[data-d4-01-pane="providers"]');
    await click('[data-d4-01-test="' + pid + '"]');
    check("UI7 · Connection Test PASS（真实调用）", await waitFn("(document.querySelector('[data-d4-01-test-result=\"" + pid + "\"]')?.textContent||'').indexOf('Inference:PASS')>=0"), await txt('[data-d4-01-test-result="' + pid + '"]'));

    // ---- DOM 扫描（save completed + input cleared）----
    const domBlob = await js("return JSON.stringify({html:document.documentElement.outerHTML,text:document.body.innerText,inputs:Array.from(document.querySelectorAll('input,textarea')).map(function(e){return e.value;}),datasets:Array.from(document.querySelectorAll('*')).reduce(function(a,el){Object.keys(el.dataset||{}).forEach(function(k){a.push(k+'='+el.dataset[k]);});return a;},[]),attrs:Array.from(document.querySelectorAll('*')).reduce(function(a,el){Array.from(el.attributes||[]).forEach(function(x){if(x.name.indexOf('data-')===0)a.push(x.name+'='+x.value);});return a;},[]),storage:JSON.stringify(Object.entries(localStorage)) });");
    const domHits = domBlob.includes(SECRET);
    check("UI8 · Renderer DOM / input / dataset / data-* 无 raw secret", !domHits, "scanBytes=" + domBlob.length);
    report.scans.dom = { hit: domHits, bytes: domBlob.length };

    // ---- Preload response ----
    const required = ["provider/list", "credential/status", "model/list", "defaults/get", "model/test"];
    const seen = new Set(modelResponses.map((r) => r.command));
    const missing = required.filter((c) => !seen.has(c));
    const responseHit = modelResponses.some((r) => hitsIn(r.response));
    check("UI9 · preload responses 覆盖关键命令且无 raw secret", missing.length === 0 && !responseHit, "seen=" + [...seen].join(",") + " missing=" + missing.join(","));
    report.responses = { seen: [...seen], count: modelResponses.length, hit: responseHit };

    // ---- IPC 错误矩阵（Renderer 可观察）----
    const ep = await callCommand("provider/create", { displayName: "bad", baseUrl: "file:///etc/passwd", credentialSecret: SECRET });
    const echoP = await callCommand("provider/create", { displayName: "Echo", baseUrl: ECHO, credentialSecret: SECRET });
    const echoM = await callCommand("model/create", { providerId: echoP.provider.providerId, remoteModelId: "fake-1", capabilities: ["chat"] });
    const echoTest = await callCommand("model/test", { configId: echoM.model.configId });
    const errP = await callCommand("provider/create", { displayName: "Err500", baseUrl: ERR, credentialSecret: SECRET });
    const errM = await callCommand("model/create", { providerId: errP.provider.providerId, remoteModelId: "fake-1", capabilities: ["chat"] });
    const errTest = await callCommand("model/test", { configId: errM.model.configId });
    const errResponses = [ep, echoP, echoM, echoTest, errP, errM, errTest];
    check("UI10 · invalid endpoint → ENDPOINT_BLOCKED", ep.error === "ENDPOINT_BLOCKED", JSON.stringify(ep).slice(0, 120));
    check("UI11 · provider 401（error echo）→ AUTH_FAILED，响应无 raw secret", echoTest.error === "AUTH_FAILED" && !hitsIn(echoTest), JSON.stringify(echoTest).slice(0, 160));
    check("UI12 · provider 500 → PROVIDER_UNAVAILABLE，响应无 raw secret", errTest.error === "PROVIDER_UNAVAILABLE" && !hitsIn(errTest), JSON.stringify(errTest).slice(0, 160));
    check("UI13 · 所有 IPC 错误投影无 raw secret / 无 Authorization", !errResponses.some((r) => hitsIn(r)) && !JSON.stringify(errResponses).includes("Bearer"), "");
    report.scans.ipcErrors = { codes: { endpoint: ep.error, auth: echoTest.error, server: errTest.error } };

    // ---- credential replace/delete：制造审计记录，再扫描 ----
    const replaced = await callCommand("credential/replace", { providerId: pid, secret: SECRET });
    const deleted = await callCommand("credential/delete", { providerId: pid });
    check("UI13b · credential replace/delete 真实生效且响应无 raw secret", replaced.ok === true && replaced.credentialVersion >= 2 && deleted.ok === true && deleted.configured === false && !hitsIn([replaced, deleted]), "");

    // ---- 真实 safeStorage 加密 blob + userData 扫描 ----
    const credDir = path.join(userData, "credentials");
    const blobs = fs.existsSync(credDir) ? fs.readdirSync(credDir).filter((f) => f.endsWith(".bin")) : [];
    const blobHits = [];
    const modes = [];
    for (const b of blobs) { const p = path.join(credDir, b); const buf = fs.readFileSync(p); if (buf.toString("latin1").includes(SECRET)) blobHits.push(b); modes.push((fs.statSync(p).mode & 0o777).toString(8)); }
    check("UI14 · 真实加密 blob 存在且不含 raw secret（ciphertext only）", blobs.length >= 1 && blobHits.length === 0, "blobs=" + blobs.length + " modes=" + modes.join(","));
    check("UI15 · blob 权限 0600", modes.length > 0 && modes.every((m) => m === "600"), modes.join(","));
    const userDataFiles = walkFiles(userData);
    const userDataHits = [];
    for (const file of userDataFiles) { let buf; try { buf = fs.readFileSync(file); } catch { continue; } if (buf.toString("latin1").includes(SECRET)) userDataHits.push(path.relative(userData, file)); }
    check("UI16 · 整个 userData 递归扫描无 raw secret", userDataHits.length === 0, "files=" + userDataFiles.length + " hits=" + userDataHits.length);

    // ---- DB / audit / call records / logger ----
    const db = identity.store.connection;
    const meta = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all();
    let dbHits = 0; let cells = 0;
    for (const m of meta) {
      if (m.name.startsWith("sqlite_")) continue;
      let rows; try { rows = db.prepare('SELECT * FROM "' + m.name + '"').all(); } catch { continue; }
      for (const row of rows) for (const val of Object.values(row)) { cells += 1; const t = typeof val === "string" ? val : val == null || typeof val === "number" ? "" : String(val); if (t.includes(SECRET)) dbHits += 1; }
    }
    const auditRows = identity.authStore.authorizationAudit();
    const auditHits = hitsIn(auditRows) ? 1 : 0;
    const callRows = identity.modelStore.recentCalls(50);
    const callHits = hitsIn(callRows) ? 1 : 0;
    const leaks = identity.logger.leaks();
    check("UI17 · userData DB 全表无 raw secret", dbHits === 0, "tables=" + meta.length + " cells=" + cells);
    check("UI18 · audit / call records / logger 无 raw secret", auditRows.length >= 1 && auditHits === 0 && callHits === 0 && leaks.length === 0, "audit=" + auditRows.length + " calls=" + callRows.length + " leaks=" + leaks.length);
    report.scans.db = { tables: meta.length, cells, hits: dbHits };
    report.scans.audit = { rows: auditRows.length, hits: auditHits };
    report.scans.callRecords = { rows: callRows.length, hits: callHits };
    report.scans.logger = { records: identity.logger.records.length, leaks: leaks.length };
    report.scans.userData = { files: userDataFiles.length, hits: userDataHits.length };
    report.scans.blobs = { count: blobs.length, modes, hits: blobHits.length };

    // ---- 最终：把 SECRET 从内存 report 里再次确认无残留 ----
    report.selfHit = JSON.stringify(report).includes(SECRET);
    check("UI19 · report 自身不含 raw secret", report.selfHit === false, "");
  } catch (e) {
    report.errors.push(String((e && e.stack) || e));
    check("探针整体未抛异常", false, String(e.message).slice(0, 200));
  } finally {
    try { win?.destroy(); } catch { /* ignore */ }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
