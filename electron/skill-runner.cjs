"use strict";
/**
 * B4a2 · 技能执行器（CJS 移植）。
 *
 * 来源：server/skills.ts:705-2298（图像/视频/音频选型 + 各内置技能实现 + runSkill + procedure 小循环）。
 * electron/skill-store.cjs（B4a1）已移植 skills.ts:1-703（目录 / 存储 / agent 工具聚合 / chat 与 vision 选型），
 * 本文件从 705 行起，逐函数对照源行号。
 *
 * 逐字对应（源行号）：
 *   · resolveImageTarget / isJimengCliProvider / resolveImageUpscaleTarget / resolveMidjourneyTarget  skills.ts:706-798
 *   · imageOptions                     skills.ts:800-802
 *   · resolveVideoTarget               skills.ts:805-836
 *   · resolveAudioTarget / audioOptions  skills.ts:838-867
 *   · SkillImage / saveImagesToFs      skills.ts:870-922
 *   · SkillVideo / SkillAudio / saveAudiosToFs  skills.ts:924-969
 *   · mediaExt                         skills.ts:971-987
 *   · saveVideosToFs                   skills.ts:989-1039
 *   · resolveImageBytes                skills.ts:1041-1065
 *   · saveJimengImageUrls / saveJimengVideoUrls  skills.ts:1067-1073
 *   · runUpscaleImage                  skills.ts:1075-1110
 *   · MIDJOURNEY_OPERATIONS / runMidjourney  skills.ts:1112-1213
 *   · extensionMime / isMediaMime / parseDataMedia / resolveMediaBytes  skills.ts:1215-1272
 *   · SubmittedAgentTaskError          skills.ts:1274
 *   · executeDeclarativeSkillTask / runDeclarative*Skill  skills.ts:1276-1399, 1693-1717, 1734-1770（委托 B5 媒体）
 *   · runGenerateImage                 skills.ts:1401-1463
 *   · VideoRefDraft / normalizeVideoRefs / runGenerateVideo  skills.ts:1465-1681
 *   · executeImageEdit                 skills.ts:1683-1691
 *   · runTextToSpeech                  skills.ts:1719-1732
 *   · runTranscribeAudio               skills.ts:1772-1795
 *   · runGenerateMusic                 skills.ts:1797-1813
 *   · runEditImage                     skills.ts:1815-1842
 *   · combinations / buildGroups / runPool / runBatchImage  skills.ts:1844-2004
 *   · runDescribeImage                 skills.ts:2006-2020
 *   · genImageToBuffer / generateMusicArtwork / generateArtistsArtwork  skills.ts:2022-2096
 *   · runSkill / runSkillWithQuota     skills.ts:2098-2134
 *   · withTransientRetry / procedureTools / runProcedureSkill  skills.ts:2145-2298
 *   · protocolParamsFromAgentArgs      shared/agentProtocolParams.ts:1-12（纯函数，直接内置）
 *
 * 【云与商业化删除记录】按 B4 架构决策逐条移除并注明源行号：
 *   · skills.ts:42  import { downloadDxosAiOutput, DXOS_AI_PROVIDER_ID, getDxosAiJob, submitDxosAiJob } from './dxosProtocol.ts'
 *       —— dxosProtocol = 云端 AI 任务（DX Credits），属 OUT。
 *   · skills.ts:1412-1446  runGenerateImage 里的 DXOS_AI_PROVIDER_ID 云端任务分支（submitDxosAiJob /
 *       getDxosAiJob / downloadDxosAiOutput）整段删除；DXOS_AI_PROVIDER_ID 常量已不存在，
 *       该分支条件永假，删除后行为等价于"永不进入云端分支"。
 *   · skills.ts:44  import { assertMeteredApiQuotaEntry, isApiModelAllowed, withApiQuotaOwner } from './apiQuota.ts'
 *       —— apiQuota = 计费/配额门禁，属 OUT。逐处删除点：
 *         :1096 / :1123（upscale / midjourney 提交前配额断言）
 *         :1413（DXOS 分支，随整段删除）
 *         :1453 / :1616 / :1685（即梦 CLI 调用前配额断言）
 *         :2104 runSkill 的 withApiQuotaOwner(userId, ...) 包装改为直接调用 runSkillWithQuota。
 *       :716 / :816 的 isApiModelAllowed 过滤：apiQuota 不存在，改为不过滤（等价于全部模型允许），见对应行注释。
 *   · cloudEntitlement（权益 / 会员门禁）在 skills.ts:705-2298 未被引用，本文件同样不引入。
 *
 * 【依赖注入】configureSkillRunner({ skillStore, providerAdapter, modelAdapter, cliRuntime,
 *   mediaAdapter, fsAdapter, libraryAdapter, artworkAdapter, clock, logger, fetchImpl })
 *   · skillStore        B4a1 electron/skill-store.cjs（listSkills / resolveChatTarget / resolveVisionTarget /
 *                       SKILLS / PROCEDURE_BASE_SKILL_IDS）。未注入时惰性 require 同目录 skill-store.cjs。
 *   · providerAdapter   provider/store 只读适配器，形状与 skill-store 一致：
 *                         { firstUsable(kind), all(), autoFallback(), revealProvider(id),
 *                           describeModel?(provider, model, intent), modelProfile?(provider, model) }
 *                       源 resolveImageTarget/resolveVideoTarget/resolveAudioTarget/resolveImageUpscaleTarget/
 *                       resolveMidjourneyTarget 依赖 server/store.ts + modelDescriptor.ts + protocolManifest.ts；
 *                       这三个模块不在 B4 冻结清单内，因此改为可注入描述器：未提供 describeModel 时按"可用"处理，
 *                       未提供 modelProfile 时按 entry.caps / entry.protocol 判定。未注入 providerAdapter 抛结构化错误。
 *   · modelAdapter      B2 provider-protocol-service.call，形状 { call({ providerId, model, messages, tools,
 *                       params, stream, signal, onEvent }) }；返回 { ok, text, toolCalls, usage } 或
 *                       { ok:false, error }。文本技能（chat/writing/rewrite/code/analysis）与 procedure 小循环走它。
 *   · cliRuntime        B3 agent-cli-tools.cjs / agent-cli-bridge.cjs（即梦图像/放大/视频与查询、tempMediaFile、
 *                       JimengPendingError）。源 skills.ts 只引用即梦（codex/gemini 图像不在本文件调用点）。
 *   · mediaAdapter      B5 媒体（server/protocols.ts：generateImages / generateVideos / editImages /
 *                       submitMidjourney / getMidjourneyTask / submitMidjourneyAction / submitMidjourneyModal /
 *                       describeImage / generateSpeech / transcribeAudio / generateMusic）以及可选
 *                       validateProtocolParameters 与 runDeclarative*Skill（server/ai-tasks 声明式路由）。
 *                       未注入（或缺少被调用的方法）时返回结构化 AGENT_DEPENDENCY_UNAVAILABLE，绝不伪造产物。
 *   · fsAdapter         B6 fs.ts 虚拟文件树
 *                         { ensureFolder, resolvePath, createNode, saveBlob, readBlob, getNode, findByPath }。
 *                       未注入时落盘 / 解析引用返回结构化 AGENT_DEPENDENCY_UNAVAILABLE，不返回假路径。
 *   · libraryAdapter / artworkAdapter  B5 library.ts（artworkTargets / putArtwork / scan）；两者任一可用即可。
 *   · clock             缺省 Date.now()；logger 可选；fetchImpl 可选（缺省 globalThis.fetch）。
 *
 * 【取消】源 SkillRunOptions 无 signal。本文件追加可选 opts.signal（AbortSignal）：
 *   runSkill 入口与 procedure 每轮循环检查，已中止抛 ABORT_ERR；并透传给 modelAdapter.call。
 *
 * 对外契约（agent-react-driver.cjs:972 按此调用）：
 *   skillAdapter = { runSkill(id, args, opts) }；opts 形状 = SkillRunOptions。
 */

const { randomUUID } = require("node:crypto");

/** 依赖后续批次 / 未注入适配器时的结构化错误码（与 skill-store.cjs:65 / skill-import.cjs:40 一致）。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

// ── 注入中心 ────────────────────────────────────────────────────────────
let skillRunner = {
  skillStore: null,
  providerAdapter: null,
  modelAdapter: null,
  cliRuntime: null,
  mediaAdapter: null,
  fsAdapter: null,
  libraryAdapter: null,
  artworkAdapter: null,
  clock: null,
  logger: null,
  fetchImpl: null,
};

function emptySkillRunner() {
  return {
    skillStore: null, providerAdapter: null, modelAdapter: null, cliRuntime: null,
    mediaAdapter: null, fsAdapter: null, libraryAdapter: null, artworkAdapter: null,
    clock: null, logger: null, fetchImpl: null,
  };
}

/** 注入执行依赖（未给出的键保持不变；重置用 resetSkillRunnerForTests）。 */
function configureSkillRunner(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw dependencyUnavailable("configureSkillRunner", "配置必须是对象");
  }
  for (const key of Object.keys(skillRunner)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) skillRunner[key] = patch[key];
  }
  return getSkillRunnerConfig();
}

/** 仅供测试：清空全部注入，恢复"未接入"状态。 */
function resetSkillRunnerForTests() {
  skillRunner = emptySkillRunner();
  lazySkillStore = null;
  return getSkillRunnerConfig();
}

function getSkillRunnerConfig() {
  return Object.assign({}, skillRunner);
}

function dependencyUnavailable(name, detail) {
  const error = new Error("技能执行依赖不可用：" + String(name));
  error.name = "AgentDependencyUnavailableError";
  error.code = AGENT_DEPENDENCY_UNAVAILABLE;
  error.dependency = String(name);
  if (detail !== undefined) error.detail = detail;
  return error;
}

function abortError() {
  const error = new Error("技能执行已取消");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function assertNotAborted(options) {
  if (options && options.signal && options.signal.aborted) throw abortError();
}

/**
 * B7j：模型站点解析失败是"依赖 / 前置缺失"，不是内部错误。
 * skill-store.resolveChatTarget / resolveVisionTarget 在"没有可启用站点"时抛的是普通 Error；
 * 这里把它归一成带 code 的依赖缺失错误（保留原始人话原因），由 skill-service.toSkillError
 * 转成 SKILL_DEPENDENCY_UNAVAILABLE，detail 指明缺的是 modelSite。
 */
function modelSiteUnavailable(cause) {
  const message = String((cause && cause.message) || cause) || "没有可用的模型站点";
  const error = new Error(message);
  error.name = "AgentDependencyUnavailableError";
  error.code = AGENT_DEPENDENCY_UNAVAILABLE;
  error.dependency = "modelSite";
  error.detail = "没有可用的模型站点：请先在「系统设置 › 模型与服务商」里添加并启用一个站点（Base URL / Key / 至少一个模型）";
  return error;
}

function resolveChatTargetOrFail(options) {
  try {
    return getSkillStore().resolveChatTarget(options);
  } catch (cause) {
    if (cause && cause.code) throw cause;
    throw modelSiteUnavailable(cause);
  }
}

function resolveVisionTargetOrFail(options) {
  try {
    return getSkillStore().resolveVisionTarget(options);
  } catch (cause) {
    if (cause && cause.code) throw cause;
    throw modelSiteUnavailable(cause);
  }
}

// ── 适配器访问器 ────────────────────────────────────────────────────────
let lazySkillStore = null;

/** 显式注入优先，其次惰性 require 同目录 skill-store.cjs（B4a1）。 */
function getSkillStore() {
  if (skillRunner.skillStore) return skillRunner.skillStore;
  if (lazySkillStore) return lazySkillStore;
  try {
    lazySkillStore = require("./skill-store.cjs");
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND" && /skill-store\.cjs/.test(String(error.message))) {
      throw dependencyUnavailable("skillStore", "electron/skill-store.cjs 尚未接入（B4a1 并行波次）");
    }
    throw error;
  }
  return lazySkillStore;
}

