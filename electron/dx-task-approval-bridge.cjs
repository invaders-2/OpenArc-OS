/**
 * D5-04 补丁 · DX 任务 → 核心审批任务 的**幂等身份映射桥**。
 *
 * 为什么需要：
 *   agent 工具循环（electron/project-agent-mode.cjs:444、electron/agent-react-driver.cjs:990）
 *   把 **dx_tasks / dx_task_steps** 的任务上下文交给 MCP 审批端口；而既有审批链
 *   （ControlledToolProxy → SideEffectAuthority → SideEffectRuntime）按**核心 tasks 表**
 *   定位 Task/Step/Run（electron/side-effect-authority.cjs:262/:267/:268、:563-:566）。
 *   两套 id 之间原本没有任何映射，导致该路径在审批后被结构化 TASK_NOT_FOUND 拒绝、
 *   0 传输 —— fail closed 是对的，但能力不可用。
 *
 * 本桥只做**一件事**：把一条 dx 任务步骤幂等地映射成一个核心审批任务/步骤/运行，
 * 并把这条身份关系持久化在 dx_task_approval_bridge（electron/dx-task-approval-schema.cjs）。
 * 它**不复制**审批状态机：approval / lease / claim / verify / audit 仍然全部由既有
 * SideEffectAuthority 与 Task Runtime 裁决，桥不新增第二套权威、不做表级合并。
 *
 * 边界（一条都不放宽）：
 *   · 只读 dx 侧：绝不 INSERT/UPDATE/DELETE dx_tasks / dx_task_steps；只读它们的身份与归属。
 *   · 身份来自可信 session：dx 任务归属必须等于 session 解析出的 actor；渲染层自报无效。
 *   · 核心任务只新增与本次审批相关的一行 Task + 一行 Step + 一行 Harness Run + 一行映射；
 *     同一 (dx_task_id, dx_step_id) 重复调用只产生一个核心任务（事务内 check-then-create）。
 *   · 桥失败一律结构化 DENIED（reasonCode = BRIDGE_ERROR.*），由调用方在 propose 之前
 *     fail closed —— 0 审批、0 传输。
 *   · 反查：核心任务 → dx 身份（dxIdentityOfCoreTask）。
 */
"use strict";
const crypto = require("node:crypto");
const { DECISION_STATUS } = require("./tool-domain.cjs");
const { TASK_STATUS, STEP_STATUS, HARNESS_RUN_STATUS, canTransitionTask, canTransitionStep } = require("./task-domain.cjs");
const { createSideEffectExecutionPort } = require("./mcp-agent-tools.cjs");

/** 桥自身的结构性错误码（绝不与 SideEffectAuthority 的业务码混用）。 */
const BRIDGE_ERROR = Object.freeze({
  INVALID_INPUT: "DX_BRIDGE_INVALID_INPUT",
  FORBIDDEN: "DX_BRIDGE_FORBIDDEN",
  TASK_NOT_FOUND: "DX_BRIDGE_TASK_NOT_FOUND",
  STEP_NOT_FOUND: "DX_BRIDGE_STEP_NOT_FOUND",
  TASK_FORBIDDEN: "DX_BRIDGE_TASK_FORBIDDEN",
  TASK_NOT_ACTIVE: "DX_BRIDGE_TASK_NOT_ACTIVE",
  MAPPING_DANGLING: "DX_BRIDGE_MAPPING_DANGLING",
  CORE_NOT_ACTIVATABLE: "DX_BRIDGE_CORE_NOT_ACTIVATABLE",
  MAPPING_WRITE_FAILED: "DX_BRIDGE_MAPPING_WRITE_FAILED",
  UNAVAILABLE: "DX_BRIDGE_UNAVAILABLE",
});

const newId = (prefix) => prefix + "_" + crypto.randomBytes(10).toString("base64url");

/** 核心 Harness Run 的 harness_version 字面量：标识"由桥建立、不是真实 Harness"。 */
const BRIDGE_HARNESS_VERSION = "dx-approval-bridge/1";

