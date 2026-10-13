/**
 * P1 · DX OS 地基：密钥掩码 / 脱敏。
 *
 * 为什么独立成模块：DX OS 对外的供应商视图天生带 apiKey / 站点凭据，
 * 而"掩码规则"必须能被单测钉死，不能散落在每个域的投影代码里各写一遍。
 * 规则是纯函数，不依赖任何运行时环境。
 */
"use strict";

/** 固定前缀 + 末 4 位：既让人认得出是同一把钥匙，又不泄漏可用部分。 */
const MASK_PREFIX = "****";
const SECRET_KEY_RE = /(secret|token|password|passwd|credential|api[_-]?key|apikey|access[_-]?key|private[_-]?key|authorization|bearer|cookie|session[_-]?key)/i;
/** 单字 key / auth 也要掩码：供应商 JSON 里这两处最常直接放裸密钥。 */
const SECRET_KEY_EXACT_RE = /^(key|auth)$/i;
const SECRET_HEADER_RE = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)$/i;

const SECRET_TEXT_PATTERNS = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{4,}/gi, "$1 <redacted>"],
  [/\b(sk-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,})\b/g, "<redacted>"],
  [/((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential|authorization)\s*[:=]\s*)(["']?)([^\s"',;]{1,})/gi, "$1$2<redacted>"],
];

function maskSecret(value) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : String(value);
  if (text.length === 0) return "";
  if (text.length <= 4) return "*".repeat(text.length);
  return MASK_PREFIX + text.slice(-4);
}

function isSecretKey(key) {
  const name = String(key);
  return SECRET_KEY_EXACT_RE.test(name) || SECRET_KEY_RE.test(name);
}

/**
 * 供应商/模型视图脱敏：保持字段名与结构不变（前端表单依赖字段），只替换敏感值。
 * 不修改入参，返回深拷贝。
 */
function maskProviderView(value, options = {}) {
  const depth = options.depth || 0;
  const seen = options.seen || new WeakSet();
  if (value == null) return value;
  if (typeof value !== "object") return value;
  if (depth >= 8) return "<max-depth>";
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => maskProviderView(item, { depth: depth + 1, seen }));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^headers$/i.test(key) && item && typeof item === "object" && !Array.isArray(item)) {
      const headers = {};
      for (const [headerName, headerValue] of Object.entries(item)) {
        headers[headerName] = SECRET_HEADER_RE.test(headerName) ? maskSecret(headerValue == null ? null : String(headerValue)) : headerValue;
      }
      out[key] = headers;
      continue;
    }
    if (isSecretKey(key)) {
      if (item == null) out[key] = item;
      else if (typeof item === "object") out[key] = maskSecret(JSON.stringify(item));
      else out[key] = maskSecret(item);
      continue;
    }
    out[key] = item && typeof item === "object" ? maskProviderView(item, { depth: depth + 1, seen }) : item;
  }
  return out;
}

/** 纯文本里的凭据形态替换（供错误规约 / 日志复用）。 */
function redactSecrets(value) {
  if (value == null) return "";
  let text = String(value);
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

module.exports = {
  MASK_PREFIX,
  maskSecret,
  isSecretKey,
  maskProviderView,
  redactSecrets,
};
