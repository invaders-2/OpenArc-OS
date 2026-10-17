#!/usr/bin/env node
/**
 * dxos-update-rollback-builtin · 真机端到端验收（真实 Electron + 真实 ModelScope 源 + 隔离 userData）。
 *
 * 验收目标（2026-10 可靠性缺口）：装了一个有问题的包之后，用户必须能退回内置版本。
 *   1 默认源 ModelScope：check -> latest 0.01（内置 0.1.0，语义等价 -> updateAvailable=false）。
 *   2 真实 install 0.01（6,437,523 B）：仓库公钥验签 -> 逐文件 sha256 -> 原子切换；
 *     画布由已安装包服务（x-openarc-canvas-source=installed）。
 *   3 更新面板：只装过一个版本时，回滚入口必须显示「回退到内置版本 0.1.0」并且可点（不是灰掉）。
 *   4 面板里真实点「回退到内置版本」-> 二次确认 -> 确认：断言 current 指针变成内置标记、
 *     已安装版本目录与 history 保留、status 如实（current=null / canRollback=false / latest 仍在）。
 *   5 重载后画布必须由内置 bundle 服务（x-openarc-canvas-source != installed，fallback=pointer-cleared），
 *     首页 + 智能画布都能打开，0 console error / 0 pageerror / 0 条 404 / 0 条 5xx。
 *   6 再 install 一次 0.01 仍然成功（可再切回），再回退一次仍然成功（可重复执行），
 *     第三次回退是幂等 no-op（previous=null）。
 *
 * 网络取证：NODE_OPTIONS=--require=... 注入只读 fetch 追踪（fetch-trace-preload.cjs），
 * 记录每笔请求的主机 / 状态 / 重定向 / 耗时与被完整读出的响应体 sha256；artifacts 只放脱敏副本。
 *
 * 用法：node experiments/dxos-update-rollback-builtin/run.mjs
 * 输出：artifacts/dxos-update-rollback-builtin/{report.json,RESULT.md,fetch-trace.jsonl,shots/*}
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
const ART = path.join(ROOT, "artifacts", "dxos-update-rollback-builtin");
const SHOTS = path.join(ART, "shots");
const RAW_TRACE = path.join(os.tmpdir(), "oa-builtin-rollback-trace-raw-" + process.pid + ".jsonl");
const TRACE_PRELOAD_SRC = path.join(HERE, "fetch-trace-preload.cjs");
const TRACE_PRELOAD = path.join(os.tmpdir(), "oa-builtin-rollback-trace-preload-" + process.pid + ".cjs");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const ADMIN = { identifier: "builtin-rollback@openarc.test", password: "BuiltinRollback-pass-1", displayName: "回退验收管理员" };
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

const checks = [];
function check(id, name, ok, expected, actual) {
  const row = { id, name, ok: !!ok, expected: typeof expected === "string" ? expected : JSON.stringify(expected), actual: typeof actual === "string" ? actual.slice(0, 2400) : JSON.stringify(actual).slice(0, 2400) };
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
    bytes: record.bytes == null ? null : record.bytes,
    sha256: record.sha256 || null,
    text: record.text ? record.text.slice(0, 4096) : null,
    ms: record.ms == null ? null : record.ms,
    error: record.error || null,
  }));
}
function hostsOf(trace) { return [...new Set(trace.filter((item) => item.host).map((item) => item.host))].sort(); }

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
    const request = (arg.channel === "identity" || arg.channel === "resource") ? Object.assign({ type: arg.command }, arg.payload) : { command: arg.command, payload: arg.payload || {} };
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
  if (!(await page.$(".control-center"))) { await clickMain('button[aria-label="控制中心"]'); await sleep(400); }
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
  await sleep(450);
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

/** 打开画布首页 + 智能画布各一次；返回服务来源、DOM 事实与截图。 */
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

