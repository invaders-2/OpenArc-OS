/**
 * P2 · **本地 stub 端到端探针**（真 HTTP / 真 SSE / 真落盘）。
 *
 * 【标题口径】本地 stub（真 HTTP/真 SSE/真落盘），**不等于外部供应商真实调用**：
 *   · stub 是 node:http 起在 127.0.0.1 随机端口上的本地服务（无外网、无域名、无 TLS）；
 *   · SSE 分片、b64_json、usage 都由本脚本自己构造；
 *   · 真实外部调用请看 experiments/dxos-p2/real-call.mjs（缺密钥时明确 SKIP）。
 *
 * 覆盖链路（全部走 electron/provider-protocol-service.cjs 的生产实现，无 mock 分支）：
 *   1. createProviderProtocolBundle 注册 provider（127.0.0.1 为 LOCALHOST，allowLan 仅显式打开）
 *   2. service.call({ stream: true }) → 真 SSE → 收集原始 onEvent 与下行 P1 信封
 *   3. service.generateImage(...) → 真 HTTP → 产物真落盘 <userData>/dxos/media/
 *   4. service.executeProtocol({ protocolId: "openai-images", intent: "image.generate" }) → 标准化输出
 *
 * 断言全绿 exit 0；任一失败打印失败点并 exit 1。
 */
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createProviderProtocolBundle } = require("../../electron/provider-protocol-service.cjs");
const { memoryCredentialBackend } = require("../../electron/credential-store.cjs");

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x51, 0x57, 0x35, 0x21]);

// ---------------------------------------------------------------------------
// 本地 stub：真 HTTP + 真 SSE（127.0.0.1 随机端口）
// ---------------------------------------------------------------------------
function startStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { __unparsed: raw.slice(0, 200) }; }
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null, body });

      if (req.url === "/v1/chat/completions") {
        res.setHeader("content-type", "text/event-stream");
        res.write('data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":", "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"stub"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"SF\\"}"}}]}}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (req.url === "/v1/images/generations") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64"), mime_type: "image/png" }] }));
        return;
      }
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "stub: unknown path " + req.url } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      port: server.address().port,
      baseUrl: "http://127.0.0.1:" + server.address().port,
      seen,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

// ---------------------------------------------------------------------------
// 断言收集器：全部跑完再决定 exit code，失败点逐条打印
// ---------------------------------------------------------------------------
const failures = [];
let checks = 0;
function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log("  PASS  " + name);
  } catch (error) {
    failures.push({ name, message: String((error && error.message) || error) });
    console.log("  FAIL  " + name + " -> " + String((error && error.message) || error));
  }
}
function eq(actual, expected, label = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(label + " expected " + b + " but got " + a);
}

console.log("[dxos-p2-stub] 本地 stub（真 HTTP/真 SSE/真落盘），不等于外部供应商真实调用");

const stub = await startStub();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-p2-stub-"));
const envelopes = [];
const rawEvents = [];
const bundle = createProviderProtocolBundle({
  userDataDir,
  backend: memoryCredentialBackend(),
  emit: (event) => envelopes.push(event),
});
const provider = bundle.store.create({
  name: "Local Stub",
  baseUrl: stub.baseUrl,
  protocol: "openai",
  models: [
    { model: "stub-chat", caps: ["llm"] },
    { model: "gpt-image-1", caps: ["image"] },
  ],
});
bundle.store.setKeys(provider.id, { apiKey: "STUB-LOCAL-KEY" });

console.log("[dxos-p2-stub] stub baseUrl = " + stub.baseUrl + "  userDataDir = " + userDataDir);

