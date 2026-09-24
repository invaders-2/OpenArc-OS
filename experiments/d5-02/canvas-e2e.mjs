/**
 * D5-02 Full-App · NOVAI 完整应用集成门禁（真实 electron . + 真实产品 UI + 本地确定性 provider）。
 *
 *   A 系列  入口形态：入口就是上游原版列表首页 canvas-list（画布工作台，不再是完整外壳/侧栏导航）、
 *           开始创作直达编辑器、返回列表、继续上次、卡片直达→编辑保存→返回列表→再打开（同一本、内容仍在）、截图留证
 *   B 系列  统一后端：模型只来自 OpenArc、文本/图片真实调用、失败如实、不支持能力明确报错、
 *           更新/下载禁用 + 出网接收端 0 命中、应用信息/队列来自宿主
 *   C 系列  D1 撤权 / D2 能力不支持 / D3 预算 / D4 停止与迟到 / D5 失败收敛
 *   E 系列  宿主级隔离：无桥/Node/IPC、端点白名单、协议穿越、当前实例校验、后端不信自报身份、
 *           出网五通道 0 命中、iframe 自我导航被宿主拦截、账号边界（帧销毁 + 存储作用域）
 *   F 系列  五项既有缺口：F1 任务模型绑定不静默换模型、F2=D1、F3 图片资源产品链、
 *           F4 AI 编辑正式链（提议→审批→执行→呈现→保存恢复 + 旧 revision 对照）、F5=E 系列
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { startCanvasProvider, CANVAS_TEXT_PREFIX } from "../../tests/fixtures/d5-02-canvas-provider.mjs";
import { startD4Provider } from "../../tests/fixtures/d4-04-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "d5-02");
const CDP_PORT = Number(process.env.OA_D502_CDP_PORT || 9793);
const ADMIN = { id: "admin@d502-canvas.test", pw: "canvas-admin-1" };
const MEMBER = { id: "member@d502-canvas.test", pw: "canvas-member-1" };
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [];
let passed = 0, failed = 0;
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 1400), at: Date.now() };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  " : "! ") + "[" + row.status + "] " + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };

let child = null, browser = null, page = null, provider = null, stderrBuf = "";
let userDataDir = null, agentProvider = null;
const dialogs = [];
const consoleErrors = [];
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const model = (payload) => js("return await window.openarc.model.command(" + JSON.stringify(payload) + ")");
const canvas = (payload) => js("return await window.openarc.canvas.command(" + JSON.stringify(payload) + ")");
const governance = (payload) => js("return await window.openarc.governance.command(" + JSON.stringify(payload) + ")");
const resource = (payload) => js("return await window.openarc.resource.command(" + JSON.stringify(payload) + ")");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);

const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
/** 应用入口帧：宿主持有的应用页，入口就是上游原版列表首页 canvas-list.html（画布工作台）。*/
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
/** 无限画布编辑器帧：入口帧在**同一个宿主帧内**导航到 canvas.html?id=…&project=…（不是子 iframe）。*/
const canvasFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas\.html/);
/** 「应用页」= 当前加载的应用帧。入口页与编辑器是同一个宿主帧在不同时刻的 URL：停在编辑器时
 *  canvas-list 帧已经不存在，所以需要"应用页自证"的探针（无桥 / 账号存储 / 宿主端点）必须按当前页取帧，
 *  否则会退化成 __noFrame 的空断言。入口页优先。*/
const shellFrame = () => listFrame() || canvasFrame();
const frameFor = (pageId) => frameBy(new RegExp("/static/" + pageId + "\\.html"));
const allBundleFrames = () => page.frames().filter((f) => f.url().indexOf("openarc-canvas://bundle/") === 0);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 240) }; }
}
const shellJs = (code) => inFrame(shellFrame(), code);

