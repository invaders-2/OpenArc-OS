/**
 * D4-01 · Model Service 纯领域模型（无 I/O）。
 * Endpoint 策略 / SSRF / Capability / 参数白名单 / 错误归一化 / secret 脱敏。
 */
"use strict";

const ENDPOINT_SCOPE = Object.freeze({ REMOTE_HTTPS: "REMOTE_HTTPS", LOCALHOST: "LOCALHOST", LAN_EXPLICIT: "LAN_EXPLICIT" });
const CAPABILITIES = Object.freeze(["chat", "tool-calling", "vision-input", "image-generation", "video-generation", "embedding"]);
const MODEL_ACTIONS = Object.freeze({ VIEW: "model.view", USE: "model.use", MANAGE: "model.manage", TEST: "model.test" });
const MODEL_ACTIONS_ALL = Object.freeze(Object.values(MODEL_ACTIONS));
const ERROR_CODE = Object.freeze({
  AUTH_FAILED: "AUTH_FAILED", RATE_LIMITED: "RATE_LIMITED", MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE", MODEL_TIMEOUT: "MODEL_TIMEOUT",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE", PROVIDER_PROTOCOL_ERROR: "PROVIDER_PROTOCOL_ERROR",
  CANCELLED: "CANCELLED", PARTIAL_RESPONSE: "PARTIAL_RESPONSE", CREDENTIAL_UNAVAILABLE: "CREDENTIAL_UNAVAILABLE",
  CREDENTIAL_MISSING: "CREDENTIAL_MISSING", CREDENTIAL_STORE_UNAVAILABLE: "CREDENTIAL_STORE_UNAVAILABLE",
  ENDPOINT_BLOCKED: "ENDPOINT_BLOCKED", MODEL_CONFIG_UNAVAILABLE: "MODEL_CONFIG_UNAVAILABLE",
  PROXY_UNAUTHORIZED: "PROXY_UNAUTHORIZED", INVALID_INPUT: "INVALID_INPUT",
});

const BLOCKED_PROTOCOLS = new Set(["file:", "ftp:", "gopher:", "unix:", "data:", "javascript:"]);
const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata", "fd00:ec2::254"]);
const LINK_LOCAL = /^169\.254\./;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isLocalhostHost(h) { return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]"; }

/** Endpoint 校验 + scope 判定。危险协议 / metadata / URL 内凭据 / 明文远程一律拒绝。 */
function validateEndpoint(rawUrl, { allowLan = false } = {}) {
  let url;
  try { url = new URL(String(rawUrl || "")); } catch { return { ok: false, error: ERROR_CODE.ENDPOINT_BLOCKED, reason: "invalid-url" }; }
  if (BLOCKED_PROTOCOLS.has(url.protocol)) return { ok: false, error: ERROR_CODE.ENDPOINT_BLOCKED, reason: "protocol:" + url.protocol };
  if (url.username || url.password) return { ok: false, error: ERROR_CODE.ENDPOINT_BLOCKED, reason: "url-credentials" };
  const host = url.hostname.toLowerCase();
  if (url.search && /(api[_-]?key|token|secret|password)=/i.test(url.search)) return { ok: false, error: ERROR_CODE.ENDPOINT_BLOCKED, reason: "secret-in-query" };
  if (METADATA_HOSTS.has(host) || LINK_LOCAL.test(host)) return { ok: false, error: ERROR_CODE.ENDPOINT_BLOCKED, reason: "metadata-endpoint" };
  if (isLocalhostHost(host)) {
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: ERROR_CODE.ENDPOINT_BLOCKED, reason: "localhost-protocol" };
    return { ok: true, scope: ENDPOINT_SCOPE.LOCALHOST, origin: url.origin, url: url.toString() };
  }
  const isPrivate = PRIVATE_V4.test(host);
  if (isPrivate) {
    if (!allowLan) return { ok: false, error: ERROR_CODE.ENDPOINT_BLOCKED, reason: "lan-requires-explicit" };
    return { ok: true, scope: ENDPOINT_SCOPE.LAN_EXPLICIT, origin: url.origin, url: url.toString() };
  }
  if (url.protocol !== "https:") return { ok: false, error: ERROR_CODE.ENDPOINT_BLOCKED, reason: "remote-requires-https" };
  return { ok: true, scope: ENDPOINT_SCOPE.REMOTE_HTTPS, origin: url.origin, url: url.toString() };
}

function normalizeError({ status = 0, kind = "", network = false } = {}) {
  if (kind === "timeout") return ERROR_CODE.MODEL_TIMEOUT;
  if (kind === "abort" || kind === "cancelled") return ERROR_CODE.CANCELLED;
  if (kind === "partial") return ERROR_CODE.PARTIAL_RESPONSE;
  if (kind === "credential") return ERROR_CODE.CREDENTIAL_UNAVAILABLE;
  if (network) return ERROR_CODE.PROVIDER_UNAVAILABLE;
  if (status === 401 || status === 403) return ERROR_CODE.AUTH_FAILED;
  if (status === 404) return ERROR_CODE.MODEL_NOT_FOUND;
  if (status === 429) return ERROR_CODE.RATE_LIMITED;
  if (status >= 500) return ERROR_CODE.PROVIDER_UNAVAILABLE;
  if (status >= 400) return ERROR_CODE.PROVIDER_PROTOCOL_ERROR;
  return ERROR_CODE.PROVIDER_PROTOCOL_ERROR;
}

function redactSecrets(text, secrets = []) {
  let out = String(text == null ? "" : text);
  for (const s of secrets) {
    if (!s || String(s).length < 4) continue;
    out = out.split(String(s)).join("[REDACTED]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]");
  out = out.replace(/sk-[A-Za-z0-9]{8,}/g, "[REDACTED]");
  return out;
}

const PARAM_ALLOWLIST = new Set(["temperature", "top_p", "max_tokens", "max_completion_tokens", "stop", "presence_penalty", "frequency_penalty", "seed", "response_format", "tools", "tool_choice", "stream", "parallel_tool_calls"]);
function sanitizeParams(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) if (PARAM_ALLOWLIST.has(k)) out[k] = v;
  return out;
}

function validateCapabilities(list = []) {
  const out = [];
  for (const c of list) { const v = String(c); if (CAPABILITIES.includes(v) && !out.includes(v)) out.push(v); }
  return out;
}

function capabilityAllowed(verified = [], requested) { return Array.isArray(verified) && verified.includes(String(requested)); }

/** 解析 App Grant 上的 model 动作（model.* namespace；不复用 resource 动作过滤）。 */
function modelGrantActions(grant) {
  if (!grant) return [];
  const raw = grant.actions;
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else { try { arr = JSON.parse(raw || "[]"); } catch { arr = []; } }
  return Array.isArray(arr) ? arr.map(String).filter((a) => MODEL_ACTIONS_ALL.includes(a)) : [];
}

module.exports = { ENDPOINT_SCOPE, CAPABILITIES, MODEL_ACTIONS, MODEL_ACTIONS_ALL, ERROR_CODE, validateEndpoint, normalizeError, redactSecrets, PARAM_ALLOWLIST, sanitizeParams, validateCapabilities, capabilityAllowed, modelGrantActions, isLocalhostHost };
