/**
 * D4-05 · S1（明确 WRITE 被拒）——official dsh facade 正式链的「拒绝假成功」闸门。
 *
 * 真实链路（无 synthetic ACP agent / 无 dshArgs）：
 *   TaskHarnessOrchestrator → HarnessAdapter(official dsh) → ACP → 受控 plugin
 *   → ToolFacadeBridge → ControlledToolProxy.propose（持久化 proposal + DENIED decision）
 *   → final text 通过 → orchestrator 以后端记录为准，拒绝「明确 WRITE 被拒但 final text 通过」的假成功。
 *
 * 边界：READ_ONLY 的拒绝 / 普通执行错误绝不参与；同 tool + 同 canonical arguments 的后续真实成功
 * 才解决旧拒绝。旧 DENIED 记录只追加只读投影，绝不删除 / 改写。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
import { createSideEffectFixture, TRASH_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";

const require = createRequire(import.meta.url);
const { registerTaskIpc } = require("../electron/task-bootstrap.cjs");

const FINAL = "OPENARC_DSH_TOOL_OK";
const TRASH = "resource.trash";
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });
const waitFor = async (fn, ms, detail) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return true; await sleep(25); }
  assert.fail("waitFor 超时：" + detail);
};

/** 真实 facade WRITE 场景：resource 级授权存在，app TOOL grant 由调用方决定。 */
async function setupFacade({ grantTrash = false, plan = null, facadeWriteToolIds = [TRASH], dbOpts = {} } = {}) {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeWriteToolIds, ...dbOpts });
  const created = await fx.createResource("Denied Write Target");
  const resourceRef = created.resource.resourceRef;
  const resourceId = created.resource.resourceId;
  assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.delete"] }).ok, true, "app resource.delete grant");
  assert.equal(fx.grantUserResource(resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true, "user resource.delete + useByAgent grant");
  if (grantTrash) assert.equal(fx.grantTool("ai", ["tool.resource.trash"]).ok, true, "TOOL grant");
  fx.fp.state.toolLoopPlan = plan || [{ id: "call_trash_1", name: "resource_trash", args: { resourceRef } }];
  const ctx = fx.ctx();
  const createdTask = fx.createTask();
  const orch = fx.makeDshOrchestrator();
  return { fx, created, resourceRef, resourceId, ctx, task: createdTask.task, orch };
}

const trashed = (s) => s.fx.f.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed;
const userCtx = (s) => ({ sessionRef: s.fx.f.sessions.admin, appId: "ai", source: "user" });

async function runFacade(s) {
  const r = await s.orch.runTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: s.task.revision, verify: { type: "EXACT_TEXT", expected: FINAL } });
  const taskId = s.task.taskId;
  return {
    r, taskId,
    task: s.fx.taskStore.taskById(taskId),
    steps: s.fx.taskStore.stepsOfTask(taskId),
    execs: s.fx.toolStore.executionsOfTask(taskId),
    proposals: s.fx.toolStore.proposalsOfTask(taskId),
    decisions: s.fx.toolStore.decisionsOfTask(taskId),
    calls: s.fx.sideEffectStore.callsOfTask(taskId),
    events: s.fx.taskStore.eventsOfTask(taskId).map((e) => e.event_type),
    artifacts: s.fx.taskStore.artifactsOfTask(taskId),
  };
}

/** 经真实产品 registerTaskIpc → task/get 读取 safe deniedOperations 投影。 */
async function callTaskGet(s, taskId) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: () => {} };
  registerTaskIpc({ ipcMain, taskService: s.fx.taskService, orchestrator: {}, identity: { current: s.fx.f.sessions.admin }, isTrusted: () => true, hostAppId: "ai" });
  return handlers.get("task:command")({}, { command: "task/get", payload: { taskId } });
}

