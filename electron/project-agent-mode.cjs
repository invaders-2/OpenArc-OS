"use strict";
/**
 * B4c · 项目级 Agent 模式（源 server/projectAgentMode.ts:1-309）。
 *
 * 逐字对应：
 *   · mediaArtifacts / fileArtifact / compactObservation        projectAgentMode.ts:27-78
 *   · parseCompletionReview                                     :80-94
 *   · runProjectAgentMode                                       :96-307
 *   · AgentTaskInterrupted                                      :309
 *
 * 【OUT 删除记录】源 projectAgentMode.ts 没有直接 import dxosProtocol（云端 AI 任务）/ apiQuota（计费）/
 *   cloudEntitlement（权益）；它经 agent-runtime 与 protocols.ts 触达模型。因此本文件无对应删除项，
 *   模型出口一律走注入 providerAdapter，绝不本地伪造。
 *
 * 【依赖注入】configureProjectAgentMode({
 *     agentRuntime, usage, fallback, toolLoop, capability, toolRunner,
 *     skillRunner, mcpAdapter, toolCatalog, providerAdapter, clock, logger })
 *   · agentRuntime  —— 源 agentRunManager + normalizeAgentRequestEnvelopeV1：
 *        { normalizeEnvelope, prepare, create, start, append, complete, fail, cancel }
 *        真实装配：normalizeEnvelope 取 agent-runtime-envelope.cjs 的 normalizeAgentRequestEnvelopeV1，
 *        其余取 agent-runtime-manager.cjs 的 agentRunManager 方法；RunManager 方法依赖 this，
 *        装配方必须 bind（例如 { ...mgr, prepare: mgr.prepare.bind(mgr), ... }）后再注入。
 *   · usage         —— 源 usageStore：{ beginAgentUsage, finishAgentUsage }
 *   · fallback      —— 源 modelFallback：{ runWithAgentModelFallback }
 *   · toolLoop      —— 源 serverAgentToolLoops（B3c electron/agent-runtime-tool-loop.cjs:75）：
 *        { create, restore, advance, snapshot, delete }
 *   · capability    —— 源 capabilityTargetResolver：
 *        { discoverCapabilityTargetsForUser, normalizeCapabilityReferences,
 *          normalizeCapabilityRequirements, selectedCapabilityTargets }
 *   · toolRunner    —— 源 agentTools.runTool：{ runTool(name, ctx, args) }
 *   · skillRunner   —— 源 skills.runSkill：{ runSkill(skillId, args, ctx) }（按需）
 *   · mcpAdapter    —— 源 mcp.callByName：{ callByName(name, args) }（按需）
 *   · toolCatalog   —— 源 toolCatalog.runCatalogTool：{ runCatalogTool(name, args, actor, options) }（按需）
 *   · providerAdapter —— 源 protocols.chatWithTools + store.getAutoFallback：
 *        { chatWithTools({ provider, providerId, model, messages, system, tools, params, signal, timeoutMs })
 *            -> { content|text, toolCalls, usage, latencyMs }, autoFallback() }
 *   核心依赖（agentRuntime / usage / fallback / toolLoop / capability / providerAdapter / toolRunner）
 *   在进入循环前一次性校验；skillRunner / mcpAdapter / toolCatalog 在其分支被真正用到时校验。
 *   任一未注入都抛结构化 AGENT_DEPENDENCY_UNAVAILABLE，不绕过、不降级。
 *
 * AuthUser 属 B4e：本文件只把 actor 当普通对象 { id, role, displayName } 使用。
 */

/** 结构化依赖缺失码（与 agent-task-store.cjs:48 同一约定）。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

function dependencyUnavailable(name, detail) {
  const err = new Error("项目 Agent 模式依赖不可用：" + String(name));
  err.name = "AgentDependencyUnavailableError";
  err.code = AGENT_DEPENDENCY_UNAVAILABLE;
  err.dependency = String(name);
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** 源 projectAgentMode.ts:309。 */
class AgentTaskInterrupted extends Error {}

/** task-34 F03：DX 0.6.1 的 30 分钟续跑窗口与继续问句。 */
const PROJECT_AGENT_WINDOW_MS = 30 * 60 * 1000;
const PROJECT_AGENT_CONTINUE_QUESTION = "任务仍在进行（已到 30 分钟执行窗口），是否继续任务？";

