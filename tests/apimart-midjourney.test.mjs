/**
 * APIMart Midjourney 接入（docs.apimart.ai/cn/api-reference/images/midjourney，2026-10-29 实测）。
 * 之前画布选 midjourney 会走 /v1/images/generations，上游真实返回 500 model_price_error。
 * mock 的提交 / 查询响应照搬 2026-10-29 真实任务的返回结构。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const adapter = require("../electron/provider-adapter-apimart.cjs");
const catalog = require("../electron/provider-apimart-models.cjs");
process.env.APM_FAST = "1";

const IMGS = [0, 1, 2, 3].map((i) => "https://getapib.org/image/x-image_task_T_" + i + ".png");
async function withMock(fn, { queryShape = "unified", polls = 1 } = {}) {
  const requests = [];
  let seen = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* multipart */ }
      requests.push({ method: req.method, path: req.url, json: body });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/uploads/images") return send(200, { url: "https://upload.apimart.ai/f/image/u1.png" });
      if (req.url === "/v1/images/generations") return send(500, { error: { message: "model `midjourney` ratio or price is not configured.", type: "apimart_error", code: "model_price_error" } });
      if (req.method === "POST" && req.url.startsWith("/v1/midjourney/generations")) return send(200, { code: 200, data: [{ status: "submitted", task_id: "task_T" }] });
      if (req.url.startsWith("/v1/tasks/task_T")) {
        seen += 1;
        if (seen <= polls) return send(200, { code: 200, data: { id: "task_T", progress: 0, status: "processing", cost: 0.055 } });
        if (queryShape === "failed") return send(200, { code: 200, data: { id: "task_T", status: "failed", fail_reason: "banned prompt" } });
        return send(200, { code: 200, data: { id: "task_T", progress: 100, status: "completed", result: { images: [{ expires_at: 1, url: IMGS }] } } });
      }
      send(404, { error: { message: "nope" } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = "http://127.0.0.1:" + server.address().port + "/v1";
  try { return await fn({ baseUrl, requests }); } finally { await new Promise((r) => server.close(r)); }
}
const posts = (requests) => requests.filter((r) => r.method === "POST" && r.path !== "/v1/uploads/images");

test("midjourney / niji 都按图片模型识别，面板 1 次 = 4 张、可带参考图", () => {
  for (const m of ["midjourney", "midjourney-v7", "mj-v6.1", "niji-6"]) {
    const s = adapter.uiSpec ? adapter.uiSpec(m) : catalog.uiSpec(m);
    assert.equal(s.kind, "image", m);
  }
  const s = catalog.uiSpec("midjourney");
  assert.ok(s.ratios.includes("16:9"));
  assert.equal(s.maxRefs, 4);
  assert.equal(adapter.uiSpec("midjourney").secs, 300, "面板预计耗时按实测 ~5 分钟");
  assert.equal(catalog.imageModel("mjx"), null);
});

test("文生图走 /v1/midjourney/generations，不带 model / n，轮询 /v1/tasks 拿到 4 张", async () => {
  await withMock(async ({ baseUrl, requests }) => {
    const out = await adapter.generateComplete({ baseUrl, apiKey: "k", model: "midjourney", prompt: "a cat", params: { ratio: "16:9" }, count: 1, fetchImpl: fetch });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.artifacts.map((a) => a.url), IMGS);
    const [p] = posts(requests);
    assert.equal(p.path, "/v1/midjourney/generations");
    assert.equal("model" in p.json, false);
    assert.equal("n" in p.json, false);
    assert.equal(p.json.size, "16:9");
    assert.equal(p.json.speed, "fast");
    assert.equal("version" in p.json, false);
    assert.ok(requests.some((r) => r.path.startsWith("/v1/tasks/task_T")));
    assert.equal(requests.some((r) => r.path === "/v1/images/generations"), false);
  });
});

test("版本 / niji 从模型名推断；speed 可指定", async () => {
  await withMock(async ({ baseUrl, requests }) => {
    await adapter.generateComplete({ baseUrl, apiKey: "k", model: "niji-6", prompt: "girl", params: { speed: "relax", stylize: 250 }, fetchImpl: fetch });
    await adapter.generateComplete({ baseUrl, apiKey: "k", model: "midjourney-v7", prompt: "dog", fetchImpl: fetch });
    const [a, b] = posts(requests).map((r) => r.json);
    assert.equal(a.niji, true); assert.equal(a.version, "6"); assert.equal(a.speed, "relax"); assert.equal(a.stylize, 250);
    assert.equal(b.version, "7"); assert.equal("niji" in b, false);
  }, { polls: 0 });
});

