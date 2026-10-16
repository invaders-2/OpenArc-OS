#!/usr/bin/env node
/**
 * dxos-anthropic-protocol · 真机验收：真实 Electron + 隔离 userData + 唯一 CDP 端口，
 * 由本地 mock（anthropic-mock.mjs）扮演 api.anthropic.com，验证：
 *   a0 真实 electron . 启动 + 登录（产品默认入口 dist/vue.html）
 *   C1 provider/create adapterType=anthropic（baseUrl=本地 mock, LOCALHOST）
 *   C2 credential/status；C3 provider/models（GET /v1/models，x-api-key + anthropic-version）
 *   C4 model/create（claude-opus-4-6, chat + vision-input）；C5 defaults/set chat
 *   E1 model/test（设置页「测试连接」的真实通道）→ inference:true
 *   E2 provider/call（对话出口，非流式）→ 真实文本；请求头/体由 mock 侧留证
 *   E3 provider/callStream（流式）→ 经 model:event 的增量文本分块到达（>=2 块）
 *   E4 对话 App（ChatApp → task/run → 全局 AI 通道）真实 UI 回复 + 截图
 *   E5 系统设置 › 模型与服务商 真实 UI 截图
 *   收工：真实 profile 只读快照前后比对；杀子进程；删隔离 userData
 *
 * 用法：node experiments/dxos-anthropic-protocol/run.mjs
 * 可选：OA_ANTHROPIC_CDP_PORT=9877 OA_ANTHROPIC_KEEP=1 OA_ANTHROPIC_ENTRIES=1,2,3,4,5
 * 说明：不做真实联网（api.anthropic.com 对本机匿名探测返回 403 "Request not allowed"），
 *       mock 只替代最后一跳网络；其余全部是真实主进程与真实产品入口。
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startAnthropicMock } from "./anthropic-mock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-anthropic-protocol");
const SHOTS = path.join(ART, "shots");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const KEEP = process.env.OA_ANTHROPIC_KEEP === "1";
const ENTRIES = String(process.env.OA_ANTHROPIC_ENTRIES || "1,2,3,4,5").split(",").map((s) => s.trim()).filter(Boolean);
const has = (id) => ENTRIES.includes(String(id));
const SECRET = "sk-ant-oa-mock-secret-1234567890";
const MODEL_ID = "claude-opus-4-6";
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
  s = s.split(SECRET).join("[REDACTED_KEY]");
  s = s.replace(/sk-[A-Za-z0-9._-]{8,}/g, "[REDACTED_KEY]");
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]");
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
async function clickWin(page, label, sel) { return page.evaluate((a) => { const w = document.querySelector(a.w); if (!w) return false; const el = w.querySelector(a.s); if (!el) return false; el.click(); return true; }, { w: winSel(label), s: sel }); }
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
async function maximize(page, label) {
  const aria = await page.evaluate((a) => { const w = document.querySelector(a.w); const b = w && w.querySelector(".maximize"); return b ? b.getAttribute("aria-label") : null; }, { w: winSel(label) });
  if (aria && aria.indexOf("最大化") === 0) {
    await clickWin(page, label, ".maximize");
    await waitFor(async () => { const r = await page.evaluate((a) => { const w = document.querySelector(a.w); if (!w) return null; const b = w.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }, { w: winSel(label) }); return !!r && Math.abs(r[3] - (900 - 38)) < 8; }, 8000, 200);
  }
  return true;
}
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

  const mock = await startAnthropicMock({ secret: SECRET });
  const realProfile = resolveRealProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  const profileProcBefore = processesUsing(realProfile);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-anthropic-"));
  const port = process.env.OA_ANTHROPIC_CDP_PORT ? Number(process.env.OA_ANTHROPIC_CDP_PORT) : await freePort();

  console.log("========== dxos-anthropic-protocol ==========");
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
  let exitCode = 0;
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

    const identifier = "anthropic-probe@openarc.test";
    const password = "AnthropicProbe-pass-1";
    const call = (channel, command, payload) => bridge(page, channel, command, payload);
    const init = await call("identity", "identity/initialize", { identifier, password, displayName: "Anthropic 探针管理员" });
    const login = await call("identity", "identity/login", { identifier, password });
    const gateReady = await waitFor(async () => (await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 30000, 200);
    record("identity", "a1 · identity/initialize + login 进入 ready", !!(init.result && init.result.ok === true && login.result && login.result.ok === true && gateReady), "ok:true + gate=ready", JSON.stringify({ init: init.result && init.result.ok, login: login.result && login.result.ok, gate: gateReady }));

    /* ── C1 provider/create adapterType=anthropic（一步带密钥） ── */
    const create = await call("model", "provider/create", { displayName: "Anthropic（官方协议 mock）", baseUrl: mock.baseUrl, adapterType: "anthropic", endpointScope: "LOCALHOST", scope: "PERSONAL", credentialSecret: SECRET });
    cfg.providerId = create.result && create.result.provider ? create.result.provider.providerId : null;
    record("config", "C1 · provider/create adapterType=anthropic", !!(create.result && create.result.ok === true && cfg.providerId), "ok:true + providerId + adapterType=anthropic", JSON.stringify(create.result).slice(0, 600));
    if (!cfg.providerId) throw new Error("provider/create 失败");
    record("config", "C1b · provider.adapterType 回读=anthropic", (create.result.provider.adapterType === "anthropic"), "anthropic", create.result.provider.adapterType);

    const credStatus = await call("model", "credential/status", { providerId: cfg.providerId });
    record("config", "C2 · credential/status configured:true（密钥不回显）", !!(credStatus.result && credStatus.result.configured === true), "configured:true", JSON.stringify(credStatus.result));

    const remote = await call("model", "provider/models", { providerId: cfg.providerId });
    const remoteIds = remote.result && Array.isArray(remote.result.items) ? remote.result.items.map((m) => m.id) : [];
    record("config", "C3 · provider/models 真实 GET /v1/models", !!(remote.result && remote.result.ok === true && remoteIds.length > 0), "ok:true + 非空清单", remoteIds.join(","));

    const modelCreate = await call("model", "model/create", { providerId: cfg.providerId, remoteModelId: MODEL_ID, displayName: "Claude Opus 4.6", capabilities: ["chat", "vision-input", "tool-calling"], scope: "PERSONAL" });
    cfg.configId = modelCreate.result && modelCreate.result.model ? modelCreate.result.model.configId : null;
    record("config", "C4 · model/create（" + MODEL_ID + "）", !!(modelCreate.result && modelCreate.result.ok === true && cfg.configId), "ok:true + configId", JSON.stringify(modelCreate.result).slice(0, 600));
    if (!cfg.configId) throw new Error("model/create 失败");

    const setChat = await call("model", "defaults/set", { capability: "chat", configId: cfg.configId, scope: "PERSONAL" });
    const setTools = await call("model", "defaults/set", { capability: "tool-calling", configId: cfg.configId, scope: "PERSONAL" });
    const setVision = await call("model", "defaults/set", { capability: "vision-input", configId: cfg.configId, scope: "PERSONAL" });
    const defaults = await call("model", "defaults/get", {});
    const bound = defaults.result && defaults.result.personal ? defaults.result.personal.chat : null;
    record("config", "C5 · defaults/set chat/tool-calling/vision-input + 回读", !!(setChat.result.ok && setTools.result.ok && setVision.result.ok && bound === cfg.configId), cfg.configId, JSON.stringify({ setChat: setChat.result.ok, setTools: setTools.result.ok, setVision: setVision.result.ok, bound }));
    report.evidence.provider = { providerId: cfg.providerId, adapterType: "anthropic", baseUrl: mock.baseUrl, configId: cfg.configId, remoteModelIds: remoteIds };

    /* ── E1 model/test + provider/call（非流式对话出口） ── */
    if (has(1)) {
      const mtest = await call("model", "model/test", { configId: cfg.configId });
      record("entry1", "E1 · model/test（「测试连接」真实模型通道）", !!(mtest.result && mtest.result.ok === true && mtest.result.inference === true), "ok:true + inference:true", JSON.stringify(mtest.result).slice(0, 400));

      const pcall = await call("model", "provider/call", { providerId: cfg.providerId, model: MODEL_ID, messages: [{ role: "system", content: "你是本地 mock" }, { role: "user", content: "只回复：ok" }], params: { max_tokens: 64 } });
      const callText = pcall.result && pcall.result.text;
      record("entry1", "E1b · provider/call 真实文本回复", !!(pcall.result && pcall.result.ok === true && String(callText || "").trim().length > 0), "ok:true + 非空 text", JSON.stringify({ text: callText, usage: pcall.result && pcall.result.usage, error: pcall.result && pcall.result.error }));
      const seen = mock.state.requests.filter((r) => r.url.endsWith("/messages")).at(-1);
      record("entry1", "E1c · mock 侧留证：POST /v1/messages", !!seen && seen.method === "POST" && seen.url === "/v1/messages", "POST /v1/messages", JSON.stringify({ method: seen && seen.method, url: seen && seen.url }));
      record("entry1", "E1d · 请求头 x-api-key + anthropic-version，且无 Authorization", !!seen && seen.hasApiKey && seen.apiKeyMatches && seen.anthropicVersion === "2023-06-01" && seen.hasAuthorization === false, "x-api-key 匹配 + anthropic-version=2023-06-01 + 无 authorization", JSON.stringify({ hasApiKey: seen && seen.hasApiKey, apiKeyMatches: seen && seen.apiKeyMatches, anthropicVersion: seen && seen.anthropicVersion, hasAuthorization: seen && seen.hasAuthorization, contentType: seen && seen.contentType }));
      report.evidence.providerCall = { text: callText, usage: pcall.result && pcall.result.usage, request: seen ? { method: seen.method, url: seen.url, hasApiKey: seen.hasApiKey, anthropicVersion: seen.anthropicVersion, hasAuthorization: seen.hasAuthorization } : null };
    }

    /* ── E2 provider/callStream（流式增量 → model:event） ── */
    if (has(2)) {
      await page.evaluate(() => {
        window.__oaAnthropicStream = [];
        if (window.__oaAnthropicStreamOff) { try { window.__oaAnthropicStreamOff(); } catch { /* ignore */ } }
        window.__oaAnthropicStreamOff = window.openarc.model.onEvent((e) => {
          try { if (e && e.payload) window.__oaAnthropicStream.push({ type: e.payload.type, text: e.payload.text == null ? null : String(e.payload.text), at: Date.now() }); } catch { /* ignore */ }
        });
        return true;
      });
      const t0 = Date.now();
      const streamed = await call("model", "provider/callStream", { providerId: cfg.providerId, model: MODEL_ID, messages: [{ role: "user", content: "流式说句话" }], params: { max_tokens: 64 } });
      await sleep(600);
      const events = await page.evaluate(() => window.__oaAnthropicStream || []);
      const deltas = events.filter((e) => e.type === "text.delta");
      const streamedText = streamed.result && streamed.result.text;
      record("entry2", "E2 · provider/callStream 聚合文本", !!(streamed.result && streamed.result.ok === true && String(streamedText || "").trim().length > 0), "ok:true + 非空 text", JSON.stringify({ text: streamedText, usage: streamed.result && streamed.result.usage, error: streamed.result && streamed.result.error }));
      record("entry2", "E2b · model:event 收到 >=2 个增量 text.delta（分块到达）", deltas.length >= 2, ">=2", JSON.stringify({ deltaCount: deltas.length, chunks: deltas.map((d) => d.text), types: events.map((e) => e.type).slice(0, 20), spanMs: deltas.length ? deltas[deltas.length - 1].at - t0 : null }));
      report.evidence.callStream = { text: streamedText, usage: streamed.result && streamed.result.usage, deltas: deltas.map((d) => d.text), events: events.map((e) => e.type), ms: Date.now() - t0 };
    }

    /* ── E3 系统设置 › 模型与服务商（真实 UI 截图） ── */
    if (has(3)) {
      const opened = await openApp(page, "settings", "系统设置");
      await sleep(600);
      const pane = await clickSel(page, '[data-settings-pane="model"]');
      await sleep(700);
      const testBtn = await clickSel(page, '[data-d4-01-test="' + cfg.providerId + '"]');
      let badge = null;
      if (testBtn) await waitFor(async () => { badge = await page.evaluate((pid) => { const el = document.querySelector('[data-d4-01-test-result="' + pid + '"]'); return el ? el.textContent.trim() : null; }, cfg.providerId); return !!badge; }, 60000, 500);
      const shots = await shootBoth(page, "03-settings-model");
      record("entry3", "E3 · 设置 › 模型与服务商 UI（测试连接）", !!(opened && pane), "窗口打开 + 模型面板可见", JSON.stringify({ opened, pane, testBtn, badge, shots: shots.map((s) => s.file) }));
      report.evidence.settingsShots = shots;
    }

    /* ── E4 对话 App 真实 UI 回复 ── */
    if (has(4)) {
      await closeControlCenter(page);
      await openApp(page, "chat", "对话");
      await maximize(page, "对话窗口");
      await sleep(400);
      const typed = await page.evaluate(() => {
        const win = document.querySelector('section.window[aria-label="对话窗口"]');
        const ta = win && win.querySelector('textarea[aria-label="消息"]');
        if (!ta) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, "请用一句话自我介绍");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      });
      await sleep(200);
      const sent = await clickWin(page, "对话窗口", ".chat-send");
      const got = await waitFor(async () => { const t = await readChat(page); return !!t && t.length > 0; }, 180000, 1000);
      const messages = await page.evaluate(() => {
        const win = document.querySelector('section.window[aria-label="对话窗口"]');
        if (!win) return null;
        return Array.prototype.slice.call(win.querySelectorAll(".chat-msg")).map((m) => ({ role: m.getAttribute("data-role"), pending: m.classList.contains("pending"), failed: m.classList.contains("failed"), text: (m.querySelector(".chat-bubble") || {}).textContent || "" }));
      });
      const errorLine = await readWinText(page, "对话窗口", ".chat-error");
      const assistant = (messages || []).filter((m) => m.role === "assistant" && !m.pending).pop();
      const reply = assistant ? assistant.text : null;
      const shots = await shootBoth(page, "04-chat");
      record("entry4", "E4 · 对话 App 真实 UI 出现模型回复", !!(got && assistant && reply && reply.trim().length && !assistant.failed && reply !== "思考中…"), "聊天气泡出现非占位、非失败的回复", JSON.stringify({ typed, sent, settled: got, reply: String(reply || "").slice(0, 300), errorLine, shots: shots.map((s) => s.file) }));
      report.evidence.chat = { typed, sent, settled: got, reply, errorLine, messages, shots };
      const chatCalls = mock.state.requests.filter((r) => r.url.endsWith("/messages"));
      record("entry4", "E4b · 对话走的是 Anthropic 线路（mock 收到 /v1/messages）", chatCalls.length > 0, ">=1", JSON.stringify({ messageCalls: chatCalls.length, authRejects: mock.state.authRejects, streamed: chatCalls.filter((r) => r.body && r.body.stream === true).length }));
    }

    /* ── E5 mock 侧全量请求证据 ── */
    if (has(5)) {
      const summary = mock.state.requests.map((r) => ({ method: r.method, url: r.url, hasApiKey: r.hasApiKey, anthropicVersion: r.anthropicVersion, hasAuthorization: r.hasAuthorization, stream: !!(r.body && r.body.stream), model: r.body && r.body.model, maxTokens: r.body && r.body.max_tokens, systemExtracted: !!(r.body && r.body.system) }));
      const anyBearer = summary.some((r) => r.hasAuthorization);
      const allVersioned = summary.every((r) => r.anthropicVersion === "2023-06-01");
      record("entry5", "E5 · mock 侧汇总：全部请求带 anthropic-version，且从未出现 Authorization", summary.length > 0 && allVersioned && !anyBearer, "anthropic-version=2023-06-01 且无 Authorization", JSON.stringify({ requests: summary.length, allVersioned, anyBearer, authRejects: mock.state.authRejects }));
      report.evidence.mockRequests = summary;
    }

    record("final", "F1 · 0 未捕获页面错误", pageErrors.length === 0, "0 pageerror", JSON.stringify(pageErrors.slice(0, 5)));
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
    record("final", "F2 · 真实 profile 未被本次探针改写", profileDiff.unchanged, "无变化", JSON.stringify(profileDiff));
    record("final", "F3 · 隔离 userData 无残留进程", leftover.length === 0, "0", JSON.stringify(leftover));
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
  exitCode = report.ok ? 0 : 1;
  return exitCode;
}

const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (IS_MAIN) main().then((code) => process.exit(code)).catch((err) => { console.error("UNCAUGHT " + err.stack); process.exit(2); });
export { main };
