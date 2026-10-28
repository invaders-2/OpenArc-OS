/**
 * D4-02A / D4-02C / D4-03C4 · Task Runtime 装配（与 Model Service 共用同一条 SQLite
 * 连接与 AuthorizationService）。
 *
 * 启动即执行一次 recovery：重启前 RUNNING 的 Task/Step 一律 BLOCKED + RECOVERY_REQUIRED，
 * 未收尾的 Harness Run 一律 UNKNOWN EFFECT → BLOCK，绝不自动 replay / retry。
 * 有 ModelProxy 时同时装配 TaskHarnessOrchestrator（Harness = 临时推理运行时）。
 *
 * D4-03C4：这里是 **唯一** OpenArc-owned side-effect production assembly：
 * ToolRegistry → ControlledToolProxy → SideEffectAuthority → RuntimeSupervisor
 * → SideEffectRuntime（approval gateway + 受监督 executor runtime）。
 * 绝不建立第二套 Task / permission / approval / execution state。
 */
"use strict";
const path = require("node:path");
const { TaskStore } = require("./task-store.cjs");
const { TaskService } = require("./task-service.cjs");
const { TaskHarnessOrchestrator } = require("./task-harness-orchestrator.cjs");
const { HarnessAdapter } = require("./harness-adapter.cjs");
const { MemoryContext } = require("./memory-context.cjs");
const { ToolStore } = require("./tool-store.cjs");
const { ToolRegistry } = require("./tool-registry.cjs");
const { ControlledToolProxy } = require("./controlled-tool-proxy.cjs");
const { createToolAdapters } = require("./tool-adapters.cjs");
const { SideEffectStore } = require("./side-effect-store.cjs");
const { SideEffectAuthority } = require("./side-effect-authority.cjs");
const { SideEffectRuntime } = require("./side-effect-runtime.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { READ_TOOL_IDS, WRITE_TOOL_IDS } = require("./dsh-tool-profile.cjs");
const { AI_TASK_BUDGET } = require("./task-domain.cjs");

/** D4-04 / D4-06：官方 dsh Tool Facade 的 run 级预算（与 orchestrator 实际使用同一份配置）。 */
// toolIds / writeToolIds 一律取 allowlist 常量（唯一真源；不在装配处再写一份字面量）。
const TOOL_FACADE_CONFIG = Object.freeze({ enabled: true, toolIds: READ_TOOL_IDS, writeToolIds: WRITE_TOOL_IDS, maxCalls: AI_TASK_BUDGET.TOOL_CALLS, ttlMs: 300000 });

function createTaskBundle({ identityStore, authorization, authStore, modelService = null, modelProxy = null, logger = null, clock = null, adapterFactory = null, resourceService = null, searchService = null, browserControl = null, canvasService = null, dbPath = null, storeRoot = null, runtimeDir = null, sideEffectApprovalWaitMs = null, executorLauncher = null, executorTestHook = null } = {}) {
  if (!identityStore) throw new Error("createTaskBundle 需要 identityStore");
  if (!authorization || !authStore) throw new Error("createTaskBundle 需要 D3 Authorization");
  const taskStore = new TaskStore({ identity: identityStore, clock });
  const taskService = new TaskService({ identity: identityStore, authService: authorization, authStore, taskStore, modelService, clock, logger });
  const taskRecovery = taskService.recoverRunning();
  // D4 收口：账本 base 用实际生效额度（model=DEFAULT_MAX_CALLS / tool=facade maxCalls / rounds=MAX_TOOL_ROUNDS）。
  taskService.attachBudgetConfig({ modelMaxCalls: AI_TASK_BUDGET.MODEL_CALLS, toolMaxCalls: AI_TASK_BUDGET.TOOL_CALLS, maxToolRounds: AI_TASK_BUDGET.TOOL_ROUNDS });
  // D4-03A：Controlled Tool Proxy（Registry 权威 + D3 授权 + decision）。
  const toolStore = new ToolStore({ identity: identityStore, clock });
  const toolRegistry = new ToolRegistry();
  // D4-03B/C2：静态 allowlist adapter（executionProvider → 既有 Domain）。
  // D5-01 Closure-2：BrowserControl 与 Resource/Search 同一条装配路径 —— 不存在第二套执行通道。
  const adapters = createToolAdapters({ resourceService, searchService, browserControl, canvasService });
  const toolProxy = new ControlledToolProxy({ registry: toolRegistry, toolStore, authService: authorization, taskStore, taskService, adapters, clock, logger });
  // D4-03C4：trusted runtime supervisor（唯一 observeExit / registerRuntime 调用方）。
  const supervisor = new RuntimeSupervisor({
    runtimeDir: runtimeDir || path.join(path.dirname(String(dbPath || "openarc.db")), "runtime", "side-effects"),
    clock, logger,
    // production：Electron main 注入 utility process launcher；纯 Node 测试默认 node child launcher。
    // executorTestHook 是 constructor-only test seam（production 默认 null），不经 env / IPC / Harness。
    ...(executorLauncher ? { launcher: executorLauncher } : {}),
    ...(executorTestHook ? { executorTestHook } : {}),
  });
  const sideEffectStore = new SideEffectStore({ identity: identityStore, clock });
  // D4-06 Closure：TaskService 只读续接账本（tool executions / side-effect calls / active leases）。
  taskService.attachBudgetStores({ toolStore, sideEffectStore });
  const sideEffectAuthority = new SideEffectAuthority({
    registry: toolRegistry, sideEffectStore, taskStore, toolStore,
    authService: authorization, adapters, clock, taskService,
    // runtime identity = supervisor runtime；quiescence 只由 supervisor 的信任证据决定。
    instanceId: supervisor.instanceId, lifecycle: supervisor,
  });
  const sideEffectRuntime = new SideEffectRuntime({
    authority: sideEffectAuthority, supervisor, store: sideEffectStore, taskStore, taskService,
    toolProxy, registry: toolRegistry, resourceStore: resourceService ? resourceService.store : null,
    authService: authorization, dbPath, storeRoot, clock, logger,
    ...(sideEffectApprovalWaitMs ? { approvalWaitMs: sideEffectApprovalWaitMs } : {}),
  });
  // 启动恢复（第一段，fail closed）：pending approval 一律明确 BLOCKED；
  // RUNNING → UNKNOWN_EFFECT，quiescence 在 rehydrate 完成前一律 unproven。
  const sideEffectRecovery = sideEffectRuntime.recoverOnStartup();
  // 第二段：production supervisor 重建上一次进程的 executor 记录。
  // 口径（D4-03C4 Closure-3，本 Closure 仅修文案）：
  //   · persisted lifecycle record 只是 hint，不是 process-death authority；
  //   · cold restart **不会**因此获得 death authority（quiesced 仍为 false）；
  //   · 只有同一 live supervisor lifetime 内真实 child 'exit' 才可能建立 quiescence；
  //   · pathname probe 只回答 reachability，绝不产生 death proof。
  const sideEffectReady = supervisor.rehydrate()
    .then(() => sideEffectRuntime.recoverOnStartup())
    .catch(() => null);
  // D4-05 S4 / A36：有 SearchService + ResourceService 才装配受控记忆；否则 null（行为不变）。
  const memoryContext = searchService && resourceService
    ? new MemoryContext({ searchService, resourceService, taskService, authService: authorization, identity: identityStore, clock, logger })
    : null;
  let orchestrator = null;
  if (modelProxy) {
    const factory = typeof adapterFactory === "function" ? adapterFactory : () => new HarnessAdapter({ modelProxy, logger, clock });
    orchestrator = new TaskHarnessOrchestrator({
      taskService, adapterFactory: factory, toolProxy, sideEffectRuntime, clock, logger,
      // task-69：内置 AI/chat 任务预算（16 model / 32 tool / 8 rounds）；普通通用装配仍用 BUDGET_BASE。
      toolFacade: TOOL_FACADE_CONFIG,
      maxToolRounds: AI_TASK_BUDGET.TOOL_ROUNDS,
      memoryContext,
    });
  }
  return { taskStore, taskService, taskRecovery, toolStore, toolRegistry, toolProxy, adapters, supervisor, sideEffectStore, sideEffectAuthority, sideEffectRuntime, sideEffectRecovery, sideEffectReady, memoryContext, orchestrator, browserControl };
}

/** D4-04：Renderer 可用的 Task 命令白名单（trusted sender + main-process session 注入）。 */
const TASK_COMMANDS = Object.freeze(["task/run", "task/get", "task/list", "task/cancel", "task/resume", "task/appendStep", "task/recovery", "task/acknowledgeUnknownEffect"]);

/** 画布 Agent 思考强度（TapNow Off / Light / Standard / Heavy） */
const THINKING_LEVELS = Object.freeze(["off", "light", "standard", "heavy"]);
/** 画布 Agent 执行方式：confirm = 先出计划等用户确认（本轮不写画布）；auto = 规划后连续执行。两者写入都仍需可信批准。 */
const PLAN_MODES = Object.freeze(["confirm", "auto"]);

function normalizeCanvasTaskContext(raw) {
  if (raw == null) return { ok: true, context: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== 1) return { ok: false, error: "INVALID_INPUT" };
  const canvasId = typeof raw.canvasId === "string" ? raw.canvasId : "";
  if (!/^[A-Za-z0-9_.#:-]{1,120}$/.test(canvasId)) return { ok: false, error: "INVALID_INPUT" };
  const strings = (value, max, pattern) => Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && pattern.test(item));
  if (!strings(raw.selectedNodeIds, 16, /^[A-Za-z0-9_.#:-]{1,120}$/)) return { ok: false, error: "INVALID_INPUT" };
  if (!strings(raw.resourceRefs, 16, /^(?:openarc-asset:|resource:\/\/)[A-Za-z0-9_.#:-]{1,160}$/)) return { ok: false, error: "INVALID_INPUT" };
  if (!strings(raw.completionConditions, 4, /^[^\u0000-\u001f]{1,160}$/)) return { ok: false, error: "INVALID_INPUT" };
  if (raw.thinking != null && !THINKING_LEVELS.includes(raw.thinking)) return { ok: false, error: "INVALID_INPUT" };
  if (raw.planMode != null && !PLAN_MODES.includes(raw.planMode)) return { ok: false, error: "INVALID_INPUT" };
  const context = {
    type: "canvas.task.v1", schemaVersion: 1, canvasId,
    selectedNodeIds: [...new Set(raw.selectedNodeIds)], resourceRefs: [...new Set(raw.resourceRefs)],
    completionConditions: raw.completionConditions.slice(),
    ...(raw.thinking ? { thinking: raw.thinking } : {}),
    ...(raw.planMode ? { planMode: raw.planMode } : {}),
  };
  if (JSON.stringify(context).length > 3500) return { ok: false, error: "INVALID_INPUT" };
  return { ok: true, context };
}

function registerTaskIpc({ ipcMain, taskService, orchestrator, identity, isTrusted, send = null, hostAppId = "ai", canvasService = null } = {}) {
  if (typeof ipcMain.removeHandler === "function") { try { ipcMain.removeHandler("task:command"); } catch { /* not registered */ } }
  ipcMain.handle("task:command", async (e, raw) => {
    if (isTrusted && !isTrusted(e)) throw Error("Forbidden");
    if (!taskService || !orchestrator) return { ok: false, error: "INTERNAL_ERROR", detail: "task-not-ready" };
    if (!raw || typeof raw !== "object") return { ok: false, error: "INVALID_INPUT" };
    const command = String(raw.command != null ? raw.command : raw.type == null ? "" : raw.type);
    if (!TASK_COMMANDS.includes(command)) return { ok: false, error: "TASK_COMMAND_NOT_ALLOWED" };
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    // sessionRef / appId 一律来自可信宿主，忽略 Renderer 自报的 userId / role / appId / sessionRef。
    const context = { sessionRef: (identity && identity.current) || null, appId: hostAppId, source: "ui", requestId: typeof payload.requestId === "string" ? payload.requestId.slice(0, 80) : null };
    const emitResult = (taskId, r) => {
      if (!send) return;
      send({
        type: "task/result", taskId,
        ok: !!(r && r.ok),
        status: r && r.task ? r.task.status : null,
        stepStatus: r && r.step ? r.step.status : null,
        artifact: r && r.artifact ? { type: r.artifact.type, content: String(r.artifact.content == null ? "" : r.artifact.content).slice(0, 4000), checksum: r.artifact.checksum || null } : null,
        verification: r && r.verification ? { type: r.verification.type, status: r.verification.status } : null,
        error: r && r.error ? String(r.error).slice(0, 120) : null,
      });
      // task-52：运行结束后把步骤/模型/工具事件一次性推给对话 UI（safeEvent/safeCall，不含密钥）。
      if (taskId && typeof taskService.getEvents === "function") {
        const events = taskService.getEvents({ context, taskId });
        const calls = typeof taskService.getCalls === "function" ? taskService.getCalls({ context, taskId }) : null;
        if (events && events.ok) send({ type: "task/event", taskId, events: events.items, calls: calls && calls.ok ? calls.items : [] });
      }
    };
    try {
      switch (command) {
        case "task/run": {
          const goal = typeof payload.goal === "string" ? payload.goal.slice(0, 2000) : "";
          if (!goal.trim()) return { ok: false, error: "INVALID_INPUT" };
          const canvasInput = normalizeCanvasTaskContext(payload.canvasContext);
          if (!canvasInput.ok) return { ok: false, error: canvasInput.error };
          if (canvasInput.context) {
            if (!canvasService || typeof canvasService.getCanvas !== "function") return { ok: false, error: "CANVAS_UNAVAILABLE" };
            const target = canvasService.getCanvas({ context, canvasId: canvasInput.context.canvasId });
            if (!target || !target.ok) return { ok: false, error: "CANVAS_NOT_FOUND_OR_FORBIDDEN" };
          }
          // D4-03：产品任务的 model config 一律由**后端**按可信 context 解析后冻结（createTask 内再按当时
          // version 落库）；renderer 自报的 modelConfigId / modelConfigVersion 一概忽略。解析不出来就明确
          // 拒绝，绝不静默回退、绝不建未绑定任务（旧任务的懒绑定见 TaskService.startHarnessRun）。
          const modelService = taskService.modelService;
          const resolved = modelService && typeof modelService.resolveModel === "function"
            ? modelService.resolveModel({ context, capability: "chat" })
            : { ok: false, error: "MODEL_CONFIG_UNAVAILABLE" };
          if (!resolved.ok) return { ok: false, error: resolved.error };
          const created = taskService.createTask({ context, goal, modelConfigId: resolved.snapshot.modelConfigId });
          if (!created.ok) return created;
          const taskId = created.task.taskId;
          // 不等待整条 Harness 链：立即返回，进度经 send 推送；approval 由 sideeffect:event 推送。
          const running = orchestrator.runTask({ context, taskId, expectedRevision: created.task.revision, stepInput: canvasInput.context, verify: { type: "SCHEMA_VALID" } });
          running.then((r) => emitResult(taskId, r)).catch(() => { try { send({ type: "task/result", taskId, ok: false, status: null, error: "INTERNAL_ERROR" }); } catch { /* ignore */ } });
          return { ok: true, taskId, status: created.task.status };
        }
        case "task/get": {
          const taskId = String(payload.taskId == null ? "" : payload.taskId);
          const got = taskService.getTask({ context, taskId });
          if (!got.ok) return got;
          const steps = taskService.getSteps({ context, taskId });
          const artifacts = taskService.getArtifacts({ context, taskId });
          // D4 收口：失败 Verification 如实返回（safe，含 FAIL 的 type/expected/actual/executionId/stepId/runId）。
          const verifications = taskService.getVerifications({ context, taskId });
          // D4-06 Closure：可续接状态与预算账本一律后端判定（renderer 自报无效）。
          const eligibility = taskService.getResumeEligibility({ context, taskId });
          const ledger = taskService.getBudgetLedger({ context, taskId });
          // D4 Main-Entry Closure-6：追加资格与拒绝原因同样只由后端判定（只回 safe projection）。
          const appendEligibility = taskService.getAppendEligibility({ context, taskId });
          // D4-05 S2：结果未知的只读恢复投影（仅 BLOCKED + UNKNOWN_EFFECT 时 applicable）。
          const recovery = taskService.getRecoveryState({ context, taskId });
          // D4 收口：被后端拒绝且尚未被同一操作真实成功解决的明确 WRITE 操作（safe 投影）。
          const denied = typeof taskService.getDeniedRequiredWriteOperations === "function"
            ? taskService.getDeniedRequiredWriteOperations({ context, taskId })
            : { ok: false };
          // task-52：对话 UI 需要步骤/模型/工具事件；只回 safeEvent / safeCall（无密钥/无绝对路径）。
          const events = typeof taskService.getEvents === "function" ? taskService.getEvents({ context, taskId }) : null;
          const calls = typeof taskService.getCalls === "function" ? taskService.getCalls({ context, taskId }) : null;
          return {
            ok: true, task: got.task, steps: steps.ok ? steps.items : [], artifacts: artifacts.ok ? artifacts.items : [],
            events: events && events.ok ? events.items : [], calls: calls && calls.ok ? calls.items : [],
            verifications: verifications.ok ? verifications.items : [],
            deniedOperations: denied.ok && Array.isArray(denied.unresolved) ? denied.unresolved : [],
            resumable: !!(eligibility.ok && eligibility.resumable),
            stopReason: eligibility.ok ? (eligibility.stopReason || null) : null,
            resumeReason: eligibility.ok ? (eligibility.reason || null) : (eligibility.error || null),
            budgetLedger: ledger.ok ? ledger.ledger : null,
            recovery: recovery.ok ? recovery : null,
            appendable: !!(appendEligibility.ok && appendEligibility.appendable),
            appendReason: appendEligibility.ok ? (appendEligibility.reason || null) : (appendEligibility.error || null),
          };
        }
        case "task/list": {
          const list = taskService.listTasks({ context });
          return list.ok ? { ok: true, items: list.items } : list;
        }
        case "task/cancel": {
          const taskId = String(payload.taskId == null ? "" : payload.taskId);
          const got = taskService.getTask({ context, taskId });
          if (!got.ok) return got;
          return orchestrator.cancel({ context, taskId, expectedRevision: got.task.revision });
        }
        case "task/resume": {
          const taskId = String(payload.taskId == null ? "" : payload.taskId);
          const got = taskService.getTask({ context, taskId });
          if (!got.ok) return got;
          // expectedRevision 只是乐观并发 token；身份 / 预算 / 可续接状态一律由主进程判定。
          const expectedRevision = payload.expectedRevision == null ? got.task.revision : Number(payload.expectedRevision);
          const running = orchestrator.resumeBudgetExhausted({ context, taskId, expectedRevision, verify: { type: "SCHEMA_VALID" } });
          running.then((r) => emitResult(taskId, r)).catch(() => { try { send({ type: "task/result", taskId, ok: false, status: null, error: "INTERNAL_ERROR" }); } catch { /* ignore */ } });
          return { ok: true, taskId, status: got.task.status };
        }
        case "task/appendStep": {
          const taskId = String(payload.taskId == null ? "" : payload.taskId);
          const goal = typeof payload.goal === "string" ? payload.goal : "";
          if (!goal.trim()) return { ok: false, error: "INVALID_INPUT" };
          const got = taskService.getTask({ context, taskId });
          if (!got.ok) return got;
          // expectedRevision 只是乐观并发 token；追加资格 / 身份 / 预算一律由主进程判定。
          const expectedRevision = payload.expectedRevision == null ? got.task.revision : Number(payload.expectedRevision);
          // 拒绝同步返回（TASK_FORBIDDEN / TASK_NOT_FOUND / TASK_CANCELLED / TASK_REVISION_CONFLICT / APPEND_NOT_ALLOWED+reason）；只有运行异步。
          const cmd = orchestrator.appendStepCommand({ context, taskId, goal, expectedRevision, verify: { type: "SCHEMA_VALID" } });
          if (!cmd || cmd.ok !== true) return cmd;
          cmd.running.then((r) => emitResult(taskId, r)).catch(() => { try { send({ type: "task/result", taskId, ok: false, status: null, error: "INTERNAL_ERROR" }); } catch { /* ignore */ } });
          return { ok: true, taskId, status: cmd.task.status };
        }
        case "task/recovery": {
          const taskId = String(payload.taskId == null ? "" : payload.taskId);
          return taskService.getRecoveryState({ context, taskId });
        }
        case "task/acknowledgeUnknownEffect": {
          const taskId = String(payload.taskId == null ? "" : payload.taskId);
          // callId 由 renderer 指定目标，但身份 / owner / app 与 call 归属一律由 taskService 校验。
          const callId = String(payload.callId == null ? "" : payload.callId);
          return taskService.acknowledgeUnknownEffect({ context, taskId, callId });
        }
        default: return { ok: false, error: "TASK_COMMAND_NOT_ALLOWED" };
      }
    } catch {
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
}

module.exports = { createTaskBundle, registerTaskIpc, normalizeCanvasTaskContext, TASK_COMMANDS, TOOL_FACADE_CONFIG };
