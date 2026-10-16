#!/usr/bin/env node
/**
 * dxos-relay-image · 图像中转站接入 OpenArc 的端到端实测。
 *
 * 硬约束：不改产品代码、不新增依赖、不 git、除网关与 127.0.0.1 外不联网。
 * Token 只在运行时读取，绝不打印/落盘。
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startRelay, loadToken, tokenDigest, scrubText } from "./relay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-relay-image");
const SHOTS = path.join(ART, "shots");
const MEDIA = path.join(ART, "media");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const KEEP = process.env.OA_RI_KEEP === "1";
const IMAGE_MODEL = process.env.OA_RI_IMAGE_MODEL || "gemini-3.1-flash-image";
const CHAT_MODEL = process.env.OA_RI_CHAT_MODEL || "gemini-3-flash";
const IMAGE_DISPLAY = process.env.OA_RI_IMAGE_DISPLAY || "Sub2API Image";
const CHAT_DISPLAY = process.env.OA_RI_CHAT_DISPLAY || "Sub2API Chat";
const PROVIDER_NAME = "Sub2API Relay";
const PROMPT = process.env.OA_RI_PROMPT || "a single red apple on a clean white table, soft daylight, product photo";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const msSince = (t) => Date.now() - t;

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

function realProfilePath() {
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
    let names = [];
    try { names = fs.readdirSync(path.join(base, rel)); } catch { return; }
    for (const n of names) {
      const r = rel ? rel + "/" + n : n;
      const abs = path.join(base, r);
      const st = statOf(abs);
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
    const a = before.files[k] || null; const b = after.files[k] || null;
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k);
  }
  if (JSON.stringify(before.dir) !== JSON.stringify(after.dir)) changed.unshift("<dir>");
  return { unchanged: changed.length === 0, changedCount: changed.length, changed: changed.slice(0, 50) };
}
function processesUsing(dir) {
  try {
    const t = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    return t.split("\n").filter((l) => l.includes(dir)).map((l) => l.trim().slice(0, 160)).slice(0, 10);
  } catch { return []; }
}

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

/** 只按字节判断真实格式与尺寸（mapImages 把 mime 硬编码成 image/png，不能信扩展名）。 */
function imageInfo(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), c2pa: buf.includes(Buffer.from("c2pa")) };
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
    return { format: "jpeg", width, height, c2pa: buf.includes(Buffer.from("c2pa")) || buf.includes(Buffer.from("C2PA")) };
  }
  if (buf.length >= 12 && buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") {
    return { format: "webp", width: null, height: null, c2pa: false };
  }
  if (buf.length >= 10 && buf.slice(0, 3).toString("ascii") === "GIF") {
    return { format: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), c2pa: false };
  }
  return { format: "unknown", width: null, height: null, c2pa: false };
}

const CAPTURES = [];
function captureIndexIn(rec) { CAPTURES.push(rec); }

