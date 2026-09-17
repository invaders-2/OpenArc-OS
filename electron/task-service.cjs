/**
 * D4-02A · Task Service —— 唯一 Task Domain Command 出口。
 *
 * 永久边界：**OpenArc = Task Authority，Harness = Reasoning Runtime**。
 * Harness 只拿 capability 与安全 snapshot；task queue / state / step / retry /
 * lease / permission authority 永远在 OpenArc。
 *
 * actor session/user/app 一律由可信宿主注入的 context + D3 Authorization 解析，
 * 忽略任何 payload 自报的 userId / role / appId。
 */
"use strict";
const crypto = require("node:crypto");
const domain = require("./task-domain.cjs");
const { safeTask, safeStep, safeCall, safeEvent, sanitizeEventPayload } = domain;
const {
  TASK_STATUS, STEP_STATUS, TASK_EVENT, ERROR, DEFAULT_MAX_ATTEMPTS, AUTO_RETRY, TOOL_EXECUTION,
  HARNESS_RUN_STATUS, HARNESS_RUN_TERMINAL, ARTIFACT_TYPE, ARTIFACT_TYPE_ALL, VERIFICATION_TYPE, VERIFICATION_STATUS,
  BUDGET_BASE, RESUME_GRANT_AMOUNT, MAX_BUDGET_RESUMES, RESUME_REASON, ORCHESTRATION_KIND,
  canTransitionTask, canTransitionStep, isKnownEventType,
} = domain;

/** Task Runtime 内部产物序列化：绝不回传 raw row。 */
function safeRun(row) {
  if (!row) return null;
  return { runId: row.run_id, taskId: row.task_id, stepId: row.step_id || null, status: row.status, harnessVersion: row.harness_version || null, acpVersion: row.acp_version || null, modelConfigId: row.model_config_id || null, modelConfigVersion: row.model_config_version == null ? null : row.model_config_version, startedAt: row.started_at, completedAt: row.completed_at == null ? null : row.completed_at, stopReason: row.stop_reason || null, errorCode: row.error_code || null };
}
function safeArtifact(row) {
  if (!row) return null;
  return { artifactId: row.artifact_id, taskId: row.task_id, stepId: row.step_id || null, runId: row.run_id || null, type: row.type, content: parseMaybeJson(row.safe_content), checksum: row.checksum || null, createdAt: row.created_at };
}
function safeVerification(row) {
  if (!row) return null;
  return { verificationId: row.verification_id, artifactId: row.artifact_id, taskId: row.task_id, type: row.type, status: row.status, details: parseMaybeJson(row.safe_details), createdAt: row.created_at };
}
function parseMaybeJson(text) { if (text == null) return null; try { return JSON.parse(text); } catch { return text; } }

class TaskService {
  constructor({ identity, authService, authStore, taskStore, toolStore = null, sideEffectStore = null, modelService = null, clock = null, logger = null, hooks = null } = {}) {
    if (!identity) throw new Error("TaskService 需要 IdentityStore");
    if (!authService || !authStore) throw new Error("TaskService 需要 D3 Authorization");
    if (!taskStore) throw new Error("TaskService 需要 TaskStore");
    this.identity = identity;
    this.authService = authService;
    this.authStore = authStore;
    this.store = taskStore;
    // D4-06 Closure：只读领域账本（tool executions / side-effect calls / leases），
    // 用于 resume eligibility 与 budget ledger。late attach 见 attachBudgetStores。
    this.toolStore = toolStore;
    this.sideEffectStore = sideEffectStore;
    this.modelService = modelService;
    this.clock = typeof clock === "function" ? clock : identity.clock;
    this.logger = logger;
    this.hooks = hooks || {};
  }
  #now() { return this.clock(); }
  #actor(context) { return this.authService.resolveActor({ context }); }

