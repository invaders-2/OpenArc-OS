#!/usr/bin/env node
/**
 * dxos-model-provider-edit · 「编辑服务商」+「拉取模型四类分组」真机端到端。
 *
 * 目标：
 *   ① 编辑服务商表单（含「允许不安全 HTTP」必选开关 + 橙色风险文案）；
 *   ② 拉取模型按四类（文本/图像/视频/音频）+ 未识别分组展示；
 *   ③ 从列表加入某个模型后的「已加入」状态。
 *
 * 隔离：独立 userData 目录 + 唯一 CDP 端口；截图 1440x900@2（PNG 2880x1800），浅/深各一张。
 * 上游：本进程内起一个只实现 GET /v1/models 的本地 fake provider（loopback http，真实网络请求）。
 * 公网明文服务商只用于复现「不安全 HTTP」开关，不发起任何真实调用。
 */
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-model-provider-edit");
const SHOTS = path.join(ART, "shots");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const PUBLIC_HTTP = process.env.OA_MPE_PUBLIC_HTTP || "http://43.130.6.197:8080";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const MODELS = [
  { id: "deepseek-chat", owned_by: "deepseek" },
  { id: "gpt-4o", owned_by: "openai" },
  { id: "dall-e-3", owned_by: "openai" },
  { id: "seedream-4", owned_by: "volcengine" },
  { id: "seedance-1", owned_by: "volcengine" },
  { id: "sora", owned_by: "openai" },
  { id: "whisper-1", owned_by: "openai" },
  { id: "text-embedding-3-large", owned_by: "openai" },
];
function startModelsServer() {
  const state = { requests: 0, urls: [], auth: [] };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    state.urls.push(req.method + " " + req.url);
    state.auth.push(req.headers.authorization || null);
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: MODELS }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
      state,
      close: () => new Promise((r) => { try { server.closeAllConnections?.(); } catch { /* ignore */ } server.close(() => r()); }),
    }));
  });
}

async function bridge(page, channel, command, payload) {
  return page.evaluate(async (arg) => {
    const api = window.openarc[arg.channel];
    if (!api || typeof api.command !== "function") return { __noBridge: true };
    const request = arg.channel === "identity" ? Object.assign({ type: arg.command }, arg.payload) : { command: arg.command, payload: arg.payload };
    try { return await api.command(request); } catch (err) { return { __threw: true, message: String((err && err.message) || err) }; }
  }, { channel, command, payload: payload || {} });
}
const winSel = (label) => 'section.window[aria-label="' + label + '"]';
const clickSel = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
function setInputValue(page, sel, value) {
  return page.evaluate((arg) => {
    const el = document.querySelector(arg.sel); if (!el) return false;
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, arg.value);
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    return true;
  }, { sel, value });
}
function setChecked(page, sel, checked) {
  return page.evaluate((arg) => {
    const el = document.querySelector(arg.sel); if (!el) return false;
    if (el.checked !== arg.checked) el.click();
    return el.checked === arg.checked;
  }, { sel, checked });
}
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
async function scrollTo(page, sel, block = "start") {
  return page.evaluate((arg) => { const el = document.querySelector(arg.sel); if (!el) return false; el.scrollIntoView({ block: arg.block, inline: "nearest" }); return true; }, { sel, block });
}
async function shoot(page, name, theme, shots) {
  const file = path.join(SHOTS, name + "-" + theme + ".png");
  const s = await page.context().newCDPSession(page);
  const res = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  try { await s.detach(); } catch { /* ignore */ }
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  const buf = fs.readFileSync(file);
  const rec = { file: path.relative(ROOT, file), theme, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length, sha256_12: sha256(buf).slice(0, 12), at2880x1800: buf.readUInt32BE(16) === 2880 && buf.readUInt32BE(20) === 1800 };
  shots.push(rec);
  return rec;
}
async function shootBoth(page, name, shots, prepare) {
  const out = [];
  for (const t of ["light", "dark"]) {
    await setTheme(page, t);
    await closeControlCenter(page);
    if (prepare) await prepare();
    await sleep(350);
    out.push(await shoot(page, name, t, shots));
  }
  return out;
}