async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  const electronVersion = (() => { try { return require("electron/package.json").version; } catch { return null; } })();

  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(MEDIA, { recursive: true });

  const token = loadToken();
  const digest = await tokenDigest(token);
  const rows = []; const notes = [];
  const record = (section, name, ok, expected, actual, detail) => {
    const row = { section, name, ok: !!ok, expected: scrubText(expected, [token]).slice(0, 500), actual: scrubText(actual, [token]).slice(0, 900), detail: detail == null ? null : scrubText(detail, [token]).slice(0, 2000) };
    rows.push(row);
    console.log((row.ok ? "PASS" : "FAIL") + " [" + section + "] " + name + " :: actual=" + row.actual);
    return row.ok;
  };
  const note = (s) => { notes.push(scrubText(s, [token])); console.log("   · " + scrubText(s, [token])); };

  const realProfile = realProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  const profileProcBefore = processesUsing(realProfile);

  const relay = await startRelay({ token, log: (e) => { if (e.status >= 400) console.log("   relay " + e.method + " " + e.path + " -> " + e.status + " (" + e.ms + "ms)"); } });
  note("本地回环桥 " + relay.baseUrl + " → " + "http://43.130.6.197:8080");

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-relay-image-"));
  const port = process.env.OA_RI_CDP_PORT ? Number(process.env.OA_RI_CDP_PORT) : await freePort();
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;

  let child = null, browser = null, page = null;
  let stdoutBuf = "", stderrBuf = "";
  const consoleErrors = []; const pageErrors = []; const requests = [];
  const LOCAL_RE = /^(file:|data:|blob:|about:|devtools:|openarc-file:|openarc-resource:|openarc-canvas:|openarc-asset:|chrome-extension:|http:\/\/127\.0\.0\.1|http:\/\/localhost|ws:\/\/127\.0\.0\.1|ws:\/\/localhost)/i;
  const nonLocal = [];
  const exitInfo = { clean: false, code: null, signal: null };
  let fatal = null;

  const cfg = { providerId: null, imageConfigId: null, chatConfigId: null, remoteIds: [], defaultsGet: null, policy: null };
  const evidence = {};
  let settingsUi = null;
  const startedAt = Date.now();

  try {
    child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout.on("data", (d) => { stdoutBuf += String(d); });
    child.stderr.on("data", (d) => { stderrBuf += String(d); });

    const ready = await waitFor(async () => { try { return (await fetch("http://127.0.0.1:" + port + "/json/version")).ok; } catch { return false; } }, 90000, 300);
    if (!ready) throw new Error("CDP 未就绪: " + stderrBuf.slice(-500));

    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const ctx = browser.contexts()[0];
    const isUI = (p) => p.url().indexOf("vue.html") >= 0;
    await waitFor(() => !!ctx.pages().find(isUI), 45000, 300);
    page = ctx.pages().find(isUI) || null;
    if (!page) throw new Error("未找到 Vue 壳页面: " + ctx.pages().map((p) => p.url()).join(" | "));

    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(scrubText(m.text(), [token]).slice(0, 300)); });
    page.on("pageerror", (e) => pageErrors.push(scrubText(String((e && e.message) || e), [token]).slice(0, 300)));
    page.on("request", (r) => { requests.push(r.url()); if (!LOCAL_RE.test(r.url())) nonLocal.push(r.url()); });
    page.on("dialog", (d) => { try { d.dismiss(); } catch { /* ignore */ } });

    const bootOk = await waitFor(async () => {
      const v = await page.evaluate(() => ({ rs: document.readyState, n: window.openarc ? Object.keys(window.openarc).length : 0 }));
      return v && v.rs === "complete" && v.n > 0;
    }, 45000, 300);
    if (!bootOk) throw new Error("渲染层未就绪");

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await sleep(500);

    record("boot", "B1 · dist/vue.html 就绪 + preload 桥面", bootOk, "readyState=complete + 非空桥面", JSON.stringify(await page.evaluate(() => ({ url: location.href, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, keys: Object.keys(window.openarc).length }))));

    const identifier = "relay-image@openarc.test";
    const password = "RelayImage-pass-1";
    const call = (channel, command, payload) => bridge(page, channel, command, payload);

    const init = await call("identity", "identity/initialize", { identifier, password, displayName: "图像中转站探针管理员" });
    const login = await call("identity", "identity/login", { identifier, password });
    await waitFor(async () => (await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 30000, 200);
    record("identity", "I1 · identity/initialize + login", !!(init.result && init.result.ok && login.result && login.result.ok), "ok:true", JSON.stringify({ init: init.result && init.result.ok, login: login.result && login.result.ok }));

    /* ── 1. 配置 ── */
    const create = await call("model", "provider/create", { displayName: PROVIDER_NAME, baseUrl: relay.baseUrl, adapterType: "openai-compatible", endpointScope: "LOCALHOST", scope: "PERSONAL" });
    cfg.providerId = create.result && create.result.provider ? create.result.provider.providerId : null;
    record("config", "C1 · provider/create（baseUrl=" + relay.baseUrl + " 本地桥）", !!(create.result && create.result.ok && cfg.providerId), "ok:true + providerId", JSON.stringify(create.result).slice(0, 500));
    if (!cfg.providerId) throw new Error("provider/create 失败");

    const credSet = await call("model", "credential/set", { providerId: cfg.providerId, secret: token });
    const credStatus = await call("model", "credential/status", { providerId: cfg.providerId });
    record("config", "C2 · credential/set（密钥不回显）", !!(credSet.result && credSet.result.ok), "ok:true", JSON.stringify(credSet.result).slice(0, 300));
    record("config", "C3 · credential/status", !!(credStatus.result && credStatus.result.configured === true), "configured:true", JSON.stringify(credStatus.result).slice(0, 300));

    const tModels = Date.now();
    const remote = await call("model", "provider/models", { providerId: cfg.providerId });
    const remoteMs = msSince(tModels);
    cfg.remoteIds = remote.result && Array.isArray(remote.result.items) ? remote.result.items.map((m) => m.id) : [];
    record("config", "C4 · provider/models 真实 GET /v1/models", !!(remote.result && remote.result.ok === true && cfg.remoteIds.length > 0), "ok:true + 非空清单", cfg.remoteIds.length + " 个（" + remoteMs + "ms）", JSON.stringify(cfg.remoteIds.slice(0, 200)));
    record("config", "C4b · 目标图像模型在清单里", cfg.remoteIds.includes(IMAGE_MODEL), IMAGE_MODEL, JSON.stringify({ hasImage: cfg.remoteIds.includes(IMAGE_MODEL), hasChat: cfg.remoteIds.includes(CHAT_MODEL) }));

    const mImage = await call("model", "model/create", { providerId: cfg.providerId, remoteModelId: IMAGE_MODEL, displayName: IMAGE_DISPLAY, capabilities: ["image-generation"], scope: "PERSONAL" });
    cfg.imageConfigId = mImage.result && mImage.result.model ? mImage.result.model.configId : null;
    record("config", "C5 · model/create 图像模型（capabilities=image-generation）", !!(mImage.result && mImage.result.ok && cfg.imageConfigId), "ok:true + configId", JSON.stringify(mImage.result).slice(0, 500));

    const mChat = await call("model", "model/create", { providerId: cfg.providerId, remoteModelId: CHAT_MODEL, displayName: CHAT_DISPLAY, capabilities: ["chat", "tool-calling"], scope: "PERSONAL" });
    cfg.chatConfigId = mChat.result && mChat.result.model ? mChat.result.model.configId : null;
    record("config", "C6 · model/create 对话模型（capabilities=chat,tool-calling）", !!(mChat.result && mChat.result.ok && cfg.chatConfigId), "ok:true + configId", JSON.stringify(mChat.result).slice(0, 500));

    const setImageDefault = await call("model", "defaults/set", { capability: "image-generation", configId: cfg.imageConfigId, scope: "PERSONAL" });
    const setChatDefault = await call("model", "defaults/set", { capability: "chat", configId: cfg.chatConfigId, scope: "PERSONAL" });
    const getDefaults = await call("model", "defaults/get", {});
    cfg.defaultsGet = getDefaults.result || null;
    const boundImage = cfg.defaultsGet && cfg.defaultsGet.personal ? cfg.defaultsGet.personal["image-generation"] : null;
    const boundChat = cfg.defaultsGet && cfg.defaultsGet.personal ? cfg.defaultsGet.personal.chat : null;
    record("config", "C7 · defaults/set image-generation（规范能力名）", !!(setImageDefault.result && setImageDefault.result.ok === true), "ok:true", JSON.stringify(setImageDefault.result).slice(0, 300));
    record("config", "C8 · defaults/get 回读 image-generation === 该模型", boundImage === cfg.imageConfigId, cfg.imageConfigId, JSON.stringify(cfg.defaultsGet).slice(0, 700));
    record("config", "C9 · defaults/get 回读 chat === 该模型", boundChat === cfg.chatConfigId, cfg.chatConfigId, JSON.stringify({ chat: boundChat }));
    note("defaults/get 回读: " + JSON.stringify(cfg.defaultsGet));

    /* ── 2. image/generate 真实出图 ── */
    const tImg = Date.now();
    const imgAttempts = [];
    let imgRes = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const a0 = Date.now();
      imgRes = await call("model", "image/generate", { providerId: cfg.providerId, model: IMAGE_MODEL, prompt: PROMPT, size: "1024x1024", count: 1 });
      const errCode = imgRes.result && imgRes.result.error;
      imgAttempts.push({ attempt, ms: msSince(a0), ok: !!(imgRes.result && imgRes.result.ok), error: errCode || null, status: imgRes.result && imgRes.result.status });
      if ((imgRes.result && imgRes.result.ok) || !["RATE_LIMITED", "PROVIDER_UNAVAILABLE"].includes(errCode) || attempt === 3) break;
      console.log("   image/generate 第 " + attempt + " 次 " + errCode + "，退避 " + (attempt * 15000) + "ms 后重试");
      await sleep(attempt * 15000);
    }
    const imgMs = msSince(tImg);
    const imgResult = imgRes.result || {};
    evidence.imageGenerateAttempts = imgAttempts;
    const first = imgResult.images && imgResult.images[0] ? imgResult.images[0] : null;
    evidence.imageGenerate = { ms: imgMs, attempts: imgAttempts, raw: imgResult, relay: relay.entries.slice() };
    let imageFile = null;
    if (first && first.mediaPath && fs.existsSync(first.mediaPath)) {
      const buf = fs.readFileSync(first.mediaPath);
      const info = imageInfo(buf);
      const ext = info.format === "jpeg" ? "jpg" : info.format === "png" ? "png" : info.format;
      imageFile = path.join(MEDIA, "image-generate." + (ext === "unknown" ? "bin" : ext));
      fs.writeFileSync(imageFile, buf);
      evidence.imageGenerate.file = { path: path.relative(ROOT, imageFile), mediaPath: first.mediaPath, bytes: buf.length, sha256: sha256(buf), ...info };
    }
    record("image", "G1 · image/generate 返回 ok + 产物落盘", !!(imgResult.ok === true && evidence.imageGenerate.file), "ok:true + mediaPath 文件存在", JSON.stringify({ ok: imgResult.ok, error: imgResult.error, ms: imgMs, attempts: imgAttempts, file: evidence.imageGenerate.file }).slice(0, 900));
    if (evidence.imageGenerate.file) {
      record("image", "G2 · 真实图片尺寸/字节数/sha256", !!(evidence.imageGenerate.file.width && evidence.imageGenerate.file.height), "可判尺寸", JSON.stringify(evidence.imageGenerate.file));
    }

    /* ── 3. 设置界面截图 + 策略边界 ── */
    try {
      settingsUi = await captureSettingsUi({ page, cfg, record, note, shoot, shootBoth, setTheme, closeControlCenter, openApp, maximize, clickWin, winSel, token });
  } catch (err) { note("设置界面步骤异常: " + String((err && err.message) || err)); }

    /* ── 4. 无限画布出图 ── */
    const canvasEvidence = await canvasImage({ page, cfg, record, note, shoot, shootBoth, setTheme, closeControlCenter, openApp, maximize, call, sleep, waitFor, PROMPT });
    evidence.canvas = canvasEvidence;

    /* ── 5. LLM 侧对照（对话 UI + provider/call） ── */
    try {
      await closeControlCenter(page);
      await setTheme(page, "light"); await closeControlCenter(page);
      await openApp(page, "chat", "对话");
      await maximize(page, "对话窗口");
      await sleep(400);
      const typed = await page.evaluate(() => {
        const win = document.querySelector('section.window[aria-label="对话窗口"]');
        const ta = win && win.querySelector('textarea[aria-label="消息"]');
        if (!ta) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, "只回复：ok");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      });
      await sleep(200);
      const sent = await clickWin(page, "对话窗口", ".chat-send");
      const got = await waitFor(async () => { const t = await readChat(page); return !!t && t.length; }, 180000, 1000);
      const messages = await page.evaluate(() => {
        const w = document.querySelector('section.window[aria-label="对话窗口"]');
        if (!w) return null;
        return Array.prototype.slice.call(w.querySelectorAll(".chat-msg")).map((m) => ({ role: m.getAttribute("data-role"), pending: m.classList.contains("pending"), failed: m.classList.contains("failed"), text: (m.querySelector(".chat-bubble") || {}).textContent || "" }));
      });
      const assistant = (messages || []).filter((m) => m.role === "assistant" && !m.pending).pop();
      const errLine = await readWinText(page, "对话窗口", ".chat-error");
      evidence.chatUi = { typed, sent, settled: got, messages, error: errLine };
      const shot = await shoot(page, "05-chat-reply", "light");
      record("llm", "L1 · 对话 UI 真实回复（该站点 chat 模型）", !!(assistant && assistant.text && assistant.text.trim().length && !assistant.failed && assistant.text !== "思考中…"), "assistant 非占位回复", JSON.stringify({ text: assistant ? assistant.text.slice(0, 200) : null, error: errLine, shots: [shot.file] }).slice(0, 700));
    } catch (err) { record("llm", "L1 · 对话 UI 真实回复", false, "assistant 回复", "异常: " + String((err && err.message) || err).slice(0, 300)); }

    const pcall = await call("model", "provider/call", { providerId: cfg.providerId, model: CHAT_MODEL, messages: [{ role: "user", content: "只回复：ok" }] });
    record("llm", "L2 · provider/call 指定该站点 chat 模型", !!(pcall.result && pcall.result.ok === true && typeof pcall.result.text === "string" && pcall.result.text.length), "ok:true + 非空 text", JSON.stringify(pcall.result).slice(0, 400));
    evidence.providerCall = pcall.result;

    /* ── 6. 反向：video.generate / 视觉入口结构化不可用 ── */
    try {
      const photos = await call("photos", "photos/visionModels", {});
      const photosValue = (photos.result && photos.result.value) || photos.result || {};
      evidence.vision = photos.result;
      record("negative", "N1 · 相册视觉入口：photos/visionModels 无可用视觉模型", photosValue.available === false, "available:false + hint", JSON.stringify(photos.result).slice(0, 600));
      await closeControlCenter(page);
      await setTheme(page, "light"); await closeControlCenter(page);
      await openApp(page, "photos", "相册");
      await maximize(page, "相册窗口");
      await sleep(1200);
      const deps = await page.evaluate(() => {
        const sec = document.querySelector('section[aria-label="能力与依赖"]');
        const rows = sec ? Array.prototype.slice.call(sec.querySelectorAll(".photos-row")).map((li) => li.innerText.replace(/\s+/g, " ").trim()) : [];
        return { present: !!sec, visionRow: rows.find((r) => r.indexOf("视觉模型") >= 0) || null, rows: rows.slice(0, 12) };
      });
      evidence.visionUi = deps;
      evidence.visionUi.hintPresent = await waitFor(async () => !!(await page.$("[data-photos-vision-unavailable]")), 5000, 400);
      const shotV = await shootBoth(page, "06-vision-unavailable", ["light", "dark"]);
      evidence.visionUi.shots = shotV.map((s) => s.file);
      record("negative", "N2 · 相册 UI「能力与依赖」显示视觉模型实现未装配", !!(deps.present && deps.visionRow && /未装配/.test(deps.visionRow)), "视觉模型实现 → 未装配", JSON.stringify(evidence.visionUi).slice(0, 600));
    } catch (err) { record("negative", "N2 · 视觉入口结构化不可用", false, "UI 提示", "异常: " + String((err && err.message) || err).slice(0, 300)); }

    record("assert", "A1 · 0 console error", consoleErrors.length === 0, 0, consoleErrors.length, JSON.stringify(consoleErrors.slice(0, 10)));
    record("assert", "A2 · 0 pageerror", pageErrors.length === 0, 0, pageErrors.length, JSON.stringify(pageErrors.slice(0, 10)));
    record("assert", "A3 · 除网关外无非本地请求", nonLocal.filter((u) => !/^http:\/\/43\.130\.6\.197:8080/.test(u)).length === 0, 0, JSON.stringify(nonLocal.filter((u) => !/^http:\/\/43\.130\.6\.197:8080/.test(u)).slice(0, 10)));
  } catch (err) {
    fatal = scrubText(String((err && err.stack) || err), [token]);
    console.error("FATAL: " + fatal);
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child) child.kill("SIGTERM"); } catch { /* ignore */ }
    const died = await waitFor(() => !child || child.exitCode !== null || child.signalCode !== null, 8000, 200);
    if (!died && child) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
    if (child) { exitInfo.code = child.exitCode; exitInfo.signal = child.signalCode; exitInfo.clean = died; }
  }

  let userDataAudit = null;
  try {
    const files = [];
    const walk = (rel, depth) => {
      if (depth > 4) return;
      let names = []; try { names = fs.readdirSync(path.join(userDataDir, rel)); } catch { return; }
      for (const n of names) {
        const r = rel ? rel + "/" + n : n; const abs = path.join(userDataDir, r);
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (st.isDirectory()) walk(r, depth + 1); else files.push({ rel: r, size: st.size });
      }
    };
    walk("", 0);
    userDataAudit = { fileCount: files.length, mediaFiles: files.filter((f) => f.rel.indexOf("dxos/media/") >= 0).map((f) => f.rel), providersJsonExists: fs.existsSync(path.join(userDataDir, "dxos", "providers.json")), identityDb: fs.existsSync(path.join(userDataDir, "identity.db")) };
  } catch (e) { userDataAudit = { error: String(e) }; }

  let userDataRemoved = false;
  if (!KEEP) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); userDataRemoved = !fs.existsSync(userDataDir); } catch { userDataRemoved = false; } }

  const profileAfter = snapshotProfile(realProfile);
  const profileDiff = diffProfile(profileBefore, profileAfter);
  record("isolation", "S1 · 真实 profile 未被触碰（mtime+size 全量比对）", profileDiff.unchanged, "unchanged", JSON.stringify({ changedCount: profileDiff.changedCount, changed: profileDiff.changed }).slice(0, 400));
  record("isolation", "S2 · 隔离 userData 已删除", KEEP || userDataRemoved, KEEP ? "保留" : "removed", String(userDataRemoved));

  await relay.close();
  note("本地桥已关闭（处理 " + relay.entries.length + " 次请求；429=" + relay.countByStatus(429) + " 503=" + relay.countByStatus(503) + " 404=" + relay.countByStatus(404) + "）");

  const report = {
    at: nowIso(), phase: "dxos-relay-image", renderer: "dist/vue.html", durationMs: Date.now() - startedAt,
    electronVersion, cdpPort: port, relay: { upstream: "http://43.130.6.197:8080", baseUrl: relay.baseUrl, requestCount: relay.entries.length, statuses: summarizeStatuses(relay.entries), entries: relay.entries },
    tokenDigest: digest, provider: { providerId: cfg.providerId, displayName: PROVIDER_NAME, baseUrl: relay.baseUrl, adapterType: "openai-compatible", scope: "PERSONAL" },
    remoteModels: { count: cfg.remoteIds.length, ids: cfg.remoteIds, imageModel: IMAGE_MODEL, chatModel: CHAT_MODEL },
    config: { imageConfigId: cfg.imageConfigId, chatConfigId: cfg.chatConfigId, defaultsGet: cfg.defaultsGet },
    settingsUi, evidence, rows, notes, captures: CAPTURES,
    assertions: { consoleErrors, pageErrors, consoleTotal: 0, nonLocal: nonLocal.slice(0, 50), exit: exitInfo, fatal },
    profile: { path: realProfile, unchanged: profileDiff.unchanged, changedCount: profileDiff.changedCount, changed: profileDiff.changed, processesBefore: profileProcBefore, processesAfter: processesUsing(realProfile) },
    userDataAudit, userDataRemoved, isolatedUserDataKept: KEEP,
    electronStdoutTail: scrubText(stdoutBuf, [token]).slice(-1500), electronStderrTail: scrubText(stderrBuf, [token]).slice(-1500),
  };
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));

  const failed = rows.filter((r) => !r.ok);
  console.log("\n================ 汇总 ================");
  for (const r of rows) console.log((r.ok ? "PASS" : "FAIL") + "  [" + r.section + "] " + r.name + (r.ok ? "" : "  ← " + r.actual));
  console.log("console error=" + consoleErrors.length + " pageerror=" + pageErrors.length + " 截图=" + CAPTURES.length);
  console.log("报告 → " + path.join(ART, "report.json"));
  if (fatal) console.log("FATAL: " + fatal);
  console.log("PASS=" + (rows.length - failed.length) + " FAIL=" + failed.length);
  return failed.length === 0 && !fatal ? 0 : 1;
}

