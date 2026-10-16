"use strict";
/**
 * 内置 dx-protocol/v2 协议。
 *
 * 源：DXSRC/protocol-engine/builtins.ts:1-2725（2725 行）。
 * 本文件保留：
 *   · 全部 15 个 provider 协议（builtins.ts:2346-2397）
 *   · 模型协议聚合（BUILTIN_MODEL_PROTOCOLS_V2 = openai-images + 其余 18 个）
 * 共享 helper 与 openai-images 协议对象见 builtins-helpers.cjs；
 * 其余 18 个模型协议见 builtins-models.cjs（源 builtins.ts:300-2720）。
 */
const { PROTOCOL_V2_SCHEMA } = require("./types.cjs");
const {
  openAiImagesProtocol,
  openAiMultipartImageFields,
  bearerProvider,
  imagePoll,
} = require("./builtins-helpers.cjs");
const { BUILTIN_MODEL_PROTOCOLS_V2_EXTRA } = require("./builtins-models.cjs");

// 源：builtins.ts:2346-2397。逐条照搬。
const BUILTIN_PROVIDER_PROTOCOLS_V2 = [
  {
    schemaVersion: PROTOCOL_V2_SCHEMA, kind: "provider", id: "ollama-http", label: "Ollama",
    summary: "本机或局域网 Ollama 的免密 OpenAI 兼容连接协议。", executor: { type: "declarative", engine: ">=1.0.0" },
    auth: { type: "none" }, headers: { Accept: "application/json" },
    models: { method: "GET", path: "/v1/models", response: { data: "$.data" } },
  },
  bearerProvider("openai-http", "OpenAI Compatible"),
  { ...bearerProvider("aliyun-bailian-http", "阿里云百炼"), summary: "阿里云百炼业务空间专属 OpenAI 兼容协议；API Key 必须与 endpoint 地域一致。" },
  { ...bearerProvider("openai-relay", "OpenAI Relay"), summary: "OpenAI 中转平台连接协议；参考图继续通过 Images Generations JSON 的 image 数组提交，不使用 multipart edits。" },
  bearerProvider("xai-http", "Grok Official API"),
  bearerProvider("minimax-http", "MiniMax Official API"),
  {
    schemaVersion: PROTOCOL_V2_SCHEMA, kind: "provider", id: "gemini-http", label: "Google Gemini Developer API",
    summary: "Google Gemini 官方 API Key 平台协议。", executor: { type: "declarative", engine: ">=1.0.0" },
    auth: { type: "google_api_key", header: "x-goog-api-key", credentialRef: "api_key" }, headers: { Accept: "application/json" },
    models: { method: "GET", path: "/v1beta/models", response: { data: "$.models" } },
  },
  bearerProvider("fhl-http", "FHL"),
  bearerProvider("agtoken-http", "AGToken"),
  bearerProvider("zkki-http", "ZKKI"),
  bearerProvider("apimart-http", "APIMart"),
  bearerProvider("modelscope-http", "ModelScope"),
  { ...bearerProvider("volcengine-http", "火山引擎方舟"), summary: "火山方舟 Bearer API Key 与 /api/v3 模型列表连接协议。", models: { method: "GET", path: "/api/v3/models", response: { data: "$.data" } } },
  {
    schemaVersion: PROTOCOL_V2_SCHEMA, kind: "provider", id: "volcengine-speech-http", label: "豆包语音",
    summary: "豆包语音新版控制台 X-Api-Key 连接协议；与火山方舟 API Key 不通用。", executor: { type: "declarative", engine: ">=1.0.0" },
    auth: { type: "api_key_header", header: "X-Api-Key", credentialRef: "api_key" }, headers: { Accept: "application/json" },
    models: { method: "GET", path: "/api/v3/models", response: { data: "$.data" } }, defaults: { timeoutMs: 300000 },
  },
  {
    schemaVersion: PROTOCOL_V2_SCHEMA, kind: "provider", id: "agnes", label: "Agnes AI",
    summary: "Agnes AI 系统声明式平台协议。", executor: { type: "declarative", engine: ">=1.0.0" },
    auth: { type: "bearer", header: "Authorization", prefix: "Bearer ", credentialRef: "api_key" },
    headers: { Accept: "application/json" },
    models: { method: "GET", path: "/v1/models", response: { data: "$.data" } },
  },
];

/**
 * 源：builtins.ts:2399-2715 的数组顺序。builtins-models.cjs 的 extras 数组把 zkki-images/agtoken-videos
 * 提前、xai/minimax 后置，与源不同；这里按源顺序重排最终导出数组，id 集合与各协议对象不变。
 */
