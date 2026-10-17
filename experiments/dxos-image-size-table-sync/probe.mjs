#!/usr/bin/env node
/**
 * DXOS-IMAGE-SIZE-TABLE-SYNC · 宿主尺寸表 × 上游 APIMart 官方 15 比例表。
 *
 * 只读核对 + 接口实测 + 画布生图尺寸链路：
 *   A. 解析 public/novai-canvas/static/js/smart-canvas.js 的 SIZE_MAP（官方 15 比例 × 1k/2k/4k）；
 *   B. 宿主 electron/image-params.cjs 的 IMAGE_SIZE_TABLE 逐格对表；与对齐前的旧 9 比例表算 13 个差异格；
 *   C. 走真实 openarc-bridge.js 调 GET /api/ai/size-policy（宿主 model.sizePolicy 的返回物），
 *      核对下发的 sizes / gptSizes；
 *   D. 用端点真实回包加载页面 shared/size-policy.js + 从 smart-canvas.js 抽取的 apiImageSize，
 *      对 15×3 逐格比对页面出图尺寸与宿主 resolveImageSize；
 *   E. 真实 CanvasService.modelCall + 本地确定性 provider（按请求 size 出 PNG），确认请求 size 与页面/宿主一致。
 *
 * 运行：node experiments/dxos-image-size-table-sync/probe.mjs
 * 产物：artifacts/dxos-image-size-table-sync/{size-table-diff,endpoint-size-policy,page-size-matrix,probe-result}.json
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import net from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createModelFixture } from "../../tests/model-fixtures.mjs";
import { startSizePolicyProvider, pngDimsFromDataUrl } from "../dxos-canvas-size-policy/provider.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "dxos-image-size-table-sync");
const LEVELS = ["1k", "2k", "4k"];
const PAGE_JS = fs.readFileSync(path.join(ROOT, "public/novai-canvas/static/js/smart-canvas.js"), "utf8");
const SIZE_POLICY_JS = fs.readFileSync(path.join(ROOT, "public/novai-canvas/static/js/shared/size-policy.js"), "utf8");
const BRIDGE_JS = fs.readFileSync(path.join(ROOT, "public/novai-canvas/openarc-bridge.js"), "utf8");
const imageParams = require(path.join(ROOT, "electron/image-params.cjs"));
const { CanvasStore } = require(path.join(ROOT, "electron/canvas-store.cjs"));
const { CanvasService } = require(path.join(ROOT, "electron/canvas-service.cjs"));

const OFFICIAL_DOC = "https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation";
const checks = [];
const fail = (label, detail) => { checks.push({ ok: false, label, detail: detail === undefined ? null : detail }); console.error("  ✗ " + label + (detail === undefined ? "" : "：" + detail)); };
const ok = (cond, label, detail) => { if (cond) checks.push({ ok: true, label, detail: detail === undefined ? null : detail }); else fail(label, detail); };

/** 对齐前宿主的旧 9 比例表（= re-vendor 前上游 canvas.js 的 SIZE_MAP，git HEAD 可查）。*/
const LEGACY_HOST_SIZE_TABLE = {
  square: { "1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096" },
  portrait: { "1k": "1024x1536", "2k": "1360x2048", "4k": "2352x3520" },
  portrait43: { "1k": "1008x1344", "2k": "1536x2048", "4k": "2448x3264" },
  landscape43: { "1k": "1344x1008", "2k": "2048x1536", "4k": "3264x2448" },
  landscape: { "1k": "1536x1024", "2k": "2048x1360", "4k": "3520x2352" },
  story: { "1k": "720x1280", "2k": "1152x2048", "4k": "2160x3840" },
  wide: { "1k": "1280x720", "2k": "2048x1152", "4k": "3840x2160" },
  ultrawide: { "1k": "1280x544", "2k": "2048x880", "4k": "3840x1648" },
  ultratall: { "1k": "544x1280", "2k": "880x2048", "4k": "1648x3840" },
};

function parseSizeMap(src) {
  const block = /const SIZE_MAP = \{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error("smart-canvas.js 缺少 SIZE_MAP");
  const rows = {};
  const re = /(\w+):\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(block[1]))) {
    const cells = {};
    for (const c of m[2].matchAll(/'?(\d?k)'?\s*:\s*'(\d+x\d+)'/g)) cells[c[1]] = c[2];
    rows[m[1]] = cells;
  }
  return rows;
}

