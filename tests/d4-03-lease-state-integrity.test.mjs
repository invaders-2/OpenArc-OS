/**
 * D4-03 Lease/State Integrity · S1 + A-4。
 *
 * S1（跨 runtime 状态机不自洽）：另一个仍存活的 runtime 已把同一 call 收敛为 UNKNOWN_EFFECT 时，
 *   本 runtime 的**迟到**终态写回绝不覆盖权威状态（ADR：RUNNING→UNKNOWN_EFFECT；UNKNOWN_EFFECT→VERIFY→BLOCK）。
 * A-4（终态遗留 ACTIVE lease）：终态 call 绝不残留 ACTIVE lease —— 终态写回与自身 lease 的终结
 *   必须在同一事务内完成；恢复 / deny 路径同样不得留下残留。
 *
 * 真实装配：tests/fixtures/harness-acp 的既有 store / authority / fixture seam；不 mock service。
 * 只有 T3 用既有 SideEffectStore.insertLease 在测试内构造"遗留 lease"，不改产品语义。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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

const LATE_SUPPRESSED = "tool.side_effect.late_result_suppressed";

/** 统计真实 ResourceService.delete 的 Domain invocation（与 side-effect-write-e2e 同法）。 */
function countDeleteCalls(sf) {
  const real = sf.fx.f.resourceService.delete.bind(sf.fx.f.resourceService);
  const box = { calls: 0 };
  sf.fx.f.resourceService.delete = (args) => { box.calls += 1; return real(args); };
  return box;
}
const activeLeasesOf = (store, callId) => store.leasesOfCall(callId).filter((l) => l.status === "ACTIVE");

/**
 * 同一 disk DB / storeRoot 上的第二个 runtime（A/B 双 runtime 语义，参照 D4-03C3 Closure 的
 * reopenRuntimeFull）：独立 identity 连接 + 独立 authority instance，内存状态零共享。
 */
function openSecondRuntime({ dbPath, storeRoot, instanceId, clock }) {
  const identity = new IdentityStore({ path: dbPath, clock }).open();
  const authStore = new AuthorizationStore({ identity, clock });
  const authService = new AuthorizationService({ identity, authStore });
  const taskStore = new TaskStore({ identity, clock });
  const toolStore = new ToolStore({ identity, clock });
  const sideEffectStore = new SideEffectStore({ identity, clock });
  const taskService = new TaskService({ identity, authService, authStore, taskStore, clock });
  const resourceStore = new ResourceStore({ identity, clock });
  const managedStore = new ManagedStore({ root: storeRoot });
  managedStore.ensureLayout();
  const resourceService = new ResourceService({ identity, resourceStore, managedStore, authService, authStore, clock });
  let deleteCalls = 0;
  const realDelete = resourceService.delete.bind(resourceService);
  resourceService.delete = (args) => { deleteCalls += 1; return realDelete(args); };
  const authority = new SideEffectAuthority({
    registry: new ToolRegistry(), sideEffectStore, taskStore, toolStore, authService,
    adapters: createToolAdapters({ resourceService }), clock, taskService, instanceId,
  });
  return {
    identity, authority, sideEffectStore, taskStore, taskService, resourceService,
    deleteCalls: () => deleteCalls,
    close() { try { identity.close(); } catch { /* ignore */ } },
  };
}

/**
 * T4/T6/T8 共用：A 已 claim RUNNING 后，B 用真实 recoverOnStartup 抢先收敛同一 call。
 * hook 默认落在"Domain mutation 已提交、尚未验证"；失败类结果（不经过验证）用 afterClaimBeforeDispatch。
 * deleteImpl 可注入 Domain 结果（known-no-effect / 非白名单），默认走真实 delete。
 */
