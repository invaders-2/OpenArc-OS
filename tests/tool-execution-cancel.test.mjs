/** D4-03B · Cancel / 撤销竞争：abort、task cancel、revision、session/app/permission/useByAgent revoke。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { ControlledToolProxy } = require("../electron/controlled-tool-proxy.cjs");

async function setup() {
  const fx = await createToolHarnessFixture({ withAdapters: true });
  const created = await fx.createResource("Cancel Target");
  fx.grantTool("ai", ["tool.resource.readMetadata"]);
  const ctx = fx.ctx();
  const t = fx.createTask();
  const s = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  return { fx, ctx, taskId: t.task.taskId, taskRevision: s.task.revision, resourceRef: created.resource.resourceRef, resourceId: created.resource.resourceId };
}
const customProxy = (fx, adapter) => new ControlledToolProxy({ registry: fx.toolRegistry, toolStore: fx.toolStore, authService: fx.f.authService, taskStore: fx.taskStore, adapters: { adapterFor: () => adapter }, clock: fx.f.clock });
const spy = (fx) => { const orig = fx.f.resourceService.get.bind(fx.f.resourceService); const box = { calls: 0 }; fx.f.resourceService.get = (...a) => { box.calls += 1; return orig(...a); }; return box; };

test("AbortSignal 中止执行 → BLOCKED/CANCELLED，不返回数据", async () => {
  const { fx, ctx, taskId, resourceRef, taskRevision } = await setup();
  try {
    const proxy = customProxy(fx, { async prepare() { return {}; }, async execute({ signal }) { return new Promise((_, reject) => { signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORT" }))); }); }, async verify() { return { ok: true }; } });
    proxy.propose({ context: ctx, taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: "cancel_abort" });
    const ac = new AbortController();
    const pr = proxy.executeReadOnly({ context: ctx, taskId, proposalId: "cancel_abort", expectedRevision: taskRevision, signal: ac.signal, timeoutMs: 5000 });
    setTimeout(() => ac.abort(), 60);
    const r = await pr;
    assert.equal(r.ok, false);
    assert.equal(r.executionStatus, "BLOCKED");
    assert.equal(r.error, "TASK_CANCELLED");
    assert.equal(r.result, null);
  } finally { await fx.close(); }
});

test("Task cancel 竞争：proposal ALLOWED 后 cancel → execute DENY TASK_CANCELLED + 0 Domain call", async () => {
  const { fx, ctx, taskId, resourceRef, taskRevision } = await setup();
  try {
    const box = spy(fx);
    fx.toolProxy.propose({ context: ctx, taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: "cancel_task" });
    const c = fx.taskService.cancelTask({ context: ctx, taskId, expectedRevision: taskRevision });
    assert.equal(c.ok, true, JSON.stringify(c));
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "cancel_task" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "TASK_CANCELLED");
    assert.equal(box.calls, 0);
  } finally { await fx.close(); }
});

test("Revision 变化 → TOOL_EXECUTION_STALE，不提交到 Harness", async () => {
  const { fx, ctx, taskId, resourceRef, taskRevision } = await setup();
  try {
    fx.toolProxy.propose({ context: ctx, taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: "stale_rev" });
    const step = fx.taskService.createStep({ context: ctx, taskId, kind: "reasoning", input: null, expectedRevision: taskRevision });
    assert.equal(step.ok, true);
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "stale_rev", expectedRevision: taskRevision });
    assert.equal(r.ok, false);
    assert.equal(r.error, "TOOL_EXECUTION_STALE", JSON.stringify(r));
  } finally { await fx.close(); }
});

test("Session revoke → TOOL_AUTHORIZATION_REVOKED", async () => {
  const { fx, ctx, taskId, resourceRef } = await setup();
  try {
    const box = spy(fx);
    fx.toolProxy.propose({ context: ctx, taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: "revoke_session" });
    fx.f.identity.logout(ctx.sessionRef);
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "revoke_session" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "TOOL_AUTHORIZATION_REVOKED", JSON.stringify(r));
    assert.equal(box.calls, 0);
  } finally { await fx.close(); }
});

test("App disable → DENY + 0 Domain call", async () => {
  const { fx, ctx, taskId, resourceRef } = await setup();
  try {
    const box = spy(fx);
    fx.toolProxy.propose({ context: ctx, taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: "revoke_app" });
    fx.f.store.setAppStatus("ai", "disabled");
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "revoke_app" });
    assert.equal(r.ok, false);
    assert.equal(box.calls, 0);
  } finally { await fx.close(); }
});

test("Resource permission revoke → DENY + 0 Domain call", async () => {
  const { fx, resourceRef, resourceId } = await setup();
  try {
    const box = spy(fx);
    const alice = { sessionRef: fx.f.sessions.alice, appId: "ai" };
    const t = fx.taskService.createTask({ context: alice, goal: "perm revoke" });
    const s = fx.taskService.startTask({ context: alice, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const grant = fx.f.authService.grantResourcePermission({ context: fx.f.adminCtx(), principalType: "USER", principalId: fx.f.users.alice, resourceId, actions: ["resource.read", "resource.useByAgent"] });
    assert.equal(grant.ok, true, JSON.stringify(grant));
    const p = fx.toolProxy.propose({ context: alice, taskId: t.task.taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: "revoke_perm" });
    assert.equal(p.decisionStatus, "ALLOWED", JSON.stringify(p));
    const rev = fx.f.authService.revokeResourcePermission({ context: fx.f.adminCtx(), grantId: grant.grant.id });
    assert.equal(rev.ok, true, JSON.stringify(rev));
    const r = await fx.toolProxy.executeReadOnly({ context: alice, taskId: t.task.taskId, proposalId: "revoke_perm", expectedRevision: s.task.revision });
    assert.equal(r.ok, false);
    assert.equal(box.calls, 0, "revoked → 0 domain read");
  } finally { await fx.close(); }
});

test("useByAgent revoke（read 仍有效）→ TOOL_AGENT_USE_NOT_AUTHORIZED + 0 Domain call", async () => {
  const { fx, resourceRef, resourceId } = await setup();
  try {
    const box = spy(fx);
    const alice = { sessionRef: fx.f.sessions.alice, appId: "ai" };
    const t = fx.taskService.createTask({ context: alice, goal: "useByAgent revoke" });
    const s = fx.taskService.startTask({ context: alice, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const readGrant = fx.f.authService.grantResourcePermission({ context: fx.f.adminCtx(), principalType: "USER", principalId: fx.f.users.alice, resourceId, actions: ["resource.read"] });
    const agentGrant = fx.f.authService.grantResourcePermission({ context: fx.f.adminCtx(), principalType: "USER", principalId: fx.f.users.alice, resourceId, resourceType: "text", actions: ["resource.useByAgent"] });
    assert.equal(readGrant.ok && agentGrant.ok, true, JSON.stringify({ readGrant, agentGrant }));
    const p = fx.toolProxy.propose({ context: alice, taskId: t.task.taskId, toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef }, proposalId: "revoke_agent" });
    assert.equal(p.decisionStatus, "ALLOWED", JSON.stringify(p));
    const rev = fx.f.authService.revokeResourcePermission({ context: fx.f.adminCtx(), grantId: agentGrant.grant.id });
    assert.equal(rev.ok, true, JSON.stringify(rev));
    const r = await fx.toolProxy.executeReadOnly({ context: alice, taskId: t.task.taskId, proposalId: "revoke_agent", expectedRevision: s.task.revision });
    assert.equal(r.ok, false);
    assert.equal(r.error, "TOOL_AGENT_USE_NOT_AUTHORIZED", JSON.stringify(r));
    assert.equal(box.calls, 0);
  } finally { await fx.close(); }
});
