"use strict";
/**
 * B3 · Agent 域装配 + agent:command 分发（唯一执行入口）。
 *
 * 装配真实模块（不 mock、不新增依赖）：
 *   · agent-task-store.cjs          任务域 SQLite 状态机（注入 identity-store 的真实连接）
 *   · agent-kernel.cjs              Agent 内核（prepareAgentTurn / 上下文）
 *   · agent-kernel-store.cjs        Agent Run 持久化   ┐ 两者注入同一 db
 *   · agent-kernel-inspection.cjs   Run 巡检            ┘
 *   · agent-runtime-manager.cjs     运行时依赖中心（configureAgentRuntime）
 *   · agent-react-driver.cjs        React 驱动（configureReactDriver）
 *   · agent-tool-catalog.cjs        工具目录（configureToolCatalog）
 *   · agent-tool-resolver.cjs       工具解析 / 权限判定
 *   · agent-builtin-tools.cjs       runTool（B3d 唯一工具执行器）
 *   · provider-protocol-service.cjs 模型调用出口（modelService.providerProtocol.service.call）
 *
 * 边界：
 *   · 渲染层自报的 userId / role / appId / sessionRef 一律忽略；actor 由 authorization.resolveActor
 *     从可信 sessionRef 推导（同 model-service.cjs:17 / task-service.cjs:128）。
 *   · fsAdapter / workspaceAdapter（B6 虚拟文件树）未落地 → 保持结构化 AGENT_DEPENDENCY_UNAVAILABLE，
 *     绝不伪造成功；workspace 模块本身已注入，但文件写真值通道仍由 fsAdapter 决定。
 *   · 返回值统一过 agent-domain.cjs 的 redactAgentValue —— 不含 api_key / credentialRef / 绝对路径。
 */
const { randomUUID } = require("node:crypto");

const agentDomain = require("./agent-domain.cjs");
const foundationErrors = require("./dxos-foundation-errors.cjs");
const { createEventChannel } = require("./dxos-foundation-events.cjs");

const agentTaskStore = require("./agent-task-store.cjs");
const agentKernel = require("./agent-kernel.cjs");
const agentKernelStore = require("./agent-kernel-store.cjs");
const agentKernelInspection = require("./agent-kernel-inspection.cjs");
const agentRuntimeWorkspace = require("./agent-runtime-workspace.cjs");
const agentRuntimeUsage = require("./agent-runtime-usage.cjs");
const agentRuntimeEnvelope = require("./agent-runtime-envelope.cjs");
const agentRuntime = require("./agent-runtime-manager.cjs");
const agentRuntimeFallback = require("./agent-runtime-fallback.cjs");
const agentRuntimeToolLoop = require("./agent-runtime-tool-loop.cjs");
const capabilityTargetResolver = require("./capability-target-resolver.cjs");
const reactDriver = require("./agent-react-driver.cjs");
const builtinTools = require("./agent-builtin-tools.cjs");
const toolResolver = require("./agent-tool-resolver.cjs");
const capabilityRouter = require("./capability-router.cjs");
const canvasCapabilities = require("./canvas-dxos-capabilities.cjs");
const projectSnapshot = require("./agent-project-snapshot.cjs");
const projectAgentMode = require("./project-agent-mode.cjs");
const authDomain = require("./authorization-domain.cjs");

const { createAgentError, normalizeAgentError, redactAgentValue, isAgentCommand, agentCommandNotAllowed, AGENT_ERR_COMMAND_NOT_ALLOWED, AGENT_ERR_INVALID_INPUT, AGENT_ERR_UNAUTHENTICATED, AGENT_ERR_FORBIDDEN, AGENT_ERR_NOT_FOUND, AGENT_ERR_DEPENDENCY_UNAVAILABLE, AGENT_ERR_INTERNAL, AGENT_EVENT_CHANNEL } = agentDomain;

/** Agent 能力承载的 App Principal。任务域 / 模型域的既有约定同为 "ai"（task-bootstrap.cjs:108）。 */
const HOST_APP_ID = "ai";

const asStr = (value, max = 512) => (typeof value === "string" ? value.slice(0, max) : value == null ? undefined : String(value).slice(0, max));
const requireStr = (value, max = 512) => { const text = asStr(value, max); return text && text.length ? text : null; };

/** 惰性加载真实工具目录；接口未就绪（并行波次写入中）返回 null，命令侧结构化报缺。 */
function loadToolCatalogModule() {
  try {
    const mod = require("./agent-tool-catalog.cjs");
    return mod && typeof mod.toolCatalogSnapshot === "function" ? mod : null;
  } catch {
    return null;
  }
}

/** resolver 失败对象的可透传字段（toolName / permission）— 只取显式白名单，避免把整个错误对象带过桥。 */
function resolverErrorDetail(error, code) {
  const detail = { causeCode: code };
  if (error && typeof error === "object") {
    if (typeof error.toolName === "string") detail.tool = error.toolName;
    if (typeof error.permission === "string") detail.permission = error.permission;
    if (Array.isArray(error.permissions)) detail.permissions = error.permissions.slice(0, 16);
  }
  return detail;
}

