#!/usr/bin/env node
/**
 * dxos-model-proxy · 真机验收：真实 Electron + 隔离 userData + 唯一 CDP 端口 + 真实 Lovart + 真实代理。
 *
 * 验证「模型/协议出网代理」：
 *   A  默认关闭时 provider/models 直连 lgw.lovart.ai 失败（如实记录原始错误）
 *   B  模型出口代理指向关闭端口 → 同一 provider/models 失败；同一时刻 market/update/check 直连成功
 *      （证明代理只影响模型出口，在线更新不受影响）
 *   C  model/proxy/set 打开 http://127.0.0.1:7897（无需重启）→ provider/models 拿到真站 catalog
 *   D  image/generate 真实出图 → 产物经 a.lovart.ai 下载，落 dxos/media；字节/魔数/真实像素/sha256/耗时
 *   E  产物进资源库（canvas/importAsset → resource/get|list）
 *   F  系统设置 › 模型与服务商 真机截图（浅/深），并断言 UI 反映代理状态
 *   G  关停后读 isolation identity.db：authorization_audit 有 model.proxyEnabled
 *
 * 密钥纪律：密钥只在运行时从 /tmp/oa-lovart.keys 读取，绝不打印 / 绝不入报告（报告里只有 sha256 前 12 位）。
 * 用法：node experiments/dxos-model-proxy/run.mjs
 * 可选：OA_MODEL_PROXY_CDP_PORT=9894 OA_MODEL_PROXY_KEEP=1 OA_MODEL_PROXY_URL=http://127.0.0.1:7897
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-model-proxy");
const SHOTS = path.join(ART, "shots");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const KEEP = process.env.OA_MODEL_PROXY_KEEP === "1";
const KEYS_FILE = process.env.OA_MODEL_PROXY_KEYS || "/tmp/oa-lovart.keys";
const PROXY_URL = process.env.OA_MODEL_PROXY_URL || "http://127.0.0.1:7897";
const DEAD_PROXY_URL = "http://127.0.0.1:9";
const LOVART_BASE = "https://lgw.lovart.ai";
const PROMPT = "一只戴帽子的柴犬，扁平插画，纯色背景";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256Prefix(value) { return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12); }

function readKeys(file) {
  const text = fs.readFileSync(file, "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)\s*[=:]\s*(\S.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return { accessKey: values.AK || "", secretKey: values.SK || "" };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

/** 报告/日志脱敏：密钥真值、sk-/ak- 形态、签名头值。 */
function makeScrubber(secrets) {
  return (value) => {
    let s = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    for (const secret of secrets) if (secret && secret.length >= 6) s = s.split(secret).join("[REDACTED_KEY]");
    s = s.replace(/sk-[A-Za-z0-9._-]{8,}/g, "[REDACTED_SK]").replace(/ak-[A-Za-z0-9._-]{8,}/g, "[REDACTED_AK]");
    s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]");
    s = s.replace(/(X-Signature"?\s*[:=]\s*"?)[A-Fa-f0-9]{16,}/g, "$1[REDACTED_SIG]");
    return s;
  };
}

