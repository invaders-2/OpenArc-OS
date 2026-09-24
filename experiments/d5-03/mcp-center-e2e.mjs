/**
 * D5-03 第一批 · MCP 中心（连接管理与能力发现）真机验收。
 *
 *   真实 electron .（隔离 userData / 隔离 CDP 端口）+ 真实产品 UI（程序坞「MCP 中心」）+ 自建受控测试服务
 *   tests/fixtures/mcp/echo-server.mjs（stdio 子进程 + 127.0.0.1 HTTP，可控失败模式）。
 *
 * 系列：
 *   A 装配与登录（三步向导 setup-name→next→identifier→next→password/confirm→submit）
 *   B 空态（还没有连接 + 新建入口，DOM 证据）
 *   C 本地连接（stdio，界面新建 → 启用 → 连接；断言**实际协商结果**与 fixture 真实返回值一致）
 *   D 重连 + 测试（状态/工具哈希稳定；mcp/test 产生界面可见的测试日志）
 *   E 停用 + 删除（DISABLED + 子进程/连接收掉；删除后记录消失、列表回空态、无残留）
 *   F 远程连接（http，127.0.0.1 动态端口；同样的协商断言 + 执行位置=远程服务）
 *   G 负例（非白名单 serverKey / 不可达 URL / 鉴权失败 / 协议版本不符；稳定错误码 + 人话提示 + 有界）
 *   H 权限（既有治理命令撤 mcp-center 的 mcp 授权；工具描述不得出现；恢复后可用）
 *   I 本批不开放工具调用（界面无入口；五个调用命令全部 MCP_TOOL_INVOCATION_NOT_ENABLED）
 *   J 自证边界（只连自建 fixture；不声称"插件隔离已通过"）
 *   K 视觉（浅色 + 深色 各 8 类截图：列表/详情/能力表/测试日志/空态/发现中/认证失败/无权）
 *   L 动效（列表插入 / 删除 / 详情切换 / 发现中 连续帧；减少动态效果同一场景 即时或 ≤100ms）
 *   Z 收尾（主进程 stderr / 控制台错误 / 产物清单）
 *
 * 只新增本文件与 artifacts/d5-03/**；不动产品代码、不动既有断言。
 * 探针只清理自己的进程（userData 前缀 oa-d503-）。
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "d5-03");
const VIS = path.join(ART, "visual");
const MOTION = path.join(ART, "motion");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "mcp", "echo-server.mjs");
const domain = require(path.join(ROOT, "electron", "mcp-domain.cjs"));
const CDP_PORT = Number(process.env.OA_D503_CDP_PORT || 9811);
const ADMIN = { id: "admin@d503-mcp.test", pw: "mcp-admin-1" };
const extraArgs = (process.env.OA_D503_ELECTRON_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 错误码 → 界面人话（与 src/mcp/McpCenter.tsx ERROR_LABEL 逐条对齐；断言的只是"提示存在"） */
const HUMAN_TEXT = {
  MCP_LOCAL_SERVER_NOT_ALLOWED: "本地服务不在白名单",
  MCP_UNREACHABLE: "连不上服务端",
  MCP_TIMEOUT: "没有在限定时间内响应",
  MCP_AUTH_REQUIRED: "认证失败，需要重新授权或更新凭据",
  MCP_PROTOCOL_VERSION_UNSUPPORTED: "服务端协议版本不在受支持列表内",
  MCP_UNAUTHORIZED: "当前账号或该应用没有被授这个动作",
  MCP_TOOL_INVOCATION_NOT_ENABLED: "第一批不开放工具调用",
  MCP_COMMAND_NOT_ALLOWED: "命令不在 mcp:command 白名单内",
};

/**
 * fixture 真实返回值固化常量（tests/fixtures/mcp/echo-server.mjs 的响应体 + 产品 sanitizeTools/toolsHash 结果）。
 * 每次运行都用产品链路之外的独立握手核对这组常量 —— fixture 改了就必须让本脚本失败，而不是静默跟着变。
 */
const FIXTURE_EXPECTED = Object.freeze({
  protocolVersion: "2025-06-18",
  serverName: "openarc-test-echo",
  serverVersion: "1.4.0",
  capabilities: { tools: { listChanged: false }, logging: {} },
  tools: [
    { name: "echo_sum", description: "把两个数字相加并回显（测试服务；不实现调用）", inputSchemaSummary: "type=object; properties: a:number(required), b:number(required); required: a,b" },
    { name: "describe_self", description: "描述本测试服务自身的传输与协议版本", inputSchemaSummary: "type=object; properties: verbose:boolean" },
  ],
  toolsHash: "7db033b3636227f94fc2a51859637cbb7b93c7e865a0e12b79d86c9dda7721ce",
});

/** 受验 MCP 产品文件的 sha256 前 16 位（工作区可能同时有别的批次未提交改动；这里固化本批受验内容）。 */
function fileSha(rel) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex").slice(0, 16); } catch { return null; }
}

/** 本地 stdio 断链的根因探针（experiments/d5-03/utility-stdin-probe.cjs，单独跑一次的真实输出）。 */
const STDIO_PROBE = Object.freeze({"electron":"44.3.0","node":"24.20.0","command":"electron experiments/d5-03/utility-stdin-probe.cjs --no-sandbox --disable-gpu-sandbox --in-process-gpu","handle":{"stdinType":"undefined","stdinIsNull":false,"stdinIsUndefined":true,"stdinHasWrite":false,"stdoutType":"object","stdoutHasOn":true},"child":{"spawned":true,"pid":39647,"ppid":39636,"stdinType":"object","stdinEndedImmediately":true,"argv":[".../Electron Helper","experiments/d5-03/utility-stdin-probe-child.cjs","--probe-arg"]},"conclusion":"Electron 44.3.0 的 utilityProcess.fork() 返回句柄没有 stdin（stdin 为 undefined）；子进程确实被拉起，但子进程侧 process.stdin 立即 end。executor-launcher 的 handle.stdin = child.stdin || null 因此恒为 null。"});

/** 本脚本会断言的全部稳定错误码（逐个对 electron/mcp-domain.cjs 的 ERROR_CODE 核过；运行时再核一次防写错）。 */
const ASSERTED_ERROR_CODES = Object.freeze([
  "MCP_LOCAL_SERVER_NOT_ALLOWED", "MCP_ENDPOINT_BLOCKED", "MCP_UNREACHABLE", "MCP_TIMEOUT", "MCP_AUTH_REQUIRED",
  "MCP_PROTOCOL_VERSION_UNSUPPORTED", "MCP_UNAUTHORIZED", "MCP_CONNECTION_DISABLED", "MCP_COMMAND_NOT_ALLOWED",
  "MCP_TOOL_INVOCATION_NOT_ENABLED", "MCP_CONNECTION_NOT_FOUND", "MCP_PROTOCOL_ERROR",
]);

/* ══════════════════════════ 记录 / 日志 ══════════════════════════ */
const CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [], LOG_LINES = [], DEFECTS = [];
/** 产品缺陷：文件:行 + 复现 + 最小修法（只记录，不动手改产品代码）。 */
const defect = (id, title, where, repro, fix) => { const d = { id, title, where, repro, fix }; DEFECTS.push(d); console.log("   ! [DEFECT] " + id + " · " + title + " @ " + where + "\n      复现：" + repro + "\n      最小修法（建议，未动手）：" + fix); return d; };
let passed = 0, failed = 0;
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG_LINES.push(s); _log(s); };
const _err = console.error.bind(console);
console.error = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG_LINES.push("[stderr] " + s); _err(s); };
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 1800), at: new Date().toISOString() };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual.slice(0, 700)));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };

/* ══════════════════════════ 通用 ══════════════════════════ */
async function waitFor(fn, timeout = 20000, intervalMs = 120) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch { /* retry */ }
    if (Date.now() - t0 >= timeout) return false;
    await sleep(intervalMs);
  }
}

/* ══════════════════════════ 状态 ══════════════════════════ */
let child = null, browser = null, page = null, userDataDir = null, stderrBuf = "";
const dialogs = [], consoleErrors = [], fixtures = [], fixtureRows = [];
let refLocal = null, refHttp = null, refAuth = null, refProtocol = null;
const ids = { local: null, remote: null, unreachable: null, auth: null, protocol: null, noResponse: null, motionInsert: null, motionReduced: null };

/* ══════════════════════════ 页面 DOM 助手 ══════════════════════════ */
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
const attrOf = (sel, name) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.getAttribute(" + JSON.stringify(name) + ") || '') : '';");
const waitSel = (sel, ms = 15000) => waitFor(() => has(sel), ms);
const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const setSelect = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok';");
const clickByText = (scope, label) => js("const root = document.querySelector(" + JSON.stringify(scope) + "); if (!root) return 'missing'; const b = Array.from(root.querySelectorAll('button')).find(function (x) { return (x.textContent || '').trim() === " + JSON.stringify(label) + "; }); if (!b) return 'no-button'; if (b.disabled) return 'disabled'; b.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const mcp = (payload) => js("return await window.openarc.mcp.command(" + JSON.stringify(payload) + ")");
const governance = (payload) => js("return await window.openarc.governance.command(" + JSON.stringify(payload) + ")");
const clipOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; const r = el.getBoundingClientRect(); const vw = window.innerWidth, vh = window.innerHeight; const x = Math.max(0, Math.min(r.left, vw - 20)); const y = Math.max(0, Math.min(r.top, vh - 20)); const w = Math.max(20, Math.min(r.width, vw - x)); const h = Math.max(20, Math.min(r.height, vh - y)); return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };");

async function shotTo(file, sel = '[aria-label="MCP 中心窗口"]') {
  try {
    const clip = await clipOf(sel);
    if (clip) await page.screenshot({ path: file, clip });
    else await page.screenshot({ path: file });
    return path.basename(file);
  } catch { return null; }
}
async function captureMotion(prefix, expr, { count = 8, intervalMs = 45, sel = '[data-mcp-center]', dir = MOTION } = {}) {
  const frames = [], samples = [];
  const clip = await clipOf(sel);
  for (let i = 0; i < count; i += 1) {
    if (expr) { try { samples.push({ i, at: Date.now(), v: await js(expr) }); } catch { /* ignore */ } }
    const file = path.join(dir, prefix + "-" + String(i).padStart(2, "0") + ".png");
    try { if (clip) await page.screenshot({ path: file, clip }); else await page.screenshot({ path: file }); frames.push(path.basename(file)); } catch { /* ignore */ }
    await sleep(intervalMs);
  }
  return { frames, samples, clip };
}

/* ══════════════════════════ 身份 ══════════════════════════ */
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
async function setupAndLogin() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const setupNext = async () => {
      await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000);
      await clickSel('[data-d3-id="setup-next"]');
    };
    await setInput('[data-d3-id="setup-name"]', "D5-03 Admin");
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
  }
  return login(ADMIN.id, ADMIN.pw);
}

/* ══════════════════════════ 窗口 / 主题 ══════════════════════════ */
async function openMcpWindow() {
  const clicked = await js("const el = document.querySelector('.dock-item[data-dock-id=\"mcp-center\"]'); if (el) el.click(); return !!el;");
  const up = await waitSel("[data-mcp-center]", 20000);
  await js("const el = document.querySelector('[aria-label=\"MCP 中心窗口\"]'); if (el && el.classList.contains('minimized')) { const d = document.querySelector('.dock-item[data-dock-id=\"mcp-center\"]'); if (d) d.click(); } return true;");
  await sleep(300);
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
  // 兜底：程序坞右键不可用（自动隐藏等）时整页 reload，强制 McpCenter 重新挂载。
  await page.reload().catch(() => {});
  const back = await waitFor(async () => { const g = await gate(); return g === "ready" || g === "unauthenticated"; }, 40000, 300);
  if ((await gate()) === "unauthenticated") await login(ADMIN.id, ADMIN.pw);
  return back && (await openMcpWindow());
}
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

