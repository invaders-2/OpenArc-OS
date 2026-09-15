/**
 * D4-03C2 · Controlled Reversible Write E2E。
 *
 * 第一条真实 production REVERSIBLE_WRITE：resource.trash → ResourceService.delete。
 * 证明：Approval required / Lease required / Eligibility required / claim exactly once /
 * Domain invocation exactly once / 真实 Domain verification / lease finalization / 可逆。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSideEffectFixture, TRASH_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";
import { PROVIDER_SECRET } from "./fixtures/harness-acp/task-harness-fixture.mjs";

const TABLES = ["side_effect_calls", "tool_approvals", "side_effect_leases", "task_tool_proposals", "tool_decisions", "tool_executions", "task_events", "authorization_audit", "resource_registry", "library_resources"];

/** 统计真实 ResourceService.delete 的 Domain invocation，不改变语义。 */
function countDeleteCalls(fx) {
  const real = fx.fx.f.resourceService.delete.bind(fx.fx.f.resourceService);
  const box = { calls: 0, lastArgs: null, lastResult: null };
  fx.fx.f.resourceService.delete = (args) => { box.calls += 1; box.lastArgs = args; const r = real(args); box.lastResult = r; return r; };
  return box;
}

async function readyTrash(opts = {}) {
  const fx = await createSideEffectFixture(opts);
  const sc = await fx.setupTrash({ resourceName: opts.resourceName || "C2 Trash Target" });
  const deleteCounter = countDeleteCalls(fx);
  const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run, holderId: opts.holderId || "exec_1", ttlMs: opts.ttlMs, instanceId: opts.instanceId });
  return { fx, sc, deleteCounter, ...flow };
}

test("E2E：resource.trash 真实闭环 Proposal→APPROVAL_REQUIRED→Plan→Approve→Lease→ELIGIBLE→claim→delete→verify→SUCCEEDED", async () => {
  const { fx, sc, deleteCounter, prop, plan, approval, lease, callId } = await readyTrash();
  try {
    assert.equal(prop.decisionStatus, "APPROVAL_REQUIRED", JSON.stringify(prop));
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.call.status, "AWAITING_APPROVAL");
    assert.equal(plan.call.effectClass, "REVERSIBLE_WRITE");
    assert.equal(plan.call.toolId, TRASH_TOOL);
    // §6：plan 只读，expectedVersion / expectedEffects 来自真实 Domain state。
    assert.equal(plan.call.preconditionsSafe.resourceRef, sc.resourceRef);
    assert.equal(plan.call.preconditionsSafe.expectedVersion, 1);
    assert.equal(plan.call.expectedEffectsSafe[0].action, "trash");
    assert.equal(plan.plan.preconditions.expectedVersion, 1);
    assert.equal(approval.ok, true, JSON.stringify(approval));
    assert.equal(approval.call.status, "APPROVED");
    assert.equal(lease.ok, true, JSON.stringify(lease));
    assert.equal(fx.store.callById(callId).status, "LEASED");
    const elig = fx.elig(callId);
    assert.equal(elig.status, "ELIGIBLE", JSON.stringify(elig));

    assert.equal(deleteCounter.calls, 0, "execute 前 0 Domain invocation");
    const exec = await fx.authority.executeSideEffect({ callId, holderId: "exec_1" });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(exec.executed, true);
    assert.equal(exec.mutationCount, 1);
    assert.equal(exec.verificationStatus, "PASS");
    assert.equal(exec.call.status, "SUCCEEDED");
    assert.equal(exec.call.verificationStatus, "PASS");
    assert.ok(exec.call.completedAt != null);

    // exactly once Domain invocation + exactly one business mutation。
    assert.equal(deleteCounter.calls, 1, "ResourceService.delete 恰好一次");
    const pre = fx.precondition(sc.resourceRef);
    assert.equal(pre.ok, true);
    assert.equal(pre.trashed, true, "真实 Resource 已 trashed");
    assert.equal(pre.registryStatus, "deleted");
    assert.equal(fx.store.callsOfTask(sc.run.taskId).filter((c) => c.toolId === TRASH_TOOL).length, 1);
    assert.equal(fx.toolStore.executionsOfTask(sc.run.taskId).length, 0, "SideEffectCall 是唯一 authority，不建第二套 execution state");

    // lease finalization：SUCCEEDED 后 0 ACTIVE，execution ownership 失效。
    assert.equal(fx.store.activeLeaseOfCall(callId), null);
    assert.equal(fx.store.leasesOfCall(callId).filter((l) => l.status === "RELEASED").length, 1);

    // §19 事件 + audit 只存安全投影。
    const events = fx.taskStore.eventsOfTask(sc.run.taskId).map((e) => e.event_type);
    for (const ev of ["tool.side_effect.execution_started", "tool.side_effect.verification_passed", "tool.side_effect.succeeded"]) {
      assert.ok(events.includes(ev), "缺少事件 " + ev + " in " + JSON.stringify(events));
    }
    const auditActions = fx.fx.f.identity.connection.prepare("SELECT action FROM authorization_audit").all().map((r) => r.action);
    for (const act of ["side_effect.execution_started", "side_effect.verification_passed", "side_effect.succeeded", "side_effect.lease_released"]) {
      assert.ok(auditActions.includes(act), "缺少 audit " + act);
    }
    // ELIGIBLE 后不能再执行（终态不可逆）。
    const again = await fx.authority.executeSideEffect({ callId, holderId: "exec_1" });
    assert.equal(again.duplicate, true);
    assert.equal(deleteCounter.calls, 1);
  } finally { await fx.fx.close(); }
});