function requireProviderAdapter() {
  const adapter = skillRunner.providerAdapter;
  if (!adapter) {
    throw dependencyUnavailable("providerAdapter", "provider/store 只读适配器未注入（firstUsable/all/revealProvider/autoFallback）");
  }
  return adapter;
}

function requireModelAdapter() {
  const adapter = skillRunner.modelAdapter;
  if (!adapter || typeof adapter.call !== "function") {
    throw dependencyUnavailable("modelAdapter", "B2 provider-protocol-service.call 未注入");
  }
  return adapter;
}

function requireCli() {
  const cli = skillRunner.cliRuntime;
  if (!cli) throw dependencyUnavailable("cliRuntime", "B3 CLI 运行时未接入");
  return cli;
}

function requireMedia() {
  const media = skillRunner.mediaAdapter;
  if (!media) {
    throw dependencyUnavailable("mediaAdapter", "B5 媒体波次未接入（server/protocols.ts 生成调用）");
  }
  return media;
}

function mediaMethod(name) {
  const media = requireMedia();
  if (typeof media[name] !== "function") {
    throw dependencyUnavailable("mediaAdapter." + name, "B5 媒体波次未提供该方法");
  }
  return media[name].bind(media);
}

function declarativeMethodOrNull(name) {
  const media = skillRunner.mediaAdapter;
  if (!media || typeof media[name] !== "function") return null;
  return media[name].bind(media);
}

function requireFs() {
  const fsx = skillRunner.fsAdapter;
  if (!fsx) throw dependencyUnavailable("fsAdapter", "B6 虚拟文件树未接入（fs.ts）");
  return fsx;
}

function artworkAdapterOrNull() {
  return skillRunner.artworkAdapter || skillRunner.libraryAdapter || null;
}

function requireArtwork() {
  const adapter = artworkAdapterOrNull();
  if (!adapter) throw dependencyUnavailable("artworkAdapter", "library.ts（B5）未接入");
  return adapter;
}

function now() {
  return skillRunner.clock ? Number(skillRunner.clock()) : Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFetch() {
  if (typeof skillRunner.fetchImpl === "function") return skillRunner.fetchImpl;
  return globalThis.fetch;
}

function logEvent(level, message, meta) {
  const logger = skillRunner.logger;
  if (!logger) return;
  try {
    if (typeof logger === "function") logger(level, message, meta);
    else if (typeof logger[level] === "function") logger[level](message, meta);
    else if (typeof logger.log === "function") logger.log(level, message, meta);
  } catch (error) {
    // 日志失败不影响技能执行
    void error;
  }
}

/** shared/agentProtocolParams.ts:1-12 逐字：排除 Surface 传输字段，保留全部 Target 参数，normalized 覆盖。 */
function protocolParamsFromAgentArgs(args, excluded, normalized) {
  const blocked = new Set(excluded || []);
  const out = {};
  for (const entry of Object.entries(args || {})) {
    if (!blocked.has(entry[0]) && entry[1] !== undefined) out[entry[0]] = entry[1];
  }
  return Object.assign(out, normalized || {});
}

// ── 模型调用出口（源 callChat / chatWithTools → B2 provider-protocol-service.call）──
function modelCallFailure(response) {
  const detail = response && (response.detail || response.error);
  return new Error("模型调用失败：" + String(detail || "UNKNOWN"));
}

/** skills.ts:2131 callChat(provider, model, { prompt, system }, {}, 180000) 的 B2 投影。 */
async function callChat(provider, model, request, options, timeoutMs) {
  const adapter = requireModelAdapter();
  const startedAt = now();
  const response = await adapter.call({
    providerId: provider && provider.id ? provider.id : undefined,
    model: model,
    messages: [{ role: "user", content: request && request.prompt ? request.prompt : "" }],
    params: request && request.system ? { system: request.system } : {},
    stream: false,
    signal: options && options.signal ? options.signal : undefined,
    onEvent: options && options.onEvent ? options.onEvent : undefined,
  });
  if (response && response.ok === false) throw modelCallFailure(response);
  void timeoutMs;
  return {
    text: response ? response.text : "",
    latencyMs: now() - startedAt,
    usage: response ? response.usage : undefined,
  };
}

/** skills.ts:2235 chatWithTools(provider, model, messages, system, tools, 240000) 的 B2 投影。 */
async function chatWithTools(provider, model, messages, system, tools, timeoutMs, options) {
  const adapter = requireModelAdapter();
  const response = await adapter.call({
    providerId: provider && provider.id ? provider.id : undefined,
    model: model,
    messages: messages,
    tools: tools,
    params: system ? { system: system } : {},
    stream: false,
    signal: options && options.signal ? options.signal : undefined,
    onEvent: options && options.onEvent ? options.onEvent : undefined,
  });
  if (response && response.ok === false) throw modelCallFailure(response);
  void timeoutMs;
  const rawCalls = (response && response.toolCalls) || [];
  const toolCalls = rawCalls.map((call) => {
    const fn = call && call.function ? call.function : {};
    const name = call && call.name ? call.name : fn.name;
    let argsValue = call && call.arguments !== undefined ? call.arguments : fn.arguments;
    if (typeof argsValue !== "string") argsValue = JSON.stringify(argsValue === undefined ? {} : argsValue);
    return { id: call && call.id ? call.id : randomUUID(), name: name, arguments: argsValue };
  });
  return { content: String((response && response.text) || ""), toolCalls: toolCalls };
}

// ── 图像 / 视频 / 音频 provider 选型（skills.ts:706-867）─────────────────
function isJimengCliProvider(provider) {
  return provider.protocol === "cli:jimeng" || (provider.source === "cli" && provider.cli_tool === "jimeng");
}

/**
 * skills.ts:706-735 resolveImageTarget。
 * :716 源 provider.models.filter((entry) => isApiModelAllowed(p.id, entry.model)) 属 apiQuota（OUT），
 * 已按 B4a1 同规则移除过滤（等价于全部模型允许）。
 */
function resolveImageTarget(opts, requiredIntent) {
  const options = opts || {};
  const intent = requiredIntent === undefined ? "image.generate" : requiredIntent;
  const adapter = requireProviderAdapter();
  const pickFrom = (p) => {
    const isCli = p && (p.source === "cli" || String((p && p.protocol) || "").startsWith("cli:"));
    // provider-adapter-bridge.cjs 的只读投影用 has_key / has_wallet_key 取代真值密钥。
    if (!p || !p.enabled || (!isCli && (!(p.api_key || p.has_key) || !p.base_url))) return null;
    const models = p.models || [];
    const filtered = options.model
      ? models.filter((entry) => entry.model === options.model)
      : models.filter((entry) => (entry.caps || []).includes("image"));
    return filtered.map((entry) => ({ p: p, entry: entry, descriptor: describeModel(p, entry, intent) }));
  };
  const preferred = options.providerId ? adapter.revealProvider(String(options.providerId)) : adapter.firstUsable("image");
  const candidates = [preferred].concat((adapter.all() || []).filter((p) => !preferred || p.id !== preferred.id));
  const choices = candidates.flatMap((provider) => pickFrom(provider) || []);
  const hit = choices.find((choice) => choice.descriptor && choice.descriptor.execution && choice.descriptor.execution.available) || choices[0];
  if (!hit) {
    throw new Error("没有可用的图像模型。请在「系统设置 › 模型与服务商」里添加 OpenAI 兼容站点，并把一个图像模型的能力标为「图像」。");
  }
  return {
    provider: { id: hit.p.id, base_url: hit.p.base_url, api_key: hit.p.api_key, protocol: hit.entry.protocol || hit.p.protocol },
    site: hit.p,
    model: hit.entry.model,
    providerName: hit.p.name,
    descriptor: hit.descriptor,
  };
}

/**
 * skills.ts:696 / :718 / :818 / :849 resolveModelDescriptor({ provider, model, intent }).
 * modelDescriptor.ts 不在 B4 冻结清单：providerAdapter.describeModel 可选注入，未注入按"执行可用"处理。
 */
function describeModel(provider, model, intent) {
  const adapter = skillRunner.providerAdapter;
  if (adapter && typeof adapter.describeModel === "function") {
    const descriptor = adapter.describeModel(provider, model, intent);
    if (descriptor) return descriptor;
  }
  return { execution: { available: true } };
}

/** skills.ts:757 / :779 resolveProtocolModelProfile(...)：protocolManifest.ts 不在 B4 冻结清单，可注入。 */
function modelProfile(provider, entry) {
  const adapter = skillRunner.providerAdapter;
  if (adapter && typeof adapter.modelProfile === "function") {
    const profile = adapter.modelProfile(provider, entry);
    if (profile) return profile;
  }
  return { protocolId: (entry && entry.protocol) || provider.protocol, capabilities: (entry && entry.caps) || [] };
}

/** skills.ts:741-765 */
function resolveImageUpscaleTarget(opts) {
  const options = opts || {};
  const adapter = requireProviderAdapter();
  const preferred = options.providerId ? adapter.revealProvider(String(options.providerId)) : adapter.firstUsable("image");
  const candidates = options.providerId
    ? [preferred]
    : [preferred].concat((adapter.all() || []).filter((provider) => provider.id !== (preferred && preferred.id)));
  for (const provider of candidates) {
    if (!provider || !provider.enabled) continue;
    const models = provider.models || [];
    const ordered = options.model
      ? models.filter((entry) => entry.model === options.model).concat(models.filter((entry) => entry.model !== options.model))
      : models;
    const entry = ordered.find((candidate) => {
      try {
        return (modelProfile(provider, candidate).capabilities || []).includes("image.upscale");
      } catch (error) {
        void error;
        return isJimengCliProvider(provider);
      }
    });
    if (entry) return { provider: provider, model: entry.model, providerName: provider.name };
  }
  throw new Error("没有可用的图片放大模型。请在「系统设置 › 模型与服务商」中启用支持 image.upscale 的模型（当前支持即梦 CLI）。");
}

/** skills.ts:767-798 */
function resolveMidjourneyTarget(opts) {
  const options = opts || {};
  const adapter = requireProviderAdapter();
  const pickFrom = (provider) => {
    if (!provider || !provider.enabled || !(provider.api_key || provider.has_key) || !provider.base_url) return null;
    const models = provider.models || [];
    const ordered = options.model
      ? models.filter((entry) => entry.model === options.model).concat(models.filter((entry) => entry.model !== options.model))
      : models;
    const entry = ordered.find((candidate) => {
      try {
        const profile = modelProfile(provider, candidate);
        return profile.protocolId === "midjourney"
          || (profile.capabilities || []).includes("image.blend")
          || (profile.capabilities || []).includes("image.pan");
      } catch (error) {
        void error;
        return /(^|[-_./\s])(midjourney|mj)([-_./\s]|$)|\bniji\b/i.test(candidate.model);
      }
    });
    return entry && entry.model ? { provider: provider, model: entry.model } : null;
  };
  const preferred = options.providerId ? adapter.revealProvider(String(options.providerId)) : adapter.firstUsable("image");
  const candidates = [preferred].concat((adapter.all() || []).filter((provider) => provider.id !== (preferred && preferred.id)));
  const hit = candidates.map(pickFrom).find((candidate) => !!candidate);
  if (!hit) {
    throw new Error("没有可用的 Midjourney 模型。请在「系统设置 › 模型与服务商」中添加并启用 Midjourney / APIMart 模型协议。");
  }
  return {
    provider: { base_url: hit.provider.base_url, api_key: hit.provider.api_key, protocol: "midjourney" },
    model: hit.model,
    providerName: hit.provider.name,
  };
}

/** skills.ts:800-802 */
function imageOptions(opts) {
  const options = opts || {};
  return { providerId: options.imageProviderId || options.providerId, model: options.imageModel || options.model };
}

/** skills.ts:805-836 */
function resolveVideoTarget(opts, requiredIntent) {
  const options = opts || {};
  const intent = requiredIntent === undefined ? "video.generate" : requiredIntent;
  const adapter = requireProviderAdapter();
  const pickFrom = (p) => {
    const isCli = p && (p.source === "cli" || String((p && p.protocol) || "").startsWith("cli:"));
    const hasCredential = isCli ? true : (p && p.protocol === "runninghub" ? !!(p.wallet_api_key || p.has_wallet_key) : !!(p && (p.api_key || p.has_key)));
    if (!p || !p.enabled || !hasCredential || (!isCli && !p.base_url)) return null;
    // skills.ts:816 isApiModelAllowed 过滤属 apiQuota（OUT），已移除（等价于全部允许）。
    const videoModels = (p.models || []).filter((m) => (m.caps || []).includes("video"));
    const entries = options.model ? videoModels.filter((entry) => entry.model === options.model) : videoModels;
    return entries.map((entry) => ({ p: p, entry: entry, descriptor: describeModel(p, entry, intent) }));
  };
  const preferred = options.providerId ? null : adapter.firstUsable("video");
  const candidates = options.providerId
    ? [adapter.revealProvider(String(options.providerId))]
    : [preferred].concat((adapter.all() || []).filter((p) => p.id !== (preferred && preferred.id)));
  const choices = candidates.flatMap((provider) => pickFrom(provider) || []);
  const hit = choices.find((choice) => choice.descriptor && choice.descriptor.execution && choice.descriptor.execution.available) || choices[0];
  if (!hit) {
    throw new Error("没有可用的视频模型。请在「系统设置 › 模型与服务商」里添加站点，并把至少一个模型的能力标为「视频」。");
  }
  return {
    provider: { id: hit.p.id, base_url: hit.p.base_url, api_key: hit.p.api_key, wallet_api_key: hit.p.wallet_api_key, protocol: hit.entry.protocol || hit.p.protocol },
    site: hit.p,
    model: hit.entry.model,
    providerName: hit.p.name,
    descriptor: hit.descriptor,
  };
}

/** skills.ts:838-863 */
function resolveAudioTarget(opts, requiredIntent) {
  const options = opts || {};
  const intent = requiredIntent === undefined ? "audio.tts" : requiredIntent;
  const adapter = requireProviderAdapter();
  const pickFrom = (provider) => {
    if (!provider || !provider.enabled || !(provider.api_key || provider.has_key) || !provider.base_url) return null;
    const audioModels = (provider.models || []).filter((entry) => (entry.caps || []).includes("audio"));
    const entries = options.model ? audioModels.filter((entry) => entry.model === options.model) : audioModels;
    return entries.map((entry) => ({ provider: provider, entry: entry, descriptor: describeModel(provider, entry, intent) }));
  };
  const preferred = options.providerId ? adapter.revealProvider(String(options.providerId)) : adapter.firstUsable("audio");
  const candidates = options.providerId
    ? [preferred]
    : [preferred].concat((adapter.all() || []).filter((provider) => provider.id !== (preferred && preferred.id)));
  const choices = candidates.flatMap((provider) => pickFrom(provider) || []);
  const hit = choices.find((choice) => choice.descriptor && choice.descriptor.execution && choice.descriptor.execution.available) || choices[0];
  if (!hit) throw new Error("没有支持 " + intent + " 的音频模型。请在「系统设置 › 模型与服务商」中添加音频模型并设置正确协议。");
  return {
    provider: { base_url: hit.provider.base_url, api_key: hit.provider.api_key, protocol: hit.entry.protocol || hit.provider.protocol },
    site: hit.provider,
    model: hit.entry.model,
    providerName: hit.provider.name,
    descriptor: hit.descriptor,
  };
}

/** skills.ts:865-867 */
function audioOptions(opts) {
  const options = opts || {};
  return { providerId: options.audioProviderId, model: options.audioModel };
}

// ── 产物落盘（skills.ts:869-1039；fs.ts 属 B6，经 fsAdapter 注入）──────────
/** skills.ts:870-874 SkillImage。 */

/** skills.ts:878-922 把图像接口返回的 url/b64 落地到虚拟文件系统。 */
async function saveImagesToFs(images, target) {
  const fsx = requireFs();
  let parentId;
  let baseName = "";
  let baseExt = "";
  const rootId = target && target.rootId !== undefined ? target.rootId : null;
  if (target && target.path) {
    const resolved = fsx.resolvePath(rootId, target.path, true);
    parentId = resolved.parentId;
    const leaf = resolved.leaf;
    const dot = leaf.lastIndexOf(".");
    baseName = dot > 0 ? leaf.slice(0, dot) : leaf;
    baseExt = dot > 0 ? leaf.slice(dot + 1) : "";
  } else {
    parentId = fsx.ensureFolder("生成图片", rootId);
  }
  const many = images.length > 1;
  const ts = now();
  const saved = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    let buf;
    let mime = "image/png";
    if (img.type === "b64") {
      buf = Buffer.from(img.value, "base64");
    } else {
      const resp = await getFetch()(img.value);
      if (!resp.ok) throw new Error("下载生成图失败：HTTP " + resp.status);
      mime = (resp.headers.get("content-type") || "").split(";")[0].trim() || "image/png";
      buf = Buffer.from(await resp.arrayBuffer());
    }
    const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
    let filename;
    if (baseName) {
      const useExt = baseExt || ext;
      filename = many ? baseName + "-" + (i + 1) + "." + useExt : baseName + "." + useExt;
    } else {
      filename = "img_" + ts + "_" + (i + 1) + "." + ext;
    }
    const node = fsx.createNode({ name: filename, type: "file", parentId: parentId, mime: mime, size: buf.length });
    fsx.saveBlob(node.id, buf);
    saved.push({ nodeId: node.id, name: node.name, url: "/api/fs/raw/" + node.id });
  }
  return saved;
}

