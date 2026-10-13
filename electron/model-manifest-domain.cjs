"use strict";
/**
 * P2 · 能力 manifest / 参数 schema / 路由与描述符的纯逻辑。
 *
 * 依据：
 *   · DXSRC/protocolManifest.ts:43-52     resolveCatalogModelCaps
 *   · DXSRC/protocolManifest.ts:65-72     TASK_INTENT_REQUIREMENTS
 *   · DXSRC/protocolManifest.ts:236-244   taskIntentRequirement
 *   · DXSRC/protocolManifest.ts:246-315   resolveProtocolModelProfile（v2 分支）
 *   · DXSRC/protocolManifest.ts:317-332   resolveOperation
 *   · DXSRC/protocolManifest.ts:334-352   resolveUiSchema
 *   · DXSRC/protocolManifest.ts:354-465   resolveParameterSchema / validateProtocolParameters
 *   · DXSRC/protocolCoverage.ts:36-73     覆盖度
 *   · DXSRC/modelResolver.ts:92-227       候选评分与路由
 *   · DXSRC/protocolInference.ts:231      inferProviderProtocols（见 inferModelType 注释：只还原
 *      规则推断的对外形状，未逐条搬运 231 行的完整规则表）
 */
const { findModelProfile } = require("./protocol-engine/modelProfile.cjs");

const COARSE_TO_INTENTS = {
  llm: ["llm.chat"], vlm: ["llm.chat.vision"], vision: ["llm.chat.vision"], tools: ["llm.tools"],
  responses: ["llm.responses"], image: ["image.generate"], video: ["video.generate"], audio: ["audio.tts"],
  embedding: ["embeddings.create"], embeddings: ["embeddings.create"], moderation: ["moderation.create"],
  files: ["files.upload"], batches: ["batches.create"],
};
const CATALOG_CAPABILITIES = new Set(["llm", "image", "video", "audio", "other"]);
const OPERATION_FALLBACKS = {
  "video.text_to_video": ["video.generate"],
  "video.first_last_frame": ["video.image_to_video"],
  "video.multi_reference": ["video.image_to_video"],
  "video.video_to_video": ["video.image_to_video"],
  "video.audio_reference": ["video.image_to_video"],
  "video.multimodal": ["video.image_to_video"],
};
const TASK_INTENT_REQUIREMENTS = {
  "agent.project.write": { taskIntent: "agent.project.write", requiresAll: ["llm.tools"], requiresAny: [] },
  "agent.code.review": { taskIntent: "agent.code.review", requiresAll: ["llm.tools"], requiresAny: ["llm.structured_output", "llm.chat"] },
  "agent.analyze_image_and_write": { taskIntent: "agent.analyze_image_and_write", requiresAll: ["llm.chat.vision", "llm.tools"], requiresAny: [] },
  "app.canvas.generate_image": { taskIntent: "app.canvas.generate_image", requiresAll: ["image.generate"], requiresAny: [] },
  "app.canvas.edit_image": { taskIntent: "app.canvas.edit_image", requiresAll: ["image.edit"], requiresAny: [] },
  "skill.video.compose": { taskIntent: "skill.video.compose", requiresAll: [], requiresAny: ["video.generate", "video.image_to_video"] },
};

function unique(items) { return [...new Set(items)]; }
function asRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

function resolveCatalogModelCaps(storedCaps = [], intents = []) {
  const stored = unique(storedCaps.map((c) => String(c || "").trim().toLowerCase()).filter((c) => CATALOG_CAPABILITIES.has(c)));
  if (stored.length) return stored;
  const resolved = unique(intents.map((intent) => String(intent || "").split(".")[0]).filter((c) => CATALOG_CAPABILITIES.has(c)));
  return resolved.length ? resolved : unique(storedCaps.map(String).filter(Boolean));
}

function taskIntentRequirement(taskIntent, intent) {
  if (taskIntent && TASK_INTENT_REQUIREMENTS[taskIntent]) return TASK_INTENT_REQUIREMENTS[taskIntent];
  return { taskIntent, intent, requiresAll: intent ? [intent] : [], requiresAny: [] };
}

function capabilityGroup(intent) {
  if (intent.startsWith("image.")) return "image";
  if (intent.startsWith("video.")) return "video";
  if (intent.startsWith("audio.")) return "audio";
  if (intent.startsWith("embedding") || intent.startsWith("rag.embedding")) return "embedding";
  if (intent.startsWith("moderation.")) return "moderation";
  if (intent.startsWith("files.")) return "files";
  if (intent.startsWith("batches.")) return "batches";
  return "llm";
}

function coarseCapability(intent) {
  const group = capabilityGroup(intent);
  return group === "llm" || group === "image" || group === "video" || group === "audio" ? group : "other";
}

