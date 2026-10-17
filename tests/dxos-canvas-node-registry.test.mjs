/**
 * A03 · 17 个 builtin.* 节点运行期注册与执行（electron/canvas-node-registry.cjs）。
 *
 * 覆盖：
 *   · 17 个定义全部注册、executor / 端口 / 参数 schema 完整、摘要稳定；
 *   · 参数 schema 拒绝缺参 / 类型不符 / 超范围，合法输入通过；
 *   · 端口类型兼容与连接校验（未知端口 / 不兼容 / artifact 通配）；
 *   · 执行器映射：本地节点真执行；生成 / 媒体 / 客户端渲染未注入端口时结构化不可用；
 *   · 注入生成 / 媒体端口后按 executor.id 分派并回填 result（node.edit）；
 *   · 插件节点与 builtin 同一 register 路径；未知类型 / 重复类型结构化拒绝；
 *   · canvas/nodes/* 命令经 createCanvasDxosExtension 真实分发，未认证执行被拒绝。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const registryModule = require("../electron/canvas-node-registry.cjs");
const { createCanvasNodeRegistry, ERROR, FORMAT, PARAM_SCHEMAS, EXECUTOR_PROFILES } = registryModule;
const { BUILTIN_CANVAS_NODES } = require("../electron/developer-canvas-builtins.cjs");
const commands = require("../electron/canvas-dxos-commands.cjs");
const domain = require("../electron/canvas-domain.cjs");

const BUILTIN_TYPES = BUILTIN_CANVAS_NODES.map((node) => node.type);

function pluginDefinition(over = {}) {
  return {
    type: "plugin.image-enhance",
    version: 1,
    title: "插件图像增强",
    category: "plugin",
    inputs: [{ id: "images", title: "图片", type: "media.image[]", multiple: true }],
    outputs: [{ id: "image", title: "结果", type: "media.image" }],
    executor: { type: "plugin", id: "plugin.enhance" },
    ...over,
  };
}

function fakeCanvasService() {
  const doc = { nodes: [{ id: "n1", type: "builtin.image-generator", params: { model: "m1" }, x: 10, y: 20 }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
  const patches = [];
  return {
    doc,
    patches,
    getCanvas: ({ canvasId }) => (canvasId === "c1" ? { ok: true, canvas: { canvasId, doc } } : { ok: false, error: "NOT_FOUND" }),
    applyCommand: ({ command }) => {
      patches.push(command);
      const node = doc.nodes.find((item) => item.id === command.id);
      if (!node) return { ok: false, error: "NOT_FOUND" };
      Object.assign(node, command.patch);
      return { ok: true, canvas: { canvasId: "c1", revision: 2 } };
    },
  };
}

function fakeIdentity(valid = true) {
  return { validateSession: (ref) => (valid && ref ? { ok: true, user: { id: "u1", role: "USER" } } : { ok: false }) };
}

/* ══════════════════════════════════════════════════════════════════════════
   1. 注册表完整性
   ══════════════════════════════════════════════════════════════════════════ */

test("17 个 builtin.* 全部注册：顺序与定义一致、executor / 端口 / 参数 schema 完整", () => {
  const registry = createCanvasNodeRegistry();
  const list = registry.list();
  assert.equal(list.length, 17, "17 个 builtin 必须全部注册");
  assert.deepEqual(list.map((node) => node.type), BUILTIN_TYPES, "注册顺序应与定义数组一致");
  assert.deepEqual(new Set(list.map((node) => node.type)).size, 17, "类型不能重复");
  for (const node of list) {
    assert.equal(node.origin, "builtin");
    assert.ok(node.executor.type === "builtin" && node.executor.id, node.type + " 缺 executor");
    assert.ok(EXECUTOR_PROFILES[node.executor.id], node.type + " 的 executor 没有运行期映射：" + node.executor.id);
    assert.equal(typeof node.paramSchema, "object", node.type + " 缺参数 schema");
    assert.equal(node.paramSchema.type, "object");
    for (const port of [...node.inputs, ...node.outputs]) {
      assert.ok(port.id && port.type, node.type + " 端口缺 id/type");
      assert.ok(registryModule.PORT_TYPES.includes(port.type), node.type + " 端口类型不在已知宇宙：" + port.type);
    }
  }
  const summary = registry.summary();
  assert.equal(summary.format, FORMAT);
  assert.equal(summary.count, 17);
  assert.equal(summary.builtinCount, 17);
  assert.equal(summary.pluginCount, 0);
  assert.match(summary.digests.registry, /^[0-9a-f]{64}$/);
});

