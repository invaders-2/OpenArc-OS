/**
 * D4-03C1 · Side-effect Authority 纯领域模型（无 I/O）。
 *
 * 永久冻结：**ToolDecision = ALLOWED != Approval != Lease != Execution != Verified Effect**。
 * 五层 authority 彻底分开；Harness 不能提供 approval / lease / callId / idempotencyKey /
 * effectClass / expectedEffects。
 *
 * 本阶段：production WRITE execution = 0。状态机最多走到 LEASED / ELIGIBLE。
 */
"use strict";
const crypto = require("node:crypto");
const { RISK_CLASS } = require("./tool-domain.cjs");

/** effectClass 与 riskClass 一一对应；READ_ONLY 不算 side effect，继续走 D4-03B。 */
const EFFECT_CLASS = Object.freeze({
  REVERSIBLE_WRITE: "REVERSIBLE_WRITE",
  IRREVERSIBLE_WRITE: "IRREVERSIBLE_WRITE",
  EXTERNAL_SIDE_EFFECT: "EXTERNAL_SIDE_EFFECT",
  PRIVILEGED: "PRIVILEGED",
});
const EFFECT_CLASS_ALL = Object.freeze(Object.values(EFFECT_CLASS));
/** D4-03C1 只研究 REVERSIBLE_WRITE 合同；其余一律 BLOCKED。 */
const C1_ALLOWED_EFFECT = Object.freeze([EFFECT_CLASS.REVERSIBLE_WRITE]);

const CALL_STATUS = Object.freeze({
  PLANNED: "PLANNED",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  APPROVED: "APPROVED",
  LEASED: "LEASED",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  BLOCKED: "BLOCKED",
  UNKNOWN_EFFECT: "UNKNOWN_EFFECT",
});
const CALL_STATUS_ALL = Object.freeze(Object.values(CALL_STATUS));
const CALL_TERMINAL = Object.freeze([CALL_STATUS.SUCCEEDED, CALL_STATUS.FAILED, CALL_STATUS.CANCELLED]);
/** C1 允许出现的状态上限：绝不 RUNNING/SUCCEEDED（真实写发生在 C2）。 */
const C1_MAX_STATUS = Object.freeze([CALL_STATUS.PLANNED, CALL_STATUS.AWAITING_APPROVAL, CALL_STATUS.APPROVED, CALL_STATUS.LEASED, CALL_STATUS.BLOCKED]);

const APPROVAL_DECISION = Object.freeze({ APPROVED: "APPROVED", DENIED: "DENIED", REVOKED: "REVOKED", EXPIRED: "EXPIRED" });
const APPROVAL_DECISION_ALL = Object.freeze(Object.values(APPROVAL_DECISION));

const LEASE_STATUS = Object.freeze({ ACTIVE: "ACTIVE", RELEASED: "RELEASED", EXPIRED: "EXPIRED", REVOKED: "REVOKED" });
const LEASE_STATUS_ALL = Object.freeze(Object.values(LEASE_STATUS));

const ELIGIBILITY = Object.freeze({
  ELIGIBLE: "ELIGIBLE",
  DENIED: "DENIED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  LEASE_REQUIRED: "LEASE_REQUIRED",
  STALE: "STALE",
  BLOCKED: "BLOCKED",
});
const ELIGIBILITY_ALL = Object.freeze(Object.values(ELIGIBILITY));

