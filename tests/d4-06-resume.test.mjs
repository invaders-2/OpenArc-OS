/**
 * D4-06 Closure · 预算停止后的显式续接（真实产品 TaskHarnessOrchestrator / TaskService）。
 *
 * 只解禁一种 Explicit Resume：因 bounded 预算耗尽停止、且不存在未决副作用的 task。
 * 覆盖 A/B/C/D/E/F 中可在 Node 验证的部分；Electron 真实 UI 路径见 tests/d4-06-resume-ui.mjs。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createToolHarnessFixture, reopenToolHarnessRuntime } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { TaskService } = require("../electron/task-service.cjs");
const { TaskHarnessOrchestrator } = require("../electron/task-harness-orchestrator.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");
const GATED_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "supervised-executor.mjs");

const sha256 = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (fn, ms, detail) => (async () => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();
const searchSeq = (n, prefix) => Array.from({ length: n }, (_, i) => ({ toolId: "resource.search", toolVersion: 1, arguments: { query: prefix + "-" + i, limit: 3 }, proposalId: "tc_" + prefix + "_" + i }));
const grantEventsOf = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "task.budget.granted");
const budgetStopEventsOf = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "task.budget_exhausted");

/** synthetic ACP 路径：step0 成功（Artifact）+ step1 轮次预算停止（TOOL_ROUNDS）。 */
async function setupSyntheticBudgetStop(fx) {
  fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
  const ctx = fx.ctx();
  const t = fx.createTask();
  const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  const s0 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { proposeSequence: [], finalText: "OPENARC_TASK_OK" }, expectedRevision: started.task.revision });
  const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { proposeSequence: searchSeq(5, "stop"), finalText: "OPENARC_TASK_OK" }, expectedRevision: s0.task.revision });
  const ss0 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: s1.task.revision });
  const orch = fx.makeToolOrchestrator();
  const r0 = await orch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: s0.step.input, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });
  assert.equal(r0.ok, true, "step0 必须成功：" + JSON.stringify(r0.error));
  const fresh = fx.taskStore.taskById(t.task.taskId);
  const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fresh.revision });
  const r1 = await orch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: s1.step.input, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "BUDGET_EXHAUSTED");
  return { ctx, taskId: t.task.taskId, step0: s0.step, step1: s1.step, orch };
}

/** 真实 dsh 路径：step0 成功（Artifact）+ step1 MODEL_CALLS 预算停止（12 个受控 READ 计划）。 */
async function setupDshBudgetStop(fx, { priorWrite = null } = {}) {
  fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
  const ctx = fx.ctx();
  const t = fx.createTask();
  const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  const s0 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
  const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s0.task.revision });
  const ss0 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: s1.task.revision });
  const dsh = fx.makeDshOrchestrator();
  fx.fp.state.toolLoopPlan = priorWrite ? [{ id: "call_prior_write", name: "resource_trash", args: { resourceRef: priorWrite } }] : [];
  const r0 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
  if (priorWrite) {
    await waitFor(() => fx.sideEffectStore.callsOfTask(t.task.taskId).length === 1, 60000, "prior SideEffectCall 未出现");
    const c = fx.sideEffectStore.callsOfTask(t.task.taskId)[0];
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: c.callId, decision: "APPROVE" }).ok, true);
  }
  assert.equal(r0.ok, true, "step0 必须成功：" + JSON.stringify(r0.error));
  const fresh = fx.taskStore.taskById(t.task.taskId);
  const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fresh.revision });
  fx.fp.state.toolLoopPlan = Array.from({ length: 12 }, (_, i) => ({ id: "call_b" + i, name: "resource_search", args: { query: "b-" + i, limit: 5 } }));
  const r1 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
  assert.equal(r1.ok, false, "step1 必须预算停止：" + JSON.stringify(r1.ok));
  assert.equal(r1.error, "BUDGET_EXHAUSTED");
  return { ctx, taskId: t.task.taskId, step0: s0.step, step1: s1.step, dsh };
}

