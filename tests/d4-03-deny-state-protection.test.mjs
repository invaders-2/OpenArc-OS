/**
 * D4-03 · DENY 状态保护（Boss 裁决：已生效的执行事实不可被迟到 DENY 改写）。
 *
 * 两类被独立复核实测到的错误事实：
 *  · 迟到 DENY 覆盖权威结果：call 已 SUCCEEDED / 已由 recovery 收敛为 UNKNOWN_EFFECT 时，
 *    DENY 把它改成 BLOCKED/APPROVAL_DENIED —— 已生效的执行被改写、UNKNOWN_EFFECT 的恢复入口消失；
 *  · "已生效却记 BLOCKED"：executor 已 claim（RUNNING）后 DENY，call 记 BLOCKED 但 Domain 已生效，
 *    UI 会显示"未执行 / 被拒绝"。
 *
 * 只用既有 seam：真实 fixture 装配（store / authority / 真实 Resource Domain）、
 * authority testHooks 的同步点、受控 claim-contender 子进程（真实卡在 claim 前）。
 * 绝不用 sleep 猜同步点。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createSideEffectFixture, TRASH_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";
const require = createRequire(import.meta.url);
const { createSideEffectGateway, registerSideEffectIpc } = require("../electron/side-effect-bootstrap.cjs");
const { SIDE_EFFECT_ERROR } = require("../electron/side-effect-domain.cjs");

const CLAIM_GATE = path.join(import.meta.dirname, "fixtures", "harness-acp", "claim-contender.mjs");
/** 迟到 DENY 的显式错误码（与 electron/side-effect-authority.cjs 的返回值逐字一致）。 */
const TOO_LATE = "SIDE_EFFECT_APPROVAL_TOO_LATE";
const TOO_LATE_AUDIT = "side_effect.deny_too_late";
const TOO_LATE_EVENT = "tool.side_effect.deny_too_late";

/** 统计真实 ResourceService.delete 的 Domain invocation。 */
function countDeleteCalls(sf) {
  const real = sf.fx.f.resourceService.delete.bind(sf.fx.f.resourceService);
  const box = { calls: 0 };
  sf.fx.f.resourceService.delete = (args) => { box.calls += 1; return real(args); };
  return box;
}
const activeLeasesOf = (store, callId) => store.leasesOfCall(callId).filter((l) => l.status === "ACTIVE");
const decisionsOf = (store, callId) => store.approvalsOfCall(callId).map((a) => a.decision);
const eventsOf = (sf, taskId) => sf.taskStore.eventsOfTask(taskId);
const eventsNamed = (sf, taskId, name) => eventsOf(sf, taskId).filter((e) => e.event_type === name);
const payloadOf = (event) => (event.safe_payload ? JSON.parse(event.safe_payload) : null);
const auditRows = (sf, action) => sf.fx.f.identity.connection.prepare("SELECT action, decision, reason_code FROM authorization_audit WHERE action = ?").all(action);
const callsOfTask = (sf, taskId) => sf.store.callsOfTask(taskId).filter((c) => c.toolId === TRASH_TOOL).length;

function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("超时：" + label)), ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** 受控 executor：真实独立进程，bind lifetime 前什么都不做，收到 GO 才尝试 claim。 */
function spawnClaimGate(args) {
  const child = spawn(process.execPath, [CLAIM_GATE, JSON.stringify(args)], { stdio: ["pipe", "pipe", "pipe"] });
  const box = { child, stderr: "" };
  let buf = "";
  let readyResolve = null; let resultResolve = null;
  box.ready = new Promise((r) => { readyResolve = r; });
  box.result = new Promise((r) => { resultResolve = r; });
  child.stdout.on("data", (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg = null; try { msg = JSON.parse(line); } catch { msg = null; }
      if (!msg) continue;
      if (msg.type === "ready") readyResolve(msg);
      if (msg.type === "result") resultResolve(msg);
    }
  });
  child.stderr.on("data", (d) => { box.stderr += String(d); });
  child.stdin.on("error", () => { /* child 已退出时忽略 EPIPE */ });
  return box;
}
const killGate = (box) => { try { box.child.kill("SIGKILL"); } catch { /* ignore */ } };

