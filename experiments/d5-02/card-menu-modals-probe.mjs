/**
 * D5-02 · 宿主 sandbox 模态对话探针（allow-modals）—— 卡片菜单「删除 / 重命名 / 复制画布」真实产品路径。
 *
 * 为什么单开一个探针而不是并进门禁：门禁 canvas-e2e.mjs 的对话框监听**一律 dismiss**（既有行为，一行不动），
 * 而这里必须**真的接受** confirm / prompt 才能走完上游卡片菜单的写路径。探针自己起 electron
 * （隔离 userData + 独立 CDP 端口，不碰门禁进程），只观察产品自己的 DOM / 端点 / 对话框事件。
 *
 *   node experiments/d5-02/card-menu-modals-probe.mjs --phase=pre    # 未加 allow-modals 的 dist（对照）
 *   node experiments/d5-02/card-menu-modals-probe.mjs --phase=post   # 加了 allow-modals 的 dist
 *
 * 证据：artifacts/d5-02/modals/<phase>-*.png、artifacts/d5-02/modals/<phase>-evidence.json
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "d5-02", "modals");
const PHASE = (process.argv.find((a) => a.startsWith("--phase=")) || "--phase=post").split("=")[1];
const CDP_PORT = Number(process.env.OA_MODALS_CDP_PORT || (PHASE === "pre" ? 9797 : 9798));
const ADMIN = { id: "admin@d5-02-modals.test", pw: "modals-admin-1" };
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EVIDENCE = { phase: PHASE, steps: {}, dialogs: [], consoleModals: [], consoleAll: [], screenshots: [], facts: {} };
let child = null, browser = null, page = null, stderrBuf = "";

const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
async function waitFor(fn, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 240) }; }
}
const shot = async (name) => { const p = path.join(ART, PHASE + "-" + name + ".png"); await page.screenshot({ path: p }).catch(() => {}); EVIDENCE.screenshots.push(p); return p; };

/** 对话框策略：pre/post 两阶段都要「记下 message 并接受」，pre 阶段期望根本收不到事件。 */
const dialogs = [];
let dialogPolicy = "accept";
let promptText = null;
/** accept 的延迟（ms）：0 = 在 dialog 事件里同步 accept。诊断模式用它排除"同步 accept 与浏览器竞争"的假设。*/
let dialogAcceptDelayMs = 0;

async function launch() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d516-"));
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
  page.on("dialog", (d) => {
    const row = { type: d.type(), message: String(d.message()).slice(0, 300), defaultValue: d.defaultValue() };
    dialogs.push(row);
    console.log("   [dialog] " + row.type + " · " + row.message);
    if (dialogPolicy === "accept") {
      const doAccept = () => void d.accept(promptText == null ? undefined : promptText)
        .then(() => { row.accepted = true; })
        .catch((e) => { row.err = String((e && e.message) || e).slice(0, 160); });
      if (dialogAcceptDelayMs > 0) setTimeout(doAccept, dialogAcceptDelayMs); else doAccept();
    } else void d.dismiss().catch(() => {});
  });
  page.on("console", (m) => {
    const t = m.text();
    EVIDENCE.consoleAll.push(m.type() + ": " + t.slice(0, 200));
    if (/Ignored call to|sandboxed/i.test(t)) EVIDENCE.consoleModals.push(m.type() + ": " + t.slice(0, 240));
  });
  page.on("pageerror", (e) => EVIDENCE.consoleAll.push("pageerror: " + String(e.message).slice(0, 200)));
}

async function wizardAndLogin() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const setupNext = async () => {
      await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000);
      await clickDom('[data-d3-id="setup-next"]');
    };
    await setInput('[data-d3-id="setup-name"]', "D5-02 Modals");
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
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}

async function openAppWindow() {
  await js("const el = document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]'); if (el) el.click(); return !!el;");
  return await waitFor(() => has("[data-canvas-host]"), 20000);
}

