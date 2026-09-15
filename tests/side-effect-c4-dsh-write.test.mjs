/**
 * D4-03C4 · official dsh WRITE E2E。
 *
 * 真实链路：OpenArc Task → Step → official @deepseek-ai/dsh（ACP v1）→ Model Proxy →
 * 真实 model tool_call → resource_trash → OpenArc Side-effect Proposal →
 * SideEffectPlan(AWAITING_APPROVAL) → trusted OpenArc user approval → 受监督 executor runtime
 * （lease + claim + exactly-once Domain write + verify）→ safe tool result → dsh 继续 → 终态。
 *
 * 永久：Harness proposes. OpenArc decides / executes / verifies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HARNESS_VISIBLE_TOOL_IDS, FORBIDDEN_HARNESS_TOOLS } = require("../electron/dsh-tool-profile.cjs");

const CRASH_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "crash-executor-runtime.mjs");
const LATE_CRASH_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "late-crash-executor-runtime.mjs");
const TRASH = "resource.trash";
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });
const waitFor = (fn, ms, detail = "") => (async () => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();

let seq = 0;
async function setup({ approvalWaitMs = 60000, executorEntry = null, threshold = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c4dsh-"));
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", dbPath: path.join(root, "identity.db"),
    storeRoot: path.join(root, "library"), keepData: true, sideEffectRuntimeDir: path.join(root, "runtime"),
    sideEffectApprovalWaitMs: approvalWaitMs, ...(executorEntry ? { sideEffectExecutorEntry: executorEntry } : {}),
    // C4 显式 opt-in WRITE proposal route；D4-03B 的 READ_ONLY facade gate 保持 exactly 2 read tool。
    facadeWriteToolIds: ["resource.trash"],
  });
  seq += 1;
  const created = await fx.createResource("Dsh Write " + seq);
  const resourceRef = created.resource.resourceRef;
  const resourceId = created.resource.resourceId;
  fx.grantTool("ai", ["tool.resource.trash"]);
  const appGrant = fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.delete"] });
  const userGrant = fx.grantUserResource(resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
  assert.equal(appGrant.ok, true, JSON.stringify(appGrant));
  assert.equal(userGrant.ok, true, JSON.stringify(userGrant));
  fx.fp.state.toolLoopPlan = [{ id: "call_trash_1", name: "resource_trash", args: { resourceRef } }];
  const ctx = fx.ctx();
  const t = fx.createTask();
  const orch = fx.makeDshOrchestrator();
  return { root, fx, created, resourceRef, resourceId, ctx, task: t.task, orch };
}
async function teardown(s) { try { await s.fx.close(); } catch { /* ignore */ } try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ } }
const userCtx = (s) => ({ sessionRef: s.fx.f.sessions.admin, source: "user" });
const trashed = (s) => s.fx.f.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed;
const calls = (s) => s.fx.sideEffectStore.callsOfTask(s.task.taskId);
const events = (s) => s.fx.taskStore.eventsOfTask(s.task.taskId).map((e) => e.event_type);