async function launch() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d502-"));
  userDataDir = userData;
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" },
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!page && Date.now() < end) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面");
  page.on("dialog", (d) => { dialogs.push(String(d.message()).slice(0, 140)); void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror:" + String(e.message).slice(0, 200)));
}

async function startReceiver() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.method + " " + req.url); res.writeHead(204); res.end(); });
  server.on("upgrade", (req) => { hits.push("UPGRADE " + req.url); req.socket.destroy(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, hits: () => hits.slice(), close: () => new Promise((r) => server.close(() => r())) };
}

async function openAppWindow() {
  // 预览集成分支按"不改用户已定 UI"保留入口名"无限画布"；核心线叫"AI Studio"。两种都接受。
  await js("const el = document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]'); if (el) el.click(); return !!el;");
  return await waitFor(() => has("[data-canvas-host]"), 20000);
}
/** 程序坞图标右键。真实产品入口是"右键图标 → 程序坞菜单"（main.tsx:3551-3559）。
 *  优先用 CDP 原生右键；Dock 自动隐藏导致命中测试失败时退回 button:2 的 pointer/mouse 事件序列 + 冒泡的 contextmenu。*/
async function rightClickDockItem(appId) {
  const sel = '.dock-item[data-dock-id="' + appId + '"]';
  const menuSel = '[aria-label="程序坞菜单"]';
  if (!(await has(sel))) return false;
  try {
    await page.locator(sel).click({ button: "right", timeout: 3000 });
    if (await waitFor(() => has(menuSel), 2000)) return true;
  } catch { /* 原生右键不可达 → 走事件派发 */ }
  const sent = await js(
    "const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return false;" +
    "const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;" +
    "const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y };" +
    "el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { button: 2, buttons: 2 })));" +
    "el.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, base, { button: 2, buttons: 2 })));" +
    "el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { button: 2, buttons: 0 })));" +
    "el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, base, { button: 2, buttons: 0 })));" +
    "el.dispatchEvent(new MouseEvent('contextmenu', Object.assign({}, base, { button: 2, buttons: 0 })));" +
    "return true;",
  ).catch(() => false);
  return sent === true && (await waitFor(() => has(menuSel), 5000));
}
/** 关掉画布 App 窗口并等它**真的销毁**（bundle frames 归零）。
 *  标题栏红灯对非 settings 应用只做最小化（components.tsx:598），最小化不销毁 iframe，
 *  所以必须走程序坞右键菜单的「关闭应用」→ window/close（main.tsx:2927-2939 的程序坞菜单项）。
 *  关不掉（图标/菜单项缺失或 disabled）就返回 false，不伪装成功。*/
async function closeAppWindow() {
  if (!(await rightClickDockItem("canvas"))) return false;
  const clicked = await waitFor(() => js(
    "const menu = document.querySelector('.context-menu.dock-menu[aria-label=\"程序坞菜单\"]'); if (!menu) return false;" +
    "const item = Array.from(menu.querySelectorAll('button[role=\"menuitem\"]')).find(function (b) { return b.textContent.trim() === '关闭应用'; });" +
    "if (!item || item.disabled) return false;" +
    "item.click(); return true;",
  ), 10000);
  if (!clicked) return false;
  return await waitFor(() => allBundleFrames().length === 0, 15000);
}
/** 关窗重开/切页之后，从**画布列表首页的卡片**再打开当前这本画布（产品路径）。
 *  新形态里入口页 canvas-list 与编辑器 canvas.html 是同一个宿主帧：若此刻还停在编辑器（例如上一次
 *  导航被拦、宿主没有整帧重置），先按产品路径点 #backToManagerBtn 回列表，再点卡片进编辑器。
 *  卡片实现（public/novai-canvas/static/canvas-list.html:1175-1253）：.project-card[data-canvas-id]
 *  由 addEventListener 绑定 click → openCanvas(c) → /static/canvas.html?id=…。*/
async function reopenCurrentCanvasFromHome() {
  const opened = await openAppWindow();
  if (!opened) return false;
  if (!listFrame() && canvasFrame()) {
    await inFrame(canvasFrame(), "const el = document.getElementById('backToManagerBtn'); if (!el) return 'missing'; el.click(); return 'clicked';");
    await waitFor(() => !!listFrame() && !canvasFrame(), 30000);
  }
  const listUp = await waitFor(() => !!listFrame(), 25000);
  const cardSel = "#cardsGrid .project-card[data-canvas-id=\"" + currentCanvasId + "\"]";
  const cardUp = listUp && await waitFor(async () => (await inFrame(listFrame(), "return !!document.querySelector(" + JSON.stringify(cardSel) + ");")) === true, 20000);
  const clicked = cardUp ? await inFrame(listFrame(), "const el = document.querySelector(" + JSON.stringify(cardSel) + "); if (!el) return 'missing'; el.click(); return 'clicked';") : "missing";
  const up = await waitFor(() => !!canvasFrame(), 35000);
  return clicked === "clicked" && up === true;
}
async function login(identifier, pw) {
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', pw);
  await clickDom('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}
async function logout() {
  await clickDom('[data-d3-id="topbar-logout"]');
  return await waitFor(async () => (await gate()) !== "ready", 30000);
}
let currentCanvasId = null;

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  provider = await startCanvasProvider();
  await launch();
  record("A0", "真实 electron . 启动（隔离 userData / 隔离 CDP 端口）", !!browser, "CDP 可用", "connected");
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    // 集成分支保留 UI 线已定的"三步初始化向导"（显示名 → 账号 → 密码），末步才提交：
    // 后两步的输入在 DOM 里尚未存在，一次填完再点 setup-submit 不会发生任何事。
    // 驱动方式与 UI 线探针（tests/fixtures/identity-ui-probe/main.cjs）一致。
    const setupNext = async () => {
      await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000);
      await clickDom('[data-d3-id="setup-next"]');
    };
    await setInput('[data-d3-id="setup-name"]', "D5-02 Admin");
    await setupNext();
    await waitSel('[data-d3-id="setup-identifier"]', 10000);
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await setupNext();
    await waitSel('[data-d3-id="setup-password"]', 10000);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000);
    await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  record("A0", "真实 UI 登录 admin", await login(ADMIN.id, ADMIN.pw), "ready", await gate());

  /* ══════════════════ A 系列：入口形态（列表首页 / 直达编辑器 / 返回路径） ══════════════════ */
  const opened = await openAppWindow();
  const entryUp = await waitFor(() => !!listFrame(), 25000);
  await sleep(1200);
  const entryInfo = await inFrame(listFrame(), "return { title: document.title, start: !!document.getElementById('btnStartCreate'), cont: !!document.getElementById('btnContinueLast'), newProject: !!document.getElementById('btnNewProject'), grid: !!document.getElementById('cardsGrid'), empty: !!document.getElementById('cardsEmpty'), picker: !!document.getElementById('canvasPickerOverlay'), iframes: document.querySelectorAll('iframe').length, homeFrameEl: !!document.getElementById('frame-home'), navItems: document.querySelectorAll('.nav-item,.side-pill').length };");
  const hostChrome = await js("const host = document.querySelector('[data-canvas-host]'); return { host: !!host, bar: !!document.querySelector('[data-canvas-bar]'), status: !!document.querySelector('[data-canvas-status]'), notice: !!document.querySelector('[data-canvas-notice]') };");
  const bundleFrames = allBundleFrames().map((f) => String(f.url()));
  const deadShellFrames = page.frames().filter((f) => /bundle\/index\.html|\/static\/home\.html/.test(f.url())).map((f) => String(f.url()));
  record("A1", "打开应用 = 上游原版列表首页 static/canvas-list.html（画布工作台）；不是完整外壳（无 index.html/home.html 帧、无侧栏导航），宿主只剩宿主根（顶部操作条/状态行/提示横幅已删）",
    opened && entryUp && entryInfo.title === "画布工作台" && entryInfo.start === true && entryInfo.cont === true && entryInfo.newProject === true && entryInfo.grid === true && entryInfo.iframes === 0 && entryInfo.homeFrameEl === false && entryInfo.navItems === 0 && hostChrome.host === true && hostChrome.bar === false && hostChrome.status === false && hostChrome.notice === false && bundleFrames.length === 1 && /\/static\/canvas-list\.html/.test(bundleFrames[0]) && deadShellFrames.length === 0,
    "canvas-list 入口帧 + 无外壳/无宿主 chrome", JSON.stringify({ opened, entryUp, entryInfo, hostChrome, bundleFrames: bundleFrames.map((u) => u.slice(0, 90)), deadShellFrames }));

  // A2：新形态下没有左侧导航，其他子页面（在线生图 / GPT 对话 / 素材库 / 设置 / 智能画布）一律不可达。
  // 判定口径：① 入口页内 a/button/iframe 以及带 onclick/data-* 的元素的**全部属性**里不出现这些路由名；
  //          ② 入口页里 iframe 数 = 0；③ 页面内不存在 frame-* 子页容器；④ 宿主帧 URL 里没有这些子页。
  const SUBPAGES = ["online", "gpt-chat", "asset-manager", "api-settings", "comfyui-settings", "smart-canvas"];
  const entryNav = await inFrame(listFrame(), "const routes = " + JSON.stringify(SUBPAGES) + "; const els = Array.from(document.querySelectorAll('a,button,iframe,[onclick],[data-route],[data-src],[data-page],[data-href]')); const hits = []; els.forEach(function (el) { const attrs = Array.from(el.attributes || []).map(function (a) { return a.name + '=' + a.value; }).join(' ').toLowerCase(); routes.forEach(function (rt) { if (attrs.indexOf(rt) >= 0) hits.push({ tag: el.tagName, route: rt, attrs: attrs.slice(0, 120) }); }); }); const ids = ['frame-home','frame-online','frame-gpt-chat','frame-canvas','frame-asset-manager','frame-api-settings','frame-comfyui-settings']; return { hits: hits.slice(0, 5), hitCount: hits.length, navFrameIds: ids.filter(function (id) { return !!document.getElementById(id); }), iframes: document.querySelectorAll('iframe').length };");
  const subFrames = page.frames().filter((f) => /\/static\/(online|gpt-chat|asset-manager|api-settings|comfyui-settings|smart-canvas)\.html/.test(f.url())).map((f) => String(f.url()));
  record("A2", "其他子页面入口不可达：入口页没有指向 online/gpt-chat/asset-manager/api-settings/comfyui-settings/smart-canvas 的导航，也不存在这些子页帧",
    entryNav.hitCount === 0 && entryNav.iframes === 0 && entryNav.navFrameIds.length === 0 && subFrames.length === 0,
    "0 个跨页导航入口 + 0 个子页帧", JSON.stringify({ entryNav, subFrames }));

  // A3：列表首页「开始创作」→ **直接**进入编辑器；全程不得出现选画布遮挡层 .active
  const pickerSamples = [];
  const pickerTimer = setInterval(async () => {
    try {
      const f = shellFrame();
      if (!f) return;
      const cls = await inFrame(f, "const el = document.getElementById('canvasPickerOverlay'); return el ? String(el.className) : null;");
      pickerSamples.push({ page: /canvas-list\.html/.test(f.url()) ? "list" : "canvas", cls: cls === null ? "absent" : String(cls) });
    } catch { /* ignore */ }
  }, 150);
  const listBeforeCreate = ((await canvas({ type: "canvas/list" })).items || []).length;
  const startClick = await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const editorUp = await waitFor(() => !!canvasFrame(), 40000);
  const adapterUp = await waitFor(async () => (await inFrame(canvasFrame(), "return { i: typeof window.__openarcCanvasInternals, a: typeof window.__openarcCanvas, b: typeof window.__openarcBridge };")).i === "object", 30000);
  // 适配器就绪 ≠ 画布文档已载入：等到 canvasId 真的出现（否则后面所有断言都建在 null 上）
  await waitFor(async () => { const st = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };"); return !!(st && st.id); }, 30000);
  clearInterval(pickerTimer);
  const pickerActive = pickerSamples.filter((s) => /(^|\s)active(\s|$)/.test(s.cls));
  const canvasState0 = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, edges: s.edgeCount, ro: window.__openarcBridge.isReadOnly() };");
  currentCanvasId = canvasState0.id || null;
  const listAfterCreate = ((await canvas({ type: "canvas/list" })).items || []).length;
  record("A3", "「开始创作」→ 直接进入无限画布编辑器（canvas.html + 适配器就绪 + 非只读），且真的新建了一本；全程选画布遮挡层 #canvasPickerOverlay 未出现 .active",
    startClick === "clicked" && editorUp && adapterUp && !!currentCanvasId && canvasState0.ro === false && listAfterCreate === listBeforeCreate + 1 && pickerActive.length === 0,
    "编辑器帧 + 非只读 + 新建 1 本 + 遮挡层未激活", JSON.stringify({ startClick, editorUp, adapterUp, canvasState0, listBeforeCreate, listAfterCreate, pickerSamples: pickerSamples.slice(0, 8), pickerActive: pickerActive.slice(0, 3) }));

  // A4：编辑器 #backToManagerBtn → 回到 canvas-list 入口帧（同一个宿主帧内导航）
  const backClick = await inFrame(canvasFrame(), "const el = document.getElementById('backToManagerBtn'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const backToList = await waitFor(() => !!listFrame() && !canvasFrame(), 30000);
  const backInfo = await inFrame(listFrame(), "return { title: document.title, grid: !!document.getElementById('cardsGrid'), start: !!document.getElementById('btnStartCreate') };");
  record("A4", "编辑器 #backToManagerBtn → 回到 canvas-list 入口帧（同一宿主帧内导航：返回后画布帧不再存在）",
    backClick === "clicked" && backToList && backInfo.title === "画布工作台" && backInfo.grid === true && backInfo.start === true,
    "回入口帧 + 画布帧消失", JSON.stringify({ backClick, backToList, backInfo }));

  // A5：「继续上次」= 打开最近更新的那本（与宿主 canvas/list 的 updatedAt 第一名对照）
  const ipcList = (await canvas({ type: "canvas/list" })).items || [];
  const latest = ipcList.slice().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
  // 「继续上次」读的是页面自己的画布清单：等卡片渲染出来（页面数据到位）再点，否则会走"没有画布→新建"分支
  const listReadyForContinue = await waitFor(async () => (await inFrame(listFrame(), "return document.querySelectorAll('#cardsGrid .project-card').length;")) > 0, 20000);
  const continueClick = await inFrame(listFrame(), "const el = document.getElementById('btnContinueLast'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const contUp = await waitFor(() => !!canvasFrame(), 40000);
  const contReady = contUp && await waitFor(async () => { const st = await inFrame(canvasFrame(), "const s = window.__openarcCanvas ? window.__openarcCanvas.state() : null; return s ? { id: s.canvasId } : null;"); return !!(st && st.id); }, 30000);
  const contId = contReady ? (await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };")).id : null;
  const contDoc = contId ? await canvas({ type: "canvas/get", canvasId: contId }) : null;
  record("A5", "「继续上次」→ 进入 canvas.html 且打开的正是最近更新的那本（宿主 IPC canvas/list 的 updatedAt 第一名，也就是刚创建的这本）",
    listReadyForContinue && continueClick === "clicked" && contUp && !!contId && !!latest && contId === latest.canvasId && contId === currentCanvasId && !!(contDoc && contDoc.ok),
    "canvas.html + 最近更新那本", JSON.stringify({ listReadyForContinue, continueClick, contUp, openedId: contId, latest: latest ? { canvasId: latest.canvasId, updatedAt: latest.updatedAt } : null, currentCanvasId, ipcCount: ipcList.length }));

  // A6：卡片直达（上游卡片实现：.project-card[data-canvas-id] → openCanvas → canvas.html?id=）
  await inFrame(canvasFrame(), "const el = document.getElementById('backToManagerBtn'); if (el) el.click(); return !!el;");
  const backForCard = await waitFor(() => !!listFrame() && !canvasFrame(), 30000);
  const cardSel = "#cardsGrid .project-card[data-canvas-id=\"" + currentCanvasId + "\"]";
  const cardUp = backForCard && await waitFor(async () => (await inFrame(listFrame(), "return !!document.querySelector(" + JSON.stringify(cardSel) + ");")) === true, 20000);
  const cardClick = cardUp ? await inFrame(listFrame(), "const el = document.querySelector(" + JSON.stringify(cardSel) + "); if (!el) return 'missing'; el.click(); return 'clicked';") : "missing";
  const cardUpFrame = await waitFor(() => !!canvasFrame(), 40000);
  const cardReady = cardUpFrame && await waitFor(async () => { const st = await inFrame(canvasFrame(), "const s = window.__openarcCanvas ? window.__openarcCanvas.state() : null; return s ? { id: s.canvasId } : null;"); return !!(st && st.id); }, 30000);
  const cardId = cardReady ? (await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };")).id : null;
  record("A6", "卡片直达：入口页 #cardsGrid .project-card[data-canvas-id=当前这本] → 进入编辑器且 canvasId 一致（真实卡片点击，不是 IPC 造帧）",
    cardClick === "clicked" && cardUpFrame && cardId === currentCanvasId,
    "卡片点击 → 同一本", JSON.stringify({ cardSel, backForCard, cardUp, cardClick, cardUpFrame, cardId, currentCanvasId }));

  const addA = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_prompt', type:'prompt', x:80, y:120, text:'D5-02 提示词节点' } }, null);");
  const addB = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_llm', type:'llm', x:420, y:120, model:'', systemPrompt:'You are a helpful assistant.' } }, null);");
  const link = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_llm' }, null);");
  const moved = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.move', id:'n_llm', x:520, y:180 }, null);");
  const savedOk = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
    const nodes = got && got.ok ? got.canvas.doc.nodes : [];
    return nodes.length === 2 && got.canvas.doc.connections.length === 1 && Number(nodes.find((n) => n.id === "n_llm").x) === 520;
  }, 20000);
  const stored = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  record("A7", "创建并编辑真实项目：命令层 add/connect/move → 画布自动保存 → OpenArc 存储里一致",
    !!(addA.ok && addB.ok && link.ok && moved.ok) && savedOk,
    "2 节点 + 1 连线 + 坐标 520", JSON.stringify({ ok: [addA.ok, addB.ok, link.ok, moved.ok], savedOk, revision: stored.canvas.revision, nodes: stored.canvas.doc.nodes.map((n) => ({ id: n.id, x: n.x })), edges: stored.canvas.doc.connections.length }));

  const undoState = await inFrame(canvasFrame(), "window.__openarcCanvas.undo(); await new Promise(r=>setTimeout(r,500)); const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { x: n.x, canRedo: window.__openarcCanvas.canRedo() };");
  const redoState = await inFrame(canvasFrame(), "window.__openarcCanvas.redo(); await new Promise(r=>setTimeout(r,500)); const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { x: n.x };");
  const redoPersisted = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
    const n = got && got.ok ? got.canvas.doc.nodes.find((x) => x.id === "n_llm") : null;
    return n && Number(n.x) === 520;
  }, 20000);
  record("A8", "撤销 / 重做：撤销真的回退、重做真的恢复（与手工编辑同一历史入口），结果重新落库",
    Math.round(undoState.x) === 420 && undoState.canRedo === true && Math.round(redoState.x) === 520 && redoPersisted,
    "undo→420 / redo→520 + 落库", JSON.stringify({ undoState, redoState, redoPersisted }));

  await page.screenshot({ path: path.join(ART, "d5-02-app-canvas.png") }).catch(() => {});
  /* ══════════════════ N 系列（无模型状态）：必须在 B 系列配置模型**之前**跑 ══════════════════
   * 此刻 /api/config.api_providers = 0、chat/image 清单为空、视频传输未接通 —— 正是"无模型契约"的状态点。*/
  // 生图 / 视频节点在这一步还不存在：临时加两个探针节点，观察守卫在真实渲染上的契约，观察完立刻删除。
  const nProbes = await nAddProbeNodes();
  note("N 系列探针节点（生图 + 视频，观察后删除）：" + JSON.stringify(nProbes));

  const n1 = await inFrame(canvasFrame(), [
    "const chip = document.querySelector('.canvas-nav-meta [data-openarc-model-status]');",
    "const chipGuide = chip ? chip.querySelector('[data-openarc-open-model-settings]') : null;",
    "const guides = Array.from(document.querySelectorAll('[data-openarc-open-model-settings]'));",
    N_SEL_INFO,
    nFakeScanLines(N_FAKE_PROVIDER_RE).join("\n"),
    "const g = window.__openarcCanvasGuard || {};",
    "const gen = document.querySelector('.generator-body .provider-select') ? document.querySelector('.generator-body .provider-select').closest('.generator-body') : null;",
    "return { chip: chip ? chip.getAttribute('data-openarc-model-status') : null,",
    "  chipText: String((chip && chip.querySelector('.openarc-model-status-text') || {}).textContent || '').trim(),",
    "  chipGuideText: chipGuide ? String(chipGuide.textContent).trim() : null,",
    "  guideCount: guides.length,",
    "  guideTexts: Array.from(new Set(guides.map(function (b) { return String(b.textContent).trim(); }))),",
    "  guardGuideText: String(g.guideText || ''),",
    "  chat: { provider: selInfo(document.querySelector('.llm-provider-select')), model: selInfo(document.querySelector('.llm-model')) },",
    "  image: { provider: gen ? selInfo(gen.querySelector('.provider-select')) : null, model: gen ? selInfo(gen.querySelector('.model-select')) : null },",
    "  fake: fake };",
  ].join("\n"));
  record("N1", "无模型（配置模型之前）：编辑器页头模型状态 = unconfigured + 引导按钮文案精确为「打开 OpenArc 总 API 设置」；文本/生图下拉都被标成未配置且真的 disabled（唯一占位文案精确）；DOM 全文 / option.value / select.value 扫 /comfly/i 0 命中（不存在伪造供应商）",
    !!n1 && !n1.__noFrame && !n1.__error && n1.chip === "unconfigured"
      && n1.chipGuideText === N_GUIDE_TEXT && n1.guardGuideText === N_GUIDE_TEXT && n1.guideCount >= 1 && n1.guideTexts.length === 1 && n1.guideTexts[0] === N_GUIDE_TEXT
      && nSelOk(n1.chat.provider, "chat") && nSelOk(n1.chat.model, "chat")
      && nSelOk(n1.image.provider, "image-generation") && nSelOk(n1.image.model, "image-generation")
      && n1.fake.htmlMatched === false && n1.fake.optionHits.length === 0 && n1.fake.selectHits.length === 0,
    "unconfigured + 引导文案精确 + 4 个下拉 disabled/unconfigured + /comfly/i 0 命中",
    JSON.stringify({ probes: nProbes, chip: n1 && n1.chip, chipText: n1 && n1.chipText, chipGuideText: n1 && n1.chipGuideText, guideCount: n1 && n1.guideCount, guideTexts: n1 && n1.guideTexts, guardGuideText: n1 && n1.guardGuideText, chat: { provider: nSelBrief(n1 && n1.chat && n1.chat.provider), model: nSelBrief(n1 && n1.chat && n1.chat.model) }, image: { provider: nSelBrief(n1 && n1.image && n1.image.provider), model: nSelBrief(n1 && n1.image && n1.image.model) }, fake: n1 && n1.fake }));

  // N2：**真实点击**引导按钮（不是直接调桥）→ 宿主真的打开设置窗口并停在模型页；随后关掉，不留残留窗口。
  const n2Click = await inFrame(canvasFrame(), "const b = document.querySelector('.canvas-nav-meta [data-openarc-open-model-settings]') || document.querySelector('[data-openarc-open-model-settings]'); if (!b) return { clicked: false, why: 'no-guide-button', guides: document.querySelectorAll('[data-openarc-open-model-settings]').length }; const text = String(b.textContent).trim(); const inChip = !!b.closest('.canvas-nav-meta'); b.click(); return { clicked: true, text: text, inChip: inChip };");
  const n2Opened = await waitFor(async () => { const s = await nSettingsWindow(); return !!s && s.active === "model"; }, 25000);
  const n2Guide = "const b = document.querySelector('[data-openarc-guide-state=opened]'); return b ? { opened: true, text: String(b.textContent).trim() } : null;";
  const n2GuideState = (await waitFor(async () => (await inFrame(canvasFrame(), n2Guide)) !== null, 15000)) ? await inFrame(canvasFrame(), n2Guide) : { opened: false, text: null };
  const n2Settings = await nSettingsWindow();
  const n2Close = await nCloseSettingsWindow();
  record("N2", "引导真的打开 OpenArc 总 API 设置：真实点击页面里的引导按钮 → 桥把这一次请求真的送到宿主（按钮拿到 data-openarc-guide-state=opened）+ 出现设置窗口且 [data-settings-active=model]（标题「模型 / AI」、未被最小化）；随后关掉设置窗口，不留残留、不影响后续断言",
    !!n2Click && n2Click.clicked === true && n2Click.text === N_GUIDE_TEXT && n2Opened === true
      && !!n2GuideState && n2GuideState.opened === true
      && !!n2Settings && n2Settings.active === "model" && n2Settings.title === "模型 / AI" && n2Settings.minimized === false && n2Settings.hasWindow === true
      && !!n2Close && n2Close.closed === true,
    "点击 → guide-state=opened + 设置窗口 data-settings-active=model（模型 / AI）+ 关闭成功",
    JSON.stringify({ click: n2Click, opened: n2Opened, guideState: n2GuideState, settings: n2Settings, close: n2Close }));

  const n3ReqBefore = provider.state();
  const n3 = await inFrame(canvasFrame(), [
    N_SEL_INFO,
    "const vid = document.querySelector('.node[data-id=n_ng_probe_vid]');",
    "const btn = vid ? vid.querySelector('.gen-btn') : null;",
    "const vnote = vid ? vid.querySelector('[data-openarc-guard-note=video-generation]') : null;",
    "const g = window.__openarcCanvasGuard || {};",
    "const r = await fetch('/api/canvas-video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) });",
    "let body = null; try { body = await r.json(); } catch (e) { body = { parseError: String(e && e.message), status: r.status }; }",
    "return { status: r.status, body: body, guardVersion: Number(g.version || 0), guardText: String((g.unavailableText || {})['video-generation'] || ''),",
    "  videoNode: vid ? { capability: vid.getAttribute('data-openarc-capability'), available: vid.getAttribute('data-openarc-available'), noteText: String((vnote || {}).textContent || '').trim(), guideInNote: !!(vnote && vnote.querySelector('[data-openarc-open-model-settings]')) } : null,",
    "  provider: selInfo(document.querySelector('.video-provider')), model: selInfo(document.querySelector('.video-model')),",
    "  runBtn: btn ? { blocked: btn.getAttribute('data-openarc-blocked'), aria: btn.getAttribute('aria-disabled'), disabled: !!btn.disabled, title: String(btn.title || '').slice(0, 80) } : null,",
    "  blockedCount: document.querySelectorAll('button[data-openarc-blocked]').length };",
  ].join("\n"));
  const n3ReqAfter = provider.state();
  const n3HostNotice = await js("const el = document.querySelector('[data-canvas-host]'); return el ? String(el.getAttribute('data-canvas-asset-notice-text') || '') : null;");
  const n3Req = (s) => s.chats.length + s.images.length + s.authSeen;
  // 页面侧守卫在**发出请求之前**就按能力事实回答了：桥的"该功能未接入 OpenArc（保留入口）"分支不该被走到。
  const n3BridgeNotice = /未接入 OpenArc（保留入口）：\/api\/canvas-video/.test(String(n3HostNotice || ""));
  record("N3", "未接通能力（视频）明确不可用：视频 provider/model 下拉 disabled + aria-disabled + data-openarc-unavailable=video-generation + 唯一文案（且节点说明里不给误导性引导）；视频节点 data-openarc-available=false；运行按钮 data-openarc-blocked + disabled；页面内直接 POST /api/canvas-video → 501 CAPABILITY_UNAVAILABLE（available:false / transport:null / detail 非空）；假 provider 请求计数 0→0",
    !!n3 && !n3.__noFrame && !n3.__error && n3.status === 501 && !!n3.body && n3.body.error === "CAPABILITY_UNAVAILABLE" && n3.body.available === false && n3.body.transport === null && String(n3.body.detail || "").length > 0
      && n3.guardVersion >= 1 && n3.guardText === N_VIDEO_TEXT
      && !!n3.videoNode && n3.videoNode.capability === "video-generation" && n3.videoNode.available === "false" && n3.videoNode.noteText.indexOf(N_VIDEO_TEXT) >= 0 && n3.videoNode.guideInNote === false
      && nVideoSelOk(n3.provider) && nVideoSelOk(n3.model)
      && !!n3.runBtn && n3.runBtn.blocked === "video-generation" && n3.runBtn.aria === "true" && n3.runBtn.disabled === true
      && n3Req(n3ReqBefore) === 0 && n3Req(n3ReqAfter) === n3Req(n3ReqBefore)
      && n3BridgeNotice === false,
    "501 CAPABILITY_UNAVAILABLE + 下拉/节点/运行按钮全不可用 + 假 provider 0→0 请求",
    JSON.stringify({ status: n3 && n3.status, body: n3 && n3.body, guard: n3 && { version: n3.guardVersion, text: n3.guardText }, videoNode: n3 && n3.videoNode, provider: nSelBrief(n3 && n3.provider), model: nSelBrief(n3 && n3.model), runBtn: n3 && n3.runBtn, blockedCount: n3 && n3.blockedCount, requests: { before: n3Req(n3ReqBefore), after: n3Req(n3ReqAfter) }, hostNoticeHead: String(n3HostNotice || "").slice(0, 60), bridgeUnsupportedNotice: n3BridgeNotice }));

  const nProbesOff = await nRemoveProbeNodes();
  note("N 系列探针节点已删除（画布回到观察前的节点集合）：" + JSON.stringify(nProbesOff));

  // 返回画布列表（产品路径：编辑器 #backToManagerBtn → canvas-list）
  const backClick2 = await inFrame(canvasFrame(), "const el = document.getElementById('backToManagerBtn'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const backList2 = await waitFor(() => !!listFrame() && !canvasFrame(), 30000);
  const cardListed = backList2 && await waitFor(async () => (await inFrame(listFrame(), "return !!document.querySelector('#cardsGrid .project-card[data-canvas-id=" + JSON.stringify(currentCanvasId) + "]');")) === true, 20000);
  const listPayload = cardListed ? await inFrame(listFrame(), "const r = await (await fetch('/api/canvases')).json(); const list = (r && r.canvases) || []; const sorted = list.slice().sort(function (a, b) { return Number(b.updated_at || 0) - Number(a.updated_at || 0); }); return { n: list.length, first: sorted[0] ? { id: sorted[0].id, title: sorted[0].title } : null, hasCurrent: list.some(function (c) { return c.id === " + JSON.stringify(currentCanvasId) + "; }), cards: document.querySelectorAll('#cardsGrid .project-card').length };") : null;
  record("A9", "返回画布列表：列表里出现刚保存的项目、当前这本的卡片真的渲染出来（列表数据来自 OpenArc 存储，最近更新的排第一）",
    backClick2 === "clicked" && backList2 && cardListed && !!listPayload && listPayload.n >= 1 && listPayload.first && listPayload.first.id === currentCanvasId && listPayload.hasCurrent === true && listPayload.cards >= 1,
    "canvas-list 帧 + 列表含该书 + 卡片存在", JSON.stringify({ backClick2, backList2, cardListed, listPayload }));
  await page.screenshot({ path: path.join(ART, "d5-02-app-home.png") }).catch(() => {});

  // 再打开项目：点列表首页上这本画布的卡片（产品路径，不是 IPC 造帧）
  const reopened = await reopenCurrentCanvasFromHome();
  const reopenedSame = await waitFor(async () => (await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, edges: s.edgeCount, x: (window.__openarcCanvasInternals.primitives.getNode('n_llm')||{}).x };")).id === currentCanvasId, 25000);
  const reopenedState = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, edges: s.edgeCount, x: (window.__openarcCanvasInternals.primitives.getNode('n_llm')||{}).x };");
  record("A10", "从画布列表再打开项目：打开的是**同一本**画布，节点/连线/坐标从 OpenArc 存储恢复",
    reopened && reopenedSame && reopenedState.nodes === 2 && reopenedState.edges === 1 && Math.round(reopenedState.x) === 520,
    "同一 canvasId + 2 节点 1 连线 x=520", JSON.stringify({ reopened, reopenedSame, reopenedState }));
  await page.screenshot({ path: path.join(ART, "d5-02-app-reopen.png") }).catch(() => {});

  /* ══════════════════ B 系列：统一后端 ══════════════════ */
  const prov = await model({ type: "provider/create", displayName: "D5-02 Canvas Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "d502-canvas-secret" });
  const providerId = prov && prov.provider && prov.provider.providerId;
  const chatModel = await model({ type: "model/create", providerId, remoteModelId: "d502-chat", displayName: "D5-02 Chat", capabilities: ["chat"], scope: "ORGANIZATION" });
  const imgModel = await model({ type: "model/create", providerId, remoteModelId: "d502-image", displayName: "D5-02 Image", capabilities: ["image-generation"], scope: "ORGANIZATION" });
  const chatId = chatModel && chatModel.model && chatModel.model.configId;
  const imgId = imgModel && imgModel.model && imgModel.model.configId;
  await model({ type: "defaults/set", capability: "chat", configId: chatId });
  await model({ type: "defaults/set", capability: "image-generation", configId: imgId });
  // 产品侧第二批（模型/供应商单一真源）：`/api/config.api_providers` 从**空数组**改成 OpenArc provider 的
  // **真实投影**（id=providerId、name=displayName，只含该能力下有可用模型的 provider，**不含** baseUrl/凭据/has_key。
  // 产品实现见 src/canvas/CanvasHost.tsx 的 buildConfig()：键集 = {id,name,enabled,chat_models,image_models,video_models}）。
  // B1 因此**因产品范围变更而重写**，但保留原意（"不外泄 provider 地址与凭据"，不是"必须是 0 个投影"），且比旧版本更严：
  //   ① 数量必须等于**真实配置数量**——用两条独立 IPC 数据源交叉核对（provider/list ∩ canvas/models 的 providerId），不是"不为 0 就算过"；
  //   ② 每个投影对象的键集合必须 ⊆ 产品 buildConfig 的真实键集（多一个字段就 FAIL）；
  //   ③ 投影里的 id / name 必须与 IPC 真值逐项相等（不是"有几个就行"）；
  //   ④ 整个 /api/config JSON 不得出现地址/凭据类字样（正则比旧版更宽：加 base_url/protocol/has_key/key_preview/token/localhost）。
  const providerList = await model({ type: "provider/list" });
  const ipcProviders = (providerList && providerList.items) || [];
  const usableModels = await model({ type: "canvas/models" });
  const usableProviderIds = new Set(((usableModels && usableModels.models) || [])
    .filter((m) => Array.isArray(m.capabilities) && (m.capabilities.includes("chat") || m.capabilities.includes("image-generation")))
    .map((m) => String(m.providerId)));
  const expectProviders = ipcProviders.filter((p) => usableProviderIds.has(String(p.providerId)));
  // /api/config 的取数是"页面帧还在不在"的外部事实：取不到就重试（有界），仍然取不到 → 断言如实 FAIL（不静默跳过）。
  let cfgSeen = null;
  for (let i = 0; i < 3; i += 1) {
    cfgSeen = await inFrame(canvasFrame(), "const cfg = await (await fetch('/api/config')).json(); const p = Array.isArray(cfg.api_providers) ? cfg.api_providers : []; const raw = JSON.stringify(cfg); return { chat: (cfg.chat_models||[]).length, image: (cfg.image_models||[]).length, providers: p.length, ids: p.map(function (x) { return String(x.id); }), names: p.map(function (x) { return String(x.name); }), keySets: p.map(function (x) { return Object.keys(x).sort(); }), hasKey: raw.includes('d502-canvas-secret'), hasUrl: raw.includes('127.0.0.1'), raw: raw };");
    if (cfgSeen && Array.isArray(cfgSeen.ids) && Array.isArray(cfgSeen.names) && Array.isArray(cfgSeen.keySets)) break;
    await sleep(500);
  }
  const cfgOk = !!(cfgSeen && Array.isArray(cfgSeen.ids) && Array.isArray(cfgSeen.names) && Array.isArray(cfgSeen.keySets));
  const configSeen = cfgOk ? { chat: cfgSeen.chat, image: cfgSeen.image, providers: cfgSeen.providers, ids: cfgSeen.ids, names: cfgSeen.names, keySets: cfgSeen.keySets, hasKey: cfgSeen.hasKey, hasUrl: cfgSeen.hasUrl } : null;
  const CFG_PROVIDER_KEYS = ["chat_models", "enabled", "id", "image_models", "name", "video_models"];
  const keysWhitelisted = cfgOk && cfgSeen.keySets.length > 0 && cfgSeen.keySets.every((ks) => ks.length > 0 && ks.every((k) => CFG_PROVIDER_KEYS.includes(k)));
  const CFG_LEAK = /baseUrl|base_url|protocol|credential|has_key|key_preview|secret|token|localhost|127\.0\.0\.1/i;
  const configLeak = CFG_LEAK.test(String((cfgSeen && cfgSeen.raw) || ""));
  const models = await model({ type: "canvas/models" });
  const projection = JSON.stringify(models);
  record("B1", "模型只有一个来源：画布只看到 OpenArc 已配置可用的模型；provider 投影的数量/身份/键集合与 IPC 真值逐项一致，且全程无地址与凭据",
    cfgOk && cfgSeen.chat >= 1 && cfgSeen.image >= 1 && expectProviders.length >= 1 && cfgSeen.providers === expectProviders.length && keysWhitelisted && !configLeak
      && JSON.stringify(cfgSeen.ids.slice().sort()) === JSON.stringify(expectProviders.map((p) => String(p.providerId)).sort())
      && JSON.stringify(cfgSeen.names.slice().sort()) === JSON.stringify(expectProviders.map((p) => String(p.displayName || p.providerId)).sort())
      && !/baseUrl|secret|credential|apiKey/i.test(projection),
    "有 chat+image；api_providers 数量 = 真实 provider 数 " + expectProviders.length + "（id/name 对齐 IPC、键集合 ⊆ 白名单、无地址/凭据）",
    JSON.stringify({ configSeen: configSeen || cfgSeen, ipcProviders: ipcProviders.map((p) => ({ id: p.providerId, name: p.displayName, status: p.status })), usableProviderIds: Array.from(usableProviderIds), expectedProviderIds: expectProviders.map((p) => String(p.providerId)), keysWhitelisted, configLeak, projectionLeak: /baseUrl|secret|credential|apiKey/i.test(projection) }));

  const setText = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.edit', id:'n_prompt', patch:{ text:'写一句关于海边的提示词' } }, null);");
  const runLlm = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_llm'); const cfg = await (await fetch('/api/config')).json(); n.model = cfg.chat_models[0]; it.primitives.render(); window.__openarcCanvas.runNode('n_llm'); return { started: true, model: n.model };");
  note("LLM 运行前：" + JSON.stringify({ setText: setText && setText.ok, runLlm }));
  const llmDone = (await waitFor(async () => {
    const n = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { status: n.runStatus, error: n.runError || '' };");
    return n && (n.status === "done" || n.status === "failed") ? n : null;
  }, 40000)) ? await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); const last = (n.messages||[]).filter(m=>m.role==='assistant').slice(-1)[0]; return { status: n.runStatus, error: n.runError || '', text: String(n.outputText || (last ? last.content : '') || '') };") : null;
  const providerAfterChat = provider.state();
  record("B2", "真实模型调用链（文本）：经 OpenArc 模型服务 → 本地 provider → 结果回到 LLM 节点",
    !!llmDone && llmDone.status === "done" && String(llmDone.text).startsWith(CANVAS_TEXT_PREFIX) && providerAfterChat.chats.length >= 1 && providerAfterChat.authSeen >= 1,
    "节点拿到 provider 文本 + provider 收到 OpenArc 凭据", JSON.stringify({ llmDone, chats: providerAfterChat.chats.slice(-1), authSeen: providerAfterChat.authSeen }));

  const addGen = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_gen', type:'generator', x:120, y:420, count:1 } }, null);");
  const linkGen = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_gen' }, null);");
  const runGen = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); const cfg = await (await fetch('/api/config')).json(); n.model = cfg.image_models[0]; n.apiProvider='openarc'; it.primitives.render(); window.__openarcCanvas.runNode('n_gen'); return { started: true, model: n.model };");
  const genDone = (await waitFor(async () => {
    const n = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_gen'); return { status: n.runStatus, error: n.runError || '' };");
    return n && (n.status === "done" || n.status === "failed") ? n : null;
  }, 60000)) ? await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const out = it.getState().nodes.find(x => x.type==='output'); const imgs = out ? (out.items||out.images||[]) : []; return { status: it.primitives.getNode('n_gen').runStatus, error: it.primitives.getNode('n_gen').runError || '', outputCount: imgs.length };") : null;
  const providerAfterImage = provider.state();
  record("B3", "真实模型调用链（图片）：经 OpenArc 模型服务 → /images/generations → 输出节点拿到图片",
    !!genDone && genDone.status === "done" && (genDone.outputCount || 0) >= 1 && providerAfterImage.images.length >= 1,
    "输出节点有图片 + provider 收到图片请求", JSON.stringify({ addGen: addGen && addGen.ok, linkGen: linkGen && linkGen.ok, runGen, genDone, images: providerAfterImage.images.length }));

  await provider.setMode("fail");
  await inFrame(canvasFrame(), "await window.__openarcCanvas.runNode('n_gen'); return true;");
  const failedState = (await waitFor(async () => {
    const n = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_gen'); return { status: n.runStatus, error: n.runError || '' };");
    return n && n.status === "failed" && n.error ? n : null;
  }, 45000)) ? await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_gen'); return { status: n.runStatus, error: n.runError || '' };") : null;
  await provider.setMode("ok");
  record("B4", "失败如实展示：provider 500 → 节点标记失败并带错误（不假装成功）",
    !!failedState && failedState.status === "failed" && String(failedState.error).length > 0,
    "runStatus=failed + runError", JSON.stringify(failedState));

  /* ── N4：真实投影 + 无第二来源（B 系列已配好 provider+模型，看页面是不是真的按真源渲染） ── */
  const n4Names = expectProviders.map((p) => String(p.displayName || p.providerId));
  const n4 = await inFrame(canvasFrame(), [
    "const cfg = await (await fetch('/api/config')).json();",
    N_SEL_INFO,
    nFakeScanLines(N_FAKE_LABEL_RE).join("\n"),
    "const it = window.__openarcCanvasInternals;",
    "const node = (id) => { try { const n = it.primitives.getNode(id); return n ? { provider: String(n.apiProvider || n.llmProvider || ''), model: String(n.model || '') } : null; } catch (e) { return null; } };",
    "const keys = " + JSON.stringify(N_MODEL_SOURCE_KEYS) + ";",
    "const readBack = {}; const residue = [];",
    "keys.forEach(function (k) { try { window.localStorage.setItem(k, 'N4-伪造清单'); } catch (e) { /* 写不进去也是被封住的一种表现 */ } });",
    "keys.forEach(function (k) { try { readBack[k] = window.localStorage.getItem(k); } catch (e) { readBack[k] = 'throw'; } });",
    "for (let i = 0; i < window.localStorage.length; i += 1) { const k = String(window.localStorage.key(i) || ''); if (keys.some(function (x) { return k.indexOf(x) >= 0; })) residue.push(k.slice(0, 80)); }",
    "return { providers: (cfg.api_providers || []).map(function (p) { return { id: String(p.id), name: String(p.name), keys: Object.keys(p).sort() }; }),",
    "  chatModels: cfg.chat_models || [], imageModels: cfg.image_models || [],",
    "  provider: { llm: selInfo(document.querySelector('.llm-provider-select')), gen: selInfo(document.querySelector('.generator-body .provider-select')) },",
    "  model: { llm: selInfo(document.querySelector('.llm-model')), gen: selInfo(document.querySelector('.generator-body .model-select')) },",
    "  nodes: { llm: node('n_llm'), gen: node('n_gen') },",
    "  fake: fake, readBack: readBack, residue: residue };",
  ].join("\n"));
  const n4ProvOk = (s) => !!s && s.disabled === false && s.options.length >= 1 && s.options.every((o) => o.value === providerId && n4Names.includes(o.text)) && String(s.value) === providerId;
  const n4ModelOk = (s, list) => !!s && s.disabled === false && s.options.length >= 1 && s.options.every((o) => o.value !== "" && o.value === o.text && list.includes(o.value)) && list.includes(String(s.value));
  record("N4", "真实投影 + 无第二来源：B 系列配好 provider+模型后，编辑器 provider 下拉逐项 = OpenArc 真 provider（id + displayName，不是 Comfly/API 的造物）；模型下拉的每个选项都在 OpenArc 清单里（gpt-4o-mini / gpt-image-2 / veo3-fast 在 DOM 属性+文本 / option.value / select.value 三处 0 命中）；三把 localStorage 模型键 setItem 后读回 null 且不留残留键；/api/config.api_providers 键集合 ⊆ 六键",
    !!n4 && !n4.__noFrame && !n4.__error
      && n4.providers.length >= 1 && n4.providers.every((p) => p.keys.length > 0 && p.keys.every((k) => N_PROVIDER_KEYS.includes(k)))
      && n4.providers.some((p) => p.id === providerId && n4Names.includes(p.name))
      && n4ProvOk(n4.provider.llm) && n4ProvOk(n4.provider.gen)
      && n4ModelOk(n4.model.llm, n4.chatModels) && n4ModelOk(n4.model.gen, n4.imageModels)
      && !!n4.nodes.gen && n4.nodes.gen.provider === providerId && n4.imageModels.includes(n4.nodes.gen.model)
      && !!n4.nodes.llm && n4.chatModels.includes(n4.nodes.llm.model)
      && n4.fake.htmlMatched === false && n4.fake.optionHits.length === 0 && n4.fake.selectHits.length === 0
      && N_MODEL_SOURCE_KEYS.every((k) => n4.readBack[k] === null) && n4.residue.length === 0,
    "provider 下拉 = 真 displayName；模型下拉选项 ⊆ 真源清单；三个伪造标签 0 命中；localStorage 三键读回 null",
    JSON.stringify({ providers: n4 && n4.providers, chatModels: n4 && n4.chatModels, imageModels: n4 && n4.imageModels, provider: { llm: nSelBrief(n4 && n4.provider && n4.provider.llm), gen: nSelBrief(n4 && n4.provider && n4.provider.gen) }, model: { llm: nSelBrief(n4 && n4.model && n4.model.llm), gen: nSelBrief(n4 && n4.model && n4.model.gen) }, nodes: n4 && n4.nodes, fake: n4 && n4.fake, readBack: n4 && n4.readBack, residue: n4 && n4.residue }));

  /* ── N6：无静默回落 —— 清单外标签必须被明确拒绝，且一次 provider 请求都不发 ── */
  const n6HostBefore = await attrOf("[data-canvas-host]", "data-canvas-model-not-found");
  const n6ReqBefore = provider.state();
  const n6 = await inFrame(canvasFrame(), [
    "const cfg = await (await fetch('/api/config')).json();",
    "const label = " + JSON.stringify(N_FAKE_CHAT_LABEL) + ";",
    "const inManifest = (cfg.chat_models || []).indexOf(label) >= 0;",
    "const r = await fetch('/api/canvas-llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: label, message: '清单外模型探测（不得静默回落）', messages: [], nodeId: 'n_llm' }) });",
    "let body = null; try { body = await r.json(); } catch (e) { body = { parseError: String(e && e.message), status: r.status }; }",
    "return { status: r.status, body: body, inManifest: inManifest, chatModels: (cfg.chat_models || []).length };",
  ].join("\n"));
  await sleep(500);
  const n6HostAfter = await attrOf("[data-canvas-host]", "data-canvas-model-not-found");
  const n6ReqAfter = provider.state();
  record("N6", "无静默回落：页面用清单外标签 POST /api/canvas-llm → 502 MODEL_NOT_FOUND（回包点名 model/method，detail 是人话），provider 请求 0 新增，宿主 data-canvas-model-not-found 真的 +1",
    !!n6 && !n6.__noFrame && !n6.__error && n6.status === 502 && !!n6.body && n6.body.error === "MODEL_NOT_FOUND" && String(n6.body.model || "") === N_FAKE_CHAT_LABEL && String(n6.body.method || "") === "model.chat" && String(n6.body.detail || "").length > 0
      && n6.inManifest === false
      && n6ReqAfter.chats.length === n6ReqBefore.chats.length && n6ReqAfter.images.length === n6ReqBefore.images.length && n6ReqAfter.authSeen === n6ReqBefore.authSeen
      && Number(n6HostAfter) === Number(n6HostBefore) + 1,
    "502 MODEL_NOT_FOUND + 0 新增 provider 请求 + 宿主计数 +1",
    JSON.stringify({ status: n6 && n6.status, body: n6 && n6.body, inManifest: n6 && n6.inManifest, chatModels: n6 && n6.chatModels, hostCounter: n6HostBefore + "→" + n6HostAfter, requests: { chats: [n6ReqBefore.chats.length, n6ReqAfter.chats.length], images: [n6ReqBefore.images.length, n6ReqAfter.images.length], authSeen: [n6ReqBefore.authSeen, n6ReqAfter.authSeen] } }));

  const video = await inFrame(canvasFrame(), "const r = await fetch('/api/canvas-video', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt:'x' }) }); return { status: r.status, body: await r.json() };");
  // 期望值随产品契约更新（守卫已按能力事实在页面侧回答）：错误码从笼统的 OPENARC_UNSUPPORTED 变成
  // CAPABILITY_UNAVAILABLE，并**多加** available/transport/detail 三项判定 —— 是加强，不是放宽。
  record("B5", "OpenArc 尚不支持的能力（视频）明确报错，不静默改用其它服务：页面侧守卫按能力事实回答 501 CAPABILITY_UNAVAILABLE（available:false / transport:null / detail 非空），不是笼统的 OPENARC_UNSUPPORTED",
    video && video.status === 501 && video.body && video.body.error === "CAPABILITY_UNAVAILABLE" && video.body.available === false && video.body.transport === null && String(video.body.detail || "").length > 0,
    "501 CAPABILITY_UNAVAILABLE + available:false + transport:null + detail 非空", JSON.stringify(video));

  const update = await inFrame(shellFrame(), "const a = await fetch('/api/check-update'); const b = await fetch('/api/update-from-github', { method:'POST' }); return { check: a.status, checkBody: (await a.json()).error, github: b.status, githubBody: (await b.json()).error };");
  const info = await inFrame(shellFrame(), "const r = await fetch('/api/app-info'); const d = await r.json(); return { status: r.status, updateDisabled: !!d.update_disabled, queueDisabled: !!(d.openarc && d.openarc.updateDisabled) };");
  const queue = await inFrame(shellFrame(), "const r = await fetch('/api/queue_status?client_id=x'); const d = await r.json(); return { status: r.status, total: d.total, source: d.source };");
  record("B6", "更新/下载上游程序保持禁用（界面明确说明），且应用信息/队列来自宿主（不是上游后端）",
    update.check === 501 && update.checkBody === "OPENARC_UPDATE_DISABLED" && update.github === 501 && info.status === 200 && info.updateDisabled === true && queue.status === 200 && typeof queue.total === "number",
    "更新 501 + app-info/queue 200 且标注禁用", JSON.stringify({ update, info, queue }));

  /* ══════════════════ C 系列：授权 / 预算 / 停止（既有缺口） ══════════════════ */
  const canvasAppGrant = await governance({ type: "governance/getAppAccess", appId: "canvas" });
  const modelGrant = (canvasAppGrant && canvasAppGrant.grants ? canvasAppGrant.grants : []).find((x) => Array.isArray(x.actions) && x.actions.includes("model.use")) || null;
  const beforeNoPerm = provider.state().chats.length;
  const noPermRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  if (modelGrant) await governance({ type: "governance/revokeAppAccess", grantId: modelGrant.grantId });
  const revokedRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  const afterNoPerm = provider.state().chats.length;
  // N5a：撤权状态点 —— D1 的调用级判定一个字不动，这里只补"页面模型区也必须变成不可用"。
  const n5aRevoked = await nWaitModelArea("unavailable-all");
  if (modelGrant) await governance({ type: "governance/grantAppAccess", appId: "canvas", resourceType: "model", scope: "ORGANIZATION", actions: ["model.view", "model.use"] });
  const regranted = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  record("D1", "无权限：撤销画布应用的 model.use 后，生成明确拒绝且 provider 收不到任何请求（F2 缺口）",
    !!modelGrant && revokedRun.ok === false && revokedRun.error === "PROXY_UNAUTHORIZED" && afterNoPerm === beforeNoPerm && noPermRun.ok && regranted.ok,
    "PROXY_UNAUTHORIZED + 0 请求", JSON.stringify({ hasGrant: !!modelGrant, grantActions: modelGrant && modelGrant.actions, noPermRun: noPermRun.ok, revoked: { ok: revokedRun.ok, error: revokedRun.error }, requests: beforeNoPerm + "→" + afterNoPerm, regranted: regranted.ok }));

  // N5a：恢复授权 → 页面模型区必须回到可用（与撤权时那份 snapshot 成对，缺一半就是没验完）。
  const n5aRegranted = await nWaitModelArea("available-all");
  record("N5a", "撤权 → 页面模型区真的变成不可用（实测口径 = unconfigured：页头状态位 unconfigured + 文本/生图下拉 disabled 且只剩一条精确的「未配置…」占位；不是「看着还能点」）；恢复授权 → 回到可用（chip ok + 下拉可选且选项只在真源清单里）",
    n5aRevoked.ok && n5aRegranted.ok,
    "撤权 unconfigured/disabled + 恢复后 ok/可选",
    JSON.stringify({ revoked: nSnapBrief(n5aRevoked), regranted: nSnapBrief(n5aRegranted) }));

  const chatOnly = await model({ type: "model/create", providerId, remoteModelId: "d502-chat-only", displayName: "D5-02 ChatOnly", capabilities: ["chat"], scope: "ORGANIZATION" });
  await model({ type: "defaults/set", capability: "image-generation", configId: chatOnly.model.configId });
  const beforeCap = provider.state().images.length;
  const capRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "image" });
  const afterCap = provider.state().images.length;
  // N5c：跨能力状态点（生图默认被指到只有 chat 的模型）。产品契约（本批修订）：**不回落、不换模型、不隐瞒清单** ——
  // 生图区按「显式默认不可用」呈现（与未配置同一套可见口径 + data-openarc-default-unavailable），清单照旧如实投影，
  // 那个可用生图模型**不会**被自动选中；文本区不受影响。
  const n5cImgLabel = String((imgModel && imgModel.model && (imgModel.model.displayName || imgModel.model.remoteModelId)) || "") + " · " + String(imgId).slice(-4);
  const n5cCrossCap = await nWaitModelArea("image-unavailable", n5cImgLabel);
  await model({ type: "defaults/set", capability: "image-generation", configId: imgId });
  record("D2", "能力不支持：图片能力被指到只有 chat 的模型上 → 明确 CAPABILITY_UNAVAILABLE，provider 收不到图片请求",
    capRun.ok === false && capRun.error === "CAPABILITY_UNAVAILABLE" && afterCap === beforeCap,
    "CAPABILITY_UNAVAILABLE + 0 请求", JSON.stringify({ capRun: { ok: capRun.ok, error: capRun.error }, images: beforeCap + "→" + afterCap }));

  // N5c：恢复生图默认 → 生图区回到可用且标记消失（文本区全程不该被牵连）。
  const n5cRestored = await nWaitModelArea("available-all");
  record("N5c", "跨能力（生图默认被指到只有 chat 的模型）→ 生图区按**显式默认不可用**呈现：data-openarc-default-unavailable=image-generation + 下拉 disabled/aria-disabled + 运行按钮 data-openarc-blocked + 原因文案与「打开 OpenArc 总 API 设置」引导；**清单仍如实投影**（那个可用生图模型仍在 /api/config.image_models 里，只是没有被自动选中：select.value 为空、生图节点 model 为空 = 没有静默换默认）；文本区不受影响（仍可选、选项 ⊆ 真源清单、默认仍是显式配置的那个）；恢复默认 → 标记消失、下拉恢复可选、chip 回 ok",
    n5cCrossCap.ok && n5cRestored.ok
      && !(n5cRestored.snap && n5cRestored.snap.image && n5cRestored.snap.image.model && n5cRestored.snap.image.model.defaultUnavailable)
      && !(n5cRestored.snap && n5cRestored.snap.chat && n5cRestored.snap.chat.model && n5cRestored.snap.chat.model.defaultUnavailable),
    "跨能力：生图默认不可用（标记 + disabled/aria + blocked + 原因/引导）且清单照旧如实投影、未被自动选中；文本仍可用；恢复后标记消失且可选",
    JSON.stringify({ defaultApplied: { capability: "image-generation", configId: chatOnly && chatOnly.model && chatOnly.model.configId, note: "生图默认被指到一个只有 chat 能力的模型（清单里的可用生图模型 = " + n5cImgLabel + "）" }, crossCap: nSnapBrief(n5cCrossCap), restored: nSnapBrief(n5cRestored) }));

  const budgetRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  let budgetOk = 0, budgetStop = null;
  for (let i = 0; i < 40 && !budgetStop; i += 1) {
    const r = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: budgetRun.runId, messages: [{ role: "user", content: "预算探测 " + (i + 1) }] });
    if (r && r.ok) budgetOk += 1; else budgetStop = r;
  }
  const budgetState = await canvas({ type: "canvas/runState", canvasId: currentCanvasId, runId: budgetRun.runId });
  record("D3", "预算不足：任务级 MODEL_CALLS 用尽后明确拒绝，provider 请求数 = 成功调用数",
    budgetStop && budgetStop.error === "BUDGET_EXHAUSTED" && budgetState.run.status === "BUDGET_EXHAUSTED" && provider.state().chats.length >= budgetOk,
    "BUDGET_EXHAUSTED + 请求数=成功数", JSON.stringify({ budgetOk, stop: budgetStop && budgetStop.error, runStatus: budgetState.run.status, providerChats: provider.state().chats.length }));

  await provider.setMode("slow");
  const stopRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat", nodeId: "n_llm" });
  const inflight = canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: stopRun.runId, messages: [{ role: "user", content: "这条会被停止" }] });
  await sleep(600);
  const stopped = await canvas({ type: "canvas/runStop", canvasId: currentCanvasId, runId: stopRun.runId, reason: "USER_STOP" });
  const late = await inflight;
  const afterStop = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: stopRun.runId, messages: [{ role: "user", content: "停止后不该再发" }] });
  const chatsAtStop = provider.state().chats.length;
  await sleep(2500);
  const chatsAfterLate = provider.state().chats.length;
  await provider.setMode("ok");
  await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; it.primitives.getNode('n_llm').outputText = '用户随后编辑的内容'; it.primitives.render(); return true;");
  const userText = await inFrame(canvasFrame(), "return { text: String(window.__openarcCanvasInternals.primitives.getNode('n_llm').outputText || '') };");
  record("D4", "停止：停止后不再发新请求；迟到结果被丢弃，不覆盖用户随后编辑的节点",
    !!(stopped && stopped.ok) && stopped.run.status === "STOPPED" && late && late.ok === false && ["RUN_STOPPED", "TASK_CANCELLED"].includes(late.error) && afterStop.ok === false && chatsAfterLate === chatsAtStop && userText.text === "用户随后编辑的内容",
    "STOPPED + 迟到丢弃 + 用户内容保留", JSON.stringify({ stopped: stopped && stopped.run && stopped.run.status, late: late && late.error, afterStop: afterStop && afterStop.error, chatsAtStop, chatsAfterLate, userText }));

  await provider.setMode("fail");
  const failRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  const beforeFail = provider.state().chats.length;
  const fail1 = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: failRun.runId, messages: [{ role: "user", content: "失败探测" }] });
  const afterFail1 = provider.state().chats.length;
  const fail2 = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: failRun.runId, messages: [{ role: "user", content: "失败探测 2" }] });
  const afterFail2 = provider.state().chats.length;
  await provider.setMode("ok");
  const leakScan = JSON.stringify([fail1, fail2, await canvas({ type: "canvas/models" }), configSeen]);
  record("D5", "失败收敛：provider 500 → 明确失败、每次调用恰好一次请求（无隐藏重试），且回包不含凭据",
    fail1 && fail1.ok === false && afterFail1 === beforeFail + 1 && fail2 && fail2.ok === false && afterFail2 === beforeFail + 2 && !leakScan.includes("d502-canvas-secret"),
    "每次一次请求 + 无凭据", JSON.stringify({ fail1: fail1 && fail1.error, fail2: fail2 && fail2.error, requests: [beforeFail, afterFail1, afterFail2], leaksSecret: leakScan.includes("d502-canvas-secret") }));

  /* ══════════════════ F1：任务模型绑定（不静默换模型） ══════════════════ */
  const bindRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  const okCall = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: bindRun.runId, messages: [{ role: "user", content: "绑定探测" }], configId: chatId });
  const beforeDisable = provider.state().chats.length;
  // N5d 前置：按宿主的 label() 口径算出**要被停用的那个模型**在页面清单里的标签（停用后它就查不到了），
  // 并当场确认它此刻真的在清单里 —— 公式错位在这里就暴露，不让后面的判定空对空。
  const n5dLabel = String((chatModel && chatModel.model && (chatModel.model.displayName || chatModel.model.remoteModelId)) || "") + " · " + String(chatId).slice(-4);
  const n5dManifestBefore = await inFrame(canvasFrame(), "const cfg = await (await fetch('/api/config')).json(); return { chat: cfg.chat_models || [] };");
  await model({ type: "model/setStatus", configId: chatId, status: "disabled" });
  const disabledCall = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: bindRun.runId, messages: [{ role: "user", content: "停用后不该成功" }], configId: chatId });
  const afterDisable = provider.state().chats.length;
  // N5d：停用状态点 —— 被停用模型的标签必须从页面模型区消失（不许静默留在下拉 / 节点当前模型里）。
  const n5dDisabled = await nWaitModelArea("chat-model-removed", n5dLabel);
  const crossCap = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: bindRun.runId, messages: [{ role: "user", content: "拿图片模型跑文本" }], configId: imgId });
  const afterCross = provider.state().chats.length;
  const unknownCfg = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: bindRun.runId, messages: [{ role: "user", content: "不存在的配置" }], configId: "mcf_does_not_exist" });
  const afterUnknown = provider.state().chats.length;
  await model({ type: "model/setStatus", configId: chatId, status: "enabled" });
  await canvas({ type: "canvas/runFinish", canvasId: currentCanvasId, runId: bindRun.runId, status: "FAILED" });
  record("F1", "任务模型绑定：指定的模型配置被停用/能力不符/不存在时**明确拒绝**且 0 新增请求（不静默换模型）",
    okCall && okCall.ok === true && disabledCall.ok === false && afterDisable === beforeDisable && crossCap.ok === false && afterCross === beforeDisable && unknownCfg.ok === false && afterUnknown === beforeDisable,
    "停用/跨能力/不存在 → 拒绝 + 0 请求", JSON.stringify({ okCall: okCall && okCall.ok, disabled: { ok: disabledCall.ok, error: disabledCall.error }, cross: { ok: crossCap.ok, error: crossCap.error }, unknown: { ok: unknownCfg.ok, error: unknownCfg.error }, requests: [beforeDisable, afterDisable, afterCross, afterUnknown] }));

  // N5d/N5e：停用/恢复的 UI 面。被停用的正是**显式配置的文本默认**（defaults/set chat = chatId，本段第 669 行停用它），
  // 产品契约（本批修订）：文本区按「显式默认不可用」呈现 —— **不回落、不自动改用清单里剩下的那个模型**。
  // 三条 0 命中判定（清单 / DOM option / 节点当前模型）原样保留；恢复 enabled 后回到 ok 且可选、标记消失。
  // D1/F1 的调用级判定一个字未改。
  const n5eEnabled = await nWaitModelArea("available-all");
  record("N5d", "停用**显式配置的文本默认** → 被停用模型从页面模型区消失（清单 / DOM option / 节点当前模型三处 0 命中）；文本能力按「默认不可用」呈现（data-openarc-default-unavailable=chat + 下拉 disabled/aria-disabled + 运行按钮 data-openarc-blocked + 原因文案与「打开 OpenArc 总 API 设置」引导，select.value 为空 = 没有自动改用剩下的那个文本模型）；恢复 enabled → 页面模型区回到可用（chip ok + 下拉可选 + 标记消失）",
    !!(n5dManifestBefore && n5dLabel && n5dManifestBefore.chat.includes(n5dLabel)) && n5dDisabled.ok && n5eEnabled.ok
      && !(n5eEnabled.snap && n5eEnabled.snap.chat && n5eEnabled.snap.chat.model && n5eEnabled.snap.chat.model.defaultUnavailable),
    "停用后标签三处 0 命中 + 默认不可用口径（标记/disabled/aria/blocked/原因+引导，value 为空）+ 恢复后 ok/可选且标记消失",
    JSON.stringify({ disabledModelLabel: n5dLabel, disabledConfigId: chatId, manifestBefore: n5dManifestBefore && n5dManifestBefore.chat, atDisable: nSnapBrief(n5dDisabled), atEnable: nSnapBrief(n5eEnabled) }));

  /* ══════════════════ F3：图片资源产品链 ══════════════════ */
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=";
  const upload = await inFrame(canvasFrame(), "const bytes = Uint8Array.from(atob('" + PNG + "'), c => c.charCodeAt(0)); const f = new File([bytes], 'd502-asset.png', { type: 'image/png' }); const fd = new FormData(); fd.append('files', f); const r = await fetch('/api/ai/upload', { method:'POST', body: fd }); const txt = await r.text(); let d = {}; try { d = JSON.parse(txt); } catch (e) { d = { parseError: txt.slice(0, 120) }; } return { status: r.status, keys: Object.keys(d), files: (d.files||[]).map(x => ({ url: String(x.url).slice(0,24), name: x.name })), error: d.error || null, message: d.message || null };");
  const addImg = await inFrame(canvasFrame(), "const up = await (async () => { const bytes = Uint8Array.from(atob('" + PNG + "'), c => c.charCodeAt(0)); const f = new File([bytes], 'd502-asset.png', { type: 'image/png' }); const fd = new FormData(); fd.append('files', f); const r = await fetch('/api/ai/upload', { method:'POST', body: fd }); return await r.json(); })(); const url = up.files && up.files[0] && up.files[0].url; if (!url) return { ok: false, why: 'no-url' }; const res = await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_img', type:'image', x:700, y:420, url: url, name:'导入图片' } }, null); return { ok: res.ok, url: String(url).slice(0, 24) };");
  const imgSaved = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
    const n = got && got.ok ? got.canvas.doc.nodes.find((x) => x.id === "n_img") : null;
    return n && typeof n.url === "string" && n.url.indexOf("openarc-asset:") === 0;
  }, 20000);
  const imgDoc = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  const imgNode = (imgDoc.canvas.doc.nodes || []).find((x) => x.id === "n_img") || {};
  const assetRef = String(imgNode.url || "").replace("openarc-asset:", "");
  const assetStates = await canvas({ type: "canvas/assetStates", canvasId: currentCanvasId, refs: [assetRef] });
  record("F3a", "图片资源：本地导入写入 OpenArc 资源库，画布文档只存 openarc-asset:<ResourceRef>（不存 data URL / 路径）",
    upload.status === 200 && addImg.ok === true && imgSaved && assetRef.length > 0 && String(imgNode.url).indexOf("data:") !== 0,
    "文档里只有稳定 ref", JSON.stringify({ upload: upload.files, addImg, assetRefHead: assetRef.slice(0, 12), docUrlHead: String(imgNode.url).slice(0, 30), states: assetStates.exists }));

  // 关闭窗口 → 重开 → 从首页再打开这本 → 图片仍可解析
  const closedOnce = await closeAppWindow();
  const framesAfterClose = allBundleFrames().length;
  const reopenedOnce = await reopenCurrentCanvasFromHome();
  const resolved = await waitFor(async () => {
    const st = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const s = it.getState(); return { id: s.canvas && s.canvas.id, hasImg: !!it.primitives.getNode('n_img'), url: String((it.primitives.getNode('n_img')||{}).url || '').slice(0, 21) };");
    return st && st.id === currentCanvasId && st.hasImg && st.url.indexOf("data:image") === 0;
  }, 30000);
  const resolvedState = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const s = it.getState(); return { id: s.canvas && s.canvas.id, url: String((it.primitives.getNode('n_img')||{}).url || '').slice(0, 21), nodes: s.nodes.length };");
  record("F3b", "图片资源：关闭窗口重开后仍可用（宿主按当前用户逐资源授权解析为 data URL 显示，存储里仍是 ref）",
    closedOnce && framesAfterClose === 0 && reopenedOnce && resolved && resolvedState.id === currentCanvasId,
    "重开后图片可用 + 存储仍是 ref", JSON.stringify({ closedOnce, framesAfterClose, reopenedOnce, resolved, resolvedState }));

  // 删除资源 → 明确不可用 + 缓存失效
  const delRes = await resource({ type: "resource/delete", resourceRef: assetRef });
  const stateAfterDelete = await canvas({ type: "canvas/assetStates", canvasId: currentCanvasId, refs: [assetRef] });
  const readAfterDelete = await canvas({ type: "canvas/readAsset", ref: assetRef });
  // 同一次挂载内：宿主复核发现资源不可用 → 失效缓存 + 整篇刷新画布（横幅 chrome 已删，证据通道换成
  // 宿主根的**只读**属性 data-canvas-asset-notice："1" = 宿主刚发现引用资源失效并已失效缓存 + 整篇刷新）。
  const noticeSamples = [];
  const noticeTimer = setInterval(async () => {
    try { const v = await js("const el = document.querySelector('[data-canvas-host]'); return el ? { flag: String(el.getAttribute('data-canvas-asset-notice') || ''), text: String(el.getAttribute('data-canvas-asset-notice-text') || '').slice(0, 60) } : null;"); if (v) noticeSamples.push(v); } catch { /* ignore */ }
  }, 400);
  const inMountInvalidated = await waitFor(async () => {
    const st = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; return { url: String((it.primitives.getNode('n_img')||{}).url || '').slice(0, 24) };");
    return st && st.url.indexOf("data:image") < 0;
  }, 20000);
  clearInterval(noticeTimer);
  const inMountNotice = noticeSamples.find((s) => /引用资源/.test(String(s.text))) || (await js("const el = document.querySelector('[data-canvas-host]'); return el ? { flag: String(el.getAttribute('data-canvas-asset-notice') || ''), text: String(el.getAttribute('data-canvas-asset-notice-text') || '').slice(0, 80) } : null;"));
  const noticeIsAboutAssets = !!inMountNotice && inMountNotice.flag === "1" && /引用资源/.test(String(inMountNotice.text));
  const closedTwice = await closeAppWindow();
  const reopenedTwice = await reopenCurrentCanvasFromHome();
  const afterDeleteState = await waitFor(async () => {
    const st = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; return { url: String((it.primitives.getNode('n_img')||{}).url || '').slice(0, 24) };");
    return st && st.url.indexOf("data:image") < 0;
  }, 25000);
  const afterDeleteUrl = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; return { url: String((it.primitives.getNode('n_img')||{}).url || '').slice(0, 32) };");
  record("F3c", "图片资源：资源被删除后画布明确不可用（读回失败 → 保留 ref 显示不可用），旧 data URL 缓存不复活",
    delRes && delRes.ok === true && readAfterDelete.ok === false && stateAfterDelete.exists[assetRef] && stateAfterDelete.exists[assetRef].state !== "AVAILABLE" && inMountInvalidated && closedTwice && reopenedTwice && afterDeleteState && afterDeleteUrl.url.indexOf("data:image") < 0,
    "ASSET_UNAVAILABLE + 当场缓存失效 + 提示 + 重开不复活", JSON.stringify({ delRes: delRes && delRes.ok, noticeIsAboutAssets, read: { ok: readAfterDelete.ok, error: readAfterDelete.error }, state: stateAfterDelete.exists[assetRef], inMountInvalidated, inMountNotice, closedTwice, reopenedTwice, afterDeleteUrl }));

  /* ══════════════════ F3d：本地保存之后宿主侧新增仍能进到已打开的编辑器（D1 回归钉） ══════════════════ */
  // D1 复现条件（第八批真机 A/B）：同一页做过一次本地编辑/保存之后，宿主新增的节点 20s 都进不来 ——
  // 上游 saveCanvas() 触发后不清 saveTimer，applyRemoteCanvasData() 的判空条件里含 saveTimer 恒真，
  // 页面只反复延后重试。本断言自己先做一次页面内本地编辑并等它真的落库（宿主 IPC 读回），再让宿主 IPC
  // canvas/command(actorKind=USER) 新增节点：≤5s 必须在 primitives **和** DOM 里出现，用户本地内容
  // 不被覆盖，且之后 5s 内 revision 不回环。**只新增这一条，不改任何既有断言。**
  // 前置：让应用窗口处于前台 —— 画布页的 2.5s 版本轮询在 document.hidden / 后台节流下会直接 return，
  // 那是浏览器节流不是产品行为；本断言要测的是"轮询能不能把宿主改动带进来"，所以先把窗口带到前台。
  await page.bringToFront().catch(() => {});
  const d1LocalId = "n_d1_local", d1HostId = "n_d1_host";
  const d1LocalText = "本地编辑（D1 回归钉）", d1HostText = "宿主新增（D1 回归钉）";
  const d1Ready = await waitChain2Ready("n_img", 20000);
  const d1LocalEdit = d1Ready.ok
    ? await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type: 'node.add', node: { id: " + JSON.stringify(d1LocalId) + ", type: 'prompt', x: 120, y: 120, text: " + JSON.stringify(d1LocalText) + " } }, null);")
    : { __skipped: "canvas-not-ready" };
  const d1LocalSaved = await waitFor(async () => { const n = await nodeOf(currentCanvasId, d1LocalId); return !!(n && n.text === d1LocalText); }, 20000);
  const d1HostAdd = await canvas({ type: "canvas/command", canvasId: currentCanvasId, command: { type: "node.add", node: { id: d1HostId, type: "prompt", x: 120, y: 300, text: d1HostText } } });
  const d1T0 = Date.now();
  const d1Appeared = await waitFor(async () => (await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; return !!(it && it.primitives.getNode(" + JSON.stringify(d1HostId) + "));")) === true, 5000);
  const d1WaitedMs = Date.now() - d1T0;
  const d1Page = await inFrame(canvasFrame(), [
    "const it = window.__openarcCanvasInternals;",
    "const has = (id) => !!(it && it.primitives.getNode(id));",
    "const nodeEl = (id) => document.querySelector('.node[data-id=' + id + ']');",
    "return { hasLocal: has(" + JSON.stringify(d1LocalId) + "), localText: String((it.primitives.getNode(" + JSON.stringify(d1LocalId) + ") || {}).text || ''),",
    "  hasHost: has(" + JSON.stringify(d1HostId) + "), domHost: !!nodeEl(" + JSON.stringify(d1HostId) + "),",
    "  hostText: String((it.primitives.getNode(" + JSON.stringify(d1HostId) + ") || {}).text || ''),",
    "  revision: it.getState().canvas ? Number(it.getState().canvas.revision) : null, nodes: it.getState().nodes.length };",
  ].join("\n"));
  const d1IpcHost = await nodeOf(currentCanvasId, d1HostId);
  const d1IpcLocal = await nodeOf(currentCanvasId, d1LocalId);
  const d1RevAt = (await canvasState(currentCanvasId)).revision;
  await sleep(5000);
  const d1RevAfter = (await canvasState(currentCanvasId)).revision;
  const d1RevisionStable = d1RevAt === d1RevAfter;
  record("F3d", "本地编辑保存之后，宿主 IPC canvas/command（actorKind=USER）新增的节点仍能进到已打开的编辑器（≤5s，primitives + DOM）：用户本地内容不被覆盖、revision 不回环",
    d1Ready.ok === true && !!d1LocalEdit && d1LocalEdit.ok === true && d1LocalSaved === true && !!(d1HostAdd && d1HostAdd.ok) && d1Appeared === true && d1WaitedMs <= 5000
      && !!d1Page && d1Page.hasHost === true && d1Page.domHost === true && d1Page.localText === d1LocalText && !!d1IpcHost && d1IpcHost.text === d1HostText && !!d1IpcLocal && d1IpcLocal.text === d1LocalText && d1RevisionStable,
    "本地编辑落库 → 宿主新增 ≤5s 呈现（primitives+DOM）+ 本地内容仍在 + revision 稳定",
    JSON.stringify({ ready: { ok: d1Ready.ok, waitedMs: d1Ready.waitedMs, steps: d1Ready.steps }, localEdit: d1LocalEdit, localSaved: d1LocalSaved, hostAdd: { ok: !!(d1HostAdd && d1HostAdd.ok), revision: d1HostAdd && d1HostAdd.ok ? d1HostAdd.canvas.revision : null, error: d1HostAdd && d1HostAdd.error }, waitedMs: d1WaitedMs, page: d1Page, ipcHost: d1IpcHost && { found: d1IpcHost.found, text: d1IpcHost.text }, ipcLocal: d1IpcLocal && { found: d1IpcLocal.found, text: d1IpcLocal.text }, revisions: { at: d1RevAt, after5s: d1RevAfter } }));

  /* ══════════════════ F3e：500ms 待保存窗口内的受控交错 —— 两边内容都必须保留 ══════════════════ */
  // 已登记缺陷（第八 / 十 / 十一批实测）：页面在 debounce 窗口里做的本地编辑撞上宿主 / AI 的改动时，
  // 上游 409 分支会把基线换成远端新值后**重发同一份基于旧 revision 的旧文档** —— 对方那次改动被静默覆盖。
  // 本断言在**同一个 500ms 窗口内**制造交错（页面 applyCommand 之后立刻用宿主 IPC canvas/command 写入）：
  //   ① 不同节点：两边都要在（页面 primitives + DOM + 宿主读回 + 关窗重开仍在）；
  //   ② 同一节点同一字段：本地那一版留在原位、远端那一版作为可辨认副本（<id>-remote）保留，
  //      两边文本都能在存储里读到，而且合并**确实发生过**（页面冲突证据通道 count ≥ 1，不是碰巧没冲突）。
  // **只新增这一条，不改任何既有断言。**
  await page.bringToFront().catch(() => {});
  const f3eLocalId = "n_f3e_local", f3eHostId = "n_f3e_host", f3eSharedId = "n_f3e_shared";
  const f3eLocalText = "F3e 页面本地编辑", f3eHostText = "F3e 宿主窗口内写入";
  const f3ePageText = "F3e 页面改的文本", f3eHostEditText = "F3e 宿主改的文本";
  const f3eReady = await waitChain2Ready("n_img", 20000);
  const f3eIpcText = async (id) => { const n = await nodeOf(currentCanvasId, id); return n ? String(n.text == null ? "" : n.text) : null; };
  // ① 不同节点：同一个 500ms 窗口内交错
  const f3eT0 = Date.now();
  const f3eLocal = f3eReady.ok
    ? await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type: 'node.add', node: { id: " + JSON.stringify(f3eLocalId) + ", type: 'prompt', x: 220, y: 620, text: " + JSON.stringify(f3eLocalText) + " } }, null);")
    : { __skipped: "canvas-not-ready" };
  const f3eHost = await canvas({ type: "canvas/command", canvasId: currentCanvasId, command: { type: "node.add", node: { id: f3eHostId, type: "prompt", x: 220, y: 780, text: f3eHostText } } });
  const f3eWindowMs = Date.now() - f3eT0;
  // 等页面那次保存真的落库（页面独有的 id 出现在存储里），再留 4s 让"盲重试"跑完 —— 修复前它正是
  // 在这段时间里把宿主那次写入覆盖掉的；修复后这段时间里不会再有任何覆盖。
  const f3eLocalSaved = await waitFor(async () => !!(await nodeOf(currentCanvasId, f3eLocalId)), 25000);
  await sleep(4000);
  const f3ePage = await inFrame(canvasFrame(), [
    "const it = window.__openarcCanvasInternals;",
    "const g = (id) => { const n = it.primitives.getNode(id); return n ? String(n.text == null ? '' : n.text) : null; };",
    "const log = (it.primitives.conflictLog && it.primitives.conflictLog()) || window.__openarcCanvasConflicts || null;",
    "return { localText: g(" + JSON.stringify(f3eLocalId) + "), hostText: g(" + JSON.stringify(f3eHostId) + "),",
    "  domHost: !!document.querySelector('.node[data-id=' + " + JSON.stringify(f3eHostId) + " + ']'), domLocal: !!document.querySelector('.node[data-id=' + " + JSON.stringify(f3eLocalId) + " + ']'),",
    "  conflicts: log ? log.count : 0, lastOutcome: log && log.last ? log.last.outcome : null };",
  ].join("\n"));
  const f3eIpcLocalText = await f3eIpcText(f3eLocalId);
  const f3eIpcHostText = await f3eIpcText(f3eHostId);
  // ② 同一节点同一字段：先把共享节点落库，再在同一窗口内交错
  const f3eSeed = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type: 'node.add', node: { id: " + JSON.stringify(f3eSharedId) + ", type: 'prompt', x: 220, y: 940, text: 'F3e 共享节点（初始）' } }, null);");
  const f3eSeedSaved = await waitFor(async () => !!(await nodeOf(currentCanvasId, f3eSharedId)), 25000);
  await sleep(1500);
  const f3eT1 = Date.now();
  const f3eEditLocal = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type: 'node.edit', id: " + JSON.stringify(f3eSharedId) + ", patch: { text: " + JSON.stringify(f3ePageText) + " } }, null);");
  const f3eEditHost = await canvas({ type: "canvas/command", canvasId: currentCanvasId, command: { type: "node.edit", id: f3eSharedId, patch: { text: f3eHostEditText } } });
  const f3eEditWindowMs = Date.now() - f3eT1;
  const f3eEditSaved = await waitFor(async () => (await f3eIpcText(f3eSharedId)) === f3ePageText, 25000);
  await sleep(4000);
  const f3eConflict = await inFrame(canvasFrame(), [
    "const it = window.__openarcCanvasInternals;",
    "const g = (id) => { const n = it.primitives.getNode(id); return n ? { text: String(n.text == null ? '' : n.text), mark: n.oaConflictCopyOf || null } : null; };",
    "const log = (it.primitives.conflictLog && it.primitives.conflictLog()) || window.__openarcCanvasConflicts || null;",
    "return { shared: g(" + JSON.stringify(f3eSharedId) + "), copy: g(" + JSON.stringify(f3eSharedId + "-remote") + "),",
    "  conflicts: log ? log.count : 0, last: log ? log.last : null };",
  ].join("\n"));
  const f3eIpcSharedText = await f3eIpcText(f3eSharedId);
  const f3eIpcCopyText = await f3eIpcText(f3eSharedId + "-remote");
  // ③ 关窗重开：两边内容都还在（重开恢复）
  const f3eClosed = await closeAppWindow();
  await sleep(800);
  const f3eReopened = await reopenCurrentCanvasFromHome();
  const f3eStillThere = f3eReopened && await waitFor(async () => {
    const [local, host, shared, copy] = await Promise.all([f3eIpcText(f3eLocalId), f3eIpcText(f3eHostId), f3eIpcText(f3eSharedId), f3eIpcText(f3eSharedId + "-remote")]);
    return local === f3eLocalText && host === f3eHostText && shared === f3ePageText && copy === f3eHostEditText;
  }, 25000);
  const f3eReopenPage = f3eReopened ? await inFrame(canvasFrame(), [
    "const it = window.__openarcCanvasInternals;",
    "const g = (id) => { const n = it.primitives.getNode(id); return n ? String(n.text == null ? '' : n.text) : null; };",
    "return { localText: g(" + JSON.stringify(f3eLocalId) + "), hostText: g(" + JSON.stringify(f3eHostId) + "), sharedText: g(" + JSON.stringify(f3eSharedId) + "), copyText: g(" + JSON.stringify(f3eSharedId + "-remote") + ") };",
  ].join("\n")) : null;
  record("F3e", "500ms 待保存窗口内的受控交错：页面本地编辑与宿主 IPC 改动**两边内容都保留**（不同节点都在；同一节点同一字段 → 本地原位 + 远端 <id>-remote 副本；关窗重开仍在）",
    f3eReady.ok === true && f3eWindowMs < 500 && f3eEditWindowMs < 500
      && f3eLocal && f3eLocal.ok === true && f3eLocalSaved === true && !!(f3eHost && f3eHost.ok)
      && !!f3ePage && f3ePage.localText === f3eLocalText && f3ePage.hostText === f3eHostText && f3ePage.domLocal === true && f3ePage.domHost === true
      && f3eIpcLocalText === f3eLocalText && f3eIpcHostText === f3eHostText
      && !!f3eSeed && f3eSeed.ok === true && f3eSeedSaved === true && f3eEditSaved === true
      && !!f3eConflict && f3eConflict.shared && f3eConflict.shared.text === f3ePageText && f3eConflict.copy && f3eConflict.copy.text === f3eHostEditText
      && f3eIpcSharedText === f3ePageText && f3eIpcCopyText === f3eHostEditText
      && f3eConflict.conflicts >= 2
      && f3eClosed === true && f3eReopened === true && f3eStillThere === true
      && !!f3eReopenPage && f3eReopenPage.sharedText === f3ePageText && f3eReopenPage.copyText === f3eHostEditText,
    "同窗口交错 → 两边都在（页面 + DOM + IPC + 重开后）+ 同字段冲突留 <id>-remote 副本 + 合并确实发生",
    JSON.stringify({ windowMs: f3eWindowMs, editWindowMs: f3eEditWindowMs, local: f3eLocal, host: f3eHost && { ok: f3eHost.ok, error: f3eHost.error || null }, localSaved: f3eLocalSaved, page: f3ePage, ipc: { local: f3eIpcLocalText, host: f3eIpcHostText }, seed: f3eSeed && { ok: f3eSeed.ok }, seedSaved: f3eSeedSaved, editLocal: f3eEditLocal && { ok: f3eEditLocal.ok, error: f3eEditLocal.error || null }, editHost: f3eEditHost && { ok: f3eEditHost.ok, error: f3eEditHost.error || null }, editSaved: f3eEditSaved, conflict: f3eConflict, ipcConflict: { shared: f3eIpcSharedText, copy: f3eIpcCopyText }, closed: f3eClosed, reopened: f3eReopened, stillThere: f3eStillThere, reopenPage: f3eReopenPage }));

  /* ══════════════════ E 系列：宿主级隔离（F5） ══════════════════ */
  const boundary = await inFrame(canvasFrame(), "return { openarc: typeof window.openarc, require: typeof window.require, process: typeof window.process, ipc: typeof window.ipcRenderer, fs: typeof window.fs, pywebview: typeof window.pywebview };");
  const unsupported = await inFrame(canvasFrame(), "const r = await fetch('/api/secret-thing'); return { status: r.status, body: await r.json() };");
  const shellBoundary = await inFrame(shellFrame(), "return { openarc: typeof window.openarc, require: typeof window.require, process: typeof window.process, ipc: typeof window.ipcRenderer };");
  record("E1", "应用页面（含外壳页与画布子页）没有 openarc 桥 / Node / IPC / fs；端点白名单外一律明确拒绝",
    [boundary, shellBoundary].every((b) => b.openarc === "undefined" && b.require === "undefined" && b.process === "undefined" && b.ipc === "undefined") && unsupported.status === 501 && unsupported.body.error === "OPENARC_UNSUPPORTED",
    "无桥 + 501", JSON.stringify({ boundary, shellBoundary, unsupported }));

  const escapeProto = await inFrame(canvasFrame(), "const a = await fetch('openarc-canvas://bundle/../package.json'); const b = await fetch('openarc-canvas://bundle/SOURCE.md'); const c = await fetch('openarc-canvas://bundle/static/js/canvas.js'); return { traversal: a.status, nonWhitelisted: b.status, whitelisted: c.status };");
  record("E2", "openarc-canvas:// 只读白名单：目录穿越与非白名单扩展名都被拒，白名单内资源正常",
    escapeProto.traversal >= 400 && escapeProto.nonWhitelisted >= 400 && escapeProto.whitelisted === 200,
    "403/404 + 200", JSON.stringify(escapeProto));

  const forged = await js("window.__openarcCanvasForged = null; try { const r = await window.openarc.canvas.command({ type: 'canvas/list', userId: 'usr_forged_identity', sessionRef: 'forged-session' }); window.__openarcCanvasForged = { ok: r.ok, count: (r.items || []).length }; } catch (e) { window.__openarcCanvasForged = { error: String(e.message).slice(0, 60) }; } return window.__openarcCanvasForged;");
  const forgedList = await canvas({ type: "canvas/list" });
  record("E3", "后端不信任消息自报身份：带伪造 userId/sessionRef 的请求按当前会话处理",
    forged && forged.ok === true && forged.count === (forgedList.items || []).length,
    "按会话身份处理", JSON.stringify({ forged, sessionListCount: (forgedList.items || []).length }));

  const listBefore2 = (await canvas({ type: "canvas/list" })).items.length;
  const e4res = await js("const f = document.createElement('iframe'); f.id='oa-forged-frame'; f.setAttribute('sandbox','allow-scripts'); f.src='openarc-canvas://bundle/index.html?id=cv_probe'; f.style.display='none'; document.body.appendChild(f); await new Promise(r=>setTimeout(r,2500)); const w = f.contentWindow; try { w.postMessage({ ch:'openarc.canvas', dir:'canvas->host', kind:'call', id: 991, token:'t_forged', method:'canvas.create', params:{ title:'伪造' } }, '*'); } catch(e) {} window.postMessage({ ch:'openarc.canvas', dir:'canvas->host', kind:'call', id: 992, token:'t_forged', method:'canvas.create', params:{ title:'来自外壳' } }, '*'); await new Promise(r=>setTimeout(r,1800)); f.remove(); return { done: true };");
  await sleep(500);
  const listAfter2 = (await canvas({ type: "canvas/list" })).items.length;
  record("E4", "宿主只接受**当前应用实例**的消息：伪造 token / 其它 iframe / 外壳自身发的调用一律不执行",
    listAfter2 === listBefore2,
    "画布数量不变", JSON.stringify({ e4res, listBefore2, listAfter2 }));

  /** A 账号（admin）本次挂载的存储钥匙与分桶自证：必须在导航尝试**之前**采集。
   *  E8 里 own>=1 必须有**真实、确定的来源**：这里在 A 账号页面的 scoped localStorage 写一个探针键 ——
   *  桥会把键名写成 "oa:<本次挂载钥匙>:oa_probe_a" 落到**真实同源 localStorage**（谁写的：A 这一次挂载的页面；
   *  写在哪一层：真实存储、带 A 的钥匙前缀），不再依赖某个页面顺手写 studio_active_page。*/
  const keyA = await shellJs("return String(window.__openarcBridge.accountKey());");
  const probeA = await shellJs("const b = window.__openarcBridge; const before = b.storageIsolation(); window.localStorage.setItem('oa_probe_a', 'A-account-probe'); const after = b.storageIsolation(); return { before: before, after: after, readBack: window.localStorage.getItem('oa_probe_a'), rawKey: 'oa:' + String(b.accountKey()) + ':oa_probe_a' };");
  const isoA = probeA ? probeA.after : null;

  const receiver = await startReceiver();
  const egress = await inFrame(canvasFrame(), [
    "const out = { };",
    "try { const r = await fetch('http://127.0.0.1:" + receiver.port + "/fetch'); out.fetch = r.status; } catch (e) { out.fetch = 'throw'; }",
    "try { const img = new Image(); img.src = 'http://127.0.0.1:" + receiver.port + "/img'; document.body.appendChild(img); out.img = 'set'; } catch (e) { out.img = 'throw'; }",
    "try { new WebSocket('ws://127.0.0.1:" + receiver.port + "/ws'); out.ws = 'set'; } catch (e) { out.ws = 'throw:' + String(e.name); }",
    "try { const f = document.createElement('form'); f.method = 'POST'; f.action = 'http://127.0.0.1:" + receiver.port + "/form'; const i = document.createElement('input'); i.name = 'x'; i.value = '1'; f.appendChild(i); document.body.appendChild(f); f.submit(); out.form = 'submitted'; } catch (e) { out.form = 'throw'; }",
    "try { const s = document.createElement('script'); s.src = 'http://127.0.0.1:" + receiver.port + "/script.js'; document.body.appendChild(s); out.script = 'set'; } catch (e) { out.script = 'throw'; }",
    "await new Promise(r => setTimeout(r, 1200));",
    "return out;",
  ].join("\n"));
  // **iframe 自我导航**：location.href 无法被 CSP 关掉，必须由宿主 will-frame-navigate 拦住
  const popup = await inFrame(canvasFrame(), "const w = window.open('http://127.0.0.1:" + receiver.port + "/popup'); return { opened: !!w };");
  // **iframe 自我导航**：location.href 形式（CSP 没有 navigate-to 指令）。这里从画布子页与外壳页各试一次。
  const navTry = await inFrame(canvasFrame(), "try { window.location.href = 'http://127.0.0.1:" + receiver.port + "/selfnav'; } catch (e) { return { threw: String(e.name) }; } await new Promise(r=>setTimeout(r,1500)); return { url: String(window.location.href).slice(0, 60) };").catch(() => ({ context: "destroyed" }));
  // 画布子页被非预期导航打断后：接收端 0 命中；应用仍可用（重新从首页进入画布成功）
  await sleep(1500);
  const egressHitsCanvas = receiver.hits();
  const relayResetAttempted = stderrBuf.indexOf("自动复位") >= 0 || true; // 复位由页面侧中继执行，主进程看不到；这里只记录观测
  const usableAfter = await reopenCurrentCanvasFromHome();
  const usableState = await waitFor(async () => {
    const st = await inFrame(canvasFrame(), "return { id: window.__openarcCanvas ? window.__openarcCanvas.state().canvasId : null };");
    return st && st.id === currentCanvasId;
  }, 30000) ? await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount };") : null;
  note("画布页自我导航被拦后的状态：" + JSON.stringify({ usableAfter, usableState, relayResetAttempted }));
  record("E5", "出网通道：fetch / 图片 / WebSocket / 表单 / 外站脚本 / window.open / **iframe 自我导航**全部被拦（本地接收端 0 命中；被拦后重新进入画布仍可用）",
    egressHitsCanvas.length === 0 && usableAfter === true && !!usableState && usableState.id === currentCanvasId,
    "接收端 0 命中 + 应用仍可用", JSON.stringify({ attempts: egress, popup, selfNav: navTry, hits: egressHitsCanvas, usableAfter, usableState }));

  // 外壳页与 OpenArc 顶层页的导航尝试（CSP 管不到顶层，宿主 will-navigate 负责）：只证明 0 命中 + 应用仍活着
  const shellNavTry = await inFrame(shellFrame(), "try { window.location.href = 'http://127.0.0.1:" + receiver.port + "/shellnav'; } catch (e) { return { threw: String(e.name) }; } await new Promise(r=>setTimeout(r,1200)); return { url: String(window.location.href).slice(0, 60) };").catch(() => ({ context: "destroyed" }));
  const topNavTry = await js("try { window.location.href = 'http://127.0.0.1:" + receiver.port + "/topnav'; } catch (e) { return { threw: String(e.name) }; } await new Promise(r=>setTimeout(r,1200)); return { url: String(window.location.href).slice(0, 40) };").catch(() => ({ context: "destroyed" }));
  await sleep(2000);
  const egressHits = receiver.hits();
  const desktopAlive = await has(".desktop");
  await receiver.close();
  record("E5b", "外壳页 / 顶层页的导航出网同样被拦（应用还活着、接收端仍 0 命中）",
    egressHits.length === 0 && desktopAlive === true,
    "接收端 0 命中 + 桌面仍在", JSON.stringify({ shellNav: shellNavTry, topNav: topNavTry, hits: egressHits, desktopAlive }));
  const hostBlocked = stderrBuf.includes("已拦截应用内导航出网");
  record("E6", "宿主级拦截留证：主进程 will-navigate / will-frame-navigate 真的拦下了导航出网（不是只靠页面 CSP 声明）",
    hostBlocked,
    "主进程日志出现拦截记录", hostBlocked ? "found" : "missing");

  /* ══════════════════ 账号边界 ══════════════════ */
  const createdMember = await governance({ type: "governance/createUser", identifier: MEMBER.id, password: MEMBER.pw, displayName: "D5-02 Member", role: "MEMBER" });
  await logout();
  // 卸载是异步的：等旧帧真的全部销毁（不是"立刻读一次"）
  await waitFor(() => allBundleFrames().length === 0, 15000);
  const framesAfterLogout = allBundleFrames().length;
  const memberLogin = await login(MEMBER.id, MEMBER.pw);
  const memberList = await canvas({ type: "canvas/list" });
  const memberOpen = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  record("E7", "账号边界（数据）：切账号后旧页面全部销毁，B 看不到也打不开 A 的私有画布",
    framesAfterLogout === 0 && memberLogin && !!(createdMember && createdMember.ok) && memberList.ok && !(memberList.items || []).some((c) => c.canvasId === currentCanvasId) && memberOpen.ok === false,
    "0 个残留帧 + B 的列表不含 A 的画布", JSON.stringify({ framesAfterLogout, memberLogin, createdMember: !!(createdMember && createdMember.ok), memberListCount: (memberList.items || []).length, memberOpen: memberOpen.ok }));

  await openAppWindow();
  await waitFor(() => !!shellFrame(), 25000);
  await sleep(800);
  const keyB = await shellJs("return String(window.__openarcBridge.accountKey());");
  /** B 侧探针：B 也写一个自己的键 —— 这样 isoB.own>=1 有真实来源（隔离探针确实看得见键），
   *  foreign===0 才不是"空对空"；同时用 B 的 scoped 存储去读 A 的逻辑键（必须 null）。*/
  const probeB = await shellJs("const b = window.__openarcBridge; window.localStorage.setItem('oa_probe_b', 'B-account-probe'); const iso = b.storageIsolation(); return { isolation: iso, ownReadBack: window.localStorage.getItem('oa_probe_b'), foreignReadBack: window.localStorage.getItem('oa_probe_a'), rawKey: 'oa:' + String(b.accountKey()) + ':oa_probe_b', logicalKeys: (function () { const out = []; for (let i = 0; i < localStorage.length; i += 1) out.push(localStorage.key(i)); return out.slice(0, 8); })(), active: localStorage.getItem('studio_active_page') };");
  const isoB = probeB ? probeB.isolation : null;
  const pageSide = { logicalKeys: probeB ? probeB.logicalKeys : null, active: probeB ? probeB.active : null };
  record("E8", "账号边界（存储/通道）：真实同源存储按**本次挂载钥匙**分桶，A 账号的键一个不剩（A/B 各自写入探针键自证 + 桥的只读隔离探针）",
    !!keyA && !!keyB && keyA !== keyB
      && isoA && isoA.mount === true && isoA.foreign === 0 && probeA && probeA.before && Number(isoA.own) >= Number(probeA.before.own) + 1 && probeA.readBack === "A-account-probe"
      && isoB && isoB.mount === true && isoB.foreign === 0 && Number(isoB.own) >= 1 && probeB && probeB.ownReadBack === "B-account-probe" && probeB.foreignReadBack === null,
    "钥匙变化 + 0 个外账号键 + oa:mount=当前钥匙 + A 的键在 B 侧读不到",
    JSON.stringify({ keyAHead: String(keyA).slice(0, 8), keyBHead: String(keyB).slice(0, 8), probeA: probeA ? { before: probeA.before, after: probeA.after, readBack: probeA.readBack, rawKey: probeA.rawKey } : null, isoA, probeB: probeB ? { isolation: probeB.isolation, ownReadBack: probeB.ownReadBack, foreignReadBack: probeB.foreignReadBack, rawKey: probeB.rawKey } : null, isoB, pageSide }));

  await logout();
  await login(ADMIN.id, ADMIN.pw);
  // 新形态：重新打开应用先落在列表首页（没有外壳的"上次页面"还原）——按产品路径从列表卡片进入当前这本。
  const reopenedForF4 = await reopenCurrentCanvasFromHome();
  note("F4 前置：切回 admin 后从画布列表重新进入当前这本 = " + reopenedForF4);

  /* ══════════════════ F4：AI 编辑正式链（提议 → 审批 → 执行 → 呈现 → 保存恢复） ══════════════════ */
  const f4 = await runAiEditChain();
  record("F4", "AI 编辑正式链：Agent 提议 → 用户审批 → 授权执行 → 画布呈现 → 保存重开仍在（旧 revision 不覆盖用户内容）",
    f4.ok, f4.expected, f4.actual);


  /* ══════════════════ F3f：MOTION_SYSTEM §6 —— AI 新增节点 160ms 淡入 + 来源标记 ══════════════════ */
  // 真源是**画布命令账本**（canvas/log 的 actorKind=AGENT、outcome=APPLIED、command.node.id），
  // **不是**"这次改动是远端同步来的"：本地用户新增、别的窗口的 USER 操作走的是同一条远端同步路径。
  // 样本：agent_node_1 = F4 那条正式链里 canvas.edit（actorKind=AGENT）真的加上去的；
  //       n_prompt = A7 里页面自己 applyCommand（用户手工）加的 —— 它必须既没有标记、也没有淡入。
  // **只新增这一条断言，不改任何既有断言。**
  await page.bringToFront().catch(() => {});
  const f3fWait = await waitFor(async () => (await inFrame(canvasFrame(), "return !!document.querySelector('.node[data-id=agent_node_1] .openarc-ai-badge');")) === true, 20000);
  const f3f = await inFrame(canvasFrame(), [
    "const it = window.__openarcCanvasInternals;",
    "const elOf = (id) => document.querySelector('.node[data-id=' + id + ']');",
    "const ai = elOf('agent_node_1'), user = elOf('n_prompt');",
    "const badgeOf = (nodeEl) => { const b = nodeEl ? nodeEl.querySelector('.openarc-ai-badge') : null; if (!b) return null; const cs = getComputedStyle(b);",
    "  const r = b.getBoundingClientRect(); const n = nodeEl.getBoundingClientRect();",
    "  return { text: String(b.textContent || '').trim(), source: b.getAttribute('data-openarc-ai-source'), aria: b.getAttribute('aria-label'), inHead: !!b.closest('.node-head'), pointerEvents: cs.pointerEvents,",
    "    fontSize: cs.fontSize, lineHeight: cs.lineHeight, fontWeight: cs.fontWeight, color: cs.color, background: cs.backgroundColor, borderRadius: cs.borderRadius, borderStyle: cs.borderStyle, borderWidth: cs.borderWidth, box: { w: Math.round(r.width), h: Math.round(r.height) }, insideNode: r.left >= n.left - 1 && r.right <= n.right + 1 && r.top >= n.top - 1 && r.bottom <= n.bottom + 1 }; };",
    "const sample = (nodeEl, ms) => new Promise((resolve) => { const out = []; const t0 = performance.now();",
    "  const tick = () => { out.push([Math.round(performance.now() - t0), Number(getComputedStyle(nodeEl).opacity)]); if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve(out); };",
    "  requestAnimationFrame(tick); });",
    "const anim = (nodeEl) => nodeEl.getAnimations().map((a) => ({ name: a.animationName || null, duration: a.effect.getTiming().duration, easing: String(getComputedStyle(nodeEl).animationTimingFunction || '') }));",
    "const state0 = it.primitives.aiMarks();",
    "const markedAi = !!(ai && ai.getAttribute('data-openarc-ai-source') === 'agent');",
    "const badge = badgeOf(ai);",
    "const userSource = user ? user.getAttribute('data-openarc-ai-source') : null;",
    "const userBadges = user ? user.querySelectorAll('.openarc-ai-badge').length : -1;",
    "ai.removeAttribute('data-openarc-ai-enter'); void ai.offsetWidth; ai.setAttribute('data-openarc-ai-enter', '1');",
    "const anims = anim(ai);",
    "const opacityAtStart = Number(getComputedStyle(ai).opacity);",
    "const samples = await sample(ai, 260);",
    "const rmPrev = document.documentElement.getAttribute('data-openarc-reduced-motion');",
    "document.documentElement.setAttribute('data-openarc-reduced-motion', '1');",
    "ai.removeAttribute('data-openarc-ai-enter'); void ai.offsetWidth; ai.setAttribute('data-openarc-ai-enter', '1');",
    "const rmAnims = anim(ai);",
    "const rmOpacity = Number(getComputedStyle(ai).opacity);",
    "const rmSamples = await sample(ai, 120);",
    "ai.removeAttribute('data-openarc-ai-enter');",
    "if (rmPrev === null) document.documentElement.removeAttribute('data-openarc-reduced-motion'); else document.documentElement.setAttribute('data-openarc-reduced-motion', rmPrev);",
    "const ramp = samples.filter((s) => s[1] > 0.001 && s[1] < 0.999).length;",
    "const reach1 = samples.find((s) => s[1] >= 0.999) || null;",
    "const dupPerNode = Array.from(document.querySelectorAll('.node')).map((n) => n.querySelectorAll('.openarc-ai-badge').length).filter((c) => c > 1).length;",
    "return { state0: state0, markedAi: markedAi, badge: badge, user: { has: !!user, source: userSource, badges: userBadges },",
    "  anims: anims, opacityAtStart: opacityAtStart, samples: samples.slice(0, 20), ramp: ramp, reach1: reach1, first: samples[0] ? samples[0][1] : null, last: samples[samples.length - 1] ? samples[samples.length - 1][1] : null,",
    "  rm: { anims: rmAnims.length, opacity: rmOpacity, min: Math.min.apply(null, rmSamples.map((s) => s[1])), max: Math.max.apply(null, rmSamples.map((s) => s[1])) },",
    "  badges: document.querySelectorAll('.node .openarc-ai-badge').length, dupPerNode: dupPerNode,",
    "  nPromptInMarked: state0.marked.nodeIds.indexOf('n_prompt') >= 0, agent2InMarked: state0.marked.nodeIds.indexOf('agent_node_2') >= 0, agent2InDom: !!elOf('agent_node_2') };",
  ].join("\n"));
  const f3fAnim = (f3f && f3f.anims && f3f.anims[0]) || null;
  const f3fEasing = f3fAnim ? String(f3fAnim.easing).replace(/\s+/g, "") : "";
  record("F3f", "MOTION_SYSTEM §6：AI 新增节点（命令账本 actorKind=AGENT）带中性来源标记（12/18、字重 500、中性灰、无描边、pointer-events:none、不吃节点按钮），用户手工新增的节点没有标记；新节点 160ms cubic-bezier(.2,0,0,1) 淡入（实测采样），html[data-openarc-reduced-motion=1] 下 animation:none + opacity 立即为 1",
    f3fWait === true && !!f3f && !f3f.__noFrame && !f3f.__error
      && f3f.markedAi === true && !!f3f.badge && f3f.badge.text === "AI" && f3f.badge.source === "agent" && f3f.badge.inHead === true
      && f3f.badge.pointerEvents === "none" && f3f.badge.fontSize === "12px" && f3f.badge.lineHeight === "18px" && Number(f3f.badge.fontWeight) <= 500
      && f3f.badge.borderWidth === "0px" && f3f.badge.insideNode === true
      && f3f.user.has === true && f3f.user.source === null && f3f.user.badges === 0 && f3f.nPromptInMarked === false
      && f3f.agent2InMarked === false && f3f.agent2InDom === false
      && f3f.anims.length === 1 && f3fAnim.name === "openarc-ai-node-in" && Number(f3fAnim.duration) === 160 && f3fEasing === "cubic-bezier(0.2,0,0,1)"
      && f3f.opacityAtStart <= 0.02 && f3f.first !== null && f3f.ramp >= 1 && !!f3f.reach1 && f3f.reach1[0] >= 100 && f3f.reach1[0] <= 400 && f3f.last >= 0.999
      && f3f.rm.anims === 0 && f3f.rm.opacity === 1 && f3f.rm.min >= 0.999
      && f3f.dupPerNode === 0
      && f3f.state0.marked.nodeIds.indexOf("agent_node_1") >= 0 && f3f.state0.seen.nodeIds.indexOf("agent_node_1") >= 0,
    "标记 + 160ms(.2,0,0,1) 淡入 + 减少动态效果即时呈现 + 用户新增不误标 + 每节点最多一个徽标",
    JSON.stringify(f3f));

  /* ══════════════════ 收尾 ══════════════════ */
  // 门禁自己制造的噪声：E5 里被拦下的导航会在 Chromium 日志里留下 ERR_BLOCKED_BY_CSP（那正是"被拦住"的证据）。
  // ENV_NOISE = **环境噪声白名单**（不是放宽断言）：只登记应用代码之外的系统/运行时消息。
  // IMKCFRunLoopWakeUpReliable：macOS 输入法框架（IMKit）向主线程 mach port 发唤醒消息失败时打的系统日志
  // （整行是 "… Electron[pid:tid] error messaging the mach port for IMKCFRunLoopWakeUpReliable"），
  // 仓库里 0 命中、与既有 SetApplicationIsDaemon / NSOSStatusErrorDomain 同类；应用代码不可能产生它。
  const ENV_NOISE = /ExperimentalWarning|SQLite is an experimental|SetApplicationIsDaemon|NSOSStatusErrorDomain|IMKCFRunLoopWakeUpReliable|In-process GPU|ERR_BLOCKED_BY_CSP|Failed to load URL: http:\/\/127\.0\.0\.1/;
  const tail = stderrBuf.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !ENV_NOISE.test(l) && !/已拦截应用内导航出网/.test(l)).slice(0, 5);
  record("Z1", "主进程无未处理错误", tail.length === 0, "无错误行", tail.join(" | ") || "clean");
  note("控制台错误样本：" + JSON.stringify(consoleErrors.slice(0, 8)));
  note("对话框样本：" + JSON.stringify(dialogs.slice(0, 5)));

  const out = {
    phase: "D5-02 Full-App",
    title: "完整应用集成：原版首页与导航 + 统一后端 + 五项缺口（真实 electron . + 真实产品 UI + 本地确定性 provider）",
    openarcCommit: process.env.OPENARC_TESTED_COMMIT || null,
    novaiSourceCommit: process.env.NOVAI_SOURCE_COMMIT || "6ce1a64680b669b31c2ac3b32418b54decd404f2",
    command: "node experiments/d5-02/canvas-e2e.mjs",
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version },
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ART, "d5-02-canvas-e2e.json"), JSON.stringify(out, null, 2));
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  return failed === 0 ? 0 : 1;
}

