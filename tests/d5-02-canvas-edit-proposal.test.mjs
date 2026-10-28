/**
 * D5-02 F4 · 「AI 编辑正式链」的 proposal 链在**真实产品装配**上的聚焦回归。
 *
 * 装配与 electron/task-bootstrap.cjs 同源（不是第二套）：
 *   createResourceFixture（真实 D3 身份 / 授权 / 资源）
 *   + CanvasStore + CanvasService（画布命令的唯一权威实例）
 *   + ToolRegistry + createToolAdapters({ canvasService })
 *   + ControlledToolProxy + 真实 SideEffectAuthority + SideEffectRuntime。
 *
 * 这里钉住的产品行为：
 *   · Harness 侧 proposeWrite("canvas.edit") 必须停在 SideEffectCall(AWAITING_APPROVAL)，
 *     proposal 阶段 0 mutation / 0 lease / 0 execution；
 *   · trusted approve 之后走同一条受监督 in-process 执行 + READ_AFTER_WRITE verify 到 SUCCEEDED/PASS。
 * 失败信息必须带真实错误码，便于取证。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createResourceFixture } from "./resource-fixtures.mjs";

const require = (await import("node:module")).createRequire(import.meta.url);
const { CanvasStore } = require("../electron/canvas-store.cjs");
const { CanvasService } = require("../electron/canvas-service.cjs");
const { ToolRegistry } = require("../electron/tool-registry.cjs");
const { ToolStore } = require("../electron/tool-store.cjs");
const { createToolAdapters } = require("../electron/tool-adapters.cjs");
const { TaskStore } = require("../electron/task-store.cjs");
const { TaskService } = require("../electron/task-service.cjs");
const { TaskHarnessOrchestrator } = require("../electron/task-harness-orchestrator.cjs");
const { ControlledToolProxy } = require("../electron/controlled-tool-proxy.cjs");
const { SideEffectStore } = require("../electron/side-effect-store.cjs");
const { SideEffectAuthority } = require("../electron/side-effect-authority.cjs");
const { SideEffectRuntime } = require("../electron/side-effect-runtime.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

const APP_ID = "ai";
const COMMAND = { type: "node.add", node: { id: "ai_n1", type: "prompt", x: 40, y: 60, text: "AI 加的节点" } };

/** 与 electron/canvas-bootstrap.cjs + task-bootstrap.cjs 相同的构造顺序。 */
async function setup() {
  const fx = await createResourceFixture();
  const canvasStore = new CanvasStore({ identity: fx.identity, clock: fx.clock });
  const canvasService = new CanvasService({ identity: fx.identity, store: canvasStore, resourceStore: fx.resourceStore, resourceService: fx.resourceService, authService: fx.authService, clock: fx.clock });
  const toolRegistry = new ToolRegistry();
  const toolStore = new ToolStore({ identity: fx.identity, clock: fx.clock });
  const adapters = createToolAdapters({ resourceService: fx.resourceService, searchService: fx.searchService, canvasService });
  const taskStore = new TaskStore({ identity: fx.identity, clock: fx.clock });
  const taskService = new TaskService({ identity: fx.identity, authService: fx.authService, authStore: fx.store, taskStore, clock: fx.clock });
  const toolProxy = new ControlledToolProxy({ registry: toolRegistry, toolStore, authService: fx.authService, taskStore, taskService, adapters, clock: fx.clock });
  const sideEffectStore = new SideEffectStore({ identity: fx.identity, clock: fx.clock });
  taskService.attachBudgetStores({ toolStore, sideEffectStore });
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d502-proposal-runtime-"));
  const supervisor = new RuntimeSupervisor({ runtimeDir, clock: fx.clock });
  await supervisor.rehydrate();
  const sideEffectAuthority = new SideEffectAuthority({ registry: toolRegistry, sideEffectStore, taskStore, toolStore, authService: fx.authService, adapters, clock: fx.clock, taskService, instanceId: "inst_d502", lifecycle: supervisor });
  const sideEffectRuntime = new SideEffectRuntime({ authority: sideEffectAuthority, supervisor, store: sideEffectStore, taskStore, taskService, toolProxy, registry: toolRegistry, resourceStore: fx.resourceStore, authService: fx.authService, clock: fx.clock });

  const ctx = { sessionRef: fx.sessions.admin, appId: APP_ID, source: "ui" };
  const created = canvasService.createCanvas({ context: ctx, title: "AI 编辑画布" });
  assert.equal(created.ok, true, "画布创建失败：" + JSON.stringify(created));
  const canvasId = created.canvas.canvasId;

  // 与 tool-harness-fixture.dshRunSetup 同一段 Task/Step/Run 生命周期（真实 TaskService）。
  const t = taskService.createTask({ context: ctx, goal: "canvas edit proposal probe" });
  const st = taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  const step = taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: st.task.revision });
  const ss = taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
  const run = taskService.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: ss.task.revision });
  const mr = taskService.markHarnessRunRunning({ context: ctx, taskId: t.task.taskId, runId: run.run.runId, expectedRevision: run.task.revision });
  assert.equal(mr.ok, true, "run 未进入 RUNNING：" + JSON.stringify(mr));

  return {
    fx, ctx, canvasService, canvasId, sideEffectRuntime, sideEffectAuthority, sideEffectStore, toolStore, toolRegistry, adapters, taskStore, taskService,
    run: { taskId: t.task.taskId, stepId: step.step.stepId, runId: run.run.runId },
    grantEdit() { return fx.authService.grantAppToolPermission({ context: fx.adminCtx(), appId: APP_ID, actions: ["tool.canvas.edit"] }); },
    doc() { return canvasService.getCanvas({ context: ctx, canvasId }).canvas; },
    log() { return canvasService.commandLog({ context: ctx, canvasId }); },
    events() { return taskStore.eventsOfTask(t.task.taskId).map((e) => e.event_type); },
    close() { try { supervisor.stop(); } catch { /* ignore */ } fx.close(); try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

test("D5-02 F4 · canvas.edit 合同如实声明幂等能力（verify + 画布命令日志 recovery 已实现）", () => {
  const reg = new ToolRegistry();
  const edit = reg.get("canvas.edit", 1);
  assert.equal(edit.requiresApproval, true);
  assert.equal(edit.approvalPolicy, "ONE_CALL");
  assert.equal(edit.leasePolicy, "SINGLE_ACTIVE");
  assert.equal(edit.riskClass, "REVERSIBLE_WRITE");
  assert.equal(edit.sideEffect, "WRITE");
  assert.equal(edit.executionPolicy, "CONTROLLED_REVERSIBLE_WRITE");
  assert.equal(edit.executionProvider, "CanvasControl");
  assert.deepEqual(edit.requiredPermissions, ["tool.canvas.edit"]);
  // 幂等声明只有在 verify + recovery 真的存在时才是如实的；两者都在 adapter 上。
  assert.equal(edit.verificationStrategy, "READ_AFTER_WRITE");
  assert.equal(edit.idempotencySupport, true, "canvas.edit 已有 READ_AFTER_WRITE + 命令日志 recoveryVerify，必须如实声明幂等支持");
  const adapters = createToolAdapters({ canvasService: {} });
  const provider = adapters.adapterFor({ executionProvider: "CanvasControl", toolId: "canvas.edit" });
  assert.ok(provider, "CanvasControl 必须解析到 adapter");
  for (const fn of ["plan", "execute", "verify", "recoveryVerify"]) assert.equal(typeof provider[fn], "function", "CanvasControl adapter 缺少 " + fn);
});

test("D5-02 F4 · proposeWrite(canvas.edit) → SideEffectCall(AWAITING_APPROVAL)，0 mutation / 0 lease / 0 execution", async () => {
  const s = await setup();
  try {
    const granted = s.grantEdit();
    assert.equal(granted.ok, true, "tool.canvas.edit 授权失败：" + JSON.stringify(granted));
    const before = s.doc();
    const beforeLog = s.log();

    const planned = await s.sideEffectRuntime.proposeWrite({
      context: s.ctx, taskId: s.run.taskId, stepId: s.run.stepId, runId: s.run.runId,
      toolId: "canvas.edit", arguments: { canvasId: s.canvasId, baseRevision: before.revision, command: COMMAND },
    });
    assert.equal(planned.ok, true, "proposeWrite 必须产出 AWAITING_APPROVAL 的 SideEffectCall；实际：" + JSON.stringify({ ok: planned.ok, error: planned.error, decisionStatus: planned.decisionStatus }));

    const call = s.sideEffectStore.callById(planned.approvalRequestId);
    assert.ok(call, "必须持久化 SideEffectCall");
    assert.equal(call.toolId, "canvas.edit");
    assert.equal(call.status, "AWAITING_APPROVAL");
    assert.equal(call.effectClass, "REVERSIBLE_WRITE");
    assert.match(String(call.idempotencyKey), /^idem_/, "idempotencyKey 必须是 OpenArc 生成的绑定");
    assert.equal(call.preconditionsSafe.revision, before.revision, "plan 固定基准版本");

    // 宿主隔离：Harness 只能提议 —— proposal 阶段 0 mutation / 0 lease / 0 execution。
    const after = s.doc();
    assert.equal(after.revision, before.revision, "proposal 阶段 revision 不得前进");
    assert.deepEqual(after.doc.nodes, before.doc.nodes, "proposal 阶段 nodes 不得变化");
    assert.equal(s.log().items.length, beforeLog.items.length, "proposal 阶段不得写入画布命令日志");
    assert.equal(s.sideEffectStore.leasesOfCall(call.callId).length, 0, "proposal 阶段 0 lease");
    assert.equal(s.toolStore.executionsOfTask(s.run.taskId).length, 0, "proposal 阶段 0 execution");
    assert.equal(s.sideEffectStore.callsOfTask(s.run.taskId).length, 1, "SideEffectCall = exactly 1");
    assert.ok(s.events().includes("tool.side_effect.waiting_approval"), "必须有明确 WAITING_APPROVAL 事件：" + JSON.stringify(s.events()));
  } finally { s.close(); }
});

test("D5-02 F4 · trusted approve → 受监督 in-process 执行 → READ_AFTER_WRITE verify → SUCCEEDED/PASS", async () => {
  const s = await setup();
  try {
    s.grantEdit();
    const before = s.doc();
    const planned = await s.sideEffectRuntime.proposeWrite({
      context: s.ctx, taskId: s.run.taskId, stepId: s.run.stepId, runId: s.run.runId,
      toolId: "canvas.edit", arguments: { canvasId: s.canvasId, baseRevision: before.revision, command: COMMAND },
    });
    assert.equal(planned.ok, true, "proposeWrite 必须产出 AWAITING_APPROVAL：" + JSON.stringify(planned));
    const callId = planned.approvalRequestId;
    // 审批只来自 trusted user action（Harness / model / ACP 拿不到这个入口）。
    const approved = s.sideEffectAuthority.approveSideEffect({ context: { sessionRef: s.fx.sessions.admin, source: "user" }, callId });
    assert.equal(approved.ok, true, "trusted approve 失败：" + JSON.stringify(approved));
    const res = await s.sideEffectRuntime.executeApproved({ callId });
    assert.equal(res.ok, true, "受监督执行失败：" + JSON.stringify({ error: res.error, status: res.call && res.call.status }));
    const after = s.sideEffectStore.callById(callId);
    assert.equal(after.status, "SUCCEEDED", JSON.stringify({ status: after.status, errorCode: after.errorCode }));
    assert.equal(after.verificationStatus, "PASS");
    const doc = s.doc();
    assert.equal(doc.revision, before.revision + 1, "revision 只前进一次");
    assert.equal(doc.doc.nodes.length, 1);
    assert.equal(doc.doc.nodes[0].id, "ai_n1");
    assert.equal(doc.doc.nodes[0].text, "AI 加的节点");
    assert.equal(s.log().items[0].actorKind, "AGENT", "AI 路径与手工路径共用同一份命令账本");
    assert.equal(s.sideEffectStore.leasesOfCall(callId).length, 1, "execution lease = exactly 1");
    assert.equal(s.sideEffectStore.leasesOfCall(callId).filter((l) => l.status === "ACTIVE").length, 0);
    assert.equal(s.sideEffectStore.callsOfTask(s.run.taskId).length, 1, "0 second call / 0 retry");
  } finally { s.close(); }
});

test("D5-02 F4 · 没有 tool.canvas.edit 权限时绝不产生 SideEffectCall（权限门仍在最前）", async () => {
  const s = await setup();
  try {
    const planned = await s.sideEffectRuntime.proposeWrite({
      context: s.ctx, taskId: s.run.taskId, stepId: s.run.stepId, runId: s.run.runId,
      toolId: "canvas.edit", arguments: { canvasId: s.canvasId, baseRevision: 1, command: COMMAND },
    });
    assert.equal(planned.ok, false, "未授权不得产生 call：" + JSON.stringify(planned));
    assert.equal(s.sideEffectStore.callsOfTask(s.run.taskId).length, 0, "0 SideEffectCall");
    const after = s.doc();
    assert.equal(after.revision, 1, "0 mutation");
    assert.equal(after.doc.nodes.length, 0, "0 mutation");
  } finally { s.close(); }
});

test("1A · 可信拒绝只收敛本次提案，绝不执行画布写入", async () => {
  const s = await setup();
  try {
    s.grantEdit();
    const planned = await s.sideEffectRuntime.proposeWrite({ context: s.ctx, ...s.run, toolId: "canvas.edit", arguments: { canvasId: s.canvasId, baseRevision: 1, command: COMMAND } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const denied = s.sideEffectAuthority.denySideEffect({ context: { sessionRef: s.fx.sessions.admin, source: "user" }, callId: planned.approvalRequestId });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    const executed = await s.sideEffectRuntime.executeApproved({ callId: planned.approvalRequestId });
    assert.equal(executed.ok, false);
    assert.equal(s.sideEffectStore.callById(planned.approvalRequestId).status, "BLOCKED");
    assert.equal(s.doc().revision, 1);
    assert.equal(s.doc().doc.nodes.length, 0);
  } finally { s.close(); }
});

test("1A · 重复提案与重复执行去重，revision 和命令日志只前进一次", async () => {
  const s = await setup();
  try {
    s.grantEdit();
    const input = { context: s.ctx, ...s.run, toolId: "canvas.edit", arguments: { canvasId: s.canvasId, baseRevision: 1, command: COMMAND } };
    const first = await s.sideEffectRuntime.proposeWrite(input);
    const duplicateProposal = await s.sideEffectRuntime.proposeWrite(input);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(duplicateProposal.duplicate, true);
    assert.equal(duplicateProposal.approvalRequestId, first.approvalRequestId);
    assert.equal(s.sideEffectStore.callsOfTask(s.run.taskId).length, 1);
    s.sideEffectAuthority.approveSideEffect({ context: { sessionRef: s.fx.sessions.admin, source: "user" }, callId: first.approvalRequestId });
    const executed = await s.sideEffectRuntime.executeApproved({ callId: first.approvalRequestId });
    const repeated = await s.sideEffectRuntime.executeApproved({ callId: first.approvalRequestId });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.duplicate, true);
    assert.equal(s.doc().revision, 2);
    assert.equal(s.doc().doc.nodes.length, 1);
    assert.equal(s.log().items.length, 1);
  } finally { s.close(); }
});

test("1A · 批准后 baseRevision 冲突保留用户编辑，AI 旧提案不覆盖", async () => {
  const s = await setup();
  try {
    s.grantEdit();
    const planned = await s.sideEffectRuntime.proposeWrite({ context: s.ctx, ...s.run, toolId: "canvas.edit", arguments: { canvasId: s.canvasId, baseRevision: 1, command: COMMAND } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const user = s.canvasService.applyCommand({ context: s.ctx, canvasId: s.canvasId, baseRevision: 1, command: { type: "node.add", node: { id: "user_n1", type: "prompt", text: "用户并发编辑" } }, actorKind: "USER" });
    assert.equal(user.ok, true, JSON.stringify(user));
    s.sideEffectAuthority.approveSideEffect({ context: { sessionRef: s.fx.sessions.admin, source: "user" }, callId: planned.approvalRequestId });
    const executed = await s.sideEffectRuntime.executeApproved({ callId: planned.approvalRequestId });
    assert.equal(executed.ok, false, JSON.stringify(executed));
    assert.equal(s.doc().revision, 2);
    assert.deepEqual(s.doc().doc.nodes.map((n) => n.id), ["user_n1"]);
    assert.equal(s.doc().doc.nodes[0].text, "用户并发编辑");
  } finally { s.close(); }
});

test("1A · 停止任务后后续 canvas.edit 提案被拒绝且零新增写入", async () => {
  const s = await setup();
  try {
    s.grantEdit();
    const first = await s.sideEffectRuntime.proposeWrite({ context: s.ctx, ...s.run, toolId: "canvas.edit", arguments: { canvasId: s.canvasId, baseRevision: 1, command: COMMAND } });
    assert.equal(first.ok, true, JSON.stringify(first));
    s.sideEffectAuthority.approveSideEffect({ context: { sessionRef: s.fx.sessions.admin, source: "user" }, callId: first.approvalRequestId });
    assert.equal((await s.sideEffectRuntime.executeApproved({ callId: first.approvalRequestId })).ok, true);
    const task = s.taskStore.taskById(s.run.taskId);
    const cancelled = s.taskService.cancelTask({ context: s.ctx, taskId: s.run.taskId, expectedRevision: task.revision });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const second = await s.sideEffectRuntime.proposeWrite({ context: s.ctx, ...s.run, toolId: "canvas.edit", arguments: { canvasId: s.canvasId, baseRevision: 2, command: { type: "node.add", node: { id: "ai_n2", type: "prompt", text: "不应执行" } } } });
    assert.equal(second.ok, false, JSON.stringify(second));
    assert.equal(s.sideEffectStore.callsOfTask(s.run.taskId).length, 1);
    assert.equal(s.doc().revision, 2);
    assert.deepEqual(s.doc().doc.nodes.map((n) => n.id), ["ai_n1"]);
  } finally { s.close(); }
});

test("1A · 等待审批时 cancel 同步收敛 pending call，不能再次批准执行", async () => {
  const s = await setup();
  try {
    s.grantEdit();
    const planned = await s.sideEffectRuntime.proposeWrite({ context: s.ctx, ...s.run, toolId: "canvas.edit", arguments: { canvasId: s.canvasId, baseRevision: 1, command: COMMAND } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const orchestrator = new TaskHarnessOrchestrator({ taskService: s.taskService, sideEffectRuntime: s.sideEffectRuntime });
    const task = s.taskStore.taskById(s.run.taskId);
    const cancelled = await orchestrator.cancel({ context: s.ctx, taskId: s.run.taskId, expectedRevision: task.revision });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const call = s.sideEffectStore.callById(planned.approvalRequestId);
    assert.equal(call.status, "BLOCKED");
    assert.equal(call.errorCode, "TASK_CANCELLED");
    assert.equal(s.sideEffectStore.leasesOfCall(call.callId).length, 0);
    assert.equal(s.doc().revision, 1);
    assert.equal(s.doc().doc.nodes.length, 0);
    const late = s.sideEffectAuthority.approveSideEffect({ context: { sessionRef: s.fx.sessions.admin, source: "user" }, callId: call.callId });
    assert.equal(late.ok, false, "取消后的 pending 不得恢复可执行");
  } finally { s.close(); }
});
