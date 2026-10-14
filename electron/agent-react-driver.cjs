"use strict";
/**
 * B3e · ReAct 循环驱动（CJS 移植）。
 *
 * 来源（DXSRC = DX OS.app/Contents/Resources/app.asar.unpacked/server）：
 *   · reactDriver.ts:1-704  M4 ReAct 服务端执行循环
 *   · 分段映射：常量 37-124；PROFILE_CONFIG 126-129；isSingleDocumentCreation 132-138；
 *     requestedDocumentLength 140-145；fastDocumentLengthError 147-154；systemForTask 156-162；
 *     ReactOutcome 164-169；pickLlm 173-189；trackedModelCall 191-209；buildContext 211-268；
 *     planIfNeeded 271-312；runReactTask 314-316；runReactTaskWithModelAccess 318-685；
 *     safeParse 687-689；formatObservation 691-696；markReactFailure 699-703。
 *
 * 云计费 OUT：源 reactDriver.ts:3 的 `import { withApiQuotaOwner } from './apiQuota.ts'`
 * 与 314-316 的 withApiQuotaOwner(userId, ...) 包装属云计费 OUT 清单，本移植删除该调用，
 * runReactTask 直接进入 runReactTaskWithModelAccess。
 *
 * 依赖注入：configureReactDriver(options)。未注入的必需适配器在 runReactTask 入口返回
 * 结构化 AGENT_DEPENDENCY_UNAVAILABLE，绝不伪造成功。本仓已冻结模块可被覆盖，未覆盖时惰性 require：
 *   · kernel            ./agent-kernel.cjs（prepareAgentTurn）
 *   · kernelStore       ./agent-kernel-store.cjs（createAgentRun/startAgentRun/appendAgentRunEvent/
 *                        failAgentRun/findAgentRunByTask/waitAgentRun）
 *   · supervisor        ./agent-kernel-supervisor.cjs（delegateAgentWork/getAgentProfile/listAgentProfiles）
 *   · taskStore         ./agent-task-store.cjs（B3a；任务状态机与 durable turn/step/operation）
 *   · capabilityAdapter 默认聚合 ./progressive-capability-router.cjs + ./capability-target-resolver.cjs
 *                        + ./capability-router.cjs
 *   · workspaceAdapter  ./agent-runtime-workspace.cjs
 *   · usageAdapter      ./agent-runtime-usage.cjs
 *   · schemaValidator   ./agent-runtime-envelope.cjs（validateJsonSchema）
 *   · modelFallback     ./agent-runtime-fallback.cjs（runWithAgentModelFallback）
 *   · toolRunner        { runTool, ToolError } —— B3d1 agent-builtin-tools，必须注入
 *   · mcpAdapter        { callByName } —— 本仓 mcp 域适配，必须注入
 *   · skillAdapter      { runSkill } —— B4，必须注入
 *   · providerAdapter   { firstUsable(kind), autoFallback(), call(...) } —— B2，必须注入
 *   · fsAdapter / clock / logger 可选
 */
const { createHash } = require("node:crypto");

const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

// 源 reactDriver.ts:37-63
const FINISH_TOOL = {
  type: "function",
  function: {
    name: "finish_task",
    description: "所有目标都已完成、交付物已写入项目后调用，结束任务。",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "给用户的完成总结（都做了什么、产出了哪些文件）" },
        output: { description: "任务声明 expectedOutputSchema 时必须按该 Schema 返回的结构化结果" },
      },
      required: ["summary"],
    },
  },
};
// 源 reactDriver.ts:52-63
const ASK_TOOL = {
  type: "function",
  function: {
    name: "ask_user",
    description: "缺少关键信息且无法合理假设时，向用户提一个问题并暂停任务。整个任务最多问 2 次，能用合理默认值时不要问。",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "要问用户的问题（合并成一条，最多 2 个点）" } },
      required: ["question"],
    },
  },
};
// 源 reactDriver.ts:64-75
const MEMORY_TOOL = {
  type: "function",
  function: {
    name: "save_memory",
    description: "把本次任务确认的稳定事实/决定存入项目记忆（例如“主角叫苏然”“文档统一用中文”）。只存跨任务有用的长期事实，不存执行细节。",
    parameters: {
      type: "object",
      properties: { content: { type: "string", description: "一句话事实或决定" } },
      required: ["content"],
    },
  },
};
// 源 reactDriver.ts:76-110（源用 listAgentProfiles() 现取 profile 列表，这里显式接收 supervisor 适配器）
function delegateTool(supervisor) {
  const profiles = supervisor.listAgentProfiles();
  return {
    type: "function",
    function: {
      name: "delegate_agents",
      description: "仅当目标确实包含可独立验证的专业工作时，把工作委派给最多 8 个受限子 Agent。简单或强顺序任务直接自己完成。",
      parameters: {
        type: "object",
        properties: {
          children: {
            type: "array", minItems: 1, maxItems: 8,
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "本批次唯一短标识" },
                title: { type: "string" },
                instruction: { type: "string", description: "可独立执行和验收的完整任务说明" },
                agentProfileId: {
                  type: "string",
                  enum: profiles.map((profile) => profile.id),
                  description: profiles.map((profile) => profile.id + "=" + profile.name).join("；"),
                },
                dependsOn: { type: "array", items: { type: "string" }, description: "引用本批次中排在前面的 key" },
                expectedOutputSchema: { type: "object", description: "可选的结构化输出约束" },
              },
              required: ["key", "instruction", "agentProfileId"],
            },
          },
        },
        required: ["children"],
      },
    },
  };
}

// 源 reactDriver.ts:112-124（源为模板字符串，这里用行数组合并保持逐字一致）
const SYSTEM = [
  "你是 DX OS 的项目 Agent，在一个项目文件夹内完成用户交办的任务。",
  "规则：",
  "- 用提供的文件工具实际完成工作，路径都相对项目根目录。",
  "- 先规划后动手；文件放在合理的子目录结构里。",
  "- 用户要求创建文件夹时，先用 fs_mkdir 创建文件夹，再把文件创建到该文件夹内（如 剧本/短剧剧本.md）。",
  "- 缺少次要信息时使用合理默认值并继续；只有关键决策才用 ask_user（整个任务最多 2 次）。",
  "- 全部完成后调用 finish_task 并总结产出。不要在没有实际写入文件前调用 finish_task。",
  "- 回复和文件内容都使用中文（除非用户要求其它语言）。",
  "- writing、rewrite、code、analysis 是官方文本预设，仅用于明确的内容成品或转换；不要用它们做任务规划、复述工具结果或普通判断。",
  "- 需要读取、写入、生成、编辑或调用外部服务时，先调用 capability_discover 选择一个或多个意图；系统随后只披露相关能力。不要猜测尚未激活的工具名。",
  "- Capability Router、模型/API 选择和 V2 协议参数由 Agent Kernel 统一负责。用户导入或创建的功能 Skill 只有在用户显式选择时才进入本轮能力声明。",
  "- 图片、视频和音频请求必须通过发现到的系统能力真实执行，不要用文本预设假装已经生成媒体。",
  "- 当任务包含多个可独立验证的专业部分时，可调用 delegate_agents 委派给 researcher、maker、reviewer 或 general 子 Agent；委派后系统会暂停本任务，待子 Agent 全部返回再恢复汇总。",
].join("\n");

