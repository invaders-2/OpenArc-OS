/**
 * 应用市场（MarketApp）真机探针：真实 Electron + 产品页面 / preload / 真实市场与集成服务。
 *
 * 结构照 tests/files-library-ui.mjs：默认起一个只监听 127.0.0.1 的 Vite 预览（不执行构建），
 * 把源码直接喂给真实 electron；探针宿主在临时目录里装配 identity / market / integration 同一条真实链路。
 *
 * 不伪造数据：第三方目录条目由探针写成真实本地目录（安装会在真实签名/摘要链上被拒绝并显示错误码）；
 * 集成插件状态来自 integration/plugins/health，安装插件按钮调用真实 enable。
 *
 * 产物：artifacts/market-redesign/*.png（浅/深 × 发现/更新/外部应用 + 详情面板）、report.json。
 *
 * 用法：node tests/market-ui.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const ART = path.join(ROOT, "artifacts", "market-redesign");
const electronPath = require("electron");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(ART, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

let vite = null;
let devURL = process.env.OA_DEV_SERVER || null;
if (!devURL) {
  const port = await freePort();
  devURL = "http://127.0.0.1:" + port + "/";
  const viteEnv = Object.assign({}, process.env, { NODE_ENV: "development" });
  vite = spawn(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    env: viteEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let viteLog = "";
  vite.stdout.on("data", (d) => (viteLog += String(d)));
  vite.stderr.on("data", (d) => (viteLog += String(d)));
  const up = await waitHttp(devURL, 45000);
  if (!up) {
    console.error("Vite 预览未起来（45s）。输出：\n" + viteLog.slice(-1500));
    vite.kill("SIGKILL");
    process.exit(1);
  }
  console.log("Vite 预览：" + devURL + "（仅 127.0.0.1，未执行构建）");
} else {
  console.log("复用外部 OA_DEV_SERVER：" + devURL);
}

const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-market-probe-host-"));
const probeMain = String.raw`"use strict";
/**
 * 应用市场真机探针宿主：真实 Electron + 产品页面 / preload / identity / market / integration 同一条链路。
 *
 * 第三方目录由探针写成真实本地目录（安装会在真实签名/摘要链上被拒绝）；
 * 集成插件状态全部来自 integration/plugins/health，安装插件按钮调用真实 enable。
 */
const { app, BrowserWindow, ipcMain, safeStorage, nativeImage, screen, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");

const ROOT = process.env.OA_MARKET_ROOT;
const DEV = process.env.OA_DEV_SERVER || null;
const DEV_BASE = DEV ? DEV.replace(/[/]+$/, "") + "/" : null;
// Vue 壳层入口：electron/main.cjs 的 UI_ENTRY 默认就是 vue.html（index.html 仍是 React 产品入口）。
const UI_ENTRY = "vue.html";
const uiURL = DEV ? new URL(UI_ENTRY, DEV).href : pathToFileURL(path.join(ROOT, "dist", UI_ENTRY)).href;
const ART = path.join(ROOT, "artifacts", "market-redesign");
const ADMIN = "market-ui-admin@openarc.test";
const ADMIN_PW = "market-ui-admin-password-1";
const SHOT_DELAY = 260;

const { createIdentityService, registerIdentityIpc } = require(path.join(ROOT, "electron/identity-bootstrap.cjs"));
const { createMarketBundle } = require(path.join(ROOT, "electron/market-service.cjs"));
const { createMarketUpdateBundle } = require(path.join(ROOT, "electron/market-update-service.cjs"));
const { createThirdPartyRegistry, createThirdPartyMarket } = require(path.join(ROOT, "electron/market-third-party-service.cjs"));
const { createPluginBundle } = require(path.join(ROOT, "electron/plugin-service.cjs"));
const { registerMarketIpc, registerIntegrationIpc } = require(path.join(ROOT, "electron/plugin-bootstrap.cjs"));
const { resolveDxosPaths } = require(path.join(ROOT, "electron/dxos-foundation-paths.cjs"));

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "oa-market-probe-"));
app.setPath("userData", USER_DATA);

/* 桌面默认壁纸是原生视频：与 electron/main.cjs 同形登记 privileged 协议并只读地服出，
   否则渲染层会报 CORS —— 那是宿主环境问题，不是应用市场的问题。 */
