/**
 * 生成尺寸 / 视频可用性（真机两个反馈的回归）：
 *
 * ① 面板选的图片比例与档位必须真的影响产物：
 *    · 对话式服务商（Lovart：请求体只有提示词、没有 size / aspect_ratio 字段）→ 尺寸写成提示词里的确定要求；
 *    · 按字段族服务商（APIMart：aspect_ratio / resolution）→ 请求体带字段，提示词保持原样。
 *    两条路径都在真实 ModelService 上跑，只把 fetch 换成捕获请求体的桩（不联网、不花钱）。
 *
 * ② 视频节点在发请求前就 FAILED（真机 run_mvmc7ar8_40qrcl：68ms、无 provider 调用、
 *    node.data.gen.err = CANVAS_NODE_PARAMS_INVALID）：根因是视频首帧图的临时直链拿不到时桥会内嵌
 *    data URL，而节点参数 schema 把媒体串卡在 400 字符 → 参数判非法。这里的断言钉住：
 *    · data URL 不再被判非法（超防呆上界仍然拒）；
 *    · 画布视频端口把比例 / 清晰度 / 时长 / 首帧角色原样提交给模型出口；
 *    · Lovart 与 APIMart 两条视频链路的提交体正确；
 *    · 异步执行失败时错误带出「哪个参数错了」，不再只回一个裸 code。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";

const require = createRequire(import.meta.url);
const imageParams = require("../electron/image-params.cjs");
const registryModule = require("../electron/canvas-node-registry.cjs");
const commands = require("../electron/canvas-dxos-commands.cjs");
const lovart = require("../electron/provider-adapter-lovart.cjs");
const apimart = require("../electron/provider-adapter-apimart.cjs");

// APIMart 适配器的轮询间隔压到 1ms（与 tests/apimart-adapter.test.mjs 同一个测试开关）
process.env.APM_FAST = "1";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const LOVART_CREDENTIAL = JSON.stringify({ accessKey: "ak-test", secretKey: "sk-test" });
const LOVART_TARGET = "https://a.lovart.ai/artifacts/agent/one.png";

/** 一个够长的假图（data URL 长度 ≈ 2MB，和"图床不可用时的内嵌压缩图"同量级）。 */
function bigDataUrl(bytes = 1.5 * 1024 * 1024) {
  return "data:image/jpeg;base64," + Buffer.alloc(bytes, 7).toString("base64");
}

function response(body) {
  return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify(body), json: async () => body };
}

/** Lovart 三段式（project/save → chat → status → result）的桩；chat 请求体记到 calls。 */
function lovartFetch(calls, artifacts) {
  return async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = init && init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (body) calls.push({ path, body });
    if (path.endsWith("/project/save")) return response({ code: 0, data: { project_id: "p1" } });
    if (path.endsWith("/file/upload") || path.endsWith("/artifact/upload")) return response({ code: 0, data: { url: "https://lgw.lovart.ai/upload/input.png" } });
    if (path.endsWith("/chat")) return response({ code: 0, data: { thread_id: "t1" } });
    if (path.endsWith("/chat/status")) return response({ code: 0, data: { status: "done" } });
    if (path.endsWith("/chat/result")) return response({ code: 0, data: { final_status: "done", items: [{ artifacts }] } });
    return response({ code: 0, data: {} });
  };
}

async function servicedFixture({ provider, model, capability, fetchImpl }) {
  const f = await createModelFixture({ fetchImpl });
  f.store.upsertApp({ appId: "settings", name: "系统设置", publisher: "openarc-builtin", status: "enabled", builtIn: 1 });
  f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: "settings", actions: ["model.view", "model.use", "model.manage", "model.test"] });
  const context = { ...f.adminCtx(), appId: "settings" };
  const created = f.modelService.createProvider({ context, ...provider });
  assert.equal(created.ok, true, JSON.stringify(created));
  const spec = f.modelService.createModel({ context, providerId: created.provider.providerId, remoteModelId: model, capabilities: [capability] });
  assert.equal(spec.ok, true, JSON.stringify(spec));
  assert.equal(f.modelService.setDefault({ context, capability, configId: spec.model.configId }).ok, true);
  return { f, context, close: () => f.close() };
}

