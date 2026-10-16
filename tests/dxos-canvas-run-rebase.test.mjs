/**
 * DXOS-CANVAS-RUN-REBASE · 异步生成 run 的结果写回（真机缺陷回归）。
 *
 * 缺陷：画布页 runGenerator 在 POST 之后会把「pending 卡片」落盘 → 画布 revision 前进；
 * 旧 modelCall 用整画布 run.base_revision 判定 → 返回 CANVAS_CHANGED，静默丢掉用户等了 60 秒的图。
 *
 * 修复边界（本轮只放宽这一条路径）：
 *   · 异步 run 结果写回：改为按 run.node_id **定向**判定（目标节点是否存在 / 是否被改过），
 *     用**当前** revision 返回结果，不再看整画布 revision；
 *   · 用户编辑/合并的冲突闸（saveCanvas / applyCommand 的 revision 检查）**保持严格**，不放宽；
 *   · 目标节点/画布已不存在 → CANVAS_RUN_TARGET_MISSING，结果留档在 run 记录里（不静默丢）；
 *   · 目标节点被并发改过 → CANVAS_RUN_NODE_CONFLICT（不覆盖用户内容），结果同样留档；
 *   · 幂等：结果留档写一次为准；已终结的 run 再收口不覆盖，也不重复发模型请求。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createResourceFixture } from "./resource-fixtures.mjs";
import { CanvasStore } from "../electron/canvas-store.cjs";
import { CanvasService } from "../electron/canvas-service.cjs";

const IMAGE = { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" };

async function fixture() {
  const fx = await createResourceFixture();
  const store = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const service = new CanvasService({ identity: fx.identity, store, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });
  const context = { sessionRef: fx.sessions.admin, appId: "canvas", source: "ui" };
  const created = service.createCanvas({ context, title: "画布", icon: "🧩" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const verified = fx.identity.validateSession(fx.sessions.admin, { sensitive: false });
  return { fx, store, service, context, canvasId: created.canvas.canvasId, userId: verified.user.id };
}

/** 可控在途的假运行时：模型调用卡在 pending[i] 上，测试自己决定什么时候、以什么结果返回。 */
function fakeRuntime() {
  const pending = [];
  const calls = [];
  const taskEvents = [];
  const taskService = {
    events: taskEvents,
    createTask: () => ({ ok: true, task: { taskId: "task_1", revision: 1 } }),
    startTask: () => ({ ok: true }),
    failTask: () => { taskEvents.push("failTask"); return { ok: true }; },
    completeTask: () => { taskEvents.push("completeTask"); return { ok: true }; },
    requestCancel: () => ({ ok: true }),
    cancelTask: () => ({ ok: true }),
    getTask: () => ({ ok: true, task: { revision: 1, cancelRequested: false, status: "RUNNING" } }),
    getTaskBudget: () => ({ ok: true, remaining: { MODEL_CALLS: 10 }, authorized: {}, consumed: {} }),
    checkModelConfig: () => ({ ok: true }),
    startModelCall: () => ({ ok: true, call: { callId: "call_1" } }),
    completeModelCall: () => ({ ok: true }),
    failModelCall: () => ({ ok: true }),
    recordBudgetConsumption: () => ({ ok: true }),
  };
  const modelService = {
    calls,
    resolveModel: () => ({ ok: true, model: { configId: "m1" } }),
    generateImage: (input) => { calls.push(input); return new Promise((resolve) => pending.push(resolve)); },
    chat: (input) => { calls.push(input); return new Promise((resolve) => pending.push(resolve)); },
  };
  const resolve = (value) => {
    const p = pending.shift();
    if (!p) throw new Error("没有在途模型调用可返回");
    p(value);
    return value;
  };
  return { taskService, modelService, calls, resolve, pendingCount: () => pending.length };
}

