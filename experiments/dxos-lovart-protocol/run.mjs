#!/usr/bin/env node
/**
 * dxos-lovart-protocol · 真机验收：真实 Electron + 隔离 userData + 唯一 CDP 端口，
 * 由本地 mock（lovart-mock.mjs）扮演 lgw.lovart.ai，验证：
 *   a0  真实 electron . 启动 + 登录（产品默认入口 dist/vue.html）
 *   C1  provider/create adapterType=lovart（两把密钥合成一个 JSON secret，LOCALHOST）
 *   C2  credential/status configured:true（密钥不回显）
 *   C3  provider/models → GET /v1/openapi/tools/catalog（mock 真校验签名）
 *   C4  model/create（generate_image_flux, image-generation）；C4b 3D 工具能力为空
 *   E1  model/test → 凭据探测（catalog）；E1b image/generate → 产物落盘 dxos/media
 *   E2  产物进资源库：真读 dxos/media 的 PNG → canvas/importAsset → resource/list
 *   E3  系统设置 › 模型与服务商真机截图（浅/深）
 *   收工：杀子进程、删隔离 userData、真实 profile 前后比对
 *
 * 用法：node experiments/dxos-lovart-protocol/run.mjs
 * 可选：OA_LOVART_CDP_PORT=9881 OA_LOVART_KEEP=1
 * 说明：**不做真实联网**（lgw.lovart.ai / www.lovart.ai 对本机 TCP 443 超时）；
 *       mock 只替代最后一跳网络，其余全部是真实主进程与真实产品入口。
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startLovartMock } from "./lovart-mock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-lovart-protocol");
const SHOTS = path.join(ART, "shots");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const KEEP = process.env.OA_LOVART_KEEP === "1";
const ACCESS_KEY = "ak_oa_lovart_mock_access";
const SECRET_KEY = "sk_oa_lovart_mock_secret_value";
const MODEL_ID = "generate_image_flux";
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
function scrub(v) {
  let s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  s = s.split(SECRET_KEY).join("[REDACTED_SK]").split(ACCESS_KEY).join("[REDACTED_AK]");
  s = s.replace(/sk-[A-Za-z0-9._-]{8,}/g, "[REDACTED_SK]").replace(/ak-[A-Za-z0-9._-]{8,}/g, "[REDACTED_AK]");
  return s;
}

async function bridge(page, channel, command, payload) {
  const started = Date.now();
  const res = await page.evaluate(async (arg) => {
    const api = window.openarc[arg.channel];
    if (!api || typeof api.command !== "function") return { __noBridge: true, channel: arg.channel };
    // identity 与 resource 两个通道读顶层 type（resource-bootstrap.cjs:160），其余读 command/payload。
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
  const s = await page.context().newCDPSession(page);
  const res = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  try { await s.detach(); } catch { /* ignore */ }
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
  const rows = [];
  const notes = [];
  const record = (section, name, ok, expected, actual) => {
    const row = { section, name, ok: !!ok, expected: scrub(expected), actual: scrub(actual).slice(0, 1200) };
    rows.push(row);
    console.log((row.ok ? "PASS" : "FAIL") + " [" + section + "] " + name + " :: actual=" + row.actual + " || expected=" + row.expected);
    return row.ok;
  };
  const note = (s) => { notes.push(scrub(s)); console.log("   · " + scrub(s)); };

  const mock = await startLovartMock({ accessKey: ACCESS_KEY, secretKey: SECRET_KEY });
  const realProfile = resolveRealProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  const profileProcBefore = processesUsing(realProfile);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-lovart-"));
  const port = process.env.OA_LOVART_CDP_PORT ? Number(process.env.OA_LOVART_CDP_PORT) : await freePort();

  console.log("========== dxos-lovart-protocol ==========");
  console.log("渲染源：dist/vue.html（产品默认入口）");
  console.log("隔离 userData：" + userDataDir);
  console.log("CDP 端口：" + port);
  console.log("electron：" + electronVersion);
  console.log("mock baseUrl：" + mock.baseUrl + "（只替代最后一跳网络；未做真实联网）");

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  let child = null, browser = null, page = null;
  let stderrBuf = "";
  const report = { at: new Date().toISOString(), electron: electronVersion, cdpPort: port, userDataDir, mockBaseUrl: mock.baseUrl, realNetwork: false, sections: {}, evidence: {} };
  let fatal = null;
  let cfg = {};
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
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await sleep(500);
    record("boot", "a0 · 真实 electron . + 隔离 userData + dist/vue.html 就绪", true, "readyState=complete + 桥面非空", JSON.stringify(await page.evaluate(() => ({ url: location.href, w: innerWidth, h: innerHeight, keys: Object.keys(window.openarc).length }))));

    const identifier = "lovart-probe@openarc.test";
    const password = "LovartProbe-pass-1";
    const call = (channel, command, payload) => bridge(page, channel, command, payload);
    const init = await call("identity", "identity/initialize", { identifier, password, displayName: "Lovart 探针管理员" });
    const login = await call("identity", "identity/login", { identifier, password });
    const gateReady = await waitFor(async () => (await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 30000, 200);
    record("identity", "a1 · identity/initialize + login 进入 ready", !!(init.result && init.result.ok === true && login.result && login.result.ok === true && gateReady), "ok:true + gate=ready", JSON.stringify({ init: init.result && init.result.ok, login: login.result && login.result.ok, gate: gateReady }));

    const credentialSecret = JSON.stringify({ accessKey: ACCESS_KEY, secretKey: SECRET_KEY });
    const create = await call("model", "provider/create", { displayName: "Lovart（官方协议 mock）", baseUrl: mock.baseUrl, adapterType: "lovart", endpointScope: "LOCALHOST", scope: "PERSONAL", credentialSecret });
    cfg.providerId = create.result && create.result.provider ? create.result.provider.providerId : null;
    record("config", "C1 · provider/create adapterType=lovart（AK/SK 合成单个 JSON secret）", !!(create.result && create.result.ok === true && cfg.providerId), "ok:true + providerId + adapterType=lovart", JSON.stringify(create.result).slice(0, 400));
    if (!cfg.providerId) throw new Error("provider/create 失败");
    record("config", "C1b · provider.adapterType 回读=lovart", create.result.provider.adapterType === "lovart", "lovart", create.result.provider.adapterType);
    record("config", "C1c · 返回体不含密钥明文", scrub(JSON.stringify(create.result)).includes(SECRET_KEY) === false && scrub(JSON.stringify(create.result)).includes(ACCESS_KEY) === false, "无明文", scrub(JSON.stringify(create.result)).slice(0, 300));

    const credStatus = await call("model", "credential/status", { providerId: cfg.providerId });
    record("config", "C2 · credential/status configured:true（密钥不回显）", !!(credStatus.result && credStatus.result.configured === true) && !scrub(JSON.stringify(credStatus.result)).includes(SECRET_KEY), "configured:true 且无明文", JSON.stringify(credStatus.result));

    const remote = await call("model", "provider/models", { providerId: cfg.providerId });
    const remoteItems = remote.result && Array.isArray(remote.result.items) ? remote.result.items : [];
    record("config", "C3 · provider/models 来自 catalog（GET /v1/openapi/tools/catalog）", !!(remote.result && remote.result.ok === true && remoteItems.length > 0), "ok:true + 非空清单", remoteItems.map((m) => m.id + "[" + (m.suggestedCapabilities || []).join("+") + "]").join(", "));
    const catalogRequest = mock.state.requests.find((r) => r.path === "/v1/openapi/tools/catalog");
    record("config", "C3b · mock 侧签名校验：GET catalog 通过（路径/方法/HMAC 全对）", !!catalogRequest && catalogRequest.signatureValid === true && catalogRequest.accessKeyMatches === true, "signatureValid=true", JSON.stringify({ method: catalogRequest && catalogRequest.method, signedMethod: catalogRequest && catalogRequest.signedMethod, signedPath: catalogRequest && catalogRequest.signedPath, signatureValid: catalogRequest && catalogRequest.signatureValid }));
    if (remoteItems.length >= 4) note("catalog 第 4 项（3D）能力为空：" + JSON.stringify({ id: remoteItems[3].id, category: remoteItems[3].category, suggestedCapabilities: remoteItems[3].suggestedCapabilities, unsupportedCapability: remoteItems[3].unsupportedCapability }));

    const modelCreate = await call("model", "model/create", { providerId: cfg.providerId, remoteModelId: MODEL_ID, displayName: "Flux Image", capabilities: ["image-generation"], scope: "PERSONAL" });
    cfg.configId = modelCreate.result && modelCreate.result.model ? modelCreate.result.model.configId : null;
    record("config", "C4 · model/create（" + MODEL_ID + ", image-generation）", !!(modelCreate.result && modelCreate.result.ok === true && cfg.configId), "ok:true + configId", JSON.stringify(modelCreate.result).slice(0, 400));
    if (!cfg.configId) throw new Error("model/create 失败");
    report.evidence.provider = { providerId: cfg.providerId, adapterType: "lovart", baseUrl: mock.baseUrl, configId: cfg.configId, remoteModelIds: remoteItems.map((m) => m.id) };

    const mtest = await call("model", "model/test", { configId: cfg.configId });
    record("entry1", "E1 · model/test（凭据探测 catalog，不冒充 inference:true）", !!(mtest.result && mtest.result.ok === true && mtest.result.credentialAccepted === true && mtest.result.inference === false), "ok:true + credentialAccepted:true + inference:false", JSON.stringify(mtest.result).slice(0, 400));

    const gen = await call("model", "image/generate", { providerId: cfg.providerId, model: MODEL_ID, prompt: "一只戴帽子的柴犬，扁平插画", size: "1024x1024", count: 1 });
    const images = gen.result && Array.isArray(gen.result.images) ? gen.result.images : [];
    record("entry1", "E1b · image/generate → send/watch/result 产物落盘 dxos/media", !!(gen.result && gen.result.ok === true && images.length > 0 && images[0].fileName), "ok:true + fileName", JSON.stringify(gen.result).slice(0, 500));
    cfg.mediaFile = images.length && images[0].fileName ? path.join(userDataDir, "dxos", "media", images[0].fileName) : null;
    let pngBytes = null;
    if (cfg.mediaFile && fs.existsSync(cfg.mediaFile)) pngBytes = fs.readFileSync(cfg.mediaFile);
    record("entry1", "E1c · 产物是真实 PNG（魔数 + 字节数）", !!pngBytes && pngBytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" && pngBytes.length > 50, "PNG 魔数 89504e470d0a1a0a", JSON.stringify({ file: cfg.mediaFile && path.relative(userDataDir, cfg.mediaFile), bytes: pngBytes ? pngBytes.length : 0 }));
    const flowPaths = mock.state.requests.filter((r) => r.path.startsWith("/v1/openapi")).map((r) => r.method + " " + r.path);
    record("entry1", "E1d · 生成流程真的走 project/save → chat → chat/status → chat/result", flowPaths.includes("POST /v1/openapi/project/save") && flowPaths.includes("POST /v1/openapi/chat") && flowPaths.includes("GET /v1/openapi/chat/status") && flowPaths.includes("GET /v1/openapi/chat/result"), "四段齐全", JSON.stringify([...new Set(flowPaths)]));
    const sendRequest = mock.state.requests.find((r) => r.path === "/v1/openapi/chat");
    record("entry1", "E1e · mock 侧签名校验：send 通过且带 Idempotency-Key", !!sendRequest && sendRequest.signatureValid === true && sendRequest.idempotencyKey === true, "signatureValid + idempotencyKey", JSON.stringify({ signatureValid: sendRequest && sendRequest.signatureValid, idempotencyKey: sendRequest && sendRequest.idempotencyKey, toolConfig: sendRequest && sendRequest.body && sendRequest.body.tool_config }));
    report.evidence.generate = { images, mediaFile: cfg.mediaFile, bytes: pngBytes ? pngBytes.length : 0, flow: [...new Set(flowPaths)] };

    /* E2 产物进资源库 */
    let resourceRef = null;
    if (pngBytes) {
      const canvas = await call("canvas", "canvas/create", { title: "Lovart 协议验收画布" });
      const canvasId = canvas.result && canvas.result.canvas ? canvas.result.canvas.canvasId : null;
      record("entry2", "E2a · canvas/create", !!(canvas.result && canvas.result.ok === true && canvasId), "ok:true + canvasId", JSON.stringify(canvas.result).slice(0, 300));
      if (canvasId) {
        const dataUrl = "data:image/png;base64," + pngBytes.toString("base64");
        const imported = await call("canvas", "canvas/importAsset", { canvasId, name: "lovart-generated.png", dataUrl });
        resourceRef = imported.result && imported.result.ref ? imported.result.ref : null;
        const canonicalRef = imported.result && imported.result.resource && imported.result.resource.resourceRef ? imported.result.resource.resourceRef : resourceRef;
        cfg.resourceCanonicalRef = canonicalRef;
        record("entry2", "E2b · canvas/importAsset：生成产物写进资源库（managed store）", !!(imported.result && imported.result.ok === true && resourceRef), "ok:true + openarc-asset ref", JSON.stringify(imported.result).slice(0, 400));
        const got = await call("resource", "resource/get", { resourceRef: cfg.resourceCanonicalRef || resourceRef });
        const list = await call("resource", "resource/list", {});
        const items = list.result && Array.isArray(list.result.items) ? list.result.items : [];
        const resourceId = String(resourceRef || "").replace("openarc-asset:", "").replace("openarc-resource:", "");
        const found = items.some((item) => JSON.stringify(item).includes(resourceId));
        record("entry2", "E2c · resource/get + resource/list 读回刚入资源库的产物", !!(got.result && got.result.ok === true) && !!(list.result && list.result.ok === true) && found, "get ok:true + list 命中", JSON.stringify({ getOk: got.result && got.result.ok, count: items.length, found, ref: resourceRef }).slice(0, 500));
        report.evidence.resourceLibrary = { canvasId, resourceRef, count: items.length, found };
      }
    }

    /* E3 设置页真机截图 */
    const opened = await openApp(page, "settings", "系统设置");
    await sleep(600);
    const pane = await clickSel(page, '[data-settings-pane="model"]');
    await sleep(700);
    const shots = await shootBoth(page, "03-settings-model");
    record("entry3", "E3 · 系统设置 › 模型与服务商 真机截图（浅/深）", !!(opened && pane && shots.length === 2), "窗口打开 + 模型面板 + 2 张截图", JSON.stringify({ opened, pane, shots: shots.map((s) => s.file) }));
    report.evidence.settingsShots = shots;

    record("final", "F1 · mock 全程 0 次签名拒绝", mock.state.authRejects === 0, "0", JSON.stringify({ authRejects: mock.state.authRejects, rejectReasons: mock.state.rejectReasons.slice(0, 5) }));
    const apiRequests = mock.state.requests.filter((r) => r.path.startsWith("/v1/openapi"));
    record("final", "F1b · 全部 /v1/openapi 请求签名通过", apiRequests.length > 0 && apiRequests.every((r) => r.signatureValid === true && r.accessKeyMatches === true), "全部 signatureValid", JSON.stringify({ count: apiRequests.length, failed: apiRequests.filter((r) => !r.signatureValid).length }));
    const observedHosts = [...mock.state.observedHosts];
    record("final", "F1c · 观察到的主机清单", observedHosts.length > 0, "至少 1 个", JSON.stringify(observedHosts));
    report.evidence.observedHosts = observedHosts;
    report.evidence.mockRequests = apiRequests.map((r) => ({ method: r.method, path: r.path, signatureValid: r.signatureValid, idempotencyKey: r.idempotencyKey, toolConfig: !!(r.body && r.body.tool_config) }));
    record("final", "F2 · 0 未捕获页面错误", pageErrors.length === 0, "0 pageerror", JSON.stringify(pageErrors.slice(0, 5)));
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
    try { await mock.close(); } catch { /* ignore */ }
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