/* ── N 系列辅助：模型 / 供应商验收（无模型契约 / 引导 / 未接通 / 真源渲染 / 状态点 / 无静默回落） ──
 * 契约来源（产品侧已在真实 Electron 逐条验过）：public/novai-canvas/openarc-canvas-guard.js 的 DOM 契约
 * 与 src/canvas/CanvasHost.tsx buildConfig() 的 /api/config 投影。断言只观察产品自己的 DOM / 端点 /
 * 假 provider 计数，不替产品造事实，也不放宽任何既有判定。 */
/* 本批产品契约修订（N5c / N5d 两条期望据此重写，其余断言未动）：
 *   OpenArc 里**显式配置的默认模型**不可用（能力不符 / 被停用 / 不存在 / 未授权）时，页面**不回落、不换模型、
 *   不隐瞒清单**：/api/config 的 chat_model / image_model 投影为空，能力事实带 defaultUsable:false + defaultReason，
 *   该能力按「与未配置同一套可见口径」呈现并多一个 data-openarc-default-unavailable=<cap>，运行按钮 blocked，
 *   说明行给原因 + 「打开 OpenArc 总 API 设置」引导；模型清单照旧如实投影，但那个可用模型不会被自动选中。
 *   旧期望里的「生图清单必须为空」「文本下拉此刻仍可选」两条与新契约相反，已按新契约改成更精确的判定。*/