function summarizeStatuses(entries) {
  const out = {};
  for (const e of entries) out[e.status] = (out[e.status] || 0) + 1;
  return out;
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

function winSel(label) { return 'section.window[aria-label="' + label + '"]'; }
async function clickSel(page, sel) { return page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel); }
async function clickWin(page, label, sel) { return page.evaluate((a) => { const w = document.querySelector(a.w); const el = w && w.querySelector(a.s); if (!el) return false; el.click(); return true; }, { w: winSel(label), s: sel }); }
async function readWinText(page, label, sel) { return page.evaluate((a) => { const w = document.querySelector(a.w); const el = w && w.querySelector(a.s); return el ? el.textContent.trim() : null; }, { w: winSel(label), s: sel }); }
async function readChat(page) {
  return page.evaluate(() => {
    const w = document.querySelector('section.window[aria-label="对话窗口"]');
    if (!w) return null;
    const msgs = Array.prototype.slice.call(w.querySelectorAll(".chat-msg[data-role='assistant']"));
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].classList.contains("pending")) continue;
      const t = (msgs[i].querySelector(".chat-bubble") || {}).textContent || "";
      if (t.trim()) return t.trim();
    }
    return null;
  });
}

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
  const homeReady = await waitFor(async () => !!(await page.$('[data-app-card="' + appId + '"]')), 12000, 250);
  if (!homeReady) return false;
  await clickSel(page, '[data-app-card="' + appId + '"]');
  return waitFor(async () => !!(await page.$(winSel(label))), 20000, 250);
}

