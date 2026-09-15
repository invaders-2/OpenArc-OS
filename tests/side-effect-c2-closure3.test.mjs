/**
 * D4-03C2 Closure-3 · Runtime Identity Final Seal。
 *
 * 关闭两个 runtime identity escape hatch：
 *  1. acquireLease production API 不再接受 runtime override（_testInstanceId 删除）。
 *  2. recoverOnStartup production API 不再接受 caller instanceId。
 * 并修正：same holderId + different runtime instance 不得被当成 duplicate。
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
const siblingAuthority = (fx, instanceId) => new SideEffectAuthority({
  registry: fx.toolRegistry, sideEffectStore: fx.store, taskStore: fx.taskStore, toolStore: fx.toolStore,
  authService: fx.authService, adapters: fx.adapters, clock: fx.authority.clock, taskService: fx.taskService, instanceId,
});

/** 建立一条 APPROVED 的 trash call（尚未 lease）。 */
async function readyCall(opts = {}) {
  const fx = await createSideEffectFixture(opts);
  const sc = await fx.setupTrash();
  const dc = countDeleteCalls(fx);
  const prop = fx.toolProxy.propose({ context: fx.ctx(), taskId: sc.run.taskId, stepId: sc.run.stepId, runId: sc.run.runId, toolId: TRASH_TOOL, toolVersion: 1, arguments: { resourceRef: sc.resourceRef } });
  const plan = await fx.authority.planSideEffect({ context: fx.ctx(), taskId: sc.run.taskId, stepId: sc.run.stepId, runId: sc.run.runId, toolId: TRASH_TOOL, arguments: { resourceRef: sc.resourceRef }, proposalId: prop.proposal.proposalId, decisionId: prop.decision.decisionId });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(fx.approve(plan.call.callId).ok, true);
  return { fx, sc, dc, callId: plan.call.callId };
}
const close = (r) => r.fx.fx.close();

test("acquireLease API：caller 提供的 instanceId 被忽略，lease 永远绑定 runtime 自身 identity", async () => {
  const r = await readyCall(); // fixture instanceId = inst_test
  try {
    const l = r.fx.authority.acquireLease({ context: r.fx.ctx(), callId: r.callId, holderId: "exec_1", instanceId: "inst_attacker", runtimeIdOverride: "x" });
    assert.equal(l.ok, true, JSON.stringify(l));
    assert.equal(l.lease.holderInstanceId, r.fx.authority.instanceId, "runtime identity 必须来自 this.instanceId");
    assert.notEqual(l.lease.holderInstanceId, "inst_attacker");
    assert.equal(r.fx.store.activeLeases().filter((x) => x.callId === r.callId).length, 1);
  } finally { await close(r); }
});

test("Same-runtime duplicate acquire：同 holderId + 同 runtime → duplicate，无第二个 ACTIVE lease", async () => {
  const r = await readyCall();
  try {
    const first = r.fx.authority.acquireLease({ context: r.fx.ctx(), callId: r.callId, holderId: "exec_1" });
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = r.fx.authority.acquireLease({ context: r.fx.ctx(), callId: r.callId, holderId: "exec_1" });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.duplicate, true);
    assert.equal(second.lease.leaseId, first.lease.leaseId);
    assert.equal(r.fx.store.activeLeases().filter((x) => x.callId === r.callId).length, 1);
  } finally { await close(r); }
});

test("Cross-runtime same-holder acquire：不同 runtime instance → LEASE_CONFLICT（不是 duplicate）", async () => {
  const r = await readyCall({ sideEffectInstanceId: "instA" });
  try {
    const leaseA = r.fx.authority.acquireLease({ context: r.fx.ctx(), callId: r.callId, holderId: "exec_1" });
    assert.equal(leaseA.ok, true, JSON.stringify(leaseA));
    assert.equal(leaseA.lease.holderInstanceId, "instA");
    const authorityB = siblingAuthority(r.fx, "instB");
    const leaseB = authorityB.acquireLease({ context: r.fx.ctx(), callId: r.callId, holderId: "exec_1" });
    assert.equal(leaseB.ok, false, JSON.stringify(leaseB));
    assert.equal(leaseB.error, "SIDE_EFFECT_LEASE_CONFLICT", "同 holder 不同 runtime 绝不能 duplicate");
    assert.notEqual(leaseB.duplicate, true);
    // Lease A 未被改动，ACTIVE 仍恰好 1。
    const active = r.fx.store.activeLeases().filter((x) => x.callId === r.callId);
    assert.equal(active.length, 1);
    assert.equal(active[0].leaseId, leaseA.lease.leaseId);
    assert.equal(active[0].holderInstanceId, "instA");
    assert.equal(r.dc.calls, 0, "0 execution / 0 mutation");
  } finally { await close(r); }
});

