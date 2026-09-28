/**
 * D5-03 第二批 · 授权收口（撤权持久化 / 部分授权 / 拒绝路径 / 升级路径）真机验收。
 *
 *   真实 electron .（隔离 userData 前缀 oa-d503b-<runId>-* / 从环境变量基址递增探测的空闲 CDP 端口）+ 真实产品 UI
 *   （程序坞「MCP 中心」）+ 自建受控测试服务 tests/fixtures/mcp/echo-server.mjs。
 *
 * 与 mcp-center-e2e.mjs（第一批，38 条）的关系：
 *   · mcp-center-e2e.mjs 继续作为第一批回归基线：第二批按其新契约只更新了 H2 一条的期望（其余 37 条的判定条件一字未动），
 *     本文件自身不改它任何一行，只在 R 段读回它最近一次运行的 JSON；
 *   · 本文件是第二批新增：撤权即时 / 跨登录 / **跨重启** / 正式重授 / 新组织首用 / 跨组织 /
 *     部分授权（mcp.view only）/ 拒绝路径 / 审计 / 工具调用边界 / **v20 库升级到 v21**；
 *   · 两个脚本各自独立 run 目录（artifacts/d5-03/runs/<runId>/）、独立 userData、各自探测的空闲 CDP 端口，互不共享状态；
 *   · 总数 = 原 38（mcp-center-e2e 最近一次 run 的 JSON）+ 本文件 N（本文件 Z 段汇总，并在 R 段读回该结果）。
 *
 * 硬约束（本脚本自证）：
 *   · **只读**查库（DatabaseSync readOnly），没有任何 UPDATE/INSERT/DELETE/DROP；
 *     迁移由产品自己在启动时完成（L 段验 v20 → v21）。
 *   · 只清理**本次运行自己 spawn 的 pid 树**与自己的 userData 目录；不 pkill 别人的进程。
 *   · 不连真实第三方、不运行任意第三方程序、不发送用户数据、不声称插件隔离通过（见 boundary 字段）。
 *
 * 段：
 *   A 装配 / 隔离 / 首次使用即播种 / schema v21 已生效
 *   B 撤权即时（正式治理入口撤销 → list/get/connect + 界面 + 只读库，四条证据）
 *   C 跨登录持久（登出不重启进程 → 仍无权）
 *   D 跨重启持久（SIGKILL 进程树 + 同一 userData 重启 → 仍无权）★本批最关键
 *   E 正式重授才恢复（重授 → 重启仍授予 → 再撤销 → 重启仍撤销）
 *   F 新组织首次使用仍有既定初始授权（全新安装 = 新组织；撤销 → 重启仍撤销）
 *   G 跨组织互不覆盖（真机可验的 schema 级证据 + 不可构造项如实记 notVerified）
 *   H 部分授权 mcp.view only（四个面 0 外泄；mcp.view+use 阳性对照；撤回后再验）
 *   I 拒绝路径（跨命名空间 / 非管理员 / 越权 scope）
 *   J 审计（authorization_audit 原始行摘要）
 *   K 边界（5 个工具调用入口仍不开放；端点自证）
 *   L 升级路径（v20 库 → 当前 Electron 启动迁移到 v21）
 *   R 第一批回归（读 mcp-center-e2e 最近一次 run 的 JSON；不改原脚本）
 *   Z 收尾（stderr / 产物清单 / 总数）
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
/* 历史产物目录 artifacts/d5-03/ 只读兜底（新运行不再写这里；历史文件原样保留）。 */
const ART = path.join(ROOT, "artifacts", "d5-03");
const RUN_ARTIFACTS = require(path.join(here, "run-artifacts.cjs"));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "mcp", "echo-server.mjs");
const domain = require(path.join(ROOT, "electron", "mcp-domain.cjs"));
const CDP_PORT_BASE = Number(process.env.OA_D503B_CDP_PORT || 9812);
const USERDATA_PREFIX_BASE = "oa-d503b-";
/* 每次启动从本次运行的基址递增取一个空闲端口：探测时占住、spawn 前释放；端口被占时宁可抛错，也不静默连到别的实例。 */
let RUN = null, OUT = null, CDP_BASE = CDP_PORT_BASE, USERDATA_PREFIX = USERDATA_PREFIX_BASE, lastCdpPort = CDP_PORT_BASE - 1;
let VIS = null;

const ADMIN = { id: "admin@d503b-policy.test", pw: "policy-admin-1" };
const MEMBER = { id: "member@d503b-policy.test", pw: "policy-member-1" };
const LEGACY = { id: "admin@d503b-upgrade.test", pw: "upgrade-admin-1", commit: "140182f", schema: 20 };
const extraArgs = (process.env.OA_D503B_ELECTRON_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


/** 界面人话（与 src/mcp/McpCenter.tsx ERROR_LABEL 同源；这里只断言"提示存在"）。 */
const HUMAN_TEXT = { MCP_UNAUTHORIZED: "当前账号或该应用没有被授这个动作" };

/** fixture 真实返回值固化常量（与第一批同一组；L 段/阳性对照都以此为准）。 */
const FIXTURE_EXPECTED = Object.freeze({
  protocolVersion: "2025-06-18",
  serverName: "openarc-test-echo",
  serverVersion: "1.4.0",
  tools: [
    { name: "echo_sum", description: "把两个数字相加并回显（测试服务；不实现调用）", inputSchemaSummary: "type=object; properties: a:number(required), b:number(required); required: a,b" },
    { name: "describe_self", description: "描述本测试服务自身的传输与协议版本", inputSchemaSummary: "type=object; properties: verbose:boolean" },
  ],
  toolsHash: "7db033b3636227f94fc2a51859637cbb7b93c7e865a0e12b79d86c9dda7721ce",
});

/* ══════════════════════════ 记录 / 日志 ══════════════════════════ */
const CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [], LOG_LINES = [], DEFECTS = [], DB_EVIDENCE = {};
let passed = 0, failed = 0;
const defect = (id, title, where, repro, fix) => { const d = { id, title, where, repro, fix }; DEFECTS.push(d); console.log("   ! [DEFECT] " + id + " · " + title + " @ " + where + "\n      复现：" + repro + "\n      最小修法（建议，未动手）：" + fix); return d; };
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

/* ══════════════════════════ 状态 ══════════════════════════ */
let page = null;
let app = null;
const apps = [];
const dialogs = [], consoleErrors = [], fixtures = [];
let runDir = null, freshDir = null, upgradeDir = null;
const state = { orgId: null, freshOrgId: null, connectionId: null, revokedAt: null, provisionedAt: null };
/** 本次运行 spawn 过的全部直接子进程（收尾只杀这些的 pid 树）。 */
const SPAWNS = [];

/* ══════════════════════════ 页面 DOM 助手（与第一批同一口径） ══════════════════════════ */
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
const attrOf = (sel, name) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.getAttribute(" + JSON.stringify(name) + ") || '') : '';");
const waitSel = (sel, ms = 15000) => waitFor(() => has(sel), ms);
const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const mcp = (payload) => js("return await window.openarc.mcp.command(" + JSON.stringify(payload) + ")");
const governance = (payload) => js("return await window.openarc.governance.command(" + JSON.stringify(payload) + ")");
const clipOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return null; const r = el.getBoundingClientRect(); const vw = window.innerWidth, vh = window.innerHeight; const x = Math.max(0, Math.min(r.left, vw - 20)); const y = Math.max(0, Math.min(r.top, vh - 20)); const w = Math.max(20, Math.min(r.width, vw - x)); const h = Math.max(20, Math.min(r.height, vh - y)); return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };");
async function shotTo(file) {
  try {
    const clip = await clipOf('[aria-label="MCP 中心窗口"]');
    if (clip) await page.screenshot({ path: file, clip }); else await page.screenshot({ path: file });
    return path.basename(file);
  } catch { return null; }
}

/* ══════════════════════════ 身份（真实 UI） ══════════════════════════ */
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
async function setupWizard(acct, displayName) {
  await waitSel('[data-d3-id="setup-name"]', 30000);
  const next = async () => {
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000);
    await clickSel('[data-d3-id="setup-next"]');
  };
  await setInput('[data-d3-id="setup-name"]', displayName);
  await next();
  await waitSel('[data-d3-id="setup-identifier"]', 10000);
  await setInput('[data-d3-id="setup-identifier"]', acct.id);
  await next();
  await waitSel('[data-d3-id="setup-password"]', 10000);
  await setInput('[data-d3-id="setup-password"]', acct.pw);
  await setInput('[data-d3-id="setup-confirm"]', acct.pw);
  await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000);
  await clickSel('[data-d3-id="setup-submit"]');
  return await waitFor(async () => ["unauthenticated", "ready"].includes(await gate()), 40000);
}
/**
 * 到达可用会话：全新安装走三步向导（首次使用），已初始化则**显式登出再登录**
 * （不留"会话被自动恢复"的模糊态）。返回到达时的 gate，作为证据。
 */
async function ensureLoggedIn(acct, label) {
  const arrived = await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000) ? await gate() : "timeout";
  let wizard = null;
  if (arrived === "uninitialized") wizard = await setupWizard(acct, label || "D5-03B Admin");
  if ((await gate()) === "ready") { const out = await logout(); if (!out) return { ok: false, arrived, reason: "logout-failed" }; }
  const ok = await login(acct.id, acct.pw);
  return { ok, arrived, wizard, gate: await gate() };
}

