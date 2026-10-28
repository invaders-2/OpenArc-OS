#!/usr/bin/env node
/**
 * task-35 C：用「用户最近失败 run」的参数在本地 mock 上游复现 413，并验证修复。
 *
 * 证据来源（只读查用户身份库，不动运行中的 App）：
 *   run_mvml2zwy_k9dcru / run_mvml28dl_3mgrdl · canvas cv_mvmd8tb1_qpd1w1 · node n_mvmkz0wjs3ro
 *   provider=APIMART(apib.ai) · model=seedance-2.0 · mode=首帧 · ratio=自适应 · res=720p · dur=5
 *   失败文案： PROVIDER_PROTOCOL_ERROR：参考图上传到 APIMart 失败：<html>…413 Request Entity Too Large…</html>
 *   参考图：六艺君子满格双十一盛典.png（1672×941 PNG，3.3MB，library/objects/sha256/aa/aa1250…）
 *
 * 步骤：
 *   1) 起 mock APIMart（上传 > 300KB 就返回 nginx 风格 413；模拟真机网关的小上限）；
 *   2) 先做「对照复现」：把原始 3.3MB 图片直接 POST 到上传端点 → 必须 413；
 *   3) 起真实 Electron（--user-data-dir 临时隔离 profile）→ 登录 → 登记 mock APIMart 服务商 + seedance-2.0；
 *   4) 把同一张图 importAsset 进画布，用失败 run 的参数走 canvas/nodes/execute（首帧视频，async）；
 *   5) 轮询 runStatus：DONE，且 mock 侧只收到压缩后的上传（≤300KB）、视频提交体里是 mock 上传后的 URL。
 *
 * 不付费、不联网（只有 127.0.0.1 mock）。
 */
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ART = path.join(ROOT, "artifacts", "gen-fix-2");
const USER_DATA = path.join(os.homedir(), "Library", "Application Support", "openarc-os");
const IDENTITY_DB = path.join(USER_DATA, "identity.db");
const ASSET_PATH = path.join(USER_DATA, "library", "objects", "sha256", "aa", "aa12507833beac976faa6ac9ffe7cf2a101e4bb30f27a24b7efce3b6a1b3b145");
const ADMIN = { id: "admin@gen-fix-2.test", pw: "gen-fix-2-1" };
const MOCK_UPLOAD_LIMIT = 300 * 1024;
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPORT = { checks: [], facts: {}, captures: {} };
const record = (name, ok, expected, actual) => {
  REPORT.checks.push({ name, ok: !!ok, expected: String(expected), actual: String(actual).slice(0, 5000) });
  console.log((ok ? "  PASS " : "! FAIL ") + name + " — 期望 " + expected + "；实际 " + String(actual).slice(0, 900));
  return !!ok;
};

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

/** 只读查用户库：最近失败 run 的参数 + 参考图节点（immutable=1，不动运行中的 App）。 */
function readFailedRunEvidence() {
  const fact = { source: IDENTITY_DB, queriedAt: Date.now() };
  try {
    const q = (sql) => JSON.parse(execFileSync("sqlite3", ["-json", "file:" + IDENTITY_DB + "?immutable=1", sql], { encoding: "utf8" }) || "[]");
    const runs = q("SELECT run_id, canvas_id, node_id, kind, status, started_at FROM canvas_runs WHERE canvas_id='cv_mvmd8tb1_qpd1w1' AND kind='video' ORDER BY started_at DESC LIMIT 6;");
    fact.runs = runs;
    const boards = q("SELECT doc FROM canvas_boards WHERE id='cv_mvmd8tb1_qpd1w1';");
    if (boards[0] && typeof boards[0].doc === "string") {
      const doc = JSON.parse(boards[0].doc);
      const node = (doc.nodes || []).find((n) => n.id === "n_mvmkz0wjs3ro") || null;
      fact.nodeParams = node && node.data && node.data.gen ? node.data.gen.params : null;
      fact.nodeError = node && node.data && node.data.gen ? node.data.gen.err : null;
      fact.inputNodes = (node && node.data && node.data.gen ? node.data.gen.order : []).map((edgeId) => {
        const edge = (doc.connections || []).find((c) => c.id === edgeId);
        const from = edge ? (doc.nodes || []).find((n) => n.id === edge.from) : null;
        return from ? { id: from.id, kind: from.kind, url: from.url || null, refs: from.data && from.data.gen ? from.data.gen.params : null } : null;
      }).filter(Boolean);
    }
  } catch (error) { fact.error = String((error && error.message) || error); }
  return fact;
}