/** 面板取证快照：属性 + 文案 + 按钮状态（回退入口的可点性靠这里）。 */
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
      rollbackTarget: attr("data-canvas-update-rollback-target"),
      rollbackState: text("[data-canvas-update-rollback-state]"),
      source: attr("data-canvas-update-source"),
      sourceRepo: attr("data-canvas-update-source-repo"),
      checkedAt: attr("data-canvas-update-checked-at"),
      loadable: attr("data-canvas-update-loadable"),
      badge: text(".cu-state-row .ds-badge"),
      title: text("[data-canvas-update-title]"),
      detail: text(".cu-state .set-cap"),
      notice: text("[data-canvas-update-notice]"),
      rows,
      installButton: !!install,
      installDisabled: install ? !!install.disabled : null,
      rollbackButton: !!rollback,
      rollbackDisabled: rollback ? !!rollback.disabled : null,
      rollbackLabel: rollback ? String(rollback.textContent || "").trim() : null,
      errorCode: el.querySelector("[data-canvas-update-error-code]") ? el.querySelector("[data-canvas-update-error-code]").getAttribute("data-canvas-update-error-code") : null,
    };
  });
}
async function waitPanelIdle() {
  return waitFor(async () => { const snapshot = await panelSnapshot(); return !!snapshot && snapshot.busy === "idle"; }, 30000);
}
async function dialogSnapshot() {
  return page.evaluate(() => {
    const shade = document.querySelector(".dialog-shade");
    const dialog = document.querySelector(".dialog");
    const primary = document.querySelector("[data-canvas-update-confirm-primary]");
    return {
      open: !!shade,
      title: dialog ? String((dialog.querySelector(".dialog-heading strong") || {}).textContent || "").trim() : null,
      body: dialog ? String((dialog.querySelector(".dialog-body") || {}).textContent || "").trim() : null,
      primaryLabel: primary ? String(primary.textContent || "").trim() : null,
      primaryKind: primary ? primary.getAttribute("data-canvas-update-confirm-primary") : null,
    };
  });
}

/* 安装包落地后的独立复核（不依赖服务端自述） ---------------------------------- */
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
  for (const rel of ["electron/main.cjs", "electron/preload.cjs", "electron/market-update-service.cjs", "electron/canvas-package-resolver.cjs"]) {
    const result = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], { encoding: "utf8" });
    syntax[rel] = { status: result.status, stderr: (result.stderr || "").slice(0, 300) };
  }
  steps.preflightSyntax = syntax;
  steps.syntaxOk = Object.values(syntax).every((item) => item.status === 0);
  if (!steps.syntaxOk) throw new Error("产品文件语法检查失败（可能有并发编辑正在进行）：" + JSON.stringify(syntax));

  for (const file of [path.join(ROOT, "dist/vue.html"), path.join(ROOT, "electron/main.cjs"), path.join(ROOT, "resources/app-update-keys.json"), TRACE_PRELOAD_SRC]) {
    if (!fs.existsSync(file)) throw new Error("缺少必需文件：" + file);
  }
  const started = Date.now();
  const url = "https://modelscope.cn/api/v1/models/" + EXPECT.owner + "/" + EXPECT.repo + "/repo?Revision=master&FilePath=" + encodeURIComponent(EXPECT.manifestPath);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  steps.harnessSourceProbe = { url: redactUrl(url), host: hostOf(url), status: response.status, ms: Date.now() - started, bytes: Buffer.byteLength(text), json };
  check("P1", "harness 直连真实源 latest.json：version 0.01 + sha256 6929461…",
    response.status === 200 && !!json && json.version === EXPECT.version && json.sha256 === EXPECT.sha256,
    { version: EXPECT.version, sha256: EXPECT.sha256 }, steps.harnessSourceProbe);
}

async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-builtin-rollback-"));
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
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push({ url: String((message.location() || {}).url || "").slice(0, 160), text: message.text().slice(0, 400) }); });
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

