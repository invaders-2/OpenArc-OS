/**
 * W4b · legacy 图片执行器契约测试（node:http 本地 stub，无外网、无真实密钥）。
 * 源：server/protocols.ts:4244-5371。
 * 覆盖：parseImagePayload / parseApimartImagePayload、OpenAI 兼容同步 + 异步轮询、
 * APIMart 尺寸派生与任务解析、Gemini parts 构造、volcengineImageSize 各入参映射、
 * 以及失败态（任务失败 / 错误码 / 超时 detail）与未移植依赖的结构化错误。
 *
 * W6c 更新：
 *   · midjourney 不再是「未移植依赖」：源 protocols.ts:5309 已由 W6b 接到
 *     media.generateMidjourneyImages，因此改成正向委托断言（本地 stub，零外网）。
 *   · 离线护栏：进程级包住 globalThis.fetch（defaultProtocolTransport 的真实出口），
 *     记录每个出站 host；文件结束时若出现任何非回环 host，整个文件判失败。
 *     另有一个独立于本文件的 socket 级验证见报告（NODE_OPTIONS --import 守护脚本）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const images = require("../electron/protocol-engine/legacy-executor-images.cjs");
const media = require("../electron/protocol-engine/legacy-executor-media.cjs");
const { createVirtualProtocolClock, RecordingTransport } = require("../electron/protocol-engine/transport.cjs");

// ── 离线护栏（W6c）───────────────────────────────────────────────────
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
const outboundHosts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = function offlineGuardedFetch(input, init) {
  try {
    outboundHosts.push(new URL(input instanceof Request ? input.url : String(input)).hostname);
  } catch {
    outboundHosts.push("<unparsable-url>");
  }
  return realFetch.call(globalThis, input, init);
};

after(() => {
  globalThis.fetch = realFetch;
  const offenders = [...new Set(outboundHosts.filter((host) => !LOOPBACK_HOSTS.has(host)))];
  assert.deepEqual(offenders, [], "离线护栏：本次运行访问了非 127.0.0.1 主机 " + offenders.join(", "));
});

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      baseUrl: "http://127.0.0.1:" + server.address().port,
      close: () => new Promise((done) => {
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
        server.close(done);
      }),
    }));
  });
}

function providerFor(baseUrl, protocol = "openai") {
  return { base_url: baseUrl, api_key: "FAKE_W4B_KEY", protocol };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

function json(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

// ── 纯解析 ───────────────────────────────────────────────────────────

test("parseImagePayload：容器递归 / data:image / 类型推断 / 去重（protocols.ts:4244）", () => {
  const longB64 = "A".repeat(160);
  const parsed = images.parseImagePayload({
    data: [{ url: "https://cdn.example.com/a.png" }, { b64_json: longB64 }],
    result: { images: ["data:image/png;base64," + longB64] },
    output: { image_url: { url: "https://cdn.example.com/b.png" } },
  });
  assert.deepEqual(parsed, [
    { type: "url", value: "https://cdn.example.com/a.png" },
    { type: "b64", value: longB64 },
    { type: "url", value: "https://cdn.example.com/b.png" },
  ]);
  assert.deepEqual(images.parseImagePayload(null), []);
  // 无类型提示的普通字符串不被当作图片；显式 url 字段按源逻辑始终按 url 处理。
  assert.deepEqual(images.parseImagePayload({ data: [{ message: "not-an-image" }] }), []);
  assert.deepEqual(images.parseImagePayload({ data: [{ url: "https://cdn.example.com/c.png" }] }), [{ type: "url", value: "https://cdn.example.com/c.png" }]);
});

test("parseApimartImagePayload：candidates inlineData / inline_data / image_url（protocols.ts:4998）", () => {
  assert.deepEqual(
    images.parseApimartImagePayload({ candidates: [{ content: { parts: [{ inlineData: { data: "AAA" } }, { image_url: { url: "https://x.example.com/1.png" } }] } }] }),
    [{ type: "b64", value: "AAA" }, { type: "url", value: "https://x.example.com/1.png" }],
  );
  assert.deepEqual(
    images.parseApimartImagePayload({ data: { candidates: [{ content: { parts: [{ inline_data: { data: "BBB" } }] } }] } }),
    [{ type: "b64", value: "BBB" }],
  );
  assert.deepEqual(images.parseApimartImagePayload({}), []);
});

test("apib 尺寸映射：apibImageAspectRatio / apibImageResolution（protocols.ts:4316 / :4335）", () => {
  assert.equal(images.apibImageAspectRatio("1024x1024"), "1:1");
  assert.equal(images.apibImageAspectRatio("1920x1080"), "16:9");
  assert.equal(images.apibImageAspectRatio("16*9"), "16:9");
  assert.equal(images.apibImageAspectRatio("auto"), "auto");
  assert.equal(images.apibImageAspectRatio("adaptive"), "auto");
  assert.equal(images.apibImageResolution("1024x1024"), "1k");
  assert.equal(images.apibImageResolution("2048x2048"), "2k");
  assert.equal(images.apibImageResolution("4096x1024"), "4k");
  assert.equal(images.apibImageResolution(undefined, "4k"), "4k");
  assert.equal(images.apibImageResolution(""), "1k");
});

test("volcengineImageSize：每种入参映射（protocols.ts:5210）", () => {
  assert.equal(images.volcengineImageSize("", ""), "1024x1024");
  assert.equal(images.volcengineImageSize("4k", ""), "4096x4096");
  assert.equal(images.volcengineImageSize("2k", ""), "2048x2048");
  assert.equal(images.volcengineImageSize("", "doubao-seedream-4.0"), "2048x2048");
  assert.equal(images.volcengineImageSize("1280*720", ""), "1280x720");
  assert.equal(images.volcengineImageSize("1024x1024", "some-volc-model"), "1024x1024");
  assert.equal(images.volcengineImageSize("1024x1024", "doubao-seedream-4.0"), "1920x1920");
  assert.equal(images.volcengineImageSize("1920x1080", "seedream"), "2720x1536");
  assert.equal(images.volcengineImageSize("16:9", "seedream"), "2048x2048");
});

test("apimart 尺寸派生：apimartImageConfig / apimartImageConfigFromParams（protocols.ts:4970 / :4988）", () => {
  assert.deepEqual(images.apimartImageConfig("1024x1024"), { aspectRatio: "1:1", imageSize: "1K" });
  assert.deepEqual(images.apimartImageConfig("2048x2048"), { aspectRatio: "1:1", imageSize: "2K" });
  assert.deepEqual(images.apimartImageConfig("16:9"), { aspectRatio: "16:9", imageSize: "1K" });
  assert.deepEqual(images.apimartImageConfig("4k"), { aspectRatio: "1:1", imageSize: "4K" });
  assert.deepEqual(images.apimartImageConfig(""), { aspectRatio: "1:1", imageSize: "1K" });
  assert.deepEqual(
    images.apimartImageConfigFromParams({ prompt: "x", size: "1024x1024", resolution: "2k" }),
    { aspectRatio: "1:1", imageSize: "2K" },
  );
  assert.deepEqual(
    images.apimartImageConfigFromParams({ prompt: "x", size: "1024x1024", aspect_ratio: "3:4" }),
    { aspectRatio: "3:4", imageSize: "1K" },
  );
});

test("apimart 任务解析：apimartImageTaskId / apimartImageTaskView / isApimartGptImage2（protocols.ts:5023-5041）", () => {
  assert.equal(images.apimartImageTaskId({ data: [{ task_id: "a1" }] }), "a1");
  assert.equal(images.apimartImageTaskId({ result: { submit_id: "s2" } }), "s2");
  assert.equal(images.apimartImageTaskId({ output: { id: "o3" } }), "o3");
  assert.equal(images.apimartImageTaskId({}), "");
  assert.deepEqual(images.apimartImageTaskView({ data: [{ status: "FAILED", fail_reason: "bad" }] }), { status: "FAILED", error: "bad" });
  assert.deepEqual(images.apimartImageTaskView({ status: "SUCCESS" }), { status: "SUCCESS", error: "" });
  assert.equal(images.isApimartGptImage2("models/gpt-image-2"), true);
  assert.equal(images.isApimartGptImage2("gpt-image-1"), false);
});

test("geminiImageParts：参考图 inlineData + text（protocols.ts:5011）", () => {
  const parts = images.geminiImageParts("画一只猫", [{ buf: Buffer.from("abc"), mime: "image/jpeg", name: "r.jpg" }]);
  assert.deepEqual(parts, [
    { inlineData: { mimeType: "image/jpeg", data: Buffer.from("abc").toString("base64") } },
    { text: "画一只猫" },
  ]);
  assert.deepEqual(images.geminiImageParts("  ", []), [{ text: "" }]);
  assert.deepEqual(images.geminiImageParts("p", [{ buf: Buffer.from("z") }])[0].inlineData.mimeType, "image/png");
});

// ── OpenAI 兼容 ──────────────────────────────────────────────────────

test("openai 兼容同步：请求体 + 质量映射 + b64 解析", async () => {
  const b64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  let seen = null;
  const stub = await startStub(async (req, res) => {
    const body = await readBody(req);
    seen = { url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
    json(res, { data: [{ b64_json: b64 }] });
  });
  try {
    const out = await images.generateImages(
      providerFor(stub.baseUrl),
      "gpt-image-1",
      { prompt: "a cat", size: "1024x1024", n: 2, quality: "hd" },
      5000,
    );
    assert.deepEqual(out.images, [{ type: "b64", value: b64 }]);
    assert.equal(seen.url, "/v1/images/generations");
    assert.equal(seen.auth, "Bearer FAKE_W4B_KEY");
    assert.deepEqual(seen.body, { model: "gpt-image-1", prompt: "a cat", size: "1024x1024", quality: "high", n: 2 });
  } finally {
    await stub.close();
  }
});

test("openai 兼容异步：task_id 轮询（非 GPT-Best 站点走 /v1/tasks，protocols.ts:4404）", async () => {
  const requests = [];
  let polls = 0;
  const stub = await startStub(async (req, res) => {
    requests.push(req.method + " " + req.url);
    if (req.url.startsWith("/v1/images/generations")) {
      await readBody(req);
      json(res, { task_id: "task-1", status: "PENDING" });
      return;
    }
    req.resume();
    polls += 1;
    json(res, { data: { status: "SUCCESS", b64_json: "QUJD" } });
  });
  try {
    const clock = createVirtualProtocolClock(0);
    const out = await images.generateImages(providerFor(stub.baseUrl), "some-openai-image", { prompt: "p" }, 60000, undefined, clock);
    assert.deepEqual(out.images, [{ type: "b64", value: "QUJD" }]);
    assert.equal(polls, 1);
    assert.deepEqual(requests, ["POST /v1/images/generations", "GET /v1/tasks/task-1"]);
  } finally {
    await stub.close();
  }
});

test("异步任务失败：fail_reason 原样作为错误 detail（protocols.ts:4427）", async () => {
  const stub = await startStub(async (req, res) => {
    if (req.url.startsWith("/v1/images/generations")) {
      await readBody(req);
      json(res, { taskId: "t9" });
      return;
    }
    req.resume();
    json(res, { data: { status: "FAILED", fail_reason: "内容审核未通过" } });
  });
  try {
    const clock = createVirtualProtocolClock(0);
    await assert.rejects(
      () => images.generateImages(providerFor(stub.baseUrl), "m", { prompt: "p" }, 60000, undefined, clock),
      /内容审核未通过/,
    );
  } finally {
    await stub.close();
  }
});

test("openai 兼容超时 detail（挂起连接 + 中止，protocols.ts:5360）", async () => {
  const stub = await startStub((req) => { req.resume(); /* 永不响应 */ });
  try {
    await assert.rejects(
      () => images.generateImages(providerFor(stub.baseUrl), "m", { prompt: "p" }, 120),
      /图像生成超时/,
    );
  } finally {
    await stub.close();
  }
});

