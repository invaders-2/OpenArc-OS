"use strict";
/**
 * B3c · Agent 运行时依赖注入中心。
 *
 * 为什么单独一层：源 server/agent-runtime/* 直接 import 了 ccsDb / auth / fs / agent-kernel
 * 等重量模块。移植后这些能力各自落在独立模块（B3a agent-task-store / B3d agent-builtin-tools /
 * B6 dxos-fs-adapter / B4 authorization），本层把它们收敛成一个显式注入点：必须由装配方注入，
 * 未注入即抛结构化 AGENT_DEPENDENCY_UNAVAILABLE，绝不伪造成功（硬约束 3）。
 *
 * 对应源：server/ccsDb.ts:1-990（db）、server/agent-kernel/kernel.ts:1-52（kernel）、
 *         server/taskStore.ts:1-1069（taskStore）、server/fs.ts（fsAdapter）、
 *         server/auth.ts（Actor，属 B4，这里只接受普通对象）。
 */
const crypto = require("node:crypto");

/** 结构化依赖缺失码：后续波次据此判定"该能力本轮未接入"，而不是把它当业务失败。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

/**
 * 默认依赖形状（源 configureAgentTaskStore 同构，见 electron/agent-task-store.cjs）。
 *   db               node:sqlite DatabaseSync（v22 已建 agent_* 表）
 *   kernel           { prepareAgentTurn(input) }        —— server/agent-kernel/kernel.ts:8
 *   taskStore        B3a agent-task-store.cjs 导出集合（runStore + taskStore）
 *   modelAdapter     { call({ providerId, model, messages, tools, params, stream, signal, onEvent }) }
 *                    —— 形状对齐本仓 electron/provider-protocol-service.cjs:151
 *   toolRunner       { run(toolName, args, ctx) }        —— B3d
 *   fsAdapter        B6 虚拟文件树（接口见 agent-runtime-workspace.cjs 顶部）
 *   workspaceAdapter 可选：工作区级适配器；未提供时回退 fsAdapter
 *   clock / logger / idFactory
 */
function defaults() {
  return {
    db: null,
    kernel: null,
    taskStore: null,
    // 可选：B3b agent-kernel-store.cjs（server/agent-kernel/runStore.ts）。未注入时按下列顺序解析。
    runStore: null,
    modelAdapter: null,
    toolRunner: null,
    fsAdapter: null,
    workspaceAdapter: null,
    clock: () => Date.now(),
    logger: null,
    idFactory: () => crypto.randomUUID(),
  };
}

let deps = defaults();
/** runStore 解析缓存：键为 [taskStore, runStore, db] 身份，任一变化即失效。 */
let runStoreCache = null;
let runStoreCacheKey = null;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 只接受白名单键，避免把无关字段带进运行时。 */
function configureAgentRuntime(patch = {}) {
  if (!isPlainObject(patch)) throw dependencyUnavailable("configureAgentRuntime", "配置必须是对象");
  const next = { ...deps };
  for (const key of Object.keys(defaults())) if (patch[key] !== undefined) next[key] = patch[key];
  deps = next;
  runStoreCache = null;
  runStoreCacheKey = null;
  return snapshot();
}

/** 仅供测试：清空全部注入，恢复"未接入"状态。 */
function resetAgentRuntimeForTests() {
  deps = defaults();
  runStoreCache = null;
  runStoreCacheKey = null;
  return snapshot();
}

/** 只读视图，避免调用方原地改注入对象。 */
function snapshot() {
  return { ...deps };
}

function agentRuntimeDeps() {
  return deps;
}

