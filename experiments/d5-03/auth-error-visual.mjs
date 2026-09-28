/**
 * D5-03 第五批 · 登录/初始化失败文案（errorText 可展示 detail 白名单）真机视觉与动效验收。
 *
 * 被测改动：src/identity/types.ts 的 errorText / SHOWABLE_ERROR_DETAIL 与
 * src/identity/AuthScreens.tsx 的 password-mismatch 标记。真机走真实 electron .（隔离 userData）
 * + 真实产品 UI（三步向导 / 登录页 / 系统设置面板），主题与减少动态效果都用**真实设置面板**切换。
 *
 * 段：
 *   V1 浅色（默认）· 初始化向导「两次输入的密码不一致」→ 截图 + 计算样式 + 对比度
 *   V2 深色（真实设置面板）· 重置后重新初始化向导同一条失败 → 截图 + 对比度
 *   V3 深色 + 减少动态效果（真实设置面板）· 系统设置「显示名太长」错误行（同类 .auth-error 的第二个真实面）
 *   V4 登录失败文案：错误口令（无 detail）→ 连续失败到限流（RATE_LIMITED，detail 是对象）
 *   V5 内部 detail 不进界面（DOM 全文扫描 + 旧括号形态扫描）
 *   V6 对比度量测（截图裁行 → 页面内 canvas 取众数背景 + 取文字像素 → WCAG 相对亮度）
 *   V7 窗口 / 缩放 / 主题 / 背景 / 透明度基准核对
 *   Z 收尾（stderr / 边界 / 源码指纹 / 总数）
 *
 * 边界：不连真实第三方、不发用户数据、不声称插件隔离通过、不改产品代码；查库只读；
 * 临时目录全部经 experiments/d5-03/userdata-ownership.cjs 建与清。
 *
 * 第六批（本文件被修改的两处，逐字披露见 experiments/d5-03/D5-03-BATCH6-MATRIX-REPORT.md）：
 *   ① V7b 的 .auth-error 规则体从「按行号硬切 split("\n").slice(2464, 2472)」改为
 *      「按选择器提取」（新模块 experiments/d5-03/auth-error-css-audit.cjs）—— 旧切片在第六批
 *      规则体挪到 2471-2478 后只剩注释 + 1 条声明，断言半空（恒真）。
 *   ② V7b 的 !cssChanged 判据（本批 diff 不含 .css）重基线为「本批新增 transition/animation
 *      声明数 = 0 + 运行时 V7a 全绿」—— 该判据在「本批修复就是改 CSS」的前提下必然 FAIL。
 *   其余 V1–V7、Z 段一字未改；新增 V7c 与 V8–V12 全部是**增补**判定。
 */
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RUN_ARTIFACTS = require(path.join(here, "run-artifacts.cjs"));
const OWNERSHIP = require(path.join(here, "userdata-ownership.cjs"));
const MATRIX = require(path.join(here, "auth-error-matrix.cjs"));
const CDP_PORT_BASE = Number(process.env.OA_D503E_VIS_CDP_PORT || 9823);
const USERDATA_PREFIX_BASE = OWNERSHIP.PREFIX;
const ADMIN = { id: "admin@d503e-visual.test", pw: "visual-admin-1" };
const ADMIN2 = { id: "admin2@d503e-visual.test", pw: "visual-admin-2" };
const extraArgs = (process.env.OA_D503E_ELECTRON_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPECT = {
  mismatch: "输入不合法。两次输入的密码不一致。",
  mismatchOldForm: "（两次输入的密码不一致）",
  marker: "password-mismatch",
  displayNameTooLong: "输入不合法。显示名太长了。",
  invalidCredentials: "账号或密码不正确。",
  rateLimited: "尝试过于频繁，请稍后再试。",
};
/** 内部 detail 标记（运维口径）：真机界面上一个都不许出现。 */
const INTERNAL_DETAILS = ["idle-expiry", "absolute-expiry", "session-missing", "not-locked", "no-stored-session", "confirm-required", "password-mismatch", "password-too-short", "identifier-taken", "display-name-too-long", "expired:idle", "expired:absolute"];

/* ══════════════════════════ 记录 / 日志 ══════════════════════════ */
const CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [], LOG_LINES = [], DEFECTS = [], STEPS = [], SHOTS = [], CONTRAST = {};
let passed = 0, failed = 0;
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG_LINES.push(s); _log(s); };
const _err = console.error.bind(console);
console.error = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG_LINES.push("[stderr] " + s); _err(s); };
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 2600), at: new Date().toISOString() };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual.slice(0, 900)));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };
const step = (id, title, command, request, result) => { const row = { id, title, command, request, result, at: new Date().toISOString() }; STEPS.push(row); return row; };

/* ══════════════════════════ 通用 ══════════════════════════ */
async function waitFor(fn, timeout = 20000, intervalMs = 120) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch { /* retry */ }
    if (Date.now() - t0 >= timeout) return false;
    await sleep(intervalMs);
  }
}
function fileSha(rel) { try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex"); } catch { return null; } }
function gitText(args) { try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim(); } catch { return null; } }
function pngSize(file) { const b = fs.readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length }; }

let RUN = null, OUT = null, USERDATA_PREFIX = USERDATA_PREFIX_BASE, VIS = null, NOT_VERIFIED_MATRIX = null;
let page = null, app = null;
const apps = [], dialogs = [], consoleErrors = [], SPAWNS = [];
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
const waitSel = (sel, ms = 15000) => waitFor(() => has(sel), ms);
const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const identity = (payload) => js("return await window.openarc.identity.command(" + JSON.stringify(payload) + ")");

