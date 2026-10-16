/**
 * DXOS-CANVAS-REVENDOR · 真机验证：升级到上游 1e20abe51 后「无限画布」仍然跑得起来。
 *
 * 真实 Electron（`electron .`，隔离 --user-data-dir + 唯一 CDP 端口）→ 打开 appId=canvas：
 *   a. 列表页渲染（标题/开始创作/继续上次/新建画布/卡片）
 *   b. 新建画布 → 编辑器渲染
 *   c. 一次真实模型调用（OpenArc 模型服务 → 本地确定性 provider，沿用 canvas 既有 runNode 路径）
 *   S1–S4 适配语义回归（供应商/模型单一真源、只读闸、撤销/重做配对、端点白名单/出网拒绝）
 *   b2. 返回列表
 *   d. 0 console error / 0 pageerror / 0 条 404（asset not found）/ 0 条 5xx
 *   e. 截图：列表页 + 编辑器（2880×1800 @2x，浅/深）
 * 收工：真实 profile（~/Library/Application Support/openarc-os）mtime+size+sha256 快照前后比对；
 *      杀子进程、删隔离 userData。
 *
 * 用法：node experiments/dxos-canvas-revendor/real-device-canvas.mjs
 * 中间产物：artifacts/dxos-canvas-revendor/{RESULT.json,shots/*.png}
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { startCanvasProvider, CANVAS_TEXT_PREFIX } from "../../tests/fixtures/d5-02-canvas-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-revendor");
const SHOTS = path.join(ART, "shots");
const CDP_PORT = Number(process.env.OA_REVENDOR_CDP_PORT || 9843);
const ADMIN = { id: "admin@dxos-revendor.test", pw: "revendor-admin-1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 真实 profile 只读快照（绝不打开 SQLite） ───────────────────────────── */
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
function diffProfile(before, after) {
  const changed = [];
  for (const name of ["identity.db", "identity.db-wal", "identity.db-shm"]) {
    const a = before.identity[name] || {}, b = after.identity[name] || {};
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push("identity:" + name);
  }
  for (const name of new Set([...Object.keys(before.topLevel || {}), ...Object.keys(after.topLevel || {})])) {
    const a = (before.topLevel || {})[name], b = (after.topLevel || {})[name];
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push("top:" + name + " " + JSON.stringify(a) + "→" + JSON.stringify(b));
  }
  return changed;
}

/* ── 结果与断言 ─────────────────────────────────────────────────────────── */
const checks = [];
const record = (name, ok, expected, actual) => {
  checks.push({ name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: typeof actual === "string" ? actual : JSON.stringify(actual) });
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + name + (ok ? "" : " — 期望 " + expected + "，实际 " + JSON.stringify(actual)));
  return ok;
};
let passed = 0, failed = 0;
const recordWrap = (...a) => { if (record(...a)) passed += 1; else failed += 1; };

/* ── 浏览器侧小工具（与 experiments/d5-02/canvas-e2e.mjs 同口径） ───────── */
let child = null, browser = null, page = null, provider = null, userDataDir = null, cdp = null, stderrBuf = "";
const consoleErrors = [], pageErrors = [], netFailures = [], requestUrls = new Map();
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const model = (payload) => js("return await window.openarc.model.command(" + JSON.stringify(payload) + ")");
const canvas = (payload) => js("return await window.openarc.canvas.command(" + JSON.stringify(payload) + ")");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const canvasFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas\.html/);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 240) }; }
}