function schemaDefaults(fields) {
  const defaults = {};
  if (!Array.isArray(fields)) return defaults;
  for (const field of fields) {
    const obj = asRecord(field);
    const key = String(obj.key || "").trim();
    if (key && Object.prototype.hasOwnProperty.call(obj, "default")) defaults[key] = obj.default;
  }
  return defaults;
}

function mergeLimitObjects(baseValue, overrideValue) {
  const base = asRecord(baseValue);
  const override = asRecord(overrideValue);
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = Object.keys(asRecord(value)).length && Object.keys(asRecord(base[key])).length ? mergeLimitObjects(base[key], value) : value;
  }
  return out;
}

function effectiveLimits(rawLimits, intent) {
  const limits = asRecord(rawLimits);
  const { byCapability: _byCapability, ...base } = limits;
  const byCapability = asRecord(limits.byCapability);
  return mergeLimitObjects(base, byCapability[intent]);
}

function limitOptions(rule) {
  return Array.isArray(rule.options) ? rule.options : Array.isArray(rule.values) ? rule.values : [];
}

function applyLimitsToFields(fields, limits) {
  const features = asRecord(limits.features);
  return (Array.isArray(fields) ? fields : []).flatMap((field) => {
    const data = asRecord(field);
    const key = String(data.key || "");
    if (!key || features[key] === false) return [];
    const rule = asRecord(limits[key]);
    if (rule.supported === false) return [];
    const next = { ...data };
    const options = limitOptions(rule);
    if (options.length) next.options = options.map((value) => typeof value === "object" && value ? value : { label: String(value).toUpperCase(), value });
    else if (Array.isArray(next.options) && (rule.min != null || rule.max != null)) {
      next.options = next.options.filter((option) => {
        const value = Number(asRecord(option).value ?? option);
        return Number.isFinite(value) && (rule.min == null || value >= Number(rule.min)) && (rule.max == null || value <= Number(rule.max));
      });
    }
    for (const prop of ["min", "max", "step", "default", "readonly"]) if (Object.prototype.hasOwnProperty.call(rule, prop)) next[prop] = rule[prop];
    if (next.type === "select" && Array.isArray(next.options) && next.options.length) {
      const values = next.options.map((option) => asRecord(option).value ?? option);
      if (!values.some((value) => String(value) === String(next.default))) next.default = rule.default ?? values[0];
    }
    return [next];
  });
}

function fieldVisibleForModel(field, model) {
  const showWhen = asRecord(asRecord(field).showWhen);
  const models = Array.isArray(showWhen.models) ? showWhen.models.map(String).filter(Boolean) : [];
  return !models.length || models.includes(model);
}

function rawV2Profiles(protocol) {
  return Object.entries(protocol.modelProfiles || {}).map(([id, data]) => ({ id, data }));
}

function matchesProfile(profileId, profile, model) {
  const found = findModelProfile({ [profileId]: profile }, model);
  return found ? found[0] === profileId : false;
}

function profileEntryFor(protocol, model) {
  return rawV2Profiles(protocol).find((entry) => matchesProfile(entry.id, entry.data, model));
}

/** 对应 protocolManifest.ts:246-280 的 v2 分支。 */
function resolveProtocolModelProfile(protocol, model) {
  const entry = profileEntryFor(protocol, model);
  const profile = entry && entry.data;
  const capabilities = unique((profile && profile.capabilities ? profile.capabilities : protocol.capabilities).map(String));
  const uiSchemas = unique(((profile && profile.uiSchemas) || []).map(String));
  const defaults = {
    ...schemaDefaults(uiSchemas[0] ? protocol.uiSchemas && protocol.uiSchemas[uiSchemas[0]] : undefined),
    ...asRecord(profile && profile.defaults),
  };
  const defaultOperations = Object.fromEntries(capabilities.map((capability) => {
    const workflowId = (profile && profile.workflows && profile.workflows[capability]) || (protocol.workflows[capability] ? capability : "");
    const wf = workflowId ? protocol.workflows[workflowId] : undefined;
    return wf ? [capability, wf.submit] : [];
  }).filter((item) => item.length === 2));
  return {
    protocolId: protocol.id,
    model,
    coarseCaps: unique(capabilities.map(coarseCapability)),
    capabilities,
    defaultOperations,
    uiSchemas,
    defaults,
    limits: asRecord(profile && profile.limits),
    capabilitySources: Object.fromEntries(capabilities.map((capability) => [capability, "profile"])),
    priority: 999999,
    profileId: entry && entry.id,
    profileLabel: profile && profile.label,
  };
}