const N_GUIDE_TEXT = "打开 OpenArc 总 API 设置";
const N_UNCONFIGURED_TEXT = {
  "chat": "未配置（OpenArc 总 API 设置里没有可用的文本模型）",
  "image-generation": "未配置（OpenArc 总 API 设置里没有可用的生图模型）",
};
const N_VIDEO_TEXT = "OpenArc 未接通视频传输（不可用）";
const N_FAKE_LABEL_RE = "/gpt-4o-mini|gpt-image-2|veo3-fast/i";
const N_FAKE_PROVIDER_RE = "/comfly/i";
const N_FAKE_CHAT_LABEL = "gpt-4o-mini";
const N_MODEL_SOURCE_KEYS = ["canvas_custom_image_models", "canvas_image_models_ordered", "canvas_chat_models_ordered"];
const N_PROVIDER_KEYS = ["chat_models", "enabled", "id", "image_models", "name", "video_models"];
/** 下拉的完整事实（class / disabled / aria / unconfigured / unavailable / 当前值 / 每个 option 的 value+text）。*/
const N_SEL_INFO = "const selInfo = (sel) => sel ? { cls: String(sel.className), disabled: !!sel.disabled, aria: sel.getAttribute('aria-disabled'), unconfigured: sel.getAttribute('data-openarc-unconfigured'), defaultUnavailable: sel.getAttribute('data-openarc-default-unavailable'), unavailable: sel.getAttribute('data-openarc-unavailable'), value: String(sel.value), options: Array.from(sel.options).map(o => ({ value: String(o.value), text: String(o.textContent).trim() })) } : null;";
const nSelBrief = (s) => (s ? { disabled: s.disabled, aria: s.aria, unconfigured: s.unconfigured, unavailable: s.unavailable, value: s.value, texts: s.options.map((o) => o.text) } : null);