test("D4-05 S1 明确 WRITE 被拒 · 无 TOOL grant → DENIED/TOOL_APP_NOT_GRANTED + final text 拒绝假成功（BLOCKED / 0 mutation / 0 call）", async () => {
  const s = await setupFacade();
  try {
    const out = await runFacade(s);

    // 后端确实把「明确 WRITE」判为 DENIED 并持久化证据。
    assert.equal(out.decisions.length, 1, "恰好 1 条 decision：" + out.decisions.length);
    assert.equal(out.decisions[0].decision, "DENIED");
    assert.equal(out.decisions[0].reason_code, "TOOL_APP_NOT_GRANTED");
    assert.equal(out.decisions[0].risk_class, "REVERSIBLE_WRITE");
    assert.equal(out.proposals.length, 1, "恰好 1 个 proposal");
    assert.equal(out.proposals[0].tool_id, TRASH);
    assert.equal(out.proposals[0].status, "DENIED");

    // 被拒 = 0 执行 / 0 side-effect call / 0 mutation。
    assert.equal(out.execs.length, 0, "WRITE 被拒 0 tool_execution");
    assert.equal(out.calls.length, 0, "WRITE 被拒 0 SideEffectCall");
    assert.equal(trashed(s), false, "WRITE 被拒 0 mutation");

    // final text 已通过，但绝不能 SUCCEEDED。
    assert.equal(out.r.ok, false, "明确 WRITE 被拒后不得成功");
    assert.equal(out.r.error, "TOOL_APP_NOT_GRANTED", "停因必须是真实 reasonCode：" + out.r.error);
    assert.equal(out.task.status, "BLOCKED", "Task 必须 BLOCKED：" + out.task.status);
    assert.equal(out.steps[0].status, "BLOCKED", "Step 必须 BLOCKED");
    assert.equal(out.artifacts.length, 0, "0 Artifact");
    assert.ok(out.events.includes("tool.denied"), "必须留下 tool.denied 证据：" + JSON.stringify(out.events));
    assert.ok(!out.events.includes("task.succeeded"), "绝不 task.succeeded");

    // safe 服务投影。
    const denied = s.fx.taskService.getDeniedRequiredWriteOperations({ context: s.ctx, taskId: out.taskId });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    assert.equal(denied.unresolved.length, 1, JSON.stringify(denied));
    assert.equal(denied.resolved.length, 0);
    assert.equal(denied.denials.length, 1, "拒绝记录保留");
    const op = denied.unresolved[0];
    assert.equal(op.toolId, TRASH);
    assert.equal(op.reasonCode, "TOOL_APP_NOT_GRANTED");
    assert.equal(op.riskClass, "REVERSIBLE_WRITE");
    assert.ok(op.proposalId, "带 proposalId");
    assert.equal(op.stepId, out.steps[0].step_id, "关联 step");
    assert.ok(op.runId, "关联 run");
    assert.deepEqual(op.arguments, { resourceRef: s.resourceRef }, "arguments 只做有界 safe 投影");
    assert.equal(Object.prototype.hasOwnProperty.call(op, "rawArguments"), false);

    // task/get.deniedOperations 含该操作，且无敏感字段。
    const got = await callTaskGet(s, out.taskId);
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.deniedOperations.length, 1, JSON.stringify(got.deniedOperations));
    assert.equal(got.deniedOperations[0].toolId, TRASH);
    assert.equal(got.deniedOperations[0].reasonCode, "TOOL_APP_NOT_GRANTED");
    assert.equal(got.deniedOperations[0].target || got.deniedOperations[0].arguments.resourceRef, s.resourceRef);
    const serialized = JSON.stringify(got.deniedOperations);
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders\/|mpx_|tpx_|Bearer /.test(serialized), "无敏感字段：" + serialized);
  } finally { await s.fx.close(); }
});

test("D4-05 S1 明确 WRITE 正对照 · 有 TOOL grant + 批准 → WRITE 成功 / Task SUCCEEDED（不回归）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa5s1-write-ok-"));
  let s = null;
  try {
    s = await setupFacade({ grantTrash: true, dbOpts: { dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), keepData: true, sideEffectRuntimeDir: path.join(root, "runtime") } });
    const runPromise = s.orch.runTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: s.task.revision, verify: { type: "EXACT_TEXT", expected: FINAL } });
    await waitFor(() => s.fx.sideEffectStore.callsOfTask(s.task.taskId).length === 1, 60000, "SideEffectCall 未出现");
    const call = s.fx.sideEffectStore.callsOfTask(s.task.taskId)[0];
    assert.equal(call.status, "AWAITING_APPROVAL");
    assert.equal(trashed(s), false, "proposal 阶段 0 mutation");
    assert.equal(s.fx.sideEffectRuntime.decideApproval({ context: userCtx(s), approvalRequestId: call.callId, decision: "APPROVE" }).ok, true);
    const r = await runPromise;

    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.equal(trashed(s), true, "mutation = 1");
    assert.equal(s.fx.sideEffectStore.callsOfTask(s.task.taskId)[0].status, "SUCCEEDED");
    const decisions = s.fx.toolStore.decisionsOfTask(s.task.taskId);
    assert.ok(decisions.length >= 1 && decisions.every((d) => d.decision !== "DENIED"), "无 DENIED decision：" + JSON.stringify(decisions));
    const denied = s.fx.taskService.getDeniedRequiredWriteOperations({ context: s.ctx, taskId: s.task.taskId });
    assert.equal(denied.unresolved.length, 0, JSON.stringify(denied));
    assert.equal(denied.denials.length, 0, JSON.stringify(denied));
  } finally {
    try { if (s) await s.fx.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("D4-05 S1 READ_ONLY 拒绝不阻断 · resource.search 无 grant → DENIED 但不整体失败", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.fp.state.toolLoopPlan = [{ id: "call_search_1", name: "resource_search", args: { query: "OPENARC_DSH_VISIBLE_RESOURCE", limit: 5 } }];
    const ctx = fx.ctx();
    const createdTask = fx.createTask();
    const orch = fx.makeDshOrchestrator();
    const r = await orch.runTask({ context: ctx, taskId: createdTask.task.taskId, expectedRevision: createdTask.task.revision, verify: { type: "EXACT_TEXT", expected: FINAL } });

    const decisions = fx.toolStore.decisionsOfTask(createdTask.task.taskId);
    assert.equal(decisions.length, 1, JSON.stringify(decisions));
    assert.equal(decisions[0].decision, "DENIED");
    assert.equal(decisions[0].reason_code, "TOOL_APP_NOT_GRANTED");
    assert.equal(decisions[0].risk_class, "READ_ONLY");

    const denied = fx.taskService.getDeniedRequiredWriteOperations({ context: ctx, taskId: createdTask.task.taskId });
    assert.equal(denied.denials.length, 0, "READ_ONLY 拒绝不进 denials：" + JSON.stringify(denied));
    assert.equal(denied.unresolved.length, 0, "READ_ONLY 拒绝不参与闸门");

    assert.equal(r.ok, true, "READ_ONLY 拒绝仍按既有语义不整体失败：" + JSON.stringify(r.error));
    assert.equal(r.task.status, "SUCCEEDED", "Task 仍 SUCCEEDED");
    assert.equal(fx.taskStore.artifactsOfTask(createdTask.task.taskId).length, 1);
  } finally { await fx.close(); }
});