test("参数 schema：生成类要求 prompt 或媒体；Midjourney 必须 prompt；LLM 接受 prompt 或 messages", () => {
  const registry = createCanvasNodeRegistry();
  assert.equal(registry.validateParams("builtin.image-generator", { prompt: "一只猫" }).ok, true);
  assert.equal(registry.validateParams("builtin.image-generator", { images: ["openarc-asset:1"] }).ok, true);
  const missing = registry.validateParams("builtin.image-generator", {});
  assert.equal(missing.ok, false);
  assert.equal(missing.error, ERROR.NODE_PARAMS_INVALID);
  assert.ok(missing.detail.errors.some((item) => item.path === "params.prompt"), "缺 prompt 必须指到 params.prompt");
  const badCount = registry.validateParams("builtin.image-generator", { prompt: "猫", count: 9 });
  assert.equal(badCount.ok, false);
  assert.ok(badCount.detail.errors.some((item) => item.path === "params.count"), "count 超范围必须拒绝");
  const wrongType = registry.validateParams("builtin.image-generator", { prompt: 123 });
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.detail.errors.some((item) => item.path === "params.prompt"));

  assert.equal(registry.validateParams("builtin.midjourney-generator", {}).ok, false, "Midjourney 无 prompt 必须拒绝");
  assert.equal(registry.validateParams("builtin.midjourney-generator", { prompt: "cat" }).ok, true);

  assert.equal(registry.validateParams("builtin.llm", { prompt: "hi" }).ok, true);
  assert.equal(registry.validateParams("builtin.llm", { messages: [{ role: "user", content: "hi" }] }).ok, true);
  assert.equal(registry.validateParams("builtin.llm", { messages: [] }).ok, false);
  assert.equal(registry.validateParams("builtin.llm", { messages: [{ role: "user" }] }).ok, false);
});

test("参数 schema：拼接 / 对比 / 表格 / 文本节点按真实字段校验，未知字段不被误判", () => {
  const registry = createCanvasNodeRegistry();
  assert.equal(registry.validateParams("builtin.mosaic", { images: ["a"] }).ok, true);
  assert.equal(registry.validateParams("builtin.mosaic", { images: [] }).ok, false);
  assert.equal(registry.validateParams("builtin.mosaic", { images: ["a"], columns: 99 }).ok, false);
  assert.equal(registry.validateParams("builtin.image-compare", {}).ok, false, "对比节点至少要一张图");
  assert.equal(registry.validateParams("builtin.image-compare", { images: ["a", "b"] }).ok, true);
  assert.equal(registry.validateParams("builtin.prompt", { prompt: "x".repeat(20001) }).ok, false);
  assert.equal(registry.validateParams("builtin.prompt", { prompt: "x", extraUiState: { a: 1 } }).ok, true, "画布 UI 私有字段应允许");
  assert.equal(registry.validateParams("builtin.table", { protocolParams: { table: { columns: [], rows: [] } } }).ok, true);
  assert.equal(registry.validateParams("builtin.table", { protocolParams: "bad" }).ok, false);
  assert.equal(registry.validateParams("builtin.group", {}).ok, true);
  assert.equal(registry.validateParams("builtin.not-a-node", {}).error, ERROR.NODE_TYPE_UNKNOWN);
});

/* ══════════════════════════════════════════════════════════════════════════
   2. 端口 / 连接
   ══════════════════════════════════════════════════════════════════════════ */

