/** D4-02C · Vertical E2E：真实 official DeepSeek Harness + ACP + Model Proxy + Fake Provider。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskHarnessFixture, EXACT, PROVIDER_SECRET } from "./fixtures/harness-acp/task-harness-fixture.mjs";

test("Vertical E2E：Task→Step→Harness→Proxy→Fake Provider→Artifact→Verification→SUCCEEDED", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "exact" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    assert.ok(t.ok, JSON.stringify(t));
    const r = await fx.orchestrator.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    assert.ok(r.ok, "runTask failed: " + JSON.stringify(r));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.equal(r.step.status, "SUCCEEDED");
    assert.equal(r.artifact.content, EXACT);
    assert.equal(r.verification.status, "PASS");

    assert.equal(fx.fp.state.requests, 1, "provider request count = 1（0 retry）");
    assert.equal(fx.fp.state.authHeaders[0], "Bearer " + PROVIDER_SECRET, "Fake Provider 收到 Provider key");

    const arts = fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId });
    assert.equal(arts.items.length, 1);
    assert.equal(arts.items[0].content, EXACT);

    const ev = fx.orchestrator.lastEvidence;
    assert.ok(ev.harnessVersion, "harness version");
    assert.equal(ev.protocolVersion, 1);
    assert.equal(ev.finalTaskRevision, r.task.revision);
    assert.equal(ev.modelConfigVersion, r.task.modelConfigVersion);

    const calls = fx.taskService.getCalls({ context: ctx, taskId: t.task.taskId });
    assert.equal(calls.items.length, 1);
    assert.equal(calls.items[0].status, "SUCCEEDED");
    assert.match(String(calls.items[0].requestId), /^mreq_hrun_/);

    const events = fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).items.map((e) => e.eventType);
    for (const need of ["harness.run.started", "harness.run.succeeded", "harness.text.delta", "artifact.created", "verification.completed", "step.succeeded", "task.succeeded"]) {
      assert.ok(events.includes(need), "missing event " + need);
    }
  } finally { await fx.close(); }
});

test("Tool proposal E2E：真实 ACP tool_call → 0 execution → BLOCKED", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "exact" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeOrchestrator(fx.agentFactory("tool-agent.mjs"));
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.ok, false);
    assert.equal(r.error, "TOOL_EXECUTION_NOT_AVAILABLE");
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0);
    const events = fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).items.map((e) => e.eventType);
    assert.ok(events.includes("harness.tool_proposed"));
    assert.ok(!events.includes("step.succeeded"));
  } finally { await fx.close(); }
});

test("Permission request E2E：真实 ACP request_permission → reject → BLOCKED", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "exact" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeOrchestrator(fx.agentFactory("permission-agent.mjs"));
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.ok, false);
    assert.equal(r.error, "PERMISSION_NOT_AVAILABLE");
    assert.equal(r.step.status, "BLOCKED");
    const events = fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).items.map((e) => e.eventType);
    assert.ok(events.includes("harness.permission_requested"));
    assert.ok(events.includes("harness.permission_rejected"));
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0);
  } finally { await fx.close(); }
});