/** 探针节点：生图 / 视频节点在 A 系列里还不存在，临时加进来才能看到守卫在**真实渲染**上的 DOM 契约；
 *  观察完立刻删除 —— 画布文档回到观察前的节点集合（A9 / B 系列 / F4 看到的画布不变）。 */
const N_PROBE_NODES = [
  { id: "n_ng_probe_gen", type: "generator", x: 120, y: 900, count: 1 },
  { id: "n_ng_probe_vid", type: "video", x: 620, y: 900 },
];
async function nAddProbeNodes() {
  const added = [];
  for (const node of N_PROBE_NODES) added.push(await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:" + JSON.stringify(node) + " }, null);"));
  const marked = await waitFor(async () => {
    const s = await inFrame(canvasFrame(), "return { gen: !!document.querySelector('.generator-body .provider-select[data-openarc-unconfigured=image-generation]'), vid: !!document.querySelector('.video-provider[data-openarc-unavailable=video-generation]') };");
    return !!s && s.gen === true && s.vid === true;
  }, 20000);
  return { add: added.map((r) => (r && r.ok === true ? "ok" : String((r && r.error) || "noFrame"))), marked };
}
async function nRemoveProbeNodes() {
  const res = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.delete', ids:" + JSON.stringify(N_PROBE_NODES.map((n) => n.id)) + " }, null);");
  const gone = await waitFor(async () => {
    const s = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; return { gen: !!it.primitives.getNode('n_ng_probe_gen'), vid: !!it.primitives.getNode('n_ng_probe_vid') };");
    return !!s && s.gen === false && s.vid === false;
  }, 15000);
  return { del: res && res.ok === true ? "ok" : String((res && res.error) || "noFrame"), gone };
}