test("editOpenAiCompatibleGenerationImages：image 数组 + 尺寸/质量映射（protocols.ts:4581）", async () => {
  let seen = null;
  const stub = await startStub(async (req, res) => {
    const body = await readBody(req);
    seen = { url: req.url, body: JSON.parse(body) };
    json(res, { data: [{ b64_json: "RURJVA==" }] });
  });
  try {
    const inputs = [{ buf: Buffer.from("x"), mime: "image/png", name: "a.png" }];
    const out = await images.editOpenAiCompatibleGenerationImages(
      providerFor(stub.baseUrl),
      "gpt-image-1",
      { prompt: "p", size: "1536x1024", quality: "standard" },
      inputs,
      5000,
    );
    assert.deepEqual(out.images, [{ type: "b64", value: "RURJVA==" }]);
    assert.deepEqual(seen.body, {
      model: "gpt-image-1",
      prompt: "p",
      n: 1,
      image: ["data:image/png;base64," + Buffer.from("x").toString("base64")],
      size: "1536x1024",
      quality: "medium",
    });
  } finally {
    await stub.close();
  }
});

// ── APIMart ──────────────────────────────────────────────────────────

test("apimart 异步图片：请求体派生 + 任务轮询解析（protocols.ts:5043）", async () => {
  const seen = [];
  const stub = await startStub(async (req, res) => {
    if (req.url.startsWith("/v1/images/generations")) {
      const body = await readBody(req);
      seen.push({ url: req.url, auth: req.headers.authorization, ct: req.headers["content-type"], body: JSON.parse(body) });
      json(res, { data: { task_id: "t7" } });
      return;
    }
    req.resume();
    seen.push({ url: req.url, auth: req.headers.authorization });
    json(res, { data: { status: "SUCCESS", b64_json: "QkJC" } });
  });
  try {
    const clock = createVirtualProtocolClock(0);
    const out = await images.generateApimartImages(
      providerFor(stub.baseUrl, "apimart"),
      "gemini-3.1-flash-image",
      { prompt: "p", size: "2048x2048" },
      1000,
      [],
      undefined,
      clock,
    );
    assert.deepEqual(out.images, [{ type: "b64", value: "QkJC" }]);
    assert.equal(seen[0].url, "/v1/images/generations");
    assert.equal(seen[0].auth, "Bearer FAKE_W4B_KEY");
    assert.equal(seen[0].ct, "application/json");
    assert.deepEqual(seen[0].body, {
      model: "gemini-3.1-flash-image",
      prompt: "p",
      n: 1,
      size: "1:1",
      resolution: "2K",
    });
    assert.equal(seen[1].url, "/v1/tasks/t7");
  } finally {
    await stub.close();
  }
});

