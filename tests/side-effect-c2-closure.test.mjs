/**
 * D4-03C2 Closure · Execution Ownership / Atomic Claim。
 *
 * Closure-2 起：runtime identity 只来自 SideEffectAuthority.instanceId，
 * executeSideEffect 不再接受 caller 提供的 holderInstanceId。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { createSideEffectFixture, TRASH_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const { AuthorizationService } = require("../electron/authorization-service.cjs");
const { TaskStore } = require("../electron/task-store.cjs");
const { TaskService } = require("../electron/task-service.cjs");
const { ResourceStore } = require("../electron/resource-store.cjs");
const { ManagedStore } = require("../electron/resource-fs.cjs");
const { ResourceService } = require("../electron/resource-service.cjs");
const { ToolStore } = require("../electron/tool-store.cjs");
const { ToolRegistry } = require("../electron/tool-registry.cjs");
const { SideEffectStore } = require("../electron/side-effect-store.cjs");
const { SideEffectAuthority } = require("../electron/side-effect-authority.cjs");
const { createToolAdapters } = require("../electron/tool-adapters.cjs");

function countDeleteCalls(fx) {
  const real = fx.fx.f.resourceService.delete.bind(fx.fx.f.resourceService);
  const box = { calls: 0 };
  fx.fx.f.resourceService.delete = (args) => { box.calls += 1; return real(args); };
  return box;
}

/** 建立一条 APPROVED+LEASED 的真实 trash call（lease owner = authority.instanceId）。 */
async function readyTrash(opts = {}) {
  const fx = await createSideEffectFixture(opts);
  const sc = await fx.setupTrash();
  const dc = countDeleteCalls(fx);
  const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run, holderId: opts.holderId || "exec_1", instanceId: opts.instanceId });
  const l = flow.lease.lease;
  const execId = { callId: flow.callId, leaseId: l.leaseId, holderId: l.holderId };
  return { fx, sc, dc, flow, execId, l, owner: fx.authority.instanceId };
}
const close = (r) => r.fx.fx.close();

test("Mandatory identity：缺 leaseId / holderId → LEASE_NOT_HELD + 0 mutation", async () => {
  const r = await readyTrash();
  try {
    assert.equal(r.fx.elig(r.execId.callId, { holderId: "exec_1", leaseId: r.execId.leaseId }).status, "ELIGIBLE");
    for (const [label, override] of [["leaseId", { leaseId: null }], ["holderId", { holderId: null }]]) {
      const exec = r.fx.authority.executeSideEffect({ ...r.execId, ...override });
      assert.equal(exec.ok, false, label);
      assert.equal(exec.error, "SIDE_EFFECT_LEASE_NOT_HELD", label);
      assert.equal(exec.detail, "EXECUTOR_IDENTITY_REQUIRED", label);
      assert.equal(exec.mutationCount, 0, label);
    }
    assert.equal(r.dc.calls, 0, "缺 identity 绝不 dispatch Domain");
  } finally { await close(r); }
});

test("execute API 不接受 caller 自报的 holderInstanceId：runtime identity 只来自 OpenArc 自身", async () => {
  const r = await readyTrash();
  try {
    // 同一 runtime（owner）即使传入一个不同的 instance 字符串，也仍然以 this.instanceId 执行：
    // caller 无法通过自报字段改变 authority，也无法借此获得别人的 lease。
    assert.equal(r.owner, r.l.holderInstanceId, "lease 必须绑定当前 runtime identity");
    const exec = await r.fx.authority.executeSideEffect({ ...r.execId, holderInstanceId: "inst_attacker" });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(exec.mutationCount, 1);
    assert.equal(r.dc.calls, 1);
    assert.equal(r.fx.store.callById(r.execId.callId).status, "SUCCEEDED");
  } finally { await close(r); }
});