test("端口校验：精确匹配通过，不兼容 / 未知端口结构化拒绝，artifact 通配", () => {
  const registry = createCanvasNodeRegistry();
  assert.equal(registry.validateConnection({ from: "builtin.image-generator", fromPort: "images", to: "builtin.mosaic", toPort: "images" }).ok, true);
  assert.equal(registry.validateConnection({ from: "builtin.image-generator", fromPort: "images", to: "builtin.image-compare", toPort: "images" }).ok, true);
  const incompatible = registry.validateConnection({ from: "builtin.prompt", fromPort: "text", to: "builtin.mosaic", toPort: "images" });
  assert.equal(incompatible.ok, false);
  assert.equal(incompatible.error, ERROR.NODE_PORT_INCOMPATIBLE);
  assert.equal(incompatible.detail.fromType, "text");
  const unknownPort = registry.validateConnection({ from: "builtin.image-generator", fromPort: "nope", to: "builtin.mosaic", toPort: "images" });
  assert.equal(unknownPort.error, ERROR.NODE_PORT_UNKNOWN);
  const unknownType = registry.validateConnection({ from: "builtin.nope", fromPort: "x", to: "builtin.mosaic", toPort: "images" });
  assert.equal(unknownType.error, ERROR.NODE_TYPE_UNKNOWN);
  assert.equal(registry.validateConnection({ from: "builtin.junction", fromPort: "out", to: "builtin.table", toPort: "rows" }).ok, true, "artifact 应可进 artifact 输入");
  assert.equal(registry.validatePorts("builtin.mosaic", { images: "media.image[]" }).ok, true);
  const badPorts = registry.validatePorts("builtin.mosaic", { images: "text" });
  assert.equal(badPorts.error, ERROR.NODE_PORT_INCOMPATIBLE);
  assert.equal(badPorts.detail.errors[0].code, ERROR.NODE_PORT_INCOMPATIBLE);
  const missingPort = registry.validatePorts("builtin.mosaic", { nope: "text" });
  assert.equal(missingPort.detail.errors[0].code, ERROR.NODE_PORT_UNKNOWN);
});

/* ══════════════════════════════════════════════════════════════════════════
   3. 执行器映射与结构化不可用
   ══════════════════════════════════════════════════════════════════════════ */

test("执行器映射：本地 5 类可执行、资产 4 类 no-op、生成/媒体/客户端默认不可用", () => {
  const registry = createCanvasNodeRegistry();
  const byType = new Map(registry.list().map((node) => [node.type, node]));
  for (const type of ["builtin.prompt", "builtin.sticky", "builtin.table", "builtin.group", "builtin.junction", "builtin.image-asset", "builtin.video-asset", "builtin.audio-asset", "builtin.file-asset"]) {
    assert.equal(byType.get(type).executable, true, type + " 应可执行（本地 / 资产）");
  }
  for (const type of ["builtin.image-generator", "builtin.video-generator", "builtin.audio-generator", "builtin.midjourney-generator", "builtin.llm", "builtin.image-compare", "builtin.mosaic", "builtin.director-3d"]) {
    assert.equal(byType.get(type).executable, false, type + " 未注入端口时不能假执行");
    assert.equal(byType.get(type).unavailable.code, ERROR.NODE_EXECUTOR_UNAVAILABLE);
  }
  assert.equal(byType.get("builtin.director-3d").unavailable.detail.reason, "requires-client-renderer");
  assert.equal(byType.get("builtin.image-generator").unavailable.detail.executorId, "canvas.generate.image");
  assert.equal(byType.get("builtin.mosaic").unavailable.detail.capability, "media-processing");
});

