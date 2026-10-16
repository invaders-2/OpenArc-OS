#!/usr/bin/env node
/**
 * dxos-ui-global-model · 「模型接上去之后是否全局生效」端到端实测。
 * 详见同目录 README.md。硬约束：不改产品代码；不新增依赖；不跑 build/test；不 git。
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
const ART = path.join(ROOT, "artifacts", "dxos-ui-global-model");
const SHOTS = path.join(ART, "shots");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const ENTRY_FILTER = String(process.env.OA_GM_ENTRIES || "1,2,3,4,5,6,7").split(",").map((s) => s.trim()).filter(Boolean);
const KEEP_USERDATA = process.env.OA_GM_KEEP === "1";
const DEEPSEEK_BASE = process.env.OA_GM_DEEPSEEK_BASE || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.OA_GM_DEEPSEEK_MODEL || "deepseek-chat";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const has = (id) => ENTRY_FILTER.includes(String(id));

function readDeepSeekKey() {
  const p = path.join(os.homedir(), ".dsh", ".credentials.yaml");
  const txt = fs.readFileSync(p, "utf8");
  const m = txt.match(/DEEPSEEK_API_KEY\s*:\s*(.+)$/m);
  if (!m) throw new Error("credentials 里没有 refs.DEEPSEEK_API_KEY");
  const v = m[1].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
  if (!v) throw new Error("DEEPSEEK_API_KEY 为空");
  return v;
}
const SECRET = readDeepSeekKey();
const SECRET_META = { length: SECRET.length, prefixSk: SECRET.startsWith("sk-"), sha256_12: crypto.createHash("sha256").update(SECRET).digest("hex").slice(0, 12) };
function scrub(v) {
  let s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  s = s.split(SECRET).join("[REDACTED_KEY]");
  s = s.replace(/sk-[A-Za-z0-9._-]{8,}/g, "[REDACTED_KEY]");
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]");
  return s;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function waitFor(fn, timeoutMs, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await fn()) return true; } catch { /* retry */ }
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}
function msSince(t) { return Date.now() - t; }

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

let CAPTURES = [];
const captureIndexIn = (rec) => { CAPTURES.push(rec); };