/* ══════════════════════════ MCP UI 动作 ══════════════════════════ */
async function mcpWindowInfo() {
  return await js([
    "const w = document.querySelector('[aria-label=\"MCP 中心窗口\"]');",
    "const c = document.querySelector('[data-mcp-center]');",
    "const norm = function (s) { return String(s || '').replace(/\\s+/g, ' ').trim(); };",
    "return {",
    "  window: !!w, minimized: !!(w && w.classList.contains('minimized')),",
    "  available: c ? c.getAttribute('data-mcp-available') : null,",
    "  empty: !!document.querySelector('[data-mcp-empty]'),",
    "  emptyText: norm(document.querySelector('[data-mcp-empty]')?.textContent).slice(0, 320),",
    "  list: !!document.querySelector('[data-mcp-list]'),",
    "  rows: Array.from(document.querySelectorAll('[data-mcp-connection]')).map(function (el) { return { id: el.getAttribute('data-mcp-connection'), status: el.getAttribute('data-mcp-status'), name: norm(el.querySelector('[data-mcp-name]')?.textContent), tools: norm(el.querySelector('[data-mcp-tool-count]')?.textContent), location: norm(el.querySelector('[data-mcp-location]')?.textContent) }; }),",
    "  detailState: document.querySelector('[data-mcp-detail-state]')?.getAttribute('data-mcp-detail-state') || null,",
    "  errorCode: document.querySelector('[data-mcp-error-code]')?.getAttribute('data-mcp-error-code') || null,",
    "  errorText: norm(document.querySelector('[data-mcp-error]')?.textContent).slice(0, 320),",
    "  notice: norm(document.querySelector('[data-mcp-notice]')?.textContent).slice(0, 200),",
    "  discovering: !!document.querySelector('[data-mcp-discovering]'),",
    "  authRequired: !!document.querySelector('[data-mcp-auth-required]'),",
    "};",
  ].join("\n"));
}
async function detailSnapshot() {
  return await js([
    "const norm = function (s) { return String(s || '').replace(/\\s+/g, ' ').trim(); };",
    "const t = function (sel) { return norm(document.querySelector(sel)?.textContent); };",
    "return {",
    "  state: document.querySelector('[data-mcp-detail-state]')?.getAttribute('data-mcp-detail-state') || null,",
    "  name: t('[data-mcp-detail-name]'), transport: t('[data-mcp-detail-transport]'), location: t('[data-mcp-detail-location]'),",
    "  status: t('[data-mcp-status-text]'), lastError: t('[data-mcp-last-error]'),",
    "  protocolVersion: t('[data-mcp-protocol-version]'), serverName: t('[data-mcp-server-name]'), serverVersion: t('[data-mcp-server-version]'), toolsHash: t('[data-mcp-tools-hash]'),",
    "  config: { endpoint: t('[data-mcp-config-endpoint]'), auth: t('[data-mcp-config-auth]'), credential: t('[data-mcp-config-credential]'), visibility: t('[data-mcp-config-visibility]'), enabled: t('[data-mcp-config-enabled]') },",
    "  capabilities: Array.from(document.querySelectorAll('[data-mcp-capability]')).map(function (el) { return { key: el.getAttribute('data-mcp-capability'), name: norm(el.querySelector('.mcp-cap__name')?.textContent), flag: norm(el.querySelector('.mcp-cap__flag')?.textContent) }; }),",
    "  tools: Array.from(document.querySelectorAll('[data-mcp-tool]')).map(function (tr) { return { name: tr.getAttribute('data-mcp-tool'), description: norm(tr.children[1]?.textContent), schema: norm(tr.children[2]?.textContent) }; }),",
    "  toolsHidden: !!document.querySelector('[data-mcp-tools-hidden]'),",
    "  logs: Array.from(document.querySelectorAll('[data-mcp-log-index]')).map(function (li) { return { time: norm(li.querySelector('.mcp-log__time')?.textContent), phase: norm(li.querySelector('.mcp-log__phase')?.textContent), level: li.querySelector('[data-mcp-log-level]')?.getAttribute('data-mcp-log-level') || '', result: li.querySelector('[data-mcp-log-result]')?.getAttribute('data-mcp-log-result') || '', message: norm(li.querySelector('.mcp-log__message')?.textContent).slice(0, 160) }; }),",
    "  bodyText: norm(document.querySelector('[data-mcp-center]')?.textContent).slice(0, 2000),",
    "};",
  ].join("\n"));
}
async function openCreateDialog() {
  if (await has('[data-mcp-dialog="create"]')) return true;
  if (await has('[data-mcp-action="create"]')) await clickSel('[data-mcp-action="create"]');
  else await clickByText("[data-mcp-empty]", "新建连接");
  return await waitSel('[data-mcp-dialog="create"]', 10000);
}
const PLACEHOLDER_NAME = "占位连接（空态缺陷绕过）";
let placeholderUsed = null;
/**
 * 空态缺陷绕过：产品空态没有任何「新建连接」入口（PageState kind=empty 的 action=none），
 * 列表为空时界面无法新建首条连接。这里用主进程命令面种一条**占位连接**让列表非空，
 * 界面随即出现列表头的「新建」按钮 —— 被验收的那条连接仍然全部经 DOM 表单创建。
 * 这不是产品能力通过，只是让后续验收项可达；证据里如实标注。
 */
async function ensureCreateEntry() {
  if (await has('[data-mcp-action="create"]')) return { needed: false, reason: "list-non-empty" };
  if (!(await has('[data-mcp-empty]'))) return { needed: false, reason: "no-empty-state", ok: false };
  const res = await mcp({ command: "mcp/create", payload: { name: PLACEHOLDER_NAME, transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: "openarc-test-echo" }, authMode: "NONE", visibility: "PERSONAL" } });
  const reopened = await reopenMcpWindow();
  const up = await waitFor(async () => !!(await has('[data-mcp-action="create"]')), 15000, 200);
  placeholderUsed = { at: new Date().toISOString(), createOk: !!(res && res.ok), error: res && res.error, connectionId: res && res.ok && res.connection ? res.connection.connectionId : null, reopened, createEntryVisible: up };
  note("空态缺陷绕过：用 mcp/create 种占位连接「" + PLACEHOLDER_NAME + "」→ 列表非空后界面才出现「新建」入口；" + JSON.stringify(placeholderUsed));
  return { needed: true, ok: !!(res && res.ok) && reopened && up, ...placeholderUsed };
}
async function createViaUI(spec) {
  const entry = await ensureCreateEntry();
  const opened = await openCreateDialog();
  if (!opened) return { ok: false, reason: "dialog-not-open", entry };
  await setInput('[data-mcp-field="name"]', spec.name);
  await setSelect('[data-mcp-field="transport"]', spec.transport);
  await setSelect('[data-mcp-field="location"]', spec.location);
  if (spec.transport === "stdio") {
    if (spec.serverKey != null) await setSelect('[data-mcp-field="serverKey"]', spec.serverKey);
  } else {
    await setInput('[data-mcp-field="url"]', spec.url);
  }
  await setSelect('[data-mcp-field="authMode"]', spec.authMode || "NONE");
  if ((spec.authMode || "NONE") === "BEARER" && spec.credentialSecret) await setInput('[data-mcp-field="credentialSecret"]', spec.credentialSecret);
  await setSelect('[data-mcp-field="visibility"]', spec.visibility || "PERSONAL");
  await sleep(120);
  await clickSel('[data-mcp-submit="create"]');
  const closed = await waitFor(async () => !(await has('[data-mcp-dialog="create"]')), 15000, 120);
  const listed = await waitFor(async () => {
    const res = await mcp({ command: "mcp/list" });
    return !!(res && res.ok && (res.items || []).some((i) => i.name === spec.name));
  }, 15000, 150);
  if (!closed) await clickSel('[aria-label="新建 MCP 连接"] button[aria-label="关闭新建 MCP 连接"]');
  const res = await mcp({ command: "mcp/list" });
  const item = res && res.ok ? (res.items || []).find((i) => i.name === spec.name) || null : null;
  return { ok: !!closed && !!listed && !!item, dialogClosed: closed, listed, connectionId: item ? item.connectionId : null, item, entry };
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
async function clickAction(name) {
  return await clickSel('[data-mcp-action="' + name + '"]');
}
async function enableAndConnect(id, { reconnect = false } = {}) {
  await selectRow(id);
  const enabled = await js("const c = document.querySelector('[data-mcp-config-enabled]'); return c ? c.textContent.trim() : '';");
  if (enabled !== "已启用") await clickAction("toggle");
  const enabledOk = await waitFor(async () => (await js("const c = document.querySelector('[data-mcp-config-enabled]'); return c ? c.textContent.trim() : '';")) === "已启用", 10000, 150);
  const action = reconnect ? "reconnect" : "connect";
  const button = await clickAction(action);
  return { enabledOk, button, action };
}
async function waitStatusText(needle, ms = 30000) {
  return await waitFor(async () => { const t = await textOf("[data-mcp-status-text]"); return t.includes(needle); }, ms, 150);
}
async function scrollDetailTo(sel) {
  return await js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.scrollIntoView({ block: 'center' }); return 'ok';");
}

/* ══════════════════════════ fixture / 参照握手 ══════════════════════════ */
function startFixture(args) {
  const c = spawn(process.execPath, [FIXTURE, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "", errBuf = "";
  const entry = { child: c, stdout: () => buf, stderr: () => errBuf, stop() { try { c.kill("SIGKILL"); } catch { /* ignore */ } } };
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
async function startHttpFixture(args = []) {
  const fx = startFixture(["--http", "--port=0", ...args]);
  const info = await fx.ready;
  return { ...fx, port: info.port, url: info.url };
}
function rawStdioReference() {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [FIXTURE, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", errBuf = "", step = 0, initResult = null;
    const timer = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* ignore */ } reject(new Error("参照 stdio 握手超时：" + errBuf)); }, 10000);
    c.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (step === 0 && msg.id === 1 && msg.result) {
          initResult = msg.result; step = 1;
          c.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
          c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        } else if (step === 1 && msg.id === 2) {
          clearTimeout(timer); step = 2;
          try { c.kill("SIGKILL"); } catch { /* ignore */ }
          resolve({ protocolVersion: initResult.protocolVersion, serverInfo: initResult.serverInfo, capabilities: initResult.capabilities, tools: (msg.result && msg.result.tools) || [], raw: { initialize: initResult, tools: msg.result } });
        }
      }
    });
    c.stderr.on("data", (d) => { errBuf += String(d); });
    c.on("error", (e) => { clearTimeout(timer); reject(e); });
    c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d5-03-reference", version: "1.0.0" } } }) + "\n");
  });
}
async function rawHttpHandshake(url) {
  const post = async (payload) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(payload) });
    return { status: res.status, text: await res.text() };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d5-03-reference", version: "1.0.0" } } });
  const initMsg = JSON.parse(init.text);
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsMsg = JSON.parse(tools.text);
  return { status: init.status, protocolVersion: initMsg.result.protocolVersion, serverInfo: initMsg.result.serverInfo, capabilities: initMsg.result.capabilities, tools: (toolsMsg.result && toolsMsg.result.tools) || [] };
}
/** 独立握手返回值 vs 固化常量：逐字段比对（含 sanitizeTools 后的工具表与 toolsHash）。 */
function referenceMatchesPinned(ref) {
  const sanitized = domain.sanitizeTools(ref.tools, { maxTools: 200 }).tools;
  return ref.protocolVersion === FIXTURE_EXPECTED.protocolVersion
    && ref.serverInfo.name === FIXTURE_EXPECTED.serverName
    && ref.serverInfo.version === FIXTURE_EXPECTED.serverVersion
    && JSON.stringify(domain.normalizeCapabilities(ref.capabilities)) === JSON.stringify(FIXTURE_EXPECTED.capabilities)
    && JSON.stringify(sanitized) === JSON.stringify(FIXTURE_EXPECTED.tools)
    && domain.toolsHash(sanitized) === FIXTURE_EXPECTED.toolsHash;
}