test("Reversibility evidence：真实 ResourceService.restore() 证明 trash 可恢复（不开放 restore Tool）", async () => {
  const { fx, sc, callId, deleteCounter } = await readyTrash();
  try {
    const exec = await fx.authority.executeSideEffect({ callId, holderId: "exec_1" });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(fx.precondition(sc.resourceRef).trashed, true);
    const restored = fx.restoreTrash(sc.resourceRef);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(fx.precondition(sc.resourceRef).trashed, false, "trash 效果可逆");
    assert.equal(deleteCounter.calls, 1);
    // 只有 resource.trash 是 production write tool；resource.restore 不在 Registry。
    assert.deepEqual(fx.toolRegistry.versionsOf("resource.restore"), []);
  } finally { await fx.fx.close(); }
});

test("Verification 是必须的：verifier 报未生效 → FAILED + verificationStatus FAIL + 0 retry", async () => {
  const { fx, sc, callId, deleteCounter } = await readyTrash();
  try {
    const provider = fx.adapters.providers.ResourceService;
    const realVerify = provider.verify;
    provider.verify = async () => ({ ok: true, applied: false, confidence: "KNOWN_NO_EFFECT", detail: { reason: "PROBE" } });
    const exec = await fx.authority.executeSideEffect({ callId, holderId: "exec_1" });
    provider.verify = realVerify;
    assert.equal(exec.ok, false);
    assert.equal(exec.error, "SIDE_EFFECT_VERIFICATION_FAILED");
    assert.equal(exec.call.status, "FAILED");
    assert.equal(exec.call.verificationStatus, "FAIL");
    assert.equal(deleteCounter.calls, 1, "不重试");
    assert.equal(fx.store.activeLeaseOfCall(callId), null, "known no-effect 也要释放 lease");
  } finally { await fx.fx.close(); }
});