/** skills.ts:936-969 */
async function saveAudiosToFs(audios, target) {
  const fsx = requireFs();
  let parentId;
  let baseName = "";
  let baseExt = "";
  const rootId = target && target.rootId !== undefined ? target.rootId : null;
  if (target && target.path) {
    const resolved = fsx.resolvePath(rootId, target.path, true);
    parentId = resolved.parentId;
    const dot = resolved.leaf.lastIndexOf(".");
    baseName = dot > 0 ? resolved.leaf.slice(0, dot) : resolved.leaf;
    baseExt = dot > 0 ? resolved.leaf.slice(dot + 1) : "";
  } else {
    parentId = fsx.ensureFolder("生成音频", rootId);
  }
  const saved = [];
  for (let i = 0; i < audios.length; i++) {
    const item = audios[i];
    let data = item.data;
    let mime = item.mime || "audio/mpeg";
    if (!data && item.url) {
      const response = await getFetch()(item.url);
      if (!response.ok) throw new Error("下载生成音频失败：HTTP " + response.status);
      data = Buffer.from(await response.arrayBuffer());
      mime = (response.headers.get("content-type") || mime).split(";")[0];
    }
    if (!data) continue;
    const ext = mediaExt(mime, item.url || "");
    const name = baseName
      ? baseName + (audios.length > 1 ? "-" + (i + 1) : "") + "." + (baseExt || ext)
      : "audio_" + now() + "_" + (i + 1) + "." + ext;
    const node = fsx.createNode({ name: name, type: "file", parentId: parentId, mime: mime, size: data.length });
    fsx.saveBlob(node.id, data);
    saved.push({ nodeId: node.id, name: node.name, url: "/api/fs/raw/" + node.id });
  }
  return saved;
}