// ---------------------------------------------------------------------------
// 依赖注入（沿用 agent-kernel.cjs / agent-runtime-deps.cjs 的既有约定）
// ---------------------------------------------------------------------------

function defaults() {
  return {
    kernel: null,
    kernelStore: null,
    supervisor: null,
    taskStore: null,
    toolRunner: null,
    mcpAdapter: null,
    skillAdapter: null,
    capabilityAdapter: null,
    providerAdapter: null,
    workspaceAdapter: null,
    usageAdapter: null,
    schemaValidator: null,
    modelFallback: null,
    fsAdapter: null,
    clock: null,
    logger: null,
  };
}

let deps = defaults();
let resolvedCache = null;

const DEFAULT_MODULES = {
  kernel: () => require("./agent-kernel.cjs"),
  kernelStore: () => require("./agent-kernel-store.cjs"),
  supervisor: () => require("./agent-kernel-supervisor.cjs"),
  taskStore: () => require("./agent-task-store.cjs"),
  workspaceAdapter: () => require("./agent-runtime-workspace.cjs"),
  usageAdapter: () => require("./agent-runtime-usage.cjs"),
  schemaValidator: () => require("./agent-runtime-envelope.cjs"),
  modelFallback: () => require("./agent-runtime-fallback.cjs"),
};

function defaultCapabilityAdapter() {
  const progressive = require("./progressive-capability-router.cjs");
  const targetResolver = require("./capability-target-resolver.cjs");
  const router = require("./capability-router.cjs");
  return {
    createProgressiveCapabilityToolset: progressive.createProgressiveCapabilityToolset,
    discoverCapabilityTargetsForUser: targetResolver.discoverCapabilityTargetsForUser,
    normalizeCapabilityReferences: targetResolver.normalizeCapabilityReferences,
    normalizeCapabilityRequirements: targetResolver.normalizeCapabilityRequirements,
    selectedCapabilityTargets: targetResolver.selectedCapabilityTargets,
    resolveAgentRoute: router.resolveAgentRoute,
  };
}

/** B3e 注入入口：白名单键，未列出的键忽略。 */
function configureReactDriver(options = {}) {
  const patch = options && typeof options === "object" ? options : {};
  const next = Object.assign({}, deps);
  for (const key of Object.keys(defaults())) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) next[key] = patch[key];
  }
  deps = next;
  resolvedCache = null;
  return getReactDriverDependencies();
}

/** 惰性解析默认模块；注入值优先。 */
function resolveDependencies() {
  if (resolvedCache) return resolvedCache;
  const resolved = Object.assign({}, deps);
  for (const key of Object.keys(DEFAULT_MODULES)) {
    if (resolved[key] === null || resolved[key] === undefined) {
      try { resolved[key] = DEFAULT_MODULES[key](); } catch { resolved[key] = null; }
    }
  }
  if (!resolved.capabilityAdapter) {
    try { resolved.capabilityAdapter = defaultCapabilityAdapter(); } catch { resolved.capabilityAdapter = null; }
  }
  resolvedCache = resolved;
  return resolved;
}

function getReactDriverDependencies() {
  return resolveDependencies();
}

/** 仅供测试：清空全部注入，恢复“未接入”状态（不触发默认模块 require）。 */
function resetReactDriverForTests() {
  deps = defaults();
  resolvedCache = null;
  return Object.assign({}, deps);
}

/** 结构化依赖缺失错误：保留 name/code/dependency 三元组。 */
function agentDependencyUnavailable(dependency, detail) {
  const error = new Error("React Driver 依赖不可用：" + String(dependency) + "（需通过 configureReactDriver 注入）");
  error.name = "AgentDependencyUnavailableError";
  error.code = AGENT_DEPENDENCY_UNAVAILABLE;
  error.dependency = String(dependency);
  if (detail !== undefined) error.detail = detail;
  return error;
}

// 必须注入（本仓暂无默认实现）与必须可用的适配器方法。
const REQUIRED_ADAPTERS = [
  ["providerAdapter", ["firstUsable", "autoFallback", "call"]],
  ["toolRunner", ["runTool", "ToolError"]],
  ["mcpAdapter", ["callByName"]],
  ["skillAdapter", ["runSkill"]],
  ["kernel", ["prepareAgentTurn"]],
  ["kernelStore", ["createAgentRun", "startAgentRun", "appendAgentRunEvent", "failAgentRun", "findAgentRunByTask", "waitAgentRun"]],
  ["supervisor", ["delegateAgentWork", "getAgentProfile", "listAgentProfiles"]],
  ["taskStore", [
    "getTask", "appendTaskEvent", "consumeBudget", "appendDynamicStep", "latestResumableAgentTurn",
    "persistAgentTurn", "advanceAgentTurn", "completeAgentTurn", "sealStaleReactSteps", "savePlan",
    "waitForUser", "waitForChildren", "failTaskFenced", "postTaskMessage", "taskIsRunning",
    "startStep", "completeStep", "failStep", "requeueReactStepForResume", "findOperation",
    "beginOperation", "finishOperation", "addMemory", "threadVisibility",
  ]],
  ["capabilityAdapter", [
    "createProgressiveCapabilityToolset", "discoverCapabilityTargetsForUser",
    "normalizeCapabilityReferences", "normalizeCapabilityRequirements",
    "selectedCapabilityTargets", "resolveAgentRoute",
  ]],
  ["workspaceAdapter", ["ensureRunWorkspace", "assertRunWorkspaceWrite", "getRunWorkspace", "listRunArtifacts", "stageRunArtifact", "stageRunArtifactNode"]],
  ["usageAdapter", ["beginAgentUsage", "finishAgentUsage"]],
  ["schemaValidator", ["validateJsonSchema"]],
  ["modelFallback", ["runWithAgentModelFallback"]],
];

function missingDependency(effective) {
  for (const entry of REQUIRED_ADAPTERS) {
    const name = entry[0];
    const value = effective[name];
    if (value === null || value === undefined) return { dependency: name };
    for (const method of entry[1]) {
      if (typeof value[method] === "function") continue;
      // ToolError 需要是构造函数（instanceof 判定），单独校验。
      if (method === "ToolError" && typeof value.ToolError === "function") continue;
      return { dependency: name + "." + method };
    }
  }
  return null;
}

function dependencyUnavailableOutcome(missing) {
  return {
    kind: "failed",
    code: AGENT_DEPENDENCY_UNAVAILABLE,
    dependency: missing.dependency,
    message: "React Driver 依赖不可用：" + missing.dependency + "（需通过 configureReactDriver 注入）",
  };
}

function clockNow() {
  const effective = resolveDependencies();
  return typeof effective.clock === "function" ? effective.clock() : Date.now();
}

// ---------------------------------------------------------------------------
// 源 reactDriver.ts:126-162
// ---------------------------------------------------------------------------

