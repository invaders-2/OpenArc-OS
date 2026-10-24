#!/usr/bin/env node
/**
 * task-27 真机验收（隔离 profile + mock 服务商抓请求体，不付费、不联网）：
 *
 *   Electron 真实主进程（--user-data-dir 临时目录）→ 真实登录 → window.openarc.model.command 登记
 *   Lovart / APIMart 两个 mock 服务商 → window.openarc.canvas.command 走
 *   canvas/run → canvas/modelImage（带 style / camera / webSearch）→ canvas/runStatus。
 *
 * 断言：
 *   · Lovart（对话式）：chat 请求体 prompt 里有「风格：…」「摄影机：机身 …，镜头 …，焦段 …mm，光圈 …」，
 *     尺寸要求与视觉要求在同一个【画面要求】里；
 *   · APIMart（字段式）：images/generations 请求体没有 style / camera / web_search，提示词保持原样；
 *   · 两条链路都返回 ok，且请求只落在本地 mock（mock 之外没有外发）。
 *
 * 证据写 artifacts/style-camera/report.json；stdout 最后一行 RESULT {...} 供外层脚本读取。
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ART = path.join(ROOT, "artifacts", "style-camera");
const ADMIN = { id: "admin@style-camera.test", pw: "style-camera-1" };
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPORT = { checks: [], facts: {}, captures: {} };
const record = (name, ok, expected, actual) => {
  REPORT.checks.push({ name, ok: !!ok, expected: String(expected), actual: String(actual).slice(0, 4000) });
  console.log((ok ? "  PASS " : "! FAIL ") + name + " — 期望 " + expected + "；实际 " + String(actual).slice(0, 600));
  return !!ok;
};

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

function jsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(raw); } });
  });
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Lovart mock：project/save → chat（抓请求体）→ status → result。 */
function startLovartMock(port) {
  const captures = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = req.method === "POST" ? await jsonBody(req) : null;
    if (body) captures.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/project/save")) return sendJson(res, { code: 0, data: { project_id: "p_style_probe" } });
    if (url.pathname.endsWith("/chat")) return sendJson(res, { code: 0, data: { thread_id: "t_style_probe" } });
    if (url.pathname.endsWith("/chat/status")) return sendJson(res, { code: 0, data: { status: "done" } });
    if (url.pathname.endsWith("/chat/result")) return sendJson(res, { code: 0, data: { final_status: "done", items: [{ artifacts: [{ content: "https://a.lovart.ai/artifacts/agent/style-probe.png", type: "image" }] }] } });
    return sendJson(res, { code: 0, data: {} });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, captures, baseUrl: "http://127.0.0.1:" + port, close: () => new Promise((d) => server.close(d)) })));
}

/** APIMart mock：images/generations（抓请求体）→ tasks/{id} completed。 */
function startApimartMock(port) {
  const captures = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = req.method === "POST" ? await jsonBody(req) : null;
    if (body) captures.push({ path: url.pathname, body });
    if (url.pathname === "/v1/images/generations") return sendJson(res, { code: 0, data: [{ task_id: "task_style_probe" }] });
    if (url.pathname.startsWith("/v1/tasks/")) return sendJson(res, { code: 0, data: { status: "completed", result: { images: [{ url: ["https://cdn.example/style-probe.png"] }] } } });
    return sendJson(res, { code: 0, data: {} });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, captures, baseUrl: "http://127.0.0.1:" + port, close: () => new Promise((d) => server.close(d)) })));
}

let child = null, browser = null, page = null, userDataDir = null;
const js = (code) => page.evaluate("(async () => { " + code + " })()");
const has = (sel) => js("return !!document.querySelector(" + JSON.stringify(sel) + ")");
const clickDom = (sel) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; el.click(); return 'ok';");
const setInput = (sel, v) => js("const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok';");
const gate = () => js("return document.querySelector('.desktop')?.getAttribute('data-identity-gate') || 'no-root'");
const modelCmd = (payload) => js("return await window.openarc.model.command(" + JSON.stringify(payload) + ")");
const canvasCmd = (payload) => js("return await window.openarc.canvas.command(" + JSON.stringify(payload) + ")");

async function waitFor(fn, timeout = 30000, step = 250) {
  const end = Date.now() + timeout;
  for (;;) {
    try { if (await fn()) return true; } catch { /* retry */ }
    if (Date.now() >= end) return false;
    await sleep(step);
  }
}

