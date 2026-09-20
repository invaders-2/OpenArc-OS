/**
 * D5-01 Closure-3 · **本任务窗口的真实可见性证据**（屏幕像素 + 真实指针输入）。
 *
 * 与其它门禁的区别（也是本门禁存在的理由）：
 *   · 证据是**操作系统级**的：screencapture 抓的是窗口自己的画面，指针是 CGEvent 真事件（cliclick）；
 *   · 绝不用 attached=true / 页面内截图 / DOM 合成点击替代（那些只能证明"DOM 认为自己在屏幕上"）；
 *   · 只操作**本门禁自己启动的隔离实例**：先确认"最前面的窗口就是我们的窗口"，否则宁可判未验证，
 *     也绝不在不确定的情况下发真实点击（避免碰到用户正在运行的另一个 OpenArc 实例）。
 *
 * 站点用 /paint（整页纯色 #0a7d4f）让"网页到底有没有显示"可以用**像素**判定。
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startSite } from "./site.mjs";
import { startD4Provider } from "../../tests/fixtures/d4-04-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "d5-01");
const FRAMES = path.join(ART, "visibility");
const CDP_PORT = Number(process.env.OA_D501_VIS_CDP_PORT || 9794);
const ADMIN = { id: "admin@d501-vis.test", pw: "admin-password-1" };
const PROVIDER_SECRET = "d501-vis-provider-secret";
const PAGE_COLOR = [10, 125, 79]; // #0a7d4f
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RECORD = [], CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [];
let passed = 0, failed = 0;
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 400), at: Date.now() };
  RECORD.push(row); CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  " : "! ") + "[" + row.status + "] " + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
const cliclick = (s) => sh("cliclick", [String(s)]).trim();
const PY = (script, args) => sh("python3", ["-c", script, ...args.map(String)]);

/** 我们进程的屏幕窗口（CGWindowID + bounds）。只按 PID 过滤 —— 绝不碰别的实例。 */
function ourWindows(pid) {
  const py = [
    "import json,sys",
    "from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGNullWindowID",
    "pid=int(sys.argv[1]); out=[]",
    "for w in CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID):",
    "    if w.get('kCGWindowOwnerPID')==pid:",
    "        b=w.get('kCGWindowBounds')",
    "        out.append({'id':int(w.get('kCGWindowNumber')),'x':float(b['X']),'y':float(b['Y']),'w':float(b['Width']),'h':float(b['Height']),'layer':int(w.get('kCGWindowLayer')),'name':str(w.get('kCGWindowName') or '')})",
    "print(json.dumps(out))",
  ].join("\n");
  return JSON.parse(PY(py, [pid]));
}
/** 全屏窗口顺序（用来确认"最前面的是不是我们"）。 */
function frontmostLayer0() {
  const py = [
    "import json,sys",
    "from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGNullWindowID",
    "out=[]",
    "for w in CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID):",
    "    if int(w.get('kCGWindowLayer'))==0: out.append({'pid':int(w.get('kCGWindowOwnerPID')),'id':int(w.get('kCGWindowNumber'))})",
    "print(json.dumps(out[:5]))",
  ].join("\n");
  return JSON.parse(PY(py, []));
}
function capture(id, name) {
  const file = path.join(FRAMES, name);
  sh("screencapture", ["-x", "-o", "-l", String(id), file]);
  return file;
}
/** 读 PNG 某个像素（图像像素坐标）。 */
function pixelAt(file, x, y) {
  const py = [
    "import sys",
    "from Quartz import CGImageSourceCreateWithURL, CGImageSourceCreateImageAtIndex, CGImageGetDataProvider, CGDataProviderCopyData, CGImageGetWidth, CGImageGetHeight, CGImageGetBytesPerRow, CGImageGetBitsPerPixel, CFURLCreateWithFileSystemPath, kCFURLPOSIXPathStyle",
    "url=CFURLCreateWithFileSystemPath(None, sys.argv[1], kCFURLPOSIXPathStyle, False)",
    "src=CGImageSourceCreateWithURL(url, None); img=CGImageSourceCreateImageAtIndex(src,0,None)",
    "bpr=CGImageGetBytesPerRow(img); bpp=CGImageGetBitsPerPixel(img)",
    "buf=bytes(CGDataProviderCopyData(CGImageGetDataProvider(img)))",
    "x=int(sys.argv[2]); y=int(sys.argv[3]); off=y*bpr+x*(bpp//8)",
    "print('%d,%d,%d' % (buf[off], buf[off+1], buf[off+2]))",
  ].join("\n");
  return PY(py, [file, x, y]).trim();
}
/** 一次调用量出两列的"绿区范围"（列坐标用**图像像素**）。 */
function greenRanges(file, cols) {
  const py = [
    "import sys, json",
    "from Quartz import CGImageSourceCreateWithURL, CGImageSourceCreateImageAtIndex, CGImageGetDataProvider, CGDataProviderCopyData, CGImageGetWidth, CGImageGetHeight, CGImageGetBytesPerRow, CGImageGetBitsPerPixel, CFURLCreateWithFileSystemPath, kCFURLPOSIXPathStyle",
    "url=CFURLCreateWithFileSystemPath(None, sys.argv[1], kCFURLPOSIXPathStyle, False)",
    "img=CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(url, None),0,None)",
    "bpr=CGImageGetBytesPerRow(img); bpp=CGImageGetBitsPerPixel(img); h=CGImageGetHeight(img)",
    "buf=bytes(CGDataProviderCopyData(CGImageGetDataProvider(img))); step=bpp//8",
    "out={}",
    "for c in sys.argv[2].split(','):",
    "    x=int(c); first=None; last=None",
    "    for y in range(h):",
    "        o=y*bpr+x*step; r,g,b=buf[o],buf[o+1],buf[o+2]",
    "        if g-r>=40 and g-b>=20:",
    "            if first is None: first=y",
    "            last=y",
    "    out[str(x)]={'first':first,'last':last}",
    "print(json.dumps(out))",
  ].join("\n");
  return JSON.parse(PY(py, [file, cols.join(",")]));
}
function imageSize(file) {
  const py = [
    "import sys",
    "from Quartz import CGImageSourceCreateWithURL, CGImageSourceCreateImageAtIndex, CGImageGetWidth, CGImageGetHeight, CFURLCreateWithFileSystemPath, kCFURLPOSIXPathStyle",
    "url=CFURLCreateWithFileSystemPath(None, sys.argv[1], kCFURLPOSIXPathStyle, False)",
    "img=CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(url, None),0,None)",
    "print('%d,%d' % (CGImageGetWidth(img), CGImageGetHeight(img)))",
  ].join("\n");
  return PY(py, [file]).trim().split(",").map(Number);
}
const closeTo = (rgb, target, tol = 26) => {
  const p = String(rgb).split(",").map(Number);
  return p.length === 3 && Math.abs(p[0] - target[0]) <= tol && Math.abs(p[1] - target[1]) <= tol && Math.abs(p[2] - target[2]) <= tol;
};
const activate = (pid) => { try { sh("osascript", ["-e", "tell application \"System Events\" to set frontmost of (first process whose unix id is " + pid + ") to true"]); return true; } catch { return false; } };

