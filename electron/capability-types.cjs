"use strict";
/**
 * B3b · 能力路由共享类型（CJS 运行时投影）。
 *
 * 来源：server/capabilityTypes.ts:1-120。
 * 源文件只有 type/interface；CJS 侧按 protocol-engine/types.cjs 的既有约定，
 * 只保留运行时真正会用到的字符串联合成员（frozen 数组），
 * interface 用 JSDoc typedef 逐字段保留，不把 TS type 伪造成运行时代码。
 * 注意：源里 CapabilityIntent / TaskIntent 末尾都有 `| string` 逃生口，
 * 下列数组只覆盖显式枚举成员，运行时不以此数组做白名单校验。
 */

/** capabilityTypes.ts:1-2 */
const PROVIDER_CAPABILITIES = Object.freeze(["llm", "image", "video", "audio"]);
const COARSE_CAPABILITIES = Object.freeze(["llm", "image", "video", "audio", "other"]);

/** capabilityTypes.ts:4-39（末尾 `| string` 只覆盖显式枚举部分） */
const CAPABILITY_INTENTS = Object.freeze([
  "llm.chat",
  "llm.chat.stream",
  "llm.chat.vision",
  "llm.tools",
  "llm.responses",
  "llm.responses.stream",
  "llm.structured_output",
  "rag.search",
  "rag.embeddings",
  "embeddings.create",
  "image.generate",
  "image.edit",
  "image.upscale",
  "image.describe",
  "video.generate",
  "video.text_to_video",
  "video.image_to_video",
  "video.first_last_frame",
  "video.multi_reference",
  "video.video_to_video",
  "video.audio_reference",
  "video.multimodal",
  "audio.tts",
  "audio.transcribe",
  "audio.translate",
  "audio.music",
  "moderation.create",
  "files.upload",
  "files.list",
  "files.retrieve",
  "files.delete",
  "batches.create",
  "batches.retrieve",
  "batches.cancel",
]);

/** capabilityTypes.ts:41-48 */
const TASK_INTENTS = Object.freeze([
  "agent.project.write",
  "agent.code.review",
  "agent.analyze_image_and_write",
  "app.canvas.generate_image",
  "app.canvas.edit_image",
  "skill.video.compose",
]);

/** capabilityTypes.ts:50-51 */
const FALLBACK_POLICIES = Object.freeze(["strict", "compatible", "best_available"]);
const CAPABILITY_SOURCES = Object.freeze(["manual", "observed", "profile", "model_caps", "fallback"]);

module.exports = {
  PROVIDER_CAPABILITIES,
  COARSE_CAPABILITIES,
  CAPABILITY_INTENTS,
  TASK_INTENTS,
  FALLBACK_POLICIES,
  CAPABILITY_SOURCES,
};

/**
 * @typedef {('llm'|'image'|'video'|'audio')} ProviderCapability
 * @typedef {('llm'|'image'|'video'|'audio'|'other')} CoarseCapability
 * @typedef {(string)} CapabilityIntent       // 源联合的显式成员见 CAPABILITY_INTENTS
 * @typedef {(string)} TaskIntent             // 源联合的显式成员见 TASK_INTENTS
 * @typedef {('strict'|'compatible'|'best_available')} FallbackPolicy
 * @typedef {('manual'|'observed'|'profile'|'model_caps'|'fallback')} CapabilitySource
 *
 * @typedef {Object} PreferredModel
 * @property {string} [providerId]
 * @property {string} model
 * @property {number} [weight]
 * @property {string} [reason]
 *
 * @typedef {Object} CapabilityRequirement
 * @property {TaskIntent} [taskIntent]
 * @property {CapabilityIntent} [intent]
 * @property {CapabilityIntent[]} requiresAll
 * @property {CapabilityIntent[]} requiresAny
 *
 * @typedef {Object} ModelCapabilityManifest
 * @property {string} [providerId]
 * @property {string} [providerName]
 * @property {string} protocolId
 * @property {string} model
 * @property {boolean} [enabled]
 * @property {('api'|'cli')} [source]
 * @property {CoarseCapability[]} coarseCaps
 * @property {CapabilityIntent[]} capabilities
 * @property {Record<string, string>} defaultOperations
 * @property {string[]} uiSchemas
 * @property {Record<string, unknown>} defaults
 * @property {Record<string, unknown>} limits
 * @property {Partial<Record<CapabilityIntent, CapabilitySource>>} capabilitySources
 * @property {number} priority
 * @property {string} [profileId]
 * @property {string} [profileLabel]
 *
 * @typedef {Object} ResolvedModelRoute
 * @property {string} providerId
 * @property {string} providerName
 * @property {{ id?: string, base_url: string, api_key: string, protocol: string }} provider
 * @property {string} model
 * @property {CapabilityIntent} intent
 * @property {string} operationId
 * @property {Record<string, unknown>} operation
 * @property {string} [uiSchemaId]
 * @property {unknown[]} [uiSchema]
 * @property {Record<string, unknown>} defaults
 * @property {CapabilityIntent[]} satisfied
 * @property {CapabilityIntent[]} missing
 * @property {string[]} reasons
 * @property {string[]} warnings
 * @property {Array<{ providerId: string, providerName: string, model: string, reason: string }>} alternatives
 *
 * @typedef {Object} RouteRequest
 * @property {TaskIntent} [taskIntent]
 * @property {CapabilityIntent} [intent]
 * @property {CapabilityIntent[]} [requiresAll]
 * @property {CapabilityIntent[]} [requiresAny]
 * @property {string} [providerId]
 * @property {string} [model]
 * @property {string} [preferredModel]
 * @property {PreferredModel[]} [preferredModels]
 * @property {FallbackPolicy} [fallbackPolicy]
 * @property {string} [actorId]
 */