test("apimart 任务失败：错误码 detail（protocols.ts:5137）", async () => {
  const stub = await startStub(async (req, res) => {
    if (req.url.startsWith("/v1/images/generations")) {
      await readBody(req);
      json(res, { task_id: "t8" });
      return;
    }
    req.resume();
    json(res, { data: { status: "FAILED", fail_reason: "内容不合规" } });
  });
  try {
    const clock = createVirtualProtocolClock(0);
    await assert.rejects(
      () => images.generateApimartImages(providerFor(stub.baseUrl, "apimart"), "m", { prompt: "p" }, 1000, [], undefined, clock),
      /APIMart 图片任务失败：内容不合规/,
    );
  } finally {
    await stub.close();
  }
});

test("apimart 本地等待超时 detail（protocols.ts:5141）", async () => {
  const stub = await startStub(async (req, res) => {
    if (req.url.startsWith("/v1/images/generations")) { await readBody(req); json(res, { task_id: "t9" }); return; }
    req.resume();
    json(res, { data: { status: "PENDING" } });
  });
  try {
    const clock = createVirtualProtocolClock(0);
    await assert.rejects(
      () => images.generateApimartImages(providerFor(stub.baseUrl, "apimart"), "m", { prompt: "p" }, 200, [], undefined, clock),
      /本地等待已结束/,
    );
  } finally {
    await stub.close();
  }
});