test("recoverOnStartup API：caller instanceId 被忽略；当前 runtime 自己的 lease 保留，其它 runtime lease EXPIRED", async () => {
  const r = await readyCall({ sideEffectInstanceId: "instA" });
  try {
    const leaseA = r.fx.authority.acquireLease({ context: r.fx.ctx(), callId: r.callId, holderId: "exec_1" });
    assert.equal(leaseA.ok, true);
    // caller 自报 instB：被忽略，实际用 this.instanceId=instA → 自己的 lease 保留。
    r.fx.authority.recoverOnStartup({ instanceId: "instB" });
    assert.equal(r.fx.store.activeLeases().filter((x) => x.callId === r.callId).length, 1, "当前 runtime 的 lease 必须保留");
    // 真正的 Runtime B 恢复 → instA 的 lease EXPIRED。
    const authorityB = siblingAuthority(r.fx, "instB");
    const rec = authorityB.recoverOnStartup({ instanceId: "instA" });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.equal(r.fx.store.activeLeases().filter((x) => x.callId === r.callId).length, 0, "instA lease 必须 EXPIRED");
    assert.equal(r.fx.store.leasesOfCall(r.callId).filter((l) => l.status === "EXPIRED").length, 1);
  } finally { await close(r); }
});

test("Authority eligibility runtime identity = this.instanceId（caller 自报 holderInstanceId 无效）", async () => {
  const r = await readyCall({ sideEffectInstanceId: "instA" });
  try {
    const leaseA = r.fx.authority.acquireLease({ context: r.fx.ctx(), callId: r.callId, holderId: "exec_1" });
    const execId = { callId: r.callId, leaseId: leaseA.lease.leaseId, holderId: "exec_1" };
    assert.equal(r.fx.authority.evaluateExecutionEligibility({ context: r.fx.ctx(), ...execId }).status, "ELIGIBLE");
    const authorityB = siblingAuthority(r.fx, "instB");
    assert.equal(authorityB.evaluateExecutionEligibility({ context: r.fx.ctx(), ...execId }).reasonCode, "SIDE_EFFECT_LEASE_NOT_HELD");
    // 自报 holderInstanceId="instA" 也不能让 Runtime B eligible。
    assert.equal(authorityB.evaluateExecutionEligibility({ context: r.fx.ctx(), ...execId, holderInstanceId: "instA" }).reasonCode, "SIDE_EFFECT_LEASE_NOT_HELD");
    // execute 同样不受 caller 自报影响。
    const execB = authorityB.executeSideEffect({ ...execId, holderInstanceId: "instA" });
    assert.equal(execB.error, "SIDE_EFFECT_LEASE_NOT_HELD");
    assert.equal(r.dc.calls, 0);
    // Runtime A（真正 owner）可执行。
    const execA = await r.fx.authority.executeSideEffect({ ...execId, holderInstanceId: "inst_attacker" });
    assert.equal(execA.ok, true, JSON.stringify(execA));
    assert.equal(r.dc.calls, 1);
  } finally { await close(r); }
});

test("Disk-backed restart impersonation：Runtime B 知道 instA 也无法保留/继承旧 lease", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c2-c3-"));
  const dbPath = path.join(root, "identity.db");
  let state = null;
  try {
    const fx = await createToolHarnessFixture({ withAdapters: true, dbPath, keepData: true, sideEffectInstanceId: "instA" });
    const created = await fx.createResource("C3 Restart Target");
    const resourceRef = created.resource.resourceRef;
    fx.grantTool("ai", ["tool.resource.trash"]);
    fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
    fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
    const run = fx.dshRunSetup();
    const p = await fx.sideEffectAuthority.planSideEffect({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, arguments: { resourceRef } });
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(fx.sideEffectAuthority.approveSideEffect({ context: { sessionRef: fx.f.sessions.admin, appId: "ai", source: "user" }, callId: p.call.callId }).ok, true);
    const lease = fx.sideEffectAuthority.acquireLease({ context: fx.ctx(), callId: p.call.callId, holderId: "exec_1", ttlMs: 600000 });
    assert.equal(lease.ok, true, JSON.stringify(lease));
    assert.equal(lease.lease.holderInstanceId, "instA");
    state = { storeRoot: fx.f.storeRoot, now: fx.f.clock(), callId: p.call.callId, leaseId: lease.lease.leaseId, resourceRef };
    await fx.close();
  } finally {
    if (!state) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  if (!state) return;

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
    const authorityB = new SideEffectAuthority({ registry, sideEffectStore, taskStore, toolStore, authService, adapters: createToolAdapters({ resourceService }), clock: () => state.now, taskService, instanceId: "instB" });

    // 即使传入 caller 自报 instanceId="instA"，production API 也忽略它 → 用 instB 恢复 → EXPIRED。
    const rec = authorityB.recoverOnStartup({ instanceId: "instA" });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.equal(sideEffectStore.leasesOfCall(state.callId).filter((l) => l.status === "ACTIVE").length, 0, "旧 instA lease 必须 EXPIRED");
    assert.equal(sideEffectStore.leasesOfCall(state.callId).filter((l) => l.status === "EXPIRED").length, 1);
    // Runtime B 不能执行旧 lease。
    const exec = authorityB.executeSideEffect({ callId: state.callId, leaseId: state.leaseId, holderId: "exec_1", holderInstanceId: "instA" });
    assert.equal(exec.ok, false);
    assert.equal(exec.mutationCount, 0);
    assert.equal(calls, 0);
    assert.equal(resourceService.sideEffectPrecondition({ resourceRef: state.resourceRef }).trashed, false);
  } finally { identity.close(); try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state.storeRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
});