test("Verifier 不可用（无法判断是否发生）→ UNKNOWN_EFFECT + Task/Step BLOCKED + 0 retry", async () => {
  const { fx, sc, callId, deleteCounter } = await readyTrash();
  try {
    const provider = fx.adapters.providers.ResourceService;
    const realVerify = provider.verify;
    provider.verify = async () => ({ ok: false, detail: { reason: "VERIFIER_DOWN" } });
    const exec = await fx.authority.executeSideEffect({ callId, holderId: "exec_1" });
    provider.verify = realVerify;
    assert.equal(exec.ok, false);
    assert.equal(exec.error, "SIDE_EFFECT_UNKNOWN_EFFECT");
    assert.equal(exec.call.status, "UNKNOWN_EFFECT");
    assert.notEqual(exec.call.status, "FAILED");
    assert.equal(deleteCounter.calls, 1);
    const task = fx.taskStore.taskById(sc.run.taskId);
    const step = fx.taskStore.stepById(sc.run.stepId);
    assert.equal(task.status, "BLOCKED", "UNKNOWN_EFFECT 必须 BLOCK Task");
    assert.equal(step.status, "BLOCKED");
    assert.equal(fx.store.activeLeaseOfCall(callId), null);
    assert.equal(fx.store.leasesOfCall(callId)[0].status, "REVOKED");
    // 再次 execute 绝不第二次 mutation。
    const again = await fx.authority.executeSideEffect({ callId, holderId: "exec_1" });
    assert.equal(again.ok, false);
    assert.equal(deleteCounter.calls, 1);
  } finally { await fx.fx.close(); }
});

test("Duplicate execute：同一 callId/holder 执行两次 → 只 1 次 Domain mutation", async () => {
  const { fx, callId, deleteCounter } = await readyTrash();
  try {
    const first = await fx.authority.executeSideEffect({ callId, holderId: "exec_1" });
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await fx.authority.executeSideEffect({ callId, holderId: "exec_1" });
    assert.equal(second.duplicate, true);
    assert.equal(second.executed, false);
    assert.equal(deleteCounter.calls, 1, "第二次绝不 invoke Domain");
    assert.equal(fx.store.callById(callId).status, "SUCCEEDED");
  } finally { await fx.fx.close(); }
});

test("并发 claim：两个 executor 争同一 leased call → 只有 1 个 claimant / 1 次 mutation", async () => {
  const { fx, callId, deleteCounter } = await readyTrash();
  try {
    const [a, b] = await Promise.all([
      fx.authority.executeSideEffect({ callId, holderId: "exec_1" }),
      fx.authority.executeSideEffect({ callId, holderId: "exec_2" }),
    ]);
    const winners = [a, b].filter((r) => r.ok === true && r.executed === true);
    const losers = [a, b].filter((r) => !(r.ok === true && r.executed === true));
    assert.equal(winners.length, 1, JSON.stringify([a, b]));
    assert.equal(losers.length, 1);
    assert.equal(deleteCounter.calls, 1, "只有一个 executor 能 dispatch Domain");
    assert.equal(fx.store.callById(callId).status, "SUCCEEDED");
  } finally { await fx.fx.close(); }
});

test("Business optimistic concurrency：plan 后 Resource version 变化 → 0 mutation + PRECONDITION_CHANGED", async () => {
  const { fx, sc, callId, deleteCounter } = await readyTrash();
  try {
    // 真实业务 Domain 并发：plan 之后、execute 之前真的改一次内容形成 v2。
    const bumped = await fx.fx.f.resourceService.replaceText({ context: fx.fx.f.adminCtx(), resourceRef: sc.resourceRef, text: "concurrent edit", expectedVersion: 1 });
    assert.equal(bumped.ok, true, JSON.stringify(bumped));
    const elig = fx.elig(callId);
    assert.equal(elig.status, "STALE");
    assert.equal(elig.reasonCode, "SIDE_EFFECT_PRECONDITION_CHANGED");
    const exec = await fx.authority.executeSideEffect({ callId, holderId: "exec_1" });
    assert.equal(exec.ok, false);
    assert.equal(exec.error, "SIDE_EFFECT_PRECONDITION_CHANGED");
    assert.equal(deleteCounter.calls, 0, "0 Domain mutation");
    assert.equal(fx.precondition(sc.resourceRef).trashed, false);
    assert.equal(fx.store.callById(callId).status, "LEASED", "未 claim，仍可安全重试/释放");
  } finally { await fx.fx.close(); }
});

