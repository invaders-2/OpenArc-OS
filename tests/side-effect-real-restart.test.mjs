/** D4-03C1 Closure · 真实 persisted restart：Runtime A 关闭 → Runtime B 新 instanceId 重开同一 disk DB。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const { AuthorizationService } = require("../electron/authorization-service.cjs");
const { TaskStore } = require("../electron/task-store.cjs");
const { TaskService } = require("../electron/task-service.cjs");
const { ToolStore } = require("../electron/tool-store.cjs");
const { ToolRegistry } = require("../electron/tool-registry.cjs");
const { SideEffectStore } = require("../electron/side-effect-store.cjs");
const { SideEffectAuthority } = require("../electron/side-effect-authority.cjs");

/** Runtime B：只重开 disk DB 与 authority，不重新 seed（避免覆盖既有 identity 数据）。 */
function reopenRuntimeB(dbPath, instanceId, now) {
  const identity = new IdentityStore({ path: dbPath, clock: () => now }).open();
  const authStore = new AuthorizationStore({ identity });
  const authService = new AuthorizationService({ identity, authStore });
  const taskStore = new TaskStore({ identity });
  const taskService = new TaskService({ identity, authService, authStore, taskStore });
  const toolStore = new ToolStore({ identity });
  const sideEffectStore = new SideEffectStore({ identity });
  const registry = new ToolRegistry();
  const authority = new SideEffectAuthority({ registry, sideEffectStore, taskStore, toolStore, authService, adapters: null, clock: () => now, taskService, instanceId });
  return { identity, authStore, authService, taskStore, taskService, toolStore, sideEffectStore, registry, authority, close() { try { identity.close(); } catch { /* ignore */ } } };
}

async function runtimeA({ status }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c1-restart-"));
  const dbPath = path.join(root, "identity.db");
  const fx = await createToolHarnessFixture({ withAdapters: true, dbPath, keepData: true });
  const run = fx.dshRunSetup();
  const p = await fx.sideEffectAuthority.planSideEffect({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: "test.write", arguments: { target: "doc-1" } });
  assert.equal(p.ok, true, JSON.stringify(p));
  const userCtx = { sessionRef: fx.f.sessions.admin, appId: "ai", source: "user" };
  assert.equal(fx.sideEffectAuthority.approveSideEffect({ context: userCtx, callId: p.call.callId }).ok, true);
  assert.equal(fx.sideEffectAuthority.acquireLease({ context: fx.ctx(), callId: p.call.callId, holderId: "exec_A", instanceId: "instA", ttlMs: 60000 }).ok, true);
  if (status) fx.sideEffectStore.transactSync(() => fx.sideEffectStore.updateCall(p.call.callId, { status, started_at: 1700000000000 }));
  const baseline = {
    calls: fx.sideEffectStore.callsOfTask(run.taskId).length,
    proposals: fx.toolStore.proposalsOfTask(run.taskId).length,
    executions: fx.toolStore.executionsOfTask(run.taskId).length,
  };
  const storeRoot = fx.f.storeRoot;
  const now = fx.f.clock();
  await fx.close(); // 关闭 Runtime A 的全部 DB handle（keepData 保留 disk 文件）
  return { root, storeRoot, dbPath, callId: p.call.callId, taskId: run.taskId, stepId: run.stepId, baseline, now };
}