/* ══════════════════════════ 身份（真实 UI） ══════════════════════════ */
async function login(identifier, pw) {
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', pw);
  await clickSel('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}
/**
 * 登录页提交一次（不等待成功），返回错误行文本。
 * 判"命令确实回来"用提交按钮的 busy→空闲沿（identity.busy 会 disable 按钮）；同一句话重复出现时
 * 不能靠"文本非空"判断（会读到上一次的旧文本）。
 */
async function loginAttempt(identifier, pw, { waitMs = 8000 } = {}) {
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', pw);
  const before = (await textOf('[data-d3-id="auth-error"]')).trim();
  await clickSel('[data-d3-id="login-submit"]');
  await waitFor(() => js('const b = document.querySelector("[data-d3-id=login-submit]"); return !!b && b.disabled;'), 2000, 30);
  await waitFor(() => js('const b = document.querySelector("[data-d3-id=login-submit]"); return !!b && !b.disabled;'), waitMs, 60);
  await sleep(350); // 命令回来后留一点渲染时间；限流那一拍由调用方的重试循环兜底
  return { text: (await textOf('[data-d3-id="auth-error"]')).trim(), gate: await gate(), previous: before };
}
async function logout() {
  const clicked = await clickSel('[data-d3-id="topbar-logout"]');
  const out = await waitFor(async () => (await gate()) !== "ready", 30000);
  return clicked === "ok" && out;
}
async function setupWizard(acct, displayName, { confirmValue = null } = {}) {
  await waitSel('[data-d3-id="setup-name"]', 30000);
  const next = async (stepId) => {
    const ready = await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"" + stepId + "\"]'); return !!b && !b.disabled;"), 10000);
    const clicked = await clickSel('[data-d3-id="' + stepId + '"]');
    return ready && clicked === "ok";
  };
  await setInput('[data-d3-id="setup-name"]', displayName);
  const s0 = await next("setup-next");
  await waitSel('[data-d3-id="setup-identifier"]', 10000);
  await setInput('[data-d3-id="setup-identifier"]', acct.id);
  const s1 = await next("setup-next");
  await waitSel('[data-d3-id="setup-password"]', 10000);
  await setInput('[data-d3-id="setup-password"]', acct.pw);
  await setInput('[data-d3-id="setup-confirm"]', confirmValue == null ? acct.pw : confirmValue);
  const s2 = await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000);
  const submitted = await clickSel('[data-d3-id="setup-submit"]');
  return { steps: [s0, s1, s2], submitted };
}
/** 向导第三步：故意两次密码不一致 → 返回错误行文本（不提交）。 */
async function wizardMismatch(acct, displayName) {
  const res = await setupWizard(acct, displayName, { confirmValue: acct.pw + "-different" });
  await waitFor(async () => (await textOf('[data-d3-id="auth-error"]')).trim().length > 0, 8000, 150);
  await sleep(250);
  return { ...res, errorText: (await textOf('[data-d3-id="auth-error"]')).trim(), gate: await gate() };
}
/** 向导停在错误态后回到干净的第 1 步：整页 reload（组件状态清空），与产品重启同一条启动询问路径。 */
async function freshWizard() {
  await page.reload().catch(() => {});
  return await waitFor(async () => (await gate()) === "uninitialized", 40000, 300);
}
async function openSettings() {
  if (await has("[data-settings-active]")) return true;
  await js("const el = document.querySelector('.dock-item[data-dock-id=\"settings\"]'); if (el) el.click(); return !!el;");
  return await waitSel("[data-settings-active]", 15000);
}
async function setTheme(mode) {
  const wantDark = mode === "dark";
  const read = () => js("return document.querySelector('.desktop').classList.contains('dark')");
  if ((await read()) === wantDark) return true;
  const up = await openSettings();
  const clicked = up ? await js("const w = document.querySelector('[data-settings-active]')?.closest('.window'); if (!w) return 'missing'; const g = w.querySelector('[aria-label=\"外观\"]'); if (!g) return 'no-group'; const b = Array.from(g.querySelectorAll('button')).find(function (x) { return (x.textContent || '').trim() === " + JSON.stringify(wantDark ? "深色" : "浅色") + "; }); if (!b) return 'no-button'; b.click(); return 'ok';") : "settings-missing";
  const ok = await waitFor(async () => (await read()) === wantDark, 6000, 150);
  return clicked === "ok" && ok;
}
async function setReduced(on) {
  const read = () => js("return document.querySelector('.desktop').classList.contains('reduced')");
  if ((await read()) === on) return true;
  const up = await openSettings();
  const clicked = up ? await js("const w = document.querySelector('[data-settings-active]')?.closest('.window'); if (!w) return 'missing'; const s = w.querySelector('button[role=\"switch\"][aria-label=\"减少动态效果\"]'); if (!s) return 'no-switch'; s.click(); return 'ok';") : "settings-missing";
  const ok = await waitFor(async () => (await read()) === on, 6000, 150);
  return clicked === "ok" && ok;
}

/* ══════════════════════════ 视觉取证 ══════════════════════════ */
async function windowShot(file) {
  await page.screenshot({ path: file });
  SHOTS.push({ file: path.basename(file), kind: "window", ...pngSize(file) });
  return path.basename(file);
}
async function clipShot(file, sel, margin = 6) {
  const clip = await js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; const r = el.getBoundingClientRect(); const vw = window.innerWidth, vh = window.innerHeight; const x = Math.max(0, Math.min(r.left - " + margin + ", vw - 20)); const y = Math.max(0, Math.min(r.top - " + margin + ", vh - 20)); const w = Math.max(20, Math.min(r.width + 2 * " + margin + ", vw - x)); const h = Math.max(20, Math.min(r.height + 2 * " + margin + ", vh - y)); return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };");
  if (!clip) return null;
  await page.screenshot({ path: file, clip });
  SHOTS.push({ file: path.basename(file), kind: "clip", clip, ...pngSize(file) });
  return { file: path.basename(file), clip };
}
/** 计算样式 + token（元素自身作用域，避免 :root 与 .reduced 混淆）。 */
async function styleOf(sel) {
  return await js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; const cs = getComputedStyle(el); return { text: (el.textContent || ''), color: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, transitionProperty: cs.transitionProperty, transitionDuration: cs.transitionDuration, transitionDelay: cs.transitionDelay, animationName: cs.animationName, animationDuration: cs.animationDuration, opacity: cs.opacity, tokFailed: cs.getPropertyValue('--failed').trim(), tokFsCaption: cs.getPropertyValue('--fs-caption').trim(), tokDurQuick: cs.getPropertyValue('--dur-quick').trim(), tokTextSecondary: cs.getPropertyValue('--muted').trim() };");
}
/**
 * 对比度：裁行截图 → 页面内 canvas 解码 → 背景取众数颜色（合成后的真实表面）→
 * 文字取与背景亮度差最大的像素 → WCAG 2.x 相对亮度 (L1+0.05)/(L2+0.05)。
 * 同时在 Node 侧用**计算样式里的 color** 与同一个背景像素算一遍，做三方一致性核对。
 */
