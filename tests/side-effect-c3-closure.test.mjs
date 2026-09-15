/**
 * D4-03C3 Closure · Trusted Quiescence Authority。
 *
 * 永久规则：different runtime instance != proof that the previous runtime is dead。
 * 只有 RuntimeLifecycleAuthority 真实观测到 origin runtime 退出，才允许 quiesced=true。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
import { createSideEffectFixture, TRASH_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";
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
const { RuntimeLifecycleAuthority } = require("../electron/runtime-lifecycle-authority.cjs");

const LIVE_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "live-runtime-executor.mjs");
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });

async function setupLeasedCall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c3c-"));
  const dbPath = path.join(root, "identity.db");
  const fx = await createToolHarnessFixture({ withAdapters: true, dbPath, keepData: true, sideEffectInstanceId: "instA" });
  const created = await fx.createResource("C3C Target");
  const resourceRef = created.resource.resourceRef;
  const resourceId = created.resource.resourceId;
  fx.grantTool("ai", ["tool.resource.trash"]);
  fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.delete"] });
  fx.grantUserResource(resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
  const run = fx.dshRunSetup();
  const p = await fx.sideEffectAuthority.planSideEffect({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, arguments: { resourceRef } });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(fx.sideEffectAuthority.approveSideEffect({ context: { sessionRef: fx.f.sessions.admin, appId: "ai", source: "user" }, callId: p.call.callId }).ok, true);
  const lease = fx.sideEffectAuthority.acquireLease({ context: fx.ctx(), callId: p.call.callId, holderId: "exec_1", ttlMs: 600000 });
  assert.equal(lease.ok, true, JSON.stringify(lease));
  const state = { root, dbPath, storeRoot: fx.f.storeRoot, now: fx.f.clock(), callId: p.call.callId, leaseId: lease.lease.leaseId, holderId: "exec_1", taskId: run.taskId, stepId: run.stepId, resourceRef, idempotencyKey: fx.sideEffectStore.callById(p.call.callId).idempotencyKey };
  await fx.close();
  return state;
}
function cleanup(s) {
  try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(s.storeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}
function reopenRuntimeFull(s, instanceId, lifecycle = null) {
  const identity = new IdentityStore({ path: s.dbPath, clock: () => s.now }).open();
  const authStore = new AuthorizationStore({ identity, clock: () => s.now });
  const authService = new AuthorizationService({ identity, authStore });
  const taskStore = new TaskStore({ identity });
  const taskService = new TaskService({ identity, authService, authStore, taskStore });
  const managedStore = new ManagedStore({ root: s.storeRoot });
  managedStore.ensureLayout();
  const resourceStore = new ResourceStore({ identity });
  const resourceService = new ResourceService({ identity, resourceStore, managedStore, authService, authStore });
  let calls = 0;
  const real = resourceService.delete.bind(resourceService);
  resourceService.delete = (...a) => { calls += 1; return real(...a); };
  const registry = new ToolRegistry();
  const toolStore = new ToolStore({ identity });
  const sideEffectStore = new SideEffectStore({ identity });
  const authority = new SideEffectAuthority({ registry, sideEffectStore, taskStore, toolStore, authService, adapters: createToolAdapters({ resourceService }), clock: () => s.now, taskService, instanceId, lifecycle });
  return { identity, authority, sideEffectStore, taskStore, toolStore, resourceService, deleteCalls: () => calls, close: () => identity.close() };
}
function spawnLive(args) {
  const child = spawn(process.execPath, [LIVE_EXECUTOR, JSON.stringify(args)], { stdio: ["pipe", "pipe", "pipe"] });
  const box = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (d) => { box.stdout += String(d); });
  child.stderr.on("data", (d) => { box.stderr += String(d); });
  child.stdin.on("error", () => { /* ignore EPIPE */ });
  box.done = new Promise((resolve) => { child.on("exit", (code, signal) => resolve({ code, signal })); });
  return box;
}
async function waitMessage(box, type, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = box.stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).find((m) => m && m.type === type);
    if (found) return found;
    await sleep(20);
  }
  assert.fail("未收到 " + type + "：" + box.stdout + box.stderr);
}
function liveArgs(s, extra = {}) {
  return { dbPath: s.dbPath, storeRoot: s.storeRoot, now: s.now, callId: s.callId, leaseId: s.leaseId, holderId: s.holderId, instanceId: "instA", timeoutMs: 200, ...extra };
}