/** 解析失败映射：resolver 的 code → Agent 域错误码（不吞原始 message）。 */
function mapResolverError(error) {
  const code = error && error.code ? String(error.code) : "internal";
  const message = (error && error.message) || "工具解析失败";
  const detail = resolverErrorDetail(error, code);
  if (code === "catalog_unavailable") return createAgentError(AGENT_ERR_DEPENDENCY_UNAVAILABLE, message, { ...detail, dependency: "toolCatalog" });
  if (code === "auth_unavailable") return createAgentError(AGENT_ERR_DEPENDENCY_UNAVAILABLE, message, { ...detail, dependency: "toolAuth" });
  if (code === "permission_denied") return createAgentError(AGENT_ERR_FORBIDDEN, message, detail);
  if (code === "not_found") return createAgentError(AGENT_ERR_NOT_FOUND, message, detail);
  if (code === "invalid_request") return createAgentError(AGENT_ERR_INVALID_INPUT, message, detail);
  return createAgentError(AGENT_ERR_INTERNAL, message, detail);
}

/** 工具执行失败映射：ToolError.code → Agent 域码；缺 fsAdapter 归 AGENT_DEPENDENCY_UNAVAILABLE。 */
function mapToolError(error, toolName) {
  const code = error && error.code ? String(error.code) : "internal";
  const message = (error && error.message) || "工具执行失败";
  if (code === "dependency_unavailable") return createAgentError(AGENT_ERR_DEPENDENCY_UNAVAILABLE, message, { dependency: "fsAdapter", tool: toolName, causeCode: code });
  if (code === "permission_denied") return createAgentError(AGENT_ERR_FORBIDDEN, message, { tool: toolName, causeCode: code });
  if (code === "not_found") return createAgentError(AGENT_ERR_NOT_FOUND, message, { tool: toolName, causeCode: code });
  if (code === "invalid_input") return createAgentError(AGENT_ERR_INVALID_INPUT, message, { tool: toolName, causeCode: code });
  if (code === "conflict") return createAgentError("AGENT_CONFLICT", message, { tool: toolName, causeCode: code });
  return createAgentError(AGENT_ERR_INTERNAL, message, { tool: toolName, causeCode: code });
}

/**
 * 模型调用适配器：形状 = agent-runtime-deps.cjs:24（provider-protocol-service.cjs:151）。
 * 出口不存在时返回 { ok:false, error:'MODEL_SERVICE_UNAVAILABLE' }，由工具循环/驱动判失败。
 */
function createModelAdapter({ modelService }) {
  function protocolService() {
    const protocol = modelService && modelService.providerProtocol ? modelService.providerProtocol : null;
    return protocol && protocol.service && typeof protocol.service.call === "function" ? protocol.service : null;
  }
  return {
    async call(input = {}) {
      const service = protocolService();
      if (!service) return { ok: false, error: "MODEL_SERVICE_UNAVAILABLE" };
      return service.call({
        providerId: input.providerId,
        model: input.model,
        messages: Array.isArray(input.messages) ? input.messages : [],
        tools: input.tools == null ? null : input.tools,
        params: input.params && typeof input.params === "object" ? input.params : {},
        stream: input.stream === true,
        requestId: asStr(input.requestId, 80),
        signal: input.signal || null,
        allowLan: false,
        onEvent: typeof input.onEvent === "function" ? input.onEvent : () => {},
      });
    },
  };
}

/**
 * 工具执行器。两个形状都要满足：
 *   · 服务端工具循环用 run(toolName, args, ctx)（agent-runtime-tool-loop.cjs:430）；
 *   · React 驱动用 runTool(toolName, ctx, args) + ToolError（agent-react-driver.cjs:993）。
 */
function createToolRunner() {
  const run = (toolName, ctx, args) => builtinTools.runTool(String(toolName), ctx && typeof ctx === "object" ? ctx : {}, args && typeof args === "object" ? args : {});
  return {
    run: (toolName, args, ctx) => run(toolName, ctx, args),
    runTool: (toolName, ctx, args) => run(toolName, ctx, args),
    ToolError: builtinTools.ToolError,
  };
}

/**
 * 工具权限适配器：agent-tool-resolver.cjs:128 需要 { canUseAppPermission(actor, permission) }。
 * 复用既有权限真值（不建第二权限系统）：
 *   · 受控 Tool action（authorization-domain.cjs:176）→ AuthorizationService.authorizeTool；
 *   · 其余（如 files.read / files.write）→ App Grant 的 actions 列表（appGrantsForApp）。
 * 适配器未装配时返回 false（保守拒绝），与 resolver 的 auth_unavailable 语义一致。
 */
function createToolAuthAdapter({ authStore, authorization }) {
  return {
    canUseAppPermission(actor, permission) {
      const action = String(permission == null ? "" : permission);
      if (!action) return true;
      if (!actor || actor.id == null) return false;
      const organizationId = actor.organizationId || actor.team_id || null;
      if (authDomain.isToolAction(action)) {
        if (!authorization || typeof authorization.authorizeTool !== "function") return false;
        const decision = authorization.authorizeTool({ context: { userId: actor.id, appId: HOST_APP_ID, source: "agent" }, action, application: { appId: HOST_APP_ID } });
        return !!(decision && decision.decision === authDomain.DECISION.ALLOW);
      }
      if (!authStore || typeof authStore.appGrantsForApp !== "function") return false;
      const grants = authStore.appGrantsForApp(HOST_APP_ID, organizationId) || [];
      for (const grant of grants) {
        let actions = grant && grant.actions;
        if (typeof actions === "string") { try { actions = JSON.parse(actions || "[]"); } catch { actions = []; } }
        if (Array.isArray(actions) && actions.map(String).includes(action)) return true;
      }
      return false;
    },
  };
}

