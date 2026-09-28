/**
 * D5-03 第三批 · MCP 流式收口 + 生命周期 真机验收（真机 = 真实 electron . + 隔离 userData + 隔离 CDP 端口）。
 *
 * 被测能力（第三批刚交付/修好）：
 *   · electron/mcp-client.cjs：POST SSE 逐事件解析、匹配响应即完成；GET SSE 有界接收 + 有界退避重连；
 *     GET 405/404/501 = 不支持且保留 POST 连接；只有服务端给过 id: 才带 Last-Event-ID 续传；
 *     重复事件按 (channel,id) 去重；半包跨 chunk；单事件字节上界；流中断 / 超大事件 / 会话失效错误码；
 *     HTTP 下服务端→客户端请求真的把 -32601 POST 回去。
 *   · mcp-service：dispose()（abort 流/在途/opening）、getStream 实时投影、closeAppConnections（撤权即时收流）。
 *   · 生命周期接线：关应用 will-quit 有界 dispose；登出/锁屏 dispose（DISABLED + MCP_SESSION_ENDED，enabled 不变）；
 *     撤权 → ERROR + MCP_UNAUTHORIZED + 收流。
 *
 * 章节 ↔ 任务编号（逐项 record(section,name,ok,expected,actual)）：
 *   A  装配 / 三步向导 / 登录 / 参照握手          → 前置
 *   1  持续 POST SSE（响应后继续推通知、流不结束）→ 任务 1
 *   2  GET SSE 建立 + 通知不改可用性              → 任务 2
 *   3  GET 405 = 不支持，连接仍 READY + test 仍成功 → 任务 3
 *   4  带事件 ID 的断线续传（Last-Event-ID 实收）  → 任务 4
 *   5  无事件 ID：不续传、不重放                  → 任务 5
 *   6  重复事件去重                                → 任务 6
 *   7a 半包跨 chunk / 7b 超大单事件               → 任务 7
 *   8  无响应有界超时                              → 任务 8
 *   9a POST 侧会话失效 / 9b GET 流重连 404 会话失效 → 任务 9
 *   10 登出收流 + enabled 不变 + 重新登录可连接    → 任务 10
 *   11 关应用（有活连接 + 在途流）有界 dispose     → 任务 11
 *   12 停用/删除：收流 + 无残留子进程              → 任务 12
 *   13 撤权：即时收流 + 不投影 + view-only 隐藏工具 → 任务 13
 *   16 边界硬断言（5×2 调用入口 / -32601 / 协议版本 / 只连 fixture）→ 任务 16
 *   Z  收尾（主进程 stderr / 控制台错误 / 产物清单）
 *
 * 纪律：
 *   · 只新增本脚本与产物；不改产品代码、不改既有脚本判定；发现缺陷只记录（文件:行 + 复现 + 最小修法）。
 *   · 连接/授权全部走真实产品入口（window.openarc.mcp.command、window.openarc.governance.command），绝不直接改库；
 *     任务 1 的首条连接**经界面表单**创建，其余场景连接走与界面同一个 IPC 命令面（证据里如实标注）。
 *   · 只连自建受控 fixture（tests/fixtures/mcp/echo-server.mjs，仅监听 127.0.0.1）；不接第三方、不发用户数据、
 *     不声称插件隔离通过（写进 evidence.boundary）。
 *   · 收尾只清本次运行自己 spawn 的 pid 树（Electron 主进程 + 后代 + fixture 子进程），绝不按前缀 pkill 别人。
 *   · 产物写入 artifacts/d5-03/runs/<runId>/（run-artifacts.cjs 的 createRun/acquirePort/finalize）。
 */
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RUN_ARTIFACTS = require(path.join(here, "run-artifacts.cjs"));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "mcp", "echo-server.mjs");
const domain = require(path.join(ROOT, "electron", "mcp-domain.cjs"));
/** 客户端上界从被测模块本身读（不抄常量）：请求超时 / 单事件字节上界。 */
const clientModule = require(path.join(ROOT, "electron", "mcp-client.cjs"));
const CLIENT_BOUND = {
  requestTimeoutMs: clientModule.DEFAULT_REQUEST_TIMEOUT_MS,
  maxEventBytes: clientModule.DEFAULT_MAX_EVENT_BYTES,
  streamReconnectAttempts: clientModule.DEFAULT_STREAM_RECONNECT_ATTEMPTS,
  protocolVersion: domain.MCP_PROTOCOL_VERSION,
};
const USERDATA_PREFIX_BASE = "oa-d503s-";
const CDP_PORT_BASE = Number(process.env.OA_D503_STREAM_CDP_PORT || 9841);
const ADMIN = { id: "admin@d503-stream.test", pw: "mcp-stream-1" };
const extraArgs = (process.env.OA_D503_ELECTRON_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本脚本会断言的全部稳定错误码（逐个与 electron/mcp-domain.cjs 的 ERROR_CODE 核对过，运行时再核一次防写错）。 */
const ASSERTED_ERROR_CODES = Object.freeze([
  "MCP_STREAM_INTERRUPTED", "MCP_STREAM_EVENT_TOO_LARGE", "MCP_SESSION_EXPIRED", "MCP_SESSION_ENDED",
  "MCP_TIMEOUT", "MCP_UNAUTHORIZED", "MCP_TOOL_INVOCATION_NOT_ENABLED", "MCP_CONNECTION_DISABLED",
  "MCP_CONNECTION_NOT_FOUND", "MCP_COMMAND_NOT_ALLOWED",
]);
/** 固化常量只用来核对 fixture 是否漂移（独立握手返回值 vs 常量），场景期望值一律来自参照握手。 */
const FIXTURE_PINNED = Object.freeze({
  protocolVersion: "2025-06-18",
  serverName: "openarc-test-echo",
  serverVersion: "1.4.0",
  capabilities: { tools: { listChanged: false }, logging: {} },
  toolsHash: "7db033b3636227f94fc2a51859637cbb7b93c7e865a0e12b79d86c9dda7721ce",
});

/* ══════════════════════════ 记录 / 日志 ══════════════════════════ */
const CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [], LOG_LINES = [], DEFECTS = [];
const defect = (id, title, where, repro, fix) => { const d = { id, title, where, repro, fix }; DEFECTS.push(d); console.log("   ! [DEFECT] " + id + " · " + title + " @ " + where + "\n      复现：" + repro + "\n      最小修法（建议，未动手）：" + fix); return d; };
let passed = 0, failed = 0;
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG_LINES.push(s); _log(s); };
const _err = console.error.bind(console);
console.error = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG_LINES.push("[stderr] " + s); _err(s); };
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 2400), at: new Date().toISOString() };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual.slice(0, 900)));
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
const short = (v, n = 240) => String(v == null ? "" : (typeof v === "string" ? v : JSON.stringify(v))).slice(0, n);

/* ══════════════════════════ 状态 ══════════════════════════ */
let child = null, browser = null, page = null, userDataDir = null;
let stdoutBuf = "", stderrBuf = "";
const dialogs = [], consoleErrors = [], fixtures = [], fixtureRows = [];
const SPAWNS = [];
let RUN = null, RESERVED_PORT = null, VIS = null;
let CDP_PORT = CDP_PORT_BASE, USERDATA_PREFIX = USERDATA_PREFIX_BASE;
const ids = {};

/* ══════════════════════════ 页面 DOM 助手 ══════════════════════════ */
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
const governance = (payload) => js("return await window.openarc.governance.command(" + JSON.stringify(payload) + ")");
const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const clipOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; const r = el.getBoundingClientRect(); const vw = window.innerWidth, vh = window.innerHeight; const x = Math.max(0, Math.min(r.left, vw - 20)); const y = Math.max(0, Math.min(r.top, vh - 20)); const w = Math.max(20, Math.min(r.width, vw - x)); const h = Math.max(20, Math.min(r.height, vh - y)); return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };");
async function shotTo(file, sel = '[aria-label="MCP 中心窗口"]') {
  try {
    const clip = await clipOf(sel);
    if (clip) await page.screenshot({ path: file, clip }); else await page.screenshot({ path: file });
    return path.basename(file);
  } catch { return null; }
}

/* ══════════════════════════ 身份（三步向导 + 登录） ══════════════════════════ */
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
    await setInput('[data-d3-id="setup-name"]', "D5-03 Stream Admin");
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
/** 强制 MCP 中心重新挂载（拿最新投影）：优先右键关应用，兜底整页 reload。 */
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
    "  toolsHiddenText: t('[data-mcp-tools-hidden]'),",
    "  sessionEndedNote: !!document.querySelector('[data-mcp-note=\"session-ended\"]'),",
    "  sessionEndedText: t('[data-mcp-note=\"session-ended\"]'),",
    "  unauthorizedPane: !!document.querySelector('[data-mcp-detail-unauthorized]'),",
    "  centerText: norm(document.querySelector('[data-mcp-center]')?.textContent).slice(0, 4000),",
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
    "  errorText: norm(document.querySelector('[data-mcp-error]')?.textContent).slice(0, 240),",
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
async function waitStatusText(needle, ms = 30000) {
  return await waitFor(async () => { const t = await textOf("[data-mcp-status-text]"); return t.includes(needle); }, ms, 150);
}

