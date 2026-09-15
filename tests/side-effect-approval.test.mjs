/** D4-03C1 · Approval Authority：create / deny / expire / revoke / 精确绑定 / 来源可信。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSideEffectFixture, WRITE_TOOL, NOVERIFY_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";

async function planned(opts = {}) {
  let now = 1_000_000;
  const fx = await createSideEffectFixture({ sideEffectClock: () => now, ...opts });
  const run = fx.setupRun();
  const p = await fx.plan(WRITE_TOOL, { target: "doc-1" }, run);
  return { fx, run, p, advance: (ms) => { now += ms; }, now: () => now };
}

test("plan：REVERSIBLE_WRITE → AWAITING_APPROVAL，callId/idempotencyKey/planHash 全部 OpenArc 生成", async () => {
  const { fx, p } = await planned();
  try {
    assert.equal(p.ok, true, JSON.stringify(p));
    const c = p.call;
    assert.equal(c.status, "AWAITING_APPROVAL");
    assert.equal(c.effectClass, "REVERSIBLE_WRITE");
    assert.match(c.callId, /^scall_/);
    assert.match(c.idempotencyKey, /^idem_/);
    assert.equal(typeof c.planHash, "string");
    assert.ok(c.preconditionsSafe && typeof c.preconditionsSafe === "object");
    assert.ok(Array.isArray(c.expectedEffectsSafe));
    // 未执行：0 tool_executions，call 未 RUNNING/SUCCEEDED。
    assert.equal(fx.toolStore.executionsOfTask(p.call.taskId).length, 0);
    assert.ok(!["RUNNING", "SUCCEEDED"].includes(c.status));
  } finally { await fx.fx.close(); }
});

test("approve：绑定 planHash/tool/version/argsHash/effectClass/expectedEffects；agent 来源一律拒绝", async () => {
  const { fx, p } = await planned();
  try {
    const agentTry = fx.authority.approveSideEffect({ context: fx.ctx(), callId: p.call.callId });
    assert.equal(agentTry.ok, false);
    assert.equal(agentTry.error, "SIDE_EFFECT_APPROVAL_FORBIDDEN");
    const a = fx.approve(p.call.callId, { ttlMs: 600000 });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.call.status, "APPROVED");
    assert.equal(a.approval.planHash, p.call.planHash);
    assert.equal(a.approval.approvedToolId, WRITE_TOOL);
    assert.equal(a.approval.approvedToolVersion, 1);
    assert.equal(a.approval.approvedArgumentsHash, p.call.argumentsHash);
    assert.equal(a.approval.approvedEffectClass, "REVERSIBLE_WRITE");
    assert.ok(a.approval.expiresAt > a.approval.createdAt);
  } finally { await fx.fx.close(); }
});

test("deny：call BLOCKED + approval DENIED，0 execution", async () => {
  const { fx, p } = await planned();
  try {
    const d = fx.deny(p.call.callId);
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.approval.decision, "DENIED");
    assert.equal(d.call.status, "BLOCKED");
    assert.equal(d.call.errorCode, "SIDE_EFFECT_APPROVAL_DENIED");
    assert.equal(fx.toolStore.executionsOfTask(p.call.taskId).length, 0);
  } finally { await fx.fx.close(); }
});

test("expiry：approval 过期 → acquire APPROVAL_EXPIRED，eligibility APPROVAL_EXPIRED", async () => {
  const { fx, p, advance } = await planned();
  try {
    const a = fx.approve(p.call.callId, { ttlMs: 1000 });
    assert.equal(a.ok, true, JSON.stringify(a));
    advance(5000);
    const lease = fx.lease(p.call.callId);
    assert.equal(lease.ok, false);
    assert.equal(lease.error, "SIDE_EFFECT_APPROVAL_EXPIRED");
    const e = fx.elig(p.call.callId);
    assert.equal(e.status, "DENIED");
    assert.equal(e.reasonCode, "SIDE_EFFECT_APPROVAL_EXPIRED");
  } finally { await fx.fx.close(); }
});

test("revoke：approval REVOKED → eligibility DENIED APPROVAL_REVOKED", async () => {
  const { fx, p } = await planned();
  try {
    assert.equal(fx.approve(p.call.callId).ok, true);
    const r = fx.revokeApproval(p.call.callId);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.approval.decision, "REVOKED");
    assert.ok(r.approval.revokedAt != null);
    const e = fx.elig(p.call.callId, { holderId: null });
    assert.equal(e.status, "DENIED");
    assert.equal(e.reasonCode, "SIDE_EFFECT_APPROVAL_REVOKED");
  } finally { await fx.fx.close(); }
});

test("wrong user / wrong session / wrong call：approval 来源与目标必须精确", async () => {
  const { fx, p } = await planned();
  try {
    const wrongUser = fx.approve(p.call.callId, { context: fx.aliceUserCtx() });
    assert.equal(wrongUser.ok, false);
    assert.equal(wrongUser.error, "SIDE_EFFECT_APPROVAL_FORBIDDEN");
    const wrongSession = fx.authority.approveSideEffect({ context: { sessionRef: "sref_does_not_exist", appId: "ai", source: "user" }, callId: p.call.callId });
    assert.equal(wrongSession.ok, false);
    assert.equal(wrongSession.error, "SIDE_EFFECT_APPROVAL_FORBIDDEN");
    const wrongCall = fx.approve("scall_does_not_exist");
    assert.equal(wrongCall.ok, false);
    assert.equal(wrongCall.error, "SIDE_EFFECT_CALL_NOT_FOUND");
  } finally { await fx.fx.close(); }
});

test("wrong planHash / wrong argsHash → PLAN_STALE，不能执行", async () => {
  const { fx, p } = await planned();
  try {
    assert.equal(fx.approve(p.call.callId).ok, true);
    // 手工插入 planHash 不匹配的 approval，验证 binding 检查。
    fx.store.transactSync(() => fx.store.insertApproval({ callId: p.call.callId, actorUserId: "u", sessionRef: fx.fx.f.sessions.admin, decision: "APPROVED", planHash: "tampered", expiresAt: Date.now() + 100000 }));
    const e = fx.elig(p.call.callId);
    assert.equal(e.status, "STALE");
    assert.equal(e.reasonCode, "SIDE_EFFECT_PLAN_STALE");
    const e2 = fx.elig(p.call.callId, { requestArgumentsHash: "different-args" });
    assert.equal(e2.reasonCode, "SIDE_EFFECT_PLAN_STALE");
  } finally { await fx.fx.close(); }
});

test("tool version changed：approval v1 后 Registry 变 v2 → eligibility TOOL_VERSION_CHANGED", async () => {
  const { fx, p } = await planned();
  try {
    assert.equal(fx.approve(p.call.callId).ok, true);
    assert.equal(fx.lease(p.call.callId).ok, true);
    fx.toolRegistry.register({ ...fx.toolRegistry.get(WRITE_TOOL, 1), version: 2 });
    const e = fx.elig(p.call.callId);
    assert.equal(e.status, "STALE");
    assert.equal(e.reasonCode, "SIDE_EFFECT_TOOL_VERSION_CHANGED");
  } finally { await fx.fx.close(); }
});

test("无 verificationStrategy 的 write tool → SIDE_EFFECT_VERIFICATION_UNAVAILABLE，不建 call", async () => {
  const { fx, run } = await planned();
  try {
    const p = await fx.plan(NOVERIFY_TOOL, { target: "doc-1" }, run);
    assert.equal(p.ok, false);
    assert.equal(p.error, "SIDE_EFFECT_VERIFICATION_UNAVAILABLE");
    assert.equal(fx.store.callsOfTask(run.taskId).filter((c) => c.toolId === NOVERIFY_TOOL).length, 0);
  } finally { await fx.fx.close(); }
});

test("IRREVERSIBLE_WRITE / EXTERNAL_SIDE_EFFECT / PRIVILEGED → EFFECT_CLASS_BLOCKED（永不建 call）", async () => {
  const { fx, run } = await planned();
  try {
    for (const [i, risk] of ["IRREVERSIBLE_WRITE", "EXTERNAL_SIDE_EFFECT", "PRIVILEGED"].entries()) {
      const toolId = "test.blocked" + i;
      fx.toolRegistry.register({ ...fx.toolRegistry.get(WRITE_TOOL, 1), toolId, version: 1, riskClass: risk, verificationStrategy: "READ_AFTER_WRITE", idempotencySupport: true });
      const p = await fx.plan(toolId, { target: "x" }, run);
      assert.equal(p.ok, false, risk);
      assert.equal(p.error, "SIDE_EFFECT_EFFECT_CLASS_BLOCKED");
    }
    assert.equal(fx.store.callsOfTask(run.taskId).filter((c) => /^test\.blocked/.test(c.toolId)).length, 0);
  } finally { await fx.fx.close(); }
});