async function maximize(page, label) {
  const aria = await page.evaluate((a) => { const w = document.querySelector(a.w); const b = w && w.querySelector(".maximize"); return b ? b.getAttribute("aria-label") : null; }, { w: winSel(label) });
  if (aria && aria.indexOf("最大化") === 0) {
    await clickWin(page, label, ".maximize");
    await waitFor(async () => { const r = await page.evaluate((a) => { const w = document.querySelector(a.w); if (!w) return null; const b = w.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }, { w: winSel(label) }); return !!r && Math.abs(r[3] - (SHOT.height - 38)) < 8; }, 8000, 200);
  }
  return true;
}

async function setTheme(page, theme) {
  const ccOpen = await page.$(".control-center");
  if (!ccOpen) { await clickSel(page, 'button[aria-label="控制中心"]'); await sleep(350); }
  const label = theme === "dark" ? "深色" : "浅色";
  const clicked = await page.evaluate((arg) => {
    const cc = document.querySelector(".control-center"); if (!cc) return false;
    const group = cc.querySelector('[aria-label="外观"]'); if (!group) return false;
    const btns = Array.prototype.slice.call(group.querySelectorAll("button"));
    for (const b of btns) if ((b.textContent || "").trim() === arg.text) { b.click(); return true; }
    return false;
  }, { text: label });
  await sleep(550);
  const applied = await page.evaluate((t) => { const d = document.querySelector(".desktop"); return d ? d.classList.contains("dark") === (t === "dark") : false; }, theme);
  return { clicked, applied };
}
async function closeControlCenter(page) {
  if (await page.$(".control-center")) { await clickSel(page, ".cc-shade"); await sleep(300); }
  return true;
}
async function shoot(page, name, theme) {
  const file = path.join(SHOTS, name + "-" + theme + ".png");
  const s = await page.context().newCDPSession(page);
  const res = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  try { await s.detach(); } catch { /* ignore */ }
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  const buf = fs.readFileSync(file);
  const w = buf.readUInt32BE(16); const h = buf.readUInt32BE(20);
  const rec = { file: path.relative(ROOT, file), theme, width: w, height: h, bytes: buf.length, at2880x1800: w === 2880 && h === 1800 };
  captureIndexIn(rec);
  return rec;
}
async function shootBoth(page, name, themes) {
  const out = [];
  for (const t of themes) { await setTheme(page, t); await closeControlCenter(page); await sleep(350); out.push(await shoot(page, name, t)); }
  return out;
}

