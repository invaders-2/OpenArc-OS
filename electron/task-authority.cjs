/**
 * P1 · 任务域**单一写入口**（跨两套任务表）。
 *
 * ## 边界
 *   · 生产代码里对两张任务表族的**直接写 SQL 只允许出现在两个 store 内部**：
 *     electron/task-store.cjs（core 三表）与 electron/agent-task-store.cjs（dx 三表）。
 *     其它模块的任务 / 步骤 / 事件写操作一律经本模块，由它按 source 路由到对应 store。
 *     该边界由 tests/dxos-agent-task-authority.test.mjs 的源码级断言守住（白名单只有两个 store）。
 *   · 本模块**不复制**任一状态机：
 *       - core：迁移校验复用 electron/task-domain.cjs 的 canTransitionTask（同一份迁移表）；
 *       - dx：没有公开迁移表，一律路由到 agent-task-store 里已带校验的生命周期函数
 *         （pauseTask / cancelTask / resumeTask）；其余状态交给 store 自己的 updateTaskStatus。
 *     两套 store 抛出的领域错误原样穿透（各自状态机的权威不变），本模块只加自己的入参/路由错误。
 *   · 内部统一：入参校验、审计、幂等、结构化错误码。
 *
 * ## 为什么需要它
 *   产品要"一套任务系统"，但短期不做物理表合并（见 docs/dxos-port/Dx-TASK-MERGE-PLAN.md §5.2
 *   替代方案 A）。只读侧用 SQL 视图统一（task-unified-schema.cjs），写入侧用本模块统一。
 *
 * ## 错误码（调用方按 code 判别，不解析 message）
 *   TASK_AUTHORITY_INVALID_INPUT         入参缺失 / 形状不对
 *   TASK_AUTHORITY_UNKNOWN_SOURCE        source 不是 core | dx
 *   TASK_AUTHORITY_UNSUPPORTED_OPERATION 该 source 不支持该操作
 *   TASK_AUTHORITY_INVALID_TRANSITION    状态迁移不合法（仅 core，用 task-domain 的迁移表判定）
 *   TASK_AUTHORITY_DEPENDENCY_UNAVAILABLE 未注入对应 store
 *   TASK_AUTHORITY_TASK_NOT_FOUND        目标任务不存在（core 迁移校验需要先读当前状态）
 *   TASK_AUTHORITY_STEP_NOT_FOUND        写回步骤时目标行不存在
 */
"use strict";

const taskDomain = require("./task-domain.cjs");

const SOURCE_CORE = "core";
const SOURCE_DX = "dx";
const TASK_AUTHORITY_SOURCES = Object.freeze([SOURCE_CORE, SOURCE_DX]);

const TASK_AUTHORITY_ERR = Object.freeze({
  INVALID_INPUT: "TASK_AUTHORITY_INVALID_INPUT",
  UNKNOWN_SOURCE: "TASK_AUTHORITY_UNKNOWN_SOURCE",
  UNSUPPORTED_OPERATION: "TASK_AUTHORITY_UNSUPPORTED_OPERATION",
  INVALID_TRANSITION: "TASK_AUTHORITY_INVALID_TRANSITION",
  DEPENDENCY_UNAVAILABLE: "TASK_AUTHORITY_DEPENDENCY_UNAVAILABLE",
  TASK_NOT_FOUND: "TASK_AUTHORITY_TASK_NOT_FOUND",
  STEP_NOT_FOUND: "TASK_AUTHORITY_STEP_NOT_FOUND",
});

/** 结构化错误：三元组 name/code/detail，与全仓 store 的错误风格一致。 */
function createTaskAuthorityError(code, message, detail) {
  const error = new Error(message == null ? code : String(message));
  error.name = "TaskAuthorityError";
  error.code = Object.values(TASK_AUTHORITY_ERR).includes(code) ? code : TASK_AUTHORITY_ERR.INVALID_INPUT;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function isTaskAuthorityError(error) {
  return !!error && typeof error === "object" && Object.values(TASK_AUTHORITY_ERR).includes(error.code);
}

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw createTaskAuthorityError(TASK_AUTHORITY_ERR.INVALID_INPUT, name + " 必填（非空字符串）", { field: name });
  }
  return value;
}

/**
 * 唯一写入口工厂。
 * @param {{ coreStore?: object, dxStore?: object, clock?: () => number, audit?: (record: object) => void, logger?: object }} options
 *   · coreStore —— TaskStore 实例（electron/task-store.cjs）；
 *   · dxStore   —— agent-task-store 导出集合；省略时惰性 require electron/agent-task-store.cjs；
 *   · audit     —— 可选审计回调；默认审计记录仍保存在 authority.auditLog()。
 */
