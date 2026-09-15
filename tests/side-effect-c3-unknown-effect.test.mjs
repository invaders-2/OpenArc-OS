/**
 * D4-03C3 · Ambiguous Result / UNKNOWN_EFFECT verification（in-process, live runtime）。
 *
 * 覆盖：late applied result、early NOT_APPLIED + quiescence gate、APPLIED/NOT_APPLIED/INDETERMINATE、
 * repeated verification、concurrent verification、historical contract、tool/session 变化后仍可 verification、
 * UNKNOWN_EFFECT 不能 reacquire/execute、Harness spoof、secret scan。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSideEffectFixture, TRASH_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";
import { PROVIDER_SECRET } from "./fixtures/harness-acp/task-harness-fixture.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TABLES = ["side_effect_calls", "tool_approvals", "side_effect_leases", "task_tool_proposals", "tool_decisions", "tool_executions", "task_events", "authorization_audit", "resource_registry", "library_resources"];

function patchDelete(fx, impl) {
  const box = { calls: 0 };
  const real = fx.fx.f.resourceService.delete.bind(fx.fx.f.resourceService);
  fx.fx.f.resourceService.delete = (...args) => { box.calls += 1; return impl(real, ...args); };
  return box;
}

/** 冷启动 UNKNOWN_EFFECT：lease 属于 instA，当前 runtime(inst_test) 恢复 → quiesced=true。 */
async function coldUnknown() {
  const fx = await createSideEffectFixture();
  const sc = await fx.setupTrash();
  const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run, instanceId: "instA" });
  const l = flow.lease.lease;
  fx.store.transactSync(() => fx.store.updateCall(flow.callId, { status: "RUNNING", started_at: fx.fx.f.clock() }));
  const rec = fx.authority.recoverOnStartup();
  assert.equal(rec.unknownEffectCalls.length, 1, JSON.stringify(rec));
  const call = fx.store.callById(flow.callId);
  assert.equal(call.status, "UNKNOWN_EFFECT");
  assert.equal(call.recoverySafe.quiesced, true);
  return { fx, sc, flow, l, callId: flow.callId, execId: { callId: flow.callId, leaseId: l.leaseId, holderId: l.holderId } };
}

test("Late applied result：timeout → UNKNOWN_EFFECT(quiesced=false) → mutation 晚到 → verify APPLIED → SUCCEEDED，0 retry", async () => {
  const fx = await createSideEffectFixture();
  try {
    const sc = await fx.setupTrash();
    let release = null;
    let markStarted = null;
    const started = new Promise((r) => { markStarted = r; });
    const box = patchDelete(fx, async (real, a) => { markStarted(); await new Promise((r) => { release = r; }); return real(a); });
    const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run });
    const l = flow.lease.lease;
    const execP = fx.authority.executeSideEffect({ callId: flow.callId, leaseId: l.leaseId, holderId: l.holderId, timeoutMs: 100 });
    await started;
    const exec = await execP;
    assert.equal(exec.error, "SIDE_EFFECT_UNKNOWN_EFFECT", JSON.stringify(exec));
    const call = fx.store.callById(flow.callId);
    assert.equal(call.status, "UNKNOWN_EFFECT");
    assert.equal(call.recoverySafe.quiesced, false, "live timeout 不得声称 quiesced");
    assert.equal(fx.taskStore.taskById(sc.run.taskId).status, "BLOCKED");
    assert.equal(fx.taskStore.stepById(sc.run.stepId).status, "BLOCKED");
    assert.equal(box.calls, 1);

    // 同 runtime 早期 verify：resource 仍 active 但 operation 可能仍未到达 → 不收敛。
    const early = await fx.authority.verifyUnknownEffect({ callId: flow.callId });
    assert.equal(early.outcome, "NOT_APPLIED");
    assert.equal(early.resolved, false, "未 quiesced 不得 FAILED");
    assert.equal(fx.store.callById(flow.callId).status, "UNKNOWN_EFFECT");

    // 晚到的 mutation 真正发生。
    release();
    await sleep(60);
    assert.equal(fx.precondition(sc.resourceRef).trashed, true, "late mutation 已到达");
    const v = await fx.authority.verifyUnknownEffect({ callId: flow.callId });
    assert.equal(v.outcome, "APPLIED", JSON.stringify(v));
    assert.equal(v.resolved, true);
    assert.equal(fx.store.callById(flow.callId).status, "SUCCEEDED");
    assert.equal(fx.store.callById(flow.callId).verificationStatus, "PASS");
    assert.equal(box.calls, 1, "0 retry / 0 second Domain execution");
    assert.equal(fx.taskStore.taskById(sc.run.taskId).status, "BLOCKED", "恢复后 Task 保持 BLOCKED");
    assert.equal(fx.taskStore.stepById(sc.run.stepId).status, "BLOCKED");
  } finally { await fx.fx.close(); }
});