/** 迟到 DENY 的通用断言：明确错误 + 状态逐字不变 + 只留 safe audit/event。 */
function assertTooLate(deny, { callSnapshot, before, callId, status, tooLateEvents }) {
  assert.equal(deny.ok, false, "迟到 DENY 必须明确失败：" + JSON.stringify(deny));
  assert.equal(deny.error, TOO_LATE);
  assert.equal(deny.callStatus, status);
  assert.equal(deny.callId, callId);
  assert.equal(deny.duplicate, undefined, "非 BLOCKED+DENIED 不得报 duplicate");
  assert.equal(callSnapshot, before, "DENY 之后 call 任何字段都不得变化");
  const audit = auditRows(tooLateEvents.sf, TOO_LATE_AUDIT);
  assert.equal(audit.length, tooLateEvents.auditCount + 1, "必须落下 safe audit：" + JSON.stringify(audit));
  assert.equal(audit[audit.length - 1].reason_code, TOO_LATE);
  const events = eventsNamed(tooLateEvents.sf, tooLateEvents.taskId, TOO_LATE_EVENT);
  assert.equal(events.length, tooLateEvents.eventCount + 1, "必须落下 safe TaskEvent（审计用）");
  assert.deepEqual(Object.keys(payloadOf(events[events.length - 1])).sort(), ["callId", "observedStatus", "toolId"]);
  assert.equal(payloadOf(events[events.length - 1]).observedStatus, status);
  assert.equal(JSON.stringify(payloadOf(events[events.length - 1])).includes("/"), false, "payload 不得含路径");
  assert.equal(eventsNamed(tooLateEvents.sf, tooLateEvents.taskId, "tool.denied").length, 0, "绝不伪装成已阻止执行");
}

/** 迟到 DENY 的观察快照（audit/event 均为"追加"语义，不能只看有无）。 */
function tooLateTracker(sf, taskId) {
  return { sf, taskId, auditCount: auditRows(sf, TOO_LATE_AUDIT).length, eventCount: eventsNamed(sf, taskId, TOO_LATE_EVENT).length };
}

