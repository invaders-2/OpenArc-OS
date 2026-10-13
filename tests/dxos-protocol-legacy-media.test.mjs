/**
 * W4c · legacy 执行器（视频 / 音频 / 图片编辑 / Midjourney）契约测试。
 *
 * 全部使用本地 node:http stub（127.0.0.1，无外网、无真实密钥），网络统一走
 * protocol-engine/transport.cjs 的 RecordingTransport，轮询用虚拟时钟，
 * 因此测试不依赖真实等待时间。
 *
 * 覆盖：
 *   · 视频 submit → poll → result：agtoken / zkki / minimax 各一条
 *   · 视频失败与超时（agtoken 失败、minimax 超时）
 *   · 音频三件套：generateSpeech（binary 落盘）/ transcribeAudio（multipart）/ generateMusic
 *   · editImages multipart 字段
 *   · Midjourney submit / get / action / modal / generate
 *   · 未移植依赖返回结构化 LEGACY_DEPENDENCY_UNAVAILABLE
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const media = require("../electron/protocol-engine/legacy-executor-media.cjs");
const aggregate = require("../electron/protocol-engine/legacy-executor.cjs");
const { RecordingTransport, createVirtualProtocolClock } = require("../electron/protocol-engine/transport.cjs");

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        Promise.resolve(handler(req, body, res)).catch((error) => {
          try {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end(String((error && error.stack) || error));
          } catch { /* socket already closed */ }
        });
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      baseUrl: "http://127.0.0.1:" + server.address().port,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function binary(res, bytes, contentType) {
  res.writeHead(200, { "content-type": contentType });
  res.end(Buffer.from(bytes));
}

function notFound(res) {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

function provider(protocol, baseUrl) {
  return { id: "stub-" + protocol, protocol, base_url: baseUrl, api_key: "FAKE_W4C_TEST_KEY" };
}

function multipartFields(entry) {
  assert.equal(entry.request.body.kind, "multipart");
  return entry.request.body.fields;
}

function fieldValue(fields, name) {
  const found = fields.find((item) => item.name === name);
  return found ? found.value : undefined;
}

// ── 视频：AGToken submit → poll → result ─────────────────────────────

test("视频 AGToken：submit → poll → result", async (t) => {
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST" && req.url === "/v1/video/generations") {
      return json(res, { data: { task_id: "ag-1", task_status: "queued" } });
    }
    if (req.method === "GET" && req.url === "/v1/video/generations/ag-1") {
      return json(res, { data: { task_id: "ag-1", task_status: "SUCCEEDED", result_url: "https://cdn.example/agtoken.mp4" } });
    }
    return notFound(res);
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  const clock = createVirtualProtocolClock();
  const result = await media.generateVideos(provider("agtoken", stub.baseUrl), "wan3.0-video（国内）", { prompt: "一只猫在草地上奔跑" }, undefined, 2000, rec, clock);

  assert.deepEqual(result.videos, [{ type: "url", value: "https://cdn.example/agtoken.mp4" }]);
  assert.equal(rec.transcript.length, 2);
  assert.equal(rec.transcript[0].request.method, "POST");
  assert.equal(rec.transcript[0].request.url, stub.baseUrl + "/v1/video/generations");
  assert.equal(rec.transcript[0].request.body.kind, "json");
  assert.equal(rec.transcript[0].request.body.value.model, "wan3.0-video（国内）");
  assert.equal(rec.transcript[1].request.method, "GET");
  assert.equal(rec.transcript[1].request.url, stub.baseUrl + "/v1/video/generations/ag-1");
});

