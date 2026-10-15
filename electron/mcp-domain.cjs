/**
 * D5-03（第一批 · 连接管理与能力发现）· MCP 纯领域模型（无 I/O）。
 *
 * 边界（与 model-domain 同一套写法）：
 *   · 传输 / 位置 / 鉴权 / 状态机 / 错误码：这里是唯一真值，service 只做编排；
 *   · Endpoint 策略不另起一套：远程 URL 直接复用 model-domain.validateEndpoint
 *     （file:// / metadata IP / URL 内嵌凭据 / 明文远程一律拒绝，scope 沿用 LOCALHOST 口径）；
 *   · 本地连接没有任意命令行：只接受白名单 serverKey，程序与参数由主进程固定映射；
 *   · 投影（projectConnection）不含 credentialRef 与任何密钥 —— 渲染层看不到凭据引用，
 *     只看到 credentialConfigured 布尔值。
 */
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const modelDomain = require("./model-domain.cjs");

/** 本批客户端实现的协议版本；服务端真实返回的版本以协商结果为准（见 classifyProtocolVersion）。 */
const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);

const TRANSPORT = Object.freeze({ STDIO: "stdio", HTTP: "http" });
const LOCATION = Object.freeze({ LOCAL_DEVICE: "LOCAL_DEVICE", REMOTE_SERVICE: "REMOTE_SERVICE" });
const AUTH_MODE = Object.freeze({ NONE: "NONE", BEARER: "BEARER" });
const STATUS = Object.freeze({ DISABLED: "DISABLED", CONNECTING: "CONNECTING", READY: "READY", ERROR: "ERROR", AUTH_REQUIRED: "AUTH_REQUIRED" });
const VISIBILITY = Object.freeze({ PERSONAL: "PERSONAL", ORGANIZATION: "ORGANIZATION" });

/** 复用 app_resource_grants（resource_type='mcp'），不建第二套 ACL。 */
const MCP_ACTIONS = Object.freeze({ VIEW: "mcp.view", USE: "mcp.use", MANAGE: "mcp.manage", TEST: "mcp.test" });
const MCP_ACTIONS_ALL = Object.freeze(Object.values(MCP_ACTIONS));

const ERROR_CODE = Object.freeze({
  MCP_CONNECTION_NOT_FOUND: "MCP_CONNECTION_NOT_FOUND",
  MCP_COMMAND_NOT_ALLOWED: "MCP_COMMAND_NOT_ALLOWED",
  MCP_INVALID_INPUT: "MCP_INVALID_INPUT",
  MCP_UNAUTHORIZED: "MCP_UNAUTHORIZED",
  MCP_LOCAL_SERVER_NOT_ALLOWED: "MCP_LOCAL_SERVER_NOT_ALLOWED",
  MCP_ENDPOINT_BLOCKED: "MCP_ENDPOINT_BLOCKED",
  MCP_CONNECTION_DISABLED: "MCP_CONNECTION_DISABLED",
  MCP_CONNECTION_BUSY: "MCP_CONNECTION_BUSY",
  MCP_PROTOCOL_ERROR: "MCP_PROTOCOL_ERROR",
  MCP_PROTOCOL_VERSION_UNSUPPORTED: "MCP_PROTOCOL_VERSION_UNSUPPORTED",
  MCP_TIMEOUT: "MCP_TIMEOUT",
  MCP_UNREACHABLE: "MCP_UNREACHABLE",
  /** 流式收口（第三批）：响应流在匹配响应之前结束/中断 —— 不重发、把决定权交回调用方。 */
  MCP_STREAM_INTERRUPTED: "MCP_STREAM_INTERRUPTED",
  /** 单个 SSE 事件超过上界：明确失败，绝不无限缓冲。 */
  MCP_STREAM_EVENT_TOO_LARGE: "MCP_STREAM_EVENT_TOO_LARGE",
  /** 服务端判定 Mcp-Session-Id 失效（404 / 明确 session 信号）：停止流与在途请求，如实上报。 */
  MCP_SESSION_EXPIRED: "MCP_SESSION_EXPIRED",
  /**
   * 本地会话结束（登出 / 锁屏 / 应用退出）收掉了连接或中止了在途握手。
   * 不是服务端故障，也不假装超时；状态回到"启用但未连接"的 DISABLED，enabled 不改写。
   */
  MCP_SESSION_ENDED: "MCP_SESSION_ENDED",
  MCP_AUTH_REQUIRED: "MCP_AUTH_REQUIRED",
  MCP_CREDENTIAL_MISSING: "MCP_CREDENTIAL_MISSING",
  MCP_CREDENTIAL_STORE_UNAVAILABLE: "MCP_CREDENTIAL_STORE_UNAVAILABLE",
  MCP_TOOL_DISCOVERY_FAILED: "MCP_TOOL_DISCOVERY_FAILED",
  MCP_TOOL_INVOCATION_NOT_ENABLED: "MCP_TOOL_INVOCATION_NOT_ENABLED",
  MCP_RECONNECT_LIMIT: "MCP_RECONNECT_LIMIT",
  MCP_STATE_INVALID: "MCP_STATE_INVALID",
  MCP_INTERNAL_ERROR: "MCP_INTERNAL_ERROR",
});

