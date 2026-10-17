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
/** 随经典编辑器移除而删除的用例/子断言：编号 + 原意图 + 删除原因 + 替代覆盖。门禁末尾必须显式打印并写进 JSON。*/
const DELETED_CASES = [
  {
    id: "N2",
    original: "页头引导按钮 [data-openarc-open-model-settings] 真实点击 → 宿主打开「模型与服务商」设置窗口",
    reason: "智能画布守卫 v3 没有页头状态位，也没有「打开 OpenArc 总 API 设置」入口；该 DOM 契约只存在于经典 openarc-canvas-guard.js，写范围不允许改 public/novai-canvas/** 补契约",
    coverage: "无等价替代（设置入口不存在）。最接近：N1（未配置事实面/占位）、D1（撤权后调用级明确拒绝）、E2c/E3（适配器与未接通能力仍工作）",
  },
  {
    id: "N5c",
    original: "跨能力（生图默认被指到只有 chat 的模型）→ 生图区按「显式默认不可用」呈现（data-openarc-default-unavailable=image-generation + 原因/引导 + select.value 为空 = 不自动换模型）",
    reason: "智能画布不消费 /api/config.capabilities.defaultUsable/defaultReason，没有 default-unavailable 呈现契约；实测页面会按清单自动选中另一个可用生图模型（见 productGaps）",
    coverage: "宿主层等价语义仍由 D2 覆盖（canvas/run kind=image → CAPABILITY_UNAVAILABLE + provider 0 新增请求）；页面侧「不换模型」缺口如实登记在 productGaps",
  },
  {
    id: "N5d",
    original: "停用显式文本默认 → 文本区按「默认不可用」呈现（data-openarc-default-unavailable=chat + select.value 为空 + 不自动改用剩下的模型）",
    reason: "同上：智能画布没有 default-unavailable 呈现契约；实测停用后页面会按清单自动选中另一个可用 chat 模型（见 productGaps）",
    coverage: "F1 仍逐项证明宿主对停用/跨能力/不存在配置明确拒绝且 0 新增请求（不静默换模型的服务端真源）",
  },
  {
    id: "N3·节点徽标",
    original: "视频节点带 data-openarc-capability / data-openarc-available=false 的节点级可用性徽标（且节点说明不给误导性引导）",
    reason: "节点级 capability/available 契约只在经典守卫里有；智能画布没有节点徽标（页面侧事实面改为 __openarcSmartGuard.facts()）",
    coverage: "N3 用守卫事实面 video available=false/transport=null + 创建入口/engine option 禁用 + 选中视频节点后 #runBtn data-openarc-blocked=video-generation 覆盖同一语义",
  },
  {
    id: "F3e·同字段副本",
    original: "同一节点同一字段被两侧同时改动时，本地版本原位保留、远端版本以 <id>-remote 副本保留，且冲突计数 ≥2",
    reason: "智能画布没有 <id>-remote 副本语义与 conflictLog 证据面；其原生 409 合并（applyMergedServerCanvas）只保证节点并集，同字段按合并规则取一方",
    coverage: "F3e 保留「同一 500ms 窗口不同节点两边都保留（页面+DOM+IPC+重开）」；同字段副本由 D1/F4 的 revision 校验链覆盖「不静默覆盖用户内容」的服务端一侧",
  },
  {
    id: "F3f",
    original: "AI 新增节点（命令账本 actorKind=AGENT）带中性 AI 来源标记 + 160ms cubic-bezier(.2,0,0,1) 淡入；减少动态效果下 animation:none；用户手工新增不误标",
    reason: "标记/淡入由 canvas-ai-marks.js 提供且只服务经典 renderNode；智能画布 render() 整层重建节点，未移植该能力（无 .openarc-ai-badge / 无 aiMarks 证据面）",
    coverage: "F4（AI 编辑正式链）证明 agent 节点真的落画布并可保存重开；动效本身无等价替代，缺口如实登记",
  },
];
const productGaps = [];
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
/** bundle 请求失败（>=400 或加载失败），只统计 openarc-canvas://bundle/ 下的资源。E4 用它在伪造帧加载窗口内数 404。 */
const netFails = [];
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
/** 智能画布编辑器帧（唯一编辑器）：入口帧在**同一个宿主帧内**导航到 smart-canvas.html?id=…&project=…。
 *  传统编辑器 static/canvas.html 已随重新 vendor 删除，门禁不再有第二个编辑器帧可指。*/
const smartFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/smart-canvas\.html/);
/** 「应用页」= 当前加载的应用帧。入口页与编辑器是同一个宿主帧在不同时刻的 URL：停在编辑器时
 *  canvas-list 帧已经不存在，所以需要"应用页自证"的探针（无桥 / 账号存储 / 宿主端点）必须按当前页取帧，
 *  否则会退化成 __noFrame 的空断言。入口页优先。*/