test("Restart ownership regression：旧 lease EXPIRED，Runtime B 不能继承 execution authority", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c2-own-"));
  const dbPath = path.join(root, "identity.db");
  let fx = null;
  let state = null;
  try {
    fx = await createToolHarnessFixture({ withAdapters: true, dbPath, keepData: true, sideEffectInstanceId: "instA" });
    const created = await fx.createResource("C2 Ownership Target");
    const resourceRef = created.resource.resourceRef;
    fx.grantTool("ai", ["tool.resource.trash"]);
    fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
    fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
    const run = fx.dshRunSetup();
    const p = await fx.sideEffectAuthority.planSideEffect({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, arguments: { resourceRef } });
    assert.equal(p.ok, true, JSON.stringify(p));
    const userCtx = { sessionRef: fx.f.sessions.admin, appId: "ai", source: "user" };
    assert.equal(fx.sideEffectAuthority.approveSideEffect({ context: userCtx, callId: p.call.callId }).ok, true);
    const lease = fx.sideEffectAuthority.acquireLease({ context: fx.ctx(), callId: p.call.callId, holderId: "exec_1", ttlMs: 600000 });
    assert.equal(lease.ok, true, JSON.stringify(lease));
    assert.equal(lease.lease.holderInstanceId, "instA");
    const dc = { calls: 0 };
    const realDelete = fx.f.resourceService.delete.bind(fx.f.resourceService);
    fx.f.resourceService.delete = (args) => { dc.calls += 1; return realDelete(args); };
    state = { storeRoot: fx.f.storeRoot, now: fx.f.clock(), callId: p.call.callId, taskId: run.taskId, leaseId: lease.lease.leaseId, resourceRef, dc };
  } finally {
    if (fx) { try { await fx.close(); } catch { /* ignore */ } }
  }
  if (!state) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } return; }

  // Runtime B：新 instanceId 重开同一 disk DB，recoverOnStartup → 旧 lease EXPIRED。
  const identity = new IdentityStore({ path: dbPath, clock: () => state.now }).open();
  try {
    const authStore = new AuthorizationStore({ identity });
    const authService = new AuthorizationService({ identity, authStore });
    const taskStore = new TaskStore({ identity });
    const taskService = new TaskService({ identity, authService, authStore, taskStore });
    const managedStore = new ManagedStore({ root: state.storeRoot });
    managedStore.ensureLayout();
    const resourceStore = new ResourceStore({ identity });
    const resourceService = new ResourceService({ identity, resourceStore, managedStore, authService, authStore });
    let calls = 0;
    const realDelete = resourceService.delete.bind(resourceService);
    resourceService.delete = (a) => { calls += 1; return realDelete(a); };
    const registry = new ToolRegistry();
    const toolStore = new ToolStore({ identity });
    const sideEffectStore = new SideEffectStore({ identity });
    const authority = new SideEffectAuthority({ registry, sideEffectStore, taskStore, toolStore, authService, adapters: createToolAdapters({ resourceService }), clock: () => state.now, taskService, instanceId: "instB" });

    const rec = authority.recoverOnStartup({ instanceId: "instB" });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.equal(sideEffectStore.leasesOfCall(state.callId).filter((l) => l.status === "ACTIVE").length, 0, "旧 ACTIVE lease 必须失效");
    assert.equal(sideEffectStore.leasesOfCall(state.callId).filter((l) => l.status === "EXPIRED").length, 1);
    assert.equal(sideEffectStore.callById(state.callId).status, "LEASED");

    // 即使自报 holderInstanceId="instA" 也不能伪装成 Runtime A。
    const exec = authority.executeSideEffect({ callId: state.callId, leaseId: state.leaseId, holderId: "exec_1", holderInstanceId: "instA" });
    assert.equal(exec.ok, false);
    assert.ok(["SIDE_EFFECT_LEASE_REQUIRED", "SIDE_EFFECT_LEASE_NOT_HELD"].includes(exec.error), exec.error);
    assert.equal(exec.mutationCount, 0);
    assert.equal(calls, 0, "0 mutation：任何 instance 都不能继承旧 execution authority");
    assert.equal(resourceService.sideEffectPrecondition({ resourceRef: state.resourceRef }).trashed, false);
  } finally { identity.close(); fs.rmSync(root, { recursive: true, force: true }); try { fs.rmSync(state.storeRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/** 在 eligibility 与 claim 之间通过 test-only seam 注入真实 authority state 变化。 */
async function withRace(mutate) {
  let hook = null;
  const fx = await createSideEffectFixture({ sideEffectTestHooks: { afterEligibilityBeforeClaim: (info) => { if (hook) hook(info); } } });
  const sc = await fx.setupTrash();
  const dc = countDeleteCalls(fx);
  const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run });
  const l = flow.lease.lease;
  const execId = { callId: flow.callId, leaseId: l.leaseId, holderId: l.holderId };
  assert.equal(fx.elig(flow.callId, { holderId: l.holderId, leaseId: l.leaseId }).status, "ELIGIBLE", "race 之前必须真实 ELIGIBLE");
  let hookFired = false;
  hook = (info) => { hookFired = true; mutate({ fx, sc, flow, info }); };
  const exec = await fx.authority.executeSideEffect({ ...execId });
  return { fx, sc, flow, exec, dc, hookFired, execId, close: () => fx.fx.close() };
}

function assertClaimDenied(r, expected) {
  assert.equal(r.hookFired, true, "race hook 必须真实触发");
  assert.equal(r.exec.ok, false, JSON.stringify(r.exec));
  assert.ok(String(r.exec.error).includes(expected), "expected " + expected + " got " + r.exec.error);
  assert.equal(r.dc.calls, 0, "0 Domain mutation");
  assert.equal(r.fx.store.callById(r.execId.callId).status, "LEASED", "claim 必须被拒绝（未进入 RUNNING）");
}

test("Eligibility→Claim race：Task cancel → claim denied, 0 mutation", async () => {
  const r = await withRace(({ fx, sc }) => {
    const t = fx.taskService.getTask({ context: fx.ctx(), taskId: sc.run.taskId }).task;
    fx.taskService.cancelTask({ context: fx.ctx(), taskId: sc.run.taskId, expectedRevision: t.revision });
  });
  try { assertClaimDenied(r, "TASK_CANCELLED"); } finally { await r.close(); }
});

test("Eligibility→Claim race：tool permission revoke → claim denied, 0 mutation", async () => {
  const r = await withRace(({ fx, sc }) => {
    fx.fx.f.authService.revokeAppResourcePermission({ context: fx.fx.f.adminCtx(), grantId: sc.toolGrant.grant.grantId });
  });
  try { assertClaimDenied(r, "SIDE_EFFECT_AUTHORIZATION_REVOKED"); } finally { await r.close(); }
});

test("Eligibility→Claim race：latest run changes → claim denied, 0 mutation", async () => {
  const r = await withRace(({ fx, sc }) => {
    const c = fx.ctx();
    const task = fx.taskStore.taskById(sc.run.taskId);
    const step = fx.taskService.createStep({ context: c, taskId: sc.run.taskId, kind: "reasoning", input: null, expectedRevision: task.revision });
    const ss = fx.taskService.startStep({ context: c, taskId: sc.run.taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
    fx.taskService.startHarnessRun({ context: c, taskId: sc.run.taskId, stepId: step.step.stepId, expectedRevision: ss.task.revision });
  });
  try { assertClaimDenied(r, "SIDE_EFFECT_STALE_RUN"); } finally { await r.close(); }
});

test("Eligibility→Claim race：approval revoke → claim denied, 0 mutation", async () => {
  const r = await withRace(({ fx, flow }) => { fx.revokeApproval(flow.callId); });
  try { assertClaimDenied(r, "SIDE_EFFECT_APPROVAL_REVOKED"); } finally { await r.close(); }
});

test("Eligibility→Claim race：lease revoke → claim denied, 0 mutation", async () => {
  const r = await withRace(({ fx, flow }) => { fx.authority.revokeLease({ callId: flow.callId, leaseId: flow.lease.lease.leaseId }); });
  try { assertClaimDenied(r, "SIDE_EFFECT_LEASE"); } finally { await r.close(); }
});

test("Deterministic duplicate claim：call 已 RUNNING 时同 identity 再次 claim → EXECUTION_CLAIM_LOST + 0 mutation", async () => {
  const r = await readyTrash();
  try {
    r.fx.store.transactSync(() => r.fx.store.updateCall(r.execId.callId, { status: "RUNNING", started_at: 1700000000000 }));
    const exec = r.fx.authority.executeSideEffect({ ...r.execId });
    assert.equal(exec.ok, false);
    assert.equal(exec.error, "SIDE_EFFECT_EXECUTION_CLAIM_LOST");
    assert.equal(exec.duplicate, true);
    assert.equal(exec.mutationCount, 0);
    assert.equal(r.dc.calls, 0, "第二个 claimant 绝不能 dispatch Domain");
    assert.equal(r.fx.store.callById(r.execId.callId).status, "RUNNING", "claim 状态不被第二个调用改写");
  } finally { await close(r); }
});