/**
 * 本地受控服务白名单（第一批只有 openarc-test-echo）。
 *
 * key → 主进程固定的程序与参数：渲染层只能给 key，给不了路径、参数或 env，
 * 因此「本地 MCP 连接」不可能退化成任意命令执行。entry 是仓库内受控文件。
 */
const LOCAL_SERVERS = Object.freeze({
  "openarc-test-echo": Object.freeze({
    serverKey: "openarc-test-echo",
    entry: path.join(__dirname, "..", "tests", "fixtures", "mcp", "echo-server.mjs"),
    args: Object.freeze(["--stdio"]),
  }),
});
const LOCAL_SERVER_KEYS = Object.freeze(Object.keys(LOCAL_SERVERS));

/** 子进程环境只给最小集合；渲染层无法追加任何变量。 */
function localServerEnv(env = process.env) {
  return { PATH: String((env && env.PATH) || "") };
}

/** 状态机：DISABLED 与 enabled=false 等价；启用即进入一次真实连接尝试。 */
const TRANSITIONS = Object.freeze({
  DISABLED: Object.freeze(["CONNECTING"]),
  CONNECTING: Object.freeze(["READY", "ERROR", "AUTH_REQUIRED", "DISABLED"]),
  READY: Object.freeze(["CONNECTING", "DISABLED", "ERROR", "AUTH_REQUIRED"]),
  ERROR: Object.freeze(["CONNECTING", "DISABLED"]),
  AUTH_REQUIRED: Object.freeze(["CONNECTING", "DISABLED"]),
});

function canTransition(from, to) {
  const allowed = TRANSITIONS[String(from || "")];
  return Array.isArray(allowed) && allowed.includes(String(to || ""));
}

/** 本地 endpoint：只认白名单 key；未知 key 明确拒绝（不是「回落到某种默认程序」）。 */
function validateLocalEndpoint(endpoint = {}) {
  const serverKey = endpoint && endpoint.serverKey != null ? String(endpoint.serverKey) : "";
  const server = LOCAL_SERVERS[serverKey];
  if (!server) return { ok: false, error: ERROR_CODE.MCP_LOCAL_SERVER_NOT_ALLOWED, detail: serverKey || null };
  return { ok: true, serverKey: server.serverKey, entry: server.entry, args: [...server.args] };
}

/**
 * 远程 endpoint：直接复用模型服务的 SSRF / 协议 / 凭据口径。
 * file://、metadata IP、URL 内嵌凭据、明文远程（非 https）都在 validateEndpoint 里被拒。
 */
