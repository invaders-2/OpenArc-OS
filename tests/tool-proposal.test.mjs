/** D4-03A · Tool Proposal / Decision：持久化、幂等、stale、终态、schema、NOT_EXECUTED。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

async function withFixture(fn) {
  const fx = await createToolHarnessFixture();
  try { return await fn(fx); } finally { await fx.close(); }
}
function advanceToRunning(fx, ctx, t) {
  const s1 = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  const c = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s1.task.revision });
  const s2 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: c.step.stepId, expectedRevision: c.task.revision });
  return { task: s2.task, stepId: c.step.stepId };
}

test("READ_ONLY proposal → ALLOWED + ExecutionPlan(dry-run) + NOT_EXECUTED", async () => withFixture(async (fx) => {
  const ctx = fx.ctx();
  const t = fx.createTask();
  const r = fx.toolProxy.propose({ context: ctx, taskId: t.task.taskId, stepId: "step_1", toolId: "test.echo", toolVersion: 1, arguments: { message: "hello" }, proposalId: "prop_ok_1" });
  assert.equal(r.decisionStatus, "ALLOWED");
  assert.equal(r.reasonCode, "ALLOW");
  assert.equal(r.executionStatus, "NOT_EXECUTED");
  assert.equal(r.executed, false);
  assert.equal(r.executionPlan.dryRun, true);
  assert.equal(r.executionPlan.execute, false);
  assert.equal(r.executionPlan.toolId, "test.echo");
  assert.equal(r.executionPlan.riskClass, "READ_ONLY");
  assert.equal(r.executionPlan.approvalRequired, false);
  const props = fx.toolStore.proposalsOfTask(t.task.taskId);
  assert.equal(props.length, 1);
  assert.equal(props[0].status, "VALIDATED");
  assert.equal(props[0].tool_id, "test.echo");
  assert.equal(props[0].tool_version, 1);
  assert.ok(props[0].arguments_hash);
  const decs = fx.toolStore.decisionsOfTask(t.task.taskId);
  assert.equal(decs.length, 1);
  assert.equal(decs[0].decision, "ALLOWED");
  assert.equal(decs[0].risk_class, "READ_ONLY");
}));

test("WRITE proposal → APPROVAL_REQUIRED + approvalRequired，仍 NOT_EXECUTED", async () => withFixture(async (fx) => {
  const ctx = fx.ctx();
  const t = fx.createTask();
  const r = fx.toolProxy.propose({ context: ctx, taskId: t.task.taskId, toolId: "test.write", toolVersion: 1, arguments: { target: "x" }, proposalId: "prop_write_1" });
  assert.equal(r.decisionStatus, "APPROVAL_REQUIRED");
  assert.equal(r.reasonCode, "TOOL_APPROVAL_REQUIRED");
  assert.equal(r.decision.approvalRequired, true);
  assert.equal(r.decision.riskClass, "REVERSIBLE_WRITE");
  assert.equal(r.executionPlan.approvalRequired, true);
  assert.equal(r.executionStatus, "NOT_EXECUTED");
  const decs = fx.toolStore.decisionsOfTask(t.task.taskId);
  assert.equal(decs[0].approval_required, 1);
}));

test("unknown / wrong version / schema invalid / forbidden field", async () => withFixture(async (fx) => {
  const ctx = fx.ctx();
  const t = fx.createTask();
  const p = (over) => fx.toolProxy.propose({ context: ctx, taskId: t.task.taskId, toolId: "test.echo", toolVersion: 1, arguments: { message: "hi" }, ...over });
  assert.equal(p({ toolId: "../../shell" }).reasonCode, "TOOL_NOT_FOUND");
  assert.equal(p({ toolId: "shell.exec" }).reasonCode, "TOOL_NOT_FOUND");
  assert.equal(p({ toolId: "test.echo", toolVersion: 99 }).reasonCode, "TOOL_VERSION_UNSUPPORTED");
  const inv = p({ ticket: 1, arguments: {} });
  assert.equal(inv.decisionStatus, "INVALID");
  assert.equal(inv.reasonCode, "TOOL_ARGUMENT_INVALID");
  const secret = p({ arguments: { message: "hi", apiKey: "FAKE_SECRET_VALUE" } });
  assert.equal(secret.decisionStatus, "INVALID");
  assert.equal(secret.reasonCode, "TOOL_ARGUMENT_INVALID");
  assert.ok(!JSON.stringify(fx.toolStore.proposalsOfTask(t.task.taskId)).includes("FAKE_SECRET_VALUE"));
}));

test("duplicate proposalId 幂等：不生成第二个 decision", async () => withFixture(async (fx) => {
  const ctx = fx.ctx();
  const t = fx.createTask();
  const args = { context: ctx, taskId: t.task.taskId, toolId: "test.echo", toolVersion: 1, arguments: { message: "dup" }, proposalId: "prop_dup" };
  const r1 = fx.toolProxy.propose(args);
  const r2 = fx.toolProxy.propose(args);
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.equal(r2.decision.decisionId, r1.decision.decisionId);
  assert.equal(fx.toolStore.proposalsOfTask(t.task.taskId).length, 1);
  assert.equal(fx.toolStore.decisionsOfTask(t.task.taskId).length, 1);
}));

test("stale run → BLOCKED TOOL_PROPOSAL_STALE；当前 run 允许", async () => withFixture(async (fx) => {
  const ctx = fx.ctx();
  const t = fx.createTask();
  const { task, stepId } = advanceToRunning(fx, ctx, t);
  const run1 = fx.taskService.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId, expectedRevision: task.revision });
  const run2 = fx.taskService.startHarnessRun({ context: ctx, taskId: t.task.taskId, stepId, expectedRevision: run1.task.revision });
  const stale = fx.toolProxy.propose({ context: ctx, taskId: t.task.taskId, stepId, runId: run1.run.runId, toolId: "test.echo", toolVersion: 1, arguments: { message: "x" }, proposalId: "prop_stale" });
  assert.equal(stale.decisionStatus, "BLOCKED");
  assert.equal(stale.reasonCode, "TOOL_PROPOSAL_STALE");
  const current = fx.toolProxy.propose({ context: ctx, taskId: t.task.taskId, stepId, runId: run2.run.runId, toolId: "test.echo", toolVersion: 1, arguments: { message: "x" }, proposalId: "prop_current" });
  assert.equal(current.decisionStatus, "ALLOWED");
}));

test("completed / cancelled task 收到 proposal → DENY / BLOCK", async () => withFixture(async (fx) => {
  const ctx = fx.ctx();
  const t1 = fx.createTask();
  const s1 = fx.taskService.startTask({ context: ctx, taskId: t1.task.taskId, expectedRevision: t1.task.revision });
  const done = fx.taskService.completeTask({ context: ctx, taskId: t1.task.taskId, expectedRevision: s1.task.revision });
  assert.equal(done.ok, true);
  const term = fx.toolProxy.propose({ context: ctx, taskId: t1.task.taskId, toolId: "test.echo", toolVersion: 1, arguments: { message: "x" }, proposalId: "prop_term" });
  assert.equal(term.decisionStatus, "DENIED");
  assert.equal(term.reasonCode, "TASK_TERMINAL");

  const t2 = fx.createTask();
  const s2 = fx.taskService.startTask({ context: ctx, taskId: t2.task.taskId, expectedRevision: t2.task.revision });
  fx.taskService.cancelTask({ context: ctx, taskId: t2.task.taskId, expectedRevision: s2.task.revision });
  const cancelled = fx.toolProxy.propose({ context: ctx, taskId: t2.task.taskId, toolId: "test.echo", toolVersion: 1, arguments: { message: "x" }, proposalId: "prop_cancel" });
  assert.equal(cancelled.decisionStatus, "BLOCKED");
  assert.equal(cancelled.reasonCode, "TASK_CANCELLED");
}));

test("risk 来自 Registry：Harness 自报 risk 无效（schema 拒绝），decision 不变", async () => withFixture(async (fx) => {
  const ctx = fx.ctx();
  const t = fx.createTask();
  const spoof = fx.toolProxy.propose({ context: ctx, taskId: t.task.taskId, toolId: "test.echo", toolVersion: 1, arguments: { message: "hi", risk: "READ_ONLY", riskClass: "READ_ONLY" }, proposalId: "prop_risk_spoof" });
  assert.equal(spoof.decisionStatus, "INVALID");
  const plain = fx.toolProxy.propose({ context: ctx, taskId: t.task.taskId, toolId: "test.echo", toolVersion: 1, arguments: { message: "hi" }, proposalId: "prop_risk_plain" });
  assert.equal(plain.decision.riskClass, "READ_ONLY");
}));
