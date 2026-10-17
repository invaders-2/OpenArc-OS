#!/usr/bin/env node
/**
 * dxos-update-real-source · 真机端到端验收（真实 Electron + 真实 ModelScope 源 + 隔离 userData）。
 *
 * 只做验证，不改产品代码：
 *   1 检查更新：默认源 ModelScope bllack/OpenArc-OS -> market/update/status + market/update/check，
 *     断言真的从 updates/canvas/latest.json 拿到 version 0.01 / sha256 6929461...，
 *     内置 0.1.0 与 0.01 语义相等 -> updateAvailable=false（预期不是 bug）。
 *   2 真实安装：market/update/install { version:"0.01", confirm:true }，走真实下载 -> 仓库公钥验签 ->
 *     逐文件 sha256 -> 解压围栏 -> 原子切换；current.json 指向 0.01；随后隔离 profile 打开画布首页 + 智能画布。
 *   3 真实回滚：market/update/rollback，原样记录结果（成功/失败都如实写进报告）。
 *   4 回滚后再检查：status 如实。
 *   5 应用商店 -> 无限画布 -> 更新面板截图（浅/深）。
 *
 * 网络取证：用 NODE_OPTIONS=--require=... 给 Electron 主进程注入只读 fetch 追踪
 * （experiments/dxos-update-real-source/fetch-trace-preload.cjs），记录每笔请求的
 * 主机 / 状态 / 重定向 / 耗时，以及被完整读出的响应体字节数与 sha256。
 * 原始 trace 含 ModelScope LFS 签名参数，只留在临时目录；artifacts 里放脱敏副本。
 *
 * 用法：node experiments/dxos-update-real-source/run.mjs
 * 输出：artifacts/dxos-update-real-source/{report.json,RESULT.md,fetch-trace.jsonl,shots/*}
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-update-real-source");
const SHOTS = path.join(ART, "shots");
const RAW_TRACE = path.join(os.tmpdir(), "oa-update-real-trace-raw-" + process.pid + ".jsonl");
const TRACE_PRELOAD_SRC = path.join(HERE, "fetch-trace-preload.cjs");
const TRACE_PRELOAD = path.join(os.tmpdir(), "oa-update-real-trace-preload.cjs");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const ADMIN = { identifier: "update-real@openarc.test", password: "UpdateReal-pass-1", displayName: "更新验收管理员" };
const MODELSCOPE_HOSTS = new Set(["modelscope.cn", "cdn-lfs-cn-1.modelscope.cn"]);
const EXPECT = {
  version: "0.01",
  sha256: "692946187d2cff2cf68f5c45740ffcdc473ce304665064f30d981fc082ab7d12",
  zipBytes: 6437523,
  builtinVersion: "0.1.0",
  owner: "bllack",
  repo: "OpenArc-OS",
  manifestPath: "updates/canvas/latest.json",
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const electronPath = require("electron");
const electronVersion = (() => { try { return require("electron/package.json").version; } catch { return null; } })();
const { chromium } = require("@playwright/test");
const domain = require(path.join(ROOT, "electron", "market-update-domain.cjs"));

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const statOf = (file) => { try { const stat = fs.statSync(file); return { exists: true, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }; } catch { return { exists: false }; } };

const checks = [];
function check(id, name, ok, expected, actual) {
  const row = {
    id,
    name,
    ok: !!ok,
    expected: typeof expected === "string" ? expected : JSON.stringify(expected),
    actual: typeof actual === "string" ? actual.slice(0, 2400) : JSON.stringify(actual).slice(0, 2400),
  };
  checks.push(row);
  console.log((row.ok ? "PASS" : "FAIL") + " [" + row.id + "] " + row.name + (row.ok ? "" : " :: expected=" + row.expected + " actual=" + row.actual));
  return row.ok;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
async function waitFor(fn, timeoutMs = 30000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await Promise.resolve(fn())) return true; } catch { /* 重试到超时 */ }
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

function hostOf(value) { try { return new URL(String(value)).hostname; } catch { return null; } }
function redactUrl(value) {
  try {
    const url = new URL(String(value));
    for (const key of ["auth_key", "sig", "signature", "token", "csrf_token", "X-Amz-Signature", "Expires", "Signature"]) url.searchParams.delete(key);
    return url.toString();
  } catch { return String(value); }
}
function traceMark() { try { return fs.readFileSync(RAW_TRACE, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } }
function traceSince(mark) {
  let lines = [];
  try { lines = fs.readFileSync(RAW_TRACE, "utf8").split("\n").filter(Boolean).slice(mark); } catch { return []; }
  return lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}
function summarizeTrace(records) {
  return records.map((record) => ({
    kind: record.kind,
    host: hostOf(record.url),
    url: redactUrl(record.url),
    method: record.method || null,
    status: record.status == null ? null : record.status,
    redirect: record.redirect || null,
    locationHost: record.location ? hostOf(record.location) : null,
    location: record.location ? redactUrl(record.location) : null,
    contentType: record.contentType || null,
    contentLength: record.contentLength == null ? null : record.contentLength,
    bytes: record.bytes == null ? null : record.bytes,
    sha256: record.sha256 || null,
    text: record.text ? record.text.slice(0, 4096) : null,
    ms: record.ms == null ? null : record.ms,
    error: record.error || null,
  }));
}
function hostsOf(trace) { return [...new Set(trace.filter((item) => item.host).map((item) => item.host))].sort(); }

// ---- 画布 / 面板取证辅助 ----------------------------------------------------
let child = null;
let browser = null;
let page = null;
let userDataDir = null;
let cdp = null;
let stderrTail = "";
let stdoutTail = "";
const consoleErrors = [];
const pageErrors = [];
const netFailures = [];
const requestUrls = new Map();
const steps = {};

const js = (code) => page.evaluate("(async () => { " + code + " })()");
const clickMain = (selector) => js("const el = document.querySelector(" + JSON.stringify(selector) + "); if (!el) return false; el.click(); return true;");
const gateState = () => js("const d = document.querySelector('.desktop'); return d ? d.getAttribute('data-identity-gate') : 'no-root'");
const frameBy = (regex) => page.frames().find((frame) => regex.test(frame.url())) || null;
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const smartFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/smart-canvas\.html/);

async function inFrame(frame, code) {
  if (!frame) return { __noFrame: true };
  try {
    const raw = await frame.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()");
    return JSON.parse(raw || "null");
  } catch (error) {
    return { __error: String((error && error.message) || error).slice(0, 400) };
  }
}

async function bridge(channel, command, payload) {
  const started = Date.now();
  const result = await page.evaluate(async (arg) => {
    const api = window.openarc && window.openarc[arg.channel];
    if (!api || typeof api.command !== "function") return { __noBridge: true, channel: arg.channel, keys: window.openarc ? Object.keys(window.openarc) : [] };
    const request = (arg.channel === "identity" || arg.channel === "resource")
      ? Object.assign({ type: arg.command }, arg.payload)
      : { command: arg.command, payload: arg.payload || {} };
    try { return await api.command(request); } catch (error) { return { __threw: true, message: String((error && error.message) || error) }; }
  }, { channel, command, payload: payload || {} });
  return { ms: Date.now() - started, result };
}
const market = (command, payload) => bridge("marketUpdate", command, payload);