// ---------------------------------------------------------------------------
// 注入中心（源用模块级 import）
// ---------------------------------------------------------------------------
let deps = {
  agentRuntime: null,
  usage: null,
  fallback: null,
  toolLoop: null,
  capability: null,
  toolRunner: null,
  skillRunner: null,
  mcpAdapter: null,
  toolCatalog: null,
  providerAdapter: null,
  clock: () => Date.now(),
  logger: null,
};

function configureProjectAgentMode(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw dependencyUnavailable("configureProjectAgentMode", "配置必须是对象");
  }
  const next = { ...deps };
  for (const key of ["agentRuntime", "usage", "fallback", "toolLoop", "capability", "toolRunner", "skillRunner", "mcpAdapter", "toolCatalog", "providerAdapter", "logger"]) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key] || null;
  }
  if (typeof patch.clock === "function") next.clock = patch.clock;
  deps = next;
  return { ...deps };
}

/** 仅供测试：清空注入，恢复"未接入"状态。 */
function resetProjectAgentModeForTests() {
  deps = {
    agentRuntime: null, usage: null, fallback: null, toolLoop: null, capability: null,
    toolRunner: null, skillRunner: null, mcpAdapter: null, toolCatalog: null, providerAdapter: null,
    clock: () => Date.now(), logger: null,
  };
  return { ...deps };
}

function requireAdapter(name) {
  const value = deps[name];
  if (!value) throw dependencyUnavailable(name);
  return value;
}

function methodOf(adapterName, methodName) {
  const adapter = deps[adapterName];
  if (!adapter) throw dependencyUnavailable(adapterName);
  const fn = adapter[methodName];
  if (typeof fn !== "function") throw dependencyUnavailable(adapterName + "." + methodName);
  return fn;
}

/** 循环开始前一次性校验的核心依赖；返回绑定好的函数集合，避免循环里反复判空。 */
function resolveCoreDependencies() {
  const agentRuntime = deps.agentRuntime;
  if (!agentRuntime) throw dependencyUnavailable("agentRuntime");
  for (const method of ["normalizeEnvelope", "prepare", "create", "start", "append", "complete", "fail", "cancel"]) {
    if (typeof agentRuntime[method] !== "function") throw dependencyUnavailable("agentRuntime." + method);
  }
  const usage = deps.usage;
  if (!usage) throw dependencyUnavailable("usage");
  for (const method of ["beginAgentUsage", "finishAgentUsage"]) {
    if (typeof usage[method] !== "function") throw dependencyUnavailable("usage." + method);
  }
  const fallback = deps.fallback;
  if (!fallback || typeof fallback.runWithAgentModelFallback !== "function") throw dependencyUnavailable("fallback.runWithAgentModelFallback");
  // toolLoop 适配器 = 协调器实例；也接受 agent-runtime-tool-loop.cjs 模块命名空间（取其 serverAgentToolLoops）。
  const toolLoop = deps.toolLoop && typeof deps.toolLoop.create === "function"
    ? deps.toolLoop
    : (deps.toolLoop && deps.toolLoop.serverAgentToolLoops);
  if (!toolLoop) throw dependencyUnavailable("toolLoop");
  for (const method of ["create", "restore", "advance", "snapshot", "delete"]) {
    if (typeof toolLoop[method] !== "function") throw dependencyUnavailable("toolLoop." + method);
  }
  const capability = deps.capability;
  if (!capability) throw dependencyUnavailable("capability");
  for (const method of ["discoverCapabilityTargetsForUser", "normalizeCapabilityReferences", "normalizeCapabilityRequirements", "selectedCapabilityTargets"]) {
    if (typeof capability[method] !== "function") throw dependencyUnavailable("capability." + method);
  }
  const providerAdapter = deps.providerAdapter;
  if (!providerAdapter) throw dependencyUnavailable("providerAdapter");
  for (const method of ["chatWithTools", "autoFallback"]) {
    if (typeof providerAdapter[method] !== "function") throw dependencyUnavailable("providerAdapter." + method);
  }
  const toolRunner = deps.toolRunner;
  if (!toolRunner || typeof toolRunner.runTool !== "function") throw dependencyUnavailable("toolRunner.runTool");
  return { agentRuntime, usage, fallback, toolLoop, capability, providerAdapter, toolRunner };
}