const shellFrame = () => listFrame() || smartFrame();
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
  const childEnv = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  // 本仓库环境 ELECTRON_RUN_AS_NODE=1 会把 Electron 当普通 Node 跑（app 未定义、CDP 不启动），必须摘掉；
  // 与 experiments/dxos-canvas-prune/real-device-canvas.mjs 同一约定。
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  // 界面页 = 当前默认壳 dist/vue.html（electron/main.cjs 默认加载；OA_UI=react 才回 dist/index.html）。
  // 两种都接受，但**都找不到时必须显式报错**，不能静默跳过（否则测试绿但其实没跑到界面）。
  const end = Date.now() + 40000;
  const uiVue = /[\\/]dist[\\/]vue\.html/;
  const uiIndex = /[\\/]dist[\\/]index\.html/;
  while (!page && Date.now() < end) {
    const pages = ctx.pages();
    page = pages.find((p) => uiVue.test(p.url())) || pages.find((p) => uiIndex.test(p.url())) || null;
    if (!page) await sleep(300);
  }
  if (!page) throw new Error("未找到界面页面（优先 dist/vue.html，回退 dist/index.html）；当前 pages=" + JSON.stringify(ctx.pages().map((p) => p.url())));
  page.on("dialog", (d) => { dialogs.push(String(d.message()).slice(0, 140)); void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror:" + String(e.message).slice(0, 200)));
  // bundle 资源失败留证（Playwright 页面事件覆盖**子帧 / OOPIF**，CDP 页面会话看不到沙箱伪造帧的请求）。
  const isBundleUrl = (u) => String(u).indexOf("openarc-canvas://bundle/") === 0;
  page.on("response", (r) => { if (isBundleUrl(r.url()) && r.status() >= 400) netFails.push({ status: r.status(), url: r.url() }); });
  page.on("requestfailed", (r) => { if (isBundleUrl(r.url())) netFails.push({ status: 0, errorText: r.failure() ? r.failure().errorText : "", url: r.url() }); });
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
/** Vue 壳层（默认 dist/vue.html）：程序坞右键菜单已下线，关闭非 settings 窗口的产品入口是
 *  顶栏「文件 → 关闭窗口」（TopBar close → window/close）——与 React 的「右键程序坞图标 → 关闭应用」
 *  同一条语义（销毁窗口，不是最小化）。*/
async function closeAppWindowViaMenuBar() {
  const opened = await js("const b = Array.from(document.querySelectorAll('.topbar-menus .bar-menu')).find(function (x) { return x.textContent.trim() === '文件'; }); if (!b) return false; b.click(); return true;");
  if (opened !== true) return false;
  const clicked = await waitFor(() => js(
    "const menu = document.querySelector('.context-menu[role=\"menu\"]'); if (!menu) return false;" +
    "const item = Array.from(menu.querySelectorAll('button[role=\"menuitem\"]')).find(function (b) { return (b.querySelector('.menu-label') || b).textContent.trim() === '关闭窗口'; });" +
    "if (!item || item.disabled) return false;" +
    "item.click(); return true;",
  ), 8000);
  if (!clicked) return false;
  return await waitFor(() => allBundleFrames().length === 0, 15000);
}
async function closeAppWindow() {
  if (await has(".topbar-menus .bar-menu")) return await closeAppWindowViaMenuBar();
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
 *  新形态里入口页 canvas-list 与编辑器 smart-canvas 是同一个宿主帧：若此刻还停在编辑器（例如上一次
 *  导航被拦、宿主没有整帧重置），先按产品路径点 .smart-back（智能画布的「返回画布列表」）回列表，
 *  再点卡片进编辑器。卡片实现（public/novai-canvas/static/canvas-list.html:1310-1322）：
 *  .project-card[data-canvas-id] 由 addEventListener 绑定 click → openCanvas(c) → /static/smart-canvas.html?id=…。*/
async function reopenCurrentCanvasFromHome() {
  const opened = await openAppWindow();
  if (!opened) return false;
  if (!listFrame() && smartFrame()) {
    await inFrame(smartFrame(), "const el = document.querySelector('.smart-back'); if (!el) return 'missing'; el.click(); return 'clicked';");
    await waitFor(() => !!listFrame() && !smartFrame(), 30000);
  }
  const listUp = await waitFor(() => !!listFrame(), 25000);
  const cardSel = "#cardsGrid .project-card[data-canvas-id=\"" + currentCanvasId + "\"]";
  const cardUp = listUp && await waitFor(async () => (await inFrame(listFrame(), "return !!document.querySelector(" + JSON.stringify(cardSel) + ");")) === true, 20000);
  const clicked = cardUp ? await inFrame(listFrame(), "const el = document.querySelector(" + JSON.stringify(cardSel) + "); if (!el) return 'missing'; el.click(); return 'clicked';") : "missing";
  const up = await waitFor(() => !!smartFrame(), 35000);
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
  // 重新 vendor 后 smart-canvas 是**唯一编辑器**：它只能从卡片/新建/继续上次进入，不是"列表页里的子页导航"，
  // 因此从本清单移除（旧清单把它当被裁掉的子页；再列就自相矛盾）。其余 5 个子页仍必须 0 命中。
  const SUBPAGES = ["online", "gpt-chat", "asset-manager", "api-settings", "comfyui-settings"];
  const entryNav = await inFrame(listFrame(), "const routes = " + JSON.stringify(SUBPAGES) + "; const els = Array.from(document.querySelectorAll('a,button,iframe,[onclick],[data-route],[data-src],[data-page],[data-href]')); const hits = []; els.forEach(function (el) { const attrs = Array.from(el.attributes || []).map(function (a) { return a.name + '=' + a.value; }).join(' ').toLowerCase(); routes.forEach(function (rt) { if (attrs.indexOf(rt) >= 0) hits.push({ tag: el.tagName, route: rt, attrs: attrs.slice(0, 120) }); }); }); const ids = ['frame-home','frame-online','frame-gpt-chat','frame-canvas','frame-asset-manager','frame-api-settings','frame-comfyui-settings']; return { hits: hits.slice(0, 5), hitCount: hits.length, navFrameIds: ids.filter(function (id) { return !!document.getElementById(id); }), iframes: document.querySelectorAll('iframe').length };");
  const subFrames = page.frames().filter((f) => /\/static\/(online|gpt-chat|asset-manager|api-settings|comfyui-settings)\.html/.test(f.url())).map((f) => String(f.url()));
  record("A2", "其他子页面入口不可达：入口页没有指向 online/gpt-chat/asset-manager/api-settings/comfyui-settings 的导航，也不存在这些子页帧（smart-canvas 是唯一编辑器，不算被裁子页）",
    entryNav.hitCount === 0 && entryNav.iframes === 0 && entryNav.navFrameIds.length === 0 && subFrames.length === 0,
    "0 个跨页导航入口 + 0 个子页帧", JSON.stringify({ entryNav, subFrames }));

  // A3：列表首页「开始创作」→ **直接**进入编辑器；全程不得出现选画布遮挡层 .active
  const pickerSamples = [];
  const pickerTimer = setInterval(async () => {
    try {
      const f = shellFrame();
      if (!f) return;
      const cls = await inFrame(f, "const el = document.getElementById('canvasPickerOverlay'); return el ? String(el.className) : null;");
      pickerSamples.push({ page: /canvas-list\.html/.test(f.url()) ? "list" : "smart", cls: cls === null ? "absent" : String(cls) });
    } catch { /* ignore */ }
  }, 150);
  const listBeforeCreate = ((await canvas({ type: "canvas/list" })).items || []).length;
  const startClick = await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const editorUp = await waitFor(() => !!smartFrame(), 40000);
  const adapterUp = await waitFor(async () => (await inFrame(smartFrame(), "return { i: typeof window.__openarcCanvasInternals, a: typeof window.__openarcCanvas, b: typeof window.__openarcBridge };")).i === "object", 30000);
  // 适配器就绪 ≠ 画布文档已载入：等到 canvasId 真的出现（否则后面所有断言都建在 null 上）
  await waitFor(async () => { const st = await inFrame(smartFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };"); return !!(st && st.id); }, 30000);
  clearInterval(pickerTimer);
  const pickerActive = pickerSamples.filter((s) => /(^|\s)active(\s|$)/.test(s.cls));
  const canvasState0 = await inFrame(smartFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, edges: s.edgeCount, ro: window.__openarcBridge.isReadOnly() };");
  currentCanvasId = canvasState0.id || null;
  const listAfterCreate = ((await canvas({ type: "canvas/list" })).items || []).length;
  record("A3", "「开始创作」→ 直接进入智能画布编辑器（smart-canvas.html + 适配器就绪 + 非只读），且真的新建了一本；全程选画布遮挡层 #canvasPickerOverlay 未出现 .active",
    startClick === "clicked" && editorUp && adapterUp && !!currentCanvasId && canvasState0.ro === false && listAfterCreate === listBeforeCreate + 1 && pickerActive.length === 0,
    "编辑器帧 + 非只读 + 新建 1 本 + 遮挡层未激活", JSON.stringify({ startClick, editorUp, adapterUp, canvasState0, listBeforeCreate, listAfterCreate, pickerSamples: pickerSamples.slice(0, 8), pickerActive: pickerActive.slice(0, 3) }));

  // A4：编辑器 .smart-back（智能画布的「返回画布列表」）→ 回到 canvas-list 入口帧（同一个宿主帧内导航）
  const backClick = await inFrame(smartFrame(), "const el = document.querySelector('.smart-back'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const backToList = await waitFor(() => !!listFrame() && !smartFrame(), 30000);
  const backInfo = await inFrame(listFrame(), "return { title: document.title, grid: !!document.getElementById('cardsGrid'), start: !!document.getElementById('btnStartCreate') };");
  record("A4", "编辑器 .smart-back → 回到 canvas-list 入口帧（同一宿主帧内导航：返回后画布帧不再存在）",
    backClick === "clicked" && backToList && backInfo.title === "画布工作台" && backInfo.grid === true && backInfo.start === true,
    "回入口帧 + 画布帧消失", JSON.stringify({ backClick, backToList, backInfo }));

  // A5：「继续上次」= 打开最近更新的那本（与宿主 canvas/list 的 updatedAt 第一名对照）
  const ipcList = (await canvas({ type: "canvas/list" })).items || [];
  const latest = ipcList.slice().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
  // 「继续上次」读的是页面自己的画布清单：等卡片渲染出来（页面数据到位）再点，否则会走"没有画布→新建"分支
  const listReadyForContinue = await waitFor(async () => (await inFrame(listFrame(), "return document.querySelectorAll('#cardsGrid .project-card').length;")) > 0, 20000);
  const continueClick = await inFrame(listFrame(), "const el = document.getElementById('btnContinueLast'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const contUp = await waitFor(() => !!smartFrame(), 40000);
  const contReady = contUp && await waitFor(async () => { const st = await inFrame(smartFrame(), "const s = window.__openarcCanvas ? window.__openarcCanvas.state() : null; return s ? { id: s.canvasId } : null;"); return !!(st && st.id); }, 30000);
  const contId = contReady ? (await inFrame(smartFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };")).id : null;
  const contDoc = contId ? await canvas({ type: "canvas/get", canvasId: contId }) : null;
  record("A5", "「继续上次」→ 进入 smart-canvas.html 且打开的正是最近更新的那本（宿主 IPC canvas/list 的 updatedAt 第一名，也就是刚创建的这本）",
    listReadyForContinue && continueClick === "clicked" && contUp && !!contId && !!latest && contId === latest.canvasId && contId === currentCanvasId && !!(contDoc && contDoc.ok),
    "smart-canvas.html + 最近更新那本", JSON.stringify({ listReadyForContinue, continueClick, contUp, openedId: contId, latest: latest ? { canvasId: latest.canvasId, updatedAt: latest.updatedAt } : null, currentCanvasId, ipcCount: ipcList.length }));

  // A6：卡片直达（上游卡片实现：.project-card[data-canvas-id] → openCanvas → smart-canvas.html?id=）
  await inFrame(smartFrame(), "const el = document.querySelector('.smart-back'); if (el) el.click(); return !!el;");
  const backForCard = await waitFor(() => !!listFrame() && !smartFrame(), 30000);
  const cardSel = "#cardsGrid .project-card[data-canvas-id=\"" + currentCanvasId + "\"]";
  const cardUp = backForCard && await waitFor(async () => (await inFrame(listFrame(), "return !!document.querySelector(" + JSON.stringify(cardSel) + ");")) === true, 20000);
  const cardClick = cardUp ? await inFrame(listFrame(), "const el = document.querySelector(" + JSON.stringify(cardSel) + "); if (!el) return 'missing'; el.click(); return 'clicked';") : "missing";
  const cardUpFrame = await waitFor(() => !!smartFrame(), 40000);
  const cardReady = cardUpFrame && await waitFor(async () => { const st = await inFrame(smartFrame(), "const s = window.__openarcCanvas ? window.__openarcCanvas.state() : null; return s ? { id: s.canvasId } : null;"); return !!(st && st.id); }, 30000);
  const cardId = cardReady ? (await inFrame(smartFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };")).id : null;
  record("A6", "卡片直达：入口页 #cardsGrid .project-card[data-canvas-id=当前这本] → 进入编辑器且 canvasId 一致（真实卡片点击，不是 IPC 造帧）",
    cardClick === "clicked" && cardUpFrame && cardId === currentCanvasId,
    "卡片点击 → 同一本", JSON.stringify({ cardSel, backForCard, cardUp, cardClick, cardUpFrame, cardId, currentCanvasId }));

  const addA = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_prompt', type:'prompt', x:80, y:120, text:'D5-02 提示词节点' } }, null);");
  const addB = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_llm', type:'llm', x:420, y:120, model:'', systemPrompt:'You are a helpful assistant.' } }, null);");
  const link = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_llm' }, null);");
  const moved = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.move', id:'n_llm', x:520, y:180 }, null);");
  const savedOk = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
    const nodes = got && got.ok ? got.canvas.doc.nodes : [];
    return nodes.length === 2 && got.canvas.doc.connections.length === 1 && Number(nodes.find((n) => n.id === "n_llm").x) === 520;
  }, 20000);
  const stored = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  record("A7", "创建并编辑真实项目：命令层 add/connect/move → 画布自动保存 → OpenArc 存储里一致",
    !!(addA.ok && addB.ok && link.ok && moved.ok) && savedOk,
    "2 节点 + 1 连线 + 坐标 520", JSON.stringify({ ok: [addA.ok, addB.ok, link.ok, moved.ok], savedOk, revision: stored.canvas.revision, nodes: stored.canvas.doc.nodes.map((n) => ({ id: n.id, x: n.x })), edges: stored.canvas.doc.connections.length }));

  const undoState = await inFrame(smartFrame(), "window.__openarcCanvas.undo(); await new Promise(r=>setTimeout(r,500)); const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { x: n.x, canRedo: window.__openarcCanvas.canRedo() };");
  const redoState = await inFrame(smartFrame(), "window.__openarcCanvas.redo(); await new Promise(r=>setTimeout(r,500)); const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { x: n.x };");
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
   * 此刻 /api/config.api_providers = 0、chat/image 清单为空、视频传输未接通 —— 正是"无模型契约"的状态点。
   * 智能画布契约（openarc-smart-adapter.js + 注入守卫 window.__openarcSmartGuard v3）：
   *   · 单一真源事实面 = facts()（available / configured / transport / reason）；
   *   · 未配置的对话模型下拉 = #chatModelSelect（disabled + aria-disabled + 唯一占位「未配置」）；
   *   · 未接通引擎 = #engineSelect 的 option[disabled] + data-openarc-unavailable；视频入口 = #createMenu [data-create-type=video]；
   *   · 经典编辑器的页头状态位 / 引导按钮 / 节点级 capability 徽标**没有移植**（删除登记见 DELETED_CASES）。*/
  const n1 = await inFrame(smartFrame(), [
    "const q = (sel) => document.querySelector(sel);",
    "const facts = window.__openarcSmartGuard ? window.__openarcSmartGuard.facts() : null;",
    "const chatSel = q('#chatModelSelect');",
    "const dyn = q('#dynamicParams');",
    "const platform = q('#unifiedPlatformControl');",
    "const videoBtn = q('#createMenu [data-create-type=\"video\"]');",
    nFakeScanLines(N_FAKE_PROVIDER_RE).join("\n"),
    "const sel = (el) => el ? { disabled: !!el.disabled, aria: el.getAttribute('aria-disabled'), value: String(el.value), options: Array.prototype.map.call(el.options || [], function (o) { return { value: String(o.value), text: String(o.textContent).trim() }; }) } : null;",
    "const engineOptions = Array.prototype.map.call(document.querySelectorAll('#engineSelect option'), function (o) { return { value: o.value, disabled: !!o.disabled, mark: o.getAttribute('data-openarc-unavailable'), title: String(o.title || '') }; });",
    "return { facts: facts,",
    "  chatSelect: sel(chatSel),",
    "  providerPills: dyn ? dyn.querySelectorAll('[data-smart-param=\"provider_id\"]').length : -1,",
    "  modelPills: dyn ? dyn.querySelectorAll('[data-smart-param=\"model\"]').length : -1,",
    "  platformEntries: platform ? Array.prototype.map.call(platform.querySelectorAll('[data-unified-engine]'), function (b) { return { engine: b.getAttribute('data-unified-engine'), id: b.getAttribute('data-unified-id'), text: String(b.textContent).trim() }; }) : null,",
    "  platformText: platform ? String(platform.textContent).replace(/\\s+/g, ' ').trim().slice(0, 120) : null,",
    "  videoBtn: videoBtn ? { disabled: !!videoBtn.disabled, aria: videoBtn.getAttribute('aria-disabled'), mark: videoBtn.getAttribute('data-openarc-unavailable'), title: String(videoBtn.title || '') } : null,",
    "  guardNote: (function () { const n = q('[data-openarc-guard-note=\"video-generation\"]'); return n ? String(n.textContent).trim() : null; })(),",
    "  engineOptions: engineOptions,",
    "  storage: window.__openarcSmartGuard ? window.__openarcSmartGuard.storage() : null,",
    "  fake: fake };",
  ].join("\n"));
  const n1Facts = n1 && n1.facts;
  const n1Engine = (value) => ((n1 && n1.engineOptions) || []).find((o) => o.value === value) || null;
  record("N1", "无模型（配置模型之前）：守卫事实面 chat/image available=true 但 configured=false、video available=false/transport=null；chat 模型下拉 disabled + aria + 唯一占位「未配置」；#engineSelect 的 volcengine/modelscope/comfy/runninghub 四个 option 全 disabled 且各带 data-openarc-unavailable；创建菜单视频节点 disabled + aria + 唯一未接通文案且页头说明可见；provider/model 参数 pill 0 个；平台控件 0 个页面内置引擎；DOM 全文 / option.value / select.value 扫 /comfly/i 0 命中；四把页面记忆键被锁",
    !!n1 && !n1.__noFrame && !n1.__error
      && !!n1Facts && n1Facts.hosted === true && n1Facts.chat && n1Facts.chat.available === true && n1Facts.chat.configured === false
      && n1Facts.image && n1Facts.image.available === true && n1Facts.image.configured === false
      && n1Facts.video && n1Facts.video.available === false && n1Facts.video.transport === null && n1Facts.video.reason === N_VIDEO_TEXT
      && !!n1.chatSelect && n1.chatSelect.disabled === true && n1.chatSelect.aria === "true" && n1.chatSelect.options.length === 1 && n1.chatSelect.options[0].value === "" && n1.chatSelect.options[0].text === "未配置"
      && n1.providerPills === 0 && n1.modelPills === 0 && (n1.platformEntries || []).length === 0
      && !!n1.videoBtn && n1.videoBtn.disabled === true && n1.videoBtn.aria === "true" && n1.videoBtn.mark === "video-generation" && n1.videoBtn.title === N_VIDEO_TEXT
      && n1.guardNote === N_VIDEO_TEXT
      && ["volcengine", "modelscope", "comfy", "runninghub"].every((v) => { const o = n1Engine(v); return !!o && o.disabled === true && !!o.mark; })
      && !!n1Engine("api") && n1Engine("api").disabled === false
      && !!n1.storage && n1.storage.locked === true
      && n1.fake.htmlMatched === false && n1.fake.optionHits.length === 0 && n1.fake.selectHits.length === 0,
    "facts unconfigured + chat 占位 disabled + 4 引擎 option disabled + 视频入口 disabled/文案 + pill 0 + /comfly/i 0 命中 + 记忆键锁",
    JSON.stringify({ facts: n1Facts, chatSelect: n1 && n1.chatSelect, providerPills: n1 && n1.providerPills, modelPills: n1 && n1.modelPills, platform: { entries: n1 && n1.platformEntries, text: n1 && n1.platformText }, videoBtn: n1 && n1.videoBtn, guardNote: n1 && n1.guardNote, engineOptions: n1 && n1.engineOptions, storage: n1 && n1.storage, fake: n1 && n1.fake }));

  /* N2 **随经典编辑器移除而删除**（登记见 DELETED_CASES / console 的「删除用例」段）：
   * 引导按钮 [data-openarc-open-model-settings] 与页头状态位是经典守卫 openarc-canvas-guard.js 的 DOM 契约；
   * 智能画布守卫 v3 只保留 available/configured 事实面，没有页头状态位、没有「打开 OpenArc 总 API 设置」入口。
   * 本批写范围不允许改 public/novai-canvas/**（不能补契约），因此不重指向、也不把断言改弱后算过。*/

  const n3ReqBefore = provider.state();
  const n3AddVid = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_ng_probe_vid', type:'video', x:620, y:900 } }, null);");
  const n3 = await inFrame(smartFrame(), [
    "const vid = document.querySelector('.image-node[data-id=\"n_ng_probe_vid\"]');",
    "if (vid) vid.click();",
    "await new Promise(function (r) { setTimeout(r, 700); });",
    "const runBtn = document.getElementById('runBtn');",
    "const videoBtn = document.querySelector('#createMenu [data-create-type=\"video\"]');",
    "const dyn = document.getElementById('dynamicParams');",
    "const note = document.querySelector('[data-openarc-guard-note=\"video-generation\"]');",
    "const r = await fetch('/api/canvas-video', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) });",
    "let body = null; try { body = await r.json(); } catch (e) { body = { parseError: String(e && e.message), status: r.status }; }",
    "return { status: r.status, body: body,",
    "  card: !!vid,",
    "  runBtn: runBtn ? { blocked: runBtn.getAttribute('data-openarc-blocked'), disabled: !!runBtn.disabled, aria: runBtn.getAttribute('aria-disabled') } : null,",
    "  videoEntry: videoBtn ? { disabled: !!videoBtn.disabled, aria: videoBtn.getAttribute('aria-disabled'), mark: videoBtn.getAttribute('data-openarc-unavailable'), title: String(videoBtn.title || '') } : null,",
    "  videoPills: dyn ? dyn.querySelectorAll('[data-smart-param=\"videoProvider\"],[data-smart-param=\"videoModel\"]').length : -1,",
    "  noteText: note ? String(note.textContent).trim() : null,",
    "  facts: window.__openarcSmartGuard.facts() };",
  ].join("\n"));
  const n3ReqAfter = provider.state();
  const n3HostNotice = await js("const el = document.querySelector('[data-canvas-host]'); return el ? String(el.getAttribute('data-canvas-asset-notice-text') || '') : null;");
  const n3Req = (s) => s.chats.length + s.images.length + s.authSeen;
  // 页面侧守卫在**发出请求之前**就按能力事实回答了：桥的"该功能未接入 OpenArc（保留入口）"分支不该被走到。
  const n3BridgeNotice = /未接入 OpenArc（保留入口）：\/api\/canvas-video/.test(String(n3HostNotice || ""));
  // 视频不可用：创建入口 disabled + 引擎 option disabled + 选中视频节点后运行入口 data-openarc-blocked=video-generation
  // （经典画布的「视频 provider/model 下拉」在智能画布没有对应下拉：宿主投影 video_models=[] ⇒ 0 个可选 pill，比"disabled 的下拉"更强）。
  record("N3", "未接通能力（视频）明确不可用：创建菜单「视频节点」disabled + aria + data-openarc-unavailable=video-generation + 唯一文案；#engineSelect 的 volcengine option 同样 disabled/mark；选中视频节点后运行入口 #runBtn data-openarc-blocked=video-generation + disabled，视频 provider/model pill 0 个（无可选来源）；守卫事实面 video available=false / transport=null；页面内直接 POST /api/canvas-video → 501 CAPABILITY_UNAVAILABLE（available:false / transport:null / detail 非空）；假 provider 请求计数 0→0",
    !!n3 && !n3.__noFrame && !n3.__error && n3.status === 501 && !!n3.body && n3.body.error === "CAPABILITY_UNAVAILABLE" && n3.body.available === false && n3.body.transport === null && String(n3.body.detail || "").length > 0
      && !!n3.facts && n3.facts.video && n3.facts.video.available === false && n3.facts.video.transport === null && n3.facts.video.reason === N_VIDEO_TEXT
      && n3.card === true
      && !!n3.runBtn && n3.runBtn.blocked === "video-generation" && n3.runBtn.disabled === true
      && !!n3.videoEntry && n3.videoEntry.disabled === true && n3.videoEntry.aria === "true" && n3.videoEntry.mark === "video-generation" && n3.videoEntry.title === N_VIDEO_TEXT
      && n3.videoPills === 0 && n3.noteText === N_VIDEO_TEXT
      && n3Req(n3ReqBefore) === 0 && n3Req(n3ReqAfter) === n3Req(n3ReqBefore)
      && n3BridgeNotice === false,
    "501 CAPABILITY_UNAVAILABLE + 创建入口/引擎/运行入口全不可用 + 0 个视频 pill + 假 provider 0→0 请求",
    JSON.stringify({ addVid: n3AddVid && n3AddVid.ok, status: n3 && n3.status, body: n3 && n3.body, factsVideo: n3 && n3.facts && n3.facts.video, card: n3 && n3.card, runBtn: n3 && n3.runBtn, videoEntry: n3 && n3.videoEntry, videoPills: n3 && n3.videoPills, noteText: n3 && n3.noteText, requests: { before: n3Req(n3ReqBefore), after: n3Req(n3ReqAfter) }, hostNoticeHead: String(n3HostNotice || "").slice(0, 60), bridgeUnsupportedNotice: n3BridgeNotice }));

  // 探针视频节点删除并等**存储**不再含它（删除是乐观本地生效 + 500ms 待保存；不等落库会复活，A10 就会读多一个节点）。
  const n3Del = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.delete', ids:['n_ng_probe_vid'] }, null);");
  const n3Gone = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
    const live = got && got.ok ? ((got.canvas.doc.nodes || []).map((n) => n.id)) : null;
    return !!live && !live.includes("n_ng_probe_vid");
  }, 20000);
  note("N3 探针视频节点已删除并落库：" + JSON.stringify({ del: !!(n3Del && n3Del.ok), persisted: n3Gone }));

  // 返回画布列表（产品路径：编辑器 .smart-back → canvas-list）
  const backClick2 = await inFrame(smartFrame(), "const el = document.querySelector('.smart-back'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const backList2 = await waitFor(() => !!listFrame() && !smartFrame(), 30000);
  const cardListed = backList2 && await waitFor(async () => (await inFrame(listFrame(), "return !!document.querySelector('#cardsGrid .project-card[data-canvas-id=" + JSON.stringify(currentCanvasId) + "]');")) === true, 20000);
  const listPayload = cardListed ? await inFrame(listFrame(), "const r = await (await fetch('/api/canvases')).json(); const list = (r && r.canvases) || []; const sorted = list.slice().sort(function (a, b) { return Number(b.updated_at || 0) - Number(a.updated_at || 0); }); return { n: list.length, first: sorted[0] ? { id: sorted[0].id, title: sorted[0].title } : null, hasCurrent: list.some(function (c) { return c.id === " + JSON.stringify(currentCanvasId) + "; }), cards: document.querySelectorAll('#cardsGrid .project-card').length };") : null;
  record("A9", "返回画布列表：列表里出现刚保存的项目、当前这本的卡片真的渲染出来（列表数据来自 OpenArc 存储，最近更新的排第一）",
    backClick2 === "clicked" && backList2 && cardListed && !!listPayload && listPayload.n >= 1 && listPayload.first && listPayload.first.id === currentCanvasId && listPayload.hasCurrent === true && listPayload.cards >= 1,
    "canvas-list 帧 + 列表含该书 + 卡片存在", JSON.stringify({ backClick2, backList2, cardListed, listPayload }));
  await page.screenshot({ path: path.join(ART, "d5-02-app-home.png") }).catch(() => {});

  // 再打开项目：点列表首页上这本画布的卡片（产品路径，不是 IPC 造帧）
  const reopened = await reopenCurrentCanvasFromHome();
  const reopenedSame = await waitFor(async () => (await inFrame(smartFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, edges: s.edgeCount, x: (window.__openarcCanvasInternals.primitives.getNode('n_llm')||{}).x };")).id === currentCanvasId, 25000);
  const reopenedState = await inFrame(smartFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, edges: s.edgeCount, x: (window.__openarcCanvasInternals.primitives.getNode('n_llm')||{}).x };");
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
    cfgSeen = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); const p = Array.isArray(cfg.api_providers) ? cfg.api_providers : []; const raw = JSON.stringify(cfg); return { chat: (cfg.chat_models||[]).length, image: (cfg.image_models||[]).length, providers: p.length, ids: p.map(function (x) { return String(x.id); }), names: p.map(function (x) { return String(x.name); }), keySets: p.map(function (x) { return Object.keys(x).sort(); }), hasKey: raw.includes('d502-canvas-secret'), hasUrl: raw.includes('127.0.0.1'), raw: raw };");
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

  await nRefreshConfig();
  const setText = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.edit', id:'n_prompt', patch:{ text:'写一句关于海边的提示词' } }, null);");
  // 智能画布的文本生成节点 = smart-prompt；真实入口是节点底部的 ▶（.prompt-node-run → runPromptLLMNode），
  // 不是 composer 的 #runBtn（那是图片/视频生成入口）。
  const llmPrep = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_llm'); const cfg = await (await fetch('/api/config')).json(); n.llmEnabled = true; n.llmProvider = cfg.api_providers[0].id; n.llmModel = cfg.chat_models[0]; n.llmInstruction = '写一句关于海边的提示词'; n.outputText = ''; n.text = ''; it.primitives.render(); await new Promise(function (r) { setTimeout(r, 400); }); const el = document.querySelector('.image-node[data-id=\"n_llm\"]'); if (el) el.click(); await new Promise(function (r) { setTimeout(r, 600); }); const b = document.querySelector('#composerConsoleHost .prompt-node-run') || document.querySelector('.prompt-node-run'); return { model: n.llmModel, provider: n.llmProvider, hasRun: !!b, runState: b ? b.getAttribute('data-run-state') : null, chatSel: (function () { const s = document.getElementById('chatModelSelect'); return s ? { disabled: !!s.disabled, options: Array.prototype.map.call(s.options, function (o) { return o.value; }) } : null; })() };");
  const runLlm = await inFrame(smartFrame(), "const b = document.querySelector('#composerConsoleHost .prompt-node-run') || document.querySelector('.prompt-node-run'); if (!b) return 'no-run'; b.click(); return 'clicked';");
  note("LLM 运行前：" + JSON.stringify({ setText: setText && setText.ok, prep: llmPrep, runLlm }));
  const llmDone = (await waitFor(async () => {
    const n = await inFrame(smartFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { running: !!n.running, text: String(n.text || ''), outputText: String(n.outputText || '') };");
    return n && n.running === false && String(n.text || '').startsWith(CANVAS_TEXT_PREFIX) ? n : null;
  }, 40000)) ? await inFrame(smartFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { running: !!n.running, text: String(n.text || ''), outputText: String(n.outputText || '') };") : null;
  const providerAfterChat = provider.state();
  record("B2", "真实模型调用链（文本）：智能画布文本生成节点 ▶（.prompt-node-run → runPromptLLMNode）→ 经 OpenArc 模型服务 → 本地 provider → 结果回到节点（node.text 以 provider 确定性前缀开头）",
    !!llmPrep && llmPrep.hasRun === true && runLlm === "clicked" && !!llmDone && String(llmDone.text).startsWith(CANVAS_TEXT_PREFIX) && providerAfterChat.chats.length >= 1 && providerAfterChat.authSeen >= 1,
    "节点拿到 provider 文本 + provider 收到 OpenArc 凭据", JSON.stringify({ llmPrep, runLlm, llmDone, chats: providerAfterChat.chats.slice(-1), authSeen: providerAfterChat.authSeen }));

  const addGen = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_gen', type:'generator', x:120, y:420, count:1 } }, null);");
  const linkGen = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_gen' }, null);");
  // 图片节点 = smart-image；真实入口是「选中节点 → 编辑栏提示词 → #runBtn」（runGeneration → /api/canvas-image-tasks）。
  const genPrep = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const cfg = await (await fetch('/api/config')).json(); const n = it.primitives.getNode('n_gen'); n.runSettings = { engine:'api', apiKind:'image', provider_id: cfg.api_providers[0].id, model: cfg.image_models[0], count: 1, ratio: 'square', resolution: '1k' }; n.promptDraftText = 'D5-02 图片生成'; n.promptDraftHtml = 'D5-02 图片生成'; n.promptDraftTouched = true; it.primitives.render(); await new Promise(function (r) { setTimeout(r, 400); }); const el = document.querySelector('.image-node[data-id=\"n_gen\"]'); if (el) el.click(); await new Promise(function (r) { setTimeout(r, 900); }); const inp = document.getElementById('promptInput'); if (inp) { inp.textContent = 'D5-02 图片生成'; inp.dispatchEvent(new Event('input', { bubbles: true })); } await new Promise(function (r) { setTimeout(r, 500); }); const b = document.getElementById('runBtn'); return { prompt: inp ? String(inp.textContent) : null, hasRun: !!b, disabled: b ? !!b.disabled : null, model: n.runSettings.model, provider: n.runSettings.provider_id, settings: { provider_id: it.getState().settings.provider_id, model: it.getState().settings.model } };");
  const runGen = await inFrame(smartFrame(), "const b = document.getElementById('runBtn'); if (!b) return 'no-btn'; const r = { disabled: !!b.disabled, blocked: b.getAttribute('data-openarc-blocked') }; b.click(); return r;");
  const genState = async () => inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); const logs = JSON.parse(window.__openarcSmartGuard.snapshot()).logs || []; const imgs = (n.images || []).filter(function (i) { return i && i.url; }); return { images: imgs.length, pending: n.pending || 0, running: !!n.running, log0: logs[0] ? { status: logs[0].status, error: String(logs[0].error || '').slice(0, 160), nodeId: logs[0].nodeId } : null };");
  const genDone = (await waitFor(async () => { const s = await genState(); return s && (s.images >= 1 || (s.log0 && s.log0.status === "failed")) ? s : null; }, 90000)) ? await genState() : null;
  const providerAfterImage = provider.state();
  // 保存是 500ms 防抖：等文档里真的出现图片（不拿"页面内存里有图"冒充实测落库）。
  const genStoredOk = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
    const n = got && got.ok ? (got.canvas.doc.nodes || []).find((x) => x.id === "n_gen") : null;
    return !!(n && Array.isArray(n.images) && n.images.length >= 1);
  }, 20000);
  const genStored = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  const genStoredNode = (genStored && genStored.ok ? (genStored.canvas.doc.nodes || []) : []).find((x) => x.id === "n_gen") || null;
  record("B3", "真实模型调用链（图片）：智能画布图片节点选中运行（#runBtn）→ OpenArc 模型服务 → /images/generations → 节点 images[] 拿到图片且保存进文档",
    !!genPrep && genPrep.hasRun === true && runGen && runGen.disabled === false && !!genDone && genDone.images >= 1 && (!genDone.log0 || genDone.log0.status !== "failed") && providerAfterImage.images.length >= 1
      && providerAfterImage.images.some((i) => i.model === genPrep.model) && genStoredOk === true && !!genStoredNode && Array.isArray(genStoredNode.images) && genStoredNode.images.length >= 1,
    "节点 images≥1 + 文档已保存 + provider 收到图片请求（模型 = 页面选中模型）", JSON.stringify({ addGen: addGen && addGen.ok, linkGen: linkGen && linkGen.ok, genPrep, runGen, genDone, providerImages: providerAfterImage.images.slice(-1), storedOk: genStoredOk, stored: genStoredNode ? { images: (genStoredNode.images || []).length } : null }));

  await provider.setMode("fail");
  // 清掉上一轮的图，确保 B4 的"没有假装成功"不是拿旧图蒙混：清空 → 运行 → 失败 → images 仍为 0。
  const b4Clear = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); n.images = []; it.primitives.render(); return { cleared: true };");
  const b4Run = await inFrame(smartFrame(), "const el = document.querySelector('.image-node[data-id=\"n_gen\"]'); if (el) el.click(); await new Promise(function (r) { setTimeout(r, 500); }); const inp = document.getElementById('promptInput'); if (inp) { inp.textContent = 'D5-02 失败探测'; inp.dispatchEvent(new Event('input', { bubbles: true })); } await new Promise(function (r) { setTimeout(r, 300); }); const b = document.getElementById('runBtn'); if (!b) return 'no-btn'; b.click(); return { clicked: true, disabled: !!b.disabled };");
  const failedState = (await waitFor(async () => { const s = await genState(); return s && s.log0 && s.log0.status === "failed" ? s : null; }, 60000)) ? await genState() : null;
  const providerAfterFail = provider.state();
  await provider.setMode("ok");
  record("B4", "失败如实展示：provider 500 → 画布生成日志记 failed + 错误原因非空，节点 images 仍为 0、pending 归 0（不假装成功）",
    !!b4Clear && !!b4Run && b4Run.clicked === true && !!failedState && failedState.log0.status === "failed" && String(failedState.log0.error).length > 0 && failedState.images === 0 && failedState.pending === 0 && providerAfterFail.images.length >= 1,
    "log.status=failed + error 非空 + images=0/pending=0", JSON.stringify({ run: b4Run, failedState, providerImages: providerAfterFail.images.length }));

  /* ── N4：真实投影 + 无第二来源（B 系列已配好 provider+模型，看页面是不是真的按真源渲染） ── */
  const n4Names = expectProviders.map((p) => String(p.displayName || p.providerId));
  await nRefreshConfig();
  await nSelectSmartNode("n_gen");
  const n4 = await inFrame(smartFrame(), [
    "const cfg = await (await fetch('/api/config')).json();",
    "const facts = window.__openarcSmartGuard ? window.__openarcSmartGuard.facts() : null;",
    nFakeScanLines(N_FAKE_LABEL_RE).join("\n"),
    "const it = window.__openarcCanvasInternals;",
    "const keys = " + JSON.stringify(N_MODEL_SOURCE_KEYS) + ";",
    "const readBack = {}; const residue = [];",
    "keys.forEach(function (k) { try { window.localStorage.setItem(k, 'N4-伪造清单'); } catch (e) { /* 写不进去也是被封住的一种表现 */ } });",
    "keys.forEach(function (k) { try { readBack[k] = window.localStorage.getItem(k); } catch (e) { readBack[k] = 'throw'; } });",
    "for (let i = 0; i < window.localStorage.length; i += 1) { const k = String(window.localStorage.key(i) || ''); if (keys.some(function (x) { return k.indexOf(x) >= 0; })) residue.push(k.slice(0, 80)); }",
    "const pillValues = (param) => Array.prototype.map.call(document.querySelectorAll('#dynamicParams [data-smart-param=\"' + param + '\"]'), function (b) { return String(b.getAttribute('data-smart-value')); });",
    "const chatSel = document.getElementById('chatModelSelect');",
    "const llm = it.primitives.getNode('n_llm') || {}; const gen = it.primitives.getNode('n_gen') || {};",
    "return { providers: (cfg.api_providers || []).map(function (p) { return { id: String(p.id), name: String(p.name), keys: Object.keys(p).sort() }; }),",
    "  chatModels: cfg.chat_models || [], imageModels: cfg.image_models || [],",
    "  providerRows: (cfg.api_providers || []).map(function (p) { return { id: String(p.id), name: String(p.name), chat: p.chat_models || [], image: p.image_models || [] }; }),",
    "  providerPills: pillValues('provider_id'), modelPills: pillValues('model'),",
    "  chatOptions: chatSel ? Array.prototype.map.call(chatSel.options, function (o) { return String(o.value); }) : null, chatValue: chatSel ? String(chatSel.value) : null,",
    "  settings: { provider_id: it.getState().settings.provider_id, model: it.getState().settings.model },",
    "  nodes: { llm: { provider: String(llm.llmProvider || ''), model: String(llm.llmModel || '') }, gen: { provider: String((gen.runSettings || {}).provider_id || ''), model: String((gen.runSettings || {}).model || '') } },",
    "  facts: facts, locked: window.__openarcSmartGuard ? window.__openarcSmartGuard.storage() : null,",
    "  fake: fake, readBack: readBack, residue: residue };",
  ].join("\n"));
  record("N4", "真实投影 + 无第二来源：B 系列配好 provider+模型后，智能画布模型区逐项 = OpenArc 真源 —— 平台控件只有真 provider（id + displayName）、provider pill 逐项 = 真 provider、模型 pill 每个值都在 /api/config.image_models 里、chat 模型下拉每个选项都在 chat_models 里、页面当前 provider/model 与节点当前模型都取自真源；gpt-4o-mini / gpt-image-2 / veo3-fast 在 DOM 属性+文本 / option.value / select.value 三处 0 命中；四把 smart_* localStorage 记忆键 setItem 后读回 null 且不留残留键；/api/config.api_providers 键集合 ⊆ 六键",
    !!n4 && !n4.__noFrame && !n4.__error
      && n4.providers.length >= 1 && n4.providers.every((p) => p.keys.length > 0 && p.keys.every((k) => N_PROVIDER_KEYS.includes(k)))
      && n4.providers.some((p) => p.id === providerId && n4Names.includes(p.name))
      && !!n4.facts && Array.isArray(n4.facts.providers) && JSON.stringify(n4.facts.providers.slice().sort()) === JSON.stringify(n4.providers.map((p) => p.id).sort())
      && n4.providerPills.length === 1 && n4.providerPills[0] === providerId
      && n4.modelPills.length >= 1 && n4.modelPills.every((v) => n4.imageModels.includes(v))
      && !!n4.settings && n4.settings.provider_id === providerId && n4.imageModels.includes(String(n4.settings.model))
      && Array.isArray(n4.chatOptions) && n4.chatOptions.length >= 1 && n4.chatOptions.every((v) => v !== "" && n4.chatModels.includes(v)) && n4.chatModels.includes(n4.chatValue)
      && !!n4.nodes.gen && n4.nodes.gen.provider === providerId && n4.imageModels.includes(n4.nodes.gen.model)
      && !!n4.nodes.llm && n4.nodes.llm.provider === providerId && n4.chatModels.includes(n4.nodes.llm.model)
      && n4.fake.htmlMatched === false && n4.fake.optionHits.length === 0 && n4.fake.selectHits.length === 0
      && !!n4.locked && n4.locked.locked === true
      && N_MODEL_SOURCE_KEYS.every((k) => n4.readBack[k] === null) && n4.residue.length === 0,
    "平台/provider pill = 真 provider；模型 pill / chat 下拉选项 ⊆ 真源清单；三个伪造标签 0 命中；四把记忆键读回 null 且锁住",
    JSON.stringify({ providers: n4 && n4.providers, chatModels: n4 && n4.chatModels, imageModels: n4 && n4.imageModels, providerPills: n4 && n4.providerPills, modelPills: n4 && n4.modelPills, chatOptions: n4 && n4.chatOptions, chatValue: n4 && n4.chatValue, settings: n4 && n4.settings, nodes: n4 && n4.nodes, factsProviders: n4 && n4.facts && n4.facts.providers, locked: n4 && n4.locked, fake: n4 && n4.fake, readBack: n4 && n4.readBack, residue: n4 && n4.residue }));

  /* ── N6：无静默回落 —— 清单外标签必须被明确拒绝，且一次 provider 请求都不发 ── */
  const n6HostBefore = await attrOf("[data-canvas-host]", "data-canvas-model-not-found");
  const n6ReqBefore = provider.state();
  const n6 = await inFrame(smartFrame(), [
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

  const video = await inFrame(smartFrame(), "const r = await fetch('/api/canvas-video', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt:'x' }) }); return { status: r.status, body: await r.json() };");
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
  await nRefreshConfig();
  const n5aRevoked = await nWaitModelArea("unavailable-all", providerId);
  if (modelGrant) await governance({ type: "governance/grantAppAccess", appId: "canvas", resourceType: "model", scope: "ORGANIZATION", actions: ["model.view", "model.use"] });
  const regranted = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  record("D1", "无权限：撤销画布应用的 model.use 后，生成明确拒绝且 provider 收不到任何请求（F2 缺口）",
    !!modelGrant && revokedRun.ok === false && revokedRun.error === "PROXY_UNAUTHORIZED" && afterNoPerm === beforeNoPerm && noPermRun.ok && regranted.ok,
    "PROXY_UNAUTHORIZED + 0 请求", JSON.stringify({ hasGrant: !!modelGrant, grantActions: modelGrant && modelGrant.actions, noPermRun: noPermRun.ok, revoked: { ok: revokedRun.ok, error: revokedRun.error }, requests: beforeNoPerm + "→" + afterNoPerm, regranted: regranted.ok }));

  // N5a：恢复授权 → 页面模型区必须回到可用（与撤权时那份 snapshot 成对，缺一半就是没验完）。
  await nRefreshConfig();
  const n5aRegranted = await nWaitModelArea("available-all", providerId);
  record("N5a", "撤权 → 智能画布模型区真的变成不可用（守卫事实面 chat/image configured=false + #chatModelSelect disabled 且只剩「未配置」+ provider/model pill 0 个 + 平台控件 0 项 + 生图/文本运行入口分别 data-openarc-blocked=image-generation / chat 且 disabled）；恢复授权 → 回到可用（事实面 configured=true + 下拉可选且选项 ⊆ 真源清单 + provider pill 逐项 = 真 provider + 模型 pill ⊆ image_models + 运行入口解封）；D1 的调用级判定一个字未改",
    n5aRevoked.ok && n5aRegranted.ok,
    "撤权：事实面 configured=false + 下拉 disabled/唯一占位 + pill 0 + 运行入口 blocked；恢复：事实面 ok + 下拉/pill 只含真源 + 运行入口解封",
    JSON.stringify({ revoked: nSnapBrief(n5aRevoked), regranted: nSnapBrief(n5aRegranted) }));

  const chatOnly = await model({ type: "model/create", providerId, remoteModelId: "d502-chat-only", displayName: "D5-02 ChatOnly", capabilities: ["chat"], scope: "ORGANIZATION" });
  await model({ type: "defaults/set", capability: "image-generation", configId: chatOnly.model.configId });
  const beforeCap = provider.state().images.length;
  const capRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "image" });
  const afterCap = provider.state().images.length;
  /* N5c **随经典编辑器移除而删除**（登记见 DELETED_CASES）：智能画布没有「显式默认不可用」的页面契约
   * （没有 data-openarc-default-unavailable / 原因说明行 / 设置引导）。写范围不能改 public/novai-canvas/**。
   * 下面保留一次**实测取证**（不是 PASS 断言）：把跨能力时页面真实选中的模型记进 productGaps。*/
  await nRefreshConfig();
  const n5cSeen = await waitFor(async () => {
    const s = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); const c = (cfg.capabilities || {})['image-generation'] || {}; return { image_model: cfg.image_model, image_models: cfg.image_models || [], defaultUsable: c.defaultUsable, defaultReason: c.defaultReason };");
    return s && s.defaultUsable === false ? s : null;
  }, 20000);
  await nSelectSmartNode("n_gen");
  const n5cObserved = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); const b = document.getElementById('runBtn'); return { cfg: { image_model: cfg.image_model, image_models: cfg.image_models || [], defaultUsable: ((cfg.capabilities || {})['image-generation'] || {}).defaultUsable, defaultReason: ((cfg.capabilities || {})['image-generation'] || {}).defaultReason }, settings_model: it.getState().settings.model, node_model: String((n.runSettings || {}).model || ''), runBtn: { disabled: b ? !!b.disabled : null, blocked: b ? b.getAttribute('data-openarc-blocked') : null } };");
  productGaps.push({ case: "N5c", reason: "页面侧「显式默认不可用」契约未移植（无 data-openarc-default-unavailable / 无原因+引导行）", evidence: n5cSeen, observed: n5cObserved, semantics: "显式生图默认不可用时，页面会按真源清单自动选中另一个可用生图模型（settings_model / node_model），即静默换模型；宿主层 D2 仍明确拒绝（CAPABILITY_UNAVAILABLE + 0 请求）" });
  note("N5c 删除后的实测（产品缺口证据）：" + JSON.stringify(n5cObserved));
  await model({ type: "defaults/set", capability: "image-generation", configId: imgId });
  record("D2", "能力不支持：图片能力被指到只有 chat 的模型上 → 明确 CAPABILITY_UNAVAILABLE，provider 收不到图片请求",
    capRun.ok === false && capRun.error === "CAPABILITY_UNAVAILABLE" && afterCap === beforeCap,
    "CAPABILITY_UNAVAILABLE + 0 请求", JSON.stringify({ capRun: { ok: capRun.ok, error: capRun.error }, images: beforeCap + "→" + afterCap }));

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
  await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; it.primitives.getNode('n_llm').outputText = '用户随后编辑的内容'; it.primitives.render(); return true;");
  const userText = await inFrame(smartFrame(), "return { text: String(window.__openarcCanvasInternals.primitives.getNode('n_llm').outputText || '') };");
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
  const n5dLabel = String((chatModel && chatModel.model && (chatModel.model.remoteModelId || chatModel.model.displayName)) || chatId);
  const n5dManifestBefore = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); return { chat: cfg.chat_models || [] };");
  await model({ type: "model/setStatus", configId: chatId, status: "disabled" });
  const disabledCall = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: bindRun.runId, messages: [{ role: "user", content: "停用后不该成功" }], configId: chatId });
  const afterDisable = provider.state().chats.length;
  /* N5d **随经典编辑器移除而删除**（登记见 DELETED_CASES）：停用「显式文本默认」后的页面呈现契约
   * （data-openarc-default-unavailable=chat / select.value 为空 / 不自动改用清单里剩下的模型）在智能画布不存在。
   * 这里只留一次实测取证（不是 PASS 断言），把页面真实行为记进 productGaps。*/
  await nRefreshConfig();
  const n5dSeen = await waitFor(async () => {
    const s = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); return { chat: cfg.chat_models || [], defaultUsable: ((cfg.capabilities || {}).chat || {}).defaultUsable, defaultReason: ((cfg.capabilities || {}).chat || {}).defaultReason };");
    return s && !s.chat.includes(n5dLabel) ? s : null;
  }, 20000);
  await nSelectSmartNode("n_llm");
  const n5dObserved = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); const it = window.__openarcCanvasInternals; const sel = document.getElementById('chatModelSelect'); const n = it.primitives.getNode('n_llm'); const b = document.getElementById('runBtn'); return { cfg: { chat: cfg.chat_models || [], defaultUsable: ((cfg.capabilities || {}).chat || {}).defaultUsable, defaultReason: ((cfg.capabilities || {}).chat || {}).defaultReason }, chatSelect: sel ? { disabled: !!sel.disabled, value: String(sel.value), options: Array.prototype.map.call(sel.options, function (o) { return String(o.value); }) } : null, node_model: String(n.llmModel || ''), runBtn: { disabled: b ? !!b.disabled : null, blocked: b ? b.getAttribute('data-openarc-blocked') : null } };");
  productGaps.push({ case: "N5d", reason: "停用显式文本默认后的「默认不可用」呈现契约未移植（无 data-openarc-default-unavailable=chat / 无原因+引导行）", evidence: n5dSeen, observed: n5dObserved, semantics: "停用后页面会按清单自动选中另一个可用 chat 模型（chatSelect.value / node_model），即静默换模型；F1 的调用级拒绝仍然成立" });
  note("N5d 删除后的实测（产品缺口证据）：" + JSON.stringify(n5dObserved));
  const crossCap = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: bindRun.runId, messages: [{ role: "user", content: "拿图片模型跑文本" }], configId: imgId });
  const afterCross = provider.state().chats.length;
  const unknownCfg = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: bindRun.runId, messages: [{ role: "user", content: "不存在的配置" }], configId: "mcf_does_not_exist" });
  const afterUnknown = provider.state().chats.length;
  await model({ type: "model/setStatus", configId: chatId, status: "enabled" });
  await canvas({ type: "canvas/runFinish", canvasId: currentCanvasId, runId: bindRun.runId, status: "FAILED" });
  // 恢复后把页面也刷回可用，供 F3 系列使用（不是断言，只是保持后续步骤的真实状态）。
  await nRefreshConfig();
  record("F1", "任务模型绑定：指定的模型配置被停用/能力不符/不存在时**明确拒绝**且 0 新增请求（不静默换模型）",
    okCall && okCall.ok === true && disabledCall.ok === false && afterDisable === beforeDisable && crossCap.ok === false && afterCross === beforeDisable && unknownCfg.ok === false && afterUnknown === beforeDisable,
    "停用/跨能力/不存在 → 拒绝 + 0 请求", JSON.stringify({ okCall: okCall && okCall.ok, disabled: { ok: disabledCall.ok, error: disabledCall.error }, cross: { ok: crossCap.ok, error: crossCap.error }, unknown: { ok: unknownCfg.ok, error: unknownCfg.error }, requests: [beforeDisable, afterDisable, afterCross, afterUnknown] }));

  /* ══════════════════ F3：图片资源产品链 ══════════════════ */
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=";
  const upload = await inFrame(smartFrame(), "const bytes = Uint8Array.from(atob('" + PNG + "'), c => c.charCodeAt(0)); const f = new File([bytes], 'd502-asset.png', { type: 'image/png' }); const fd = new FormData(); fd.append('files', f); const r = await fetch('/api/ai/upload', { method:'POST', body: fd }); const txt = await r.text(); let d = {}; try { d = JSON.parse(txt); } catch (e) { d = { parseError: txt.slice(0, 120) }; } return { status: r.status, keys: Object.keys(d), files: (d.files||[]).map(x => ({ url: String(x.url).slice(0,24), name: x.name })), error: d.error || null, message: d.message || null };");
  const addImg = await inFrame(smartFrame(), "const up = await (async () => { const bytes = Uint8Array.from(atob('" + PNG + "'), c => c.charCodeAt(0)); const f = new File([bytes], 'd502-asset.png', { type: 'image/png' }); const fd = new FormData(); fd.append('files', f); const r = await fetch('/api/ai/upload', { method:'POST', body: fd }); return await r.json(); })(); const url = up.files && up.files[0] && up.files[0].url; if (!url) return { ok: false, why: 'no-url' }; const res = await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_img', type:'image', x:700, y:420, url: url, name:'导入图片' } }, null); return { ok: res.ok, url: String(url).slice(0, 24) };");
  const imgSaved = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
    const n = got && got.ok ? got.canvas.doc.nodes.find((x) => x.id === "n_img") : null;
    const url = n && Array.isArray(n.images) && n.images[0] ? String(n.images[0].url || "") : "";
    return !!n && url.indexOf("openarc-asset:") === 0;
  }, 20000);
  const imgDoc = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  const imgNode = (imgDoc.canvas.doc.nodes || []).find((x) => x.id === "n_img") || {};
  const imgUrl = imgNode && Array.isArray(imgNode.images) && imgNode.images[0] ? String(imgNode.images[0].url || "") : "";
  const assetRef = imgUrl.replace("openarc-asset:", "");
  const assetStates = await canvas({ type: "canvas/assetStates", canvasId: currentCanvasId, refs: [assetRef] });
  record("F3a", "图片资源：本地导入写入 OpenArc 资源库，画布文档只存 openarc-asset:<ResourceRef>（Smart 节点 images[0].url；不存 data URL / 路径）",
    upload.status === 200 && addImg.ok === true && imgSaved && assetRef.length > 0 && imgUrl.indexOf("data:") !== 0,
    "文档里只有稳定 ref", JSON.stringify({ upload: upload.files, addImg, assetRefHead: assetRef.slice(0, 12), docUrlHead: imgUrl.slice(0, 30), states: assetStates.exists }));

  // 关闭窗口 → 重开 → 从首页再打开这本 → 图片仍可解析
  const closedOnce = await closeAppWindow();
  const framesAfterClose = allBundleFrames().length;
  const reopenedOnce = await reopenCurrentCanvasFromHome();
  const resolved = await waitFor(async () => {
    const st = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const s = it.getState(); const n = it.primitives.getNode('n_img'); const url = String((((n || {}).images || [])[0] || {}).url || ''); return { id: s.canvas && s.canvas.id, hasImg: !!n, url: url.slice(0, 21) };");
    return st && st.id === currentCanvasId && st.hasImg && st.url.indexOf("data:image") === 0;
  }, 30000);
  const resolvedState = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const s = it.getState(); const n = it.primitives.getNode('n_img'); return { id: s.canvas && s.canvas.id, url: String((((n || {}).images || [])[0] || {}).url || '').slice(0, 21), nodes: s.nodes.length };");
  const resolvedStored = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  const resolvedStoredNode = (resolvedStored && resolvedStored.ok ? (resolvedStored.canvas.doc.nodes || []) : []).find((x) => x.id === "n_img") || {};
  const resolvedStoredUrl = resolvedStoredNode && Array.isArray(resolvedStoredNode.images) && resolvedStoredNode.images[0] ? String(resolvedStoredNode.images[0].url || "") : "";
  record("F3b", "图片资源：关闭窗口重开后仍可用（宿主按当前用户逐资源授权解析为 data URL 显示，存储里仍是 ref）",
    closedOnce && framesAfterClose === 0 && reopenedOnce && resolved && resolvedState.id === currentCanvasId && resolvedStoredUrl.indexOf("openarc-asset:") === 0,
    "重开后图片可用 + 存储仍是 ref", JSON.stringify({ closedOnce, framesAfterClose, reopenedOnce, resolved, resolvedState, storedUrlHead: resolvedStoredUrl.slice(0, 24) }));

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
    const st = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_img'); return { url: String((((n || {}).images || [])[0] || {}).url || '').slice(0, 24) };");
    return st && st.url.indexOf("data:image") < 0;
  }, 25000);
  clearInterval(noticeTimer);
  const inMountNotice = noticeSamples.find((s) => /引用资源/.test(String(s.text))) || (await js("const el = document.querySelector('[data-canvas-host]'); return el ? { flag: String(el.getAttribute('data-canvas-asset-notice') || ''), text: String(el.getAttribute('data-canvas-asset-notice-text') || '').slice(0, 80) } : null;"));
  const noticeIsAboutAssets = !!inMountNotice && inMountNotice.flag === "1" && /引用资源/.test(String(inMountNotice.text));
  const closedTwice = await closeAppWindow();
  const reopenedTwice = await reopenCurrentCanvasFromHome();
  const afterDeleteState = await waitFor(async () => {
    const st = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_img'); return { url: String((((n || {}).images || [])[0] || {}).url || '').slice(0, 24) };");
    return st && st.url.indexOf("data:image") < 0;
  }, 25000);
  const afterDeleteUrl = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_img'); return { url: String((((n || {}).images || [])[0] || {}).url || '').slice(0, 32) };");
  const afterDeleteStored = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  const afterDeleteStoredNode = (afterDeleteStored && afterDeleteStored.ok ? (afterDeleteStored.canvas.doc.nodes || []) : []).find((x) => x.id === "n_img") || {};
  const afterDeleteStoredUrl = afterDeleteStoredNode && Array.isArray(afterDeleteStoredNode.images) && afterDeleteStoredNode.images[0] ? String(afterDeleteStoredNode.images[0].url || "") : "";
  record("F3c", "图片资源：资源被删除后画布明确不可用（宿主复核失效缓存 + reload-doc → 节点显示不可用占位，存储仍保留 ref），旧 data URL 缓存不复活",
    delRes && delRes.ok === true && readAfterDelete.ok === false && stateAfterDelete.exists && stateAfterDelete.exists[assetRef] && stateAfterDelete.exists[assetRef].state !== "AVAILABLE" && inMountInvalidated && closedTwice && reopenedTwice && afterDeleteState && afterDeleteUrl.url.indexOf("data:image") < 0 && afterDeleteStoredUrl.indexOf("openarc-asset:") === 0,
    "ASSET_UNAVAILABLE + 当场缓存失效 + 提示 + 重开不复活 + 存储仍保留 ref", JSON.stringify({ delRes: delRes && delRes.ok, noticeIsAboutAssets, read: { ok: readAfterDelete.ok, error: readAfterDelete.error }, state: stateAfterDelete.exists && stateAfterDelete.exists[assetRef], inMountInvalidated, inMountNotice, closedTwice, reopenedTwice, afterDeleteUrl, storedUrlHead: afterDeleteStoredUrl.slice(0, 24) }));

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
    ? await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type: 'node.add', node: { id: " + JSON.stringify(d1LocalId) + ", type: 'prompt', x: 120, y: 120, text: " + JSON.stringify(d1LocalText) + " } }, null);")
    : { __skipped: "canvas-not-ready" };
  const d1LocalSaved = await waitFor(async () => { const n = await nodeOf(currentCanvasId, d1LocalId); return !!(n && n.text === d1LocalText); }, 20000);
  const d1HostAdd = await canvas({ type: "canvas/command", canvasId: currentCanvasId, command: { type: "node.add", node: { id: d1HostId, type: "prompt", x: 120, y: 300, text: d1HostText } } });
  const d1T0 = Date.now();
  // 等 12s 只为**测出真实呈现延迟**（判定仍是 ≤5s；智能画布自己的远端合并轮询是 8s —— 
  // public/novai-canvas/static/js/smart-canvas.js:11022 的 setTimeout(..., 8000)，宿主侧没有 canvas_updated 推送）。
  const d1Appeared = await waitFor(async () => (await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; return !!(it && it.primitives.getNode(" + JSON.stringify(d1HostId) + "));")) === true, 12000);
  const d1WaitedMs = Date.now() - d1T0;
  const d1Page = await inFrame(smartFrame(), [
    "const it = window.__openarcCanvasInternals;",
    "const has = (id) => !!(it && it.primitives.getNode(id));",
    "const nodeEl = (id) => document.querySelector('.image-node[data-id=' + id + ']');",
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
    JSON.stringify({ ready: { ok: d1Ready.ok, waitedMs: d1Ready.waitedMs, steps: d1Ready.steps }, localEdit: { ok: !!(d1LocalEdit && d1LocalEdit.ok), error: d1LocalEdit && d1LocalEdit.error || null }, localSaved: d1LocalSaved, hostAdd: { ok: !!(d1HostAdd && d1HostAdd.ok), error: d1HostAdd && d1HostAdd.error }, appeared: d1Appeared, waitedMs: d1WaitedMs, thresholdMs: 5000, page: d1Page, ipcHost: d1IpcHost && { text: d1IpcHost.text }, ipcLocal: d1IpcLocal && { text: d1IpcLocal.text }, revisions: { at: d1RevAt, after5s: d1RevAfter, stable: d1RevisionStable } }));

  // F3d 的失败如果来自「延迟 > 5s」，如实登记为产品缺口（不是门禁写法问题：这条测的就是"推进来有多快"）。
  if (d1Appeared === true && d1WaitedMs > 5000) {
    productGaps.push({ case: "F3d", reason: "智能画布远端合并轮询 8s（smart-canvas.js:11022），宿主/AI 的 canvas/command 改动最多约 8s 才进已打开编辑器；经典画布为 2.5s", observed: { waitedMs: d1WaitedMs, thresholdMs: 5000, appeared: d1Appeared }, semantics: "门禁未能通过（F3d ≤5s），原因是产品问题：远端改动呈现延迟超出旧门禁预算" });
  }

  /* ══════════════════ F3e：500ms 待保存窗口内的受控交错 —— 两边内容都必须保留 ══════════════════ */
  // 已登记缺陷（第八 / 十 / 十一批实测）：页面在 debounce 窗口里做的本地编辑撞上宿主 / AI 的改动时，
  // 上游 409 分支会把基线换成远端新值后**重发同一份基于旧 revision 的旧文档** —— 对方那次改动被静默覆盖。
  // 本断言在**同一个 500ms 窗口内**制造交错（页面 applyCommand 之后立刻用宿主 IPC canvas/command 写入）：
  //   ① 不同节点：两边都要在（页面 primitives + DOM + 宿主读回 + 关窗重开仍在）；
  //   ② 同一节点同一字段：本地那一版留在原位、远端那一版作为可辨认副本（<id>-remote）保留，
  //      两边文本都能在存储里读到，而且合并**确实发生过**（页面冲突证据通道 count ≥ 1，不是碰巧没冲突）。
  // **只新增这一条，不改任何既有断言。**
  await page.bringToFront().catch(() => {});
  const f3eLocalId = "n_f3e_local", f3eHostId = "n_f3e_host";
  const f3eLocalText = "F3e 页面本地编辑", f3eHostText = "F3e 宿主窗口内写入";
  const f3eReady = await waitChain2Ready("n_img", 20000);
  const f3eIpcText = async (id) => { const n = await nodeOf(currentCanvasId, id); return n ? String(n.text == null ? "" : n.text) : null; };
  // 同一个 500ms 窗口内交错：页面 applyCommand 之后立刻用宿主 IPC canvas/command 写另一个节点。
  const f3eT0 = Date.now();
  const f3eLocal = f3eReady.ok
    ? await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type: 'node.add', node: { id: " + JSON.stringify(f3eLocalId) + ", type: 'prompt', x: 220, y: 620, text: " + JSON.stringify(f3eLocalText) + " } }, null);")
    : { __skipped: "canvas-not-ready" };
  const f3eHost = await canvas({ type: "canvas/command", canvasId: currentCanvasId, command: { type: "node.add", node: { id: f3eHostId, type: "prompt", x: 220, y: 780, text: f3eHostText } } });
  const f3eWindowMs = Date.now() - f3eT0;
  // 等页面那次保存真的落库（页面独有的 id 出现在存储里），再留 4s 让"盲重试"跑完 —— 修复前它正是
  // 在这段时间里把宿主那次写入覆盖掉的；修复后这段时间里不会再有任何覆盖。
  const f3eLocalSaved = await waitFor(async () => !!(await nodeOf(currentCanvasId, f3eLocalId)), 25000);
  await sleep(4000);
  const f3ePage = await inFrame(smartFrame(), [
    "const it = window.__openarcCanvasInternals;",
    "const g = (id) => { const n = it.primitives.getNode(id); return n ? String(n.text == null ? '' : n.text) : null; };",
    "const el = (id) => document.querySelector('.image-node[data-id=\"' + id + '\"]');",
    "return { localText: g(" + JSON.stringify(f3eLocalId) + "), hostText: g(" + JSON.stringify(f3eHostId) + "),",
    "  domHost: !!el(" + JSON.stringify(f3eHostId) + "), domLocal: !!el(" + JSON.stringify(f3eLocalId) + ") };",
  ].join("\n"));
  const f3eIpcLocalText = await f3eIpcText(f3eLocalId);
  const f3eIpcHostText = await f3eIpcText(f3eHostId);
  // 关窗重开：两边内容都还在（智能画布原生 409 合并 = 节点并集，不丢任一方）
  const f3eClosed = await closeAppWindow();
  await sleep(800);
  const f3eReopened = await reopenCurrentCanvasFromHome();
  const f3eStillThere = f3eReopened && await waitFor(async () => {
    const [local, host] = await Promise.all([f3eIpcText(f3eLocalId), f3eIpcText(f3eHostId)]);
    return local === f3eLocalText && host === f3eHostText;
  }, 25000);
  const f3eReopenPage = f3eReopened ? await inFrame(smartFrame(), [
    "const it = window.__openarcCanvasInternals;",
    "const g = (id) => { const n = it.primitives.getNode(id); return n ? String(n.text == null ? '' : n.text) : null; };",
    "return { localText: g(" + JSON.stringify(f3eLocalId) + "), hostText: g(" + JSON.stringify(f3eHostId) + ") };",
  ].join("\n")) : null;
  record("F3e", "500ms 待保存窗口内的受控交错（不同节点）：页面本地编辑与宿主 IPC 改动**两边内容都保留**（页面 primitives + DOM + 宿主读回 + 关窗重开仍在）。同节点同字段的 <id>-remote 副本与冲突计数随经典编辑器删除，登记见 DELETED_CASES",
    f3eReady.ok === true && f3eWindowMs < 500
      && f3eLocal && f3eLocal.ok === true && f3eLocalSaved === true && !!(f3eHost && f3eHost.ok)
      && !!f3ePage && f3ePage.localText === f3eLocalText && f3ePage.hostText === f3eHostText && f3ePage.domLocal === true && f3ePage.domHost === true
      && f3eIpcLocalText === f3eLocalText && f3eIpcHostText === f3eHostText
      && f3eClosed === true && f3eReopened === true && f3eStillThere === true
      && !!f3eReopenPage && f3eReopenPage.localText === f3eLocalText && f3eReopenPage.hostText === f3eHostText,
    "同窗口交错（不同节点）→ 两边都在（页面 + DOM + IPC + 重开后）",
    JSON.stringify({ windowMs: f3eWindowMs, local: f3eLocal, host: f3eHost && { ok: f3eHost.ok, error: f3eHost.error || null }, localSaved: f3eLocalSaved, page: f3ePage, ipc: { local: f3eIpcLocalText, host: f3eIpcHostText }, closed: f3eClosed, reopened: f3eReopened, stillThere: f3eStillThere, reopenPage: f3eReopenPage }));

  /* ══════════════════ E 系列：宿主级隔离（F5） ══════════════════ */
  const boundary = await inFrame(smartFrame(), "return { openarc: typeof window.openarc, require: typeof window.require, process: typeof window.process, ipc: typeof window.ipcRenderer, fs: typeof window.fs, pywebview: typeof window.pywebview };");
  const unsupported = await inFrame(smartFrame(), "const r = await fetch('/api/secret-thing'); return { status: r.status, body: await r.json() };");
  const shellBoundary = await inFrame(shellFrame(), "return { openarc: typeof window.openarc, require: typeof window.require, process: typeof window.process, ipc: typeof window.ipcRenderer };");
  record("E1", "应用页面（含外壳页与画布子页）没有 openarc 桥 / Node / IPC / fs；端点白名单外一律明确拒绝",
    [boundary, shellBoundary].every((b) => b.openarc === "undefined" && b.require === "undefined" && b.process === "undefined" && b.ipc === "undefined") && unsupported.status === 501 && unsupported.body.error === "OPENARC_UNSUPPORTED",
    "无桥 + 501", JSON.stringify({ boundary, shellBoundary, unsupported }));

  const escapeProto = await inFrame(smartFrame(), "const a = await fetch('openarc-canvas://bundle/../package.json'); const b = await fetch('openarc-canvas://bundle/SOURCE.md'); const c = await fetch('openarc-canvas://bundle/static/js/smart-canvas.js'); return { traversal: a.status, nonWhitelisted: b.status, whitelisted: c.status };");
  record("E2", "openarc-canvas:// 只读白名单：目录穿越与非白名单扩展名都被拒，白名单内资源正常",
    escapeProto.traversal >= 400 && escapeProto.nonWhitelisted >= 400 && escapeProto.whitelisted === 200,
    "403/404 + 200", JSON.stringify(escapeProto));

  const forged = await js("window.__openarcCanvasForged = null; try { const r = await window.openarc.canvas.command({ type: 'canvas/list', userId: 'usr_forged_identity', sessionRef: 'forged-session' }); window.__openarcCanvasForged = { ok: r.ok, count: (r.items || []).length }; } catch (e) { window.__openarcCanvasForged = { error: String(e.message).slice(0, 60) }; } return window.__openarcCanvasForged;");
  const forgedList = await canvas({ type: "canvas/list" });
  record("E3", "后端不信任消息自报身份：带伪造 userId/sessionRef 的请求按当前会话处理",
    forged && forged.ok === true && forged.count === (forgedList.items || []).length,
    "按会话身份处理", JSON.stringify({ forged, sessionListCount: (forgedList.items || []).length }));

  // 伪造帧的来源必须是**保留下来的产品页**（画布入口 static/canvas-list.html），不再是已裁掉子页的非产品外壳
  // bundle 根 index.html（它 eager 的 #frame-home 指向已删除的 static/home.html，加载一次就是 1 条 404）。
  // 断言语义不变且更严：伪造 token / 其它 iframe / 产品页自身来源的调用一律不执行（画布数不变），
  // **并且**伪造帧加载窗口内 bundle 资源 0 条 404、伪造帧确实加载了目标文档（不是空跑）。
  const E4_FORGED_SRC = "openarc-canvas://bundle/static/canvas-list.html?id=cv_probe";
  const listBefore2 = (await canvas({ type: "canvas/list" })).items.length;
  const e4NetMark = netFails.length;
  const e4res = await js("const f = document.createElement('iframe'); f.id='oa-forged-frame'; f.setAttribute('sandbox','allow-scripts'); f.src=" + JSON.stringify(E4_FORGED_SRC) + "; f.style.display='none'; document.body.appendChild(f); await new Promise(r=>setTimeout(r,2500)); const w = f.contentWindow; try { w.postMessage({ ch:'openarc.canvas', dir:'canvas->host', kind:'call', id: 991, token:'t_forged', method:'canvas.create', params:{ title:'伪造' } }, '*'); } catch(e) {} window.postMessage({ ch:'openarc.canvas', dir:'canvas->host', kind:'call', id: 992, token:'t_forged', method:'canvas.create', params:{ title:'来自产品页' } }, '*'); await new Promise(r=>setTimeout(r,1800)); const frameUrl = (function () { try { return String(f.contentWindow.location.href); } catch (e) { return 'cross-origin'; } })(); return { done: true, frameUrl: frameUrl };");
  const e4FrameUrls = page.frames().map((f) => String(f.url())).filter((u) => u.indexOf("openarc-canvas://bundle/") === 0);
  const e4FrameLoaded = e4FrameUrls.some((u) => u.indexOf(E4_FORGED_SRC.split("?")[0]) === 0) || String(e4res && e4res.frameUrl).indexOf(E4_FORGED_SRC.split("?")[0]) === 0;
  await js("const f = document.getElementById('oa-forged-frame'); if (f) f.remove(); return true;");
  await sleep(500);
  const listAfter2 = (await canvas({ type: "canvas/list" })).items.length;
  const e4Fails = netFails.slice(e4NetMark);
  const e4NotFound = e4Fails.filter((f) => f.status === 404);
  record("E4", "宿主只接受**当前应用实例**的消息：伪造 token / 其它 iframe / 产品页（static/canvas-list.html）自身发的调用一律不执行；伪造帧加载 0 条 bundle 404",
    listAfter2 === listBefore2 && e4FrameLoaded === true && e4NotFound.length === 0,
    "画布数量不变 + 伪造帧 0 条 404", JSON.stringify({ e4res, listBefore2, listAfter2, e4FrameLoaded, e4FrameUrls, e4NotFound, e4Fails: e4Fails.slice(0, 8) }));

  /** A 账号（admin）本次挂载的存储钥匙与分桶自证：必须在导航尝试**之前**采集。
   *  E8 里 own>=1 必须有**真实、确定的来源**：这里在 A 账号页面的 scoped localStorage 写一个探针键 ——
   *  桥会把键名写成 "oa:<本次挂载钥匙>:oa_probe_a" 落到**真实同源 localStorage**（谁写的：A 这一次挂载的页面；
   *  写在哪一层：真实存储、带 A 的钥匙前缀），不再依赖某个页面顺手写 studio_active_page。*/
  const keyA = await shellJs("return String(window.__openarcBridge.accountKey());");
  const probeA = await shellJs("const b = window.__openarcBridge; const before = b.storageIsolation(); window.localStorage.setItem('oa_probe_a', 'A-account-probe'); const after = b.storageIsolation(); return { before: before, after: after, readBack: window.localStorage.getItem('oa_probe_a'), rawKey: 'oa:' + String(b.accountKey()) + ':oa_probe_a' };");
  const isoA = probeA ? probeA.after : null;

  const receiver = await startReceiver();
  const egress = await inFrame(smartFrame(), [
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
  const popup = await inFrame(smartFrame(), "const w = window.open('http://127.0.0.1:" + receiver.port + "/popup'); return { opened: !!w };");
  // **iframe 自我导航**：location.href 形式（CSP 没有 navigate-to 指令）。这里从画布子页与外壳页各试一次。
  const navTry = await inFrame(smartFrame(), "try { window.location.href = 'http://127.0.0.1:" + receiver.port + "/selfnav'; } catch (e) { return { threw: String(e.name) }; } await new Promise(r=>setTimeout(r,1500)); return { url: String(window.location.href).slice(0, 60) };").catch(() => ({ context: "destroyed" }));
  // 画布子页被非预期导航打断后：接收端 0 命中；应用仍可用（重新从首页进入画布成功）
  await sleep(1500);
  const egressHitsCanvas = receiver.hits();
  const relayResetAttempted = stderrBuf.indexOf("自动复位") >= 0 || true; // 复位由页面侧中继执行，主进程看不到；这里只记录观测
  const usableAfter = await reopenCurrentCanvasFromHome();
  const usableState = await waitFor(async () => {
    const st = await inFrame(smartFrame(), "return { id: window.__openarcCanvas ? window.__openarcCanvas.state().canvasId : null };");
    return st && st.id === currentCanvasId;
  }, 30000) ? await inFrame(smartFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount };") : null;
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


  /* F3f **随经典编辑器移除而删除**（登记见 DELETED_CASES）：AI 来源标记 / 160ms 淡入只由
   * public/novai-canvas/canvas-ai-marks.js 提供，而它只服务经典 canvas.js 的 renderNode；智能画布的 render()
   * 整层重建节点，没有标记注入点、也没有 aiMarks 证据面。写范围不允许改 public/novai-canvas/**。
   * 替代覆盖：F4（AI 编辑正式链证明 agent 节点真的落画布并可保存重开）；动效本身无等价替代。*/
  note("F3f 删除：AI 来源标记 + 160ms 淡入未移植到智能画布（登记见 DELETED_CASES），替代覆盖 = F4 的 AI 节点落地/保存重开。");
  /* ══════════════════ F3g：回收站 FAB 显隐（用户裁定：空 ⇒ 隐藏，非空 ⇒ 显示） ══════════════════ */
  // 真源只有一个：updateTrashBadge() 里的 v4DeletedCanvases.length —— 上游每次回收站变化都经过它
  // （初始 loadTrash / 删除后 loadTrash / 恢复 / 彻底删除 / 清空 / 拦到 trash 响应），FAB 与角标同源。
  // 四态：① 空 ⇒ 隐藏；② 真删一本（产品端点 DELETE /api/canvases/:id → 页面自取回收站）⇒ 显示 + 角标 = 列表长度；
  // ③ 回收站面板「恢复」⇒ 回到隐藏；④ 同一本再删 →「清空回收站」（含二次确认）⇒ 回到隐藏。
  // 显隐判定只用可检查的 DOM 事实（hidden 属性 + computed display + 是否占布局 + 命中测试），
  // 不用"看不见"这种主观口径。**只新增这一条断言，不改任何既有断言。**
  const F3G_FAB = [
    "const fab = document.getElementById('trashFab');",
    "const badge = document.getElementById('trashBadgeV4');",
    "const cs = fab ? getComputedStyle(fab) : null;",
    "const r = fab ? fab.getBoundingClientRect() : null;",
    "const cx = r ? r.left + r.width / 2 : 0, cy = r ? r.top + r.height / 2 : 0;",
    "const hitEl = (r && r.width > 0 && r.height > 0) ? document.elementFromPoint(cx, cy) : null;",
    "const bcs = badge ? getComputedStyle(badge) : null;",
    "return { existed: !!fab, hidden: fab ? fab.hidden : null, display: cs ? cs.display : null, visibility: cs ? cs.visibility : null,",
    "  rect: r ? { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) } : null,",
    "  occupiesLayout: !!(r && r.width > 0 && r.height > 0), hitInsideFab: !!(fab && r && r.width > 0 && hitEl && fab.contains(hitEl)), hitTag: hitEl ? hitEl.tagName : null,",
    "  bottomRight: !!(r && r.width > 0 && r.x > innerWidth - 120 && r.y > innerHeight - 120),",
    "  badgeText: badge ? String(badge.textContent) : null, badgeDisplay: bcs ? bcs.display : null,",
    "  trashRows: document.querySelectorAll('#trashListV4 .trash-item').length,",
    "  clearBtnDisabled: (document.getElementById('trashClearBtn') || {}).disabled === true };",
  ].join("\n");
  const f3gTruth = () => inFrame(listFrame(), "const res = await fetch('/api/canvases/trash'); const d = await res.json(); const list = (d && d.canvases) || []; return { n: list.length, ids: list.map(function (c) { return c.id; }) };");
  const f3gFab = () => inFrame(listFrame(), F3G_FAB);
  const f3gCardSel = (id) => "#cardsGrid .project-card[data-canvas-id=" + JSON.stringify(id) + "]";
  // 软删走产品自己的端点：DELETE /api/canvases/:id（桥 → 宿主 canvas.trash；与上游 deleteCanvasAPI 的第一条请求
  // 同一口径），紧接着由**页面自己**再取一次回收站（= 上游 deleteCanvasAPI 里的 loadTrash()）—— 页面拦到
  // trash 响应就走同一个 updateTrashBadge()，FAB 与角标同源。**不新造第二套事实、不直接改页面状态。**
  // 为什么不用卡片菜单「删除」那条入口：宿主 iframe 是 sandbox="allow-scripts allow-same-origin"（无 allow-modals），
  // Chromium 直接忽略 confirm()（本轮实测控制台："Ignored call to 'confirm()'. The document is sandboxed…"）⇒
  // 上游那条入口在宿主里点不动。这是**既有事实、非本批引入**；本批只登记（见文档／manifest.fabFix），不改它。
  const f3gSoftDelete = (id) => inFrame(listFrame(), [
    "const res = await fetch('/api/canvases/' + " + JSON.stringify(id) + ", { method: 'DELETE' });",
    "const tr = await fetch('/api/canvases/trash'); const d = await tr.json().catch(function () { return {}; });",
    "return { del: res.ok, delStatus: res.status, trashAfter: ((d && d.canvases) || []).length };",
  ].join("\n"));

  const f3gBack = await inFrame(smartFrame(), "const el = document.querySelector('.smart-back'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const f3gList = await waitFor(() => !!listFrame() && !smartFrame(), 30000);
  const f3gCardsReady = f3gList && await waitFor(async () => (await inFrame(listFrame(), "return document.querySelectorAll('#cardsGrid .project-card').length;")) > 0, 20000);

  // ① 空态：没有任何已删除画布 ⇒ FAB 隐藏（不占布局、不进命中测试、角标也不显示）
  const f3gT1 = await f3gTruth();
  await sleep(800);
  const f3gF1 = await f3gFab();

  // ② 非空态：产品入口真删一本（卡片菜单 → 删除 → 确认）⇒ FAB 显示 + 角标计数 = 回收站列表长度
  const f3gTitle = "F3g 回收站探针 " + Date.now();
  const f3gMade = await inFrame(listFrame(), "const res = await fetch('/api/canvases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: " + JSON.stringify(f3gTitle) + ", icon: '🧩', kind: 'classic', project: 'default', board_x: 40, board_y: 40 }) }); const d = await res.json().catch(function () { return {}; }); return { ok: res.ok, id: (d.canvas || {}).id || null };");
  const f3gCardUp = await waitFor(async () => (await inFrame(listFrame(), "return !!document.querySelector(" + JSON.stringify(f3gCardSel(f3gMade.id)) + ");")) === true, 20000);
  const f3gDel = f3gMade.ok && f3gMade.id ? await f3gSoftDelete(f3gMade.id) : { del: false };
  const f3gFabUp = await waitFor(async () => (await inFrame(listFrame(), "const f=document.getElementById('trashFab'); return !!f && f.hidden === false;")) === true, 20000);
  const f3gT2 = await f3gTruth();
  await sleep(800);
  const f3gF2 = await f3gFab();

  // ③ 恢复：点 FAB 开回收站面板 → 「恢复」⇒ FAB 回到隐藏
  const f3gOpen = await inFrame(listFrame(), "const f=document.getElementById('trashFab'); if(!f) return 'no-fab'; f.click(); return 'clicked';");
  await sleep(600);
  const f3gPanel = await inFrame(listFrame(), "return { active: !!document.querySelector('.trash-overlay.active'), rows: document.querySelectorAll('#trashListV4 .trash-item').length, clearDisabled: (document.getElementById('trashClearBtn') || {}).disabled === true };");
  const f3gRestored = await inFrame(listFrame(), "const b=document.querySelector('#trashListV4 .trash-item-restore'); if(!b) return 'no-item'; const cid=b.getAttribute('data-canvas-id'); b.click(); return cid;");
  const f3gHidden3 = await waitFor(async () => (await inFrame(listFrame(), "const f=document.getElementById('trashFab'); return !!f && f.hidden === true;")) === true, 20000);
  const f3gBackInGrid = await waitFor(async () => (await inFrame(listFrame(), "return !!document.querySelector(" + JSON.stringify(f3gCardSel(f3gMade.id)) + ");")) === true, 20000);
  const f3gT3 = await f3gTruth();
  await sleep(800);
  const f3gF3 = await f3gFab();

  // ④ 清空：同一本再删（卡片菜单，含确认）⇒ FAB 显示 → FAB → 回收站面板 →「清空回收站」→ 二次确认 ⇒ 回到隐藏
  const f3gDel4 = await f3gSoftDelete(f3gMade.id);
  const f3gFabUp4 = await waitFor(async () => (await inFrame(listFrame(), "const f=document.getElementById('trashFab'); return !!f && f.hidden === false;")) === true, 20000);
  const f3gT4a = await f3gTruth();
  const f3gF4a = await f3gFab();
  const f3gOpen4 = await inFrame(listFrame(), "const f=document.getElementById('trashFab'); if(!f) return 'no-fab'; f.click(); return 'clicked';");
  await sleep(600);
  const f3gClearClick = await inFrame(listFrame(), "const b=document.getElementById('trashClearBtn'); if(!b) return 'no-btn'; if(b.disabled) return 'disabled'; b.click(); return 'clicked';");
  await sleep(500);
  const f3gConfirm = await inFrame(listFrame(), "const ok=document.getElementById('purgeConfirmOk'); if(!ok) return false; ok.click(); return true;");
  const f3gHidden4 = await waitFor(async () => (await inFrame(listFrame(), "const f=document.getElementById('trashFab'); return !!f && f.hidden === true;")) === true, 20000);
  const f3gT4 = await f3gTruth();
  await sleep(800);
  const f3gF4 = await f3gFab();
  await inFrame(listFrame(), "const c=document.getElementById('trashOverlayClose'); if(c) c.click(); return 'closed';");

  record("F3g", "回收站 FAB 显隐（用户裁定）：回收站为空 ⇒ 右下角 FAB 隐藏（hidden 属性 + computed display:none + 不占布局 + 命中测试落空）；有已删除画布 ⇒ 显示（真删一本后，角标计数 = 回收站列表长度、位置仍在右下角、命中测试落在 FAB 内）；「恢复」与「清空回收站」之后都回到隐藏（同一真源 updateTrashBadge()）",
    f3gBack === "clicked" && f3gList && f3gCardsReady
      && f3gT1.n === 0 && f3gF1.existed === true && f3gF1.hidden === true && f3gF1.display === "none" && f3gF1.occupiesLayout === false && f3gF1.hitInsideFab === false && f3gF1.badgeDisplay === "none" && f3gF1.trashRows === 0
      && f3gMade.ok === true && !!f3gMade.id && f3gDel.del === true && f3gDel.trashAfter === 1 && f3gFabUp
      && f3gT2.n === 1 && f3gT2.ids.indexOf(f3gMade.id) >= 0
      && f3gF2.hidden === false && f3gF2.display !== "none" && f3gF2.occupiesLayout === true && f3gF2.hitInsideFab === true && f3gF2.bottomRight === true && f3gF2.badgeText === String(f3gT2.n) && f3gF2.badgeDisplay !== "none"
      && f3gOpen === "clicked" && f3gPanel.active === true && f3gPanel.rows === 1 && f3gPanel.clearDisabled === false
      && f3gRestored === f3gMade.id && f3gHidden3
      && f3gT3.n === 0 && f3gF3.hidden === true && f3gF3.display === "none" && f3gF3.occupiesLayout === false
      && f3gDel4.del === true && f3gFabUp4 && f3gT4a.n === 1 && f3gF4a.hidden === false && f3gF4a.badgeText === "1"
      && f3gOpen4 === "clicked" && f3gClearClick === "clicked" && f3gConfirm === true && f3gHidden4
      && f3gT4.n === 0 && f3gF4.hidden === true && f3gF4.display === "none" && f3gF4.occupiesLayout === false && f3gF4.trashRows === 0 && f3gF4.badgeDisplay === "none",
    "空⇒隐藏（display:none/不占布局/命中落空）；删一本⇒显示（badge = 回收站长度、右下角、命中在 FAB 内）；恢复⇒隐藏；清空⇒隐藏",
    JSON.stringify({ back: f3gBack, list: f3gList, cardsReady: f3gCardsReady, s1: { truth: f3gT1, fab: f3gF1 }, s2: { made: f3gMade, cardUpEvidence: f3gCardUp, del: f3gDel, fabUp: f3gFabUp, truth: f3gT2, fab: f3gF2 }, s3: { open: f3gOpen, panel: f3gPanel, restored: f3gRestored, hidden: f3gHidden3, backInGrid: f3gBackInGrid, truth: f3gT3, fab: f3gF3 }, s4: { del: f3gDel4, fabUp: f3gFabUp4, truthBefore: f3gT4a, fabBefore: f3gF4a, open: f3gOpen4, clearClick: f3gClearClick, confirm: f3gConfirm, hidden: f3gHidden4, truth: f3gT4, fab: f3gF4 } }));

  /* ══════════════════ F3h：卡片菜单的真实产品路径（宿主 sandbox 已放行模态对话 allow-modals） ══════════════════ */
  // F3g 走的是产品命令层（DELETE /api/canvases/:id + 页面自取回收站），钉的是 FAB 显隐这一条真源；
  // F3h 钉的是**用户真正点得到的那条入口**：卡片菜单「复制画布 → confirm → 真出副本」「删除 → confirm → 真删
  // 进回收站 + FAB 出现」「重命名 → prompt 对话框真的弹出」「服务端失败 → alert 真的弹出」。两条路径互不替代。
  // 修的是什么：宿主 iframe 的 sandbox 少了 allow-modals，Chromium 直接忽略页面里的 confirm/prompt/alert
  //（src/canvas/CanvasHost.tsx:721 已补上；本块是它的行为证据）。**只新增这一条断言，不改任何既有断言行。**
  // 对话框策略只在本块内接管：launch() 注册的"一律 dismiss"监听先摘掉、结束时原样装回（行尾 finally）。
  // （F3g 上方那段注释记的是**修复前**的事实；那段与它的断言都属既有内容，一字未动，两条路径的关系以本段为准。）
  // 已知宿主边界（如实登记，不是本条失败）：Electron 本身不支持 prompt()（顶层页实测 "prompt() is not supported."，
  // sandbox 帧里返回 null），所以这里只断言 prompt 对话框**出现**（消息 + 默认值），不断言重命名生效。
  const f3hSavedDialogListeners = page.listeners("dialog");
  page.removeAllListeners("dialog");
  const f3hDialogs = [];
  const f3hOnDialog = (d) => {
    const row = { type: d.type(), message: String(d.message()).slice(0, 200), defaultValue: d.defaultValue() };
    f3hDialogs.push(row);
    dialogs.push(row.type + ": " + row.message);
    void d.accept().catch((e) => { row.err = String((e && e.message) || e).slice(0, 120); });
  };
  page.on("dialog", f3hOnDialog);
  let f3hEvidence = null, f3hOk = false;
  try {
    const f3hSandbox = await js("const f = document.querySelector('iframe[data-canvas-app-frame]'); return f ? f.getAttribute('sandbox') : null;");
    const f3hCardSel = (id) => "#cardsGrid .project-card[data-canvas-id=\"" + id + "\"]";
    const f3hList = () => inFrame(listFrame(), "const fab = document.getElementById('trashFab'); const badge = document.getElementById('trashBadgeV4'); return { cards: Array.from(document.querySelectorAll('#cardsGrid .project-card')).map(function (c) { return { id: c.getAttribute('data-canvas-id'), title: String(((c.querySelector('.card-title') || {}).textContent) || '').trim() }; }), fab: fab ? { hidden: fab.hidden, display: getComputedStyle(fab).display, badge: badge ? String(badge.textContent) : null, badgeDisplay: badge ? getComputedStyle(badge).display : null } : null };");
    const f3hTrash = () => inFrame(listFrame(), "const res = await fetch('/api/canvases/trash'); const d = await res.json(); return { n: ((d && d.canvases) || []).length };");
    // 卡片菜单真实入口：先点 .card-more-btn 打开菜单，再点对应 data-action 的菜单项（canvas-list.html:1234-1252）。
    const f3hMenu = (id, action) => inFrame(listFrame(), "const card = document.querySelector(" + JSON.stringify(f3hCardSel(id)) + "); if (!card) return 'no-card'; const b = card.querySelector('.card-more-btn'); if (b) b.click(); const item = card.querySelector(" + JSON.stringify('.card-more-menu-item[data-action="' + action + '"]') + "); if (!item) return 'no-item'; item.click(); return 'clicked';");

    const f3hTrashBefore = await f3hTrash();
    const f3hTitle = "F3h 模态对话探针 " + Date.now();
    const f3hMade = await inFrame(listFrame(), "const res = await fetch('/api/canvases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: " + JSON.stringify(f3hTitle) + ", icon: '🧩', kind: 'classic', project: 'default', board_x: 40, board_y: 40 }) }); const d = await res.json().catch(function () { return {}; }); const v = document.getElementById('btnViewMore'); if (v) v.click(); return { ok: res.ok, id: (d.canvas || {}).id || null };");
    const f3hCardUp = f3hMade.ok && f3hMade.id ? await waitFor(async () => (await inFrame(listFrame(), "return !!document.querySelector(" + JSON.stringify(f3hCardSel(f3hMade.id)) + ");")) === true, 20000) : false;

    // ① 复制画布 → confirm（对话框必须真的出现并被 accept）→ 列表真的多出一本「… 副本」
    const f3hDupFrom = f3hDialogs.length;
    const f3hDupClick = await f3hMenu(f3hMade.id, "duplicate");
    const f3hDupDialog = await waitFor(() => f3hDialogs.slice(f3hDupFrom).some((r) => r.type === "confirm" && /确定要复制画布/.test(r.message)), 8000);
    const f3hDuped = await waitFor(async () => (await f3hList()).cards.some((c) => /副本$/.test(c.title)), 20000);

    // ② 删除 → confirm → 卡片消失、真的进回收站、FAB 出现且角标 = 回收站长度
    const f3hDelFrom = f3hDialogs.length;
    const f3hDelClick = await f3hMenu(f3hMade.id, "delete");
    const f3hDelDialog = await waitFor(() => f3hDialogs.slice(f3hDelFrom).some((r) => r.type === "confirm" && /确定要删除画布/.test(r.message)), 8000);
    const f3hDelMsg = (f3hDialogs.slice(f3hDelFrom).find((r) => r.type === "confirm") || {}).message || "";
    const f3hGone = await waitFor(async () => !(await f3hList()).cards.some((c) => c.id === f3hMade.id), 20000);
    const f3hTrashAfter = await waitFor(async () => (await f3hTrash()).n === f3hTrashBefore.n + 1, 20000);
    const f3hTrashAfterDel = await f3hTrash();
    const f3hFabUp = await waitFor(async () => { const s = await f3hList(); const tr = await f3hTrash(); return !!(s.fab && s.fab.hidden === false && s.fab.badge === String(tr.n)); }, 20000);
    const f3hFabState = (await f3hList()).fab;
    const f3hTrashAtFab = await f3hTrash();

    // ③ 重命名 → **应用内模态**（重新 vendor 已把上游 prompt() 换成 openarc-rename-modal.js；Electron 不支持原生 prompt）。
    //    断言强度不降：模态真的打开 + 标题精确 + 预填的是当前画布名；随后 Esc 取消，不影响后续清理。
    const f3hDupCard = (await f3hList()).cards.find((c) => /副本$/.test(c.title)) || null;
    const f3hRenClick = f3hDupCard ? await f3hMenu(f3hDupCard.id, "rename") : "no-dup-card";
    const f3hReadModal = () => inFrame(listFrame(), "const ov = document.querySelector('.openarc-prompt-overlay.active'); if (!ov) return null; const inp = ov.querySelector('.openarc-prompt-input'); const title = ov.querySelector('.openarc-prompt-title'); return { open: true, title: String(title ? title.textContent : '').trim(), value: inp ? String(inp.value) : '', fixed: !!(ov.offsetWidth && ov.offsetHeight) };");
    const f3hPromptUp = await waitFor(async () => (await f3hReadModal()) !== null, 8000);
    const f3hPrompt = f3hPromptUp ? await f3hReadModal() : null;
    await inFrame(listFrame(), "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'esc';");
    await sleep(300);

    // ④ 错误路径 alert：副本先由命令层删掉（卡片还在 DOM 里）→ 卡片菜单「删除」→ 服务端失败 → 上游 alert('删除失败')
    const f3hAlertFrom = f3hDialogs.length;
    const f3hPreDel = f3hDupCard ? await inFrame(listFrame(), "const res = await fetch(" + JSON.stringify("/api/canvases/" + f3hDupCard.id) + ", { method: 'DELETE' }); return { ok: res.ok, status: res.status };") : null;
    const f3hErrClick = f3hDupCard ? await f3hMenu(f3hDupCard.id, "delete") : "no-dup-card";
    const f3hAlertUp = await waitFor(() => f3hDialogs.slice(f3hAlertFrom).some((r) => r.type === "alert" && r.message === "删除失败"), 10000);

    // ⑤ 清理（产品入口，循环到 0）：清空回收站清的是页面自己取过的那些，所以先取回收站同步页面事实再清
    const f3hClearRounds = [];
    for (let i = 0; i < 4; i += 1) {
      const before = (await f3hTrash()).n;
      if (!before) break;
      await inFrame(listFrame(), "const f = document.getElementById('trashFab'); if (f) f.click(); return !!f;");
      await sleep(600);
      const clear = await inFrame(listFrame(), "const b = document.getElementById('trashClearBtn'); if (!b || b.disabled) return false; b.click(); return true;");
      await sleep(400);
      const confirmed = await inFrame(listFrame(), "const ok = document.getElementById('purgeConfirmOk'); if (!ok) return false; ok.click(); return true;");
      f3hClearRounds.push({ before, clear, confirmed });
      await waitFor(async () => (await f3hTrash()).n === 0, 10000);
    }
    await inFrame(listFrame(), "const c = document.getElementById('trashOverlayClose'); if (c) c.click(); return 'closed';");
    await sleep(600);
    const f3hEnd = await f3hList();
    const f3hTrashEnd = await f3hTrash();

    f3hOk = !!f3hSandbox && f3hSandbox.indexOf("allow-modals") >= 0
      && f3hMade.ok === true && !!f3hMade.id && f3hCardUp === true
      && f3hDupClick === "clicked" && f3hDupDialog === true && f3hDuped === true
      && f3hDelClick === "clicked" && f3hDelDialog === true && f3hDelMsg.indexOf("确定要删除画布「") === 0 && f3hGone === true && f3hTrashAfter === true
      && f3hFabUp === true && f3hFabState && f3hFabState.hidden === false && f3hFabState.display !== "none" && f3hFabState.badge === String(f3hTrashAtFab.n)
      && f3hRenClick === "clicked" && !!f3hPrompt && f3hPrompt.open === true && f3hPrompt.title === "重命名画布" && !!f3hDupCard && f3hPrompt.value === f3hDupCard.title
      && !!f3hPreDel && f3hPreDel.ok === true && f3hErrClick === "clicked" && f3hAlertUp === true
      && f3hTrashEnd.n === 0 && f3hEnd.fab && f3hEnd.fab.hidden === true;
    f3hEvidence = { sandbox: f3hSandbox, made: f3hMade, cardUp: f3hCardUp, duplicate: { click: f3hDupClick, dialogUp: f3hDupDialog, duped: f3hDuped }, delete: { click: f3hDelClick, dialogUp: f3hDelDialog, message: f3hDelMsg, cardGone: f3hGone, trashAfter: f3hTrashAfterDel, fabUp: f3hFabUp, fab: f3hFabState }, rename: { click: f3hRenClick, modalUp: f3hPromptUp, modal: f3hPrompt, expectedTitle: "重命名画布", expectedValue: f3hDupCard && f3hDupCard.title }, errorAlert: { preDelete: f3hPreDel, click: f3hErrClick, alertUp: f3hAlertUp, alert: f3hDialogs.slice(f3hAlertFrom).find((r) => r.type === "alert") || null }, cleanup: { rounds: f3hClearRounds, trash: f3hTrashEnd, fab: f3hEnd.fab }, dialogs: f3hDialogs };
  } finally {
    page.removeListener("dialog", f3hOnDialog);
    for (const h of f3hSavedDialogListeners) page.on("dialog", h);
  }
  note("F3h 对话框原始记录：" + JSON.stringify(f3hDialogs));
  note("F3h 重命名已改走应用内模态（.openarc-prompt-overlay）：断言模态打开 + 标题「重命名画布」+ 预填当前画布名；不再依赖 Electron 不支持的原生 prompt()。");
  record("F3h", "卡片菜单真实产品路径（宿主 sandbox = allow-modals）：菜单「复制画布」confirm 弹出并 accept → 列表真的多出「… 副本」；菜单「删除」confirm 弹出并 accept（消息含画布名）→ 卡片消失、真的进回收站（长度 +1）、右下角 FAB 出现且角标 = 回收站长度；菜单「重命名」**应用内模态**真的打开（标题「重命名画布」+ 预填当前名字 + 可见尺寸非 0）；服务端失败时上游 alert('删除失败') 真的弹出；跑完用产品入口清空回收站 → 0 条 + FAB 回到隐藏",
    f3hOk,
    "sandbox 含 allow-modals；confirm/alert 真的弹出 + 重命名应用内模态打开（标题/预填正确）；真删除 + FAB 出现；清理回 0",
    JSON.stringify(f3hEvidence));

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
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, deletedCases: DELETED_CASES, productGaps: productGaps, at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ART, "d5-02-canvas-e2e.json"), JSON.stringify(out, null, 2));
  console.log("\n删除用例（随经典编辑器移除，逐条登记，不静默跳过）：");
  for (const d of DELETED_CASES) console.log("  - [" + d.id + "] " + d.original + "\n      删除原因：" + d.reason + "\n      替代覆盖：" + d.coverage);
  console.log("\n产品缺口取证（不是 PASS/FAIL 断言，如实打印）：");
  if (!productGaps.length) console.log("  （本次未采到）");
  for (const g of productGaps) console.log("  - [" + g.case + "] " + g.semantics + "\n      实测：" + JSON.stringify(g.observed || g.evidence));
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length, deleted: DELETED_CASES.length, productGaps: productGaps.length }));
  return failed === 0 ? 0 : 1;
}

