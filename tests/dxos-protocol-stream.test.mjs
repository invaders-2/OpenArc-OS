/**
 * W5 · B2 遗留① · 流式调用下行事件（model:event）契约测试。
 *
 * 不启动 Electron：
 *   · ipcMain 用假的 handler Map；
 *   · webContents 退化为一个记录 send 的回调（等价于 main.cjs 的 win.webContents.send）；
 *   · 真实经过 registerModelIpc → provider-protocol-service.call → 本地 node:http SSE stub。
 *
 * 断言：事件信封字段齐全（channel/domain/kind/sequence/at/payload）、sequence 单调、
 * 流式 delta 顺序正确、trusted 校验拒绝伪造 sender。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerModelIpc, disposeModelIpc, MODEL_COMMANDS, MODEL_COMMAND_NOT_ALLOWED } = require("../electron/model-bootstrap.cjs");
const { createProviderProtocolBundle } = require("../electron/provider-protocol-service.cjs");
const { memoryCredentialBackend } = require("../electron/credential-store.cjs");

const DELTAS = ["Hel", "lo", " ", "W5"];

function startStub() {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/v1/chat/completions") {
      res.setHeader("content-type", "text/event-stream");
      for (const delta of DELTAS) res.write('data: {"choices":[{"delta":{"content":' + JSON.stringify(delta) + '}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      baseUrl: "http://127.0.0.1:" + server.address().port,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

const stub = await startStub();
after(() => stub.close());

function makeIpc() {
  const handlers = new Map();
  return { handlers, handle: (channel, fn) => { if (handlers.has(channel)) throw new Error("duplicate handler " + channel); handlers.set(channel, fn); }, removeHandler: (channel) => handlers.delete(channel) };
}

/** 一个 bundle + 一个假 ipcMain + 一个假 webContents(downstream)。 */
function makeRig({ trusted = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dxos-stream-"));
  const bundle = createProviderProtocolBundle({ userDataDir: dir, backend: memoryCredentialBackend() });
  const provider = bundle.store.create({ name: "StreamStub", baseUrl: stub.baseUrl, protocol: "openai", models: [{ model: "stream-model", caps: ["llm"] }] });
  bundle.store.setKeys(provider.id, { apiKey: "FAKE_W5_STREAM_KEY" });
  const ipc = makeIpc();
  const downstream = [];
  registerModelIpc({
    ipcMain: ipc,
    service: { providerProtocol: bundle },
    identity: { current: "session-w5" },
    isTrusted: (e) => e && e.trusted === true,
    send: (event) => downstream.push(event),
  });
  return {
    bundle, provider, ipc, downstream, dir,
    invoke: (raw) => ipc.handlers.get("model:command")({ trusted }, raw),
  };
}

const STREAM_COMMAND = (providerId) => ({
  command: "provider/callStream",
  payload: { providerId, model: "stream-model", messages: [{ role: "user", content: "hi" }], allowLan: true },
});

test("W5-1 · 命令表新增 provider/callStream，既有流式出口 provider/call 仍在", () => {
  assert.ok(MODEL_COMMANDS.includes("provider/call"), "provider/call 必须保留");
  assert.ok(MODEL_COMMANDS.includes("provider/callStream"), "provider/callStream 必须登记");
  assert.equal(MODEL_COMMANDS.includes("credential/getRaw"), false);
});

test("W5-2 · provider/callStream 真实 SSE → model:event：信封齐全、sequence 单调、delta 顺序正确", async () => {
  const rig = makeRig();
  const result = await rig.invoke(STREAM_COMMAND(rig.provider.id));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, DELTAS.join(""), "文本必须按分片顺序拼接");
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });

  // 8 个信封：1 start + 4 delta + 1 usage + 1 complete? 实际为 1+4+1+1 = 7
  const events = rig.downstream;
  assert.equal(events.length, DELTAS.length + 3, "信封数量 = start + " + DELTAS.length + " delta + usage + complete");
  for (const event of events) {
    assert.equal(typeof event.channel, "string");
    assert.equal(typeof event.domain, "string");
    assert.equal(typeof event.kind, "string");
    assert.equal(typeof event.sequence, "number");
    assert.equal(typeof event.at, "number");
    assert.equal(typeof event.payload, "object");
    assert.equal(event.channel, "model:event");
    assert.equal(event.domain, "model");
    assert.ok(["progress", "log", "approval"].includes(event.kind), "非法 kind " + event.kind);
  }
  // sequence 从 1 起严格 +1（该 bundle 的事件通道只服务本次调用）
  assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i + 1));
  const increasing = events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence);
  assert.equal(increasing, true, "sequence 必须严格单调递增");
  // 流式 delta 顺序
  assert.deepEqual(
    events.filter((e) => e.payload.type === "text.delta").map((e) => e.payload.text),
    DELTAS,
  );
  assert.deepEqual(events.map((e) => e.payload.type), [
    "response.start",
    ...DELTAS.map(() => "text.delta"),
    "usage",
    "response.complete",
  ]);
  assert.equal(events.find((e) => e.payload.type === "usage").payload.usage.totalTokens, 5);
});

test("W5-3 · trusted 校验拒绝伪造 sender（连 handler 都不进入）", async () => {
  const rig = makeRig({ trusted: false });
  await assert.rejects(() => rig.invoke(STREAM_COMMAND(rig.provider.id)), /Forbidden/);
  assert.equal(rig.downstream.length, 0, "被拒的 sender 不得收到任何 model:event");
});

test("W5-4 · 未知命令仍 DENY，且不产生下行事件", async () => {
  const rig = makeRig();
  const denied = await rig.invoke({ command: "provider/rawFetch", payload: {} });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, MODEL_COMMAND_NOT_ALLOWED);
  assert.equal(rig.downstream.length, 0);
});

test("W5-5 · disposeModelIpc 后 handler 被移除，可重复注册", () => {
  const rig = makeRig();
  disposeModelIpc({ ipcMain: rig.ipc });
  assert.equal(rig.ipc.handlers.has("model:command"), false);
  registerModelIpc({ ipcMain: rig.ipc, service: { providerProtocol: rig.bundle }, identity: { current: "s" }, isTrusted: () => true });
  registerModelIpc({ ipcMain: rig.ipc, service: { providerProtocol: rig.bundle }, identity: { current: "s" }, isTrusted: () => true });
  assert.equal(typeof rig.ipc.handlers.get("model:command"), "function");
});
