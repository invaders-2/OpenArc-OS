/** D4-03C1 · Crash recovery：RUNNING → UNKNOWN_EFFECT、旧 lease 失效、0 自动 retry。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createSideEffectFixture, WRITE_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";
const require = createRequire(import.meta.url);
const { SideEffectAuthority } = require("../electron/side-effect-authority.cjs");

async function leased(instanceId = "instA") {
  const fx = await createSideEffectFixture();
  const run = fx.setupRun();
  const p = await fx.plan(WRITE_TOOL, { target: "doc-1" }, run);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(fx.approve(p.call.callId).ok, true);
  assert.equal(fx.lease(p.call.callId, { holderId: "exec_1", instanceId }).ok, true);
  return { fx, run, call: p.call };
}
const events = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).map((e) => e.event_type);

test("restart：旧进程 ACTIVE lease → EXPIRED，旧 holder 不能执行，必须重新 acquire", async () => {
  const { fx, call } = await leased("instA");
  try {
    const r = fx.authority.recoverOnStartup();
    assert.equal(r.ok, true);
    assert.equal(r.expiredLeases.length, 1);
    const old = fx.store.activeLeaseOfCall(call.callId);
    assert.equal(old, null, "旧 lease 不再 ACTIVE");
    const e = fx.elig(call.callId, { holderId: "exec_1" });
    assert.equal(e.status, "LEASE_REQUIRED");
    const re = fx.lease(call.callId, { holderId: "exec_1" });
    assert.equal(re.ok, true, JSON.stringify(re));
    assert.equal(re.lease.holderInstanceId, fx.authority.instanceId, "re-acquire 绑定当前 runtime identity");
    assert.equal(fx.elig(call.callId, { holderId: "exec_1" }).status, "ELIGIBLE");
  } finally { await fx.fx.close(); }
});

test("RUNNING-after-crash → UNKNOWN_EFFECT（不是 FAILED/PLANNED/RUNNING）+ event + 0 execution", async () => {
  const { fx, run, call } = await leased("instA");
  try {
    fx.store.transactSync(() => fx.store.updateCall(call.callId, { status: "RUNNING", started_at: 1_000_000 }));
    assert.equal(fx.store.callById(call.callId).status, "RUNNING");
    const before = fx.store.callsOfTask(run.taskId).length;
    const r = fx.authority.recoverOnStartup();
    assert.equal(r.unknownEffectCalls.length, 1);
    const after = fx.store.callById(call.callId);
    assert.equal(after.status, "UNKNOWN_EFFECT");
    assert.equal(after.errorCode, "SIDE_EFFECT_UNKNOWN_EFFECT");
    assert.ok(events(fx, run.taskId).includes("tool.side_effect.unknown_effect"));
    assert.equal(fx.store.callsOfTask(run.taskId).length, before, "不得新建 call（0 自动 retry）");
    assert.equal(fx.toolStore.executionsOfTask(run.taskId).length, 0);
    assert.equal(fx.authority.executeSideEffect().error, "WRITE_EXECUTION_DISABLED");
  } finally { await fx.fx.close(); }
});

test("Crash before RUNNING：APPROVED/LEASED 不进入 UNKNOWN_EFFECT，可安全 release/reacquire", async () => {
  const { fx, call } = await leased("instA");
  try {
    const r = fx.authority.recoverOnStartup();
    assert.equal(r.unknownEffectCalls.length, 0);
    assert.equal(fx.store.callById(call.callId).status, "LEASED");
    const re = fx.lease(call.callId, { holderId: "exec_2" });
    assert.equal(re.ok, true, JSON.stringify(re));
  } finally { await fx.fx.close(); }
});

test("verifyUnknownEffect：无 verifier → VERIFICATION_NOT_AVAILABLE 且保持 UNKNOWN_EFFECT", async () => {
  const { fx, call } = await leased("instA");
  try {
    fx.store.transactSync(() => fx.store.updateCall(call.callId, { status: "RUNNING" }));
    fx.authority.recoverOnStartup();
    const v = await fx.authority.verifyUnknownEffect({ callId: call.callId });
    assert.equal(v.ok, false);
    assert.equal(v.error, "SIDE_EFFECT_VERIFICATION_NOT_AVAILABLE");
    assert.equal(fx.store.callById(call.callId).status, "UNKNOWN_EFFECT");
  } finally { await fx.fx.close(); }
});

test("verifyUnknownEffect：走 allowlisted adapter 的 read-only recovery verifier（APPLIED → SUCCEEDED，NOT_APPLIED + quiesced → FAILED）", async () => {
  const { fx, call } = await leased("instA");
  try {
    fx.store.transactSync(() => fx.store.updateCall(call.callId, { status: "RUNNING" }));
    fx.authority.recoverOnStartup(); // 冷启动 → recovery_safe.quiesced = true
    let outcome = "APPLIED";
    fx.adapters.providers.test.recoveryVerify = async () => ({ outcome, reason: "TEST_PROVIDER_" + outcome });
    const v = await fx.authority.verifyUnknownEffect({ callId: call.callId });
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.outcome, "APPLIED");
    assert.equal(fx.store.callById(call.callId).status, "SUCCEEDED");
    assert.equal(fx.store.callById(call.callId).verificationStatus, "PASS");
    assert.equal(fx.toolStore.executionsOfTask(call.taskId).length, 0);
    // terminal duplicate：再次 verify 不产生第二次状态副作用。
    const again = await fx.authority.verifyUnknownEffect({ callId: call.callId });
    assert.equal(again.duplicate, true);
    assert.equal(fx.store.callById(call.callId).status, "SUCCEEDED");
    // NOT_APPLIED + quiesced → FAILED（另一个 call）。
    const second = await leased("instA");
    try {
      second.fx.store.transactSync(() => second.fx.store.updateCall(second.call.callId, { status: "RUNNING" }));
      second.fx.authority.recoverOnStartup();
      second.fx.adapters.providers.test.recoveryVerify = async () => ({ outcome: "NOT_APPLIED", reason: "TEST_NOT_APPLIED" });
      const r = await second.fx.authority.verifyUnknownEffect({ callId: second.call.callId });
      assert.equal(r.outcome, "NOT_APPLIED");
      assert.equal(r.resolved, true);
      assert.equal(second.fx.store.callById(second.call.callId).status, "FAILED");
      assert.equal(second.fx.store.callById(second.call.callId).verificationStatus, "FAIL");
    } finally { await second.fx.fx.close(); }
    void outcome;
  } finally { await fx.fx.close(); }
});

test("no auto retry：recovery 不得产生第二次 authority / execution", async () => {
  const { fx, run, call } = await leased("instA");
  try {
    fx.store.transactSync(() => fx.store.updateCall(call.callId, { status: "RUNNING" }));
    const proposalsBefore = fx.toolStore.proposalsOfTask(run.taskId).length;
    fx.authority.recoverOnStartup();
    fx.authority.recoverOnStartup();
    assert.equal(fx.store.callsOfTask(run.taskId).length, 1, "只应存在 1 个 side effect call");
    assert.equal(fx.toolStore.proposalsOfTask(run.taskId).length, proposalsBefore, "不得新建 proposal");
    assert.equal(fx.toolStore.executionsOfTask(run.taskId).length, 0, "0 execution invocation");
    assert.equal(fx.store.callById(call.callId).status, "UNKNOWN_EFFECT");
  } finally { await fx.fx.close(); }
});
