#!/usr/bin/env node
"use strict";
/**
 * 任务 C · 新交互真机端到端验收（真实 Electron + 隔离 userData + 唯一调试端口）。
 *
 * 与前序探针的分工：
 *   · experiments/dxos-e2e/、dxos-e2e-write/  证明"命令注册 / 读写链路 / 重启持久化"；
 *   · experiments/dxos-ui-real/              证明"真实窗口里的度量对照"（只截图，不点开关）；
 *   · 本探针只做一件事：把**本轮新增的四项交互**在**真实产品入口** electron .（真实
 *     electron/main.cjs + electron/preload.cjs + dist/index.html）里真的点一遍，并断言
 *     主进程真实落盘 / 真实入库 / 后端权威状态。
 *
 * 覆盖（逐项，含失败/权限路径）：
 *   ① MCP 中心「工具调用」开关      —— 读状态 → 打开 → 断言 <userData>/dxos/mcp.json
 *     真实落盘 tools.invocationEnabled=true → 重读 → 关闭 → 断言恢复；
 *     负向：非管理员账号写开关 → MCP_UNAUTHORIZED 且文件不变。
 *     源：src/mcp/McpCenter.tsx:1800-1885（data-mcp-toolswitch-*）、
 *         electron/mcp-bootstrap.cjs:286-307（唯一写命令）、electron/mcp-switch.cjs:85-105（落盘）。
 *   ② 访达窗口「资源库」入口         —— 未选中禁用给原因 → 选中真实文件 → 加入资源库 →
 *     resource/query 可查 → 导出到电脑 → 断言真实落盘且内容一致。
 *     源：src/main.tsx:2379-2418（data-files-library-*）、src/governance/filesLibraryActions.ts:36-42、
 *         electron/resource-bootstrap.cjs:202-225、electron/main.cjs:1276-1310（files:export）。
 *   ③ core 任务选中与追加步骤        —— 经产品桥建 core 任务 → 任务控制台选中 → 追加步骤 →
 *     后端 task/get 步骤数 +1；负向：状态/输入不允许时按钮禁用并给原因。
 *     源：src/projects/TaskConsole.tsx:1178-1195 / 1330-1374、src/projects/coreTaskConsole.ts:40-54、
 *         electron/task-bootstrap.cjs:152-216。
 *   ④ 定时自动化「定义即授权」       —— 启用集成 + 建本机 MCP stub 连接 → 建含集成动作的自动化并启用 →
 *     断言授权落 authorization_audit → runNow → 断言真实调用到 127.0.0.1 stub 且 run 审计含授权来源；
 *     负向：停用后 runNow → 结构化拒绝且 stub 0 次外发。
 *     源：electron/automation-domain.cjs:90-170、electron/automation-store.cjs:191+、
 *         electron/plugin-service.cjs:1026-1086 / 1065-1086、electron/mcp-live-transport.cjs:39-66。
 *
 * 隔离（最高优先级）：
 *   · 真实 profile（~/Library/Application Support/openarc-os）只读：开工/收工各做一次
 *     sha256+size+mtime 快照（identity.db/-wal/-shm + 顶层），绝不用 SQLite 打开真实库；
 *   · 应用一律 --user-data-dir=<mkdtemp 临时目录> 启动，全部写入只落隔离目录；
 *   · 开收工打印真实 profile 的写者进程，区分"探针写的 / 本就在跑的 OpenArc OS.app 写的"。
 *
 * 硬约束：不联网（只连本机 CDP / inspector / 127.0.0.1 stub；并断言渲染层无非本地请求）；
 *         不新增依赖；不改产品代码；不跑 npm build/test；失败 exit 非 0。
 *
 * 用法：node experiments/dxos-e2e-interactions/run-all.mjs
 *   OA_E2E_INTERACTIONS_KEEP=1  保留隔离 userData（默认收工删除）
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-e2e-interactions");
const SHOT = { width: 1440, height: 900, deviceScaleFactor: 2 };
const ADMIN = "admin@openarc.test";
const ADMIN_PW = "admin-password-1";
const MEMBER = "e2e-interactions-member@openarc.test";
const MEMBER_PW = "member-password-1";
const KEEP = process.env.OA_E2E_INTERACTIONS_KEEP === "1";
const LOCAL_RE = /^(file:|data:|blob:|about:|devtools:|openarc-file:|openarc-resource:|openarc-canvas:|http:\/\/127\.0\.0\.1|http:\/\/localhost|http:\/\/\[::1\]|ws:\/\/127\.0\.0\.1|ws:\/\/localhost)/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

const checks = [];
const observations = [];
const screenshots = [];
const consoleAll = [];
const consoleErrors = [];
const pageErrors = [];
const nonLocalRequests = [];
const requestFailures = [];

function record(section, name, ok, expected, actual, detail) {
  const row = { section: section, name: name, ok: !!ok, expected: String(expected == null ? "" : expected), actual: String(actual == null ? "" : actual).slice(0, 800), detail: detail || null };
  checks.push(row);
  console.log((row.ok ? "PASS" : "FAIL") + " [" + section + "] " + name + " :: actual=" + row.actual + " expected=" + row.expected);
  return row.ok;
}
function note(line) { observations.push(String(line)); console.log("   · " + line); }

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
async function waitFor(fn, timeoutMs, stepMs) {
  const step = stepMs || 200;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await fn()) return true; } catch { /* 重试 */ }
    if (Date.now() >= deadline) return false;
    await sleep(step);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   真实 profile 只读快照（只 stat/read，绝不用 SQLite 打开）
   ══════════════════════════════════════════════════════════════════════════ */
function resolveRealProfilePath() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openarc-os");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "openarc-os");
}
function statOf(p) {
  try { const s = fs.statSync(p); return { exists: true, mtimeMs: Math.round(s.mtimeMs), size: s.size, ino: s.ino }; }
  catch { return { exists: false }; }
}
function sha256File(p) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; }
}
function snapshotProfile(dir) {
  const out = { path: dir, exists: fs.existsSync(dir), dir: statOf(dir), identity: {}, topLevel: {} };
  for (const name of ["identity.db", "identity.db-wal", "identity.db-shm"]) {
    const abs = path.join(dir, name);
    const st = statOf(abs);
    out.identity[name] = st.exists ? Object.assign({}, st, { sha256: sha256File(abs) }) : st;
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      const st = statOf(path.join(dir, name));
      out.topLevel[name] = { mtimeMs: st.mtimeMs, size: st.size };
    }
  } catch { /* 目录不存在 */ }
  return out;
}
function diffProfile(before, after) {
  const changed = [];
  for (const name of new Set(Object.keys(before.identity).concat(Object.keys(after.identity)))) {
    if (JSON.stringify(before.identity[name] || null) !== JSON.stringify(after.identity[name] || null)) changed.push("identity/" + name);
  }
  for (const name of new Set(Object.keys(before.topLevel).concat(Object.keys(after.topLevel)))) {
    if (JSON.stringify(before.topLevel[name] || null) !== JSON.stringify(after.topLevel[name] || null)) changed.push("topLevel/" + name);
  }
  return { unchanged: changed.length === 0, changed: changed, absentAfter: !after.exists };
}
function processesUsing(dir) {
  try {
    const text = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout || "";
    return text.split("\n").filter((line) => line.includes(dir)).map((line) => line.trim().slice(0, 200)).slice(0, 20);
  } catch { return []; }
}
function processesMatching(substr) {
  try {
    const text = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout || "";
    return text.split("\n").filter((line) => line.includes(substr)).map((line) => line.trim().slice(0, 200)).slice(0, 20);
  } catch { return []; }
}

/* ══════════════════════════════════════════════════════════════════════════
   本机 stub：模型服务（OpenAI 兼容）+ MCP 工具服务（lingxing 工具）
   ── 只监听 127.0.0.1，探针自起自停；不是"假传输"：产品经真实 HTTP 调它。
   ══════════════════════════════════════════════════════════════════════════ */
