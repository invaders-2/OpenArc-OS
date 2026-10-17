"use strict";
/**
 * B3b+ · Agent 模型路由（CJS 移植）。
 *
 * 来源：DX OS 0.6.1 随包 server/modelResolver.ts:1-249。
 *   · providerUsable / coarseForIntent / capabilitySort / modelSort / capsFromModelEntry
 *   · capabilityFamily / requestRequirements / preferredWeight / candidateFor
 *   · resolveCandidateSet / candidateAllowedByRequest / routeFromCandidate
 *   · resolveModelFromProviders / resolveModelRoutesFromProviders
 *
 * 协议能力解析来源：server/protocolManifest.ts 的 resolveProtocolModelProfile /
 * resolveOperation / resolveParameterSchema / taskIntentRequirement。本仓 v2 协议解析复用
 * model-manifest-domain.cjs；legacy 协议（protocol-engine/legacy-protocols.cjs 的 PROTOCOLS /
 * PROVIDER_PROTOCOLS / MODEL_PROTOCOL_ALIASES）按 protocolManifest.ts 的 legacy 分支补在
 * 本文件内，二者对外合成同一个 service（resolveProtocolModelProfile / resolveProtocolOperation /
 * resolveProtocolParameterSchema）。
 *
 * 【与源的有意差异（均为本仓已删除的云能力，不是遗漏）】
 *   · apiModelAccessFilter：源用于 DX Credits 云配额过滤；本仓无云计费 → 默认全部放行，
 *     可经 createModelResolverBundle({ apiModelAccessFilter }) 注入。
 *   · allProviders()：本仓没有全局 store 单例；providers 由装配方经 providerProtocol.store
 *     或显式 providers() 注入，不在本模块读盘。
 *   · 路由失败带结构化 code（MODEL_ROUTE_NO_CANDIDATE / MODEL_ROUTE_STRICT_CAPABILITY），
 *     与 AGENT_DEPENDENCY_UNAVAILABLE 区分：前者是"没有可用模型"的业务失败，后者是"未装配"。
 *
 * 不伪造成功：没有候选一定抛错；strict 模式缺能力一定抛错；best_available 回退时把
 * missing / warnings 原样带在路由上。
 */
const manifestDomain = require("./model-manifest-domain.cjs");
const legacyProtocols = require("./protocol-engine/legacy-protocols.cjs");
const repository = require("./protocol-engine/repository.cjs");
const { findModelProfile } = require("./protocol-engine/modelProfile.cjs");
const { providerRequiresApiKey } = require("./provider-protocol-domain.cjs");

const MODEL_ROUTE_NO_CANDIDATE = "MODEL_ROUTE_NO_CANDIDATE";
const MODEL_ROUTE_STRICT_CAPABILITY = "MODEL_ROUTE_STRICT_CAPABILITY";

const { COARSE_TO_INTENTS, OPERATION_FALLBACKS } = manifestDomain;

const asRecord = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const unique = (items) => [...new Set(items)];

