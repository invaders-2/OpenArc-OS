/**
 * D4-03C3 · 真实 crash / restart matrix（disk-backed + child process）。
 *
 * 覆盖：claim 后 dispatch 前 crash、mutation 后 crash、verification 后 crash、SUCCEEDED 后 crash，
 * 以及 idempotency across restart（same callId / idempotencyKey，0 replay / 0 retry / 0 second mutation）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
import { TRASH_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";
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

const CRASH_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "crash-executor.mjs");

async function setupTrashCall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c3-crash-"));
  const dbPath = path.join(root, "identity.db");
  const fx = await createToolHarnessFixture({ withAdapters: true, dbPath, keepData: true, sideEffectInstanceId: "instA" });
  const created = await fx.createResource("C3 Crash Target");
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
  const call = fx.sideEffectStore.callById(p.call.callId);
  const state = { root, dbPath, storeRoot: fx.f.storeRoot, now: fx.f.clock(), callId: p.call.callId, leaseId: lease.lease.leaseId, holderId: "exec_1", taskId: run.taskId, stepId: run.stepId, resourceRef, idempotencyKey: call.idempotencyKey };
  await fx.close();
  return state;
}
function cleanup(s) {
  try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(s.storeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}
function spawnCrash(args) {
  const child = spawn(process.execPath, [CRASH_EXECUTOR, JSON.stringify(args)], { stdio: ["ignore", "pipe", "pipe"] });
  const box = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (d) => { box.stdout += String(d); });
  child.stderr.on("data", (d) => { box.stderr += String(d); });
  box.done = new Promise((resolve) => { child.on("exit", (code) => resolve(code)); });
  box.messages = () => box.stdout.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return box;
}
function reopenRuntimeFull(s, instanceId) {
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
  const authority = new SideEffectAuthority({ registry, sideEffectStore, taskStore, toolStore, authService, adapters: createToolAdapters({ resourceService }), clock: () => s.now, taskService, instanceId });
  return { identity, authority, sideEffectStore, taskStore, toolStore, resourceService, deleteCalls: () => calls, close: () => identity.close() };
}
async function runCrash(s, crashPoint) {
  const box = spawnCrash({ dbPath: s.dbPath, storeRoot: s.storeRoot, now: s.now, callId: s.callId, leaseId: s.leaseId, holderId: s.holderId, instanceId: "instA", crashPoint });
  const code = await box.done;
  assert.notEqual(code, 0, "child 必须 crash: " + box.stderr);
  const crashMsg = box.messages().find((m) => m.type === "crash");
  assert.ok(crashMsg, "缺少 crash 标记: " + box.stdout + box.stderr);
  return crashMsg;
}

test("Crash before dispatch：restart → UNKNOWN_EFFECT → NOT_APPLIED + quiesced → FAILED，0 mutation", async () => {
  const s = await setupTrashCall();
  try {
    const crashMsg = await runCrash(s, "before_dispatch");
    assert.equal(crashMsg.deleteCalls, 0);
    const B = reopenRuntimeFull(s, "instB");
    try {
      const rec = B.authority.recoverOnStartup();
      assert.equal(rec.unknownEffectCalls.length, 1, JSON.stringify(rec));
      assert.equal(B.sideEffectStore.callById(s.callId).status, "UNKNOWN_EFFECT");
      assert.equal(B.sideEffectStore.callById(s.callId).recoverySafe.quiesced, true);
      assert.equal(B.taskStore.taskById(s.taskId).status, "BLOCKED");
      assert.equal(B.taskStore.stepById(s.stepId).status, "BLOCKED");
      assert.equal(B.sideEffectStore.leasesOfCall(s.callId).filter((l) => l.status === "ACTIVE").length, 0);
      const v = await B.authority.verifyUnknownEffect({ callId: s.callId });
      assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
      assert.equal(v.resolved, true);
      assert.equal(B.sideEffectStore.callById(s.callId).status, "FAILED");
      assert.equal(B.sideEffectStore.callById(s.callId).verificationStatus, "FAIL");
      assert.equal(B.deleteCalls(), 0, "0 Domain re-execution");
      assert.equal(B.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, false);
    } finally { B.close(); }
  } finally { cleanup(s); }
});

test("Crash after real mutation（C3 关键 E2E）→ restart → UNKNOWN_EFFECT → APPLIED → SUCCEEDED，exactly 1 delete", async () => {
  const s = await setupTrashCall();
  try {
    const crashMsg = await runCrash(s, "after_mutation");
    assert.equal(crashMsg.deleteCalls, 1, "mutation 已提交");
    const B = reopenRuntimeFull(s, "instB");
    try {
      B.authority.recoverOnStartup();
      assert.equal(B.sideEffectStore.callById(s.callId).status, "UNKNOWN_EFFECT");
      assert.equal(B.sideEffectStore.callById(s.callId).recoverySafe.quiesced, true);
      assert.equal(B.taskStore.taskById(s.taskId).status, "BLOCKED");
      assert.equal(B.taskStore.stepById(s.stepId).status, "BLOCKED");
      const v = await B.authority.verifyUnknownEffect({ callId: s.callId });
      assert.equal(v.outcome, "APPLIED", JSON.stringify(v));
      assert.equal(v.resolved, true);
      const call = B.sideEffectStore.callById(s.callId);
      assert.equal(call.status, "SUCCEEDED");
      assert.equal(call.verificationStatus, "PASS");
      assert.equal(call.idempotencyKey, s.idempotencyKey, "idempotencyKey 跨 restart 不变");
      assert.equal(crashMsg.deleteCalls + B.deleteCalls(), 1, "delete invocation 总计恰好 1");
      assert.equal(B.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, true);
    } finally { B.close(); }
  } finally { cleanup(s); }
});

test("Crash after verification before final persist → APPLIED → SUCCEEDED，无第二次 mutation", async () => {
  const s = await setupTrashCall();
  try {
    const crashMsg = await runCrash(s, "after_verification");
    assert.equal(crashMsg.deleteCalls, 1);
    const B = reopenRuntimeFull(s, "instB");
    try {
      B.authority.recoverOnStartup();
      const v = await B.authority.verifyUnknownEffect({ callId: s.callId });
      assert.equal(v.outcome, "APPLIED", JSON.stringify(v));
      assert.equal(B.sideEffectStore.callById(s.callId).status, "SUCCEEDED");
      assert.equal(B.sideEffectStore.callById(s.callId).verificationStatus, "PASS");
      assert.equal(crashMsg.deleteCalls + B.deleteCalls(), 1);
    } finally { B.close(); }
  } finally { cleanup(s); }
});

test("Crash after SUCCEEDED before lease finalize → Call remains SUCCEEDED，旧 lease EXPIRED，不重试", async () => {
  const s = await setupTrashCall();
  try {
    const crashMsg = await runCrash(s, "after_succeeded");
    assert.equal(crashMsg.deleteCalls, 1);
    const B = reopenRuntimeFull(s, "instB");
    try {
      B.authority.recoverOnStartup();
      const call = B.sideEffectStore.callById(s.callId);
      assert.equal(call.status, "SUCCEEDED", "SUCCEEDED 不能被降级");
      assert.equal(call.verificationStatus, "PASS");
      assert.equal(B.sideEffectStore.leasesOfCall(s.callId).filter((l) => l.status === "ACTIVE").length, 0, "旧 lease 必须 EXPIRED");
      const v = await B.authority.verifyUnknownEffect({ callId: s.callId });
      assert.equal(v.duplicate, true, "terminal call 不再重复收敛");
      assert.equal(B.deleteCalls(), 0);
    } finally { B.close(); }
  } finally { cleanup(s); }
});

test("Idempotency across restart：same callId / idempotencyKey，无第二个 call / lease / execution", async () => {
  const s = await setupTrashCall();
  try {
    await runCrash(s, "after_mutation");
    const B = reopenRuntimeFull(s, "instB");
    try {
      B.authority.recoverOnStartup();
      const v = await B.authority.verifyUnknownEffect({ callId: s.callId });
      assert.equal(v.outcome, "APPLIED");
      const calls = B.sideEffectStore.callsOfTask(s.taskId).filter((c) => c.toolId === TRASH_TOOL);
      assert.equal(calls.length, 1, "不得创建第二个 SideEffectCall");
      assert.equal(calls[0].idempotencyKey, s.idempotencyKey);
      assert.equal(B.sideEffectStore.leasesOfCall(s.callId).filter((l) => l.status === "ACTIVE").length, 0, "不得自动创建第二个 lease");
      const reacquire = B.authority.acquireLease({ context: {}, callId: s.callId, holderId: "exec_1" });
      assert.equal(reacquire.ok, false, "SUCCEEDED call 不能重新 acquire");
      assert.equal(B.deleteCalls(), 0);
    } finally { B.close(); }
  } finally { cleanup(s); }
});