function createTaskAuthority(options = {}) {
  let coreStore = options.coreStore || null;
  let dxStore = options.dxStore || null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const auditSink = typeof options.audit === "function" ? options.audit : null;
  const auditRecords = [];
  const idempotentResults = new Map();

  /** dx store 惰性解析：未显式注入时用生产单例（configureAgentTaskStore 已配置）。 */
  function resolveDxStore() {
    if (!dxStore) dxStore = require("./agent-task-store.cjs");
    return dxStore;
  }

  function requireCoreStore() {
    if (!coreStore) {
      throw createTaskAuthorityError(TASK_AUTHORITY_ERR.DEPENDENCY_UNAVAILABLE, "task-authority 未注入 coreStore", { dependency: "coreStore" });
    }
    return coreStore;
  }

  function assertSource(source) {
    if (!TASK_AUTHORITY_SOURCES.includes(source)) {
      throw createTaskAuthorityError(TASK_AUTHORITY_ERR.UNKNOWN_SOURCE, "source 必须是 core | dx", { source });
    }
    return source;
  }

  /** 审计 + 幂等复用的共同记账；写成功后追加一条不可变记录。 */
  function record(source, operation, outcome, targetId, detail) {
    const entry = Object.freeze({
      at: clock(),
      source,
      operation,
      outcome,
      targetId: targetId == null ? null : String(targetId),
      detail: detail === undefined ? null : detail,
    });
    auditRecords.push(entry);
    if (auditSink) auditSink(entry);
    return entry;
  }

  /**
   * 幂等：同一 (source, operation, idempotencyKey) 只执行一次，重复调用直接回放首次结果。
   * 未给 key 时不启用（保持既有调用语义）。
   */
  function withIdempotency(source, operation, idempotencyKey, run) {
    if (idempotencyKey === undefined || idempotencyKey === null || idempotencyKey === "") return run();
    requireText(String(idempotencyKey), "idempotencyKey");
    const key = source + ":" + operation + ":" + String(idempotencyKey);
    if (idempotentResults.has(key)) {
      record(source, operation, "duplicate", null, { idempotencyKey: String(idempotencyKey) });
      return idempotentResults.get(key);
    }
    const result = run();
    idempotentResults.set(key, result);
    return result;
  }

  /** core 任务创建：入参直接是 TaskStore.insertTask 的形状，只补一条状态合法性校验。 */
  function createCoreTask(input) {
    requireText(input.userId, "input.userId");
    requireText(input.appId, "input.appId");
    requireText(input.goal, "input.goal");
    const status = input.status === undefined || input.status === null ? taskDomain.TASK_STATUS.PENDING : String(input.status);
    if (!taskDomain.isKnownTaskStatus(status)) {
      throw createTaskAuthorityError(TASK_AUTHORITY_ERR.INVALID_INPUT, "core 任务状态非法：" + status, { status });
    }
    return requireCoreStore().insertTask(Object.assign({}, input, { status: status }));
  }

  /** dx 任务创建：入参直接是 agent-task-store.createTask 的形状。 */
  function createDxTask(input) {
    requireText(input.projectId, "input.projectId");
    requireText(input.createdBy, "input.createdBy");
    requireText(input.instruction, "input.instruction");
    return resolveDxStore().createTask(input);
  }

  /** 追加事件：统一形状 { taskId, eventType, message?, payload? }，两套 store 各自映射。 */
  function appendEvent(args) {
    const source = assertSource(args.source);
    const taskId = requireText(args.taskId, "taskId");
    const eventType = requireText(args.eventType, "eventType");
    return withIdempotency(source, "appendEvent", args.idempotencyKey, () => {
      let result;
      if (source === SOURCE_CORE) {
        result = requireCoreStore().appendEvent({ taskId: taskId, eventType: eventType, safePayload: args.payload === undefined ? null : args.payload, at: args.at === undefined ? null : args.at });
      } else {
        result = resolveDxStore().appendTaskEvent(taskId, eventType, requireText(args.message, "message"), args.payload === undefined ? undefined : args.payload);
      }
      record(source, "appendEvent", "accepted", taskId, { eventType: eventType });
      return result;
    });
  }

  /** 追加步骤：统一入口，形状仍由 source 决定（core 走 insertStep，dx 走 appendDynamicStep）。 */
  function appendStep(args) {
    const source = assertSource(args.source);
    const taskId = requireText(args.taskId, "taskId");
    return withIdempotency(source, "appendStep", args.idempotencyKey, () => {
      let result;
      if (source === SOURCE_CORE) {
        const status = args.status === undefined || args.status === null ? taskDomain.STEP_STATUS.PENDING : String(args.status);
        if (!taskDomain.isKnownStepStatus(status)) {
          throw createTaskAuthorityError(TASK_AUTHORITY_ERR.INVALID_INPUT, "core 步骤状态非法：" + status, { status });
        }
        result = requireCoreStore().insertStep(Object.assign({}, args.step || {}, { taskId: taskId, status: status }));
      } else {
        result = resolveDxStore().appendDynamicStep(taskId, requireText(args.title, "title"), requireText(args.toolName, "toolName"), args.args, args.stableOperationId);
      }
      record(source, "appendStep", "accepted", (result && (result.stepId || result.step_id || result.id)) || taskId, { taskId: taskId });
      return result;
    });
  }

  /**
   * 任务状态迁移。
   *   · core：先读当前行，用 task-domain 的迁移表判定 PENDING→SUCCEEDED 这类非法边，
   *     合法时更新 status/updated_at 并递增 revision（与 task-service 的写法一致）；
   *   · dx：已知 11 态内，路由到 store 自己的迁移函数（pause/cancel/resume），其余交给
   *     store 的 updateTaskStatus —— 校验权威仍在该 store。
   */
  function updateTaskStatus(args) {
    const source = assertSource(args.source);
    const taskId = requireText(args.taskId, "taskId");
    const to = requireText(args.to, "to");
    return withIdempotency(source, "updateTaskStatus", args.idempotencyKey, () => {
      if (source === SOURCE_CORE) {
        if (!taskDomain.isKnownTaskStatus(to)) {
          throw createTaskAuthorityError(TASK_AUTHORITY_ERR.INVALID_INPUT, "core 任务状态非法：" + to, { to: to });
        }
        const store = requireCoreStore();
        const current = store.taskById(taskId);
        if (!current) throw createTaskAuthorityError(TASK_AUTHORITY_ERR.TASK_NOT_FOUND, "任务不存在：" + taskId, { taskId: taskId });
        if (!taskDomain.canTransitionTask(current.status, to)) {
          throw createTaskAuthorityError(TASK_AUTHORITY_ERR.INVALID_TRANSITION, "非法迁移：" + current.status + " -> " + to, { from: current.status, to: to });
        }
        const patch = Object.assign({}, args.extras || {}, { status: to, updated_at: clock(), revision: Number(current.revision || 1) + 1 });
        const updated = store.updateTask(taskId, patch);
        record(source, "updateTaskStatus", "accepted", taskId, { from: current.status, to: to });
        return updated;
      }
      const store = resolveDxStore();
      if (!store.TASK_STATUSES.includes(to)) {
        throw createTaskAuthorityError(TASK_AUTHORITY_ERR.INVALID_INPUT, "dx 任务状态非法：" + to, { to: to });
      }
      let result;
      if (to === "paused") result = store.pauseTask(taskId);
      else if (to === "cancelled") result = store.cancelTask(taskId);
      else if (to === "queued") result = store.resumeTask(taskId);
      else result = store.updateTaskStatus(taskId, to, args.extras);
      record(source, "updateTaskStatus", "accepted", taskId, { to: to });
      return result;
    });
  }

  /** 把提交产物坐标写回步骤：core 写 output_ref，dx 写 output_json。 */
  function writeStepOutput(args) {
    const source = assertSource(args.source);
    const taskId = requireText(args.taskId, "taskId");
    const stepId = requireText(args.stepId, "stepId");
    if (args.output === undefined) {
      throw createTaskAuthorityError(TASK_AUTHORITY_ERR.INVALID_INPUT, "output 必填", { stepId: stepId });
    }
    return withIdempotency(source, "writeStepOutput", args.idempotencyKey, () => {
      let changed;
      if (source === SOURCE_CORE) {
        const outputRef = typeof args.output === "string" ? args.output : JSON.stringify(args.output);
        const updated = requireCoreStore().updateStep(stepId, { output_ref: outputRef });
        changed = !!updated;
      } else {
        changed = resolveDxStore().attachStepOutput(taskId, stepId, args.output);
      }
      if (!changed) throw createTaskAuthorityError(TASK_AUTHORITY_ERR.STEP_NOT_FOUND, "步骤不存在或不属于该任务：" + stepId, { taskId: taskId, stepId: stepId });
      record(source, "writeStepOutput", "accepted", stepId, { taskId: taskId });
      return true;
    });
  }

  return Object.freeze({
    createTask(args) {
      const source = assertSource(args.source);
      return withIdempotency(source, "createTask", args.idempotencyKey, () => {
        const result = source === SOURCE_CORE ? createCoreTask(args.input || {}) : createDxTask(args.input || {});
        record(source, "createTask", "accepted", (result && (result.taskId || result.id)) || null, null);
        return result;
      });
    },
    appendEvent,
    appendStep,
    updateTaskStatus,
    writeStepOutput,
    /** 审计读数：返回未冻结数组的浅拷贝，供测试 / 健康检查。 */
    auditLog() {
      return auditRecords.slice();
    },
    /** 幂等表大小（测试用）。 */
    idempotencySize() {
      return idempotentResults.size;
    },
  });
}

module.exports = {
  SOURCE_CORE,
  SOURCE_DX,
  TASK_AUTHORITY_SOURCES,
  TASK_AUTHORITY_ERR,
  createTaskAuthorityError,
  isTaskAuthorityError,
  createTaskAuthority,
};