/** skills.ts:971-987 */
function mediaExt(mime, value) {
  const byMime = {
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg",
  };
  const normalized = String(mime || "").split(";")[0].trim().toLowerCase();
  if (byMime[normalized]) return byMime[normalized];
  const match = String(value || "").split(/[?#]/, 1)[0].match(/\.([a-z0-9]{2,5})$/i);
  return (match && match[1] ? match[1].toLowerCase() : "mp4");
}

/** skills.ts:989-1039 */
async function saveVideosToFs(videos, target) {
  const fsx = requireFs();
  let parentId;
  let baseName = "";
  let baseExt = "";
  const rootId = target && target.rootId !== undefined ? target.rootId : null;
  if (target && target.path) {
    const resolved = fsx.resolvePath(rootId, target.path, true);
    parentId = resolved.parentId;
    const dot = resolved.leaf.lastIndexOf(".");
    baseName = dot > 0 ? resolved.leaf.slice(0, dot) : resolved.leaf;
    baseExt = dot > 0 ? resolved.leaf.slice(dot + 1) : "";
  } else {
    parentId = fsx.ensureFolder("生成视频", rootId);
  }
  const many = videos.length > 1;
  const ts = now();
  const saved = [];
  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const value = video.type === "url" ? String(video.value || "").trim() : "";
    if (video.type === "url" && !value) continue;
    let buf;
    let mime = "video/mp4";
    if (video.type === "data") {
      buf = video.data;
      mime = video.mime || mime;
    } else if (value.startsWith("data:") && value.includes(";base64,")) {
      const parts = value.split(";base64,", 2);
      mime = parts[0].slice(5) || mime;
      buf = Buffer.from(parts[1], "base64");
    } else {
      if (!/^https?:\/\//i.test(value)) throw new Error("视频接口返回了无法下载的地址：" + value.slice(0, 120));
      const resp = await getFetch()(value);
      if (!resp.ok) throw new Error("下载生成视频失败：HTTP " + resp.status);
      mime = (resp.headers.get("content-type") || "").split(";")[0].trim() || mime;
      buf = Buffer.from(await resp.arrayBuffer());
    }
    const ext = mediaExt(mime, value);
    const filename = baseName
      ? baseName + (many ? "-" + (i + 1) : "") + "." + (baseExt || ext)
      : "video_" + ts + "_" + (i + 1) + "." + ext;
    const node = fsx.createNode({ name: filename, type: "file", parentId: parentId, mime: mime, size: buf.length });
    fsx.saveBlob(node.id, buf);
    saved.push({ nodeId: node.id, name: node.name, url: "/api/fs/raw/" + node.id });
  }
  return saved;
}

/** skills.ts:1041-1065 */
async function resolveImageBytes(ref, rootId) {
  const s = String(ref === undefined || ref === null ? "" : ref).trim();
  if (!s) throw new Error("空图片引用");
  const m = s.match(/\/api\/fs\/raw\/([0-9a-f-]{36})/i);
  let nodeId = m ? m[1] : (/^[0-9a-f-]{36}$/i.test(s) ? s : "");
  if (!nodeId && !/^https?:\/\//i.test(s) && rootId !== undefined) {
    const node = requireFs().findByPath(rootId === undefined || rootId === null ? null : rootId, s);
    if (node) nodeId = node.id;
  }
  if (nodeId) {
    const fsx = requireFs();
    const node = fsx.getNode(nodeId);
    const buf = fsx.readBlob(nodeId);
    if (!node || !buf) throw new Error("找不到图片：" + s);
    return { buf: buf, mime: node.mime || "image/png", name: node.name || "image.png" };
  }
  if (/^https?:\/\//i.test(s)) {
    const resp = await getFetch()(s);
    if (!resp.ok) throw new Error("下载参考图失败：HTTP " + resp.status);
    const mime = (resp.headers.get("content-type") || "").split(";")[0].trim() || "image/png";
    return { buf: Buffer.from(await resp.arrayBuffer()), mime: mime, name: "ref." + (mime.includes("jpeg") ? "jpg" : "png"), publicUrl: s };
  }
  throw new Error("无法识别的图片引用：" + s.slice(0, 80));
}

/** skills.ts:1067-1069 */
async function saveJimengImageUrls(urls, rootId, path) {
  const target = { rootId: rootId === undefined ? null : rootId };
  if (path) target.path = path;
  return saveImagesToFs(urls.map((value) => ({ type: "url", value: value })), target);
}

/** skills.ts:1071-1073 */
async function saveJimengVideoUrls(urls, rootId, path) {
  const target = { rootId: rootId === undefined ? null : rootId };
  if (path) target.path = path;
  return saveVideosToFs(urls.map((value) => ({ type: "url", value: value })), target);
}

function isJimengPending(error) {
  const Ctor = skillRunner.cliRuntime ? skillRunner.cliRuntime.JimengPendingError : null;
  return !!Ctor && error instanceof Ctor;
}

// ── upscale_image（skills.ts:1075-1110）─────────────────────────────────
async function runUpscaleImage(args, opts) {
  const options = opts || {};
  const operation = String(args.operation || "upscale").trim().toLowerCase();
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const target = resolveImageUpscaleTarget(imageOptions(options));
  const provider = target.provider;
  const model = target.model;
  const providerName = target.providerName;
  if (!isJimengCliProvider(provider)) throw new Error("当前图片放大执行器仅支持即梦 CLI。");
  const cli = requireCli();

  if (operation === "status") {
    const submitId = String(args.submit_id || "").trim();
    if (!submitId) throw new Error("status 操作需要 submit_id");
    const queried = await cli.queryJimengMedia(submitId, "image");
    if (queried.status === "failed") throw new Error("即梦图片放大失败：" + (queried.error || "未知错误"));
    if (queried.status !== "succeeded") {
      return { text: queried.message || "即梦图片放大仍在排队（submit_id: " + submitId + "）。", meta: { model: model, provider: providerName, submitId: submitId, status: queried.status, operation: operation } };
    }
    const saved = await saveJimengImageUrls(queried.urls, options.rootId, path);
    return { text: "即梦图片放大已完成（submit_id: " + submitId + "），已保存 " + saved.length + " 张图片。", meta: { model: model, provider: providerName, submitId: submitId, status: "succeeded", operation: operation }, images: saved };
  }
  if (operation !== "upscale") throw new Error("不支持的图片放大 operation");
  // skills.ts:1096 assertMeteredApiQuotaEntry() —— apiQuota（OUT）已删除。
  const image = await resolveImageBytes(args.image, options.rootId);
  const resolutionValue = String(args.resolution || "").toLowerCase();
  const resolution = ["2k", "4k", "8k"].includes(resolutionValue) ? resolutionValue : "2k";
  const temp = cli.tempMediaFile(image.buf, image.mime, ".png");
  try {
    const result = await cli.upscaleJimengImage(temp, resolution, { pollSeconds: 120, deferPending: true });
    const saved = await saveJimengImageUrls(result.images, options.rootId, path);
    return { text: "图片已放大到 " + resolution.toUpperCase() + "，并保存 " + saved.length + " 张结果。", meta: { model: model, provider: providerName, submitId: result.submit_id, status: "succeeded", resolution: resolution, operation: operation }, images: saved };
  } catch (error) {
    if (isJimengPending(error)) {
      return { text: "即梦图片放大仍在排队（submit_id: " + error.submit_id + "），稍后可用 status 续查。", meta: { model: model, provider: providerName, submitId: error.submit_id, status: "pending", resolution: resolution, operation: operation } };
    }
    throw error;
  }
}

// ── midjourney（skills.ts:1112-1213）────────────────────────────────────
const MIDJOURNEY_OPERATIONS = new Set([
  "imagine", "blend", "edit", "upscale", "variation", "low_variation", "high_variation",
  "reroll", "zoom", "pan", "inpaint", "remix_subtle", "remix_strong", "status",
]);

async function runMidjourney(args, opts) {
  const options = opts || {};
  const operation = String(args.operation || "").trim().toLowerCase();
  if (!MIDJOURNEY_OPERATIONS.has(operation)) throw new Error("缺少或不支持 Midjourney operation");
  // skills.ts:1123 if (operation !== 'status') assertMeteredApiQuotaEntry() —— apiQuota（OUT）已删除。
  const target = resolveMidjourneyTarget(imageOptions(options));
  const provider = target.provider;
  const model = target.model;
  const providerName = target.providerName;
  const taskIdInput = String(args.task_id || "").trim();
  const prompt = String(args.prompt || args.instruction || "").trim();
  const speed = String(args.speed || "relax").trim().toLowerCase();
  const shouldWait = args.wait !== false;
  const path = typeof args.path === "string" ? args.path.trim() : "";

  const finishTask = async (taskId, queryOnly) => {
    const getTask = mediaMethod("getMidjourneyTask");
    const deadline = now() + 600000;
    for (;;) {
      const task = await getTask(provider, taskId, 180000);
      if (task.status === "failed") throw new Error(task.error || "Midjourney 任务失败");
      if (task.status === "succeeded") {
        const saveTarget = { rootId: options.rootId === undefined ? null : options.rootId };
        if (path) saveTarget.path = path;
        const saved = task.images.length ? await saveImagesToFs(task.images, saveTarget) : [];
        const where = path ? "已按路径「" + path + "」保存" : "保存在「生成图片」文件夹";
        return {
          text: saved.length
            ? "Midjourney 任务已完成（task_id: " + taskId + "），" + where + "：\n" + saved.map((image) => "- " + image.name).join("\n")
            : "Midjourney 任务已完成（task_id: " + taskId + "），但没有返回图片。",
          meta: { model: model, provider: providerName, taskId: taskId, status: task.status, operation: operation },
          ...(saved.length ? { images: saved } : {}),
        };
      }
      if (queryOnly) {
        return { text: "Midjourney 任务仍在运行（task_id: " + taskId + "）。", meta: { model: model, provider: providerName, taskId: taskId, status: task.status, operation: operation } };
      }
      if (now() >= deadline) throw new Error("Midjourney 任务等待超时（task_id: " + taskId + "），可稍后使用 status 查询。");
      await sleep(2500);
    }
  };

  if (operation === "status") {
    if (!taskIdInput) throw new Error("status 操作需要 task_id");
    return finishTask(taskIdInput, true);
  }

  let taskId = "";
  let submittedStatus = "queued";
  if (["imagine", "blend", "edit"].includes(operation)) {
    if (operation !== "blend" && !prompt) throw new Error(operation + " 操作需要 prompt");
    const refsRaw = Array.isArray(args.image) ? args.image : (args.image ? [args.image] : []);
    const referenceImages = await Promise.all(refsRaw.map((ref) => resolveImageBytes(ref, options.rootId)));
    const submitted = await mediaMethod("submitMidjourney")(provider, model, {
      prompt: prompt,
      size: String(args.size || "1:1"),
      version: String(args.version || model),
      speed: speed,
      mode: operation,
      reference_images: referenceImages,
    }, 180000);
    taskId = submitted.taskId;
    submittedStatus = submitted.status;
  } else if (operation === "inpaint") {
    if (!taskIdInput) throw new Error("inpaint 操作需要 task_id");
    if (!args.mask_image) throw new Error("inpaint 操作需要 mask_image");
    const mask = await resolveImageBytes(args.mask_image, options.rootId);
    const submitted = await mediaMethod("submitMidjourneyModal")(provider, {
      task_id: taskIdInput, prompt: prompt, speed: speed, mask_image: mask,
    }, 180000);
    taskId = submitted.taskId;
    submittedStatus = submitted.status;
  } else {
    if (!taskIdInput) throw new Error(operation + " 操作需要 task_id");
    const submitted = await mediaMethod("submitMidjourneyAction")(provider, {
      task_id: taskIdInput,
      action: operation,
      index: args.index === undefined ? undefined : Number(args.index),
      speed: speed,
      direction: String(args.direction || ""),
      zoom_ratio: args.zoom_ratio === undefined ? undefined : Number(args.zoom_ratio),
      custom_id: String(args.custom_id || ""),
      prompt: prompt,
    }, 180000);
    taskId = submitted.taskId;
    submittedStatus = submitted.status;
  }

  if (!shouldWait) {
    return {
      text: "Midjourney 任务已提交（task_id: " + taskId + "，状态：" + submittedStatus + "）。",
      meta: { model: model, provider: providerName, taskId: taskId, status: submittedStatus, operation: operation },
    };
  }
  return finishTask(taskId, false);
}

// ── 媒体引用解析（skills.ts:1215-1272）──────────────────────────────────
/** skills.ts:1215-1223 */
function extensionMime(name, fallback) {
  const match = String(name || "").toLowerCase().split(/[?#]/, 1)[0].match(/\.([a-z0-9]{2,5})$/);
  const ext = match && match[1] ? match[1] : "";
  const map = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", mkv: "video/x-matroska",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac",
  };
  return map[ext] || fallback;
}

/** skills.ts:1225-1227 */
function isMediaMime(mime, kind) {
  return mime.startsWith(kind + "/") || mime === "application/octet-stream" || mime === "";
}

/** skills.ts:1229-1237 */
function parseDataMedia(ref, kind) {
  if (!ref.startsWith("data:")) return null;
  const match = ref.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/i);
  if (!match) throw new Error("媒体 data URL 格式无效");
  const mime = match[1] || (kind + "/*");
  if (!isMediaMime(mime, kind)) throw new Error("引用的媒体不是" + (kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"));
  const buf = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]));
  return { buf: buf, mime: mime, name: "reference." + mediaExt(mime) };
}

/** skills.ts:1240-1272 */
async function resolveMediaBytes(ref, rootId, kind) {
  const s = String(ref === undefined || ref === null ? "" : ref).trim();
  const kindLabel = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
  if (!s) throw new Error("空" + kindLabel + "引用");
  const data = parseDataMedia(s, kind);
  if (data) return data;
  const m = s.match(/\/api\/fs\/raw\/([0-9a-f-]{36})/i);
  let nodeId = m ? m[1] : (/^[0-9a-f-]{36}$/i.test(s) ? s : "");
  if (!nodeId && !/^https?:\/\//i.test(s) && rootId !== undefined) {
    const node = requireFs().findByPath(rootId === undefined || rootId === null ? null : rootId, s);
    if (node) nodeId = node.id;
  }
  if (nodeId) {
    const fsx = requireFs();
    const node = fsx.getNode(nodeId);
    const buf = fsx.readBlob(nodeId);
    if (!node || node.type !== "file" || !buf) throw new Error("找不到媒体：" + s);
    const mime = node.mime || extensionMime(node.name, "application/octet-stream");
    if (!isMediaMime(mime, kind)) throw new Error("「" + node.name + "」不是" + kindLabel);
    return { buf: buf, mime: mime, name: node.name || "reference." + mediaExt(mime) };
  }
  if (/^https?:\/\//i.test(s)) {
    const resp = await getFetch()(s);
    if (!resp.ok) throw new Error("下载参考" + kindLabel + "失败：HTTP " + resp.status);
    const mime = (resp.headers.get("content-type") || "").split(";")[0].trim() || extensionMime(s, "application/octet-stream");
    if (!isMediaMime(mime, kind)) throw new Error("远程引用不是" + kindLabel);
    const name = decodeURIComponent(new URL(s).pathname.split("/").pop() || ("reference." + mediaExt(mime, s)));
    return { buf: Buffer.from(await resp.arrayBuffer()), mime: mime, name: name, publicUrl: s };
  }
  throw new Error("无法识别的" + kindLabel + "引用：" + s.slice(0, 100));
}

// ── 声明式任务（skills.ts:1274-1399 / 1693-1717 / 1734-1770）──
// server/ai-tasks/* 不在 B4 冻结清单，属 B5 媒体波次。这里只做"路由可用性判定"：
// mediaAdapter.runDeclarative*Skill 存在则调用，否则返回 null（等价源 route.mode !== 'declarative'，
// 调用方随即回退 legacy 协议分支）。
class SubmittedAgentTaskError extends Error {}

async function runDeclarativeImageSkill(input) {
  const fn = declarativeMethodOrNull("runDeclarativeImageSkill");
  if (!fn) return null;
  return fn(input);
}

async function runDeclarativeVideoSkill(input) {
  const fn = declarativeMethodOrNull("runDeclarativeVideoSkill");
  if (!fn) return null;
  return fn(input);
}

async function runDeclarativeAudioSkill(input) {
  const fn = declarativeMethodOrNull("runDeclarativeAudioSkill");
  if (!fn) return null;
  return fn(input);
}

async function runDeclarativeTranscriptionSkill(input) {
  const fn = declarativeMethodOrNull("runDeclarativeTranscriptionSkill");
  if (!fn) return null;
  return fn(input);
}

/**
 * skills.ts:1617 / :1645 validateProtocolParameters(provider.protocol, model, intent, params, counts)。
 * protocolManifest.ts 不在 B4 冻结清单：mediaAdapter.validateProtocolParameters 可选注入，未注入跳过（记录日志）。
 */
function validateProtocolParametersCompat(provider, model, intent, params, counts) {
  const media = skillRunner.mediaAdapter;
  if (media && typeof media.validateProtocolParameters === "function") {
    return media.validateProtocolParameters(provider.protocol, model, intent, params, counts);
  }
  logEvent("debug", "validateProtocolParameters skipped（protocolManifest 未接入）", { protocol: provider.protocol, model: model, intent: intent });
  return undefined;
}

// ── generate_image（skills.ts:1401-1463）────────────────────────────────
async function runGenerateImage(args, opts) {
  const options = opts || {};
  const prompt = String((args && args.prompt) != null ? args.prompt : (args && args.instruction) != null ? args.instruction : "").trim();
  if (!prompt) throw new Error("缺少 prompt（要画什么）");
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const size = typeof args.size === "string" && IMAGE_SIZES.includes(args.size) ? String(args.size) : "1024x1024";
  const n = Math.max(1, Math.min(4, Number(args.n) || 1));

  // skills.ts:1412-1446 DXOS_AI_PROVIDER_ID 云端 AI 任务分支整段删除（dxosProtocol OUT）：
  //   源涉及 requested.providerId === DXOS_AI_PROVIDER_ID 时的 submitDxosAiJob / getDxosAiJob /
  //   downloadDxosAiOutput 轮询与落盘。删除后无云端路径，直接走本地 provider 选型。
  const target = resolveImageTarget(imageOptions(options));
  const provider = target.provider;
  const site = target.site;
  const model = target.model;
  const providerName = target.providerName;

  const declarative = await runDeclarativeImageSkill({
    site: site, model: model, prompt: prompt, size: size, count: n, ownerId: options.userId,
    params: protocolParamsFromAgentArgs(args, ["prompt", "instruction", "path", "size", "n", "image", "images"]),
  });
  // skills.ts:1453 if (!declarative && isJimengCliProvider(provider)) assertMeteredApiQuotaEntry() —— apiQuota（OUT）已删除。
  let images;
  if (declarative && declarative.images) {
    images = declarative.images;
  } else if (isJimengCliProvider(provider)) {
    const result = await requireCli().generateJimengImage(prompt, model, size);
    images = (result.images || []).map((value) => ({ type: "url", value: value }));
  } else {
    const result = await mediaMethod("generateImages")(provider, model, { prompt: prompt, size: size, n: n });
    images = result.images || [];
  }
  if (!images.length) throw new Error("图像接口调用成功，但未返回任何图片");

  const saveTarget = { rootId: options.rootId === undefined ? null : options.rootId };
  if (path) saveTarget.path = path;
  const saved = await saveImagesToFs(images, saveTarget);
  const where = path ? "已按路径「" + path + "」保存" : "保存在「生成图片」文件夹";
  const text = "已生成 " + saved.length + " 张图片，" + where + "：\n" + saved.map((s) => "- " + s.name + ": " + s.url).join("\n");
  return {
    text: text,
    meta: Object.assign(
      { model: model, provider: providerName, size: size, count: saved.length, executor: (declarative && declarative.executor) || "legacy" },
      declarative && declarative.taskId ? { taskId: declarative.taskId } : {},
    ),
    images: saved,
  };
}

// ── generate_video（skills.ts:1465-1681）────────────────────────────────
/** skills.ts:1470-1486 */
function normalizeVideoRefs(raw, defaultRole) {
  const role = defaultRole === undefined ? "" : defaultRole;
  const items = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]);
  return items
    .map((item) => {
      if (typeof item === "string") {
        const ref = item.trim();
        return ref ? Object.assign({ ref: ref }, role ? { role: role } : {}) : null;
      }
      if (!item || typeof item !== "object") return null;
      const ref = String(item.ref != null ? item.ref : item.url != null ? item.url : item.path != null ? item.path : item.id != null ? item.id : "").trim();
      if (!ref) return null;
      const picked = String(item.role != null ? item.role : role).trim();
      return Object.assign({ ref: ref }, picked ? { role: picked } : {});
    })
    .filter((item) => !!item);
}