  /** 可信 context → actor + enabled App。payload 自报一律无效。 */
  #guard(context) {
    const actor = this.#actor(context);
    if (!actor || !actor.ok) return { ok: false, error: ERROR.TASK_FORBIDDEN };
    const appId = context && context.appId ? String(context.appId) : null;
    if (!appId) return { ok: false, error: ERROR.TASK_FORBIDDEN };
    const app = this.authStore.appById(appId);
    if (!app || String(app.status).toLowerCase() !== "enabled") return { ok: false, error: ERROR.TASK_FORBIDDEN };
    return { ok: true, actor, appId };
  }
  /** Personal Task：owner + 创建它的 App 才能访问。 */
  #access(guard, task) {
    if (!task) return { ok: false, error: ERROR.TASK_NOT_FOUND };
    if (task.user_id !== guard.actor.user.id) return { ok: false, error: ERROR.TASK_FORBIDDEN };
    if (task.app_id !== guard.appId) return { ok: false, error: ERROR.TASK_FORBIDDEN };
    return { ok: true };
  }
  #conflict(task, expectedRevision) {
    if (expectedRevision == null) return { ok: false, error: ERROR.INVALID_INPUT, detail: "expectedRevision is required" };
    if (Number(expectedRevision) !== Number(task.revision)) return { ok: false, error: ERROR.TASK_REVISION_CONFLICT, expected: Number(expectedRevision), current: task.revision };
    return null;
  }
  #audit(guard, context, action, taskId) {
    try {
      this.authStore.auditAuthorization({ actorUserId: guard.actor.user.id, targetUserId: null, appId: guard.appId, departmentId: null, resourceRef: taskId, action, decision: "ALLOW", reasonCode: "ALLOW", permissionSource: "USER", oldPermissions: [], newPermissions: [] });
    } catch { /* audit 失败不改变业务结果 */ }
  }
  #load(guard, taskId) {
    const task = this.store.taskById(taskId);
    if (!task) return { ok: false, error: ERROR.TASK_NOT_FOUND };
    const access = this.#access(guard, task);
    if (!access.ok) return access;
    return { ok: true, task };
  }

  /** D4-06 Closure：late attach 只读账本 store（bootstrap / 测试夹具在装配完成后注入）。 */
  attachBudgetStores({ toolStore = null, sideEffectStore = null } = {}) {
    if (toolStore) this.toolStore = toolStore;
    if (sideEffectStore) this.sideEffectStore = sideEffectStore;
    return { ok: true };
  }

  // ------------------------------------------------------------------ Task
  createTask({ context, goal, modelConfigId = null, modelConfigVersion = null, budgetSnapshot = null, permissionSnapshotRef = null } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const g = typeof goal === "string" ? goal.trim() : "";
    if (!g) return { ok: false, error: ERROR.INVALID_INPUT, detail: "goal is required" };
    let frozenVersion = modelConfigVersion == null ? null : Number(modelConfigVersion);
    if (modelConfigId && this.modelService) {
      const resolved = this.modelService.resolveModel({ context, configId: modelConfigId });
      if (!resolved.ok) return resolved;
      frozenVersion = resolved.snapshot.modelConfigVersion;
    }
    const now = this.#now();
    return this.store.transactSync(() => {
      const task = this.store.insertTask({ userId: guard.actor.user.id, sessionRef: context.sessionRef || null, appId: guard.appId, status: TASK_STATUS.PENDING, goal: g, createdAt: now, updatedAt: now, modelConfigId, modelConfigVersion: frozenVersion, budgetSnapshot, permissionSnapshotRef });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_CREATED, safePayload: sanitizeEventPayload({ goal: g, modelConfigId: modelConfigId || null, modelConfigVersion: frozenVersion }), at: now });
      this.#audit(guard, context, "task.create", task.task_id);
      return { ok: true, task: safeTask(task) };
    });
  }

  startTask({ context, taskId, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      if (task.cancel_requested) return { ok: false, error: ERROR.TASK_CANCELLED };
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      if (!canTransitionTask(task.status, TASK_STATUS.RUNNING)) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: task.status, to: TASK_STATUS.RUNNING };
      const now = this.#now();
      const updated = this.store.updateTask(task.task_id, { status: TASK_STATUS.RUNNING, started_at: task.started_at == null ? now : task.started_at, updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_STARTED, safePayload: sanitizeEventPayload({ revision: updated.revision }), at: now });
      this.#audit(guard, context, "task.start", task.task_id);
      return { ok: true, task: safeTask(updated) };
    });
  }

  cancelTask({ context, taskId, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      if (task.status === TASK_STATUS.CANCELLED) return { ok: true, changed: false, task: safeTask(task) };
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      if (!canTransitionTask(task.status, TASK_STATUS.CANCELLED)) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: task.status, to: TASK_STATUS.CANCELLED };
      const now = this.#now();
      const updated = this.store.updateTask(task.task_id, { status: TASK_STATUS.CANCELLED, cancel_requested: 1, completed_at: now, updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_CANCEL_REQUESTED, safePayload: sanitizeEventPayload({ cancelRequested: true }), at: now });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_CANCELLED, safePayload: sanitizeEventPayload({ revision: updated.revision }), at: now });
      this.#audit(guard, context, "task.cancel", task.task_id);
      return { ok: true, changed: true, task: safeTask(updated) };
    });
  }

  completeTask({ context, taskId, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      if (!canTransitionTask(task.status, TASK_STATUS.SUCCEEDED)) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: task.status, to: TASK_STATUS.SUCCEEDED };
      const now = this.#now();
      const updated = this.store.updateTask(task.task_id, { status: TASK_STATUS.SUCCEEDED, completed_at: now, updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_SUCCEEDED, safePayload: sanitizeEventPayload({ revision: updated.revision }), at: now });
      this.#audit(guard, context, "task.complete", task.task_id);
      return { ok: true, task: safeTask(updated) };
    });
  }

  failTask({ context, taskId, errorCode = null, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      if (!canTransitionTask(task.status, TASK_STATUS.FAILED)) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: task.status, to: TASK_STATUS.FAILED };
      const now = this.#now();
      const updated = this.store.updateTask(task.task_id, { status: TASK_STATUS.FAILED, completed_at: now, updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_FAILED, safePayload: sanitizeEventPayload({ errorCode: errorCode || null }), at: now });
      this.#audit(guard, context, "task.fail", task.task_id);
      return { ok: true, task: safeTask(updated) };
    });
  }

  // ------------------------------------------------------------------ Step
  createStep({ context, taskId, kind = "model", input = null, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const k = typeof kind === "string" ? kind.trim() : "";
    if (!k) return { ok: false, error: ERROR.INVALID_INPUT, detail: "kind is required" };
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      if (task.cancel_requested) return { ok: false, error: ERROR.TASK_CANCELLED };
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      if (task.status !== TASK_STATUS.RUNNING && task.status !== TASK_STATUS.WAITING) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: task.status, to: "STEP_CREATED" };
      const now = this.#now();
      const seq = this.store.nextStepSequence(task.task_id);
      const step = this.store.insertStep({ taskId: task.task_id, sequence: seq, kind: k, status: STEP_STATUS.PENDING, input, attempt: 1, maxAttempts: DEFAULT_MAX_ATTEMPTS });
      const updated = this.store.updateTask(task.task_id, { updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.STEP_CREATED, safePayload: sanitizeEventPayload({ stepId: step.step_id, sequence: seq, kind: k, maxAttempts: DEFAULT_MAX_ATTEMPTS }), at: now });
      return { ok: true, step: safeStep(step), task: safeTask(updated) };
    });
  }

  #stepCommand({ context, taskId, stepId, expectedRevision, from, to, event, patch = () => ({}) }) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      const step = this.store.stepById(stepId);
      if (!step || step.task_id !== task.task_id) return { ok: false, error: ERROR.TASK_NOT_FOUND };
      if (!canTransitionStep(step.status, to)) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: step.status, to };
      const now = this.#now();
      const updatedStep = this.store.updateStep(step.step_id, patch({ now, step, task }));
      const taskPatch = { updated_at: now, revision: task.revision + 1 };
      if (to === STEP_STATUS.RUNNING) taskPatch.current_step_id = step.step_id;
      if (to === STEP_STATUS.SUCCEEDED || to === STEP_STATUS.FAILED || to === STEP_STATUS.CANCELLED) { if (task.current_step_id === step.step_id) taskPatch.current_step_id = null; }
      const updatedTask = this.store.updateTask(task.task_id, taskPatch);
      this.store.appendEvent({ taskId: task.task_id, eventType: event, safePayload: sanitizeEventPayload({ stepId: step.step_id, sequence: step.sequence }), at: now });
      return { ok: true, step: safeStep(updatedStep), task: safeTask(updatedTask) };
    });
  }
  startStep({ context, taskId, stepId, expectedRevision } = {}) {
    return this.#stepCommand({ context, taskId, stepId, expectedRevision, to: STEP_STATUS.RUNNING, event: TASK_EVENT.STEP_STARTED, patch: ({ now }) => ({ status: STEP_STATUS.RUNNING, started_at: now }) });
  }
  completeStep({ context, taskId, stepId, outputRef = null, expectedRevision } = {}) {
    return this.#stepCommand({ context, taskId, stepId, expectedRevision, to: STEP_STATUS.SUCCEEDED, event: TASK_EVENT.STEP_SUCCEEDED, patch: ({ now }) => ({ status: STEP_STATUS.SUCCEEDED, completed_at: now, output_ref: outputRef }) });
  }
  failStep({ context, taskId, stepId, errorCode = null, expectedRevision } = {}) {
    void errorCode;
    return this.#stepCommand({ context, taskId, stepId, expectedRevision, to: STEP_STATUS.FAILED, event: TASK_EVENT.STEP_FAILED, patch: ({ now }) => ({ status: STEP_STATUS.FAILED, completed_at: now }) });
  }

  // ------------------------------------------------------------- Model call
  startModelCall({ context, taskId, stepId = null, requestId = null, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      if (task.cancel_requested) return { ok: false, error: ERROR.TASK_CANCELLED };
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      if (task.status !== TASK_STATUS.RUNNING) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: task.status, to: "MODEL_CALL_STARTED" };
      // 调用时重新 authorize + 重新检查 model/provider status；snapshot 变化不静默升级。
      if (this.modelService && task.model_config_id) {
        const resolved = this.modelService.resolveModel({ context, configId: task.model_config_id });
        if (!resolved.ok) return resolved;
        if (resolved.snapshot.modelConfigVersion !== task.model_config_version) {
          return { ok: false, error: ERROR.MODEL_CONFIG_CHANGED, expected: task.model_config_version, current: resolved.snapshot.modelConfigVersion };
        }
      }
      const now = this.#now();
      const call = this.store.insertCall({ taskId: task.task_id, stepId, modelConfigId: task.model_config_id, modelConfigVersion: task.model_config_version, requestId, status: "STARTED", startedAt: now });
      const updated = this.store.updateTask(task.task_id, { updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.MODEL_CALL_STARTED, safePayload: sanitizeEventPayload({ callId: call.call_id, stepId, requestId, modelConfigVersion: task.model_config_version }), at: now });
      return { ok: true, call: safeCall(call), task: safeTask(updated) };
    });
  }

  #callCommand({ context, taskId, callId, expectedRevision, to, event, patch = () => ({}) }) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      const call = this.store.callById(callId);
      if (!call || call.task_id !== task.task_id) return { ok: false, error: ERROR.TASK_NOT_FOUND };
      if (call.status !== "STARTED") return { ok: false, error: ERROR.TASK_INVALID_STATE, from: call.status, to };
      const now = this.#now();
      const updatedCall = this.store.updateCall(call.call_id, patch({ now, call }));
      const updatedTask = this.store.updateTask(task.task_id, { updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: event, safePayload: sanitizeEventPayload({ callId: call.call_id, status: to }), at: now });
      return { ok: true, call: safeCall(updatedCall), task: safeTask(updatedTask) };
    });
  }
  completeModelCall({ context, taskId, callId, usage = null, requestId = null, expectedRevision } = {}) {
    return this.#callCommand({ context, taskId, callId, expectedRevision, to: "SUCCEEDED", event: TASK_EVENT.MODEL_CALL_COMPLETED, patch: ({ now }) => Object.assign({ status: "SUCCEEDED", completed_at: now, usage: usage == null ? null : usage }, requestId ? { request_id: requestId } : {}) });
  }
  /** 失败只落一条 FAILED call；AUTO_RETRY = 0，绝不自动创建新 call。 */
  failModelCall({ context, taskId, callId, providerErrorCode = null, requestId = null, expectedRevision } = {}) {
    return this.#callCommand({ context, taskId, callId, expectedRevision, to: "FAILED", event: TASK_EVENT.MODEL_CALL_FAILED, patch: ({ now }) => Object.assign({ status: "FAILED", completed_at: now, provider_error_code: providerErrorCode }, requestId ? { request_id: requestId } : {}) });
  }

  // ------------------------------------------------------------------ Read
  getTask({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return { ok: true, task: safeTask(load.task) };
  }
  listTasks({ context } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return { ok: true, items: this.store.tasksByUser(guard.actor.user.id, guard.appId).map(safeTask) };
  }
  getSteps({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return { ok: true, items: this.store.stepsOfTask(taskId).map(safeStep) };
  }
  getEvents({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return { ok: true, items: this.store.eventsOfTask(taskId).map(safeEvent) };
  }
  getCalls({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return { ok: true, items: this.store.callsOfTask(taskId).map(safeCall) };
  }

  /**
   * 启动恢复：重启前 RUNNING 的 Task/Step 不能假装继续执行。
   * 一律转 BLOCKED + RECOVERY_REQUIRED，并落 TaskEvent；0 自动 replay / 0 retry。
   */
  recoverRunning() {
    const ids = [];
    for (const t of this.store.allTasks()) {
      if (t.status !== TASK_STATUS.RUNNING) continue;
      this.store.transactSync(() => {
        const now = this.#now();
        for (const s of this.store.stepsOfTask(t.task_id)) {
          if (s.status === STEP_STATUS.RUNNING) {
            this.store.updateStep(s.step_id, { status: STEP_STATUS.BLOCKED, completed_at: now });
            this.store.appendEvent({ taskId: t.task_id, eventType: TASK_EVENT.STEP_RECOVERY_BLOCKED, safePayload: sanitizeEventPayload({ stepId: s.step_id, reason: ERROR.RECOVERY_REQUIRED }), at: now });
          }
        }
        // §43/§44/§45：重启前未收尾的 Harness Run 一律 UNKNOWN EFFECT → BLOCK，绝不 replay。
        for (const r of this.store.harnessRunsOfTask(t.task_id)) {
          if (HARNESS_RUN_TERMINAL.includes(r.status)) continue;
          this.store.updateHarnessRun(r.run_id, { status: HARNESS_RUN_STATUS.BLOCKED, completed_at: now, stop_reason: "RECOVERY_REQUIRED", error_code: ERROR.RECOVERY_REQUIRED });
          this.store.appendEvent({ taskId: t.task_id, eventType: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT, safePayload: sanitizeEventPayload({ runId: r.run_id, stepId: r.step_id, reason: ERROR.RECOVERY_REQUIRED }), at: now });
        }
        const fresh = this.store.taskById(t.task_id);
        this.store.updateTask(t.task_id, { status: TASK_STATUS.BLOCKED, updated_at: now, revision: fresh.revision + 1 });
        this.store.appendEvent({ taskId: t.task_id, eventType: TASK_EVENT.TASK_RECOVERY_BLOCKED, safePayload: sanitizeEventPayload({ reason: ERROR.RECOVERY_REQUIRED, cancelRequested: !!fresh.cancel_requested }), at: now });
      });
      ids.push(t.task_id);
    }
    return { ok: true, recovered: ids.length, taskIds: ids };
  }


  // -------------------------------------------- D4-02C Harness Run / Artifact / Verification
  /** 每次 Harness invocation 一条 run；绑定 task/step/revision/modelConfig/session。*/
  startHarnessRun({ context, taskId, stepId = null, modelConfigId = null, modelConfigVersion = null, harnessVersion = null, acpVersion = null, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      if (task.cancel_requested) return { ok: false, error: ERROR.TASK_CANCELLED };
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      if (task.status !== TASK_STATUS.RUNNING) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: task.status, to: "HARNESS_RUN_STARTED" };
      if (stepId) {
        const step = this.store.stepById(stepId);
        if (!step || step.task_id !== task.task_id) return { ok: false, error: ERROR.TASK_NOT_FOUND };
        if (step.status !== STEP_STATUS.RUNNING) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: step.status, to: "HARNESS_RUN_STARTED" };
      }
      const now = this.#now();
      const run = this.store.insertHarnessRun({ taskId: task.task_id, stepId, status: HARNESS_RUN_STATUS.STARTING, harnessVersion, acpVersion, modelConfigId: modelConfigId || task.model_config_id, modelConfigVersion: modelConfigVersion == null ? task.model_config_version : modelConfigVersion, startedAt: now });
      const updated = this.store.updateTask(task.task_id, { updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.HARNESS_RUN_STARTED, safePayload: sanitizeEventPayload({ runId: run.run_id, stepId, harnessVersion, acpVersion, modelConfigId: run.model_config_id, modelConfigVersion: run.model_config_version }), at: now });
      return { ok: true, run: safeRun(run), task: safeTask(updated) };
    });
  }

  #runTransition({ context, taskId, runId, expectedRevision, to, event = null, stopReason = null, errorCode = null } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      const run = this.store.harnessRunById(runId);
      if (!run || run.task_id !== task.task_id) return { ok: false, error: ERROR.TASK_NOT_FOUND };
      if (run.status === to) return { ok: true, changed: false, run: safeRun(run), task: safeTask(task) };
      if (HARNESS_RUN_TERMINAL.includes(run.status)) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: run.status, to };
      const now = this.#now();
      const patch = { status: to };
      if (HARNESS_RUN_TERMINAL.includes(to)) patch.completed_at = now;
      if (stopReason != null) patch.stop_reason = stopReason;
      if (errorCode != null) patch.error_code = errorCode;
      const updatedRun = this.store.updateHarnessRun(run.run_id, patch);
      const updatedTask = this.store.updateTask(task.task_id, { updated_at: now, revision: task.revision + 1 });
      if (event) this.store.appendEvent({ taskId: task.task_id, eventType: event, safePayload: sanitizeEventPayload({ runId: run.run_id, stepId: run.step_id, status: to, stopReason, errorCode }), at: now });
      return { ok: true, changed: true, run: safeRun(updatedRun), task: safeTask(updatedTask) };
    });
  }
  markHarnessRunRunning({ context, taskId, runId, expectedRevision } = {}) { return this.#runTransition({ context, taskId, runId, expectedRevision, to: HARNESS_RUN_STATUS.RUNNING }); }
  completeHarnessRun({ context, taskId, runId, stopReason = null, expectedRevision } = {}) { return this.#runTransition({ context, taskId, runId, expectedRevision, to: HARNESS_RUN_STATUS.SUCCEEDED, event: TASK_EVENT.HARNESS_RUN_SUCCEEDED, stopReason }); }
  blockHarnessRun({ context, taskId, runId, errorCode = null, stopReason = null, expectedRevision } = {}) { return this.#runTransition({ context, taskId, runId, expectedRevision, to: HARNESS_RUN_STATUS.BLOCKED, event: TASK_EVENT.HARNESS_RUN_BLOCKED, stopReason, errorCode }); }
  cancelHarnessRun({ context, taskId, runId, expectedRevision } = {}) { return this.#runTransition({ context, taskId, runId, expectedRevision, to: HARNESS_RUN_STATUS.CANCELLED }); }

  /** ACP → TaskEvent 已由 Orchestrator 显式映射；这里只做长度上限 + 敏感 key 打码的批量追加。*/
  recordHarnessEvents({ context, taskId, runId = null, events = [], expectedRevision, maxEvents = 128 } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const cap = Math.max(0, Number(maxEvents) || 0);
    const list = Array.isArray(events) ? events.slice(0, cap) : [];
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      const now = this.#now();
      const out = [];
      for (const e of list) {
        if (!e || !isKnownEventType(e.eventType)) continue;
        out.push(safeEvent(this.store.appendEvent({ taskId: task.task_id, eventType: String(e.eventType), safePayload: sanitizeEventPayload(e.safePayload == null ? { runId } : Object.assign({ runId }, e.safePayload)), at: now })));
      }
      const updated = this.store.updateTask(task.task_id, { updated_at: now, revision: task.revision + 1 });
      return { ok: true, added: out.length, events: out, task: safeTask(updated) };
    });
  }

  /** Step BLOCKED：仅 Orchestrator 在 crash/timeout/tool/permission/authz 下调用。*/
  blockStep({ context, taskId, stepId, runId = null, reason = null, event = null, payload = null, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      const step = this.store.stepById(stepId);
      if (!step || step.task_id !== task.task_id) return { ok: false, error: ERROR.TASK_NOT_FOUND };
      const now = this.#now();
      let updatedStep = step;
      if (step.status === STEP_STATUS.BLOCKED) { /* idempotent */ }
      else if (canTransitionStep(step.status, STEP_STATUS.BLOCKED)) updatedStep = this.store.updateStep(step.step_id, { status: STEP_STATUS.BLOCKED, completed_at: now });
      else return { ok: false, error: ERROR.TASK_INVALID_STATE, from: step.status, to: STEP_STATUS.BLOCKED };
      if (event) this.store.appendEvent({ taskId: task.task_id, eventType: event, safePayload: sanitizeEventPayload(Object.assign({ stepId: step.step_id, runId, reason }, payload || {})), at: now });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.STEP_BLOCKED, safePayload: sanitizeEventPayload({ stepId: step.step_id, reason }), at: now });
      const taskPatch = { updated_at: now, revision: task.revision + 1 };
      if (task.current_step_id === step.step_id) taskPatch.current_step_id = null;
      let blockedTask = false;
      if (task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.WAITING || task.status === TASK_STATUS.PENDING) { taskPatch.status = TASK_STATUS.BLOCKED; blockedTask = true; }
      const updatedTask = this.store.updateTask(task.task_id, taskPatch);
      if (blockedTask) this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_BLOCKED, safePayload: sanitizeEventPayload({ reason, stepId: step.step_id }), at: now });
      return { ok: true, step: safeStep(updatedStep), task: safeTask(updatedTask) };
    });
  }

  /** D4-03A：Tool 需要审批 → Step BLOCKED + Task WAITING（比 BLOCKED 语义更准确）。*/
  waitForApproval({ context, taskId, stepId, runId = null, reason = null, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      const step = this.store.stepById(stepId);
      if (!step || step.task_id !== task.task_id) return { ok: false, error: ERROR.TASK_NOT_FOUND };
      const now = this.#now();
      let updatedStep = step;
      if (step.status === STEP_STATUS.BLOCKED) { /* idempotent */ }
      else if (canTransitionStep(step.status, STEP_STATUS.BLOCKED)) updatedStep = this.store.updateStep(step.step_id, { status: STEP_STATUS.BLOCKED, completed_at: now });
      else return { ok: false, error: ERROR.TASK_INVALID_STATE, from: step.status, to: STEP_STATUS.BLOCKED };
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TOOL_APPROVAL_REQUIRED, safePayload: sanitizeEventPayload({ stepId: step.step_id, runId, reason }), at: now });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.STEP_BLOCKED, safePayload: sanitizeEventPayload({ stepId: step.step_id, reason }), at: now });
      const taskPatch = { updated_at: now, revision: task.revision + 1 };
      if (task.current_step_id === step.step_id) taskPatch.current_step_id = null;
      let waiting = false;
      if (canTransitionTask(task.status, TASK_STATUS.WAITING)) { taskPatch.status = TASK_STATUS.WAITING; waiting = true; }
      const updatedTask = this.store.updateTask(task.task_id, taskPatch);
      if (waiting) this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_WAITING, safePayload: sanitizeEventPayload({ reason, stepId: step.step_id }), at: now });
      return { ok: true, step: safeStep(updatedStep), task: safeTask(updatedTask) };
    });
  }

  /** 两阶段 cancel：先持久 cancel_requested=1（供 race 判定），再 finalize。*/
  requestCancel({ context, taskId, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      if (task.cancel_requested) return { ok: true, changed: false, task: safeTask(task) };
      const now = this.#now();
      const updated = this.store.updateTask(task.task_id, { cancel_requested: 1, updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_CANCEL_REQUESTED, safePayload: sanitizeEventPayload({ cancelRequested: true }), at: now });
      this.#audit(guard, context, "task.cancel", task.task_id);
      return { ok: true, changed: true, task: safeTask(updated) };
    });
  }

  finalizeCancel({ context, taskId, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      const now = this.#now();
      let rev = task.revision;
      let stepChanged = false;
      for (const s of this.store.stepsOfTask(task.task_id)) {
        if (s.status === STEP_STATUS.RUNNING || s.status === STEP_STATUS.PENDING) {
          this.store.updateStep(s.step_id, { status: STEP_STATUS.CANCELLED, completed_at: now });
          this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.STEP_CANCELLED, safePayload: sanitizeEventPayload({ stepId: s.step_id, reason: ERROR.TASK_CANCELLED }), at: now });
          stepChanged = true;
        }
      }
      if (task.status === TASK_STATUS.CANCELLED) return { ok: true, changed: stepChanged, task: safeTask(task) };
      if (!canTransitionTask(task.status, TASK_STATUS.CANCELLED)) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: task.status, to: TASK_STATUS.CANCELLED };
      const updated = this.store.updateTask(task.task_id, { status: TASK_STATUS.CANCELLED, cancel_requested: 1, completed_at: now, updated_at: now, current_step_id: null, revision: rev + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_CANCELLED, safePayload: sanitizeEventPayload({ revision: updated.revision }), at: now });
      this.#audit(guard, context, "task.cancelFinalize", task.task_id);
      return { ok: true, changed: true, task: safeTask(updated) };
    });
  }

  // -------------------------------------------- D4-06 Closure 预算续接（唯一解禁场景）
  #budgetEvents(taskId, eventType) {
    return this.store.eventsOfTask(taskId).filter((e) => e.event_type === eventType).map((e) => {
      let payload = null;
      try { payload = e.safe_payload ? JSON.parse(e.safe_payload) : null; } catch { payload = null; }
      return Object.assign({ eventId: e.event_id, at: e.created_at }, payload || {});
    });
  }
  #budgetGrantEvents(taskId) { return this.#budgetEvents(taskId, TASK_EVENT.TASK_BUDGET_GRANTED); }
  #budgetExhaustEvents(taskId) { return this.#budgetEvents(taskId, TASK_EVENT.TASK_BUDGET_EXHAUSTED); }

  /**
   * D4-06 Closure 后端可续接判定（不信 renderer）。
   * 只有「BLOCKED + last run error_code=BUDGET_EXHAUSTED + 无未决副作用/UNKNOWN_EFFECT/active lease
   * + 存在可续接的已完成产物 + 未达续接上限」才 resumable。其余一律带显式 reason 拒绝。
   */
  #resumeAssessment(task) {
    const base = {
      resumable: false, reason: null, stopReason: null, kind: null,
      fromStepId: null, fromRunId: null,
      resumeIndex: 1, resumeCount: 0, maxResumes: MAX_BUDGET_RESUMES, remainingResumes: MAX_BUDGET_RESUMES,
    };
    if (!task) return Object.assign(base, { reason: RESUME_REASON.NOT_BLOCKED });
    const runs = this.store.harnessRunsOfTask(task.task_id);
    const steps = this.store.stepsOfTask(task.task_id);
    const grants = this.#budgetGrantEvents(task.task_id);
    const lastRun = runs.length ? runs[runs.length - 1] : null;
    const lastStep = steps.length ? steps[steps.length - 1] : null;
    base.resumeCount = grants.length;
    base.resumeIndex = grants.length + 1;
    base.remainingResumes = Math.max(0, MAX_BUDGET_RESUMES - grants.length);
    base.stopReason = lastRun ? (lastRun.error_code || lastRun.stop_reason || null) : null;
    base.fromStepId = lastStep ? lastStep.step_id : null;
    base.fromRunId = lastRun ? lastRun.run_id : null;

    if (task.cancel_requested) return Object.assign(base, { reason: RESUME_REASON.CANCELLED });
    if (task.status !== TASK_STATUS.BLOCKED) return Object.assign(base, { reason: RESUME_REASON.NOT_BLOCKED });
    if (runs.some((r) => r.status === HARNESS_RUN_STATUS.STARTING || r.status === HARNESS_RUN_STATUS.RUNNING)) return Object.assign(base, { reason: RESUME_REASON.IN_FLIGHT });
    if (steps.some((s) => s.status === STEP_STATUS.RUNNING || s.status === STEP_STATUS.PENDING)) return Object.assign(base, { reason: RESUME_REASON.IN_FLIGHT });
    // 安全优先：未决/未知副作用与 active lease 无条件阻断续接，先于停止原因判定。
    if (!this.sideEffectStore) return Object.assign(base, { reason: RESUME_REASON.EFFECT_STATE_UNAVAILABLE });
    const calls = this.sideEffectStore.callsOfTask(task.task_id);
    if (calls.some((c) => String(c.status) === "UNKNOWN_EFFECT")) return Object.assign(base, { reason: RESUME_REASON.UNKNOWN_EFFECT_PRESENT });
    if (calls.some((c) => ["AWAITING_APPROVAL", "APPROVED", "LEASED", "RUNNING"].includes(String(c.status)))) return Object.assign(base, { reason: RESUME_REASON.SIDE_EFFECT_PENDING });
    const callIds = new Set(calls.map((c) => c.callId));
    if (this.sideEffectStore.activeLeases().some((l) => callIds.has(l.callId))) return Object.assign(base, { reason: RESUME_REASON.ACTIVE_LEASE });

    if (!lastRun) return Object.assign(base, { reason: RESUME_REASON.NO_HARNESS_RUN });
    if (String(lastRun.error_code) !== ERROR.BUDGET_EXHAUSTED) return Object.assign(base, { reason: RESUME_REASON.NOT_BUDGET_STOP });
    const exhaust = this.#budgetExhaustEvents(task.task_id);
    const lastExhaust = exhaust.length ? exhaust[exhaust.length - 1] : null;
    base.kind = lastExhaust ? (lastExhaust.kind || null) : null;
    if (!base.kind || !RESUME_GRANT_AMOUNT[base.kind]) return Object.assign(base, { reason: RESUME_REASON.UNKNOWN_BUDGET_KIND });
    if (grants.length >= MAX_BUDGET_RESUMES) return Object.assign(base, { reason: RESUME_REASON.LIMIT_REACHED });
    if (!this.store.artifactsOfTask(task.task_id).length) return Object.assign(base, { reason: RESUME_REASON.NO_SAFE_CONTINUATION });

    base.resumable = true;
    return base;
  }

  getResumeEligibility({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return Object.assign({ ok: true, taskId: load.task.task_id }, this.#resumeAssessment(load.task));
  }

  /** 只读预算账本：base + additions + resumeCount + consumed（绝不更新/清零历史计数）。 */
  getBudgetLedger({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    const id = load.task.task_id;
    const assessment = this.#resumeAssessment(load.task);
    const additions = this.#budgetGrantEvents(id).map((g) => ({
      resumeIndex: g.resumeIndex == null ? null : g.resumeIndex, kind: g.kind || null, amount: g.amount == null ? null : g.amount,
      operatorUserId: g.operatorUserId || null, grantedAt: g.at, consumedAtGrant: g.consumedAtGrant || null,
    }));
    const budgetStops = this.#budgetExhaustEvents(id).map((s) => ({ kind: s.kind || null, consumed: s.consumed == null ? null : s.consumed, at: s.at }));
    return {
      ok: true,
      ledger: {
        taskId: id,
        base: Object.assign({}, BUDGET_BASE),
        additions,
        resumeCount: additions.length,
        maxResumes: MAX_BUDGET_RESUMES,
        remainingResumes: Math.max(0, MAX_BUDGET_RESUMES - additions.length),
        consumed: {
          modelCalls: this.store.callsOfTask(id).length,
          toolExecutions: this.toolStore ? this.toolStore.executionsOfTask(id).length : null,
          budgetStops,
        },
        nextGrant: assessment.resumable ? { kind: assessment.kind, amount: RESUME_GRANT_AMOUNT[assessment.kind] } : null,
        resumable: assessment.resumable,
        stopReason: assessment.stopReason,
        reason: assessment.reason,
      },
    };
  }

  /**
   * 原子追加一次 bounded 预算并开启续接 step：单事务内重新判定 → 写 budget.granted 账本
   * → 新建 reasoning step（携带 continuation 上下文，绝不携带旧 tool 请求）→ BLOCKED→RUNNING。
   * expectedRevision + 状态/在途守卫保证同一 task 只成功续接一次。
   */
  grantBudgetResume({ context, taskId, expectedRevision, kind = null, amount = null } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      if (task.cancel_requested) return { ok: false, error: ERROR.TASK_CANCELLED };
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      const assessment = this.#resumeAssessment(task);
      if (!assessment.resumable) return { ok: false, error: assessment.reason || "RESUME_NOT_ELIGIBLE", resumable: false, stopReason: assessment.stopReason || null };
      const useKind = kind || assessment.kind;
      if (!useKind || !RESUME_GRANT_AMOUNT[useKind] || (kind && kind !== assessment.kind)) return { ok: false, error: RESUME_REASON.UNKNOWN_BUDGET_KIND };

      const now = this.#now();
      const priorArtifacts = this.store.artifactsOfTask(task.task_id).slice(-3).map((a) => ({
        artifactId: a.artifact_id, type: a.type, content: String(a.safe_content == null ? "" : a.safe_content).slice(0, 2000),
      }));
      const continuation = {
        continuation: true,
        fromStepId: assessment.fromStepId, fromRunId: assessment.fromRunId,
        stopReason: ERROR.BUDGET_EXHAUSTED, budgetKind: useKind, resumeIndex: assessment.resumeIndex,
        priorArtifacts,
        instruction: "Continue from the verified prior results. Do not re-issue any previous tool request and do not repeat already completed operations.",
      };
      const sequence = this.store.nextStepSequence(task.task_id);
      const step = this.store.insertStep({ taskId: task.task_id, sequence, kind: ORCHESTRATION_KIND, status: STEP_STATUS.PENDING, input: continuation, attempt: 1, maxAttempts: DEFAULT_MAX_ATTEMPTS });
      const consumedAtGrant = {
        modelCalls: this.store.callsOfTask(task.task_id).length,
        toolExecutions: this.toolStore ? this.toolStore.executionsOfTask(task.task_id).length : null,
        budgetStops: this.#budgetExhaustEvents(task.task_id).length,
      };
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_BUDGET_GRANTED, at: now, safePayload: sanitizeEventPayload({ amount: Number(amount) || RESUME_GRANT_AMOUNT[useKind], operatorUserId: guard.actor.user.id, resumeIndex: assessment.resumeIndex, kind: useKind, consumedAtGrant }) });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.STEP_CREATED, at: now, safePayload: sanitizeEventPayload({ stepId: step.step_id, sequence, kind: ORCHESTRATION_KIND, maxAttempts: DEFAULT_MAX_ATTEMPTS, resumeIndex: assessment.resumeIndex }) });
      const updatedTask = this.store.updateTask(task.task_id, { status: TASK_STATUS.RUNNING, updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_STARTED, at: now, safePayload: sanitizeEventPayload({ revision: updatedTask.revision, resumed: true, resumeIndex: assessment.resumeIndex, kind: useKind }) });
      this.#audit(guard, context, "task.resume", task.task_id);
      return { ok: true, task: safeTask(updatedTask), step: safeStep(step), resumeIndex: assessment.resumeIndex, kind: useKind };
    });
  }

  /**
   * 原子提交 Step 成功：Artifact + Verification + Step + Task + Events 同一事务。
   * §82/§83/§84：Artifact 写入失败或 cancel 竞争时，绝不允许 Step/Task SUCCEEDED。
   */
  commitStepSuccess({ context, taskId, stepId, runId = null, artifact, verification, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    if (!artifact || !ARTIFACT_TYPE_ALL.includes(String(artifact.type))) return { ok: false, error: ERROR.INVALID_INPUT, detail: "artifact.type must be text|json" };
    if (!verification || verification.status !== VERIFICATION_STATUS.PASS) return { ok: false, error: ERROR.VERIFICATION_FAILED };
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      if (task.cancel_requested) return { ok: false, error: ERROR.TASK_CANCELLED };
      const step = this.store.stepById(stepId);
      if (!step || step.task_id !== task.task_id) return { ok: false, error: ERROR.TASK_NOT_FOUND };
      if (step.status !== STEP_STATUS.RUNNING) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: step.status, to: STEP_STATUS.SUCCEEDED };
      if (this.hooks.beforeArtifactInsert) this.hooks.beforeArtifactInsert({ taskId: task.task_id, stepId, runId });
      const now = this.#now();
      const content = typeof artifact.content === "string" ? artifact.content : JSON.stringify(artifact.content == null ? null : artifact.content);
      const checksum = artifact.checksum || crypto.createHash("sha256").update(content).digest("hex");
      const savedArtifact = this.store.insertArtifact({ taskId: task.task_id, stepId, runId, type: artifact.type, safeContent: content, checksum, createdAt: now });
      const savedVerification = this.store.insertVerification({ artifactId: savedArtifact.artifact_id, taskId: task.task_id, type: verification.type || VERIFICATION_TYPE.EXACT_TEXT, status: VERIFICATION_STATUS.PASS, safeDetails: verification.details || null, createdAt: now });
      const updatedStep = this.store.updateStep(step.step_id, { status: STEP_STATUS.SUCCEEDED, completed_at: now, output_ref: savedArtifact.artifact_id });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.ARTIFACT_CREATED, safePayload: sanitizeEventPayload({ artifactId: savedArtifact.artifact_id, stepId, runId, type: savedArtifact.type, checksum }), at: now });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.VERIFICATION_COMPLETED, safePayload: sanitizeEventPayload({ verificationId: savedVerification.verification_id, artifactId: savedArtifact.artifact_id, type: savedVerification.type, status: savedVerification.status }), at: now });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.STEP_SUCCEEDED, safePayload: sanitizeEventPayload({ stepId: step.step_id, sequence: step.sequence }), at: now });
      const remaining = this.store.stepsOfTask(task.task_id).filter((s) => s.step_id !== step.step_id && (s.status === STEP_STATUS.PENDING || s.status === STEP_STATUS.RUNNING));
      const taskPatch = { updated_at: now, revision: task.revision + 1 };
      if (task.current_step_id === step.step_id) taskPatch.current_step_id = null;
      let completedTask = false;
      if (remaining.length === 0 && canTransitionTask(task.status, TASK_STATUS.SUCCEEDED)) { taskPatch.status = TASK_STATUS.SUCCEEDED; taskPatch.completed_at = now; completedTask = true; }
      const updatedTask = this.store.updateTask(task.task_id, taskPatch);
      if (completedTask) this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_SUCCEEDED, safePayload: sanitizeEventPayload({ revision: updatedTask.revision }), at: now });
      return { ok: true, artifact: safeArtifact(savedArtifact), verification: safeVerification(savedVerification), step: safeStep(updatedStep), task: safeTask(updatedTask), completedTask };
    });
  }

  // ------------------------------------------------------- D4-02C Read（继承 Task ownership + App context）
  getHarnessRuns({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return { ok: true, items: this.store.harnessRunsOfTask(taskId).map(safeRun) };
  }
  getArtifacts({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return { ok: true, items: this.store.artifactsOfTask(taskId).map(safeArtifact) };
  }
  getVerifications({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return { ok: true, items: this.store.verificationsOfTask(taskId).map(safeVerification) };
  }

  // 供 ADR / 测试断言：第一版永久冻结
  static get policy() { return Object.freeze({ autoRetry: AUTO_RETRY, defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS, toolExecution: TOOL_EXECUTION }); }
}

module.exports = { TaskService };
