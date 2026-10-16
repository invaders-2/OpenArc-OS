"use strict";
/**
 * P2 · 模型与协议域纯逻辑（无 I/O）。
 *
 * 依据：
 *   · DXSRC/protocols.ts:281-2568   PROTOCOLS（29 个模型协议）
 *   · DXSRC/protocols.ts:2589-2982  PROVIDER_PROTOCOLS（实测 20 个供应商协议；
 *     源含 'cli:dreamina-canvas'，任务书写的 19 为漏计）
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
const legacyProtocols = require("./protocol-engine/legacy-protocols.cjs");
// 旧版扁平仓库（source protocols.ts:2984-3181）：自建协议在列表/详情读取时惰性装载进
// legacyProtocols.PROTOCOLS / PROVIDER_PROTOCOLS；顶层 require 只依赖 foundation，不构成循环。
const customProtocolStore = require("./protocol-engine/legacy-custom-protocol-store.cjs");

/**
 * Legacy key 与纯函数来自 electron/protocol-engine/legacy-protocols.cjs（源 protocols.ts）。
 * 模型协议内置 29 个（源 :281-2568）；供应商协议内置实测 20 个（源 :2589-2982，含 'cli:dreamina-canvas'）。
 *
 * 必须在读取时动态取键并先触发自建仓库惰性装载（X3，源 :3181）：模块加载时的 Object.keys
 * 快照会把"装载晚于本模块"的自建协议挡在 protocol/list、protocolTable() 之外。
 * ensureLoaded 自身保证不覆盖内置、不重复；返回顺序 = 内置顺序 + 自建追加顺序。
 */
function legacyModelProtocolIds() {
  customProtocolStore.ensureLoaded();
  return Object.keys(legacyProtocols.PROTOCOLS);
}

function legacyProviderProtocolIds() {
  customProtocolStore.ensureLoaded();
  return Object.keys(legacyProtocols.PROVIDER_PROTOCOLS);
}

/** Legacy 表里免 API Key 的协议，按源语义取 auth.type === 'none'。源：protocols.ts:3595 providerRequiresApiKey。 */
function legacyNoKeyProtocolIds() {
  return legacyProviderProtocolIds().filter((id) => legacyProtocols.PROVIDER_PROTOCOLS[id].auth.type === "none");
}