test("执行：未注入生成 / 媒体端口的节点返回结构化不可用，不产出假结果", async () => {
  const registry = createCanvasNodeRegistry();
  const image = await registry.execute({ type: "builtin.image-generator", params: { prompt: "猫" } });
  assert.equal(image.ok, false);
  assert.equal(image.error, ERROR.NODE_EXECUTOR_UNAVAILABLE);
  assert.equal(image.detail.executorId, "canvas.generate.image");
  assert.equal(image.detail.reason, "no-generation-port");
  const mosaic = await registry.execute({ type: "builtin.mosaic", params: { images: ["a", "b"] } });
  assert.equal(mosaic.error, ERROR.NODE_EXECUTOR_UNAVAILABLE);
  assert.equal(mosaic.detail.capability, "media-processing");
  const director = await registry.execute({ type: "builtin.director-3d", params: {} });
  assert.equal(director.error, ERROR.NODE_EXECUTOR_UNAVAILABLE);
  assert.equal(director.detail.reason, "requires-client-renderer");
  const invalid = await registry.execute({ type: "builtin.image-generator", params: {} });
  assert.equal(invalid.error, ERROR.NODE_PARAMS_INVALID);
});

test("执行：本地节点真实执行（文本 / 表格 / 转接 / 分组 / 资产 no-op）", async () => {
  const registry = createCanvasNodeRegistry();
  const prompt = await registry.execute({ type: "builtin.prompt", params: { prompt: "写一首诗" } });
  assert.equal(prompt.ok, true);
  assert.deepEqual(prompt.outputs, { text: "写一首诗" });
  const sticky = await registry.execute({ type: "builtin.sticky", params: { prompt: "便签" } });
  assert.deepEqual(sticky.outputs, { text: "便签" });
  const table = await registry.execute({ type: "builtin.table", params: { protocolParams: { table: { columns: [{ title: "A" }], rows: [{ A: 1 }] } } } });
  assert.deepEqual(table.outputs.table, { columns: [{ title: "A" }], rows: [{ A: 1 }] });
  assert.deepEqual(table.outputs.rows, [{ A: 1 }]);
  const junction = await registry.execute({ type: "builtin.junction", params: { inputs: ["x"] } });
  assert.deepEqual(junction.outputs, { out: ["x"] });
  const group = await registry.execute({ type: "builtin.group", params: {} });
  assert.equal(group.ok, true);
  assert.deepEqual(group.outputs, {});
  const asset = await registry.execute({ type: "builtin.image-asset", params: { ref: "openarc-asset:abc" } });
  assert.equal(asset.ok, true);
  assert.equal(asset.status, "NOOP");
  assert.deepEqual(asset.outputs, { image: "openarc-asset:abc" });
});

test("执行：注入生成端口后按 executor.id 分派 image / video / midjourney / llm，失败原样透传", async () => {
  const calls = [];
  const registry = createCanvasNodeRegistry({
    ports: {
      generation: async (input) => {
        calls.push(input);
        if (input.type === "builtin.video-generator") return { ok: true, outputs: { videos: [{ url: "openarc-asset:v1" }] } };
        if (input.type === "builtin.midjourney-generator") return { ok: false, error: "MARKET_UPDATE_SOURCE_NOT_ALLOWED", detail: { reason: "safety" } };
        return { ok: true, outputs: { images: [{ url: "openarc-asset:i1" }], text: "ok" } };
      },
    },
  });
  const image = await registry.execute({ type: "builtin.image-generator", params: { prompt: "猫" } });
  assert.equal(image.ok, true);
  assert.equal(image.executorId, "canvas.generate.image");
  assert.deepEqual(image.outputs.images, [{ url: "openarc-asset:i1" }]);
  const video = await registry.execute({ type: "builtin.video-generator", params: { prompt: "海浪" } });
  assert.equal(video.executorId, "canvas.generate.video");
  assert.deepEqual(video.outputs.videos, [{ url: "openarc-asset:v1" }]);
  const llm = await registry.execute({ type: "builtin.llm", params: { prompt: "你好" } });
  assert.equal(llm.executorId, "canvas.llm");
  const mj = await registry.execute({ type: "builtin.midjourney-generator", params: { prompt: "cat" } });
  assert.equal(mj.ok, false);
  assert.equal(mj.error, "MARKET_UPDATE_SOURCE_NOT_ALLOWED");
  assert.deepEqual(mj.detail, { reason: "safety" });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.executorId), ["canvas.generate.image", "canvas.generate.video", "canvas.llm", "canvas.generate.midjourney"]);
});

