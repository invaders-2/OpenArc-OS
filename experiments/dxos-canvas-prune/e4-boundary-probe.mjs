/**
 * DXOS-CANVAS-PRUNE · E4 宿主边界测试（针对**真实产品页**，隔离运行，可给出修复前后对照）。
 *
 * 背景：原 E4（experiments/d5-02/canvas-e2e.mjs:900）用非产品外壳
 * `openarc-canvas://bundle/index.html` 造伪造帧；该外壳 eager 的 `#frame-home` 指向已删除的
 * `static/home.html` ⇒ 加载它必然产生 1 条 404。本探针把同一套边界语义（伪造 token / 其它 iframe /
 * 页面自身来源的调用一律不执行）分别加载：
 *   · 旧来源 `openarc-canvas://bundle/index.html`（期望：边界仍成立，但有 1 条 /static/home.html 404）
 *   · 产品来源 `openarc-canvas://bundle/static/canvas-list.html`（期望：边界成立 + **0 条 404**）
 * 断言语义与原 E4 一致且更严：画布数量不变 **并且** 伪造帧加载期间 bundle 请求 0 条 404。
 *
 * 用法：node experiments/dxos-canvas-prune/e4-boundary-probe.mjs
 *   （默认只跑产品页；历史对照需先把旧 index.html 放回 bundle 根，再设 OA_E4_INCLUDE_OLD_SHELL=1）
 * 产物：artifacts/dxos-canvas-prune/E4-BOUNDARY.json
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-prune");
const CDP_PORT = Number(process.env.OA_E4_CDP_PORT || 9822);
const ADMIN = { id: "admin@dxos-e4.test", pw: "e4-admin-1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 界面页定位：当前默认壳 dist/vue.html，回退 dist/index.html。缺任何一个都明确报错。 */
const UI_RE = /[\\/]dist[\\/](vue|index)\.html/;

const checks = [];
const record = (name, ok, expected, actual) => {
  checks.push({ name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: typeof actual === "string" ? actual : JSON.stringify(actual) });
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + name + (ok ? "" : " — 期望 " + expected + "，实际 " + JSON.stringify(actual)));
  return ok;
};
let passed = 0, failed = 0;
const recordWrap = (...a) => { if (record(...a)) passed += 1; else failed += 1; };

let child = null, browser = null, page = null, userDataDir = null, cdp = null, stderrBuf = "";
const consoleErrors = [], pageErrors = [], netFailures = [], requestUrls = new Map();
const pwBundle = [], pwFails = []; // Playwright 页面事件（与 CDP 互为交叉验证，且能看到 OOPIF 子帧请求）
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const canvas = (payload) => js("return await window.openarc.canvas.command(" + JSON.stringify(payload) + ")");
async function waitFor(fn, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await Promise.resolve(fn())) return true; } catch { /* retry */ } await sleep(200); } return false; }
const waitSel = (sel, ms) => waitFor(() => has(sel), ms || 20000);
const frameBy = (re) => page.frames().find((f) => re.test(f.url())) || null;
const listFrame = () => frameBy(/openarc-canvas:\/\/bundle\/static\/canvas-list\.html/);

