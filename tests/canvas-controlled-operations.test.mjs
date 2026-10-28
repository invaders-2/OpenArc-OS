import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { CanvasStore } from "../electron/canvas-store.cjs";
import { CanvasService } from "../electron/canvas-service.cjs";
const require = createRequire(import.meta.url);
const { createToolAdapters } = require("../electron/tool-adapters.cjs");

test("受控 Agent：创建、修改、连线、断线、删除均经 plan/execute/verify 生效", async () => {
  const fx = await createResourceFixture();
  try {
    const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
    const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });
    const ctx = { sessionRef: fx.sessions.admin, appId: "ai", source: "ui", actorUserId: fx.users.admin };
    const created = service.createCanvas({ context: ctx, title: "受控操作" });
    const canvasId = created.canvas.canvasId;
    const provider = createToolAdapters({ canvasService: service }).adapterFor({ executionProvider: "CanvasControl", toolId: "canvas.edit" });
    const run = async (command) => {
      const args = { canvasId, command };
      const plan = await provider.plan({ context: ctx, args, contract: { toolId: "canvas.edit" } });
      assert.ok(plan, "必须生成受控计划 " + JSON.stringify(command));
      const pre = { ...plan.preconditions };
      const result = await provider.execute({ context: ctx, args, contract: { toolId: "canvas.edit" }, preconditions: pre, expectedEffects: plan.expectedEffects });
      assert.equal(result.ok, true, JSON.stringify(result));
      const verified = await provider.verify({ context: ctx, result: result.result, preconditions: pre, contract: { toolId: "canvas.edit" } });
      assert.equal(verified.applied, true, JSON.stringify(verified));
    };
    await run({ type: "node.add", node: { id: "text_1", type: "prompt", text: "原文", x: 0, y: 0 } });
    await run({ type: "node.add", node: { id: "image_1", type: "image", x: 300, y: 0 } });
    await run({ type: "node.edit", id: "text_1", patch: { text: "已修改" } });
    await run({ type: "edge.connect", from: "text_1", to: "image_1", id: "edge_1" });
    assert.equal(service.getCanvas({ context: ctx, canvasId }).canvas.doc.nodes.find((n) => n.id === "text_1").text, "已修改");
    assert.equal(service.getCanvas({ context: ctx, canvasId }).canvas.doc.connections.length, 1);
    await run({ type: "edge.disconnect", id: "edge_1" });
    assert.equal(service.getCanvas({ context: ctx, canvasId }).canvas.doc.connections.length, 0);
    await run({ type: "node.delete", ids: ["text_1"] });
    const doc = service.getCanvas({ context: ctx, canvasId }).canvas.doc;
    assert.equal(doc.nodes.some((n) => n.id === "text_1"), false);
    assert.equal(doc.nodes.some((n) => n.id === "image_1"), true);
    const log = service.commandLog({ context: ctx, canvasId });
    assert.equal(log.items.length, 6);
    assert.ok(log.items.every((item) => item.actorKind === "AGENT" && item.outcome === "APPLIED"));
  } finally { fx.close(); }
});