const BUILTIN_MODEL_PROTOCOL_ORDER_V2 = [
  "openai-chat-media",
  "comfly-openai",
  "gemini-generations",
  "gpt-best-images",
  "fhl-images",
  "gemini",
  "gemini-general",
  "xai",
  "minimax",
  "agtoken-videos",
  "zkki-images",
  "apimart-images",
  "midjourney",
  "apib-images",
  "modelscope-images",
  "volcengine",
  "volcengine-speech",
  "agnes",
];

const BUILTIN_MODEL_PROTOCOLS_V2 = [
  openAiImagesProtocol,
  ...BUILTIN_MODEL_PROTOCOL_ORDER_V2.map((id) => {
    const protocol = BUILTIN_MODEL_PROTOCOLS_V2_EXTRA.find((item) => item.id === id);
    if (!protocol) throw new Error("内置 v2 模型协议缺失：" + id);
    return protocol;
  }),
];

/** 源：builtins.ts:2399-2715。登记每个内置 v2 协议的 id/kind/label 与移植状态，供 protocol/list 如实标注；
 * 模型条目顺序与 BUILTIN_MODEL_PROTOCOLS_V2 一致（源 builtins.ts:2399-2715）。 */
const BUILTIN_PROTOCOL_METADATA_V2 = [
  ...BUILTIN_PROVIDER_PROTOCOLS_V2.map((protocol) => ({ id: protocol.id, kind: "provider", label: protocol.label, ported: true, source: "protocol-engine/builtins.ts" })),
  { id: "openai-images", kind: "model", label: "OpenAI Unified", ported: true, source: "protocol-engine/builtins.ts:87" },
  { id: "openai-chat-media", kind: "model", label: "OpenAI Chat 同步返媒体", ported: true, source: "protocol-engine/builtins.ts:301" },
  { id: "comfly-openai", kind: "model", label: "OpenAI 兼容媒体", ported: true, source: "protocol-engine/builtins.ts:373" },
  { id: "gemini-generations", kind: "model", label: "Gemini Generations", ported: true, source: "protocol-engine/builtins.ts:511" },
  { id: "gpt-best-images", kind: "model", label: "GPT-Best Images", ported: true, source: "protocol-engine/builtins.ts:567" },
  { id: "fhl-images", kind: "model", label: "FHL Images", ported: true, source: "protocol-engine/builtins.ts:660" },
  { id: "gemini", kind: "model", label: "Gemini", ported: true, source: "protocol-engine/builtins.ts:701" },
  { id: "gemini-general", kind: "model", label: "Gemini 通用协议", ported: true, source: "protocol-engine/builtins.ts:866" },
  { id: "xai", kind: "model", label: "Grok 官方能力协议", ported: true, source: "protocol-engine/builtins.ts:2048" },
  { id: "minimax", kind: "model", label: "MiniMax 官方模型", ported: true, source: "protocol-engine/builtins.ts:2166" },
  { id: "agtoken-videos", kind: "model", label: "AGToken 视频", ported: true, source: "protocol-engine/builtins.ts:1081" },
  { id: "zkki-images", kind: "model", label: "ZKKI 图片与视频", ported: true, source: "protocol-engine/builtins.ts:817" },
  { id: "apimart-images", kind: "model", label: "APIMart 图片、视频与语音", ported: true, source: "protocol-engine/builtins.ts:1185" },
  { id: "midjourney", kind: "model", label: "Midjourney", ported: true, source: "protocol-engine/builtins.ts:1696" },
  { id: "apib-images", kind: "model", label: "APIB 图片", ported: true, source: "protocol-engine/builtins.ts:1764" },
  { id: "modelscope-images", kind: "model", label: "ModelScope 图片", ported: true, source: "protocol-engine/builtins.ts:1803" },
  { id: "volcengine", kind: "model", label: "火山方舟能力协议", ported: true, source: "protocol-engine/builtins.ts:1879" },
  { id: "volcengine-speech", kind: "model", label: "豆包语音模型", ported: true, source: "protocol-engine/builtins.ts:1975" },
  { id: "agnes", kind: "model", label: "Agnes", ported: true, source: "protocol-engine/builtins.ts:2389" },
];

function listBuiltinProtocolsV2() {
  return [...BUILTIN_PROVIDER_PROTOCOLS_V2, ...BUILTIN_MODEL_PROTOCOLS_V2];
}

function getBuiltinProtocolV2(kind, idValue) {
  const id = String(idValue || "").trim().toLowerCase();
  return listBuiltinProtocolsV2().find((protocol) => protocol.kind === kind && protocol.id === id) || null;
}

module.exports = {
  BUILTIN_PROVIDER_PROTOCOLS_V2,
  BUILTIN_MODEL_PROTOCOLS_V2,
  BUILTIN_PROTOCOL_METADATA_V2,
  listBuiltinProtocolsV2,
  getBuiltinProtocolV2,
  openAiImagesProtocol,
  openAiMultipartImageFields,
  bearerProvider,
  imagePoll,
};
