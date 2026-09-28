/**
 * D5-03 第四批 · 会话**自然到期**（空闲 / 绝对）→ MCP 收流 真机验收。
 *
 * 真机 = 真实 electron . + 隔离 userData（本次运行自建、带归属标记）+ 本次运行独占 CDP 端口。
 *
 * 被测能力（第四批未提交改动）：
 *   · electron/identity-service.cjs：身份服务层**权威到期调度** —— 单一定时器、按持久层
 *     min(expires_at, idle_expires_at) 排程、到点重读权威行过四道门（旧代次 / 已被其它路径终结 /
 *     未到期只重排 / 真过期才终结+emit）；无 setInterval；懒判定与定时器共用 domain.sessionExpiry()。
 *   · electron/identity-store.cjs：expireSession(ref) 幂等落权威终态（REVOKE_REASON.EXPIRED）。
 *   · 新事件 identity/session-expired（reason: "idle"|"absolute"）→ MCP dispose
 *     （不改写 enabled；DISABLED + MCP_SESSION_ENDED；连接日志 detail = expired:idle / expired:absolute）。
 *   · 渲染层已订阅该事件 → 与登出同一条收敛（清投影 + 未认证 + 登录页文案）。
 *   · 短有效期双重开关：OPENARC_ALLOW_SESSION_TTL_OVERRIDE=1 且值为 >=2000 的十进制整数才生效，
 *     生效时主进程日志留痕；不给 ack 一律沿用默认（12h 绝对 / 2h 空闲）。
 *
 * 场景（每次调用只跑一个，--scenario=...；每个场景一个独立 runId 产物目录）：
 *   idle           场景1（空闲自然到期收流 + 界面收敛 + 0 投影 + 4s 无自动重连）+ 场景6（无高频轮询自证）
 *                  + 场景7b（ack + 合法值 → 日志有"默认值 → 生效值"）+ 视觉/对比度/动效
 *   extend         场景2（合法活动把 idle_expires_at 往后推；越过原到期点不误关；最后一次活动 + idle 才到期）
 *   absolute       场景3（idle 远大于观察窗，每 ~2s 合法活动 → 仍因绝对到期收流，detail=expired:absolute）
 *   relogin        场景4（旧会话到期不关随后登录的新会话）
 *   regress        场景5（登出 / 锁屏 / 撤权仍按第三批口径收流，detail 仍是 logout / user / app-grant-revoked）
 *   override-deny  场景7a（给了 TTL 值但不给 ack → 忽略，只读 DB 证明仍是默认 12h / 2h）
 *
 * 纪律（与前三批一致，判定只新增）：
 *   · 只新增本脚本与产物；不改产品代码、不改既有门禁脚本判定；不 commit / 不 push / 不切分支。
 *   · 连接全部走真实产品入口（界面表单 + window.openarc.mcp.command / governance.command），**绝不直接改库**；
 *     DB 只做只读取证（DatabaseSync readOnly）。
 *   · 只连自建受控 fixture（tests/fixtures/mcp/echo-server.mjs，只监听 127.0.0.1）；不接第三方、不发用户数据、
 *     不运行任意第三方本地程序、不声称插件隔离通过（写进 evidence.boundary）。
 *   · 收尾只清本次运行自己 spawn 的 pid 树 + 自己建并带归属标记的临时 userData 目录，绝不 pkill 通配。
 */
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RUN_ARTIFACTS = require(path.join(here, "run-artifacts.cjs"));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "mcp", "echo-server.mjs");
const domain = require(path.join(ROOT, "electron", "mcp-domain.cjs"));
const identityDomain = require(path.join(ROOT, "electron", "identity-domain.cjs"));
const identityStoreModule = require(path.join(ROOT, "electron", "identity-store.cjs"));
const identityBootstrap = require(path.join(ROOT, "electron", "identity-bootstrap.cjs"));

const SCRIPT_NAME = "mcp-expiry-e2e";
const USERDATA_PREFIX_BASE = "oa-d503b-";
const MARKER = "owner.json";
const CDP_PORT_BASE = Number(process.env.OA_D503_EXPIRY_CDP_PORT || 9861);
const ADMIN = { id: "admin@d503-expiry.test", pw: "mcp-expiry-1" };
const extraArgs = (process.env.OA_D503_ELECTRON_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 到期"有界窗口"：定时器到点 → 落库 → 事件送达渲染层，全链上界（实测值另记，不写"约"）。 */
const EXPIRY_BOUND_MS = Number(process.env.OA_D503_EXPIRY_BOUND_MS || 2000);
/** 参考基准（第一批浅/深截图），用于证明本次窗口尺寸 / 缩放与基准可比。 */
const BASELINE_VISUAL_DIR = path.join(ROOT, "artifacts", "d5-03", "runs", "20260928T015121Z-8f32-mcp-center-e2e", "visual");
/** 设计规范（版本与行号在报告里如实写出）。 */
const SPEC = Object.freeze({
  design: "DESIGN_SYSTEM.md · 版本：设计提案 0.2，2026-09-10（第 3 行）",
  designLines: { textSecondary: 64, captionFont: 164, contrastGate: 248 },
  motion: "MOTION_SYSTEM.md · 版本：动效提案 0.1，2026-09-10（第 3 行）",
  plan: "PLAN.md §4（第 38-52 行）/ §42（第 801-806 行），更新日期 2026-09-10（第 3 行）",
});
/** 按字号/字重判定 WCAG 门槛：>=24px，或 >=18.66px 且 bold(>=700)。 */
const contrastThreshold = (fontSizePx, fontWeight) => (fontSizePx >= 24 || (fontSizePx >= 18.66 && Number(fontWeight) >= 700) ? 3 : 4.5);

const SCENARIOS = Object.freeze({
  idle: { ack: true, idleMs: 8000, ttlMs: 120000, title: "空闲自然到期收流 + 界面收敛 + 0 投影 + 视觉/动效/开关自证" },
  extend: { ack: true, idleMs: 8000, ttlMs: 120000, title: "合法活动延长空闲期限、旧安排不误关" },
  absolute: { ack: true, idleMs: 60000, ttlMs: 10000, title: "绝对到期（空闲永不到期）" },
  relogin: { ack: true, idleMs: 8000, ttlMs: 120000, title: "旧会话到期不关随后登录的新会话" },
  regress: { ack: false, idleMs: null, ttlMs: null, title: "既有路径回归：登出 / 锁屏 / 撤权（默认有效期）" },
  "override-deny": { ack: false, idleMs: 8000, ttlMs: 60000, title: "开关自证 (a)：不给 ack → 忽略且仍是默认有效期" },
});
const argOf = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const SCENARIO = argOf("scenario", "idle");
const CFG = SCENARIOS[SCENARIO];
if (!CFG) {
  console.error("未知场景：" + SCENARIO + "；可选 " + Object.keys(SCENARIOS).join(" / "));
  process.exit(2);
}

/* ══════════════════════════ 记录 / 日志 ══════════════════════════ */
const CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [], LOG_LINES = [], DEFECTS = [], MEASURES = {};
const DB_SNAPSHOTS = {}, UI_TEXTS = {};
let passed = 0, failed = 0;
const defect = (id, title, where, repro, fix) => { const d = { id, title, where, repro, fix }; DEFECTS.push(d); console.log("   ! [DEFECT] " + id + " · " + title + " @ " + where + "\n      复现：" + repro + "\n      最小修法（建议，未动手）：" + fix); return d; };
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG_LINES.push(s); _log(s); };
const _err = console.error.bind(console);
console.error = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG_LINES.push("[stderr] " + s); _err(s); };
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 3600), at: new Date().toISOString() };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual.slice(0, 900)));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };
const measure = (k, v) => { MEASURES[k] = v; return v; };

/* ══════════════════════════ 通用 ══════════════════════════ */
async function waitFor(fn, timeout = 20000, intervalMs = 120) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch { /* retry */ }
    if (Date.now() - t0 >= timeout) return false;
    await sleep(intervalMs);
  }
}
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
/* WCAG 2.x 相对亮度与对比度（与 experiments/d2-01/lib/ds.mjs 同式，脚本内自算 + 交叉核对）。 */
const parseRgb = (v) => {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) return m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number);
  const h = s.match(/^#([0-9a-f]{6})$/i);
  if (h) return [parseInt(h[1].slice(0, 2), 16), parseInt(h[1].slice(2, 4), 16), parseInt(h[1].slice(4, 6), 16)];
  return null;
};
const relLum = (rgb) => {
  const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
function contrastRatio(fg, bg) {
  const a = Array.isArray(fg) ? fg : parseRgb(fg);
  const b = Array.isArray(bg) ? bg : parseRgb(bg);
  if (!a || !b) return null;
  const l1 = relLum(a), l2 = relLum(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });
const sha16 = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
const isZeroDur = (v) => String(v == null ? "" : v).split(",").every((s) => /^0m?s$/.test(s.trim()));

/* ══════════════════════════ 状态 ══════════════════════════ */
let child = null, browser = null, page = null, userDataDir = null;
let stdoutBuf = "", stderrBuf = "";
const dialogs = [], consoleErrors = [], fixtures = [], fixtureRows = [], SPAWNS = [];
let RUN = null, RESERVED_PORT = null, VIS = null, OUT = null, CLEANUP = null;
let CDP_PORT = CDP_PORT_BASE, USERDATA_PREFIX = USERDATA_PREFIX_BASE;
const OWNED_DIRS = [];
const dbPath = () => path.join(userDataDir, "identity.db");

/* ══════════════════════════ 页面 DOM 助手（与第三批同一套 UI 驱动方式） ══════════════════════════ */
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
const attrOf = (sel, name) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.getAttribute(" + JSON.stringify(name) + ") || '') : '';");
const waitSel = (sel, ms = 15000) => waitFor(() => has(sel), ms);
const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const setSelect = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const mcpCmd = (command, payload) => js("return await window.openarc.mcp.command(" + JSON.stringify({ command, payload }) + ")");
const identityCmd = (type) => js("return await window.openarc.identity.command(" + JSON.stringify({ type }) + ")");
const governance = (payload) => js("return await window.openarc.governance.command(" + JSON.stringify(payload) + ")");
const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const clipOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; const r = el.getBoundingClientRect(); const vw = window.innerWidth, vh = window.innerHeight; const x = Math.max(0, Math.min(r.left, vw - 20)); const y = Math.max(0, Math.min(r.top, vh - 20)); const w = Math.max(20, Math.min(r.width, vw - x)); const h = Math.max(20, Math.min(r.height, vh - y)); return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };");
async function shotTo(file, sel = '[aria-label="MCP 中心窗口"]') {
  try {
    const clip = await clipOf(sel);
    const buf = clip ? await page.screenshot({ path: file, clip }) : await page.screenshot({ path: file });
    return { file: path.basename(file), clip, ...pngSize(buf), bytes: buf.length, sha256_16: sha16(buf) };
  } catch (e) { return { file: path.basename(file), error: String((e && e.message) || e).slice(0, 200) }; }
}
async function viewportInfo() {
  return await js([
    "const d = document.querySelector('.desktop');",
    "const ls = {}; for (const k of ['oa-theme','oa-dark','oa-motion','oa-glass','oa-opaque','oa-wallpaper','oa-lock-wallpaper','oa-wallpaper-style','oa-dock-size']) ls[k] = localStorage.getItem(k);",
    "return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, desktopClasses: d ? Array.from(d.classList) : null, localStorage: ls, desktopOpacity: d ? getComputedStyle(d).opacity : null };",
  ].join("\n"));
}

/* ══════════════════════════ 身份（三步向导 + 登录 / 登出 / 锁屏） ══════════════════════════ */
async function login(identifier, pw) {
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', pw);
  await clickSel('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}
async function logout() {
  const clicked = await clickSel('[data-d3-id="topbar-logout"]');
  const out = await waitFor(async () => (await gate()) !== "ready", 30000);
  return clicked === "ok" && out;
}
async function lockScreen() {
  const clicked = await clickSel('[data-d3-id="topbar-lock"]');
  const out = await waitFor(async () => (await gate()) === "locked", 30000);
  return clicked === "ok" && out;
}
async function unlockScreen() {
  await waitSel('[data-d3-id="unlock-password"]', 15000);
  await setInput('[data-d3-id="unlock-password"]', ADMIN.pw);
  await clickSel('[data-d3-id="unlock-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 30000);
}
async function setupAndLogin() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  let initialized = false;
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const setupNext = async () => {
      await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000);
      await clickSel('[data-d3-id="setup-next"]');
    };
    await setInput('[data-d3-id="setup-name"]', "D5-03 Expiry Admin");
    await setupNext();
    await waitSel('[data-d3-id="setup-identifier"]', 10000);
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await setupNext();
    await waitSel('[data-d3-id="setup-password"]', 10000);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000);
    await clickSel('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
    initialized = true;
  }
  const ok = await login(ADMIN.id, ADMIN.pw);
  return { ok, initialized };
}

/* ══════════════════════════ MCP 窗口 / UI 投影 ══════════════════════════ */
async function openMcpWindow() {
  const clicked = await js("const el = document.querySelector('.dock-item[data-dock-id=\"mcp-center\"]'); if (el) el.click(); return !!el;");
  const up = await waitSel("[data-mcp-center]", 20000);
  await js("const el = document.querySelector('[aria-label=\"MCP 中心窗口\"]'); if (el && el.classList.contains('minimized')) { const d = document.querySelector('.dock-item[data-dock-id=\"mcp-center\"]'); if (d) d.click(); } return true;");
  await sleep(250);
  return clicked === true && up;
}
async function rightClickDockItem(appId) {
  const sel = '.dock-item[data-dock-id="' + appId + '"]';
  const menuSel = '[aria-label="程序坞菜单"]';
  if (!(await has(sel))) return false;
  try {
    await page.locator(sel).click({ button: "right", timeout: 3000 });
    if (await waitFor(() => has(menuSel), 2000, 100)) return true;
  } catch { /* 原生右键不可达 → 事件派发 */ }
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
  return sent === true && (await waitFor(() => has(menuSel), 5000, 150));
}
async function closeMcpWindow() {
  if (!(await has('[aria-label="MCP 中心窗口"]'))) return true;
  if (!(await rightClickDockItem("mcp-center"))) return false;
  const clicked = await waitFor(() => js(
    "const menu = document.querySelector('.context-menu.dock-menu[aria-label=\"程序坞菜单\"]'); if (!menu) return false;" +
    "const item = Array.from(menu.querySelectorAll('button[role=\"menuitem\"]')).find(function (b) { return b.textContent.trim() === '关闭应用'; });" +
    "if (!item || item.disabled) return false; item.click(); return true;",
  ), 8000, 150);
  if (!clicked) return false;
  return await waitFor(async () => !(await has('[aria-label="MCP 中心窗口"]')), 12000, 150);
}
async function reopenMcpWindow() {
  const closed = await closeMcpWindow();
  if (closed) return await openMcpWindow();
  await page.reload().catch(() => {});
  const back = await waitFor(async () => { const g = await gate(); return g === "ready" || g === "unauthenticated"; }, 40000, 300);
  if ((await gate()) === "unauthenticated") await login(ADMIN.id, ADMIN.pw);
  return back && (await openMcpWindow());
}
async function detailSnapshot() {
  return await js([
    "const norm = function (s) { return String(s || '').replace(/\\s+/g, ' ').trim(); };",
    "const t = function (sel) { return norm(document.querySelector(sel)?.textContent); };",
    "return {",
    "  state: document.querySelector('[data-mcp-detail-state]')?.getAttribute('data-mcp-detail-state') || null,",
    "  name: t('[data-mcp-detail-name]'), status: t('[data-mcp-status-text]'), lastError: t('[data-mcp-last-error]'),",
    "  protocolVersion: t('[data-mcp-protocol-version]'), serverName: t('[data-mcp-server-name]'), serverVersion: t('[data-mcp-server-version]'), toolsHash: t('[data-mcp-tools-hash]'),",
    "  enabled: t('[data-mcp-config-enabled]'),",
    "  tools: Array.from(document.querySelectorAll('[data-mcp-tool]')).map(function (tr) { return { name: tr.getAttribute('data-mcp-tool'), description: norm(tr.children[1]?.textContent), schema: norm(tr.children[2]?.textContent) }; }),",
    "  toolsHidden: !!document.querySelector('[data-mcp-tools-hidden]'),",
    "  sessionEndedNote: !!document.querySelector('[data-mcp-note=\"session-ended\"]'),",
    "  sessionEndedText: t('[data-mcp-note=\"session-ended\"]'),",
    "  noteCount: document.querySelectorAll('[data-mcp-note]').length,",
    "};",
  ].join("\n"));
}
async function mcpWindowInfo() {
  return await js([
    "const norm = function (s) { return String(s || '').replace(/\\s+/g, ' ').trim(); };",
    "return {",
    "  window: !!document.querySelector('[aria-label=\"MCP 中心窗口\"]'),",
    "  available: document.querySelector('[data-mcp-center]') ? document.querySelector('[data-mcp-center]').getAttribute('data-mcp-available') : null,",
    "  rows: Array.from(document.querySelectorAll('[data-mcp-connection]')).map(function (el) { return { id: el.getAttribute('data-mcp-connection'), status: el.getAttribute('data-mcp-status'), name: norm(el.querySelector('[data-mcp-name]')?.textContent), tools: norm(el.querySelector('[data-mcp-tool-count]')?.textContent) }; }),",
    "  errorCode: document.querySelector('[data-mcp-error-code]')?.getAttribute('data-mcp-error-code') || null,",
    "};",
  ].join("\n"));
}
async function selectRow(id) {
  const clicked = await clickSel('.mcp-row[data-mcp-connection="' + id + '"]');
  const ok = await waitFor(async () => (await js([
    "const row = document.querySelector('.mcp-row[data-mcp-connection=" + JSON.stringify(id) + "]');",
    "const name = row ? (row.querySelector('[data-mcp-name]') || {}).textContent || '' : '';",
    "const state = document.querySelector('[data-mcp-detail-state]')?.getAttribute('data-mcp-detail-state') || null;",
    "const shown = (document.querySelector('[data-mcp-detail-name]') || {}).textContent || '';",
    "return state === 'ready' && !!name && shown.trim() === name.trim();",
  ].join("\n"))) === true, 20000, 120);
  return clicked === "ok" && ok;
}
/** 未认证窗口内的"投影是否为空"：整页扫描（工具名 / 描述 / 参数 / hash / 工具表）。 */
async function projectionScan(toolNames, hash) {
  return await js([
    "const t = document.body ? document.body.textContent || '' : '';",
    "const names = " + JSON.stringify(toolNames) + ";",
    "const hash = " + JSON.stringify(hash) + ";",
    "return {",
    "  toolRows: document.querySelectorAll('[data-mcp-tool]').length,",
    "  toolsTable: !!document.querySelector('[data-mcp-tools]'),",
    "  toolNameHits: names.filter(function (n) { return t.indexOf(n) >= 0; }),",
    "  descriptionHit: t.indexOf('把两个数字相加') >= 0,",
    "  schemaHit: t.indexOf('a:number') >= 0 || t.indexOf('verbose:boolean') >= 0,",
    "  hashHit: !!hash && t.indexOf(hash) >= 0,",
    "  mcpWindow: !!document.querySelector('[aria-label=\"MCP 中心窗口\"]'),",
    "  mcpCenter: !!document.querySelector('[data-mcp-center]'),",
    "  loginForm: !!document.querySelector('[data-d3-id=\"login-form\"]'),",
    "  authError: (document.querySelector('[data-d3-id=\"auth-error\"]') || {}).textContent || null,",
    "  gate: document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root',",
    "  bodyText: t.replace(/\\s+/g, ' ').trim().slice(0, 400),",
    "};",
  ].join("\n"));
}