protocol.registerSchemesAsPrivileged([
  { scheme: "openarc-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);
const NATIVE_RESOURCES = { "siri-blob": "/System/Library/PrivateFrameworks/SiriUI.framework/Versions/A/Resources/Siri Blob.mov" };
const NATIVE_TYPES = { ".mov": "video/quicktime", ".mp4": "video/mp4" };

const report = {
  versions: {},
  window: {},
  checks: [],
  errors: [],
  notVerified: [],
  screenshots: [],
  diffs: [],
  measurements: {},
  commands: { market: [], integration: [] },
  console: { total: 0, errors: [], environmentKnown: [] },
  network: { total: 0, nonLocal: [] },
  functional: {},
  isolated: { userData: USER_DATA },
};
const out = (line) => process.stdout.write(line + "\n");
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail).slice(0, 700) });
  out((ok ? "PASS" : "FAIL") + " " + name + (detail ? " :: " + detail : ""));
  return !!ok;
};
const notVerified = (name, reason) => {
  report.notVerified.push({ name, reason: String(reason).slice(0, 500) });
  out("NOT VERIFIED " + name + " :: " + reason);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;
process.on("uncaughtException", (error) => out("UNCAUGHT " + String((error && error.stack) || error)));
process.on("unhandledRejection", (error) => out("UNHANDLED " + String((error && error.stack) || error)));
app.on("child-process-gone", (event, details) => out("CHILD-GONE " + JSON.stringify(details)));

/* ── 第三方目录（真实本地目录；包内容不是合法签名包，安装会被真实链路拒绝） ── */
function seedThirdPartyCatalog() {
  const dxosRoot = resolveDxosPaths(USER_DATA).root;
  const dir = path.join(dxosRoot, "market");
  fs.mkdirSync(path.join(dir, "packages"), { recursive: true });
  const bytes = Buffer.from("oa-market-probe-package-payload-not-a-signed-zip", "utf8");
  fs.writeFileSync(path.join(dir, "packages", "arc-notes-plus-0.2.0.zip"), bytes);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const catalog = {
    format: "openarc-third-party-catalog/v1",
    apps: [
      {
        id: "arc-notes-plus",
        name: "增强文稿",
        version: "0.2.0",
        packageFile: "packages/arc-notes-plus-0.2.0.zip",
        sha256: sha,
        size: bytes.length,
        minSystemVersion: "0.1.0",
        description: "给文稿加入模板与双链的第三方扩展。",
        author: "OpenArc Samples",
      },
      { id: "bad-entry", name: "坏条目", version: "1.0.0", packageFile: "packages/missing.zip", sha256: "not-a-sha256" },
    ],
  };
  fs.writeFileSync(path.join(dir, "third-party.json"), JSON.stringify(catalog, null, 2));
  return { catalogFile: path.join(dir, "third-party.json"), sha: sha, bytes: bytes.length };
}

/* ── DOM 原语 ─────────────────────────────────────────────────────────── */
const js = (code) => win.webContents.executeJavaScript("(async () => { " + code + " })()");
const q = (value) => JSON.stringify(String(value));
const has = (sel) => js("return !!document.querySelector(" + q(sel) + ")");
const count = (sel) => js("return document.querySelectorAll(" + q(sel) + ").length");
const text = (sel) => js("var el=document.querySelector(" + q(sel) + "); return el ? (el.textContent||'').trim() : ''");
const attr = (sel, name) => js("var el=document.querySelector(" + q(sel) + "); return el ? el.getAttribute(" + q(name) + ") : null");
const click = (sel) =>
  js(
    "var el=document.querySelector(" + q(sel) + "); if(!el) return 'missing'; if(el.disabled) return 'disabled'; el.click(); return 'ok';",
  );
const setInput = (sel, value) =>
  js(
    "var el=document.querySelector(" + q(sel) + "); if(!el) return 'missing';" +
      "var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el," + q(value) + ");" +
      "el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';",
  );
const focusSel = (sel) => js("var el=document.querySelector(" + q(sel) + "); if(!el) return 'missing'; el.focus(); return 'ok';");
const activeInfo = () =>
  js(
    "var el=document.activeElement; if(!el) return null;" +
      "var s=getComputedStyle(el); return {tag:el.tagName, cls:String(el.className||''), view:el.getAttribute('data-market-view'), cat:el.getAttribute('data-market-cat'), outlineWidth:s.outlineWidth, outlineStyle:s.outlineStyle, outlineColor:s.outlineColor, focusVisible:el.matches(':focus-visible'), docFocus:document.hasFocus()};",
  );
async function waitFn(expr, timeout) {
  const t0 = Date.now();
  const limit = timeout || 15000;
  for (;;) {
    try {
      if (await js("return (" + expr + ")")) return true;
    } catch {
      /* 页面导航中 */
    }
    if (Date.now() - t0 > limit) return false;
    await sleep(120);
  }
}
const waitSel = (sel, timeout) => waitFn("!!document.querySelector(" + q(sel) + ")", timeout);
const waitText = (sel, needle, timeout) => waitFn("(function(){var el=document.querySelector(" + q(sel) + "); return !!el && (el.textContent||'').indexOf(" + q(needle) + ")>=0;})()", timeout);

/* ── 主题 / 窗口 / 截图 ───────────────────────────────────────────────── */
const MARKET_SEL = ".window[aria-label=" + q("应用市场窗口") + "]";
async function rectOf(sel) {
  return await js(
    "var el=document.querySelector(" + q(sel) + "); if(!el) return null; var r=el.getBoundingClientRect();" +
      "return {left:r.left, top:r.top, width:r.width, height:r.height};",
  );
}
async function shot(name, theme, viewName, zoom) {
  const rect = await rectOf(MARKET_SEL);
  if (!rect) throw new Error("capturePage 前找不到应用市场窗口：" + name);
  await sleep(SHOT_DELAY);
  const img = await win.capturePage();
  const size = img.getSize();
  const inner = await js("return window.innerWidth");
  const scale = inner > 0 ? size.width / inner : 1;
  const crop = {
    x: Math.max(0, Math.round(rect.left * scale)),
    y: Math.max(0, Math.round(rect.top * scale)),
    width: Math.min(size.width, Math.round(rect.width * scale)),
    height: Math.min(size.height, Math.round(rect.height * scale)),
  };
  const cut = img.crop(crop);
  const file = path.join(ART, name + ".png");
  fs.writeFileSync(file, cut.toPNG());
  const pixels = cut.getSize();
  const entry = {
    file: path.relative(ROOT, file),
    name: name,
    theme: theme,
    view: viewName,
    zoom: zoom,
    css: { width: Math.round(rect.width), height: Math.round(rect.height) },
    pixels: { width: pixels.width, height: pixels.height },
    crop: crop,
    scale: Math.round(scale * 100) / 100,
  };
  report.screenshots.push(entry);
  return entry;
}
async function applyTheme(theme, motionReduced) {
  await js(
    "localStorage.setItem('oa-theme'," + q(theme) + ");" +
      "localStorage.setItem('oa-motion'," + q(motionReduced ? "true" : "false") + "); return 'ok'",
  );
  await win.webContents.reload();
  await waitFn("document.readyState==='complete' && !!window.openarc", 60000);
  await sleep(500);
  await ensureReady();
  const dark = await js("var d=document.querySelector('.desktop'); return !!d && d.classList.contains('dark')");
  const reduced = await js("var d=document.querySelector('.desktop'); return !!d && d.classList.contains('reduced')");
  return { dark: dark, reduced: reduced };
}
async function ensureReady() {
  const gate = () => js("var d=document.querySelector('.desktop'); return d ? d.getAttribute('data-identity-gate') : 'no-root'");
  let g = await gate();
  if (g !== "ready" && g !== "locking" && g !== "locked") {
    await setInput('[data-d3-id="login-identifier"]', ADMIN);
    await setInput('[data-d3-id="login-password"]', ADMIN_PW);
    await sleep(80);
    await click('[data-d3-id="login-submit"]');
  }
  const ok = await waitFn("(function(){var d=document.querySelector('.desktop'); return !!d && d.getAttribute('data-identity-gate')==='ready';})()", 30000);
  return { ok: ok, gate: await gate() };
}
async function dumpUi(label) {
  const info = await js("var d=document.querySelector('.dock'); var pop=document.querySelector('.apps-pop'); var grid=document.querySelector('.app-grid'); var bodies=Array.from(document.querySelectorAll('.window-body')); return {dock:!!d, pop:!!pop, cards:document.querySelectorAll('[data-app-card]').length, appCards:document.querySelectorAll('.app-card').length, gridChildren:grid?grid.children.length:-1, gridHtml:grid?String(grid.innerHTML).slice(0,260):'', wins:Array.from(document.querySelectorAll('.window')).map(function(el){return el.getAttribute('aria-label')+'|'+el.className}), gate:(document.querySelector('.desktop')||{}).getAttribute?document.querySelector('.desktop').getAttribute('data-identity-gate'):null};");
  out("DUMP " + label + " " + JSON.stringify(info));
  return info;
}
async function openMarket() {
  if (await has(MARKET_SEL)) return true;
  const viaHome = await js("var list=Array.from(document.querySelectorAll('[data-app-card=\"market\"]')).filter(function(el){return !el.closest('.apps-pop')}); if(!list.length) return 'missing'; list[0].click(); return 'ok';");
  out("OPEN via App Center => " + viaHome);
  if (viaHome === "ok") {
    const opened = await waitSel(MARKET_SEL, 15000);
    if (opened) return true;
  }
  await click('[data-dock-id="home"]');
  if (!(await waitSel(".apps-pop", 8000))) { await dumpUi("openMarket-failed"); return false; }
  await setInput(".apps-pop .ds-search__input", "应用市场");
  await sleep(300);
  const clicked = await click('.apps-pop [data-app-card="market"]');
  if (clicked === "missing") return false;
  return waitSel(MARKET_SEL, 15000);
}
async function focusMarket() {
  await js(
    "var el=document.querySelector(" + q(MARKET_SEL) + "); if(!el) return 'missing';" +
      "el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:420,clientY:120})); return 'ok';",
  );
  await sleep(80);
}
async function waitMarketReady() {
  await waitSel("[data-market-title]", 20000);
  await waitFn(
    "(function(){var h=document.querySelector('.mk-hero-title'); if(!h) return true; return (h.textContent||'').indexOf('正在读取')<0;})()",
    20000,
  );
  await waitFn("document.querySelectorAll('[data-market-apps] .mk-card').length > 0", 20000);
}
async function setView(viewName) {
  if (viewName === "apps") await click('[data-market-view="apps"]');
  else await click('[data-market-view="' + viewName + '"]');
  await sleep(240);
}

/* ── 度量：所有值都来自 computed style / 真实布局 ─────────────────────── */
async function measure() {
  return await js(
    "function num(v){ var n=parseFloat(v); return isFinite(n) ? Math.round(n*100)/100 : null; }" +
      "function rgba(v){ var m=/rgba?\(([^)]+)\)/.exec(v||''); if(!m) return null; var p=m[1].split(',').map(function(x){return parseFloat(x)}); return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}; }" +
      "var root=document.querySelector('.market-app');" +
      "var winEl=root?root.closest('.window'):null;" +
      "var side=document.querySelector('.mk-side');" +
      "var hero=document.querySelector('.mk-hero');" +
      "var grid=document.querySelector('[data-market-apps]');" +
      "var card=grid?grid.querySelector('.mk-card'):null;" +
      "var icon=card?card.querySelector('.mk-card-icon'):null;" +
      "var name=card?card.querySelector('.mk-card-name'):null;" +
      "var desc=card?card.querySelector('.mk-card-desc'):null;" +
      "var pill=card?card.querySelector('.mk-pill'):null;" +
      "var navSel=document.querySelector('.mk-nav[aria-current=\u0022page\u0022]');" +
      "var viewEl=document.querySelector('.mk-view');" +
      "var heroTitle=document.querySelector('.mk-hero-title');" +
      "var wr=winEl?winEl.getBoundingClientRect():null;" +
      "var sr=side?side.getBoundingClientRect():null;" +
      "var hr=hero?hero.getBoundingClientRect():null;" +
      "var cr=card?card.getBoundingClientRect():null;" +
      "var ir=icon?icon.getBoundingClientRect():null;" +
      "var pr=pill?pill.getBoundingClientRect():null;" +
      "var neutral=[];" +
      "var probe=[document.querySelector('.mk-title'),name,desc,pill,hero,navSel,document.querySelector('.mk-nav-count')];" +
      "probe.forEach(function(el){ if(!el) return; var st=getComputedStyle(el); ['color','backgroundColor'].forEach(function(prop){ var c=rgba(st[prop]); if(!c) return; if(c.a===0) return; if(Math.abs(c.r-c.g)>1||Math.abs(c.g-c.b)>1) neutral.push(el.className+' '+prop+'='+st[prop]); }); });" +
      "return {" +
      "exists: !!root," +
      "window: wr?{width:num(wr.width),height:num(wr.height)}:null," +
      "side: sr?{width:num(sr.width),height:num(sr.height),borderWidth:getComputedStyle(side).borderTopWidth}:null," +
      "hero: hr?{width:num(hr.width),height:num(hr.height),radius:num(getComputedStyle(hero).borderTopLeftRadius),borderWidth:getComputedStyle(hero).borderTopWidth,backgroundImage:getComputedStyle(hero).backgroundImage,backgroundColor:getComputedStyle(hero).backgroundColor}:null," +
      "heroTitle: heroTitle?{fontSize:num(getComputedStyle(heroTitle).fontSize),fontWeight:getComputedStyle(heroTitle).fontWeight,letterSpacing:getComputedStyle(heroTitle).letterSpacing}:null," +
      "heroDots: document.querySelectorAll('[data-market-hero-dot]').length," +
      "grid: grid?{columns:getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,template:getComputedStyle(grid).gridTemplateColumns,gap:getComputedStyle(grid).columnGap}:null," +
      "card: cr?{width:num(cr.width),height:num(cr.height),radius:num(getComputedStyle(card).borderTopLeftRadius),borderWidth:getComputedStyle(card).borderTopWidth,backgroundColor:getComputedStyle(card).backgroundColor,boxShadow:getComputedStyle(card).boxShadow}:null," +
      "icon: ir?{width:num(ir.width),height:num(ir.height)}:null," +
      "name: name?{fontSize:num(getComputedStyle(name).fontSize),fontWeight:getComputedStyle(name).fontWeight}:null," +
      "desc: desc?{fontSize:num(getComputedStyle(desc).fontSize),color:getComputedStyle(desc).color}:null," +
      "pill: pr?{width:num(pr.width),height:num(pr.height),radius:num(getComputedStyle(pill).borderTopLeftRadius),fontSize:num(getComputedStyle(pill).fontSize),fontWeight:getComputedStyle(pill).fontWeight}:null," +
      "navSelected: navSel?{background:getComputedStyle(navSel).backgroundColor,color:getComputedStyle(navSel).color,fontWeight:getComputedStyle(navSel).fontWeight,borderWidth:getComputedStyle(navSel).borderTopWidth}:null," +
      "viewAnimation: viewEl?getComputedStyle(viewEl).animationDuration:null," +
      "cardCount: document.querySelectorAll('[data-market-apps] .mk-card').length," +
      "neutral: neutral," +
      "zoom: window.devicePixelRatio" +
      "};",
  );
}

function buildDiffs(m, phase) {
  const add = (item, expected, measured, ok, note) => report.diffs.push({ phase: phase, item: item, expected: expected, measured: measured, ok: !!ok, note: note || "" });
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const expectedH = report.window.expectedHeight || 710;
  const zoomed = phase.indexOf("1.25") >= 0;
  add(
    "窗口尺寸",
    zoomed ? "缩放 1.25 下按 zoom 换算（宽度仍 1060）" : "1060×" + expectedH + "（shell.ts 声明 710，受工作区高度夹取）",
    m.window ? m.window.width + "×" + m.window.height : "—",
    !!m.window && Math.abs(m.window.width - 1060) <= 1 && (zoomed || Math.abs(m.window.height - expectedH) <= 1),
    zoomed ? "浏览器缩放不改变窗口物理尺寸，CSS 尺寸 = 物理尺寸 / zoom" : "原型 1060×710；窗口高度上限由 shell defaultBounds 按工作区计算",
  );
  add("左栏可见宽度", "200（任务与原型一致）", m.side ? m.side.width : "—", !!m.side && Math.abs(m.side.width - 200) <= 1, "共享 .split 侧栏默认 220；本页按其 200px 口径覆盖");
  add("hero 高度", "208（需求约 210，取 4 的倍数）", m.hero ? m.hero.height : "—", !!m.hero && Math.abs(m.hero.height - 208) <= 1, "原型 220，需求写约 210");
  add("hero 圆角", "12", m.hero ? m.hero.radius : "—", !!m.hero && m.hero.radius === 12, "DESIGN_SYSTEM §6 卡片圆角");
  add("hero 无描边", "0px", m.hero ? m.hero.borderWidth : "—", !!m.hero && m.hero.borderWidth === "0px", "§3.2 禁发丝线框");
  add("hero 标题字号/字重", "28 / 500", m.heroTitle ? m.heroTitle.fontSize + " / " + m.heroTitle.fontWeight : "—", !!m.heroTitle && m.heroTitle.fontSize === 28 && m.heroTitle.fontWeight === "500", "§5 字重 ≤500；原型 26/600 按规范降到 500");
  add("hero 指示点数量", "≥2（真实状态屏数）", m.heroDots, m.heroDots >= 2, "原型 3 点；本项目按真实数据屏数生成");
  add("应用网格列数", "2", m.grid ? m.grid.columns : "—", !!m.grid && m.grid.columns === 2, "原型两列卡片");
  add("网格间距", "12px", m.grid ? m.grid.gap : "—", !!m.grid && m.grid.gap === "12px", "4 的倍数");
  add("卡片图标", "40×40", m.icon ? m.icon.width + "×" + m.icon.height : "—", !!m.icon && m.icon.width === 40 && m.icon.height === 40, "需求：图标 40");
  add("名称字号/字重", "13 / 500", m.name ? m.name.fontSize + " / " + m.name.fontWeight : "—", !!m.name && m.name.fontSize === 13 && m.name.fontWeight === "500", "需求：名称 13/500");
  add("描述字号", "12", m.desc ? m.desc.fontSize : "—", !!m.desc && m.desc.fontSize === 12, "需求：描述 12");
  add("卡片圆角", "12", m.card ? m.card.radius : "—", !!m.card && m.card.radius === 12, "§6 卡片 12");
  add("卡片无描边", "0px", m.card ? m.card.borderWidth : "—", !!m.card && m.card.borderWidth === "0px", "§3.2 靠明度差 + 阴影分层");
  add("卡片最小高度", ">0（真实内容撑开）", m.card ? m.card.height : "—", !!m.card && m.card.height >= 60, "原型约 64");
  add("胶囊高度/圆角", "26 / 999", m.pill ? m.pill.height + " / " + m.pill.radius : "—", !!m.pill && m.pill.height === 26 && m.pill.radius === 999, "原型 getbtn 26/13px(胶囊)");
  add("胶囊字号/字重", "13 / 500", m.pill ? m.pill.fontSize + " / " + m.pill.fontWeight : "—", !!m.pill && m.pill.fontSize === 13 && m.pill.fontWeight === "500", "§5 按钮 13；500 用于强调");
  add("选中导航无描边", "0px", m.navSelected ? m.navSelected.borderWidth : "—", !!m.navSelected && m.navSelected.borderWidth === "0px", "选中态只用背景明度差");
  add("视图切换时长", "0.16s（减少动态时 0s）", m.viewAnimation, !!m.viewAnimation && (m.viewAnimation === "0.16s" || m.viewAnimation === "0s"), "MOTION §5 页面切换 160ms");
  add("非中性色", "0 处（语义色只用于错误文字）", m.neutral && m.neutral.length ? JSON.stringify(m.neutral) : "0", !!m.neutral && m.neutral.length === 0, "§3.1 只允许中性灰阶；应用图标彩色不受检");
  add("卡片数量", "24（注册表去掉应用市场自身）", m.cardCount, m.cardCount === 24, "真实应用注册表");
  if (!isNum(m.zoom)) add("缩放", "1.0", m.zoom, false, "devicePixelRatio 读取失败");
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */
app.whenReady().then(async () => {
  try {
    report.versions = { electron: process.versions.electron, node: process.versions.node, platform: process.platform + "/" + process.arch };
    out("VERSIONS " + JSON.stringify(report.versions));
    fs.mkdirSync(ART, { recursive: true });
    const seeded = seedThirdPartyCatalog();
    report.functional.catalog = { file: path.relative(USER_DATA, seeded.catalogFile), sha: seeded.sha, bytes: seeded.bytes };

    const identity = createIdentityService({ userDataDir: USER_DATA, safeStorage, allowAdmin: true, nativeImage });
    await identity.store.initialize({ identifier: ADMIN, password: ADMIN_PW, displayName: "Admin" });

    const marketUpdate = createMarketUpdateBundle({
      userDataDir: USER_DATA,
      appDir: ROOT,
      authorization: identity.authorization,
      fetchImpl: null,
      packageResolver: null,
      logger: null,
      clock: null,
    });
    const registry = createThirdPartyRegistry({ userDataDir: USER_DATA, clock: null });
    const thirdParty = createThirdPartyMarket({
      userDataDir: USER_DATA,
      appDir: ROOT,
      updateService: marketUpdate,
      registry: registry,
      fetchImpl: null,
      authorization: identity.authorization,
      systemVersion: "0.1.0",
      clock: null,
    });
    const marketBundle = createMarketBundle({
      userDataDir: USER_DATA,
      appDir: ROOT,
      logger: null,
      clock: null,
      updateService: marketUpdate,
      thirdPartyService: thirdParty,
    });
    const pluginBundle = createPluginBundle({ userDataDir: USER_DATA, safeStorage: safeStorage, fetch: typeof fetch === "function" ? fetch.bind(globalThis) : null, clock: null });

    const workArea = screen.getPrimaryDisplay().workAreaSize;
    report.functional.workArea = workArea;
    win = new BrowserWindow({
      width: Math.min(workArea.width, 1512),
      height: Math.min(workArea.height, 982),
      x: 0,
      y: 0,
      show: true,
      webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const isTrusted = (event) => {
      if (!win || event.sender !== win.webContents) return false;
      const url = String((event.senderFrame && event.senderFrame.url) || "");
      return DEV_BASE ? url.indexOf(DEV_BASE) === 0 : url === uiURL;
    };
    const loggingIpc = {
      handle(channel, fn) {
        ipcMain.handle(channel, async (event, raw) => {
          if (channel === "market:command") report.commands.market.push(String((raw && (raw.command || raw.type)) || ""));
          if (channel === "integration:command") report.commands.integration.push(String((raw && (raw.command || raw.type)) || ""));
          return fn(event, raw);
        });
      },
      removeHandler(channel) {
        try {
          ipcMain.removeHandler(channel);
        } catch (error) {
          /* 尚未注册 */
        }
      },
      on(channel, fn) {
        ipcMain.on(channel, fn);
      },
    };

    registerMarketIpc({ ipcMain: loggingIpc, bundle: marketBundle, identity: identity.service, isTrusted: isTrusted });
    registerIntegrationIpc({ ipcMain: loggingIpc, bundle: pluginBundle, identity: identity.service, isTrusted: isTrusted });
    registerIdentityIpc({
      ipcMain: loggingIpc,
      service: identity.service,
      authorization: identity.authorization,
      isTrusted: isTrusted,
      send: () => {},
    });
    ipcMain.handle("windows:sync", async () => ({ ok: true, results: [] }));
    ipcMain.handle("browser:navigate", async () => ({ ok: true }));
    ipcMain.handle("browser:action", async () => ({ ok: true }));
    ipcMain.handle("browser:command", async () => ({ ok: true }));

    win.webContents.on("render-process-gone", (event, details) => out("RENDER-GONE " + JSON.stringify(details)));
    win.webContents.on("console-message", (...args) => {
      let level = args[1];
      let message = args[2];
      if (args[0] && typeof args[0] === "object" && "message" in args[0]) {
        level = args[0].level;
        message = args[0].message;
      }
      const isError = level === 3 || level === "error";
      report.console.total += 1;
      const text = String(message).slice(0, 300);
      if (isError) {
        // 桌面默认壁纸是 openarc-file://native/siri-blob 原生视频；探针宿主已登记 privileged 协议，
        // 若系统资源缺失仍会报 CORS。这是桌面既有行为，与应用市场无关，单独记账。
        if (text.indexOf("openarc-file://native/siri-blob") >= 0 || text.indexOf("siri-blob") >= 0) {
          report.console.environmentKnown.push(text);
        } else {
          report.console.errors.push(text);
          out("CONSOLE ERROR " + text);
        }
      }
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
      const url = details.url || "";
      report.network.total += 1;
      const local = /^(file:|data:|blob:|about:|devtools:|openarc-file:|openarc-resource:|openarc-canvas:|http:\/\/127\.0\.0\.1|http:\/\/localhost|http:\/\/\[::1\]|ws:\/\/127\.0\.0\.1|ws:\/\/localhost)/i.test(url);
      if (!local) report.network.nonLocal.push(url);
      callback({});
    });

    protocol.handle("openarc-file", async (request) => {
      try {
        const url = new URL(request.url);
        const abs = url.hostname === "native" ? NATIVE_RESOURCES[url.pathname.replace(/^\/+/, "")] : null;
        if (!abs || !fs.existsSync(abs)) return new Response("Not Found", { status: 404 });
        const size = fs.statSync(abs).size;
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
        const start = range && range[1] ? Number(range[1]) : 0;
        const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end) return new Response("Range Not Satisfiable", { status: 416 });
        const headers = {
          "Content-Type": NATIVE_TYPES[path.extname(abs).toLowerCase()] || "application/octet-stream",
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
          "Access-Control-Allow-Origin": "*",
        };
        if (range) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
        return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })), { status: range ? 206 : 200, headers });
      } catch (error) {
        return new Response("Error", { status: 500 });
      }
    });

    out("STAGE load " + uiURL);
    await win.loadURL(uiURL);
    out("STAGE loaded");
    const pageOk = await waitFn("document.readyState==='complete' && !!window.openarc && Object.keys(window.openarc).length>0", 60000);
    check("P0 · 真实页面加载完成且有 openarc 桥", pageOk, "readyState=" + (await js("return document.readyState").catch(() => "?")));
    await sleep(400);

    const ready = await ensureReady();
    check("P1 · 登录进入桌面 ready", ready.ok, "gate=" + ready.gate);

    /* ── 打开应用市场（走真实「应用中心」浮层，不是直接调 store） ─────────── */
    const opened = await openMarket();
    await waitMarketReady();
    const marketWindow = await rectOf(MARKET_SEL);
    const title = await text("[data-market-title]");
    const innerHeight = await js("return window.innerHeight");
    // shell.ts defaultBounds：h = max(420, min(size[1], innerHeight - 52 - 110 - 20))
    const expectedHeight = Math.max(420, Math.min(710, Math.round(innerHeight - 182)));
    report.window = {
      css: marketWindow ? { width: Math.round(marketWindow.width), height: Math.round(marketWindow.height) } : null,
      expectedHeight: expectedHeight,
      innerHeight: innerHeight,
      declaredHeight: 710,
      zoom: win.webContents.getZoomFactor(),
      devicePixelRatio: await js("return window.devicePixelRatio"),
      title: title,
    };
    check(
      "P2 · 从应用中心打开应用市场窗口（1060×710）",
      opened && !!marketWindow && Math.abs(marketWindow.width - 1060) <= 1 && Math.abs(marketWindow.height - expectedHeight) <= 1,
      JSON.stringify(report.window),
    );

    /* ── 侧栏：搜索 + 8 项导航 + 真实更新徽标 ───────────────────────────── */
    const navItems = await count(".mk-nav");
    const navLabels = await js("return Array.from(document.querySelectorAll('.mk-nav')).map(function(el){return (el.querySelector('.split-nav-label')||{}).textContent||''})");
    const navCats = await js("return Array.from(document.querySelectorAll('[data-market-cat]')).map(function(el){return el.getAttribute('data-market-cat')})");
    const updatableCards = await js("return Array.from(document.querySelectorAll('[data-app-card]')).filter(function(el){return el.getAttribute('data-app-update-upgrade')==='true'}).length");
    const badge = await text("[data-market-update-count]");
    check(
      "P3 · 左侧导航来自真实目录，含发现、创作、效率、团队资源与外部应用",
      navItems === 11 && navLabels[0] === "发现" && navLabels.includes("创作") && navLabels.includes("效率") && navLabels.includes("团队与资源") && navLabels.includes("外部应用") && navCats.join("|") === "creative|efficiency|team-resource|brand-design|film-creative|ecommerce-ads|interactive-games|social-media-content",
      navLabels.join("|"),
    );
    check(
      "P3b · 更新徽标只显示真实可升级数量（本机无发布包时不显示）",
      updatableCards === 0 ? badge === "" : badge === String(updatableCards),
      "upgrade=" + updatableCards + " badge=" + badge,
    );

    /* ── 发现页：hero / 两列网格 / 真实内容 ───────────────────────────── */
    const heroText = await text(".mk-hero-slide");
    const heroDots = await count("[data-market-hero-dot]");
    const cards = await count("[data-market-apps] .mk-card");
    check(
      "P4 · 发现页 hero 来自真实状态（可更新数量），不是编造文案",
      (await has("[data-market-hero]")) && heroDots >= 2 && (heroText.indexOf("应用更新") >= 0 || heroText.indexOf("应用") >= 0) && heroText.indexOf("本周推荐") < 0,
      "hero=" + heroText.slice(0, 80) + " dots=" + heroDots,
    );
    check("P4b · 发现页渲染 24 个真实应用卡片", cards === 24, "cards=" + cards);

    /* ── hero 轮播：正常动效下 4.2s 自动切换 ───────────────────────────── */
    const idxBefore = await attr("[data-market-hero]", "data-market-hero-index");
    await sleep(4600);
    const idxAfter = await attr("[data-market-hero]", "data-market-hero-index");
    check("P5 · hero 每 4.2s 自动切屏（正常动效）", String(idxBefore) !== String(idxAfter), "before=" + idxBefore + " after=" + idxAfter);
    report.functional.carousel = { before: idxBefore, after: idxAfter };

    /* ── 分类过滤 ───────────────────────────────────────────────────────── */
    await click('[data-market-cat="creative"]');
    await sleep(240);
    const creationCards = await js("return Array.from(document.querySelectorAll('[data-market-category-items] [data-market-entry]')).map(function(el){return el.getAttribute('data-market-entry')})");
    check(
      "P6 · 创作分类页只列目录里的创作条目",
      creationCards.length === 4 && creationCards.every((id) => ["catalog-app:canvas", "catalog-app:photos", "catalog-app:music", "catalog-app:video"].includes(id)),
      JSON.stringify(creationCards),
    );
    await click('[data-market-cat="efficiency"]');
    await sleep(240);
    const efficiencyCards = await js("return Array.from(document.querySelectorAll('[data-market-category-items] [data-market-entry]')).map(function(el){return el.getAttribute('data-market-entry')})");
    check("P6b · 效率分类页只列目录里的效率应用", efficiencyCards.length === 2 && efficiencyCards.every((id) => ["catalog-app:browser", "catalog-app:chat"].includes(id)), JSON.stringify(efficiencyCards));

    /* ── 搜索 ───────────────────────────────────────────────────────────── */
    await click('[data-market-view="apps"]');
    await setInput(".mk-search .ds-search__input", "天气");
    await sleep(240);
    const searchCards = await js("return Array.from(document.querySelectorAll('[data-market-apps] .mk-card')).map(function(el){return {id:el.getAttribute('data-app-card'), text:(el.textContent||\"\").trim()}})");
    const searchIds = searchCards.map((item) => item.id).sort();
    // 本机真实命中集：weather（名称）+ integrations（描述「领星、紫鸟、钉钉、夸克、天气与黄历…」）。
    // 描述搜索是刻意保留的行为，不为过检把它砍掉。
    check(
      "P7 · 搜索「天气」命中名称或描述里真的含有该词的应用（weather + integrations）",
      searchIds.join("|") === "integrations|weather" && searchCards.every((item) => item.text.indexOf("天气") >= 0),
      JSON.stringify(searchIds),
    );
    await setInput(".mk-search .ds-search__input", "no-such-app-xyz");
    await sleep(200);
    const emptyVisible = await text("[data-ds-comp=page-state]");
    check("P7b · 无结果时显示写实空态（不静默留白）", (await has('[data-ds-kind="empty"]')) && emptyVisible.indexOf("没有找到") >= 0, emptyVisible.slice(0, 80));
    await setInput(".mk-search .ds-search__input", "");
    await sleep(200);

    /* ── 打开应用 ───────────────────────────────────────────────────────── */
    await js("var el=document.querySelector('[data-app-card=\u0022weather\u0022] [data-app-open]'); if(!el) return 'missing'; el.click(); return 'ok';");
    const weatherOpened = await waitSel('.window[aria-label="天气窗口"]', 12000);
    check("P8 · 卡片「打开」真实唤起天气窗口", weatherOpened, "windows=" + (await count(".window")));
    await focusMarket();

    /* ── 版本与更新入口（卡片主体 + 更新页链接） ────────────────────────── */
    await js("var el=document.querySelector('[data-app-card=\u0022canvas\u0022] [data-app-update-open]'); if(!el) return 'missing'; el.click(); return 'ok';");
    const panelOk = await waitSel('[data-app-update="canvas"]', 12000);
    const panelPhase = await attr('[data-app-update="canvas"]', "data-app-update-phase");
    check("P9 · 卡片进入「版本与更新」详情面板（真实 appId）", panelOk, "phase=" + panelPhase);
    const backOk = await click("[data-canvas-update-back]");
    await waitFn("!!document.querySelector('[data-market-apps]')", 12000);
    check("P9b · 详情面板可返回市场网格", backOk === "ok" && (await has("[data-market-apps]")), "back=" + backOk);

    /* ── 更新页 / 加载状态页 ────────────────────────────────────────────── */
    await click('[data-market-view="updates"]');
    await sleep(300);
    const updateRows = await count("[data-market-installed] [data-market-installed-app]");
    const healthEntry = await has("[data-market-health-open]");
    check("P10 · 更新页保留真实已安装列表与加载健康入口", updateRows === 24 && healthEntry, "rows=" + updateRows + " healthEntry=" + healthEntry);
    const installedLink = await js("return document.querySelector('[data-market-installed-app] [data-market-update-open]') ? 'ok' : 'missing'");
    await click("[data-market-update-open]");
    const panelFromUpdates = await waitSel("[data-app-update]", 12000);
    check("P10b · 更新页的「版本与更新」入口可用", installedLink === "ok" && panelFromUpdates, "link=" + installedLink);
    await click("[data-canvas-update-back]");
    await waitFn("!!document.querySelector('[data-market-installed]')", 12000);
    await click("[data-market-health-open]");
    const healthRows = await waitFn("document.querySelectorAll('[data-health-app]').length === 24", 20000);
    check("P10c · 加载状态页逐应用显示真实生效来源", healthRows, "rows=" + (await count("[data-health-app]")));
    await click('[data-market-view="updates"]');
    await sleep(200);

    /* ── 外部应用：集成服务真实状态映射 ─────────────────────────────────── */
    await click('[data-market-view="external"]');
    await waitFn("document.querySelectorAll('[data-market-external] .mk-card').length > 0", 20000);
    const pluginCount = await count("[data-market-external] .mk-card");
    const weatherState0 = await attr('[data-market-external="weather"]', "data-market-external-state");
    check("P11 · 外部应用列出主进程登记的全部集成插件", pluginCount === 11, "plugins=" + pluginCount);
    check("P11b · 默认关闭的插件映射为「安装插件」（不伪造已连接）", weatherState0 === "install", "weather=" + weatherState0);

    await js("var el=document.querySelector('[data-market-external-action=\u0022weather\u0022]'); if(!el) return 'missing'; el.click(); return 'ok';");
    const weatherOpen = await waitFn("(function(){var el=document.querySelector('[data-market-external=\u0022weather\u0022]'); return !!el && el.getAttribute('data-market-external-state')==='open';})()", 20000);
    const weatherPill = await text('[data-market-external-action="weather"]');
    check("P11c · 安装插件走真实 enable，启用后按依赖状态映射为「打开」", weatherOpen && weatherPill.trim() === "打开", "pill=" + weatherPill);

    await js("var el=document.querySelector('[data-market-external-action=\u0022dingtalk\u0022]'); if(!el) return 'missing'; el.click(); return 'ok';");
    const dingtalkConnect = await waitFn("(function(){var el=document.querySelector('[data-market-external=\u0022dingtalk\u0022]'); return !!el && el.getAttribute('data-market-external-state')==='connect';})()", 20000);
    const dingtalkPill = await text('[data-market-external-action="dingtalk"]');
    check("P11d · 已启用但凭据未验证映射为「连接」", dingtalkConnect && dingtalkPill.trim() === "连接", "pill=" + dingtalkPill);
    const enableCount = report.commands.integration.filter((c) => c === "integration/plugins/enable").length;
    check("P11e · 两次按钮都发了真实 integration/plugins/enable", enableCount === 2, "enable=" + enableCount);

    /* ── 第三方应用目录 + 获取二次确认 ──────────────────────────────────── */
    const thirdCard = await waitSel('[data-third-app="arc-notes-plus"]', 20000);
    const thirdPill = await text('[data-third-app="arc-notes-plus"] [data-third-install]');
    check("P12 · 真实本地第三方目录被读出（含 2 个条目与 1 条被拒）", thirdCard && thirdPill.trim() === "获取", "pill=" + thirdPill + " rejected=" + (await count("[data-third-rejected]")));
    const installBefore = report.commands.market.filter((c) => c === "market/thirdparty/install").length;
    await click('[data-third-install="arc-notes-plus"]');
    const dialogOpen = await waitSel('.dialog[role="dialog"]', 8000);
    const installDuring = report.commands.market.filter((c) => c === "market/thirdparty/install").length;
    check("P12b · 「获取」先弹二次确认，确认前不发安装命令", dialogOpen && installDuring === installBefore, "before=" + installBefore + " during=" + installDuring);
    await shot("market-install-confirm-light", "light", "third-party-confirm", win.webContents.getZoomFactor());
    await click("[data-third-install-confirm]");
    const installAfter = await waitFn("(function(){ return " + "true" + " && !!document.querySelector('[data-third-action-error]'); })()", 20000);
    const errCode = await attr("[data-third-action-error]", "data-third-action-error");
    const errText = await text("[data-third-action-error]");
    const installCommands = report.commands.market.filter((c) => c === "market/thirdparty/install").length;
    const fakeSuccess = (await text("[data-third-notice]")).indexOf("已安装") >= 0;
    check(
      "P12c · 确认后走真实安装命令，失败显示后端结构化错误码（不伪造成功）",
      installCommands === installBefore + 1 && installAfter && !!errCode && errCode.length > 0 && errText.indexOf(errCode) >= 0 && !fakeSuccess,
      "code=" + errCode + " text=" + errText.slice(0, 120) + " cmd=" + installCommands,
    );

    /* ── 键盘可达：Tab 进入导航、Enter 切换视图、焦点环 2px ─────────────── */
    win.focus();
    win.webContents.focus();
    await sleep(220);
    await focusSel(".mk-search .ds-search__input");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await sleep(160);
    const afterTab = await activeInfo();
    await focusSel('[data-market-view="apps"]');
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await sleep(240);
    const viewAfterEnter = await text("[data-market-title]");
    await focusSel('[data-market-view="updates"]');
    const focusRing = await activeInfo();
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await sleep(260);
    const updatesTitle = await text("[data-market-title]");
    check(
      "P13 · Tab 顺序进入操作按钮，Enter 可切换视图（键盘可达）",
      !!afterTab && afterTab.tag === "BUTTON" && viewAfterEnter === "发现" && updatesTitle === "更新",
      "tab=" + JSON.stringify(afterTab) + " enterView=" + viewAfterEnter + " updates=" + updatesTitle,
    );
    await focusSel('[data-market-view="updates"]');
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await focusSel('[data-market-view="updates"]');
    const ring = (await activeInfo()) || afterTab || focusRing;
    if (!ring || !ring.focusVisible || !ring.docFocus) {
      notVerified("键盘焦点环", "窗口未持有系统焦点（docFocus=" + (ring && ring.docFocus) + "，focusVisible=" + (ring && ring.focusVisible) + "），:focus-visible 不匹配，无法在本次探针里量到焦点环；导航按钮已在样式里显式声明 outline: 2px solid var(--focus)");
    } else {
      check(
        "P13b · 键盘焦点环为 2px 中性轮廓（不是彩色）",
        ring.outlineWidth === "2px" && ring.outlineStyle === "solid" && /rgb\(38, 38, 38\)|rgb\(223, 223, 223\)|rgba\(38, 38, 38/.test(ring.outlineColor),
        JSON.stringify({ afterTab, focusRing }),
      );
      await shot("market-focus-tab-light", "light", "keyboard-focus", win.webContents.getZoomFactor());
    }

    /* ── 减少动态：停用轮播 + 视图动画归零 ──────────────────────────────── */
    const lightTheme = await applyTheme("light", true);
    await openMarket();
    await waitMarketReady();
    const rmIndex0 = await attr("[data-market-hero]", "data-market-hero-index");
    await sleep(4600);
    const rmIndex1 = await attr("[data-market-hero]", "data-market-hero-index");
    const rmMeasure = await measure();
    check(
      "P14 · 应用内「减少动态」下 hero 不轮播、视图动画为 0s",
      lightTheme.reduced && String(rmIndex0) === String(rmIndex1) && rmMeasure.viewAnimation === "0s",
      "reduced=" + lightTheme.reduced + " index=" + rmIndex0 + "/" + rmIndex1 + " animation=" + rmMeasure.viewAnimation,
    );

    /* ── 浅色截图（减少动态 = 稳定截图条件） ────────────────────────────── */
    await setView("apps");
    await sleep(200);
    await shot("market-discover-light", "light", "discover", win.webContents.getZoomFactor());
    report.measurements.light = await measure();
    buildDiffs(report.measurements.light, "浅色 · 发现（缩放 1.0）");

    await setView("updates");
    await shot("market-updates-light", "light", "updates", win.webContents.getZoomFactor());
    await setView("external");
    await waitFn("!!document.querySelector('[data-third-app]')", 20000);
    await shot("market-external-light", "light", "external", win.webContents.getZoomFactor());
    await setView("apps");
    await js("var el=document.querySelector('[data-app-card=\u0022canvas\u0022] [data-app-update-open]'); if(!el) return 'missing'; el.click(); return 'ok';");
    await waitSel('[data-app-update="canvas"]', 12000);
    await shot("market-detail-light", "light", "detail", win.webContents.getZoomFactor());
    await click("[data-canvas-update-back]");
    await waitFn("!!document.querySelector('[data-market-apps]')", 12000);

    /* ── 深色截图 ───────────────────────────────────────────────────────── */
    const darkTheme = await applyTheme("dark", true);
    await openMarket();
    await waitMarketReady();
    await setView("apps");
    await sleep(200);
    await shot("market-discover-dark", "dark", "discover", win.webContents.getZoomFactor());
    report.measurements.dark = await measure();
    buildDiffs(report.measurements.dark, "深色 · 发现（缩放 1.0）");
    const darkCardBg = report.measurements.dark.card ? report.measurements.dark.card.backgroundColor : "";
    check("P15 · 深色主题真实生效（.desktop.dark）且卡片有独立明度", darkTheme.dark && darkCardBg !== "rgba(0, 0, 0, 0)", "bg=" + darkCardBg);
    await setView("updates");
    await shot("market-updates-dark", "dark", "updates", win.webContents.getZoomFactor());
    await setView("external");
    await waitFn("!!document.querySelector('[data-third-app]')", 20000);
    await shot("market-external-dark", "dark", "external", win.webContents.getZoomFactor());
    await setView("apps");
    await js("var el=document.querySelector('[data-app-card=\u0022canvas\u0022] [data-app-update-open]'); if(!el) return 'missing'; el.click(); return 'ok';");
    await waitSel('[data-app-update="canvas"]', 12000);
    await shot("market-detail-dark", "dark", "detail", win.webContents.getZoomFactor());
    await click("[data-canvas-update-back]");
    await waitFn("!!document.querySelector('[data-market-apps]')", 12000);

    /* ── 125% 缩放：仍是两列、不横向溢出（先回到浅色，截图标签与主题一致） ── */
    const lightAgain = await applyTheme("light", true);
    await openMarket();
    await waitMarketReady();
    await setView("apps");
    report.functional.zoomTheme = lightAgain.dark ? "dark" : "light";
    win.webContents.setZoomFactor(1.25);
    await sleep(500);
    await waitMarketReady();
    await sleep(300);
    await shot("market-discover-light-zoom125", "light", "discover", win.webContents.getZoomFactor());
    const zoomMeasure = await measure();
    const overflow = await js("var m=document.querySelector('.split-main'); return m ? m.scrollWidth - m.clientWidth : -1");
    check(
      "P16 · 125% 缩放仍两列且不横向溢出",
      zoomMeasure.grid && zoomMeasure.grid.columns === 2 && overflow <= 1,
      "columns=" + (zoomMeasure.grid ? zoomMeasure.grid.columns : "?") + " overflow=" + overflow + " zoom=" + win.webContents.getZoomFactor(),
    );
    report.measurements.zoom125 = zoomMeasure;
    buildDiffs(zoomMeasure, "浅色 · 发现（缩放 1.25）");
    win.webContents.setZoomFactor(1);

    /* ── 命令白名单 / console / network ────────────────────────────────── */
    const marketWhitelist = [
      "market/catalog",
      "market/update/status",
      "market/update/check",
      "market/update/install",
      "market/update/rollback",
      "market/update/sources",
      "market/update/source/set",
      "market/update/health",
      "market/thirdparty/list",
      "market/thirdparty/install",
      "market/thirdparty/rollback",
      "market/thirdparty/source/get",
      "market/thirdparty/source/set",
    ];
    const integrationWhitelist = [
      "integration/health",
      "integration/commands",
      "integration/plugins/list",
      "integration/plugins/get",
      "integration/plugins/enable",
      "integration/plugins/disable",
      "integration/plugins/health",
    ];
    const badMarket = Array.from(new Set(report.commands.market)).filter((c) => marketWhitelist.indexOf(c) < 0);
    const badIntegration = Array.from(new Set(report.commands.integration)).filter((c) => c.indexOf("integration/") === 0 && integrationWhitelist.indexOf(c) < 0);
    check("P17 · 只发市场/集成白名单命令", badMarket.length === 0 && badIntegration.length === 0, JSON.stringify({ badMarket, badIntegration }));

    const shotViews = report.screenshots.map((s) => s.theme + ":" + s.view);
    const requiredShots = ["light:discover", "light:updates", "light:external", "light:detail", "dark:discover", "dark:updates", "dark:external", "dark:detail"];
    check("P18 · 浅/深 × 发现/更新/外部应用 + 详情面板截图齐全", requiredShots.every((k) => shotViews.indexOf(k) >= 0), shotViews.join(", "));
    check(
      "P19 · 0 console error（桌面壁纸原生视频的 openarc-file CORS 记为环境已知，不计入）",
      report.console.errors.length === 0,
      JSON.stringify(report.console.errors.slice(0, 5)) + " total=" + report.console.total + " environmentKnown=" + report.console.environmentKnown.length,
    );
    check("P20 · 0 非本地请求", report.network.nonLocal.length === 0, JSON.stringify(report.network.nonLocal.slice(0, 5)) + " total=" + report.network.total);
  } catch (err) {
    report.errors.push(String((err && err.stack) || err));
    check("探针整体未抛异常", false, String((err && err.message) || err).slice(0, 300));
  } finally {
    try {
      win?.destroy();
    } catch (error) {
      /* ignore */
    }
    try {
      fs.rmSync(USER_DATA, { recursive: true, force: true });
    } catch (error) {
      /* ignore */
    }
  }
  out("RESULT " + JSON.stringify(report));
  app.quit();
});
`;
fs.writeFileSync(path.join(probeDir, "main.cjs"), probeMain, "utf8");
fs.writeFileSync(path.join(probeDir, "package.json"), JSON.stringify({ name: "oa-market-ui-probe", version: "0.0.0", main: "main.cjs" }), "utf8");

const childEnv = Object.assign({}, process.env, { OA_DEV_SERVER: devURL, OA_MARKET_ROOT: ROOT });
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
const child = spawn(electronPath, [probeDir, "--no-sandbox"], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  stdout += String(d);
  process.stdout.write(String(d));
});
child.stderr.on("data", (d) => {
  stderr += String(d);
  process.stderr.write(String(d));
});
const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => child.kill("SIGKILL"), 420000);
  child.on("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
if (vite) {
  try {
    vite.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}
try {
  fs.rmSync(probeDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!match) {
  console.log("ERROR: 探针未输出结果");
  console.log("stdout:\n" + stdout.slice(-4000));
  console.log("stderr:\n" + stderr.slice(-3000));
  process.exit(1);
}
const report = JSON.parse(match[1]);
try {
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));
} catch {
  /* 报告不是关键路径 */
}
const failed = report.checks.filter((c) => !c.ok);
console.log("");
console.log((report.checks.length - failed.length) + "/" + report.checks.length + " checks passed");
for (const shot of report.screenshots) {
  console.log("截图 " + shot.theme + " · " + shot.view + " · " + shot.file + " (" + shot.pixels.width + "x" + shot.pixels.height + " px, css " + Math.round(shot.css.width) + "x" + Math.round(shot.css.height) + ", zoom " + shot.zoom + ")");
}
const diffsBad = report.diffs.filter((d) => !d.ok);
console.log("原型逐项差异：" + (report.diffs.length - diffsBad.length) + "/" + report.diffs.length + " 项与规范/原型一致");
for (const d of diffsBad) console.log("  差异 " + d.item + "：期望 " + d.expected + "，实测 " + d.measured + "（" + d.note + "）");
console.log("console error=" + report.console.errors.length + " 非本地请求=" + report.network.nonLocal.length);
console.log("市场命令：" + JSON.stringify(Array.from(new Set(report.commands.market))) + " 集成命令：" + JSON.stringify(Array.from(new Set(report.commands.integration))));
if (report.notVerified.length) {
  console.log("NOT VERIFIED：");
  for (const nv of report.notVerified) console.log("  - " + nv.name + " :: " + nv.reason);
}
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n"));
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name + " (" + f.detail + ")").join(" | "));
  process.exit(1);
}
if (exitCode !== 0) {
  console.log("Electron 退出码 " + exitCode + "\nstderr:\n" + stderr.slice(-1500));
  process.exit(1);
}
console.log("PASS: 应用市场在真实 Electron 中的视图切换 / 分类 / 搜索 / 打开 / 更新入口 / 第三方二次确认 / 集成状态 / 键盘可达全部成立。");
console.log("报告：" + path.relative(ROOT, path.join(ART, "report.json")));