const SIDE_EFFECT_ERROR = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TASK_FORBIDDEN: "TASK_FORBIDDEN",
  TASK_CANCELLED: "TASK_CANCELLED",
  TASK_NOT_RUNNING: "SIDE_EFFECT_TASK_NOT_RUNNING",
  APP_DISABLED: "SIDE_EFFECT_APP_DISABLED",
  STEP_NOT_RUNNING: "SIDE_EFFECT_STEP_NOT_RUNNING",
  STALE_RUN: "SIDE_EFFECT_STALE_RUN",
  TOOL_NOT_FOUND: "SIDE_EFFECT_TOOL_NOT_FOUND",
  TOOL_DISABLED: "SIDE_EFFECT_TOOL_DISABLED",
  TOOL_VERSION_CHANGED: "SIDE_EFFECT_TOOL_VERSION_CHANGED",
  EFFECT_CLASS_BLOCKED: "SIDE_EFFECT_EFFECT_CLASS_BLOCKED",
  VERIFICATION_UNAVAILABLE: "SIDE_EFFECT_VERIFICATION_UNAVAILABLE",
  NO_PLAN: "SIDE_EFFECT_NO_PLAN",
  PLAN_STALE: "SIDE_EFFECT_PLAN_STALE",
  PRECONDITION_CHANGED: "SIDE_EFFECT_PRECONDITION_CHANGED",
  AUTHORIZATION_REVOKED: "SIDE_EFFECT_AUTHORIZATION_REVOKED",
  APPROVAL_REQUIRED: "SIDE_EFFECT_APPROVAL_REQUIRED",
  APPROVAL_FORBIDDEN: "SIDE_EFFECT_APPROVAL_FORBIDDEN",
  APPROVAL_DENIED: "SIDE_EFFECT_APPROVAL_DENIED",
  APPROVAL_REVOKED: "SIDE_EFFECT_APPROVAL_REVOKED",
  APPROVAL_EXPIRED: "SIDE_EFFECT_APPROVAL_EXPIRED",
  LEASE_REQUIRED: "SIDE_EFFECT_LEASE_REQUIRED",
  LEASE_CONFLICT: "SIDE_EFFECT_LEASE_CONFLICT",
  LEASE_EXPIRED: "SIDE_EFFECT_LEASE_EXPIRED",
  LEASE_NOT_HELD: "SIDE_EFFECT_LEASE_NOT_HELD",
  CALL_NOT_FOUND: "SIDE_EFFECT_CALL_NOT_FOUND",
  CALL_STATE: "SIDE_EFFECT_CALL_STATE",
  IDEMPOTENCY_CONFLICT: "SIDE_EFFECT_IDEMPOTENCY_CONFLICT",
  IDEMPOTENCY_UNSUPPORTED: "SIDE_EFFECT_IDEMPOTENCY_UNSUPPORTED",
  WRITE_EXECUTION_DISABLED: "WRITE_EXECUTION_DISABLED",
  RECOVERY_REQUIRED: "SIDE_EFFECT_RECOVERY_REQUIRED",
  VERIFICATION_NOT_AVAILABLE: "SIDE_EFFECT_VERIFICATION_NOT_AVAILABLE",
  UNKNOWN_EFFECT: "SIDE_EFFECT_UNKNOWN_EFFECT",
});

/** 产品合同冻结 TTL：Approval 默认 10 分钟；Lease 默认 60 秒。都有限期，绝不永久。 */
const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LEASE_TTL_MS = 60 * 1000;

const CALL_TRANSITIONS = Object.freeze({
  PLANNED: Object.freeze([CALL_STATUS.AWAITING_APPROVAL, CALL_STATUS.APPROVED, CALL_STATUS.BLOCKED, CALL_STATUS.CANCELLED, CALL_STATUS.FAILED]),
  AWAITING_APPROVAL: Object.freeze([CALL_STATUS.APPROVED, CALL_STATUS.BLOCKED, CALL_STATUS.CANCELLED, CALL_STATUS.FAILED]),
  APPROVED: Object.freeze([CALL_STATUS.LEASED, CALL_STATUS.BLOCKED, CALL_STATUS.CANCELLED, CALL_STATUS.FAILED]),
  LEASED: Object.freeze([CALL_STATUS.LEASED, CALL_STATUS.RUNNING, CALL_STATUS.BLOCKED, CALL_STATUS.CANCELLED, CALL_STATUS.FAILED]),
  RUNNING: Object.freeze([CALL_STATUS.SUCCEEDED, CALL_STATUS.FAILED, CALL_STATUS.CANCELLED, CALL_STATUS.UNKNOWN_EFFECT, CALL_STATUS.BLOCKED]),
  SUCCEEDED: Object.freeze([]),
  FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  BLOCKED: Object.freeze([CALL_STATUS.CANCELLED]),
  UNKNOWN_EFFECT: Object.freeze([CALL_STATUS.SUCCEEDED, CALL_STATUS.FAILED, CALL_STATUS.BLOCKED]),
});

function effectClassForRisk(riskClass) {
  switch (String(riskClass)) {
    case RISK_CLASS.REVERSIBLE_WRITE: return EFFECT_CLASS.REVERSIBLE_WRITE;
    case RISK_CLASS.IRREVERSIBLE_WRITE: return EFFECT_CLASS.IRREVERSIBLE_WRITE;
    case RISK_CLASS.EXTERNAL_SIDE_EFFECT: return EFFECT_CLASS.EXTERNAL_SIDE_EFFECT;
    case RISK_CLASS.PRIVILEGED: return EFFECT_CLASS.PRIVILEGED;
    default: return null;
  }
}
function isC1EffectClass(effectClass) { return C1_ALLOWED_EFFECT.includes(String(effectClass)); }
function isTerminalCall(status) { return CALL_TERMINAL.includes(String(status)); }
function canTransitionCall(from, to) {
  const allowed = CALL_TRANSITIONS[String(from)];
  return !!allowed && allowed.includes(String(to));
}