/** 任务安全投影：只暴露渲染层需要的字段（内部列名 → 驼峰）。 */
function taskSummary(task) {
  if (!task) return null;
  return {
    taskId: task.id, projectId: task.project_id, threadId: task.thread_id,
    title: task.title, instruction: task.instruction, status: task.status, mode: task.mode,
    executionProfile: task.execution_profile, createdAt: task.created_at, updatedAt: task.updated_at,
    startedAt: task.started_at || null, completedAt: task.completed_at || null,
    errorCode: task.error_code || null, errorMessage: task.error_message || null,
    agentRunId: task.agent_run_id || null,
  };
}

/**
 * mcp-agent-tools 实例（createMcpAgentTools 产物）→ 工具目录 mcp 来源。
 * agent-tool-catalog.cjs:140-144 callMcp / :333-358 mcpTools 的契约是
 *   { list(): servers[], call(toolName, args, ctx) }，且 sourceList(:62-65) 不 await，
 * 所以 list() 必须同步：只有调用方提供同步目录快照（mcpServersSnapshot）时才注册。
 * 未提供实例或同步目录 → 返回 null，catalog 保持 mcp_registry 的 available:false（不伪造）。
 */
function buildMcpCatalogSource(mcpAgentTools, mcpServersSnapshot) {
  if (!mcpAgentTools || typeof mcpAgentTools.callByName !== "function") return null;
  if (typeof mcpServersSnapshot !== "function") return null;
  return {
    list: () => { const rows = mcpServersSnapshot(); return Array.isArray(rows) ? rows : []; },
    call: (toolName, args, ctx) => mcpAgentTools.callByName(String(toolName), args && typeof args === "object" ? args : {}, { context: ctx && typeof ctx === "object" ? ctx : {} }),
  };
}

/**
 * skill-store + skill-runner → 工具目录 skill 来源。
 * agent-tool-catalog.cjs:134-138 callSkill / :360-387 skillTools 的同类契约。
 * list() 给 listSkills()（目录需要 id/enabled/exposure/v2 才能补 installedSkillStatus:254-260）；
 * agentSkillTools() 的 OpenAI 函数定义无法满足该契约，作为没有 listSkills 时的兜底。
 * 两者缺一 → null，catalog 保持 skill_registry 的 available:false（不伪造）。
 */
function buildSkillCatalogSource(skillStore, skillRunner) {
  if (!skillStore || (typeof skillStore.listSkills !== "function" && typeof skillStore.agentSkillTools !== "function")) return null;
  if (!skillRunner || typeof skillRunner.runSkill !== "function") return null;
  // 目录契约要的是完整技能行；agentSkillTools()（OpenAI 函数定义）只在没有 listSkills 时兜底。
  const list = typeof skillStore.listSkills === "function" ? () => skillStore.listSkills() : () => skillStore.agentSkillTools();
  return {
    list,
    call: (skillId, args, ctx) => skillRunner.runSkill(String(skillId), args && typeof args === "object" ? args : {}, ctx && typeof ctx === "object" ? ctx : {}),
  };
}

/**
 * canvasExtension → 工具目录 canvas 来源（B5d）。
 * 画布内核能力清单是静态投影（canvas-dxos-capabilities.cjs），只依赖"画布扩展是否装配"；
 * 未装配（null）→ 返回 null，不注册来源键，catalog 保持 app_canvas_registry 的 available:false（不伪造）。
 */
function buildCanvasCatalogSource(canvasExtension) {
  if (!canvasExtension) return null;
  return canvasCapabilities.buildCanvasCatalogSource({
    nodeTypes: Array.isArray(canvasExtension.nodeTypes) ? canvasExtension.nodeTypes : [],
  });
}

/**
 * project-agent-mode 的 agentRuntime 适配器。
 * agent-runtime-manager.cjs:277 的 agentRunManager 是单例，prepare/create/start/append/complete/fail/cancel
 * 都读写 this.controllers / this.pipeline（agent-runtime-manager.cjs:104-105、:168-169），
 * 直接以方法引用注入会丢 this —— 必须 bind（project-agent-mode.cjs:20-22 明确要求）。
 * normalizeEnvelope 取 agent-runtime-envelope.cjs:50 的 V1 归一化（无 this 依赖）。
 */
function bindAgentRuntimeManager(manager) {
  if (!manager || typeof manager.prepare !== "function") return null;
  return {
    normalizeEnvelope: agentRuntimeEnvelope.normalizeAgentRequestEnvelopeV1,
    prepare: manager.prepare.bind(manager),
    create: manager.create.bind(manager),
    start: manager.start.bind(manager),
    append: manager.append.bind(manager),
    complete: manager.complete.bind(manager),
    fail: manager.fail.bind(manager),
    cancel: manager.cancel.bind(manager),
  };
}

/**
 * project-agent-mode 要的模型出口是 { chatWithTools, autoFallback }（project-agent-mode.cjs:34-36、:143），
 * 而 provider-adapter-bridge.cjs 只投影 { firstUsable, all, autoFallback, revealProvider, call }（:171）。
 * 这里只做形状投影：chatWithTools → bridge.call —— 模型出口仍只有 provider-protocol-service.call 一条，
 * 不新建第二套调用，也不把 api_key / credentialRef 带出桥。
 */