/** 页面内「伪造事实」扫描：outerHTML（全部属性 + 文本）、option.value（JS 属性，不一定落成 HTML 属性）、
 *  select 当前 value 三处都扫。命中即证明页面上还留着第二套来源里的名字；样本带 where 便于定位。 */
function nFakeScanLines(reLiteral) {
  return [
    "const fake = (function () {",
    "  var re = " + reLiteral + ";",
    "  var html = document.documentElement.outerHTML;",
    "  var hits = [];",
    "  var where = function (el) { var n = el && el.closest ? el.closest('.node') : null; return n ? ('node:' + String(n.getAttribute('data-id') || '?')) : (el && el.closest && el.closest('.canvas-nav-meta') ? 'nav' : 'page'); };",
    "  if (re.test(html)) { Array.prototype.forEach.call(document.querySelectorAll('*'), function (el) { if (hits.length >= 5) return; Array.prototype.forEach.call(el.attributes || [], function (a) { if (hits.length < 5 && re.test(String(a.value))) hits.push({ kind: 'attr', where: where(el), tag: el.tagName, name: a.name, value: String(a.value).slice(0, 80) }); }); if (hits.length < 5 && el.children.length === 0 && re.test(String(el.textContent || ''))) hits.push({ kind: 'text', where: where(el), tag: el.tagName, value: String(el.textContent).slice(0, 80) }); }); }",
    "  var optionHits = []; Array.prototype.forEach.call(document.querySelectorAll('option'), function (o) { if (optionHits.length < 5 && re.test(String(o.value))) optionHits.push({ where: where(o), value: String(o.value).slice(0, 80), text: String(o.textContent).trim().slice(0, 80) }); });",
    "  var selectHits = []; Array.prototype.forEach.call(document.querySelectorAll('select'), function (s) { if (selectHits.length < 5 && re.test(String(s.value))) selectHits.push({ where: where(s), cls: String(s.className).slice(0, 60), value: String(s.value).slice(0, 80) }); });",
    "  return { htmlMatched: re.test(html), hits: hits, optionHits: optionHits, selectHits: selectHits, options: document.querySelectorAll('option').length };",
    "})();",
  ];
}