// D2：api.dx-os.com 的 /v1/media/temp/ 参考素材不得被探测（录制 host + 命中即失败，绝不联网）。
test("视频 AGToken：api.dx-os.com 临时素材不再探测，参考图原样提交", async (t) => {
  const dxTempUrl = "https://api.dx-os.com/v1/media/temp/reference-1.png";
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST" && req.url === "/api/v1/services/aigc/video-generation/video-synthesis") {
      return json(res, { data: { task_id: "ag-dx", task_status: "queued" } });
    }
    if (req.method === "GET" && req.url === "/api/v1/tasks/ag-dx") {
      return json(res, { data: { task_id: "ag-dx", task_status: "SUCCEEDED", result_url: "https://cdn.example/dx.mp4" } });
    }
    return notFound(res);
  });
  t.after(() => stub.close());

  // 记录型 transport：统计 host，且任何 api.dx-os.com 命中都直接失败（保证离线）。
  const hosts = [];
  const hostGuard = {
    fetch(input, init) {
      const url = String(input && input.url ? input.url : input);
      let host = "";
      try { host = new URL(url).hostname; } catch { /* 非法 URL 交给下游报错 */ }
      hosts.push(host);
      if (host === "api.dx-os.com") return Promise.reject(new Error("测试禁止访问 api.dx-os.com"));
      return fetch(input, init);
    },
  };
  const rec = new RecordingTransport(hostGuard);
  const clock = createVirtualProtocolClock();
  const result = await media.generateVideos(
    provider("agtoken", stub.baseUrl),
    "wan3.0-video（国内）",
    { prompt: "参考这个画面", images: [{ publicUrl: dxTempUrl, role: "reference_image" }] },
    undefined,
    2000,
    rec,
    clock,
  );

  // 参考素材不得丢失：DX 临时 URL 原样进入 submit body（源 protocols.ts:5680 的等价分支）。
  const submit = rec.transcript[0];
  assert.equal(submit.request.method, "POST");
  assert.ok(JSON.stringify(submit.request.body.value).includes(dxTempUrl), "DX 临时素材 URL 必须原样提交");
  // 不产生任何对 api.dx-os.com 的请求。
  assert.equal(hosts.includes("api.dx-os.com"), false, "不得对 api.dx-os.com 发起任何请求");
  assert.equal(
    rec.transcript.some((entry) => { try { return new URL(entry.request.url).hostname === "api.dx-os.com"; } catch { return false; } }),
    false,
    "录制 transcript 中不得出现 api.dx-os.com",
  );
  assert.deepEqual(result.videos, [{ type: "url", value: "https://cdn.example/dx.mp4" }]);
});

// ── 视频：ZKKI submit → poll → binary content ────────────────────────

test("视频 ZKKI：submit → poll → content（二进制转 data URL）", async (t) => {
  const videoBytes = [0, 0, 0, 24, 102, 116, 121, 112];
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST" && req.url === "/v1/videos") {
      return json(res, { id: "zk-1" });
    }
    if (req.method === "GET" && req.url === "/v1/videos/zk-1") {
      return json(res, { data: { status: "completed" } });
    }
    if (req.method === "GET" && req.url === "/v1/videos/zk-1/content") {
      return binary(res, videoBytes, "video/mp4");
    }
    return notFound(res);
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  const clock = createVirtualProtocolClock();
  const result = await media.generateVideos(provider("zkki", stub.baseUrl), "seedance-1-0-pro", { prompt: "海浪" }, undefined, 2000, rec, clock);

  const expected = "data:video/mp4;base64," + Buffer.from(videoBytes).toString("base64");
  assert.deepEqual(result.videos, [{ type: "url", value: expected }]);
  assert.equal(rec.transcript.length, 3);
  assert.equal(rec.transcript[0].request.url, stub.baseUrl + "/v1/videos");
  assert.equal(rec.transcript[1].request.url, stub.baseUrl + "/v1/videos/zk-1");
  assert.equal(rec.transcript[2].request.url, stub.baseUrl + "/v1/videos/zk-1/content");
});

// ── 视频：MiniMax submit → poll → result ─────────────────────────────

test("视频 MiniMax：submit → poll → result", async (t) => {
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST" && req.url === "/v2/video_generation") {
      return json(res, { task_id: "mm-1" });
    }
    if (req.method === "GET" && req.url === "/v2/query/video_generation/mm-1") {
      return json(res, { task: { status: "succeeded", content: { url: "https://cdn.example/minimax.mp4" } } });
    }
    return notFound(res);
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  const clock = createVirtualProtocolClock();
  const result = await media.generateVideos(provider("minimax", stub.baseUrl), "MiniMax-H3", { prompt: "日出", duration: 6 }, undefined, 20000, rec, clock);

  assert.deepEqual(result.videos, [{ type: "url", value: "https://cdn.example/minimax.mp4" }]);
  assert.equal(rec.transcript.length, 2);
  assert.equal(rec.transcript[0].request.url, stub.baseUrl + "/v2/video_generation");
  assert.equal(rec.transcript[0].request.body.value.model, "MiniMax-H3");
  assert.equal(rec.transcript[0].request.body.value.duration, 6);
  assert.equal(rec.transcript[1].request.url, stub.baseUrl + "/v2/query/video_generation/mm-1");
});

// ── 视频：失败与超时 ─────────────────────────────────────────────────

