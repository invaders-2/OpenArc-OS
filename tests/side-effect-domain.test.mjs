/** D4-03C1 · Side-effect 纯领域：effect class / 状态机 / plan hash / idempotency / eligibility matrix。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const d = require("../electron/side-effect-domain.cjs");

test("effectClassForRisk：READ_ONLY 不是 side effect；write 族一一对应", () => {
  assert.equal(d.effectClassForRisk("READ_ONLY"), null);
  assert.equal(d.effectClassForRisk("REVERSIBLE_WRITE"), "REVERSIBLE_WRITE");
  assert.equal(d.effectClassForRisk("IRREVERSIBLE_WRITE"), "IRREVERSIBLE_WRITE");
  assert.equal(d.effectClassForRisk("EXTERNAL_SIDE_EFFECT"), "EXTERNAL_SIDE_EFFECT");
  assert.equal(d.effectClassForRisk("PRIVILEGED"), "PRIVILEGED");
  assert.equal(d.isC1EffectClass("REVERSIBLE_WRITE"), true);
  assert.equal(d.isC1EffectClass("IRREVERSIBLE_WRITE"), false);
  assert.equal(d.isC1EffectClass("EXTERNAL_SIDE_EFFECT"), false);
  assert.equal(d.isC1EffectClass("PRIVILEGED"), false);
});

test("call 状态机：最多 LEASED；RUNNING→UNKNOWN_EFFECT；终态不可逆", () => {
  assert.equal(d.canTransitionCall("PLANNED", "AWAITING_APPROVAL"), true);
  assert.equal(d.canTransitionCall("APPROVED", "LEASED"), true);
  assert.equal(d.canTransitionCall("LEASED", "RUNNING"), true);
  assert.equal(d.canTransitionCall("RUNNING", "UNKNOWN_EFFECT"), true);
  assert.equal(d.canTransitionCall("SUCCEEDED", "RUNNING"), false);
  assert.equal(d.canTransitionCall("UNKNOWN_EFFECT", "RUNNING"), false);
  assert.ok(d.C1_MAX_STATUS.includes("LEASED"));
  assert.ok(!d.C1_MAX_STATUS.includes("RUNNING"));
});

test("planHash / idempotencyKey：plan 或 args 改变即改变", () => {
  const base = { callId: "scall_1", toolId: "test.write", toolVersion: 1, argumentsHash: "a", riskClass: "REVERSIBLE_WRITE", requiresApproval: true, targets: ["t"], preconditions: { targetRef: "t" }, expectedEffects: [{ action: "update" }] };
  const h1 = d.planHashOf(base);
  const h2 = d.planHashOf({ ...base, argumentsHash: "b" });
  const h3 = d.planHashOf({ ...base, expectedEffects: [{ action: "delete" }] });
  assert.notEqual(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(d.planHashOf({ ...base }), h1);
  const k1 = d.idempotencyKeyOf({ callId: "c1", toolId: "test.write", toolVersion: 1, argumentsHash: "a", targetRefs: ["t"] });
  const k2 = d.idempotencyKeyOf({ callId: "c2", toolId: "test.write", toolVersion: 1, argumentsHash: "a", targetRefs: ["t"] });
  assert.notEqual(k1, k2, "不同 callId → 不同 key（新 proposal 不自动合并）");
  assert.match(k1, /^idem_/);
});

test("evaluateExecutionEligibility：纯函数逐 gate 判定", () => {
  const call = { call_id: "scall_1", effect_class: "REVERSIBLE_WRITE", status: "LEASED", plan_hash: "ph", arguments_hash: "ah", tool_id: "test.write", tool_version: 1 };
  const base = {
    call,
    task: { task_id: "task_1", status: "RUNNING", cancel_requested: 0, user_id: "u1", app_id: "ai" },
    actor: { ok: true, user: { id: "u1" } },
    app: { status: "enabled" },
    appId: "ai",
    step: { task_id: "task_1", status: "RUNNING" },
    runId: "run_1", latestRunId: "run_1",
    tool: { ok: true, contract: { toolId: "test.write", version: 1, riskClass: "REVERSIBLE_WRITE", verificationStrategy: "READ_AFTER_WRITE" } },
    authorization: { ok: true },
    approval: { decision: "APPROVED", plan_hash: "ph", approved_arguments_hash: "ah", approved_tool_id: "test.write", approved_tool_version: 1, approved_effect_class: "REVERSIBLE_WRITE", expires_at: 9999, revoked_at: null },
    lease: { call_id: "scall_1", status: "ACTIVE", holder_id: "exec_1", expires_at: 9999 },
    holderId: "exec_1",
    planHash: "ph",
    argumentsHash: "ah",
    preconditionsOk: true,
    now: 1000,
  };
  assert.equal(d.evaluateExecutionEligibility(base).status, "ELIGIBLE");
  assert.equal(d.evaluateExecutionEligibility({ ...base, call: null }).reasonCode, "SIDE_EFFECT_CALL_NOT_FOUND");
  assert.equal(d.evaluateExecutionEligibility({ ...base, task: { ...base.task, cancel_requested: 1 } }).reasonCode, "TASK_CANCELLED");
  assert.equal(d.evaluateExecutionEligibility({ ...base, app: { status: "disabled" } }).reasonCode, "SIDE_EFFECT_APP_DISABLED");
  assert.equal(d.evaluateExecutionEligibility({ ...base, runId: "run_old" }).reasonCode, "SIDE_EFFECT_STALE_RUN");
  assert.equal(d.evaluateExecutionEligibility({ ...base, tool: { ok: false, error: "SIDE_EFFECT_TOOL_VERSION_CHANGED" } }).reasonCode, "SIDE_EFFECT_TOOL_VERSION_CHANGED");
  assert.equal(d.evaluateExecutionEligibility({ ...base, tool: { ok: true, contract: { ...base.tool.contract, verificationStrategy: null } } }).reasonCode, "SIDE_EFFECT_VERIFICATION_UNAVAILABLE");
  assert.equal(d.evaluateExecutionEligibility({ ...base, authorization: { ok: false } }).reasonCode, "SIDE_EFFECT_AUTHORIZATION_REVOKED");
  assert.equal(d.evaluateExecutionEligibility({ ...base, approval: null }).status, "APPROVAL_REQUIRED");
  assert.equal(d.evaluateExecutionEligibility({ ...base, approval: { ...base.approval, decision: "REVOKED" } }).reasonCode, "SIDE_EFFECT_APPROVAL_REVOKED");
  assert.equal(d.evaluateExecutionEligibility({ ...base, approval: { ...base.approval, expires_at: 10 } }).reasonCode, "SIDE_EFFECT_APPROVAL_EXPIRED");
  assert.equal(d.evaluateExecutionEligibility({ ...base, approval: { ...base.approval, plan_hash: "other" } }).reasonCode, "SIDE_EFFECT_PLAN_STALE");
  assert.equal(d.evaluateExecutionEligibility({ ...base, requestArgumentsHash: "other" }).reasonCode, "SIDE_EFFECT_PLAN_STALE");
  assert.equal(d.evaluateExecutionEligibility({ ...base, lease: null }).status, "LEASE_REQUIRED");
  assert.equal(d.evaluateExecutionEligibility({ ...base, lease: { ...base.lease, holder_id: "other" } }).reasonCode, "SIDE_EFFECT_LEASE_NOT_HELD");
  assert.equal(d.evaluateExecutionEligibility({ ...base, preconditionsOk: false }).reasonCode, "SIDE_EFFECT_PRECONDITION_CHANGED");
});
