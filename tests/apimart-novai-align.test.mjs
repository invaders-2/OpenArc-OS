/**
 * NOVAI 对齐（task-44）：APIMart 视频参考图策略 / 官方渠道 / 时长自愈 / 端点回退 / 状态容错 / 人话错误。
 *
 * 全部离线 mock（127.0.0.1），不联网、不付费。逐个复刻 NOVAI 的 mock 断言：
 *   小请求零上传、超预算才上传、上传失败退回内联、官方渠道必传且无 official_fallback、
 *   413 人话、时长自愈只重试一次且不重复上传、/v1→/v2 端点回退、非标准状态容错。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const apimart = require("../electron/provider-adapter-apimart.cjs");

process.env.APM_FAST = "1";
const API_KEY = "sk-novai-align";
const TINY = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TOO_BIG_BYTES = 1.5 * 1024 * 1024;
const BIG = "data:image/png;base64," + Buffer.alloc(TOO_BIG_BYTES, 0x41).toString("base64");

function fakeNativeImage() {
  const counter = { resizeWidths: [] };
  const make = (scale) => ({
    isEmpty: () => false,
    getSize: () => ({ width: 2000, height: 1200 }),
    resize: ({ width }) => { counter.resizeWidths.push(width); return make(scale * (width / 2000)); },
    toJPEG: (quality) => Buffer.alloc(Math.max(2048, Math.round(TOO_BIG_BYTES * scale * (quality / 100))), 0x41),
    toPNG: () => Buffer.alloc(Math.max(2048, Math.round(TOO_BIG_BYTES * scale)), 0x41),
  });
  return { counter, createFromBuffer() { return make(1); } };
}

function startMock(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const send = (res, status, body, contentType = "application/json") => {
      if (res.writableEnded) return;
      const text = typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "content-type": contentType });
      res.end(text);
    };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        let json = null; try { json = JSON.parse(raw.toString("utf8")); } catch { json = null; }
        const entry = { method: req.method, path: new URL(req.url, "http://127.0.0.1").pathname, bytes: raw.length, raw, json };
        requests.push(entry);
        try { handler(entry, { json: (status, body) => send(res, status, body), html: (status, text) => send(res, status, text, "text/html") }); }
        catch (error) { send(res, 500, { error: { message: String(error && error.message || error) } }); }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ requests, baseUrl: "http://127.0.0.1:" + server.address().port, close: () => new Promise((done) => server.close(done)) }));
  });
}

/** 标准视频 mock：上传 → 提交 → 完成。可选覆盖 submit/poll 行为。 */
function videoMock({ onSubmit = null, onPoll = null, uploadStatus = 200 } = {}) {
  return startMock((entry, reply) => {
    if (entry.path === "/v1/uploads/images") { if (uploadStatus !== 200) { reply.json(uploadStatus, { error: { message: "upload boom" } }); return; } reply.json(200, { url: "https://cdn.example/upload.png" }); return; }
    if (entry.path === "/v1/videos/generations" || entry.path === "/v2/videos/generations") {
      if (onSubmit) { onSubmit(entry, reply); return; }
      reply.json(200, { code: 0, data: [{ task_id: "task_video_1" }] }); return;
    }
    if (entry.method === "GET" && entry.path.startsWith("/v1/tasks/")) {
      if (onPoll) { onPoll(entry, reply); return; }
      reply.json(200, { code: 0, data: { status: "completed", result: { videos: [{ url: ["https://cdn.example/out.mp4"] }] } } }); return;
    }
    reply.json(404, { error: { message: "unexpected " + entry.path } });
  });
}

const baseVideo = () => ({ baseUrl: "", apiKey: API_KEY, model: "seedance-2.5", prompt: "海浪拍岸", params: { duration: 5, ratio: "16:9", resolution: "720p" }, fetchImpl: fetch });

test("① 扩展渠道：内联放得下（JSON ≤900KB）就完全不调 /v1/uploads/images", async () => {
  const mock = await videoMock();
  try {
    const out = await apimart.generateVideo({ ...baseVideo(), baseUrl: mock.baseUrl, inputs: [TINY] });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(mock.requests.filter((r) => r.path.includes("/uploads/")).length, 0, "小请求零上传");
    const submit = mock.requests.find((r) => r.path.includes("/videos/generations"));
    assert.equal(submit.json.image_urls.length, 1);
    assert.match(submit.json.image_urls[0], /^data:image\/png;base64,/, "参考图以 data URL 内联");
    assert.ok(submit.bytes <= 900 * 1024, "JSON 精确字节必须 ≤900KB：" + submit.bytes);
  } finally { await mock.close(); }
});

