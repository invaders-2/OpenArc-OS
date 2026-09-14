/**
 * D4-02A · Task Runtime 装配（与 Model Service 共用同一条 SQLite 连接与 AuthorizationService）。
 *
 * 启动即执行一次 recovery：重启前 RUNNING 的 Task/Step 一律 BLOCKED + RECOVERY_REQUIRED，
 * 绝不自动 replay / retry。
 */
"use strict";
const { TaskStore } = require("./task-store.cjs");
const { TaskService } = require("./task-service.cjs");

function createTaskBundle({ identityStore, authorization, authStore, modelService = null, logger = null, clock = null } = {}) {
  if (!identityStore) throw new Error("createTaskBundle 需要 identityStore");
  if (!authorization || !authStore) throw new Error("createTaskBundle 需要 D3 Authorization");
  const taskStore = new TaskStore({ identity: identityStore, clock });
  const taskService = new TaskService({ identity: identityStore, authService: authorization, authStore, taskStore, modelService, clock, logger });
  const taskRecovery = taskService.recoverRunning();
  return { taskStore, taskService, taskRecovery };
}

module.exports = { createTaskBundle };
