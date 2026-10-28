/**
 * 风格 / 摄影机 / 联网「真转发」（task-27）。
 *
 * 链路：
 *   canvas/modelImage（canvas-bootstrap 解析 + 边界归一）
 *     → canvas-service.modelCall / startAsyncModelCall
 *     → model-service.generateImage
 *     → 对话式（Lovart：SIZE_VIA_PROMPT）写进提示词【画面要求】；字段式（APIMart）只在 uiSpec 说支持时带字段。
 *
 * 覆盖：
 *   ① 边界归一：style ≤40、camera 字符串/索引（越界夹到边界）、webSearch 只认 true；
 *      取值表与画布页 CAMERAS 一致（漂移核对）；
 *   ② canvas-service 真的把 style / camera / webSearch 传给 generateImage（params + hints）；
 *   ③ Lovart：提示词含「风格：…」「摄影机：机身 …，镜头 …，焦段 …mm，光圈 …」「联网…」；未提供不出现；
 *   ④ Lovart 适配器直调 generateComplete 时同样消费 params（不重复写）；
 *   ⑤ APIMart：uiSpec 未声明 style/camera → 请求体不加字段、提示词保持原样。
 *
 * 全部离线：mock fetch 捕获请求体，不联网、不花钱。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { createModelFixture } from "./model-fixtures.mjs";

const require = createRequire(import.meta.url);
const canvasBootstrap = require("../electron/canvas-bootstrap.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");
const lovart = require("../electron/provider-adapter-lovart.cjs");
const apimart = require("../electron/provider-adapter-apimart.cjs");

process.env.APM_FAST = "1";

const LOVART_CREDENTIAL = JSON.stringify({ accessKey: "ak-style", secretKey: "sk-style" });
const LOVART_ARTIFACT = "https://a.lovart.ai/artifacts/agent/style.png";

function response(body) {
  return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify(body), json: async () => body };
}

/** Lovart 三段式桩：project/save → chat（记请求体）→ status → result。 */
function lovartFetch(calls, artifact = LOVART_ARTIFACT) {
  return async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (body) calls.push({ path, body });
    if (path.endsWith("/project/save")) return response({ code: 0, data: { project_id: "p1" } });
    if (path.endsWith("/chat")) return response({ code: 0, data: { thread_id: "t1" } });
    if (path.endsWith("/chat/status")) return response({ code: 0, data: { status: "done" } });
    if (path.endsWith("/chat/result")) return response({ code: 0, data: { final_status: "done", items: [{ artifacts: [{ content: artifact, type: "image" }] }] } });
    return response({ code: 0, data: {} });
  };
}

async function modelFixture({ provider, model, capability, fetchImpl }) {
  const f = await createModelFixture({ fetchImpl });
  f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });
  const context = { ...f.adminCtx(), appId: "settings" };
  const created = f.modelService.createProvider({ context, ...provider });
  assert.equal(created.ok, true, JSON.stringify(created));
  const spec = f.modelService.createModel({ context, providerId: created.provider.providerId, remoteModelId: model, capabilities: [capability] });
  assert.equal(spec.ok, true, JSON.stringify(spec));
  assert.equal(f.modelService.setDefault({ context, capability, configId: spec.model.configId }).ok, true);
  return { f, context, configId: spec.model.configId, close: () => f.close() };
}

const CAMERA = { body: "ARRI Alexa 35", lens: "Zeiss Ultra Prime", focal: "75mm", aperture: "ƒ/2" };

/* ══ ① 边界归一 ══ */