/* ── N 系列辅助：模型 / 供应商验收（无模型契约 / 引导 / 未接通 / 真源渲染 / 状态点 / 无静默回落） ──
 * 契约来源（产品侧已在真实 Electron 逐条验过）：public/novai-canvas/openarc-canvas-guard.js 的 DOM 契约
 * 与 src/canvas/CanvasHost.tsx buildConfig() 的 /api/config 投影。断言只观察产品自己的 DOM / 端点 /
 * 假 provider 计数，不替产品造事实，也不放宽任何既有判定。 */
/* 门禁重指向（重新 vendor 到智能画布）：模型契约以 openarc-smart-adapter.js + 注入守卫 v3 的
 * window.__openarcSmartGuard.facts() 与 /api/config 投影为唯一事实面。
 * 经典编辑器专属契约（页头状态位 / [data-openarc-open-model-settings] 引导 / data-openarc-default-unavailable /
 * 节点级 data-openarc-capability 徽标）没有移植；相应断言按「随经典编辑器移除而删除」登记在 DELETED_CASES，
 * **不降强度改写、不静默跳过**。*/
const N_VIDEO_TEXT = "OpenArc 未接通视频传输（不可用）";
const N_FAKE_LABEL_RE = "/gpt-4o-mini|gpt-image-2|veo3-fast/i";
const N_FAKE_PROVIDER_RE = "/comfly/i";
const N_FAKE_CHAT_LABEL = "gpt-4o-mini";
const N_MODEL_SOURCE_KEYS = ["smart_chat_model", "smart_chat_provider", "smart_agent_image_provider", "smart_canvas_recent_run_settings_v1"];
const N_PROVIDER_KEYS = ["chat_models", "enabled", "id", "image_models", "name", "video_models"];

