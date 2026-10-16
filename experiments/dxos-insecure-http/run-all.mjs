#!/usr/bin/env node
/**
 * dxos-insecure-http · 显式明文 HTTP 真机端到端。
 *
 * 与 experiments/dxos-relay-image 的区别：那批测试用 127.0.0.1 回环桥把公网 http 伪装成 LOCALHOST；
 * 本探针**直连** http://43.130.6.197:8080，验证「用户在添加服务商时显式勾选」这一条放行链路：
 *   ① IPC provider/create 不勾选 → 结构化 ENDPOINT_BLOCKED（默认拒绝，安全底线）；
 *   ② IPC provider/create 勾选 → ok，scope=REMOTE_HTTP_EXPLICIT，allow_insecure_http=1；
 *   ③ 标记镜像进 providers.json；
 *   ④ authorization_audit 留下 model.insecureHttpAuthorized；
 *   ⑤ 真实 image/generate 出图（文件路径 / 字节数 / sha256 / 真实尺寸 / 耗时）；
 *   ⑥ 2880x1800@2 截图：表单开关 + 警示、详情「不安全 HTTP」徽标、真实出图。
 *
 * 隔离：独立 userData 目录 + 唯一 CDP 端口；token 只在运行时从 /tmp/oa-relay.token 读取，
 * 绝不打印、绝不落盘，报告里只出现 sha256 前 12 位。
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-insecure-http");
const SHOTS = path.join(ART, "shots");
const MEDIA = path.join(ART, "media");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const TOKEN_FILE = process.env.OA_II_TOKEN_FILE || "/tmp/oa-relay.token";
const UPSTREAM = process.env.OA_II_UPSTREAM || "http://43.130.6.197:8080";
const IMAGE_MODEL = process.env.OA_II_IMAGE_MODEL || "gemini-3.1-flash-image";
const PROMPT = process.env.OA_II_PROMPT || "a single red apple on a clean white table, soft daylight, product photo";
const KEEP = process.env.OA_II_KEEP === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msSince = (t) => Date.now() - t;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function waitFor(fn, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      try { if (await fn()) return true; } catch { /* retry */ }
      if (Date.now() >= deadline) return false;
      await sleep(stepMs);
    }
  })();
}
function imageInfo(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2; let width = null; let height = null;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off += 1; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      const isSOF = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isSOF) { height = buf.readUInt16BE(off + 5); width = buf.readUInt16BE(off + 7); break; }
      off += 2 + len;
    }
    return { format: "jpeg", width, height };
  }
  if (buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return { format: "webp", width: null, height: null };
  return { format: "unknown", width: null, height: null };
}

async function bridge(page, channel, command, payload) {
  const res = await page.evaluate(async (arg) => {
    const api = window.openarc[arg.channel];
    if (!api || typeof api.command !== "function") return { __noBridge: true };
    const request = arg.channel === "identity" ? Object.assign({ type: arg.command }, arg.payload) : { command: arg.command, payload: arg.payload };
    try { return await api.command(request); } catch (err) { return { __threw: true, message: String((err && err.message) || err) }; }
  }, { channel, command, payload: payload || {} });
  return { result: res };
}

const winSel = (label) => 'section.window[aria-label="' + label + '"]';
const clickSel = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
const clickWin = (page, label, sel) => page.evaluate((a) => { const w = document.querySelector(a.w); const el = w && w.querySelector(a.s); if (!el) return false; el.click(); return true; }, { w: winSel(label), s: sel });