function validateRemoteEndpoint(rawUrl, { allowLan = false } = {}) {
  const res = modelDomain.validateEndpoint(rawUrl, { allowLan });
  if (!res.ok) return { ok: false, error: ERROR_CODE.MCP_ENDPOINT_BLOCKED, detail: res.reason || null };
  return { ok: true, url: res.url, endpointScope: res.scope, origin: res.origin };
}

/** location + transport + endpoint 三者必须自洽；不允许「本地却给 URL」「远程却给 key」。 */
function validateEndpointFor({ location, transport, endpoint = {}, allowLan = false } = {}) {
  const loc = String(location || "");
  const tr = String(transport || "");
  if (loc === LOCATION.LOCAL_DEVICE) {
    if (tr !== TRANSPORT.STDIO) return { ok: false, error: ERROR_CODE.MCP_INVALID_INPUT, detail: "local-requires-stdio" };
    return validateLocalEndpoint(endpoint);
  }
  if (loc === LOCATION.REMOTE_SERVICE) {
    if (tr !== TRANSPORT.HTTP) return { ok: false, error: ERROR_CODE.MCP_INVALID_INPUT, detail: "remote-requires-http" };
    return validateRemoteEndpoint(endpoint && endpoint.url, { allowLan });
  }
  return { ok: false, error: ERROR_CODE.MCP_INVALID_INPUT, detail: "location" };
}

/** endpoint 记录 JSON（库里只存必要字段，不存主进程路径/参数）。 */
function encodeEndpoint({ location, transport, endpoint = {}, allowLan = false } = {}) {
  const v = validateEndpointFor({ location, transport, endpoint, allowLan });
  if (!v.ok) return v;
  if (v.serverKey) return { ok: true, json: JSON.stringify({ serverKey: v.serverKey }), origin: "mcp-local:" + v.serverKey, server: v };
  return { ok: true, json: JSON.stringify({ url: v.url, endpointScope: v.endpointScope }), origin: v.origin, server: v };
}

function parseJson(text, fallback) {
  if (text == null || text === "") return fallback;
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Y6：App 托管归属键。只落在 endpoint_json 的附加键上（不改表结构、不加列）。 */
const MANAGED_BY_APP_KEY = "managedByAppId";

/**
 * Y6：端点重写时原样携带既有归属。
 * 通用编辑路径（mcp-service.updateConnection）只重编码 serverKey / url / endpointScope；
 * 若不显式携带，endpoint_json 上的 managedByAppId 会随覆盖丢失 —— 连接变成"无主"，
 * 下一次 App 启用 / 禁用就再也找不到它（归属判定只看这个键）。
 */
function carryManagedByAppId(encoded, previousEndpointJson) {
  if (!encoded || encoded.ok !== true || typeof encoded.json !== "string") return encoded;
  const previous = parseJson(previousEndpointJson, null);
  if (!previous || typeof previous !== "object" || !previous[MANAGED_BY_APP_KEY]) return encoded;
  const next = parseJson(encoded.json, null);
  if (!next || typeof next !== "object") return encoded;
  next[MANAGED_BY_APP_KEY] = String(previous[MANAGED_BY_APP_KEY]);
  return { ...encoded, json: JSON.stringify(next) };
}

const asText = (v, max) => String(v == null ? "" : v).slice(0, max);

/**
 * 工具快照：[{name, description, inputSchemaSummary}]。
 * 只留「能力表」要展示的三项 —— 完整 inputSchema 不进记录、不回渲染层。
 */
function summarizeInputSchema(schema) {
  if (!schema || typeof schema !== "object") return "";
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const parts = [];
  for (const [key, value] of Object.entries(props)) {
    const type = value && typeof value === "object" && value.type ? String(value.type) : "any";
    parts.push(asText(key, 60) + ":" + asText(type, 20) + (required.includes(key) ? "(required)" : ""));
  }
  const head = schema.type ? "type=" + asText(schema.type, 20) : "type=object";
  const body = parts.length ? "; properties: " + parts.join(", ") : "; properties: none";
  const tail = required.length ? "; required: " + required.join(",") : "";
  return asText(head + body + tail, 240);
}

function sanitizeTool(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = asText(raw.name, 120).trim();
  if (!name) return null;
  return { name, description: asText(raw.description, 300), inputSchemaSummary: summarizeInputSchema(raw.inputSchema) };
}

/** 服务端返回的工具列表 → 有界快照（去重、去空名、上限截断）。 */
function sanitizeTools(rawList, { maxTools = 200 } = {}) {
  const out = [];
  const seen = new Set();
  let truncated = false;
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const tool = sanitizeTool(raw);
    if (!tool || seen.has(tool.name)) continue;
    if (out.length >= maxTools) { truncated = true; break; }
    seen.add(tool.name);
    out.push(tool);
  }
  return { tools: out, truncated };
}

