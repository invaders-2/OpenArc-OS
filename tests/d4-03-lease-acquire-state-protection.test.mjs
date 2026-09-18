/**
 * D4-03 CG-01 · acquireLease 的事务状态保护。
 *
 * 审计发现（静态）：acquireLease 在事务外读 call 判定 APPROVED/LEASED，进入事务后只重读
 * lease 与 approval，随后无条件建立 ACTIVE lease 并把 call 写成 LEASED。另一连接若已把
 * call 推进到 RUNNING / 终态，旧读不足以支撑发放租约 —— **有效 approval 不等于调用仍可执行**。
 *
 * 复用既有并发设施（不新增产品 seam，不 mock service）：
 *  1. test-only 事务边界探针（同 d4-03-deny-state-protection 的 armRaceAfterPreRead /
 *     d4-03-lease-state-integrity 的 trackTransactionBoundaries 手法）：在 authority 对 callId
 *     的资格预读（store.callById）之后、它开启第一个写入事务之前同步注入真实动作，不用 sleep 猜同步点；
 *  2. 注入动作由**另一条真实 SQLite 连接**（同一 disk DB 的第二个 IdentityStore / SideEffectStore）
 *     执行，即"另一连接已推进调用状态"的真实路径。
 *
 * 覆盖：六种不可租用状态（RUNNING / SUCCEEDED / UNKNOWN_EFFECT / FAILED / BLOCKED / CANCELLED）
 * 迟到申请必须被拒且 call / lease / 恢复证据逐字不变；拒绝申请绝不提前改写已有租约；
 * 正常申请 / 合法重复 / 不同执行器竞争 / 过期后重租的既有语义保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createSideEffectFixture, WRITE_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";
const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { SideEffectStore } = require("../electron/side-effect-store.cjs");
const { SideEffectAuthority } = require("../electron/side-effect-authority.cjs");

const LEASED = "LEASED";
const LEASE_CONFLICT = "SIDE_EFFECT_LEASE_CONFLICT";
const CALL_STATE = "SIDE_EFFECT_CALL_STATE";
const APPROVAL_EXPIRED = "SIDE_EFFECT_APPROVAL_EXPIRED";

const activeLeasesOf = (store, callId) => store.leasesOfCall(callId).filter((l) => l.status === "ACTIVE");
const callSnapshot = (store, callId) => JSON.stringify(store.callById(callId));
const leaseSnapshot = (store, leaseId) => JSON.stringify(store.leaseById(leaseId));
const auditRows = (sf, action) => sf.fx.f.identity.connection.prepare("SELECT action, decision, reason_code FROM authorization_audit WHERE action = ?").all(action);
const leaseEvents = (sf, taskId) => sf.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "tool.lease_acquired");

/**
 * 另一条连接：独立 IdentityStore 打开同一个 disk DB（真实第二个 SQLite connection），
 * 只用于在同步注入点推进 call 的 persisted status。
 */
