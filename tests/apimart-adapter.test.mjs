/**
 * APIMart 适配器离线验收（node:http 起本地 mock 上游，不联网、不写用户目录、不启动 App）。
 *
 * 走真实代码路径：require electron/provider-adapter-apimart.cjs 的
 * generateComplete / generateVideo / upload / chatStream / chatComplete / listModels，
 * fetchImpl 注入全局 fetch，baseUrl 指向本地 127.0.0.1 mock。
 *
 * 覆盖：
 *   ① 适配器登记 + 主机名自动识别（api.apimart.ai / apib.ai，openai-compatible 手配也认）；
 *   ② 401 / 403 / 402 / 429 错误映射（图片与对话两条出口）；
 *   ③ GET /v1/models?expand=category → category / capability_tags / 模型名推断 → 模型域能力；
 *   ④ 图片：POST /v1/images/generations 拿 task_id → 轮询 /v1/tasks/{id} → completed 取 images[].url；
 *   ⑤ 视频：/v1/videos/generations 同一链路（含 failed 状态）；
 *   ⑥ /v1/uploads/images multipart（字段名 file）→ 托管 url；
 *   ⑦ 对话 SSE：流式片段拼成文本（chatStream / chatComplete）；
 *   ⑧ 轮询超时如实报 PROVIDER_TIMEOUT。
 *
 * 第二轮（按 artifacts/apimart/GAP.md 修缺陷）新增：
 *   ⑨ 音视频上传：文档只有 /v1/uploads/images → video/audio 本地文件直接 UNSUPPORTED，公网 URL / asset:// 放行；
 *   ⑩ Suno 必填 version（默认 v6）与 custom_model_id 互斥、结果取 data.result.music[].audio_url；
 *   ⑪ 自动时长 -1 原样透传（seedance-2.5 / wan3.0）；
 *   ⑫ gpt-image-2 支持蒙版（redraw 同时发 image_urls + mask_url）；
 *   ⑬ kling motion-control 按 image_url/video_url 组体；MiniMax-H3-Context-IR/Regeneration 不再当视频生成；
 *   ⑭ 种子表：seedream 系分辨率用大写档位（lite 只 2K/3K/4K）；
 *   ⑮ 协议层：任务 id 取 data[0].task_id、视频分族字段、音乐 version、删掉不存在的音视频上传端点；
 *   ⑯ 协议层音乐运行期组体（legacy-executor-media.generateMusic）也带 Suno version，与适配器同口径。
 *
 * 只消费实现，不复制实现：断言都落在这份适配器的导出上。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const adapter = require("../electron/provider-adapter-apimart.cjs");
const generic = require("../electron/provider-adapter.cjs");

// 轮询间隔压到 1ms（适配器里的测试开关），验收不靠真实等待，也不联网。
process.env.APM_FAST = "1";

const API_KEY = "sk-apimart-test";
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001a5f645400000000049454e44ae426082",
  "hex",
);

function parseJson(buf) {
  const text = buf.toString("utf8");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** 起一个一次性 mock 上游：requests 记录全部请求，handler 决定怎么回。 */
function startMock(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url, "http://127.0.0.1");
        const entry = { method: req.method, path: url.pathname, search: url.search, query: url.searchParams, headers: req.headers, raw, json: parseJson(raw) };
        requests.push(entry);
        handler({ req, res, entry });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        baseUrl: "http://127.0.0.1:" + port + "/v1",
        rootUrl: "http://127.0.0.1:" + port,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("① 适配器登记：adapterType=apimart 直配，镜像域名按主机名自动识别", () => {
  assert.equal(adapter.ADAPTER_TYPE, "apimart");
  assert.equal(generic.adapterFor("apimart"), adapter, "adapterType=apimart 必须选中 APIMart 实现");
  assert.equal(generic.adapterFor("openai-compatible", "https://api.apimart.ai/v1"), adapter, "api.apimart.ai 按主机自动识别");
  assert.equal(generic.adapterFor("", "https://apib.ai"), adapter, "apib.ai 镜像域名（不带 /v1）也认");
  assert.equal(generic.adapterFor(undefined, "https://api.apib.ai"), adapter);
  assert.equal(generic.adapterFor("openai-compatible", "https://api.deepseek.com"), generic, "其它站点仍走 OpenAI 兼容实现");
  assert.equal(generic.adapterFor("openai-compatible", "https://apimart.ai.evil.example"), generic, "只认精确域名，不吃后缀伪装");
  assert.equal(adapter.isApimartUrl("https://apib.ai"), true);
  assert.equal(adapter.isApimartUrl("https://api.apimart.ai"), true);
  assert.equal(adapter.isApimartUrl("https://apimart.ai.evil.example"), false);
  assert.equal(adapter.isApimartUrl("not a url"), false);
  for (const name of ["generateComplete", "generateVideo", "upload", "chatStream", "chatComplete", "listModels"]) {
    assert.equal(typeof adapter[name], "function", "导出缺失：" + name);
  }
});