const listStateRaw = () => inFrame(listFrame(), [
  "const cards = Array.from(document.querySelectorAll('#cardsGrid .project-card'));",
  "const fab = document.getElementById('trashFab');",
  "const badge = document.getElementById('trashBadgeV4');",
  "const cs = fab ? getComputedStyle(fab) : null;",
  "return { cards: cards.length, ids: cards.map(function (c) { return c.getAttribute('data-canvas-id'); }),",
  "  titles: cards.map(function (c) { return (c.querySelector('.card-title') || {}).textContent ? c.querySelector('.card-title').textContent.trim() : null; }),",
  "  fab: fab ? { hidden: fab.hidden, display: cs.display, badge: badge ? String(badge.textContent) : null, badgeDisplay: badge ? getComputedStyle(badge).display : null } : null,",
  "  menuOpen: !!document.querySelector('.card-more-menu.active'),",
  "  trashRows: document.querySelectorAll('#trashListV4 .trash-item').length };",
].join("\n"));
/** 帧不在（导航 / 整帧重置那一瞬）时给一份空事实，避免把"读不到"当成崩溃。*/
const listState = async () => { const s = await listStateRaw(); if (!s || !s.ids) return { nodes: s, cards: 0, ids: [], titles: [], fab: null }; return s; };
/** 页面可交互信号：canvas-list.html 的主脚本在文档末尾（同步 <script>），readyState 不再是 loading
 *  才说明按钮的 click 处理器已经挂上（踩过的坑：只等帧 URL 就点，等于点在没有处理器的按钮上）。*/
const appState = () => inFrame(listFrame(), "return { rs: document.readyState, btnNew: !!document.getElementById('btnNewProject'), bridge: typeof window.__openarcBridge, cards: document.querySelectorAll('#cardsGrid .project-card').length };");
const waitAppReady = async () => { const ok = await waitFor(async () => { const s = await appState(); return !!(s && s.rs && s.rs !== "loading" && s.btnNew === true); }, 30000); return { ok, state: await appState() }; };
const trashTruth = () => inFrame(listFrame(), "const res = await fetch('/api/canvases/trash'); const d = await res.json(); const l = (d && d.canvases) || []; return { n: l.length, ids: l.map(function (c) { return c.id; }) };");
const liveList = () => inFrame(listFrame(), "const res = await fetch('/api/canvases'); const d = await res.json(); const l = (d && d.canvases) || []; return { n: l.length, items: l.map(function (c) { return { id: c.id, title: c.title }; }) };");
const cardSelector = (id) => "#cardsGrid .project-card[data-canvas-id=\"" + id + "\"]";
const openCardMenu = (id) => inFrame(listFrame(),
  "const card = document.querySelector(" + JSON.stringify(cardSelector(id)) + "); if (!card) return 'no-card';" +
  "const b = card.querySelector('.card-more-btn'); if (!b) return 'no-btn'; b.click();" +
  "return card.querySelector('.card-more-menu').classList.contains('active') ? 'open' : 'not-open';");
/** 用页面自己的端点软删一本（安排错误路径用；产品自己的 deleteCanvasAPI 用的就是这条）。*/
const deleteCanvasApi = (id) => inFrame(listFrame(),
  "const res = await fetch(" + JSON.stringify("/api/canvases/" + id) + ", { method: 'DELETE' }); return { ok: res.ok, status: res.status };");