test("执行：注入媒体处理端口后拼接 / 对比节点按 executor.id 分派", async () => {
  const calls = [];
  const registry = createCanvasNodeRegistry({ ports: { mediaProcess: async (input) => { calls.push(input.executorId); return { ok: true, outputs: { image: "openarc-asset:out" } }; } } });
  const mosaic = await registry.execute({ type: "builtin.mosaic", params: { images: ["a", "b"], columns: 2 } });
  assert.equal(mosaic.ok, true);
  assert.equal(mosaic.executorId, "canvas.image.mosaic");
  assert.deepEqual(mosaic.outputs, { image: "openarc-asset:out" });
  const compare = await registry.execute({ type: "builtin.image-compare", params: { images: ["a", "b"] } });
  assert.equal(compare.executorId, "canvas.image.compare");
  assert.deepEqual(calls, ["canvas.image.mosaic", "canvas.image.compare"]);
});

test("执行：按 nodeId 从文档解析类型，成功后 node.edit 回填 params.lastRunResult 与 runStatus", async () => {
  const canvasService = fakeCanvasService();
  const registry = createCanvasNodeRegistry({ ports: { generation: async () => ({ ok: true, outputs: { images: [{ url: "openarc-asset:i9" }] } }) }, canvasService });
  const executed = await registry.execute({ type: null, params: { prompt: "猫" }, context: { sessionRef: "s" }, canvasId: "c1", nodeId: "n1", writeBack: true });
  assert.equal(executed.ok, true);
  assert.equal(executed.type, "builtin.image-generator");
  assert.equal(executed.writeBack.ok, true);
  assert.equal(executed.writeBack.revision, 2);
  assert.equal(canvasService.patches.length, 1);
  const patch = canvasService.patches[0];
  assert.equal(patch.type, "node.edit");
  assert.equal(patch.id, "n1");
  assert.equal(patch.patch.runStatus, "DONE");
  assert.equal(patch.patch.runError, null);
  assert.deepEqual(patch.patch.params.lastRunResult, { images: [{ url: "openarc-asset:i9" }] });
  assert.equal(patch.patch.params.model, "m1", "回填应合并节点原有 params，而不是整体覆盖");
});

test("未知类型 / 参数不合法 / 回填目标缺失都结构化拒绝", async () => {
  const registry = createCanvasNodeRegistry();
  const unknown = await registry.execute({ type: "builtin.unknown-node", params: {} });
  assert.equal(unknown.error, ERROR.NODE_TYPE_UNKNOWN);
  const canvasService = fakeCanvasService();
  const withService = createCanvasNodeRegistry({ ports: { generation: async () => ({ ok: true, outputs: {} }) }, canvasService });
  const missing = await withService.execute({ type: "builtin.image-generator", params: { prompt: "x" }, context: {}, canvasId: "c2", nodeId: "n1", writeBack: true });
  assert.equal(missing.ok, true, "生成本身成功；回填失败要单独、诚实报告");
  assert.equal(missing.writeBack.ok, false);
  assert.equal(missing.writeBack.error, "NOT_FOUND");
});

/* ══════════════════════════════════════════════════════════════════════════
   4. 插件同路径与命令集成
   ══════════════════════════════════════════════════════════════════════════ */

test("插件节点与 builtin 同一 register 路径：重复 / 非法定义结构化拒绝", () => {
  const registry = createCanvasNodeRegistry({ extraDefinitions: [pluginDefinition()] });
  const list = registry.list();
  assert.equal(list.length, 18);
  assert.equal(list[17].type, "plugin.image-enhance");
  assert.equal(list[17].origin, "plugin");
  assert.equal(registry.summary().pluginCount, 1);
  assert.equal(registry.register(pluginDefinition()).error, ERROR.NODE_TYPE_DUPLICATE);
  const invalid = registry.register({ type: "plugin.bad", executor: null });
  assert.equal(invalid.error, ERROR.NODE_DEFINITION_INVALID);
  const pluginExec = createCanvasNodeRegistry({ extraDefinitions: [pluginDefinition()], ports: { plugin: async (input) => ({ ok: true, outputs: { image: "openarc-asset:p" } }) } });
  assert.equal(pluginExec.describe("plugin.image-enhance").executable, true);
});

