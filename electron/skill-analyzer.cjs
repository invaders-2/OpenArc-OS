"use strict";
/**
 * B4c · 技能文档分析（源 server/skillAnalyzer.ts:1-263）。
 *
 * 逐字对应：
 *   · BASE_SKILLS          skillAnalyzer.ts:14
 *   · ANALYZE_TOOL         skillAnalyzer.ts:16-66
 *   · SYSTEM               skillAnalyzer.ts:68-77
 *   · ARGS_TOOL            skillAnalyzer.ts:84-99
 *   · planPackRunArgs      skillAnalyzer.ts:102-125
 *   · runPackAiTest        skillAnalyzer.ts:128-176
 *   · analyzeSkillDocument skillAnalyzer.ts:178-263
 *
 * 【OUT 删除记录】源 skillAnalyzer.ts:1 经 protocols.ts 的 callChat/chatWithTools、
 *   :4 经 store.ts 的 allProviders/getAutoFallback 间接联网。这些出口统一改走注入 modelAdapter；
 *   源文件本身没有 dxosProtocol（云端 AI 任务）/ apiQuota（计费）/ cloudEntitlement（权益）调用，
 *   因此本文件无对应删除项，也没有任何绕过注入的本地模型实现。
 *
 * 【依赖注入】configureSkillAnalyzer({ modelAdapter, skillStore, builtinTools, providerAdapter, clock, logger })
 *   · modelAdapter（必需）形状对齐 B2 electron/provider-protocol-service.cjs:151 的 call 出口：
 *       call({ provider, providerId, model, messages, system, tools, params, signal, timeoutMs })
 *         -> { ok, text|content, toolCalls:[{id,name,arguments}], usage, latencyMs }
 *     可选：resolveChatTarget(opts) / listChatTargets()。
 *   · skillStore（源 skills.ts 存储）默认惰性 require ./skill-store.cjs；
 *     只用 resolveChatTarget 与 PROCEDURE_BASE_SKILL_IDS。缺模块时抛结构化依赖错误。
 *   · builtinTools（源 agentTools.ts）默认惰性 require ./agent-builtin-tools.cjs；只用 FILE_TOOLS 白名单。
 *   · providerAdapter（可选）{ all(), autoFallback() }，仅 runPackAiTest 的多目标枚举需要。
 *   任一必需依赖缺失都抛 AGENT_DEPENDENCY_UNAVAILABLE，不静默降级、不伪造结果。
 */

/** 结构化依赖缺失码（与 agent-task-store.cjs:48 / skill-import.cjs:40 同一约定）。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

function dependencyUnavailable(name, detail) {
  const err = new Error("技能分析依赖不可用：" + String(name));
  err.name = "AgentDependencyUnavailableError";
  err.code = AGENT_DEPENDENCY_UNAVAILABLE;
  err.dependency = String(name);
  if (detail !== undefined) err.detail = detail;
  return err;
}

// ---------------------------------------------------------------------------
// 注入中心（源用模块级 import）
// ---------------------------------------------------------------------------
let deps = {
  modelAdapter: null,
  skillStore: null,
  builtinTools: null,
  providerAdapter: null,
  clock: () => Date.now(),
  logger: null,
};

/** 注入分析依赖（源 skillAnalyzer.ts:1-4 的 import 集合）。 */
function configureSkillAnalyzer(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw dependencyUnavailable("configureSkillAnalyzer", "配置必须是对象");
  }
  const next = { ...deps };
  for (const key of ["modelAdapter", "skillStore", "builtinTools", "providerAdapter", "logger"]) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key] || null;
  }
  if (typeof patch.clock === "function") next.clock = patch.clock;
  deps = next;
  return { ...deps };
}

/** 仅供测试：清空注入，恢复"未接入"状态。 */
function resetSkillAnalyzerForTests() {
  deps = { modelAdapter: null, skillStore: null, builtinTools: null, providerAdapter: null, clock: () => Date.now(), logger: null };
  return { ...deps };
}

function requireAdapter(name) {
  const value = deps[name];
  if (!value) throw dependencyUnavailable(name);
  return value;
}