function kanon(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(kanon).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + kanon(value[k])).join(",") + "}";
}
function sha256(text) { return crypto.createHash("sha256").update(String(text)).digest("hex"); }
function fingerprint(value) { return sha256(kanon(value)); }

/** SideEffectPlan hash：plan 改 → approval 失效。 */
function planHashOf(plan) {
  return fingerprint({
    callId: plan && plan.callId ? plan.callId : null,
    toolId: plan && plan.toolId ? plan.toolId : null,
    toolVersion: plan && plan.toolVersion != null ? Number(plan.toolVersion) : null,
    argumentsHash: plan && plan.argumentsHash ? plan.argumentsHash : null,
    riskClass: plan && plan.riskClass ? plan.riskClass : null,
    requiresApproval: !!(plan && plan.requiresApproval),
    targets: (plan && plan.targets) || [],
    preconditions: (plan && plan.preconditions) || {},
    expectedEffects: (plan && plan.expectedEffects) || [],
  });
}

/** OpenArc 生成的 idempotency binding：callId + tool + version + argsHash + target refs。 */
function idempotencyKeyOf({ callId, toolId, toolVersion, argumentsHash, targetRefs = [] }) {
  return "idem_" + sha256(JSON.stringify([String(callId || ""), String(toolId || ""), Number(toolVersion) || 0, String(argumentsHash || ""), [...targetRefs].map(String).sort()])).slice(0, 40);
}

/**
 * 纯 Execution Eligibility：调用方把 trusted 快照传入，本函数只做判定，绝不 I/O。
 * 任一 gate 失败立即返回；status 语义见 ELIGIBILITY。
 */