test("① 边界归一：style ≤40、camera 索引越界夹到边界、webSearch 只认 true", () => {
  assert.equal(canvasBootstrap.sanitizeStyle("  "), null);
  assert.equal(canvasBootstrap.sanitizeStyle(42), null);
  assert.equal(canvasBootstrap.sanitizeStyle(" 电 影 感 "), "电 影 感");
  assert.equal(canvasBootstrap.sanitizeStyle("长".repeat(80)).length, 40);

  // 索引：正常 / 越界（负数与超大）都收敛到合法项
  assert.deepEqual(canvasBootstrap.sanitizeCamera({ body: 1, lens: 2, focal: 4, aperture: 0 }), {
    body: "Arri Alexa 35", lens: "Canon K-35", focal: 50, aperture: "ƒ/1.4",
  });
  const clamped = canvasBootstrap.sanitizeCamera({ body: -3, lens: 99, focal: 3, aperture: 2.7 });
  assert.deepEqual(clamped, { body: "Sony Venice", lens: "Hawk Class X", focal: 35, aperture: "ƒ/11" });
  // 字符串原样（≤40）
  assert.deepEqual(canvasBootstrap.sanitizeCamera({ body: "自定义机身", lens: "长".repeat(80) }).body, "自定义机身");
  assert.equal(canvasBootstrap.sanitizeCamera({ lens: "长".repeat(80) }).lens.length, 40);
  // 空对象 / 非对象 / 空值 → 不发送
  assert.equal(canvasBootstrap.sanitizeCamera({}), null);
  assert.equal(canvasBootstrap.sanitizeCamera(null), null);
  assert.equal(canvasBootstrap.sanitizeCamera({ body: "" }), null);

  assert.deepEqual(canvasBootstrap.imagePanelOptions({ style: " 电影感 ", camera: { body: 0 }, webSearch: true }), {
    style: "电影感", camera: { body: "Sony Venice" }, webSearch: true,
  });
  assert.deepEqual(canvasBootstrap.imagePanelOptions({ style: "", camera: null, webSearch: "yes" }), {});
});

test("①b 摄影机取值表与画布页 CAMERAS 一致（漂移核对）", async () => {
  const { CAMERAS } = await import("../src/canvas/canvas-next/model.ts");
  assert.deepEqual([...canvasBootstrap.CAMERA_PARTS.body], [...CAMERAS.body]);
  assert.deepEqual([...canvasBootstrap.CAMERA_PARTS.lens], [...CAMERAS.lens]);
  assert.deepEqual([...canvasBootstrap.CAMERA_PARTS.focal], [...CAMERAS.focal]);
  assert.deepEqual([...canvasBootstrap.CAMERA_PARTS.aperture], [...CAMERAS.aperture]);
});

/* ══ ② canvas-service 透传 ══ */