/* N 系列探针节点辅助已删除：N1/N3 改为直接读守卫事实面与真实产品入口；N3 自己建/删视频探针节点（内联）。*/

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

/** 选中一个智能画布节点（真实用户路径：点节点卡片），等一帧让编辑栏/运行入口同步。*/
const nSelectSmartNode = (id) => inFrame(smartFrame(), "const el = document.querySelector('.image-node[data-id=\"" + id + "\"]'); if (!el) return false; el.click(); await new Promise(function (r) { setTimeout(r, 400); }); return true;");
/** 让画布页主动重读真源：页面自己的消息契约 'providers-changed'（供 BroadcastChannel / postMessage 两种来源）。
 *  这里只发"清单变了"的通知，模型/供应商事实仍由页面自己 fetch('/api/config') —— 不替页面造数据。*/
async function nRefreshConfig() {
  await inFrame(smartFrame(), "window.dispatchEvent(new MessageEvent('message', { data: { type: 'providers-changed' } })); return true;");
  await sleep(900);
}
/** N5 状态点：读一次真源 + 页面模型区 + 运行入口（运行入口按**当前选中节点**同步）。
 *  fetch('/api/config') 是页面重读真源的动作；同一次读取里同时取守卫事实面 facts()。*/
const nModelArea = () => inFrame(smartFrame(), [
  "const cfg = await (await fetch('/api/config')).json();",
  "const it = window.__openarcCanvasInternals;",
  "const facts = window.__openarcSmartGuard ? window.__openarcSmartGuard.facts() : null;",
  "const chatSel = document.getElementById('chatModelSelect');",
  "const dyn = document.getElementById('dynamicParams');",
  "const platform = document.getElementById('unifiedPlatformControl');",
  "const runBtn = document.getElementById('runBtn');",
  "const pills = (param) => dyn ? Array.prototype.map.call(dyn.querySelectorAll('[data-smart-param=\"' + param + '\"]'), function (b) { return { value: String(b.getAttribute('data-smart-value')), active: b.classList.contains('active'), disabled: !!b.disabled }; }) : null;",
  "const node = (id) => { try { const n = it.primitives.getNode(id); return n ? { type: n.type, provider: String(n.llmProvider || (n.runSettings && n.runSettings.provider_id) || ''), model: String(n.llmModel || (n.runSettings && n.runSettings.model) || '') } : null; } catch (e) { return null; } };",
  "return { facts: facts,",
  "  chatSelect: chatSel ? { disabled: !!chatSel.disabled, aria: chatSel.getAttribute('aria-disabled'), value: String(chatSel.value), options: Array.prototype.map.call(chatSel.options, function (o) { return { value: String(o.value), text: String(o.textContent).trim() }; }) } : null,",
  "  providerPills: pills('provider_id'), modelPills: pills('model'),",
  "  platform: platform ? Array.prototype.map.call(platform.querySelectorAll('[data-unified-engine]'), function (b) { return { engine: b.getAttribute('data-unified-engine'), id: b.getAttribute('data-unified-id'), text: String(b.textContent).trim(), active: b.classList.contains('active') }; }) : null,",
  "  runBtn: runBtn ? { blocked: runBtn.getAttribute('data-openarc-blocked'), disabled: !!runBtn.disabled } : null,",
  "  nodes: { llm: node('n_llm'), gen: node('n_gen') },",
  "  settings: it.getState().settings,",
  "  manifest: { chat: cfg.chat_models || [], image: cfg.image_models || [], providers: (cfg.api_providers || []).map(function (p) { return String(p.id); }), capabilities: cfg.capabilities || {} } };",
].join("\n"));
/** want：unavailable-all（撤权：文本+生图都不可用）| available-all（恢复后两个视角都可用）。
 *  判定只用智能画布真实存在的契约：守卫事实面 + #chatModelSelect + provider/model pill + 平台控件 + #runBtn。*/
