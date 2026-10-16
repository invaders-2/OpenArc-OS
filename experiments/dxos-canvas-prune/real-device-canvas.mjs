/**
 * DXOS-CANVAS-PRUNE · 真机验证：裁剪后「无限画布」仍然跑得起来。
 *
 * 真实 Electron（`electron .`，隔离 --user-data-dir + 唯一 CDP 端口）→ 打开 appId=canvas：
 *   a. 列表页渲染（标题/开始创作/继续上次/新建画布/卡片）
 *   b. 新建画布 → 编辑器渲染 → 返回列表
 *   c. 一次真实模型调用（OpenArc 模型服务 → 本地确定性 provider，沿用 canvas 既有 runNode 路径）
 *   d. 0 console error / 0 pageerror / 0 条 404（asset not found）
 *   e. 截图：列表页 + 编辑器（浅色；深色尽力）
 * 收工：真实 profile（~/Library/Application Support/openarc-os）mtime+size+sha256 快照前后比对；
 *      杀子进程、删隔离 userData。
 *
 * 用法：node experiments/dxos-canvas-prune/real-device-canvas.mjs
 * 中间产物：artifacts/dxos-canvas-prune/{RESULT.json,shots/*.png}
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
const ART = path.join(ROOT, "artifacts", "dxos-canvas-prune");
const SHOTS = path.join(ART, "shots");
const CDP_PORT = Number(process.env.OA_PRUNE_CDP_PORT || 9821);
const ADMIN = { id: "admin@dxos-prune.test", pw: "prune-admin-1" };
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-prune-"));
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

  const result = {
    ok: failed === 0,
    cdpPort: CDP_PORT,
    entry: "static/canvas-list.html",
    canvasId,
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