async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-revendor-"));
  // 本仓库环境的 ELECTRON_RUN_AS_NODE 会把 Electron 当普通 Node 跑（app 未定义、CDP 不启动），必须摘掉。
  const childEnv = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + CDP_PORT, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪（exit=" + child.exitCode + "）。electron stderr 尾部：\n" + stderrBuf.slice(-1500));
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  // 当前工作树 main.cjs 默认加载 Vue 壳 dist/vue.html（OA_UI=react 才回 index.html），两种都接受。
  const end = Date.now() + 40000;
  const isUI = (p) => /[\\/]dist[\\/](vue|index)\.html/.test(p.url());
  while (!page && Date.now() < end) { page = ctx.pages().find(isUI) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面，当前 pages=" + JSON.stringify(ctx.pages().map((p) => p.url())) + "，electron stderr 尾部：\n" + stderrBuf.slice(-800));
  page.on("dialog", (d) => { void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push({ url: String((m.location() || {}).url || "").slice(0, 120), text: m.text().slice(0, 300) }); });
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
  cdp = await page.context().newCDPSession(page);
  // 验收要求 2880×1800 @2x：视口 1440×900 + deviceScaleFactor 2（截图按 2x 输出）。
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }).catch(() => {});
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => requestUrls.set(e.requestId, e.request.url));
  cdp.on("Network.responseReceived", (e) => { if (e.response.status >= 400) netFailures.push({ kind: "response", status: e.response.status, url: e.response.url }); });
  cdp.on("Network.loadingFailed", (e) => { netFailures.push({ kind: "loadingFailed", status: 0, errorText: e.errorText, url: requestUrls.get(e.requestId) || "" }); });
}