function seedGenerator(f, { text = "原始" } = {}) {
  const rev = Number(f.store.boardById(f.canvasId).revision);
  const add = f.service.applyCommand({
    context: f.context, canvasId: f.canvasId, baseRevision: rev,
    command: { type: "node.add", node: { id: "n_gen", type: "generator", x: 10, y: 20, text, model: "rebase-image" } },
  });
  assert.equal(add.ok, true, JSON.stringify(add));
  const addOther = f.service.applyCommand({
    context: f.context, canvasId: f.canvasId, baseRevision: Number(f.store.boardById(f.canvasId).revision),
    command: { type: "node.add", node: { id: "n_other", type: "prompt", x: 200, y: 20, text: "别的节点" } },
  });
  assert.equal(addOther.ok, true, JSON.stringify(addOther));
  return Number(f.store.boardById(f.canvasId).revision);
}

function startImageRun(f) {
  const runtime = fakeRuntime();
  f.service.attachRuntime({ taskService: runtime.taskService, modelService: runtime.modelService });
  const started = f.service.startRun({ context: f.context, canvasId: f.canvasId, nodeId: "n_gen", kind: "image" });
  assert.equal(started.ok, true, JSON.stringify(started));
  return { runtime, run: started };
}

function callImage(f, run) {
  return f.service.modelCall({ context: f.context, canvasId: f.canvasId, runId: run.runId, kind: "image", prompt: "画一只猫" });
}

/* ── 1. 核心：页面自身 pending 落盘推进 revision → 结果不再被丢 ───────────────── */
test("run-rebase · 页面自身 pending 落盘推进整画布 revision 后，异步结果照常写回（不再 CANVAS_CHANGED）", async () => {
  const f = await fixture();
  try {
    seedGenerator(f);
    const { runtime, run } = startImageRun(f);
    const inFlight = callImage(f, run);
    // 模拟画布页：POST 之后把 pending 卡片落盘（新增输出节点 + 保存）→ revision 前进。
    const current = f.service.getCanvas({ context: f.context, canvasId: f.canvasId }).canvas;
    const pendingDoc = {
      nodes: [...current.doc.nodes, { id: "out_1", type: "output", x: 460, y: 20, images: [] }],
      connections: [{ id: "c_1", from: "n_gen", to: "out_1" }],
      viewport: current.doc.viewport,
      logs: [],
    };
    const saved = f.service.saveCanvas({ context: f.context, canvasId: f.canvasId, baseRevision: current.revision, doc: pendingDoc });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.ok(Number(saved.canvas.revision) > Number(run.baseRevision), "pending 落盘必须推进 revision");
    runtime.resolve({ ok: true, images: [{ ...IMAGE }], requestId: "req_1" });

    const res = await inFlight;
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal((res.images || []).length, 1, "结果必须原样返回给画布");
    const after = f.service.runState({ context: f.context, canvasId: f.canvasId, runId: run.runId });
    assert.equal(after.ok, true);
    assert.equal(after.run.status, "RUNNING", "结果写回不再把 run 收成 SUPERSEDED");
    assert.equal(after.run.stopReason, null);
    assert.equal(runtime.calls.length, 1);
  } finally { f.fx.close(); }
});

/* ── 2. 目标节点被删 → 结构化错误 + 结果留档 ─────────────────────────────────── */
test("run-rebase · 目标节点被删除：返回 CANVAS_RUN_TARGET_MISSING，结果留在 run 记录里（不静默丢）", async () => {
  const f = await fixture();
  try {
    seedGenerator(f);
    const { runtime, run } = startImageRun(f);
    const inFlight = callImage(f, run);
    const del = f.service.applyCommand({
      context: f.context, canvasId: f.canvasId, baseRevision: Number(f.store.boardById(f.canvasId).revision),
      command: { type: "node.delete", id: "n_gen" },
    });
    assert.equal(del.ok, true, JSON.stringify(del));
    runtime.resolve({ ok: true, images: [{ ...IMAGE }], requestId: "req_2" });

    const res = await inFlight;
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, "CANVAS_RUN_TARGET_MISSING");
    assert.equal(res.detail.resultAvailable, true, "结果必须留档");
    const state = f.service.runState({ context: f.context, canvasId: f.canvasId, runId: run.runId });
    assert.equal(state.run.status, "SUPERSEDED");
    assert.equal(state.run.stopReason, "CANVAS_RUN_TARGET_MISSING");
    assert.equal(state.run.resultAvailable, true);
    assert.equal(state.run.result.images.length, 1, "留档的结果仍是真图，可被上层提示/恢复");
    // 已终结的 run 再走 runFinish 不得被覆盖，也不重复发模型请求。
    const finished = f.service.finishRun({ context: f.context, canvasId: f.canvasId, runId: run.runId, status: "FAILED" });
    assert.equal(finished.ok, true);
    assert.equal(finished.alreadyFinished, true);
    assert.equal(finished.run.status, "SUPERSEDED");
    assert.ok(runtime.taskService.events.includes("failTask"), "run 已终态时 runFinish 仍必须把 Task 收口（不能泄漏在 RUNNING）");
    const again = await callImage(f, run);
    assert.equal(again.error, "RUN_STOPPED");
    assert.equal(runtime.calls.length, 1, "重放同一 run 不得再发一次模型请求");
  } finally { f.fx.close(); }
});

