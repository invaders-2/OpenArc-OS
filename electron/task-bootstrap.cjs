/**
 * D4-02A / D4-02C · Task Runtime 装配（与 Model Service 共用同一条 SQLite 连接与 AuthorizationService）。
 *
 * 启动即执行一次 recovery：重启前 RUNNING 的 Task/Step 一律 BLOCKED + RECOVERY_REQUIRED，
 * 未收尾的 Harness Run 一律 UNKNOWN EFFECT → BLOCK，绝不自动 replay / retry。
 * 有 ModelProxy 时同时装配 TaskHarnessOrchestrator（Harness = 临时推理运行时）。
 */
"use strict";
const { TaskStore } = require("./task-store.cjs");
const { TaskService } = require("./task-service.cjs");
const { TaskHarnessOrchestrator } = require("./task-harness-orchestrator.cjs");
const { HarnessAdapter } = require("./harness-adapter.cjs");

function createTaskBundle({ identityStore, authorization, authStore, modelService = null, modelProxy = null, logger = null, clock = null, adapterFactory = null } = {}) {
  if (!identityStore) throw new Error("createTaskBundle 需要 identityStore");
  if (!authorization || !authStore) throw new Error("createTaskBundle 需要 D3 Authorization");
  const taskStore = new TaskStore({ identity: identityStore, clock });
  const taskService = new TaskService({ identity: identityStore, authService: authorization, authStore, taskStore, modelService, clock, logger });
  const taskRecovery = taskService.recoverRunning();
  let orchestrator = null;
  if (modelProxy) {
    const factory = typeof adapterFactory === "function" ? adapterFactory : () => new HarnessAdapter({ modelProxy, logger, clock });
    orchestrator = new TaskHarnessOrchestrator({ taskService, adapterFactory: factory, clock, logger });
  }
  return { taskStore, taskService, taskRecovery, orchestrator };
}

module.exports = { createTaskBundle };