async function measureContrast(sel, file, style) {
  const shot = await clipShot(file, sel, 6);
  if (!shot) return { error: "元素不存在：" + sel };
  const b64 = fs.readFileSync(path.join(VIS, shot.file)).toString("base64");
  const px = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = () => res(true); img.onerror = () => rej(new Error("image-decode-failed")); img.src = "data:image/png;base64," + b64; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const hist = new Map();
    for (let i = 0; i < d.length; i += 4) { const k = d[i] + "," + d[i + 1] + "," + d[i + 2]; hist.set(k, (hist.get(k) || 0) + 1); }
    let modeKey = null, modeN = -1;
    for (const [k, n] of hist) if (n > modeN) { modeN = n; modeKey = k; }
    const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bg = modeKey.split(",").map(Number);
    const lbg = lum(bg[0], bg[1], bg[2]);
    let bestKey = null, bestN = 0, bestDiff = -1;
    for (const [k, n] of hist) { const p = k.split(",").map(Number); const diff = Math.abs(lum(p[0], p[1], p[2]) - lbg); if (diff > bestDiff) { bestDiff = diff; bestKey = k; bestN = n; } }
    const tx = bestKey.split(",").map(Number);
    const ltx = lum(tx[0], tx[1], tx[2]);
    const ratio = (Math.max(lbg, ltx) + 0.05) / (Math.min(lbg, ltx) + 0.05);
    return { totalPx: d.length / 4, modeRgb: modeKey, modeShare: modeN / (d.length / 4), textRgb: bestKey, textPixels: bestN, bgLum: lbg, textLum: ltx, ratio, distinctColors: hist.size };
  }, b64);
  const m = String(style.color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  let specifiedRatio = null;
  if (m) {
    const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const lc = lum(Number(m[1]), Number(m[2]), Number(m[3]));
    specifiedRatio = (Math.max(px.bgLum, lc) + 0.05) / (Math.min(px.bgLum, lc) + 0.05);
  }
  const out = { selector: sel, shot: shot.file, clip: shot.clip, pixelSize: pngSize(path.join(VIS, shot.file)), style: { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, tokFailed: style.tokFailed, tokFsCaption: style.tokFsCaption, tokDurQuick: style.tokDurQuick, transitionProperty: style.transitionProperty, transitionDuration: style.transitionDuration, animationName: style.animationName, text: style.text }, ...px, specifiedRatio, measuredMatchesSpecifiedText: px.textRgb.replace(/,/g, ", ") === style.color.replace(/rgba?\((\d+), (\d+), (\d+)/, "$1, $2, $3"), threshold: 4.5, pass: px.ratio >= 4.5 };
  CONTRAST[sel + "@" + shot.file] = out;
  return out;
}
/** 界面全文 + 内部标记扫描。 */
async function domScan(label) {
  return await js([
    "const root = document.querySelector('.desktop') || document.body;",
    "const text = (root.innerText || root.textContent || '');",
    "return { label: " + JSON.stringify(label) + ", gate: document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root', dark: !!document.querySelector('.desktop')?.classList.contains('dark'), reduced: !!document.querySelector('.desktop')?.classList.contains('reduced'), text: text.replace(/\\s+/g, ' ').trim().slice(0, 4000) };",
  ].join("\n"));
}
const hitsIn = (text, needles) => needles.filter((n) => text.includes(n));
const bracketPattern = /（[a-z0-9]+(?:[-:][a-z0-9]+)+）/;

/* ══════════════════════════ Electron 启停 ══════════════════════════ */
async function portFree(port) { try { await fetch("http://127.0.0.1:" + port + "/json/version"); return false; } catch { return true; } }
function psRows() {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" })
      .split("\n").map((l) => { const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m ? { pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], cmd: m[4] } : null; })
      .filter(Boolean);
  } catch { return []; }
}
function descendantsOf(rootPid) {
  const rows = psRows(); const byId = new Map(rows.map((r) => [r.pid, r]));
  return rows.filter((r) => { let p = r.ppid, hops = 0; while (p && hops < 14) { if (p === rootPid) return true; const pr = byId.get(p); if (!pr) return false; p = pr.ppid; hops += 1; } return false; });
}
const pidAlive = (pid) => psRows().some((r) => r.pid === pid && !r.stat.startsWith("Z"));
async function launchApp({ userDataDir = null, label = "" } = {}) {
  if (app) await killApp(app);
  const dir = userDataDir || OWNERSHIP.createOwnedDir({ prefix: USERDATA_PREFIX, kind: label ? "electron-userdata/" + label : "electron-userdata", runId: RUN ? RUN.runId : null });
  const requested = CDP_PORT_BASE + apps.length;
  const reservation = RUN ? await RUN.acquirePort(requested) : null;
  const cdpPort = reservation ? reservation.port : requested;
  if (reservation) await reservation.release();
  if (!(await portFree(cdpPort))) throw new Error("CDP 端口 " + cdpPort + " 仍被占用，拒绝启动");
  const child = spawn(electronPath, [".", "--user-data-dir=" + dir, "--remote-debugging-port=" + cdpPort, ...extraArgs], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" } });
  SPAWNS.push({ kind: "electron", pid: child.pid, label, cdpPort, userDataDir: dir, at: new Date().toISOString() });
  const rec = { label, userDataDir: dir, cdpPort, child, pid: child.pid, browser: null, page: null, stderr: "", launchedAt: Date.now() };
  apps.push(rec);
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { rec.stderr += String(d); });
  let version = null; const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪：" + label + " " + dir + " port=" + cdpPort);
  rec.browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
  const ctx = rec.browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!rec.page && end > Date.now()) { rec.page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!rec.page) await sleep(300); }
  if (!rec.page) throw new Error("未找到界面页面：" + label);
  rec.page.on("dialog", (d) => { dialogs.push(String(d.message()).slice(0, 140)); void d.dismiss().catch(() => {}); });
  rec.page.on("console", (m) => { if (m.type() === "error") consoleErrors.push((label + ":" + m.text()).slice(0, 220)); });
  rec.page.on("pageerror", (e) => consoleErrors.push(label + ":pageerror:" + String(e.message).slice(0, 200)));
  app = rec; page = rec.page;
  return rec;
}
/**
 * 重新连一次 CDP 并把 page 指针换到新对象上。
 *
 * 为什么需要：同一个进程里先 connectOverCDP 连过第一个 electron 实例、把它 kill 掉之后再连第二个实例时，
 * Playwright 的 `page.reload()` 会抛 "Target page, context or browser has been closed"，
 * 之后 `page.screenshot` / `page.keyboard` / `newCDPSession` 也陆续报同一个错，
 * 而 `page.evaluate` 仍然可用。用页面内 location.reload() + 重连可以彻底绕开。
 * 只影响取证脚本自身，不碰产品。
 */
async function rebindPage(rec) {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + rec.cdpPort);
  const ctx = browser.contexts()[0];
  let p = null; const end = Date.now() + 30000;
  while (!p && end > Date.now()) { p = ctx.pages().find((x) => x.url().includes("dist/index.html")) || null; if (!p) await sleep(250); }
  if (!p) throw new Error("重连后找不到界面页面：" + rec.label);
  rec.browser = browser; rec.page = p; app = rec; page = p;
  p.on("dialog", (d) => { dialogs.push(String(d.message()).slice(0, 140)); void d.dismiss().catch(() => {}); });
  p.on("console", (m) => { if (m.type() === "error") consoleErrors.push((rec.label + ":" + m.text()).slice(0, 220)); });
  p.on("pageerror", (e) => consoleErrors.push(rec.label + ":pageerror:" + String(e.message).slice(0, 200)));
  return p;
}