/* ── 3. 同一节点被并发编辑 → 结构化冲突，不覆盖用户内容 ─────────────────────── */
test("run-rebase · 用户在生成期间编辑同一节点：CANVAS_RUN_NODE_CONFLICT，用户内容保持", async () => {
  const f = await fixture();
  try {
    seedGenerator(f);
    const { runtime, run } = startImageRun(f);
    const inFlight = callImage(f, run);
    const edit = f.service.applyCommand({
      context: f.context, canvasId: f.canvasId, baseRevision: Number(f.store.boardById(f.canvasId).revision),
      command: { type: "node.edit", id: "n_gen", patch: { text: "用户在生成期间改的提示词" } },
    });
    assert.equal(edit.ok, true, JSON.stringify(edit));
    runtime.resolve({ ok: true, images: [{ ...IMAGE }] });

    const res = await inFlight;
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, "CANVAS_RUN_NODE_CONFLICT");
    assert.equal(res.detail.nodeId, "n_gen");
    const doc = f.service.getCanvas({ context: f.context, canvasId: f.canvasId }).canvas.doc;
    assert.equal(doc.nodes.find((n) => n.id === "n_gen").text, "用户在生成期间改的提示词", "冲突时绝不覆盖用户内容");
    const state = f.service.runState({ context: f.context, canvasId: f.canvasId, runId: run.runId });
    assert.equal(state.run.resultAvailable, true, "被拒绝的结果也要留档");
  } finally { f.fx.close(); }
});

/* ── 4. 别的节点被编辑 → 不误伤 ─────────────────────────────────────────────── */
test("run-rebase · 用户编辑的是别的节点：结果照常成功写回", async () => {
  const f = await fixture();
  try {
    seedGenerator(f);
    const { runtime, run } = startImageRun(f);
    const inFlight = callImage(f, run);
    const edit = f.service.applyCommand({
      context: f.context, canvasId: f.canvasId, baseRevision: Number(f.store.boardById(f.canvasId).revision),
      command: { type: "node.edit", id: "n_other", patch: { text: "别的节点被改了" } },
    });
    assert.equal(edit.ok, true, JSON.stringify(edit));
    runtime.resolve({ ok: true, images: [{ ...IMAGE }] });

    const res = await inFlight;
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.images.length, 1);
    assert.equal(res.run.nodeId, "n_gen");
    assert.equal(res.run.rebased, true, "返回当前 revision 与是否发生 rebase");
  } finally { f.fx.close(); }
});

/* ── 5. 整本画布被删 → 结构化错误 + 留档 ───────────────────────────────────── */
test("run-rebase · 画布在生成期间被删：CANVAS_RUN_TARGET_MISSING，结果留档", async () => {
  const f = await fixture();
  try {
    seedGenerator(f);
    const { runtime, run } = startImageRun(f);
    const inFlight = callImage(f, run);
    const trashed = f.service.trashCanvas({ context: f.context, canvasId: f.canvasId });
    assert.equal(trashed.ok, true, JSON.stringify(trashed));
    runtime.resolve({ ok: true, images: [{ ...IMAGE }] });
    const res = await inFlight;
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.error, "CANVAS_RUN_TARGET_MISSING");
    assert.equal(res.detail.reason, "CANVAS_DELETED");
    assert.equal(res.detail.resultAvailable, true);
  } finally { f.fx.close(); }
});