async function runGenerateVideo(args, opts) {
  const options = opts || {};
  const operation = String((args && args.operation) || "generate").trim().toLowerCase();
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (operation === "status") {
    const submitId = String(args.submit_id || "").trim();
    if (!submitId) throw new Error("status 操作需要 submit_id");
    const target = resolveVideoTarget(options);
    if (!isJimengCliProvider(target.provider)) throw new Error("当前视频任务续查仅支持即梦 CLI。");
    const queried = await requireCli().queryJimengMedia(submitId, "video");
    if (queried.status === "failed") throw new Error("即梦视频任务失败：" + (queried.error || "未知错误"));
    if (queried.status !== "succeeded") {
      return { text: queried.message || "即梦视频仍在排队（submit_id: " + submitId + "）。", meta: { model: target.model, provider: target.providerName, submitId: submitId, status: queried.status, operation: operation } };
    }
    const saved = await saveJimengVideoUrls(queried.urls, options.rootId, path);
    return { text: "即梦视频任务已完成（submit_id: " + submitId + "），已保存 " + saved.length + " 个视频。", meta: { model: target.model, provider: target.providerName, submitId: submitId, status: "succeeded", operation: operation }, videos: saved };
  }
  if (operation !== "generate") throw new Error("不支持的视频 operation");
  const prompt = String((args && args.prompt) != null ? args.prompt : (args && args.instruction) != null ? args.instruction : "").trim();
  if (!prompt) throw new Error("缺少 prompt（要生成什么视频）");

  const imageDrafts = [].concat(normalizeVideoRefs(args.images), normalizeVideoRefs(args.image), normalizeVideoRefs(args.first_frame, "first_frame"), normalizeVideoRefs(args.last_frame, "last_frame"));
  const videoDrafts = [].concat(normalizeVideoRefs(args.videos, "reference_video"), normalizeVideoRefs(args.video, "reference_video"), normalizeVideoRefs(args.reference_video, "reference_video"));
  const audioDrafts = [].concat(normalizeVideoRefs(args.audios, "reference_audio"), normalizeVideoRefs(args.audio, "reference_audio"), normalizeVideoRefs(args.reference_audio, "reference_audio"));

  const requestedMode = String(args.mode || "auto").trim();
  const explicitVideoIntents = {
    text_to_video: "video.text_to_video",
    image_to_video: "video.image_to_video",
    first_last_frame: "video.first_last_frame",
    multi_reference: "video.multi_reference",
    video_to_video: "video.video_to_video",
    audio_reference: "video.audio_reference",
    multimodal: "video.multimodal",
  };
  if (requestedMode !== "auto" && !explicitVideoIntents[requestedMode]) throw new Error("不支持的视频 mode：" + requestedMode);
  const hasFirstFrame = imageDrafts.some((item) => item.role === "first_frame");
  const hasLastFrame = imageDrafts.some((item) => item.role === "last_frame");
  const inferredIntent = requestedMode !== "auto"
    ? explicitVideoIntents[requestedMode]
    : args.multimodal === true
      ? "video.multimodal"
      : videoDrafts.length
        ? "video.video_to_video"
        : audioDrafts.length
          ? "video.audio_reference"
          : hasFirstFrame && hasLastFrame
            ? "video.first_last_frame"
            : imageDrafts.length > 1
              ? "video.multi_reference"
              : imageDrafts.length === 1
                ? "video.image_to_video"
                : "video.text_to_video";

  const resolveRefs = async (drafts, kind) =>
    Promise.all(
      drafts.slice(0, kind === "image" ? 9 : 3).map(async (draft) => {
        const media = await resolveMediaBytes(draft.ref, options.rootId === undefined ? null : options.rootId, kind);
        return Object.assign({}, media, { kind: kind }, draft.role ? { role: draft.role } : {});
      }),
    );

  const resolved = await Promise.all([resolveRefs(imageDrafts, "image"), resolveRefs(videoDrafts, "video"), resolveRefs(audioDrafts, "audio")]);
  const images = resolved[0];
  const videos = resolved[1];
  const audios = resolved[2];
  const duration = Math.max(1, Math.min(60, Number(args.duration) || 5));
  const aspectRatio = typeof args.aspect_ratio === "string"
    ? args.aspect_ratio
    : typeof args.aspectRatio === "string"
      ? args.aspectRatio
      : typeof args.size === "string"
        ? args.size
        : "16:9";
  const resolution = typeof args.resolution === "string" ? args.resolution : undefined;
  const seed = args.seed === undefined || args.seed === null ? undefined : Number(args.seed);

  const target = resolveVideoTarget(options, inferredIntent);
  const provider = target.provider;
  const site = target.site;
  const model = target.model;
  const providerName = target.providerName;
  const protocolParams = protocolParamsFromAgentArgs(args, [
    "prompt", "instruction", "path", "operation", "submit_id",
    "image", "images", "first_frame", "last_frame",
    "video", "videos", "reference_video", "audio", "audios", "reference_audio",
    "mode", "size", "aspectRatio", "camerafixed",
  ], Object.assign(
    {
      duration: duration,
      aspect_ratio: aspectRatio,
      generate_audio: args.generate_audio === true,
      enhance_prompt: args.enhance_prompt === true,
      camera_fixed: args.camera_fixed === true || args.camerafixed === true,
      watermark: args.watermark === true,
      enable_upsample: args.enable_upsample === true,
      return_last_frame: args.return_last_frame === true,
      multimodal: args.multimodal === true,
      trusted_asset: args.trusted_asset === true,
    },
    resolution ? { resolution: resolution } : {},
    Number.isFinite(seed) ? { seed: seed } : {},
  ));
  const references = [].concat(images, videos, audios);
  const declarative = isJimengCliProvider(provider) ? null : await runDeclarativeVideoSkill({
    site: site,
    model: model,
    intent: inferredIntent,
    prompt: prompt,
    params: protocolParams,
    references: references,
    ownerId: options.userId,
  });
  let generated;
  if (declarative) {
    generated = declarative.videos;
  } else if (isJimengCliProvider(provider)) {
    // skills.ts:1616 assertMeteredApiQuotaEntry() —— apiQuota（OUT）已删除。
    validateProtocolParametersCompat(provider, model, inferredIntent, protocolParams, { images: images.length, videos: videos.length, audios: audios.length });
    const cli = requireCli();
    const imagePaths = images.map((input) => cli.tempMediaFile(input.buf, input.mime, ".png"));
    const videoPaths = videos.map((input) => cli.tempMediaFile(input.buf, input.mime, ".mp4"));
    const audioPaths = audios.map((input) => cli.tempMediaFile(input.buf, input.mime, ".mp3"));
    try {
      const result = await cli.generateJimengVideo(prompt, model, {
        imagePaths: imagePaths,
        imageRoles: images.map((input) => input.role || "reference_image"),
        videoPaths: videoPaths,
        audioPaths: audioPaths,
        duration: duration,
        aspect_ratio: aspectRatio,
        resolution: resolution,
        multimodal: inferredIntent === "video.multimodal" || inferredIntent === "video.video_to_video" || inferredIntent === "video.audio_reference",
        pollSeconds: 120,
        deferPending: true,
      });
      generated = result.videos.map((value) => ({ type: "url", value: value }));
    } catch (error) {
      if (isJimengPending(error)) {
        return {
          text: "即梦视频仍在排队（submit_id: " + error.submit_id + "），稍后可用 status 续查。",
          meta: { capability: inferredIntent, model: model, provider: providerName, submitId: error.submit_id, status: "pending", operation: operation },
        };
      }
      throw error;
    }
  } else {
    validateProtocolParametersCompat(provider, model, inferredIntent, protocolParams, { images: images.length, videos: videos.length, audios: audios.length });
    const result = await mediaMethod("generateVideos")(provider, model, {
      prompt: prompt,
      duration: duration,
      size: typeof args.size === "string" ? args.size : undefined,
      aspect_ratio: aspectRatio,
      resolution: resolution,
      images: images,
      videos: videos,
      audios: audios,
      enhance_prompt: args.enhance_prompt === true,
      enable_upsample: args.enable_upsample === true,
      watermark: args.watermark === true,
      seed: Number.isFinite(seed) ? seed : undefined,
      camerafixed: args.camera_fixed === true || args.camerafixed === true,
      return_last_frame: args.return_last_frame === true,
      generate_audio: args.generate_audio === true,
      multimodal: args.multimodal === true,
      trusted_asset: args.trusted_asset === true,
    }, undefined, 900000);
    generated = result.videos;
  }
  if (!generated.length) throw new Error("视频接口调用成功，但未返回任何视频");

  const saveTarget = { rootId: options.rootId === undefined ? null : options.rootId };
  if (path) saveTarget.path = path;
  const saved = await saveVideosToFs(generated, saveTarget);
  const where = path ? "已按路径「" + path + "」保存" : "保存在「生成视频」文件夹";
  const refs = [
    images.length ? images.length + " 张图片" : "",
    videos.length ? videos.length + " 个参考视频" : "",
    audios.length ? audios.length + " 个参考音频" : "",
  ].filter(Boolean).join("、");
  const text = "已生成 " + saved.length + " 个视频，" + where + (refs ? "（使用" + refs + "）" : "") + "：\n" + saved.map((item) => "- " + item.name + ": " + item.url).join("\n");
  return {
    text: text,
    meta: Object.assign({
      capability: inferredIntent, model: model, provider: providerName, duration: duration, aspectRatio: aspectRatio,
      resolution: resolution || "", count: saved.length, imageRefs: images.length, videoRefs: videos.length,
      audioRefs: audios.length, executor: (declarative && declarative.executor) || "legacy",
    }, declarative && declarative.taskId ? { taskId: declarative.taskId } : {}),
    videos: saved,
  };
}