/* ══════════════════════════════════════════════════════════════════════════
   ① 图片尺寸：两种服务商形状都按用户选择走
   ══════════════════════════════════════════════════════════════════════════ */

test("尺寸要求文案：比例 + 像素都写进去；拿不到尺寸时不动提示词", () => {
  assert.equal(
    imageParams.withSizeRequirement("一只猫", { size: "1536x2048", ratio: "3:4" }),
    "一只猫\n\n【画面要求】画面比例 3:4，输出 1536×2048 像素，严格按此比例与尺寸出图。",
  );
  // 只有像素：比例从像素化简
  assert.match(imageParams.withSizeRequirement("海浪", { size: "2048x1152" }), /画面比例 16:9，输出 2048×1152 像素/);
  // 只有比例 / 自适应 / auto：不写像素，也不编造
  assert.equal(imageParams.withSizeRequirement("海浪", { size: null, ratio: "自适应" }), "海浪");
  assert.equal(imageParams.withSizeRequirement("x", { size: "auto", ratio: "custom" }), "x");
});

test("Lovart（对话式）：比例 3:4 / 2K → 提示词带「画面比例 3:4，输出 1536×2048 像素」", async () => {
  const calls = [];
  const fx = await servicedFixture({
    provider: { displayName: "Lovart", baseUrl: "https://lgw.lovart.ai", adapterType: "lovart", credentialSecret: LOVART_CREDENTIAL },
    model: "generate_image_gpt_image_2_5_flare",
    capability: "image-generation",
    fetchImpl: lovartFetch(calls, [{ content: LOVART_TARGET, type: "image" }]),
  });
  try {
    const out = await fx.f.modelService.generateImage({
      context: fx.context, prompt: "一只猫", size: "1536x2048", count: 1,
      hints: { ratio: "3:4", resolution: "2K" },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const chat = calls.find((call) => call.path.endsWith("/chat"));
    assert.ok(chat, "Lovart 必须走 chat（对话式）入口");
    assert.match(chat.body.prompt, /^一只猫/);
    assert.match(chat.body.prompt, /【画面要求】画面比例 3:4，输出 1536×2048 像素/);
    // 对话式入口没有 size / aspect_ratio 字段：尺寸只能靠提示词
    assert.equal("size" in chat.body, false);
    assert.equal("aspect_ratio" in chat.body, false);
  } finally { fx.close(); }
});

test("APIMart（字段族）：比例 / 档位走字段，提示词保持原样不带尺寸要求", async () => {
  const bodies = [];
  const fx = await servicedFixture({
    provider: { displayName: "APIMart", baseUrl: "https://apib.ai/", adapterType: "apimart", credentialSecret: "sk-apimart-test" },
    model: "seedream-4-5",
    capability: "image-generation",
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/images/generations")) {
        bodies.push(JSON.parse(init.body));
        return response({ code: 0, data: [{ task_id: "task_img_1" }] });
      }
      if (url.includes("/v1/tasks/task_img_1")) return response({ code: 0, data: { status: "completed", result: { images: [{ url: "https://cdn.example.com/a.png" }] } } });
      return response({ code: 0, data: {} });
    },
  });
  try {
    const out = await fx.f.modelService.generateImage({
      context: fx.context, prompt: "一只猫", size: "1536x2048", count: 1,
      hints: { ratio: "3:4", resolution: "2K" },
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    const body = bodies[0];
    assert.equal(body.model, "seedream-4-5");
    assert.equal(body.prompt, "一只猫", "按字段族计价的服务商提示词不该被塞尺寸要求");
    assert.equal(body.size, "3:4", "比例走 size 字段");
    assert.equal(body.resolution, "2K", "档位走 resolution 字段");
  } finally { fx.close(); }
});

/* ══════════════════════════════════════════════════════════════════════════
   ② 视频：参数不再被 400 字符卡住；提交体正确；失败带原因
   ══════════════════════════════════════════════════════════════════════════ */

function videoParams(over = {}) {
  return {
    prompt: "猫猫动起来", configId: "mcf_test_video", modelType: "image_to_video",
    ratio: "16:9", resolution: "720p", duration: 5, count: 1, times: 1,
    images: ["openarc-asset:res_first_frame"], imageRoles: ["first_frame"], imageRefs: ["openarc-asset:res_first_frame"],
    videos: [], videoRefs: [], audios: [], audioRefs: [],
    ...over,
  };
}

test("视频参数：首帧图是 data URL（图床不可用时的兜底）不再判非法，超上界仍拒", () => {
  const registry = new registryModule.CanvasNodeRegistry({ ports: {} });
  const withDataUrl = registry.validateParams("builtin.video-generator", videoParams({ images: [bigDataUrl()] }));
  assert.equal(withDataUrl.ok, true, "真实生成的 1.5MB 内嵌图（≈2MB base64）必须能进参数校验");

  const absurd = registry.validateParams("builtin.video-generator", videoParams({ images: ["data:image/jpeg;base64," + "A".repeat(5 * 1024 * 1024)] }));
  assert.equal(absurd.ok, false);
  assert.equal(absurd.error, registryModule.ERROR.NODE_PARAMS_INVALID);
  assert.equal(absurd.detail.errors[0].path, "params.images[0]", "防呆上界仍在，报的是具体参数");
});

test("画布视频端口：比例 / 清晰度 / 时长 / 首帧角色 / 首帧字节都提交给模型出口", async () => {
  const seen = [];
  const canvasService = {
    getCanvas: () => ({ ok: true, canvas: { doc: { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] } } }),
    applyCommand: () => ({ ok: true, canvas: { revision: 2 } }),
    startRun: () => ({ ok: true, runId: "run_port_1", taskId: "task_1" }),
    finishRun: () => ({ ok: true }),
    asyncRuns: new Map(),
    readAsset: ({ ref }) => (ref === "openarc-asset:res_first_frame" ? { ok: true, dataUrl: "data:image/png;base64," + PNG_1X1 } : { ok: false, error: "ASSET_UNAVAILABLE" }),
    modelService: {
      resolveModel: () => ({ ok: true, snapshot: { providerId: "prv_lovart", modelId: "generate_video_seedance_v2_5" } }),
      providerProtocol: { service: { legacyExecute: async () => ({ ok: true, videos: [] }) } },
      generateVideo: async (input) => { seen.push(input); return { ok: true, videos: [{ url: "openarc-asset:res_video_out" }] }; },
    },
  };
  const extension = commands.createCanvasDxosExtension({ identity: { validateSession: () => ({ ok: true, user: { id: "u1", role: "USER" } }) }, canvasService, clock: () => Date.now() });
  const out = await extension.dispatch({ command: "canvas/nodes/execute", payload: { type: "builtin.video-generator", canvasId: "c1", nodeId: "n1", params: videoParams() }, context: { sessionRef: "s1" } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(seen.length, 1, "视频必须走模型配置自带的视频出口");
  const call = seen[0];
  assert.equal(call.prompt, "猫猫动起来");
  assert.equal(call.params.ratio, "16:9");
  assert.equal(call.params.resolution, "720p");
  assert.equal(call.params.duration, 5);
  assert.equal(call.params.modelType, "image_to_video");
  assert.deepEqual(call.params.imageRoles, ["first_frame"]);
  assert.match(call.inputs[0], /^data:image\/png;base64,/, "首帧按资源库原始引用读成字节，不把裸引用发给服务商");
});

test("Lovart 视频提交体：data URL 首帧先传成 Lovart 附件，生成要求写进提示词", async () => {
  const calls = [];
  const out = await lovart.generateVideo({
    baseUrl: "https://lgw.lovart.ai",
    apiKey: LOVART_CREDENTIAL,
    model: "generate_video_seedance_v2_5",
    prompt: "猫猫动起来",
    inputs: ["data:image/png;base64," + PNG_1X1],
    params: { ratio: "16:9", resolution: "720p", duration: 5, imageRoles: ["first_frame"], generateAudio: false },
    fetchImpl: lovartFetch(calls, [{ content: "https://a.lovart.ai/artifacts/agent/one.mp4", type: "video" }]),
    timeoutMs: 30000,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  const chat = calls.find((call) => call.path.endsWith("/chat"));
  assert.ok(chat, "Lovart 视频走 chat（对话式）入口");
  assert.deepEqual(chat.body.attachments, ["https://lgw.lovart.ai/upload/input.png"], "首帧必须先上传成 Lovart 附件");
  assert.match(chat.body.prompt, /^猫猫动起来/);
  assert.match(chat.body.prompt, /【生成要求】/);
  assert.match(chat.body.prompt, /附件按顺序：第1个=首帧/);
  assert.match(chat.body.prompt, /画面比例 16:9/);
  assert.match(chat.body.prompt, /清晰度 720p/);
  assert.match(chat.body.prompt, /时长 5 秒/);
});

test("APIMart 视频提交体：首帧图 + 比例 / 清晰度 / 时长走字段", async () => {
  const submits = [];
  const out = await apimart.generateVideo({
    baseUrl: "https://apib.ai/",
    apiKey: "sk-apimart-test",
    model: "seedance-2.5",
    prompt: "猫猫动起来",
    inputs: ["https://cdn.example.com/first.png"],
    params: { ratio: "16:9", resolution: "720p", duration: 5, modelType: "image_to_video" },
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/videos/generations")) { submits.push(JSON.parse(init.body)); return response({ code: 0, data: [{ task_id: "task_vid_1" }] }); }
      if (url.includes("/v1/tasks/task_vid_1")) return response({ code: 0, data: { status: "completed", result: { videos: [{ url: "https://cdn.example.com/v.mp4" }] } } });
      return response({ code: 0, data: {} });
    },
    timeoutMs: 30000,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  const body = submits[0];
  assert.equal(body.model, "seedance-2.5");
  assert.equal(body.prompt, "猫猫动起来");
  assert.equal(body.duration, 5);
  assert.equal(body.resolution, "720p");
  assert.equal(body.size, "16:9");
  assert.ok(
    JSON.stringify(body).includes("https://cdn.example.com/first.png"),
    "首帧图必须进提交体：" + JSON.stringify(body),
  );
});

test("异步节点执行失败：错误文案带出是哪个参数错了（不再只有裸 code）", async () => {
  const canvasService = {
    startRun: () => ({ ok: true, runId: "run_bad_1", taskId: "task_1" }),
    finishRun: () => ({ ok: true }),
    asyncRuns: new Map(),
    getCanvas: () => ({ ok: true, canvas: { doc: { nodes: [], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] } } }),
    applyCommand: () => ({ ok: true, canvas: { revision: 2 } }),
    modelService: { resolveModel: () => ({ ok: true, snapshot: { providerId: "p", modelId: "m" } }), providerProtocol: { service: { legacyExecute: async () => ({ ok: true }) } } },
  };
  const extension = commands.createCanvasDxosExtension({ identity: { validateSession: () => ({ ok: true, user: { id: "u1", role: "USER" } }) }, canvasService, clock: () => Date.now() });
  const started = await extension.dispatch({
    command: "canvas/nodes/execute",
    payload: { type: "builtin.video-generator", canvasId: "c1", nodeId: "n1", async: true, params: videoParams({ prompt: "", images: [] }) },
    context: { sessionRef: "s1" },
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  for (let i = 0; i < 40 && canvasService.asyncRuns.get("run_bad_1")?.status !== "FAILED"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const entry = canvasService.asyncRuns.get("run_bad_1");
  assert.equal(entry.status, "FAILED");
  assert.match(entry.error, /^CANVAS_NODE_PARAMS_INVALID/);
  assert.match(entry.error, /params\.prompt/, "失败原因必须指出是哪个参数：" + entry.error);
});