test("apimart 参考图编辑：先上传 /v1/uploads/images，再提交 image_urls", async () => {
  const seen = [];
  const stub = await startStub(async (req, res) => {
    if (req.url === "/v1/uploads/images") {
      await readBody(req);
      seen.push({ url: req.url, ct: req.headers["content-type"] });
      json(res, { data: { url: "https://cdn.example.com/up.png" } });
      return;
    }
    if (req.url.startsWith("/v1/images/generations")) {
      const body = await readBody(req);
      seen.push({ url: req.url, body: JSON.parse(body) });
      json(res, { data: [{ b64_json: "VVBM" }] });
      return;
    }
    req.resume();
    json(res, {});
  });
  try {
    const inputs = [{ buf: Buffer.from("img"), mime: "image/png", name: "r.png" }];
    const out = await images.generateApimartImages(providerFor(stub.baseUrl, "apimart"), "gemini-3.1-flash-image", { prompt: "p" }, 5000, inputs);
    assert.deepEqual(out.images, [{ type: "b64", value: "VVBM" }]);
    assert.equal(seen[0].url, "/v1/uploads/images");
    assert.match(seen[0].ct, /multipart\/form-data/);
    assert.deepEqual(seen[1].body.image_urls, ["https://cdn.example.com/up.png"]);
  } finally {
    await stub.close();
  }
});