class DxTaskApprovalBridge {
  /**
   * @param {object} options
   * @param {object} options.identity     IdentityStore（提供同一 SQLite 连接与 transactSync）
   * @param {object} options.taskStore    核心 TaskStore（tasks / task_steps / task_harness_runs）
   * @param {object} options.dxTaskStore  dx 任务域只读端口（至少 getTask(id)；生产为 agent-task-store.cjs）
   * @param {object} options.authService  AuthorizationService（resolveActor）
   * @param {string} [options.appId]      承载 MCP 审批的核心 App Principal（默认 mcp-center）
   * @param {()=>number} [options.clock]
   * @param {object|(()=>object)} [options.context] trusted 上下文来源（sessionRef 只由宿主注入）
   */
  constructor({ identity, taskStore, dxTaskStore, authService, appId = "mcp-center", clock = null, context = null } = {}) {
    if (!identity || !identity.connection) throw new Error("DxTaskApprovalBridge 需要 IdentityStore");
    if (!taskStore || typeof taskStore.taskById !== "function") throw new Error("DxTaskApprovalBridge 需要核心 TaskStore");
    if (!dxTaskStore || typeof dxTaskStore.getTask !== "function") throw new Error("DxTaskApprovalBridge 需要 dx 任务只读端口（getTask）");
    if (!authService || typeof authService.resolveActor !== "function") throw new Error("DxTaskApprovalBridge 需要 AuthorizationService");
    this.identity = identity;
    this.db = identity.connection;
    this.taskStore = taskStore;
    this.dxTaskStore = dxTaskStore;
    this.authService = authService;
    this.appId = String(appId || "mcp-center");
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.contextSource = context;
  }

  #now() { return this.clock(); }

  /** trusted 上下文：sessionRef 只来自宿主注入；appId 固定为承载 MCP 审批的核心 App。 */
  trustedContext() {
    const base = typeof this.contextSource === "function" ? this.contextSource() : this.contextSource;
    const value = base && typeof base === "object" ? base : {};
    return { sessionRef: value.sessionRef || null, appId: value.appId || this.appId, source: "agent", agent: true, requestId: value.requestId || null };
  }

  /** 传入 id 是否已是核心任务（mcp/toolInvocation/call 路径）→ 桥应原样透传。 */
  isCoreTaskId(taskId) {
    if (taskId == null || String(taskId) === "") return false;
    return !!this.taskStore.taskById(String(taskId));
  }

  mappingRow(dxTaskId, dxStepId) {
    return this.db.prepare("SELECT * FROM dx_task_approval_bridge WHERE dx_task_id=? AND dx_step_id=?")
      .get(String(dxTaskId), String(dxStepId || "")) || null;
  }