function startMock(port) {
  const uploads = [];
  const videoSubmits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/v1/uploads/images") {
        uploads.push({ bytes: raw.length, at: Date.now() });
        if (raw.length > MOCK_UPLOAD_LIMIT) {
          res.writeHead(413, { "content-type": "text/html" });
          res.end("<html><head><title>413 Request Entity Too Large</title></head><body><h1>413 Request Entity Too Large</h1><hr><center>nginx</center></body></html>");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ url: "http://127.0.0.1:" + port + "/mock-uploaded-" + uploads.length + ".png" }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/videos/generations") {
        videoSubmits.push(JSON.parse(raw.toString("utf8")));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, data: [{ task_id: "task_genfix_2" }] }));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/tasks/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, data: { status: "completed", result: { videos: [{ url: ["http://127.0.0.1:" + port + "/mock-out.mp4"] }] } } }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unexpected " + req.method + " " + url.pathname } }));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({
    server, uploads, videoSubmits, baseUrl: "http://127.0.0.1:" + port,
    close: () => new Promise((d) => server.close(d)),
  })));
}

/** 对照复现：把原始参考图直接 multipart 上传到同一个 mock（真机就是这样 413 的）。 */
async function reproduceRawUpload(mockBaseUrl, pngBytes) {
  const form = new FormData();
  form.append("file", new Blob([pngBytes], { type: "image/png" }), "reference.png");
  const res = await fetch(mockBaseUrl + "/v1/uploads/images", { method: "POST", body: form });
  const text = await res.text();
  return { status: res.status, bytes: pngBytes.length, body: text.slice(0, 200) };
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
  for (;;) { try { if (await fn()) return true; } catch { /* retry */ } if (Date.now() >= end) return false; await sleep(step); }
}

