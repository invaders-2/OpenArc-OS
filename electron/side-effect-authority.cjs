/**
 * D4-03C1 · Side-effect Authority。
 *
 * 唯一职责：把 **Proposal → Decision → Plan → Approval → Lease → Eligibility**
 * 六层合同落成受信任的 OpenArc Authority。执行本身仍然禁止：
 * `evaluateExecutionEligibility` 最多返回 ELIGIBLE，绝不调用任何 Domain mutation。
 *
 * 永久冻结：
 * - callId / idempotencyKey / effectClass / expectedEffects 一律 OpenArc 生成，
 *   Harness payload 中的同名字段无效；
 * - Approval 只来自 trusted user action，绝不来自 Harness / ACP permission / model text；
 * - Approval 与 Lease 是两个独立 authority；有 Approval 无 Lease 不能执行，
 *   有 Lease 无有效 Approval 也不能执行；
 * - Lease 是 side-effect 执行资格，不是业务 Domain 锁（业务 version/lock 另行遵守）。
 */
"use strict";
const crypto = require("node:crypto");
const domain = require("./side-effect-domain.cjs");
const toolDomain = require("./tool-domain.cjs");
const {
  CALL_STATUS, APPROVAL_DECISION, LEASE_STATUS, ELIGIBILITY, SIDE_EFFECT_ERROR,
  DEFAULT_APPROVAL_TTL_MS, DEFAULT_LEASE_TTL_MS,
  effectClassForRisk, isC1EffectClass, planHashOf, idempotencyKeyOf, fingerprint,
  evaluateExecutionEligibility,
} = domain;
const { isWellFormedToolId } = toolDomain;

const newId = (prefix) => prefix + "_" + crypto.randomBytes(10).toString("base64url");
const SAFE_EFFECT = /^(secret|token|authorization|api[_-]?key|credential|password|bearer)/i;