test("NOT_APPLIED + quiesced（cold restart）→ FAILED；Task/Step 保持 BLOCKED", async () => {
  const r = await coldUnknown();
  try {
    const v = await r.fx.authority.verifyUnknownEffect({ callId: r.callId });
    assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
    assert.equal(v.quiesced, true);
    assert.equal(v.resolved, true);
    assert.equal(r.fx.store.callById(r.callId).status, "FAILED");
    assert.equal(r.fx.store.callById(r.callId).verificationStatus, "FAIL");
    assert.equal(r.fx.taskStore.taskById(r.sc.run.taskId).status, "BLOCKED");
    assert.equal(r.fx.taskStore.stepById(r.sc.run.stepId).status, "BLOCKED");
    assert.equal(r.fx.toolStore.executionsOfTask(r.sc.run.taskId).length, 0);
  } finally { await r.fx.fx.close(); }
});

test("APPLIED（cold restart，mutation 已提交）→ SUCCEEDED，0 replay / 0 retry", async () => {
  const fx = await createSideEffectFixture();
  try {
    const sc = await fx.setupTrash();
    const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run, instanceId: "instA" });
    const l = flow.lease.lease;
    // mutation 在崩溃前已提交。
    const del = await fx.fx.f.resourceService.delete({ context: fx.fx.f.adminCtx(), resourceRef: sc.resourceRef, expectedVersion: 1 });
    assert.equal(del.ok, true, JSON.stringify(del));
    assert.equal(fx.precondition(sc.resourceRef).trashed, true);
    fx.store.transactSync(() => fx.store.updateCall(flow.callId, { status: "RUNNING", started_at: fx.fx.f.clock() }));
    fx.authority.recoverOnStartup();
    const v = await fx.authority.verifyUnknownEffect({ callId: flow.callId });
    assert.equal(v.outcome, "APPLIED", JSON.stringify(v));
    assert.equal(fx.store.callById(flow.callId).status, "SUCCEEDED");
    assert.equal(fx.store.callById(flow.callId).verificationStatus, "PASS");
    assert.equal(fx.toolStore.executionsOfTask(sc.run.taskId).length, 0);
    assert.equal(fx.store.callsOfTask(sc.run.taskId).filter((c) => c.toolId === TRASH_TOOL).length, 1);
  } finally { await fx.fx.close(); }
});

test("INDETERMINATE：并发 Domain 改动 → 保持 UNKNOWN_EFFECT", async () => {
  const r = await coldUnknown();
  try {
    const bumped = await r.fx.fx.f.resourceService.replaceText({ context: r.fx.fx.f.adminCtx(), resourceRef: r.sc.resourceRef, text: "concurrent change", expectedVersion: 1 });
    assert.equal(bumped.ok, true, JSON.stringify(bumped));
    const v = await r.fx.authority.verifyUnknownEffect({ callId: r.callId });
    assert.equal(v.outcome, "INDETERMINATE", JSON.stringify(v));
    assert.equal(v.resolved, false);
    assert.equal(r.fx.store.callById(r.callId).status, "UNKNOWN_EFFECT");
    assert.equal(r.fx.store.callById(r.callId).verificationStatus, null);
    assert.equal(r.fx.taskStore.taskById(r.sc.run.taskId).status, "BLOCKED");
  } finally { await r.fx.fx.close(); }
});

test("Repeated verification idempotency：INDETERMINATE 可重复 read-only；terminal 后 duplicate", async () => {
  const r = await coldUnknown();
  try {
    const first = await r.fx.authority.verifyUnknownEffect({ callId: r.callId });
    assert.equal(first.outcome, "NOT_APPLIED");
    assert.equal(r.fx.store.callById(r.callId).status, "FAILED");
    const again = await r.fx.authority.verifyUnknownEffect({ callId: r.callId });
    assert.equal(again.duplicate, true);
    assert.equal(again.resolved, true);
    assert.equal(r.fx.store.callById(r.callId).status, "FAILED", "terminal 不被第二次 verify 改写");
    assert.equal(r.fx.toolStore.executionsOfTask(r.sc.run.taskId).length, 0, "0 mutation");
  } finally { await r.fx.fx.close(); }
});

test("Concurrent verification：两个 read-only verifier → 单一 authoritative terminal transition", async () => {
  const r = await coldUnknown();
  try {
    const [a, b] = await Promise.all([
      r.fx.authority.verifyUnknownEffect({ callId: r.callId }),
      r.fx.authority.verifyUnknownEffect({ callId: r.callId }),
    ]);
    const resolvedCount = [a, b].filter((x) => x.resolved === true && x.duplicate !== true).length;
    assert.equal(resolvedCount, 1, JSON.stringify([a, b]));
    assert.equal(r.fx.store.callById(r.callId).status, "FAILED");
    const events = r.fx.taskStore.eventsOfTask(r.sc.run.taskId).filter((e) => e.event_type === "tool.side_effect.recovery_resolved");
    assert.equal(events.length, 1, "只能有一个 authoritative recovery resolution");
    assert.equal(r.fx.toolStore.executionsOfTask(r.sc.run.taskId).length, 0);
  } finally { await r.fx.fx.close(); }
});