/** skills.ts:1683-1691 */
async function executeImageEdit(provider, model, prompt, size, n, inputs) {
  if (isJimengCliProvider(provider)) {
    // skills.ts:1685 assertMeteredApiQuotaEntry() —— apiQuota（OUT）已删除。
    const cli = requireCli();
    const paths = inputs.map((input) => cli.tempMediaFile(input.buf, input.mime, ".png"));
    const result = await cli.generateJimengImage(prompt, model, size, paths);
    return (result.images || []).map((value) => ({ type: "url", value: value }));
  }
  const result = await mediaMethod("editImages")(provider, model, { prompt: prompt, size: size, n: n }, inputs);
  return result.images || [];
}

// ── text_to_speech（skills.ts:1719-1732）────────────────────────────────
async function runTextToSpeech(args, opts) {
  const options = opts || {};
  const text = String(args.text || args.instruction || "").trim();
  if (!text) throw new Error("缺少要合成的文字");
  const target = resolveAudioTarget(audioOptions(options), "audio.tts");
  const provider = target.provider;
  const site = target.site;
  const model = target.model;
  const providerName = target.providerName;
  const format = String(args.format || "mp3").toLowerCase();
  const params = protocolParamsFromAgentArgs(args, ["text", "instruction", "path", "format"], {
    input: text, voice: String(args.voice || "alloy"), speed: Number(args.speed) || 1, response_format: format,
  });
  const declarative = await runDeclarativeAudioSkill({ site: site, model: model, intent: "audio.tts", prompt: text, params: params, ownerId: options.userId });
  let generated;
  if (declarative && declarative.audios) generated = declarative.audios;
  else generated = [await mediaMethod("generateSpeech")(provider, model, params)];
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const saveTarget = { rootId: options.rootId === undefined ? null : options.rootId };
  if (path) saveTarget.path = path;
  const audios = await saveAudiosToFs(generated, saveTarget);
  return {
    text: "语音合成完成，已保存 " + audios.length + " 个音频文件。",
    meta: Object.assign({ model: model, provider: providerName, format: format, count: audios.length, executor: (declarative && declarative.executor) || "legacy" }, declarative && declarative.taskId ? { taskId: declarative.taskId } : {}),
    audios: audios,
  };
}

// ── transcribe_audio（skills.ts:1772-1795）──────────────────────────────
async function runTranscribeAudio(args, opts) {
  const options = opts || {};
  const operation = String(args.operation || "transcribe").toLowerCase();
  if (!["transcribe", "translate"].includes(operation)) throw new Error("不支持的音频文字操作");
  const input = await resolveMediaBytes(args.audio, options.rootId, "audio");
  const intent = operation === "translate" ? "audio.translate" : "audio.transcribe";
  const target = resolveAudioTarget(audioOptions(options), intent);
  const provider = target.provider;
  const site = target.site;
  const model = target.model;
  const providerName = target.providerName;
  const params = protocolParamsFromAgentArgs(args, ["audio", "operation"], {
    language: String(args.language || ""),
    prompt: String(args.prompt || ""),
    response_format: String(args.response_format || "json"),
    temperature: args.temperature === null || args.temperature === undefined ? undefined : Number(args.temperature),
  });
  const declarative = await runDeclarativeTranscriptionSkill({
    site: site, model: model, intent: intent, prompt: params.prompt, params: params, audio: input, ownerId: options.userId,
  });
  const result = declarative || await mediaMethod("transcribeAudio")(provider, model, input, Object.assign({}, params, { translate: operation === "translate" }));
  return {
    text: result.text,
    meta: Object.assign({ model: model, provider: providerName, operation: operation, executor: (declarative && declarative.executor) || "legacy" }, declarative && declarative.taskId ? { taskId: declarative.taskId } : {}),
  };
}

// ── generate_music（skills.ts:1797-1813）────────────────────────────────
async function runGenerateMusic(args, opts) {
  const options = opts || {};
  const prompt = String(args.prompt || args.instruction || "").trim();
  if (!prompt) throw new Error("缺少音乐生成提示词");
  const target = resolveAudioTarget(audioOptions(options), "audio.music");
  const provider = target.provider;
  const site = target.site;
  const model = target.model;
  const providerName = target.providerName;
  const params = protocolParamsFromAgentArgs(args, ["prompt", "instruction", "path"], {
    prompt: prompt,
    title: String(args.title || ""),
    lyrics: String(args.lyrics || ""),
    style: String(args.style || ""),
    instrumental: args.instrumental === true,
  });
  const declarative = await runDeclarativeAudioSkill({ site: site, model: model, intent: "audio.music", prompt: prompt, params: params, ownerId: options.userId });
  let generated;
  if (declarative && declarative.audios) {
    generated = declarative.audios;
  } else {
    const music = await mediaMethod("generateMusic")(provider, model, params);
    generated = (music.audios || []).map((audio) => ({ url: audio.value }));
  }
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const saveTarget = { rootId: options.rootId === undefined ? null : options.rootId };
  if (path) saveTarget.path = path;
  const audios = await saveAudiosToFs(generated, saveTarget);
  return {
    text: "音乐生成完成，已保存 " + audios.length + " 个音频文件。",
    meta: Object.assign({ model: model, provider: providerName, count: audios.length, executor: (declarative && declarative.executor) || "legacy" }, declarative && declarative.taskId ? { taskId: declarative.taskId } : {}),
    audios: audios,
  };
}

// ── edit_image（skills.ts:1815-1842）────────────────────────────────────
async function runEditImage(args, opts) {
  const options = opts || {};
  const prompt = String((args && args.prompt) != null ? args.prompt : (args && args.instruction) != null ? args.instruction : "").trim();
  if (!prompt) throw new Error("缺少 prompt（要怎么改）");
  const raw = args && args.image !== undefined ? args.image : (args ? args.images : undefined);
  const refs = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x === undefined || x === null ? "" : x).trim()).filter(Boolean);
  if (!refs.length) throw new Error("缺少参考图（image）");
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const size = typeof args.size === "string" && IMAGE_SIZES.includes(args.size) ? String(args.size) : "1024x1024";
  const n = Math.max(1, Math.min(4, Number(args.n) || 1));

  const inputs = await Promise.all(refs.slice(0, 8).map((r) => resolveImageBytes(r, options.rootId === undefined ? null : options.rootId)));
  const target = resolveImageTarget(imageOptions(options), "image.edit");
  const provider = target.provider;
  const site = target.site;
  const model = target.model;
  const providerName = target.providerName;
  const declarative = await runDeclarativeImageSkill({
    site: site, model: model, intent: "image.edit",
    prompt: prompt, size: size, count: n, inputs: inputs, ownerId: options.userId,
    params: protocolParamsFromAgentArgs(args, ["prompt", "instruction", "path", "size", "n", "image", "images"]),
  });
  const images = (declarative && declarative.images) || await executeImageEdit(provider, model, prompt, size, n, inputs);
  if (!images.length) throw new Error("图像编辑成功，但未返回任何图片");

  const saveTarget = { rootId: options.rootId === undefined ? null : options.rootId };
  if (path) saveTarget.path = path;
  const saved = await saveImagesToFs(images, saveTarget);
  const where = path ? "已按路径「" + path + "」保存" : "保存在「生成图片」文件夹";
  const text = "已编辑生成 " + saved.length + " 张图片（参考图 " + inputs.length + " 张），" + where + "：\n" + saved.map((s) => "- " + s.name + ": " + s.url).join("\n");
  return {
    text: text,
    meta: Object.assign({ model: model, provider: providerName, size: size, count: saved.length, refs: inputs.length, executor: (declarative && declarative.executor) || "legacy" }, declarative && declarative.taskId ? { taskId: declarative.taskId } : {}),
    images: saved,
  };
}

