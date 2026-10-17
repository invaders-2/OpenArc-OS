/**
 * DXOS-CANVAS-FIX-LATENCY 探针（真实 Electron + 隔离 userData + 本地确定性 provider）。
 *
 * 覆盖：
 *   L1 宿主 canvas/command 之后到已打开智能画布呈现的耗时（3 轮）+ 宿主推送的页面侧统计；
 *   L2 推送到达但用户正在输入：不打断、不合并；失焦后补上（内容不丢）；
 *   M1 显式生图默认不可用（跨能力）：不静默换模型，如实呈现 + 运行入口拦截 + 宿主仍拒绝；
 *   M2 显式文本默认被停用：下拉不自动换模型，如实呈现"不可用"；用户显式选择替代后不被掰回；
 *   M3 宿主调用级拒绝仍然成立（跨能力 / 停用 → 明确错误 + 0 新增请求）。
 *
 * 用法：node experiments/dxos-canvas-fix-latency/probe.mjs
 * 产物：artifacts/dxos-canvas-fix-latency/probe.json + shots/*.png
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startCanvasProvider } from "../../tests/fixtures/d5-02-canvas-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const OUT = path.join(ROOT, "artifacts", "dxos-canvas-fix-latency");
const SHOTS = path.join(OUT, "shots");
const CDP_PORT = Number(process.env.OA_FIXLAT_CDP_PORT || 9884);
const ADMIN = { id: "admin@fixlat.test", pw: "fixlat-admin-1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null, browser = null, page = null, provider = null, userDataDir = null, stderrBuf = "";
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop') ? document.querySelector('.desktop').getAttribute('data-identity-gate') : 'no-root'");
const model = (payload) => js("return await window.openarc.model.command(" + JSON.stringify(payload) + ")");
const canvas = (payload) => js("return await window.openarc.canvas.command(" + JSON.stringify(payload) + ")");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(150); } return false; }
const waitSel = (sel, ms) => waitFor(() => js("return !!document.querySelector(" + JSON.stringify(sel) + ")"), ms || 20000);
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const smartFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/smart-canvas\.html/);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 400) }; }
}
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? "  [PASS] " : "  [FAIL] ") + name);
  if (!ok) console.log("         " + JSON.stringify(detail).slice(0, 1200));
}
async function shot(name) {
  try { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); } catch (e) { console.log("shot failed " + name + ": " + e.message); }
}
async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-fixlat-"));
  const childEnv = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + CDP_PORT, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null; const end0 = Date.now() + 60000;
  while (!version && Date.now() < end0) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0]; const end = Date.now() + 40000;
  while (!page && Date.now() < end) { page = ctx.pages().find((p) => /[\\/]dist[\\/](vue|index)\.html/.test(p.url())) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页");
  page.on("dialog", (d) => { void d.dismiss().catch(() => {}); });
}
async function login() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const next = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "FIXLAT Admin"); await next();
    await waitSel('[data-d3-id="setup-identifier"]', 10000); await setInput('[data-d3-id="setup-identifier"]', ADMIN.id); await next();
    await waitSel('[data-d3-id="setup-password"]', 10000); await setInput('[data-d3-id="setup-password"]', ADMIN.pw); await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  return waitFor(async () => (await gate()) === "ready", 60000);
}
async function openCanvas() {
  await js("const el = document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]'); if (el) el.click(); return !!el;");
  await waitFor(() => js("return !!document.querySelector('[data-canvas-host]')"), 20000);
  await waitFor(() => !!listFrame(), 25000);
  // 列表页的入口监听是内联脚本挂的：帧出现 ≠ 监听已挂（早点点到会落空，表现为一直停在列表页）。
  await sleep(1600);
  let clicked = await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';");
  if (clicked !== "clicked") { await sleep(1200); clicked = await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';"); }
  const editorUp = await waitFor(() => !!smartFrame(), 45000);
  if (!editorUp) throw new Error("点「开始创作」后没有进入 smart-canvas（click=" + clicked + "）");
  await waitFor(async () => {
    const s = await inFrame(smartFrame(), "return { id: (window.__openarcCanvas && window.__openarcCanvas.state().canvasId) || null, ro: window.__openarcBridge ? window.__openarcBridge.isReadOnly() : null };");
    return s && s.id && s.ro === false;
  }, 30000);
  return inFrame(smartFrame(), "return window.__openarcCanvas.state().canvasId;");
}
const nRefreshConfig = async () => {
  await inFrame(smartFrame(), "window.dispatchEvent(new MessageEvent('message', { data: { type: 'providers-changed' } })); return true;");
  await sleep(900);
};
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  provider = await startCanvasProvider({ port: 5436 });
  await launch(); await login();

  const prov = await model({ type: "provider/create", displayName: "FIXLAT Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "fixlat-secret" });
  const providerId = prov.provider.providerId;
  const imgModel = await model({ type: "model/create", providerId, remoteModelId: "fl-image", displayName: "FL Image", capabilities: ["image-generation"], scope: "ORGANIZATION" });
  const chatModel = await model({ type: "model/create", providerId, remoteModelId: "fl-chat", displayName: "FL Chat", capabilities: ["chat"], scope: "ORGANIZATION" });
  const chatOnly = await model({ type: "model/create", providerId, remoteModelId: "fl-chat-only", displayName: "FL ChatOnly", capabilities: ["chat"], scope: "ORGANIZATION" });
  const imgId = imgModel.model.configId, chatId = chatModel.model.configId, chatOnlyId = chatOnly.model.configId;
  await model({ type: "defaults/set", capability: "chat", configId: chatId });
  await model({ type: "defaults/set", capability: "image-generation", configId: imgId });

  const canvasId = await openCanvas();
  console.log("canvasId", canvasId);

  /* ── L1：宿主 canvas/command → 已打开画布呈现（3 轮） ── */
  const latency = [];
  for (let i = 0; i < 3; i += 1) {
    const nodeId = "lat_" + i;
    await sleep(1200);
    const before = await inFrame(smartFrame(), "return window.__openarcCanvasLiveSync ? window.__openarcCanvasLiveSync.stats() : null;");
    const add = await canvas({ type: "canvas/command", canvasId, command: { type: "node.add", node: { id: nodeId, type: "prompt", x: 80 + i * 40, y: 80, text: "延迟探针 " + i } } });
    const t0 = Date.now();
    const appeared = await waitFor(async () => (await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; return !!(it && it.primitives.getNode(" + JSON.stringify(nodeId) + "));")) === true, 12000);
    const waitedMs = Date.now() - t0;
    const after = await inFrame(smartFrame(), "return window.__openarcCanvasLiveSync ? window.__openarcCanvasLiveSync.stats() : null;");
    latency.push({ round: i, hostOk: !!(add && add.ok), appeared, waitedMs, before, after });
    console.log("  L1 第 " + (i + 1) + " 轮：" + waitedMs + "ms（appeared=" + appeared + "）");
  }
  const worst = Math.max(...latency.map((x) => x.waitedMs));
  const pushSeen = latency.every((x) => x.after && x.after.applied >= 1);
  record("L1 宿主命令 → 已打开画布呈现 ≤2500ms（3 轮，含宿主推送统计）", latency.every((x) => x.hostOk && x.appeared && x.waitedMs <= 2500) && pushSeen,
    { worstMs: worst, thresholdMs: 2500, latency });

  /* ── L2：正在输入时不打断；失焦后补上 ── */
  await sleep(1000);
  const beforeL2 = await inFrame(smartFrame(), "return window.__openarcCanvasLiveSync.stats();");
  await inFrame(smartFrame(), "const i = document.createElement('input'); i.id = 'oa-probe-input'; document.body.appendChild(i); i.focus(); return document.activeElement === i;");
  const addL2 = await canvas({ type: "canvas/command", canvasId, command: { type: "node.add", node: { id: "lat_busy", type: "prompt", x: 300, y: 300, text: "输入中不应打断" } } });
  await sleep(1400);
  const duringL2 = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; return { has: !!it.primitives.getNode('lat_busy'), stats: window.__openarcCanvasLiveSync.stats(), active: document.activeElement && document.activeElement.id };");
  await inFrame(smartFrame(), "const i = document.getElementById('oa-probe-input'); if (i) i.blur(); return true;");
  const t2 = Date.now();
  const appearedL2 = await waitFor(async () => (await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; return !!it.primitives.getNode('lat_busy');")) === true, 6000);
  const afterBlurMs = Date.now() - t2;
  const afterL2 = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; return { has: !!it.primitives.getNode('lat_busy'), stats: window.__openarcCanvasLiveSync.stats() };");
  await inFrame(smartFrame(), "const i = document.getElementById('oa-probe-input'); if (i) i.remove(); return true;");
  record("L2 正在输入时远端改动不抢（不合并、不打断），失焦后补上且内容不丢",
    !!(addL2 && addL2.ok) && duringL2 && duringL2.has === false && duringL2.stats && duringL2.stats.deferred >= 1 && appearedL2 === true && afterL2.has === true,
    { during: duringL2, appearedAfterBlur: appearedL2, afterBlurMs, beforeL2, afterL2 });

  /* ── M1：显式生图默认不可用（跨能力）→ 不静默换模型 ── */
  await model({ type: "defaults/set", capability: "image-generation", configId: chatOnlyId });
  await nRefreshConfig();
  const m1cfg = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); const c = (cfg.capabilities || {})['image-generation'] || {}; return { default_models: cfg.default_models || null, image_models: cfg.image_models || [], defaultUsable: c.defaultUsable, defaultReason: c.defaultReason };");
  const m1 = await inFrame(smartFrame(), [
    "const it = window.__openarcCanvasInternals;",
    "const facts = window.__openarcSmartGuard ? window.__openarcSmartGuard.facts() : null;",
    "const pill = (document.querySelector('#dynamicParams .model-control .smart-pill') || null);",
    "const note = document.querySelector('[data-openarc-guard-note=\"default-image-model\"]');",
    "const pop = document.querySelector('#dynamicParams .model-control .smart-popover');",
    "const opts = pop ? Array.prototype.map.call(pop.querySelectorAll('[data-smart-param=\"model\"]'), function(b){ return { value: b.getAttribute('data-smart-value'), disabled: !!b.disabled, unavailable: b.getAttribute('data-openarc-unavailable') }; }) : [];",
    "return { settings_model: String(it.getState().settings.model || ''), pill: pill ? { text: String(pill.textContent || '').trim(), unavailable: pill.getAttribute('data-openarc-unavailable'), defaultUnavailable: pill.getAttribute('data-openarc-default-unavailable'), title: pill.getAttribute('title') } : null, note: note ? String(note.textContent || '') : null, htmlFlag: document.documentElement.getAttribute('data-openarc-default-unavailable'), factsDefaults: facts && facts.defaults, opts };",
  ].join("\n"));
  const m1Label = m1cfg && m1cfg.default_models ? String(m1cfg.default_models["image-generation"] || "") : "";
  await inFrame(smartFrame(), "const r = await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_probe_gen', type:'image', x:420, y:420 } }, null); const el = document.querySelector('.image-node[data-id=\"n_probe_gen\"]'); if (el) el.click(); await new Promise(function(r){ setTimeout(r, 400); }); return true;");
  const m1run = await inFrame(smartFrame(), "const b = document.getElementById('runBtn'); return b ? { disabled: !!b.disabled, blocked: b.getAttribute('data-openarc-blocked'), defaultUnavailable: b.getAttribute('data-openarc-default-unavailable') } : null;");
  const beforeM1 = provider.state().images.length;
  const m1host = await canvas({ type: "canvas/run", canvasId, kind: "image" });
  const afterM1 = provider.state().images.length;
  await shot("model-image-default-unavailable-light.png");
  record("M1 显式生图默认不可用：页面不静默换模型（保持默认标签 + 如实标注 + 运行入口拦截）",
    !!m1cfg && m1cfg.defaultUsable === false && m1Label !== "" && m1.settings_model === m1Label && m1.pill && m1.pill.defaultUnavailable === "image-generation" && !!m1.note && m1.note.indexOf("不会自动改用其它模型") >= 0 && m1.htmlFlag && m1.htmlFlag.indexOf("image-generation") >= 0 && m1run && m1run.disabled === true && m1run.blocked === "MODEL_UNAVAILABLE" && m1run.defaultUnavailable === "image-generation",
    { cfg: m1cfg, label: m1Label, page: m1, runBtn: m1run });
  record("M1b 宿主侧拒绝语义不变（跨能力生图 → CAPABILITY_UNAVAILABLE + 0 新增请求）",
    m1host && m1host.ok === false && m1host.error === "CAPABILITY_UNAVAILABLE" && afterM1 === beforeM1,
    { host: m1host && { ok: m1host.ok, error: m1host.error }, images: beforeM1 + "→" + afterM1 });

  /* ── M2：显式文本默认被停用 → 下拉不自动换模型 ── */
  await model({ type: "defaults/set", capability: "image-generation", configId: imgId });
  // 先开一个 chat run（默认还可用），停用后再用它验证宿主调用级拒绝（与门禁 F1 同一条路径）。
  const m2Run = await canvas({ type: "canvas/run", canvasId, kind: "chat" });
  await model({ type: "model/setStatus", configId: chatId, status: "disabled" });
  await nRefreshConfig();
  const m2cfg = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); const c = (cfg.capabilities || {})['chat'] || {}; return { default_models: cfg.default_models || null, chat: cfg.chat_models || [], defaultUsable: c.defaultUsable, defaultReason: c.defaultReason };");
  const m2 = await inFrame(smartFrame(), [
    "const sel = document.getElementById('chatModelSelect');",
    "const note = document.querySelector('[data-openarc-guard-note=\"default-chat-model\"]');",
    "const facts = window.__openarcSmartGuard ? window.__openarcSmartGuard.facts() : null;",
    "return { value: sel ? String(sel.value) : null, disabled: sel ? !!sel.disabled : null, defaultUnavailable: sel ? sel.getAttribute('data-openarc-default-unavailable') : null, options: sel ? Array.prototype.map.call(sel.options, function(o){ return { value: String(o.value), disabled: !!o.disabled, text: String(o.textContent) }; }) : [], note: note ? String(note.textContent || '') : null, factsDefaults: facts && facts.defaults, htmlFlag: document.documentElement.getAttribute('data-openarc-default-unavailable') };",
  ].join("\n"));
  const m2Label = m2cfg && m2cfg.default_models ? String(m2cfg.default_models.chat || "") : "";
  await inFrame(smartFrame(), "if (typeof window.toggleChatPanel === 'function' && !document.getElementById('chatModal').classList.contains('open')) window.toggleChatPanel(); await new Promise(function(r){ setTimeout(r, 500); }); return true;");
  await shot("model-chat-default-unavailable-light.png");
  await inFrame(smartFrame(), "if (document.getElementById('chatModal').classList.contains('open')) window.toggleChatPanel(); return true;");
  const m2Option = (m2 && Array.isArray(m2.options)) ? m2.options.find((o) => o.value === m2Label) : null;
  record("M2 显式文本默认停用：chat 下拉不自动改选清单剩余模型，如实呈现不可用项",
    !!m2cfg && m2cfg.defaultUsable === false && m2Label !== "" && m2.value === m2Label && m2.defaultUnavailable === "chat" && !!m2.note && m2.note.indexOf("已停用") >= 0 && !!m2Option && m2Option.disabled === true && m2.htmlFlag && m2.htmlFlag.indexOf("chat") >= 0,
    { cfg: m2cfg, label: m2Label, page: m2 });
  const beforeM2 = provider.state().chats.length;
  const m2host = await canvas({ type: "canvas/modelChat", canvasId, runId: m2Run && m2Run.runId, messages: [{ role: "user", content: "停用后不该成功" }], configId: chatId }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  const afterM2 = provider.state().chats.length;
  record("M2b 宿主侧调用级拒绝不变（停用配置 → MODEL_DISABLED + 0 新增请求）",
    m2host && m2host.ok === false && ["MODEL_DISABLED", "MODEL_CONFIG_UNAVAILABLE", "MODEL_NOT_FOUND"].includes(m2host.error) && afterM2 === beforeM2,
    { host: m2host && { ok: m2host.ok, error: m2host.error }, chats: beforeM2 + "→" + afterM2 });

  /* M2c：用户显式选择替代模型 → 配置刷新不再被掰回不可用默认 */
  await inFrame(smartFrame(), "window.changeChatModel('fl-chat-only'); return true;");
  await sleep(400);
  await nRefreshConfig();
  const m2c = await inFrame(smartFrame(), "const sel = document.getElementById('chatModelSelect'); return { value: sel ? String(sel.value) : null, defaultUnavailable: sel ? sel.getAttribute('data-openarc-default-unavailable') : null };");
  record("M2c 显式选择替代模型后，配置刷新不会把选择掰回不可用默认", !!m2c && m2c.value === "fl-chat-only" && !m2c.defaultUnavailable,
    { page: m2c });
  await model({ type: "model/setStatus", configId: chatId, status: "enabled" });
  await nRefreshConfig();

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  fs.writeFileSync(path.join(OUT, "probe.json"), JSON.stringify({ at: new Date().toISOString(), pass, fail, total: results.length, results, latency, shots: fs.readdirSync(SHOTS) }, null, 2));
  console.log("\n探针结果：" + JSON.stringify({ pass, fail, total: results.length }));
}
try { await main(); } catch (e) { console.error("探针异常：" + String((e && e.stack) || e)); console.error(stderrBuf.slice(-1500)); process.exitCode = 2; }
try { if (browser) await browser.close().catch(() => {}); } catch {}
try { if (child) child.kill("SIGKILL"); } catch {}
try { spawnSync("pkill", ["-f", "oa-fixlat-"], { stdio: "ignore" }); } catch {}
try { if (provider) await provider.close(); } catch {}