// ---------------------------------------------------------------------------
// projectAgentMode.ts:27-78 结果投影
// ---------------------------------------------------------------------------
/** projectAgentMode.ts:27-37 */
function mediaArtifacts(value) {
  if (!value || typeof value !== "object") return [];
  const record = value;
  return ["images", "videos", "audios"].flatMap((key) => Array.isArray(record[key]) ? record[key].flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const media = item;
    const id = String(media.nodeId || media.id || "").trim();
    if (!id) return [];
    return [{ id, nodeId: id, kind: key === "images" ? "image" : key === "videos" ? "video" : "audio", name: String(media.name || "") }];
  }) : []);
}

/** projectAgentMode.ts:39-45 */
function fileArtifact(value) {
  if (!value || typeof value !== "object") return [];
  const result = value;
  const nodeId = String(result.nodeId || "").trim();
  if (!nodeId || result.deliverable === false) return [];
  return [{ id: nodeId, nodeId, kind: "file", name: String(result.name || "") }];
}

/** projectAgentMode.ts:47-78 */
function compactObservation(value) {
  if (typeof value === "string") return value.slice(0, 8000);
  if (!value || typeof value !== "object") return value;
  const record = value;
  const compact = { ...record };
  for (const key of ["data", "value", "buffer", "base64", "bytes"]) delete compact[key];
  if (typeof compact.url === "string") compact.url = compact.url.slice(0, 2000);
  if (Array.isArray(record.entries)) {
    compact.entries = record.entries.slice(0, 300).map((item) => item && typeof item === "object"
      ? { name: String(item.name || "").slice(0, 260), type: String(item.type || "") }
      : item);
    if (record.entries.length > 300) compact.entriesTruncated = record.entries.length - 300;
  }
  for (const key of ["images", "videos", "audios"]) {
    if (!Array.isArray(record[key])) continue;
    compact[key] = record[key].slice(0, 32).map((item) => {
      if (!item || typeof item !== "object") return item;
      const media = item;
      return {
        ...(media.nodeId ? { nodeId: media.nodeId } : {}),
        ...(media.id ? { id: media.id } : {}),
        ...(media.name ? { name: media.name } : {}),
        ...(media.url ? { url: String(media.url).slice(0, 2000) } : {}),
        ...(media.path ? { path: media.path } : {}),
        ...(media.mime ? { mime: media.mime } : {}),
      };
    });
  }
  if (typeof compact.text === "string") compact.text = compact.text.slice(0, 8000);
  if (typeof compact.content === "string") compact.content = compact.content.slice(0, 8000);
  return compact;
}

/** projectAgentMode.ts:80-94 */
function parseCompletionReview(content) {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return { complete: false, reason: "验收模型没有返回可解析的结构化结论", missingActions: ["重新核对任务目标与工具结果"] };
  try {
    const value = JSON.parse(content.slice(start, end + 1));
    return {
      complete: value.complete === true,
      reason: String(value.reason || (value.complete === true ? "目标与实际结果一致" : "任务尚未完整覆盖")).slice(0, 1000),
      missingActions: Array.isArray(value.missingActions) ? value.missingActions.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 20) : [],
    };
  } catch {
    return { complete: false, reason: "验收模型返回的 JSON 无效", missingActions: ["重新核对任务目标与工具结果"] };
  }
}

