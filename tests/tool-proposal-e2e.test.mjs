/** D4-03A · Tool Proposal E2E：Task → Harness(ACP tool_call) → Orchestrator → Tool Proxy → Decision；0 execution。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const eventsOf = (fx, ctx, taskId) => fx.taskService.getEvents({ context: ctx, taskId }).items.map((e) => e.eventType);

test("E2E READ_ONLY tool proposal：ALLOWED decision + Task BLOCKED TOOL_EXECUTION_NOT_AVAILABLE + 0 execution", async () => {
  const fx = await createToolHarnessFixture();
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeToolOrchestrator();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput: { proposeTool: { toolId: "test.echo", toolVersion: 1, arguments: { message: "hello" }, proposalId: "e2e_echo" } } });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, "TOOL_EXECUTION_NOT_AVAILABLE");
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(r.step.status, "BLOCKED");
    const props = fx.toolStore.proposalsOfTask(t.task.taskId);
    assert.equal(props.length, 1);
    assert.equal(props[0].tool_id, "test.echo");
    const decs = fx.toolStore.decisionsOfTask(t.task.taskId);
    assert.equal(decs.length, 1);
    assert.equal(decs[0].decision, "ALLOWED");
    assert.equal(decs[0].risk_class, "READ_ONLY");
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0, "0 execution / 0 artifact");
    const ev = eventsOf(fx, ctx, t.task.taskId);
    for (const need of ["harness.tool_proposed", "tool.proposed", "tool.validated", "tool.execution_blocked", "step.blocked", "task.blocked"]) assert.ok(ev.includes(need), "missing " + need);
  } finally { await fx.close(); }
});

test("E2E resource tool proposal：D3 授权通过 → decision ALLOWED，仍 0 execution", async () => {
  const fx = await createToolHarnessFixture();
  try {
    const created = await fx.createResource("E2E Target");
    fx.grantTool("ai", ["tool.resource.readMetadata"]);
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeToolOrchestrator();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput: { proposeTool: { toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef: created.resource.resourceRef }, proposalId: "e2e_resource" } } });
    assert.equal(r.error, "TOOL_EXECUTION_NOT_AVAILABLE", JSON.stringify(r));
    const decs = fx.toolStore.decisionsOfTask(t.task.taskId);
    assert.equal(decs[0].decision, "ALLOWED");
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0);
  } finally { await fx.close(); }
});

test("E2E WRITE tool proposal → APPROVAL_REQUIRED → Task WAITING（0 execution）", async () => {
  const fx = await createToolHarnessFixture();
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeToolOrchestrator();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput: { proposeTool: { toolId: "test.write", toolVersion: 1, arguments: { target: "x" }, proposalId: "e2e_write" } } });
    assert.equal(r.error, "TOOL_APPROVAL_REQUIRED");
    assert.equal(r.approvalRequired, true);
    assert.equal(r.task.status, "WAITING");
    assert.equal(r.step.status, "BLOCKED");
    const decs = fx.toolStore.decisionsOfTask(t.task.taskId);
    assert.equal(decs[0].decision, "APPROVAL_REQUIRED");
    assert.equal(decs[0].approval_required, 1);
    const ev = eventsOf(fx, ctx, t.task.taskId);
    assert.ok(ev.includes("tool.approval_required"));
    assert.ok(ev.includes("task.waiting"));
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0);
  } finally { await fx.close(); }
});

test("E2E 未注册 / 注入 toolId → BLOCKED，0 execution", async () => {
  const fx = await createToolHarnessFixture();
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeToolOrchestrator();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput: { proposeTool: { toolId: "shell.exec", toolVersion: 1, arguments: { command: "rm -rf /" }, proposalId: "e2e_shell" } } });
    assert.equal(r.error, "TOOL_NOT_FOUND");
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0);
    const ev = eventsOf(fx, ctx, t.task.taskId);
    assert.ok(ev.includes("tool.denied"));
    assert.ok(!ev.includes("tool.validated"));
  } finally { await fx.close(); }
});