async function killApp(rec) {
  if (!rec) return null;
  const tree = [rec.child.pid, ...descendantsOf(rec.child.pid).filter((r) => !r.stat.startsWith("Z")).map((r) => r.pid)];
  try { rec.child.kill("SIGKILL"); } catch { /* ignore */ }
  await waitFor(() => !pidAlive(rec.child.pid), 15000, 100);
  for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  await waitFor(() => tree.every((p) => !pidAlive(p)), 12000, 100);
  await waitFor(() => portFree(rec.cdpPort), 10000, 200);
  const out = { pid: rec.child.pid, tree, leftovers: tree.filter(pidAlive) };
  if (app === rec) { app = null; page = null; }
  return out;
}
async function cleanupOwnProcesses() {
  const result = { strategy: "own-pid-tree-only", pkillUsed: false, at: new Date().toISOString(), targets: [], leftovers: [] };
  for (const rec of apps) {
    const tree = [rec.child.pid, ...descendantsOf(rec.child.pid).filter((r) => !r.stat.startsWith("Z")).map((r) => r.pid)];
    for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await waitFor(() => tree.every((pid) => !pidAlive(pid)), 12000, 100);
    result.targets.push({ kind: "electron", label: rec.label, rootPid: rec.child.pid, tree, leftovers: tree.filter(pidAlive) });
  }
  result.leftovers = [...new Set(result.targets.flatMap((t) => t.leftovers))];
  return result;
}