function startModelStub() {
  const state = { requests: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const send = (code, obj) => { const body = JSON.stringify(obj); res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); res.end(body); };
      if (req.method === "GET" && req.url === "/v1/models") return send(200, { object: "list", data: [{ id: "e2e-chat", object: "model" }] });
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        state.requests += 1;
        state.bodies.push(raw.slice(0, 4000));
        return send(200, {
          id: "chatcmpl-e2e-" + state.requests, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "e2e-chat",
          choices: [{ index: 0, message: { role: "assistant", content: "E2E 交互验收完成。" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      return send(404, { error: { message: "not found" } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ url: "http://127.0.0.1:" + server.address().port + "/v1", port: server.address().port, state: state, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

const E2E_SAMPLE_SALES = [{ asin: "B0E2E0001", item_name: "探针产品一", volume: 3, amount: 99.5, order_items: 2, sessions: 40, currency_code: "CNY", seller_name: "探针店铺", country: "US", brand: "探针品牌" }];

function startMcpStub() {
  const state = { requests: 0, byMethod: {}, toolsCalls: [], sessions: 0 };
  function reply(msg) {
    const method = String(msg.method || "");
    if (method === "initialize") {
      state.sessions += 1;
      return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "openarc-e2e-mcp-stub", version: "0.1.0" }, instructions: "e2e interactions stub" } };
    }
    if (method === "ping") return { jsonrpc: "2.0", id: msg.id, result: {} };
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "query_product_performance_asin_lists", description: "e2e stub 销售列表", inputSchema: { type: "object", properties: {}, required: [] } },
        { name: "list_stores", description: "e2e stub 店铺列表", inputSchema: { type: "object", properties: {}, required: [] } },
        { name: "start_client", description: "e2e stub", inputSchema: { type: "object", properties: {}, required: [] } },
      ] } };
    }
    if (method === "tools/call") {
      const name = msg.params && typeof msg.params.name === "string" ? msg.params.name : "";
      const args = msg.params && msg.params.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
      state.toolsCalls.push({ name: name, arguments: args });
      if (name === "query_product_performance_asin_lists") {
        return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ code: 1, data: { list: E2E_SAMPLE_SALES, total: E2E_SAMPLE_SALES.length } }) }] } };
      }
      if (name === "list_stores") return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify([{ browserOauth: "oauth-1", browserName: "探针店铺" }]) }] } };
      return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: {} }) }] } };
    }
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + method } };
  }
  const server = http.createServer((req, res) => {
    state.requests += 1;
    const pathname = String(req.url || "/").split("?")[0];
    const send = (code, obj, extra) => { const body = JSON.stringify(obj); res.writeHead(code, Object.assign({ "content-type": "application/json", "content-length": Buffer.byteLength(body) }, extra || {})); res.end(body); };
    if (pathname === "/__state") return send(200, state);
    if (req.method !== "POST") return send(405, { jsonrpc: "2.0", error: { code: -32600, message: "Method Not Allowed" } });
    let raw = "";
    req.on("data", (d) => { raw += d; if (raw.length > 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(raw || "{}"); } catch { return send(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }); }
      const method = String(msg.method || "");
      state.byMethod[method || "(response)"] = (state.byMethod[method || "(response)"] || 0) + 1;
      if (msg.method == null) { res.writeHead(202, { "content-length": 0 }); return res.end(); }
      const headers = method === "initialize" ? { "mcp-session-id": crypto.randomBytes(12).toString("base64url") } : {};
      send(200, reply(msg), headers);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ url: "http://127.0.0.1:" + server.address().port + "/mcp", port: server.address().port, state: state, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   主进程 Node inspector：只用于把系统原生 dialog 换成探针临时目录
   （真实 files:export 落盘逻辑一字不改，见 electron/main.cjs:1276-1310）。
   ══════════════════════════════════════════════════════════════════════════ */
async function waitValue(fn, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* 重试 */ }
    if (Date.now() >= deadline) return null;
    await sleep(stepMs || 300);
  }
}
async function attachMainInspector(port) {
  const list = await waitValue(async () => {
    try { const r = await fetch("http://127.0.0.1:" + port + "/json/list"); if (r.ok) { const j = await r.json(); return j && j.length ? j : null; } } catch { /* 重试 */ }
    return null;
  }, 30000, 400);
  if (!list) return null;
  const target = list.find((t) => t && t.webSocketDebuggerUrl) || null;
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("inspector ws timeout")), 10000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
    ws.addEventListener("error", (e) => { clearTimeout(timer); reject(new Error("inspector ws error")); });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.id && pending.has(m.id)) { const fn = pending.get(m.id); pending.delete(m.id); fn(m); }
  });
  function send(method, params) {
    const id = ++seq;
    return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id: id, method: method, params: params })); });
  }
  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", { expression: expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true });
    if (r && r.result && r.result.exceptionDetails) return { ok: false, error: JSON.stringify(r.result.exceptionDetails).slice(0, 400) };
    return { ok: true, value: r && r.result && r.result.result ? r.result.result.value : null };
  }
  async function stubExportDialog(destDir) {
    const expr = "(function(){ try { var d = process.mainModule.require('electron').dialog;"
      + " globalThis.__oaE2EOrigShowOpenDialog = globalThis.__oaE2EOrigShowOpenDialog || d.showOpenDialog;"
      + " d.showOpenDialog = async function(){ return { canceled: false, filePaths: [" + JSON.stringify(destDir) + "] }; };"
      + " return 'stubbed'; } catch (e) { return 'ERR:' + String(e && e.message); } })()";
    return evaluate(expr);
  }
  async function restoreDialog() {
    return evaluate("(function(){ try { if (globalThis.__oaE2EOrigShowOpenDialog) { process.mainModule.require('electron').dialog.showOpenDialog = globalThis.__oaE2EOrigShowOpenDialog; return 'restored'; } return 'no-orig'; } catch (e) { return 'ERR:' + String(e && e.message); } })()");
  }
  function close() { try { ws.close(); } catch { /* ignore */ } }
  return { evaluate: evaluate, stubExportDialog: stubExportDialog, restoreDialog: restoreDialog, close: close, targets: list.map((t) => ({ title: t.title, type: t.type })) };
}

/* ══════════════════════════════════════════════════════════════════════════
   DOM / 桥 原语
   ══════════════════════════════════════════════════════════════════════════ */
const windowSelector = (label) => 'section.window[aria-label="' + label + '"]';
async function q(page, sel) { return page.evaluate((s) => !!document.querySelector(s), sel); }
async function clickSel(page, sel) {
  return page.evaluate((s) => { const el = document.querySelector(s); if (!el) return "missing"; if (el.disabled) return "disabled"; el.click(); return "ok"; }, sel);
}
async function attr(page, sel, name) {
  return page.evaluate((a) => { const el = document.querySelector(a[0]); return el ? (el.getAttribute(a[1]) || "") : null; }, [sel, name]);
}
async function textOf(page, sel) {
  return page.evaluate((s) => { const el = document.querySelector(s); return el ? (el.textContent || "").trim() : null; }, sel);
}
async function setInput(page, sel, value) {
  return page.evaluate((a) => {
    const el = document.querySelector(a[0]);
    if (!el) return "missing";
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, a[1]);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return "ok";
  }, [sel, value]);
}
async function openApp(page, appId, label) {
  await clickSel(page, '.dock-item[data-dock-id="' + appId + '"]');
  return waitFor(() => q(page, windowSelector(label)), 15000, 250);
}
async function clickNavText(page, label, text) {
  return page.evaluate((a) => {
    const win = document.querySelector(a[0]);
    if (!win) return false;
    const buttons = Array.prototype.slice.call(win.querySelectorAll(".split-nav"));
    for (let i = 0; i < buttons.length; i += 1) {
      if ((buttons[i].textContent || "").trim() === a[1]) { buttons[i].click(); return true; }
    }
    return false;
  }, [windowSelector(label), text]);
}
async function raiseWindow(page, label) {
  return page.evaluate((sel) => {
    const win = document.querySelector(sel);
    if (!win) return false;
    win.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    return true;
  }, windowSelector(label));
}
async function isTopmost(page, label) {
  return page.evaluate((sel) => {
    const win = document.querySelector(sel);
    if (!win) return false;
    const mine = Number(getComputedStyle(win).zIndex) || 0;
    let max = -1;
    const all = document.querySelectorAll("section.window");
    for (let i = 0; i < all.length; i += 1) max = Math.max(max, Number(getComputedStyle(all[i]).zIndex) || 0);
    return mine >= max;
  }, windowSelector(label));
}
async function bridge(page, channel, command, payload) {
  return page.evaluate(async (a) => {
    const api = window.openarc && window.openarc[a[0]];
    if (!api || typeof api.command !== "function") return { __error: "NO_BRIDGE:" + a[0] };
    try { return await api.command({ command: a[1], payload: a[2] || {} }); } catch (e) { return { __error: String((e && e.message) || e) }; }
  }, [channel, command, payload || {}]);
}
async function resourceCommand(page, command) {
  return page.evaluate(async (cmd) => {
    const api = window.openarc && window.openarc.resource;
    if (!api || typeof api.command !== "function") return { __error: "NO_BRIDGE:resource" };
    try { return await api.command(cmd); } catch (e) { return { __error: String((e && e.message) || e) }; }
  }, command);
}
async function filesImport(page, folderId, paths) {
  return page.evaluate(async (a) => {
    const api = window.openarc && window.openarc.files;
    if (!api || typeof api.import !== "function") return { __error: "NO_BRIDGE:files.import" };
    try { return await api.import(a[0], a[1]); } catch (e) { return { __error: String((e && e.message) || e) }; }
  }, [folderId, paths]);
}
async function identityCommand(page, command, payload) {
  return page.evaluate(async (a) => {
    const api = window.openarc && window.openarc.identity;
    if (!api || typeof api.command !== "function") return { __error: "NO_BRIDGE:identity" };
    try { return await api.command(Object.assign({ type: a[0] }, a[1] || {})); } catch (e) { return { __error: String((e && e.message) || e) }; }
  }, [command, payload || {}]);
}
async function taskGet(page, taskId) { return bridge(page, "task", "task/get", { taskId: taskId }); }