async function main() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  const electronVersion = (() => { try { return require("electron/package.json").version; } catch { return null; } })();

  fs.mkdirSync(SHOTS, { recursive: true });
  CAPTURES = [];

  const rows = [];
  const notes = [];
  const entries = {};
  const reverse = {};
  const consoleAll = [];
  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  const nonLocal = [];
  const LOCAL_RE = /^(file:|data:|blob:|about:|devtools:|openarc-file:|openarc-resource:|openarc-canvas:|chrome-extension:|http:\/\/127\.0\.0\.1|http:\/\/localhost|http:\/\/\[::1\]|ws:\/\/127\.0\.0\.1|ws:\/\/localhost)/i;

  const record = (section, name, ok, expected, actual, detail) => {
    const row = { section, name, ok: !!ok, expected: scrub(expected), actual: scrub(actual).slice(0, 800), detail: detail ? scrub(detail).slice(0, 1500) : null };
    rows.push(row);
    console.log((row.ok ? "PASS" : "FAIL") + " [" + section + "] " + name + " :: actual=" + row.actual + " || expected=" + row.expected);
    return row.ok;
  };
  const note = (s) => { notes.push(scrub(s)); console.log("   · " + scrub(s)); };

  const realProfile = resolveRealProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  const profileProcBefore = processesUsing(realProfile);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-gm-"));
  const port = process.env.OA_GM_CDP_PORT ? Number(process.env.OA_GM_CDP_PORT) : await freePort();
  const launchArgs = [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port];

  console.log("========== dxos-ui-global-model ==========");
  console.log("渲染源：dist/vue.html（产品默认入口）");
  console.log("隔离 userData：" + userDataDir);
  console.log("CDP 端口：" + port);
  console.log("electron：" + electronVersion + " / " + electronPath);
  console.log("DeepSeek baseUrl：" + DEEPSEEK_BASE + " / model：" + DEEPSEEK_MODEL);
  console.log("密钥体检（不含明文）：" + JSON.stringify(SECRET_META));

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  let child = null, browser = null, page = null, cdp = null;
  let stdoutBuf = "", stderrBuf = "";
  const exitInfo = { clean: false, code: null, signal: null };
  let fatal = null;
  const startedAt = Date.now();
  const cfg = { providerId: null, configId: null, models: [], defaultsGet: null, literalAttempt: null };
  let modelsEvidence = null;
  let preRepair = null;
  let repairEvidence = null;

  try {
    child = spawn(electronPath, launchArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout.on("data", (d) => { stdoutBuf += String(d); });
    child.stderr.on("data", (d) => { stderrBuf += String(d); });

    const ready = await waitFor(async () => { try { const r = await fetch("http://127.0.0.1:" + port + "/json/version"); return r.ok; } catch { return false; } }, 60000, 300);
    if (!ready) throw new Error("CDP 未就绪：" + stderrBuf.slice(-600));

    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const ctx = browser.contexts()[0];
    const isUI = (p) => p.url().indexOf("vue.html") >= 0;
    const found = await waitFor(() => !!ctx.pages().find(isUI), 45000, 300);
    page = ctx.pages().find(isUI) || null;
    if (!found || !page) throw new Error("未找到 Vue 壳页面：" + ctx.pages().map((p) => p.url()).join(" | "));

    page.on("console", (m) => { const r = { type: m.type(), text: scrub(String(m.text())).slice(0, 400) }; consoleAll.push(r); if (r.type === "error") consoleErrors.push(r.text); });
    page.on("pageerror", (e) => pageErrors.push(scrub(String((e && e.message) || e)).slice(0, 400)));
    page.on("request", (r) => { requests.push(r.url()); if (!LOCAL_RE.test(r.url())) nonLocal.push(r.url()); });
    page.on("requestfailed", (r) => requests.push("FAILED " + r.url()));

    const bootOk = await waitFor(async () => {
      const v = await page.evaluate(() => ({ rs: document.readyState, n: window.openarc ? Object.keys(window.openarc).length : 0 }));
      return v && v.rs === "complete" && v.n > 0;
    }, 45000, 300);
    if (!bootOk) throw new Error("渲染层未就绪");

    cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await sleep(500);

    const bridgeKeys = await page.evaluate(() => Object.keys(window.openarc));
    console.log("桥面键：" + bridgeKeys.join(","));
    record("boot", "B1 · 真实 electron + preload + dist/vue.html 渲染就绪", bootOk, "readyState=complete + 非空桥面", JSON.stringify(await page.evaluate(() => ({ url: location.href, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, keys: Object.keys(window.openarc) }))));

    const identifier = "global-model@openarc.test";
    const password = "GlobalModel-pass-1";
    const call = (channel, command, payload) => bridge(page, channel, command, payload);
    const init = await call("identity", "identity/initialize", { identifier, password, displayName: "全局模型探针管理员" });
    const login = await call("identity", "identity/login", { identifier, password });
    const gateReady = await waitFor(async () => (await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 30000, 200);
    record("identity", "I0 · identity/initialize 首启", !!(init.result && init.result.ok === true), "ok:true", JSON.stringify(init.result).slice(0, 300));
    record("identity", "I1 · identity/login 进入 ready", !!(login.result && login.result.ok === true) && gateReady, "ok:true + gate=ready", JSON.stringify({ ok: login.result && login.result.ok, gate: gateReady }));
    if (!gateReady) throw new Error("登录后桌面未就绪");
    note("隔离 userData 内 identity.db 存在=" + fs.existsSync(path.join(userDataDir, "identity.db")));

    /* ── 一、配置一次真实 DeepSeek ── */
    const create = await call("model", "provider/create", { displayName: "DeepSeek", baseUrl: DEEPSEEK_BASE, adapterType: "openai-compatible", endpointScope: "REMOTE_HTTPS", scope: "PERSONAL" });
    cfg.providerId = create.result && create.result.provider ? create.result.provider.providerId : null;
    record("config", "C1 · provider/create（baseUrl=" + DEEPSEEK_BASE + "）", !!(create.result && create.result.ok === true && cfg.providerId), "ok:true + providerId", JSON.stringify(create.result).slice(0, 500));
    if (!cfg.providerId) throw new Error("provider/create 失败，后续无法继续");

    const credSet = await call("model", "credential/set", { providerId: cfg.providerId, secret: SECRET });
    const credStatus = await call("model", "credential/status", { providerId: cfg.providerId });
    record("config", "C2 · credential/set（密钥不回显）", !!(credSet.result && credSet.result.ok === true), "ok:true", JSON.stringify(credSet.result).slice(0, 300));
    record("config", "C3 · credential/status 回读", !!(credStatus.result && credStatus.result.configured === true), "configured:true", JSON.stringify(credStatus.result).slice(0, 300));

    const tModels = Date.now();
    const remote = await call("model", "provider/models", { providerId: cfg.providerId });
    const remoteMs = msSince(tModels);
    const remoteIds = remote.result && Array.isArray(remote.result.items) ? remote.result.items.map((m) => m.id) : [];
    cfg.models = remoteIds;
    record("config", "C4 · provider/models 真实 GET " + DEEPSEEK_BASE + "/models", !!(remote.result && remote.result.ok === true && remoteIds.length > 0), "ok:true + 非空模型清单", remoteIds.join(",") + "（" + remoteMs + "ms）", JSON.stringify(remote.result).slice(0, 900));
    modelsEvidence = { requestUrl: DEEPSEEK_BASE.replace(/\/$/, "") + "/models", ms: remoteMs, ids: remoteIds, raw: remote.result };

    const modelCreate = await call("model", "model/create", { providerId: cfg.providerId, remoteModelId: DEEPSEEK_MODEL, displayName: "DeepSeek Chat", capabilities: ["chat", "tool-calling"], scope: "PERSONAL" });
    cfg.configId = modelCreate.result && modelCreate.result.model ? modelCreate.result.model.configId : null;
    record("config", "C5 · model/create（capabilities=chat,tool-calling）", !!(modelCreate.result && modelCreate.result.ok === true && cfg.configId), "ok:true + configId", JSON.stringify(modelCreate.result).slice(0, 500));
    if (!cfg.configId) throw new Error("model/create 失败");

    const literalSet = await call("model", "defaults/set", { capability: "llm.chat", configId: cfg.configId, scope: "PERSONAL" });
    const literalGet = await call("model", "defaults/get", {});
    cfg.literalAttempt = { set: literalSet.result, get: literalGet.result };
    record("config", "C6 · defaults/set capability=llm.chat（用户口径，如实记录）", !!(literalSet.result && literalSet.result.ok === true), "记录真实行为", JSON.stringify(literalSet.result).slice(0, 300), JSON.stringify(literalGet.result).slice(0, 500));

    const setChat = await call("model", "defaults/set", { capability: "chat", configId: cfg.configId, scope: "PERSONAL" });
    const setTools = await call("model", "defaults/set", { capability: "tool-calling", configId: cfg.configId, scope: "PERSONAL" });
    const getDefaults = await call("model", "defaults/get", {});
    cfg.defaultsGet = getDefaults.result;
    const boundChat = getDefaults.result && getDefaults.result.personal ? getDefaults.result.personal.chat : null;
    record("config", "C7 · defaults/set capability=chat（实现的能力枚举）", !!(setChat.result && setChat.result.ok === true), "ok:true", JSON.stringify(setChat.result).slice(0, 300));
    record("config", "C8 · defaults/set capability=tool-calling", !!(setTools.result && setTools.result.ok === true), "ok:true", JSON.stringify(setTools.result).slice(0, 300));
    record("config", "C9 · defaults/get 回读 personal.chat === configId", boundChat === cfg.configId, cfg.configId, JSON.stringify(getDefaults.result).slice(0, 600), JSON.stringify({ personalKeys: Object.keys((getDefaults.result && getDefaults.result.personal) || {}) }));
    note("defaults/get 回读：" + scrub(JSON.stringify(getDefaults.result)));

    /* ── 一之补 · 历史留证（修复前曾为 ENDPOINT_BLOCKED）：credential/set 存的是未归一化的 base_url，
          旧缺陷下所有调用出口比对 "providerOrigin !== new URL(baseUrl).origin" → ENDPOINT_BLOCKED；
          该缺陷已修，故下方 P1 改断言修复后的正确行为（ok:true + 非空文本），同时保留这段考古信息。 ── */
    preRepair = {};
    {
      const cv = await call("canvas", "canvas/create", { title: "修复前探针画布", icon: "freeform", kind: "canvas" });
      const cid = cv.result && cv.result.canvas ? (cv.result.canvas.canvasId || cv.result.canvas.id) : null;
      const rn = cid ? await call("canvas", "canvas/run", { canvasId: cid, kind: "chat", nodeId: null }) : { result: {} };
      const rid = rn.result && (rn.result.runId || (rn.result.run && rn.result.run.runId));
      preRepair.canvasModelChat = rid ? (await call("canvas", "canvas/modelChat", { canvasId: cid, runId: rid, messages: [{ role: "user", content: "只回复：ok" }] })).result : rn.result;
      preRepair.taskRun = (await call("task", "task/run", { goal: "只回复：ok" })).result;
      preRepair.skillRun = (await call("skill", "skill/run", { skillId: "chat", arguments: { instruction: "只回复：ok" } })).result;
      preRepair.photosVision = (await call("photos", "photos/visionModels", {})).result;
    }
    record("preRepair", "P1 · 画布 canvas/modelChat（修复前曾为 ENDPOINT_BLOCKED，修复后应为 ok:true + 非空文本）", !!(preRepair.canvasModelChat && preRepair.canvasModelChat.ok === true && String(preRepair.canvasModelChat.text || "").trim().length), "ok:true + 非空文本", JSON.stringify(preRepair.canvasModelChat).slice(0, 300));
    record("preRepair", "P2 · 修复前 task/run 原始返回", true, "记录真实行为", JSON.stringify(preRepair.taskRun).slice(0, 300));
    record("preRepair", "P3 · 修复前 skill/run 原始返回", true, "记录真实行为", JSON.stringify(preRepair.skillRun).slice(0, 300));

    /* ── 一之补 · 正确路径重配：provider/create 一步带密钥（= 设置页「添加服务商」填密钥那条路，
          providerOrigin 取 ep.origin，已归一化），并从它重建默认模型 ── */
    const cfgBroken = { providerId: cfg.providerId, configId: cfg.configId };
    const create2 = await call("model", "provider/create", { displayName: "DeepSeek（一步带密钥）", baseUrl: DEEPSEEK_BASE, adapterType: "openai-compatible", endpointScope: "REMOTE_HTTPS", scope: "PERSONAL", credentialSecret: SECRET });
    const provider2 = create2.result && create2.result.provider ? create2.result.provider.providerId : null;
    record("repair", "C10 · provider/create { credentialSecret }（ep.origin 归一化路径）", !!(create2.result && create2.result.ok === true && provider2), "ok:true + providerId", JSON.stringify(create2.result).slice(0, 400));
    const tM2 = Date.now();
    const remote2 = provider2 ? await call("model", "provider/models", { providerId: provider2 }) : { result: {} };
    record("repair", "C11 · 正确路径 provider/models 真实 GET " + DEEPSEEK_BASE + "/models", !!(remote2.result && remote2.result.ok === true), "ok:true + 非空清单", JSON.stringify(remote2.result).slice(0, 500), String(msSince(tM2) + "ms"));
    const mc2 = provider2 ? await call("model", "model/create", { providerId: provider2, remoteModelId: DEEPSEEK_MODEL, displayName: "DeepSeek Chat", capabilities: ["chat", "tool-calling"], scope: "PERSONAL" }) : { result: {} };
    const config2 = mc2.result && mc2.result.model ? mc2.result.model.configId : null;
    record("repair", "C12 · 正确路径 model/create", !!(mc2.result && mc2.result.ok === true && config2), "ok:true + configId", JSON.stringify(mc2.result).slice(0, 400));
    if (config2) {
      await call("model", "defaults/set", { capability: "chat", configId: config2, scope: "PERSONAL" });
      await call("model", "defaults/set", { capability: "tool-calling", configId: config2, scope: "PERSONAL" });
    }
    const getDef2 = await call("model", "defaults/get", {});
    record("repair", "C13 · defaults/get 回读（正确路径 config 为默认）", !!(getDef2.result && getDef2.result.personal && getDef2.result.personal.chat === config2), config2, JSON.stringify(getDef2.result).slice(0, 400));
    const tMT2 = Date.now();
    const mtest2 = config2 ? await call("model", "model/test", { configId: config2 }) : { result: {} };
    record("repair", "C14 · 正确路径 model/test 真实推理", !!(mtest2.result && mtest2.result.ok === true && mtest2.result.inference === true), "ok:true + inference:true", JSON.stringify(mtest2.result).slice(0, 300), String(msSince(tMT2) + "ms"));
    const e1c = provider2 ? await call("model", "provider/call", { providerId: provider2, model: DEEPSEEK_MODEL, messages: [{ role: "user", content: "只回复：ok" }], params: { max_tokens: 16 } }) : { result: {} };
    record("repair", "C15 · 正确路径 provider/call（P2 供应商存储仍为空 → 如实报错）", true, "记录真实行为", JSON.stringify(e1c.result).slice(0, 300));
    repairEvidence = { brokenPath: cfgBroken, create: create2.result, remoteModels: remote2.result, modelCreate: mc2.result, defaults: getDef2.result, modelTest: mtest2.result, providerCall: e1c.result };
    if (config2) { cfg.providerId = provider2; cfg.configId = config2; }
    note("正确路径重配完成：providerId=" + provider2 + " configId=" + config2 + "；后续入口实测均使用该默认模型");

    /* ── 入口 1 ── */
    if (has(1)) {
      const e = { id: "1-model-settings", name: "模型设置 · 快速测试" };
      const t = Date.now();
      const pcall = await call("model", "provider/call", { providerId: cfg.providerId, model: DEEPSEEK_MODEL, messages: [{ role: "user", content: "只回复：ok" }], params: { max_tokens: 16 } });
      e.providerCall = { ms: msSince(t), raw: scrub(JSON.stringify(pcall.result)).slice(0, 700) };
      const t2 = Date.now();
      const mtest = await call("model", "model/test", { configId: cfg.configId });
      e.modelTest = { ms: msSince(t2), raw: scrub(JSON.stringify(mtest.result)).slice(0, 700) };
      await openApp(page, "settings", "系统设置");
      const paneOk = await clickSel(page, '[data-settings-pane="model"]');
      await sleep(500);
      e.paneClicked = paneOk;
      e.rowClicked = await clickSel(page, '[data-d4-01-provider="' + cfg.providerId + '"]');
      await sleep(400);
      const testBtn = await clickSel(page, '[data-d4-01-test="' + cfg.providerId + '"]');
      const testText = testBtn ? await waitFor(async () => {
        const v = await page.evaluate((pid) => { const el = document.querySelector('[data-d4-01-test-result="' + pid + '"]'); return el ? el.textContent.trim() : null; }, cfg.providerId);
        return !!v;
      }, 60000, 500) : false;
      e.uiTest = { clicked: testBtn, settled: testText, badge: await page.evaluate((pid) => { const el = document.querySelector('[data-d4-01-test-result="' + pid + '"]'); return el ? el.textContent.trim() : null; }, cfg.providerId) };
      // 坏路径（credential/set 建的 provider）在同一界面上的「测试连接」结果，形成同屏对照
      const brokenPid = repairEvidence && repairEvidence.brokenPath ? repairEvidence.brokenPath.providerId : null;
      if (brokenPid) {
        await clickSel(page, '[data-d4-01-provider="' + brokenPid + '"]');
        await sleep(400);
        const bBtn = await clickSel(page, '[data-d4-01-test="' + brokenPid + '"]');
        const bSettled = bBtn ? await waitFor(async () => !!(await page.evaluate((pid) => { const el = document.querySelector('[data-d4-01-test-result="' + pid + '"]'); return el ? el.textContent.trim() : null; }, brokenPid)), 60000, 500) : false;
        e.uiTestBroken = { providerId: brokenPid, clicked: bBtn, settled: bSettled, badge: await page.evaluate((pid) => { const el = document.querySelector('[data-d4-01-test-result="' + pid + '"]'); return el ? el.textContent.trim() : null; }, brokenPid) };
        await clickSel(page, '[data-d4-01-provider="' + cfg.providerId + '"]');
        await sleep(300);
      }
      e.ms = msSince(t);
      const shots = await shootBoth(page, "01-model-settings", ["light", "dark"]);
      e.shots = shots.map((s) => s.file);
      e.ok = !!(pcall.result && pcall.result.ok === true && typeof pcall.result.text === "string" && pcall.result.text.length);
      e.callText = (pcall.result && pcall.result.text) || null;
      e.verdict = e.ok ? "全局生效" : (pcall.result && pcall.result.error === "PROVIDER_NOT_FOUND" ? "未生效（provider/call 走的是另一套供应商存储 P2，与模型默认无关）" : "未生效（" + (pcall.result && pcall.result.error) + "）");
      entries["1"] = e;
      record("entry1", "E1 · provider/call「只回复：ok」真实返回", e.ok, "ok:true + 非空 text", JSON.stringify({ error: pcall.result && pcall.result.error, text: e.callText }).slice(0, 300));
      record("entry1", "E1b · model/test（设置页「测试连接」的真实模型通道）", !!(mtest.result && mtest.result.ok === true), "ok:true + inference:true", JSON.stringify(mtest.result).slice(0, 300));
    }

    /* ── 入口 2 ── */
    if (has(2)) {
      const e = { id: "2-chat", name: "对话（appId=chat）" };
      const t = Date.now();
      await closeControlCenter(page);
      await openApp(page, "chat", "对话");
      await maximize(page, "对话窗口");
      await sleep(300);
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
      const got = await waitFor(async () => { const txt = await readChat(page); return !!txt && txt.length > 0; }, 180000, 1000);
      e.typed = typed; e.sent = sent; e.settled = got;
      e.messages = await page.evaluate(() => {
        const win = document.querySelector('section.window[aria-label="对话窗口"]');
        if (!win) return null;
        return Array.prototype.slice.call(win.querySelectorAll(".chat-msg")).map((m) => ({ role: m.getAttribute("data-role"), pending: m.classList.contains("pending"), failed: m.classList.contains("failed"), text: (m.querySelector(".chat-bubble") || {}).textContent || "" }));
      });
      e.errorLine = await readWinText(page, "对话窗口", ".chat-error");
      e.windowText = await page.evaluate(() => { const w = document.querySelector('section.window[aria-label="对话窗口"]'); return w ? w.innerText.replace(/\s+/g, " ").slice(0, 800) : null; });
      e.taskList = (await call("task", "task/list", {})).result;
      e.ms = msSince(t);
      const shots2 = await shootBoth(page, "02-chat", ["light", "dark"]);
      e.shots = shots2.map((s) => s.file);
      const assistant = (e.messages || []).filter((m) => m.role === "assistant" && !m.pending).pop();
      e.callText = assistant ? assistant.text : null;
      e.ok = !!(assistant && assistant.text && assistant.text.trim().length && !assistant.failed && assistant.text !== "思考中…");
      e.verdict = e.ok ? "全局生效" : (e.errorLine ? "未生效（" + e.errorLine + "）" : "未生效");
      e.rawRun = (await call("task", "task/run", { goal: "只回复：ok（命令级）" })).result;
      if (e.rawRun && e.rawRun.ok && e.rawRun.taskId) {
        let detail2 = null;
        await waitFor(async () => {
          const d = (await call("task", "task/get", { taskId: e.rawRun.taskId })).result;
          if (!d || !d.task) return false;
          if (["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"].includes(String(d.task.status))) { detail2 = d; return true; }
          return false;
        }, 120000, 1500);
        e.rawRunDetail = detail2;
      }
      entries["2"] = e;
      record("entry2", "E2 · 对话真实 UI 发送并出现模型回复", e.ok, "聊天气泡出现非占位、非失败的回复", JSON.stringify({ text: e.callText, error: e.errorLine, windowText: e.windowText }).slice(0, 500));
      record("entry2", "E2b · 对话底层 task/run 原始返回", true, "记录真实行为", JSON.stringify({ run: e.rawRun, detail: e.rawRunDetail && { status: e.rawRunDetail.task.status, artifacts: (e.rawRunDetail.artifacts || []).map((a) => String(a.content).slice(0, 200)), steps: (e.rawRunDetail.steps || []).map((s) => s.status) } }).slice(0, 700));
    }

    /* ── 入口 3 ── */
    if (has(3)) {
      const e = { id: "3-assist", name: "全局 AI（助手面板）" };
      const t = Date.now();
      await closeControlCenter(page);
      const opened = await clickSel(page, 'button[aria-label="全局 AI"]');
      const panel = await waitFor(async () => !!(await page.$("section.assist[data-ai-panel]")), 15000, 200);
      e.opened = opened; e.panel = panel;
      if (panel) {
        await page.evaluate(() => {
          const inp = document.querySelector("[data-ai-goal]");
          if (!inp) return;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(inp, "只回复：ok");
          inp.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await sleep(200);
        await page.evaluate(() => { const inp = document.querySelector("[data-ai-goal]"); if (inp) inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
        const settled = await waitFor(async () => {
          const v = await page.evaluate(() => {
            const p = document.querySelector("section.assist[data-ai-panel]");
            if (!p) return null;
            const res = p.querySelector("[data-ai-result]");
            const err = p.querySelector("[data-ai-error]");
            return { status: p.getAttribute("data-ai-status"), result: res ? res.textContent.trim() : null, error: err ? err.textContent.trim() : null };
          });
          return v && (v.result || v.error);
        }, 180000, 1000);
        e.settled = settled;
        e.state = await page.evaluate(() => {
          const p = document.querySelector("section.assist[data-ai-panel]");
          if (!p) return null;
          const res = p.querySelector("[data-ai-result]");
          const err = p.querySelector("[data-ai-error]");
          const st = p.querySelector("[data-ai-status-text]");
          return { status: p.getAttribute("data-ai-status"), statusText: st ? st.textContent.trim() : null, result: res ? res.textContent.trim() : null, error: err ? err.textContent.trim() : null };
        });
        e.callText = e.state && e.state.result;
        e.errorLine = e.state && e.state.error;
        e.ok = !!(e.callText && e.callText.trim().length);
      }
      e.ms = msSince(t);
      const shots3 = await shootBoth(page, "03-assist", ["light", "dark"]);
      e.shots = shots3.map((s) => s.file);
      e.verdict = e.ok ? "全局生效" : (e.errorLine ? "未生效（" + e.errorLine + "）" : "未生效");
      e.taskList = (await call("task", "task/list", {})).result;
      if (e.taskList && e.taskList.ok && Array.isArray(e.taskList.items) && e.taskList.items.length) {
        e.taskDetail = (await call("task", "task/get", { taskId: e.taskList.items[e.taskList.items.length - 1].taskId })).result;
      }
      entries["3"] = e;
      record("entry3", "E3 · 全局 AI 面板真实回复", e.ok, "面板出现真实结果文本", JSON.stringify({ result: e.callText, error: e.errorLine, status: e.state && e.state.status }).slice(0, 400));
      record("entry3", "E3b · 面板任务原始返回（task/list + task/get）", true, "记录真实行为", JSON.stringify({ list: e.taskList, detail: e.taskDetail }).slice(0, 500));
    }

    /* ── 入口 4 ── */
    if (has(4)) {
      const e = { id: "4-canvas", name: "无限画布 / AI Studio（appId=canvas）" };
      const t = Date.now();
      await closeControlCenter(page);
      await openApp(page, "canvas", "AI Studio");
      await maximize(page, "AI Studio窗口");
      const host = await waitFor(async () => !!(await page.$("[data-canvas-host]")), 30000, 300);
      const frame = await waitFor(async () => !!(await page.$("[data-canvas-frame]")), 45000, 500);
      e.host = host; e.frame = frame;
      await sleep(1500);
      const sUi = await shootBoth(page, "04-canvas-ui", ["light"]);
      const mk = await call("canvas", "canvas/create", { title: "全局模型探针画布", icon: "freeform", kind: "canvas" });
      const canvasId = mk.result && mk.result.canvas ? (mk.result.canvas.canvasId || mk.result.canvas.id) : null;
      e.canvasId = canvasId;
      e.create = scrub(JSON.stringify(mk.result)).slice(0, 400);
      const run = canvasId ? await call("canvas", "canvas/run", { canvasId, kind: "chat", nodeId: null }) : { result: { ok: false, error: "NO_CANVAS" } };
      e.run = scrub(JSON.stringify(run.result)).slice(0, 400);
      const runId = run.result && (run.result.runId || (run.result.run && run.result.run.runId));
      const tChat = Date.now();
      const chat = runId ? await call("canvas", "canvas/modelChat", { canvasId, runId, messages: [{ role: "user", content: "只回复：ok" }] }) : { result: { ok: false, error: "NO_RUN" } };
      e.modelChat = { ms: msSince(tChat), raw: scrub(JSON.stringify(chat.result)).slice(0, 700), text: chat.result && (chat.result.text || (chat.result.message && chat.result.message.content)) };
      if (runId) await call("canvas", "canvas/runFinish", { canvasId, runId, status: chat.result && chat.result.ok ? "DONE" : "FAILED" });
      e.ms = msSince(t);
      const sRun = await shootBoth(page, "04-canvas-run", ["light"]);
      e.shots = sUi.concat(sRun).map((s) => s.file);
      e.ok = !!(chat.result && chat.result.ok === true && e.modelChat.text);
      e.callText = e.modelChat.text || null;
      e.verdict = e.ok ? "全局生效（画布生成命令路径，与 CanvasHost 同序列）" : ((chat.result && chat.result.error === "MODEL_CONFIG_UNAVAILABLE") ? "如实不可用（MODEL_CONFIG_UNAVAILABLE）" : "未生效（" + (chat.result && chat.result.error) + "）");
      entries["4"] = e;
      record("entry4", "E4 · 画布 canvas/run + canvas/modelChat 真实返回", e.ok, "ok:true + 非空文本", JSON.stringify({ error: chat.result && chat.result.error, text: e.callText, canvasId, runId }).slice(0, 400));
    }

    /* ── 入口 5 ── */
    if (has(5)) {
      const e = { id: "5-skills", name: "技能（appId=skills）" };
      const t = Date.now();
      await closeControlCenter(page);
      await openApp(page, "skills", "Skill 中心");
      await maximize(page, "Skill 中心窗口");
      await sleep(600);
      const list = await call("skill", "skill/list", {});
      const val = (list.result && (list.result.items || (list.result.value && list.result.value.items))) || [];
      const items = Array.isArray(val) ? val : [];
      e.skillCount = items.length;
      e.skills = items.slice(0, 40).map((s) => ({ id: s.id, name: s.name, kind: s.kind, builtin: s.builtin, enabled: s.enabled }));
      const cand = items.find((s) => (s.kind === "text" || !s.kind) && s.enabled !== false && /chat/i.test(String(s.id))) ||
        items.find((s) => (s.kind === "text" || !s.kind) && s.enabled !== false);
      e.picked = cand ? { id: cand.id, name: cand.name, kind: cand.kind } : null;
      if (cand) {
        const picked = await page.evaluate((id) => {
          const win = document.querySelector('section.window[aria-label="Skill 中心窗口"]');
          const row = win && win.querySelector('[data-skill-id="' + id + '"]');
          if (row) { row.click(); return true; }
          return false;
        }, cand.id);
        e.pickedInUi = picked;
        const runArea = await waitFor(async () => !!(await page.$('[data-skill-run]')), 20000, 300);
        e.runArea = runArea;
        if (runArea) {
          await page.evaluate(() => {
            const area = document.querySelector("[data-skill-run]");
            const ta = area.querySelector("textarea") || area.querySelector('input[type="text"],input:not([type])');
            if (!ta) return;
            const proto = ta.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
            setter.call(ta, "只回复：ok");
            ta.dispatchEvent(new Event("input", { bubbles: true }));
          });
          await sleep(200);
          const tRun = Date.now();
          const clicked = await clickSel(page, '[data-skill-run-go]');
          const done = await waitFor(async () => {
            const v = await page.evaluate(() => {
              const out = document.querySelector("[data-skill-result]");
              const err = document.querySelector("[data-skill-run] .sk-msg.err");
              return { text: out ? out.textContent.trim() : null, error: err ? err.textContent.trim() : null };
            });
            return !!(v.text || v.error);
          }, 180000, 1000);
          e.clicked = clicked; e.settled = done; e.runMs = msSince(tRun);
          e.uiRun = await page.evaluate(() => {
            const out = document.querySelector("[data-skill-result]");
            const err = document.querySelector("[data-skill-run] .sk-msg.err");
            const st = document.querySelector("[data-skill-run] .sk-run-state");
            const unavailable = document.querySelector("[data-skill-run] .set-cap");
            return { text: out ? out.textContent.trim() : null, error: err ? err.textContent.trim() : null, state: st ? st.textContent.trim() : null, cap: unavailable ? unavailable.textContent.trim() : null };
          });
          e.callText = e.uiRun.text; e.errorLine = e.uiRun.error || e.uiRun.cap;
        }
      }
      e.ms = msSince(t);
      const shots5 = await shootBoth(page, "05-skills", ["light", "dark"]);
      e.shots = shots5.map((s) => s.file);
      e.ok = !!(e.callText && e.callText.trim().length);
      e.verdict = e.ok ? "全局生效" : (e.errorLine ? "未生效（" + e.errorLine + "）" : "未生效");
      entries["5"] = e;
      record("entry5", "E5 · 技能 UI 运行 chat 类技能真实回复", e.ok, "skill/run 返回非空 text", JSON.stringify({ picked: e.picked, text: e.callText, error: e.errorLine, state: e.uiRun && e.uiRun.state }).slice(0, 500));
    }

    /* ── 入口 6 ── */
    if (has(6)) {
      const e = { id: "6-drama", name: "短剧工坊（appId=drama）" };
      const t = Date.now();
      await closeControlCenter(page);
      await openApp(page, "drama", "短剧工坊");
      await maximize(page, "短剧工坊窗口");
      await sleep(500);
      await clickWin(page, "短剧工坊窗口", "[data-drama-new]");
      await sleep(300);
      await page.evaluate(() => {
        const inp = document.querySelector('[data-drama-name]');
        if (!inp) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(inp, "全局模型探针短剧");
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sleep(200);
      await clickWin(page, "短剧工坊窗口", "[data-drama-create]");
      const opened = await waitFor(async () => !!(await page.$('section.window[aria-label="短剧工坊窗口"] [data-drama-stage="script"]')), 20000, 300);
      e.projectOpened = opened;
      await clickWin(page, "短剧工坊窗口", '[data-drama-stage="script"]');
      await sleep(400);
      await page.evaluate(() => {
        const win = document.querySelector('section.window[aria-label="短剧工坊窗口"]');
        const ta = win && win.querySelector(".dr-field textarea");
        if (!ta) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, "深秋的横店，群演林小满在片场被导演当众羞辱，她攥着被撕碎的剧本，决定用一场自己的戏证明自己。");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("blur", { bubbles: true }));
      });
      await sleep(600);
      const tOutline = Date.now();
      const clicked = await clickWin(page, "短剧工坊窗口", "[data-drama-outline]");
      const settled = await waitFor(async () => {
        const v = await page.evaluate(() => {
          const win = document.querySelector('section.window[aria-label="短剧工坊窗口"]');
          if (!win) return null;
          const err = win.querySelector("[data-drama-error]");
          const bp = win.querySelector(".dr-card h3");
          return { error: err ? err.textContent.trim() : null, hasBlueprint: !!bp };
        });
        return v && (v.error || v.hasBlueprint);
      }, 90000, 1000);
      e.clicked = clicked; e.settled = settled; e.outlineMs = msSince(tOutline);
      e.debug = await page.evaluate(() => {
        const win = document.querySelector('section.window[aria-label="短剧工坊窗口"]');
        if (!win) return null;
        const outline = win.querySelector("[data-drama-outline]");
        return {
          hasOutlineBtn: !!outline,
          outlineDisabled: outline ? outline.disabled : null,
          panel: win.querySelector("[data-drama-panel]") ? win.querySelector("[data-drama-panel]").getAttribute("data-drama-panel") : null,
          textarea: !!win.querySelector(".dr-field textarea"),
          textLen: win.querySelector(".dr-field textarea") ? win.querySelector(".dr-field textarea").value.length : 0,
          alert: win.querySelector("[role=alert]") ? win.querySelector("[role=alert]").textContent.trim().slice(0, 200) : null,
        };
      });
      e.state = await page.evaluate(() => {
        const win = document.querySelector('section.window[aria-label="短剧工坊窗口"]');
        if (!win) return null;
        const err = win.querySelector("[data-drama-error]");
        const msg = win.querySelector(".vd-msg.sk-msg:not(.err)");
        const cards = Array.prototype.slice.call(win.querySelectorAll(".dr-card")).slice(0, 3).map((c) => c.innerText.replace(/\s+/g, " ").slice(0, 300));
        return { error: err ? err.textContent.trim() : null, message: msg ? msg.textContent.trim() : null, cards };
      });
      e.callText = e.state && e.state.cards && e.state.cards.length ? e.state.cards[0] : null;
      e.errorLine = e.state && e.state.error;
      e.ms = msSince(t);
      const s6 = await shootBoth(page, "06-drama", ["light"]);
      e.shots = s6.map((s) => s.file);
      e.ok = !!(e.state && e.state.cards && e.state.cards.length);
      e.verdict = e.ok ? "全局生效（真实结构化文本）" : (e.errorLine ? "如实不可用（结构化：" + e.errorLine + "）" : "未生效");
      // E6b：命令级实测（同一 AI 步骤的确定路径）——UI 交互失败时也能给出真实模型行为
      const dc = await call("media", "media/short-drama/create", { name: "全局模型探针短剧（命令级）" });
      const did = dc.result && (dc.result.project ? dc.result.project.id : (dc.result.value && dc.result.value.project ? dc.result.value.project.id : null));
      e.commandCreate = scrub(JSON.stringify(dc.result)).slice(0, 400);
      if (did) {
        await call("media", "media/short-drama/update", { projectId: did, patch: { sourceText: "深秋的横店，群演林小满在片场被导演当众羞辱，她攥着被撕碎的剧本，决定用一场自己的戏证明自己。" } });
        const tOut2 = Date.now();
        e.commandOutline = await call("media", "media/short-drama/outline", { projectId: did, episodeCount: 3 });
        e.commandOutlineMs = msSince(tOut2);
      }
      entries["6"] = e;
      record("entry6", "E6 · 短剧工坊 AI 拆解集纲（UI）", e.ok, "真实结构化文本 或 结构化不可用", JSON.stringify({ error: e.errorLine, firstCard: e.callText, debug: e.debug }).slice(0, 500));
      record("entry6", "E6b · 短剧 AI 步骤命令级（media/short-drama/outline）", true, "记录真实行为（成功或结构化不可用）", JSON.stringify(e.commandOutline).slice(0, 500));
    }

    /* ── 入口 7 · 反向对照 ── */
    if (has(7)) {
      const imgNoProvider = await call("model", "image/generate", { prompt: "一只猫", size: "1024x1024", count: 1 });
      const imgWithDs = await call("model", "image/generate", { providerId: cfg.providerId, model: DEEPSEEK_MODEL, prompt: "一只猫", size: "1024x1024", count: 1 });
      reverse["image.generate"] = { noProvider: imgNoProvider.result, withDeepSeekProvider: imgWithDs.result };
      record("reverse", "R1 · image/generate 无图像供应商 → 结构化错误（无假图）", !!(imgNoProvider.result && imgNoProvider.result.ok === false && !imgNoProvider.result.images), "ok:false + 无 images", JSON.stringify(imgNoProvider.result).slice(0, 400));

      const vidCmd = await call("model", "video.generate", { prompt: "一只猫在跑" });
      const vidProto = await call("model", "protocol/execute", { intent: "video.generate", prompt: "一只猫在跑" });
      reverse["video.generate"] = { asModelCommand: vidCmd.result, asProtocolIntent: vidProto.result };
      record("reverse", "R2 · video.generate → 结构化错误（两条通道都不得假成功）", !!(vidCmd.result && vidCmd.result.ok === false) && !!(vidProto.result && vidProto.result.ok === false), "两条通道都 ok:false", JSON.stringify({ cmd: vidCmd.result, proto: vidProto.result }).slice(0, 500));

      const visModels = await call("photos", "photos/visionModels", {});
      const visReverse = await call("photos", "photos/reversePrompt", { imageId: "probe-none", providerId: "probe-none", model: "probe-none" });
      reverse["llm.chat.vision"] = { visionModels: visModels.result, reversePrompt: visReverse.result };
      record("reverse", "R3 · 相册「反推提示词」→ 结构化不可用 + 配置提示", !!(visReverse.result && visReverse.result.ok === false), "ok:false + 结构化 hint", JSON.stringify({ visionModels: visModels.result, reverse: visReverse.result }).slice(0, 600));

      await closeControlCenter(page);
      await openApp(page, "photos", "相册");
      await maximize(page, "相册窗口");
      await sleep(1500);
      const s7 = await shootBoth(page, "07-reverse-photos", ["light"]);
      reverse.shots = s7.map((s) => s.file);
    }

    await sleep(300);
  } catch (err) {
    fatal = scrub(String((err && err.stack) || err));
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
      let names = [];
      try { names = fs.readdirSync(path.join(userDataDir, rel)); } catch { return; }
      for (const n of names) {
        const r = rel ? rel + "/" + n : n;
        const abs = path.join(userDataDir, r);
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (st.isDirectory()) walk(r, depth + 1);
        else files.push({ rel: r, size: st.size });
      }
    };
    walk("", 0);
    userDataAudit = { fileCount: files.length, sample: files.slice(0, 40), providersJsonExists: fs.existsSync(path.join(userDataDir, "dxos", "providers.json")), identityDb: fs.existsSync(path.join(userDataDir, "identity.db")) };
  } catch (e) { userDataAudit = { error: scrub(String(e)) }; }

  let userDataRemoved = false;
  if (!KEEP_USERDATA) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); userDataRemoved = !fs.existsSync(userDataDir); } catch { userDataRemoved = false; }
  }

  const profileAfter = snapshotProfile(realProfile);
  const profileDiff = diffProfile(profileBefore, profileAfter);
  const profileProcAfter = processesUsing(realProfile);
  record("isolation", "S1 · 真实 profile 未被触碰（mtime+size 全量比对）", profileDiff.unchanged, "unchanged", JSON.stringify({ changedCount: profileDiff.changedCount, changed: profileDiff.changed }).slice(0, 400));
  record("isolation", "S2 · 隔离 userData 已删除（含 safeStorage 测试密钥副本）", KEEP_USERDATA || userDataRemoved, KEEP_USERDATA ? "OA_GM_KEEP=1（保留）" : "removed", String(userDataRemoved));
  record("assert", "A1 · 0 console error", consoleErrors.length === 0, 0, consoleErrors.length, JSON.stringify(consoleErrors.slice(0, 10)));
  record("assert", "A2 · 0 pageerror", pageErrors.length === 0, 0, pageErrors.length, JSON.stringify(pageErrors.slice(0, 10)));

  const deepseekRequests = requests.filter((u) => /^https:\/\/api\.deepseek\.com\//i.test(u));
  const otherExternal = nonLocal.filter((u) => !/api\.deepseek\.com/i.test(u));

  const report = {
    at: nowIso(), phase: "dxos-ui-global-model", renderer: "dist/vue.html", durationMs: Date.now() - startedAt,
    electronVersion, cdpPort: port,
    secretMeta: SECRET_META,
    provider: { providerId: cfg.providerId, displayName: "DeepSeek", baseUrl: DEEPSEEK_BASE, adapterType: "openai-compatible", scope: "PERSONAL" },
    remoteModels: modelsEvidence,
    defaults: { literalLlmChatAttempt: cfg.literalAttempt, get: cfg.defaultsGet },
    preRepair, repairEvidence,
    entries,
    reverse,
    assertions: { consoleErrors, pageErrors, consoleTotal: consoleAll.length, deepseekRequestCount: deepseekRequests.length, otherExternalRequests: otherExternal.slice(0, 30), exit: exitInfo, fatal },
    profile: { path: realProfile, existsBefore: profileBefore.exists, existsAfter: profileAfter.exists, unchanged: profileDiff.unchanged, changedCount: profileDiff.changedCount, changed: profileDiff.changed, processesBefore: profileProcBefore, processesAfter: profileProcAfter },
    userDataAudit, userDataRemoved, isolatedUserDataKept: KEEP_USERDATA,
    rows, notes, captures: CAPTURES,
    electronStdoutTail: scrub(stdoutBuf).slice(-1500),
    electronStderrTail: scrub(stderrBuf).slice(-1500),
  };
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));

  const failed = rows.filter((r) => !r.ok);
  console.log("\n================ 汇总 ================");
  for (const r of rows) console.log((r.ok ? "PASS" : "FAIL") + "  [" + r.section + "] " + r.name + (r.ok ? "" : "  ← " + r.actual));
  console.log("console error=" + consoleErrors.length + " pageerror=" + pageErrors.length + " 非本地请求(除 DeepSeek)=" + otherExternal.length + " DeepSeek 请求=" + deepseekRequests.length);
  console.log("截图 " + CAPTURES.length + " 张 → " + SHOTS);
  console.log("报告 → " + path.join(ART, "report.json"));
  if (fatal) console.log("FATAL: " + fatal);
  console.log("PASS=" + (rows.length - failed.length) + " FAIL=" + failed.length);
  return failed.length === 0 && !fatal ? 0 : 1;
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
async function clickSel(page, sel) {
  return page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
}
function winSel(label) { return 'section.window[aria-label="' + label + '"]'; }
async function clickWin(page, label, sel) {
  return page.evaluate((a) => { const w = document.querySelector(a.w); if (!w) return false; const el = w.querySelector(a.s); if (!el) return false; el.click(); return true; }, { w: winSel(label), s: sel });
}
async function openApp(page, appId, name) {
  const label = name + "窗口";
  const already = await page.$(winSel(label));
  if (already) {
    await page.evaluate((w) => { const el = document.querySelector(w); if (el) el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window })); }, winSel(label));
    return true;
  }
  await page.evaluate(() => { const d = document.querySelector(".dock"); if (d) d.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true })); });
  await clickSel(page, '.dock-item[data-dock-id="' + appId + '"]');
  if (await waitFor(async () => !!(await page.$(winSel(label))), 3000, 250)) return true;
  // 不在程序坞里的应用（短剧工坊 / 相册 / 应用市场…）：经「应用中心」的应用卡片启动
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
    await waitFor(async () => {
      const r = await page.evaluate((a) => { const w = document.querySelector(a.w); if (!w) return null; const b = w.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; }, { w: winSel(label) });
      return !!r && Math.abs(r[3] - (900 - 38)) < 6;
    }, 8000, 200);
  }
  return true;
}
async function readWinText(page, label, sel) {
  return page.evaluate((a) => { const w = document.querySelector(a.w); const el = w && w.querySelector(a.s); return el ? el.textContent.trim() : null; }, { w: winSel(label), s: sel });
}
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
  const ccOpen = await page.$(".control-center");
  if (!ccOpen) { await clickSel(page, 'button[aria-label="控制中心"]'); await sleep(350); }
  const label = theme === "dark" ? "深色" : "浅色";
  const clicked = await page.evaluate((arg) => {
    const cc = document.querySelector(".control-center");
    if (!cc) return false;
    const group = cc.querySelector('[aria-label="外观"]');
    if (!group) return false;
    const btns = Array.prototype.slice.call(group.querySelectorAll("button"));
    for (const b of btns) if ((b.textContent || "").trim() === arg.text) { b.click(); return true; }
    return false;
  }, { text: label });
  await sleep(550);
  const applied = await page.evaluate((t) => { const d = document.querySelector(".desktop"); return d ? d.classList.contains("dark") === (t === "dark") : false; }, theme);
  return { clicked, applied };
}
async function closeControlCenter(page) {
  const open = await page.$(".control-center");
  if (open) { await clickSel(page, ".cc-shade"); await sleep(300); }
  return true;
}
async function shoot(page, name, theme) {
  const file = path.join(SHOTS, name + "-" + theme + ".png");
  const s = await page.context().newCDPSession(page);
  const res = await s.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  try { await s.detach(); } catch { /* ignore */ }
  fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  const buf = fs.readFileSync(file);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const rec = { file: path.relative(ROOT, file), theme, width: w, height: h, bytes: buf.length, at2880x1800: w === 2880 && h === 1800 };
  captureIndexIn(rec);
  return rec;
}
async function shootBoth(page, name, themes) {
  const out = [];
  for (const t of themes) {
    await setTheme(page, t);
    await closeControlCenter(page);   // 主题浮层绝不出现在证据截图里
    await sleep(350);
    out.push(await shoot(page, name, t));
  }
  await setTheme(page, "light");
  await closeControlCenter(page);
  return out;
}

const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (IS_MAIN) main().then((code) => process.exit(code)).catch((err) => { console.error("UNCAUGHT " + err.stack); process.exit(2); });
export { main };