function toolsHash(tools) {
  return crypto.createHash("sha256").update(JSON.stringify(Array.isArray(tools) ? tools : [])).digest("hex");
}

/** capabilities 归一化：只留布尔/字符串/数值叶子，避免把服务端任意大对象落库。 */
function normalizeCapabilities(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const inner = {};
      for (const [k2, v2] of Object.entries(value)) {
        if (typeof v2 === "boolean" || typeof v2 === "string" || typeof v2 === "number") inner[asText(k2, 60)] = typeof v2 === "string" ? asText(v2, 120) : v2;
      }
      out[asText(key, 60)] = inner;
    } else if (typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
      out[asText(key, 60)] = typeof value === "string" ? asText(value, 120) : value;
    }
  }
  return out;
}

function parseProtocolVersion(text) {
  const s = asText(text, 40);
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) ? s : null;
}

/** 协议版本判定：客户端记录服务端真实返回值；不支持时明确报错，不假装成功。 */
function classifyProtocolVersion(version) {
  const actual = parseProtocolVersion(version);
  if (!actual) return { ok: false, protocolVersion: null, error: ERROR_CODE.MCP_PROTOCOL_ERROR };
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(actual)) return { ok: false, protocolVersion: actual, error: ERROR_CODE.MCP_PROTOCOL_VERSION_UNSUPPORTED };
  return { ok: true, protocolVersion: actual };
}

/**
 * 传输层/协议层错误归一化。
 * JSON-RPC 错误码与 HTTP 状态各自映射到稳定 MCP_* 码；未知一律 MCP_PROTOCOL_ERROR（不猜成成功）。
 */
function normalizeError({ kind = "", status = 0, jsonrpcCode = null } = {}) {
  if (kind === "timeout") return ERROR_CODE.MCP_TIMEOUT;
  if (kind === "abort" || kind === "cancelled") return ERROR_CODE.MCP_TIMEOUT;
  if (kind === "protocol") return ERROR_CODE.MCP_PROTOCOL_ERROR;
  if (kind === "auth") return ERROR_CODE.MCP_AUTH_REQUIRED;
  if (kind === "credential") return ERROR_CODE.MCP_CREDENTIAL_MISSING;
  if (kind === "store") return ERROR_CODE.MCP_CREDENTIAL_STORE_UNAVAILABLE;
  if (kind === "spawn" || kind === "unreachable") return ERROR_CODE.MCP_UNREACHABLE;
  if (kind === "discovery") return ERROR_CODE.MCP_TOOL_DISCOVERY_FAILED;
  if (status === 401 || status === 403) return ERROR_CODE.MCP_AUTH_REQUIRED;
  if (status >= 500) return ERROR_CODE.MCP_UNREACHABLE;
  if (status >= 400) return ERROR_CODE.MCP_PROTOCOL_ERROR;
  if (typeof jsonrpcCode === "number") return ERROR_CODE.MCP_PROTOCOL_ERROR;
  return ERROR_CODE.MCP_UNREACHABLE;
}

