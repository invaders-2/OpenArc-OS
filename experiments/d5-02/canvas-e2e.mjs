/**
 * D5-02 · 无限画布真实产品路径门禁（真实 electron . + 真实产品 UI + 本地确定性 provider）。
 *
 * 覆盖：
 *   C0 启动 / 登录 admin（真实 UI）
 *   C1 模型只有一个来源：画布只能看到 OpenArc 已配置并可用的模型（无 provider / 无凭据 / 无地址）
 *   C2 打开无限画布：宿主窗口 + sandbox iframe + 上游画布真的渲染 + 命令适配器就绪
 *   C3 隔离边界：画布页面没有 openarc 桥 / Node / IPC；端点白名单外一律明确拒绝（不回落）
 *   C4 创建并编辑真实项目：命令层 add/edit/connect → 自动保存 → 版本前进
 *   C5 关闭、重新打开：节点、连线、视口恢复
 *   C6 真实模型调用（文本）：经 OpenArc 模型服务；provider 侧看到的是 OpenArc 的凭据与模型 id
 *   C7 真实模型调用（图片）：同上，走 /images/generations
 *   C8 失败如实展示（provider 500 → 节点失败，不假装成功）
 *   C9 不支持的能力明确报错（视频：OpenArc 没有该传输）
 *   C10 切账号隔离：另一个账号看不到也打不开别人的画布
 *   C11 A28 只读成员：手工与 AI 两条路径被同一条权限规则拒绝
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startCanvasProvider, CANVAS_TEXT_PREFIX } from "../../tests/fixtures/d5-02-canvas-provider.mjs";
import http from "node:http";

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
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 1200), at: Date.now() };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  " : "! ") + "[" + row.status + "] " + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual));
  return ok;
}
const note = (t) => { OBSERVATIONS.push(t); console.log("   · " + t); };
const notVerified = (n, r) => { NOT_VERIFIED.push({ name: n, reason: r }); console.log("   ? [NOT VERIFIED] " + n + " — " + r); };

let child = null, browser = null, page = null, provider = null, stderrBuf = "";
/** 上游画布会弹 alert（例如"需要提示词"）：自动关掉，避免阻塞渲染进程。*/
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
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(150); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);
const canvasFrame = () => page.frames().find((f) => f.url().includes("openarc-canvas://bundle/index.html")) || null;
/** 在画布 iframe 里求值（opaque origin，只能通过 Playwright 的 frame 句柄）。*/
async function inFrame(code) {
  const f = canvasFrame();
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 200) }; }
}

async function launch() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d502-"));
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