function routeError(code, message, detail) {
  const error = new Error(message);
  error.name = "ModelRouteError";
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

// ---------------------------------------------------------------------------
// 协议解析（protocolManifest.ts 的 v2 + legacy 两个分支）
// ---------------------------------------------------------------------------

function getProtocolV2(kind, id) {
  try { return repository.getProtocolV2(kind, id); } catch { return null; }
}

/** protocolManifest.ts:78-81 manifestProtocolId */
function manifestProtocolId(protocolId) {
  const direct = String(protocolId || "").trim().toLowerCase();
  if (!direct) return "";
  if (legacyProtocols.PROTOCOLS[direct] || legacyProtocols.PROVIDER_PROTOCOLS[direct] || getProtocolV2("model", direct)) return direct;
  return legacyProtocols.normalizeProtocol(direct);
}

function v2ModelDefinition(protocolId) {
  const entry = getProtocolV2("model", manifestProtocolId(protocolId));
  return entry && entry.protocol && entry.protocol.kind === "model" ? entry.protocol : null;
}

/** protocolManifest.ts:83-88 manifestDefinition：provider 协议可回落到 runtimeProtocol。 */
function legacyManifestDefinition(protocolId) {
  const id = manifestProtocolId(protocolId);
  const definition = legacyProtocols.PROTOCOLS[id] || legacyProtocols.PROVIDER_PROTOCOLS[id];
  const runtime = definition && definition.runtimeProtocol;
  return definition && !definition.operations && runtime && legacyProtocols.PROTOCOLS[runtime]
    ? legacyProtocols.PROTOCOLS[runtime]
    : definition;
}

function profileEntry(protocol, model) {
  const found = findModelProfile(protocol && protocol.modelProfiles, model);
  return found ? { id: found[0], data: asRecord(found[1]) } : undefined;
}

function matchesProfile(profileId, profile, model) {
  const found = findModelProfile({ [profileId]: profile }, model);
  return found ? found[0] === profileId : false;
}

/** protocolManifest.ts:160-165 fallbackIntents */
function fallbackIntents(def) {
  const sources = {};
  const capabilities = unique(Object.keys(asRecord(def.capabilities)).flatMap((cap) => COARSE_TO_INTENTS[cap] || []));
  for (const intent of capabilities) sources[intent] = "fallback";
  return { capabilities, sources };
}

function rawProfiles(def) {
  return Object.entries(asRecord(def.modelProfiles)).map(([id, data]) => ({ id, data: asRecord(data) }));
}

/** protocolManifest.ts:184-193 pickOperation */
function pickOperation(def, capabilities, profile, intent) {
  const operations = asRecord(def.operations);
  const preferred = [
    ...(intent ? [intent] : []),
    ...(intent ? OPERATION_FALLBACKS[intent] || [] : []),
    ...((profile && profile.operationPreference) || []),
    ...capabilities,
  ];
  return preferred.find((operationId) => !!operations[operationId]) || Object.keys(operations)[0] || "";
}

function operationUiSchemaId(operation) {
  return typeof operation.uiSchema === "string" ? operation.uiSchema : undefined;
}

function fieldVisibleForModel(field, model) {
  const showWhen = asRecord(asRecord(field).showWhen);
  const models = Array.isArray(showWhen.models) ? showWhen.models.map(String).filter(Boolean) : [];
  return !models.length || models.includes(model);
}

/** protocolManifest.ts:246-315 的 legacy 分支（v2 分支由 model-manifest-domain.cjs 提供）。 */
function legacyModelProfile(protocolId, model, def) {
  const alias = legacyProtocols.modelProtocolAlias(protocolId);
  const fallback = fallbackIntents(def);
  const entry = rawProfiles(def).find((item) => matchesProfile(item.id, item.data, model));
  const profile = entry && entry.data;
  const profileCapabilities = profile ? (profile.capabilities || []).map(String) : alias ? alias.capabilities.map(String) : [];
  const capabilities = unique(alias || profile ? profileCapabilities : fallback.capabilities);
  const capabilitySources = alias || profile ? {} : { ...fallback.sources };
  for (const capability of profileCapabilities) capabilitySources[capability] = "profile";
  const uiSchemas = unique(((profile && profile.uiSchemas) || []).map(String));
  const defaultOperations = Object.fromEntries(capabilities.map((capability) => {
    const operationId = pickOperation(def, capabilities, profile, capability);
    return operationId ? [capability, operationId] : [];
  }).filter((item) => item.length === 2));
  const operations = asRecord(def.operations);
  const defaultOperationId = pickOperation(def, capabilities, profile);
  const operation = asRecord(operations[defaultOperationId]);
  const uiSchemaId = operationUiSchemaId(operation) || uiSchemas[0];
  return {
    protocolId: alias ? String(protocolId || "").trim().toLowerCase() : manifestProtocolId(protocolId),
    model,
    coarseCaps: unique(capabilities.map(manifestDomain.coarseCapability)),
    capabilities,
    defaultOperations,
    uiSchemas,
    defaults: {
      ...manifestDomain.schemaDefaults(uiSchemaId ? asRecord(def.uiSchemas)[uiSchemaId] : undefined),
      ...asRecord(profile && profile.defaults),
    },
    limits: asRecord(profile && profile.limits),
    capabilitySources,
    priority: Number(profile && profile.priority != null ? profile.priority : 999999),
    profileId: entry && entry.id,
    profileLabel: profile && profile.label,
  };
}

/** server/protocolManifest.ts:246 resolveProtocolModelProfile（v2 + legacy 合成）。 */
function resolveProtocolModelProfile(protocolId, model) {
  const v2 = v2ModelDefinition(protocolId);
  const def = legacyManifestDefinition(protocolId);
  const v2Profile = v2 ? profileEntry(v2, model) : undefined;
  if (v2 && (v2Profile || !def)) return manifestDomain.resolveProtocolModelProfile(v2, model);
  if (!def) throw new Error("协议不存在：" + String(protocolId || ""));
  return legacyModelProfile(protocolId, model, def);
}

function resolveLegacyUiSchemaId(protocolId, operationId, model, def) {
  const operation = asRecord(asRecord(def.operations)[operationId]);
  const uiSchemaId = operationUiSchemaId(operation) || resolveProtocolModelProfile(protocolId, model).uiSchemas[0];
  return uiSchemaId && Array.isArray(asRecord(def.uiSchemas)[uiSchemaId]) ? uiSchemaId : null;
}

/** server/protocolManifest.ts:317 resolveOperation（v2 + legacy 合成）。 */
function resolveProtocolOperation(protocolId, model, intent) {
  const v2 = v2ModelDefinition(protocolId);
  const def = legacyManifestDefinition(protocolId);
  const v2Profile = v2 ? profileEntry(v2, model) : undefined;
  if (v2 && (v2Profile || !def)) return manifestDomain.resolveOperation(v2, model, intent);
  if (!def) return null;
  const manifest = legacyModelProfile(protocolId, model, def);
  const operationId = manifest.defaultOperations[intent] || pickOperation(def, manifest.capabilities, undefined, intent);
  const operation = asRecord(asRecord(def.operations)[operationId]);
  return operationId && Object.keys(operation).length ? { id: operationId, operation } : null;
}

/** server/protocolManifest.ts:354 resolveParameterSchema（v2 + legacy 合成）。 */
function resolveProtocolParameterSchema(protocolId, model, intent) {
  const v2 = v2ModelDefinition(protocolId);
  const def = legacyManifestDefinition(protocolId);
  const v2Profile = v2 ? profileEntry(v2, model) : undefined;
  if (v2 && (v2Profile || !def)) {
    try { return manifestDomain.resolveParameterSchema(v2, model, intent); } catch { return null; }
  }
  if (!def) return null;
  const manifest = legacyModelProfile(protocolId, model, def);
  const limits = manifestDomain.effectiveLimits(manifest.limits, intent);
  const operation = resolveProtocolOperation(protocolId, model, intent);
  const uiSchemaId = operation ? resolveLegacyUiSchemaId(protocolId, operation.id, model, def) : null;
  if (uiSchemaId) {
    const fields = (asRecord(def.uiSchemas)[uiSchemaId] || []).filter((field) => fieldVisibleForModel(field, model));
    const limited = manifestDomain.applyLimitsToFields(fields, limits);
    return {
      protocolId: manifestProtocolId(protocolId), model, intent,
      operationId: operation ? operation.id : intent,
      operation: operation ? operation.operation : {},
      schemaId: uiSchemaId, source: "uiSchema", fields: limited,
      defaults: { ...manifest.defaults, ...manifestDomain.schemaDefaults(limited) }, limits,
    };
  }
  const group = manifestDomain.capabilityGroup(intent);
  const fields = (asRecord(def.paramSchema)[group] || []).filter((field) => fieldVisibleForModel(field, model));
  if (!fields.length) return null;
  const limited = manifestDomain.applyLimitsToFields(fields, limits);
  return {
    protocolId: manifestProtocolId(protocolId), model, intent,
    operationId: operation ? operation.id : intent,
    operation: operation ? operation.operation : {},
    schemaId: manifestProtocolId(protocolId) + "." + group, source: "paramSchema", fields: limited,
    defaults: { ...manifest.defaults, ...manifestDomain.schemaDefaults(limited) }, limits,
  };
}

// ---------------------------------------------------------------------------
// 候选评分与路由（modelResolver.ts:24-249）
// ---------------------------------------------------------------------------

function providerUsable(provider) {
  if (!provider || !provider.enabled) return false;
  if (provider.source === "cli") return !!provider.cli_tool;
  return !!(provider.base_url && (!providerRequiresApiKey(provider.protocol) || provider.api_key));
}

function coarseForIntent(intent) {
  if (String(intent).startsWith("image.")) return "image";
  if (String(intent).startsWith("video.")) return "video";
  return "llm";
}

function capabilitySort(provider, intent) {
  const coarse = coarseForIntent(intent);
  return provider.cap_sort?.[intent] ?? provider.cap_sort?.[coarse] ?? provider.sort ?? 999999;
}

function modelSort(model, intent) {
  const coarse = coarseForIntent(intent);
  return model.cap_sort?.[intent] ?? model.cap_sort?.[coarse] ?? 999999;
}

function capsFromModelEntry(model) {
  return (model.caps || []).flatMap((cap) => COARSE_TO_INTENTS[cap] || [cap]);
}

function capabilityFamily(capability) {
  const value = String(capability || "");
  if (value.startsWith("llm.")) return "llm";
  if (value.startsWith("image.")) return "image";
  if (value.startsWith("video.")) return "video";
  if (value.startsWith("audio.")) return "audio";
  return value.split(".")[0];
}

function requestRequirements(request) {
  const mapped = manifestDomain.taskIntentRequirement(request.taskIntent, request.intent);
  const requiresAll = unique([...(mapped.requiresAll || []), ...(request.requiresAll || [])]);
  const requiresAny = unique([...(mapped.requiresAny || []), ...(request.requiresAny || [])]);
  if (!requiresAll.length && !requiresAny.length && request.intent) requiresAll.push(request.intent);
  return {
    requiresAll,
    requiresAny,
    taskIntent: request.taskIntent || mapped.taskIntent,
    intent: request.intent || requiresAll[0] || requiresAny[0] || "llm.chat",
  };
}

function preferredWeight(provider, model, preferredModels) {
  let best = 0;
  for (const preferred of preferredModels) {
    if (preferred.providerId && preferred.providerId !== provider.id) continue;
    if (preferred.model !== model.model) continue;
    best = Math.max(best, preferred.weight ?? 100);
  }
  return best;
}

function candidateFor(provider, model, request) {
  const protocolId = model.protocol || provider.protocol;
  const manifest = resolveProtocolModelProfile(protocolId, model.model);
  const imageReferenceLimit = Number(asRecord(asRecord(asRecord(manifest.limits).references).images).max);
  const explicitlyTextOnly = Number.isFinite(imageReferenceLimit) && imageReferenceLimit === 0;
  const storedCapabilities = unique([
    ...capsFromModelEntry(model),
    ...(provider.source !== "cli" && (model.caps || []).includes("image") ? ["image.edit"] : []),
    ...(provider.source !== "cli" && (model.caps || []).includes("llm") && !explicitlyTextOnly ? ["llm.chat.vision"] : []),
  ]);
  const declaredFamilies = new Set(storedCapabilities.map(capabilityFamily));
  const authoritativeFamilies = new Set(Object.entries(asRecord(manifest.capabilitySources))
    .filter(([, source]) => source === "profile")
    .map(([capability]) => capabilityFamily(capability)));
  const toolOperation = provider.source !== "cli" && declaredFamilies.has("llm")
    ? resolveProtocolOperation(protocolId, model.model, "llm.tools")
    : null;
  const adapterCapabilities = toolOperation?.id === "llm.tools" && (!authoritativeFamilies.size || authoritativeFamilies.has("llm"))
    ? ["llm.tools"]
    : [];
  const capabilities = unique([...(manifest.capabilities || []), ...storedCapabilities, ...adapterCapabilities]);
  const { requiresAll, requiresAny, intent } = requestRequirements(request);
  const requestedFamilies = new Set([...requiresAll, ...requiresAny, intent].map(capabilityFamily));
  const declaredFamilyMatch = !declaredFamilies.size || [...declaredFamilies].some((family) => requestedFamilies.has(family));
  const authoritativeFamilyMatch = !authoritativeFamilies.size || [...authoritativeFamilies].some((family) => requestedFamilies.has(family));
  const anySatisfied = !requiresAny.length || requiresAny.some((capability) => capabilities.includes(capability));
  const required = unique([...requiresAll, ...(requiresAny.length && anySatisfied ? [] : requiresAny)]);
  const satisfied = unique([...requiresAll, ...requiresAny].filter((capability) => capabilities.includes(capability)));
  const missing = required.filter((capability) => !capabilities.includes(capability));
  // 源的"第一项"语义：显式首选 > preferredModels > strict 的 provider/model 指定。
  const preferredModels = [
    ...(request.preferredModel ? [{ model: request.preferredModel, weight: 100 }] : []),
    ...(request.preferredModels || []),
    ...(request.model && request.fallbackPolicy !== "compatible" ? [{ providerId: request.providerId, model: request.model, weight: 1000 }] : []),
  ];
  const preference = preferredWeight(provider, model, preferredModels);
  const matchScore = satisfied.length * 100;
  const primaryIntent = intent || satisfied[0] || requiresAll[0] || requiresAny[0] || "llm.chat";
  const score = preference + matchScore - (missing.length * 100000) - modelSort(model, primaryIntent) - capabilitySort(provider, primaryIntent) - (provider.sort || 0);
  return {
    provider,
    model,
    capabilities,
    satisfied,
    missing,
    score,
    reasons: [
      provider.name + "/" + model.model + " 支持 " + (capabilities.join(", ") || "未声明能力"),
      satisfied.length ? "满足能力：" + satisfied.join(", ") : "未匹配到目标能力",
    ],
    warnings: missing.length ? ["缺少能力：" + missing.join(", ")] : [],
    familyMatch: declaredFamilyMatch && authoritativeFamilyMatch,
    preference,
    modelPriority: modelSort(model, primaryIntent),
    providerPriority: capabilitySort(provider, primaryIntent),
  };
}

function candidateAllowedByRequest(candidate, request, fallbackPolicy) {
  if (fallbackPolicy !== "strict") return true;
  if (request.providerId && candidate.provider.id !== request.providerId) return false;
  if (request.model && candidate.model.model !== request.model) return false;
  return true;
}

function accessFilterOf(options) {
  return options && typeof options.apiModelAccessFilter === "function" ? options.apiModelAccessFilter : () => true;
}

function resolveCandidateSet(providers, request, options) {
  const allowed = accessFilterOf(options);
  const fallbackPolicy = request.fallbackPolicy || (request.providerId || request.model ? "strict" : "best_available");
  const candidates = (Array.isArray(providers) ? providers : [])
    .filter(providerUsable)
    .flatMap((provider) => (provider.models || [])
      .filter((model) => allowed(provider.id, model.model))
      .map((model) => candidateFor(provider, model, request))
      .filter((candidate) => candidate.familyMatch && candidateAllowedByRequest(candidate, request, fallbackPolicy)))
    .sort((a, b) => a.missing.length - b.missing.length
      || b.satisfied.length - a.satisfied.length
      || b.preference - a.preference
      || a.modelPriority - b.modelPriority
      || a.providerPriority - b.providerPriority
      || b.score - a.score);
  return { candidates, request, fallbackPolicy };
}

function routeFromCandidate(candidate, request, allCandidates) {
  const { intent } = requestRequirements(request);
  const protocolId = candidate.model.protocol || candidate.provider.protocol;
  const operation = resolveProtocolOperation(protocolId, candidate.model.model, intent);
  const alternatives = allCandidates
    .filter((item) => item !== candidate && !item.missing.length)
    .slice(0, 5)
    .map((item) => ({ providerId: item.provider.id, providerName: item.provider.name, model: item.model.model, reason: item.reasons.join("；") }));
  return {
    providerId: candidate.provider.id,
    providerName: candidate.provider.name,
    provider: {
      id: candidate.provider.id,
      base_url: candidate.provider.base_url,
      api_key: candidate.provider.api_key,
      protocol: protocolId,
    },
    model: candidate.model.model,
    intent,
    operationId: operation?.id || intent,
    operation: operation?.operation || {},
    defaults: resolveProtocolModelProfile(protocolId, candidate.model.model).defaults,
    satisfied: candidate.satisfied,
    missing: candidate.missing,
    reasons: candidate.reasons,
    warnings: candidate.warnings,
    alternatives,
  };
}

function resolveModelFromProviders(providers, request = {}, options = {}) {
  const { candidates, fallbackPolicy } = resolveCandidateSet(providers, request, options);
  if (!candidates.length) {
    throw routeError(MODEL_ROUTE_NO_CANDIDATE, "没有可用的模型站点：请在「API 设置」中启用模型站点", { reason: "no-usable-provider" });
  }
  const exact = candidates.find((candidate) => !candidate.missing.length);
  if (exact) return routeFromCandidate(exact, request, candidates);
  const alternatives = candidates
    .filter((candidate) => candidate.satisfied.length)
    .slice(0, 5)
    .map((candidate) => candidate.provider.name + "/" + candidate.model.model + "：" + candidate.warnings.join("；"));
  if (fallbackPolicy === "strict") {
    const missing = (candidates[0] && candidates[0].missing.join(", ")) || "未知能力";
    throw routeError(MODEL_ROUTE_STRICT_CAPABILITY, "指定模型不支持所需能力：" + missing
      + (alternatives.length ? "。可选替代：" + alternatives.join("；") : ""), { missing: candidates[0] ? candidates[0].missing : [] });
  }
  return routeFromCandidate(candidates[0], request, candidates);
}

/** 返回满足同一组硬要求的有序路由链（首选 + 回退），不是单个模型。 */
function resolveModelRoutesFromProviders(providers, request = {}, options = {}) {
  const { candidates } = resolveCandidateSet(providers, request, options);
  const exact = candidates.filter((candidate) => !candidate.missing.length);
  if (!exact.length) return [resolveModelFromProviders(providers, request, options)];
  return exact.map((candidate) => routeFromCandidate(candidate, request, candidates));
}

// ---------------------------------------------------------------------------
// modelDescriptor.ts 的 Agent 所需子集（capabilityTargetResolver 依赖）
// ---------------------------------------------------------------------------

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function referenceInputRule(limits, kind) {
  const rule = asRecord(asRecord(limits.references)[kind]);
  return {
    ...(numberOrUndefined(rule.min) == null ? {} : { min: numberOrUndefined(rule.min) }),
    ...(numberOrUndefined(rule.max) == null ? {} : { max: numberOrUndefined(rule.max) }),
  };
}

/** server/modelDescriptor.ts:135 的 v2 子集：目标解析只需要 available/capabilities/operation/parameters/inputs。 */
function resolveModelDescriptor({ provider, model, intent, references = {} } = {}) {
  const providerRecord = provider && typeof provider === "object" ? provider : {};
  const modelRecord = model && typeof model === "object" ? model : { model: String(model || "") };
  const modelId = String(modelRecord.model || "");
  const protocolId = String(modelRecord.protocol || legacyProtocols.suggestModelProtocol(providerRecord.protocol, modelId) || providerRecord.protocol || "").trim().toLowerCase();
  const reasons = [];
  let manifest;
  try { manifest = resolveProtocolModelProfile(protocolId, modelId); }
  catch (error) { manifest = { capabilities: [], limits: {}, defaults: {}, capabilitySources: {} }; reasons.push(String((error && error.message) || error)); }
  const imageReferenceMax = Number(asRecord(asRecord(asRecord(manifest.limits).references).images).max);
  const explicitlyTextOnly = Number.isFinite(imageReferenceMax) && imageReferenceMax === 0;
  const modelCaps = Array.isArray(modelRecord.caps) ? modelRecord.caps.map(String) : [];
  const apiCaps = [
    ...(providerRecord.source !== "cli" && modelCaps.includes("image") ? ["image.generate", "image.edit"] : []),
    ...(providerRecord.source !== "cli" && modelCaps.includes("llm") && !explicitlyTextOnly ? ["llm.chat", "llm.chat.vision"] : []),
  ];
  const capabilities = unique([...(manifest.capabilities || []).map(String), ...modelCaps.flatMap((cap) => COARSE_TO_INTENTS[cap] || []), ...apiCaps]);
  const operation = resolveProtocolOperation(protocolId, modelId, intent);
  const parameters = resolveProtocolParameterSchema(protocolId, modelId, intent);
  const limits = asRecord(manifest.limits);
  const available = providerRecord.enabled !== false && capabilities.includes(intent) && !!operation && !reasons.length;
  return {
    providerId: providerRecord.id,
    model: modelId,
    protocolId,
    profileId: manifest.profileId,
    capabilities,
    intent,
    operation: operation ? { id: operation.id, ...operation.operation } : null,
    inputs: {
      images: referenceInputRule(limits, "images"),
      videos: referenceInputRule(limits, "videos"),
      audios: referenceInputRule(limits, "audios"),
      files: referenceInputRule(limits, "files"),
    },
    parameters: parameters ? {
      schemaId: parameters.schemaId,
      source: parameters.source,
      fields: parameters.fields,
      defaults: parameters.defaults,
      limits: parameters.limits,
    } : null,
    limits,
    execution: {
      available,
      mode: available ? "declarative" : "unavailable",
      reasons: available ? [] : [...reasons, ...(capabilities.includes(intent) ? [] : ["模型未声明能力「" + intent + "」。"]), ...(operation ? [] : ["协议未声明「" + intent + "」对应的 operation。"])],
    },
  };
}

// ---------------------------------------------------------------------------
// 装配工件：注入 agent-kernel 的 modelResolver / modelDescriptor / providers / store
// ---------------------------------------------------------------------------

/**
 * 由 provider-protocol bundle（{ store, service }）构造 Agent 内核的数据层依赖。
 *   · providers()：store.listInternal()（带真实 key，仅主进程内使用；路由返回值过 agent 脱敏）
 *   · store.applyModelOrders：本仓尚无 modelOrders 设置存储 → 原序返回（不伪造排序）
 *   · modelResolver / modelDescriptor：上面的移植实现
 * 未注入 providerProtocol.store 时 providers() 返回 []（路由会结构化报"没有可用模型站点"）。
 */
function createModelResolverBundle({ providerProtocol = null, providers = null, apiModelAccessFilter = null } = {}) {
  const store = providerProtocol && providerProtocol.store ? providerProtocol.store : null;
  const listProviders = typeof providers === "function"
    ? providers
    : store && typeof store.listInternal === "function"
      ? () => store.listInternal()
      : () => [];
  const resolverOptions = { apiModelAccessFilter };
  return {
    providers: listProviders,
    store: {
      applyModelOrders: (items) => (Array.isArray(items) ? items.slice() : []),
    },
    modelResolver: {
      resolveModelFromProviders: (items, request) => resolveModelFromProviders(items, request, resolverOptions),
      resolveModelRoutesFromProviders: (items, request) => resolveModelRoutesFromProviders(items, request, resolverOptions),
    },
    modelDescriptor: { resolveModelDescriptor },
  };
}

module.exports = {
  MODEL_ROUTE_NO_CANDIDATE,
  MODEL_ROUTE_STRICT_CAPABILITY,
  providerUsable,
  requestRequirements,
  candidateFor,
  resolveCandidateSet,
  resolveModelFromProviders,
  resolveModelRoutesFromProviders,
  resolveProtocolModelProfile,
  resolveProtocolOperation,
  resolveProtocolParameterSchema,
  resolveModelDescriptor,
  createModelResolverBundle,
};
