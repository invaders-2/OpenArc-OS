"use strict";
/**
 * B3b · 能力目标解析（CJS 移植）。
 *
 * 来源：server/capabilityTargetResolver.ts:1-194。
 * 逐字对应：CAPABILITY_TO_PROTOCOL_INTENT 16 条映射、references/requirements 归一化、
 * resolutionSupport 的 0/1/2 三档与 4k/2k/1k 尺寸阈值、discoverCapabilityTargets 的
 * 24 条候选上限 → support 排序 → 8 条上限、selectedCapabilityTargets 取首选。
 *
 * 依赖注入（源直接 import 的模块）：
 *   · modelResolver.resolveModelRoutesFromProviders  ← server/modelResolver.ts
 *   · modelDescriptor.resolveModelDescriptor        ← server/modelDescriptor.ts
 *   · store.applyModelOrders / providers()          ← server/store.ts
 * 未注入时抛 AGENT_DEPENDENCY_UNAVAILABLE。
 *
 * 【云计费 / DX Credits 删除记录】按 B3b 约束 D，以下源调用一律删除：
 *   · capabilityTargetResolver.ts:5   import { dxosAiSystemProvider, dxosModelDescriptor, DXOS_AI_PROVIDER_ID } from './dxosProtocol.ts'
 *   · capabilityTargetResolver.ts:124-129 注释里"User-scoped discovery includes runtime providers such as DX OS Credits"整段
 *   · capabilityTargetResolver.ts:138-141  dxosAiSystemProvider(userId) 调用与 dxos 运行时供应商注入
 *   · capabilityTargetResolver.ts:145-188  dxos 云候选（dxosModelDescriptor / DXOS_AI_PROVIDER_ID / cap_sort 排序）合并分支
 * 删除后 discoverCapabilityTargetsForUser 只保留本地 providers 的同步目录语义；
 * userId 参数保留以维持签名兼容。
 */
// 惰性 require 破环：agent-kernel 反向依赖本模块（capabilityRouter / capabilityTargetResolver）。
function kernelModule() { return require("./agent-kernel.cjs"); }
function agentDependencyUnavailable(dependency) { return kernelModule().agentDependencyUnavailable(dependency); }
function getAgentKernelDependencies() { return kernelModule().getAgentKernelDependencies(); }

/** capabilityTargetResolver.ts:7-24 */
const CAPABILITY_TO_PROTOCOL_INTENT = Object.freeze({
  "media.image.generate": "image.generate",
  "media.image.edit": "image.edit",
  "media.image.batch_edit": "image.edit",
  "media.image.upscale": "image.upscale",
  "media.image.inspect": "image.describe",
  "media.image.midjourney": "image.generate",
  "media.video.generate": "video.generate",
  "media.video.image_to_video": "video.image_to_video",
  "media.video.first_last_frame": "video.first_last_frame",
  "media.video.multi_reference": "video.multi_reference",
  "media.video.video_to_video": "video.video_to_video",
  "media.video.audio_reference": "video.audio_reference",
  "media.video.multimodal": "video.multimodal",
  "media.audio.synthesize": "audio.tts",
  "media.audio.transcribe": "audio.transcribe",
  "media.audio.music_generate": "audio.music",
});

/** capabilityTargetResolver.ts:26-30 */
function normalizeCapabilityReferences(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const count = (key) => Math.max(0, Math.min(100, Math.floor(Number(input[key]) || 0)));
  return { images: count("images"), videos: count("videos"), audios: count("audios"), files: count("files") };
}

/** capabilityTargetResolver.ts:32-36 */
function normalizeCapabilityRequirements(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const resolution = String(input.resolution || "").trim().toLowerCase().replace(/\s+/g, "");
  return { ...(resolution ? { resolution } : {}) };
}

/** capabilityTargetResolver.ts:40-44 */
function optionValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) && "value" in value
    ? String(value.value || "")
    : String(value || "");
}

/** capabilityTargetResolver.ts:46-67 */
function resolutionSupport(parameters, requirements) {
  const requested = requirements.resolution?.trim().toLowerCase();
  if (!requested) return 0;
  const record = parameters && typeof parameters === "object" && !Array.isArray(parameters) ? parameters : {};
  const fields = Array.isArray(record.fields) ? record.fields : [];
  const resolutionField = fields.find((value) => value && typeof value === "object" && String(value.key || "") === "resolution");
  const declared = (resolutionField?.options || []).map(optionValue).map((value) => value.toLowerCase());
  if (declared.length) return declared.includes(requested) ? 0 : 2;
  const sizeField = fields.find((value) => value && typeof value === "object" && String(value.key || "") === "size");
  const dimensions = (sizeField?.options || []).map(optionValue).flatMap((value) => {
    const match = value.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/i);
    return match ? [Math.max(Number(match[1]), Number(match[2]))] : [];
  });
  if (!dimensions.length) return 1;
  const threshold = requested === "4k" || requested === "2160p" ? 3800
    : requested === "2k" || requested === "1440p" ? 1900
      : requested === "1k" || requested === "1080p" ? 1000
        : Number(requested.replace(/p$/, "")) || 0;
  return threshold > 0 && Math.max(...dimensions) >= threshold ? 0 : 2;
}

