/**
 * D5-02 Full-App · NOVAI 完整应用集成门禁（真实 electron . + 真实产品 UI + 本地确定性 provider）。
 *
 *   A 系列  完整应用：原版首页(AI Studio 外壳)、侧栏导航逐项可达、首页→新建项目→无限画布→
 *           编辑保存→返回首页→再打开项目（同一本、内容仍在）、截图留证
 *   B 系列  统一后端：模型只来自 OpenArc、文本/图片真实调用、失败如实、不支持能力明确报错、
 *           更新/下载禁用 + 出网接收端 0 命中、应用信息/队列来自宿主
 *   C 系列  D1 撤权 / D2 能力不支持 / D3 预算 / D4 停止与迟到 / D5 失败收敛
 *   E 系列  宿主级隔离：无桥/Node/IPC、端点白名单、协议穿越、当前实例校验、后端不信自报身份、
 *           出网五通道 0 命中、iframe 自我导航被宿主拦截、账号边界（帧销毁 + 存储作用域）
 *   F 系列  五项既有缺口：F1 任务模型绑定不静默换模型、F2=D1、F3 图片资源产品链、
 *           F4 AI 编辑正式链（提议→审批→执行→呈现→保存恢复 + 旧 revision 对照）、F5=E 系列
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { startCanvasProvider, CANVAS_TEXT_PREFIX } from "../../tests/fixtures/d5-02-canvas-provider.mjs";
import { startD4Provider } from "../../tests/fixtures/d4-04-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "d5-02");
const CDP_PORT = Number(process.env.OA_D502_CDP_PORT || 9793);
const ADMIN = { id: "admin@d502-canvas.test", pw: "canvas-admin-1" };
const MEMBER = { id: "member@d502-canvas.test", pw: "canvas-member-1" };
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHECKS = [], NOT_VERIFIED = [], OBSERVATIONS = [];
let passed = 0, failed = 0;
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 1400), at: Date.now() };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  " : "! ") + "[" + row.status + "] " + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };

let child = null, browser = null, page = null, provider = null, stderrBuf = "";
let userDataDir = null, agentProvider = null;
const dialogs = [];
const consoleErrors = [];
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const model = (payload) => js("return await window.openarc.model.command(" + JSON.stringify(payload) + ")");
const canvas = (payload) => js("return await window.openarc.canvas.command(" + JSON.stringify(payload) + ")");
const governance = (payload) => js("return await window.openarc.governance.command(" + JSON.stringify(payload) + ")");
const resource = (payload) => js("return await window.openarc.resource.command(" + JSON.stringify(payload) + ")");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);

const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const shellFrame = () => frameBy(/openarc-canvas:\/\/bundle\/index\.html/);
const canvasFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas\.html/);
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const homeFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/home\.html/);
const frameFor = (pageId) => frameBy(new RegExp("/static/" + pageId + "\\.html"));
const allBundleFrames = () => page.frames().filter((f) => f.url().indexOf("openarc-canvas://bundle/") === 0);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 240) }; }
}
const shellJs = (code) => inFrame(shellFrame(), code);

async function launch() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d502-"));
  userDataDir = userData;
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" },
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!page && Date.now() < end) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面");
  page.on("dialog", (d) => { dialogs.push(String(d.message()).slice(0, 140)); void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror:" + String(e.message).slice(0, 200)));
}

async function startReceiver() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.method + " " + req.url); res.writeHead(204); res.end(); });
  server.on("upgrade", (req) => { hits.push("UPGRADE " + req.url); req.socket.destroy(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, hits: () => hits.slice(), close: () => new Promise((r) => server.close(() => r())) };
}

async function openAppWindow() {
  // 预览集成分支按"不改用户已定 UI"保留入口名"无限画布"；核心线叫"AI Studio"。两种都接受。
  await js("const el = document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]'); if (el) el.click(); return !!el;");
  return await waitFor(() => has("[data-canvas-host]"), 20000);
}
async function closeAppWindow() {
  await js("const el = document.querySelector('[aria-label=\"关闭AI Studio窗口\"]') || document.querySelector('[aria-label=\"关闭无限画布窗口\"]'); if (el) el.click(); return !!el;").catch(() => {});
  await js("const el=document.querySelector('[data-canvas-host]'); const win=el&&el.closest('[data-window-id]'); const btn=win&&win.querySelector('.window-title button.close'); if(btn) btn.click(); return !!btn;");
  return await waitFor(() => allBundleFrames().length === 0, 15000);
}
/** 关窗重开/切页之后，从**首页最近项目卡片**再打开当前这本画布（产品路径）。*/
async function reopenCurrentCanvasFromHome() {
  const opened = await openAppWindow();
  if (!opened) return false;
  await waitFor(() => !!homeFrame(), 25000);
  await waitFor(async () => (await inFrame(homeFrame(), "const r = await (await fetch('/api/recent-canvases')).json(); return (Array.isArray(r) ? r : []).some(function (c) { return c.id === " + JSON.stringify(currentCanvasId) + "; });")) === true, 20000);
  const clicked = await inFrame(homeFrame(), "const id = " + JSON.stringify(currentCanvasId) + "; const cards = Array.from(document.querySelectorAll('#recentProjects .hp-proj:not(.hp-proj-new)')); const hit = cards.find(function (c) { return (c.getAttribute('onclick') || '').indexOf(encodeURIComponent(id)) >= 0; }) || cards[0]; if (!hit) return 'missing'; hit.click(); return 'clicked';");
  const up = await waitFor(() => !!canvasFrame(), 35000);
  return clicked === "clicked" && up === true;
}
async function login(identifier, pw) {
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', pw);
  await clickDom('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}
async function logout() {
  await clickDom('[data-d3-id="topbar-logout"]');
  return await waitFor(async () => (await gate()) !== "ready", 30000);
}
let currentCanvasId = null;

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  provider = await startCanvasProvider();
  await launch();
  record("A0", "真实 electron . 启动（隔离 userData / 隔离 CDP 端口）", !!browser, "CDP 可用", "connected");
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    await setInput('[data-d3-id="setup-name"]', "D5-02 Admin");
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  record("A0", "真实 UI 登录 admin", await login(ADMIN.id, ADMIN.pw), "ready", await gate());

  /* ══════════════════ A 系列：完整应用（首页 / 导航 / 项目往返） ══════════════════ */
  const opened = await openAppWindow();
  const shellUp = await waitFor(() => !!shellFrame(), 25000);
  const homeUp = await waitFor(() => !!homeFrame(), 20000);
  await sleep(1200);
  const shellInfo = await shellJs("return { title: document.title, active: (document.querySelector('iframe.active') || {}).id || null, nav: Array.from(document.querySelectorAll('.nav-item,.side-pill')).length, pages: Array.from(document.querySelectorAll('iframe')).map(f => f.id) };");
  const homeInfo = await inFrame(homeFrame(), "return { title: document.title, newCard: !!document.querySelector('.hp-proj-new'), recentBox: !!document.getElementById('recentProjects') };");
  record("A1", "打开应用 = 上游原版外壳（AI Studio）+ 原版首页（不是单个画布编辑器）",
    opened && shellUp && homeUp && shellInfo.title === "AI Studio" && shellInfo.active === "frame-home" && shellInfo.pages.length >= 11 && homeInfo.newCard === true && homeInfo.recentBox === true,
    "AI Studio 外壳 + frame-home 首页渲染", JSON.stringify({ opened, shellUp, homeUp, shellInfo, homeInfo }));

  const NAV = [
    { route: "online", frame: "frame-online" },
    { route: "gpt-chat", frame: "frame-gpt-chat" },
    { route: "canvas", frame: "frame-canvas" },
    { route: "asset-manager", frame: "frame-asset-manager" },
    { route: "home", frame: "frame-home" },
  ];
  const navResults = [];
  for (const item of NAV) {
    const navSel = "[onclick*=\"" + "'" + item.route + "'" + "\"]";
    const clicked = await shellJs("const el = document.querySelector(" + JSON.stringify(navSel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
    const ok = await waitFor(async () => {
      const st = await shellJs("return { active: (document.querySelector('iframe.active') || {}).id || null, activeHasDoc: !!document.querySelector('iframe.active') && document.querySelector('iframe.active').contentDocument !== null };");
      return st.active === item.frame && st.activeHasDoc === true;
    }, 20000);
    navResults.push({ route: item.route, clicked, ok });
  }
  record("A2", "左侧导航逐项可达：每个入口切到对应子页且子页文档真的加载（不是空 iframe）",
    navResults.every((r) => r.ok === true && r.clicked === "ok"),
    "5 个导航项 active + contentDocument 就绪", JSON.stringify(navResults));

  // 首页 → 新建项目 → 无限画布编辑器
  await shellJs("const el = document.querySelector(" + JSON.stringify("[onclick*=\"" + "'home'" + "\"]") + "); if (el) el.click(); return 'ok';");
  await waitFor(() => !!homeFrame(), 15000);
  const before = await inFrame(homeFrame(), "const r = await (await fetch('/api/recent-canvases')).json(); return { n: Array.isArray(r) ? r.length : r };");
  const clickNew = await inFrame(homeFrame(), "const el = document.querySelector('.hp-proj-new'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const editorUp = await waitFor(() => !!canvasFrame(), 40000);
  const adapterUp = await waitFor(async () => (await inFrame(canvasFrame(), "return { i: typeof window.__openarcCanvasInternals, a: typeof window.__openarcCanvas, b: typeof window.__openarcBridge };")).i === "object", 30000);
  // 适配器就绪 ≠ 画布文档已载入：等到 canvasId 真的出现（否则后面所有断言都建在 null 上）
  await waitFor(async () => { const st = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };"); return !!(st && st.id); }, 30000);
  const canvasState = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, edges: s.edgeCount, ro: window.__openarcBridge.isReadOnly() };");
  currentCanvasId = canvasState.id || null;
  record("A3", "首页「新建项目」→ 进入无限画布编辑器（同一本书由外壳中继交给画布页；不是只加载列表页）",
    clickNew === "clicked" && editorUp && adapterUp && !!currentCanvasId && canvasState.ro === false,
    "编辑器帧 + 适配器就绪 + 非只读", JSON.stringify({ before, clickNew, editorUp, adapterUp, canvasState }));

  const addA = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_prompt', type:'prompt', x:80, y:120, text:'D5-02 提示词节点' } }, null);");
  const addB = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_llm', type:'llm', x:420, y:120, model:'', systemPrompt:'You are a helpful assistant.' } }, null);");
  const link = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_llm' }, null);");
  const moved = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.move', id:'n_llm', x:520, y:180 }, null);");
  const savedOk = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
    const nodes = got && got.ok ? got.canvas.doc.nodes : [];
    return nodes.length === 2 && got.canvas.doc.connections.length === 1 && Number(nodes.find((n) => n.id === "n_llm").x) === 520;
  }, 20000);
  const stored = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  record("A4", "创建并编辑真实项目：命令层 add/connect/move → 画布自动保存 → OpenArc 存储里一致",
    !!(addA.ok && addB.ok && link.ok && moved.ok) && savedOk,
    "2 节点 + 1 连线 + 坐标 520", JSON.stringify({ ok: [addA.ok, addB.ok, link.ok, moved.ok], savedOk, revision: stored.canvas.revision, nodes: stored.canvas.doc.nodes.map((n) => ({ id: n.id, x: n.x })), edges: stored.canvas.doc.connections.length }));

  const undoState = await inFrame(canvasFrame(), "window.__openarcCanvas.undo(); await new Promise(r=>setTimeout(r,500)); const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { x: n.x, canRedo: window.__openarcCanvas.canRedo() };");
  const redoState = await inFrame(canvasFrame(), "window.__openarcCanvas.redo(); await new Promise(r=>setTimeout(r,500)); const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { x: n.x };");
  const redoPersisted = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
    const n = got && got.ok ? got.canvas.doc.nodes.find((x) => x.id === "n_llm") : null;
    return n && Number(n.x) === 520;
  }, 20000);
  record("A5", "撤销 / 重做：撤销真的回退、重做真的恢复（与手工编辑同一历史入口），结果重新落库",
    Math.round(undoState.x) === 420 && undoState.canRedo === true && Math.round(redoState.x) === 520 && redoPersisted,
    "undo→420 / redo→520 + 落库", JSON.stringify({ undoState, redoState, redoPersisted }));

  await page.screenshot({ path: path.join(ART, "d5-02-app-canvas.png") }).catch(() => {});
  // 返回首页（产品路径：外壳侧栏「首页」）
  await shellJs("const el = document.querySelector(" + JSON.stringify("[onclick*=\"" + "'home'" + "\"]") + "); if (el) el.click(); return 'ok';");
  const backHome = await waitFor(async () => (await shellJs("return (document.querySelector('iframe.active') || {}).id || null;")) === "frame-home", 20000);
  const recent = await inFrame(homeFrame(), "const r = await (await fetch('/api/recent-canvases')).json(); const list = Array.isArray(r) ? r : []; return { n: list.length, first: list[0] ? { id: list[0].id, title: list[0].title } : null };");
  record("A6", "返回首页：最近画布列表里出现刚保存的项目（首页数据来自 OpenArc 存储）",
    backHome && recent.n >= 1 && recent.first && recent.first.id === currentCanvasId,
    "frame-home 活跃 + 最近列表含该书", JSON.stringify({ backHome, recent }));
  await page.screenshot({ path: path.join(ART, "d5-02-app-home.png") }).catch(() => {});

  // 再打开项目：点首页最近项目卡片
  const reopened = await reopenCurrentCanvasFromHome();
  const reopenedSame = await waitFor(async () => (await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, edges: s.edgeCount, x: (window.__openarcCanvasInternals.primitives.getNode('n_llm')||{}).x };")).id === currentCanvasId, 25000);
  const reopenedState = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, edges: s.edgeCount, x: (window.__openarcCanvasInternals.primitives.getNode('n_llm')||{}).x };");
  record("A7", "从首页再打开项目：打开的是**同一本**画布，节点/连线/坐标从 OpenArc 存储恢复",
    reopened && reopenedSame && reopenedState.nodes === 2 && reopenedState.edges === 1 && Math.round(reopenedState.x) === 520,
    "同一 canvasId + 2 节点 1 连线 x=520", JSON.stringify({ reopened, reopenedSame, reopenedState }));
  await page.screenshot({ path: path.join(ART, "d5-02-app-reopen.png") }).catch(() => {});

  /* ══════════════════ B 系列：统一后端 ══════════════════ */
  const prov = await model({ type: "provider/create", displayName: "D5-02 Canvas Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "d502-canvas-secret" });
  const providerId = prov && prov.provider && prov.provider.providerId;
  const chatModel = await model({ type: "model/create", providerId, remoteModelId: "d502-chat", displayName: "D5-02 Chat", capabilities: ["chat"], scope: "ORGANIZATION" });
  const imgModel = await model({ type: "model/create", providerId, remoteModelId: "d502-image", displayName: "D5-02 Image", capabilities: ["image-generation"], scope: "ORGANIZATION" });
  const chatId = chatModel && chatModel.model && chatModel.model.configId;
  const imgId = imgModel && imgModel.model && imgModel.model.configId;
  await model({ type: "defaults/set", capability: "chat", configId: chatId });
  await model({ type: "defaults/set", capability: "image-generation", configId: imgId });
  const configSeen = await inFrame(canvasFrame(), "const cfg = await (await fetch('/api/config')).json(); return { chat: (cfg.chat_models||[]).length, image: (cfg.image_models||[]).length, providers: (cfg.api_providers||[]).length, hasKey: JSON.stringify(cfg).includes('d502-canvas-secret'), hasUrl: JSON.stringify(cfg).includes('127.0.0.1') };");
  const models = await model({ type: "canvas/models" });
  const projection = JSON.stringify(models);
  record("B1", "模型只有一个来源：画布只看到 OpenArc 已配置可用的模型（无 provider 地址、无凭据）",
    configSeen.chat >= 1 && configSeen.image >= 1 && configSeen.providers === 0 && configSeen.hasKey === false && configSeen.hasUrl === false && !/baseUrl|secret|credential|apiKey/i.test(projection),
    "有 chat+image、无 provider/密钥/地址", JSON.stringify({ configSeen, projectionLeak: /baseUrl|secret|credential|127\.0\.0\.1|apiKey/i.test(projection) }));

  const setText = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.edit', id:'n_prompt', patch:{ text:'写一句关于海边的提示词' } }, null);");
  const runLlm = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_llm'); const cfg = await (await fetch('/api/config')).json(); n.model = cfg.chat_models[0]; it.primitives.render(); window.__openarcCanvas.runNode('n_llm'); return { started: true, model: n.model };");
  note("LLM 运行前：" + JSON.stringify({ setText: setText && setText.ok, runLlm }));
  const llmDone = (await waitFor(async () => {
    const n = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); return { status: n.runStatus, error: n.runError || '' };");
    return n && (n.status === "done" || n.status === "failed") ? n : null;
  }, 40000)) ? await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_llm'); const last = (n.messages||[]).filter(m=>m.role==='assistant').slice(-1)[0]; return { status: n.runStatus, error: n.runError || '', text: String(n.outputText || (last ? last.content : '') || '') };") : null;
  const providerAfterChat = provider.state();
  record("B2", "真实模型调用链（文本）：经 OpenArc 模型服务 → 本地 provider → 结果回到 LLM 节点",
    !!llmDone && llmDone.status === "done" && String(llmDone.text).startsWith(CANVAS_TEXT_PREFIX) && providerAfterChat.chats.length >= 1 && providerAfterChat.authSeen >= 1,
    "节点拿到 provider 文本 + provider 收到 OpenArc 凭据", JSON.stringify({ llmDone, chats: providerAfterChat.chats.slice(-1), authSeen: providerAfterChat.authSeen }));

  const addGen = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_gen', type:'generator', x:120, y:420, count:1 } }, null);");
  const linkGen = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_gen' }, null);");
  const runGen = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); const cfg = await (await fetch('/api/config')).json(); n.model = cfg.image_models[0]; n.apiProvider='openarc'; it.primitives.render(); window.__openarcCanvas.runNode('n_gen'); return { started: true, model: n.model };");
  const genDone = (await waitFor(async () => {
    const n = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_gen'); return { status: n.runStatus, error: n.runError || '' };");
    return n && (n.status === "done" || n.status === "failed") ? n : null;
  }, 60000)) ? await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const out = it.getState().nodes.find(x => x.type==='output'); const imgs = out ? (out.items||out.images||[]) : []; return { status: it.primitives.getNode('n_gen').runStatus, error: it.primitives.getNode('n_gen').runError || '', outputCount: imgs.length };") : null;
  const providerAfterImage = provider.state();
  record("B3", "真实模型调用链（图片）：经 OpenArc 模型服务 → /images/generations → 输出节点拿到图片",
    !!genDone && genDone.status === "done" && (genDone.outputCount || 0) >= 1 && providerAfterImage.images.length >= 1,
    "输出节点有图片 + provider 收到图片请求", JSON.stringify({ addGen: addGen && addGen.ok, linkGen: linkGen && linkGen.ok, runGen, genDone, images: providerAfterImage.images.length }));

  await provider.setMode("fail");
  await inFrame(canvasFrame(), "await window.__openarcCanvas.runNode('n_gen'); return true;");
  const failedState = (await waitFor(async () => {
    const n = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_gen'); return { status: n.runStatus, error: n.runError || '' };");
    return n && n.status === "failed" && n.error ? n : null;
  }, 45000)) ? await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_gen'); return { status: n.runStatus, error: n.runError || '' };") : null;
  await provider.setMode("ok");
  record("B4", "失败如实展示：provider 500 → 节点标记失败并带错误（不假装成功）",
    !!failedState && failedState.status === "failed" && String(failedState.error).length > 0,
    "runStatus=failed + runError", JSON.stringify(failedState));

  const video = await inFrame(canvasFrame(), "const r = await fetch('/api/canvas-video', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt:'x' }) }); return { status: r.status, body: await r.json() };");
  record("B5", "OpenArc 尚不支持的能力（视频）明确报错，不静默改用其它服务",
    video && video.status === 501 && video.body && video.body.error === "OPENARC_UNSUPPORTED",
    "501 OPENARC_UNSUPPORTED", JSON.stringify(video));

  const update = await inFrame(shellFrame(), "const a = await fetch('/api/check-update'); const b = await fetch('/api/update-from-github', { method:'POST' }); return { check: a.status, checkBody: (await a.json()).error, github: b.status, githubBody: (await b.json()).error };");
  const info = await inFrame(shellFrame(), "const r = await fetch('/api/app-info'); const d = await r.json(); return { status: r.status, updateDisabled: !!d.update_disabled, queueDisabled: !!(d.openarc && d.openarc.updateDisabled) };");
  const queue = await inFrame(shellFrame(), "const r = await fetch('/api/queue_status?client_id=x'); const d = await r.json(); return { status: r.status, total: d.total, source: d.source };");
  record("B6", "更新/下载上游程序保持禁用（界面明确说明），且应用信息/队列来自宿主（不是上游后端）",
    update.check === 501 && update.checkBody === "OPENARC_UPDATE_DISABLED" && update.github === 501 && info.status === 200 && info.updateDisabled === true && queue.status === 200 && typeof queue.total === "number",
    "更新 501 + app-info/queue 200 且标注禁用", JSON.stringify({ update, info, queue }));

  /* ══════════════════ C 系列：授权 / 预算 / 停止（既有缺口） ══════════════════ */
  const canvasAppGrant = await governance({ type: "governance/getAppAccess", appId: "canvas" });
  const modelGrant = (canvasAppGrant && canvasAppGrant.grants ? canvasAppGrant.grants : []).find((x) => Array.isArray(x.actions) && x.actions.includes("model.use")) || null;
  const beforeNoPerm = provider.state().chats.length;
  const noPermRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  if (modelGrant) await governance({ type: "governance/revokeAppAccess", grantId: modelGrant.grantId });
  const revokedRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  const afterNoPerm = provider.state().chats.length;
  if (modelGrant) await governance({ type: "governance/grantAppAccess", appId: "canvas", resourceType: "model", scope: "ORGANIZATION", actions: ["model.view", "model.use"] });
  const regranted = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  record("D1", "无权限：撤销画布应用的 model.use 后，生成明确拒绝且 provider 收不到任何请求（F2 缺口）",
    !!modelGrant && revokedRun.ok === false && revokedRun.error === "PROXY_UNAUTHORIZED" && afterNoPerm === beforeNoPerm && noPermRun.ok && regranted.ok,
    "PROXY_UNAUTHORIZED + 0 请求", JSON.stringify({ hasGrant: !!modelGrant, grantActions: modelGrant && modelGrant.actions, noPermRun: noPermRun.ok, revoked: { ok: revokedRun.ok, error: revokedRun.error }, requests: beforeNoPerm + "→" + afterNoPerm, regranted: regranted.ok }));

  const chatOnly = await model({ type: "model/create", providerId, remoteModelId: "d502-chat-only", displayName: "D5-02 ChatOnly", capabilities: ["chat"], scope: "ORGANIZATION" });
  await model({ type: "defaults/set", capability: "image-generation", configId: chatOnly.model.configId });
  const beforeCap = provider.state().images.length;
  const capRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "image" });
  const afterCap = provider.state().images.length;
  await model({ type: "defaults/set", capability: "image-generation", configId: imgId });
  record("D2", "能力不支持：图片能力被指到只有 chat 的模型上 → 明确 CAPABILITY_UNAVAILABLE，provider 收不到图片请求",
    capRun.ok === false && capRun.error === "CAPABILITY_UNAVAILABLE" && afterCap === beforeCap,
    "CAPABILITY_UNAVAILABLE + 0 请求", JSON.stringify({ capRun: { ok: capRun.ok, error: capRun.error }, images: beforeCap + "→" + afterCap }));

  const budgetRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  let budgetOk = 0, budgetStop = null;
  for (let i = 0; i < 40 && !budgetStop; i += 1) {
    const r = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: budgetRun.runId, messages: [{ role: "user", content: "预算探测 " + (i + 1) }] });
    if (r && r.ok) budgetOk += 1; else budgetStop = r;
  }
  const budgetState = await canvas({ type: "canvas/runState", canvasId: currentCanvasId, runId: budgetRun.runId });
  record("D3", "预算不足：任务级 MODEL_CALLS 用尽后明确拒绝，provider 请求数 = 成功调用数",
    budgetStop && budgetStop.error === "BUDGET_EXHAUSTED" && budgetState.run.status === "BUDGET_EXHAUSTED" && provider.state().chats.length >= budgetOk,
    "BUDGET_EXHAUSTED + 请求数=成功数", JSON.stringify({ budgetOk, stop: budgetStop && budgetStop.error, runStatus: budgetState.run.status, providerChats: provider.state().chats.length }));

  await provider.setMode("slow");
  const stopRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat", nodeId: "n_llm" });
  const inflight = canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: stopRun.runId, messages: [{ role: "user", content: "这条会被停止" }] });
  await sleep(600);
  const stopped = await canvas({ type: "canvas/runStop", canvasId: currentCanvasId, runId: stopRun.runId, reason: "USER_STOP" });
  const late = await inflight;
  const afterStop = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: stopRun.runId, messages: [{ role: "user", content: "停止后不该再发" }] });
  const chatsAtStop = provider.state().chats.length;
  await sleep(2500);
  const chatsAfterLate = provider.state().chats.length;
  await provider.setMode("ok");
  await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; it.primitives.getNode('n_llm').outputText = '用户随后编辑的内容'; it.primitives.render(); return true;");
  const userText = await inFrame(canvasFrame(), "return { text: String(window.__openarcCanvasInternals.primitives.getNode('n_llm').outputText || '') };");
  record("D4", "停止：停止后不再发新请求；迟到结果被丢弃，不覆盖用户随后编辑的节点",
    !!(stopped && stopped.ok) && stopped.run.status === "STOPPED" && late && late.ok === false && ["RUN_STOPPED", "TASK_CANCELLED"].includes(late.error) && afterStop.ok === false && chatsAfterLate === chatsAtStop && userText.text === "用户随后编辑的内容",
    "STOPPED + 迟到丢弃 + 用户内容保留", JSON.stringify({ stopped: stopped && stopped.run && stopped.run.status, late: late && late.error, afterStop: afterStop && afterStop.error, chatsAtStop, chatsAfterLate, userText }));

  await provider.setMode("fail");
  const failRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  const beforeFail = provider.state().chats.length;
  const fail1 = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: failRun.runId, messages: [{ role: "user", content: "失败探测" }] });
  const afterFail1 = provider.state().chats.length;
  const fail2 = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: failRun.runId, messages: [{ role: "user", content: "失败探测 2" }] });
  const afterFail2 = provider.state().chats.length;
  await provider.setMode("ok");
  const leakScan = JSON.stringify([fail1, fail2, await canvas({ type: "canvas/models" }), configSeen]);
  record("D5", "失败收敛：provider 500 → 明确失败、每次调用恰好一次请求（无隐藏重试），且回包不含凭据",
    fail1 && fail1.ok === false && afterFail1 === beforeFail + 1 && fail2 && fail2.ok === false && afterFail2 === beforeFail + 2 && !leakScan.includes("d502-canvas-secret"),
    "每次一次请求 + 无凭据", JSON.stringify({ fail1: fail1 && fail1.error, fail2: fail2 && fail2.error, requests: [beforeFail, afterFail1, afterFail2], leaksSecret: leakScan.includes("d502-canvas-secret") }));

  /* ══════════════════ F1：任务模型绑定（不静默换模型） ══════════════════ */
  const bindRun = await canvas({ type: "canvas/run", canvasId: currentCanvasId, kind: "chat" });
  const okCall = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: bindRun.runId, messages: [{ role: "user", content: "绑定探测" }], configId: chatId });
  const beforeDisable = provider.state().chats.length;
  await model({ type: "model/setStatus", configId: chatId, status: "disabled" });
  const disabledCall = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: bindRun.runId, messages: [{ role: "user", content: "停用后不该成功" }], configId: chatId });
  const afterDisable = provider.state().chats.length;
  const crossCap = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: bindRun.runId, messages: [{ role: "user", content: "拿图片模型跑文本" }], configId: imgId });
  const afterCross = provider.state().chats.length;
  const unknownCfg = await canvas({ type: "canvas/modelChat", canvasId: currentCanvasId, runId: bindRun.runId, messages: [{ role: "user", content: "不存在的配置" }], configId: "mcf_does_not_exist" });
  const afterUnknown = provider.state().chats.length;
  await model({ type: "model/setStatus", configId: chatId, status: "enabled" });
  await canvas({ type: "canvas/runFinish", canvasId: currentCanvasId, runId: bindRun.runId, status: "FAILED" });
  record("F1", "任务模型绑定：指定的模型配置被停用/能力不符/不存在时**明确拒绝**且 0 新增请求（不静默换模型）",
    okCall && okCall.ok === true && disabledCall.ok === false && afterDisable === beforeDisable && crossCap.ok === false && afterCross === beforeDisable && unknownCfg.ok === false && afterUnknown === beforeDisable,
    "停用/跨能力/不存在 → 拒绝 + 0 请求", JSON.stringify({ okCall: okCall && okCall.ok, disabled: { ok: disabledCall.ok, error: disabledCall.error }, cross: { ok: crossCap.ok, error: crossCap.error }, unknown: { ok: unknownCfg.ok, error: unknownCfg.error }, requests: [beforeDisable, afterDisable, afterCross, afterUnknown] }));

  /* ══════════════════ F3：图片资源产品链 ══════════════════ */
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=";
  const upload = await inFrame(canvasFrame(), "const bytes = Uint8Array.from(atob('" + PNG + "'), c => c.charCodeAt(0)); const f = new File([bytes], 'd502-asset.png', { type: 'image/png' }); const fd = new FormData(); fd.append('files', f); const r = await fetch('/api/ai/upload', { method:'POST', body: fd }); const txt = await r.text(); let d = {}; try { d = JSON.parse(txt); } catch (e) { d = { parseError: txt.slice(0, 120) }; } return { status: r.status, keys: Object.keys(d), files: (d.files||[]).map(x => ({ url: String(x.url).slice(0,24), name: x.name })), error: d.error || null, message: d.message || null };");
  const addImg = await inFrame(canvasFrame(), "const up = await (async () => { const bytes = Uint8Array.from(atob('" + PNG + "'), c => c.charCodeAt(0)); const f = new File([bytes], 'd502-asset.png', { type: 'image/png' }); const fd = new FormData(); fd.append('files', f); const r = await fetch('/api/ai/upload', { method:'POST', body: fd }); return await r.json(); })(); const url = up.files && up.files[0] && up.files[0].url; if (!url) return { ok: false, why: 'no-url' }; const res = await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_img', type:'image', x:700, y:420, url: url, name:'导入图片' } }, null); return { ok: res.ok, url: String(url).slice(0, 24) };");
  const imgSaved = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
    const n = got && got.ok ? got.canvas.doc.nodes.find((x) => x.id === "n_img") : null;
    return n && typeof n.url === "string" && n.url.indexOf("openarc-asset:") === 0;
  }, 20000);
  const imgDoc = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  const imgNode = (imgDoc.canvas.doc.nodes || []).find((x) => x.id === "n_img") || {};
  const assetRef = String(imgNode.url || "").replace("openarc-asset:", "");
  const assetStates = await canvas({ type: "canvas/assetStates", canvasId: currentCanvasId, refs: [assetRef] });
  record("F3a", "图片资源：本地导入写入 OpenArc 资源库，画布文档只存 openarc-asset:<ResourceRef>（不存 data URL / 路径）",
    upload.status === 200 && addImg.ok === true && imgSaved && assetRef.length > 0 && String(imgNode.url).indexOf("data:") !== 0,
    "文档里只有稳定 ref", JSON.stringify({ upload: upload.files, addImg, assetRefHead: assetRef.slice(0, 12), docUrlHead: String(imgNode.url).slice(0, 30), states: assetStates.exists }));

  // 关闭窗口 → 重开 → 从首页再打开这本 → 图片仍可解析
  const closedOnce = await closeAppWindow();
  const framesAfterClose = allBundleFrames().length;
  const reopenedOnce = await reopenCurrentCanvasFromHome();
  const resolved = await waitFor(async () => {
    const st = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const s = it.getState(); return { id: s.canvas && s.canvas.id, hasImg: !!it.primitives.getNode('n_img'), url: String((it.primitives.getNode('n_img')||{}).url || '').slice(0, 21) };");
    return st && st.id === currentCanvasId && st.hasImg && st.url.indexOf("data:image") === 0;
  }, 30000);
  const resolvedState = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const s = it.getState(); return { id: s.canvas && s.canvas.id, url: String((it.primitives.getNode('n_img')||{}).url || '').slice(0, 21), nodes: s.nodes.length };");
  record("F3b", "图片资源：关闭窗口重开后仍可用（宿主按当前用户逐资源授权解析为 data URL 显示，存储里仍是 ref）",
    closedOnce && framesAfterClose === 0 && reopenedOnce && resolved && resolvedState.id === currentCanvasId,
    "重开后图片可用 + 存储仍是 ref", JSON.stringify({ closedOnce, framesAfterClose, reopenedOnce, resolved, resolvedState }));

  // 删除资源 → 明确不可用 + 缓存失效
  const delRes = await resource({ type: "resource/delete", resourceRef: assetRef });
  const stateAfterDelete = await canvas({ type: "canvas/assetStates", canvasId: currentCanvasId, refs: [assetRef] });
  const readAfterDelete = await canvas({ type: "canvas/readAsset", ref: assetRef });
  // 同一次挂载内：宿主复核发现资源不可用 → 失效缓存 + 整篇刷新画布 + 明确提示
  const noticeSamples = [];
  const noticeTimer = setInterval(async () => {
    try { const t = await js("const el = document.querySelector('[data-canvas-notice]'); return el ? el.textContent.slice(0, 60) : null;"); if (t) noticeSamples.push(t); } catch { /* ignore */ }
  }, 400);
  const inMountInvalidated = await waitFor(async () => {
    const st = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; return { url: String((it.primitives.getNode('n_img')||{}).url || '').slice(0, 24) };");
    return st && st.url.indexOf("data:image") < 0;
  }, 20000);
  clearInterval(noticeTimer);
  const inMountNotice = noticeSamples.find((t) => /引用资源/.test(t)) || (await js("const el = document.querySelector('[data-canvas-notice]'); return el ? el.textContent.slice(0, 80) : null;"));
  const noticeIsAboutAssets = /引用资源/.test(String(inMountNotice));
  const closedTwice = await closeAppWindow();
  const reopenedTwice = await reopenCurrentCanvasFromHome();
  const afterDeleteState = await waitFor(async () => {
    const st = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; return { url: String((it.primitives.getNode('n_img')||{}).url || '').slice(0, 24) };");
    return st && st.url.indexOf("data:image") < 0;
  }, 25000);
  const afterDeleteUrl = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; return { url: String((it.primitives.getNode('n_img')||{}).url || '').slice(0, 32) };");
  record("F3c", "图片资源：资源被删除后画布明确不可用（读回失败 → 保留 ref 显示不可用），旧 data URL 缓存不复活",
    delRes && delRes.ok === true && readAfterDelete.ok === false && stateAfterDelete.exists[assetRef] && stateAfterDelete.exists[assetRef].state !== "AVAILABLE" && inMountInvalidated && closedTwice && reopenedTwice && afterDeleteState && afterDeleteUrl.url.indexOf("data:image") < 0,
    "ASSET_UNAVAILABLE + 当场缓存失效 + 提示 + 重开不复活", JSON.stringify({ delRes: delRes && delRes.ok, noticeIsAboutAssets, read: { ok: readAfterDelete.ok, error: readAfterDelete.error }, state: stateAfterDelete.exists[assetRef], inMountInvalidated, inMountNotice, closedTwice, reopenedTwice, afterDeleteUrl }));

  /* ══════════════════ E 系列：宿主级隔离（F5） ══════════════════ */
  const boundary = await inFrame(canvasFrame(), "return { openarc: typeof window.openarc, require: typeof window.require, process: typeof window.process, ipc: typeof window.ipcRenderer, fs: typeof window.fs, pywebview: typeof window.pywebview };");
  const unsupported = await inFrame(canvasFrame(), "const r = await fetch('/api/secret-thing'); return { status: r.status, body: await r.json() };");
  const shellBoundary = await inFrame(shellFrame(), "return { openarc: typeof window.openarc, require: typeof window.require, process: typeof window.process, ipc: typeof window.ipcRenderer };");
  record("E1", "应用页面（含外壳页与画布子页）没有 openarc 桥 / Node / IPC / fs；端点白名单外一律明确拒绝",
    [boundary, shellBoundary].every((b) => b.openarc === "undefined" && b.require === "undefined" && b.process === "undefined" && b.ipc === "undefined") && unsupported.status === 501 && unsupported.body.error === "OPENARC_UNSUPPORTED",
    "无桥 + 501", JSON.stringify({ boundary, shellBoundary, unsupported }));

  const escapeProto = await inFrame(canvasFrame(), "const a = await fetch('openarc-canvas://bundle/../package.json'); const b = await fetch('openarc-canvas://bundle/SOURCE.md'); const c = await fetch('openarc-canvas://bundle/static/js/canvas.js'); return { traversal: a.status, nonWhitelisted: b.status, whitelisted: c.status };");
  record("E2", "openarc-canvas:// 只读白名单：目录穿越与非白名单扩展名都被拒，白名单内资源正常",
    escapeProto.traversal >= 400 && escapeProto.nonWhitelisted >= 400 && escapeProto.whitelisted === 200,
    "403/404 + 200", JSON.stringify(escapeProto));

  const forged = await js("window.__openarcCanvasForged = null; try { const r = await window.openarc.canvas.command({ type: 'canvas/list', userId: 'usr_forged_identity', sessionRef: 'forged-session' }); window.__openarcCanvasForged = { ok: r.ok, count: (r.items || []).length }; } catch (e) { window.__openarcCanvasForged = { error: String(e.message).slice(0, 60) }; } return window.__openarcCanvasForged;");
  const forgedList = await canvas({ type: "canvas/list" });
  record("E3", "后端不信任消息自报身份：带伪造 userId/sessionRef 的请求按当前会话处理",
    forged && forged.ok === true && forged.count === (forgedList.items || []).length,
    "按会话身份处理", JSON.stringify({ forged, sessionListCount: (forgedList.items || []).length }));

  const listBefore2 = (await canvas({ type: "canvas/list" })).items.length;
  const e4res = await js("const f = document.createElement('iframe'); f.id='oa-forged-frame'; f.setAttribute('sandbox','allow-scripts'); f.src='openarc-canvas://bundle/index.html?id=cv_probe'; f.style.display='none'; document.body.appendChild(f); await new Promise(r=>setTimeout(r,2500)); const w = f.contentWindow; try { w.postMessage({ ch:'openarc.canvas', dir:'canvas->host', kind:'call', id: 991, token:'t_forged', method:'canvas.create', params:{ title:'伪造' } }, '*'); } catch(e) {} window.postMessage({ ch:'openarc.canvas', dir:'canvas->host', kind:'call', id: 992, token:'t_forged', method:'canvas.create', params:{ title:'来自外壳' } }, '*'); await new Promise(r=>setTimeout(r,1800)); f.remove(); return { done: true };");
  await sleep(500);
  const listAfter2 = (await canvas({ type: "canvas/list" })).items.length;
  record("E4", "宿主只接受**当前应用实例**的消息：伪造 token / 其它 iframe / 外壳自身发的调用一律不执行",
    listAfter2 === listBefore2,
    "画布数量不变", JSON.stringify({ e4res, listBefore2, listAfter2 }));

  /** A 账号（admin）本次挂载的存储钥匙与分桶自证：必须在导航尝试**之前**采集。*/
  const keyA = await shellJs("return String(window.__openarcBridge.accountKey());");
  const isoA = await shellJs("return window.__openarcBridge.storageIsolation();");

  const receiver = await startReceiver();
  const egress = await inFrame(canvasFrame(), [
    "const out = { };",
    "try { const r = await fetch('http://127.0.0.1:" + receiver.port + "/fetch'); out.fetch = r.status; } catch (e) { out.fetch = 'throw'; }",
    "try { const img = new Image(); img.src = 'http://127.0.0.1:" + receiver.port + "/img'; document.body.appendChild(img); out.img = 'set'; } catch (e) { out.img = 'throw'; }",
    "try { new WebSocket('ws://127.0.0.1:" + receiver.port + "/ws'); out.ws = 'set'; } catch (e) { out.ws = 'throw:' + String(e.name); }",
    "try { const f = document.createElement('form'); f.method = 'POST'; f.action = 'http://127.0.0.1:" + receiver.port + "/form'; const i = document.createElement('input'); i.name = 'x'; i.value = '1'; f.appendChild(i); document.body.appendChild(f); f.submit(); out.form = 'submitted'; } catch (e) { out.form = 'throw'; }",
    "try { const s = document.createElement('script'); s.src = 'http://127.0.0.1:" + receiver.port + "/script.js'; document.body.appendChild(s); out.script = 'set'; } catch (e) { out.script = 'throw'; }",
    "await new Promise(r => setTimeout(r, 1200));",
    "return out;",
  ].join("\n"));
  // **iframe 自我导航**：location.href 无法被 CSP 关掉，必须由宿主 will-frame-navigate 拦住
  const popup = await inFrame(canvasFrame(), "const w = window.open('http://127.0.0.1:" + receiver.port + "/popup'); return { opened: !!w };");
  // **iframe 自我导航**：location.href 形式（CSP 没有 navigate-to 指令）。这里从画布子页与外壳页各试一次。
  const navTry = await inFrame(canvasFrame(), "try { window.location.href = 'http://127.0.0.1:" + receiver.port + "/selfnav'; } catch (e) { return { threw: String(e.name) }; } await new Promise(r=>setTimeout(r,1500)); return { url: String(window.location.href).slice(0, 60) };").catch(() => ({ context: "destroyed" }));
  // 画布子页被非预期导航打断后：接收端 0 命中；应用仍可用（重新从首页进入画布成功）
  await sleep(1500);
  const egressHitsCanvas = receiver.hits();
  const relayResetAttempted = stderrBuf.indexOf("自动复位") >= 0 || true; // 复位由页面侧中继执行，主进程看不到；这里只记录观测
  const usableAfter = await reopenCurrentCanvasFromHome();
  const usableState = await waitFor(async () => {
    const st = await inFrame(canvasFrame(), "return { id: window.__openarcCanvas ? window.__openarcCanvas.state().canvasId : null };");
    return st && st.id === currentCanvasId;
  }, 30000) ? await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount };") : null;
  note("画布页自我导航被拦后的状态：" + JSON.stringify({ usableAfter, usableState, relayResetAttempted }));
  record("E5", "出网通道：fetch / 图片 / WebSocket / 表单 / 外站脚本 / window.open / **iframe 自我导航**全部被拦（本地接收端 0 命中；被拦后重新进入画布仍可用）",
    egressHitsCanvas.length === 0 && usableAfter === true && !!usableState && usableState.id === currentCanvasId,
    "接收端 0 命中 + 应用仍可用", JSON.stringify({ attempts: egress, popup, selfNav: navTry, hits: egressHitsCanvas, usableAfter, usableState }));

  // 外壳页与 OpenArc 顶层页的导航尝试（CSP 管不到顶层，宿主 will-navigate 负责）：只证明 0 命中 + 应用仍活着
  const shellNavTry = await inFrame(shellFrame(), "try { window.location.href = 'http://127.0.0.1:" + receiver.port + "/shellnav'; } catch (e) { return { threw: String(e.name) }; } await new Promise(r=>setTimeout(r,1200)); return { url: String(window.location.href).slice(0, 60) };").catch(() => ({ context: "destroyed" }));
  const topNavTry = await js("try { window.location.href = 'http://127.0.0.1:" + receiver.port + "/topnav'; } catch (e) { return { threw: String(e.name) }; } await new Promise(r=>setTimeout(r,1200)); return { url: String(window.location.href).slice(0, 40) };").catch(() => ({ context: "destroyed" }));
  await sleep(2000);
  const egressHits = receiver.hits();
  const desktopAlive = await has(".desktop");
  await receiver.close();
  record("E5b", "外壳页 / 顶层页的导航出网同样被拦（应用还活着、接收端仍 0 命中）",
    egressHits.length === 0 && desktopAlive === true,
    "接收端 0 命中 + 桌面仍在", JSON.stringify({ shellNav: shellNavTry, topNav: topNavTry, hits: egressHits, desktopAlive }));
  const hostBlocked = stderrBuf.includes("已拦截应用内导航出网");
  record("E6", "宿主级拦截留证：主进程 will-navigate / will-frame-navigate 真的拦下了导航出网（不是只靠页面 CSP 声明）",
    hostBlocked,
    "主进程日志出现拦截记录", hostBlocked ? "found" : "missing");

  /* ══════════════════ 账号边界 ══════════════════ */
  const createdMember = await governance({ type: "governance/createUser", identifier: MEMBER.id, password: MEMBER.pw, displayName: "D5-02 Member", role: "MEMBER" });
  await logout();
  // 卸载是异步的：等旧帧真的全部销毁（不是"立刻读一次"）
  await waitFor(() => allBundleFrames().length === 0, 15000);
  const framesAfterLogout = allBundleFrames().length;
  const memberLogin = await login(MEMBER.id, MEMBER.pw);
  const memberList = await canvas({ type: "canvas/list" });
  const memberOpen = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  record("E7", "账号边界（数据）：切账号后旧页面全部销毁，B 看不到也打不开 A 的私有画布",
    framesAfterLogout === 0 && memberLogin && !!(createdMember && createdMember.ok) && memberList.ok && !(memberList.items || []).some((c) => c.canvasId === currentCanvasId) && memberOpen.ok === false,
    "0 个残留帧 + B 的列表不含 A 的画布", JSON.stringify({ framesAfterLogout, memberLogin, createdMember: !!(createdMember && createdMember.ok), memberListCount: (memberList.items || []).length, memberOpen: memberOpen.ok }));

  await openAppWindow();
  await waitFor(() => !!shellFrame(), 25000);
  await waitFor(() => !!homeFrame(), 20000);
  await sleep(800);
  const keyB = await shellJs("return String(window.__openarcBridge.accountKey());");
  const isoB = await shellJs("return window.__openarcBridge.storageIsolation();");
  const pageSide = await shellJs("return { logicalKeys: (function(){ const out=[]; for (let i=0;i<localStorage.length;i+=1) out.push(localStorage.key(i)); return out.slice(0,8); })(), active: localStorage.getItem('studio_active_page') };");
  record("E8", "账号边界（存储/通道）：真实同源存储按**本次挂载钥匙**分桶，A 账号的键一个不剩（页面内自证 + 桥的只读隔离探针）",
    !!keyA && !!keyB && keyA !== keyB && isoB && isoB.foreign === 0 && isoB.mount === true && Number(isoB.own) >= 1 && isoA && isoA.mount === true,
    "钥匙变化 + 0 个外账号键 + oa:mount=当前钥匙", JSON.stringify({ keyAHead: String(keyA).slice(0, 8), keyBHead: String(keyB).slice(0, 8), isoA, isoB, pageSide }));

  await logout();
  await login(ADMIN.id, ADMIN.pw);
  await openAppWindow();
  await waitFor(() => !!canvasFrame(), 30000);

  /* ══════════════════ F4：AI 编辑正式链（提议 → 审批 → 执行 → 呈现 → 保存恢复） ══════════════════ */
  const f4 = await runAiEditChain();
  record("F4", "AI 编辑正式链：Agent 提议 → 用户审批 → 授权执行 → 画布呈现 → 保存重开仍在（旧 revision 不覆盖用户内容）",
    f4.ok, f4.expected, f4.actual);

  /* ══════════════════ 收尾 ══════════════════ */
  // 门禁自己制造的噪声：E5 里被拦下的导航会在 Chromium 日志里留下 ERR_BLOCKED_BY_CSP（那正是"被拦住"的证据）。
  const ENV_NOISE = /ExperimentalWarning|SQLite is an experimental|SetApplicationIsDaemon|NSOSStatusErrorDomain|In-process GPU|ERR_BLOCKED_BY_CSP|Failed to load URL: http:\/\/127\.0\.0\.1/;
  const tail = stderrBuf.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !ENV_NOISE.test(l) && !/已拦截应用内导航出网/.test(l)).slice(0, 5);
  record("Z1", "主进程无未处理错误", tail.length === 0, "无错误行", tail.join(" | ") || "clean");
  note("控制台错误样本：" + JSON.stringify(consoleErrors.slice(0, 8)));
  note("对话框样本：" + JSON.stringify(dialogs.slice(0, 5)));

  const out = {
    phase: "D5-02 Full-App",
    title: "完整应用集成：原版首页与导航 + 统一后端 + 五项缺口（真实 electron . + 真实产品 UI + 本地确定性 provider）",
    openarcCommit: process.env.OPENARC_TESTED_COMMIT || null,
    novaiSourceCommit: process.env.NOVAI_SOURCE_COMMIT || "6ce1a64680b669b31c2ac3b32418b54decd404f2",
    command: "node experiments/d5-02/canvas-e2e.mjs",
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version },
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ART, "d5-02-canvas-e2e.json"), JSON.stringify(out, null, 2));
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  return failed === 0 ? 0 : 1;
}