test("图生图走 /edits，参考图先上传成网址", async () => {
  await withMock(async ({ baseUrl, requests }) => {
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const out = await adapter.editImageMode({ baseUrl, apiKey: "k", model: "midjourney", prompt: "make it night", sourceDataUrl: PNG, fetchImpl: fetch });
    assert.equal(out.ok, true, JSON.stringify(out));
    const [p] = posts(requests);
    assert.equal(p.path, "/v1/midjourney/generations/edits");
    assert.deepEqual(p.json.image_urls, ["https://upload.apimart.ai/f/image/u1.png"]);
    assert.equal(p.json.prompt, "make it night");
  }, { polls: 0 });
});

test("任务失败时把上游原因带出来", async () => {
  await withMock(async ({ baseUrl }) => {
    const out = await adapter.generateComplete({ baseUrl, apiKey: "k", model: "midjourney", prompt: "x", fetchImpl: fetch });
    assert.equal(out.ok, false);
    assert.match(out.detail, /banned prompt/);
  }, { queryShape: "failed", polls: 0 });
});

/* ---- 全局 AI 的 Midjourney 技能走 legacy 执行器（/v1/midjourney/{id} 原生查询）---- */
const media = require("../electron/protocol-engine/legacy-executor-media.cjs");
function legacyTransport(answers) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
      const next = answers.shift();
      return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}
const clock = { now: (() => { let t = 0; return () => (t += 1000); })(), sleep: async () => {} };
const PROVIDER = { protocol: "midjourney", api_key: "k", base_url: "https://api.apimart.ai" };

test("legacy：名字没版本号就不传 version（以前写死 6.1），默认 fast，niji 带 niji:true", async () => {
  const t = legacyTransport([
    { code: 200, data: [{ status: "submitted", task_id: "task_A" }] },
    { code: 200, data: [{ status: "submitted", task_id: "task_B" }] },
    { code: 200, data: [{ status: "submitted", task_id: "task_C" }] },
  ]);
  await media.submitMidjourney(PROVIDER, "midjourney", { prompt: "cat", size: "16:9" }, 1000, { transport: t, clock });
  await media.submitMidjourney(PROVIDER, "niji-6", { prompt: "girl", version: "niji-6" }, 1000, { transport: t, clock });
  await media.submitMidjourney(PROVIDER, "midjourney", { prompt: "dog", speed: "relax", version: "7" }, 1000, { transport: t, clock });
  const [a, b, c] = t.calls.map((x) => x.body);
  assert.equal("version" in a, false); assert.equal(a.speed, "fast"); assert.equal(a.size, "16:9");
  assert.equal(b.niji, true); assert.equal(b.version, "6");
  assert.equal(c.speed, "relax"); assert.equal(c.version, "7"); assert.equal("niji" in c, false);
  assert.equal(t.calls[0].url, "https://api.apimart.ai/v1/midjourney/generations");
});

test("legacy：轮询真实返回结构（IN_PROGRESS → SUCCESS，顶层 image_urls 4 张），upscale 结果 1 张", async () => {
  const t = legacyTransport([
    { code: 200, data: [{ status: "submitted", task_id: "task_T" }] },
    { action: "IMAGINE", id: "task_T", progress: "0%", status: "IN_PROGRESS" },
    { action: "IMAGINE", id: "task_T", progress: "100%", status: "SUCCESS", grid_image_url: "https://getapib.org/image/grid.png", image_urls: IMGS, buttons: [{ customId: "MJ::JOB::upsample::1::abc", label: "U1" }] },
    { code: 200, data: [{ status: "submitted", task_id: "task_U" }] },
    { action: "UPSCALE", id: "task_U", progress: "100%", status: "SUCCESS", upscale_mode: "selection", image_urls: ["https://getapib.org/image/u1.png"] },
  ]);
  const gen = await media.generateMidjourneyImages(PROVIDER, "midjourney", { prompt: "cat" }, 60000, [], { transport: t, clock });
  assert.deepEqual(gen.images.map((i) => i.value), IMGS);
  assert.equal(t.calls[1].url, "https://api.apimart.ai/v1/midjourney/task_T");
  const up = await media.submitMidjourneyAction(PROVIDER, { action: "upscale", task_id: "task_T", index: 1 }, 1000, { transport: t, clock });
  assert.equal(up.taskId, "task_U");
  assert.deepEqual(t.calls[3].body.index, 1);
  const done = await media.getMidjourneyTask(PROVIDER, "task_U", 1000, { transport: t, clock });
  assert.equal(done.status, "succeeded");
  assert.deepEqual(done.images.map((i) => i.value), ["https://getapib.org/image/u1.png"]);
});
