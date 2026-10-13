"use strict";
/**
 * 模型协议推断（DX OS server/protocolInference.ts 的 CJS 移植）。
 *
 * 源：DXSRC/server/protocolInference.ts:1-257
 *   · InferredModelType / InferredModel / ProtocolInferenceResult  protocolInference.ts:4-22
 *   · unique / hasProtocol                                          protocolInference.ts:24-30
 *   · defaultModelProtocol（每个 if 分支逐条照搬）                   protocolInference.ts:32-52
 *   · PLATFORM_PROTOCOLS / normalizePlatformProtocol                protocolInference.ts:54-61
 *   · platformProtocolFromBaseUrl（URL 特征 → 平台协议/置信度/理由） protocolInference.ts:63-82
 *   · inferByModelName（模型名关键词 → 类型/能力/协议/置信度/理由）  protocolInference.ts:84-229
 *   · inferProviderProtocols                                        protocolInference.ts:231-257
 *
 * 依赖（并行任务冻结接口，只 require 不修改）：
 *   · ./legacy-protocols.cjs   normalizeProtocol / normalizeProtocolId
 *   · ./providerIdentity.cjs   canonicalAgentProviderProtocol / isFhlProvider
 *
 * 未移植依赖：无。本模块是纯推断，不发网络请求、不落盘、不读凭据。
 * 为不阻塞 require（legacy-protocols.cjs 由并行任务落地），对 legacy 依赖采用惰性 require：
 * 仅在实际需要 normalizeProtocol/normalizeProtocolId 的分支才加载；缺失时由 Node 抛
 * MODULE_NOT_FOUND，不伪造结果。
 */
const { canonicalAgentProviderProtocol, isFhlProvider } = require("./providerIdentity.cjs");

/** 源：protocolInference.ts:4。 */
const INFERRED_MODEL_TYPES = Object.freeze(["llm", "image", "video", "audio", "other"]);

let legacyModule = null;
function legacy() {
  if (!legacyModule) legacyModule = require("./legacy-protocols.cjs");
  return legacyModule;
}

function normalizeProtocol(id, fallback = "openai") {
  return legacy().normalizeProtocol(id, fallback);
}

function normalizeProtocolId(id, fallback = "openai") {
  return legacy().normalizeProtocolId(id, fallback);
}

/** 源：protocolInference.ts:24-26。 */
function unique(items) {
  return [...new Set(items)];
}

/** 源：protocolInference.ts:28-30。 */
function hasProtocol(id) {
  return !!normalizeProtocolId(id, "");
}

/** 源：protocolInference.ts:32-52。 */
function defaultModelProtocol(providerProtocol, type) {
  if (providerProtocol === "openai-relay") return "openai-relay";
  if (providerProtocol === "aliyun-bailian") return "aliyun-bailian";
  if (providerProtocol === "fhl-http") return type === "image" ? "fhl-images" : "openai-chat";
  if (providerProtocol === "agtoken-video" || providerProtocol === "agtoken") {
    if (type === "llm") return "openai-chat";
    if (type === "image") return "openai-image";
    return "agtoken-video";
  }
  if (providerProtocol === "zkki-model" || providerProtocol === "zkki") return type === "llm" ? "openai-chat" : "zkki-model";
  if (providerProtocol === "xai") return "xai";
  if (providerProtocol === "grok2api") return "grok2api";
  if (providerProtocol === "modelscope") return "modelscope";
  if (providerProtocol === "volcengine") return "volcengine";
  if (providerProtocol === "volcengine-speech") return "volcengine-speech";
  if (providerProtocol === "agnes") return "agnes";
  if (providerProtocol === "v2-unified" && (type === "image" || type === "video")) return "v2-unified";
  if (type === "image") return "openai-image";
  if (type === "audio") return "openai-audio";
  return "openai-chat";
}

/** 源：protocolInference.ts:54。 */
const PLATFORM_PROTOCOLS = new Set(["openai", "openai-relay", "aliyun-bailian", "fhl-http", "xai", "apimart", "agtoken", "zkki", "grok2api", "agnes", "modelscope", "volcengine", "volcengine-speech", "runninghub"]);

/** 源：protocolInference.ts:56-61。 */
function normalizePlatformProtocol(protocol) {
  const raw = String(protocol || "").trim().toLowerCase();
  if (PLATFORM_PROTOCOLS.has(raw)) return raw;
  const normalized = normalizeProtocol(protocol || "openai");
  return PLATFORM_PROTOCOLS.has(normalized) ? normalized : "openai";
}

