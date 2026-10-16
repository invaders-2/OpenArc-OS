/**
 * DXOS-CANVAS-SCOPE · 真机验证（V0.01 只读闸补齐）：逐条编辑路径被拒。
 *
 * 真实 Electron（electron .，隔离 --user-data-dir + 唯一 CDP 端口）：
 *   S0  启动 + 登录 + 打开画布应用 + 进入 smart-canvas.html
 *   S1  可编辑态种子：2 个节点 + 1 条连线 + 1 个多维表格（applyOps，走正常路径）
 *   S2  只读态（宿主 context）：逐条用例 —— 操作被拒 + 文档逐字节未变 + 0 条后端写请求
 *   S3  可编辑回归：同一批操作正常、文档确实变化
 *   S4  后到 context：先可编辑，再推 readOnly，之后逐条操作仍被拒
 *   S5  0 console error / 0 pageerror / 0 条 404 / 0 条 5xx；只读态截图 + 被拒提示截图
 *
 * 状态切换走**桥的真实宿主消息**（window.postMessage {ch:'openarc.canvas', dir:'host->canvas', kind:'context'}），
 * 不是直接改页面变量 —— 与宿主 CanvasHost 下发的 context 同一条路径。
 *
 * 用法：node experiments/dxos-canvas-scope/readonly-gate-probe.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-scope");
const SHOTS = path.join(ART, "shots-readonly");
const CDP_PORT = Number(process.env.OA_CANVAS_RO_CDP_PORT || 9866);
const ADMIN = { id: "admin@oa-ro.test", pw: "oa-ro-admin-1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (name, ok, expected, actual) => {
  checks.push({ name, status: ok ? "PASS" : "FAIL", expected: String(expected == null ? "" : expected), actual: typeof actual === "string" ? actual : JSON.stringify(actual) });
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + name + (ok ? "" : " -- 期望 " + expected + "，实际 " + JSON.stringify(actual)));
  return ok;
};
let passed = 0, failed = 0;
const check = (...a) => { if (record(...a)) passed += 1; else failed += 1; };

let child = null, browser = null, page = null, userDataDir = null, cdp = null, stderrBuf = "";
const consoleErrors = [], pageErrors = [], netFailures = [], apiWrites = [], requestUrls = new Map();
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
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
async function shot(name) { fs.mkdirSync(SHOTS, { recursive: true }); const p = path.join(SHOTS, name + ".png"); await page.screenshot({ path: p }).catch(() => {}); return path.relative(ROOT, p); }

/** 页面侧探针：只在页面里读事实 / 造事件，不改状态（状态切换走桥的真实 postMessage）。*/
async function installProbe(f) {
  if (!f) return false;
  await f.evaluate(() => {
    if (window.__roProbe) return true;
    window.__roProbe = {
      doc: () => window.__openarcSmartGuard.snapshot(),
      blocked: () => window.__openarcSmartGuard.blocked().length,
      writes: () => window.__openarcSmartGuard.writeBlocked(),
      facts: () => window.__openarcSmartGuard.facts(),
      wrapped: () => window.__openarcSmartGuard.wrapped(),
      nodes: () => window.__smartAgentTestHooks.nodes(),
      conns: () => window.__smartAgentTestHooks.connections(),
      applyOps: (ops) => window.__smartAgentTestHooks.applyOps(ops),
      save: () => window.__smartAgentTestHooks.save(),
      postContext: (readOnly, canEdit) => { window.postMessage({ ch: "openarc.canvas", dir: "host->canvas", kind: "context", readOnly: !!readOnly, canEdit: !!canEdit }, "*"); return true; },
      ev: (type, init) => {
        const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
        if (/^pointer/.test(type)) return new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, base, init || {}));
        if (type === "keydown" || type === "keyup") return new KeyboardEvent(type, Object.assign({ key: "Delete" }, base, init || {}));
        if (type === "paste" || type === "cut") { try { return new ClipboardEvent(type, Object.assign({ clipboardData: new DataTransfer() }, base, init || {})); } catch (e) { return new Event(type, base); } }
        if (type === "dragstart" || type === "dragover" || type === "drop") { return new DragEvent(type, Object.assign({ dataTransfer: new DataTransfer() }, base, init || {})); }
        return new MouseEvent(type, Object.assign(base, init || {}));
      },
      fire: (sel, type, init) => { const el = document.querySelector(sel); if (!el) return "missing"; el.dispatchEvent(window.__roProbe.ev(type, init)); return "ok"; },
      fireWin: (type, init) => { window.dispatchEvent(window.__roProbe.ev(type, init)); return "ok"; },
      drag: (sel, dx, dy) => {
        const el = document.querySelector(sel); if (!el) return "missing";
        const r = el.getBoundingClientRect(); const x = r.left + Math.min(r.width / 2, 40), y = r.top + Math.min(r.height / 2, 24);
        const on = (target, t, cx, cy, extra) => target.dispatchEvent(new MouseEvent(t, Object.assign({ bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: cx, clientY: cy }, extra || {})));
        on(el, "mousedown", x, y);
        on(window, "mousemove", x + dx, y + dy);
        on(window, "mousemove", x + dx, y + dy);
        on(window, "mouseup", x + dx, y + dy);
        return { x: x, y: y };
      },
      dragBetween: (fromSel, toSel) => {
        const a = document.querySelector(fromSel), b = document.querySelector(toSel);
        if (!a || !b) return "missing";
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const ax = ra.left + ra.width / 2, ay = ra.top + ra.height / 2, bx = rb.left + rb.width / 2, by = rb.top + rb.height / 2;
        const on = (target, t, cx, cy) => target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: cx, clientY: cy }));
        on(a, "mousedown", ax, ay);
        on(window, "mousemove", bx, by);
        on(window, "mousemove", bx, by);
        on(window, "mouseup", bx, by);
        return "ok";
      },
      dropAsset: () => {
        const dt = new DataTransfer();
        dt.setData("application/x-smart-asset", JSON.stringify({ url: "data:image/png;base64,iVBORw0KGgo=", name: "ro-probe.png", kind: "image" }));
        const shell = document.getElementById("shell");
        if (!shell) return "missing";
        shell.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
        shell.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
        return "ok";
      }
    };
    return true;
  });
  return true;
}

