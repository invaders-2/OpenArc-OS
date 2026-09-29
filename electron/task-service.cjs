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
// D4-03 收口：证据投影路径去敏复用 tool-domain 单一来源（tool-domain 是叶子模块，无环）。
const toolDomain = require("./tool-domain.cjs");
const { safeTask, safeStep, safeCall, safeEvent, sanitizeEventPayload } = domain;
const {
  TASK_STATUS, STEP_STATUS, TASK_EVENT, ERROR, DEFAULT_MAX_ATTEMPTS, AUTO_RETRY, TOOL_EXECUTION,
  HARNESS_RUN_STATUS, HARNESS_RUN_TERMINAL, ARTIFACT_TYPE, ARTIFACT_TYPE_ALL, VERIFICATION_TYPE, VERIFICATION_STATUS,
  BUDGET_BASE, BUDGET_KIND, BUDGET_KIND_ALL, RESUME_GRANT_AMOUNT, MAX_BUDGET_RESUMES, RESUME_REASON, APPEND_REASON, ORCHESTRATION_KIND,
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
/** D4 收口：失败 Verification 的 safe projection（新列 step/run/execution + expected/actual）。 */
function safeVerification(row) {
  if (!row) return null;
  const details = parseMaybeJson(row.safe_details);
  const d = details && typeof details === "object" && !Array.isArray(details) ? details : {};
  const evidence = d.evidence && typeof d.evidence === "object" ? d.evidence : {};
  return {
    verificationId: row.verification_id,
    artifactId: row.artifact_id == null ? null : row.artifact_id,
    taskId: row.task_id,
    stepId: row.step_id == null ? null : row.step_id,
    runId: row.run_id == null ? null : row.run_id,
    executionId: row.execution_id == null ? (evidence.executionId == null ? null : evidence.executionId) : row.execution_id,
    type: row.type,
    status: row.status,
    method: d.method == null ? row.type : d.method,
    expected: d.expected === undefined ? null : d.expected,
    actual: d.actual === undefined ? null : d.actual,
    details,
    createdAt: row.created_at,
  };
}
function parseMaybeJson(text) { if (text == null) return null; try { return JSON.parse(text); } catch { return text; } }

/** 失败 Verification 的 expected/actual 只允许安全扁平证据：截断 / 去敏键 / 去路径与 capability 前缀。 */
const EVIDENCE_SENSITIVE_KEY = /(secret|token|authorization|api[_-]?key|credential|password|bearer)/i;
// 路径判据单一来源：tool-domain 的持久化去敏判据（bridge 的窄口径是「拒绝」判据，不适用于证据投影）。
const EVIDENCE_PATH_RE = toolDomain.UNSAFE_PATH_PERSIST_RE;
const EVIDENCE_CAPABILITY_RE = /mpx_[A-Za-z0-9_-]+|tpx_[A-Za-z0-9_-]+/g;
/** 证据文本一律过同一份判据，含 depth>=2 的 JSON 兜底分支（那里也绝不能出现明文路径）。 */
function redactEvidenceText(text) { return String(text).replace(EVIDENCE_PATH_RE, "[REDACTED_PATH]").replace(EVIDENCE_CAPABILITY_RE, "[REDACTED_CAPABILITY]"); }
function sanitizeEvidenceValue(value, depth = 0) {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = redactEvidenceText(value);
    return s.length > 200 ? s.slice(0, 200) + "…[truncated]" : s;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value).slice(0, 40);
  if (typeof value === "boolean") return value;
  if (depth >= 2) { try { return redactEvidenceText(JSON.stringify(value).slice(0, 200)); } catch { return "[unserializable]"; } }
  if (Array.isArray(value)) return value.slice(0, 16).map((v) => sanitizeEvidenceValue(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = EVIDENCE_SENSITIVE_KEY.test(k) ? "[REDACTED]" : sanitizeEvidenceValue(v, depth + 1);
    return out;
  }
  return String(value).slice(0, 200);
}

/** 被拒 WRITE 操作的 safe arguments 投影：只回传有界、去敏、去私有路径的 evidence。 */
function safeDeniedArguments(raw) {
  const parsed = parseMaybeJson(raw);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const safe = sanitizeEvidenceValue(parsed);
  return safe && typeof safe === "object" && !Array.isArray(safe) ? safe : {};
}

/**
 * D4-03 · #sideEffectSafety code → 各入口既有拒绝原因。
 * 逐字保持既有 RESUME_* / APPEND_* 字符串：收敛判定来源，绝不改写对外语义。
 */
const RESUME_SAFETY_REASON = Object.freeze({
  EFFECT_STATE_UNAVAILABLE: RESUME_REASON.EFFECT_STATE_UNAVAILABLE,
  UNKNOWN_EFFECT: RESUME_REASON.UNKNOWN_EFFECT_PRESENT,
  SIDE_EFFECT_PENDING: RESUME_REASON.SIDE_EFFECT_PENDING,
  ACTIVE_LEASE: RESUME_REASON.ACTIVE_LEASE,
});
const APPEND_SAFETY_REASON = Object.freeze({
  EFFECT_STATE_UNAVAILABLE: APPEND_REASON.EFFECT_STATE_UNAVAILABLE,
  UNKNOWN_EFFECT: APPEND_REASON.UNKNOWN_EFFECT,
  SIDE_EFFECT_PENDING: APPEND_REASON.SIDE_EFFECT_PENDING,
  ACTIVE_LEASE: APPEND_REASON.ACTIVE_LEASE,
});

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
    // D4 收口：实际生效额度由装配层注入；默认回退冻结默认值，保证旧调用不破坏。
    this.budgetConfig = Object.assign({}, BUDGET_BASE);
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

  /**
   * 任务冻结的 model config 版本 vs 当前生效版本（真实 resolve，不是读快照）。
   * 变化一律 MODEL_CONFIG_CHANGED：绝不静默升级、绝不用新版本签发 capability。
   * 未绑定的旧任务（model_config_id 为空）在这里不判定版本。
   */
  #boundModelConfig(task, context) {
    if (!this.modelService || !task.model_config_id) return { ok: true, bound: false };
    // 解析**抛出**（如已绑定 config 行的 capabilities 是损坏 JSON）与返回失败同等对待：
    // 绝不穿透成 RUNNING 悬挂，也不吞掉真实原因（原样带 detail），且绝不写任何状态。
    let resolved;
    try {
      resolved = this.modelService.resolveModel({ context, configId: task.model_config_id });
    } catch (e) {
      resolved = { ok: false, error: "MODEL_CONFIG_UNAVAILABLE", detail: String((e && e.message) || e).slice(0, 120) };
    }
    if (!resolved || !resolved.ok) return resolved || { ok: false, error: "MODEL_CONFIG_UNAVAILABLE" };
    if (resolved.snapshot.modelConfigVersion !== task.model_config_version) {
      return { ok: false, error: ERROR.MODEL_CONFIG_CHANGED, expected: task.model_config_version, current: resolved.snapshot.modelConfigVersion };
    }
    return { ok: true, bound: true, snapshot: resolved.snapshot };
  }

  /** D4-06 Closure：late attach 只读账本 store（bootstrap / 测试夹具在装配完成后注入）。 */
  attachBudgetStores({ toolStore = null, sideEffectStore = null } = {}) {
    if (toolStore) this.toolStore = toolStore;
    if (sideEffectStore) this.sideEffectStore = sideEffectStore;
    return { ok: true };
  }

  /**
   * D4 收口 · 注入实际生效额度（bootstrap / executor bundle 传真实配置）。
   * 只影响账本 base / nextGrant；任一缺失回退 BUDGET_BASE，绝不把缺省当成无限。
   */
  attachBudgetConfig({ modelMaxCalls = null, toolMaxCalls = null, maxToolRounds = null } = {}) {
    const pick = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
    this.budgetConfig = {
      MODEL_CALLS: pick(modelMaxCalls, BUDGET_BASE.MODEL_CALLS),
      TOOL_CALLS: pick(toolMaxCalls, BUDGET_BASE.TOOL_CALLS),
      TOOL_ROUNDS: pick(maxToolRounds, BUDGET_BASE.TOOL_ROUNDS),
    };
    return { ok: true, base: Object.assign({}, this.budgetConfig) };
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
      // SUCCEEDED→RUNNING 只属于 AppendStep：startTask 显式拒绝，绝不借这条边重启已成功任务。
      if (task.status === TASK_STATUS.SUCCEEDED) return { ok: false, error: ERROR.TASK_INVALID_STATE, from: task.status, to: TASK_STATUS.RUNNING, detail: "APPEND_REQUIRED" };
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
  /**
   * Orchestrator 启动 Harness **之前**的绑定校验入口：capability 只允许用任务冻结的版本签发，
   * 因此在 spawn Harness / issueCapability 之前必须先问这一句（失败时 run/step/task 全部 BLOCKED）。
   */
  checkModelConfig({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return this.#boundModelConfig(load.task, context);
  }

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
      const binding = this.#boundModelConfig(task, context);
      if (!binding.ok) return binding;
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

  /**
   * D5-03 第十二批 · 用户取消的账本终态：call = CANCELLED，**绝不写成 Provider 失败**。
   *
   * 边界（每一条都是硬约束）：
   *   · 只收敛**本次任务**里仍为 `STARTED` 的 call —— 已 SUCCEEDED / FAILED / CANCELLED 的历史行
   *     一律原样保留（`#callCommand` 的 `status !== "STARTED"` 前置判定就是这条守卫）；
   *   · 保留已观测到的真实用量（`usage` 原样落库），**不声称 Provider 从未执行 / 从未计费**；
   *   · 与取消同一事务：call 终态、`completed_at`、安全事件一起落，绝不出现半个终态；
   *   · 不新增 call、不改写其它任务的 call（按 task 归属过滤）。
   */
  cancelStartedModelCalls({ context, taskId, expectedRevision, usageByCallId = null } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      let task = load.task;
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      const now = this.#now();
      const finalized = [];
      for (const call of this.store.callsOfTask(task.task_id)) {
        if (call.status !== "STARTED") continue;
        const usage = usageByCallId && usageByCallId[call.call_id] != null ? usageByCallId[call.call_id] : null;
        const patch = { status: "CANCELLED", completed_at: now };
        if (usage != null) patch.usage = usage;
        this.store.updateCall(call.call_id, patch);
        this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.MODEL_CALL_CANCELLED, safePayload: sanitizeEventPayload({ callId: call.call_id, status: "CANCELLED", usageRecorded: usage != null }), at: now });
        finalized.push(call.call_id);
      }
      if (!finalized.length) return { ok: true, changed: false, canceled: [], task: safeTask(task) };
      task = this.store.updateTask(task.task_id, { updated_at: now, revision: task.revision + 1 });
      return { ok: true, changed: true, canceled: finalized, task: safeTask(task) };
    });
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
      let task = load.task;
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
      // R-8：绑定前创建的旧任务从未冻结过版本，这里按**当前**生效配置懒绑定一次（同一事务内落事件），
      // 使 run 行归属正确。解析失败一律保持未绑定 —— 但**绝不建 run**：未绑定的 run 一旦在 capability
      // 签发前出现默认配置，就会以"当前默认"真实执行，而 task/run/call 归属全是 null。
      // 唯一例外：modelService 为 null 的 test-only / 桩装配没有真实模型服务可解析，保持既有建 run 行为不变。
      if (!task.model_config_id && this.modelService) {
        // 解析**抛出**（如库里的 capabilities 是损坏 JSON）与返回失败同等对待：绝不让异常穿透成
        // task/step 停在 RUNNING 的悬挂，也不吞掉真实原因（原样带 detail）。
        let resolved;
        try {
          resolved = this.modelService.resolveModel({ context, capability: "chat" });
        } catch (e) {
          resolved = { ok: false, error: "MODEL_CONFIG_UNAVAILABLE", detail: String((e && e.message) || e).slice(0, 120) };
        }
        if (!resolved || !resolved.ok) {
          return Object.assign({}, resolved || null, { ok: false, error: (resolved && resolved.error) || "MODEL_CONFIG_UNAVAILABLE", message: "任务未绑定模型配置，无法启动", taskId: task.task_id });
        }
        task = this.store.updateTask(task.task_id, { model_config_id: resolved.snapshot.modelConfigId, model_config_version: resolved.snapshot.modelConfigVersion, updated_at: now });
        this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.MODEL_CONFIG_BOUND, safePayload: sanitizeEventPayload({ modelConfigId: resolved.snapshot.modelConfigId, modelConfigVersion: resolved.snapshot.modelConfigVersion, source: resolved.snapshot.source, reason: "LEGACY_UNBOUND_LAZY_BIND" }), at: now });
      }
      // 归属只认任务已冻结的值：已绑定的任务不接受 caller 传入的 id/version 覆盖；未绑定的桩装配才沿用 caller 实参。
      const boundId = task.model_config_id || modelConfigId;
      const boundVersion = task.model_config_id ? task.model_config_version : modelConfigVersion;
      const run = this.store.insertHarnessRun({ taskId: task.task_id, stepId, status: HARNESS_RUN_STATUS.STARTING, harnessVersion, acpVersion, modelConfigId: boundId, modelConfigVersion: boundVersion, startedAt: now });
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

  /** 该 kind 的一次追加额度 = 装配层注入的实际生效额度（与 capability 同源）；缺失回退冻结默认。 */
  #grantBase(kind) {
    const v = this.budgetConfig[kind];
    if (Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
    return RESUME_GRANT_AMOUNT[kind];
  }

  #budgetKinds(taskId) {
    const out = {};
    for (const row of this.store.taskBudgetsOfTask(taskId)) {
      const authorized = Math.max(0, Number(row.authorized) || 0);
      const consumed = Math.max(0, Math.min(authorized, Number(row.consumed) || 0));
      out[row.kind] = { authorized, consumed, remaining: Math.max(0, authorized - consumed), updatedAt: row.updated_at == null ? null : Number(row.updated_at) };
    }
    for (const kind of BUDGET_KIND_ALL) if (!out[kind]) out[kind] = { authorized: 0, consumed: 0, remaining: 0, updatedAt: null };
    return out;
  }

  /**
   * D4-06 Closure · 任务首次触及时惰性建立任务级账本（**只写一次**）。
   *
   * 新任务没有历史消耗 → consumed=0 是精确值。
   * 旧任务（首次触及时已有 run / model call / budget 事件）缺少可靠消耗证据：
   * 采用**保守基线** consumed=authorized（不伪造精确历史余额、不由旧数据反推），
   * 并落一条 task.budget_baseline_created safe event 说明该基线不精确。
   * 调用方必须已处于事务内。
   */
  #ensureBudgetRows(task, now) {
    const existing = this.store.taskBudgetsOfTask(task.task_id);
    const known = new Set(existing.map((r) => r.kind));
    const legacy = this.store.harnessRunsOfTask(task.task_id).length > 0
      || this.store.callsOfTask(task.task_id).length > 0
      || this.#budgetExhaustEvents(task.task_id).length > 0;
    const authorizedByKind = {};
    const consumedByKind = {};
    let created = false;
    for (const kind of BUDGET_KIND_ALL) {
      const authorized = this.#grantBase(kind);
      const consumed = legacy ? authorized : 0;
      authorizedByKind[kind] = authorized;
      consumedByKind[kind] = consumed;
      if (known.has(kind)) continue;
      this.store.upsertTaskBudget({ taskId: task.task_id, kind, authorized, consumed, updatedAt: now });
      created = true;
    }
    if (created && legacy) {
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_BUDGET_BASELINE_CREATED, at: now, safePayload: sanitizeEventPayload({ precise: false, reason: "LEGACY_TASK_CONSERVATIVE_BASELINE", authorized: authorizedByKind, consumed: consumedByKind }) });
    }
    return this.#budgetKinds(task.task_id);
  }

  /**
   * D4-03 · 未决副作用安全判定**单一来源**。
   *
   * resume / append / runTask 三条"启动新执行"入口必须给出同一答案：存在 UNKNOWN_EFFECT /
   * 待批准 / 已批准未执行 / LEASED / RUNNING 或 active lease 时一律阻断。任何一条入口各自
   * 复制判定，都会漂移出"某个入口漏守卫"的缺口（runTask 曾经就是）。只读，绝不改状态。
   */
  #sideEffectSafety(taskId) {
    if (!this.sideEffectStore) return { blocked: true, code: "EFFECT_STATE_UNAVAILABLE" };
    const calls = this.sideEffectStore.callsOfTask(taskId);
    if (calls.some((c) => String(c.status) === "UNKNOWN_EFFECT")) return { blocked: true, code: "UNKNOWN_EFFECT" };
    if (calls.some((c) => ["AWAITING_APPROVAL", "APPROVED", "LEASED", "RUNNING"].includes(String(c.status)))) return { blocked: true, code: "SIDE_EFFECT_PENDING" };
    const callIds = new Set(calls.map((c) => c.callId));
    if (this.sideEffectStore.activeLeases().some((l) => callIds.has(l.callId))) return { blocked: true, code: "ACTIVE_LEASE" };
    return { blocked: false, code: null };
  }

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
    const exhaust = this.#budgetExhaustEvents(task.task_id);
    const lastRun = runs.length ? runs[runs.length - 1] : null;
    const lastStep = steps.length ? steps[steps.length - 1] : null;
    const lastExhaust = exhaust.length ? exhaust[exhaust.length - 1] : null;
    // run 开始前 remaining==0 时不会创建 run，预算停止只留 TASK_BUDGET_EXHAUSTED 事件（payload.stepId）；
    // 该事件属于最后一个 BLOCKED step 时同样是有效预算停止，否则用户拿不到续接入口。
    const stepBudgetStop = !!lastStep && lastStep.status === STEP_STATUS.BLOCKED
      && !!lastExhaust && String(lastExhaust.stepId == null ? "" : lastExhaust.stepId) === String(lastStep.step_id);
    const runBudgetStop = !!lastRun && String(lastRun.error_code) === ERROR.BUDGET_EXHAUSTED;
    base.resumeCount = grants.length;
    base.resumeIndex = grants.length + 1;
    base.remainingResumes = Math.max(0, MAX_BUDGET_RESUMES - grants.length);
    base.stopReason = stepBudgetStop ? ERROR.BUDGET_EXHAUSTED : (lastRun ? (lastRun.error_code || lastRun.stop_reason || null) : null);
    base.fromStepId = lastStep ? lastStep.step_id : null;
    base.fromRunId = lastRun ? lastRun.run_id : null;

    if (task.cancel_requested) return Object.assign(base, { reason: RESUME_REASON.CANCELLED });
    if (task.status !== TASK_STATUS.BLOCKED) return Object.assign(base, { reason: RESUME_REASON.NOT_BLOCKED });
    if (runs.some((r) => r.status === HARNESS_RUN_STATUS.STARTING || r.status === HARNESS_RUN_STATUS.RUNNING)) return Object.assign(base, { reason: RESUME_REASON.IN_FLIGHT });
    if (steps.some((s) => s.status === STEP_STATUS.RUNNING || s.status === STEP_STATUS.PENDING)) return Object.assign(base, { reason: RESUME_REASON.IN_FLIGHT });
    // 安全优先：未决/未知副作用与 active lease 无条件阻断续接，先于停止原因判定。
    const safety = this.#sideEffectSafety(task.task_id);
    if (safety.blocked) return Object.assign(base, { reason: RESUME_SAFETY_REASON[safety.code] });

    if (!lastRun && !stepBudgetStop) return Object.assign(base, { reason: RESUME_REASON.NO_HARNESS_RUN });
    if (!runBudgetStop && !stepBudgetStop) return Object.assign(base, { reason: RESUME_REASON.NOT_BUDGET_STOP });
    base.kind = lastExhaust ? (lastExhaust.kind || null) : null;
    if (!base.kind || !RESUME_GRANT_AMOUNT[base.kind]) return Object.assign(base, { reason: RESUME_REASON.UNKNOWN_BUDGET_KIND });
    if (grants.length >= MAX_BUDGET_RESUMES) return Object.assign(base, { reason: RESUME_REASON.LIMIT_REACHED });
    if (!this.store.artifactsOfTask(task.task_id).length) return Object.assign(base, { reason: RESUME_REASON.NO_SAFE_CONTINUATION });

    base.resumable = true;
    return base;
  }

  /** 历史 appended step 数：只读本任务自身 step 行（input.appended===true）。 */
  #appendedStepCount(steps) {
    let count = 0;
    for (const s of steps) {
      if (!s.input) continue;
      let parsed = null;
      try { parsed = JSON.parse(s.input); } catch { parsed = null; }
      if (parsed && parsed.appended === true) count += 1;
    }
    return count;
  }

  /**
   * D4 Main-Entry Closure-6 后端追加步骤判定（与 #resumeAssessment 并列，appendStep / getAppendEligibility 唯一共用）。
   *
   * 安全守卫先于状态判定：绝不借"追加"绕过未决副作用 / UNKNOWN_EFFECT / active lease / cancel 的限制。
   * 只有任务已 SUCCEEDED、存在真实产物、且无任何在途或未知副作用时，才允许新增一个 bounded step。
   */
  #appendAssessment(task) {
    const base = { appendable: false, reason: null, appendIndex: 1, fromStepId: null, fromRunId: null };
    if (!task) return Object.assign(base, { reason: APPEND_REASON.NOT_SUCCEEDED });
    const runs = this.store.harnessRunsOfTask(task.task_id);
    const steps = this.store.stepsOfTask(task.task_id);
    const lastStep = steps.length ? steps[steps.length - 1] : null;
    const lastRun = runs.length ? runs[runs.length - 1] : null;
    base.fromStepId = lastStep ? lastStep.step_id : null;
    base.fromRunId = lastRun ? lastRun.run_id : null;
    base.appendIndex = this.#appendedStepCount(steps) + 1;

    if (task.cancel_requested) return Object.assign(base, { reason: APPEND_REASON.NOT_SUCCEEDED });
    if (runs.some((r) => r.status === HARNESS_RUN_STATUS.STARTING || r.status === HARNESS_RUN_STATUS.RUNNING)) return Object.assign(base, { reason: APPEND_REASON.IN_FLIGHT });
    if (steps.some((s) => s.status === STEP_STATUS.RUNNING || s.status === STEP_STATUS.PENDING)) return Object.assign(base, { reason: APPEND_REASON.IN_FLIGHT });
    const safety = this.#sideEffectSafety(task.task_id);
    if (safety.blocked) return Object.assign(base, { reason: APPEND_SAFETY_REASON[safety.code] });
    if (task.status !== TASK_STATUS.SUCCEEDED) return Object.assign(base, { reason: APPEND_REASON.NOT_SUCCEEDED });
    if (!this.store.artifactsOfTask(task.task_id).length) return Object.assign(base, { reason: APPEND_REASON.NO_ARTIFACT });

    base.appendable = true;
    return base;
  }

  #remainingOf(kinds) {
    const out = {};
    for (const kind of BUDGET_KIND_ALL) out[kind] = kinds[kind].remaining;
    return out;
  }

  /** D4-06 Closure：调度层读任务剩余额度的唯一入口（惰性建账本，只读 projection）。 */
  getTaskBudget({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return this.store.transactSync(() => {
      const kinds = this.#ensureBudgetRows(load.task, this.#now());
      const authorized = {}; const consumed = {};
      for (const kind of BUDGET_KIND_ALL) { authorized[kind] = kinds[kind].authorized; consumed[kind] = kinds[kind].consumed; }
      return { ok: true, taskId: load.task.task_id, kinds, remaining: this.#remainingOf(kinds), authorized, consumed };
    });
  }

  /**
   * D4-06 Closure · 原子、单调的任务级消耗计量（run 结束时调用一次）。
   * clamp 到 authorized，绝不回退既有 consumed，绝不重复扣减同一次消耗。
   */
  recordBudgetConsumption({ context, taskId, consumption = {} } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return this.store.transactSync(() => {
      const now = this.#now();
      this.#ensureBudgetRows(load.task, now);
      const applied = {};
      for (const kind of BUDGET_KIND_ALL) {
        const row = this.store.taskBudgetById(load.task.task_id, kind);
        const delta = Math.max(0, Number(consumption[kind]) || 0);
        const nextConsumed = Math.min(row.authorized, row.consumed + delta);
        applied[kind] = nextConsumed - row.consumed;
        if (nextConsumed !== row.consumed) this.store.upsertTaskBudget({ taskId: load.task.task_id, kind, authorized: row.authorized, consumed: nextConsumed, updatedAt: now });
      }
      const kinds = this.#budgetKinds(load.task.task_id);
      return { ok: true, applied, kinds, remaining: this.#remainingOf(kinds) };
    });
  }

  getResumeEligibility({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return this.store.transactSync(() => {
      const kinds = this.#ensureBudgetRows(load.task, this.#now());
      const assessment = this.#resumeAssessment(load.task);
      // nextGrant 即**当前阻塞 kind** 与它的一次追加额度；绝不补齐其他种类。
      const nextGrant = assessment.kind ? { kind: assessment.kind, amount: this.#grantBase(assessment.kind) } : null;
      return Object.assign({ ok: true, taskId: load.task.task_id, kinds, remaining: this.#remainingOf(kinds), nextGrant }, assessment);
    });
  }

  /** D4 Main-Entry Closure-6：后端追加资格判定（与 appendStep 共用同一份 #appendAssessment，renderer 自报无效）。 */
  getAppendEligibility({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    return this.store.transactSync(() => {
      const assessment = this.#appendAssessment(load.task);
      return { ok: true, taskId: load.task.task_id, appendable: assessment.appendable, reason: assessment.reason };
    });
  }

  /**
   * D4-03 · 未决副作用安全判定的唯一只读出口（与 command 同源的 owner/app 归属校验）。
   *
   * orchestrator.runTask 在任何状态变更之前调用它；绝不改任何状态、绝不写事件。
   * !ok（TASK_FORBIDDEN / TASK_NOT_FOUND）原样回传，调用方保持既有错误语义，绝不吞掉改写。
   */
  getSideEffectSafety({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    const safety = this.#sideEffectSafety(load.task.task_id);
    return { ok: true, taskId: load.task.task_id, blocked: safety.blocked, code: safety.code };
  }

  /** 只读预算账本：每类 authorized/consumed/remaining + base + additions + nextGrant（绝不更新/清零历史计数）。 */
  getBudgetLedger({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    const id = load.task.task_id;
    return this.store.transactSync(() => {
      const kinds = this.#ensureBudgetRows(load.task, this.#now());
      const assessment = this.#resumeAssessment(load.task);
      const additions = this.#budgetGrantEvents(id).map((g) => ({
        resumeIndex: g.resumeIndex == null ? null : g.resumeIndex, kind: g.kind || null, amount: g.amount == null ? null : g.amount,
        operatorUserId: g.operatorUserId || null, grantedAt: g.at, consumedAtGrant: g.consumedAtGrant || null,
      }));
      const budgetStops = this.#budgetExhaustEvents(id).map((s) => ({ kind: s.kind || null, consumed: s.consumed == null ? null : s.consumed, at: s.at }));
      const nextGrant = assessment.kind ? { kind: assessment.kind, amount: this.#grantBase(assessment.kind) } : null;
      return {
        ok: true,
        ledger: {
          taskId: id,
          // D4 收口：base 必须是**实际生效额度**（装配层注入），而不是硬编码冻结默认值。
          base: Object.assign({}, this.budgetConfig),
          // D4-06 Closure：任务级跨 run 累计账本（每类 authorized/consumed/remaining）。
          kinds,
          authorized: { MODEL_CALLS: kinds.MODEL_CALLS.authorized, TOOL_CALLS: kinds.TOOL_CALLS.authorized, TOOL_ROUNDS: kinds.TOOL_ROUNDS.authorized },
          remaining: this.#remainingOf(kinds),
          additions,
          resumeCount: additions.length,
          maxResumes: MAX_BUDGET_RESUMES,
          remainingResumes: Math.max(0, MAX_BUDGET_RESUMES - additions.length),
          consumed: {
            // task_model_calls 是「每个 step/run 一个模型调用信封」，不是逐 provider 请求；
            // 逐请求的真实 bounded 消耗由任务级 task_budgets 记录（kinds[kind].consumed）。
            modelCallEnvelopes: this.store.callsOfTask(id).length,
            toolExecutions: this.toolStore ? this.toolStore.executionsOfTask(id).length : null,
            budgetStops,
          },
          // nextGrant 明确指向当前阻塞 kind；amount 与 grantBudgetResume 实际追加、capability 签发同源。
          nextGrant,
          resumable: assessment.resumable,
          stopReason: assessment.stopReason,
          reason: assessment.reason,
        },
      };
    });
  }

  /**
   * D4-05 S2 · 结果未知的只读恢复投影（PLAN §384：检查实际应用 / 关联产物 / 人工确认入口）。
   *
   * 只读：不改变 call / step / task 状态，不 retry、不 execute、不授权 resume。
   * 仅当 task BLOCKED 且存在 UNKNOWN_EFFECT call 时 applicable=true；投影一律 safe（无绝对路径 / secret）。
   */
  getRecoveryState({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    const task = load.task;
    const assessment = this.#resumeAssessment(task);
    const base = {
      ok: true, taskId: task.task_id, taskStatus: task.status, applicable: false,
      stopReason: assessment.stopReason || null, resumable: !!assessment.resumable,
      reason: assessment.reason || null, calls: [],
    };
    if (!this.sideEffectStore) return Object.assign(base, { reason: "RECOVERY_STATE_UNAVAILABLE" });
    const unknown = this.sideEffectStore.callsOfTask(task.task_id).filter((c) => String(c.status) === "UNKNOWN_EFFECT");
    if (task.status !== TASK_STATUS.BLOCKED || unknown.length === 0) return base;
    const artifacts = this.store.artifactsOfTask(task.task_id).slice(0, 20).map((a) => ({
      artifactId: a.artifact_id, stepId: a.step_id || null, type: a.type, checksum: a.checksum || null, createdAt: a.created_at,
    }));
    const acks = new Map();
    for (const e of this.store.eventsOfTask(task.task_id)) {
      if (e.event_type !== TASK_EVENT.TOOL_SIDE_EFFECT_UNKNOWN_EFFECT_ACKNOWLEDGED) continue;
      let p = null; try { p = e.safe_payload ? JSON.parse(e.safe_payload) : null; } catch { p = null; }
      if (p && p.callId) acks.set(String(p.callId), { at: e.created_at, operatorUserId: p.operatorUserId || null });
    }
    const calls = unknown.slice(0, 20).map((c) => {
      const rec = c.recoverySafe || null;
      const outcome = rec && ["APPLIED", "NOT_APPLIED", "INDETERMINATE"].includes(String(rec.outcome)) ? String(rec.outcome) : null;
      const ack = acks.get(String(c.callId)) || null;
      return {
        callId: c.callId, toolId: c.toolId, toolVersion: c.toolVersion, status: c.status,
        errorCode: c.errorCode || null, stepId: c.stepId || null, runId: c.runId || null,
        resourceRef: (c.preconditionsSafe && c.preconditionsSafe.resourceRef) || null,
        recoveryResult: outcome || "NO_CONCLUSION", recoveryReason: (rec && rec.reason) || null,
        quiesced: rec && typeof rec.quiesced === "boolean" ? rec.quiesced : null,
        associatedArtifacts: artifacts.map((a) => Object.assign({ sameStepAsCall: a.stepId === c.stepId }, a)),
        acknowledged: !!ack, acknowledgedAt: ack ? ack.at : null, acknowledgedBy: ack ? ack.operatorUserId : null,
      };
    });
    return Object.assign(base, { applicable: true, reason: assessment.reason || RESUME_REASON.UNKNOWN_EFFECT_PRESENT, calls });
  }

  /**
   * D4-05 S2 · 人工确认“已核查结果未知的副作用”。
   *
   * 只追加一条 safe task event；绝不改 call / step / task 状态，绝不授权 resume / retry / replay，
   * 也绝不显示成功。仅允许对属于本 task 的 UNKNOWN_EFFECT call 确认；重复确认幂等（不追加第二条）。
   */
  acknowledgeUnknownEffect({ context, taskId, callId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const id = String(callId == null ? "" : callId);
    if (!id) return { ok: false, error: ERROR.INVALID_INPUT };
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      if (!this.sideEffectStore) return { ok: false, error: "RECOVERY_STATE_UNAVAILABLE" };
      const call = this.sideEffectStore.callById(id);
      if (!call || call.taskId !== task.task_id) return { ok: false, error: ERROR.TASK_NOT_FOUND };
      if (String(call.status) !== "UNKNOWN_EFFECT") return { ok: false, error: "RECOVERY_NOT_APPLICABLE" };
      const already = this.store.eventsOfTask(task.task_id).some((e) => {
        if (e.event_type !== TASK_EVENT.TOOL_SIDE_EFFECT_UNKNOWN_EFFECT_ACKNOWLEDGED) return false;
        let p = null; try { p = e.safe_payload ? JSON.parse(e.safe_payload) : null; } catch { p = null; }
        return !!(p && String(p.callId) === id);
      });
      if (already) return { ok: true, changed: false, acknowledged: true, taskId: task.task_id, callId: id };
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TOOL_SIDE_EFFECT_UNKNOWN_EFFECT_ACKNOWLEDGED, safePayload: sanitizeEventPayload({ callId: id, toolId: call.toolId, operatorUserId: guard.actor.user.id }), at: this.#now() });
      this.#audit(guard, context, "task.acknowledge_unknown_effect", task.task_id);
      return { ok: true, changed: true, acknowledged: true, taskId: task.task_id, callId: id };
    });
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
      const now = this.#now();
      const kinds = this.#ensureBudgetRows(task, now);
      const assessment = this.#resumeAssessment(task);
      if (!assessment.resumable) return { ok: false, error: assessment.reason || "RESUME_NOT_ELIGIBLE", resumable: false, stopReason: assessment.stopReason || null };
      const useKind = kind || assessment.kind;
      if (!useKind || !RESUME_GRANT_AMOUNT[useKind] || (kind && kind !== assessment.kind)) return { ok: false, error: RESUME_REASON.UNKNOWN_BUDGET_KIND };
      // 只允许追加**当前真实阻塞 kind**；该 kind 仍充足（remaining>0）时拒绝循环追加。
      const row = this.store.taskBudgetById(task.task_id, useKind);
      if (!row) return { ok: false, error: RESUME_REASON.UNKNOWN_BUDGET_KIND };
      if (kinds[useKind].remaining > 0) return { ok: false, error: RESUME_REASON.BUDGET_REMAINING, resumable: false, kind: useKind, remaining: kinds[useKind].remaining };
      const addAmount = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : this.#grantBase(useKind);
      // 单事务内只抬升该 kind 的 authorized；其他 kind 的 authorized/consumed 原样不动。
      this.store.upsertTaskBudget({ taskId: task.task_id, kind: useKind, authorized: row.authorized + addAmount, consumed: row.consumed, updatedAt: now });

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
        modelCallEnvelopes: this.store.callsOfTask(task.task_id).length,
        toolExecutions: this.toolStore ? this.toolStore.executionsOfTask(task.task_id).length : null,
        budgetStops: this.#budgetExhaustEvents(task.task_id).length,
      };
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_BUDGET_GRANTED, at: now, safePayload: sanitizeEventPayload({ amount: addAmount, operatorUserId: guard.actor.user.id, resumeIndex: assessment.resumeIndex, kind: useKind, consumedAtGrant }) });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.STEP_CREATED, at: now, safePayload: sanitizeEventPayload({ stepId: step.step_id, sequence, kind: ORCHESTRATION_KIND, maxAttempts: DEFAULT_MAX_ATTEMPTS, resumeIndex: assessment.resumeIndex }) });
      const updatedTask = this.store.updateTask(task.task_id, { status: TASK_STATUS.RUNNING, updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_STARTED, at: now, safePayload: sanitizeEventPayload({ revision: updatedTask.revision, resumed: true, resumeIndex: assessment.resumeIndex, kind: useKind }) });
      this.#audit(guard, context, "task.resume", task.task_id);
      return { ok: true, task: safeTask(updatedTask), step: safeStep(step), resumeIndex: assessment.resumeIndex, kind: useKind, amount: addAmount, remaining: this.#budgetKinds(task.task_id) };
    });
  }

  /**
   * D4 Main-Entry Closure-6 · 唯一产品级"同一任务追加下一步目标"入口（AppendStep）。
   *
   * 判定 + 写入同一事务：并发/重复提交只成功一次。只新增一个 bounded reasoning step，
   * 绝不修改/删除旧 step、artifact、verification、tool proposal/execution、side-effect call 或 lease，
   * 绝不重放旧 tool 请求，也绝不写 task_budgets —— 新 run 只能用既有剩余额度。
   */
  appendStep({ context, taskId, goal, expectedRevision } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const g = typeof goal === "string" ? goal.trim() : "";
    if (!g || g.length > 2000) return { ok: false, error: ERROR.INVALID_INPUT, detail: "goal is required" };
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      if (task.cancel_requested) return { ok: false, error: ERROR.TASK_CANCELLED };
      const conflict = this.#conflict(task, expectedRevision);
      if (conflict) return conflict;
      const assessment = this.#appendAssessment(task);
      if (!assessment.appendable) return { ok: false, error: ERROR.APPEND_NOT_ALLOWED, reason: assessment.reason };
      const now = this.#now();
      const sequence = this.store.nextStepSequence(task.task_id);
      // priorArtifacts 只是低信任参考数据：只取本任务自身最后 ≤3 个产物，事务内现场读取，绝不跨用户/app 取。
      const input = {
        appended: true,
        appendIndex: assessment.appendIndex,
        fromStepId: assessment.fromStepId,
        fromRunId: assessment.fromRunId,
        goal: g,
        priorArtifacts: this.store.artifactsOfTask(task.task_id).slice(-3).map((a) => ({
          artifactId: a.artifact_id, type: a.type, content: String(a.safe_content == null ? "" : a.safe_content).slice(0, 2000),
        })),
        instruction: "Continue from the verified prior results. Do not re-issue any previous tool request and do not repeat already completed operations.",
      };
      const step = this.store.insertStep({ taskId: task.task_id, sequence, kind: ORCHESTRATION_KIND, status: STEP_STATUS.PENDING, input, attempt: 1, maxAttempts: DEFAULT_MAX_ATTEMPTS });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.STEP_CREATED, safePayload: sanitizeEventPayload({ stepId: step.step_id, sequence, kind: ORCHESTRATION_KIND, maxAttempts: DEFAULT_MAX_ATTEMPTS, appended: true, appendIndex: assessment.appendIndex }), at: now });
      // 只改 status/updated_at/revision：started_at/completed_at 等历史字段一律保留（不伪装成新任务）。
      const updatedTask = this.store.updateTask(task.task_id, { status: TASK_STATUS.RUNNING, updated_at: now, revision: task.revision + 1 });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.TASK_STARTED, safePayload: sanitizeEventPayload({ revision: updatedTask.revision, appended: true, appendIndex: assessment.appendIndex }), at: now });
      this.#audit(guard, context, "task.appendStep", task.task_id);
      // 账本只惰性补缺失行；已有 authorized/consumed 一律原样返回，绝不抬升/清零。
      const kinds = this.#ensureBudgetRows(task, now);
      return { ok: true, task: safeTask(updatedTask), step: safeStep(step), appendIndex: assessment.appendIndex, remaining: this.#remainingOf(kinds) };
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

  /**
   * D4 收口 · 失败 Verification 持久化（PLAN §39）。
   *
   * 只追加一条 status=FAIL 的 task_verifications（artifact_id=null）+ 一条 safe task event；
   * **绝不创建 Artifact**、**绝不改变 Step/Task 终态**、**绝不授权 resume/retry**。
   * expected/actual 一律经 sanitizeEvidenceValue（截断 / 去敏键 / 去私有路径与 capability 前缀）。
   */
  recordVerificationFailure({ context, taskId, stepId = null, runId = null, executionId = null, type = null, expected = null, actual = null } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const failureType = String(type == null ? "" : type).trim().slice(0, 80);
    if (!failureType) return { ok: false, error: ERROR.INVALID_INPUT, detail: "type is required" };
    return this.store.transactSync(() => {
      const load = this.#load(guard, taskId);
      if (!load.ok) return load;
      const task = load.task;
      const now = this.#now();
      const safeExecutionId = executionId == null ? null : String(executionId).slice(0, 120);
      const safeDetails = {
        method: failureType,
        expected: sanitizeEvidenceValue(expected),
        actual: sanitizeEvidenceValue(actual),
        evidence: { executionId: safeExecutionId },
      };
      const saved = this.store.insertVerification({
        artifactId: null, taskId: task.task_id,
        stepId: stepId == null ? null : String(stepId).slice(0, 120),
        runId: runId == null ? null : String(runId).slice(0, 120),
        executionId: safeExecutionId,
        type: failureType, status: VERIFICATION_STATUS.FAIL, safeDetails, createdAt: now,
      });
      this.store.appendEvent({ taskId: task.task_id, eventType: TASK_EVENT.VERIFICATION_COMPLETED, safePayload: sanitizeEventPayload({ verificationId: saved.verification_id, artifactId: null, executionId: safeExecutionId, stepId: stepId == null ? null : String(stepId).slice(0, 120), runId, type: failureType, status: "FAIL" }), at: now });
      return { ok: true, verification: safeVerification(saved) };
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

  /**
   * D4-05 Closure · A33：只读列出「必需产物验证失败且尚未被后续真实验证 PASS 解决」的操作。
   *
   * 判据来自后端记录（tool_executions + task_tool_proposals.arguments_hash），不信任模型自述。
   * 关联键是 **(tool_id, canonical arguments)**，不是裸 tool_id：同一工具对**同一对象 + 同一验证要求**
   * （同 arguments_hash）的后续真实 PASS 才算解决；对象/要求不同（如 label 或 expectedSize 不同）的
   * PASS 绝不误清除别的对象的 FAIL。
   *   · 只有 verification_status ∈ {FAIL, PASS} 的 execution 参与；普通工具调用错误（为空）不参与。
   *   · arguments_hash 缺失/为空（旧数据/无法可靠关联）→ 以 execution_id 生成唯一键，保守地永不清除。
   *   · 顺序敏感：FAIL、PASS、FAIL → 仍未解决；旧 FAIL 记录绝不删除、绝不改写。无副作用。
   */
  getUnresolvedRequiredVerificationFailures({ context, taskId } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    if (!this.toolStore || typeof this.toolStore.executionsOfTask !== "function") return { ok: true, unresolved: [], resolved: [] };
    const methodOf = (errorCode) => errorCode === ERROR.TOOL_OUTPUT_INVALID ? "OUTPUT_SCHEMA" : errorCode === ERROR.TOOL_VERIFICATION_FAILED ? "ADAPTER_VERIFY" : null;
    const proposalById = typeof this.toolStore.proposalById === "function" ? (id) => this.toolStore.proposalById(id) : null;
    const states = new Map();
    for (const exec of this.toolStore.executionsOfTask(load.task.task_id)) {
      const status = exec && exec.verification_status;
      if (status !== "FAIL" && status !== "PASS") continue;
      const proposal = proposalById ? proposalById(exec.proposal_id) : null;
      const argsHash = proposal && typeof proposal.arguments_hash === "string" && proposal.arguments_hash ? proposal.arguments_hash : null;
      const toolId = String(exec.tool_id);
      // 无可靠关联键时退回 execution 唯一键：绝不与其他 execution 共享解决关系（保守保持未解决）。
      const key = argsHash ? toolId + "::" + argsHash : toolId + "::exec:" + String(exec.execution_id);
      let rec = states.get(key);
      if (!rec) { rec = { toolId, argsHash, linked: !!argsHash, lastFail: null, resolvedBy: null }; states.set(key, rec); }
      if (status === "FAIL") {
        rec.lastFail = { executionId: exec.execution_id, errorCode: exec.error_code || null, method: methodOf(exec.error_code), stepId: exec.step_id || null, runId: exec.run_id || null };
        rec.resolvedBy = null;
      } else if (rec.lastFail) {
        rec.resolvedBy = { executionId: exec.execution_id, stepId: exec.step_id || null, runId: exec.run_id || null };
      }
    }
    const unresolved = [];
    const resolved = [];
    for (const rec of states.values()) {
      if (!rec.lastFail) continue;
      if (rec.resolvedBy) {
        resolved.push({ toolId: rec.toolId, argsHash: rec.argsHash, failedExecutionId: rec.lastFail.executionId, resolvedByExecutionId: rec.resolvedBy.executionId, method: rec.lastFail.method });
      } else {
        unresolved.push({ toolId: rec.toolId, executionId: rec.lastFail.executionId, errorCode: rec.lastFail.errorCode, method: rec.lastFail.method, argsHash: rec.argsHash, linked: rec.linked, stepId: rec.lastFail.stepId, runId: rec.lastFail.runId });
      }
    }
    return { ok: true, unresolved, resolved };
  }

  /**
   * D4 收口 · 只读列出「明确非 READ_ONLY（WRITE 类）操作被后端拒绝、且尚未被同一
   * tool + 同一 canonical arguments 的真实成功解决」的记录。
   *
   * 判据全部来自后端记录（task_tool_proposals + tool_decisions + tool_executions +
   * side_effect_calls），不信任模型自述；READ_ONLY 的拒绝绝不参与。
   * 解决语义与 A33 同源：只有同一 (tool_id, arguments_hash) **之后**出现真实成功
   * （SideEffectCall SUCCEEDED，或 decision=ALLOWED 且 execution SUCCEEDED）才算解决；
   * arguments_hash 缺失（无法可靠关联）→ 以 proposal 唯一键保守保持未解决。
   * 严格只读：绝不删除 / 改写任何拒绝记录，绝不产生副作用。
   */
  getDeniedRequiredWriteOperations({ context, taskId, runId = null } = {}) {
    const guard = this.#guard(context);
    if (!guard.ok) return guard;
    const load = this.#load(guard, taskId);
    if (!load.ok) return load;
    const empty = { ok: true, denials: [], unresolved: [], resolved: [] };
    if (!this.toolStore || typeof this.toolStore.decisionsOfTask !== "function" || typeof this.toolStore.proposalsOfTask !== "function") return empty;
    const targetRunId = runId == null || runId === "" ? null : String(runId);

    const proposals = this.toolStore.proposalsOfTask(load.task.task_id) || [];
    const proposalById = new Map(proposals.map((p) => [String(p.proposal_id), p]));
    const decisions = this.toolStore.decisionsOfTask(load.task.task_id) || [];
    const decisionByProposal = new Map(decisions.map((d) => [String(d.proposal_id), d]));
    // 同秒 / 固定时钟下 created_at 无法区分先后：优先用 proposal 插入顺序(rowid)判定“之后”。
    const sequence = typeof this.toolStore.proposalSequenceOfTask === "function" ? this.toolStore.proposalSequenceOfTask(load.task.task_id) : null;
    const seqOfProposal = new Map((sequence || []).map((id, index) => [String(id), index]));

    // 真实成功索引：key = tool_id + "::" + arguments_hash → 成功记录（按 proposal 插入序判定“之后”）。
    const successByKey = new Map();
    const addSuccess = (key, proposalId, at, kind, ref, stepId, runIdOf) => {
      if (!key) return;
      let list = successByKey.get(key);
      if (!list) { list = []; successByKey.set(key, list); }
      list.push({ proposalId: proposalId == null ? null : String(proposalId), at: at == null ? null : Number(at), kind, ref, stepId: stepId || null, runId: runIdOf || null });
    };
    if (this.sideEffectStore && typeof this.sideEffectStore.callsOfTask === "function") {
      for (const call of this.sideEffectStore.callsOfTask(load.task.task_id) || []) {
        if (!call || call.status !== "SUCCEEDED" || !call.argumentsHash) continue;
        addSuccess(String(call.toolId) + "::" + String(call.argumentsHash), call.proposalId, call.completedAt == null ? call.updatedAt : call.completedAt, "SIDE_EFFECT_CALL", call.callId, call.stepId, call.runId);
      }
    }
    if (typeof this.toolStore.executionsOfTask === "function") {
      for (const exec of this.toolStore.executionsOfTask(load.task.task_id) || []) {
        if (!exec || exec.status !== "SUCCEEDED") continue;
        const proposal = proposalById.get(String(exec.proposal_id));
        if (!proposal || !proposal.arguments_hash) continue;
        const decision = decisionByProposal.get(String(exec.proposal_id));
        if (!decision || decision.decision !== "ALLOWED") continue;
        addSuccess(String(exec.tool_id) + "::" + String(proposal.arguments_hash), exec.proposal_id, exec.completed_at == null ? exec.started_at : exec.completed_at, "TOOL_EXECUTION", exec.execution_id, exec.step_id, exec.run_id);
      }
    }

    const denials = [];
    for (const d of decisions) {
      if (!d || String(d.decision) !== "DENIED") continue;
      const riskClass = d.risk_class == null ? null : String(d.risk_class);
      // READ_ONLY 拒绝不参与；risk 缺失无法归类为“明确 WRITE”，保守排除。
      if (!riskClass || riskClass === "READ_ONLY") continue;
      const proposal = proposalById.get(String(d.proposal_id));
      if (!proposal) continue;
      const proposalRunId = proposal.run_id == null ? null : String(proposal.run_id);
      if (targetRunId && proposalRunId !== targetRunId) continue;
      const argsHash = proposal.arguments_hash == null || proposal.arguments_hash === "" ? null : String(proposal.arguments_hash);
      const toolId = String(proposal.tool_id);
      const decidedAt = d.created_at == null ? null : Number(d.created_at);
      const rec = {
        toolId,
        toolVersion: proposal.tool_version == null ? null : proposal.tool_version,
        proposalId: proposal.proposal_id,
        decisionId: d.decision_id,
        reasonCode: d.reason_code || null,
        riskClass,
        stepId: proposal.step_id || null,
        runId: proposalRunId,
        argumentsHash: argsHash,
        arguments: safeDeniedArguments(proposal.arguments_safe),
        decidedAt,
        linked: !!argsHash,
      };
      // 只有同一 tool + 同一 canonical arguments 的**后续**真实成功才解决；先后不可比 → 保守未解决。
      if (argsHash) {
        const denialSeq = seqOfProposal.has(String(proposal.proposal_id)) ? seqOfProposal.get(String(proposal.proposal_id)) : null;
        const later = (successByKey.get(toolId + "::" + argsHash) || []).find((s) => {
          if (denialSeq != null) return s.proposalId != null && seqOfProposal.has(s.proposalId) && seqOfProposal.get(s.proposalId) > denialSeq;
          return decidedAt != null && s.at != null && Number.isFinite(s.at) && s.at > decidedAt;
        });
        if (later) rec.resolvedBy = { kind: later.kind, ref: later.ref, stepId: later.stepId, runId: later.runId, at: later.at, proposalId: later.proposalId };
      }
      denials.push(rec);
    }
    return { ok: true, denials, unresolved: denials.filter((r) => !r.resolvedBy), resolved: denials.filter((r) => !!r.resolvedBy) };
  }

  // 供 ADR / 测试断言：第一版永久冻结
  static get policy() { return Object.freeze({ autoRetry: AUTO_RETRY, defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS, toolExecution: TOOL_EXECUTION }); }
}

module.exports = { TaskService };
