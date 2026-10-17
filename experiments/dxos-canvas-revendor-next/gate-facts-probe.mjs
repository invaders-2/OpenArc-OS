/**
 * DXOS-CANVAS-REVENDOR-NEXT · 门禁重定向事实探针（只读，不改产品）
 * 目的：为 canvas-e2e.mjs 的智能画布重指向采集真实 DOM / 守卫事实 / 运行链路证据。
 * 用法：node experiments/dxos-canvas-revendor-next/gate-facts-probe.mjs
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startCanvasProvider, CANVAS_TEXT_PREFIX } from "../../tests/fixtures/d5-02-canvas-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-revendor-next");
const CDP_PORT = Number(process.env.OA_GATE_FACTS_CDP_PORT || 9881);
const ADMIN = { id: "admin@gate-facts.test", pw: "gate-facts-1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null, browser = null, page = null, provider = null, userDataDir = null, stderrBuf = "";
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop') ? document.querySelector('.desktop').getAttribute('data-identity-gate') : 'no-root'");
const model = (payload) => js("return await window.openarc.model.command(" + JSON.stringify(payload) + ")");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const waitSel = (sel, ms) => waitFor(() => js("return !!document.querySelector(" + JSON.stringify(sel) + ")"), ms || 20000);
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const smartFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/smart-canvas\.html/);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 400) }; }
}
const slog = (tag, v) => console.log("\n=== " + tag + " ===\n" + JSON.stringify(v, null, 2));
const consoleErrors = [];

async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-gate-facts-"));
  const childEnv = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + CDP_PORT, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪：" + stderrBuf.slice(-800));
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!page && Date.now() < end) { page = ctx.pages().find((p) => /[\\/]dist[\\/](vue|index)\.html/.test(p.url())) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页：" + JSON.stringify(ctx.pages().map((p) => p.url())));
  page.on("dialog", (d) => { void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(String(m.text()).slice(0, 240)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror:" + String(e.message).slice(0, 240)));
}

async function login() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const next = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "Gate Facts Admin"); await next();
    await waitSel('[data-d3-id="setup-identifier"]', 10000); await setInput('[data-d3-id="setup-identifier"]', ADMIN.id); await next();
    await waitSel('[data-d3-id="setup-password"]', 10000); await setInput('[data-d3-id="setup-password"]', ADMIN.pw); await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}

const NO_MODEL = String.raw`
const q = (sel) => document.querySelector(sel);
const facts = window.__openarcSmartGuard ? window.__openarcSmartGuard.facts() : null;
const chatSel = q('#chatModelSelect');
const runBtn = q('#runBtn');
const dyn = q('#dynamicParams');
const platform = q('#unifiedPlatformControl');
const videoBtn = q('#createMenu [data-create-type="video"]');
const eng = Array.prototype.map.call(document.querySelectorAll('#engineSelect option'), function (o) { return { value: o.value, text: String(o.textContent).trim(), disabled: !!o.disabled, mark: o.getAttribute('data-openarc-unavailable'), title: String(o.title || '') }; });
return {
  facts: facts,
  storage: window.__openarcSmartGuard ? window.__openarcSmartGuard.storage() : null,
  chatModels: { disabled: chatSel ? chatSel.disabled : null, aria: chatSel ? chatSel.getAttribute('aria-disabled') : null, value: chatSel ? chatSel.value : null, options: chatSel ? Array.prototype.map.call(chatSel.options, function (o) { return { value: o.value, text: String(o.textContent).trim() }; }) : null },
  chatSelectExists: !!chatSel,
  runBtn: runBtn ? { disabled: !!runBtn.disabled, blocked: runBtn.getAttribute('data-openarc-blocked'), aria: runBtn.getAttribute('aria-disabled') } : null,
  dynHtml: dyn ? String(dyn.innerHTML).slice(0, 1200) : null,
  dynButtons: dyn ? Array.prototype.map.call(dyn.querySelectorAll('[data-smart-param]'), function (b) { return { param: b.getAttribute('data-smart-param'), value: b.getAttribute('data-smart-value'), disabled: !!b.disabled, mark: b.getAttribute('data-openarc-unavailable'), text: String(b.textContent).trim().slice(0, 40) }; }).slice(0, 20) : null,
  platform: platform ? { text: String(platform.textContent).trim().slice(0, 200), entries: Array.prototype.map.call(platform.querySelectorAll('[data-unified-engine]'), function (b) { return { engine: b.getAttribute('data-unified-engine'), id: b.getAttribute('data-unified-id'), text: String(b.textContent).trim(), active: b.classList.contains('active') }; }) } : null,
  videoBtn: videoBtn ? { disabled: !!videoBtn.disabled, aria: videoBtn.getAttribute('aria-disabled'), mark: videoBtn.getAttribute('data-openarc-unavailable'), title: String(videoBtn.title || '') } : null,
  guardNote: (function () { const n = q('[data-openarc-guard-note="video-generation"]'); return n ? { text: String(n.textContent).trim(), where: n.parentElement ? n.parentElement.className : null } : null; })(),
  engineOptions: eng,
  settings: window.__openarcCanvasInternals ? window.__openarcCanvasInternals.getState().settings : null,
  nodeClassSample: String(document.querySelector('#world .image-node') ? document.querySelector('#world .image-node').outerHTML.slice(0, 500) : 'none')
};
`;

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  provider = await startCanvasProvider({ port: 5433 });
  await launch();
  await login();
  await js("const el = document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]') || document.querySelector('[data-dock-id=\"canvas\"]'); if (el) el.click(); return !!el;");
  await waitFor(() => !!listFrame(), 25000);
  await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';");
  await waitFor(() => !!smartFrame(), 45000);
  await waitFor(async () => (await inFrame(smartFrame(), "return !!(window.__openarcSmartGuard && window.__openarcCanvas && window.__openarcCanvasInternals);")) === true, 30000);
  await sleep(1500);
  slog("NO_MODEL", await inFrame(smartFrame(), NO_MODEL));

  // 配置 chat + image
  const prov = await model({ type: "provider/create", displayName: "Gate Facts Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "gate-facts-secret" });
  const providerId = prov && prov.provider && prov.provider.providerId;
  const cm = await model({ type: "model/create", providerId, remoteModelId: "gate-chat", displayName: "Gate Chat", capabilities: ["chat"], scope: "ORGANIZATION" });
  const im = await model({ type: "model/create", providerId, remoteModelId: "gate-image", displayName: "Gate Image", capabilities: ["image-generation"], scope: "ORGANIZATION" });
  const chatId = cm && cm.model && cm.model.configId;
  const imgId = im && im.model && im.model.configId;
  await model({ type: "defaults/set", capability: "chat", configId: chatId });
  await model({ type: "defaults/set", capability: "image-generation", configId: imgId });
  await inFrame(smartFrame(), "window.dispatchEvent(new MessageEvent('message', { data: { type: 'providers-changed' } })); return true;");
  await sleep(2500);
  const WITH_MODEL = NO_MODEL.replace("return {", "const cfg = await (await fetch('/api/config')).json(); return { cfg: { chat_models: cfg.chat_models, image_models: cfg.image_models, api_providers: cfg.api_providers, capabilities: cfg.capabilities }, ");
  slog("WITH_MODEL", await inFrame(smartFrame(), WITH_MODEL));

  // 图片生成链路
  const addImg = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_probe_gen', type:'generator', x:120, y:420, count:1 } }, null);");
  const label = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); return { image: (cfg.image_models||[])[0] || null, chat: (cfg.chat_models||[])[0] || null, provider: (cfg.api_providers||[])[0] && cfg.api_providers[0].id };");
  const runSet = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_probe_gen'); n.runSettings = { engine:'api', apiKind:'image', provider_id: " + JSON.stringify(providerId) + ", model: " + JSON.stringify(label && label.image) + ", count: 1, ratio: 'square', resolution: '1k' }; n.promptDraftText = '海边测试图'; n.promptDraftHtml = '海边测试图'; n.promptDraftTouched = true; it.primitives.render(); return { set: true };");
  const selectGen = await inFrame(smartFrame(), "const el = document.querySelector('.image-node[data-id=\"n_probe_gen\"]'); if (!el) return { click: 'missing' }; el.click(); await new Promise(r=>setTimeout(r,900)); const inp = document.getElementById('promptInput'); return { click: 'ok', promptText: inp ? String(inp.textContent) : null, runBtn: (function(){ const b=document.getElementById('runBtn'); return b ? { disabled: !!b.disabled, blocked: b.getAttribute('data-openarc-blocked') } : null; })(), settings: window.__openarcCanvasInternals.getState().settings };");
  const promptSet = await inFrame(smartFrame(), "const el = document.getElementById('promptInput'); if (!el) return 'missing'; el.textContent = '海边测试图'; el.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r=>setTimeout(r,400)); return { text: String(el.textContent), settings: window.__openarcCanvasInternals.getState().settings };");
  const beforeImg = provider.state();
  const runClick = await inFrame(smartFrame(), "const b = document.getElementById('runBtn'); if (!b) return 'no-btn'; const r = { disabled: !!b.disabled, blocked: b.getAttribute('data-openarc-blocked') }; b.click(); return r;");
  await sleep(1500);
  const afterClick = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_probe_gen'); const logs = JSON.parse(window.__openarcSmartGuard.snapshot()).logs || []; const t = Array.prototype.map.call(document.querySelectorAll('.toast, .smart-toast > div'), function(e){ return String(e.textContent||'').trim().slice(0,120); }).filter(Boolean).slice(-4); return { pending: n.pending || 0, running: !!n.running, images: (n.images||[]).length, log0: logs[0] ? { status: logs[0].status, error: String(logs[0].error||'').slice(0,200), nodeId: logs[0].nodeId } : null, toasts: t, providerReq: null };");
  const imgDone = await waitFor(async () => {
    const s = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_probe_gen'); const logs = JSON.parse(window.__openarcSmartGuard.snapshot()).logs || []; return { pending: n.pending || 0, running: !!n.running, images: (n.images||[]).length, log0: logs[0] ? { status: logs[0].status, error: String(logs[0].error||'').slice(0,120), nodeId: logs[0].nodeId } : null };");
    return s && (s.images > 0 || (s.log0 && s.log0.status === 'failed')) ? s : null;
  }, 60000);
  const afterImg = provider.state();
  slog("IMAGE_RUN", { addImg: addImg && addImg.ok, label, runSet, selectGen, promptSet, runClick, afterClick, imgDone, images: afterImg.images, chats: afterImg.chats.length, imgReq: afterImg.images, consoleTail: consoleErrors.slice(-8) });

  // 视频节点：选中后 runBtn / 参数区
  const addVid = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_probe_vid', type:'video', x:620, y:900 } }, null);");
  const selectVid = await inFrame(smartFrame(), "const el = document.querySelector('.image-node[data-id=\"n_probe_vid\"]'); if (!el) return { click: 'missing' }; el.click(); await new Promise(r=>setTimeout(r,700)); const runBtn = document.getElementById('runBtn'); const facts = window.__openarcSmartGuard.facts(); const dyn = document.getElementById('dynamicParams'); return { click: 'ok', cls: String(el.className), runBtn: { disabled: !!runBtn.disabled, blocked: runBtn.getAttribute('data-openarc-blocked'), aria: runBtn.getAttribute('aria-disabled') }, factsVideo: facts.video, settings: window.__openarcCanvasInternals.getState().settings.apiKind, dynButtons: Array.prototype.map.call(dyn.querySelectorAll('[data-smart-param]'), function (b) { return { param: b.getAttribute('data-smart-param'), value: b.getAttribute('data-smart-value'), disabled: !!b.disabled, mark: b.getAttribute('data-openarc-unavailable') }; }).slice(0, 14) };");
  const videoFetch = await inFrame(smartFrame(), "const r = await fetch('/api/canvas-video', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }); const j = await r.json().catch(function(){ return {}; }); return { status: r.status, body: j };");
  slog("VIDEO", { addVid: addVid && addVid.ok, selectVid, videoFetch, stderrBlocked: /已拦截/.test(stderrBuf) });
  const afterVideo = provider.state();

  // prompt 节点 DOM + LLM 运行
  const promptNode = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const p = it.primitives.addNode ? null : null; const r = await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_probe_prompt', type:'prompt', x:900, y:200, text:'写一句关于海边的提示词' } }, null); const n = it.primitives.getNode('n_probe_prompt'); return { ok: r.ok, node: n ? { type: n.type, text: n.text, prompt: n.prompt } : null };");
  const promptSelect = await inFrame(smartFrame(), "const el = document.querySelector('.image-node[data-id=\"n_probe_prompt\"]'); if (!el) return { click:'missing' }; el.click(); await new Promise(r=>setTimeout(r,600)); const n = window.__openarcCanvasInternals.primitives.getNode('n_probe_prompt'); const it = window.__openarcCanvasInternals; const cfg = await (await fetch('/api/config')).json(); n.llmEnabled = true; n.llmProvider = " + JSON.stringify(providerId) + "; n.llmModel = (cfg.chat_models||[])[0]; n.llmInstruction = '写一句关于海边的提示词'; it.primitives.render(); await new Promise(r=>setTimeout(r,300)); const btn = document.querySelector('.prompt-node-run'); const el2 = document.querySelector('.image-node[data-id=\"n_probe_prompt\"]'); return { hasRun: !!btn, runState: btn ? btn.getAttribute('data-run-state') : null, nodeHtml: el2 ? el2.outerHTML.slice(0, 1600) : null, providerSelect: el2 ? !!el2.querySelector('.prompt-llm-provider') : null, modelSelect: el2 ? Array.prototype.map.call(el2.querySelectorAll('.prompt-llm-model option'), function(o){ return { v:o.value, t:String(o.textContent).trim() }; }) : null };");
  const beforeLlm = provider.state();
  const runLlm = await inFrame(smartFrame(), "const b = document.querySelector('.prompt-node-run'); if (!b) return 'no-run'; b.click(); return 'clicked';");
  const llmDone = await waitFor(async () => {
    const s = await inFrame(smartFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_probe_prompt'); return { text: String(n.text||''), outputText: String(n.outputText||''), running: !!n.running, status: (function(){ try { return null; } catch(e){ return null; } })() };");
    return s && s.running === false && String(s.text || '').length > 0 && s.text.indexOf('OPENARC-CANVAS-LLM') === 0 ? s : null;
  }, 40000);
  const afterLlm = provider.state();
  slog("PROMPT_RUN", { promptNode, promptSelect: { hasRun: promptSelect.hasRun, runState: promptSelect.runState, providerSelect: promptSelect.providerSelect, modelSelect: promptSelect.modelSelect, nodeHtmlHead: String(promptSelect.nodeHtml || '').slice(0, 900) }, runLlm, llmDone, chats: afterLlm.chats.slice(-1), authSeen: afterLlm.authSeen });

  // 停用显式文本默认后的页面状态
  await model({ type: "model/setStatus", configId: chatId, status: "disabled" });
  await inFrame(smartFrame(), "window.dispatchEvent(new MessageEvent('message', { data: { type: 'providers-changed' } })); return true;");
  await sleep(2500);
  const disabledChat = await inFrame(smartFrame(), String.raw`
const cfg = await (await fetch('/api/config')).json();
const chatSel = document.getElementById('chatModelSelect');
const it = window.__openarcCanvasInternals;
const n = it.primitives.getNode('n_probe_prompt');
const runBtn = document.getElementById('runBtn');
return {
  cfg: { chat_models: cfg.chat_models, image_models: cfg.image_models, capabilities: cfg.capabilities, providers: (cfg.api_providers||[]).map(function(p){ return { id: p.id, chat: p.chat_models, image: p.image_models }; }) },
  settings: it.getState().settings,
  node: n ? { llmModel: n.llmModel, llmProvider: n.llmProvider, runSettings: n.runSettings || null } : null,
  chatSelect: chatSel ? { disabled: !!chatSel.disabled, value: chatSel.value, options: Array.prototype.map.call(chatSel.options, function(o){ return { v:o.value, t:String(o.textContent).trim() }; }) } : null,
  promptModelOptions: (function () { const el = document.querySelector('.image-node[data-id="n_probe_prompt"] .prompt-llm-model'); return el ? Array.prototype.map.call(el.options, function(o){ return { v:o.value, t:String(o.textContent).trim() }; }) : null; })(),
  runBtn: runBtn ? { disabled: !!runBtn.disabled, blocked: runBtn.getAttribute('data-openarc-blocked') } : null,
  facts: window.__openarcSmartGuard.facts()
};
`);

  // 跨能力：生图默认指到只有 chat 的模型
  await model({ type: "defaults/set", capability: "image-generation", configId: chatId });
  await inFrame(smartFrame(), "window.dispatchEvent(new MessageEvent('message', { data: { type: 'providers-changed' } })); return true;");
  await sleep(2500);
  const crossCap = await inFrame(smartFrame(), String.raw`
const cfg = await (await fetch('/api/config')).json();
const it = window.__openarcCanvasInternals;
const el = document.querySelector('.image-node[data-id="n_probe_gen"]');
if (el) el.click();
await new Promise(r=>setTimeout(r,700));
const n = it.primitives.getNode('n_probe_gen');
const runBtn = document.getElementById('runBtn');
const dyn = document.getElementById('dynamicParams');
return {
  cfg: { image_models: cfg.image_models, image_model: cfg.image_model, chat_model: cfg.chat_model, capabilities: cfg.capabilities },
  settings: it.getState().settings,
  node: n ? { runSettings: n.runSettings || null } : null,
  dynButtons: dyn ? Array.prototype.map.call(dyn.querySelectorAll('[data-smart-param]'), function(b){ return { param:b.getAttribute('data-smart-param'), value:b.getAttribute('data-smart-value'), active:b.classList.contains('active'), disabled:!!b.disabled, mark:b.getAttribute('data-openarc-unavailable') }; }).slice(0,16) : null,
  platform: (function(){ const p=document.getElementById('unifiedPlatformControl'); return p ? Array.prototype.map.call(p.querySelectorAll('[data-unified-engine]'), function(b){ return { engine:b.getAttribute('data-unified-engine'), id:b.getAttribute('data-unified-id'), text:String(b.textContent).trim(), active:b.classList.contains('active') }; }) : null; })(),
  runBtn: runBtn ? { disabled: !!runBtn.disabled, blocked: runBtn.getAttribute('data-openarc-blocked'), aria: runBtn.getAttribute('aria-disabled') } : null,
  facts: window.__openarcSmartGuard.facts()
};
`);
  slog("DISABLED_CHAT", disabledChat);
  slog("CROSS_CAP", crossCap);
  slog("PROVIDER_REQ", { chats: provider.state().chats.length, images: provider.state().images.length, afterVideo: afterVideo.images.length, authSeen: provider.state().authSeen });
}
try { await main(); } catch (e) { console.error("探针异常：" + String((e && e.stack) || e)); console.error(stderrBuf.slice(-1500)); process.exitCode = 2; }
try { if (browser) await browser.close().catch(() => {}); } catch { /* ignore */ }
try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
try { spawnSync("pkill", ["-f", "oa-gate-facts-"], { stdio: "ignore" }); } catch { /* ignore */ }
try { if (provider) await provider.close(); } catch { /* ignore */ }