/** capabilityTargetResolver.ts:69-71 */
function protocolIntentForCapability(intent) {
  return CAPABILITY_TO_PROTOCOL_INTENT[intent] || null;
}

/** capabilityTargetResolver.ts:73-111 */
function discoverCapabilityTargets(capabilityIntents, providers, references = {}, requirements = {}) {
  const dependencies = getAgentKernelDependencies();
  const modelResolver = dependencies.modelResolver;
  if (!modelResolver || typeof modelResolver.resolveModelRoutesFromProviders !== "function") {
    throw agentDependencyUnavailable("modelResolver.resolveModelRoutesFromProviders");
  }
  const modelDescriptor = dependencies.modelDescriptor;
  if (!modelDescriptor || typeof modelDescriptor.resolveModelDescriptor !== "function") {
    throw agentDependencyUnavailable("modelDescriptor.resolveModelDescriptor");
  }
  const providerList = providers === undefined ? defaultProviders(dependencies) : providers;
  const result = {};
  for (const capabilityIntent of [...new Set(capabilityIntents)]) {
    const intent = protocolIntentForCapability(capabilityIntent);
    if (!intent) continue;
    try {
      const routes = modelResolver.resolveModelRoutesFromProviders(providerList, { intent, fallbackPolicy: "best_available" });
      result[capabilityIntent] = routes.slice(0, 24).flatMap((route) => {
        const provider = providerList.find((item) => item.id === route.providerId);
        const model = provider?.models.find((item) => item.model === route.model);
        if (!provider || !model) return [];
        const descriptor = modelDescriptor.resolveModelDescriptor({ provider, model, intent, references });
        if (!descriptor.execution.available || !descriptor.capabilities.includes(intent) || !descriptor.operation) return [];
        const parameters = descriptor.parameters ? {
          schemaId: descriptor.parameters.schemaId,
          fields: descriptor.parameters.fields,
          defaults: descriptor.parameters.defaults,
        } : undefined;
        const support = resolutionSupport(parameters, requirements);
        if (support === 2) return [];
        return [{ target: {
          providerId: provider.id, providerName: provider.name, model: model.model,
          mode: descriptor.execution.mode, operationId: descriptor.operation.id,
          parameters, inputs: descriptor.inputs,
        }, support }];
      }).sort((left, right) => left.support - right.support).slice(0, 8).map((item) => item.target);
    } catch {
      result[capabilityIntent] = [];
    }
  }
  return result;
}

/** capabilityTargetResolver.ts:115-122 */
function coarseCapabilityForIntent(intent) {
  const protocolIntent = protocolIntentForCapability(intent);
  if (protocolIntent?.startsWith("image.")) return "image";
  if (protocolIntent?.startsWith("video.")) return "video";
  if (protocolIntent?.startsWith("audio.")) return "audio";
  if (protocolIntent?.startsWith("llm.")) return "llm";
  return null;
}

function defaultProviders(dependencies) {
  if (typeof dependencies.providers === "function") return dependencies.providers();
  throw agentDependencyUnavailable("providers");
}

/**
 * capabilityTargetResolver.ts:130-190（按约束 D 删除 dxos 云分支，见文件头）。
 * 只保留本地 providers 的有序目录查询。
 */
async function discoverCapabilityTargetsForUser(userId, capabilityIntents, references = {}, requirements = {}, options = {}) {
  const dependencies = getAgentKernelDependencies();
  const localProviders = options.localProviders || defaultProviders(dependencies);
  const order = dependencies.store && typeof dependencies.store.applyModelOrders === "function"
    ? dependencies.store.applyModelOrders
    : null;
  if (!order) throw agentDependencyUnavailable("store.applyModelOrders");
  return discoverCapabilityTargets(capabilityIntents, order(localProviders), references, requirements);
}

/** capabilityTargetResolver.ts:192-194 */
function selectedCapabilityTargets(targets) {
  return Object.entries(targets).flatMap(([intent, candidates]) => candidates[0] ? [{ intent, ...candidates[0] }] : []);
}

module.exports = {
  CAPABILITY_TO_PROTOCOL_INTENT,
  normalizeCapabilityReferences,
  normalizeCapabilityRequirements,
  protocolIntentForCapability,
  discoverCapabilityTargets,
  discoverCapabilityTargetsForUser,
  selectedCapabilityTargets,
};
