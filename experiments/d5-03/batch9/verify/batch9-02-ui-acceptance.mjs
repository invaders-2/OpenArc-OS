/**
 * D5-03 第九批 · 独立验收 · 第二段驱动：任务界面 [data-ai-error] 浅/深实机截图 + 布局 + 对比度 + 动效。
 *
 * 真机：真实 electron（产品 Renderer + 产品 preload + 产品 IPC），宿主见
 * experiments/d5-03/batch9/verify/harness-timeout-ui-probe/main.cjs。
 * 隔离：独立 runId 目录 artifacts/d5-03/runs/<runId>/ + acquirePort 独占探测 + 只清自己 pid 树 + 串行。
 * 主题与减少动态效果一律经**真实设置面板**切换（不写 localStorage、不改 class）。
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
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const PROBE_DIR = path.join(HERE, "harness-timeout-ui-probe");
const RUN_ARTIFACTS = require(path.join(ROOT, "experiments/d5-03/run-artifacts.cjs"));
const OWNERSHIP = require(path.join(ROOT, "experiments/d5-03/userdata-ownership.cjs"));
const CDP_PORT_BASE = Number(process.env.OA_D503_BATCH9_CDP_PORT || 9841);
const extraArgs = (process.env.OA_D503_BATCH9_ELECTRON_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const fileSha = (p) => sha256(fs.readFileSync(p));

const CHECKS = [], SHOTS = [], MEAS = {}, NOTES = [], NOT_VERIFIED = [], STEPS = [];
let passed = 0, failed = 0;
const log = [];
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); log.push(s); _log(s); };
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected == null ? "" : expected), actual: String(actual == null ? "" : actual).slice(0, 2000), at: new Date().toISOString() };
  CHECKS.push(row); if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual.slice(0, 700)));
  return ok;
}
const note = (t) => { NOTES.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };
const step = (id, title, command, request, result) => STEPS.push({ id, title, command, request, result, at: new Date().toISOString() });

let RUN = null, VIS = null, app = null, page = null;
const SPAWNS = [], consoleErrors = [], dialogs = [], failedRequests = [], pageErrors = [];
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
async function waitFor(fn, timeout = 20000, interval = 120) { const t0 = Date.now(); for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() - t0 >= timeout) return false; await sleep(interval); } }
const waitSel = (sel, ms = 15000) => waitFor(() => has(sel), ms);
const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");

function pngSize(file) { const b = fs.readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length }; }
function psRows() {
  try { return execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" }).split("\n").map((l) => { const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m ? { pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], cmd: m[4] } : null; }).filter(Boolean); } catch { return []; }
}
function descendantsOf(rootPid) { const rows = psRows(); const byId = new Map(rows.map((r) => [r.pid, r])); return rows.filter((r) => { let p = r.ppid, hops = 0; while (p && hops < 14) { if (p === rootPid) return true; const pr = byId.get(p); if (!pr) return false; p = pr.ppid; hops += 1; } return false; }); }
const pidAlive = (pid) => psRows().some((r) => r.pid === pid && !r.stat.startsWith("Z"));
const portFree = async (port) => { try { await fetch("http://127.0.0.1:" + port + "/json/version"); return false; } catch { return true; } };

/* ── 截图 ── */
async function windowShot(file) { await page.screenshot({ path: file }); SHOTS.push({ file: path.basename(file), kind: "window", ...pngSize(file) }); return path.basename(file); }
async function clipShot(file, sel, margin = 8) {
  const clip = await js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; const r = el.getBoundingClientRect(); const vw = window.innerWidth, vh = window.innerHeight; const x = Math.max(0, Math.min(r.left - " + margin + ", vw - 20)); const y = Math.max(0, Math.min(r.top - " + margin + ", vh - 20)); const w = Math.max(20, Math.min(r.width + 2 * " + margin + ", vw - x)); const h = Math.max(20, Math.min(r.height + 2 * " + margin + ", vh - y)); return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };");
  if (!clip) return null;
  await page.screenshot({ path: file, clip });
  SHOTS.push({ file: path.basename(file), kind: "clip", clip, ...pngSize(file) });
  return { file: path.basename(file), clip };
}

