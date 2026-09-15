/**
 * D4-03C2 · Negative E2E / Cancel-Revoke-Expiry-Stale Gates。
 *
 * 每一条 gate 失败都必须：0 Domain mutation、call 不 SUCCEEDED、lease ownership 不泄漏。
 * D4-03C2 Closure：execute 必须携带完整 executor identity（leaseId + holderId + holderInstanceId）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSideEffectFixture, TRASH_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";

function countDeleteCalls(fx) {
  const real = fx.fx.f.resourceService.delete.bind(fx.fx.f.resourceService);
  const box = { calls: 0 };
  fx.fx.f.resourceService.delete = (args) => { box.calls += 1; return real(args); };
  return box;
}

/** 建立一条 APPROVED+LEASED 的真实 trash call，再注入 gate 失败，然后尝试 execute。 */
async function attempt({ now = null, ttlMs = undefined, leaseTtlMs = undefined, holderId = "exec_1", skipApprove = false, skipLease = false } = {}) {
  const fx = now ? await createSideEffectFixture({ sideEffectClock: () => now.value }) : await createSideEffectFixture();
  const sc = await fx.setupTrash();
  const dc = countDeleteCalls(fx);
  const prop = fx.toolProxy.propose({ context: fx.ctx(), taskId: sc.run.taskId, stepId: sc.run.stepId, runId: sc.run.runId, toolId: TRASH_TOOL, toolVersion: 1, arguments: { resourceRef: sc.resourceRef } });
  const plan = await fx.authority.planSideEffect({ context: fx.ctx(), taskId: sc.run.taskId, stepId: sc.run.stepId, runId: sc.run.runId, toolId: TRASH_TOOL, arguments: { resourceRef: sc.resourceRef }, proposalId: prop.proposal.proposalId, decisionId: prop.decision.decisionId });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const approval = skipApprove ? null : fx.approve(plan.call.callId, ttlMs ? { ttlMs } : {});
  const lease = skipLease ? null : fx.lease(plan.call.callId, { holderId, ...(leaseTtlMs ? { ttlMs: leaseTtlMs } : {}) });
  const l = lease && lease.ok ? lease.lease : null;
  const execId = { callId: plan.call.callId, leaseId: l ? l.leaseId : "slease_missing", holderId: (l && l.holderId) || holderId, holderInstanceId: l ? l.holderInstanceId : fx.authority.instanceId };
  return { fx, sc, dc, prop, plan, approval, lease, execId, callId: plan.call.callId };
}

async function expectZeroMutation(ctx, exec, expectedError) {
  assert.equal(ctx.dc.calls, 0, "0 Domain mutation；实际 " + ctx.dc.calls);
  assert.equal(exec.ok, false, JSON.stringify(exec));
  assert.notEqual(exec.call && exec.call.status, "SUCCEEDED");
  if (expectedError) assert.ok(String(exec.error).includes(expectedError), "expected " + expectedError + " got " + exec.error);
}
const runExec = (ctx, override = {}) => ctx.fx.authority.executeSideEffect({ ...ctx.execId, ...override });

test("No approval → 0 mutation", async () => {
  const ctx = await attempt({ skipApprove: true });
  try {
    assert.equal(ctx.lease.ok, false, "无 approval 不能 acquire lease");
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_CALL_STATE");
  } finally { await ctx.fx.fx.close(); }
});

test("Approval expired → 0 mutation", async () => {
  const now = { value: 1_000_000 };
  const ctx = await attempt({ now, ttlMs: 1000 });
  try {
    assert.equal(ctx.lease.ok, true, JSON.stringify(ctx.lease));
    now.value += 60_000;
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_APPROVAL_EXPIRED");
  } finally { await ctx.fx.fx.close(); }
});

test("Approval revoke → 0 mutation", async () => {
  const ctx = await attempt();
  try {
    assert.equal(ctx.fx.revokeApproval(ctx.callId).ok, true);
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_APPROVAL_REVOKED");
  } finally { await ctx.fx.fx.close(); }
});

test("No lease → 0 mutation", async () => {
  const ctx = await attempt({ skipLease: true });
  try {
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_CALL_STATE");
  } finally { await ctx.fx.fx.close(); }
});

test("Wrong holder → 0 mutation", async () => {
  const ctx = await attempt({ holderId: "exec_1" });
  try {
    await expectZeroMutation(ctx, runExec(ctx, { holderId: "exec_other" }), "SIDE_EFFECT_LEASE_NOT_HELD");
  } finally { await ctx.fx.fx.close(); }
});

test("Lease expire → 0 mutation", async () => {
  const now = { value: 1_000_000 };
  const ctx = await attempt({ now, leaseTtlMs: 1000 });
  try {
    assert.equal(ctx.lease.ok, true, JSON.stringify(ctx.lease));
    now.value += 5000;
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_LEASE_EXPIRED");
  } finally { await ctx.fx.fx.close(); }
});