test("§20 production exposure boundary：只有 resource.trash 可执行；test.write 等仍 WRITE_EXECUTION_DISABLED", async () => {
  const { fx, sc, callId, deleteCounter } = await readyTrash();
  try {
    // test.write 经同一 authority：无 executionPolicy → 永远 disabled。
    const run2 = fx.setupRun();
    const p2 = await fx.plan("test.write", { target: "x" }, run2);
    assert.equal(p2.ok, true, JSON.stringify(p2));
    assert.equal(fx.approve(p2.call.callId).ok, true);
    assert.equal(fx.lease(p2.call.callId).ok, true);
    const disabled = fx.authority.executeSideEffect({ callId: p2.call.callId, holderId: "exec_1" });
    assert.equal(disabled.error, "WRITE_EXECUTION_DISABLED");
    assert.equal(disabled.mutationCount, 0);
    // 未注册的 write tool / 无 executionPolicy 的 REVERSIBLE_WRITE → BLOCKED。
    const exec = await fx.authority.executeSideEffect({ callId, holderId: "exec_1" });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(deleteCounter.calls, 1);
    assert.deepEqual(fx.toolRegistry.ids().filter((t) => t.startsWith("resource.")).sort(), ["resource.read.metadata", "resource.search", "resource.trash"]);
    void sc;
  } finally { await fx.fx.close(); }
});

test("Secret scan：C2 产物不含 Provider Secret / mpx_ / tpx_ / 绝对路径 / store root", async () => {
  const { fx, callId } = await readyTrash();
  try {
    assert.equal((await fx.authority.executeSideEffect({ callId, holderId: "exec_1" })).ok, true);
    let dump = "";
    for (const t of TABLES) { try { for (const row of fx.fx.f.identity.connection.prepare("SELECT * FROM " + t).all()) dump += JSON.stringify(row) + "\n"; } catch { /* ignore */ } }
    assert.ok(!dump.includes(PROVIDER_SECRET), "Provider Secret 不得落库");
    assert.ok(!dump.includes("mpx_"));
    assert.ok(!dump.includes("tpx_"));
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders/.test(dump), "绝对路径不得落库");
    assert.ok(!dump.includes(fx.fx.f.storeRoot), "store root 不得落库");
    assert.ok(!/authorization: bearer|Bearer /i.test(dump));
  } finally { await fx.fx.close(); }
});

test("Crash boundary 不退化：C2 执行路径存在后，RUNNING→restart 仍 UNKNOWN_EFFECT + 0 replay", async () => {
  const { fx, sc, callId, deleteCounter } = await readyTrash();
  try {
    // 人工注入 RUNNING（模拟 dispatch 后进程崩溃）。
    fx.store.transactSync(() => fx.store.updateCall(callId, { status: "RUNNING", started_at: 1000000 }));
    const r = fx.authority.recoverOnStartup({ instanceId: "inst_restart" });
    assert.equal(r.unknownEffectCalls.length, 1);
    assert.equal(fx.store.callById(callId).status, "UNKNOWN_EFFECT");
    assert.equal(fx.taskStore.taskById(sc.run.taskId).status, "BLOCKED");
    assert.equal(fx.taskStore.stepById(sc.run.stepId).status, "BLOCKED");
    assert.equal(deleteCounter.calls, 0, "0 replay / 0 retry / 0 Domain invocation");
    assert.equal(fx.store.callsOfTask(sc.run.taskId).filter((c) => c.toolId === TRASH_TOOL).length, 1);
  } finally { await fx.fx.close(); }
});