test("D4-05 S1 解决语义 · 同 tool+args 先 DENIED 后真实成功 → 允许成功且旧 DENIED 记录保留", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa5s1-resolve-"));
  let sf = null;
  try {
    sf = await createSideEffectFixture({ dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), keepData: true, sideEffectRuntimeDir: path.join(root, "runtime") });
    const created = await sf.createResource("Resolution Target");
    const resourceRef = created.resource.resourceRef;
    const resourceId = created.resource.resourceId;
    assert.equal(sf.authService.grantAppResourcePermission({ context: sf.fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(sf.grantUserResource(resourceId, sf.fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);
    const run = sf.setupRun();
    const args = { resourceRef };

    const first = sf.toolProxy.propose({ context: sf.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, toolVersion: 1, arguments: args });
    assert.equal(first.decisionStatus, "DENIED", JSON.stringify(first));
    assert.equal(first.reasonCode, "TOOL_APP_NOT_GRANTED");
    let denied = sf.taskService.getDeniedRequiredWriteOperations({ context: sf.ctx(), taskId: run.taskId });
    assert.equal(denied.unresolved.length, 1, JSON.stringify(denied));
    assert.equal(denied.denials.length, 1);
    assert.deepEqual(denied.unresolved[0].arguments, { resourceRef });

    assert.equal(sf.grantTool("ai", ["tool.resource.trash"]).ok, true);
    await sleep(5);
    const second = sf.toolProxy.propose({ context: sf.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, toolVersion: 1, arguments: args });
    assert.equal(second.decisionStatus, "APPROVAL_REQUIRED", JSON.stringify(second));
    const plan = await sf.authority.planSideEffect({ context: sf.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, arguments: args, proposalId: second.proposal.proposalId, decisionId: second.decision.decisionId });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(sf.approve(plan.call.callId).ok, true);
    const lease = sf.lease(plan.call.callId);
    assert.equal(lease.ok, true, JSON.stringify(lease));
    const exec = await sf.authority.executeSideEffect({ callId: plan.call.callId, leaseId: lease.lease.leaseId, holderId: lease.lease.holderId, holderInstanceId: lease.lease.holderInstanceId });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(exec.call.status, "SUCCEEDED");
    assert.equal(exec.call.verificationStatus, "PASS");

    denied = sf.taskService.getDeniedRequiredWriteOperations({ context: sf.ctx(), taskId: run.taskId });
    assert.equal(denied.unresolved.length, 0, "同 tool+args 真实成功 → 解决：" + JSON.stringify(denied));
    assert.equal(denied.resolved.length, 1, JSON.stringify(denied));
    assert.equal(denied.denials.length, 1, "旧 DENIED 记录保留，绝不删除");
    assert.equal(denied.resolved[0].proposalId, first.proposal.proposalId, "解决的是原拒绝");
    assert.equal(denied.resolved[0].resolvedBy.kind, "SIDE_EFFECT_CALL");
  } finally {
    try { if (sf) await sf.fx.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
