/**
 * DXOS-CANVAS-SCOPE · 真机验证：应用内模态输入（openarc-rename-modal.js）替代 window.prompt。
 *
 * 背景：Electron 的 Chromium 不支持 window.prompt（上游在画布列表页与智能画布都用它做重命名）。
 * 本探针跑真实 Electron（electron .，隔离 --user-data-dir + 唯一 CDP 端口），逐条验证：
 *   M1 列表页真实卡片「重命名」→ 打开应用内模态（不再有原生 prompt）
 *   M2 空值不提交：内联错误提示，模态保持打开，服务端标题未变
 *   M3 Esc 取消：模态关闭、服务端标题未变
 *   M4 确认提交：模态关闭，/api/canvases/:id/meta 真的落库（重读 meta 验证）
 *   M5 提交失败：结构化错误（HTTP 状态 + 原因）留在模态内，不关窗
 *   M6 智能画布「提示词模板分组 新建」同样走应用内模态（真按钮路径）
 *   M7 0 console error / 0 pageerror / 0 条 404 / 0 条 5xx
 *   M8 截图：列表 + 模态（浅/深）
 *   收工：真实 profile 只读快照前后比对；杀子进程 + 删隔离 userData。
 *
 * 用法：node experiments/dxos-canvas-scope/rename-modal-probe.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-scope");
const SHOTS = path.join(ART, "shots");
const CDP_PORT = Number(process.env.OA_CANVAS_SCOPE_CDP_PORT || 9861);
const ADMIN = { id: "admin@oa-scope.test", pw: "oa-scope-admin-1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function realProfilePath() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openarc-os");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "openarc-os");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "openarc-os");
}
const statOf = (p) => { try { const s = fs.statSync(p); return { exists: true, mtimeMs: Math.round(s.mtimeMs), size: s.size, ino: s.ino }; } catch { return { exists: false }; } };
const sha256File = (p) => { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; } };
function snapshotProfile(dir) {
  const out = { path: dir, exists: fs.existsSync(dir), identity: {}, topLevel: {} };
  for (const name of ["identity.db", "identity.db-wal", "identity.db-shm"]) {
    const st = statOf(path.join(dir, name));
    out.identity[name] = st.exists ? { ...st, sha256: sha256File(path.join(dir, name)) } : st;
  }
  try { for (const name of fs.readdirSync(dir)) { const st = statOf(path.join(dir, name)); out.topLevel[name] = { mtimeMs: st.mtimeMs, size: st.size }; } } catch { /* 不存在 */ }
  return out;
}
const checks = [];
const record = (name, ok, expected, actual) => {
  checks.push({ name, status: ok ? "PASS" : "FAIL", expected: String(expected == null ? "" : expected), actual: typeof actual === "string" ? actual : JSON.stringify(actual) });
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + name + (ok ? "" : " -- 期望 " + expected + "，实际 " + JSON.stringify(actual)));
  return ok;
};
let passed = 0, failed = 0;
const check = (...a) => { if (record(...a)) passed += 1; else failed += 1; };

let child = null, browser = null, page = null, userDataDir = null, cdp = null, stderrBuf = "";
const consoleErrors = [], pageErrors = [], netFailures = [], requestUrls = new Map();
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
// 子页（iframe）内的读写 helper：`page.evaluate` 作用在顶层 UI 页，够不到 iframe 里的模态 DOM。
const inSet = (f, sel, v) => inFrame(f, "const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const inClick = (f, sel) => inFrame(f, "const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const inKey = (f, key) => inFrame(f, "document.dispatchEvent(new KeyboardEvent('keydown', { key:" + JSON.stringify(key) + ", bubbles:true })); return 'key';");
const gate = () => js("return document.querySelector('.desktop') ? document.querySelector('.desktop').getAttribute('data-identity-gate') : 'no-root'");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const waitSel = (sel, ms) => waitFor(() => js("return !!document.querySelector(" + JSON.stringify(sel) + ")"), ms || 20000);
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const smartFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/smart-canvas\.html/);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 300) }; }
}