async function openAppWindow() {
  await js("const el = document.querySelector('[data-dock-id=\"canvas\"]') || document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]'); if (el) el.click(); return !!el;");
  return await waitFor(() => has("[data-canvas-host]"), 20000);
}
async function login() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const next = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "DXOS Prune Admin"); await next();
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
async function shot(name) { fs.mkdirSync(SHOTS, { recursive: true }); const p = path.join(SHOTS, name + ".png"); await page.screenshot({ path: p }).catch(() => {}); return path.relative(ROOT, p); }
async function darken(frame) {
  return inFrame(frame, "const add = (el) => { if (el) { el.classList.add('theme-dark'); el.classList.add('studio-theme-dark'); } }; add(document.documentElement); add(document.body); return true;");
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const realProfile = realProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  console.log("[profile] 打开前快照：" + realProfile + " exists=" + profileBefore.exists);

  provider = await startCanvasProvider();
  await launch();
  await login();
  recordWrap("a0 · 真实 electron . 启动 + 登录（隔离 userData + 唯一 CDP 端口 " + CDP_PORT + "）", (await gate()) === "ready", "ready", await gate());

  /* a. 列表页渲染 */
  const opened = await openAppWindow();
  const listUp = await waitFor(() => !!listFrame(), 25000);
  await sleep(1200);
  const listInfo = await inFrame(listFrame(), "return { title: document.title, start: !!document.getElementById('btnStartCreate'), cont: !!document.getElementById('btnContinueLast'), newProject: !!document.getElementById('btnNewProject'), grid: !!document.getElementById('cardsGrid'), cards: document.querySelectorAll('#cardsGrid .project-card').length, iframes: document.querySelectorAll('iframe').length };");
  const shotListLight = await shot("list-light");
  recordWrap("a · 画布列表页渲染（标题=画布工作台 + 开始创作/继续上次/新建画布 + 卡片网格；无子 iframe）",
    opened && listUp && listInfo.title === "画布工作台" && listInfo.start === true && listInfo.cont === true && listInfo.newProject === true && listInfo.grid === true && listInfo.iframes === 0,
    "画布工作台 + 4 入口 + cardsGrid", listInfo);

  /* b. 新建画布 → 编辑器 → 返回列表 */
  const before = ((await canvas({ type: "canvas/list" })).items || []).length;
  const newClick = await inFrame(listFrame(), "const el = document.getElementById('btnNewProject'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const editorUp = await waitFor(() => !!canvasFrame(), 40000);
  const adapterUp = await waitFor(async () => (await inFrame(canvasFrame(), "return { i: typeof window.__openarcCanvasInternals, a: typeof window.__openarcCanvas, b: typeof window.__openarcBridge, ro: window.__openarcBridge.isReadOnly() };")).i === "object", 30000);
  await waitFor(async () => { const st = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };"); return !!(st && st.id); }, 30000);
  const state0 = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, ro: window.__openarcBridge.isReadOnly() };");
  const after = ((await canvas({ type: "canvas/list" })).items || []).length;
  const canvasId = state0.id || null;
  recordWrap("b1 · 「新建画布」→ 直接进入编辑器（canvas.html + 适配器就绪 + 非只读 + 真新建 1 本）",
    newClick === "clicked" && editorUp && adapterUp && !!canvasId && state0.ro === false && after === before + 1,
    "编辑器帧 + 非只读 + +1 本", { newClick, editorUp, adapterUp, state0, before, after });

  /* c. 一次真实模型调用（OpenArc 模型服务 → 本地 provider） */
  const prov = await model({ type: "provider/create", displayName: "DXOS Prune Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "dxos-prune-secret" });
  const providerId = prov && prov.provider && prov.provider.providerId;
  const cm = await model({ type: "model/create", providerId, remoteModelId: "dxos-prune-chat", displayName: "DXOS Prune Chat", capabilities: ["chat"], scope: "ORGANIZATION" });
  const configId = cm && cm.model && cm.model.configId;
  await model({ type: "defaults/set", capability: "chat", configId });
  // 等 /api/config 真的把新模型投影进 chat_models（CanvasHost 按 canvas/models 的 enabled 集合投影）
  let cfgInfo = null;
  const reflected = await waitFor(async () => {
    cfgInfo = await inFrame(canvasFrame(), "const cfg = await (await fetch('/api/config')).json(); return { chat: cfg.chat_models || [], count: cfg.chat_model_count, providers: (cfg.api_providers || []).map(function (p) { return p.id + ':' + (p.chat_models || []).join('|'); }) };");
    return cfgInfo && Array.isArray(cfgInfo.chat) && cfgInfo.chat.length >= 1;
  }, 25000);
  const addPrompt = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_prompt', type:'prompt', x:80, y:120, text:'写一句关于海边的提示词' } }, null);");
  const addLlm = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_llm', type:'llm', x:420, y:120, model:'', systemPrompt:'You are a helpful assistant.' } }, null);");
  await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_llm' }, null);");
  const runLlm = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_llm'); const cfg = await (await fetch('/api/config')).json(); n.model = cfg.chat_models[0]; it.primitives.render(); window.__openarcCanvas.runNode('n_llm'); return { started: true, model: n.model };");
  const llmDone = (await waitFor(async () => {
    const n = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { status: n.runStatus, error: n.runError || '' };");
    return n && (n.status === "done" || n.status === "failed") ? n : null;
  }, 40000)) ? await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); const last = (n.messages||[]).filter(m=>m.role==='assistant').slice(-1)[0]; return { status: n.runStatus, error: n.runError || '', text: String(n.outputText || (last ? last.content : '') || '') };") : null;
  const pstate = provider.state();
  const shotEditorLight = await shot("editor-light");
  recordWrap("c · 真实模型调用链（文本）：编辑器 runNode → OpenArc 模型服务 → 本地 provider → 结果回节点",
    !!(addPrompt && addPrompt.ok && addLlm && addLlm.ok) && runLlm && runLlm.started === true && !!llmDone && llmDone.status === "done" && String(llmDone.text).startsWith(CANVAS_TEXT_PREFIX) && pstate.chats.length >= 1 && pstate.authSeen >= 1,
    "节点 done + provider 文本 + OpenArc 凭据", { prov: { providerId }, cm: { configId }, reflected, cfgInfo, runLlm, llmDone, chats: pstate.chats.length, authSeen: pstate.authSeen });

  /* ── 适配语义回归（S1–S4）：升级上游后三条不变式 + 白名单/出网拒绝仍生效 ───────── */
  // 补两个能力节点（生图 generator / 视频 video），让守卫的"未接通真实 disable"有对象可验。
  await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_gen', type:'generator', x:80, y:420 } }, null);");
  await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_vid', type:'video', x:520, y:420, model:'' } }, null);");
  await sleep(1000);
  const sem = await inFrame(canvasFrame(), `
    const out = {};
    const it = window.__openarcCanvasInternals;
    const g = window.__openarcCanvasGuard;
    const b = window.__openarcBridge;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const facts = JSON.parse(JSON.stringify((g && g.facts) || {}));
    out.facts = {
      providers: (facts.providers || []).map((p) => p.id),
      providerIds: facts.providerIds || [],
      chat: facts.chat || [], image: facts.image || [], video: facts.video || [],
      capabilities: facts.capabilities || {},
      modelSourceKeys: g ? g.modelSourceKeys : null,
    };
    /* S1 · 供应商 / 模型单一真源 */
    const keyName = 'canvas_image_models_ordered';
    const readBefore = localStorage.getItem(keyName);
    localStorage.setItem(keyName, JSON.stringify(['OPENARC-OFFLIST-MODEL']));
    const readAfter = localStorage.getItem(keyName);
    if (g && g.scan) g.scan();
    await sleep(500);
    const offlistHit = [];
    document.querySelectorAll('select').forEach((s) => { Array.prototype.forEach.call(s.options, (o) => { if (o.value === 'OPENARC-OFFLIST-MODEL') offlistHit.push(String(s.className)); }); });
    const badProv = [];
    document.querySelectorAll('.llm-provider-select, .video-provider, .generator-body .provider-select').forEach((s) => { Array.prototype.forEach.call(s.options, (o) => { if (o.value && (facts.providerIds || []).indexOf(o.value) < 0) badProv.push({ sel: String(s.className), value: o.value }); }); });
    const vp = document.querySelector('.video-provider');
    const vm = document.querySelector('.video-model');
    const vNode = vp ? vp.closest('.node') : null;
    const noteEl = vNode ? vNode.querySelector('[data-openarc-guard-note], .openarc-guard-note') : null;
    const genSel = document.querySelector('.generator-body .provider-select');
    out.s1 = {
      keyLocked: readBefore === null && readAfter === null,
      offlistHit: offlistHit, badProv: badProv,
      videoAvailable: !!(facts.capabilities['video-generation'] && facts.capabilities['video-generation'].available),
      videoReason: (facts.capabilities['video-generation'] || {}).reason || null,
      videoDisabled: !!(vp && vp.disabled) && !!(vm && vm.disabled),
      videoNodeAvailable: vNode ? vNode.getAttribute('data-openarc-available') : null,
      videoNote: noteEl ? String(noteEl.textContent).slice(0, 160) : null,
      imageSelectDisabled: !!(genSel && genSel.disabled),
      imageSelectState: genSel ? (genSel.getAttribute('data-openarc-unavailable') || genSel.getAttribute('data-openarc-unconfigured') || '') : null,
    };
    /* S2 · 只读闸 */
    const n0 = it.getState().nodes.length;
    window.postMessage({ ch: 'openarc.canvas', dir: 'host->canvas', kind: 'context', readOnly: true, canEdit: false, reducedMotion: false }, '*');
    await sleep(300);
    const roOn = b.isReadOnly();
    const roCmd = await window.__openarcCanvas.applyCommand({ type: 'node.add', node: { id: 'n_ro', type: 'prompt', x: 10, y: 10, text: 'ro' } }, null);
    const n1 = it.getState().nodes.length;
    const roPrim = it.primitives.addNode({ id: 'n_ro2', type: 'prompt', x: 10, y: 10, text: 'ro' });
    const n2 = it.getState().nodes.length;
    window.postMessage({ ch: 'openarc.canvas', dir: 'host->canvas', kind: 'context', readOnly: false, canEdit: true, reducedMotion: false }, '*');
    await sleep(300);
    out.s2 = { roOn: roOn, roCmd: roCmd, n0: n0, n1: n1, n2: n2, primBlocked: roPrim === null, restored: b.isReadOnly() === false };
    /* S3 · 撤销 / 重做配对（走产品同一条命令入口：applyCommand 先 pushUndo，再由 undo/redo 配对；
       上游 addNode 本身不压栈 —— 压栈由交互层/命令层负责，所以必须用命令入口才代表真实路径） */
    const base = it.getState().nodes.length;
    const utAdd = await window.__openarcCanvas.applyCommand({ type: 'node.add', node: { id: 'n_ut', type: 'prompt', x: 40, y: 560, text: 'undo-redo' } }, null);
    const afterAdd = it.getState().nodes.length;
    const canUndo1 = it.primitives.canUndo();
    window.__openarcCanvas.undo();
    const afterUndo = it.getState().nodes.length;
    const canRedo1 = it.primitives.canRedo();
    window.__openarcCanvas.redo();
    const afterRedo = it.getState().nodes.length;
    const canRedo2 = it.primitives.canRedo();
    window.__openarcCanvas.undo();
    out.s3 = { utAdd: utAdd, base: base, afterAdd: afterAdd, afterUndo: afterUndo, afterRedo: afterRedo, canUndo1: canUndo1, canRedo1: canRedo1, canRedo2: canRedo2, cleaned: it.getState().nodes.length === base };
    /* S4 · 端点白名单 / 出网拒绝 */
    const probe = async (url, init) => { try { const r = await fetch(url, init || {}); let j = null; try { j = await r.json(); } catch (e) { j = null; } return { status: r.status, error: (j && j.error) || null }; } catch (e) { return { thrown: String((e && e.message) || e) }; } };
    out.s4 = {
      egress: await probe('https://example.com/steal'),
      unrouted: await probe('/api/midjourney/submit', { method: 'POST', body: '{}' }),
      update: await probe('/api/check-update'),
      allowed: await probe('/api/config'),
    };
    return out;
  `);

  const s1 = sem && sem.s1 || {}, s2 = sem && sem.s2 || {}, s3 = sem && sem.s3 || {}, s4 = sem && sem.s4 || {};
  recordWrap("S1 · 供应商/模型单一真源（清单外值进不来 + 未接通能力真实 disable）",
    s1.keyLocked === true && (s1.offlistHit || []).length === 0 && (s1.badProv || []).length === 0 &&
    s1.videoAvailable === false && s1.videoDisabled === true && s1.videoNodeAvailable === "false" && !!s1.videoNote &&
    s1.imageSelectDisabled === true,
    "锁键 + 0 清单外 + 视频/生图下拉 disable + 说明", s1);
  recordWrap("S2 · 只读闸（只读画布上不能编辑）",
    s2.roOn === true && !!s2.roCmd && s2.roCmd.ok === false && s2.roCmd.error === "READ_ONLY" &&
    s2.n1 === s2.n0 && s2.n2 === s2.n0 && s2.primBlocked === true && s2.restored === true,
    "READ_ONLY + 节点数不变 + 恢复可编辑", s2);
  recordWrap("S3 · 撤销/重做配对（redo 与 undo 成对、新编辑清空 redo）",
    s3.afterAdd === s3.base + 1 && s3.afterUndo === s3.base && s3.afterRedo === s3.base + 1 &&
    s3.canUndo1 === true && s3.canRedo1 === true && s3.canRedo2 === false && s3.cleaned === true,
    "add +1 → undo 还原 → redo +1", s3);
  recordWrap("S4 · 端点白名单 / 出网拒绝仍生效",
    s4.egress && s4.egress.status === 501 && s4.egress.error === "OPENARC_EGRESS_BLOCKED" &&
    s4.unrouted && s4.unrouted.status === 501 && s4.unrouted.error === "OPENARC_UNSUPPORTED" &&
    s4.update && s4.update.status === 501 && s4.update.error === "OPENARC_UPDATE_DISABLED" &&
    s4.allowed && s4.allowed.status === 200,
    "出网 501 + 未登记端点 501 + 更新 501 + /api/config 200", s4);

  /* e. 深色截图（尽力：给当前画布帧加 theme-dark 类） */
  let shotEditorDark = null, shotListDark = null;
  try { await darken(canvasFrame()); await sleep(400); shotEditorDark = await shot("editor-dark"); } catch { /* ignore */ }

  /* b2. 返回列表 */
  const backClick = await inFrame(canvasFrame(), "const el = document.getElementById('backToManagerBtn'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const backToList = await waitFor(() => !!listFrame() && !canvasFrame(), 30000);
  const backInfo = await inFrame(listFrame(), "return { title: document.title, grid: !!document.getElementById('cardsGrid'), cards: document.querySelectorAll('#cardsGrid .project-card').length };");
  recordWrap("b2 · 编辑器返回列表（同一宿主帧内导航，画布帧消失，列表含刚建的卡片）",
    backClick === "clicked" && backToList && backInfo.title === "画布工作台" && backInfo.grid === true && backInfo.cards >= 1,
    "回列表 + 卡片存在", { backClick, backToList, backInfo });

  try { await darken(listFrame()); await sleep(400); shotListDark = await shot("list-dark"); } catch { /* ignore */ }

  await sleep(1500); // 收集收尾网络事件

  /* d. 0 console error / 0 pageerror / 0 404 */
  const notFound = netFailures.filter((f) => f.status === 404);
  const failedOther = netFailures.filter((f) => f.status === 0 && !/ERR_ABORTED/.test(String(f.errorText)));
  const serverErrors = netFailures.filter((f) => f.status >= 500);
  recordWrap("d1 · 0 条 404（asset not found）", notFound.length === 0, "0 个 404", notFound.slice(0, 12));
  recordWrap("d2 · 0 console error", consoleErrors.length === 0, "0 条 console error", consoleErrors.slice(0, 12));
  recordWrap("d3 · 0 pageerror", pageErrors.length === 0, "0 条 pageerror", pageErrors.slice(0, 12));
  recordWrap("d4 · 0 条 5xx（含桥 501/502，产品流不触发未接通端点）", serverErrors.length === 0, "0 个 5xx", serverErrors.slice(0, 12));

  const result = {
    ok: failed === 0,
    cdpPort: CDP_PORT,
    entry: "static/canvas-list.html",
    canvasId,
    semantics: sem,
    checks,
    count404: notFound.length,
    notFound,
    serverErrors,
    loadingFailures: failedOther,
    consoleErrors,
    pageErrors,
    shots: { listLight: shotListLight, editorLight: shotEditorLight, listDark: shotListDark, editorDark: shotEditorDark },
    provider: { chats: pstate.chats.length, authSeen: pstate.authSeen },
  };
  fs.writeFileSync(path.join(ART, "RESULT.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("\n==== 截图 ====");
  for (const [k, v] of Object.entries(result.shots)) if (v) console.log("  " + k + ": " + v);

  /* 收工：杀子进程 + 删隔离 userData + profile 比对 */
  try { await browser.close(); } catch { /* ignore */ }
  browser = null;
  if (child && !child.killed) { child.kill("SIGTERM"); await sleep(1200); try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (provider) await provider.close().catch(() => {});
  if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
  const profileAfter = snapshotProfile(realProfile);
  const changed = diffProfile(profileBefore, profileAfter);
  fs.writeFileSync(path.join(ART, "profile-before.json"), JSON.stringify(profileBefore, null, 2) + "\n");
  fs.writeFileSync(path.join(ART, "profile-after.json"), JSON.stringify(profileAfter, null, 2) + "\n");
  recordWrap("f · 真实 profile 收工前后未变（mtime+size+sha256）", changed.length === 0, "identity.db/-wal/-shm 与顶层快照完全一致", changed.slice(0, 20));
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
