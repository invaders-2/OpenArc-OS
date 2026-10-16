#!/usr/bin/env node
/**
 * 画布模型名真机验证：无限画布里的模型下拉必须显示供应商提供的模型名，
 * 且每个显示串能正确解析回对应 configId（重名消歧后仍双射）。
 *
 * 真机口径（真实 electron . + 隔离 userData + 唯一 CDP 端口 + 真实 ModelService + 本地确定性 provider）：
 *   1) 起 4 个确定性本地 provider（stub，只替代最后一跳网络）；
 *   2) 经真实产品桥登记 provider/model：
 *        P1 DeepSeek    deepseek-chat
 *        P2 SiliconFlow deepseek-chat        ┐ 同名供应商 + 同名 remoteModelId
 *        P3 SiliconFlow deepseek-chat        ┘ → 必须再用 configId 后缀区分
 *        P4 Google      gemini-3.1-flash-image
 *   3) 打开 AI Studio → 无限画布编辑器，读 /api/config 与节点下拉的实际 option 文本；
 *   4) 逐条切换节点 provider，选中该 provider 下的模型名跑真实调用，
 *      断言请求只落在该 configId 对应的 provider（两条 SiliconFlow 各归各的）；
 *   5) 清单外标签 → 502 MODEL_NOT_FOUND + 宿主计数 +1（不静默回落）；
 *   6) 浅/深各截一张 1440x900@2（= 2880x1800 像素）。
 *
 * 注意：截图里的下拉被探针侧设成 size=options.length 展开，仅为让 option 文本可见；
 *       产品代码与 public/novai-canvas/** 一个字都没改。
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { startCanvasProvider } from "./fixtures/d5-02-canvas-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ART = path.join(ROOT, "artifacts", "canvas-model-labels");
const SHOTS = path.join(ART, "shots");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const ADMIN = { id: "admin@canvas-labels.test", pw: "canvas-labels-1" };
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPORT = { checks: [], facts: {}, shots: [] };
const record = (name, description, ok, expected, actual) => {
  REPORT.checks.push({ name, description, ok: !!ok, expected: String(expected), actual: String(actual).slice(0, 2400) });
  console.log((ok ? "  PASS " : "! FAIL ") + name + " · " + description + (ok ? "" : " — 期望 " + expected + "；实际 " + actual));
  return !!ok;
};
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(fn, timeout = 30000, step = 250) { const end = Date.now() + timeout; for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() >= end) return false; await sleep(step); } }

let child = null, browser = null, page = null, userDataDir = null;
const pops = [];
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const attrOf = (sel, name) => js("const e = document.querySelector(" + JSON.stringify(sel) + "); return e ? e.getAttribute(" + JSON.stringify(name) + ") : null;");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const modelCmd = (payload) => js("return await window.openarc.model.command(" + JSON.stringify(payload) + ")");
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const canvasFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas\.html/);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 300) }; }
}

async function launch(cdpPort) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-labels-"));
  const env = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + cdpPort, ...extraArgs], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
  child.stderr.on("data", () => {});
  await waitFor(async () => { try { return (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).ok; } catch { return false; } }, 90000, 300);
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
  const ctx = browser.contexts()[0];
  await waitFor(() => ctx.pages().length > 0, 60000, 300);
  page = ctx.pages().find((p) => /^file:|^https?:/.test(p.url())) || null;
  if (!page) throw new Error("未找到渲染层页面；pages=" + JSON.stringify(ctx.pages().map((p) => p.url())));
  page.on("dialog", (d) => { pops.push(String(d.message()).slice(0, 140)); void d.dismiss().catch(() => {}); });
  const ses = await page.context().newCDPSession(page);
  await ses.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false });
}

async function setupAndLogin() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized") {
    await waitFor(() => has('[data-d3-id="setup-name"]'), 30000);
    const setupNext = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "Canvas Labels Admin");
    await setupNext();
    await waitFor(() => has('[data-d3-id="setup-identifier"]'), 10000);
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await setupNext();
    await waitFor(() => has('[data-d3-id="setup-password"]'), 10000);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000);
    await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  await waitFor(() => has('[data-d3-id="login-identifier"]'), 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}

async function openCanvasApp() {
  const clicked = await js("const el = document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]'); if (el) el.click(); return !!el;");
  const hostUp = await waitFor(() => has("[data-canvas-host]"), 25000);
  const listUp = await waitFor(() => !!listFrame(), 30000);
  await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate') || document.getElementById('btnNewProject'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const editorUp = await waitFor(() => !!canvasFrame(), 45000);
  await waitFor(async () => (await inFrame(canvasFrame(), "return typeof window.__openarcCanvasInternals;")) === "object", 30000);
  await waitFor(async () => { const st = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };"); return !!(st && st.id); }, 30000);
  return { clicked, hostUp, listUp, editorUp };
}

async function readConfigAndOptions() {
  return await inFrame(canvasFrame(), [
    "const cfg = await (await fetch('/api/config')).json();",
    "await new Promise(function (r) { setTimeout(r, 1000); });",
    "const opts = function (sel) { const s = document.querySelector(sel); if (!s) return { missing: true }; return { value: String(s.value), options: Array.prototype.map.call(s.options, function (o) { return String(o.textContent); }) }; };",
    "return { chat_models: cfg.chat_models || [], image_models: cfg.image_models || [], chat_model: cfg.chat_model || '', image_model: cfg.image_model || '',",
    "  providers: (cfg.api_providers || []).map(function (p) { return { id: String(p.id), name: String(p.name), chat_models: p.chat_models || [], image_models: p.image_models || [] }; }),",
    "  video_models: cfg.video_models || [],",
    "  capabilities: cfg.capabilities || {},",
    "  llmSelect: opts('.llm-model'), imageSelect: opts('.generator-body .model-select') };",
  ].join("\n"));
}

async function runNode(nodeId) {
  await inFrame(canvasFrame(), "window.__openarcCanvas.runNode(" + JSON.stringify(nodeId) + "); return true;");
  await waitFor(async () => {
    const n = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode(" + JSON.stringify(nodeId) + "); return { status: n.runStatus, error: n.runError || '' };");
    return n && (n.status === "done" || n.status === "failed");
  }, 45000);
  return await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode(" + JSON.stringify(nodeId) + "); const last = (n.messages || []).filter(function (m) { return m.role === 'assistant'; }).slice(-1)[0]; return { status: n.runStatus, error: n.runError || '', model: String(n.model || ''), text: String(n.outputText || (last ? last.content : '') || '').slice(0, 80) };");
}

async function switchProvider(nodeId, providerId, field, modelSel, expectedLabel) {
  return await waitFor(async () => {
    await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode(" + JSON.stringify(nodeId) + "); n." + field + " = " + JSON.stringify(providerId) + "; it.primitives.render(); return true;");
    await sleep(400);
    const s = await inFrame(canvasFrame(), [
      "const msel = document.querySelector('[data-id=\"' + " + JSON.stringify(nodeId) + " + '\"] ' + " + JSON.stringify(modelSel) + ");",
      "const n = window.__openarcCanvasInternals.primitives.getNode(" + JSON.stringify(nodeId) + ");",
      "if (!msel) return { missing: true };",
      "return { value: String(msel.value), options: Array.prototype.map.call(msel.options, function (o) { return String(o.textContent); }), nodeModel: String(n.model || '') };",
    ].join("\n"));
    return s && !s.missing && s.value === expectedLabel && s.options.length === 1 && s.options[0] === expectedLabel && s.nodeModel === expectedLabel;
  }, 15000, 400);
}

async function expandSelectsAndShoot(name) {
  const res = [];
  for (const theme of ["light", "dark"]) {
    await js("if (!document.querySelector('.control-center')) { const b = document.querySelector('button[aria-label=\"控制中心\"]'); if (b) b.click(); } return true;");
    await sleep(350);
    await js("const cc = document.querySelector('.control-center'); if (!cc) return 'no-cc'; const g = cc.querySelector('[aria-label=\"外观\"]'); if (!g) return 'no-group'; const btns = Array.prototype.slice.call(g.querySelectorAll('button')); for (const b of btns) if (String(b.textContent).trim() === " + JSON.stringify(theme === "dark" ? "深色" : "浅色") + ") { b.click(); return 'clicked'; } return 'no-btn';");
    await sleep(800);
    await js("const sh = document.querySelector('.cc-shade'); if (sh) sh.click(); return true;");
    await sleep(400);
    await inFrame(canvasFrame(), "try { if (typeof window.fitAllNodesViewport === 'function') window.fitAllNodesViewport(); } catch (e) {} return true;");
    await sleep(900);
    await inFrame(canvasFrame(), "window.__oaExpand = window.setInterval(function () { Array.prototype.forEach.call(document.querySelectorAll('.llm-model, .generator-body .model-select'), function (s) { s.setAttribute('size', String(Math.max(1, s.options.length))); s.style.width = '320px'; s.style.height = 'auto'; s.style.minHeight = '0'; s.style.maxHeight = 'none'; }); }, 100); return true;");
    await sleep(1000);
    const panel = await inFrame(canvasFrame(), [
      "document.querySelectorAll('[data-oa-probe-panel]').forEach(function (e) { e.remove(); });",
      "const wrap = document.createElement('div');",
      "wrap.setAttribute('data-oa-probe-panel', '1');",
      "wrap.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;background:#fff;color:#111;border:1px solid #888;border-radius:8px;padding:10px 12px;font:13px/1.5 -apple-system,Helvetica,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28);max-width:720px';",
      "const title = document.createElement('div'); title.textContent = '探针侧：下列为下拉真实 option 文本（DOM 读取，未改产品）'; title.style.fontWeight = '600'; title.style.marginBottom = '6px'; wrap.appendChild(title);",
      "const out = [];",
      "Array.prototype.forEach.call(document.querySelectorAll('.llm-model, .generator-body .model-select'), function (s) {",
      "  const node = s.closest('.node'); const id = node ? node.getAttribute('data-id') : '?';",
      "  const kind = s.classList.contains('llm-model') ? 'LLM 模型下拉' : '生图模型下拉';",
      "  const clone = s.cloneNode(true); clone.multiple = true; clone.size = Math.max(1, s.options.length);",
      "  clone.style.width = '520px'; clone.style.border = '1px solid #bbb'; clone.style.background = '#fff'; clone.style.color = '#111';",
      "  const cap = document.createElement('div'); cap.textContent = id + ' · ' + kind + ' · 选中：' + String(s.value); cap.style.marginTop = '6px';",
      "  wrap.appendChild(cap); wrap.appendChild(clone);",
      "  out.push({ id: id, kind: kind, selected: String(s.value), options: Array.prototype.map.call(s.options, function (o) { return String(o.textContent); }) });",
      "});",
      "document.body.appendChild(wrap);",
      "return out;",
    ].join("\n"));
    await sleep(400);
    const ses = await page.context().newCDPSession(page);
    const r = await ses.send("Page.captureScreenshot", { format: "png" });
    try { await ses.detach(); } catch { /* ignore */ }
    const file = path.join(SHOTS, name + "-" + theme + ".png");
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    await inFrame(canvasFrame(), "clearInterval(window.__oaExpand); document.querySelectorAll('[data-oa-probe-panel]').forEach(function (e) { e.remove(); }); return true;");
    const b = fs.readFileSync(file);
    res.push({ file: path.relative(ROOT, file), theme, width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length });
  }
  return res;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const ports = await Promise.all([1, 2, 3, 4, 5].map(() => freePort()));
  const cdp = ports[4];
  const stubs = [];
  for (let i = 0; i < 4; i += 1) stubs.push(await startCanvasProvider({ port: ports[i] }));
  let fatal = null;
  try {
    await launch(cdp);
    const loggedIn = await setupAndLogin();
    record("R0", "真实 electron 启动 + 隔离 userData + 唯一 CDP 端口 + 真实 UI 登录", loggedIn && !!browser, "ready", "gate=" + (await gate()) + " cdp=" + cdp + " userData=" + path.basename(userDataDir));

    const SPECS = [
      { name: "DeepSeek", remote: "deepseek-chat", caps: ["chat"], display: "DeepSeek显示名" },
      { name: "SiliconFlow", remote: "deepseek-chat", caps: ["chat"], display: "硅基流动显示名A" },
      { name: "SiliconFlow", remote: "deepseek-chat", caps: ["chat"], display: "硅基流动显示名B" },
      { name: "Google", remote: "gemini-3.1-flash-image", caps: ["image-generation"], display: "Google显示名" },
    ];
    const created = [];
    for (let i = 0; i < SPECS.length; i += 1) {
      const s = SPECS[i];
      const prov = await modelCmd({ type: "provider/create", displayName: s.name, baseUrl: stubs[i].baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "labels-secret-" + i });
      const providerId = prov.provider.providerId;
      const mdl = await modelCmd({ type: "model/create", providerId, remoteModelId: s.remote, displayName: s.display, capabilities: s.caps, scope: "ORGANIZATION" });
      created.push({ name: s.name, remote: s.remote, display: s.display, providerId, configId: mdl.model.configId, stub: stubs[i] });
    }
    const p1 = created[0], p2 = created[1], p3 = created[2], p4 = created[3];
    await modelCmd({ type: "defaults/set", capability: "chat", configId: p1.configId });
    await modelCmd({ type: "defaults/set", capability: "image-generation", configId: p4.configId });
    REPORT.facts.registered = created.map((c) => ({ name: c.name, display: c.display, remote: c.remote, providerId: c.providerId, configId: c.configId }));
    record("R1", "真机登记 4 个 provider / 4 条模型（真实 ModelService；含 2 条同名供应商 + 同名 remoteModelId）", created.every((c) => !!c.configId), "4 条配置", JSON.stringify(created.map((c) => ({ name: c.name, configId: c.configId }))));

    const app = await openCanvasApp();
    record("R2", "打开 AI Studio → 无限画布编辑器", app.clicked && app.hostUp && app.listUp && app.editorUp, "编辑器就绪", JSON.stringify(app));

    const canvasId = (await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };")).id;
    await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_prompt', type:'prompt', x:40, y:60, text:'写一句关于海边的提示词' } }, null);");
    for (const [id, x] of [["n_llm", 320], ["n_llm_a", 700], ["n_llm_b", 1080]]) {
      await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:" + JSON.stringify(id) + ", type:'llm', x:" + x + ", y:60, model:'', systemPrompt:'You are a helpful assistant.' } }, null);");
      await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:" + JSON.stringify(id) + " }, null);");
    }
    await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_gen', type:'generator', x:320, y:520, count:1 } }, null);");
    await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_gen' }, null);");
    await sleep(800);

    const proj = await readConfigAndOptions();
    REPORT.facts.projection = proj;
    const chatLabels = proj.chat_models || [];
    const imageLabels = proj.image_models || [];
    const EXPECT = {
      p1: "deepseek-chat · DeepSeek",
      p2: "deepseek-chat · SiliconFlow · " + p2.configId.slice(-4),
      p3: "deepseek-chat · SiliconFlow · " + p3.configId.slice(-4),
      p4: "gemini-3.1-flash-image",
    };
    const expectedChat = [EXPECT.p1, EXPECT.p2, EXPECT.p3].sort();
    REPORT.facts.expectedLabels = EXPECT;

    record("R3", "chat_models 是供应商真实模型名（remoteModelId）优先；同名供应商再用 configId 后缀消歧；逐条唯一",
      JSON.stringify(chatLabels.slice().sort()) === JSON.stringify(expectedChat)
        && new Set(chatLabels).size === chatLabels.length
        && !chatLabels.some((l) => /显示名/.test(l))
        && EXPECT.p2 !== EXPECT.p3,
      JSON.stringify(expectedChat), JSON.stringify(chatLabels.slice().sort()));
    record("R4", "image_models 是供应商真实模型名（唯一 → 不加后缀）",
      imageLabels.length === 1 && imageLabels[0] === EXPECT.p4 && !/显示名/.test(imageLabels[0]),
      JSON.stringify([EXPECT.p4]), JSON.stringify(imageLabels));
    record("R5", "节点下拉 DOM 选项全部落在 OpenArc 投影清单内（画布按节点 provider 分组，单节点只列该 provider 的模型）",
      ((proj.llmSelect || {}).options || []).length >= 1 && ((proj.llmSelect || {}).options || []).every((l) => chatLabels.includes(l))
        && ((proj.imageSelect || {}).options || []).length >= 1 && ((proj.imageSelect || {}).options || []).every((l) => imageLabels.includes(l)),
      JSON.stringify({ llmSubset: chatLabels, imageSubset: imageLabels }),
      JSON.stringify({ llm: (proj.llmSelect || {}).options, image: (proj.imageSelect || {}).options }));
    record("R6", "默认值投影 chat_model / image_model 与清单同一命名（单一真源）",
      proj.chat_model === EXPECT.p1 && proj.image_model === EXPECT.p4,
      JSON.stringify({ chat_model: EXPECT.p1, image_model: EXPECT.p4 }), JSON.stringify({ chat_model: proj.chat_model, image_model: proj.image_model }));

    const provOf = (id) => (proj.providers || []).find((p) => p.id === id) || {};
    record("R7", "api_providers[].chat_models / image_models 与顶层清单同一命名（每条 provider 只列自己的模型）",
      JSON.stringify(provOf(p1.providerId).chat_models || []) === JSON.stringify([EXPECT.p1])
        && JSON.stringify(provOf(p2.providerId).chat_models || []) === JSON.stringify([EXPECT.p2])
        && JSON.stringify(provOf(p3.providerId).chat_models || []) === JSON.stringify([EXPECT.p3])
        && JSON.stringify(provOf(p4.providerId).image_models || []) === JSON.stringify([EXPECT.p4])
        && provOf(p2.providerId).name === "SiliconFlow" && provOf(p3.providerId).name === "SiliconFlow",
      "逐 provider 精确匹配 + 两条 SiliconFlow 同名",
      JSON.stringify({ p1: provOf(p1.providerId), p2: provOf(p2.providerId), p3: provOf(p3.providerId), p4: provOf(p4.providerId) }));

    const caps = proj.capabilities || {};
    record("R8", "既有语义未改：video_models 仍为空数组，capabilities 仍带 available/transport/configured/defaultUsable",
      Array.isArray(proj.video_models) && proj.video_models.length === 0
        && caps.chat && caps.chat.available === true && caps.chat.configured === true && caps.chat.defaultUsable === true
        && caps["image-generation"] && caps["image-generation"].available === true
        && caps["video-generation"] && caps["video-generation"].available === false && caps["video-generation"].transport === null
        && caps.comfy && caps.comfy.available === false,
      "video_models=[] + capabilities 原语义", JSON.stringify({ video_models: proj.video_models, capabilities: caps }));

    const chatCases = [
      { label: EXPECT.p1, provider: p1, field: "llmProvider", node: "n_llm" },
      { label: EXPECT.p2, provider: p2, field: "llmProvider", node: "n_llm" },
      { label: EXPECT.p3, provider: p3, field: "llmProvider", node: "n_llm_a" },
    ];
    const routing = [];
    for (const c of chatCases) {
      const before = stubs.map((s) => s.state().chats.length);
      const sw = await switchProvider(c.node, c.provider.providerId, c.field, ".llm-model", c.label);
      const run = await runNode(c.node);
      const after = stubs.map((s) => s.state().chats.length);
      const target = stubs.indexOf(c.provider.stub);
      const targetOk = after[target] === before[target] + 1;
      const othersOk = after.every((v, i) => i === target || v === before[i]);
      routing.push({ label: c.label, name: c.provider.name, configId: c.provider.configId, switchOk: sw, runStatus: run.status, runError: run.error, runModel: run.model, target, targetOk, othersOk, before, after });
    }
    REPORT.facts.routing = routing;
    record("R9", "每个显示名都能解析回自己的 configId：逐条切 provider 跑真实调用，只有目标 provider 收到请求（两条同名 SiliconFlow 按 configId 后缀各归各的）",
      routing.length === 3 && routing.every((r) => r.switchOk && r.targetOk && r.othersOk && r.runStatus === "done" && r.runError === "" && r.runModel === r.label),
      "3/3 目标 provider +1、其余 0、run=done",
      JSON.stringify(routing));

    const imgBefore = stubs[3].state().images.length;
    const swImg = await switchProvider("n_gen", p4.providerId, "apiProvider", ".generator-body .model-select", EXPECT.p4);
    const runImg = await runNode("n_gen");
    const imgAfter = stubs[3].state().images.length;
    record("R10", "图片节点显示 gemini-3.1-flash-image 并跑真实图片调用 → 落在该 configId 的 provider（图片 +1）",
      swImg && runImg.status === "done" && imgAfter === imgBefore + 1,
      "Google 图片 +1",
      JSON.stringify({ switchOk: swImg, runStatus: runImg.status, runError: runImg.error, images: [imgBefore, imgAfter], last: stubs[3].state().images.slice(-1) }));

    const nfBefore = Number(await attrOf("[data-canvas-host]", "data-canvas-model-not-found") || 0);
    const beforeAll = stubs.reduce((n, s) => n + s.state().chats.length, 0);
    const reject = await inFrame(canvasFrame(), [
      "const r = await fetch('/api/canvas-llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-chat · 不存在的供应商', message: 'x', messages: [], nodeId: 'n_llm' }) });",
      "const body = await r.json();",
      "return { status: r.status, error: String(body.error || ''), detail: String(body.detail || body.message || '') };",
    ].join("\n"));
    await sleep(700);
    const nfAfter = Number(await attrOf("[data-canvas-host]", "data-canvas-model-not-found") || 0);
    const afterAll = stubs.reduce((n, s) => n + s.state().chats.length, 0);
    record("R11", "清单外标签明确拒绝（502 MODEL_NOT_FOUND），宿主拒绝计数 +1 且 provider 0 新增请求（无静默回落）",
      reject.status === 502 && reject.error === "MODEL_NOT_FOUND" && nfAfter === nfBefore + 1 && afterAll === beforeAll,
      "502 + 计数+1 + 0 请求",
      JSON.stringify({ reject, nf: [nfBefore, nfAfter], providerChats: [beforeAll, afterAll] }));

    await switchProvider("n_llm", p1.providerId, "llmProvider", ".llm-model", EXPECT.p1);
    await switchProvider("n_llm_a", p2.providerId, "llmProvider", ".llm-model", EXPECT.p2);
    await switchProvider("n_llm_b", p3.providerId, "llmProvider", ".llm-model", EXPECT.p3);
    await switchProvider("n_gen", p4.providerId, "apiProvider", ".generator-body .model-select", EXPECT.p4);
    REPORT.facts.beforeShot = await inFrame(canvasFrame(), "const sel = function (id, s) { const e = document.querySelector('[data-id=\"' + id + '\"] ' + s); return e ? { value: String(e.value), options: Array.prototype.map.call(e.options, function (o) { return String(o.textContent); }) } : null; }; return { llm: sel('n_llm','.llm-model'), llmA: sel('n_llm_a','.llm-model'), llmB: sel('n_llm_b','.llm-model'), image: sel('n_gen','.generator-body .model-select') };");

    REPORT.shots = await expandSelectsAndShoot("canvas-model-labels");
    record("R12", "浅/深截图各一张，像素 2880x1800",
      REPORT.shots.length === 2 && REPORT.shots.every((s) => s.width === 2880 && s.height === 1800 && s.bytes > 0),
      "2 x 2880x1800", JSON.stringify(REPORT.shots));

    REPORT.facts.canvasId = canvasId;
    REPORT.facts.stubs = stubs.map((s, i) => ({ i, chats: s.state().chats.length, images: s.state().images.length, models: Array.from(new Set(s.state().models)) }));
    REPORT.facts.dialogs = pops;
  } catch (err) {
    fatal = String((err && err.stack) || err);
    console.error("FATAL " + fatal);
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child) child.kill("SIGTERM"); } catch { /* ignore */ }
    await waitFor(() => !child || child.exitCode !== null || child.signalCode !== null, 8000, 200);
    if (child && child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    for (const s of stubs) { try { await s.close(); } catch { /* ignore */ } }
  }
  const failed = REPORT.checks.filter((c) => !c.ok);
  REPORT.ok = !fatal && failed.length === 0;
  if (fatal) REPORT.fatal = fatal;
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(REPORT, null, 2));
  console.log("\n" + (REPORT.checks.length - failed.length) + "/" + REPORT.checks.length + " checks passed" + (fatal ? " (FATAL)" : ""));
  console.log("RESULT " + JSON.stringify({ ok: REPORT.ok, checks: REPORT.checks.length, failed: failed.map((f) => f.name), shots: REPORT.shots, facts: REPORT.facts }));
  return REPORT.ok ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => { console.error("UNCAUGHT " + (e && e.stack)); process.exit(2); });
