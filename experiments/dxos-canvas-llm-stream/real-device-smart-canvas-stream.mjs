/**
 * DXOS-CANVAS-LLM-STREAM · 真机验证：智能画布（smart-canvas）的流式 LLM 真的可用。
 *
 * 真实 Electron（electron .，隔离 --user-data-dir + 唯一 CDP 端口）：
 *   C1 从列表页建一本 kind=smart 的画布 → smart-canvas.html 加载（无适配层也必须有桥）
 *   C2 触发一次 LLM 调用 → 页面上真的出现**流式**文本（provider 真实 SSE，逐 token）
 *   C3 上游回非流式 → 宿主如实降级（409 → 页面退回普通接口），不伪造分块
 *   C4 取消 → 主进程在途请求被中止（provider 观察到 connection abort），不留悬挂
 *   C5 未登记端点（/api/agent/*）仍旧 501 OPENARC_UNSUPPORTED
 *   C6 出网仍被拒（OPENARC_EGRESS_BLOCKED）
 *   C7 回归：经典画布 canvas.html 的 LLM 链路仍正常
 *   d 0 pageerror / 0 未登记 5xx（桥的 501 是页面内合成响应，不会出现在 Network 里）
 *   e 截图（智能画布流式完成态）
 *   收工：真实 profile 只读快照前后比对；杀子进程 + 删隔离 userData。
 *
 * 用法：node experiments/dxos-canvas-llm-stream/real-device-smart-canvas-stream.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { startStreamProvider, STREAM_PREFIX, STREAM_CHUNKS } from "./provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-llm-stream");
const SHOTS = path.join(ART, "shots");
const CDP_PORT = Number(process.env.OA_CANVAS_LLM_STREAM_CDP_PORT || 9851);
const ADMIN = { id: "admin@oa-stream.test", pw: "oa-stream-admin-1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function realProfilePath() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openarc-os");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "openarc-os");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "openarc-os");
}
const statOf = (p) => { try { const s = fs.statSync(p); return { exists: true, mtimeMs: Math.round(s.mtimeMs), size: s.size, ino: s.ino }; } catch { return { exists: false }; } };
const sha256File = (p) => { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; } };
function snapshotProfile(dir) {
  const out = { path: dir, exists: fs.existsSync(dir), identity: {}, topLevel: {} };
  for (const name of ["identity.db", "identity.db-wal", "identity.db-shm"]) {
    const st = statOf(path.join(dir, name));
    out.identity[name] = st.exists ? { ...st, sha256: sha256File(path.join(dir, name)) } : st;
  }
  try { for (const name of fs.readdirSync(dir)) { const st = statOf(path.join(dir, name)); out.topLevel[name] = { mtimeMs: st.mtimeMs, size: st.size }; } } catch { /* 不存在 */ }
  return out;
}
const checks = [];
const record = (name, ok, expected, actual) => {
  checks.push({ name, status: ok ? "PASS" : "FAIL", expected: String(expected == null ? "" : expected), actual: typeof actual === "string" ? actual : JSON.stringify(actual) });
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + name + (ok ? "" : " -- 期望 " + expected + "，实际 " + JSON.stringify(actual)));
  return ok;
};
let passed = 0, failed = 0;
const check = (...a) => { if (record(...a)) passed += 1; else failed += 1; };

let child = null, browser = null, page = null, provider = null, userDataDir = null, cdp = null, stderrBuf = "";
const consoleErrors = [], pageErrors = [], netFailures = [], requestUrls = new Map();
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop') ? document.querySelector('.desktop').getAttribute('data-identity-gate') : 'no-root'");
const model = (payload) => js("return await window.openarc.model.command(" + JSON.stringify(payload) + ")");
const canvas = (payload) => js("return await window.openarc.canvas.command(" + JSON.stringify(payload) + ")");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const waitSel = (sel, ms) => waitFor(() => js("return !!document.querySelector(" + JSON.stringify(sel) + ")"), ms || 20000);
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const smartFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/smart-canvas\.html/);
const canvasFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas\.html/);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 300) }; }
}

