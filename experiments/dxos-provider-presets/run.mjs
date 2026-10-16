#!/usr/bin/env node
/**
 * dxos-provider-presets · 真机验收：真实 Electron + 隔离 userData + 唯一 CDP 端口，
 * 用产品默认入口 dist/vue.html，验证「模型与服务商 › 添加服务商」的 8 条预设：
 *   a0 真实 electron . 启动 + 登录（ready）
 *   P1 8 条预设都在（带品牌图标位），并逐条带 adapterType / 凭据形态
 *   P2 点 DeepSeek 自动填名称 / 地址 / adapterType
 *   P3 点 Lovart 出现双密钥输入（单密钥框消失）且标为 catalog
 *   P4 用 Lovart 双密钥提交 → 详情显示 adapterType=lovart；凭据 configured:true；
 *      provider/models 的失败不是「凭据形状不对」（INVALID_INPUT / CREDENTIAL_MISSING）
 *   P5 编辑态显示当前协议，且不被预设误改（无自动选中；显式点选才改）
 *   截图：2880×1800@2 浅/深 + 窄窗 820
 *   收工：真实 profile 只读快照前后比对；杀子进程；删隔离 userData
 *
 * 用法：node experiments/dxos-provider-presets/run.mjs
 * 可选：OA_PRESETS_CDP_PORT=9881 OA_PRESETS_KEEP=1
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-provider-presets");
const SHOTS = path.join(ART, "shots");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const NARROW = { width: 820, height: 900, dsf: 2 };
const KEEP = process.env.OA_PRESETS_KEEP === "1";
const ACCESS = "ak_probe_presets_0001";
const SECRET = "sk_probe_presets_0002";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
async function waitFor(fn, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() >= deadline) return false; await sleep(stepMs); }
}
function resolveRealProfilePath() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openarc-os");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "openarc-os");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "openarc-os");
}
function statOf(p) { try { const s = fs.statSync(p); return { exists: true, mtimeMs: Math.round(s.mtimeMs), size: s.size, ino: s.ino }; } catch { return { exists: false }; } }
function snapshotProfile(dir) {
  const out = { path: dir, exists: fs.existsSync(dir), dir: statOf(dir), files: {} };
  const walk = (base, rel, depth) => {
    if (depth > 3) return;
    let names = []; try { names = fs.readdirSync(path.join(base, rel)); } catch { return; }
    for (const n of names) {
      const r = rel ? rel + "/" + n : n; const abs = path.join(base, r); const st = statOf(abs);
      if (!st.exists) continue;
      out.files[r] = { mtimeMs: st.mtimeMs, size: st.size };
      let isDir = false; try { isDir = fs.statSync(abs).isDirectory(); } catch { isDir = false; }
      if (isDir && depth < 3) walk(base, r, depth + 1);
    }
  };
  if (out.exists) walk(dir, "", 0);
  return out;
}
function diffProfile(before, after) {
  const changed = [];
  for (const k of new Set(Object.keys(before.files).concat(Object.keys(after.files)))) {
    if (JSON.stringify(before.files[k] || null) !== JSON.stringify(after.files[k] || null)) changed.push(k);
  }
  if (JSON.stringify(before.dir) !== JSON.stringify(after.dir)) changed.unshift("<dir>");
  return { unchanged: changed.length === 0, changedCount: changed.length, changed: changed.slice(0, 50) };
}
function processesUsing(dir) {
  try { return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(dir)).map((l) => l.trim().slice(0, 160)).slice(0, 10); }
  catch { return []; }
}
const REDACT = "[REDACTED]";
function scrub(v) {
  let s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  s = s.split(ACCESS).join(REDACT);
  s = s.split(SECRET).join(REDACT);
  s = s.split("Bearer ").join("Bearer " + REDACT + " ");
  return s;
}

async function bridge(page, channel, command, payload) {
  const started = Date.now();
  const res = await page.evaluate(async (arg) => {
    const api = window.openarc[arg.channel];
    if (!api || typeof api.command !== "function") return { __noBridge: true, channel: arg.channel };
    const request = arg.channel === "identity" ? Object.assign({ type: arg.command }, arg.payload) : { command: arg.command, payload: arg.payload };
    try { return await api.command(request); } catch (err) { return { __threw: true, message: String((err && err.message) || err) }; }
  }, { channel, command, payload: payload || {} });
  return { ms: Date.now() - started, result: res };
}
const winSel = (label) => 'section.window[aria-label="' + label + '"]';
async function clickSel(page, sel) { return page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel); }
async function openApp(page, appId, name) {
  const label = name + "窗口";
  if (await page.$(winSel(label))) {
    await page.evaluate((w) => { const el = document.querySelector(w); if (el) el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window })); }, winSel(label));
    return true;
  }
  await page.evaluate(() => { const d = document.querySelector(".dock"); if (d) d.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true })); });
  await clickSel(page, '.dock-item[data-dock-id="' + appId + '"]');
  if (await waitFor(async () => !!(await page.$(winSel(label))), 3000, 250)) return true;
  await clickSel(page, '.dock-item[data-dock-id="home"]');
  if (!(await waitFor(async () => !!(await page.$('[data-app-card="' + appId + '"]')), 12000, 250))) return false;
  await clickSel(page, '[data-app-card="' + appId + '"]');
  return waitFor(async () => !!(await page.$(winSel(label))), 20000, 250);
}
async function setTheme(page, theme) {
  const open = await page.$(".control-center");
  if (!open) { await clickSel(page, 'button[aria-label="控制中心"]'); await sleep(350); }
  const label = theme === "dark" ? "深色" : "浅色";
  await page.evaluate((arg) => {
    const cc = document.querySelector(".control-center"); if (!cc) return false;
    const group = cc.querySelector('[aria-label="外观"]'); if (!group) return false;
    for (const b of Array.prototype.slice.call(group.querySelectorAll("button"))) if ((b.textContent || "").trim() === arg.text) { b.click(); return true; }
    return false;
  }, { text: label });
  await sleep(450);
}
async function closeControlCenter(page) { if (await page.$(".control-center")) { await clickSel(page, ".cc-shade"); await sleep(250); } }
async function shoot(page, name, theme) {
  const file = path.join(SHOTS, name + "-" + theme + ".png");
  const s = await page.context().newCDPSession(page);
  const res = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  try { await s.detach(); } catch { /* ignore */ }
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  const buf = fs.readFileSync(file);
  return { file: path.relative(ROOT, file), theme, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}