// ── batch_image_group_process（skills.ts:1844-2004）─────────────────────
/** skills.ts:1859-1874 C(items, k) 组合（保序）。 */
function combinations(items, k) {
  const out = [];
  const pick = (start, cur) => {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i < items.length; i++) {
      cur.push(items[i]);
      pick(i + 1, cur);
      cur.pop();
    }
  };
  if (k >= 1 && k <= items.length) pick(0, []);
  return out;
}

/** skills.ts:1877-1893 */
function buildGroups(refs, mode, groupSize, remainder) {
  const gs = Math.max(1, groupSize);
  if (mode === "all_in_one") return refs.length ? [refs.slice()] : [];
  if (mode === "all_each") return refs.map((r) => [r]);
  if (mode === "combinations") return combinations(refs, gs);
  const groups = [];
  for (let i = 0; i < refs.length; i += gs) {
    const chunk = refs.slice(i, i + gs);
    if (chunk.length < gs) {
      if (remainder === "skip") continue;
      if (remainder === "error") throw new Error("最后剩余 " + chunk.length + " 张不足一组（groupSize=" + gs + "），remainderPolicy=error");
    }
    groups.push(chunk);
  }
  return groups;
}

/** skills.ts:1896-1908 简单并发池。 */
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function runBatchImage(args, opts) {
  const options = opts || {};
  const prompt = String((args && args.prompt) != null ? args.prompt : (args && args.instruction) != null ? args.instruction : "").trim();
  if (!prompt) throw new Error("缺少 prompt（对每组图片执行的编辑提示词）");
  const raw = args && args.image !== undefined ? args.image : (args ? args.images : undefined);
  const refs = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x === undefined || x === null ? "" : x).trim()).filter(Boolean);
  if (!refs.length) throw new Error("缺少待处理图片（image）");

  const mode = ["sequential", "all_each", "all_in_one", "combinations"].includes(args.groupMode) ? args.groupMode : "sequential";
  const groupSize = Math.max(1, Number(args.groupSize) || 1);
  const remainder = ["run", "skip", "error"].includes(args.remainderPolicy) ? args.remainderPolicy : "run";
  const concurrency = Math.max(1, Math.min(4, Number(args.concurrency) || 2));
  const rcRaw = Number(args.retryCount);
  const retryCount = Number.isFinite(rcRaw) ? Math.max(0, Math.min(5, rcRaw)) : 1;
  const maxRef = Math.max(1, Math.min(8, Number(args.maxReferenceImages) || 4));
  const failurePolicy = args.failurePolicy === "stop" ? "stop" : "continue";
  const size = typeof args.size === "string" && IMAGE_SIZES.includes(args.size) ? String(args.size) : "1024x1024";
  const n = Math.max(1, Math.min(4, Number(args.n) || 1));

  let groups = buildGroups(refs, mode, groupSize, remainder);
  if (!groups.length) throw new Error("按当前分组规则没有可执行的组");
  const cap = Number(args.maxGroups) > 0 ? Number(args.maxGroups) : (mode === "combinations" ? 200 : 0);
  let truncated = 0;
  if (cap && groups.length > cap) {
    truncated = groups.length - cap;
    groups = groups.slice(0, cap);
  }

  const byteMap = new Map();
  await Promise.all([...new Set(refs)].map(async (r) => byteMap.set(r, await resolveImageBytes(r, options.rootId === undefined ? null : options.rootId))));

  const target = resolveImageTarget(imageOptions(options), "image.edit");
  const provider = target.provider;
  const site = target.site;
  const model = target.model;
  const providerName = target.providerName;
  let stopped = false;

  const results = await runPool(groups, concurrency, async (groupRefs, i) => {
    if (stopped) return { index: i, status: "skipped", sourceRefs: groupRefs, error: "已因前序失败停止" };
    const inputs = groupRefs.slice(0, maxRef).map((r) => byteMap.get(r)).filter(Boolean);
    let lastErr = "";
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        const declarative = await runDeclarativeImageSkill({
          site: site, model: model, intent: "image.edit",
          prompt: prompt, size: size, count: n, inputs: inputs, ownerId: options.userId,
          params: protocolParamsFromAgentArgs(args, [
            "prompt", "instruction", "path", "size", "n", "image", "images", "groups", "mode", "groupSize",
            "remainder", "concurrency", "retryCount", "maxReferenceImages", "failurePolicy", "maxGroups",
          ]),
        });
        const images = (declarative && declarative.images) || await executeImageEdit(provider, model, prompt, size, n, inputs);
        if (!images.length) throw new Error("未返回图片");
        const saved = await saveImagesToFs(images, { rootId: options.rootId === undefined ? null : options.rootId });
        return Object.assign({ index: i, status: "succeeded", sourceRefs: groupRefs, images: saved, executor: (declarative && declarative.executor) || "legacy" }, declarative && declarative.taskId ? { taskId: declarative.taskId } : {});
      } catch (e) {
        lastErr = String((e && e.message) || e);
        if (e instanceof SubmittedAgentTaskError) break;
      }
    }
    if (failurePolicy === "stop") stopped = true;
    return { index: i, status: "failed", sourceRefs: groupRefs, error: lastErr };
  });

  const allImages = results.flatMap((r) => r.images || []);
  const okCount = results.filter((r) => r.status === "succeeded").length;
  const failed = results.filter((r) => r.status === "failed");
  const skipped = results.filter((r) => r.status === "skipped").length;

  let text = "批量处理完成：共 " + groups.length + " 组，成功 " + okCount + "，失败 " + failed.length + (skipped ? "，跳过 " + skipped : "") + "。产出 " + allImages.length + " 张图片，保存在「生成图片」文件夹。";
  if (truncated) text += "\n（分组数超出上限，已截断 " + truncated + " 组）";
  if (failed.length) text += "\n失败组：\n" + failed.map((r) => "- 组 " + (r.index + 1) + ": " + r.error).join("\n");

  return {
    text: text,
    meta: {
      model: model,
      provider: providerName,
      mode: mode,
      groups: groups.length,
      ok: okCount,
      fail: failed.length,
      skipped: skipped,
      truncated: truncated,
      count: allImages.length,
      agentTasks: results.filter((item) => item.executor === "declarative").map((item) => item.taskId).filter(Boolean),
    },
    images: allImages,
  };
}

// ── describe_image（skills.ts:2006-2020）────────────────────────────────
async function runDescribeImage(args, opts) {
  const options = opts || {};
  const ref = args && args.image !== undefined ? args.image : (args && Array.isArray(args.images) ? args.images[0] : undefined);
  if (ref === undefined || ref === null || String(ref).trim() === "") throw new Error("缺少要识别的图片（image）");
  const prompt = String((args && args.prompt) != null ? args.prompt : (args && args.instruction) != null ? args.instruction : "").trim() || "请用中文详细描述这张图片的画面内容。";
  const input = await resolveImageBytes(ref, options.rootId === undefined ? null : options.rootId);
  const dataUrl = "data:" + (input.mime || "image/png") + ";base64," + input.buf.toString("base64");
  // 源 skills.ts:2016 resolveVisionTarget(opts) 由 B4a1 skill-store 提供；describeImage(...) 属 B5 媒体。
  // B7j：解析不到视觉站点时归一成依赖缺失，而不是漏成内部错误。
  const target = resolveVisionTargetOrFail(options);
  const text = await mediaMethod("describeImage")(target.provider, target.model, dataUrl, prompt);
  if (!text) throw new Error("视觉模型未返回内容（该模型可能不支持看图）");
  return { text: text, meta: { model: target.model, provider: target.providerName } };
}

// ── AI 生成歌手/专辑图（skills.ts:2022-2096）────────────────────────────
/** skills.ts:2023-2032 */
async function genImageToBuffer(img) {
  try {
    if (img.type === "b64") return Buffer.from(img.value, "base64");
    const resp = await getFetch()(img.value);
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch (error) {
    void error;
    return null;
  }
}

/** skills.ts:2035-2073 给曲库里还没有图的歌手/专辑用图像模型生成原创插画，写入艺术图缓存。 */
async function generateMusicArtwork() {
  const artwork = requireArtwork();
  const targets = await artwork.artworkTargets();
  const target = resolveImageTarget({});
  const generateImages = mediaMethod("generateImages");
  let artistsDone = 0;
  let albumsDone = 0;
  let failed = 0;
  for (const name of targets.artists) {
    try {
      const prompt =
        "为音乐人「" + name + "」设计一张方形头像插画：现代、有音乐氛围的原创艺术风格，" +
        "抽象或象征性地表达其音乐气质。不要写实的真实人物照片、不要模仿任何真实人物的长相、不要文字或水印。";
      const result = await generateImages(target.provider, target.model, { prompt: prompt, size: "1024x1024", n: 1 });
      const buf = result.images[0] ? await genImageToBuffer(result.images[0]) : null;
      if (buf) {
        artwork.putArtwork("artist", name, buf);
        artistsDone++;
      } else failed++;
    } catch (error) {
      void error;
      failed++;
    }
  }
  for (const item of targets.albums) {
    try {
      const prompt =
        "为专辑「" + item.album + "」（音乐人：" + item.artist + "）设计一张原创专辑封面插画：方形、有意境、契合专辑名的氛围与情绪，" +
        "艺术化视觉表达。不要真实人物照片、不要文字或 logo、不要模仿现有专辑封面。";
      const result = await generateImages(target.provider, target.model, { prompt: prompt, size: "1024x1024", n: 1 });
      const buf = result.images[0] ? await genImageToBuffer(result.images[0]) : null;
      if (buf) {
        artwork.putArtwork("album", item.key, buf);
        albumsDone++;
      } else failed++;
    } catch (error) {
      void error;
      failed++;
    }
  }
  await artwork.scan();
  return { artists: artistsDone, albums: albumsDone, failed: failed };
}

/** skills.ts:2076-2096 只给还没有图的歌手生成原创头像插画（不处理专辑）。 */
async function generateArtistsArtwork() {
  const artwork = requireArtwork();
  const targets = await artwork.artworkTargets();
  const target = resolveImageTarget({});
  const generateImages = mediaMethod("generateImages");
  let artistsDone = 0;
  let failed = 0;
  for (const name of targets.artists) {
    try {
      const prompt = "为音乐人「" + name + "」设计一张方形头像插画：现代、有音乐氛围的风格";
      const result = await generateImages(target.provider, target.model, { prompt: prompt, size: "1024x1024", n: 1 });
      const buf = result.images[0] ? await genImageToBuffer(result.images[0]) : null;
      if (buf) {
        artwork.putArtwork("artist", name, buf);
        artistsDone++;
      } else failed++;
    } catch (error) {
      void error;
      failed++;
    }
  }
  await artwork.scan();
  return { artists: artistsDone, failed: failed };
}

// ── 执行入口（skills.ts:2098-2134）──────────────────────────────────────
async function runSkill(id, args, opts) {
  const options = opts || {};
  // skills.ts:2104 源为 withApiQuotaOwner(opts.userId, () => runSkillWithQuota(id, args, opts))。
  // 【OUT】apiQuota（计费/归属）包装已删除，直接调用 runSkillWithQuota。
  assertNotAborted(options);
  return runSkillWithQuota(id, args, options);
}

async function runSkillWithQuota(id, args, opts) {
  const store = getSkillStore();
  const skills = store.listSkills();
  const def = skills.find((s) => s.id === id);
  if (!def) throw new Error("未知技能：" + id);
  if (def.enabled === false) throw new Error("技能「" + def.name + "」已停用");

  if (def.kind === "image") return runGenerateImage(args, opts);
  if (def.kind === "image_upscale") return runUpscaleImage(args, opts);
  if (def.kind === "midjourney") return runMidjourney(args, opts);
  if (def.kind === "image_edit") return runEditImage(args, opts);
  if (def.kind === "image_batch") return runBatchImage(args, opts);
  if (def.kind === "image_describe") return runDescribeImage(args, opts);
  if (def.kind === "video") return runGenerateVideo(args, opts);
  if (def.kind === "audio_tts") return runTextToSpeech(args, opts);
  if (def.kind === "audio_transcribe") return runTranscribeAudio(args, opts);
  if (def.kind === "audio_music") return runGenerateMusic(args, opts);
  if (def.kind === "procedure") return runProcedureSkill(def, args, opts);

  const instruction = String(args && args.instruction !== undefined ? args.instruction : "").trim();
  if (!instruction) throw new Error("缺少 instruction");

  // B7j：没有可启用站点 → 结构化依赖缺失（detail 指 modelSite），不折叠成内部错误。
  const target = resolveChatTargetOrFail(opts);
  const r = await callChat(target.provider, target.model, { prompt: instruction, system: def.systemPrompt }, { signal: opts.signal }, 180000);
  if (!r.text) throw new Error("LLM 未返回文本");
  return { text: r.text, meta: { model: target.model, provider: target.providerName, latencyMs: r.latencyMs } };
}

// ── procedure Skill 执行器（skills.ts:2136-2298）────────────────────────
const PROC_BASE_SKILL_IDS = (function () {
  const ids = getSkillStore().PROCEDURE_BASE_SKILL_IDS;
  if (Array.isArray(ids)) return ids;
  return [];
})();
const PROC_BASE_SKILLS = new Set(PROC_BASE_SKILL_IDS);
const PROC_MAX_ROUNDS = 12;
const PROC_MAX_CALLS = 16;

/** skills.ts:2145-2158 上游 429/5xx 是暂时的：指数退避重试，其他错误直接抛。 */
async function withTransientRetry(run, tries) {
  const attempts = tries === undefined ? 3 : tries;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run();
    } catch (e) {
      lastError = e;
      if (e instanceof SubmittedAgentTaskError) throw e;
      const msg = String((e && e.message) || e);
      if (!/HTTP (429|502|503|504)/.test(msg)) throw e;
      await sleep(8000 * (attempt + 1));
    }
  }
  throw lastError;
}