test("canvas/nodes/* 命令经扩展真实分发：list / get / validate / execute；未认证执行被拒绝", async () => {
  const extension = commands.createCanvasDxosExtension({
    identity: fakeIdentity(true),
    nodeDefinitions: [pluginDefinition()],
    nodePorts: { generation: async () => ({ ok: true, outputs: { images: ["openarc-asset:cmd"] } }) },
    clock: () => Date.now(),
  });
  const authorized = { sessionRef: "s1" };
  const listed = await extension.dispatch({ command: "canvas/nodes/list", payload: {}, context: authorized });
  assert.equal(listed.ok, true);
  assert.equal(listed.registry.count, 18);
  assert.equal(listed.nodes.filter((node) => node.origin === "builtin").length, 17);
  const got = await extension.dispatch({ command: "canvas/nodes/get", payload: { type: "builtin.image-generator" }, context: authorized });
  assert.equal(got.ok, true);
  assert.equal(got.node.executor.id, "canvas.generate.image");
  const unknown = await extension.dispatch({ command: "canvas/nodes/get", payload: { type: "builtin.nope" }, context: authorized });
  assert.equal(unknown.error, ERROR.NODE_TYPE_UNKNOWN);
  const valid = await extension.dispatch({ command: "canvas/nodes/validate", payload: { type: "builtin.image-generator", params: { prompt: "cat" } }, context: authorized });
  assert.equal(valid.ok, true);
  const invalid = await extension.dispatch({ command: "canvas/nodes/validate", payload: { type: "builtin.image-generator", params: {} }, context: authorized });
  assert.equal(invalid.error, ERROR.NODE_PARAMS_INVALID);
  const connection = await extension.dispatch({ command: "canvas/nodes/validate", payload: { connection: { from: "builtin.image-generator", fromPort: "images", to: "builtin.mosaic", toPort: "images" } }, context: authorized });
  assert.equal(connection.ok, true);
  const executed = await extension.dispatch({ command: "canvas/nodes/execute", payload: { type: "builtin.image-generator", params: { prompt: "cat" } }, context: authorized });
  assert.equal(executed.ok, true);
  assert.deepEqual(executed.outputs.images, ["openarc-asset:cmd"]);
  const local = await extension.dispatch({ command: "canvas/nodes/execute", payload: { type: "builtin.prompt", params: { prompt: "hi" } }, context: authorized });
  assert.equal(local.ok, true);
  const denied = await extension.dispatch({ command: "canvas/nodes/execute", payload: { type: "builtin.prompt", params: { prompt: "hi" } }, context: {} });
  assert.equal(denied.error, "NOT_FOUND_OR_FORBIDDEN");
});