async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-scope-"));
  const childEnv = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + CDP_PORT, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪（exit=" + child.exitCode + "）。electron stderr 尾部：" + stderrBuf.slice(-1500));
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  const isUI = (p) => /[\\/]dist[\\/](vue|index)\.html/.test(p.url());
  while (!page && Date.now() < end) { page = ctx.pages().find(isUI) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面：" + JSON.stringify(ctx.pages().map((p) => p.url())));
  page.on("dialog", (d) => { void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push({ url: String((m.location() || {}).url || "").slice(0, 120), text: m.text().slice(0, 300) }); });
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
  cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }).catch(() => {});
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => requestUrls.set(e.requestId, e.request.url));
  cdp.on("Network.responseReceived", (e) => { if (e.response.status >= 400) netFailures.push({ kind: "response", status: e.response.status, url: e.response.url }); });
  cdp.on("Network.loadingFailed", (e) => netFailures.push({ kind: "loadingFailed", status: 0, errorText: e.errorText, url: requestUrls.get(e.requestId) || "" }));
}

async function login() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const next = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "OA Scope Admin"); await next();
    await waitSel('[data-d3-id="setup-identifier"]', 10000); await setInput('[data-d3-id="setup-identifier"]', ADMIN.id); await next();
    await waitSel('[data-d3-id="setup-password"]', 10000); await setInput('[data-d3-id="setup-password"]', ADMIN.pw); await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}
async function openAppWindow() {
  await js("const el = document.querySelector('[data-dock-id=\"canvas\"]') || document.querySelector('[aria-label=\"打开无限画布\"]') || document.querySelector('[aria-label=\"打开AI Studio\"]'); if (el) el.click(); return !!el;");
  return await waitFor(() => js("return !!document.querySelector('[data-canvas-host]')"), 20000);
}
async function shot(name) { fs.mkdirSync(SHOTS, { recursive: true }); const p = path.join(SHOTS, name + ".png"); await page.screenshot({ path: p }).catch(() => {}); return path.relative(ROOT, p); }

const MODAL_STATE = "const ov = document.querySelector('.openarc-prompt-overlay.active'); const inp = ov && ov.querySelector('.openarc-prompt-input'); const err = ov && ov.querySelector('[data-openarc-prompt-error]'); return ov ? { open: true, value: inp ? inp.value : null, error: err ? String(err.textContent || '') : '', focused: document.activeElement === inp, rootFlag: document.documentElement.getAttribute('data-openarc-prompt-open') } : { open: false };";

