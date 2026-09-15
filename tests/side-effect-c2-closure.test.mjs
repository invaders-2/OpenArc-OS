/**
 * D4-03C2 Closure · Execution Ownership / Atomic Claim。
 *
 * 关闭：runtime instance ownership 强制、missing/wrong instance 0 mutation、
 * 真实跨进程 duplicate claim contention、Eligibility→Claim TOCTOU race fail closed。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
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

const CONTENDER = path.join(import.meta.dirname, "fixtures", "harness-acp", "claim-contender.mjs");
// unref：测试超时 guard 不得让 event loop 挂在 production 之外。
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && typeof t.unref === "function") t.unref(); });

function countDeleteCalls(fx) {
  const real = fx.fx.f.resourceService.delete.bind(fx.fx.f.resourceService);
  const box = { calls: 0 };
  fx.fx.f.resourceService.delete = (args) => { box.calls += 1; return real(args); };
  return box;
}

/** 建立一条 APPROVED+LEASED 的真实 trash call（默认 lease instance = inst_test）。 */
async function readyTrash(opts = {}) {
  const fx = await createSideEffectFixture(opts);
  const sc = await fx.setupTrash();
  const dc = countDeleteCalls(fx);
  const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run, holderId: opts.holderId || "exec_1", instanceId: opts.instanceId });
  const l = flow.lease.lease;
  const execId = { callId: flow.callId, leaseId: l.leaseId, holderId: l.holderId, holderInstanceId: l.holderInstanceId };
  return { fx, sc, dc, flow, execId, l };
}
const close = (r) => r.fx.fx.close();

test("Mandatory identity：缺 holderInstanceId / leaseId / holderId → LEASE_NOT_HELD + 0 mutation", async () => {
  const r = await readyTrash();
  try {
    assert.equal(r.fx.elig(r.execId.callId, { holderId: "exec_1", holderInstanceId: r.execId.holderInstanceId }).status, "ELIGIBLE");
    for (const [label, override] of [["holderInstanceId", { holderInstanceId: null }], ["leaseId", { leaseId: null }], ["holderId", { holderId: null }]]) {
      const exec = r.fx.authority.executeSideEffect({ ...r.execId, ...override });
      assert.equal(exec.ok, false, label);
      assert.equal(exec.error, "SIDE_EFFECT_LEASE_NOT_HELD", label);
      assert.equal(exec.detail, "EXECUTOR_IDENTITY_REQUIRED", label);
      assert.equal(exec.mutationCount, 0, label);
    }
    assert.equal(r.dc.calls, 0, "缺 identity 绝不 dispatch Domain");
  } finally { await close(r); }
});