const clickCardAction = (id, action) => inFrame(listFrame(),
  "const card = document.querySelector(" + JSON.stringify(cardSelector(id)) + "); if (!card) return 'no-card';" +
  "const item = card.querySelector(" + JSON.stringify(".card-more-menu-item[data-action=" + action + "]") + ");" +
  "if (!item) return 'no-item'; item.click(); return 'clicked';");

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  await launch();
  EVIDENCE.steps.wizardLogin = await wizardAndLogin();
  EVIDENCE.steps.appOpened = await openAppWindow();
  EVIDENCE.steps.listUp = await waitFor(() => !!listFrame(), 30000);
  await sleep(1200);
  EVIDENCE.facts.appFrameSandbox = await js("const f = document.querySelector('iframe[data-canvas-app-frame]'); return f ? f.getAttribute('sandbox') : null;");
  EVIDENCE.facts.launchedCommand = "electron . --user-data-dir=<隔离> --remote-debugging-port=" + CDP_PORT;
  await shot("0-list-before");

  // 诊断模式：prompt 的作用域（顶层页 vs sandbox 帧）与 alert，不碰产品状态。
  if (process.argv.includes("--diag=prompt-scope")) {
    const readyDiag = await waitAppReady();
    promptText = "ACCEPTED_BY_PROBE";
    const out = { ready: readyDiag };
    out.shellPrompt = await js("try { var v = prompt('诊断 shell prompt', 'S'); return { returned: true, value: v }; } catch (e) { return { returned: false, error: String(e && e.message) }; }");
    out.framePrompt = await inFrame(listFrame(), "return { value: prompt('诊断 frame prompt', 'F') };");
    promptText = null;
    out.frameAlert = await inFrame(listFrame(), "alert('诊断 frame alert'); return 'returned';");
    out.rows = dialogs;
    out.stderrPrompt = stderrBuf.split("\n").filter((l) => /prompt|dialog|not be supported/i.test(l)).slice(0, 6);
    console.log(JSON.stringify(out, null, 1));
    return 0;
  }

  // 诊断模式：只验"该帧里的 confirm / prompt 在宿主 sandbox 下到底怎么返回"，不碰产品状态。
  if (process.argv.includes("--diag=dialogs")) {
    const readyDiag = await waitAppReady();
    const out = { ready: readyDiag };
    out.confirmAccept = await inFrame(listFrame(), "return confirm('诊断 confirm');");
    out.promptAcceptSync = await inFrame(listFrame(), "return prompt('诊断 prompt 同步', 'D');");
    await sleep(400);
    dialogAcceptDelayMs = 80;
    out.promptAcceptAsync = await inFrame(listFrame(), "return prompt('诊断 prompt 异步', 'D2');");
    dialogAcceptDelayMs = 0;
    out.rows = dialogs;
    console.log(JSON.stringify(out, null, 1));
    return 0;
  }

  const ready0 = await waitAppReady();
  const cards0 = await listState();
  const trash0 = await trashTruth();
  EVIDENCE.steps.baseline = { ready: ready0, cards: cards0, trash: trash0 };

  // ① 造一本测试画布：走页面自己的端点 POST /api/canvases（上游 createCanvasFromPicker / duplicateCanvasAPI
  //    用的就是它），再用产品自己的「查看更多」入口 #btnViewMore（canvas-list.html:1388-1392 → refreshAll()）
  //    让页面自己渲染卡片。**不点 #btnNewProject**：那条入口新建后会直接跳进编辑器（:1358-1363），
  //    而卡片菜单只存在于列表页 —— 「新建 → 编辑器 → 回列表」那条路径已由门禁 A3 / A4 / A6 覆盖。
  const before = cards0.ids;
  const mkTitle = "模态探针 " + Date.now();
  const made = await inFrame(listFrame(), "const res = await fetch('/api/canvases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: " + JSON.stringify(mkTitle) + ", icon: '🧩', kind: 'classic', project: 'default', board_x: 40, board_y: 40 }) }); const d = await res.json().catch(function () { return {}; }); const b = document.getElementById('btnViewMore'); if (b) b.click(); return { ok: res.ok, status: res.status, id: (d.canvas || {}).id || null, refresh: b ? 'btnViewMore' : 'no-refresh-entry' };");
  const created = await waitFor(async () => { const s = await listState(); return s.ids.some((x) => !before.includes(x)); }, 20000);
  const after = await listState();
  const canvasA = after.ids.find((x) => !before.includes(x)) || made.id || null;
  EVIDENCE.steps.create = { made, created, canvasA, mkTitle, cards: after.cards, titles: after.titles };
  await shot("1-created");

  // ② 卡片菜单「重命名」：prompt 事件必须真的出现（修复前被 sandbox 直接忽略并打 "Ignored call to 'prompt()'"）。
  //    **宿主能力边界（与 sandbox 无关）**：Electron 本身不支持 prompt() —— 顶层页实测抛 "prompt() is not supported."，
  //    sandbox 帧里 prompt() 返回 null（对话框事件出现但拿不到输入）。所以本步只钉"prompt 不再被 sandbox 吞掉"，
  //    标题预期**不变**（真机如实记录；要修"重命名"入口需要把上游 prompt 换成应用内模态，属产品决定）。
  promptText = "模态重命名 " + Date.now();
  const dlgRenameBefore = dialogs.length;
  const menuRename = await openCardMenu(canvasA);
  const clickRename = await clickCardAction(canvasA, "rename");
  const renameDialogUp = await waitFor(() => dialogs.length > dlgRenameBefore, 5000);
  const renameRow = dialogs[dlgRenameBefore] || null;
  const renamedAfterAccept = await waitFor(async () => { const l = await liveList(); return l.items.some((c) => c.id === canvasA && c.title === promptText); }, 3000);
  const hostPrompt = await js("try { prompt('探测宿主 prompt 支持'); return { returned: true }; } catch (e) { return { returned: false, error: String((e && e.message) || e) }; }");
  EVIDENCE.steps.rename = { menu: menuRename, click: clickRename, dialogUp: renameDialogUp, dialog: renameRow, renamedAfterAccept, hostPrompt, live: await liveList() };
  promptText = null;
  await shot("2-renamed");

  // ③ 卡片菜单「复制画布」：confirm 捕获 → 列表真的多出一本「<标题> 副本」
  const dlgDupBefore = dialogs.length;
  const clickDup = await clickCardAction(canvasA, "duplicate");
  const dupDialogUp = await waitFor(() => dialogs.length > dlgDupBefore, 5000);
  const duped = dupDialogUp ? await waitFor(async () => { const s = await listState(); return s.titles.some((t) => String(t || "").indexOf("副本") >= 0); }, 15000) : false;
  const afterDup = await listState();
  const canvasB = afterDup.ids.find((x) => !before.includes(x) && x !== canvasA) || null;
  EVIDENCE.steps.duplicate = { click: clickDup, dialogUp: dupDialogUp, dialog: dialogs[dlgDupBefore] || null, duped, canvasB, titles: afterDup.titles, live: await liveList() };
  await shot("3-duplicated");

  // ④ 卡片菜单「删除」：confirm 捕获 + accept → 卡片消失、进回收站、FAB 出现且角标 = 回收站长度
  const dlgDelBefore = dialogs.length;
  const trashBeforeDel = await trashTruth();
  const menuDel = await openCardMenu(canvasA);
  const clickDel = await clickCardAction(canvasA, "delete");
  const delDialogUp = await waitFor(() => dialogs.length > dlgDelBefore, 5000);
  const cardGone = delDialogUp ? await waitFor(async () => { const s = await listState(); return !s.ids.includes(canvasA); }, 15000) : false;
  const trashAfterDel = delDialogUp ? await waitFor(async () => { const t = await trashTruth(); return t.n === trashBeforeDel.n + 1 && t.ids.includes(canvasA); }, 15000) : false;
  const fabUp = delDialogUp ? await waitFor(async () => { const s = await listState(); return !!(s.fab && s.fab.hidden === false); }, 15000) : false;
  const afterDel = await listState();
  EVIDENCE.steps.delete = { menu: menuDel, click: clickDel, dialogUp: delDialogUp, dialog: dialogs[dlgDelBefore] || null, cardGone, trashAfter: await trashTruth(), trashOk: trashAfterDel, fabUp, fab: afterDel.fab };
  await shot("4-deleted-fab");

  // ⑤ 错误路径 alert：把副本先在服务端删掉（卡片仍在 DOM 里），再走卡片菜单「删除」→ DELETE 返回 404 →
  //    上游 catch 里 alert('删除失败')。钉：alert 对话框在宿主里真的弹出并被接受（修复前被 sandbox 直接忽略）。
  let alertStep = { skipped: true };
  if (canvasB) {
    const dlgAlertBefore = dialogs.length;
    const preDel = await deleteCanvasApi(canvasB);
    const menu2 = await openCardMenu(canvasB);
    const clickDel2 = await clickCardAction(canvasB, "delete");
    const alertUp = await waitFor(() => dialogs.slice(dlgAlertBefore).some((d) => d.type === "alert"), 8000);
    const rows = dialogs.slice(dlgAlertBefore);
    alertStep = { preDelete: preDel, menu: menu2, click: clickDel2, alertUp, dialogs: rows };
  }
  EVIDENCE.steps.errorAlert = alertStep;
  await shot("5-error-alert");

  // ⑥ E1 轻量：应用帧里没有 openarc 桥 / Node / IPC / fs
  EVIDENCE.steps.e1 = await inFrame(listFrame(), "return { openarc: typeof window.openarc, require: typeof window.require, process: typeof window.process, module: typeof window.module, ipc: typeof window.ipcRenderer, fs: typeof window.fs, openarcOnWindow: 'openarc' in window };");

  // ⑦ E4 轻量：伪造帧（sandbox allow-scripts）发伪造调用 → 宿主必须无视（收不到任何 result）
  EVIDENCE.steps.e4 = await js([
    "const got = [];",
    "const onMsg = function (e) { const d = e.data; if (d && d.ch === 'openarc.canvas' && d.kind === 'result') got.push(String(d.id)); };",
    "window.addEventListener('message', onMsg);",
    "const f = document.createElement('iframe'); f.id = 'oa-modals-forged'; f.setAttribute('sandbox', 'allow-scripts');",
    "f.src = 'openarc-canvas://bundle/static/canvas-list.html'; document.body.appendChild(f);",
    "await new Promise(function (r) { f.addEventListener('load', r); setTimeout(r, 4000); });",
    "for (let i = 0; i < 3; i += 1) { f.contentWindow.postMessage({ ch: 'openarc.canvas', dir: 'canvas->host', kind: 'call', id: 900 + i, token: 't_forged', method: 'canvas.list', params: {} }, '*'); }",
    "await new Promise(function (r) { setTimeout(r, 2500); });",
    "window.removeEventListener('message', onMsg); f.remove();",
    "return { results: got, forgedFrames: 1 };",
  ].join("\n"));

  // ⑧ E5 轻量：应用帧出网全部被拦（本地接收端 0 命中）
  const hits = [];
  const recv = http.createServer((req, res) => { hits.push(req.method + " " + req.url); res.writeHead(204); res.end(); });
  await new Promise((r) => recv.listen(0, "127.0.0.1", r));
  const port = recv.address().port;
  EVIDENCE.steps.e5 = await inFrame(listFrame(), [
    "const url = 'http://127.0.0.1:" + port + "/probe';",
    "const out = {};",
    "try { await fetch(url); out.fetch = 'ok'; } catch (e) { out.fetch = 'blocked:' + String(e && e.name); }",
    "out.img = await new Promise(function (r) { const i = new Image(); i.onload = function () { r('ok'); }; i.onerror = function () { r('blocked'); }; i.src = url + '.png'; setTimeout(function () { r('timeout'); }, 1500); });",
    "out.ws = await new Promise(function (r) { try { const w = new WebSocket('ws://127.0.0.1:" + port + "/ws'); w.onopen = function () { r('ok'); }; w.onerror = function () { r('blocked'); }; setTimeout(function () { r('timeout'); }, 1500); } catch (e) { r('blocked:' + String(e && e.name)); } });",
    "out.opened = (function () { const w = window.open('http://127.0.0.1:" + port + "/open'); return w ? 'opened' : 'null'; })();",
    "return out;",
  ].join("\n"));
  await sleep(1200);
  EVIDENCE.steps.e5.receiverHits = hits.slice();
  await new Promise((r) => recv.close(() => r()));

  // ⑨ 清理（产品入口）：FAB → 回收站面板 →「清空回收站」→ 二次确认 → 回收站归零 + FAB 回到隐藏。
  //    「清空」清的是页面自己那份 v4DeletedCanvases，而页面只在**取过 /api/canvases/trash** 之后才认识
  //    命令层删掉的那本（canvas-list.html:1127-1128 的响应拦截）—— 所以循环：先取回收站同步页面事实 → 再清。
  const clearRounds = [];
  for (let i = 0; i < 4; i += 1) {
    const before = (await trashTruth()).n;
    if (before === 0) break;
    const fabClick = await inFrame(listFrame(), "const f = document.getElementById('trashFab'); if (!f) return 'no-fab'; f.click(); return 'clicked';");
    await sleep(700);
    const clearClick = await inFrame(listFrame(), "const b = document.getElementById('trashClearBtn'); if (!b) return 'no-btn'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';");
    await sleep(500);
    const purgeOk = await inFrame(listFrame(), "const ok = document.getElementById('purgeConfirmOk'); if (!ok) return false; ok.click(); return true;");
    clearRounds.push({ before, fabClick, clearClick, purgeOk });
    await waitFor(async () => (await trashTruth()).n === 0, 10000);
  }
  const cleared = (await trashTruth()).n === 0;
  const finalState = await listState();
  const closeTrash = await inFrame(listFrame(), "const c = document.getElementById('trashOverlayClose'); if (c) c.click(); return 'closed';");
  EVIDENCE.steps.cleanup = { clearRounds, cleared, closeTrash, trash: await trashTruth(), fab: finalState.fab, cards: finalState.cards };
  await shot("6-cleaned");

  EVIDENCE.dialogs = dialogs;
  EVIDENCE.facts.dialogCount = dialogs.length;
  EVIDENCE.facts.consoleModalIgnore = EVIDENCE.consoleModals.slice(0, 4);

  const out = path.join(ART, PHASE + "-evidence.json");
  fs.writeFileSync(out, JSON.stringify(EVIDENCE, null, 2));
  console.log("证据文件：" + out);
  console.log("摘要：" + JSON.stringify({
    phase: PHASE,
    sandbox: EVIDENCE.facts.appFrameSandbox,
    dialogs: dialogs.map((d) => d.type + ":" + d.message.slice(0, 60)),
    ignoredConsole: EVIDENCE.consoleModals.length,
    rename: { dialogUp: EVIDENCE.steps.rename.dialogUp, dialog: EVIDENCE.steps.rename.dialog, renamedAfterAccept: EVIDENCE.steps.rename.renamedAfterAccept, hostPrompt: EVIDENCE.steps.rename.hostPrompt },
    duplicate: EVIDENCE.steps.duplicate.duped,
    delete: { dialogUp: EVIDENCE.steps.delete.dialogUp, cardGone: EVIDENCE.steps.delete.cardGone, trash: EVIDENCE.steps.delete.trashAfter, fabUp: EVIDENCE.steps.delete.fabUp, fab: EVIDENCE.steps.delete.fab },
    errorAlert: EVIDENCE.steps.errorAlert,
    e1: EVIDENCE.steps.e1,
    e4: EVIDENCE.steps.e4,
    e5: { ...EVIDENCE.steps.e5 },
    cleanup: EVIDENCE.steps.cleanup,
  }));
  return 0;
}

let code = 0;
try { code = await main(); }
catch (e) { console.log("探针异常：" + String((e && e.stack) || e).slice(0, 800)); code = 1; }
finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { if (child && !child.killed) child.kill("SIGKILL"); } catch { /* ignore */ }
}
process.exit(code);