/* ══════════════════════════ 连接：命令面 / 界面表单 ══════════════════════════ */
async function createConn(name, { transport = "http", url = null, serverKey = null } = {}) {
  const created = await mcpCmd("mcp/create", {
    name,
    transport,
    location: transport === "stdio" ? "LOCAL_DEVICE" : "REMOTE_SERVICE",
    endpoint: transport === "stdio" ? { serverKey } : { url },
    authMode: "NONE",
    visibility: "PERSONAL",
  });
  const connectionId = created && created.ok && created.connection ? created.connection.connectionId : null;
  const enabled = connectionId ? await mcpCmd("mcp/setEnabled", { connectionId, enabled: true }) : null;
  return { created, connectionId, enabled: !!(enabled && enabled.ok), error: created && created.error };
}
async function connectMeasured(connectionId) {
  const t0 = Date.now();
  const res = await mcpCmd("mcp/connect", { connectionId });
  return { res, ms: Date.now() - t0 };
}
async function connState(connectionId) {
  const res = await mcpCmd("mcp/get", { connectionId });
  const connection = res && res.ok ? res.connection || null : null;
  return { res, ok: !!(res && res.ok), error: res && res.error, connection, stream: connection && connection.getStream ? connection.getStream : null };
}
async function openCreateDialog() {
  if (await has('[data-mcp-dialog="create"]')) return true;
  if (await has('[data-mcp-action="create"]')) await clickSel('[data-mcp-action="create"]');
  else await js("const b = Array.from(document.querySelectorAll('button')).find(function (x) { return (x.textContent || '').trim() === '新建连接'; }); if (b) b.click(); return !!b;");
  return await waitSel('[data-mcp-dialog="create"]', 10000);
}
async function createViaUI(spec) {
  const opened = await openCreateDialog();
  if (!opened) return { ok: false, reason: "dialog-not-open" };
  await setInput('[data-mcp-field="name"]', spec.name);
  await setSelect('[data-mcp-field="transport"]', spec.transport);
  await setSelect('[data-mcp-field="location"]', spec.location);
  if (spec.transport === "stdio") { if (spec.serverKey != null) await setSelect('[data-mcp-field="serverKey"]', spec.serverKey); }
  else await setInput('[data-mcp-field="url"]', spec.url);
  await setSelect('[data-mcp-field="authMode"]', spec.authMode || "NONE");
  await setSelect('[data-mcp-field="visibility"]', spec.visibility || "PERSONAL");
  await sleep(120);
  await clickSel('[data-mcp-submit="create"]');
  const closed = await waitFor(async () => !(await has('[data-mcp-dialog="create"]')), 15000, 120);
  const listed = await waitFor(async () => { const res = await mcpCmd("mcp/list"); return !!(res && res.ok && (res.items || []).some((i) => i.name === spec.name)); }, 15000, 150);
  const res = await mcpCmd("mcp/list");
  const item = res && res.ok ? (res.items || []).find((i) => i.name === spec.name) || null : null;
  return { ok: !!closed && !!listed && !!item, dialogClosed: closed, listed, connectionId: item ? item.connectionId : null };
}
/** 界面表单建连 + 启用 + 连接（一步到位，返回全部证据）。 */
async function uiBuildAndConnect(name, url) {
  const ui = await createViaUI({ name, transport: "http", location: "REMOTE_SERVICE", url, authMode: "NONE", visibility: "PERSONAL" });
  if (!ui.ok) return { ui, connectionId: null, ok: false };
  const en = await mcpCmd("mcp/setEnabled", { connectionId: ui.connectionId, enabled: true });
  const c = await connectMeasured(ui.connectionId);
  return { ui, connectionId: ui.connectionId, enabled: !!(en && en.ok), connect: c, ok: !!(en && en.ok) && !!(c.res && c.res.ok) };
}

/* ══════════════════════════ fixture / 参照握手 ══════════════════════════ */
function startFixture(args) {
  const c = spawn(process.execPath, [FIXTURE, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "", errBuf = "";
  SPAWNS.push({ kind: "fixture", pid: c.pid, label: args.join(" "), at: new Date().toISOString() });
  const entry = { child: c, args, stdout: () => buf, stderr: () => errBuf, stop() { try { c.kill("SIGKILL"); } catch { /* ignore */ } } };
  fixtures.push(entry);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture 未就绪：" + errBuf)), 8000);
    c.stdout.on("data", (d) => {
      buf += String(d);
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { clearTimeout(timer); reject(e); }
    });
    c.stderr.on("data", (d) => { errBuf += String(d); });
    c.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
  return { ...entry, ready };
}
async function fixtureState(port) {
  for (let i = 0; i < 20; i += 1) {
    try { const r = await fetch("http://127.0.0.1:" + port + "/__state"); if (r.ok) return await r.json(); } catch { /* not ready */ }
    await sleep(50);
  }
  return null;
}
async function fx(args = [], label = "") {
  const f = startFixture(["--http", "--port=0", ...args]);
  const info = await f.ready;
  const handle = { ...f, label: label || args.join(" ") || "plain", port: info.port, url: info.url, state: () => fixtureState(info.port) };
  fixtureRows.push({ label: handle.label, args, port: info.port, url: info.url });
  return handle;
}
async function rawHttpHandshake(url) {
  const post = async (payload) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(payload) });
    return { status: res.status, text: await res.text() };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d5-03-expiry-reference", version: "1.0.0" } } });
  const initMsg = JSON.parse(init.text);
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsMsg = JSON.parse(tools.text);
  return { status: init.status, protocolVersion: initMsg.result.protocolVersion, serverInfo: initMsg.result.serverInfo, capabilities: initMsg.result.capabilities, tools: (toolsMsg.result && toolsMsg.result.tools) || [] };
}
function expectedFromReference(ref) {
  const sanitized = domain.sanitizeTools(ref.tools, { maxTools: 200 });
  return { protocolVersion: ref.protocolVersion, tools: sanitized.tools, toolsHash: domain.toolsHash(sanitized.tools), toolNames: sanitized.tools.map((t) => t.name) };
}

/* ══════════════════════════ 进程 / DB 只读取证 ══════════════════════════ */
function psRows() {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" })
      .split("\n").map((l) => { const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m ? { pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], cmd: m[4] } : null; })
      .filter(Boolean);
  } catch { return []; }
}
function descendantsOf(rootPid) {
  const rows = psRows();
  const byId = new Map(rows.map((r) => [r.pid, r]));
  return rows.filter((r) => {
    let p = r.ppid, hops = 0;
    while (p && hops < 14) { if (p === rootPid) return true; const pr = byId.get(p); if (!pr) return false; p = pr.ppid; hops += 1; }
    return false;
  });
}
const descendantPids = () => (child ? descendantsOf(child.pid).filter((r) => !r.stat.startsWith("Z")).map((r) => r.pid) : []);
const pidAlive = (pid) => psRows().some((r) => r.pid === pid && !r.stat.startsWith("Z"));
function dbAll(sql) {
  try {
    const db = new DatabaseSync(dbPath(), { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  } catch (e) { return [{ __error: String((e && e.message) || e).slice(0, 200) }]; }
}
const q = (v) => "'" + String(v).replace(/'/g, "") + "'";
const dbConnection = (id) => dbAll("SELECT * FROM mcp_connections WHERE connection_id = " + q(id))[0] || null;
const dbLogs = (id, limit = 12) => dbAll("SELECT at, level, event, error_code, detail FROM mcp_connection_logs WHERE connection_id = " + q(id) + " ORDER BY at DESC, id DESC LIMIT " + Number(limit));
const dbSessions = () => dbAll("SELECT id, ref, user_id, created_at, last_seen_at, expires_at, idle_expires_at, revoked_at, revoked_reason, locked_at FROM sessions ORDER BY created_at");
const dbAudit = (event) => dbAll("SELECT at, event, result, error_code FROM audit_log WHERE event = " + q(event) + " ORDER BY id");
/** 到期权威时刻：对权威行只读轮询，记录 revoked_at（= 库时钟落终态那一刻）。 */
async function waitRevoked(ref, timeoutMs) {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  const stmt = db.prepare("SELECT id, ref, expires_at, idle_expires_at, last_seen_at, revoked_at, revoked_reason FROM sessions WHERE ref = ?");
  const t0 = Date.now();
  try {
    for (;;) {
      let row = null;
      try { row = stmt.get(ref) || null; } catch { row = null; }
      if (row && row.revoked_at != null) return { detectedAtWall: Date.now(), row, waitedMs: Date.now() - t0 };
      if (Date.now() - t0 >= timeoutMs) return { timeout: true, row, waitedMs: Date.now() - t0 };
      await sleep(40);
    }
  } finally { db.close(); }
}
/** 全量只读快照（写进产物 JSON 的 dbSnapshots）。 */
function captureDbSnapshot(label, connectionIds) {
  const ids = (connectionIds || []).filter(Boolean);
  DB_SNAPSHOTS[label] = {
    at: new Date().toISOString(),
    sessions: dbSessions(),
    connections: ids.map((id) => dbAll("SELECT connection_id, name, enabled, status, last_error_code, protocol_version, server_name, tools_hash, created_at, updated_at FROM mcp_connections WHERE connection_id = " + q(id))[0] || null),
    connectionLogs: ids.map((id) => ({ connectionId: id, rows: dbLogs(id, 20) })),
    auditTail: dbAll("SELECT at, event, result, error_code FROM audit_log ORDER BY id DESC LIMIT 40").reverse(),
  };
  return DB_SNAPSHOTS[label];
}
/** 渲染层事件计数（页面内只加监听，不发任何命令 —— 不触碰会话）。 */
const installEventProbe = () => js("window.__d503Events = []; if (!(window.openarc && window.openarc.identity && window.openarc.identity.onEvent)) return 'no-bridge'; window.openarc.identity.onEvent(function (e) { window.__d503Events.push({ at: Date.now(), event: e.event, reason: e.reason || null, sessionRef: e.sessionRef || null, sessionId: e.sessionId || null }); }); return 'subscribed';");
const readEvents = (filter) => js("const a = Array.isArray(window.__d503Events) ? window.__d503Events : []; return " + (filter ? "a.filter(function (e) { return " + filter + "; })" : "a") + ";");
const expiredEvents = async () => (await readEvents("e.event === 'identity/session-expired'")) || [];

/* ══════════════════════════ 启动 / 收尾 ══════════════════════════ */
function writeOwnerMarker(dir, meta) {
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ script: SCRIPT_NAME, runId: RUN ? RUN.runId : null, pid: process.pid, createdAt: new Date().toISOString(), kind: "userdata", prefix: USERDATA_PREFIX, ...meta }, null, 2) + "\n", { mode: 0o600 });
}
async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), USERDATA_PREFIX));
  writeOwnerMarker(userDataDir, { scenario: SCENARIO });
  OWNED_DIRS.push(userDataDir);
  if (RESERVED_PORT) { await RESERVED_PORT.release(); RESERVED_PORT = null; }
  const env = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete env.OPENARC_ALLOW_SESSION_TTL_OVERRIDE; delete env.OPENARC_SESSION_IDLE_MS; delete env.OPENARC_SESSION_TTL_MS;
  if (CFG.ack) env.OPENARC_ALLOW_SESSION_TTL_OVERRIDE = "1";
  if (CFG.idleMs != null) env.OPENARC_SESSION_IDLE_MS = String(CFG.idleMs);
  if (CFG.ttlMs != null) env.OPENARC_SESSION_TTL_MS = String(CFG.ttlMs);
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
  SPAWNS.push({ kind: "electron", pid: child.pid, label: "main", cdpPort: CDP_PORT, userDataDir, at: new Date().toISOString() });
  child.stdout.on("data", (d) => { stdoutBuf += String(d); });
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!page && end > Date.now()) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面");
  page.on("dialog", (d) => { dialogs.push(String(d.message()).slice(0, 140)); void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror:" + String(e.message).slice(0, 200)));
  return { userDataDir: path.basename(userDataDir), cdpPort: CDP_PORT, env: { OPENARC_ALLOW_SESSION_TTL_OVERRIDE: env.OPENARC_ALLOW_SESSION_TTL_OVERRIDE || null, OPENARC_SESSION_IDLE_MS: env.OPENARC_SESSION_IDLE_MS || null, OPENARC_SESSION_TTL_MS: env.OPENARC_SESSION_TTL_MS || null }, electronArgs: [".", "--user-data-dir=<isolated>", "--remote-debugging-port=" + CDP_PORT, ...extraArgs] };
}
const waitExit = (ms) => new Promise((resolve) => {
  if (!child || child.exitCode != null || child.signalCode != null) return resolve({ code: child ? child.exitCode : null, signal: child ? child.signalCode : null });
  const onExit = (code, signal) => { clearTimeout(t); resolve({ code, signal }); };
  const t = setTimeout(() => { child.removeListener("exit", onExit); resolve(null); }, ms);
  child.once("exit", onExit);
});
async function quitApp() {
  const t0 = Date.now();
  let quitPath = "page.close()（关窗 → window-all-closed → app.quit → will-quit）";
  try { await page.close(); } catch { /* CDP 可能随应用退出断开 */ }
  let exit = await waitExit(15000);
  if (!exit) { quitPath = "browser.close()（CDP Browser.close 兜底）"; try { await browser.close(); } catch { /* ignore */ } exit = await waitExit(10000); }
  if (!exit) { quitPath = "SIGTERM（非优雅兜底）"; try { child.kill("SIGTERM"); } catch { /* ignore */ } exit = await waitExit(6000); }
  return { quitPath, exit, quitMs: Date.now() - t0 };
}
async function cleanupOwnProcesses() {
  const result = { strategy: "own-pid-tree-only", pkillUsed: false, at: new Date().toISOString(), targets: [], leftovers: [], userDataDirsRemoved: [], userDataDirsKept: [], tmpdir: os.tmpdir() };
  const roots = [];
  if (child && child.pid) roots.push({ kind: "electron", rootPid: child.pid });
  for (const f of fixtures) if (f.child && f.child.pid) roots.push({ kind: "fixture", rootPid: f.child.pid });
  for (const r of roots) {
    const tree = [r.rootPid, ...descendantsOf(r.rootPid).filter((x) => !x.stat.startsWith("Z")).map((x) => x.pid)];
    for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await waitFor(() => tree.every((pid) => !pidAlive(pid)), 12000, 100);
    result.targets.push({ ...r, tree, leftovers: tree.filter(pidAlive) });
  }
  for (const f of fixtures) { try { f.stop(); } catch { /* ignore */ } }
  result.leftovers = [...new Set(result.targets.flatMap((t) => t.leftovers))];
  /* 临时 userData：只删"本次运行自建、owner.json 证明是本进程写的、且在 os.tmpdir() 下"的目录。 */
  const rootReal = fs.realpathSync(os.tmpdir());
  while (OWNED_DIRS.length) {
    const dir = OWNED_DIRS.shift();
    const name = path.basename(dir);
    if (!name.startsWith(USERDATA_PREFIX_BASE)) { result.userDataDirsKept.push({ name, reason: "前缀不是 " + USERDATA_PREFIX_BASE }); continue; }
    let real = null;
    try { real = fs.realpathSync(dir); } catch { continue; }
    if (path.dirname(real) !== rootReal) { result.userDataDirsKept.push({ name, reason: "不在清理根目录下：" + real }); continue; }
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8")); } catch { marker = null; }
    if (!marker || marker.script !== SCRIPT_NAME || Number(marker.pid) !== process.pid || marker.runId !== (RUN ? RUN.runId : null)) {
      result.userDataDirsKept.push({ name, reason: "归属标记不是本进程写的" });
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(dir)) { result.userDataDirsKept.push({ name, reason: "删除后仍存在" }); continue; }
    result.userDataDirsRemoved.push(name);
  }
  return result;
}
function leftoverTempDirs() {
  try {
    return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(USERDATA_PREFIX_BASE)).sort().map((n) => {
      const p = path.join(os.tmpdir(), n);
      let marker = null;
      try { marker = JSON.parse(fs.readFileSync(path.join(p, MARKER), "utf8")); } catch { marker = null; }
      return { name: n, marker, isMine: !!(marker && marker.script === SCRIPT_NAME) };
    });
  } catch { return null; }
}