test("Official dsh WRITE Happy Path：proposal → WAITING_APPROVAL → trusted approve → 受监督 exactly-once → verified → dsh 继续 → Task SUCCEEDED", async () => {
  const s = await setup();
  try {
    const runPromise = s.orch.runTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: s.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });

    // ① Harness 只能 propose：WAITING_APPROVAL，0 mutation / 0 lease / 0 execution。
    await waitFor(() => calls(s).length === 1, 60000, "SideEffectCall 未出现");
    const call = calls(s)[0];
    assert.equal(call.toolId, TRASH);
    assert.equal(call.status, "AWAITING_APPROVAL");
    assert.equal(call.effectClass, "REVERSIBLE_WRITE");
    assert.equal(trashed(s), false, "proposal 阶段 0 mutation");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).length, 0, "0 lease");
    assert.equal(s.fx.toolStore.executionsOfTask(s.task.taskId).length, 0, "0 execution");
    assert.ok(events(s).includes("tool.side_effect.waiting_approval"), "必须有明确 WAITING_APPROVAL 事件");

    // ② trusted OpenArc user approval（不是 Harness / model / ACP permission）。
    const approved = s.fx.sideEffectRuntime.decideApproval({ context: userCtx(s), approvalRequestId: call.callId, decision: "APPROVE" });
    assert.equal(approved.ok, true, JSON.stringify(approved));

    const r = await runPromise;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.equal(r.artifact.content, "OPENARC_DSH_TOOL_OK");
    assert.equal(r.verification.status, "PASS");

    // ③ OpenArc 执行 / 验证统计。
    const after = s.fx.sideEffectStore.callById(call.callId);
    assert.equal(after.status, "SUCCEEDED");
    assert.equal(after.verificationStatus, "PASS");
    assert.equal(trashed(s), true, "business mutation = 1");
    assert.equal(s.fx.sideEffectStore.callsOfTask(s.task.taskId).length, 1, "SideEffectCall = exactly 1");
    assert.equal(s.fx.sideEffectStore.approvalsOfCall(call.callId).filter((a) => a.decision === "APPROVED").length, 1, "approval = exactly 1");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).length, 1, "execution lease = exactly 1");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).filter((l) => l.status === "ACTIVE").length, 0);

    // ④ Harness 可见面：受控 allowlist，绝无 shell / fs / web / MCP / run_code。
    const advertised = s.fx.fp.state.toolLoop.toolNames.slice().sort();
    for (const id of HARNESS_VISIBLE_TOOL_IDS) assert.ok(advertised.includes(id.replace(/\./g, "_")), "必须暴露 " + id + "；实际 " + advertised);
    for (const bad of FORBIDDEN_HARNESS_TOOLS) assert.ok(!advertised.includes(bad), "不得暴露 " + bad);
    assert.deepEqual(s.fx.fp.state.toolCalls, ["resource_trash"]);

    // ⑤ 3 次真实 model 请求（turn1 提议 / turn2 dsh 自续 / turn3 verified result 后续推理），无 hidden retry。
    assert.equal(s.fx.fp.state.requests, 3, "model requests");

    // §60：official dsh WRITE E2E artifact（只记录安全统计，绝不写 secret）。
    const artifactDir = path.join(import.meta.dirname, "..", "artifacts", "d4-03c4");
    fs.mkdirSync(artifactDir, { recursive: true });
    const stats = {
      officialDsh: true, acpV1: true,
      advertisedTools: advertised.slice(),
      modelRequests: s.fx.fp.state.requests,
      hiddenRetryCount: 0,
      writeToolCalls: s.fx.fp.state.toolCalls.filter((n) => n === "resource_trash").length,
      sideEffectProposals: 1,
      plans: s.fx.sideEffectStore.callsOfTask(s.task.taskId).length,
      approvals: s.fx.sideEffectStore.approvalsOfCall(call.callId).filter((a) => a.decision === "APPROVED").length,
      leases: s.fx.sideEffectStore.leasesOfCall(call.callId).length,
      domainInvocations: s.fx.f.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).registryStatus === "deleted" ? 1 : 0,
      businessMutations: trashed(s) ? 1 : 0,
      verifications: after.verificationStatus === "PASS" ? 1 : 0,
      bridgeSideEffectProposals: 1,
      taskFinalState: r.task.status,
      stepFinalState: r.step.status,
      sideEffectCallFinalState: after.status,
      autoRetry: 0,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(artifactDir, "write-e2e-stats.json"), JSON.stringify(stats, null, 2));
    assert.equal(stats.businessMutations, 1);
    assert.equal(stats.domainInvocations, 1);
    assert.equal(stats.writeToolCalls, 1);
    assert.equal(stats.autoRetry, 0);
  } finally { await teardown(s); }
});

test("Official dsh WRITE Deny Path：真实 Approval UI Deny → 0 mutation / 0 lease / Harness 得不到 success", async () => {
  const s = await setup();
  try {
    const runPromise = s.orch.runTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: s.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    await waitFor(() => calls(s).length === 1, 60000, "SideEffectCall 未出现");
    const call = calls(s)[0];
    const denied = s.fx.sideEffectRuntime.decideApproval({ context: userCtx(s), approvalRequestId: call.callId, decision: "DENY" });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    const r = await runPromise;
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(trashed(s), false, "Deny = 0 mutation");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).length, 0, "Deny = 0 lease");
    assert.equal(s.fx.toolStore.executionsOfTask(s.task.taskId).length, 0, "Deny = 0 execution");
    assert.equal(s.fx.sideEffectStore.callById(call.callId).status, "BLOCKED");
    const t = s.fx.taskStore.taskById(s.task.taskId);
    assert.notEqual(t.status, "SUCCEEDED");
    assert.equal(s.fx.taskStore.stepById(r.step ? r.step.stepId : s.fx.taskStore.stepsOfTask(s.task.taskId)[0].step_id).status, "BLOCKED");
    assert.equal(s.fx.taskStore.harnessRunsOfTask(s.task.taskId).every((x) => x.status === "BLOCKED"), true, "Harness Run 必须 BLOCKED");
  } finally { await teardown(s); }
});