test("Historical contract：exact version 不存在 → VERIFICATION_NOT_AVAILABLE 且保持 UNKNOWN_EFFECT", async () => {
  const r = await coldUnknown();
  try {
    r.fx.toolRegistry.tools.delete(TRASH_TOOL + "@1");
    const v = await r.fx.authority.verifyUnknownEffect({ callId: r.callId });
    assert.equal(v.ok, false);
    assert.equal(v.error, "SIDE_EFFECT_VERIFICATION_NOT_AVAILABLE");
    assert.equal(r.fx.store.callById(r.callId).status, "UNKNOWN_EFFECT");
  } finally { await r.fx.fx.close(); }
});

test("Tool disabled ≠ verification disabled：disabled 后仍可 read-only 收敛，但绝不再 execute", async () => {
  const r = await coldUnknown();
  try {
    r.fx.toolRegistry.tools.set(TRASH_TOOL + "@1", { ...r.fx.toolRegistry.get(TRASH_TOOL, 1), enabled: false });
    const v = await r.fx.authority.verifyUnknownEffect({ callId: r.callId });
    assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
    assert.equal(r.fx.store.callById(r.callId).status, "FAILED");
    // 不得 execute v1 again。
    const exec = r.fx.authority.executeSideEffect({ ...r.execId });
    assert.equal(exec.ok, false);
    assert.notEqual(exec.executed, true);
  } finally { await r.fx.fx.close(); }
});

test("Session / App disabled 后仍可做 safe read-only recovery verification", async () => {
  const r = await coldUnknown();
  try {
    r.fx.fx.f.identity.logout(r.fx.fx.f.sessions.admin);
    r.fx.fx.f.store.setAppStatus("ai", "disabled");
    const v = await r.fx.authority.verifyUnknownEffect({ callId: r.callId });
    assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
    assert.equal(r.fx.store.callById(r.callId).status, "FAILED");
  } finally { await r.fx.fx.close(); }
});

test("UNKNOWN_EFFECT 不能 reacquire lease / execute（0 mutation）", async () => {
  const r = await coldUnknown();
  try {
    const lease = r.fx.authority.acquireLease({ context: r.fx.ctx(), callId: r.callId, holderId: "exec_new" });
    assert.equal(lease.ok, false, JSON.stringify(lease));
    const exec = r.fx.authority.executeSideEffect({ callId: r.callId, leaseId: r.l.leaseId, holderId: "exec_new" });
    assert.equal(exec.ok, false);
    assert.equal(exec.mutationCount, 0);
    assert.equal(r.fx.store.callById(r.callId).status, "UNKNOWN_EFFECT");
  } finally { await r.fx.fx.close(); }
});

test("Harness spoof recovery/verification fields → TOOL_ARGUMENT_INVALID", async () => {
  const fx = await createSideEffectFixture();
  try {
    const sc = await fx.setupTrash();
    for (const spoof of [{ resourceRef: sc.resourceRef, verificationOutcome: "APPLIED" }, { resourceRef: sc.resourceRef, effectApplied: true }, { resourceRef: sc.resourceRef, executionQuiesced: true }, { resourceRef: sc.resourceRef, recoveryResolved: true }, { resourceRef: sc.resourceRef, retry: true }, { resourceRef: sc.resourceRef, verified: true }]) {
      const p = await fx.authority.planSideEffect({ context: fx.ctx(), taskId: sc.run.taskId, stepId: sc.run.stepId, runId: sc.run.runId, toolId: TRASH_TOOL, arguments: spoof });
      assert.equal(p.ok, false, JSON.stringify(p));
      assert.equal(p.error, "TOOL_ARGUMENT_INVALID");
    }
    assert.equal(fx.store.callsOfTask(sc.run.taskId).length, 0);
  } finally { await fx.fx.close(); }
});

test("Secret scan：C3 产物不含 Provider Secret / mpx_ / tpx_ / 绝对路径 / store root", async () => {
  const r = await coldUnknown();
  try {
    await r.fx.authority.verifyUnknownEffect({ callId: r.callId });
    let dump = "";
    for (const t of TABLES) { try { for (const row of r.fx.fx.f.identity.connection.prepare("SELECT * FROM " + t).all()) dump += JSON.stringify(row) + "\n"; } catch { /* ignore */ } }
    assert.ok(!dump.includes(PROVIDER_SECRET));
    assert.ok(!dump.includes("mpx_"));
    assert.ok(!dump.includes("tpx_"));
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders/.test(dump), "绝对路径不得落库");
    assert.ok(!dump.includes(r.fx.fx.f.storeRoot));
    assert.ok(!/authorization: bearer|Bearer /i.test(dump));
  } finally { await r.fx.fx.close(); }
});