async function openUpdatePanel() {
  await clickMain('[data-dock-id="home"]');
  await waitFor(async () => !!(await page.$('[data-app-card="market"]')), 20000);
  await clickMain('[data-app-card="market"]');
  const marketUp = await waitFor(async () => !!(await page.$('[data-canvas-update-open]')), 25000);
  await clickMain('[data-canvas-update-open]');
  const panelUp = await waitFor(async () => !!(await page.$('[data-canvas-update]')), 20000);
  await waitPanelIdle();
  return { marketUp, panelUp };
}

async function main() {
  fs.rmSync(ART, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(RAW_TRACE, { force: true });

  await preflight();
  await launch();
  await login();

  /* 1 状态与检查 ------------------------------------------------------------ */
  const status0 = await market("market/update/status", { appId: "canvas" });
  steps.statusBefore = status0;
  const s0 = status0.result && status0.result.ok === true ? status0.result.value : null;
  check("B1", "status（未检查）：current=null、builtin=0.1.0、rollbackTarget=null、canRollback=false、loadable=true",
    !!s0 && s0.current === null && s0.builtinVersion === EXPECT.builtinVersion && s0.rollbackTarget === null
      && s0.canRollback === false && s0.loadable === true && s0.source.kind === "modelscope-repo",
    { current: null, builtinVersion: "0.1.0", rollbackTarget: null, canRollback: false, loadable: true }, s0);

  const check1 = await market("market/update/check", { appId: "canvas" });
  steps.check = check1;
  const c1 = check1.result && check1.result.ok === true ? check1.result.value : null;
  check("B2", "check：latest=0.01、updateAvailable=false（0.01 ≡ 0.1.0）、current=null、rollbackTarget=null",
    !!c1 && !!c1.latest && c1.latest.version === EXPECT.version && c1.updateAvailable === false && c1.current === null && c1.rollbackTarget === null,
    { latest: "0.01", updateAvailable: false, current: null, rollbackTarget: null }, c1);

  /* 2 真实安装 0.01 --------------------------------------------------------- */
  const installMark = traceMark();
  const install = await market("market/update/install", { appId: "canvas", version: EXPECT.version, confirm: true });
  const installTrace = summarizeTrace(traceSince(installMark));
  steps.install = { response: install, trace: installTrace, hosts: hostsOf(installTrace), ms: install.ms };
  const installed = install.result && install.result.ok === true ? install.result.value : null;
  check("C1", "真实 install 0.01 成功：kind=static-web、entry=static/canvas-list.html、previous=null",
    !!installed && installed.installed && installed.installed.version === EXPECT.version
      && installed.installed.kind === "static-web" && installed.installed.entry === "static/canvas-list.html" && installed.previous === null,
    { version: "0.01", kind: "static-web", entry: "static/canvas-list.html", previous: null }, installed);

  const assetBody = installTrace.filter((item) => item.kind === "body" && item.host === "cdn-lfs-cn-1.modelscope.cn").pop();
  check("C2", "下载真实走通 ModelScope：落盘 6,437,523 B 且 sha256=6929461…",
    !!assetBody && assetBody.bytes === EXPECT.zipBytes && assetBody.sha256 === EXPECT.sha256,
    { bytes: EXPECT.zipBytes, sha256: EXPECT.sha256 }, assetBody);
  const installHosts = hostsOf(installTrace);
  check("C3", "install 只访问白名单主机（逐跳校验重定向）",
    installHosts.length > 0 && installHosts.every((host) => MODELSCOPE_HOSTS.has(host)),
    [...MODELSCOPE_HOSTS], installHosts);

  const stateDir = path.join(userDataDir, "dxos", "apps", "canvas");
  const currentFile = path.join(stateDir, "current.json");
  const historyFile = path.join(stateDir, "history.json");
  const packageVerify = verifyInstalledPackage(stateDir, EXPECT.version);
  steps.packageVerify = {
    dir: packageVerify.dir, ok: packageVerify.ok, signatureOk: packageVerify.signatureOk, manifest: packageVerify.manifest,
    fileCount: packageVerify.fileCount, totalBytes: packageVerify.totalBytes,
    mismatches: packageVerify.mismatches.slice(0, 20), unsafeNames: packageVerify.unsafeNames.slice(0, 20),
    digest: packageVerify.digest, entryExists: packageVerify.entryExists, normalized: packageVerify.normalized,
  };
  check("C4", "安装目录独立复核：仓库公钥验签 OK + 逐文件 sha256 全命中 + 无目录穿越 + entry 落盘",
    packageVerify.ok === true && packageVerify.fileCount === 69 && packageVerify.mismatches.length === 0
      && packageVerify.unsafeNames.length === 0 && packageVerify.entryExists === true,
    { signatureOk: true, files: 69, mismatches: 0, unsafeNames: 0, entryExists: true },
    { signatureOk: packageVerify.signatureOk, fileCount: packageVerify.fileCount, totalBytes: packageVerify.totalBytes, mismatches: packageVerify.mismatches.slice(0, 5), manifest: packageVerify.manifest });

  const statusInstalled = await market("market/update/status", { appId: "canvas" });
  steps.statusInstalled = statusInstalled;
  const si = statusInstalled.result && statusInstalled.result.ok === true ? statusInstalled.result.value : null;
  check("C5", "装完之后 status：current=0.01、canRollback=false（没有上一版）、rollbackTarget={kind:builtin,version:0.1.0}",
    !!si && !!si.current && si.current.version === EXPECT.version && si.canRollback === false
      && !!si.rollbackTarget && si.rollbackTarget.kind === "builtin" && si.rollbackTarget.version === EXPECT.builtinVersion,
    { current: "0.01", canRollback: false, rollbackTarget: { kind: "builtin", version: "0.1.0" } },
    { current: si && si.current, canRollback: si && si.canRollback, rollbackTarget: si && si.rollbackTarget });

  /* 3 安装后画布由已安装包服务 ---------------------------------------------- */
  await sleep(400);
  const passInstalled = await canvasPass("after-install");
  steps.canvasAfterInstall = passInstalled;
  check("D1", "安装后画布首页可打开（入口按钮在、非错误页），由已安装包服务：source=installed、version=0.01",
    passInstalled.opened === true && passInstalled.listUp === true && !!passInstalled.list && passInstalled.list.start === true
      && passInstalled.list.errorDoc === false && !!passInstalled.served && passInstalled.served.status === 200
      && passInstalled.served.source === "installed" && passInstalled.served.version === EXPECT.version,
    { source: "installed", version: "0.01", start: true },
    { served: passInstalled.served, list: passInstalled.list });
  check("D2", "安装后智能画布可打开并可返回列表页",
    passInstalled.smartUp === true && passInstalled.smartReady === true && passInstalled.backToList === true,
    { smartUp: true, smartReady: true, backToList: true },
    { smartUp: passInstalled.smartUp, smartReady: passInstalled.smartReady, backToList: passInstalled.backToList, smart: passInstalled.smart });
  check("D3", "安装后画布两页：0 console error / 0 pageerror / 0 条 404 / 0 条 5xx",
    !!passInstalled.errorCounts && passInstalled.errorCounts.consoleErrors === 0 && passInstalled.errorCounts.pageErrors === 0
      && passInstalled.errorCounts.notFound === 0 && passInstalled.errorCounts.serverErrors === 0,
    { consoleErrors: 0, pageErrors: 0, notFound: 0, serverErrors: 0 }, passInstalled.errorCounts);

  /* 4 更新面板：只装过一个版本 -> 回退到内置版本入口必须是可点的 ------------ */
  const opened = await openUpdatePanel();
  const panelInstalled = await panelSnapshot();
  steps.panelInstalled = panelInstalled;
  check("E1", "面板打开：只装过一个版本时回滚入口指向内置版本、文案「回退到内置版本 0.1.0」、并且可点",
    opened.marketUp === true && opened.panelUp === true && !!panelInstalled
      && panelInstalled.rollbackTarget === "builtin" && panelInstalled.canRollback === "false"
      && panelInstalled.rollbackButton === true && panelInstalled.rollbackDisabled === false
      && String(panelInstalled.rollbackLabel || "").indexOf("回退到内置版本") >= 0
      && String(panelInstalled.rollbackLabel || "").indexOf(EXPECT.builtinVersion) >= 0,
    { rollbackTarget: "builtin", canRollback: "false", rollbackDisabled: false, rollbackLabel: "回退到内置版本 0.1.0" },
    { rollbackTarget: panelInstalled && panelInstalled.rollbackTarget, canRollback: panelInstalled && panelInstalled.canRollback, rollbackDisabled: panelInstalled && panelInstalled.rollbackDisabled, rollbackLabel: panelInstalled && panelInstalled.rollbackLabel });
  check("E2", "面板设置行如实：回退状态文案「可以回退到内置版本 0.1.0」、当前版本 0.01",
    !!panelInstalled && String(panelInstalled.rollbackState || "").indexOf("可以回退到内置版本 " + EXPECT.builtinVersion) >= 0
      && panelInstalled.current === EXPECT.version,
    { rollbackState: "可以回退到内置版本 0.1.0", current: "0.01" },
    { rollbackState: panelInstalled && panelInstalled.rollbackState, current: panelInstalled && panelInstalled.current });

  await setTheme("light");
  await closeControlCenter();
  await sleep(350);
  const shotTargetLight = await screenshot("panel-rollback-builtin-light");
  await setTheme("dark");
  await closeControlCenter();
  await sleep(350);
  const shotTargetDark = await screenshot("panel-rollback-builtin-dark");
  await setTheme("light");
  await closeControlCenter();
  await sleep(250);
  steps.shots = { rollbackTargetLight: shotTargetLight, rollbackTargetDark: shotTargetDark };

  /* 5 面板里真实点「回退到内置版本」-> 二次确认 ------------------------------ */
  const clickedRollback = await clickMain("[data-canvas-update-rollback]");
  const dialogUp = await waitFor(async () => (await dialogSnapshot()).open === true, 15000);
  const dialog = await dialogSnapshot();
  steps.rollbackDialog = { clickedRollback, dialogUp, dialog };
  check("F1", "点回滚入口弹二次确认：标题/正文说明从 0.01 回退到随包内置 0.1.0、版本目录保留、主按钮「确认回退到内置版本」",
    clickedRollback === true && dialogUp === true && dialog.open === true
      && String(dialog.title || "").indexOf("回退") >= 0 && String(dialog.title || "").indexOf("内置版本") >= 0
      && String(dialog.body || "").indexOf(EXPECT.version) >= 0 && String(dialog.body || "").indexOf(EXPECT.builtinVersion) >= 0
      && String(dialog.body || "").indexOf("版本目录会保留") >= 0
      && dialog.primaryLabel === "确认回退到内置版本" && dialog.primaryKind === "rollback-builtin",
    { title: "回退无限画布到内置版本", primaryLabel: "确认回退到内置版本", primaryKind: "rollback-builtin" }, dialog);
  const shotDialog = await screenshot("panel-confirm-builtin-light");

  const confirmClicked = await js("const el = document.querySelector('[data-canvas-update-confirm-primary]'); if (!el) return false; el.click(); return true;");
  const rolledBack = await waitFor(async () => {
    const snapshot = await panelSnapshot();
    return !!snapshot && snapshot.busy === "idle" && snapshot.rollbackTarget === "none";
  }, 45000);
  const panelAfterRollback = await panelSnapshot();
  steps.rollbackFromPanel = { confirmClicked, rolledBack, panelAfterRollback, shotDialog };
  check("F2", "面板确认后回退完成：current=0.1.0（内置）、rollbackTarget=none、notice 如实「已回退到内置版本」",
    confirmClicked === true && rolledBack === true && !!panelAfterRollback
      && panelAfterRollback.current === EXPECT.builtinVersion && panelAfterRollback.rollbackTarget === "none"
      && panelAfterRollback.canRollback === "false" && panelAfterRollback.rollbackDisabled === true
      && String(panelAfterRollback.notice || "").indexOf("已回退到内置版本") >= 0
      && panelAfterRollback.errorCode === null,
    { current: "0.1.0", rollbackTarget: "none", rollbackDisabled: true, notice: "已回退到内置版本。" },
    { current: panelAfterRollback && panelAfterRollback.current, rollbackTarget: panelAfterRollback && panelAfterRollback.rollbackTarget, rollbackDisabled: panelAfterRollback && panelAfterRollback.rollbackDisabled, notice: panelAfterRollback && panelAfterRollback.notice, errorCode: panelAfterRollback && panelAfterRollback.errorCode });
  check("F3", "回退后 status 如实：current=null、canRollback=false、rollbackTarget=null、latest 仍是 0.01、updateAvailable 按内置版本计算",
    await (async () => {
      const status = await market("market/update/status", { appId: "canvas" });
      steps.statusAfterRollback = status;
      const sr = status.result && status.result.ok === true ? status.result.value : null;
      const ok = !!sr && sr.current === null && sr.canRollback === false && sr.rollbackTarget === null
        && !!sr.latest && sr.latest.version === EXPECT.version && sr.builtinVersion === EXPECT.builtinVersion;
      check("F3a", "status 细节：latest=0.01 / updateAvailable=false（0.01 ≡ 0.1.0）/ checkedAt 有值",
        !!sr && sr.updateAvailable === false && Number.isFinite(sr.checkedAt) && sr.checkedAt > 0,
        { latest: "0.01", updateAvailable: false, checkedAt: ">0" }, sr);
      return ok;
    })(),
    { current: null, canRollback: false, rollbackTarget: null, latest: "0.01", builtin: "0.1.0" }, steps.statusAfterRollback);

  /* 6 磁盘：内置标记 + 版本目录/history 保留 -------------------------------- */
  const pointerAfter = readJson(currentFile);
  const historyAfter = readJson(historyFile);
  steps.pointerAfterRollback = { exists: fs.existsSync(currentFile), value: pointerAfter, history: historyAfter, dirs: fs.readdirSync(stateDir).sort() };
  check("G1", "current.json 变成内置标记（mode=builtin、version=null、rolledBackFrom=0.01），且没有残留临时文件",
    !!pointerAfter && pointerAfter.mode === "builtin" && pointerAfter.version === null
      && pointerAfter.rolledBackFrom === EXPECT.version && pointerAfter.builtinVersion === EXPECT.builtinVersion
      && fs.readdirSync(stateDir).filter((name) => name.startsWith("current.json.tmp-")).length === 0,
    { mode: "builtin", version: null, rolledBackFrom: "0.01", builtinVersion: "0.1.0" }, pointerAfter);
  check("G2", "不删已安装版本：0.01 目录与整包仍在、history 仍记着 0.01（可再切回）",
    fs.existsSync(path.join(stateDir, EXPECT.version, "manifest.json")) === true
      && !!historyAfter && Array.isArray(historyAfter.versions) && historyAfter.versions.includes(EXPECT.version),
    { dirExists: true, history: ["0.01"] }, { dirExists: fs.existsSync(path.join(stateDir, EXPECT.version)), history: historyAfter });

  const shotAfterLight = await screenshot("panel-after-rollback-light");
  await setTheme("dark");
  await closeControlCenter();
  await sleep(350);
  const shotAfterDark = await screenshot("panel-after-rollback-dark");
  await setTheme("light");
  await closeControlCenter();
  await sleep(250);
  steps.shots.afterRollbackLight = shotAfterLight;
  steps.shots.afterRollbackDark = shotAfterDark;

  /* 7 重载后：画布必须真的由内置 bundle 服务 -------------------------------- */
  await reloadRenderer();
  const passAfter = await canvasPass("after-builtin-rollback");
  steps.canvasAfterRollback = passAfter;
  check("H1", "回退后画布首页 + 智能画布都能打开，且能返回列表页",
    passAfter.opened === true && passAfter.listUp === true && passAfter.smartUp === true
      && passAfter.smartReady === true && passAfter.backToList === true && !!passAfter.list && passAfter.list.start === true,
    { list: true, smart: true, backToList: true },
    { served: passAfter.served, list: passAfter.list, smart: passAfter.smart, backToList: passAfter.backToList });
  check("H2", "画布真的改由内置 bundle 服务：x-openarc-canvas-source=" + String(passAfter.served && passAfter.served.source) + "（不再是 installed）、fallback=pointer-cleared、无已安装版本号",
    !!passAfter.served && passAfter.served.status === 200 && passAfter.served.source !== "installed"
      && ["dist", "public"].includes(passAfter.served.source) && passAfter.served.version === null
      && passAfter.served.fallback === "pointer-cleared",
    { source: "dist|public（非 installed）", version: null, fallback: "pointer-cleared" }, passAfter.served);
  check("H3", "回退后画布两页：0 console error / 0 pageerror / 0 条 404 / 0 条 5xx",
    !!passAfter.errorCounts && passAfter.errorCounts.consoleErrors === 0 && passAfter.errorCounts.pageErrors === 0
      && passAfter.errorCounts.notFound === 0 && passAfter.errorCounts.serverErrors === 0,
    { consoleErrors: 0, pageErrors: 0, notFound: 0, serverErrors: 0 }, passAfter.errorCounts);

  /* 8 可再切回：再装一次 0.01；再回退一次；第三次幂等 ---------------------- */
  const reinstallMark = traceMark();
  const reinstall = await market("market/update/install", { appId: "canvas", version: EXPECT.version, confirm: true });
  const reinstallTrace = summarizeTrace(traceSince(reinstallMark));
  steps.reinstall = { response: reinstall, trace: reinstallTrace, hosts: hostsOf(reinstallTrace) };
  const reinstalled = reinstall.result && reinstall.result.ok === true ? reinstall.result.value : null;
  check("I1", "回退后再装一次 0.01 仍然成功（可再切回），previous=null、指针恢复为已安装",
    !!reinstalled && reinstalled.installed && reinstalled.installed.version === EXPECT.version && reinstalled.previous === null
      && (readJson(currentFile) || {}).version === EXPECT.version,
    { version: "0.01", previous: null, pointer: "0.01" },
    { value: reinstalled, pointer: readJson(currentFile) });

  const rollback2 = await market("market/update/rollback", { appId: "canvas" });
  steps.rollbackAgain = rollback2;
  const r2 = rollback2.result && rollback2.result.ok === true ? rollback2.result.value : null;
  check("I2", "第二次回退到内置版本同样成功（可重复执行）：rolledBackTo=builtin、previous={version:0.01}",
    !!r2 && r2.rolledBackTo === "builtin" && !!r2.previous && r2.previous.version === EXPECT.version
      && (readJson(currentFile) || {}).mode === "builtin",
    { rolledBackTo: "builtin", previous: { version: "0.01" } }, rollback2.result);

  const rollback3 = await market("market/update/rollback", { appId: "canvas" });
  steps.rollbackIdempotent = rollback3;
  const r3 = rollback3.result && rollback3.result.ok === true ? rollback3.result.value : null;
  check("I3", "第三次回退幂等：ok=true、rolledBackTo=builtin、previous=null（已在内置版本，不报错）",
    !!r3 && r3.rolledBackTo === "builtin" && r3.previous === null,
    { rolledBackTo: "builtin", previous: null }, rollback3.result);

  /* 9 收尾：面板最终态（浅/深）+ 全场错误与网络汇总 ------------------------ */
  await reloadRenderer();
  const finalOpen = await openUpdatePanel();
  const panelFinal = await panelSnapshot();
  await setTheme("light");
  await closeControlCenter();
  await sleep(350);
  steps.shots.finalLight = await screenshot("panel-final-builtin-light");
  await setTheme("dark");
  await closeControlCenter();
  await sleep(350);
  steps.shots.finalDark = await screenshot("panel-final-builtin-dark");
  await setTheme("light");
  await closeControlCenter();
  steps.panelFinal = { ...finalOpen, snapshot: panelFinal };
  check("J1", "最终面板如实：当前=0.1.0（内置）、回滚入口「已在用内置版本」且不可点、latest 仍显示 0.01、无错误码",
    !!panelFinal && panelFinal.current === EXPECT.builtinVersion && panelFinal.rollbackTarget === "none"
      && panelFinal.rollbackDisabled === true && String(panelFinal.rollbackLabel || "").indexOf("已在用内置版本") >= 0
      && panelFinal.latest === EXPECT.version && panelFinal.errorCode === null,
    { current: "0.1.0", rollbackTarget: "none", rollbackLabel: "已在用内置版本", latest: "0.01", errorCode: null },
    panelFinal);

  const allTrace = summarizeTrace(traceSince(0));
  const allHosts = hostsOf(allTrace);
  report.trace = { note: "原始 trace 含 ModelScope LFS 签名参数，已脱敏；逐请求记录见 fetch-trace.jsonl。", hosts: allHosts, requests: allTrace };
  const notFound = netFailures.filter((item) => item.status === 404);
  const serverErrors = netFailures.filter((item) => item.status >= 500);
  steps.errors = { consoleErrors, pageErrors, netFailures, notFound, serverErrors };
  check("K1", "全场 0 console error", consoleErrors.length === 0, 0, consoleErrors.slice(0, 10));
  check("K2", "全场 0 pageerror", pageErrors.length === 0, 0, pageErrors.slice(0, 10));
  check("K3", "全场 0 条 HTTP 404", notFound.length === 0, 0, notFound.slice(0, 10));
  check("K4", "全场 0 条 HTTP 5xx", serverErrors.length === 0, 0, serverErrors.slice(0, 10));
  check("K5", "所有真实出网主机都在白名单内（含重定向落点）",
    allHosts.length > 0 && allHosts.every((host) => MODELSCOPE_HOSTS.has(host)), [...MODELSCOPE_HOSTS], allHosts);
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
    lines.push("# dxos-update-rollback-builtin · 真机端到端验收（回退到内置版本）", "");
    lines.push("- 时间：" + report.at + " -> " + report.finishedAt);
    lines.push("- Electron " + report.electronVersion + " · CDP " + (steps.environment && steps.environment.cdpPort) + " · 隔离 userData：" + (steps.environment && steps.environment.userDataDir));
    lines.push("- 真实源：ModelScope " + EXPECT.owner + "/" + EXPECT.repo + " · " + EXPECT.manifestPath);
    lines.push("- 结论：" + (report.failed === 0 ? "全部通过" : report.failed + " 项未通过") + "（通过 " + report.passed + "）", "");
    lines.push("## 检查项", "", "| ID | 结果 | 项 | 期望 | 实际 |", "| --- | --- | --- | --- | --- |");
    for (const row of checks) lines.push("| " + row.id + " | " + (row.ok ? "PASS" : "FAIL") + " | " + row.name.replace(/\|/g, "\\|") + " | " + String(row.expected).replace(/\|/g, "\\|").slice(0, 200) + " | " + String(row.actual).replace(/\|/g, "\\|").slice(0, 300) + " |");
    lines.push("", "## 真实出网主机", "", (report.trace.hosts || []).map((host) => "- " + host).join("\n") || "- （无）");
    lines.push("", "## 截图", "");
    for (const [key, shot] of Object.entries(steps.shots || {})) lines.push("- " + key + "：" + shot.file + "（" + shot.width + "×" + shot.height + "）");
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