async function launch(cdpPort) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-style-camera-"));
  const env = { ...process.env, OA_STYLE_CAMERA_PROBE: "1" };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  child = spawn(electronPath, [".", "--user-data-dir=" + userDataDir, "--remote-debugging-port=" + cdpPort, ...extraArgs], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
  child.stderr.on("data", () => {});
  const up = await waitFor(async () => { try { return (await fetch("http://127.0.0.1:" + cdpPort + "/json/version")).ok; } catch { return false; } }, 90000, 300);
  if (!up) throw new Error("Electron CDP 未就绪");
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + cdpPort);
  const ctx = browser.contexts()[0];
  await waitFor(() => ctx.pages().length > 0, 60000, 300);
  page = ctx.pages().find((p) => /^file:|^https?:/.test(p.url())) || null;
  if (!page) throw new Error("未找到渲染层页面");
  page.on("dialog", (d) => { void d.dismiss().catch(() => {}); });
}

async function setupAndLogin() {
  await waitFor(async () => ["uninitialized", "unauthenticated", "ready"].includes(await gate()), 60000);
  if ((await gate()) === "uninitialized") {
    await waitFor(() => has('[data-d3-id="setup-name"]'), 30000);
    const next = async () => { await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-next\"]'); return !!b && !b.disabled;"), 10000); await clickDom('[data-d3-id="setup-next"]'); };
    await setInput('[data-d3-id="setup-name"]', "Style Camera Admin");
    await next();
    await waitFor(() => has('[data-d3-id="setup-identifier"]'), 10000);
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await next();
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

async function createProviderAndModel({ displayName, baseUrl, adapterType, credential, remoteModelId }) {
  const provider = await modelCmd({ type: "provider/create", displayName, baseUrl, adapterType, endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: credential });
  if (!provider || provider.ok !== true) throw new Error("provider/create 失败：" + JSON.stringify(provider));
  const model = await modelCmd({ type: "model/create", providerId: provider.provider.providerId, remoteModelId, displayName, capabilities: ["image-generation"], scope: "ORGANIZATION" });
  if (!model || model.ok !== true) throw new Error("model/create 失败：" + JSON.stringify(model));
  return { providerId: provider.provider.providerId, configId: model.model.configId };
}

async function generateOnCanvas({ canvasId, configId, prompt, style, camera, webSearch }) {
  const run = await canvasCmd({ command: "canvas/run", payload: { canvasId, kind: "image", configId } });
  if (!run || run.ok !== true) throw new Error("canvas/run 失败：" + JSON.stringify(run));
  const started = await canvasCmd({
    command: "canvas/modelImage",
    payload: {
      canvasId, runId: run.runId, async: true, configId, prompt, size: "1536x2048", ratio: "3:4", resolution: "2K", count: 1,
      ...(style ? { style } : {}), ...(camera ? { camera } : {}), ...(webSearch === true ? { webSearch: true } : {}),
    },
  });
  if (!started || started.ok !== true) throw new Error("canvas/modelImage 失败：" + JSON.stringify(started));
  const deadline = Date.now() + 90000;
  let status = null;
  while (Date.now() < deadline) {
    status = await canvasCmd({ command: "canvas/runStatus", payload: { canvasId, runId: run.runId } });
    if (status && status.status && status.status !== "RUNNING") break;
    await sleep(300);
  }
  return { run, started, status };
}