test("视频 AGToken：失败状态抛错（不静默）", async (t) => {
  const stub = await startStub((_req, _body, res) => {
    return json(res, { data: { task_id: "ag-fail", task_status: "FAILED", fail_reason: "内容被拒绝" } });
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  const clock = createVirtualProtocolClock();
  await assert.rejects(
    media.generateVideos(provider("agtoken", stub.baseUrl), "wan3.0-video（国内）", { prompt: "x" }, undefined, 2000, rec, clock),
    /AGToken 视频任务失败/,
  );
  assert.equal(rec.transcript.length, 1);
});

test("视频 MiniMax：超时抛错", async (t) => {
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST") return json(res, { task_id: "mm-slow" });
    return json(res, { task: { status: "running" } });
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  const clock = createVirtualProtocolClock();
  await assert.rejects(
    media.generateVideos(provider("minimax", stub.baseUrl), "MiniMax-H3", { prompt: "x" }, undefined, 10000, rec, clock),
    /MiniMax H3 视频生成超时/,
  );
  assert.ok(rec.transcript.length >= 2);
});

// ── 音频三件套 ───────────────────────────────────────────────────────

test("音频 generateSpeech：JSON 请求 + binary 响应并落盘", async (t) => {
  const audioBytes = [82, 73, 70, 70, 1, 2, 3, 4];
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST" && req.url === "/v1/audio/speech") return binary(res, audioBytes, "audio/mpeg");
    return notFound(res);
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  const result = await media.generateSpeech(provider("openai", stub.baseUrl), "tts-1", { input: "你好世界", voice: "alloy" }, 5000, rec);

  assert.equal(rec.transcript[0].request.url, stub.baseUrl + "/v1/audio/speech");
  assert.equal(rec.transcript[0].request.body.kind, "json");
  assert.equal(rec.transcript[0].request.body.value.model, "tts-1");
  assert.equal(rec.transcript[0].request.body.value.input, "你好世界");
  assert.equal(rec.transcript[0].request.body.value.voice, "alloy");
  assert.equal(result.mime, "audio/mpeg");
  assert.ok(Buffer.isBuffer(result.data));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-w4c-audio-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "speech.mp3");
  fs.writeFileSync(file, result.data);
  assert.deepEqual([...fs.readFileSync(file)], audioBytes);
});

test("音频 transcribeAudio：multipart 字段与文本解析", async (t) => {
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST" && req.url === "/v1/audio/transcriptions") return json(res, { text: "hello world" });
    return notFound(res);
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  const input = { buf: Buffer.from("RIFF0000WAVE"), mime: "audio/wav", name: "sample.wav" };
  const result = await media.transcribeAudio(provider("openai", stub.baseUrl), "whisper-1", input, { language: "zh" }, 5000, rec);

  assert.equal(rec.transcript[0].request.url, stub.baseUrl + "/v1/audio/transcriptions");
  const fields = multipartFields(rec.transcript[0]);
  assert.equal(fieldValue(fields, "model"), "whisper-1");
  assert.equal(fieldValue(fields, "language"), "zh");
  assert.equal(fieldValue(fields, "response_format"), "json");
  const file = fields.find((item) => item.name === "file");
  assert.ok(file && file.file, "multipart 必须包含 file 文件字段");
  assert.equal(file.file.name, "sample.wav");
  assert.equal(file.file.type, "audio/wav");
  assert.equal(result.text, "hello world");
  assert.deepEqual(result.raw, { text: "hello world" });
});

test("音频 generateMusic：点单请求与音频地址解析", async (t) => {
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST" && req.url === "/v1/music/generations") {
      return json(res, { data: { audio_url: "https://cdn.example/music.mp3" } });
    }
    return notFound(res);
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  const clock = createVirtualProtocolClock();
  const result = await media.generateMusic(provider("apimart-media", stub.baseUrl), "suno-v4", { prompt: "轻快的钢琴" }, 5000, rec, clock);

  assert.equal(rec.transcript[0].request.url, stub.baseUrl + "/v1/music/generations");
  assert.equal(rec.transcript[0].request.body.value.model, "suno-v4");
  assert.deepEqual(result.audios, [{ type: "url", value: "https://cdn.example/music.mp3" }]);
});

// ── 图片编辑：multipart 字段 ─────────────────────────────────────────