/** 解析技能存储：显式注入优先，其次惰性 require skill-store.cjs（B4a 冻结契约）。 */
function resolveSkillStore() {
  if (deps.skillStore) return deps.skillStore;
  try {
    // eslint-disable-next-line global-require
    return require("./skill-store.cjs");
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND" && /skill-store\.cjs/.test(String(error.message))) {
      throw dependencyUnavailable("skillStore", "electron/skill-store.cjs 尚未接入（B4a 并行波次）");
    }
    throw error;
  }
}

/** 解析内置文件工具目录（源 agentTools.ts FILE_TOOLS），只用于能力白名单校验。 */
function resolveBuiltinTools() {
  if (deps.builtinTools) return deps.builtinTools;
  try {
    // eslint-disable-next-line global-require
    return require("./agent-builtin-tools.cjs");
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND" && /agent-builtin-tools\.cjs/.test(String(error.message))) {
      throw dependencyUnavailable("builtinTools", "electron/agent-builtin-tools.cjs 尚未接入");
    }
    throw error;
  }
}

/**
 * skillAnalyzer.ts:14 的基础能力表。与 electron/skill-store.cjs:819 PROCEDURE_BASE_SKILL_IDS 完全一致；
 * 注入的 skillStore 暴露该常量时优先用它，保证跨模块单一事实来源。
 */
const DEFAULT_BASE_SKILLS = Object.freeze([
  "writing", "rewrite", "analysis", "code", "chat",
  "generate_image", "upscale_image", "midjourney", "generate_video",
  "text_to_speech", "transcribe_audio", "generate_music", "edit_image", "describe_image",
]);

function baseSkills() {
  if (deps.skillStore && Array.isArray(deps.skillStore.PROCEDURE_BASE_SKILL_IDS)) return deps.skillStore.PROCEDURE_BASE_SKILL_IDS;
  try {
    const store = resolveSkillStore();
    if (Array.isArray(store.PROCEDURE_BASE_SKILL_IDS)) return store.PROCEDURE_BASE_SKILL_IDS;
  } catch {
    /* 模块缺失时回落到源字面表，避免把"白名单"误当成必需依赖 */
  }
  return DEFAULT_BASE_SKILLS;
}

/** skillAnalyzer.ts:12 —— FILE_TOOLS.map((t) => t.name) 的能力白名单。 */
function validTools() {
  const tools = resolveBuiltinTools();
  const list = Array.isArray(tools.FILE_TOOLS) ? tools.FILE_TOOLS : [];
  return new Set(list.map((tool) => String((tool && tool.name) || "")).filter(Boolean));
}

// ---------------------------------------------------------------------------
// 模型出口（源 skillAnalyzer.ts:1 chatWithTools / callChat 与 :4 allProviders/getAutoFallback）
// ---------------------------------------------------------------------------

/** 解析聊天目标：modelAdapter 自带优先，其次技能存储的 provider 选型（skills.ts:640-661）。 */
function resolveChatTarget() {
  const adapter = deps.modelAdapter;
  if (adapter && typeof adapter.resolveChatTarget === "function") {
    const target = adapter.resolveChatTarget({});
    if (target && target.model) return target;
  }
  const store = resolveSkillStore();
  if (store && typeof store.resolveChatTarget === "function") {
    const target = store.resolveChatTarget({});
    if (target && target.model) return target;
  }
  throw dependencyUnavailable("modelAdapter.resolveChatTarget / skillStore.resolveChatTarget");
}

function toolCallsOf(response) {
  if (!response || !Array.isArray(response.toolCalls)) return [];
  return response.toolCalls.map((call) => ({
    name: String((call && call.name) || ""),
    arguments: String((call && call.arguments) || "{}"),
  }));
}