/* ══════════════════════════ MCP 中心窗口 ══════════════════════════ */
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
/** 关窗重开 = 强制 McpCenter 重新挂载（授权变化后渲染层不会自己刷新）。失败兜底 reload。 */
async function remountMcp(acct = ADMIN) {
  if (await closeMcpWindow()) return await openMcpWindow();
  await page.reload().catch(() => {});
  const back = await waitFor(async () => ["ready", "unauthenticated", "uninitialized"].includes(await gate()), 40000, 300);
  if (!back) return false;
  if ((await gate()) === "uninitialized") await setupWizard(acct, "D5-03B Admin");
  if ((await gate()) === "unauthenticated") await login(acct.id, acct.pw);
  return (await gate()) === "ready" && (await openMcpWindow());
}
async function waitMcpSettled(ms = 20000) {
  return await waitFor(async () => (await js("return !!document.querySelector('[data-mcp-error], [data-mcp-empty], [data-mcp-list], [data-mcp-detail-state]')")), ms, 150);
}
async function mcpWindowInfo() {
  return await js([
    "const norm = function (s) { return String(s || '').replace(/\\s+/g, ' ').trim(); };",
    "return {",
    "  window: !!document.querySelector('[aria-label=\"MCP 中心窗口\"]'),",
    "  available: document.querySelector('[data-mcp-center]')?.getAttribute('data-mcp-available') || null,",
    "  errorCode: document.querySelector('[data-mcp-error]')?.getAttribute('data-mcp-error-code') || null,",
    "  errorText: norm(document.querySelector('[data-mcp-error]')?.textContent).slice(0, 300),",
    "  detailUnauthorizedCode: document.querySelector('[data-mcp-detail-unauthorized]')?.getAttribute('data-mcp-error-code') || null,",
    "  rows: Array.from(document.querySelectorAll('[data-mcp-connection]')).map(function (el) { return { id: el.getAttribute('data-mcp-connection'), status: el.getAttribute('data-mcp-status'), name: norm(el.querySelector('[data-mcp-name]')?.textContent), tools: norm(el.querySelector('[data-mcp-tool-count]')?.textContent) }; }),",
    "  detailState: document.querySelector('[data-mcp-detail-state]')?.getAttribute('data-mcp-detail-state') || null,",
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
async function detailSnapshot() {
  return await js([
    "const norm = function (s) { return String(s || '').replace(/\\s+/g, ' ').trim(); };",
    "const t = function (sel) { return norm(document.querySelector(sel)?.textContent); };",
    "return {",
    "  state: document.querySelector('[data-mcp-detail-state]')?.getAttribute('data-mcp-detail-state') || null,",
    "  status: t('[data-mcp-status-text]'), toolsHash: t('[data-mcp-tools-hash]'),",
    "  tools: Array.from(document.querySelectorAll('[data-mcp-tool]')).map(function (tr) { return { name: tr.getAttribute('data-mcp-tool'), description: norm(tr.children[1]?.textContent), schema: norm(tr.children[2]?.textContent) }; }),",
    "  toolsHidden: !!document.querySelector('[data-mcp-tools-hidden]'),",
    "  toolsTable: !!document.querySelector('[data-mcp-tools]'),",
    "  logs: Array.from(document.querySelectorAll('[data-mcp-log-index]')).map(function (li) { return { phase: norm(li.querySelector('.mcp-log__phase')?.textContent), message: norm(li.querySelector('.mcp-log__message')?.textContent).slice(0, 200) }; }),",
    "};",
  ].join("\n"));
}
/** 关窗重开 → 选中连接 → 详情快照。返回 null 表示界面没到可读状态（调用方判 FAIL）。 */
async function remountAndDetail(acct = ADMIN) {
  const up = await remountMcp(acct);
  if (!up || !(await waitMcpSettled())) return null;
  if (!(await has('.mcp-row[data-mcp-connection="' + state.connectionId + '"]'))) return null;
  await selectRow(state.connectionId);
  return await detailSnapshot();
}

/* ══════════════════════════ 四个面的泄漏扫描 ══════════════════════════ */
const LEAK_NAMES = ["echo_sum", "describe_self"];
const LEAK_DESCS = ["把两个数字相加", "描述本测试服务"];
const LEAK_SCHEMA = ["properties:", "a:number", "verbose:boolean", "inputSchema"];
const HEX64 = /[0-9a-f]{64}/;
/** 一个面上"4 类数据"的命中情况（true = 泄漏）。hash= 只认**文本与属性值**：data-mcp-tools-hash 是静态属性名，不算数据。 */
function scanFace(text) {
  const s = String(text || "");
  return {
    toolName: LEAK_NAMES.filter((n) => s.includes(n)),
    description: LEAK_DESCS.filter((d) => s.includes(d)),
    schema: LEAK_SCHEMA.filter((k) => s.includes(k)),
    hex64: HEX64.test(s),
    hashEq: s.includes("hash="),
    pinnedHash: s.includes(FIXTURE_EXPECTED.toolsHash),
  };
}
const faceHits = (f) => f.toolName.length + f.description.length + f.schema.length + (f.hex64 ? 1 : 0) + (f.hashEq ? 1 : 0) + (f.pinnedHash ? 1 : 0);
async function domFaces() {
  const raw = await js([
    "const root = document.querySelector('[data-mcp-center]');",
    "if (!root) return { present: false };",
    "const attrValues = [], attrNames = [];",
    "for (const el of [root, ...root.querySelectorAll('*')]) for (const a of Array.from(el.attributes)) { attrNames.push(a.name); attrValues.push(a.value); }",
    "return { present: true, text: root.textContent || '', attrValues: attrValues.join('\\n'), attrNameHashEq: (attrNames.join(' ').match(/hash=/g) || []).length, toolsTable: !!root.querySelector('[data-mcp-tools]'), toolsHidden: !!root.querySelector('[data-mcp-tools-hidden]'), toolRows: root.querySelectorAll('[data-mcp-tool]').length, toolsHashText: (root.querySelector('[data-mcp-tools-hash]')?.textContent || '').trim() };",
  ].join("\n"));
  if (!raw.present) return { present: false, text: scanFace(""), attrs: scanFace(""), info: raw };
  return { present: true, text: scanFace(raw.text), attrs: scanFace(raw.attrValues), info: raw };
}

/* ══════════════════════════ 进程 / DB 取证（只读） ══════════════════════════ */
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
const pidAlive = (pid) => psRows().some((r) => r.pid === pid && !r.stat.startsWith("Z"));
function dbRows(dir, sql) {
  try {
    const db = new DatabaseSync(path.join(dir, "identity.db"), { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  } catch (e) { return [{ __error: String((e && e.message) || e).slice(0, 200) }]; }
}
const J = (v) => { try { return JSON.parse(v || "[]"); } catch { return []; } };
const schemaVersionOf = (dir) => Number((dbRows(dir, "PRAGMA user_version")[0] || {}).user_version ?? -1);
const tableSqlOf = (dir, name) => String((dbRows(dir, "SELECT sql FROM sqlite_master WHERE type='table' AND name='" + name + "'")[0] || {}).sql || "");
const hasTable = (dir, name) => dbRows(dir, "SELECT name FROM sqlite_master WHERE name='" + name + "'").length > 0;
function evidenceOf(dir) {
  const grants = dbRows(dir, "SELECT id, organization_id, app_id, resource_type, department_id, scope, actions, granted_by, created_at FROM app_resource_grants WHERE app_id='mcp-center' ORDER BY created_at, id")
    .map((r) => ({ ...r, actions: J(r.actions) }));
  const provisions = dbRows(dir, "SELECT organization_id, app_id, policy_key, provisioned_at, provisioned_by, revoked_at, revoked_by, updated_at FROM app_policy_provisions WHERE app_id='mcp-center'");
  const mcpOnly = grants.filter((g) => g.resource_type === "mcp");
  return { dir: path.basename(dir), schemaVersion: schemaVersionOf(dir), mcpGrantRows: mcpOnly, mcpGrantCount: mcpOnly.length, allGrantRows: grants, provisions };
}
const mcpGrantOf = (dir) => evidenceOf(dir).mcpGrantRows[0] || null;
const provisionOf = (dir) => (evidenceOf(dir).provisions || []).find((p) => p.policy_key === "mcp") || null;
const auditRowsOf = (dir, limit = 60) => dbRows(dir, "SELECT id, at, actor_user_id, app_id, action, decision, reason_code, old_permissions, new_permissions FROM authorization_audit WHERE action IN ('governance.grantAppPermission','governance.revokeAppPermission') ORDER BY id DESC LIMIT " + limit);
const grantDdlHasOrg = (dir) => { const sql = tableSqlOf(dir, "app_resource_grants"); const m = sql.match(/UNIQUE\s*\(([^)]*)\)/i); return !!(m && m[1].includes("organization_id")); };
const provisionPkHasOrg = (dir) => { const sql = tableSqlOf(dir, "app_policy_provisions"); const m = sql.match(/PRIMARY KEY\s*\(([^)]*)\)/i); return !!(m && m[1].includes("organization_id")); };

/* ══════════════════════════ Electron 启停（只动自己的进程树） ══════════════════════════ */
async function portFree(port) {
  try { await fetch("http://127.0.0.1:" + port + "/json/version"); return false; } catch { return true; }
}
/**
 * CDP 归属校验：渲染层报的 installationId 必须等于**目标 userData 目录**里 identity.db 的
 * installations.id。否则说明连到了别的实例（端口被上一个进程占着）—— 直接抛错，绝不"测了个别的 App"。
 */
async function verifyInstance(rec) {
  const deadline = Date.now() + 20000;
  let inApp = null, inDb = null;
  for (;;) {
    inApp = await js("try { const r = await window.openarc.identity.command({ type: 'identity/status' }); return (r && r.installationId) || null; } catch (e) { return null; }").catch(() => null);
    inDb = ((dbRows(rec.userDataDir, "SELECT id FROM installations LIMIT 1")[0] || {}).id) || null;
    if (inApp && inDb && inApp === inDb) return { ok: true, installationId: inApp };
    // 目标目录还没有 installation 行（全新目录在 initialize 之前不写这一行），却报出了别的 installationId → 串台
    if (inApp && !inDb) return { ok: false, kind: "foreign-instance", inApp, inDb, dir: path.basename(rec.userDataDir) };
    if (inApp && inDb !== inApp) return { ok: false, kind: "mismatch", inApp, inDb, dir: path.basename(rec.userDataDir) };
    // 全新目录的正常形态：库还没有 installation 行 + 界面停在 uninitialized
    if (!inApp && !inDb && (await gate().catch(() => "no-root")) === "uninitialized") {
      return { ok: true, freshUninitialized: true, gate: "uninitialized", cdpPort: rec.cdpPort };
    }
    // 库在、桥不可用（BOOT_FAILED）：归属已由端口独占保证，让后续断言如实失败，不在这里抛
    if (!inApp && inDb && Date.now() > deadline) return { ok: true, degraded: "identity/status 不可用（可能 BOOT_FAILED）", inDb, cdpPort: rec.cdpPort };
    if (Date.now() > deadline) return { ok: false, kind: "timeout", inApp, inDb, dir: path.basename(rec.userDataDir) };
    await sleep(400);
  }
}
async function launchApp({ userDataDir = null, label = "" } = {}) {
  // 上一次实例必须先杀掉：否则新进程抢不到同一个 CDP 端口，会静默连到旧实例。
  if (app) { const stray = await killApp(app); note("launchApp 自我保护：先杀掉仍存活的上一实例 " + JSON.stringify(stray)); }
  const dir = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), USERDATA_PREFIX));
  // 本次运行内单调递增（不复用刚释放的端口），并从基址起递增探测第一个空闲端口：探测即占住，spawn 前释放
  const requested = Math.max(CDP_BASE + apps.length, lastCdpPort + 1);
  const reservation = RUN ? await RUN.acquirePort(requested) : null;
  const cdpPort = reservation ? reservation.port : requested;
  lastCdpPort = cdpPort;
  if (reservation) await reservation.release();
  if (!(await portFree(cdpPort))) throw new Error("CDP 端口 " + cdpPort + " 仍被占用，拒绝启动（避免连到别的实例）");
  const child = spawn(electronPath, [".", "--user-data-dir=" + dir, "--remote-debugging-port=" + cdpPort, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" },
  });
  SPAWNS.push({ kind: "electron", pid: child.pid, label, cdpPort, userDataDir: dir, at: new Date().toISOString() });
  const rec = { label, userDataDir: dir, cdpPort, child, pid: child.pid, browser: null, page: null, stderr: "", launchedAt: Date.now() };
  apps.push(rec);
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { rec.stderr += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
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
  rec.instance = await verifyInstance(rec);
  if (!rec.instance.ok) throw new Error("实例归属校验失败（identity/status 的 installationId ≠ 目标 userData 里 identity.db 的 installations.id）；可能是 CDP 串台，也可能是身份库启动失败： " + JSON.stringify(rec.instance));
  return rec;
}
/** 杀掉自己的这一棵进程树（主进程 + 其后代），并等到确实退出。 */
async function killApp(rec) {
  if (!rec) return null;
  const tree = [rec.child.pid, ...descendantsOf(rec.child.pid).filter((r) => !r.stat.startsWith("Z")).map((r) => r.pid)];
  try { rec.child.kill("SIGKILL"); } catch { /* ignore */ }
  await waitFor(() => !pidAlive(rec.child.pid), 15000, 100);
  for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  await waitFor(() => tree.every((p) => !pidAlive(p)), 12000, 100);
  await waitFor(() => portFree(rec.cdpPort), 10000, 200);
  const out = { pid: rec.child.pid, tree, mainGone: !pidAlive(rec.child.pid), leftovers: tree.filter(pidAlive), cdpPort: rec.cdpPort };
  if (app === rec) { app = null; page = null; }
  return out;
}

/** 收尾：只杀本次运行自己 spawn 的 pid 树（Electron 主进程 + 后代 + fixture 子进程）；绝不按前缀 pkill 别人的。 */
async function cleanupOwnProcesses() {
  const result = { strategy: "own-pid-tree-only", pkillUsed: false, at: new Date().toISOString(), targets: [], leftovers: [] };
  for (const rec of apps) {
    const tree = [rec.child.pid, ...descendantsOf(rec.child.pid).filter((r) => !r.stat.startsWith("Z")).map((r) => r.pid)];
    for (const pid of tree) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await waitFor(() => tree.every((pid) => !pidAlive(pid)), 12000, 100);
    result.targets.push({ kind: "electron", label: rec.label, rootPid: rec.child.pid, tree, leftovers: tree.filter(pidAlive) });
  }
  for (const fx of fixtures) { try { fx.stop(); } catch { /* ignore */ } }
  result.leftovers = [...new Set(result.targets.flatMap((t) => t.leftovers))];
  result.unregisteredSurvivors = SPAWNS.filter((s) => s.pid && s.kind !== "legacy-v20-driver" && pidAlive(s.pid) && !result.targets.some((t) => t.tree.includes(s.pid))).map((s) => ({ pid: s.pid, kind: s.kind, label: s.label }));
  return result;
}

/* ══════════════════════════ fixture ══════════════════════════ */
function startHttpFixture() {
  const c = spawn(process.execPath, [FIXTURE, "--http", "--port=0"], { stdio: ["ignore", "pipe", "pipe"] });
  SPAWNS.push({ kind: "fixture", pid: c.pid, label: "echo-server --http", at: new Date().toISOString() });
  let buf = "", errBuf = "";
  const entry = { child: c, stderr: () => errBuf, stop() { try { c.kill("SIGKILL"); } catch { /* ignore */ } } };
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
async function rawHttpHandshake(url) {
  const post = async (payload) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(payload) });
    return { status: res.status, text: await res.text() };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d5-03b-reference", version: "1.0.0" } } });
  const initMsg = JSON.parse(init.text);
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  return { protocolVersion: initMsg.result.protocolVersion, tools: (JSON.parse(tools.text).result || {}).tools || [] };
}

