/** D4-03C1 · Idempotency binding：同 call 幂等、无第二 authority、key 不能绑不同 args、不自动合并新 proposal。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSideEffectFixture, WRITE_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";

async function ready() {
  const fx = await createSideEffectFixture();
  const run = fx.setupRun();
  const p = await fx.plan(WRITE_TOOL, { target: "doc-1" }, run);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(fx.approve(p.call.callId).ok, true);
  assert.equal(fx.lease(p.call.callId, { holderId: "exec_1" }).ok, true);
  return { fx, run, call: p.call };
}

test("同 call 重复 eligibility → 状态一致，0 新 call / 0 新 lease / 0 Domain", async () => {
  const { fx, run, call } = await ready();
  try {
    const beforeCalls = fx.store.callsOfTask(run.taskId).length;
    const beforeLeases = fx.store.leasesOfCall(call.callId).length;
    const a = fx.elig(call.callId);
    const b = fx.elig(call.callId);
    assert.equal(a.status, "ELIGIBLE");
    assert.equal(b.status, "ELIGIBLE");
    assert.deepEqual(a.checks, b.checks);
    assert.equal(fx.store.callsOfTask(run.taskId).length, beforeCalls);
    assert.equal(fx.store.leasesOfCall(call.callId).length, beforeLeases);
    assert.equal(fx.toolStore.executionsOfTask(run.taskId).length, 0);
  } finally { await fx.fx.close(); }
});

test("同 call 重复 acquire → duplicate，仍然只有 1 个 ACTIVE authority", async () => {
  const { fx, call } = await ready();
  try {
    const first = fx.store.activeLeaseOfCall(call.callId);
    const again = fx.lease(call.callId, { holderId: "exec_1" });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal(again.lease.leaseId, first.leaseId);
    assert.equal(fx.store.leasesOfCall(call.callId).filter((l) => l.status === "ACTIVE").length, 1);
  } finally { await fx.fx.close(); }
});

test("同一 idempotency key 不能绑定不同 arguments；相同 binding 幂等", async () => {
  const { fx, run } = await ready();
  try {
    const a = await fx.plan(WRITE_TOOL, { target: "same" }, run, { _idempotencyKey: "idem_fixed_1" });
    assert.equal(a.ok, true, JSON.stringify(a));
    const b = await fx.plan(WRITE_TOOL, { target: "different" }, run, { _idempotencyKey: "idem_fixed_1" });
    assert.equal(b.ok, false);
    assert.equal(b.error, "SIDE_EFFECT_IDEMPOTENCY_CONFLICT");
    const c = await fx.plan(WRITE_TOOL, { target: "same" }, run, { _idempotencyKey: "idem_fixed_1" });
    assert.equal(c.ok, true);
    assert.equal(c.duplicate, true);
    assert.equal(c.call.callId, a.call.callId);
  } finally { await fx.fx.close(); }
});

test("新 proposal 语义相同 write → 新 call（不自动合并），但只有按 call 的 authority", async () => {
  const { fx, run } = await ready();
  try {
    const first = await fx.plan(WRITE_TOOL, { target: "doc-x" }, run);
    const second = await fx.plan(WRITE_TOOL, { target: "doc-x" }, run);
    assert.notEqual(first.call.callId, second.call.callId);
    assert.notEqual(first.call.idempotencyKey, second.call.idempotencyKey);
    assert.equal(first.call.argumentsHash, second.call.argumentsHash);
    assert.equal(fx.store.callsOfTask(run.taskId).filter((c) => c.toolId === WRITE_TOOL && c.argumentsHash === first.call.argumentsHash).length >= 2, true);
  } finally { await fx.fx.close(); }
});