/** 统一模型调用：源 chatWithTools(provider, model, messages, system, tools, timeout)。 */
async function callModel(input) {
  const adapter = requireAdapter("modelAdapter");
  if (typeof adapter.call !== "function") throw dependencyUnavailable("modelAdapter.call");
  const target = input.target || resolveChatTarget();
  const provider = target.provider || null;
  const response = await adapter.call({
    provider,
    providerId: provider && provider.id ? provider.id : undefined,
    model: target.model,
    messages: input.messages,
    system: input.system,
    tools: input.tools,
    params: input.params || {},
    timeoutMs: input.timeoutMs,
    signal: input.signal || null,
  });
  // provider-protocol-service 失败返回 { ok:false, error }；这里保持"调用失败即抛"的源语义。
  if (response && response.ok === false) {
    const err = new Error("技能分析模型调用失败：" + String(response.error || "UNKNOWN"));
    err.code = response.error || "MODEL_CALL_FAILED";
    err.requestId = response.requestId;
    throw err;
  }
  return response || {};
}

// ---------------------------------------------------------------------------
// skillAnalyzer.ts:14-99 常量
// ---------------------------------------------------------------------------
const BASE_SKILLS = DEFAULT_BASE_SKILLS;

const ANALYZE_TOOL = {
  type: "function",
  function: {
    name: "submit_skill_analysis",
    description: "提交对第三方 Skill 文档的结构化解析结果",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "小写字母开头的英文 id，如 weekly_report" },
        name: { type: "string", description: "简短中文名称" },
        description: { type: "string", description: "一句话说明该 Skill 做什么（120 字内）" },
        triggers: { type: "array", items: { type: "string" }, description: "2-4 条触发条件：用户什么样的请求应该用它" },
        inputs: { type: "array", items: { type: "string" }, description: "执行前需要用户提供的输入（人话，如“商品名称与卖点”）" },
        steps: {
          type: "array",
          description: "3-8 个分步工作流。每步映射到平台基础能力：文档里“调用 API 生图”→ uses=generate_image；“写文案”→ uses=writing；纯思考/拼模板的步骤 uses 留空",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "步骤短标题" },
              detail: { type: "string", description: "这一步做什么、用哪个资源模板、注意什么（100 字内）" },
              uses: { type: "string", description: "这一步用的基础能力，从这些里选：" + BASE_SKILLS.join(", ") + "；不需要工具留空" },
            },
            required: ["title", "detail"],
          },
        },
        allowedTools: { type: "array", items: { type: "string" }, description: "执行需要的基础能力白名单（steps 里 uses 的并集），可选：" + BASE_SKILLS.join(", ") },
        resources: {
          type: "array",
          description: "从文档提炼的可复用资源：提示词模板、风格参数、检查清单原文等。原样摘录（可精简），执行时会注入给模型",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "资源名，如“白底主图提示词模板”" },
              content: { type: "string", description: "资源内容原文（2000 字内）" },
            },
            required: ["name", "content"],
          },
        },
        readsFiles: { type: "boolean", description: "是否需要读取项目文件" },
        writesFiles: { type: "boolean", description: "是否会创建/修改文件（生图会保存文件，算 true）" },
        network: { type: "boolean", description: "除基础能力自带的模型调用外，是否还需要额外联网（爬网页、调外部服务）。仅调 LLM/生图 API 的填 false，因为平台基础能力已覆盖" },
        sensitive: { type: "array", items: { type: "string" }, description: "文档中出现的敏感动作（发送消息、删除数据、账号操作等）；没有则空" },
        output: { type: "string", description: "产出说明：生成什么、放到哪（80 字内）" },
        checks: { type: "array", items: { type: "string" }, description: "2-5 条完成前自查项（优先用文档自带的质检标准）" },
        systemPrompt: { type: "string", description: "为该 Skill 提炼的执行 system prompt：角色 + 领域最佳实践摘要 + 输出规则，600 字内，中文" },
      },
      required: ["id", "name", "description", "triggers", "steps", "allowedTools", "readsFiles", "writesFiles", "network", "output", "checks", "systemPrompt"],
    },
  },
};