test("prepareApibEditInputs：未超预算时原样返回（protocols.ts:4558）", async () => {
  const inputs = [{ buf: Buffer.from("abc"), mime: "image/png", name: "a.png" }];
  const out = await images.prepareApibEditInputs(inputs);
  assert.equal(out, inputs);
});

// ── Gemini / 火山方舟 ───────────────────────────────────────────────

test("gemini 图片：URL / 请求体 / candidates 解析（protocols.ts:5161）", async () => {
  let seen = null;
  const stub = await startStub(async (req, res) => {
    const body = await readBody(req);
    seen = { url: req.url, key: req.headers["x-goog-api-key"], body: JSON.parse(body) };
    json(res, { candidates: [{ content: { parts: [{ inlineData: { data: "R0VN" } }] } }] });
  });
  try {
    const out = await images.generateGeminiImages(
      providerFor(stub.baseUrl, "gemini"),
      "models/gemini-3.1-flash-image",
      { prompt: "p", size: "1024x1024" },
      5000,
    );
    assert.deepEqual(out.images, [{ type: "b64", value: "R0VN" }]);
    assert.equal(seen.url, "/v1beta/models/gemini-3.1-flash-image:generateContent");
    assert.equal(seen.key, "FAKE_W4B_KEY");
    assert.deepEqual(seen.body.contents, [{ role: "user", parts: [{ text: "p" }] }]);
    assert.deepEqual(seen.body.generationConfig.responseModalities, ["TEXT", "IMAGE"]);
    assert.deepEqual(seen.body.generationConfig.imageConfig, { aspectRatio: "1:1", imageSize: "1K" });
  } finally {
    await stub.close();
  }
});

test("gemini 超时 detail（protocols.ts:5201）", async () => {
  const stub = await startStub((req) => { req.resume(); /* 永不响应 */ });
  try {
    await assert.rejects(
      () => images.generateGeminiImages(providerFor(stub.baseUrl, "gemini"), "m", { prompt: "p" }, 120),
      /Gemini 图像生成超时/,
    );
  } finally {
    await stub.close();
  }
});

test("火山方舟图片：size 透传 + 响应解析（protocols.ts:5230）", async () => {
  let seen = null;
  const stub = await startStub(async (req, res) => {
    const body = await readBody(req);
    seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
    json(res, { data: [{ url: "https://cdn.example.com/v.png" }] });
  });
  try {
    const out = await images.generateVolcengineImages(
      providerFor(stub.baseUrl, "volcengine"),
      "some-volc-model",
      { prompt: "p", size: "2048x2048" },
      [],
      5000,
    );
    assert.deepEqual(out.images, [{ type: "url", value: "https://cdn.example.com/v.png" }]);
    assert.equal(seen.url, "/api/v3/images/generations");
    assert.equal(seen.auth, "Bearer FAKE_W4B_KEY");
    assert.deepEqual(seen.body, { model: "some-volc-model", prompt: "p", size: "2048x2048", response_format: "url" });
  } finally {
    await stub.close();
  }
});