/* ══════════════════════════ 治理 / MCP 动作 ══════════════════════════ */
async function mcpGrantId() {
  const access = await governance({ type: "governance/getAppAccess", appId: "mcp-center" });
  const grant = access && access.ok ? (access.grants || []).find((g) => g.resourceType === "mcp") : null;
  return { access, grantId: grant ? grant.grantId : null, grant };
}
const revokeByGovernance = (grantId) => governance({ type: "governance/revokeAppAccess", grantId });
const grantByGovernance = (actions, extra = {}) => governance({ type: "governance/grantAppAccess", appId: "mcp-center", resourceType: "mcp", actions, ...extra });
const threeUnauthorized = async (connectionId = state.connectionId) => ({
  list: await mcp({ command: "mcp/list" }),
  get: await mcp({ command: "mcp/get", connectionId }),
  connect: await mcp({ command: "mcp/connect", connectionId }),
});
const allUnauthorized = (r) => r.list.error === "MCP_UNAUTHORIZED" && r.get.error === "MCP_UNAUTHORIZED" && r.connect.error === "MCP_UNAUTHORIZED"
  && r.list.ok === false && r.get.ok === false && r.connect.ok === false;
const brief = (r) => ({ ok: r.ok, error: r.error || null, reason: r.reason || null });
/** 失败响应没有 connection 字段：判定里一律走这个取值器，缺字段就是 FAIL 而不是 TypeError。 */
const conn = (r) => (r && r.connection) || null;

/* ══════════════════════════ v20 旧库构造（旧代码，非改库） ══════════════════════════ */
function buildLegacyV20Db(userDataDir) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), USERDATA_PREFIX + "legacy-"));
  const archive = spawnSync("git", ["-C", ROOT, "archive", LEGACY.commit, "electron", "package.json"], { encoding: "buffer", maxBuffer: 1 << 28 });
  if (archive.status !== 0 || !archive.stdout) return { ok: false, tree, error: "git-archive-failed:" + String(archive.stderr).slice(0, 160) };
  const untar = spawnSync("tar", ["-x", "-C", tree], { input: archive.stdout });
  if (untar.status !== 0) return { ok: false, tree, error: "untar-failed:" + String(untar.stderr).slice(0, 160) };
  const boot = path.join(tree, "electron", "identity-bootstrap.cjs");
  // 驱动文件只调旧代码自己的装配 + 治理 API（不写 SQL）：建库、登录（v20 会种 mcp baseline）、再真实撤销一次。
  const driver = path.join(here, "mcp-policy-legacy-v20-driver.cjs");
  const res = spawnSync(process.execPath, [driver, boot, userDataDir, LEGACY.id, LEGACY.pw], { encoding: "utf8", timeout: 120000 });
  SPAWNS.push({ kind: "legacy-v20-driver", pid: res.pid, label: "spawnSync（同步等待，返回时已退出）", at: new Date().toISOString() });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || "{}")); } catch { payload = { parseError: String(res.stdout).slice(0, 200) }; }
  return { ok: res.status === 0 && !!payload && payload.loginOk === true && payload.revokeOk === true, tree, bootstrap: boot, driver, payload, stderr: String(res.stderr || "").slice(0, 400) };
}