/* ══════════════════════════ 主流程 ══════════════════════════ */
async function main() {
  RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "auth-error-visual", basePort: CDP_PORT_BASE, envBaseVar: "OA_D503E_VIS_CDP_PORT", userDataPrefixBase: USERDATA_PREFIX_BASE });
  USERDATA_PREFIX = RUN.userDataPrefix;
  VIS = path.join(RUN.runDir, "visual");
  fs.mkdirSync(VIS, { recursive: true });
  console.log("本次运行：" + RUN.runId + " → " + RUN.runDirRel + "（CDP 基址 " + CDP_PORT_BASE + "，userData 前缀 " + USERDATA_PREFIX + "）");
  note("被测提交：" + (gitText(["rev-parse", "HEAD"]) || "?") + "（分支 " + (gitText(["rev-parse", "--abbrev-ref", "HEAD"]) || "?") + "）");

  const rec = await launchApp({ label: "visual-run1" });
  const metrics0 = await js("const d = document.querySelector('.desktop'); return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: devicePixelRatio, classes: d ? d.className : null, gate: d ? d.getAttribute('data-identity-gate') : null, glassAttr: d ? d.getAttribute('data-glass') : null, wallpaperAttr: d ? d.getAttribute('data-wallpaper') : null, dockIcon: d ? d.style.getPropertyValue('--dock-icon') : null, theme: localStorage.getItem('oa-theme'), wallpaperLs: localStorage.getItem('oa-wallpaper'), glassLs: localStorage.getItem('oa-glass'), opaqueLs: localStorage.getItem('oa-opaque') };");
  record("V0", "真实 electron . 启动（隔离 userData / 独占 CDP 端口），窗口 1440×940、DPR 2（与第一/四批基准同口径）",
    metrics0.innerWidth === 1440 && metrics0.innerHeight === 940 && metrics0.dpr === 2,
    "innerWidth=1440 / innerHeight=940 / devicePixelRatio=2（electron/main.cjs:271-272 默认，未设缩放）",
    JSON.stringify(metrics0));

  /* ── V1 浅色向导「两次密码不一致」 ── */
  const w1 = await wizardMismatch(ADMIN, "D5-03E 视觉 Admin");
  const styleL = await styleOf('[data-d3-id="auth-error"]');
  const domL = await domScan("light-setup-mismatch");
  await windowShot(path.join(VIS, "light-01-setup-password-mismatch.png"));
  const contrastL = await measureContrast('[data-d3-id="auth-error"]', path.join(VIS, "light-02-auth-error-row.png"), styleL);
  const internalL = hitsIn(domL.text, INTERNAL_DETAILS);
  record("V1a", "浅色（默认）· 初始化向导两次密码不一致 → 日志文案 = 「输入不合法。两次输入的密码不一致。」（旧括号形态与标记都不出现）",
    w1.errorText === EXPECT.mismatch && !domL.text.includes(EXPECT.mismatchOldForm) && !domL.text.includes(EXPECT.marker),
    JSON.stringify({ text: EXPECT.mismatch, noOldForm: true, noMarker: true }),
    JSON.stringify({ errorText: w1.errorText, gate: w1.gate, dark: domL.dark, internalHits: internalL, bracketHit: bracketPattern.test(domL.text) }));
  step("V1a", "浅色向导两次密码不一致", "UI: setup-confirm ≠ setup-password → errorText(INVALID_INPUT, password-mismatch)", { password: ADMIN.pw, confirm: ADMIN.pw + "-different" }, { errorText: w1.errorText, gate: w1.gate });

  /* ── V1b 浅色 · 窗口面（系统设置）同一条错误行：把「文字色 vs token」与「合成背景」分开 ── */
  const fresh1 = await freshWizard(); // 向导停在错误态 → reload 回到干净第 1 步（组件状态不跨 reload）
  const setup1 = await setupWizard(ADMIN, "D5-03E 视觉 Admin");
  const login1 = await login(ADMIN.id, ADMIN.pw);
  const settingsUpL = await openSettings();
  const longNameL = "很长的显示名".repeat(20); // 120 字符 > 80 上限
  await setInput('[data-d3-id="settings-name"]', longNameL);
  await waitFor(() => js('const b = document.querySelector("[data-d3-id=settings-save]"); return !!b && !b.disabled;'), 5000, 100);
  const saveClickedL = await clickSel('[data-d3-id="settings-save"]');
  await waitFor(async () => (await textOf('[data-d3-id="settings-error"]')).trim().length > 0, 8000, 150);
  await js("const el = document.querySelector('[data-d3-id=settings-error]'); if (el) el.scrollIntoView({ block: 'center' }); return true;");
  await sleep(400);
  const styleLS = await styleOf('[data-d3-id="settings-error"]');
  const domLS = await domScan("light-settings-error");
  await windowShot(path.join(VIS, "light-03-settings-error.png"));
  const contrastLS = await measureContrast('[data-d3-id="settings-error"]', path.join(VIS, "light-04-auth-error-row.png"), styleLS);
  record("V1b", "浅色 · 窗口面（系统设置）同一条 .auth-error：「文字色 vs token」与「合成背景」分开 —— 若窗口面达标而向导面不达标，说明浅色不达标来自玻璃卡片在默认深色壁纸上的合成背景，不是 --failed 本身",
    !!contrastLS.ratio && contrastLS.ratio >= 4.5,
    "窗口面 ratio >= 4.5（与向导面 2.62:1 对照）",
    JSON.stringify({ ratio: contrastLS.ratio, bg: contrastLS.modeRgb, modeShare: contrastLS.modeShare, text: contrastLS.textRgb, computedColor: styleLS.color, textRect: contrastLS.clip, domDark: domLS.dark, settingsUpL, login1, saveClickedL, text: styleLS.text }));
  step("V1b", "浅色设置→个人资料→显示名（120 字符）保存", "UI: settings-save → identity/update-profile", { displayNameLength: longNameL.length }, { errorText: styleLS.text, contrastWindowSurface: contrastLS.ratio });

  /* ── V2 深色（真实设置面板）→ 重置 → 深色向导同一条失败 ── */
  const themeDark = await setTheme("dark");
  const darkState = await js("return { dark: document.querySelector('.desktop').classList.contains('dark'), reduced: document.querySelector('.desktop').classList.contains('reduced') };");
  record("V2a", "深色主题由**真实设置面板**切换（非注入）：.desktop.dark = true，减少动态效果仍为关",
    themeDark && darkState.dark === true && darkState.reduced === false && fresh1 && setup1.steps.every(Boolean) && login1 === true,
    ".desktop.dark=true + reduced=false + 向导三步都点到了 + 登录成功", JSON.stringify({ themeDark, darkState, fresh1, setup: setup1, login: login1 }));
  const resetForDark = await identity({ type: "identity/reset-installation", confirm: "DELETE-ALL-IDENTITY-DATA" });
  step("V2b", "identity/reset-installation（正确 confirm；产品无该命令 UI 入口，见报告）", "identity/reset-installation", { confirm: "DELETE-ALL-IDENTITY-DATA" }, { ok: resetForDark?.ok, status: resetForDark?.status || null });
  await page.reload().catch(() => {});
  const backToWizard = await waitFor(async () => (await gate()) === "uninitialized", 40000, 300);
  const w2 = await wizardMismatch(ADMIN2, "D5-03E 视觉 Admin 2");
  const styleD = await styleOf('[data-d3-id="auth-error"]');
  const domD = await domScan("dark-setup-mismatch");
  await windowShot(path.join(VIS, "dark-01-setup-password-mismatch.png"));
  const contrastD = await measureContrast('[data-d3-id="auth-error"]', path.join(VIS, "dark-02-auth-error-row.png"), styleD);
  const internalD = hitsIn(domD.text, INTERNAL_DETAILS);
  record("V2b", "深色（重置后重新初始化，向导仍为深色）· 同一条失败文案一致；内部标记与旧括号形态都不出现",
    resetForDark?.ok === true && backToWizard && domD.dark === true && w2.errorText === EXPECT.mismatch && !domD.text.includes(EXPECT.marker) && !bracketPattern.test(domD.text),
    JSON.stringify({ resetOk: true, gate: "uninitialized", dark: true, text: EXPECT.mismatch }),
    JSON.stringify({ resetOk: resetForDark?.ok, status: resetForDark?.status || null, backToWizard, errorText: w2.errorText, gate: w2.gate, dark: domD.dark, internalHits: internalD, bracketHit: bracketPattern.test(domD.text) }));

  /* ── V3 深色 + 减少动态效果 · 系统设置「显示名太长」 ── */
  const fresh2 = await freshWizard(); // 同上：深色向导停在错误态 → reload 回到干净第 1 步
  const setup2 = await setupWizard(ADMIN2, "D5-03E 视觉 Admin 2");
  const login2 = await login(ADMIN2.id, ADMIN2.pw);
  const settingsUp = await openSettings();
  const reducedOn = await setReduced(true);
  const longName = "很长的显示名".repeat(20); // 120 字符 > 80 上限
  await setInput('[data-d3-id="settings-name"]', longName);
  await waitFor(() => js('const b = document.querySelector("[data-d3-id=settings-save]"); return !!b && !b.disabled;'), 5000, 100);
  const saveClicked = await clickSel('[data-d3-id="settings-save"]');
  await waitFor(async () => (await textOf('[data-d3-id="settings-error"]')).trim().length > 0, 8000, 150);
  await js("const el = document.querySelector('[data-d3-id=\"settings-error\"]'); if (el) el.scrollIntoView({ block: 'center' }); return true;");
  await sleep(400);
  const styleR = await styleOf('[data-d3-id="settings-error"]');
  const domR = await domScan("dark-reduced-settings-error");
  await windowShot(path.join(VIS, "dark-reduced-01-settings-error.png"));
  const contrastR = await measureContrast('[data-d3-id="settings-error"]', path.join(VIS, "dark-reduced-02-auth-error-row.png"), styleR);
  const internalR = hitsIn(domR.text, INTERNAL_DETAILS);
  record("V3a", "深色 + 减少动态效果（真实设置面板）· 设置里「显示名太长」→ 「输入不合法。显示名太长了。」（第二个白名单条目）",
    settingsUp && reducedOn && saveClicked === "ok" && styleR.text.trim() === EXPECT.displayNameTooLong && !internalR.length,
    JSON.stringify({ reduced: true, text: EXPECT.displayNameTooLong }), JSON.stringify({ fresh2, setup: setup2, login: login2, settingsUp, reducedOn, saveClicked, text: styleR.text, dark: domR.dark, reduced: domR.reduced, internalHits: internalR }));
  step("V3a", "设置→个人资料→显示名（120 字符）保存", "UI: settings-save → identity/update-profile", { displayNameLength: longName.length }, { errorText: styleR.text });

  /* ── V4 登录失败文案 ── */
  const loggedOut = await logout();
  const attempt1 = await loginAttempt(ADMIN2.id, "definitely-wrong-1");
  await windowShot(path.join(VIS, "dark-03-login-invalid-credentials.png"));
  const domLogin = await domScan("dark-login-invalid-credentials");
  let rateLimited = null;
  for (let i = 0; i < 12 && !rateLimited; i++) {
    const a = await loginAttempt(ADMIN2.id, "definitely-wrong-" + (i + 2), { waitMs: 8000 });
    if (a.text.includes("尝试过于频繁")) rateLimited = { attempt: i + 2, text: a.text, gate: a.gate };
  }
  await windowShot(path.join(VIS, "dark-04-login-rate-limited.png"));
  const domRate = await domScan("dark-login-rate-limited");
  const internalLogin = hitsIn(domLogin.text + " " + domRate.text, INTERNAL_DETAILS);
  record("V4a", "登录页错误口令 → 「账号或密码不正确。」（无 detail，界面上没有内部标记）",
    loggedOut && attempt1.text === EXPECT.invalidCredentials && !hitsIn(domLogin.text, INTERNAL_DETAILS).length,
    JSON.stringify({ text: EXPECT.invalidCredentials }), JSON.stringify({ loggedOut, attempt1, gate: attempt1.gate, internalHits: hitsIn(domLogin.text, INTERNAL_DETAILS) }));
  record("V4b", "连续失败到限流 → 「尝试过于频繁，请稍后再试。」（RATE_LIMITED 的 detail 是对象 {retryAfterMs}，旧实现会显示 [object Object]，现被白名单过滤）",
    !!rateLimited && rateLimited.text === EXPECT.rateLimited && !rateLimited.text.includes("object") && !rateLimited.text.includes("["),
    JSON.stringify({ text: EXPECT.rateLimited }), JSON.stringify({ rateLimited, internalHits: internalLogin, domText: domRate.text.slice(0, 300) }));
  step("V4b", "登录连续失败到限流", "identity/login × N → RATE_LIMITED", { failures: rateLimited ? rateLimited.attempt : null }, { errorText: rateLimited ? rateLimited.text : null });

  /* ── V5 内部 detail 扫描汇总 ── */
  record("V5", "真机三个界面（浅色向导 / 深色向导 / 深色登录页与设置）全文扫描：11 个内部 detail 标记与「（kebab-case）」旧括号形态一个都不出现",
    !internalL.length && !internalD.length && !internalR.length && !internalLogin.length
      && ![domL, domD, domR, domLogin, domRate].some((d) => bracketPattern.test(d.text)),
    JSON.stringify({ forbidden: INTERNAL_DETAILS, bracket: "（kebab-case）" }),
    JSON.stringify({ light: internalL, dark: internalD, reducedSettings: internalR, login: internalLogin, bracketHits: [domL, domD, domR, domLogin, domRate].map((d) => bracketPattern.test(d.text)) }));
  note("本次未构造到的内部 detail 路径：idle-expiry（已由第四批 mcp-expiry-e2e --scenario=idle 真机覆盖登录页文案）、session-missing / not-locked（产品 UI 不可达：restore 失败不显示错误行，unlock 只在锁屏可用），处置见 notVerified。");

  /* ── V6 对比度汇总 ── */
  const contrastRows = [contrastL, contrastD, contrastR].filter((c) => c && !c.error);
  record("V6a", "对比度实测（浅色向导错误行）：>= 4.5:1（12px / 400 = 普通文本门槛，DESIGN_SYSTEM.md:248）",
    !!contrastL.ratio && contrastL.ratio >= 4.5, "ratio >= 4.5", JSON.stringify({ ratio: contrastL.ratio, bg: contrastL.modeRgb, text: contrastL.textRgb, style: contrastL.style }));
  record("V6b", "对比度实测（深色向导错误行）：>= 4.5:1",
    !!contrastD.ratio && contrastD.ratio >= 4.5, "ratio >= 4.5", JSON.stringify({ ratio: contrastD.ratio, bg: contrastD.modeRgb, text: contrastD.textRgb, style: contrastD.style }));
  record("V6c", "对比度实测（深色 + 减少动态效果 · 设置错误行）：>= 4.5:1（同类 .auth-error 的第二个面）",
    !!contrastR.ratio && contrastR.ratio >= 4.5, "ratio >= 4.5", JSON.stringify({ ratio: contrastR.ratio, bg: contrastR.modeRgb, text: contrastR.textRgb, style: contrastR.style }));
  record("V6d", "计算样式与 token 一致：12px（--fs-caption）/ 字重 400 / color = --failed（浅 #d70015、深 #ff453a）",
    styleL.fontSize === "12px" && styleD.fontSize === "12px" && styleL.fontWeight === "400" && styleD.fontWeight === "400"
      && styleL.color === "rgb(215, 0, 21)" && styleD.color === "rgb(255, 69, 58)",
    "12px / 400 / 浅 rgb(215,0,21) / 深 rgb(255,69,58)",
    JSON.stringify({ light: { color: styleL.color, fontSize: styleL.fontSize, fontWeight: styleL.fontWeight, lineHeight: styleL.lineHeight, tokFailed: styleL.tokFailed, tokFsCaption: styleL.tokFsCaption }, dark: { color: styleD.color, fontSize: styleD.fontSize, fontWeight: styleD.fontWeight, lineHeight: styleD.lineHeight, tokFailed: styleD.tokFailed } }));

  /* ── V7 动效（本批未新增） ── */
  const motionShot = { light: { transitionProperty: styleL.transitionProperty, transitionDuration: styleL.transitionDuration, transitionDelay: styleL.transitionDelay, animationName: styleL.animationName, animationDuration: styleL.animationDuration, tokDurQuickElement: styleL.tokDurQuick }, dark: { transitionProperty: styleD.transitionProperty, transitionDuration: styleD.transitionDuration, animationName: styleD.animationName, tokDurQuickElement: styleD.tokDurQuick }, darkReduced: { transitionProperty: styleR.transitionProperty, transitionDuration: styleR.transitionDuration, animationName: styleR.animationName, tokDurQuickElement: styleR.tokDurQuick } };
  const rootDur = await js("const el = document.querySelector('[data-d3-id=settings-error]'); return { rootDurQuick: getComputedStyle(document.documentElement).getPropertyValue('--dur-quick').trim(), reducedClass: document.querySelector('.desktop').classList.contains('reduced'), errorHasAnimation: el ? getComputedStyle(el).animationName : null };");
  const v7aOk = record("V7a", "错误行无动效：常规（浅/深）与减少动态效果下 transition/animation 均为 none/0s（元素作用域 --dur-quick = 0ms）",
    motionShot.light.animationName === "none" && motionShot.dark.animationName === "none" && motionShot.darkReduced.animationName === "none"
      && motionShot.darkReduced.transitionDuration.split(",").every((d) => d.trim() === "0s") && styleR.tokDurQuick === "0ms",
    "animationName=none；减少动态效果下 transitionDuration=0s、元素作用域 --dur-quick=0ms",
    JSON.stringify({ motionShot, rootDur }));
  /* 门禁重基线（第六批，唯一允许的既有判定改动，逐字披露见报告）：
     旧口径两处假阳性 ——
       ① 规则体用行号硬切 split("\n").slice(2464, 2472)：第六批把 .auth-error 从 2465 挪到
          2471-2478，切片只剩注释 + margin-top，断言半空（恒真）。改为按**选择器**提取。
       ② 判据 !cssChanged（本批 diff 不含 .css）在"本批修复就是给 .auth-error 加不透明底"的
          前提下必然 FAIL —— 与第五批 R3 同形，属 fail-closed 设计问题，不是产品缺陷。
          替代判据 = 本批**新增** transition/animation 声明数 = 0 + 运行时 V7a 仍全绿。
     反证对照（修正前会给假绿/假红）见 experiments/d5-03/batch6-gate-rebase-proof.mjs。 */
  const AUDIT = require(path.join(here, "auth-error-css-audit.cjs"));
  const BATCH_BASE = process.env.OPENARC_BATCH_BASE || "d4a3516";
  let batchBaseIsAncestor = false;
  try { execFileSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", BATCH_BASE, "HEAD"], { stdio: "ignore" }); batchBaseIsAncestor = true; } catch { batchBaseIsAncestor = false; }
  const cssTextRaw = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
  const authErrorRule = AUDIT.readRule(path.join(ROOT, "src/styles.css"), ".auth-error");
  const batchDiffFiles = (gitText(["diff", "--name-only", BATCH_BASE]) || "").split("\n").filter(Boolean);
  const cssDiff = gitText(["diff", "--unified=0", BATCH_BASE, "--", "*.css"]) || "";
  const addedMotion = AUDIT.countAddedMotionDeclarations(cssDiff);
  /* 旧口径复现：只作为反证留痕（例如旧行号切片只覆盖 1 条声明、旧判据在本批必 FAIL），不参与评分 */
  const legacySlice = AUDIT.legacyLineSlice(cssTextRaw, 2465, 2472);
  const legacy = {
    ruleExtraction: { criterion: 'split("\\n").slice(2464, 2472)', declarations: AUDIT.declarationsOf(legacySlice).count, declarationNames: AUDIT.declarationsOf(legacySlice).names, hasBackgroundDeclaration: /(^|[;{\s])background\s*:/.test(legacySlice) },
    cssChanged: { criterion: "!cssChanged（本批 diff 不含 .css）", cssChanged: AUDIT.legacyCssChanged(batchDiffFiles), wouldFail: AUDIT.legacyCssChanged(batchDiffFiles) },
  };
  record("V7b", "【门禁重基线 · 旧口径→新口径】本批**新增** transition/animation 声明数 = 0，且运行时 V7a 仍全绿（旧判据「本批 diff 不含 .css」在「本批修复就是改 .auth-error 的 CSS」前提下必然 FAIL，属 fail-closed 设计问题，不是产品缺陷；与第五批 R3 同形）",
    addedMotion.count === 0 && v7aOk && batchBaseIsAncestor,
    "本批新增 transition/animation 声明数 = 0 且 V7a PASS；基线 = d4a3516（第五批定稿提交，须是 HEAD 祖先）",
    JSON.stringify({ batchBase: BATCH_BASE, batchBaseIsAncestor, batchDiffFiles, addedMotion, legacy }));
  record("V7c", "【假阳性 ①修正】.auth-error 规则体按**选择器**提取且完整：命中 1 条、6 条声明（含本批新增 background / border-radius / padding），不含 .auth-error:empty 的 display、无 transition/animation —— 旧口径按行号硬切只剩注释 + 1 条声明（恒真）",
    authErrorRule.bodies.length === 1 && authErrorRule.declarations >= 6
      && ["margin-top", "font-size", "color", "background", "border-radius", "padding"].every((n) => authErrorRule.declarationNames.includes(n))
      && /background\s*:\s*rgb\(var\(--content-rgb\)\s*\/\s*1\)/.test(authErrorRule.text)
      && !/(^|[;{\s])display\s*:/.test(authErrorRule.text) && authErrorRule.hasMotion === false
      && legacy.ruleExtraction.declarations === 1 && legacy.ruleExtraction.hasBackgroundDeclaration === false,
    "选择器提取：bodies=1 / 声明 >=6（含 background=rgb(var(--content-rgb)/1)、border-radius、padding）/ 无 display / 无 transition|animation；对照：旧行号切片声明数 = 1 且不含 background",
    JSON.stringify({ selector: ".auth-error", file: "src/styles.css", lineRange: authErrorRule.lineRange, bodies: authErrorRule.bodies.length, declarations: authErrorRule.declarations, declarationNames: authErrorRule.declarationNames, text: authErrorRule.text, hasMotion: authErrorRule.hasMotion, legacyRuleExtraction: legacy.ruleExtraction, legacySlicePreview: legacySlice.slice(0, 160) }));

  /* ── V8–V12 · 真机渲染与对比度矩阵 / 布局 / 焦点 / 动效（新开一个 electron 实例） ── */
  const MATRIX_OUT = await MATRIX.runMatrix({
    js, page, sleep, waitFor, VIS, record, note, notVerified, step,
    measureContrast, windowShot, clipShot, domScan, styleOf,
    has, textOf, setInput, clickSel, waitSel, gate, identity,
    setupWizard, login, logout, loginAttempt, openSettings, setTheme, setReduced,
    launchApp, EXPECT,
    pageNow: () => page, appRec: () => app, rebindPage,
  });
  NOT_VERIFIED_MATRIX = MATRIX_OUT;

  /* ── Z 收尾 ── */
  const ENV_NOISE = /ExperimentalWarning|SQLite is an experimental|SetApplicationIsDaemon|NSOSStatusErrorDomain|IMKCFRunLoopWakeUpReliable|In-process GPU|ERR_BLOCKED_BY_CSP/;
  const appStderrs = apps.map((a) => ({ label: a.label, pid: a.pid, errors: a.stderr.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !ENV_NOISE.test(l)).slice(0, 4) }));
  record("Z1", "全部 Electron 实例的主进程 stderr 无未处理错误", appStderrs.every((a) => a.errors.length === 0), "无错误行", JSON.stringify(appStderrs));
  note("渲染层控制台错误样本：" + JSON.stringify(consoleErrors.filter((l) => !ENV_NOISE.test(l)).slice(0, 6)));

  const distMain = (() => { try { const list = fs.readdirSync(path.join(ROOT, "dist", "assets")).filter((f) => /^main-.*\.js$/.test(f)); return list.map((f) => ({ file: f, hasWhitelistMarker: fs.readFileSync(path.join(ROOT, "dist", "assets", f), "utf8").includes("password-mismatch"), hasMismatchCopy: fs.readFileSync(path.join(ROOT, "dist", "assets", f), "utf8").includes("两次输入的密码不一致。"), mtime: fs.statSync(path.join(ROOT, "dist", "assets", f)).mtime.toISOString() })); } catch { return []; } })();
  record("Z2", "被测渲染层确实是本批构建（dist bundle 含白名单标记与新手话；src 改动时间早于构建时间）",
    distMain.length > 0 && distMain.every((d) => d.hasWhitelistMarker && d.hasMismatchCopy),
    "dist/assets/main-*.js 含 password-mismatch 与「两次输入的密码不一致。」",
    JSON.stringify({ distMain, srcMtimes: { types: fs.statSync(path.join(ROOT, "src/identity/types.ts")).mtime.toISOString(), authScreens: fs.statSync(path.join(ROOT, "src/identity/AuthScreens.tsx")).mtime.toISOString() } }));

  const sourceFingerprint = RUN_ARTIFACTS.collectSourceFingerprint(ROOT, RUN_ARTIFACTS.d503SourceFiles(ROOT));
  const testedCommit = process.env.OPENARC_TESTED_COMMIT || gitText(["rev-parse", "HEAD"]);
  const out = {
    phase: "D5-03 第六批",
    title: "登录错误行不透明内容底真机渲染与对比度矩阵（含授权组织隔离批次的视觉复测）",
    runId: RUN.runId, runDir: RUN.runDirRel, startedAt: RUN.startedAt,
    testedCommit, openarcCommit: testedCommit, openarcBranch: gitText(["rev-parse", "--abbrev-ref", "HEAD"]),
    command: "node experiments/d5-03/auth-error-visual.mjs",
    scriptSha256: fileSha("experiments/d5-03/auth-error-visual.mjs"),
    specRefs: {
      DESIGN_SYSTEM: { versionLine: 3, textSecondary: 64, noHairline: 108, materialTable: "126-140", fontWeight: "153-154", secondaryType: 164, contrast: 248, compositeBackground: 251, dsA05: 270, dsA02: 267 },
      MOTION_SYSTEM: { versionLine: 3, instant: 21, reduced: 145, reducedAsScreenshotCondition: 177, msA07: 192 },
      PLAN: { sections: ["4", "42"], section4Line: 38, section42Line: 801 },
      gateRebase: { base: "d4a3516", oldCriterion: "!cssChanged（本批 diff 不含 .css）", newCriterion: "本批新增 transition/animation 声明数 = 0 且运行时 V7a 全绿", reason: "本批修复本身就是改 .auth-error 的 CSS，旧判据必然 FAIL（fail-closed 设计问题，非产品缺陷；与第五批 R3 同形）", proof: "experiments/d5-03/batch6-gate-rebase-proof.mjs" },
    },
    expectedTexts: EXPECT, internalDetails: INTERNAL_DETAILS,
    steps: STEPS, screenshots: SHOTS, contrast: CONTRAST,
    domScans: { light: domL, dark: domD, darkReducedSettings: domR, loginInvalid: domLogin, loginRateLimited: domRate },
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    matrix: NOT_VERIFIED_MATRIX,
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, productDefects: DEFECTS,
    appStderrs,
    sourceFingerprint, sourceFingerprintSetSha256: sourceFingerprint.setSha256,
    fingerprints: Object.fromEntries(Object.entries(sourceFingerprint.files).map(([f, v]) => [f, v.sha256_16])),
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version, cdpPort: apps[0] ? apps[0].cdpPort : null, cdpPortProbes: RUN.portProbes, userDataPrefix: USERDATA_PREFIX, runId: RUN.runId, userData: apps[0] ? path.basename(apps[0].userDataDir) : null },
    boundary: {
      thirdPartyServices: false, userDataSent: false, arbitraryLocalPrograms: false, pluginIsolationClaimed: false,
      databaseWritesByProbe: false, writesOnlyByProduct: true, newOrganizationEntryAdded: false,
      note: "主题与减少动态效果都用真实设置面板切换；重置走正式命令 identity/reset-installation（产品无该命令 UI 入口，§18/§20）；查询数据库只读；未连真实第三方、未发用户数据、未新增「创建组织」入口。",
    },
    at: new Date().toISOString(),
  };
  if (!contrastRows.length) notVerified("对比度量测", "三处测量都没有取到像素数据（元素缺失或截图失败）—— 见 checks 的 V6* 实际值。");
  OUT = out;
  out.exitCode = failed === 0 ? 0 : 1;
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  return failed === 0 ? 0 : 1;
}

