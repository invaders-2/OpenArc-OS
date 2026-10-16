#!/usr/bin/env node
/**
 * dxos-relay-image · 画布出图定位探针。
 *
 * 事实：页面自身生成链（点 ▶ → /api/canvas-image-tasks → 宿主 canvas/run + canvas/modelImage）
 * 在真实慢模型下必然失败：canvas.js:10222-10223 在 POST 之后落盘 pending 卡片，
 * 画布 revision 前进，而 canvas-service 以 run.base_revision 判定，返回 CANVAS_CHANGED
 * （主探针 V1/V2 已记录 revision 2→4）。本探针只做两件事：
 *   1) 直接驱动**画布生成命令**（canvas/run → canvas/modelImage → canvas/runFinish），
 *      验证命令链本身能拿到真实图片；
 *   2) 把真实结果放回画布节点并截图（探针级放置，不改产品代码）。
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startRelay, loadToken, scrubText } from "./relay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ART = path.join(ROOT, "artifacts", "dxos-relay-image");
const SHOTS = path.join(ART, "shots");
const MEDIA = path.join(ART, "media");
const SHOT = { width: 1440, height: 900, dsf: 2 };
const IMAGE_MODEL = "gemini-3.1-flash-image";
const PROMPT = "a single red apple on a clean white table, soft daylight, product photo";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs, stepMs = 250) => { const end = Date.now() + timeoutMs; for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() >= end) return false; await sleep(stepMs); } };
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function imageInfo(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2; while (off + 9 < buf.length) { if (buf[off] !== 0xff) { off += 1; continue; } const m = buf[off + 1]; if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { off += 2; continue; } const len = buf.readUInt16BE(off + 2); const sof = (m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf); if (sof) return { format: "jpeg", width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) }; off += 2 + len; }
    return { format: "jpeg", width: null, height: null };
  }
  return { format: "unknown", width: null, height: null };
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
  const require = createRequire(path.join(ROOT, "package.json"));
  const chromium = require("@playwright/test").chromium;
  const electronPath = require("electron");
  const token = loadToken();
  const relay = await startRelay({ token });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-relay-canvas-"));
  const port = await freePort();
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  let child = null, browser = null, page = null;
  const out = { relay: relay.baseUrl, at: new Date().toISOString() };
  try {
    child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + port], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
    await waitFor(async () => { try { return (await fetch("http://127.0.0.1:" + port + "/json/version")).ok; } catch { return false; } }, 90000, 300);
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const ctx = browser.contexts()[0];
    await waitFor(() => !!ctx.pages().find((p) => p.url().includes("vue.html")), 45000, 300);
    page = ctx.pages().find((p) => p.url().includes("vue.html"));
    const s = await page.context().newCDPSession(page);
    await s.send("Emulation.setDeviceMetricsOverride", { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.dsf, mobile: false });
    await waitFor(async () => !!(await page.evaluate(() => window.openarc)), 45000, 300);
    await page.evaluate(() => { const d = document.querySelector(".desktop"); return d && d.getAttribute("data-identity-gate"); });
    const call = async (channel, command, payload) => ({ result: await page.evaluate(async (a) => { const api = window.openarc[a.channel]; return api ? api.command(a.channel === "identity" ? Object.assign({ type: a.command }, a.payload) : { command: a.command, payload: a.payload }) : { __noBridge: true }; }, { channel, command, payload: payload || {} }) });
    await page.evaluate(async () => { await window.openarc.identity.command({ type: "identity/initialize", identifier: "relay-canvas@openarc.test", password: "RelayCanvas-1", displayName: "画布定位探针" }); });
    await page.evaluate(async () => { await window.openarc.identity.command({ type: "identity/login", identifier: "relay-canvas@openarc.test", password: "RelayCanvas-1" }); });
    await waitFor(async () => (await page.evaluate(() => { const d = document.querySelector(".desktop"); return d ? d.getAttribute("data-identity-gate") : null; })) === "ready", 30000, 200);

    const create = (await call("model", "provider/create", { displayName: "Sub2API Relay", baseUrl: relay.baseUrl, adapterType: "openai-compatible", endpointScope: "LOCALHOST", scope: "PERSONAL" })).result;
    const providerId = create.provider.providerId;
    await call("model", "credential/set", { providerId, secret: token });
    const mImage = (await call("model", "model/create", { providerId, remoteModelId: IMAGE_MODEL, displayName: "Sub2API Image", capabilities: ["image-generation"], scope: "PERSONAL" })).result;
    const configId = mImage.model.configId;
    await call("model", "defaults/set", { capability: "image-generation", configId, scope: "PERSONAL" });
    out.providerId = providerId; out.configId = configId;

    // 打开画布
    await page.evaluate(() => { const d = document.querySelector(".dock"); if (d) d.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true })); });
    await page.evaluate(() => { const el = document.querySelector('.dock-item[data-dock-id="canvas"]'); if (el) el.click(); });
    await waitFor(async () => !!(await page.$("[data-canvas-frame]")), 45000, 400);
    const listFrame = () => page.frames().find((f) => /openarc-canvas:\/\/bundle\/static\/canvas-list\.html/.test(f.url())) || null;
    const canvasFrame = () => page.frames().find((f) => /openarc-canvas:\/\/bundle\/static\/canvas\.html/.test(f.url())) || null;
    const inFrame = async (f, code) => { if (!f) return { __noFrame: true }; try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); } catch (e) { return { __error: String((e && e.message) || e).slice(0, 300) }; } };
    await waitFor(() => !!listFrame(), 45000, 500);
    await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate') || document.getElementById('btnNewProject'); if (!el) return 'missing'; el.click(); return 'clicked';");
    await waitFor(() => !!canvasFrame(), 45000, 500);
    await waitFor(async () => (await inFrame(canvasFrame(), "return typeof window.__openarcCanvasInternals;")) === "object", 30000, 300);
    await sleep(1500);
    const st0 = await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };");
    const canvasId = st0.id; out.canvasId = canvasId;

    await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_relay_prompt', type:'prompt', x:80, y:120, text:" + JSON.stringify(PROMPT) + " } }, null);");
    const addGen = await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_relay_gen', type:'generator', x:520, y:120, count:1 } }, null);");
    await inFrame(canvasFrame(), "return await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_relay_prompt', to:'n_relay_gen' }, null);");
    const runSet = await inFrame(canvasFrame(), "const it = window.__openarcCanvasInternals; const n = it.primitives.getNode('n_relay_gen'); const cfg = await (await fetch('/api/config')).json(); n.model = cfg.image_models[0]; n.apiProvider='openarc'; it.primitives.render(); return { model: n.model, imageModels: cfg.image_models };");
    out.addGen = addGen; out.runSet = runSet;
    await sleep(2500);

    const revBefore = (await call("canvas", "canvas/get", { canvasId })).result;
    out.revisionBeforeRun = revBefore && (revBefore.revision != null ? revBefore.revision : (revBefore.canvas && revBefore.canvas.revision));

    const t0 = Date.now();
    const run = (await call("canvas", "canvas/run", { canvasId, kind: "image", nodeId: "n_relay_gen" })).result;
    out.run = run;
    const runId = run && (run.runId || (run.run && run.run.runId));
    let modelImage = null;
    if (runId) modelImage = (await call("canvas", "canvas/modelImage", { canvasId, runId, prompt: PROMPT, size: "1024x1024", count: 1, configId })).result;
    out.modelImage = modelImage ? { ok: modelImage.ok, error: modelImage.error, imageCount: (modelImage.images || []).length, ms: Date.now() - t0 } : null;
    if (runId) await call("canvas", "canvas/runFinish", { canvasId, runId, status: modelImage && modelImage.ok ? "DONE" : "FAILED" });
    out.runMs = Date.now() - t0;

    const first = modelImage && modelImage.images && modelImage.images[0];
    const url = first && (first.dataUrl || first.url);
    if (url && url.startsWith("data:image/")) {
      const buf = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
      const info = imageInfo(buf);
      const ext = info.format === "jpeg" ? "jpg" : info.format === "png" ? "png" : "bin";
      const file = path.join(MEDIA, "canvas-host-image." + ext);
      fs.writeFileSync(file, buf);
      out.file = { path: path.relative(ROOT, file), bytes: buf.length, sha256: sha256(buf), ...info };
    }
    out.placement = await inFrame(canvasFrame(), [
      "const it = window.__openarcCanvasInternals;",
      "const url = " + JSON.stringify(url || "") + ";",
      "if(!url) return { placed:false, why:'no-url' };",
      "const gen = it.primitives.getNode('n_relay_gen');",
      "gen.generatedOutputs = [{url:url, name:'generated.jpg'}]; gen.runStatus='done'; gen.runError='';",
      "let o = it.getState().nodes.find(function(n){ return n.type==='output'; });",
      "if(!o){ await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'n_relay_out', type:'output', x:1100, y:120, images:[] } }, null); await window.__openarcCanvas.applyCommand({ type:'edge.connect', from:'n_relay_gen', to:'n_relay_out' }, null); o = it.primitives.getNode('n_relay_out') || it.getState().nodes.find(function(n){ return n.type==='output'; }); }",
      "if(o){ o.images = [{url:url, name:'generated.jpg'}]; }",
      "it.primitives.render(); try { it.primitives.saveNow(); } catch(e){}",
      "try { if (typeof window.fitAllNodesViewport === 'function') window.fitAllNodesViewport(); } catch(e){}",
      "it.primitives.render();",
      "return { placed:!!o, hasOutputNode: !!o, nodeCount: it.getState().nodes.length, outImages: o ? (o.images||[]).length : 0 };",
    ].join("\n"));
    await sleep(1200);
    const revAfter = (await call("canvas", "canvas/get", { canvasId })).result;
    out.revisionAfterRun = revAfter && (revAfter.revision != null ? revAfter.revision : (revAfter.canvas && revAfter.canvas.revision));

    // 关掉其它窗口并把 AI Studio 置顶/最大化，确保截图是画布本身
    out.windowsBefore = await page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll("section.window")).map((w) => w.getAttribute("aria-label")));
    await page.evaluate(() => {
      Array.prototype.slice.call(document.querySelectorAll("section.window")).forEach((w) => {
        if (w.getAttribute("aria-label") !== "AI Studio窗口") { const b = w.querySelector(".window-title button.close"); if (b) b.click(); }
      });
    });
    await sleep(500);
    await page.evaluate(() => { const w = document.querySelector('section.window[aria-label="AI Studio窗口"]'); if (w) w.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window })); });
    const maxAria = await page.evaluate(() => { const w = document.querySelector('section.window[aria-label="AI Studio窗口"]'); const b = w && w.querySelector(".maximize"); return b ? b.getAttribute("aria-label") : null; });
    if (maxAria && maxAria.indexOf("最大化") === 0) {
      await page.evaluate(() => { const w = document.querySelector('section.window[aria-label="AI Studio窗口"]'); const b = w && w.querySelector(".maximize"); if (b) b.click(); });
      await sleep(900);
    }
    out.windowsAfter = await page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll("section.window")).map((w) => w.getAttribute("aria-label")));

    const shotBoth = async (name) => { const res = []; for (const theme of ["light", "dark"]) { const cc = await page.$(".control-center"); if (!cc) { await page.evaluate(() => { const b = document.querySelector('button[aria-label="控制中心"]'); if (b) b.click(); }); await sleep(350); } await page.evaluate((t) => { const cc2 = document.querySelector(".control-center"); if (!cc2) return; const g = cc2.querySelector('[aria-label="外观"]'); if (!g) return; const btns = Array.prototype.slice.call(g.querySelectorAll("button")); for (const b of btns) if (String(b.textContent).trim() === t) { b.click(); return; } }, theme === "dark" ? "深色" : "浅色"); await sleep(500); await page.evaluate(() => { const sh = document.querySelector(".cc-shade"); if (sh) sh.click(); }); await sleep(300); const file = path.join(SHOTS, name + "-" + theme + ".png"); const ses = await page.context().newCDPSession(page); const r = await ses.send("Page.captureScreenshot", { format: "png" }); try { await ses.detach(); } catch { /* ignore */ } fs.writeFileSync(file, Buffer.from(r.data, "base64")); const b = fs.readFileSync(file); res.push({ file: path.relative(ROOT, file), theme, width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length }); } return res; };
    out.shots = await shotBoth("07-canvas-host-image");
    await relay.close();
  } catch (err) {
    out.fatal = scrubText(String((err && err.stack) || err), [token]);
    console.error("FATAL " + out.fatal);
    try { await relay.close(); } catch { /* ignore */ }
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child) child.kill("SIGTERM"); } catch { /* ignore */ }
    await waitFor(() => !child || child.exitCode !== null || child.signalCode !== null, 8000, 200);
    if (child && child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.writeFileSync(path.join(ART, "canvas-diag.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  return out.file ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => { console.error("UNCAUGHT " + scrubText(e && e.stack, [loadToken()])); process.exit(2); });