  #safeMapping(row) {
    if (!row) return null;
    return {
      dxTaskId: row.dx_task_id,
      dxStepId: row.dx_step_id || null,
      dxRunId: row.dx_run_id || null,
      coreTaskId: row.core_task_id,
      coreStepId: row.core_step_id,
      coreRunId: row.core_run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 列出映射（不传 dxTaskId = 全部）；供证据与反查。 */
  listMappings({ dxTaskId = null } = {}) {
    const rows = dxTaskId == null
      ? this.db.prepare("SELECT * FROM dx_task_approval_bridge ORDER BY created_at, dx_task_id, dx_step_id").all()
      : this.db.prepare("SELECT * FROM dx_task_approval_bridge WHERE dx_task_id=? ORDER BY created_at, dx_step_id").all(String(dxTaskId));
    return rows.map((row) => this.#safeMapping(row));
  }

  /** 反查：核心审批任务 → 对应的 dx 任务/步骤身份；无映射返回 null。 */
  dxIdentityOfCoreTask(coreTaskId) {
    const row = this.db.prepare("SELECT * FROM dx_task_approval_bridge WHERE core_task_id=?").get(String(coreTaskId == null ? "" : coreTaskId)) || null;
    return this.#safeMapping(row);
  }

  #resolveActor(context) {
    const trusted = {
      sessionRef: context && context.sessionRef ? context.sessionRef : null,
      appId: (context && context.appId) || this.appId,
      source: "agent", agent: true,
      requestId: (context && context.requestId) || null,
    };
    if (!trusted.sessionRef) return { ok: false, error: BRIDGE_ERROR.INVALID_INPUT, detail: "缺少可信 sessionRef" };
    const actor = this.authService.resolveActor({ context: trusted });
    if (!actor || actor.ok !== true || !actor.user || actor.user.id == null) return { ok: false, error: BRIDGE_ERROR.FORBIDDEN, detail: "会话无效" };
    return { ok: true, actor, context: trusted };
  }

  /**
   * 幂等取得或创建核心审批任务。
   * 同一 (dxTaskId, dxStepId) 重复调用只产生一个核心任务；返回 { ok, created, duplicate, mapping, context }。
   */
  ensureCoreApprovalTask({ dxTaskId, dxStepId = null, dxRunId = null, context = null } = {}) {
    const id = dxTaskId == null ? "" : String(dxTaskId);
    if (!id) return { ok: false, error: BRIDGE_ERROR.INVALID_INPUT, detail: "缺少 dxTaskId" };
    const resolved = this.#resolveActor(context || this.trustedContext());
    if (resolved.ok !== true) return resolved;
    const actor = resolved.actor;
    const trusted = resolved.context;

    const dxTask = this.dxTaskStore.getTask(id);
    if (!dxTask) return { ok: false, error: BRIDGE_ERROR.TASK_NOT_FOUND, detail: id };
    const owner = dxTask.created_by == null ? "" : String(dxTask.created_by);
    if (!owner || owner !== String(actor.user.id)) return { ok: false, error: BRIDGE_ERROR.TASK_FORBIDDEN, detail: id };
    if (String(dxTask.status) !== "running") return { ok: false, error: BRIDGE_ERROR.TASK_NOT_ACTIVE, detail: String(dxTask.status || "") };

    // 步骤：显式给出优先，否则取 dx 任务当前正在跑的步骤（appendDynamicStep/startStep 会写 current_step_id）。
    let stepId = dxStepId == null || String(dxStepId) === "" ? null : String(dxStepId);
    if (!stepId && dxTask.current_step_id) stepId = String(dxTask.current_step_id);
    if (stepId) {
      const inHydrated = Array.isArray(dxTask.steps) && dxTask.steps.some((step) => String(step.id) === stepId);
      if (!inHydrated) {
        const stepRow = this.db.prepare("SELECT id FROM dx_task_steps WHERE id=? AND task_id=?").get(stepId, id);
        if (!stepRow) return { ok: false, error: BRIDGE_ERROR.STEP_NOT_FOUND, detail: stepId };
      }
    }
    const key = stepId || "";
    const runId = dxRunId == null || String(dxRunId) === "" ? null : String(dxRunId);

    const existing = this.mappingRow(id, key);
    if (existing) {
      const revived = this.#activateMapping(existing);
      if (revived.ok !== true) return revived;
      return { ok: true, created: false, duplicate: true, mapping: revived.mapping, context: trusted };
    }

    let created = false;
    let row = null;
    try {
      row = this.identity.transactSync(() => {
        // 事务内 check-then-create：并发下只有唯一赢家；输家读回赢家的行，不新建第二个核心任务。
        const again = this.mappingRow(id, key);
        if (again) return again;
        const now = this.#now();
        const coreTaskId = newId("task");
        const coreStepId = newId("step");
        const coreRunId = newId("hrun");
        this.db.prepare(
          "INSERT INTO dx_task_approval_bridge (dx_task_id, dx_step_id, dx_run_id, core_task_id, core_step_id, core_run_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        ).run(id, key, runId, coreTaskId, coreStepId, coreRunId, now, now);
        this.taskStore.insertTask({
          taskId: coreTaskId, userId: actor.user.id, sessionRef: trusted.sessionRef, appId: trusted.appId,
          status: TASK_STATUS.RUNNING,
          goal: "DX 任务审批桥 · " + id + (stepId ? " · step " + stepId : ""),
          createdAt: now, updatedAt: now, startedAt: now,
        });
        this.taskStore.insertStep({ stepId: coreStepId, taskId: coreTaskId, sequence: 1, kind: "reasoning", status: STEP_STATUS.RUNNING, startedAt: now, attempt: 1, maxAttempts: 1 });
        this.taskStore.updateTask(coreTaskId, { current_step_id: coreStepId });
        this.taskStore.insertHarnessRun({ runId: coreRunId, taskId: coreTaskId, stepId: coreStepId, status: HARNESS_RUN_STATUS.RUNNING, harnessVersion: BRIDGE_HARNESS_VERSION, startedAt: now });
        this.taskStore.appendEvent({
          taskId: coreTaskId, eventType: "task.created",
          safePayload: { source: "dx-approval-bridge", dxTaskId: id, dxStepId: stepId, dxRunId: runId }, at: now,
        });
        created = true;
        return this.mappingRow(id, key);
      });
    } catch (error) {
      const raced = this.mappingRow(id, key);
      if (!raced) return { ok: false, error: BRIDGE_ERROR.MAPPING_WRITE_FAILED, detail: String((error && error.message) || error).slice(0, 200) };
      row = raced;
      created = false;
    }
    const revived = this.#activateMapping(row);
    if (revived.ok !== true) return revived;
    return { ok: true, created, duplicate: !created, mapping: revived.mapping, context: trusted };
  }

  /**
   * 把既有映射的核心 Task/Step 恢复到 RUNNING（被 DENY/超时收敛为 BLOCKED 后，同一 dx 步骤重试时可复用）。
   * 绝不创建新行；不可恢复时显式 CORE_NOT_ACTIVATABLE（fail closed）。
   */
  #activateMapping(row) {
    const mapping = this.#safeMapping(row);
    const task = this.taskStore.taskById(mapping.coreTaskId);
    const step = this.taskStore.stepById(mapping.coreStepId);
    const run = this.taskStore.harnessRunById(mapping.coreRunId);
    if (!task || !step || !run || String(step.task_id) !== String(task.task_id) || String(run.task_id) !== String(task.task_id)) {
      return { ok: false, error: BRIDGE_ERROR.MAPPING_DANGLING, detail: mapping.coreTaskId };
    }
    const now = this.#now();
    this.identity.transactSync(() => {
      const freshTask = this.taskStore.taskById(mapping.coreTaskId);
      if (freshTask && String(freshTask.status) !== TASK_STATUS.RUNNING && canTransitionTask(freshTask.status, TASK_STATUS.RUNNING)) {
        this.taskStore.updateTask(mapping.coreTaskId, { status: TASK_STATUS.RUNNING, started_at: freshTask.started_at == null ? now : freshTask.started_at, updated_at: now, revision: Number(freshTask.revision || 1) + 1 });
      }
      const freshStep = this.taskStore.stepById(mapping.coreStepId);
      if (freshStep && String(freshStep.status) !== STEP_STATUS.RUNNING && canTransitionStep(freshStep.status, STEP_STATUS.RUNNING)) {
        this.taskStore.updateStep(mapping.coreStepId, { status: STEP_STATUS.RUNNING, started_at: now, completed_at: null });
      }
    });
    const afterTask = this.taskStore.taskById(mapping.coreTaskId);
    const afterStep = this.taskStore.stepById(mapping.coreStepId);
    if (!afterTask || String(afterTask.status) !== TASK_STATUS.RUNNING || !afterStep || String(afterStep.status) !== STEP_STATUS.RUNNING) {
      return { ok: false, error: BRIDGE_ERROR.CORE_NOT_ACTIVATABLE, detail: String((afterTask && afterTask.status) || "?") + "/" + String((afterStep && afterStep.status) || "?") };
    }
    return { ok: true, mapping };
  }
}

function createDxTaskApprovalBridge(options = {}) {
  return new DxTaskApprovalBridge(options);
}

/**
 * 任务内 MCP 审批端口（agent 工具循环的装配点）。
 *
 * 入参 taskId 若是 dx 任务 → 桥幂等映射出核心 Task/Step/Run 后调用**既有**
 * createSideEffectExecutionPort（proposeWrite → trusted approval → lease/claim/verify）；
 * 若已是核心任务（mcp/toolInvocation/call 路径）→ 原样透传，保持既有语义不变。
 */
function createDxBridgedApprovalPort({ bridge, runtime, taskId = null, stepId = null, runId = null, toolIdFor, toolVersionFor = null, approvalTimeoutMs = null } = {}) {
  const inner = createSideEffectExecutionPort({ runtime, toolIdFor, toolVersionFor, approvalTimeoutMs });
  const denied = (reasonCode, detail = null) => ({ decisionStatus: DECISION_STATUS.DENIED, reasonCode, detail });
  return {
    kind: "dx-task-approval-bridge",
    async authorize(payload = {}) {
      if (!bridge || typeof bridge.ensureCoreApprovalTask !== "function") return denied(BRIDGE_ERROR.UNAVAILABLE);
      const requested = payload.taskId != null && String(payload.taskId) !== "" ? String(payload.taskId) : (taskId ? String(taskId) : null);
      if (!requested) return denied(BRIDGE_ERROR.INVALID_INPUT, "缺少 taskId");
      if (typeof bridge.isCoreTaskId === "function" && bridge.isCoreTaskId(requested)) return await inner.authorize({ ...payload, taskId: requested });
      const importStepId = payload.stepId != null && String(payload.stepId) !== "" ? payload.stepId : stepId;
      const importRunId = payload.runId != null && String(payload.runId) !== "" ? payload.runId : runId;
      const ensured = bridge.ensureCoreApprovalTask({ dxTaskId: requested, dxStepId: importStepId, dxRunId: importRunId, context: bridge.trustedContext() });
      if (!ensured || ensured.ok !== true) return denied((ensured && ensured.error) || BRIDGE_ERROR.UNAVAILABLE, ensured && ensured.detail ? ensured.detail : null);
      return await inner.authorize({
        ...payload,
        taskId: ensured.mapping.coreTaskId,
        stepId: ensured.mapping.coreStepId,
        runId: ensured.mapping.coreRunId,
        context: ensured.context,
      });
    },
  };
}

module.exports = { DxTaskApprovalBridge, createDxTaskApprovalBridge, createDxBridgedApprovalPort, BRIDGE_ERROR, BRIDGE_HARNESS_VERSION };
