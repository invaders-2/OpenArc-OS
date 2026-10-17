/** task-71 · 服务端画布工具：canvas_list / canvas_generate_image。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { ToolRegistry, buildWriteToolManifest } = require("../electron/tool-registry.cjs");
const { createToolAdapters } = require("../electron/tool-adapters.cjs");
const { createCanvasBundle } = require("../electron/canvas-bootstrap.cjs");

function docCanvasOf(f) {
  return createCanvasBundle({ identityStore: f.identity, resourceStore: f.resourceStore, resourceService: f.resourceService, authService: f.authService, authStore: f.store }).service;
}
const { READ_TOOL_IDS, WRITE_TOOL_IDS } = require("../electron/dsh-tool-profile.cjs");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function ctxOf(f) { return { ...f.adminCtx(), actorUserId: f.users.admin, appId: "ai" }; }

test("工具注册：canvas.list READ / canvas.generate.image WRITE（需审批、tool.canvas.edit、external 风险）", () => {
  assert.ok(READ_TOOL_IDS.includes("canvas.list"));
  assert.ok(WRITE_TOOL_IDS.includes("canvas.generate.image"));
  assert.ok(!READ_TOOL_IDS.includes("canvas.generate.image"));
  const registry = new ToolRegistry();
  const list = registry.get("canvas.list", 1);
  const gen = registry.get("canvas.generate.image", 1);
  assert.ok(list && gen);
  assert.equal(list.riskClass, "READ_ONLY");
  assert.deepEqual(list.requiredPermissions, ["tool.canvas.read"]);
  assert.equal(gen.riskClass, "REVERSIBLE_WRITE");
  assert.equal(gen.requiresApproval, true);
  assert.deepEqual(gen.requiredPermissions, ["tool.canvas.edit"]);
  assert.equal(gen.executionPolicy, "CONTROLLED_REVERSIBLE_WRITE");
  assert.equal(gen.risk, "external");
  const writeManifest = buildWriteToolManifest(registry, { toolIds: WRITE_TOOL_IDS });
  assert.ok(writeManifest.toolIds.includes("canvas.generate.image"));
});

test("canvas.generate.image：无 canvasId 用最近可编辑画布，生成 PNG → 资源入库 + image 节点，真实 plan/execute/verify", async () => {
  const f = await createResourceFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-task71-"));
  try {
    const canvasService = docCanvasOf(f);
    const canvas = canvasService.createCanvas({ context: f.adminCtx(), title: "主画布" });
    assert.equal(canvas.ok, true, JSON.stringify(canvas));
    canvasService.tempDir = dir;
    const generated = [];
    canvasService.modelService = {
      resolveModel: () => ({ ok: true, snapshot: { modelConfigId: "cfg_img", modelId: "fake-image" } }),
      generateImage: async (input) => {
        generated.push(input);
        return { ok: true, images: [{ dataUrl: "data:image/png;base64," + PNG }] };
      },
    };
    const adapters = createToolAdapters({ canvasService, resourceService: f.resourceService });
    const adapter = adapters.adapterFor({ executionProvider: "CanvasControl", toolId: "canvas.generate.image" });
    assert.ok(adapter, "CanvasControl adapter 必须存在");
    const context = ctxOf(f);
    const plan = await adapter.plan({ context, args: { prompt: "一只猫" }, contract: { toolId: "canvas.generate.image" } });
    assert.ok(plan, "有默认图像模型且画布可编辑时必须能 plan");
    assert.equal(plan.preconditions.canvasId, canvas.canvas.canvasId, "无 canvasId 时应选最近可编辑画布");
    const result = await adapter.execute({ context, args: { prompt: "一只猫" }, preconditions: plan.preconditions, contract: { toolId: "canvas.generate.image" } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.canvasId, canvas.canvas.canvasId);
    assert.ok(result.result.nodeId);
    assert.match(result.result.resourceRef, /^openarc-asset:/);
    assert.equal(generated.length, 1);
    assert.equal(generated[0].prompt, "一只猫");
    const detail = canvasService.getCanvas({ context, canvasId: canvas.canvas.canvasId });
    const node = detail.canvas.doc.nodes.find((item) => item.id === result.result.nodeId);
    assert.ok(node, "画布必须新增 image 节点");
    assert.equal(node.type, "image");
    assert.equal(node.url, result.result.resourceRef);
    const resource = f.resourceService.get({ context, resourceRef: result.result.resourceRef.replace(/^openarc-asset:/, "") });
    assert.equal(resource.ok, true, JSON.stringify(resource));
    assert.equal(resource.resource.mimeType, "image/png");
    const verified = await adapter.verify({ context, result: result.result, preconditions: plan.preconditions, contract: { toolId: "canvas.generate.image" } });
    assert.equal(verified.applied, true, JSON.stringify(verified));
  } finally { f.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("canvas.list：返回可编辑画布；无默认图像模型时 canvas.generate.image 结构化 MODEL_CONFIG_UNAVAILABLE", async () => {
  const f = await createResourceFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-task71b-"));
  try {
    const canvasService = docCanvasOf(f);
    const canvas = canvasService.createCanvas({ context: f.adminCtx(), title: "画布 A" });
    assert.equal(canvas.ok, true);
    canvasService.tempDir = dir;
    canvasService.modelService = {
      resolveModel: () => ({ ok: false, error: "MODEL_CONFIG_UNAVAILABLE" }),
      generateImage: async () => { throw new Error("must not be called"); },
    };
    const adapters = createToolAdapters({ canvasService, resourceService: f.resourceService });
    const context = ctxOf(f);
    const listAdapter = adapters.adapterFor({ executionProvider: "CanvasControl", toolId: "canvas.list" });
    const listed = await listAdapter.execute({ context, args: {}, preconditions: { targetRef: "canvas:list" }, contract: { toolId: "canvas.list" } });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.ok(listed.result.canvases.some((entry) => entry.canvasId === canvas.canvas.canvasId && entry.canEdit === true));

    const genAdapter = adapters.adapterFor({ executionProvider: "CanvasControl", toolId: "canvas.generate.image" });
    const plan = await genAdapter.plan({ context, args: { prompt: "猫" }, contract: { toolId: "canvas.generate.image" } });
    assert.equal(plan, null, "无默认图像模型时不应发起审批");
    const executed = await genAdapter.execute({ context, args: { prompt: "猫" }, preconditions: { prompt: "猫", count: 1 }, contract: { toolId: "canvas.generate.image" } });
    assert.equal(executed.ok, false);
    assert.equal(executed.knownNoEffect, true);
    assert.equal(executed.error, "MODEL_CONFIG_UNAVAILABLE");
    const detail = canvasService.getCanvas({ context, canvasId: canvas.canvas.canvasId });
    assert.equal(detail.canvas.doc.nodes.length, 0, "无模型时不得新增节点");
  } finally { f.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
