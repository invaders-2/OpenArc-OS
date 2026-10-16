/**
 * D4-01 · Model Service 纯领域模型（无 I/O）。
 * Endpoint 策略 / SSRF / Capability / 参数白名单 / 错误归一化 / secret 脱敏。
 */
"use strict";

const ENDPOINT_SCOPE = Object.freeze({ REMOTE_HTTPS: "REMOTE_HTTPS", LOCALHOST: "LOCALHOST", LAN_EXPLICIT: "LAN_EXPLICIT", REMOTE_HTTP_EXPLICIT: "REMOTE_HTTP_EXPLICIT" });
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

/** 模型出网代理允许的协议：只放行 http / https（SOCKS 等一律拒绝，不静默降级）。 */
const PROXY_EGRESS_PROTOCOLS = new Set(["http:", "https:"]);

const BLOCKED_PROTOCOLS = new Set(["file:", "ftp:", "gopher:", "unix:", "data:", "javascript:"]);
const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata", "fd00:ec2::254"]);
const LINK_LOCAL = /^169\.254\./;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isLocalhostHost(h) { return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]"; }

/**
 * Endpoint 校验 + scope 判定。危险协议 / metadata / URL 内凭据一律拒绝。
 * 明文远程 http 默认拒绝（remote-requires-https）；只有调用方显式传 allowInsecureHttp=true
 * （来自用户在「添加服务商」里的显式勾选，不是全局开关）才放行，并给出独立 scope REMOTE_HTTP_EXPLICIT。
 */
function validateEndpoint(rawUrl, { allowLan = false, allowInsecureHttp = false } = {}) {
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
  if (url.protocol !== "https:") {
    if (url.protocol === "http:" && allowInsecureHttp === true) {
      return { ok: true, scope: ENDPOINT_SCOPE.REMOTE_HTTP_EXPLICIT, origin: url.origin, url: url.toString(), insecureHttp: true };
    }
    return { ok: false, error: ERROR_CODE.ENDPOINT_BLOCKED, reason: "remote-requires-https", insecureHttpRequired: url.protocol === "http:" };
  }
  return { ok: true, scope: ENDPOINT_SCOPE.REMOTE_HTTPS, origin: url.origin, url: url.toString() };
}

/**
 * 持久化口径：model_providers.endpoint_scope 的 CHECK 只允许三个历史值（SCHEMA_V8_SQL）。
 * 明文放行因此单独占一列 allow_insecure_http；落库时把 REMOTE_HTTP_EXPLICIT 收敛为 REMOTE_HTTPS，
 * 「不安全」这一事实由独立列承载，读取时再恢复成独立 scope（不把明文站点伪装成 REMOTE_HTTPS）。
 */
function persistableEndpointScope(scope) { return scope === ENDPOINT_SCOPE.REMOTE_HTTP_EXPLICIT ? ENDPOINT_SCOPE.REMOTE_HTTPS : scope; }
function effectiveEndpointScope(scope, allowInsecureHttp) { return allowInsecureHttp === true ? ENDPOINT_SCOPE.REMOTE_HTTP_EXPLICIT : scope; }

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

/** 能力别名 → 规范名。显式表，便于核对与测试；只映射到 CAPABILITIES 中的 6 个规范名。 */
const CAPABILITY_ALIASES = Object.freeze({
  "llm.chat": "chat",
  "llm.chat.text": "chat",
  "llm.text": "chat",
  "llm.tool-calling": "tool-calling",
  "llm.chat.tool-calling": "tool-calling",
  "llm.chat.tools": "tool-calling",
  "tool_call": "tool-calling",
  "tool-calling": "tool-calling",
  "llm.chat.vision": "vision-input",
  "llm.vision": "vision-input",
  "vision": "vision-input",
  "vision-input": "vision-input",
  "image": "image-generation",
  "llm.image": "image-generation",
  "image.generation": "image-generation",
  "image.generate": "image-generation",
  "video": "video-generation",
  "llm.video": "video-generation",
  "video.generation": "video-generation",
  "video.generate": "video-generation",
  "llm.embedding": "embedding",
  "embeddings": "embedding",
});

/** 规范化单个 capability：命中规范名或显式别名返回规范名，未知值返回 null（调用方必须报错，不得静默成功）。 */
function normalizeCapability(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase();
  if (!raw) return null;
  if (CAPABILITIES.includes(raw)) return raw;
  const alias = CAPABILITY_ALIASES[raw];
  return alias && CAPABILITIES.includes(alias) ? alias : null;
}

/** providerOrigin 唯一口径：一律取 URL origin（无尾斜杠）。非法 URL 返回 null，由调用方报结构化错误。 */
function originOf(rawUrl) {
  try { const origin = new URL(String(rawUrl == null ? "" : rawUrl)).origin; return origin && origin !== "null" ? origin : null; } catch { return null; }
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

/**
 * 模型出网代理地址校验（纯函数）。
 * 只接受 http(s)://host:port；**必须显式端口**、不得带路径 / 查询 / fragment、不得内嵌用户名密码。
 * 任何不合法一律结构化 INVALID_INPUT + reason（调用方据此如实告知，不静默改写）。
 */
function validateProxyUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return { ok: false, error: ERROR_CODE.INVALID_INPUT, reason: "proxy-url-required" };
  let url;
  try { url = new URL(rawUrl.trim()); } catch { return { ok: false, error: ERROR_CODE.INVALID_INPUT, reason: "proxy-url-invalid" }; }
  if (!PROXY_EGRESS_PROTOCOLS.has(url.protocol)) return { ok: false, error: ERROR_CODE.INVALID_INPUT, reason: "proxy-protocol-unsupported" };
  if (url.username || url.password) return { ok: false, error: ERROR_CODE.INVALID_INPUT, reason: "proxy-credentials-unsupported" };
  if (!url.hostname) return { ok: false, error: ERROR_CODE.INVALID_INPUT, reason: "proxy-host-required" };
  if (!url.port) return { ok: false, error: ERROR_CODE.INVALID_INPUT, reason: "proxy-port-required" };
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: ERROR_CODE.INVALID_INPUT, reason: "proxy-port-invalid" };
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return { ok: false, error: ERROR_CODE.INVALID_INPUT, reason: "proxy-path-unsupported" };
  return { ok: true, url: url.origin, protocol: url.protocol, hostname: url.hostname, port };
}

/**
 * 归一化「模型出网代理」设置。
 * enabled 必须是布尔；关闭时**忽略 url**，一律落 {enabled:false, url:null}。
 */
function normalizeProxyConfig({ enabled, url } = {}) {
  if (typeof enabled !== "boolean") return { ok: false, error: ERROR_CODE.INVALID_INPUT, reason: "proxy-enabled-invalid" };
  if (!enabled) return { ok: true, enabled: false, url: null };
  const parsed = validateProxyUrl(url);
  if (!parsed.ok) return parsed;
  return { ok: true, enabled: true, url: parsed.url };
}

module.exports = { ENDPOINT_SCOPE, CAPABILITIES, MODEL_ACTIONS, MODEL_ACTIONS_ALL, ERROR_CODE, PROXY_EGRESS_PROTOCOLS, validateEndpoint, persistableEndpointScope, effectiveEndpointScope, normalizeError, redactSecrets, PARAM_ALLOWLIST, sanitizeParams, validateCapabilities, CAPABILITY_ALIASES, normalizeCapability, originOf, capabilityAllowed, modelGrantActions, isLocalhostHost, validateProxyUrl, normalizeProxyConfig };