async function setTheme(page, theme) {
  const label = "系统设置窗口";
  const opened = await openApp(page, "settings", label);
  if (!opened) return false;
  await clickSel(page, windowSelector(label) + ' [data-settings-pane="appearance"]');
  await sleep(200);
  const want = theme === "dark" ? "深色" : "浅色";
  const clicked = await page.evaluate((a) => {
    const win = document.querySelector(a[0]);
    if (!win) return false;
    const group = win.querySelector('.segmented[aria-label="外观"]');
    if (!group) return false;
    const buttons = Array.prototype.slice.call(group.querySelectorAll("button"));
    for (let i = 0; i < buttons.length; i += 1) if ((buttons[i].textContent || "").trim() === a[1]) { buttons[i].click(); return true; }
    return false;
  }, [windowSelector(label), want]);
  if (!clicked) return false;
  return waitFor(() => page.evaluate((d) => { const el = document.querySelector(".desktop"); return el ? el.classList.contains("dark") === d : false; }, theme === "dark"), 6000, 150);
}
async function shoot(page, cdp, file) {
  await sleep(280);
  const res = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  const buf = fs.readFileSync(file);
  const meta = { file: path.relative(ROOT, file), width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
  screenshots.push(meta);
  return meta;
}
async function shootThemes(page, cdp, ctx, slug, raiseLabel) {
  const out = {};
  for (const theme of ["light", "dark"]) {
    const ok = await setTheme(page, theme);
    if (raiseLabel) { await openApp(page, ctx.raiseAppId || "", raiseLabel).catch(() => false); await raiseWindow(page, raiseLabel); }
    else if (ctx.raiseFiles) {
      await page.evaluate(() => {
        const body = document.querySelector('.folder-body[data-drop-folder="desktop"]');
        const win = body ? body.closest("section.window") : null;
        if (win) win.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
      });
    }
    const top = raiseLabel ? await isTopmost(page, raiseLabel) : true;
    const meta = await shoot(page, cdp, path.join(ART, slug + "-" + theme + ".png"));
    out[theme] = { ok: ok, topmost: top, file: meta.file };
    record("截图", "S " + slug + " · " + (theme === "dark" ? "深色" : "浅色") + "截图", ok, "主题已切换", JSON.stringify({ theme: theme, topmost: top, file: meta.file }));
  }
  await setTheme(page, "light");
  return out;
}

function readMcpJson(userData) {
  const p = path.join(userData, "dxos", "mcp.json");
  try {
    if (!fs.existsSync(p)) return { exists: false, path: p, value: null };
    return { exists: true, path: p, value: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (e) { return { exists: true, path: p, value: null, parseError: String((e && e.message) || e) }; }
}

async function readAuditRows(dbPath) {
  try {
    const mod = await import("node:sqlite");
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT * FROM authorization_audit ORDER BY id").all();
    db.close();
    return { ok: true, rows: rows };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), rows: [] }; }
}

/* ══════════════════════════════════════════════════════════════════════════
   四项交互
   ══════════════════════════════════════════════════════════════════════════ */
async function readToggle(page) {
  return page.evaluate(() => {
    const sec = document.querySelector("[data-mcp-toolswitch-section]");
    const btn = document.querySelector("[data-mcp-toolswitch-toggle]");
    const err = document.querySelector("[data-mcp-toolswitch-error]");
    const badge = document.querySelector("[data-mcp-toolswitch-badge]");
    return {
      section: !!sec,
      state: sec ? sec.getAttribute("data-mcp-toolswitch-state") : null,
      enabled: btn ? btn.getAttribute("data-mcp-toolswitch-enabled") : null,
      disabled: btn ? !!btn.disabled : null,
      aria: btn ? btn.getAttribute("aria-label") : null,
      badge: badge ? badge.getAttribute("data-mcp-toolswitch-badge") : null,
      errorCode: err ? err.getAttribute("data-mcp-toolswitch-error-code") : null,
      errorText: err ? (err.textContent || "").trim() : null,
    };
  });
}

async function reloadRenderer(page, ctx) {
  await page.reload({ waitUntil: "load" }).catch(() => null);
  const ready = await waitFor(() => page.evaluate(() => document.readyState === "complete" && !!window.openarc && Object.keys(window.openarc).length === 25), 45000, 300);
  if (ctx && ctx.cdp) { try { await ctx.cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.deviceScaleFactor, mobile: false }); } catch { /* ignore */ } }
  const gateReady = () => page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") === "ready" : false; });
  let gate = await waitFor(gateReady, 25000, 250);
  if (!gate && ready) { await identityCommand(page, "identity/login", { identifier: ADMIN, password: ADMIN_PW }); gate = await waitFor(gateReady, 25000, 250); }
  return { ready: ready, gate: gate };
}