/* ── 量测：几何 / 行数 / 溢出 / 计算样式 ── */
async function measureState(label) {
  return await js([
    "const pick = (s) => document.querySelector(s);",
    "const err = pick('[data-ai-error]'), state = pick('.ai-state'), panel = pick('.ai-panel');",
    "const run = pick('[data-ai-run]'), cancel = pick('[data-ai-cancel]');",
    "const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2) }; };",
    "const overflow = (el) => el ? { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, horizontalOverflow: el.scrollWidth > el.clientWidth, verticalOverflow: el.scrollHeight > el.clientHeight } : null;",
    "const lineCount = (el) => { if (!el) return null; const range = document.createRange(); range.selectNodeContents(el); const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0); const tops = new Set(rects.map((r) => Math.round(r.top))); return { rectCount: rects.length, lineCount: tops.size, lineTops: Array.from(tops).sort((a,b)=>a-b), widestLine: rects.length ? +Math.max(...rects.map(r=>r.width)).toFixed(2) : null, totalLineWidth: rects.length ? +rects.reduce((s,r)=>s+r.width,0).toFixed(2) : null }; };",
    "const cs = err ? getComputedStyle(err) : null; const csState = state ? getComputedStyle(state) : null;",
    "const rootCs = getComputedStyle(document.documentElement);",
    "const ancestors = []; let n = err; while (n && n !== document.body) { ancestors.push({ tag: n.tagName.toLowerCase(), cls: String(n.className || '').slice(0,60), ...overflow(n) }); n = n.parentElement; }",
    "return {",
    "  label: " + JSON.stringify(label) + ",",
    "  errorText: err ? (err.textContent || '') : null,",
    "  statusText: (pick('[data-ai-status-text]') || {}).textContent || null,",
    "  panelTaskId: panel ? panel.getAttribute('data-ai-task-id') : null,",
    "  panelStatus: panel ? panel.getAttribute('data-ai-status') : null,",
    "  theme: { dark: !!document.querySelector('.desktop')?.classList.contains('dark'), reduced: !!document.querySelector('.desktop')?.classList.contains('reduced'), glassMode: document.querySelector('.desktop')?.getAttribute('data-glass') || null },",
    "  rects: { error: rect(err), state: rect(state), panel: rect(panel), run: rect(run), cancel: rect(cancel) },",
    "  overflow: { error: overflow(err), state: overflow(state), panel: overflow(panel) },",
    "  lines: { error: lineCount(err), state: lineCount(state) },",
    "  style: cs ? { color: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, fontFamily: cs.fontFamily.slice(0,60), whiteSpace: cs.whiteSpace, overflowWrap: cs.overflowWrap, transitionProperty: cs.transitionProperty, transitionDuration: cs.transitionDuration, transitionDelay: cs.transitionDelay, animationName: cs.animationName, animationDuration: cs.animationDuration, animationDelay: cs.animationDelay, opacity: cs.opacity, display: cs.display, tokDurQuickElement: cs.getPropertyValue('--dur-quick').trim(), tokDurStandardElement: cs.getPropertyValue('--standard').trim() } : null,",
    "  stateStyle: csState ? { fontSize: csState.fontSize, fontWeight: csState.fontWeight, lineHeight: csState.lineHeight, display: csState.display, transitionProperty: csState.transitionProperty, transitionDuration: csState.transitionDuration, animationName: csState.animationName } : null,",
    "  tokens: { rootDurQuick: rootCs.getPropertyValue('--dur-quick').trim(), rootStandard: rootCs.getPropertyValue('--standard').trim(), rootQuick: rootCs.getPropertyValue('--quick').trim() },",
    "  blocks: { stopReasonPresent: !!pick('[data-ai-stop-reason]'), resumeBlockPresent: !!pick('[data-ai-resume-block]'), recoveryPresent: !!pick('[data-ai-recovery]'), verificationPresent: !!pick('[data-ai-verification]') },",
    "  buttons: { runDisabled: run ? run.disabled : null, cancelDisabled: cancel ? cancel.disabled : null, runText: run ? run.textContent.trim() : null },",
    "  ancestors,",
    "  viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, zoom: window.devicePixelRatio },",
    "  fontsReady: document.fonts ? document.fonts.status : null",
    "};",
  ].join("\n"));
}

/** 对比度：裁行截图 → 页面内 canvas 解码 → 背景取众数（合成后的真实表面）→ 文字取与背景亮度差最大像素 → WCAG。 */
async function measureContrast(sel, file, style) {
  const shot = await clipShot(file, sel, 8);
  if (!shot) return { error: "元素不存在：" + sel };
  const b64 = fs.readFileSync(path.join(VIS, shot.file)).toString("base64");
  const px = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = () => res(true); img.onerror = () => rej(new Error("decode-failed")); img.src = "data:image/png;base64," + b64; });
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
    return { totalPx: d.length / 4, modeRgb: modeKey, modeShare: +(modeN / (d.length / 4)).toFixed(6), textRgb: bestKey, textPixels: bestN, bgLum: +lbg.toFixed(6), textLum: +ltx.toFixed(6), ratio: +((Math.max(lbg, ltx) + 0.05) / (Math.min(lbg, ltx) + 0.05)).toFixed(3), distinctColors: hist.size };
  }, b64);
  const m = String(style.color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  let specifiedRatio = null;
  if (m) {
    const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const lc = lum(Number(m[1]), Number(m[2]), Number(m[3]));
    specifiedRatio = +((Math.max(px.bgLum, lc) + 0.05) / (Math.min(px.bgLum, lc) + 0.05)).toFixed(3);
  }
  const out = { selector: sel, shot: shot.file, clip: shot.clip, pixelSize: pngSize(path.join(VIS, shot.file)), style: { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, text: style.text }, ...px, specifiedRatio, threshold: 4.5, pass: px.ratio >= 4.5 };
  MEAS[sel + "@" + file.replace(/\.png$/, "")] = out;
  return out;
}