async function shootBoth(page, name) {
  const out = [];
  for (const t of ["light", "dark"]) { await setTheme(page, t); await closeControlCenter(page); await sleep(280); out.push(await shoot(page, name, t)); }
  await setTheme(page, "light"); await closeControlCenter(page);
  return out;
}
async function setViewport(cdp, page, shape) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: shape.width, height: shape.height, deviceScaleFactor: shape.dsf, mobile: false });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await sleep(350);
}
async function maximize(page, label) {
  const aria = await page.evaluate((a) => { const w = document.querySelector(a.w); const b = w && w.querySelector(".maximize"); return b ? b.getAttribute("aria-label") : null; }, { w: winSel(label) });
  if (aria && aria.indexOf("最大化") === 0) { await clickSel(page, winSel(label) + " .maximize"); await sleep(600); }
  return true;
}
async function scrollTo(page, selector) {
  return page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.scrollIntoView({ block: "center", inline: "nearest" }); return true; }, selector);
}
async function fill(page, selector, value) {
  return page.evaluate((arg) => {
    const el = document.querySelector(arg.selector);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, arg.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, { selector, value });
}
async function read(page, selector) {
  return page.evaluate((s) => { const el = document.querySelector(s); return el ? String(el.value != null ? el.value : el.textContent || "").trim() : null; }, selector);
}
async function presence(page, selector) { return page.evaluate((s) => !!document.querySelector(s), selector); }
async function presetIds(page) {
  return page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll("[data-d4-01-preset]")).map((el) => el.getAttribute("data-d4-01-preset")));
}

