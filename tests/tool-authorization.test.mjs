/** D4-03A · Tool Authorization：复用 D3（Session∩User∩App∩Tool∩Resource + useByAgent）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

async function setup() {
  const fx = await createToolHarnessFixture();
  const created = await fx.createResource("Auth Target");
  assert.equal(created.ok, true, JSON.stringify(created));
  const resourceRef = created.resource.resourceRef;
  const resourceId = created.resource.resourceId;
  fx.grantTool("ai", ["tool.resource.readMetadata"]);
  return { fx, resourceRef, resourceId, adminCtx: fx.ctx("admin", "ai") };
}
const proposeMeta = (fx, ctx, taskId, resourceRef, proposalId = null) => fx.toolProxy.propose({ context: ctx, taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId });

test("authorized owner + app tool permission + resource.read → ALLOWED", async () => {
  const { fx, resourceRef, adminCtx } = await setup();
  try {
    const t = fx.createTask();
    const r = proposeMeta(fx, adminCtx, t.task.taskId, resourceRef, "auth_ok");
    assert.equal(r.decisionStatus, "ALLOWED", JSON.stringify(r));
    assert.equal(r.executed, false);
  } finally { await fx.close(); }
});

test("wrong user → DENY", async () => {
  const { fx, resourceRef } = await setup();
  try {
    const t = fx.createTask();
    const alice = { sessionRef: fx.f.sessions.alice, appId: "ai" };
    const r = proposeMeta(fx, alice, t.task.taskId, resourceRef, "auth_wrong_user");
    assert.equal(r.decisionStatus, "DENIED");
    assert.equal(r.reasonCode, "TOOL_FORBIDDEN");
  } finally { await fx.close(); }
});

test("wrong app（App spoof）→ DENY", async () => {
  const { fx, resourceRef } = await setup();
  try {
    const t = fx.createTask();
    const canvas = { sessionRef: fx.f.sessions.admin, appId: "canvas" };
    const r = proposeMeta(fx, canvas, t.task.taskId, resourceRef, "auth_wrong_app");
    assert.equal(r.decisionStatus, "DENIED");
    assert.equal(r.reasonCode, "TOOL_FORBIDDEN");
  } finally { await fx.close(); }
});

test("useByAgent=false（User can read，但未授予 useByAgent）→ DENY", async () => {
  const { fx, resourceRef, resourceId } = await setup();
  try {
    const aliceCtx = { sessionRef: fx.f.sessions.alice, appId: "ai" };
    const aliceTask = fx.taskService.createTask({ context: aliceCtx, goal: "agent use probe" });
    assert.equal(aliceTask.ok, true, JSON.stringify(aliceTask));
    const grant = fx.grantUserResource(resourceId, fx.f.users.alice, ["resource.read"]);
    assert.equal(grant.ok, true, JSON.stringify(grant));
    const r = proposeMeta(fx, aliceCtx, aliceTask.task.taskId, resourceRef, "auth_use_by_agent");
    assert.equal(r.decisionStatus, "DENIED");
    assert.equal(r.reasonCode, "TOOL_AGENT_USE_NOT_AUTHORIZED", JSON.stringify(r));
  } finally { await fx.close(); }
});

test("resource permission missing → DENY", async () => {
  const { fx, resourceRef, adminCtx } = await setup();
  try {
    const t = fx.createTask();
    const before = proposeMeta(fx, adminCtx, t.task.taskId, resourceRef, "auth_before");
    assert.equal(before.decisionStatus, "ALLOWED");
    fx.f.store.upsertApp({ appId: "tool-test-app", name: "Tool Test App", status: "enabled", builtIn: 0 });
    const noGrantCtx = { sessionRef: fx.f.sessions.admin, appId: "tool-test-app" };
    const task = fx.taskService.createTask({ context: noGrantCtx, goal: "no grant" });
    assert.equal(task.ok, true, JSON.stringify(task));
    const r = proposeMeta(fx, noGrantCtx, task.task.taskId, resourceRef, "auth_no_resource_grant");
    assert.equal(r.decisionStatus, "DENIED");
    assert.equal(r.reasonCode, "TOOL_FORBIDDEN");
  } finally { await fx.close(); }
});

test("app tool permission missing → DENY TOOL_APP_NOT_GRANTED", async () => {
  const fx = await createToolHarnessFixture();
  try {
    const created = await fx.createResource("No Tool Grant");
    const t = fx.createTask();
    const r = fx.toolProxy.propose({ context: fx.ctx(), taskId: t.task.taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef: created.resource.resourceRef }, proposalId: "auth_no_tool_grant" });
    assert.equal(r.decisionStatus, "DENIED");
    assert.equal(r.reasonCode, "TOOL_APP_NOT_GRANTED");
  } finally { await fx.close(); }
});

test("disabled app → DENY", async () => {
  const { fx, resourceRef, adminCtx } = await setup();
  try {
    const t = fx.createTask();
    fx.f.store.setAppStatus("ai", "disabled");
    const r = proposeMeta(fx, adminCtx, t.task.taskId, resourceRef, "auth_app_disabled");
    assert.equal(r.decisionStatus, "DENIED");
    assert.notEqual(r.decisionStatus, "ALLOWED");
  } finally { await fx.close(); }
});

test("revoked / bogus session → DENY", async () => {
  const { fx, resourceRef } = await setup();
  try {
    const t = fx.createTask();
    const bogus = { sessionRef: "sess_bogus_not_real", appId: "ai" };
    const r = proposeMeta(fx, bogus, t.task.taskId, resourceRef, "auth_bogus_session");
    assert.equal(r.decisionStatus, "DENIED");
    assert.equal(r.reasonCode, "TOOL_FORBIDDEN");
  } finally { await fx.close(); }
});

test("resourceRef 必填：缺 ResourceRef → DENY", async () => {
  const { fx, adminCtx } = await setup();
  try {
    const t = fx.createTask();
    const r = fx.toolProxy.propose({ context: adminCtx, taskId: t.task.taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: {}, proposalId: "auth_no_ref" });
    assert.equal(r.decisionStatus, "INVALID");
    assert.equal(r.reasonCode, "TOOL_ARGUMENT_INVALID");
  } finally { await fx.close(); }
});