function createProjectProviderAdapter(providerAdapter) {
  if (!providerAdapter || typeof providerAdapter.call !== "function") return null;
  return {
    autoFallback: () => (typeof providerAdapter.autoFallback === "function" ? providerAdapter.autoFallback() !== false : true),
    chatWithTools: (input) => providerAdapter.call(input && typeof input === "object" ? input : {}),
  };
}

/**
 * project-agent-mode 的依赖缺失（project-agent-mode.cjs:45 / :47-54）→ Agent 域结构化依赖错误，保留 dependency。
 * 也覆盖真实文件工具的 dependency_unavailable（agent-builtin-tools.cjs:99 的 fsAdapter 缺失）——
 * 与 mapToolError 同口径，不折成 DXOS_ERR_INTERNAL 那种"看不出缺什么"的失败。
 */
function mapProjectModeError(error) {
  const code = error && error.code ? String(error.code) : "";
  if (code === AGENT_ERR_DEPENDENCY_UNAVAILABLE || code === "dependency_unavailable") {
    return createAgentError(AGENT_ERR_DEPENDENCY_UNAVAILABLE, (error && error.message) || "项目 Agent 模式依赖不可用", {
      dependency: error.dependency ? String(error.dependency) : null,
      causeCode: code,
    });
  }
  return error;
}

/**
 * 装配 Agent 域 bundle。dbPath / userDataDir 只为运行时工作区与日志定位，不作为返回值。
 * 额外可选键 toolCatalog 是测试/未来批次注入目录的 seam（production 省略即惰性 require 真实模块）。
 * B4 接线：skillStore/skillRunner（或预构造 skillSource）与 mcpAgentTools/mcpServersSnapshot
 * （或预构造 mcpSource）把 catalog 的 mcp/skill 空来源接上真实实现；未给即保持 available:false。
 * B5d 接线：canvasExtension（画布域扩展实例）把 canvas 来源接上画布内核能力投影；未给即 available:false。
 * providerAdapter 由宿主注入 provider-adapter-bridge.cjs 的只读桥（未注入即保持结构化依赖缺失，不伪造）。
 */