const CAMERA_INDEX = { body: 1, lens: 0, focal: 4, aperture: 1 };

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const [lovartPort, apimartPort, cdpPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const lovartMock = await startLovartMock(lovartPort);
  const apimartMock = await startApimartMock(apimartPort);
  let fatal = null;
  try {
    await launch(cdpPort);
    const loggedIn = await setupAndLogin();
    record("R0 真实 Electron + 隔离 userData 登录", loggedIn, "gate=ready", "gate=" + (await gate()) + " userData=" + path.basename(userDataDir));

    const lovart = await createProviderAndModel({
      displayName: "Lovart Probe", baseUrl: lovartMock.baseUrl, adapterType: "lovart",
      credential: JSON.stringify({ accessKey: "ak-probe", secretKey: "sk-probe" }), remoteModelId: "generate_image_seedream_v5_pro",
    });
    const apimart = await createProviderAndModel({
      displayName: "APIMart Probe", baseUrl: apimartMock.baseUrl, adapterType: "apimart",
      credential: "sk-apimart-probe", remoteModelId: "seedream-4-5",
    });
    record("R1 两个 mock 服务商 + 图片模型登记成功", !!lovart.configId && !!apimart.configId, "两个 configId", JSON.stringify({ lovart, apimart }));

    const created = await canvasCmd({ command: "canvas/create", payload: { title: "风格摄影机探针" } });
    if (!created || created.ok !== true) throw new Error("canvas/create 失败：" + JSON.stringify(created));
    const canvasId = created.canvas.canvasId;

    // ① Lovart：风格 / 摄影机 / 联网必须真进提示词
    const lovartRun = await generateOnCanvas({ canvasId, configId: lovart.configId, prompt: "一只猫坐在窗边", style: "电影感", camera: CAMERA_INDEX, webSearch: true });
    const lovartChat = lovartMock.captures.filter((c) => c.path.endsWith("/chat")).slice(-1)[0];
    const lovartPrompt = lovartChat && lovartChat.body && lovartChat.body.prompt ? String(lovartChat.body.prompt) : "";
    REPORT.captures.lovartRun = lovartRun;
    REPORT.captures.lovartPrompt = lovartPrompt;
    record("R2 Lovart 生成完成", !!(lovartRun.status && lovartRun.status.status === "DONE"), "DONE", JSON.stringify(lovartRun.status || {}));
    record("R3 Lovart 提示词含风格", /风格：电影感/.test(lovartPrompt), "风格：电影感", lovartPrompt);
    record("R4 Lovart 提示词含摄影机（索引 1/0/4/1 → 机身 ARRI Alexa 35，镜头 Zeiss Ultra Prime，焦段 50mm，光圈 ƒ/2）",
      /摄影机：机身 ARRI Alexa 35，镜头 Zeiss Ultra Prime，焦段 50mm，光圈 ƒ\/2/.test(lovartPrompt), "完整摄影机要求", lovartPrompt);
    record("R5 Lovart 尺寸与视觉要求在同一段【画面要求】", (lovartPrompt.match(/【画面要求】/g) || []).length === 1 && /画面比例 3:4，输出 1536×2048 像素/.test(lovartPrompt), "单段且含尺寸", lovartPrompt);
    record("R6 Lovart 联网要求进提示词", /联网搜索参考资料后再画/.test(lovartPrompt), "联网要求", lovartPrompt);
    record("R7 Lovart 请求体没有 size / aspect_ratio 字段", !!(lovartChat && lovartChat.body && !("size" in lovartChat.body) && !("aspect_ratio" in lovartChat.body)), "无字段", JSON.stringify(lovartChat && lovartChat.body).slice(0, 500));

    // ② APIMart：字段式适配器不许凭空加字段、提示词保持原样
    const apimartRun = await generateOnCanvas({ canvasId, configId: apimart.configId, prompt: "一只猫坐在窗边", style: "电影感", camera: CAMERA_INDEX, webSearch: true });
    const apimartSubmit = apimartMock.captures.filter((c) => c.path === "/v1/images/generations").slice(-1)[0];
    const apimartBody = apimartSubmit && apimartSubmit.body ? apimartSubmit.body : {};
    REPORT.captures.apimartRun = apimartRun;
    REPORT.captures.apimartBody = apimartBody;
    record("R8 APIMart 生成完成", !!(apimartRun.status && apimartRun.status.status === "DONE"), "DONE", JSON.stringify(apimartRun.status || {}));
    record("R9 APIMart 请求体不含 style / camera / web_search", !("style" in apimartBody) && !("camera" in apimartBody) && !("web_search" in apimartBody), "不含视觉字段", JSON.stringify(apimartBody));
    record("R10 APIMart 提示词保持原样（没被塞视觉要求）", apimartBody.prompt === "一只猫坐在窗边", "一只猫坐在窗边", String(apimartBody.prompt));
    record("R11 APIMart 尺寸仍走字段", apimartBody.size === "3:4" && String(apimartBody.resolution).toUpperCase() === "2K", "size=3:4 resolution=2K", JSON.stringify({ size: apimartBody.size, resolution: apimartBody.resolution }));

    REPORT.facts.providerRequests = { lovart: lovartMock.captures.length, apimart: apimartMock.captures.length };
  } catch (error) {
    fatal = String((error && error.stack) || error);
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
    await lovartMock.close().catch(() => {});
    await apimartMock.close().catch(() => {});
    try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const failed = REPORT.checks.filter((c) => !c.ok);
  REPORT.ok = failed.length === 0 && !fatal;
  if (fatal) REPORT.fatal = fatal;
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(REPORT, null, 2));
  if (fatal) console.log("FATAL " + fatal);
  console.log("RESULT " + JSON.stringify(REPORT));
  process.exit(REPORT.ok ? 0 : 1);
}

await main();