async function launch() {
  if (!UI_RE && false) {}
  if (!fs.existsSync(path.join(ROOT, "dist", "vue.html")) && !fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
    throw new Error("缺少界面页：dist/vue.html 与 dist/index.html 都不存在（先 npm run build）");
  }
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-e4-"));
  const childEnv = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
  // 本仓库环境会把 Electron 当普通 Node 跑（app 未定义、CDP 不启动），必须摘掉。
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + CDP_PORT, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: childEnv,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderrBuf += String(d); });
  let version = null;
  const deadline = Date.now() + 60000;
  while (!version && Date.now() < deadline) { try { version = await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version")).json(); } catch { await sleep(300); } }
  if (!version) throw new Error("CDP 未就绪（exit=" + child.exitCode + "）。electron stderr 尾部：\n" + stderrBuf.slice(-1500));
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP_PORT);
  const ctx = browser.contexts()[0];
  const end = Date.now() + 40000;
  const prefer = (all) => all.find((p) => /[\\/]dist[\\/]vue\.html/.test(p.url())) || all.find((p) => /[\\/]dist[\\/]index\.html/.test(p.url())) || null;
  while (!page && Date.now() < end) { page = prefer(ctx.pages()); if (!page) await sleep(300); }
  if (!page) throw new Error("未找到界面页面（优先 dist/vue.html，回退 dist/index.html），当前 pages=" + JSON.stringify(ctx.pages().map((p) => p.url())) + "，electron stderr 尾部：\n" + stderrBuf.slice(-800));
  console.log("   · 界面页：" + page.url());
  page.on("dialog", (d) => { void d.dismiss().catch(() => {}); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push({ url: String((m.location() || {}).url || "").slice(0, 120), text: m.text().slice(0, 300) }); });
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
  const isBundleUrl = (u) => String(u).indexOf("openarc-canvas://bundle/") === 0;
  page.on("request", (r) => { if (isBundleUrl(r.url())) pwBundle.push({ url: r.url(), frame: r.frame() ? r.frame().url() : "" }); });
  page.on("response", (r) => { if (isBundleUrl(r.url()) && r.status() >= 400) pwFails.push({ status: r.status(), url: r.url() }); });
  page.on("requestfailed", (r) => { if (isBundleUrl(r.url())) pwFails.push({ status: 0, errorText: r.failure() ? r.failure().errorText : "", url: r.url() }); });
  cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => requestUrls.set(e.requestId, e.request.url));
  cdp.on("Network.responseReceived", (e) => { if (e.response.status >= 400) netFailures.push({ kind: "response", status: e.response.status, url: e.response.url }); });
  cdp.on("Network.loadingFailed", (e) => { netFailures.push({ kind: "loadingFailed", status: 0, errorText: e.errorText, url: requestUrls.get(e.requestId) || "" }); });
}

async function login() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized" && (await waitSel('[data-d3-id="setup-name"]', 30000))) {
    const next = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "DXOS E4 Admin"); await next();
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
  await js("const el = document.querySelector('[data-dock-id=\"canvas\"]') || document.querySelector('[aria-label=\"打开AI Studio\"]') || document.querySelector('[aria-label=\"打开无限画布\"]'); if (el) el.click(); return !!el;");
  return await waitFor(() => has("[data-canvas-host]"), 20000);
}