/* ══════════════════════════ 连接：命令面 / 界面表单 ══════════════════════════ */
/** 与界面同一个 IPC 命令面（window.openarc.mcp.command）；不是直接改库。 */
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
  if (!closed) await clickSel('[aria-label="新建 MCP 连接"] button[aria-label="关闭新建 MCP 连接"]');
  const listed = await waitFor(async () => { const res = await mcpCmd("mcp/list"); return !!(res && res.ok && (res.items || []).some((i) => i.name === spec.name)); }, 15000, 150);
  const res = await mcpCmd("mcp/list");
  const item = res && res.ok ? (res.items || []).find((i) => i.name === spec.name) || null : null;
  return { ok: !!closed && !!listed && !!item, dialogClosed: closed, listed, connectionId: item ? item.connectionId : null, item };
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
/** 起一个 http fixture 并返回带 /__state 读数的句柄。 */
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
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d5-03-stream-reference", version: "1.0.0" } } });
  const initMsg = JSON.parse(init.text);
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsMsg = JSON.parse(tools.text);
  return { status: init.status, protocolVersion: initMsg.result.protocolVersion, serverInfo: initMsg.result.serverInfo, capabilities: initMsg.result.capabilities, tools: (toolsMsg.result && toolsMsg.result.tools) || [] };
}
function referenceMatchesPinned(ref) {
  const sanitized = domain.sanitizeTools(ref.tools, { maxTools: 200 }).tools;
  return ref.protocolVersion === FIXTURE_PINNED.protocolVersion
    && ref.serverInfo.name === FIXTURE_PINNED.serverName
    && ref.serverInfo.version === FIXTURE_PINNED.serverVersion
    && JSON.stringify(domain.normalizeCapabilities(ref.capabilities)) === JSON.stringify(FIXTURE_PINNED.capabilities)
    && domain.toolsHash(sanitized) === FIXTURE_PINNED.toolsHash;
}
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
const toolsMatchExpected = (uiTools, exp) => JSON.stringify(uiTools) === JSON.stringify(exp.tools.map((t) => ({ name: t.name, description: t.description, schema: t.inputSchemaSummary })));

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
const descendantPids = () => (child ? descendantsOf(child.pid).filter((r) => !r.stat.startsWith("Z")).map((r) => r.pid) : []);
const pidAlive = (pid) => psRows().some((r) => r.pid === pid && !r.stat.startsWith("Z"));
const pidInfo = (pids) => psRows().filter((r) => pids.includes(r.pid)).map((r) => ({ pid: r.pid, ppid: r.ppid, stat: r.stat, cmd: r.cmd.slice(0, 240) }));
function startPidSampler(durationMs = 6000) {
  const seen = new Map();
  const state = { done: false };
  const t0 = Date.now();
  const loop = (async () => {
    while (!state.done && Date.now() - t0 < durationMs) {
      if (child) for (const r of descendantsOf(child.pid)) if (!seen.has(r.pid)) seen.set(r.pid, { pid: r.pid, ppid: r.ppid, stat: r.stat, cmd: r.cmd.slice(0, 280), firstSeenAtMs: Date.now() - t0 });
      await sleep(40);
    }
  })();
  return { stop: async () => { state.done = true; await loop.catch(() => {}); return [...seen.values()]; } };
}
async function cleanupOwnProcesses() {
  const result = { strategy: "own-pid-tree-only", pkillUsed: false, at: new Date().toISOString(), targets: [], leftovers: [] };
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
  return result;
}
function dbAll(sql) {
  try {
    const db = new DatabaseSync(path.join(userDataDir, "identity.db"), { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  } catch (e) { return [{ __error: String((e && e.message) || e).slice(0, 200) }]; }
}
const dbConnection = (id) => dbAll("SELECT connection_id, name, transport, location, endpoint_json, enabled, status, last_error_code FROM mcp_connections WHERE connection_id = '" + String(id).replace(/'/g, "") + "'")[0] || null;
const dbLogs = (id, limit = 12) => dbAll("SELECT at, level, event, error_code, detail FROM mcp_connection_logs WHERE connection_id = '" + String(id).replace(/'/g, "") + "' ORDER BY at DESC, id DESC LIMIT " + Number(limit));

/* ══════════════════════════ 启动 Electron ══════════════════════════ */
async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), USERDATA_PREFIX));
  if (RESERVED_PORT) { await RESERVED_PORT.release(); RESERVED_PORT = null; }
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" },
  });
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
  return { userDataDir, cdpPort: CDP_PORT };
}