async function screenshot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, name + ".png");
  await page.screenshot({ path: file });
  const buffer = fs.readFileSync(file);
  return { file: path.relative(ROOT, file), bytes: buffer.length, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function setTheme(theme) {
  if (!(await page.$(".control-center"))) {
    await clickMain('button[aria-label="控制中心"]');
    await sleep(400);
  }
  const clicked = await page.evaluate((label) => {
    const center = document.querySelector(".control-center");
    if (!center) return false;
    const group = center.querySelector('[aria-label="外观"]');
    if (!group) return false;
    for (const button of group.querySelectorAll("button")) {
      if (String(button.textContent || "").trim() === label) { button.click(); return true; }
    }
    return false;
  }, theme === "dark" ? "深色" : "浅色");
  await sleep(500);
  return clicked;
}
async function closeControlCenter() {
  if (await page.$(".control-center")) { await clickMain(".cc-shade"); await sleep(250); }
}

async function openCanvasWindow() {
  if (listFrame() || smartFrame()) return true;
  await clickMain('[data-dock-id="canvas"]');
  if (await waitFor(() => !!listFrame() || !!smartFrame(), 20000)) return true;
  await clickMain('[data-dock-id="home"]');
  await waitFor(async () => !!(await page.$('[data-app-card="canvas"]')), 15000);
  await clickMain('[data-app-card="canvas"]');
  return await waitFor(() => !!listFrame() || !!smartFrame(), 20000);
}

/** 打开画布首页（列表页）+ 智能画布各一次；返回服务来源、DOM 事实与截图。 */
async function canvasPass(label) {
  const pass = { label, opened: false, listUp: false, list: null, served: null, smart: null, back: null, errorCounts: null, shots: [] };
  pass.opened = await openCanvasWindow();
  if (!pass.opened) return pass;
  if (smartFrame()) {
    await inFrame(smartFrame(), "const el = document.querySelector('.smart-back'); if (el) el.click(); return !!el;");
    await waitFor(() => !!listFrame() && !smartFrame(), 30000);
  }
  pass.listUp = await waitFor(() => !!listFrame(), 30000);
  pass.readyComplete = await waitFor(async () => String(await inFrame(listFrame(), "return document.readyState;")) === "complete", 15000);
  pass.list = await inFrame(listFrame(), "return { url: location.href, title: document.title, ready: document.readyState, start: !!document.getElementById('btnStartCreate'), errorDoc: String(document.title).indexOf('不可用') >= 0 };");
  pass.served = await inFrame(listFrame(), "const r = await fetch('/static/canvas-list.html'); const text = await r.text(); let digest = null; try { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); digest = Array.prototype.map.call(new Uint8Array(d), function(b){ return b.toString(16).padStart(2,'0'); }).join(''); } catch (e) { digest = null; } return { status: r.status, source: r.headers.get('x-openarc-canvas-source'), version: r.headers.get('x-openarc-canvas-version'), fallback: r.headers.get('x-openarc-canvas-fallback'), bytes: new TextEncoder().encode(text).length, sha256: digest };");
  pass.shots.push(await screenshot("canvas-home-" + label));
  pass.created = await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';");
  pass.smartUp = await waitFor(() => !!smartFrame() && !listFrame(), 45000);
  pass.smartReady = await waitFor(async () => (await inFrame(smartFrame(), "return document.readyState === 'complete' && typeof window.__openarcBridge === 'object' && !!window.__openarcSmartGuard;")).toString() === "true", 45000);
  pass.smart = await inFrame(smartFrame(), "return { url: location.href, title: document.title, ready: document.readyState, bridge: typeof window.__openarcBridge, guard: typeof window.__openarcSmartGuard, canvasId: (window.__openarcBridge && window.__openarcBridge.context && window.__openarcBridge.context.canvasId) || null };");
  pass.shots.push(await screenshot("canvas-smart-" + label));
  pass.back = await inFrame(smartFrame(), "const el = document.querySelector('.smart-back'); if (!el) return 'missing'; el.click(); return 'clicked';");
  pass.backToList = await waitFor(() => !!listFrame() && !smartFrame(), 30000);
  pass.errorCounts = { consoleErrors: consoleErrors.length, pageErrors: pageErrors.length, notFound: netFailures.filter((item) => item.status === 404).length, serverErrors: netFailures.filter((item) => item.status >= 500).length };
  return pass;
}

async function panelSnapshot() {
  return page.evaluate(() => {
    const el = document.querySelector("[data-canvas-update]");
    if (!el) return null;
    const attr = (name) => el.getAttribute(name);
    const text = (selector) => { const node = el.querySelector(selector); return node ? String(node.textContent || "").trim() : null; };
    const rows = Array.prototype.map.call(el.querySelectorAll(".set-group > .setting-row"), (row) => {
      const lab = row.querySelector(".set-lab");
      const val = row.querySelector(".set-val");
      return { label: lab ? String(lab.textContent || "").trim() : "", value: val ? String(val.textContent || "").trim() : "" };
    });
    const install = el.querySelector("[data-canvas-update-install]");
    const rollback = el.querySelector("[data-canvas-update-rollback]");
    return {
      state: attr("data-canvas-update-state"),
      busy: attr("data-canvas-update-busy"),
      current: attr("data-canvas-update-current"),
      builtin: attr("data-canvas-update-builtin"),
      latest: attr("data-canvas-update-latest"),
      published: attr("data-canvas-update-published"),
      available: attr("data-canvas-update-available"),
      canRollback: attr("data-canvas-update-can-rollback"),
      source: attr("data-canvas-update-source"),
      sourceRepo: attr("data-canvas-update-source-repo"),
      checkedAt: attr("data-canvas-update-checked-at"),
      loadable: attr("data-canvas-update-loadable"),
      badge: text(".cu-state-row .ds-badge"),
      title: text("[data-canvas-update-title]"),
      detail: text(".cu-state .set-cap"),
      rows,
      installButton: !!install,
      installDisabled: install ? !!install.disabled : null,
      rollbackButton: !!rollback,
      rollbackDisabled: rollback ? !!rollback.disabled : null,
      errorCode: el.querySelector("[data-canvas-update-error-code]") ? el.querySelector("[data-canvas-update-error-code]").getAttribute("data-canvas-update-error-code") : null,
    };
  });
}

async function waitPanelIdle() {
  return waitFor(async () => { const snapshot = await panelSnapshot(); return !!snapshot && snapshot.busy === "idle"; }, 30000);
}

// ---- 安装包落地后的独立复核（不依赖服务端自述） ----------------------------
function verifyInstalledPackage(stateDir, version) {
  const dir = path.join(stateDir, version);
  const out = { dir, ok: false, signatureOk: null, manifest: null, fileCount: 0, totalBytes: 0, mismatches: [], unsafeNames: [], digest: null, entryExists: false };
  let manifestBytes;
  try { manifestBytes = fs.readFileSync(path.join(dir, "manifest.json")); } catch { out.error = "manifest.json 缺失"; return out; }
  out.digest = sha256(manifestBytes);
  let signature = "";
  try { signature = fs.readFileSync(path.join(dir, "manifest.sig"), "utf8").trim(); } catch { out.error = "manifest.sig 缺失"; return out; }
  const keys = readJson(path.join(ROOT, "resources", "app-update-keys.json")) || {};
  const verified = domain.verifyManifestSignature({ manifestBytes, signatureBase64: signature, publicKeyBase64: keys.canvas });
  let independent = false;
  try {
    const raw = Buffer.from(String(keys.canvas || ""), "base64");
    const key = raw.length === 32 ? crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" }) : null;
    independent = key ? crypto.verify(null, manifestBytes, key, Buffer.from(signature, "base64")) : false;
  } catch { independent = false; }
  out.signatureOk = verified.ok === true && independent === true;
  out.signatureReason = verified.reason || null;
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { out.error = "manifest.json 不是 JSON"; return out; }
  out.manifest = { format: manifest.format, id: manifest.id, name: manifest.name, version: manifest.version, build: manifest.build, kind: manifest.kind, entry: manifest.entry, files: Object.keys(manifest.files || {}).length };
  const normalized = domain.normalizeManifest(manifest, { appId: "canvas" });
  out.normalized = normalized.ok === true;
  if (!normalized.ok) out.normalizeError = normalized.error && normalized.error.message;
  for (const [rel, hash] of Object.entries(manifest.files || {})) {
    out.fileCount += 1;
    if (!domain.isSafeEntryName(rel)) out.unsafeNames.push(rel);
    const absolute = path.join(dir, rel);
    let data;
    try { data = fs.readFileSync(absolute); } catch { out.mismatches.push({ rel, reason: "missing" }); continue; }
    out.totalBytes += data.length;
    if (sha256(data) !== hash) out.mismatches.push({ rel, reason: "sha256" });
    if (!absolute.startsWith(dir + path.sep)) out.mismatches.push({ rel, reason: "escape" });
  }
  out.entryExists = !!manifest.entry && fs.existsSync(path.join(dir, manifest.entry));
  out.ok = out.signatureOk === true && out.normalized === true && out.mismatches.length === 0 && out.unsafeNames.length === 0 && out.entryExists === true && out.manifest.id === "canvas";
  return out;
}

// ---- 主流程 -----------------------------------------------------------------
const report = {
  at: new Date().toISOString(),
  electronVersion,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  realNetwork: true,
  source: { kind: "modelscope-repo", owner: EXPECT.owner, repo: EXPECT.repo, manifestPath: EXPECT.manifestPath },
  expected: EXPECT,
  checks,
  steps,
  trace: { requests: [], hosts: [] },
  failure: null,
};

function attachNetwork(session) {
  session.on("Network.requestWillBeSent", (event) => requestUrls.set(event.requestId, event.request.url));
  session.on("Network.responseReceived", (event) => {
    if (event.response.status >= 400) netFailures.push({ kind: "response", status: event.response.status, url: event.response.url.slice(0, 240) });
  });
  session.on("Network.loadingFailed", (event) => netFailures.push({ kind: "loadingFailed", status: 0, errorText: event.errorText, url: String(requestUrls.get(event.requestId) || "").slice(0, 240) }));
}

async function reloadRenderer() {
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await waitFor(async () => ["ready"].includes(await gateState()), 60000);
  await waitFor(async () => (await js("return !!(window.openarc && Object.keys(window.openarc).length > 0)")), 45000);
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable").catch(() => {});
  await session.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false }).catch(() => {});
  await page.emulateMedia({ reducedMotion: "reduce" });
  attachNetwork(session);
  cdp = session;
  return session;
}