test("② 401 / 403 / 402 / 429 映射成鉴权 / 额度 / 限流错误，不吞成成功", async () => {
  let status = 401;
  const mock = await startMock(({ res }) => json(res, status, { error: { message: "mock-" + status } }));
  try {
    const cases = [
      [401, "PROVIDER_AUTH_FAILED"],
      [403, "PROVIDER_AUTH_FAILED"],
      [402, "PROVIDER_QUOTA_EXCEEDED"],
      [429, "PROVIDER_RATE_LIMITED"],
    ];
    for (const [code, expected] of cases) {
      status = code;
      const out = await adapter.generateComplete({ baseUrl: mock.baseUrl, apiKey: API_KEY, model: "gpt-image-2.5", prompt: "一只猫", fetchImpl: fetch });
      assert.equal(out.ok, false, "HTTP " + code + " 不能算成功");
      assert.equal(out.error, expected, "HTTP " + code + " 应映射成 " + expected);
      assert.equal(out.status, code);
      assert.match(out.detail, /mock-/);
    }
    status = 401;
    const said = await adapter.chatComplete({ baseUrl: mock.baseUrl, apiKey: API_KEY, model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], fetchImpl: fetch });
    assert.equal(said.ok, false);
    assert.equal(said.error, "PROVIDER_AUTH_FAILED", "对话出口 401 也要映射成鉴权失败");
  } finally {
    await mock.close();
  }
});

test("③ GET /v1/models?expand=category：category / capability_tags / 名字推断 → 模型域能力", async () => {
  const rows = [
    { id: "deepseek-v4-pro", category: "chat", owned_by: "deepseek" },
    { id: "glm-4.6", category: "chat", capability_tags: ["Vision"] },
    { id: "qwen-vl-max", category: "chat" },
    { id: "mystery-chat", category: "chat", capability_tags: ["Embedding"] },
    { id: "text-embedding-3-large", category: "chat" },
    { id: "flux-kontext-pro", category: "image" },
    { id: "kling-v3", category: "video" },
    { id: "kling-v2-6-motion-control", category: "video" },
    { id: "MiniMax-H3-Context-IR", category: "video" },
    { id: "MiniMax-H3-Regeneration", category: "video" },
    { id: "suno-v5", category: "audio" },
    { id: "whisper-1", category: "audio" },
    { id: "gpt-audio-preview", category: "audio" },
    { id: "mystery-model", category: "unknown" },
    { id: "x".repeat(201), category: "chat" },
  ];
  const mock = await startMock(({ res, entry }) => {
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/v1/models");
    assert.equal(entry.query.get("expand"), "category", "拉模型必须带 expand=category 才拿得到类别");
    assert.equal(entry.headers.authorization, "Bearer " + API_KEY);
    json(res, 200, { object: "list", data: rows });
  });
  try {
    const out = await adapter.listModels({ baseUrl: mock.baseUrl, apiKey: API_KEY, fetchImpl: fetch });
    assert.equal(out.ok, true, JSON.stringify(out));
    const byId = new Map(out.items.map((item) => [item.id, item]));
    assert.equal(byId.has("x".repeat(201)), false, "超长 id 丢弃");
    assert.equal(out.items.length, rows.length - 1);

    assert.deepEqual(byId.get("deepseek-v4-pro").suggestedCapabilities, ["chat"]);
    assert.equal(byId.get("deepseek-v4-pro").category, "chat");
    assert.equal(byId.get("deepseek-v4-pro").ownedBy, "deepseek");

    assert.deepEqual(byId.get("glm-4.6").suggestedCapabilities, ["chat", "vision-input"], "capability_tags=Vision 带出看图");
    assert.deepEqual(byId.get("qwen-vl-max").suggestedCapabilities, ["chat", "vision-input"], "名字推断也认全模态");
    assert.deepEqual(byId.get("mystery-chat").suggestedCapabilities, ["embedding"], "Embedding 标签进向量");
    assert.deepEqual(byId.get("text-embedding-3-large").suggestedCapabilities, ["embedding"]);
    assert.deepEqual(byId.get("flux-kontext-pro").suggestedCapabilities, ["image-generation"]);
    assert.equal(byId.get("flux-kontext-pro").category, "image");
    assert.deepEqual(byId.get("kling-v3").suggestedCapabilities, ["video-generation"]);
    assert.deepEqual(byId.get("kling-v2-6-motion-control").suggestedCapabilities, ["video-generation"], "动作控制仍是视频，只是字段不同");
    assert.deepEqual(byId.get("MiniMax-H3-Context-IR").suggestedCapabilities, [], "Context-IR 只产提示词，不标视频生成");
    assert.deepEqual(byId.get("MiniMax-H3-Regeneration").suggestedCapabilities, [], "Regeneration 需要 source_task_id，不标视频生成");
    assert.deepEqual(byId.get("suno-v5").suggestedCapabilities, ["audio-generation"]);
    assert.deepEqual(byId.get("whisper-1").suggestedCapabilities, [], "whisper 是转写，不进生成能力");
    assert.deepEqual(byId.get("gpt-audio-preview").suggestedCapabilities, ["chat"], "实时语音预览按对话算");
    assert.deepEqual(byId.get("mystery-model").suggestedCapabilities, ["chat"], "未知类别回落名字推断");
    assert.equal(byId.get("mystery-model").category, undefined, "未知类别不硬塞 category");
  } finally {
    await mock.close();
  }
});