test("Two live runtimes：不同 instanceId != dead proof；early NOT_APPLIED 不得 FAILED；late mutation 后 APPLIED", async () => {
  const s = await setupLeasedCall();
  const children = [];
  try {
    const lifecycle = new RuntimeLifecycleAuthority();
    lifecycle.registerRuntime("instA"); // A 真实存活：未 observeExit
    const A = spawnLive(liveArgs(s));
    children.push(A);
    await waitMessage(A, "unknown_effect", 30000);

    // B1：同一 disk DB 的另一个 runtime。lifecycle 证明 instA 仍 ACTIVE → 不能 quiesced。
    const B1 = reopenRuntimeFull(s, "instB", lifecycle);
    try {
      B1.authority.recoverOnStartup();
      const call1 = B1.sideEffectStore.callById(s.callId);
      assert.equal(call1.status, "UNKNOWN_EFFECT");
      assert.equal(call1.recoverySafe.quiesced, false, "live runtime 不能被声明 quiesced");
      assert.equal(call1.recoverySafe.quiescenceReason, "RUNTIME_STILL_ACTIVE");
      const early = await B1.authority.verifyUnknownEffect({ callId: s.callId });
      assert.equal(early.outcome, "NOT_APPLIED");
      assert.equal(early.resolved, false, "live old runtime 不得被 false-negative 成 FAILED");
      assert.equal(B1.sideEffectStore.callById(s.callId).status, "UNKNOWN_EFFECT");
      assert.equal(B1.deleteCalls(), 0);
    } finally { B1.close(); }

    // 放行 A 的真实 mutation，然后 kill A（A 不 finalize）。
    A.child.stdin.write("MUTATE\n");
    await waitMessage(A, "mutation_done", 30000);
    A.child.kill("SIGKILL");
    await A.done;
    lifecycle.observeExit("instA", { signal: "SIGKILL" });

    const B2 = reopenRuntimeFull(s, "instB2", lifecycle);
    try {
      B2.authority.recoverOnStartup();
      const call2 = B2.sideEffectStore.callById(s.callId);
      assert.equal(call2.status, "UNKNOWN_EFFECT", "quiescence 升级不推断 effect");
      assert.equal(call2.recoverySafe.quiesced, true);
      assert.equal(call2.recoverySafe.source, "cold_restart_confirmed");
      const late = await B2.authority.verifyUnknownEffect({ callId: s.callId });
      assert.equal(late.outcome, "APPLIED", JSON.stringify(late));
      assert.equal(B2.sideEffectStore.callById(s.callId).status, "SUCCEEDED");
      assert.equal(B2.deleteCalls(), 0, "0 second execution / 0 retry");
      assert.equal(B2.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, true);
      assert.equal(B2.sideEffectStore.callsOfTask(s.taskId).filter((c) => c.toolId === TRASH_TOOL).length, 1);
      assert.equal(B2.sideEffectStore.leasesOfCall(s.callId).filter((l) => l.status === "ACTIVE").length, 0);
    } finally { B2.close(); }
  } finally {
    for (const c of children) { try { c.child.kill("SIGKILL"); } catch { /* ignore */ } }
    cleanup(s);
  }
});