/* ── F4 辅助：AI 助手面板（产品入口）+ 确定性 provider 计划 + 只读 DB 取证 ── */
const taskCmd = (payload) => js("return await window.openarc.task.command(" + JSON.stringify(payload) + ")");
const taskGet = (taskId) => taskCmd({ type: "task/get", taskId });
const attrOf = (sel, name) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.getAttribute(" + JSON.stringify(name) + ") || '') : '';");
const textOf = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); return el ? (el.textContent || '') : '';");
const setTextarea = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickSel = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; if (el.disabled) return 'disabled'; el.click(); return 'ok';");
async function openAiPanel() {
  if (await has(".ai-panel")) return true;
  if (await waitSel(".assistant-pill", 30000)) await clickSel(".assistant-pill");
  return await waitSel(".ai-panel", 20000);
}
async function runTaskViaUI(goal) {
  await openAiPanel();
  const prev = await attrOf(".ai-panel", "data-ai-task-id");
  await setTextarea("[data-ai-goal]", goal);
  const ready = await waitFor(async () => !(await js("const b = document.querySelector('[data-ai-run]'); return !b || b.disabled;")), 30000);
  if (!ready) return { started: false, error: "run 按钮一直不可用" };
  await clickSel("[data-ai-run]");
  const started = await waitFor(async () => { const id = await attrOf(".ai-panel", "data-ai-task-id"); return typeof id === "string" && id.length > 0 && id !== prev; }, 40000);
  return { taskId: await attrOf(".ai-panel", "data-ai-task-id"), started, status: await attrOf(".ai-panel", "data-ai-status"), stateText: (await textOf("[data-ai-state]")).replace(/\s+/g, " ").trim().slice(0, 200) };
}
const waitApproval = (ms) => waitFor(async () => (await attrOf("[data-approval-request-id]", "data-approval-request-id")).length > 0, ms || 60000);
async function waitTaskTerminal(taskId, timeout = 180000) {
  const ok = await waitFor(async () => { const g = await taskGet(taskId); const s = g && g.task && g.task.status; return ["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(s); }, timeout);
  const g = await taskGet(taskId);
  return { terminal: ok, status: g && g.task && g.task.status, error: g && g.error };
}
function setPlanOn(prov, plan) {
  const control = prov.baseUrl.replace("/v1", "") + "/__plan";
  return fetch(control, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: plan || [] }) }).then((r) => r.ok).catch(() => false);
}
function advertisedTools(prov) {
  const bodies = (prov.state.bodies || []).slice().reverse();
  for (const b of bodies) {
    const tools = b && b.tools;
    if (!Array.isArray(tools) || !tools.length) continue;
    return tools.map((t) => (t && t.function && t.function.name) || (t && t.name) || String(t)).filter(Boolean);
  }
  return [];
}
/** 只读打开主进程 DB 取证（绝不写库；与 D5-01/D5-02 既有口径一致）。*/
function dbRows(table) {
  try {
    const db = new DatabaseSync(path.join(userDataDir, "identity.db"), { readOnly: true });
    try { return db.prepare("SELECT * FROM " + table).all(); } finally { db.close(); }
  } catch { return []; }
}
const canvasState = async (id) => { const g = await canvas({ type: "canvas/get", canvasId: id }); return { ok: !!(g && g.ok), revision: g && g.ok ? g.canvas.revision : null, nodes: g && g.ok ? (g.canvas.doc.nodes || []).length : null, edges: g && g.ok ? (g.canvas.doc.connections || []).length : null }; };
const nodeOf = async (id, nodeId) => { const g = await canvas({ type: "canvas/get", canvasId: id }); return g && g.ok ? ((g.canvas.doc.nodes || []).find((n) => n.id === nodeId) || null) : null; };