/* ============================================================ A + F（Node 部分） */
test("D4-06 Closure A/F · 预算停止 → 后端判定可续接 → 新 step 续接成功；副作用恰好一次、不重放、账本/关联链正确", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d406r-a-"));
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), keepData: true,
    sideEffectRuntimeDir: path.join(root, "runtime"), sideEffectApprovalWaitMs: 60000, facadeWriteToolIds: ["resource.trash"],
  });
  try {
    const created = await fx.createResource("D406R Target");
    const resourceRef = created.resource.resourceRef;
    const resourceId = created.resource.resourceId;
    fx.grantTool("ai", ["tool.resource.trash", "tool.resource.search", "tool.resource.readMetadata"]);
    assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(fx.grantUserResource(resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);

    const ctx = fx.ctx();
    const t = fx.createTask();
    const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const s2 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { proposeSequence: searchSeq(5, "budget"), finalText: "OPENARC_TASK_OK" }, expectedRevision: s1.task.revision });
    const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: s2.task.revision });

    // step1：真实 official dsh + Tool Facade + 受控 WRITE + 真实 approval → 真实副作用。
    fx.fp.state.toolLoopPlan = [{ id: "call_a_trash", name: "resource_trash", args: { resourceRef } }];
    const dsh = fx.makeDshOrchestrator();
    const p1 = dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    await waitFor(() => fx.sideEffectStore.callsOfTask(t.task.taskId).length === 1, 60000, "SideEffectCall 未出现");
    const call = fx.sideEffectStore.callsOfTask(t.task.taskId)[0];
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: call.callId, decision: "APPROVE" }).ok, true);
    const r1 = await p1;
    assert.equal(r1.ok, true, "step1 WRITE 必须成功：" + JSON.stringify(r1.error));
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, true);

    // step2：synthetic 轮次预算停止。
    const fresh = fx.taskStore.taskById(t.task.taskId);
    const ss2 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: fresh.revision });
    const toolOrch = fx.makeToolOrchestrator();
    const r2 = await toolOrch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: ss2.task.revision, stepInput: s2.step.input, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });
    assert.equal(r2.error, "BUDGET_EXHAUSTED");
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "BLOCKED");
    const stopEv = budgetStopEventsOf(fx, t.task.taskId);
    assert.equal(stopEv.length, 1);
    assert.equal(JSON.parse(stopEv[0].safe_payload).kind, "TOOL_ROUNDS");

    // 后端判定可续接（不信 renderer）。
    const elig = fx.taskService.getResumeEligibility({ context: ctx, taskId: t.task.taskId });
    assert.equal(elig.ok, true);
    assert.equal(elig.resumable, true, JSON.stringify(elig));
    assert.equal(elig.kind, "TOOL_ROUNDS");
    assert.equal(elig.resumeIndex, 1);
    assert.equal(elig.maxResumes, 3);
    assert.equal(elig.stopReason, "BUDGET_EXHAUSTED");

    // 刷新恢复（F）：同一持久层上新建 TaskService，仍可判定可续接且账本一致。
    const fresh2 = new TaskService({ identity: fx.f.identity, authService: fx.f.authService, authStore: fx.f.store, taskStore: fx.taskStore, modelService: fx.f.modelService, clock: fx.f.clock });
    fresh2.attachBudgetStores({ toolStore: fx.toolStore, sideEffectStore: fx.sideEffectStore });
    const eligReload = fresh2.getResumeEligibility({ context: ctx, taskId: t.task.taskId });
    assert.equal(eligReload.resumable, true, "刷新后仍可续接");
    const ledgerReload = fresh2.getBudgetLedger({ context: ctx, taskId: t.task.taskId }).ledger;
    assert.equal(ledgerReload.resumeCount, 0);
    assert.equal(ledgerReload.base.TOOL_ROUNDS, 4);

    const step1Artifact = fx.taskStore.artifactsOfTask(t.task.taskId).find((a) => a.step_id === s1.step.stepId);
    assert.ok(step1Artifact, "step1 必须有 Artifact");
    const callsBefore = fx.sideEffectStore.callsOfTask(t.task.taskId);
    const execBefore = fx.toolStore.executionsOfTask(t.task.taskId).length;
    const revision = fx.taskStore.taskById(t.task.taskId).revision;

    // 续接：新 step + 新 run；不重放旧 tool 请求。
    const res = await toolOrch.resumeBudgetExhausted({ context: ctx, taskId: t.task.taskId, expectedRevision: revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });
    assert.equal(res.ok, true, "续接必须成功：" + JSON.stringify(res.error));
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "SUCCEEDED");

    // 已成功副作用恰好一次，绝不重复执行。
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, true);
    assert.equal(fx.sideEffectStore.callsOfTask(t.task.taskId).length, callsBefore.length, "0 新 SideEffectCall");
    assert.equal(fx.sideEffectStore.callById(call.callId).status, "SUCCEEDED");
    assert.equal(fx.sideEffectStore.leasesOfCall(call.callId).filter((l) => l.status === "ACTIVE").length, 0, "0 active lease");

    // 新 step 携带 continuation（prior artifact 文本）；旧 step/artifact/verification 保留。
    const steps = fx.taskStore.stepsOfTask(t.task.taskId);
    assert.equal(steps.length, 3);
    const resumed = steps[2];
    assert.equal(resumed.kind, "reasoning");
    assert.equal(resumed.status, "SUCCEEDED");
    const continuation = JSON.parse(resumed.input);
    assert.equal(continuation.continuation, true);
    assert.equal(continuation.budgetKind, "TOOL_ROUNDS");
    assert.equal(continuation.resumeIndex, 1);
    assert.equal(continuation.fromStepId, s2.step.stepId);
    assert.ok(continuation.priorArtifacts.some((a) => a.artifactId === step1Artifact.artifact_id), "continuation 必须含 prior artifact 文本");
    assert.ok(!("proposeSequence" in continuation) && !("proposeTool" in continuation), "continuation 绝不携带旧 tool 请求");
    assert.equal(fx.toolStore.executionsOfTask(t.task.taskId).filter((e) => e.step_id === resumed.step_id).length, 0, "续接 step 不得执行任何 tool（不重放）");
    assert.equal(fx.toolStore.executionsOfTask(t.task.taskId).length, execBefore, "旧 execution 保留且无新增");
    const artifacts = fx.taskStore.artifactsOfTask(t.task.taskId);
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts.filter((a) => a.step_id === s1.step.stepId).length, 1, "step1 Artifact 保留");
    assert.equal(artifacts.filter((a) => a.step_id === resumed.step_id).length, 1);
    assert.equal(artifacts.find((a) => a.step_id === s1.step.stepId).checksum, sha256(step1Artifact.safe_content));
    const verifs = fx.taskStore.verificationsOfTask(t.task.taskId);
    assert.equal(verifs.length, 2, "两条 Artifact 各有 Verification");
    assert.ok(verifs.every((v) => artifacts.some((a) => a.artifact_id === v.artifact_id)));

    // 预算账本：base + additions + resumeCount + consumed，历史消费保留。
    const ledger = fx.taskService.getBudgetLedger({ context: ctx, taskId: t.task.taskId }).ledger;
    assert.equal(ledger.resumeCount, 1);
    assert.equal(ledger.additions.length, 1);
    assert.equal(ledger.additions[0].kind, "TOOL_ROUNDS");
    assert.equal(ledger.additions[0].amount, 4);
    assert.equal(ledger.additions[0].operatorUserId, fx.f.users.admin);
    assert.ok(ledger.additions[0].consumedAtGrant && ledger.additions[0].consumedAtGrant.toolExecutions === execBefore, "consumedAtGrant 保留续接前消耗");
    assert.equal(ledger.consumed.toolExecutions, execBefore, "consumed 真实反映已发生执行");
    assert.equal(ledger.consumed.budgetStops.length, 1);
    assert.equal(ledger.resumable, false, "SUCCEEDED 不可续接");
    assert.equal(grantEventsOf(fx, t.task.taskId).length, 1, "只追加一次预算");

    // 其他 Explicit Resume 场景仍 DEFERRED。
    const deferred = await toolOrch.resume();
    assert.equal(deferred.ok, false);
    assert.equal(deferred.error, "EXPLICIT_RESUME_DEFERRED");
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/* ============================================================ B */
test("D4-06 Closure B · 续接后再次达到预算 → 再次停止，无额外调度、只追加一次预算", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const h = await setupDshBudgetStop(fx);
    const before = {
      runs: fx.taskStore.harnessRunsOfTask(h.taskId).length,
      stops: budgetStopEventsOf(fx, h.taskId).length,
    };
    assert.equal(before.stops, 1);
    const revision = fx.taskStore.taskById(h.taskId).revision;
    const rr = await h.dsh.resumeBudgetExhausted({ context: h.ctx, taskId: h.taskId, expectedRevision: revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    assert.equal(rr.ok, false, "续接后再次预算停止，不得 SUCCEEDED");
    assert.equal(rr.error, "BUDGET_EXHAUSTED");
    assert.equal(fx.taskStore.taskById(h.taskId).status, "BLOCKED");
    assert.equal(fx.taskStore.stepsOfTask(h.taskId).filter((s) => s.status === "BLOCKED").length, 2, "旧 step 与新 step 都 BLOCKED");
    assert.equal(fx.taskStore.harnessRunsOfTask(h.taskId).length, before.runs + 1, "只多一个 run（无额外调度）");
    assert.equal(budgetStopEventsOf(fx, h.taskId).length, before.stops + 1, "预算停止事件恰好 +1");
    assert.equal(grantEventsOf(fx, h.taskId).length, 1, "只追加一次预算");
    const elig = fx.taskService.getResumeEligibility({ context: h.ctx, taskId: h.taskId });
    assert.equal(elig.resumable, true);
    assert.equal(elig.resumeIndex, 2, "下一次续接序号 = 2");
    assert.equal(elig.remainingResumes, 2);
    assert.equal(fx.taskStore.harnessRunsOfTask(h.taskId).every((r) => r.status !== "RUNNING" && r.status !== "STARTING"), true);
  } finally { await fx.close(); }
});