async function preflight() {
  const syntax = {};
  for (const rel of ["electron/main.cjs", "electron/preload.cjs", "electron/market-update-service.cjs"]) {
    const result = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], { encoding: "utf8" });
    syntax[rel] = { status: result.status, stderr: (result.stderr || "").slice(0, 300) };
  }
  steps.preflightSyntax = syntax;
  steps.syntaxOk = Object.values(syntax).every((item) => item.status === 0);
  if (!steps.syntaxOk) throw new Error("产品文件语法检查失败（可能有并发编辑正在进行）：" + JSON.stringify(syntax));

  const required = [path.join(ROOT, "dist/vue.html"), path.join(ROOT, "electron/main.cjs"), path.join(ROOT, "resources/app-update-keys.json"), TRACE_PRELOAD_SRC];
  for (const file of required) {
    if (!fs.existsSync(file)) throw new Error("缺少必需文件：" + file);
  }

  // harness 进程自己独立拉一次真实清单，与 Electron 里拿到的结果交叉核对。
  const started = Date.now();
  const url = "https://modelscope.cn/api/v1/models/" + EXPECT.owner + "/" + EXPECT.repo + "/repo?Revision=master&FilePath=" + encodeURIComponent(EXPECT.manifestPath);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  steps.harnessSourceProbe = { url: redactUrl(url), host: hostOf(url), status: response.status, ms: Date.now() - started, bytes: Buffer.byteLength(text), json };
  check("P1", "harness 直连真实源 latest.json：version 0.01 + sha256 6929461…",
    response.status === 200 && !!json && json.version === EXPECT.version && json.sha256 === EXPECT.sha256,
    { version: EXPECT.version, sha256: EXPECT.sha256 },
    steps.harnessSourceProbe);
}

async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-update-real-"));
  const port = await freePort();
  steps.environment = { userDataDir, cdpPort: port, electronVersion };
  fs.copyFileSync(TRACE_PRELOAD_SRC, TRACE_PRELOAD);
  const env = { ...process.env, OPENARC_IDENTITY_ADMIN: "1", NODE_OPTIONS: "--require=" + TRACE_PRELOAD, OA_FETCH_TRACE_FILE: RAW_TRACE };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
  child.stdout.on("data", (chunk) => { stdoutTail = (stdoutTail + String(chunk)).slice(-8000); });
  child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-12000); });

  const ready = await waitFor(async () => { try { return (await fetch("http://127.0.0.1:" + port + "/json/version")).ok; } catch { return false; } }, 60000, 300);
  if (!ready) throw new Error("CDP 未就绪（electron 退出码 " + child.exitCode + "）：" + stderrTail.slice(-1200));
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
  const context = browser.contexts()[0];
  const isUI = (candidate) => /[\/]dist[\/](vue|index)\.html/.test(candidate.url());
  await waitFor(() => !!context.pages().find(isUI), 45000, 300);
  page = context.pages().find(isUI) || null;
  if (!page) throw new Error("未找到界面页面：" + JSON.stringify(context.pages().map((item) => item.url())));

  page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({ url: String((message.location() || {}).url || "").slice(0, 160), text: message.text().slice(0, 400) });
  });
  page.on("pageerror", (error) => pageErrors.push(String((error && error.message) || error).slice(0, 400)));

  cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await cdp.send("Network.enable");
  attachNetwork(cdp);
  return port;
}

