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
  // D4-03 收口：落库投影已去敏时绝不回读执行（fail closed，见 ControlledToolProxy.#argsOf）。
  TOOL_ARGUMENTS_PROJECTION_UNAVAILABLE: "TOOL_ARGUMENTS_PROJECTION_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

/** ToolId 必须是点分小写 namespace，禁止路径 / 注入字符。 */
const TOOL_ID_RE = /^[a-z][a-z0-9]*(.[a-z][a-z0-9]*)+$/;
function isWellFormedToolId(id) { return TOOL_ID_RE.test(String(id == null ? "" : id)); }

/** 明令禁止出现在 Tool arguments 的字段（§23/§24）。 */
const FORBIDDEN_ARGUMENT_KEY = /(secret|token|authorization|api[_-]?key|credential|password|bearer|proxyBearer|absolutePath|rawPath|filesystemPath|filePath|shell|command|exec|spawn)/i;
/**
 * @param allowTopLevel Registry 合同**显式声明**的结构化参数名（contract.structuredArguments）。
 *   只豁免顶层：合同 schema（additionalProperties:false）已经把字段集合裁决完，未被声明的同名字段
 *   一律照旧拒绝；嵌套层 schema 往往更宽，denylist 必须继续兜底（同名嵌套字段仍然命中）。
 */
function forbiddenArgumentKeys(obj, allowTopLevel = null, depth = 0, out = []) {
  if (obj == null || typeof obj !== "object" || depth > 4) return out;
  const allow = depth === 0 && allowTopLevel && allowTopLevel.length ? new Set(allowTopLevel.map(String)) : null;
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_ARGUMENT_KEY.test(k) && !(allow && allow.has(k))) out.push(k);
    if (v && typeof v === "object") forbiddenArgumentKeys(v, allowTopLevel, depth + 1, out);
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

/**
 * 路径「拒绝」判据（D4-03B 冻结）：只覆盖 store root 与最敏感的系统根。
 * 收紧它会改变 Tool 门语义，故本判据永久保持窄口径；持久化去敏另用下面的判据。
 */
const UNSAFE_PATH_SRC = /(\/Users\/|\/private\/|\/var\/folders|C:\\|\\\\[^\\]+\\)/;
/** facade bridge 的整串判据：命中即整串视为 unsafe（语义与 D4-03B 逐字符等价）。 */
const UNSAFE_STRING_RE = new RegExp("(^|\\s)" + UNSAFE_PATH_SRC.source);
/**
 * 路径「落库/投影去敏」判据（比拒绝判据宽）：契约是 absolute path 绝不落库，
 * 故持久化侧必须覆盖常见系统根（macOS/Linux）、通用 POSIX 绝对路径（多段 / 裸单段 / 双斜杠形态）、盘符（含裸盘符）/UNC/file://。
 * 收紧拒绝判据会改变工具门语义，所以只扩大持久化去敏面；两者用途不同，各自有名字、绝不互相替换。
 */
const UNSAFE_PATH_TAIL_SRC = "(?:[^\\s\"'`|;,)\\]}&<>]|\\s(?=[^\\s\"'`|;,)\\]}&<>]*[\\\\/]))*";
const UNSAFE_PATH_PERSIST_SRC = "(?:" +
  "(?<![\\w])file:\\/\\/" + UNSAFE_PATH_TAIL_SRC +
  "|\\\\\\\\[^\\\\\\s]+\\\\" + UNSAFE_PATH_TAIL_SRC +
  "|(?<![\\w])(?:[A-Za-z]:[\\\\/]" + UNSAFE_PATH_TAIL_SRC + "|[A-Z]:(?![\\\\/\\w]))" +
  "|\\/(?:Users|private|var\\/folders|tmp|Volumes|Library|Applications|etc|opt|home|root|usr|var|mnt|media|srv|dev|proc|sys)(?![A-Za-z0-9_-])" + UNSAFE_PATH_TAIL_SRC +
  "|(?<=^|[\\s\"'({=:,;\\[\\]<>])\\/(?:[\\w.@+-]+\\/)+" + UNSAFE_PATH_TAIL_SRC +
  "|(?<![\\w:/])\\/\\/[^\\s\"'\`|;,)\\]}&<>]" + UNSAFE_PATH_TAIL_SRC +
  "|(?<=^|[\\s\"'({=:,;\\[\\]<>])\\/[\\w.@+-]+(?![\\w.@+-])" +
  ")";