/** 源 reactDriver.ts:126-129（DEFAULT_BUDGET 由 taskStore 适配器提供） */
function profileConfig() {
  const effective = resolveDependencies();
  const fallbackBudget = { maxModelCalls: null, maxToolCalls: null };
  const defaultBudget = (effective.taskStore && effective.taskStore.DEFAULT_BUDGET) || fallbackBudget;
  return {
    assistant: { budget: { maxModelCalls: 10, maxToolCalls: 24 }, plan: false, skills: true, memory: false },
    thinking: { budget: defaultBudget, plan: true, skills: true, memory: true },
  };
}

/** 源 reactDriver.ts:132-138 */
function isSingleDocumentCreation(instruction) {
  const text = String(instruction || "");
  const wantsCreate = /(创建|新建|生成|创作|落地|撰写|写一(?:篇|份|个)|保存为)/.test(text);
  const isDocument = /(Markdown|\.md\b|文稿|文章|小说|剧本|故事|报告|方案|说明书|文档)/i.test(text);
  const isMultiArtifact = /(多个|若干|一组|批量|每个文件|分别保存|拆分(?:为|成)|分章节保存|目录结构)/.test(text);
  const isEditing = /(修改|改写|重写|润色|校对|追加|更新|整理现有|已有文件)/.test(text);
  return wantsCreate && isDocument && !isMultiArtifact && !isEditing;
}

/** 源 reactDriver.ts:140-145 */
function requestedDocumentLength(instruction) {
  const match = String(instruction || "").match(/(?:约|大约|篇幅(?:为|适中，?)?)?\s*(\d{3,6})\s*[—–~-]\s*(\d{3,6})\s*字/);
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2]);
  return min > 0 && max >= min ? { min: min, max: max } : null;
}

/** 源 reactDriver.ts:147-154 */
function fastDocumentLengthError(task, callName, args) {
  if (callName !== "fs_create" && callName !== "fs_write") return "";
  const range = requestedDocumentLength(task.instruction);
  if (!range) return "";
  const length = String(args.content === undefined || args.content === null ? "" : args.content).replace(/\s/g, "").length;
  if (length >= range.min && length <= range.max) return "";
  return "正文当前约 " + length + " 字，不符合用户要求的 " + range.min + "—" + range.max + " 字。请重新生成一份范围内的完整正文并一次性写入；不要拆成局部编辑。";
}

/** 源 reactDriver.ts:156-162 */
function systemForTask(task, fastDocument) {
  if (!fastDocument) return SYSTEM;
  return SYSTEM + "\n\n当前为 AI 助理快速单文档任务：\n" +
    "- 在调用文件工具前，在本次模型响应内部完成构思、写作、字数与要求检查。\n" +
    "- 一次性生成可直接交付的完整正文，只允许创建目录并用 fs_create 或 fs_write 写入一次。\n" +
    "- 写入成功即视为完成，不要再读取、追加、局部替换、润色或二次改写。严格遵守用户要求的篇幅范围。";
}

// ---------------------------------------------------------------------------
// 源 reactDriver.ts:164-209
// ---------------------------------------------------------------------------

/**
 * ReactOutcome = { kind:'finished'; summary; output? } | { kind:'waiting_user' }
 *   | { kind:'waiting_children' } | { kind:'stopped' } | { kind:'failed'; code; message }
 * 源 reactDriver.ts:164-169（TS union 只有编译期意义，运行时为普通对象）。
 */

/** 源 reactDriver.ts:173-189 */
function pickLlm(preferences = {}) {
  const effective = resolveDependencies();
  try {
    const resolved = effective.capabilityAdapter.resolveAgentRoute({
      preferredProviderId: preferences.providerId || undefined,
      preferredModel: preferences.llmModel || undefined,
    });
    const route = resolved.model;
    const routeMissing = (route && route.missing) || [];
    if (!routeMissing.includes("llm.tools")) {
      const routes = (resolved.modelRoutes || [route]).filter((item) => !((item.missing || []).includes("llm.tools"))).map((item) => ({
        provider: item.provider, providerId: item.providerId, model: item.model,
      }));
      return { provider: route.provider, providerId: route.providerId, model: route.model, routes: routes };
    }
  } catch { /* 回退到 legacy 粗粒度路由（源 183） */ }
  const stored = effective.providerAdapter.firstUsable("llm");
  if (!stored) return null;
  const models = stored.models || [];
  const picked = models.find((m) => (m.caps || []).includes("llm")) || models[0];
  const model = picked && picked.model;
  if (!model) return null;
  return {
    provider: { id: stored.id, base_url: stored.base_url, api_key: stored.api_key, protocol: stored.protocol },
    providerId: stored.id,
    model: model,
  };
}

/** 模型回复归一化：容忍 toolCalls / tool_calls 与 function 包装两种形状。 */
function normalizeModelReply(result) {
  const reply = result || {};
  const content = typeof reply.content === "string" ? reply.content : reply.content === undefined || reply.content === null ? "" : String(reply.content);
  const rawCalls = Array.isArray(reply.toolCalls) ? reply.toolCalls : Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
  const toolCalls = rawCalls.map((call, index) => {
    const fn = call && call.function ? call.function : {};
    const rawArgs = call && call.arguments !== undefined ? call.arguments : fn.arguments;
    return {
      id: String((call && call.id) || fn.id || ("call_" + index)),
      name: String((call && call.name) || fn.name || ""),
      arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs === undefined ? {} : rawArgs),
    };
  }).filter((call) => call.name);
  return { content: content, toolCalls: toolCalls, usage: reply.usage, latencyMs: reply.latencyMs };
}

function invokeModelProvider(route, input) {
  const effective = resolveDependencies();
  // 保留适配器 this 绑定：call 必须按方法调用，否则依赖 this 的适配器会报错。
  const adapter = typeof effective.providerAdapter.call === "function"
    ? effective.providerAdapter
    : effective.modelAdapter && typeof effective.modelAdapter.call === "function" ? effective.modelAdapter : null;
  if (!adapter) throw agentDependencyUnavailable("providerAdapter.call");
  return Promise.resolve(adapter.call({
    provider: route.provider,
    providerId: route.providerId,
    model: route.model,
    messages: input.messages,
    system: input.system,
    tools: input.tools,
    timeoutMs: input.timeoutMs,
  })).then(normalizeModelReply);
}

/** 源 reactDriver.ts:191-209 */
async function trackedModelCall(runId, taskId, llm, input) {
  const effective = resolveDependencies();
  const routes = effective.providerAdapter.autoFallback() ? llm.routes || [llm] : [llm];
  return effective.modelFallback.runWithAgentModelFallback({
    routes: routes,
    invoke: async (route) => {
      const invocation = effective.usageAdapter.beginAgentUsage({ runId: runId, taskId: taskId, kind: "model", providerId: route.providerId, model: route.model });
      try {
        const result = await invokeModelProvider(route, input);
        effective.usageAdapter.finishAgentUsage(invocation.id, { status: "completed", usage: result.usage, latencyMs: result.latencyMs });
        return result;
      } catch (error) {
        effective.usageAdapter.finishAgentUsage(invocation.id, {
          status: error && error.name === "AbortError" ? "cancelled" : "failed",
          latencyMs: clockNow() - invocation.startedAt,
          error: error,
        });
        throw error;
      }
    },
  });
}