/* ============================================================ C */
test("D4-06 Closure C · 重复点击 / 并发请求 → 一次有效续接、一次预算追加", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const h = await setupSyntheticBudgetStop(fx);
    const revision = fx.taskStore.taskById(h.taskId).revision;
    const args = { context: h.ctx, taskId: h.taskId, expectedRevision: revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } };
    const results = await Promise.all([h.orch.resumeBudgetExhausted(args), h.orch.resumeBudgetExhausted({ ...args })]);
    assert.equal(results.filter((r) => r.ok === true).length, 1, "恰好一次有效续接：" + JSON.stringify(results.map((r) => [r.ok, r.error])));
    assert.equal(grantEventsOf(fx, h.taskId).length, 1, "只追加一次预算");
    assert.equal(fx.taskStore.stepsOfTask(h.taskId).length, 3, "只新增一个 step");
    assert.equal(fx.taskStore.taskById(h.taskId).status, "SUCCEEDED");
    assert.equal(fx.taskService.getBudgetLedger({ context: h.ctx, taskId: h.taskId }).ledger.resumeCount, 1);
    // 成功后再次点击：不可续接，且不再追加。
    const again = await h.orch.resumeBudgetExhausted({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision });
    assert.equal(again.ok, false);
    assert.equal(grantEventsOf(fx, h.taskId).length, 1);
  } finally { await fx.close(); }
});