/* ══════════════════════════ 收尾 ══════════════════════════ */
let hardExitCleanupStarted = false;
const onHardExit = (signal) => {
  if (hardExitCleanupStarted) return;
  hardExitCleanupStarted = true;
  void (async () => {
    console.error("收到 " + signal + "：按本次运行清单收尾");
    try { await cleanupOwnProcesses(); } catch (err) { console.error("硬退出收尾（进程）失败：" + String((err && err.message) || err)); }
    try { OWNERSHIP.cleanupOwnedDirs({ log: (line) => console.error("   " + line) }); } catch (err) { console.error("硬退出收尾（目录）失败：" + String((err && err.message) || err)); }
    process.exit(signal === "SIGINT" ? 130 : 143);
  })();
};
process.once("SIGINT", () => onHardExit("SIGINT"));
process.once("SIGTERM", () => onHardExit("SIGTERM"));

let exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("验收异常：" + String((e && e.stack) || e));
  record("Z0", "验收脚本无未捕获异常", false, "无异常", String((e && e.message) || e));
  exitCode = 2;
}
const cleanup = await cleanupOwnProcesses();
console.log("收尾：只清理本次运行 spawn 的 pid 树（" + JSON.stringify(cleanup.targets.map((t) => ({ label: t.label, rootPid: t.rootPid, leftovers: t.leftovers }))) + "），未使用 pkill");
cleanup.userDataDirsRemoved = OWNERSHIP.cleanupOwnedDirs({ log: (line) => console.log("   " + line) });
if (RUN) {
  try {
    const fallback = { phase: "D5-03 第五批", title: "登录失败文案视觉与动效（真机）", aborted: true, checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length }, notVerified: NOT_VERIFIED, observations: OBSERVATIONS, productDefects: DEFECTS, screenshots: SHOTS, contrast: CONTRAST };
    const fin = await RUN.finalize({ out: OUT || fallback, exitCode, logLines: LOG_LINES, cleanup });
    console.log("产物：" + fin.artifactPath + "（sha256 " + fin.artifactSha256.slice(0, 16) + "）+ " + fin.logPath);
  } catch (e) { console.error("产物写入失败：" + String((e && e.stack) || e)); }
}
process.exit(exitCode);
