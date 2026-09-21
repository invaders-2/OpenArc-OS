/**
 * D4-03 · runTask 入口守卫：存在未决副作用（UNKNOWN_EFFECT / 待批准 / 已批准未执行 / LEASED /
 * RUNNING）或 active lease 时，第三条"启动新 run"入口 TaskHarnessOrchestrator.runTask 必须与
 * resume / append 一样拒绝，且 0 状态变化（无 task 转换 / revision 变化 / 新 step / 新 harness run /
 * 新 SideEffectCall / 新事件）。
 *
 * 真实装配：tests/fixtures/harness-acp 的 supervised-executor + recoverOnStartup（与独立审查探针
 * probe-e-finalstate 同法）；只用既有测试 seam，不直写 DB。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { TaskService } = require("../electron/task-service.cjs");
const { TaskHarnessOrchestrator } = require("../electron/task-harness-orchestrator.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");
const GATED_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "supervised-executor.mjs");

const SYNTH_FINAL = "OPENARC_TASK_OK";
const DSH_FINAL = "OPENARC_DSH_TOOL_OK";
const RUN_BLOCKED = "RUN_BLOCKED_UNRESOLVED_SIDE_EFFECT";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (fn, ms, detail) => (async () => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();

const revOf = (fx, taskId) => fx.taskStore.taskById(taskId).revision;
/** 只读快照：入口守卫拒绝时逐项必须完全一致。 */
const stateOf = (fx, taskId) => ({
  status: fx.taskStore.taskById(taskId).status,
  revision: revOf(fx, taskId),
  steps: fx.taskStore.stepsOfTask(taskId).map((r) => JSON.stringify(r)),
  runs: fx.taskStore.harnessRunsOfTask(taskId).map((r) => JSON.stringify(r)),
  calls: fx.sideEffectStore.callsOfTask(taskId).map((r) => JSON.stringify(r)),
  events: fx.taskStore.eventsOfTask(taskId).map((r) => r.event_type),
});
const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** runTask 被守卫拒绝的统一断言：形状 + 0 状态变化（同一 taskId 上逐行比对）。 */
async function assertRunBlocked(fx, { ctx, taskId, reason }) {
  const before = stateOf(fx, taskId);
  const r = await fx.makeDshOrchestrator().runTask({ context: ctx, taskId, expectedRevision: before.revision, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
  assert.equal(r.ok, false, "runTask 必须被拒：" + JSON.stringify(r));
  assert.equal(r.error, RUN_BLOCKED, JSON.stringify(r));
  assert.equal(r.reason, reason, JSON.stringify(r));
  assert.equal(r.task.status, before.status, "拒绝必须回当前 task（不伪造终态）");
  assert.ok(sameState(before, stateOf(fx, taskId)), "拒绝不得改任何 step/run/call/event/revision/状态");
  return r;
}

/* ============================================================ A 真实 UNKNOWN_EFFECT（与 probe-e 同法） */
test("D4-03 A · BLOCKED + 真实 UNKNOWN_EFFECT：runTask 拒绝（UNKNOWN_EFFECT），0 新 run/step/call/事件", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d403-"));
  const paths = { root, dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), runtimeDir: path.join(root, "rt") };
  let fx = null; let box = null;
  try {
    fx = await createToolHarnessFixture({
      withAdapters: true, behavior: "tool-loop", dbPath: paths.dbPath, storeRoot: paths.storeRoot, keepData: true,
      sideEffectRuntimeDir: paths.runtimeDir, sideEffectApprovalWaitMs: 60000, facadeWriteToolIds: ["resource.trash"],
    });
    fx.grantTool("ai", ["tool.resource.trash"]);
    const ctx = fx.ctx();
    const t = fx.createTask();
    const taskId = t.task.taskId;
    // 先有一个 SUCCEEDED step（真实产物），再生出第二条 step 承载 WRITE。
    const started = fx.taskService.startTask({ context: ctx, taskId, expectedRevision: t.task.revision });
    const s0 = fx.taskService.createStep({ context: ctx, taskId, kind: "reasoning", input: { proposeSequence: [], finalText: SYNTH_FINAL }, expectedRevision: started.task.revision });
    const s1 = fx.taskService.createStep({ context: ctx, taskId, kind: "reasoning", input: null, expectedRevision: s0.task.revision });
    const ss0 = fx.taskService.startStep({ context: ctx, taskId, stepId: s0.step.stepId, expectedRevision: s1.task.revision });
    const r0 = await fx.makeToolOrchestrator().runStep({ context: ctx, taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: s0.step.input, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(r0.ok, true, "step0 必须成功：" + JSON.stringify(r0.error));

    const ss1 = fx.taskService.startStep({ context: ctx, taskId, stepId: s1.step.stepId, expectedRevision: revOf(fx, taskId) });
    const run = fx.taskService.startHarnessRun({ context: ctx, taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision });
    fx.taskService.markHarnessRunRunning({ context: ctx, taskId, runId: run.run.runId, expectedRevision: run.task.revision });

    const unk = await fx.createResource("D4-03 Unknown Target");
    const resourceRef = unk.resource.resourceRef;
    assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: unk.resource.resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(fx.grantUserResource(unk.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);
    const planned = await fx.sideEffectRuntime.proposeWrite({ context: ctx, taskId, stepId: s1.step.stepId, runId: run.run.runId, toolId: "resource.trash", arguments: { resourceRef } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const callId = planned.approvalRequestId;
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: callId, decision: "APPROVE" }).ok, true);

    // 真实受监督 executor：停在 mutation gate，随后 recovery 把它判为结果未知。
    box = spawn(process.execPath, [GATED_EXECUTOR, JSON.stringify({ runtimeDir: paths.runtimeDir, dbPath: paths.dbPath, storeRoot: paths.storeRoot, instanceId: "exe_d403a", callId, holderId: "exec_1", timeoutMs: 120000, holdAfterMutation: true, now: fx.f.clock() })], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    box.stdout.on("data", (d) => { out += d; });
    await waitFor(() => RuntimeSupervisor.parseExecutorMessage(out, "ready"), 30000, "executor 未就绪");
    await waitFor(() => fx.sideEffectStore.callById(callId).status === "RUNNING", 30000, "claim 未提交");
    fx.sideEffectRuntime.recoverOnStartup();

    const calls = () => fx.sideEffectStore.callsOfTask(taskId);
    assert.equal(fx.taskStore.taskById(taskId).status, "BLOCKED");
    assert.equal(fx.sideEffectStore.callById(callId).status, "UNKNOWN_EFFECT");
    assert.equal(calls().length, 1, "起点恰好 1 条 SideEffectCall");
    // 既有两条入口的拒绝字符串必须逐字不变（单一来源收敛不得改写对外语义）。
    assert.equal(fx.taskService.getResumeEligibility({ context: ctx, taskId }).reason, "RESUME_UNKNOWN_EFFECT_PRESENT");
    assert.equal(fx.taskService.getAppendEligibility({ context: ctx, taskId }).reason, "APPEND_UNKNOWN_EFFECT");
    assert.deepEqual(fx.taskService.getSideEffectSafety({ context: ctx, taskId }), { ok: true, taskId, blocked: true, code: "UNKNOWN_EFFECT" });

    const counts = () => ({
      steps: fx.taskStore.stepsOfTask(taskId).length,
      runs: fx.taskStore.harnessRunsOfTask(taskId).length,
      artifacts: fx.taskStore.artifactsOfTask(taskId).length,
      calls: calls().length,
    });
    const beforeCounts = counts();
    assert.equal(beforeCounts.steps, 2, "s0 + s1");
    assert.equal(beforeCounts.artifacts, 1, "step0 已产出真实 artifact");

    // 若守卫缺失，下面这份 plan 会让 official dsh 再次提出同一 resource.trash（= 第二条 SideEffectCall）。
    fx.fp.state.toolLoopPlan = [{ id: "call_trash_2", name: "resource_trash", args: { resourceRef } }];
    const r = await assertRunBlocked(fx, { ctx, taskId, reason: "UNKNOWN_EFFECT" });

    assert.deepEqual(counts(), beforeCounts, "绝不新增 step / harness run / artifact / SideEffectCall");
    assert.equal(fx.sideEffectStore.callById(callId).status, "UNKNOWN_EFFECT", "旧 call1 结果未知必须保留");
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "0 mutation");
    const rec = fx.taskService.getRecoveryState({ context: ctx, taskId });
    assert.equal(rec.applicable, true, "UNKNOWN_EFFECT 恢复入口必须仍然 applicable");
    assert.equal(rec.taskStatus, "BLOCKED");
    assert.equal(rec.resumable, false, "UNKNOWN_EFFECT 绝不授权 resume");
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].callId, callId);
    assert.equal(fx.taskStore.taskById(taskId).status, "BLOCKED", "任务仍 BLOCKED");

    // 与 probe-e-finalstate 同形的真实证据。
    console.log("A. 起点: task=BLOCKED call1=UNKNOWN_EFFECT calls=1");
    console.log("C. runTask(dsh on BLOCKED+UNKNOWN_EFFECT) ok=" + r.ok + " error=" + r.error + " reason=" + r.reason);
    console.log("D. 出现第二条 SideEffectCall=false calls=" + calls().length + " task=" + fx.taskStore.taskById(taskId).status + " steps=" + fx.taskStore.stepsOfTask(taskId).length + " runs=" + fx.taskStore.harnessRunsOfTask(taskId).length);
    console.log("E. 终态: taskStatus=" + fx.taskStore.taskById(taskId).status + " | call1=" + fx.sideEffectStore.callById(callId).status
      + " | recovery.applicable=" + rec.applicable + " | appendable=" + fx.taskService.getAppendEligibility({ context: ctx, taskId }).appendable
      + " | resumable=" + fx.taskService.getResumeEligibility({ context: ctx, taskId }).resumable);
  } finally {
    try { if (box) box.kill("SIGKILL"); } catch { /* ignore */ }
    try { if (fx) await fx.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/* ============================================================ B 待批准 */
test("D4-03 B · 遗留 AWAITING_APPROVAL 副作用：runTask 拒绝（SIDE_EFFECT_PENDING），0 状态变化", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d403-b-"));
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), keepData: true,
    sideEffectRuntimeDir: path.join(root, "runtime"), sideEffectApprovalWaitMs: 60000, facadeWriteToolIds: ["resource.trash"],
  });
  try {
    const created = await fx.createResource("D4-03 Approval Target");
    fx.grantTool("ai", ["tool.resource.trash"]);
    assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);
    const run = fx.dshRunSetup();
    const planned = await fx.sideEffectRuntime.proposeWrite({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: "resource.trash", arguments: { resourceRef: created.resource.resourceRef } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const callId = planned.approvalRequestId;
    const waited = fx.taskService.waitForApproval({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, reason: "TOOL_APPROVAL_REQUIRED", expectedRevision: run.revision });
    assert.equal(waited.ok, true, JSON.stringify(waited));
    assert.equal(fx.taskService.blockHarnessRun({ context: run.context, taskId: run.taskId, runId: run.runId, errorCode: "TOOL_APPROVAL_REQUIRED", stopReason: "approval_required", expectedRevision: waited.task.revision }).ok, true);
    assert.equal(fx.sideEffectStore.callById(callId).status, "AWAITING_APPROVAL");
    assert.equal(fx.taskStore.taskById(run.taskId).status, "WAITING", "WAITING→RUNNING 是合法边：守卫必须前置");

    // 既有判定顺序逐字不变：resume 的状态门（NOT_BLOCKED）先于安全门，append 相反。
    assert.equal(fx.taskService.getResumeEligibility({ context: run.context, taskId: run.taskId }).reason, "RESUME_NOT_BLOCKED");
    assert.equal(fx.taskService.getAppendEligibility({ context: run.context, taskId: run.taskId }).reason, "APPEND_SIDE_EFFECT_PENDING");
    assert.deepEqual(fx.taskService.getSideEffectSafety({ context: run.context, taskId: run.taskId }), { ok: true, taskId: run.taskId, blocked: true, code: "SIDE_EFFECT_PENDING" });

    await assertRunBlocked(fx, { ctx: run.context, taskId: run.taskId, reason: "SIDE_EFFECT_PENDING" });
    assert.equal(fx.sideEffectStore.callById(callId).status, "AWAITING_APPROVAL", "未决审批不得被入口拒绝改写");
    assert.equal(fx.taskStore.stepsOfTask(run.taskId).length, 1);

    // BLOCKED + 同一未决 call：resume 的既有拒绝字符串必须是 RESUME_SIDE_EFFECT_PENDING（逐字不变）。
    const blk = fx.dshRunSetup();
    const planned2 = await fx.sideEffectRuntime.proposeWrite({ context: blk.context, taskId: blk.taskId, stepId: blk.stepId, runId: blk.runId, toolId: "resource.trash", arguments: { resourceRef: created.resource.resourceRef } });
    assert.equal(planned2.ok, true, JSON.stringify(planned2));
    const stopped = fx.taskService.blockStep({ context: blk.context, taskId: blk.taskId, stepId: blk.stepId, reason: "HARNESS_TURN_TIMEOUT", expectedRevision: revOf(fx, blk.taskId) });
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(stopped.task.status, "BLOCKED");
    const runStopped = fx.taskService.blockHarnessRun({ context: blk.context, taskId: blk.taskId, runId: blk.runId, errorCode: "HARNESS_TURN_TIMEOUT", stopReason: "blocked", expectedRevision: stopped.task.revision });
    assert.equal(runStopped.ok, true, JSON.stringify(runStopped));
    assert.equal(fx.sideEffectStore.callById(planned2.approvalRequestId).status, "AWAITING_APPROVAL");
    assert.equal(fx.taskService.getResumeEligibility({ context: blk.context, taskId: blk.taskId }).reason, "RESUME_SIDE_EFFECT_PENDING");
    assert.equal(fx.taskService.getAppendEligibility({ context: blk.context, taskId: blk.taskId }).reason, "APPEND_SIDE_EFFECT_PENDING");
    await assertRunBlocked(fx, { ctx: blk.context, taskId: blk.taskId, reason: "SIDE_EFFECT_PENDING" });
    assert.equal(fx.sideEffectStore.callById(planned2.approvalRequestId).status, "AWAITING_APPROVAL");
  } finally { await fx.close(); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/* ============================================================ C 正对照 1：全新 PENDING */
test("D4-03 C · 正对照：全新 PENDING 任务 runTask 仍正常（既有路径不受影响）", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeWriteToolIds: ["resource.trash"] });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    assert.deepEqual(fx.taskService.getSideEffectSafety({ context: ctx, taskId: t.task.taskId }), { ok: true, taskId: t.task.taskId, blocked: false, code: null });
    fx.fp.state.toolLoopPlan = [];
    const r = await fx.makeDshOrchestrator().runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.equal(fx.taskStore.stepsOfTask(t.task.taskId).length, 1);
    assert.equal(fx.taskStore.harnessRunsOfTask(t.task.taskId).length, 1);
    assert.equal(fx.sideEffectStore.callsOfTask(t.task.taskId).length, 0);
  } finally { await fx.close(); }
});

