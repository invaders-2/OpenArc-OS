/**
 * D5-01 Closure-4 · **浏览器提示条**（permission 稳定场景）的可见 / 可操作 / 点击归属判定。
 *
 * 为什么单独一个门禁（而不是复用 visibility-e2e）：
 *   · Closure-4 的聚焦探针用 /permission（**白底**页）采样，得到"非绿 = 提示可见"——这个推论无效：
 *     "白底网页"和"提示条"都不是绿，像素分不开。本门禁改用**整页纯绿**的稳定页：
 *     「提示条在上面」= 采样点是提示条自己的浅色；「网页在上面」= 采样点是页面纯绿。两者可判。
 *   · 提示必须**只申请一次**（产品对同 (kind, origin, permission) 只留一条，反复申请会让
 *     "消失 = 可点击"这条断言失效）：站点 /notice-lab 加载时只调一次 geolocation。
 *
 * 三条独立通道（互不循环论证）：
 *   ① 像素：screencapture -x -o -l <CGWindowID> 抓本窗口画面 → 直接判"谁在上面"；
 *   ② 真实指针：cliclick（CGEvent）→ 外壳侧 capture 监听（点击到达外壳 + isTrusted）；
 *   ③ 页面自证：网页自己记录到达网页的指针事件（点击有没有漏进网页）。
 * 坐标换算只用**实测**的原生视图矩形（见 screen-geometry.mjs 的唯一换算器）；
 * "点已知屏幕点 → 页面回报 client 坐标 → 反推视图原点"是独立校验，不参与换算。
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startSite } from "./site.mjs";
import {
  ourWindows, activate, ensureFrontmost,
  captureTo, imageSize, scanGreen, viewRectFromPixels, makeMapper, makeSafeClick,
  isPageGreen, sleep,
} from "./screen-geometry.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "d5-01");
const FRAMES = path.join(ART, "notice");
const CDP_PORT = Number(process.env.OA_D501_NOTICE_CDP_PORT || 9798);
const ADMIN = { id: "admin@d501-notice.test", pw: "admin-password-1" };
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);

const CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [];
let passed = 0, failed = 0;
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 2400), at: Date.now() };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  " : "! ") + "[" + row.status + "] " + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

let child = null, browser = null, page = null, site = null, stderrBuf = "";
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(100); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);
const views = () => browser.contexts()[0].pages().filter((p) => !p.url().includes("dist/index.html"));
const viewByUrl = (part) => views().find((p) => p.url().includes(part)) || null;
async function viewEval(v, code, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try { return await v.evaluate("(async () => { " + code + " })()"); } catch (e) {
      last = e;
      if (!/Execution context was destroyed|Target closed|frame was detached/i.test(String(e && e.message))) throw e;
      await sleep(200);
    }
  }
  throw last;
}

async function launch() {
  const busy = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version").then(() => true).catch(() => false);
  if (busy) throw new Error("CDP 端口 " + CDP_PORT + " 已被占用");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-notice-"));
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" },
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
}

/** 提示条快照：容器 + 每一项的身份与矩形（含按钮矩形）。 */
const SNAPSHOT = "const cont = document.querySelector('.browser-notices');" +
  " if (!cont) return JSON.stringify({ present: false, items: [] });" +
  " const cb = cont.getBoundingClientRect();" +
  " const items = Array.from(cont.querySelectorAll('[data-notice-kind]')).map((el, i) => {" +
  "   const b = el.getBoundingClientRect();" +
  "   const btn = el.querySelector('button[aria-label=\"关闭提示\"]');" +
  "   const bb = btn ? btn.getBoundingClientRect() : null;" +
  "   const buttons = Array.from(el.querySelectorAll('button')).map((x) => { const r = x.getBoundingClientRect(); return { label: x.getAttribute('aria-label') || String(x.textContent || '').trim().slice(0, 24), cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height }; });" +
  "   return { i, kind: el.getAttribute('data-notice-kind'), text: String(el.innerText || '').split(String.fromCharCode(10)).join(' | ').trim().slice(0, 160), rect: { left: b.left, top: b.top, w: b.width, h: b.height }, close: bb ? { cx: bb.left + bb.width / 2, cy: bb.top + bb.height / 2, w: bb.width, h: bb.height } : null, buttons };" +
  " });" +
  " return JSON.stringify({ present: true, container: { left: cb.left, top: cb.top, w: cb.width, h: cb.height }, items });";