/** 源：protocolInference.ts:63-82。 */
function platformProtocolFromBaseUrl(baseUrl, fallback) {
  const url = String(baseUrl || "").toLowerCase();
  if (normalizePlatformProtocol(fallback) === "openai-relay") return { protocol: "openai-relay", confidence: 99, reason: "已选择 OpenAI 中转平台协议" };
  if (/\.maas\.aliyuncs\.com|dashscope(?:-intl|-us)?\.aliyuncs\.com/.test(url) && /compatible-mode\/v1/.test(url)) return { protocol: "aliyun-bailian", confidence: 99, reason: "Base URL 命中阿里云百炼 OpenAI 兼容端点" };
  if (isFhlProvider({ base_url: baseUrl })) return { protocol: "fhl-http", confidence: 99, reason: "Base URL 命中 FHL 图片平台" };
  if (normalizePlatformProtocol(fallback) === "xai") return { protocol: "xai", confidence: 99, reason: "已选择 Grok 官方协议" };
  if (normalizePlatformProtocol(fallback) === "grok2api") return { protocol: "grok2api", confidence: 98, reason: "已选择 Grok2API 网关协议" };
  if (/agtoken\.vip/.test(url)) return { protocol: "agtoken", confidence: 98, reason: "Base URL 命中 AGToken 视频平台" };
  if (/api\.zkki\.net/.test(url)) return { protocol: "zkki", confidence: 98, reason: "Base URL 命中 ZKKI 平台" };
  if (/api-inference\.modelscope\.(cn|ai)/.test(url)) return { protocol: "modelscope", confidence: 96, reason: "Base URL 命中 ModelScope 推理平台" };
  if (/openspeech\.bytedance\.com/.test(url)) return { protocol: "volcengine-speech", confidence: 99, reason: "Base URL 命中豆包语音服务" };
  if (/ark\.[a-z0-9-]+\.volces\.com|volcengine\.com/.test(url)) return { protocol: "volcengine", confidence: 98, reason: "Base URL 命中火山方舟平台" };
  if (/apihub\.agnes-ai\.com/.test(url)) return { protocol: "agnes", confidence: 96, reason: "Base URL 命中 Agnes AI 平台" };
  if (/api\.apimart\.ai|(^|\/)apib\.ai(?=\/|$)/.test(url)) return { protocol: "apimart", confidence: 92, reason: "Base URL 命中已知异步聚合平台" };
  if (/api\.openai\.com|\/v1($|\/)/.test(url)) return { protocol: "openai", confidence: 65, reason: "Base URL 命中 OpenAI v1 形状" };
  if (/generativelanguage\.googleapis\.com|anthropic\.com|kling|kuaishou|suno|minimax|hailuo|pixverse|pika|vidu/.test(url)) {
    return { protocol: normalizePlatformProtocol(fallback), confidence: 45, reason: "Base URL 命中厂商特征，厂商差异按模型协议处理" };
  }
  return { protocol: normalizePlatformProtocol(fallback), confidence: 35, reason: "未命中明显站点形态，沿用当前站点协议" };
}