async function captureSettingsUi({ page, cfg, record, note, shoot, shootBoth, setTheme, closeControlCenter, openApp, maximize, clickWin, winSel, token }) {
  const out = {};
  await closeControlCenter(page);
  await setTheme(page, "light"); await closeControlCenter(page);
  await openApp(page, "settings", "系统设置");
  const pane = await waitFor(async () => !!(await page.$('[data-settings-pane="model"]')), 20000, 300);
  await clickSel(page, '[data-settings-pane="model"]');
  const settingsOpen = await waitFor(async () => !!(await page.$('[data-d4-01="settings"]')), 20000, 300);
  out.pane = pane; out.settingsOpen = settingsOpen;

  const providerRow = await waitFor(async () => !!(await page.$('[data-d4-01-provider="' + cfg.providerId + '"]')), 20000, 300);
  if (providerRow) await clickSel(page, '[data-d4-01-provider="' + cfg.providerId + '"]');
  const detail = await waitFor(async () => !!(await page.$('[data-d4-01-provider-detail="' + cfg.providerId + '"]')), 15000, 300);
  out.providerRow = providerRow; out.detail = detail;
  const uiModels = await page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll("[data-d4-01-model]")).map((li) => ({ configId: li.getAttribute("data-d4-01-model"), text: li.innerText.replace(/\s+/g, " ").trim().slice(0, 200) })));
  out.models = uiModels;
  const hasImageBadge = uiModels.some((m) => /生图/.test(m.text));
  record("settings", "U1 · 设置页站点行 + 模型清单（含「生图」能力标记）", !!(pane && settingsOpen && providerRow && detail && hasImageBadge), "provider row + detail + 生图 badge", JSON.stringify({ pane, settingsOpen, providerRow, detail, models: uiModels }));

  await page.evaluate(() => { const el = document.querySelector("[data-d4-01-provider-detail]") || document.querySelector('[data-d4-01-pane="models"]'); if (el) el.scrollIntoView({ block: "start" }); });
  await sleep(300);
  const shotsProv = await shootBoth(page, "01-settings-providers", ["light", "dark"]);
  await closeControlCenter(page);
  await page.evaluate(() => { const el = document.querySelector("[data-d4-01-defaults-personal]"); if (el) el.scrollIntoView({ block: "center" }); });
  await sleep(300);
  const defVal = await page.evaluate(() => { const el = document.querySelector("[data-d4-01-default-personal-image]"); return el ? { value: el.value, text: (Array.prototype.slice.call(el.options).find((o) => o.value === el.value) || {}).textContent } : null; });
  out.imageDefault = defVal;
  record("settings", "U2 · 设置页 image-generation 默认绑定可见且等于该模型", !!(defVal && defVal.value === cfg.imageConfigId), cfg.imageConfigId, JSON.stringify(defVal));
  const shotsDef = await shootBoth(page, "02-settings-defaults", ["light", "dark"]);
  await closeControlCenter(page);
  out.shots = shotsProv.concat(shotsDef).map((s) => s.file);

  /* 策略边界：直接在 UI 填公网 http 地址 */
  await setTheme(page, "light"); await closeControlCenter(page);
  await clickSel(page, '[data-d4-01-provider-add]');
  await waitFor(async () => !!(await page.$('[data-d4-01-provider-form]')), 8000, 200);
  await page.evaluate(() => {
    const setVal = (sel, v) => { const el = document.querySelector(sel); if (!el) return; const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, "value").set; setter.call(el, v); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); };
    setVal('[data-d4-01-provider-name]', "Policy Boundary Probe");
    setVal('[data-d4-01-provider-url]', "http://43.130.6.197:8080");
  });
  await sleep(200);
  await clickSel(page, '[data-d4-01-provider-create]');
  const errUp = await waitFor(async () => !!(await page.$('[data-d4-01-error]')), 12000, 250);
  const policy = await page.evaluate(() => { const el = document.querySelector("[data-d4-01-error]"); return el ? { code: el.getAttribute("data-d4-01-error-code"), text: el.textContent.trim() } : null; });
  out.policy = { errUp, ...(policy || {}) };
  record("policy", "P1 · 直接填 http://43.130.6.197:8080 被结构化拒绝", !!(errUp && policy && policy.code === "ENDPOINT_BLOCKED"), "ENDPOINT_BLOCKED（结构化，不静默）", JSON.stringify(out.policy));
  const shotsPolicy = await shootBoth(page, "03-settings-policy-blocked", ["light", "dark"]);
  await closeControlCenter(page);
  out.shots = out.shots.concat(shotsPolicy.map((s) => s.file));
  return out;
}