test("④ 图片：提交拿 task_id → 轮询 /v1/tasks/{id} → completed 取 images[].url", async () => {
  let polls = 0;
  const events = [];
  const mock = await startMock(({ res, entry }) => {
    if (entry.method === "POST" && entry.path === "/v1/images/generations") {
      json(res, 200, { code: 0, data: [{ task_id: "task_img_1", status: "submitted" }] });
      return;
    }
    if (entry.method === "GET" && entry.path === "/v1/tasks/task_img_1") {
      polls += 1;
      if (polls === 1) {
        json(res, 200, { code: 0, data: { task_id: "task_img_1", status: "processing", progress: 40 } });
        return;
      }
      json(res, 200, { code: 0, data: { task_id: "task_img_1", status: "completed", result: { images: [{ url: ["https://cdn.example.com/a.png"] }] } } });
      return;
    }
    json(res, 404, { error: { message: "unexpected " + entry.method + " " + entry.path } });
  });
  try {
    const out = await adapter.generateComplete({
      baseUrl: mock.baseUrl,
      apiKey: API_KEY,
      kind: "image",
      model: "gpt-image-2.5",
      prompt: "一只戴帽子的猫",
      size: "1024x1024",
      count: 1,
      params: { aspect_ratio: "16:9", resolution: "2K" },
      fetchImpl: fetch,
      onEvent: (event) => events.push(event),
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.artifacts, [{ url: "https://cdn.example.com/a.png" }]);

    const submit = mock.requests.find((entry) => entry.path === "/v1/images/generations");
    assert.equal(submit.method, "POST");
    assert.equal(submit.headers.authorization, "Bearer " + API_KEY);
    assert.deepEqual(submit.json, { model: "gpt-image-2.5", prompt: "一只戴帽子的猫", n: 1, size: "16:9", resolution: "2k" });

    const polled = mock.requests.filter((entry) => entry.path === "/v1/tasks/task_img_1");
    assert.equal(polled.length, 2, "第一次 processing，第二次 completed");
    assert.equal(polled[0].query.get("language"), "zh");
    assert.deepEqual(events.filter((event) => event.type === "progress"), [{ type: "progress", progress: 0.4 }]);
  } finally {
    await mock.close();
  }
});

test("⑤ 视频：/v1/videos/generations 走同一条异步链路；failed 如实报 PROVIDER_TASK_FAILED", async () => {
  let phase = "success";
  let polls = 0;
  const mock = await startMock(({ res, entry }) => {
    if (entry.method === "POST" && entry.path === "/v1/videos/generations") {
      json(res, 200, { code: 0, data: [{ task_id: "task_vid_1" }] });
      return;
    }
    if (entry.method === "GET" && entry.path === "/v1/tasks/task_vid_1") {
      polls += 1;
      if (phase === "failed") {
        json(res, 200, { code: 0, data: { status: "failed", error: { message: "内容审核未通过" } } });
        return;
      }
      if (polls % 2 === 1) {
        json(res, 200, { code: 0, data: { status: "pending" } });
        return;
      }
      json(res, 200, { code: 0, data: { status: "completed", result: { videos: [{ url: ["https://cdn.example.com/v.mp4"] }] } } });
      return;
    }
    json(res, 404, { error: { message: "unexpected " + entry.method + " " + entry.path } });
  });
  try {
    const out = await adapter.generateVideo({
      baseUrl: mock.baseUrl,
      apiKey: API_KEY,
      model: "seedance-2.5",
      prompt: "海浪拍岸",
      params: { duration: 5, ratio: "16:9", resolution: "720p" },
      fetchImpl: fetch,
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.artifacts, [{ url: "https://cdn.example.com/v.mp4", mime: "video/mp4" }]);
    const submit = mock.requests.find((entry) => entry.path === "/v1/videos/generations");
    assert.deepEqual(submit.json, { model: "seedance-2.5", prompt: "海浪拍岸", duration: 5, size: "16:9", resolution: "720p" });
    assert.equal(mock.requests.filter((entry) => entry.path === "/v1/tasks/task_vid_1").length, 2);

    phase = "failed";
    const failed = await adapter.generateVideo({ baseUrl: mock.baseUrl, apiKey: API_KEY, model: "seedance-2.5", prompt: "x", params: { duration: 5 }, fetchImpl: fetch });
    assert.equal(failed.ok, false, "上游 failed 不能算成功");
    assert.equal(failed.error, "PROVIDER_TASK_FAILED");
    assert.match(failed.detail, /内容审核未通过/);
  } finally {
    await mock.close();
  }
});

test("⑥ /v1/uploads/images：multipart 字段名 file → 托管 url；已是 http(s) 地址就原样返回", async () => {
  const mock = await startMock(({ res, entry }) => {
    if (entry.method === "POST" && entry.path === "/v1/uploads/images") {
      json(res, 200, { code: 0, data: { url: "https://cdn.example.com/upload.png" } });
      return;
    }
    json(res, 404, { error: { message: "unexpected " + entry.method + " " + entry.path } });
  });
  try {
    const dataUrl = "data:image/png;base64," + PNG_1X1.toString("base64");
    const out = await adapter.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: dataUrl, kind: "image" });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.url, "https://cdn.example.com/upload.png");

    assert.equal(mock.requests.length, 1);
    const sent = mock.requests[0];
    assert.equal(sent.method, "POST");
    assert.match(sent.headers["content-type"], /^multipart\/form-data; boundary=/);
    const body = sent.raw.toString("latin1");
    assert.ok(body.includes('name="file"'), "multipart 字段名必须是 file");
    assert.ok(body.includes('filename="image.png"'), "文件名按 mime 给后缀");
    assert.ok(body.includes("Content-Type: image/png"));

    const passThrough = await adapter.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: "https://cdn.example.com/already.png" });
    assert.deepEqual(passThrough, { ok: true, url: "https://cdn.example.com/already.png" });
    assert.equal(mock.requests.length, 1, "已经是 http(s) 地址就不再上传");
  } finally {
    await mock.close();
  }
});