test("editImages：OpenAI multipart（多图 image[] + model/prompt/size/quality/n）", async (t) => {
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST" && req.url === "/v1/images/edits") {
      return json(res, { data: [{ url: "https://cdn.example/edited.png" }] });
    }
    return notFound(res);
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  const inputs = [
    { buf: Buffer.from("PNG-ONE"), mime: "image/png", name: "one.png" },
    { buf: Buffer.from("PNG-TWO"), mime: "image/png", name: "two.png" },
  ];
  const result = await media.editImages(
    provider("openai", stub.baseUrl),
    "gpt-image-1",
    { prompt: "把背景换成蓝天", size: "1024x1024", quality: "high", n: 2 },
    inputs,
    5000,
    rec,
  );

  assert.equal(rec.transcript[0].request.url, stub.baseUrl + "/v1/images/edits");
  const fields = multipartFields(rec.transcript[0]);
  assert.equal(fieldValue(fields, "model"), "gpt-image-1");
  assert.equal(fieldValue(fields, "prompt"), "把背景换成蓝天");
  assert.equal(fieldValue(fields, "size"), "1024x1024");
  assert.equal(fieldValue(fields, "quality"), "high");
  assert.equal(fieldValue(fields, "n"), "2");
  const imageFiles = fields.filter((item) => item.name === "image[]");
  assert.equal(imageFiles.length, 2, "两张参考图必须使用 image[] 字段");
  assert.deepEqual(imageFiles.map((item) => item.file.name), ["one.png", "two.png"]);
  assert.deepEqual(result.images, [{ type: "url", value: "https://cdn.example/edited.png" }]);
});

test("editImages：单图使用 image 字段名", async (t) => {
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST" && req.url === "/v1/images/edits") return json(res, { data: [{ url: "https://cdn.example/single.png" }] });
    return notFound(res);
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  await media.editImages(provider("openai", stub.baseUrl), "gpt-image-1", { prompt: "润色" }, [{ buf: Buffer.from("P"), mime: "image/png", name: "p.png" }], 5000, rec);
  const fields = multipartFields(rec.transcript[0]);
  assert.ok(fields.some((item) => item.name === "image"));
  assert.ok(!fields.some((item) => item.name === "image[]"));
});

// ── Midjourney ───────────────────────────────────────────────────────

test("Midjourney：submit / get / action / modal / generate 路径与响应解析", async (t) => {
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST" && req.url === "/v1/midjourney/generations") {
      return json(res, { data: { task_id: "mj-1", status: "queued" } });
    }
    if (req.method === "GET" && req.url === "/v1/midjourney/mj-1") {
      return json(res, { data: { status: "SUCCEEDED", image_urls: ["https://cdn.example/mj-a.png", "https://cdn.example/mj-b.png"] } });
    }
    if (req.method === "POST" && req.url === "/v1/midjourney/generations/upscale") {
      return json(res, { data: { task_id: "mj-2", status: "queued" } });
    }
    if (req.method === "POST" && req.url === "/v1/midjourney/generations/modal") {
      return json(res, { data: { task_id: "mj-3", status: "submitted" } });
    }
    return notFound(res);
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  const clock = createVirtualProtocolClock();
  const options = { apiRoot: stub.baseUrl, transport: rec, clock };
  const p = provider("midjourney", stub.baseUrl);

  const submit = await media.submitMidjourney(p, "midjourney-v6", { prompt: "赛博朋克城市", size: "1024x1024" }, 5000, options);
  assert.equal(submit.taskId, "mj-1");
  assert.equal(submit.status, "QUEUED");
  assert.equal(rec.transcript[0].request.url, stub.baseUrl + "/v1/midjourney/generations");
  assert.deepEqual(rec.transcript[0].request.body.value.size, "1:1");
  assert.equal(rec.transcript[0].request.body.value.prompt, "赛博朋克城市");
  assert.equal(rec.transcript[0].request.body.value.version, "6");

  const task = await media.getMidjourneyTask(p, "mj-1", 5000, options);
  assert.equal(task.status, "succeeded");
  assert.deepEqual(task.images, [
    { type: "url", value: "https://cdn.example/mj-a.png" },
    { type: "url", value: "https://cdn.example/mj-b.png" },
  ]);
  assert.equal(rec.transcript[1].request.url, stub.baseUrl + "/v1/midjourney/mj-1");

  const action = await media.submitMidjourneyAction(p, { task_id: "mj-1", action: "upscale", index: 2 }, 5000, options);
  assert.equal(action.taskId, "mj-2");
  assert.equal(action.action, "upscale");
  assert.equal(rec.transcript[2].request.url, stub.baseUrl + "/v1/midjourney/generations/upscale");
  assert.equal(rec.transcript[2].request.body.value.index, 2);
  assert.equal(rec.transcript[2].request.body.value.task_id, "mj-1");

  const modal = await media.submitMidjourneyModal(p, { task_id: "mj-1", prompt: "补一扇窗", mask_image: { url: "https://cdn.example/mask.png" } }, 5000, options);
  assert.equal(modal.taskId, "mj-3");
  assert.equal(rec.transcript[3].request.url, stub.baseUrl + "/v1/midjourney/generations/modal");
  assert.equal(rec.transcript[3].request.body.value.mask_url, "https://cdn.example/mask.png");

  const generated = await media.generateMidjourneyImages(p, "midjourney-v6", { prompt: "赛博朋克城市" }, 20000, [], options);
  assert.deepEqual(generated.images, [
    { type: "url", value: "https://cdn.example/mj-a.png" },
    { type: "url", value: "https://cdn.example/mj-b.png" },
  ]);
  assert.equal(rec.transcript[4].request.url, stub.baseUrl + "/v1/midjourney/generations");
  assert.equal(rec.transcript[5].request.url, stub.baseUrl + "/v1/midjourney/mj-1");
});