async function openApp(page, appId, name) {
  const label = name + "窗口";
  if (await page.$(winSel(label))) return true;
  await page.evaluate(() => { const d = document.querySelector(".dock"); if (d) d.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true })); });
  await clickSel(page, '.dock-item[data-dock-id="' + appId + '"]');
  return waitFor(async () => !!(await page.$(winSel(label))), 20000, 250);
}
async function setTheme(page, theme) {
  if (!(await page.$(".control-center"))) { await clickSel(page, 'button[aria-label="控制中心"]'); await sleep(350); }
  const label = theme === "dark" ? "深色" : "浅色";
  await page.evaluate((arg) => {
    const cc = document.querySelector(".control-center"); if (!cc) return;
    const group = cc.querySelector('[aria-label="外观"]'); if (!group) return;
    for (const b of Array.prototype.slice.call(group.querySelectorAll("button"))) if ((b.textContent || "").trim() === arg.text) { b.click(); return; }
  }, { text: label });
  await sleep(550);
}
async function closeControlCenter(page) { if (await page.$(".control-center")) { await clickSel(page, ".cc-shade"); await sleep(300); } }
async function shoot(page, name, theme, shots) {
  const file = path.join(SHOTS, name + "-" + theme + ".png");
  const s = await page.context().newCDPSession(page);
  const res = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  try { await s.detach(); } catch { /* ignore */ }
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  const buf = fs.readFileSync(file);
  const rec = { file: path.relative(ROOT, file), theme, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length, at2880x1800: buf.readUInt32BE(16) === 2880 && buf.readUInt32BE(20) === 1800 };
  shots.push(rec);
  return rec;
}
async function shootBoth(page, name, shots) {
  const out = [];
  for (const t of ["light", "dark"]) { await setTheme(page, t); await closeControlCenter(page); await sleep(300); out.push(await shoot(page, name, t, shots)); }
  return out;
}
function setInputValue(page, sel, value) {
  return page.evaluate((arg) => {
    const el = document.querySelector(arg.sel); if (!el) return false;
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, arg.value);
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    return true;
  }, { sel, value });
}