function extractFunction(srcText, name) {
  const re = new RegExp("(?:^|\\n)(?:async\\s+)?function\\s+" + name + "\\s*\\(");
  const m = re.exec(srcText);
  if (!m) throw new Error("smart-canvas.js 缺少函数 " + name);
  const start = m.index + (m[0].charAt(0) === "\n" ? 1 : 0);
  let depth = 0;
  let i = srcText.indexOf("{", start);
  for (; i < srcText.length; i += 1) {
    if (srcText[i] === "{") depth += 1;
    else if (srcText[i] === "}") { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  if (depth !== 0) throw new Error("函数抽取失败 " + name);
  return srcText.slice(start, i);
}
function extractConst(srcText, name) {
  const idx = srcText.indexOf("const " + name + " ");
  if (idx < 0) throw new Error("smart-canvas.js 缺少常量 " + name);
  let depth = 0;
  let i = srcText.indexOf("=", idx);
  for (; i < srcText.length; i += 1) {
    const c = srcText[i];
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    else if (c === ";" && depth === 0) { i += 1; break; }
  }
  return srcText.slice(idx, i);
}

class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k) { return this.map.has(String(k)) ? this.map.get(String(k)) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
  clear() { this.map.clear(); }
}
class FakeCustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 真实 openarc-bridge.js：GET /api/ai/size-policy → 宿主 model.sizePolicy 调用 → 回包 JSON。*/
function loadBridge() {
  const posted = [];
  const listeners = {};
  const win = {
    top: null, self: null, window: null,
    parent: { postMessage: (msg) => { posted.push(msg); } },
    location: { href: "openarc-canvas://bundle/static/canvas.html", origin: "openarc-canvas://bundle", hash: "" },
    localStorage: new FakeStorage(), sessionStorage: new FakeStorage(),
    XMLHttpRequest: class FakeXHR {}, WebSocket: class FakeWebSocket {},
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    fetch: async () => new Response("", { status: 200 }),
  };
  win.top = win; win.self = win; win.window = win;
  const doc = { documentElement: { setAttribute: () => {} }, addEventListener: () => {}, removeEventListener: () => {} };
  const sandbox = {
    window: win, document: doc, console, Response, ReadableStream, TextEncoder, TextDecoder, URL, DOMException, CustomEvent: FakeCustomEvent,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, FormData: undefined, FileReader: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_JS, sandbox, { filename: "openarc-bridge.js" });
  const fire = (data) => { for (const fn of listeners.message || []) fn({ data, source: null }); };
  fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "hello", token: "tok-size-table", readOnly: false, canEdit: true, canvasId: "cv-size", accountKey: "k-size", reducedMotion: false });
  const lastCall = (method) => [...posted].reverse().find((m) => m.kind === "call" && m.method === method) || null;
  return { win, posted, fire, lastCall };
}

async function callSizePolicyEndpoint(policyTable) {
  const b = loadBridge();
  const pending = b.win.fetch("/api/ai/size-policy", { method: "GET", headers: { Accept: "application/json" } });
  await tick();
  const call = b.lastCall("model.sizePolicy");
  if (!call) throw new Error("桥没有登记 model.sizePolicy");
  b.fire({ ch: "openarc.canvas", dir: "host->canvas", kind: "result", id: call.id, ok: true, value: policyTable });
  const res = await pending;
  const body = await res.json();
  return { status: res.status, call, body };
}