async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  fs.mkdirSync(SHOTS, { recursive: true });

  const rows = []; const shots = []; const notes = [];
  const record = (name, ok, expected, actual) => { const row = { name, ok: !!ok, expected: String(expected).slice(0, 400), actual: String(actual).slice(0, 900) }; rows.push(row); console.log((row.ok ? "PASS " : "FAIL ") + name + " :: " + row.actual); return row.ok; };
  const note = (s) => { notes.push(String(s)); console.log("   · " + s); };

  const modelsServer = await startModelsServer();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-model-provider-edit-"));
  const port = await freePort();
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;

  let child = null; let browser = null; let page = null;
  let loopbackPid = null; let publicPid = null;
  const report = { at: new Date().toISOString(), userDataIsolated: true, cdpPort: port, upstreamModels: MODELS.map((m) => m.id), publicHttp: PUBLIC_HTTP, fakeBaseUrl: modelsServer.baseUrl, modelRequests: [] };
  try {
    child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    let stderrBuf = ""; child.stderr.on("data", (d) => { stderrBuf += String(d); });

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

    const identifier = "model-provider-edit-probe-" + Date.now() + "@openarc.test";
    const password = "ModelProviderEdit-pass-1";
    await bridge(page, "identity", "identity/initialize", { identifier, password, displayName: "编辑服务商探针管理员" });
    const login = await bridge(page, "identity", "identity/login", { identifier, password });
    record("I1 · identity/initialize + login", !!(login && login.ok), "ok:true", JSON.stringify(login == null ? null : { ok: login.ok, type: login.type, userId: login.snapshot && login.snapshot.userId }).slice(0, 300));

    const settingsOpen = await openApp(page, "settings", "系统设置");
    await waitFor(async () => !!(await page.$('[data-settings-pane="model"]')), 20000, 300);
    await clickSel(page, '[data-settings-pane="model"]');
    const paneReady = await waitFor(async () => !!(await page.$('[data-d4-01="settings"]')), 20000, 300);
    record("U0 · 打开 系统设置 › 模型与服务商", settingsOpen && paneReady, "settings pane", JSON.stringify({ settingsOpen, paneReady }));

    /* ── 1) UI 创建一个 loopback 服务商（真实上游 = 本地 fake /v1/models） ── */
    await clickSel(page, '[data-d4-01-provider-add]');
    await waitFor(async () => !!(await page.$('[data-d4-01-provider-form]')), 8000, 200);
    await setInputValue(page, '[data-d4-01-provider-name]', "本地模型清单");
    await setInputValue(page, '[data-d4-01-provider-url]', modelsServer.baseUrl);
    await setInputValue(page, '[data-d4-01-provider-secret]', "sk-local-models");
    await clickSel(page, '[data-d4-01-provider-create]');
    const loopbackDetail = await waitFor(async () => !!(await page.$('[data-d4-01-provider-detail]')), 20000, 250);
    loopbackPid = await page.evaluate(() => document.querySelector('[data-d4-01-provider-detail]')?.getAttribute('data-d4-01-provider-detail') || null);
    record("S1 · UI 创建 loopback 服务商并进入详情", !!(loopbackDetail && loopbackPid), "detail visible", JSON.stringify({ loopbackPid }));

    /* ── 2) UI 创建公网明文 http 服务商（用于「不安全 HTTP」开关） ── */
    await clickSel(page, '[data-d4-01-provider-add]');
    await waitFor(async () => !!(await page.$('[data-d4-01-provider-form]')), 8000, 200);
    await setInputValue(page, '[data-d4-01-provider-name]', "Sub2API 明文直连");
    await setInputValue(page, '[data-d4-01-provider-url]', PUBLIC_HTTP);
    const optShown = await waitFor(async () => !!(await page.$('[data-d4-01-provider-insecure-http]')), 8000, 200);
    const warnText = await page.evaluate(() => (document.querySelector('[data-d4-01-provider-insecure-warning]')?.textContent || '').trim());
    await setChecked(page, '[data-d4-01-provider-insecure-http]', true);
    await setInputValue(page, '[data-d4-01-provider-secret]', "sk-plain-http");
    await clickSel(page, '[data-d4-01-provider-create]');
    const publicDetail = await waitFor(async () => !!(await page.$('[data-d4-01-provider-detail]')), 20000, 250);
    publicPid = await page.evaluate(() => document.querySelector('[data-d4-01-provider-detail]')?.getAttribute('data-d4-01-provider-detail') || null);
    const badge = await page.evaluate(() => { const el = document.querySelector('[data-d4-01-provider-insecure-badge]'); return el ? { text: el.textContent.trim(), title: el.getAttribute('title') } : null; });
    record("S2 · 公网明文服务商：开关 + 橙色警示 + 详情徽标", !!(optShown && publicDetail && publicPid && badge && /不安全/.test(badge.text)), "checkbox + warning + badge", JSON.stringify({ optShown, warnText: warnText.slice(0, 160), publicPid, badge }));

    /* ── ① 编辑服务商表单（含明文开关与警告） ── */
    await clickSel(page, '[data-d4-01-provider-edit="' + publicPid + '"]');
    const editOk = await waitFor(async () => !!(await page.$('[data-d4-01-provider-edit-form="' + publicPid + '"]')), 10000, 200);
    const editState = await page.evaluate((pid) => {
      const root = document.querySelector('[data-d4-01-provider-edit-form="' + pid + '"]');
      if (!root) return null;
      const cb = root.querySelector('[data-d4-01-provider-insecure-http]');
      return {
        mode: root.querySelector('[data-d4-01-provider-form]')?.getAttribute('data-d4-01-provider-form-mode') || null,
        name: root.querySelector('[data-d4-01-provider-name]')?.value || null,
        url: root.querySelector('[data-d4-01-provider-url]')?.value || null,
        checkbox: !!cb, checked: cb ? cb.checked : null,
        warning: (root.querySelector('[data-d4-01-provider-insecure-warning]')?.textContent || '').trim(),
        scopeDisabled: root.querySelector('[data-d4-01-provider-scope]')?.disabled === true,
        status: root.querySelector('[data-d4-01-provider-status]')?.value || null,
        encryptMissing: !root.querySelector('[data-d4-01-provider-secret]')?.value,
      };
    }, publicPid);
    record("E1 · 编辑表单复用同一套字段 + 明文开关 + 风险文案", !!(editOk && editState && editState.mode === "edit" && editState.checkbox === true && editState.checked === true && /明文 HTTP/.test(editState.warning) && /中间人/.test(editState.warning) && editState.encryptMissing === true), "edit mode / checkbox / warning / 密钥不回显", JSON.stringify(editState).slice(0, 600));
    await shootBoth(page, "01-provider-edit-insecure", shots, () => scrollTo(page, '[data-d4-01-provider-edit-form="' + publicPid + '"]'));

    /* ── ② 拉取模型 · 四类分组 ── */
    await clickSel(page, '[data-d4-01-provider="' + loopbackPid + '"]');
    await waitFor(async () => !!(await page.$('[data-d4-01-provider-detail="' + loopbackPid + '"]')), 15000, 250);
    await clickSel(page, '[data-d4-01-pull="' + loopbackPid + '"]');
    const pulled = await waitFor(async () => !!(await page.$('[data-d4-01-remote="' + loopbackPid + '"]')), 20000, 250);
    await waitFor(async () => !!(await page.$('[data-d4-01-remote-group="text"]')), 8000, 200);
    const groupState = await page.evaluate((pid) => {
      const root = document.querySelector('[data-d4-01-remote="' + pid + '"]');
      if (!root) return null;
      const groups = ["text", "image", "video", "audio", "unknown"].map((id) => ({
        id,
        label: (root.querySelector('[data-d4-01-remote-group="' + id + '"] b')?.textContent || '').trim(),
        count: Number((root.querySelector('[data-d4-01-remote-group-n="' + id + '"]')?.textContent || '0').trim()),
        note: (root.querySelector('[data-d4-01-remote-group-note="' + id + '"]')?.textContent || '').trim(),
        empty: (root.querySelector('[data-d4-01-remote-group-empty="' + id + '"]')?.textContent || '').trim(),
        ids: Array.prototype.slice.call(root.querySelectorAll('[data-d4-01-remote-pick]')).filter((el) => el.closest('[data-d4-01-remote-group="' + id + '"]')).map((el) => el.getAttribute('data-d4-01-remote-pick')),
      }));
      return { groups };
    }, loopbackPid);
    const gc = groupState ? Object.fromEntries(groupState.groups.map((g) => [g.id, g.count])) : {};
    record("P1 · 拉取模型按四类 + 未识别分组（2/2/2/0/2）", !!(pulled && groupState && gc.text === 2 && gc.image === 2 && gc.video === 2 && gc.audio === 0 && gc.unknown === 2), "text2 image2 video2 audio0 unknown2", JSON.stringify({ gc, groups: groupState ? groupState.groups.map((g) => ({ id: g.id, label: g.label, count: g.count, empty: g.empty.slice(0, 40) })) : null }).slice(0, 800));
    const audio = groupState && groupState.groups.find((g) => g.id === "audio");
    record("P2 · 音频组为空且写明「模型域当前没有音频能力枚举」", !!(audio && audio.count === 0 && /模型域当前没有音频能力枚举/.test(audio.note + audio.empty)), "audio empty + note", JSON.stringify(audio).slice(0, 400));
    await shootBoth(page, "02-remote-groups", shots, () => scrollTo(page, '[data-d4-01-remote="' + loopbackPid + '"]'));
    await shootBoth(page, "02b-remote-groups-tail", shots, () => scrollTo(page, '[data-d4-01-remote-group="audio"]'));

    /* ── ③ 加入某模型后的状态 ── */
    await clickSel(page, '[data-d4-01-remote-add-item="deepseek-chat"]');
    const registered = await waitFor(async () => !!(await page.$('[data-d4-01-remote-registered="deepseek-chat"]')), 15000, 200);
    const joinState = await page.evaluate((pid) => {
      const root = document.querySelector('[data-d4-01-remote="' + pid + '"]');
      const badge = root ? root.querySelector('[data-d4-01-remote-registered="deepseek-chat"]') : null;
      const modelRow = document.querySelector('[data-d4-01-model]');
      return {
        registeredText: badge ? badge.textContent.trim() : null,
        caps: (root && root.querySelector('[data-d4-01-remote-caps="deepseek-chat"]')?.textContent || '').trim(),
        modelCount: document.querySelectorAll('[data-d4-01-model]').length,
        firstModelId: modelRow ? modelRow.getAttribute('data-d4-01-model') : null,
      };
    }, loopbackPid);
    record("R1 · 加入模型后出现「已加入」状态标记 + 模型进入清单", !!(registered && joinState && /已加入/.test(joinState.registeredText || '') && joinState.modelCount >= 1), "已加入 badge + model list", JSON.stringify(joinState).slice(0, 400));
    await shootBoth(page, "03-remote-registered", shots, () => scrollTo(page, '[data-d4-01-remote="' + loopbackPid + '"]'));

    report.ui = { settingsOpen, paneReady, optShown, warnText: warnText.slice(0, 200), editState, groupState, joinState, shots };
    report.shots = shots;
    report.modelRequests = modelsServer.state.urls.slice(-5);
  } catch (err) {
    report.fatal = String((err && err.stack) || err);
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child && !child.killed) child.kill("SIGTERM"); } catch { /* ignore */ }
    await sleep(800);
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(path.join(userDataDir, "identity.db"), { readOnly: true });
      const providers = db.prepare("SELECT provider_id, display_name, base_url, endpoint_scope, allow_insecure_http FROM model_providers ORDER BY rowid").all();
      const configs = db.prepare("SELECT provider_id, remote_model_id, capabilities FROM model_configs ORDER BY rowid").all();
      db.close();
      report.modelProviders = providers;
      report.modelConfigs = configs;
      const pub = providers.find((p) => p.provider_id === publicPid);
      const loop = providers.find((p) => p.provider_id === loopbackPid);
      record("D1 · 公网明文服务商落库 allow_insecure_http=1，loopback 为 0", !!(pub && pub.allow_insecure_http === 1 && loop && loop.allow_insecure_http === 0), "public=1 / loopback=0", JSON.stringify({ pub, loop }));
      const cfg = configs.find((c) => c.remote_model_id === "deepseek-chat");
      record("D2 · 加入的模型 capabilities 来自真实推断（chat）", !!(cfg && JSON.parse(cfg.capabilities).join(",") === "chat"), "deepseek-chat → chat", JSON.stringify(cfg || null));
    } catch (e) {
      report.dbError = String((e && e.message) || e);
      record("D1 · 数据库核对", false, "可查询", report.dbError.slice(0, 300));
    }
    await modelsServer.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify({ ...report, rows, notes }, null, 2));
  const pass = rows.filter((r) => r.ok).length;
  console.log("SUMMARY " + pass + "/" + rows.length + " pass; report=" + path.relative(ROOT, path.join(ART, "report.json")));
  if (pass !== rows.length) process.exitCode = 1;
  return { pass, total: rows.length };
}

main().catch((err) => { console.error("PROBE FAILED " + String((err && err.stack) || err).slice(0, 1200)); process.exit(2); });
