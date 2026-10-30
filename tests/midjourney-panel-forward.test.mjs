/**
 * Midjourney 面板参数（版本 / 速度 / HD / 风格化）从画布一路转发到 APIMart 请求体。
 * 链路：canvas/modelImage(Edit) 边界归一 → canvas-service → model-service → APIMart 适配器 midjourneyBody。
 * 全部离线：mock fetch 捕获请求体。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { createModelFixture } from "./model-fixtures.mjs";

const require = createRequire(import.meta.url);
const canvasBootstrap = require("../electron/canvas-bootstrap.cjs");
const imageParams = require("../electron/image-params.cjs");
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");
const apimart = require("../electron/provider-adapter-apimart.cjs");
process.env.APM_FAST = "1";

const response = (body) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify(body), json: async () => body });
function apimartFetch(posts) {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/uploads/images") return response({ url: "https://upload.apimart.ai/f/u1.png" });
    if (init && init.method === "POST") { posts.push({ path: url.pathname, body: JSON.parse(init.body) }); return response({ code: 200, data: [{ status: "submitted", task_id: "task_mj" }] }); }
    if (url.pathname.startsWith("/v1/tasks/task_mj")) return response({ code: 200, data: { status: "completed", result: { images: [{ url: ["https://cdn.example/1.png", "https://cdn.example/2.png", "https://cdn.example/3.png", "https://cdn.example/4.png"] }] } } });
    return response({ code: 200, data: {} });
  };
}
async function modelFixture(model, posts) {
  const f = await createModelFixture({ fetchImpl: apimartFetch(posts) });
  f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });
  const context = { ...f.adminCtx(), appId: "settings" };
  const created = f.modelService.createProvider({ context, displayName: "APIMart", baseUrl: "https://api.apimart.ai/v1", adapterType: "apimart", credentialSecret: "sk-mj-" + model });
  assert.equal(created.ok, true, JSON.stringify(created));
  const spec = f.modelService.createModel({ context, providerId: created.provider.providerId, remoteModelId: model, capabilities: ["image-generation"] });
  assert.equal(spec.ok, true, JSON.stringify(spec));
  assert.equal(f.modelService.setDefault({ context, capability: "image-generation", configId: spec.model.configId }).ok, true);
  return { f, context };
}

test("边界归一：只收认识的版本 / 速度 / HD / 风格化", () => {
  assert.deepEqual(imageParams.sanitizeMidjourney({ version: " 8.1 ", speed: "TURBO", hd: true, stylize: "250", junk: 1 }), { version: "8.1", speed: "turbo", hd: true, stylize: 250 });
  assert.deepEqual(imageParams.sanitizeMidjourney({ version: "Niji7" }), { version: "niji 7" });
  assert.deepEqual(imageParams.sanitizeMidjourney({ stylize: 5000 }), { stylize: 1000 });
  assert.equal(imageParams.sanitizeMidjourney({ version: "8.1 --tile", speed: "warp", hd: "yes" }), null);
  assert.equal(imageParams.sanitizeMidjourney(null), null);
  assert.deepEqual(canvasBootstrap.imagePanelOptions({ mj: { version: "7" } }), { mj: { version: "7" } });
  assert.deepEqual(canvasBootstrap.imagePanelOptions({}), {});
  assert.deepEqual(canvasBootstrap.imageEditOptions({ mj: { hd: true } }).mj, { hd: true });
});

test("面板规格：midjourney 带版本 / 速度 / HD 列表，别的模型没有", () => {
  const s = apimart.uiSpec("midjourney");
  assert.ok(s.mj.versions.includes("8.1") && s.mj.versions.includes("niji 7"));
  assert.deepEqual(s.mj.speeds, ["relax", "fast", "turbo"]);
  assert.deepEqual(s.mj.hd, ["8.1", "8.2"]);
  assert.equal("mj" in apimart.uiSpec("seedream-4-5"), false);
});

test("canvas-service 把 mj 交给 generateImage（同步 + 异步）", async () => {
  const fx = await createResourceFixture();
  try {
    const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
    const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });
    const context = { sessionRef: fx.sessions.admin, appId: "canvas", source: "ui" };
    const canvasId = service.createCanvas({ context, title: "mj" }).canvas.canvasId;
    const calls = [];
    service.attachRuntime({
      taskService: {
        createTask: () => ({ ok: true, task: { taskId: "t", revision: 1 } }), startTask: () => ({ ok: true }),
        getTask: () => ({ ok: true, task: { revision: 1, cancelRequested: false, status: "RUNNING" } }),
        getTaskBudget: () => ({ ok: true, remaining: { MODEL_CALLS: 10 }, authorized: {}, consumed: {} }), checkModelConfig: () => ({ ok: true }),
        startModelCall: () => ({ ok: true, call: { callId: "c" } }), completeModelCall: () => ({ ok: true }), failModelCall: () => ({ ok: true }), recordBudgetConsumption: () => ({ ok: true }),
      },
      modelService: { resolveModel: () => ({ ok: true, model: { configId: "m1" } }), generateImage: async (input) => { calls.push(input); return { ok: true, images: [{ url: "openarc-asset:x" }] }; } },
    });
    const run1 = service.startRun({ context, canvasId, kind: "image" }).runId;
    await service.modelCall({ context, canvasId, runId: run1, kind: "image", prompt: "cat", ratio: "16:9", mj: { version: "8.1", hd: true } });
    assert.deepEqual(calls[0].params.mj, { version: "8.1", hd: true });
    const run2 = service.startRun({ context, canvasId, kind: "image" }).runId;
    service.startAsyncModelCall({ context, canvasId, runId: run2, prompt: "dog", ratio: "1:1", mj: { speed: "relax" } });
    const deadline = Date.now() + 3000;
    while (calls.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(calls[1].params.mj, { speed: "relax" });
  } finally { fx.close(); }
});

test("model-service → APIMart：midjourney 请求体带上面板的版本 / 速度 / HD / 风格化", async () => {
  const posts = [];
  const { f, context } = await modelFixture("midjourney", posts);
  try {
    const out = await f.modelService.generateImage({ context, prompt: "a lighthouse", count: 1, params: { mj: { version: "8.1", speed: "turbo", hd: true, stylize: 250 } }, hints: { ratio: "16:9" } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.images.length, 4);
    const { path, body } = posts[0];
    assert.equal(path, "/v1/midjourney/generations");
    assert.deepEqual({ v: body.version, s: body.speed, hd: body.hd, st: body.stylize, size: body.size }, { v: "8.1", s: "turbo", hd: true, st: 250, size: "16:9" });
  } finally { f.close(); }
});

test("niji 版本带 niji:true；不支持 HD 的版本不发 hd", async () => {
  const posts = [];
  const { f, context } = await modelFixture("midjourney", posts);
  try {
    await f.modelService.generateImage({ context, prompt: "girl", count: 1, params: { mj: { version: "niji 7", hd: true } }, hints: { ratio: "1:1" } });
    await f.modelService.generateImage({ context, prompt: "dog", count: 1, params: { mj: { version: "7", hd: true } }, hints: { ratio: "1:1" } });
    await f.modelService.generateImage({ context, prompt: "cat", count: 1, params: { mj: { hd: true } }, hints: { ratio: "1:1" } });
    const [a, b, c] = posts.map((x) => x.body);
    assert.equal(a.version, "7"); assert.equal(a.niji, true); assert.equal("hd" in a, false);
    assert.equal(b.version, "7"); assert.equal("hd" in b, false); assert.equal("niji" in b, false);
    assert.equal("version" in c, false); assert.equal(c.hd, true, "没选版本时上游默认补 8.1，可以开 HD");
  } finally { f.close(); }
});

test("非 Midjourney 模型：就算带了 mj 也不转发", async () => {
  const posts = [];
  const { f, context } = await modelFixture("seedream-4-5", posts);
  try {
    await f.modelService.generateImage({ context, prompt: "cat", count: 1, params: { mj: { version: "8.1", hd: true } }, hints: { ratio: "1:1", resolution: "2K" } });
    const body = posts[0].body;
    for (const k of ["mj", "version", "hd", "speed"]) assert.equal(k in body, false, k);
  } finally { f.close(); }
});

test("图生图（editImage → /edits）同样带面板参数", async () => {
  const posts = [];
  const { f, context } = await modelFixture("midjourney", posts);
  try {
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const out = await f.modelService.editImage({ context, mode: "prompt", prompt: "night", sourceDataUrl: PNG, hints: { ratio: "1:1", mj: { version: "8.2", speed: "fast" } } });
    assert.equal(out.ok, true, JSON.stringify(out));
    const p = posts.find((x) => x.path === "/v1/midjourney/generations/edits");
    assert.ok(p, JSON.stringify(posts.map((x) => x.path)));
    assert.equal(p.body.version, "8.2"); assert.equal(p.body.speed, "fast");
  } finally { f.close(); }
});