async function loadPageApiImageSize(policyBody) {
  const code = [
    extractConst(PAGE_JS, "SIZE_MAP"),
    extractConst(PAGE_JS, "API_RES_LEVELS"),
    extractConst(PAGE_JS, "RES_LONG_SIDE"),
    extractConst(PAGE_JS, "RES_PIXEL_LIMIT_FALLBACK"),
    ...["parseRatioValue", "parseSizePair", "resPixelLimitFor", "fitApiSizePair", "oaTierFit", "apiImageSize"].map((n) => extractFunction(PAGE_JS, n)),
    "window.__apiImageSize = apiImageSize;",
  ].join("\n");
  const sandbox = { window: {}, fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(policyBody)) }) };
  vm.createContext(sandbox);
  vm.runInContext(SIZE_POLICY_JS, sandbox, { filename: "size-policy.js" });
  await sandbox.window.NovaSizePolicy.load();
  sandbox.NovaSizePolicy = sandbox.window.NovaSizePolicy;
  sandbox.parseSizeValue = (value) => {
    const m = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(String(value || "").trim());
    return m ? { width: m[1], height: m[2] } : null;
  };
  sandbox.modelTierPixelFor = () => "";
  vm.runInContext(code, sandbox, { filename: "smart-canvas-apiImageSize.js" });
  return sandbox.window.__apiImageSize;
}