async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-stream-"));
  const childEnv = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + CDP_PORT, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪（exit=" + child.exitCode + "）。electron stderr 尾部：" + stderrBuf.slice(-1500));
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  const isUI = (p) => /[\\/]dist[\\/](vue|index)\.html/.test(p.url());
  while (!page && Date.now() < end) { page = ctx.pages().find(isUI) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面：" + JSON.stringify(ctx.pages().map((p) => p.url())));
  page.on("dialog", (d) => { void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push({ url: String((m.location() || {}).url || "").slice(0, 120), text: m.text().slice(0, 300) }); });
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
  cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }).catch(() => {});
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => requestUrls.set(e.requestId, e.request.url));
  cdp.on("Network.responseReceived", (e) => { if (e.response.status >= 400) netFailures.push({ kind: "response", status: e.response.status, url: e.response.url }); });
  cdp.on("Network.loadingFailed", (e) => netFailures.push({ kind: "loadingFailed", status: 0, errorText: e.errorText, url: requestUrls.get(e.requestId) || "" }));
}

async function login() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const next = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "OA Stream Admin"); await next();
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
async function openAppWindow() {
  await js("const el = document.querySelector('[data-dock-id=\"canvas\"]') || document.querySelector('[aria-label=\"打开无限画布\"]') || document.querySelector('[aria-label=\"打开AI Studio\"]'); if (el) el.click(); return !!el;");
  return await waitFor(() => js("return !!document.querySelector('[data-canvas-host]')"), 20000);
}
async function shot(name) { fs.mkdirSync(SHOTS, { recursive: true }); const p = path.join(SHOTS, name + ".png"); await page.screenshot({ path: p }).catch(() => {}); return path.relative(ROOT, p); }

