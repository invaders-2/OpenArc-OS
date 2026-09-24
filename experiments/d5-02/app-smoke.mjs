/**
 * D5-02 Full-App · 交互式冒烟探针（开发期快速定位；正式门禁是 canvas-e2e.mjs）。
 * 流程：登录 → 打开应用（入口=原版列表首页 canvas-list）→ 开始创作直达编辑器 → 编辑保存 →
 *       #backToManagerBtn 返回列表 → 点卡片再进编辑器（产品路径；不是 IPC 造帧）。
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const CDP_PORT = Number(process.env.OA_D502_CDP_PORT || 9799);
const ADMIN = { id: "admin@d502-app.test", pw: "app-admin-1" };
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null, browser = null, page = null, stderrBuf = "";
const logs = [];
const js = (code) => page.evaluate("(async () => { " + code + " })()");
async function waitFor(fn, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
/** 新形态：入口帧 = 上游原版列表首页 canvas-list（画布工作台）；编辑器 = 同一宿主帧导航后的 canvas.html。*/
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const canvasFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas\.html/);
async function inFrame(f, code) { if (!f) return { __noFrame: true }; try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); } catch (e) { return { __error: String((e && e.message) || e).slice(0, 200) }; } }
const hostCanvas = (payload) => js("return await window.openarc.canvas.command(" + JSON.stringify(payload) + ")");

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d502app-"));
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, ...extraArgs], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1" } });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!page && Date.now() < end) { page = ctx.pages().find((p) => p.url().includes("dist/index.html")) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面");
  page.on("console", (m) => { if (m.type() === "error") logs.push("console:" + m.text().slice(0, 200)); });
  page.on("pageerror", (e) => logs.push("pageerror:" + String(e.message).slice(0, 200)));
  page.on("dialog", (d) => { logs.push("dialog:" + String(d.message()).slice(0, 120)); void d.dismiss().catch(() => {}); });

  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized") {
    await js("const set=(s,v)=>{const el=document.querySelector(s); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));}; set('[data-d3-id=\"setup-name\"]','Smoke'); set('[data-d3-id=\"setup-identifier\"]'," + JSON.stringify(ADMIN.id) + "); set('[data-d3-id=\"setup-password\"]'," + JSON.stringify(ADMIN.pw) + "); set('[data-d3-id=\"setup-confirm\"]'," + JSON.stringify(ADMIN.pw) + "); document.querySelector('[data-d3-id=\"setup-submit\"]').click(); return 'ok';");
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  await waitFor(() => has('[data-d3-id="login-identifier"]'), 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  console.log("login:", await waitFor(async () => (await gate()) === "ready", 60000));

  await clickDom('[aria-label="打开AI Studio"]');
  await waitFor(() => has("[data-canvas-host]"), 20000);
  console.log("A1 入口帧（canvas-list）:", await waitFor(() => !!listFrame(), 25000));
  await sleep(2500);
  console.log("A2 frames:", page.frames().map((f) => f.url().replace("openarc-canvas://bundle/", "").slice(0, 60)).join(" | "));
  console.log("A2b 入口页身份:", JSON.stringify(await inFrame(listFrame(), "return { title: document.title, start: !!document.getElementById('btnStartCreate'), cont: !!document.getElementById('btnContinueLast'), grid: !!document.getElementById('cardsGrid'), picker: !!document.getElementById('canvasPickerOverlay'), iframes: document.querySelectorAll('iframe').length };")));

  // A3 入口页「开始创作」→ 直接进画布编辑器（不再有选画布遮挡层 .active）
  const created = await inFrame(listFrame(), "const r = await (await fetch('/api/canvases')).json(); return { before: (r && r.canvases ? r.canvases : []).length };");
  console.log("A3 list canvases:", JSON.stringify(created));
  const pickerWatch = [];
  const watchTimer = setInterval(async () => { try { const f = listFrame() || canvasFrame(); if (!f) return; const cls = await inFrame(f, "const el = document.getElementById('canvasPickerOverlay'); return el ? String(el.className) : null;"); pickerWatch.push(cls === null ? "absent" : cls); } catch { /* ignore */ } }, 150);
  const clickRes = await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';");
  console.log("A3b click 开始创作:", JSON.stringify(clickRes));
  const gotCanvas = await waitFor(() => !!canvasFrame(), 40000);
  clearInterval(watchTimer);
  console.log("A3c picker overlay 采样:", JSON.stringify(pickerWatch.slice(0, 10)), "激活过:", pickerWatch.some((c) => /(^|\s)active(\s|$)/.test(c)));
  console.log("A4 canvas editor frame:", gotCanvas, "| list frame:", !!listFrame(), "| frames:", page.frames().map((f) => f.url().split("/static/")[1] || f.url().slice(0, 30)).join(","));
  const adapterReady = await waitFor(async () => (await inFrame(canvasFrame(), "return { internals: typeof window.__openarcCanvasInternals, adapter: typeof window.__openarcCanvas, bridge: typeof window.__openarcBridge, board: !!document.getElementById('board'), ro: window.__openarcBridge ? window.__openarcBridge.isReadOnly() : null };")).internals === "object", 30000);
  console.log("A5 adapter:", adapterReady, JSON.stringify(await inFrame(canvasFrame(), "return { internals: typeof window.__openarcCanvasInternals, board: !!document.getElementById('board'), nodes: !!document.getElementById('nodes'), ro: window.__openarcBridge.isReadOnly() };")));
  const state = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount, rev: s.revision };");
  console.log("A6 canvas state:", JSON.stringify(state));

  // A7 编辑并保存
  const add = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_smoke', type:'prompt', x:120, y:160, text:'冒烟节点' } }, null);");
  const saved = await waitFor(async () => {
    const got = await hostCanvas({ type: "canvas/get", canvasId: state.id });
    return got && got.ok && got.canvas.doc.nodes.length === 1;
  }, 20000);
  console.log("A7 add:", JSON.stringify(add && { ok: add.ok, error: add.error }), "saved:", saved);
  const hostState = await hostCanvas({ type: "canvas/get", canvasId: state.id });
  console.log("A8 host doc:", JSON.stringify({ nodes: hostState.canvas.doc.nodes.map((n) => ({ id: n.id, x: n.x })), rev: hostState.canvas.revision, title: hostState.canvas.title }).slice(0, 300));

  // A9 返回：画布页 #backToManagerBtn → 画布列表（同一个宿主帧内导航）
  const backClick = await inFrame(canvasFrame(), "const el = document.getElementById('backToManagerBtn'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const backToList = await waitFor(() => !!listFrame() && !canvasFrame(), 30000);
  console.log("A9 back to list:", JSON.stringify({ backClick, backToList }));
  const listNow = await inFrame(listFrame(), "const r = await (await fetch('/api/canvases')).json(); const list = (r && r.canvases) || []; return { n: list.length, first: list[0] ? { id: list[0].id, title: list[0].title } : null, cards: document.querySelectorAll('#cardsGrid .project-card').length };");
  console.log("A10 list after save:", JSON.stringify(listNow));
  // A11 点当前这本的卡片再进编辑器（产品路径）
  const cardSel = "#cardsGrid .project-card[data-canvas-id=\"" + state.id + "\"]";
  const cardUp = await waitFor(async () => (await inFrame(listFrame(), "return !!document.querySelector(" + JSON.stringify(cardSel) + ");")) === true, 20000);
  const cardClick = cardUp ? await inFrame(listFrame(), "const el = document.querySelector(" + JSON.stringify(cardSel) + "); if (!el) return 'missing'; el.click(); return 'clicked';") : "missing";
  const reopened = await waitFor(() => !!canvasFrame(), 40000);
  const reopenedState = reopened ? await waitFor(async () => (await inFrame(canvasFrame(), "const s = window.__openarcCanvas ? window.__openarcCanvas.state() : null; return s ? { id: s.canvasId, nodes: s.nodeCount } : null;")) !== null, 20000) ? await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId, nodes: s.nodeCount };") : null : null;
  console.log("A11 reopen via card:", JSON.stringify({ cardSel, cardClick, reopened, reopenedState }));

  // A12 上传链诊断（本地 PNG → /api/ai/upload → 宿主导入资源库）
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=";
  const up = await inFrame(canvasFrame(), "const bytes = Uint8Array.from(atob('" + PNG + "'), c => c.charCodeAt(0)); const f = new File([bytes], 'd502-asset.png', { type: 'image/png' }); const fd = new FormData(); fd.append('files', f); const r = await fetch('/api/ai/upload', { method:'POST', body: fd }); const txt = await r.text(); return { status: r.status, text: txt.slice(0, 300), bridgeHasUpload: String(window.fetch).indexOf('readUploadFiles') >= 0 };");
  console.log("A12 upload:", JSON.stringify(up));
  const upNode = await inFrame(canvasFrame(), "const bytes = Uint8Array.from(atob('" + PNG + "'), c => c.charCodeAt(0)); const f = new File([bytes], 'd502-asset.png', { type: 'image/png' }); const fd = new FormData(); fd.append('files', f); const r = await fetch('/api/ai/upload', { method:'POST', body: fd }); const d = await r.json(); return { status: r.status, keys: Object.keys(d), files: (d.files||[]).length, first: d.files && d.files[0] ? { url: String(d.files[0].url).slice(0, 22), name: d.files[0].name } : null, msg: d.message || null };");
  console.log("A13 upload json:", JSON.stringify(upNode));

  console.log("logs:", JSON.stringify(logs.slice(0, 12)));
  const tail = stderrBuf.split("\n").filter((l) => /error|Error|拦截/.test(l)).slice(0, 8);
  console.log("stderr tail:", tail.join(" | ").slice(0, 1200));
}

let code = 0;
try { await main(); } catch (e) { console.error("SMOKE FAIL:", String((e && e.stack) || e)); code = 2; }
try { if (browser) await browser.close().catch(() => {}); } catch { /* ignore */ }
try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
try { spawnSync("pkill", ["-f", "oa-d502app-"], { stdio: "ignore" }); } catch { /* ignore */ }
process.exit(code);
