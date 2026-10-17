/**
 * DXOS-CANVAS-REVENDOR-NEXT · 真机验证：重新 vendor 后的入口 / 单一真源 / 未接通禁用 /
 * 真实模型调用 / 返回列表 / 应用内模态 / 只读 / 0 错误。
 *
 * 真实 Electron（electron .，隔离 --user-data-dir + 唯一 CDP 端口）逐条验证：
 *   E1 列表页「新建画布」(#btnStartCreate) → 进入 smart-canvas.html（canvas.html 已删）
 *   E2 C1：window.__openarcSmartGuard 就绪；供应商/模型只来自宿主 /api/config 投影
 *   E2b 四把页面记忆键被锁（读恒 null、写丢弃）
 *   E2c 命令适配器就绪（window.__openarcCanvas + adapter-ready 同一条协议）
 *   E3 C2：创建菜单「视频节点」真实 disabled + data-openarc-unavailable + 既有未接通文案；
 *      engine option disabled；POST /api/canvas-video 页面侧 501 CAPABILITY_UNAVAILABLE
 *   E4 编辑 + 真实模型调用：建文本生成节点 → 本地确定性 provider 真实 SSE 回到页面
 *   E5 返回列表（.smart-back）
 *   E6 「继续上次」→ 智能画布且是同一本
 *   E7 卡片点击 → 智能画布且是同一本
 *   E8 重命名走应用内模态
 *   E9 只读 context → data-openarc-readonly=1 + 编辑面 pointer-events=none
 *   E10 浅/深截图
 *   E11 0 console error / 0 pageerror / 0 条 404 / 0 条 5xx
 *   收工：真实 profile 只读快照前后比对；杀子进程 + 删隔离 userData。
 *
 * 用法：node experiments/dxos-canvas-revendor-next/entry-probe.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { startStreamProvider, STREAM_PREFIX, STREAM_CHUNKS } from "../dxos-canvas-llm-stream/provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-revendor-next");
const SHOTS = path.join(ART, "shots");
const CDP_PORT = Number(process.env.OA_CANVAS_REVENDOR_CDP_PORT || 9872);
const ADMIN = { id: "admin@oa-revendor.test", pw: "oa-revendor-admin-1" };
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
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const waitSel = (sel, ms) => waitFor(() => js("return !!document.querySelector(" + JSON.stringify(sel) + ")"), ms || 20000);
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const smartFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/smart-canvas\.html/);
const classicFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas\.html/);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 300) }; }
}
async function shot(name) { fs.mkdirSync(SHOTS, { recursive: true }); const p = path.join(SHOTS, name + ".png"); await page.screenshot({ path: p }).catch(() => {}); return path.relative(ROOT, p); }

async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-scope-entry-"));
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
    await setInput('[data-d3-id="setup-name"]', "OA Scope Admin"); await next();
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
async function installStreamObserver() {
  return await js("window.__oaStreamEvents = []; if (window.__oaStreamOff) { try { window.__oaStreamOff(); } catch(e){} } window.__oaStreamOff = window.openarc.model.onEvent(function(e){ try { if (e && e.payload && e.payload.type === 'canvas.stream') window.__oaStreamEvents.push({ requestId: e.payload.requestId, type: (e.payload.event||{}).type, text: (e.payload.event||{}).text }); } catch(_){} }); return true;");
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const realProfile = realProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  provider = await startStreamProvider();
  await launch();
  await login();
  check("a0 · 真实 electron . 启动 + 登录（隔离 userData + CDP " + CDP_PORT + "）", (await gate()) === "ready", "ready", await gate());

  const prov = await model({ type: "provider/create", displayName: "OA Scope Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "oa-scope-secret" });
  const providerId = prov && prov.provider && prov.provider.providerId;
  const cm = await model({ type: "model/create", providerId, remoteModelId: "oa-scope-chat", displayName: "OA Scope Chat", capabilities: ["chat"], scope: "ORGANIZATION" });
  const configId = cm && cm.model && cm.model.configId;
  const im = await model({ type: "model/create", providerId, remoteModelId: "oa-scope-image", displayName: "OA Scope Image", capabilities: ["image-generation"], scope: "ORGANIZATION" });
  const imgConfigId = im && im.model && im.model.configId;
  await model({ type: "defaults/set", capability: "chat", configId });
  await model({ type: "defaults/set", capability: "image-generation", configId: imgConfigId });
  check("a1 · 本地确定性 provider + chat/image 模型已登记", !!providerId && !!configId && !!imgConfigId, "providerId + configId + imgConfigId", { providerId, configId, imgConfigId });

  await openAppWindow();
  const listUp = await waitFor(() => !!listFrame(), 25000);
  check("a2 · 打开画布应用（列表页 canvas-list.html）", listUp, "canvas-list.html", listUp);
  const shotListLight = await shot("list-light");

  // E1 · 新建画布 → 智能画布
  const created = await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const smartUp = await waitFor(() => !!smartFrame() && !listFrame(), 45000);
  const guardUp = await waitFor(async () => (await inFrame(smartFrame(), "return typeof window.__openarcSmartGuard === 'object' && !!window.__openarcSmartGuard;")).toString() === "true", 30000);
  const id1 = await inFrame(smartFrame(), "return (window.__openarcBridge && window.__openarcBridge.context && window.__openarcBridge.context.canvasId) || null;");
  check("E1 · 列表页「新建画布」→ 进入 smart-canvas.html（不再是 canvas.html）+ 最小封堵就绪",
    created === "clicked" && smartUp && guardUp && !!id1 && !classicFrame(), "smart-canvas.html + __openarcSmartGuard + canvasId + 无经典帧", { created, smartUp, guardUp, id1, classic: !!classicFrame() });

  // E2 · C1 单一真源
  const facts = await inFrame(smartFrame(), "return window.__openarcSmartGuard ? window.__openarcSmartGuard.facts() : null;");
  const platform = await inFrame(smartFrame(), "const c = document.getElementById('unifiedPlatformControl'); const ids = c ? Array.prototype.map.call(c.querySelectorAll('[data-unified-engine]'), function(b){ return b.getAttribute('data-unified-engine') + ':' + (b.getAttribute('data-unified-id') || ''); }) : []; return ids;");
  const fakeEngines = ["volcengine", "modelscope", "comfy", "runninghub"];
  const platformHasFake = Array.isArray(platform) && platform.some((x) => fakeEngines.some((f) => String(x).indexOf(f) === 0));
  const providers = facts && facts.providers ? facts.providers : [];
  check("E2 · C1 供应商/模型只来自宿主：providers 只含宿主 provider，平台控件 0 个页面内置引擎",
    !!facts && facts.hosted === true && providers.length >= 1 && providers.indexOf(providerId) >= 0 && !providers.some((p) => fakeEngines.indexOf(p) >= 0) && !platformHasFake,
    "providers=" + JSON.stringify([providerId]) + "；平台控件无 volcengine/modelscope/comfy/runninghub",
    { facts, platform });

  // E2b · 四把页面记忆键被锁（第二来源失效）
  const storage = await inFrame(smartFrame(), "try { localStorage.setItem('smart_chat_model','FAKE'); localStorage.setItem('smart_chat_provider','FAKE'); localStorage.setItem('smart_agent_image_provider','FAKE'); localStorage.setItem('smart_canvas_recent_run_settings_v1','{}'); } catch(e){} const ls=window.localStorage; const proto=window.Storage && window.Storage.prototype; return { chatModel: localStorage.getItem('smart_chat_model'), chatProvider: localStorage.getItem('smart_chat_provider'), agentProvider: localStorage.getItem('smart_agent_image_provider'), recent: localStorage.getItem('smart_canvas_recent_run_settings_v1'), meta: window.__openarcSmartGuard.storage(), diag: { storageType: typeof window.Storage, sameProto: !!(proto && Object.getPrototypeOf(ls)===proto), protoLock: !!(proto && proto.__openarcSmartStorageLocked), fn: (typeof ls.setItem==='function' ? String(ls.setItem).slice(0,160) : null), own: Object.prototype.hasOwnProperty.call(ls,'setItem') } };");
  check("E2b · 页面记忆键被锁：读恒 null、写丢弃（第二来源失效）",
    !!storage && storage.chatModel === null && storage.chatProvider === null && storage.agentProvider === null && storage.recent === null && storage.meta && storage.meta.locked === true,
    "四把键读回 null + locked=true", storage);

  // E2c · 命令适配器就绪（同一套宿主协议）
  const adapter = await inFrame(smartFrame(), "return { has: typeof window.__openarcCanvas === 'object' && !!window.__openarcCanvas, state: window.__openarcCanvas && window.__openarcCanvas.state ? window.__openarcCanvas.state() : null, internals: !!window.__openarcCanvasInternals };");
  check("E2c · 智能画布命令适配器就绪（window.__openarcCanvas + internals）",
    !!adapter && adapter.has === true && adapter.internals === true && !!adapter.state && adapter.state.canvasId === id1,
    "adapter.state.canvasId === " + id1, adapter);
  const adapterCmd = await inFrame(smartFrame(), "const api=window.__openarcCanvas; const add=await api.applyCommand({type:'node.add', node:{id:'adapter_probe', type:'image', x:200, y:200, url:'data:image/png;base64,iVBORw0KGgo='}}, null); const n=api.getNode('adapter_probe'); const st=api.state(); const move=await api.applyCommand({type:'node.move', id:'adapter_probe', x:260, y:240}, st.revision); const moved=api.getNode('adapter_probe'); const del=await api.applyCommand({type:'node.delete', id:'adapter_probe'}, null); const afterDelete=!!api.getNode('adapter_probe'); api.undo(); const afterUndo=!!api.getNode('adapter_probe'); api.redo(); const afterRedo=!!api.getNode('adapter_probe'); return {add:add.ok, node:!!n, x:n&&n.x, move:move.ok, movedX:moved&&moved.x, del:del.ok, afterDelete, afterUndo, afterRedo, revision:st.revision};");
  check("E2d · 命令适配器真实执行：node.add → node.move → node.delete → undo/redo",
    !!adapterCmd && adapterCmd.add === true && adapterCmd.node === true && adapterCmd.move === true && adapterCmd.movedX === 260 && adapterCmd.del === true && adapterCmd.afterDelete === false && adapterCmd.afterUndo === true && adapterCmd.afterRedo === false,
    "add/move/delete/undo/redo 全部经 window.__openarcCanvas 生效", adapterCmd);

  // E3 · C2 未接通能力如实禁用 + 页面侧明确失败（新源码把视频改成创建菜单的节点类型，没有 apiKindToggle）
  const videoUi = await inFrame(smartFrame(), "const b = document.querySelector('#createMenu [data-create-type=\"video\"]'); const note = document.querySelector('[data-openarc-guard-note=\"video-generation\"]'); const opt = document.querySelector('#engineSelect option[value=\"comfy\"]'); const cs = b ? getComputedStyle(b) : null; return { disabled: b ? b.disabled : null, aria: b ? b.getAttribute('aria-disabled') : null, mark: b ? b.getAttribute('data-openarc-unavailable') : null, title: b ? b.getAttribute('title') : null, opacity: cs ? cs.opacity : null, note: note ? String(note.textContent || '') : null, noteVisible: note ? getComputedStyle(note).display !== 'none' : null, comfyDisabled: opt ? opt.disabled : null, apiKindToggle: !!document.getElementById('apiKindToggle') };");
  const videoApi = await inFrame(smartFrame(), "const r = await fetch('/api/canvas-video', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }); const j = await r.json().catch(function(){ return {}; }); return { status: r.status, error: j.error || null, message: j.message || null };");
  check("E3 · C2 视频未接通：创建菜单「视频节点」真实 disabled + data-openarc-unavailable + 既有未接通文案；/api/canvas-video 页面侧 501",
    !!videoUi && videoUi.disabled === true && videoUi.aria === "true" && videoUi.mark === "video-generation" && /OpenArc 未接通视频传输（不可用）/.test(String(videoUi.note || "")) && videoUi.noteVisible === true && videoUi.comfyDisabled === true && videoUi.apiKindToggle === false && videoApi && videoApi.status === 501 && videoApi.error === "CAPABILITY_UNAVAILABLE",
    "disabled + aria + data-openarc-unavailable + 文案可见；501 CAPABILITY_UNAVAILABLE", { videoUi, videoApi });
  const imageSel = await inFrame(smartFrame(), "const hooks = window.__smartAgentTestHooks; hooks.applyOps({ nodes_upsert: [{ id: 'n_scope_img', type: 'smart-image', x: 120, y: 120, w: 320, h: 240 }] }); await new Promise(function(r){ setTimeout(r, 900); }); const el = document.querySelector('[data-id=\"n_scope_img\"]'); if(el) el.click(); await new Promise(function(r){ setTimeout(r, 700); }); const b = document.querySelector('#createMenu [data-create-type=\"video\"]'); const n = document.querySelector('[data-openarc-guard-note=\"video-generation\"]'); const cs = n ? getComputedStyle(n) : null; return { nodeEl: !!el, videoDisabled: b ? b.disabled : null, videoMark: b ? b.getAttribute('data-openarc-unavailable') : null, noteText: n ? String(n.textContent || '') : null, noteVisible: cs ? (cs.display !== 'none' && cs.visibility !== 'hidden') : null, composerVisible: !!document.getElementById('composer') && getComputedStyle(document.getElementById('composer')).display !== 'none' };");
  check("E3b · 图片节点选中时：视频节点入口仍真实禁用 + 未接通文案可见（人眼可辨）",
    !!imageSel && imageSel.nodeEl === true && imageSel.videoDisabled === true && imageSel.videoMark === "video-generation" && /未接通视频传输（不可用）/.test(String(imageSel.noteText || "")) && imageSel.noteVisible === true && imageSel.composerVisible === true,
    "video disabled + note 可见", imageSel);
  await inFrame(smartFrame(), "const w=document.getElementById('world'); const r=w.getBoundingClientRect(); w.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,composed:true,view:window,clientX:r.left+320,clientY:r.top+260})); return true;");
  await sleep(600);
  const videoMenu = await inFrame(smartFrame(), "const menu=document.getElementById('createMenu'); const b=menu && menu.querySelector('[data-create-type=video]'); const cs=b?getComputedStyle(b):null; return { open: !!(menu && menu.classList.contains('open')), disabled: b?b.disabled:null, opacity: cs?cs.opacity:null, text: b?String(b.textContent||'').trim():null, mark: b?b.getAttribute('data-openarc-unavailable'):null };");
  const shotSmartMenu = await shot("smart-video-menu-light");
  check("E3c · 创建菜单可见时「视频节点」仍是禁用态（0.45 透明 + 不可点）",
    !!videoMenu && videoMenu.open === true && videoMenu.disabled === true && videoMenu.mark === "video-generation" && Number(videoMenu.opacity) < 0.6,
    "menu open + video disabled + opacity<0.6", videoMenu);
  await inFrame(smartFrame(), "document.getElementById('createMenu') && document.getElementById('createMenu').classList.remove('open'); return true;");
  await sleep(250);
  const shotSmartVideo = await shot("smart-video-disabled-light");
  await inFrame(smartFrame(), "document.documentElement.classList.add('studio-theme-dark','theme-dark'); return 'dark';");
  await sleep(400);
  const shotSmartVideoDark = await shot("smart-video-disabled-dark");
  await inFrame(smartFrame(), "document.documentElement.classList.remove('studio-theme-dark','theme-dark'); return 'light';");

  // E4 · 编辑 + 真实模型调用（文本 LLM，经本地确定性 provider 真实 SSE）
  const cfg = await inFrame(smartFrame(), "const cfg = await (await fetch('/api/config')).json(); return { providerId: (cfg.api_providers||[])[0] && cfg.api_providers[0].id, model: (cfg.chat_models||[])[0] || null, chatCount: (cfg.chat_models||[]).length };");
  const nodeReady = await inFrame(smartFrame(), "window.zoomBarCreate('prompt'); const t = document.querySelector('.prompt-node-pill.prompt-llm-toggle'); if(!t) return null; t.click(); const hooks = window.__smartAgentTestHooks; const list = hooks.nodes().filter(function(n){return n.type === 'smart-prompt';}); const n = list[list.length-1]; if(!n) return null; hooks.setLocal(n.id, 'llmProvider', " + JSON.stringify(providerId) + "); hooks.setLocal(n.id, 'llmModel', " + JSON.stringify(cfg && cfg.model) + "); const el = document.querySelector('.prompt-llm-instruction'); if(!el) return null; el.textContent = '写一句关于海边的提示词'; el.dispatchEvent(new Event('input', { bubbles: true })); return { id: n.id, enabled: hooks.node(n.id).llmEnabled };");
  const nid = nodeReady && nodeReady.id;
  await installStreamObserver();
  const trigger = await inFrame(smartFrame(), "const b = document.querySelector('.prompt-node-run'); if(!b) return 'no-run'; b.click(); return 'clicked';");
  const streamed = await waitFor(async () => {
    const n = await inFrame(smartFrame(), "const hooks = window.__smartAgentTestHooks; const n = hooks.node(" + JSON.stringify(nid) + "); return n ? { text: String(n.outputText || n.text || ''), running: !!n.running } : null;");
    return n && n.running === false && typeof n.text === "string" && n.text.length > 0 ? n : null;
  }, 40000);
  const pageText = await inFrame(smartFrame(), "const hooks = window.__smartAgentTestHooks; const n = hooks.node(" + JSON.stringify(nid) + "); return String(n.outputText || n.text || '');");
  const pstate = provider.state();
  const shotSmartLight = await shot("smart-edit-llm-light");
  const expectedText = STREAM_CHUNKS.join("");
  check("E4 · 智能画布可编辑 + 真实模型调用成功（页面出现 provider 真实流式文本）",
    !!nodeReady && nodeReady.enabled === true && trigger === "clicked" && !!streamed && pageText === expectedText && pstate.chats.length >= 1 && pstate.chats[0].stream === true,
    "页面文本=" + expectedText + " + provider 收到 stream:true", { nodeReady, trigger, pageText, chats: pstate.chats });

  // E9 · C3 只读闸（合成 context：只读事实 → 编辑面关闭；随后恢复）
  const ro = await inFrame(smartFrame(), "window.dispatchEvent(new CustomEvent('openarc-canvas-context', { detail: { canEdit: false, readOnly: true, canvasId: window.__openarcBridge.context.canvasId } })); await new Promise(function(r){ setTimeout(r, 350); }); const c = document.getElementById('composer'); return { attr: document.documentElement.getAttribute('data-openarc-readonly'), composer: c ? getComputedStyle(c).pointerEvents : null, flag: !!window.__openarcCanvasReadOnly, blocked: window.__openarcSmartGuard.blocked().length };");
  const shotReadonly = await shot("smart-readonly-light");
  const roBack = await inFrame(smartFrame(), "window.dispatchEvent(new CustomEvent('openarc-canvas-context', { detail: { canEdit: true, readOnly: false, canvasId: window.__openarcBridge.context.canvasId } })); await new Promise(function(r){ setTimeout(r, 350); }); const c = document.getElementById('composer'); return { attr: document.documentElement.getAttribute('data-openarc-readonly'), composer: c ? getComputedStyle(c).pointerEvents : null, flag: !!window.__openarcCanvasReadOnly };");
  check("E9 · C3 只读 context：data-openarc-readonly=1 + 编辑面 pointer-events=none；恢复后关闭",
    !!ro && ro.attr === "1" && ro.composer === "none" && ro.flag === true && !!roBack && roBack.attr === "0" && roBack.composer !== "none" && roBack.flag === false,
    "只读属性 + composer pointerEvents=none；恢复 = 0", { ro, roBack });

  // E5 · 返回列表
  const back = await inFrame(smartFrame(), "const el = document.querySelector('.smart-back'); if(!el) return 'missing'; el.click(); return 'clicked';");
  const backToList = await waitFor(() => !!listFrame() && !smartFrame(), 30000);
  check("E5 · 「返回列表」→ canvas-list.html（同一宿主帧导航）", back === "clicked" && backToList, "回到列表页", { back, backToList });

  // E6 · 继续上次 → 智能画布同一本
  const cont = await inFrame(listFrame(), "const el = document.getElementById('btnContinueLast'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const contUp = await waitFor(() => !!smartFrame(), 45000);
  const contId = await inFrame(smartFrame(), "return (window.__openarcBridge && window.__openarcBridge.context && window.__openarcBridge.context.canvasId) || null;");
  check("E6 · 「继续上次」→ 智能画布，且是同一本画布（id 一致）", cont === "clicked" && contUp && contId === id1, "smart-canvas.html + canvasId=" + id1, { cont, contUp, contId, id1 });

  // E7 · 卡片点击 → 智能画布同一本
  await inFrame(smartFrame(), "document.querySelector('.smart-back') && document.querySelector('.smart-back').click(); return 'clicked';");
  await waitFor(() => !!listFrame() && !smartFrame(), 30000);
  const cardClick = await inFrame(listFrame(), "const card = Array.prototype.slice.call(document.querySelectorAll('#cardsGrid .project-card')).filter(function(c){ return c.getAttribute('data-canvas-id') === " + JSON.stringify(id1) + "; })[0]; if(!card) return 'no-card'; card.click(); return 'clicked';");
  const cardUp = await waitFor(() => !!smartFrame(), 45000);
  const cardId = await inFrame(smartFrame(), "return (window.__openarcBridge && window.__openarcBridge.context && window.__openarcBridge.context.canvasId) || null;");
  check("E7 · 卡片点击 → 智能画布，且是同一本画布（id 一致）", cardClick === "clicked" && cardUp && cardId === id1, "smart-canvas.html + canvasId=" + id1, { cardClick, cardUp, cardId });

  // E8 · 重命名走应用内模态（回归）
  await inFrame(smartFrame(), "document.querySelector('.smart-back') && document.querySelector('.smart-back').click(); return 'clicked';");
  await waitFor(() => !!listFrame() && !smartFrame(), 30000);
  await inFrame(listFrame(), "document.documentElement.classList.add('studio-theme-dark','theme-dark'); return 'dark';");
  await sleep(400);
  const shotListDark = await shot("list-dark");
  await inFrame(listFrame(), "document.documentElement.classList.remove('studio-theme-dark','theme-dark'); return 'light';");
  const openModal = await inFrame(listFrame(), "const cards = Array.prototype.slice.call(document.querySelectorAll('#cardsGrid .project-card')); const card = cards.filter(function(c){ return c.getAttribute('data-canvas-id') === " + JSON.stringify(id1) + "; })[0]; if(!card) return 'no-card'; card.querySelector('.card-more-btn').click(); const item = card.querySelector('[data-action=\"rename\"]'); if(!item) return 'no-item'; item.click(); return 'clicked';");
  const modalOpen = await waitFor(async () => (await inFrame(listFrame(), "return !!document.querySelector('.openarc-prompt-overlay.active');")) === true, 10000);
  const modalState = await inFrame(listFrame(), "const ov = document.querySelector('.openarc-prompt-overlay.active'); return ov ? { open: true, value: (ov.querySelector('.openarc-prompt-input')||{}).value || '' } : { open: false };");
  const shotModal = await shot("list-rename-modal-light");
  await inFrame(listFrame(), "document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })); return 'esc';");
  await sleep(400);
  const modalClosed = await waitFor(async () => { const s = await inFrame(listFrame(), "return !document.querySelector('.openarc-prompt-overlay.active');"); return s === true; }, 8000);
  check("E8 · 卡片「重命名」走应用内模态（打开 + 预填 + Esc 关闭，回归确认）", openModal === "clicked" && modalOpen === true && !!modalState && modalState.open === true && typeof modalState.value === "string" && modalState.value.length > 0 && modalClosed, "模态打开 + Esc 关闭", { openModal, modalOpen, modalState, modalClosed });

  await sleep(1000);
  const pageErrorsFiltered = pageErrors.filter((e) => !/AbortError|The operation was aborted/.test(e));
  const notFound = netFailures.filter((f) => f.status === 404);
  const serverErrors = netFailures.filter((f) => f.status >= 500);
  check("E11a · 0 条 404", notFound.length === 0, "0 个 404", notFound.slice(0, 10));
  check("E11b · 0 条 pageerror（取消产生的 AbortError 除外）", pageErrorsFiltered.length === 0, "0 条 pageerror", pageErrorsFiltered.slice(0, 10));
  check("E11c · 0 条网络 5xx", serverErrors.length === 0, "0 个 5xx", serverErrors.slice(0, 10));
  check("E11d · 0 条 console error", consoleErrors.length === 0, "0 条 console error", consoleErrors.slice(0, 10));

  const result = {
    ok: failed === 0, cdpPort: CDP_PORT, providerId, configId, imgConfigId,
    canvasId: id1, checks,
    facts, platform, videoUi, videoApi, imageSel,
    llm: { pageText, expectedText, chats: pstate.chats },
    readOnly: { ro, roBack },
    consoleErrors, pageErrors: pageErrorsFiltered, notFound, serverErrors,
    shots: { listLight: shotListLight, listDark: shotListDark, smartVideo: shotSmartVideo, smartVideoMenu: shotSmartMenu, smartVideoDark: shotSmartVideoDark, smartLight: shotSmartLight, readonly: shotReadonly, modal: shotModal },
  };
  fs.writeFileSync(path.join(ART, "entry-probe.json"), JSON.stringify(result, null, 2) + "\n");
  const lines = [];
  lines.push("# DXOS-CANVAS-REVENDOR-NEXT · 重新 vendor 后的入口 / 真源 / 只读 / 模态（真机证据）", "");
  lines.push("CDP " + CDP_PORT + " · providerId=" + providerId + " · canvasId=" + id1, "");
  lines.push("| 结果 | 检查 | 说明 |");
  lines.push("| --- | --- | --- |");
  for (const c of checks) lines.push("| " + (c.status === "PASS" ? "PASS" : "FAIL") + " | " + c.name + " | " + c.actual.replace(/\|/g, "\\|").slice(0, 400) + " |");
  lines.push("", "PASS " + passed + " / FAIL " + failed, "");
  lines.push("## 截图", "");
  for (const [k, v] of Object.entries(result.shots)) lines.push("- " + k + ": " + v);
  fs.writeFileSync(path.join(ART, "ENTRY-RESULT.md"), lines.join("\n") + "\n");
  console.log("\n==== 截图 ====");
  for (const [k, v] of Object.entries(result.shots)) console.log("  " + k + ": " + v);
  console.log("\nPASS " + passed + " / FAIL " + failed);

  try { await browser.close(); } catch { /* ignore */ }
  browser = null;
  if (child && !child.killed) { child.kill("SIGTERM"); await sleep(1200); try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (provider) await provider.close().catch(() => {});
  if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
  const profileAfter = snapshotProfile(realProfile);
  fs.writeFileSync(path.join(ART, "profile-entry-before.json"), JSON.stringify(profileBefore, null, 2) + "\n");
  fs.writeFileSync(path.join(ART, "profile-entry-after.json"), JSON.stringify(profileAfter, null, 2) + "\n");
  const changed = [];
  for (const name of ["identity.db", "identity.db-wal", "identity.db-shm"]) if (JSON.stringify(profileBefore.identity[name]) !== JSON.stringify(profileAfter.identity[name])) changed.push("identity:" + name);
  for (const name of new Set([...Object.keys(profileBefore.topLevel || {}), ...Object.keys(profileAfter.topLevel || {})])) if (JSON.stringify(profileBefore.topLevel[name]) !== JSON.stringify(profileAfter.topLevel[name])) changed.push("top:" + name);
  check("f · 真实 profile 收工前后未变（只读快照）", changed.length === 0, "完全一致", changed.slice(0, 20));
  result.profileUnchanged = changed.length === 0;
  result.profileChanged = changed;
  fs.writeFileSync(path.join(ART, "entry-probe.json"), JSON.stringify(result, null, 2) + "\n");
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error("探针异常：", err && err.stack || err); if (stderrBuf) console.error("electron stderr 尾部：\n" + stderrBuf.slice(-2500)); process.exitCode = 1; });