/** 源：protocolInference.ts:84-229。 */
function inferByModelName(model, providerProtocol, baseUrl = "") {
  const s = model.toLowerCase();
  const reasons = [];
  let protocol = defaultModelProtocol(providerProtocol, "llm");
  let type = "llm";
  let caps = ["llm"];
  let confidence = 45;

  const set = (next, reason) => {
    if (next.protocol) protocol = next.protocol;
    if (next.type) type = next.type;
    if (next.caps) caps = next.caps;
    if (next.confidence) confidence = Math.max(confidence, next.confidence);
    reasons.push(reason);
  };

  if (providerProtocol === "volcengine-speech" && /seed-(?:tts|icl)-2\.0/.test(s)) {
    set({ protocol: "volcengine-speech", type: "audio", caps: ["audio"], confidence: 100 }, "模型名命中豆包语音合成或声音复刻 2.0");
  } else if (providerProtocol === "volcengine-speech" && /seed-audio-1\.0/.test(s)) {
    set({ protocol: "volcengine-speech", type: "audio", caps: ["audio"], confidence: 100 }, "模型名命中豆包音频生成 1.0");
  } else if (providerProtocol === "volcengine" && /(?:doubao-)?seedream/.test(s)) {
    set({ protocol: "volcengine", type: "image", caps: ["image"], confidence: 98 }, "模型名命中火山 Seedream 图片模型");
  } else if (providerProtocol === "volcengine" && /(?:doubao-)?seedance/.test(s)) {
    set({ protocol: "volcengine", type: "video", caps: ["video"], confidence: 98 }, "模型名命中火山 Seedance 视频模型");
  } else if (providerProtocol === "xai" && /grok-imagine-image/.test(s)) {
    set({ protocol: "xai", type: "image", caps: ["image"], confidence: 99 }, "模型名命中 Grok 官方图片模型");
  } else if (providerProtocol === "xai" && /grok-imagine-video/.test(s)) {
    set({ protocol: "xai", type: "video", caps: ["video"], confidence: 99 }, "模型名命中 Grok 官方视频模型");
  } else if (providerProtocol === "xai" && /^grok[-_.\d]/.test(s)) {
    set({ protocol: "xai", type: "llm", caps: ["llm"], confidence: 98 }, "模型名命中 Grok 官方文本模型");
  } else if (providerProtocol === "grok2api" && /grok-imagine-image/.test(s)) {
    set({ protocol: "grok2api", type: "image", caps: ["image"], confidence: 96 }, "模型名命中 Grok2API 图片模型");
  } else if (providerProtocol === "grok2api" && /grok-imagine-video/.test(s)) {
    set({ protocol: "grok2api", type: "video", caps: ["video"], confidence: 96 }, "模型名命中 Grok2API 视频模型");
  } else if (providerProtocol === "grok2api" && /grok-(voice|stt)/.test(s)) {
    set({ protocol: "grok2api", type: "audio", caps: ["audio"], confidence: 96 }, "模型名命中 Grok2API 语音模型");
  } else if (providerProtocol === "grok2api" && /^grok[-_.\d]/.test(s)) {
    set({ protocol: "grok2api", type: "llm", caps: ["llm"], confidence: 92 }, "模型名命中 Grok2API 对话模型");
  } else if (providerProtocol === "apimart" && s === "gpt-4o-mini-tts") {
    set({ protocol: "apimart", type: "audio", caps: ["audio"], confidence: 100 }, "模型名精确命中 APIMart 官方 TTS 模型");
  } else if (providerProtocol === "apimart" && /gpt-4o-mini-audio-preview/.test(s)) {
    set({ protocol: "apimart", type: "llm", caps: ["llm"], confidence: 100 }, "APIMart Audio Preview 是对话预览模型，不是 audio/speech TTS 模型");
  } else if (providerProtocol === "apimart" && /(tts|speech|voice)/.test(s)) {
    set({ protocol: "apimart", type: "other", caps: ["other"], confidence: 98 }, "APIMart 官方 TTS 当前未声明支持该模型");
  } else if (/(text-embedding|embedding|embed-|bge|e5-|gte-)/.test(s)) {
    set({ protocol: "openai-embedding", type: "other", caps: ["embedding"], confidence: 90 }, "模型名命中 embedding");
  } else if (/(whisper|transcribe|speech-to-text|stt)/.test(s)) {
    set({ protocol: "openai-audio", type: "audio", caps: ["audio"], confidence: 88 }, "模型名命中语音转写");
  } else if (/(tts|speech|voice)/.test(s)) {
    set({ protocol: "openai-audio", type: "audio", caps: ["audio"], confidence: 85 }, "模型名命中语音合成");
  } else if (/(suno|music|song|udio)/.test(s)) {
    set({ protocol: "suno", type: "audio", caps: ["audio"], confidence: 88 }, "模型名命中音乐生成");
  } else if (/(kling|可灵)/.test(s)) {
    set({ protocol: "kling", type: "video", caps: ["video"], confidence: 90 }, "模型名命中 Kling/可灵");
  } else if (/(pixverse)/.test(s)) {
    set({ protocol: "pixverse", type: "video", caps: ["video"], confidence: 90 }, "模型名命中 PixVerse");
  } else if (/(pika)/.test(s)) {
    set({ protocol: "pika", type: "video", caps: ["video"], confidence: 90 }, "模型名命中 Pika");
  } else if (/(vidu)/.test(s)) {
    set({ protocol: "vidu", type: "video", caps: ["video"], confidence: 90 }, "模型名命中 Vidu");
  } else if (/(minimax|hailuo|海螺).*(image|img)|(?:image|img).*(minimax|hailuo|海螺)/.test(s)) {
    set({ protocol: "openai-image", type: "image", caps: ["image"], confidence: 90 }, "模型名命中 MiniMax 图片模型");
  } else if (/^minimax[-_.]?m(?:2|3)(?:\b|[-_.])/.test(s)) {
    set({ protocol: "minimax", type: "llm", caps: ["llm"], confidence: 96 }, "模型名命中 MiniMax M2/M3 文本模型");
  } else if (/(minimax|hailuo|海螺)/.test(s)) {
    set({ protocol: "minimax", type: "video", caps: ["video"], confidence: 86 }, "模型名命中 MiniMax/海螺");
  } else if (/(wanx|wan\b|wan[-_.]?\d|通义万相|qwen-image|qwen.?image)/.test(s)) {
    const isImage = /(image|img|qwen|text[-_.]?to[-_.]?image|t2i)/.test(s);
    set({ protocol: "wanxiang", type: isImage ? "image" : "video", caps: [isImage ? "image" : "video"], confidence: 84 }, "模型名命中通义万相/Wan");
  } else if (/(sora|veo|runway|luma|video|cogvideo|seedance|hailuo|(?:^|[-_.])sd[-_.]?\d|(?:^|[-_.])ray(?:\b|[-_.])|(?:^|[-_])gen-?[34](?:\b|[-_.]))/.test(s)) {
    set({ protocol: hasProtocol(providerProtocol) && providerProtocol !== "openai" ? providerProtocol : "v2-unified", type: "video", caps: ["video"], confidence: 76 }, "模型名命中视频生成");
  } else if (/(gpt[-_.]?image|dall.?e|image|img|flux|stable.?diffusion|sdxl|sd3|midjourney|imagen|nano[-_. ]?banana|seedream|jimeng|recraft|ideogram|photon|cogview|kolors)/.test(s)) {
    // 源：protocolInference.ts:156-159 的注释保留——内置 Gemini 图片 Profile 是明确的 wire-contract 命中，
    // 即使自定义 Bearer 供应商占用了 Base URL 也优先 generateContent；OpenAI Relay 仍受下方 Images API 约束。
    const nativeGeminiEndpoint = /generativelanguage\.googleapis\.com/i.test(baseUrl);
    const nativeGeminiImageProfile = /^(?:models\/)?gemini-(?:2\.0-flash-preview-image|2\.5-flash-image|3-pro-image|3\.1-flash-image)(?:$|[-_.])/i.test(s);
    let comflyGenerationsEndpoint = false;
    try { comflyGenerationsEndpoint = new URL(baseUrl).hostname.toLowerCase() === "ai.comfly.org"; } catch { /* invalid/partial URL */ }
    const isGeminiImage = /(gemini|imagen|nano[-_. ]?banana)/.test(s);
    const imageProtocol = isGeminiImage
      ? comflyGenerationsEndpoint ? "gemini-generations" : nativeGeminiEndpoint || nativeGeminiImageProfile ? "gemini-image" : "openai-image"
      : "openai-image";
    set({ protocol: imageProtocol, type: "image", caps: ["image"], confidence: 82 }, "模型名命中图像生成");
  } else if (/(claude)/.test(s)) {
    set({ protocol: "anthropic-chat", type: "llm", caps: ["llm"], confidence: 85 }, "模型名命中 Claude");
  } else if (/(gemini)/.test(s)) {
    set({ protocol: "gemini-chat", type: "llm", caps: ["llm"], confidence: 80 }, "模型名命中 Gemini");
  } else if (/(gpt|o\d|deepseek|qwen|glm|yi-|moonshot|kimi|doubao|llama|mistral|mixtral|ernie|hunyuan)/.test(s)) {
    set({ protocol: defaultModelProtocol(providerProtocol, "llm"), type: "llm", caps: ["llm"], confidence: 72 }, "模型名命中 LLM");
  } else {
    reasons.push("未命中模型名规则，按默认 LLM 处理");
  }

  if (providerProtocol === "fhl-http") {
    protocol = defaultModelProtocol(providerProtocol, type);
    reasons.push("FHL 图片模型统一绑定独立的 Agent 图片协议");
  } else if (providerProtocol === "openai-relay") {
    protocol = defaultModelProtocol(providerProtocol, type);
    confidence = Math.max(confidence, 96);
    reasons.push("OpenAI 中转平台统一使用 Images Generations JSON 媒体协议");
  } else if (providerProtocol === "aliyun-bailian") {
    protocol = "aliyun-bailian";
    reasons.push("阿里云百炼模型统一使用业务空间 OpenAI 兼容协议");
  } else if (providerProtocol === "modelscope") {
    protocol = "modelscope";
    reasons.push("ModelScope 模型统一使用原生异步图片/兼容对话协议");
  } else if (providerProtocol === "volcengine") {
    protocol = "volcengine";
    reasons.push("火山方舟模型统一使用兼容对话、Seedream 图片或 Seedance 视频协议");
  } else if (providerProtocol === "volcengine-speech") {
    protocol = "volcengine-speech";
    type = "audio";
    caps = ["audio"];
    reasons.push("豆包语音模型统一使用 X-Api-Key 官方语音协议");
  } else if (providerProtocol === "agnes") {
    protocol = "agnes";
    reasons.push("Agnes 模型统一使用原生图片/视频和兼容对话协议");
  } else if (providerProtocol === "agtoken" || providerProtocol === "agtoken-video") {
    protocol = defaultModelProtocol(providerProtocol, type);
    confidence = Math.max(confidence, 96);
    reasons.push("AGToken 只绑定模型协议，不覆盖模型家族判断出的类别");
  } else if (providerProtocol === "zkki" || providerProtocol === "zkki-model") {
    if (/(seedream|gpt[-_.]?image|gemini.*image|imagen|nano[-_. ]?banana|flux|recraft|ideogram|midjourney|jimeng|kolors)/i.test(s)) {
      type = "image";
      caps = [type];
      const fallbackIndex = reasons.indexOf("未命中模型名规则，按默认 LLM 处理");
      if (fallbackIndex >= 0) reasons.splice(fallbackIndex, 1);
    } else if (/(seedance|video|veo|sora|kling|runway|luma|hailuo|minimax[-_.]?h3|omni|global[-_.]?(?:standard[-_.]?)?(?:multi|t2v)|wan[-_.]?\d)/i.test(s) || /^sd[-_]\d(?:[-_.]|$)/i.test(s)) {
      type = "video";
      caps = ["video"];
      const fallbackIndex = reasons.indexOf("未命中模型名规则，按默认 LLM 处理");
      if (fallbackIndex >= 0) reasons.splice(fallbackIndex, 1);
    }
    protocol = defaultModelProtocol(providerProtocol, type);
    confidence = Math.max(confidence, 96);
    reasons.push("ZKKI 只绑定模型协议，不覆盖模型家族判断出的类别");
  } else if (!hasProtocol(protocol)) {
    reasons.push(`协议 ${protocol} 未在内置协议中声明，回退到 ${defaultModelProtocol(providerProtocol, type)}`);
    protocol = defaultModelProtocol(providerProtocol, type);
    confidence = Math.min(confidence, 55);
  }

  return { model, type, caps: unique(caps), protocol, confidence, reasons };
}