let child = null, browser = null, page = null, site = null, provider = null, stderrBuf = "";
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const attr = (sel, a) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.getAttribute(" + JSON.stringify(a) + ") || ''");
const value = (sel) => js("return document.querySelector(" + JSON.stringify(sel) + ")?.value || ''");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : (el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype); Object.getOwnPropertyDescriptor(proto,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(100); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);
const bridge = (domain, command) => js("return window.openarc." + domain + ".command(" + JSON.stringify(command) + ")");
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
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d501-vis-"));
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
  return userData;
}

async function main() {
  fs.mkdirSync(FRAMES, { recursive: true });
  site = await startSite();
  provider = await startD4Provider();
  await launch();
  const pid = child.pid;
  record("boot", "V0 · 真实 electron . 启动（隔离 userData / 隔离 CDP 端口）", !!browser, "CDP 可用", "connected");

  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    await setInput('[data-d3-id="setup-name"]', "D5-01 Vis Admin");
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  await waitSel('[data-d3-id="login-identifier"]', 20000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  record("boot", "V1 · 真实 UI 登录 admin", await waitFor(async () => (await gate()) === "ready", 90000), "ready", await gate());

  // 最小 provider（只为让审批面板能出现；可见性不依赖模型质量）
  await clickDom('[data-app-id="settings"]');
  await waitSel('[data-settings-pane="model"]', 20000);
  await clickDom('[data-settings-pane="model"]');
  await waitSel('[data-d4-01="settings"]', 20000);
  await setInput('[data-d4-01-provider-name]', "D5-01 Vis Provider");
  await setInput('[data-d4-01-provider-scope]', "ORGANIZATION");
  await setInput('[data-d4-01-provider-url]', provider.baseUrl);
  await setInput('[data-d4-01-provider-secret]', PROVIDER_SECRET);
  await clickDom('[data-d4-01-provider-create]');
  await waitSel('[data-d4-01-provider]', 20000);
  const pidProvider = await js("return Array.from(document.querySelectorAll('[data-d4-01-provider]')).map((e)=>e.getAttribute('data-d4-01-provider')).filter(Boolean)[0] || ''");
  await clickDom('[data-d4-01-tab="models"]');
  await waitSel('[data-d4-01-pane="models"]', 20000);
  await setInput('[data-d4-01-model-provider]', pidProvider);
  await setInput('[data-d4-01-model-scope]', "ORGANIZATION");
  await setInput('[data-d4-01-model-remote]', "d501-vis-local");
  await setInput('[data-d4-01-model-name]', "D5-01 Vis Local");
  await clickDom('[data-d4-01-model-create]');
  await waitSel('[data-d4-01-model]', 20000);
  const cid = await attr("[data-d4-01-model]", "data-d4-01-model");
  await clickDom('[data-d4-01-tab="defaults"]');
  await waitSel('[data-d4-01-pane="defaults"]', 20000);
  await setInput('[data-d4-01-default-personal-chat]', cid);
  await setInput('[data-d4-01-default-org-chat]', cid);
  await clickDom('[data-gov-tool-grant="ai"]').catch(() => {});
  await bridge("governance", { type: "governance/grantAppToolAccess", appId: "ai", actions: ["tool.browser.read", "tool.browser.navigate"] });
  await fetch(provider.baseUrl.replace("/v1", "") + "/__plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: [{ name: "browser_navigate", args: { viewId: "browser#t1", url: site.base + "/page2" } }] }) });

  const PAINT = site.base + "/paint";
  await clickDom('[aria-label="打开浏览器"]');
  await waitSel("[data-browser-window]", 20000);
  await setInput('[aria-label="网页地址"]', PAINT);
  await clickDom(".addressbar .primary");
  const view = await waitFor(() => !!viewByUrl("/paint"), 25000) ? viewByUrl("/paint") : null;
  record("setup", "V2 · 真实视图加载纯色页面（像素判定的基准）", !!view && (await viewEval(view, "return document.getElementById('paint-marker')?.textContent || ''")) === "PAINT-MARKER-2f7d", "PAINT-MARKER-2f7d", view ? view.url() : "无视图");
  await sleep(600);

  /* ── 我们的窗口 + 最前面确认（否则不发真实点击） ── */
  activate(pid);
  await sleep(900);
  const wins = ourWindows(pid).filter((w) => w.layer === 0 && w.w > 400 && w.h > 300);
  if (!wins.length) throw new Error("找不到本实例的屏幕窗口（CGWindow）");
  const win = wins[0];
  const front = frontmostLayer0();
  const isFront = front.length > 0 && front[0].id === win.id;
  record("safety", "V3 · 真实点击前先确认「最前面的窗口就是我们自己的实例」", isFront, "本实例窗口在最前", JSON.stringify({ ours: win.id, front: front.slice(0, 3) }));
  if (!isFront) {
    notVerified("真实指针输入（标签栏/地址栏/网页交互/窗口缩放）", "我们的隔离实例未能成为最前面的窗口；为**绝不影响**用户正在运行的另一个 OpenArc 实例，本门禁不发真实点击，改为保持未验证。需要的条件：本实例窗口可被激活到最前（无其它窗口覆盖其区域）。");
  } else {
    const geo = JSON.parse(await js("const c=(s)=>{const e=document.querySelector(s); if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2,w:b.width,h:b.height};}; return JSON.stringify({origin:{x:window.screenX,y:window.screenY},outer:{ow:window.outerWidth,oh:window.outerHeight,iw:window.innerWidth,ih:window.innerHeight},tabNew:c('[data-tab-new]'),addr:c('[aria-label=\"网页地址\"]'),viewport:c('.web-viewport'),dl:c('[data-downloads-toggle]'),dlPanel:null});"));
    const titlebar = Math.max(0, Math.round(geo.outer.oh - geo.outer.ih));
    const contentTop = win.y + titlebar;
    // 像素判定：macOS 截图会做色彩管理（P3→sRGB），因此判"这一块是不是网页纯绿"用**绿占优**而不是精确值。
    const isPageGreen = (rgb) => { const p = String(rgb).split(",").map(Number); return p.length === 3 && p[1] - p[0] >= 40 && p[1] - p[2] >= 20; };
    const frame0 = capture(win.id, "01-paint-before.png");
    const size0 = imageSize(frame0);
    const scale = size0[0] / win.w;
    const vpCenter = { x: Math.round(geo.origin.x + geo.viewport.x), y: Math.round(geo.origin.y + geo.viewport.y) };
    const pixelOfPoint = (file, pt) => pixelAt(file, Math.round((pt.x - win.x) * scale), Math.round((pt.y - win.y) * scale));
    const before = pixelOfPoint(frame0, vpCenter);
    record("pixel", "V4 · 屏幕像素证明确实「看得见」网页（视口中心是页面纯绿）", isPageGreen(before), "页面纯绿（绿占优）", String(before));
    record("pixel", "V4b · 截图确实是本窗口的画面（图像尺寸 = 窗口 bounds × 缩放）", size0[0] > 400 && Math.abs(scale - Math.round(scale)) < 0.01, "尺寸一致", JSON.stringify({ image: size0, win: { w: Math.round(win.w), h: Math.round(win.h) }, scale, titlebar }));

    // 直接**从像素**量出"网页那一块"在窗口里的真实范围（而不是相信 DOM 占位符），
    // 并与 DOM 占位符比较 —— 两者的差就是"原生视图与预留位置是否一致"的真值。
    const scanCol = Math.round((vpCenter.x - win.x) * scale);
    const ranges = greenRanges(frame0, [scanCol, 6]);
    const r1 = ranges[String(scanCol)] || { first: null, last: null };
    const shellCol = ranges["6"] || { first: null, last: null };
    const firstGreen = r1.first, lastGreen = r1.last;
    const viewRectFromPixels = firstGreen == null ? null : { topPt: Math.round(win.y + firstGreen / scale), bottomPt: Math.round(win.y + lastGreen / scale) };
    const shellColGreen = shellCol.first != null;
    const placeholderTopPt = Math.round(geo.origin.y + geo.viewport.y - geo.viewport.h / 2);
    const placeholderBottomPt = Math.round(placeholderTopPt + geo.viewport.h);
    const rectDelta = viewRectFromPixels ? { top: viewRectFromPixels.topPt - placeholderTopPt, bottom: viewRectFromPixels.bottomPt - placeholderBottomPt } : null;
    record("pixel", "V4c · 像素量出的网页范围与 DOM 预留位置一致（原生视图没有压住 chrome、也没有错位）", !shellColGreen && !!rectDelta && Math.abs(rectDelta.top) <= 4 && Math.abs(rectDelta.bottom) <= 6, "|Δtop|≤4 且 |Δbottom|≤6", JSON.stringify({ fromPixels: viewRectFromPixels, placeholder: { topPt: placeholderTopPt, bottomPt: placeholderBottomPt }, delta: rectDelta, titlebar, chromePt: 90, shellColumnGreen: shellColGreen, shellColumn: shellCol }));

    /** 真实点击前的**安全闸**：① 窗口还在；② 我们仍是最前面的窗口；③ 落点在我们的内容区内。 */
    const safeClick = async (pt, label) => {
      const w = ourWindows(pid).filter((x) => x.layer === 0 && x.w > 400)[0];
      if (!w) return { ok: false, reason: "window-gone:" + label };
      const front2 = frontmostLayer0();
      if (!front2.length || front2[0].id !== w.id) return { ok: false, reason: "not-frontmost:" + label };
      if (pt.x < w.x + 6 || pt.x > w.x + w.w - 6 || pt.y < w.y + titlebar + 4 || pt.y > w.y + w.h - 6) return { ok: false, reason: "outside-content:" + label };
      cliclick("m:" + pt.x + "," + pt.y); await sleep(150); cliclick("c:" + pt.x + "," + pt.y);
      return { ok: true };
    };
    const focusedAddress = () => js("return document.activeElement === document.querySelector('[aria-label=\"网页地址\"]')");

    /* 先用地址栏做**坐标标定**：真实指针点在哪个 dy 上能真的把焦点送进输入框。 */
    let dy = 0; let calib = null;
    for (const cand of [0, 6, 12, 20, 28, -6, -12]) {
      const pt = { x: Math.round(geo.origin.x + geo.addr.x), y: Math.round(geo.origin.y + geo.addr.y + cand) };
      const r = await safeClick(pt, "calib");
      if (!r.ok) { calib = r; break; }
      await sleep(250);
      if (await focusedAddress()) { dy = cand; calib = { ok: true, dy: cand }; break; }
    }
    record("safety", "V3b · 真实点击只落在本实例窗口内（每次点击前重新校验前台与内容区）", !!(calib && calib.ok), "点击被安全闸放行", JSON.stringify(calib));
    if (calib && calib.ok) {
      record("pointer", "V6 · 真实指针点击地址栏 → 焦点真的进入输入框（并据此标定坐标偏移）", await focusedAddress(), "activeElement=地址栏", JSON.stringify({ dy }));
      capture(win.id, "03-addressbar-focus.png");
      const toScreen = (p) => ({ x: Math.round(geo.origin.x + p.x), y: Math.round(geo.origin.y + p.y + dy) });

      /* V5 标签栏：真实指针点击「新建标签」→ 真的多出一个标签；再点第二个标签 → 活动标签切换 */
      const tabs0 = await js("return document.querySelectorAll('[data-tab]').length");
      const addR = await safeClick(toScreen(geo.tabNew), "new-tab");
      const added = addR.ok && await waitFor(async () => (await js("return document.querySelectorAll('[data-tab]').length")) === tabs0 + 1, 6000);
      record("pointer", "V5 · 真实指针点击标签栏「新建标签」→ 真的多出一个标签", added, "标签数 +1", JSON.stringify({ before: tabs0, after: await js("return document.querySelectorAll('[data-tab]').length"), click: addR }));
      if (added) {
        const g2 = JSON.parse(await js("const e=document.querySelectorAll('[data-tab]')[1]; const b=e.getBoundingClientRect(); return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2,id:e.getAttribute('data-tab')});"));
        const r2 = await safeClick(toScreen(g2), "tab-switch");
        const switched = r2.ok && await waitFor(async () => (await attr('[data-tab][data-tab-active="1"]', "data-tab")) === g2.id, 6000);
        const frame1 = capture(win.id, "02-tab-switch.png");
        record("pointer", "V5b · 真实指针点击第二个标签 → 活动标签真的切换", switched, "第二个标签变为活动", JSON.stringify({ want: g2.id, active: await attr('[data-tab][data-tab-active="1"]', "data-tab"), click: r2 }));
        record("pixel", "V5c · 操作前后两帧像素确实不同（画面真的变了）", fs.readFileSync(frame0).length !== fs.readFileSync(frame1).length || pixelOfPoint(frame1, vpCenter) !== before, "帧不同", path.basename(frame1));
        // 切回第一个标签，后面的页面交互仍在原来的网页视图上
        const g1 = JSON.parse(await js("const e=document.querySelectorAll('[data-tab]')[0]; const b=e.getBoundingClientRect(); return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2,id:e.getAttribute('data-tab')});"));
        await safeClick(toScreen(g1), "tab-back");
        await waitFor(async () => (await attr('[data-tab][data-tab-active="1"]', "data-tab")) === g1.id, 6000);
        await sleep(400);
      }

      /* V7 网页可见 + 可交互：真实指针点击页面内部（页面自己记录落点，用来度量真实命中位置） */
      const vpRect = JSON.parse(await js("const b=document.querySelector('.web-viewport').getBoundingClientRect(); return JSON.stringify({left:b.left,top:b.top,width:b.width,height:b.height});"));
      const pageClick = async (pageX, pageY, tag) => {
        const r = await safeClick(toScreen({ x: vpRect.left + pageX, y: vpRect.top + pageY }), tag);
        await sleep(400);
        const vv = viewByUrl("/paint");
        const last = vv ? await viewEval(vv, "return JSON.stringify(window.__lastClick || null)") : "null";
        const count = vv ? await viewEval(vv, "return document.getElementById('paint-count')?.textContent || ''") : "";
        return { r, last: JSON.parse(last || "null"), count };
      };
      // 先点页面**中心**（最稳的命中目标）——同时用它标定"我们算出的屏幕点"到"页面坐标系"的常量偏移。
      const probePage = { x: Math.round(vpRect.width / 2), y: Math.round(vpRect.height / 2) };
      const centerTry = await pageClick(probePage.x, probePage.y, "page-center");
      const pageGeo = JSON.parse((await viewEval(viewByUrl("/paint"), "return JSON.stringify({scrollY: window.scrollY, innerH: window.innerHeight, docH: document.documentElement.scrollHeight, innerW: window.innerWidth})")) || "{}");
      const dxCal = centerTry.last ? Math.round(centerTry.last.x - probePage.x) : 0;
      const dyCal = centerTry.last ? Math.round(centerTry.last.y - probePage.y) : 0;
      note("页面坐标标定：探测点 " + JSON.stringify(probePage) + " → 页面实际收到 " + JSON.stringify(centerTry.last) + "，常量偏移 dx=" + dxCal + " dy=" + dyCal + "；页面 scrollY=" + pageGeo.scrollY + " innerH=" + pageGeo.innerH + " docH=" + pageGeo.docH);
      const btnInPage = { x: 60 + 130 - dxCal, y: 140 + 45 - dyCal }; // 用标定结果把"页面内的目标"换算成"我们该发的屏幕坐标"
      const btnTry = await pageClick(btnInPage.x, btnInPage.y, "page-button");
      const frame2 = capture(win.id, "04-page-click.png");
      const hit = !!(centerTry.last || btnTry.last);
      record("pointer", "V7 · 真实指针点击**网页内部** → 页面自己收到了点击（网页真的可见且可交互）", hit && !!(centerTry.count || btnTry.count), "页面收到真实点击并计数", JSON.stringify({ center: { last: centerTry.last, count: centerTry.count, click: centerTry.r }, button: { last: btnTry.last, count: btnTry.count, click: btnTry.r }, calibration: { dx: dxCal, dy: dyCal, pageGeo }, frame: path.basename(frame2) }));
      record("pointer", "V7b · 标定后点中页面按钮本体（落点误差 ≤ 6px，目标 = CLICK-ME）", !!btnTry.last && Math.abs(btnTry.last.x - 190) <= 6 && Math.abs(btnTry.last.y - 185) <= 6, "命中按钮", JSON.stringify({ got: btnTry.last, wantPagePoint: { x: 190, y: 185 }, calibration: { dx: dxCal, dy: dyCal } }));

      /* V8 面板出现时网页让位（像素级） */
      const dlR = await safeClick(toScreen(geo.dl), "downloads-toggle");
      await sleep(700);
      const frame3 = capture(win.id, "05-panel-open.png");
      const during = pixelOfPoint(frame3, vpCenter);
      record("pixel", "V8 · 面板打开时网页**让位**（视口中心像素不再是页面绿）", dlR.ok && !isPageGreen(during), "非页面绿", JSON.stringify({ pixel: during, click: dlR }));
      await safeClick(toScreen(geo.dl), "downloads-toggle-close");
      await sleep(700);
      const wAfter = ourWindows(pid).filter((x) => x.layer === 0 && x.w > 400)[0];
      const frame4 = capture(win.id, "06-panel-closed.png");
      const after = pixelOfPoint(frame4, vpCenter);
      record("pixel", "V8b · 面板关闭后网页回到可见（像素回到页面绿）", isPageGreen(after) && !!wAfter, "页面绿", String(after));

      /* V9 窗口缩放后布局与点击位置仍然一致 */
      let resized = false;
      try {
        const before2 = ourWindows(pid).filter((x) => x.layer === 0 && x.w > 400)[0];
        if (before2) {
          sh("osascript", ["-e", "tell application \"System Events\" to tell (first process whose unix id is " + pid + ") to set size of window 1 to {" + Math.round(Math.max(900, before2.w - 260)) + ", " + Math.round(Math.max(620, before2.h - 200)) + "}"]);
          await sleep(1200);
          const after2 = ourWindows(pid).filter((x) => x.layer === 0 && x.w > 400)[0];
          resized = !!after2 && (Math.abs(after2.w - before2.w) > 40 || Math.abs(after2.h - before2.h) > 40);
          if (resized) {
            activate(pid); await sleep(800);
            const geo2 = JSON.parse(await js("const c=(s)=>{const e=document.querySelector(s); if(!e) return null; const b=e.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2};}; return JSON.stringify({origin:{x:window.screenX,y:window.screenY},viewport:c('.web-viewport')});"));
            const vp2 = JSON.parse(await js("const b=document.querySelector('.web-viewport').getBoundingClientRect(); return JSON.stringify({left:b.left,top:b.top});"));
            // 缩放后重新标定（布局变了，偏移必须重新测，不能用旧值）
            const probe2 = { x: Math.round(vp2.left + Math.round(Number((await js("return document.querySelector('.web-viewport').getBoundingClientRect().width")) || 0) / 2)), y: Math.round(vp2.top + Math.round(Number((await js("return document.querySelector('.web-viewport').getBoundingClientRect().height")) || 0) / 2)) };
            const cal2 = await safeClick({ x: Math.round(geo2.origin.x + probe2.x), y: Math.round(geo2.origin.y + probe2.y + dy) }, "recalib");
            await sleep(400);
            const vvCal = viewByUrl("/paint");
            const calLast = vvCal ? JSON.parse((await viewEval(vvCal, "return JSON.stringify(window.__lastClick || null)")) || "null") : null;
            const dxCal2 = calLast ? Math.round(calLast.x - (probe2.x - vp2.left)) : 0;
            const dyCal2 = calLast ? Math.round(calLast.y - (probe2.y - vp2.top)) : 0;
            void cal2;
            const pt2 = { x: Math.round(geo2.origin.x + vp2.left + (190 - dxCal2)), y: Math.round(geo2.origin.y + vp2.top + dy + (185 - dyCal2)) };
            const r3 = await safeClick(pt2, "page-button-after-resize");
            await sleep(400);
            const vv3 = viewByUrl("/paint");
            const last3 = vv3 ? JSON.parse((await viewEval(vv3, "return JSON.stringify(window.__lastClick || null)")) || "null") : null;
            const counted2 = r3.ok && !!last3 && Math.abs(last3.x - 190) <= 8 && Math.abs(last3.y - 185) <= 8;
            const frame5 = capture(win.id, "07-after-resize.png");
            const s5 = imageSize(frame5);
            record("pointer", "V9 · 窗口缩放后重新测量坐标，真实指针点击仍然命中页面内部（落点误差 ≤ 8px）", counted2, "落点命中", JSON.stringify({ last: last3, click: r3, from: before2 ? { w: Math.round(before2.w), h: Math.round(before2.h) } : null, to: { w: Math.round(after2.w), h: Math.round(after2.h) } }));
            record("pixel", "V9b · 缩放后截图尺寸随之变化（画面确实是缩放后的窗口）", Math.abs(s5[0] / after2.w - scale) < 0.01, "比例一致", JSON.stringify({ image: s5, win: { w: Math.round(after2.w), h: Math.round(after2.h) }, frame: path.basename(frame5) }));
          }
        }
      } catch (e) {
        note("窗口缩放（System Events）失败：" + String(e && e.message).slice(0, 120));
      }
      if (!resized) notVerified("窗口缩放后的布局/点击一致性", "本机 System Events 未能改变窗口尺寸（或尺寸未变化）；需要的条件：允许通过辅助功能接口调整该窗口大小。");

      /* V10 连续帧（录屏等价物）：一段连续操作期间的多帧 */
      const burst = [];
      for (let i = 0; i < 4; i += 1) { burst.push(path.basename(capture(win.id, "08-burst-" + i + ".png"))); await sleep(350); }
      const sizes = burst.map((f) => fs.statSync(path.join(FRAMES, f)).size);
      record("pixel", "V10 · 连续截图可用（一段连续操作的多帧都真实落盘）", sizes.every((s) => s > 5000), "4 帧", JSON.stringify({ frames: burst, bytes: sizes }));
    } else {
      notVerified("真实指针输入（标签栏/地址栏/网页交互/窗口缩放）", "坐标标定第一步就被安全闸拦下（" + JSON.stringify(calib) + "）；为绝不影响其它实例，未继续发真实点击。");
    }
  }

  const tail = stderrBuf.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !/ExperimentalWarning|SQLite is an experimental/i.test(l)).slice(0, 5);
  record("hygiene", "H1 · 主进程无未处理错误", tail.length === 0, "无错误行", tail.join(" | ") || "clean");

  const out = {
    phase: "D5-01 Closure-3",
    title: "本任务窗口的真实可见性（屏幕像素 + 真实指针输入）",
    testedCommit: process.env.OPENARC_TESTED_COMMIT || null,
    command: process.env.npm_lifecycle_event ? "npm run " + process.env.npm_lifecycle_event : "node experiments/d5-01/visibility-e2e.mjs",
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version, instrument: "screencapture -x -o -l <CGWindowID> + cliclick（CGEvent 真实指针）" },
    isolation: { userData: "os.tmpdir mkdtemp", note: "只按本进程 PID 定位窗口；另一个正在运行的 OpenArc 实例绝不被激活/点击/关闭" },
    framesDir: path.relative(ROOT, FRAMES),
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, operationRecord: RECORD, at: new Date().toISOString(),
  };
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "d5-01-visibility-e2e.json"), JSON.stringify(out, null, 2));
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  return failed === 0 ? 0 : 1;
}

/** 以"点 → 图像像素"的同一换算读一帧里的像素。 */
function pixelOfPoint2(file, win, scale, pt) {
  return pixelAt(file, Math.round((pt.x - win.x) * scale), Math.round((pt.y - win.y) * scale));
}

let exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("门禁异常：" + String((e && e.stack) || e));
  exitCode = 2;
}
try { if (browser) await browser.close().catch(() => {}); } catch { /* ignore */ }
try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
try { spawnSync("pkill", ["-f", "oa-d501-vis-"], { stdio: "ignore" }); } catch { /* ignore */ }
try { if (site) await site.close(); } catch { /* ignore */ }
try { if (provider) await provider.close(); } catch { /* ignore */ }
process.exit(exitCode);