/** skills.ts:2160-2191 */
function procedureTools(allowed, hasSourceFiles) {
  const allow = allowed || [];
  const wanted = allow.filter((t) => PROC_BASE_SKILLS.has(t));
  const pick = new Set(wanted.length ? wanted : [...PROC_BASE_SKILLS]);
  const baseSkills = getSkillStore().SKILLS || [];
  const defs = baseSkills.filter((s) => pick.has(s.id)).map((s) => ({
    type: "function",
    function: { name: s.id, description: "[基础能力] " + s.description, parameters: s.inputSchema },
  }));
  return [
    ...defs,
    ...(hasSourceFiles ? [{
      type: "function",
      function: {
        name: "read_skill_resource",
        description: "按相对路径读取当前 Skill 自带的 reference、模板或文本元数据",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "资源相对路径，必须从可用资源路径中选择" } },
          required: ["path"],
        },
      },
    }] : []),
    {
      type: "function",
      function: {
        name: "finish",
        description: "全部步骤完成后调用，汇总结果",
        parameters: { type: "object", properties: { summary: { type: "string", description: "给用户的结果说明" } }, required: ["summary"] },
      },
    },
  ];
}

async function runProcedureSkill(def, args, opts) {
  const options = opts || {};
  const instruction = String(args && args.instruction !== undefined ? args.instruction : "").trim();
  if (!instruction) throw new Error("缺少 instruction");
  const v2 = def.v2;
  // B7j：同上，procedure 技能同样按依赖缺失归一。
  const target = resolveChatTargetOrFail(options);
  const started = now();

  const resources = (v2 && v2.resources ? v2.resources : []).slice(0, 6)
    .map((r) => "【资源：" + r.name + "】\n" + r.content.slice(0, 3000)).join("\n\n");
  const sourceFiles = (def.source && def.source.files) || [];
  const sourcePaths = sourceFiles.map((file) => file.path);
  const system = [
    def.systemPrompt || ("你是技能「" + def.name + "」的执行器。"),
    "",
    "执行规则：",
    "- 按工作流逐步执行，每一步用提供的基础能力工具完成实际工作，不要只输出计划。",
    "- 工具返回的产物（文本/图片/视频）就是交付物；媒体工具会把文件存到用户指定目录。",
    "- 资源模板是原作者的最佳实践，拼提示词时优先套用。",
    sourcePaths.length ? "- SKILL.md 引用外部资料时，先用 read_skill_resource 读取对应原文，不要凭空补全。" : "",
    "- 全部完成后调用 finish 汇总。",
  ].filter(Boolean).join("\n");

  const messages = [{
    role: "user",
    content: [
      resources ? "可用资源模板：\n\n" + resources : "",
      sourcePaths.length ? "Skill 原始资源路径：\n" + sourcePaths.map((path) => "- " + path).join("\n") : "",
      "用户请求：" + instruction,
    ].filter(Boolean).join("\n\n"),
  }];

  const tools = procedureTools(v2 && v2.allowedTools ? v2.allowedTools : [], sourcePaths.length > 0);
  const collectedImages = [];
  const collectedVideos = [];
  const collectedAudios = [];
  const stepLog = [];
  let calls = 0;

  for (let round = 0; round < PROC_MAX_ROUNDS; round++) {
    assertNotAborted(options);
    const r = await withTransientRetry(() => chatWithTools(target.provider, target.model, messages, system, tools, 240000, { signal: options.signal }));
    if (!r.toolCalls.length) {
      if (r.content.trim()) {
        return Object.assign({
          text: [r.content.trim(), stepLog.length ? "\n— 执行记录 —\n" + stepLog.join("\n") : ""].join("\n"),
          meta: { model: target.model, provider: target.providerName, latencyMs: now() - started, steps: stepLog.length },
        },
          collectedImages.length ? { images: collectedImages } : {},
          collectedVideos.length ? { videos: collectedVideos } : {},
          collectedAudios.length ? { audios: collectedAudios } : {});
      }
      messages.push({ role: "user", content: "请调用工具继续执行工作流，全部完成后调用 finish。" });
      continue;
    }
    messages.push({ role: "assistant", content: r.content || "", tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) });
    for (const call of r.toolCalls) {
      if (call.name === "finish") {
        let summary = "";
        try {
          summary = String((JSON.parse(call.arguments || "{}").summary) || "");
        } catch (error) {
          void error;
        }
        return Object.assign({
          text: [summary || "技能执行完成", stepLog.length ? "\n— 执行记录 —\n" + stepLog.join("\n") : ""].join("\n"),
          meta: { model: target.model, provider: target.providerName, latencyMs: now() - started, steps: stepLog.length },
        },
          collectedImages.length ? { images: collectedImages } : {},
          collectedVideos.length ? { videos: collectedVideos } : {},
          collectedAudios.length ? { audios: collectedAudios } : {});
      }
      if (++calls > PROC_MAX_CALLS) throw new Error("技能「" + def.name + "」执行超出调用上限（" + PROC_MAX_CALLS + " 次）");
      let observation;
      try {
        let callArgs = {};
        try {
          callArgs = JSON.parse(call.arguments || "{}");
        } catch (error) {
          void error;
        }
        if (call.name === "read_skill_resource") {
          const path = String(callArgs.path || "").replace(/\\/g, "/");
          const file = sourceFiles.find((item) => item.path === path);
          if (!file) throw new Error("Skill 资源不存在：" + path);
          stepLog.push("✓ 读取 Skill 资源 " + path);
          observation = file.content.slice(0, 16000);
          messages.push({ role: "tool", tool_call_id: call.id, content: observation });
          continue;
        }
        const result = await withTransientRetry(() => runSkill(call.name, callArgs, options));
        if (result.images && result.images.length) collectedImages.push(...result.images);
        if (result.videos && result.videos.length) collectedVideos.push(...result.videos);
        if (result.audios && result.audios.length) collectedAudios.push(...result.audios);
        stepLog.push("✓ " + call.name
          + (result.images && result.images.length ? "（产出 " + result.images.length + " 张图）" : "")
          + (result.videos && result.videos.length ? "（产出 " + result.videos.length + " 个视频）" : "")
          + (result.audios && result.audios.length ? "（产出 " + result.audios.length + " 个音频）" : ""));
        observation = [
          result.text,
          result.images && result.images.length ? "已保存图片：" + result.images.map((im) => im.name).join("、") : "",
          result.videos && result.videos.length ? "已保存视频：" + result.videos.map((video) => video.name).join("、") : "",
          result.audios && result.audios.length ? "已保存音频：" + result.audios.map((audio) => audio.name).join("、") : "",
        ].filter(Boolean).join("\n").slice(0, 6000);
      } catch (e) {
        const msg = String((e && e.message) || e);
        stepLog.push("✗ " + call.name + "：" + msg.slice(0, 80));
        observation = "执行失败：" + msg;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: observation });
    }
  }
  throw new Error("技能「" + def.name + "」超过最大执行轮数仍未完成");
}

// ── 常量副本（skills.ts:124-126，B4a1 skill-store 已定义；此处从 skillStore 读取）──
const IMAGE_SIZES = (function () {
  const sizes = getSkillStore().IMAGE_SIZES;
  return Array.isArray(sizes) ? sizes : ["1024x1024", "1792x1024", "1024x1792", "1536x1024", "1024x1536", "1280x720", "720x1280"];
})();

module.exports = {
  AGENT_DEPENDENCY_UNAVAILABLE,
  configureSkillRunner,
  resetSkillRunnerForTests,
  getSkillRunnerConfig,
  // selectors
  isJimengCliProvider,
  resolveImageTarget,
  resolveImageUpscaleTarget,
  resolveMidjourneyTarget,
  resolveVideoTarget,
  resolveAudioTarget,
  imageOptions,
  audioOptions,
  // fs / media helpers
  saveImagesToFs,
  saveAudiosToFs,
  saveVideosToFs,
  mediaExt,
  extensionMime,
  isMediaMime,
  parseDataMedia,
  resolveImageBytes,
  resolveMediaBytes,
  saveJimengImageUrls,
  saveJimengVideoUrls,
  // skills
  runUpscaleImage,
  runMidjourney,
  runGenerateImage,
  runGenerateVideo,
  executeImageEdit,
  runTextToSpeech,
  runTranscribeAudio,
  runGenerateMusic,
  runEditImage,
  runBatchImage,
  runDescribeImage,
  // batch helpers
  combinations,
  buildGroups,
  runPool,
  normalizeVideoRefs,
  // artwork
  genImageToBuffer,
  generateMusicArtwork,
  generateArtistsArtwork,
  // entry / procedure
  runSkill,
  runSkillWithQuota,
  withTransientRetry,
  procedureTools,
  runProcedureSkill,
  protocolParamsFromAgentArgs,
  SubmittedAgentTaskError,
  MIDJOURNEY_OPERATIONS,
  IMAGE_SIZES,
};