async function canvasFixture() {
  const fx = await createResourceFixture();
  const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });
  const context = { sessionRef: fx.sessions.admin, appId: "canvas", source: "ui" };
  const created = service.createCanvas({ context, title: "风格摄影机" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const calls = [];
  const taskService = {
    createTask: () => ({ ok: true, task: { taskId: "task_style_1", revision: 1 } }),
    startTask: () => ({ ok: true }),
    getTask: () => ({ ok: true, task: { revision: 1, cancelRequested: false, status: "RUNNING" } }),
    getTaskBudget: () => ({ ok: true, remaining: { MODEL_CALLS: 10 }, authorized: {}, consumed: {} }),
    checkModelConfig: () => ({ ok: true }),
    startModelCall: () => ({ ok: true, call: { callId: "call_1" } }),
    completeModelCall: () => ({ ok: true }), failModelCall: () => ({ ok: true }), recordBudgetConsumption: () => ({ ok: true }),
  };
  const modelService = {
    resolveModel: () => ({ ok: true, model: { configId: "m1" } }),
    generateImage: async (input) => { calls.push(input); return { ok: true, images: [{ url: "openarc-asset:styled" }], requestId: "ireq_test" }; },
  };
  service.attachRuntime({ taskService, modelService });
  const started = service.startRun({ context, canvasId: created.canvas.canvasId, kind: "image" });
  assert.equal(started.ok, true, JSON.stringify(started));
  return { fx, service, context, canvasId: created.canvas.canvasId, runId: started.runId, calls };
}

test("② canvas-service.modelCall 把 style / camera / webSearch 传给 generateImage（params + hints）", async () => {
  const f = await canvasFixture();
  try {
    const out = await f.service.modelCall({
      context: f.context, canvasId: f.canvasId, runId: f.runId, kind: "image", prompt: "一只猫",
      ratio: "3:4", resolution: "2K", style: "电影感", camera: CAMERA, webSearch: true,
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const call = f.calls[0];
    assert.equal(call.prompt, "一只猫");
    assert.deepEqual(call.params.style, "电影感");
    assert.deepEqual(call.params.camera, CAMERA);
    assert.equal(call.params.webSearch, true);
    assert.equal(call.hints.style, "电影感");
    assert.deepEqual(call.hints.camera, CAMERA);
    assert.equal(call.hints.webSearch, true);
    assert.equal(call.hints.ratio, "3:4");
  } finally { f.fx.close(); }
});

test("②b startAsyncModelCall 同样透传（异步 run 路径）", async () => {
  const f = await canvasFixture();
  try {
    const started = f.service.startAsyncModelCall({
      context: f.context, canvasId: f.canvasId, runId: f.runId, prompt: "一只猫",
      ratio: "1:1", resolution: "1K", style: "胶片", camera: { body: 1 }, webSearch: false,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    const deadline = Date.now() + 3000;
    while (!f.calls.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const call = f.calls[0];
    assert.ok(call, "异步路径必须真的调用 generateImage");
    assert.equal(call.params.style, "胶片");
    assert.deepEqual(call.params.camera, { body: 1 });
    assert.equal("webSearch" in call.params, false, "webSearch=false 不发送（不造空字段）");
    assert.equal(call.hints.style, "胶片");
    assert.deepEqual(call.hints.camera, { body: 1 });
    assert.equal("webSearch" in call.hints, false);
  } finally { f.fx.close(); }
});

/* ══ ③ Lovart：提示词真带上风格 / 摄影机 ══ */

test("③ Lovart：提示词含风格与摄影机要求，尺寸要求并进同一段【画面要求】", async () => {
  const calls = [];
  const fx = await modelFixture({
    provider: { displayName: "Lovart", baseUrl: "https://lgw.lovart.ai", adapterType: "lovart", credentialSecret: LOVART_CREDENTIAL },
    model: "generate_image_seedream_v5_pro",
    capability: "image-generation",
    fetchImpl: lovartFetch(calls),
  });
  try {
    const out = await fx.f.modelService.generateImage({
      context: fx.context, prompt: "一只猫", size: "1536x2048", count: 1,
      hints: { ratio: "3:4", resolution: "2K", style: "电影感", camera: CAMERA, webSearch: true },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const chat = calls.find((call) => call.path.endsWith("/chat"));
    assert.ok(chat, "Lovart 走 chat 入口");
    const prompt = chat.body.prompt;
    assert.match(prompt, /^一只猫/);
    assert.match(prompt, /【画面要求】/);
    assert.match(prompt, /画面比例 3:4，输出 1536×2048 像素/);
    assert.match(prompt, /风格：电影感/);
    assert.match(prompt, /摄影机：机身 ARRI Alexa 35，镜头 Zeiss Ultra Prime，焦段 75mm，光圈 ƒ\/2/);
    assert.match(prompt, /联网搜索参考资料后再画/);
    // 一句话里只出现一次（尺寸 + 视觉要求合并，不重复起段）
    assert.equal((prompt.match(/【画面要求】/g) || []).length, 1);
    assert.equal("size" in chat.body, false, "对话式没有 size 字段");
    assert.equal("aspect_ratio" in chat.body, false);
  } finally { fx.close(); }
});

test("③b Lovart：未提供风格 / 摄影机 / 联网时不出现（不编造）", async () => {
  const calls = [];
  const fx = await modelFixture({
    provider: { displayName: "Lovart", baseUrl: "https://lgw.lovart.ai", adapterType: "lovart", credentialSecret: LOVART_CREDENTIAL },
    model: "generate_image_seedream_v5_pro",
    capability: "image-generation",
    fetchImpl: lovartFetch(calls),
  });
  try {
    const out = await fx.f.modelService.generateImage({ context: fx.context, prompt: "一只猫", hints: { ratio: "3:4" } });
    assert.equal(out.ok, true, JSON.stringify(out));
    const prompt = calls.find((call) => call.path.endsWith("/chat")).body.prompt;
    assert.equal(/风格[:：]/.test(prompt), false);
    assert.equal(/摄影机[:：]/.test(prompt), false);
    assert.equal(/联网/.test(prompt), false);
  } finally { fx.close(); }
});

test("④ Lovart 适配器直调 generateComplete：params 里的风格 / 摄影机也进提示词，且不重复写", async () => {
  const calls = [];
  const out = await lovart.generateComplete({
    baseUrl: "https://lgw.lovart.ai", apiKey: LOVART_CREDENTIAL, kind: "image", model: "generate_image_seedream_v5_pro",
    prompt: "一只猫", params: { style: "电影感", camera: CAMERA }, fetchImpl: lovartFetch(calls), timeoutMs: 30000,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  const prompt = calls.find((call) => call.path.endsWith("/chat")).body.prompt;
  assert.match(prompt, /风格：电影感/);
  assert.match(prompt, /摄影机：机身 ARRI Alexa 35/);

  // 已经写过的不再重复（model-service 先写过时，适配器这层要幂等）
  const twice = lovart.withVisualRequirements(prompt, { style: "电影感", camera: CAMERA });
  assert.equal((twice.match(/风格：/g) || []).length, 1);
  assert.equal((twice.match(/摄影机：/g) || []).length, 1);
});

/* ══ ⑤ APIMart：uiSpec 没声明就不加字段 ══ */

function apimartFetch(bodies) {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/images/generations")) { bodies.push(JSON.parse(init.body)); return response({ code: 0, data: [{ task_id: "task_style_1" }] }); }
    if (url.includes("/v1/tasks/task_style_1")) return response({ code: 0, data: { status: "completed", result: { images: [{ url: ["https://cdn.example.com/styled.png"] }] } } });
    return response({ code: 0, data: {} });
  };
}

test("⑤ APIMart：字段式适配器 uiSpec 未声明 style/camera → 请求体不加字段、提示词保持原样", async () => {
  assert.equal(apimart.uiSpec("seedream-4-5").style, false);
  assert.equal(apimart.uiSpec("seedream-4-5").camera, false);
  const bodies = [];
  const fx = await modelFixture({
    provider: { displayName: "APIMart", baseUrl: "https://api.apimart.ai/v1", adapterType: "apimart", credentialSecret: "sk-style-test" },
    model: "seedream-4-5",
    capability: "image-generation",
    fetchImpl: apimartFetch(bodies),
  });
  try {
    const out = await fx.f.modelService.generateImage({
      context: fx.context, prompt: "一只猫", size: "1536x2048", count: 1,
      hints: { ratio: "3:4", resolution: "2K", style: "电影感", camera: CAMERA, webSearch: true },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const body = bodies[0];
    assert.equal(body.prompt, "一只猫", "字段式适配器不往提示词塞视觉要求");
    assert.equal(body.size, "3:4");
    assert.equal(body.resolution, "2K");
    for (const key of ["style", "camera", "web_search", "webSearch"]) assert.equal(key in body, false, "不得凭空加字段：" + key);
  } finally { fx.close(); }
});

test("⑤b APIMart：就算 params 里带了 style/camera（白名单允许），也不会下发给该适配器", async () => {
  const bodies = [];
  const fx = await modelFixture({
    provider: { displayName: "APIMart", baseUrl: "https://api.apimart.ai/v1", adapterType: "apimart", credentialSecret: "sk-style-test-2" },
    model: "seedream-4-5",
    capability: "image-generation",
    fetchImpl: apimartFetch(bodies),
  });
  try {
    const out = await fx.f.modelService.generateImage({
      context: fx.context, prompt: "一只猫", count: 1,
      params: { style: "电影感", camera: CAMERA, webSearch: true },
      hints: { ratio: "1:1", resolution: "1K" },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const body = bodies[0];
    for (const key of ["style", "camera", "web_search"]) assert.equal(key in body, false);
    assert.equal(body.prompt, "一只猫");
  } finally { fx.close(); }
});

test("①c 摄影机选项数量与顺序（9 / 10 / 7 / 3，与 TapNow 逐项一致）", async () => {
  const { CAMERAS } = await import("../src/canvas/canvas-next/model.ts");
  assert.equal(CAMERAS.body.length, 9);
  assert.equal(CAMERAS.lens.length, 10);
  assert.equal(CAMERAS.focal.length, 7);
  assert.equal(CAMERAS.aperture.length, 3);
  assert.deepEqual([...CAMERAS.body], ["Sony Venice", "Arri Alexa 35", "Arri Alexa 65", "Red V-Raptor", "Panavision DXL2", "Arricam LT", "ArriFlex 435", "IMAX Keighley", "IMAX Film Camera"]);
  assert.deepEqual([...CAMERAS.lens], ["Zeiss Ultra Prime", "Arri Signature Prime", "Canon K-35", "Cooke S4", "Cooke Panchro", "Cooke SF 1.8x", "Helios", "Panavision C-series", "Panavision Primo", "Hawk Class X"]);
  assert.deepEqual([...CAMERAS.focal], [8, 14, 24, 35, 50, 75, 125]);
  assert.deepEqual([...CAMERAS.aperture], ["ƒ/1.4", "ƒ/4", "ƒ/11"]);
  // 边界表与前端逐项一致
  assert.deepEqual([...canvasBootstrap.CAMERA_PARTS.body], [...CAMERAS.body]);
  assert.deepEqual([...canvasBootstrap.CAMERA_PARTS.lens], [...CAMERAS.lens]);
  assert.deepEqual([...canvasBootstrap.CAMERA_PARTS.focal], [...CAMERAS.focal]);
  assert.deepEqual([...canvasBootstrap.CAMERA_PARTS.aperture], [...CAMERAS.aperture]);
});

test("①d 默认组合写入（Sony Venice + Zeiss Ultra Prime + 24mm + ƒ/4）与请求字段拼法", async () => {
  const { DEFAULT_CAMERA, defaultParams, cameraForRequest, cameraSummary } = await import("../src/canvas/canvas-next/model.ts");
  assert.deepEqual(DEFAULT_CAMERA, { on: false, body: 0, lens: 0, focal: 2, aperture: 1 });
  assert.deepEqual(defaultParams("image").camera, DEFAULT_CAMERA);
  // 打开浮层即写入 on=true 的默认组合
  const opened = { ...DEFAULT_CAMERA, on: true };
  assert.deepEqual(cameraForRequest(opened), { body: "Sony Venice", lens: "Zeiss Ultra Prime", focal: "24mm", aperture: "ƒ/4" });
  assert.equal(cameraSummary(opened), "Sony Venice · 24mm · ƒ/4 · Zeiss Ultra Prime");
  // 越界索引收敛到边界，不抛错
  assert.deepEqual(cameraForRequest({ on: true, body: 99, lens: -3, focal: 99, aperture: 9 }), { body: "IMAX Film Camera", lens: "Zeiss Ultra Prime", focal: "125mm", aperture: "ƒ/11" });
});

test("①e 移除（✕）清空组合：on=false 后请求不再带 camera 字段", async () => {
  const { DEFAULT_CAMERA, cameraForRequest, cameraSummary } = await import("../src/canvas/canvas-next/model.ts");
  const cleared = { ...DEFAULT_CAMERA, on: false };
  assert.equal(cameraForRequest(cleared), null);
  assert.equal(cameraForRequest(null), null);
  assert.equal(cameraSummary(cleared), "");
  // 旧节点 camera.on === true 仍可读（向后兼容）
  assert.deepEqual(cameraForRequest({ on: true, body: 1, lens: 0, focal: 3, aperture: 0 }), { body: "Arri Alexa 35", lens: "Zeiss Ultra Prime", focal: "35mm", aperture: "ƒ/1.4" });
});

test("①f 能力门控：只有服务商 uiSpec 明确声明 style/camera 才渲染入口（按名字猜不算）", async () => {
  const { specFor } = await import("../src/canvas/canvas-next/model.ts");
  const lovartSpec = specFor({ configId: "c1", label: "Nano Banana 2 Lite", kind: "image", specSource: "spec", ui: { kind: "image", ratios: ["1:1"], sizes: ["1K"], style: true, camera: true, batch: [1] } });
  assert.equal(lovartSpec.style, true, "会话式（Lovart）声明 true → 渲染");
  assert.equal(lovartSpec.camera, true);
  const apiSpec = specFor({ configId: "c2", label: "seedream-4-5", kind: "image", specSource: "spec", ui: { kind: "image", ratios: ["1:1"], sizes: ["1K"], style: false, camera: false, batch: [1] } });
  assert.equal(apiSpec.style, false, "字段式（APIMart）uiSpec 全 false → 不渲染");
  assert.equal(apiSpec.camera, false);
  const guess = specFor({ configId: "c3", label: "Nano Banana 2 Lite", kind: "image" });
  assert.equal(guess.specSource, "guess");
  assert.equal(guess.style, false, "没有 uiSpec 时不许按名字猜成可用");
  assert.equal(guess.camera, false);
});