test("⑦ 对话 SSE：流式片段拼成文本（chatStream / chatComplete，地址不带 /v1 也认）", async () => {
  const mock = await startMock(({ res, entry }) => {
    if (entry.method !== "POST" || entry.path !== "/v1/chat/completions") {
      json(res, 404, { error: { message: "unexpected " + entry.method + " " + entry.path } });
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"，我是 APIMart"}}]}\n\n');
    res.write('data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const streamed = await adapter.chatStream({ baseUrl: mock.rootUrl, apiKey: API_KEY, model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], fetchImpl: fetch });
    assert.equal(streamed.text, "你好，我是 APIMart");
    assert.deepEqual(streamed.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });

    const sent = mock.requests[0];
    assert.equal(sent.path, "/v1/chat/completions", "不带 /v1 的地址要补成 /v1/chat/completions");
    assert.equal(sent.json.stream, true);
    assert.equal(sent.json.model, "deepseek-v4-pro");
    assert.equal(sent.headers.authorization, "Bearer " + API_KEY);

    const complete = await adapter.chatComplete({ baseUrl: mock.rootUrl, apiKey: API_KEY, model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }], fetchImpl: fetch });
    assert.equal(complete.ok, true, JSON.stringify(complete));
    assert.equal(complete.text, "你好，我是 APIMart");
    assert.deepEqual(complete.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    assert.equal(complete.toolCalls, null);
  } finally {
    await mock.close();
  }
});

test("⑧ 轮询超时如实报 PROVIDER_TIMEOUT，并提示远程任务可能仍在处理", async () => {
  const mock = await startMock(({ res, entry }) => {
    if (entry.method === "POST") {
      json(res, 200, { code: 0, data: [{ task_id: "task_slow" }] });
      return;
    }
    json(res, 200, { code: 0, data: { status: "processing", progress: 10 } });
  });
  try {
    const out = await adapter.generateComplete({ baseUrl: mock.baseUrl, apiKey: API_KEY, model: "flux-2-pro", prompt: "x", fetchImpl: fetch, timeoutMs: 25 });
    assert.equal(out.ok, false);
    assert.equal(out.error, "PROVIDER_TIMEOUT");
    assert.match(out.detail, /task_slow/);
    assert.ok(mock.requests.filter((entry) => entry.method === "GET").length >= 1, "至少轮询过一次");
  } finally {
    await mock.close();
  }
});