/* ============================================================ D */
test("D4-06 Closure D · 续接过程中撤权 → 受保护执行被拒绝并收敛；旧 approval/capability 不复活", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d406r-d-"));
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), keepData: true,
    sideEffectRuntimeDir: path.join(root, "runtime"), sideEffectApprovalWaitMs: 60000, facadeWriteToolIds: ["resource.trash"],
  });
  try {
    const created = await fx.createResource("D406R Revoke Target");
    const resourceRef = created.resource.resourceRef;
    const resourceId = created.resource.resourceId;
    assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(fx.grantUserResource(resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);

    const h = await setupDshBudgetStop(fx);
    // app tool grant 是 upsert（替换 actions），必须在 setup 之后一次性授予全部工具。
    const toolGrant = fx.grantTool("ai", ["tool.resource.trash", "tool.resource.search", "tool.resource.readMetadata"]);
    const trashGrantId = toolGrant && toolGrant.grant ? toolGrant.grant.grantId : null;
    assert.ok(trashGrantId, "tool grant 必须存在");
    assert.equal(fx.taskService.getResumeEligibility({ context: h.ctx, taskId: h.taskId }).resumable, true);

    // 续接过程中（WRITE 已到 AWAITING_APPROVAL）撤权，然后再用旧 approval → 受保护执行必须被拒绝。
    fx.fp.state.toolLoopPlan = [{ id: "call_d_trash", name: "resource_trash", args: { resourceRef } }];
    const revision = fx.taskStore.taskById(h.taskId).revision;
    const p = h.dsh.resumeBudgetExhausted({ context: h.ctx, taskId: h.taskId, expectedRevision: revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    await waitFor(() => fx.sideEffectStore.callsOfTask(h.taskId).length === 1, 60000, "续接后的 SideEffectCall 未出现");
    const call = fx.sideEffectStore.callsOfTask(h.taskId)[0];
    assert.equal(call.status, "AWAITING_APPROVAL");
    const rev = fx.f.authService.revokeAppResourcePermission({ context: fx.f.adminCtx(), grantId: trashGrantId });
    assert.equal(rev.ok, true, JSON.stringify(rev));
    assert.equal(rev.changed, true);
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "撤权前 0 mutation");
    const appr = fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: call.callId, decision: "APPROVE" });
    assert.equal(appr.ok, true, JSON.stringify(appr));
    const rr = await p;
    assert.equal(rr.ok, false);
    const finalCall = fx.sideEffectStore.callById(call.callId);
    assert.equal(finalCall.status, "BLOCKED", "撤权后旧 approval 不得执行：" + finalCall.status);
    assert.equal(finalCall.errorCode, "SIDE_EFFECT_AUTHORIZATION_REVOKED");
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "0 mutation");
    assert.equal(fx.sideEffectStore.leasesOfCall(call.callId).filter((l) => l.status === "ACTIVE").length, 0, "0 active lease");
    assert.equal(fx.taskStore.taskById(h.taskId).status, "BLOCKED");
    const steps = fx.taskStore.stepsOfTask(h.taskId);
    assert.equal(steps[steps.length - 1].status, "BLOCKED");
    assert.equal(fx.taskStore.harnessRunsOfTask(h.taskId).every((r) => r.status !== "RUNNING" && r.status !== "STARTING"), true);
    assert.equal(grantEventsOf(fx, h.taskId).length, 1);
  } finally { await fx.close(); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/* ============================================================ E */
test("D4-06 Closure E · 非预算停止 / 伪造身份 / 伪造预算 / stale revision → 后端显式拒绝", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    // E1：非预算停止（真实受控执行异常）→ NOT_BUDGET_STOP
    fx.grantTool("ai", ["tool.resource.search"]);
    const realSearch = fx.f.searchService.search;
    fx.f.searchService.search = () => { throw new Error("d4-06-resume injected fault"); };
    const ctx2 = fx.ctx();
    const t2 = fx.createTask();
    const r2 = await fx.makeToolOrchestrator().runTask({ context: ctx2, taskId: t2.task.taskId, expectedRevision: t2.task.revision, stepInput: { proposeSequence: searchSeq(1, "fault"), finalText: "X" }, verify: { type: "EXACT_TEXT", expected: "X" } });
    assert.equal(r2.ok, false);
    const elig2 = fx.taskService.getResumeEligibility({ context: ctx2, taskId: t2.task.taskId });
    assert.equal(elig2.ok, true);
    assert.equal(elig2.resumable, false);
    assert.equal(elig2.reason, "RESUME_NOT_BUDGET_STOP", JSON.stringify(elig2));
    const denied2 = await fx.makeToolOrchestrator().resumeBudgetExhausted({ context: ctx2, taskId: t2.task.taskId, expectedRevision: fx.taskStore.taskById(t2.task.taskId).revision });
    assert.equal(denied2.ok, false);
    assert.equal(denied2.error, "RESUME_NOT_BUDGET_STOP");
    assert.equal(grantEventsOf(fx, t2.task.taskId).length, 0);
    fx.f.searchService.search = realSearch;

    // E2：伪造身份 / 错误 app → TASK_FORBIDDEN
    const h = await setupSyntheticBudgetStop(fx);
    const spoof = fx.taskService.getResumeEligibility({ context: { sessionRef: "sess_evil", appId: "ai", source: "ui" }, taskId: h.taskId });
    assert.equal(spoof.ok, false);
    assert.equal(spoof.error, "TASK_FORBIDDEN");
    const wrongApp = fx.taskService.getResumeEligibility({ context: { sessionRef: fx.f.sessions.admin, appId: "canvas", source: "ui" }, taskId: h.taskId });
    assert.equal(wrongApp.ok, false);
    assert.equal(wrongApp.error, "TASK_FORBIDDEN");
    const spoofGrant = h.orch.resumeBudgetExhausted({ context: { sessionRef: "sess_evil", appId: "ai", source: "ui" }, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision });
    const spoofRes = await spoofGrant;
    assert.equal(spoofRes.ok, false);
    assert.equal(spoofRes.error, "TASK_FORBIDDEN");
    assert.equal(grantEventsOf(fx, h.taskId).length, 0);

    // E3：stale revision → TASK_REVISION_CONFLICT（不追加）
    const stale = await h.orch.resumeBudgetExhausted({ context: h.ctx, taskId: h.taskId, expectedRevision: 999999 });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "TASK_REVISION_CONFLICT");
    assert.equal(grantEventsOf(fx, h.taskId).length, 0);

    // E4：renderer 自报预算种类 / 金额 → 后端忽略（kind 必须匹配真实停止 kind；错误 kind 拒绝）
    const wrongKind = fx.taskService.grantBudgetResume({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision, kind: "MODEL_CALLS", amount: 9999 });
    assert.equal(wrongKind.ok, false);
    assert.equal(wrongKind.error, "RESUME_UNKNOWN_BUDGET_KIND");
    assert.equal(grantEventsOf(fx, h.taskId).length, 0);

    // E5：app 被禁用 → guard 失败
    fx.f.authService.setAppStatus({ context: fx.f.adminCtx(), appId: "ai", status: "disabled" });
    const disabled = fx.taskService.getResumeEligibility({ context: h.ctx, taskId: h.taskId });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.error, "TASK_FORBIDDEN");
    fx.f.authService.setAppStatus({ context: fx.f.adminCtx(), appId: "ai", status: "enabled" });
    assert.equal(grantEventsOf(fx, h.taskId).length, 0);

    // 正确续接仍可成功（证明拒绝都是 fail-closed，不是把入口全部关死）。
    const ok = await h.orch.resumeBudgetExhausted({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });
    assert.equal(ok.ok, true, JSON.stringify(ok.error));
    assert.equal(fx.taskStore.taskById(h.taskId).status, "SUCCEEDED");
    assert.equal(grantEventsOf(fx, h.taskId).length, 1);
  } finally { await fx.close(); }
});