test("Timeout → 真实进程死亡（mutation 未发生）→ trusted quiescence → NOT_APPLIED → FAILED", async () => {
  const s = await setupLeasedCall();
  const children = [];
  try {
    const lifecycle = new RuntimeLifecycleAuthority();
    lifecycle.registerRuntime("instA");
    const A = spawnLive(liveArgs(s));
    children.push(A);
    await waitMessage(A, "unknown_effect", 30000);
    A.child.kill("SIGKILL"); // mutation 前 kill
    await A.done;
    lifecycle.observeExit("instA", { signal: "SIGKILL" });

    const B = reopenRuntimeFull(s, "instB", lifecycle);
    try {
      B.authority.recoverOnStartup();
      assert.equal(B.sideEffectStore.callById(s.callId).recoverySafe.quiesced, true);
      const v = await B.authority.verifyUnknownEffect({ callId: s.callId });
      assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
      assert.equal(v.resolved, true);
      assert.equal(B.sideEffectStore.callById(s.callId).status, "FAILED");
      assert.equal(B.sideEffectStore.callById(s.callId).verificationStatus, "FAIL");
      assert.equal(B.taskStore.taskById(s.taskId).status, "BLOCKED");
      assert.equal(B.taskStore.stepById(s.stepId).status, "BLOCKED");
      assert.equal(B.deleteCalls(), 0);
      assert.equal(B.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, false, "mutation total = 0");
      assert.equal(B.sideEffectStore.leasesOfCall(s.callId).filter((l) => l.status === "ACTIVE").length, 0);
    } finally { B.close(); }
  } finally {
    for (const c of children) { try { c.child.kill("SIGKILL"); } catch { /* ignore */ } }
    cleanup(s);
  }
});

test("Timeout → late applied → 进程死亡 → restart quiescence 升级 → APPLIED → SUCCEEDED", async () => {
  const s = await setupLeasedCall();
  const children = [];
  try {
    const lifecycle = new RuntimeLifecycleAuthority();
    lifecycle.registerRuntime("instA");
    const A = spawnLive(liveArgs(s));
    children.push(A);
    await waitMessage(A, "unknown_effect", 30000);
    A.child.stdin.write("MUTATE\n");
    const done = await waitMessage(A, "mutation_done", 30000);
    assert.equal(done.deleteCalls, 1);
    A.child.kill("SIGKILL");
    await A.done;
    lifecycle.observeExit("instA", { signal: "SIGKILL" });

    const B = reopenRuntimeFull(s, "instB", lifecycle);
    try {
      B.authority.recoverOnStartup();
      assert.equal(B.sideEffectStore.callById(s.callId).recoverySafe.quiesced, true);
      const v = await B.authority.verifyUnknownEffect({ callId: s.callId });
      assert.equal(v.outcome, "APPLIED", JSON.stringify(v));
      assert.equal(B.sideEffectStore.callById(s.callId).status, "SUCCEEDED");
      assert.equal(B.deleteCalls(), 0, "Domain invocation = 1（只在 A）");
      assert.equal(B.sideEffectStore.callById(s.callId).idempotencyKey, s.idempotencyKey);
    } finally { B.close(); }
  } finally {
    for (const c of children) { try { c.child.kill("SIGKILL"); } catch { /* ignore */ } }
    cleanup(s);
  }
});
/* ------------------------------------------------ in-process trusted-quiescence gates */

/** 直接写一个 UNKNOWN_EFFECT(quiesced=false) 的 recovery evidence（targeted quiescence 测试）。 */
function persistUnquiescedUnknown(fx, callId, originRuntimeInstanceId, leaseId = null) {
  fx.store.transactSync(() => fx.store.updateCall(callId, {
    status: "UNKNOWN_EFFECT",
    error_code: "SIDE_EFFECT_UNKNOWN_EFFECT",
    verification_status: null,
    recovery_safe: { quiesced: false, source: "live_timeout", originRuntimeInstanceId, originLeaseId: leaseId, reason: "SIDE_EFFECT_TIMEOUT", recordedAt: fx.fx.f.clock() },
  }));
}

test("UNKNOWN_EFFECT without proven death（self runtime）→ 保持 UNKNOWN_EFFECT，绝不 FAILED", async () => {
  const fx = await createSideEffectFixture();
  try {
    const sc = await fx.setupTrash();
    const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run });
    const l = flow.lease.lease;
    // live timeout 的 origin 就是当前 runtime（self，永远不是 dead proof）。
    persistUnquiescedUnknown(fx, flow.callId, fx.authority.instanceId, l.leaseId);
    fx.authority.recoverOnStartup();
    const call = fx.store.callById(flow.callId);
    assert.equal(call.status, "UNKNOWN_EFFECT");
    assert.equal(call.recoverySafe.quiesced, false);
    assert.equal(call.recoverySafe.quiescenceReason, "SELF_RUNTIME_ACTIVE");
    const v = await fx.authority.verifyUnknownEffect({ callId: flow.callId });
    assert.equal(v.outcome, "NOT_APPLIED");
    assert.equal(v.resolved, false);
    assert.equal(fx.store.callById(flow.callId).status, "UNKNOWN_EFFECT");
  } finally { await fx.fx.close(); }
});