function cleanup(a) {
  fs.rmSync(a.root, { recursive: true, force: true });
  try { fs.rmSync(a.storeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

test("真实 restart：RUNNING → UNKNOWN_EFFECT，Step/Task BLOCKED，旧 lease EXPIRED，0 replay / 0 retry / 0 execution", async () => {
  const a = await runtimeA({ status: "RUNNING" });
  try {
    const b = reopenRuntimeB(a.dbPath, "instB", a.now);
    try {
      assert.equal(b.identity.schemaVersion, SCHEMA_VERSION);
      const r = b.authority.recoverOnStartup({ instanceId: "instB" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
      assert.equal(r.unknownEffectCalls.length, 1);

      const call = b.sideEffectStore.callById(a.callId);
      assert.equal(call.status, "UNKNOWN_EFFECT");
      assert.notEqual(call.verificationStatus, "PASS");
      assert.notEqual(call.status, "FAILED");

      const leases = b.sideEffectStore.leasesOfCall(a.callId);
      assert.equal(leases.filter((l) => l.status === "ACTIVE").length, 0, "旧 lease 必须不再 ACTIVE");
      assert.equal(leases.filter((l) => l.status === "EXPIRED").length, 1);

      assert.equal(b.taskStore.taskById(a.taskId).status, "BLOCKED");
      assert.equal(b.taskStore.stepById(a.stepId).status, "BLOCKED");
      assert.ok(b.taskStore.eventsOfTask(a.taskId).some((e) => e.event_type === "tool.side_effect.unknown_effect"));
      assert.ok(b.taskStore.eventsOfTask(a.taskId).some((e) => e.event_type === "task.recovery_blocked"));

      assert.equal(b.sideEffectStore.callsOfTask(a.taskId).length, a.baseline.calls);
      assert.equal(b.toolStore.proposalsOfTask(a.taskId).length, a.baseline.proposals);
      assert.equal(b.toolStore.executionsOfTask(a.taskId).length, 0);

      const elig = b.authority.evaluateExecutionEligibility({ context: { sessionRef: null, appId: "ai" }, callId: a.callId, holderId: "exec_A" });
      assert.notEqual(elig.status, "ELIGIBLE");
      assert.equal(b.authority.executeSideEffect().error, "WRITE_EXECUTION_DISABLED");
      const v = await b.authority.verifyUnknownEffect({ callId: a.callId });
      assert.equal(v.ok, false);
      assert.equal(v.error, "SIDE_EFFECT_VERIFICATION_NOT_AVAILABLE");
      assert.equal(b.sideEffectStore.callById(a.callId).status, "UNKNOWN_EFFECT");
    } finally { b.close(); }
  } finally { cleanup(a); }
});

test("Crash-before-RUNNING：APPROVED/LEASED 不进入 UNKNOWN_EFFECT，旧 lease EXPIRED，可重新 acquire", async () => {
  const a = await runtimeA({ status: null });
  try {
    const b = reopenRuntimeB(a.dbPath, "instB", a.now);
    try {
      const r = b.authority.recoverOnStartup({ instanceId: "instB" });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.unknownEffectCalls.length, 0);
      assert.equal(b.sideEffectStore.callById(a.callId).status, "LEASED");
      assert.equal(b.sideEffectStore.leasesOfCall(a.callId).filter((l) => l.status === "ACTIVE").length, 0);
      const re = b.authority.acquireLease({ context: {}, callId: a.callId, holderId: "exec_B", instanceId: "instB", ttlMs: 60000 });
      assert.equal(re.ok, true, JSON.stringify(re));
      assert.equal(re.lease.holderInstanceId, "instB");
      assert.equal(b.toolStore.executionsOfTask(a.taskId).length, 0);
      assert.equal(b.authority.executeSideEffect().error, "WRITE_EXECUTION_DISABLED");
    } finally { b.close(); }
  } finally { cleanup(a); }
});

test("Recovery fail closed：TaskService 不可用时仍保持 UNKNOWN_EFFECT，绝不回退/重试", async () => {
  const a = await runtimeA({ status: "RUNNING" });
  try {
    const b = reopenRuntimeB(a.dbPath, "instB", a.now);
    try {
      // test-only seam：构造没有 TaskService 的 authority；生产路径始终注入 TaskService，
      // 且 recoverOnStartup 已删除 blockTask 开关，不存在 production bypass。
      const orphan = new SideEffectAuthority({ registry: b.registry, sideEffectStore: b.sideEffectStore, taskStore: b.taskStore, toolStore: b.toolStore, authService: {}, adapters: null, clock: () => Date.now(), taskService: null, instanceId: "instB" });
      const r = orphan.recoverOnStartup({ instanceId: "instB" });
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.detail === "TASK_SERVICE_UNAVAILABLE"), JSON.stringify(r.errors));
      assert.equal(b.sideEffectStore.callById(a.callId).status, "UNKNOWN_EFFECT");
      assert.equal(b.toolStore.executionsOfTask(a.taskId).length, 0);
    } finally { b.close(); }
  } finally { cleanup(a); }
});
