/** D4-03B · resource.read.metadata 真实 Domain 执行：metadata 正确性 / 隔离 / useByAgent / path leak / call count。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

async function setup() {
  const fx = await createToolHarnessFixture({ withAdapters: true });
  const created = await fx.createResource("Read Target");
  fx.grantTool("ai", ["tool.resource.readMetadata"]);
  const ctx = fx.ctx();
  const t = fx.createTask();
  const s = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  return { fx, ctx, taskId: t.task.taskId, taskRevision: s.task.revision, resourceRef: created.resource.resourceRef, resourceId: created.resource.resourceId };
}
const spy = (fx) => { const orig = fx.f.resourceService.get.bind(fx.f.resourceService); const box = { calls: 0 }; fx.f.resourceService.get = (...a) => { box.calls += 1; return orig(...a); }; return box; };
const proposeMeta = (fx, ctx, taskId, resourceRef, id) => fx.toolProxy.propose({ context: ctx, taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: id });

test("authorized：真实 ResourceService.get，metadata 与 Domain 一致", async () => {
  const { fx, ctx, taskId, resourceRef } = await setup();
  try {
    const box = spy(fx);
    proposeMeta(fx, ctx, taskId, resourceRef, "read_ok");
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "read_ok" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(box.calls, 1);
    assert.equal(r.result.resourceRef, resourceRef);
    assert.equal(r.result.name, "Read Target");
    assert.equal(r.result.resourceType, "text");
    assert.equal(typeof r.result.mimeType, "string");
    assert.ok(Number.isInteger(r.result.version));
    assert.ok(Number.isInteger(r.result.updatedAt));
  } finally { await fx.close(); }
});

test("cross-user：User B 读 User A resource → DENY + 0 Domain call", async () => {
  const { fx, ctx, taskId, resourceRef } = await setup();
  try {
    const box = spy(fx);
    const alice = { sessionRef: fx.f.sessions.alice, appId: "ai" };
    const aTask = fx.taskService.createTask({ context: alice, goal: "cross user" });
    const aStart = fx.taskService.startTask({ context: alice, taskId: aTask.task.taskId, expectedRevision: aTask.task.revision });
    const p = proposeMeta(fx, alice, aTask.task.taskId, resourceRef, "read_cross_user");
    assert.equal(p.decisionStatus, "DENIED");
    const r = await fx.toolProxy.executeReadOnly({ context: alice, taskId: aTask.task.taskId, proposalId: "read_cross_user" });
    assert.equal(r.ok, false);
    assert.equal(box.calls, 0, "unauthorized 0 Domain call");
    void aStart; void ctx; void taskId;
  } finally { await fx.close(); }
});

test("cross-app：无 App resource permission → DENY + 0 Domain call", async () => {
  const { fx, resourceRef } = await setup();
  try {
    const box = spy(fx);
    fx.f.store.upsertApp({ appId: "tool-test-app", name: "Tool Test App", status: "enabled", builtIn: 0 });
    const noGrant = { sessionRef: fx.f.sessions.admin, appId: "tool-test-app" };
    const t = fx.taskService.createTask({ context: noGrant, goal: "cross app" });
    const s = fx.taskService.startTask({ context: noGrant, taskId: t.task.taskId, expectedRevision: t.task.revision });
    proposeMeta(fx, noGrant, t.task.taskId, resourceRef, "read_cross_app");
    const r = await fx.toolProxy.executeReadOnly({ context: noGrant, taskId: t.task.taskId, proposalId: "read_cross_app" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "TOOL_FORBIDDEN");
    assert.equal(box.calls, 0);
    void s;
  } finally { await fx.close(); }
});

test("useByAgent=false：User can read 但无 useByAgent → DENY + 0 Domain call", async () => {
  const { fx, resourceRef, resourceId } = await setup();
  try {
    const box = spy(fx);
    const alice = { sessionRef: fx.f.sessions.alice, appId: "ai" };
    const t = fx.taskService.createTask({ context: alice, goal: "useByAgent" });
    fx.taskService.startTask({ context: alice, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const grant = fx.grantUserResource(resourceId, fx.f.users.alice, ["resource.read"]);
    assert.equal(grant.ok, true, JSON.stringify(grant));
    proposeMeta(fx, alice, t.task.taskId, resourceRef, "read_agent_deny");
    const r = await fx.toolProxy.executeReadOnly({ context: alice, taskId: t.task.taskId, proposalId: "read_agent_deny" });
    assert.equal(r.ok, false);
    assert.equal(box.calls, 0, "useByAgent=false → 0 domain read");
    assert.ok(["TOOL_FORBIDDEN", "TOOL_AGENT_USE_NOT_AUTHORIZED"].includes(r.error), JSON.stringify(r));
  } finally { await fx.close(); }
});

test("path leak：result/execution 不出现绝对路径或 store root", async () => {
  const { fx, ctx, taskId, resourceRef } = await setup();
  try {
    proposeMeta(fx, ctx, taskId, resourceRef, "read_path");
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "read_path" });
    const execRow = fx.toolStore.executionsOfTask(taskId)[0];
    const dump = JSON.stringify({ result: r.result, exec: execRow });
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders|C:\\/.test(dump), "path leak: " + dump);
    assert.ok(!dump.includes(fx.f.storeRoot), "store root 不得出现");
  } finally { await fx.close(); }
});

test("Resource 已删除 → RESOURCE_NOT_AVAILABLE，不返回 stale metadata", async () => {
  const { fx, ctx, taskId, resourceRef } = await setup();
  try {
    proposeMeta(fx, ctx, taskId, resourceRef, "read_deleted");
    const del = await fx.f.resourceService.delete({ context: fx.f.adminCtx(), resourceRef });
    assert.equal(del.ok, true, JSON.stringify(del));
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "read_deleted" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "RESOURCE_NOT_AVAILABLE", JSON.stringify(r));
    assert.equal(r.result, null);
  } finally { await fx.close(); }
});