/* ══════════════════════════ 证据：源码 / 开关 / 无轮询 ══════════════════════════ */
function sourceScan() {
  const files = {
    "electron/identity-service.cjs": fs.readFileSync(path.join(ROOT, "electron", "identity-service.cjs"), "utf8"),
    "electron/identity-store.cjs": fs.readFileSync(path.join(ROOT, "electron", "identity-store.cjs"), "utf8"),
    "electron/identity-domain.cjs": fs.readFileSync(path.join(ROOT, "electron", "identity-domain.cjs"), "utf8"),
    "electron/identity-bootstrap.cjs": fs.readFileSync(path.join(ROOT, "electron", "identity-bootstrap.cjs"), "utf8"),
    "electron/mcp-bootstrap.cjs": fs.readFileSync(path.join(ROOT, "electron", "mcp-bootstrap.cjs"), "utf8"),
    "electron/mcp-service.cjs": fs.readFileSync(path.join(ROOT, "electron", "mcp-service.cjs"), "utf8"),
    "electron/runtime-boot.cjs": fs.readFileSync(path.join(ROOT, "electron", "runtime-boot.cjs"), "utf8"),
    "src/identity/useIdentity.ts": fs.readFileSync(path.join(ROOT, "src", "identity", "useIdentity.ts"), "utf8"),
    "src/identity/types.ts": fs.readFileSync(path.join(ROOT, "src", "identity", "types.ts"), "utf8"),
    "src/mcp/McpCenter.tsx": fs.readFileSync(path.join(ROOT, "src", "mcp", "McpCenter.tsx"), "utf8"),
  };
  const out = {};
  for (const [f, src] of Object.entries(files)) {
    out[f] = {
      setInterval: (src.match(/setInterval\s*\(/g) || []).length,
      clearInterval: (src.match(/clearInterval\s*\(/g) || []).length,
      singleTimerRefs: (src.match(/#expiryTimer/g) || []).length,
      mentionsExpiry: /sessionExpired|session-expired|expiry|expireSession|sessionExpiry/.test(src),
      events: (src.match(/identity\/session-expired/g) || []).length,
    };
  }
  const identitySvc = files["electron/identity-service.cjs"];
  return {
    perFile: out,
    setIntervalTotal: Object.values(out).reduce((n, v) => n + v.setInterval, 0),
    /** 排程只有一处 this.timers.setTimeout(...)，句柄只有单字段 expiryTimer。 */
    scheduleSites: (identitySvc.match(/this\.timers\.setTimeout\(/g) || []).length,
    expiryTimerFieldRefs: out["electron/identity-service.cjs"].singleTimerRefs,
    singleTimerComment: /单一定时器/.test(identitySvc),
    noIntervalComment: /禁止 setInterval/.test(identitySvc),
    sharedVerdict: /domain\.sessionExpiry\(row, this\.store\.clock\(\)\)/.test(identitySvc) && /function sessionExpiry\(session, now\)/.test(files["electron/identity-domain.cjs"]),
    rendererUsesPureConvergence: /identityEventConvergence\(\{\s*event:\s*event\.event/.test(files["src/identity/useIdentity.ts"]),
    mcpSessionEndEvents: (() => {
      try { return require(path.join(ROOT, "electron", "mcp-bootstrap.cjs")).MCP_SESSION_END_EVENTS; } catch { return null; }
    })(),
    sessionEndReasonSource: (() => {
      const src = files["electron/mcp-bootstrap.cjs"];
      const m = src.match(/function sessionEndReason[\s\S]{0,400}?\n\}/);
      return m ? m[0] : null;
    })(),
  };
}
function overrideEvidence() {
  /* 直接调产品解析入口（同一份实现，main.cjs 用的就是它），拿 record 的形状（event / result / detail）。 */
  const withAck = identityBootstrap.resolveSessionTtlOverride({ env: { OPENARC_ALLOW_SESSION_TTL_OVERRIDE: "1", OPENARC_SESSION_IDLE_MS: String(CFG.idleMs ?? 8000), OPENARC_SESSION_TTL_MS: String(CFG.ttlMs ?? 60000) } });
  const noAck = identityBootstrap.resolveSessionTtlOverride({ env: { OPENARC_SESSION_IDLE_MS: String(CFG.idleMs ?? 8000), OPENARC_SESSION_TTL_MS: String(CFG.ttlMs ?? 60000) } });
  const defaults = identityBootstrap.resolveSessionTtlOverride({ env: {} });
  return { withAck, noAck, defaults, minMs: identityBootstrap.SESSION_TTL_OVERRIDE.MIN_MS, ackEnv: identityBootstrap.SESSION_TTL_OVERRIDE.ACK_ENV, storeDefaults: { ttlMs: identityStoreModule.DEFAULT_TTL_MS, idleMs: identityStoreModule.DEFAULT_IDLE_MS } };
}
function stdoutTtlLines() {
  return stdoutBuf.split("\n").filter((l) => l.includes("[openarc]") && /会话有效期覆写|忽略 OPENARC_SESSION/.test(l));
}

/* ══════════════════════════ 视觉量测 ══════════════════════════ */
/**
 * 真机像素量测：截图该说明行（含 6px 边距）→ 回到页面里用 canvas 解码 →
 *   · 背景 = 区域内出现次数最多的颜色（合成后的实际表面）；
 *   · 文字 = 区域内与背景亮度差最大的那个像素（字形实心处的颜色）。
 * 同时取计算样式（color / font-size / font-weight / line-height 与 --muted / --fs-caption token 真值）。
 */
async function measureNote(sel) {
  const rect = await js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };");
  if (!rect) return null;
  const style = await js([
    "const el = document.querySelector(" + JSON.stringify(sel) + ");",
    "const cs = getComputedStyle(el);",
    "const root = getComputedStyle(document.documentElement);",
    "const d = document.querySelector('.desktop');",
    "return { color: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing,",
    "  fontFamily: cs.fontFamily, transitionProperty: cs.transitionProperty, transitionDuration: cs.transitionDuration,",
    "  animationName: cs.animationName, animationDuration: cs.animationDuration,",
    "  elementMuted: cs.getPropertyValue('--muted').trim(), elementFsCaption: cs.getPropertyValue('--fs-caption').trim(), elementDurQuick: cs.getPropertyValue('--dur-quick').trim(),",
    "  rootMuted: root.getPropertyValue('--muted').trim(), rootFsCaption: root.getPropertyValue('--fs-caption').trim(),",
    "  desktopClasses: d ? Array.from(d.classList) : null, rect: { x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) },",
    "  text: (el.textContent || '').replace(/\\s+/g, ' ').trim() };",
  ].join("\n"));
  const PAD = 6;
  const clip = { x: Math.max(0, rect.x - PAD), y: Math.max(0, rect.y - PAD), width: rect.w + PAD * 2, height: rect.h + PAD * 2 };
  const buf = await page.screenshot({ clip });
  const dataUrl = "data:image/png;base64," + buf.toString("base64");
  const pixels = await js([
    "const url = " + JSON.stringify(dataUrl) + ";",
    "const img = new Image(); img.src = url; await img.decode();",
    "const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;",
    "const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);",
    "const d = ctx.getImageData(0, 0, c.width, c.height).data;",
    "const W = c.width, H = c.height;",
    "const pad = Math.max(1, Math.round(" + PAD + " * (W / " + clip.width + ")));",
    "const counts = new Map();",
    "const lum = function (r, g, b) { const f = function (v) { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };",
    "let total = 0;",
    "for (let y = pad; y < H - pad; y += 1) for (let x = pad; x < W - pad; x += 1) { const i = (y * W + x) * 4; const k = d[i] + ',' + d[i + 1] + ',' + d[i + 2]; counts.set(k, (counts.get(k) || 0) + 1); total += 1; }",
    "let bgKey = null, bgN = -1; for (const [k, n] of counts) if (n > bgN) { bgN = n; bgKey = k; }",
    "const bg = bgKey.split(',').map(Number); const lbg = lum(bg[0], bg[1], bg[2]);",
    "let bestDiff = -1, bestPx = null;",
    "for (let y = pad; y < H - pad; y += 1) for (let x = pad; x < W - pad; x += 1) { const i = (y * W + x) * 4; const L = lum(d[i], d[i + 1], d[i + 2]); const diff = Math.abs(L - lbg); if (diff > bestDiff) { bestDiff = diff; bestPx = [d[i], d[i + 1], d[i + 2]]; } }",
    "return { imgWidth: W, imgHeight: H, cssWidth: " + clip.width + ", cssHeight: " + clip.height + ", padDevicePx: pad, bg: bg, bgCount: bgN, bgShare: +(bgN / total).toFixed(4), distinctColors: counts.size, textPx: bestPx, textDiff: +bestDiff.toFixed(4) };",
  ].join("\n"));
  return { rect, clip, style, pixels, png: { ...pngSize(buf), bytes: buf.length, sha256_16: sha16(buf) } };
}

/* ══════════════════════════ 设置面板（主题 / 减少动态效果） ══════════════════════════ */
async function openSettings() {
  if (await has("[data-settings-active]")) return true;
  await js("const el = document.querySelector('.dock-item[data-dock-id=\"settings\"]'); if (el) el.click(); return !!el;");
  return await waitSel("[data-settings-active]", 15000);
}
async function closeSettings() {
  await js("const w = document.querySelector('[data-settings-active]')?.closest('.window'); const b = w?.querySelector('.window-title button.close'); if (b) b.click(); return !!b;");
  return await waitFor(async () => !(await has("[data-settings-active]")), 8000, 150);
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
/** 视觉阶段保活：只发身份只读命令（合法活动），不改被测状态；用递归 setTimeout 链（本脚本自身不用 setInterval）。 */
function startKeepAlive(intervalMs = 2000) {
  const state = { stopped: false, ticks: 0, errors: [], firstTickAt: null, lastTickAt: null };
  const tick = async () => {
    if (state.stopped) return;
    try { const r = await identityCmd("identity/status"); state.ticks += 1; if (!state.firstTickAt) state.firstTickAt = Date.now(); state.lastTickAt = Date.now(); if (r && r.ok === false) state.errors.push("status-not-ok:" + r.error); } catch (e) { state.errors.push(String((e && e.message) || e).slice(0, 120)); }
    if (!state.stopped) setTimeout(tick, intervalMs);
  };
  tick();
  return { stop: () => { state.stopped = true; return state; }, state };
}

/* ══════════════════════════ 场景 1（idle）+ 6 + 7b + 视觉 / 对比度 / 动效 ══════════════════════════ */
async function runIdle() {
  const launched = await launch();
  const probe = await installEventProbe();
  const boot = await setupAndLogin();
  const view = measure("idle.viewport", await viewportInfo());
  record("1a", "真实 electron . 启动（隔离 userData " + USERDATA_PREFIX + "* / 本次运行独占 CDP 端口）+ 三步向导 + 真实 UI 登录 + 渲染层事件探针就位",
    !!browser && boot.ok === true && probe === "subscribed", "CDP 可用 + gate=ready + 事件探针 subscribed",
    JSON.stringify({ cdp: CDP_PORT, userData: launched.userDataDir, initialized: boot.initialized, gate: await gate(), probe, viewport: view, env: launched.env }));

  /* 7b：短有效期双重开关（ack + 合法值）→ 主进程日志有"默认值 → 生效值" */
  const ov = overrideEvidence();
  const applied = stdoutTtlLines();
  const appliedLine = applied[0] || "";
  const expectEffective = ov.storeDefaults.idleMs + " → " + CFG.idleMs + "，ttlMs " + ov.storeDefaults.ttlMs + " → " + CFG.ttlMs;
  record("7b", "开关自证 (b)：ack（" + ov.ackEnv + "=1）+ 合法值 " + CFG.idleMs + "/" + CFG.ttlMs + " → 主进程日志恰好一条「会话有效期覆写生效」且含「默认值 → 生效值」",
    applied.length === 1 && /会话有效期覆写生效/.test(appliedLine) && appliedLine.includes(ov.storeDefaults.idleMs + " → " + CFG.idleMs) && appliedLine.includes(ov.storeDefaults.ttlMs + " → " + CFG.ttlMs)
      && ov.withAck.applied === true && ov.withAck.records[0].event === "session-ttl-override" && ov.withAck.records[0].result === "OK",
    "1 条生效日志 + 数值 " + expectEffective + " + 解析入口 record(event=session-ttl-override, result=OK)",
    JSON.stringify({ stdoutLines: applied, expected: expectEffective, resolver: { applied: ov.withAck.applied, sessionIdleMs: ov.withAck.sessionIdleMs, sessionTtlMs: ov.withAck.sessionTtlMs, record: ov.withAck.records[0] }, defaults: ov.storeDefaults, minMs: ov.minMs }));
  if (!appliedLine.includes("session-ttl-override")) {
    note("开关留痕的措辞差异（如实记录，不是失败）：stdout 只打印 record.message，该句本身不含事件名 session-ttl-override；事件名只存在于解析结果 record.event（见 7b 证据 resolver.record）。");
  }

  /* 连接：界面表单建连 + 启用 + 连接（真实 UI 入口） */
  const refFx = await fx([], "reference-plain");
  const ref = await rawHttpHandshake(refFx.url);
  const exp = expectedFromReference(ref);
  const fIdle = await fx(["--get-sse", "--get-sse-ids", "--get-sse-notify-interval=200"], "idle-natural-expiry");
  const opened = await openMcpWindow();
  const info0 = await mcpWindowInfo();
  record("1b", "程序坞打开「MCP 中心」→ 窗口出现 + MCP 域可用 + fixture 参照握手（独立进程，产品链路之外）",
    opened && !!info0.window && info0.available === "true" && exp.toolNames.length >= 2 && typeof exp.toolsHash === "string",
    "窗口存在 + data-mcp-available=true + 参照握手工具表 ≥2",
    JSON.stringify({ opened, window: info0.window, available: info0.available, reference: { protocolVersion: ref.protocolVersion, serverInfo: ref.serverInfo, tools: exp.toolNames, toolsHash: exp.toolsHash } }));
  const built = await uiBuildAndConnect("会话到期服务", fIdle.url);
  const ids = { idle: built.connectionId };
  const rowAfterCreate = built.connectionId ? await selectRow(built.connectionId) : false;
  const detailBefore = rowAfterCreate ? await detailSnapshot() : null;
  record("1c", "首条连接经界面表单创建（真实 UI 入口）+ 启用 + 连接：详情 READY、工具表等于本次参照握手（" + exp.toolNames.join("/") + "）且哈希一致",
    built.ok === true && rowAfterCreate === true && !!detailBefore && detailBefore.state === "ready"
      && JSON.stringify(detailBefore.tools.map((t) => t.name)) === JSON.stringify(exp.toolNames) && detailBefore.toolsHash === exp.toolsHash,
    "表单建连 ok + 启用 + connect ok + 详情 ready + 工具名/哈希 = 参照握手",
    JSON.stringify({ ui: { ok: built.ui.ok, dialogClosed: built.ui.dialogClosed, listed: built.ui.listed }, enabled: built.enabled, connect: { ok: !!(built.connect.res && built.connect.res.ok), ms: built.connect.ms, error: built.connect.res && built.connect.res.error }, detail: detailBefore && { state: detailBefore.state, status: detailBefore.status, tools: detailBefore.tools.map((t) => t.name), toolsHash: detailBefore.toolsHash, enabled: detailBefore.enabled }, expected: { tools: exp.toolNames, toolsHash: exp.toolsHash } }));
  const streamUp = await waitFor(async () => { const s = await fIdle.state(); return !!s && s.getSse.openStreams === 1; }, 10000, 80);
  const preState = await fIdle.state();
  const preRow = dbConnection(ids.idle);
  const preSess = dbSessions().find((s) => s.revoked_at == null) || null;
  if (!preSess) throw new Error("没有活跃会话：无法测量自然到期");
  const dueAt = Math.min(preSess.expires_at, preSess.idle_expires_at);
  const dueReason = preSess.idle_expires_at <= preSess.expires_at ? "idle" : "absolute";
  measure("idle.dueAt", { dueAt, dueAtISO: iso(dueAt), dueReason, idleExpiresAt: preSess.idle_expires_at, expiresAt: preSess.expires_at, sessionRef: preSess.ref, sessionId: preSess.id, idleMsFromCreated: preSess.idle_expires_at - preSess.created_at, ttlMsFromCreated: preSess.expires_at - preSess.created_at, observedAt: Date.now() });
  /* idle_expires_at 会被最后一次活动（建连 / 选详情时的 validateSession -> #touch）重写成 last_seen_at + idleMs，
     所以判据用 idle_expires_at - last_seen_at（应精确等于注入值）；绝对上限只看 created_at。 */
  const idleFromLastSeen = preSess.idle_expires_at - preSess.last_seen_at;
  record("1d", "前置：注入的短有效期真的落在权威行（只读 DB）—— idle_expires_at - last_seen_at = " + idleFromLastSeen + "ms（= 注入 " + CFG.idleMs + "ms；相对 created_at 为 " + (preSess.idle_expires_at - preSess.created_at) + "ms，差的 " + (preSess.idle_expires_at - preSess.created_at - CFG.idleMs) + "ms 是登录 / 建连那次 touch 的漂移）、expires_at - created_at = " + (preSess.expires_at - preSess.created_at) + "ms（= 注入 " + CFG.ttlMs + "ms）；服务端 GET 流 openStreams=" + (preState && preState.getSse.openStreams),
    idleFromLastSeen === CFG.idleMs && preSess.expires_at - preSess.created_at === CFG.ttlMs && streamUp === true
      && Number(preState.getSse.openStreams) === 1 && preState.getSse.requests >= 1,
    "idle 有效期 = 注入值（按 last_seen_at 起算）+ 绝对有效期 = 注入值（按 created_at 起算）+ 服务端 getSse.openStreams=1",
    JSON.stringify({ session: { id: preSess.id, createdAt: preSess.created_at, lastSeenAt: preSess.last_seen_at, idleExpiresAt: preSess.idle_expires_at, expiresAt: preSess.expires_at, idleFromLastSeen, touchDriftMs: preSess.idle_expires_at - preSess.created_at - CFG.idleMs }, expected: { idleMs: CFG.idleMs, ttlMs: CFG.ttlMs }, connection: preRow && { enabled: preRow.enabled, status: preRow.status, last_error_code: preRow.last_error_code }, fixture: { openStreams: preState.getSse.openStreams, requests: preState.getSse.requests, opens: preState.getSse.opens }, dueAtISO: iso(dueAt) }));

  /* 不点任何按钮、不发任何命令，只读轮询等自然到期 */
  note("1e 起：进入零交互窗口 —— 只做只读 DB 轮询 + fixture /__state 轮询（都不触碰会话）；渲染层事件探针只是一次性订阅。");
  const evP = (async () => {
    for (let i = 0; i < 700; i += 1) {
      const list = await expiredEvents().catch(() => []);
      if (Array.isArray(list) && list.length) return { at: list[0].at, events: list };
      await sleep(50);
    }
    return null;
  })();
  const rev = await waitRevoked(preSess.ref, Math.max(20000, (dueAt - Date.now()) + 15000));
  const ev = await evP;
  const revRow = rev && rev.row ? rev.row : null;
  const revokedAt = revRow ? revRow.revoked_at : null;
  const deviationMs = Number.isFinite(revokedAt) && Number.isFinite(dueAt) ? revokedAt - dueAt : null;
  const eventDelayMs = ev && Number.isFinite(revokedAt) ? ev.at - revokedAt : null;
  measure("idle.expiry", { dueAt, dueAtISO: iso(dueAt), dueReason, revokedAt, revokedAtISO: iso(revokedAt), deviationMs, eventRecvAt: ev && ev.at, eventRecvAtISO: ev && iso(ev.at), eventDelayMs, detectWallMs: rev && rev.detectedAtWall, pollLatencyMs: rev && rev.detectedAtWall && Number.isFinite(revokedAt) ? rev.detectedAtWall - revokedAt : null, revokedReason: revRow && revRow.revoked_reason, pollWaitedMs: rev && rev.waitedMs });
  const allEvents = (await readEvents()) || [];
  const expired = allEvents.filter((e) => e.event === "identity/session-expired");
  record("1e", "空闲自然到期发生在权威时刻的有界窗口内：dueAt=" + iso(dueAt) + "（" + dueReason + " 归因）→ revoked_at=" + iso(revokedAt) + "，偏差 " + deviationMs + "ms（上界 " + EXPIRY_BOUND_MS + "ms）；事件送达渲染层延迟 " + eventDelayMs + "ms",
    Number.isFinite(revokedAt) && deviationMs != null && deviationMs >= 0 && deviationMs <= EXPIRY_BOUND_MS && !!ev
      && Number.isFinite(eventDelayMs) && eventDelayMs >= 0 && eventDelayMs <= EXPIRY_BOUND_MS && expired.length === 1 && expired[0].reason === "idle"
      && revRow.revoked_reason === identityDomain.REVOKE_REASON.EXPIRED,
    "0 ≤ 偏差 ≤ " + EXPIRY_BOUND_MS + "ms + 事件延迟 ≤ " + EXPIRY_BOUND_MS + "ms + 恰好 1 条 identity/session-expired(reason=idle)",
    JSON.stringify({ measures: MEASURES["idle.expiry"], events: allEvents, revokedReason: revRow && revRow.revoked_reason, sessionRow: revRow }));

  const collected = await waitFor(async () => { const s = await fIdle.state(); return !!s && s.getSse.openStreams === 0; }, 8000, 60);
  const collectedAt = Date.now();
  const postState = await fIdle.state();
  const rowAfter = dbConnection(ids.idle);
  const logsAfter = dbLogs(ids.idle, 12);
  const endedLogs = logsAfter.filter((l) => l.event === "SESSION_ENDED");
  record("1f", "到期即收流：服务端 getSse.openStreams 1→0（实测收流耗时 " + (collectedAt - revokedAt) + "ms）+ POST 流全部由客户端释放（streams=" + (postState && postState.postSse.streams) + " / closedByClient=" + (postState && postState.postSse.closedByClient) + "，未释放 = " + ((postState && postState.postSse.streams) - (postState && postState.postSse.closedByClient)) + "）",
    collected === true && !!postState && postState.getSse.openStreams === 0 && postState.postSse.openStreams === 0
      && Number(postState.postSse.streams) === Number(postState.postSse.closedByClient) && Number(postState.getSse.opens) === 1,
    "getSse.openStreams=0 且打开次数停在 1（未重连）+ postSse.openStreams=0 + 每个 POST 流都由客户端释放（在途 0）",
    JSON.stringify({ collected, collectedAfterRevokeMs: collectedAt - revokedAt, before: { getOpenStreams: preState.getSse.openStreams, postStreams: preState.postSse.streams, postClosed: preState.postSse.closedByClient }, after: { get: postState.getSse, post: postState.postSse }, note: "主进程客户端的在途计数没有渲染层出口；此处用服务端侧每个流都已由客户端释放 + 重新登录后 mcp/get 不再有 getStream 两项等价证据；精确的 inflightRequests=0 由 tests/d5-03-mcp-lifecycle.test.mjs L6 断言" }));
  record("1g", "只读 DB：enabled=1 未被改写、status=DISABLED、last_error_code=MCP_SESSION_ENDED、revoked_reason=EXPIRED；连接日志 SESSION_ENDED 恰好 1 条且 detail=expired:idle",
    !!rowAfter && Number(rowAfter.enabled) === 1 && rowAfter.status === "DISABLED" && rowAfter.last_error_code === "MCP_SESSION_ENDED"
      && revRow.revoked_reason === identityDomain.REVOKE_REASON.EXPIRED && endedLogs.length === 1 && endedLogs[0].detail === "expired:idle" && endedLogs[0].error_code === "MCP_SESSION_ENDED",
    "enabled=1 + DISABLED + MCP_SESSION_ENDED + EXPIRED + 1 条 SESSION_ENDED(detail=expired:idle)",
    JSON.stringify({ row: rowAfter && { connection_id: rowAfter.connection_id, name: rowAfter.name, enabled: rowAfter.enabled, status: rowAfter.status, last_error_code: rowAfter.last_error_code, updated_at: rowAfter.updated_at }, logs: logsAfter, session: revRow && { revoked_at: revRow.revoked_at, revoked_reason: revRow.revoked_reason, idle_expires_at: revRow.idle_expires_at, expires_at: revRow.expires_at } }));

  const auditRows = dbAudit("expire");
  const auditForSession = auditRows.filter((r) => r.at >= (preSess.created_at - 1000));
  record("6a", "无高频轮询自证 · 权威事件只有一次：audit_log 里 event=expire 本次会话相关恰好 1 条（result=OK / error_code=SESSION_EXPIRED）+ 渲染层 identity/session-expired 恰好 1 条 + 收尾 SESSION_ENDED 恰好 1 条（没有第二套判定在跑）",
    auditForSession.length === 1 && auditForSession[0].result === "OK" && auditForSession[0].error_code === "SESSION_EXPIRED" && expired.length === 1 && endedLogs.length === 1,
    "audit expire=1（result=OK / error_code=SESSION_EXPIRED）+ 渲染层事件=1 + SESSION_ENDED=1",
    JSON.stringify({ auditAll: auditRows, auditForSession, rendererExpiredEvents: expired, sessionEndedLogs: endedLogs }));

  const converged = await waitFor(async () => (await gate()) === "unauthenticated", 15000, 100);
  const gateNow = await gate();
  const scan = await projectionScan(exp.toolNames, exp.toolsHash);
  const errText = scan.authError;
  UI_TEXTS.idle = { gate: gateNow, authError: errText, loginBodyText: scan.bodyText, sessionEndedNoteText: null };
  record("1h", "渲染层收敛到未认证（gate=" + gateNow + "）且登录页给出解释：auth-error = " + JSON.stringify(norm(errText)),
    converged === true && gateNow === "unauthenticated" && scan.loginForm === true && typeof errText === "string" && errText.includes("登录状态已过期，请重新登录。"),
    "gate=unauthenticated + 登录表单在 + auth-error 含「登录状态已过期，请重新登录。」",
    JSON.stringify({ gate: gateNow, scan }));
  if (typeof errText === "string" && /（(idle|absolute)）/.test(errText)) {
    defect("EXP-01", "登录页把内部到期枚举拼进了用户可见文案", "src/identity/useIdentity.ts 事件订阅回调（absorb({ error: intent.errorCode, detail: event.reason })）+ src/identity/types.ts:70-75 errorText 把 detail 括注在文案后",
      "会话空闲自然到期后，登录页 [data-d3-id=\"auth-error\"] 实测文案 = " + JSON.stringify(errText) + "；detail 是事件 payload 的 reason（idle/absolute），不是给人看的说法。",
      "订阅回调不再把 reason 当 detail 传（absorb({ ok: false, error: intent.errorCode })），或在 errorText 里只对身份域 detail 白名单放行（如 idle-expiry / absolute-expiry）。");
  }
  record("1i", "未认证窗口内工具投影为 0（DOM）：整页 0 个 [data-mcp-tool]、无工具表、工具名/描述/参数/hash 全部 0 命中，MCP 中心投影已清空",
    scan.toolRows === 0 && scan.toolsTable === false && scan.toolNameHits.length === 0 && scan.descriptionHit === false && scan.schemaHit === false && scan.hashHit === false && scan.mcpCenter === false,
    "0 工具行 + 无工具表 + 0 命中（工具名/描述/参数/hash）+ MCP 中心不在 DOM",
    JSON.stringify(scan));

  /* /__state 是**本脚本自己**在轮询的观测口，fixture 会给每次请求计数（http.requests / http.stateRequests），
     所以稳定性对比要剔除这两个自观测计数，只看服务端实际看到的 MCP 流量与流状态。 */
  const stripSelfPolling = (s) => { const c = JSON.parse(JSON.stringify(s || {})); if (c.http) { delete c.http.requests; delete c.http.stateRequests; } return c; };
  const before4 = await fIdle.state();
  const eventsBefore4 = ((await readEvents()) || []).length;
  await sleep(4200);
  const after4 = await fIdle.state();
  const eventsAfter4 = ((await readEvents()) || []).length;
  const cmpBefore = stripSelfPolling(before4), cmpAfter = stripSelfPolling(after4);
  const diffKeys = Object.keys(cmpAfter).filter((k) => JSON.stringify(cmpAfter[k]) !== JSON.stringify(cmpBefore[k]));
  const flatKeys = [];
  for (const k of diffKeys) if (cmpBefore[k] && typeof cmpBefore[k] === "object") for (const kk of Object.keys(cmpBefore[k])) if (JSON.stringify(cmpBefore[k][kk]) !== JSON.stringify(cmpAfter[k][kk])) flatKeys.push(k + "." + kk);
  record("1j", "之后 4.2s 服务端计数不再变化（无自动重连、无盲目重发）：/__state 对比差异字段 = " + JSON.stringify(diffKeys.length ? diffKeys : flatKeys) + "（0 变化；已剔除本脚本自身观测口计数 http.requests / http.stateRequests，差值 " + (after4.http.requests - before4.http.requests) + " 次 = 4.2s 内的只读轮询）；GET 打开次数 " + before4.getSse.opens + " → " + after4.getSse.opens + "；渲染层事件总数 " + eventsBefore4 + " → " + eventsAfter4,
    diffKeys.length === 0 && eventsAfter4 === eventsBefore4 && Number(after4.getSse.opens) === Number(before4.getSse.opens) && Number(after4.http.posts) === Number(before4.http.posts),
    "剔除自观测计数后 4.2s 内 /__state 无任何字段变化（含 GET 打开次数、POST 次数、流计数）+ 事件总数不变",
    JSON.stringify({ changedTopKeys: diffKeys, changedLeafKeys: flatKeys, before: cmpBefore, after: cmpAfter, selfPollingDelta: { requests: after4.http.requests - before4.http.requests, stateRequests: after4.http.stateRequests - before4.http.stateRequests }, eventsBefore4, eventsAfter4, windowMs: 4200 }));
  const clientAfter = await mcpCmd("mcp/get", { connectionId: ids.idle });
  record("1k", "会话结束后命令面的投影也归零：mcp/get 在没有会话时回 MCP_UNAUTHORIZED，响应里 0 连接数据 / 0 工具名 / 0 hash",
    clientAfter && clientAfter.ok === false && clientAfter.error === "MCP_UNAUTHORIZED" && !clientAfter.connection
      && !JSON.stringify(clientAfter).includes(exp.toolNames[0]) && !JSON.stringify(clientAfter).includes(exp.toolsHash),
    "mcp/get = MCP_UNAUTHORIZED 且无 connection / 工具名 / hash",
    JSON.stringify(clientAfter));

  /* 重新登录（会话 B）→ 界面「会话已结束」说明行 + 截图；期间用只读身份命令保活（合法活动），不改被测状态 */
  const relogin = await login(ADMIN.id, ADMIN.pw);
  const ka = startKeepAlive(3000);
  const reopened = await reopenMcpWindow();
  const selected = reopened ? await selectRow(ids.idle) : false;
  const detail = selected ? await detailSnapshot() : null;
  const rowAfterRelogin = await connState(ids.idle);
  UI_TEXTS.idle.sessionEndedNoteText = detail && detail.sessionEndedText;
  record("1l", "重新登录后界面显示「会话已结束」说明行（data-mcp-note=session-ended）且文案覆盖会话过期；连接仍 DISABLED 但 enabled 保持「已启用」，mcp/get 已无 getStream（客户端不再持有活连接）",
    relogin === true && reopened === true && selected === true && !!detail && detail.sessionEndedNote === true && detail.sessionEndedText.includes("会话过期")
      && detail.enabled === "已启用" && !!rowAfterRelogin.connection && rowAfterRelogin.connection.status === "DISABLED" && rowAfterRelogin.stream === null,
    "登录成功 + 详情 note=session-ended 且含「会话过期」+ enabled=已启用 + mcp/get 无 getStream（stream=null）",
    JSON.stringify({ relogin, reopened, detail, record: rowAfterRelogin.connection && { status: rowAfterRelogin.connection.status, lastErrorCode: rowAfterRelogin.connection.lastErrorCode, enabled: rowAfterRelogin.connection.enabled, toolsHash: rowAfterRelogin.connection.toolsHash, tools: (rowAfterRelogin.connection.tools || []).length, getStream: rowAfterRelogin.stream } }));
  note("工具投影口径（DOM 与 DB 两处，逐项如实）：未认证窗口内 DOM 0 命中 + 命令面 0 连接数据（1i / 1k）；重新登录后详情页显示的是权威记录里的**能力快照**（tools_json / tools_hash 属连接记录，不是活投影），活投影 getStream 为空、DB status=DISABLED（1l）。DB 只读快照：" + JSON.stringify({ status: rowAfterRelogin.connection.status, last_error_code: rowAfterRelogin.connection.last_error_code, toolsHash: rowAfterRelogin.connection.toolsHash, toolsCount: (rowAfterRelogin.connection.tools || []).length, getStream: rowAfterRelogin.stream }));

  /* ── 视觉：浅 / 深 + 计算样式 + 实机像素对比度 ── */
  const noteSel = '[data-mcp-note="session-ended"]';
  await closeSettings();
  await js("const el = document.querySelector(" + JSON.stringify(noteSel) + "); if (el) el.scrollIntoView({ block: 'center' }); return true;");
  await sleep(300);
  const lightShot = await shotTo(path.join(VIS, "light-session-expired.png"));
  const lightView = measure("visual.light.viewport", await viewportInfo());
  const lightNote = await measureNote(noteSel);
  const themeDark = await setTheme("dark");
  await closeSettings();
  await sleep(400);
  const darkShot = await shotTo(path.join(VIS, "dark-session-expired.png"));
  const darkView = measure("visual.dark.viewport", await viewportInfo());
  const darkNote = await measureNote(noteSel);
  await setTheme("light");
  await closeSettings();
  const baseline = (() => {
    try {
      const out = {};
      for (const f of ["light-02-list.png", "dark-02-detail.png"]) {
        const p = path.join(BASELINE_VISUAL_DIR, f);
        if (fs.existsSync(p)) { const b = fs.readFileSync(p); out[f] = { ...pngSize(b), sha256_16: sha16(b) }; }
      }
      return out;
    } catch { return null; }
  })();
  const contrastRow = (m, themeName) => {
    if (!m) return null;
    const fsPx = parseFloat(m.style.fontSize);
    const threshold = contrastThreshold(fsPx, m.style.fontWeight);
    const measured = contrastRatio(m.pixels.textPx, m.pixels.bg);
    const specified = contrastRatio(m.style.color, m.pixels.bg);
    const tokenSpecified = contrastRatio(m.style.elementMuted, m.pixels.bg);
    return { theme: themeName, fontSize: m.style.fontSize, fontSizePx: fsPx, fontWeight: m.style.fontWeight, lineHeight: m.style.lineHeight, color: m.style.color, fontFamily: m.style.fontFamily, tokenMuted: m.style.elementMuted, tokenFsCaption: m.style.elementFsCaption, rootMuted: m.style.rootMuted, thresholdRule: threshold === 4.5 ? "普通文本 4.5:1（" + fsPx + "px / " + m.style.fontWeight + "，不属大字）" : "大字 3:1", threshold, bgMeasured: "rgb(" + m.pixels.bg.join(",") + ")", bgShare: m.pixels.bgShare, textMeasured: "rgb(" + m.pixels.textPx.join(",") + ")", contrastMeasuredPx: measured, contrastSpecified: specified, contrastTokenSpecified: tokenSpecified, passMeasured: measured != null && measured >= threshold, passSpecified: specified != null && specified >= threshold, passTokenSpecified: tokenSpecified != null && tokenSpecified >= threshold, px: m.pixels, shot: m.png, clip: m.clip, text: m.style.text };
  };
  const light = contrastRow(lightNote, "light");
  const dark = contrastRow(darkNote, "dark");
  measure("visual.contrast", { light, dark });
  const baselineSame = !!(baseline && baseline["light-02-list.png"] && lightShot.width === baseline["light-02-list.png"].width && lightShot.height === baseline["light-02-list.png"].height && baseline["dark-02-detail.png"] && darkShot.width === baseline["dark-02-detail.png"].width && darkShot.height === baseline["dark-02-detail.png"].height);
  const sameSize = !!(lightShot.width && darkShot.width && lightShot.width === darkShot.width && lightShot.height === darkShot.height);
  record("V1", "视觉 · 会话已结束（自然过期）状态浅色实机截图（含窗口尺寸 / 缩放 / 设置记录）",
    !!lightShot.file && !lightShot.error && !!light && lightShot.width > 0, "浅色截图落盘 + 计算样式可取",
    JSON.stringify({ shot: lightShot, viewport: lightView, note: light }));
  record("V2", "视觉 · 同一状态深色实机截图（与浅色同状态、同页面）", !!darkShot.file && !darkShot.error && !!dark && darkShot.width > 0, "深色截图落盘 + 计算样式可取", JSON.stringify({ shot: darkShot, viewport: darkView, note: dark }));
  record("V3", "视觉 · 窗口尺寸 / 缩放 / 主题设置与第一批基准一致：本次浅深截图 " + lightShot.width + "×" + lightShot.height + " 设备像素（DPR " + lightView.dpr + "，CSS 裁剪 " + (lightShot.clip && lightShot.clip.width) + "×" + (lightShot.clip && lightShot.clip.height) + "），第一批基准 light-02-list / dark-02-detail = " + (baseline && baseline["light-02-list.png"] ? baseline["light-02-list.png"].width + "×" + baseline["light-02-list.png"].height : "?") + "；窗口 " + lightView.innerWidth + "×" + lightView.innerHeight + "（electron/main.cjs:272 默认 1440×940，未设缩放）+ 背景/透明度/壁纸为默认值（未改设置）",
    sameSize && baselineSame && lightView.innerWidth === 1440 && lightView.innerHeight === 940 && darkView.desktopClasses.includes("dark") && lightView.desktopClasses.includes("dark") === false && themeDark === true && lightView.localStorage["oa-opaque"] !== "true",
    "浅深截图同尺寸且与基准逐像素同尺寸 + innerWidth/Height=1440/940 + 主题类正确 + 未开不透明模式",
    JSON.stringify({ lightShot: { width: lightShot.width, height: lightShot.height, clip: lightShot.clip }, darkShot: { width: darkShot.width, height: darkShot.height, clip: darkShot.clip }, baseline, lightViewport: lightView, darkViewport: darkView }));
  record("V4", "视觉 · 对比度（规范 " + SPEC.design + "；门槛行 :248：「普通文本对比初始验收门槛为 4.5:1，大字为 3:1」；text.secondary 行 :64；次级说明字号行 :164）：浅色实测 " + light.contrastMeasuredPx + ":1（合成背景 " + light.bgMeasured + " / 字形像素 " + light.textMeasured + "）、深色实测 " + dark.contrastMeasuredPx + ":1（" + dark.bgMeasured + " / " + dark.textMeasured + "）；该行 " + light.fontSize + " / 字重 " + light.fontWeight + " → " + light.thresholdRule,
    light.passMeasured === true && dark.passMeasured === true && light.passSpecified === true && dark.passSpecified === true,
    "浅色与深色实测对比度均 >= 4.5:1（普通文本门槛）",
    JSON.stringify({ light, dark, spec: SPEC, formula: "WCAG 2.x：(L1+0.05)/(L2+0.05)，sRGB 线性化相对亮度" }));

  /* ── 动效：本批未新增动效 ── */
  const motionNormal = await js("const el = document.querySelector(" + JSON.stringify(noteSel) + "); if (!el) return null; const cs = getComputedStyle(el); return { transitionProperty: cs.transitionProperty, transitionDuration: cs.transitionDuration, transitionDelay: cs.transitionDelay, animationName: cs.animationName, animationDuration: cs.animationDuration };");
  const reducedOn = await setReduced(true);
  await closeSettings();
  await sleep(300);
  /* --dur-quick 在 .reduced 作用域里被重定义成 0ms（tokens.css:358）：必须在**元素自身**的计算样式上读，
     读 document.documentElement 拿到的是 :root 的 160ms，会把"已压掉"误判成"没压掉"。 */
  const motionReduced = await js("const el = document.querySelector(" + JSON.stringify(noteSel) + "); const d = document.querySelector('.desktop'); const root = getComputedStyle(document.documentElement); return { present: !!el, transitionProperty: el ? getComputedStyle(el).transitionProperty : null, transitionDuration: el ? getComputedStyle(el).transitionDuration : null, animationName: el ? getComputedStyle(el).animationName : null, animationDuration: el ? getComputedStyle(el).animationDuration : null, reduced: d.classList.contains('reduced'), durQuickElement: el ? getComputedStyle(el).getPropertyValue('--dur-quick').trim() : null, durQuickDesktop: getComputedStyle(d).getPropertyValue('--dur-quick').trim(), durQuickRoot: root.getPropertyValue('--dur-quick').trim(), text: el ? (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90) : null };");
  const reducedShot = await shotTo(path.join(VIS, "dark-reduced-session-expired.png"));
  const reducedOff = await setReduced(false);
  await closeSettings();
  const mcpCenterDiff = (() => {
    try {
      const d = execFileSync("git", ["-C", ROOT, "diff", "-U0", "--", "src/mcp/McpCenter.tsx"], { encoding: "utf8" });
      const changed = d.split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));
      return { changedLines: changed, allAreCopy: changed.length > 0 && changed.every((l) => /会话已结束（登出/.test(l)) };
    } catch { return null; }
  })();
  record("M1", "动效 · 本批未新增动效：该说明行在常规与减少动态效果下都没有过渡 / 动画（常规 transitionProperty=" + JSON.stringify(motionNormal && motionNormal.transitionProperty) + "、transitionDuration=" + JSON.stringify(motionNormal && motionNormal.transitionDuration) + "、animationName=" + JSON.stringify(motionNormal && motionNormal.animationName) + "）；减少动态效果下说明行自身 --dur-quick=" + JSON.stringify(motionReduced.durQuickElement) + "（.reduced 作用域已压到 0ms；:root 仍是 " + JSON.stringify(motionReduced.durQuickRoot) + "）且说明行仍完整显示（信息不丢）",
    !!motionNormal && motionNormal.animationName === "none" && isZeroDur(motionNormal.transitionDuration)
      && motionReduced.present === true && motionReduced.animationName === "none" && isZeroDur(motionReduced.transitionDuration) && isZeroDur(motionReduced.animationDuration)
      && reducedOn === true && motionReduced.reduced === true && motionReduced.durQuickElement === "0ms" && motionReduced.durQuickDesktop === "0ms" && !!motionReduced.text
      && !!(mcpCenterDiff && mcpCenterDiff.allAreCopy),
    "无 animation + 过渡 0s（常规与减少动态效果下都是）+ 减少动态效果下元素作用域 --dur-quick=0ms + 说明行仍显示 + McpCenter 本批只改了那一行文案",
    JSON.stringify({ normal: motionNormal, reduced: motionReduced, reducedOn, reducedOff, shot: reducedShot, mcpCenterDiff }));

  /* 视觉 / 动效阶段必须证明"会话 B 一直活着"（保活是合法活动）：否则截图可能拍的是过期后的空壳，证据无效 */
  const aliveAfterVisual = await js("const d = document.querySelector('.desktop'); return { gate: d?.getAttribute('data-identity-gate') || 'no-root', notePresent: !!document.querySelector(" + JSON.stringify(noteSel) + "), dark: d ? d.classList.contains('dark') : null, reduced: d ? d.classList.contains('reduced') : null };");
  const sessAfterVisual = dbSessions().find((s) => s.revoked_at == null) || null;
  record("V5", "视觉 / 动效阶段会话一直是活的（保活 = 只读身份命令，属合法活动）：截图 / 量测结束时 gate=" + aliveAfterVisual.gate + "、说明行仍在=" + aliveAfterVisual.notePresent + "、当前会话=" + (sessAfterVisual && sessAfterVisual.id) + "（revoked_at=" + JSON.stringify(sessAfterVisual && sessAfterVisual.revoked_at) + "）",
    aliveAfterVisual.gate === "ready" && aliveAfterVisual.notePresent === true && !!sessAfterVisual && sessAfterVisual.revoked_at == null && aliveAfterVisual.reduced === false,
    "gate=ready + 说明行仍在 + 会话未终结 + 减少动态效果已还原",
    JSON.stringify({ aliveAfterVisual, session: sessAfterVisual && { id: sessAfterVisual.id, revoked_at: sessAfterVisual.revoked_at, idle_expires_at: sessAfterVisual.idle_expires_at }, keepAlive: ka.state }));

  /* 既有动效未被本批触及：随手复测一条列表入场（只记录，不改第一 / 三批结论） */
  const tIns = Date.now();
  const insP = createViaUI({ name: "动效回归连接", transport: "stdio", location: "LOCAL_DEVICE", serverKey: "openarc-test-echo", authMode: "NONE", visibility: "PERSONAL" });
  let insSample = null;
  for (let i = 0; i < 20; i += 1) {
    const v = await js("const r = document.querySelector('.mcp-row.is-new'); return r ? { anim: getComputedStyle(r).animationName, dur: getComputedStyle(r).animationDuration } : null;").catch(() => null);
    if (v && v.anim && v.anim !== "none") { insSample = v; break; }
    await sleep(40);
  }
  const insRes = await insP;
  const insMs = Date.now() - tIns;
  note("既有动效抽样复测（本批未改列表动效，仅作记录，不改第一 / 三批结论）：列表入场 is-new → " + JSON.stringify(insSample) + "，建连耗时 " + insMs + "ms，connectionId=" + insRes.connectionId);
  if (insRes.connectionId) await mcpCmd("mcp/delete", { connectionId: insRes.connectionId });
  const kaState = ka.stop();
  note("视觉阶段保活（只发身份只读命令 identity/status，属合法活动，不触碰被测状态）：" + JSON.stringify({ ticks: kaState.ticks, errors: kaState.errors }));
  captureDbSnapshot("idle.final", [ids.idle]);

  /* 源码自证（场景 6 的第二半） */
  const src = sourceScan();
  record("6b", "无高频轮询自证 · 源码：到期链路文件（identity-service / identity-store / identity-domain / identity-bootstrap / mcp-bootstrap / mcp-service / runtime-boot / useIdentity / types / McpCenter）setInterval 合计 = " + src.setIntervalTotal + "；排程只有 " + src.scheduleSites + " 处 this.timers.setTimeout（句柄单字段 #expiryTimer：" + src.expiryTimerFieldRefs + " 处引用）；定时器与懒判定共用 domain.sessionExpiry",
    src.setIntervalTotal === 0 && src.scheduleSites === 1 && src.singleTimerComment === true && src.noIntervalComment === true && src.sharedVerdict === true && src.rendererUsesPureConvergence === true
      && src.mcpSessionEndEvents["identity/session-expired"] === "expired",
    "0 个 setInterval + 1 处排程 + 单句柄 + 共用判据 + 事件登记表含 session-expired→expired",
    JSON.stringify(src));
  note("在途定时器 <=1 的真机侧证据 = 权威事件恰好 1 次（6a）+ 4.2s 后服务端计数零变化（1j）；精确的在途定时器计数与出队旧回调不动新会话由 tests/identity-session-expiry.test.mjs（fakeTimers 注入计数）与 tests/d5-03-mcp-lifecycle.test.mjs L7 断言，本次一并重跑（见 artifact.timerUnitTests）。");

  const quit = await quitApp();
  note("退出路径：" + JSON.stringify(quit));
  return { launched, quit };
}

/* ══════════════════════════ 场景 2（extend） ══════════════════════════ */
async function runExtend() {
  const launched = await launch();
  await installEventProbe();
  const boot = await setupAndLogin();
  const refFx = await fx([], "reference-plain");
  const ref = await rawHttpHandshake(refFx.url);
  const exp = expectedFromReference(ref);
  const f = await fx(["--get-sse", "--get-sse-ids", "--get-sse-notify-interval=200"], "extend-idle");
  await openMcpWindow();
  const built = await uiBuildAndConnect("活动续期服务", f.url);
  const selected = await selectRow(built.connectionId);
  const t0 = Date.now();
  const s0 = dbSessions().find((s) => s.revoked_at == null) || null;
  if (!s0) throw new Error("没有活跃会话");
  const idleBefore = s0.idle_expires_at;
  const streamUp = await waitFor(async () => { const st = await f.state(); return !!st && st.getSse.openStreams === 1; }, 10000, 80);
  record("2a", "前置：idle=" + CFG.idleMs + "ms（绝对 " + CFG.ttlMs + "ms），t0 建连 + 选中详情后权威行 idle_expires_at - now = " + (idleBefore - Date.now()) + "ms；GET 流已建立、工具表等于参照握手",
    boot.ok === true && built.ok === true && selected === true && streamUp === true && idleBefore - Date.now() > 0 && exp.toolNames.length >= 2,
    "建连 ok + 详情 ready + 流 open + idle 到期点在将来",
    JSON.stringify({ built: { ok: built.ok, enabled: built.enabled, connectMs: built.connect.ms }, selected, session: s0, fixture: await f.state(), t0ISO: iso(t0) }));

  const activityAtTarget = t0 + 6000;
  if (activityAtTarget > Date.now()) await sleep(activityAtTarget - Date.now());
  const actStart = Date.now();
  const act = await mcpCmd("mcp/get", { connectionId: built.connectionId });
  const actMs = Date.now() - actStart;
  const s1 = dbSessions().find((s) => s.id === s0.id) || null;
  const idleAfter = s1 ? s1.idle_expires_at : null;
  const pushedMs = idleAfter != null ? idleAfter - idleBefore : null;
  const idleAfterMinusActStart = idleAfter != null ? idleAfter - actStart : null;
  measure("extend.activity", { activityAt: actStart, activityISO: iso(actStart), activityCommandMs: actMs, ok: !!(act && act.ok), idleBefore, idleBeforeISO: iso(idleBefore), idleAfter, idleAfterISO: iso(idleAfter), pushedMs, idleAfterMinusActStart, lastSeenAfter: s1 && s1.last_seen_at });
  record("2b", "t0+" + (actStart - t0) + "ms 用真实命令层做一次合法活动（mcp/get，经授权守卫 validateSession → #touch）：只读 DB 证明 idle_expires_at 从 " + iso(idleBefore) + " 推到 " + iso(idleAfter) + "（+" + pushedMs + "ms，= 活动时刻 + " + idleAfterMinusActStart + "ms ≈ idle " + CFG.idleMs + "ms）、last_seen_at=" + iso(s1 && s1.last_seen_at),
    !!(act && act.ok) && idleAfter != null && idleAfter > idleBefore && idleAfterMinusActStart >= CFG.idleMs - 300 && idleAfterMinusActStart <= CFG.idleMs + 3000 && s1.last_seen_at >= actStart - 50 && s1.last_seen_at <= actStart + 3000,
    "活动成功 + idle_expires_at = 活动时刻 + idle（" + CFG.idleMs + "ms ± 容差）+ last_seen_at 落在活动时刻",
    JSON.stringify({ measures: MEASURES["extend.activity"], newDueISO: iso(idleAfter) }));

  const checkpoint = Math.max(t0 + 11000, idleBefore + 3000);
  if (checkpoint > Date.now()) await sleep(checkpoint - Date.now());
  const chkAt = Date.now();
  const s2 = dbSessions().find((s) => s.id === s0.id) || null;
  const row2 = dbConnection(built.connectionId);
  const st2 = await f.state();
  const evAtChk = (await readEvents()) || [];
  const chk = measure("extend.checkpoint", { checkpointAt: chkAt, checkpointISO: iso(chkAt), msSinceT0: chkAt - t0, idleBeforeISO: iso(idleBefore), msPastOldDue: chkAt - idleBefore, sessionRevokedAt: s2 && s2.revoked_at, connStatus: row2 && row2.status, lastErrorCode: row2 && row2.last_error_code, enabled: row2 && row2.enabled, openStreams: st2 && st2.getSse.openStreams, expiryEvents: evAtChk.filter((e) => e.event === "identity/session-expired") });
  record("2c", "已越过原到期点（t0+" + (chkAt - t0) + "ms > 原到期 " + iso(idleBefore) + "，超出 " + (chkAt - idleBefore) + "ms）连接必须仍 READY、流仍开 —— 旧安排没有误关：会话 revoked_at=" + JSON.stringify(s2 && s2.revoked_at) + "、连接 status=" + (row2 && row2.status) + "、服务端 openStreams=" + (st2 && st2.getSse.openStreams) + "、渲染层过期事件 " + chk.expiryEvents.length + " 条",
    !!s2 && s2.revoked_at == null && !!row2 && row2.status === "READY" && row2.last_error_code == null && st2 && st2.getSse.openStreams === 1 && chk.expiryEvents.length === 0,
    "原到期点之后：会话未终结 + 连接 READY + 流仍开 + 0 过期事件",
    JSON.stringify({ ...chk, addendum: "检查点的 READY 只从只读 DB + 服务端计数读，不发 mcp 命令（否则会再次续期）" }));

  const rev = await waitRevoked(s2.ref, Math.max(25000, idleAfter - Date.now() + 15000));
  const revRow = rev && rev.row ? rev.row : null;
  const revokedAt = revRow ? revRow.revoked_at : null;
  const deviationMs = Number.isFinite(revokedAt) && Number.isFinite(idleAfter) ? revokedAt - idleAfter : null;
  const events = (await readEvents()) || [];
  const expired = events.filter((e) => e.event === "identity/session-expired");
  const collected = await waitFor(async () => { const st = await f.state(); return !!st && st.getSse.openStreams === 0; }, 8000, 60);
  const collectedAt = Date.now();
  const row3 = dbConnection(built.connectionId);
  const ended = dbLogs(built.connectionId, 8).filter((l) => l.event === "SESSION_ENDED");
  measure("extend.expiry", { dueAt: idleAfter, dueAtISO: iso(idleAfter), revokedAt, revokedAtISO: iso(revokedAt), deviationMs, eventRecvAt: expired[0] && expired[0].at, eventDelayMs: expired[0] && revokedAt ? expired[0].at - revokedAt : null, collectedAtISO: iso(collectedAt), collectAfterRevokeMs: revokedAt ? collectedAt - revokedAt : null, revokedReason: revRow && revRow.revoked_reason });
  record("2d", "最后一次活动 + idle（" + iso(idleAfter) + "）才到期：revoked_at=" + iso(revokedAt) + "，偏差 " + deviationMs + "ms（上界 " + EXPIRY_BOUND_MS + "ms）；收流 1→0（" + (revokedAt ? collectedAt - revokedAt : null) + "ms）；日志 detail=" + (ended[0] && ended[0].detail) + "；enabled=1 未改写",
    collected === true && Number.isFinite(revokedAt) && deviationMs != null && deviationMs >= 0 && deviationMs <= EXPIRY_BOUND_MS
      && expired.length === 1 && expired[0].reason === "idle" && !!row3 && Number(row3.enabled) === 1 && row3.status === "DISABLED" && row3.last_error_code === "MCP_SESSION_ENDED"
      && ended.length === 1 && ended[0].detail === "expired:idle" && revRow.revoked_reason === identityDomain.REVOKE_REASON.EXPIRED,
    "到期点 = 最后一次活动 + idle（偏差 <= " + EXPIRY_BOUND_MS + "ms）+ 1 条 idle 事件 + 收流 + enabled=1 + detail=expired:idle",
    JSON.stringify({ measures: MEASURES["extend.expiry"], events, row: row3 && { status: row3.status, last_error_code: row3.last_error_code, enabled: row3.enabled }, endedLogs: ended, timeline: { t0ISO: iso(t0), activityISO: iso(actStart), oldDueISO: iso(idleBefore), checkpointISO: iso(chkAt), newDueISO: iso(idleAfter), revokedAtISO: iso(revokedAt) } }));
  captureDbSnapshot("extend.final", [built.connectionId]);
  const quit = await quitApp();
  return { launched, quit };
}

/* ══════════════════════════ 场景 3（absolute） ══════════════════════════ */
async function runAbsolute() {
  const launched = await launch();
  await installEventProbe();
  const refFx = await fx([], "reference-plain");
  const ref = await rawHttpHandshake(refFx.url);
  const exp = expectedFromReference(ref);
  const boot = await setupAndLogin();
  const f = await fx(["--get-sse", "--get-sse-ids", "--get-sse-notify-interval=200"], "absolute-expiry");
  await openMcpWindow();
  const built = await uiBuildAndConnect("绝对到期服务", f.url);
  const selected = await selectRow(built.connectionId);
  const s0 = dbSessions().find((s) => s.revoked_at == null) || null;
  if (!s0) throw new Error("没有活跃会话");
  const absDue = s0.expires_at;
  const streamUp = await waitFor(async () => { const st = await f.state(); return !!st && st.getSse.openStreams === 1; }, 10000, 80);
  record("3a", "前置：idle=" + CFG.idleMs + "ms（远大于观察窗）、absolute=" + CFG.ttlMs + "ms；绝对到期点 = " + iso(absDue) + "（相对现在 " + (absDue - Date.now()) + "ms）；GET 流已建立、工具表等于参照握手",
    boot.ok === true && built.ok === true && selected === true && streamUp === true && absDue - Date.now() > 0 && CFG.idleMs > CFG.ttlMs && exp.toolNames.length >= 2,
    "建连 ok + 流 open + absolute 到期点在将来且早于 idle 期限",
    JSON.stringify({ built: { ok: built.ok, connectMs: built.connect.ms }, session: s0, fixture: await f.state(), absDueISO: iso(absDue), toolsHash: exp.toolsHash }));

  const ticks = [];
  const evP = (async () => {
    for (let i = 0; i < 900; i += 1) {
      const list = await expiredEvents().catch(() => []);
      if (Array.isArray(list) && list.length) return list;
      await sleep(50);
    }
    return null;
  })();
  while (Date.now() < absDue - 900) {
    const at = Date.now();
    const res = await identityCmd("identity/status");
    const s = dbSessions().find((x) => x.id === s0.id) || null;
    ticks.push({ at, atISO: iso(at), ok: !!(res && res.ok), idleExpiresAt: s && s.idle_expires_at, idleHorizonMs: s ? s.idle_expires_at - at : null, lastSeenAt: s && s.last_seen_at, revokedAt: s && s.revoked_at });
    const next = at + 2000;
    if (next < absDue - 600) await sleep(Math.max(0, next - Date.now()));
    else break;
  }
  const lastTick = ticks[ticks.length - 1] || null;
  const idleAtLastTick = lastTick ? lastTick.idleExpiresAt : null;
  const rev = await waitRevoked(s0.ref, Math.max(15000, absDue - Date.now() + 12000));
  const revRow = rev && rev.row ? rev.row : null;
  const revokedAt = revRow ? revRow.revoked_at : null;
  const deviationMs = Number.isFinite(revokedAt) && Number.isFinite(absDue) ? revokedAt - absDue : null;
  const expired = (await evP) || [];
  const collected = await waitFor(async () => { const st = await f.state(); return !!st && st.getSse.openStreams === 0; }, 8000, 60);
  const collectedAt = Date.now();
  const row = dbConnection(built.connectionId);
  const ended = dbLogs(built.connectionId, 8).filter((l) => l.event === "SESSION_ENDED");
  measure("absolute.expiry", { idleMs: CFG.idleMs, ttlMs: CFG.ttlMs, absDue, absDueISO: iso(absDue), activityTicks: ticks, idleExpiresAtAtLastActivity: idleAtLastTick, idleHorizonRemainingMs: idleAtLastTick ? idleAtLastTick - absDue : null, revokedAt, revokedAtISO: iso(revokedAt), deviationMs, revokedReason: revRow && revRow.revoked_reason, eventAt: expired[0] && expired[0].at, eventReason: expired[0] && expired[0].reason, eventDelayMs: expired[0] && revokedAt ? expired[0].at - revokedAt : null, collectAfterRevokeMs: revokedAt ? collectedAt - revokedAt : null });
  record("3b", "空闲永不到期（最后一次活动把 idle_expires_at 推到 " + iso(idleAtLastTick) + " = 绝对到期后 " + (idleAtLastTick - absDue) + "ms）→ 仍在绝对到期点 " + iso(absDue) + " 收流：revoked_at=" + iso(revokedAt) + "（偏差 " + deviationMs + "ms <= " + EXPIRY_BOUND_MS + "ms）、事件 reason=" + (expired[0] && expired[0].reason) + "、日志 detail=" + (ended[0] && ended[0].detail) + "、收流 1→0（" + (revokedAt ? collectedAt - revokedAt : null) + "ms）、enabled=1 未改写",
    collected === true && ticks.length >= 3 && ticks.every((t) => t.ok === true && t.revokedAt == null) && idleAtLastTick != null && idleAtLastTick > absDue
      && Number.isFinite(revokedAt) && deviationMs != null && deviationMs >= 0 && deviationMs <= EXPIRY_BOUND_MS
      && expired.length === 1 && expired[0].reason === "absolute" && !!row && row.status === "DISABLED" && row.last_error_code === "MCP_SESSION_ENDED" && Number(row.enabled) === 1
      && ended.length === 1 && ended[0].detail === "expired:absolute" && revRow.revoked_reason === identityDomain.REVOKE_REASON.EXPIRED,
    ">=3 次合法活动且期间无到期 + idle 期限晚于绝对到期 + 绝对点偏差 <= " + EXPIRY_BOUND_MS + "ms + reason=absolute + detail=expired:absolute + enabled=1",
    JSON.stringify({ measures: MEASURES["absolute.expiry"], row: row && { status: row.status, last_error_code: row.last_error_code, enabled: row.enabled }, endedLogs: ended, events: await readEvents() }));
  captureDbSnapshot("absolute.final", [built.connectionId]);
  const quit = await quitApp();
  return { launched, quit };
}

/* ══════════════════════════ 场景 4（relogin） ══════════════════════════ */
async function runRelogin() {
  const launched = await launch();
  await installEventProbe();
  const boot = await setupAndLogin();
  const refFx = await fx([], "reference-plain");
  const ref = await rawHttpHandshake(refFx.url);
  const exp = expectedFromReference(ref);
  const fA = await fx(["--get-sse", "--get-sse-ids", "--get-sse-notify-interval=200"], "sessionA");
  await openMcpWindow();
  const aBuild = await uiBuildAndConnect("会话 A 的连接", fA.url);
  await selectRow(aBuild.connectionId);
  const t0 = Date.now();
  const sessA = dbSessions().find((s) => s.revoked_at == null) || null;
  if (!sessA) throw new Error("没有活跃会话 A");
  const aDue = sessA.idle_expires_at;
  const aUp = await waitFor(async () => { const st = await fA.state(); return !!st && st.getSse.openStreams === 1; }, 10000, 80);
  record("4a", "t0 登录（会话 A=" + sessA.id + "）+ 界面表单建连 + GET 流建立；A 的到期点 = " + iso(aDue) + "（t0+" + (aDue - t0) + "ms）",
    boot.ok === true && aBuild.ok === true && aUp === true && !!sessA && exp.toolNames.length >= 2,
    "登录 + 建连 + 流 open + A 有到期点",
    JSON.stringify({ sessA, aDueISO: iso(aDue), t0ISO: iso(t0), fixture: await fA.state() }));

  const target = t0 + 5000;
  if (target > Date.now()) await sleep(target - Date.now());
  const kickAt = Date.now();
  const out = await logout();
  const fB = await fx(["--get-sse", "--get-sse-ids", "--get-sse-notify-interval=200"], "sessionB");
  const inAt = Date.now();
  const back = await login(ADMIN.id, ADMIN.pw);
  const sessB = dbSessions().find((s) => s.revoked_at == null) || null;
  if (!sessB) throw new Error("没有活跃会话 B");
  const bBuild = await createConn("会话 B 的连接", { url: fB.url });
  const bConnect = bBuild.connectionId ? await connectMeasured(bBuild.connectionId) : { res: null, ms: null };
  const bUp = await waitFor(async () => { const st = await fB.state(); return !!st && st.getSse.openStreams === 1; }, 10000, 80);
  const bDue = sessB.idle_expires_at;
  record("4b", "t0+" + (kickAt - t0) + "ms 真实 UI 登出（" + out + "）→ t0+" + (inAt - t0) + "ms 重新登录（会话 B=" + sessB.id + "，与 A 不同：id " + (sessB.id !== sessA.id) + " / ref " + (sessB.ref !== sessA.ref) + "）+ 建 B 的连接 + GET 流建立；B 的到期点 = " + iso(bDue),
    out === true && back === true && sessB.id !== sessA.id && sessB.ref !== sessA.ref && bConnect.res && bConnect.res.ok === true && bUp === true,
    "登出 ok + 登录 ok + B 是新会话（id/ref 都不同）+ B 连接 READY + B 流 open",
    JSON.stringify({ out, back, sessA: { id: sessA.id, ref: sessA.ref }, sessB, bConnect: { ok: !!(bConnect.res && bConnect.res.ok), ms: bConnect.ms }, bDueISO: iso(bDue), fixtureB: await fB.state() }));

  const chk = Math.max(aDue + 300, Date.now());
  if (chk > Date.now()) await sleep(chk - Date.now());
  const chkAt = Date.now();
  const sessA2 = dbSessions().find((s) => s.id === sessA.id) || null;
  const sessB2 = dbSessions().find((s) => s.id === sessB.id) || null;
  const rowB = dbConnection(bBuild.connectionId);
  const stB = await fB.state();
  const evs = (await readEvents()) || [];
  const chkMeasure = measure("relogin.checkpoint", { aDueISO: iso(aDue), chkAtISO: iso(chkAt), msPastADue: chkAt - aDue, sessionA: sessA2 && { id: sessA2.id, revoked_at: sessA2.revoked_at, revoked_reason: sessA2.revoked_reason }, sessionB: sessB2 && { id: sessB2.id, revoked_at: sessB2.revoked_at, idle_expires_at: sessB2.idle_expires_at }, connB: rowB && { status: rowB.status, last_error_code: rowB.last_error_code, enabled: rowB.enabled }, openStreamsB: stB && stB.getSse.openStreams, expiryEvents: evs.filter((e) => e.event === "identity/session-expired") });
  record("4c", "到 A 的原到期点（+" + (chkAt - aDue) + "ms）：B 的连接仍 READY、B 的 GET 流仍开、B 会话未终结，且渲染层 0 条过期事件 —— 旧安排没有关掉随后登录的新会话（A 的状态：" + JSON.stringify(sessA2 && { revoked_reason: sessA2.revoked_reason }) + "）",
    sessB2 && sessB2.revoked_at == null && !!rowB && rowB.status === "READY" && rowB.last_error_code == null && stB && stB.getSse.openStreams === 1 && chkMeasure.expiryEvents.length === 0,
    "A 到期点之后：B 会话未终结 + B 连接 READY + B 流仍开 + 0 过期事件",
    JSON.stringify({ ...chkMeasure, fixtureA: await fA.state(), fixtureB: stB, note: "检查点只读（DB + 服务端计数），不发 mcp 命令，避免给 B 续期" }));

  const rev = await waitRevoked(sessB.ref, Math.max(25000, bDue - Date.now() + 15000));
  const revRow = rev && rev.row ? rev.row : null;
  const revokedAt = revRow ? revRow.revoked_at : null;
  const deviationMs = Number.isFinite(revokedAt) && Number.isFinite(bDue) ? revokedAt - bDue : null;
  const expired = (await readEvents() || []).filter((e) => e.event === "identity/session-expired");
  const collected = await waitFor(async () => { const st = await fB.state(); return !!st && st.getSse.openStreams === 0; }, 10000, 60);
  const collectedAt = Date.now();
  const rowB2 = dbConnection(bBuild.connectionId);
  const endedB = dbLogs(bBuild.connectionId, 8).filter((l) => l.event === "SESSION_ENDED");
  const rowA2 = dbConnection(aBuild.connectionId);
  const endedA = dbLogs(aBuild.connectionId, 8).filter((l) => l.event === "SESSION_ENDED");
  measure("relogin.expiry", { bDueISO: iso(bDue), revokedAtISO: iso(revokedAt), deviationMs, eventReason: expired[0] && expired[0].reason, eventSessionId: expired[0] && expired[0].sessionId, eventAt: expired[0] && expired[0].at, collectAfterRevokeMs: revokedAt ? collectedAt - revokedAt : null });
  record("4d", "B 在自己最后一次活动 + idle（" + iso(bDue) + "）到期：revoked_at=" + iso(revokedAt) + "（偏差 " + deviationMs + "ms）、唯一过期事件绑定的是 B（sessionId=" + (expired[0] && expired[0].sessionId) + "）、B 连接收流并落 DISABLED / MCP_SESSION_ENDED / detail=expired:idle；A 的连接记录保持登出时的 SESSION_ENDED(detail=" + (endedA[0] && endedA[0].detail) + ") 未被二次改写",
    collected === true && Number.isFinite(revokedAt) && deviationMs != null && Math.abs(deviationMs) <= EXPIRY_BOUND_MS && expired.length === 1
      && expired[0].sessionId === sessB.id && !!rowB2 && rowB2.status === "DISABLED" && rowB2.last_error_code === "MCP_SESSION_ENDED" && Number(rowB2.enabled) === 1
      && endedB.length === 1 && endedB[0].detail === "expired:idle"
      && !!rowA2 && rowA2.status === "DISABLED" && rowA2.last_error_code === "MCP_SESSION_ENDED" && endedA.length === 1 && endedA[0].detail === "logout",
    "偏差 <= " + EXPIRY_BOUND_MS + "ms + 1 条事件且 sessionId=B + B 连接 SESSION_ENDED(expired:idle) + A 连接仍是 SESSION_ENDED(logout) 单条",
    JSON.stringify({ measures: MEASURES["relogin.expiry"], rowB: rowB2 && { status: rowB2.status, last_error_code: rowB2.last_error_code, enabled: rowB2.enabled }, rowA: rowA2 && { status: rowA2.status, last_error_code: rowA2.last_error_code, enabled: rowA2.enabled }, endedB, endedA, fixtureA: await fA.state(), fixtureB: await fB.state() }));
  captureDbSnapshot("relogin.final", [aBuild.connectionId, bBuild.connectionId]);
  const quit = await quitApp();
  return { launched, quit };
}

/* ══════════════════════════ 场景 5（regress：登出 / 锁屏 / 撤权） ══════════════════════════ */
async function runRegress() {
  const launched = await launch();
  await installEventProbe();
  const boot = await setupAndLogin();
  await openMcpWindow();
  const refFx = await fx([], "reference-plain");
  const ref = await rawHttpHandshake(refFx.url);
  const exp = expectedFromReference(ref);
  const out = {};

  const fa = await fx(["--get-sse", "--get-sse-ids", "--get-sse-notify-interval=200"], "logout-path");
  const a = await uiBuildAndConnect("登出收流服务", fa.url);
  await selectRow(a.connectionId);
  const aUp = await waitFor(async () => { const st = await fa.state(); return !!st && st.getSse.openStreams === 1; }, 10000, 80);
  const aOut = await logout();
  const aCollected = await waitFor(async () => { const st = await fa.state(); return !!st && st.getSse.openStreams === 0; }, 10000, 60);
  const aRow = dbConnection(a.connectionId);
  const aEnded = dbLogs(a.connectionId, 8).filter((l) => l.event === "SESSION_ENDED");
  out.logout = { up: aUp, collected: aCollected, row: aRow && { enabled: aRow.enabled, status: aRow.status, last_error_code: aRow.last_error_code }, ended: aEnded };
  record("5a", "既有路径 · 登出（真实 UI 顶栏退出）：流 1→0、enabled=1 未改写、DISABLED + MCP_SESSION_ENDED、日志 SESSION_ENDED 恰好 1 条且 detail=logout（第三批口径未变）",
    aOut === true && aUp === true && aCollected === true && !!aRow && Number(aRow.enabled) === 1 && aRow.status === "DISABLED" && aRow.last_error_code === "MCP_SESSION_ENDED"
      && aEnded.length === 1 && aEnded[0].detail === "logout",
    "登出 + 流 1→0 + enabled=1 / DISABLED / MCP_SESSION_ENDED + 1 条 detail=logout",
    JSON.stringify(out.logout));

  const back = await login(ADMIN.id, ADMIN.pw);
  const fb = await fx(["--get-sse", "--get-sse-ids", "--get-sse-notify-interval=200"], "lock-path");
  const b = await createConn("锁屏收流服务", { url: fb.url });
  const bConnect = await connectMeasured(b.connectionId);
  const bUp = await waitFor(async () => { const st = await fb.state(); return !!st && st.getSse.openStreams === 1; }, 10000, 80);
  const bLocked = await lockScreen();
  const bCollected = await waitFor(async () => { const st = await fb.state(); return !!st && st.getSse.openStreams === 0; }, 10000, 60);
  const bRow = dbConnection(b.connectionId);
  const bEnded = dbLogs(b.connectionId, 8).filter((l) => l.event === "SESSION_ENDED");
  const bUnlocked = await unlockScreen();
  out.lock = { relogin: back, connectOk: !!(bConnect.res && bConnect.res.ok), up: bUp, locked: bLocked, collected: bCollected, row: bRow && { enabled: bRow.enabled, status: bRow.status, last_error_code: bRow.last_error_code }, ended: bEnded, unlocked: bUnlocked, gateAfterUnlock: await gate() };
  record("5b", "既有路径 · 锁屏（真实 UI 顶栏「锁定」）：流 1→0、enabled=1 未改写、DISABLED + MCP_SESSION_ENDED、日志 SESSION_ENDED 恰好 1 条且 detail=user（第三批口径未变）；解锁后回到 ready",
    back === true && bConnect.res && bConnect.res.ok === true && bUp === true && bLocked === true && bCollected === true && !!bRow && Number(bRow.enabled) === 1
      && bRow.status === "DISABLED" && bRow.last_error_code === "MCP_SESSION_ENDED" && bEnded.length === 1 && bEnded[0].detail === "user" && bUnlocked === true,
    "锁屏 + 流 1→0 + enabled=1 / DISABLED / MCP_SESSION_ENDED + 1 条 detail=user + 解锁回 ready",
    JSON.stringify(out.lock));

  const fc = await fx(["--get-sse", "--get-sse-ids", "--get-sse-notify-interval=200"], "revoke-path");
  const c = await createConn("撤权收流服务", { url: fc.url });
  const cConnect = await connectMeasured(c.connectionId);
  const cUp = await waitFor(async () => { const st = await fc.state(); return !!st && st.getSse.openStreams === 1; }, 10000, 80);
  const access = await governance({ type: "governance/getAppAccess", appId: "mcp-center" });
  const grant = access && access.ok ? (access.grants || []).find((g) => g.resourceType === "mcp") : null;
  const revoked = grant ? await governance({ type: "governance/revokeAppAccess", grantId: grant.grantId }) : { ok: false, error: "NO_MCP_GRANT" };
  const cCollected = await waitFor(async () => { const st = await fc.state(); return !!st && st.getSse.openStreams === 0; }, 10000, 60);
  const cRow = dbConnection(c.connectionId);
  const cRevoked = dbLogs(c.connectionId, 8).filter((l) => l.event === "AUTHORIZATION_REVOKED");
  const regrant = await governance({ type: "governance/grantAppAccess", appId: "mcp-center", resourceType: "mcp", actions: [...domain.MCP_ACTIONS_ALL] });
  const listBack = await waitFor(async () => (await mcpCmd("mcp/list")).ok === true, 15000, 300);
  out.revoke = { connectOk: !!(cConnect.res && cConnect.res.ok), up: cUp, revoked: { ok: revoked.ok, error: revoked.error || null }, collected: cCollected, row: cRow && { enabled: cRow.enabled, status: cRow.status, last_error_code: cRow.last_error_code }, revokedLogs: cRevoked, regrant: { ok: regrant.ok, error: regrant.error || null }, listBack };
  record("5c", "既有路径 · 撤权（governance/revokeAppAccess 撤掉 mcp-center 的 mcp.*）：流 1→0、enabled=1 未改写、ERROR + MCP_UNAUTHORIZED、日志 AUTHORIZATION_REVOKED 恰好 1 条且 detail=app-grant-revoked（第三批口径未变）；随后经正式治理入口恢复",
    cConnect.res && cConnect.res.ok === true && cUp === true && revoked.ok === true && cCollected === true && !!cRow && Number(cRow.enabled) === 1
      && cRow.status === "ERROR" && cRow.last_error_code === "MCP_UNAUTHORIZED" && cRevoked.length === 1 && cRevoked[0].detail === "app-grant-revoked"
      && regrant.ok === true && listBack === true,
    "撤权 + 流 1→0 + enabled=1 / ERROR / MCP_UNAUTHORIZED + 1 条 detail=app-grant-revoked + 正式重授后可用",
    JSON.stringify(out.revoke));

  const invCommands = ["mcp/callTool", "mcp/call", "mcp/invoke", "mcp/invokeTool", "mcp/toolCall"];
  const inv = {};
  for (const command of invCommands) inv[command] = await mcpCmd(command, { connectionId: c.connectionId, name: "echo_sum", arguments: { a: 1, b: 2 } });
  const unknown = await mcpCmd("mcp/toolsInvoke", { connectionId: c.connectionId });
  const proto = await connState(c.connectionId);
  record("5d", "边界回归：5 个工具调用入口仍全部 MCP_TOOL_INVOCATION_NOT_ENABLED、未登记命令仍 MCP_COMMAND_NOT_ALLOWED、协议仍是 " + domain.MCP_PROTOCOL_VERSION,
    invCommands.every((k) => inv[k].ok === false && inv[k].error === "MCP_TOOL_INVOCATION_NOT_ENABLED") && unknown.ok === false && unknown.error === "MCP_COMMAND_NOT_ALLOWED"
      && !!proto.connection && proto.connection.protocolVersion === domain.MCP_PROTOCOL_VERSION && domain.MCP_PROTOCOL_VERSION === "2025-06-18",
    "5 个入口全 MCP_TOOL_INVOCATION_NOT_ENABLED + 未知命令 MCP_COMMAND_NOT_ALLOWED + protocolVersion=2025-06-18",
    JSON.stringify({ inv, unknown: { ok: unknown.ok, error: unknown.error }, protocolVersion: proto.connection && proto.connection.protocolVersion, constant: domain.MCP_PROTOCOL_VERSION, referenceTools: exp.toolNames }));
  for (const cid of ((await mcpCmd("mcp/list")).items || []).map((i) => i.connectionId)) await mcpCmd("mcp/delete", { connectionId: cid });
  captureDbSnapshot("regress.final", [a.connectionId, b.connectionId, c.connectionId]);
  const quit = await quitApp();
  return { launched, quit };
}

/* ══════════════════════════ 场景 7a（override-deny） ══════════════════════════ */
async function runOverrideDeny() {
  const launched = await launch();
  await setupAndLogin();
  const ov = overrideEvidence();
  const lines = stdoutTtlLines();
  const denyLine = lines[0] || "";
  const sess = dbSessions().find((s) => s.revoked_at == null) || null;
  if (!sess) throw new Error("没有活跃会话");
  const idleDelta = sess.idle_expires_at - sess.created_at;
  const ttlDelta = sess.expires_at - sess.created_at;
  /* idle_expires_at 在登录后会被 #touch 重写成"最后一次活动 + idleMs"，所以它与 created_at 的差会比默认值多出
     登录/恢复那几毫秒；绝对上限 expires_at 不受 touch 影响，必须与默认值完全相等。 */
  const idleHorizonMs = sess.idle_expires_at - Date.now();
  const idleIsDefault = idleDelta >= ov.storeDefaults.idleMs && idleDelta <= ov.storeDefaults.idleMs + 60000 && idleHorizonMs > 3600000;
  measure("overrideDeny", { stdoutLines: lines, session: { id: sess.id, createdAtISO: iso(sess.created_at), expiresAtISO: iso(sess.expires_at), idleExpiresAtISO: iso(sess.idle_expires_at), idleDeltaMs: idleDelta, ttlDeltaMs: ttlDelta, idleHorizonMs, touchDriftMs: idleDelta - ov.storeDefaults.idleMs }, defaults: ov.storeDefaults, requested: { idleMs: CFG.idleMs, ttlMs: CFG.ttlMs }, resolver: { applied: ov.noAck.applied, record: ov.noAck.records[0] } });
  record("7a", "开关自证 (a)：给了 OPENARC_SESSION_IDLE_MS=" + CFG.idleMs + " / OPENARC_SESSION_TTL_MS=" + CFG.ttlMs + " 但**不给** " + ov.ackEnv + " → 整体忽略并留痕（日志：" + JSON.stringify(denyLine.slice(0, 200)) + "）；只读 DB 证明权威行仍是默认有效期：idle_expires_at - created_at = " + idleDelta + "ms（默认 " + ov.storeDefaults.idleMs + " + 登录 touch 漂移 " + (idleDelta - ov.storeDefaults.idleMs) + "ms，距今 " + idleHorizonMs + "ms）、expires_at - created_at = " + ttlDelta + "ms（默认 " + ov.storeDefaults.ttlMs + " 整）",
    lines.length === 1 && /忽略 OPENARC_SESSION_IDLE_MS/.test(denyLine) && /沿用默认有效期/.test(denyLine)
      && idleIsDefault && ttlDelta === ov.storeDefaults.ttlMs && ttlDelta !== CFG.ttlMs
      && ov.noAck.applied === false && ov.noAck.records[0].result === "DENY" && ov.noAck.records[0].error_code === "OVERRIDE_NOT_ACKNOWLEDGED",
    "1 条忽略日志 + DB 绝对上限 = 默认 12h 整、idle 期限 = 默认 2h（含登录后 touch 的毫秒漂移，远期 >1h；都不等于注入值 8s/60s）",
    JSON.stringify({ measures: MEASURES.overrideDeny, ackEnv: ov.ackEnv, minMs: ov.minMs }));
  record("7a-2", "开关自证 (a) 补充：同一注入值**加上** ack 后解析结果确实生效（证明上一条不是因为值本身非法而被拒）",
    ov.withAck.applied === true && ov.withAck.sessionIdleMs === CFG.idleMs && ov.withAck.sessionTtlMs === CFG.ttlMs,
    "同值 + ack → applied=true 且值一致",
    JSON.stringify({ withAck: { applied: ov.withAck.applied, idleMs: ov.withAck.sessionIdleMs, ttlMs: ov.withAck.sessionTtlMs, record: ov.withAck.records[0] }, noAck: { applied: ov.noAck.applied, error_code: ov.noAck.records[0].error_code } }));
  captureDbSnapshot("overrideDeny.final", []);
  const quit = await quitApp();
  return { launched, quit };
}

/* ══════════════════════════ 既有证据保护 / 环境 ══════════════════════════ */
function snapshotRunsEvidence() {
  const runsDir = path.join(ROOT, "artifacts", "d5-03", "runs");
  const out = {};
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      const r = rel ? rel + "/" + name : name;
      if (st.isDirectory()) walk(p, r);
      else if (/^index\.(json|jsonl)$/.test(name)) out[r] = { bytes: st.size, mtimeMs: Math.round(st.mtimeMs), sha256_16: null, appendOnly: true };
      else out[r] = { bytes: st.size, mtimeMs: Math.round(st.mtimeMs), sha256_16: sha16(fs.readFileSync(p)), appendOnly: false };
    }
  };
  walk(runsDir, "");
  return out;
}
function diffRunsEvidence(before, after) {
  const changed = [], added = [], removed = [];
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) { added.push(k); continue; }
    if (before[k].bytes !== v.bytes || before[k].mtimeMs !== v.mtimeMs || (v.sha256_16 && before[k].sha256_16 !== v.sha256_16)) changed.push(k);
  }
  for (const k of Object.keys(before)) if (!(k in after)) removed.push(k);
  return { changed, added, removed };
}
function runTimerUnitTests() {
  try {
    const out = execFileSync(process.execPath, ["--test", "tests/identity-session-expiry.test.mjs", "tests/d5-03-mcp-lifecycle.test.mjs"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, tail: out.split("\n").filter(Boolean).slice(-16), full: out.split("\n").filter((l) => /^(# (pass|fail|tests)|not ok)/.test(l)).slice(0, 40) };
  } catch (e) {
    const text = String((e && (e.stdout || e.message)) || e);
    return { ok: false, tail: text.split("\n").filter(Boolean).slice(-16), full: text.split("\n").filter((l) => /^(# (pass|fail|tests)|not ok)/.test(l)).slice(0, 40) };
  }
}

/* ══════════════════════════ 主流程 ══════════════════════════ */
async function main() {
  RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: SCRIPT_NAME, basePort: CDP_PORT_BASE, envBaseVar: "OA_D503_EXPIRY_CDP_PORT", userDataPrefixBase: USERDATA_PREFIX_BASE });
  USERDATA_PREFIX = RUN.userDataPrefix;
  RESERVED_PORT = await RUN.acquirePort(CDP_PORT_BASE);
  CDP_PORT = RESERVED_PORT.port;
  VIS = path.join(RUN.runDir, "visual");
  fs.mkdirSync(VIS, { recursive: true });
  const runsEvidenceBefore = snapshotRunsEvidence();
  console.log("本次运行：" + RUN.runId + " → " + RUN.runDirRel + "（场景 " + SCENARIO + "：" + CFG.title + "；CDP " + CDP_PORT + "，userData 前缀 " + USERDATA_PREFIX + "）");
  console.log("注入的 TTL：" + JSON.stringify({ ack: CFG.ack, idleMs: CFG.idleMs, ttlMs: CFG.ttlMs, defaults: { idleMs: identityStoreModule.DEFAULT_IDLE_MS, ttlMs: identityStoreModule.DEFAULT_TTL_MS }, minMs: identityBootstrap.SESSION_TTL_OVERRIDE.MIN_MS }));
  console.log("规范版本：" + JSON.stringify(SPEC));
  console.log("基准视觉目录：" + BASELINE_VISUAL_DIR);

  const R = { idle: runIdle, extend: runExtend, absolute: runAbsolute, relogin: runRelogin, regress: runRegress, "override-deny": runOverrideDeny }[SCENARIO];
  const result = await R();

  CLEANUP = await cleanupOwnProcesses();
  const leftover = leftoverTempDirs();
  const timerUnit = SCENARIO === "idle" ? runTimerUnitTests() : { skipped: SCENARIO, reason: "定时器接缝单测只在 idle 场景跑一次（避免重复启动测试进程）" };
  if (SCENARIO === "idle") note("定时器接缝单测（到期调度在途 <=1 / 出队旧回调 / 无 setInterval）：" + JSON.stringify(timerUnit.full));

  const runsEvidenceAfter = snapshotRunsEvidence();
  const runsDiff = diffRunsEvidence(runsEvidenceBefore, runsEvidenceAfter);
  const touchedExisting = runsDiff.changed.filter((k) => !k.startsWith(RUN.runId + "/") && !/^index\.(json|jsonl)$/.test(k));
  const mine = runsDiff.added.filter((k) => k.startsWith(RUN.runId + "/"));
  record("Z1", "既有证据未被触碰：本次运行前已存在的 artifacts/d5-03/runs/** 文件在运行后逐字节一致（被改写的既有文件 = " + JSON.stringify(touchedExisting) + "，被删的 = " + JSON.stringify(runsDiff.removed) + "；index.json / index.jsonl 由 run-artifacts.cjs 只追加维护，单独列出）",
    touchedExisting.length === 0 && runsDiff.removed.length === 0,
    "0 个既有证据文件被改写 / 删除（索引只追加）",
    JSON.stringify({ changedExisting: touchedExisting, removed: runsDiff.removed, appendOnlyIndexChanged: runsDiff.changed.filter((k) => /^index\.(json|jsonl)$/.test(k)), addedCount: runsDiff.added.length, addedMine: mine.length }));
  record("Z2", "临时 userData 归属清理：本次运行自建目录已全部删除（cleanup.userDataDirsRemoved=" + JSON.stringify(CLEANUP.userDataDirsRemoved) + "，保留=" + JSON.stringify(CLEANUP.userDataDirsKept) + "）；运行结束后 " + USERDATA_PREFIX_BASE + "* 残留 = " + JSON.stringify((leftover || []).map((d) => ({ name: d.name, isMine: d.isMine }))) ,
    CLEANUP.userDataDirsRemoved.length >= 1 && CLEANUP.userDataDirsKept.length === 0 && Array.isArray(leftover) && leftover.filter((d) => d.isMine).length === 0,
    "本次自建 userData 全部删除 + 无本脚本残留（pkillUsed=false，只清自己的 pid 树）",
    JSON.stringify({ cleanup: CLEANUP, leftover, prefix: USERDATA_PREFIX_BASE }));
  if (SCENARIO === "idle") {
    record("6c", "无高频轮询自证 · 注入式定时器单测重跑（tests/identity-session-expiry.test.mjs + tests/d5-03-mcp-lifecycle.test.mjs）：在途定时器 <=1、出队旧回调不动新会话、从不 setInterval、到期只 emit 一次",
      timerUnit.ok === true && (timerUnit.tail || []).some((l) => /^# pass \d+/.test(l)) && !(timerUnit.tail || []).some((l) => /^# fail [1-9]/.test(l)),
      "node --test 无 fail",
      JSON.stringify({ pass_lines: (timerUnit.tail || []).filter((l) => /^# /.test(l)), full: timerUnit.full, ok: timerUnit.ok }));
  }

  const testedCommit = process.env.OPENARC_TESTED_COMMIT || (() => { try { return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
  const sourceFingerprint = RUN_ARTIFACTS.collectSourceFingerprint(ROOT, RUN_ARTIFACTS.d503SourceFiles(ROOT).concat(["experiments/d5-03/mcp-expiry-e2e.mjs", "tests/identity-session-expiry.test.mjs", "tests/session-expiry-fixtures.mjs"]));
  const ENV_NOISE = /ExperimentalWarning|SQLite is an experimental|SetApplicationIsDaemon|NSOSStatusErrorDomain|IMKCFRunLoopWakeUpReliable|In-process GPU|ERR_BLOCKED_BY_CSP/;
  const stderrTail = stderrBuf.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !ENV_NOISE.test(l)).slice(0, 5);
  const consoleTail = consoleErrors.filter((l) => !ENV_NOISE.test(l)).slice(0, 5);
  record("Z3", "主进程 stderr 无未处理错误（采样尾部：" + JSON.stringify(stderrTail) + "）+ 渲染层控制台无错误样本：" + JSON.stringify(consoleTail),
    stderrTail.length === 0 && consoleTail.length === 0,
    "主进程 stderr 与渲染层控制台均无错误行",
    JSON.stringify({ stderrTail, consoleTail, stdoutTail: stdoutBuf.split("\n").filter(Boolean).slice(-8), dialogs: dialogs.slice(0, 5) }));
  const out = {
    phase: "D5-03 第四批",
    title: "会话自然到期（空闲 / 绝对）→ MCP 收流 真机验收 · 场景 " + SCENARIO + "：" + CFG.title,
    scenario: SCENARIO,
    scenarioTable: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v])),
    runId: RUN.runId,
    runDir: RUN.runDirRel,
    startedAt: RUN.startedAt,
    testedCommit,
    openarcCommit: testedCommit,
    openarcBranch: (() => { try { return execFileSync("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })(),
    gitDirtyLines: (() => { try { return execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean).length; } catch { return null; } })(),
    command: "node experiments/d5-03/mcp-expiry-e2e.mjs --scenario=" + SCENARIO,
    spec: SPEC,
    injectedTtl: { ack: CFG.ack, idleMs: CFG.idleMs, ttlMs: CFG.ttlMs, productDefaults: { idleMs: identityStoreModule.DEFAULT_IDLE_MS, ttlMs: identityStoreModule.DEFAULT_TTL_MS }, minMs: identityBootstrap.SESSION_TTL_OVERRIDE.MIN_MS, ackEnv: identityBootstrap.SESSION_TTL_OVERRIDE.ACK_ENV },
    launch: result && result.launched ? result.launched : null,
    measures: MEASURES,
    dbSnapshots: DB_SNAPSHOTS,
    uiTexts: UI_TEXTS,
    quit: result && result.quit ? result.quit : null,
    sourceFingerprint,
    sourceFingerprintSetSha256: sourceFingerprint.setSha256,
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version, cdpPort: CDP_PORT, cdpPorts: RUN.ports.slice(), userDataPrefix: USERDATA_PREFIX, runId: RUN.runId, runDir: RUN.runDirRel, tmpdir: os.tmpdir() },
    fixture: { path: "tests/fixtures/mcp/echo-server.mjs", instances: fixtureRows },
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, productDefects: DEFECTS,
    visualFiles: fs.existsSync(VIS) ? fs.readdirSync(VIS).sort() : [],
    timerUnitTests: timerUnit,
    runsEvidenceGuard: { changedExisting: touchedExisting, removed: runsDiff.removed, addedCount: runsDiff.added.length, addedMine: mine.length },
    boundary: { thirdPartyServices: false, userDataSent: false, arbitraryLocalPrograms: false, pluginIsolationClaimed: false, note: "只连自建 fixture（127.0.0.1 动态端口）；工具调用入口仍全部 MCP_TOOL_INVOCATION_NOT_ENABLED；协议仍 2025-06-18；不声称插件隔离通过" },
    at: new Date().toISOString(),
  };
  OUT = out;
  out.exitCode = failed === 0 ? 0 : 1;
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ scenario: SCENARIO, pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length, defects: DEFECTS.length }));
  return failed === 0 ? 0 : 1;
}

/* ══════════════════════════ 收尾（只清理本次运行自己的东西） ══════════════════════════ */
let exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("验收异常：" + String((e && e.stack) || e));
  record("Z0", "验收脚本无未捕获异常", false, "无异常", String((e && e.message) || e));
  exitCode = 2;
}
try { if (browser) await browser.close().catch(() => {}); } catch { /* ignore */ }
const cleanup = CLEANUP || (await cleanupOwnProcesses());
console.log("收尾：只清理本次运行 spawn 的 pid 树（" + JSON.stringify(cleanup.targets.map((t) => ({ kind: t.kind, rootPid: t.rootPid, leftovers: t.leftovers }))) + "），未使用 pkill；临时 userData 已删 " + JSON.stringify(cleanup.userDataDirsRemoved) + "，保留 " + JSON.stringify(cleanup.userDataDirsKept));
if (RUN) {
  try {
    const fallback = {
      phase: "D5-03 第四批", title: "会话自然到期 → MCP 收流 真机验收（场景 " + SCENARIO + "）", scenario: SCENARIO, aborted: true,
      checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
      notVerified: NOT_VERIFIED, observations: OBSERVATIONS, productDefects: DEFECTS,
    };
    const fin = await RUN.finalize({ out: OUT || fallback, exitCode, logLines: LOG_LINES, cleanup });
    console.log("产物：" + fin.artifactPath + "（sha256 " + fin.artifactSha256.slice(0, 16) + "）+ " + fin.logPath + "；索引 " + RUN_ARTIFACTS.RUNS_REL + "/index.json");
  } catch (e) { console.error("产物写入失败：" + String((e && e.stack) || e)); }
} else {
  console.error("未创建 run 目录（createRun 失败），本次运行无产物");
}
process.exit(exitCode);