test("② 扩展渠道：超预算才压缩并逐张上传（长边先 1536，请求体 <1MB）", async () => {
  const mock = await videoMock();
  try {
    const nativeImage = fakeNativeImage();
    const out = await apimart.generateVideo({ ...baseVideo(), baseUrl: mock.baseUrl, inputs: [BIG], nativeImage });
    assert.equal(out.ok, true, JSON.stringify(out));
    const uploads = mock.requests.filter((r) => r.path.includes("/uploads/"));
    assert.equal(uploads.length, 1, "只有一张参考图，超预算后上传一次：" + JSON.stringify(mock.requests.map((r) => r.path)));
    const submit = mock.requests.find((r) => r.path.includes("/videos/generations"));
    assert.match(submit.json.image_urls[0], /^https:\/\/cdn\.example\//, "上传后 body 用公网 URL");
    assert.ok(submit.bytes < 1024 * 1024, "请求体必须 <1MB：" + submit.bytes);
    assert.ok(nativeImage.counter.resizeWidths.includes(1536), "起始长边 1536 应实际生效：" + JSON.stringify(nativeImage.counter.resizeWidths.slice(0, 4)));
  } finally { await mock.close(); }
});

test("③ 扩展渠道：上传失败 → 整体退回压缩 data URL（仍 <1MB，不报错）", async () => {
  const mock = await videoMock({ uploadStatus: 500 });
  try {
    const out = await apimart.generateVideo({ ...baseVideo(), baseUrl: mock.baseUrl, inputs: [BIG], nativeImage: fakeNativeImage() });
    assert.equal(out.ok, true, JSON.stringify(out));
    const submit = mock.requests.find((r) => r.path.includes("/videos/generations"));
    assert.match(submit.json.image_urls[0], /^data:image\//, "上传失败要退回 data URL");
    assert.ok(submit.bytes < 1024 * 1024, "退回内联后请求体仍 <1MB：" + submit.bytes);
    assert.equal(mock.requests.filter((r) => r.path.includes("/uploads/")).length, 1);
  } finally { await mock.close(); }
});

test("④ 官方渠道必传、body 不得出现 official_fallback；扩展渠道只允许显式 false", async () => {
  const official = await videoMock();
  try {
    const out = await apimart.generateVideo({ ...baseVideo(), model: "seedance-2.5-official", baseUrl: official.baseUrl, inputs: [TINY], params: { ...baseVideo().params, official_fallback: false } });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(official.requests.filter((r) => r.path.includes("/uploads/")).length, 1, "官方渠道必须先上传");
    const submit = official.requests.find((r) => r.path.includes("/videos/generations"));
    assert.match(submit.json.image_urls[0], /^https:\/\//, "官方渠道 body 用上传后的 URL");
    assert.equal(Object.prototype.hasOwnProperty.call(submit.json, "official_fallback"), false, "官方渠道不得出现 official_fallback");
  } finally { await official.close(); }

  const extended = await videoMock();
  try {
    const out = await apimart.generateVideo({ ...baseVideo(), baseUrl: extended.baseUrl, inputs: [TINY], params: { ...baseVideo().params, official_fallback: false } });
    assert.equal(out.ok, true, JSON.stringify(out));
    const submit = extended.requests.find((r) => r.path.includes("/videos/generations"));
    assert.equal(submit.json.official_fallback, false, "扩展渠道允许显式 false");
    assert.equal((JSON.stringify(submit.json).match(/official_fallback/g) || []).length, 1, "只写一次");
  } finally { await extended.close(); }
});

test("⑤ 图片生成：官方渠道删除 official_fallback，扩展渠道允许 false", async () => {
  const makeImageMock = () => startMock((entry, reply) => {
    if (entry.path === "/v1/images/generations") { reply.json(200, { code: 0, data: { status: "completed", result: { images: [{ url: ["https://cdn.example/i.png"] }] } } }); return; }
    reply.json(404, {});
  });
  const official = await makeImageMock();
  try {
    const out = await apimart.generateComplete({ baseUrl: official.baseUrl, apiKey: API_KEY, model: "seedream-4-5-official", prompt: "猫", params: { official_fallback: false }, fetchImpl: fetch });
    assert.equal(out.ok, true, JSON.stringify(out));
    const submit = official.requests[0];
    assert.equal(Object.prototype.hasOwnProperty.call(submit.json, "official_fallback"), false);
  } finally { await official.close(); }
  const extended = await makeImageMock();
  try {
    const out = await apimart.generateComplete({ baseUrl: extended.baseUrl, apiKey: API_KEY, model: "seedream-4-5", prompt: "猫", params: { official_fallback: false }, fetchImpl: fetch });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(extended.requests[0].json.official_fallback, false);
  } finally { await extended.close(); }
});

test("⑥ 时长自愈：400 报 duration 区间 → 夹取后原样重发一次，不重新上传素材", async () => {
  let submits = 0;
  const mock = await videoMock({
    onSubmit: (entry, reply) => {
      submits += 1;
      if (submits === 1) { reply.json(400, { error: { message: "duration must be an integer between 4 and 12 seconds" } }); return; }
      reply.json(200, { code: 0, data: [{ task_id: "task_dur" }] });
    },
  });
  try {
    const out = await apimart.generateVideo({ ...baseVideo(), baseUrl: mock.baseUrl, inputs: [BIG], nativeImage: fakeNativeImage(), params: { ...baseVideo().params, duration: 15 } });
    assert.equal(out.ok, true, JSON.stringify(out));
    const calls = mock.requests.filter((r) => r.path.includes("/videos/generations"));
    assert.equal(calls.length, 2, "只重试一次");
    assert.equal(calls[0].json.duration, 15);
    assert.equal(calls[1].json.duration, 12, "夹取到上游给的区间上限");
    assert.equal(mock.requests.filter((r) => r.path.includes("/uploads/")).length, 1, "重试不重复上传");
  } finally { await mock.close(); }
});

test("⑦ 端点回退：/v1 404/405/HTML 才换 /v2", async () => {
  const mock = await videoMock({
    onSubmit: (entry, reply) => {
      if (entry.path === "/v1/videos/generations") { reply.json(404, { error: { message: "not found" } }); return; }
      reply.json(200, { code: 0, data: [{ task_id: "task_v2" }] });
    },
  });
  try {
    const out = await apimart.generateVideo({ ...baseVideo(), baseUrl: mock.baseUrl, inputs: [TINY] });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(mock.requests.filter((r) => r.path.includes("/videos/generations")).map((r) => r.path), ["/v1/videos/generations", "/v2/videos/generations"]);
  } finally { await mock.close(); }
});

test("⑧ 轮询状态容错：非标准成功状态、未知状态但已有 URL 都算成功", async () => {
  for (const status of ["READY", "process_weird"]) {
    const mock = await videoMock({ onPoll: (entry, reply) => reply.json(200, { code: 0, data: { status, result: { videos: [{ url: ["https://cdn.example/out.mp4"] }] } } }) });
    try {
      const out = await apimart.generateVideo({ ...baseVideo(), baseUrl: mock.baseUrl, inputs: [TINY] });
      assert.equal(out.ok, true, status + " 应成功：" + JSON.stringify(out));
      assert.deepEqual(out.artifacts.map((a) => a.url), ["https://cdn.example/out.mp4"]);
    } finally { await mock.close(); }
  }
});

test("⑨ 413 / HTML 给人话：不抛 html 原文，说明 1MB / 不是本机 / 减少参考图", async () => {
  const tooLarge = await videoMock({ onSubmit: (entry, reply) => reply.html(413, "<html><head><title>413 Request Entity Too Large</title></head><body><h1>413</h1></body></html>") });
  try {
    const out = await apimart.generateVideo({ ...baseVideo(), baseUrl: tooLarge.baseUrl, inputs: [TINY] });
    assert.equal(out.ok, false);
    assert.equal(out.error, "PROVIDER_PAYLOAD_TOO_LARGE");
    assert.match(out.detail, /1MB/);
    assert.match(out.detail, /不是本机/);
    assert.match(out.detail, /减少参考图/);
    assert.equal(String(out.detail).includes("<html"), false);
  } finally { await tooLarge.close(); }

  const html200 = await startMock((entry, reply) => {
    if (entry.path.includes("/videos/generations")) { reply.html(200, "<html><body>gateway</body></html>"); return; }
    reply.json(404, {});
  });
  try {
    const out = await apimart.generateVideo({ ...baseVideo(), baseUrl: html200.baseUrl, inputs: [TINY] });
    assert.equal(out.ok, false);
    assert.equal(out.error, "PROVIDER_UPSTREAM_HTML");
    assert.match(out.detail, /网关 HTML/);
    assert.equal(String(out.detail).includes("<html"), false);
  } finally { await html200.close(); }
});

test("⑩ 本地视频/音频：不自动传公共网盘（隐私），要求 https / asset", async () => {
  const mock = await videoMock();
  try {
    const out = await apimart.generateVideo({ ...baseVideo(), baseUrl: mock.baseUrl, inputs: ["data:video/mp4;base64," + Buffer.from("fake").toString("base64")] });
    assert.equal(out.ok, false);
    assert.equal(out.error, "UNSUPPORTED");
    assert.match(out.detail, /隐私/);
    assert.match(out.detail, /公网可访问的 URL/);
    assert.equal(mock.requests.length, 0, "本地音视频不应发出任何请求");
  } finally { await mock.close(); }
});
