/**
 * D4-02A · Task Runtime 纯领域模型（无 I/O）。
 *
 * 永久冻结：**OpenArc = Task Authority，Harness = Reasoning Runtime**。
 * 状态机 / 错误码 / 事件类型 / attempt 上限 / tool 边界都在这一层，Harness 不能改。
 */
"use strict";

const TASK_STATUS = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  WAITING: "WAITING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  BLOCKED: "BLOCKED",
});
const TASK_STATUS_ALL = Object.freeze(Object.values(TASK_STATUS));
const TERMINAL_TASK_STATUS = Object.freeze([TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]);

const STEP_STATUS = Object.freeze({
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  BLOCKED: "BLOCKED",
});
const STEP_STATUS_ALL = Object.freeze(Object.values(STEP_STATUS));

const CALL_STATUS = Object.freeze({ STARTED: "STARTED", SUCCEEDED: "SUCCEEDED", FAILED: "FAILED", CANCELLED: "CANCELLED" });
const CALL_STATUS_ALL = Object.freeze(Object.values(CALL_STATUS));

const TASK_EVENT = Object.freeze({
  TASK_CREATED: "task.created",
  TASK_STARTED: "task.started",
  TASK_CANCEL_REQUESTED: "task.cancel_requested",
  TASK_CANCELLED: "task.cancelled",
  TASK_SUCCEEDED: "task.succeeded",
  TASK_FAILED: "task.failed",
  TASK_RECOVERY_BLOCKED: "task.recovery_blocked",
  STEP_CREATED: "step.created",
  STEP_STARTED: "step.started",
  STEP_SUCCEEDED: "step.succeeded",
  STEP_FAILED: "step.failed",
  STEP_CANCELLED: "step.cancelled",
  STEP_BLOCKED: "step.blocked",
  STEP_RECOVERY_BLOCKED: "step.recovery_blocked",
  TASK_BLOCKED: "task.blocked",
  MODEL_CALL_STARTED: "model.call.started",
  MODEL_CALL_COMPLETED: "model.call.completed",
  MODEL_CALL_FAILED: "model.call.failed",
  HARNESS_RUN_STARTED: "harness.run.started",
  HARNESS_RUN_SUCCEEDED: "harness.run.succeeded",
  HARNESS_RUN_BLOCKED: "harness.run.blocked",
  HARNESS_RUN_UNKNOWN_EFFECT: "harness.run.unknown_effect",
  HARNESS_TEXT_DELTA: "harness.text.delta",
  HARNESS_PLAN: "harness.plan",
  HARNESS_USAGE: "harness.usage",
  HARNESS_TOOL_PROPOSED: "harness.tool_proposed",
  HARNESS_PERMISSION_REQUESTED: "harness.permission_requested",
  HARNESS_PERMISSION_REJECTED: "harness.permission_rejected",
  ARTIFACT_CREATED: "artifact.created",
  VERIFICATION_COMPLETED: "verification.completed",
  TASK_WAITING: "task.waiting",
  TOOL_PROPOSED: "tool.proposed",
  TOOL_VALIDATED: "tool.validated",
  TOOL_DENIED: "tool.denied",
  TOOL_APPROVAL_REQUIRED: "tool.approval_required",
  TOOL_EXECUTION_BLOCKED: "tool.execution_blocked",
  TOOL_EXECUTION_STARTED: "tool.execution.started",
  TOOL_EXECUTION_SUCCEEDED: "tool.execution.succeeded",
  TOOL_EXECUTION_FAILED: "tool.execution.failed",
  TOOL_VERIFICATION_FAILED: "tool.verification.failed",
});
const TASK_EVENT_ALL = Object.freeze(Object.values(TASK_EVENT));