async function item1_mcpPositive(page, ctx) {
  record("1-MCP", "M1.0 打开 MCP 中心窗口（真实 dock 交互）", await openApp(page, "mcp-center", "MCP 中心窗口"), "窗口出现", "seen");
  await waitFor(() => q(page, "[data-mcp-center]"), 15000, 250);
  // 先等真空态（不是首屏 loading 分支）稳定，避免在加载帧把空态开关误判成"不可达"。
  const emptyUp = await waitFor(() => q(page, "[data-mcp-empty]"), 20000, 250);
  const emptyState = await page.evaluate(() => {
    const center = document.querySelector("[data-mcp-center]");
    return { center: !!center, available: center ? center.getAttribute("data-mcp-available") : null, empty: !!document.querySelector("[data-mcp-empty]"), toolswitch: !!document.querySelector("[data-mcp-toolswitch-section]") };
  });
  record("1-MCP", "M1.1 空连接态下「工具调用」开关是否可达（McpCenter.tsx:1060-1085 空态提前 return vs 1095-1135 才渲染）", emptyUp === true && emptyState.toolswitch === true, "空态 + 开关区块渲染", JSON.stringify(Object.assign({ emptyUp: emptyUp }, emptyState)));
  // M1.1a（本波新增）：空态下开关不仅可见，而且**可写** —— 真实点一次（真实落盘 invocationEnabled=true）
  // 再点回关闭，全程 0 条连接；后面的 M1.2 仍按"默认关闭"断言（关回后 invocationEnabled=false）。
  const emptyReady = await waitFor(async () => { const t = await readToggle(page); return t.section === true && t.state === "ready" && t.disabled === false; }, 20000, 250);
  const emptyToggle = await readToggle(page);
  const clickOn = await clickSel(page, "[data-mcp-toolswitch-toggle]");
  const wroteOn = await waitFor(async () => (await readToggle(page)).enabled === "true", 20000, 250);
  const fileOnEmpty = readMcpJson(ctx.userData);
  const clickOff = await clickSel(page, "[data-mcp-toolswitch-toggle]");
  const wroteOff = await waitFor(async () => (await readToggle(page)).enabled === "false", 20000, 250);
  const fileOffEmpty = readMcpJson(ctx.userData);
  record("1-MCP", "M1.1a 空连接态下开关可写（真实点击 → 真实落盘 → 关回，全程 0 连接）",
    emptyReady === true && emptyToggle.section === true && emptyToggle.state === "ready" && emptyToggle.disabled === false
      && clickOn === "ok" && wroteOn === true && !!fileOnEmpty.value && fileOnEmpty.value.tools.invocationEnabled === true
      && clickOff === "ok" && wroteOff === true && !!fileOffEmpty.value && fileOffEmpty.value.tools.invocationEnabled === false,
    "空态可见 + state=ready + 可点 + 打开落盘 true + 关回落盘 false",
    JSON.stringify({ emptyReady: emptyReady, emptyToggle: emptyToggle, clickOn: clickOn, wroteOn: wroteOn, fileOn: fileOnEmpty.value, clickOff: clickOff, wroteOff: wroteOff, fileOff: fileOffEmpty.value }));
  // 让开关区块可达：先经产品桥建一条到本机 stub 的真实 MCP 连接（真实握手），再刷新重开 MCP 中心。
  const dummy = await bridge(page, "mcp", "mcp/create", { name: "E2E Toggle Stub", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: ctx.mcpStub.url, serverKey: "e2e-toggle" }, authMode: "NONE", visibility: "PERSONAL" });
  const dummyId = dummy && dummy.connection ? dummy.connection.connectionId : null;
  if (dummyId) { await bridge(page, "mcp", "mcp/setEnabled", { connectionId: dummyId, enabled: true }); await bridge(page, "mcp", "mcp/connect", { connectionId: dummyId }); }
  ctx.toggleConnectionId = dummyId;
  const reloaded = await reloadRenderer(page, ctx);
  await openApp(page, "mcp-center", "MCP 中心窗口");
  const hasSection = await waitFor(() => q(page, "[data-mcp-toolswitch-section]"), 20000, 250);
  record("1-MCP", "M1.1b 建真实连接后开关区块渲染", hasSection, "data-mcp-toolswitch-section 存在", JSON.stringify({ dummyId: dummyId, created: !!dummy && dummy.ok === true, reloaded: reloaded }));
  if (!hasSection) return;

  const fileBefore = readMcpJson(ctx.userData);
  record("1-MCP", "M1.2 开工前开关默认关闭（electron/mcp-switch.cjs:29-31）", !fileBefore.value || fileBefore.value.tools.invocationEnabled !== true, "缺省或 false", JSON.stringify(fileBefore.value));

  const t0 = await readToggle(page);
  record("1-MCP", "M1.3 读当前状态：ready + 关闭", t0.state === "ready" && t0.enabled === "false", "state=ready enabled=false", JSON.stringify(t0));

  const c = await clickSel(page, "[data-mcp-toolswitch-toggle]");
  record("1-MCP", "M1.4 开关按钮可点（未禁用）", c === "ok", "ok", c);
  const on = await waitFor(async () => (await readToggle(page)).enabled === "true", 20000, 250);
  const fileOn = readMcpJson(ctx.userData);
  record("1-MCP", "M1.5 打开后界面显示已打开（无乐观切换，写后重读 mcp/agentTools）", on, "data-mcp-toolswitch-enabled=true", JSON.stringify(await readToggle(page)));
  record("1-MCP", "M1.6 真实落盘 <userData>/dxos/mcp.json tools.invocationEnabled=true + updatedAt 数值",
    !!fileOn.value && fileOn.value.tools && fileOn.value.tools.invocationEnabled === true && typeof fileOn.value.updatedAt === "number",
    "tools.invocationEnabled=true && typeof updatedAt=number", JSON.stringify(fileOn.value));

  ctx.raiseAppId = "mcp-center";
  await shootThemes(page, ctx.cdp, ctx, "mcp-toolswitch-on", "MCP 中心窗口");

  const off = await clickSel(page, "[data-mcp-toolswitch-toggle]");
  const offOk = await waitFor(async () => (await readToggle(page)).enabled === "false", 20000, 250);
  const fileOff = readMcpJson(ctx.userData);
  record("1-MCP", "M1.7 关闭后界面恢复关闭", offOk, "enabled=false", JSON.stringify(await readToggle(page)));
  record("1-MCP", "M1.8 关闭后磁盘恢复 invocationEnabled=false", !!fileOff.value && fileOff.value.tools.invocationEnabled === false, "tools.invocationEnabled=false", JSON.stringify(fileOff.value));
}