test("Wrong runtime instance（same holderId, wrong holderInstanceId）→ 0 mutation", async () => {
  const r = await readyTrash();
  try {
    const wrong = r.fx.authority.executeSideEffect({ ...r.execId, holderInstanceId: "inst_attacker" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, "SIDE_EFFECT_LEASE_NOT_HELD");
    assert.equal(wrong.mutationCount, 0);
    assert.equal(r.dc.calls, 0);
    // eligibility 也必须拒绝错误 runtime instance。
    assert.equal(r.fx.elig(r.execId.callId, { holderId: "exec_1", holderInstanceId: "inst_attacker" }).reasonCode, "SIDE_EFFECT_LEASE_NOT_HELD");
    // 正确的 instance 仍可执行 → 证明拒绝来自 instance，而不是其它 gate。
    assert.equal((await r.fx.authority.executeSideEffect({ ...r.execId })).ok, true);
    assert.equal(r.dc.calls, 1);
  } finally { await close(r); }
});

test("Restart ownership regression：旧 instA lease EXPIRED，instB / 旧 identity 都不能继承 execution authority", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c2-own-"));
  const dbPath = path.join(root, "identity.db");
  let fx = null;
  let state = null;
  try {
    fx = await createToolHarnessFixture({ withAdapters: true, dbPath, keepData: true });
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
    const lease = fx.sideEffectAuthority.acquireLease({ context: fx.ctx(), callId: p.call.callId, holderId: "exec_1", instanceId: "instA", ttlMs: 600000 });
    assert.equal(lease.ok, true, JSON.stringify(lease));
    const dc = { calls: 0 };
    const realDelete = fx.f.resourceService.delete.bind(fx.f.resourceService);
    fx.f.resourceService.delete = (args) => { dc.calls += 1; return realDelete(args); };

    // Runtime A 仍持有 ACTIVE instA lease：instB 身份不能执行。
    const wrong = fx.sideEffectAuthority.executeSideEffect({ callId: p.call.callId, leaseId: lease.lease.leaseId, holderId: "exec_1", holderInstanceId: "instB" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, "SIDE_EFFECT_LEASE_NOT_HELD");
    assert.equal(dc.calls, 0);
    state = { storeRoot: fx.f.storeRoot, now: fx.f.clock(), callId: p.call.callId, taskId: run.taskId, leaseId: lease.lease.leaseId, resourceRef };
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

    for (const inst of ["instB", "instA"]) {
      const exec = authority.executeSideEffect({ callId: state.callId, leaseId: state.leaseId, holderId: "exec_1", holderInstanceId: inst });
      assert.equal(exec.ok, false, inst);
      assert.ok(["SIDE_EFFECT_LEASE_REQUIRED", "SIDE_EFFECT_LEASE_NOT_HELD"].includes(exec.error), inst + " -> " + exec.error);
      assert.equal(exec.mutationCount, 0, inst);
    }
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
  const execId = { callId: flow.callId, leaseId: l.leaseId, holderId: l.holderId, holderInstanceId: l.holderInstanceId };
  assert.equal(fx.elig(flow.callId, { holderId: l.holderId, holderInstanceId: l.holderInstanceId }).status, "ELIGIBLE", "race 之前必须真实 ELIGIBLE");
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

/* ------------------------------------------------------------------ real cross-process claim contention */

async function setupLeasedTrash() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c2-claim-"));
  const dbPath = path.join(root, "identity.db");
  const fx = await createToolHarnessFixture({ withAdapters: true, dbPath, keepData: true });
  const created = await fx.createResource("C2 Claim Target");
  const resourceRef = created.resource.resourceRef;
  fx.grantTool("ai", ["tool.resource.trash"]);
  fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
  fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
  const run = fx.dshRunSetup();
  const p = await fx.sideEffectAuthority.planSideEffect({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, arguments: { resourceRef } });
  assert.equal(p.ok, true, JSON.stringify(p));
  const userCtx = { sessionRef: fx.f.sessions.admin, appId: "ai", source: "user" };
  assert.equal(fx.sideEffectAuthority.approveSideEffect({ context: userCtx, callId: p.call.callId }).ok, true);
  const lease = fx.sideEffectAuthority.acquireLease({ context: fx.ctx(), callId: p.call.callId, holderId: "exec_1", instanceId: "instA", ttlMs: 600000 });
  assert.equal(lease.ok, true, JSON.stringify(lease));
  const now = fx.f.clock();
  const storeRoot = fx.f.storeRoot;
  await fx.close();
  return { root, storeRoot, dbPath, callId: p.call.callId, leaseId: lease.lease.leaseId, now, resourceRef };
}

function spawnContender(args) {
  const child = spawn(process.execPath, [CONTENDER, JSON.stringify(args)], { stdio: ["pipe", "pipe", "pipe"] });
  const box = { child, ready: false, result: null, deleteCalls: null, stderr: "" };
  let buf = "";
  box.done = new Promise((resolve) => {
    child.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg = null; try { msg = JSON.parse(line); } catch { msg = null; }
        if (!msg) continue;
        if (msg.type === "ready") box.ready = true;
        if (msg.type === "result") { box.result = msg.result; box.deleteCalls = msg.deleteCalls; resolve(true); }
      }
    });
    child.on("exit", () => resolve(box.result != null));
  });
  child.stderr.on("data", (d) => { box.stderr += String(d); });
  child.stdin.on("error", () => { /* child 已退出时忽略 EPIPE */ });
  return box;
}
async function waitReady(box, ms) {
  const deadline = Date.now() + ms;
  while (!box.ready && Date.now() < deadline) await sleep(20);
  assert.ok(box.ready, "executor 未就绪: " + box.stderr);
}
async function waitExit(box, ms) {
  if (box.child.exitCode != null || box.child.signalCode != null) return;
  await Promise.race([new Promise((r) => box.child.once("exit", r)), sleep(ms)]);
}