async function installStreamObserver() {
  return await js("window.__oaStreamEvents = []; if (window.__oaStreamOff) { try { window.__oaStreamOff(); } catch(e){} } window.__oaStreamOff = window.openarc.model.onEvent(function(e){ try { if (e && e.payload && e.payload.type === 'canvas.stream') window.__oaStreamEvents.push({ requestId: e.payload.requestId, type: (e.payload.event||{}).type, text: (e.payload.event||{}).text }); } catch(_){} }); return true;");
}
const readStreamEvents = () => js("return (window.__oaStreamEvents || []).map(function(p){ return { requestId: p.requestId, type: p.type, text: p.text }; })");

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const realProfile = realProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  provider = await startStreamProvider();
  await launch();
  await login();
  check("a0 · 真实 electron . 启动 + 登录（隔离 userData + CDP " + CDP_PORT + "）", (await gate()) === "ready", "ready", await gate());

  // 先登记一个确定性本地 provider（只替代最后一跳网络）
  const prov = await model({ type: "provider/create", displayName: "OA Stream Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "oa-stream-secret" });
  const providerId = prov && prov.provider && prov.provider.providerId;
  const cm = await model({ type: "model/create", providerId, remoteModelId: "oa-stream-chat", displayName: "OA Stream Chat", capabilities: ["chat"], scope: "ORGANIZATION" });
  const configId = cm && cm.model && cm.model.configId;
  await model({ type: "defaults/set", capability: "chat", configId });
  check("a1 · 本地确定性 provider + chat 模型已登记", !!providerId && !!configId, "providerId + configId", { providerId, configId });

  await openAppWindow();
  const listUp = await waitFor(() => !!listFrame(), 25000);
  check("a2 · 打开画布应用（列表页）", listUp, "canvas-list.html", listUp);

  // C1 · 建 smart 画布并进入 smart-canvas.html
  const created = await inFrame(listFrame(), "const el = document.getElementById('pickerSmart'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const smartUp = await waitFor(() => !!smartFrame(), 45000);
  const hooksUp = await waitFor(async () => (await inFrame(smartFrame(), "return typeof window.__smartAgentTestHooks === 'object' && typeof window.zoomBarCreate === 'function';")).toString() === "true", 45000);
  const smartInfo = await inFrame(smartFrame(), "return { title: document.title, hooks: typeof window.__smartAgentTestHooks, bridge: typeof window.__openarcBridge, nodes: window.__smartAgentTestHooks.nodes().length };");
  check("C1 · 列表页建智能画布 → smart-canvas.html 加载（桥存在、test hooks 就绪）",
    created === "clicked" && smartUp && hooksUp && smartInfo.bridge === "object" && smartInfo.hooks === "object",
    "smart-canvas.html + __smartAgentTestHooks + __openarcBridge", { created, smartUp, hooksUp, smartInfo });

  // 等 /api/config 把模型投影进 smart 页
  const cfgOk = await waitFor(async () => {
    const cfg = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); return { providers: (cfg.api_providers||[]).map(function(p){return p.id;}), chat: cfg.chat_models || [] };");
    return cfg && Array.isArray(cfg.chat) && cfg.chat.length >= 1 && Array.isArray(cfg.providers) && cfg.providers.length >= 1;
  }, 25000);
  const cfg = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); return { providerId: (cfg.api_providers||[])[0] && cfg.api_providers[0].id, model: (cfg.chat_models||[])[0] || null, chatCount: (cfg.chat_models||[]).length };");
  check("C1b · smart 页拿到 OpenArc 模型投影（唯一真源）", cfgOk && cfg.providerId === providerId && !!cfg.model, "api_providers[0].id == providerId + chat_models>=1", cfg);

  // 在 smart 页建一个「文本生成」节点、开 LLM、写指令
  const nodeId = await inFrame(smartFrame(), "window.zoomBarCreate('prompt'); const t = document.querySelector('.prompt-node-pill.prompt-llm-toggle'); if(!t) return null; t.click(); const hooks = window.__smartAgentTestHooks; const list = hooks.nodes().filter(function(n){return n.type === 'smart-prompt';}); const n = list[list.length-1]; if(!n) return null; hooks.setLocal(n.id, 'llmProvider', " + JSON.stringify(cfg.providerId) + "); hooks.setLocal(n.id, 'llmModel', " + JSON.stringify(cfg.model) + "); const el = document.querySelector('.prompt-llm-instruction'); if(!el) return null; el.textContent = '写一句关于海边的提示词'; el.dispatchEvent(new Event('input', { bubbles: true })); return { id: n.id, enabled: hooks.node(n.id).llmEnabled, instruction: hooks.node(n.id).llmInstruction };");
  check("C1c · 建文本生成节点 + 打开 LLM + 写入指令", !!(nodeId && nodeId.id) && nodeId.enabled === true, "smart-prompt 节点 llmEnabled=true", nodeId);
  const nid = nodeId && nodeId.id;

  // C2 · 触发一次流式 LLM，抓分块序列 + 页面文本
  await installStreamObserver();
  const trigger = await inFrame(smartFrame(), "const b = document.querySelector('.prompt-node-run'); if(!b) return 'no-run'; b.click(); return 'clicked';");
  const streamed = await waitFor(async () => {
    const n = await inFrame(smartFrame(), "const hooks = window.__smartAgentTestHooks; const n = hooks.node(" + JSON.stringify(nid) + "); return n ? { text: String(n.outputText || n.text || ''), running: !!n.running } : null;");
    return n && n.running === false && typeof n.text === "string" && n.text.length > 0 ? n : null;
  }, 40000);
  const pageText = await inFrame(smartFrame(), "const hooks = window.__smartAgentTestHooks; const n = hooks.node(" + JSON.stringify(nid) + "); return String(n.outputText || n.text || '');");
  const events = await readStreamEvents();
  const pstate = provider.state();
  const shotSmart = await shot("smart-canvas-stream");
  const deltas = events.filter((e) => e.type === "text.delta").map((e) => e.text);
  const expectedText = STREAM_CHUNKS.join("");
  check("C2 · 智能画布 LLM 真实流式：页面出现流式文本 + 分块序列与 provider SSE 一致",
    trigger === "clicked" && !!streamed && pageText === expectedText && pstate.chats.length === 1 && pstate.chats[0].stream === true && pstate.chats[0].streamed === true && JSON.stringify(deltas) === JSON.stringify(STREAM_CHUNKS),
    "页面文本=" + expectedText + "，delta 序列=" + JSON.stringify(STREAM_CHUNKS), { trigger, pageText, deltas, events: events.slice(0, 8), chats: pstate.chats });

  // C3 · 上游回非流式 → 如实降级（409 → 普通接口），不伪造分块
  await provider.setMode("nonstream");
  await installStreamObserver();
  const trigger3 = await inFrame(smartFrame(), "const b = document.querySelector('.prompt-node-run'); if(!b) return 'no-run'; b.click(); return 'clicked';");
  const fallbackDone = await waitFor(async () => {
    const n = await inFrame(smartFrame(), "const hooks = window.__smartAgentTestHooks; const n = hooks.node(" + JSON.stringify(nid) + "); return n ? { text: String(n.outputText || n.text || ''), running: !!n.running } : null;");
    return n && n.running === false && typeof n.text === "string" && n.text.length > 0 ? n : null;
  }, 40000);
  const events3 = await readStreamEvents();
  const pstate3 = provider.state();
  const deltas3 = events3.filter((e) => e.type === "text.delta");
  check("C3 · 上游非流式：宿主如实降级（0 条伪造 delta；页面仍拿到普通接口结果）",
    trigger3 === "clicked" && !!fallbackDone && deltas3.length === 0 && pstate3.chats.length === 2 && pstate3.chats[0].stream === true && pstate3.chats[1].stream === false,
    "第一次 stream:true 无 delta 后回退，第二次 stream:false", { fallbackDone, deltas3, chats: pstate3.chats });

  // C4 · 取消：中止主进程在途请求
  await provider.setMode("slow");
  await installStreamObserver();
  const trigger4 = await inFrame(smartFrame(), "const b = document.querySelector('.prompt-node-run'); if(!b) return 'no-run'; b.click(); return 'clicked';");
  const firstChunk = await waitFor(async () => (await readStreamEvents()).some((e) => e.type === "text.delta"), 30000);
  const stop = await inFrame(smartFrame(), "const b = document.querySelector('.prompt-node-run'); if(!b) return 'no-stop'; b.click(); return { state: b.getAttribute('data-run-state') };");
  const aborted = await waitFor(async () => provider.state().aborted >= 1, 20000);
  const cancelState = await inFrame(smartFrame(), "const hooks = window.__smartAgentTestHooks; const n = hooks.node(" + JSON.stringify(nid) + "); return { running: !!n.running, text: String(n.outputText || n.text || '') };");
  check("C4 · 用户取消 → 主进程在途 provider 请求被中止（provider 观察到 abort）",
    trigger4 === "clicked" && firstChunk && !!stop && aborted && cancelState.running === false,
    "provider.aborted >= 1 且节点不再 running", { firstChunk, stop, aborted, provider: provider.state(), cancelState });

  // C5 / C6 · smart 页上的白名单与出网
  const boundary = await inFrame(smartFrame(), "const probe = async (url, init) => { try { const r = await fetch(url, init || {}); let j = null; try { j = await r.json(); } catch(e) {} return { status: r.status, error: (j && j.error) || null }; } catch(e) { return { thrown: String((e && e.message) || e) }; } }; return { agent: await probe('/api/agent/plan', { method:'POST', body:'{}' }), agentRun: await probe('/api/agent/run', { method:'POST', body:'{}' }), egress: await probe('https://example.com/steal'), update: await probe('/api/check-update') };");
  check("C5 · 升级新增的 /api/agent/* 保持 501 OPENARC_UNSUPPORTED（不静默、不假成功）",
    boundary.agent && boundary.agent.status === 501 && boundary.agent.error === "OPENARC_UNSUPPORTED" && boundary.agentRun && boundary.agentRun.status === 501,
    "501 OPENARC_UNSUPPORTED", { agent: boundary.agent, agentRun: boundary.agentRun });
  check("C6 · 出网仍被拒 / 更新仍禁用",
    boundary.egress && boundary.egress.status === 501 && boundary.egress.error === "OPENARC_EGRESS_BLOCKED" && boundary.update && boundary.update.status === 501 && boundary.update.error === "OPENARC_UPDATE_DISABLED",
    "OPENARC_EGRESS_BLOCKED + OPENARC_UPDATE_DISABLED", { egress: boundary.egress, update: boundary.update });

  // C7 · 回归：经典画布 canvas.html 的 LLM 链路仍正常（先恢复 provider 正常模式）
  await provider.setMode("stream");
  const back = await inFrame(smartFrame(), "const el = document.querySelector('.smart-back'); if(!el) return 'missing'; el.click(); return 'clicked';");
  const backToList = await waitFor(() => !!listFrame() && !smartFrame(), 30000);
  const createdClassic = await inFrame(listFrame(), "const el = document.getElementById('btnNewProject'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const editorUp = await waitFor(() => !!canvasFrame(), 45000);
  const adapterUp = await waitFor(async () => (await inFrame(canvasFrame(), "return typeof window.__openarcCanvas === 'object';")).toString() === "true", 30000);
  const classic = await inFrame(canvasFrame(), "const cfg = await (await fetch('/api/config')).json(); const it = window.__openarcCanvasInternals; await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_prompt', type:'prompt', x:80, y:120, text:'经典画布回归' } }, null); await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_llm', type:'llm', x:420, y:120, model:'', systemPrompt:'You are a helpful assistant.' } }, null); await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_llm' }, null); const n = it.primitives.getNode('n_llm'); n.model = cfg.chat_models[0]; it.primitives.render(); window.__openarcCanvas.runNode('n_llm'); return { started: true, model: n.model };");
  const classicDone = (await waitFor(async () => {
    const n = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { status: n.runStatus, text: String(n.outputText || n.text || '') };");
    return n && (n.status === "done" || n.status === "failed") ? n : null;
  }, 40000)) ? await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { status: n.runStatus, error: n.runError || '', text: String(n.outputText || n.text || '') };") : null;
  const pstateClassic = provider.state();
  check("C7 · 回归：经典画布 canvas.html 的 LLM 链路仍正常（非流式 /api/canvas-llm）",
    back === "clicked" && backToList && createdClassic === "clicked" && editorUp && adapterUp && classic && classic.started === true && !!classicDone && classicDone.status === "done" && String(classicDone.text).length > 0,
    "canvas.html 节点 done + 有文本", { back, backToList, createdClassic, editorUp, adapterUp, classic, classicDone, chats: pstateClassic.chats.length });

  const shotClassic = await shot("classic-canvas-regression");
  await sleep(1200);

  const pageErrorsFiltered = pageErrors.filter((e) => !/AbortError|The operation was aborted/.test(e));
  const notFound = netFailures.filter((f) => f.status === 404);
  const serverErrors = netFailures.filter((f) => f.status >= 500);
  check("d1 · 0 条 404（asset not found）", notFound.length === 0, "0 个 404", notFound.slice(0, 10));
  check("d2 · 0 条 pageerror（取消产生的 AbortError 除外）", pageErrorsFiltered.length === 0, "0 条 pageerror", pageErrorsFiltered.slice(0, 10));
  check("d3 · 0 条网络 5xx", serverErrors.length === 0, "0 个 5xx", serverErrors.slice(0, 10));

  const result = {
    ok: failed === 0, cdpPort: CDP_PORT, providerId, configId,
    smartCanvasId: smartInfo, checks,
    stream: { pageText, deltas, events: events.slice(0, 20) },
    fallback: { events3: events3.slice(0, 20), chats: pstate3.chats },
    cancel: { provider: provider.state(), cancelState },
    consoleErrors, pageErrors: pageErrorsFiltered, notFound, serverErrors,
    shots: { smart: shotSmart, classic: shotClassic },
  };
  fs.writeFileSync(path.join(ART, "RESULT.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("\n==== 截图 ====");
  for (const [k, v] of Object.entries(result.shots)) console.log("  " + k + ": " + v);

  try { await browser.close(); } catch { /* ignore */ }
  browser = null;
  if (child && !child.killed) { child.kill("SIGTERM"); await sleep(1200); try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (provider) await provider.close().catch(() => {});
  if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
  const profileAfter = snapshotProfile(realProfile);
  fs.writeFileSync(path.join(ART, "profile-before.json"), JSON.stringify(profileBefore, null, 2) + "\n");
  fs.writeFileSync(path.join(ART, "profile-after.json"), JSON.stringify(profileAfter, null, 2) + "\n");
  const changed = [];
  for (const name of ["identity.db", "identity.db-wal", "identity.db-shm"]) if (JSON.stringify(profileBefore.identity[name]) !== JSON.stringify(profileAfter.identity[name])) changed.push("identity:" + name);
  for (const name of new Set([...Object.keys(profileBefore.topLevel || {}), ...Object.keys(profileAfter.topLevel || {})])) if (JSON.stringify(profileBefore.topLevel[name]) !== JSON.stringify(profileAfter.topLevel[name])) changed.push("top:" + name);
  check("f · 真实 profile 收工前后未变（只读快照）", changed.length === 0, "完全一致", changed.slice(0, 20));
  result.profileUnchanged = changed.length === 0;
  result.profileChanged = changed;
  result.isolatedUserDataRemoved = !fs.existsSync(userDataDir);
  result.ok = failed === 0;
  fs.writeFileSync(path.join(ART, "RESULT.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("\n==== 汇总：PASS " + passed + " / FAIL " + failed + " ====");
  process.exitCode = result.ok ? 0 : 1;
}

main().catch(async (e) => {
  console.error("探针异常：" + String((e && e.stack) || e));
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  if (child && !child.killed) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (provider) await provider.close().catch(() => {});
  if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
  process.exitCode = 2;
});
