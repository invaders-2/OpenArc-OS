/** task-55 · DSH 运行时闭包、harness 明确错误码、画布视频生成。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { copyDshRuntimeClosure, collectDshRuntimeClosure, DSH_RUNTIME_PINS } from "../scripts/dsh-runtime-closure.mjs";

const require = createRequire(import.meta.url);
const { resolveDshRuntime } = require("../electron/harness-adapter.cjs");
const { classifyHarnessError } = require("../electron/task-harness-orchestrator.cjs");
const { createCanvasVideoGenerationPort } = require("../electron/canvas-dxos-commands.cjs");
const { createCanvasNodeRegistry } = require("../electron/canvas-node-registry.cjs");
const { ERROR: TASK_ERROR } = require("../electron/task-domain.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("DSH 运行时闭包：PIN 版本、完整依赖、.bin/dsh 复制到目标 node_modules", () => {
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-closure-test-")), "node_modules");
  try {
    const collected = collectDshRuntimeClosure({ root: ROOT });
    for (const [name, pin] of Object.entries(DSH_RUNTIME_PINS)) {
      const entry = [...collected.packages.values()].find((pkg) => pkg.name === name);
      assert.ok(entry, "缺少 " + name);
      assert.equal(entry.version, pin);
    }
    const result = copyDshRuntimeClosure({ root: ROOT, destNodeModules: dest });
    assert.ok(result.packages > 20, "依赖闭包过小：" + result.packages);
    assert.ok(fs.existsSync(path.join(dest, "@deepseek-ai", "dsh", "package.json")));
    assert.ok(fs.existsSync(path.join(dest, "@agentclientprotocol", "sdk", "package.json")));
    const bin = path.join(dest, ".bin", "dsh");
    assert.ok(fs.existsSync(bin));
    assert.equal(fs.realpathSync(bin), fs.realpathSync(path.join(dest, "@deepseek-ai", "dsh", "lib", "bin.js")));
  } finally {
    fs.rmSync(path.dirname(dest), { recursive: true, force: true });
  }
});

test("DSH 缺运行时 / 版本漂移返回明确错误码，不退化 INTERNAL_ERROR", () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-missing-test-"));
  const oldRuntime = process.env.OPENARC_DSH_RUNTIME;
  try {
    process.env.OPENARC_DSH_RUNTIME = missing;
    assert.throws(() => resolveDshRuntime(), (error) => error.code === "DSH_RUNTIME_MISSING");
    assert.equal(classifyHarnessError({ code: "DSH_RUNTIME_MISSING" }), "DSH_RUNTIME_MISSING");
    assert.equal(classifyHarnessError({ code: "DSH_VERSION_MISMATCH" }), "DSH_VERSION_MISMATCH");
    assert.equal(classifyHarnessError({ code: "SOMETHING_ELSE" }), TASK_ERROR.INTERNAL_ERROR);
  } finally {
    if (oldRuntime === undefined) delete process.env.OPENARC_DSH_RUNTIME; else process.env.OPENARC_DSH_RUNTIME = oldRuntime;
    fs.rmSync(missing, { recursive: true, force: true });
  }
});

test("画布视频节点：接入 model 协议引擎，提交/产物回填，缺失能力结构化", async () => {
  const calls = [];
  const canvasService = {
    modelService: {
      resolveModel: ({ capability, configId }) => ({ ok: true, snapshot: { providerId: "prv_1", modelId: "video-1", capability, configId } }),
      providerProtocol: { service: { legacyExecute: async (input) => { calls.push(input); return { ok: true, videos: [{ url: "openarc-asset:v1", mimeType: "video/mp4" }] }; } } },
    },
    startRun: (input) => { calls.push({ startRun: input }); return { ok: true, runId: "run_1" }; },
    finishRun: (input) => { calls.push({ finishRun: input }); return { ok: true }; },
    getCanvas: async () => ({ ok: true, canvas: { doc: { nodes: [{ id: "n1", type: "builtin.video-generator", params: { prompt: "旧" } }] } } }),
    applyCommand: async (input) => { calls.push({ applyCommand: input }); return { ok: true, canvas: { revision: 2 } }; },
  };
  const port = createCanvasVideoGenerationPort(canvasService);
  assert.equal(port.supports("builtin.video-generator"), true);
  assert.equal(port.supports("builtin.image-generator"), false);
  const result = await port({ type: "builtin.video-generator", params: { prompt: "海浪", size: "1280x720" }, context: { sessionRef: "s" }, canvasId: "c1", nodeId: "n1" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.outputs.videos.length, 1);
  const legacy = calls.find((call) => call.action === "videos");
  assert.equal(legacy.providerId, "prv_1");
  assert.equal(legacy.model, "video-1");
  assert.equal(legacy.prompt, "海浪");
  assert.deepEqual(calls.find((call) => call.startRun).startRun.kind, "video");
  assert.equal(calls.find((call) => call.finishRun).finishRun.status, "DONE");

  const registry = createCanvasNodeRegistry({ ports: { videoGeneration: port }, canvasService });
  assert.equal(registry.describe("builtin.video-generator").executable, true);
  const executed = await registry.execute({ type: "builtin.video-generator", params: { prompt: "山" }, context: { sessionRef: "s" }, canvasId: "c1", nodeId: "n1" });
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.equal(executed.outputs.videos[0].url, "openarc-asset:v1");
  const backfilled = await registry.execute({ type: "builtin.video-generator", params: { prompt: "山" }, context: { sessionRef: "s" }, canvasId: "c1", nodeId: "n1", writeBack: true });
  assert.equal(backfilled.ok, true, JSON.stringify(backfilled));
  assert.equal(backfilled.writeBack.ok, true);
  const edit = calls.find((call) => call.applyCommand).applyCommand.command;
  assert.equal(edit.type, "node.edit");
  assert.equal(edit.patch.runStatus, "DONE");
  assert.equal(edit.patch.params.lastRunResult.videos[0].url, "openarc-asset:v1");

  const unavailable = createCanvasVideoGenerationPort({ modelService: { resolveModel: () => ({ ok: true, snapshot: {} }) } });
  const rejected = await unavailable({ type: "builtin.video-generator", params: {}, context: {}, canvasId: "c1" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "CANVAS_NODE_EXECUTOR_UNAVAILABLE");
});
