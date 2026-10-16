/**
 * DXOS-CANVAS-SIZE-POLICY · 真机验证（真实 Electron + 隔离 userData + 唯一 CDP 端口 + 本地桩 provider）。
 *
 * 验证三件事（全部走产品真实链路，不 mock 页面逻辑）：
 *   S1  画布编辑器里 GET /api/ai/size-policy 返回 200，页面 window.NovaSizePolicy 不再是 free 模式
 *       （gpt-image-2 = enum；未登记时页面恒为 free，见单测 B2 的对照）；
 *   S2  在画布 UI 里选 1:1 @1k → 真实出图：请求体的 size = 1024x1024（1:1），产物 PNG 的 IHDR 也是 1024x1024；
 *   S2b 同一 UI 走 custom 1:1 @1k（修复点）：请求 size = 1248x1248（修复前旧算法会给 1536x1248，非 1:1）；
 *   S3  gpt-image-2 的 4k 方图被策略吸附：请求 size = 2048x2048，不再是 4096x4096。
 *   d   0 console error / 0 pageerror / 0 个 404
 *   收工：真实 profile 只读快照前后比对；杀子进程 + 删隔离 userData。
 *
 * 用法：node experiments/dxos-canvas-size-policy/real-device-size-policy.mjs
 * 产物：artifacts/dxos-canvas-size-policy/{RESULT.json,shots/*.png}
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { startSizePolicyProvider, pngDimsFromDataUrl } from "./provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-size-policy");
const SHOTS = path.join(ART, "shots");
const CDP_PORT = Number(process.env.OA_SIZE_POLICY_CDP_PORT || 9856);
const ADMIN = { id: "admin@oa-sizepolicy.test", pw: "oa-sizepolicy-1" };
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
const canvasFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas\.html/);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 300) }; }
}

async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-size-policy-"));
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
    await setInput('[data-d3-id="setup-name"]', "OA Size Policy Admin"); await next();
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

/** 读生成器节点的运行态 + 第一张产物的真实像素（在页面里用 Image 解码，避免传大 data URL）。*/
async function generatorState() {
  return await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_gen'); if(!n) return null; const raw = (n.generatedOutputs||[])[0]; const url = typeof raw === 'string' ? raw : ((raw && raw.url) || ''); if(!url) return { status:n.runStatus, error:n.runError||'', model:n.model, resolution:n.resolution, ratio:n.ratio, outputs:(n.generatedOutputs||[]).length, pixels:null }; return await new Promise(function(resolve){ const img = new Image(); img.onload=function(){ resolve({ status:n.runStatus, error:n.runError||'', model:n.model, resolution:n.resolution, ratio:n.ratio, outputs:(n.generatedOutputs||[]).length, pixels:{ w:img.naturalWidth, h:img.naturalHeight } }); }; img.onerror=function(){ resolve({ status:n.runStatus, error:n.runError||'', model:n.model, resolution:n.resolution, ratio:n.ratio, outputs:(n.generatedOutputs||[]).length, pixels:null }); }; img.src = url; });");
}
async function runGeneratorOnce() {
  await provider.reset();
  await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); n.runStatus=''; n.runError=''; n.generatedOutputs=[]; return true;");
  await inFrame(canvasFrame(), "window.__openarcCanvas.runNode('n_gen'); return { started: true };");
  let state = null;
  const finished = await waitFor(async () => {
    const s = await generatorState();
    if (s && (s.status === "done" || s.status === "failed")) { state = s; return true; }
    return false;
  }, 90000);
  await sleep(600);
  return { finished, state, provider: provider.state() };
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const realProfile = realProfilePath();
  const profileBefore = snapshotProfile(realProfile);
  provider = await startSizePolicyProvider();
  await launch();
  await login();
  check("a0 · 真实 electron . 启动 + 登录（隔离 userData + CDP " + CDP_PORT + "）", (await gate()) === "ready", "ready", await gate());

  const prov = await model({ type: "provider/create", displayName: "OA Size Policy Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "oa-size-policy-secret" });
  const providerId = prov && prov.provider && prov.provider.providerId;
  const flux = await model({ type: "model/create", providerId, remoteModelId: "flux-pro", displayName: "OA Size Policy Flux", capabilities: ["image-generation"], scope: "ORGANIZATION" });
  const gpt = await model({ type: "model/create", providerId, remoteModelId: "gpt-image-2", displayName: "OA Size Policy GPT Image 2", capabilities: ["image-generation"], scope: "ORGANIZATION" });
  await model({ type: "defaults/set", capability: "image-generation", configId: flux && flux.model && flux.model.configId });
  check("a1 · 本地确定性 provider + flux-pro / gpt-image-2 两个生图模型已登记", !!providerId && !!(flux && flux.model) && !!(gpt && gpt.model), "providerId + 两个模型", { providerId, flux: !!(flux && flux.model), gpt: !!(gpt && gpt.model) });

  await openAppWindow();
  const listUp = await waitFor(() => !!listFrame(), 25000);
  await waitFor(async () => (await inFrame(listFrame(), "return document.readyState === 'complete' && !!(document.getElementById('btnNewProject') || document.getElementById('btnStartCreate'));")) === true, 25000);
  const newClick = await inFrame(listFrame(), "const el = document.getElementById('btnNewProject') || document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';");
  const editorUp = await waitFor(() => !!canvasFrame(), 45000);
  const adapterUp = await waitFor(async () => (await inFrame(canvasFrame(), "return typeof window.__openarcCanvas === 'object' && typeof window.__openarcCanvasInternals === 'object';")).toString() === "true", 30000);
  check("a2 · 打开画布应用 → 列表页 → 新建画布进入编辑器（适配层就绪）", listUp && newClick === "clicked" && editorUp && adapterUp, "canvas.html + __openarcCanvas", { listUp, newClick, editorUp, adapterUp });

  /* ───────────── S1 · 策略端点 + 页面不再是 free 模式 ───────────── */
  const policy = await inFrame(canvasFrame(), "const r = await fetch('/api/ai/size-policy'); const body = await r.json(); const nova = window.NovaSizePolicy; return { status: r.status, format: body.format, modelKeys: Object.keys(body.models||{}).sort(), defaultMode: (body.default||{}).mode, gptMode: nova.policy('gpt-image-2').mode, gptIsEnum: nova.isEnum('gpt-image-2'), gptOptions: nova.enumOptions('gpt-image-2'), fluxMode: nova.policy('flux-pro').mode, gptMaxEdge: nova.policy('gpt-image-2').maxEdge, constrain4096: nova.constrain('4096x4096','gpt-image-2') };");
  check("S1 · GET /api/ai/size-policy 200 + 页面 NovaSizePolicy 不再是 free（gpt-image-2 = enum，4k 方图吸附成 2048x2048）",
    policy.status === 200 && policy.format === "novai-size-policy/v1" && policy.gptMode === "enum" && policy.gptIsEnum === true && policy.fluxMode === "free" && Array.isArray(policy.gptOptions) && policy.gptOptions.length === 8 && policy.constrain4096 === "2048x2048",
    "200 + gpt enum + flux free + 4096→2048",
    policy);

  /* ───────────── 节点：提示词 → 生成器 ───────────── */
  await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_prompt', type:'prompt', x:80, y:120, text:'尺寸策略真机：方形图' } }, null);");
  await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_gen', type:'generator', x:120, y:420, count:1 } }, null);");
  await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_prompt', to:'n_gen' }, null);");
  const cfgInfo = await inFrame(canvasFrame(), "const cfg = await (await fetch('/api/config')).json(); const prov = (cfg.api_providers||[]).find(function(p){ return (p.image_models||[]).indexOf('flux-pro') >= 0; }) || (cfg.api_providers||[])[0]; const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); n.model = 'flux-pro'; n.apiProvider = prov.id; it.primitives.render(); return { provider: prov.id, model: n.model, imageModels: cfg.image_models };");
  await sleep(1200);
  check("a3 · 生成器节点就位并指向 OpenArc provider + flux-pro", cfgInfo.model === "flux-pro" && !!cfgInfo.provider, "flux-pro", cfgInfo);

  /* ───────────── S2 · UI 选 1:1 @1k → 真实出图 ───────────── */
  const ui1 = await inFrame(canvasFrame(), "const node = document.querySelector('.node[data-id=\"n_gen\"]'); if(!node) return { error:'no-node' }; const ratio = node.querySelector('.generator-body .ratio'); const res = node.querySelector('.generator-body .resolution'); if(!ratio || !res) return { error:'no-controls' }; ratio.value='square'; ratio.dispatchEvent(new Event('change',{bubbles:true})); res.value='1k'; res.dispatchEvent(new Event('change',{bubbles:true})); const n = window.__openarcCanvasInternals.primitives.getNode('n_gen'); return { ratioUi:ratio.value, resUi:res.value, ratio:n.ratio, resolution:n.resolution };");
  const run1 = await runGeneratorOnce();
  const shot1 = await shot("s2-square-1k");
  const img1 = run1.provider.images[0] || null;
  check("S2 · 画布 UI 选 1:1 @1k → 真实出图：请求 size = 1024x1024，产物像素 = 1024x1024",
    ui1.ratio === "square" && ui1.resolution === "1k" && run1.finished && run1.state && run1.state.status === "done" && !!img1 && img1.size === "1024x1024" && img1.width === 1024 && img1.height === 1024 && run1.state.pixels && run1.state.pixels.w === 1024 && run1.state.pixels.h === 1024,
    "size=1024x1024，产物 1024x1024",
    { ui1, run: run1.state, request: img1, shot: shot1 });

  /* ───────────── S2b · UI 选 custom 1:1 @1k（修复点）───────────── */
  const ui2b = await inFrame(canvasFrame(), "const node = document.querySelector('.node[data-id=\"n_gen\"]'); const ratio = node.querySelector('.generator-body .ratio'); ratio.value='custom'; ratio.dispatchEvent(new Event('change',{bubbles:true})); const w = node.querySelector('.custom-ratio-w-input'); const h = node.querySelector('.custom-ratio-h-input'); w.value='1'; w.dispatchEvent(new Event('input',{bubbles:true})); h.value='1'; h.dispatchEvent(new Event('input',{bubbles:true})); const n = window.__openarcCanvasInternals.primitives.getNode('n_gen'); return { ratio:n.ratio, customRatio:n.customRatio, resolution:n.resolution };");
  const run2 = await runGeneratorOnce();
  const shot2 = await shot("s2b-custom-1to1-1k");
  const img2 = run2.provider.images[0] || null;
  check("S2b · UI 选 custom 1:1 @1k（修复点）：请求 size = 1248x1248（1:1），产物像素 1248x1248；修复前旧算法会给 1536x1248",
    ui2b.ratio === "custom" && ui2b.customRatio === "1:1" && run2.finished && run2.state && run2.state.status === "done" && !!img2 && img2.size === "1248x1248" && run2.state.pixels && run2.state.pixels.w === 1248 && run2.state.pixels.h === 1248,
    "size=1248x1248，产物 1248x1248",
    { ui2b, run: run2.state, request: img2, shot: shot2 });

  /* ───────────── S3 · gpt-image-2 的 4k 方图被吸附 ───────────── */
  const ui3 = await inFrame(canvasFrame(), "const node = document.querySelector('.node[data-id=\"n_gen\"]'); const modelSel = node.querySelector('.generator-body .model-select'); const res = node.querySelector('.generator-body .resolution'); modelSel.value='gpt-image-2'; modelSel.dispatchEvent(new Event('change',{bubbles:true})); const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_gen'); const option4k = (function(){ const o = res.querySelector('option[value=\"4k\"]'); return o ? { text:o.textContent, disabled:o.disabled, title:o.title } : null; })(); let viaUi = false; try { res.value='4k'; res.dispatchEvent(new Event('change',{bubbles:true})); viaUi = n.resolution === '4k'; } catch(e) { viaUi = false; } if(!viaUi){ n.resolution='4k'; n._apiResolutionUserSet=true; } const n2 = it.primitives.getNode('n_gen'); return { model:n2.model, viaUi, resolution:n2.resolution, ratio:n2.ratio, option4k, sizeOption: { value:res.value } };");
  const run3 = await runGeneratorOnce();
  const shot3 = await shot("s3-gpt-4k-square");
  const img3 = run3.provider.images[0] || null;
  check("S3 · gpt-image-2 的 4k 方图被策略吸附：请求 size = 2048x2048，不再是 4096x4096（UI 把 4K 标成「等同 2K」）",
    run3.finished && run3.state && run3.state.status === "done" && !!img3 && img3.size === "2048x2048" && img3.size !== "4096x4096" && run3.state.pixels && run3.state.pixels.w === 2048 && run3.state.pixels.h === 2048,
    "size=2048x2048",
    { ui3, run: run3.state, request: img3, shot: shot3 });

  /* ───────────── d · 边界回归 ───────────── */
  const boundary = await inFrame(canvasFrame(), "const probe = async function(url, init){ try { const r = await fetch(url, init||{}); let j=null; try { j = await r.json(); } catch(e){} return { status:r.status, error:(j&&j.error)||null }; } catch(e){ return { thrown:String((e&&e.message)||e) }; } }; return { agent: await probe('/api/agent/plan', {method:'POST', body:'{}'}), egress: await probe('https://example.com/steal'), update: await probe('/api/check-update') };");
  check("d1 · 白名单/出网未放宽：/api/agent/* 仍 501、出网仍拒、更新仍禁用",
    boundary.agent && boundary.agent.status === 501 && boundary.agent.error === "OPENARC_UNSUPPORTED" && boundary.egress && boundary.egress.error === "OPENARC_EGRESS_BLOCKED" && boundary.update && boundary.update.error === "OPENARC_UPDATE_DISABLED",
    "501 + EGRESS_BLOCKED + UPDATE_DISABLED", boundary);
  const notFound = netFailures.filter((f) => f.status === 404);
  const serverErrors = netFailures.filter((f) => f.status >= 500);
  check("d2 · 0 个 404 / 0 个 5xx / 0 console error / 0 pageerror", notFound.length === 0 && serverErrors.length === 0 && consoleErrors.length === 0 && pageErrors.length === 0,
    "0 / 0 / 0 / 0", { notFound: notFound.slice(0, 6), serverErrors: serverErrors.slice(0, 6), consoleErrors: consoleErrors.slice(0, 6), pageErrors: pageErrors.slice(0, 6) });

  await sleep(1200);

  const result = {
    ok: failed === 0, cdpPort: CDP_PORT, providerId,
    models: { flux: flux && flux.model, gpt: gpt && gpt.model },
    policy,
    s2: { ui: ui1, run: run1.state, request: img1, shot: shot1 },
    s2b: { ui: ui2b, run: run2.state, request: img2, shot: shot2 },
    s3: { ui: ui3, run: run3.state, request: img3, shot: shot3 },
    boundary, checks, consoleErrors, pageErrors, notFound, serverErrors,
    shots: { s2: shot1, s2b: shot2, s3: shot3 },
  };
  fs.writeFileSync(path.join(ART, "RESULT.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("\n==== 截图 ====");
  for (const v of [shot1, shot2, shot3]) console.log("  " + v);

  try { await browser.close(); } catch { /* ignore */ }
  browser = null;
  if (child && !child.killed) { child.kill("SIGTERM"); await sleep(1200); try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (provider) await provider.close().catch(() => {});
  try { if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* ignore */ }
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
  try { if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* ignore */ }
  process.exitCode = 2;
});