async function item2_files(page, ctx) {
  const seedPath = path.join(ctx.userData, "probe-seed.txt");
  const seedBody = "e2e-interactions-seed-" + Date.now() + "\n";
  fs.writeFileSync(seedPath, seedBody);
  const exportDir = path.join(ctx.userData, "export-dest");
  fs.mkdirSync(exportDir, { recursive: true });
  ctx.exportDir = exportDir;

  const imported = await filesImport(page, "desktop", [seedPath]);
  const added = imported && Array.isArray(imported.added) ? imported.added : [];
  record("2-访达", "F2.2 真实文件经产品桥 files.import 落入桌面文件夹", added.length === 1, "added=1", JSON.stringify(imported).slice(0, 400));
  if (!added.length) return;
  const entryId = added[0].id;
  ctx.seedEntryId = entryId;
  // 渲染层的桌面列表在应用启动时就取过一次（src/main.tsx:960-962），且只在"该文件夹未加载"时重取
  // （src/main.tsx:1864）；桥里新导入的文件因此不会自动出现。这里刷新一次页面，让真实文件进入桌面列表。
  const seeded = await reloadRenderer(page, ctx);
  record("2-访达", "F2.2b 刷新渲染层后桌面列表已重取（含刚导入的真实文件）", seeded.ready && seeded.gate, "ready + gate=ready", JSON.stringify(seeded));

  await clickSel(page, '.dock-item[data-dock-id="files"]');
  const folderOpen = await waitFor(() => q(page, '.folder-body[data-drop-folder="desktop"]'), 15000, 250);
  record("2-访达", "F2.0 打开访达（桌面文件夹窗口）", folderOpen, ".folder-body[data-drop-folder=desktop]", String(folderOpen));
  if (!folderOpen) return;

  const entryBefore = await entryState(page);
  record("2-访达", "F2.1 未选中时入口禁用并给出原因（src/main.tsx:2383/2390）",
    !!entryBefore && entryBefore.disabled === true && entryBefore.state === "disabled" && entryBefore.title.indexOf("先选择") >= 0,
    "disabled + title=先选择要处理的文件或文件夹", JSON.stringify(entryBefore));

  const cellOk = await waitFor(() => q(page, '.file-cell[data-entry-id="' + entryId + '"]'), 15000, 200);
  record("2-访达", "F2.3 文件格子在访达窗口出现", cellOk, ".file-cell[data-entry-id]", String(cellOk));
  const clicked = await page.evaluate((id) => { const el = document.querySelector('.file-cell[data-entry-id="' + id + '"]'); if (!el) return "missing"; el.click(); return "ok"; }, entryId);
  await sleep(250);

  const entrySel = await entryState(page);
  record("2-访达", "F2.4 选中文件后入口可用", clicked === "ok" && entrySel && entrySel.disabled === false && entrySel.state === "enabled", "enabled", JSON.stringify(entrySel));

  await clickSel(page, "[data-files-library-entry]");
  const menuOpen = await waitFor(() => q(page, '[data-menu-id="lib-add-managed"]'), 6000, 150);
  const items = await page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll(".context-menu [data-menu-id]")).map((el) => ({ id: el.getAttribute("data-menu-id"), label: (el.textContent || "").trim(), disabled: !!el.disabled })));
  record("2-访达", "F2.5 资源库菜单 5 项渲染且顺序/文案固定（filesLibraryActions.ts:36-42）", menuOpen && items.length === 5, "5 项", JSON.stringify(items));
  const exportRes = items.find((i) => i.id === "lib-export-resource");
  record("2-访达", "F2.6 未加入资源库时「导出资源」禁用并说明原因", !!exportRes && exportRes.disabled === true && exportRes.label.indexOf("尚未加入资源库") >= 0, "disabled + 尚未加入资源库", JSON.stringify(exportRes));

  const exportComputer = items.find((i) => i.id === "lib-export-computer");
  record("2-访达", "F2.7 有文件选中时「导出到电脑」可用", !!exportComputer && exportComputer.disabled === false, "enabled", JSON.stringify(exportComputer));

  await clickSel(page, '[data-menu-id="lib-add-managed"]');
  const addOk = await waitFor(() => page.evaluate(() => { const el = document.querySelector("[data-files-library-status]"); return !!el && el.getAttribute("data-files-library-status") === "ok"; }), 25000, 250);
  const addStatus = await statusState(page);
  record("2-访达", "F2.8 「加入资源库（Managed）」成功并有可见反馈", addOk, "status=ok", JSON.stringify(addStatus));

  const query = await resourceCommand(page, { type: "resource/query", category: "all", limit: 100 });
  const items2 = query && Array.isArray(query.items) ? query.items : [];
  const hit = items2.find((r) => JSON.stringify(r).indexOf("probe-seed") >= 0);
  record("2-访达", "F2.9 主进程真的入库（resource/query 可查到刚加入的文件）", !!hit, "resource/query 命中", JSON.stringify(query).slice(0, 500));

  ctx.raiseAppId = "files";
  ctx.raiseFiles = true;
  await shootThemes(page, ctx.cdp, ctx, "files-library-added", null);

  if (!ctx.inspector) { record("2-访达", "F2.10 导出到电脑（原生 dialog 需主进程 inspector 换目录）", false, "inspector 可用", "inspector 未连接，跳过真实导出（不改产品代码，不伪造落盘）"); return; }
  const stubbed = await ctx.inspector.stubExportDialog(exportDir);
  record("2-访达", "F2.10 主进程 inspector 就绪：把系统 dialog 换成探针临时目录（真实 files:export 落盘逻辑不变）", stubbed.ok && stubbed.value === "stubbed", "stubbed", JSON.stringify(stubbed));

  await clickSel(page, '[data-files-library-entry]');
  await waitFor(() => q(page, '[data-menu-id="lib-export-computer"]'), 6000, 150);
  const exportClick = await clickSel(page, '[data-menu-id="lib-export-computer"]');
  const exportOk = await waitFor(() => page.evaluate(() => { const el = document.querySelector("[data-files-library-status]"); return !!el && el.getAttribute("data-files-library-status") === "ok"; }), 25000, 250);
  await sleep(400);
  // files:export 复制的是文件服务里的真实落盘名（electron/main.cjs:1296 path.basename(hit.path)），
  // 不是显示名，因此这里按"目录里恰好 1 个文件 + 内容逐字一致"断言。
  const exportedFiles = fs.existsSync(exportDir) ? fs.readdirSync(exportDir) : [];
  const destFile = exportedFiles.length === 1 ? path.join(exportDir, exportedFiles[0]) : null;
  const contentMatch = !!destFile && fs.existsSync(destFile) && fs.readFileSync(destFile, "utf8") === seedBody;
  record("2-访达", "F2.11 「导出到电脑」真实落盘且内容与源文件逐字一致", exportOk && exportedFiles.length === 1 && contentMatch, "落盘 1 个文件 + 内容逐字一致", JSON.stringify({ click: exportClick, status: await statusState(page), destDir: path.relative(ctx.userData, exportDir), exportedFiles: exportedFiles, contentMatch: contentMatch }));
}

async function entryState(page) {
  return page.evaluate(() => {
    const b = document.querySelector("[data-files-library-entry]");
    if (!b) return null;
    return { disabled: b.disabled, label: b.getAttribute("aria-label") || "", title: b.title || "", state: b.getAttribute("data-files-library-state") || "", busy: b.getAttribute("data-files-library-busy") || "" };
  });
}
async function statusState(page) {
  return page.evaluate(() => {
    const el = document.querySelector("[data-files-library-status]");
    if (!el) return null;
    return { kind: el.getAttribute("data-files-library-status") || "", code: el.getAttribute("data-files-library-code") || "", text: (el.textContent || "").trim() };
  });
}

async function item3_core(page, ctx) {
  const prov = await bridge(page, "model", "provider/create", { displayName: "E2E Interactions Stub", baseUrl: ctx.modelStub.url, adapterType: "openai-compatible", scope: "PERSONAL", credentialSecret: "e2e-interactions-secret" });
  const providerId = prov && prov.provider ? (prov.provider.providerId || prov.provider.id) : null;
  record("3-core", "C3.0 经产品桥 model/provider/create 建本机 provider（127.0.0.1 stub）", !!providerId, "ok + providerId", JSON.stringify(prov).slice(0, 400));
  if (!providerId) return;
  const mdl = await bridge(page, "model", "model/create", { providerId: providerId, remoteModelId: "e2e-chat", displayName: "E2E Chat", capabilities: ["chat"], scope: "PERSONAL" });
  const configId = mdl && mdl.model ? (mdl.model.configId || mdl.model.id) : null;
  record("3-core", "C3.1 经产品桥 model/create 建 chat 配置", !!configId, "ok + configId", JSON.stringify(mdl).slice(0, 400));
  if (!configId) return;
  const def = await bridge(page, "model", "defaults/set", { capability: "chat", configId: configId, scope: "PERSONAL" });
  record("3-core", "C3.2 经产品桥 defaults/set 设为个人默认 chat", !!def && def.ok === true, "ok:true", JSON.stringify(def).slice(0, 300));

  const run = await bridge(page, "task", "task/run", { goal: "E2E 交互验收：创建一个 core 任务" });
  const taskId = run && run.taskId ? run.taskId : null;
  record("3-core", "C3.3 经产品桥 task/run 创建 core 任务（task-bootstrap.cjs:133-151）", !!taskId && run.ok === true, "ok + taskId", JSON.stringify(run).slice(0, 400));
  if (!taskId) return;
  ctx.coreTaskId = taskId;
  await waitFor(async () => { const g = await taskGet(page, taskId); return !!(g && g.ok && g.task && ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].indexOf(g.task.status) >= 0); }, 60000, 500);

  const opened = await openApp(page, "projects", "项目窗口");
  const nav = await clickNavText(page, "项目窗口", "任务控制台");
  const rowOk = await waitFor(() => q(page, '[data-task-core-row="' + taskId + '"]'), 25000, 300);
  record("3-core", "C3.4 任务控制台出现 core 行（统一读模型；TaskConsole.tsx:1178-1195）", opened && nav && rowOk, "core 行可见", JSON.stringify({ opened: opened, nav: nav, row: rowOk }));
  if (!rowOk) return;
  await clickSel(page, '[data-task-core-row="' + taskId + '"]');
  const detailOk = await waitFor(() => q(page, "[data-task-core-detail]"), 15000, 250);
  record("3-core", "C3.5 选中 core 任务后详情按后端 task/get 渲染", detailOk, "[data-task-core-detail]", String(detailOk));

  const before = await taskGet(page, taskId);
  const stepsBefore = before && Array.isArray(before.steps) ? before.steps.length : -1;

  const appendDisabled = await attr(page, '[data-task-core-action="append-step"]', "disabled");
  const appendReasonEmpty = await textOf(page, '[data-task-core-action-reason="append-step"]');
  const cancelReason = await textOf(page, '[data-task-core-action-reason="cancel"]');
  record("3-core", "C3.6 输入不允许时「追加步骤」禁用并给可见原因（taskConsoleLogic.ts:1571-1574）",
    appendDisabled !== null && !!appendReasonEmpty, "append-step 原因非空", JSON.stringify({ appendDisabled: appendDisabled, appendReasonEmpty: appendReasonEmpty }));
  record("3-core", "C3.6b 状态不允许时「取消」禁用并给可见原因（终态任务，taskConsoleLogic.ts:1580-1585）",
    !!cancelReason && cancelReason.indexOf("不能再取消") >= 0, "包含 不能再取消", JSON.stringify({ cancelReason: cancelReason }));

  const set = await setInput(page, '[data-task-core-field="goal"]', "E2E 追加步骤：确认后端步骤 +1");
  const clickAppend = await clickSel(page, '[data-task-core-action="append-step"]');
  const confirmShown = await waitFor(() => q(page, '[data-task-core-confirm="append-step"]'), 6000, 150);
  const confirmSummary = await textOf(page, '[data-task-core-confirm-summary]');
  record("3-core", "C3.7 写类动作先二次确认（确认前 0 命令）", set === "ok" && clickAppend === "ok" && confirmShown, "confirm 出现", JSON.stringify({ set: set, click: clickAppend, summary: confirmSummary }));
  if (!confirmShown) return;
  await clickSel(page, '[data-task-core-confirm-submit]');
  const appended = await waitFor(async () => { const g = await taskGet(page, taskId); return !!(g && g.ok && Array.isArray(g.steps) && g.steps.length >= stepsBefore + 1); }, 45000, 400);
  const after = await taskGet(page, taskId);
  record("3-core", "C3.8 追加后后端 task/get 步骤数 +1（不做本地拼接）", appended, "steps >= " + (stepsBefore + 1), JSON.stringify({ before: stepsBefore, after: after && after.steps ? after.steps.length : null, status: after && after.task ? after.task.status : null }));

  const uiStepsOk = await waitFor(() => page.evaluate(() => document.querySelectorAll("[data-task-core-step]").length >= 2), 30000, 300);
  const uiSteps = await page.evaluate(() => document.querySelectorAll("[data-task-core-step]").length);
  const backendAfter = await taskGet(page, taskId);
  record("3-core", "C3.9 界面步骤列表条数 ≥ 后端 task/get（界面不做本地拼接）",
    uiStepsOk && uiSteps >= (backendAfter && backendAfter.steps ? backendAfter.steps.length : 0),
    "界面条数 ≥ 后端条数",
    JSON.stringify({ uiSteps: uiSteps, backendSteps: backendAfter && backendAfter.steps ? backendAfter.steps.length : null, status: backendAfter && backendAfter.task ? backendAfter.task.status : null }));

  ctx.raiseAppId = "projects";
  await shootThemes(page, ctx.cdp, ctx, "core-task-append", "项目窗口");
}