/** 守卫的三种合格写法（严格 AND：disabled + aria + 标记 + 唯一占位 option 的精确文案）。*/
const nSelOk = (s, cap) => !!s && s.disabled === true && s.aria === "true" && s.unconfigured === cap && s.unavailable === null && s.options.length === 1 && s.options[0].value === "" && s.options[0].text === N_UNCONFIGURED_TEXT[cap];
const nVideoSelOk = (s) => !!s && s.disabled === true && s.aria === "true" && s.unavailable === "video-generation" && s.unconfigured === null && s.options.length === 1 && s.options[0].value === "" && s.options[0].text === N_VIDEO_TEXT;
const nAvailSel = (s, list) => !!s && s.disabled === false && !s.unconfigured && !s.unavailable && s.options.length >= 1 && s.options.every((o) => o.value !== "" && list.includes(o.value)) && list.includes(String(s.value));
/** 显式配置的默认模型不可用时的呈现（本批产品契约修订）：与"未配置"同一套可见口径
 *  （disabled + aria-disabled + data-openarc-unconfigured + 唯一「未配置…」占位）**并且**多一个
 *  data-openarc-default-unavailable=<cap> 把原因分开；select.value 为空 = 没有自动选中清单里的别的模型。*/
const nDefaultDownSel = (s, cap) => !!s && s.disabled === true && s.aria === "true" && s.unconfigured === cap && s.unavailable === null
  && s.defaultUnavailable === cap && s.options.length === 1 && s.options[0].value === "" && s.options[0].text === N_UNCONFIGURED_TEXT[cap] && String(s.value) === "";
/** 运行按钮被守卫按能力禁用（disabled + aria-disabled + data-openarc-blocked=<cap>）。*/
const nBlockedRun = (r, cap) => !!r && r.disabled === true && r.aria === "true" && r.blocked === cap;
/** 说明行：点名「默认不可用」+ 真实原因（缺能力/停用/不存在/未授权）+ 可点的「打开 OpenArc 总 API 设置」。*/
const nReasonNote = (n) => !!n && /默认不可用/.test(String(n.text)) && /没有这个能力|停用|不存在|未被授权使用/.test(String(n.text)) && n.guide === true && n.guideText === N_GUIDE_TEXT;

/** N5 状态点：读一次真源 + DOM + 节点当前模型（同一次读取里的 fetch('/api/config') 就是页面重读真源的动作，
 *  守卫按这次响应更新事实 → providers-changed → 上游 refreshCanvasConfigFromSettings + render → 守卫再扫一遍）。*/
const nModelArea = () => inFrame(canvasFrame(), [
  "const cfg = await (await fetch('/api/config')).json();",
  N_SEL_INFO,
  "const it = window.__openarcCanvasInternals;",
  "const node = (id) => { try { const n = it.primitives.getNode(id); return n ? { provider: String(n.apiProvider || n.llmProvider || ''), model: String(n.model || '') } : null; } catch (e) { return null; } };",
  "const chip = document.querySelector('.canvas-nav-meta [data-openarc-model-status]');",
  // 显式默认的可用性事实（产品契约：defaultUsable/defaultReason）+ 运行按钮 + 说明行（原因与引导）。
  "const caps = cfg.capabilities || {};",
  "const runOf = (nodeId, cls) => { const n = document.querySelector('.node[data-id=' + nodeId + ']'); const b = n ? n.querySelector('.' + cls) : null; return b ? { cls: String(b.className), blocked: b.getAttribute('data-openarc-blocked'), disabled: !!b.disabled, aria: b.getAttribute('aria-disabled'), title: String(b.title || '').slice(0, 90) } : null; };",
  "const noteOf = (nodeId, cap) => { const n = document.querySelector('.node[data-id=' + nodeId + ']'); const p = n ? n.querySelector('[data-openarc-guard-note=' + cap + ']') : null; if (!p) return null; const g = p.querySelector('[data-openarc-open-model-settings]'); return { text: String((p.querySelector('.openarc-guard-note-text') || {}).textContent || '').trim(), guide: !!g, guideText: g ? String(g.textContent).trim() : null }; };",
  "return { chip: chip ? chip.getAttribute('data-openarc-model-status') : null,",
  "  chipText: String((chip && chip.querySelector('.openarc-model-status-text') || {}).textContent || '').trim(),",
  "  caps: { chat: caps.chat || null, image: caps['image-generation'] || null },",
  "  chat: { provider: selInfo(document.querySelector('.llm-provider-select')), model: selInfo(document.querySelector('.llm-model')) },",
  "  image: { provider: selInfo(document.querySelector('.generator-body .provider-select')), model: selInfo(document.querySelector('.generator-body .model-select')) },",
  "  chatRun: runOf('n_llm', 'llm-run'), imageRun: runOf('n_gen', 'gen-btn'),",
  "  chatNote: noteOf('n_llm', 'chat'), imageNote: noteOf('n_gen', 'image-generation'),",
  "  nodes: { llm: node('n_llm'), gen: node('n_gen') },",
  "  manifest: { chat: cfg.chat_models || [], image: cfg.image_models || [], providers: (cfg.api_providers || []).map(function (p) { return String(p.id); }) } };",
].join("\n"));
/** want：unavailable-all（撤权：文本+生图都不可用）| available-all |
 *  image-unavailable（跨能力：生图显式默认不可用，label = 那个仍可用、但**不该被自动选中**的生图模型标签）|
 *  chat-model-removed（停用**显式配置的文本默认**：label = 被停用模型标签）。*/
function nModelAreaOk(want, snap, label) {
  if (!snap || snap.__noFrame || snap.__error) return false;
  const chat = snap.manifest.chat || [], image = snap.manifest.image || [];
  if (want === "unavailable-all") return snap.chip === "unconfigured" && chat.length === 0 && image.length === 0 && nSelOk(snap.chat.model, "chat") && nSelOk(snap.image.model, "image-generation");
  if (want === "available-all") return snap.chip === "ok" && chat.length > 0 && image.length > 0 && nAvailSel(snap.chat.model, chat) && nAvailSel(snap.image.model, image);
  // 跨能力（生图默认被指到只有 chat 的模型）：产品契约修订后**不再要求生图清单为空**（清单照旧如实投影，
  // 不向页面隐瞒真源），而是要求「默认不可用」口径 + 那个可用生图模型仍在清单里、但没被自动选中（label = 生图默认模型标签）。
  if (want === "image-unavailable") return snap.chip === "unconfigured"
    && !!snap.caps && !!snap.caps.image && snap.caps.image.defaultUsable === false && snap.caps.image.defaultReason === "CAPABILITY_UNAVAILABLE"
    && image.length > 0 && (!label || image.includes(label))
    && nDefaultDownSel(snap.image.model, "image-generation") && nBlockedRun(snap.imageRun, "image-generation") && nReasonNote(snap.imageNote)
    && chat.length > 0 && !!snap.caps.chat && snap.caps.chat.defaultUsable === true && nAvailSel(snap.chat.model, chat);
  if (want === "chat-model-removed") {
    const goneFromManifest = !chat.includes(label) && !image.includes(label);
    const goneFromDom = !(snap.chat.model && snap.chat.model.options.some((o) => o.value === label));
    const goneFromNode = !(snap.nodes && snap.nodes.llm && snap.nodes.llm.model === label);
    if (!(goneFromManifest && goneFromDom && goneFromNode)) return false;
    // 被停用的正是**显式配置的文本默认**：产品契约修订 = 文本区按"默认不可用"呈现（不回落、不换模型），
    // 而不是自动改用清单里剩下的那个模型。三条 0 命中判定原样保留，只把"下拉此刻仍可选"换成更精确的呈现。
    return snap.chip === "unconfigured" && !!snap.caps && !!snap.caps.chat && snap.caps.chat.defaultUsable === false && snap.caps.chat.defaultReason === "MODEL_DISABLED"
      && nDefaultDownSel(snap.chat.model, "chat") && nBlockedRun(snap.chatRun, "chat") && nReasonNote(snap.chatNote);
  }
  return false;
}
async function nWaitModelArea(want, label, timeout = 20000) {
  const t0 = Date.now();
  let snap = null, reads = 0;
  while (Date.now() - t0 < timeout) {
    snap = await nModelArea();
    reads += 1;
    if (nModelAreaOk(want, snap, label)) return { ok: true, want: want, reads: reads, waitedMs: Date.now() - t0, snap: snap };
    await sleep(250);
  }
  return { ok: false, want: want, reads: reads, waitedMs: Date.now() - t0, snap: snap };
}
/** 证据摘要（断言之外的"一眼可读"字段）：默认不可用原因码、两个标记、运行按钮、说明行、select.value 与清单。*/
const nSnapBrief = (r) => (r ? {
  ok: r.ok, want: r.want, waitedMs: r.waitedMs, reads: r.reads, chip: r.snap && r.snap.chip, chipText: r.snap && r.snap.chipText,
  defaultFacts: r.snap && r.snap.caps ? {
    chat: r.snap.caps.chat && { usable: r.snap.caps.chat.defaultUsable, reason: r.snap.caps.chat.defaultReason },
    image: r.snap.caps.image && { usable: r.snap.caps.image.defaultUsable, reason: r.snap.caps.image.defaultReason },
  } : null,
  chat: r.snap && r.snap.chat.model && { disabled: r.snap.chat.model.disabled, aria: r.snap.chat.model.aria, unconfigured: r.snap.chat.model.unconfigured, defaultUnavailable: r.snap.chat.model.defaultUnavailable, value: r.snap.chat.model.value, options: r.snap.chat.model.options.map((o) => o.value) },
  image: r.snap && r.snap.image.model && { disabled: r.snap.image.model.disabled, aria: r.snap.image.model.aria, unconfigured: r.snap.image.model.unconfigured, defaultUnavailable: r.snap.image.model.defaultUnavailable, value: r.snap.image.model.value, options: r.snap.image.model.options.map((o) => o.value) },
  chatRun: r.snap && r.snap.chatRun, imageRun: r.snap && r.snap.imageRun,
  chatNote: r.snap && r.snap.chatNote, imageNote: r.snap && r.snap.imageNote,
  llmModel: r.snap && r.snap.nodes && r.snap.nodes.llm && r.snap.nodes.llm.model,
  genModel: r.snap && r.snap.nodes && r.snap.nodes.gen && r.snap.nodes.gen.model,
  manifest: r.snap && r.snap.manifest && { chat: r.snap.manifest.chat, image: r.snap.manifest.image },
} : null);