/** 凭据相关失败按状态归类：需要重新授权 vs 一般错误。 */
function statusForError(code) {
  // 会话结束收掉连接后回到"启用但未连接"（DISABLED）：不假装故障，也不要求重新授权。
  if (code === ERROR_CODE.MCP_SESSION_ENDED) return STATUS.DISABLED;
  return code === ERROR_CODE.MCP_AUTH_REQUIRED || code === ERROR_CODE.MCP_CREDENTIAL_MISSING
    ? STATUS.AUTH_REQUIRED
    : STATUS.ERROR;
}

/** 解析 App Grant 上的 mcp 动作（mcp.* namespace；不复用 resource 动作过滤）。 */
function mcpGrantActions(grant) {
  if (!grant) return [];
  const raw = grant.actions;
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else { try { arr = JSON.parse(raw || "[]"); } catch { arr = []; } }
  return Array.isArray(arr) ? arr.map(String).filter((a) => MCP_ACTIONS_ALL.includes(a)) : [];
}

/** 安全 endpoint 投影：stdio 只暴露 serverKey（不暴露受控程序路径与参数）。 */
function projectEndpoint(endpointJson) {
  const parsed = parseJson(endpointJson, null);
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.serverKey) return { serverKey: String(parsed.serverKey) };
  return { url: String(parsed.url || ""), endpointScope: String(parsed.endpointScope || "") };
}

/**
 * 连接记录 → 渲染层投影。
 * toolsVisible=false（无权）时连 toolsHash 都不给 —— 不漏任何工具描述。
 * 任何情况下都不含 credentialRef / secret。
 */
function projectConnection(row, { toolsVisible = true } = {}) {
  if (!row) return null;
  const base = {
    connectionId: row.connection_id,
    name: row.name,
    transport: row.transport,
    location: row.location,
    endpoint: projectEndpoint(row.endpoint_json),
    authMode: row.auth_mode,
    credentialConfigured: !!row.credential_ref,
    enabled: !!row.enabled,
    status: row.status,
    lastErrorCode: row.last_error_code || null,
    protocolVersion: row.protocol_version || null,
    serverName: row.server_name || null,
    serverVersion: row.server_version || null,
    capabilities: parseJson(row.capabilities_json, {}),
    visibility: row.visibility,
    ownerUserId: row.owner_user_id || null,
    organizationId: row.organization_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastConnectedAt: row.last_connected_at == null ? null : row.last_connected_at,
  };
  if (!toolsVisible) return { ...base, tools: [], toolsHash: null, toolsHidden: true };
  return { ...base, tools: parseJson(row.tools_json, []), toolsHash: row.tools_hash || null, toolsHidden: false };
}

/** 可 patch 的字段白名单：渲染层改不了 owner/org/时间戳/能力快照。 */
const PATCHABLE = Object.freeze(["name", "authMode", "visibility", "endpoint"]);

module.exports = {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  TRANSPORT,
  LOCATION,
  AUTH_MODE,
  STATUS,
  VISIBILITY,
  MCP_ACTIONS,
  MCP_ACTIONS_ALL,
  ERROR_CODE,
  LOCAL_SERVERS,
  LOCAL_SERVER_KEYS,
  TRANSITIONS,
  PATCHABLE,
  localServerEnv,
  canTransition,
  validateLocalEndpoint,
  validateRemoteEndpoint,
  validateEndpointFor,
  encodeEndpoint,
  MANAGED_BY_APP_KEY,
  carryManagedByAppId,
  sanitizeTools,
  sanitizeTool,
  summarizeInputSchema,
  toolsHash,
  normalizeCapabilities,
  parseProtocolVersion,
  classifyProtocolVersion,
  normalizeError,
  statusForError,
  mcpGrantActions,
  projectEndpoint,
  projectConnection,
  parseJson,
  /** 脱敏只有一份实现（model-domain）；MCP 侧不复制粘贴。 */
  redactSecrets: modelDomain.redactSecrets,
};
