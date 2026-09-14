/**
 * D4-03A · Controlled Tool Proxy 纯领域模型（无 I/O）。
 *
 * 永久冻结：**Harness proposes. OpenArc decides. OpenArc executes. OpenArc verifies.**
 * Harness 只能提供 toolId + arguments + optional rationale；绝不能提供
 * userId / role / appId / permission / approval / resource grant / lease / risk。
 *
 * 本阶段 execute() = forbidden；任何 proposal 最终 executionStatus = NOT_EXECUTED。
 */
"use strict";
const crypto = require("node:crypto");

/** 风险分类必须带 side-effect 语义；禁止 low/medium/high 单一模糊分类。 */
const RISK_CLASS = Object.freeze({
  READ_ONLY: "READ_ONLY",
  REVERSIBLE_WRITE: "REVERSIBLE_WRITE",
  IRREVERSIBLE_WRITE: "IRREVERSIBLE_WRITE",
  EXTERNAL_SIDE_EFFECT: "EXTERNAL_SIDE_EFFECT",
  PRIVILEGED: "PRIVILEGED",
});
const RISK_CLASS_ALL = Object.freeze(Object.values(RISK_CLASS));

const SIDE_EFFECT = Object.freeze({ NONE: "NONE", READ: "READ", WRITE: "WRITE", EXTERNAL: "EXTERNAL" });
const SIDE_EFFECT_ALL = Object.freeze(Object.values(SIDE_EFFECT));

const DECISION_STATUS = Object.freeze({ ALLOWED: "ALLOWED", DENIED: "DENIED", APPROVAL_REQUIRED: "APPROVAL_REQUIRED", INVALID: "INVALID", BLOCKED: "BLOCKED" });
const DECISION_STATUS_ALL = Object.freeze(Object.values(DECISION_STATUS));

const PROPOSAL_STATUS = Object.freeze({ PROPOSED: "PROPOSED", VALIDATED: "VALIDATED", DENIED: "DENIED", APPROVAL_REQUIRED: "APPROVAL_REQUIRED", INVALID: "INVALID", BLOCKED: "BLOCKED" });
const PROPOSAL_STATUS_ALL = Object.freeze(Object.values(PROPOSAL_STATUS));

/** D4-03A：唯一允许的执行状态。 */
const EXECUTION_STATUS = Object.freeze({ NOT_EXECUTED: "NOT_EXECUTED" });

const TOOL_ERROR = Object.freeze({
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  TOOL_DISABLED: "TOOL_DISABLED",
  TOOL_VERSION_UNSUPPORTED: "TOOL_VERSION_UNSUPPORTED",
  TOOL_ARGUMENT_INVALID: "TOOL_ARGUMENT_INVALID",
  TOOL_ARGUMENT_FORBIDDEN_FIELD: "TOOL_ARGUMENT_FORBIDDEN_FIELD",
  TOOL_FORBIDDEN: "TOOL_FORBIDDEN",
  TOOL_APP_NOT_GRANTED: "TOOL_APP_NOT_GRANTED",
  TOOL_APPROVAL_REQUIRED: "TOOL_APPROVAL_REQUIRED",
  TOOL_PROPOSAL_STALE: "TOOL_PROPOSAL_STALE",
  TOOL_RESOURCE_REF_REQUIRED: "TOOL_RESOURCE_REF_REQUIRED",
  TOOL_RESOURCE_NOT_AVAILABLE: "TOOL_RESOURCE_NOT_AVAILABLE",
  TOOL_AGENT_USE_NOT_AUTHORIZED: "TOOL_AGENT_USE_NOT_AUTHORIZED",
  TOOL_EXECUTION_NOT_AVAILABLE: "TOOL_EXECUTION_NOT_AVAILABLE",
  TASK_TERMINAL: "TASK_TERMINAL",
  TASK_CANCELLED: "TASK_CANCELLED",
  // D4-03B execution
  TOOL_NOT_EXECUTABLE: "TOOL_NOT_EXECUTABLE",
  TOOL_EXECUTION_STALE: "TOOL_EXECUTION_STALE",
  TOOL_PLAN_STALE: "TOOL_PLAN_STALE",
  TOOL_TIMEOUT: "TOOL_TIMEOUT",
  TOOL_EXECUTION_FAILED: "TOOL_EXECUTION_FAILED",
  TOOL_OUTPUT_INVALID: "TOOL_OUTPUT_INVALID",
  TOOL_VERIFICATION_FAILED: "TOOL_VERIFICATION_FAILED",
  TOOL_AUTHORIZATION_REVOKED: "TOOL_AUTHORIZATION_REVOKED",
  RESOURCE_NOT_AVAILABLE: "RESOURCE_NOT_AVAILABLE",
  WRITE_EXECUTION_DISABLED: "WRITE_EXECUTION_DISABLED",
  INVALID_INPUT: "INVALID_INPUT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

/** ToolId 必须是点分小写 namespace，禁止路径 / 注入字符。 */
const TOOL_ID_RE = /^[a-z][a-z0-9]*(.[a-z][a-z0-9]*)+$/;
function isWellFormedToolId(id) { return TOOL_ID_RE.test(String(id == null ? "" : id)); }

/** 明令禁止出现在 Tool arguments 的字段（§23/§24）。 */
const FORBIDDEN_ARGUMENT_KEY = /(secret|token|authorization|api[_-]?key|credential|password|bearer|proxyBearer|absolutePath|rawPath|filesystemPath|filePath|shell|command|exec|spawn)/i;
function forbiddenArgumentKeys(obj, depth = 0, out = []) {
  if (obj == null || typeof obj !== "object" || depth > 4) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_ARGUMENT_KEY.test(k)) out.push(k);
    if (v && typeof v === "object") forbiddenArgumentKeys(v, depth + 1, out);
  }
  return out;
}

