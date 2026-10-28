/**
 * 图片编辑路径按面板选择的比例 / 档位出图（task-35 A）。
 *
 * 链路：canvas/modelImageEdit（bootstrap 解析 ratio/resolution/customSize/customRatio）
 *   → canvas-service.editImage（与生成同一个 size 解析点）
 *   → model-service.editImage（size + hints）
 *   → Lovart 写进提示词【画面要求】；APIMart 按模型族发 size / resolution 字段。
 *
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

process.env.APM_FAST = "1";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DATA_URL = "data:image/png;base64," + PNG_1X1;
const LOVART_CREDENTIAL = JSON.stringify({ accessKey: "ak-edit", secretKey: "sk-edit" });

function response(body) {
  return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify(body), json: async () => body };
}

function lovartFetch(calls) {
  return async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (body) calls.push({ path, body });
    if (path.endsWith("/project/save")) return response({ code: 0, data: { project_id: "p_edit" } });
    if (path.endsWith("/file/upload")) return response({ code: 0, data: { url: "https://lgw.lovart.ai/upload/edit-input.png" } });
    if (path.endsWith("/chat")) return response({ code: 0, data: { thread_id: "t_edit" } });
    if (path.endsWith("/chat/status")) return response({ code: 0, data: { status: "done" } });
    if (path.endsWith("/chat/result")) return response({ code: 0, data: { final_status: "done", items: [{ artifacts: [{ content: "https://a.lovart.ai/artifacts/edit.png", type: "image" }] }] } });
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
  return { f, context, configId: spec.model.configId, close: () => f.close() };
}

/* ══ ① bootstrap 边界解析 ══ */

test("① imageEditOptions：size / ratio / resolution / customSize / customRatio 都解析并做长度边界", () => {
  assert.deepEqual(canvasBootstrap.imageEditOptions({ size: "1536x2048", ratio: "3:4", resolution: "2K" }), {
    size: "1536x2048", ratio: "3:4", resolution: "2K", customSize: null, customRatio: null,
  });
  const custom = canvasBootstrap.imageEditOptions({ ratio: "custom", customRatio: "16:9", customSize: " 2048x1152 " });
  assert.equal(custom.ratio, "custom");
  assert.equal(custom.customRatio, "16:9");
  assert.equal(custom.customSize, "2048x1152");
  assert.equal(canvasBootstrap.imageEditOptions({ size: "x".repeat(80) }).size.length, 32);
  assert.deepEqual(canvasBootstrap.imageEditOptions(null), { size: null, ratio: null, resolution: null, customSize: null, customRatio: null });
});

/* ══ ② canvas-service.editImage：size 解析 + 透传 ══ */