function makeToolError(code, message) {
  const effective = resolveDependencies();
  const ToolError = effective.toolRunner && effective.toolRunner.ToolError;
  if (typeof ToolError === "function") return new ToolError(code, message);
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// 源 reactDriver.ts:211-268 · 恢复上下文
// ---------------------------------------------------------------------------

function parsePermissionGrant(task) {
  try { return JSON.parse(task.permission_grant_json || "[]"); } catch { return []; }
}

function parseExpectedSchema(task) {
  try { return task.expected_output_schema ? JSON.parse(task.expected_output_schema) : undefined; } catch { return undefined; }
}

function parseDependsOn(task) {
  try { return JSON.parse(task.depends_on_json || "[]"); } catch { return []; }
}

/**
 * 子任务结果：源 227-231 直接查 ccsDb 的 tasks LEFT JOIN agent_runs。
 * 移植后该查询归 taskStore 适配器所有（OUT 直连 db）；适配器未提供 listChildTasks 时返回空。
 */
function listChildTaskResults(taskId) {
  const effective = resolveDependencies();
  const store = effective.taskStore;
  if (store && typeof store.listChildTasks === "function") return store.listChildTasks(taskId) || [];
  return [];
}

/** 源 reactDriver.ts:212-268 */
function buildContext(task) {
  const effective = resolveDependencies();
  const messages = [];
  const plan = task.plan;
  const steps = task.steps || [];
  const events = task.events || [];
  const done = steps.filter((s) => s.status === "completed");
  const parts = [
    "任务目标：" + task.instruction,
    plan && plan.goal !== task.instruction ? "当前计划：" + plan.goal : "",
    plan && plan.assumptions && plan.assumptions !== "[]" ? "已确认假设：" + plan.assumptions : "",
    plan && plan.acceptance && plan.acceptance !== "[]" ? "验收条件：" + plan.acceptance : "",
  ].filter(Boolean);
  // waiting_user 后带上用户最新回答
  const answered = events.filter((e) => e.type === "task.answered").at(-1);
  if (answered) parts.push("用户最新补充或回答：" + answered.message);
  const childrenReturned = events.filter((e) => e.type === "supervisor.children_completed").at(-1);
  if (childrenReturned) {
    const children = listChildTaskResults(task.id);
    parts.push("子 Agent 已全部返回：\n" + children.map((child) => {
      let authoritativeOutput;
      try {
        authoritativeOutput = child.result_json ? JSON.parse(child.result_json).output : undefined;
      } catch { /* 损坏的历史行（源 234） */ }
      const structured = authoritativeOutput === undefined ? "" : "\n  结构化输出：" + JSON.stringify(authoritativeOutput).slice(0, 6000);
      return "- " + child.title + " [" + child.status + "]：" + String(child.result || child.error_message || "无摘要").slice(0, 2000) + structured;
    }).join("\n") + "\n请以已通过 Schema 验证的结构化输出为权威数据，综合结果、处理失败项并完成最终验收。");
  }
  if (task.agent_profile_id === "reviewer") {
    const dependencies = parseDependsOn(task);
    const evidence = [];
    for (const dependencyTaskId of dependencies) {
      const dependency = effective.taskStore.getTask(dependencyTaskId);
      const run = effective.kernelStore.findAgentRunByTask(dependencyTaskId);
      if (!dependency || !run) continue;
      evidence.push("依赖任务：" + dependency.title + "\n系统结果：" + String(dependency.result || "").slice(0, 2000));
      const workspace = typeof effective.workspaceAdapter.getRunWorkspace === "function" ? effective.workspaceAdapter.getRunWorkspace(run.id) : null;
      const artifacts = typeof effective.workspaceAdapter.listRunArtifacts === "function" ? effective.workspaceAdapter.listRunArtifacts(run.id) : [];
      for (const artifact of artifacts) {
        const node = workspace && effective.fsAdapter && typeof effective.fsAdapter.findByPath === "function"
          ? effective.fsAdapter.findByPath(workspace.workspaceRootId, artifact.path)
          : null;
        const excerpt = node && node.type === "file" && node.content !== undefined ? "\n内容摘录：" + node.content.slice(0, 4000) : "";
        evidence.push("Artifact：" + artifact.path + " · " + artifact.status + " · sha256=" + artifact.sha256 + excerpt);
      }
    }
    if (evidence.length) parts.push("Reviewer 权威证据（只读）：\n" + evidence.join("\n\n"));
  }
  messages.push({ role: "user", content: parts.join("\n") });
  if (done.length) {
    const recent = done.slice(-12).map((s) => {
      let out = "";
      try { out = String((JSON.parse(s.output_json || "{}")).message || ""); } catch { /* 忽略（源 261） */ }
      return "- " + s.title + (out ? "：" + out : "");
    });
    messages.push({ role: "assistant", content: "我已经完成了以下步骤：\n" + recent.join("\n") + (done.length > 12 ? "\n（更早的 " + (done.length - 12) + " 步略）" : "") });
    messages.push({ role: "user", content: "请继续完成剩余工作。已完成的不要重做。" });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// 源 reactDriver.ts:271-312 · Planner
// ---------------------------------------------------------------------------

async function planIfNeeded(task, llm, budget, runId) {
  const effective = resolveDependencies();
  const events = task.events || [];
  const continuedSequence = (events.filter((e) => e.type === "task.continued").at(-1) || {}).sequence || 0;
  const planned = events.some((e) => e.type === "task.planned" && e.sequence > continuedSequence);
  if (planned) return;
  if (!effective.taskStore.consumeBudget(task.id, "model", budget)) throw makeToolError("internal", "模型调用预算耗尽");
  const planTool = {
    type: "function",
    function: {
      name: "submit_plan",
      description: "提交任务执行计划",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "一句话目标" },
          assumptions: { type: "array", items: { type: "string" }, description: "未询问用户、直接采用的假设（可为空）" },
          acceptance: { type: "array", items: { type: "string" }, description: "3-6 条可检查的验收条件" },
        },
        required: ["goal", "acceptance"],
      },
    },
  };
  const latestRequirement = (events.filter((e) => e.type === "task.answered").at(-1) || {}).message;
  const planningGoal = latestRequirement ? task.instruction + "\n\n用户本轮追加要求：" + latestRequirement : task.instruction;
  const r = await trackedModelCall(runId, task.id, llm, {
    messages: [{ role: "user", content: "为以下任务制定执行计划（不要开始执行）：\n" + planningGoal }],
    system: "你是任务规划器。用 submit_plan 提交简洁的计划。假设写明默认值；验收条件必须可检查（文件存在、内容包含某要素等）。",
    tools: [planTool], timeoutMs: 120000,
  });
  const call = (r.toolCalls || []).find((c) => c.name === "submit_plan");
  let plan = { goal: planningGoal, assumptions: [], acceptance: [] };
  if (call) {
    try {
      const args = JSON.parse(call.arguments || "{}");
      plan = {
        goal: String(args.goal || task.instruction),
        assumptions: Array.isArray(args.assumptions) ? args.assumptions.map(String).slice(0, 10) : [],
        acceptance: Array.isArray(args.acceptance) ? args.acceptance.map(String).slice(0, 10) : [],
      };
    } catch { /* 解析失败用默认计划（源 309） */ }
  }
  effective.taskStore.savePlan(task.id, plan);
}