async function main() {
  fs.mkdirSync(FRAMES, { recursive: true });
  site = await startSite();
  await launch();
  const pid = child.pid;
  record("boot", "N0 · 真实 electron . 启动（隔离 userData / 隔离 CDP 端口）", !!browser, "CDP 可用", "connected");

  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    // 集成分支保留 UI 线已定的"三步初始化向导"（显示名 → 账号 → 密码），末步才提交：
    // 后两步的输入在 DOM 里尚未存在，一次填完再点 setup-submit 不会发生任何事。
    // 驱动方式与 UI 线探针（tests/fixtures/identity-ui-probe/main.cjs）一致。
    const setupNext = async () => {
      await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000);
      await clickDom('[data-d3-id="setup-next"]');
    };
    await setInput('[data-d3-id="setup-name"]', "D5-01 Notice Admin");
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
  await waitSel('[data-d3-id="login-identifier"]', 20000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  record("boot", "N1 · 真实 UI 登录 admin", await waitFor(async () => (await gate()) === "ready", 90000), "ready", await gate());

  const LAB = site.base + "/notice-lab";
  await clickDom('[aria-label="打开浏览器"]');
  await waitSel("[data-browser-window]", 20000);
  await setInput('[aria-label="网页地址"]', LAB);
  await clickDom(".addressbar .primary");
  const lab = await waitFor(() => !!viewByUrl("/notice-lab"), 25000) ? viewByUrl("/notice-lab") : null;
  record("setup", "N2 · 稳定场景页加载（整页纯绿 + 只申请一次权限 + 页面自记指针事件）", !!lab && (await viewEval(lab, "return document.getElementById('lab-marker')?.textContent || ''")) === "LAB-MARKER-51c3", "LAB-MARKER-51c3", lab ? lab.url() : "无视图");
  const marker = JSON.parse((await viewEval(lab, "return JSON.stringify({req: window.__permissionRequests, geo: window.__geo})")) || "{}");
  note("稳定页自报：权限申请次数 = " + marker.req + "，geolocation 结果 = " + marker.geo);

  await waitFor(async () => {
    const s = JSON.parse(await js(SNAPSHOT));
    return s.items.some((n) => n.text.includes(site.base));
  }, 25000);
  await sleep(800);

  activate(pid);
  await sleep(900);
  const wins = ourWindows(pid).filter((w) => w.layer === 0 && w.w > 400 && w.h > 300);
  if (!wins.length) throw new Error("找不到本实例的屏幕窗口（CGWindow）");
  const win = wins[0];
  const frontTry = await ensureFrontmost(pid, win.id);
  record("safety", "N3 · 真实点击前先确认「最前面的窗口就是我们自己的实例」", frontTry.ok, "本实例窗口在最前", JSON.stringify({ ours: win.id, front: frontTry.front, tries: frontTry.tries }));
  if (!frontTry.ok) {
    notVerified("提示条的真实指针点击", "本实例窗口未能成为最前面的窗口；为绝不影响用户其它实例，不发真实点击。");
  } else {
    const boxOf = async (sel) => JSON.parse((await js("const e=document.querySelector(" + JSON.stringify(sel) + "); if(!e) return 'null'; const b=e.getBoundingClientRect(); return JSON.stringify({left:b.left,top:b.top,width:b.width,height:b.height,cx:b.left+b.width/2,cy:b.top+b.height/2});")) || "null");
    const titlebar = Math.max(0, Math.round(Number(await js("return window.outerHeight - window.innerHeight")) || 0));
    const shellBox = JSON.parse(await js("const e=document.querySelector('[data-browser-window]'); if(!e) return 'null'; const b=e.getBoundingClientRect(); return JSON.stringify({left:b.left,top:b.top,width:b.width,height:b.height});"));
    const frame0 = captureTo(win.id, path.join(FRAMES, "01-lab-before.png"));
    const size0 = imageSize(frame0);
    const scale = size0[0] / win.w;
    const scan0 = scanGreen(frame0, Math.round(size0[0] / 2), Math.round(size0[1] / 2));
    const view = viewRectFromPixels(win, scale, scan0);
    if (!view) throw new Error("像素扫描找不到网页区域（页面没显示？）");
    // DOM 原点只来自**窗口 + DOM 事实**（与像素矩形互相独立，避免循环论证）。
    const contentDom = { x: win.x, y: win.y + titlebar };
    const M = makeMapper({ win, scale, viewRect: view, origin: contentDom });
    const safeClick = makeSafeClick({ pid, titlebar, winId: win.id });
    const pixelOf = (pt) => M.pixelOfScreen(frame0, pt);
    // **热身**：系统会把"刚被激活的 App 的第一下点击"用于把窗口变成 key window（不送进内容）。
    // 这是操作系统行为，不是产品缺陷 —— 但它会污染后面每一条"点击归属"断言。
    // 先点窗口标题栏（只触发拖拽、不改变任何状态）并确认外壳真的收到了 pointerdown，最多两下。
    const warmUp = async () => {
      await js("window.__shellPointer = 0; if (!window.__shellPointerInstalled) { window.__shellPointerInstalled = true; document.addEventListener('pointerdown', function () { window.__shellPointer += 1; }, true); } return 'ok'");
      const domWinId = await js("return document.querySelector('[data-browser-window]')?.getAttribute('data-browser-window') || ''");
      const winSel = '[data-window-id="' + domWinId + '"]';
      const winPos = async () => JSON.parse((await js("const b=document.querySelector(" + JSON.stringify(winSel) + "); return JSON.stringify(b?{left:b.getBoundingClientRect().left,top:b.getBoundingClientRect().top}:null)")) || "null");
      const title = await boxOf(winSel + ' .window-title');
      if (!title) return { ok: false, reason: "no-title-bar" };
      const before = await winPos();
      const pt0 = M.domToScreen({ x: title.cx, y: title.cy });
      const trace = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await safeClick(pt0, "warmup-" + i);
        await sleep(350);
        const seen = Number(await js("return window.__shellPointer || 0")) || 0;
        trace.push({ i, click: r.ok ? { ok: true, attempt: r.attempt } : r, shellPointer: seen });
        if (r.ok && seen > 0) {
          const after = await winPos();
          return { ok: true, tries: i + 1, seen, point: pt0, windowRectUnchanged: JSON.stringify(before) === JSON.stringify(after), before, after, trace };
        }
      }
      return { ok: false, reason: "shell-never-received-pointer", point: pt0, trace };
    };
    const warm = await warmUp();
    record("safety", "N3b · 真实指针确实到达本实例外壳（激活后的第一下点击可能被系统用于激活窗口，先热身）", warm.ok, "外壳收到真实 pointerdown（≤2 次热身点击）", JSON.stringify(warm));
    note("窗口/几何：" + JSON.stringify({ quartz: { x: win.x, y: win.y, w: win.w, h: win.h }, scale, titlebar, shell: shellBox, viewFromPixels: view, domOrigin: contentDom, reservedStrip: Math.round(shellBox ? view.top - contentDom.y - shellBox.top - 90 : 0) }));

    /* ── N4 独立校验：真实指针点已知屏幕点 → 页面回报 client 坐标 → 反推视图原点 ── */
    const probeScreen = { x: Math.round((view.left + view.right) / 2), y: Math.round((view.top + view.bottom) / 2) };
    const probePixel = pixelOf(probeScreen);
    const vv = viewByUrl("/notice-lab");
    // 首次点进原生视图可能被用于把焦点交给网页（系统行为）：允许至多 3 次，并如实记录是第几次生效。
    const crossAttempts = [];
    let cb = { ok: false }, seen = null;
    for (let i = 0; i < 3; i += 1) {
      cb = await safeClick(probeScreen, "geometry-crosscheck" + (i ? "-retry" + i : ""));
      await sleep(400);
      seen = vv ? JSON.parse((await viewEval(vv, "const e=(window.__events||[]).filter(x=>x.t==='click').slice(-1)[0]||null; return JSON.stringify(e)")) || "null") : null;
      crossAttempts.push({ i, click: cb.ok ? { ok: true, attempt: cb.attempt } : cb, seen });
      if (seen) break;
    }
    const viewPointer = seen && cb.ok ? { left: probeScreen.x - seen.x, top: probeScreen.y - seen.y } : null;
    const crossOk = !!viewPointer && Math.abs(viewPointer.top - view.top) <= 2 && Math.abs(viewPointer.left - view.left) <= 2;
    // 第三条独立通道：DOM 预留矩形（.web-viewport）按窗口内容原点换算 —— 原生视图必须正好落在它上面
    // （这正是"提示条让位"成立与否的判据：不让位时网页矩形会盖住提示条所在的那一段）。
    const vpDom = JSON.parse(await js("const b=document.querySelector('.web-viewport').getBoundingClientRect(); return JSON.stringify({left:b.left,top:b.top,width:b.width,height:b.height});"));
    const vpScreen = { left: contentDom.x + vpDom.left, top: contentDom.y + vpDom.top, right: contentDom.x + vpDom.left + vpDom.width, bottom: contentDom.y + vpDom.top + vpDom.height };
    const domOk = Math.abs(vpScreen.top - view.top) <= 3 && Math.abs(vpScreen.left - view.left) <= 3 && Math.abs(vpScreen.bottom - view.bottom) <= 3;
    record("geometry", "N4 · 原生视图矩形：像素扫描 = 真实指针反推 = DOM 预留矩形（三路独立，均 ≤3pt）", isPageGreen(probePixel) && crossOk && domOk, "三路一致", JSON.stringify({ pixels: { left: Math.round(view.left), top: Math.round(view.top), bottom: Math.round(view.bottom) }, pointer: viewPointer, domReserved: vpScreen, probeScreen, probePixel, crossOk, domOk, crossAttempts }));

    /* ── N5 提示唯一标识 + 可见性（像素判"谁在上面"） ── */
    const snap0 = JSON.parse(await js(SNAPSHOT));
    const ours = snap0.items.find((n) => n.kind === "permission" && n.text.includes(site.base) && /geolocation/.test(n.text)) || null;
    const beforeTexts = snap0.items.map((n) => n.kind + "|" + n.text);
    if (!ours) {
      record("notice", "N5 · 稳定场景确实产生了一条该站点的 geolocation 权限提示（唯一标识可复核）", false, "存在该站点的 geolocation 权限提示", JSON.stringify(snap0.items.map((n) => ({ kind: n.kind, text: n.text }))));
    } else {
      const identity = { kind: ours.kind, text: ours.text, index: ours.i };
      const closeScreen = ours.close ? M.domToScreen({ x: ours.close.cx, y: ours.close.cy }) : null;
      const noticeScreen = M.domToScreen({ x: ours.rect.left, y: ours.rect.top });
      const overlapH = Math.max(0, Math.min(noticeScreen.y + ours.rect.h, view.bottom) - Math.max(noticeScreen.y, view.top));
      const grid = [];
      for (const fy of [0.15, 0.35, 0.55, 0.75, 0.95]) for (const fx of [0.08, 0.3, 0.5, 0.7, 0.92]) {
        const pt = { x: Math.round(noticeScreen.x + ours.rect.w * fx), y: Math.round(noticeScreen.y + ours.rect.h * fy) };
        grid.push({ fx, fy, screen: pt, rgb: pixelOf(pt) });
      }
      const greenOnNotice = grid.filter((g) => isPageGreen(g.rgb));
      const closePixel = closeScreen ? pixelOf(closeScreen) : null;
      note("提示条屏幕矩形 " + JSON.stringify({ left: Math.round(noticeScreen.x), top: Math.round(noticeScreen.y), w: Math.round(ours.rect.w), h: Math.round(ours.rect.h) }) + "；与原生视图重叠高度 " + overlapH.toFixed(1) + "pt；网格采样 " + grid.length + " 点，其中网页绿 " + greenOnNotice.length + " 点；关闭按钮中心 " + JSON.stringify(closeScreen) + " 像素 " + closePixel);
      record("notice", "N5 · 提示条可见（像素判「谁在上面」）：关闭按钮中心不是网页绿", !!closeScreen && !isPageGreen(closePixel), "按钮中心非网页绿", JSON.stringify({ identity: identity.text, closeScreen, closePixel, overlapH: Number(overlapH.toFixed(1)), greenOnNotice: greenOnNotice.length, gridSize: grid.length }));
      record("notice", "N5b · 提示条整条没有被网页压住（自身矩形内 0 个采样点是网页绿）", greenOnNotice.length === 0, "0 个采样点是网页绿", JSON.stringify({ overlapH: Number(overlapH.toFixed(1)), greenSamples: greenOnNotice.map((g) => ({ fx: g.fx, fy: g.fy, rgb: g.rgb })), viewRect: { left: view.left, top: view.top, right: view.right, bottom: view.bottom }, noticeScreen }));

      /* ── N6 点击归属：外壳侧监听 + 页面自证 ── */
      await js("window.__shellClicks = []; if (!window.__shellClickInstalled) { window.__shellClickInstalled = true; document.addEventListener('click', function (e) { const b = e.target && e.target.closest ? e.target.closest('button') : null; const t = e.target; window.__shellClicks.push({ trusted: !!e.isTrusted, x: e.clientX, y: e.clientY, target: (t && t.getAttribute && (t.getAttribute('aria-label') || t.tagName)) || '', button: b ? (b.getAttribute('aria-label') || String(b.className || '')) : '', at: Date.now() }); }, true); } return 'installed'");
      const pageEventsBefore = Number(await viewEval(vv, "return String((window.__events||[]).length)")) || 0;
      // 系统偶尔会吃掉"刚被激活的窗口的第一下点击"：最多重试 3 次，以**外壳收到**为准。
      let closeClick = { ok: false, reason: "no-close-rect" };
      for (let i = 0; closeScreen && i < 3; i += 1) {
        await js("window.__shellClicks = []");
        closeClick = await safeClick(closeScreen, "notice-close" + (i ? "-retry" + i : ""));
        await sleep(450);
        const seen = JSON.parse((await js("return JSON.stringify(window.__shellClicks || [])")) || "[]");
        if (closeClick.ok && seen.some((c) => c.trusted && /关闭提示/.test(c.button))) break;
      }
      await sleep(300);
      const shellClicks = JSON.parse((await js("return JSON.stringify(window.__shellClicks || [])")) || "[]");
      const snap1 = JSON.parse(await js(SNAPSHOT));
      const afterTexts = snap1.items.map((n) => n.kind + "|" + n.text);
      const oursGone = !afterTexts.includes(identity.kind + "|" + identity.text);
      const othersKept = beforeTexts.filter((t) => t !== identity.kind + "|" + identity.text).every((t) => afterTexts.includes(t));
      const pageEventsAfter = Number(await viewEval(vv, "return String((window.__events||[]).length)")) || 0;
      const frame1 = captureTo(win.id, path.join(FRAMES, "02-lab-after-close.png"));
      record("pointer", "N6 · 真实指针点提示条「关闭」按钮 → 点击到达**外壳**（isTrusted，且命中该按钮）", closeClick.ok && shellClicks.some((c) => c.trusted && /关闭提示/.test(c.button)), "外壳收到该按钮的 isTrusted 点击", JSON.stringify({ click: closeClick, shellClicks }));
      record("pointer", "N6b · 同一条提示按按钮语义被处理（该条消失，其余提示不受影响）", oursGone && othersKept, "仅该条消失", JSON.stringify({ identity: identity.text, before: beforeTexts, after: afterTexts }));
      record("pointer", "N6c · 这次点击**没有**被传给网页（页面自己的事件计数不变）", pageEventsAfter === pageEventsBefore, "页面事件数不变", JSON.stringify({ before: pageEventsBefore, after: pageEventsAfter, frame: path.basename(frame1) }));

      /* ── N7 对照：popup（有明确按钮语义，且不会反复重弹） ── */
      const popupBtnPage = { x: 190, y: 105 }; // 站点 /notice-lab 的 OPEN-POPUP 按钮中心（页面坐标；提示条最高的那一轮也在视口内）
      const tabsBefore = await js("return document.querySelectorAll('[data-tab]').length");
      const popupClick = await safeClick(M.pageToScreen(popupBtnPage), "lab-popup");
      await sleep(1000);
      const pageEventsAfterPopup = Number(await viewEval(vv, "return String((window.__events||[]).length)")) || 0;
      const snap2 = JSON.parse(await js(SNAPSHOT));
      const popupNotice = snap2.items.find((n) => n.kind === "popup") || null;
      record("pointer", "N7 · 对照：真实指针点**网页内**按钮 → 点击确实进了网页（页面事件 +1）", popupClick.ok && pageEventsAfterPopup > pageEventsAfter, "页面事件 +1", JSON.stringify({ before: pageEventsAfter, after: pageEventsAfterPopup, click: popupClick }));
      record("notice", "N7b · 对照：网页请求弹窗 → 外壳出现 popup 提示（有明确按钮语义）", !!popupNotice, "出现 popup 提示", JSON.stringify({ items: snap2.items.map((n) => ({ kind: n.kind, buttons: n.buttons.map((b) => b.label) })) }));
      if (popupNotice) {
        // popup 提示是刚出现的：坐标必须用**当下**的截图与矩形（提示条高度变了，视图矩形也跟着变）
        const frame2 = captureTo(win.id, path.join(FRAMES, "03-popup-notice.png"));
        const scan2 = scanGreen(frame2, Math.round(size0[0] / 2), Math.round(size0[1] / 2));
        const view2 = viewRectFromPixels(win, scale, scan2);
        const M2 = view2 ? makeMapper({ win, scale, viewRect: view2, origin: contentDom }) : null;
        const openBtn = popupNotice.buttons.find((b) => /在新标签打开/.test(b.label));
        const openScreen = openBtn && M2 ? M2.domToScreen({ x: openBtn.cx, y: openBtn.cy }) : null;
        const openPixel = openScreen ? M2.pixelOfScreen(frame2, openScreen) : null;
        let click2 = { ok: false, reason: "no-button" };
        let opened = false;
        for (let i = 0; openScreen && i < 3; i += 1) {
          click2 = await safeClick(openScreen, "notice-popup-open" + (i ? "-retry" + i : ""));
          opened = click2.ok && await waitFor(async () => (await js("return document.querySelectorAll('[data-tab]').length")) > tabsBefore, 4000);
          if (opened) break;
        }
        const snap3 = JSON.parse(await js(SNAPSHOT));
        const popupGone = !snap3.items.some((n) => n.kind === "popup" && n.text === popupNotice.text);
        const pageEventsAfterOpen = Number(await viewEval(vv, "return String((window.__events||[]).length)")) || 0;
        record("pointer", "N7c · 对照：真实指针点 popup 提示的「在新标签打开」→ 真的多出一个标签（按钮本身也没被网页盖住）", opened && !isPageGreen(openPixel), "标签 +1 且按钮像素非网页绿", JSON.stringify({ click: click2, tabsBefore, tabsAfter: await js("return document.querySelectorAll('[data-tab]').length"), buttonScreen: openScreen, buttonPixel: openPixel }));
        record("pointer", "N7d · 对照：该按钮的点击也被外壳消费（该提示消失，且没有漏进网页）", popupGone && pageEventsAfterOpen === pageEventsAfterPopup, "提示消失 + 页面事件不变", JSON.stringify({ popupGone, before: pageEventsAfterPopup, after: pageEventsAfterOpen }));
      }
    }
  }

  const tail = stderrBuf.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !/ExperimentalWarning|SQLite is an experimental/i.test(l)).slice(0, 5);
  record("hygiene", "N8 · 主进程无未处理错误", tail.length === 0, "无错误行", tail.join(" | ") || "clean");

  const out = {
    phase: "D5-01 Closure-4",
    title: "浏览器提示条的可见 / 可操作 / 点击归属（屏幕像素 + 真实指针 + 双侧事件）",
    testedCommit: process.env.OPENARC_TESTED_COMMIT || null,
    command: "node experiments/d5-01/notice-operability-e2e.mjs",
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version, instrument: "screencapture -x -o -l <CGWindowID> + cliclick（CGEvent 真实指针）+ 外壳/页面双侧事件" },
    isolation: { userData: "os.tmpdir mkdtemp", note: "只按本进程 PID 定位窗口；另一个正在运行的 OpenArc 实例绝不被激活/点击/关闭" },
    framesDir: path.relative(ROOT, FRAMES),
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, at: new Date().toISOString(),
  };
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "d5-01-notice-operability-e2e.json"), JSON.stringify(out, null, 2));
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  return failed === 0 ? 0 : 1;
}

let exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("门禁异常：" + String((e && e.stack) || e));
  exitCode = 2;
}
try { if (browser) await browser.close().catch(() => {}); } catch { /* ignore */ }
try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
try { spawnSync("pkill", ["-f", "oa-d501-notice-"], { stdio: "ignore" }); } catch { /* ignore */ }
try { if (site) await site.close(); } catch { /* ignore */ }
try { void sh; } catch { /* ignore */ }
process.exit(exitCode);