const ERROR = Object.freeze({
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TASK_FORBIDDEN: "TASK_FORBIDDEN",
  TASK_INVALID_STATE: "TASK_INVALID_STATE",
  TASK_REVISION_CONFLICT: "TASK_REVISION_CONFLICT",
  TASK_CANCELLED: "TASK_CANCELLED",
  MODEL_CONFIG_CHANGED: "MODEL_CONFIG_CHANGED",
  RECOVERY_REQUIRED: "RECOVERY_REQUIRED",
  INVALID_INPUT: "INVALID_INPUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // D4-02C orchestration-level classifications（OpenArc 自己决定，不由 Harness 自报）
  HARNESS_PROCESS_EXITED: "HARNESS_PROCESS_EXITED",
  HARNESS_TURN_TIMEOUT: "HARNESS_TURN_TIMEOUT",
  HARNESS_CANCELLED: "HARNESS_CANCELLED",
  TOOL_EXECUTION_NOT_AVAILABLE: "TOOL_EXECUTION_NOT_AVAILABLE",
  PERMISSION_NOT_AVAILABLE: "PERMISSION_NOT_AVAILABLE",
  AUTHORIZATION_REVOKED: "AUTHORIZATION_REVOKED",
  MODEL_CONFIG_CHANGED: "MODEL_CONFIG_CHANGED",
  STALE_CAPABILITY: "STALE_CAPABILITY",
  ARTIFACT_PERSIST_FAILED: "ARTIFACT_PERSIST_FAILED",
  VERIFICATION_FAILED: "VERIFICATION_FAILED",
  MCP_NOT_AVAILABLE: "MCP_NOT_AVAILABLE",
  // D4-03A Tool Gate
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  TOOL_DISABLED: "TOOL_DISABLED",
  TOOL_VERSION_UNSUPPORTED: "TOOL_VERSION_UNSUPPORTED",
  TOOL_ARGUMENT_INVALID: "TOOL_ARGUMENT_INVALID",
  TOOL_ARGUMENT_FORBIDDEN_FIELD: "TOOL_ARGUMENT_FORBIDDEN_FIELD",
  TOOL_FORBIDDEN: "TOOL_FORBIDDEN",
  TOOL_APP_NOT_GRANTED: "TOOL_APP_NOT_GRANTED",
  TOOL_AGENT_USE_NOT_AUTHORIZED: "TOOL_AGENT_USE_NOT_AUTHORIZED",
  TOOL_APPROVAL_REQUIRED: "TOOL_APPROVAL_REQUIRED",
  TOOL_PROPOSAL_STALE: "TOOL_PROPOSAL_STALE",
  TOOL_RESOURCE_REF_REQUIRED: "TOOL_RESOURCE_REF_REQUIRED",
  TOOL_EXECUTION_NOT_AVAILABLE: "TOOL_EXECUTION_NOT_AVAILABLE",
  TASK_TERMINAL: "TASK_TERMINAL",
  TOOL_EXECUTION_STALE: "TOOL_EXECUTION_STALE",
  TOOL_PLAN_STALE: "TOOL_PLAN_STALE",
  TOOL_TIMEOUT: "TOOL_TIMEOUT",
  TOOL_EXECUTION_FAILED: "TOOL_EXECUTION_FAILED",
  TOOL_OUTPUT_INVALID: "TOOL_OUTPUT_INVALID",
  TOOL_AUTHORIZATION_REVOKED: "TOOL_AUTHORIZATION_REVOKED",
  TOOL_NOT_EXECUTABLE: "TOOL_NOT_EXECUTABLE",
  RESOURCE_NOT_AVAILABLE: "RESOURCE_NOT_AVAILABLE",
  WRITE_EXECUTION_DISABLED: "WRITE_EXECUTION_DISABLED",
});

/** D4-02C 第一版编排只允许 reasoning step；绝不申请 tool/shell/browser/mcp step。 */
const ORCHESTRATION_KIND = "reasoning";