/** skillAnalyzer.ts:68-77 逐字。 */
const SYSTEM = `你是 DX OS 的 Skill 解析器。用户上传了第三方 Skill 文档，你要把它翻译成平台可执行的 Skill 定义。
核心原则：第三方 Skill 的价值在工作流知识（步骤、提示词模板、质检标准），执行能力一律替换成平台基础能力：
- 文档里的普通生图脚本/图像 API 调用 → uses=generate_image（平台会用用户配置的模型站点生图）；已有图片超分放大 → uses=upscale_image；明确要求 Midjourney 或其 U/V、Blend、Zoom、Pan、Inpaint、Remix 操作 → uses=midjourney
- 文档里的文生视频、图生视频、首尾帧或参考视频生成 → uses=generate_video
- 改图/局部重绘 → uses=edit_image；看图分析 → uses=describe_image
- 写文案/长文 → uses=writing；改写润色 → uses=rewrite；分析判断 → uses=analysis
- 文档里的 Python/Shell 脚本本身不纳入，只提取它体现的流程与参数含义
- 提示词模板、参数对照表、质检清单 → 摘录进 resources（这是最有价值的部分，尽量完整）
- systemPrompt 要浓缩文档的领域知识（如构图规范、风格要求），能独立指导模型
全部用中文输出（id 除外）。用 submit_skill_analysis 提交。`;

/** skillAnalyzer.ts:84-99 逐字。 */
const ARGS_TOOL = {
  type: "function",
  function: {
    name: "submit_run_args",
    description: "提交命令行参数数组",
    parameters: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, description: "按顺序的命令行参数，如 [\"--prompt\",\"一只猫\",\"--n\",\"2\"]。值不要带引号包裹。" },
        note: { type: "string", description: "给用户的一句执行说明（用了哪些默认值、有什么限制）" },
        blocked: { type: "string", description: "如果指令无法映射到该脚本的参数（缺关键信息/功能不符），说明原因；能执行则留空" },
      },
      required: ["args"],
    },
  },
};

// ---------------------------------------------------------------------------
// skillAnalyzer.ts:102-125 planPackRunArgs
// ---------------------------------------------------------------------------
/** Agent 运行 Skill 包：把自然语言指令翻译成入口脚本的命令行参数。 */
async function planPackRunArgs(input) {
  const payload = input || {};
  const response = await callModel({
    messages: [{
      role: "user",
      content: [
        "用户想运行一个第三方 Skill 的 Python 入口，请把用户指令翻译成该脚本的命令行参数。",
        "脚本 --help 输出：\n" + String(payload.helpText || "").slice(0, 6000),
        payload.docs ? "包内 SKILL.md 摘要：\n" + String(payload.docs).slice(0, 6000) : "",
        "用户指令：" + String(payload.instruction || ""),
        "注意：沙箱无网络、无环境变量文件；如果脚本必须联网才有意义，仍然生成参数（让脚本自己报错），但在 note 里说明。必填参数缺少且无法从指令推断时用 blocked 说明。",
      ].filter(Boolean).join("\n\n"),
    }],
    system: "你是命令行参数规划器。只依据 --help 与文档，不发明不存在的参数。用 submit_run_args 提交。",
    tools: [ARGS_TOOL],
    timeoutMs: 120000,
  });
  const call = toolCallsOf(response).find((item) => item.name === "submit_run_args");
  if (!call) throw new Error("Agent 未能生成运行参数，请手动填写");
  let parsed = {};
  try { parsed = JSON.parse(call.arguments || "{}"); } catch { throw new Error("参数结果解析失败"); }
  const args = Array.isArray(parsed.args) ? parsed.args.map(String).filter((item) => item.length <= 500).slice(0, 32) : [];
  return { args, note: String(parsed.note || ""), blocked: String(parsed.blocked || "") };
}

// ---------------------------------------------------------------------------
// skillAnalyzer.ts:128-176 runPackAiTest
// ---------------------------------------------------------------------------