/** 绝对路径形态（POSIX / Windows drive / UNC）——Resource 类 Tool 只能用 ResourceRef。 */
const ABSOLUTE_PATH_RE = /(^\/)|(^[A-Za-z]:[\\/])|(^\\\\[^\\]+[\\/])/;
function containsAbsolutePath(value, depth = 0) {
  if (typeof value === "string") return ABSOLUTE_PATH_RE.test(value);
  if (value == null || typeof value !== "object" || depth > 4) return false;
  for (const v of Object.values(value)) if (containsAbsolutePath(v, depth + 1)) return true;
  return false;
}

function kanon(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(kanon).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + kanon(value[k])).join(",") + "}";
}
function fingerprint(value) { return crypto.createHash("sha256").update(kanon(value)).digest("hex"); }

/**
 * 安全 projection：只保留 schema 声明的字段，敏感 key 打码，字符串截断。
 * 绝不默认保存完整 raw payload。
 */
function projectArguments(args, properties = {}) {
  const out = {};
  for (const key of Object.keys(properties)) {
    if (args == null || !Object.prototype.hasOwnProperty.call(args, key)) continue;
    const v = args[key];
    if (FORBIDDEN_ARGUMENT_KEY.test(key)) { out[key] = "[REDACTED]"; continue; }
    if (typeof v === "string") out[key] = v.length > 256 ? v.slice(0, 256) + "…" : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[key] = v;
    else if (Array.isArray(v)) out[key] = v.slice(0, 32);
    else if (typeof v === "object") out[key] = Object.fromEntries(Object.entries(v).slice(0, 32));
  }
  return out;
}

function sideEffectForRisk(riskClass) {
  switch (String(riskClass)) {
    case RISK_CLASS.READ_ONLY: return SIDE_EFFECT.READ;
    case RISK_CLASS.REVERSIBLE_WRITE:
    case RISK_CLASS.IRREVERSIBLE_WRITE: return SIDE_EFFECT.WRITE;
    case RISK_CLASS.EXTERNAL_SIDE_EFFECT: return SIDE_EFFECT.EXTERNAL;
    default: return SIDE_EFFECT.NONE;
  }
}

/** D4-03A：READ_ONLY 未来可 auto-approve；WRITE/EXTERNAL/PRIVILEGED 必须显式审批。 */
function approvalRequiredForRisk(riskClass) {
  return String(riskClass) !== RISK_CLASS.READ_ONLY;
}

module.exports = {
  RISK_CLASS, RISK_CLASS_ALL, SIDE_EFFECT, SIDE_EFFECT_ALL,
  DECISION_STATUS, DECISION_STATUS_ALL, PROPOSAL_STATUS, PROPOSAL_STATUS_ALL, EXECUTION_STATUS,
  TOOL_ERROR, TOOL_ID_RE, isWellFormedToolId, FORBIDDEN_ARGUMENT_KEY, forbiddenArgumentKeys,
  ABSOLUTE_PATH_RE, containsAbsolutePath, fingerprint, projectArguments,
  sideEffectForRisk, approvalRequiredForRisk,
};
