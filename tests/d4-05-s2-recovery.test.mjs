/**
 * D4-05 · S2（结果未知 / PLAN §383/384）——真实受控 WRITE + 真实存活 executor 无法证明 quiescence
 * → Call 持久化 UNKNOWN_EFFECT，然后校验只读恢复投影 + 人工确认事件，且绝不改变 authority 状态。
 *
 * 真实链路：Tool Proxy propose → trusted approval → 受监督/真实 executor acquireLease + claim RUNNING
 * （Domain mutation 由 stdin gate 挂起）→ OpenArc recoverOnStartup 无法证明 origin runtime 已死
 * → UNKNOWN_EFFECT / Task·Step BLOCKED（与 D4-06 Closure 的 live-unlinked 场景同源）。
 *
 * 人工确认只追加一条 safe task event：call 仍 UNKNOWN_EFFECT、Task 仍 BLOCKED、
 * 仍 RESUME_UNKNOWN_EFFECT_PRESENT、0 第二 call/lease/retry、绝不授权 resume。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");
const GATED_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "supervised-executor.mjs");

const ACK_EVENT = "tool.side_effect.unknown_effect.acknowledged";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, detail) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); };
const ackEvents = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === ACK_EVENT);
const grantEvents = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "task.budget.granted");

/** 真实受监督 executor 需要 disk DB（独立 child 进程要读到同一条 call）。 */
async function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa5s2-"));
  const paths = { root, dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), runtimeDir: path.join(root, "rt") };
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop",
    dbPath: paths.dbPath, storeRoot: paths.storeRoot, keepData: true,
    sideEffectRuntimeDir: paths.runtimeDir,
  });
  return { fx, paths };
}