/* ============================================================ D 正对照 2：BLOCKED 但无未决副作用 */
test("D4-03 D · 正对照：blockStep 造成的 BLOCKED（无任何未决副作用）runTask 仍被允许", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const taskId = t.task.taskId;
    const started = fx.taskService.startTask({ context: ctx, taskId, expectedRevision: t.task.revision });
    const step = fx.taskService.createStep({ context: ctx, taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const ss = fx.taskService.startStep({ context: ctx, taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
    assert.equal(fx.taskService.blockStep({ context: ctx, taskId, stepId: step.step.stepId, reason: "HARNESS_TURN_TIMEOUT", expectedRevision: ss.task.revision }).ok, true);
    assert.equal(fx.taskStore.taskById(taskId).status, "BLOCKED");
    assert.deepEqual(fx.taskService.getSideEffectSafety({ context: ctx, taskId }), { ok: true, taskId, blocked: false, code: null });
    // 判定顺序不变：无副作用时 reason 仍是既有的"无 run / 非 SUCCEEDED"。
    assert.equal(fx.taskService.getResumeEligibility({ context: ctx, taskId }).reason, "RESUME_NO_HARNESS_RUN");
    assert.equal(fx.taskService.getAppendEligibility({ context: ctx, taskId }).reason, "APPEND_NOT_SUCCEEDED");

    const r = await fx.makeToolOrchestrator().runTask({ context: ctx, taskId, expectedRevision: revOf(fx, taskId), stepInput: { proposeSequence: [], finalText: SYNTH_FINAL }, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(r.ok, true, "BLOCKED 无未决副作用必须仍可显式启动：" + JSON.stringify(r.error));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.equal(fx.taskStore.stepsOfTask(taskId).length, 2);
    assert.equal(fx.taskStore.harnessRunsOfTask(taskId).length, 1);
    assert.equal(fx.sideEffectStore.callsOfTask(taskId).length, 0);
  } finally { await fx.close(); }
});

/* ============================================================ E 遗留 active lease */
test("D4-03 E · LEASED 遗留 active lease：runTask 拒绝（ACTIVE_LEASE），0 状态变化", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", sideEffectApprovalWaitMs: 60000, facadeWriteToolIds: ["resource.trash"] });
  try {
    const created = await fx.createResource("D4-03 Lease Target");
    const resourceRef = created.resource.resourceRef;
    fx.grantTool("ai", ["tool.resource.trash"]);
    assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);
    const run = fx.dshRunSetup();
    const planned = await fx.sideEffectRuntime.proposeWrite({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: "resource.trash", arguments: { resourceRef } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const callId = planned.approvalRequestId;
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: callId, decision: "APPROVE" }).ok, true);
    assert.equal(fx.sideEffectAuthority.acquireLease({ callId, holderId: "oase_d403" }).ok, true);
    assert.equal(fx.taskService.recoverRunning().ok, true);
    fx.sideEffectRuntime.recoverOnStartup();
    assert.equal(fx.taskStore.taskById(run.taskId).status, "BLOCKED");
    assert.equal(fx.sideEffectStore.activeLeases().filter((l) => l.callId === callId).length, 1, "遗留 active lease 必须存在");
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "0 mutation");

    assert.equal(fx.taskService.getResumeEligibility({ context: run.context, taskId: run.taskId }).reason, "RESUME_ACTIVE_LEASE");
    assert.equal(fx.taskService.getAppendEligibility({ context: run.context, taskId: run.taskId }).reason, "APPEND_ACTIVE_LEASE");
    assert.deepEqual(fx.taskService.getSideEffectSafety({ context: run.context, taskId: run.taskId }), { ok: true, taskId: run.taskId, blocked: true, code: "ACTIVE_LEASE" });
    await assertRunBlocked(fx, { ctx: run.context, taskId: run.taskId, reason: "ACTIVE_LEASE" });
    assert.equal(fx.sideEffectStore.activeLeases().filter((l) => l.callId === callId).length, 1, "入口拒绝绝不回收/改写 lease");
  } finally { await fx.close(); }
});