/** 统一调用出口命令/事件表。每条命令都走 model:command + trusted(event) 校验。 */
const PROTOCOL_COMMANDS = Object.freeze({
  "protocol/list": { risk: "read", credential: false, summary: "列出 dx-protocol/v2 协议（含执行可用性标记 available / conditional / declarative）" },
  "protocol/get": { risk: "read", credential: false, summary: "读取单个协议定义" },
  "protocol/validate": { risk: "read", credential: false, summary: "校验协议定义，返回 issues" },
  "protocol/save": { risk: "manage", credential: false, summary: "保存自定义 declarative 协议" },
  "manifest/get": { risk: "read", credential: false, summary: "能力 manifest + 参数 schema + limits" },
  "provider/call": { risk: "use", credential: true, summary: "OpenAI 兼容 chat/completions 统一出口" },
  "image/generate": { risk: "use", credential: true, summary: "图像协议族调用并落盘到 dxos/media" },
  "protocol/execute": { risk: "use", credential: true, summary: "声明式协议引擎执行（compile + workflow）" },
  // W6b · legacy 协议族统一出口（electron/protocol-engine/legacy-executor.cjs）。
  "legacy/chat": { risk: "use", credential: true, summary: "legacy 对话调用（callChat）" },
  "legacy/chatStream": { risk: "use", credential: true, summary: "legacy 流式对话（streamChat，增量走 model:event）" },
  "legacy/chatTools": { risk: "use", credential: true, summary: "legacy 原生工具调用对话（chatWithTools）" },
  "legacy/images": { risk: "use", credential: true, summary: "legacy 图像生成并落盘 dxos/media" },
  "legacy/editImages": { risk: "use", credential: true, summary: "legacy 参考图编辑并落盘 dxos/media" },
  "legacy/videos": { risk: "use", credential: true, summary: "legacy 视频生成（submit→poll）并落盘 dxos/media" },
  "legacy/audio": { risk: "use", credential: true, summary: "legacy 语音合成/转写/音乐生成（intent 区分）并落盘 dxos/media" },
  "legacy/catalog": { risk: "read", credential: true, summary: "拉取站点模型目录（fetchModelCatalog）" },
  "legacy/describeImage": { risk: "use", credential: true, summary: "legacy 图片理解（视觉模型）" },
  "legacy/midjourney": { risk: "use", credential: true, summary: "legacy Midjourney 提交/查询/操作/局部重绘" },
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

/**
 * 执行可用性（D4 / B7e2）：ported 只表示「定义已移植」，不代表执行分支可直接调用。
 * execution 三值：
 *   available    legacy 分支自身完整实现，可直接执行；
 *   conditional  执行依赖 legacy 执行器端口注入（electron/legacy-executor-ports.cjs）；端口已注入即可执行，
 *                未注入仍返回 LEGACY_DEPENDENCY_UNAVAILABLE，unavailableReason 写明可执行前提；
 *   unavailable  确实未实现（只登记了端口，没有内置实现，需调用方显式注入）。
 * 其余 legacy 条目按可用标注；v2 条目为声明式引擎，execution="declarative"。
 */
const LEGACY_CONDITIONAL_EXECUTION = Object.freeze({
  "cli:jimeng": "需安装即梦（dreamina）CLI 并由主进程注入 cliJimeng 端口（electron/legacy-cli-ports.cjs）；未注入时端口回 LEGACY_DEPENDENCY_UNAVAILABLE",
  "cli:codex": "需安装 OpenAI Codex CLI 并由主进程注入 cliCodex 端口（electron/legacy-cli-ports.cjs）；未注入时端口回 LEGACY_DEPENDENCY_UNAVAILABLE",
  "cli:gemini": "需安装 Gemini / Antigravity CLI 并由主进程注入 cliGemini 端口（electron/legacy-cli-ports.cjs）；未注入时端口回 LEGACY_DEPENDENCY_UNAVAILABLE",
  // B7e3：四类执行分支（对话 / 图片生成 / 视频生成 / 图片编辑）都已由插件端口提供，不再是"确实未实现"。
  runninghub: "需启用 runninghub 插件并配置凭据（B7e2/B7e3 可选插件）；对话 / 图片 / 视频 / 图片编辑四类 legacy 分支均由插件端口提供，插件关闭 / 未注入端口时回 LEGACY_DEPENDENCY_UNAVAILABLE",
  modelscope: "需启用 modelscope 插件并配置凭据（B7e2 可选插件）；插件关闭 / 未注入端口时回 LEGACY_DEPENDENCY_UNAVAILABLE",
  // agnes 的 legacy 行被 v2 同名声明遮蔽（不动既有去重契约）；B7e3 端口见 electron/plugin-agnes.cjs，
  // 与 runninghub / modelscope 同语义：插件端口已实现，只差"启用 + 配置 Key"。
  agnes: "需启用 agnes 插件并配置 Key（B7e3 可选插件，electron/plugin-agnes.cjs）；未启用时端口回 LEGACY_DEPENDENCY_UNAVAILABLE",
});

/** 当前没有「确实未实现」的 legacy 条目；保留该表，后续批次按同一规约登记。 */
const LEGACY_UNAVAILABLE_EXECUTION = Object.freeze({});

function legacyExecution(id) {
  const conditionalReason = LEGACY_CONDITIONAL_EXECUTION[id];
  if (conditionalReason) return { execution: "conditional", unavailableReason: conditionalReason };
  const unavailableReason = LEGACY_UNAVAILABLE_EXECUTION[id];
  return unavailableReason ? { execution: "unavailable", unavailableReason } : { execution: "available" };
}

/** legacy 协议条目（供应商 + 模型，既有顺序），统一带来源、移植状态与执行可用性。 */
function legacyProtocolEntries(kind) {
  const legacyModel = legacyModelProtocolIds().map((id) => ({ id, kind: "model", engine: "legacy", ported: true, source: "protocols.ts:281-2568", ...legacyExecution(id) }));
  const legacyProvider = legacyProviderProtocolIds().map((id) => ({ id, kind: "provider", engine: "legacy", ported: true, source: "protocols.ts:2589-2982", ...legacyExecution(id) }));
  const all = [...legacyProvider, ...legacyModel];
  return kind ? all.filter((entry) => entry.kind === kind) : all;
}

/** v2 内置协议的 kind:id 键集，用于判定 legacy 同名分支是否被遮蔽。 */
const V2_PROTOCOL_KEYS = new Set(BUILTIN_PROTOCOL_METADATA_V2.map((entry) => entry.kind + ":" + entry.id));

/** 被 v2 同名定义遮蔽、执行链并非「直接可用」的 legacy 分支：protocolTable() 按既有规则去重后不再出现，
 * 单独列出以免「该 legacy 路径不是直接可执行」的事实被 v2 同名定义掩盖（如 agnes 同时有 v2 声明式定义
 * 与需插件端口才可执行的 legacy 执行器）。conditional 与 unavailable 都属此列，available 不列。
 * 同一个 id 的 model/provider 分支都被遮蔽时归并为一条（model 优先）。 */
function shadowedLegacyProtocols(kind) {
  const byId = new Map();
  for (const entry of legacyProtocolEntries(kind)) {
    if (entry.execution === "available" || !V2_PROTOCOL_KEYS.has(entry.kind + ":" + entry.id)) continue;
    const current = byId.get(entry.id);
    if (!current || (current.kind !== "model" && entry.kind === "model")) byId.set(entry.id, entry);
  }
  return [...byId.values()].map((entry) => ({ id: entry.id, kind: entry.kind, execution: entry.execution, unavailableReason: entry.unavailableReason }));
}

/** 协议表：legacy + dx-protocol/v2 内置，统一带来源、移植状态与执行可用性。
 * 同名同 kind 时 v2 定义优先（既有去重规则）；被遮蔽的 legacy 分支见 shadowedLegacyProtocols()。 */
function protocolTable(kind) {
  const v2 = BUILTIN_PROTOCOL_METADATA_V2.map((entry) => ({ ...entry, engine: "v2", execution: "declarative" }));
  const all = [...v2, ...legacyProtocolEntries(kind)];
  const filtered = kind ? all.filter((entry) => entry.kind === kind) : all;
  const seen = new Set();
  return filtered.filter((entry) => { const key = entry.kind + ":" + entry.id; if (seen.has(key)) return false; seen.add(key); return true; });
}

function providerRequiresApiKey(protocolId) {
  const id = String(protocolId || "").trim().toLowerCase();
  // 保留既有 cli:* 短路语义；其余复用 legacy-protocols.cjs 的 auth.type 判定。
  if (id.startsWith("cli:")) return false;
  return legacyProtocols.providerRequiresApiKey(id);
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
  PROTOCOL_COMMANDS, PROTOCOL_EVENTS, RISK_LEVELS,
  commandRisk, commandRequiresCredential, maskSecret, toPublicProvider,
  protocolTable, shadowedLegacyProtocols, providerRequiresApiKey,
  buildChatRequest, buildImageRequest, parseChatResponse, parseImageResponse, normalizeProtocolError,
};

// 派生键集改为 getter：模块加载时不再是固定快照，读取时反映当前 legacy 表（含已装载的自建协议）。
Object.defineProperties(module.exports, {
  LEGACY_MODEL_PROTOCOLS: { enumerable: true, get: legacyModelProtocolIds },
  LEGACY_PROVIDER_PROTOCOLS: { enumerable: true, get: legacyProviderProtocolIds },
  LEGACY_NO_KEY_PROTOCOLS: { enumerable: true, get: legacyNoKeyProtocolIds },
});