async function main() {
  if (!fs.existsSync(TOKEN_FILE)) { console.log("SKIP  token 文件不存在：" + TOKEN_FILE + "（按约定跳过真机段，不伪造）"); return { skipped: true, reason: "token-missing" }; }
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  if (!token) { console.log("SKIP  token 文件为空：" + TOKEN_FILE); return { skipped: true, reason: "token-empty" }; }
  const tokenDigest = { bytes: Buffer.byteLength(token, "utf8"), sha256_12: sha256(token).slice(0, 12) };
  const scrub = (s) => { let out = String(s == null ? "" : s); if (token.length >= 4) out = out.split(token).join("[REDACTED_TOKEN]"); return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"); };

  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(MEDIA, { recursive: true });

  const require = createRequire(path.join(ROOT, "package.json"));
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");

  const rows = []; const shots = []; const notes = [];
  const record = (name, ok, expected, actual) => { const row = { name, ok: !!ok, expected: scrub(expected).slice(0, 500), actual: scrub(actual).slice(0, 1200) }; rows.push(row); console.log((row.ok ? "PASS " : "FAIL ") + name + " :: " + row.actual); return row.ok; };
  const note = (s) => { const v = scrub(s); notes.push(v); console.log("   · " + v); };

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-insecure-http-"));
  const port = await freePort();
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;

  let child = null; let browser = null; let page = null;
  let providerId = null;
  let stderrBuf = "";
  const report = { upstream: UPSTREAM, tokenDigest, model: IMAGE_MODEL, userDataIsolated: true, cdpPort: port, at: new Date().toISOString() };
  try {
    child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    child.stderr.on("data", (d) => { stderrBuf += String(d); });

    const ready = await waitFor(async () => { try { return (await fetch("http://127.0.0.1:" + port + "/json/version")).ok; } catch { return false; } }, 90000, 300);
    if (!ready) throw new Error("CDP 未就绪: " + stderrBuf.slice(-400));
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const ctx = browser.contexts()[0];
    const isUI = (p) => p.url().indexOf("vue.html") >= 0;
    await waitFor(() => !!ctx.pages().find(isUI), 45000, 300);
    page = ctx.pages().find(isUI);
    if (!page) throw new Error("未找到 Vue 壳页面");
    const bootOk = await waitFor(async () => {
      const v = await page.evaluate(() => ({ rs: document.readyState, n: window.openarc ? Object.keys(window.openarc).length : 0 }));
      return v && v.rs === "complete" && v.n > 0;
    }, 45000, 300);
    if (!bootOk) throw new Error("渲染层未就绪");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await sleep(400);

    const identifier = "insecure-http-probe-" + Date.now() + "@openarc.test";
    const password = "InsecureHttp-pass-1";
    await bridge(page, "identity", "identity/initialize", { identifier, password, displayName: "明文 HTTP 探针管理员" });
    const login = await bridge(page, "identity", "identity/login", { identifier, password });
    record("I1 · identity/initialize + login", !!(login.result && login.result.ok), "ok:true", JSON.stringify(login.result).slice(0, 300));

    /* ── ① 默认仍然拒绝远程明文 http ── */
    const denied = await bridge(page, "model", "provider/create", { displayName: "未勾选明文", baseUrl: UPSTREAM, adapterType: "openai-compatible", scope: "PERSONAL", credentialSecret: token });
    record("D1 · 未勾选的远程 http 仍 ENDPOINT_BLOCKED", !!(denied.result && denied.result.ok === false && denied.result.error === "ENDPOINT_BLOCKED" && denied.result.reason === "remote-requires-https"), "ok:false / ENDPOINT_BLOCKED / remote-requires-https", JSON.stringify(denied.result).slice(0, 400));

    /* ── ② 显式勾选放行（独立 scope + 持久化 + 审计 + 镜像） ── */
    const created = await bridge(page, "model", "provider/create", { displayName: "Sub2API 明文直连", baseUrl: UPSTREAM, adapterType: "openai-compatible", scope: "PERSONAL", allowInsecureHttp: true, credentialSecret: token });
    providerId = created.result && created.result.provider ? created.result.provider.providerId : null;
    record("A1 · 勾选后可建：scope=REMOTE_HTTP_EXPLICIT + allowInsecureHttp=true", !!(created.result && created.result.ok === true && providerId && created.result.provider.endpointScope === "REMOTE_HTTP_EXPLICIT" && created.result.provider.allowInsecureHttp === true), "ok:true / REMOTE_HTTP_EXPLICIT / allowInsecureHttp:true", JSON.stringify(created.result).slice(0, 500));
    if (!providerId) throw new Error("provider/create 显式放行失败");

    const models = await bridge(page, "model", "provider/models", { providerId });
    const ids = models.result && Array.isArray(models.result.items) ? models.result.items.map((m) => m.id) : [];
    record("A2 · provider/models 真实 GET /v1/models", !!(models.result && models.result.ok === true && ids.includes(IMAGE_MODEL)), "ok:true 且清单含 " + IMAGE_MODEL, ids.length + " 个；含目标=" + ids.includes(IMAGE_MODEL));

    const modelCreate = await bridge(page, "model", "model/create", { providerId, remoteModelId: IMAGE_MODEL, displayName: "Sub2API Image", capabilities: ["image-generation"], scope: "PERSONAL" });
    record("A3 · model/create 图像模型", !!(modelCreate.result && modelCreate.result.ok === true), "ok:true", JSON.stringify(modelCreate.result).slice(0, 300));

    /* ── ⑤ 真实出图 ── */
    // 网关偶发 429/503（"No available accounts"）：有限次退避重试，每次都如实记录。
    const attempts = [];
    let imgResult = {};
    let imgMs = 0;
    for (let i = 0; i < 3; i += 1) {
      const tImg = Date.now();
      const imgRes = await bridge(page, "model", "image/generate", { providerId, model: IMAGE_MODEL, prompt: PROMPT, size: "1024x1024", count: 1 });
      imgMs = msSince(tImg);
      imgResult = imgRes.result || {};
      attempts.push({ attempt: i + 1, ok: imgResult.ok === true, error: imgResult.error || null, ms: imgMs });
      if (imgResult.ok === true) break;
      const transient = ["RATE_LIMITED", "PROVIDER_UNAVAILABLE", "MODEL_TIMEOUT", "PROVIDER_PROTOCOL_ERROR"].includes(imgResult.error);
      if (!transient || i === 2) break;
      await sleep(i === 0 ? 4000 : 10000);
    }
    const first = imgResult.images && imgResult.images[0] ? imgResult.images[0] : null;
    let artifact = null;
    if (first && first.mediaPath && fs.existsSync(first.mediaPath)) {
      const buf = fs.readFileSync(first.mediaPath);
      const info = imageInfo(buf);
      const ext = info.format === "jpeg" ? "jpg" : info.format === "png" ? "png" : (info.format === "webp" ? "webp" : "bin");
      const saved = path.join(MEDIA, "insecure-http-image." + ext);
      fs.writeFileSync(saved, buf);
      artifact = { path: path.relative(ROOT, saved), mediaPath: first.mediaPath, bytes: buf.length, sha256: sha256(buf), width: info.width, height: info.height, format: info.format, elapsedMs: imgMs };
    }
    record("G1 · image/generate 真实出图（文件 / 字节 / sha256 / 真实尺寸 / 耗时）", !!(imgResult.ok === true && artifact && artifact.bytes > 0), "ok:true + 落盘文件", JSON.stringify({ ok: imgResult.ok, error: imgResult.error, attempts, artifact }).slice(0, 700));
    report.image = { ...(artifact || {}), attempts };

    /* ── ⑥ UI 截图：表单开关 + 警示 / 详情徽标 / 未勾选拦截 ── */
    await closeControlCenter(page);
    await setTheme(page, "light"); await closeControlCenter(page);
    const settingsOpen = await openApp(page, "settings", "系统设置");
    await waitFor(async () => !!(await page.$('[data-settings-pane="model"]')), 20000, 300);
    await clickSel(page, '[data-settings-pane="model"]');
    const paneReady = await waitFor(async () => !!(await page.$('[data-d4-01="settings"]')), 20000, 300);
    await clickSel(page, '[data-d4-01-provider-add]');
    await waitFor(async () => !!(await page.$('[data-d4-01-provider-form]')), 8000, 200);
    await setInputValue(page, '[data-d4-01-provider-name]', "Sub2API 明文直连");
    await setInputValue(page, '[data-d4-01-provider-url]', UPSTREAM);
    const optShown = await waitFor(async () => !!(await page.$('[data-d4-01-provider-insecure-http]')), 8000, 200);
    const warnText = await page.evaluate(() => { const el = document.querySelector('[data-d4-01-provider-insecure-warning]'); return el ? el.textContent.trim() : null; });
    const warnOk = !!(warnText && /明文 HTTP/.test(warnText) && /中间人/.test(warnText) && /凭据|密钥/.test(warnText));
    record("U1 · http 地址出现必须显式勾选的开关 + 诚实警示文案", optShown && warnOk, "checkbox 可见 + 文案含「明文 HTTP / 中间人 / 凭据」", JSON.stringify({ optShown, warnText }).slice(0, 500));
    const shotsForm = await shootBoth(page, "01-form-insecure-opt", shots);

    // 未勾选就提交 → 结构化 ENDPOINT_BLOCKED（本地即时拦截，不发请求）
    const tBlocked = Date.now();
    await clickSel(page, '[data-d4-01-provider-create]');
    const errShown = await waitFor(async () => !!(await page.$('[data-d4-01-error]')), 8000, 200);
    const blockedUi = await page.evaluate(() => { const el = document.querySelector('[data-d4-01-error]'); return el ? { code: el.getAttribute('data-d4-01-error-code'), text: el.textContent.trim() } : null; });
    const blockedMs = msSince(tBlocked);
    record("U2 · 表单未勾选提交 → 结构化 ENDPOINT_BLOCKED", !!(errShown && blockedUi && blockedUi.code === "ENDPOINT_BLOCKED"), "ENDPOINT_BLOCKED", JSON.stringify({ ...blockedUi, ms: blockedMs }).slice(0, 500));
    const shotsBlocked = await shootBoth(page, "02-form-unchecked-blocked", shots);

    // 详情徽标
    await waitFor(async () => !!(await page.$('[data-d4-01-provider="' + providerId + '"]')), 15000, 300);
    await clickSel(page, '[data-d4-01-provider="' + providerId + '"]');
    const detailOk = await waitFor(async () => !!(await page.$('[data-d4-01-provider-detail="' + providerId + '"]')), 15000, 300);
    const badge = await page.evaluate(() => { const el = document.querySelector('[data-d4-01-provider-insecure-badge]'); return el ? { text: el.textContent.trim(), title: el.getAttribute('title') } : null; });
    record("U3 · 详情区「不安全 HTTP」徽标 + tooltip", !!(detailOk && badge && /不安全/.test(badge.text) && /中间人/.test(badge.title || "")), "徽标可见 + tooltip 说明明文风险", JSON.stringify({ detailOk, badge }).slice(0, 400));
    const shotsDetail = await shootBoth(page, "03-detail-insecure-badge", shots);

    report.ui = { settingsOpen, paneReady, optShown, warnText: scrub(warnText), blockedUi: { ...blockedUi, text: scrub(blockedUi && blockedUi.text) }, badge, shots };
    report.shots = shots;

    // 真实出图渲染截图（直接渲染刚落盘的产物字节；不是产品 chrome）
    if (artifact) {
      // connectOverCDP 不支持 Target.createTarget（newPage），因此在当前产品页上做一次性覆盖层渲染真实产物。
      const buf = fs.readFileSync(path.join(ROOT, artifact.path));
      const b64 = buf.toString("base64");
      await page.evaluate((arg) => {
        const el = document.createElement("div");
        el.id = "oa-insecure-http-render";
        el.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#101014;display:flex;align-items:center;justify-content:center";
        const img = document.createElement("img");
        img.alt = "generated";
        img.src = "data:image/" + arg.ext + ";base64," + arg.b64;
        img.style.cssText = "max-width:94vw;max-height:94vh";
        el.appendChild(img);
        document.body.appendChild(el);
      }, { ext: artifact.format, b64 });
      await sleep(600);
      await shoot(page, "04-generated-image-render", "dark", shots);
      await page.evaluate(() => { const el = document.getElementById("oa-insecure-http-render"); if (el) el.remove(); });
      report.shots = shots;
    }

    /* ── providers.json 镜像标记 ── */
    const ppFile = path.join(userDataDir, "dxos", "providers.json");
    const mapFile = path.join(userDataDir, "dxos", "model-provider-map.json");
    let mirror = { ppFileExists: fs.existsSync(ppFile), found: null, mappedId: null };
    if (mirror.ppFileExists) {
      const list = JSON.parse(fs.readFileSync(ppFile, "utf8"));
      let mapped = null;
      try { mapped = JSON.parse(fs.readFileSync(mapFile, "utf8")).providers[providerId] || null; } catch { mapped = null; }
      const entry = list.find((p) => p.id === mapped) || null;
      mirror = { ppFileExists: true, mappedId: mapped, found: entry ? { id: entry.id, base_url: entry.base_url, allow_insecure_http: entry.allow_insecure_http === true, apiKeyEmpty: entry.api_key === "" } : null };
    }
    record("M1 · 镜像把 allow_insecure_http 带进 providers.json", !!(mirror.found && mirror.found.allow_insecure_http === true && mirror.found.apiKeyEmpty === true), "allow_insecure_http:true 且 api_key 为空串", JSON.stringify(mirror));
    report.mirror = mirror;
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child && !child.killed) child.kill("SIGTERM"); } catch { /* ignore */ }
    await sleep(800);

    /* ── ④ 授权审计（关闭进程后以只读方式查库） ── */
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(path.join(userDataDir, "identity.db"), { readOnly: true });
      const audit = db.prepare("SELECT action, reason_code, decision, permission_source, resource_ref, app_id FROM authorization_audit WHERE action = ? ORDER BY id").all("model.insecureHttpAuthorized");
      const providerRow = db.prepare("SELECT provider_id, base_url, endpoint_scope, allow_insecure_http FROM model_providers").all();
      db.close();
      report.audit = audit;
      report.modelProviders = providerRow;
      record("X1 · 授权审计留下 model.insecureHttpAuthorized + providerId", audit.length >= 1 && audit.every((a) => a.reason_code === "INSECURE_HTTP_EXPLICIT") && audit.some((a) => a.resource_ref === providerId), "≥1 条 / INSECURE_HTTP_EXPLICIT / resource_ref=providerId", JSON.stringify(audit).slice(0, 600));
      const persisted = providerRow.find((p) => p.allow_insecure_http === 1);
      record("X2 · model_providers 持久化 allow_insecure_http=1（base_url 为明文）", !!(persisted && String(persisted.base_url).startsWith("http://")), "allow_insecure_http=1", JSON.stringify(persisted || null).slice(0, 300));
    } catch (e) { report.auditError = String((e && e.message) || e); record("X1 · 授权审计查询", false, "可查询", report.auditError.slice(0, 300)); }

    if (!KEEP) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    else { report.userDataKept = userDataDir; }
  }

  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify({ ...report, rows, notes }, null, 2));
  const pass = rows.filter((r) => r.ok).length;
  console.log("SUMMARY " + pass + "/" + rows.length + " pass; report=artifacts/dxos-insecure-http/report.json");
  if (pass !== rows.length) process.exitCode = 1;
  return { skipped: false, pass, total: rows.length };
}

main().catch((err) => { console.error("PROBE FAILED " + String((err && err.stack) || err).slice(0, 800)); process.exit(2); });
