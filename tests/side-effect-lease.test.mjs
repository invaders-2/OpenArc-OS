/** D4-03C1 · Lease Authority：唯一 ACTIVE、并发、release/expire/revoke、与 Approval 独立。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSideEffectFixture, WRITE_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";

async function approved(opts = {}) {
  let now = 1_000_000;
  const fx = await createSideEffectFixture({ sideEffectClock: () => now, ...opts });
  const run = fx.setupRun();
  const p = await fx.plan(WRITE_TOOL, { target: "doc-1" }, run);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(fx.approve(p.call.callId, { ttlMs: 600000 }).ok, true);
  return { fx, run, call: p.call, advance: (ms) => { now += ms; } };
}
const activeCount = (fx, callId) => fx.store.leasesOfCall(callId).filter((l) => l.status === "ACTIVE").length;

test("acquire：唯一 ACTIVE lease，call → LEASED", async () => {
  const { fx, call } = await approved();
  try {
    const l = fx.lease(call.callId, { holderId: "exec_1", ttlMs: 60000 });
    assert.equal(l.ok, true, JSON.stringify(l));
    assert.equal(l.lease.status, "ACTIVE");
    assert.equal(l.lease.holderId, "exec_1");
    assert.ok(l.lease.holderInstanceId, "lease 必须带 runtime instance id");
    assert.equal(fx.store.callById(call.callId).status, "LEASED");
    assert.equal(activeCount(fx, call.callId), 1);
  } finally { await fx.fx.close(); }
});

test("release：LEASE_RELEASED，call 回到 APPROVED，0 Domain mutation", async () => {
  const { fx, call } = await approved();
  try {
    const l = fx.lease(call.callId);
    const r = fx.authority.releaseLease({ callId: call.callId, leaseId: l.lease.leaseId });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.lease.status, "RELEASED");
    assert.equal(fx.store.callById(call.callId).status, "APPROVED");
    assert.equal(activeCount(fx, call.callId), 0);
  } finally { await fx.fx.close(); }
});

test("double acquire 同 holder → duplicate；并发不同 holder → 只一个成功 LEASE_CONFLICT", async () => {
  const { fx, call } = await approved();
  try {
    const first = fx.lease(call.callId, { holderId: "exec_A" });
    assert.equal(first.ok, true);
    const second = fx.lease(call.callId, { holderId: "exec_A" });
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.lease.leaseId, first.lease.leaseId);
    const other = fx.lease(call.callId, { holderId: "exec_B" });
    assert.equal(other.ok, false);
    assert.equal(other.error, "SIDE_EFFECT_LEASE_CONFLICT");
    assert.equal(activeCount(fx, call.callId), 1);
  } finally { await fx.fx.close(); }
});

test("wrong holder / wrong call → LEASE_NOT_HELD", async () => {
  const { fx, call } = await approved();
  try {
    fx.lease(call.callId, { holderId: "exec_1" });
    const e = fx.elig(call.callId, { holderId: "exec_other" });
    assert.equal(e.status, "DENIED");
    assert.equal(e.reasonCode, "SIDE_EFFECT_LEASE_NOT_HELD");
    const r = fx.authority.releaseLease({ callId: call.callId, leaseId: "slease_nope" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "SIDE_EFFECT_LEASE_NOT_HELD");
  } finally { await fx.fx.close(); }
});

test("expired lease → eligibility LEASE_EXPIRED", async () => {
  const { fx, call, advance } = await approved();
  try {
    fx.lease(call.callId, { holderId: "exec_1", ttlMs: 1000 });
    advance(5000);
    const e = fx.elig(call.callId, { holderId: "exec_1" });
    assert.equal(e.status, "LEASE_REQUIRED");
    assert.equal(e.reasonCode, "SIDE_EFFECT_LEASE_EXPIRED");
  } finally { await fx.fx.close(); }
});

test("Approval != Lease：有 Approval 无 Lease 不能执行；无 Approval 不能 acquire", async () => {
  const { fx, call } = await approved();
  try {
    const e = fx.elig(call.callId, { holderId: null });
    assert.equal(e.status, "LEASE_REQUIRED");
    const fx2 = await createSideEffectFixture();
    try {
      const run2 = fx2.setupRun();
      const p2 = await fx2.plan(WRITE_TOOL, { target: "doc-2" }, run2);
      const l2 = fx2.lease(p2.call.callId, { holderId: "exec_1" });
      assert.equal(l2.ok, false);
      assert.equal(l2.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
      assert.equal(fx2.store.leasesOfCall(p2.call.callId).length, 0);
    } finally { await fx2.fx.close(); }
  } finally { await fx.fx.close(); }
});

test("expired approval + valid lease → APPROVAL_EXPIRED（lease 不能盖过 approval）", async () => {
  const { fx, call, advance } = await approved();
  try {
    fx.lease(call.callId, { holderId: "exec_1", ttlMs: 10 * 60 * 1000 });
    advance(11 * 60 * 1000);
    const e = fx.elig(call.callId, { holderId: "exec_1" });
    assert.equal(e.status, "DENIED");
    assert.equal(e.reasonCode, "SIDE_EFFECT_APPROVAL_EXPIRED");
  } finally { await fx.fx.close(); }
});

test("valid approval + expired lease → LEASE_REQUIRED", async () => {
  const { fx, call, advance } = await approved();
  try {
    fx.lease(call.callId, { holderId: "exec_1", ttlMs: 1000 });
    advance(2000);
    const e = fx.elig(call.callId, { holderId: "exec_1" });
    assert.equal(e.status, "LEASE_REQUIRED");
    assert.equal(e.reasonCode, "SIDE_EFFECT_LEASE_EXPIRED");
  } finally { await fx.fx.close(); }
});

test("revokeLease → REVOKED，eligibility 不再 ELIGIBLE", async () => {
  const { fx, call } = await approved();
  try {
    const l = fx.lease(call.callId, { holderId: "exec_1" });
    const r = fx.authority.revokeLease({ callId: call.callId, leaseId: l.lease.leaseId });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.lease.status, "REVOKED");
    assert.equal(fx.elig(call.callId, { holderId: "exec_1" }).status, "LEASE_REQUIRED");
  } finally { await fx.fx.close(); }
});
