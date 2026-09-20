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
