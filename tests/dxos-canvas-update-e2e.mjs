#!/usr/bin/env node
/**
 * Stage 2 · 无限画布在线更新「真机」验收（真实 electron . + 隔离 userData + 唯一 CDP 端口）。
 *
 * 不联网：安装走真实 market-update-service（注入假 GitHub 源），包由真实打包脚本产出并
 * 用仓库私钥 .keys/update-signing.key 签名（与 resources/app-update-keys.json 配对）。
 *
 * 四场景：
 *   ① 无安装包 → 走内置 bundle（dist/novai-canvas），画布正常；
 *   ② 真实 static-web 包经 market/update/install 安装 → 画布加载 apps/canvas/<version>；
 *   ④ 应用内 market/update/rollback → 回到上一版；
 *   ③ current.json 改坏 → 自动回退内置，画布入口仍可加载（不白屏/不 500）。
 *
 * 证据：协议响应头 x-openarc-canvas-{source,version,fallback} + 包内 marker 指纹 +
 *       主进程结构化 canvas-bundle 日志（含已安装目录绝对路径）+ 截图。
 *
 * 运行：npm run build && node tests/dxos-canvas-update-e2e.mjs
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCRIPT = path.join(ROOT, "scripts", "oa-canvas-package.mjs");
const KEYS_FILE = path.join(ROOT, "resources", "app-update-keys.json");
const domain = require(path.join(ROOT, "electron", "market-update-domain.cjs"));
const { createMarketUpdateBundle } = require(path.join(ROOT, "electron", "market-update-service.cjs"));

const ART = path.join(ROOT, "artifacts", "canvas-online-update");
const SHOTS = path.join(ART, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const ADMIN = { id: "canvas-e2e@openarc.local", pw: "canvas-e2e-pass" };
const SHOT = { width: 1440, height: 900, dsf: 2 };

const report = { checks: [], facts: {}, shots: [] };
const record = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail: String(detail == null ? "" : detail).slice(0, 2000) });
  console.log((ok ? "  PASS " : "! FAIL ") + name + (ok ? "" : " :: " + detail));
  return !!ok;
};
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(fn, timeout = 45000, step = 250) { const end = Date.now() + timeout; for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() >= end) return false; await sleep(step); } }

// ── 静态树 / 打包 ─────────────────────────────────────────────────────────
function copyTree(src, dst) { fs.cpSync(src, dst, { recursive: true }); }

function makeSource(version, marker, work) {
  const base = path.join(ROOT, "public", "novai-canvas");
  const src = path.join(work, "src-" + version);
  copyTree(base, src);
  fs.writeFileSync(path.join(src, "static", "openarc-e2e-marker.json"), JSON.stringify({ marker, version }) + "\n");
  return src;
}

function runPack(version, source, out) {
  const args = [SCRIPT, "--version", version, "--kind", "static-web", "--source", source, "--out", out,
    "--name", "无限画布 · E2E", "--notes", "Stage 2 e2e fixture"];
  const res = spawnSync(process.execPath, args, { encoding: "utf8", cwd: ROOT });
  if (res.status !== 0) throw new Error("打包脚本退出 " + res.status + "：" + res.stderr + res.stdout);
  return fs.readFileSync(path.join(out, "canvas-" + version + ".zip"));
}

// ── 离线安装（真实服务，注入假 GitHub 源） ────────────────────────────────
const API_URL = domain.releasesApiUrl(null);
const assetUrl = (version) => "https://github.com/invaders-2/OpenArc-OS/releases/download/canvas-v" + version + "/canvas-" + version + ".zip";
function makeRelease(version) {
  return { tag_name: "canvas-v" + version, draft: false, prerelease: false, html_url: "https://github.com/invaders-2/OpenArc-OS/releases/tag/canvas-v" + version, published_at: "2026-01-01T00:00:00Z", assets: [{ name: "canvas-" + version + ".zip", browser_download_url: assetUrl(version), size: 1024 }] };
}
function makeFetch(routes) { return async (url) => { const route = routes[String(url)]; return route ? route() : new Response("not found", { status: 404 }); }; }
function installOffline(userDataDir, zips) {
  const routes = {
    [API_URL]: () => new Response(JSON.stringify(Object.keys(zips).map(makeRelease)), { status: 200, headers: { "content-type": "application/json" } }),
    ...Object.fromEntries(Object.entries(zips).map(([version, bytes]) => [assetUrl(version), () => new Response(bytes, { status: 200 })])),
  };
  return createMarketUpdateBundle({
    userDataDir, keysFile: KEYS_FILE, fetchImpl: makeFetch(routes), sourceKind: "github-releases",
    builtinVersion: "0.1.0", clock: () => Date.now(),
    authorization: { resolveActor: () => ({ ok: true, user: { id: "e2e" } }), store: { auditAuthorization: () => {} } },
  });
}

// ── 启动 / 关闭真实应用 ───────────────────────────────────────────────────
let child = null, browser = null, page = null, stdout = "", stderr = "";
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('[data-identity-gate]')?.getAttribute('data-identity-gate') || 'no-root'");
const listFrame = () => page.frames().find((f) => /openarc-canvas:\/\/bundle\/static\/canvas-list\.html/.test(f.url())) || null;

async function launch(userDataDir, tag) {
  const cdpPort = await freePort();
  const env = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE; delete env.OA_DEV_SERVER;
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + cdpPort, ...extraArgs], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
  stdout = ""; stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  const ready = await waitFor(async () => { try { return (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).ok; } catch { return false; } }, 90000, 300);
  if (!ready) throw new Error("CDP 未就绪（" + tag + "）：" + stderr.slice(-800));
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
  const ctx = browser.contexts()[0];
  await waitFor(() => ctx.pages().length > 0, 60000, 300);
  page = ctx.pages().find((p) => /^file:|^https?:/.test(p.url())) || ctx.pages()[0];
  if (!page) throw new Error("未找到渲染层页面（" + tag + "）");
  const ses = await page.context().newCDPSession(page);
  await ses.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false });
  return { cdpPort, tag };
}

async function closeApp(tag) {
  try { if (page) await js("window.close(); return 'closing'"); } catch {}
  await waitFor(() => child && (child.exitCode != null || child.signalCode != null), 15000, 200);
  if (child && child.exitCode == null && child.signalCode == null) { try { child.kill("SIGTERM"); } catch {} await waitFor(() => child.exitCode != null || child.signalCode != null, 6000, 200); }
  if (child && child.exitCode == null && child.signalCode == null) { try { child.kill("SIGKILL"); } catch {} await sleep(500); }
  try { if (browser) await browser.close(); } catch {}
  browser = null; page = null; child = null;
  void tag;
}

async function setupAndLogin() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized") {
    await waitFor(() => has('[data-d3-id="setup-name"]'), 30000);
    const next = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "Canvas E2E");
    await next();
    await waitFor(() => has('[data-d3-id="setup-identifier"]'), 10000);
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await next();
    await waitFor(() => has('[data-d3-id="setup-password"]'), 10000);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000);
    await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  await waitFor(() => has('[data-d3-id="login-identifier"]'), 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  return waitFor(async () => (await gate()) === "ready", 60000);
}

async function openCanvas() {
  const clicked = await js("const el = document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]'); if (el) el.click(); return !!el;");
  const hostUp = await waitFor(() => has("[data-canvas-host]"), 30000);
  const listUp = await waitFor(() => !!listFrame(), 45000);
  return { clicked, hostUp, listUp };
}

async function frameFetch(rel) {
  const frame = listFrame();
  if (!frame) return { error: "no-frame" };
  try {
    return await frame.evaluate(async (rel) => {
      try {
        const r = await fetch(rel);
        const text = await r.text();
        return { status: r.status, source: r.headers.get("x-openarc-canvas-source"), version: r.headers.get("x-openarc-canvas-version"), fallback: r.headers.get("x-openarc-canvas-fallback"), text };
      } catch (e) { return { error: String(e) }; }
    }, rel);
  } catch (e) { return { error: String(e) }; }
}

async function shot(name, label) {
  const file = path.join(SHOTS, name + ".png");
  await page.screenshot({ path: file });
  report.shots.push({ name, label, file: path.relative(ROOT, file) });
  return file;
}

function bundleLogs() {
  return stdout.split("\n").filter((line) => line.includes("[openarc] canvas-bundle ")).map((line) => { try { return JSON.parse(line.slice(line.indexOf("{"))); } catch { return { raw: line }; } });
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-e2e-"));
const userDataInstalled = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-ud-installed-"));
const idOf = (userDataDir) => path.join(userDataDir, "dxos", "apps", "canvas");

async function main() {
  if (!fs.existsSync(KEYS_FILE)) throw new Error("缺少 " + KEYS_FILE);
  if (!fs.existsSync(path.join(ROOT, ".keys", "update-signing.key"))) throw new Error("缺少签名私钥 .keys/update-signing.key");
  if (!fs.existsSync(path.join(ROOT, "dist", "novai-canvas", "static", "canvas-list.html"))) throw new Error("缺少 dist/novai-canvas，请先 npm run build");

  // ① 打包两个真实 static-web 包（含整棵画布树 + 唯一 marker）
  const srcA = makeSource("0.2.0", "A", work);
  const srcB = makeSource("0.3.0", "B", work);
  const outA = path.join(work, "out-0.2.0");
  const outB = path.join(work, "out-0.3.0");
  const zipA = runPack("0.2.0", srcA, outA);
  const zipB = runPack("0.3.0", srcB, outB);
  const publicKeyBase64 = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")).canvas;
  const { readZip } = require(path.join(ROOT, "electron", "canvas-dxos-zip.cjs"));
  for (const [version, zipBytes] of [["0.2.0", zipA], ["0.3.0", zipB]]) {
    const entries = readZip(zipBytes, { maxEntries: 2000, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 });
    const map = new Map(entries.map((e) => [e.name, e.data]));
    const mb = map.get("manifest.json");
    const verified = domain.verifyManifestSignature({ manifestBytes: mb, signatureBase64: map.get("manifest.sig").toString("utf8"), publicKeyBase64 });
    report.facts["package-" + version] = { files: Object.keys(JSON.parse(mb.toString()).files).length, zipEntries: entries.length, zipBytes: zipBytes.length, manifestSha256: sha256(mb), zipSha256: sha256(zipBytes), signatureVerified: verified.ok };
    record("包 " + version + "：真实 static-web（" + entries.length + " 条目 / " + zipBytes.length + " 字节 / 仓库公钥验签）", verified.ok && entries.length > 60, JSON.stringify(report.facts["package-" + version]));
  }

  // ② 应用启动 #1：无安装包 → 内置 bundle
  let launched = await launch(fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-ud-clean-")), "clean");
  const loggedIn1 = await setupAndLogin();
  record("① 应用启动 + 管理员登录（隔离 userData）", loggedIn1, "gate=" + await gate());
  const opened1 = await openCanvas();
  record("① 打开 AI Studio，画布 iframe 起来", opened1.clicked && opened1.hostUp && opened1.listUp, JSON.stringify(opened1));
  const cleanList = await frameFetch("/static/canvas-list.html");
  const cleanMarker = await frameFetch("/static/openarc-e2e-marker.json");
  report.facts["scenario1"] = { cdpPort: launched.cdpPort, list: { status: cleanList.status, source: cleanList.source, version: cleanList.version, fallback: cleanList.fallback, len: (cleanList.text || "").length }, markerStatus: cleanMarker.status, root: (bundleLogs().slice(-1)[0] || {}).root };
  record("① 无安装包：画布入口 200，来源=内置（dist），marker 404", cleanList.status === 200 && cleanList.source !== "installed" && cleanMarker.status === 404 && (cleanList.text || "").length > 0, JSON.stringify(report.facts.scenario1));
  await shot("01-builtin-no-install", "① 无安装包 → 内置 bundle");
  await closeApp("clean");

  // ③ 预置安装：0.2.0 → 0.3.0（真实服务、离线 fixture 源、仓库密钥）
  const service = installOffline(userDataInstalled, { "0.2.0": zipA, "0.3.0": zipB });
  const installA = await service.execute("market/update/install", { confirm: true, version: "0.2.0" }, { sessionRef: "e2e" });
  const installB = await service.execute("market/update/install", { confirm: true, version: "0.3.0" }, { sessionRef: "e2e" });
  if (!installA.ok || !installB.ok) throw new Error("离线安装失败：" + JSON.stringify({ installA, installB }));
  report.facts["installed"] = { a: installA.value.installed, b: installB.value.installed, current: JSON.parse(fs.readFileSync(path.join(idOf(userDataInstalled), "current.json"), "utf8")) };
  record("② market/update/install 真实 static-web 包（0.2.0 → 0.3.0）", installA.value.installed.kind === "static-web" && installB.value.installed.version === "0.3.0", JSON.stringify(report.facts.installed));

  // ④ 应用启动 #2：已安装 0.3.0 → 画布加载 apps/canvas/0.3.0
  launched = await launch(userDataInstalled, "installed");
  const loggedIn2 = await setupAndLogin();
  record("② 应用启动 + 登录（同一隔离 userData）", loggedIn2, "gate=" + await gate());
  const opened2 = await openCanvas();
  record("② 打开 AI Studio", opened2.clicked && opened2.hostUp && opened2.listUp, JSON.stringify(opened2));
  const listInstalled = await frameFetch("/static/canvas-list.html");
  const markerInstalled = await frameFetch("/static/openarc-e2e-marker.json");
  const installedLog = bundleLogs().filter((l) => l.source === "installed").slice(-1)[0] || {};
  const expectedDir = idOf(userDataInstalled) + path.sep + "0.3.0";
  const realpath = (value) => { try { return fs.realpathSync(value); } catch { return value; } };
  report.facts["scenario2"] = {
    cdpPort: launched.cdpPort,
    list: { status: listInstalled.status, source: listInstalled.source, version: listInstalled.version, len: (listInstalled.text || "").length },
    marker: markerInstalled,
    resolvedRoot: installedLog.root,
    expectedDir,
    rootMatchesInstalledDir: realpath(installedLog.root || "") === realpath(expectedDir),
  };
  record("② 画布加载已安装版本：协议来源=installed / 版本=0.3.0 / marker=B", listInstalled.status === 200 && listInstalled.source === "installed" && listInstalled.version === "0.3.0" && markerInstalled.status === 200 && JSON.parse(markerInstalled.text || "{}").marker === "B", JSON.stringify(report.facts.scenario2.list) + " marker=" + markerInstalled.status);
  record("② 主进程解析根目录 = <userData>/dxos/apps/canvas/0.3.0", realpath(installedLog.root || "") === realpath(expectedDir), "root=" + installedLog.root + " expected=" + expectedDir);
  await shot("02-installed-0.3.0", "② 已安装 0.3.0（apps/canvas/0.3.0）");

  // ④ 应用内 rollback → 回到 0.2.0
  const rollbackRes = await js("return await window.openarc.marketUpdate.command({ command: 'market/update/rollback', payload: {} });");
  const rollbackOk = rollbackRes && rollbackRes.ok === true && rollbackRes.value && rollbackRes.value.rolledBackTo === "0.2.0";
  const markerAfterRollback = await frameFetch("/static/openarc-e2e-marker.json");
  report.facts["scenario4"] = { rollbackRes, marker: markerAfterRollback, current: JSON.parse(fs.readFileSync(path.join(idOf(userDataInstalled), "current.json"), "utf8")) };
  record("④ 应用内 rollback 回到 0.2.0，画布 marker 切换为 A", rollbackOk && markerAfterRollback.status === 200 && JSON.parse(markerAfterRollback.text || "{}").marker === "A", JSON.stringify(report.facts.scenario4.rollbackRes));
  await shot("04-after-rollback-0.2.0", "④ rollback 后 0.2.0");

  // ③ 改坏 current.json → 自动回退内置、不白屏
  fs.writeFileSync(path.join(idOf(userDataInstalled), "current.json"), "{ corrupted pointer");
  const listBroken = await frameFetch("/static/canvas-list.html");
  const markerBroken = await frameFetch("/static/openarc-e2e-marker.json");
  const fallbackLog = bundleLogs().slice(-1)[0] || {};
  // 重新加载 iframe，确认真实渲染不白屏
  const frame = listFrame();
  if (frame) { try { await frame.goto(frame.url(), { timeout: 30000 }); } catch {} }
  await waitFor(async () => (await frameFetch("/static/canvas-list.html")).status === 200, 15000);
  const bodyLen = await js("const f = document.querySelector('iframe[src*=\"openarc-canvas\"]'); return f && f.contentDocument ? f.contentDocument.body.innerHTML.length : -1;");
  report.facts["scenario3"] = { list: { status: listBroken.status, source: listBroken.source, fallback: listBroken.fallback, len: (listBroken.text || "").length }, markerStatus: markerBroken.status, fallbackLog, iframeBodyLen: bodyLen };
  record("③ current.json 改坏 → 协议来源=dist / fallback=pointer-invalid / 入口 200", listBroken.status === 200 && listBroken.source === "dist" && listBroken.fallback === "pointer-invalid", JSON.stringify(report.facts.scenario3.list));
  record("③ 内置 bundle 无 marker（404）且画布入口非空（不白屏）", markerBroken.status === 404 && (listBroken.text || "").length > 0, "marker=" + markerBroken.status);
  await shot("03-corrupt-current-fallback", "③ current.json 损坏 → 回退内置");
  await closeApp("installed");
}

let failure = null;
try { await main(); } catch (error) { failure = String((error && error.stack) || error); console.error("E2E 异常：" + failure); }
finally {
  try { await closeApp("final"); } catch {}
  const failed = report.checks.filter((c) => !c.ok);
  report.summary = { total: report.checks.length, passed: report.checks.length - failed.length, failed: failed.map((c) => c.name), error: failure };
  report.stderrTail = stderr.slice(-1500);
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("\n" + report.summary.passed + "/" + report.summary.total + " 真机检查通过；report=" + path.relative(ROOT, path.join(ART, "report.json")));
  console.log("截图：" + report.shots.map((s) => s.file).join(", "));
  if (failure) { console.error(failure); process.exit(1); }
  if (failed.length) process.exit(1);
  process.exit(0);
}