try {
  // ---- 2. 流式 chat ----
  console.log("[dxos-p2-stub] step 2: service.call({ stream: true })");
  const chat = await bundle.service.call({
    providerId: provider.id,
    model: "stub-chat",
    messages: [{ role: "user", content: "ping" }],
    params: { max_tokens: 32 },
    stream: true,
    allowLan: true,
    onEvent: (event) => rawEvents.push(event),
  });

  check("call.ok === true", () => eq(chat.ok, true, "ok:"));
  check("文本按 SSE 分片顺序拼接 = 'Hello, stub'", () => eq(chat.text, "Hello, stub", "text:"));
  check("usage 真解析 = {inputTokens:11,outputTokens:7,totalTokens:18}", () => eq(chat.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 }, "usage:"));
  check("tool_calls delta 真拼装", () => {
    eq(chat.toolCalls.length, 1, "toolCalls.length:");
    eq(chat.toolCalls[0].function.name, "get_weather", "name:");
    eq(chat.toolCalls[0].function.arguments, '{"city":"SF"}', "arguments:");
  });

  const req = stub.seen.find((item) => item.url === "/v1/chat/completions");
  check("真 HTTP 请求到 /v1/chat/completions，带 Bearer key、stream=true", () => {
    if (!req) throw new Error("没有观察到 /v1/chat/completions 请求");
    eq(req.method, "POST", "method:");
    eq(req.authorization, "Bearer STUB-LOCAL-KEY", "authorization:");
    eq(req.body.stream, true, "body.stream:");
    eq(req.body.model, "stub-chat", "body.model:");
  });

  check("原始 onEvent 顺序: response.start → 3×text.delta → 2×tool_call.delta → usage → response.complete", () => {
    const types = rawEvents.map((event) => event.type);
    eq(types, ["response.start", "text.delta", "text.delta", "text.delta", "tool_call.delta", "tool_call.delta", "usage", "response.complete"], "raw types:");
    eq(rawEvents.filter((event) => event.type === "text.delta").map((event) => event.text), ["Hello", ", ", "stub"], "deltas:");
  });

  check("下行事件信封字段齐全且 channel/domain 正确", () => {
    if (envelopes.length !== 8) throw new Error("期望 8 个信封，实际 " + envelopes.length);
    for (const event of envelopes) {
      for (const key of ["channel", "domain", "kind", "sequence", "at", "payload"]) {
        if (!(key in event)) throw new Error("信封缺字段 " + key + " -> " + JSON.stringify(event));
      }
      eq(event.channel, "model:event", "channel:");
      eq(event.domain, "model", "domain:");
      if (!["progress", "log", "approval"].includes(event.kind)) throw new Error("非法 kind: " + event.kind);
      if (typeof event.sequence !== "number") throw new Error("sequence 非数字");
      if (typeof event.at !== "number") throw new Error("at 非数字");
    }
  });
  check("下行 sequence 从 1 起严格单调 +1", () => eq(envelopes.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8], "sequences:"));
  check("下行 kind 全为 progress", () => eq([...new Set(envelopes.map((event) => event.kind))], ["progress"], "kinds:"));
  check("下行 payload.type 顺序与原始事件一致", () => {
    eq(envelopes.map((event) => event.payload.type), ["response.start", "text.delta", "text.delta", "text.delta", "tool_call.delta", "tool_call.delta", "usage", "response.complete"], "payload types:");
    eq(envelopes.filter((event) => event.payload.type === "text.delta").map((event) => event.payload.text), ["Hello", ", ", "stub"], "payload deltas:");
    eq(envelopes.find((event) => event.payload.type === "usage").payload.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 }, "payload usage:");
  });

  // ---- 3. 图像落盘 ----
  console.log("[dxos-p2-stub] step 3: service.generateImage(...) -> 落盘");
  const image = await bundle.service.generateImage({
    providerId: provider.id,
    model: "gpt-image-1",
    prompt: "a stub cat",
    size: "512x512",
    count: 1,
    allowLan: true,
  });
  check("generateImage.ok === true", () => eq(image.ok, true, "ok:"));
  check("落盘文件存在且字节与 stub b64 一致", () => {
    const saved = image.images[0];
    if (!saved || !saved.mediaPath) throw new Error("没有 mediaPath: " + JSON.stringify(image));
    if (!saved.mediaPath.startsWith(path.join(userDataDir, "dxos", "media"))) throw new Error("落盘路径不在 dxos/media: " + saved.mediaPath);
    if (!fs.existsSync(saved.mediaPath)) throw new Error("文件不存在: " + saved.mediaPath);
    if (!fs.readFileSync(saved.mediaPath).equals(PNG_BYTES)) throw new Error("文件字节与 stub 不一致");
  });
  check("图像请求体正确 /v1/images/generations", () => {
    const req2 = stub.seen.find((item) => item.url === "/v1/images/generations");
    if (!req2) throw new Error("没有观察到图像请求");
    eq(req2.body, { model: "gpt-image-1", prompt: "a stub cat", n: 1, size: "512x512" }, "body:");
  });

  // ---- 4. 声明式协议引擎 ----
  console.log("[dxos-p2-stub] step 4: service.executeProtocol(openai-images / image.generate)");
  const executed = await bundle.service.executeProtocol({
    providerId: provider.id,
    protocolId: "openai-images",
    model: "gpt-image-1",
    intent: "image.generate",
    prompt: "a stub cat",
    params: { size: "1024x1024", n: 1 },
    allowLan: true,
  });
  check("executeProtocol.ok === true", () => eq(executed.ok, true, "ok: " + JSON.stringify(executed.error || null)));
  check("标准化输出为 image，且字节与 stub 一致", () => {
    eq(executed.outputs.length, 1, "outputs.length:");
    eq(executed.outputs[0].kind, "image", "kind:");
    if (!Buffer.from(executed.outputs[0].data).equals(PNG_BYTES)) throw new Error("输出字节与 stub 不一致");
  });
} catch (error) {
  failures.push({ name: "uncaught", message: String((error && error.stack) || error) });
  console.log("  FAIL  uncaught -> " + String((error && error.stack) || error));
} finally {
  await stub.close();
}

console.log("[dxos-p2-stub] checks=" + checks + " failures=" + failures.length);
if (failures.length) {
  for (const item of failures) console.log("[dxos-p2-stub] FAILED: " + item.name + " | " + item.message);
  console.log("[dxos-p2-stub] 结果：失败，exit 1");
  process.exit(1);
}
console.log("[dxos-p2-stub] 结果：全部通过，exit 0");
process.exit(0);