function openSecondConnection({ dbPath, clock }) {
  const identity = new IdentityStore({ path: dbPath, clock }).open();
  const store = new SideEffectStore({ identity, clock });
  return {
    store,
    setStatus(callId, status) {
      const at = clock();
      const patch = { status };
      if (status === "RUNNING") patch.started_at = at;
      if (["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(status)) patch.completed_at = at;
      if (status === "SUCCEEDED") patch.verification_status = "PASS";
      if (status === "FAILED") patch.error_code = "SIDE_EFFECT_PRECONDITION_CHANGED";
      if (status === "BLOCKED") patch.error_code = "SIDE_EFFECT_APPROVAL_DENIED";
      // UNKNOWN_EFFECT 必须带真实恢复证据（recovery_safe），迟到申请绝不允许把它一并改写。
      if (status === "UNKNOWN_EFFECT") {
        patch.error_code = "SIDE_EFFECT_UNKNOWN_EFFECT";
        patch.recovery_safe = { source: "live_ambiguous", quiesced: false, originRuntimeInstanceId: "instA", originLeaseId: "slease_origin" };
      }
      store.transactSync(() => store.updateCall(callId, patch));
      return at;
    },
    close() { try { identity.close(); } catch { /* ignore */ } },
  };
}

/**
 * test-only 事务边界探针：authority 对 callId 的资格预读之后、第一个 transactSync 之前注入。
 * 与 d4-03-deny-state-protection 的 armRaceAfterPreRead 同一手法。
 */
function armRaceAfterPreRead(sf, callId, inject) {
  const store = sf.store;
  const originalTransact = store.transactSync;
  const originalCallById = store.callById;
  let armed = true; let preRead = false;
  store.callById = (id) => {
    const row = originalCallById.call(store, id);
    if (armed && String(id) === String(callId)) preRead = true;
    return row;
  };
  store.transactSync = function (fn) {
    if (armed && preRead) { armed = false; preRead = false; inject(); }
    return originalTransact.call(store, fn);
  };
  return {
    injected: () => !armed,
    restore() { store.callById = originalCallById; store.transactSync = originalTransact; },
  };
}

/** disk-backed fixture + 一条 APPROVED 的 call（尚未租用）。 */
async function approvedCallOnDisk(clock) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d403-cg01-"));
  const dbPath = path.join(root, "identity.db");
  const sf = await createSideEffectFixture({ dbPath, keepData: true, sideEffectClock: clock, sideEffectInstanceId: "instA" });
  const run = sf.setupRun();
  const p = await sf.plan(WRITE_TOOL, { target: "cg01-doc" }, run);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(sf.approve(p.call.callId).ok, true);
  assert.equal(sf.store.callById(p.call.callId).status, "APPROVED");
  return { root, dbPath, sf, run, callId: p.call.callId };
}

const cleanup = async (r) => {
  try { await r.sf.fx.close(); } catch { /* ignore */ }
  try { fs.rmSync(r.root, { recursive: true, force: true }); } catch { /* ignore */ }
};

/* ============================================================ T1 迟到申请 vs 已推进状态 */
const ADVANCED = ["RUNNING", "SUCCEEDED", "UNKNOWN_EFFECT", "FAILED", "BLOCKED", "CANCELLED"];
test("T1 · 另一连接已推进状态的六种 call：迟到 acquire 必须被拒，call / 恢复证据 / lease 零改写", async (t) => {
  const now = 1_700_000_000_000;
  const r = await approvedCallOnDisk(() => now);
  const second = openSecondConnection({ dbPath: r.dbPath, clock: () => now });
  try {
    for (const status of ADVANCED) {
      await t.test(status, async () => {
        const p = await r.sf.plan(WRITE_TOOL, { target: "cg01-" + status }, r.run);
        assert.equal(p.ok, true, JSON.stringify(p));
        const callId = p.call.callId;
        assert.equal(r.sf.approve(callId).ok, true);
        // 注入后由第一条连接读取权威快照：迟到 acquire 不得再改动其中任何一个字段。
        let frozen = null;
        const race = armRaceAfterPreRead(r.sf, callId, () => {
          second.setStatus(callId, status);
          frozen = callSnapshot(r.sf.store, callId);
        });
        try {
          const leasesBefore = JSON.stringify(r.sf.store.leasesOfCall(callId));
          const auditBefore = auditRows(r.sf, "side_effect.lease_acquired").length;
          const eventsBefore = leaseEvents(r.sf, r.run.taskId).length;

          const res = r.sf.authority.acquireLease({ context: r.sf.ctx(), callId, holderId: "exec_late" });
          assert.equal(race.injected(), true, "探针必须真实注入（否则本用例无区分力）");
          assert.ok(frozen && frozen.includes('"status":"' + status + '"'), "另一连接必须真实推进 persisted status：" + frozen);
          assert.equal(res.ok, false, JSON.stringify(res));
          assert.equal(res.error, CALL_STATE, JSON.stringify(res));
          assert.equal(res.duplicate, undefined, "已进入执行/终态的 call 绝不能被当作 duplicate");
          assert.equal(res.lease, undefined, "拒绝时绝不得返回租约");
          assert.equal(callSnapshot(r.sf.store, callId), frozen, "call 任何字段都不得变化（含 " + status + " 与恢复证据）");
          assert.equal(r.sf.store.callById(callId).status, status, "终态 / RUNNING 不得被重新写成 LEASED");
          assert.equal(JSON.stringify(r.sf.store.leasesOfCall(callId)), leasesBefore, "不得创建/改写任何 lease");
          assert.deepEqual(activeLeasesOf(r.sf.store, callId), []);
          assert.equal(auditRows(r.sf, "side_effect.lease_acquired").length, auditBefore, "拒绝路径绝不落 lease_acquired audit");
          assert.equal(leaseEvents(r.sf, r.run.taskId).length, eventsBefore, "拒绝路径绝不落 tool.lease_acquired 事件");
          console.log("T1 " + status + ": " + JSON.stringify({ error: res.error, callStatus: r.sf.store.callById(callId).status, leases: r.sf.store.leasesOfCall(callId).length }));
        } finally { race.restore(); }
      });
    }
  } finally {
    second.close();
    await cleanup(r);
  }
});

/* ============================================================ T2 拒绝申请绝不提前改写已有租约 */
test("T2 · 批准已过期 + 已有过期 ACTIVE lease：拒绝申请时该 lease 逐字不变（绝不提前 EXPIRED）", async () => {
  let now = 1_000_000;
  const sf = await createSideEffectFixture({ sideEffectClock: () => now, sideEffectInstanceId: "instA" });
  try {
    const run = sf.setupRun();
    const p = await sf.plan(WRITE_TOOL, { target: "cg01-t2" }, run);
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(sf.approve(p.call.callId, { ttlMs: 5_000 }).ok, true);
    const lease = sf.lease(p.call.callId, { holderId: "exec_A", ttlMs: 1_000 });
    assert.equal(lease.ok, true, JSON.stringify(lease));
    now += 10_000; // approval 与 lease 同时过期
    assert.equal(sf.store.callById(p.call.callId).status, LEASED);

    const callBefore = callSnapshot(sf.store, p.call.callId);
    const leaseBefore = leaseSnapshot(sf.store, lease.lease.leaseId);
    const rejected = sf.lease(p.call.callId, { holderId: "exec_B" });
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.error, APPROVAL_EXPIRED, JSON.stringify(rejected));
    assert.equal(leaseSnapshot(sf.store, lease.lease.leaseId), leaseBefore, "拒绝申请不得提前改写已有租约（仍为 ACTIVE，字段逐字不变）");
    assert.equal(sf.store.leaseById(lease.lease.leaseId).status, "ACTIVE");
    assert.equal(sf.store.leasesOfCall(p.call.callId).length, 1, "不得创建第二条 lease");
    assert.equal(callSnapshot(sf.store, p.call.callId), callBefore, "call 不得变化");
    console.log("T2: " + JSON.stringify({ error: rejected.error, leaseStatus: sf.store.leaseById(lease.lease.leaseId).status, leases: sf.store.leasesOfCall(p.call.callId).length }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T3 既有语义保留 */
test("T3 · 既有语义保留：正常申请 / 合法重复 / 不同执行器竞争 / 过期后重租", async () => {
  let now = 2_000_000;
  const sf = await createSideEffectFixture({ sideEffectClock: () => now, sideEffectInstanceId: "instA" });
  const sibling = new SideEffectAuthority({
    registry: sf.toolRegistry, sideEffectStore: sf.store, taskStore: sf.taskStore, toolStore: sf.toolStore,
    authService: sf.authService, adapters: sf.adapters, clock: () => now, taskService: sf.taskService, instanceId: "instB",
  });
  try {
    const run = sf.setupRun();
    const p = await sf.plan(WRITE_TOOL, { target: "cg01-t3" }, run);
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(sf.approve(p.call.callId).ok, true);

    // 正常申请
    const first = sf.lease(p.call.callId, { holderId: "exec_A" });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.duplicate, false);
    assert.equal(sf.store.callById(p.call.callId).status, LEASED);
    assert.equal(activeLeasesOf(sf.store, p.call.callId).length, 1);

    // 合法重复（同 holderId + 同 runtime instance）
    const again = sf.lease(p.call.callId, { holderId: "exec_A" });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.duplicate, true);
    assert.equal(again.lease.leaseId, first.lease.leaseId);
    assert.equal(activeLeasesOf(sf.store, p.call.callId).length, 1);

    // 不同执行器竞争（同 holderId、不同 runtime instance）→ CONFLICT，既有 lease 不被改写
    const leaseBefore = leaseSnapshot(sf.store, first.lease.leaseId);
    const other = sibling.acquireLease({ context: sf.ctx(), callId: p.call.callId, holderId: "exec_A" });
    assert.equal(other.ok, false, JSON.stringify(other));
    assert.equal(other.error, LEASE_CONFLICT);
    assert.equal(leaseSnapshot(sf.store, first.lease.leaseId), leaseBefore);
    assert.equal(activeLeasesOf(sf.store, p.call.callId).length, 1);

    // 过期后重租：旧 lease → EXPIRED，恰好 1 ACTIVE，call 仍 LEASED
    now += 70_000;
    const renewed = sf.lease(p.call.callId, { holderId: "exec_B" });
    assert.equal(renewed.ok, true, JSON.stringify(renewed));
    assert.equal(renewed.duplicate, false);
    assert.equal(sf.store.leaseById(first.lease.leaseId).status, "EXPIRED", "过期 lease 在发放新租约的同一事务内终结");
    assert.equal(activeLeasesOf(sf.store, p.call.callId).length, 1);
    assert.equal(sf.store.activeLeaseOfCall(p.call.callId).leaseId, renewed.lease.leaseId);
    assert.equal(sf.store.callById(p.call.callId).status, LEASED);
    assert.equal(sf.store.leasesOfCall(p.call.callId).length, 2);
    console.log("T3: " + JSON.stringify({ leases: sf.store.leasesOfCall(p.call.callId).map((l) => l.status), call: sf.store.callById(p.call.callId).status }));
  } finally { await sf.fx.close(); }
});
