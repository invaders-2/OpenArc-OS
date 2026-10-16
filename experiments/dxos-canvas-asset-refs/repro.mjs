/**
 * 复现 / 验收：画布上「由 OpenArc 资源库而来的图片」在什么条件下会 CSP 违规 + 图裂。
 *
 * 场景（都走真实产品路径：真实 electron . + 真实宿主 IPC + 真实画布页渲染）：
 *   A. >20 个资源引用：25 张资源库图片落在 25 个 image 节点上 —— 原实现只解析前 20 个，
 *      第 21 个起以原始 openarc-asset: 落到 <img> 上（CSP img-src 只允许 openarc-canvas:/data:/blob:）。
 *   B. 引用只有一个且可用：1 张图正常显示（对照组，证明资源链路本身是通的）。
 *   C. 引用读不出来（资源被删）：宿主把文档推回画布页时若保留原始 ref，就同样 CSP 违规；
 *      这正是全量门禁日志里 8 条违规样本的来源（门禁 F3a 流程只引入了 1 个 ref，触发点是 F3c）。
 *
 * 输出：每个场景的 <img> 计数（loaded / broken / rawRef）、CSP 违规条数、console error 数、截图。
 * 用法：node experiments/dxos-canvas-asset-refs/repro.mjs <label>
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-asset-refs");
const LABEL = String(process.argv[2] || "run");
const CDP_PORT = Number(process.env.OA_ASSETREF_CDP_PORT || 9795);
const ADMIN = { id: "admin@assetref.test", pw: "asset-ref-1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CSP_RE = /Content Security Policy|violates the following/i;

/* ── 最小 PNG 编码器：给每张图不同的字节，保证 25 个引用是 25 个不同 ResourceRef ── */
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePng(seed, w = 8, h = 8) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * row] = 0;
    for (let x = 0; x < w; x += 1) {
      raw[y * row + 1 + x * 3] = (seed * 37 + x * 13) & 255;
      raw[y * row + 2 + x * 3] = (seed * 53 + y * 29) & 255;
      raw[y * row + 3 + x * 3] = (seed * 11 + x * y) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const pngDataUrl = (seed) => "data:image/png;base64," + makePng(seed).toString("base64");

let child = null, browser = null, page = null;
const consoleErrors = [];
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const canvas = (payload) => js("return await window.openarc.canvas.command(" + JSON.stringify(payload) + ")");
const resource = (payload) => js("return await window.openarc.resource.command(" + JSON.stringify(payload) + ")");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const canvasFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas\.html/);
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 240) }; }
}

async function launch() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-assetref-"));
  const childEnv = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userData, "--remote-debugging-port=" + CDP_PORT, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  while (!page && Date.now() < end) {
    const pages = ctx.pages();
    page = pages.find((p) => /[\\/]dist[\\/]vue\.html/.test(p.url())) || pages.find((p) => /[\\/]dist[\\/]index\.html/.test(p.url())) || null;
    if (!page) await sleep(300);
  }
  if (!page) throw new Error("未找到界面页面");
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 240)); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror:" + String(e.message).slice(0, 240)));
}

