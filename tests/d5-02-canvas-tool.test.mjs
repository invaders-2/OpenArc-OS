/**
 * D5-02 · AI 编辑画布走**同一条**命令层与受控工具契约。
 *
 * 这里验证的是产品真实装配：Tool Registry 条目（权限 / 审批 / 执行类）+
 * CanvasControl adapter 的 plan→execute→verify（用真实 CanvasService / SQLite）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { CanvasStore } from "../electron/canvas-store.cjs";
import { CanvasService } from "../electron/canvas-service.cjs";

const require = (await import("node:module")).createRequire(import.meta.url);
const { ToolRegistry } = require("../electron/tool-registry.cjs");
const { createToolAdapters } = require("../electron/tool-adapters.cjs");

test("D5-02 · Registry：canvas.read / canvas.edit 权限、审批与执行类", () => {
  const reg = new ToolRegistry();
  const tools = (reg.list ? reg.list() : []).map((t) => t.toolId);
  assert.ok(tools.includes("canvas.read"));
  assert.ok(tools.includes("canvas.edit"));
  const read = reg.get("canvas.read", 1);
  const edit = reg.get("canvas.edit", 1);
  assert.equal(read.executionProvider, "CanvasControl");
  assert.equal(read.requiresApproval, false);
  assert.deepEqual(read.requiredPermissions, ["tool.canvas.read"]);
  assert.equal(edit.executionProvider, "CanvasControl");
  assert.equal(edit.requiresApproval, true, "编辑画布必须审批");
  assert.deepEqual(edit.requiredPermissions, ["tool.canvas.edit"]);
  assert.equal(edit.executionPolicy, "CONTROLLED_REVERSIBLE_WRITE");
  assert.equal(edit.sideEffect, "WRITE");
  assert.equal(edit.riskClass, "REVERSIBLE_WRITE");
  // 读取绝不隐含编辑
  assert.notEqual(read.requiredPermissions[0], edit.requiredPermissions[0]);
});

test("D5-02 · CanvasControl adapter：plan 带基准版本，execute 用 plan，verify 读回确认", async () => {
  const fx = await createResourceFixture();
  try {
    const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
    const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });
    const ctx = { sessionRef: fx.sessions.admin, appId: "ai", source: "ui" };
    const created = service.createCanvas({ context: ctx, title: "AI 画布" });
    assert.equal(created.ok, true, JSON.stringify(created));
    const canvasId = created.canvas.canvasId;
    // AI 上下文：工具执行时只有 actorUserId（不信任 Harness 自报身份）
    const toolCtx = { ...ctx, actorUserId: fx.users.admin };
    const adapters = createToolAdapters({ canvasService: service });
    const provider = adapters.adapterFor({ executionProvider: "CanvasControl", toolId: "canvas.edit" });
    assert.ok(provider, "registry 的 executionProvider 必须能解析到 adapter");
    assert.equal(adapters.adapterFor({ executionProvider: "CanvasControl", toolId: "browser.navigate" }), null, "provider 只认自己声明的 toolIds");

    const args = { canvasId, command: { type: "node.add", node: { id: "ai_n1", type: "prompt", x: 40, y: 60, text: "AI 加的节点" } } };
    const plan = await provider.plan({ context: toolCtx, args, contract: { toolId: "canvas.edit" } });
    assert.ok(plan, "plan 必须产出");
    assert.equal(plan.preconditions.targetRef, canvasId);
    assert.equal(plan.preconditions.revision, 1, "plan 固定基准版本");
    assert.ok(plan.preconditions.commandFingerprint);
    const pre = { ...plan.preconditions };
    const res = await provider.execute({ context: toolCtx, args, contract: { toolId: "canvas.edit" }, preconditions: pre, expectedEffects: plan.expectedEffects });
    assert.equal(res.ok, true, JSON.stringify(res));
    const verified = await provider.verify({ context: toolCtx, result: res.result, preconditions: pre, contract: { toolId: "canvas.edit" } });
    assert.equal(verified.ok, true);
    assert.equal(verified.applied, true, JSON.stringify(verified));
    // 文档里确实有那个节点（走的是同一份 store）
    const doc = service.getCanvas({ context: ctx, canvasId }).canvas.doc;
    assert.equal(doc.nodes.length, 1);
    assert.equal(doc.nodes[0].text, "AI 加的节点");
    // 账本里记的是 AGENT 命令（撤销记录同一份）
    const log = service.commandLog({ context: ctx, canvasId });
    assert.equal(log.items[0].actorKind, "AGENT");
    assert.equal(log.items[0].outcome, "APPLIED");
  } finally { fx.close(); }
});

test("D5-02 · A38：批准后用户先改了 → AI 执行被版本检查拒绝（不覆盖用户内容）", async () => {
  const fx = await createResourceFixture();
  try {
    const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
    const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });
    const ctx = { sessionRef: fx.sessions.admin, appId: "ai", source: "ui" };
    const created = service.createCanvas({ context: ctx, title: "冲突画布" });
    const canvasId = created.canvas.canvasId;
    service.applyCommand({ context: ctx, canvasId, baseRevision: 1, command: { type: "node.add", node: { id: "n1", type: "prompt", x: 0, y: 0, text: "原始" } } });
    const toolCtx = { ...ctx, actorUserId: fx.users.admin };
    const adapters = createToolAdapters({ canvasService: service });
    const provider = adapters.adapterFor({ executionProvider: "CanvasControl", toolId: "canvas.edit" });
    const args = { canvasId, command: { type: "node.edit", id: "n1", patch: { text: "AI 想改的" } } };
    const plan = await provider.plan({ context: toolCtx, args, contract: { toolId: "canvas.edit" } });
    const pre = { ...plan.preconditions };
    // 批准之后、执行之前：用户手工改了同一节点
    service.applyCommand({ context: ctx, canvasId, baseRevision: pre.revision, command: { type: "node.edit", id: "n1", patch: { text: "用户的手工修改" } } });
    const res = await provider.execute({ context: toolCtx, args, contract: { toolId: "canvas.edit" }, preconditions: pre, expectedEffects: plan.expectedEffects });
    assert.equal(res.ok, false);
    assert.equal(res.knownNoEffect, true, "版本冲突 = 明确没有写入（不是不可知）");
    assert.equal(res.error, "REVISION_CONFLICT");
    assert.equal(service.getCanvas({ context: ctx, canvasId }).canvas.doc.nodes[0].text, "用户的手工修改");
    // UNKNOWN_EFFECT 恢复：账本里没有这条命令，且 revision 前进过 → INDETERMINATE（不猜）
    const rec = await provider.recoveryVerify({ context: toolCtx, call: { callId: "c1" }, preconditions: pre });
    assert.equal(rec.outcome, "INDETERMINATE");
  } finally { fx.close(); }
});

test("D5-02 · A28：只读成员时 AI 工具执行被同一条权限规则拒绝", async () => {
  const fx = await createResourceFixture();
  try {
    const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
    const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });
    const owner = { sessionRef: fx.sessions.admin, appId: "ai", source: "ui" };
    const created = service.createCanvas({ context: owner, title: "共享画布" });
    const canvasId = created.canvas.canvasId;
    service.shareCanvas({ context: owner, canvasId, userId: fx.users.alice, role: "VIEWER" });
    const aliceCtx = { sessionRef: fx.sessions.alice, appId: "ai", source: "ui", actorUserId: fx.users.alice };
    const adapters = createToolAdapters({ canvasService: service });
    const provider = adapters.adapterFor({ executionProvider: "CanvasControl", toolId: "canvas.edit" });
    // plan 阶段就拿不到（只读成员连"计划一次写入"都不允许）
    const plan = await provider.plan({ context: aliceCtx, args: { canvasId, command: { type: "node.add", node: { id: "x", type: "prompt", x: 0, y: 0 } } }, contract: { toolId: "canvas.edit" } });
    assert.equal(plan, null, "只读成员不应产出写入 plan");
    // 直接执行也必须被拒（防御性：不依赖上一步）
    const res = await provider.execute({ context: aliceCtx, args: { canvasId, command: { type: "node.add", node: { id: "x", type: "prompt", x: 0, y: 0 } } }, contract: { toolId: "canvas.edit" }, preconditions: { targetRef: canvasId, revision: 1, command: { type: "node.add", node: { id: "x", type: "prompt", x: 0, y: 0 } } }, expectedEffects: [] });
    assert.equal(res.ok, false);
    assert.equal(res.knownNoEffect, true);
    assert.equal(res.error, "READ_ONLY");
    assert.equal(service.getCanvas({ context: owner, canvasId }).canvas.doc.nodes.length, 0);
  } finally { fx.close(); }
});