/* ══════════════════════════ 主流程 ══════════════════════════ */
async function main() {
  RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "mcp-policy-e2e", basePort: CDP_PORT_BASE, envBaseVar: "OA_D503B_CDP_PORT", userDataPrefixBase: USERDATA_PREFIX_BASE });
  USERDATA_PREFIX = RUN.userDataPrefix;
  CDP_BASE = CDP_PORT_BASE;
  lastCdpPort = CDP_BASE - 1;
  VIS = path.join(RUN.runDir, "policy-visual");
  fs.mkdirSync(VIS, { recursive: true });
  const runDirOk = fs.mkdtempSync(path.join(os.tmpdir(), USERDATA_PREFIX));
  runDir = runDirOk;
  console.log("本次运行：" + RUN.runId + " → " + RUN.runDirRel + "（CDP 基址 " + CDP_BASE + "，userData 前缀 " + USERDATA_PREFIX + "）");
  const firstScriptSha = { script: fileSha("experiments/d5-03/mcp-center-e2e.mjs"), originalBefore: null };
  firstScriptSha.originalBefore = firstScriptSha.script;

  const fx = startHttpFixture();
  const fxInfo = await fx.ready;
  const fxUrl = fxInfo.url;
  const refHandshake = await rawHttpHandshake(fxUrl);
  record("A", "自建受控 fixture（127.0.0.1 动态端口）参照握手 = 固化常量（tools/toolsHash）",
    refHandshake.protocolVersion === FIXTURE_EXPECTED.protocolVersion
      && domain.toolsHash(domain.sanitizeTools(refHandshake.tools).tools) === FIXTURE_EXPECTED.toolsHash,
    JSON.stringify({ protocolVersion: FIXTURE_EXPECTED.protocolVersion, toolsHash: FIXTURE_EXPECTED.toolsHash }),
    JSON.stringify({ url: fxUrl, protocolVersion: refHandshake.protocolVersion, tools: refHandshake.tools.map((t) => t.name), toolsHash: domain.toolsHash(domain.sanitizeTools(refHandshake.tools).tools) }));

  /* ── A 装配 / 隔离 / 首次使用播种 / schema v21 ── */
  const first = await launchApp({ label: "run1-first-use" });
  const firstLogin = await ensureLoggedIn(ADMIN, "D5-03B Admin");
  record("A", "真实 electron . 启动（隔离 userData " + USERDATA_PREFIX + "* / 隔离 CDP 端口）+ 首次使用三步向导 + 登录 admin",
    !!first.browser && firstLogin.ok === true && (await gate()) === "ready",
    "CDP 可用 + 界面 gate=ready",
    JSON.stringify({ cdpPort: first.cdpPort, instance: first.instance, restarts: apps.map((a) => ({ label: a.label, cdpPort: a.cdpPort, userData: path.basename(a.userDataDir) })), userData: path.basename(first.userDataDir), pid: first.pid, login: firstLogin, gate: await gate() }));

  const orgId = (await js("try { const r = await window.openarc.identity.command({ type: 'identity/status' }); return (r && r.snapshot && r.snapshot.teamId) || null; } catch (e) { return null; }"))
    || ((dbRows(first.userDataDir, "SELECT team_id FROM users WHERE role='ADMIN' LIMIT 1")[0] || {}).team_id || null);
  state.orgId = orgId;
  const evA = evidenceOf(first.userDataDir);
  DB_EVIDENCE.A_firstUse = evA;
  const listA = await mcp({ command: "mcp/list" });
  const provA = provisionOf(first.userDataDir);
  state.provisionedAt = provA ? provA.provisioned_at : null;
  record("A", "首次使用即拿到 mcp baseline（mcp/list ok）+ 只读库：1 行 mcp grant、provisioned_at 非空、revoked_at NULL",
    listA.ok === true && evA.mcpGrantCount === 1 && provA && provA.provisioned_at != null && provA.revoked_at == null,
    "list ok + 1 行 + provisioned_at 非空 + revoked_at NULL",
    JSON.stringify({ orgId, listOk: listA.ok, items: (listA.items || []).length, mcpGrantCount: evA.mcpGrantCount, grant: evA.mcpGrantRows, provision: provA }));

  record("A", "schema v21 已在真机库生效：user_version=21 + app_policy_provisions 存在 + app_resource_grants 唯一键含 organization_id",
    evA.schemaVersion === 21 && hasTable(first.userDataDir, "app_policy_provisions") && grantDdlHasOrg(first.userDataDir) && provisionPkHasOrg(first.userDataDir),
    "user_version=21 + 表存在 + UNIQUE/PRIMARY KEY 含 organization_id",
    JSON.stringify({ userVersion: evA.schemaVersion, provisionTable: hasTable(first.userDataDir, "app_policy_provisions"), grantUnique: (tableSqlOf(first.userDataDir, "app_resource_grants").match(/UNIQUE[^)]*\)/i) || [""])[0], provisionPk: (tableSqlOf(first.userDataDir, "app_policy_provisions").match(/PRIMARY KEY[^)]*\)/i) || [""])[0] }));

  /* ── B0 受控连接 + 四面对照（授权完整时应当"看得见"） ── */
  const created = await mcp({ command: "mcp/create", payload: { name: "策略验收回显", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: fxUrl }, authMode: "NONE", visibility: "PERSONAL" } });
  state.connectionId = created && created.ok ? created.connection.connectionId : null;
  await mcp({ command: "mcp/setEnabled", connectionId: state.connectionId, enabled: true });
  const connected = await mcp({ command: "mcp/connect", connectionId: state.connectionId });
  await remountMcp();
  const detailGranted = await remountAndDetail();
  const getGranted = await mcp({ command: "mcp/get", connectionId: state.connectionId });
  const logGranted = await mcp({ command: "mcp/testLog", connectionId: state.connectionId, limit: 50 });
  const domGranted = await domFaces();
  const grantedFaces = {
    api: scanFace(JSON.stringify(getGranted)),
    log: scanFace(JSON.stringify(logGranted)),
    domText: domGranted.text,
    domAttrs: domGranted.attrs,
  };
  // 日志面只带 hash 前缀（hash=7db0…16 位）不是完整 64 位；它命中 hashEq 就算"看得见"。
  const grantedVisible = faceHits(grantedFaces.api) >= 4 && grantedFaces.log.hashEq === true && faceHits(grantedFaces.domText) >= 4
    && (grantedFaces.domAttrs.toolName.length + grantedFaces.domAttrs.description.length + grantedFaces.domAttrs.schema.length) >= 1;
  record("B0", "阳性对照：授权完整时工具名/描述/参数/hash 在 DOM、mcp/get、mcp/testLog 三面都看得见（证明后面的 0 命中不是「没数据/扫描器坏」）",
    connected.ok === true && connected.connection.toolsHash === FIXTURE_EXPECTED.toolsHash && getGranted.connection.toolsHidden === false
      && (getGranted.connection.tools || []).length === 2 && !!detailGranted && detailGranted.tools.length === 2 && detailGranted.toolsHash === FIXTURE_EXPECTED.toolsHash && grantedVisible,
    "握手 hash=" + FIXTURE_EXPECTED.toolsHash + " + tools=2 + 三面都命中（>0）",
    JSON.stringify({ connectOk: connected.ok, toolsHash: connected.connection ? connected.connection.toolsHash : null, toolsHidden: getGranted.connection ? getGranted.connection.toolsHidden : null, uiTools: detailGranted ? detailGranted.tools.map((t) => t.name) : null, uiHash: detailGranted ? detailGranted.toolsHash : null, faces: { api: grantedFaces.api, log: grantedFaces.log, domText: grantedFaces.domText, domAttrs: grantedFaces.domAttrs }, hits: { api: faceHits(grantedFaces.api), log: faceHits(grantedFaces.log), domText: faceHits(grantedFaces.domText) } }));

  /* ── B 撤权即时 ── */
  const { access, grantId } = await mcpGrantId();
  note("governance/getAppAccess(mcp-center)：" + JSON.stringify({ ok: access && access.ok, grants: (access && access.grants) || [] }));
  const revoked = grantId ? await revokeByGovernance(grantId) : { ok: false, error: "NO_MCP_GRANT" };
  record("B1", "正式治理入口撤销：governance/getAppAccess 找到 mcp-center 的 mcp grantId → governance/revokeAppAccess",
    !!grantId && revoked.ok === true && revoked.changed === true,
    "grantId 存在 + revoke ok/changed",
    JSON.stringify({ grantId, grant: access && access.grants ? access.grants.find((g) => g.resourceType === "mcp") : null, revoked }));

  const bAfter = await threeUnauthorized();
  record("B2", "撤权即时：mcp/list、mcp/get、mcp/connect 全部 MCP_UNAUTHORIZED（无任何「缓存」成功）",
    allUnauthorized(bAfter), "三个命令都 ok=false + MCP_UNAUTHORIZED", JSON.stringify({ list: brief(bAfter.list), get: brief(bAfter.get), connect: brief(bAfter.connect) }));

  const remountB = await remountMcp();
  const bWin = await mcpWindowInfo();
  const bDom = await domFaces();
  const bShot = await shotTo(path.join(VIS, "b3-revoked-immediate.png"));
  record("B3", "撤权即时·真实界面：MCP 中心无权（MCP_UNAUTHORIZED + 人话）+ 工具名/描述/参数/hash 在 DOM 0 命中（含 64 位 hex 与 hash=）",
    remountB && bWin.errorCode === "MCP_UNAUTHORIZED" && bWin.errorText.includes(HUMAN_TEXT.MCP_UNAUTHORIZED)
      && bDom.present && faceHits(bDom.text) === 0 && faceHits(bDom.attrs) === 0 && bDom.info.toolsTable === false && bDom.info.toolRows === 0,
    "界面 MCP_UNAUTHORIZED + 文本/属性值 0 命中 + 无工具表",
    JSON.stringify({ remountB, errorCode: bWin.errorCode, errorText: bWin.errorText, domText: bDom.text, domAttrs: bDom.attrs, domInfo: bDom.info, shot: bShot }));

  const evB = evidenceOf(first.userDataDir);
  DB_EVIDENCE.B_afterRevoke = evB;
  const provB = evB.provisions.find((p) => p.policy_key === "mcp") || null;
  state.revokedAt = provB ? provB.revoked_at : null;
  record("B4", "撤权即时·只读库：app_resource_grants 该组织 mcp 行 = 0；app_policy_provisions 该行 revoked_at 非空（写墓碑）",
    evB.mcpGrantCount === 0 && provB && typeof provB.revoked_at === "number" && !!provB.revoked_by && provB.provisioned_at === state.provisionedAt,
    "mcp 行数 0 + revoked_at 非空 + revoked_by 非空 + provisioned_at 保留",
    JSON.stringify({ mcpGrantCount: evB.mcpGrantCount, grantRows: evB.allGrantRows, provision: provB, provisionedAtBefore: state.provisionedAt }));

  /* ── C 跨登录持久（不重启进程） ── */
  const pidBeforeRelogin = first.pid;
  const loggedOut = await logout();
  const relogin = loggedOut ? await login(ADMIN.id, ADMIN.pw) : false;
  const reloginGate = await gate();
  await remountMcp();
  const cAfter = await threeUnauthorized();
  const cWin = await mcpWindowInfo();
  const cDom = await domFaces();
  record("C1", "跨登录持久：登出 → 重新登录（**不重启进程**）→ 仍无权（API + 界面 + DOM 0 命中）",
    loggedOut === true && relogin === true && reloginGate === "ready" && allUnauthorized(cAfter)
      && cWin.errorCode === "MCP_UNAUTHORIZED" && faceHits(cDom.text) === 0 && faceHits(cDom.attrs) === 0,
    "登出+登录成功 + 三个命令仍 MCP_UNAUTHORIZED + 界面无权",
    JSON.stringify({ loggedOut, relogin, reloginGate, pidBefore: pidBeforeRelogin, pidAfter: first.pid, sameProcess: pidBeforeRelogin === first.pid, list: brief(cAfter.list), get: brief(cAfter.get), connect: brief(cAfter.connect), errorCode: cWin.errorCode, domText: cDom.text, domAttrs: cDom.attrs }));

  const evC = evidenceOf(first.userDataDir);
  DB_EVIDENCE.C_afterRelogin = evC;
  const provC = evC.provisions.find((p) => p.policy_key === "mcp") || null;
  record("C2", "跨登录持久·只读库：mcp 行仍 0；revoked_at 仍是撤权当时那一刻的值（墓碑没被登录播种清掉/改写）",
    evC.mcpGrantCount === 0 && provC && provC.revoked_at === state.revokedAt,
    "mcp 行数 0 + revoked_at === " + state.revokedAt,
    JSON.stringify({ mcpGrantCount: evC.mcpGrantCount, provision: provC, revokedAtAtRevoke: state.revokedAt }));

  /* ── D 跨重启持久 ★ ── */
  const dataDirFirst = first.userDataDir;
  const killed = await killApp(first);
  const launchCmd = (rec) => ({ pid: rec.pid, userDataDir: rec.userDataDir, cmd: "electron . --user-data-dir=" + path.basename(rec.userDataDir) + " --remote-debugging-port=" + rec.cdpPort });
  const second = await launchApp({ userDataDir: dataDirFirst, label: "run2-restart-same-userdata" });
  record("D1", "跨重启：杀掉整个 Electron 进程树（含 Helper）→ 用**同一个 userData 目录**重新启动（新 pid / 同一路径 / 端口已释放）",
    !!killed && killed.mainGone === true && killed.leftovers.length === 0 && !!second.browser && second.userDataDir === dataDirFirst && second.pid !== killed.pid,
    "旧 pid 全退出 + 新 pid + userData 路径相同",
    JSON.stringify({ killed, before: launchCmd(first), after: launchCmd(second), sameUserData: second.userDataDir === dataDirFirst, differentPid: second.pid !== killed.pid }));

  const dLogin = await ensureLoggedIn(ADMIN, "D5-03B Admin");
  const dAfter = await threeUnauthorized();
  record("D2", "跨重启持久：重启后登录 → mcp/list、mcp/get、mcp/connect 仍全部 MCP_UNAUTHORIZED",
    dLogin.ok === true && allUnauthorized(dAfter),
    "登录成功 + 三个命令仍 MCP_UNAUTHORIZED",
    JSON.stringify({ login: dLogin, list: brief(dAfter.list), get: brief(dAfter.get), connect: brief(dAfter.connect) }));

  await remountMcp();
  const dWin = await mcpWindowInfo();
  const dDom = await domFaces();
  const dShot = await shotTo(path.join(VIS, "d3-restart-unauthorized.png"));
  record("D3", "跨重启持久·界面：重启后 MCP 中心仍无权，工具名/描述/参数/hash 0 命中（真实 DOM）",
    dWin.errorCode === "MCP_UNAUTHORIZED" && faceHits(dDom.text) === 0 && faceHits(dDom.attrs) === 0,
    "MCP_UNAUTHORIZED + 0 命中",
    JSON.stringify({ errorCode: dWin.errorCode, domText: dDom.text, domAttrs: dDom.attrs, shot: dShot }));

  const evD = evidenceOf(dataDirFirst);
  DB_EVIDENCE.D_afterRestart = evD;
  const provD = evD.provisions.find((p) => p.policy_key === "mcp") || null;
  record("D4", "跨重启持久·只读库：重启后 mcp 行仍 0、revoked_at 与撤权当时**同一个值**、provisioned_at 仍在（撤销没被重启播种复活）",
    evD.mcpGrantCount === 0 && provD && provD.revoked_at === state.revokedAt && provD.provisioned_at === state.provisionedAt,
    "mcp 行数 0 + revoked_at === " + state.revokedAt + " + provisioned_at 保留",
    JSON.stringify({ mcpGrantCount: evD.mcpGrantCount, provision: provD, revokedAtAtRevoke: state.revokedAt, provisionedAtAtFirstUse: state.provisionedAt }));

  /* ── E 正式重授才恢复 ── */
  const regranted = await grantByGovernance(["mcp.view", "mcp.use", "mcp.manage", "mcp.test"]);
  const evE1 = evidenceOf(dataDirFirst);
  const provE1 = evE1.provisions.find((p) => p.policy_key === "mcp") || null;
  record("E1", "正式重授（governance/grantAppAccess：appId=mcp-center、resourceType=mcp、四动作组合）→ 落库 1 行 + 清墓碑 + provisioned_at 保留",
    regranted.ok === true && evE1.mcpGrantCount === 1 && JSON.stringify(evE1.mcpGrantRows[0].actions.slice().sort()) === JSON.stringify(["mcp.manage", "mcp.test", "mcp.use", "mcp.view"])
      && provE1 && provE1.revoked_at == null && provE1.provisioned_at === state.provisionedAt,
    "grant ok + 1 行四动作 + revoked_at NULL + provisioned_at 保留",
    JSON.stringify({ regranted, mcpGrantCount: evE1.mcpGrantCount, grant: evE1.mcpGrantRows, provision: provE1 }));

  const eList = await mcp({ command: "mcp/list" });
  const eGet = await mcp({ command: "mcp/get", connectionId: state.connectionId });
  const eDetail = await remountAndDetail();
  record("E2", "重授后恢复可用：mcp/list、mcp/get ok + toolsHidden=false + 工具目录（2 个工具 + 同一 hash）回到界面与命令面",
    eList.ok === true && eGet.ok === true && (conn(eGet) || {}).toolsHidden === false && ((conn(eGet) || {}).tools || []).length === 2 && (conn(eGet) || {}).toolsHash === FIXTURE_EXPECTED.toolsHash
      && !!eDetail && eDetail.tools.length === 2 && eDetail.toolsHash === FIXTURE_EXPECTED.toolsHash,
    "list/get ok + tools=2 + hash 一致 + 界面工具表回来",
    JSON.stringify({ listOk: eList.ok, getOk: eGet.ok, toolsHidden: eGet.connection ? eGet.connection.toolsHidden : null, tools: (eGet.connection && eGet.connection.tools || []).map((t) => t.name), hash: eGet.connection ? eGet.connection.toolsHash : null, uiTools: eDetail ? eDetail.tools.map((t) => t.name) : null }));

  const third = await (async () => { const k = await killApp(second); return { killed: k, rec: await launchApp({ userDataDir: dataDirFirst, label: "run3-restart-granted" }) }; })();
  const e3Login = await ensureLoggedIn(ADMIN, "D5-03B Admin");
  const e3List = await mcp({ command: "mcp/list" });
  const e3Get = await mcp({ command: "mcp/get", connectionId: state.connectionId });
  const evE3 = evidenceOf(dataDirFirst);
  record("E3", "重授后**再重启**一次：授权保持（list/get ok + 1 行 + revoked_at NULL）—— 重授不是「只到重启为止」",
    e3Login.ok === true && e3List.ok === true && e3Get.ok === true && (conn(e3Get) || {}).toolsHidden === false && evE3.mcpGrantCount === 1
      && (evE3.provisions.find((p) => p.policy_key === "mcp") || {}).revoked_at == null,
    "登录 + list/get ok + 1 行 + revoked_at NULL",
    JSON.stringify({ restart: third.killed, login: e3Login, listOk: e3List.ok, getOk: e3Get.ok, toolsHidden: e3Get.connection ? e3Get.connection.toolsHidden : null, evidence: evE3 }));

  const regrant = await mcpGrantId();
  const revokedAgain = regrant.grantId ? await revokeByGovernance(regrant.grantId) : { ok: false, error: "NO_MCP_GRANT" };
  const fourth = await (async () => { const k = await killApp(third.rec); return { killed: k, rec: await launchApp({ userDataDir: dataDirFirst, label: "run4-restart-revoked-again" }) }; })();
  const e4Login = await ensureLoggedIn(ADMIN, "D5-03B Admin");
  const e4After = await threeUnauthorized();
  const evE4 = evidenceOf(dataDirFirst);
  const provE4 = evE4.provisions.find((p) => p.policy_key === "mcp") || null;
  record("E4", "再次撤销 → 再重启 → 仍保持撤销（mcp 行 0 + revoked_at 非空 + list/get/connect 全 MCP_UNAUTHORIZED）",
    revokedAgain.ok === true && e4Login.ok === true && allUnauthorized(e4After) && evE4.mcpGrantCount === 0 && provE4 && typeof provE4.revoked_at === "number",
    "revoke ok + 重启后仍 MCP_UNAUTHORIZED + 墓碑在",
    JSON.stringify({ revokedAgain, restart: fourth.killed, login: e4Login, list: brief(e4After.list), get: brief(e4After.get), connect: brief(e4After.connect), evidence: evE4 }));
  state.revokedAt = provE4 ? provE4.revoked_at : state.revokedAt;

  /* ── F 新组织首次使用仍有既定初始授权 ── */
  freshDir = fs.mkdtempSync(path.join(os.tmpdir(), USERDATA_PREFIX));
  const fresh = await launchApp({ userDataDir: freshDir, label: "run5-fresh-org" });
  const fLogin = await ensureLoggedIn(ADMIN, "D5-03B Admin");
  const freshOrgId = (await js("try { const r = await window.openarc.identity.command({ type: 'identity/status' }); return (r && r.snapshot && r.snapshot.teamId) || null; } catch (e) { return null; }"))
    || ((dbRows(freshDir, "SELECT team_id FROM users WHERE role='ADMIN' LIMIT 1")[0] || {}).team_id || null);
  state.freshOrgId = freshOrgId;
  const evF1 = evidenceOf(freshDir);
  const fList = await mcp({ command: "mcp/list" });
  const fCreated = await mcp({ command: "mcp/create", payload: { name: "新组织回显", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: fxUrl }, authMode: "NONE", visibility: "PERSONAL" } });
  const freshConnId = fCreated && fCreated.ok ? fCreated.connection.connectionId : null;
  const fGet = await mcp({ command: "mcp/get", connectionId: freshConnId });
  record("F1", "新组织（全新安装 = 新 organization_id）首次使用仍拿到既定初始授权：mcp baseline 存在、能 list/get",
    fLogin.ok === true && !!freshOrgId && freshOrgId !== state.orgId && fList.ok === true && fGet.ok === true && evF1.mcpGrantCount === 1
      && (evF1.provisions.find((p) => p.policy_key === "mcp") || {}).provisioned_at != null,
    "新 orgId（≠ 第一个组织）+ list/get ok + 1 行 + provisioned_at 非空",
    JSON.stringify({ orgIdFirst: state.orgId, orgIdFresh: freshOrgId, login: fLogin, listOk: fList.ok, getOk: fGet.ok, evidence: evF1 }));

  const fGrant = await mcpGrantId();
  const fRevoked = fGrant.grantId ? await revokeByGovernance(fGrant.grantId) : { ok: false, error: "NO_MCP_GRANT" };
  const fifth = await (async () => { const k = await killApp(fresh); return { killed: k, rec: await launchApp({ userDataDir: freshDir, label: "run6-fresh-org-restart" }) }; })();
  const f2Login = await ensureLoggedIn(ADMIN, "D5-03B Admin");
  const f2After = await threeUnauthorized(freshConnId);
  const evF2 = evidenceOf(freshDir);
  const provF2 = evF2.provisions.find((p) => p.policy_key === "mcp") || null;
  record("F2", "新组织撤销后重启仍撤销（与第一个组织同一口径）：mcp 行 0 + revoked_at 非空 + 三个命令 MCP_UNAUTHORIZED",
    fRevoked.ok === true && f2Login.ok === true && allUnauthorized(f2After) && evF2.mcpGrantCount === 0 && provF2 && typeof provF2.revoked_at === "number",
    "revoke ok + 重启后仍 MCP_UNAUTHORIZED + 墓碑在",
    JSON.stringify({ revoked: fRevoked, restart: fifth.killed, login: f2Login, list: brief(f2After.list), get: brief(f2After.get), connect: brief(f2After.connect), evidence: evF2 }));

  notVerified("同一安装内的**第二个组织**（两组织共库）无法用产品入口构造", "真机上「组织」= teams 行，只在 identity/initialize 里创建 root 团队（electron/identity-store.cjs:1843-1846，唯一的部分索引 idx_teams_single_root 只允许一行 root=1）；渲染层可用的命令白名单里没有任何创建组织的入口（electron/identity-commands/identity-service 的 IDENTITY_COMMANDS/ADMIN_COMMANDS 全集 = identity/{status,initialize,login,restore,logout,lock,unlock,change-password,validate,update-profile,disable-user,enable-user,reset-installation}），governance/createUser 又把 teamId 钉死在 gate.user.team_id（electron/authorization-service.cjs:708）且 governance-bootstrap.cjs:77 不透传 teamId。既有 node 层测试是用 fixture 直接 INSERT teams 造「Foreign Workspace」（tests/device-fixtures.mjs:73）——那正是本批禁止的「直接改库」。因此 F1/F2 只能验到「全新安装 = 新组织」，共库双组织的**行为级**场景在真机不可构造。最小修法建议：给 identity 命令集加 identity/create-team 或让 governance/createUser 透传 teamId（都是在既有 store API 之上的入口，不改授权语义）。");

  /* ── G 跨组织互不覆盖 ── */
  const gDdlA = { dir: path.basename(dataDirFirst), grantUnique: (tableSqlOf(dataDirFirst, "app_resource_grants").match(/UNIQUE[^)]*\)/i) || [""])[0], grantHasOrg: grantDdlHasOrg(dataDirFirst), provisionPkHasOrg: provisionPkHasOrg(dataDirFirst) };
  const gDdlF = { dir: path.basename(freshDir), grantUnique: (tableSqlOf(freshDir, "app_resource_grants").match(/UNIQUE[^)]*\)/i) || [""])[0], grantHasOrg: grantDdlHasOrg(freshDir), provisionPkHasOrg: provisionPkHasOrg(freshDir) };
  const gProvA = provisionOf(dataDirFirst);
  const gProvF = provisionOf(freshDir);
  record("G1", "跨组织覆盖缺陷的**修复点**在真机库上生效：app_resource_grants 唯一键含 organization_id（两个组织的库都验）+ app_policy_provisions 主键含 organization_id + 两库各自只有本组织一行 mcp 记录（organization_id 互不相同）",
    !!gDdlA.grantHasOrg && !!gDdlF.grantHasOrg && !!gDdlA.provisionPkHasOrg && !!gDdlF.provisionPkHasOrg
      && gProvA && gProvF && gProvA.organization_id !== gProvF.organization_id,
    "两个库的 UNIQUE/PRIMARY KEY 都含 organization_id + 两行不同 organization_id",
    JSON.stringify({ firstOrg: gDdlA, freshOrg: gDdlF, provisionFirst: gProvA, provisionFresh: gProvF }));

  notVerified("跨组织**行为级**不互相覆盖（同一库里 A 撤销 → B 不受影响；两种登录顺序各验一次）", "同上：真机不可构造共库双组织（无产品入口）。本轮在真机能拿到的只有 (a) G1 的 schema 级证据（唯一键/主键含 organization_id，即该缺陷的修复点已经落到真机库上）；(b) node 层行为级证据 tests/authorization-app-grant-scope.test.mjs 与 tests/d5-03-mcp-policy-persistence.test.mjs（P1/S1：不同 organization_id 各一行）。真机行为级验收要么等「新建组织」入口落地，要么由产品提供第二个组织（例如多工作区/多租户安装）。");

  /* ── H 部分授权 mcp.view only ── */
  // F/G 段把当前实例切到了新组织；H 段必须在**第一个组织的同一个库**上继续。
  const hApp = await launchApp({ userDataDir: dataDirFirst, label: "run8-back-to-first-org" });
  const hLogin = await ensureLoggedIn(ADMIN, "D5-03B Admin");
  note("H 段前置：重新启动第一个组织的实例（" + path.basename(dataDirFirst) + "，pid=" + hApp.pid + "，login=" + JSON.stringify(hLogin) + "）。");
  const hRegrant = await grantByGovernance(["mcp.view", "mcp.use", "mcp.manage", "mcp.test"]);
  const h0Detail = await remountAndDetail();
  const h0Get = await mcp({ command: "mcp/get", connectionId: state.connectionId });
  const h0Log = await mcp({ command: "mcp/testLog", connectionId: state.connectionId, limit: 50 });
  const h0Dom = await domFaces();
  record("H0", "阳性对照（重授四动作后）：mcp/get tools 2 + hash 一致；DOM 工具表 2 行 + 指纹可见；mcp/testLog 含 hash=（下面 view-only 的 0 命中才有意义）",
    hRegrant.ok === true && (conn(h0Get) || {}).toolsHidden === false && ((conn(h0Get) || {}).tools || []).length === 2
      && JSON.stringify(h0Log).includes("hash=") && !!h0Detail && h0Detail.tools.length === 2 && h0Detail.toolsHash === FIXTURE_EXPECTED.toolsHash && h0Dom.info.toolRows === 2,
    "toolsHash 一致 + DOM 2 行工具 + testLog 有 hash=",
    JSON.stringify({ regrant: { ok: hRegrant.ok }, toolsHidden: h0Get.connection ? h0Get.connection.toolsHidden : null, uiTools: h0Detail ? h0Detail.tools.map((t) => t.name) : null, uiHash: h0Detail ? h0Detail.toolsHash : null, logHashHits: (JSON.stringify(h0Log).match(/hash=/g) || []).length, domToolRows: h0Dom.info.toolRows }));

  /* H2 驱动重基线（第三批契约）：第三批起「撤权才收流」（closeAppConnections + 连接日志 AUTHORIZATION_REVOKED），
     而 H1 把 grant 收窄为 [mcp.view] 是**正式治理入口的 grant**（upsertAppGrant），不是 revoke —— 不触发收流。
     原驱动里 B1/E4/H0 的净效果是"授权回来了、活连接没有"，于是 H2 在 ERROR 上断言 READY（判定本身没错，是被测前提没了）。
     这里先真实 connect 回 READY，H2 的既有断言照旧跑在"连着的时候只有 view 权限"这个原始前提下；不新增/不改判定。 */
  const h0Connect = await mcp({ command: "mcp/connect", connectionId: state.connectionId });
  note("H2 驱动前置：重授四动作后真实 mcp/connect → " + JSON.stringify(brief(h0Connect)) + "，status=" + (conn(h0Connect) ? conn(h0Connect).status : null) + "（随后的 H1 是同一条 grant 的收窄，不是 revoke，按第三批契约不收流）。");

  const viewOnly = await grantByGovernance(["mcp.view"]);
  const evH1 = evidenceOf(dataDirFirst);
  const h1Prov = evH1.provisions.find((p) => p.policy_key === "mcp") || null;
  record("H1", "用正式入口把 grant 置为 [mcp.view]（baseline 形状覆盖同一行）→ 库 1 行、actions=[mcp.view]、revoked_at NULL",
    viewOnly.ok === true && evH1.mcpGrantCount === 1 && JSON.stringify(evH1.mcpGrantRows[0].actions) === JSON.stringify(["mcp.view"]) && h1Prov && h1Prov.revoked_at == null,
    "1 行 + actions=[mcp.view]",
    JSON.stringify({ viewOnly, mcpGrantCount: evH1.mcpGrantCount, grant: evH1.mcpGrantRows, provision: h1Prov }));

  const hDetail = await remountAndDetail();
  const hList = await mcp({ command: "mcp/list" });
  const hGet = await mcp({ command: "mcp/get", connectionId: state.connectionId });
  const hWin = await mcpWindowInfo();
  record("H2", "view-only：toolsHidden===true、tools=[]、toolsHash=null，但**连接状态可见**（mcp/list ok、状态 READY、界面行与状态徽标都在）",
    hGet.ok === true && (conn(hGet) || {}).toolsHidden === true && ((conn(hGet) || {}).tools || []).length === 0 && (conn(hGet) || {}).toolsHash === null
      && hList.ok === true && (hList.items || []).length === 1 && (conn(hGet) || {}).status === "READY"
      && !!hDetail && hDetail.state === "ready" && hDetail.toolsHidden === true && hDetail.tools.length === 0 && hDetail.status.includes("READY")
      && hWin.rows.length === 1 && hWin.rows[0].status === "READY" && hWin.rows[0].tools.includes("无权查看"),
    "toolsHidden=true + tools=[] + hash=null + status=READY + 界面状态可见且工具计数=无权查看",
    JSON.stringify({ getOk: hGet.ok, toolsHidden: hGet.connection ? hGet.connection.toolsHidden : null, tools: (hGet.connection && hGet.connection.tools) || null, hash: hGet.connection ? hGet.connection.toolsHash : null, status: hGet.connection ? hGet.connection.status : null, listItems: (hList.items || []).length, ui: hDetail, uiRow: hWin.rows }));

  const hLog = await mcp({ command: "mcp/testLog", connectionId: state.connectionId, limit: 50 });
  const hDom = await domFaces();
  const hFaces = { domText: hDom.text, domAttrs: hDom.attrs, api: scanFace(JSON.stringify(hGet)), log: scanFace(JSON.stringify(hLog)) };
  const hShot = await shotTo(path.join(VIS, "h3-view-only-no-leak.png"));
  const hHashEqInAttrNames = hDom.info.attrNameHashEq;
  record("H3", "view-only：工具名/描述/参数/hash 在 **DOM、mcp/get、mcp/testLog 三个面**都 0 命中（含 64 位 hex 与 hash=；hash= 只认文本与属性值）",
    hDom.present && faceHits(hFaces.domText) === 0 && faceHits(hFaces.domAttrs) === 0 && faceHits(hFaces.api) === 0 && faceHits(hFaces.log) === 0
      && hDom.info.toolsTable === false && hDom.info.toolRows === 0 && hDom.info.toolsHashText === "尚无快照"
      && JSON.stringify(hLog).includes("tools=2"),
    "三面 faceHits 全 0 + 界面无工具表 + 指纹位显示「尚无快照」+ 日志只保留工具数量",
    JSON.stringify({ faces: hFaces, faceHits: { domText: faceHits(hFaces.domText), domAttrs: faceHits(hFaces.domAttrs), api: faceHits(hFaces.api), log: faceHits(hFaces.log) }, domInfo: hDom.info, hashEqInStaticAttrNames: hHashEqInAttrNames, logKeepsCount: JSON.stringify(hLog).includes("tools=2"), shot: hShot }));

  const hConnect = await mcp({ command: "mcp/connect", connectionId: state.connectionId });
  const hTest = await mcp({ command: "mcp/test", connectionId: state.connectionId });
  record("H4", "view-only：mcp/connect / mcp/test 回 MCP_UNAUTHORIZED（拿不到工具目录的旁路）",
    hConnect.ok === false && hConnect.error === "MCP_UNAUTHORIZED" && hTest.ok === false && hTest.error === "MCP_UNAUTHORIZED",
    "两个命令都 MCP_UNAUTHORIZED",
    JSON.stringify({ connect: brief(hConnect), test: brief(hTest) }));

  const useGrant = await grantByGovernance(["mcp.view", "mcp.use"]);
  const h5Detail = await remountAndDetail();
  const h5Get = await mcp({ command: "mcp/get", connectionId: state.connectionId });
  const h5Dom = await domFaces();
  record("H5", "阳性对照：再授 [mcp.view, mcp.use] → 工具目录立刻可见（toolsHidden=false、DOM 2 行、hash 一致）—— 证明 H3 的隐藏是权限判定不是功能坏了",
    useGrant.ok === true && (conn(h5Get) || {}).toolsHidden === false && ((conn(h5Get) || {}).tools || []).length === 2 && (conn(h5Get) || {}).toolsHash === FIXTURE_EXPECTED.toolsHash
      && !!h5Detail && h5Detail.tools.length === 2 && h5Dom.info.toolRows === 2,
    "toolsHidden=false + DOM 工具表 2 行",
    JSON.stringify({ useGrant: { ok: useGrant.ok }, toolsHidden: h5Get.connection ? h5Get.connection.toolsHidden : null, uiTools: h5Detail ? h5Detail.tools.map((t) => t.name) : null, domToolRows: h5Dom.info.toolRows }));

  const h6Revoke = await mcpGrantId();
  const h6Revoked = h6Revoke.grantId ? await revokeByGovernance(h6Revoke.grantId) : { ok: false, error: "NO_MCP_GRANT" };
  const h6RevokeEv = evidenceOf(dataDirFirst);
  const h6RevokeProv = h6RevokeEv.provisions.find((p) => p.policy_key === "mcp") || null;
  const h6Again = await grantByGovernance(["mcp.view"]);
  const h6Detail = await remountAndDetail();
  const h6Get = await mcp({ command: "mcp/get", connectionId: state.connectionId });
  const h6Log = await mcp({ command: "mcp/testLog", connectionId: state.connectionId, limit: 50 });
  const h6Dom = await domFaces();
  const h6Faces = { domText: h6Dom.text, domAttrs: h6Dom.attrs, api: scanFace(JSON.stringify(h6Get)), log: scanFace(JSON.stringify(h6Log)) };
  record("H6", "整条撤销 → 再正式重授 view-only → 又不外泄（墓碑写过又清，三面仍 0 命中）",
    h6Revoked.ok === true && h6RevokeEv.mcpGrantCount === 0 && h6RevokeProv && typeof h6RevokeProv.revoked_at === "number"
      && h6Again.ok === true && h6Get.ok === true && (conn(h6Get) || {}).toolsHidden === true
      && faceHits(h6Faces.domText) === 0 && faceHits(h6Faces.domAttrs) === 0 && faceHits(h6Faces.api) === 0 && faceHits(h6Faces.log) === 0,
    "撤销(0 行+墓碑) → 重授 view-only → toolsHidden=true + 三面 0 命中",
    JSON.stringify({ revoked: h6Revoked, revokeEvidence: { mcpGrantCount: h6RevokeEv.mcpGrantCount, provision: h6RevokeProv }, regrantViewOnly: h6Again, get: { ok: h6Get.ok, toolsHidden: h6Get.connection ? h6Get.connection.toolsHidden : null }, faces: h6Faces, faceHits: { domText: faceHits(h6Faces.domText), domAttrs: faceHits(h6Faces.domAttrs), api: faceHits(h6Faces.api), log: faceHits(h6Faces.log) }, uiTools: h6Detail ? h6Detail.tools.map((t) => t.name) : null }));

  note("产品行为记录（capabilities）：view-only 时 projectConnection 仍返回服务端 capabilities（tools.listChanged / logging），只隐去工具目录本身（electron/mcp-domain.cjs:292）。它不属于本批点名的 4 类数据（工具名/描述/参数/hash），如实记录不判 FAIL。");

  /* ── I 拒绝路径 ── */
  const beforeI = evidenceOf(dataDirFirst);
  const crossAttempts = [
    { resourceType: "mcp", actions: ["model.use"] },
    { resourceType: "mcp", actions: ["resource.read"] },
    { resourceType: "mcp", actions: ["tool.resource.search"] },
    { resourceType: "mcp", actions: ["mcp.view", "resource.read"] },
    { resourceType: "mcp", actions: ["mcp.use", "model.manage"] },
    { resourceType: "model", actions: ["mcp.view"] },
    { resourceType: "", actions: ["mcp.view"] },
    { resourceType: "mcp", actions: [] },
    { resourceType: "mcp", permissionSet: "VIEWER" },
  ];
  const crossResults = [];
  for (const attempt of crossAttempts) crossResults.push({ attempt, res: await governance({ type: "governance/grantAppAccess", appId: "mcp-center", ...attempt }) });
  const afterI = evidenceOf(dataDirFirst);
  record("I1", "跨命名空间动作组合一律 INVALID_INPUT（mcp grant 里带 model.*/resource.*/tool.*、model grant 带 mcp.*、空资源类型、空动作、permissionSet），且被拒的写入不留任何 grant 行",
    crossResults.every((r) => r.res.ok === false && r.res.error === "INVALID_INPUT")
      && JSON.stringify(afterI.mcpGrantRows) === JSON.stringify(beforeI.mcpGrantRows),
    "9 组尝试全部 INVALID_INPUT + 库行不变",
    JSON.stringify({ results: crossResults.map((r) => ({ attempt: r.attempt, ok: r.res.ok, error: r.res.error })), rowsBefore: beforeI.mcpGrantRows, rowsAfter: afterI.mcpGrantRows }));

  const createdMember = await governance({ type: "governance/createUser", identifier: MEMBER.id, password: MEMBER.pw, displayName: "D5-03B Member", role: "MEMBER" });
  const memberLoggedOut = await logout();
  const memberLogin = memberLoggedOut ? await login(MEMBER.id, MEMBER.pw) : false;
  const memberGetAccess = await governance({ type: "governance/getAppAccess", appId: "mcp-center" });
  const memberGrant = await governance({ type: "governance/grantAppAccess", appId: "mcp-center", resourceType: "mcp", actions: ["mcp.view", "mcp.use"] });
  const memberRevoke = await governance({ type: "governance/revokeAppAccess", grantId: (beforeI.mcpGrantRows[0] || {}).id || "GRANT_not_exists" });
  const afterMember = evidenceOf(dataDirFirst);
  record("I2", "非管理员（MEMBER 账号，真实登录）发起 grant/revoke/getAppAccess → 全部被拒（错误码如实记录），且库里的授权行没被改动",
    createdMember.ok === true && memberLogin === true && memberGrant.ok === false && !!memberGrant.error && memberRevoke.ok === false && !!memberRevoke.error
      && memberGetAccess.ok === false
      && JSON.stringify(afterMember.mcpGrantRows) === JSON.stringify(beforeI.mcpGrantRows),
    "三个治理调用 ok=false（错误码见 actual）+ 库行不变",
    JSON.stringify({ createUser: createdMember, memberLogin, gate: await gate(), getAppAccess: { ok: memberGetAccess.ok, error: memberGetAccess.error || null }, grant: { ok: memberGrant.ok, error: memberGrant.error || null }, revoke: { ok: memberRevoke.ok, error: memberRevoke.error || null }, rowsBefore: beforeI.mcpGrantRows, rowsAfter: afterMember.mcpGrantRows }));
  note("非管理员拒绝码（如实记录）：grant/revoke/getAppAccess → " + JSON.stringify({ grant: memberGrant.error, revoke: memberRevoke.error, getAppAccess: memberGetAccess.error }) + "；与 authorization-domain.cjs:298-306（GRANT_APP_PERMISSION / REVOKE_APP_PERMISSION 属 SUPER_ADMIN_ONLY）+ authorization-service.cjs:591 的预期一致。");

  const memberScopeAttempt = await governance({ type: "governance/grantAppAccess", appId: "mcp-center", resourceType: "mcp", scope: "ORGANIZATION", actions: ["mcp.manage"] });
  const memberScopeAttempt2 = await governance({ type: "governance/grantAppAccess", appId: "mcp-center", resourceType: "mcp", actions: ["mcp.manage"] });
  const backToAdmin = await logout();
  const adminAgain = backToAdmin ? await login(ADMIN.id, ADMIN.pw) : false;
  const superScope = await governance({ type: "governance/grantAppAccess", appId: "mcp-center", resourceType: "mcp", scope: "ORGANIZATION", actions: ["mcp.manage"] });
  const superScopeRow = superScope.ok ? ((await mcpGrantId()).access.grants || []).filter((g) => g.resourceType === "mcp" && g.scope === "ORGANIZATION") : [];
  const superCleanup = superScopeRow.length ? await revokeByGovernance(superScopeRow[0].grantId) : null;
  const afterI3 = evidenceOf(dataDirFirst);
  record("I3", "越权拒绝：非管理员授 ORGANIZATION scope 的 mcp.manage（两种形状）都被拒；同一组合只有 SUPER_ADMIN 能过（验完立刻撤销恢复原状）",
    memberScopeAttempt.ok === false && !!memberScopeAttempt.error && memberScopeAttempt2.ok === false && !!memberScopeAttempt2.error
      && adminAgain === true && superScope.ok === true && superScopeRow.length === 1 && superCleanup && superCleanup.ok === true
      && JSON.stringify(afterI3.mcpGrantRows.slice().sort((a, b) => a.id.localeCompare(b.id))) === JSON.stringify(beforeI.mcpGrantRows.slice().sort((a, b) => a.id.localeCompare(b.id))),
    "member 两次被拒 + admin 成功一次 + 清理后库行回到原状",
    JSON.stringify({ memberOrgScope: { ok: memberScopeAttempt.ok, error: memberScopeAttempt.error || null }, memberNoScope: { ok: memberScopeAttempt2.ok, error: memberScopeAttempt2.error || null }, adminAgain, superScope: { ok: superScope.ok, created: superScope.created === true }, superScopeRow, superCleanup, rowsAfter: afterI3.mcpGrantRows }));
  note("越权 scope 的边界（如实记录）：真机上唯一的非管理员是 MEMBER，而 GRANT_APP_PERMISSION 本身在 SUPER_ADMIN_ONLY 里，所以「scope=ORGANIZATION 且非 super」这一层判据（authorization-service.cjs:777/817 口径）在真机上无法单独触达 —— 只能观测到更外层的 NOT_SUPER_ADMIN。");

  /* ── J 审计 ── */
  const auditRows = auditRowsOf(dataDirFirst);
  DB_EVIDENCE.J_audit = auditRows;
  const grantAudit = auditRows.filter((r) => r.action === "governance.grantAppPermission");
  const revokeAudit = auditRows.filter((r) => r.action === "governance.revokeAppPermission");
  const summary = auditRows.slice(0, 12).map((r) => ({ id: r.id, at: new Date(Number(r.at)).toISOString(), action: r.action, decision: r.decision, reasonCode: r.reason_code, old: J(r.old_permissions), new: J(r.new_permissions) }));
  record("J1", "审计：authorization_audit 里 grant/revoke 各有行，old_permissions/new_permissions 如实（grant 的新动作、revoke 的旧动作、撤销后 new=[]）",
    grantAudit.length >= 2 && revokeAudit.length >= 2
      && grantAudit.every((r) => J(r.new_permissions).some((a) => a.startsWith("mcp.")))
      && revokeAudit.every((r) => J(r.old_permissions).some((a) => a.startsWith("mcp.")) && J(r.new_permissions).length === 0)
      && grantAudit.some((r) => J(r.new_permissions).length === 1 && J(r.new_permissions)[0] === "mcp.view")
      && grantAudit.some((r) => J(r.new_permissions).sort().join(",") === "mcp.manage,mcp.test,mcp.use,mcp.view"),
    "grant ≥2 行（含四动作与 view-only 各一次）+ revoke ≥2 行（old=mcp.*、new=[]）",
    JSON.stringify({ grantRows: grantAudit.length, revokeRows: revokeAudit.length, summary }));

  const revokeAuditApps = [...new Set(revokeAudit.map((r) => r.app_id))];
  const j2 = record("J2", "撤销审计行必须记**被撤销授权的那个 App**（app_id=mcp-center）：迁移补墓碑与审计追责都只认这一列",
    revokeAudit.length > 0 && revokeAudit.every((r) => r.app_id === "mcp-center"),
    "revoke 行的 app_id 全部 = mcp-center",
    JSON.stringify({ revokeRows: revokeAudit.length, appIdValues: revokeAuditApps, revokedAppsByOldPermissions: revokeAudit.map((r) => ({ id: r.id, appId: r.app_id, old: J(r.old_permissions) })) }));
  if (!j2) defect("D5-03B-D1",
    "撤销审计行的 app_id 记的是「治理上下文 App」（缺省 resource-library），不是被撤销授权所属的 App —— 于是 v21 迁移把 baseline 墓碑补到了错误的 App 上",
    "electron/authorization-service.cjs:570-572（#governanceGate：appId = context?.appId || \"resource-library\"）+ :601-605（#govAudit：appId = gate.prepared.app.app_id）+ :1230-1237（revokeAppResourcePermission 的审计调用不带被撤 App）+ electron/governance-bootstrap.cjs:72（context.appId 缺省 resource-library）+ electron/identity-store.cjs:1423-1434（backfill 用 a.app_id 当 provision 的 app_id）",
    "governance/revokeAppAccess({grantId})（渲染层 GovernanceApp 里根本没有 App-grant 的撤销入口，只有工具权限；桥调用默认不带 appId）→ 只读查 authorization_audit：action=governance.revokeAppPermission 的行 app_id='resource-library'，而 old_permissions=[\"mcp.view\",…]。后果见 L3：v20 库里撤销过的 mcp-center baseline，在升级到 v21 之后墓碑写到了 (org,'resource-library','mcp')，(org,'mcp-center','mcp') 没有记录 → 登录时 seedMcpAppPolicy 判定「从未提供」→ 把撤销的授权**种回来**。",
    "在 revokeAppResourcePermission 里把被撤 grant 的 app_id 带进审计（#govAudit 增加可选的 appId 覆盖，或直接 this.store.auditAuthorization({ appId: before.app_id, … })），与 grantAppResourcePermission 同口径；迁移补写保持用 a.app_id 即可自动变正确。可选加固：backfillPolicyProvisions 里当 a.app_id 与 old_permissions 命名空间不符时，按 namespace 取族并对所有 baseline App 补墓碑（保守方向）。");

  /* ── K 边界 ── */
  const invCommands = ["mcp/callTool", "mcp/call", "mcp/invoke", "mcp/invokeTool", "mcp/toolCall"];
  const invResults = [];
  for (const command of invCommands) {
    const nested = await mcp({ command, payload: { connectionId: state.connectionId, name: "echo_sum", arguments: { a: 1, b: 2 } } });
    const flat = await mcp({ command, connectionId: state.connectionId, name: "echo_sum", args: { a: 1, b: 2 } });
    invResults.push({ command, nested: brief(nested), flat: brief(flat) });
  }
  const unknownCmd = await mcp({ command: "mcp/toolsInvoke", connectionId: state.connectionId });
  record("K1", "边界复验：5 个工具调用入口（nested + flat 两种形状）仍全部 MCP_TOOL_INVOCATION_NOT_ENABLED；未登记命令仍 MCP_COMMAND_NOT_ALLOWED",
    invResults.every((r) => r.nested.ok === false && r.nested.error === "MCP_TOOL_INVOCATION_NOT_ENABLED" && r.flat.ok === false && r.flat.error === "MCP_TOOL_INVOCATION_NOT_ENABLED")
      && unknownCmd.ok === false && unknownCmd.error === "MCP_COMMAND_NOT_ALLOWED",
    "5×2 全 MCP_TOOL_INVOCATION_NOT_ENABLED + 未知命令 MCP_COMMAND_NOT_ALLOWED",
    JSON.stringify({ invResults, unknownCmd: brief(unknownCmd) }));

  const conns = dbRows(dataDirFirst, "SELECT connection_id, name, transport, location, endpoint_json FROM mcp_connections");
  const endpointsLocal = conns.length >= 1 && conns.every((r) => { try { return new URL(JSON.parse(r.endpoint_json).url).hostname === "127.0.0.1"; } catch { return false; } });
  const fixturePids = fixtures.filter((f) => f.child && f.child.pid).map((f) => f.child.pid);
  record("K2", "自证边界（端点）：本次全部 MCP 连接端点只指向自建 fixture（127.0.0.1 动态端口），没有连任何真实第三方",
    endpointsLocal,
    "每条 endpoint_json 都是 127.0.0.1",
    JSON.stringify({ connections: conns, fixtureUrl: fxUrl, fixturePids }));

  /* ── L 升级路径（已存在的 v20 库 + 库里一次真实撤销 → 当前 Electron 启动迁移到 v21） ── */
  upgradeDir = fs.mkdtempSync(path.join(os.tmpdir(), USERDATA_PREFIX + "upgrade-"));
  const legacyBuild = buildLegacyV20Db(upgradeDir);
  const legacyV = schemaVersionOf(upgradeDir);
  const legacyEv = evidenceOf(upgradeDir);
  const legacyPayload = legacyBuild.payload || {};
  const legacyAllGrantIds = dbRows(upgradeDir, "SELECT id FROM app_resource_grants ORDER BY id").map((r) => r.id);
  record("L1", "用 v20 代码（git archive " + LEGACY.commit + " 的 electron/，跑它自己的 createIdentityService + governanceService，**不写一行 SQL**）建出 v20 库，并在旧代码上真实撤销一次 mcp-center baseline",
    legacyBuild.ok === true && legacyV === LEGACY.schema && hasTable(upgradeDir, "app_policy_provisions") === false
      && legacyPayload.revokeOk === true && legacyPayload.mcpRowsAfterRevoke === 0 && legacyEv.mcpGrantCount === 0,
    "user_version=20 + 无 app_policy_provisions + 撤销后 mcp 行 0",
    JSON.stringify({ payload: legacyPayload, userVersion: legacyV, provisionTableExists: hasTable(upgradeDir, "app_policy_provisions"), mcpGrantCount: legacyEv.mcpGrantCount, allGrantRows: legacyAllGrantIds.length, allGrantIds: legacyAllGrantIds, legacyTree: path.basename(legacyBuild.tree), stderr: legacyBuild.stderr }));

  const up = await launchApp({ userDataDir: upgradeDir, label: "run7-v20-upgrade" });
  const upGateArrived = await waitFor(async () => ["uninitialized", "unauthenticated", "ready", "boot-failed"].includes(await gate()), 60000) ? await gate() : "timeout";
  const upVersion = schemaVersionOf(upgradeDir);
  const upGrantRows = evidenceOf(upgradeDir).allGrantRows;
  const upProvisions = dbRows(upgradeDir, "SELECT organization_id, app_id, policy_key, provisioned_at, provisioned_by, revoked_at, revoked_by FROM app_policy_provisions WHERE app_id IN ('mcp-center','resource-library') ORDER BY app_id, policy_key");
  const upAllGrantIds = dbRows(upgradeDir, "SELECT id FROM app_resource_grants ORDER BY id").map((r) => r.id);
  // 迁移的行保留是**整表**性质：逐行搬运不得丢行。故意看整表，不看被撤销的 App 那几行
  // （那几行的"该不该被种回来"是 L3 的语义判定，别和迁移机制混在一起）。
  // 迁移的判据是"一条不丢"（子集）；"有没有多出来的行"属于播种语义，在 L3 判。
  const lostRows = legacyAllGrantIds.filter((id) => !upAllGrantIds.includes(id));
  const noRowLost = lostRows.length === 0;
  const seededAtBoot = upAllGrantIds.filter((id) => !legacyAllGrantIds.includes(id));
  const upMigErr = up.stderr.split("\n").filter((l) => /SchemaTooNew|migrat|迁移|SqliteError|Error/.test(l)).filter((l) => !/ExperimentalWarning|SQLite is an experimental/.test(l)).slice(0, 4);
  DB_EVIDENCE.L2_afterMigration = { userVersion: upVersion, provisions: upProvisions, grantRows: upGrantRows };
  record("L2", "升级路径：v20 库上启动当前 Electron → 自动迁移到 v21（user_version=21 + 建 app_policy_provisions + 唯一键含 organization_id + 既有授权行 id 一条不丢 + 主进程无迁移错误）",
    upVersion === 21 && hasTable(upgradeDir, "app_policy_provisions") && grantDdlHasOrg(upgradeDir) && noRowLost && upMigErr.length === 0,
    "user_version=21 + 表存在 + 唯一键含 organization_id + 整表 grant 行 id 一条不丢 + 无错误",
    JSON.stringify({ arrivedGate: upGateArrived, userVersion: upVersion, provisionTable: hasTable(upgradeDir, "app_policy_provisions"), grantUnique: (tableSqlOf(upgradeDir, "app_resource_grants").match(/UNIQUE[^)]*\)/i) || [""])[0], rowsBefore: legacyAllGrantIds.length, rowsAfter: upAllGrantIds.length, noRowLost, lostRows, newRowsAtBoot: seededAtBoot, migrationErrors: upMigErr, provisionsWritten: upProvisions }));

  const upLogin = await ensureLoggedIn(LEGACY, "Upgrade Admin");
  const upList = await mcp({ command: "mcp/list" });
  const upMcpRows = evidenceOf(upgradeDir).mcpGrantRows;
  const upProvMcp = upProvisions.find((p) => p.app_id === "mcp-center" && p.policy_key === "mcp") || null;
  const upProvBogus = upProvisions.find((p) => p.app_id !== "mcp-center") || null;
  const l3 = record("L3", "升级后撤销仍保持：v20 库里撤销过的 mcp-center baseline 不得被升级/登录种回来（墓碑必须落在 (organization_id,'mcp-center','mcp')）",
    upLogin.ok === true && upList.ok === false && upList.error === "MCP_UNAUTHORIZED" && upMcpRows.length === 0 && upProvMcp && typeof upProvMcp.revoked_at === "number",
    "登录后 mcp/list 仍 MCP_UNAUTHORIZED + mcp 行 0 + (org,mcp-center,mcp) 有 revoked_at",
    JSON.stringify({ login: upLogin, list: brief(upList), mcpGrantCount: upMcpRows.length, mcpGrantRows: upMcpRows, provisionForMcpCenter: upProvMcp, bogusProvision: upProvBogus, allProvisions: upProvisions }));
  if (!l3) {
    if (j2) defect("D5-03B-D2", "v21 迁移没把「已撤销」补成墓碑：v20 库里撤销过的 mcp-center baseline 在升级后被重新种回来", "electron/identity-store.cjs:1399-1435（backfillPolicyProvisions）", "v20 库 + 一次真实撤销 → 升级启动 → 登录：mcp/list 竟然 ok、mcp 行 1 条", "让 backfill 的 app_id 与被撤 App 对齐（见 D5-03B-D1 的修法）。");
    else note("L3 的失败与 J2/D5-03B-D1 同一根因（撤销审计行的 app_id 记的不是被撤的 App → 墓碑补到了 (org,'resource-library','mcp')，(org,'mcp-center','mcp') 没有记录 → 登录播种判定「从未提供」→ 复活）。不重复登记缺陷。");
  }

  /* ── R 第一批回归（不改原脚本，只读其结果） ── */
  let orig = null;
  // 第一批产物已改为 runs/<runId>/ 布局：取最近一次 run 的 JSON，根目录历史文件只作兜底（可用 OA_D503_FIRST_BATCH_JSON 指定）
  const firstBatchPick = process.env.OA_D503_FIRST_BATCH_JSON
    ? { file: path.resolve(process.env.OA_D503_FIRST_BATCH_JSON), mtimeMs: 0, legacy: false }
    : RUN_ARTIFACTS.findLatestRunArtifact(ROOT, "mcp-center-e2e");
  const origPath = firstBatchPick ? firstBatchPick.file : path.join(ART, "mcp-center-e2e.json");
  const origRel = path.relative(ROOT, origPath).split(path.sep).join("/");
  try { orig = JSON.parse(fs.readFileSync(origPath, "utf8")); } catch { orig = null; }
  const origCounts = orig && orig.counts ? orig.counts : null;
  const origFails = orig ? (orig.checks || []).filter((c) => c.status === "FAIL") : [];
  record("R1", "第一批回归（本批 HEAD 上重跑；H2 已按 D5-03 第二批新契约更新，其余 37 条一字未动）38 条全绿",
    !!origCounts && origCounts.fail === 0 && origCounts.total === 38,
    "38/38 PASS",
    JSON.stringify({ counts: origCounts, testedCommit: orig ? orig.openarcCommit : null, failedChecks: origFails.map((c) => c.section + "·" + c.name), scriptSha256: fileSha("experiments/d5-03/mcp-center-e2e.mjs"), firstBatchArtifactPath: origRel }));

  const STALE_EXPECTATION = ["H2", "L3"];
  const CASCADE = ["K1", "K2", "K3", "K4", "L2", "L4"];
  const EXPLAINABLE = [...STALE_EXPECTATION, ...CASCADE];
  record("R2", "原脚本失败项的分类：全部 ⊆ {H2/L3 —— 旧断言写死了 v21 之前的「重新登录会把撤销的授权种回来」；K1–K4/L2/L4 —— H2 的下游（H2 一旦不恢复：列表为空 → 动效采样无行可抓；没有 mcp grant 可第二次撤销 → NO_MCP_GRANT；没有连接可清空 → 深色空态不出现）}，没有一项是本批新引入的行为回归",
    origFails.length === 0 || origFails.every((c) => EXPLAINABLE.includes(c.section)),
    "失败项 ⊆ " + JSON.stringify(EXPLAINABLE),
    JSON.stringify({ failed: origFails.map((c) => ({ section: c.section, name: c.name, expected: c.expected, actual: c.actual.slice(0, 400) })), staleExpectation: STALE_EXPECTATION, cascade: CASCADE, notVerifiedInOriginal: orig ? orig.notVerified : null }));

  /* R3 基线重定（第三批）：原基线 d583154 已过期 —— 第三批在 1b78953 为「会话已结束」提示合法改了渲染层。
     新基线 = 第三批开始前的提交 c2e96c1。实测该区间 src/ 的改动**有且只有**白名单那个文件，所以这里是白名单式放行：
     文件级 + 只增不删 + 补丁内容确实带 MCP_SESSION_ENDED；白名单之外的任何 src/ 改动照样判 FAIL（不是"有改动就算过"）。 */
  const R3_BASE_REV = "c2e96c1";
  const R3_ALLOWED_SRC = ["src/mcp/McpCenter.tsx"];
  const gitTextOf = (args) => { try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim(); } catch { return null; } };
  const srcDiffRaw = gitTextOf(["diff", "--name-only", R3_BASE_REV, "HEAD", "--", "src/"]);
  const srcDiff = srcDiffRaw === null ? "git-diff-failed" : srcDiffRaw;
  const srcDiffFiles = srcDiff === "" ? [] : srcDiff.split("\n");
  const srcDiffOutsideWhitelist = srcDiffFiles.filter((f) => !R3_ALLOWED_SRC.includes(f));
  const whitelistNumstat = srcDiffFiles.length ? gitTextOf(["diff", "--numstat", R3_BASE_REV, "HEAD", "--", ...R3_ALLOWED_SRC]) : "";
  const whitelistPatch = srcDiffFiles.length ? gitTextOf(["diff", R3_BASE_REV, "HEAD", "--", ...R3_ALLOWED_SRC]) : "";
  const srcWhitelistAddOnly = srcDiff !== "git-diff-failed" && (!srcDiffFiles.length
    || (!!whitelistNumstat && whitelistNumstat.split("\n").filter(Boolean).every((l) => /^\d+\t0\t/.test(l)) && !!whitelistPatch && whitelistPatch.includes("MCP_SESSION_ENDED")));
  const allDiff = (() => { try { return execFileSync("git", ["-C", ROOT, "diff", "--name-only", R3_BASE_REV, "HEAD"], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } })();
  const kFails = origFails.filter((c) => ["K1", "K2", "K3", "K4", "L2", "L4"].includes(c.section));
  const kCascadePattern = /"rows":0|"leavingFrames":0|"statesSeen":\[null\]|"rowAnim":null|"insertPresentMs":1[0-9]{4}|"reducedInsertMs":1[0-9]{4}|NO_MCP_GRANT|"emptyDarkUp":false/;
  const kAllCascade = kFails.every((c) => kCascadePattern.test(c.actual));
  record("R3", "下游失败可被独立证伪为「产品回归」：本批 " + R3_BASE_REV + "→HEAD 的 diff 里 src/ 改动 ⊆ 白名单 " + JSON.stringify(R3_ALLOWED_SRC) + "（1b78953 的「会话已结束」提示，只增不删），白名单外的 src/ 文件一个都没改，且下游失败的实际值全是「列表空 / 没有行可采样 / 删除即时 / NO_MCP_GRANT」的授权已撤上下文",
    srcDiffOutsideWhitelist.length === 0 && srcWhitelistAddOnly && (kFails.length === 0 || kAllCascade),
    "src/ diff ⊆ 白名单（只增不删，且补丁确实带 MCP_SESSION_ENDED）+ K 段失败实际值全部命中空态上下文",
    JSON.stringify({ baseRev: R3_BASE_REV, allowedSrc: R3_ALLOWED_SRC, srcDiff, srcDiffOutsideWhitelist, whitelistNumstat, srcWhitelistAddOnly, changedOutsideSrc: allDiff, kFailures: kFails.map((c) => ({ section: c.section, actual: c.actual.slice(0, 260) })), kAllCascade }));

  /* ── Z 收尾 ── */
  const ENV_NOISE = /ExperimentalWarning|SQLite is an experimental|SetApplicationIsDaemon|NSOSStatusErrorDomain|IMKCFRunLoopWakeUpReliable|In-process GPU|ERR_BLOCKED_BY_CSP/;
  const appStderrs = apps.map((a) => ({ label: a.label, pid: a.pid, errors: a.stderr.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !ENV_NOISE.test(l)).slice(0, 4) }));
  record("Z1", "全部 Electron 实例的主进程 stderr 无未处理错误", appStderrs.every((a) => a.errors.length === 0), "无错误行", JSON.stringify(appStderrs));
  note("渲染层控制台错误样本：" + JSON.stringify(consoleErrors.filter((l) => !ENV_NOISE.test(l)).slice(0, 6)));
  note("对话框样本：" + JSON.stringify(dialogs.slice(0, 5)));

  const scriptSha = fileSha("experiments/d5-03/mcp-policy-e2e.mjs");
  const testedCommit = process.env.OPENARC_TESTED_COMMIT || (() => { try { return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
  /* 被测相关文件全集（electron/mcp-*.cjs + 授权/治理/身份/执行器 + 渲染层 + fixture + 两个验收脚本），逐文件标 missing/modified。 */
  const sourceFingerprint = RUN_ARTIFACTS.collectSourceFingerprint(ROOT, RUN_ARTIFACTS.d503SourceFiles(ROOT));
  const out = {
    phase: "D5-03 第二批",
    title: "授权收口（撤权持久化 / 正式重授 / 部分授权 / 拒绝路径 / v20→v21 升级）真机验收",
    runId: RUN.runId,
    runDir: RUN.runDirRel,
    startedAt: RUN.startedAt,
    testedCommit,
    relation: {
      this: "experiments/d5-03/mcp-policy-e2e.mjs（第二批新增，N 条）",
      regression: "experiments/d5-03/mcp-center-e2e.mjs（第一批，38 条；第二批按其新契约只更新 H2 一条期望，其余判定未动；sha256=" + firstScriptSha.originalBefore + "）",
      total: { first: origCounts ? origCounts.total : 38, second: CHECKS.length, combined: (origCounts ? origCounts.total : 38) + CHECKS.length },
      note: "两个脚本各自启动真实 Electron（各自 run 目录 artifacts/d5-03/runs/<runId>/、独立 userData 前缀 oa-d503-* / oa-d503b-*、从环境变量基址递增探测的空闲 CDP 端口），互不共享状态；本文件不修改原脚本的判定。",
    },
    openarcCommit: testedCommit,
    openarcBranch: (() => { try { return execFileSync("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })(),
    gitDirtyLines: (() => { try { return execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean).length; } catch { return null; } })(),
    command: "node experiments/d5-03/mcp-policy-e2e.mjs",
    scriptSha256: scriptSha,
    fingerprints: Object.fromEntries(Object.entries(sourceFingerprint.files).map(([f, v]) => [f, v.sha256_16])),
    sourceFingerprint,
    sourceFingerprintSetSha256: sourceFingerprint.setSha256,
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version, cdpPort: apps[0] ? apps[0].cdpPort : null, cdpPorts: apps.map((a) => a.cdpPort), cdpPortProbes: RUN.portProbes, userDataPrefix: USERDATA_PREFIX, runId: RUN.runId, runDir: RUN.runDirRel },
    fixture: { path: "tests/fixtures/mcp/echo-server.mjs", url: fxUrl, tools: FIXTURE_EXPECTED.tools.map((t) => t.name), toolsHash: FIXTURE_EXPECTED.toolsHash },
    restarts: apps.map((a) => ({ label: a.label, pid: a.pid, cdpPort: a.cdpPort, userData: path.basename(a.userDataDir), instance: a.instance })),
    orgIds: { first: state.orgId, fresh: state.freshOrgId },
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, productDefects: DEFECTS,
    dbEvidence: DB_EVIDENCE,
    firstBatch: orig ? { artifactPath: origRel, counts: origCounts, failedChecks: origFails.map((c) => ({ section: c.section, name: c.name, expected: c.expected, actual: c.actual.slice(0, 400) })), notVerified: orig.notVerified, scriptSha256: firstScriptSha.originalBefore } : null,
    boundary: {
      thirdPartyServices: false, userDataSent: false, arbitraryLocalPrograms: false, pluginIsolationClaimed: false,
      databaseWritesByProbe: false, writesOnlyByProduct: true,
      note: "只连自建 fixture（127.0.0.1 动态端口 HTTP）；验收路径对数据库**只读**（DatabaseSync readOnly），所有写入都由产品自己的命令路径完成；没有运行任何任意第三方本地程序；没有发送用户数据；连接成功不等于插件隔离通过（D5-04 范围）。",
    },
    at: new Date().toISOString(),
  };
  OUT = out;
  out.exitCode = failed === 0 ? 0 : 1;
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length, firstBatch: origCounts, combined: (origCounts ? origCounts.total : 38) + CHECKS.length }));
  return failed === 0 ? 0 : 1;
}

/* ══════════════════════════ 收尾（只清理本次运行自己 spawn 的进程 / 目录） ══════════════════════════ */
let exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("验收异常：" + String((e && e.stack) || e));
  record("Z0", "验收脚本无未捕获异常", false, "无异常", String((e && e.message) || e));
  exitCode = 2;
}
const cleanup = await cleanupOwnProcesses();
console.log("收尾：只清理本次运行 spawn 的 pid 树（" + JSON.stringify(cleanup.targets.map((t) => ({ label: t.label, rootPid: t.rootPid, leftovers: t.leftovers }))) + "），未使用 pkill");
cleanup.userDataDirsRemoved = [];
for (const dir of [runDir, freshDir, upgradeDir]) { try { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); cleanup.userDataDirsRemoved.push(path.basename(dir)); } } catch { /* ignore */ } }
if (RUN) {
  try {
    const fallback = {
      phase: "D5-03 第二批",
      title: "授权收口（撤权持久化 / 正式重授 / 部分授权 / 拒绝路径 / v20→v21 升级）真机验收",
      aborted: true,
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