async function login() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitFor(() => has('[data-d3-id="setup-name"]'), 30000))) {
    const setupNext = async () => { await waitFor(() => js(`const b = document.querySelector('[data-d3-id="setup-next"]'); return !!b && !b.disabled;`), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "AssetRef Admin");
    await setupNext();
    await waitFor(() => has('[data-d3-id="setup-identifier"]'), 10000);
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await setupNext();
    await waitFor(() => has('[data-d3-id="setup-password"]'), 10000);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js(`const b = document.querySelector('[data-d3-id="setup-submit"]'); return !!b && !b.disabled;`), 10000);
    await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  await waitFor(() => has('[data-d3-id="login-identifier"]'), 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  return waitFor(async () => (await gate()) === "ready", 60000);
}

async function openAppWindow() {
  await js(`const el = document.querySelector('[aria-label="打开AI Studio"]') || document.querySelector('[aria-label="打开无限画布"]'); if (el) el.click(); return !!el;`);
  return waitFor(() => has("[data-canvas-host]"), 20000);
}

/** 页面上的 <img> 事实：解码成功 / 图裂 / src 还是原始 openarc-asset:（= 会被 CSP 拦）/ 占位值。*/
async function imgFacts() {
  return inFrame(canvasFrame(), [
    "const imgs = Array.from(document.querySelectorAll('img'));",
    "const srcOf = (i) => String(i.getAttribute('src') || '');",
    "const origOf = (i) => String(i.getAttribute('data-original-src') || '');",
    "const media = imgs.map(srcOf).filter((s) => s.startsWith('data:image'));",
    "// loading=lazy 的离屏图不会自动解码，且 decode() 对未开始加载的图会一直挂起；",
    "// 这里用独立 Image() 以同一 data URL 立刻解码一次（带超时兜底），证明宿主给出的数据确实能成为图像。",
    "const decoded = await Promise.all(media.map((src) => new Promise((resolve) => {",
    "  const probe = new Image();",
    "  let done = false;",
    "  const finish = (ok) => { if (!done) { done = true; resolve(ok); } };",
    "  probe.onload = () => finish(true);",
    "  probe.onerror = () => finish(false);",
    "  probe.src = src;",
    "  setTimeout(() => finish(probe.naturalWidth > 0), 2000);",
    "})));",
    "return {",
    "  total: imgs.length,",
    "  loaded: imgs.filter((i) => i.naturalWidth > 0).length,",
    "  broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,",
    "  dataUrlSrc: media.length,",
    "  decoded: decoded.filter(Boolean).length,",
    "  decodedSampleError: media.length - decoded.filter(Boolean).length,",
  
    "  rawRefSrc: imgs.filter((i) => srcOf(i).startsWith('openarc-asset:')).length,",
    "  rawRefOriginal: imgs.filter((i) => origOf(i).startsWith('openarc-asset:')).length,",
    "  sampleRaw: imgs.map(srcOf).filter((s) => s.startsWith('openarc-asset:')).slice(0, 3),",
    "  samplePlaceholder: imgs.map(srcOf).filter((s) => s.startsWith('data:application/vnd.openarc.missing-asset')).slice(0, 2),",
    "};",
  ].join("\n"));
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  await launch();
  const loginOk = await login();
  if (!loginOk) throw new Error("登录失败");

  // 打开画布应用 → 开始创作 → 编辑器
  if (!(await openAppWindow())) throw new Error("画布应用窗口未打开");
  await waitFor(() => !!listFrame(), 30000);
  await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';");
  await waitFor(() => !!canvasFrame(), 40000);
  await waitFor(async () => { const st = await inFrame(canvasFrame(), "const s = window.__openarcCanvas ? window.__openarcCanvas.state() : null; return s ? { id: s.canvasId } : null;"); return !!(st && st.id); }, 30000);
  const canvasId = (await inFrame(canvasFrame(), "const s = window.__openarcCanvas.state(); return { id: s.canvasId };")).id;

  const cases = [];

  // ── B（对照组）：1 个引用，可用 → 应正常显示 ──
  const bBase = consoleErrors.length;
  const oneImp = await canvas({ type: "canvas/importAsset", canvasId, name: "one", dataUrl: pngDataUrl(1) });
  await canvas({ type: "canvas/command", canvasId, command: { type: "node.add", node: { id: "n_one", type: "image", x: 80, y: 80, url: oneImp.ref, name: "one" } } });
  await sleep(7000);
  const bFacts = await imgFacts();
  cases.push({ case: "B-单引用可用", ref: oneImp.ref, cspViolations: consoleErrors.slice(bBase).filter((t) => CSP_RE.test(t)).length, img: bFacts });
  await page.screenshot({ path: path.join(ART, "repro-" + LABEL + "-B-single.png") }).catch(() => {});

  // ── A：25 个引用（>20） ──
  const refs = [];
  for (let i = 0; i < 25; i += 1) {
    const imp = await canvas({ type: "canvas/importAsset", canvasId, name: "batch-" + i, dataUrl: pngDataUrl(100 + i) });
    if (!imp || !imp.ok || !imp.ref) throw new Error("importAsset 失败：" + JSON.stringify(imp));
    refs.push(imp.ref);
  }
  for (let i = 0; i < refs.length; i += 1) {
    await canvas({ type: "canvas/command", canvasId, command: { type: "node.add", node: { id: "n_batch_" + i, type: "image", x: 320 + (i % 5) * 220, y: 80 + Math.floor(i / 5) * 220, url: refs[i], name: "batch-" + i } } });
  }
  const aBase = consoleErrors.length;
  await sleep(9000);
  const aCsp = consoleErrors.slice(aBase).filter((t) => CSP_RE.test(t));
  const aFacts = await imgFacts();
  cases.push({ case: "A-25个引用", refs: refs.length, cspViolations: aCsp.length, consoleErrors: consoleErrors.slice(aBase).filter((t) => CSP_RE.test(t)).length, img: aFacts });
  await page.screenshot({ path: path.join(ART, "repro-" + LABEL + "-A-25-refs.png") }).catch(() => {});

  // ── C：单个引用被删（读不出来）→ 宿主把文档推回画布页 ──
  const deadImp = await canvas({ type: "canvas/importAsset", canvasId, name: "dead", dataUrl: pngDataUrl(999) });
  await canvas({ type: "canvas/command", canvasId, command: { type: "node.add", node: { id: "n_dead", type: "image", x: 1700, y: 640, url: deadImp.ref, name: "dead" } } });
  await sleep(6000);
  const beforeDelete = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_dead'); return { urlHead: String((n || {}).url || '').slice(0, 21) };");
  await resource({ type: "resource/delete", resourceRef: String(deadImp.ref).replace("openarc-asset:", "") });
  const cBase = consoleErrors.length;
  await sleep(11000);
  const cCsp = consoleErrors.slice(cBase).filter((t) => CSP_RE.test(t));
  const cFacts = await imgFacts();
  const deadNode = await inFrame(canvasFrame(), "const n = window.__openarcCanvasInternals.primitives.getNode('n_dead'); return { urlHead: String((n || {}).url || '').slice(0, 60) };");
  cases.push({ case: "C-引用被删", ref: deadImp.ref, beforeDelete, deadNode, cspViolations: cCsp.length, cspSample: cCsp.slice(0, 2), img: cFacts });
  await page.screenshot({ path: path.join(ART, "repro-" + LABEL + "-C-deleted.png") }).catch(() => {});

  const totalCsp = consoleErrors.filter((t) => CSP_RE.test(t)).length;
  const out = { label: LABEL, canvasId, totalCspViolations: totalCsp, consoleErrors: consoleErrors.length, cases, at: new Date().toISOString() };
  fs.writeFileSync(path.join(ART, "repro-" + LABEL + ".json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
  try { child.kill("SIGKILL"); } catch { /* ignore */ }
  return 0;
}

main().then((c) => process.exit(c)).catch(async (e) => {
  console.error("repro 异常：" + String((e && e.stack) || e));
  try { await browser?.close(); } catch { /* ignore */ }
  try { child?.kill("SIGKILL"); } catch { /* ignore */ }
  process.exit(1);
});