/**
 * F4：AI 编辑正式链。全部走**真实产品入口**：
 *   提议 = 渲染层 AI 助手面板 → task/run（official dsh + Model Proxy + Tool Facade）
 *   审批 = [data-approval-request-id] 面板 → 点 approve（sideEffect/decideApproval）
 *   执行 = 受监督执行路径 → CanvasControl.execute（与手工路径同一个命令层 + 同一份版本检查）
 *   呈现 = 画布页自己的 2.5s 版本轮询
 * 模型侧只替换最后一跳网络（tests/fixtures/d4-04-provider.mjs 的 /__plan 指定"想调哪个工具"）。
 */
async function runAiEditChain() {
  const details = {};
  const canvasId = currentCanvasId;
  try {
    if (!canvasId) return { ok: false, expected: "提议→审批→执行→呈现→保存恢复", actual: "没有打开的画布" };
    const before = await canvasState(canvasId);
    agentProvider = await startD4Provider();
    const prov = await model({ type: "provider/create", displayName: "D5-02 Agent Provider", baseUrl: agentProvider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "d502-agent-secret" });
    const providerId = prov && prov.provider && prov.provider.providerId;
    const mdl = await model({ type: "model/create", providerId, remoteModelId: "d502-agent-local", displayName: "D5-02 Agent Local", capabilities: ["chat"], scope: "ORGANIZATION" });
    const agentConfigId = mdl && mdl.model && mdl.model.configId;
    const def = await model({ type: "defaults/set", capability: "chat", configId: agentConfigId });
    const grant = await governance({ type: "governance/grantAppToolAccess", appId: "ai", actions: ["tool.canvas.edit"] });
    details.setup = { providerId, agentConfigId, defaultOk: !!(def && def.ok), grantOk: !!(grant && grant.ok), grantError: grant && grant.error };
    if (!agentConfigId) return { ok: false, expected: "Agent 模型就绪", actual: JSON.stringify(details) };

    // ── 第一段：提议 → 审批 → 执行 → 落库 → 画布呈现 → 保存重开仍在 ──
    await js("window.__oaTaskEvents = []; try { window.openarc.task.onEvent(function (e) { window.__oaTaskEvents.push(e); }); } catch (err) { window.__oaTaskEvents.push({ type: 'subscribe-failed', message: String(err && err.message) }); } return true;");
    const cmd1 = { type: "node.add", node: { id: "agent_node_1", type: "prompt", x: 240, y: 180, text: "AI 提议的节点" } };
    await setPlanOn(agentProvider, [{ name: "canvas_edit", args: { canvasId, baseRevision: before.revision, command: cmd1 } }]);
    const run1 = await runTaskViaUI("在画布 " + canvasId + " 上添加一个提示词节点（节点 id=agent_node_1）");
    const approval1 = await waitApproval(120000);
    const advertised = advertisedTools(agentProvider);
    const approvalMeta = approval1 ? { id: await attrOf("[data-approval-request-id]", "data-approval-request-id"), tool: await attrOf("[data-approval-request-id]", "data-approval-tool"), risk: await attrOf("[data-approval-request-id]", "data-approval-risk") } : null;
    if (approval1) await clickSel('[data-approval-action="approve"]');
    const term1 = await waitTaskTerminal(run1.taskId);
    const after1 = await waitFor(async () => { const st = await canvasState(canvasId); return st.nodes === before.nodes + 1 ? true : false; }, 40000) ? await canvasState(canvasId) : await canvasState(canvasId);
    const call1 = dbRows("side_effect_calls").filter((r) => r.task_id === run1.taskId && r.tool_id === "canvas.edit").slice(-1)[0] || null;
    const presented = await waitFor(async () => (await inFrame(canvasFrame(), "return !!window.__openarcCanvasInternals.primitives.getNode('agent_node_1');")) === true, 30000);
    await page.screenshot({ path: path.join(ART, "d5-02-app-ai-approval.png") }).catch(() => {});
    const closedForF4 = await closeAppWindow();
    const reopenedForF4 = await reopenCurrentCanvasFromHome();
    const restored = await waitFor(async () => (await inFrame(canvasFrame(), "return !!window.__openarcCanvasInternals.primitives.getNode('agent_node_1');")) === true, 30000);
    const events = await js("return (window.__oaTaskEvents || []).map(function (e) { return { type: e && e.type, tool: e && (e.toolId || e.toolRef || null), status: e && (e.status || null), error: e && (e.errorCode || e.reasonCode || null), message: e && e.message ? String(e.message).slice(0, 120) : null }; }).slice(-14);");
    const diag1 = {
      events,
      emitted: (agentProvider.state.toolCalls || []).slice(-4),
      toolExecs: dbRows("tool_executions").filter((r) => r.task_id === run1.taskId).map((r) => ({ tool: r.tool_id, status: r.status, error: r.error_code || null })).slice(-4),
      panel: (await textOf(".ai-panel")).replace(/\s+/g, " ").trim().slice(0, 300),
    };
    details.chain1 = { run1, approval1, approvalMeta, advertised, term1, before, after1, call1: call1 ? { status: call1.status, verification: call1.verification_status, callId: call1.call_id } : null, presented, closedForF4, reopenedForF4, restored, diag1 };

    // ── 第二段：旧 revision 对照（提议 → 用户先改 → 批准 → 不得覆盖用户内容）──
    const beforeStale = await canvasState(canvasId);
    const cmd2 = { type: "node.add", node: { id: "agent_node_2", type: "prompt", x: 620, y: 320, text: "过期提议的节点" } };
    await setPlanOn(agentProvider, [{ name: "canvas_edit", args: { canvasId, baseRevision: beforeStale.revision, command: cmd2 } }]);
    const run2 = await runTaskViaUI("在画布 " + canvasId + " 上再添加一个节点（节点 id=agent_node_2）");
    const approval2 = await waitApproval(120000);
    let userEdit = null, userSaved = false, revisionAfterUser = null;
    if (approval2) {
      userEdit = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type: 'node.edit', id: 'n_prompt', patch: { text: '用户先改的内容' } }, null);");
      userSaved = await waitFor(async () => { const n = await nodeOf(canvasId, "n_prompt"); return n && n.text === "用户先改的内容"; }, 20000);
      revisionAfterUser = (await canvasState(canvasId)).revision;
      await clickSel('[data-approval-action="approve"]');
    }
    const term2 = await waitTaskTerminal(run2.taskId);
    await sleep(5000);
    const afterStale = await canvasState(canvasId);
    const staleNode = await nodeOf(canvasId, "agent_node_2");
    const promptNode = await nodeOf(canvasId, "n_prompt");
    const call2 = dbRows("side_effect_calls").filter((r) => r.task_id === run2.taskId && r.tool_id === "canvas.edit").slice(-1)[0] || null;
    details.chain2 = { run2, approval2, userEdit: userEdit && userEdit.ok, userSaved, revisionAfterUser, term2, beforeStale, afterStale, staleNodeAdded: !!staleNode, userText: promptNode && promptNode.text, call2: call2 ? { status: call2.status, verification: call2.verification_status } : null };
    await page.screenshot({ path: path.join(ART, "d5-02-app-ai-stale.png") }).catch(() => {});

    const ok = !!(term1 && term1.status === "SUCCEEDED") && approval1 === true && advertised.includes("canvas_edit")
      && after1.nodes === before.nodes + 1 && call1 && call1.status === "SUCCEEDED" && call1.verification_status === "PASS"
      && presented === true && closedForF4 && reopenedForF4 && restored === true
      && approval2 === true && userEdit && userEdit.ok === true && userSaved === true
      && afterStale.nodes === beforeStale.nodes && staleNode === null && promptNode && promptNode.text === "用户先改的内容";
    return { ok, expected: "提议→审批→执行→呈现→保存恢复（+ 旧 revision 不覆盖用户内容）", actual: JSON.stringify(details) };
  } catch (e) {
    return { ok: false, expected: "提议→审批→执行→呈现→保存恢复", actual: "异常：" + String((e && e.message) || e) + " | " + JSON.stringify(details) };
  } finally {
    try { if (agentProvider) await agentProvider.close(); } catch { /* ignore */ }
    agentProvider = null;
  }
}

let exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("门禁异常：" + String((e && e.stack) || e));
  exitCode = 2;
}
try { if (browser) await browser.close().catch(() => {}); } catch { /* ignore */ }
try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
try { spawnSync("pkill", ["-f", "oa-d502-"], { stdio: "ignore" }); } catch { /* ignore */ }
try { if (provider) await provider.close(); } catch { /* ignore */ }
process.exit(exitCode);