/* ── 6. 幂等：结果留档写一次为准 ───────────────────────────────────────────── */
test("run-rebase · 结果留档幂等：同一 run 重复落档不覆盖、不重复写图", async () => {
  const f = await fixture();
  try {
    seedGenerator(f);
    const { runtime, run } = startImageRun(f);
    const inFlight = callImage(f, run);
    f.service.applyCommand({
      context: f.context, canvasId: f.canvasId, baseRevision: Number(f.store.boardById(f.canvasId).revision),
      command: { type: "node.delete", id: "n_gen" },
    });
    runtime.resolve({ ok: true, images: [{ ...IMAGE }] });
    await inFlight;
    const first = f.store.runResultOf(run.runId);
    assert.equal(first.result.images.length, 1);
    // 再次落档（模拟重放）：第一次为准，图片数不翻倍。
    f.store.recordRunResult({ runId: run.runId, canvasId: f.canvasId, result: { ok: true, images: [{ ...IMAGE }, { ...IMAGE }] }, status: "SUPERSEDED", stopReason: "CANVAS_RUN_TARGET_MISSING" });
    const second = f.store.runResultOf(run.runId);
    assert.equal(second.result.images.length, 1, "同一 run 的留档结果不得被重复写入覆盖");
  } finally { f.fx.close(); }
});

/* ── 7. 回归：用户编辑/合并的冲突闸不放宽 ──────────────────────────────────── */
test("run-rebase · 回归：用户编辑闸保持严格（saveCanvas / applyCommand 过期基准仍 REVISION_CONFLICT）", async () => {
  const f = await fixture();
  try {
    seedGenerator(f);
    const base = Number(f.store.boardById(f.canvasId).revision);
    const doc = f.service.getCanvas({ context: f.context, canvasId: f.canvasId }).canvas.doc;
    // 用当前基准保存成功
    const okSave = f.service.saveCanvas({ context: f.context, canvasId: f.canvasId, baseRevision: base, doc });
    assert.equal(okSave.ok, true, JSON.stringify(okSave));
    // 用过期基准再保存 → 冲突，且带回当前文档
    const stale = f.service.saveCanvas({ context: f.context, canvasId: f.canvasId, baseRevision: base, doc });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "REVISION_CONFLICT");
    // 命令层同样严格
    const staleCmd = f.service.applyCommand({
      context: f.context, canvasId: f.canvasId, baseRevision: base,
      command: { type: "node.edit", id: "n_gen", patch: { text: "过期基准的编辑" } },
    });
    assert.equal(staleCmd.ok, false);
    assert.equal(staleCmd.error, "REVISION_CONFLICT");
  } finally { f.fx.close(); }
});

/* ── 8. 目标快照真的由 startRun 记录（节点粒度判定的前提） ─────────────────── */
test("run-rebase · startRun 为目标节点记录快照；没给 nodeId 时不建节点粒度快照（退化为整本画布仍在）", async () => {
  const f = await fixture();
  try {
    seedGenerator(f);
    const runtime = fakeRuntime();
    f.service.attachRuntime({ taskService: runtime.taskService, modelService: runtime.modelService });
    const withNode = f.service.startRun({ context: f.context, canvasId: f.canvasId, nodeId: "n_gen", kind: "image" });
    assert.equal(withNode.ok, true);
    const snap = f.store.runTargetOf(withNode.runId);
    assert.ok(snap && snap.target, "必须记录目标节点快照");
    assert.equal(snap.target.id, "n_gen");
    const noNode = f.service.startRun({ context: f.context, canvasId: f.canvasId, nodeId: null, kind: "image" });
    assert.equal(noNode.ok, true);
    assert.equal(f.store.runTargetOf(noNode.runId), null);
  } finally { f.fx.close(); }
});
