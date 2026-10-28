"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvasAudioGenerationPort } = require("../canvas-dxos-commands.cjs");

function mockService({ resolveOk = true, result = { ok: true, audios: [{ url: "openarc-asset://a1" }] } } = {}) {
  const calls = { legacy: [], started: [], finished: [] };
  const service = {
    modelService: {
      providerProtocol: {
        service: {
          async legacyExecute(input) { calls.legacy.push(input); return result; },
        },
      },
      resolveModel(input) {
        calls.resolve = input;
        return resolveOk
          ? { ok: true, snapshot: { providerId: "p1", modelId: "m1" } }
          : { ok: false, error: "CAPABILITY_UNAVAILABLE" };
      },
    },
    startRun(input) { calls.started.push(input); return { ok: true, runId: "run-audio-1" }; },
    finishRun(input) { calls.finished.push(input); return { ok: true }; },
  };
  return { service, calls };
}

test("audio port 走 legacy action=audio 并返回 outputs.audios", async () => {
  const { service, calls } = mockService();
  const port = createCanvasAudioGenerationPort(service);
  const out = await port({ type: "builtin.audio-generator", params: { prompt: "海浪", configId: "c1" }, context: {}, canvasId: "cv1", nodeId: "n1" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.outputs.audios, [{ url: "openarc-asset://a1" }]);
  assert.equal(calls.resolve.capability, "audio-generation");
  assert.equal(calls.started[0].kind, "audio");
  assert.equal(calls.legacy[0].action, "audio");
  assert.equal(calls.legacy[0].prompt, "海浪");
  assert.equal(calls.legacy[0].requestId, "canvas_audio_run-audio-1");
  assert.equal(calls.finished[0].status, "DONE");
});

test("audio port capability 不可用返回结构化错误", async () => {
  const { service, calls } = mockService({ resolveOk: false });
  const port = createCanvasAudioGenerationPort(service);
  const out = await port({ type: "builtin.audio-generator", params: {}, context: {}, canvasId: "cv1", nodeId: null });
  assert.equal(out.ok, false);
  assert.equal(out.error, "CAPABILITY_UNAVAILABLE");
  assert.equal(calls.legacy.length, 0);
});

test("audio port provider 不可用返回 CANVAS_NODE_EXECUTOR_UNAVAILABLE", async () => {
  const port = createCanvasAudioGenerationPort({ modelService: {}, startRun() {}, finishRun() {} });
  const out = await port({ type: "builtin.audio-generator", params: {}, context: {}, canvasId: "cv1", nodeId: null });
  assert.equal(out.ok, false);
  assert.equal(out.error, "CANVAS_NODE_EXECUTOR_UNAVAILABLE");
  assert.equal(out.detail.reason, "audio-provider-unavailable");
});