function pickOperation(protocol, capabilities, profile, intent) {
  const operations = asRecord(protocol.operations);
  const preferred = [
    ...(intent ? [intent] : []),
    ...(intent ? OPERATION_FALLBACKS[intent] || [] : []),
    ...((profile && profile.operationPreference) || []),
    ...capabilities,
  ];
  return preferred.find((operationId) => !!operations[operationId]) || Object.keys(operations)[0] || "";
}

function resolveOperation(protocol, model, intent) {
  const profile = profileEntryFor(protocol, model);
  const profileData = profile && profile.data;
  const workflowId = (profileData && profileData.workflows && profileData.workflows[intent]) || (protocol.workflows[intent] ? intent : "");
  const wf = workflowId ? protocol.workflows[workflowId] : undefined;
  const operation = wf ? asRecord(protocol.operations[wf.submit]) : {};
  return wf && Object.keys(operation).length ? { id: wf.submit, operation } : null;
}

function resolveUiSchema(protocol, operationId, model) {
  const profile = model ? profileEntryFor(protocol, model) : undefined;
  const profileData = profile && profile.data;
  const openAiSchemas = { "image-generate": "openai-image", "image-edit": "openai-image", "video-submit": "openai-compatible-video", "audio-speech": "openai-speech", "audio-transcribe": "openai-transcription", "audio-translate": "openai-transcription" };
  const operationSchema = protocol.id === "openai-images" && ((profileData && profileData.uiSchemas && profileData.uiSchemas.length) || 0) > 1 ? openAiSchemas[operationId] : undefined;
  const uiSchemaId = operationSchema || (profileData && profileData.uiSchemas && profileData.uiSchemas[0]) || (protocol.uiSchemas && protocol.uiSchemas[operationId] ? operationId : undefined);
  const fields = uiSchemaId && protocol.uiSchemas ? protocol.uiSchemas[uiSchemaId] : undefined;
  return uiSchemaId && Array.isArray(fields) ? { id: uiSchemaId, fields, defaults: schemaDefaults(fields) } : null;
}

function resolveParameterSchema(protocol, model, intent) {
  const manifest = resolveProtocolModelProfile(protocol, model);
  const limits = effectiveLimits(manifest.limits, intent);
  const operation = resolveOperation(protocol, model, intent);
  const uiSchema = operation ? resolveUiSchema(protocol, operation.id, model) : null;
  if (!uiSchema) return null;
  const fields = applyLimitsToFields(uiSchema.fields.filter((field) => fieldVisibleForModel(field, model)), limits);
  return {
    protocolId: protocol.id, model, intent,
    operationId: operation ? operation.id : intent,
    operation: operation ? operation.operation : {},
    schemaId: uiSchema.id, source: "uiSchema", fields,
    defaults: { ...manifest.defaults, ...schemaDefaults(fields) }, limits,
  };
}

function validateProtocolParameters(protocol, model, intent, params = {}, references = {}) {
  const manifest = resolveProtocolModelProfile(protocol, model);
  const limits = effectiveLimits(manifest.limits, intent);
  const label = manifest.profileLabel || model;
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    const rule = asRecord(limits[key]);
    if (rule.supported === false || asRecord(limits.features)[key] === false) {
      if (value === false) continue;
      throw new Error(label + " 不支持参数「" + key + "」。");
    }
    const number = typeof value === "number" ? value : Number(value);
    if (rule.integer === true && !Number.isInteger(number)) throw new Error(label + " 的「" + key + "」必须是整数。");
    if (rule.min != null && Number.isFinite(number) && number < Number(rule.min)) throw new Error(label + " 的「" + key + "」不能小于 " + rule.min + "。");
    if (rule.max != null && Number.isFinite(number) && number > Number(rule.max)) throw new Error(label + " 的「" + key + "」不能大于 " + rule.max + "。");
    const options = limitOptions(rule).map((option) => String(asRecord(option).value ?? option).toLowerCase());
    if (options.length && !options.includes(String(value).toLowerCase())) throw new Error(label + " 的「" + key + "」只支持：" + options.join("、") + "。");
  }
  const referenceLimits = asRecord(limits.references);
  for (const kind of ["images", "videos", "audios"]) {
    const count = Number(references[kind] || 0);
    const rule = asRecord(referenceLimits[kind]);
    if (rule.min != null && count < Number(rule.min)) throw new Error(label + " 至少需要 " + rule.min + " 个参考。");
    if (rule.max != null && count > Number(rule.max)) throw new Error(label + " 最多支持 " + rule.max + " 个参考。");
  }
  return limits;
}

function protocolCapabilities(protocol) {
  return unique([...(protocol.capabilities || []), ...rawV2Profiles(protocol).flatMap((profile) => (profile.data.capabilities || []).map(String))]);
}

