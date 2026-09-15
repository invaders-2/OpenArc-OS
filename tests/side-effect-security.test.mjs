/** D4-03C1 · Security：Harness spoof / WRITE 边界 / 实时 reauthorization / cancel / stale run / secret scan。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSideEffectFixture, WRITE_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";
import { PROVIDER_SECRET } from "./fixtures/harness-acp/task-harness-fixture.mjs";

const TABLES = ["side_effect_calls", "tool_approvals", "side_effect_leases", "task_tool_proposals", "tool_decisions", "tool_executions", "task_events", "authorization_audit"];
function dumpDb(identity) { let text = ""; for (const t of TABLES) { try { for (const row of identity.connection.prepare("SELECT * FROM " + t).all()) text += JSON.stringify(row) + "\n"; } catch { /* ignore */ } } return text; }

async function approvedLeased(opts = {}) {
  const fx = await createSideEffectFixture(opts);
  const run = fx.setupRun(opts.context || null);
  const p = await fx.plan(WRITE_TOOL, { target: "doc-1" }, run);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(fx.approve(p.call.callId, opts.approve || {}).ok, true);
  assert.equal(fx.lease(p.call.callId, { holderId: "exec_1", ...(opts.lease || {}) }).ok, true);
  return { fx, run, call: p.call };
}

test("Harness spoof：approved/approvalId/leaseId/callId/idempotencyKey/effectClass → TOOL_ARGUMENT_INVALID，0 call", async () => {
  const fx = await createSideEffectFixture();
  try {
    const run = fx.setupRun();
    for (const spoof of [{ target: "x", approved: true }, { target: "x", approvalId: "fake" }, { target: "x", leaseId: "fake" }, { target: "x", callId: "scall_fake" }, { target: "x", idempotencyKey: "idem_fake" }, { target: "x", effectClass: "REVERSIBLE_WRITE" }, { target: "x", expectedEffects: ["fake"] }]) {
      const p = await fx.plan(WRITE_TOOL, spoof, run);
      assert.equal(p.ok, false, JSON.stringify(p));
      assert.equal(p.error, "TOOL_ARGUMENT_INVALID");
    }
    assert.equal(fx.store.callsOfTask(run.taskId).length, 0, "spoof payload 不能创建 authority call");
  } finally { await fx.fx.close(); }
});

test("OpenArc 生成 callId/idempotencyKey/expectedEffects；Harness 只提供 args", async () => {
  const { fx, call } = await approvedLeased();
  try {
    assert.match(call.callId, /^scall_/);
    assert.match(call.idempotencyKey, /^idem_/);
    assert.ok(Array.isArray(call.expectedEffectsSafe) && call.expectedEffectsSafe.length >= 1);
    assert.equal(call.expectedEffectsSafe[0].action, "update", "expectedEffects 由 adapter.plan 生成");
  } finally { await fx.fx.close(); }
});

test("WRITE execution boundary：executeSideEffect / executeReadOnly 都 WRITE_EXECUTION_DISABLED + 0 mutation", async () => {
  const { fx, run, call } = await approvedLeased();
  try {
    const e = fx.authority.executeSideEffect({ callId: call.callId });
    assert.equal(e.ok, false);
    assert.equal(e.error, "WRITE_EXECUTION_DISABLED");
    assert.equal(e.mutationCount, 0);
    const proxyPropose = fx.toolProxy.propose({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: WRITE_TOOL, toolVersion: 1, arguments: { target: "doc-1" } });
    assert.equal(proxyPropose.decisionStatus, "APPROVAL_REQUIRED");
    const r = await fx.toolProxy.executeReadOnly({ context: fx.ctx(), taskId: run.taskId, proposalId: proxyPropose.proposal.proposalId });
    assert.equal(r.ok, false);
    assert.equal(r.error, "WRITE_EXECUTION_DISABLED");
    assert.equal(fx.toolStore.executionsOfTask(run.taskId).length, 0);
  } finally { await fx.fx.close(); }
});

test("Session revoke → eligibility AUTHORIZATION_REVOKED", async () => {
  const { fx, call } = await approvedLeased();
  try {
    const before = fx.elig(call.callId).status;
    assert.equal(before, "ELIGIBLE");
    fx.fx.f.identity.logout(fx.userCtx().sessionRef);
    const e = fx.elig(call.callId);
    assert.equal(e.status, "DENIED");
    assert.equal(e.reasonCode, "SIDE_EFFECT_AUTHORIZATION_REVOKED");
  } finally { await fx.fx.close(); }
});

test("App disable → eligibility APP_DISABLED", async () => {
  const { fx, call } = await approvedLeased();
  try {
    fx.fx.f.store.setAppStatus("ai", "disabled");
    const e = fx.elig(call.callId);
    assert.equal(e.status, "DENIED");
    assert.equal(e.reasonCode, "SIDE_EFFECT_APP_DISABLED");
  } finally { await fx.fx.close(); }
});