async function runLateResultScenario({ hook = "afterDomainResultBeforeVerification", deleteImpl = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d403-lsi-"));
  const dbPath = path.join(root, "identity.db");
  const hold = { sf: null, b: null, bRecovery: null, snapshotAtInterleave: null };
  const sf = await createSideEffectFixture({
    dbPath, keepData: true, sideEffectInstanceId: "instA",
    sideEffectTestHooks: {
      // 真实交错点：A 已 claim（RUNNING）而尚未落收敛结果 —— 此时 B 才看得到 RUNNING。
      [hook]: ({ callId }) => {
        hold.bRecovery = hold.b.authority.recoverOnStartup();
        hold.snapshotAtInterleave = JSON.stringify(hold.sf.store.callById(callId));
      },
    },
  });
  hold.sf = sf;
  const b = openSecondRuntime({ dbPath, storeRoot: sf.fx.f.storeRoot, instanceId: "instB", clock: sf.fx.f.clock });
  hold.b = b;
  const sc = await sf.setupTrash({ resourceName: "D4-03 Late Result Target" });
  const counter = { calls: 0 };
  const domain = sf.fx.f.resourceService;
  const realDelete = domain.delete.bind(domain);
  domain.delete = (args) => { counter.calls += 1; return deleteImpl ? deleteImpl(args) : realDelete(args); };
  const flow = await sf.trashFlow({ ref: sc.resourceRef, run: sc.run });
  const exec = await sf.authority.executeSideEffect({ callId: flow.callId, leaseId: flow.lease.lease.leaseId, holderId: "exec_1" });
  return {
    sf, b, hold, sc, flow, exec, counter,
    async cleanup() {
      try { b.close(); } catch { /* ignore */ }
      try { await sf.fx.close(); } catch { /* ignore */ }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/* ============================================================ T1 A-4 崩溃窗口 */
test("T1 · A-4：SUCCEEDED 落定时刻 call 已是终态且无 ACTIVE lease（同一事务）", async () => {
  const hold = { sf: null, atHook: null };
  const sf = await createSideEffectFixture({
    sideEffectTestHooks: {
      afterSucceededBeforeLeaseFinalize: ({ callId }) => {
        hold.atHook = { call: hold.sf.store.callById(callId), active: hold.sf.store.activeLeaseOfCall(callId) };
      },
    },
  });
  hold.sf = sf;
  try {
    const sc = await sf.setupTrash({ resourceName: "T1 Crash Window Target" });
    const counter = countDeleteCalls(sf);
    const flow = await sf.trashFlow({ ref: sc.resourceRef, run: sc.run });
    const exec = await sf.authority.executeSideEffect({ callId: flow.callId, leaseId: flow.lease.lease.leaseId, holderId: "exec_1" });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(counter.calls, 1);
    assert.ok(hold.atHook, "seam 必须被真实触发");
    assert.equal(hold.atHook.call.status, "SUCCEEDED");
    assert.equal(hold.atHook.active, null, "终态写回时刻该 call 已无 ACTIVE lease");
    assert.deepEqual(activeLeasesOf(sf.store, flow.callId), []);
    // 崩溃窗口消失：进程内不再需要任何 lease 回收才能继续 append/runTask。
    assert.deepEqual(sf.taskService.getSideEffectSafety({ context: sf.ctx(), taskId: sc.run.taskId }), { ok: true, taskId: sc.run.taskId, blocked: false, code: null });
    assert.equal(sf.taskService.getAppendEligibility({ context: sf.ctx(), taskId: sc.run.taskId }).reason !== "APPEND_ACTIVE_LEASE", true);
    console.log("T1 before/after 观察点: " + JSON.stringify({ call: hold.atHook.call.status, activeLease: hold.atHook.active ? hold.atHook.active.status : null, safety: sf.taskService.getSideEffectSafety({ context: sf.ctx(), taskId: sc.run.taskId }) }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T2 A-4 非崩溃路径 */
test("T2 · A-4：denySideEffect 收敛 LEASED call 时终结其 ACTIVE lease", async () => {
  const sf = await createSideEffectFixture();
  try {
    const sc = await sf.setupTrash({ resourceName: "T2 Deny Target" });
    const flow = await sf.trashFlow({ ref: sc.resourceRef, run: sc.run });
    assert.equal(sf.store.callById(flow.callId).status, "LEASED");
    assert.equal(activeLeasesOf(sf.store, flow.callId).length, 1);
    const denied = sf.deny(flow.callId);
    assert.equal(denied.ok, true, JSON.stringify(denied));
    assert.equal(sf.store.callById(flow.callId).status, "BLOCKED");
    assert.deepEqual(activeLeasesOf(sf.store, flow.callId), [], "deny 后不得残留 ACTIVE lease");
    assert.equal(sf.precondition(sc.resourceRef).trashed, false, "0 mutation");
    assert.deepEqual(sf.taskService.getSideEffectSafety({ context: sf.ctx(), taskId: sc.run.taskId }), { ok: true, taskId: sc.run.taskId, blocked: false, code: null });
    console.log("T2 after deny: " + JSON.stringify({ call: sf.store.callById(flow.callId).status, activeLeases: activeLeasesOf(sf.store, flow.callId).length, safety: sf.taskService.getSideEffectSafety({ context: sf.ctx(), taskId: sc.run.taskId }) }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T3 A-4 恢复路径 */
test("T3 · A-4：终态 call 的遗留 ACTIVE lease 被 recoverAfterExecutorExit 回收，终态与证据不变", async () => {
  const sf = await createSideEffectFixture();
  try {
    const sc = await sf.setupTrash({ resourceName: "T3 Recovery Target" });
    const flow = await sf.trashFlow({ ref: sc.resourceRef, run: sc.run });
    const exec = await sf.authority.executeSideEffect({ callId: flow.callId, leaseId: flow.lease.lease.leaseId, holderId: "exec_1" });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(sf.store.callById(flow.callId).status, "SUCCEEDED");
    // 用既有 store API 构造"终态 + 遗留 ACTIVE lease"（模拟旧版本/崩溃遗留），不改产品语义。
    const now = sf.fx.f.clock();
    const stale = sf.store.insertLease({ callId: flow.callId, holderId: "exec_stale", holderInstanceId: "exe_A4", status: "ACTIVE", issuedAt: now, expiresAt: now + 600000 });
    const foreign = sf.store.insertLease({ callId: flow.callId, holderId: "exec_other", holderInstanceId: "exe_other", status: "ACTIVE", issuedAt: now, expiresAt: now + 600000 });
    const before = JSON.stringify(sf.store.callById(flow.callId));
    const rec = sf.authority.recoverAfterExecutorExit({ callId: flow.callId, executorInstanceId: "exe_A4" });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.equal(rec.status, "SUCCEEDED");
    assert.equal(sf.store.leaseById(stale.leaseId).status, "REVOKED", "本 executor 的遗留 lease 必须被回收");
    assert.equal(sf.store.leaseById(foreign.leaseId).status, "ACTIVE", "绝不触碰其它 runtime 的 lease");
    assert.equal(JSON.stringify(sf.store.callById(flow.callId)), before, "终态 / verification / 证据逐字不变");
    // 幂等：重复调用无第二次状态变化。
    const again = sf.authority.recoverAfterExecutorExit({ callId: flow.callId, executorInstanceId: "exe_A4" });
    assert.equal(again.ok, true);
    assert.equal(again.status, "SUCCEEDED");
    assert.equal(sf.store.leaseById(stale.leaseId).status, "REVOKED");
    assert.equal(JSON.stringify(sf.store.callById(flow.callId)), before);
    console.log("T3 after recovery: " + JSON.stringify({ call: sf.store.callById(flow.callId).status, stale: sf.store.leaseById(stale.leaseId).status, foreign: sf.store.leaseById(foreign.leaseId).status }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T4 S1 复现与闭合 */
test("T4 · S1：另一个 runtime 的 UNKNOWN_EFFECT 权威不被本 runtime 迟到终态覆盖", async () => {
  const r = await runLateResultScenario();
  try {
    const { sf, b, hold, sc, flow, exec, counter } = r;
    assert.ok(hold.bRecovery, "B 必须在 A 落终态前真实执行 recoverOnStartup");
    assert.equal(hold.bRecovery.unknownEffectCalls.length, 1, JSON.stringify(hold.bRecovery));
    assert.equal(exec.ok, false, "迟到结果不得声称成功状态迁移：" + JSON.stringify(exec));
    assert.equal(exec.executed, true);
    assert.equal(exec.suppressed, true);
    assert.equal(exec.mutationCount, 1);
    const call = sf.store.callById(flow.callId);
    assert.equal(call.status, "UNKNOWN_EFFECT", "B 的权威状态绝不被 A 覆盖");
    assert.equal(call.verificationStatus, null);
    assert.equal(sf.store.leaseById(flow.lease.lease.leaseId).status, "EXPIRED", "B 的 lease 判定不被 A 覆盖");
    assert.deepEqual(activeLeasesOf(sf.store, flow.callId), []);
    assert.equal(sf.taskStore.taskById(sc.run.taskId).status, "BLOCKED");
    assert.equal(sf.taskStore.stepById(sc.run.stepId).status, "BLOCKED");
    assert.equal(counter.calls, 1, "副作用恰好 1 次");
    assert.equal(b.deleteCalls(), 0, "B 0 执行");
    assert.equal(sf.store.callsOfTask(sc.run.taskId).filter((c) => c.toolId === TRASH_TOOL).length, 1, "无第二条 SideEffectCall");
    const rec = sf.taskService.getRecoveryState({ context: sf.ctx(), taskId: sc.run.taskId });
    assert.equal(rec.applicable, true, "UNKNOWN_EFFECT 恢复入口必须保留");
    assert.equal(rec.taskStatus, "BLOCKED");
    assert.equal(rec.calls.length, 1);
    const events = sf.taskStore.eventsOfTask(sc.run.taskId).map((e) => ({ type: e.event_type, payload: e.safe_payload ? JSON.parse(e.safe_payload) : null }));
    const late = events.filter((e) => e.type === LATE_SUPPRESSED);
    assert.equal(late.length, 1, "必须落下 late_result_suppressed safe 事件：" + JSON.stringify(events.map((e) => e.type)));
    assert.deepEqual(Object.keys(late[0].payload).sort(), ["callId", "observedStatus", "toolId"]);
    assert.equal(late[0].payload.callId, flow.callId);
    assert.equal(late[0].payload.observedStatus, "UNKNOWN_EFFECT");
    assert.equal(JSON.stringify(late[0].payload).includes("/"), false, "payload 不含路径");
    console.log("T4 A 迟到写回: " + JSON.stringify({ exec: { ok: exec.ok, executed: exec.executed, suppressed: exec.suppressed, error: exec.error }, call: call.status, task: sf.taskStore.taskById(sc.run.taskId).status, recoveryApplicable: rec.applicable, domainCalls: counter.calls, lateEvent: late[0].payload }));
  } finally { await r.cleanup(); }
});

/* ============================================================ T6 幂等 / 收敛 */
test("T6 · 既有恢复路径仍可用：verifyUnknownEffect → APPLIED → SUCCEEDED（0 二次执行）", async () => {
  const r = await runLateResultScenario();
  try {
    const { sf, b, sc, flow, counter } = r;
    assert.equal(sf.store.callById(flow.callId).status, "UNKNOWN_EFFECT");
    const v = await b.authority.verifyUnknownEffect({ callId: flow.callId });
    assert.equal(v.outcome, "APPLIED", JSON.stringify(v));
    assert.equal(v.resolved, true);
    const call = sf.store.callById(flow.callId);
    assert.equal(call.status, "SUCCEEDED");
    assert.equal(call.verificationStatus, "PASS");
    assert.equal(counter.calls, 1, "Domain invocation 仍然恰好 1（恢复只读）");
    assert.equal(b.deleteCalls(), 0, "恢复路径 0 execute / 0 retry");
    assert.equal(sf.precondition(sc.resourceRef).trashed, true);
    console.log("T6 收敛: " + JSON.stringify({ verified: { outcome: v.outcome, resolved: v.resolved }, call: call.status, verificationStatus: call.verificationStatus, domainCalls: counter.calls }));
  } finally { await r.cleanup(); }
});

/* ============================================================ T5 正对照 */
test("T5 · 正对照：单 runtime WRITE 全链 SUCCEEDED/PASS、lease RELEASED、恰好 1 次 mutation", async () => {
  const sf = await createSideEffectFixture();
  try {
    const sc = await sf.setupTrash({ resourceName: "T5 Positive Target" });
    const counter = countDeleteCalls(sf);
    const flow = await sf.trashFlow({ ref: sc.resourceRef, run: sc.run });
    const exec = await sf.authority.executeSideEffect({ callId: flow.callId, leaseId: flow.lease.lease.leaseId, holderId: "exec_1" });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(exec.executed, true);
    assert.equal(exec.mutationCount, 1);
    assert.equal(exec.suppressed, undefined, "正常路径绝不进入 suppressed 形状");
    assert.equal(exec.verificationStatus, "PASS");
    assert.equal(exec.call.status, "SUCCEEDED");
    assert.equal(counter.calls, 1);
    assert.equal(sf.store.activeLeaseOfCall(flow.callId), null);
    assert.deepEqual(sf.store.leasesOfCall(flow.callId).filter((l) => l.status === "RELEASED").length, 1);
    assert.equal(sf.precondition(sc.resourceRef).trashed, true);
    // append / resume 既有判定逐字不变（task 仍 RUNNING → 既有 reason 不变）。
    assert.deepEqual(sf.taskService.getSideEffectSafety({ context: sf.ctx(), taskId: sc.run.taskId }), { ok: true, taskId: sc.run.taskId, blocked: false, code: null });
    assert.equal(sf.taskService.getAppendEligibility({ context: sf.ctx(), taskId: sc.run.taskId }).reason, "APPEND_IN_FLIGHT");
    assert.equal(sf.taskService.getResumeEligibility({ context: sf.ctx(), taskId: sc.run.taskId }).reason, "RESUME_NOT_BLOCKED");
    const events = sf.taskStore.eventsOfTask(sc.run.taskId).map((e) => e.event_type);
    for (const ev of ["tool.side_effect.execution_started", "tool.side_effect.verification_passed", "tool.side_effect.succeeded"]) assert.ok(events.includes(ev), "缺少事件 " + ev);
    assert.equal(events.includes(LATE_SUPPRESSED), false, "正常路径绝不落 late_result_suppressed");
    console.log("T5 正对照: " + JSON.stringify({ call: exec.call.status, verificationStatus: exec.verificationStatus, leases: sf.store.leasesOfCall(flow.callId).map((l) => l.status), domainCalls: counter.calls }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T7 A-4/S1 事务边界（全部收敛路径） */
/**
 * test-only 事务边界探针：在每个 transactSync 入口记录该 call 的 (status / ACTIVE lease)。
 * 若"写收敛结果"与"终结自身 lease"分处两个事务，必然会观察到 <收敛状态>/ACTIVE 边界态。
 */
function trackTransactionBoundaries(store, callId) {
  const seen = [];
  store.transactSync = (fn) => {
    const call = store.callById(callId);
    const active = store.activeLeaseOfCall(callId);
    seen.push((call ? call.status : "MISSING") + "/" + (active ? active.status : "NONE"));
    return IdentityStore.prototype.transactSync.call(store, fn);
  };
  return { seen, restore() { delete store.transactSync; } };
}
const CONVERGED_WITH_ACTIVE_LEASE = /^(SUCCEEDED|FAILED|BLOCKED|UNKNOWN_EFFECT)\/ACTIVE$/;

test("T7 · A-4：SUCCEEDED/UNKNOWN_EFFECT/FAILED/BLOCKED 四类收敛写回与 lease 终结均同一事务", async () => {
  const cases = [
    { name: "SUCCEEDED", status: "SUCCEEDED", lease: "RELEASED", deleteImpl: null },
    { name: "ambiguous→UNKNOWN_EFFECT", status: "UNKNOWN_EFFECT", lease: "REVOKED", deleteImpl: () => { throw new Error("T7_AMBIGUOUS_DOMAIN_RESULT"); } },
    { name: "known-no-effect→FAILED", status: "FAILED", lease: "RELEASED", deleteImpl: () => ({ ok: false, error: "VERSION_CONFLICT" }) },
    { name: "非白名单→BLOCKED", status: "BLOCKED", lease: "RELEASED", deleteImpl: () => ({ ok: false, error: "INTERNAL_DOMAIN_FAILURE" }) },
  ];
  for (const c of cases) {
    const sf = await createSideEffectFixture();
    try {
      const sc = await sf.setupTrash({ resourceName: "T7 " + c.name });
      const flow = await sf.trashFlow({ ref: sc.resourceRef, run: sc.run });
      const domain = sf.fx.f.resourceService;
      const realDelete = domain.delete.bind(domain);
      let domainCalls = 0;
      domain.delete = (args) => { domainCalls += 1; return c.deleteImpl ? c.deleteImpl(args) : realDelete(args); };
      const boundaries = trackTransactionBoundaries(sf.store, flow.callId);
      let exec;
      try {
        exec = await sf.authority.executeSideEffect({ callId: flow.callId, leaseId: flow.lease.lease.leaseId, holderId: "exec_1" });
      } finally { boundaries.restore(); domain.delete = realDelete; }
      assert.equal(domainCalls, 1, c.name + "：恰好 1 次 Domain invocation，绝不 retry");
      const call = sf.store.callById(flow.callId);
      assert.equal(call.status, c.status, c.name + "：" + JSON.stringify(exec));
      assert.deepEqual(activeLeasesOf(sf.store, flow.callId), [], c.name + "：收敛后不得残留 ACTIVE lease");
      assert.deepEqual(sf.store.leasesOfCall(flow.callId).map((l) => l.status), [c.lease], c.name);
      assert.equal(boundaries.seen.some((b) => CONVERGED_WITH_ACTIVE_LEASE.test(b)), false, c.name + "：收敛状态与 ACTIVE lease 绝不得跨事务共存：" + JSON.stringify(boundaries.seen));
      if (c.status === "SUCCEEDED") {
        assert.equal(exec.ok, true, JSON.stringify(exec));
        assert.equal(exec.verificationStatus, "PASS");
      }
      if (c.status === "UNKNOWN_EFFECT") {
        assert.equal(exec.error, "SIDE_EFFECT_UNKNOWN_EFFECT", JSON.stringify(exec));
        assert.equal(call.recoverySafe.quiesced, false);
        assert.equal(call.recoverySafe.originRuntimeInstanceId, sf.authority.instanceId);
        assert.equal(call.recoverySafe.originLeaseId, flow.lease.lease.leaseId);
        assert.equal(sf.taskStore.taskById(sc.run.taskId).status, "BLOCKED");
        assert.equal(sf.taskService.getRecoveryState({ context: sf.ctx(), taskId: sc.run.taskId }).applicable, true);
      }
      if (c.status === "FAILED") assert.equal(call.errorCode, "SIDE_EFFECT_PRECONDITION_CHANGED", JSON.stringify(call));
      if (c.status === "BLOCKED") assert.equal(call.errorCode, "INTERNAL_DOMAIN_FAILURE", JSON.stringify(call));
      console.log("T7 " + c.name + ": " + JSON.stringify({ execError: exec.error, call: call.status, leases: sf.store.leasesOfCall(flow.callId).map((l) => l.status), boundaries: boundaries.seen }));
    } finally { await sf.fx.close(); }
  }
});

/* ============================================================ T8 S1-b 迟到失败类写回（双 runtime） */
/**
 * S1-b：A 的 Domain 结果是失败类时，B 已收敛的 UNKNOWN_EFFECT 权威绝不被 FAILED/BLOCKED 覆盖。
 * 交错点用 afterClaimBeforeDispatch（A 已 claim RUNNING、尚未 dispatch）——失败类结果不经过验证 seam。
 */
async function assertLateFailureSuppressed({ label, deleteImpl }) {
  const r = await runLateResultScenario({ hook: "afterClaimBeforeDispatch", deleteImpl });
  try {
    const { sf, b, hold, sc, flow, exec, counter } = r;
    assert.ok(hold.bRecovery, "B 必须在 A 落收敛结果前真实执行 recoverOnStartup");
    assert.equal(hold.bRecovery.unknownEffectCalls.length, 1, JSON.stringify(hold.bRecovery));
    const call = sf.store.callById(flow.callId);
    assert.equal(call.status, "UNKNOWN_EFFECT", "B 的权威状态绝不被覆盖（实际=" + call.status + "）");
    assert.equal(JSON.stringify(call), hold.snapshotAtInterleave, "绝不覆盖任何持久化字段（status/error_code/completed_at/verification_status/recovery_safe/updated_at）");
    assert.equal(exec.ok, false, "迟到失败类结果不得声称终态迁移：" + JSON.stringify(exec));
    assert.equal(exec.executed, true);
    assert.equal(exec.suppressed, true);
    assert.equal(exec.observedStatus, "UNKNOWN_EFFECT");
    assert.equal(counter.calls, 1, "Domain invocation 恰好 1 次");
    assert.equal(b.deleteCalls(), 0, "B 0 执行");
    assert.equal(sf.store.callsOfTask(sc.run.taskId).filter((c) => c.toolId === TRASH_TOOL).length, 1, "无第二条 SideEffectCall");
    assert.deepEqual(activeLeasesOf(sf.store, flow.callId), []);
    assert.equal(sf.taskStore.taskById(sc.run.taskId).status, "BLOCKED");
    assert.equal(sf.taskStore.stepById(sc.run.stepId).status, "BLOCKED");
    const rec = sf.taskService.getRecoveryState({ context: sf.ctx(), taskId: sc.run.taskId });
    assert.equal(rec.applicable, true, "恢复入口必须保留");
    assert.equal(rec.calls.length, 1);
    const events = sf.taskStore.eventsOfTask(sc.run.taskId).map((e) => ({ type: e.event_type, payload: e.safe_payload ? JSON.parse(e.safe_payload) : null }));
    const late = events.filter((e) => e.type === LATE_SUPPRESSED);
    assert.equal(late.length, 1, "必须落下 late_result_suppressed 事件：" + JSON.stringify(events.map((e) => e.type)));
    assert.deepEqual(Object.keys(late[0].payload).sort(), ["callId", "observedStatus", "toolId"]);
    assert.equal(late[0].payload.observedStatus, "UNKNOWN_EFFECT");
    // 绝不落本 runtime 的失败收敛事件。
    assert.equal(events.some((e) => e.type === "tool.side_effect.execution_blocked" && e.payload && e.payload.callId === flow.callId), false, "不得落失败收敛 event");
    assert.equal(events.some((e) => e.type === "tool.side_effect.succeeded"), false, "不得落 succeeded event");
    assert.equal(events.some((e) => e.type === "tool.side_effect.verification_passed"), false);
    console.log("T8 " + label + ": " + JSON.stringify({ exec: { ok: exec.ok, executed: exec.executed, suppressed: exec.suppressed, error: exec.error, observedStatus: exec.observedStatus }, call: call.status, task: sf.taskStore.taskById(sc.run.taskId).status, recoveryApplicable: rec.applicable, domainCalls: counter.calls, lateEvent: late[0].payload }));
  } finally { await r.cleanup(); }
}

test("T8-a · S1-b：known-no-effect 迟到写回不覆盖 UNKNOWN_EFFECT 权威", async () => {
  await assertLateFailureSuppressed({ label: "known-no-effect(FAILED 类)", deleteImpl: () => ({ ok: false, error: "VERSION_CONFLICT" }) });
});

test("T8-b · S1-b：非白名单错误迟到写回不覆盖 UNKNOWN_EFFECT 权威", async () => {
  await assertLateFailureSuppressed({ label: "non-whitelist(BLOCKED 类)", deleteImpl: () => ({ ok: false, error: "INTERNAL_DOMAIN_FAILURE" }) });
});

/* ============================================================ T9 正对照：单 runtime 失败类逐字不变 */
test("T9 · 正对照：单 runtime known-no-effect→FAILED / ambiguous→UNKNOWN_EFFECT / 非白名单→BLOCKED", async () => {
  const cases = [
    { name: "known-no-effect→FAILED", deleteImpl: () => ({ ok: false, error: "VERSION_CONFLICT" }), status: "FAILED", errorCode: "SIDE_EFFECT_PRECONDITION_CHANGED", lease: "RELEASED", blockedEvent: true, knownNoEffect: true },
    { name: "ambiguous→UNKNOWN_EFFECT", deleteImpl: () => { throw new Error("T9_AMBIGUOUS_DOMAIN_RESULT"); }, status: "UNKNOWN_EFFECT", errorCode: "SIDE_EFFECT_UNKNOWN_EFFECT", lease: "REVOKED", blockedEvent: false },
    { name: "非白名单→BLOCKED", deleteImpl: () => ({ ok: false, error: "INTERNAL_DOMAIN_FAILURE" }), status: "BLOCKED", errorCode: "INTERNAL_DOMAIN_FAILURE", lease: "RELEASED", blockedEvent: true, knownNoEffect: false },
  ];
  for (const c of cases) {
    const sf = await createSideEffectFixture();
    try {
      const sc = await sf.setupTrash({ resourceName: "T9 " + c.name });
      const flow = await sf.trashFlow({ ref: sc.resourceRef, run: sc.run });
      const domain = sf.fx.f.resourceService;
      const realDelete = domain.delete.bind(domain);
      let domainCalls = 0;
      domain.delete = (args) => { domainCalls += 1; return c.deleteImpl(args); };
      let exec;
      try { exec = await sf.authority.executeSideEffect({ callId: flow.callId, leaseId: flow.lease.lease.leaseId, holderId: "exec_1" }); }
      finally { domain.delete = realDelete; }
      assert.equal(exec.ok, false, JSON.stringify(exec));
      assert.equal(exec.executed, true);
      assert.equal(exec.suppressed, undefined, c.name + "：正常路径绝不进入 suppressed 形状");
      assert.equal(exec.error, c.errorCode, JSON.stringify(exec));
      assert.equal(domainCalls, 1);
      const call = sf.store.callById(flow.callId);
      assert.equal(call.status, c.status);
      assert.equal(call.errorCode, c.errorCode);
      assert.deepEqual(activeLeasesOf(sf.store, flow.callId), []);
      assert.deepEqual(sf.store.leasesOfCall(flow.callId).map((l) => l.status), [c.lease]);
      const events = sf.taskStore.eventsOfTask(sc.run.taskId).map((e) => e.event_type);
      assert.equal(events.includes(LATE_SUPPRESSED), false, c.name + "：正常路径绝不落 late_result_suppressed");
      assert.equal(events.includes("tool.side_effect.execution_blocked"), c.blockedEvent, c.name + "：既有事件逐字不变");
      if (c.status === "UNKNOWN_EFFECT") {
        assert.equal(call.recoverySafe.source, "live_ambiguous");
        assert.equal(call.recoverySafe.quiesced, false);
        assert.equal(call.recoverySafe.originRuntimeInstanceId, sf.authority.instanceId);
        assert.equal(sf.taskStore.taskById(sc.run.taskId).status, "BLOCKED");
      } else if (c.status === "FAILED") {
        assert.equal(exec.knownNoEffect, true);
        assert.equal(call.completedAt != null, true);
        assert.equal(sf.taskStore.taskById(sc.run.taskId).status, "RUNNING", "known-no-effect 不 blockStep");
      } else {
        assert.equal(exec.knownNoEffect, false);
      }
      console.log("T9 " + c.name + ": " + JSON.stringify({ exec: { ok: exec.ok, error: exec.error, knownNoEffect: exec.knownNoEffect }, call: call.status, errorCode: call.errorCode, leases: sf.store.leasesOfCall(flow.callId).map((l) => l.status), lateEvent: false }));
    } finally { await sf.fx.close(); }
  }
});