async function waitModal(f, ms) { await waitFor(async () => { const s = await inFrame(f, MODAL_STATE); return !!(s && s.open); }, ms || 10000); return await inFrame(f, MODAL_STATE); }

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const realProfile = realProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  await launch();
  await login();
  check("a0 · 真实 electron . 启动 + 登录（隔离 userData + CDP " + CDP_PORT + "）", (await gate()) === "ready", "ready", await gate());
  await openAppWindow();
  const listUp = await waitFor(() => !!listFrame(), 25000);
  check("a1 · 打开画布应用（列表页）", listUp, "canvas-list.html", listUp);

  const modalReady = await waitFor(async () => (await inFrame(listFrame(), "return typeof window.__openarcPrompt === 'function';")).toString() === "true", 15000);
  const injected = await inFrame(listFrame(), "const s = Array.prototype.map.call(document.querySelectorAll('script[src]'), function(x){return x.getAttribute('src');}); return { modal: s.indexOf('/openarc-rename-modal.js') >= 0, prompt: typeof window.prompt === 'function' };");
  check("a2 · 列表页注入 openarc-rename-modal.js 且 __openarcPrompt 可用", modalReady && injected.modal === true, "注入 + 函数可用", injected);

  // 造一张真实的画布卡片（经桥登记端点 POST /api/canvases）
  const created = await inFrame(listFrame(), "const r = await fetch('/api/canvases', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title:'OA-SCOPE-原值', icon:'🧩', kind:'classic', project:'default' }) }); const j = await r.json().catch(function(){ return {}; }); return { status: r.status, id: (j.canvas||{}).canvasId || (j.canvas||{}).id || null, title: (j.canvas||{}).title || null };");
  check("a3 · 造一张真实画布（POST /api/canvases）", created && created.status === 200 && !!created.id, "200 + canvasId", created);
  const canvasId = created && created.id;
  await inFrame(listFrame(), "location.reload(); return 'reloading';");
  await waitFor(() => inFrame(listFrame(), "return document.readyState === 'complete';").then((v) => v === true), 20000);
  const cardUp = await waitFor(async () => { const s = await inFrame(listFrame(), "const cards = Array.prototype.slice.call(document.querySelectorAll('#cardsGrid .project-card')); const hit = cards.filter(function(c){ return (c.textContent||'').indexOf('OA-SCOPE-原值') >= 0; }); return { total: cards.length, hit: hit.length };"); return !!(s && s.hit >= 1); }, 20000);
  check("a4 · 列表渲染出刚建的画布卡片", cardUp, "卡片命中 1", "ok");
  const shotList = await shot("list-light");

  // M1 · 真实卡片菜单 → 重命名 → 应用内模态
  const openModal = await inFrame(listFrame(), "const cards = Array.prototype.slice.call(document.querySelectorAll('#cardsGrid .project-card')); const card = cards.filter(function(c){ return (c.textContent||'').indexOf('OA-SCOPE-原值') >= 0; })[0]; if(!card) return 'no-card'; card.querySelector('.card-more-btn').click(); const item = card.querySelector('[data-action=\"rename\"]'); if(!item) return 'no-item'; item.click(); return 'clicked';");
  const modal1 = await waitModal(listFrame());
  const shotModalLight = await shot("modal-light");
  check("M1 · 卡片「重命名」打开应用内模态（输入框预填当前标题、自动聚焦、无原生 prompt）", openModal === "clicked" && !!modal1 && modal1.value === "OA-SCOPE-原值" && modal1.focused === true && modal1.rootFlag === "1", "modal.value=原值 + focused", { openModal, modal1 });

  // M2 · 空值不提交
  await inSet(listFrame(), ".openarc-prompt-overlay.active .openarc-prompt-input", "   ");
  await inClick(listFrame(), ".openarc-prompt-overlay.active [data-openarc-prompt-confirm]");
  await sleep(300);
  const modal2 = await inFrame(listFrame(), MODAL_STATE);
  const metaAfterEmpty = await inFrame(listFrame(), "const r = await fetch('/api/canvases/' + encodeURIComponent(" + JSON.stringify(canvasId) + ") + '/meta'); const j = await r.json().catch(function(){ return {}; }); return { status: r.status, title: (j.canvas||{}).title || j.title || null };");
  check("M2 · 空值不提交：内联错误 + 模态保持打开 + 服务端标题未变", !!modal2 && modal2.open === true && /名称不能为空/.test(modal2.error || "") && metaAfterEmpty && metaAfterEmpty.title === "OA-SCOPE-原值", "错误文案 + 标题不变", { modal2, metaAfterEmpty });

  // M3 · Esc 取消
  await inKey(listFrame(), "Escape");
  const closedByEsc = await waitFor(async () => { const s = await inFrame(listFrame(), MODAL_STATE); return s && s.open === false; }, 8000);
  const metaAfterEsc = await inFrame(listFrame(), "const r = await fetch('/api/canvases/' + encodeURIComponent(" + JSON.stringify(canvasId) + ") + '/meta'); const j = await r.json().catch(function(){ return {}; }); return { title: (j.canvas||{}).title || j.title || null };");
  check("M3 · Esc 取消：模态关闭、服务端标题未变", closedByEsc && metaAfterEsc && metaAfterEsc.title === "OA-SCOPE-原值", "closed + 标题不变", { closedByEsc, metaAfterEsc });

  // M4 · 确认提交真的落库
  await inFrame(listFrame(), "const cards = Array.prototype.slice.call(document.querySelectorAll('#cardsGrid .project-card')); const card = cards.filter(function(c){ return (c.textContent||'').indexOf('OA-SCOPE-原值') >= 0; })[0]; if(!card) return 'no-card'; card.querySelector('.card-more-btn').click(); card.querySelector('[data-action=\"rename\"]').click(); return 'clicked';");
  await waitModal(listFrame());
  await inSet(listFrame(), ".openarc-prompt-overlay.active .openarc-prompt-input", "OA-SCOPE-新值");
  await inClick(listFrame(), ".openarc-prompt-overlay.active [data-openarc-prompt-confirm]");
  await sleep(1500);
  const modal4 = await inFrame(listFrame(), MODAL_STATE);
  const closedAfterOk = !!(modal4 && modal4.open === false);
  const metaAfterOk = await inFrame(listFrame(), "const r = await fetch('/api/canvases/' + encodeURIComponent(" + JSON.stringify(canvasId) + ") + '/meta'); const j = await r.json().catch(function(){ return {}; }); return { title: (j.canvas||{}).title || j.title || null };");
  const cardRenamed = await waitFor(async () => (await inFrame(listFrame(), "return (document.getElementById('cardsGrid').textContent||'').indexOf('OA-SCOPE-新值') >= 0;")).toString() === "true", 10000);
  check("M4 · 确认提交：模态关闭 + /meta 真的落库 + 卡片重渲染", closedAfterOk && metaAfterOk && metaAfterOk.title === "OA-SCOPE-新值" && cardRenamed, "标题=新值", { closedAfterOk, modal4, metaAfterOk, cardRenamed });

  // M5 · 提交失败：结构化错误留在模态内
  const failure = await inFrame(listFrame(), "window.__oaScopeFail = null; window.__openarcPrompt({ title:'失败路径', value:'x', confirmText:'提交', onSubmit: function(){ var e = new Error('boom'); e.status = 500; return Promise.reject(e); } }).then(function(v){ window.__oaScopeFail = v; }); await new Promise(function(r){ setTimeout(r, 250); }); return 'opened';");
  await waitModal(listFrame(), 8000);
  await inClick(listFrame(), ".openarc-prompt-overlay.active [data-openarc-prompt-confirm]");
  await sleep(500);
  const modal5 = await inFrame(listFrame(), MODAL_STATE);
  const shotModalFailure = await shot("modal-failure");
  check("M5 · 提交失败：结构化错误（HTTP 500 + 原因）留在模态内、不关窗", failure === "opened" && !!modal5 && modal5.open === true && /HTTP 500/.test(modal5.error || "") && /boom/.test(modal5.error || ""), "错误含 HTTP 500 与 boom", { failure, modal5 });
  await inKey(listFrame(), "Escape");
  await sleep(400);

  // M8 · 深色主题截图：列表重命名模态（沿用页面自己的主题类名，不做第二套换肤）
  await inFrame(listFrame(), "document.documentElement.classList.add('studio-theme-dark','theme-dark'); return 'dark';");
  await inFrame(listFrame(), "const cards = Array.prototype.slice.call(document.querySelectorAll('#cardsGrid .project-card')); const card = cards[0]; if(!card) return 'no-card'; card.querySelector('.card-more-btn').click(); card.querySelector('[data-action=\"rename\"]').click(); return 'clicked';");
  await waitModal(listFrame(), 10000);
  await sleep(400);
  const shotModalDark = await shot("modal-dark");
  await inKey(listFrame(), "Escape");
  await sleep(400);
  await inFrame(listFrame(), "document.documentElement.classList.remove('studio-theme-dark','theme-dark'); return 'light';");
  // M6 · 智能画布：真实「提示词模板分组 新建」按钮路径
  await inFrame(listFrame(), "const el = document.getElementById('pickerSmart'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const smartUp = await waitFor(() => !!smartFrame(), 45000);
  const smartModalReady = await waitFor(async () => (await inFrame(smartFrame(), "return typeof window.__openarcPrompt === 'function';")).toString() === "true", 20000);
  check("M6a · 智能画布页注入 openarc-rename-modal.js", smartUp && smartModalReady, "smart-canvas.html + 函数可用", { smartUp, smartModalReady });
  const groupFlow = await inFrame(smartFrame(), "const t = document.getElementById('composerTemplateBtn'); if(!t) return 'no-template-btn'; t.click(); await new Promise(function(r){ setTimeout(r, 400); }); const edit = document.querySelector('[data-template-group-edit]'); if(!edit) return 'no-edit'; edit.click(); await new Promise(function(r){ setTimeout(r, 250); }); const add = document.querySelector('[data-template-cat-new]'); if(!add) return 'no-add'; add.click(); await new Promise(function(r){ setTimeout(r, 300); }); const ov = document.querySelector('.openarc-prompt-overlay.active'); return ov ? { open: true, value: (ov.querySelector('.openarc-prompt-input')||{}).value } : { open: false };");
  check("M6b · 智能画布「新建模板分组」打开应用内模态", groupFlow && groupFlow.open === true, "模态打开", groupFlow);
  const shotSmartModal = await shot("smart-modal");
  await inFrame(smartFrame(), "document.documentElement.classList.add('studio-theme-dark','theme-dark'); return 'dark';");
  await sleep(300);
  const shotSmartModalDark = await shot("smart-modal-dark");
  await inFrame(smartFrame(), "document.documentElement.classList.remove('studio-theme-dark','theme-dark'); return 'light';");
  const groupsBefore = await inFrame(smartFrame(), "return document.querySelectorAll('[data-template-cat]').length;");
  await inSet(smartFrame(), ".openarc-prompt-overlay.active .openarc-prompt-input", "OA-SCOPE-分组");
  await inClick(smartFrame(), ".openarc-prompt-overlay.active [data-openarc-prompt-confirm]");
  const groupCreated = await waitFor(async () => (await inFrame(smartFrame(), "return (document.getElementById('promptTemplatePanel')||document.body).textContent.indexOf('OA-SCOPE-分组') >= 0;")).toString() === "true", 10000);
  check("M6c · 智能画布确认后真的建出分组（模态替代 prompt 的完整路径）", groupCreated, "面板出现 OA-SCOPE-分组", { groupsBefore, groupCreated });
  await inKey(smartFrame(), "Escape");

  const shotSmart = await shot("smart-light");
  await sleep(800);
  const pageErrorsFiltered = pageErrors.filter((e) => !/AbortError|The operation was aborted/.test(e));
  const notFound = netFailures.filter((f) => f.status === 404);
  const serverErrors = netFailures.filter((f) => f.status >= 500);
  check("M7a · 0 条 404（asset not found）", notFound.length === 0, "0 个 404", notFound.slice(0, 10));
  check("M7b · 0 条 pageerror", pageErrorsFiltered.length === 0, "0 条 pageerror", pageErrorsFiltered.slice(0, 10));
  check("M7c · 0 条网络 5xx", serverErrors.length === 0, "0 个 5xx", serverErrors.slice(0, 10));
  check("M7d · 0 条 console error", consoleErrors.length === 0, "0 条 console error", consoleErrors.slice(0, 10));

  const result = {
    ok: failed === 0, cdpPort: CDP_PORT, canvasId, checks,
    shots: { list: shotList, modalLight: shotModalLight, modalDark: shotModalDark, modalFailure: shotModalFailure, smartModal: shotSmartModal, smartModalDark: shotSmartModalDark, smart: shotSmart },
    consoleErrors, pageErrors: pageErrorsFiltered, notFound, serverErrors,
  };
  fs.writeFileSync(path.join(ART, "RESULT.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("\n==== 截图 ====");
  for (const [k, v] of Object.entries(result.shots)) console.log("  " + k + ": " + v);

  try { await browser.close(); } catch { /* ignore */ }
  browser = null;
  if (child && !child.killed) { child.kill("SIGTERM"); await sleep(1200); try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
  const profileAfter = snapshotProfile(realProfile);
  fs.writeFileSync(path.join(ART, "profile-before.json"), JSON.stringify(profileBefore, null, 2) + "\n");
  fs.writeFileSync(path.join(ART, "profile-after.json"), JSON.stringify(profileAfter, null, 2) + "\n");
  const changed = [];
  for (const name of ["identity.db", "identity.db-wal", "identity.db-shm"]) if (JSON.stringify(profileBefore.identity[name]) !== JSON.stringify(profileAfter.identity[name])) changed.push("identity:" + name);
  for (const name of new Set([...Object.keys(profileBefore.topLevel || {}), ...Object.keys(profileAfter.topLevel || {})])) if (JSON.stringify(profileBefore.topLevel[name]) !== JSON.stringify(profileAfter.topLevel[name])) changed.push("top:" + name);
  check("f · 真实 profile 收工前后未变（只读快照）", changed.length === 0, "完全一致", changed.slice(0, 20));
  result.profileUnchanged = changed.length === 0;
  result.profileChanged = changed;
  result.isolatedUserDataRemoved = !fs.existsSync(userDataDir);
  result.ok = failed === 0;
  fs.writeFileSync(path.join(ART, "RESULT.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("\n==== 汇总：PASS " + passed + " / FAIL " + failed + " ====");
  process.exitCode = result.ok ? 0 : 1;
}

main().catch(async (e) => {
  console.error("探针异常：" + String((e && e.stack) || e));
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  if (child && !child.killed) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
  process.exitCode = 2;
});