/* ══════════════════════════ 主流程 ══════════════════════════ */
async function main() {
  RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "mcp-stream-e2e", basePort: CDP_PORT_BASE, envBaseVar: "OA_D503_STREAM_CDP_PORT", userDataPrefixBase: USERDATA_PREFIX_BASE });
  USERDATA_PREFIX = RUN.userDataPrefix;
  RESERVED_PORT = await RUN.acquirePort(CDP_PORT_BASE);
  CDP_PORT = RESERVED_PORT.port;
  VIS = path.join(RUN.runDir, "visual");
  fs.mkdirSync(VIS, { recursive: true });
  console.log("本次运行：" + RUN.runId + " → " + RUN.runDirRel + "（CDP " + CDP_PORT + "，userData 前缀 " + USERDATA_PREFIX + "）");
  console.log("客户端上界（读自 electron/mcp-client.cjs，非抄常量）：" + JSON.stringify(CLIENT_BOUND));

  /* ── A 装配 / 三步向导 / 登录 / 参照握手 ── */
  await launch();
  record("A1", "真实 electron . 启动（隔离 userData " + USERDATA_PREFIX + "* / 本次运行独占 CDP 端口）", !!browser, "CDP 可用 + 界面页", "cdp=" + CDP_PORT + " userData=" + path.basename(userDataDir));
  const loggedIn = await setupAndLogin();
  record("A2", "三步向导（setup-name→next→identifier→next→password/confirm→submit）+ 真实 UI 登录 admin", loggedIn, "identity gate = ready", "gate=" + (await gate()));
  const missingCodes = ASSERTED_ERROR_CODES.filter((c) => !Object.values(domain.ERROR_CODE).includes(c));
  record("A3", "本脚本断言的全部错误码都存在于 electron/mcp-domain.cjs ERROR_CODE（期望码不许写错）", missingCodes.length === 0, "0 个未知错误码", JSON.stringify({ asserted: ASSERTED_ERROR_CODES, missing: missingCodes }));
  const openedA = await openMcpWindow();
  const infoA = await mcpWindowInfo();
  record("A4", "程序坞打开「MCP 中心」→ 窗口出现 + MCP 域可用", openedA && !!infoA.window && infoA.available === "true", "窗口存在 + data-mcp-available=true", JSON.stringify({ opened: openedA, window: infoA.window, available: infoA.available }));
  const refFx = await fx([], "reference-plain");
  const ref = await rawHttpHandshake(refFx.url);
  const exp = expectedFromReference(ref);
  record("A5", "fixture 参照握手（独立进程，产品链路之外）= 固化常量：protocolVersion/serverInfo/capabilities/tools/toolsHash", referenceMatchesPinned(ref), JSON.stringify(FIXTURE_PINNED), JSON.stringify({ protocolVersion: ref.protocolVersion, serverInfo: ref.serverInfo, capabilities: domain.normalizeCapabilities(ref.capabilities), toolsHash: domain.toolsHash(domain.sanitizeTools(ref.tools).tools), tools: ref.tools.map((t) => t.name) }));
  note("场景期望值一律来自本次参照握手（不抄客户端常量）：" + JSON.stringify({ protocolVersion: exp.protocolVersion, serverName: exp.serverName, toolsHash: exp.toolsHash, tools: exp.toolNames }));

  /* ── 1 持续 POST SSE（响应事件之后继续推通知、流不结束） ── */
  const f1 = await fx(["--sse-stream"], "sse-stream");
  const uiCreate1 = await createViaUI({ name: "流式 POST 服务", transport: "http", location: "REMOTE_SERVICE", url: f1.url, authMode: "NONE", visibility: "PERSONAL" });
  ids.sse = uiCreate1.connectionId;
  const en1 = ids.sse ? await mcpCmd("mcp/setEnabled", { connectionId: ids.sse, enabled: true }) : null;
  record("1a", "任务1 前置：首条连接经界面表单创建（真实 UI 入口，无占位绕过）+ 启用", uiCreate1.ok === true && !!ids.sse && !!(en1 && en1.ok === true), "对话框关闭 + 列表出现该连接 + 启用成功", JSON.stringify({ create: { ok: uiCreate1.ok, reason: uiCreate1.reason || null, dialogClosed: uiCreate1.dialogClosed, listed: uiCreate1.listed, connectionId: ids.sse }, enabled: en1 && en1.ok === true, rows: (await mcpWindowInfo()).rows }));
  const c1 = await connectMeasured(ids.sse);
  const cs1 = await connState(ids.sse);
  const st1 = await f1.state();
  /* 连接是经命令面发起的（与界面同一 IPC）——界面列表不会自己刷新，重新挂载后再取真实投影 */
  const refreshed1 = await reopenMcpWindow();
  const selected1 = await selectRow(ids.sse);
  const d1 = await detailSnapshot();
  const row1 = (await mcpWindowInfo()).rows.find((r) => r.id === ids.sse) || null;
  const boundHalf = Math.round(CLIENT_BOUND.requestTimeoutMs / 2);
  record("1", "持续 POST SSE：服务端先推通知、回响应事件后**继续推通知且流不结束** → mcp/connect 在远低于超时的时间内完成（" + c1.ms + "ms < " + boundHalf + "ms）、连接 READY、工具表正确；服务端侧显示客户端已释放流",
    uiCreate1.ok === true && en1 && en1.ok === true && !!c1.res && c1.res.ok === true && c1.ms < boundHalf && refreshed1 === true && selected1 === true
      && !!cs1.connection && cs1.connection.status === "READY" && cs1.connection.lastErrorCode == null
      && !!st1 && st1.postSse.streams >= 1 && st1.postSse.notifications >= 1 && st1.postSse.closedByClient >= 1 && st1.postSse.openStreams === 0
      && d1.protocolVersion === exp.protocolVersion && d1.serverName === exp.serverName && d1.serverVersion === exp.serverVersion
      && toolsMatchExpected(d1.tools, exp) && d1.toolsHash === exp.toolsHash && !!row1 && row1.status === "READY",
    "connect ok + 耗时 < " + boundHalf + "ms + READY + 工具表/哈希等于参照值 + 服务端 postSse.closedByClient≥1 且 openStreams=0",
    JSON.stringify({ connectMs: c1.ms, connectOk: !!(c1.res && c1.res.ok), requestTimeoutMs: CLIENT_BOUND.requestTimeoutMs, fixtureSide: { streams: st1 && st1.postSse.streams, notifications: st1 && st1.postSse.notifications, closedByClient: st1 && st1.postSse.closedByClient, openStreams: st1 && st1.postSse.openStreams, droppedByServer: st1 && st1.postSse.droppedByServer }, record: { status: cs1.connection && cs1.connection.status, lastErrorCode: cs1.connection && cs1.connection.lastErrorCode, toolsHash: cs1.connection && cs1.connection.toolsHash, protocolVersion: cs1.connection && cs1.connection.protocolVersion }, ui: { protocolVersion: d1.protocolVersion, serverName: d1.serverName, serverVersion: d1.serverVersion, toolsHash: d1.toolsHash, tools: d1.tools, protocolVersionMatch: d1.protocolVersion === exp.protocolVersion }, listRow: row1, uiRefreshed: refreshed1, rowSelected: selected1 }));

  /* ── 2 GET SSE（服务端支持）+ 16b 服务端→客户端请求 -32601 ── */
  const f2 = await fx(["--get-sse", "--server-request-after=2", "--get-sse-notify-interval=200"], "get-sse + server-request");
  const cr2 = await createConn("GET 流服务", { url: f2.url });
  ids.getSse = cr2.connectionId;
  const c2 = await connectMeasured(ids.getSse);
  await waitFor(async () => { const s = await f2.state(); return !!s && s.getSse.opens >= 1; }, 8000, 80);
  const cs2 = await connState(ids.getSse);
  const notified2 = await waitFor(async () => { const s = await f2.state(); return !!s && s.getSse.distinctSent >= 3 && s.serverRequests.sent >= 1; }, 15000, 150);
  const st2 = await f2.state();
  const cs2b = await connState(ids.getSse);
  record("2", "GET SSE：服务端支持时建立 GET 流（getStream.supported=true / state=open / status=200 / error=null，状态如实）；持续收到服务端通知不改变连接可用性（仍 READY 且 lastErrorCode=null）",
    cr2.created && cr2.created.ok === true && !!c2.res && c2.res.ok === true && notified2
      && !!cs2.stream && cs2.stream.supported === true && cs2.stream.state === "open" && cs2.stream.status === 200 && cs2.stream.error === null
      && !!cs2.connection && cs2.connection.status === "READY" && cs2.connection.lastErrorCode == null
      && !!st2 && st2.getSse.opens >= 1 && st2.getSse.openStreams === 1 && st2.getSse.distinctSent >= 3
      && !!cs2b.stream && cs2b.stream.state === "open" && cs2b.stream.events.total >= 2 && !!cs2b.connection && cs2b.connection.status === "READY" && cs2b.connection.lastErrorCode == null,
    "getStream.supported=true/state=open/status=200/error=null + READY + lastErrorCode=null（通知到达后仍成立）+ 服务端 getSse.openStreams=1",
    JSON.stringify({ connectOk: !!(c2.res && c2.res.ok), getStreamAfterConnect: cs2.stream, recordAfterConnect: { status: cs2.connection && cs2.connection.status, lastErrorCode: cs2.connection && cs2.connection.lastErrorCode }, getStreamAfterNotifications: cs2b.stream, recordAfterNotifications: { status: cs2b.connection && cs2b.connection.status, lastErrorCode: cs2b.connection && cs2b.connection.lastErrorCode }, fixtureSide: { opens: st2 && st2.getSse.opens, openStreams: st2 && st2.getSse.openStreams, distinctSent: st2 && st2.getSse.distinctSent, lastSeq: st2 && st2.getSse.lastSeq, hasIds: st2 && st2.getSse.lastEventIdSeen != null } }));
  record("16", "边界：HTTP 下服务端→客户端请求（sampling）真的把 -32601 POST 回去（服务端侧实收计数，不是「未实现所以挂着」）",
    !!st2 && st2.serverRequests.sent >= 1 && (st2.serverRequests.responses || []).some((r) => r.code === -32601),
    "服务端发出 ≥1 条请求 + responses 里出现 code=-32601",
    JSON.stringify({ sent: st2 && st2.serverRequests.sent, responses: st2 && st2.serverRequests.responses, byMethod: st2 && st2.http.byMethod }));

  /* ── 3 GET 405 = 不支持，连接仍 READY，POST 不被连带判死 ── */
  const f3 = await fx([], "get-unavailable-405(默认)");
  const cr3 = await createConn("GET 不支持（405）", { url: f3.url });
  ids.noGet = cr3.connectionId;
  const c3 = await connectMeasured(ids.noGet);
  const cs3 = await connState(ids.noGet);
  const st3 = await f3.state();
  const t3 = await mcpCmd("mcp/test", { connectionId: ids.noGet });
  const cs3b = await connState(ids.noGet);
  const st3b = await f3.state();
  record("3", "GET 405 = 服务端不支持 server→client 流：getStream.supported=false / status=405 / error=null，连接仍 READY 且 lastErrorCode=null；随后 mcp/test 仍成功（POST 未被连带判死）",
    cr3.created && cr3.created.ok === true && !!c3.res && c3.res.ok === true
      && !!cs3.stream && cs3.stream.supported === false && cs3.stream.status === 405 && cs3.stream.error === null
      && !!cs3.connection && cs3.connection.status === "READY" && cs3.connection.lastErrorCode == null
      && !!st3 && st3.getSse.requests >= 1 && st3.getSse.rejected >= 1
      && !!t3 && t3.ok === true && t3.reachable === true && !!t3.negotiated && t3.negotiated.tools.length === exp.tools.length && t3.negotiated.toolsHash === exp.toolsHash
      && !!t3.negotiated.stream && t3.negotiated.stream.supported === false && t3.negotiated.stream.status === 405 && t3.negotiated.stream.error === null
      && !!cs3b.connection && cs3b.connection.status === "READY" && cs3b.connection.lastErrorCode == null,
    "supported=false/status=405/error=null + READY + lastErrorCode=null + mcp/test ok 且工具哈希一致 + test 后仍 READY",
    JSON.stringify({ connectOk: !!(c3.res && c3.res.ok), getStream: cs3.stream, recordAfterConnect: { status: cs3.connection && cs3.connection.status, lastErrorCode: cs3.connection && cs3.connection.lastErrorCode }, mcpTest: { ok: t3 && t3.ok, reachable: t3 && t3.reachable, error: t3 && t3.error, toolsHash: t3 && t3.negotiated && t3.negotiated.toolsHash, tools: t3 && t3.negotiated && t3.negotiated.tools, stream: t3 && t3.negotiated && t3.negotiated.stream }, recordAfterTest: { status: cs3b.connection && cs3b.connection.status, lastErrorCode: cs3b.connection && cs3b.connection.lastErrorCode }, fixtureSide: { gets: st3 && st3.getSse.requests, rejected: st3 && st3.getSse.rejected, posts: st3 && st3.http.posts, byMethod: st3 && st3.http.byMethod, postsAfterTest: st3b && st3b.http.posts } }));

  /* ── 4 带事件 ID 的断线续传 ── */
  const f4 = await fx(["--get-sse", "--get-sse-ids", "--get-sse-replay", "--get-sse-close-after=3", "--get-sse-notify-interval=250"], "get-sse + ids + replay + close-after=3");
  const cr4 = await createConn("断线续传（带事件 ID）", { url: f4.url });
  ids.resume = cr4.connectionId;
  const c4 = await connectMeasured(ids.resume);
  const replayed4 = await waitFor(async () => { const s = await f4.state(); return !!s && s.getSse.replays >= 1; }, 20000, 100);
  /* fixture 的 replays/opens 在响应头写出时就 +1，早于客户端 fetch 返回；必须等客户端侧状态跟上再取样 */
  const resumed4 = await waitFor(async () => { const cs = await connState(ids.resume); return !!(cs.stream && cs.stream.reconnects >= 1); }, 20000, 80);
  const cs4 = await connState(ids.resume);
  const st4 = await f4.state();
  const cs4b = await connState(ids.resume);
  const total4 = cs4b.stream ? cs4b.stream.events.total : null;
  const lastSeen4 = st4 && st4.getSse ? st4.getSse.lastEventIdSeen : null;
  record("4", "带事件 ID 的断线续传：服务端发满 3 条后主动 end() 断开 GET 流且事件带 id → 客户端重连时服务端**实收 Last-Event-ID**（lastEventIdSeen = 断开位置的 id）并只重放其后事件（replayedFrom = 该 id）；客户端无重复结果（duplicates=0，事件总数=服务端不重复发送数）",
    cr4.created && cr4.created.ok === true && !!c4.res && c4.res.ok === true && replayed4
      && Number(st4 && st4.getSse && st4.getSse.closesByServer) >= 1 && Number(st4.getSse.replays) >= 1
      && lastSeen4 != null && /^[0-9]+$/.test(String(lastSeen4)) && Number(lastSeen4) >= 3 && Number(st4.getSse.replayedFrom) === Number(lastSeen4)
      && resumed4 && !!cs4b.stream && cs4b.stream.state !== "closed" && cs4b.stream.hasLastEventId === true && cs4b.stream.reconnects >= 1 && cs4b.stream.events.duplicates === 0
      && typeof total4 === "number" && total4 <= Number(st4.getSse.distinctSent) + 1 && total4 >= Number(st4.getSse.distinctSent) - 3
      && !!cs4b.connection && cs4b.connection.status === "READY" && cs4b.connection.lastErrorCode == null,
    "服务端 lastEventIdSeen 为数字且 = replayedFrom（≥3），closesByServer≥1/replays≥1；客户端 hasLastEventId=true、reconnects≥1、duplicates=0、total≈distinctSent(±1)；连接仍 READY",
    JSON.stringify({ fixtureSide: st4 && { lastEventIdSeen: st4.getSse.lastEventIdSeen, replayedFrom: st4.getSse.replayedFrom, replays: st4.getSse.replays, closesByServer: st4.getSse.closesByServer, opens: st4.getSse.opens, distinctSent: st4.getSse.distinctSent, lastSeq: st4.getSse.lastSeq }, clientSide: cs4b.stream, clientReconnectObserved: resumed4, clientTotalEvents: total4, connectOk: !!(c4.res && c4.res.ok) }));

  /* ── 5 无事件 ID：不续传、不重放 ── */
  const f5 = await fx(["--get-sse", "--get-sse-close-after=3", "--get-sse-notify-interval=200"], "get-sse 无 id");
  const cr5 = await createConn("断线续传（无事件 ID）", { url: f5.url });
  ids.noIds = cr5.connectionId;
  const c5 = await connectMeasured(ids.noIds);
  const reopened5 = await waitFor(async () => { const s = await f5.state(); return !!s && s.getSse.opens >= 2; }, 20000, 100);
  const reconnected5 = await waitFor(async () => { const cs = await connState(ids.noIds); return !!(cs.stream && cs.stream.reconnects >= 1); }, 20000, 80);
  const st5 = await f5.state();
  const cs5 = await connState(ids.noIds);
  record("5", "无事件 ID 的断线：服务端不给 id: → 客户端**不发送 Last-Event-ID、不续传、不重放**（服务端侧 lastEventIdSeen=null / replays=0），重连仍然有界进行且连接保持可用",
    cr5.created && cr5.created.ok === true && !!c5.res && c5.res.ok === true && reopened5
      && !!st5 && st5.getSse.lastEventIdSeen === null && st5.getSse.replays === 0 && st5.getSse.opens >= 2 && Number(st5.getSse.closesByServer) >= 1
      && reconnected5 && !!cs5.stream && cs5.stream.hasLastEventId === false && cs5.stream.reconnects >= 1 && cs5.stream.events.duplicates === 0
      && !!cs5.connection && cs5.connection.status === "READY" && cs5.connection.lastErrorCode == null,
    "服务端 lastEventIdSeen=null 且 replays=0（还有 ≥2 次 GET 打开，说明确实重连过）；客户端 hasLastEventId=false、duplicates=0；连接仍 READY",
    JSON.stringify({ fixtureSide: st5 && { lastEventIdSeen: st5.getSse.lastEventIdSeen, replays: st5.getSse.replays, opens: st5.getSse.opens, closesByServer: st5.getSse.closesByServer, distinctSent: st5.getSse.distinctSent }, clientSide: cs5.stream, clientReconnectObserved: reconnected5, connectOk: !!(c5.res && c5.res.ok) }));

  /* ── 6 重复事件去重 ── */
  const f6 = await fx(["--get-sse", "--get-sse-ids", "--get-sse-duplicate", "--get-sse-notify-interval=150"], "get-sse 同一 id 重发");
  const cr6 = await createConn("重复事件（同一 id）", { url: f6.url });
  ids.dup = cr6.connectionId;
  const c6 = await connectMeasured(ids.dup);
  const dupSeen = await waitFor(async () => { const cs = await connState(ids.dup); return !!(cs.stream && cs.stream.events.duplicates >= 2); }, 20000, 120);
  const cs6 = await connState(ids.dup);
  const st6 = await f6.state();
  record("6", "重复事件：服务端每个事件用同一 id 重发一次 → 客户端按 (channel,id) 去重（duplicates 计数上行），**不把它当成新的结果**（事件总数≈服务端不重复发送数，而不是两倍）；连接保持可用",
    cr6.created && cr6.created.ok === true && !!c6.res && c6.res.ok === true && dupSeen
      && !!st6 && !!st6.getSse && !!cs6.stream && cs6.stream.events.duplicates >= 2 && typeof cs6.stream.events.total === "number" && cs6.stream.events.total <= Number(st6.getSse.distinctSent) + 1
      && Number(st6.getSse.duplicatesSent) >= 1 && Number(cs6.stream.events.duplicates) >= Number(st6.getSse.duplicatesSent) - 1
      && !!cs6.connection && cs6.connection.status === "READY" && cs6.connection.lastErrorCode == null,
    "客户端 duplicates≥2 且 total ≤ distinctSent+1（未重复计数）；服务端 duplicatesSent≥1；连接仍 READY",
    JSON.stringify({ fixtureSide: { duplicatesSent: st6 && st6.getSse.duplicatesSent, distinctSent: st6 && st6.getSse.distinctSent, lastSeq: st6 && st6.getSse.lastSeq }, clientSide: cs6.stream, connectOk: !!(c6.res && c6.res.ok) }));

  /* ── 7 半包 / 超大事件 ── */
  const f7 = await fx(["--sse-split"], "sse 5 字节分片");
  const cr7 = await createConn("半包分片服务", { url: f7.url });
  ids.split = cr7.connectionId;
  const c7 = await connectMeasured(ids.split);
  const cs7 = await connState(ids.split);
  const st7 = await f7.state();
  record("7a", "半包跨 chunk：服务端按 5 字符分片写入 SSE（服务端 splitWrites 计数）→ 客户端仍能拼接出匹配响应、连接 READY 且工具表正确",
    cr7.created && cr7.created.ok === true && !!c7.res && c7.res.ok === true && Number(st7 && st7.postSse.splitWrites) >= 10
      && !!cs7.connection && cs7.connection.status === "READY" && cs7.connection.lastErrorCode == null && cs7.connection.tools.length === exp.tools.length && cs7.connection.toolsHash === exp.toolsHash,
    "splitWrites≥10 + connect ok + READY + 工具表 2 条 + toolsHash 等于参照值",
    JSON.stringify({ connectOk: !!(c7.res && c7.res.ok), connectMs: c7.ms, fixtureSide: st7 && { splitWrites: st7.postSse.splitWrites, streams: st7.postSse.streams }, record: { status: cs7.connection && cs7.connection.status, tools: cs7.connection && cs7.connection.tools.map((t) => t.name), toolsHash: cs7.connection && cs7.connection.toolsHash } }));
  const BIG = 393216;
  const f8 = await fx(["--sse-event-bytes=" + BIG], "sse 超大单事件 " + BIG + "B");
  const cr8 = await createConn("超大单事件服务", { url: f8.url });
  ids.tooLarge = cr8.connectionId;
  const c8 = await connectMeasured(ids.tooLarge);
  const cs8 = await connState(ids.tooLarge);
  await waitFor(async () => { const s = await f8.state(); return !!s && s.postSse.openStreams === 0; }, 6000, 80);
  const st8 = await f8.state();
  record("7b", "超大单事件：" + BIG + "B 的单事件 > 上界 " + CLIENT_BOUND.maxEventBytes + "B → 明确 MCP_STREAM_EVENT_TOO_LARGE；且**不重发请求**（服务端侧 byMethod.initialize=1、bigEvents=1）",
    cr8.created && cr8.created.ok === true && !!c8.res && c8.res.error === "MCP_STREAM_EVENT_TOO_LARGE" && c8.ms <= 15000
      && !!cs8.connection && cs8.connection.status === "ERROR" && cs8.connection.lastErrorCode === "MCP_STREAM_EVENT_TOO_LARGE"
      && Number(st8 && st8.http.byMethod && st8.http.byMethod.initialize) === 1 && Number(st8.postSse.bigEvents) >= 1 && st8.postSse.openStreams === 0,
    "connect.error=MCP_STREAM_EVENT_TOO_LARGE + 记录 status=ERROR/lastErrorCode 同码 + initialize 计数=1（未重发）+ 流已被客户端释放",
    JSON.stringify({ connectError: c8.res && c8.res.error, connectMs: c8.ms, maxEventBytes: CLIENT_BOUND.maxEventBytes, eventBytes: BIG, fixtureSide: { byMethod: st8 && st8.http.byMethod, posts: st8 && st8.http.posts, bigEvents: st8 && st8.postSse.bigEvents, openStreams: st8 && st8.postSse.openStreams, closedByClient: st8 && st8.postSse.closedByClient }, record: { status: cs8.connection && cs8.connection.status, lastErrorCode: cs8.connection && cs8.connection.lastErrorCode } }));

  /* ── 8 无响应有界超时 ── */
  const f9 = await fx(["--sse-notify-only", "--sse-notify-interval=100"], "sse 只推通知不响应");
  const cr9 = await createConn("只推通知不响应", { url: f9.url });
  ids.notifyOnly = cr9.connectionId;
  const c9 = await connectMeasured(ids.notifyOnly);
  const cs9 = await connState(ids.notifyOnly);
  const released9 = await waitFor(async () => { const s = await f9.state(); return !!s && s.postSse.openStreams === 0; }, 8000, 80);
  const st9 = await f9.state();
  record("8", "无响应超时：服务端在 POST 的 SSE 上只推通知、永不回匹配响应 → 有界 MCP_TIMEOUT（客户端上界 " + CLIENT_BOUND.requestTimeoutMs + "ms，实测 " + c9.ms + "ms；不悬挂、不假装成功），超时后客户端释放流",
    cr9.created && cr9.created.ok === true && !!c9.res && c9.res.error === "MCP_TIMEOUT"
      && c9.ms >= CLIENT_BOUND.requestTimeoutMs * 0.75 && c9.ms <= CLIENT_BOUND.requestTimeoutMs + 6000
      && !!cs9.connection && cs9.connection.status === "ERROR" && cs9.connection.lastErrorCode === "MCP_TIMEOUT"
      && Number(st9 && st9.postSse.notifications) >= 1 && released9 && st9.postSse.openStreams === 0,
    "connect.error=MCP_TIMEOUT 且耗时 ∈ [" + Math.round(CLIENT_BOUND.requestTimeoutMs * 0.75) + "," + (CLIENT_BOUND.requestTimeoutMs + 6000) + "]ms + 记录 ERROR/MCP_TIMEOUT + 服务端通知≥1 且流已释放",
    JSON.stringify({ connectError: c9.res && c9.res.error, connectMs: c9.ms, boundMs: CLIENT_BOUND.requestTimeoutMs, fixtureSide: { notifications: st9 && st9.postSse.notifications, streams: st9 && st9.postSse.streams, openStreams: st9 && st9.postSse.openStreams, closedByClient: st9 && st9.postSse.closedByClient }, record: { status: cs9.connection && cs9.connection.status, lastErrorCode: cs9.connection && cs9.connection.lastErrorCode } }));

  /* ── 9 会话失效 ── */
  const f10 = await fx(["--require-session", "--session-expire-after=1"], "session 失效（POST 侧）");
  const cr10 = await createConn("会话失效（POST 侧 404）", { url: f10.url });
  ids.sessionPost = cr10.connectionId;
  const c10 = await connectMeasured(ids.sessionPost);
  const cs10 = await connState(ids.sessionPost);
  const st10a = await f10.state();
  await sleep(2500);
  const st10b = await f10.state();
  record("9a", "会话失效（POST 侧 404 + session 信号）→ MCP_SESSION_EXPIRED、记录状态如实（ERROR）、流与在途收掉（不再 live）、**不自动重连/不自动重发**（2.5s 后服务端 POST 计数不变、initialize 仍为 1）",
    cr10.created && cr10.created.ok === true && !!c10.res && c10.res.error === "MCP_SESSION_EXPIRED" && c10.ms <= 15000
      && !!cs10.connection && cs10.connection.status === "ERROR" && cs10.connection.lastErrorCode === "MCP_SESSION_EXPIRED" && cs10.stream === null
      && Number(st10a && st10a.session && st10a.session.expired) >= 1 && Number(st10a.http.byMethod.initialize) === 1
      && !!st10b && !!st10b.http && st10b.http.posts === st10a.http.posts && Number(st10b.http.byMethod.initialize) === 1,
    "connect.error=MCP_SESSION_EXPIRED + 记录 ERROR/同码 + 无 getStream（不 live）+ 服务端 session.expired≥1 + 无后续 POST",
    JSON.stringify({ connectError: c10.res && c10.res.error, connectMs: c10.ms, fixtureSideAtFail: st10a && { session: st10a.session, byMethod: st10a.http.byMethod, posts: st10a.http.posts }, fixtureSideAfter2500ms: st10b && { session: st10b.session, byMethod: st10b.http.byMethod, posts: st10b.http.posts }, record: { status: cs10.connection && cs10.connection.status, lastErrorCode: cs10.connection && cs10.connection.lastErrorCode, getStream: cs10.stream } }));
  const f11 = await fx(["--get-sse", "--get-sse-ids", "--get-sse-close-after=2", "--get-sse-reconnect-404", "--get-sse-notify-interval=200"], "GET 重连 404（会话失效）");
  const cr11 = await createConn("会话失效（GET 重连 404）", { url: f11.url });
  ids.sessionGet = cr11.connectionId;
  const c11 = await connectMeasured(ids.sessionGet);
  const invalidated11 = await waitFor(async () => { const s = await f11.state(); return !!s && s.getSse.reconnect404 >= 1; }, 20000, 120);
  await sleep(1500);
  const st11 = await f11.state();
  const cs11 = await connState(ids.sessionGet);
  record("9b", "会话失效（GET 流重连 404 = 曾跑通的流回 404）→ MCP_SESSION_EXPIRED、连接如实转 ERROR、流与在途被 abort、**不自动重连**（1.5s 后 GET 打开次数仍为 1）",
    cr11.created && cr11.created.ok === true && !!c11.res && c11.res.ok === true && invalidated11
      && !!cs11.connection && cs11.connection.status === "ERROR" && cs11.connection.lastErrorCode === "MCP_SESSION_EXPIRED" && cs11.stream === null
      && Number(st11 && st11.getSse.opens) === 1 && Number(st11.getSse.reconnect404) >= 1,
    "连接记录 ERROR + MCP_SESSION_EXPIRED + 不再 live（无 getStream）+ 服务端 reconnect404≥1 且 opens 停在 1（无自动重连）",
    JSON.stringify({ connectOk: !!(c11.res && c11.res.ok), fixtureSide: st11 && { opens: st11.getSse.opens, reconnect404: st11.getSse.reconnect404, openStreams: st11.getSse.openStreams, closesByServer: st11.getSse.closesByServer }, record: { status: cs11.connection && cs11.connection.status, lastErrorCode: cs11.connection && cs11.connection.lastErrorCode, getStream: cs11.stream } }));

  /* ── 10 登出：收流 + enabled 不变 + 重新登录可连接 ── */
  const f12 = await fx(["--get-sse", "--get-sse-ids", "--get-sse-notify-interval=200"], "登出收流");
  const cr12 = await createConn("登出收流服务", { url: f12.url });
  ids.logout = cr12.connectionId;
  const c12 = await connectMeasured(ids.logout);
  const cs12before = await connState(ids.logout);
  const openBefore10 = await waitFor(async () => { const s = await f12.state(); return !!s && s.getSse.openStreams === 1; }, 8000, 80);
  const kicked10 = await logout();
  const collected10 = await waitFor(async () => { const s = await f12.state(); return !!s && s.getSse.openStreams === 0; }, 12000, 80);
  const row10 = dbConnection(ids.logout);
  const logs10 = dbLogs(ids.logout);
  const endedLog10 = logs10.find((l) => l.event === "SESSION_ENDED") || null;
  record("10a", "登出（真实 UI 顶栏退出）：撤权前先建好活连接 + GET 流 → 登出后流立刻收掉（服务端 getSse.openStreams 1→0，客户端不再 live）、**enabled 未被改写**、状态如实 DISABLED + MCP_SESSION_ENDED（日志 SESSION_ENDED/detail=logout）",
    !!c12.res && c12.res.ok === true && !!cs12before.stream && cs12before.stream.supported === true && openBefore10 && kicked10 && collected10
      && !!row10 && Number(row10.enabled) === 1 && row10.status === "DISABLED" && row10.last_error_code === "MCP_SESSION_ENDED"
      && !!endedLog10 && endedLog10.error_code === "MCP_SESSION_ENDED" && endedLog10.detail === "logout"
      && !!cs12before.connection && cs12before.connection.status === "READY",
    "登出成功 + 服务端流 1→0 + DB enabled=1/status=DISABLED/last_error_code=MCP_SESSION_ENDED + 日志 SESSION_ENDED(detail=logout)",
    JSON.stringify({ kicked: kicked10, collected: collected10, fixtureSide: { openStreamsNow: (await f12.state()) && (await f12.state()).getSse.openStreams }, beforeLogout: { status: cs12before.connection && cs12before.connection.status, getStream: cs12before.stream }, dbRow: row10, dbLogsNewest: logs10.slice(0, 4), clientDiagnosticsEquivalent: { note: "登出后渲染层无会话，改用服务端 openStreams + DB 记录 + 界面口径三项等价证据", sessionEndedLog: endedLog10 } }));
  const relogin10 = await login(ADMIN.id, ADMIN.pw);
  const list10 = await mcpCmd("mcp/list");
  const reopened10 = await reopenMcpWindow();
  await selectRow(ids.logout);
  const d10 = await detailSnapshot();
  const c10c = await connectMeasured(ids.logout);
  const cs10c = await connState(ids.logout);
  const noteShot = await shotTo(path.join(VIS, "session-ended-note.png"));
  record("10b", "重新登录后：详情页显示「会话已结束」口径（data-mcp-note=session-ended，MCP_SESSION_ENDED），随后仍可再次连接（enabled 保持用户意图 → READY）",
    relogin10 && list10.ok === true && reopened10 && d10.sessionEndedNote === true && d10.sessionEndedText.includes("会话已结束") && d10.enabled === "已启用"
      && !!c10c.res && c10c.res.ok === true && !!cs10c.connection && cs10c.connection.status === "READY",
    "登录成功 + mcp/list ok + 详情 note=session-ended 文案含「会话已结束」+ enabled=已启用 + 再次 connect → READY",
    JSON.stringify({ relogin: relogin10, listOk: list10.ok, reopened: reopened10, ui: { sessionEndedNote: d10.sessionEndedNote, sessionEndedText: d10.sessionEndedText, enabled: d10.enabled, lastError: d10.lastError, status: d10.status }, reconnect: { ok: !!(c10c.res && c10c.res.ok), ms: c10c.ms, status: cs10c.connection && cs10c.connection.status }, shot: noteShot }));

  /* ── 12 停用 / 删除（收流 + 无残留子进程） ── */
  const open12 = await waitFor(async () => { const s = await f12.state(); return !!s && s.getSse.openStreams === 1; }, 8000, 80);
  const dis12 = await mcpCmd("mcp/setEnabled", { connectionId: ids.logout, enabled: false });
  const collected12 = await waitFor(async () => { const s = await f12.state(); return !!s && s.getSse.openStreams === 0; }, 12000, 80);
  const cs12 = await connState(ids.logout);
  const connectDisabled12 = await mcpCmd("mcp/connect", { connectionId: ids.logout });
  const del12 = await mcpCmd("mcp/delete", { connectionId: ids.logout });
  const list12 = await mcpCmd("mcp/list");
  const row12After = dbConnection(ids.logout);
  record("12a", "停用（HTTP，带 GET 流）→ 流收掉 + DISABLED + 停用后不再接受连接；删除 → 界面列表与 DB 都不再有该记录",
    open12 && !!(dis12 && dis12.ok === true) && collected12 && !!cs12.connection && cs12.connection.status === "DISABLED" && cs12.connection.enabled === false && cs12.connection.lastErrorCode == null && cs12.stream === null
      && connectDisabled12.error === "MCP_CONNECTION_DISABLED"
      && !!(del12 && del12.ok === true) && !(list12.items || []).some((i) => i.connectionId === ids.logout) && row12After === null,
    "停用后服务端 openStreams=0 + 记录 DISABLED/enabled=false + mcp/connect=MCP_CONNECTION_DISABLED；删除后 list 与 DB 均无该记录",
    JSON.stringify({ openBefore: open12, collected: collected12, recordAfterDisable: { status: cs12.connection && cs12.connection.status, enabled: cs12.connection && cs12.connection.enabled, lastErrorCode: cs12.connection && cs12.connection.lastErrorCode, getStream: cs12.stream }, connectWhileDisabled: connectDisabled12.error, deleteOk: del12 && del12.ok === true, listHasIt: (list12.items || []).some((i) => i.connectionId === ids.logout), dbRowAfterDelete: row12After }));
  const cr13 = await createConn("本地回显（进程证据）", { transport: "stdio", serverKey: "openarc-test-echo" });
  ids.stdio = cr13.connectionId;
  const pidsIdle13 = descendantPids();
  const sampler13 = startPidSampler(8000);
  const c13 = await connectMeasured(ids.stdio);
  const ready13 = await waitFor(async () => { const cs = await connState(ids.stdio); return !!(cs.connection && cs.connection.status === "READY"); }, 20000, 150);
  const sampled13 = await sampler13.stop();
  const newPids13 = sampled13.filter((s) => !pidsIdle13.includes(s.pid));
  const cs13 = await connState(ids.stdio);
  const dis13 = await mcpCmd("mcp/setEnabled", { connectionId: ids.stdio, enabled: false });
  const childrenGone13 = newPids13.length >= 1 && (await waitFor(() => newPids13.every((p) => !pidAlive(p.pid)), 12000, 150));
  const del13 = await mcpCmd("mcp/delete", { connectionId: ids.stdio });
  const row13After = dbConnection(ids.stdio);
  const stillGone13 = newPids13.every((p) => !pidAlive(p.pid));
  const connectAfterDel13 = await mcpCmd("mcp/connect", { connectionId: ids.stdio });
  record("12b", "停用/删除（本地 stdio，沿用第一批证据口径）：连接期间新起的受控子进程在停用后全部退出，删除后记录消失且无残留子进程",
    cr13.created && cr13.created.ok === true && !!c13.res && c13.res.ok === true && ready13 && !!cs13.connection && cs13.connection.toolsHash === exp.toolsHash
      && newPids13.length >= 1 && Number(dis13 && dis13.ok === true) === 1 && childrenGone13
      && !!(del13 && del13.ok === true) && row13After === null && stillGone13 && connectAfterDel13.error === "MCP_CONNECTION_NOT_FOUND",
    "connect ok + READY + ≥1 个新后代进程 + 停用后全部退出 + 删除后 DB 无记录/无残留 + mcp/connect=MCP_CONNECTION_NOT_FOUND",
    JSON.stringify({ connectMs: c13.ms, spawnedNew: newPids13.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 200) })), toolsHash: cs13.connection && cs13.connection.toolsHash, childrenGone: childrenGone13, deleteOk: del13 && del13.ok === true, dbRowAfterDelete: row13After, stillGone: stillGone13, connectAfterDelete: connectAfterDel13.error, aliveNow: pidInfo(newPids13.map((p) => p.pid)) }));

  /* ── 16 边界硬断言 ── */
  const invCommands = ["mcp/callTool", "mcp/call", "mcp/invoke", "mcp/invokeTool", "mcp/toolCall"];
  const invResults = [];
  for (const command of invCommands) {
    const nested = await js("return await window.openarc.mcp.command(" + JSON.stringify({ command, payload: { connectionId: ids.sse, name: "echo_sum", arguments: { a: 1, b: 2 } } }) + ")");
    const flat = await js("return await window.openarc.mcp.command(" + JSON.stringify({ command, connectionId: ids.sse, name: "echo_sum", arguments: { a: 1, b: 2 } }) + ")");
    invResults.push({ command, nested, flat });
  }
  const unknownCmd = await mcpCmd("mcp/toolsInvoke", { connectionId: ids.sse });
  record("16", "边界①：5 个工具调用入口 × 2 种形状（nested/flat）仍全部 MCP_TOOL_INVOCATION_NOT_ENABLED；未登记命令仍 MCP_COMMAND_NOT_ALLOWED",
    invResults.every((r) => r.nested && r.nested.ok === false && r.nested.error === "MCP_TOOL_INVOCATION_NOT_ENABLED" && r.flat && r.flat.ok === false && r.flat.error === "MCP_TOOL_INVOCATION_NOT_ENABLED")
      && unknownCmd.ok === false && unknownCmd.error === "MCP_COMMAND_NOT_ALLOWED",
    "5×2 全部 MCP_TOOL_INVOCATION_NOT_ENABLED + 未知命令 MCP_COMMAND_NOT_ALLOWED",
    JSON.stringify({ invResults, unknownCmd }));
  const cs16 = await connState(ids.sse);
  record("16", "边界②：协议版本仍是 " + CLIENT_BOUND.protocolVersion + "（客户端常量、连接记录、界面投影三处一致）",
    cs16.ok === true && cs16.connection.protocolVersion === CLIENT_BOUND.protocolVersion && cs16.connection.protocolVersion === domain.MCP_PROTOCOL_VERSION && domain.MCP_PROTOCOL_VERSION === "2025-06-18",
    "记录 protocolVersion = 客户端常量 = 2025-06-18",
    JSON.stringify({ record: cs16.connection && cs16.connection.protocolVersion, clientConstant: CLIENT_BOUND.protocolVersion, domainConstant: domain.MCP_PROTOCOL_VERSION }));
  const allConns16 = dbAll("SELECT connection_id, name, transport, location, endpoint_json FROM mcp_connections");
  const endpointsOnly17 = allConns16.every((r) => {
    try {
      const ep = JSON.parse(r.endpoint_json);
      if (ep.serverKey) return ep.serverKey === "openarc-test-echo";
      return new URL(String(ep.url)).hostname === "127.0.0.1";
    } catch { return false; }
  });
  const fixtureHosts = (await Promise.all(fixtureRows.map(async (f) => { try { const u = new URL(f.url); return u.hostname; } catch { return "?"; } }))).every((h) => h === "127.0.0.1");
  record("16", "边界③：全部 MCP 连接端点只指向自建受控 fixture（stdio 白名单 serverKey openarc-test-echo / 127.0.0.1 动态端口），fixture 实例全部只监听 127.0.0.1",
    allConns16.length >= 1 && endpointsOnly17 && fixtureRows.length >= 8 && fixtureHosts,
    "每条 endpoint_json 都是 openarc-test-echo 或 127.0.0.1 + 本次运行的 fixture 全部 127.0.0.1",
    JSON.stringify({ connections: allConns16, fixtureCount: fixtureRows.length, fixtureHosts }));

  /* ── 13 撤权：即时收流 + 不投影 + view-only 隐藏工具 ── */
  const f14 = await fx(["--get-sse", "--get-sse-ids", "--get-sse-notify-interval=200"], "撤权收流");
  const cr14 = await createConn("撤权收流服务", { url: f14.url });
  ids.revoke = cr14.connectionId;
  const c14 = await connectMeasured(ids.revoke);
  const cs14before = await connState(ids.revoke);
  const open14 = await waitFor(async () => { const s = await f14.state(); return !!s && s.getSse.openStreams === 1; }, 8000, 80);
  const access13 = await governance({ type: "governance/getAppAccess", appId: "mcp-center" });
  const grant13 = access13 && access13.ok ? (access13.grants || []).find((g) => g.resourceType === "mcp") : null;
  const revoked13 = grant13 ? await governance({ type: "governance/revokeAppAccess", grantId: grant13.grantId }) : { ok: false, error: "NO_MCP_GRANT" };
  /* 撤权后**一个 mcp 命令都不发**，先等服务端流被收掉 —— 证明收流是撤权本身驱动的 */
  const collectedByRevoke = await waitFor(async () => { const s = await f14.state(); return !!s && s.getSse.openStreams === 0; }, 10000, 80);
  const row13 = dbConnection(ids.revoke);
  const list13 = await mcpCmd("mcp/list");
  const get13 = await mcpCmd("mcp/get", { connectionId: ids.revoke });
  const connect13 = await mcpCmd("mcp/connect", { connectionId: ids.revoke });
  const test13 = await mcpCmd("mcp/test", { connectionId: ids.revoke });
  const reopened13 = await reopenMcpWindow();
  const scan13 = await js("const t = document.querySelector('[data-mcp-center]'); const norm = function (s) { return String(s || '').replace(/\\s+/g, ' '); }; return { text: norm(t && t.textContent), toolsTable: !!document.querySelector('[data-mcp-tools]'), toolRows: document.querySelectorAll('[data-mcp-tool]').length, hashText: norm(document.querySelector('[data-mcp-tools-hash]')?.textContent), toolsHidden: !!document.querySelector('[data-mcp-tools-hidden]'), errorCode: document.querySelector('[data-mcp-error-code]')?.getAttribute('data-mcp-error-code') || null };");
  const hashPrefix = String(exp.toolsHash).slice(0, 12);
  const leak13 = {
    echo_sum: scan13.text.includes("echo_sum"),
    describe_self: scan13.text.includes("describe_self"),
    description: scan13.text.includes("把两个数字相加"),
    schema: scan13.text.includes("a:number") || scan13.text.includes("verbose:boolean"),
    hash: scan13.text.includes(hashPrefix),
    toolsTable: scan13.toolsTable,
    toolRows: scan13.toolRows,
  };
  const unauthShot = await shotTo(path.join(VIS, "unauthorized.png"));
  record("13", "撤权（governance/revokeAppAccess 撤掉 mcp-center 的 mcp.*）：不发任何 mcp 命令流就被立刻收掉（服务端 openStreams 1→0）；随后 mcp/list|get|connect|test 全 MCP_UNAUTHORIZED；工具名/描述/参数/hash **不再投影**（记录 ERROR + MCP_UNAUTHORIZED）",
    !!(revoked13 && revoked13.ok === true) && open14 && !!cs14before.stream && cs14before.stream.supported === true && collectedByRevoke
      && !!row13 && row13.status === "ERROR" && row13.last_error_code === "MCP_UNAUTHORIZED"
      && list13.error === "MCP_UNAUTHORIZED" && get13.error === "MCP_UNAUTHORIZED" && connect13.error === "MCP_UNAUTHORIZED" && test13.error === "MCP_UNAUTHORIZED"
      && reopened13 && scan13.errorCode === "MCP_UNAUTHORIZED"
      && leak13.echo_sum === false && leak13.describe_self === false && leak13.description === false && leak13.schema === false && leak13.hash === false && leak13.toolsTable === false && leak13.toolRows === 0,
    "撤权 ok + 无 mcp 命令期间服务端流 1→0 + DB ERROR/MCP_UNAUTHORIZED + 4 条命令全 MCP_UNAUTHORIZED + DOM 工具名/描述/参数/hash/工具表 0 命中",
    JSON.stringify({ revoked: revoked13, grant: grant13, collectedWithoutAnyCommand: collectedByRevoke, fixtureSide: { openStreamsNow: (await f14.state()) && (await f14.state()).getSse.openStreams }, beforeRevoke: { getStream: cs14before.stream }, dbRow: row13, commands: { list: { ok: list13.ok, error: list13.error }, get: { ok: get13.ok, error: get13.error }, connect: { ok: connect13.ok, error: connect13.error }, test: { ok: test13.ok, error: test13.error } }, dom: { errorCode: scan13.errorCode, leak: leak13, hashPrefix, textSample: scan13.text.slice(0, 400) }, shot: unauthShot }));
  const grantView13 = await governance({ type: "governance/grantAppAccess", appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view"] });
  const cs13v = await connState(ids.revoke);
  const connectView13 = await mcpCmd("mcp/connect", { connectionId: ids.revoke });
  const reopenedV13 = await reopenMcpWindow();
  await selectRow(ids.revoke);
  const scanV13 = await js("const t = document.querySelector('[data-mcp-center]'); const norm = function (s) { return String(s || '').replace(/\\s+/g, ' '); }; return { text: norm(t && t.textContent), toolsTable: !!document.querySelector('[data-mcp-tools]'), toolRows: document.querySelectorAll('[data-mcp-tool]').length, hashText: norm(document.querySelector('[data-mcp-tools-hash]')?.textContent), toolsHidden: !!document.querySelector('[data-mcp-tools-hidden]'), hiddenText: norm(document.querySelector('[data-mcp-tools-hidden]')?.textContent) };");
  const leakV13 = { echo_sum: scanV13.text.includes("echo_sum"), describe_self: scanV13.text.includes("describe_self"), description: scanV13.text.includes("把两个数字相加"), hash: scanV13.text.includes(hashPrefix), toolRows: scanV13.toolRows, toolsTable: scanV13.toolsTable };
  record("13", "重授 mcp.view-only → toolsHidden=true（工具名/描述/参数/hash 仍不投影，连接状态仍可见）；mcp/connect 仍 MCP_UNAUTHORIZED（缺 mcp.use）",
    !!(grantView13 && grantView13.ok === true) && cs13v.ok === true && !!cs13v.connection && cs13v.connection.toolsHidden === true && (cs13v.connection.tools || []).length === 0 && cs13v.connection.toolsHash === null && cs13v.connection.status === "ERROR"
      && connectView13.error === "MCP_UNAUTHORIZED" && reopenedV13 && scanV13.toolsHidden === true && leakV13.toolRows === 0 && leakV13.echo_sum === false && leakV13.describe_self === false && leakV13.description === false && leakV13.hash === false,
    "grant(view-only) ok + 记录 toolsHidden=true/tools=[]/toolsHash=null + DOM toolsHidden + 0 工具行与 0 命中 + connect=MCP_UNAUTHORIZED",
    JSON.stringify({ grantView: grantView13, record: cs13v.connection && { status: cs13v.connection.status, toolsHidden: cs13v.connection.toolsHidden, tools: cs13v.connection.tools, toolsHash: cs13v.connection.toolsHash }, connectView: connectView13.error, dom: { toolsHidden: scanV13.toolsHidden, hiddenText: scanV13.hiddenText, leak: leakV13 }, reopened: reopenedV13 }));
  const restore13 = await governance({ type: "governance/grantAppAccess", appId: "mcp-center", resourceType: "mcp", actions: [...domain.MCP_ACTIONS_ALL] });
  const listRestored = await waitFor(async () => (await mcpCmd("mcp/list")).ok === true, 15000, 300);
  note("撤权复验后已用正式治理入口恢复 mcp.*（actions=" + JSON.stringify(domain.MCP_ACTIONS_ALL) + "）：" + JSON.stringify({ restoreOk: restore13 && restore13.ok === true, listRestored }));
  for (const cid of ((await mcpCmd("mcp/list")).items || []).map((i) => i.connectionId)) await mcpCmd("mcp/delete", { connectionId: cid });
  note("清理本次运行创建的连接（经 mcp/delete 命令面）：" + JSON.stringify((await mcpCmd("mcp/list")).items || []));

  /* ── 11 关应用（有活连接 + 在途流） ── */
  const f15 = await fx(["--get-sse", "--get-sse-ids", "--get-sse-notify-interval=150"], "退出时活连接 GET 流");
  const q1 = await createConn("退出前活连接", { url: f15.url });
  const q1c = await connectMeasured(q1.connectionId);
  const f16 = await fx(["--sse-notify-only", "--sse-notify-interval=100"], "退出时在途 POST 流");
  const q2 = await createConn("退出前在途流", { url: f16.url });
  const firedQ2 = await js("window.openarc.mcp.command({ command: 'mcp/test', payload: { connectionId: " + JSON.stringify(q2.connectionId) + " } }).catch(function () {}); return 'fired';");
  const preQuit = await waitFor(async () => { const a = await f15.state(); const b = await f16.state(); return !!a && !!b && a.getSse.openStreams >= 1 && b.postSse.openStreams >= 1 && Number(b.postSse.notifications) >= 1; }, 12000, 100);
  const preQuitState = { get: await f15.state(), post: await f16.state() };
  const waitExit = (ms) => new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) return resolve({ code: child.exitCode, signal: child.signalCode });
    const onExit = (code, signal) => { clearTimeout(t); resolve({ code, signal }); };
    const t = setTimeout(() => { child.removeListener("exit", onExit); resolve(null); }, ms);
    child.once("exit", onExit);
  });
  const tQuit = Date.now();
  let quitPath = "page.close()（关窗 → window-all-closed → app.quit → will-quit）";
  try { await page.close(); } catch { /* CDP 可能随应用退出断开 */ }
  let exitInfo = await waitExit(20000);
  if (!exitInfo) { quitPath = "browser.close()（CDP Browser.close 兜底）"; try { await browser.close(); } catch { /* ignore */ } exitInfo = await waitExit(10000); }
  if (!exitInfo) { quitPath = "SIGTERM（非优雅兜底）"; try { child.kill("SIGTERM"); } catch { /* ignore */ } exitInfo = await waitExit(6000); }
  const quitMs = Date.now() - tQuit;
  const disposeLineMatch = stdoutBuf.match(/\[openarc\] MCP 收尾：(\{[^\n]*\})/);
  let dispose = null;
  try { dispose = disposeLineMatch ? JSON.parse(disposeLineMatch[1]) : null; } catch { dispose = null; }
  const leftoverQuit = await waitFor(() => descendantPids().length === 0, 8000, 150);
  const postQuit = { get: await f15.state(), post: await f16.state() };
  record("11", "关应用（退出前有活连接 GET 流 + 在途 POST 流）：优雅退出、退出码正常、主进程 dispose 结果行有界（closed/ended>0、无 error）、服务端两条流全部收掉、无悬挂进程",
    !!exitInfo && exitInfo.code === 0 && !exitInfo.signal && quitPath === "page.close()（关窗 → window-all-closed → app.quit → will-quit）" && quitMs <= 20000
      && !!dispose && dispose.ok !== false && Number(dispose.closed) >= 1 && Number(dispose.ended) >= 1 && Number(dispose.aborted) >= 1 && !dispose.error
      && !!postQuit.get && postQuit.get.getSse.openStreams === 0 && !!postQuit.post && postQuit.post.postSse.openStreams === 0
      && leftoverQuit,
    "退出码 0（无信号）+ 走优雅关窗路径 + ≤20s + stdout dispose 行 ok/closed≥1/aborted≥1/ended≥1/无 error + 两条服务端流归零 + 无后代进程残留",
    JSON.stringify({ quitPath, exitInfo, quitMs, disposeLine: disposeLineMatch ? disposeLineMatch[1] : null, disposeLineStream: disposeLineMatch ? "main-stdout" : null, preQuit, preQuitState: { getOpenStreams: preQuitState.get && preQuitState.get.getSse.openStreams, postOpenStreams: preQuitState.post && preQuitState.post.postSse.openStreams, getDistinctSent: preQuitState.get && preQuitState.get.getSse.distinctSent, postNotifications: preQuitState.post && preQuitState.post.postSse.notifications }, postQuit: { getOpenStreams: postQuit.get && postQuit.get.getSse.openStreams, postOpenStreams: postQuit.post && postQuit.post.postSse.openStreams, postClosedByClient: postQuit.post && postQuit.post.postSse.closedByClient }, leftoverDescendants: descendantPids(), firedQ2: firedQ2 }));

  /* ── Z 收尾 ── */
  const ENV_NOISE = /ExperimentalWarning|SQLite is an experimental|SetApplicationIsDaemon|NSOSStatusErrorDomain|IMKCFRunLoopWakeUpReliable|In-process GPU|ERR_BLOCKED_BY_CSP/;
  const stderrTail = stderrBuf.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !ENV_NOISE.test(l)).slice(0, 5);
  record("Z1", "主进程 stderr 无未处理错误（采样尾部）", stderrTail.length === 0, "无错误行", stderrTail.join(" | ") || "clean");
  note("主进程 stdout 尾部（含 dispose 结果行）：" + JSON.stringify(stdoutBuf.split("\n").filter(Boolean).slice(-6)));
  note("主进程 stderr 尾部：" + JSON.stringify(stderrBuf.split("\n").filter(Boolean).slice(-6)));
  const consoleTail = consoleErrors.filter((l) => !ENV_NOISE.test(l)).slice(0, 5);
  note("渲染层控制台错误样本：" + JSON.stringify(consoleTail));
  note("对话框样本：" + JSON.stringify(dialogs.slice(0, 5)));
  note("边界声明：全程只连自建受控 fixture（tests/fixtures/mcp/echo-server.mjs，stdio 白名单 key + 127.0.0.1 动态端口），不连任何真实第三方服务、不发送用户数据、不运行任意第三方本地程序；本批只覆盖流式收口与生命周期，不声称插件隔离通过（属 D5-04）。");
  const files = fs.existsSync(VIS) ? fs.readdirSync(VIS).sort() : [];
  const testedCommit = process.env.OPENARC_TESTED_COMMIT || (() => { try { return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
  const sourceFingerprint = RUN_ARTIFACTS.collectSourceFingerprint(ROOT, RUN_ARTIFACTS.d503SourceFiles(ROOT).concat(["experiments/d5-03/mcp-stream-e2e.mjs"]));
  const out = {
    phase: "D5-03 第三批",
    title: "MCP 流式收口（POST/GET SSE）+ 生命周期（登出/关应用/停用删除/撤权）真机验收",
    runId: RUN.runId,
    runDir: RUN.runDirRel,
    startedAt: RUN.startedAt,
    testedCommit,
    openarcCommit: testedCommit,
    openarcBranch: (() => { try { return execFileSync("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })(),
    gitDirtyLines: (() => { try { return execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean).length; } catch { return null; } })(),
    command: "node experiments/d5-03/mcp-stream-e2e.mjs",
    clientBounds: CLIENT_BOUND,
    mcpSourceFingerprint: Object.fromEntries(Object.entries(sourceFingerprint.files).map(([f, v]) => [f, v.sha256_16])),
    sourceFingerprint,
    sourceFingerprintSetSha256: sourceFingerprint.setSha256,
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version, cdpPort: CDP_PORT, cdpPorts: RUN.ports.slice(), userDataPrefix: USERDATA_PREFIX, runId: RUN.runId, runDir: RUN.runDirRel },
    fixture: { path: "tests/fixtures/mcp/echo-server.mjs", instances: fixtureRows, reference: exp ? { protocolVersion: exp.protocolVersion, serverName: exp.serverName, serverVersion: exp.serverVersion, toolsHash: exp.toolsHash, tools: exp.toolNames, capabilities: exp.capabilities } : null },
    connectionCreation: { uiForm: { used: true, where: "任务1 首条连接（界面表单 + 空态入口）", ok: uiCreate1.ok === true }, commandSurface: { used: true, via: "window.openarc.mcp.command（与界面同一 IPC 命令面，不直接改库）", note: "其余场景连接按同一命令面创建/启停" } },
    quit: { path: "关应用（任务 11）", stdoutTail: stdoutBuf.split("\n").filter(Boolean).slice(-8), stderrTail: stderrBuf.split("\n").filter(Boolean).slice(-8) },
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS,
    productDefects: DEFECTS,
    visualFiles: files,
    boundary: { thirdPartyServices: false, userDataSent: false, arbitraryLocalPrograms: false, pluginIsolationClaimed: false, note: "只连自建 fixture（stdio 子进程 + 127.0.0.1 HTTP）；流式收口通过不等于插件隔离通过" },
    at: new Date().toISOString(),
  };
  OUT = out;
  out.exitCode = failed === 0 ? 0 : 1;
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  return failed === 0 ? 0 : 1;
}

/* ══════════════════════════ 收尾（只清理本次运行自己 spawn 的进程） ══════════════════════════ */
let OUT = null, exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("验收异常：" + String((e && e.stack) || e));
  record("Z0", "验收脚本无未捕获异常", false, "无异常", String((e && e.message) || e));
  exitCode = 2;
}
try { if (browser) await browser.close().catch(() => {}); } catch { /* ignore */ }
const cleanup = await cleanupOwnProcesses();
console.log("收尾：只清理本次运行 spawn 的 pid 树（" + JSON.stringify(cleanup.targets.map((t) => ({ kind: t.kind, rootPid: t.rootPid, leftovers: t.leftovers }))) + "），未使用 pkill");
try { if (userDataDir) { fs.rmSync(userDataDir, { recursive: true, force: true }); cleanup.userDataRemoved = userDataDir; } } catch { /* ignore */ }
if (RUN) {
  try {
    const fallback = {
      phase: "D5-03 第三批", title: "MCP 流式收口 + 生命周期 真机验收", aborted: true,
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