const UNSAFE_PATH_PERSIST_RE = new RegExp(UNSAFE_PATH_PERSIST_SRC, "g");
/** 截断残留：截断面可能把路径切成裸前缀 / 半段目录（如 `/Users`、`/dat`、`C:`）。 */
const UNSAFE_PATH_REMNANT_RE = /\/[\w.@+-]*(?:\/[\w.@+-]*)*$|(?<![\w])[A-Z]:(?![\\/\w])$/;
/** 去敏标记：落库投影中出现完整标记即视为已去敏，缓存未命中时绝不能再当执行入参（只认完整标记，零误报）。 */
const REDACTION_MARKER_RE = /\[REDACTED(?:_(?:PATH|CAPABILITY|SECRET))?\]/;
/** 截断预算不足时用来保住“已去敏”证据的兜底标记（极短，保证能塞进 256 预算）。 */
const FALLBACK_REDACTION_MARKER = "[REDACTED]";
/** 截断把标记切一半时收口；完整标记以 `]` 结尾，不会被本判据命中。 */
const PARTIAL_REDACTION_MARKER_RE = /\[REDACTED_[A-Z_]*$/;
/** capability 形态：tpx_/mpx_ 只活进程内存，绝不允许进入任何持久化投影。 */
const CAPABILITY_VALUE_RE = /mpx_[A-Za-z0-9_-]+|tpx_[A-Za-z0-9_-]+/g;
/** credential 形态：Bearer token / sk-* / key=value。 */
const SECRET_VALUE_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|apikey|token|secret|password|credential|authorization|proxy[_-]?bearer)\s*[=:]\s*(?:Bearer\s+)?[^\s"'&,;]+/gi;

const PROJECTION_MAX_STRING = 256;
const PROJECTION_MAX_ITEMS = 32;
const PROJECTION_MAX_DEPTH = 6;

/**
 * 值级去敏：命中片段就地替换（保持可读），再沿用既有的 256 字符截断。
 * 投影字符串上界是 271 而非 256：截断面把裸路径前缀换成 15 字符标记最多净增 14，再加省略号。
 * 这里刻意不 clamp 回 256 —— clamp 会切掉完整标记，破坏 R-5' 的 fail-closed 不变式。
 */
function redactArgumentString(value) {
  const s = String(value)
    .replace(UNSAFE_PATH_PERSIST_RE, "[REDACTED_PATH]")
    .replace(CAPABILITY_VALUE_RE, "[REDACTED_CAPABILITY]")
    .replace(SECRET_VALUE_RE, "[REDACTED_SECRET]");
  if (s.length <= PROJECTION_MAX_STRING) return s;
  // 截断面本身也是泄漏面：先清裸路径前缀/半段目录，再清半截占位符。
  const cut = s.slice(0, PROJECTION_MAX_STRING).replace(UNSAFE_PATH_REMNANT_RE, "[REDACTED_PATH]").replace(PARTIAL_REDACTION_MARKER_RE, "");
  if (!REDACTION_MARKER_RE.test(s) || REDACTION_MARKER_RE.test(cut)) return cut + "…";
  // 截断吃掉了完整标记：在 256 预算内补一个完整标记，绝不让已去敏值退化成“无标记”而骗过执行守卫。
  const room = PROJECTION_MAX_STRING - FALLBACK_REDACTION_MARKER.length;
  const body = cut.slice(0, room).replace(UNSAFE_PATH_REMNANT_RE, "[REDACTED_PATH]");
  return (body.length <= room ? body : body.slice(0, room)) + FALLBACK_REDACTION_MARKER + "…";
}

/** 对已投影结果做递归值级去敏：深度与条数有界，嵌套 object/array 绝不旁路。 */
function redactProjectedValue(value, depth = 0) {
  if (typeof value === "string") return redactArgumentString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return undefined;
  if (depth > PROJECTION_MAX_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, PROJECTION_MAX_ITEMS).map((item) => redactProjectedValue(item, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, PROJECTION_MAX_ITEMS)) out[k] = FORBIDDEN_ARGUMENT_KEY.test(k) ? "[REDACTED]" : redactProjectedValue(v, depth + 1);
  return out;
}

/**
 * 落库前的安全投影：在既有 projectArguments 之上补值级去敏。
 * 与执行入参彻底解耦 —— 调用方必须先把 projectArguments 的结果留作执行用，再对本函数的返回值落库。
 */
function redactProjectedArguments(projected) { return redactProjectedValue(projected, 0); }

function kanon(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(kanon).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + kanon(value[k])).join(",") + "}";
}
function fingerprint(value) { return crypto.createHash("sha256").update(kanon(value)).digest("hex"); }

/**
 * 安全 projection：只保留 schema 声明的字段，敏感 key 打码，字符串截断。
 * 绝不默认保存完整 raw payload。**执行入参也取自本函数**，故其 lossy 语义（字段集合 / 键名打码 / 256 截断）永久冻结；
 * 值级去敏只能由 redactProjectedArguments 在落库前追加，绝不回写执行入参。
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
  UNSAFE_STRING_RE, UNSAFE_PATH_PERSIST_RE, REDACTION_MARKER_RE, redactProjectedArguments,
  sideEffectForRisk, approvalRequiredForRisk,
};