test("⑨ 音视频上传：文档只有 /v1/uploads/images → video/audio 本地文件直接 UNSUPPORTED，不发假请求", async () => {
  const mock = await startMock(({ res, entry }) => json(res, 404, { error: { message: "unexpected " + entry.path } }));
  try {
    const video = await adapter.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: "data:video/mp4;base64,AAAA", kind: "video" });
    assert.equal(video.ok, false);
    assert.equal(video.error, "UNSUPPORTED");
    assert.equal(video.kind, "video");
    assert.match(video.detail, /\/v1\/uploads\/images/, "要说明文档只有 images 上传");
    assert.match(video.detail, /公网可访问的 URL/, "要说明音视频只能用公网 URL");

    const audio = await adapter.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: "data:audio/mpeg;base64,AAAA", kind: "audio" });
    assert.equal(audio.ok, false);
    assert.equal(audio.error, "UNSUPPORTED");
    assert.equal(mock.requests.length, 0, "不能去打不存在的 /v1/uploads/videos|audios");

    const publicUrl = await adapter.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: "https://cdn.example/ref.mp4", kind: "video" });
    assert.deepEqual(publicUrl, { ok: true, url: "https://cdn.example/ref.mp4" }, "公网 URL 直接用");
    const asset = await adapter.upload({ fetchImpl: fetch, apiKey: API_KEY, baseUrl: mock.baseUrl, value: "asset://asset_a", kind: "video" });
    assert.deepEqual(asset, { ok: true, url: "asset://asset_a" }, "asset:// 素材也放行");
    assert.equal(mock.requests.length, 0);
  } finally {
    await mock.close();
  }
});

test("⑩ 音乐 Suno：必填 version（默认 v6）与 custom_model_id 互斥；结果取 data.result.music[].audio_url", async () => {
  const mock = await startMock(({ res, entry }) => {
    if (entry.method === "POST" && entry.path === "/v1/music/generations") {
      const n = mock.requests.filter((item) => item.path === "/v1/music/generations").length;
      json(res, 200, { code: 200, data: [{ status: "submitted", task_id: "task_mus_" + n }] });
      return;
    }
    if (entry.method === "GET" && entry.path.startsWith("/v1/music/tasks/")) {
      json(res, 200, { code: 200, data: { status: "completed", result: { music: [{ audio_url: "https://cdn.example/music.mp3", title: "t" }] } } });
      return;
    }
    json(res, 404, { error: { message: "unexpected " + entry.method + " " + entry.path } });
  });
  try {
    const out = await adapter.generateAudio({ baseUrl: mock.baseUrl, apiKey: API_KEY, model: "suno", prompt: "轻快的钢琴", params: { kind: "音乐" }, fetchImpl: fetch });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.artifacts, [{ url: "https://cdn.example/music.mp3", mime: "audio/mpeg" }]);
    const submit = mock.requests[0];
    assert.equal(submit.path, "/v1/music/generations");
    assert.equal(submit.json.version, "v6", "Suno 必须带 version（默认 v6）");
    assert.equal(submit.json.custom, false);
    assert.equal("custom_model_id" in submit.json, false);
    assert.equal(mock.requests[1].path, "/v1/music/tasks/task_mus_1", "音乐任务查询走 /v1/music/tasks/{id}");

    const custom = await adapter.generateAudio({ baseUrl: mock.baseUrl, apiKey: API_KEY, model: "suno", prompt: "自定义歌词", params: { kind: "纯音乐", custom: true, custom_model_id: "suno-v7-custom" }, fetchImpl: fetch });
    assert.equal(custom.ok, true, JSON.stringify(custom));
    const second = mock.requests.filter((item) => item.path === "/v1/music/generations")[1];
    assert.equal(second.json.custom_model_id, "suno-v7-custom");
    assert.equal("version" in second.json, false, "custom_model_id 与 version 不能同发");
    assert.equal(second.json.custom, true);
    assert.equal(second.json.instrumental, true);
  } finally {
    await mock.close();
  }
});