function fakeRuntime() {
  const taskService = {
    getTask: () => ({ ok: true, task: { revision: 1, cancelRequested: false, status: "RUNNING" } }),
    getTaskBudget: () => ({ ok: true, remaining: { MODEL_CALLS: 10 }, authorized: {}, consumed: {} }),
    checkModelConfig: () => ({ ok: true }),
    startModelCall: () => ({ ok: true, call: { callId: "call_size" } }),
    completeModelCall: () => ({ ok: true }),
    failModelCall: () => ({ ok: true }),
    recordBudgetConsumption: () => ({ ok: true }),
  };
  return { taskService };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function toMarkdownDiff(diff) {
  const lines = [
    "| 比例 | 档位 | 宿主旧值 | 上游官方值（采纳） | 谁对 | 判定依据 |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of diff.rows) lines.push("| " + row.ratio + " | " + row.level + " | " + row.hostBefore + " | " + row.adopted + " | 上游 | " + row.basis + " |");
  return lines.join("\n");
}

async function main() {
  fs.mkdirSync(ART, { recursive: true });
  const upstream = parseSizeMap(PAGE_JS);
  const host = JSON.parse(JSON.stringify(imageParams.IMAGE_SIZE_TABLE));
  const gptHost = JSON.parse(JSON.stringify(imageParams.GPT_IMAGE_SIZE_TABLE));

  // ── A/B. 表对表 + 历史差异 ────────────────────────────────────────────────
  ok(Object.keys(upstream).length === 15, "上游 SIZE_MAP 是 15 比例", Object.keys(upstream).length);
  ok(Object.keys(host).length === 15, "宿主 IMAGE_SIZE_TABLE 是 15 比例", Object.keys(host).length);
  ok(JSON.stringify(host) === JSON.stringify(upstream), "宿主表与上游 SIZE_MAP 逐格一致", "45 格");
  const diffRows = [];
  const addedRows = [];
  for (const ratio of Object.keys(upstream)) {
    for (const level of LEVELS) {
      const before = LEGACY_HOST_SIZE_TABLE[ratio] ? LEGACY_HOST_SIZE_TABLE[ratio][level] : undefined;
      const after = upstream[ratio][level];
      if (before === undefined) {
        addedRows.push({ ratio, level, adopted: after });
      } else if (before !== after) {
        diffRows.push({
          ratio, level, hostBefore: before, upstream: after, adopted: after, verdict: "upstream",
          basis: "上游官方值（APIMart gpt-image-2 generation 文档的 size×resolution 映射）",
          reason: "上游 SIZE_MAP 注释、tests/test_size_map_official.js 与 main.py APIMART_OFFICIAL_PIXELS 三处同源；宿主旧值是 re-vendor 前 canvas.js 的通用 9 比例表，不是官方表，因此以官方值为准。",
        });
      }
    }
  }
  const addedRatios = Object.keys(upstream).filter((k) => !LEGACY_HOST_SIZE_TABLE[k]);
  ok(diffRows.length === 13, "旧宿主表与官方表恰好 13 个差异格", diffRows.length);
  ok(addedRatios.length === 6, "官方表新增 6 个比例", addedRatios.join(","));
  const diff = {
    capturedAt: new Date().toISOString(),
    officialDoc: OFFICIAL_DOC,
    upstreamSource: "public/novai-canvas/static/js/smart-canvas.js · SIZE_MAP",
    hostSource: "electron/image-params.cjs · IMAGE_SIZE_TABLE",
    hostBeforeSource: "对齐前宿主表 = re-vendor 前上游 static/js/canvas.js 的 SIZE_MAP（git HEAD 可查；旧通用 9 比例表，非 APIMart 官方表）",
    adoptedRule: "13 个差异格全部采纳上游官方值；新增 6 个比例按官方表补齐；宿主只做数据对齐，宽高算法未改",
    counts: { upstreamRatios: 15, hostBeforeRatios: 9, hostRatios: 15, diffCells: diffRows.length, addedRatios: addedRatios.length, cells: 15 * 3 },
    addedRatios,
    addedCells: addedRows,
    rows: diffRows,
  };
  fs.writeFileSync(path.join(ART, "size-table-diff.json"), JSON.stringify(diff, null, 2) + "\n");

  // ── C. 真实桥端点 ────────────────────────────────────────────────────────
  const policyTable = imageParams.buildSizePolicyTable([
    { key: "gpt-image-2", model: "gpt-image-2" },
    { key: "openai/gpt-image-2.5", model: "openai/gpt-image-2.5" },
    { key: "flux-pro", model: "flux-pro" },
  ]);
  const endpoint = await callSizePolicyEndpoint(policyTable);
  ok(endpoint.status === 200, "GET /api/ai/size-policy 返回 200", endpoint.status);
  ok(endpoint.body.format === "novai-size-policy/v1", "端点 format 正确", endpoint.body.format);
  ok(JSON.stringify(endpoint.body.sizes) === JSON.stringify(upstream), "端点 sizes 与上游官方表逐格一致", "45 格");
  ok(JSON.stringify(endpoint.body.gptSizes) === JSON.stringify(gptHost), "端点 gptSizes 与宿主派生表逐格一致", "45 格");
  ok(endpoint.body.models["gpt-image-2"] && endpoint.body.models["gpt-image-2"].mode === "enum", "gpt-image-2 策略仍为 enum");
  fs.writeFileSync(path.join(ART, "endpoint-size-policy.json"), JSON.stringify({
    capturedAt: new Date().toISOString(),
    route: "openarc-bridge.js GET /api/ai/size-policy → host model.sizePolicy",
    status: endpoint.status,
    format: endpoint.body.format,
    modelKeys: Object.keys(endpoint.body.models || {}).sort(),
    sizes: endpoint.body.sizes,
    gptSizes: endpoint.body.gptSizes,
    defaultTiers: endpoint.body.default && endpoint.body.default.tiers,
    matchesUpstreamSizeMap: true,
  }, null, 2) + "\n");

  // ── D. 页面真实 apiImageSize × 宿主 ───────────────────────────────────────
  const apiImageSize = await loadPageApiImageSize(endpoint.body);
  const matrix = [];
  for (const ratio of Object.keys(upstream)) {
    for (const level of LEVELS) {
      const pageFree = apiImageSize(ratio, level, "", "", "flux-pro");
      const hostFree = imageParams.resolveImageSize({ ratio, resolution: level });
      const pageGpt = apiImageSize(ratio, level, "", "", "gpt-image-2");
      const hostGpt = imageParams.resolveImageSize({ ratio, resolution: level, model: "gpt-image-2" });
      ok(pageFree === hostFree, "页面/宿主 free 一致 " + ratio + "@" + level, pageFree + " vs " + hostFree);
      ok(pageGpt === hostGpt, "页面/宿主 gpt-image-2 一致 " + ratio + "@" + level, pageGpt + " vs " + hostGpt);
      matrix.push({ ratio, level, official: upstream[ratio][level], pageFree, hostFree, pageGpt, hostGpt, officialCellIsSentAsIs: pageFree === upstream[ratio][level] });
    }
  }
  ok(matrix.length === 45, "页面 15×3 矩阵 45 格", matrix.length);
  const customCases = [
    { ratio: "1:1", level: "1k" }, { ratio: "4:3", level: "1k" }, { ratio: "3:4", level: "1k" },
    { ratio: "1:1", level: "4k" }, { ratio: "3:2", level: "4k" }, { ratio: "2:3", level: "4k" },
  ].map((c) => {
    const page = apiImageSize("custom", c.level, c.ratio, "", "flux-pro");
    const parts = c.ratio.split(":").map(Number);
    const host = imageParams.sizeFromRatio(parts[0] / parts[1], c.level);
    ok(page === host, "custom " + c.ratio + "@" + c.level + " 页面/宿主一致", page + " vs " + host);
    return { ...c, page, host };
  });
  fs.writeFileSync(path.join(ART, "page-size-matrix.json"), JSON.stringify({ capturedAt: new Date().toISOString(), rows: matrix, customCases }, null, 2) + "\n");

  // ── E. 真实 CanvasService.modelCall + 确定性 provider ──────────────────────
  const port = await freePort();
  const providerServer = await startSizePolicyProvider({ port });
  const chainRows = [];
  let fixture = null;
  try {
    fixture = await createModelFixture();
    const f = fixture;
    f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
    f.store.upsertApp({ appId: "canvas", name: "无限画布", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
    const admin = f.adminCtx();
    f.modelService.grantAppModelAccess({ context: admin, appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });
    f.modelService.grantAppModelAccess({ context: admin, appId: "canvas", actions: ["model.view", "model.use"] });
    const settingsCtx = { ...admin, appId: "settings" };
    const createdProvider = f.modelService.createProvider({
      context: settingsCtx, displayName: "Size table probe", baseUrl: providerServer.baseUrl, credentialSecret: "FAKE_SIZE_TABLE_PROBE",
    });
    if (!createdProvider.ok) throw new Error("provider: " + JSON.stringify(createdProvider));
    const createdModel = f.modelService.createModel({
      context: settingsCtx, providerId: createdProvider.provider.providerId, remoteModelId: "flux-pro", capabilities: ["image-generation"],
    });
    if (!createdModel.ok) throw new Error("model: " + JSON.stringify(createdModel));
    const setDefault = f.modelService.setDefault({ context: settingsCtx, capability: "image-generation", configId: createdModel.model.configId });
    if (!setDefault.ok) throw new Error("default: " + JSON.stringify(setDefault));

    const store = new CanvasStore({ identity: f.identity, clock: f.clock });
    const service = new CanvasService({ identity: f.identity, store, resourceStore: f.resourceStore, authService: f.authService, clock: f.clock });
    const context = { sessionRef: f.sessions.admin, appId: "canvas", source: "ui" };
    const created = service.createCanvas({ context, title: "尺寸表探针" });
    if (!created.ok) throw new Error("canvas: " + JSON.stringify(created));
    const canvasId = created.canvas.canvasId;
    const userId = f.identity.validateSession(f.sessions.admin, { sensitive: false }).user.id;
    service.attachRuntime({ ...fakeRuntime(), modelService: f.modelService });

    const cases = [
      { label: "square@4k / free", node: { ratio: "square", resolution: "4k" }, page: ["square", "4k", "", "", "flux-pro"], host: { ratio: "square", resolution: "4k" } },
      { label: "ultrawide@1k / free", node: { ratio: "ultrawide", resolution: "1k" }, page: ["ultrawide", "1k", "", "", "flux-pro"], host: { ratio: "ultrawide", resolution: "1k" } },
      { label: "portrait12@2k / free", node: { ratio: "portrait12", resolution: "2k" }, page: ["portrait12", "2k", "", "", "flux-pro"], host: { ratio: "portrait12", resolution: "2k" } },
      { label: "5:4@2k / free", node: { ratio: "landscape54", resolution: "2k" }, page: ["landscape54", "2k", "", "", "flux-pro"], host: { ratio: "landscape54", resolution: "2k" } },
      { label: "3:1@1k / free", node: { ratio: "landscape31", resolution: "1k" }, page: ["landscape31", "1k", "", "", "flux-pro"], host: { ratio: "landscape31", resolution: "1k" } },
      { label: "custom 1:1@1k", node: { ratio: "custom", resolution: "1k", customRatio: "1:1" }, page: ["custom", "1k", "1:1", "", "flux-pro"], host: { ratio: "custom", resolution: "1k", customRatio: "1:1" } },
      { label: "square@4k / gpt-image-2", node: { ratio: "square", resolution: "4k", model: "gpt-image-2" }, page: ["square", "4k", "", "", "gpt-image-2"], host: { ratio: "square", resolution: "4k", model: "gpt-image-2" } },
    ];

    for (const item of cases) {
      const pageSize = apiImageSize(...item.page);
      const hostSize = imageParams.resolveImageSize(item.host);
      ok(pageSize === hostSize, "链路期望值 页面=宿主 " + item.label, pageSize + " vs " + hostSize);
      const nodeId = "gen_" + Math.random().toString(36).slice(2, 8);
      const added = service.applyCommand({
        context, canvasId, baseRevision: store.boardById(canvasId).revision,
        command: { type: "node.add", node: { id: nodeId, type: "generator", x: 0, y: 0, ...item.node } },
      });
      if (!added.ok) throw new Error("node.add: " + JSON.stringify(added));
      const revision = Number(store.boardById(canvasId).revision);
      const run = store.insertRun({
        runId: "run_" + Math.random().toString(36).slice(2, 8), canvasId, nodeId,
        kind: "image", actorUserId: userId, taskId: "task_size_probe", baseRevision: revision,
      });
      const res = await service.modelCall({ context, canvasId, runId: run.run_id, kind: "image", prompt: "size-table-probe" });
      ok(res.ok, "modelCall 成功 " + item.label, JSON.stringify(res).slice(0, 300));
      const state = providerServer.state();
      const request = state.images[state.images.length - 1];
      ok(!!request, "provider 收到请求 " + item.label);
      if (request) ok(request.size === hostSize, "provider 请求 size = 宿主尺寸 " + item.label, request.size + " vs " + hostSize);
      if (request) ok(request.requested === true && request.width + "x" + request.height === hostSize, "provider 解析出的像素 = 宿主尺寸 " + item.label, request.width + "x" + request.height);
      const dims = res.ok && res.images && res.images[0] ? pngDimsFromDataUrl(res.images[0].dataUrl) : null;
      if (dims) {
        const [ew, eh] = hostSize.split("x").map(Number);
        ok(dims.width === Math.min(ew, 2048) && dims.height === Math.min(eh, 2048), "返回图 IHDR 尺寸符合请求（provider 上限 2048） " + item.label, dims.width + "x" + dims.height);
      }
      chainRows.push({
        label: item.label, pageSize, hostSize,
        requestSize: request ? request.size : null,
        requestPixels: request ? request.width + "x" + request.height : null,
        returnedPng: dims ? dims.width + "x" + dims.height : null,
        modelCallOk: !!res.ok,
      });
    }
  } finally {
    if (fixture) { try { fixture.close(); } catch { /* ignore */ } }
    await providerServer.close();
  }

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  const result = {
    capturedAt: new Date().toISOString(),
    officialDoc: OFFICIAL_DOC,
    summary: { checks: checks.length, passed, failed },
    table: { upstreamRatios: 15, hostRatios: 15, diffCells: diffRows.length, addedRatios, cells: 45 },
    endpoint: { status: endpoint.status, format: endpoint.body.format, modelKeys: Object.keys(endpoint.body.models || {}).sort() },
    chain: chainRows,
    failures: checks.filter((c) => !c.ok),
    checks,
  };
  fs.writeFileSync(path.join(ART, "probe-result.json"), JSON.stringify(result, null, 2) + "\n");
  fs.writeFileSync(path.join(ART, "size-table-diff.md"), [
    "# APIMart 官方 15 比例表 × 宿主对齐差异表",
    "",
    "官方口径：" + OFFICIAL_DOC,
    "",
    toMarkdownDiff(diff),
    "",
    "新增比例：" + addedRatios.join("、"),
    "",
  ].join("\n"));

  console.log("=== size table diff (" + diffRows.length + " cells) ===");
  for (const row of diffRows) console.log("  " + row.ratio + "@" + row.level + "  host=" + row.hostBefore + " -> adopted=" + row.adopted);
  console.log("added ratios: " + addedRatios.join(", "));
  console.log("=== endpoint ===");
  console.log("  status=" + endpoint.status + " sizes=15x3 gptSizes=15x3 modelKeys=" + Object.keys(endpoint.body.models || {}).join(","));
  console.log("=== chain ===");
  for (const row of chainRows) console.log("  " + row.label + "  host=" + row.hostSize + "  request=" + row.requestSize + "  png=" + row.returnedPng);
  console.log("=== checks: " + passed + " pass / " + failed + " fail ===");
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
