/**
 * APIMart 模型表与官方文档（docs.apimart.ai/cn，2026-10-29 核对）逐条对齐的离线验收。
 * 只断言请求体 / 面板规格，不联网：videoBody 走 generateVideo + 本地 mock 上游。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const adapter = require("../electron/provider-adapter-apimart.cjs");
const catalog = require("../electron/provider-apimart-models.cjs");
process.env.APM_FAST = "1";

async function withMock(fn) {
  const requests = [];
  let uploads = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      let body = null; try { body = JSON.parse(raw.toString("utf8")); } catch { /* multipart */ }
      requests.push({ method: req.method, path: req.url, json: body });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/uploads/images") { uploads += 1; return send(200, { url: "https://upload.apimart.ai/f/image/u" + uploads + ".png" }); }
      if (req.method === "POST") return send(200, { code: 200, data: [{ status: "submitted", task_id: "t1" }] });
      if (req.url.startsWith("/v1/tasks/")) return send(200, { code: 200, data: { status: "completed", result: { videos: [{ url: ["https://cdn.example/v.mp4"] }] } } });
      send(404, { error: { message: "nope" } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = "http://127.0.0.1:" + server.address().port + "/v1";
  try { return await fn({ baseUrl, requests }); } finally { await new Promise((r) => server.close(r)); }
}
const submitted = (requests) => requests.find((r) => r.method === "POST" && /generations/.test(r.path)).json;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const run = (model, extra = {}) => withMock(async ({ baseUrl, requests }) => {
  const out = await adapter.generateVideo({ baseUrl, apiKey: "k", model, prompt: "p", fetchImpl: fetch, ...extra });
  return { out, body: out.ok ? submitted(requests) : null, requests };
});

test("Grok 1.5 视频不再被图片规则抢走；Grok 官方视频用 aspect_ratio", async () => {
  assert.equal(catalog.uiSpec("grok-imagine-1.5-video-ext").kind, "video");
  assert.equal(catalog.uiSpec("grok-imagine-1.5-ext").kind, "image");
  const { body } = await run("grok-imagine-video", { params: { ratio: "16:9", resolution: "720p", duration: 8 } });
  assert.equal(body.aspect_ratio, "16:9");
  assert.equal("size" in body, false);
  assert.deepEqual(catalog.uiSpec("grok-imagine-video-1.5").res, ["480p", "720p", "1080p"]);
});

test("海螺 02 / 2.3 分辨率是小写 p", async () => {
  const { body } = await run("MiniMax-Hailuo-2.3", { params: { resolution: "768p", duration: 6 } });
  assert.equal(body.resolution, "768p");
  const r2 = await run("MiniMax-Hailuo-02", { params: { resolution: "1080p", duration: 10 } });
  assert.equal(r2.body.resolution, "1080p");
  assert.equal(r2.body.duration, 5, "1080p 只支持 5 秒");
});

test("wan2.7-r2v 参考图走 image_with_roles(reference_image)，不发 image_urls", async () => {
  const { body } = await run("wan2.7-r2v", { inputs: ["https://cdn.example/a.png"], params: { mediaKinds: ["image"], duration: 5 } });
  assert.equal("image_urls" in body, false);
  assert.deepEqual(body.image_with_roles, [{ url: "https://cdn.example/a.png", role: "reference_image" }]);
});

test("wan2.5-preview 用 size、时长只有 5/10、不下发 audio", async () => {
  const { body } = await run("wan2.5-preview", { params: { ratio: "16:9", duration: 15, generateAudio: false } });
  assert.equal(body.size, "16:9");
  assert.equal("aspect_ratio" in body, false);
  assert.equal(body.duration, 10);
  assert.equal("audio" in body, false);
});

test("PixVerse V6 Max：aspect_ratio + image_urls 单图，不发首尾帧 / img_references", async () => {
  const { body } = await run("pixverse-v6-max", { inputs: ["https://cdn.example/a.png"], params: { mediaKinds: ["image"], imageRoles: ["first_frame"], ratio: "16:9", duration: 5 } });
  assert.deepEqual(body.image_urls, ["https://cdn.example/a.png"]);
  assert.equal("first_frame_image" in body, false);
  assert.equal("img_references" in body, false);
  assert.equal(body.aspect_ratio, "16:9");
});

test("Vidu Q3 Pro 带图时不发 aspect_ratio", async () => {
  const { body } = await run("viduq3-pro", { inputs: ["https://cdn.example/a.png"], params: { mediaKinds: ["image"], imageRoles: ["first_frame"], ratio: "16:9", duration: 5 } });
  assert.equal("aspect_ratio" in body, false);
  const t2v = await run("viduq3-pro", { params: { ratio: "9:16", duration: 5 } });
  assert.equal(t2v.body.aspect_ratio, "9:16");
});

test("VEO 官方渠道：first_frame_image / last_frame_image，时长 4/6/8，4K 大写", async () => {
  const { body } = await run("veo3.1-fast-official", { inputs: ["https://cdn.example/a.png", "https://cdn.example/b.png"], params: { mediaKinds: ["image", "image"], imageRoles: ["first_frame", "last_frame"], resolution: "4k", duration: 6 } });
  assert.equal(body.first_frame_image, "https://cdn.example/a.png");
  assert.equal(body.last_frame_image, "https://cdn.example/b.png");
  assert.equal("image_urls" in body, false);
  assert.equal("generation_type" in body, false);
  assert.equal(body.resolution, "4K");
  assert.equal(body.duration, 6);
});

test("Gemini Omni 1.1 Flash Ext：首帧 = generation_type frame + image_urls；参考图只能 1 或 3 张", async () => {
  const { body } = await run("gemini-omni-1.1-flash-ext", { inputs: ["https://cdn.example/a.png"], params: { mediaKinds: ["image"], imageRoles: ["first_frame"], duration: 6 } });
  assert.deepEqual(body.image_urls, ["https://cdn.example/a.png"]);
  assert.equal(body.generation_type, "frame");
  assert.equal("first_frame_image" in body, false);
  const two = await run("gemini-omni-1.1-flash-ext", { inputs: ["https://cdn.example/a.png", "https://cdn.example/b.png"], params: { mediaKinds: ["image", "image"], duration: 6 } });
  assert.deepEqual(two.body.image_urls, ["https://cdn.example/a.png"], "2 张会被上游拒绝，收成 1 张");
  assert.equal(two.body.generation_type, "reference");
  const prev = await run("gemini-omni-flash-preview", { params: {} });
  assert.equal(prev.out.ok, false, "preview 必须带参考素材");
});

test("动作控制：缺人物图直接说明，不提交", async () => {
  const { out, requests } = await run("kling-v2-6-motion-control", { inputs: ["https://cdn.example/m.mp4"], params: { mediaKinds: ["video"] } });
  assert.equal(out.ok, false);
  assert.match(out.detail, /人物参考图/);
  assert.equal(requests.filter((r) => r.method === "POST").length, 0);
});

test("Seedream 文生图要 3 张 = 并发 3 个 n=1 的请求", async () => {
  await withMock(async ({ baseUrl, requests }) => {
    // 图片结果走 images，单独 mock 一下任务查询形状不影响：只数提交
    await adapter.generateComplete({ baseUrl, apiKey: "k", model: "seedream-4.5", prompt: "p", count: 3, fetchImpl: fetch, timeoutMs: 50 });
    const posts = requests.filter((r) => r.method === "POST" && r.path === "/v1/images/generations");
    assert.equal(posts.length, 3);
    assert.ok(posts.every((r) => r.json.n === 1));
  });
});

test("文档写明不收 base64 的模型：本地图先上传成公网 URL", async () => {
  const { body, requests } = await run("pixverse-v6", { inputs: [PNG], params: { mediaKinds: ["image"], imageRoles: ["first_frame"], duration: 5 } });
  assert.equal(requests.filter((r) => r.path === "/v1/uploads/images").length, 1);
  assert.match(JSON.stringify(body), /upload\.apimart\.ai/);
  assert.doesNotMatch(JSON.stringify(body), /data:image/);
});

test("Seedream 4.x / 5.0-lite 单次只要 1 张（多张并发），参考视频按模型上限截断", async () => {
  for (const m of ["seedream-4.0", "seedream-4.5", "seedream-5-0-lite"]) {
    assert.deepEqual(adapter.uiSpec(m).batch, [1, 2, 3, 4], m + " 面板仍可选多张");
    assert.equal(catalog.imageModel(m).perReq, 1, m + " 每次请求只要 1 张");
  }
  assert.equal(catalog.videoModel("seedance-2.0").vMax, 3);
  assert.equal(catalog.videoModel("gpt-image-2-official"), null);
  assert.equal(catalog.imageModel("gpt-image-2-official").refs, 16);
  assert.deepEqual(catalog.uiSpec("wan2.7-image").sizes, ["1K", "2K"]);
  assert.deepEqual(catalog.uiSpec("wan2.7-image-pro").sizes, ["1K", "2K", "4K"]);
  assert.equal(catalog.imageModel("grok-imagine-image-2.0").refs, 3);
});
