/** D4-03B · 执行安全：垂直 E2E + 全量 secret/path 扫描 + mutation 边界 + 0 外网。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
import { PROVIDER_SECRET } from "./fixtures/harness-acp/task-harness-fixture.mjs";

const TABLES = ["tasks", "task_steps", "task_events", "task_artifacts", "task_verifications", "task_harness_runs", "task_tool_proposals", "tool_decisions", "tool_executions", "authorization_audit"];
function dumpDb(identity) { let text = ""; for (const t of TABLES) { try { for (const row of identity.connection.prepare("SELECT * FROM " + t).all()) text += JSON.stringify(row) + "\n"; } catch { /* ignore */ } } return text; }

async function verticalFixture() {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "exact" });
  const created = await fx.createResource("Searchable Needle");
  await fx.f.searchService.indexResource(created.resource.resourceId);
  fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]);
  return { fx, resourceRef: created.resource.resourceRef, resourceId: created.resource.resourceId };
}

test("Vertical E2E：Task→Harness(ACP)→Proxy→search→read→verify→Artifact→SUCCEEDED", async () => {
  const { fx, resourceRef } = await verticalFixture();
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeToolOrchestrator();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput: { proposeSequence: [
      { toolId: "resource.search", toolVersion: 1, arguments: { query: "Searchable", limit: 5 }, proposalId: "e2e_search" },
      { toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: "e2e_read" },
    ], finalText: "OPENARC_TASK_OK" }, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.equal(r.artifact.content, "OPENARC_TASK_OK");
    assert.equal(r.verification.status, "PASS");
    const props = fx.toolStore.proposalsOfTask(t.task.taskId);
    const decs = fx.toolStore.decisionsOfTask(t.task.taskId);
    const execs = fx.toolStore.executionsOfTask(t.task.taskId);
    assert.equal(props.length, 2, "2 proposals");
    assert.equal(decs.length, 2, "2 decisions");
    assert.equal(execs.length, 2, "2 executions");
    assert.ok(execs.every((e) => e.status === "SUCCEEDED" && e.verification_status === "PASS"), "2 verifications PASS");
    const ev = fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).items.map((e) => e.eventType);
    for (const need of ["tool.execution.started", "tool.execution.succeeded", "artifact.created", "task.succeeded"]) assert.ok(ev.includes(need), "missing " + need);
  } finally { await fx.close(); }
});

test("Secret / path 全量扫描：Provider Secret / capability / 绝对路径 0 hit", async () => {
  const { fx, resourceRef } = await verticalFixture();
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeToolOrchestrator();
    await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput: { proposeSequence: [{ toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: "scan_read" }], finalText: "OPENARC_TASK_OK" }, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });
    const dump = dumpDb(fx.f.identity);
    assert.ok(!dump.includes(PROVIDER_SECRET), "Provider Secret 不得落库");
    assert.ok(!dump.includes("mpx_"), "proxy capability 不得落库");
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders|C:\\/.test(dump), "绝对路径不得落库");
    assert.ok(!dump.includes(fx.f.storeRoot), "store root 不得落库");
    // Tool result 不 dump 进 TaskEvent
    for (const e of fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).items) {
      const payload = JSON.stringify(e.safePayload || {});
      assert.ok(!payload.includes("Searchable Needle"), "event 不得含完整 result");
    }
  } finally { await fx.close(); }
});

test("Mutation 边界：READ_ONLY 执行前后 Resource 数据不变（version/updatedAt/registry 数）", async () => {
  const { fx, resourceRef, resourceId } = await verticalFixture();
  try {
    const before = fx.f.resourceStore.resourceRowById(resourceId);
    const beforeCount = Number(fx.f.identity.connection.prepare("SELECT COUNT(*) AS c FROM resource_registry").get().c);
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeToolOrchestrator();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput: { proposeSequence: [
      { toolId: "resource.search", toolVersion: 1, arguments: { query: "Searchable", limit: 5 }, proposalId: "mut_search" },
      { toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: "mut_read" },
    ], finalText: "OPENARC_TASK_OK" }, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = fx.f.resourceStore.resourceRowById(resourceId);
    assert.equal(Number(after.version), Number(before.version), "Resource version 不得变化");
    assert.equal(Number(after.updated_at), Number(before.updated_at), "Resource updated_at 不得变化");
    assert.equal(Number(after.checksum) === Number(before.checksum) || after.checksum === before.checksum, true);
    assert.equal(Number(fx.f.identity.connection.prepare("SELECT COUNT(*) AS c FROM resource_registry").get().c), beforeCount, "registry 数不得变化");
  } finally { await fx.close(); }
});

test("0 external network：执行期间 fetch 未被调用", async () => {
  const { fx, resourceRef } = await verticalFixture();
  try {
    const origFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (...a) => { fetches += 1; return origFetch(...a); };
    try {
      const ctx = fx.ctx();
      const t = fx.createTask();
      fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
      fx.toolProxy.propose({ context: ctx, taskId: t.task.taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: "net_read" });
      const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId: t.task.taskId, proposalId: "net_read" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(fetches, 0, "READ_ONLY resource tool 不得访问外网");
    } finally { globalThis.fetch = origFetch; }
  } finally { await fx.close(); }
});

test("WRITE / MCP / Shell 仍 0：Registry 未注册且 test.write 不可执行", async () => {
  const { fx } = await verticalFixture();
  try {
    const ctx = fx.ctx();
    const task = fx.createTask();
    const taskId = task.task.taskId;
    fx.taskService.startTask({ context: ctx, taskId, expectedRevision: task.task.revision });
    assert.ok(!fx.toolRegistry.ids().some((id) => /mcp|shell|terminal|filesystem|browser/.test(id)));
    const p = fx.toolProxy.propose({ context: ctx, taskId, toolId: "test.write", toolVersion: 1, arguments: { target: "x" }, proposalId: "sec_write" });
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "sec_write" });
    assert.equal(r.error, "WRITE_EXECUTION_DISABLED");
    assert.equal(fx.toolStore.executionsOfTask(taskId).length, 0);
    void p;
  } finally { await fx.close(); }
});