test("Lease revoke → 0 mutation", async () => {
  const ctx = await attempt();
  try {
    assert.equal(ctx.fx.authority.revokeLease({ callId: ctx.callId, leaseId: ctx.lease.lease.leaseId }).ok, true);
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_LEASE_REQUIRED");
  } finally { await ctx.fx.fx.close(); }
});

test("Wrong leaseId → 0 mutation", async () => {
  const ctx = await attempt();
  try {
    await expectZeroMutation(ctx, runExec(ctx, { leaseId: "slease_does_not_exist" }), "SIDE_EFFECT_LEASE_NOT_HELD");
  } finally { await ctx.fx.fx.close(); }
});

test("Task cancelled → 0 mutation", async () => {
  const ctx = await attempt();
  try {
    const t = ctx.fx.taskService.getTask({ context: ctx.fx.ctx(), taskId: ctx.sc.run.taskId }).task;
    assert.equal(ctx.fx.taskService.cancelTask({ context: ctx.fx.ctx(), taskId: ctx.sc.run.taskId, expectedRevision: t.revision }).ok, true);
    await expectZeroMutation(ctx, runExec(ctx), "TASK_CANCELLED");
  } finally { await ctx.fx.fx.close(); }
});

test("Session revoked → 0 mutation", async () => {
  const ctx = await attempt();
  try {
    ctx.fx.fx.f.identity.logout(ctx.fx.fx.f.sessions.admin);
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_AUTHORIZATION_REVOKED");
  } finally { await ctx.fx.fx.close(); }
});

test("App disable → 0 mutation", async () => {
  const ctx = await attempt();
  try {
    ctx.fx.fx.f.store.setAppStatus("ai", "disabled");
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_APP_DISABLED");
  } finally { await ctx.fx.fx.close(); }
});

test("Tool permission revoke → 0 mutation", async () => {
  const ctx = await attempt();
  try {
    const rev = ctx.fx.fx.f.authService.revokeAppResourcePermission({ context: ctx.fx.fx.f.adminCtx(), grantId: ctx.sc.toolGrant.grant.grantId });
    assert.equal(rev.ok, true, JSON.stringify(rev));
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_AUTHORIZATION_REVOKED");
  } finally { await ctx.fx.fx.close(); }
});

test("Resource permission revoked（USER grant, non-admin）→ 0 mutation", async () => {
  const fx = await createSideEffectFixture();
  try {
    const sc = await fx.setupTrash();
    const aliceCtx = { sessionRef: fx.fx.f.sessions.alice, appId: "ai", source: "test" };
    const ag = fx.fx.f.authService.grantResourcePermission({ context: fx.fx.f.adminCtx(), principalType: "USER", principalId: fx.fx.f.users.alice, resourceId: sc.resourceId, actions: ["resource.delete", "resource.useByAgent"] });
    assert.equal(ag.ok, true, JSON.stringify(ag));
    const run = fx.fx.dshRunSetup(aliceCtx);
    const dc = countDeleteCalls(fx);
    const prop = fx.toolProxy.propose({ context: aliceCtx, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, toolVersion: 1, arguments: { resourceRef: sc.resourceRef } });
    const plan = await fx.authority.planSideEffect({ context: aliceCtx, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, arguments: { resourceRef: sc.resourceRef }, proposalId: prop.proposal.proposalId, decisionId: prop.decision.decisionId });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(fx.authority.approveSideEffect({ context: { sessionRef: fx.fx.f.sessions.alice, appId: "ai", source: "user" }, callId: plan.call.callId }).ok, true);
    const lease = fx.authority.acquireLease({ context: aliceCtx, callId: plan.call.callId, holderId: "exec_1" });
    assert.equal(lease.ok, true, JSON.stringify(lease));
    const execId = { callId: plan.call.callId, leaseId: lease.lease.leaseId, holderId: "exec_1", holderInstanceId: lease.lease.holderInstanceId };
    assert.equal(fx.authority.evaluateExecutionEligibility({ context: aliceCtx, callId: plan.call.callId, holderId: "exec_1", holderInstanceId: lease.lease.holderInstanceId }).status, "ELIGIBLE");
    const rev = fx.fx.f.authService.revokeResourcePermission({ context: fx.fx.f.adminCtx(), grantId: ag.grant.id });
    assert.equal(rev.ok, true, JSON.stringify(rev));
    const exec = await fx.authority.executeSideEffect({ ...execId });
    assert.equal(dc.calls, 0);
    assert.equal(exec.ok, false);
    assert.ok(String(exec.error).includes("SIDE_EFFECT_AUTHORIZATION_REVOKED"), JSON.stringify(exec));
  } finally { await fx.fx.close(); }
});

test("Tool disabled → 0 mutation", async () => {
  const ctx = await attempt();
  try {
    ctx.fx.toolRegistry.tools.set(TRASH_TOOL + "@1", { ...ctx.fx.toolRegistry.get(TRASH_TOOL, 1), enabled: false });
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_TOOL_DISABLED");
  } finally { await ctx.fx.fx.close(); }
});