async function login() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gateState()), 60000);
  const initialized = await bridge("identity", "identity/initialize", ADMIN);
  const loggedIn = await bridge("identity", "identity/login", { identifier: ADMIN.identifier, password: ADMIN.password });
  const ready = await waitFor(async () => (await gateState()) === "ready", 60000);
  steps.login = { initialized: initialized.result, loggedIn: loggedIn.result, gate: await gateState() };
  check("A0", "真实 electron . 启动 + 隔离 userData + 登录后 gate=ready",
    ready && initialized.result && initialized.result.ok === true && loggedIn.result && loggedIn.result.ok === true,
    "identity/initialize ok + identity/login ok + gate=ready",
    { initOk: initialized.result && initialized.result.ok, loginOk: loggedIn.result && loggedIn.result.ok, gate: await gateState() });
  await waitFor(async () => (await js("return !!(window.openarc && Object.keys(window.openarc).length > 0)")), 30000);
}

async function main() {
  fs.rmSync(ART, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(RAW_TRACE, { force: true });

  await preflight();
  await launch();
  await login();

  /* 1 检查更新（默认源 = ModelScope） --------------------------------------- */
  const status0 = await market("market/update/status", { appId: "canvas" });
  steps.statusBefore = status0;
  const s0 = status0.result && status0.result.ok === true ? status0.result.value : null;
  check("B1", "status（未检查）：默认源 modelscope-repo bllack/OpenArc-OS、current=null、builtin=0.1.0、latest=null、updateAvailable=false、canRollback=false、loadable=true",
    !!s0 && s0.source && s0.source.kind === "modelscope-repo" && s0.source.owner === EXPECT.owner && s0.source.repo === EXPECT.repo
      && s0.current === null && s0.builtinVersion === EXPECT.builtinVersion && s0.latest === null
      && s0.updateAvailable === false && s0.canRollback === false && s0.loadable === true && s0.packageKind === "static-web",
    { kind: "modelscope-repo", owner: EXPECT.owner, repo: EXPECT.repo, current: null, builtinVersion: "0.1.0", latest: null, updateAvailable: false, canRollback: false, loadable: true },
    s0);

  const sources = await market("market/update/sources", { appId: "canvas" });
  steps.sources = sources;
  const sourceValue = sources.result && sources.result.ok === true ? sources.result.value : null;
  const modelscopeDescriptor = sourceValue && Array.isArray(sourceValue.sources) ? sourceValue.sources.find((item) => item.kind === "modelscope-repo") : null;
  check("B2", "sources：manifestPath=updates/canvas/latest.json、ModelScope 源白名单只有 modelscope.cn / cdn-lfs-cn-1.modelscope.cn（顶层 allowedHosts 是全部源并集，如实记录）",
    !!sourceValue && sourceValue.kind === "modelscope-repo" && sourceValue.owner === EXPECT.owner && sourceValue.repo === EXPECT.repo
      && sourceValue.manifestPath === EXPECT.manifestPath
      && !!modelscopeDescriptor && Array.isArray(modelscopeDescriptor.allowedHosts) && modelscopeDescriptor.allowedHosts.length === 2
      && modelscopeDescriptor.allowedHosts.every((host) => MODELSCOPE_HOSTS.has(host)),
    "modelscope-repo/bllack/OpenArc-OS + updates/canvas/latest.json + ModelScope 源 2 个白名单主机",
    { kind: sourceValue && sourceValue.kind, owner: sourceValue && sourceValue.owner, repo: sourceValue && sourceValue.repo, manifestPath: sourceValue && sourceValue.manifestPath, topLevelAllowedHosts: sourceValue && sourceValue.allowedHosts, modelscopeAllowedHosts: modelscopeDescriptor && modelscopeDescriptor.allowedHosts });

  const checkMark = traceMark();
  const check1 = await market("market/update/check", { appId: "canvas" });
  const checkTrace = summarizeTrace(traceSince(checkMark));
  steps.check = { response: check1, trace: checkTrace, hosts: hostsOf(checkTrace), ms: check1.ms };
  const c1 = check1.result && check1.result.ok === true ? check1.result.value : null;
  const bodyEntries = checkTrace
    .filter((item) => item.kind === "body" && item.text)
    .map((item) => { try { return { record: item, json: JSON.parse(item.text) }; } catch { return null; } })
    .filter(Boolean);
  const latestJsonEntry = bodyEntries.find((entry) => entry.json && entry.json.sha256 === EXPECT.sha256 && entry.json.version === EXPECT.version) || null;
  const latestJson = latestJsonEntry ? latestJsonEntry.json : null;
  const latestJsonBody = latestJsonEntry ? latestJsonEntry.record : null;
  check("C1", "check 真实命中 updates/canvas/latest.json：version=0.01、sha256=6929461…（清单原文由主进程下载，trace 留存）",
    !!latestJson && latestJson.version === EXPECT.version && latestJson.sha256 === EXPECT.sha256 && latestJson.asset === "updates/canvas/canvas-0.01.zip",
    { version: EXPECT.version, sha256: EXPECT.sha256, asset: "updates/canvas/canvas-0.01.zip" },
    { latestJson, bodySha256: latestJsonBody && latestJsonBody.sha256, bodyBytes: latestJsonBody && latestJsonBody.bytes });
  check("C2", "check 回包：latest.version=0.01、updateAvailable=false（0.01 ≡ 0.1.0 内置）、current=null、canRollback=false、checkedAt 有值",
    !!c1 && c1.latest && c1.latest.version === EXPECT.version && c1.updateAvailable === false
      && c1.current === null && c1.canRollback === false && Number.isFinite(c1.checkedAt) && c1.checkedAt > 0
      && c1.builtinVersion === EXPECT.builtinVersion && c1.source.kind === "modelscope-repo",
    { latestVersion: "0.01", updateAvailable: false, current: null, canRollback: false, builtinVersion: "0.1.0" },
    c1);
  const checkHosts = hostsOf(checkTrace);
  check("C3", "check 只访问白名单主机（modelscope.cn / cdn-lfs-cn-1.modelscope.cn），且全部 HTTPS 2xx",
    checkHosts.length > 0 && checkHosts.every((host) => MODELSCOPE_HOSTS.has(host)) && checkTrace.filter((item) => item.kind === "fetch").every((item) => item.status >= 200 && item.status < 300),
    "主机 ⊆ [modelscope.cn, cdn-lfs-cn-1.modelscope.cn] + 全部 2xx",
    { hosts: checkHosts, requests: checkTrace.filter((item) => item.kind === "fetch").map((item) => ({ host: item.host, status: item.status, ms: item.ms, url: item.url })) });
  check("C4", "check 真实耗时已记录（桥调用 ms > 0，逐请求 ms 齐全）",
    check1.ms > 0 && checkTrace.filter((item) => item.kind === "fetch").every((item) => Number.isFinite(item.ms) && item.ms >= 0),
    "ms>0",
    { bridgeMs: check1.ms, requests: checkTrace.filter((item) => item.kind === "fetch").map((item) => ({ host: item.host, ms: item.ms })) });

  /* 2 真实安装 0.01 -------------------------------------------------------- */
  const installMark = traceMark();
  const install = await market("market/update/install", { appId: "canvas", version: EXPECT.version, confirm: true });
  const installTrace = summarizeTrace(traceSince(installMark));
  steps.install = { response: install, trace: installTrace, hosts: hostsOf(installTrace), ms: install.ms };
  const installed = install.result && install.result.ok === true ? install.result.value : null;
  check("D1", "install 成功：installed.version=0.01、kind=static-web、entry=static/canvas-list.html、previous=null",
    !!installed && installed.installed && installed.installed.version === EXPECT.version
      && installed.installed.kind === "static-web" && installed.installed.entry === "static/canvas-list.html"
      && installed.previous === null && typeof installed.installed.digest === "string",
    { version: "0.01", kind: "static-web", entry: "static/canvas-list.html", previous: null },
    installed);

  const assetFetch = installTrace.filter((item) => item.kind === "fetch" && item.locationHost === "cdn-lfs-cn-1.modelscope.cn");
  const assetBody = installTrace.filter((item) => item.kind === "body" && item.host === "cdn-lfs-cn-1.modelscope.cn").pop();
  check("D2", "install 真实下载走通：modelscope.cn 302 -> cdn-lfs-cn-1.modelscope.cn 200，落盘字节 6437523 且 sha256=6929461…",
    assetFetch.length >= 1 && !!assetBody && assetBody.bytes === EXPECT.zipBytes && assetBody.sha256 === EXPECT.sha256,
    { redirectTo: "cdn-lfs-cn-1.modelscope.cn", bytes: EXPECT.zipBytes, sha256: EXPECT.sha256 },
    { assetFetch, assetBody });
  const installHosts = hostsOf(installTrace);
  check("D3", "install 只访问白名单主机（逐跳校验重定向），全程 HTTPS",
    installHosts.length > 0 && installHosts.every((host) => MODELSCOPE_HOSTS.has(host))
      && installTrace.filter((item) => item.kind === "fetch").every((item) => String(item.url).startsWith("https://")),
    "主机 ⊆ [modelscope.cn, cdn-lfs-cn-1.modelscope.cn]",
    { hosts: installHosts, requests: installTrace.filter((item) => item.kind === "fetch").map((item) => ({ host: item.host, status: item.status, locationHost: item.locationHost, ms: item.ms })) });

  const stateDir = path.join(userDataDir, "dxos", "apps", "canvas");
  const currentFile = path.join(stateDir, "current.json");
  const historyFile = path.join(stateDir, "history.json");
  const checkFile = path.join(stateDir, "check.json");
  const current = readJson(currentFile);
  const history = readJson(historyFile);
  const checkState = readJson(checkFile);
  steps.installedState = {
    stateDir,
    current: { exists: fs.existsSync(currentFile), value: current },
    history,
    check: checkState,
    dirs: fs.existsSync(stateDir) ? fs.readdirSync(stateDir).sort() : [],
  };
  const packageVerify = verifyInstalledPackage(stateDir, EXPECT.version);
  steps.packageVerify = {
    dir: packageVerify.dir,
    ok: packageVerify.ok,
    signatureOk: packageVerify.signatureOk,
    signatureReason: packageVerify.signatureReason,
    manifest: packageVerify.manifest,
    fileCount: packageVerify.fileCount,
    totalBytes: packageVerify.totalBytes,
    mismatches: packageVerify.mismatches.slice(0, 20),
    unsafeNames: packageVerify.unsafeNames.slice(0, 20),
    digest: packageVerify.digest,
    entryExists: packageVerify.entryExists,
    normalized: packageVerify.normalized,
  };
  check("D4", "current.json = 0.01（原子写入），digest = manifest.json 原始字节 sha256",
    !!current && current.version === EXPECT.version && typeof current.digest === "string" && current.digest === packageVerify.digest
      && current.kind === "static-web" && current.entry === "static/canvas-list.html" && Number.isFinite(current.installedAt),
    { version: "0.01", digest: "<sha256(manifest.json)>", kind: "static-web", entry: "static/canvas-list.html" },
    current);
  check("D5", "安装目录整包独立复核：仓库公钥验签 OK + 69 个文件逐文件 sha256 全命中 + 无目录穿越条目 + entry 落盘",
    packageVerify.ok === true && packageVerify.fileCount === 69 && packageVerify.mismatches.length === 0 && packageVerify.unsafeNames.length === 0
      && packageVerify.manifest && packageVerify.manifest.id === "canvas" && packageVerify.manifest.version === EXPECT.version,
    { signatureOk: true, files: 69, mismatches: 0, unsafeNames: 0, entryExists: true },
    { signatureOk: packageVerify.signatureOk, signatureReason: packageVerify.signatureReason, fileCount: packageVerify.fileCount, totalBytes: packageVerify.totalBytes, mismatches: packageVerify.mismatches.slice(0, 5), unsafeNames: packageVerify.unsafeNames.slice(0, 5), manifest: packageVerify.manifest, entryExists: packageVerify.entryExists, normalized: packageVerify.normalized });
  const strayStaging = steps.installedState.dirs.filter((name) => name.startsWith(".staging-"));
  check("D6", "原子切换无残留：没有 .staging-* 目录，history.json=[0.01]，check.json 有 latest=0.01",
    strayStaging.length === 0 && !!history && Array.isArray(history.versions) && history.versions.length === 1 && history.versions[0] === EXPECT.version
      && !!checkState && checkState.latest && checkState.latest.version === EXPECT.version,
    { staging: [], history: ["0.01"], checkLatest: "0.01" },
    { staging: strayStaging, history, checkLatest: checkState && checkState.latest });
  const compareToBuiltin = domain.compareSemver(EXPECT.version, EXPECT.builtinVersion);
  check("D7", "版本语义：compareSemver(0.01, 0.1.0) === 0（0.01 ≡ 0.1.0，所以 updateAvailable 必为 false —— 预期行为）",
    compareToBuiltin === 0,
    "0",
    { compareSemver: compareToBuiltin, version: EXPECT.version, builtin: EXPECT.builtinVersion });

  /* 画布可用性（安装后） --------------------------------------------------- */
  await sleep(400);
  const passInstalled = await canvasPass("after-install");
  steps.canvasAfterInstall = passInstalled;
  check("E1", "安装后隔离 profile 打开画布首页（static/canvas-list.html）：iframe 由 openarc-canvas:// 服务、入口按钮在、无错误页",
    passInstalled.opened === true && passInstalled.listUp === true && !!passInstalled.list && ["interactive", "complete"].includes(passInstalled.list.ready)
      && passInstalled.list.start === true && passInstalled.list.errorDoc === false,
    "canvas-list.html ready(interactive/complete) + #btnStartCreate + 非错误页",
    { ...passInstalled.list, readyComplete: passInstalled.readyComplete });
  check("E2", "画布首页实际由已安装包提供：x-openarc-canvas-source=installed、x-openarc-canvas-version=0.01",
    !!passInstalled.served && passInstalled.served.status === 200 && passInstalled.served.source === "installed" && passInstalled.served.version === EXPECT.version,
    { status: 200, source: "installed", version: "0.01" },
    passInstalled.served);
  check("E3", "智能画布打开一次（smart-canvas.html）：桥 + 守卫就绪，有 canvasId",
    passInstalled.smartUp === true && passInstalled.smartReady === true && !!passInstalled.smart && passInstalled.smart.bridge === "object"
      && passInstalled.smart.guard === "object" && !!passInstalled.smart.canvasId,
    "smart-canvas.html + __openarcBridge + __openarcSmartGuard + canvasId",
    passInstalled.smart);
  check("E4", "智能画布返回列表页（.smart-back）走通",
    passInstalled.back === "clicked" && passInstalled.backToList === true,
    "回到 canvas-list.html",
    { back: passInstalled.back, backToList: passInstalled.backToList });
  check("E5", "安装后画布两页：0 console error / 0 pageerror / 0 条 404 / 0 条 5xx",
    passInstalled.errorCounts && passInstalled.errorCounts.consoleErrors === 0 && passInstalled.errorCounts.pageErrors === 0
      && passInstalled.errorCounts.notFound === 0 && passInstalled.errorCounts.serverErrors === 0,
    { consoleErrors: 0, pageErrors: 0, notFound: 0, serverErrors: 0 },
    passInstalled.errorCounts);

  /* 3 真实回滚 ------------------------------------------------------------- */
  const rollbackMark = traceMark();
  const rollback = await market("market/update/rollback", { appId: "canvas" });
  steps.rollback = { response: rollback, trace: summarizeTrace(traceSince(rollbackMark)) };
  const rolled = rollback.result && rollback.result.ok === true ? rollback.result.value : null;
  const rollbackRaw = rollback.result;
  const isBuiltinPointer = (pointer) => !!pointer && pointer.mode === "builtin" && pointer.version === null;
  check("F1", "rollback 回退到内置版本：rolledBackTo=\"builtin\"、previous={version:\"0.01\"}",
    !!rolled && rolled.rolledBackTo === "builtin" && !!rolled.previous && rolled.previous.version === EXPECT.version,
    { rolledBackTo: "builtin", previous: { version: EXPECT.version } },
    rollbackRaw);
  const currentAfterRollback = readJson(currentFile);
  steps.currentAfterRollback = { exists: fs.existsSync(currentFile), value: currentAfterRollback };
  check("F2", "rollback 后 current.json 变成内置标记：mode=builtin、version=null、rolledBackFrom=0.01、builtinVersion=0.1.0",
    isBuiltinPointer(currentAfterRollback) && currentAfterRollback.rolledBackFrom === EXPECT.version
      && currentAfterRollback.builtinVersion === EXPECT.builtinVersion,
    { mode: "builtin", version: null, rolledBackFrom: EXPECT.version, builtinVersion: EXPECT.builtinVersion },
    { exists: fs.existsSync(currentFile), value: currentAfterRollback });

  const statusAfterRollback = await market("market/update/status", { appId: "canvas" });
  steps.statusAfterRollback = statusAfterRollback;
  const sr = statusAfterRollback.result && statusAfterRollback.result.ok === true ? statusAfterRollback.result.value : null;
  const pointerAfterRollback = readJson(currentFile);
  const consistentWithDisk = isBuiltinPointer(pointerAfterRollback)
    ? !!sr && sr.current === null && sr.rollbackTarget === null
    : pointerAfterRollback === null
      ? !!sr && sr.current === null
      : !!sr && !!sr.current && sr.current.version === pointerAfterRollback.version;
  check("F3", "回滚后 status 如实：latest=0.01、updateAvailable=false、canRollback=false、rollbackTarget=null，current 与磁盘指针一致（内置标记 → current=null）",
    !!sr && sr.latest && sr.latest.version === EXPECT.version && sr.updateAvailable === false && sr.canRollback === false && consistentWithDisk,
    { latest: "0.01", updateAvailable: false, canRollback: false, rollbackTarget: null, current: null },
    { status: sr, pointer: pointerAfterRollback });

  /* 回滚后（无论成功或如实失败）画布必须仍可用：整页重载 -> 首页 + 智能画布 */
  const passAfterRollback = await (async () => {
    await reloadRenderer();
    return canvasPass("after-rollback");
  })();
  steps.canvasAfterRollback = passAfterRollback;
  const pointerNow = readJson(currentFile);
  const builtinNow = isBuiltinPointer(pointerNow);
  const expectedSource = !builtinNow && pointerNow && pointerNow.version === EXPECT.version ? "installed" : "dist";
  check("F4", "回滚后重载，画布仍能打开（首页 + 智能画布）：来源从 installed 变为 " + expectedSource + (builtinNow ? "、fallback=pointer-cleared、无已安装版本号" : ""),
    passAfterRollback.opened === true && passAfterRollback.listUp === true && passAfterRollback.smartUp === true
      && passAfterRollback.smartReady === true && passAfterRollback.backToList === true
      && !!passAfterRollback.served && passAfterRollback.served.status === 200 && passAfterRollback.served.source === expectedSource
      && (!builtinNow || (passAfterRollback.served.fallback === "pointer-cleared" && !passAfterRollback.served.version)),
    { source: expectedSource, fallback: builtinNow ? "pointer-cleared" : null, version: null, list: true, smart: true, backToList: true },
    { served: passAfterRollback.served, list: passAfterRollback.list, smart: passAfterRollback.smart });
  check("F5", "回滚后画布两页：0 console error / 0 pageerror / 0 条 404 / 0 条 5xx",
    passAfterRollback.errorCounts && passAfterRollback.errorCounts.consoleErrors === 0 && passAfterRollback.errorCounts.pageErrors === 0
      && passAfterRollback.errorCounts.notFound === 0 && passAfterRollback.errorCounts.serverErrors === 0,
    { consoleErrors: 0, pageErrors: 0, notFound: 0, serverErrors: 0 },
    passAfterRollback.errorCounts);

  /* 4 再检查一次（回滚后 status 如实） ------------------------------------- */
  const check2Mark = traceMark();
  const check2Start = Date.now();
  const check2 = await market("market/update/check", { appId: "canvas" });
  const check2Trace = summarizeTrace(traceSince(check2Mark));
  steps.checkAfterRollback = { response: check2, trace: check2Trace, hosts: hostsOf(check2Trace), ms: Date.now() - check2Start };
  const c2 = check2.result && check2.result.ok === true ? check2.result.value : null;
  const pointerFinal = readJson(currentFile);
  const currentText = isBuiltinPointer(pointerFinal) ? "builtin" : (pointerFinal ? pointerFinal.version : null);
  const consistentFinal = isBuiltinPointer(pointerFinal)
    ? !!c2 && c2.current === null && c2.rollbackTarget === null
    : pointerFinal === null
      ? !!c2 && c2.current === null
      : !!c2 && !!c2.current && c2.current.version === pointerFinal.version;
  check("G1", "回滚后再检查：latest=0.01、updateAvailable=false、canRollback=false、rollbackTarget=null、current 与磁盘指针一致（" + String(currentText) + "）",
    !!c2 && c2.latest && c2.latest.version === EXPECT.version && c2.updateAvailable === false && c2.canRollback === false && consistentFinal,
    { latest: "0.01", updateAvailable: false, canRollback: false, rollbackTarget: null, current: currentText },
    { status: c2, pointer: pointerFinal });
  check("G2", "回滚后检查仍只访问白名单主机",
    hostsOf(check2Trace).length > 0 && hostsOf(check2Trace).every((host) => MODELSCOPE_HOSTS.has(host)),
    "主机 ⊆ [modelscope.cn, cdn-lfs-cn-1.modelscope.cn]",
    hostsOf(check2Trace));

  /* 5 应用商店 -> 无限画布 -> 更新面板（浅/深） --------------------------- */
  await reloadRenderer();
  const windowLabels = () => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll("section.window"), (win) => win.getAttribute("aria-label")));
  await clickMain('[data-dock-id="home"]');
  await waitFor(async () => !!(await page.$('[data-app-card="market"]')), 20000);
  await clickMain('[data-app-card="market"]');
  const marketUp = await waitFor(async () => !!(await page.$('[data-canvas-update-open]')), 25000);
  await clickMain('[data-canvas-update-open]');
  const panelUp = await waitFor(async () => !!(await page.$('[data-canvas-update]')), 20000);
  await waitPanelIdle();
  const panelInitial = await panelSnapshot();
  steps.updatePanel = { marketUp, panelUp, panelInitial, windowsWhenPanelOpen: await windowLabels() };

  // 先截图：此刻面板已按本机记录显示「已是最新」（第 4 步真实检查的结果）。
  await setTheme("light");
  await closeControlCenter();
  await sleep(350);
  const lightShot = await screenshot("market-canvas-update-light");
  await setTheme("dark");
  await closeControlCenter();
  await sleep(350);
  const darkShot = await screenshot("market-canvas-update-dark");
  await setTheme("light");
  await closeControlCenter();
  await sleep(250);
  const panelAfterShots = await panelSnapshot();
  steps.shots = { light: lightShot, dark: darkShot };

  // 再点一次「检查更新」：真实联网刷新；逐秒记录面板/窗口状态，便于解释任何界面变化。
  const checkedAtBefore = panelInitial ? String(panelInitial.checkedAt) : null;
  const uiCheckMark = traceMark();
  const uiCheckStart = Date.now();
  let sawCheckBusy = false;
  const diagnostics = [];
  await clickMain('[data-canvas-update-check]');
  const refreshed = await waitFor(async () => {
    const snapshot = await page.evaluate(() => {
      const el = document.querySelector("[data-canvas-update]");
      const panel = el ? {
        busy: el.getAttribute("data-canvas-update-busy"),
        checkedAt: el.getAttribute("data-canvas-update-checked-at"),
        state: el.getAttribute("data-canvas-update-state"),
        errorCode: el.querySelector("[data-canvas-update-error-code]") ? el.querySelector("[data-canvas-update-error-code]").getAttribute("data-canvas-update-error-code") : null,
      } : null;
      const nav = performance.getEntriesByType ? performance.getEntriesByType("navigation")[0] : null;
      return {
        panel,
        windows: Array.prototype.map.call(document.querySelectorAll("section.window"), (win) => win.getAttribute("aria-label")),
        navType: nav ? nav.type : null,
      };
    });
    if (snapshot.panel && snapshot.panel.busy === "check") sawCheckBusy = true;
    diagnostics.push({
      t: Date.now() - uiCheckStart,
      panel: !!snapshot.panel,
      busy: snapshot.panel ? snapshot.panel.busy : null,
      checkedAt: snapshot.panel ? snapshot.panel.checkedAt : null,
      state: snapshot.panel ? snapshot.panel.state : null,
      windows: snapshot.windows,
      navType: snapshot.navType,
    });
    if (!snapshot.panel) return false;
    if (snapshot.panel.errorCode) return true;
    return (sawCheckBusy || String(snapshot.panel.checkedAt) !== checkedAtBefore) && snapshot.panel.busy === "idle";
  }, 30000, 800);
  const uiCheckTrace = summarizeTrace(traceSince(uiCheckMark));
  const panelAfter = await panelSnapshot();
  steps.updatePanel.uiCheck = {
    refreshed,
    sawCheckBusy,
    uiCheckMs: Date.now() - uiCheckStart,
    uiCheckTrace,
    uiCheckHosts: hostsOf(uiCheckTrace),
    panelAfter,
    diagnostics,
  };
  steps.updatePanel.panelAfterShots = panelAfterShots;
  const panelShown = panelAfterShots || panelInitial || panelAfter;
  steps.updatePanel.panelShown = panelShown;

  check("H1", "应用商店 -> 无限画布 -> 更新面板打开（在线更新入口）；打开时窗口：" + JSON.stringify(steps.updatePanel.windowsWhenPanelOpen),
    marketUp === true && panelUp === true && !!panelInitial,
    "面板存在（[data-canvas-update]）",
    { marketUp, panelUp, windows: steps.updatePanel.windowsWhenPanelOpen });
  check("H2", "面板点「检查更新」触发真实联网（请求全在 modelscope.cn），面板自身无错误",
    refreshed === true && !!panelAfter && !panelAfter.errorCode
      && hostsOf(uiCheckTrace).length > 0 && hostsOf(uiCheckTrace).every((host) => MODELSCOPE_HOSTS.has(host)),
    { hosts: "[modelscope.cn, cdn-lfs-cn-1.modelscope.cn]", errorCode: null },
    { hosts: hostsOf(uiCheckTrace), errorCode: panelAfter && panelAfter.errorCode, uiCheckMs: Date.now() - uiCheckStart, sawCheckBusy });
  check("H3", "截图时面板显示已是最新（state=latest、badge=已是最新、latest=0.01、available=false、current=" + String(panelShown && panelShown.current) + "、builtin=0.1.0）",
    !!panelShown && panelShown.state === "latest" && panelShown.badge === "已是最新" && panelShown.latest === EXPECT.version
      && panelShown.available === "false" && panelShown.builtin === EXPECT.builtinVersion
      && String(panelShown.title || "").indexOf("已是最新版本 " + EXPECT.version) >= 0 && panelShown.source === "modelscope-repo",
    { state: "latest", badge: "已是最新", latest: "0.01", available: "false", builtin: "0.1.0" },
    { state: panelShown && panelShown.state, badge: panelShown && panelShown.badge, title: panelShown && panelShown.title, latest: panelShown && panelShown.latest, available: panelShown && panelShown.available, current: panelShown && panelShown.current, builtin: panelShown && panelShown.builtin, source: panelShown && panelShown.source });
  check("H4", "面板如实反映回滚不可用：can-rollback=false、回滚按钮 disabled、无安装按钮（无可用更新）",
    !!panelShown && panelShown.canRollback === "false" && panelShown.rollbackDisabled === true && panelShown.installButton === false,
    { canRollback: "false", rollbackDisabled: true, installButton: false },
    { canRollback: panelShown && panelShown.canRollback, rollbackDisabled: panelShown && panelShown.rollbackDisabled, installButton: panelShown && panelShown.installButton });

  /* 全场网络与错误汇总 ----------------------------------------------------- */
  const allTrace = summarizeTrace(traceSince(0));
  const allHosts = hostsOf(allTrace);
  report.trace = {
    note: "原始 trace 含 ModelScope LFS 签名参数，已脱敏（auth_key 等查询参数移除）；逐请求记录见下。",
    hosts: allHosts,
    requests: allTrace,
  };
  steps.networkProbeUsage = { hosts: allHosts, requestCount: allTrace.filter((item) => item.kind === "fetch").length };
  const notFound = netFailures.filter((item) => item.status === 404);
  const serverErrors = netFailures.filter((item) => item.status >= 500);
  steps.errors = { consoleErrors, pageErrors, netFailures, notFound, serverErrors };
  check("I1", "全场 0 console error", consoleErrors.length === 0, 0, consoleErrors.slice(0, 10));
  check("I2", "全场 0 pageerror", pageErrors.length === 0, 0, pageErrors.slice(0, 10));
  check("I3", "全场 0 条 HTTP 404", notFound.length === 0, 0, notFound.slice(0, 10));
  check("I4", "全场 0 条 HTTP 5xx", serverErrors.length === 0, 0, serverErrors.slice(0, 10));
  check("I5", "所有真实出网主机都在白名单内（含重定向落点）",
    allHosts.length > 0 && allHosts.every((host) => MODELSCOPE_HOSTS.has(host)),
    [...MODELSCOPE_HOSTS],
    allHosts);

  steps.productTree = {
    "electron/main.cjs": statOf(path.join(ROOT, "electron/main.cjs")),
    "electron/preload.cjs": statOf(path.join(ROOT, "electron/preload.cjs")),
    "resources/app-update-keys.json": statOf(path.join(ROOT, "resources/app-update-keys.json")),
    "dist/vue.html": statOf(path.join(ROOT, "dist/vue.html")),
  };

  report.rollbackOutcome = rolled ? { ok: true, value: rolled } : { ok: false, raw: rollbackRaw };
  report.passed = checks.filter((row) => row.ok).length;
  report.failed = checks.filter((row) => !row.ok).length;
}