/** 原 E4 的伪造场景（语义一字不改）：sandbox allow-scripts 的伪造帧 + 伪造 token 调用 canvas.create。 */
function forgeScenario(src, title) {
  return [
    "const f = document.createElement('iframe'); f.id='oa-e4-probe-frame';",
    "f.setAttribute('sandbox','allow-scripts');",
    "f.src=" + JSON.stringify(src) + "; f.style.display='none'; document.body.appendChild(f);",
    "await new Promise(r=>setTimeout(r,2500));",
    "const w = f.contentWindow;",
    "try { w.postMessage({ ch:'openarc.canvas', dir:'canvas->host', kind:'call', id: 991, token:'t_forged', method:'canvas.create', params:{ title:'伪造' } }, '*'); } catch(e) {}",
    "window.postMessage({ ch:'openarc.canvas', dir:'canvas->host', kind:'call', id: 992, token:'t_forged', method:'canvas.create', params:{ title:" + JSON.stringify(title) + " } }, '*');",
    "await new Promise(r=>setTimeout(r,1800));",
    "const frameUrl = (function () { try { return String(f.contentWindow.location.href); } catch (e) { return 'cross-origin'; } })();",
    "return { done: true, frameUrl: frameUrl };",
  ].join("\n");
}
/** 场景结束后再摘掉伪造帧（原 E4 在场景内 f.remove()；这里把摘帧挪到取证之后）。 */
function removeForgedFrame() {
  return "const f = document.getElementById('oa-e4-probe-frame'); if (f) f.remove(); return true;";
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  await launch();
  recordWrap("e4-0 · 真实 electron . 启动 + 登录（隔离 userData + CDP " + CDP_PORT + "）", await login(), "ready", await gate());
  const appUp = await openAppWindow();
  const listUp = await waitFor(() => !!listFrame(), 25000);
  const listenerMounted = await has("[data-canvas-host]");
  recordWrap("e4-1 · 宿主应用窗口已挂载（消息监听真的存在，不是空断言）", appUp && listUp && listenerMounted === true, "应用帧 + [data-canvas-host]", { appUp, listUp, listenerMounted });

  const cases = [
    // old-shell 是**历史对照**（复现"修复前 1 条 404"），只有在 bundle 根 index.html 还存在时才有意义；
    // 默认（bundle 根外壳已删）不跑它。要复现修复前对照：先把历史 index.html 放回 bundle 根，再
    // OA_E4_INCLUDE_OLD_SHELL=1 node experiments/dxos-canvas-prune/e4-boundary-probe.mjs
    ...(process.env.OA_E4_INCLUDE_OLD_SHELL === "1"
      ? [{ key: "old-shell", src: "openarc-canvas://bundle/index.html?id=cv_probe", title: "来自外壳", expect404: 1, note: "修复前：非产品外壳（eager #frame-home → 已删的 static/home.html）" }]
      : []),
    { key: "product-page", src: "openarc-canvas://bundle/static/canvas-list.html?id=cv_probe", title: "来自产品页", expect404: 0, note: "修复后：保留的产品画布入口页" },
  ];
  const results = [];
  for (const c of cases) {
    const before = (await canvas({ type: "canvas/list" })).items.length;
    const mark = netFailures.length;
    const pwMark = pwFails.length;
    const pwReqMark = pwBundle.length;
    const res = await js(forgeScenario(c.src, c.title));
    const framesDuring = page.frames().map((f) => f.url()).filter((u) => u.indexOf("openarc-canvas://bundle/") === 0);
    await js(removeForgedFrame());
    await sleep(600);
    const after = (await canvas({ type: "canvas/list" })).items.length;
    const cdpFails = netFailures.slice(mark).filter((f) => String(f.url).indexOf("openarc-canvas://bundle/") === 0);
    const pwCaseFails = pwFails.slice(pwMark).filter((f) => String(f.url).indexOf("openarc-canvas://bundle/") === 0);
    const seen = new Set();
    const bundleFails = [...cdpFails, ...pwCaseFails].filter((f) => { const k = f.status + " " + f.url; if (seen.has(k)) return false; seen.add(k); return true; });
    const bundleRequests = pwBundle.slice(pwReqMark);
    const notFound = bundleFails.filter((f) => f.status === 404);
    const boundaryHeld = after === before;
    // 伪造帧必须**真的加载了 bundle 文档**，否则"0 条 404"只是没请求，属于假绿。
    const expectedDoc = c.src.split("?")[0];
    const forgedFrameLoaded = framesDuring.some((u) => u.indexOf(expectedDoc) === 0) || !!(res && typeof res.frameUrl === "string" && res.frameUrl.indexOf(expectedDoc) === 0);
    const ok = boundaryHeld && notFound.length === c.expect404 && forgedFrameLoaded === true;
    results.push({ case: c.key, note: c.note, src: c.src, before, after, boundaryHeld, notFound, bundleFails, bundleRequests, framesDuring, forgedFrameLoaded, signature: "host-command-boundary" });
    recordWrap("e4 · " + c.key + " — " + c.note + "：伪造 token / 其它 iframe / 页面自身来源的调用一律不执行（画布数不变）且 404 数 = " + c.expect404,
      ok,
      "画布数不变 + 404=" + c.expect404 + " + 伪造帧真的加载",
      { before, after, boundaryHeld, forgedFrameLoaded, notFound, bundleFailCount: bundleFails.length, bundleRequestCount: bundleRequests.length, frameUrl: res && res.frameUrl });
  }

  const out = {
    ok: failed === 0,
    probe: "experiments/dxos-canvas-prune/e4-boundary-probe.mjs",
    cdpPort: CDP_PORT,
    caseSemantics: "原 E4 语义不变：伪造 token / 其它 iframe / 页面自身来源的调用不得执行宿主命令（画布数不变）；新增：伪造帧加载期间 0 条 bundle 404。",
    uiPage: page.url(),
    checks,
    results,
    consoleErrors,
    pageErrors,
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ART, "E4-BOUNDARY.json"), JSON.stringify(out, null, 2) + "\n");
  console.log("\n==== 汇总：PASS " + passed + " / FAIL " + failed + " ====");
  process.exitCode = out.ok ? 0 : 1;
}

main().catch((e) => {
  console.error("探针异常：" + String((e && e.stack) || e));
  process.exitCode = 2;
}).finally(async () => {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
  if (child && !child.killed) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
});