/* ============================================================ E（真实 UNKNOWN_EFFECT · live-unlinked） */
/**
 * 真实产品路径：executor 独占 lifetime socket 并停在真实 side-effect 执行中，A 仍存活时
 * live-unlink 其 socket，再以 production 顺序 cold-restart（taskService.recoverRunning +
 * sideEffectRuntime.recoverOnStartup）。quiescence 无法证明 → call 持久化 UNKNOWN_EFFECT，
 * Task BLOCKED。全程真实 API + 真实 crash/liveness，不直改 DB、不手工 insert 终态、不调终态收敛方法。
 */
test("D4-06 Closure E · 真实 live-unlinked 崩溃遗留 UNKNOWN_EFFECT call → 后端拒绝续接（RESUME_UNKNOWN_EFFECT_PRESENT）", async () => {
  // 短前缀：unix socket 路径必须 < 104 bytes（与既有 live-unlinked 夹具同样的约束）。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa4u-"));
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const runtimeDir = path.join(root, "runtime");
  let fx = null; let box = null; let exited = null; let rt = null;
  try {
    fx = await createToolHarnessFixture({ withAdapters: true, dbPath, storeRoot, keepData: true, sideEffectRuntimeDir: runtimeDir, sideEffectApprovalWaitMs: 400 });
    const created = await fx.createResource("D406R Unknown Target");
    const resourceRef = created.resource.resourceRef;
    fx.grantTool("ai", ["tool.resource.trash"]);
    assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);
    const run = fx.dshRunSetup();
    const planned = await fx.sideEffectRuntime.proposeWrite({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: "resource.trash", arguments: { resourceRef } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
    const callId = planned.approvalRequestId;
    const adminSession = fx.f.sessions.admin;

    // 真实受监督 executor runtime：独占 lifetime socket，停在 mutation gate（永不放行）。
    const execId = "exe_u" + Math.random().toString(36).slice(2, 7);
    const socketPath = path.join(runtimeDir, "executors", execId + ".sock");
    box = spawn(process.execPath, [GATED_EXECUTOR, JSON.stringify({ runtimeDir, dbPath, storeRoot, instanceId: execId, callId, holderId: "exec_1", timeoutMs: 120000, holdAfterMutation: true, now: fx.f.clock() })], { stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; let err = "";
    box.stdout.on("data", (d) => { out += d; });
    box.stderr.on("data", (d) => { err += d; });
    exited = new Promise((r) => box.on("exit", (c) => r(c)));
    await waitFor(() => RuntimeSupervisor.parseExecutorMessage(out, "ready"), 30000, "executor 未就绪：" + err);
    await waitFor(() => fx.sideEffectStore.callById(callId).status === "RUNNING", 30000, "claim 未提交");
    assert.equal(box.exitCode, null, "executor 必须仍然存活");
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "mutation 尚未发生");

    // 上一次 production supervisor 的 persisted ACTIVE record（无 socketPath），随后 A 存活时 unlink。
    const recordPath = path.join(runtimeDir, "executors", execId + ".json");
    fs.mkdirSync(path.join(runtimeDir, "executors"), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify({ instanceId: execId, status: "ACTIVE", startedAt: 1, callId, holderId: "exec_1", endedAt: null, exitCode: null, signal: null, reason: null }));
    if (!fs.existsSync(socketPath)) assert.fail("executor lifetime socket 未出现（path len=" + socketPath.length + "）；out=" + out.slice(0, 200) + " err=" + err.slice(0, 200));
    fs.unlinkSync(socketPath);
    assert.equal(fs.existsSync(socketPath), false, "socket 已 unlink");
    assert.equal(box.exitCode, null, "unlink 不得杀死 executor");

    const fixedNow = fx.f.clock();
    await fx.close(); fx = null;
    rt = await reopenToolHarnessRuntime({ dbPath, storeRoot, runtimeDir, clock: () => fixedNow });
    const rec = rt.recover();
    assert.ok(rec && rec.sideEffect, "recovery 必须执行");

    // 真实产品状态：call 持久化 UNKNOWN_EFFECT（绝不 FAILED），Task/Step BLOCKED。
    const persistedCall = rt.sideEffectStore.callById(callId);
    assert.equal(persistedCall.status, "UNKNOWN_EFFECT", JSON.stringify(persistedCall));
    assert.equal(rt.taskStore.taskById(run.taskId).status, "BLOCKED");
    assert.equal(rt.taskStore.stepById(run.stepId).status, "BLOCKED");

    const context = { sessionRef: adminSession, appId: "ai", source: "test" };
    const elig = rt.taskService.getResumeEligibility({ context, taskId: run.taskId });
    assert.equal(elig.ok, true, JSON.stringify(elig));
    assert.equal(elig.resumable, false);
    assert.equal(elig.reason, "RESUME_UNKNOWN_EFFECT_PRESENT", JSON.stringify(elig));

    const orch = new TaskHarnessOrchestrator({ taskService: rt.taskService, toolProxy: rt.toolProxy, sideEffectRuntime: rt.sideEffectRuntime, clock: () => fixedNow });
    const denied = await orch.resumeBudgetExhausted({ context, taskId: run.taskId, expectedRevision: rt.taskStore.taskById(run.taskId).revision });
    assert.equal(denied.ok, false, JSON.stringify(denied));
    assert.equal(denied.error, "RESUME_UNKNOWN_EFFECT_PRESENT");
    assert.equal(rt.taskStore.eventsOfTask(run.taskId).filter((e) => e.event_type === "task.budget.granted").length, 0, "UNKNOWN_EFFECT 绝不追加预算");
    assert.equal(rt.taskStore.taskById(run.taskId).status, "BLOCKED", "续接尝试不得改变 task 状态");
    assert.equal(rt.taskStore.stepsOfTask(run.taskId).length, 1, "不得新增 step");
  } finally {
    try { if (box) box.kill("SIGKILL"); } catch { /* ignore */ }
    try { if (exited) await exited; } catch { /* ignore */ }
    try { if (rt) await rt.close(); } catch { /* ignore */ }
    try { if (fx) await fx.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