// ---------------------------------------------------------------------------
// 源 reactDriver.ts:314-316 · 任务入口
// ---------------------------------------------------------------------------

/**
 * 源 reactDriver.ts:314-316。
 * 云计费 OUT：源 line 315 的 withApiQuotaOwner(userId, ...) 已删除，直接进入主循环。
 */
async function runReactTask(taskId, workerId, leaseToken, rootNodeId, userId) {
  const effective = resolveDependencies();
  const missing = missingDependency(effective);
  if (missing) return dependencyUnavailableOutcome(missing);
  return runReactTaskWithModelAccess(taskId, workerId, leaseToken, rootNodeId, userId);
}

/** 能力发现：源 473-479 与 499-514 共用的 discover + targets 逻辑。 */
async function runCapabilityDiscovery(input) {
  const effective = resolveDependencies();
  const adapter = effective.capabilityAdapter;
  const decision = input.toolset.discover(input.args);
  const result = Object.assign({}, decision, {
    targets: await adapter.discoverCapabilityTargetsForUser(
      input.userId,
      Array.isArray(input.args.intents) ? input.args.intents.map(String) : [],
      adapter.normalizeCapabilityReferences(input.args.references),
      adapter.normalizeCapabilityRequirements(input.args.requirements),
    ),
  });
  input.toolset.applyTargets(result.targets);
  return { decision: decision, result: result };
}

// ---------------------------------------------------------------------------
// 源 reactDriver.ts:318-685 · 主循环
// ---------------------------------------------------------------------------