/** 结构化依赖缺失错误：保留 name/code/dependency 三元组，便于 IPC 侧判定。 */
function dependencyUnavailable(name, detail) {
  const err = new Error("Agent 运行时依赖不可用：" + String(name));
  err.name = "AgentDependencyUnavailableError";
  err.code = AGENT_DEPENDENCY_UNAVAILABLE;
  err.dependency = String(name);
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** 取必需依赖；未注入直接抛错（不做静默降级）。 */
function requireDependency(name) {
  const value = deps[name];
  if (value === null || value === undefined) throw dependencyUnavailable(name);
  return value;
}

function hasDependency(name) {
  return deps[name] !== null && deps[name] !== undefined;
}

/**
 * node:sqlite 的 DatabaseSync（Node 22.22）没有 ccsDb.transaction()，只有 exec/prepare。
 * 源代码大量使用 ccsDb.transaction(work).immediate()；这里用 BEGIN IMMEDIATE 复刻，
 * 并用 WeakSet 做连接级重入保护（对应源 ccsDb.inTransaction 判断）。
 */
const IN_TRANSACTION = new WeakSet();
function transactImmediate(connection, work) {
  if (IN_TRANSACTION.has(connection)) return work();
  connection.exec("BEGIN IMMEDIATE");
  IN_TRANSACTION.add(connection);
  try {
    const result = work();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      connection.exec("ROLLBACK");
    } catch {
      /* 回滚失败不覆盖原始异常 */
    }
    throw error;
  } finally {
    IN_TRANSACTION.delete(connection);
  }
}

/** 取注入对象上的必需方法；owner 存在但方法缺失同样视为依赖未接入。 */
function requireDependencyFunction(owner, name) {
  const host = requireDependency(owner);
  const fn = host && host[name];
  if (typeof fn !== "function") throw dependencyUnavailable(owner + "." + name);
  return fn;
}

/**
 * runStore 解析（server/agent-kernel/runStore.ts 的移植）：
 *   1. 注入的 taskStore 已提供 run 生命周期函数（测试注入或 B3a 扩展）；
 *   2. 显式注入的 runStore（B3b electron/agent-kernel-store.cjs）；
 *   3. 惰性 require ./agent-kernel-store.cjs，并用 deps.db/deps.clock 先配置 agent-kernel。
 * 三者都拿不到才抛 AGENT_DEPENDENCY_UNAVAILABLE —— 绝不伪造 Run 生命周期。
 */
function resolveRunStore() {
  const key = [deps.taskStore, deps.runStore, deps.db];
  if (runStoreCache && runStoreCacheKey
    && runStoreCacheKey[0] === key[0] && runStoreCacheKey[1] === key[1] && runStoreCacheKey[2] === key[2]) {
    return runStoreCache;
  }
  let store = null;
  const taskStore = deps.taskStore;
  if (taskStore && typeof taskStore.getAgentRun === "function" && typeof taskStore.createAgentRun === "function") {
    store = taskStore;
  } else if (deps.runStore && typeof deps.runStore.getAgentRun === "function") {
    store = deps.runStore;
  } else {
    try {
      const kernel = require("./agent-kernel.cjs");
      if (deps.db && typeof kernel.configureAgentKernel === "function") {
        kernel.configureAgentKernel({
          db: deps.db,
          ...(typeof deps.clock === "function" ? { clock: deps.clock } : {}),
          ...(deps.logger ? { logger: deps.logger } : {}),
        });
      }
      const candidate = require("./agent-kernel-store.cjs");
      if (candidate && typeof candidate.getAgentRun === "function") store = candidate;
    } catch {
      store = null;
    }
  }
  runStoreCache = store;
  runStoreCacheKey = key;
  return store;
}

/** 取 runStore 必需函数；未接入时抛结构化依赖错误。 */
function runStoreFunction(name) {
  const store = resolveRunStore();
  const fn = store && store[name];
  if (typeof fn !== "function") throw dependencyUnavailable("runStore." + name);
  return fn;
}

module.exports = {
  AGENT_DEPENDENCY_UNAVAILABLE,
  configureAgentRuntime,
  resetAgentRuntimeForTests,
  agentRuntimeDeps,
  snapshot,
  dependencyUnavailable,
  requireDependency,
  requireDependencyFunction,
  hasDependency,
  transactImmediate,
  resolveRunStore,
  runStoreFunction,
};