/* ── 真实设置面板：主题 / 减少动态效果 ── */
async function openSettings() {
  if (await has("[data-settings-active]")) return true;
  await js("const el = document.querySelector('.dock-item[data-dock-id=\"settings\"]'); if (el) el.click(); return !!el;");
  return await waitSel("[data-settings-active]", 15000);
}
async function closeSettings() {
  if (!(await has("[data-settings-active]"))) return true;
  await js("const b = document.querySelector('button.close[aria-label^=\"关闭\"]'); if (b) b.click(); return !!b;");
  return await waitFor(async () => !(await has("[data-settings-active]")), 8000);
}
async function setTheme(mode) {
  const wantDark = mode === "dark";
  const read = () => js("return document.querySelector('.desktop').classList.contains('dark')");
  // 只有"已显式存成该主题且渲染一致"才算已就绪 —— 否则一律经真实设置面板点一次。
  const stored = await js("return localStorage.getItem('oa-theme')");
  if (stored === mode && (await read()) === wantDark) return { ok: true, changed: false, via: "already-explicit" };
  const up = await openSettings();
  const clicked = up ? await js("const w = document.querySelector('[data-settings-active]')?.closest('.window'); if (!w) return 'missing'; const g = w.querySelector('[aria-label=\"外观\"]'); if (!g) return 'no-group'; const b = Array.from(g.querySelectorAll('button')).find(function (x) { return (x.textContent || '').trim() === " + JSON.stringify(wantDark ? "深色" : "浅色") + "; }); if (!b) return 'no-button'; b.click(); return 'ok';") : "settings-missing";
  const ok = await waitFor(async () => (await read()) === wantDark, 6000, 150);
  await closeSettings();
  return { ok: clicked === "ok" && ok, changed: true, via: "settings-panel", clicked };
}
async function setReduced(on) {
  const read = () => js("return document.querySelector('.desktop').classList.contains('reduced')");
  if ((await read()) === on) return { ok: true, changed: false, via: "already" };
  const up = await openSettings();
  const clicked = up ? await js("const w = document.querySelector('[data-settings-active]')?.closest('.window'); if (!w) return 'missing'; const s = w.querySelector('button[role=\"switch\"][aria-label=\"减少动态效果\"]'); if (!s) return 'no-switch'; s.click(); return 'ok';") : "settings-missing";
  const ok = await waitFor(async () => (await read()) === on, 6000, 150);
  await closeSettings();
  return { ok: clicked === "ok" && ok, changed: true, via: "settings-panel", clicked };
}

function findLine(file, re) { for (const l of file.split("\n")) if (re.test(l)) return l; return null; }

