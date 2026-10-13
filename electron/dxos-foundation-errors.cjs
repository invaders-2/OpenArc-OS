/**
 * P1 · DX OS 地基：统一错误规约。
 *
 * 为什么要有这一层：新增的十几个域如果各自把 err.message / err.stack 直接回渲染层，
 * 主进程的绝对路径与密钥就会顺着 IPC 泄漏，而且渲染层无法稳定判别失败原因。
 * 这里给出唯一转换点：新域 IPC 出口只允许 normalizeError / toIpcResult。
 */
"use strict";

const { redactSecrets, isSecretKey, maskSecret } = require("./dxos-foundation-mask.cjs");

const DXOS_ERR_INTERNAL = "DXOS_ERR_INTERNAL";
const DXOS_ERR_INVALID_INPUT = "DXOS_ERR_INVALID_INPUT";
const DXOS_ERR_NOT_FOUND = "DXOS_ERR_NOT_FOUND";
const DXOS_ERR_CONFLICT = "DXOS_ERR_CONFLICT";
const DXOS_ERR_FORBIDDEN = "DXOS_ERR_FORBIDDEN";
const DXOS_ERR_UNAVAILABLE = "DXOS_ERR_UNAVAILABLE";
const DXOS_ERR_DEPENDENCY_MISSING = "DXOS_ERR_DEPENDENCY_MISSING";
const DXOS_ERR_TIMEOUT = "DXOS_ERR_TIMEOUT";
const DXOS_ERR_CANCELLED = "DXOS_ERR_CANCELLED";
const DXOS_ERR_CHILD_FAILED = "DXOS_ERR_CHILD_FAILED";
const DXOS_ERR_QUOTA_EXCEEDED = "DXOS_ERR_QUOTA_EXCEEDED";
const DXOS_ERR_QUOTA_LEDGER_MISSING = "DXOS_ERR_QUOTA_LEDGER_MISSING";
const DXOS_ERR_SCHEMA_TOO_NEW = "DXOS_ERR_SCHEMA_TOO_NEW";
/** 云替身类能力在"本地无对端"时的标准失败码（§6.3 关闭开关）。 */
const DXOS_ERR_UNSUPPORTED = "DXOS_ERR_UNSUPPORTED";

const DXOS_ERROR_CODES = Object.freeze([
  DXOS_ERR_INTERNAL,
  DXOS_ERR_INVALID_INPUT,
  DXOS_ERR_NOT_FOUND,
  DXOS_ERR_CONFLICT,
  DXOS_ERR_FORBIDDEN,
  DXOS_ERR_UNAVAILABLE,
  DXOS_ERR_DEPENDENCY_MISSING,
  DXOS_ERR_TIMEOUT,
  DXOS_ERR_CANCELLED,
  DXOS_ERR_CHILD_FAILED,
  DXOS_ERR_QUOTA_EXCEEDED,
  DXOS_ERR_QUOTA_LEDGER_MISSING,
  DXOS_ERR_SCHEMA_TOO_NEW,
  DXOS_ERR_UNSUPPORTED,
]);

const CAUSE_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;
/** macOS / Linux 上的绝对路径根：命中即整体替换，而不是逐个文件名字符串替换。 */
const POSIX_ABS_PATH_RE = /\/(?:Users|home|private|var|tmp|Volumes|Applications|Library|opt|etc|root|mnt)[^\n\r"';|]*/g;
const WINDOWS_ABS_PATH_RE = /[A-Za-z]:\\[^\n\r"';|]*/g;

/**
 * 把任意文本里"可能被当成凭据或本机路径"的片段替换掉。
 * 之所以连路径一起处理：IPC 报错里最容易顺带带出的就是 <userData>/... 与 skill 包路径。
 */
function redactText(value) {
  if (value == null) return "";
  return redactSecrets(String(value)).replace(POSIX_ABS_PATH_RE, "<path>").replace(WINDOWS_ABS_PATH_RE, "<path>");
}

/** 递归脱敏任意 IPC 返回值（对象/数组深度封顶，避免把大对象原样搬过桥）。 */
function redactValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value !== "object") return String(value);
  if (depth >= 6) return "<max-depth>";
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1, seen));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    // 密钥字段按字段名掩码：只靠文本形态识别会漏掉 { apiKey: "裸串" } 这种最普通的返回值。
    if (isSecretKey(key) && item != null) out[key] = maskSecret(typeof item === "object" ? JSON.stringify(item) : item);
    else out[key] = redactValue(item, depth + 1, seen);
  }
  return out;
}

function isDxosError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && DXOS_ERROR_CODES.includes(err.code);
}

function createDxosError(code, message, detail) {
  const err = new Error(redactText(message == null ? code : message));
  err.name = "DxosError";
  err.code = DXOS_ERROR_CODES.includes(code) ? code : DXOS_ERR_INTERNAL;
  if (detail !== undefined) err.detail = redactValue(detail);
  return err;
}

/**
 * 异常 → 渲染层安全结果。未知异常一律折叠成 DXOS_ERR_INTERNAL，
 * 但把原始 err.code（如 ENOENT）作为 causeCode 留在 detail 里，便于主进程侧定位。
 */
function normalizeError(err, options = {}) {
  const fallbackCode = options.fallbackCode && DXOS_ERROR_CODES.includes(options.fallbackCode) ? options.fallbackCode : DXOS_ERR_INTERNAL;
  const known = isDxosError(err);
  const code = known ? err.code : fallbackCode;
  const message = redactText(err && err.message ? err.message : err == null ? code : String(err)) || code;
  const out = { ok: false, error: code, message };
  const rawDetail = err && typeof err === "object" && "detail" in err ? err.detail : undefined;
  if (rawDetail !== undefined) out.detail = redactValue(rawDetail);
  else if (!known && err && typeof err === "object" && typeof err.code === "string" && CAUSE_CODE_RE.test(err.code)) out.detail = { causeCode: err.code };
  return out;
}

/** 渲染层出口：成功 { ok:true, value }，失败 normalizeError。 */
async function toIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactValue(value) };
  } catch (err) {
    return normalizeError(err);
  }
}

module.exports = {
  DXOS_ERR_INTERNAL,
  DXOS_ERR_INVALID_INPUT,
  DXOS_ERR_NOT_FOUND,
  DXOS_ERR_CONFLICT,
  DXOS_ERR_FORBIDDEN,
  DXOS_ERR_UNAVAILABLE,
  DXOS_ERR_DEPENDENCY_MISSING,
  DXOS_ERR_TIMEOUT,
  DXOS_ERR_CANCELLED,
  DXOS_ERR_CHILD_FAILED,
  DXOS_ERR_QUOTA_EXCEEDED,
  DXOS_ERR_QUOTA_LEDGER_MISSING,
  DXOS_ERR_SCHEMA_TOO_NEW,
  DXOS_ERR_UNSUPPORTED,
  DXOS_ERROR_CODES,
  redactText,
  redactValue,
  isDxosError,
  createDxosError,
  normalizeError,
  toIpcResult,
};
