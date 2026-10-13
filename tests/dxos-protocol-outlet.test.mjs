/**
 * W6b · 统一调用出口接线契约测试（不启动 Electron、无外网、无真实密钥）。
 *
 * 真实链路：假 ipcMain（handler Map）→ registerModelIpc 的 model:command →
 * provider-protocol-service.legacyExecute → protocol-engine/legacy-executor.cjs
 * （chat / images / media）→ 本地 node:http stub（127.0.0.1 随机端口）。
 *
 * 覆盖：
 *   1. legacy/chat（openai 兼容）返回文本与 usage，且不回传 api_key；
 *   2. legacy/chatStream 复用 W5 的 model:event 信封（sequence 单调、delta 有序）；
 *   3. legacy/images 落盘 <userData>/dxos/media，返回值不含 api_key / 绝对路径；
 *   4. legacy/videos 的 submit → poll → result；
 *   5. 未在白名单的命令被拒（MODEL_COMMAND_NOT_ALLOWED），不产生网络副作用；
 *   6. trusted(sender) 校验拒绝伪造 sender，且不产生网络副作用。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerModelIpc, MODEL_COMMANDS, MODEL_COMMAND_NOT_ALLOWED } = require("../electron/model-bootstrap.cjs");
const { createProviderProtocolBundle } = require("../electron/provider-protocol-service.cjs");
const domain = require("../electron/provider-protocol-domain.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]);
const API_KEY = "FAKE_W6B_OUTLET_KEY";

const LEGACY_COMMANDS = [
  "legacy/chat", "legacy/chatStream", "legacy/chatTools", "legacy/images", "legacy/editImages",
  "legacy/videos", "legacy/audio", "legacy/catalog", "legacy/describeImage", "legacy/midjourney",
];

function startStub() {
  const requests = [];
  const edits = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const baseUrl = "http://127.0.0.1:" + server.address().port;
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "你好" } }] }) + "\n\n");
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "世界" } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/images/edits") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        edits.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", name: "Test Model" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/videos/generations") {
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ task_id: "vid-1" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/videos/generations/vid-1") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "SUCCEEDED", video_url: baseUrl + "/media/video.mp4" }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    requests,
    edits,
    baseUrl: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((done) => server.close(done)),
  })));
}

const stub = await startStub();
after(() => stub.close());

function makeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, fn) => { if (handlers.has(channel)) throw new Error("duplicate handler " + channel); handlers.set(channel, fn); },
    removeHandler: (channel) => handlers.delete(channel),
  };
}

function makeRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-outlet-"));
  const bundle = createProviderProtocolBundle({ userDataDir: dir, backend: memoryCredentialBackend() });
  const provider = bundle.store.create({
    name: "OutletStub", baseUrl: stub.baseUrl, protocol: "openai",
    models: [{ model: "test-model", caps: ["llm", "image", "video"] }],
  });
  bundle.store.setKeys(provider.id, { apiKey: API_KEY });
  const ipc = makeIpc();
  const downstream = [];
  registerModelIpc({
    ipcMain: ipc,
    service: { providerProtocol: bundle },
    identity: { current: "session-w6b" },
    isTrusted: (e) => !!(e && e.trusted === true),
    send: (event) => downstream.push(event),
  });
  const handler = ipc.handlers.get("model:command");
  return {
    dir, bundle, provider, ipc, downstream,
    invoke: (raw) => handler({ trusted: true }, raw),
    invokeUntrusted: (raw) => handler({ trusted: false }, raw),
  };
}

test("W6b-1 · 命令表：10 条 legacy 出口已登记，risk/credential/summary 齐全", () => {
  for (const command of LEGACY_COMMANDS) {
    assert.ok(MODEL_COMMANDS.includes(command), "MODEL_COMMANDS 缺 " + command);
    const entry = domain.PROTOCOL_COMMANDS[command];
    assert.ok(entry, "PROTOCOL_COMMANDS 缺 " + command);
    assert.ok(["read", "use"].includes(entry.risk), command + " risk=" + entry.risk);
    assert.equal(typeof entry.credential, "boolean", command + " credential");
    assert.equal(typeof entry.summary, "string", command + " summary");
    assert.ok(entry.summary.length > 0, command + " summary 非空");
  }
  assert.equal(domain.commandRisk("legacy/catalog"), "read");
  assert.equal(domain.commandRequiresCredential("legacy/chat"), true);
  assert.equal(domain.commandRequiresCredential("legacy/images"), true);
});

test("W6b-2 · legacy/chat（openai 兼容）经 model:command 返回文本与 usage，不回传密钥", async () => {
  const rig = makeRig();
  const result = await rig.invoke({
    command: "legacy/chat",
    payload: { providerId: rig.provider.id, model: "test-model", messages: [{ role: "user", content: "hi" }], allowLan: true },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, "你好世界");
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.equal(JSON.stringify(result).includes(API_KEY), false, "返回值不得含 api_key");
  assert.equal(result.snapshot.providerId, rig.provider.id);
});

test("W6b-3 · legacy/chatStream 复用 W5 的 model:event 信封（sequence 单调、delta 有序）", async () => {
  const rig = makeRig();
  const result = await rig.invoke({
    command: "legacy/chatStream",
    payload: { providerId: rig.provider.id, model: "test-model", messages: [{ role: "user", content: "hi" }], allowLan: true },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, "你好世界");
  const events = rig.downstream;
  assert.ok(events.length >= 5, "应至少收到 start + 2 delta + usage + complete");
  for (const event of events) {
    assert.equal(event.channel, "model:event");
    assert.equal(event.domain, "model");
    assert.ok(["progress", "log", "approval"].includes(event.kind));
    assert.equal(typeof event.sequence, "number");
    assert.equal(typeof event.at, "number");
  }
  assert.deepEqual(events.map((e) => e.sequence), events.map((_, index) => index + 1));
  assert.deepEqual(events.filter((e) => e.payload.type === "text.delta").map((e) => e.payload.text), ["你好", "世界"]);
  assert.deepEqual(events.map((e) => e.payload.type), ["response.start", "text.delta", "text.delta", "usage", "response.complete"]);
});

test("W6b-4 · legacy/images 落盘 dxos/media，返回值不含 api_key / 绝对路径", async () => {
  const rig = makeRig();
  const result = await rig.invoke({
    command: "legacy/images",
    payload: { providerId: rig.provider.id, model: "gpt-image-1", prompt: "a cat", params: { size: "512x512", n: 1 }, allowLan: true },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.images.length, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(API_KEY), false, "返回值不得含 api_key");
  assert.equal(serialized.includes(rig.dir), false, "返回值不得含绝对路径");
  const mediaDir = path.join(rig.dir, "dxos", "media");
  const files = fs.readdirSync(mediaDir);
  assert.equal(files.length, 1);
  assert.equal(result.images[0].fileName, files[0]);
  assert.equal(result.images[0].mime, "image/png");
  assert.deepEqual(fs.readFileSync(path.join(mediaDir, files[0])), PNG_BYTES);
});

test("W6b-5 · legacy/videos 的 submit → poll → result", async () => {
  const rig = makeRig();
  const before = stub.requests.length;
  const result = await rig.invoke({
    command: "legacy/videos",
    payload: { providerId: rig.provider.id, model: "veo-3", prompt: "雪山", allowLan: true },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.videos.length, 1);
  assert.match(result.videos[0].url, /\/media\/video\.mp4$/);
  const seen = stub.requests.slice(before);
  assert.deepEqual(seen.map((r) => r.method + " " + r.url), [
    "POST /v1/videos/generations",
    "GET /v1/videos/generations/vid-1",
  ]);
});

test("W6b-6 · 未在白名单的命令被拒 MODEL_COMMAND_NOT_ALLOWED，且不产生副作用", async () => {
  const rig = makeRig();
  const before = stub.requests.length;
  const denied = await rig.invoke({ command: "legacy/rawFetch", payload: { providerId: rig.provider.id, allowLan: true } });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, MODEL_COMMAND_NOT_ALLOWED);
  assert.equal(stub.requests.length, before, "被拒命令不得产生网络副作用");
});

test("W6b-7 · legacy/catalog（read）经 model:command 返回模型目录，不回传密钥", async () => {
  const rig = makeRig();
  const result = await rig.invoke({ command: "legacy/catalog", payload: { providerId: rig.provider.id, allowLan: true } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.models, [{ model: "test-model", name: "Test Model" }]);
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});

test("W6b-8 · trusted(sender) 校验拒绝伪造 sender，且不产生副作用", async () => {
  const rig = makeRig();
  const before = stub.requests.length;
  await assert.rejects(
    () => rig.invokeUntrusted({ command: "legacy/chat", payload: { providerId: rig.provider.id, allowLan: true } }),
    /Forbidden/,
  );
  assert.equal(stub.requests.length, before);
  assert.equal(rig.downstream.length, 0);
});

// ── W6c · 渲染层二进制参考素材解码 ───────────────────────────────────

test("W6c-1 · legacy/editImages 用 base64/dataUrl 参考图：主进程解码 → multipart 正确，返回值无密钥与绝对路径", async () => {
  const rig = makeRig();
  const refA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);
  const refB = Buffer.from("REF-B-BYTES");
  const before = stub.edits.length;
  const result = await rig.invoke({
    command: "legacy/editImages",
    payload: {
      providerId: rig.provider.id,
      model: "gpt-image-1",
      prompt: "把背景换成雪山",
      params: { size: "512x512" },
      inputs: [
        { base64: refA.toString("base64"), mime: "image/png", name: "ref-a.png" },
        { dataUrl: "data:image/jpeg;base64," + refB.toString("base64"), name: "ref-b.jpg" },
      ],
      allowLan: true,
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.images.length, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(API_KEY), false, "返回值不得含 api_key");
  assert.equal(serialized.includes(rig.dir), false, "返回值不得含绝对路径");

  const uploads = stub.edits.slice(before);
  assert.equal(uploads.length, 1, "应恰好发生一次 multipart 上传");
  assert.match(String(uploads[0].headers["content-type"]), /multipart\/form-data/);
  const body = uploads[0].body;
  assert.ok(body.includes(refA), "multipart 必须携带第一张参考图解码后的原始字节");
  assert.ok(body.includes(refB), "multipart 必须携带第二张参考图解码后的原始字节");
  assert.equal((body.toString("latin1").match(/name="image\[\]"/g) || []).length, 2, "多图字段名应为 image[]");
  assert.ok(body.includes(Buffer.from('filename="ref-a.png"')), "第一张文件名应透传");
  assert.ok(body.includes(Buffer.from('filename="ref-b.jpg"')), "第二张文件名应透传（mime 来自 dataUrl）");
});

test("W6c-2 · legacy/editImages 非法 base64 返回结构化 INVALID_INPUT，且不产生网络副作用", async () => {
  const rig = makeRig();
  const before = stub.edits.length;
  const result = await rig.invoke({
    command: "legacy/editImages",
    payload: {
      providerId: rig.provider.id,
      model: "gpt-image-1",
      prompt: "x",
      inputs: [{ base64: "这不是 base64!!!", mime: "image/png", name: "bad.png" }],
      allowLan: true,
    },
  });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error, "INVALID_INPUT");
  assert.equal(typeof result.detail, "string");
  assert.equal(stub.edits.length, before, "非法输入不得发起上传");
  assert.equal(JSON.stringify(result).includes(API_KEY), false);
});
