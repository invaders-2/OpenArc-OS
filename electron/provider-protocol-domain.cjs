"use strict";
/**
 * P2 · 模型与协议域纯逻辑（无 I/O）。
 *
 * 依据：
 *   · DXSRC/protocols.ts:281   PROTOCOLS（29 个模型协议）
 *   · DXSRC/protocols.ts:2589  PROVIDER_PROTOCOLS（19 个供应商协议）
 *   · DXSRC/store.ts:24-61     Provider/ModelEntry/PublicProvider JSON 形状与掩码
 *   · DXSRC/store.ts:287-303   maskKey / toPublic
 *   · DXSRC/protocol-engine/builtins.ts  dx-protocol/v2 内置协议
 *
 * 只做纯逻辑：协议表、统一调用出口命令/事件表、风险与掩码视图、请求构造与响应解析、
 * 错误规约。网络、磁盘、凭据在 provider-protocol-store/service.cjs。
 */
const modelDomain = require("./model-domain.cjs");
const { joinUrl } = require("./protocol-engine/compiler.cjs");
const { BUILTIN_PROTOCOL_METADATA_V2 } = require("./protocol-engine/builtins.cjs");
const adapter = require("./provider-adapter.cjs");

/** 源：DXSRC/protocols.ts:281-2569（顶层 key 共 29 个）。 */
const LEGACY_MODEL_PROTOCOLS = Object.freeze([
  "ollama", "openai", "anthropic", "gemini", "gemini-generations", "gpt-best-images", "apimart", "apimart-gemini",
  "apimart-claude", "apimart-media", "agtoken-video", "zkki-model", "midjourney", "v2-unified", "xai", "grok",
  "grok2api", "kling", "pixverse", "pika", "vidu", "wanxiang", "minimax", "suno", "agnes", "modelscope",
  "volcengine", "volcengine-speech", "runninghub",
]);

/** 源：DXSRC/protocols.ts:2589-2980（顶层 key 共 19 个）。 */
const LEGACY_PROVIDER_PROTOCOLS = Object.freeze([
  "ollama", "cli:pippit", "cli:jimeng", "cli:codex", "cli:gemini", "openai", "openai-relay", "aliyun-bailian",
  "apimart", "agtoken", "zkki", "xai", "grok2api", "agnes", "modelscope", "volcengine", "volcengine-speech",
  "minimax", "runninghub",
]);

/** Legacy 表里需要 API Key 的协议（cli:* 与 ollama 免密）。源：protocols.ts:3586 providerRequiresApiKey。 */
const LEGACY_NO_KEY_PROTOCOLS = Object.freeze(["ollama", "cli:pippit", "cli:jimeng", "cli:codex", "cli:gemini"]);

/** 统一调用出口命令/事件表。每条命令都走 model:command + trusted(event) 校验。 */
const PROTOCOL_COMMANDS = Object.freeze({
  "protocol/list": { risk: "read", credential: false, summary: "列出 dx-protocol/v2 协议（含未移植标记）" },
  "protocol/get": { risk: "read", credential: false, summary: "读取单个协议定义" },
  "protocol/validate": { risk: "read", credential: false, summary: "校验协议定义，返回 issues" },
  "protocol/save": { risk: "manage", credential: false, summary: "保存自定义 declarative 协议" },
  "manifest/get": { risk: "read", credential: false, summary: "能力 manifest + 参数 schema + limits" },
  "provider/call": { risk: "use", credential: true, summary: "OpenAI 兼容 chat/completions 统一出口" },
  "image/generate": { risk: "use", credential: true, summary: "图像协议族调用并落盘到 dxos/media" },
  "protocol/execute": { risk: "use", credential: true, summary: "声明式协议引擎执行（compile + workflow）" },
});

const PROTOCOL_EVENTS = Object.freeze({
  "protocol/event": { summary: "协议任务进度/日志（submitting/submitted/progress/completed/failed）" },
});

const RISK_LEVELS = Object.freeze({ read: 0, manage: 1, use: 2, destructive: 3 });

function commandRisk(command) {
  const entry = PROTOCOL_COMMANDS[command];
  return entry ? entry.risk : null;
}

function commandRequiresCredential(command) {
  const entry = PROTOCOL_COMMANDS[command];
  return !!(entry && entry.credential);
}

/** 掩码：源 DXSRC/store.ts:287-292（长度 ≤8 全掩码，否则头 4 + 尾 4）。 */
function maskSecret(key) {
  const value = String(key || "");
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return value.slice(0, 4) + "••••••" + value.slice(-4);
}