/** 期望值一律从 fixture 真实返回推导（不抄客户端常量）。 */
function expectedFromReference(ref) {
  const sanitized = domain.sanitizeTools(ref.tools, { maxTools: 200 });
  return {
    protocolVersion: ref.protocolVersion,
    serverName: ref.serverInfo.name,
    serverVersion: ref.serverInfo.version,
    capabilities: domain.normalizeCapabilities(ref.capabilities),
    tools: sanitized.tools,
    toolsHash: domain.toolsHash(sanitized.tools),
    toolNames: sanitized.tools.map((t) => t.name),
  };
}

/* ══════════════════════════ 进程 / DB 取证 ══════════════════════════ */
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
/** Electron 会话的全部后代 pid（含 Electron Helper / utilityProcess 子进程）。 */
const descendantPids = () => (child ? descendantsOf(child.pid).filter((r) => !r.stat.startsWith("Z")).map((r) => r.pid) : []);
/** 「连接后新出现的后代进程」= MCP 本地连接真实起的子进程（不依赖命令行长什么样）。 */
const newPids = (before, after) => after.filter((p) => !before.includes(p));
const pidInfo = (pids) => psRows().filter((r) => pids.includes(r.pid)).map((r) => ({ pid: r.pid, ppid: r.ppid, stat: r.stat, cmd: r.cmd.slice(0, 260) }));
const pidAlive = (pid) => psRows().some((r) => r.pid === pid && !r.stat.startsWith("Z"));
/** 40ms 轮询后代进程：本地 stdio 连接起的 utility 子进程可能短命，快照会漏，必须连续采样。 */
function startPidSampler(durationMs = 6000) {
  const seen = new Map();
  const state = { done: false };
  const t0 = Date.now();
  const loop = (async () => {
    while (!state.done && Date.now() - t0 < durationMs) {
      if (child) for (const r of descendantsOf(child.pid)) if (!seen.has(r.pid)) seen.set(r.pid, { pid: r.pid, ppid: r.ppid, stat: r.stat, cmd: r.cmd.slice(0, 280), firstSeenAtMs: Date.now() - t0, lastSeenMs: 0 });
      for (const v of seen.values()) v.lastSeenMs = Date.now() - t0;
      await sleep(40);
    }
  })();
  return { stop: async () => { state.done = true; await loop.catch(() => {}); return [...seen.values()]; } };
}
function dbAll(sql) {
  try {
    const db = new DatabaseSync(path.join(userDataDir, "identity.db"), { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  } catch (e) { return [{ __error: String((e && e.message) || e).slice(0, 160) }]; }
}
async function closePort() {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const port = srv.address().port; srv.close(() => resolve(port)); });
  });
}
function bundleHasText(needle) {
  try {
    const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
    const srcs = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
    for (const src of srcs) {
      const file = path.join(ROOT, "dist", src.replace(/^\//, ""));
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(needle)) return { ok: true, file: src };
    }
    return { ok: false, file: null };
  } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 120) }; }
}

