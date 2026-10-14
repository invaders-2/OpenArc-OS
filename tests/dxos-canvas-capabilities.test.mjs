/**
 * B5c · 画布内核能力清单投影（源 server/canvasKernelCapabilities.ts）。
 * 被测：electron/canvas-dxos-capabilities.cjs（产品真实代码）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const caps = require("../electron/canvas-dxos-capabilities.cjs");
const domain = require("../electron/canvas-domain.cjs");

const RISKS = new Set(["read", "write", "delete", "external"]);
const NAMES = new Set(caps.STATIC_TOOLS.map((tool) => tool.name));

test("投影覆盖内置节点类型与 Agent 可执行命令（源 :6-12 / :26-31 的动态枚举位置）", () => {
  const projection = caps.buildCanvasKernelCapabilities({ nodeTypes: ["plugin_x"] });
  assert.equal(projection.format, caps.FORMAT);
  assert.ok(projection.generatedAt > 0);
  assert.match(projection.digest, /^[0-9a-f]{64}$/);
  for (const type of domain.NODE_TYPES) assert.ok(projection.nodeTypes.includes(type), "缺节点类型 " + type);
  assert.ok(projection.nodeTypes.includes("plugin_x"));
  assert.deepEqual(projection.agentCommands, [...domain.AGENT_COMMANDS].sort());
});

test("每条能力都有统一身份与 risk / credential / 中文 summary（源 :14-22）", () => {
  const { capabilities } = caps.buildCanvasKernelCapabilities({});
  assert.ok(capabilities.length >= NAMES.size);
  const seen = new Set();
  for (const capability of capabilities) {
    assert.match(capability.capabilityId, /^app:canvas:[\w.]+$/);
    assert.ok(!seen.has(capability.capabilityId), "能力 id 重复：" + capability.capabilityId);
    seen.add(capability.capabilityId);
    assert.equal(capability.source, "app");
    assert.equal(capability.sourceId, caps.SOURCE_ID);
    assert.equal(capability.appId, "canvas");
    assert.equal(capability.domain, "app.canvas");
    assert.equal(capability.enabled, true);
    assert.equal(capability.executable, true);
    assert.equal(capability.status, "ready");
    assert.equal(capability.statusText, "Canvas 客户端受控执行");
    assert.deepEqual(capability.requiredContext, ["app.canvas.current"]);
    assert.equal(capability.handler.type, "client");
    assert.ok(RISKS.has(capability.risk), "未知 risk：" + capability.risk);
    assert.equal(capability.credential, "none", "画布不持有凭据（canvas-service.cjs:7）");
    assert.ok(Array.isArray(capability.sideEffects));
    assert.ok(typeof capability.summary === "string" && /[\u4e00-\u9fa5]/.test(capability.summary), "summary 必须是中文：" + capability.name);
    assert.ok(typeof capability.inputSchema === "object" && capability.inputSchema.type === "object");
  }
});

test("风险分级与源口径一致：删除=delete、生成=external 且声明调用模型供应商（源 :33 / :42）", () => {
  const { capabilities } = caps.buildCanvasKernelCapabilities({});
  const byName = new Map(capabilities.map((capability) => [capability.name, capability]));
  const remove = byName.get("canvas_delete_nodes");
  assert.equal(remove.risk, "delete");
  assert.deepEqual(remove.sideEffects, ["delete:canvas-node"]);
  const run = byName.get("canvas_run_generation");
  assert.equal(run.risk, "external");
  assert.ok(run.sideEffects.includes("call:model-provider"));
  const read = byName.get("canvas_read");
  assert.equal(read.risk, "read");
  assert.deepEqual(read.sideEffects, []);
  // 写类能力的副作用必须显式
  for (const name of ["canvas_create_node", "canvas_edit_node", "canvas_move_node", "canvas_group_nodes", "canvas_connect_nodes"]) {
    assert.equal(byName.get(name).risk, "write");
    assert.deepEqual(byName.get(name).sideEffects, ["modify:canvas"]);
  }
});

test("create_node 的 nodeType 枚举来自真实节点类型，不是写死的假清单", () => {
  const { capabilities } = caps.buildCanvasKernelCapabilities({ nodeTypes: ["plugin_x"] });
  const create = capabilities.find((capability) => capability.name === "canvas_create_node");
  assert.deepEqual(create.inputSchema.properties.nodeType.enum, [...new Set([...domain.NODE_TYPES, "plugin_x"])].sort());
});

test("Agent 工具目录契约：toCatalogDescriptors / buildCanvasCatalogSource（agent-tool-catalog.cjs:62-65 的 {list}）", () => {
  const projection = caps.buildCanvasKernelCapabilities({});
  const descriptors = caps.toCatalogDescriptors(projection.capabilities);
  assert.equal(descriptors.length, projection.capabilities.length);
  for (const descriptor of descriptors) {
    assert.equal(descriptor.source, "app");
    assert.equal(descriptor.sourceId, caps.SOURCE_ID);
    assert.equal(descriptor.domain, "app.canvas");
    assert.equal(descriptor.status, "ready");
    assert.equal(descriptor.handler.type, "client");
    assert.ok(Array.isArray(descriptor.intents) && descriptor.intents.length >= 1);
  }
  const source = caps.buildCanvasCatalogSource({});
  assert.equal(typeof source.list, "function");
  assert.equal(source.list().length, descriptors.length);
  assert.equal(source.list()[0].sourceId, "canvas-kernel");
});

test("capabilityDescriptor 允许注入额外工具（插件节点能力的接入点）", () => {
  const { capabilities } = caps.buildCanvasKernelCapabilities({
    extraTools: [{ name: "canvas.plugin.run", title: "跑插件节点", summary: "运行插件声明的节点操作。", command: "canvas/command", profile: { risk: "write", credential: "none", sideEffects: ["modify:canvas"] }, commandType: "node.edit" }],
  });
  const extra = capabilities.find((capability) => capability.name === "canvas_plugin_run");
  assert.ok(extra, "额外工具应进入投影");
  assert.equal(extra.capabilityId, "app:canvas:canvas.plugin.run");
});