/** 对外安全投影：源 DXSRC/store.ts:294-303（Omit api_key/wallet_api_key，加 has_key/key_mask）。 */
function toPublicProvider(provider, { hasKey = false, hasWalletKey = false } = {}) {
  if (!provider) return null;
  const { api_key: _apiKey, wallet_api_key: _walletApiKey, ...rest } = provider;
  return {
    ...rest,
    has_key: hasKey,
    key_mask: maskSecret(hasKey ? "stored-secret-placeholder" : ""),
    has_wallet_key: hasWalletKey,
    wallet_key_mask: hasWalletKey ? maskSecret("stored-secret-placeholder") : "",
  };
}

/** 协议表：legacy + dx-protocol/v2 内置，统一带来源与移植状态。 */
function protocolTable(kind) {
  const legacyModel = LEGACY_MODEL_PROTOCOLS.map((id) => ({ id, kind: "model", engine: "legacy", ported: false, source: "protocols.ts:281" }));
  const legacyProvider = LEGACY_PROVIDER_PROTOCOLS.map((id) => ({ id, kind: "provider", engine: "legacy", ported: false, source: "protocols.ts:2589" }));
  const v2 = BUILTIN_PROTOCOL_METADATA_V2.map((entry) => ({ ...entry, engine: "v2" }));
  const all = [...v2, ...legacyProvider, ...legacyModel];
  const filtered = kind ? all.filter((entry) => entry.kind === kind) : all;
  const seen = new Set();
  return filtered.filter((entry) => { const key = entry.kind + ":" + entry.id; if (seen.has(key)) return false; seen.add(key); return true; });
}

function providerRequiresApiKey(protocolId) {
  const id = String(protocolId || "").trim().toLowerCase();
  if (id.startsWith("cli:")) return false;
  return !LEGACY_NO_KEY_PROTOCOLS.includes(id);
}

/** OpenAI 兼容 chat/completions 请求构造（非流式与流式共用）。 */
function buildChatRequest({ baseUrl, apiKey, model, messages, tools, params = {}, stream = false } = {}) {
  const url = joinUrl(String(baseUrl || ""), "/v1/chat/completions");
  const clean = modelDomain.sanitizeParams(params);
  const body = {
    model: String(model || ""),
    messages: Array.isArray(messages) ? messages : [],
    stream: !!stream,
    ...(tools ? { tools } : {}),
    ...clean,
  };
  return {
    method: "POST",
    url,
    headers: { "content-type": "application/json", authorization: "Bearer " + String(apiKey || "") },
    body,
    redirect: "error",
  };
}

/** 图像协议族（OpenAI 兼容 images/generations）请求构造。 */
function buildImageRequest({ baseUrl, apiKey, model, prompt, size = null, count = 1, params = {} } = {}) {
  const url = joinUrl(String(baseUrl || ""), "/v1/images/generations");
  const clean = modelDomain.sanitizeParams(params);
  const body = {
    model: String(model || ""),
    prompt: String(prompt || "").slice(0, 4000),
    n: Math.max(1, Math.min(4, Number(count) || 1)),
    ...(size ? { size: String(size).slice(0, 32) } : {}),
    ...clean,
  };
  return {
    method: "POST",
    url,
    headers: { "content-type": "application/json", authorization: "Bearer " + String(apiKey || "") },
    body,
    redirect: "error",
  };
}

/** 响应解析：复用 provider-adapter 的 OpenAI 映射，保持与既有 D4-01 一致。 */
function parseChatResponse(body) {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  return {
    text: message && typeof message.content === "string" ? message.content : "",
    toolCalls: message && Array.isArray(message.tool_calls) ? message.tool_calls : [],
    usage: adapter.mapUsage(body && body.usage),
    model: body && body.model ? String(body.model) : undefined,
  };
}

function parseImageResponse(body) {
  return adapter.mapImages(body);
}

/** 错误规约：HTTP 状态 / 网络 / 超时 / 取消 → model-domain 错误码。 */
function normalizeProtocolError({ status = 0, kind = "", network = false } = {}) {
  return modelDomain.normalizeError({ status, kind, network });
}

module.exports = {
  LEGACY_MODEL_PROTOCOLS, LEGACY_PROVIDER_PROTOCOLS, LEGACY_NO_KEY_PROTOCOLS,
  PROTOCOL_COMMANDS, PROTOCOL_EVENTS, RISK_LEVELS,
  commandRisk, commandRequiresCredential, maskSecret, toPublicProvider,
  protocolTable, providerRequiresApiKey,
  buildChatRequest, buildImageRequest, parseChatResponse, parseImageResponse, normalizeProtocolError,
};