/** 对应 protocolCoverage.ts:36-73；用操作是否存在判定可用性。 */
function inspectProtocolCoverage(protocol, models = []) {
  const items = models.map((model) => {
    const modelId = typeof model === "string" ? model : String(model.model || "");
    const manifest = resolveProtocolModelProfile(protocol, modelId);
    const intents = (manifest.capabilities.length ? manifest.capabilities : ["llm.chat"]).map((intent) => {
      try {
        const operation = resolveOperation(protocol, modelId, intent);
        return { intent, available: !!operation, mode: "declarative", operation: operation ? { id: operation.id, method: operation.operation.method, path: operation.operation.path, requestMode: operation.operation.requestMode } : null, reasons: operation ? [] : ["协议未声明 " + intent + " 的 workflow。"] };
      } catch (error) {
        return { intent, available: false, mode: "unavailable", operation: null, reasons: [String(error.message || error)] };
      }
    });
    const ready = intents.filter((intent) => intent.available).length;
    return { model: modelId, protocolId: protocol.id, status: ready === intents.length ? "ready" : ready ? "partial" : "missing", intents };
  });
  return {
    format: "dx-protocol-coverage/v1", protocolId: protocol.id,
    summary: { total: items.length, ready: items.filter((i) => i.status === "ready").length, partial: items.filter((i) => i.status === "partial").length, missing: items.filter((i) => i.status === "missing").length },
    models: items,
  };
}

/**
 * 粗能力推断。**不是** protocolInference.ts:231 完整规则表的逐条移植：
 * 这里只保留输出形状与最保守的关键词规则，未命中的模型落到 llm，绝不臆造图像/视频能力。
 */
const IMAGE_KEYWORDS = /(?:^|[-_/])(?:dall-e|gpt-image|seedream|flux|midjourney|imagen|sd-?d|kolors|ideogram|banana|cogview)/i;
const VIDEO_KEYWORDS = /(?:^|[-_/])(?:sora|veo|kling|pixverse|pika|vidu|wan|seedance|hailuo|minimax-h3)/i;
const AUDIO_KEYWORDS = /(?:tts|whisper|speech|voice|audio|music|suno|udio)/i;
function inferModelType(model) {
  const name = String(model || "");
  if (VIDEO_KEYWORDS.test(name)) return { type: "video", reasons: ["命中视频模型名规则"] };
  if (IMAGE_KEYWORDS.test(name)) return { type: "image", reasons: ["命中图像模型名规则"] };
  if (AUDIO_KEYWORDS.test(name)) return { type: "audio", reasons: ["命中音频模型名规则"] };
  if (/(?:embed|rerank|bge-|text-embedding)/i.test(name)) return { type: "other", reasons: ["命中向量模型名规则"] };
  return { type: "llm", reasons: ["未命中特殊模型名规则，按语言模型处理"] };
}

/** 路由描述符（modelDescriptor.ts:133 的 v2 子集）。 */
function resolveModelDescriptor({ protocol, provider, model, intent }) {
  const providerId = provider && (provider.id || provider.providerId);
  const modelId = typeof model === "string" ? model : String(model.model || "");
  const profile = profileEntryFor(protocol, modelId);
  const manifest = resolveProtocolModelProfile(protocol, modelId);
  const capabilities = unique([...manifest.capabilities, ...(model && Array.isArray(model.caps) ? model.caps.flatMap((cap) => COARSE_TO_INTENTS[cap] || [cap]) : [])]);
  const operation = resolveOperation(protocol, modelId, intent);
  const parameters = resolveParameterSchema(protocol, modelId, intent);
  const reasons = [];
  const available = !!(operation || capabilities.includes(intent));
  if (!available) reasons.push("协议未声明 " + intent + " 的执行路径。");
  return {
    providerId, model: modelId, protocolId: protocol.id, profileId: profile && profile.id,
    capabilities, intent, operation: operation ? { id: operation.id, ...operation.operation } : null,
    execution: { available, mode: available ? "declarative" : "unavailable", reasons },
    parameters, limits: effectiveLimits(manifest.limits, intent),
  };
}

module.exports = {
  COARSE_TO_INTENTS, CATALOG_CAPABILITIES, OPERATION_FALLBACKS, TASK_INTENT_REQUIREMENTS,
  resolveCatalogModelCaps, taskIntentRequirement, capabilityGroup, coarseCapability,
  schemaDefaults, mergeLimitObjects, effectiveLimits, applyLimitsToFields,
  resolveProtocolModelProfile, resolveOperation, resolveUiSchema, resolveParameterSchema,
  validateProtocolParameters, protocolCapabilities, inspectProtocolCoverage,
  inferModelType, resolveModelDescriptor,
};