/* ============================================================ G 纯推理装配（无账本 + 无 side-effect runtime） */
test("D4-03 G · 纯推理装配（无账本、无 side-effect runtime）runTask 仍正常；账本不可用只由访问器如实报告", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: false, behavior: "tool-loop" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const taskId = t.task.taskId;
    const bareService = new TaskService({ identity: fx.f.identity, authService: fx.f.authService, authStore: fx.f.store, taskStore: fx.taskStore, clock: fx.f.clock });
    // 访问器如实 fail-closed：读不到账本绝不谎报"安全"。
    assert.deepEqual(bareService.getSideEffectSafety({ context: ctx, taskId }), { ok: true, taskId, blocked: true, code: "EFFECT_STATE_UNAVAILABLE" });
    assert.equal(bareService.getAppendEligibility({ context: ctx, taskId }).reason, "APPEND_EFFECT_STATE_UNAVAILABLE");

    const stub = (opts) => ({
      lastText: null,
      async start() { return { capabilityId: "mcap_stub", modelConfigVersion: opts.modelConfigVersion, dshVersion: "stub-0", sdkVersion: "0.0.0", protocolVersion: 1 }; },
      async prompt(p) { this.lastText = p; return { ok: true, stopReason: "end_turn", text: SYNTH_FINAL, events: [{ type: "text.delta", text: SYNTH_FINAL }] }; },
      async cancel() {},
      revokeToolCapability() {},
      revokeModelCapability() {},
      async dispose() {},
    });
    const orch = new TaskHarnessOrchestrator({ taskService: bareService, adapterFactory: (opts) => stub(opts) });
    const r = await orch.runTask({ context: ctx, taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(r.ok, true, "无副作用能力的纯推理装配必须仍可运行：" + JSON.stringify(r.error));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.equal(fx.taskStore.stepsOfTask(taskId).length, 1);
    assert.equal(fx.sideEffectStore.callsOfTask(taskId).length, 0);

    // 反向边界：同一无账本 TaskService + 装配了 side-effect runtime 的编排器 → 仍按 code 拒绝，
    // 且拒绝发生在 adapter 装配之前（写入能力存在时绝不放行）。
    const t2 = fx.createTask();
    const effectOrch = new TaskHarnessOrchestrator({ taskService: bareService, sideEffectRuntime: fx.sideEffectRuntime, adapterFactory: () => { throw new Error("守卫必须先于 adapter 装配"); } });
    const blocked = await effectOrch.runTask({ context: ctx, taskId: t2.task.taskId, expectedRevision: t2.task.revision });
    assert.equal(blocked.error, RUN_BLOCKED, JSON.stringify(blocked));
    assert.equal(blocked.reason, "EFFECT_STATE_UNAVAILABLE", JSON.stringify(blocked));
    assert.equal(fx.taskStore.taskById(t2.task.taskId).status, "PENDING", "拒绝不得启动任务");
    assert.equal(fx.taskStore.stepsOfTask(t2.task.taskId).length, 0, "拒绝不得新增 step");
  } finally { await fx.close(); }
});