async function runReactTaskWithModelAccess(taskId, workerId, leaseToken, rootNodeId, userId) {
  const effective = resolveDependencies();
  const taskStore = effective.taskStore;
  const kernelStore = effective.kernelStore;
  const kernel = effective.kernel;
  const supervisor = effective.supervisor;

  // 源 319-320（源为非空断言 getTask(taskId)!，这里保留防御性失败分支）
  taskStore.sealStaleReactSteps(taskId);
  let task = taskStore.getTask(taskId);
  if (!task) return { kind: "failed", code: "task_not_found", message: "任务不存在：" + taskId };
  let routeTools = [];
  let kernelPromptAdditions = [];
  let kernelRunId = (kernelStore.findAgentRunByTask(taskId) || {}).id;
  let toolRootNodeId = rootNodeId;
  try {
    const prepared = kernel.prepareAgentTurn({
      runId: kernelRunId,
      instruction: task.instruction,
      entryPoint: "project",
      userId: userId,
      projectId: task.project_id,
      taskId: task.id,
      correlationId: task.id,
      preferredProviderId: task.preferred_provider_id || undefined,
      preferredModel: task.preferred_llm_model || undefined,
    });
    const permissionGrant = parsePermissionGrant(task);
    if (task.parent_task_id) {
      const allowedCapabilityIds = new Set((prepared.capabilities || []).filter((item) => permissionGrant.includes(item.id)).map((item) => item.id));
      prepared.capabilities = (prepared.capabilities || []).filter((item) => permissionGrant.includes(item.id));
      prepared.route.toolDescriptors = (prepared.route.toolDescriptors || []).filter((item) => allowedCapabilityIds.has(item.capabilityId || (item.source + ":" + item.sourceId + ":" + item.name)));
      const allowed = new Set((prepared.route.toolDescriptors || []).map((item) => item.name));
      prepared.route.tools = (prepared.route.tools || []).filter((item) => allowed.has(item.function.name));
      // 源 346-349 直接查 ccsDb.agent_profiles；移植后经 supervisor.getAgentProfile（字段 systemPrompt 对应源 system_prompt）。
      const agentProfile = task.agent_profile_id ? supervisor.getAgentProfile(task.agent_profile_id) : undefined;
      if (agentProfile) prepared.systemPromptAdditions.push("当前角色：" + agentProfile.name + "。" + (agentProfile.systemPrompt || ""));
    }
    const created = !kernelRunId;
    kernelStore.createAgentRun(prepared, task.instruction);
    kernelRunId = prepared.trace.runId;
    const workspace = effective.workspaceAdapter.ensureRunWorkspace(kernelRunId, task.project_id, rootNodeId, userId);
    toolRootNodeId = workspace.workspaceRootId;
    kernelStore.startAgentRun(kernelRunId);
    routeTools = prepared.route.tools;
    kernelPromptAdditions = prepared.systemPromptAdditions;
    if (created) kernelStore.appendAgentRunEvent(kernelRunId, "planned", { capabilityCount: prepared.capabilities.length });
    taskStore.appendTaskEvent(taskId, "agent.kernel.prepared", "Agent Kernel 已准备 " + prepared.capabilities.length + " 个能力", {
      runId: prepared.trace.runId,
      correlationId: prepared.trace.correlationId,
      capabilityCount: prepared.capabilities.length,
      contextSections: (prepared.context || []).map((section) => section.id),
    });
  } catch (error) {
    const message = "Agent 工作区初始化失败：" + String((error && error.message) || error);
    if (kernelRunId) kernelStore.failAgentRun(kernelRunId, message);
    return { kind: "failed", code: "workspace_initialization_failed", message: message };
  }
  const llm = pickLlm({ providerId: task.preferred_provider_id, llmModel: task.preferred_llm_model });
  if (!llm) {
    const message = "没有可用的模型站点：请在「API 设置」中启用一个带 LLM 模型的站点后恢复任务";
    if (kernelRunId) kernelStore.failAgentRun(kernelRunId, message);
    return { kind: "failed", code: "no_llm_provider", message: message };
  }
  // 源 376-384：旧任务中的 expert 与缺省值均按新的思考模式执行。
  const profiles = profileConfig();
  const profile = task.execution_profile === "assistant" ? profiles.assistant : profiles.thinking;
  const fastDocument = task.execution_profile === "assistant" && isSingleDocumentCreation(task.instruction);
  const delegatedProfile = task.agent_profile_id ? supervisor.getAgentProfile(task.agent_profile_id) : undefined;
  const budget = fastDocument
    ? { maxModelCalls: 3, maxToolCalls: 4 }
    : delegatedProfile
      ? { maxModelCalls: delegatedProfile.budget.modelCalls, maxToolCalls: delegatedProfile.budget.toolCalls }
      : profile.budget;
  try {
    if (!taskStore.taskIsRunning(taskId, workerId, leaseToken)) return { kind: "stopped" };
    if (profile.plan) await planIfNeeded(task, llm, budget, kernelRunId);
  } catch (e) {
    const message = "规划失败：" + String((e && e.message) || e);
    if (kernelRunId) kernelStore.failAgentRun(kernelRunId, message);
    return { kind: "failed", code: "planner_failed", message: message };
  }

  task = taskStore.getTask(taskId);
  const taskEvents = task.events || [];
  const askCount = taskEvents.filter((e) => e.type === "task.waiting_user").length;
  // 源 396-401：工具声明来自 Capability Router；执行层暂时保留旧 file/skill 兼容分支。
  if (!profile.skills) routeTools = routeTools.filter((tool) => !tool.function.name.startsWith("skill__"));
  if (fastDocument) {
    const allowed = new Set(["fs_mkdir", "fs_create", "fs_write"]);
    routeTools = routeTools.filter((tool) => allowed.has(tool.function.name));
  }
  const expectedSchema = parseExpectedSchema(task);
  const finishTool = expectedSchema ? Object.assign({}, FINISH_TOOL, {
    function: Object.assign({}, FINISH_TOOL.function, {
      parameters: Object.assign({}, FINISH_TOOL.function.parameters, {
        properties: Object.assign({}, FINISH_TOOL.function.parameters.properties, { output: expectedSchema }),
        required: ["summary", "output"],
      }),
    }),
  }) : FINISH_TOOL;
  const reviewer = task.agent_profile_id === "reviewer";
  const capabilityAdapter = effective.capabilityAdapter;
  const capabilityToolset = capabilityAdapter.createProgressiveCapabilityToolset(routeTools, { surface: "思考模式" });
  for (const event of taskEvents.filter((item) => item.type === "agent.capability.routed")) {
    try {
      const args = JSON.parse(event.data_json || "{}");
      const decision = capabilityToolset.discover(args);
      capabilityToolset.applyTargets(await capabilityAdapter.discoverCapabilityTargetsForUser(
        userId,
        decision.activated.flatMap((item) => item.intents),
        capabilityAdapter.normalizeCapabilityReferences(args.references),
        capabilityAdapter.normalizeCapabilityRequirements(args.requirements),
      ));
    } catch { /* 忽略损坏的历史路由事件（源 417） */ }
  }
  const controlTools = [
    finishTool,
    ...(!reviewer && profile.plan && kernelRunId ? [delegateTool(supervisor)] : []),
    ...(!reviewer && profile.memory ? [MEMORY_TOOL] : []),
    ...(askCount < 2 ? [ASK_TOOL] : []),
  ];
  const modelTools = () => [...capabilityToolset.tools(), ...controlTools];
  const messages = buildContext(task);
  const system = [systemForTask(task, fastDocument), ...kernelPromptAdditions].filter(Boolean).join("\n\n");
  let lastSteerSequence = 0;
  let schemaCorrectionCount = taskEvents.filter((event) => event.type === "agent.schema_correction").length;

  for (;;) {
    if (!taskStore.taskIsRunning(taskId, workerId, leaseToken)) return { kind: "stopped" };
    const steerEvents = taskStore.getTask(taskId).events.filter((event) => event.type === "agent.steer" && event.sequence > lastSteerSequence);
    if (steerEvents.length) {
      lastSteerSequence = steerEvents.at(-1).sequence;
      messages.push({ role: "user", content: "Supervisor 实时纠偏：\n" + steerEvents.map((event) => event.message).join("\n") });
    }
    let round;
    let durableTurn = taskStore.latestResumableAgentTurn(taskId);
    if (durableTurn) {
      try { round = JSON.parse(durableTurn.response_json); }
      catch { return { kind: "failed", code: "checkpoint_invalid", message: "持久化 Agent Turn 无法解析，已停止以避免重复执行工具" }; }
    } else {
      if (!taskStore.consumeBudget(taskId, "model", budget)) {
        return { kind: "failed", code: "budget_exhausted", message: "模型调用达到上限（" + budget.maxModelCalls + " 次），任务未完成" };
      }
      try {
        const tools = modelTools();
        const requestHash = createHash("sha256").update(JSON.stringify({ system: system, messages: messages, tools: tools })).digest("hex");
        round = await trackedModelCall(kernelRunId, taskId, llm, { messages: messages, system: system, tools: tools, timeoutMs: 240000 });
        // 源 446：先持久化完整 provider 响应和 tool calls，任何副作用都只能发生在此之后。
        durableTurn = taskStore.persistAgentTurn({ runId: kernelRunId, taskId: taskId, attemptNo: task.attempt_no, workerId: workerId, leaseToken: leaseToken, requestHash: requestHash, content: round.content, toolCalls: round.toolCalls });
      } catch (e) {
        return { kind: "failed", code: "model_error", message: "模型调用失败：" + String((e && e.message) || e) };
      }
    }
    if (!round.toolCalls.length) {
      // 模型只说话不动手：提醒一次，第二次按失败处理（源 452-462）
      messages.push({ role: "assistant", content: round.content || "" });
      messages.push({ role: "user", content: "请调用工具继续执行，全部完成后调用 finish_task。" });
      taskStore.appendTaskEvent(taskId, "react.note", (round.content || "（空回复）").slice(0, 300));
      const currentEvents = taskStore.getTask(taskId).events;
      const continuedSequence = (currentEvents.filter((e) => e.type === "task.continued").at(-1) || {}).sequence || 0;
      const notes = currentEvents.filter((e) => e.type === "react.note" && e.sequence > continuedSequence).length;
      if (notes >= 3) return { kind: "failed", code: "model_stalled", message: "模型连续多轮未执行任何动作" };
      taskStore.completeAgentTurn(durableTurn.id, workerId, leaseToken);
      continue;
    }

    messages.push({
      role: "assistant", content: round.content || "",
      tool_calls: round.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    });

    // 恢复时补回当前 turn 中已确认完成的 observation，不重新调用模型或工具（源 470-487）。
    for (let index = 0; index < durableTurn.next_tool_index; index += 1) {
      const call = round.toolCalls[index];
      if (!call) continue;
      if (capabilityToolset.isDiscovery(call.name)) {
        const args = safeParse(call.arguments);
        const discovery = await runCapabilityDiscovery({ toolset: capabilityToolset, args: args, userId: userId });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(discovery.result).slice(0, 6000) });
        continue;
      }
      const previous = taskStore.findOperation(taskId + ":turn:" + durableTurn.id + ":call:" + index);
      let content = "该工具调用已在持久化检查点中完成。";
      if (previous && previous.status === "completed" && previous.result_json) {
        try { content = formatObservation(JSON.parse(previous.result_json)); } catch { /* 保留有限恢复说明（源 484） */ }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: content.slice(0, 6000) });
    }

    const checkpointCall = (nextToolIndex) => taskStore.advanceAgentTurn(durableTurn.id, nextToolIndex, {
      runId: kernelRunId, taskId: taskId, attemptNo: task.attempt_no, workerId: workerId, leaseToken: leaseToken,
      state: { iteration: durableTurn.iteration, nextToolIndex: nextToolIndex, lastSteerSequence: lastSteerSequence, schemaCorrectionCount: schemaCorrectionCount },
    });

    for (let callIndex = durableTurn.next_tool_index; callIndex < round.toolCalls.length; callIndex += 1) {
      const call = round.toolCalls[callIndex];
      if (!taskStore.taskIsRunning(taskId, workerId, leaseToken)) return { kind: "stopped" };
      const args = safeParse(call.arguments);

      if (capabilityToolset.isDiscovery(call.name)) {
        const discovery = await runCapabilityDiscovery({ toolset: capabilityToolset, args: args, userId: userId });
        taskStore.appendTaskEvent(taskId, "agent.capability.routed", "已激活 " + discovery.decision.activated.length + " 个能力", {
          intents: Array.isArray(args.intents) ? args.intents : [],
          domains: Array.isArray(args.domains) ? args.domains : [],
          references: capabilityAdapter.normalizeCapabilityReferences(args.references),
          activated: discovery.decision.activated.map((item) => item.id),
        });
        if (kernelRunId) kernelStore.appendAgentRunEvent(kernelRunId, "capability.completed", {
          toolName: call.name, activated: discovery.decision.activated.map((item) => item.id), targets: capabilityAdapter.selectedCapabilityTargets(discovery.result.targets),
        });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(discovery.result).slice(0, 6000) });
        checkpointCall(callIndex + 1);
        continue;
      }

      if (call.name === "delegate_agents") {
        if (!kernelRunId || !Array.isArray(args.children)) {
          messages.push({ role: "tool", tool_call_id: call.id, content: "委派失败：缺少父 Run 或 children。" });
          checkpointCall(callIndex + 1);
          continue;
        }
        try {
          const delegated = supervisor.delegateAgentWork(kernelRunId, userId, args.children);
          checkpointCall(callIndex + 1);
          if (taskStore.waitForChildren(taskId, workerId, delegated.children.length, leaseToken)) return { kind: "waiting_children" };
          return { kind: "stopped" };
        } catch (error) {
          messages.push({ role: "tool", tool_call_id: call.id, content: "委派失败：" + String((error && error.message) || error) });
          checkpointCall(callIndex + 1);
          continue;
        }
      }

      if (call.name === "finish_task") {
        const summary = String(args.summary || "任务完成");
        if (expectedSchema) {
          const issues = effective.schemaValidator.validateJsonSchema(args.output, expectedSchema);
          if (issues.length) {
            const message = "结构化结果未通过 expectedOutputSchema：" + issues.slice(0, 5).map((issue) => issue.path + " " + issue.message).join("；");
            taskStore.appendTaskEvent(taskId, "agent.schema_correction", message);
            if (schemaCorrectionCount++ < 1) {
              messages.push({ role: "tool", tool_call_id: call.id, content: message + "。请修正 output 后再次调用 finish_task，不要重复执行已完成工具。" });
              checkpointCall(callIndex + 1);
              continue;
            }
            return { kind: "failed", code: "output_schema_invalid", message: message };
          }
        }
        checkpointCall(callIndex + 1);
        taskStore.completeAgentTurn(durableTurn.id, workerId, leaseToken);
        return { kind: "finished", summary: summary, output: args.output };
      }

      if (call.name === "ask_user") {
        const question = String(args.question || "需要你的补充说明");
        checkpointCall(callIndex + 1);
        if (taskStore.waitForUser(taskId, workerId, question, leaseToken)) {
          if (kernelRunId) kernelStore.waitAgentRun(kernelRunId, question);
          taskStore.postTaskMessage(taskId, "assistant", "❓ " + question);
          return { kind: "waiting_user" };
        }
        return { kind: "stopped" };
      }

      if (call.name === "save_memory") {
        const content = String(args.content || "").trim();
        let note = "记忆内容为空，未保存";
        if (content) {
          try {
            const current = taskStore.getTask(taskId);
            // 源 567-568：私人对话的任务不能自动写入共享项目记忆
            const thread = taskStore.threadVisibility(current.thread_id);
            if (thread === "private") {
              note = "本任务来自私人对话，未写入共享项目记忆（可在项目「记忆」标签手动添加）";
            } else {
              const memory = taskStore.addMemory({ projectId: current.project_id, content: content, sourceType: "task", sourceId: taskId });
              taskStore.appendTaskEvent(taskId, "memory.saved", content.slice(0, 200), { memoryId: memory.id });
              note = "已存入项目记忆：" + content;
            }
          } catch (e) { note = "记忆保存失败：" + String((e && e.message) || e); }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: note });
        checkpointCall(callIndex + 1);
        continue;
      }

      // 授权双检：源 30 声明“权限由 Registry 暴露前+执行前双检”。暴露前即 modelTools()；
      // 这里补上执行前校验，越界/未知名工具一律拒绝，绝不交给工具注册表兜底。
      const exposedNames = new Set(modelTools().map((tool) => tool.function && tool.function.name).filter(Boolean));
      if (!exposedNames.has(call.name)) {
        messages.push({ role: "tool", tool_call_id: call.id, content: "工具未授权（unknown_tool）：" + call.name + " 不在本轮授权工具集内，已拒绝执行。" });
        checkpointCall(callIndex + 1);
        continue;
      }

      // 源 583-681：文件/Skill/MCP 工具：持久步骤 + 幂等 + 预算
      const lengthError = fastDocument ? fastDocumentLengthError(task, call.name, args) : "";
      if (lengthError) {
        messages.push({ role: "tool", tool_call_id: call.id, content: lengthError });
        checkpointCall(callIndex + 1);
        continue;
      }
      const stableOperationId = taskId + ":turn:" + durableTurn.id + ":call:" + callIndex;
      const durableOperation = taskStore.findOperation(stableOperationId);
      if (durableOperation && durableOperation.status === "running") {
        const question = "工具 " + call.name + " 的上次执行结果未知。为避免重复外部副作用，系统已停止自动重放；请核对外部结果后决定是否人工重试。";
        taskStore.appendTaskEvent(taskId, "operation.unknown", question, { operationId: stableOperationId, toolName: call.name });
        if (taskStore.waitForUser(taskId, workerId, question, leaseToken)) {
          if (kernelRunId) kernelStore.waitAgentRun(kernelRunId, question);
          return { kind: "waiting_user" };
        }
        return { kind: "stopped" };
      }
      if (!durableOperation && !taskStore.consumeBudget(taskId, "tool", budget)) {
        return { kind: "failed", code: "budget_exhausted", message: "工具调用达到上限（" + budget.maxToolCalls + " 次），任务未完成" };
      }
      const stepLabel = call.name.startsWith("skill__")
        ? "技能 " + call.name.slice(7)
        : (call.name + " " + String(args.path || args.from || "")).trim();
      let step;
      try {
        step = taskStore.appendDynamicStep(taskId, stepLabel, call.name, args, stableOperationId);
      } catch {
        // UNIQUE 冲突 = 另一个 Worker 已接管本任务（源 607-610）
        return { kind: "stopped" };
      }
      if (step.status !== "queued" && step.status !== "completed") taskStore.requeueReactStepForResume(taskId, step.id, workerId, leaseToken);
      if (step.status !== "completed" && !taskStore.startStep(taskId, step.id, workerId, leaseToken)) return { kind: "stopped" };
      if (step.status !== "completed") {
        taskStore.appendTaskEvent(taskId, "step.started", stepLabel);
        if (kernelRunId) kernelStore.appendAgentRunEvent(kernelRunId, "capability.started", { toolName: call.name, stepId: step.id });
      }
      const toolUsage = !durableOperation && kernelRunId ? effective.usageAdapter.beginAgentUsage({ runId: kernelRunId, taskId: taskId, kind: "tool", toolName: call.name }) : undefined;
      let observation;
      try {
        effective.workspaceAdapter.assertRunWorkspaceWrite(kernelRunId, userId, toolRootNodeId);
        const previous = durableOperation || taskStore.findOperation(step.operation_id);
        let result;
        if (previous && previous.status === "completed" && previous.result_json) {
          result = JSON.parse(previous.result_json);
        } else if (call.name.startsWith("skill__")) {
          if (!taskStore.beginOperation(step.operation_id, taskId, call.name, workerId, leaseToken)) throw new Error("工具执行前任务租约已失效");
          const skill = await effective.skillAdapter.runSkill(call.name.slice(7), args, {
            rootId: toolRootNodeId,
            providerId: task.preferred_provider_id || undefined,
            model: task.preferred_llm_model || undefined,
            imageProviderId: task.preferred_image_provider_id || undefined,
            imageModel: task.preferred_image_model || undefined,
          });
          const media = [...(skill.images || []), ...(skill.videos || []), ...(skill.audios || [])];
          if (kernelRunId) for (const item of media) if (item.nodeId) effective.workspaceAdapter.stageRunArtifactNode(kernelRunId, item.nodeId);
          const firstMedia = media[0];
          result = Object.assign(
            { message: "技能 " + call.name.slice(7) + " 完成", content: String(skill.text || "").slice(0, 8000) },
            firstMedia ? { deliverable: true, nodeId: firstMedia.nodeId, name: firstMedia.name } : {},
          );
          if (!taskStore.finishOperation(step.operation_id, result, taskId, workerId, leaseToken)) throw new Error("工具完成时任务租约已失效，结果进入待对账状态");
        } else if (call.name.startsWith("mcp__")) {
          if (!taskStore.beginOperation(step.operation_id, taskId, call.name, workerId, leaseToken)) throw new Error("工具执行前任务租约已失效");
          // D5-04：携带本任务上下文（taskId + 本步骤 id + 本 kernel run），让 MCP 调用经
          // dx-task-approval-bridge 幂等映射进既有审批链；缺 taskId 会在 propose 前 fail closed。
          result = { message: "MCP 工具 " + call.name + " 完成", content: String(await effective.mcpAdapter.callByName(call.name, args, { taskId, stepId: step.id, runId: kernelRunId || null })).slice(0, 8000) };
          if (!taskStore.finishOperation(step.operation_id, result, taskId, workerId, leaseToken)) throw new Error("工具完成时任务租约已失效，结果进入待对账状态");
        } else {
          if (!taskStore.beginOperation(step.operation_id, taskId, call.name, workerId, leaseToken)) throw new Error("工具执行前任务租约已失效");
          result = await effective.toolRunner.runTool(call.name, { rootNodeId: toolRootNodeId, userId: userId, runId: kernelRunId }, args);
          if (kernelRunId && result.deliverable && typeof args.path === "string") effective.workspaceAdapter.stageRunArtifact(kernelRunId, args.path);
          if (!taskStore.finishOperation(step.operation_id, result, taskId, workerId, leaseToken)) throw new Error("工具完成时任务租约已失效，结果进入待对账状态");
        }
        const task2 = taskStore.getTask(taskId);
        const deliverable = result.deliverable && result.nodeId
          ? { projectId: task2.project_id, nodeId: result.nodeId, name: result.name || call.name }
          : undefined;
        if (toolUsage) effective.usageAdapter.finishAgentUsage(toolUsage.id, { status: "completed", latencyMs: clockNow() - toolUsage.startedAt });
        if (step.status !== "completed" && !taskStore.completeStep(taskId, step.id, workerId, result, deliverable, leaseToken)) return { kind: "stopped" };
        if (step.status !== "completed" && kernelRunId) kernelStore.appendAgentRunEvent(kernelRunId, "capability.completed", { toolName: call.name, stepId: step.id });
        observation = formatObservation(result);
        if (fastDocument && result.deliverable && (call.name === "fs_create" || call.name === "fs_write")) {
          const path = String(args.path || result.name || "文档");
          checkpointCall(callIndex + 1);
          taskStore.completeAgentTurn(durableTurn.id, workerId, leaseToken);
          return { kind: "finished", summary: "已完成文稿并保存至 " + path };
        }
      } catch (e) {
        const ToolError = effective.toolRunner.ToolError;
        const code = typeof ToolError === "function" && e instanceof ToolError ? e.code : "internal";
        const message = String((e && e.message) || e);
        if (toolUsage) effective.usageAdapter.finishAgentUsage(toolUsage.id, { status: "failed", latencyMs: clockNow() - toolUsage.startedAt, error: e });
        taskStore.failStep(taskId, step.id, workerId, message, leaseToken);
        if (kernelRunId) kernelStore.appendAgentRunEvent(kernelRunId, "capability.failed", { toolName: call.name, stepId: step.id, message: message });
        // 工具失败不终止任务：把错误交给模型修正参数（源 677-678）
        observation = "工具执行失败（" + code + "）：" + message;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: observation.slice(0, 6000) });
      checkpointCall(callIndex + 1);
    }
    taskStore.completeAgentTurn(durableTurn.id, workerId, leaseToken);
  }
}