test("⑪ 自动时长：clampDur(-1) 原样透传，seedance-2.5 / wan3.0 收到 duration=-1", async () => {
  const catalog = require("../electron/provider-apimart-models.cjs");
  assert.equal(catalog.clampDur({ min: 4, max: 30 }, -1), -1, "-1（模型自动时长）不能被夹成最小值");
  assert.equal(catalog.clampDur([5, 10], -1), -1);
  assert.equal(catalog.clampDur({ min: 4, max: 30 }, 99), 30, "其它越界值仍按范围夹");
  let tasks = 0;
  const mock = await startMock(({ res, entry }) => {
    if (entry.method === "POST" && entry.path === "/v1/videos/generations") {
      tasks += 1;
      json(res, 200, { code: 200, data: [{ status: "submitted", task_id: "task_auto_" + tasks }] });
      return;
    }
    if (entry.method === "GET" && entry.path.startsWith("/v1/tasks/")) {
      json(res, 200, { code: 200, data: { status: "completed", result: { videos: [{ url: ["https://cdn.example/auto.mp4"] }] } } });
      return;
    }
    json(res, 404, { error: { message: "unexpected " + entry.method + " " + entry.path } });
  });
  try {
    for (const model of ["seedance-2.5", "wan3.0-video"]) {
      const out = await adapter.generateVideo({ baseUrl: mock.baseUrl, apiKey: API_KEY, model, prompt: "p", params: { duration: -1, ratio: "16:9", resolution: "720p" }, fetchImpl: fetch });
      assert.equal(out.ok, true, model + " " + JSON.stringify(out));
      const submit = mock.requests.filter((item) => item.path === "/v1/videos/generations").slice(-1)[0];
      assert.equal(submit.json.duration, -1, model + " 的 -1 要原样透传");
    }
  } finally {
    await mock.close();
  }
});

test("⑫ gpt-image-2 支持蒙版：redraw 同时发原图 image_urls 与 mask_url（先走 /v1/uploads/images）", async () => {
  const catalog = require("../electron/provider-apimart-models.cjs");
  assert.equal(catalog.imageModel("gpt-image-2").mask, true, "模型表要标 gpt-image-2 支持 mask");
  let uploads = 0;
  const mock = await startMock(({ res, entry }) => {
    if (entry.method === "POST" && entry.path === "/v1/uploads/images") {
      uploads += 1;
      json(res, 200, { url: "https://cdn.example/upload-" + uploads + ".png" });
      return;
    }
    if (entry.method === "POST" && entry.path === "/v1/images/generations") {
      json(res, 200, { code: 200, data: [{ status: "submitted", task_id: "task_mask_1" }] });
      return;
    }
    if (entry.method === "GET" && entry.path === "/v1/tasks/task_mask_1") {
      json(res, 200, { code: 200, data: { status: "completed", result: { images: [{ url: ["https://cdn.example/edited.png"] }] } } });
      return;
    }
    json(res, 404, { error: { message: "unexpected " + entry.method + " " + entry.path } });
  });
  try {
    const dataUrl = "data:image/png;base64," + PNG_1X1.toString("base64");
    const out = await adapter.editImageMode({ baseUrl: mock.baseUrl, apiKey: API_KEY, model: "gpt-image-2", mode: "redraw", prompt: "把背景换成蓝天", sourceDataUrl: dataUrl, originalDataUrl: dataUrl, fetchImpl: fetch });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.artifacts, [{ url: "https://cdn.example/edited.png" }]);
    const submit = mock.requests.find((item) => item.path === "/v1/images/generations");
    assert.equal(submit.json.mask_url, "https://cdn.example/upload-1.png", "挖空图（透明区=要改的地方）当 mask_url");
    assert.deepEqual(submit.json.image_urls, ["https://cdn.example/upload-2.png"], "原图进 image_urls");
  } finally {
    await mock.close();
  }
});

