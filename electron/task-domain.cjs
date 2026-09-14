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
  STEP_RECOVERY_BLOCKED: "step.recovery_blocked",
  MODEL_CALL_STARTED: "model.call.started",
  MODEL_CALL_COMPLETED: "model.call.completed",
  MODEL_CALL_FAILED: "model.call.failed",
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
});

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
  canTransitionTask, canTransitionStep, isTerminalTask, isKnownTaskStatus, isKnownStepStatus, isKnownEventType,
  sanitizeEventPayload, safeTask, safeStep, safeCall, safeEvent,
};