let desiredReadOnly = false;
async function ensureSmart() {
  if (smartFrame()) return true;
  const lf = listFrame();
  if (!lf) return false;
  await inFrame(lf, "const card=document.querySelector('#cardsGrid .project-card'); if(card){ card.click(); return 'card'; } const b=document.getElementById('btnContinueLast'); if(b){ b.click(); return 'btn'; } return 'none';");
  const up = await waitFor(() => !!smartFrame(), 45000);
  if (!up) return false;
  await waitFor(async () => (await inFrame(smartFrame(), "return !!window.__openarcSmartGuard;")) === true, 30000);
  await installProbe(smartFrame());
  await inFrame(smartFrame(), "window.__roProbe.postContext(" + (desiredReadOnly ? "true, false" : "false, true") + "); return true;");
  await waitFor(async () => (await inFrame(smartFrame(), "return !!window.__openarcCanvasReadOnly === " + (desiredReadOnly ? "true" : "false"))) === true, 10000);
  await sleep(400);
  return true;
}
const state = async () => { await ensureSmart(); return inFrame(smartFrame(), "const g=window.__openarcSmartGuard,h=window.__smartAgentTestHooks; const d=JSON.parse(g.snapshot()); return { doc:g.snapshot(), updated:d.updated_at, blocked:g.blocked().length, writes:g.writeBlocked(), nodes:h.nodes().length, conns:h.connections().length };"); };

async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-ro-gate-"));
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
  cdp.on("Network.requestWillBeSent", (e) => {
    requestUrls.set(e.requestId, e.request.url);
    let pathname = "";
    try { pathname = new URL(e.request.url).pathname; } catch { pathname = e.request.url; }
    if (String(e.request.method).toUpperCase() !== "GET" && pathname.indexOf("/api/") === 0) apiWrites.push({ method: e.request.method, url: pathname });
  });
  cdp.on("Network.responseReceived", (e) => { if (e.response.status >= 400) netFailures.push({ kind: "response", status: e.response.status, url: e.response.url }); });
  cdp.on("Network.loadingFailed", (e) => netFailures.push({ kind: "loadingFailed", status: 0, errorText: e.errorText, url: requestUrls.get(e.requestId) || "" }));
}
async function login() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const next = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "OA RO Admin"); await next();
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