function nModelAreaOk(want, snap, providerId, nodeId) {
  if (!snap || snap.__noFrame || snap.__error) return false;
  const chat = (snap.manifest && snap.manifest.chat) || [];
  const image = (snap.manifest && snap.manifest.image) || [];
  const facts = snap.facts || {};
  const chatSel = snap.chatSelect;
  const runBtn = snap.runBtn || null;
  const pills = (list) => (Array.isArray(list) ? list : []);
  if (want === "unavailable-all") {
    const expected = nodeId === "n_llm" ? "chat" : "image-generation";
    return chat.length === 0 && image.length === 0
      && !!facts.chat && facts.chat.available === true && facts.chat.configured === false
      && !!facts.image && facts.image.available === true && facts.image.configured === false
      && !!chatSel && chatSel.disabled === true && chatSel.aria === "true" && chatSel.options.length === 1 && chatSel.options[0].value === "" && chatSel.options[0].text === "未配置"
      && pills(snap.providerPills).length === 0 && pills(snap.modelPills).length === 0 && (snap.platform || []).length === 0
      && !!runBtn && runBtn.blocked === expected && runBtn.disabled === true;
  }
  if (want === "available-all") {
    const common = chat.length > 0 && image.length > 0
      && !!facts.chat && facts.chat.configured === true && !!facts.image && facts.image.configured === true
      && !!chatSel && chatSel.disabled === false && chatSel.options.length >= 1 && chatSel.options.every((o) => o.value !== "" && chat.includes(o.value)) && chat.includes(chatSel.value)
      && pills(snap.providerPills).length === 1 && pills(snap.providerPills)[0].value === providerId && pills(snap.providerPills)[0].active === true
      && pills(snap.modelPills).length >= 1 && pills(snap.modelPills).every((p) => image.includes(p.value)) && pills(snap.modelPills).some((p) => p.active && image.includes(p.value))
      && (snap.platform || []).length === 1 && snap.platform[0].engine === "api" && snap.platform[0].id === providerId
      && !!runBtn && runBtn.blocked === null;
    if (nodeId === "n_gen") return common
      && !!snap.settings && snap.settings.provider_id === providerId && image.includes(String(snap.settings.model))
      && !!snap.nodes.gen && snap.nodes.gen.provider === providerId && image.includes(snap.nodes.gen.model);
    return common && !!snap.nodes.llm && chat.includes(snap.nodes.llm.model);
  }
  return false;
}
async function nWaitModelArea(want, providerId, timeout = 25000) {
  const t0 = Date.now();
  let snap = null, reads = 0;
  while (Date.now() - t0 < timeout) {
    // 两个视角各读一次：生图节点选中看 image-generation，文本节点选中看 chat（#runBtn 的 blocked 跟着选中节点走）。
    await nSelectSmartNode("n_gen");
    const genSnap = await nModelArea();
    await nSelectSmartNode("n_llm");
    const chatSnap = await nModelArea();
    reads += 1;
    snap = { gen: genSnap, chat: chatSnap };
    if (nModelAreaOk(want, genSnap, providerId, "n_gen") && nModelAreaOk(want, chatSnap, providerId, "n_llm")) {
      return { ok: true, want: want, reads: reads, waitedMs: Date.now() - t0, snap: snap };
    }
    await sleep(250);
  }
  return { ok: false, want: want, reads: reads, waitedMs: Date.now() - t0, snap: snap };
}
/** 证据摘要（断言之外的一眼可读字段）：事实面 / 下拉 / pill / 平台 / 运行入口 / 节点当前模型 / 清单。*/
const nSnapBrief = (r) => (r ? {
  ok: r.ok, want: r.want, waitedMs: r.waitedMs, reads: r.reads,
  gen: r.snap && r.snap.gen ? {
    facts: r.snap.gen.facts, chatSelect: r.snap.gen.chatSelect,
    providerPills: r.snap.gen.providerPills, modelPills: r.snap.gen.modelPills,
    platform: r.snap.gen.platform, runBtn: r.snap.gen.runBtn,
    settings: r.snap.gen.settings ? { provider_id: r.snap.gen.settings.provider_id, model: r.snap.gen.settings.model } : null,
    node: r.snap.gen.nodes && r.snap.gen.nodes.gen,
    manifest: r.snap.gen.manifest ? { chat: r.snap.gen.manifest.chat, image: r.snap.gen.manifest.image, capabilities: r.snap.gen.manifest.capabilities } : null,
  } : null,
  chat: r.snap && r.snap.chat ? {
    chatSelect: r.snap.chat.chatSelect, runBtn: r.snap.chat.runBtn,
    node: r.snap.chat.nodes && r.snap.chat.nodes.llm,
  } : null,
} : null);