// ── Midjourney：正向委托（W6c）───────────────────────────────────────

test("midjourney：generateImages 委托 media.generateMidjourneyImages（apiRoot 指向本地 stub，零外网）", async () => {
  const seen = [];
  const stub = await startStub(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    if (req.method === "POST" && req.url === "/v1/midjourney/generations") {
      json(res, { data: { task_id: "mj-w6c", status: "queued" } });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/midjourney/mj-w6c") {
      json(res, { data: { status: "SUCCEEDED", image_urls: ["https://cdn.example.com/mj-w6c.png"] } });
      return;
    }
    json(res, { error: "not found" }, 404);
  });
  try {
    const rec = new RecordingTransport();
    const clock = createVirtualProtocolClock(0);
    const realGenerate = media.generateMidjourneyImages;
    let delegated = 0;
    // 源 protocols.ts:4639 的 apiRoot 只在 media 执行器内部可配置，W6b 的
    // legacy-executor-images midjourney 分支不转发该字段，因此测试用外层包装
    // 把它指向本地 stub，既走真实提交路径又保证零外网。
    media.generateMidjourneyImages = (provider, model, params, timeoutMs, references, options) => {
      delegated += 1;
      return realGenerate(provider, model, params, timeoutMs, references, { ...options, apiRoot: stub.baseUrl });
    };
    let out;
    try {
      out = await images.generateImages(
        { base_url: "https://api.apimart.ai", api_key: "FAKE_W6C_KEY", protocol: "midjourney" },
        "midjourney-v6",
        { prompt: "赛博朋克城市", size: "1024x1024" },
        20000,
        rec,
        clock,
      );
    } finally {
      media.generateMidjourneyImages = realGenerate;
    }
    assert.equal(delegated, 1, "generateImages 必须委托 media.generateMidjourneyImages");
    assert.deepEqual(out.images, [{ type: "url", value: "https://cdn.example.com/mj-w6c.png" }]);
    assert.deepEqual(rec.transcript.map((entry) => entry.request.method + " " + entry.request.url), [
      "POST " + stub.baseUrl + "/v1/midjourney/generations",
      "GET " + stub.baseUrl + "/v1/midjourney/mj-w6c",
    ]);
    assert.deepEqual(rec.transcript[0].request.body.value, {
      size: "1:1",
      speed: "fast", // 2026-10-29：relax 排队实测很慢，默认改 fast（PR #23）
      metadata: { source: "ccs-os" },
      prompt: "赛博朋克城市",
      version: "6",
    });
    assert.deepEqual([...new Set(rec.transcript.map((entry) => new URL(entry.request.url).hostname))], ["127.0.0.1"]);
    assert.equal(seen.length, 2);
  } finally {
    await stub.close();
  }
});

// ── 未移植依赖与未知协议 ─────────────────────────────────────────────

test("未注入端口 / 未移植依赖：返回 LEGACY_DEPENDENCY_UNAVAILABLE，不做假实现（硬约束 8）", async () => {
  const cases = [
    ["cli:jimeng", /cliJimeng/],
    ["cli:codex", /cliCodex/],
    ["cli:gemini", /cliGemini/],
    ["agnes", /agnes/i],
    ["modelscope", /modelscope/i],
    ["runninghub", /runninghub/i],
  ];
  for (const [protocol, marker] of cases) {
    const result = await images.generateImages({ base_url: "https://example.invalid", api_key: "k", protocol }, "m", { prompt: "p" }, 1000);
    assert.equal(result.ok, false, protocol);
    assert.equal(result.error, "LEGACY_DEPENDENCY_UNAVAILABLE", protocol);
    assert.match(result.detail, marker, protocol);
  }
});

test("未知协议：assertRunnableProtocol 等价判定抛错（protocols.ts:3415）", async () => {
  await assert.rejects(
    () => images.generateImages({ base_url: "https://example.invalid", api_key: "k", protocol: "totally-unknown-proto" }, "m", { prompt: "p" }, 1000),
    /还在待适配/,
  );
});
