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
const { ToolStore } = require("./tool-store.cjs");
const { ToolRegistry } = require("./tool-registry.cjs");
const { ControlledToolProxy } = require("./controlled-tool-proxy.cjs");
const { createToolAdapters } = require("./tool-adapters.cjs");
const { SideEffectStore } = require("./side-effect-store.cjs");
const { SideEffectAuthority } = require("./side-effect-authority.cjs");
const { SideEffectRuntime } = require("./side-effect-runtime.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { WRITE_TOOL_IDS } = require("./dsh-tool-profile.cjs");

function createTaskBundle({ identityStore, authorization, authStore, modelService = null, modelProxy = null, logger = null, clock = null, adapterFactory = null, resourceService = null, searchService = null, dbPath = null, storeRoot = null, runtimeDir = null, sideEffectApprovalWaitMs = null } = {}) {
  if (!identityStore) throw new Error("createTaskBundle 需要 identityStore");
  if (!authorization || !authStore) throw new Error("createTaskBundle 需要 D3 Authorization");
  const taskStore = new TaskStore({ identity: identityStore, clock });
  const taskService = new TaskService({ identity: identityStore, authService: authorization, authStore, taskStore, modelService, clock, logger });
  const taskRecovery = taskService.recoverRunning();
  // D4-03A：Controlled Tool Proxy（Registry 权威 + D3 授权 + decision）。
  const toolStore = new ToolStore({ identity: identityStore, clock });
  const toolRegistry = new ToolRegistry();
  // D4-03B/C2：静态 allowlist adapter（executionProvider → 既有 Domain）。
  const adapters = createToolAdapters({ resourceService, searchService });
  const toolProxy = new ControlledToolProxy({ registry: toolRegistry, toolStore, authService: authorization, taskStore, adapters, clock, logger });
  // D4-03C4：trusted runtime supervisor（唯一 observeExit / registerRuntime 调用方）。
  const supervisor = new RuntimeSupervisor({
    runtimeDir: runtimeDir || path.join(path.dirname(String(dbPath || "openarc.db")), "runtime", "side-effects"),
    clock, logger,
  });
  const sideEffectStore = new SideEffectStore({ identity: identityStore, clock });
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
  // 只有已持久化的 trusted EXITED proof（或本进程真实 child 'exit'）才允许 recoverOnStartup
  // 把 quiesced 升级为 true；pathname probe 只回答 reachability，绝不产生 death proof。
  const sideEffectReady = supervisor.rehydrate()
    .then(() => sideEffectRuntime.recoverOnStartup())
    .catch(() => null);
  let orchestrator = null;
  if (modelProxy) {
    const factory = typeof adapterFactory === "function" ? adapterFactory : () => new HarnessAdapter({ modelProxy, logger, clock });
    orchestrator = new TaskHarnessOrchestrator({
      taskService, adapterFactory: factory, toolProxy, sideEffectRuntime, clock, logger,
      // D4-04：混合 READ + WRITE turn 需要多次受控 tool call；capability 必须有合理 bounded 预算
      // （此前未设置 maxCalls 会退化成 1，第二次 tool call 直接 TOOL_CAPABILITY_EXHAUSTED）。
      toolFacade: { enabled: true, toolIds: ["resource.search", "resource.read.metadata"], writeToolIds: WRITE_TOOL_IDS, maxCalls: 16, ttlMs: 300000 },
    });
  }
  return { taskStore, taskService, taskRecovery, toolStore, toolRegistry, toolProxy, adapters, supervisor, sideEffectStore, sideEffectAuthority, sideEffectRuntime, sideEffectRecovery, sideEffectReady, orchestrator };
}

/** D4-04：Renderer 可用的 Task 命令白名单（trusted sender + main-process session 注入）。 */
const TASK_COMMANDS = Object.freeze(["task/run", "task/get", "task/list", "task/cancel"]);

function registerTaskIpc({ ipcMain, taskService, orchestrator, identity, isTrusted, send = null, hostAppId = "ai" } = {}) {
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
    try {
      switch (command) {
        case "task/run": {
          const goal = typeof payload.goal === "string" ? payload.goal.slice(0, 2000) : "";
          if (!goal.trim()) return { ok: false, error: "INVALID_INPUT" };
          const created = taskService.createTask({ context, goal });
          if (!created.ok) return created;
          const taskId = created.task.taskId;
          // 不等待整条 Harness 链：立即返回，进度经 send 推送；approval 由 sideeffect:event 推送。
          const running = orchestrator.runTask({ context, taskId, expectedRevision: created.task.revision, verify: { type: "SCHEMA_VALID" } });
          running.then((r) => {
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
          }).catch(() => { try { send({ type: "task/result", taskId, ok: false, status: null, error: "INTERNAL_ERROR" }); } catch { /* ignore */ } });
          return { ok: true, taskId, status: created.task.status };
        }
        case "task/get": {
          const taskId = String(payload.taskId == null ? "" : payload.taskId);
          const got = taskService.getTask({ context, taskId });
          if (!got.ok) return got;
          const steps = taskService.getSteps({ context, taskId });
          const artifacts = taskService.getArtifacts({ context, taskId });
          return { ok: true, task: got.task, steps: steps.ok ? steps.items : [], artifacts: artifacts.ok ? artifacts.items : [] };
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
        default: return { ok: false, error: "TASK_COMMAND_NOT_ALLOWED" };
      }
    } catch {
      return { ok: false, error: "INTERNAL_ERROR" };
    }
  });
}

module.exports = { createTaskBundle, registerTaskIpc, TASK_COMMANDS };