async function canvasFixture() {
  const fx = await createResourceFixture();
  const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });
  const context = { sessionRef: fx.sessions.admin, appId: "canvas", source: "ui" };
  const created = service.createCanvas({ context, title: "编辑尺寸" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const calls = [];
  const modelService = {
    editImage: async (input) => { calls.push(input); return { ok: true, images: [{ url: "openarc-asset:edited" }] }; },
  };
  service.attachRuntime({ taskService: { createTask: () => ({ ok: true, task: { taskId: "t1", revision: 1 } }), startTask: () => ({ ok: true }) }, modelService });
  return { fx, service, context, canvasId: created.canvas.canvasId, calls };
}

test("② canvas-service.editImage：显式比例 / 档位解析成像素 size，并把 hints 交给 model-service", async () => {
  const f = await canvasFixture();
  try {
    const out = await f.service.editImage({
      context: f.context, canvasId: f.canvasId, mode: "prompt", prompt: "把背景换成蓝天",
      sourceDataUrl: DATA_URL, ratio: "3:4", resolution: "2K",
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const call = f.calls[0];
    assert.equal(call.size, "1536x2048", "3:4 + 2K → 1536x2048（与生成同一张表）");
    assert.equal(call.hints.ratio, "3:4");
    assert.equal(call.hints.resolution, "2K");
    assert.equal(call.mode, "prompt");
    assert.equal(call.prompt, "把背景换成蓝天");
  } finally { f.fx.close(); }
});

test("②b canvas-service.editImage：customRatio / 显式 size 的优先级", async () => {
  const f = await canvasFixture();
  try {
    await f.service.editImage({ context: f.context, canvasId: f.canvasId, mode: "redraw", prompt: "x", sourceDataUrl: DATA_URL, ratio: "custom", customRatio: "16:9", resolution: "2K" });
    assert.equal(f.calls[0].size, imageParams.resolveImageSize({ ratio: "custom", customRatio: "16:9", resolution: "2K" }));
    await f.service.editImage({ context: f.context, canvasId: f.canvasId, mode: "redraw", prompt: "x", sourceDataUrl: DATA_URL, size: "1024x1024", ratio: "3:4", resolution: "2K" });
    assert.equal(f.calls[1].size, "1024x1024", "显式 size 优先");
  } finally { f.fx.close(); }
});

/* ══ ③ Lovart：编辑也按比例 / 像素写进提示词 ══ */

test("③ Lovart 编辑：提示词带【画面要求】比例与像素，附件仍是上传后的地址", async () => {
  const calls = [];
  const fx = await modelFixture({
    provider: { displayName: "Lovart", baseUrl: "https://lgw.lovart.ai", adapterType: "lovart", credentialSecret: LOVART_CREDENTIAL },
    model: "generate_image_seedream_v5_pro",
    capability: "image-generation",
    fetchImpl: lovartFetch(calls),
  });
  try {
    const out = await fx.f.modelService.editImage({
      context: fx.context, configId: fx.configId, mode: "prompt", prompt: "把背景换成蓝天",
      sourceDataUrl: DATA_URL, size: "1536x2048", hints: { ratio: "3:4", resolution: "2K" },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const chat = calls.find((call) => call.path.endsWith("/chat"));
    assert.ok(chat, "Lovart 编辑走 chat（对话式）");
    assert.match(chat.body.prompt, /把背景换成蓝天/);
    assert.match(chat.body.prompt, /【画面要求】画面比例 3:4，输出 1536×2048 像素/);
    assert.deepEqual(chat.body.attachments, ["https://lgw.lovart.ai/upload/edit-input.png"], "参考图仍是上传后的地址");
  } finally { fx.close(); }
});

test("③b Lovart 编辑（重绘）：带透明区域的提示词里也有尺寸要求", async () => {
  const calls = [];
  const fx = await modelFixture({
    provider: { displayName: "Lovart", baseUrl: "https://lgw.lovart.ai", adapterType: "lovart", credentialSecret: LOVART_CREDENTIAL },
    model: "generate_image_gpt_image_2_5_flare",
    capability: "image-generation",
    fetchImpl: lovartFetch(calls),
  });
  try {
    const out = await fx.f.modelService.editImage({
      context: fx.context, configId: fx.configId, mode: "outpaint", prompt: "向外扩展",
      sourceDataUrl: DATA_URL, originalDataUrl: DATA_URL, size: "2048x1152", hints: { ratio: "16:9", resolution: "2K" },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const chat = calls.find((call) => call.path.endsWith("/chat"));
    assert.match(chat.body.prompt, /画面比例 16:9，输出 2048×1152 像素/);
  } finally { fx.close(); }
});

/* ══ ④ APIMart：编辑按模型族发 size / resolution 字段 ══ */

function apimartFetch(state) {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/uploads/images")) { state.uploads += 1; return response({ url: "https://cdn.example/edit-input-" + state.uploads + ".png" }); }
    if (url.includes("/v1/images/generations")) { state.bodies.push(JSON.parse(init.body)); return response({ code: 0, data: [{ task_id: "task_edit_1" }] }); }
    if (url.includes("/v1/tasks/task_edit_1")) return response({ code: 0, data: { status: "completed", result: { images: [{ url: ["https://cdn.example/edit-out.png"] }] } } });
    return response({ code: 0, data: {} });
  };
}

test("④ APIMart 编辑：按模型规格发 size / resolution；不选比例时不硬发", async () => {
  const state = { uploads: 0, bodies: [] };
  const fx = await modelFixture({
    provider: { displayName: "APIMart", baseUrl: "https://api.apimart.ai/v1", adapterType: "apimart", credentialSecret: "sk-edit-test" },
    model: "gpt-image-2",
    capability: "image-generation",
    fetchImpl: apimartFetch(state),
  });
  try {
    const out = await fx.f.modelService.editImage({
      context: fx.context, configId: fx.configId, mode: "redraw", prompt: "把背景换成蓝天",
      sourceDataUrl: DATA_URL, originalDataUrl: DATA_URL, size: "1536x2048", hints: { ratio: "3:4", resolution: "2K" },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.images.length, 1);
    const body = state.bodies[0];
    assert.equal(body.model, "gpt-image-2");
    assert.equal(body.size, "3:4", "比例走模型族的 size 字段");
    assert.equal(body.resolution, "2k", "档位走 resolution 字段（gpt-image-2 族小写）");
    assert.ok(Array.isArray(body.image_urls) && body.image_urls.length === 1, "原图进 image_urls");
    assert.equal(typeof body.mask_url, "string", "重绘带 mask_url");
    assert.match(body.prompt, /把背景换成蓝天/);

    const plain = await fx.f.modelService.editImage({ context: fx.context, configId: fx.configId, mode: "redraw", prompt: "改一下", sourceDataUrl: DATA_URL, originalDataUrl: DATA_URL });
    assert.equal(plain.ok, true, JSON.stringify(plain));
    const withoutRatio = state.bodies[1];
    assert.equal("size" in withoutRatio, false, "没选比例就不发 size（跟随原图）");
    // 档位是模型表既有默认（gpt-image-2 默认 1k），与「有没有选比例」无关
    assert.equal(withoutRatio.resolution, "1k");
  } finally { fx.close(); }
});