async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const { chromium } = require("@playwright/test");
  const electronPath = require("electron");
  const electronVersion = (() => { try { return require("electron/package.json").version; } catch { return null; } })();

  fs.mkdirSync(SHOTS, { recursive: true });
  const rows = [];
  const notes = [];
  const record = (section, name, ok, expected, actual) => {
    const row = { section, name, ok: !!ok, expected: scrub(expected), actual: scrub(actual).slice(0, 1400) };
    rows.push(row);
    console.log((row.ok ? "PASS" : "FAIL") + " [" + section + "] " + name + " :: actual=" + row.actual + " || expected=" + row.expected);
    return row.ok;
  };
  const note = (s) => { notes.push(scrub(s)); console.log("   · " + scrub(s)); };

  const realProfile = resolveRealProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  const profileProcBefore = processesUsing(realProfile);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-presets-"));
  const port = process.env.OA_PRESETS_CDP_PORT ? Number(process.env.OA_PRESETS_CDP_PORT) : await freePort();

  console.log("========== dxos-provider-presets ==========");
  console.log("渲染源：dist/vue.html（产品默认入口）");
  console.log("隔离 userData：" + userDataDir);
  console.log("CDP 端口：" + port);
  console.log("electron：" + electronVersion);

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  let child = null, browser = null, page = null;
  let stderrBuf = "";
  const report = { at: new Date().toISOString(), electron: electronVersion, cdpPort: port, userDataDir, sections: {}, evidence: {} };
  let fatal = null;
  try {
    child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { stderrBuf += String(d); });
    if (!(await waitFor(async () => { try { return (await fetch("http://127.0.0.1:" + port + "/json/version")).ok; } catch { return false; } }, 60000, 300))) throw new Error("CDP 未就绪：" + stderrBuf.slice(-600));
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const ctx = browser.contexts()[0];
    const isUI = (p) => p.url().indexOf("vue.html") >= 0;
    if (!(await waitFor(() => !!ctx.pages().find(isUI), 45000, 300))) throw new Error("未找到 Vue 壳页面：" + ctx.pages().map((p) => p.url()).join(" | "));
    page = ctx.pages().find(isUI);
    const consoleErrors = [], pageErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(scrub(String(m.text())).slice(0, 300)); });
    page.on("pageerror", (e) => pageErrors.push(scrub(String((e && e.message) || e)).slice(0, 300)));
    report.evidence.consoleErrors = consoleErrors;
    report.evidence.pageErrors = pageErrors;
    if (!(await waitFor(async () => page.evaluate(() => document.readyState === "complete" && window.openarc && Object.keys(window.openarc).length > 0), 45000, 300))) throw new Error("渲染层未就绪");
    const cdp = await page.context().newCDPSession(page);
    await setViewport(cdp, page, SHOT);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await sleep(500);
    record("boot", "a0 · 真实 electron . + 隔离 userData + dist/vue.html 就绪", true, "readyState=complete + 桥面非空", JSON.stringify(await page.evaluate(() => ({ url: location.href, w: innerWidth, h: innerHeight, keys: Object.keys(window.openarc).length }))));

    const call = (channel, command, payload) => bridge(page, channel, command, payload);
    const identifier = "presets-probe@openarc.test";
    const password = "PresetsProbe-pass-1";
    const init = await call("identity", "identity/initialize", { identifier, password, displayName: "预设探针管理员" });
    const login = await call("identity", "identity/login", { identifier, password });
    const gateReady = await waitFor(async () => (await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 30000, 200);
    record("identity", "a1 · identity/initialize + login 进入 ready", !!(init.result && init.result.ok === true && login.result && login.result.ok === true && gateReady), "ok:true + gate=ready", JSON.stringify({ init: init.result && init.result.ok, login: login.result && login.result.ok, gate: gateReady }));

    const opened = await openApp(page, "settings", "系统设置");
    await sleep(600);
    const pane = await clickSel(page, '[data-settings-pane="model"]');
    await sleep(700);
    await maximize(page, "系统设置窗口");
    if (!(await page.$('[data-d4-01-presets]'))) {
      await clickSel(page, '[data-d4-01-provider-add]');
      await waitFor(async () => !!(await page.$('[data-d4-01-presets]')), 5000, 200);
    }
    const ids = await presetIds(page);
    const expectedIds = ["modelscope", "agnes", "lovart", "volcengine", "deepseek", "openai", "gemini", "anthropic"];
    const adapters = await page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll("[data-d4-01-preset]")).map((el) => ({ id: el.getAttribute("data-d4-01-preset"), adapter: el.getAttribute("data-d4-01-preset-adapter"), mode: el.getAttribute("data-d4-01-preset-mode"), status: el.getAttribute("data-d4-01-preset-status"), logo: (el.querySelector("[data-d4-01-preset-logo]") || { getAttribute: () => null }).getAttribute("data-d4-01-preset-logo") })));
    const brandCount = await page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll("[data-d4-01-preset] [data-d4-01-preset-logo-kind]")).filter((el) => el.getAttribute("data-d4-01-preset-logo-kind") === "brand").length);
    record("presets", "P1 · 「添加服务商」出现 8 条预设（id 逐条一致）", !!(opened && pane) && JSON.stringify(ids) === JSON.stringify(expectedIds), JSON.stringify(expectedIds), JSON.stringify(ids));
    record("presets", "P1b · 8 条预设逐条带 adapterType / 凭据形态 / 协议状态", adapters.length === 8 && adapters.every((a) => a.adapter && (a.mode === "single" || a.mode === "dual") && a.status === "available"), "每条 adapterType + single/dual + status=available", JSON.stringify(adapters));
    report.evidence.presets = adapters;
    report.evidence.brandLogoCount = brandCount;
    const p1Shots = await shootBoth(page, "01-presets");
    report.evidence.p1Shots = p1Shots;

    await clickSel(page, '[data-d4-01-preset="deepseek"]');
    await sleep(350);
    const dsName = await read(page, "[data-d4-01-provider-name]");
    const dsUrl = await read(page, "[data-d4-01-provider-url]");
    const dsAdapter = await read(page, "[data-d4-01-provider-adapter]");
    const dsSelected = await page.evaluate(() => { const el = document.querySelector('[data-d4-01-preset-selected="true"]'); return el ? el.getAttribute("data-d4-01-preset") : null; });
    record("deepseek", "P2 · 点 DeepSeek 自动填名称 / 地址 / adapterType", dsName === "DeepSeek" && dsUrl === "https://api.deepseek.com" && dsAdapter === "openai-compatible" && dsSelected === "deepseek", "DeepSeek + https://api.deepseek.com + openai-compatible + selected=deepseek", JSON.stringify({ dsName, dsUrl, dsAdapter, dsSelected }));
    const p2Shots = await shootBoth(page, "02-deepseek-filled");
    report.evidence.p2Shots = p2Shots;

    await clickSel(page, '[data-d4-01-preset="lovart"]');
    await sleep(350);
    const lvAdapter = await read(page, "[data-d4-01-provider-adapter]");
    const dualAccess = await presence(page, "[data-d4-01-provider-secret-access]");
    const dualSecret = await presence(page, "[data-d4-01-provider-secret-key]");
    const singleSecret = await presence(page, "[data-d4-01-provider-secret]");
    const catalogText = await read(page, "[data-d4-01-preset-models-catalog]");
    const modeLabel = await read(page, "[data-d4-01-preset-mode-label]");
    record("lovart", "P3 · 点 Lovart 出现双密钥输入（单密钥框消失）", lvAdapter === "lovart" && dualAccess && dualSecret && !singleSecret, "adapterType=lovart + access/secret 两个输入 + 无单密钥框", JSON.stringify({ lvAdapter, dualAccess, dualSecret, singleSecret, catalogText, modeLabel }));
    record("lovart", "P3b · catalog 来源如实标注（不编模型）", String(catalogText || "").includes("catalog"), "模型列表由 catalog 动态拉取", String(catalogText));
    await scrollTo(page, "[data-d4-01-provider-secret-key]");
    await sleep(300);
    const p3Shots = await shootBoth(page, "03-lovart-dual");
    report.evidence.p3Shots = p3Shots;

    await setViewport(cdp, page, NARROW);
    const narrowOk = await page.evaluate(() => innerWidth <= 820);
    const narrowP3 = await shoot(page, "04-narrow-820-lovart", "light");
    await setViewport(cdp, page, SHOT);
    record("narrow", "P3c · 窄窗（≤820）预设区与双密钥仍可见", narrowOk && (await presence(page, "[data-d4-01-preset]")) && (await presence(page, "[data-d4-01-provider-secret-access]")), "innerWidth<=820 + 预设 + 双密钥", JSON.stringify({ narrowOk, shot: narrowP3.file, width: narrowP3.width }));
    report.evidence.narrowShot = narrowP3;

    await fill(page, "[data-d4-01-provider-secret-access]", ACCESS);
    await fill(page, "[data-d4-01-provider-secret-key]", SECRET);
    await clickSel(page, "[data-d4-01-provider-create]");
    const gotDetail = await waitFor(async () => !!(await page.$('[data-d4-01-provider-detail]')), 20000, 250);
    const detailText = await read(page, "[data-d4-01-provider-detail]");
    const list = await call("model", "provider/list");
    const items = list.result && Array.isArray(list.result.items) ? list.result.items : [];
    const lovartProvider = items.find((p) => p.adapterType === "lovart") || null;
    const cred = lovartProvider ? await call("model", "credential/status", { providerId: lovartProvider.providerId }) : { result: null };
    record("submit", "P4 · 提交 Lovart 后详情显示正确协议（adapterType=lovart）", gotDetail && !!lovartProvider && String(detailText || "").includes("lovart"), "详情含 lovart + provider/list adapterType=lovart", JSON.stringify({ gotDetail, detailHas: String(detailText || "").includes("lovart"), provider: lovartProvider && { providerId: lovartProvider.providerId, adapterType: lovartProvider.adapterType, baseUrl: lovartProvider.baseUrl } }).slice(0, 600));
    record("submit", "P4b · 双密钥写成一条凭据（configured:true，界面不回显）", !!(cred.result && cred.result.configured === true), "configured:true", JSON.stringify(cred.result));
    let lovartModelsError = null;
    if (lovartProvider) {
      const rm = await call("model", "provider/models", { providerId: lovartProvider.providerId });
      lovartModelsError = rm.result && rm.result.error ? String(rm.result.error) : null;
    }
    const credentialShapeOk = lovartModelsError !== "INVALID_INPUT" && lovartModelsError !== "CREDENTIAL_MISSING";
    record("submit", "P4c · 双密钥 JSON 被 Lovart 适配器接受（失败只在网络，不在凭据形状）", credentialShapeOk, "provider/models 不报 INVALID_INPUT / CREDENTIAL_MISSING", JSON.stringify({ error: lovartModelsError }));
    await scrollTo(page, "[data-d4-01-provider-detail]");
    await sleep(300);
    const p4Shots = await shootBoth(page, "05-lovart-detail");
    report.evidence.p4Shots = p4Shots;

    await clickSel(page, '[data-d4-01-provider-edit="' + (lovartProvider ? lovartProvider.providerId : "") + '"]');
    await sleep(400);
    const editAdapter = await read(page, "[data-d4-01-preset-current-adapter]");
    const autoSelected = await page.evaluate(() => document.querySelectorAll('[data-d4-01-preset-selected="true"]').length);
    const formAdapter = await read(page, "[data-d4-01-provider-adapter]");
    record("edit", "P5 · 编辑态显示当前协议且不被预设误改（无自动选中）", String(editAdapter || "").includes("lovart") && formAdapter === "lovart" && autoSelected === 0, "当前协议=lovart + 无预设被自动选中", JSON.stringify({ editAdapter, formAdapter, autoSelected }));
    const p5Shots = await shootBoth(page, "06-edit-current-adapter");
    report.evidence.p5Shots = p5Shots;

    record("final", "F1 · 0 console error", consoleErrors.length === 0, "0 console error", JSON.stringify(consoleErrors.slice(0, 5)));
    record("final", "F2 · 0 pageerror", pageErrors.length === 0, "0 pageerror", JSON.stringify(pageErrors.slice(0, 5)));
  } catch (error) {
    fatal = String((error && error.stack) || error);
    record("fatal", "F0 · 未捕获异常", false, "无异常", scrub(fatal).slice(0, 500));
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child && !child.killed) { child.kill("SIGTERM"); await sleep(1200); if (child.exitCode == null) child.kill("SIGKILL"); } } catch { /* ignore */ }
    await sleep(400);
    const profileAfter = snapshotProfile(realProfile);
    const profileDiff = diffProfile(profileBefore, profileAfter);
    const leftover = processesUsing(userDataDir);
    report.evidence.realProfile = { before: profileBefore.path, after: profileAfter.path, diff: profileDiff, processesBefore: profileProcBefore };
    record("final", "F3 · 真实 profile 未被本次探针改写", profileDiff.unchanged, "无变化", JSON.stringify(profileDiff));
    record("final", "F4 · 隔离 userData 无残留进程", leftover.length === 0, "0", JSON.stringify(leftover));
    if (!KEEP) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    report.userDataRemoved = !KEEP;
  }

  report.rows = rows;
  report.notes = notes;
  report.passed = rows.filter((r) => r.ok).length;
  report.failed = rows.filter((r) => !r.ok).length;
  report.ok = report.failed === 0 && !fatal;
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log("\n========== 汇总 ==========");
  console.log("PASS=" + report.passed + " FAIL=" + report.failed + (fatal ? " FATAL" : ""));
  console.log("报告：" + path.relative(ROOT, path.join(ART, "report.json")));
  return report.ok ? 0 : 1;
}

const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (IS_MAIN) main().then((code) => process.exit(code)).catch((err) => { console.error("UNCAUGHT " + err.stack); process.exit(2); });
export { main };