test("⑬ 动作控制 / 排除族：kling motion-control 按 image_url+video_url 组体；MiniMax-H3-Context-IR/Regeneration 不再当视频生成", async () => {
  const catalog = require("../electron/provider-apimart-models.cjs");
  assert.equal(catalog.videoModel("kling-v2-6-motion-control").motionControl, true);
  assert.equal(catalog.videoModel("kling-v3-motion-control").motionControl, true);
  assert.equal(catalog.videoModel("kling-v3").motionControl, undefined, "普通 kling-v3 不能被动作控制规则抢走");
  assert.equal(catalog.videoModel("MiniMax-H3-Context-IR"), null);
  assert.equal(catalog.videoModel("MiniMax-H3-Regeneration"), null);
  assert.ok(catalog.videoModel("MiniMax-H3"), "普通 MiniMax-H3 仍要识别");
  assert.equal(catalog.uiSpec("MiniMax-H3-Context-IR").unsupported, true, "面板要如实标不能用");

  let tasks = 0;
  const mock = await startMock(({ res, entry }) => {
    if (entry.method === "POST" && entry.path === "/v1/videos/generations") {
      tasks += 1;
      json(res, 200, { code: 200, data: [{ status: "submitted", task_id: "task_mc_" + tasks }] });
      return;
    }
    if (entry.method === "GET" && entry.path.startsWith("/v1/tasks/")) {
      json(res, 200, { code: 200, data: { status: "completed", result: { videos: [{ url: "https://cdn.example/mc.mp4" }] } } });
      return;
    }
    json(res, 404, { error: { message: "unexpected " + entry.method + " " + entry.path } });
  });
  try {
    const out = await adapter.generateVideo({
      baseUrl: mock.baseUrl,
      apiKey: API_KEY,
      model: "kling-v3-motion-control",
      prompt: "",
      inputs: ["https://cdn.example/first.png", "https://cdn.example/motion.mp4"],
      params: { mediaKinds: ["image", "video"], duration: 5, character_orientation: "video", keep_original_sound: true },
      fetchImpl: fetch,
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.artifacts, [{ url: "https://cdn.example/mc.mp4", mime: "video/mp4" }]);
    const submit = mock.requests.find((item) => item.path === "/v1/videos/generations");
    assert.deepEqual(submit.json, {
      model: "kling-v3-motion-control",
      duration: 5,
      image_url: "https://cdn.example/first.png",
      video_url: "https://cdn.example/motion.mp4",
      character_orientation: "video",
      keep_original_sound: true,
    });
    assert.equal("size" in submit.json, false, "动作控制不塞比例字段");
    assert.equal("image_urls" in submit.json, false, "动作控制不用 image_urls");

    const noVideo = await adapter.generateVideo({ baseUrl: mock.baseUrl, apiKey: API_KEY, model: "kling-v2-6-motion-control", prompt: "p", inputs: ["https://cdn.example/first.png"], params: { mediaKinds: ["image"] }, fetchImpl: fetch });
    assert.equal(noVideo.ok, false);
    assert.match(noVideo.detail, /参考视频/);

    const excluded = await adapter.generateVideo({ baseUrl: mock.baseUrl, apiKey: API_KEY, model: "MiniMax-H3-Context-IR", prompt: "p", fetchImpl: fetch });
    assert.equal(excluded.ok, false);
    assert.equal(excluded.error, "UNSUPPORTED");
    assert.equal(tasks, 1, "排除族不能真的提交任务");
  } finally {
    await mock.close();
  }
});

test("⑭ seedream 分辨率：适配器表与协议层都用大写档位，Lite 只 2K/3K/4K", () => {
  const catalog = require("../electron/provider-apimart-models.cjs");
  const builtins = require("../electron/protocol-engine/builtins.cjs");
  const compiler = require("../electron/protocol-engine/compiler.cjs");
  const { findModelProfile } = require("../electron/protocol-engine/modelProfile.cjs");

  assert.deepEqual(catalog.imageModel("seedream-5-0-lite").res, [["2K", "2K"], ["3K", "3K"], ["4K", "4K"]], "适配器表 Lite 只有 2K/3K/4K");
  assert.deepEqual(catalog.imageModel("seedream-4-5").res, [["2K", "2K"], ["4K", "4K"]]);
  assert.equal(catalog.imageModel("seedream-4").res[0][0], "1K");

  const images = builtins.BUILTIN_MODEL_PROTOCOLS_V2.find((protocol) => protocol.id === "apimart-images");
  for (const [model, profileId, options] of [
    ["seedream-4.0", "seedream-4", ["1K", "2K", "4K"]],
    ["seedream-4.5", "seedream-4.5", ["2K", "4K"]],
    ["seedream-5-0-lite", "seedream-5-lite", ["2K", "3K", "4K"]],
  ]) {
    const found = findModelProfile(images.modelProfiles, model);
    assert.ok(found, model + " 必须有专用 profile（否则走通用 generate 发小写 1k）");
    assert.equal(found[0], profileId, model + " 命中的 profile");
    assert.deepEqual(found[1].limits.resolution.options, options, model + " 分辨率档位");
  }
  const compile = (model, resolution) => compiler.compileProtocolPlan({
    providerProtocol: builtins.bearerProvider("apimart-http", "APIMart"),
    modelProtocol: images,
    baseUrl: "https://api.apimart.ai/v1",
    credential: "test",
    task: { requestId: "req", model, intent: "image.generate", prompt: "p", params: { resolution }, inputs: { images: [], videos: [], audios: [], files: [] } },
  }).steps.find((step) => step.id === "submit").request.body;
  assert.equal(compile("seedream-4.0", "2k").resolution, "2K", "协议层发大写档位");
  assert.equal(compile("seedream-5-0-lite", "1K").resolution, "2K", "Lite 不支持 1K → 收敛到 2K");
  assert.equal(compile("seedream-5-0-lite", "3k").resolution, "3K");
});

test("⑮ 协议层对齐文档：任务 id 取数组形态 / 视频分族字段 / 音乐 version / 不再声明假上传端点", () => {
  const legacy = require("../electron/protocol-engine/legacy-protocols.cjs");
  const builtins = require("../electron/protocol-engine/builtins.cjs");
  const validator = require("../electron/protocol-engine/validator.cjs");

  const apimart = legacy.PROTOCOLS.apimart;
  const media = legacy.PROTOCOLS["apimart-media"];
  for (const opId of ["video.generate", "video.image_to_video"]) {
    const operation = apimart.operations[opId];
    assert.match(operation.response.taskId, /^\$\.data\[0\]\.task_id/, opId + " 必须先取数组形态 task_id");
    for (const key of ["aspect_ratio", "size", "audio", "generate_audio", "image_urls", "image_with_roles", "first_frame_image", "last_frame_image", "video_urls", "audio_urls"]) {
      assert.ok(operation.bodyTemplate[key], opId + " 缺字段 " + key);
    }
    assert.equal(operation.response.videos.includes("$..url"), false, "视频结果不能用 $..url 深度通配（会抓到封面/缩略图）");
  }
  for (const opId of ["video.generate", "video.image_to_video", "audio.music"]) {
    assert.match(media.operations[opId].response.taskId, /^\$\.data\[0\]\.task_id/, "apimart-media." + opId + " 也要取 data[0].task_id");
  }
  for (const opId of ["uploads.video", "uploads.audio", "uploads.file"]) {
    assert.equal(media.operations[opId], undefined, opId + " 文档不存在，不能声明");
  }
  assert.equal(media.operations["uploads.image"].path, "/v1/uploads/images");
  for (const key of ["version", "custom", "custom_model_id", "sound_prompt", "length"]) {
    assert.ok(media.operations["audio.music"].bodyTemplate[key], "音乐体缺字段 " + key);
  }

  const images = builtins.BUILTIN_MODEL_PROTOCOLS_V2.find((protocol) => protocol.id === "apimart-images");
  assert.equal(images.operations["upload-video"], undefined, "内置协议也不能声明假视频上传");
  assert.equal(images.operations["upload-audio"], undefined);
  assert.equal(images.operations["upload-image"].path, "/v1/uploads/images");
  for (const protocol of builtins.BUILTIN_MODEL_PROTOCOLS_V2) validator.validateProtocolV2(protocol);
});

test("⑯ 协议层音乐运行期组体也带 Suno 必填 version（legacy-executor-media.generateMusic）", async () => {
  const media = require("../electron/protocol-engine/legacy-executor-media.cjs");
  const { RecordingTransport, createVirtualProtocolClock } = require("../electron/protocol-engine/transport.cjs");
  const provider = { id: "stub-apimart-media", protocol: "apimart-media", base_url: "", api_key: API_KEY };
  const mock = await startMock(({ res, entry }) => {
    if (entry.method === "POST" && entry.path === "/v1/music/generations") {
      json(res, 200, { data: { audio_url: "https://cdn.example/music-legacy.mp3" } });
      return;
    }
    json(res, 404, { error: { message: "unexpected " + entry.method + " " + entry.path } });
  });
  try {
    provider.base_url = mock.baseUrl;
    const rec = new RecordingTransport();
    const out = await media.generateMusic(provider, "suno", { prompt: "轻快的钢琴" }, 5000, rec, createVirtualProtocolClock());
    assert.deepEqual(out.audios, [{ type: "url", value: "https://cdn.example/music-legacy.mp3" }]);
    assert.equal(rec.transcript[0].request.url, mock.rootUrl + "/v1/music/generations", "协议层音乐提交走 /v1/music/generations");
    const body = rec.transcript[0].request.body.value;
    assert.equal(body.model, "suno");
    assert.equal(body.version, "v6", "协议层音乐组体必须带 Suno 必填 version");
    assert.equal(body.custom, false);
    assert.equal("custom_model_id" in body, false);

    const customRec = new RecordingTransport();
    const out2 = await media.generateMusic(provider, "suno", { prompt: "自定义歌词", custom: true, custom_model_id: "suno-v7-custom" }, 5000, customRec, createVirtualProtocolClock());
    assert.equal(out2.audios.length, 1);
    const body2 = customRec.transcript[0].request.body.value;
    assert.equal(body2.custom, true);
    assert.equal(body2.custom_model_id, "suno-v7-custom");
    assert.equal("version" in body2, false, "custom_model_id 与 version 不能同发");

    const flowRec = new RecordingTransport();
    await media.generateMusic(provider, "flowmusic", { prompt: "lofi" }, 5000, flowRec, createVirtualProtocolClock());
    const body3 = flowRec.transcript[0].request.body.value;
    assert.equal(body3.model, "flowmusic");
    assert.equal("version" in body3, false, "非 Suno 音乐模型不能带 Suno version");
  } finally {
    await mock.close();
  }
});