/** 源 allProviders()/getAutoFallback() 的注入等价物：输出有序 LLM 目标链。 */
function listAiTestTargets() {
  const adapter = deps.modelAdapter;
  if (adapter && typeof adapter.listChatTargets === "function") {
    const targets = adapter.listChatTargets();
    return Array.isArray(targets) ? targets.filter((item) => item && item.model) : [];
  }
  const providerAdapter = deps.providerAdapter;
  if (providerAdapter && typeof providerAdapter.all === "function") {
    const autoFallback = typeof providerAdapter.autoFallback === "function" ? providerAdapter.autoFallback() !== false : false;
    // provider-adapter-bridge.cjs 的只读投影用 has_key 取代 api_key（真值密钥不跨出适配器）。
    const providers = (providerAdapter.all() || []).filter((provider) => provider && provider.source !== "cli" && provider.enabled && (provider.api_key || provider.has_key) && provider.base_url);
    const modelTargets = providers
      .map((provider) => ({ provider, models: (provider.models || []).filter((model) => (model.caps || []).includes("llm")) }))
      .filter((target) => target.models.length);
    const flat = [
      ...modelTargets.map((target) => ({ provider: target.provider, model: target.models[0].model, providerName: target.provider.name })),
      ...modelTargets.flatMap((target) => target.models.slice(1).map((model) => ({ provider: target.provider, model: model.model, providerName: target.provider.name }))),
    ];
    return flat.slice(0, autoFallback ? 8 : 1);
  }
  throw dependencyUnavailable("modelAdapter.listChatTargets / providerAdapter.all");
}

/** 不执行包内代码；让当前 LLM 直接按原始 Agent Skill 与 references 生成一次测试结果。 */
async function runPackAiTest(input) {
  const payload = input || {};
  const instruction = String(payload.instruction || "").trim();
  if (!instruction) throw new Error("请描述要测试的任务");
  const system = [
    "你正在测试导入的 Agent Skill：" + String(payload.sourceName || ""),
    "严格遵循下方 SKILL.md 与资源文件完成用户任务，直接给出最终产物。",
    "先在内部判断任务属于哪一种模式，并读取该模式对应的 reference。reference 中的最终格式、字段名、顺序、标签和时间记法都是硬约束。",
    "如果 Skill 规定了固定输出结构，必须逐字保留字段名并按规定顺序输出；禁止退化成普通说明、摘要或通用提示词。",
    "这是纯 AI 测试：不能执行包内脚本、访问网络或声称已经生成/保存真实媒体文件；需要媒体工具时，只输出对应提示词、规划或可检查的文本结果。",
    "",
    String(payload.context || "").slice(0, 64000),
  ].join("\n");

  const targets = listAiTestTargets();
  if (!targets.length) throw new Error("还没有可用的 LLM 模型站点");

  const failures = [];
  for (const target of targets) {
    try {
      const response = await callModel({
        target,
        messages: [{ role: "user", content: instruction }],
        system,
        tools: [],
        params: { temperature: 0.1 },
        timeoutMs: 180000,
      });
      return {
        text: response.text !== undefined ? response.text : (response.content || ""),
        model: target.model,
        provider: target.providerName || (target.provider && target.provider.name) || (target.provider && target.provider.id) || "",
        latencyMs: response.latencyMs,
        fallbacks: failures,
      };
    } catch (error) {
      const message = String((error && error.message) || error);
      failures.push(((target.providerName || (target.provider && target.provider.name) || "") + "/" + target.model + "：" + message).slice(0, 220));
      // 参数/内容错误通常会在所有站点重复，不做无意义降级；站点、鉴权、限流和服务错误可切换目标。
      if (/HTTP 4\d\d\b/.test(message) && !/HTTP (401|403|404|408|409|429)\b/.test(message)) break;
    }
  }
  throw new Error("所有可用 LLM 目标均未完成测试。" + failures.join("；"));
}