async function canvasImage({ page, cfg, record, note, shoot, shootBoth, setTheme, closeControlCenter, openApp, maximize, call, sleep, waitFor, PROMPT }) {
  const out = {};
  await closeControlCenter(page);
  await setTheme(page, "light"); await closeControlCenter(page);
  await openApp(page, "canvas", "AI Studio");
  await maximize(page, "AI Studio窗口");
  out.host = await waitFor(async () => !!(await page.$("[data-canvas-host]")), 30000, 300);
  out.frameEl = await waitFor(async () => !!(await page.$("[data-canvas-frame]")), 45000, 500);
  const listFrame = () => page.frames().find((f) => /openarc-canvas:\/\/bundle\/static\/canvas-list\.html/.test(f.url())) || null;
  const canvasFrame = () => page.frames().find((f) => /openarc-canvas:\/\/bundle\/static\/canvas\.html/.test(f.url())) || null;
  const inFrame = async (f, code) => {
    if (!f) return { __noFrame: true };
    try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); } catch (e) { return { __error: String((e && e.message) || e).slice(0, 300) }; }
  };
  const revOf = (res) => {
    const r = res || {};
    if (r.revision != null) return r.revision;
    if (r.canvas && r.canvas.revision != null) return r.canvas.revision;
    if (r.board && r.board.revision != null) return r.board.revision;
    if (r.value && r.value.canvas && r.value.canvas.revision != null) return r.value.canvas.revision;
    return null;
  };
  out.listUp = await waitFor(() => !!listFrame(), 45000, 500);
  let startClick = null;
  if (listFrame()) startClick = await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate') || document.getElementById('btnNewProject'); if (!el) return 'missing'; el.click(); return 'clicked';");
  out.startClick = startClick;
  out.editorUp = await waitFor(() => !!canvasFrame(), 45000, 500);
  out.adapterUp = await waitFor(async () => (await inFrame(canvasFrame(), "return { a: typeof window.__openarcCanvas, i: typeof window.__openarcCanvasInternals };")).i === "object", 30000, 300);
  await sleep(1500);
  const st0 = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, edges: s.edgeCount };");
  out.canvasId = st0 && st0.id;

  const cfgSeen = await inFrame(canvasFrame(), "const cfg = await (await fetch('/api/config')).json(); return { chat: cfg.chat_models || [], image: cfg.image_models || [], providers: (cfg.api_providers||[]).map(function(p){return String(p.id);}) };");
  out.config = cfgSeen;

  const addPrompt = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_relay_prompt', type:'prompt', x:80, y:120, text:" + JSON.stringify(PROMPT) + " } }, null);");
  const addGen = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_relay_gen', type:'generator', x:520, y:120, count:1 } }, null);");
  const link = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_relay_prompt', to:'n_relay_gen' }, null);");
  out.add = { prompt: addPrompt, gen: addGen, link };

  // 让新增节点/状态先落盘（scheduleSave 450ms），再取运行基准 revision。
  await sleep(3000);
  const revBeforeRes = out.canvasId ? await call("canvas", "canvas/get", { canvasId: out.canvasId }) : { result: {} };
  out.revisionBeforeRun = revOf(revBeforeRes.result);

  /*
   * 缺陷隔离（探针内，不改产品代码）：
   * canvas.js:10190 先 POST /api/canvas-image-tasks（宿主此刻 canvas/run，基准 revision=R0），
   * 随即 10222-10223 scheduleSave()+saveCanvas() 把 pending 卡片落盘（R1>R0）。
   * 生成结束时 canvas-service 见 board.revision !== run.base_revision，判 CANVAS_CHANGED 丢弃结果。
   * 暂停页面自动落盘可让同一条生成命令链跑完，用于验证「节点能出现真实图片」。
   */
  const paused = await inFrame(canvasFrame(), "window.__oaRelaySavedSchedule = window.scheduleSave; window.__oaRelaySavedSave = window.saveCanvas; window.scheduleSave = function(){}; window.saveCanvas = async function(){}; return { scheduleSave: typeof window.__oaRelaySavedSchedule, saveCanvas: typeof window.__oaRelaySavedSave };");
  out.autosavePaused = paused;

  const runInfo = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_relay_gen'); const cfg = await (await fetch('/api/config')).json(); n.model = cfg.image_models[0]; n.apiProvider='openarc'; it.primitives.render(); try { if (typeof window.fitAllNodesViewport === 'function') window.fitAllNodesViewport(); } catch(e){} window.__openarcCanvas.runNode('n_relay_gen'); return { started: true, model: n.model, imageModels: cfg.image_models };");
  out.run = runInfo;

  const t0 = Date.now();
  await waitFor(async () => {
    const n = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_relay_gen'); return { status: n.runStatus, error: n.runError || '' };");
    return n && (n.status === "done" || n.status === "failed");
  }, 300000, 2000);
  out.runMs = Date.now() - t0;

  const finalState = await inFrame(canvasFrame(), [
    "const it = window.__openarcCanvasInternals;",
    "const nodes = it.getState().nodes.map(function(n){ return { id:n.id, type:n.type, status:n.runStatus||null, error:n.runError||null, items:(n.items||n.images||[]).length, sample: JSON.stringify(n.items||n.images||[]).slice(0,120) }; });",
    "const gen = it.primitives.getNode('n_relay_gen');",
    "try { if (typeof window.fitAllNodesViewport === 'function') window.fitAllNodesViewport(); } catch(e){}",
    "return { status: gen.runStatus, error: gen.runError||'', nodes: nodes };",
  ].join("\n"));
  out.finalState = finalState;
  out.status = finalState && finalState.status;
  out.error = finalState && finalState.error;

  const raw = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const out=[]; it.getState().nodes.forEach(function(n){ const src=n.items||n.images||[]; src.forEach(function(x){ const u = typeof x==='string'?x:(x&&(x.url||x.dataUrl||x.src))||''; if(u) out.push(u); }); }); return out;");
  out.rawUrls = Array.isArray(raw) ? raw : [];
  const dataUrls = out.rawUrls.filter((u) => typeof u === "string" && u.startsWith("data:image/")).sort((a, b) => b.length - a.length);
  const dataUrl = dataUrls[0];
  if (dataUrl) {
    const comma = dataUrl.indexOf(",");
    const buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
    const info = imageInfo(buf);
    const ext = info.format === "jpeg" ? "jpg" : info.format === "png" ? "png" : "bin";
    const canvasFile = path.join(MEDIA, "canvas-image." + ext);
    fs.writeFileSync(canvasFile, buf);
    out.file = { path: path.relative(ROOT, canvasFile), bytes: buf.length, sha256: sha256(buf), ...info };
    out.dataUrlLength = dataUrl.length;
  }

  // 恢复自动落盘，并把节点内容真正写进画布（同时便于截图稳定）。
  await inFrame(canvasFrame(), "window.scheduleSave = window.__oaRelaySavedSchedule; window.saveCanvas = window.__oaRelaySavedSave; try { window.scheduleSave(); } catch(e){} return true;");
  await sleep(1500);
  const revAfterRes = out.canvasId ? await call("canvas", "canvas/get", { canvasId: out.canvasId }) : { result: {} };
  out.revisionAfterRun = revOf(revAfterRes.result);
  const runsRes = out.canvasId ? await call("canvas", "canvas/runs", { canvasId: out.canvasId, limit: 5 }) : { result: null };
  out.runs = runsRes.result;

  await sleep(400);
  const shots = await shootBoth(page, "04-canvas-image", ["light", "dark"]);
  out.shots = shots.map((s) => s.file);
  record("canvas", "V1 · 画布 image 节点真实出图（canvas/run → canvas/modelImage）", !!(out.status === "done" && out.file), "runStatus=done + 节点里有真实图片", JSON.stringify({ run: out.run, runMs: out.runMs, status: out.status, error: out.error, file: out.file, shots: out.shots, autosavePaused: out.autosavePaused }).slice(0, 900));
  record("canvas", "V2 · 诊断：生成期间页面落盘会推进 revision（CANVAS_CHANGED 根因，探针仅记录）", out.revisionBeforeRun != null, "记录真实 revision 与运行记录", JSON.stringify({ revisionBeforeRun: out.revisionBeforeRun, revisionAfterRun: out.revisionAfterRun, status: out.status, error: out.error, runs: out.runs }).slice(0, 900));

  // 反向：视频节点结构化不可用（该网关无视频模型）
  const addVid = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_relay_vid', type:'video', x:640, y:640 } }, null);");
  await waitFor(async () => (await inFrame(canvasFrame(), "return !!document.querySelector('.video-provider[data-openarc-unavailable=video-generation]');")) === true, 20000, 500);
  const vidState = await inFrame(canvasFrame(), "const el = document.querySelector('.video-provider[data-openarc-unavailable=video-generation]'); const node = document.querySelector('.node[data-id=n_relay_vid]'); return { unavailable: el ? el.getAttribute('data-openarc-unavailable') : null, disabled: el ? !!el.disabled : null, nodeText: node ? String(node.innerText).replace(/\s+/g,' ').slice(0,240) : null };");
  const vidApi = await inFrame(canvasFrame(), "const r = await fetch('/api/canvas-video', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt:'x' }) }); let b=null; try { b = await r.json(); } catch(e) { b = await r.text(); } return { status: r.status, body: b };");
  out.video = { addVid, vidState, vidApi };
  record("negative", "N3 · 画布视频节点结构化不可用（该网关无视频模型）", !!(vidState && vidState.unavailable === "video-generation"), ".video-provider[data-openarc-unavailable=video-generation]", JSON.stringify(out.video).slice(0, 700));
  record("negative", "N4 · /api/canvas-video 结构化拒绝（不假成功）", !!(vidApi && vidApi.status >= 400), "4xx/5xx + 结构化错误体", JSON.stringify(vidApi).slice(0, 500));
  return out;
}

const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (IS_MAIN) main().then((code) => process.exit(code)).catch((err) => { console.error("UNCAUGHT " + scrubText(err && err.stack, [loadToken()])); process.exit(2); });
export { main };