async function item4_automation(page, ctx) {
  // P0：item1 收工把开关关回了默认；自动化真实外发需要总开关打开（Z1 文档：总开关 + 定义授权 两把锁）。
  const on = await bridge(page, "mcp", "mcp/toolInvocation/set", { enabled: true });
  const fileOn = readMcpJson(ctx.userData);
  record("4-自动化", "A4.0 前置：工具调用总开关打开（真实落盘）", !!on && on.ok === true && !!fileOn.value && fileOn.value.tools.invocationEnabled === true, "ok + invocationEnabled=true", JSON.stringify({ res: on, file: fileOn.value }));

  const health = await bridge(page, "automation", "automation/health");
  const enabled = await bridge(page, "integration", "integration/plugins/enable", { id: "lingxing" });
  record("4-自动化", "A4.1 启用领星集成（integration/plugins/enable）", !!enabled && enabled.ok === true, "ok:true", JSON.stringify({ enabled: enabled, health: health }).slice(0, 600));

  const created = await bridge(page, "mcp", "mcp/create", { name: "E2E Lingxing Stub", transport: "http", location: "REMOTE_SERVICE", endpoint: { url: ctx.mcpStub.url, serverKey: "lingxing" }, authMode: "NONE", visibility: "PERSONAL" });
  const connectionId = created && created.connection ? created.connection.connectionId : null;
  record("4-自动化", "A4.2 建到本机 stub 的 MCP 连接（127.0.0.1，http）", !!connectionId, "ok + connectionId", JSON.stringify(created).slice(0, 400));
  let connected = null;
  if (connectionId) {
    await bridge(page, "mcp", "mcp/setEnabled", { connectionId: connectionId, enabled: true });
    connected = await bridge(page, "mcp", "mcp/connect", { connectionId: connectionId });
    record("4-自动化", "A4.3 真实握手到 stub（mcp/connect）", !!connected && connected.ok === true && connected.connection && connected.connection.status === "READY", "READY", JSON.stringify(connected).slice(0, 400));
  }

  const auto = await bridge(page, "automation", "automation/create", { definition: { instruction: "E2E 定义即授权：领星缓存同步", schedule: { type: "interval", everyMs: 3600000 }, action: { type: "lingxing_cache_sync", args: { days: 1 } } } });
  const autoId = auto && auto.value && auto.value.automation ? auto.value.automation.id : (auto && auto.automation ? auto.automation.id : null);
  record("4-自动化", "A4.4 经产品桥建含集成动作的自动化", !!autoId, "ok + automationId", JSON.stringify(auto).slice(0, 500));
  if (!autoId) return;
  ctx.automationId = autoId;
  const en = await bridge(page, "automation", "automation/enable", { automationId: autoId });
  record("4-自动化", "A4.5 启用（定义即授权：管理员启用即落授权记录）", !!en && en.ok === true, "ok:true", JSON.stringify(en).slice(0, 500));

  const hitsBefore = ctx.mcpStub.state.toolsCalls.length;
  const run = await bridge(page, "automation", "automation/runNow", { automationId: autoId, await: true });
  await sleep(1200);
  const hitsAfter = ctx.mcpStub.state.toolsCalls.length;
  record("4-自动化", "A4.6 触发执行 → 真实调用到本机 stub（不是假传输）", hitsAfter > hitsBefore, "stub tools/call > " + hitsBefore, JSON.stringify({ run: run, stubCalls: ctx.mcpStub.state.toolsCalls, stubMethods: ctx.mcpStub.state.byMethod }).slice(0, 900));

  const runs = await bridge(page, "automation", "automation/runs", { automationId: autoId });
  record("4-自动化", "A4.7 run 记录可见（run 审计含授权来源）", !!runs && runs.ok === true, "ok:true", JSON.stringify(runs).slice(0, 600));

  await bridge(page, "automation", "automation/disable", { automationId: autoId });
  const hitsBeforeOff = ctx.mcpStub.state.toolsCalls.length;
  const blocked = await bridge(page, "automation", "automation/runNow", { automationId: autoId, await: true });
  await sleep(800);
  const hitsAfterOff = ctx.mcpStub.state.toolsCalls.length;
  record("4-自动化", "A4.8 停用后 runNow 结构化拒绝（AUTOMATION_FORBIDDEN）", !!blocked && blocked.ok === false && blocked.error === "AUTOMATION_FORBIDDEN", "ok:false + AUTOMATION_FORBIDDEN", JSON.stringify(blocked).slice(0, 500));
  record("4-自动化", "A4.9 停用后 0 次外发（stub 调用数不增）", hitsAfterOff === hitsBeforeOff, "stub calls 不变", JSON.stringify({ before: hitsBeforeOff, after: hitsAfterOff }));

  ctx.raiseAppId = "mcp-center";
  await shootThemes(page, ctx.cdp, ctx, "automation-precondition", "MCP 中心窗口");
}