/* ============================================================ T1 AWAITING_APPROVAL */
test("T1 · AWAITING_APPROVAL：DENY → BLOCKED、0 lease、0 mutation；重复 DENY 幂等成功", async () => {
  const sf = await createSideEffectFixture();
  try {
    const sc = await sf.setupTrash({ resourceName: "T1 Deny Target" });
    const counter = countDeleteCalls(sf);
    const p = await sf.plan(TRASH_TOOL, { resourceRef: sc.resourceRef }, sc.run);
    assert.equal(p.ok, true, JSON.stringify(p));
    const callId = p.call.callId;
    assert.equal(sf.store.callById(callId).status, "AWAITING_APPROVAL");

    const deny = sf.deny(callId);
    assert.equal(deny.ok, true, JSON.stringify(deny));
    assert.equal(deny.call.status, "BLOCKED");
    assert.equal(deny.call.errorCode, SIDE_EFFECT_ERROR.APPROVAL_DENIED);
    assert.equal(deny.approval.decision, "DENIED");
    assert.deepEqual(activeLeasesOf(sf.store, callId), []);
    assert.deepEqual(sf.store.leasesOfCall(callId), [], "AWAITING_APPROVAL 上没有任何 lease");
    assert.equal(counter.calls, 0, "0 Domain mutation");
    assert.equal(sf.precondition(sc.resourceRef).trashed, false);
    assert.equal(callsOfTask(sf, sc.run.taskId), 1, "无第二套 call");

    // 双击 / 重放：同一 DENY 已生效 → 幂等成功，绝不报错、绝不再写 approval 行。
    const before = JSON.stringify(sf.store.callById(callId));
    const again = sf.deny(callId);
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.duplicate, true);
    assert.equal(again.callStatus, "BLOCKED");
    assert.equal(JSON.stringify(sf.store.callById(callId)), before);
    assert.deepEqual(decisionsOf(sf.store, callId), ["DENIED"], "重复 DENY 不得插入第二行 approval");
    assert.equal(eventsNamed(sf, sc.run.taskId, "tool.denied").length, 1);
    console.log("T1 after deny: " + JSON.stringify({ call: deny.call.status, errorCode: deny.call.errorCode, leases: sf.store.leasesOfCall(callId).length, mutation: counter.calls, repeat: { ok: again.ok, duplicate: again.duplicate, callStatus: again.callStatus }, approvals: decisionsOf(sf.store, callId) }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T2 APPROVED（未租用） */
test("T2 · APPROVED：DENY → BLOCKED、0 mutation、0 ACTIVE lease", async () => {
  const sf = await createSideEffectFixture();
  try {
    const sc = await sf.setupTrash({ resourceName: "T2 Deny Target" });
    const counter = countDeleteCalls(sf);
    const p = await sf.plan(TRASH_TOOL, { resourceRef: sc.resourceRef }, sc.run);
    const callId = p.call.callId;
    assert.equal(sf.approve(callId).ok, true);
    assert.equal(sf.store.callById(callId).status, "APPROVED");
    assert.deepEqual(sf.store.leasesOfCall(callId), [], "尚未租用");

    const deny = sf.deny(callId);
    assert.equal(deny.ok, true, JSON.stringify(deny));
    assert.equal(deny.call.status, "BLOCKED");
    assert.equal(deny.call.errorCode, SIDE_EFFECT_ERROR.APPROVAL_DENIED);
    assert.deepEqual(decisionsOf(sf.store, callId), ["APPROVED", "DENIED"]);
    assert.deepEqual(activeLeasesOf(sf.store, callId), []);
    assert.equal(counter.calls, 0);
    assert.equal(sf.precondition(sc.resourceRef).trashed, false);
    console.log("T2 after deny: " + JSON.stringify({ call: deny.call.status, approvals: decisionsOf(sf.store, callId), leases: sf.store.leasesOfCall(callId).length, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T3 LEASED（executor 已 spawn、尚未 claim） */
test("T3 · LEASED：DENY → BLOCKED + 0 ACTIVE lease；释放 executor → claim 失败、0 mutation、无第二套 call", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d403-deny-t3-"));
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const EXECUTOR_INSTANCE = "exe_t3_deny";
  let sf = null; let gate = null;
  try {
    sf = await createSideEffectFixture({ dbPath, storeRoot, keepData: true });
    const sc = await sf.setupTrash({ resourceName: "T3 Deny Target" });
    const counter = countDeleteCalls(sf);
    // lease 属于受控 executor 的 runtime instance（production executor = 自己的 instanceId）。
    const flow = await sf.trashFlow({ ref: sc.resourceRef, run: sc.run, holderId: "exec_1", instanceId: EXECUTOR_INSTANCE });
    const callId = flow.callId;
    assert.equal(sf.store.callById(callId).status, "LEASED");
    assert.equal(activeLeasesOf(sf.store, callId).length, 1);
    // 受控 executor 已 spawn 并卡在 claim 前（stdin gate），此刻尚未进入 claim 事务。
    gate = spawnClaimGate({ dbPath, storeRoot, callId, leaseId: flow.lease.lease.leaseId, holderId: "exec_1", instanceId: EXECUTOR_INSTANCE, domainDelayMs: 0 });
    await withTimeout(gate.ready, 30000, "executor 未就绪: " + gate.stderr);
    assert.equal(sf.store.callById(callId).status, "LEASED", "释放前必须仍停留在 claim 之前");

    const deny = sf.deny(callId);
    assert.equal(deny.ok, true, JSON.stringify(deny));
    assert.equal(deny.call.status, "BLOCKED");
    assert.deepEqual(activeLeasesOf(sf.store, callId), []);
    assert.deepEqual(sf.store.leasesOfCall(callId).map((l) => l.status), ["REVOKED"]);
    assert.equal(counter.calls, 0, "DENY 本身 0 Domain mutation");

    // 释放 executor：它必须无法 claim（call 已不可撤回地离开 LEASED）。
    gate.child.stdin.write("GO\n");
    const msg = await withTimeout(gate.result, 30000, "executor 未返回结果: " + gate.stderr);
    assert.equal(msg.result.ok, false, JSON.stringify(msg.result));
    assert.equal(msg.result.executed, false);
    assert.equal(msg.result.mutationCount, 0);
    assert.equal(msg.deleteCalls, 0, "claim 失败 → 0 Domain mutation");
    assert.equal(sf.store.callById(callId).status, "BLOCKED");
    assert.equal(sf.precondition(sc.resourceRef).trashed, false);
    assert.equal(callsOfTask(sf, sc.run.taskId), 1, "无第二套 call");
    console.log("T3 after deny: " + JSON.stringify({ call: deny.call.status, leases: sf.store.leasesOfCall(callId).map((l) => l.status), executor: { ok: msg.result.ok, error: msg.result.error, mutationCount: msg.result.mutationCount }, mutation: counter.calls }));
  } finally {
    if (gate) killGate(gate);
    try { if (sf) await sf.fx.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/* ============================================================ T4 RUNNING（已 claim） */
/** 在 RUNNING 的真实同步点发 DENY：hook 决定 DENY 落点（claim 后 / mutation 后）。 */
async function runningDenyScenario(hookName) {
  const hold = { sf: null, deny: null, atDeny: null };
  const sf = await createSideEffectFixture({
    sideEffectTestHooks: {
      [hookName]: ({ callId }) => {
        hold.atDeny = JSON.stringify(hold.sf.store.callById(callId));
        // audit / event 都是追加语义：基线必须在 DENY 之前取，否则无法区分"新增"与"既有"。
        hold.tracker = tooLateTracker(hold.sf, hold.sf.store.callById(callId).taskId);
        hold.deny = hold.sf.deny(callId);
        hold.afterDeny = JSON.stringify(hold.sf.store.callById(callId));
      },
    },
  });
  hold.sf = sf;
  const sc = await sf.setupTrash({ resourceName: "T4 Deny Target " + hookName });
  const counter = countDeleteCalls(sf);
  const flow = await sf.trashFlow({ ref: sc.resourceRef, run: sc.run });
  const callId = flow.callId;
  const exec = await sf.authority.executeSideEffect({ callId, leaseId: flow.lease.lease.leaseId, holderId: "exec_1" });
  return { sf, sc, counter, flow, callId, exec, hold };
}

for (const hookName of ["afterClaimBeforeDispatch", "afterDomainResultBeforeVerification"]) {
  test("T4 · RUNNING（" + hookName + "）：DENY → TOO_LATE + 状态不变；执行仍收敛 SUCCEEDED，恰好 1 次 mutation", async () => {
    const r = await runningDenyScenario(hookName);
    const { sf, sc, counter, callId, exec, hold } = r;
    try {
      assert.ok(hold.deny, "hook 必须在 RUNNING 同步点真实触发");
      assert.equal(JSON.parse(hold.atDeny).status, "RUNNING", "DENY 落点必须是已 claim 的 RUNNING");
      // 同一同步点内逐字比对：DENY 那一刻 0 状态变化（随后执行继续收敛是既有生命周期）。
      assert.equal(hold.afterDeny, hold.atDeny, "DENY 不得改动 RUNNING call 的任何字段");
      // 迟到 DENY：明确结果、0 状态变化。
      assertTooLate(hold.deny, { callSnapshot: hold.afterDeny, before: hold.atDeny, callId, status: "RUNNING", tooLateEvents: hold.tracker });
      // 运行中的执行继续按既有生命周期收敛，绝不因 DENY 中止/改写。
      assert.equal(exec.ok, true, JSON.stringify(exec));
      assert.equal(exec.mutationCount, 1);
      assert.equal(exec.verificationStatus, "PASS");
      const call = sf.store.callById(callId);
      assert.equal(call.status, "SUCCEEDED");
      assert.equal(call.verificationStatus, "PASS");
      assert.equal(call.errorCode, null);
      assert.equal(counter.calls, 1, "Domain mutation 恰好 1 次");
      assert.equal(sf.precondition(sc.resourceRef).trashed, true);
      assert.deepEqual(sf.store.leasesOfCall(callId).map((l) => l.status), ["RELEASED"]);
      assert.deepEqual(activeLeasesOf(sf.store, callId), []);
      // 无"被拒绝 / 未执行"假象：没有 DENIED approval 行，也没有 tool.denied 事件。
      assert.deepEqual(decisionsOf(sf.store, callId), ["APPROVED"]);
      assert.equal(eventsNamed(sf, sc.run.taskId, "tool.denied").length, 0);
      assert.equal(sf.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: callId }), null, "终态绝不回到待决");
      assert.equal(callsOfTask(sf, sc.run.taskId), 1);
      console.log("T4[" + hookName + "] after deny: " + JSON.stringify({ deny: { ok: hold.deny.ok, error: hold.deny.error, callStatus: hold.deny.callStatus }, exec: { ok: exec.ok, verificationStatus: exec.verificationStatus }, call: call.status, leases: sf.store.leasesOfCall(callId).map((l) => l.status), mutation: counter.calls, approvals: decisionsOf(sf.store, callId) }));
    } finally { await sf.fx.close(); }
  });
}

/* ============================================================ T5 UNKNOWN_EFFECT（另一 runtime / 超时收敛） */
test("T5 · UNKNOWN_EFFECT：DENY → TOO_LATE、call 与恢复证据逐字段不变、恢复入口仍可用", async () => {
  const hold = { sf: null, deny: null, recovery: null, recoverySafeAtDeny: null, callAtDeny: null };
  const sf = await createSideEffectFixture({
    sideEffectTestHooks: {
      afterClaimBeforeDispatch: ({ callId }) => {
        // 真实收敛：已 claim 的 RUNNING call 由 recovery 权威改成 UNKNOWN_EFFECT（超时 / 另一 runtime）。
        hold.recovery = hold.sf.fx.sideEffectRuntime.recoverOnStartup();
        hold.recoverySafeAtDeny = JSON.stringify(hold.sf.store.callById(callId).recoverySafe);
        hold.beforeDeny = JSON.stringify(hold.sf.store.callById(callId));
        hold.tracker = tooLateTracker(hold.sf, hold.sf.store.callById(callId).taskId);
        hold.deny = hold.sf.deny(callId);
        hold.callAtDeny = JSON.stringify(hold.sf.store.callById(callId));
      },
    },
  });
  hold.sf = sf;
  try {
    const sc = await sf.setupTrash({ resourceName: "T5 Deny Target" });
    const counter = countDeleteCalls(sf);
    const flow = await sf.trashFlow({ ref: sc.resourceRef, run: sc.run });
    const callId = flow.callId;
    const exec = await sf.authority.executeSideEffect({ callId, leaseId: flow.lease.lease.leaseId, holderId: "exec_1" });
    assert.ok(hold.deny, "hook 必须真实触发");
    assert.equal(hold.recovery.unknownEffectCalls.length, 1, JSON.stringify(hold.recovery));
    assert.equal(hold.callAtDeny, hold.beforeDeny, "DENY 不得改动 UNKNOWN_EFFECT call 的任何字段");
    assertTooLate(hold.deny, { callSnapshot: hold.callAtDeny, before: hold.beforeDeny, callId, status: "UNKNOWN_EFFECT", tooLateEvents: hold.tracker });

    const call = sf.store.callById(callId);
    assert.equal(call.status, "UNKNOWN_EFFECT", "recovery 权威绝不被 DENY 覆盖");
    assert.equal(call.verificationStatus, null);
    assert.equal(exec.suppressed, true, "迟到结果不得覆盖 recovery 权威：" + JSON.stringify(exec));
    assert.equal(exec.mutationCount, 1);
    assert.equal(counter.calls, 1, "Domain mutation 恰好 1 次，DENY 不产生第二次");
    assert.equal(sf.precondition(sc.resourceRef).trashed, true);
    // 恢复证据逐字段不变（quiesced / origin runtime / origin lease / reason / recordedAt）。
    assert.equal(JSON.stringify(call.recoverySafe), hold.recoverySafeAtDeny);
    assert.equal(call.recoverySafe.quiesced, false);
    assert.equal(call.recoverySafe.source, "unproven");
    assert.equal(call.recoverySafe.originRuntimeInstanceId, sf.authority.instanceId);
    assert.equal(call.recoverySafe.originLeaseId, flow.lease.lease.leaseId);
    assert.equal(call.recoverySafe.reason, "SELF_RUNTIME_ACTIVE");
    // 恢复入口（VERIFY → APPLIED → SUCCEEDED）必须保留。
    const rec = sf.taskService.getRecoveryState({ context: sf.ctx(), taskId: sc.run.taskId });
    assert.equal(rec.applicable, true, "UNKNOWN_EFFECT 恢复入口必须保留");
    assert.equal(rec.taskStatus, "BLOCKED");
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].callId, callId);
    // 幂等：重复 DENY 仍 TOO_LATE，0 状态变化。
    const again = sf.deny(callId);
    assert.equal(again.ok, false);
    assert.equal(again.error, TOO_LATE);
    assert.equal(JSON.stringify(sf.store.callById(callId)), hold.callAtDeny);
    // 恢复仍是唯一收敛出口，且 0 二次执行。
    const v = await sf.authority.verifyUnknownEffect({ callId });
    assert.equal(v.outcome, "APPLIED", JSON.stringify(v));
    assert.equal(v.resolved, true);
    assert.equal(sf.store.callById(callId).status, "SUCCEEDED");
    assert.equal(sf.store.callById(callId).verificationStatus, "PASS");
    assert.equal(counter.calls, 1);
    assert.equal(sf.precondition(sc.resourceRef).trashed, true);
    console.log("T5 after deny: " + JSON.stringify({ deny: { ok: hold.deny.ok, error: hold.deny.error, callStatus: hold.deny.callStatus }, callAtDeny: JSON.parse(hold.callAtDeny).status, recoverySafe: JSON.parse(hold.recoverySafeAtDeny), recoveryApplicable: rec.applicable, verified: { outcome: v.outcome, status: sf.store.callById(callId).status }, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T6 SUCCEEDED */
test("T6 · SUCCEEDED：DENY → TOO_LATE、call 仍 SUCCEEDED/PASS、无 BLOCKED 覆盖、无 DENIED approval 行", async () => {
  const sf = await createSideEffectFixture();
  try {
    const sc = await sf.setupTrash({ resourceName: "T6 Deny Target" });
    const counter = countDeleteCalls(sf);
    const flow = await sf.trashFlow({ ref: sc.resourceRef, run: sc.run });
    const callId = flow.callId;
    const exec = await sf.authority.executeSideEffect({ callId, leaseId: flow.lease.lease.leaseId, holderId: "exec_1" });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    const tracker = tooLateTracker(sf, sc.run.taskId);
    const terminal = JSON.stringify(sf.store.callById(callId));
    const deny = sf.deny(callId);
    assertTooLate(deny, { callSnapshot: JSON.stringify(sf.store.callById(callId)), before: terminal, callId, status: "SUCCEEDED", tooLateEvents: tracker });
    const call = sf.store.callById(callId);
    assert.equal(call.status, "SUCCEEDED");
    assert.equal(call.verificationStatus, "PASS");
    assert.equal(call.errorCode, null);
    assert.deepEqual(decisionsOf(sf.store, callId), ["APPROVED"], "绝不写 DENIED approval 行");
    assert.deepEqual(sf.store.leasesOfCall(callId).map((l) => l.status), ["RELEASED"], "DENY 不动 lease");
    assert.equal(counter.calls, 1);
    assert.equal(sf.precondition(sc.resourceRef).trashed, true);
    assert.equal(sf.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: callId }), null);
    console.log("T6 after deny: " + JSON.stringify({ deny: { ok: deny.ok, error: deny.error, callStatus: deny.callStatus }, call: call.status, verificationStatus: call.verificationStatus, approvals: decisionsOf(sf.store, callId), leases: sf.store.leasesOfCall(callId).map((l) => l.status), mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T7 门面 / UI 一致性（产品桥） */
function fakeIpc() {
  const handlers = new Map();
  return {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    invoke: (channel, event, payload) => handlers.get(channel)(event, payload),
  };
}

test("T7 · 产品桥 sideEffect/decideApproval：迟到 DENY 显式报错；listPending / getApprovalRequest 不再待决", async () => {
  const sf = await createSideEffectFixture();
  try {
    const gateway = createSideEffectGateway({ sideEffectRuntime: sf.fx.sideEffectRuntime });
    const ipc = fakeIpc();
    registerSideEffectIpc({ ipcMain: ipc.ipcMain, service: gateway, identity: { current: sf.fx.f.sessions.admin }, isTrusted: () => true });
    const invoke = (payload) => ipc.invoke("sideeffect:command", {}, payload);

    // 正对照：仍可决定的 call 经产品桥 DENY → BLOCKED（既有语义逐字不变）。
    const sc1 = await sf.setupTrash({ resourceName: "T7 Bridge Deny Target" });
    const p1 = await sf.plan(TRASH_TOOL, { resourceRef: sc1.resourceRef }, sc1.run);
    const pending1 = await invoke({ type: "sideEffect/listPending" });
    assert.equal(pending1.items.some((i) => i.approvalRequestId === p1.call.callId), true, "待决 call 必须出现在 listPending");
    const denied = await invoke({ type: "sideEffect/decideApproval", approvalRequestId: p1.call.callId, decision: "DENY" });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    assert.equal(denied.status, "BLOCKED");
    const deniedAgain = await invoke({ type: "sideEffect/decideApproval", approvalRequestId: p1.call.callId, decision: "DENY" });
    assert.equal(deniedAgain.ok, true, JSON.stringify(deniedAgain));
    assert.equal(deniedAgain.status, "BLOCKED");

    // 迟到 DENY：已 SUCCEEDED 的 call 经同一产品桥 → 显式错误，且不再是待决。
    const sc2 = await sf.setupTrash({ resourceName: "T7 Bridge Late Target" });
    const counter = countDeleteCalls(sf);
    const flow2 = await sf.trashFlow({ ref: sc2.resourceRef, run: sc2.run });
    const exec2 = await sf.authority.executeSideEffect({ callId: flow2.callId, leaseId: flow2.lease.lease.leaseId, holderId: "exec_1" });
    assert.equal(exec2.ok, true, JSON.stringify(exec2));
    const before = JSON.stringify(sf.store.callById(flow2.callId));
    const late = await invoke({ type: "sideEffect/decideApproval", approvalRequestId: flow2.callId, decision: "DENY" });
    assert.equal(late.ok, false, JSON.stringify(late));
    assert.equal(late.error, TOO_LATE, "门面必须透传显式稳定错误码");
    assert.equal(JSON.stringify(sf.store.callById(flow2.callId)), before, "迟到 DENY 绝不改状态");
    assert.equal(sf.store.callById(flow2.callId).status, "SUCCEEDED");
    assert.equal(counter.calls, 1);
    assert.deepEqual(decisionsOf(sf.store, flow2.callId), ["APPROVED"]);
    const pending2 = await invoke({ type: "sideEffect/listPending" });
    assert.equal(pending2.items.some((i) => i.approvalRequestId === flow2.callId), false, "终态绝不回到待决列表");
    const req2 = await invoke({ type: "sideEffect/getApprovalRequest", approvalRequestId: flow2.callId });
    assert.equal(req2.ok, false);
    assert.equal(req2.error, "SIDE_EFFECT_CALL_NOT_FOUND", "终态不可 revive：" + JSON.stringify(req2));
    console.log("T7 bridge: " + JSON.stringify({ pendingBefore: pending1.items.length, deny: { ok: denied.ok, status: denied.status }, denyAgain: { ok: deniedAgain.ok, status: deniedAgain.status }, late: { ok: late.ok, error: late.error }, call: sf.store.callById(flow2.callId).status, pendingAfter: pending2.items.length, request: { ok: req2.ok, error: req2.error } }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T8 effectiveApproval 有效期判据 */
test("T8 · effectiveApproval：TTL 过期 → EXPIRED（行不变）；未过期 / 已撤销 / 已拒绝对照不变；执行侧判定逐字不变", async () => {
  let now = 1_000_000;
  const sf = await createSideEffectFixture({ sideEffectClock: () => now });
  try {
    const counter = countDeleteCalls(sf);

    // A：过期 → effectiveDecision=EXPIRED，且只读投影绝不修改 approval 行。
    const scA = await sf.setupTrash({ resourceName: "T8 Expiry Target" });
    const pA = await sf.plan(TRASH_TOOL, { resourceRef: scA.resourceRef }, scA.run);
    assert.equal(sf.approve(pA.call.callId, { ttlMs: 1000 }).ok, true);
    assert.equal(sf.authority.effectiveApproval(pA.call.callId).effectiveDecision, "APPROVED", "未过期对照");
    const rowBefore = JSON.stringify(sf.store.latestApprovalOfCall(pA.call.callId));
    now += 2000;
    assert.equal(sf.authority.effectiveApproval(pA.call.callId).effectiveDecision, "EXPIRED", "过期必须收敛为 EXPIRED");
    assert.equal(JSON.stringify(sf.store.latestApprovalOfCall(pA.call.callId)), rowBefore, "effectiveApproval 不修改行");
    // 执行侧既有时效判定逐字不变：过期仍被 acquire / eligibility 拒绝，且 0 mutation。
    const leaseA = sf.lease(pA.call.callId);
    assert.equal(leaseA.ok, false, JSON.stringify(leaseA));
    assert.equal(leaseA.error, "SIDE_EFFECT_APPROVAL_EXPIRED");
    const eligA = sf.elig(pA.call.callId, { holderId: null });
    assert.equal(eligA.status, "DENIED");
    assert.equal(eligA.reasonCode, "SIDE_EFFECT_APPROVAL_EXPIRED", "过期必须仍是 APPROVAL_EXPIRED，不得退化为 APPROVAL_DENIED");

    // B：已租用后过期 → claim 侧（eligibility）仍拒绝，0 mutation、call 与 lease 不变。
    const scB = await sf.setupTrash({ resourceName: "T8 Claim Expiry Target" });
    const pB = await sf.plan(TRASH_TOOL, { resourceRef: scB.resourceRef }, scB.run);
    assert.equal(sf.approve(pB.call.callId, { ttlMs: 1000 }).ok, true);
    const leaseB = sf.lease(pB.call.callId);
    assert.equal(leaseB.ok, true, JSON.stringify(leaseB));
    now += 2000;
    const execB = await sf.authority.executeSideEffect({ callId: pB.call.callId, leaseId: leaseB.lease.leaseId, holderId: "exec_1" });
    assert.equal(execB.ok, false, JSON.stringify(execB));
    assert.equal(execB.error, "SIDE_EFFECT_APPROVAL_EXPIRED");
    assert.equal(execB.mutationCount, 0);
    assert.equal(sf.store.callById(pB.call.callId).status, "LEASED", "过期 claim 必须被拒且不改状态");
    assert.equal(sf.store.activeLeaseOfCall(pB.call.callId).leaseId, leaseB.lease.leaseId);

    // C：已撤销对照 REVOKED；D：已拒绝对照 DENIED（幂等判据依赖它，过期判据不得改写）。
    const scC = await sf.setupTrash({ resourceName: "T8 Revoke Target" });
    const pC = await sf.plan(TRASH_TOOL, { resourceRef: scC.resourceRef }, scC.run);
    assert.equal(sf.approve(pC.call.callId, { ttlMs: 600000 }).ok, true);
    assert.equal(sf.revokeApproval(pC.call.callId).ok, true);
    assert.equal(sf.authority.effectiveApproval(pC.call.callId).effectiveDecision, "REVOKED");
    const scD = await sf.setupTrash({ resourceName: "T8 Deny Target" });
    const pD = await sf.plan(TRASH_TOOL, { resourceRef: scD.resourceRef }, scD.run);
    assert.equal(sf.deny(pD.call.callId).ok, true);
    now += 600000;
    assert.equal(sf.authority.effectiveApproval(pD.call.callId).effectiveDecision, "DENIED");
    const againD = sf.deny(pD.call.callId);
    assert.equal(againD.ok, true, JSON.stringify(againD));
    assert.equal(againD.duplicate, true, "过期判据不得破坏重复 DENY 的幂等语义");
    assert.equal(counter.calls, 0, "全程 0 Domain mutation");
    console.log("T8 effectiveApproval: " + JSON.stringify({ expired: sf.authority.effectiveApproval(pA.call.callId).effectiveDecision, rowDecision: sf.store.latestApprovalOfCall(pA.call.callId).decision, acquire: leaseA.error, eligibility: eligA.reasonCode, claimSide: { ok: execB.ok, error: execB.error, mutationCount: execB.mutationCount, call: sf.store.callById(pB.call.callId).status }, revoked: sf.authority.effectiveApproval(pC.call.callId).effectiveDecision, denied: sf.authority.effectiveApproval(pD.call.callId).effectiveDecision, duplicate: againD.duplicate, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});