function writeReport(fatal) {
  report.failure = fatal;
  report.checks = checks;
  report.steps = steps;
  report.passed = checks.filter((row) => row.ok).length;
  report.failed = checks.filter((row) => !row.ok).length;
  report.finishedAt = new Date().toISOString();
  report.process = { stderrTail: stderrTail.slice(-4000), stdoutTail: stdoutTail.slice(-2000) };
  try {
    fs.mkdirSync(ART, { recursive: true });
    const raw = traceSince(0);
    const redacted = raw.map((record) => ({ ...record, url: redactUrl(record.url), location: record.location ? redactUrl(record.location) : null }));
    fs.writeFileSync(path.join(ART, "fetch-trace.jsonl"), redacted.map((record) => JSON.stringify(record)).join("\n") + "\n");
    fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2) + "\n");
    const lines = [];
    lines.push("# dxos-update-real-source · 真机端到端验收", "");
    lines.push("- 时间：" + report.at + " -> " + report.finishedAt);
    lines.push("- Electron " + report.electronVersion + " · CDP " + (steps.environment && steps.environment.cdpPort) + " · 隔离 userData：" + (steps.environment && steps.environment.userDataDir));
    lines.push("- 真实源：ModelScope " + EXPECT.owner + "/" + EXPECT.repo + " · " + EXPECT.manifestPath);
    lines.push("- 结论：" + (report.failed === 0 ? "全部通过" : report.failed + " 项未通过") + "（通过 " + report.passed + "）", "");
    lines.push("## 检查项", "", "| ID | 结果 | 项 | 期望 | 实际 |", "| --- | --- | --- | --- | --- |");
    for (const row of checks) lines.push("| " + row.id + " | " + (row.ok ? "PASS" : "FAIL") + " | " + row.name.replace(/\|/g, "\\|") + " | " + String(row.expected).replace(/\|/g, "\\|").slice(0, 200) + " | " + String(row.actual).replace(/\|/g, "\\|").slice(0, 300) + " |");
    lines.push("", "## 真实出网主机", "", (report.trace.hosts || []).map((host) => "- " + host).join("\n"));
    if (fatal) lines.push("", "## 致命失败", "", "~~~", String(fatal.message || fatal), "~~~");
    fs.writeFileSync(path.join(ART, "RESULT.md"), lines.join("\n") + "\n");
  } catch (error) {
    console.error("写报告失败：" + String((error && error.message) || error));
  }
}

async function cleanup() {
  try { if (browser) await browser.close(); } catch { /* 忽略 */ }
  try {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await waitFor(() => child.exitCode !== null, 8000, 200);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  } catch { /* 忽略 */ }
  try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(TRACE_PRELOAD, { force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(RAW_TRACE, { force: true }); } catch { /* 忽略 */ }
}

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = { message: String((error && error.message) || error), stack: String((error && error.stack) || "").slice(0, 4000) };
  console.error("FAIL [Z0] harness 异常：" + fatal.message);
  checks.push({ id: "Z0", name: "harness 无异常完成", ok: false, expected: "无异常", actual: fatal.message });
} finally {
  writeReport(fatal);
  await cleanup();
}

const failed = checks.filter((row) => !row.ok);
console.log("\n========== 汇总 ==========");
console.log("通过 " + (checks.length - failed.length) + " / 失败 " + failed.length);
for (const row of failed) console.log("  FAIL [" + row.id + "] " + row.name + " :: " + row.actual.slice(0, 300));
console.log("报告：" + path.join(ART, "report.json"));
console.log("截图：" + SHOTS);
if (fatal || failed.length) process.exitCode = 1;