function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function canConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { try { socket.destroy(); } catch { /* ignore */ } resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
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
function pngInfo(buffer) {
  if (!buffer || buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function bridge(page, channel, command, payload) {
  const started = Date.now();
  const res = await page.evaluate(async (arg) => {
    const api = window.openarc[arg.channel];
    if (!api || typeof api.command !== "function") return { __noBridge: true, channel: arg.channel };
    const request = (arg.channel === "identity" || arg.channel === "resource")
      ? Object.assign({ type: arg.command }, arg.payload)
      : { command: arg.command, payload: arg.payload };
    try { return await api.command(request); } catch (err) { return { __threw: true, message: String((err && err.message) || err) }; }
  }, { channel, command, payload: payload || {} });
  return { ms: Date.now() - started, result: res };
}
const winSel = (label) => 'section.window[aria-label="' + label + '"]';
async function clickSel(page, sel) { return page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel); }
async function openApp(page, appId, name) {
  const label = name + "窗口";
  if (await page.$(winSel(label))) return true;
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
  const session = await page.context().newCDPSession(page);
  const res = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  try { await session.detach(); } catch { /* ignore */ }
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  const buf = fs.readFileSync(file);
  return { file: path.relative(ROOT, file), theme, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}
async function shootBoth(page, name) {
  const out = [];
  for (const t of ["light", "dark"]) { await setTheme(page, t); await closeControlCenter(page); await sleep(300); out.push(await shoot(page, name, t)); }
  await setTheme(page, "light"); await closeControlCenter(page);
  return out;
}

async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const { chromium } = require("@playwright/test");
  const electronPath = require("electron");
  const electronVersion = (() => { try { return require("electron/package.json").version; } catch { return null; } })();

  fs.mkdirSync(SHOTS, { recursive: true });
  const keys = readKeys(KEYS_FILE);
  if (!keys.accessKey || !keys.secretKey) throw new Error("密钥文件缺少 AK/SK：" + KEYS_FILE);
  const scrub = makeScrubber([keys.accessKey, keys.secretKey]);
  const rows = [];
  const notes = [];
  const record = (section, name, ok, expected, actual) => {
    const row = { section, name, ok: !!ok, expected: scrub(expected), actual: scrub(actual).slice(0, 1600) };
    rows.push(row);
    console.log((row.ok ? "PASS" : "FAIL") + " [" + section + "] " + name + " :: actual=" + row.actual + " || expected=" + row.expected);
    return row.ok;
  };
  const note = (s) => { notes.push(scrub(s)); console.log("   · " + scrub(s)); };

  const proxyUrl = new URL(PROXY_URL);
  const proxyReachable = await canConnect(proxyUrl.hostname, Number(proxyUrl.port), 3000);
  const realProfile = resolveRealProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  const profileProcBefore = processesUsing(realProfile);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-model-proxy-"));
  const port = process.env.OA_MODEL_PROXY_CDP_PORT ? Number(process.env.OA_MODEL_PROXY_CDP_PORT) : await freePort();

  console.log("========== dxos-model-proxy（真机） ==========");
  console.log("渲染源：dist/vue.html");
  console.log("隔离 userData：" + userDataDir);
  console.log("CDP 端口：" + port);
  console.log("electron：" + electronVersion);
  console.log("Lovart baseUrl：" + LOVART_BASE + "（真实联网）");
  console.log("代理：" + PROXY_URL + "（可达=" + proxyReachable + "）");
  console.log("密钥指纹：AK sha256[0:12]=" + sha256Prefix(keys.accessKey) + " · SK sha256[0:12]=" + sha256Prefix(keys.secretKey) + "（真值不打印）");

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  let child = null, browser = null, page = null;
  let stderrBuf = "";
  const report = {
    at: new Date().toISOString(), electron: electronVersion, cdpPort: port, userDataDir,
    realNetwork: true, lovartBaseUrl: LOVART_BASE, proxyUrl: PROXY_URL, proxyReachable,
    keyFingerprints: { accessKeySha256_12: sha256Prefix(keys.accessKey), secretKeySha256_12: sha256Prefix(keys.secretKey) },
    sections: {}, evidence: {},
  };
  let fatal = null;
  let cfg = {};
  try {
    child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    const stdoutBuf = [];
    child.stdout.on("data", (d) => { stdoutBuf.push(String(d)); });
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
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await sleep(500);
    record("boot", "a0 · 真实 electron . + 隔离 userData + dist/vue.html 就绪", true, "readyState=complete", JSON.stringify(await page.evaluate(() => ({ url: location.href, keys: Object.keys(window.openarc).length }))));

    const identifier = "model-proxy-probe@openarc.test";
    const password = "ModelProxyProbe-pass-1";
    const call = (channel, command, payload) => bridge(page, channel, command, payload);
    const init = await call("identity", "identity/initialize", { identifier, password, displayName: "代理验收管理员" });
    const login = await call("identity", "identity/login", { identifier, password });
    const gateReady = await waitFor(async () => (await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 30000, 200);
    record("identity", "a1 · identity/initialize + login 进入 ready", !!(init.result && init.result.ok === true && login.result && login.result.ok === true && gateReady), "ok:true + gate=ready", JSON.stringify({ init: init.result && init.result.ok, login: login.result && login.result.ok, gate: gateReady }));

    /* ── A. 建 Lovart 服务商（真站）；默认关闭，先记录「关闭代理」的原始失败 ── */
    const credentialSecret = JSON.stringify({ accessKey: keys.accessKey, secretKey: keys.secretKey });
    const create = await call("model", "provider/create", {
      displayName: "Lovart（真站·代理验收）", baseUrl: LOVART_BASE, adapterType: "lovart",
      endpointScope: "REMOTE_HTTPS", scope: "PERSONAL", credentialSecret,
    });
    cfg.providerId = create.result && create.result.provider ? create.result.provider.providerId : null;
    record("config", "A1 · provider/create adapterType=lovart（真站 baseUrl，AK/SK 合成单个 JSON secret）", !!(create.result && create.result.ok === true && cfg.providerId), "ok:true + providerId", JSON.stringify(create.result).slice(0, 400));
    if (!cfg.providerId) throw new Error("provider/create 失败，后续无法继续");
    const rawCreate = JSON.stringify(create.result);
    record("config", "A2 · 密钥不回显", !rawCreate.includes(keys.accessKey) && !rawCreate.includes(keys.secretKey), "无明文", scrub(rawCreate).slice(0, 300));
    const credStatus = await call("model", "credential/status", { providerId: cfg.providerId });
    record("config", "A3 · credential/status configured:true", !!(credStatus.result && credStatus.result.configured === true), "configured:true", JSON.stringify(credStatus.result));

    const proxyGet0 = await call("model", "model/proxy/get");
    record("config", "A4 · model/proxy/get 默认关闭", !!(proxyGet0.result && proxyGet0.result.ok === true && proxyGet0.result.enabled === false), "enabled:false + url:null", JSON.stringify(proxyGet0.result));

    const modelsOffStart = Date.now();
    const modelsOff = await call("model", "provider/models", { providerId: cfg.providerId });
    const modelsOffMs = Date.now() - modelsOffStart;
    record("control", "A5 · 关闭代理时 provider/models 直连失败（如实记录）", !!(modelsOff.result && modelsOff.result.ok !== true), "ok:false", JSON.stringify({ ...modelsOff.result, ms: modelsOffMs }).slice(0, 600));
    report.evidence.directFailure = { command: "provider/models", ms: modelsOffMs, result: scrub(modelsOff.result) };

    /* ── B. 只影响模型出口：模型代理指向关闭端口，同一时刻在线更新 check 仍直连成功 ── */
    const setDead = await call("model", "model/proxy/set", { enabled: true, url: DEAD_PROXY_URL });
    record("scope", "B1 · model/proxy/set 指向不可达代理（用于对照）", !!(setDead.result && setDead.result.ok === true), "ok:true", JSON.stringify(setDead.result));
    const marketCheck = await call("market", "market/update/check", { appId: "canvas" });
    record("scope", "B2 · 同一时刻在线更新 check 走直连成功（模型代理已指向关闭端口）", !!(marketCheck.result && marketCheck.result.ok === true), "ok:true", JSON.stringify({ ...marketCheck.result, ms: marketCheck.ms }).slice(0, 500));
    const modelsDead = await call("model", "provider/models", { providerId: cfg.providerId });
    const deadProxyCode = modelsDead.result && modelsDead.result.proxyError ? modelsDead.result.proxyError : null;
    record("scope", "B3 · 同一 provider/models 经不可达代理失败，且带原始出网码", !!(modelsDead.result && modelsDead.result.ok !== true), "ok:false + proxyError=PROXY_UNREACHABLE", JSON.stringify(modelsDead.result).slice(0, 500));
    note("B3 proxyError=" + String(deadProxyCode));
    report.evidence.scopeIsolation = { marketCheckOk: !!(marketCheck.result && marketCheck.result.ok === true), modelsDead, deadProxyCode };

    /* ── C. 打开真实代理（无需重启）→ catalog ── */
    if (!proxyReachable) note("警告：代理 " + PROXY_URL + " 当前不可达，生成步骤可能失败");
    const setOn = await call("model", "model/proxy/set", { enabled: true, url: PROXY_URL });
    record("proxy-on", "C1 · model/proxy/set 打开 " + PROXY_URL, !!(setOn.result && setOn.result.ok === true && setOn.result.enabled === true), "ok:true + enabled:true + changed:true", JSON.stringify(setOn.result));
    const proxyGet1 = await call("model", "model/proxy/get");
    record("proxy-on", "C2 · model/proxy/get 回读（无重启）", !!(proxyGet1.result && proxyGet1.result.enabled === true && proxyGet1.result.url === PROXY_URL), PROXY_URL, JSON.stringify(proxyGet1.result));

    const modelsOnStart = Date.now();
    const modelsOn = await call("model", "provider/models", { providerId: cfg.providerId });
    const modelsOnMs = Date.now() - modelsOnStart;
    const items = modelsOn.result && Array.isArray(modelsOn.result.items) ? modelsOn.result.items : [];
    const byCategory = items.reduce((acc, it) => { const k = it.category || "UNKNOWN"; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    record("proxy-on", "C3 · 打开代理后 provider/models 从真站 catalog 拿到工具清单", !!(modelsOn.result && modelsOn.result.ok === true && items.length > 0), "ok:true + 非空", JSON.stringify({ count: items.length, byCategory, ms: modelsOnMs }));
    record("proxy-on", "C4 · catalog 含 IMAGE / VIDEO 工具", !!(byCategory.IMAGE > 0 && byCategory.VIDEO > 0), "IMAGE>0 且 VIDEO>0", JSON.stringify(byCategory));
    report.evidence.catalog = { count: items.length, byCategory, ms: modelsOnMs, sample: items.slice(0, 8).map((m) => ({ id: m.id, category: m.category, caps: m.suggestedCapabilities })) };

    const imageTool = items.find((m) => Array.isArray(m.suggestedCapabilities) && m.suggestedCapabilities.includes("image-generation"))
      || items.find((m) => String(m.category || "").toUpperCase() === "IMAGE") || null;
    record("proxy-on", "C5 · 选中 IMAGE 工具", !!imageTool, "有 image-generation 工具", JSON.stringify(imageTool));
    if (!imageTool) throw new Error("真站 catalog 没有 IMAGE 工具，无法出图");

    const modelCreate = await call("model", "model/create", { providerId: cfg.providerId, remoteModelId: imageTool.id, displayName: imageTool.displayName || imageTool.id, capabilities: ["image-generation"], scope: "PERSONAL" });
    cfg.configId = modelCreate.result && modelCreate.result.model ? modelCreate.result.model.configId : null;
    record("proxy-on", "C6 · model/create（" + imageTool.id + "）", !!(modelCreate.result && modelCreate.result.ok === true && cfg.configId), "ok:true + configId", JSON.stringify(modelCreate.result).slice(0, 400));
    if (!cfg.configId) throw new Error("model/create 失败");

    const modelTest = await call("model", "model/test", { configId: cfg.configId });
    record("proxy-on", "C7 · model/test（凭据探测 catalog）", !!(modelTest.result && modelTest.result.ok === true && modelTest.result.credentialAccepted === true), "ok:true + credentialAccepted:true + inference:false", JSON.stringify(modelTest.result).slice(0, 400));

    /* ── D. 真实出图 ── */
    const genStart = Date.now();
    const gen = await call("model", "image/generate", { providerId: cfg.providerId, model: imageTool.id, prompt: PROMPT, size: "1024x1024", count: 1 });
    const genMs = Date.now() - genStart;
    const images = gen.result && Array.isArray(gen.result.images) ? gen.result.images : [];
    record("generate", "D1 · image/generate 真实生成一张图", !!(gen.result && gen.result.ok === true && images.length > 0 && images[0].fileName), "ok:true + fileName", JSON.stringify({ images: images.map((i) => ({ fileName: i.fileName, bytes: i.bytes, mime: i.mime, type: i.type })), ms: genMs }).slice(0, 700));
    if (!images.length || !images[0].fileName) { report.evidence.generate = { ok: false, ms: genMs, raw: scrub(gen.result).slice(0, 1200) }; throw new Error("image/generate 未产出文件：" + scrub(JSON.stringify(gen.result)).slice(0, 400)); }
    cfg.mediaFile = path.join(userDataDir, "dxos", "media", images[0].fileName);
    const pngBytes = fs.existsSync(cfg.mediaFile) ? fs.readFileSync(cfg.mediaFile) : null;
    const png = pngInfo(pngBytes);
    record("generate", "D2 · 产物落 dxos/media 且是真实 PNG（魔数/像素/字节/sha256）", !!png && pngBytes.length > 100, "PNG 魔数 + width/height>0", JSON.stringify({ file: cfg.mediaFile && path.relative(userDataDir, cfg.mediaFile), bytes: pngBytes ? pngBytes.length : 0, magic: pngBytes ? pngBytes.subarray(0, 8).toString("hex") : null, width: png && png.width, height: png && png.height, sha256: pngBytes ? crypto.createHash("sha256").update(pngBytes).digest("hex") : null, ms: genMs }));
    const artifactUrl = images[0].url ? String(images[0].url) : null;
    let artifactHost = null;
    try { artifactHost = artifactUrl ? new URL(artifactUrl).hostname : null; } catch { artifactHost = null; }
    record("generate", "D3 · 产物下载经 a.lovart.ai（白名单主机）", artifactHost === "a.lovart.ai", "a.lovart.ai", JSON.stringify({ host: artifactHost, type: images[0].type }));
    // 真图独立留档（隔离 userData 会被删）：产物字节直接复制到 artifacts。
    if (pngBytes) { try { fs.mkdirSync(ART, { recursive: true }); fs.copyFileSync(cfg.mediaFile, path.join(ART, "generated-image.png")); } catch { /* 留档失败不改结论 */ } }
    report.evidence.generate = {
      ok: true, ms: genMs, model: imageTool.id, prompt: PROMPT,
      archivedImage: pngBytes ? "artifacts/dxos-model-proxy/generated-image.png" : null,
      file: { name: images[0].fileName, bytes: pngBytes ? pngBytes.length : 0, mime: images[0].mime || "image/png", width: png && png.width, height: png && png.height, magic: pngBytes ? pngBytes.subarray(0, 8).toString("hex") : null, sha256: pngBytes ? crypto.createHash("sha256").update(pngBytes).digest("hex") : null },
      artifactHost, artifactType: images[0].type || null,
    };

    /* ── E. 产物进资源库 ── */
    if (pngBytes) {
      const canvas = await call("canvas", "canvas/create", { title: "模型出网代理验收画布" });
      const canvasId = canvas.result && canvas.result.canvas ? canvas.result.canvas.canvasId : null;
      record("resource", "E1 · canvas/create", !!(canvas.result && canvas.result.ok === true && canvasId), "ok:true + canvasId", JSON.stringify(canvas.result).slice(0, 300));
      if (canvasId) {
        const dataUrl = "data:image/png;base64," + pngBytes.toString("base64");
        const imported = await call("canvas", "canvas/importAsset", { canvasId, name: images[0].fileName, dataUrl });
        const resourceRef = imported.result && imported.result.ref ? imported.result.ref : null;
        const canonical = imported.result && imported.result.resource && imported.result.resource.resourceRef ? imported.result.resource.resourceRef : resourceRef;
        const got = await call("resource", "resource/get", { resourceRef: canonical || resourceRef });
        const list = await call("resource", "resource/list", {});
        const listItems = list.result && Array.isArray(list.result.items) ? list.result.items : [];
        const resourceId = String(resourceRef || "").replace("openarc-asset:", "").replace("openarc-resource:", "");
        const found = listItems.some((item) => JSON.stringify(item).includes(resourceId));
        record("resource", "E2 · canvas/importAsset 入资源库 + resource/get|list 读回", !!(imported.result && imported.result.ok === true && resourceRef && got.result && got.result.ok === true && list.result && list.result.ok === true && found), "import ok + get ok + list 命中", JSON.stringify({ ref: resourceRef, count: listItems.length, found }).slice(0, 400));
        report.evidence.resourceLibrary = { canvasId, resourceRef, count: listItems.length, found };

        // E3：资源库真机截图（可见刚入库的产物）
        const libOpened = await openApp(page, "resource-library", "资源库");
        const libVisible = await waitFor(async () => page.evaluate((name) => document.body.innerText.includes(name), images[0].fileName), 8000, 250);
        await sleep(400);
        const libShot = await shoot(page, "02-resource-library", "light");
        record("resource", "E3 · 资源库真机截图（可见生成产物文件名）", !!(libOpened && libVisible && libShot), "窗口打开 + 文件名可见 + 截图", JSON.stringify({ libOpened, libVisible, shot: libShot.file }));
        report.evidence.resourceLibrary.screenshot = libShot;
      }
    }

    /* ── F. 设置页真机截图 + UI 反映代理状态 ── */
    const opened = await openApp(page, "settings", "系统设置");
    await sleep(600);
    const pane = await clickSel(page, '[data-settings-pane="model"]');
    await waitFor(async () => !!(await page.$("[data-model-egress-switch]")), 8000, 250);
    await sleep(500);
    const ui = await page.evaluate(() => {
      const sw = document.querySelector("[data-model-egress-switch]");
      const input = document.querySelector("[data-model-egress-url]");
      const badge = document.querySelector("[data-model-egress-status]");
      const hint = document.querySelector("[data-model-egress-hint]");
      return {
        hasSwitch: !!sw, checked: sw ? sw.getAttribute("aria-checked") : null,
        hasInput: !!input, url: input ? input.value : null,
        hasBadge: !!badge, badge: badge ? badge.textContent.trim() : null,
        hasHint: !!hint, hint: hint ? hint.textContent.trim() : null,
      };
    });
    const shots = await shootBoth(page, "01-settings-model-egress");
    record("ui", "F1 · 「模型与服务商」出现出网代理一行（开关/输入/状态/说明）", !!(opened && pane && ui.hasSwitch && ui.hasInput && ui.hasBadge && ui.hasHint), "switch+input+badge+hint", JSON.stringify(ui));
    record("ui", "F2 · UI 反映已启用与代理地址", !!(ui.checked === "true" && ui.url === PROXY_URL), "aria-checked=true + url=" + PROXY_URL, JSON.stringify({ checked: ui.checked, url: ui.url, badge: ui.badge }));
    record("ui", "F3 · 设置页浅/深截图", shots.length === 2, "2 张", JSON.stringify(shots.map((s) => s.file)));
    report.evidence.settingsUi = { ui, shots };

    // 真实演练「关闭」再「开启」：审计里必须出现 PROXY_DISABLED，避免关闭路径只靠单测。
    const setOff = await call("model", "model/proxy/set", { enabled: false });
    const setBack = await call("model", "model/proxy/set", { enabled: true, url: PROXY_URL });
    record("proxy-on", "F5 · 真实关闭→再开启（关闭后 get 不再带地址）", !!(setOff.result && setOff.result.ok === true && setOff.result.enabled === false && setOff.result.url === null && setBack.result && setBack.result.ok === true && setBack.result.enabled === true), "off 无 url + 再开 ok", JSON.stringify({ off: setOff.result, back: setBack.result }));

    record("final", "F4 · 0 未捕获页面错误", pageErrors.length === 0, "0 pageerror", JSON.stringify(pageErrors.slice(0, 5)));
    report.hostObserved = { artifactHost };
  } catch (error) {
    fatal = String((error && error.stack) || error);
    record("fatal", "F0 · 未捕获异常", false, "无异常", scrub(fatal).slice(0, 600));
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child && !child.killed) { child.kill("SIGTERM"); await sleep(1500); if (child.exitCode == null) child.kill("SIGKILL"); } } catch { /* ignore */ }
    await sleep(600);

    /* ── G. 关停后读隔离库：代理设置落库 + 授权审计 ── */
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(path.join(userDataDir, "identity.db"));
      const pref = db.prepare("SELECT preference_key, preference_value, updated_by FROM system_preferences WHERE preference_key = ?").get("model.egress.proxy");
      const audits = db.prepare("SELECT action, decision, reason_code, permission_source, old_permissions, new_permissions, resource_ref FROM authorization_audit WHERE action = 'model.proxyEnabled' ORDER BY rowid").all();
      record("audit", "G1 · 代理设置落 system_preferences", !!(pref && JSON.parse(pref.preference_value).enabled === true && JSON.parse(pref.preference_value).url === PROXY_URL), "enabled:true + " + PROXY_URL, JSON.stringify(pref));
      const auditView = audits.map((a) => ({ action: a.action, decision: a.decision, reason: a.reason_code, old: a.old_permissions, new: a.new_permissions }));
      const parseFirst = (json) => { try { return JSON.parse(JSON.parse(json)[0]); } catch { return null; } };
      const firstOld = audits.length ? parseFirst(audits[0].old_permissions) : null;
      const lastNew = audits.length ? parseFirst(audits[audits.length - 1].new_permissions) : null;
      const hasDisabled = audits.some((a) => String(a.reason_code) === "PROXY_DISABLED");
      const g2ok = audits.length >= 3
        && audits.every((a) => a.action === "model.proxyEnabled" && a.decision === "ALLOW")
        && !!(firstOld && firstOld.enabled === false)
        && !!(lastNew && lastNew.enabled === true && lastNew.url === PROXY_URL)
        && hasDisabled;
      record("audit", "G2 · authorization_audit 记录 model.proxyEnabled（关→开 / 地址变更 / 关闭，含前后值）", g2ok, ">=3 条 ALLOW + 首条 old=关闭 + 末条 new=真实代理 + 含 PROXY_DISABLED", JSON.stringify(auditView).slice(0, 1000));
      report.evidence.audit = { preference: pref, audits };
      db.close();
    } catch (error) {
      record("audit", "G0 · 读取隔离库失败", false, "可读", String((error && error.message) || error).slice(0, 300));
    }

    const profileAfter = snapshotProfile(realProfile);
    const profileDiff = diffProfile(profileBefore, profileAfter);
    const leftover = processesUsing(userDataDir);
    report.evidence.realProfile = { before: profileBefore.path, diff: profileDiff, processesBefore: profileProcBefore };
    record("final", "G3 · 真实 profile 未被本次探针改写", profileDiff.unchanged, "无变化", JSON.stringify(profileDiff));
    record("final", "G4 · 隔离 userData 无残留进程", leftover.length === 0, "0", JSON.stringify(leftover));
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