test("Tool version change → 0 mutation", async () => {
  const ctx = await attempt();
  try {
    ctx.fx.toolRegistry.register({ ...ctx.fx.toolRegistry.get(TRASH_TOOL, 1), version: 2 });
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_TOOL_VERSION_CHANGED");
  } finally { await ctx.fx.fx.close(); }
});

test("Stale run → 0 mutation", async () => {
  const ctx = await attempt();
  try {
    const c = ctx.fx.ctx();
    const task = ctx.fx.taskStore.taskById(ctx.sc.run.taskId);
    const step = ctx.fx.taskService.createStep({ context: c, taskId: ctx.sc.run.taskId, kind: "reasoning", input: null, expectedRevision: task.revision });
    const ss = ctx.fx.taskService.startStep({ context: c, taskId: ctx.sc.run.taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
    assert.equal(ctx.fx.taskService.startHarnessRun({ context: c, taskId: ctx.sc.run.taskId, stepId: step.step.stepId, expectedRevision: ss.task.revision }).ok, true);
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_STALE_RUN");
  } finally { await ctx.fx.fx.close(); }
});

test("Plan / approval binding changed（planHash 不匹配）→ 0 mutation", async () => {
  const ctx = await attempt();
  try {
    const far = Date.now() + 100_000;
    ctx.fx.store.transactSync(() => ctx.fx.store.insertApproval({ callId: ctx.callId, actorUserId: "u", sessionRef: ctx.fx.fx.f.sessions.admin, decision: "APPROVED", planHash: "tampered", createdAt: far, expiresAt: far + 100_000 }));
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_PLAN_STALE");
  } finally { await ctx.fx.fx.close(); }
});

test("Resource version / precondition changed → 0 mutation", async () => {
  const ctx = await attempt();
  try {
    const bumped = await ctx.fx.fx.f.resourceService.replaceText({ context: ctx.fx.fx.f.adminCtx(), resourceRef: ctx.sc.resourceRef, text: "edited", expectedVersion: 1 });
    assert.equal(bumped.ok, true, JSON.stringify(bumped));
    await expectZeroMutation(ctx, runExec(ctx), "SIDE_EFFECT_PRECONDITION_CHANGED");
  } finally { await ctx.fx.fx.close(); }
});

test("Unsupported effectClass（IRREVERSIBLE / EXTERNAL / PRIVILEGED）→ 0 call / 0 mutation", async () => {
  const fx = await createSideEffectFixture();
  try {
    const run = fx.setupRun();
    const dc = countDeleteCalls(fx);
    for (const [i, risk] of ["IRREVERSIBLE_WRITE", "EXTERNAL_SIDE_EFFECT", "PRIVILEGED"].entries()) {
      const toolId = "test.c2blocked" + i;
      fx.toolRegistry.register({ ...fx.toolRegistry.get(TRASH_TOOL, 1), toolId, version: 1, riskClass: risk, requiredPermissions: [], resourceActions: ["resource.delete"], executionPolicy: null });
      const p = await fx.plan(toolId, { resourceRef: "resource://abc" }, run);
      assert.equal(p.ok, false, risk);
      assert.equal(p.error, "SIDE_EFFECT_EFFECT_CLASS_BLOCKED");
    }
    assert.equal(fx.store.callsOfTask(run.taskId).length, 0);
    assert.equal(dc.calls, 0);
  } finally { await fx.fx.close(); }
});

test("Harness spoof on resource.trash → TOOL_ARGUMENT_INVALID / 0 call / 0 mutation", async () => {
  const fx = await createSideEffectFixture();
  try {
    const sc = await fx.setupTrash();
    const dc = countDeleteCalls(fx);
    for (const spoof of [{ resourceRef: sc.resourceRef, approved: true }, { resourceRef: sc.resourceRef, approvalId: "x" }, { resourceRef: sc.resourceRef, leaseId: "x" }, { resourceRef: sc.resourceRef, callId: "x" }, { resourceRef: sc.resourceRef, idempotencyKey: "x" }, { resourceRef: sc.resourceRef, expectedVersion: 1 }, { resourceRef: sc.resourceRef, holderInstanceId: "x" }, { resourceRef: sc.resourceRef, effectClass: "REVERSIBLE_WRITE" }]) {
      const p = await fx.authority.planSideEffect({ context: fx.ctx(), taskId: sc.run.taskId, stepId: sc.run.stepId, runId: sc.run.runId, toolId: TRASH_TOOL, arguments: spoof });
      assert.equal(p.ok, false, JSON.stringify(p));
      assert.equal(p.error, "TOOL_ARGUMENT_INVALID");
    }
    assert.equal(fx.store.callsOfTask(sc.run.taskId).length, 0);
    assert.equal(dc.calls, 0);
  } finally { await fx.fx.close(); }
});
