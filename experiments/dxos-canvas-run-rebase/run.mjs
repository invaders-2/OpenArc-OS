/**
 * DXOS-CANVAS-RUN-REBASE · 真机复现/验收探针（真实 Electron + 真实画布页生图链 + 延迟桩 provider）。
 *
 * 复现的时序缺陷：
 *   画布页 runGenerator 在 POST /api/canvas-image-tasks 之后，会把「pending 卡片」scheduleSave + saveCanvas
 *   落盘 → 画布 revision 在模型返回之前前进；修复前 electron/canvas-service.cjs 的 modelCall 用整画布
 *   run.base_revision 判定，发现 revision 已变 → CANVAS_CHANGED，结果被丢弃（静默丢图）。
 *
 * 两段证据：
 *   [host-chain]  直接走宿主命令链 canvas/run → (期间编辑别的节点推进 revision) → canvas/modelImage：
 *                 修复前返回 CANVAS_CHANGED；修复后返回 ok（run.node_id 定向写回）。
 *   [page-chain]  走画布页自己的生图链：window.__openarcCanvas.runNode('n_gen')：
 *                 修复前 generator 节点 runStatus=failed / 输出节点 0 图；修复后 done / 输出节点有图（截图）。
 *
 * 用法：
 *   node experiments/dxos-canvas-run-rebase/run.mjs --expect=red     # 修复前：应观察到丢图
 *   node experiments/dxos-canvas-run-rebase/run.mjs --expect=green   # 修复后：应观察到结果写入
 * 中间产物：artifacts/dxos-canvas-run-rebase/{RESULT.json,shots/*.png}
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startDelayedCanvasProvider } from "./delayed-canvas-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-run-rebase");
const SHOTS = path.join(ART, "shots");
const CDP_PORT = Number(process.env.OA_REBASE_CDP_PORT || 9833);
const ARG = (name, dflt) => { const hit = process.argv.find((a) => a.startsWith("--" + name + "=")); return hit ? hit.slice(name.length + 3) : dflt; };
const EXPECT = String(ARG("expect", "green"));
const DELAY_MS = Number(ARG("delay", "4000"));
const ADMIN = { id: "admin@dxos-rebase.test", pw: "rebase-admin-1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const record = (name, ok, expected, actual) => {
  checks.push({ name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: typeof actual === "string" ? actual : JSON.stringify(actual) });
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + name + (ok ? "" : " — 期望 " + expected + "，实际 " + JSON.stringify(actual)));
  return ok;
};

let child = null, browser = null, page = null, provider = null, userDataDir = null;
const consoleErrors = [], pageErrors = [], dialogs = [];
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-rebase-"));
  // DSH/CI 会话可能带着 ELECTRON_RUN_AS_NODE=1：那会让 Electron 以 Node 模式跑 main.cjs（app 为 undefined）。
  // 真机探针必须清掉它。
  const childEnv = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  let childErr = "";
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + CDP_PORT, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { childErr += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪；electron stderr: " + childErr.slice(-1500));
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  const isUi = (p) => { const u = p.url(); return u.includes("/dist/") && (u.endsWith("vue.html") || u.endsWith("index.html")) && !u.includes("devtools"); };
  while (!page && Date.now() < end) { page = ctx.pages().find(isUi) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面；已见页面：" + ctx.pages().map((p) => p.url()).join(" | ").slice(0, 1200));
  page.on("dialog", (d) => { dialogs.push(String(d.message()).slice(0, 200)); void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push({ url: String((m.location() || {}).url || "").slice(0, 120), text: m.text().slice(0, 300) }); });
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
}

async function openAppWindow() {
  // 当前工作树默认是 Vue 壳 dist/vue.html（程序坞里是 data-dock-id=canvas）；React 壳两种 aria-label 也接受。
  await js("const el = document.querySelector('[data-dock-id=\"canvas\"]') || document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]'); if (el) el.click(); return !!el;");
  return await waitFor(() => has("[data-canvas-host]"), 20000);
}
async function login() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const next = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "DXOS Rebase Admin"); await next();
    await waitSel('[data-d3-id="setup-identifier"]', 10000); await setInput('[data-d3-id="setup-identifier"]', ADMIN.id); await next();
    await waitSel('[data-d3-id="setup-password"]', 10000); await setInput('[data-d3-id="setup-password"]', ADMIN.pw); await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  await waitSel('[data-d3-id="login-identifier"]', 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  return waitFor(async () => (await gate()) === "ready", 60000);
}
async function shot(name) { fs.mkdirSync(SHOTS, { recursive: true }); const p = path.join(SHOTS, name + ".png"); await page.screenshot({ path: p }).catch(() => {}); return path.relative(ROOT, p); }

/* 画布 revision：从宿主真值读（canvas/get），避免只信页面内存。 */
async function revisionOf(canvasId) { const r = await canvas({ type: "canvas/get", canvasId }); return r && r.ok ? Number(r.canvas.revision) : null; }
async function docOf(canvasId) { const r = await canvas({ type: "canvas/get", canvasId }); return r && r.ok ? r.canvas.doc : null; }
function startRevisionWatch(canvasId) {
  const samples = [];
  let stopped = false;
  (async () => {
    while (!stopped) {
      try { samples.push({ at: Date.now(), revision: await revisionOf(canvasId) }); } catch { /* ignore */ }
      await sleep(150);
    }
  })();
  return { stop: () => { stopped = true; }, samples };
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  provider = await startDelayedCanvasProvider({ delayMs: DELAY_MS });
  await launch();
  const loggedIn = await login();
  await openAppWindow();
  const listUp = await waitFor(() => !!listFrame(), 25000);
  // 列表页按钮是页面 JS 渲染出来的：等 readyState + 按钮出现再点（否则会报 missing）。
  await waitFor(async () => (await inFrame(listFrame(), "return document.readyState === 'complete' && !!(document.getElementById('btnNewProject') || document.getElementById('btnStartCreate'));")) === true, 25000);
  const newClick = await inFrame(listFrame(), "const el = document.getElementById('btnNewProject') || document.getElementById('btnStartCreate'); if (!el) return { clicked: 'missing', ids: Array.from(document.querySelectorAll('button[id]')).map(function (b) { return b.id; }).slice(0, 24), title: document.title, ready: document.readyState }; el.click(); return { clicked: 'clicked', id: el.id };");
  const editorUp = await waitFor(() => !!canvasFrame(), 40000);
  const adapterUp = await waitFor(async () => (await inFrame(canvasFrame(), "return { i: typeof window.__openarcCanvasInternals };")).i === "object", 30000);
  await waitFor(async () => { const st = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };"); return !!(st && st.id); }, 30000);
  const state0 = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };");
  const canvasId = state0.id || null;
  record("a · 真实 Electron 启动 + 登录 + 新建画布进入编辑器", loggedIn && listUp && newClick && newClick.clicked === "clicked" && editorUp && adapterUp && !!canvasId, "编辑器就绪 + canvasId", { loggedIn, listUp, newClick, editorUp, adapterUp, canvasId });

  /* 模型：延迟桩 provider（LOCALHOST）+ chat/image 两个能力 + 默认值 */
  const prov = await model({ type: "provider/create", displayName: "DXOS Rebase Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "dxos-rebase-secret" });
  const providerId = prov && prov.provider && prov.provider.providerId;
  const cm = await model({ type: "model/create", providerId, remoteModelId: "rebase-chat", displayName: "DXOS Rebase Chat", capabilities: ["chat"], scope: "ORGANIZATION" });
  const im = await model({ type: "model/create", providerId, remoteModelId: "rebase-image", displayName: "DXOS Rebase Image", capabilities: ["image-generation"], scope: "ORGANIZATION" });
  await model({ type: "defaults/set", capability: "chat", configId: cm && cm.model && cm.model.configId });
  await model({ type: "defaults/set", capability: "image-generation", configId: im && im.model && im.model.configId });
  record("b · 延迟桩 provider + chat/image 模型 + 默认值已登记", !!providerId && !!cm && !!im, "providerId + 两个模型", { providerId: !!providerId, chat: !!(cm && cm.model), image: !!(im && im.model) });

  /* 画布节点：提示词 → 生成器 */
  await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_prompt', type:'prompt', x:80, y:120, text:'一只在雨里的猫' } }, null);");
  await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_gen', type:'generator', x:120, y:420, count:1 } }, null);");
  await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_gen' }, null);");
  await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); const cfg = await (await fetch('/api/config')).json(); n.model = cfg.image_models[0]; n.apiProvider = 'openarc'; it.primitives.render(); it.getState(); window.__openarcCanvasInternals.primitives.sanitizeConnections(); return { model: n.model };");
  // 等画布把节点落库（revision 稳定）
  let lastRev = -1;
  for (let i = 0; i < 40; i += 1) { const rev = await revisionOf(canvasId); if (rev === lastRev && rev != null) break; lastRev = rev; await sleep(250); }
  await sleep(800);

  /* ───────────── [host-chain] 宿主命令链：期间编辑别的节点推进 revision ───────────── */
  const hostRun = await canvas({ type: "canvas/run", canvasId, kind: "image", nodeId: "n_gen" });
  const hostBase = hostRun && hostRun.ok ? Number(hostRun.baseRevision) : null;
  // 模拟"画布在生成期间 revision 前进"（这里编辑的是别的节点 n_prompt）
  await sleep(600);
  await canvas({ type: "canvas/command", canvasId, baseRevision: await revisionOf(canvasId), command: { type: "node.edit", id: "n_prompt", patch: { text: "一只在雨里的猫（宿主链期间编辑别的节点）" } } });
  const hostRevAfter = await revisionOf(canvasId);
  const hostRes = hostRun && hostRun.ok ? await canvas({ type: "canvas/modelImage", canvasId, runId: hostRun.runId, prompt: "宿主链：一只在雨里的猫", size: "1024x1024" }) : { ok: false, error: "RUN_NOT_STARTED" };
  if (hostRun && hostRun.ok) await canvas({ type: "canvas/runFinish", canvasId, runId: hostRun.runId, status: hostRes && hostRes.ok ? "DONE" : "FAILED" });
  const hostRuns = await canvas({ type: "canvas/runs", canvasId, limit: 10 });
  const hostRunRow = hostRuns && hostRuns.ok ? (hostRuns.items || []).find((r) => r.runId === hostRun.runId) : null;
  record("c · [宿主命令链] 编辑别的节点推进 revision 后，modelImage 结果写回（修复后应为 ok；修复前为 CANVAS_CHANGED）",
    EXPECT === "red" ? (hostRes && hostRes.error === "CANVAS_CHANGED" || hostRes && hostRes.ok === false) : !!(hostRes && hostRes.ok && (hostRes.images || []).length >= 1),
    EXPECT === "red" ? "CANVAS_CHANGED（丢结果）" : "ok + images",
    { baseRevision: hostBase, revisionAfterEdit: hostRevAfter, result: hostRes && (hostRes.ok ? { ok: true, images: (hostRes.images || []).length, run: hostRes.run || null } : { ok: false, error: hostRes.error, detail: hostRes.detail || null }), runRow: hostRunRow });

  /* ───────────── [page-chain] 画布页自己的生图链 ───────────── */
  // 复位：清掉 n_gen 的运行痕迹（宿主链没写节点，这里只是稳妥）
  await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); n.runStatus=''; n.runError=''; n.generatedOutputs=[]; it.primitives.render(); return true;");
  const genReset = await canvas({ type: "canvas/command", canvasId, baseRevision: await revisionOf(canvasId), command: { type: "node.edit", id: "n_gen", patch: { runStatus: "", runError: "" } } });
  const revBeforePageRun = await revisionOf(canvasId);
  const watch = startRevisionWatch(canvasId);
  const triggered = await inFrame(canvasFrame(), "window.__openarcCanvas.runNode('n_gen'); return { started: true };");
  // 等页面把 pending 卡片落盘（revision 前进）
  const advanced = await waitFor(async () => (await revisionOf(canvasId)) > revBeforePageRun, 15000);
  const revDuringRun = await revisionOf(canvasId);
  // 等结果回来：generator 进入 done/failed
  let genState = null;
  const finished = await waitFor(async () => {
    const s = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); return n ? { status: n.runStatus, error: n.runError || '', generated: (n.generatedOutputs||[]).length } : null;");
    if (s && (s.status === "done" || s.status === "failed")) { genState = s; return true; }
    return false;
  }, 60000);
  const revAfterRun = await revisionOf(canvasId);
  await sleep(1200); // 让页面把结果 scheduleSave 落盘
  watch.stop();
  const pageDoc = await docOf(canvasId);
  const outNode = pageDoc ? (pageDoc.nodes || []).find((n) => n.type === "output") : null;
  const outImages = outNode ? (outNode.images || []).length : 0;
  const genNode = pageDoc ? (pageDoc.nodes || []).find((n) => n.id === "n_gen") : null;
  const pageRuns = await canvas({ type: "canvas/runs", canvasId, limit: 10 });
  const pageRunRows = pageRuns && pageRuns.ok ? (pageRuns.items || []) : [];
  const shotPage = await shot("page-chain-" + EXPECT);
  const pstate = provider.state();

  const revisionSeq = watch.samples.filter((s, i, a) => i === 0 || s.revision !== a[i - 1].revision).map((s) => s.revision);

  if (EXPECT === "red") {
    record("d · [画布页生图链] 修复前：pending 落盘推进 revision → 结果被丢弃（runStatus=failed / 输出节点 0 图）",
      triggered && triggered.started === true && advanced && finished && !!genState && genState.status === "failed" && outImages === 0,
      "failed + 输出节点 0 图 + revision 在 run 期间前进",
      { triggered, advanced, revBeforePageRun, revDuringRun, revAfterRun, revisionSeq, genState, outImages, pageRunRows: pageRunRows.map((r) => ({ status: r.status, stopReason: r.stopReason, baseRevision: r.baseRevision, nodeId: r.nodeId })), dialogs: dialogs.slice(-4) });
  } else {
    record("d · [画布页生图链] 修复后：结果真实写入目标节点/输出节点，页面能看到图",
      triggered && triggered.started === true && advanced && finished && !!genState && genState.status === "done" && outImages >= 1 && pstate.images.length >= 1,
      "done + 输出节点有图 + pending 落盘仍发生",
      { triggered, advanced, revBeforePageRun, revDuringRun, revAfterRun, revisionSeq, genState, outImages, outNode: outNode ? { id: outNode.id, images: (outNode.images || []).length } : null, genNode: genNode ? { id: genNode.id, model: genNode.model, runStatus: genNode.runStatus } : null, pageRunRows: pageRunRows.map((r) => ({ status: r.status, stopReason: r.stopReason, baseRevision: r.baseRevision, nodeId: r.nodeId })), providerImages: pstate.images.length, shot: shotPage });
  }

  record("e · 0 console error / 0 pageerror", consoleErrors.length === 0 && pageErrors.length === 0, "0 / 0", { consoleErrors: consoleErrors.slice(0, 6), pageErrors: pageErrors.slice(0, 6) });

  const failedCount = checks.filter((c) => c.status === "FAIL").length;
  const result = { expect: EXPECT, ok: failedCount === 0, canvasId, delayMs: DELAY_MS, revisionSeq, checks, consoleErrors, pageErrors, dialogs, shots: { page: shotPage }, provider: { images: pstate.images.length, chats: pstate.chats.length, authSeen: pstate.authSeen } };
  fs.writeFileSync(path.join(ART, "RESULT-" + EXPECT + ".json"), JSON.stringify(result, null, 2) + "\n");
  console.log("\n==== 汇总（" + EXPECT + "）：PASS " + checks.filter((c) => c.status === "PASS").length + " / FAIL " + failedCount + " ====");
  console.log("截图：" + shotPage);
  process.exitCode = result.ok ? 0 : 1;

  try { await browser.close(); } catch { /* ignore */ }
  browser = null;
  if (child && !child.killed) { child.kill("SIGTERM"); await sleep(1200); try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (provider) await provider.close().catch(() => {});
  try { if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 进程刚退出，目录稍后由系统清理 */ }
}

main().catch(async (e) => {
  console.error("探针异常：" + String((e && e.stack) || e));
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  if (child && !child.killed) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (provider) await provider.close().catch(() => {});
  try { if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* ignore */ }
  process.exitCode = 2;
});