test("Lease EXPIRED / REVOKED 单独 != quiescence", async () => {
  const lifecycle = new RuntimeLifecycleAuthority();
  lifecycle.registerRuntime("instA"); // ACTIVE：未观测到退出
  const fx = await createSideEffectFixture({ sideEffectLifecycle: lifecycle });
  try {
    const sc = await fx.setupTrash();
    const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run, instanceId: "instA" });
    const l = flow.lease.lease;
    // lease REVOKED（live timeout 的正常结果），但 origin runtime 仍 ACTIVE。
    assert.equal(fx.authority.revokeLease({ callId: flow.callId, leaseId: l.leaseId }).ok, true);
    persistUnquiescedUnknown(fx, flow.callId, "instA", l.leaseId);
    fx.authority.recoverOnStartup();
    const call = fx.store.callById(flow.callId);
    assert.equal(call.recoverySafe.quiesced, false, "lease REVOKED 不等于 dead proof");
    assert.equal(call.recoverySafe.quiescenceReason, "RUNTIME_STILL_ACTIVE");
    const v = await fx.authority.verifyUnknownEffect({ callId: flow.callId });
    assert.equal(v.resolved, false);
    assert.equal(fx.store.callById(flow.callId).status, "UNKNOWN_EFFECT");
  } finally { await fx.fx.close(); }
});

test("RuntimeId mismatch / unknown runtime 单独 != quiescence", async () => {
  const lifecycle = new RuntimeLifecycleAuthority(); // 空 registry：origin 未注册
  const fx = await createSideEffectFixture({ sideEffectLifecycle: lifecycle });
  try {
    const sc = await fx.setupTrash();
    const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run, instanceId: "instA" });
    persistUnquiescedUnknown(fx, flow.callId, "instA", flow.lease.lease.leaseId);
    fx.authority.recoverOnStartup();
    const call = fx.store.callById(flow.callId);
    assert.equal(call.recoverySafe.quiesced, false);
    assert.equal(call.recoverySafe.quiescenceReason, "UNKNOWN_RUNTIME");
    assert.equal((await fx.authority.verifyUnknownEffect({ callId: flow.callId })).resolved, false);
    assert.equal(fx.store.callById(flow.callId).status, "UNKNOWN_EFFECT");
  } finally { await fx.fx.close(); }
});

test("APPLIED 不依赖 quiescence：可靠看到 APPLIED → SUCCEEDED", async () => {
  const lifecycle = new RuntimeLifecycleAuthority();
  lifecycle.registerRuntime("instA"); // ACTIVE
  const fx = await createSideEffectFixture({ sideEffectLifecycle: lifecycle });
  try {
    const sc = await fx.setupTrash();
    const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run, instanceId: "instA" });
    const del = await fx.fx.f.resourceService.delete({ context: fx.fx.f.adminCtx(), resourceRef: sc.resourceRef, expectedVersion: 1 });
    assert.equal(del.ok, true, JSON.stringify(del));
    persistUnquiescedUnknown(fx, flow.callId, "instA", flow.lease.lease.leaseId);
    fx.authority.recoverOnStartup();
    assert.equal(fx.store.callById(flow.callId).recoverySafe.quiesced, false, "quiescence 未证明");
    const v = await fx.authority.verifyUnknownEffect({ callId: flow.callId });
    assert.equal(v.outcome, "APPLIED", JSON.stringify(v));
    assert.equal(v.resolved, true);
    assert.equal(fx.store.callById(flow.callId).status, "SUCCEEDED");
    assert.equal(fx.store.callById(flow.callId).verificationStatus, "PASS");
  } finally { await fx.fx.close(); }
});