// ---------------------------------------------------------------------------
// skillAnalyzer.ts:178-263 analyzeSkillDocument
// ---------------------------------------------------------------------------
async function analyzeSkillDocument(markdown, sourceName) {
  const text = String(markdown || "").slice(0, 64000);
  const response = await callModel({
    messages: [{ role: "user", content: "第三方 Skill 文档（来源：" + String(sourceName || "") + "）：\n\n" + text }],
    system: SYSTEM,
    tools: [ANALYZE_TOOL],
    timeoutMs: 180000,
  });
  const call = toolCallsOf(response).find((item) => item.name === "submit_skill_analysis");
  // skillAnalyzer.ts:187
  if (!call) throw new Error("解析失败：模型未返回结构化结果，请重试或改用手动导入");
  let args;
  try { args = JSON.parse(call.arguments || "{}"); } catch { throw new Error("解析失败：结构化结果无法解析"); }

  const warnings = [];
  const strArr = (value, max) => (Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, max) : []);
  const baseSkillSet = new Set(baseSkills());
  const fileTools = validTools();
  const rawTools = strArr(args.allowedTools, 12);
  const allowedTools = rawTools.filter((item) => baseSkillSet.has(item) || fileTools.has(item));
  // skillAnalyzer.ts:196
  for (const item of rawTools) if (!baseSkillSet.has(item) && !fileTools.has(item)) warnings.push("忽略了不存在的能力：" + item);
  const sensitive = strArr(args.sensitive, 8);
  // skillAnalyzer.ts:198-199
  if (args.network === true) warnings.push("该 Skill 声明需要平台能力之外的联网（如爬网页）：暂不放行，相关步骤只输出文本");
  if (sensitive.length) warnings.push("包含敏感动作声明：" + sensitive.join("、") + "（执行时不会自动放行）");

  // skillAnalyzer.ts:201-212
  const steps = (Array.isArray(args.steps) ? args.steps : [])
    .map((step) => {
      const rec = step && typeof step === "object" ? step : {};
      const uses = String(rec.uses || "").trim();
      return {
        title: String(rec.title || "").slice(0, 60),
        detail: String(rec.detail || "").slice(0, 300),
        ...(uses && baseSkillSet.has(uses) ? { uses } : {}),
      };
    })
    .filter((step) => step.title)
    .slice(0, 10);
  if (!steps.length) throw new Error("解析失败：没有识别出工作流步骤");
  // skillAnalyzer.ts:215 步骤里用到但白名单漏掉的基础能力自动补齐
  for (const step of steps) if (step.uses && !allowedTools.includes(step.uses)) allowedTools.push(step.uses);

  // skillAnalyzer.ts:217-223
  const resources = (Array.isArray(args.resources) ? args.resources : [])
    .map((resource) => {
      const rec = resource && typeof resource === "object" ? resource : {};
      return { name: String(rec.name || "").slice(0, 60), content: String(rec.content || "").slice(0, 4000) };
    })
    .filter((resource) => resource.name && resource.content)
    .slice(0, 8);

  // skillAnalyzer.ts:225-242
  const v2 = {
    triggers: strArr(args.triggers, 6),
    inputs: strArr(args.inputs, 8),
    steps,
    allowedTools,
    permissions: {
      readsFiles: args.readsFiles === true,
      writesFiles: args.writesFiles === true,
      network: args.network === true,
      sensitive,
    },
    output: String(args.output || "").slice(0, 300),
    checks: strArr(args.checks, 8),
    ...(resources.length ? { resources } : {}),
    sourceName: String(sourceName || ""),
    analyzedAt: deps.clock(),
    version: 1,
  };
  // skillAnalyzer.ts:243-250
  const workflowText = steps.map((step, index) => (index + 1) + ". " + step.title + (step.uses ? "【用 " + step.uses + "】" : "") + "：" + step.detail).join("\n");
  const systemPrompt = [
    String(args.systemPrompt || "").slice(0, 3000),
    "",
    "工作流（按序执行）：",
    workflowText,
    v2.checks.length ? "\n完成前自查：\n" + v2.checks.map((check) => "- " + check).join("\n") : "",
  ].join("\n");

  // skillAnalyzer.ts:252-262
  return {
    skill: {
      id: String(args.id || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || undefined,
      name: String(args.name || "").slice(0, 60),
      description: String(args.description || "").slice(0, 180),
      kind: "procedure",
      systemPrompt,
      v2,
    },
    warnings,
  };
}

module.exports = {
  AGENT_DEPENDENCY_UNAVAILABLE,
  BASE_SKILLS,
  ANALYZE_TOOL,
  ARGS_TOOL,
  SYSTEM,
  dependencyUnavailable,
  configureSkillAnalyzer,
  resetSkillAnalyzerForTests,
  analyzeSkillDocument,
  planPackRunArgs,
  runPackAiTest,
};