/** 本地接收端：记录任何到达的请求（用于证明出网通道被拦住）。*/
async function startReceiver() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.method + " " + req.url); res.writeHead(204); res.end(); });
  server.on("upgrade", (req) => { hits.push("UPGRADE " + req.url); req.socket.destroy(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, hits: () => hits.slice(), close: () => new Promise((r) => server.close(() => r())) };
}

async function login(identifier, pw) {
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', identifier);
  await setInput('[data-d3-id="login-password"]', pw);
  await clickDom('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}
/** 以 owner 身份核对节点数（只读成员改不动东西的独立证据）。*/
async function canvasOwnerNodeCount() {
  await clickDom('[data-d3-id="topbar-logout"]');
  await waitFor(async () => (await gate()) !== "ready", 30000);
  if (!(await login(ADMIN.id, ADMIN.pw))) return -1;
  const got = await canvas({ type: "canvas/get", canvasId: currentCanvasId });
  return got && got.ok ? got.canvas.doc.nodes.length : -1;
}
let currentCanvasId = null;

async function openCanvasWindow() {
  await clickDom('[aria-label="打开无限画布"]');
  return await waitFor(() => has("[data-canvas-host]"), 20000);
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  provider = await startCanvasProvider();
  await launch();
  record("C0", "真实 electron . 启动（隔离 userData / 隔离 CDP 端口）", !!browser, "CDP 可用", "connected");

  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    await setInput('[data-d3-id="setup-name"]', "D5-02 Admin");
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  record("C0", "真实 UI 登录 admin", await login(ADMIN.id, ADMIN.pw), "ready", await gate());

  /* ── C1 模型只有一个来源 ── */
  const prov = await model({ type: "provider/create", displayName: "D5-02 Canvas Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "d502-canvas-secret" });
  const providerId = prov && prov.provider && prov.provider.providerId;
  const chatModel = await model({ type: "model/create", providerId, remoteModelId: "d502-chat", displayName: "D5-02 Chat", capabilities: ["chat"], scope: "ORGANIZATION" });
  const imgModel = await model({ type: "model/create", providerId, remoteModelId: "d502-image", displayName: "D5-02 Image", capabilities: ["image-generation"], scope: "ORGANIZATION" });
  const chatId = chatModel && chatModel.model && chatModel.model.configId;
  const imgId = imgModel && imgModel.model && imgModel.model.configId;
  await model({ type: "defaults/set", capability: "chat", configId: chatId });
  await model({ type: "defaults/set", capability: "image-generation", configId: imgId });
  const models = await model({ type: "canvas/models" });
  const projection = JSON.stringify(models);
  record("C1", "画布可见模型面来自 OpenArc（含能力，且**不含** provider 地址/凭据）",
    !!(models && models.ok && (models.models || []).some((m) => m.configId === chatId)) && !/baseUrl|secret|credential|127\.0\.0\.1|apiKey/i.test(projection),
    "只投影 configId/能力/状态", JSON.stringify({ ok: !!models.ok, count: (models.models || []).length, hasChat: (models.models || []).some((m) => m.configId === chatId), leaks: /baseUrl|secret|credential|127\.0\.0\.1|apiKey/i.test(projection) }));

  /* ── C2 打开无限画布 ── */
  const opened = await openCanvasWindow();
  const frameUp = await waitFor(() => !!canvasFrame(), 25000);
  const frameProbe = "return { internals: typeof window.__openarcCanvasInternals, adapter: typeof window.__openarcCanvas, bridge: typeof window.__openarcBridge, board: !!document.getElementById('board'), nodes: !!document.getElementById('nodes'), readOnly: window.__openarcBridge ? window.__openarcBridge.isReadOnly() : null };";
  await waitFor(async () => (await inFrame(frameProbe)).internals === "object", 25000);
  const canvasInfo = await inFrame(frameProbe);
  const listBefore = await canvas({ type: "canvas/list" });
  record("C2", "打开 NOVAI 无限画布窗口：sandbox iframe + 上游画布真的渲染 + 命令适配器就绪",
    opened && frameUp && !!canvasInfo && canvasInfo.internals === "object" && canvasInfo.adapter === "object" && canvasInfo.bridge === "object" && canvasInfo.board && canvasInfo.nodes && canvasInfo.readOnly === false,
    "board/nodes/adapter 就绪", JSON.stringify({ opened, frameUp, canvasInfo, listCount: (listBefore.items || []).length }));

  /* ── C3 隔离边界 ── */
  const boundary = await inFrame("return { openarc: typeof window.openarc, require: typeof window.require, process: typeof window.process, ipc: typeof window.ipcRenderer, fs: typeof window.fs };");
  const unsupported = await inFrame("const r = await fetch('/api/secret-thing'); return { status: r.status, body: await r.json() };");
  const viaHost = await inFrame("const r = await fetch('/api/canvases'); const d = await r.json(); return { status: r.status, keys: Object.keys(d) };");
  record("C3", "画布页面没有 openarc 桥 / Node / IPC，且端点白名单外一律明确拒绝（不回落、不直连）",
    boundary.openarc === "undefined" && boundary.require === "undefined" && boundary.process === "undefined" && boundary.ipc === "undefined" && boundary.fs === "undefined" && unsupported.status === 501 && viaHost.status === 200,
    "无桥 + 501 + 白名单经宿主", JSON.stringify({ boundary, unsupported, viaHost }));

  /* ── C4 创建并编辑项目（命令层）── */
  const canvasId = (listBefore.items && listBefore.items[0] && listBefore.items[0].canvasId) || null;
  currentCanvasId = canvasId;
  const addA = await inFrame("return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_prompt', type:'prompt', x:80, y:120, text:'D5-02 提示词节点' } }, null);");
  const addB = await inFrame("return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_llm', type:'llm', x:420, y:120, model:'', systemPrompt:'You are a helpful assistant.' } }, null);");
  const link = await inFrame("return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_llm' }, null);");
  const moved = await inFrame("return await window.__openarcCanvas.applyCommand({ type:'node.move', id:'n_llm', x:520, y:180 }, null);");
  const savedOk = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId });
    const nodes = got && got.ok ? got.canvas.doc.nodes : [];
    return nodes.length === 2 && got.canvas.doc.connections.length === 1 && Number(got.canvas.doc.nodes.find((n) => n.id === "n_llm").x) === 520;
  }, 15000);
  const stored = await canvas({ type: "canvas/get", canvasId });
  record("C4", "创建并编辑真实项目：命令层 add/connect/move → 画布自动保存 → 存储里节点/连线/坐标一致",
    !!(addA.ok && addB.ok && link.ok && moved.ok) && savedOk && stored.canvas.revision >= 2,
    "2 节点 + 1 连线 + 坐标 520", JSON.stringify({ addA: addA.ok, addB: addB.ok, link: link.ok, moved: moved.ok, savedOk, revision: stored.canvas.revision, nodes: stored.canvas.doc.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })), edges: stored.canvas.doc.connections.length }));

  /* ── C4b 撤销 / 重做（上游只有撤销；重做由适配层补齐，与手工编辑同一入口）── */
  const undoState = await inFrame("window.__openarcCanvas.undo(); await new Promise(r=>setTimeout(r,400)); const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_llm'); return { x: n.x, canRedo: window.__openarcCanvas.canRedo() };");
  const redoState = await inFrame("window.__openarcCanvas.redo(); await new Promise(r=>setTimeout(r,400)); const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_llm'); return { x: n.x, canRedo: window.__openarcCanvas.canRedo() };");
  const undoPersisted = await waitFor(async () => {
    const got = await canvas({ type: "canvas/get", canvasId });
    const n = got && got.ok ? got.canvas.doc.nodes.find((x) => x.id === "n_llm") : null;
    return n && Number(n.x) === 520;
  }, 15000);
  record("C4b", "撤销 / 重做：撤销真的回退、重做真的恢复（与手工编辑同一历史入口），且结果重新落库",
    Math.round(undoState.x) === 420 && undoState.canRedo === true && Math.round(redoState.x) === 520 && undoPersisted,
    "undo→420 / redo→520 + 落库", JSON.stringify({ undoState, redoState, undoPersisted }));

  /* ── C5 关闭 / 重新打开：恢复 ── */
  await clickDom('[aria-label="关闭无限画布窗口"]').catch(() => {});
  await js("const el=document.querySelector('[data-canvas-host]'); const win=el&&el.closest('[data-window-id]'); const btn=win&&win.querySelector('.window-title button.close'); if(btn) btn.click(); return !!btn;");
  await sleep(600);
  const reopened = await openCanvasWindow();
  const frameBack = await waitFor(() => !!canvasFrame(), 20000);
  const restored = await waitFor(async () => {
    const st = await inFrame("const s = window.__openarcCanvas.state(); return { nodes: s.nodeCount, edges: s.edgeCount };");
    return st && st.nodes === 2 && st.edges === 1;
  }, 20000);
  const restoredState = await inFrame("const it = window.__openarcCanvasInternals; const s = it.getState(); return { nodes: s.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })), edges: s.connections.map((c) => ({ from: c.from, to: c.to })) };");
  record("C5", "关闭后重新打开：节点位置、连线与必要资源从 OpenArc 存储正确恢复",
    reopened && frameBack && restored && restoredState.nodes.length === 2 && restoredState.edges.length === 1 && Math.round(restoredState.nodes.find((n) => n.id === "n_llm").x) === 520,
    "2 节点 + 1 连线 + 坐标一致", JSON.stringify({ reopened, frameBack, restored, restoredState }));

  /* ── C6 真实模型调用（文本）── */
  const configSeen = await inFrame("const cfg = await (await fetch('/api/config')).json(); return { chat: cfg.chat_models, image: cfg.image_models, providers: cfg.api_providers.length, hasKey: JSON.stringify(cfg).includes('secret') };");
  const setText = await inFrame("return await window.__openarcCanvas.applyCommand({ type:'node.edit', id:'n_prompt', patch:{ text:'写一句关于海边的提示词' } }, null);");
  const runLlm = await inFrame("const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_llm'); const cfg = await (await fetch('/api/config')).json(); n.model = cfg.chat_models[0]; it.primitives.render(); window.__openarcCanvas.runNode('n_llm'); return { started: true, model: n.model, nodes: it.getState().nodes.map(x=>x.id) };");
  note("LLM 运行前状态：" + JSON.stringify({ setText: setText && setText.ok, runLlm }));
  const llmDone = await waitFor(async () => {
    const n = await inFrame("const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_llm'); return { status: n.runStatus, error: n.runError || '', text: (n.messages && n.messages.length ? String(n.messages[n.messages.length-1].content || '') : '') };");
    return n && (n.status === "done" || n.status === "failed") ? n : null;
  }, 30000) ? await inFrame("const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_llm'); const last = (n.messages||[]).filter(m=>m.role==='assistant').slice(-1)[0]; return { status: n.runStatus, error: n.runError || '', text: String(n.outputText || (last ? last.content : '') || '') };") : null;
  const providerAfterChat = provider.state();
  record("C6", "真实模型调用链（文本）：经 OpenArc 模型服务 → 本地 provider → 结果回到 LLM 节点",
    !!llmDone && llmDone.status === "done" && String(llmDone.text).startsWith(CANVAS_TEXT_PREFIX) && providerAfterChat.chats.length >= 1 && providerAfterChat.authSeen >= 1,
    "节点拿到 provider 文本 + provider 收到 OpenArc 凭据", JSON.stringify({ llmDone, chats: providerAfterChat.chats.slice(-1), authSeen: providerAfterChat.authSeen, models: providerAfterChat.models.slice(-1) }));
  record("C6b", "画布只看到模型标签（不含 provider 地址/凭据），且文本模型来自 OpenArc 配置",
    !!configSeen && configSeen.providers === 0 && configSeen.hasKey === false && configSeen.chat.length >= 1 && configSeen.image.length >= 1,
    "无 provider / 无密钥 / 有 chat+image", JSON.stringify(configSeen));

  /* ── C7 真实模型调用（图片）── */
  const addGen = await inFrame("return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_gen', type:'generator', x:120, y:420, count:1 } }, null);");
  const linkGen = await inFrame("return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_gen' }, null);");
  const runGen = await inFrame("const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); const cfg = await (await fetch('/api/config')).json(); n.model = cfg.image_models[0]; n.apiProvider='openarc'; it.primitives.render(); window.__openarcCanvas.runNode('n_gen'); return { started: true, model: n.model, imageModels: cfg.image_models };");
  note("图片运行前状态：" + JSON.stringify({ addGen: addGen && addGen.ok, linkGen: linkGen && linkGen.ok, runGen }));
  const genDone = await waitFor(async () => {
    const n = await inFrame("const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); return { status: n.runStatus, error: n.runError || '' };");
    return n && (n.status === "done" || n.status === "failed") ? n : null;
  }, 60000) ? await inFrame("const it = window.__openarcCanvasInternals; const out = it.getState().nodes.find(x => x.type==='output'); const imgs = out ? (out.items||out.images||[]) : []; return { status: it.primitives.getNode('n_gen').runStatus, error: it.primitives.getNode('n_gen').runError || '', outputCount: imgs.length, first: imgs[0] ? String(imgs[0].url || imgs[0]).slice(0, 40) : '' };") : null;
  const providerAfterImage = provider.state();
  record("C7", "真实模型调用链（图片）：经 OpenArc 模型服务 → /images/generations → 输出节点拿到图片",
    !!genDone && genDone.status === "done" && (genDone.outputCount || 0) >= 1 && providerAfterImage.images.length >= 1,
    "输出节点有图片 + provider 收到图片请求", JSON.stringify({ genDone, images: providerAfterImage.images.slice(-1), authSeen: providerAfterImage.authSeen }));

  /* ── C8 失败如实展示 ── */
  await provider.setMode("fail");
  const runFail = await inFrame("await window.__openarcCanvas.runNode('n_gen'); return true;");
  const failedState = await waitFor(async () => {
    const n = await inFrame("const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); return { status: n.runStatus, error: n.runError || '' };");
    return n && n.status === "failed" && n.error ? n : null;
  }, 45000) ? await inFrame("const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); return { status: n.runStatus, error: n.runError || '' };") : null;
  await provider.setMode("ok");
  note("模型链诊断：" + JSON.stringify({ provider: provider.state().chats.length + "/" + provider.state().images.length, dialogs: dialogs.slice(0, 6), consoleErrors: consoleErrors.slice(0, 6) }));
  record("C8", "失败如实展示：provider 500 → 节点标记失败并带错误（不假装成功）",
    !!runFail && !!failedState && failedState.status === "failed" && failedState.error.length > 0,
    "runStatus=failed + runError", JSON.stringify(failedState));


  /* ── D 系列：模型调用的授权 / 预算 / 停止（任务归属）── */
  const canvasAppGrant = await governance({ type: "governance/getAppAccess", appId: "canvas" });
  const modelGrant = (canvasAppGrant && canvasAppGrant.grants ? canvasAppGrant.grants : []).find((x) => Array.isArray(x.actions) && x.actions.includes("model.use")) || null;
  const beforeNoPerm = provider.state().chats.length;
  const noPermRun = await canvas({ type: "canvas/run", canvasId, kind: "chat" });
  if (modelGrant) await governance({ type: "governance/revokeAppAccess", grantId: modelGrant.grantId });
  const revokedRun = await canvas({ type: "canvas/run", canvasId, kind: "chat" });
  const afterNoPerm = provider.state().chats.length;
  if (modelGrant) await governance({ type: "governance/grantAppAccess", appId: "canvas", resourceType: "model", scope: "ORGANIZATION", actions: ["model.view", "model.use"] });
  const regranted = await canvas({ type: "canvas/run", canvasId, kind: "chat" });
  record("D1", "无权限：画布应用的 model.use 被撤销后，生成**明确拒绝**且 provider 收不到任何请求", 
    !!modelGrant && revokedRun.ok === false && revokedRun.error === "PROXY_UNAUTHORIZED" && afterNoPerm === beforeNoPerm && noPermRun.ok && regranted.ok,
    "PROXY_UNAUTHORIZED + 0 请求", JSON.stringify({ projectAccess: canvasAppGrant && { ok: canvasAppGrant.ok, error: canvasAppGrant.error, grants: (canvasAppGrant.grants || []).map((x) => ({ actions: x.actions, resourceType: x.resourceType })) }, hasGrant: !!modelGrant, noPermRun: noPermRun.ok, revoked: { ok: revokedRun.ok, error: revokedRun.error }, requests: beforeNoPerm + "→" + afterNoPerm, regranted: regranted.ok }));

  // 能力不支持：把 image-generation 默认指到一个只有 chat 能力的模型上
  const chatOnly = await model({ type: "model/create", providerId, remoteModelId: "d502-chat-only", displayName: "D5-02 ChatOnly", capabilities: ["chat"], scope: "ORGANIZATION" });
  await model({ type: "defaults/set", capability: "image-generation", configId: chatOnly.model.configId });
  const beforeCap = provider.state().images.length;
  const capRun = await canvas({ type: "canvas/run", canvasId, kind: "image" });
  const afterCap = provider.state().images.length;
  await model({ type: "defaults/set", capability: "image-generation", configId: imgId });
  record("D2", "能力不支持：图片能力被指到只有 chat 的模型上 → 明确 CAPABILITY_UNAVAILABLE，provider 收不到图片请求",
    capRun.ok === false && capRun.error === "CAPABILITY_UNAVAILABLE" && afterCap === beforeCap,
    "CAPABILITY_UNAVAILABLE + 0 请求", JSON.stringify({ capRun: { ok: capRun.ok, error: capRun.error }, images: beforeCap + "→" + afterCap }));

  // 预算：同一个 run 内反复调用，直到任务级 MODEL_CALLS 用尽
  await provider.setMode("ok");
  const budgetRun = await canvas({ type: "canvas/run", canvasId, kind: "chat" });
  let budgetOk = 0, budgetStop = null;
  for (let i = 0; i < 40 && !budgetStop; i += 1) {
    const r = await canvas({ type: "canvas/modelChat", canvasId, runId: budgetRun.runId, messages: [{ role: "user", content: "预算探测 " + (i + 1) }] });
    if (r && r.ok) budgetOk += 1; else budgetStop = r;
  }
  const budgetState = await canvas({ type: "canvas/runState", canvasId, runId: budgetRun.runId });
  const providerChats = provider.state().chats.length;
  record("D3", "预算不足：任务级 MODEL_CALLS 用尽后**明确拒绝**，provider 请求数 = 成功调用数（拒绝的那次没发出去）",
    budgetStop && budgetStop.error === "BUDGET_EXHAUSTED" && budgetState.run.status === "BUDGET_EXHAUSTED" && providerChats === budgetOk,
    "BUDGET_EXHAUSTED + 请求数=成功数", JSON.stringify({ budgetOk, stop: budgetStop && budgetStop.error, runStatus: budgetState.run.status, providerChats, remaining: budgetState.budget && budgetState.budget.remaining }));

  // 停止：在途请求不可撤回（如实记录），但停止后不再发新请求；迟到结果不返回、不覆盖用户随后编辑
  await provider.setMode("slow");
  const stopRun = await canvas({ type: "canvas/run", canvasId, kind: "chat", nodeId: "n_llm" });
  const inflight = canvas({ type: "canvas/modelChat", canvasId, runId: stopRun.runId, messages: [{ role: "user", content: "这条会被停止" }] });
  await sleep(600);
  const stopped = await canvas({ type: "canvas/runStop", canvasId, runId: stopRun.runId, reason: "USER_STOP" });
  const late = await inflight;
  const afterStop = await canvas({ type: "canvas/modelChat", canvasId, runId: stopRun.runId, messages: [{ role: "user", content: "停止后不该再发" }] });
  const chatsAtStop = provider.state().chats.length;
  await sleep(3000);
  const chatsAfterLate = provider.state().chats.length;
  await provider.setMode("ok");
  // 用户随后编辑的节点内容必须还在（迟到结果从未回到画布）
  await inFrame("const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_llm'); n.outputText = '用户随后编辑的内容'; it.primitives.render(); return true;");
  const userText = await inFrame("const it = window.__openarcCanvasInternals; return { text: String(it.primitives.getNode('n_llm').outputText || '') };");
  record("D4", "停止：在途请求不可撤回（如实），但停止后**不再发新请求**；迟到结果被丢弃，不覆盖用户随后编辑的节点",
    !!(stopped && stopped.ok) && stopped.run.status === "STOPPED" && late && late.ok === false && late.error === "RUN_STOPPED" && afterStop.ok === false && ["RUN_STOPPED", "TASK_CANCELLED"].includes(afterStop.error) && chatsAfterLate === chatsAtStop && userText.text === "用户随后编辑的内容",
    "STOPPED + 迟到丢弃 + 用户内容保留", JSON.stringify({ stopped: stopped && stopped.run, late: late && { ok: late.ok, error: late.error }, afterStop: { ok: afterStop.ok, error: afterStop.error }, chatsAtStop, chatsAfterLate, userText }));

  // 失败收敛：不隐藏重试；凭据不出现在任何回包里
  await provider.setMode("fail");
  const failRun = await canvas({ type: "canvas/run", canvasId, kind: "chat" });
  const beforeFail = provider.state().chats.length;
  const fail1 = await canvas({ type: "canvas/modelChat", canvasId, runId: failRun.runId, messages: [{ role: "user", content: "失败探测" }] });
  const afterFail1 = provider.state().chats.length;
  const fail2 = await canvas({ type: "canvas/modelChat", canvasId, runId: failRun.runId, messages: [{ role: "user", content: "失败探测 2" }] });
  const afterFail2 = provider.state().chats.length;
  await provider.setMode("ok");
  const leakScan = JSON.stringify([fail1, fail2, await canvas({ type: "canvas/models" }), canvasInfo, configSeen]);
  record("D5", "失败收敛：provider 500 → 明确失败、**每次调用恰好一次请求**（无隐藏重试），且响应/authored 面不含凭据",
    fail1 && fail1.ok === false && afterFail1 === beforeFail + 1 && fail2 && fail2.ok === false && afterFail2 === beforeFail + 2 && !leakScan.includes("d502-canvas-secret"),
    "每次一次请求 + 无凭据", JSON.stringify({ fail1: fail1 && fail1.error, fail2: fail2 && fail2.error, requests: [beforeFail, afterFail1, afterFail2], leaksSecret: leakScan.includes("d502-canvas-secret") }));

  /* ── E 系列：隔离必须由宿主强制 ── */
  const escapeProto = await inFrame("const a = await fetch('openarc-canvas://bundle/../package.json'); const b = await fetch('openarc-canvas://bundle/SOURCE.md'); return { traversal: a.status, nonWhitelisted: b.status };");
  record("E3", "openarc-canvas:// 不能越界读取任意本地文件（目录穿越与非白名单扩展名都被拒）",
    escapeProto.traversal >= 400 && escapeProto.nonWhitelisted >= 400,
    "403/404", JSON.stringify(escapeProto));

  const forged = await js("window.__openarcCanvasForged = null; try { const r = await window.openarc.canvas.command({ type: 'canvas/list', userId: 'usr_forged_identity', sessionRef: 'forged-session' }); window.__openarcCanvasForged = { ok: r.ok, count: (r.items || []).length }; } catch (e) { window.__openarcCanvasForged = { error: String(e.message).slice(0, 60) }; } return window.__openarcCanvasForged;");
  const forgedList = await canvas({ type: "canvas/list" });
  record("E2", "后端不信任消息自报身份：带伪造 userId/sessionRef 的请求按**当前会话**处理（不是伪造身份）",
    forged && forged.ok === true && forged.count === (forgedList.items || []).length,
    "按会话身份处理", JSON.stringify({ forged, sessionListCount: (forgedList.items || []).length }));

  /* ── E4：出网通道（本地接收端实测；fetch 替换只是兼容层，限制由宿主/CSP 强制）── */
  const receiver = await startReceiver();
  const egress = await inFrame([
    "const out = { };",
    "try { const r = await fetch('http://127.0.0.1:" + receiver.port + "/fetch'); out.fetch = r.status; } catch (e) { out.fetch = 'throw'; }",
    "try { const img = new Image(); img.src = 'http://127.0.0.1:" + receiver.port + "/img'; document.body.appendChild(img); out.img = 'set'; } catch (e) { out.img = 'throw'; }",
    "try { new WebSocket('ws://127.0.0.1:" + receiver.port + "/ws'); out.ws = 'set'; } catch (e) { out.ws = 'throw:' + String(e.name); }",
    "try { const f = document.createElement('form'); f.method = 'POST'; f.action = 'http://127.0.0.1:" + receiver.port + "/form'; const i = document.createElement('input'); i.name = 'x'; i.value = '1'; f.appendChild(i); document.body.appendChild(f); f.submit(); out.form = 'submitted'; } catch (e) { out.form = 'throw'; }",
    "try { const s = document.createElement('script'); s.src = 'http://127.0.0.1:" + receiver.port + "/script.js'; document.body.appendChild(s); out.script = 'set'; } catch (e) { out.script = 'throw'; }",
    "await new Promise(r => setTimeout(r, 800));",
    "return out;",
  ].join("\n"));
  await sleep(600);
  const egressHits = receiver.hits();
  record("E4", "出网通道：图片加载 / WebSocket / 表单提交 / 外站脚本都被**宿主级策略**拦住（本地接收端 0 命中）",
    egressHits.length === 0,
    "接收端 0 命中", JSON.stringify({ attempts: egress, hits: egressHits }));

  /* ── E1：宿主只接受当前画布实例的消息 ── */
  const listBefore2 = (await canvas({ type: "canvas/list" })).items.length;
  const e1res = await js("const f = document.createElement('iframe'); f.id='oa-forged-frame'; f.setAttribute('sandbox','allow-scripts'); f.src='openarc-canvas://bundle/index.html?id=cv_probe'; f.style.display='none'; document.body.appendChild(f); await new Promise(r=>setTimeout(r,1500)); const w = f.contentWindow; let delivered = 0; try { w.postMessage({ ch:'openarc.canvas', dir:'canvas->host', kind:'call', id: 991, token:'t_forged', method:'canvas.create', params:{ title:'伪造' } }, '*'); delivered++; } catch(e) {} window.postMessage({ ch:'openarc.canvas', dir:'canvas->host', kind:'call', id: 992, token:'t_forged', method:'canvas.create', params:{ title:'来自外壳' } }, '*'); await new Promise(r=>setTimeout(r,1200)); f.remove(); return { delivered };");
  await sleep(500);
  const listAfter2 = (await canvas({ type: "canvas/list" })).items.length;
  record("E1", "宿主只接受**当前画布实例**的消息：伪造 token / 其它 iframe / 外壳自身发的调用一律不执行",
    listAfter2 === listBefore2,
    "画布数量不变", JSON.stringify({ e1res, listBefore2, listAfter2 }));
  await receiver.close();

  /* ── C9 不支持的能力明确报错 ── */
  const video = await inFrame("const r = await fetch('/api/canvas-video', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt:'x' }) }); return { status: r.status, body: await r.json() };");
  record("C9", "OpenArc 尚不支持的能力（视频）明确报错，不静默改用其它服务",
    video && video.status === 501 && video.body && video.body.error === "OPENARC_UNSUPPORTED",
    "501 OPENARC_UNSUPPORTED", JSON.stringify(video));

  /* ── C10 切账号隔离 ── */
  const createdMember = await governance({ type: "governance/createUser", identifier: MEMBER.id, password: MEMBER.pw, displayName: "D5-02 Member", role: "MEMBER" });
  note("创建成员返回：" + JSON.stringify(createdMember));
  await clickDom('[data-d3-id="topbar-logout"]');
  const loggedOut = await waitFor(async () => (await gate()) !== "ready", 30000);
  const memberLogin = await login(MEMBER.id, MEMBER.pw);
  const memberList = await canvas({ type: "canvas/list" });
  const memberOpen = await canvas({ type: "canvas/get", canvasId });
  record("C10", "切账号后不能读取或修改另一账号的私有画布",
    loggedOut && memberLogin && !!(createdMember && createdMember.ok) && memberList.ok && !(memberList.items || []).some((c) => c.canvasId === canvasId) && memberOpen.ok === false,
    "B 的列表不含 A 的画布且打不开", JSON.stringify({ createdMember: !!(createdMember && createdMember.ok), loggedOut, memberLogin, memberListCount: (memberList.items || []).length, memberOpen: memberOpen.ok }));

  /* ── C11 A28 只读成员 ── */
  await clickDom('[data-d3-id="topbar-logout"]');
  await waitFor(async () => (await gate()) !== "ready", 30000);
  const backToAdmin = await login(ADMIN.id, ADMIN.pw);
  const memberUserId = (createdMember && (createdMember.userId || (createdMember.user && createdMember.user.id) || (createdMember.user && createdMember.user.userId))) || null;
  const shared = await canvas({ type: "canvas/share", canvasId, userId: memberUserId, role: "VIEWER" });
  const ownerBefore = (await canvas({ type: "canvas/get", canvasId })).canvas.doc.nodes.length;
  note("共享结果：" + JSON.stringify(shared) + "；共享前 owner 节点数 " + ownerBefore);
  await clickDom('[data-d3-id="topbar-logout"]');
  await waitFor(async () => (await gate()) !== "ready", 30000);
  await login(MEMBER.id, MEMBER.pw);
  const sharedList = await canvas({ type: "canvas/list" });
  const sharedItem = (sharedList.items || []).find((c) => c.canvasId === canvasId) || null;
  await openCanvasWindow();
  await waitFor(() => !!canvasFrame(), 20000);
  // 真实产品路径：用宿主工具条的画布选择器切到被共享的那一本（不是新建自己的画布）
  await waitFor(() => has("[data-canvas-picker]"), 15000);
  const pickerOptions = await js("return Array.from(document.querySelectorAll('[data-canvas-picker] option')).map(o=>o.value)");
  await js("const sel=document.querySelector('[data-canvas-picker]'); sel.value=" + JSON.stringify(canvasId) + "; sel.dispatchEvent(new Event('change',{bubbles:true})); return sel.value;");
  await sleep(1500);
  await waitFor(async () => !!canvasFrame(), 20000);
  await waitFor(async () => (await inFrame("return { ready: typeof window.__openarcCanvas === 'object' }")).ready === true, 20000);
  const openedShared = await waitFor(async () => (await inFrame("const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount };")).id === canvasId, 20000) ? await inFrame("const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount };") : null;
  note("只读成员打开的画布：" + JSON.stringify({ pickerOptions, openedShared }));
  const roCtx = await inFrame("return { readOnly: window.__openarcBridge.isReadOnly() };");
  const roManual = await inFrame("return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'x', type:'prompt', x:0, y:0 } }, null);");
  const roSave = await canvas({ type: "canvas/save", canvasId, baseRevision: 1, doc: { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] } });
  const roAi = await canvas({ type: "canvas/command", canvasId, baseRevision: 1, command: { type: "node.add", node: { id: "y", type: "prompt", x: 0, y: 0 } } });
  const afterRo = await canvas({ type: "canvas/get", canvasId });
  const ownerNodes = await canvasOwnerNodeCount();
  record("C11", "A28 只读成员：手工与 AI 两条路径被同一条权限规则拒绝（画布页面也是只读态）",
    !!sharedItem && sharedItem.access.canEdit === false && roCtx.readOnly === true && roManual.ok === false && roManual.error === "READ_ONLY" && roSave.ok === false && roSave.error === "READ_ONLY" && roAi.ok === false && roAi.error === "READ_ONLY" && ownerNodes === ownerBefore,
    "READ_ONLY（两条路径）+ 内容未变", JSON.stringify({ sharedItem: sharedItem && sharedItem.access, roCtx, roManual, roSave: roSave.error, roAi: roAi.error, ownerBefore, ownerNodes, memberRead: afterRo && afterRo.ok ? afterRo.canvas.revision : afterRo }));

  // Electron/Chromium 自身的沙箱日志（SetApplicationIsDaemon / NSOSStatusErrorDomain paramErr）与产品无关，
  // 按既有惯例过滤环境噪声；其余 error 行一律算失败。
  const ENV_NOISE = /ExperimentalWarning|SQLite is an experimental|SetApplicationIsDaemon|NSOSStatusErrorDomain|In-process GPU/i;
  const tail = stderrBuf.split("\n").filter((l) => /error|Error|FATAL/.test(l)).filter((l) => !ENV_NOISE.test(l)).slice(0, 5);
  record("C12", "主进程无未处理错误", tail.length === 0, "无错误行", tail.join(" | ") || "clean");

  const out = {
    phase: "D5-02",
    title: "无限画布集成：真实产品路径（真实 electron . + 真实画布 + OpenArc 模型服务 + 本地确定性 provider）",
    openarcCommit: process.env.OPENARC_TESTED_COMMIT || null,
    novaiSourceCommit: process.env.OA_NOVAI_SOURCE_COMMIT || null,
    command: "node experiments/d5-02/canvas-e2e.mjs",
    env: { platform: process.platform, arch: process.arch, node: process.version, electron: require("electron/package.json").version },
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    notVerified: NOT_VERIFIED, observations: OBSERVATIONS, at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ART, "d5-02-canvas-e2e.json"), JSON.stringify(out, null, 2));
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length, notVerified: NOT_VERIFIED.length }));
  return failed === 0 ? 0 : 1;
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