const results = [];
async function runCaseOnce(id, name, act, opts = {}) {
  await ensureSmart();
  const before = await state();
  const apiBefore = apiWrites.length;
  const actRes = await act();
  await sleep(opts.wait || 320);
  const after = await state();
  const docChanged = before.doc !== after.doc;
  const blockedDelta = after.blocked - before.blocked;
  const apiDelta = apiWrites.length - apiBefore;
  const expectChange = !!opts.expectChange;
  let ok, reason;
  if (expectChange) {
    ok = docChanged;
    reason = "文档确实变化：" + (docChanged ? "是" : "否");
  } else {
    ok = !docChanged && blockedDelta > 0 && apiDelta === 0;
    reason = "文档未变=" + (!docChanged) + " / blocked+" + blockedDelta + " / 后端写=" + apiDelta;
  }
  const entry = { id, name, ok, docChanged, blockedDelta, apiDelta, actRes, reason };
  return entry;
}
async function runCase(id, name, act, opts = {}) {
  let entry = await runCaseOnce(id, name, act, opts);
  const frameLost = entry.actRes && entry.actRes.__noFrame || Number.isNaN(entry.blockedDelta);
  if (frameLost) {
    const reentered = await ensureSmart();
    if (reentered) entry = await runCaseOnce(id, name, act, opts);
  }
  results.push(entry);
  if (record(id + " · " + name, entry.ok, entry.reason, entry)) passed += 1; else failed += 1;
  return entry;
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  await launch();
  await login();
  check("S0a · 真实 electron . 启动 + 登录", (await gate()) === "ready", "ready", await gate());
  await openAppWindow();
  const listUp = await waitFor(() => !!listFrame(), 25000);
  check("S0b · 打开画布应用（列表页）", listUp, "canvas-list.html", listUp);
  const listReady = await waitFor(async () => (await inFrame(listFrame(), "return document.readyState === 'complete' && !!document.getElementById('btnStartCreate');")) === true, 20000);
  check("S0b2 · 列表页可交互（readyState=complete + 新建按钮就位）", listReady, "ready", listReady);
  await sleep(1000);
  let created = await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';");
  let smartUp = await waitFor(() => !!smartFrame(), 45000);
  if (!smartUp) {
    created = await inFrame(listFrame(), "const el = document.getElementById('btnNewProject'); if (!el) return 'missing'; el.click(); return 'clicked';");
    smartUp = await waitFor(() => !!smartFrame(), 45000);
  }
  const guardUp = await waitFor(async () => (await inFrame(smartFrame(), "return typeof window.__openarcSmartGuard === 'object' && !!window.__openarcSmartGuard;")).toString() === "true", 30000);
  check("S0c · 进入 smart-canvas.html + 守卫就绪", smartUp && guardUp, "smart-canvas.html + __openarcSmartGuard", { created, smartUp, guardUp });
  await installProbe(smartFrame());
  const wrapped = await inFrame(smartFrame(), "return window.__roProbe.wrapped();");
  check("S0d · 函数闸就绪：173 个改文档函数被包装、0 个缺失", !!wrapped && wrapped.count >= 170 && Array.isArray(wrapped.missing) && wrapped.missing.length === 0, "count>=170, missing=[]", wrapped);

  await inFrame(smartFrame(), "window.__roProbe.postContext(false, true); return true;");
  await waitFor(async () => (await inFrame(smartFrame(), "return !!window.__openarcCanvasReadOnly === false;")) === true, 10000);
  const seeded = await inFrame(smartFrame(), "const ops = { nodes_upsert: [ { id:'roA', type:'smart-image', x:120, y:120, w:260, h:190, title:'RO A', images:[] }, { id:'roB', type:'smart-prompt', x:520, y:120, w:300, h:200, title:'RO B' }, { id:'roT', type:'table', x:120, y:420, w:520, h:240, title:'RO TABLE', table:{kind:'table',version:1,columns:[{id:'c1',name:'c1',type:'text'},{id:'c2',name:'c2',type:'text'}],rows:[{id:'r1',cells:{c1:'a',c2:'b'}}],selectedRows:[],mergedGroups:[]} } ], connections_upsert: [ { from:'roA', to:'roB', kind:'input' } ] }; return { changed: window.__roProbe.applyOps(ops), nodes: window.__roProbe.nodes().length, conns: window.__roProbe.conns().length };");
  await sleep(800);
  check("S1 · 可编辑态种子（2 节点 + 1 连线 + 1 表格，走 applyAgentCanvasOps）", !!seeded && seeded.nodes >= 3 && seeded.conns >= 1, "nodes>=3, conns>=1", seeded);
  const editSeedShot = await shot("editable-seeded-light");

  desiredReadOnly = true;
  await inFrame(smartFrame(), "window.__roProbe.postContext(true, false); return true;");
  const roOn = await waitFor(async () => (await inFrame(smartFrame(), "return document.documentElement.getAttribute('data-openarc-readonly') === '1' && !!window.__openarcCanvasReadOnly;")) === true, 10000);
  check("S2.0 · 宿主 context(readOnly) 生效：data-openarc-readonly=1", roOn, "readonly=1", roOn);
  await sleep(600);
  const roBefore = await state();
  const ro = [];
  ro.push(await runCase("P01", "节点拖动", () => inFrame(smartFrame(), "return window.__roProbe.drag('[data-id=\"roA\"]', 80, 60);")));
  ro.push(await runCase("P02", "节点缩放（把手下拖）", () => inFrame(smartFrame(), "return window.__roProbe.drag('[data-id=\"roT\"] .node-resize-handle', 60, 60);")));
  ro.push(await runCase("P03", "框选（空白处拉框）", () => inFrame(smartFrame(), "const world=document.getElementById('world'); const w=world.getBoundingClientRect(); const x=w.right-160,y=w.bottom-160; world.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,composed:true,view:window,button:0,clientX:x,clientY:y})); window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,cancelable:true,composed:true,view:window,button:0,clientX:x+120,clientY:y+120})); window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,composed:true,view:window,button:0,clientX:x+120,clientY:y+120})); return 'ok';")));
  ro.push(await runCase("P04", "多选（Ctrl+框选）", () => inFrame(smartFrame(), "const world=document.getElementById('world'); const w=world.getBoundingClientRect(); const x=w.right-160,y=w.bottom-160; world.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,composed:true,view:window,button:0,clientX:x,clientY:y,ctrlKey:true})); window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,cancelable:true,composed:true,view:window,button:0,clientX:x+120,clientY:y+120,ctrlKey:true})); window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,composed:true,view:window,button:0,clientX:x+120,clientY:y+120,ctrlKey:true})); return 'ok';")));
  ro.push(await runCase("P05", "新增节点（底栏「图片节点」入口）", () => inFrame(smartFrame(), "const before=window.__roProbe.nodes().length; window.zoomBarCreate('image'); return 'before='+before;")));
  ro.push(await runCase("P06", "新增节点（右键创建菜单）", () => inFrame(smartFrame(), "window.__roProbe.fire('[data-id=\"roA\"]','contextmenu',{clientX:200,clientY:200}); const menu=document.getElementById('createMenu'); return { menuOpen: !!(menu && menu.classList.contains('open')) };")));
  ro.push(await runCase("P07", "删除节点（Delete 键）", () => inFrame(smartFrame(), "document.querySelector('[data-id=\"roA\"]').click(); window.__roProbe.fireWin('keydown',{key:'Delete'}); return 'ok';")));
  ro.push(await runCase("P08", "删除节点（节点工具条删除钮）", () => inFrame(smartFrame(), "const sel='[data-id=\"roA\"] .node-delete, [data-id=\"roA\"] .image-delete, [data-id=\"roA\"] .mini-x'; const el=document.querySelector(sel); if(!el) return 'missing'; el.dispatchEvent(window.__roProbe.ev('click')); return 'ok';")));
  ro.push(await runCase("P09", "连线（端口拖到另一节点）", () => inFrame(smartFrame(), "return window.__roProbe.dragBetween('[data-id=\"roA\"] .node-port[data-port=\"out\"]', '[data-id=\"roB\"] .node-port[data-port=\"in\"]');")));
  ro.push(await runCase("P10", "断线（点连线）", () => inFrame(smartFrame(), "const el=document.querySelector('[data-conn-index] .conn-hit') || document.querySelector('[data-conn-index]'); if(!el) return 'missing'; el.dispatchEvent(window.__roProbe.ev('click')); return 'ok';")));
  ro.push(await runCase("P11", "分组（Ctrl+G）", () => inFrame(smartFrame(), "document.querySelector('[data-id=\"roA\"]').click(); document.querySelector('[data-id=\"roB\"]').click(); window.__roProbe.fireWin('keydown',{key:'g',ctrlKey:true,metaKey:true}); return 'ok';")));
  ro.push(await runCase("P12", "取消分组（Ctrl+Shift+G）", () => inFrame(smartFrame(), "window.__roProbe.fireWin('keydown',{key:'g',ctrlKey:true,metaKey:true,shiftKey:true}); return 'ok';")));
  ro.push(await runCase("P13", "表格内联编辑（单元格输入）", () => inFrame(smartFrame(), "const host=document.querySelector('[data-id=\"roT\"] .table-node-host'); if(!host) return 'missing-host'; const cell=host.querySelector('[contenteditable], input, textarea') || host; cell.dispatchEvent(window.__roProbe.ev('beforeinput')); if(cell!==host){ try{ cell.textContent='RO-EDIT'; }catch(e){} } cell.dispatchEvent(new Event('input',{bubbles:true})); cell.dispatchEvent(new Event('change',{bubbles:true})); cell.dispatchEvent(window.__roProbe.ev('mousedown')); cell.dispatchEvent(window.__roProbe.ev('click')); return { cell: cell.tagName + (cell.className ? '.' + String(cell.className).split(' ')[0] : ''), hasCell: !!host.querySelector('[contenteditable], input, textarea') };")));
  ro.push(await runCase("P14", "属性面板/参数编辑（提示词 + 引擎下拉）", () => inFrame(smartFrame(), "const inp=document.getElementById('promptInput'); if(inp){ inp.focus(); inp.textContent='RO-EDIT'; inp.dispatchEvent(new Event('beforeinput',{bubbles:true,cancelable:true})); inp.dispatchEvent(new Event('input',{bubbles:true})); } const sel=document.getElementById('engineSelect'); if(sel){ sel.value='comfy'; sel.dispatchEvent(new Event('change',{bubbles:true})); } return 'ok';")));
  ro.push(await runCase("P15", "右键菜单（节点右键 + 空白右键）", () => inFrame(smartFrame(), "window.__roProbe.fire('[data-id=\"roA\"]','contextmenu',{clientX:220,clientY:220}); window.__roProbe.fire('#world','contextmenu',{clientX:900,clientY:700}); const menu=document.getElementById('createMenu'); return { createMenuOpen: !!(menu && menu.classList.contains('open')), nodeMenu: !!document.querySelector('.smart-node-menu') };")));
  ro.push(await runCase("P16", "键盘方向键（微移节点）", () => inFrame(smartFrame(), "document.querySelector('[data-id=\"roA\"]').click(); window.__roProbe.fireWin('keydown',{key:'ArrowRight'}); window.__roProbe.fireWin('keydown',{key:'ArrowDown'}); return 'ok';")));
  ro.push(await runCase("P17", "粘贴（Cmd+V / paste 事件）", () => inFrame(smartFrame(), "window.__roProbe.fireWin('keydown',{key:'v',metaKey:true,ctrlKey:true}); window.__roProbe.fireWin('paste'); return 'ok';")));
  ro.push(await runCase("P18", "拖拽落点（素材库拖入画布）", () => inFrame(smartFrame(), "return window.__roProbe.dropAsset();")));
  ro.push(await runCase("P19", "图片参数修改 / 版本恢复·删除", () => inFrame(smartFrame(), "window.applyImageEdit(); window.restoreCanvasVersion && window.restoreCanvasVersion('v1'); window.deleteCanvasVersion && window.deleteCanvasVersion('v1'); return 'ok';")));
  ro.push(await runCase("P20", "Agent 应用画布操作（applyOps）", () => inFrame(smartFrame(), "const changed=window.__roProbe.applyOps({ nodes_upsert:[{ id:'roZ', type:'smart-image', x:800, y:600, w:200, h:200, title:'RO Z', images:[] }] }); return 'changed='+changed;")));
  ro.push(await runCase("P21", "撤销/重做（底栏 + Cmd+Z）", () => inFrame(smartFrame(), "window.zoomBarUndo && window.zoomBarUndo(); window.zoomBarRedo && window.zoomBarRedo(); window.__roProbe.fireWin('keydown',{key:'z',metaKey:true,ctrlKey:true}); return 'ok';")));
  ro.push(await runCase("P22", "提示词模板库写操作（模板库入口）", () => inFrame(smartFrame(), "const btn=document.getElementById('composerTemplateBtn'); if(btn) btn.dispatchEvent(window.__roProbe.ev('click')); const panel=document.getElementById('promptTemplatePanel'); const save=panel && panel.querySelector('[data-template-save-current]'); if(save) save.dispatchEvent(window.__roProbe.ev('click')); return { panelOpen: !!(panel && panel.classList.contains('open')), hadSave: !!save };")));
  ro.push(await runCase("P23", "后端写请求（saveCanvas + 直接 PUT）", () => inFrame(smartFrame(), "window.__roProbe.save(); const id=(window.__openarcBridge && window.__openarcBridge.context && window.__openarcBridge.context.canvasId) || ''; fetch('/api/canvases/'+encodeURIComponent(id), {method:'PUT', headers:{'Content-Type':'application/json'}, body:'{}'}).then(()=>{}).catch(()=>{}); return { canvasId: id };"), { wait: 700 }));
  const roShot = await shot("readonly-blocked-toast-light");
  const roAfter = await state();
  check("S2.1 · 只读期间服务端 revision（updated_at）未变 —— 后端没收到写请求", !!roBefore && !!roAfter && roBefore.updated === roAfter.updated, "updated_at 不变", { before: roBefore && roBefore.updated, after: roAfter && roAfter.updated, writeBlocked: roAfter && roAfter.writes, blockedTotal: roAfter && roAfter.blocked });
  check("S2 · 只读态逐条用例全部被拒（操作被拒 + 文档未变 + 0 后端写）", ro.every((r) => r.ok), "全部 PASS", ro.map((r) => ({ id: r.id, ok: r.ok, blockedDelta: r.blockedDelta, apiDelta: r.apiDelta })));

  desiredReadOnly = false;
  await inFrame(smartFrame(), "window.__roProbe.postContext(false, true); return true;");
  await waitFor(async () => (await inFrame(smartFrame(), "return !!window.__openarcCanvasReadOnly === false;")) === true, 10000);
  await sleep(500);
  const reg = [];
  reg.push(await runCase("R01", "可编辑·新增节点", () => inFrame(smartFrame(), "window.zoomBarCreate('image'); return 'ok';"), { expectChange: true }));
  reg.push(await runCase("R02", "可编辑·删除节点（选中后 Delete）", () => inFrame(smartFrame(), "const img=window.__roProbe.nodes().filter(n=>n.type==='smart-image'); const target=img[img.length-1]; if(!target) return 'no-node'; const el=document.querySelector('[data-id=\"'+target.id+'\"]'); if(el) el.click(); window.__roProbe.fireWin('keydown',{key:'Delete'}); return target.id;"), { expectChange: true }));
  reg.push(await runCase("R03", "可编辑·撤销", () => inFrame(smartFrame(), "window.zoomBarUndo && window.zoomBarUndo(); return 'ok';"), { expectChange: true }));
  reg.push(await runCase("R04", "可编辑·重做", () => inFrame(smartFrame(), "window.zoomBarRedo && window.zoomBarRedo(); return 'ok';"), { expectChange: true }));
  reg.push(await runCase("R05", "可编辑·连线（applyOps connections_upsert）", () => inFrame(smartFrame(), "const before=window.__roProbe.conns().length; const changed=window.__roProbe.applyOps({ connections_upsert:[{from:'roA',to:'roT',kind:'input'}] }); return { before: before, changed: changed };"), { expectChange: true }));
  reg.push(await runCase("R06", "可编辑·断线（点连线）", () => inFrame(smartFrame(), "const el=document.querySelector('[data-conn-index] .conn-hit') || document.querySelector('[data-conn-index]'); if(!el) return 'missing'; el.dispatchEvent(window.__roProbe.ev('click')); return 'ok';"), { expectChange: true }));
  reg.push(await runCase("R07", "可编辑·Agent 落节点", () => inFrame(smartFrame(), "const changed=window.__roProbe.applyOps({ nodes_upsert:[{ id:'roY', type:'smart-image', x:820, y:620, w:200, h:200, title:'RO Y', images:[] }] }); return 'changed='+changed;"), { expectChange: true }));
  reg.push(await runCase("R09", "可编辑·端口拖拽真连线", () => inFrame(smartFrame(), "return window.__roProbe.dragBetween('[data-id=\"roB\"] .node-port[data-port=\"out\"]', '[data-id=\"roT\"] .node-port[data-port=\"in\"]');"), { expectChange: true }));
  const wBefore = (await state()).writes;
  const putRes = await inFrame(smartFrame(), "const id=(window.__openarcBridge && window.__openarcBridge.context && window.__openarcBridge.context.canvasId) || ''; const r=await fetch('/api/canvases/'+encodeURIComponent(id), {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title:'RO-PUT',nodes:[],connections:[],base_updated_at:0})}).then(x=>x.status).catch(()=>-1); return { canvasId: id, status: r };");
  await sleep(600);
  const wAfter = (await state()).writes;
  check("R08 · 可编辑·后端 PUT 同一 fetch 通道不被拒（服务端真收到请求 + 页面侧写闸未触发）", !!putRes && putRes.status !== 403 && putRes.status !== -1 && wAfter === wBefore, "非 403/-1 且 writeBlocked 不变", { putRes, writeBlockedDelta: wAfter - wBefore, note: "openarc-canvas:// 是 OOPIF，CDP 页面会话不统计其子帧请求；以服务端回包状态 + 页面侧 writeBlocked 计数为准" });
  check("S3 · 可编辑回归：同一批操作全部正常（文档确实变化）", reg.every((r) => r.ok), "全部 PASS", reg.map((r) => ({ id: r.id, ok: r.ok, docChanged: r.docChanged })));
  const editShot = await shot("editable-after-edits-light");

  desiredReadOnly = true;
  await inFrame(smartFrame(), "window.__roProbe.postContext(true, false); return true;");
  const lateOn = await waitFor(async () => (await inFrame(smartFrame(), "return document.documentElement.getAttribute('data-openarc-readonly') === '1' && !!window.__openarcCanvasReadOnly;")) === true, 10000);
  check("S4.0 · 后到 context(readOnly) 生效", lateOn, "readonly=1", lateOn);
  await sleep(500);
  const late = [];
  late.push(await runCase("L01", "后到·节点拖动", () => inFrame(smartFrame(), "return window.__roProbe.drag('[data-id=\"roA\"]', 70, 50);")));
  late.push(await runCase("L02", "后到·新增节点", () => inFrame(smartFrame(), "window.zoomBarCreate('prompt'); return 'ok';")));
  late.push(await runCase("L03", "后到·连线", () => inFrame(smartFrame(), "return window.__roProbe.dragBetween('[data-id=\"roA\"] .node-port[data-port=\"out\"]', '[data-id=\"roB\"] .node-port[data-port=\"in\"]');")));
  late.push(await runCase("L04", "后到·删除（Delete 键）", () => inFrame(smartFrame(), "document.querySelector('[data-id=\"roA\"]').click(); window.__roProbe.fireWin('keydown',{key:'Delete'}); return 'ok';")));
  late.push(await runCase("L05", "后到·参数编辑", () => inFrame(smartFrame(), "const inp=document.getElementById('promptInput'); if(inp){ inp.textContent='LATE'; inp.dispatchEvent(new Event('beforeinput',{bubbles:true,cancelable:true})); inp.dispatchEvent(new Event('input',{bubbles:true})); } return 'ok';")));
  late.push(await runCase("L06", "后到·Agent 应用画布操作", () => inFrame(smartFrame(), "return 'changed='+window.__roProbe.applyOps({ nodes_upsert:[{ id:'roLate', type:'smart-image', x:900, y:700, w:160, h:160, title:'LATE', images:[] }] });")));
  late.push(await runCase("L07", "后到·撤销", () => inFrame(smartFrame(), "window.zoomBarUndo && window.zoomBarUndo(); return 'ok';")));
  late.push(await runCase("L08", "后到·后端写请求", () => inFrame(smartFrame(), "window.__roProbe.save(); return 'ok';"), { wait: 600 }));
  check("S4 · 后到 context 之后逐条操作仍被拒", late.every((r) => r.ok), "全部 PASS", late.map((r) => ({ id: r.id, ok: r.ok, blockedDelta: r.blockedDelta, apiDelta: r.apiDelta })));

  await sleep(900);
  const pageErrorsFiltered = pageErrors.filter((e) => !/AbortError|The operation was aborted/.test(e));
  const notFound = netFailures.filter((f) => f.status === 404);
  const serverErrors = netFailures.filter((f) => f.status >= 500);
  check("S5a · 0 条 404", notFound.length === 0, "0 个 404", notFound.slice(0, 8));
  check("S5b · 0 条 pageerror", pageErrorsFiltered.length === 0, "0 条 pageerror", pageErrorsFiltered.slice(0, 8));
  check("S5c · 0 条网络 5xx", serverErrors.length === 0, "0 个 5xx", serverErrors.slice(0, 8));
  check("S5d · 0 条 console error", consoleErrors.length === 0, "0 条 console error", consoleErrors.slice(0, 8));

  const result = {
    ok: failed === 0, cdpPort: CDP_PORT,
    checks, readonlyCases: ro, editableCases: reg, lateCases: late,
    apiWrites, consoleErrors, pageErrors: pageErrorsFiltered, notFound, serverErrors, wrapped,
    shots: { editableSeeded: editSeedShot, editableAfter: editShot, readonlyBlocked: roShot }
  };
  fs.writeFileSync(path.join(ART, "readonly-gate-probe.json"), JSON.stringify(result, null, 2) + "\n");
  const lines = [];
  lines.push("# DXOS-CANVAS-SCOPE · 智能画布只读闸逐条封堵（真机证据）", "");
  lines.push("CDP " + CDP_PORT + " · wrapped=" + JSON.stringify(wrapped && wrapped.count) + " · missing=" + JSON.stringify((wrapped && wrapped.missing) || []), "");
  lines.push("| 结果 | 检查 | 说明 |");
  lines.push("| --- | --- | --- |");
  for (const c of checks) lines.push("| " + (c.status === "PASS" ? "PASS" : "FAIL") + " | " + c.name + " | " + String(c.actual).replace(/\|/g, "\\|").slice(0, 400) + " |");
  lines.push("", "PASS " + passed + " / FAIL " + failed, "");
  lines.push("## 只读逐条用例（操作被拒 + 文档未变 + 0 后端写）", "");
  lines.push("| 编号 | 路径 | 结果 | 文档变化 | blocked+ | 后端写 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of ro) lines.push("| " + r.id + " | " + r.name + " | " + (r.ok ? "PASS" : "FAIL") + " | " + r.docChanged + " | " + r.blockedDelta + " | " + r.apiDelta + " |");
  lines.push("", "## 可编辑回归", "");
  lines.push("| 编号 | 路径 | 结果 | 文档变化 |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of reg) lines.push("| " + r.id + " | " + r.name + " | " + (r.ok ? "PASS" : "FAIL") + " | " + r.docChanged + " |");
  lines.push("", "## 后到 context", "");
  lines.push("| 编号 | 路径 | 结果 | 文档变化 | blocked+ | 后端写 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of late) lines.push("| " + r.id + " | " + r.name + " | " + (r.ok ? "PASS" : "FAIL") + " | " + r.docChanged + " | " + r.blockedDelta + " | " + r.apiDelta + " |");
  lines.push("", "## 截图", "");
  for (const [k, v] of Object.entries(result.shots)) lines.push("- " + k + ": " + v);
  fs.writeFileSync(path.join(ART, "READONLY-GATE-RESULT.md"), lines.join("\n") + "\n");
  console.log("\n==== 截图 ====");
  for (const [k, v] of Object.entries(result.shots)) console.log("  " + k + ": " + v);
  console.log("\nPASS " + passed + " / FAIL " + failed);

  try { await browser.close(); } catch { /* ignore */ }
  browser = null;
  if (child && !child.killed) { child.kill("SIGTERM"); await sleep(1200); try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error("探针异常：", (err && err.stack) || err); if (stderrBuf) console.error("electron stderr 尾部：\n" + stderrBuf.slice(-2500)); process.exitCode = 1; });