/* ══════════════════════════ 启动 Electron ══════════════════════════ */
async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d503-"));
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
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
  while (!page && end > Date.now()) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面");
  page.on("dialog", (d) => { dialogs.push(String(d.message()).slice(0, 140)); void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror:" + String(e.message).slice(0, 200)));
  return { userDataDir, cdpPort: CDP_PORT };
}

/* ══════════════════════════ 主流程 ══════════════════════════ */
async function main() {
  fs.mkdirSync(VIS, { recursive: true });
  fs.mkdirSync(MOTION, { recursive: true });

  /* ── A 装配与登录 ── */
  await launch();
  record("A", "真实 electron . 启动（隔离 userData oa-d503-* / 隔离 CDP 端口）", !!browser, "CDP 可用 + 界面页", "cdp=" + CDP_PORT + " userData=" + path.basename(userDataDir));
  const loggedIn = await setupAndLogin();
  record("A", "三步向导（setup-name→next→identifier→next→password/confirm→submit）+ 真实 UI 登录 admin", loggedIn, "identity gate = ready", "gate=" + (await gate()));
  const missingCodes = ASSERTED_ERROR_CODES.filter((c) => !Object.values(domain.ERROR_CODE).includes(c));
  record("A0", "本脚本断言的全部错误码都存在于 electron/mcp-domain.cjs ERROR_CODE（避免期望码写错）",
    missingCodes.length === 0, "0 个未知错误码", JSON.stringify({ asserted: ASSERTED_ERROR_CODES, missing: missingCodes }));

  const opened = await openMcpWindow();
  const emptyUp = await waitFor(async () => (await js("return !!document.querySelector('[data-mcp-empty]') || !!document.querySelector('[data-mcp-connection]') || !!document.querySelector('[data-mcp-error]')")), 20000, 200);
  const infoB = await mcpWindowInfo();
  record("B1", "程序坞打开「MCP 中心」→ 窗口出现 + MCP 域可用", opened && !!infoB.window && infoB.available === "true",
    "窗口存在 + data-mcp-available=true", JSON.stringify({ opened, emptyUp, window: infoB.window, available: infoB.available }));
  record("B2", "空态渲染：显示「还没有连接」与下一步说明（DOM 证据）", !!infoB.empty && infoB.emptyText.includes("还没有连接") && infoB.emptyText.includes("新建一个连接后"),
    "data-mcp-empty 含标题与说明", JSON.stringify({ empty: infoB.empty, emptyText: infoB.emptyText.slice(0, 260) }));
  const emptyEntryScan = await js("const root = document.querySelector('[data-mcp-empty]'); return { buttons: root ? root.querySelectorAll('button').length : -1, labels: root ? Array.from(root.querySelectorAll('button')).map(function (b) { return (b.textContent || '').trim(); }) : null, pageListCreate: !!document.querySelector('[data-mcp-action=create]'), pageStateKind: document.querySelector('[data-mcp-empty] [data-ds-kind]')?.getAttribute('data-ds-kind') || null };");
  record("B3", "空态「新建连接」入口：期望有（PLAN §22「无连接可添加」），实际 0 个按钮 —— 首条连接在界面上无法创建（缺陷，见 productDefects D5-03-D1）",
    emptyEntryScan.buttons >= 1 && emptyEntryScan.pageListCreate === true,
    "空态 ≥1 个新建入口按钮 + 页面存在 data-mcp-action=create",
    JSON.stringify(emptyEntryScan));
  defect("D5-03-D1",
    "MCP 中心空态没有任何「新建连接」入口：列表为空时界面无法创建首条连接（PLAN §22「无连接可添加」不满足）",
    "src/mcp/McpCenter.tsx:962-970（空态分支传 onAction/actionLabel）+ src/design-system/page-states.tsx:46（PAGE_STATE_SPEC.empty.action='none'）与 :82（showAction = spec.action!=='none' && Boolean(onAction)）",
    "全新 userData → 程序坞打开「MCP 中心」→ 列表空态：document.querySelectorAll('[data-mcp-empty] button').length = 0，且页面无 [data-mcp-action=create]（列表头的「新建」只在非空分支渲染，McpCenter.tsx:1005）。PageState 把传入的 onAction/actionLabel 静默忽略。",
    "在 McpCenter 空态分支自己渲染新建按钮（例如 <Button variant='secondary' data-mcp-action='create' onClick={openCreate}>新建连接</Button> 包在 [data-mcp-empty] 内，或空态也渲染左侧列表头含「新建」）；或让 PageState 在显式传入 onAction 时放行动作（PAGE_STATE_SPEC.empty 增加 'custom'，showAction = Boolean(onAction) && spec.action !== 'none' 并给默认文案）。未动手改产品代码。");
  const lightEmpty = await shotTo(path.join(VIS, "light-01-empty.png"));
  note("浅色空态截图：" + lightEmpty);

  /* ── C 本地连接（stdio） ── */
  refLocal = await rawStdioReference();
  const expLocal = expectedFromReference(refLocal);
  record("C0", "fixture stdio 参照握手（独立进程，产品链路之外）= 固化常量：protocolVersion/serverInfo/capabilities/tools/toolsHash",
    referenceMatchesPinned(refLocal),
    JSON.stringify(FIXTURE_EXPECTED),
    JSON.stringify({ protocolVersion: refLocal.protocolVersion, serverInfo: refLocal.serverInfo, capabilities: domain.normalizeCapabilities(refLocal.capabilities), tools: domain.sanitizeTools(refLocal.tools).tools, toolsHash: domain.toolsHash(domain.sanitizeTools(refLocal.tools).tools) }));

  const createLocal = await createViaUI({ name: "本地测试回显", transport: "stdio", location: "LOCAL_DEVICE", serverKey: "openarc-test-echo", authMode: "NONE", visibility: "PERSONAL" });
  ids.local = createLocal.connectionId;
  const listB = await mcpWindowInfo();
  record("C1", "本地连接（stdio）经界面表单创建：传输=本地 stdio、serverKey=白名单 openarc-test-echo；因 B3 空态缺陷，首条连接前用主进程命令面种了占位连接让「新建」入口出现（绕过已标注）",
    createLocal.ok === true && !!ids.local && listB.rows.some((r) => r.id === ids.local) && !!placeholderUsed && placeholderUsed.createEntryVisible === true,
    "对话框关闭 + 列表出现该连接（entry 绕过记录见 actual）",
    JSON.stringify({ create: { ok: createLocal.ok, dialogClosed: createLocal.dialogClosed, listed: createLocal.listed, connectionId: ids.local, entry: createLocal.entry }, placeholderUsed, rows: listB.rows, transport: createLocal.item && createLocal.item.transport, location: createLocal.item && createLocal.item.location, endpoint: createLocal.item && createLocal.item.endpoint }));

  const pidsIdleLocal = descendantPids();
  const localSampler = startPidSampler(8000);
  const enable = await enableAndConnect(ids.local);
  const connected = await waitStatusText("READY", 30000);
  const sampledChildren = await localSampler.stop();
  const mcpSpawnedPids = sampledChildren.filter((s) => !pidsIdleLocal.includes(s.pid)).map((s) => s.pid);
  const spawnedInfo = sampledChildren.filter((s) => !pidsIdleLocal.includes(s.pid));
  const detailC = await detailSnapshot();
  const rawLocal = await mcp({ command: "mcp/get", connectionId: ids.local });
  const rowLocal = (rawLocal && rawLocal.connection) || {};
  const capsUi = detailC.capabilities;
  const capsExpectedKeys = Object.keys(expLocal.capabilities);
  const capsMatch = capsUi.length === capsExpectedKeys.length && capsExpectedKeys.every((k) => capsUi.some((c) => c.key === k))
    && JSON.stringify(rowLocal.capabilities) === JSON.stringify(expLocal.capabilities);
  const toolsMatch = JSON.stringify(detailC.tools) === JSON.stringify(expLocal.tools.map((t) => ({ name: t.name, description: t.description, schema: t.inputSchemaSummary })));
  record("C2", "启用 → 连接：实际协商结果与 fixture 真实返回一致（protocolVersion / serverName / serverVersion / capabilities / 工具表含描述与参数摘要 / 执行位置=本地设备 / READY）",
    enable.enabledOk && connected && detailC.protocolVersion === expLocal.protocolVersion && detailC.serverName === expLocal.serverName && detailC.serverVersion === expLocal.serverVersion
      && capsMatch && toolsMatch && detailC.toolsHash === expLocal.toolsHash && detailC.location.includes("本地设备") && detailC.status.includes("READY")
      && rowLocal.status === "READY" && rowLocal.protocolVersion === expLocal.protocolVersion,
    "协议/身份/能力/工具/位置/状态逐条等于 fixture 参照值",
    JSON.stringify({
      ui: { protocolVersion: detailC.protocolVersion, serverName: detailC.serverName, serverVersion: detailC.serverVersion, toolsHash: detailC.toolsHash, location: detailC.location, status: detailC.status, capabilities: detailC.capabilities, tools: detailC.tools, transport: detailC.transport, endpoint: detailC.config.endpoint },
      fixtureReference: { protocolVersion: expLocal.protocolVersion, serverName: expLocal.serverName, serverVersion: expLocal.serverVersion, toolsHash: expLocal.toolsHash, capabilities: expLocal.capabilities, tools: expLocal.tools },
      record: { status: rowLocal.status, protocolVersion: rowLocal.protocolVersion, serverName: rowLocal.serverName, serverVersion: rowLocal.serverVersion, toolsHash: rowLocal.toolsHash, location: rowLocal.location, transport: rowLocal.transport, capabilities: rowLocal.capabilities, authMode: rowLocal.authMode, credentialConfigured: rowLocal.credentialConfigured },
      capabilitiesMatch: capsMatch, toolsMatch,
      localChildProcess: { sampledNewDescendants: spawnedInfo, descendantsAtIdle: pidsIdleLocal.length, connectFailureLog: (await mcp({ command: "mcp/testLog", connectionId: ids.local, limit: 5 })).items },
    }));

  if (!connected || rowLocal.status !== "READY") {
    defect("D5-03-D2",
      "本地（stdio）MCP 连接在真实 Electron 里永远握不上手：utilityProcess 句柄没有 stdin，客户端写第一帧前就回 MCP_UNREACHABLE / stdin-unavailable",
      "electron/executor-launcher.cjs:114-131（ElectronUtilityProcessLauncher：handle.stdin = child.stdin || null；Electron 44 的 utilityProcess 无 stdin）+ electron/mcp-client.cjs:157-167（#write 无 stdin → MCP_UNREACHABLE detail=stdin-unavailable）",
      "新建本地连接 openarc-test-echo → 启用 → 点「连接」：CONNECT_START 后立刻 CONNECT_FAILED MCP_UNREACHABLE detail=stdin-unavailable；记录 status=ERROR，无 protocolVersion/工具表。单元测试 31/31 通过，是因为 tests/mcp-fixtures.mjs 用 NodeChildProcessLauncher（Node child_process 有 stdin），生产路径才用 utilityProcess。根因探针（真实 Electron 44.3.0）：" + STDIO_PROBE.command + " → " + JSON.stringify(STDIO_PROBE.handle) + "，子进程确实起来（pid 存在、argv 指向 Electron Helper + 模块路径），但子进程 process.stdin 立即 end。",
      "最小修法建议（未动手）：给 stdio 连接一条真的有 stdin 的通道 —— ① ElectronUtilityProcessLauncher 改为 fork 一个仓库内 shim（新增 electron/mcp-stdio-shim.cjs，受控 launcher 入口），shim 里用 child_process.spawn 拉起**同一个白名单 entry/args**，把 parentPort 消息 ↔ 子进程 stdin/stdout 互转，launcher 句柄暴露一个 stdin 兼容 Writable；或 ② 主进程改用 Node 语义的 child_process.spawn(process.execPath, [entry, ...args], { env: { PATH, ELECTRON_RUN_AS_NODE: '1' } })，同时重新论证 mcp-client.cjs 顶部「不 spawn Electron executable」的约束与 fuse 设置。");
    notVerified("本地 stdio 的「重连后状态 / 工具哈希稳定」（D1）", "D5-03-D2：本地 stdio 从未握手成功，没有可重连的对象；该项要等 D2 修复后才能验。");
    notVerified("本地 stdio 的「mcp/test 产生 CONNECT_START→TOOLS_DISCOVERED 测试日志」（D2 的日志一半）", "D5-03-D2：test 确实走了一次真实握手并写出日志（CONNECT_START 与 CONNECT_FAILED，带时间戳，界面可见），但握手停在 stdin-unavailable，能力发现那一段不可达。");
    notVerified("本地 stdio 的「停用/删除收掉子进程」正常生命周期（E1 的进程证据）", "D5-03-D2：fixture 在 stdin 立即 end 后即退出，观察不到「READY 时子进程活着 → 停用/删除后收掉」的正常生命周期；采样器捕获的瞬时子进程与命令行为仍记录在 C2/E1/J1b。");
  }
  const shotList = await shotTo(path.join(VIS, "light-02-list.png"));
  const shotDetail = await shotTo(path.join(VIS, "light-03-detail.png"));
  await scrollDetailTo("[data-mcp-capabilities]");
  await sleep(250);
  const shotCaps = await shotTo(path.join(VIS, "light-04-capabilities.png"));
  note("浅色 列表/详情/能力表截图：" + JSON.stringify([shotList, shotDetail, shotCaps]));

  /* ── D 重连 + 测试 ── */
  const clickReconnect = await clickAction("reconnect");
  const reconnected = await waitStatusText("READY", 30000);
  const detailD1 = await detailSnapshot();
  record("D1", "重连后状态与工具哈希稳定（READY + toolsHash 与首次协商一致）",
    clickReconnect === "ok" && reconnected && detailD1.toolsHash === expLocal.toolsHash && detailD1.status.includes("READY"),
    "READY + toolsHash 不变", JSON.stringify({ click: clickReconnect, reconnected, toolsHash: detailD1.toolsHash, expected: expLocal.toolsHash, status: detailD1.status }));

  const logsBefore = (await mcp({ command: "mcp/testLog", connectionId: ids.local, limit: 50 })).items || [];
  const clickTest = await clickAction("test");
  const testNotice = await waitFor(async () => (await textOf("[data-mcp-notice]")).includes("连接测试已完成"), 30000, 200);
  const detailD2 = await detailSnapshot();
  const rawLogs = (await mcp({ command: "mcp/testLog", connectionId: ids.local, limit: 50 })).items || [];
  const newLogs = rawLogs.length - logsBefore.length;
  const logHasTime = detailD2.logs.filter((l) => /\d{4}|\d{2}:\d{2}/.test(l.time)).length;
  const logPhases = [...new Set(detailD2.logs.map((l) => l.phase))];
  const logResults = [...new Set(detailD2.logs.map((l) => l.result))];
  record("D2", "mcp/test 做真实握手并产生界面可见测试日志（步骤 / 结果 / 时间）",
    clickTest === "ok" && testNotice && newLogs >= 2 && detailD2.logs.length >= 3 && logHasTime === detailD2.logs.length && logPhases.includes("CONNECT_START") && logPhases.includes("TOOLS_DISCOVERED"),
    "新增 ≥2 条日志 + 每条有时间 + 步骤含 CONNECT_START/TOOLS_DISCOVERED",
    JSON.stringify({ click: clickTest, notice: testNotice, logsBefore: logsBefore.length, logsAfter: rawLogs.length, newLogs, phases: logPhases, results: logResults, uiLogs: detailD2.logs.slice(0, 6), rawNewest: rawLogs.slice(0, 4) }));
  await scrollDetailTo("[data-mcp-test-log]");
  await sleep(250);
  const shotLog = await shotTo(path.join(VIS, "light-05-test-log.png"));
  note("浅色测试日志截图：" + shotLog);

  /* ── E 停用 + 删除 ── */
  const descendantsAtDisable = descendantPids();
  const clickDisable = await clickAction("toggle");
  await waitFor(async () => (await js("const c = document.querySelector('[data-mcp-config-enabled]'); return c ? c.textContent.trim() : '';")) === "已停用", 10000, 150);
  const disabledStatus = await waitStatusText("DISABLED", 15000);
  const pidsAtReady = mcpSpawnedPids.length ? mcpSpawnedPids : [];
  const childrenGoneAfterDisable = await waitFor(() => pidsAtReady.length > 0 && pidsAtReady.every((p) => !pidAlive(p)), 10000, 200);
  const rawDisabled = await mcp({ command: "mcp/get", connectionId: ids.local });
  const connectWhileDisabled = await mcp({ command: "mcp/connect", connectionId: ids.local });
  record("E1", "停用 → 状态 DISABLED + 连接/子进程收掉（进程级证据）+ 停用后不再接受连接",
    clickDisable === "ok" && disabledStatus && pidsAtReady.length >= 1 && childrenGoneAfterDisable
      && rawDisabled.connection.status === "DISABLED" && rawDisabled.connection.enabled === false
      && connectWhileDisabled.error === "MCP_CONNECTION_DISABLED",
    "DISABLED + MCP 子进程（连接后新增后代）全部退出 + mcp/connect=MCP_CONNECTION_DISABLED",
    JSON.stringify({ click: clickDisable, descendantsAtDisable: descendantsAtDisable.length, sampledNewDescendants: spawnedInfo, mcpSpawnedPidsAtReady: pidInfo(pidsAtReady), childrenGoneAfterDisable, record: { status: rawDisabled.connection.status, enabled: rawDisabled.connection.enabled }, connectWhileDisabled: connectWhileDisabled.error }));

  const motionDeleteP = captureMotion("light-delete", "const r = document.querySelector('.mcp-row[data-mcp-connection=" + JSON.stringify(ids.local) + "]'); return { present: !!r, leaving: !!(r && r.classList.contains('is-leaving')), anim: r ? getComputedStyle(r).animationName : null };", { count: 8, intervalMs: 40 });
  await clickAction("delete");
  await waitSel('[data-mcp-submit="delete"]', 8000);
  const tDelete = Date.now();
  await clickSel('[data-mcp-submit="delete"]');
  const gone = await waitFor(async () => !(await has('.mcp-row[data-mcp-connection="' + ids.local + '"]')), 8000, 12);
  const deleteMs = Date.now() - tDelete;
  const motionDelete = await motionDeleteP;
  const noResidual = pidsAtReady.every((p) => !pidAlive(p));
  // 连带把 B3/C1 的占位连接也从界面删掉 → 列表真正回到空态（PLAN §22「删除后回空态」）
  const placeholderRow = (await mcpWindowInfo()).rows.find((r) => r.name === PLACEHOLDER_NAME) || null;
  let placeholderDeleted = null;
  if (placeholderRow) {
    await selectRow(placeholderRow.id);
    await clickAction("delete");
    await waitSel('[data-mcp-submit="delete"]', 8000);
    await clickSel('[data-mcp-submit="delete"]');
    placeholderDeleted = await waitFor(async () => !(await has('.mcp-row[data-mcp-connection="' + placeholderRow.id + '"]')), 8000, 20);
  }
  const listAfterDelete = await mcpWindowInfo();
  const dbConns = dbAll("SELECT connection_id FROM mcp_connections");
  const dbLogs = dbAll("SELECT connection_id FROM mcp_connection_logs WHERE connection_id = '" + ids.local + "'");
  record("E2", "删除 → 记录消失、列表回到空态、子进程无残留（占位连接也经界面删除；DB 只读取证）",
    gone && deleteMs > 0 && placeholderDeleted !== false && listAfterDelete.empty === true && listAfterDelete.rows.length === 0 && noResidual
      && !dbConns.some((r) => r.connection_id === ids.local) && dbLogs.length === 0,
    "行消失 + 占位行也消失 + data-mcp-empty + 子进程仍全退 + mcp_connections 空 + mcp_connection_logs 无该 id",
    JSON.stringify({ gone, deleteMs, placeholderDeleted, empty: listAfterDelete.empty, rows: listAfterDelete.rows.length, mcpPidsAliveAfterDelete: pidsAtReady.filter(pidAlive), dbConnections: dbConns.map((r) => r.connection_id), dbLogsOfLocal: dbLogs.length, motionSamples: motionDelete.samples.slice(0, 5) }));

  /* ── F 远程连接（http） ── */
  const httpFx = await startHttpFixture();
  fixtureRows.push({ name: "http", port: httpFx.port, url: httpFx.url });
  refHttp = await rawHttpHandshake(httpFx.url);
  const expHttp = expectedFromReference(refHttp);
  record("F0", "fixture http 参照握手（127.0.0.1 动态端口）= 与 stdio 同一组固化常量（协议/身份/能力/工具/哈希一致）",
    referenceMatchesPinned(refHttp) && expHttp.toolsHash === expLocal.toolsHash,
    "http 与 stdio 协商结果一致且等于固化常量",
    JSON.stringify({ port: httpFx.port, url: httpFx.url, status: refHttp.status, protocolVersion: refHttp.protocolVersion, serverInfo: refHttp.serverInfo, toolsHash: expHttp.toolsHash, pinnedHash: FIXTURE_EXPECTED.toolsHash }));
  const createRemote = await createViaUI({ name: "远程回显服务", transport: "http", location: "REMOTE_SERVICE", url: httpFx.url, authMode: "NONE", visibility: "PERSONAL" });
  ids.remote = createRemote.connectionId;
  const pidsBeforeRemote = descendantPids();
  const enableRemote = await enableAndConnect(ids.remote);
  const remoteReady = await waitStatusText("READY", 30000);
  const remoteSpawned = newPids(pidsBeforeRemote, descendantPids());
  const detailF = await detailSnapshot();
  const rawRemote = await mcp({ command: "mcp/get", connectionId: ids.remote });
  const capsMatchHttp = Object.keys(expHttp.capabilities).every((k) => detailF.capabilities.some((c) => c.key === k))
    && JSON.stringify(rawRemote.connection.capabilities) === JSON.stringify(expHttp.capabilities);
  const toolsMatchHttp = JSON.stringify(detailF.tools) === JSON.stringify(expHttp.tools.map((t) => ({ name: t.name, description: t.description, schema: t.inputSchemaSummary })));
  record("F1", "界面新建远程服务连接（http，127.0.0.1 动态端口）→ 连接：协商结果与 fixture 真实返回一致 + 执行位置=远程服务",
    createRemote.ok && enableRemote.enabledOk && remoteReady && detailF.protocolVersion === expHttp.protocolVersion && detailF.serverName === expHttp.serverName
      && detailF.serverVersion === expHttp.serverVersion && capsMatchHttp && toolsMatchHttp && detailF.toolsHash === expHttp.toolsHash
      && detailF.location.includes("远程服务") && detailF.config.endpoint.includes(httpFx.url) && detailF.config.endpoint.includes("仅本机"),
    "协议/身份/能力/工具等于 fixture 参照值 + 位置=远程服务 + 端点范围=仅本机",
    JSON.stringify({
      fixture: { url: httpFx.url, port: httpFx.port, reference: { protocolVersion: expHttp.protocolVersion, serverName: expHttp.serverName, serverVersion: expHttp.serverVersion, toolsHash: expHttp.toolsHash, capabilities: expHttp.capabilities, tools: expHttp.tools } },
      ui: { protocolVersion: detailF.protocolVersion, serverName: detailF.serverName, serverVersion: detailF.serverVersion, toolsHash: detailF.toolsHash, location: detailF.location, status: detailF.status, endpoint: detailF.config.endpoint, capabilities: detailF.capabilities, tools: detailF.tools },
      record: { status: rawRemote.connection.status, protocolVersion: rawRemote.connection.protocolVersion, toolsHash: rawRemote.connection.toolsHash, capabilities: rawRemote.connection.capabilities, transport: rawRemote.connection.transport, location: rawRemote.connection.location },
      toolsMatchHttp, capsMatchHttp,
      remoteSpawnedLocalProcesses: remoteSpawned,
    }));
  const shotRemote = await shotTo(path.join(VIS, "light-06-remote-detail.png"));
  note("浅色远程详情截图：" + shotRemote);

  /* ── G 负例 ── */
  const badKeys = ["/bin/sh", "openarc-test-echo; rm -rf /", "unknown-echo", "../../bin/sh"];
  const badResults = [];
  for (const key of badKeys) {
    const res = await mcp({ command: "mcp/create", payload: { name: "越权本地 " + key.slice(0, 10), transport: "stdio", location: "LOCAL_DEVICE", endpoint: { serverKey: key }, authMode: "NONE", visibility: "PERSONAL" } });
    badResults.push({ key, ok: res.ok, error: res.error, detail: res.detail });
  }
  const dialogForScan = await openCreateDialog();
  const serverKeyOptions = dialogForScan ? await js("const el = document.querySelector('[data-mcp-field=\"serverKey\"]'); return el ? Array.from(el.options).map(function (o) { return o.value; }) : null;") : null;
  if (dialogForScan) await clickSel('[aria-label="新建 MCP 连接"] button[aria-label="关闭新建 MCP 连接"]');
  await waitFor(async () => !(await has('[data-mcp-dialog="create"]')), 6000, 150);
  const humanAllowed = bundleHasText(HUMAN_TEXT.MCP_LOCAL_SERVER_NOT_ALLOWED);
  record("G1", "负例① 非白名单 serverKey（/bin/sh、带分号、未知 key、路径穿越）→ MCP_LOCAL_SERVER_NOT_ALLOWED，且界面不提供任意命令行",
    badResults.every((r) => r.ok === false && r.error === "MCP_LOCAL_SERVER_NOT_ALLOWED") && humanAllowed.ok,
    "4 个 key 全部 ok:false + MCP_LOCAL_SERVER_NOT_ALLOWED + 界面白名单下拉 + 人话提示在构建产物中",
    JSON.stringify({ badResults, humanTextInBundle: humanAllowed, uiServerKeyOptions: serverKeyOptions }));

  const closedPort = await closePort();
  const deadUrl = "http://127.0.0.1:" + closedPort + "/mcp";
  const createDead = await createViaUI({ name: "不可达服务", transport: "http", location: "REMOTE_SERVICE", url: deadUrl, authMode: "NONE", visibility: "PERSONAL" });
  ids.unreachable = createDead.connectionId;
  record("F1a", "界面新建路径在列表非空时可用（此时无绕过：entry.needed=false，完全走 DOM 表单）",
    createDead.ok === true && !!createDead.entry && createDead.entry.needed === false,
    "createDead.ok + entry.needed=false",
    JSON.stringify({ create: { ok: createDead.ok, dialogClosed: createDead.dialogClosed, listed: createDead.listed, connectionId: ids.unreachable }, entry: createDead.entry }));
  await enableAndConnect(ids.unreachable);
  const tUnreachable = Date.now();
  const deadErrUp = await waitFor(async () => { const c = await attrOf("[data-mcp-error]", "data-mcp-error-code"); return c === "MCP_UNREACHABLE" || c === "MCP_TIMEOUT"; }, 20000, 100);
  const deadMs = Date.now() - tUnreachable;
  const deadInfo = await mcpWindowInfo();
  const deadRaw = await mcp({ command: "mcp/get", connectionId: ids.unreachable });
  record("G2", "负例② 不可达 URL（127.0.0.1 已关闭端口）→ MCP_UNREACHABLE/MCP_TIMEOUT，有界且有人话提示",
    createDead.ok && deadErrUp && deadMs <= 15000 && deadInfo.errorText.includes(HUMAN_TEXT[deadInfo.errorCode] || "###") && deadRaw.connection.status === "ERROR",
    "稳定错误码 + 人话提示 + 耗时 ≤15s",
    JSON.stringify({ url: deadUrl, create: createDead.ok, errorCode: deadInfo.errorCode, errorText: deadInfo.errorText, elapsedMs: deadMs, record: { status: deadRaw.connection.status, lastErrorCode: deadRaw.connection.lastErrorCode } }));

  const authFx = await startHttpFixture(["--auth-token=d503-secret-token"]);
  fixtureRows.push({ name: "http-auth", port: authFx.port, url: authFx.url });
  const authProbe = await fetch(authFx.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  refAuth = { status: authProbe.status };
  const createAuth = await createViaUI({ name: "鉴权失败服务", transport: "http", location: "REMOTE_SERVICE", url: authFx.url, authMode: "NONE", visibility: "PERSONAL" });
  ids.auth = createAuth.connectionId;
  await enableAndConnect(ids.auth);
  const authBannerUp = await waitFor(async () => (await attrOf("[data-mcp-error]", "data-mcp-error-code")) === "MCP_AUTH_REQUIRED", 20000, 150);
  const authImmediate = await mcpWindowInfo();
  const authRaw = await mcp({ command: "mcp/get", connectionId: ids.auth });
  record("G3a", "负例③ fixture 鉴权失败模式（--auth-token）→ MCP_AUTH_REQUIRED + 记录 status=AUTH_REQUIRED（后端如实落库；界面失败当下不出现重授权入口 → 缺陷 D5-03-D3）",
    authProbe.status === 401 && createAuth.ok && authBannerUp && authImmediate.authRequired === false
      && authRaw.connection.status === "AUTH_REQUIRED" && authRaw.connection.lastErrorCode === "MCP_AUTH_REQUIRED",
    "fixture 401 + 错误码 MCP_AUTH_REQUIRED + status=AUTH_REQUIRED + （失败当下 data-mcp-auth-required 尚未出现）",
    JSON.stringify({ fixtureStatus: authProbe.status, errorCode: authImmediate.errorCode, errorText: authImmediate.errorText, authRequiredImmediately: authImmediate.authRequired, record: { status: authRaw.connection.status, lastErrorCode: authRaw.connection.lastErrorCode } }));
  defect("D5-03-D3",
    "连接/重连/测试失败后不刷新列表与详情：鉴权失败当下界面不出现「认证失败 → 重新授权」入口，必须手动重选该行才出现（PLAN §22「认证失败重授权」的入口被延迟）",
    "src/mcp/McpCenter.tsx:435-455（runAction：res.ok !== true 时 setFailure 后直接 return，不执行 loadList/loadDetail）",
    "新建远程连接（fixture --auth-token，NONE）→ 启用 → 点「连接」→ 失败横幅出现 MCP_AUTH_REQUIRED，但右侧详情仍是失败前的旧投影（status=DISABLED 等），[data-mcp-auth-required] 不存在；左键再点同一行后才出现。",
    "runAction 在失败分支也调一次 await loadList({silent:true}) + await loadDetail(connectionId)（后端已把 status/lastErrorCode 落库），再 setFailure；或失败时清空详情并要求重取。未动手改产品代码。");
  await selectRow(ids.remote);
  await selectRow(ids.auth);
  const authStatusUp = await waitStatusText("AUTH_REQUIRED", 15000);
  const authUp = await waitFor(async () => !!(await has("[data-mcp-auth-required]")), 10000, 150);
  const authDetail = await detailSnapshot();
  const authButton = await js("const b = document.querySelector('[data-mcp-action=\"reauth\"]'); return b ? { text: (b.textContent || '').trim(), action: b.getAttribute('data-mcp-action') } : null;");
  record("G3b", "重选该行后界面出现「认证失败，需要重新授权」入口（data-mcp-auth-required + 重授权按钮）",
    authStatusUp && authUp && authButton && /重新连接|更新凭据并重连/.test(authButton.text),
    "status=AUTH_REQUIRED + data-mcp-auth-required + 重授权按钮",
    JSON.stringify({ authStatusUp, authUp, authButton, detailStatus: authDetail.status, lastError: authDetail.lastError }));
  const shotAuth = await shotTo(path.join(VIS, "light-07-auth-required.png"));
  note("浅色认证失败截图：" + shotAuth);

  const protoFx = await startHttpFixture(["--protocol-version=1999-01-01"]);
  fixtureRows.push({ name: "http-protocol", port: protoFx.port, url: protoFx.url });
  refProtocol = await rawHttpHandshake(protoFx.url);
  const createProto = await createViaUI({ name: "协议版本不符", transport: "http", location: "REMOTE_SERVICE", url: protoFx.url, authMode: "NONE", visibility: "PERSONAL" });
  ids.protocol = createProto.connectionId;
  await enableAndConnect(ids.protocol);
  const protoUp = await waitFor(async () => (await attrOf("[data-mcp-error]", "data-mcp-error-code")) === "MCP_PROTOCOL_VERSION_UNSUPPORTED", 20000, 120);
  const protoInfo = await mcpWindowInfo();
  const protoDetail = await detailSnapshot();
  const protoRaw = await mcp({ command: "mcp/get", connectionId: ids.protocol });
  record("G4", "负例④ 协议版本不符模式 → MCP_PROTOCOL_VERSION_UNSUPPORTED（真实码），并如实记录服务端返回的版本",
    createProto.ok && protoUp && refProtocol.protocolVersion === "1999-01-01" && protoInfo.errorCode === "MCP_PROTOCOL_VERSION_UNSUPPORTED"
      && protoRaw.connection.status === "ERROR" && protoRaw.connection.lastErrorCode === "MCP_PROTOCOL_VERSION_UNSUPPORTED" && protoRaw.connection.protocolVersion === "1999-01-01",
    "MCP_PROTOCOL_VERSION_UNSUPPORTED + status=ERROR + 记录实际协议版本 1999-01-01",
    JSON.stringify({ fixtureVersion: refProtocol.protocolVersion, errorCode: protoInfo.errorCode, errorText: protoInfo.errorText, uiProtocolVersion: protoDetail.protocolVersion, record: { status: protoRaw.connection.status, lastErrorCode: protoRaw.connection.lastErrorCode, protocolVersion: protoRaw.connection.protocolVersion, serverName: protoRaw.connection.serverName, serverVersion: protoRaw.connection.serverVersion } }));

  const silentFx = await startHttpFixture(["--no-response"]);
  fixtureRows.push({ name: "http-no-response", port: silentFx.port, url: silentFx.url });
  const createSilent = await createViaUI({ name: "无响应服务", transport: "http", location: "REMOTE_SERVICE", url: silentFx.url, authMode: "NONE", visibility: "PERSONAL" });
  ids.noResponse = createSilent.connectionId;
  await selectRow(ids.noResponse);
  if ((await js("const c = document.querySelector('[data-mcp-config-enabled]'); return c ? c.textContent.trim() : '';")) !== "已启用") await clickAction("toggle");
  await waitFor(async () => (await js("const c = document.querySelector('[data-mcp-config-enabled]'); return c ? c.textContent.trim() : '';")) === "已启用", 10000, 150);
  const tSilent = Date.now();
  const motionDiscoverP = captureMotion("light-discovering", "return { discovering: !!document.querySelector('[data-mcp-discovering]'), status: (document.querySelector('[data-mcp-status-text]') || {}).textContent || null };", { count: 6, intervalMs: 120 });
  await clickAction("connect");
  await sleep(700);
  const discoverShot = await shotTo(path.join(VIS, "light-06b-discovering.png"));
  const motionDiscover = await motionDiscoverP;
  const silentUp = await waitFor(async () => (await attrOf("[data-mcp-error]", "data-mcp-error-code")) === "MCP_TIMEOUT", 20000, 150);
  const silentMs = Date.now() - tSilent;
  record("G5", "负例⑤ 挂死服务（fixture --no-response）→ 有界 MCP_TIMEOUT（不长时间挂死），期间界面显示「发现工具中」",
    createSilent.ok && silentUp && silentMs <= 15000 && motionDiscover.samples.some((s) => s.v && s.v.discovering === true),
    "MCP_TIMEOUT + 耗时 ≤15s + 出现 data-mcp-discovering",
    JSON.stringify({ errorCode: await attrOf("[data-mcp-error]", "data-mcp-error-code"), elapsedMs: silentMs, discoveringSamples: motionDiscover.samples.filter((s) => s.v && s.v.discovering).length, frames: motionDiscover.frames, shot: discoverShot }));
  note("负例 4 条连接（不可达/鉴权/协议/无响应）均经界面表单创建，entry.needed 全为 false：" + JSON.stringify([createDead.entry, createAuth.entry, createProto.entry, createSilent.entry]));

  /* ── H 权限 ── */
  const access = await governance({ type: "governance/getAppAccess", appId: "mcp-center" });
  const mcpGrant = access && access.ok ? (access.grants || []).find((g) => g.resourceType === "mcp") : null;
  note("governance/getAppAccess(mcp-center)：" + JSON.stringify({ ok: access && access.ok, grants: (access && access.grants) || [] }));
  const partialGrant = await governance({ type: "governance/grantAppAccess", appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view"] });
  const partialTool = await governance({ type: "governance/grantAppToolAccess", appId: "mcp-center", actions: ["mcp.view"] });
  const beforeRevoke = { list: await mcp({ command: "mcp/list" }) };
  const revoked = mcpGrant ? await governance({ type: "governance/revokeAppAccess", grantId: mcpGrant.grantId }) : { ok: false, error: "NO_MCP_GRANT" };
  const afterList = await mcp({ command: "mcp/list" });
  const afterGet = await mcp({ command: "mcp/get", connectionId: ids.remote });
  const afterConnect = await mcp({ command: "mcp/connect", connectionId: ids.remote });
  const reopenedH = await reopenMcpWindow();
  const unauthorizedUp = await waitFor(async () => (await attrOf("[data-mcp-error]", "data-mcp-error-code")) === "MCP_UNAUTHORIZED", 20000, 150);
  const unauthorizedInfo = await mcpWindowInfo();
  const toolTextLeak = await js("const t = document.querySelector('[data-mcp-center]')?.textContent || ''; return { echo_sum: t.includes('echo_sum'), describe_self: t.includes('describe_self'), toolsTable: !!document.querySelector('[data-mcp-tools]') };");
  record("H1", "撤掉 mcp-center 的 MCP 授权（既有治理命令 governance/revokeAppAccess）→ 全部 mcp 读命令拒绝；界面「无权」不暴露任何工具描述（mcp.view 也被撤 → 详情整块无权）",
    beforeRevoke.list.ok === true && revoked.ok === true && afterList.ok === false && afterList.error === "MCP_UNAUTHORIZED" && afterGet.error === "MCP_UNAUTHORIZED" && afterConnect.error === "MCP_UNAUTHORIZED"
      && reopenedH && unauthorizedUp && unauthorizedInfo.errorCode === "MCP_UNAUTHORIZED" && unauthorizedInfo.errorText.includes(HUMAN_TEXT.MCP_UNAUTHORIZED)
      && toolTextLeak.echo_sum === false && toolTextLeak.describe_self === false && toolTextLeak.toolsTable === false,
    "revoke 成功 + list/get/connect=MCP_UNAUTHORIZED + 界面无权文案 + 0 工具名/工具表",
    JSON.stringify({ mcpGrant, partialGrantAttempt: partialGrant, partialToolAttempt: partialTool, beforeRevokeListOk: beforeRevoke.list.ok, revoked, afterList: { ok: afterList.ok, error: afterList.error, reason: afterList.reason }, afterGet: { ok: afterGet.ok, error: afterGet.error }, afterConnect: { ok: afterConnect.ok, error: afterConnect.error }, reopenedH, unauthorized: { code: unauthorizedInfo.errorCode, text: unauthorizedInfo.errorText }, toolTextLeak }));
  const shotUnauth = await shotTo(path.join(VIS, "light-08-unauthorized.png"));
  note("浅色无权截图：" + shotUnauth);
  notVerified("「工具描述不暴露」的 mcp.use-only 主路径（toolsHidden=true、mcp.view 仍在）", "渲染层既有治理命令无法写出部分动作的 mcp grant：governance/grantAppAccess(resourceType=mcp, actions=[mcp.view]) → " + JSON.stringify(partialGrant) + "；grantAppToolAccess → " + JSON.stringify(partialTool) + "。mcp-center baseline 是单条含 mcp.view/use/manage/test 的 grant（electron/mcp-bootstrap.cjs:41-50），governance/revokeAppAccess 只能整条撤销（authorization-service.cjs:1216），故真机上只能验收「mcp.view 也被撤 → 详情整块无权」这一支。");
  note("最小修法建议（未动手）：authorization-service.cjs:1163 #normalizeAppGrantActions 对 resourceType==='mcp' 放行 mcp.*（mcp-domain.mcpGrantActions 同一命名空间），或新增 governance/updateAppGrantActions。");

  const restored = await logout() && (await login(ADMIN.id, ADMIN.pw));
  const listBack = restored ? await waitFor(async () => (await mcp({ command: "mcp/list" })).ok === true, 15000, 300) : false;
  const afterRestoreList = await mcp({ command: "mcp/list" });
  const afterRestoreGet = await mcp({ command: "mcp/get", connectionId: ids.remote });
  const reopenedR = await reopenMcpWindow();
  const restoreVisible = reopenedR && await waitFor(async () => (await mcpWindowInfo()).rows.some((r) => r.id === ids.remote), 20000, 200);
  await selectRow(ids.remote);
  const detailRestore = await detailSnapshot();
  record("H2", "恢复授权后回到可用（重新登录触发内置 baseline upsert 重新授权）→ 列表/详情/工具表都回来",
    restored && afterRestoreList.ok === true && afterRestoreGet.ok === true && afterRestoreGet.connection.toolsHidden === false && restoreVisible && detailRestore.tools.length === 2,
    "mcp/list ok + 工具可见 + 界面恢复",
    JSON.stringify({ restored, listBack, listOk: afterRestoreList.ok, itemCount: (afterRestoreList.items || []).length, getOk: afterRestoreGet.ok, toolsHidden: afterRestoreGet.connection ? afterRestoreGet.connection.toolsHidden : null, restoreVisible, uiTools: detailRestore.tools.map((t) => t.name), reauthEntryGone: !(await has("[data-mcp-auth-required]")) }));
  note("产品行为记录：内置 App baseline 是「登录时对该组织再 seed 一次」（electron/identity-bootstrap.cjs:131-139 → mcp-bootstrap.cjs:41-50），所以被治理撤销的 mcp-center 授权在下次登录会被重新写回 —— 恢复路径可用，但撤销不跨登录保持。见缺陷清单。");

  /* ── I 本批不开放工具调用 ── */
  const invocationScan = await js([
    "const scope = document.querySelector('[data-mcp-center]');",
    "const els = Array.from(scope ? scope.querySelectorAll('button, a[href], [role=\"button\"], [role=\"menuitem\"], input[type=\"submit\"]') : []);",
    "const labels = els.map(function (el) { return (el.textContent || '').trim(); }).filter(Boolean);",
    "const hits = els.filter(function (el) { const t = (el.textContent || '').trim(); const attrs = Array.from(el.attributes).map(function (a) { return a.name + '=' + a.value; }).join(' '); return /调用|运行工具|执行工具|invoke|callTool/i.test(t) || /callTool|invoke|mcp\\/call/i.test(attrs); });",
    "const bridge = window.openarc && window.openarc.mcp ? window.openarc.mcp : null;",
    "return { labels: labels, hitCount: hits.length, bridgeKeys: bridge ? Object.keys(bridge) : null, extraCallEntries: bridge ? ['callTool','call','invoke'].filter(function (k) { return typeof bridge[k] !== 'undefined'; }) : null };",
  ].join("\n"));
  record("I1", "界面没有任何「调用/运行工具」入口（交互元素扫描 0 命中；桥只暴露 command）",
    invocationScan.hitCount === 0 && invocationScan.bridgeKeys && invocationScan.bridgeKeys.length === 1 && invocationScan.bridgeKeys[0] === "command" && invocationScan.extraCallEntries.length === 0,
    "0 个调用入口 + bridge keys = ['command']",
    JSON.stringify(invocationScan));
  const invCommands = ["mcp/callTool", "mcp/call", "mcp/invoke", "mcp/invokeTool", "mcp/toolCall"];
  const invResults = [];
  for (const command of invCommands) {
    const nested = await mcp({ command, payload: { connectionId: ids.remote, name: "echo_sum", arguments: { a: 1, b: 2 } } });
    const flat = await mcp({ command, connectionId: ids.remote, name: "echo_sum", args: { a: 1, b: 2 } });
    invResults.push({ command, nested, flat });
  }
  const unknownCmd = await mcp({ command: "mcp/toolsInvoke", connectionId: ids.remote });
  record("I2", "直接对 window.openarc.mcp.command 发 5 个调用命令（nested + flat 两种形状）→ 全部 MCP_TOOL_INVOCATION_NOT_ENABLED；未登记命令仍是 MCP_COMMAND_NOT_ALLOWED",
    invResults.every((r) => r.nested && r.nested.ok === false && r.nested.error === "MCP_TOOL_INVOCATION_NOT_ENABLED" && r.flat && r.flat.ok === false && r.flat.error === "MCP_TOOL_INVOCATION_NOT_ENABLED")
      && unknownCmd.ok === false && unknownCmd.error === "MCP_COMMAND_NOT_ALLOWED",
    "5×2 全部 MCP_TOOL_INVOCATION_NOT_ENABLED + 未知命令 MCP_COMMAND_NOT_ALLOWED",
    JSON.stringify({ invResults, unknownCmd }));

  /* ── J 自证边界 ── */
  const conns = dbAll("SELECT connection_id, name, transport, location, endpoint_json, status, last_error_code FROM mcp_connections");
  const endpointLocal = conns.every((r) => {
    try {
      const ep = JSON.parse(r.endpoint_json);
      if (ep.serverKey) return ep.serverKey === "openarc-test-echo";
      const u = new URL(ep.url);
      return u.hostname === "127.0.0.1";
    } catch { return false; }
  });
  const spawnedAll = spawnedInfo;
  record("J1a", "自证边界（端点）：全部 MCP 连接端点只指向自建 fixture（stdio 白名单 key openarc-test-echo / 127.0.0.1 动态端口）",
    conns.length >= 4 && endpointLocal,
    "每条 endpoint_json 都是 openarc-test-echo 或 127.0.0.1",
    JSON.stringify({ connections: conns.map((r) => ({ id: r.connection_id, name: r.name, transport: r.transport, location: r.location, endpoint: r.endpoint_json, status: r.status, lastErrorCode: r.last_error_code })), fixtureRows }));
  // 本地连接起的子进程必须是本仓库 Electron/Node 运行时，且不得是任意外部程序（shell/python/curl）
  const spawnedSafe = spawnedAll.length >= 1 && spawnedAll.every((p) => !/\/bin\/(sh|bash|zsh|python3?|curl|nc)\b/.test(p.cmd) && (p.cmd.includes("echo-server.mjs") || /Electron|electron|Helper|node/.test(p.cmd)));
  record("J1b", "自证边界（子进程）：本地 stdio 连接期间确实起过本仓库受控子进程，命令行不含 shell/python/curl 等任意外部程序（本地 stdio 握手本身在 D5-03-D2 下失败）",
    spawnedSafe,
    "≥1 个本地连接期间新出现的后代进程，且命令行为仓库 fixture 或 Electron/Node 运行时",
    JSON.stringify({ sampledNewDescendants: spawnedAll, mcpSpawnedPids }));
  note("边界声明：全程只连自建 fixture（stdio 子进程 + 127.0.0.1 动态端口 HTTP），没有连接任何真实第三方服务，没有运行任意第三方本地程序（本地只有白名单 serverKey → 固定 entry/args），没有发送用户数据。");
  note("本批结论只覆盖「连接管理与能力发现」：连接成功 ≠ 插件隔离已通过；插件隔离属 D5-04 范围，本脚本不做也不声称。");

  /* ── K 动效（浅色） ── */
  const tInsert = Date.now();
  const createMotionP = createViaUI({ name: "动效插入连接", transport: "stdio", location: "LOCAL_DEVICE", serverKey: "openarc-test-echo", authMode: "NONE", visibility: "PERSONAL" });
  const motionInsert = await captureMotion("light-insert", "const r = document.querySelector('.mcp-row.is-new'); return { anyNew: !!r, anim: r ? getComputedStyle(r).animationName : null, dur: r ? getComputedStyle(r).animationDuration : null, rows: document.querySelectorAll('[data-mcp-connection]').length };", { count: 12, intervalMs: 45 });
  const createMotion = await createMotionP;
  ids.motionInsert = createMotion.connectionId;
  const insertPresentMs = Date.now() - tInsert;
  const insertSample = motionInsert.samples.find((s) => s.v && s.v.anyNew) || null;
  record("K1", "动效 · 列表插入：新行播 MS §5 入场（is-new + mcp-row-in，--dur-quick=160ms）",
    createMotion.ok && !!insertSample && insertSample.v.anim === "mcp-row-in" && insertSample.v.dur === "0.16s",
    "采样到 .mcp-row.is-new + animationName=mcp-row-in + duration=0.16s",
    JSON.stringify({ insertPresentMs, sample: insertSample, samples: motionInsert.samples, frames: motionInsert.frames.length }));

  await js("window.__d503Leave = []; window.__d503LeaveTimer = setInterval(function () { const r = document.querySelector('.mcp-row.is-leaving'); window.__d503Leave.push({ t: Math.round(performance.now()), leaving: !!r, anim: r ? getComputedStyle(r).animationName : null, dur: r ? getComputedStyle(r).animationDuration : null }); }, 8); return true;");
  const motionDelete2P = captureMotion("light-delete-motion", "const r = document.querySelector('.mcp-row.is-leaving'); return { anyLeaving: !!r, anim: r ? getComputedStyle(r).animationName : null, dur: r ? getComputedStyle(r).animationDuration : null };", { count: 8, intervalMs: 40 });
  await selectRow(ids.motionInsert);
  await clickAction("delete");
  await waitSel('[data-mcp-submit="delete"]', 8000);
  const tDel2 = Date.now();
  await clickSel('[data-mcp-submit="delete"]');
  const gone2 = await waitFor(async () => !(await has('.mcp-row[data-mcp-connection="' + ids.motionInsert + '"]')), 8000, 10);
  const deleteMs2 = Date.now() - tDel2;
  const motionDelete2 = await motionDelete2P;
  const leaveTrace = await js("clearInterval(window.__d503LeaveTimer); return window.__d503Leave;");
  const leaveSample = leaveTrace.find((s) => s.leaving) || null;
  record("K2", "动效 · 列表删除：退场 160ms（is-leaving + mcp-row-out）后行被摘除",
    gone2 && deleteMs2 >= 120 && !!leaveSample && leaveSample.anim === "mcp-row-out" && leaveSample.dur === "0.16s",
    "页面内 8ms 采样到 .mcp-row.is-leaving + mcp-row-out/0.16s + 摘除耗时 ≥120ms",
    JSON.stringify({ gone: gone2, deleteMs: deleteMs2, leaveSample, leavingFrames: leaveTrace.filter((s) => s.leaving).length, frames: motionDelete2.frames.length }));

  await js("window.__d503Switch = []; window.__d503SwitchTimer = setInterval(function () { const d = document.querySelector('[data-mcp-detail-name]'); const s = document.querySelector('[data-mcp-detail-state]'); window.__d503Switch.push({ t: Math.round(performance.now()), state: s ? s.getAttribute('data-mcp-detail-state') : null, name: d ? d.textContent : null }); }, 8); return true;");
  const motionSwitchP = captureMotion("light-detail-switch", "const d = document.querySelector('[data-mcp-detail-name]'); const s = document.querySelector('[data-mcp-detail-state]'); return { state: s ? s.getAttribute('data-mcp-detail-state') : null, name: d ? d.textContent : null };", { count: 8, intervalMs: 50 });
  await selectRow(ids.remote);
  await sleep(500);
  await selectRow(ids.auth);
  await sleep(700);
  const motionSwitch = await motionSwitchP;
  const switchTrace = await js("clearInterval(window.__d503SwitchTimer); return window.__d503Switch;");
  const switchNames = [...new Set(switchTrace.map((s) => s.name).filter(Boolean))];
  record("K3", "动效 · 详情切换：从远程连接切到鉴权失败连接，详情面板按 connectionId 重挂载（连续帧覆盖切换；loading 是数据态，进程内 IPC 可能短于 8ms 采样，只记录不判定）",
    switchNames.length >= 2 && switchNames.some((n) => n.includes("远程回显服务")) && switchNames.some((n) => n.includes("鉴权失败服务")),
    "页面内 8ms 采样到 ≥2 个详情名（重挂载）；loading 帧数仅作参考",
    JSON.stringify({ switchNames, statesSeen: [...new Set(switchTrace.map((s) => s.state))], loadingFrames: switchTrace.filter((s) => s.state === "loading").length, loadingNote: "数据态 loading 可能短于 8ms 采样间隔，不作为动效判定", nameChanges: switchTrace.filter((s, i) => i > 0 && s.name !== switchTrace[i - 1].name).map((s) => ({ t: s.t, name: s.name })), frames: motionSwitch.frames.length }));

  /* ── K 动效 · 减少动态效果（同一场景：插入 / 删除 / 详情切换） ── */
  const reducedOn = await setReduced(true);
  await closeSettings();
  const reducedState = await js("const c = document.querySelector('[data-mcp-center]'); const d = document.querySelector('.desktop'); return { desktopReduced: d.classList.contains('reduced'), durQuick: getComputedStyle(c).getPropertyValue('--dur-quick').trim() };");
  const tReducedInsert = Date.now();
  const createReducedP = createViaUI({ name: "动效减少连接", transport: "stdio", location: "LOCAL_DEVICE", serverKey: "openarc-test-echo", authMode: "NONE", visibility: "PERSONAL" });
  const motionReducedInsert = await captureMotion("reduced-insert", "const r = document.querySelector('.mcp-row.is-new'); return { anyNew: !!r, anim: r ? getComputedStyle(r).animationName : null, dur: r ? getComputedStyle(r).animationDuration : null };", { count: 8, intervalMs: 45 });
  const createReduced = await createReducedP;
  ids.motionReduced = createReduced.connectionId;
  const reducedInsertMs = Date.now() - tReducedInsert;
  const reducedAnim = await js("const r = document.querySelector('.mcp-row[data-mcp-connection=" + JSON.stringify(ids.motionReduced) + "]'); const s = document.querySelector('.mcp-row.is-new'); return { rowAnim: r ? getComputedStyle(r).animationName : null, newRowAnim: s ? getComputedStyle(s).animationName : null, newRowDur: s ? getComputedStyle(s).animationDuration : null };");
  const motionReducedDeleteP = captureMotion("reduced-delete", "const r = document.querySelector('.mcp-row[data-mcp-connection=" + JSON.stringify(ids.motionReduced) + "]'); return { present: !!r, anim: r ? getComputedStyle(r).animationName : null };", { count: 6, intervalMs: 35 });
  await selectRow(ids.motionReduced);
  await clickAction("delete");
  await waitSel('[data-mcp-submit="delete"]', 8000);
  const tReduced = Date.now();
  await clickSel('[data-mcp-submit="delete"]');
  const reducedGone = await waitFor(async () => !(await has('.mcp-row[data-mcp-connection="' + ids.motionReduced + '"]')), 8000, 8);
  const reducedDeleteMs = Date.now() - tReduced;
  const motionReducedDelete = await motionReducedDeleteP;
  record("K4", "动效 · 减少动态效果：同一场景（插入 + 删除）animation 被压掉、--dur-quick=0ms，删除即时（≤100ms，且明显快于常规 160ms 退场）",
    reducedOn && reducedState.desktopReduced === true && reducedState.durQuick === "0ms" && reducedAnim.newRowAnim === "none" && reducedGone && reducedDeleteMs <= 100 && reducedDeleteMs < deleteMs2 - 60,
    "desktop.reduced + --dur-quick=0ms + animationName=none + 删除耗时 ≤100ms 且 < 常规",
    JSON.stringify({ reducedOn, reducedState, reducedAnim, reducedInsertMs, reducedDeleteMs, normalDeleteMs: deleteMs2, insertFrames: motionReducedInsert.frames.length, deleteFrames: motionReducedDelete.frames.length, insertSamples: motionReducedInsert.samples.slice(0, 3) }));
  const motionReducedSwitchP = captureMotion("reduced-detail-switch", "const d = document.querySelector('[data-mcp-detail-name]'); const s = document.querySelector('[data-mcp-detail-state]'); return { state: s ? s.getAttribute('data-mcp-detail-state') : null, name: d ? d.textContent : null };", { count: 6, intervalMs: 45 });
  await selectRow(ids.remote);
  await sleep(300);
  await selectRow(ids.auth);
  await sleep(400);
  const motionReducedSwitch = await motionReducedSwitchP;
  note("减少动态效果下的详情切换帧：" + motionReducedSwitch.frames.length + "，采样名：" + JSON.stringify([...new Set(motionReducedSwitch.samples.map((s) => s.v && s.v.name).filter(Boolean))]));
  const reducedRestore = await setReduced(false);
  await closeSettings();

  /* ── L 深色视觉 + 无权复验 ── */
  const themeDark = await setTheme("dark");
  await closeSettings();
  const darkState = await js("return { dark: document.querySelector('.desktop').classList.contains('dark'), reduced: document.querySelector('.desktop').classList.contains('reduced') };");
  record("L1", "深色主题切换（真实产品外观开关）", themeDark && darkState.dark === true && darkState.reduced === false, ".desktop.dark + 减少动效已关闭", JSON.stringify({ themeDark, darkState }));
  await selectRow(ids.remote);
  await sleep(300);
  const darkList = await shotTo(path.join(VIS, "dark-01-list.png"));
  const darkDetail = await shotTo(path.join(VIS, "dark-02-detail.png"));
  await scrollDetailTo("[data-mcp-capabilities]");
  await sleep(250);
  const darkCaps = await shotTo(path.join(VIS, "dark-03-capabilities.png"));
  await scrollDetailTo("[data-mcp-test-log]");
  await sleep(250);
  const darkLog = await shotTo(path.join(VIS, "dark-04-test-log.png"));
  note("深色 列表/详情/能力表/测试日志截图：" + JSON.stringify([darkList, darkDetail, darkCaps, darkLog]));

  await selectRow(ids.noResponse);
  if ((await js("const c = document.querySelector('[data-mcp-config-enabled]'); return c ? c.textContent.trim() : '';")) !== "已启用") await clickAction("toggle");
  await waitFor(async () => (await js("const c = document.querySelector('[data-mcp-config-enabled]'); return c ? c.textContent.trim() : '';")) === "已启用", 10000, 150);
  const motionDiscoverDarkP = captureMotion("dark-discovering", "return { discovering: !!document.querySelector('[data-mcp-discovering]') };", { count: 4, intervalMs: 120 });
  await clickAction("connect");
  await sleep(600);
  const darkDiscovering = await shotTo(path.join(VIS, "dark-05-discovering.png"));
  const motionDiscoverDark = await motionDiscoverDarkP;
  await waitFor(async () => (await attrOf("[data-mcp-error]", "data-mcp-error-code")) === "MCP_TIMEOUT", 20000, 150);
  note("深色发现中截图：" + darkDiscovering + "，采样帧含 discovering=" + motionDiscoverDark.samples.filter((s) => s.v && s.v.discovering).length);

  await selectRow(ids.auth);
  await waitFor(async () => !!(await has("[data-mcp-auth-required]")), 10000, 150);
  const darkAuth = await shotTo(path.join(VIS, "dark-06-auth-required.png"));
  note("深色认证失败截图：" + darkAuth);

  const access2 = await governance({ type: "governance/getAppAccess", appId: "mcp-center" });
  const grant2 = access2 && access2.ok ? (access2.grants || []).find((g) => g.resourceType === "mcp") : null;
  const revoked2 = grant2 ? await governance({ type: "governance/revokeAppAccess", grantId: grant2.grantId }) : { ok: false, error: "NO_MCP_GRANT" };
  const reopenedU2 = await reopenMcpWindow();
  const unauthDarkUp = await waitFor(async () => (await attrOf("[data-mcp-error]", "data-mcp-error-code")) === "MCP_UNAUTHORIZED", 20000, 150);
  const darkUnauth = await shotTo(path.join(VIS, "dark-07-unauthorized.png"));
  record("L2", "深色 · 无权（第二次整条撤销 → 界面无权，工具描述 0 暴露）", revoked2.ok === true && reopenedU2 && unauthDarkUp, "revoke 成功 + 界面 MCP_UNAUTHORIZED", JSON.stringify({ revoked2, reopenedU2, unauthDarkUp, shot: darkUnauth }));
  const restored2 = await logout() && (await login(ADMIN.id, ADMIN.pw));
  const listBack2 = restored2 ? await waitFor(async () => (await mcp({ command: "mcp/list" })).ok === true, 15000, 300) : false;
  const listRestore2 = await mcp({ command: "mcp/list" });
  record("L3", "深色 · 恢复授权后再次可用", restored2 && listBack2 && listRestore2.ok === true, "登录后 mcp/list ok", JSON.stringify({ restored2, listBack2, ok: listRestore2.ok, items: (listRestore2.items || []).length }));

  const finalConns = (listRestore2.items || []).map((i) => i.connectionId);
  for (const id of finalConns) await mcp({ command: "mcp/delete", connectionId: id });
  const reopenedEmpty = await reopenMcpWindow();
  const emptyDarkUp = await waitFor(async () => !!(await has("[data-mcp-empty]")), 20000, 150);
  const darkEmpty = await shotTo(path.join(VIS, "dark-08-empty.png"));
  record("L4", "深色 · 空态（清空连接后回到「还没有连接」）", reopenedEmpty && emptyDarkUp, "data-mcp-empty 可见", JSON.stringify({ reopenedEmpty, emptyDarkUp, shot: darkEmpty }));
  const finalAlive = await waitFor(() => mcpSpawnedPids.every((p) => !pidAlive(p)), 10000, 200) ? [] : mcpSpawnedPids.filter(pidAlive);
  record("L5", "清空后无 MCP 子进程残留", finalAlive.length === 0, "本地连接起的后代进程全部退出", JSON.stringify({ mcpSpawnedPids: pidInfo(mcpSpawnedPids), finalAlive, fixtureRows }));

  /* ── Z 收尾 ── */
  const ENV_NOISE = /ExperimentalWarning|SQLite is an experimental|SetApplicationIsDaemon|NSOSStatusErrorDomain|IMKCFRunLoopWakeUpReliable|In-process GPU|ERR_BLOCKED_BY_CSP/;
  const stderrTail = stderrBuf.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !ENV_NOISE.test(l)).slice(0, 5);
  record("Z1", "主进程 stderr 无未处理错误", stderrTail.length === 0, "无错误行", stderrTail.join(" | ") || "clean");
  const consoleTail = consoleErrors.filter((l) => !ENV_NOISE.test(l)).slice(0, 5);
  note("控制台错误样本：" + JSON.stringify(consoleTail));
  note("对话框样本：" + JSON.stringify(dialogs.slice(0, 5)));

  const files = { visual: fs.existsSync(VIS) ? fs.readdirSync(VIS).sort() : [], motion: fs.existsSync(MOTION) ? fs.readdirSync(MOTION).sort() : [] };
  const out = {
    phase: "D5-03 第一批",
    title: "MCP 中心连接管理与能力发现（真实 electron + 自建受控测试服务）",
    openarcCommit: process.env.OPENARC_TESTED_COMMIT || (() => { try { return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })(),
    openarcBranch: (() => { try { return execFileSync("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })(),
    gitDirtyLines: (() => { try { return execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean).length; } catch { return null; } })(),
    command: "node experiments/d5-03/mcp-center-e2e.mjs",
    mcpSourceFingerprint: (() => {
      const files = ["electron/mcp-domain.cjs", "electron/mcp-store.cjs", "electron/mcp-client.cjs", "electron/mcp-service.cjs", "electron/mcp-bootstrap.cjs", "src/mcp/McpCenter.tsx", "tests/fixtures/mcp/echo-server.mjs"];
      return Object.fromEntries(files.map((f) => [f, fileSha(f)]));
    })(),
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version, cdpPort: CDP_PORT, userDataPrefix: "oa-d503-" },
    distFingerprint: (() => {
      try {
        const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
        const src = (html.match(/src="([^"]+\.js)"/) || [])[1] || null;
        const file = src ? path.join(ROOT, "dist", src.replace(/^\//, "")) : null;
        const st = file && fs.existsSync(file) ? fs.statSync(file) : null;
        return { entry: src, bytes: st ? st.size : null, mtime: st ? st.mtime.toISOString() : null };
      } catch { return null; }
    })(),
    fixture: { path: "tests/fixtures/mcp/echo-server.mjs", instances: fixtureRows, referenceStdio: refLocal ? { protocolVersion: refLocal.protocolVersion, serverInfo: refLocal.serverInfo, capabilities: refLocal.capabilities, tools: refLocal.tools.map((t) => t.name) } : null, referenceHttp: refHttp ? { protocolVersion: refHttp.protocolVersion, serverInfo: refHttp.serverInfo, capabilities: refHttp.capabilities, tools: refHttp.tools.map((t) => t.name) } : null },
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS,
    productDefects: DEFECTS,
    emptyStateWorkaround: placeholderUsed,
    stdioProbe: STDIO_PROBE,
    visualFiles: files.visual, motionFiles: files.motion,
    boundary: { thirdPartyServices: false, userDataSent: false, arbitraryLocalPrograms: false, pluginIsolationClaimed: false, note: "只连自建 fixture（stdio 子进程 + 127.0.0.1 HTTP）；连接成功不等于插件隔离通过" },
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ART, "mcp-center-e2e.json"), JSON.stringify(out, null, 2));
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  return failed === 0 ? 0 : 1;
}

/* ══════════════════════════ 收尾 ══════════════════════════ */
let exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("验收异常：" + String((e && e.stack) || e));
  record("Z0", "验收脚本无未捕获异常", false, "无异常", String((e && e.message) || e));
  exitCode = 2;
}
try { if (browser) await browser.close().catch(() => {}); } catch { /* ignore */ }
try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
try { spawnSync("pkill", ["-f", "oa-d503-"], { stdio: "ignore" }); } catch { /* ignore */ }
for (const fx of fixtures) { try { fx.stop(); } catch { /* ignore */ } }
try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.mkdirSync(ART, { recursive: true }); fs.writeFileSync(path.join(ART, "mcp-center-e2e.log"), LOG_LINES.join("\n") + "\n"); } catch { /* ignore */ }
process.exit(exitCode);