test("Permission revoke（tool grant）→ eligibility AUTHORIZATION_REVOKED", async () => {
  const fx = await createSideEffectFixture();
  try {
    const contract = fx.registerResourceWriteTool({ toolId: "test.resourcewrite", resourceActions: ["resource.read"] });
    const created = await fx.createResource("C1 Perm Target");
    const grant = fx.grantTool("ai", ["tool.resource.readMetadata"]);
    assert.equal(grant.ok, true, JSON.stringify(grant));
    const run = fx.setupRun();
    const p = await fx.plan("test.resourcewrite", { resourceRef: created.resource.resourceRef, text: "v2" }, run);
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(fx.approve(p.call.callId).ok, true);
    assert.equal(fx.lease(p.call.callId).ok, true);
    assert.equal(fx.elig(p.call.callId).status, "ELIGIBLE", JSON.stringify(fx.elig(p.call.callId)));
    const rev = fx.fx.f.authService.revokeAppResourcePermission({ context: fx.fx.f.adminCtx(), grantId: grant.grant.grantId });
    assert.equal(rev.ok, true, JSON.stringify(rev));
    const e = fx.elig(p.call.callId);
    assert.equal(e.status, "DENIED");
    assert.equal(e.reasonCode, "SIDE_EFFECT_AUTHORIZATION_REVOKED");
    void contract;
  } finally { await fx.fx.close(); }
});

test("useByAgent 缺失 → eligibility AUTHORIZATION_REVOKED（read 仍有效）", async () => {
  const fx = await createSideEffectFixture();
  try {
    fx.registerResourceWriteTool({ toolId: "test.resourcewrite", resourceActions: ["resource.read"] });
    const created = await fx.createResource("C1 useByAgent Target");
    const alice = { sessionRef: fx.fx.f.sessions.alice, appId: "ai" };
    const grant = fx.grantUserResource(created.resource.resourceId, fx.fx.f.users.alice, ["resource.read"]);
    assert.equal(grant.ok, true, JSON.stringify(grant));
    const run = fx.setupRun(alice);
    const p = await fx.plan("test.resourcewrite", { resourceRef: created.resource.resourceRef, text: "v2" }, run, { context: alice });
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(fx.approve(p.call.callId, { context: fx.aliceUserCtx() }).ok, true);
    assert.equal(fx.lease(p.call.callId).ok, true);
    const e = fx.elig(p.call.callId, { context: alice });
    assert.equal(e.status, "DENIED");
    assert.equal(e.reasonCode, "SIDE_EFFECT_AUTHORIZATION_REVOKED");
  } finally { await fx.fx.close(); }
});

test("Task cancel → eligibility TASK_CANCELLED", async () => {
  const { fx, run, call } = await approvedLeased();
  try {
    const c = fx.taskService.cancelTask({ context: fx.ctx(), taskId: run.taskId, expectedRevision: fx.taskService.getTask({ context: fx.ctx(), taskId: run.taskId }).task.revision });
    assert.equal(c.ok, true, JSON.stringify(c));
    const e = fx.elig(call.callId);
    assert.equal(e.status, "DENIED");
    assert.equal(e.reasonCode, "TASK_CANCELLED");
  } finally { await fx.fx.close(); }
});

test("Stale run → eligibility SIDE_EFFECT_STALE_RUN", async () => {
  const { fx, run, call } = await approvedLeased();
  try {
    const ctx = fx.ctx();
    const task = fx.taskStore.taskById(run.taskId);
    const step = fx.taskService.createStep({ context: ctx, taskId: run.taskId, kind: "reasoning", input: null, expectedRevision: task.revision });
    const ss = fx.taskService.startStep({ context: ctx, taskId: run.taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
    const newRun = fx.taskService.startHarnessRun({ context: ctx, taskId: run.taskId, stepId: step.step.stepId, expectedRevision: ss.task.revision });
    assert.equal(newRun.ok, true, JSON.stringify(newRun));
    const e = fx.elig(call.callId);
    assert.equal(e.status, "STALE");
    assert.equal(e.reasonCode, "SIDE_EFFECT_STALE_RUN");
  } finally { await fx.fx.close(); }
});

test("Tool disabled → planSideEffect TOOL_DISABLED", async () => {
  const fx = await createSideEffectFixture();
  try {
    fx.toolRegistry.register({ ...fx.toolRegistry.get(WRITE_TOOL, 1), toolId: "test.disabledwrite", version: 1, enabled: false });
    const run = fx.setupRun();
    const p = await fx.plan("test.disabledwrite", { target: "x" }, run);
    assert.equal(p.ok, false);
    assert.equal(p.error, "SIDE_EFFECT_TOOL_DISABLED");
  } finally { await fx.fx.close(); }
});

test("Secret scan：Provider Secret / mpx_ / tpx_ / 绝对路径 / store root 0 hit", async () => {
  const { fx, run } = await approvedLeased();
  try {
    const dump = dumpDb(fx.fx.f.identity);
    assert.ok(!dump.includes(PROVIDER_SECRET), "Provider Secret 不得落库");
    assert.ok(!dump.includes("mpx_"), "Model capability 不得落库");
    assert.ok(!dump.includes("tpx_"), "Tool facade capability 不得落库");
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders/.test(dump), "绝对路径不得落库");
    assert.ok(!dump.includes(fx.fx.f.storeRoot), "store root 不得落库");
    assert.ok(!/authorization: bearer|Bearer /i.test(dump), "raw Authorization 不得落库");
    void run;
  } finally { await fx.fx.close(); }
});