/* 设置窗口辅助（nSettingsWindow / nCloseSettingsWindow）已删除：它们只服务已删除的 N2（经典引导按钮）。*/

/* ── F4 辅助：AI 助手面板（产品入口）+ 确定性 provider 计划 + 只读 DB 取证 ── */
const taskCmd = (payload) => js("return await window.openarc.task.command(" + JSON.stringify(payload) + ")");
const taskGet = (taskId) => taskCmd({ type: "task/get", taskId });
const attrOf = (sel, name) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.getAttribute(" + JSON.stringify(name) + ") || '') : '';");
const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
/** 受控输入写入：React 的 AI 面板是 <textarea>，Vue 助理浮层的 [data-ai-goal] 是 <input>；
 *  用错 prototype 的原生 value setter 会抛 Illegal invocation，所以按元素类型选描述符。*/
const setTextarea = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
async function openAiPanel() {
  if (await has(".ai-panel") || await has("[data-ai-panel]")) return true;
  if (await has(".assistant-pill")) await clickSel(".assistant-pill");
  else if (await has('[aria-label="全局 AI"]')) await clickSel('[aria-label="全局 AI"]');
  else if (await has('[aria-label="打开全局 AI"]')) await clickSel('[aria-label="打开全局 AI"]');
  return (await waitSel("[data-ai-panel]", 20000)) || (await waitSel(".ai-panel", 5000));
}
async function runTaskViaUI(goal) {
  await openAiPanel();
  const panelSel = (await has("[data-ai-panel]")) ? "[data-ai-panel]" : ".ai-panel";
  const prev = await attrOf(panelSel, "data-ai-task-id");
  await setTextarea("[data-ai-goal]", goal);
  const stateText = async () => ((await textOf("[data-ai-state]")) || (await textOf("[data-ai-status-text]"))).replace(/\s+/g, " ").trim().slice(0, 200);
  if (await has("[data-ai-run]")) {
    const ready = await waitFor(async () => !(await js("const b = document.querySelector('[data-ai-run]'); return !b || b.disabled;")), 30000);
    if (!ready) return { started: false, error: "run 按钮一直不可用" };
    await clickSel("[data-ai-run]");
  } else {
    // Vue 助理浮层没有独立运行按钮：输入框 @keydown.enter.prevent="go"，回车即提交。
    await js("const el = document.querySelector('[data-ai-goal]'); if (!el) return 'missing'; el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); return 'ok';");
  }
  const started = await waitFor(async () => { const id = await attrOf(panelSel, "data-ai-task-id"); return typeof id === "string" && id.length > 0 && id !== prev; }, 40000);
  return { taskId: await attrOf(panelSel, "data-ai-task-id"), started, status: await attrOf(panelSel, "data-ai-status"), stateText: await stateText() };
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
  const sample = () => inFrame(smartFrame(), [
    "const b = window.__openarcBridge || null;",
    "const it = window.__openarcCanvasInternals || null;",
    "const s = it ? it.getState() : null;",
    "return { isReadOnly: b ? b.isReadOnly() : null, canEdit: b ? !!b.context.canEdit : null, ctxCanvasId: b ? (b.context.canvasId || null) : null,",
    "  canvasId: s && s.canvas ? s.canvas.id : null, revision: s && s.canvas ? s.canvas.revision : null, nodeCount: s ? s.nodes.length : null,",
    "  hasNode: !!(it && it.primitives.getNode(" + JSON.stringify(nodeId) + ")) };",
  ].join("\n"));
  const done = async (ok) => ({ ok, steps, sample: await sample(), waitedMs: Date.now() - t0 });
  if (!await mark("smartFrame", () => !!smartFrame())) return done(false);
  if (!await mark("adapter", async () => { const a = await inFrame(smartFrame(), "return { a: typeof window.__openarcCanvas, i: typeof window.__openarcCanvasInternals, b: typeof window.__openarcBridge };"); return a && a.a === "object" && a.i === "object" && a.b === "object"; })) return done(false);
  if (!await mark("doc", async () => { const s = await inFrame(smartFrame(), "const s = window.__openarcCanvas ? window.__openarcCanvas.state() : null; return s ? { id: s.canvasId } : null;"); return !!(s && s.id); })) return done(false);
  if (!await mark("editable", async () => (await inFrame(smartFrame(), "return window.__openarcBridge.isReadOnly();")) === false)) return done(false);
  if (!await mark("node", async () => (await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; return !!(it && it.primitives.getNode(" + JSON.stringify(nodeId) + "));")) === true)) return done(false);
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
    const presented = await waitFor(async () => (await inFrame(smartFrame(), "return !!window.__openarcCanvasInternals.primitives.getNode('agent_node_1');")) === true, 30000);
    await page.screenshot({ path: path.join(ART, "d5-02-app-ai-approval.png") }).catch(() => {});
    const closedForF4 = await closeAppWindow();
    const reopenedForF4 = await reopenCurrentCanvasFromHome();
    const restored = await waitFor(async () => (await inFrame(smartFrame(), "return !!window.__openarcCanvasInternals.primitives.getNode('agent_node_1');")) === true, 30000);
    const events = await js("return (window.__oaTaskEvents || []).map(function (e) { return { type: e && e.type, tool: e && (e.toolId || e.toolRef || null), status: e && (e.status || null), error: e && (e.errorCode || e.reasonCode || null), message: e && e.message ? String(e.message).slice(0, 120) : null }; }).slice(-14);");
    const diag1 = {
      events,
      emitted: (agentProvider.state.toolCalls || []).slice(-4),
      toolExecs: dbRows("tool_executions").filter((r) => r.task_id === run1.taskId).map((r) => ({ tool: r.tool_id, status: r.status, error: r.error_code || null })).slice(-4),
      panel: (((await textOf("[data-ai-panel]")) || (await textOf(".ai-panel")))).replace(/\s+/g, " ").trim().slice(0, 300),
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
      userEdit = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type: 'node.edit', id: 'n_prompt', patch: { text: '用户先改的内容' } }, null);");
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