/* ============================================================ F 访问器契约：归属 / 只读 / fail-closed */
test("D4-03 F · getSideEffectSafety 契约：owner/app 归属校验、绝不改状态、无账本 fail-closed", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const taskId = t.task.taskId;
    const before = stateOf(fx, taskId);
    assert.deepEqual(fx.taskService.getSideEffectSafety({ context: ctx, taskId }), { ok: true, taskId, blocked: false, code: null });
    assert.equal(fx.taskService.getSideEffectSafety({ context: ctx, taskId: "task_missing" }).error, "TASK_NOT_FOUND");
    // 非 owner / 错误 app：与既有 command 同源的归属校验，绝不泄露他人任务。
    assert.equal(fx.taskService.getSideEffectSafety({ context: { sessionRef: fx.f.sessions.alice, appId: "ai", source: "test" }, taskId }).error, "TASK_FORBIDDEN");
    assert.equal(fx.taskService.getSideEffectSafety({ context: { sessionRef: fx.f.sessions.admin, appId: "canvas", source: "test" }, taskId }).error, "TASK_FORBIDDEN");
    assert.equal(fx.taskService.getSideEffectSafety({ context: { sessionRef: fx.f.sessions.admin, source: "test" }, taskId }).error, "TASK_FORBIDDEN");
    assert.ok(sameState(before, stateOf(fx, taskId)), "只读访问器不得改任何行 / 事件 / revision");

    // 归属错误时 runTask 保持既有错误语义：不被守卫吞掉、不改写成 RUN_BLOCKED。
    // （未装配账本的纯推理装配见 G。）
    const bare = new TaskService({ identity: fx.f.identity, authService: fx.f.authService, authStore: fx.f.store, taskStore: fx.taskStore, clock: fx.f.clock });
    const bareOrch = new TaskHarnessOrchestrator({ taskService: bare, adapterFactory: () => { throw new Error("守卫必须先于任何 adapter 装配"); } });
    const denied = await bareOrch.runTask({ context: { sessionRef: fx.f.sessions.alice, appId: "ai", source: "test" }, taskId, expectedRevision: revOf(fx, taskId) });
    assert.equal(denied.error, "TASK_FORBIDDEN", JSON.stringify(denied));
    const missing = await bareOrch.runTask({ context: ctx, taskId: "task_missing", expectedRevision: 1 });
    assert.equal(missing.error, "TASK_NOT_FOUND", JSON.stringify(missing));
    const noApp = await bareOrch.runTask({ context: { sessionRef: fx.f.sessions.admin, source: "test" }, taskId, expectedRevision: revOf(fx, taskId) });
    assert.equal(noApp.error, "TASK_FORBIDDEN", JSON.stringify(noApp));
    assert.ok(sameState(before, stateOf(fx, taskId)), "拒绝不得改任何行 / 事件 / revision");
  } finally { await fx.close(); }
});