const HARNESS_RUN_STATUS = Object.freeze({
  STARTING: "STARTING",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  BLOCKED: "BLOCKED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
});
const HARNESS_RUN_STATUS_ALL = Object.freeze(Object.values(HARNESS_RUN_STATUS));
const HARNESS_RUN_TERMINAL = Object.freeze([HARNESS_RUN_STATUS.SUCCEEDED, HARNESS_RUN_STATUS.BLOCKED, HARNESS_RUN_STATUS.CANCELLED, HARNESS_RUN_STATUS.FAILED]);

const ARTIFACT_TYPE = Object.freeze({ TEXT: "text", JSON: "json" });
const ARTIFACT_TYPE_ALL = Object.freeze(Object.values(ARTIFACT_TYPE));
const VERIFICATION_TYPE = Object.freeze({ EXACT_TEXT: "EXACT_TEXT", SCHEMA_VALID: "SCHEMA_VALID" });
const VERIFICATION_STATUS = Object.freeze({ PASS: "PASS", FAIL: "FAIL" });

/**
 * ACP v1 session/update → safe TaskEvent mapping。
 *
 * 真类型来自 ACP v1（agent_message_chunk / agent_thought_chunk / tool_call /
 * tool_call_update / plan / usage_update）；Adapter 已在 #onUpdate 归一到
 * text.delta / reasoning.delta / tool.proposed / plan / usage。这里只做
 * "内层类型 → TaskEvent" 的显式映射；未列出的一律不落库。
 */
const ACP_EVENT_MAP = Object.freeze({
  "text.delta": TASK_EVENT.HARNESS_TEXT_DELTA,
  "reasoning.delta": null, // §50 reasoning privacy：不默认持久化
  "tool.proposed": TASK_EVENT.HARNESS_TOOL_PROPOSED,
  "plan": TASK_EVENT.HARNESS_PLAN,
  "usage": TASK_EVENT.HARNESS_USAGE,
});

function isKnownHarnessRunStatus(s) { return HARNESS_RUN_STATUS_ALL.includes(String(s)); }
function isTerminalHarnessRun(s) { return HARNESS_RUN_TERMINAL.includes(String(s)); }

/** 显式 transition table。未列出的边一律禁止。 */
const TASK_TRANSITIONS = Object.freeze({
  PENDING: Object.freeze([TASK_STATUS.RUNNING, TASK_STATUS.CANCELLED, TASK_STATUS.BLOCKED]),
  RUNNING: Object.freeze([TASK_STATUS.WAITING, TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.BLOCKED]),
  WAITING: Object.freeze([TASK_STATUS.RUNNING, TASK_STATUS.CANCELLED, TASK_STATUS.BLOCKED]),
  BLOCKED: Object.freeze([TASK_STATUS.RUNNING, TASK_STATUS.CANCELLED]),
  SUCCEEDED: Object.freeze([]),
  FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});