function createAgentBundle({ identityStore, authorization, authStore, modelService, providerAdapter = null, userDataDir, logger = null, clock = null, dbPath = null, toolCatalog = null, mcpAgentTools = null, mcpServersSnapshot = null, skillStore = null, skillRunner = null, mcpSource = null, skillSource = null, canvasExtension = null, canvasSource = null, projectAgent = null } = {}) {
  const now = typeof clock === "function" ? clock : () => Date.now();
  const idFactory = () => randomUUID();
  const db = (identityStore && (identityStore.connection || identityStore.db)) || null;
  const catalog = toolCatalog || loadToolCatalogModule();

  // ---- 1) 任务域：唯一 SQLite 连接（identity-store 的连接，agent_* 表由 v23 迁移建立） ----
  if (db) agentTaskStore.configureAgentTaskStore({ db, clock: now, idFactory });

  // ---- 2) 工具执行器与模型出口（tool loop / react driver / kernel 共用同一实例） ----
  const modelAdapter = createModelAdapter({ modelService });
  const toolRunner = createToolRunner();
  const toolAuth = createToolAuthAdapter({ authStore, authorization });
  // B6 未落地：fsAdapter / workspaceAdapter 不注入（workspace 模块本身可用，但文件真值通道为空）。
  const fsAdapter = null;

  // ---- 3) 内核依赖：Run 持久化 / 巡检 / 工具解析 / 用量 / 工作区 ----
  agentKernel.configureAgentKernel({
    db, clock: now, logger, taskStore: agentTaskStore, workspaceStore: agentRuntimeWorkspace,
    usageStore: agentRuntimeUsage, schemaValidator: agentRuntimeEnvelope, toolResolver,
    modelAdapter, toolRunner, fsAdapter,
  });

  // ---- 4) 运行时依赖中心（tool loop）与 React 驱动 ----
  agentRuntime.configureAgentRuntime({
    db, kernel: agentKernel, taskStore: agentTaskStore, runStore: agentKernelStore,
    modelAdapter, toolRunner, fsAdapter, workspaceAdapter: agentRuntimeWorkspace,
    clock: now, logger, idFactory,
  });
  reactDriver.configureReactDriver({
    kernel: agentKernel, kernelStore: agentKernelStore, supervisor: require("./agent-kernel-supervisor.cjs"),
    taskStore: agentTaskStore, toolRunner, workspaceAdapter: agentRuntimeWorkspace,
    usageAdapter: agentRuntimeUsage, fsAdapter, clock: now, logger,
    // B4 接线：provider-adapter-bridge 组装的只读 providerAdapter（agent-react-driver.cjs:33 契约）。
    providerAdapter: providerAdapter,
  });

  // ---- 5) 工具目录 + 解析器（同一份 auth / catalog 注入，避免两套权限判定） ----
  // B4：把 B3 留空的 mcp/skill 来源接上真实实现。两者都用同步 list()（catalog 的
  // sourceList 不 await），所以只接受已构造好的同步来源或"实例 + 同步目录快照"。
  // 未落地/未配置的来源不注册键，catalog 继续给出 available:false 的 fallback descriptor。
  const catalogSources = {};
  const resolvedMcpSource = mcpSource || buildMcpCatalogSource(mcpAgentTools, mcpServersSnapshot);
  if (resolvedMcpSource) catalogSources.mcp = resolvedMcpSource;
  const resolvedSkillSource = skillSource || buildSkillCatalogSource(skillStore, skillRunner);
  if (resolvedSkillSource) catalogSources.skill = resolvedSkillSource;
  const resolvedCanvasSource = canvasSource || buildCanvasCatalogSource(canvasExtension);
  if (resolvedCanvasSource) catalogSources.canvas = resolvedCanvasSource;
  if (catalog && typeof catalog.configureToolCatalog === "function") catalog.configureToolCatalog({ sources: catalogSources, auth: toolAuth, weather: null, clock: now });
  toolResolver.configureToolResolver({ catalog, auth: toolAuth });

  // ---- 5b) 项目级 Agent 模式（B4c）的注入点位 ----
  // project-agent-mode.cjs:77 configureProjectAgentMode 是模块级注入点；这里先把本 bundle 的
  // 真实适配器固定到闭包（skillRunner / mcpAdapter / providerAdapter 都来自本 bundle），
  // 在 agent/project/run 分发时再注入 —— 避免同进程里后建的 bundle（或测试夹具）把适配器串味。
  // projectAgent 只作为测试/装配 seam 覆盖个别适配器；未覆盖的键仍用真实模块（不 mock）。
  const skillRunnerAdapter = skillRunner && typeof skillRunner.runSkill === "function"
    ? { runSkill: (skillId, args, ctx) => skillRunner.runSkill(String(skillId), args, ctx) }
    : resolvedSkillSource
      ? { runSkill: (skillId, args, ctx) => resolvedSkillSource.call(String(skillId), args, ctx) }
      : null;
  const mcpAdapter = mcpAgentTools && typeof mcpAgentTools.callByName === "function"
    ? { callByName: (name, args) => mcpAgentTools.callByName(String(name), args && typeof args === "object" ? args : {}, {}) }
    : null;
  const projectAdapters = {
    agentRuntime: bindAgentRuntimeManager(agentRuntime.agentRunManager),
    usage: agentRuntimeUsage,
    fallback: agentRuntimeFallback,
    toolLoop: agentRuntimeToolLoop.serverAgentToolLoops,
    capability: capabilityTargetResolver,
    toolRunner: { runTool: (name, ctx, args) => builtinTools.runTool(String(name), ctx && typeof ctx === "object" ? ctx : {}, args && typeof args === "object" ? args : {}) },
    skillRunner: skillRunnerAdapter,
    mcpAdapter,
    toolCatalog: catalog,
    providerAdapter: createProjectProviderAdapter(providerAdapter),
  };
  if (projectAgent && typeof projectAgent === "object" && !Array.isArray(projectAgent)) {
    for (const key of Object.keys(projectAdapters)) {
      if (Object.prototype.hasOwnProperty.call(projectAgent, key)) projectAdapters[key] = projectAgent[key];
    }
  }

  // ---- 6) 下行事件（P1 信封；bootstrap 的 send 经 setEventSink 注入） ----
  const channel = createEventChannel({ domain: agentDomain.AGENT_EVENT_DOMAIN, clock: now });
  let eventSink = null;
  function setEventSink(fn) { eventSink = typeof fn === "function" ? fn : null; return true; }
  function emit(kind, payload) {
    const event = channel.emit(kind, payload);
    if (eventSink) { try { eventSink(event); } catch { /* 事件推送失败不改变业务结果 */ } }
    return event;
  }

  const dependencies = Object.freeze({
    db: !!db,
    // 键名不用 authorization：foundation 的 isSecretKey 会把它当凭据字段掩码，布尔值会丢失类型。
    actorResolution: !!(authorization && typeof authorization.resolveActor === "function"),
    modelAdapter: !!(modelService && modelService.providerProtocol && modelService.providerProtocol.service),
    // B4 接线：providerAdapter 只读桥是否装配（不含任何密钥值）。
    providerAdapter: !!providerAdapter,
    toolRunner: true,
    toolCatalog: !!catalog,
    toolAuth: true,
    // B4：catalog 里 mcp/skill 来源是否已接真实实现（false = catalog 保持 available:false）。
    mcpSource: !!resolvedMcpSource,
    skillSource: !!resolvedSkillSource,
    canvasSource: !!resolvedCanvasSource,
    // B6 未落地：显式 false，不假装可用（agent-project-snapshot 会据此抛结构化依赖错误）。
    fsAdapter: false,
    workspaceAdapter: !!agentRuntimeWorkspace,
    userDataDir: !!userDataDir,
    dbPath: !!dbPath,
  });

  /** sessionRef → actor；不可解析时返回 { ok:false }，绝不伪造身份。 */
  function resolveActor(context) {
    if (!authorization || typeof authorization.resolveActor !== "function") return { ok: false, message: "授权服务未装配" };
    try {
      const result = authorization.resolveActor({ context });
      if (!result || result.ok !== true || !result.user || result.user.id == null) return { ok: false, message: (result && (result.error || result.reason)) || "会话无效" };
      return result;
    } catch (error) {
      return { ok: false, message: String((error && error.message) || error) };
    }
  }

  function accessOrForbidden(projectId, userId, createTask) {
    try { agentTaskStore.requireProjectAccess(projectId, userId, createTask); }
    catch (error) { throw createAgentError(AGENT_ERR_FORBIDDEN, (error && error.message) || "没有该项目的访问权限", { projectId }); }
  }

  /** 命令分发。失败一律 throw（由 execute 统一规约），成功返回原始值（由 execute 统一脱敏）。 */
  async function dispatch(command, payload, context) {
    const userId = context.userId;
    const actor = { ...context.actor, id: userId, organizationId: context.actor && (context.actor.organizationId || context.actor.team_id) };
    switch (command) {
      // ---------------- task ----------------
      case "agent/task/create": {
        const projectId = requireStr(payload.projectId, 160);
        const instruction = requireStr(payload.instruction, 8000);
        if (!projectId || !instruction) throw createAgentError(AGENT_ERR_INVALID_INPUT, "projectId 与 instruction 必填");
        accessOrForbidden(projectId, userId, true);
        const task = agentTaskStore.createTask({
          projectId, instruction, createdBy: userId,
          title: asStr(payload.title, 120), threadId: requireStr(payload.threadId, 120),
          executionProfile: requireStr(payload.executionProfile, 20),
          agentProfileId: requireStr(payload.agentProfileId, 80),
          parentTaskId: requireStr(payload.parentTaskId, 120),
          preferences: payload.preferences && typeof payload.preferences === "object" ? payload.preferences : undefined,
          actions: Array.isArray(payload.actions) ? payload.actions : undefined,
        });
        return { task: taskSummary(task) };
      }
      case "agent/task/list": {
        const projectId = requireStr(payload.projectId, 160) || undefined;
        return { items: agentTaskStore.listTasks(userId, projectId).map(taskSummary) };
      }
      case "agent/task/get": {
        const taskId = requireStr(payload.taskId, 160);
        if (!taskId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "taskId 必填");
        const task = agentTaskStore.getTask(taskId);
        if (!task) throw createAgentError(AGENT_ERR_NOT_FOUND, "任务不存在：" + taskId);
        accessOrForbidden(task.project_id, userId);
        return {
          task: taskSummary(task),
          steps: Array.isArray(task.steps) ? task.steps.map((step) => ({ id: step.id, ordinal: step.ordinal, title: step.title, tool: step.tool_name, status: step.status, startedAt: step.started_at, completedAt: step.completed_at })) : [],
          deliverables: Array.isArray(task.deliverables) ? task.deliverables.map((item) => ({ id: item.id, name: item.name, type: item.type, createdAt: item.created_at })) : [],
          checkpoints: Array.isArray(task.checkpoints) ? task.checkpoints.length : 0,
        };
      }
      case "agent/task/events": {
        const taskId = requireStr(payload.taskId, 160);
        if (!taskId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "taskId 必填");
        const task = agentTaskStore.getTask(taskId);
        if (!task) throw createAgentError(AGENT_ERR_NOT_FOUND, "任务不存在：" + taskId);
        accessOrForbidden(task.project_id, userId);
        const after = Number.isFinite(Number(payload.afterSequence)) ? Number(payload.afterSequence) : 0;
        return { items: agentTaskStore.listTaskEvents(taskId, Math.max(0, after)) };
      }
      case "agent/task/answer": {
        const taskId = requireStr(payload.taskId, 160);
        const answer = requireStr(payload.answer, 4000);
        if (!taskId || !answer) throw createAgentError(AGENT_ERR_INVALID_INPUT, "taskId 与 answer 必填");
        agentTaskStore.answerTask(taskId, userId, answer);
        return { task: taskSummary(agentTaskStore.getTask(taskId)) };
      }
      case "agent/task/continue": {
        const taskId = requireStr(payload.taskId, 160);
        const message = requireStr(payload.message, 4000);
        if (!taskId || !message) throw createAgentError(AGENT_ERR_INVALID_INPUT, "taskId 与 message 必填");
        agentTaskStore.continueTask(taskId, userId, message);
        return { task: taskSummary(agentTaskStore.getTask(taskId)) };
      }
      case "agent/task/pause": {
        const taskId = requireStr(payload.taskId, 160);
        if (!taskId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "taskId 必填");
        const task = agentTaskStore.getTask(taskId);
        if (!task) throw createAgentError(AGENT_ERR_NOT_FOUND, "任务不存在：" + taskId);
        accessOrForbidden(task.project_id, userId);
        agentTaskStore.pauseTask(taskId);
        return { task: taskSummary(agentTaskStore.getTask(taskId)) };
      }
      case "agent/task/cancel": {
        const taskId = requireStr(payload.taskId, 160);
        if (!taskId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "taskId 必填");
        const task = agentTaskStore.getTask(taskId);
        if (!task) throw createAgentError(AGENT_ERR_NOT_FOUND, "任务不存在：" + taskId);
        accessOrForbidden(task.project_id, userId);
        agentTaskStore.cancelTask(taskId);
        return { task: taskSummary(agentTaskStore.getTask(taskId)) };
      }
      case "agent/task/resume": {
        const taskId = requireStr(payload.taskId, 160);
        if (!taskId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "taskId 必填");
        const task = agentTaskStore.getTask(taskId);
        if (!task) throw createAgentError(AGENT_ERR_NOT_FOUND, "任务不存在：" + taskId);
        accessOrForbidden(task.project_id, userId, true);
        agentTaskStore.resumeTask(taskId);
        return { task: taskSummary(agentTaskStore.getTask(taskId)) };
      }
      case "agent/task/delete": {
        const taskId = requireStr(payload.taskId, 160);
        if (!taskId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "taskId 必填");
        const task = agentTaskStore.getTask(taskId);
        if (!task) throw createAgentError(AGENT_ERR_NOT_FOUND, "任务不存在：" + taskId);
        accessOrForbidden(task.project_id, userId);
        agentTaskStore.deleteTask(taskId);
        return { taskId, deleted: true };
      }
      case "agent/task/trace": {
        const taskId = requireStr(payload.taskId, 160);
        if (!taskId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "taskId 必填");
        return agentTaskStore.taskTrace(taskId, userId);
      }
      case "agent/task/stats": {
        const sinceMs = Number.isFinite(Number(payload.sinceMs)) ? Number(payload.sinceMs) : undefined;
        return agentTaskStore.taskStats(userId, sinceMs);
      }

      // ---------------- run ----------------
      case "agent/run/get": {
        const runId = requireStr(payload.runId, 160);
        if (!runId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "runId 必填");
        const run = agentKernelStore.getAgentRun(runId);
        if (!run) throw createAgentError(AGENT_ERR_NOT_FOUND, "Agent Run 不存在：" + runId);
        return { run };
      }
      case "agent/run/inspect": {
        const runId = requireStr(payload.runId, 160);
        if (!runId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "runId 必填");
        return { inspection: agentKernelInspection.inspectAgentRun(runId, now()) };
      }
      case "agent/run/list": {
        const projectId = requireStr(payload.projectId, 160) || undefined;
        const limit = Number.isFinite(Number(payload.limit)) ? Number(payload.limit) : 50;
        return { items: agentKernelStore.listAgentRuns(userId, projectId, limit) };
      }

      // ---------------- tool ----------------
      case "agent/tool/catalog": {
        if (!catalog) throw createAgentError(AGENT_ERR_DEPENDENCY_UNAVAILABLE, "工具目录未就绪：agent-tool-catalog.cjs 不可用", { dependency: "toolCatalog" });
        const snapshot = catalog.toolCatalogSnapshot({ actor, executableOnly: payload.executableOnly !== false, source: requireStr(payload.source, 20), sourceId: requireStr(payload.sourceId, 80), appId: requireStr(payload.appId, 80) });
        return { descriptors: snapshot.descriptors, tools: snapshot.tools, summary: snapshot.summary };
      }
      case "agent/tool/describe": {
        const name = requireStr(payload.tool, 200) || requireStr(payload.name, 200);
        if (!name) throw createAgentError(AGENT_ERR_INVALID_INPUT, "tool 必填");
        const resolved = toolResolver.resolveToolByName(name, { actor, executableOnly: true }, { catalog });
        if (!resolved.ok) throw mapResolverError(resolved.error);
        return { descriptor: resolved.descriptor, openaiTool: resolved.openaiTool, permission: resolved.permission };
      }
      case "agent/tool/call": {
        const name = requireStr(payload.tool, 200) || requireStr(payload.name, 200);
        if (!name) throw createAgentError(AGENT_ERR_INVALID_INPUT, "tool 必填");
        const resolved = toolResolver.resolveToolByName(name, { actor, executableOnly: true }, { catalog });
        if (!resolved.ok) throw mapResolverError(resolved.error);
        const handler = resolved.descriptor.handler || {};
        if (handler.type !== "file-tool") throw createAgentError(AGENT_ERR_DEPENDENCY_UNAVAILABLE, "工具执行器未接入：" + String(handler.type || "unknown"), { tool: name, handlerType: handler.type || null });
        const args = payload.arguments && typeof payload.arguments === "object" ? payload.arguments : payload.args && typeof payload.args === "object" ? payload.args : {};
        try {
          const result = await builtinTools.runTool(handler.toolName || name, { userId, rootNodeId: requireStr(payload.rootNodeId, 160) || undefined, runId: requireStr(payload.runId, 160) || undefined }, args);
          return { tool: name, result };
        } catch (error) {
          throw mapToolError(error, name);
        }
      }

      // ---------------- capability ----------------
      case "agent/capability/route": {
        const request = {
          instruction: asStr(payload.instruction, 4000) || "",
          actor, hasImageInput: payload.hasImageInput === true,
          taskId: requireStr(payload.taskId, 160), projectId: requireStr(payload.projectId, 160), rootNodeId: requireStr(payload.rootNodeId, 160),
          preferredProviderId: requireStr(payload.preferredProviderId, 120), preferredModel: requireStr(payload.preferredModel, 200),
          providers: Array.isArray(payload.providers) ? payload.providers : undefined,
          requestedSources: Array.isArray(payload.requestedSources) ? payload.requestedSources.slice(0, 16).map((item) => asStr(item, 40)) : undefined,
        };
        return { route: capabilityRouter.resolveAgentRoute(request) };
      }

      // ---------------- project ----------------
      case "agent/project/create": {
        const name = requireStr(payload.name, 200);
        const rootNodeId = requireStr(payload.rootNodeId, 200);
        if (!name || !rootNodeId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "name 与 rootNodeId 必填");
        return { project: agentTaskStore.createProject({ name, rootNodeId, createdBy: userId }) };
      }
      case "agent/project/list": return { items: agentTaskStore.listProjects(userId) };
      case "agent/project/snapshot": {
        const projectId = requireStr(payload.projectId, 160);
        if (!projectId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "projectId 必填");
        const project = agentTaskStore.getProject(projectId);
        if (!project) throw createAgentError(AGENT_ERR_NOT_FOUND, "项目不存在：" + projectId);
        accessOrForbidden(projectId, userId, true);
        projectSnapshot.writeProjectSnapshot(projectId);
        return { projectId, written: true };
      }
      case "agent/project/run": {
        const projectId = requireStr(payload.projectId, 160);
        const instruction = requireStr(payload.instruction, 8000);
        if (!projectId || !instruction) throw createAgentError(AGENT_ERR_INVALID_INPUT, "projectId 与 instruction 必填");
        const project = agentTaskStore.getProject(projectId);
        if (!project) throw createAgentError(AGENT_ERR_NOT_FOUND, "项目不存在：" + projectId);
        // 一次运行会真实调用模型与工具，按"使用"级动作校验项目权限（与 createTask 同口径）。
        accessOrForbidden(projectId, userId, true);
        const history = Array.isArray(payload.history) ? payload.history : [];
        const preferences = payload.preferences && typeof payload.preferences === "object" ? payload.preferences : {};
        // runId / taskId 不接受渲染层自报：Run 归属由 RunManager 依 actor + projectId 自行创建。
        const session = { requestId: context.requestId || undefined, threadId: requireStr(payload.threadId, 120) || undefined };
        // 每次分发都重注本 bundle 的适配器（见 5b）：未注入的适配器由 project-agent-mode 抛结构化
        // AGENT_DEPENDENCY_UNAVAILABLE（project-agent-mode.cjs:100-149），绝不伪造成功。
        projectAgentMode.configureProjectAgentMode({ ...projectAdapters, clock: now, logger });
        try {
          const outcome = await projectAgentMode.runProjectAgentMode(project, actor, instruction, history, preferences, session);
          return { projectId, outcome };
        } catch (error) {
          throw mapProjectModeError(error);
        }
      }

      // ---------------- memory ----------------
      case "agent/memory/list": {
        const projectId = requireStr(payload.projectId, 160);
        if (!projectId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "projectId 必填");
        accessOrForbidden(projectId, userId);
        return { items: agentTaskStore.listMemories(projectId, payload.includeSuperseded === true) };
      }
      case "agent/memory/save": {
        const projectId = requireStr(payload.projectId, 160);
        const content = requireStr(payload.content, 2000);
        if (!projectId || !content) throw createAgentError(AGENT_ERR_INVALID_INPUT, "projectId 与 content 必填");
        accessOrForbidden(projectId, userId, true);
        return { memory: agentTaskStore.addMemory({ projectId, content, createdBy: userId, sourceType: requireStr(payload.sourceType, 40), sourceId: requireStr(payload.sourceId, 160), replacesId: requireStr(payload.replacesId, 160) }) };
      }

      // ---------------- react ----------------
      case "agent/react/run": {
        const taskId = requireStr(payload.taskId, 160);
        if (!taskId) throw createAgentError(AGENT_ERR_INVALID_INPUT, "taskId 必填");
        const task = agentTaskStore.getTask(taskId);
        if (!task) throw createAgentError(AGENT_ERR_NOT_FOUND, "任务不存在：" + taskId);
        accessOrForbidden(task.project_id, userId, true);
        const project = agentTaskStore.getProject(task.project_id);
        const rootNodeId = project ? project.root_node_id : null;
        const outcome = await reactDriver.runReactTask(taskId, null, null, rootNodeId, userId);
        return { taskId, outcome };
      }

      // ---------------- health ----------------
      case "agent/health": return { status: dependencies.db ? "ok" : "degraded", dependencies, commands: agentDomain.listAgentCommands().length, eventChannel: AGENT_EVENT_CHANNEL };

      default: throw agentCommandNotAllowed(command);
    }
  }

  /**
   * 唯一分发入口：白名单 → actor 解析 → dispatch → 脱敏；失败统一 normalizeAgentError。
   * 每次执行前后各发一条 progress 事件（P1 信封），供渲染层显示与丢帧判定。
   */
  async function execute(command, payload, ctx = {}) {
    if (!isAgentCommand(command)) return normalizeAgentError(agentCommandNotAllowed(command));
    const context = {
      sessionRef: requireStr(ctx && ctx.sessionRef, 160) || null,
      appId: requireStr(ctx && ctx.appId, 60) || HOST_APP_ID,
      source: "agent",
      requestId: requireStr(ctx && ctx.requestId, 80) || null,
    };
    emit("progress", { command, phase: "begin", requestId: context.requestId });
    const actorResult = resolveActor(context);
    if (!actorResult.ok) {
      emit("progress", { command, phase: "rejected", reason: "unauthenticated", requestId: context.requestId });
      return normalizeAgentError(createAgentError(AGENT_ERR_UNAUTHENTICATED, actorResult.message || "当前会话未认证，agent 命令被拒绝"));
    }
    context.userId = String(actorResult.user.id);
    context.actor = actorResult.user;
    const body = payload && typeof payload === "object" ? payload : {};
    try {
      const value = await dispatch(command, body, context);
      emit("progress", { command, phase: "completed", requestId: context.requestId });
      return { ok: true, value: redactAgentValue(value) };
    } catch (error) {
      emit("progress", { command, phase: "failed", requestId: context.requestId });
      return normalizeAgentError(error);
    }
  }

  return {
    execute,
    setEventSink,
    emitEvent: emit,
    /** 只读依赖清单（供 health 与测试；不含任何路径 / 凭据值）。 */
    dependencies,
  };
}

module.exports = { createAgentBundle, HOST_APP_ID, buildMcpCatalogSource, buildSkillCatalogSource, buildCanvasCatalogSource };