test("默认生成执行器：image-generator / llm 接 canvas/run → modelCall；视频 / Midjourney 结构化不可用", async () => {
  const doc = { nodes: [{ id: "n1", type: "builtin.image-generator", params: { model: "m1" }, x: 0, y: 0 }, { id: "n2", type: "builtin.llm", params: {}, x: 40, y: 0 }], connections: [], viewport: { x: 0, y: 0, scale: 1 }, logs: [] };
  const runs = [];
  const finished = [];
  const patches = [];
  const canvasService = {
    getCanvas: () => ({ ok: true, canvas: { doc } }),
    applyCommand: ({ command }) => { patches.push(command); return { ok: true, canvas: { revision: 3 } }; },
    startRun: ({ kind, nodeId }) => { const runId = "run_" + (runs.length + 1); runs.push({ kind, nodeId, runId }); return { ok: true, runId }; },
    modelCall: async ({ kind }) => (kind === "image" ? { ok: true, images: [{ url: "openarc-asset:gen" }] } : { ok: true, text: "回复" }),
    finishRun: ({ runId, status }) => { finished.push({ runId, status }); return { ok: true }; },
  };
  const extension = commands.createCanvasDxosExtension({ identity: fakeIdentity(true), canvasService, clock: () => Date.now() });
  const authorized = { sessionRef: "s1" };
  const listed = await extension.dispatch({ command: "canvas/nodes/list", payload: {}, context: authorized });
  const imageNode = listed.nodes.find((node) => node.type === "builtin.image-generator");
  const videoNode = listed.nodes.find((node) => node.type === "builtin.video-generator");
  assert.equal(imageNode.executable, true, "装配真实 canvasService 后 image-generator 应可执行");
  assert.equal(videoNode.executable, false);
  assert.equal(videoNode.unavailable.detail.reason, "unsupported-model-kind");

  const image = await extension.dispatch({ command: "canvas/nodes/execute", payload: { type: "builtin.image-generator", params: { prompt: "猫" }, canvasId: "c1", nodeId: "n1", writeBack: true }, context: authorized });
  assert.equal(image.ok, true);
  assert.deepEqual(image.outputs.images, [{ url: "openarc-asset:gen" }]);
  assert.equal(runs[0].kind, "image");
  assert.equal(runs[0].nodeId, "n1");
  assert.deepEqual(finished[0], { runId: "run_1", status: "DONE" });
  assert.equal(image.writeBack.ok, true);
  assert.deepEqual(patches[0].patch.params.lastRunResult, { images: [{ url: "openarc-asset:gen" }] });
  assert.equal(patches[0].patch.runStatus, "DONE");

  const llm = await extension.dispatch({ command: "canvas/nodes/execute", payload: { type: "builtin.llm", params: { prompt: "你好" }, canvasId: "c1", nodeId: "n2" }, context: authorized });
  assert.equal(llm.ok, true);
  assert.equal(llm.outputs.text, "回复");
  assert.equal(runs[1].kind, "chat");

  const video = await extension.dispatch({ command: "canvas/nodes/execute", payload: { type: "builtin.video-generator", params: { prompt: "海浪" } }, context: authorized });
  assert.equal(video.ok, false);
  assert.equal(video.error, "CANVAS_NODE_EXECUTOR_UNAVAILABLE");
  assert.equal(video.detail.reason, "unsupported-model-kind");
  assert.equal(runs.length, 2, "视频生成不应创建 Task");
});

test("命令登记：canvas/nodes/* 都有中文 summary / 合法 risk / credential=none，并进渲染层白名单", () => {
  const entries = commands.DXOS_CANVAS_COMMANDS.filter((entry) => entry.command.startsWith("canvas/nodes/"));
  assert.deepEqual(entries.map((entry) => entry.command).sort(), ["canvas/nodes/execute", "canvas/nodes/get", "canvas/nodes/list", "canvas/nodes/validate"]);
  for (const entry of entries) {
    assert.ok(["read", "write", "delete", "external"].includes(entry.risk), entry.command + " risk 非法");
    assert.equal(entry.credential, "none");
    assert.match(entry.summary, /[\u4e00-\u9fa5]/, entry.command + " summary 必须中文");
  }
  const renderer = commands.extendRendererCommands([]);
  for (const entry of entries) assert.ok(renderer.includes(entry.command), entry.command + " 未进渲染层白名单");
});

test("画布文档 node.add 接受 builtin.* 节点类型（运行期与文档层不冲突）", () => {
  const doc = domain.emptyDoc();
  const added = domain.applyCommand(doc, { type: "node.add", node: { id: "n1", type: "builtin.image-generator", x: 1, y: 2 } });
  assert.equal(added.ok, true);
  assert.equal(added.doc.nodes[0].type, "builtin.image-generator");
  assert.equal(domain.NODE_TYPES.includes("builtin.image-generator"), false, "文档卡片 kind 与 builtin 命名空间保持分离");
});