// ---------------------------------------------------------------------------
// projectAgentMode.ts:96-307 runProjectAgentMode
// ---------------------------------------------------------------------------
async function runProjectAgentMode(project, actor, instruction, history = [], preferences = {}, session = {}) {
  const core = resolveCoreDependencies();
  const clock = typeof deps.clock === "function" ? deps.clock : () => Date.now();

  // projectAgentMode.ts:110-117
  const envelope = core.agentRuntime.normalizeEnvelope({
    schema: "dx-agent-request/v1", requestId: session.requestId, goal: instruction,
    source: { type: "project", entryPoint: "project-assistant" },
    session: { sessionId: session.threadId, threadId: session.threadId },
    scope: { projectId: project.id }, profileId: "project-assistant", interactionPolicy: "confirm-risky",
    modelPreference: { providerId: preferences.providerId, model: preferences.llmModel },
    deliveryTarget: { type: "desktop", targetId: "files" },
  }, actor);
  // projectAgentMode.ts:118-121
  const runtime = core.agentRuntime.prepare(envelope, actor, { runId: session.runId, taskId: session.taskId });
  const prepared = runtime.prepared;
  core.agentRuntime.create(runtime);
  core.agentRuntime.start(runtime.runId);
  // projectAgentMode.ts:122
  // toolRunner 的真实实现是异步的（agent-builtin-tools.cjs:456 async runTool），
  // 不 await 会把 Promise 当 observation 回填（模型只看到 "{}"）；对同步桩 await 无副作用。
  const initialRootListing = compactObservation(await core.toolRunner.runTool("fs_list", { rootNodeId: project.root_node_id, userId: actor.id }, {}));

  // projectAgentMode.ts:123-136
  const invokeModel = async (messages, prompt, tools) => {
    const routes = core.providerAdapter.autoFallback() ? (prepared.route.modelRoutes || []) : [prepared.route.model];
    return core.fallback.runWithAgentModelFallback({
      routes,
      invoke: async (route) => {
        const usage = core.usage.beginAgentUsage({ runId: runtime.runId, kind: "model", providerId: route.providerId, model: route.model });
        try {
          const response = await core.providerAdapter.chatWithTools({
            provider: route.provider || null,
            providerId: route.providerId,
            model: route.model,
            messages,
            system: prompt,
            tools,
            params: {},
            timeoutMs: 300000,
            signal: runtime.signal,
          });
          if (response && response.ok === false) {
            const err = new Error("Agent 模型调用失败：" + String(response.error || "MODEL_CALL_FAILED"));
            err.code = response.error || "MODEL_CALL_FAILED";
            throw err;
          }
          core.usage.finishAgentUsage(usage.id, { status: "completed", usage: response && response.usage, latencyMs: response && response.latencyMs });
          return response || {};
        } catch (error) {
          core.usage.finishAgentUsage(usage.id, {
            status: (error && error.name) === "AbortError" ? "cancelled" : "failed",
            latencyMs: clock() - usage.startedAt,
            error,
          });
          throw error;
        }
      },
    });
  };

  // projectAgentMode.ts:137-158
  const state = session.checkpoint ? core.toolLoop.restore(session.checkpoint.state) : core.toolLoop.create({
    runId: runtime.runId,
    messages: [
      ...history.filter((item) => item.role === "user" || item.role === "assistant").slice(-20).map((item) => ({ role: item.role, content: item.content })),
      { role: "user", content: instruction },
    ],
    system: [
      "你是 DX OS 项目「" + project.name + "」的统一 Agent，当前项目文件夹是唯一文件作用域。",
      "普通问题直接回答；需要读取、写入、生成、编辑或调用外部服务时，先调用 capability_discover，再使用系统披露的能力完成任务。",
      "项目文件读取能力是 APP 的最小入口：用户提到“这个文件夹”“文件”“图片”“视频”或未给出完整路径时，先用 fs_list 查看当前目录并取得准确相对路径，不要要求用户重复上传项目里已有的媒体。",
      "当前项目根目录初始清单（可信只读上下文）：" + JSON.stringify(initialRootListing),
      "处理已有媒体时，把项目相对路径直接传给发现到的媒体能力；识别图片使用 media.image.inspect，修改图片使用 media.image.edit，生成新图使用 media.image.generate。具体工具与模型由 Capability Router 披露和选择。",
      "你自行判断任务类型、执行顺序和是否需要多步操作，不依赖“助理模式”或“思考模式”的旧分流规则。",
      "只依据工具 observation 声明实际结果；工具失败时分析错误并在仍有安全路径时调整参数继续。不要读取或修改 .ccs-ai 系统元数据目录。",
      "批量任务必须逐项覆盖目录清单中的目标。准备结束时系统会用原始要求、文件清单、工具成功/失败记录和产物做独立验收；少做、漏做或失败均会退回本 Run 继续补齐。",
      ...(Array.isArray(prepared.systemPromptAdditions) ? prepared.systemPromptAdditions : []),
    ].join("\n"),
    tools: prepared.route.tools,
    surface: "项目文件夹 Agent",
    bootstrapIntents: ["file.read"],
    // task-34 F03：DX 0.6.1 maxSteps=null（无硬步数上限）；调用方仍可显式传上限做安全阀。
    maxSteps: session.maxSteps === undefined ? null : session.maxSteps,
  });

  // task-34 F03：30 分钟执行窗口。到期 checkpoint + 等待用户“继续任务”，续跑时传同一 checkpoint。
  const windowStartedAt = clock();
  const windowMs = session.windowMs === undefined ? PROJECT_AGENT_WINDOW_MS : Math.max(0, Number(session.windowMs) || 0);
  let windowConsumed = session.continueAfterWindow === true;
  let latestCheckpoint = session.checkpoint || null;

  // projectAgentMode.ts:159-163
  let observations = session.checkpoint ? session.checkpoint.observations : undefined;
  let filesChanged = !!(session.checkpoint && session.checkpoint.filesChanged);
  let toolCalls = (session.checkpoint && session.checkpoint.toolCalls) || 0;
  let reviewAttempts = (session.checkpoint && session.checkpoint.reviewAttempts) || 0;
  let lastReviewSignature = "";
  const ledger = (session.checkpoint && session.checkpoint.ledger) || [{ toolName: "fs_list", args: {}, status: "completed", result: initialRootListing, artifacts: [] }];

  // projectAgentMode.ts:164
  const checkActive = () => { if (session.isActive && !session.isActive()) throw new AgentTaskInterrupted(); };
  // projectAgentMode.ts:165-171
  const checkpoint = () => {
    const snapshot = core.toolLoop.snapshot(runtime.runId);
    if (snapshot) {
      latestCheckpoint = { state: snapshot, observations: observations || [], ledger, toolCalls, reviewAttempts, filesChanged };
      if (session.saveCheckpoint) session.saveCheckpoint(latestCheckpoint);
      else core.agentRuntime.append(runtime.runId, "loop.checkpoint", snapshot);
    }
    return latestCheckpoint;
  };

  const windowPause = () => {
    if (windowConsumed) return null;
    if (clock() - windowStartedAt < windowMs) return null;
    const saved = checkpoint();
    return {
      text: PROJECT_AGENT_CONTINUE_QUESTION,
      waitingForUser: true,
      question: PROJECT_AGENT_CONTINUE_QUESTION,
      checkpoint: saved && saved.state ? saved : latestCheckpoint,
      filesChanged,
      agentTrace: prepared.trace,
      complete: false,
    };
  };

  // projectAgentMode.ts:172-298
  try {
    for (;;) {
      checkActive();
      // task-34 F03：30 分钟窗口到期 → 先持久化 checkpoint，再等待用户答复续跑。
      const paused = windowPause();
      if (paused) return paused;
      // projectAgentMode.ts:175-183：Worker 中断期间未回填的待执行调用按"结果未知"记账，不自动重试副作用。
      if (session.checkpoint && state.pending.length) {
        const completed = new Set((observations || []).map((item) => item.invocationId));
        observations = [...(observations || []), ...state.pending.filter((call) => !completed.has(call.id)).map((call) => ({
          invocationId: call.id, toolName: call.name, status: "failed",
          error: "Worker 中断期间工具结果未知；为避免重复副作用，本次不自动重试该调用。",
        }))];
        checkpoint();
        session.checkpoint = undefined;
      }
      // projectAgentMode.ts:184-202
      const result = await core.toolLoop.advance(state, {
        observations,
        model: async (messages, prompt, tools) => {
          const response = await invokeModel(messages, prompt, tools);
          return { content: (response && (response.content || response.text)) || "", toolCalls: (response && response.toolCalls) || [] };
        },
        discover: async (args, local) => {
          const usage = core.usage.beginAgentUsage({ runId: runtime.runId, kind: "tool", toolName: "capability_discover" });
          try {
            const targets = await core.capability.discoverCapabilityTargetsForUser(
              actor.id,
              Array.isArray(args.intents) ? args.intents.map(String) : [],
              core.capability.normalizeCapabilityReferences(args.references),
              core.capability.normalizeCapabilityRequirements(args.requirements),
            );
            core.usage.finishAgentUsage(usage.id, { status: "completed", latencyMs: clock() - usage.startedAt });
            core.agentRuntime.append(runtime.runId, "capability.completed", { toolName: "capability_discover", activated: local.activated.map((item) => item.id), targets: core.capability.selectedCapabilityTargets(targets) });
            return { ...local, targets };
          } catch (error) {
            core.usage.finishAgentUsage(usage.id, { status: "failed", latencyMs: clock() - usage.startedAt, error });
            throw error;
          }
        },
      });
      checkpoint();
      checkActive();

      // projectAgentMode.ts:205-235 独立完成验收
      if (result.terminal) {
        const reviewResponse = await invokeModel([{ role: "user", content: [
          "原始任务：" + instruction,
          "候选完成回复：" + (result.content || "(空)"),
          "执行账本：" + JSON.stringify(ledger).slice(0, 48000),
        ].join("\n\n") }], [
          "你是 DX OS 项目 Agent 的独立完成验收器，只检查是否真的完成，不执行任务。",
          "必须把原始任务与执行账本逐项对照。批量任务要核对目录清单中的目标数量、每个目标的成功工具调用，以及对应产物；失败调用、口头承诺和缺少产物都不算完成。",
          "纯问答可以在候选回复确实回答问题时通过。需要修改、生成或写文件但账本没有成功工具结果时必须拒绝。",
          "只返回 JSON：{\"complete\":boolean,\"reason\":\"简洁依据\",\"missingActions\":[\"还需要做的具体动作\"]}",
        ].join("\n"), []);
        const review = parseCompletionReview((reviewResponse && (reviewResponse.content || reviewResponse.text)) || "");
        reviewAttempts += 1;
        checkActive();
        core.agentRuntime.append(runtime.runId, "planned", { phase: "completion-review", attempt: reviewAttempts, ...review });
        if (review.complete) {
          if (!session.taskId) core.agentRuntime.complete(runtime.runId, { content: result.content, reason: review.reason, filesChanged, completionReview: review });
          return { text: result.content || "已完成。", filesChanged, agentTrace: prepared.trace, complete: true };
        }
        // 0.6.1 不再有 2 次验收硬上限；但完全重复的拒绝说明模型没有产生新证据，
        // 继续循环只会烧预算，因此按"无进展"提前收口。
        const reviewSignature = JSON.stringify({ reason: review.reason, missingActions: review.missingActions });
        if (reviewSignature === lastReviewSignature && reviewAttempts > 1) {
          const text = "任务尚未通过完成验收：" + review.reason + "（连续两次相同拒绝，已停止重试）";
          if (!session.taskId) core.agentRuntime.fail(runtime.runId, text);
          return { text, filesChanged, agentTrace: prepared.trace, complete: false };
        }
        lastReviewSignature = reviewSignature;
        if (state.step < state.maxSteps) {
          state.terminal = false;
          state.content = "";
          state.messages.push({ role: "user", content: "系统完成验收未通过：" + review.reason + "\n仍需完成：" + (review.missingActions.join("；") || "重新核对原始目标并补齐缺失结果") + "。请继续调用已声明能力实际补齐，不要重复已成功的项目。" });
          observations = undefined;
          checkpoint();
          continue;
        }
        const text = "任务尚未通过完成验收：" + review.reason + (review.missingActions.length ? "\n仍需完成：" + review.missingActions.join("；") : "");
        if (!session.taskId) core.agentRuntime.fail(runtime.runId, text);
        return { text, filesChanged, agentTrace: prepared.trace, complete: false };
      }

      // projectAgentMode.ts:236-297 执行本轮工具调用并回填 observation
      observations = [];
      for (const call of result.toolCalls) {
        checkActive();
        toolCalls += 1;
        const startedAt = clock();
        const usage = core.usage.beginAgentUsage({ runId: runtime.runId, kind: "tool", toolName: call.name });
        core.agentRuntime.append(runtime.runId, "capability.started", { toolName: call.name });
        let callArgs = {};
        try {
          const args = JSON.parse(call.arguments || "{}");
          callArgs = args;
          const descriptor = prepared.route.toolDescriptors.find((item) => item.name === call.name);
          if (!descriptor) throw new Error("本轮没有激活工具：" + call.name);
          let value;
          if (descriptor.source === "file") {
            value = await core.toolRunner.runTool(call.name, { rootNodeId: project.root_node_id, userId: actor.id }, args);
            if (descriptor.risk !== "read") filesChanged = true;
          } else if (descriptor.source === "skill") {
            const runSkill = methodOf("skillRunner", "runSkill");
            value = await runSkill(descriptor.sourceId, args, {
              rootId: project.root_node_id, userId: actor.id,
              providerId: preferences.providerId, model: preferences.llmModel,
              imageProviderId: preferences.imageProviderId, imageModel: preferences.imageModel,
            });
            if (mediaArtifacts(value).length) filesChanged = true;
          } else if (descriptor.source === "mcp") {
            const callByName = methodOf("mcpAdapter", "callByName");
            // D5-04：把本 Run 的任务上下文交给 MCP 适配器（审批链要求真实 Task）。缺 taskId 时由审批端口
            // 结构化 fail closed（0 传输），绝不伪造任务身份。
            value = await callByName(call.name, args, { taskId: session.taskId || null, stepId: session.stepId || null, runId: session.runId || null });
          } else {
            const runCatalogTool = methodOf("toolCatalog", "runCatalogTool");
            value = await runCatalogTool(call.name, {
              ...args, __rootId: project.root_node_id,
              ...(preferences.providerId ? { __providerId: preferences.providerId } : {}),
              ...(preferences.llmModel ? { __model: preferences.llmModel } : {}),
              ...(preferences.imageProviderId ? { __imageProviderId: preferences.imageProviderId } : {}),
              ...(preferences.imageModel ? { __imageModel: preferences.imageModel } : {}),
            }, actor, descriptor.source === "app" ? { sourceId: descriptor.sourceId } : {});
            if (mediaArtifacts(value).length) filesChanged = true;
          }
          const artifacts = [...fileArtifact(value), ...mediaArtifacts(value)];
          for (const artifact of artifacts) core.agentRuntime.append(runtime.runId, "artifact.created", {
            surfaceArtifact: true, artifactId: artifact.id, nodeId: artifact.nodeId,
            kind: artifact.kind, name: artifact.name, bytes: null, toolName: call.name,
          });
          core.usage.finishAgentUsage(usage.id, { status: "completed", latencyMs: clock() - startedAt });
          core.agentRuntime.append(runtime.runId, "capability.completed", { toolName: call.name });
          const compact = compactObservation(value);
          ledger.push({ toolName: call.name, args: callArgs, status: "completed", result: compact, artifacts });
          observations.push({ invocationId: call.id, toolName: call.name, status: "completed", result: compact, latencyMs: clock() - startedAt, artifacts });
          checkpoint();
        } catch (error) {
          const message = String((error && error.message) || error);
          core.usage.finishAgentUsage(usage.id, { status: runtime.signal.aborted ? "cancelled" : "failed", latencyMs: clock() - startedAt, error });
          core.agentRuntime.append(runtime.runId, "capability.failed", { toolName: call.name, message });
          ledger.push({ toolName: call.name, args: callArgs, status: runtime.signal.aborted ? "cancelled" : "failed", error: message, artifacts: [] });
          observations.push({ invocationId: call.id, toolName: call.name, status: runtime.signal.aborted ? "cancelled" : "failed", error: message, latencyMs: clock() - startedAt });
          checkpoint();
        }
      }
    }
  } catch (error) {
    // projectAgentMode.ts:299-303
    if (error instanceof AgentTaskInterrupted) throw error;
    if (runtime.signal.aborted || (error && error.name === "AbortError")) core.agentRuntime.cancel(runtime.runId);
    else if (!session.taskId) core.agentRuntime.fail(runtime.runId, error);
    throw error;
  } finally {
    // projectAgentMode.ts:304-306
    core.toolLoop.delete(runtime.runId);
  }
}

module.exports = {
  AGENT_DEPENDENCY_UNAVAILABLE,
  AgentTaskInterrupted,
  dependencyUnavailable,
  configureProjectAgentMode,
  resetProjectAgentModeForTests,
  mediaArtifacts,
  fileArtifact,
  compactObservation,
  parseCompletionReview,
  runProjectAgentMode,
};