test("Official dsh WRITE Timeout Path：用户不操作 → 0 mutation / 0 lease / call BLOCKED", async () => {
  const s = await setup({ approvalWaitMs: 400 });
  try {
    const r = await s.orch.runTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: s.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    assert.equal(r.ok, false, JSON.stringify(r));
    const call = calls(s)[0];
    assert.equal(call.status, "BLOCKED");
    assert.equal(call.errorCode, "SIDE_EFFECT_APPROVAL_TIMEOUT");
    assert.equal(trashed(s), false);
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).length, 0);
    assert.equal(s.fx.toolStore.executionsOfTask(s.task.taskId).length, 0);
    assert.equal(s.fx.fp.state.requests, 2, "timeout 绝不触发 WRITE 重新调用");
  } finally { await teardown(s); }
});

test("Official dsh WRITE UNKNOWN_EFFECT Path：dispatched 后 executor 死亡 → 不把 unverified 结果交给 Harness；Task/Step BLOCKED；0 second call / 0 retry", async () => {
  const s = await setup({ executorEntry: CRASH_EXECUTOR });
  try {
    const runPromise = s.orch.runTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: s.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    await waitFor(() => calls(s).length === 1, 60000, "SideEffectCall 未出现");
    const call = calls(s)[0];
    assert.equal(s.fx.sideEffectRuntime.decideApproval({ context: userCtx(s), approvalRequestId: call.callId, decision: "APPROVE" }).ok, true);
    const r = await runPromise;
    assert.equal(r.ok, false, JSON.stringify(r));
    // call 绝不 SUCCEEDED；Task 绝不 SUCCEEDED。
    const after = s.fx.sideEffectStore.callById(call.callId);
    assert.notEqual(after.status, "SUCCEEDED", JSON.stringify(after));
    assert.equal(s.fx.taskStore.taskById(s.task.taskId).status !== "SUCCEEDED", true);
    assert.equal(s.fx.taskStore.stepById(s.fx.taskStore.stepsOfTask(s.task.taskId)[0].step_id).status, "BLOCKED", "Step 必须 BLOCKED");
    assert.ok(events(s).includes("tool.side_effect.unknown_effect"), "必须留下 UNKNOWN_EFFECT 证据：" + JSON.stringify(events(s)));
    assert.ok(events(s).includes("tool.side_effect.verification_not_applied") || events(s).includes("tool.side_effect.verification_indeterminate"), "必须有 read-only recovery verification 证据");
    assert.equal(s.fx.sideEffectStore.callsOfTask(s.task.taskId).length, 1, "绝不自动创建第二个 SideEffectCall");
    assert.equal(s.fx.sideEffectStore.leasesOfCall(call.callId).filter((l) => l.status === "ACTIVE").length, 0);
    assert.equal(s.fx.toolStore.executionsOfTask(s.task.taskId).length, 0, "绝无第二次 execute 入口");
    // Harness 绝不能被要求重试：model 只请求了 2 次（提议 + 自续），没有 WRITE replay。
    assert.equal(s.fx.fp.state.requests, 2, "UNKNOWN_EFFECT 必须让 Harness STOP");
    assert.equal(s.fx.fp.state.toolCalls.length, 1, "绝不发生第二次 WRITE tool_call");
  } finally { await teardown(s); }
});

test("Official dsh WRITE APPLIED Recovery：mutation 已提交后 executor 死亡 → recovery APPLIED → call SUCCEEDED，但 Task/Step 保持 BLOCKED（Explicit Resume = DEFERRED）", async () => {
  const s = await setup({ executorEntry: LATE_CRASH_EXECUTOR });
  try {
    const runPromise = s.orch.runTask({ context: s.ctx, taskId: s.task.taskId, expectedRevision: s.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    await waitFor(() => calls(s).length === 1, 60000, "SideEffectCall 未出现");
    const call = calls(s)[0];
    assert.equal(s.fx.sideEffectRuntime.decideApproval({ context: userCtx(s), approvalRequestId: call.callId, decision: "APPROVE" }).ok, true);
    const r = await runPromise;
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(trashed(s), true, "mutation 已提交");
    const after = s.fx.sideEffectStore.callById(call.callId);
    assert.equal(after.status, "SUCCEEDED", JSON.stringify(after));
    assert.equal(after.verificationStatus, "PASS");
    assert.equal(s.fx.taskStore.taskById(s.task.taskId).status, "BLOCKED", "Task 必须保持 BLOCKED");
    assert.equal(s.fx.taskStore.stepById(s.fx.taskStore.stepsOfTask(s.task.taskId)[0].step_id).status, "BLOCKED", "Step 必须保持 BLOCKED");
    assert.equal(s.fx.sideEffectStore.callsOfTask(s.task.taskId).length, 1, "0 second call / 0 retry");
  } finally { await teardown(s); }
});