const STEP_TRANSITIONS = Object.freeze({
  PENDING: Object.freeze([STEP_STATUS.RUNNING, STEP_STATUS.CANCELLED, STEP_STATUS.BLOCKED]),
  RUNNING: Object.freeze([STEP_STATUS.SUCCEEDED, STEP_STATUS.FAILED, STEP_STATUS.CANCELLED, STEP_STATUS.BLOCKED]),
  BLOCKED: Object.freeze([STEP_STATUS.RUNNING, STEP_STATUS.CANCELLED]),
  SUCCEEDED: Object.freeze([]),
  FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

/** 第一版永久冻结：0 自动 retry，attempt 上限 1。 */
const AUTO_RETRY = 0;
const DEFAULT_MAX_ATTEMPTS = 1;
/** 本阶段不存在 side effect execution；ToolProposal 即使建表也只有 proposal。 */
const TOOL_EXECUTION = "FORBIDDEN";

function canTransitionTask(from, to) { return (TASK_TRANSITIONS[String(from)] || []).includes(String(to)); }
function canTransitionStep(from, to) { return (STEP_TRANSITIONS[String(from)] || []).includes(String(to)); }
function isTerminalTask(status) { return TERMINAL_TASK_STATUS.includes(String(status)); }
function isKnownTaskStatus(status) { return TASK_STATUS_ALL.includes(String(status)); }
function isKnownStepStatus(status) { return STEP_STATUS_ALL.includes(String(status)); }
function isKnownEventType(type) { return TASK_EVENT_ALL.includes(String(type)); }

const SENSITIVE_KEY = /(secret|token|authorization|api[_-]?key|credential|password|bearer)/i;
/** Event payload 只允许安全结构化数据：敏感 key 打码，超长截断。 */
function sanitizeEventPayload(value, depth = 0) {
  if (value == null) return null;
  if (typeof value === "string") return value.length > 512 ? value.slice(0, 512) + "…[truncated]" : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 4) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 64).map((v) => sanitizeEventPayload(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : sanitizeEventPayload(v, depth + 1);
    return out;
  }
  return String(value);
}

function safeTask(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    userId: row.user_id,
    appId: row.app_id,
    status: row.status,
    goal: row.goal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at == null ? null : row.started_at,
    completedAt: row.completed_at == null ? null : row.completed_at,
    modelConfigId: row.model_config_id || null,
    modelConfigVersion: row.model_config_version == null ? null : row.model_config_version,
    currentStepId: row.current_step_id || null,
    revision: row.revision,
    cancelRequested: !!row.cancel_requested,
    budgetSnapshot: row.budget_snapshot ? safeJson(row.budget_snapshot) : null,
    permissionSnapshotRef: row.permission_snapshot_ref || null,
  };
}
function safeStep(row) {
  if (!row) return null;
  return {
    stepId: row.step_id, taskId: row.task_id, sequence: row.sequence, kind: row.kind, status: row.status,
    input: row.input ? safeJson(row.input) : null, outputRef: row.output_ref || null,
    startedAt: row.started_at == null ? null : row.started_at, completedAt: row.completed_at == null ? null : row.completed_at,
    attempt: row.attempt, maxAttempts: row.max_attempts,
  };
}
function safeCall(row) {
  if (!row) return null;
  return {
    callId: row.call_id, taskId: row.task_id, stepId: row.step_id || null,
    modelConfigId: row.model_config_id || null, modelConfigVersion: row.model_config_version == null ? null : row.model_config_version,
    requestId: row.request_id || null, status: row.status,
    startedAt: row.started_at, completedAt: row.completed_at == null ? null : row.completed_at,
    usage: row.usage ? safeJson(row.usage) : null, providerErrorCode: row.provider_error_code || null,
  };
}
function safeEvent(row) {
  if (!row) return null;
  return { eventId: row.event_id, taskId: row.task_id, sequence: row.sequence, eventType: row.event_type, createdAt: row.created_at, safePayload: row.safe_payload ? safeJson(row.safe_payload) : null };
}
function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }

module.exports = {
  TASK_STATUS, TASK_STATUS_ALL, TERMINAL_TASK_STATUS, STEP_STATUS, STEP_STATUS_ALL,
  CALL_STATUS, CALL_STATUS_ALL, TASK_EVENT, TASK_EVENT_ALL, ERROR,
  TASK_TRANSITIONS, STEP_TRANSITIONS,
  AUTO_RETRY, DEFAULT_MAX_ATTEMPTS, TOOL_EXECUTION,
  ORCHESTRATION_KIND, HARNESS_RUN_STATUS, HARNESS_RUN_STATUS_ALL, HARNESS_RUN_TERMINAL,
  ARTIFACT_TYPE, ARTIFACT_TYPE_ALL, VERIFICATION_TYPE, VERIFICATION_STATUS, ACP_EVENT_MAP,
  canTransitionTask, canTransitionStep, isTerminalTask, isKnownTaskStatus, isKnownStepStatus, isKnownEventType,
  isKnownHarnessRunStatus, isTerminalHarnessRun,
  sanitizeEventPayload, safeTask, safeStep, safeCall, safeEvent,
};
