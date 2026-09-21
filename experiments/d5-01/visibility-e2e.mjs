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
// **唯一换算**：屏幕像素 / 真实指针 / DOM 三条实测通道 + 一个换算器（见模块头部说明）。
// 本文件不再自带任何"按 DOM 占位符 + 经验 dy"的换算路径。
import {
  sh, cliclick, ourWindows, activate, ensureFrontmost,
  captureTo, imageSize, scanGreen, viewRectFromPixels, makeMapper, makeSafeClick,
  isPageGreen, sleep,
} from "./screen-geometry.mjs";

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

const RECORD = [], CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [];
let passed = 0, failed = 0;
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 2400), at: Date.now() };
  RECORD.push(row); CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  " : "! ") + "[" + row.status + "] " + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };

/** 抓本窗口画面到 artifacts（几何 / 可见性判定的输入）。 */
const capture = (id, name) => captureTo(id, path.join(FRAMES, name));

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
    // 集成分支保留 UI 线已定的"三步初始化向导"（显示名 → 账号 → 密码），末步才提交：
    // 后两步的输入在 DOM 里尚未存在，一次填完再点 setup-submit 不会发生任何事。
    // 驱动方式与 UI 线探针（tests/fixtures/identity-ui-probe/main.cjs）一致。
    const setupNext = async () => {
      await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000);
      await clickDom('[data-d3-id="setup-next"]');
    };
    await setInput('[data-d3-id="setup-name"]', "D5-01 Vis Admin");
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
  const frontTry = await ensureFrontmost(pid, win.id);
  const isFront = frontTry.ok;
  record("safety", "V3 · 真实点击前先确认「最前面的窗口就是我们自己的实例」", isFront, "本实例窗口在最前", JSON.stringify({ ours: win.id, front: frontTry.front, tries: frontTry.tries }));
  if (!isFront) {
    notVerified("真实指针输入（标签栏/地址栏/网页交互/窗口缩放）", "我们的隔离实例未能成为最前面的窗口；为**绝不影响**用户正在运行的另一个 OpenArc 实例，本门禁不发真实点击，改为保持未验证。需要的条件：本实例窗口可被激活到最前（无其它窗口覆盖其区域）。");
  } else {
    const geo = JSON.parse(await js("const c=(s)=>{const e=document.querySelector(s); if(!e) return null; const b=e.getBoundingClientRect(); return {left:b.left,top:b.top,width:b.width,height:b.height,x:b.left+b.width/2,y:b.top+b.height/2,w:b.width,h:b.height};}; const bn=document.querySelector('.browser-notices, .browser-error'); const k=bn?bn.querySelector('[data-notice-kind]'):null; return JSON.stringify({origin:{x:window.screenX,y:window.screenY},outer:{ow:window.outerWidth,oh:window.outerHeight,iw:window.innerWidth,ih:window.innerHeight},tabNew:c('[data-tab-new]'),addr:c('[aria-label=\"网页地址\"]'),dl:c('[data-downloads-toggle]'),vp:c('.web-viewport'),shell:c('[data-browser-window]'),banner:bn?{cls:String(bn.className),left:bn.getBoundingClientRect().left,top:bn.getBoundingClientRect().top,width:bn.getBoundingClientRect().width,height:bn.getBoundingClientRect().height,kind:k?k.getAttribute('data-notice-kind'):null,text:String(bn.innerText||'').slice(0,80)}:null});"));
    const titlebar = Math.max(0, Math.round(geo.outer.oh - geo.outer.ih));
    // 通道③：窗口 + DOM 事实推出的"网页坐标系原点"（不依赖任何点击标定）。
    const contentDom = { x: win.x, y: win.y + titlebar };
    /** 真实点击前的安全闸（每次点击前重新校验前台与落点；见 screen-geometry.mjs）。 */
    const safeClick = makeSafeClick({ pid, titlebar, winId: win.id });
    const boxOf = async (sel) => JSON.parse((await js("const e=document.querySelector(" + JSON.stringify(sel) + "); if(!e) return 'null'; const b=e.getBoundingClientRect(); return JSON.stringify({left:b.left,top:b.top,width:b.width,height:b.height,cx:b.left+b.width/2,cy:b.top+b.height/2});")) || "null");
    /** 外壳侧点击监听：真实指针点外壳控件时，证据必须来自外壳自己（isTrusted + 命中哪个按钮）。 */
    const shellWatch = () => js("window.__shellClicks = []; if (!window.__shellClickInstalled) { window.__shellClickInstalled = true; document.addEventListener('click', function (e) { const b = e.target && e.target.closest ? e.target.closest('button') : null; const t = e.target; window.__shellClicks.push({ trusted: !!e.isTrusted, x: e.clientX, y: e.clientY, target: (t && t.getAttribute && (t.getAttribute('aria-label') || t.tagName)) || '', button: b ? (b.getAttribute('aria-label') || String(b.className || '')) : '' }); }, true); } return 'ok'");
    const shellClicks = async () => JSON.parse((await js("return JSON.stringify(window.__shellClicks || [])")) || "[]");
    /**
     * 真实指针点击 + **回执**：系统偶尔会把"刚被激活的窗口的第一下点击"吃掉（不送进内容），
     * 因此最多重试 3 次，并以"外壳自己收到这次点击"为准 —— 绝不以"我们发了点击"当成功。
     */
    const clickUntil = async (pt, label, received, tries = 3) => {
      const trace = [];
      for (let i = 0; i < tries; i += 1) {
        await shellWatch();
        const r = await safeClick(pt, label + (i ? "-retry" + i : ""));
        await sleep(320);
        const got = await received();
        trace.push({ i, click: r.ok ? { ok: true, attempt: r.attempt } : r, received: !!got });
        if (r.ok && got) return { ok: true, tries: i + 1, trace };
      }
      return { ok: false, reason: "not-received:" + label, trace };
    };
    /** DOM 命中测试：这个 DOM 点现在到底压在哪个元素上（坐标换算的独立旁证）。 */
    const elementAt = (p) => js("const e=document.elementFromPoint(" + Math.round(p.x) + "," + Math.round(p.y) + "); if(!e) return 'none'; const b=e.closest?e.closest('button'):null; return (b && b.getAttribute('aria-label')) || e.getAttribute('aria-label') || (e.tagName + '.' + String(e.className||'').split(' ')[0]);");
    const frame0 = capture(win.id, "01-paint-before.png");
    const size0 = imageSize(frame0);
    const scale = size0[0] / win.w;
    // 通道①：**像素**——扫中间一行/一列，直接量出网页那一块在屏幕上的矩形。
    const scan0 = scanGreen(frame0, Math.round(size0[0] / 2), Math.round(size0[1] / 2));
    const viewPixels = viewRectFromPixels(win, scale, scan0);
    // 通道③的预测：DOM 预留矩形（.web-viewport）按"窗口内容原点"换算到屏幕。
    const vpScreen = viewPixels ? { left: contentDom.x + geo.vp.left, top: contentDom.y + geo.vp.top, right: contentDom.x + geo.vp.left + geo.vp.width, bottom: contentDom.y + geo.vp.top + geo.vp.height } : null;
    // 换算器的 DOM 原点来自**窗口 + DOM 事实**（③），不由像素矩形反推 —— 两条几何各自独立。
    const M = viewPixels ? makeMapper({ win, scale, viewRect: viewPixels, origin: contentDom }) : null;
    const pixelOfPoint = (file, pt) => M.pixelOfScreen(file, pt);
    const origTitlebar = titlebar;
    /** 当下实测（每次布局变化后都重新走一遍）：抓帧 → 扫像素 → 视图矩形 → 唯一换算器。 */
    const measureView = async (tag) => {
      const w = ourWindows(pid).filter((x) => x.layer === 0 && x.w > 400)[0] || win;
      const shellRect = JSON.parse(await js("const e=document.querySelector('[data-browser-window]'); if(!e) return 'null'; const b=e.getBoundingClientRect(); return JSON.stringify({left:b.left,top:b.top,width:b.width,height:b.height});"));
      const file = capture(w.id, tag);
      const size = imageSize(file);
      const sc = size[0] / w.w;
      const scan = scanGreen(file, Math.round(size[0] / 2), Math.round(size[1] / 2));
      const rect = viewRectFromPixels(w, sc, scan);
      const origin = { x: w.x, y: w.y + Math.max(0, Math.round(Number(origTitlebar) || 0)) };
      return { win: w, file, size, scale: sc, rect, shellRect, origin, mapper: rect && shellRect ? makeMapper({ win: w, scale: sc, viewRect: rect, origin }) : null };
    };
    const vpCenter = viewPixels ? { x: Math.round((viewPixels.left + viewPixels.right) / 2), y: Math.round((viewPixels.top + viewPixels.bottom) / 2) } : null;
    const before = vpCenter ? pixelOfPoint(frame0, vpCenter) : "0,0,0";
    record("pixel", "V4 · 屏幕像素证明确实「看得见」网页（视口中心是页面纯绿）", isPageGreen(before), "页面纯绿（绿占优）", String(before));
    record("pixel", "V4b · 截图确实是本窗口的画面（图像尺寸 = 窗口 bounds × 缩放）", size0[0] > 400 && Math.abs(scale - Math.round(scale)) < 0.01, "尺寸一致", JSON.stringify({ image: size0, win: { w: Math.round(win.w), h: Math.round(win.h) }, scale, titlebar }));
    // 通道②：**真实指针**——点像素矩形中心，网页回报它自己的 client 坐标 → 反推视图原点。
    const vv0 = viewByUrl("/paint");
    const centerTry = await safeClick(vpCenter, "geometry-crosscheck");
    await sleep(400);
    const seenCenter = vv0 ? JSON.parse((await viewEval(vv0, "const e=(window.__lastClick||null); return JSON.stringify(e)")) || "null") : null;
    const viewPointer = seenCenter && centerTry.ok ? { left: vpCenter.x - seenCenter.x, top: vpCenter.y - seenCenter.y } : null;
    const pageGeoC = vv0 ? JSON.parse((await viewEval(vv0, "return JSON.stringify({iw:window.innerWidth,ih:window.innerHeight,dpr:window.devicePixelRatio,scrollY:window.scrollY})")) || "{}") : {};
    const delta = (a, b) => (a && b ? { top: Math.round(a.top - b.top), left: Math.round(a.left - b.left), bottom: Math.round(a.bottom - b.bottom), right: Math.round(a.right - b.right) } : null);
    const dPixDom = delta(viewPixels, vpScreen);          // ① vs ③
    const dPixPtr = viewPointer ? delta(viewPixels, { left: viewPointer.left, top: viewPointer.top, right: viewPointer.left + (viewPixels ? viewPixels.width : 0), bottom: viewPointer.top + (viewPixels ? viewPixels.height : 0) }) : null; // ① vs ②
    const sizeOk = viewPixels && Math.abs(viewPixels.width - Number(pageGeoC.iw)) <= 3 && Math.abs(viewPixels.height - Number(pageGeoC.ih)) <= 3;
    note("几何（屏幕 pt）：像素真值 " + JSON.stringify(viewPixels) + "；DOM 预留矩形 " + JSON.stringify(vpScreen) + "；指针反推原点 " + JSON.stringify(viewPointer) + "；网页自报 innerWidth/Height " + pageGeoC.iw + "×" + pageGeoC.ih + "；chrome 之下条带高度 " + (geo.shell ? Math.round(geo.vp.top - geo.shell.top - 90) : "?") + "；banner " + JSON.stringify(geo.banner ? { cls: geo.banner.cls, h: geo.banner.height, kind: geo.banner.kind } : null));
    record("pixel", "V4c · 三条独立通道一致：像素真值 = DOM 预留矩形 = 指针反推（|Δ|≤3pt，宽高也对）", !!dPixDom && !!dPixPtr && Math.abs(dPixDom.top) <= 3 && Math.abs(dPixDom.bottom) <= 3 && Math.abs(dPixDom.left) <= 3 && Math.abs(dPixDom.right) <= 3 && Math.abs(dPixPtr.top) <= 3 && Math.abs(dPixPtr.left) <= 3 && sizeOk, "三路一致（|Δ|≤3pt）", JSON.stringify({ pixels: viewPixels, domReserved: vpScreen, pointerOrigin: viewPointer, deltaPixelsVsDom: dPixDom, deltaPixelsVsPointer: dPixPtr, sizeVsPage: { iw: pageGeoC.iw, ih: pageGeoC.ih, ok: sizeOk } }));
    // V4d：有提示条/错误条时，网页必须**让出**那一条 DOM 条带（否则提示被网页整个盖住）。
    const strip = geo.shell ? Math.round(geo.vp.top - geo.shell.top - 90) : 0;
    const grid = [];
    if (geo.banner && M) {
      for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.1, 0.5, 0.9]) {
        const pt = { x: Math.round(contentDom.x + geo.banner.left + geo.banner.width * fx), y: Math.round(contentDom.y + geo.banner.top + geo.banner.height * fy) };
        grid.push({ fy, fx, rgb: pixelOfPoint(frame0, pt) });
      }
    }
    const greenInBanner = grid.filter((g) => isPageGreen(g.rgb)).length;
    record("pixel", "V4d · 提示条/错误条存在时网页**让位**（条带高度 > 0，且条带内像素不是网页绿）", !!geo.banner ? strip > 0 && grid.length > 0 && greenInBanner === 0 : strip === 0, "条带让位且不被网页覆盖", JSON.stringify({ banner: geo.banner ? { kind: geo.banner.kind, h: Math.round(geo.banner.height), text: geo.banner.text } : null, stripH: strip, samples: grid.length, greenSamples: greenInBanner, sampleRgb: grid.map((g) => g.rgb) }));
    // **热身**：系统会把"刚被激活的 App 的第一下点击"用于把窗口变成 key window（不送进内容）。
    // 这是操作系统行为、不是产品缺陷，但会污染后面每一条点击断言：先点窗口标题栏
    // （只触发拖拽、不改状态）并确认外壳真的收到了 pointerdown，最多三下。
    const warmUp = async () => {
      await js("window.__shellPointer = 0; if (!window.__shellPointerInstalled) { window.__shellPointerInstalled = true; document.addEventListener('pointerdown', function () { window.__shellPointer += 1; }, true); } return 'ok'");
      const domWinId = await js("return document.querySelector('[data-browser-window]')?.getAttribute('data-browser-window') || ''");
      const title = await boxOf('[data-window-id="' + domWinId + '"] .window-title');
      if (!title || !M) return { ok: false, reason: "no-title-bar-or-geometry" };
      const pt = M.domToScreen({ x: title.cx, y: title.cy });
      const trace = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await safeClick(pt, "warmup-" + i);
        await sleep(350);
        const seen = Number(await js("return window.__shellPointer || 0")) || 0;
        trace.push({ i, click: r.ok ? { ok: true, attempt: r.attempt } : r, shellPointer: seen });
        if (r.ok && seen > 0) return { ok: true, tries: i + 1, seen, point: pt, trace };
      }
      return { ok: false, reason: "shell-never-received-pointer", point: pt, trace };
    };
    const warm = await warmUp();
    record("safety", "V3c · 真实指针确实到达本实例外壳（激活后的第一下点击可能被系统用于激活窗口，先热身）", warm.ok, "外壳收到真实 pointerdown（≤3 次热身点击）", JSON.stringify(warm));

    const focusedAddress = () => js("return document.activeElement === document.querySelector('[aria-label=\"网页地址\"]')");
    // 地址栏的真实点击：坐标由**统一换算**给出（DOM 点 → 屏幕点），不再有"试几个 dy"的标定路径。
    // 判定用独立通道：焦点是否真的进了输入框。
    const addrPt = M.domToScreen(geo.addr);
    let calib = { ok: false }, addrFocused = false;
    for (let i = 0; i < 3; i += 1) {
      calib = await safeClick(addrPt, "addressbar" + (i ? "-retry" + i : ""));
      await sleep(250);
      addrFocused = await focusedAddress();
      if (calib.ok && addrFocused) break;
    }
    record("safety", "V3b · 真实点击只落在本实例窗口内（每次点击前重新校验前台与内容区）", calib.ok, "点击被安全闸放行", JSON.stringify(calib));
    if (calib.ok) {
      record("pointer", "V6 · 统一换算给出的地址栏坐标 + 真实指针 → 焦点真的进入输入框", addrFocused, "activeElement=地址栏", JSON.stringify({ point: addrPt, fromDom: { x: geo.addr.x, y: geo.addr.y }, click: calib }));
      capture(win.id, "03-addressbar-focus.png");
      const toScreen = M.domToScreen;

      /* V5 标签栏：真实指针点击「新建标签」→ 真的多出一个标签；再点第二个标签 → 活动标签切换 */
      const tabNewPt = toScreen(geo.tabNew);
      const tabNewEl = await elementAt(geo.tabNew);
      const tabNewPixel = pixelOfPoint(frame0, tabNewPt);
      const tabs0 = await js("return document.querySelectorAll('[data-tab]').length");
      const addR = await clickUntil(tabNewPt, "new-tab", async () => (await shellClicks()).some((c) => c.trusted && /新建标签/.test(c.button)));
      const tabClicks = await shellClicks();
      const added = addR.ok && await waitFor(async () => (await js("return document.querySelectorAll('[data-tab]').length")) === tabs0 + 1, 6000);
      record("pointer", "V5 · 真实指针点击标签栏「新建标签」→ 真的多出一个标签（外壳收到该按钮的 isTrusted 点击）", added, "标签数 +1 且外壳收到该按钮点击", JSON.stringify({ before: tabs0, after: await js("return document.querySelectorAll('[data-tab]').length"), elementAtPoint: tabNewEl, screen: tabNewPt, pointPixel: tabNewPixel, click: addR, shellClicks: tabClicks }));
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

      /* V7 网页可见 + 可交互：真实指针点页面里的按钮本体（页面自己记录落点，作为独立通道） */
      const pageGeo = JSON.parse((await viewEval(viewByUrl("/paint"), "return JSON.stringify({scrollY: window.scrollY, innerH: window.innerHeight, docH: document.documentElement.scrollHeight, innerW: window.innerWidth})")) || "{}");
      // 首次点进原生视图可能被用于把焦点交给网页（系统行为）：允许至多重试 2 次，并如实记录第几次生效。
      const pageClick = async (pageX, pageY, tag) => {
        let r = { ok: false }, last = null, count = "";
        for (let i = 0; i < 3; i += 1) {
          r = await safeClick(M.pageToScreen({ x: pageX, y: pageY }), tag + (i ? "-retry" + i : ""));
          await sleep(400);
          const vv = viewByUrl("/paint");
          last = vv ? JSON.parse((await viewEval(vv, "return JSON.stringify(window.__lastClick || null)")) || "null") : null;
          count = vv ? await viewEval(vv, "return document.getElementById('paint-count')?.textContent || ''") : "";
          if (last) return { r, last, count, attempt: i + 1 };
        }
        return { r, last, count, attempt: 3 };
      };
      // 目标 = /paint 的 CLICK-ME 按钮本体（页面坐标 left 60 / top 140 / 260×90 → 中心 190,185）
      const btnTry = await pageClick(190, 185, "page-button");
      const frame2 = capture(win.id, "04-page-click.png");
      record("pointer", "V7 · 真实指针点击**网页内部**按钮 → 页面自己收到点击并计数", btnTry.r.ok && !!btnTry.last && /^COUNT-[1-9]/.test(String(btnTry.count)), "页面收到真实点击并计数", JSON.stringify({ button: { last: btnTry.last, count: btnTry.count, click: btnTry.r }, pageGeo, frame: path.basename(frame2) }));
      record("pointer", "V7b · 落点就是按钮本体（页面收到的坐标 = 目标，误差 ≤ 6px，target=paint-btn）", !!btnTry.last && Math.abs(btnTry.last.x - 190) <= 6 && Math.abs(btnTry.last.y - 185) <= 6 && btnTry.last.target === "paint-btn", "命中按钮", JSON.stringify({ got: btnTry.last, wantPagePoint: { x: 190, y: 185 } }));

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
            // 缩放后**重新测量**（布局变了，一律不用旧值）：像素 → 视图矩形 → 唯一换算器
            const shell9 = JSON.parse(await js("const e=document.querySelector('[data-browser-window]'); if(!e) return 'null'; const b=e.getBoundingClientRect(); return JSON.stringify({left:b.left,top:b.top,width:b.width,height:b.height});"));
            const frame5 = capture(win.id, "07-after-resize.png");
            const s5 = imageSize(frame5);
            const scale5 = s5[0] / after2.w;
            const scan5 = scanGreen(frame5, Math.round(s5[0] / 2), Math.round(s5[1] / 2));
            const view5 = viewRectFromPixels(after2, scale5, scan5);
            const M5 = view5 ? makeMapper({ win: after2, scale: scale5, viewRect: view5, origin: { x: after2.x, y: after2.y + titlebar } }) : null;
            const r3 = M5 ? await safeClick(M5.pageToScreen({ x: 190, y: 185 }), "page-button-after-resize") : { ok: false, reason: "no-view-rect" };
            await sleep(400);
            const vv3 = viewByUrl("/paint");
            const last3 = vv3 ? JSON.parse((await viewEval(vv3, "return JSON.stringify(window.__lastClick || null)")) || "null") : null;
            const counted2 = !!r3.ok && !!last3 && Math.abs(last3.x - 190) <= 8 && Math.abs(last3.y - 185) <= 8;
            record("pointer", "V9 · 窗口缩放后重新测量坐标，真实指针点击仍然命中页面内部（落点误差 ≤ 8px）", counted2, "落点命中", JSON.stringify({ last: last3, click: r3, viewRect: view5 && { left: Math.round(view5.left), top: Math.round(view5.top), w: Math.round(view5.width), h: Math.round(view5.height) }, from: before2 ? { w: Math.round(before2.w), h: Math.round(before2.h) } : null, to: { w: Math.round(after2.w), h: Math.round(after2.h) } }));
            record("pixel", "V9b · 缩放后截图尺寸随之变化（画面确实是缩放后的窗口）", Math.abs(s5[0] / after2.w - scale) < 0.01, "比例一致", JSON.stringify({ image: s5, win: { w: Math.round(after2.w), h: Math.round(after2.h) }, frame: path.basename(frame5) }));
          }
        }
      } catch (e) {
        note("窗口缩放（System Events）失败：" + String(e && e.message).slice(0, 120));
      }
      if (!resized) notVerified("窗口缩放后的布局/点击一致性", "本机 System Events 未能改变窗口尺寸（或尺寸未变化）；需要的条件：允许通过辅助功能接口调整该窗口大小。");

      /* V11 网页四边与近边界：坐标一律由**当下实测**的视图矩形换算，不再经过 DOM 占位符 */
      const em = await measureView("09-edges-frame.png");
      const pw = em.rect ? Math.round(em.rect.width) : 0;
      const ph = em.rect ? Math.round(em.rect.height) : 0;
      // 原生视图有 16pt 圆角（native-view-controller 的 VIEW_RADIUS），圆角切掉的角落里
      // 点击不落进网页。因此"近边界"分两组：四条边的中点（3pt 内）＋ 四个角内缩 24pt。
      const corner = 24;
      const edgeProbes = [
        { name: "上边中点", x: Math.round(pw / 2), y: 3 },
        { name: "下边中点", x: Math.round(pw / 2), y: Math.max(1, ph - 4) },
        { name: "左边中点", x: 3, y: Math.round(ph / 2) },
        { name: "右边中点", x: Math.max(1, pw - 4), y: Math.round(ph / 2) },
        { name: "左上角内", x: corner, y: corner },
        { name: "右上角内", x: Math.max(1, pw - corner), y: corner },
        { name: "左下角内", x: corner, y: Math.max(1, ph - corner) },
        { name: "右下角内", x: Math.max(1, pw - corner), y: Math.max(1, ph - corner) },
      ];
      const edgeResults = [];
      for (const e of edgeProbes) {
        const pt = em.mapper ? em.mapper.pageToScreen({ x: e.x, y: e.y }) : null;
        // 独立通道：落点像素必须是网页绿 —— 证明"我们算出的屏幕点确实落在网页上"，
        // 而不是"点到了别处但页面恰好收到了坐标"。
        const px = pt ? em.mapper.pixelOfScreen(em.file, pt) : null;
        const r = pt ? await safeClick(pt, "edge-" + e.name) : { ok: false, reason: "no-geometry" };
        await sleep(300);
        const vv = viewByUrl("/paint");
        const last = vv ? JSON.parse((await viewEval(vv, "return JSON.stringify(window.__lastClick || null)")) || "null") : null;
        edgeResults.push({ name: e.name, page: { x: e.x, y: e.y }, screen: pt, pixel: px, pixelGreen: isPageGreen(px), click: r, last });
      }
      const edgeOk = edgeResults.every((e) => e.pixelGreen && e.last && Math.abs(e.last.x - e.page.x) <= 6 && Math.abs(e.last.y - e.page.y) <= 6);
      record("pointer", "V11 · 网页**四边近边界**的真实指针命中（坐标由实测视图矩形换算；落点像素独立证明在网页内）", edgeOk, "四边都命中", JSON.stringify({ viewRect: em.rect && { left: Math.round(em.rect.left), top: Math.round(em.rect.top), w: pw, h: ph }, probes: edgeResults }));
      capture(win.id, "09-edges.png");

      /* V12 最大化 / 恢复：先定位**真实按钮矩形**并核对前台窗口，再发真实指针；
             判定用**窗口实际状态 + 网页布局变化**（不是"我们发了点击"）。 */
      let maxiOk = false, restoreOk = false, maxiDetail = null;
      try {
        const domWinId = await js("return document.querySelector('[data-browser-window]')?.getAttribute('data-browser-window') || ''");
        const winRect = () => boxOf('[data-window-id="' + domWinId + '"]');
        const pageSize = async () => { const vv = viewByUrl("/paint"); return vv ? JSON.parse((await viewEval(vv, "return JSON.stringify({iw:window.innerWidth,ih:window.innerHeight})")) || "{}") : {}; };
        const pageClickAt = async (p, tag) => {
          const r = await safeClick(p, tag); await sleep(350);
          const vv = viewByUrl("/paint");
          const last = vv ? JSON.parse((await viewEval(vv, "return JSON.stringify(window.__lastClick || null)")) || "null") : null;
          return { r, last };
        };
        const beforeRect = await winRect();
        const beforeSize = await pageSize();
        const maxBtn = await boxOf('[aria-label="最大化' + domWinId + '"]');
        if (!maxBtn) {
          note("最大化按钮不存在（windowId=" + domWinId + "）");
          notVerified("最大化 / 恢复后的布局与点击一致性", "当前窗口没有可点的最大化按钮（windowId=" + domWinId + "）。");
        } else {
          const m0 = await measureView("10-maximize-before.png");
          const pt = m0.mapper ? m0.mapper.domToScreen({ x: maxBtn.cx, y: maxBtn.cy }) : null;
          const elAt = await elementAt({ x: maxBtn.cx, y: maxBtn.cy });
          const px = pt ? m0.mapper.pixelOfScreen(m0.file, pt) : null;
          const frontOk = (await ensureFrontmost(pid, win.id)).ok;
          const r = frontOk && pt ? await clickUntil(pt, "maximize", async () => (await shellClicks()).some((c) => c.trusted && c.button === "最大化" + domWinId)) : { ok: false, reason: "not-frontmost-or-no-geometry" };
          const clicks = await shellClicks();
          const stateChanged = r.ok && await waitFor(async () => !!(await boxOf('[aria-label="还原' + domWinId + '"]')), 6000);
          await sleep(900);
          const afterRect = await winRect();
          const afterSize = await pageSize();
          const m1 = await measureView("10-maximized.png");
          const layoutChanged = !!(beforeRect && afterRect) && (Math.abs(afterRect.width - beforeRect.width) > 40 || Math.abs(afterRect.height - beforeRect.height) > 40);
          const pageChanged = !!afterSize.iw && (afterSize.iw !== beforeSize.iw || afterSize.ih !== beforeSize.ih);
          const viewFollows = !!(m1.rect && afterSize.iw) && Math.abs(m1.rect.width - afterSize.iw) <= 3 && Math.abs(m1.rect.height - afterSize.ih) <= 3;
          const hitPt = m1.mapper && afterSize.iw ? m1.mapper.pageToScreen({ x: Math.round(afterSize.iw / 2), y: Math.round(afterSize.ih / 2) }) : null;
          const hitMax = hitPt ? await pageClickAt(hitPt, "page-center-max") : { r: { ok: false }, last: null };
          const hitOk = !!hitMax.r.ok && !!hitMax.last && Math.abs(hitMax.last.x - Math.round(afterSize.iw / 2)) <= 6 && Math.abs(hitMax.last.y - Math.round(afterSize.ih / 2)) <= 6;
          const shellGot = clicks.some((c) => c.trusted && c.button === "最大化" + domWinId);
          maxiOk = !!r.ok && shellGot && stateChanged && layoutChanged && pageChanged && viewFollows && hitOk;
          maxiDetail = {
            frontOk, button: { label: "最大化" + domWinId, rect: { left: Math.round(maxBtn.left), top: Math.round(maxBtn.top), w: Math.round(maxBtn.width), h: Math.round(maxBtn.height) }, elementAtPoint: elAt, screen: pt, pointPixel: px },
            shellGot, shellClicks: clicks, click: r, stateChanged,
            windowRect: { before: beforeRect, after: afterRect }, pageSize: { before: beforeSize, after: afterSize },
            layoutChanged, pageChanged, viewFollows, viewRectAfter: m1.rect && { left: Math.round(m1.rect.left), top: Math.round(m1.rect.top), w: Math.round(m1.rect.width), h: Math.round(m1.rect.height) },
            hit: hitMax.last, hitOk, frame: path.basename(m1.file),
          };
          record("pointer", "V12 · 真实指针点窗口「最大化」按钮 → 窗口状态 + 网页布局真的变化，且最大化后网页仍能被真实指针命中", maxiOk, "状态/布局/命中都成立", JSON.stringify(maxiDetail));
          const restBtn = await boxOf('[aria-label="还原' + domWinId + '"]');
          if (restBtn) {
            const m2 = await measureView("11-restore-before.png");
            const pt2 = m2.mapper ? m2.mapper.domToScreen({ x: restBtn.cx, y: restBtn.cy }) : null;
            const r2 = pt2 ? await clickUntil(pt2, "restore", async () => (await shellClicks()).some((c) => c.trusted && c.button === "还原" + domWinId)) : { ok: false, reason: "no-geometry" };
            const restState = r2.ok && await waitFor(async () => !!(await boxOf('[aria-label="最大化' + domWinId + '"]')), 6000);
            await sleep(900);
            const backRect = await winRect();
            const backSize = await pageSize();
            const m3 = await measureView("11-restored.png");
            const backLayout = !!(backRect && beforeRect) && Math.abs(backRect.width - beforeRect.width) <= 4 && Math.abs(backRect.height - beforeRect.height) <= 4;
            const backPage = backSize.iw === beforeSize.iw && backSize.ih === beforeSize.ih;
            const backView = !!(m3.rect && backSize.iw) && Math.abs(m3.rect.width - backSize.iw) <= 3 && Math.abs(m3.rect.height - backSize.ih) <= 3;
            restoreOk = restState && backLayout && backPage && backView;
            record("pixel", "V12b · 恢复后窗口矩形与网页布局回到最大化之前，且像素真值跟着回到原位", restoreOk, "尺寸/布局恢复", JSON.stringify({ restState, click: r2, windowRect: { before: beforeRect, restored: backRect, max: maxiDetail.windowRect.after }, pageSize: { before: beforeSize, restored: backSize }, backLayout, backPage, backView, viewRectRestored: m3.rect && { left: Math.round(m3.rect.left), top: Math.round(m3.rect.top), w: Math.round(m3.rect.width), h: Math.round(m3.rect.height) }, frame: path.basename(m3.file) }));
          }
        }
      } catch (e) { note("最大化/恢复路径异常：" + String(e && e.message).slice(0, 120)); }

      /* V13 已支持的页面缩放：用真实按键试 Cmd +/-，如实记录产品是否支持 */
      const zoomBefore = JSON.parse(await js("return 'null'") || "null");
      void zoomBefore;
      const pageZoom = async () => { const vv = viewByUrl("/paint"); return vv ? JSON.parse((await viewEval(vv, "return JSON.stringify({iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio})")) || "{}") : null; };
      const z0 = await pageZoom();
      const focusPt = z0 && M ? M.pageToScreen({ x: Math.round(Number(z0.iw) / 2), y: Math.round(Number(z0.ih) / 2) }) : null;
      await (focusPt ? safeClick(focusPt, "focus-page") : Promise.resolve({ ok: false }));
      const keyZoom = (key) => { try { cliclick("kd:cmd"); cliclick("kp:" + key); cliclick("ku:cmd"); return true; } catch { return false; } };
      const zoomKeyOk = keyZoom("num-plus") && keyZoom("num-plus");
      await sleep(700);
      const z1 = await pageZoom();
      if (zoomKeyOk) { keyZoom("num-minus"); keyZoom("num-minus"); }
      await sleep(500);
      const z2 = await pageZoom();
      // V13 **不作为必需项**：D5-01 原始必需项里没有页面缩放（PLAN 的「缩放」指窗口缩放，已由 V9 覆盖），
      // 本轮也不新增任何缩放入口。这里只如实记录真实按键的实测结果（上一轮写的"按键未改变页面"不成立）。
      const zm = await measureView("12-zoom.png");
      const zoomed = !!z0 && !!z1 && (z0.dpr !== z1.dpr || z0.iw !== z1.iw);
      const ptPerCss = (v) => (v && v.iw ? Number(v.iw) * Number(v.dpr) : null);
      notVerified("页面缩放（Cmd +/-）", "不适用：D5-01 原始必需项不含页面缩放（PLAN 里的『缩放』是窗口缩放，V9 已覆盖），产品无缩放入口、本轮不新增。" +
        "实测补充（仅观察、不计入必需项）：真实按键 " + JSON.stringify(z0) + " → " + JSON.stringify(z1) + " → " + JSON.stringify(z2) + "，" +
        (zoomed ? "**确实进入了缩放态**" : "未改变页面缩放") +
        "；缩放态下像素真值 " + JSON.stringify(zm.rect && { left: Math.round(zm.rect.left), top: Math.round(zm.rect.top), w: Math.round(zm.rect.width), h: Math.round(zm.rect.height) }) +
        " 与网页自报 innerWidth×dpr " + ptPerCss(z1) + "（未缩放时 " + ptPerCss(z0) + "）一致。");

      /* V10 连续帧（录屏等价物）：一段连续操作期间的多帧 */
      const burst = [];
      for (let i = 0; i < 4; i += 1) { burst.push(path.basename(capture(win.id, "08-burst-" + i + ".png"))); await sleep(350); }
      const sizes = burst.map((f) => fs.statSync(path.join(FRAMES, f)).size);
      record("pixel", "V10 · 连续截图可用（一段连续操作的多帧都真实落盘）", sizes.every((s) => s > 5000), "4 帧", JSON.stringify({ frames: burst, bytes: sizes }));
    } else {
      notVerified("真实指针输入（标签栏/地址栏/网页交互/窗口缩放）", "统一换算所需的第一个真实点击就被安全闸拦下（" + JSON.stringify(calib) + "）；为绝不影响其它实例，未继续发真实点击。");
    }
  }

  const tail = stderrBuf.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !/ExperimentalWarning|SQLite is an experimental/i.test(l)).slice(0, 5);
  record("hygiene", "H1 · 主进程无未处理错误", tail.length === 0, "无错误行", tail.join(" | ") || "clean");

  const out = {
    phase: "D5-01 Closure-4",
    title: "本任务窗口的真实可见性（屏幕像素 + 真实指针输入；唯一坐标换算）",
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