// ── 视频：OpenAI 兼容通用路径（submit → poll → result）──────────────

test("视频 OpenAI 兼容通用路径：/v1/videos/generations submit → poll → result", async (t) => {
  const stub = await startStub((req, _body, res) => {
    if (req.method === "POST" && req.url === "/v1/videos/generations") {
      return json(res, { id: "v-1" });
    }
    if (req.method === "GET" && req.url === "/v1/videos/generations/v-1") {
      return json(res, { status: "SUCCEEDED", video_url: "https://cdn.example/generic.mp4" });
    }
    return notFound(res);
  });
  t.after(() => stub.close());

  const rec = new RecordingTransport();
  const clock = createVirtualProtocolClock();
  const result = await media.generateVideos(provider("openai", stub.baseUrl), "veo-3", { prompt: "雪山", duration: 5 }, undefined, 5000, rec, clock);

  assert.deepEqual(result.videos, [{ type: "url", value: "https://cdn.example/generic.mp4" }]);
  assert.equal(rec.transcript[0].request.url, stub.baseUrl + "/v1/videos/generations");
  assert.equal(rec.transcript[0].request.body.value.model, "veo-3");
  assert.equal(rec.transcript[0].request.body.value.prompt, "雪山");
  assert.equal(rec.transcript[1].request.url, stub.baseUrl + "/v1/videos/generations/v-1");
});

// ── 未移植依赖必须返回结构化错误 ─────────────────────────────────────

test("未移植依赖：midjourney 之外的媒体/图像分支返回 LEGACY_DEPENDENCY_UNAVAILABLE", async () => {
  const p = { id: "stub", protocol: "runninghub", base_url: "https://example.invalid", api_key: "k" };
  const videos = await media.generateVideos(p, "m", { prompt: "x" }, undefined, 1000);
  assert.equal(videos.ok, false);
  assert.equal(videos.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(videos.detail, /runninghub/);

  const edit = await media.editImages({ ...p, protocol: "modelscope" }, "m", { prompt: "x" }, [{ buf: Buffer.from("x"), mime: "image/png", name: "x.png" }], 1000);
  assert.equal(edit.ok, false);
  assert.equal(edit.error, "LEGACY_DEPENDENCY_UNAVAILABLE");
  assert.match(edit.detail, /modelscope/);

  const cli = await media.editImages({ ...p, protocol: "cli:codex" }, "m", { prompt: "x" }, [{ buf: Buffer.from("x"), mime: "image/png", name: "x.png" }], 1000);
  assert.equal(cli.ok, false);
  assert.match(cli.detail, /agentCliTools/);
});

// ── 聚合出口惰性装配 ─────────────────────────────────────────────────

test("聚合出口：命名空间与展平函数可用", () => {
  assert.equal(typeof aggregate.chat, "object");
  assert.equal(typeof aggregate.images, "object");
  assert.equal(typeof aggregate.media, "object");
  assert.equal(typeof aggregate.media.generateVideos, "function");
  assert.equal(typeof aggregate.generateVideos, "function");
  assert.equal(typeof aggregate.generateImages, "function");
  assert.equal(typeof aggregate.callChat, "function");
  assert.equal(typeof aggregate.editImages, "function");
  assert.equal(aggregate.generateVideos, aggregate.media.generateVideos);
});
