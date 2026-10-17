/**
 * F3d 定向探针（D1 回归钉在智能画布上的真实行为）。
 * 用法：node experiments/dxos-canvas-revendor-next/f3d-probe.mjs
 */
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startCanvasProvider } from "../../tests/fixtures/d5-02-canvas-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const CDP_PORT = Number(process.env.OA_F3D_CDP_PORT || 9883);
const ADMIN = { id: "admin@f3d.test", pw: "f3d-admin-1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null, browser = null, page = null, provider = null, userDataDir = null, stderrBuf = "";
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop') ? document.querySelector('.desktop').getAttribute('data-identity-gate') : 'no-root'");
const model = (payload) => js("return await window.openarc.model.command(" + JSON.stringify(payload) + ")");
const canvas = (payload) => js("return await window.openarc.canvas.command(" + JSON.stringify(payload) + ")");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(150); } return false; }
const waitSel = (sel, ms) => waitFor(() => js("return !!document.querySelector(" + JSON.stringify(sel) + ")"), ms || 20000);
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);
const smartFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/smart-canvas\.html/);
async function inFrame(f, code) {
  if (!f) return { __noFrame: true };
  try { return JSON.parse((await f.evaluate("(async () => { return JSON.stringify(await (async () => { " + code + " })()); })()")) || "null"); }
  catch (e) { return { __error: String((e && e.message) || e).slice(0, 300) }; }
}
async function launch() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-f3d-"));
  const childEnv = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + CDP_PORT, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null; const end0 = Date.now() + 60000;
  while (!version && Date.now() < end0) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0]; const end = Date.now() + 40000;
  while (!page && Date.now() < end) { page = ctx.pages().find((p) => /[\\/]dist[\\/](vue|index)\.html/.test(p.url())) || null; if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页");
  page.on("dialog", (d) => { void d.dismiss().catch(() => {}); });
}
async function login() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const next = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "F3D Admin"); await next();
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
async function main() {
  provider = await startCanvasProvider({ port: 5435 });
  await launch(); await login();
  const prov = await model({ type: "provider/create", displayName: "F3D Provider", baseUrl: provider.baseUrl, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "f3d-secret" });
  const providerId = prov.provider.providerId;
  const cm = await model({ type: "model/create", providerId, remoteModelId: "f3d-chat", displayName: "F3D Chat", capabilities: ["chat"], scope: "ORGANIZATION" });
  await model({ type: "defaults/set", capability: "chat", configId: cm.model.configId });
  await js("const el = document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]'); if (el) el.click(); return !!el;");
  await waitFor(() => js("return !!document.querySelector('[data-canvas-host]')"), 20000);
  console.log("frames-after-open", JSON.stringify(page.frames().map((f) => f.url().slice(0, 90))));
  await waitFor(() => !!listFrame(), 25000);
  await inFrame(listFrame(), "const el = document.getElementById('btnStartCreate'); if (!el) return 'missing'; el.click(); return 'clicked';");
  await waitFor(() => !!smartFrame(), 45000);
  await waitFor(async () => {
    const s = await inFrame(smartFrame(), "return { id: (window.__openarcCanvas && window.__openarcCanvas.state().canvasId) || null, ro: window.__openarcBridge ? window.__openarcBridge.isReadOnly() : null };");
    return s && s.id && s.ro === false;
  }, 30000);
  console.log("frames-after-smart", JSON.stringify(page.frames().map((f) => f.url().slice(0, 90))));
  const canvasId = await inFrame(smartFrame(), "return window.__openarcCanvas.state().canvasId;");
  console.log("canvasId", canvasId);

  const localId = "n_d1_local", hostId = "n_d1_host";
  const localText = "本地编辑（D1 回归钉）", hostText = "宿主新增（D1 回归钉）";
  const localEdit = await inFrame(smartFrame(), "return await window.__openarcCanvas.applyCommand({ type:'node.add', node:{ id:'" + localId + "', type:'prompt', x:120, y:120, text:'" + localText + "' } }, null);");
  const localSaved = await waitFor(async () => { const g = await canvas({ type: "canvas/get", canvasId }); const n = g.ok ? (g.canvas.doc.nodes || []).find((x) => x.id === localId) : null; return !!(n && n.text === localText); }, 20000);
  console.log("local", JSON.stringify({ ok: localEdit.ok, localSaved }));
  const hostAdd = await canvas({ type: "canvas/command", canvasId, command: { type: "node.add", node: { id: hostId, type: "prompt", x: 120, y: 300, text: hostText } } });
  const t0 = Date.now();
  const appeared = await waitFor(async () => (await inFrame(smartFrame(), "return !!(window.__openarcCanvasInternals && window.__openarcCanvasInternals.primitives.getNode('" + hostId + "'));")) === true, 8000);
  const waitedMs = Date.now() - t0;
  await sleep(800);
  const pageState = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; const has = (id) => !!(it.primitives.getNode(id)); const el = (id) => document.querySelector('.image-node[data-id=\"' + id + '\"]'); const n = (id) => it.primitives.getNode(id) || {}; return { hasLocal: has('" + localId + "'), localText: String(n('" + localId + "').text || ''), hasHost: has('" + hostId + "'), domHost: !!el('" + hostId + "'), hostText: String(n('" + hostId + "').text || ''), nodes: it.getState().nodes.length };");
  const ipcHost = (await canvas({ type: "canvas/get", canvasId })).canvas.doc.nodes.find((x) => x.id === hostId) || null;
  const ipcLocal = (await canvas({ type: "canvas/get", canvasId })).canvas.doc.nodes.find((x) => x.id === localId) || null;
  const rev0 = (await canvas({ type: "canvas/get", canvasId })).canvas.revision;
  await sleep(5000);
  const rev1 = (await canvas({ type: "canvas/get", canvasId })).canvas.revision;
  const pageState2 = await inFrame(smartFrame(), "const it = window.__openarcCanvasInternals; return { host: !!it.primitives.getNode('" + hostId + "'), local: !!it.primitives.getNode('" + localId + "'), rev: it.getState().canvas ? Number(it.getState().canvas.revision) : null };");
  console.log(JSON.stringify({ hostAddOk: hostAdd && hostAdd.ok, hostAddError: hostAdd && hostAdd.error, appeared, waitedMs, pageState, ipcHost: ipcHost && ipcHost.text, ipcLocal: ipcLocal && ipcLocal.text, rev: [rev0, rev1], revisionStable: rev0 === rev1, pageState2 }, null, 2));
}
try { await main(); } catch (e) { console.error("探针异常：" + String((e && e.stack) || e)); console.error(stderrBuf.slice(-1200)); process.exitCode = 2; }
try { if (browser) await browser.close().catch(() => {}); } catch {}
try { if (child) child.kill("SIGKILL"); } catch {}
try { spawnSync("pkill", ["-f", "oa-f3d-"], { stdio: "ignore" }); } catch {}
try { if (provider) await provider.close(); } catch {}
