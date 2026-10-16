"use strict";
/**
 * B3b · Agent 路由（CJS 移植）。
 *
 * 来源：server/capabilityRouter.ts:1-76。
 * 逐字对应：inferAgentRequirements 的 taskIntent/requiresAll 分支、
 * preferredProviderId / preferredModel 的 preferredModels 权重（2000 / 500）、
 * requestedSources 走 resolveTools（project.agent + executableOnly + 四类 risk），
 * 否则走 resolveReactTools(actor)；warnings 追加"无可执行工具"提示。
 *
 * 依赖注入（源直接 import 的模块，本仓未同批移植 → 由 configureAgentKernel 注入）：
 *   · modelResolver.resolveModelRoutesFromProviders  ← server/modelResolver.ts
 *   · toolResolver.resolveTools / resolveReactTools  ← server/toolResolver.ts
 *   · providers()                                    ← server/store.ts allProviders()
 *   · AuthUser 用普通对象 { id, role, displayName }（B4 未落地，不 import auth）
 * 未注入时抛 AGENT_DEPENDENCY_UNAVAILABLE，绝不伪造成功。
 */
// 惰性 require 破环：agent-kernel 反向依赖本模块（capabilityRouter / capabilityTargetResolver）。
function kernelModule() { return require("./agent-kernel.cjs"); }
function agentDependencyUnavailable(dependency) { return kernelModule().agentDependencyUnavailable(dependency); }
function getAgentKernelDependencies() { return kernelModule().getAgentKernelDependencies(); }

/** capabilityRouter.ts:36-40 */
function inferAgentRequirements(request) {
  const taskIntent = request.hasImageInput ? "agent.analyze_image_and_write" : "agent.project.write";
  const requiresAll = request.hasImageInput ? ["llm.chat.vision", "llm.tools"] : ["llm.tools"];
  return { taskIntent, requiresAll, requiresAny: [] };
}

/** capabilityRouter.ts:42-76 */
function resolveAgentRoute(request = {}) {
  const dependencies = getAgentKernelDependencies();
  const modelResolver = dependencies.modelResolver;
  if (!modelResolver || typeof modelResolver.resolveModelRoutesFromProviders !== "function") {
    throw agentDependencyUnavailable("modelResolver.resolveModelRoutesFromProviders");
  }
  const toolResolver = dependencies.toolResolver;
  if (!toolResolver || typeof toolResolver.resolveTools !== "function") {
    throw agentDependencyUnavailable("toolResolver.resolveTools");
  }
  if (!request.requestedSources && typeof toolResolver.resolveReactTools !== "function") {
    throw agentDependencyUnavailable("toolResolver.resolveReactTools");
  }
  const requirements = inferAgentRequirements(request);
  const providers = request.providers
    || (typeof dependencies.providers === "function" ? dependencies.providers() : null);
  if (!Array.isArray(providers)) throw agentDependencyUnavailable("providers");
  const preferredModels = request.preferredProviderId
    ? (providers.find((provider) => provider.id === request.preferredProviderId)?.models || []).map((entry) => ({
      providerId: request.preferredProviderId,
      model: entry.model,
      weight: entry.model === request.preferredModel ? 2000 : 500,
    }))
    : request.preferredModel ? [{ model: request.preferredModel, weight: 2000 }] : [];
  const modelRoutes = modelResolver.resolveModelRoutesFromProviders(providers, {
    taskIntent: requirements.taskIntent,
    requiresAll: requirements.requiresAll,
    requiresAny: requirements.requiresAny,
    fallbackPolicy: "best_available",
    preferredModels,
  });
  const model = modelRoutes[0];
  const tools = request.requestedSources
    ? toolResolver.resolveTools({ intent: "project.agent", actor: request.actor, requestedSources: request.requestedSources, executableOnly: true, includeRisk: ["read", "write", "delete", "external"] })
    : toolResolver.resolveReactTools(request.actor);
  const warnings = [
    ...model.warnings,
    ...(!tools.descriptors.length ? ["当前没有可执行工具，Agent 只能规划或说明，不能落地执行。"] : []),
  ];
  return {
    ...requirements,
    model,
    modelRoutes,
    tools: tools.openaiTools,
    toolDescriptors: tools.descriptors,
    systemPromptAdditions: [],
    reasons: [
      ...model.reasons,
      `暴露 ${tools.descriptors.length} 个 Agent 工具（${tools.descriptors.filter((tool) => tool.source === "file").length} 个文件工具，${tools.descriptors.filter((tool) => tool.source === "skill").length} 个 Skill 工具，${tools.descriptors.filter((tool) => tool.source === "mcp").length} 个 MCP 工具）`,
    ],
    warnings,
  };
}

module.exports = { inferAgentRequirements, resolveAgentRoute };

/**
 * @typedef {Object} AgentRouteRequest
 * @property {string} [instruction]
 * @property {string} [taskId]
 * @property {string} [projectId]
 * @property {string} [rootNodeId]
 * @property {{ id: string, role?: string, displayName?: string }|null} [actor]   // AuthUser 的字段子集（B4 前不 import auth）
 * @property {boolean} [hasImageInput]
 * @property {Array<Object>} [providers]
 * @property {string} [preferredProviderId]
 * @property {string} [preferredModel]
 * @property {string[]} [requestedSources]
 *
 * @typedef {Object} AgentRoute
 * @property {string} taskIntent
 * @property {string[]} requiresAll
 * @property {string[]} requiresAny
 * @property {Object} model
 * @property {Array<Object>} modelRoutes
 * @property {Array<Object>} tools
 * @property {Array<Object>} toolDescriptors
 * @property {string[]} systemPromptAdditions
 * @property {string[]} reasons
 * @property {string[]} warnings
 */