/** step0 成功（Artifact 锚点）+ step1 真实存活 executor claim RUNNING → recoverOnStartup → UNKNOWN_EFFECT。 */
async function setupUnknownEffect(fx, paths) {
  fx.grantTool("ai", ["tool.resource.trash"]);
  const ctx = fx.ctx();
  const t = fx.createTask();
  const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  const s0 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { proposeSequence: [], finalText: "OPENARC_TASK_OK" }, expectedRevision: started.task.revision });
  const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s0.task.revision });
  const ss0 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: s1.task.revision });
  const r0 = await fx.makeToolOrchestrator().runStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: s0.step.input, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });
  assert.equal(r0.ok, true, "step0 必须成功：" + JSON.stringify(r0.error));
  assert.equal(fx.taskStore.taskById(t.task.taskId).status, "RUNNING", "s1 仍 PENDING：Task 不得提前 SUCCEEDED");

  const fresh = fx.taskStore.taskById(t.task.taskId);
  const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fresh.revision });
  const run = fx.taskService.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision });
  const mr = fx.taskService.markHarnessRunRunning({ context: ctx, taskId: t.task.taskId, runId: run.run.runId, expectedRevision: run.task.revision });
  assert.equal(mr.ok, true);

  const unkRes = await fx.createResource("D405 S2 Unknown Target");
  assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: unkRes.resource.resourceId, actions: ["resource.delete"] }).ok, true);
  assert.equal(fx.grantUserResource(unkRes.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);

  const planned = await fx.sideEffectRuntime.proposeWrite({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, runId: run.run.runId, toolId: "resource.trash", arguments: { resourceRef: unkRes.resource.resourceRef } });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const callId = planned.approvalRequestId;
  assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: callId, decision: "APPROVE" }).ok, true);

  // 真实存活 executor：独占 lifetime socket、acquireLease、claim RUNNING，Domain mutation 被 stdin gate 挂起。
  const instanceId = "exe_" + Math.random().toString(36).slice(2, 8);
  const box = spawn(process.execPath, [GATED_EXECUTOR, JSON.stringify({ runtimeDir: paths.runtimeDir, dbPath: paths.dbPath, storeRoot: paths.storeRoot, instanceId, callId, holderId: "exec_1", timeoutMs: 120000, holdAfterMutation: true, now: fx.f.clock() })], { stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; let err = "";
  box.stdout.on("data", (d) => { out += d; });
  box.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((r) => box.on("exit", (c) => r(c)));
  await waitFor(() => RuntimeSupervisor.parseExecutorMessage(out, "ready"), 30000, "executor 未就绪：" + err);
  await waitFor(() => fx.sideEffectStore.callById(callId).status === "RUNNING", 30000, "claim RUNNING 未提交");
  assert.equal(box.exitCode, null, "真实 executor 必须仍存活（quiescence 不可证）");

  // 真实 recovery（与生产启动同一入口）：无法证明 origin runtime 已死 → UNKNOWN_EFFECT。
  const rec = fx.sideEffectRuntime.recoverOnStartup();
  return { box, exited, rec, ctx, taskId: t.task.taskId, s0, s1, runId: run.run.runId, callId, resourceRef: unkRes.resource.resourceRef };
}

test("D4-05 S2 · recovery 只读投影：含 UNKNOWN_EFFECT call 与关联产物，且 resumable=false", async () => {
  const { fx, paths } = await makeFixture();
  let h = null;
  try {
    h = await setupUnknownEffect(fx, paths);
    assert.equal(fx.sideEffectStore.callById(h.callId).status, "UNKNOWN_EFFECT", "call 必须持久化 UNKNOWN_EFFECT");
    assert.equal(fx.taskStore.taskById(h.taskId).status, "BLOCKED");
    assert.equal(fx.taskStore.stepById(h.s1.step.stepId).status, "BLOCKED");

    const step0Artifact = fx.taskStore.artifactsOfTask(h.taskId).find((a) => a.step_id === h.s0.step.stepId);
    assert.ok(step0Artifact, "step0 必须留下 Artifact 作为关联产物锚点");

    const proj = fx.taskService.getRecoveryState({ context: h.ctx, taskId: h.taskId });
    assert.equal(proj.ok, true);
    assert.equal(proj.applicable, true, "BLOCKED + UNKNOWN_EFFECT 必须 applicable");
    assert.equal(proj.taskStatus, "BLOCKED");
    assert.equal(proj.resumable, false, "结果未知绝不 resumable");
    assert.equal(proj.reason, "RESUME_UNKNOWN_EFFECT_PRESENT", JSON.stringify(proj));
    assert.equal(proj.calls.length, 1);
    const call = proj.calls[0];
    assert.equal(call.callId, h.callId);
    assert.equal(call.status, "UNKNOWN_EFFECT");
    assert.equal(call.toolId, "resource.trash");
    assert.ok(call.errorCode, "必须给出 errorCode：" + JSON.stringify(call));
    assert.ok(["APPLIED", "NOT_APPLIED", "INDETERMINATE", "NO_CONCLUSION"].includes(call.recoveryResult), call.recoveryResult);
    assert.equal(call.acknowledged, false, "确认前 acknowledged=false");
    assert.ok(call.associatedArtifacts.some((a) => a.artifactId === step0Artifact.artifact_id), "关联产物必须含 step0 Artifact：" + JSON.stringify(call.associatedArtifacts));
    assert.ok(call.associatedArtifacts.every((a) => a.checksum === null || /^[a-f0-9]{64}$/.test(a.checksum)), "checksum 只能是 sha256 形态");
    assert.equal(new RegExp("/Users|/private|/var/folders|mpx_|tpx_|credential", "i").test(JSON.stringify(proj)), false, "投影必须脱敏");

    assert.equal(fx.sideEffectStore.callById(h.callId).status, "UNKNOWN_EFFECT", "只读投影不改状态");
    assert.equal(fx.taskStore.taskById(h.taskId).status, "BLOCKED");
    assert.equal(ackEvents(fx, h.taskId).length, 0);

    // 非 owner（dana：fixture 内真实用户/session，非该 task 的 owner）不得读取恢复详情。
    const danaCtx = { sessionRef: fx.f.sessions.dana, appId: "ai", source: "ui" };
    const danaProj = fx.taskService.getRecoveryState({ context: danaCtx, taskId: h.taskId });
    assert.equal(danaProj.ok, false, "非 owner 读取恢复详情必须被拒：" + JSON.stringify(danaProj));
    assert.equal(danaProj.error, "TASK_FORBIDDEN", "必须是显式 TASK_FORBIDDEN：" + JSON.stringify(danaProj));
    assert.equal(danaProj.calls, undefined, "拒绝时绝不返回 recovery 详情（calls）");
    assert.equal(danaProj.applicable, undefined, "拒绝时绝不返回 applicable");
    assert.equal(ackEvents(fx, h.taskId).length, 0, "拒绝读取不追加任何 event");
    assert.equal(fx.sideEffectStore.callById(h.callId).status, "UNKNOWN_EFFECT", "拒绝读取后 call 状态不变");
    assert.equal(fx.taskStore.taskById(h.taskId).status, "BLOCKED", "拒绝读取后 Task 状态不变");

    // 投影/语义不得暗示成功：call 仍 UNKNOWN_EFFECT、resumable=false、无 SUCCEEDED/success 字样。
    assert.equal(call.status, "UNKNOWN_EFFECT");
    assert.equal(proj.resumable, false, "结果未知绝不 resumable");
    assert.equal(/SUCCEEDED|"success"|success/is.test(JSON.stringify(proj)), false, "恢复投影不得含成功语义：" + JSON.stringify(proj));
  } finally {
    try { if (h) { h.box.kill("SIGKILL"); await h.exited; } } catch { /* ignore */ }
    await fx.close(); try { fs.rmSync(paths.root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("D4-05 S2 · 人工确认只追加 safe event：call 仍 UNKNOWN_EFFECT / Task 仍 BLOCKED / 0 第二 call·lease·retry", async () => {
  const { fx, paths } = await makeFixture();
  let h = null;
  try {
    h = await setupUnknownEffect(fx, paths);
    const callsBefore = fx.sideEffectStore.callsOfTask(h.taskId).length;
    const leasesBefore = fx.sideEffectStore.leasesOfCall(h.callId).length;
    const runsBefore = fx.taskStore.harnessRunsOfTask(h.taskId).length;
    const artifactsBefore = fx.taskStore.artifactsOfTask(h.taskId).length;

    const ack = fx.taskService.acknowledgeUnknownEffect({ context: h.ctx, taskId: h.taskId, callId: h.callId });
    assert.equal(ack.ok, true, JSON.stringify(ack));
    assert.equal(ack.changed, true);
    assert.equal(ack.acknowledged, true);

    const evs = ackEvents(fx, h.taskId);
    assert.equal(evs.length, 1, "恰好一条 acknowledge event");
    const payload = JSON.parse(evs[0].safe_payload);
    assert.equal(payload.callId, h.callId);
    assert.equal(payload.operatorUserId, fx.f.users.admin);
    assert.equal(new RegExp("/Users|/private|/var/folders|mpx_|tpx_|credential", "i").test(evs[0].safe_payload), false, "event payload 必须脱敏");

    assert.equal(fx.sideEffectStore.callById(h.callId).status, "UNKNOWN_EFFECT", "ack 后 call 仍 UNKNOWN_EFFECT");
    assert.equal(fx.taskStore.taskById(h.taskId).status, "BLOCKED", "ack 后 Task 仍 BLOCKED");
    assert.equal(fx.taskStore.stepById(h.s1.step.stepId).status, "BLOCKED", "ack 后 Step 仍 BLOCKED");
    assert.equal(fx.sideEffectStore.callsOfTask(h.taskId).length, callsBefore, "ack 不产生第二 call");
    assert.equal(fx.sideEffectStore.callsOfTask(h.taskId).filter((c) => c.status === "UNKNOWN_EFFECT").length, 1);
    assert.equal(fx.sideEffectStore.leasesOfCall(h.callId).length, leasesBefore, "ack 不产生第二 lease");
    assert.equal(fx.sideEffectStore.activeLeases().filter((l) => l.callId === h.callId).length, 0, "0 active lease");
    assert.equal(fx.taskStore.harnessRunsOfTask(h.taskId).length, runsBefore, "ack 不新增 run / retry");
    assert.equal(fx.taskStore.artifactsOfTask(h.taskId).length, artifactsBefore, "ack 不新增 Artifact");
    assert.equal(grantEvents(fx, h.taskId).length, 0, "ack 绝不追加预算 / 授权 resume");

    const elig = fx.taskService.getResumeEligibility({ context: h.ctx, taskId: h.taskId });
    assert.equal(elig.resumable, false);
    assert.equal(elig.reason, "RESUME_UNKNOWN_EFFECT_PRESENT");

    const proj = fx.taskService.getRecoveryState({ context: h.ctx, taskId: h.taskId });
    assert.equal(proj.calls[0].acknowledged, true);
    assert.equal(proj.calls[0].acknowledgedBy, fx.f.users.admin);
    const again = fx.taskService.acknowledgeUnknownEffect({ context: h.ctx, taskId: h.taskId, callId: h.callId });
    assert.equal(again.ok, true);
    assert.equal(again.changed, false, "重复确认幂等");
    assert.equal(ackEvents(fx, h.taskId).length, 1, "绝不追加第二条 event");

    assert.equal(fx.taskService.acknowledgeUnknownEffect({ context: { sessionRef: "sess_evil", appId: "ai", source: "ui" }, taskId: h.taskId, callId: h.callId }).ok, false, "伪造 session 被拒");
    assert.equal(fx.taskService.acknowledgeUnknownEffect({ context: h.ctx, taskId: h.taskId, callId: "scall_missing" }).error, "TASK_NOT_FOUND");
    assert.equal(ackEvents(fx, h.taskId).length, 1);

    // 非 owner（dana：fixture 内真实用户/session，与该 task owner/admin 不同）不得确认，也不得读取恢复详情。
    const danaCtx = { sessionRef: fx.f.sessions.dana, appId: "ai", source: "ui" };
    const danaAck = fx.taskService.acknowledgeUnknownEffect({ context: danaCtx, taskId: h.taskId, callId: h.callId });
    assert.equal(danaAck.ok, false, "非 owner 确认必须被拒：" + JSON.stringify(danaAck));
    assert.equal(danaAck.error, "TASK_FORBIDDEN", "必须是显式 TASK_FORBIDDEN：" + JSON.stringify(danaAck));
    assert.equal(danaAck.acknowledged, undefined, "拒绝确认时不返回确认语义");
    const danaProj = fx.taskService.getRecoveryState({ context: danaCtx, taskId: h.taskId });
    assert.equal(danaProj.ok, false, "非 owner 读取必须被拒：" + JSON.stringify(danaProj));
    assert.equal(danaProj.error, "TASK_FORBIDDEN");
    assert.equal(danaProj.calls, undefined, "拒绝时不返回 recovery 详情");
    assert.equal(ackEvents(fx, h.taskId).length, 1, "非 owner 尝试不追加任何 event");
    assert.equal(fx.sideEffectStore.callById(h.callId).status, "UNKNOWN_EFFECT", "非 owner 后 call 仍 UNKNOWN_EFFECT");
    assert.equal(fx.taskStore.taskById(h.taskId).status, "BLOCKED", "非 owner 后 Task 仍 BLOCKED");

    // 重复确认幂等（既有：again.changed=false 且仅 1 条 event）。
    assert.equal(again.changed, false, "重复确认幂等");
    assert.equal(ackEvents(fx, h.taskId).length, 1);
    // 确认语义不暗示成功：call 仍 UNKNOWN_EFFECT、resumable=false、投影无 SUCCEEDED/success 字样。
    assert.equal(fx.sideEffectStore.callById(h.callId).status, "UNKNOWN_EFFECT");
    assert.equal(proj.resumable, false);
    assert.equal(/SUCCEEDED|"success"|success/is.test(JSON.stringify(proj)), false, "确认后投影不得含成功语义：" + JSON.stringify(proj));
  } finally {
    try { if (h) { h.box.kill("SIGKILL"); await h.exited; } } catch { /* ignore */ }
    await fx.close(); try { fs.rmSync(paths.root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