function safeString(value, max = 200) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + "…" : s;
}
/** expectedEffects 只保留安全结构，绝不含 credential / 绝对路径 / raw payload。 */
function sanitizeEffects(effects, depth = 0) {
  if (effects == null) return [];
  if (!Array.isArray(effects)) return [safeString(effects)];
  return effects.slice(0, 16).map((e) => sanitizeEffect(e, depth + 1));
}
function sanitizeEffect(effect, depth = 0) {
  if (effect == null) return null;
  if (typeof effect === "string") return safeString(effect, 300);
  if (typeof effect === "number" || typeof effect === "boolean") return effect;
  if (depth > 4) return "[depth]";
  if (Array.isArray(effect)) return effect.slice(0, 16).map((e) => sanitizeEffect(e, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(effect)) {
    if (SAFE_EFFECT.test(k)) continue;
    out[k] = sanitizeEffect(v, depth + 1);
  }
  return out;
}
/** preconditions 只允许 safe refs + version/hash，绝不复制业务对象。 */
const PRECONDITION_KEYS = new Set(["resourceRef", "expectedVersion", "expectedHash", "targetRef", "targetType", "registryStatus", "updatedAt"]);
function sanitizePreconditions(pre) {
  const out = {};
  if (!pre || typeof pre !== "object") return out;
  for (const [k, v] of Object.entries(pre)) {
    if (!PRECONDITION_KEYS.has(k)) continue;
    out[k] = typeof v === "string" ? safeString(v, 300) : v;
  }
  return out;
}

class SideEffectAuthority {
  constructor({ registry, sideEffectStore, taskStore, toolStore, authService, adapters = null, clock = null, audit = null, taskService = null, instanceId = null, unknownEffectVerifier = null } = {}) {
    if (!registry) throw new Error("SideEffectAuthority 需要 ToolRegistry");
    if (!sideEffectStore) throw new Error("SideEffectAuthority 需要 SideEffectStore");
    if (!taskStore) throw new Error("SideEffectAuthority 需要 TaskStore");
    if (!authService) throw new Error("SideEffectAuthority 需要 AuthorizationService");
    this.registry = registry;
    this.store = sideEffectStore;
    this.taskStore = taskStore;
    this.toolStore = toolStore || null;
    this.authService = authService;
    this.adapterFor = adapters && typeof adapters.adapterFor === "function" ? adapters.adapterFor : null;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.audit = typeof audit === "function" ? audit : null;
    this.taskService = taskService || null;
    this.instanceId = instanceId || "runtime_" + crypto.randomBytes(6).toString("base64url");
    this.unknownEffectVerifier = typeof unknownEffectVerifier === "function" ? unknownEffectVerifier : null;
    this.lastUnknownEffect = null;
  }

  #now() { return this.clock(); }
  #trusted(context = {}, { user = false } = {}) {
    return { sessionRef: context.sessionRef, appId: context.appId, source: user ? "user" : "agent", agent: !user, requestId: context.requestId || null };
  }
  #audit({ actorUserId = null, appId = null, toolRef = null, action, decision, reasonCode = null }) {
    try { this.toolStore?.insertToolAudit?.({ at: this.#now(), actorUserId, appId, toolRef, action, decision, reasonCode, requestId: null }); } catch { /* audit 失败不改业务结果 */ }
  }
  #event(taskId, eventType, safePayload = null) {
    try { this.taskStore.appendEvent({ taskId, eventType, safePayload }); } catch { /* ignore */ }
  }

  #resolveAgent(context) {
    const actor = this.authService.resolveActor({ context: this.#trusted(context) });
    return actor && actor.ok ? actor : { ok: false, error: SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED };
  }
  /** trusted 用户动作：任何 Harness/ACP/model 来源都拒绝。 */
  #resolveTrustedUser(context) {
    const src = context && context.source != null ? String(context.source) : "";
    if (src !== "user" || context.agent === true) return { ok: false, error: SIDE_EFFECT_ERROR.APPROVAL_FORBIDDEN };
    const actor = this.authService.resolveActor({ context: this.#trusted(context, { user: true }) });
    return actor && actor.ok ? actor : { ok: false, error: SIDE_EFFECT_ERROR.APPROVAL_FORBIDDEN };
  }

  /** 当前有效 approval：过期按 EXPIRED 计算，不修改行。 */
  effectiveApproval(callId) {
    const row = this.store.latestApprovalOfCall(callId);
    if (!row) return null;
    if (row.decision === APPROVAL_DECISION.APPROVED && row.expires_at != null && this.#now() >= Number(row.expires_at)) return { ...row, effectiveDecision: APPROVAL_DECISION.EXPIRED };
    return { ...row, effectiveDecision: row.decision };
  }

  /** 实时重新授权（resource actions + app tool permissions），读取真实 AuthorizationService。 */
  #authorizeLive({ sessionRef, appId, preconditions }, contract, userId) {
    const trusted = { sessionRef, appId, source: "agent", agent: true, requestId: null, actorUserId: userId };
    const ref = preconditions ? (preconditions.resourceRef || preconditions.targetRef || null) : null;
    for (const action of contract.resourceActions || []) {
      if (!ref) return { ok: false, error: SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED };
      const authz = this.authService.authorize({ context: trusted, application: { appId }, action, resource: String(ref) });
      if (authz.decision !== "ALLOW") return { ok: false, error: SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED };
    }
    for (const perm of contract.requiredPermissions || []) {
      const t = this.authService.authorizeTool({ context: trusted, action: perm });
      if (t.decision !== "ALLOW") return { ok: false, error: SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED };
    }
    return { ok: true };
  }

  #toolFor(call) {
    // §57：call 必须绑定 Registry 当前（最新）版本；Registry 变 v2 后旧 v1 call 一律 stale。
    const versions = this.registry.versionsOf(call.toolId);
    const latest = versions.length ? versions[versions.length - 1] : null;
    if (latest == null) return { ok: false, error: "SIDE_EFFECT_TOOL_NOT_FOUND" };
    if (Number(latest) !== Number(call.toolVersion)) return { ok: false, error: "SIDE_EFFECT_TOOL_VERSION_CHANGED" };
    const resolved = this.registry.resolve(call.toolId, call.toolVersion);
    if (!resolved.ok) {
      if (resolved.error === "TOOL_DISABLED") return { ok: false, error: "TOOL_DISABLED" };
      if (resolved.error === "TOOL_VERSION_UNSUPPORTED") return { ok: false, error: "SIDE_EFFECT_TOOL_VERSION_CHANGED" };
      return { ok: false, error: "SIDE_EFFECT_TOOL_NOT_FOUND" };
    }
    return { ok: true, contract: resolved.contract };
  }

  #preconditionsOk(call) {
    const pre = call.preconditionsSafe || {};
    const ref = pre.resourceRef;
    if (!ref || pre.expectedVersion == null) return true;
    const store = this.authService.store;
    if (!store || typeof store.resourceByRef !== "function") return true;
    const row = store.resourceByRef(String(ref));
    if (!row) return false;
    const status = String(row.registry_status || row.status || "");
    if (status && status !== "active") return false;
    return Number(row.version) === Number(pre.expectedVersion);
  }

  /**
   * 第一层合同：把已 APPROVAL_REQUIRED 的 write proposal 变成持久 SideEffectCall。
   * 全程只读（adapter.plan），无任何 mutation。_idempotencyKey 仅测试 seam。
   */
  async planSideEffect({ context = {}, taskId, stepId = null, runId = null, toolId, toolVersion = null, arguments: args = {}, proposalId = null, decisionId = null, _idempotencyKey = null } = {}) {
    if (!isWellFormedToolId(toolId)) return { ok: false, error: SIDE_EFFECT_ERROR.TOOL_NOT_FOUND };
    const actor = this.#resolveAgent(context);
    if (!actor.ok) return { ok: false, error: actor.error };
    const task = taskId ? this.taskStore.taskById(taskId) : null;
    if (!task) return { ok: false, error: SIDE_EFFECT_ERROR.TASK_NOT_FOUND };
    if (task.user_id !== actor.user.id || task.app_id !== context.appId) return { ok: false, error: SIDE_EFFECT_ERROR.TASK_FORBIDDEN };
    if (task.cancel_requested || task.status === "CANCELLED") return { ok: false, error: SIDE_EFFECT_ERROR.TASK_CANCELLED };
    if (task.status !== "RUNNING") return { ok: false, error: SIDE_EFFECT_ERROR.TASK_NOT_RUNNING };
    if (stepId) { const step = this.taskStore.stepById(stepId); if (!step || step.task_id !== taskId || step.status !== "RUNNING") return { ok: false, error: SIDE_EFFECT_ERROR.STEP_NOT_RUNNING }; }
    if (runId) { const runs = this.taskStore.harnessRunsOfTask(taskId); const latest = runs[runs.length - 1]; if (!runs.some((r) => r.run_id === runId) || (latest && latest.run_id !== runId)) return { ok: false, error: SIDE_EFFECT_ERROR.STALE_RUN }; }

    const versions = this.registry.versionsOf(toolId);
    const effectiveVersion = toolVersion == null ? (versions.length ? versions[versions.length - 1] : null) : toolVersion;
    const resolved = this.registry.resolve(toolId, effectiveVersion);
    if (!resolved.ok) {
      if (resolved.error === "TOOL_DISABLED") return { ok: false, error: SIDE_EFFECT_ERROR.TOOL_DISABLED };
      if (resolved.error === "TOOL_VERSION_UNSUPPORTED") return { ok: false, error: SIDE_EFFECT_ERROR.TOOL_VERSION_CHANGED };
      return { ok: false, error: SIDE_EFFECT_ERROR.TOOL_NOT_FOUND };
    }
    const contract = resolved.contract;
    // §59：Harness spoof 字段（approved/approvalId/leaseId/callId/idempotencyKey/effectClass...）
    // 要么被 inputSchema additionalProperties=false 拒绝，要么完全忽略，绝不改变 authority。
    const validation = this.registry.validateInput(contract, args);
    if (!validation.ok) return { ok: false, error: "TOOL_ARGUMENT_INVALID", schemaErrors: validation.errors };
    const effectClass = effectClassForRisk(contract.riskClass);
    if (!effectClass) return { ok: false, error: SIDE_EFFECT_ERROR.EFFECT_CLASS_BLOCKED, detail: "READ_ONLY uses D4-03B" };
    if (!isC1EffectClass(effectClass)) return { ok: false, error: SIDE_EFFECT_ERROR.EFFECT_CLASS_BLOCKED };
    if (!contract.verificationStrategy) return { ok: false, error: SIDE_EFFECT_ERROR.VERIFICATION_UNAVAILABLE };
    if (contract.idempotencySupport === false) return { ok: false, error: SIDE_EFFECT_ERROR.IDEMPOTENCY_UNSUPPORTED };
    const adapter = this.adapterFor ? this.adapterFor({ executionProvider: contract.executionProvider, toolId: contract.toolId }) : null;
    if (!adapter || typeof adapter.plan !== "function") return { ok: false, error: SIDE_EFFECT_ERROR.NO_PLAN };

    const trusted = { sessionRef: context.sessionRef, appId: context.appId, source: "agent", agent: true, requestId: context.requestId || null, actorUserId: actor.user.id };
    let plan;
    try { plan = await adapter.plan({ context: trusted, args: args && typeof args === "object" ? args : {}, contract }); }
    catch { return { ok: false, error: SIDE_EFFECT_ERROR.NO_PLAN }; }
    if (!plan || typeof plan !== "object") return { ok: false, error: SIDE_EFFECT_ERROR.NO_PLAN };

    const argumentsHash = fingerprint(args == null ? {} : args);
    const targets = (Array.isArray(plan.targets) ? plan.targets : []).slice(0, 8).map((t) => (typeof t === "string" ? t : (t && (t.resourceRef || t.ref || t.targetRef)) || null)).filter((t) => typeof t === "string" && t.length <= 300);
    const preconditions = sanitizePreconditions(plan.preconditions);
    const expectedEffects = sanitizeEffects(plan.expectedEffects);
    const callId = newId("scall");
    const idempotencyKey = _idempotencyKey || idempotencyKeyOf({ callId, toolId: contract.toolId, toolVersion: contract.version, argumentsHash, targetRefs: targets });
    const planHash = planHashOf({ callId, toolId: contract.toolId, toolVersion: contract.version, argumentsHash, riskClass: contract.riskClass, requiresApproval: true, targets, preconditions, expectedEffects });

    const existingByKey = this.store.callByIdempotencyKey(idempotencyKey);
    if (existingByKey) {
      // §52：同一 idempotency key 只能绑定同一 call binding；planHash 含 callId，不用于跨 call 比较。
      const sameBinding = existingByKey.argumentsHash === argumentsHash
        && existingByKey.toolId === contract.toolId
        && Number(existingByKey.toolVersion) === Number(contract.version)
        && JSON.stringify(existingByKey.preconditionsSafe || {}) === JSON.stringify(preconditions);
      if (!sameBinding) return { ok: false, error: SIDE_EFFECT_ERROR.IDEMPOTENCY_CONFLICT, call: existingByKey };
      return { ok: true, duplicate: true, call: existingByKey, plan: null };
    }

    const now = this.#now();
    const call = this.store.transactSync(() => this.store.insertCall({
      callId, proposalId, decisionId, taskId, stepId, runId, toolId: contract.toolId, toolVersion: contract.version,
      argumentsHash, planHash, idempotencyKey, effectClass, status: CALL_STATUS.AWAITING_APPROVAL,
      preconditionsSafe: preconditions, expectedEffectsSafe: expectedEffects, createdAt: now, updatedAt: now,
    }));
    this.#audit({ actorUserId: actor.user.id, appId: context.appId, toolRef: contract.toolId, action: "side_effect.planned", decision: CALL_STATUS.AWAITING_APPROVAL, reasonCode: null });
    this.#audit({ actorUserId: actor.user.id, appId: context.appId, toolRef: contract.toolId, action: "side_effect.approval_requested", decision: CALL_STATUS.AWAITING_APPROVAL, reasonCode: null });
    this.#event(taskId, "tool.side_effect.planned", { callId: call.callId, toolId: call.toolId, toolVersion: call.toolVersion, effectClass: call.effectClass, status: call.status });
    this.#event(taskId, "tool.approval_required", { callId: call.callId, toolId: call.toolId, status: call.status });
    return { ok: true, duplicate: false, call, plan: { callId, toolId: contract.toolId, toolVersion: contract.version, argumentsHash, targets, preconditions, expectedEffects, planHash, riskClass: contract.riskClass, requiresApproval: true } };
  }

  /** trusted user action only：绑定 call 的 tool/version/argsHash/effectClass/expectedEffects/planHash。 */
  approveSideEffect({ context = {}, callId, ttlMs = DEFAULT_APPROVAL_TTL_MS } = {}) {
    const actor = this.#resolveTrustedUser(context);
    if (!actor.ok) return { ok: false, error: actor.error };
    const call = this.store.callById(callId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    const task = this.taskStore.taskById(call.taskId);
    if (!task) return { ok: false, error: SIDE_EFFECT_ERROR.TASK_NOT_FOUND };
    if (task.user_id !== actor.user.id && actor.user.role !== "ADMIN") return { ok: false, error: SIDE_EFFECT_ERROR.APPROVAL_FORBIDDEN };
    if (call.status !== CALL_STATUS.AWAITING_APPROVAL && call.status !== CALL_STATUS.APPROVED) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_STATE };
    const now = this.#now();
    const expiresAt = now + Math.max(1, Number(ttlMs) || DEFAULT_APPROVAL_TTL_MS);
    const approval = this.store.transactSync(() => this.store.insertApproval({
      callId, actorUserId: actor.user.id, sessionRef: context.sessionRef, decision: APPROVAL_DECISION.APPROVED, planHash: call.planHash,
      approvedToolId: call.toolId, approvedToolVersion: call.toolVersion, approvedArgumentsHash: call.argumentsHash,
      approvedEffectClass: call.effectClass, approvedExpectedEffects: call.expectedEffectsSafe, createdAt: now, expiresAt,
    }));
    const updated = this.store.transactSync(() => this.store.updateCall(callId, { status: CALL_STATUS.APPROVED, approved_at: now }));
    this.#audit({ actorUserId: actor.user.id, appId: context.appId, toolRef: call.toolId, action: "side_effect.approved", decision: APPROVAL_DECISION.APPROVED, reasonCode: null });
    this.#event(call.taskId, "tool.approved", { callId, approvalId: approval.approvalId, expiresAt });
    return { ok: true, call: updated, approval };
  }

  denySideEffect({ context = {}, callId } = {}) {
    const actor = this.#resolveTrustedUser(context);
    if (!actor.ok) return { ok: false, error: actor.error };
    const call = this.store.callById(callId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    const task = this.taskStore.taskById(call.taskId);
    if (!task) return { ok: false, error: SIDE_EFFECT_ERROR.TASK_NOT_FOUND };
    if (task.user_id !== actor.user.id && actor.user.role !== "ADMIN") return { ok: false, error: SIDE_EFFECT_ERROR.APPROVAL_FORBIDDEN };
    const now = this.#now();
    const approval = this.store.transactSync(() => this.store.insertApproval({ callId, actorUserId: actor.user.id, sessionRef: context.sessionRef, decision: APPROVAL_DECISION.DENIED, planHash: call.planHash, createdAt: now }));
    const updated = this.store.transactSync(() => this.store.updateCall(callId, { status: CALL_STATUS.BLOCKED, error_code: SIDE_EFFECT_ERROR.APPROVAL_DENIED }));
    this.#audit({ actorUserId: actor.user.id, appId: context.appId, toolRef: call.toolId, action: "side_effect.denied", decision: APPROVAL_DECISION.DENIED, reasonCode: null });
    this.#event(call.taskId, "tool.denied", { callId, approvalId: approval.approvalId });
    return { ok: true, call: updated, approval };
  }

  revokeApproval({ context = {}, callId } = {}) {
    const actor = this.#resolveTrustedUser(context);
    if (!actor.ok) return { ok: false, error: actor.error };
    const approval = this.store.latestApprovalOfCall(callId);
    if (!approval) return { ok: false, error: SIDE_EFFECT_ERROR.APPROVAL_REQUIRED };
    const revokeCall = this.store.callById(callId);
    const revokeTask = revokeCall ? this.taskStore.taskById(revokeCall.taskId) : null;
    if (!revokeTask) return { ok: false, error: SIDE_EFFECT_ERROR.TASK_NOT_FOUND };
    if (revokeTask.user_id !== actor.user.id && actor.user.role !== "ADMIN") return { ok: false, error: SIDE_EFFECT_ERROR.APPROVAL_FORBIDDEN };
    const now = this.#now();
    this.store.transactSync(() => this.store.updateApproval(approval.approvalId, { decision: APPROVAL_DECISION.REVOKED, revoked_at: now }));
    const call = this.store.callById(callId);
    this.#audit({ actorUserId: actor.user.id, appId: context.appId, toolRef: call ? call.toolId : null, action: "side_effect.approval_revoked", decision: APPROVAL_DECISION.REVOKED, reasonCode: null });
    if (call) this.#event(call.taskId, "tool.denied", { callId, approvalId: approval.approvalId, reason: SIDE_EFFECT_ERROR.APPROVAL_REVOKED });
    return { ok: true, call, approval: this.store.approvalById(approval.approvalId) };
  }

  /** 每个 call 至多一个 ACTIVE lease；同一 holder 重复 acquire 幂等返回既有 lease。 */
  acquireLease({ context = {}, callId, holderId, instanceId = null, ttlMs = DEFAULT_LEASE_TTL_MS, _leaseId = null } = {}) {
    if (!holderId) return { ok: false, error: SIDE_EFFECT_ERROR.INVALID_INPUT };
    const call = this.store.callById(callId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    if (call.status !== CALL_STATUS.APPROVED && call.status !== CALL_STATUS.LEASED) {
      return { ok: false, error: call.status === CALL_STATUS.AWAITING_APPROVAL ? SIDE_EFFECT_ERROR.APPROVAL_REQUIRED : SIDE_EFFECT_ERROR.CALL_STATE };
    }
    const now = this.#now();
    const result = this.store.transactSync(() => {
      const active = this.store.activeLeaseOfCall(callId);
      if (active) {
        if (active.expiresAt != null && now >= Number(active.expiresAt)) this.store.updateLease(active.leaseId, { status: LEASE_STATUS.EXPIRED });
        else if (active.holderId === holderId) return { ok: true, duplicate: true, lease: active };
        else return { ok: false, error: SIDE_EFFECT_ERROR.LEASE_CONFLICT, lease: active };
      }
      const approval = this.store.latestApprovalOfCall(callId);
      const valid = approval && approval.decision === APPROVAL_DECISION.APPROVED && approval.revokedAt == null && (approval.expiresAt == null || now < Number(approval.expiresAt)) && approval.planHash === call.planHash && approval.approvedArgumentsHash === call.argumentsHash && approval.approvedToolId === call.toolId && Number(approval.approvedToolVersion) === Number(call.toolVersion);
      if (!valid) {
        const reason = !approval ? SIDE_EFFECT_ERROR.APPROVAL_REQUIRED
          : approval.decision === APPROVAL_DECISION.REVOKED ? SIDE_EFFECT_ERROR.APPROVAL_REVOKED
          : (approval.expiresAt != null && now >= Number(approval.expiresAt)) ? SIDE_EFFECT_ERROR.APPROVAL_EXPIRED
          : SIDE_EFFECT_ERROR.PLAN_STALE;
        return { ok: false, error: reason };
      }
      const lease = this.store.insertLease({ leaseId: _leaseId || undefined, callId, holderId, holderInstanceId: instanceId || this.instanceId, status: LEASE_STATUS.ACTIVE, issuedAt: now, expiresAt: now + Math.max(1, Number(ttlMs) || DEFAULT_LEASE_TTL_MS) });
      this.store.updateCall(callId, { status: CALL_STATUS.LEASED, leased_at: now });
      return { ok: true, duplicate: false, lease };
    });
    if (result.ok) this.#audit({ toolRef: call.toolId, action: "side_effect.lease_acquired", decision: LEASE_STATUS.ACTIVE, reasonCode: null });
    if (result.ok && !result.duplicate) this.#event(call.taskId, "tool.lease_acquired", { callId, leaseId: result.lease.leaseId, holderId });
    return result;
  }

  releaseLease({ callId, leaseId } = {}) {
    const lease = this.store.leaseById(leaseId);
    if (!lease || lease.callId !== callId) return { ok: false, error: SIDE_EFFECT_ERROR.LEASE_NOT_HELD };
    if (lease.status !== LEASE_STATUS.ACTIVE) return { ok: false, error: SIDE_EFFECT_ERROR.LEASE_REQUIRED };
    const now = this.#now();
    const updated = this.store.transactSync(() => this.store.updateLease(leaseId, { status: LEASE_STATUS.RELEASED, released_at: now }));
    const call = this.store.callById(callId);
    if (call && call.status === CALL_STATUS.LEASED) this.store.transactSync(() => this.store.updateCall(callId, { status: CALL_STATUS.APPROVED }));
    const fresh = this.store.callById(callId);
    this.#audit({ toolRef: fresh ? fresh.toolId : null, action: "side_effect.lease_released", decision: LEASE_STATUS.RELEASED, reasonCode: null });
    if (fresh) this.#event(fresh.taskId, "tool.execution_blocked", { callId, leaseId, reason: "LEASE_RELEASED" });
    return { ok: true, lease: updated, call: fresh };
  }

  revokeLease({ callId, leaseId } = {}) {
    const lease = this.store.leaseById(leaseId);
    if (!lease || lease.callId !== callId) return { ok: false, error: SIDE_EFFECT_ERROR.LEASE_NOT_HELD };
    const now = this.#now();
    const updated = this.store.transactSync(() => this.store.updateLease(leaseId, { status: LEASE_STATUS.REVOKED, revoked_at: now }));
    return { ok: true, lease: updated };
  }

  /** 完整 Execution Eligibility（只读；不执行任何 mutation）。 */
  evaluateExecutionEligibility({ context = {}, callId, holderId = null, requestArgumentsHash = null } = {}) {
    const raw = this.store.rawCallById(callId);
    const call = this.store.callById(callId);
    if (!call) return { ok: false, status: ELIGIBILITY.DENIED, reasonCode: SIDE_EFFECT_ERROR.CALL_NOT_FOUND, call: null };
    const task = this.taskStore.taskById(call.taskId);
    const step = call.stepId ? this.taskStore.stepById(call.stepId) : null;
    const runs = this.taskStore.harnessRunsOfTask(call.taskId);
    const latestRunId = runs.length ? runs[runs.length - 1].run_id : null;
    const actor = this.#resolveAgent(context);
    const app = this.authService.store && typeof this.authService.store.appById === "function" && task ? this.authService.store.appById(task.app_id) : null;
    const tool = this.#toolFor(call);
    let authorization = { ok: false };
    if (tool.ok && raw && task) authorization = actor.ok ? this.#authorizeLive({ sessionRef: task.session_ref, appId: task.app_id, preconditions: call.preconditionsSafe }, tool.contract, actor.user.id) : { ok: false };
    const now = this.#now();
    const approvalRow = this.effectiveApproval(callId);
    let approval = null;
    if (approvalRow) approval = { decision: approvalRow.effectiveDecision, plan_hash: approvalRow.planHash, approved_arguments_hash: approvalRow.approvedArgumentsHash, approved_tool_id: approvalRow.approvedToolId, approved_tool_version: approvalRow.approvedToolVersion, approved_effect_class: approvalRow.approvedEffectClass, expires_at: approvalRow.expiresAt, revoked_at: approvalRow.revokedAt };
    const lease = this.store.activeLeaseOfCall(callId);
    const result = evaluateExecutionEligibility({
      call: { ...call, call_id: call.callId, effect_class: call.effectClass, plan_hash: call.planHash, arguments_hash: call.argumentsHash, tool_id: call.toolId, tool_version: call.toolVersion, status: call.status },
      task: task ? { task_id: task.task_id, status: task.status, cancel_requested: task.cancel_requested, user_id: task.user_id, app_id: task.app_id } : null,
      actor: actor.ok ? { ok: true, user: { id: actor.user.id } } : { ok: false },
      app: app ? { status: app.status } : null,
      appId: task ? task.app_id : null,
      step: step ? { task_id: step.task_id, status: step.status } : null,
      runId: call.runId,
      latestRunId,
      tool,
      authorization,
      approval,
      lease: lease ? { call_id: lease.callId, status: lease.status, holder_id: lease.holderId, expires_at: lease.expiresAt } : null,
      holderId,
      planHash: call.planHash,
      argumentsHash: call.argumentsHash,
      requestArgumentsHash,
      preconditionsOk: this.#preconditionsOk(call),
      now,
    });
    if (result.status === ELIGIBILITY.ELIGIBLE) this.#event(call.taskId, "tool.execution_eligible", { callId, toolId: call.toolId });
    return { ok: result.status === ELIGIBILITY.ELIGIBLE, ...result, call };
  }

  /** Crash recovery：RUNNING → UNKNOWN_EFFECT；旧进程 ACTIVE lease → EXPIRED。 */
  recoverOnStartup({ instanceId = this.instanceId, blockTask = false } = {}) {
    const now = this.#now();
    const running = this.store.callsByStatus(CALL_STATUS.RUNNING);
    const unknown = [];
    for (const call of running) {
      this.store.transactSync(() => this.store.updateCall(call.callId, { status: CALL_STATUS.UNKNOWN_EFFECT, error_code: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT, verification_status: null }));
      this.#audit({ toolRef: call.toolId, action: "side_effect.unknown_effect", decision: CALL_STATUS.UNKNOWN_EFFECT, reasonCode: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT });
      this.#event(call.taskId, "tool.side_effect.unknown_effect", { callId: call.callId, toolId: call.toolId });
      if (blockTask && this.taskService) {
        try {
          const task = this.taskStore.taskById(call.taskId);
          if (task && call.stepId) this.taskService.blockStep({ context: { sessionRef: task.session_ref, appId: task.app_id }, taskId: call.taskId, stepId: call.stepId, runId: call.runId, reason: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT, expectedRevision: task.revision });
        } catch { /* recovery 阻塞失败不吞掉 call 状态 */ }
      }
      unknown.push(this.store.callById(call.callId));
    }
    const expiredLeases = [];
    for (const lease of this.store.activeLeases()) {
      if (lease.holderInstanceId && lease.holderInstanceId === instanceId) continue;
      this.store.transactSync(() => this.store.updateLease(lease.leaseId, { status: LEASE_STATUS.EXPIRED }));
      expiredLeases.push(lease.leaseId);
    }
    void now;
    this.lastUnknownEffect = unknown;
    return { ok: true, unknownEffectCalls: unknown, expiredLeases, instanceId };
  }

  /** C1 只定义接口：无 verifier → VERIFICATION_NOT_AVAILABLE，保持 BLOCKED。 */
  async verifyUnknownEffect({ callId } = {}) {
    const call = this.store.callById(callId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    if (call.status !== CALL_STATUS.UNKNOWN_EFFECT) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_STATE };
    const tool = this.#toolFor(call);
    if (!tool.ok || !tool.contract.verificationStrategy) return { ok: false, error: SIDE_EFFECT_ERROR.VERIFICATION_NOT_AVAILABLE, call };
    if (!this.unknownEffectVerifier) return { ok: false, error: SIDE_EFFECT_ERROR.VERIFICATION_NOT_AVAILABLE, call };
    let verdict;
    try { verdict = await this.unknownEffectVerifier({ call, contract: tool.contract }); } catch { verdict = { ok: false }; }
    if (!verdict || !verdict.ok) return { ok: false, error: SIDE_EFFECT_ERROR.VERIFICATION_NOT_AVAILABLE, call };
    const status = verdict.effectApplied ? CALL_STATUS.SUCCEEDED : CALL_STATUS.FAILED;
    const updated = this.store.transactSync(() => this.store.updateCall(callId, { status, verification_status: verdict.effectApplied ? "PASS" : "FAIL", error_code: null }));
    return { ok: true, call: updated, effectApplied: !!verdict.effectApplied };
  }

  /** §75：任何 write 执行入口在本阶段一律 WRITE_EXECUTION_DISABLED。 */
  executeSideEffect() { return { ok: false, error: SIDE_EFFECT_ERROR.WRITE_EXECUTION_DISABLED, executed: false, mutationCount: 0 }; }

  getCall(callId) { return this.store.callById(callId); }
  listApprovals(callId) { return this.store.approvalsOfCall(callId); }
  listLeases(callId) { return this.store.leasesOfCall(callId); }
}

module.exports = { SideEffectAuthority, sanitizeEffects, sanitizePreconditions };