test("Real duplicate claim contention：同一合法 executor identity 两进程同时 claim → 恰好 1 RUNNING / 1 Domain invocation", async () => {
  const a = await setupLeasedTrash();
  const contenders = [];
  try {
    const base = { callId: a.callId, leaseId: a.leaseId, holderId: "exec_1", holderInstanceId: "instA", now: a.now, storeRoot: a.storeRoot, domainDelayMs: 500 };
    // 顺序启动（避开 WAL PRAGMA 争抢），GO 同时放行 → 真实跨进程 BEGIN IMMEDIATE contention。
    contenders.push(spawnContender({ ...base, dbPath: a.dbPath, instanceId: "child1" }));
    await waitReady(contenders[0], 30000);
    contenders.push(spawnContender({ ...base, dbPath: a.dbPath, instanceId: "child2" }));
    await waitReady(contenders[1], 30000);

    contenders[0].child.stdin.write("GO\n");
    contenders[1].child.stdin.write("GO\n");
    const done = await Promise.race([Promise.all(contenders.map((c) => c.done)), sleep(45000).then(() => null)]);
    assert.ok(done, "contender 超时: " + JSON.stringify(contenders.map((c) => c.stderr)));
    for (const c of contenders) { try { c.child.kill("SIGKILL"); } catch { /* ignore */ } }

    const results = contenders.map((c) => c.result);
    const winners = results.filter((r) => r && r.ok === true && r.executed === true);
    const losers = results.filter((r) => !(r && r.ok === true && r.executed === true));
    assert.equal(winners.length, 1, "claim success 必须恰好 1: " + JSON.stringify(results));
    assert.equal(losers.length, 1, "claim loser 必须恰好 1: " + JSON.stringify(results));
    assert.equal(winners[0].status, "SUCCEEDED");
    assert.equal(winners[0].verificationStatus, "PASS");
    assert.equal(winners[0].mutationCount, 1);
    // loser 必须 fail closed，且绝不 dispatch Domain。winner claim 后停留 500ms，
    // 使 duplicate invocation 真实竞争 LEASED → RUNNING（CLAIM_LOST）。
    assert.equal(losers[0].error, "SIDE_EFFECT_EXECUTION_CLAIM_LOST", "loser: " + JSON.stringify(losers[0]));
    assert.equal(losers[0].executed === true, false, "loser 绝不能 dispatch Domain");
    const totalDeletes = contenders.reduce((n, c) => n + (c.deleteCalls || 0), 0);
    assert.equal(totalDeletes, 1, "ResourceService.delete invocation 必须恰好 1: " + JSON.stringify(contenders.map((c) => c.deleteCalls)));
    const dump = JSON.stringify(results);
    assert.ok(!dump.includes("SQLITE_BUSY"), "不得暴露裸 SQLITE_BUSY: " + dump);
    assert.ok(!dump.includes("SQLITE_LOCKED"), "不得暴露裸 SQLITE_LOCKED: " + dump);

    for (const c of contenders) await waitExit(c, 5000);

    // 重开 disk DB 校验唯一 authority 真值。
    const identity = new IdentityStore({ path: a.dbPath }).open();
    try {
      const store = new SideEffectStore({ identity });
      assert.equal(identity.schemaVersion, 13);
      assert.equal(store.callById(a.callId).status, "SUCCEEDED");
      assert.equal(store.callById(a.callId).verificationStatus, "PASS");
      assert.equal(store.leasesOfCall(a.callId).filter((l) => l.status === "ACTIVE").length, 0, "final ACTIVE lease 必须 0");
      assert.equal(store.leasesOfCall(a.callId).filter((l) => l.status === "RELEASED").length, 1);
      assert.equal(store.callsOfTask(store.callById(a.callId).taskId).filter((c) => c.toolId === TRASH_TOOL).length, 1);
    } finally { identity.close(); }
  } finally {
    for (const c of contenders) { try { c.child.kill("SIGKILL"); } catch { /* ignore */ } }
    fs.rmSync(a.root, { recursive: true, force: true });
    try { fs.rmSync(a.storeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("Deterministic duplicate claim：call 已 RUNNING 时同 identity 再次 claim → EXECUTION_CLAIM_LOST + 0 mutation", async () => {
  const r = await readyTrash();
  try {
    // 模拟 duplicate delivery：第一个 executor 已 claim 进入 RUNNING（仍在 dispatch）。
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