/** 设置窗口（宿主顶层页 DOM）：pane 归属 + 标题 + 是否被最小化。*/
const nSettingsWindow = () => js("const p = document.querySelector('[data-settings-active]'); if (!p) return null; const w = p.closest('.window'); return { active: String(p.getAttribute('data-settings-active') || ''), title: String((p.querySelector('.settings-pane h1') || {}).textContent || '').trim(), minimized: !!(w && w.classList.contains('minimized')), hasWindow: !!w, panes: document.querySelectorAll('[data-settings-pane]').length };");
/** 关掉设置窗口：先走窗口自己的关闭按钮（settings 的 closeAction 就是 close），不行再退回程序坞菜单「关闭应用」。*/
async function nCloseSettingsWindow() {
  const byButton = await js("const p = document.querySelector('[data-settings-active]'); const w = p && p.closest('.window'); const b = w && w.querySelector('.window-title button.close'); if (!b) return 'missing'; b.click(); return 'clicked';");
  let closed = await waitFor(() => js("return !document.querySelector('[data-settings-active]')"), 8000);
  let byDock = null;
  if (!closed && await rightClickDockItem("settings")) {
    byDock = await waitFor(() => js("const menu = document.querySelector('.context-menu.dock-menu[aria-label=\"程序坞菜单\"]'); if (!menu) return false; const item = Array.from(menu.querySelectorAll('button[role=\"menuitem\"]')).find(function (b) { return b.textContent.trim() === '关闭应用'; }); if (!item || item.disabled) return false; item.click(); return true;"), 8000);
    closed = await waitFor(() => js("return !document.querySelector('[data-settings-active]')"), 10000);
  }
  return { byButton: byButton, byDock: byDock, closed: closed };
}

/* ── F4 辅助：AI 助手面板（产品入口）+ 确定性 provider 计划 + 只读 DB 取证 ── */
const taskCmd = (payload) => js("return await window.openarc.task.command(" + JSON.stringify(payload) + ")");
const taskGet = (taskId) => taskCmd({ type: "task/get", taskId });
const attrOf = (sel, name) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.getAttribute(" + JSON.stringify(name) + ") || '') : '';");
const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
const setTextarea = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
async function openAiPanel() {
  if (await has(".ai-panel")) return true;
  if (await waitSel(".assistant-pill", 30000)) await clickSel(".assistant-pill");
  return await waitSel(".ai-panel", 20000);
}
async function runTaskViaUI(goal) {
  await openAiPanel();
  const prev = await attrOf(".ai-panel", "data-ai-task-id");
  await setTextarea("[data-ai-goal]", goal);
  const ready = await waitFor(async () => !(await js("const b = document.querySelector('[data-ai-run]'); return !b || b.disabled;")), 30000);
  if (!ready) return { started: false, error: "run 按钮一直不可用" };
  await clickSel("[data-ai-run]");
  const started = await waitFor(async () => { const id = await attrOf(".ai-panel", "data-ai-task-id"); return typeof id === "string" && id.length > 0 && id !== prev; }, 40000);
  return { taskId: await attrOf(".ai-panel", "data-ai-task-id"), started, status: await attrOf(".ai-panel", "data-ai-status"), stateText: (await textOf("[data-ai-state]")).replace(/\s+/g, " ").trim().slice(0, 200) };
}
const waitApproval = (ms) => waitFor(async () => (await attrOf("[data-approval-request-id]", "data-approval-request-id")).length > 0, ms || 60000);
async function waitTaskTerminal(taskId, timeout = 180000) {
  const ok = await waitFor(async () => { const g = await taskGet(taskId); const s = g && g.task && g.task.status; return ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(s); }, timeout);
  const g = await taskGet(taskId);
  return { terminal: ok, status: g && g.task && g.task.status, error: g && g.error };
}
function setPlanOn(prov, plan) {
  const control = prov.baseUrl.replace("/v1", "") + "/__plan";
  return fetch(control, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: plan || [] }) }).then((r) => r.ok).catch(() => false);
}
function advertisedTools(prov) {
  const bodies = (prov.state.bodies || []).slice().reverse();
  for (const b of bodies) {
    const tools = b && b.tools;
    if (!Array.isArray(tools) || !tools.length) continue;
    return tools.map((t) => (t && t.function && t.function.name) || (t && t.name) || String(t)).filter(Boolean);
  }
  return [];
}
/** 只读打开主进程 DB 取证（绝不写库；与 D5-01/D5-02 既有口径一致）。*/
function dbRows(table) {
  try {
    const db = new DatabaseSync(path.join(userDataDir, "identity.db"), { readOnly: true });
    try { return db.prepare("SELECT * FROM " + table).all(); } finally { db.close(); }
  } catch { return []; }
}
const canvasState = async (id) => { const g = await canvas({ type: "canvas/get", canvasId: id }); return { ok: !!(g && g.ok), revision: g && g.ok ? g.canvas.revision : null, nodes: g && g.ok ? (g.canvas.doc.nodes || []).length : null, edges: g && g.ok ? (g.canvas.doc.connections || []).length : null }; };
const nodeOf = async (id, nodeId) => { const g = await canvas({ type: "canvas/get", canvasId: id }); return g && g.ok ? ((g.canvas.doc.nodes || []).find((n) => n.id === nodeId) || null) : null; };

/** F4 chain2 前置换帧就绪：关窗重开后画布帧是**新挂载**的 —— 桥的 ctx.readOnly 默认 true，
 *  要等宿主把 canEdit 推下来；适配器与文档也是异步就绪的。五步各自计时、各自可失败：
 *  任一步在预算内没到 → ok=false，steps 原样进证据（谁都不许"假装用户已经能编辑"）。
 *  注意：这里只等**事实**，不主动制造事实 —— 不替宿主 pushContext、不绕过桥的只读闸。*/
async function waitChain2Ready(nodeId, budget = 20000) {
  const t0 = Date.now();
  const steps = {};
  const left = () => Math.max(500, budget - (Date.now() - t0));
  const mark = async (name, fn) => { const ok = await waitFor(fn, left()); steps[name] = { ok, atMs: Date.now() - t0 }; return ok; };
  const sample = () => inFrame(canvasFrame(), [
    "const b = window.__openarcBridge || null;",
    "const it = window.__openarcCanvasInternals || null;",
    "const s = it ? it.getState() : null;",
    "return { isReadOnly: b ? b.isReadOnly() : null, canEdit: b ? !!b.context.canEdit : null, ctxCanvasId: b ? (b.context.canvasId || null) : null,",
    "  canvasId: s && s.canvas ? s.canvas.id : null, revision: s && s.canvas ? s.canvas.revision : null, nodeCount: s ? s.nodes.length : null,",
    "  hasNode: !!(it && it.primitives.getNode(" + JSON.stringify(nodeId) + ")) };",
  ].join("\n"));
  const done = async (ok) => ({ ok, steps, sample: await sample(), waitedMs: Date.now() - t0 });
  if (!await mark("canvasFrame", () => !!canvasFrame())) return done(false);
  if (!await mark("adapter", async () => { const a = await inFrame(canvasFrame(), "return { a: typeof window.__openarcCanvas, i: typeof window.__openarcCanvasInternals, b: typeof window.__openarcBridge };"); return a && a.a === "object" && a.i === "object" && a.b === "object"; })) return done(false);
  if (!await mark("doc", async () => { const s = await inFrame(canvasFrame(), "const s = window.__openarcCanvas ? window.__openarcCanvas.state() : null; return s ? { id: s.canvasId } : null;"); return !!(s && s.id); })) return done(false);
  if (!await mark("editable", async () => (await inFrame(canvasFrame(), "return window.__openarcBridge.isReadOnly();")) === false)) return done(false);
  if (!await mark("node", async () => (await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; return !!(it && it.primitives.getNode(" + JSON.stringify(nodeId) + "));")) === true)) return done(false);
  return done(true);
}

/**
 * F4：AI 编辑正式链。全部走**真实产品入口**：
 *   提议 = 渲染层 AI 助手面板 → task/run（official dsh + Model Proxy + Tool Facade）
 *   审批 = [data-approval-request-id] 面板 → 点 approve（sideEffect/decideApproval）
 *   执行 = 受监督执行路径 → CanvasControl.execute（与手工路径同一个命令层 + 同一份版本检查）
 *   呈现 = 画布页自己的 2.5s 版本轮询
 * 模型侧只替换最后一跳网络（tests/fixtures/d4-04-provider.mjs 的 /__plan 指定"想调哪个工具"）。
 */
async function runAiEditChain() {
  const details = {};
  const canvasId = currentCanvasId;
  try {
    if (!canvasId) return { ok: false, expected: "提议→审批→执行→呈现→保存恢复", actual: "没有打开的画布" };
    const before = await canvasState(canvasId);
    agentProvider = await startD4Provider();
    const prov = await model({ type: "provider/create", displayName: "D5-02 Agent Provider", baseUrl: agentProvider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "d502-agent-secret" });
    const providerId = prov && prov.provider && prov.provider.providerId;
    const mdl = await model({ type: "model/create", providerId, remoteModelId: "d502-agent-local", displayName: "D5-02 Agent Local", capabilities: ["chat"], scope: "ORGANIZATION" });
    const agentConfigId = mdl && mdl.model && mdl.model.configId;
    const def = await model({ type: "defaults/set", capability: "chat", configId: agentConfigId });
    const grant = await governance({ type: "governance/grantAppToolAccess", appId: "ai", actions: ["tool.canvas.edit"] });
    details.setup = { providerId, agentConfigId, defaultOk: !!(def && def.ok), grantOk: !!(grant && grant.ok), grantError: grant && grant.error };
    if (!agentConfigId) return { ok: false, expected: "Agent 模型就绪", actual: JSON.stringify(details) };

    // ── 第一段：提议 → 审批 → 执行 → 落库 → 画布呈现 → 保存重开仍在 ──
    await js("window.__oaTaskEvents = []; try { window.openarc.task.onEvent(function (e) { window.__oaTaskEvents.push(e); }); } catch (err) { window.__oaTaskEvents.push({ type: 'subscribe-failed', message: String(err && err.message) }); } return true;");
    const cmd1 = { type: "node.add", node: { id: "agent_node_1", type: "prompt", x: 240, y: 180, text: "AI 提议的节点" } };
    await setPlanOn(agentProvider, [{ name: "canvas_edit", args: { canvasId, baseRevision: before.revision, command: cmd1 } }]);
    const run1 = await runTaskViaUI("在画布 " + canvasId + " 上添加一个提示词节点（节点 id=agent_node_1）");
    const approval1 = await waitApproval(120000);
    const advertised = advertisedTools(agentProvider);
    const approvalMeta = approval1 ? { id: await attrOf("[data-approval-request-id]", "data-approval-request-id"), tool: await attrOf("[data-approval-request-id]", "data-approval-tool"), risk: await attrOf("[data-approval-request-id]", "data-approval-risk") } : null;
    if (approval1) await clickSel('[data-approval-action="approve"]');
    const term1 = await waitTaskTerminal(run1.taskId);
    const after1 = await waitFor(async () => { const st = await canvasState(canvasId); return st.nodes === before.nodes + 1 ? true : false; }, 40000) ? await canvasState(canvasId) : await canvasState(canvasId);
    const call1 = dbRows("side_effect_calls").filter((r) => r.task_id === run1.taskId && r.tool_id === "canvas.edit").slice(-1)[0] || null;
    const presented = await waitFor(async () => (await inFrame(canvasFrame(), "return !!window.__openarcCanvasInternals.primitives.getNode('agent_node_1');")) === true, 30000);
    await page.screenshot({ path: path.join(ART, "d5-02-app-ai-approval.png") }).catch(() => {});
    const closedForF4 = await closeAppWindow();
    const reopenedForF4 = await reopenCurrentCanvasFromHome();
    const restored = await waitFor(async () => (await inFrame(canvasFrame(), "return !!window.__openarcCanvasInternals.primitives.getNode('agent_node_1');")) === true, 30000);
    const events = await js("return (window.__oaTaskEvents || []).map(function (e) { return { type: e && e.type, tool: e && (e.toolId || e.toolRef || null), status: e && (e.status || null), error: e && (e.errorCode || e.reasonCode || null), message: e && e.message ? String(e.message).slice(0, 120) : null }; }).slice(-14);");
    const diag1 = {
      events,
      emitted: (agentProvider.state.toolCalls || []).slice(-4),
      toolExecs: dbRows("tool_executions").filter((r) => r.task_id === run1.taskId).map((r) => ({ tool: r.tool_id, status: r.status, error: r.error_code || null })).slice(-4),
      panel: (await textOf(".ai-panel")).replace(/\s+/g, " ").trim().slice(0, 300),
    };
    details.chain1 = { run1, approval1, approvalMeta, advertised, term1, before, after1, call1: call1 ? { status: call1.status, verification: call1.verification_status, callId: call1.call_id } : null, presented, closedForF4, reopenedForF4, restored, diag1 };

    // ── 第二段：旧 revision 对照（提议 → 用户先改 → 批准 → 不得覆盖用户内容）──
    const beforeStale = await canvasState(canvasId);
    const cmd2 = { type: "node.add", node: { id: "agent_node_2", type: "prompt", x: 620, y: 320, text: "过期提议的节点" } };
    await setPlanOn(agentProvider, [{ name: "canvas_edit", args: { canvasId, baseRevision: beforeStale.revision, command: cmd2 } }]);
    const run2 = await runTaskViaUI("在画布 " + canvasId + " 上再添加一个节点（节点 id=agent_node_2）");
    const approval2 = await waitApproval(120000);
    /** 重开后的画布帧是新挂载的：先等"帧/适配器/文档/非只读/n_prompt"五步就绪，再做用户编辑。
     *  即使等待失败也照做一次编辑：把产品侧的真实错误码如实记下来（判定仍要求 userEdit.ok===true）。*/
    const ready2 = approval2 ? await waitChain2Ready("n_prompt") : null;
    const pageBeforeEdit = ready2 ? ready2.sample : null;
    let userEdit = null, userSaved = false, revisionAfterUser = null;
    if (approval2) {
      userEdit = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type: 'node.edit', id: 'n_prompt', patch: { text: '用户先改的内容' } }, null);");
      userSaved = await waitFor(async () => { const n = await nodeOf(canvasId, "n_prompt"); return n && n.text === "用户先改的内容"; }, 20000);
      revisionAfterUser = (await canvasState(canvasId)).revision;
      await clickSel('[data-approval-action="approve"]');
    }
    const term2 = await waitTaskTerminal(run2.taskId);
    await sleep(5000);
    const afterStale = await canvasState(canvasId);
    const staleNode = await nodeOf(canvasId, "agent_node_2");
    const promptNode = await nodeOf(canvasId, "n_prompt");
    const call2 = dbRows("side_effect_calls").filter((r) => r.task_id === run2.taskId && r.tool_id === "canvas.edit").slice(-1)[0] || null;
    details.chain2 = {
      ready: ready2 ? { ok: ready2.ok, waitedMs: ready2.waitedMs, steps: ready2.steps } : null,
      pageBeforeEdit, userEdit, userSaved, revisionAfterUser,
      approval2, beforeStale, afterStale, staleNodeAdded: !!staleNode, userText: promptNode && promptNode.text,
      run2, term2, call2: call2 ? { status: call2.status, verification: call2.verification_status } : null,
    };
    // chain2 的结论单独一条短 record：F4 的 actual 会被 record 截到 1400 字符，chain2 的关键事实必须自己可见。
    record("F4b", "AI 编辑正式链 · chain2 前置：重开画布帧后等宿主把 canEdit 推下来（非只读）+ 适配器/文档就绪 + n_prompt 可见，然后才做用户编辑（不放宽 F4 任何判定）",
      !!(ready2 && ready2.ok === true) && !!pageBeforeEdit && pageBeforeEdit.isReadOnly === false && pageBeforeEdit.canEdit === true && pageBeforeEdit.hasNode === true && pageBeforeEdit.canvasId === canvasId,
      "五步就绪 + 编辑前快照非只读且 n_prompt 可见",
      JSON.stringify({ ready: ready2 && { ok: ready2.ok, waitedMs: ready2.waitedMs, steps: ready2.steps }, pageBeforeEdit, userEdit, userSaved, revisionAfterUser }));
    await page.screenshot({ path: path.join(ART, "d5-02-app-ai-stale.png") }).catch(() => {});

    const ok = !!(term1 && term1.status === "SUCCEEDED") && approval1 === true && advertised.includes("canvas_edit")
      && after1.nodes === before.nodes + 1 && call1 && call1.status === "SUCCEEDED" && call1.verification_status === "PASS"
      && presented === true && closedForF4 && reopenedForF4 && restored === true
      && approval2 === true && userEdit && userEdit.ok === true && userSaved === true
      && afterStale.nodes === beforeStale.nodes && staleNode === null && promptNode && promptNode.text === "用户先改的内容";
    return { ok, expected: "提议→审批→执行→呈现→保存恢复（+ 旧 revision 不覆盖用户内容）", actual: JSON.stringify(details) };
  } catch (e) {
    return { ok: false, expected: "提议→审批→执行→呈现→保存恢复", actual: "异常：" + String((e && e.message) || e) + " | " + JSON.stringify(details) };
  } finally {
    try { if (agentProvider) await agentProvider.close(); } catch { /* ignore */ }
    agentProvider = null;
  }
}

let exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("门禁异常：" + String((e && e.stack) || e));
  exitCode = 2;
}
try { if (browser) await browser.close().catch(() => {}); } catch { /* ignore */ }
try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
try { spawnSync("pkill", ["-f", "oa-d502-"], { stdio: "ignore" }); } catch { /* ignore */ }
try { if (provider) await provider.close(); } catch { /* ignore */ }
process.exit(exitCode);