// ---------------------------------------------------------------------------
// 源 reactDriver.ts:687-703
// ---------------------------------------------------------------------------

function safeParse(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

function formatObservation(result) {
  const parts = [result.message];
  if (result.content !== undefined) parts.push(String(result.content).slice(0, 4000));
  if (result.entries) parts.push(result.entries.map((e) => (e.type === "folder" ? "文件夹 " : "文件 ") + e.name).join("\n") || "(空)");
  return parts.filter(Boolean).join("\n");
}

/** 源 reactDriver.ts:699-703 · react 任务失败：围栏在 workerId 上。 */
function markReactFailure(taskId, workerId, code, message, leaseToken) {
  const effective = resolveDependencies();
  if (!effective.taskStore) return false;
  const changed = effective.taskStore.failTaskFenced(taskId, workerId, code, message, leaseToken);
  if (!changed) return false;
  if (code !== "no_llm_provider") effective.taskStore.postTaskMessage(taskId, "system", "任务失败：" + message);
  return true;
}

module.exports = {
  AGENT_DEPENDENCY_UNAVAILABLE,
  configureReactDriver,
  getReactDriverDependencies,
  resetReactDriverForTests,
  agentDependencyUnavailable,
  isSingleDocumentCreation,
  requestedDocumentLength,
  fastDocumentLengthError,
  systemForTask,
  pickLlm,
  trackedModelCall,
  buildContext,
  planIfNeeded,
  runReactTask,
  markReactFailure,
  safeParse,
  formatObservation,
  FINISH_TOOL,
  ASK_TOOL,
  MEMORY_TOOL,
  SYSTEM,
};