async function launch(cdpPort) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-gen-fix-2-"));
  const env = { ...process.env };
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
    await setInput('[data-d3-id="setup-name"]', "Gen Fix Admin");
    await next();
    await waitFor(() => has('[data-d3-id="setup-identifier"]'), 10000);
    await setInput('[data-d3-id="setup-identifier"]', ADMIN.id);
    await next();
    await waitFor(() => has('[data-d3-id="setup-password"]'), 10000);
    await setInput('[data-d3-id="setup-password"]', ADMIN.pw);
    await setInput('[data-d3-id="setup-confirm"]', ADMIN.pw);
    await waitFor(() => js("const b = document.querySelector('[data-d3-id=\"setup-submit\"]'); return !b || !b.disabled;"), 10000);
    await clickDom('[data-d3-id="setup-submit"]');
    await waitFor(async () => (await gate()) === "unauthenticated", 30000);
  }
  await waitFor(() => has('[data-d3-id="login-identifier"]'), 30000);
  await setInput('[data-d3-id="login-identifier"]', ADMIN.id);
  await setInput('[data-d3-id="login-password"]', ADMIN.pw);
  await clickDom('[data-d3-id="login-submit"]');
  return await waitFor(async () => (await gate()) === "ready", 60000);
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const [mockPort, cdpPort] = await Promise.all([freePort(), freePort()]);
  const mock = await startMock(mockPort);
  const evidence = readFailedRunEvidence();
  REPORT.facts.failedRun = evidence;
  let fatal = null;
  try {
    if (!fs.existsSync(ASSET_PATH)) throw new Error("参考图文件不存在：" + ASSET_PATH);
    const png = fs.readFileSync(ASSET_PATH);
    const digest = crypto.createHash("sha256").update(png).digest("hex");
    REPORT.facts.referenceImage = { path: ASSET_PATH, bytes: png.length, sha256: digest, from: "identify by node n_mvmd8wq61y5t hist 1672x941" };
    record("R1 用户失败 run 的参数已读到（只读 identity.db）",
      !!(evidence.nodeParams && evidence.nodeError && /413/.test(String(evidence.nodeError))),
      "node params + 413 错误文案",
      JSON.stringify({ runs: (evidence.runs || []).slice(0, 2), nodeParams: evidence.nodeParams, nodeError: String(evidence.nodeError || "").slice(0, 160) }));

    // 对照复现：同一张原图直接上传 → 413（真机就是这样失败的）
    const control = await reproduceRawUpload(mock.baseUrl, png);
    REPORT.captures.controlRawUpload = control;
    record("R2 对照复现：原始参考图直传 mock 网关 → 413 且文案一致",
      control.status === 413 && /413 Request Entity Too Large/.test(control.body),
      "HTTP 413 + nginx 文案",
      JSON.stringify({ status: control.status, bytes: control.bytes, body: control.body }));

    await launch(cdpPort);
    const loggedIn = await setupAndLogin();
    record("R3 真实 Electron + 隔离 profile 登录", loggedIn, "gate=ready", "gate=" + (await gate()) + " userData=" + path.basename(userDataDir));

    const provider = await modelCmd({ type: "provider/create", displayName: "APIMART mock", baseUrl: mock.baseUrl, adapterType: "apimart", endpointScope: "LOCALHOST", scope: "ORGANIZATION", credentialSecret: "sk-gen-fix-2" });
    if (!provider || provider.ok !== true) throw new Error("provider/create 失败：" + JSON.stringify(provider));
    const model = await modelCmd({ type: "model/create", providerId: provider.provider.providerId, remoteModelId: "seedance-2.0", displayName: "seedance-2.0", capabilities: ["video-generation"], scope: "ORGANIZATION" });
    if (!model || model.ok !== true) throw new Error("model/create 失败：" + JSON.stringify(model));
    const configId = model.model.configId;
    const created = await canvasCmd({ command: "canvas/create", payload: { title: "413 复现" } });
    if (!created || created.ok !== true) throw new Error("canvas/create 失败：" + JSON.stringify(created));
    const canvasId = created.canvas.canvasId;
    const imported = await canvasCmd({ command: "canvas/importAsset", payload: { canvasId, name: "gen-fix-2-reference.png", dataUrl: "data:image/png;base64," + png.toString("base64") } });
    if (!imported || imported.ok !== true) throw new Error("importAsset 失败：" + JSON.stringify(imported).slice(0, 400));
    const ref = imported.ref || (imported.asset && imported.asset.ref) || null;
    record("R4 mock 服务商 + 模型 + 用户参考图已进隔离画布", !!configId && !!ref, "configId + asset ref", JSON.stringify({ configId, ref }));

    const failedParams = evidence.nodeParams || { mode: "首帧", ratio: "自适应", res: "720p", dur: 5, sound: false };
    const executed = await canvasCmd({
      command: "canvas/nodes/execute",
      payload: {
        canvasId, nodeId: "n_mvmkz0wjs3ro", async: true, type: "builtin.video-generator", writeBack: false,
        params: {
          configId,
          prompt: "让整体画面动起来（task-35 复现用）",
          modelType: "image_to_video",
          ratio: failedParams.ratio || "自适应",
          resolution: failedParams.res || "720p",
          duration: failedParams.dur || 5,
          generateAudio: typeof failedParams.sound === "boolean" ? failedParams.sound : false,
          count: 1, times: 1, multiShot: false,
          images: [ref], imageRefs: [ref], imageRoles: ["first_frame"],
          videos: [], videoRefs: [], audios: [], audioRefs: [],
        },
      },
    });
    if (!executed || executed.ok !== true) throw new Error("canvas/nodes/execute 失败：" + JSON.stringify(executed).slice(0, 600));
    const runId = executed.runId;
    const deadline = Date.now() + 120000;
    let status = null;
    while (Date.now() < deadline) {
      status = await canvasCmd({ command: "canvas/runStatus", payload: { canvasId, runId } });
      if (status && status.status && status.status !== "RUNNING") break;
      await sleep(400);
    }
    REPORT.captures.runStatus = status;
    REPORT.captures.uploads = mock.uploads;
    REPORT.captures.videoSubmit = mock.videoSubmits[0] || null;
    record("R5 视频 run 最终 DONE（修复后不再 413 失败）", !!(status && status.status === "DONE"), "DONE", JSON.stringify(status || {}).slice(0, 1200));
    // mock.uploads[0] 是 R2 的对照复现（原始 3.3MB 直传，已 413）；适配器的上传从 index 1 起。
    const adapterUploads = mock.uploads.slice(1);
    const rejected = adapterUploads.filter((u) => u.bytes > MOCK_UPLOAD_LIMIT).length;
    const accepted = adapterUploads.filter((u) => u.bytes <= MOCK_UPLOAD_LIMIT).length;
    record("R6 适配器先压缩再上传，超 mock 上限时逐级降档，最终被接受（对照：原图 " + Math.round(png.length / 1024) + "KB 直接 413）",
      adapterUploads.length >= 1 && accepted >= 1 && adapterUploads[adapterUploads.length - 1].bytes <= MOCK_UPLOAD_LIMIT,
      "至少一次被接受，最后一次 ≤" + Math.round(MOCK_UPLOAD_LIMIT / 1024) + "KB",
      JSON.stringify({ rejected, accepted, sizes: adapterUploads.map((u) => Math.round(u.bytes / 1024) + "KB") }));
    record("R7 适配器每次上传都远小于原图（确实先压缩过）",
      adapterUploads.length >= 1 && adapterUploads.every((u) => u.bytes < png.length * 0.5),
      "每次 < 原图一半",
      JSON.stringify({ originalKB: Math.round(png.length / 1024), uploadsKB: adapterUploads.map((u) => Math.round(u.bytes / 1024)) }));
    const submit = mock.videoSubmits[0] || {};
    const submitText = JSON.stringify(submit);
    const uploadedUrls = (submitText.match(/http:\/\/127\.0\.0\.1:\d+\/mock-uploaded-\d+\.png/g) || []).filter((value, index, list) => list.indexOf(value) === index);
    record("R8 视频提交体里是 mock 上传后的 URL（参考图不再是 data URL）",
      uploadedUrls.length >= 1 && !submitText.includes("data:image"),
      "提交体含 mock 上传地址、不含 data: 图片",
      JSON.stringify({ uploadedUrls, hasDataUrl: submitText.includes("data:image"), submit: submitText.slice(0, 500) }));
    REPORT.facts.mock = { uploadLimitBytes: MOCK_UPLOAD_LIMIT, uploads: mock.uploads.length, videoSubmits: mock.videoSubmits.length };
  } catch (error) {
    fatal = String((error && error.stack) || error);
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    try { if (child) child.kill("SIGKILL"); } catch { /* ignore */ }
    await mock.close().catch(() => {});
    try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const failed = REPORT.checks.filter((c) => !c.ok);
  REPORT.ok = failed.length === 0 && !fatal;
  if (fatal) REPORT.fatal = fatal;
  fs.writeFileSync(path.join(ART, "reproduction.json"), JSON.stringify(REPORT, null, 2));
  if (fatal) console.log("FATAL " + fatal);
  console.log("RESULT " + JSON.stringify(REPORT));
  process.exit(REPORT.ok ? 0 : 1);
}

await main();