function evaluateExecutionEligibility(snapshot = {}) {
  const checks = [];
  const fail = (status, reasonCode) => { checks.push({ gate: checks.length + 1, status, reasonCode }); return { status, reasonCode, checks }; };
  const pass = (gate) => { checks.push({ gate: checks.length + 1, status: "PASS", reasonCode: null, name: gate }); };
  const s = snapshot || {};
  const call = s.call;
  const now = Number(s.now || 0);

  if (!call) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.CALL_NOT_FOUND);
  if (!isC1EffectClass(call.effect_class)) return fail(ELIGIBILITY.BLOCKED, SIDE_EFFECT_ERROR.EFFECT_CLASS_BLOCKED);
  if (![CALL_STATUS.APPROVED, CALL_STATUS.LEASED, CALL_STATUS.RUNNING].includes(String(call.status))) return fail(ELIGIBILITY.BLOCKED, SIDE_EFFECT_ERROR.CALL_STATE);
  pass("call");

  const task = s.task;
  if (!task) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.TASK_NOT_FOUND);
  if (task.cancel_requested || String(task.status) === "CANCELLED") return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.TASK_CANCELLED);
  if (String(task.status) !== "RUNNING") return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.TASK_NOT_RUNNING);
  const actor = s.actor;
  if (!actor || !actor.ok) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED);
  if (task.user_id !== actor.user.id) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.TASK_FORBIDDEN);
  if (String(task.app_id) !== String(s.appId)) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.TASK_FORBIDDEN);
  if (!s.app || String(s.app.status).toLowerCase() !== "enabled") return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.APP_DISABLED);
  pass("task/session/app");

  const step = s.step;
  if (!step || step.task_id !== task.task_id || String(step.status) !== "RUNNING") return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.STEP_NOT_RUNNING);
  if (!s.runId || !s.latestRunId || s.runId !== s.latestRunId) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.STALE_RUN);
  pass("step/run");

  const tool = s.tool;
  if (!tool || !tool.ok) {
    if (tool && tool.error === "SIDE_EFFECT_TOOL_VERSION_CHANGED") return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.TOOL_VERSION_CHANGED);
    if (tool && tool.error === "TOOL_DISABLED") return fail(ELIGIBILITY.BLOCKED, SIDE_EFFECT_ERROR.TOOL_DISABLED);
    return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.TOOL_NOT_FOUND);
  }
  const contract = tool.contract;
  if (effectClassForRisk(contract.riskClass) !== String(call.effect_class)) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.TOOL_VERSION_CHANGED);
  if (Number(contract.version) !== Number(call.tool_version)) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.TOOL_VERSION_CHANGED);
  if (String(contract.toolId) !== String(call.tool_id)) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.TOOL_VERSION_CHANGED);
  if (!contract.verificationStrategy) return fail(ELIGIBILITY.BLOCKED, SIDE_EFFECT_ERROR.VERIFICATION_UNAVAILABLE);
  pass("tool contract");

  const authz = s.authorization;
  if (!authz || !authz.ok) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED);
  pass("reauthorization");

  if (s.planHash && call.plan_hash && s.planHash !== call.plan_hash) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.PLAN_STALE);
  if (s.argumentsHash && call.arguments_hash && s.argumentsHash !== call.arguments_hash) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.PLAN_STALE);
  // §58：execution 请求带来不同 arguments hash → plan stale。
  if (s.requestArgumentsHash && call.arguments_hash && s.requestArgumentsHash !== call.arguments_hash) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.PLAN_STALE);

  const approval = s.approval;
  if (!approval) return fail(ELIGIBILITY.APPROVAL_REQUIRED, SIDE_EFFECT_ERROR.APPROVAL_REQUIRED);
  if (String(approval.decision) === APPROVAL_DECISION.REVOKED) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.APPROVAL_REVOKED);
  if (String(approval.decision) === APPROVAL_DECISION.DENIED) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.APPROVAL_DENIED);
  if (String(approval.decision) !== APPROVAL_DECISION.APPROVED) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.APPROVAL_DENIED);
  if (approval.revoked_at != null) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.APPROVAL_REVOKED);
  if (approval.expires_at != null && now >= Number(approval.expires_at)) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.APPROVAL_EXPIRED);
  if (approval.plan_hash !== call.plan_hash) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.PLAN_STALE);
  if (approval.approved_arguments_hash != null && approval.approved_arguments_hash !== call.arguments_hash) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.PLAN_STALE);
  if (approval.approved_tool_id != null && approval.approved_tool_id !== call.tool_id) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.PLAN_STALE);
  if (approval.approved_tool_version != null && Number(approval.approved_tool_version) !== Number(call.tool_version)) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.PLAN_STALE);
  if (approval.approved_effect_class != null && approval.approved_effect_class !== call.effect_class) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.PLAN_STALE);
  pass("approval");

  const lease = s.lease;
  if (!lease) return fail(ELIGIBILITY.LEASE_REQUIRED, SIDE_EFFECT_ERROR.LEASE_REQUIRED);
  if (lease.call_id !== call.call_id) return fail(ELIGIBILITY.LEASE_REQUIRED, SIDE_EFFECT_ERROR.LEASE_REQUIRED);
  if (String(lease.status) !== LEASE_STATUS.ACTIVE) return fail(ELIGIBILITY.LEASE_REQUIRED, SIDE_EFFECT_ERROR.LEASE_REQUIRED);
  if (lease.expires_at != null && now >= Number(lease.expires_at)) return fail(ELIGIBILITY.LEASE_REQUIRED, SIDE_EFFECT_ERROR.LEASE_EXPIRED);
  if (s.holderId != null && lease.holder_id !== s.holderId) return fail(ELIGIBILITY.DENIED, SIDE_EFFECT_ERROR.LEASE_NOT_HELD);
  pass("lease");

  if (s.preconditionsOk === false) return fail(ELIGIBILITY.STALE, SIDE_EFFECT_ERROR.PRECONDITION_CHANGED);
  pass("preconditions");

  return { status: ELIGIBILITY.ELIGIBLE, reasonCode: null, checks };
}

module.exports = {
  EFFECT_CLASS, EFFECT_CLASS_ALL, C1_ALLOWED_EFFECT,
  CALL_STATUS, CALL_STATUS_ALL, CALL_TERMINAL, C1_MAX_STATUS,
  APPROVAL_DECISION, APPROVAL_DECISION_ALL, LEASE_STATUS, LEASE_STATUS_ALL,
  ELIGIBILITY, ELIGIBILITY_ALL, SIDE_EFFECT_ERROR,
  DEFAULT_APPROVAL_TTL_MS, DEFAULT_LEASE_TTL_MS,
  effectClassForRisk, isC1EffectClass, isTerminalCall, canTransitionCall,
  sha256, fingerprint, planHashOf, idempotencyKeyOf, evaluateExecutionEligibility,
};