/** 源：protocolInference.ts:231-257。 */
function inferProviderProtocols(input) {
  const source = input && typeof input === "object" ? input : {};
  const canonicalProtocol = canonicalAgentProviderProtocol({ base_url: source.baseUrl, protocol: source.protocol || "openai" });
  const base = platformProtocolFromBaseUrl(source.baseUrl || "", canonicalProtocol);
  const models = unique((source.models || []).map(String).map((item) => item.trim()).filter(Boolean));
  const inferredModels = models.map((model) => inferByModelName(model, base.protocol, source.baseUrl || ""));
  const asyncScore = inferredModels
    .filter((model) => model.type === "video" || model.caps.includes("audio"))
    .reduce((sum, model) => sum + model.confidence, 0);
  const providerProtocol = base.protocol;
  const reasons = [base.reason];
  const normalizedModels = inferredModels.map((model) => ({
    ...model,
    protocol: model.protocol === providerProtocol ? "" : model.protocol,
  }));
  return {
    providerProtocol,
    providerProtocolSuggestion: providerProtocol,
    confidence: Math.max(base.confidence, Math.round(asyncScore / Math.max(1, models.length))),
    reasons,
    models: normalizedModels,
    customProtocols: unique(normalizedModels.map((model) => model.protocol).filter(Boolean)),
  };
}

module.exports = {
  INFERRED_MODEL_TYPES,
  PLATFORM_PROTOCOLS,
  unique,
  hasProtocol,
  defaultModelProtocol,
  normalizePlatformProtocol,
  platformProtocolFromBaseUrl,
  inferByModelName,
  inferProviderProtocols,
};