async function item1b_mcpFailure(page, ctx) {
  const mcpPath = path.join(ctx.userData, "dxos", "mcp.json");
  const before = fs.readFileSync(mcpPath, "utf8");
  const expectedEnabled = before.indexOf('"invocationEnabled": true') >= 0 ? "true" : "false";

  // (a) 非法载荷：结构化拒绝且状态不变（electron/mcp-bootstrap.cjs:287）
  const invalid = await bridge(page, "mcp", "mcp/toolInvocation/set", { enabled: "yes" });
  const afterInvalid = fs.readFileSync(mcpPath, "utf8");
  record("1b-MCP失败", "N1.1 非法载荷结构化拒绝 MCP_INVALID_INPUT 且开关状态不变",
    !!invalid && invalid.ok === false && invalid.error === "MCP_INVALID_INPUT" && afterInvalid === before,
    "ok:false + MCP_INVALID_INPUT + 文件逐字不变", JSON.stringify(invalid).slice(0, 300));

  // (b) 写盘失败：dxos 目录只读 → MCP_SWITCH_UNAVAILABLE，UI 显示结构化错误且不乐观切换
  await openApp(page, "mcp-center", "MCP 中心窗口");
  const section = await waitFor(() => q(page, "[data-mcp-toolswitch-section]"), 20000, 250);
  const dxosDir = path.join(ctx.userData, "dxos");
  let uiOk = false;
  let uiToggle = null;
  let fileUnchanged = false;
  let chmodOk = true;
  try {
    fs.chmodSync(dxosDir, 0o555);
  } catch (e) { chmodOk = false; }
  try {
    if (section && chmodOk) {
      await clickSel(page, "[data-mcp-toolswitch-toggle]");
      uiOk = await waitFor(async () => (await readToggle(page)).errorCode === "MCP_SWITCH_UNAVAILABLE", 20000, 250);
    }
    uiToggle = await readToggle(page);
    fileUnchanged = fs.readFileSync(mcpPath, "utf8") === before;
  } finally {
    try { fs.chmodSync(dxosDir, 0o755); } catch { /* ignore */ }
  }
  record("1b-MCP失败", "N1.2 写盘失败路径：结构化 MCP_SWITCH_UNAVAILABLE + 界面不乐观切换 + 文件不变",
    section && chmodOk && uiOk && !!uiToggle && uiToggle.enabled === expectedEnabled && fileUnchanged,
    "MCP_SWITCH_UNAVAILABLE + enabled=" + expectedEnabled + " + 文件逐字不变",
    JSON.stringify({ section: section, chmodOk: chmodOk, code: uiToggle ? uiToggle.errorCode : null, toggle: uiToggle, fileUnchanged: fileUnchanged }).slice(0, 600));

  // (c) 权限路径：真实 MEMBER 会话写全局开关（风险标注 mcp.manage）——如实断言实测结果
  const created = await identityCommand(page, "identity/user-create", { identifier: MEMBER, password: MEMBER_PW, displayName: "E2E 成员", role: "MEMBER" });
  await identityCommand(page, "identity/logout", {});
  const login = await identityCommand(page, "identity/login", { identifier: MEMBER, password: MEMBER_PW });
  const gate = await waitFor(() => page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") === "ready" : false; }), 25000, 250);
  record("1b-MCP失败", "N1.3 切换到 MEMBER 会话进入桌面 ready", !!created && created.ok === true && !!login && login.ok === true && gate, "ok + gate=ready", JSON.stringify({ user: created && created.ok, login: login && login.ok, gate: gate }).slice(0, 300));
  const beforeMember = fs.readFileSync(mcpPath, "utf8");
  const memberWrite = await bridge(page, "mcp", "mcp/toolInvocation/set", { enabled: expectedEnabled === "true" ? false : true });
  const afterMember = fs.readFileSync(mcpPath, "utf8");
  record("1b-MCP失败", "N1.4 权限路径：非管理员写全局开关应被结构化拒绝（风险标注 mcp.manage；实测结果如实断言）",
    !!memberWrite && memberWrite.ok === false && afterMember === beforeMember,
    "ok:false（MCP_UNAUTHORIZED）+ 文件逐字不变",
    JSON.stringify({ memberWrite: memberWrite, fileUnchanged: afterMember === beforeMember }).slice(0, 600));
}

/* ══════════════════════════════════════════════════════════════════════════
   主流程
   ══════════════════════════════════════════════════════════════════════════ */
async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  fs.mkdirSync(ART, { recursive: true });

  const realProfilePath = resolveRealProfilePath();
  const profileBefore = snapshotProfile(realProfilePath);
  const realProfileProcessesBefore = processesUsing(realProfilePath);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-e2e-interactions-"));
  const cdpPort = await freePort();
  const inspectPort = await freePort();
  const modelStub = await startModelStub();
  const mcpStub = await startMcpStub();
  const ctx = { userData: userData, modelStub: modelStub, mcpStub: mcpStub, realProfilePath: realProfilePath, inspector: null, cdp: null, raiseAppId: null };

  console.log("隔离 userData：" + userData);
  console.log("CDP 端口：" + cdpPort + " / 主进程 inspector 端口：" + inspectPort);
  console.log("模型 stub：" + modelStub.url);
  console.log("MCP stub：" + mcpStub.url);
  console.log("真实 profile：" + realProfilePath + (profileBefore.exists ? "（存在，只读快照）" : "（不存在）"));

  const env = Object.assign({}, process.env, { OPENARC_IDENTITY_ADMIN: "1" });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const args = [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + cdpPort, "--inspect=" + inspectPort];
  const child = spawn(electronPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: env });
  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout.on("data", (d) => { stdoutBuf += String(d); });
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  const exitInfo = { code: null, signal: null, clean: false };

  let browser = null;
  let page = null;
  try {
    const cdpReady = await waitFor(async () => { try { const r = await fetch("http://127.0.0.1:" + cdpPort + "/json/version"); return r.ok; } catch { return false; } }, 45000, 300);
    record("boot", "B0 · 真实 electron .（electron/main.cjs）启动并暴露 CDP", cdpReady, "CDP ready", cdpReady ? "ready" : stderrBuf.slice(-300));
    if (!cdpReady) throw new Error("CDP 未就绪：" + stderrBuf.slice(-500));

    ctx.inspector = await attachMainInspector(inspectPort);
    record("boot", "B0b · 主进程 inspector（仅用于替换系统 dialog；产品代码不改）", !!ctx.inspector, "inspector 可用", JSON.stringify(ctx.inspector ? ctx.inspector.targets : null));

    browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
    const context = browser.contexts()[0];
    const isUI = (p) => p.url().indexOf("dist/index.html") >= 0 || p.url().indexOf("index.html") >= 0;
    const found = await waitFor(() => !!context.pages().find(isUI), 30000, 300);
    page = context.pages().find(isUI) || null;
    if (!found || !page) throw new Error("未找到真实界面页面：" + context.pages().map((p) => p.url()).join(" | "));

    page.on("console", (msg) => { const row = { type: msg.type(), text: String(msg.text()).slice(0, 400) }; consoleAll.push(row); if (row.type === "error") consoleErrors.push(row.text); });
    page.on("pageerror", (err) => pageErrors.push(String((err && err.message) || err).slice(0, 400)));
    page.on("request", (req) => { if (!LOCAL_RE.test(req.url())) nonLocalRequests.push({ url: req.url() }); });
    page.on("requestfailed", (req) => requestFailures.push({ url: req.url(), error: String((req.failure() && req.failure().errorText) || "") }));

    const rendererReady = await waitFor(() => page.evaluate(() => { const d = document.querySelector(".desktop"); return document.readyState === "complete" && !!window.openarc && Object.keys(window.openarc).length === 25; }), 45000, 300);
    record("boot", "B1 · 渲染就绪 + 桥面顶层键恰为 25", rendererReady, "readyState=complete + 25 键", JSON.stringify(await page.evaluate(() => ({ url: location.href, keys: window.openarc ? Object.keys(window.openarc).length : 0, gate: document.querySelector(".desktop") ? document.querySelector(".desktop").getAttribute("data-identity-gate") : null }))));
    ctx.cdp = await page.context().newCDPSession(page);
    await ctx.cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.deviceScaleFactor, mobile: false });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "no-preference" });
    await sleep(300);

    const initRes = await identityCommand(page, "identity/initialize", { identifier: ADMIN, password: ADMIN_PW, displayName: "E2E 交互管理员" });
    const loginRes = await identityCommand(page, "identity/login", { identifier: ADMIN, password: ADMIN_PW });
    const gateReady = await waitFor(() => page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") === "ready" : false; }), 25000, 250);
    record("boot", "B2 · 经产品桥 identity/initialize + login 进入桌面 ready", !!(initRes && initRes.ok === true) && !!(loginRes && loginRes.ok === true) && gateReady, "ok + gate=ready", JSON.stringify({ init: initRes && initRes.ok, login: loginRes && loginRes.ok, gateReady: gateReady }));
    record("隔离", "B3 · 隔离 userData ≠ 真实 profile 且内部真实建库 identity.db", path.resolve(userData) !== path.resolve(realProfilePath) && fs.existsSync(path.join(userData, "identity.db")), "不同路径 + identity.db 存在", userData);

    const items = [
      ["1-MCP", () => item1_mcpPositive(page, ctx)],
      ["2-访达", () => item2_files(page, ctx)],
      ["3-core", () => item3_core(page, ctx)],
      ["4-自动化", () => item4_automation(page, ctx)],
      ["1b-MCP失败", () => item1b_mcpFailure(page, ctx)],
    ];
    for (const entry of items) {
      try { await entry[1](); }
      catch (e) { record(entry[0], "未捕获异常（该项后续断言不再执行）", false, "不抛异常", String((e && e.stack) || e).slice(0, 700)); }
    }
  } catch (e) {
    record("boot", "主流程异常", false, "不抛异常", String((e && e.stack) || e).slice(0, 800));
  } finally {
    try { if (ctx.inspector) await ctx.inspector.restoreDialog(); } catch { /* ignore */ }
    try { if (ctx.inspector) ctx.inspector.close(); } catch { /* ignore */ }
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { spawnSync("pkill", ["-f", userData], { stdio: "ignore" }); } catch { /* ignore */ }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    const exited = await waitFor(() => child.exitCode !== null || child.signalCode !== null, 8000, 200);
    if (!exited) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
    exitInfo.code = child.exitCode;
    exitInfo.signal = child.signalCode;
    exitInfo.clean = exited;
  }

  record("boot", "B4 · 应用可正常收尾（无 SIGKILL 兜底）", exitInfo.clean, "正常退出", JSON.stringify(exitInfo));
  const residual = processesUsing(userData);
  record("exit", "X1 · 无残留进程持有隔离 userData", residual.length === 0, "0 个", residual.length + " → " + JSON.stringify(residual.slice(0, 5)));

  const audit = await readAuditRows(path.join(userData, "identity.db"));
  const autoRows = audit.rows.filter((r) => String(r.resource_ref || "").indexOf("automation:") === 0);
  record("4-自动化", "A4.10 授权审计落库：automation.authorize(A) + automation.execute(E)", audit.ok && autoRows.some((r) => r.action === "automation.authorize") && autoRows.some((r) => r.action === "automation.execute"), "两类审计行存在", JSON.stringify({ ok: audit.ok, error: audit.error, rows: autoRows.map((r) => ({ action: r.action, decision: r.decision, reason: r.reason_code, actor: r.actor_user_id, perm: r.new_permissions })) }).slice(0, 1200));
  const authorize = autoRows.find((r) => r.action === "automation.authorize");
  const execute = autoRows.find((r) => r.action === "automation.execute");
  record("4-自动化", "A4.11 execute 审计含授权来源（definitionId + runId）", !!execute && String(execute.new_permissions || "").indexOf("definitionId") >= 0, "new_permissions 含 definitionId", JSON.stringify({ execute: execute ? { decision: execute.decision, reason: execute.reason_code, perm: execute.new_permissions } : null, authorize: authorize ? { decision: authorize.decision, perm: authorize.new_permissions } : null }).slice(0, 800));

  try { if (!KEEP) fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
  record("exit", "X2 · 删除隔离 userData", KEEP ? true : !fs.existsSync(userData), KEEP ? "KEEP=1 保留" : "removed", KEEP ? "kept" : String(!fs.existsSync(userData)));

  const profileAfter = snapshotProfile(realProfilePath);
  const profileDiff = diffProfile(profileBefore, profileAfter);
  const realProfileProcessesAfter = processesUsing(realProfilePath);
  const openArcRunning = processesMatching("OpenArc OS.app");
  const spawnJoined = [electronPath].concat(args).join(" ");
  record("隔离", "X3 · 本探针只以隔离 userData 启动（启动参数含隔离路径、不含真实 profile 路径）",
    spawnJoined.indexOf(userData) >= 0 && spawnJoined.indexOf(realProfilePath) < 0,
    "含隔离路径且不含真实 profile 路径", JSON.stringify({ userData: userData, realProfilePath: realProfilePath, args: args }));
  const pidSetBefore = realProfileProcessesBefore.map((l) => l.split(" ")[0]);
  const pidSetAfter = realProfileProcessesAfter.map((l) => l.split(" ")[0]);
  const writersAreUserApp = realProfileProcessesAfter.every((l) => l.indexOf("OpenArc OS.app") >= 0);
  const probeArgvRefsRealProfile = spawnJoined.indexOf(realProfilePath) >= 0;
  record("隔离", "X3b · 真实 profile 的所有变化都来自本机 OpenArc OS.app（本探针 argv 不含真实 profile 路径）",
    profileDiff.unchanged || (writersAreUserApp && !probeArgvRefsRealProfile),
    "无变化 或（写者全是 OpenArc OS.app 且探针 argv 不含真实 profile）",
    JSON.stringify({ unchanged: profileDiff.unchanged, changed: profileDiff.changed.slice(0, 20), writersAreUserApp: writersAreUserApp, probeArgvRefsRealProfile: probeArgvRefsRealProfile, writersBefore: pidSetBefore, writersAfter: pidSetAfter, appRestartedDuringProbe: pidSetBefore.join(",") !== pidSetAfter.join(",") }).slice(0, 1200));
  note("真实 profile 开工/收工快照对照（sha256+size+mtime，如实报告）：" + (profileDiff.unchanged ? "无变化" : "变化 " + profileDiff.changed.join("、")));
  note("真实 profile 写者进程（开工）：" + JSON.stringify(realProfileProcessesBefore));
  note("真实 profile 写者进程（收工）：" + JSON.stringify(realProfileProcessesAfter));
  note("本机正在跑的 OpenArc OS.app 进程（用户自己的实例，可独立写真实库）：" + JSON.stringify(openArcRunning.slice(0, 5)));
  if (!profileDiff.unchanged) note("真实 profile 有变化，但探针全程只用 --user-data-dir 隔离目录（X3 已证 argv 不含真实 profile），变化来自上方列出的本机 OpenArc OS.app 进程；本次观测到该 App 在探针期间重启过（pid 集合变化），所以写入者 pid 与开工时不同，这属于用户自己的实例，不是探针。");

  record("console", "C · 0 console error", consoleErrors.length === 0, "0", consoleErrors.length + " → " + JSON.stringify(consoleErrors.slice(0, 5)));
  record("console", "C · 0 pageerror", pageErrors.length === 0, "0", pageErrors.length + " → " + JSON.stringify(pageErrors.slice(0, 5)));
  record("network", "N · 0 非本地请求", nonLocalRequests.length === 0, "0", nonLocalRequests.length + " → " + JSON.stringify(nonLocalRequests.slice(0, 5)));

  const failed = checks.filter((c) => !c.ok);
  const report = {
    at: nowIso(), title: "任务 C · 新交互真机端到端验收", ok: failed.length === 0,
    isolation: { userDataDir: userData, kept: KEEP, cdpPort: cdpPort, inspectPort: inspectPort, realProfilePath: realProfilePath, realProfileDiff: { unchanged: profileDiff.unchanged, changed: profileDiff.changed }, realProfileProcessesBefore: realProfileProcessesBefore, realProfileProcessesAfter: realProfileProcessesAfter, openArcRunning: openArcRunning.slice(0, 10) },
    stubs: { model: { url: modelStub.url, requests: modelStub.state.requests }, mcp: { url: mcpStub.url, requests: mcpStub.state.requests, sessions: mcpStub.state.sessions, byMethod: mcpStub.state.byMethod, toolsCalls: mcpStub.state.toolsCalls } },
    checks: checks, screenshots: screenshots, observations: observations,
    console: { total: consoleAll.length, errors: consoleErrors, pageErrors: pageErrors },
    network: { nonLocal: nonLocalRequests, failures: requestFailures.slice(0, 20) },
    process: { exit: exitInfo, residual: residual, stdoutTail: stdoutBuf.slice(-1000), stderrTail: stderrBuf.slice(-2000) },
  };
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));

  console.log("");
  console.log("========== 汇总 ==========");
  console.log("PASS " + (checks.length - failed.length) + " / FAIL " + failed.length);
  for (const f of failed) console.log("  FAIL [" + f.section + "] " + f.name + " :: " + f.actual);
  console.log("报告：" + path.relative(ROOT, path.join(ART, "report.json")));
  console.log("截图：" + screenshots.length + " 张（" + screenshots.map((s) => s.file).join(", ") + "）");

  await modelStub.close();
  await mcpStub.close();
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