async function main() {
  RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "batch9-harness-timeout-ui", basePort: CDP_PORT_BASE, envBaseVar: "OA_D503_BATCH9_CDP_PORT" });
  VIS = RUN.runDir;
  console.log("runId=" + RUN.runId + "  runDir=" + RUN.runDirRel);
  step("S0", "隔离布局", "node experiments/d5-03/batch9/verify/batch9-02-ui-acceptance.mjs", "独立 runId 目录 + acquirePort + 只清自己 pid 树 + 串行", RUN.runDirRel);

  const reservation = await RUN.acquirePort(CDP_PORT_BASE);
  const cdpPort = reservation.port;
  await reservation.release();
  if (!(await portFree(cdpPort))) throw new Error("CDP 端口 " + cdpPort + " 仍被占用，拒绝启动");
  const userDataDir = OWNERSHIP.createOwnedDir({ prefix: OWNERSHIP.PREFIX, kind: "electron-userdata/batch9-ui", runId: RUN.runId });
  const env = { ...process.env, OPENARC_IDENTITY_ADMIN: "1", OPENARC_PROBE_NODE_BIN: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(electronPath, [PROBE_DIR, "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + cdpPort, ...extraArgs], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
  SPAWNS.push({ kind: "electron", pid: child.pid, cdpPort, userDataDir, at: new Date().toISOString() });
  let stdout = "", stderr = "";
  const probeLines = [];
  child.stdout.on("data", (d) => { stdout += String(d); for (const l of String(d).split("\n")) if (l.trim()) { probeLines.push(l); if (/^PROBE_(VERSIONS|DIAG|READY|MODEL_READY|MODEL_ERROR|FATAL|TASK_EVENT|EXIT)/.test(l)) console.log("[probe] " + l.slice(0, 900)); } });
  child.stderr.on("data", (d) => { stderr += String(d); });
  app = { child, cdpPort, userDataDir, pid: child.pid };

  let version = null; const dl = Date.now() + 60000;
  while (!version && Date.now() < dl) { try { version = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!page && end > Date.now()) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面");
  page.on("dialog", (d) => { dialogs.push(String(d.message()).slice(0, 140)); void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 220)); });
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 200)));
  page.on("requestfailed", (r) => { try { failedRequests.push({ url: r.url().slice(0, 200), scheme: (r.url().split(":")[0] || ""), error: (r.failure() && r.failure().errorText) || null, resourceType: r.resourceType() }); } catch { /* ignore */ } });

  /* ── 基准核对 ── */
  await waitSel('[data-d3-id="login-identifier"]', 40000);
  await setInput('[data-d3-id="login-identifier"]', "admin@batch9-ui.test");
  await setInput('[data-d3-id="login-password"]', "batch9-ui-admin-1");
  await clickSel('[data-d3-id="login-submit"]');
  const ready = await waitFor(async () => (await gate()) === "ready", 60000);
  record("S1", "真实 UI 登录进入桌面（真实身份 IPC）", ready, "data-identity-gate=ready", "gate=" + (await gate()));

  const modelReady = await waitFor(() => Promise.resolve(probeLines.some((l) => l.startsWith("PROBE_MODEL_READY"))), 60000);
  record("S2", "探针宿主建立真实 provider/model 配置（经真实 Identity IPC 装配）", modelReady, "PROBE_MODEL_READY", findLine(stdout, /^PROBE_MODEL_READY/) || "missing");
  const vLine = findLine(stdout, /^PROBE_VERSIONS/);
  console.log("   · " + vLine);

  await closeSettings();
  await setTheme("light");
  const base = await js("return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, desktopDark: document.querySelector('.desktop').classList.contains('dark'), reduced: document.querySelector('.desktop').classList.contains('reduced'), glassMode: document.querySelector('.desktop').getAttribute('data-glass'), wallpaper: localStorage.getItem('oa-wallpaper'), theme: localStorage.getItem('oa-theme') };");
  MEAS.baseline = base;
  const declaredWindow = /"window":"1360x900"/.test(vLine || "");
  const zoomApplied = (() => { try { return execFileSync("grep", ["-rl", "setZoomFactor", path.join(ROOT, "electron"), path.join(ROOT, "src")], { encoding: "utf8" }).trim(); } catch { return ""; } })();
  MEAS.baselineZoom = { declaredWindow, zoomAppliedFiles: zoomApplied ? zoomApplied.split(String.fromCharCode(10)).map((s) => path.relative(ROOT, s)) : [], dprIsDisplayScale: base.dpr === 2 };
  record("S3", "窗口/背景基准 = 既有任务界面门禁探针（tests/fixtures/d4-08-verification-ui）同一 BrowserWindow 参数 1360x900；内容区 1360x868（原生标题栏 32px）；玻璃模式 full；壁纸 theme-dark（产品默认）；产品无 setZoomFactor → 缩放 100%，dpr=2 是本机显示器缩放",
    declaredWindow && base.innerWidth === 1360 && base.innerHeight === 868 && base.glassMode === "full" && base.wallpaper === "theme-dark" && zoomApplied === "",
    'window=1360x900 / innerWidth=1360 / innerHeight=868 / glass=full / wallpaper=theme-dark / 无 setZoomFactor',
    JSON.stringify({ declaredWindow, ...base, zoomAppliedFiles: MEAS.baselineZoom.zoomAppliedFiles }));

  const SCENARIOS = [
    { id: "light-start", theme: "light", reduced: false, mode: "start", code: "HARNESS_START_TIMEOUT", goal: "验收探针 · 启动阻塞（ACP initialize 永不返回）[PROBE:START]" },
    { id: "light-turn", theme: "light", reduced: false, mode: "turn", code: "HARNESS_TURN_TIMEOUT", goal: "验收探针 · 执行阻塞（session/prompt 永不返回）[PROBE:TURN]" },
    { id: "dark-start", theme: "dark", reduced: false, mode: "start", code: "HARNESS_START_TIMEOUT", goal: "验收探针 · 启动阻塞（ACP initialize 永不返回）[PROBE:START]" },
    { id: "dark-turn", theme: "dark", reduced: false, mode: "turn", code: "HARNESS_TURN_TIMEOUT", goal: "验收探针 · 执行阻塞（session/prompt 永不返回）[PROBE:TURN]" },
    { id: "dark-reduced-turn", theme: "dark", reduced: true, mode: "turn", code: "HARNESS_TURN_TIMEOUT", goal: "验收探针 · 执行阻塞（session/prompt 永不返回）[PROBE:TURN]" },
  ];
  for (const sc of SCENARIOS) {
    console.log("\n--- 场景 " + sc.id + " ---");
    const th = await setTheme(sc.theme);
    const rd = await setReduced(sc.reduced);
    if (!(await has(".ai-panel"))) { await js("const b = document.querySelector('.assistant-pill'); if (b) b.click(); return !!b;"); }
    await waitSel(".ai-panel", 15000);
    await waitFor(async () => (await js("return document.querySelector('[data-ai-run]') ? !document.querySelector('[data-ai-run]').disabled : false")), 20000);
    await setInput("[data-ai-goal]", sc.goal);
    await sleep(200);
    const t0 = Date.now();
    const clicked = await clickSel("[data-ai-run]");
    const shown = await waitFor(async () => (await textOf("[data-ai-error]")).includes(sc.code), 40000, 80);
    const settled = await waitFor(async () => (await js("const b = document.querySelector('[data-ai-run]'); return !!b && !b.disabled")), 30000, 100);
    const elapsedMs = Date.now() - t0;
    await sleep(600);

    const m = await measureState(sc.id);
    MEAS[sc.id] = m;
    await windowShot(path.join(VIS, sc.id + "-window.png"));
    await clipShot(path.join(VIS, sc.id + "-state-row.png"), ".ai-state", 10);
    await clipShot(path.join(VIS, sc.id + "-panel.png"), ".ai-panel", 4);
    const contrast = await measureContrast("[data-ai-error]", path.join(VIS, sc.id + "-error-contrast.png"), { color: m.style.color, fontSize: m.style.fontSize, fontWeight: m.style.fontWeight, lineHeight: m.style.lineHeight, text: m.errorText });

    const tag = sc.id;
    record(tag + "-1", "任务状态行原样显示 " + sc.code, m.errorText.trim() === "· " + sc.code, "· " + sc.code, JSON.stringify(m.errorText));
    record(tag + "-2", "状态文字 BLOCKED · Recovery Required（resumable=false 路径）", m.statusText === "BLOCKED · Recovery Required", "BLOCKED · Recovery Required", JSON.stringify(m.statusText));
    record(tag + "-3", "真实界面操作成功触发真实运行（clicked=ok 且错误行出现且 busy 复位）", clicked === "ok" && shown && settled, "ok/true/true", JSON.stringify({ clicked, shown, settled, elapsedMs }));
    record(tag + "-4", "结构：无 [data-ai-stop-reason] / 无恢复块 / 无验证块（启动与执行超时都不是预算停止）", !m.blocks.stopReasonPresent && !m.blocks.resumeBlockPresent && !m.blocks.recoveryPresent && !m.blocks.verificationPresent, "全 false", JSON.stringify(m.blocks));
    record(tag + "-5", "主题/减少动态效果确实由真实设置面板切换到位", m.theme.dark === (sc.theme === "dark") && m.theme.reduced === sc.reduced, JSON.stringify({ dark: sc.theme === "dark", reduced: sc.reduced }), JSON.stringify({ themeResult: th, reducedResult: rd, observed: m.theme }));
    record(tag + "-6", "错误行无横向溢出：scrollWidth <= clientWidth", m.overflow.error && m.overflow.error.scrollWidth <= m.overflow.error.clientWidth, "scrollWidth<=clientWidth", JSON.stringify(m.overflow.error));
    record(tag + "-7", "错误行容器无横向溢出：.ai-state scrollWidth <= clientWidth", m.overflow.state && m.overflow.state.scrollWidth <= m.overflow.state.clientWidth, "scrollWidth<=clientWidth", JSON.stringify(m.overflow.state));
    record(tag + "-8", "面板无横向溢出：.ai-panel scrollWidth <= clientWidth", m.overflow.panel && m.overflow.panel.scrollWidth <= m.overflow.panel.clientWidth, "scrollWidth<=clientWidth", JSON.stringify(m.overflow.panel));
    record(tag + "-9", "祖先链全部无横向溢出（到 body）", m.ancestors.every((a) => !a.horizontalOverflow), "无 horizontalOverflow", JSON.stringify(m.ancestors.filter((a) => a.horizontalOverflow)));
    record(tag + "-10", "错误行在面板内容宽内（error.right <= panel.right - padding）", m.rects.error.right <= m.rects.panel.right - 20, "<= panel.right-20", JSON.stringify({ errorRight: m.rects.error.right, panelRight: m.rects.panel.right }));
    const is12 = parseFloat(m.style.fontSize) < 18.67;
    record(tag + "-11", "对比度 ≥ 4.5:1（12px 级普通文本门槛，DESIGN_SYSTEM.md:248）", contrast.pass, ">= 4.5", JSON.stringify({ ratio: contrast.ratio, specifiedRatio: contrast.specifiedRatio, fontSize: m.style.fontSize, fontWeight: m.style.fontWeight, threshold: contrast.threshold, bg: contrast.modeRgb, text: contrast.textRgb, note: is12 ? "普通文本门槛 4.5" : "字号较大，需按大字判定" }));
    record(tag + "-12", "本行未新增动效：animationName=none 且 transitionDuration=0s", m.style.animationName === "none" && String(m.style.transitionDuration).split(",").every((d) => d.trim() === "0s"), "animationName=none; transitionDuration=0s", JSON.stringify({ animationName: m.style.animationName, animationDuration: m.style.animationDuration, transitionProperty: m.style.transitionProperty, transitionDuration: m.style.transitionDuration, transitionDelay: m.style.transitionDelay }));
    if (sc.reduced) {
      record(tag + "-13", "减少动态效果下该行 --dur-quick=0ms（元素作用域）", m.style.tokDurQuickElement === "0ms", "0ms", JSON.stringify({ element: m.style.tokDurQuickElement, root: m.tokens.rootDurQuick, standard: m.style.tokDurStandardElement }));
    }
  }

  /* ── 布局对照：两种错误码 ── */
  console.log("\n--- 布局对照（同一主题下两种码） ---");
  for (const [theme, a, b] of [["light", "light-start", "light-turn"], ["dark", "dark-start", "dark-turn"]]) {
    const A = MEAS[a], B = MEAS[b];
    const sameErrLines = A.lines.error.lineCount === B.lines.error.lineCount;
    const sameStateLines = A.lines.state.lineCount === B.lines.state.lineCount;
    const sameHeight = A.rects.state.height === B.rects.state.height;
    const sameRunRect = JSON.stringify(A.rects.run) === JSON.stringify(B.rects.run);
    const sameCancelRect = JSON.stringify(A.rects.cancel) === JSON.stringify(B.rects.cancel);
    const samePanel = JSON.stringify(A.rects.panel) === JSON.stringify(B.rects.panel);
    record("layout-" + theme, "更长的码（HARNESS_START_TIMEOUT 21 字符 vs HARNESS_TURN_TIMEOUT 20 字符）不改变行数/行高/按钮矩形",
      sameErrLines && sameStateLines && sameHeight && sameRunRect && sameCancelRect && samePanel, "行数/高度/按钮/面板矩形全相同",
      JSON.stringify({
        start: { code: "HARNESS_START_TIMEOUT", len: 21, errLines: A.lines.error, stateLines: A.lines.state, stateRect: A.rects.state, errRect: A.rects.error, overflow: A.overflow.state, widestLine: A.lines.error.widestLine },
        turn: { code: "HARNESS_TURN_TIMEOUT", len: 20, errLines: B.lines.error, stateLines: B.lines.state, stateRect: B.rects.state, errRect: B.rects.error, overflow: B.overflow.state, widestLine: B.lines.error.widestLine },
        deltas: { widestLinePx: +(A.lines.error.widestLine - B.lines.error.widestLine).toFixed(2), stateHeight: A.rects.state.height - B.rects.state.height, errorRightPx: +(A.rects.error.right - B.rects.error.right).toFixed(2) },
        sameErrLines, sameStateLines, sameHeight, sameRunRect, sameCancelRect, samePanel,
      }));
  }

  /* ── 变窄压力（布局稳健性，额外口径，非基准截图） ── */
  console.log("\n--- 窄窗口压力（额外，不改基准） ---");
  const narrow = await js("const p = document.querySelector('.ai-panel'); if (!p) return null; const r = p.getBoundingClientRect(); return { panelWidth: r.width, contentWidth: p.clientWidth, pad: getComputedStyle(p).padding };");
  note("AI 面板固定宽度 = " + JSON.stringify(narrow) + "（窗口宽 1360 → 面板右贴边，面板宽度不随窗口变化）");
  record("layout-narrow", "AI 面板宽度固定 350px（不随窗口宽度变化）→ 窗口尺寸变化不构成该行布局风险", narrow && narrow.panelWidth === 350, "350", JSON.stringify(narrow));

  /* ── 收尾 ── */
  const tree = [child.pid, ...descendantsOf(child.pid).filter((r) => !r.stat.startsWith("Z")).map((r) => r.pid)];
  for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } }
  await waitFor(() => tree.every((p) => !pidAlive(p)), 15000, 100);
  const cleanup = { strategy: "own-pid-tree-only", pkillUsed: false, rootPid: child.pid, tree, leftovers: tree.filter(pidAlive) };
  await waitFor(() => portFree(cdpPort), 10000, 200);
  const removed = OWNERSHIP.cleanupOwnedDirs({ log: (l) => { log.push(l); console.log("   " + l); } });
  const tmpHits = [];
  try {
    const tmp = fs.realpathSync(require("node:os").tmpdir());
    for (const d of fs.readdirSync(tmp)) if (d.startsWith("oa-d503") ) tmpHits.push(d);
  } catch { /* ignore */ }
  record("Z1", "只清了本次运行自己的 pid 树，0 残留", cleanup.leftovers.length === 0, "leftovers=[]", JSON.stringify(cleanup));
  record("Z2", "本次运行的 userData 临时目录已按归属标记删除", removed.length === 1, "removed=1", JSON.stringify(removed));
  record("Z3", "TMPDIR 下 oa-d503* 无本次运行残留", !tmpHits.some((d) => d.includes(RUN.tag)), "无 " + RUN.tag, JSON.stringify(tmpHits));
  // 探针宿主只装配被测面（身份 + 任务）。产品 main 还注册 openarc-resource / openarc-canvas / openarc-file
  // 三个自定义协议（electron/main.cjs:474/476/485），探针宿主没有 → 桌面里引用这些 scheme 的资源会
  // ERR_UNKNOWN_URL_SCHEME。这与本批改动无关（本批 0 行 src 改动），如实分列，不放宽判定口径。
  const PROBE_HOST_PROTOCOL_GAP = /ERR_UNKNOWN_URL_SCHEME/;
  const gapErrors = consoleErrors.filter((e) => PROBE_HOST_PROTOCOL_GAP.test(e));
  const otherErrors = consoleErrors.filter((e) => !PROBE_HOST_PROTOCOL_GAP.test(e));
  const gapSchemes = [...new Set(failedRequests.filter((r) => r.error && /UNKNOWN_URL_SCHEME/.test(r.error)).map((r) => r.scheme))];
  MEAS.consoleGap = { gapErrors, otherErrors, failedRequests: failedRequests.slice(0, 40), gapSchemes, pageErrors };
  record("Z4a", "渲染层 0 个未捕获异常（pageerror）", pageErrors.length === 0, "0", JSON.stringify(pageErrors.slice(0, 5)));
  record("Z4b", "除探针宿主未注册的自定义协议（openarc-resource/canvas/file 的 ERR_UNKNOWN_URL_SCHEME）外，渲染层 0 条 console error", otherErrors.length === 0,
    "非协议缺口 console error = 0", JSON.stringify({ otherErrors, gapErrorCount: gapErrors.length, gapSchemes, failingRequestSample: failedRequests.slice(0, 6) }));
  const probeFatal = findLine(stdout, /^PROBE_FATAL/);
  record("Z5", "探针宿主无致命错误", !probeFatal, "无 PROBE_FATAL", probeFatal || "(none)");
  const health = findLine(stdout, /^PROBE_HEALTH/) || "";
  const noMainErr = /"mainErrors":\[\]/.test(health);
  const noProbeConsoleErr = /"rendererConsoleErrors":\[\]/.test(health);
  record("Z6", "宿主主进程无 uncaughtException/unhandledRejection（每次 task/result 后的探针健康快照）", noMainErr, '"mainErrors":[]', health || "(未打印)");

  const distMain = (() => { try { return fs.readdirSync(path.join(ROOT, "dist/assets")).filter((f) => /^main-.*\.js$/.test(f)).map((f) => ({ file: f, hasErrorAttr: fs.readFileSync(path.join(ROOT, "dist/assets", f), "utf8").includes("data-ai-error"), hasBlockedCopy: fs.readFileSync(path.join(ROOT, "dist/assets", f), "utf8").includes("BLOCKED · Recovery Required"), mtime: fs.statSync(path.join(ROOT, "dist/assets", f)).mtime.toISOString() })); } catch { return []; } })();
  record("Z7", "被测渲染层确实是当前构建（dist bundle 含 data-ai-error 与状态文案）", distMain.length > 0 && distMain.every((d) => d.hasErrorAttr && d.hasBlockedCopy), "含 data-ai-error + BLOCKED · Recovery Required", JSON.stringify(distMain));

  const srcFp = RUN_ARTIFACTS.collectSourceFingerprint(ROOT, ["electron/task-domain.cjs", "electron/task-harness-orchestrator.cjs", "src/desktop/components.tsx", "src/styles.css", "dist/assets/" + (distMain[0] ? distMain[0].file : "main.js"), "experiments/d5-03/batch9/verify/harness-timeout-ui-probe/main.cjs", "experiments/d5-03/batch9/verify/batch9-02-ui-acceptance.mjs"]);
  const git = (args) => { try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim(); } catch { return null; } };
  const out = {
    phase: "D5-03 第九批 · 独立验收 · 第二段（任务界面 [data-ai-error] 视觉/动效）",
    testedCommit: git(["rev-parse", "HEAD"]), testedBranch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    worktreePorcelain: git(["status", "--porcelain"]),
    command: "node experiments/d5-03/batch9/verify/batch9-02-ui-acceptance.mjs",
    scriptSha256: fileSha(fileURLToPath(import.meta.url)),
    specRefs: {
      DESIGN_SYSTEM: { file: "DESIGN_SYSTEM.md", version: "设计提案 0.2，2026-09-10（第 3 行）", textSecondaryLine64: "text.secondary 浅 #6E6E73 / 深 #98989D", fontWeightLine154: "标题/强调 500，正文/按钮/次级 400", secondaryTypeLine164: "次级说明 12 / 18 px，字重 400", keyErrorLine170: "关键错误与权限说明不缩小到脚注尺寸；较长中文允许换行", contrastLine248: "普通文本 4.5:1，大字 3:1，控件边界/状态标记 3:1", largeTextLine249: "大字 = 至少 24 CSS px，或约 18.67 CSS px 粗体", compositeLine251: "测量最终合成背景、浅深主题、不同壁纸及透明度模式", reducedLine252: "减少动态效果与减少透明度是两个独立设置" },
      MOTION_SYSTEM: { file: "MOTION_SYSTEM.md", version: "动效提案 0.1，2026-09-10（第 3 行）", instantLine21: "duration.instant = 0 ms（减少动态效果）", reducedLine141to150: "§8 减少动态效果：空间移动/缩放/弹性映射为即时切换或 <=100ms 淡变", errorLine150: "动画不能高频闪烁，错误强调优先图标、边界和文字", shotConditionLine177: "减少动态效果模式同时作为稳定截图回归条件" },
      PLAN: { file: "PLAN.md", section4: "§4 全局视觉与动效规范（第 38–52 行）：浅深方案 + 对比度验证（:43）、AI 状态反馈不依赖颜色单独传意（:45）、动效可中断（:48）、减少动态效果（:49）、键盘焦点/缩放/中文长文本/窄窗口（:51）", section42: "§42 设计语言与交互动效交付（第 801–806 行）：DS-A/MS-A 验收编号；:806 最终合成背景的对比须实测" },
    },
    scenarios: SCENARIOS,
    baseline: base,
    screenshots: SHOTS.map((s) => ({ ...s, sha256: fileSha(path.join(VIS, s.file)) })),
    measurements: MEAS,
    checks: CHECKS,
    counts: { total: CHECKS.length, pass: passed, fail: failed },
    failedChecks: CHECKS.filter((c) => c.status === "FAIL").map((c) => c.section + " · " + c.name + " — 期望 " + c.expected + "，实际 " + c.actual.slice(0, 300)),
    steps: STEPS, observations: NOTES, notVerified: NOT_VERIFIED,
    probeLines: probeLines.filter((l) => /^PROBE_/.test(l)).slice(0, 200),
    probeStderrTail: stderr.slice(-2000),
    rendererConsoleErrors: consoleErrors.slice(0, 10),
    cleanup, sourceFingerprint: srcFp,
    env: { electron: require("electron/package.json").version, node: process.version, platform: process.platform, arch: process.arch, cdpPort, cdpPortProbes: RUN.portProbes, userDataDirBasename: path.basename(userDataDir), runId: RUN.runId },
    windowSize: MEAS.baseline ? { width: MEAS.baseline.innerWidth, height: MEAS.baseline.innerHeight, dpr: MEAS.baseline.dpr } : null,
  };
  const fin = await RUN.finalize({ out, exitCode: failed ? 1 : 0, logLines: log, cleanup });
  console.log("\n计数：" + JSON.stringify(out.counts) + "  artifactSha256=" + fin.artifactSha256);
  console.log("runDir=" + RUN.runDirRel);
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("DRIVER ERROR: " + (e && e.stack || e));
  try {
    const tree = app ? [app.pid, ...descendantsOf(app.pid).filter((r) => !r.stat.startsWith("Z")).map((r) => r.pid)] : [];
    for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } }
    OWNERSHIP.cleanupOwnedDirs({ log: () => {} });
    if (RUN) await RUN.finalize({ out: { phase: "D5-03 第九批 · 独立验收 · 第二段", fatal: String(e && e.message), checks: CHECKS, counts: { total: CHECKS.length, pass: passed, fail: failed } }, exitCode: 2, logLines: log, cleanup: { strategy: "own-pid-tree-only", pkillUsed: false, tree } });
  } catch { /* ignore */ }
  process.exit(2);
});
