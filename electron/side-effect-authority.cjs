/**
 * D4-03C1/C2 · Side-effect Authority。
 *
 * 唯一职责：把 **Proposal → Decision → Plan → Approval → Lease → Eligibility**
 * 六层合同落成受信任的 OpenArc Authority。
 * D4-03C1 只判定 eligibility，不执行；D4-03C2 新增**唯一**受控真实写入入口
 * `executeSideEffect`：只有显式声明 executionPolicy = CONTROLLED_REVERSIBLE_WRITE 的
 * contract（本阶段仅 resource.trash）才可能执行。
 * execution ownership = callId + exact leaseId + holderId + runtime instance，其中 runtime
 * instance 只来自 OpenArc 自身（this.instanceId），execute caller 无权声明；缺少任一字段即 DENY。
 * 再在同一 BEGIN IMMEDIATE 事务内重校验 authority snapshot（Task/Step/Run/session/app/tool/
 * resource permission/approval/exact lease/precondition）并原子 claim LEASED → RUNNING，
 * 只有唯一 claim 成功者 dispatch 真实 Domain，最后经真实 Domain verifier PASS 才置 SUCCEEDED。
 *
 * 永久冻结：
 * - callId / idempotencyKey / effectClass / expectedEffects 一律 OpenArc 生成，
 *   Harness payload 中的同名字段无效；
 * - Approval 只来自 trusted user action，绝不来自 Harness / ACP permission / model text；
 * - Approval 与 Lease 是两个独立 authority；有 Approval 无 Lease 不能执行，
 *   有 Lease 无有效 Approval 也不能执行；
 * - Lease 是 side-effect 执行资格，不是业务 Domain 锁（业务 version/lock 另行遵守）；
 * - Runtime identity = this.instanceId，覆盖 acquireLease / evaluateExecutionEligibility /
 *   executeSideEffect / recoverOnStartup：production API 不接受任何 caller runtime override，
 *   同 holderId 不同 runtime instance 的 acquire 一律 LEASE_CONFLICT。
 */
"use strict";
const crypto = require("node:crypto");
const domain = require("./side-effect-domain.cjs");
const toolDomain = require("./tool-domain.cjs");
const {
  CALL_STATUS, APPROVAL_DECISION, LEASE_STATUS, ELIGIBILITY, SIDE_EFFECT_ERROR,
  EXECUTION_POLICY, DEFAULT_APPROVAL_TTL_MS, DEFAULT_LEASE_TTL_MS,
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
  constructor({ registry, sideEffectStore, taskStore, toolStore, authService, adapters = null, clock = null, audit = null, taskService = null, instanceId = null, unknownEffectVerifier = null, testHooks = null } = {}) {
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
    // test-only seam（构造注入）：绝不由 Renderer / Harness 控制，默认 null，不改变 production 语义。
    this.testHooks = testHooks && typeof testHooks === "object" ? testHooks : null;
    this.lastUnknownEffect = null;
  }

  #now() { return this.clock(); }
  /** SQLite 竞争错误识别：只用于把 contention 收敛为安全业务语义，绝不重试 side effect。 */
  #isBusy(e) {
    const s = String((e && (e.errstr || e.message)) || e || "");
    return s.includes("SQLITE_BUSY") || s.includes("SQLITE_LOCKED") || s.includes("database is locked") || s.includes("database table is locked");
  }
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
  acquireLease({ context = {}, callId, holderId, ttlMs = DEFAULT_LEASE_TTL_MS, _leaseId = null } = {}) {
    if (!holderId) return { ok: false, error: SIDE_EFFECT_ERROR.INVALID_INPUT };
    const call = this.store.callById(callId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    if (call.status !== CALL_STATUS.APPROVED && call.status !== CALL_STATUS.LEASED) {
      return { ok: false, error: call.status === CALL_STATUS.AWAITING_APPROVAL ? SIDE_EFFECT_ERROR.APPROVAL_REQUIRED : SIDE_EFFECT_ERROR.CALL_STATE };
    }
    const now = this.#now();
    let result;
    try {
      result = this.store.transactSync(() => {
        const active = this.store.activeLeaseOfCall(callId);
        if (active) {
          if (active.expiresAt != null && now >= Number(active.expiresAt)) this.store.updateLease(active.leaseId, { status: LEASE_STATUS.EXPIRED });
          // duplicate 必须同时匹配 holderId 与 runtime instance；同 holder 不同 runtime = 不同 executor → CONFLICT。
          else if (active.holderId === holderId && active.holderInstanceId === this.instanceId) return { ok: true, duplicate: true, lease: active };
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
        // production：lease 永远绑定 OpenArc runtime 自身 identity，caller 无法修改。
        const lease = this.store.insertLease({ leaseId: _leaseId || undefined, callId, holderId, holderInstanceId: this.instanceId, status: LEASE_STATUS.ACTIVE, issuedAt: now, expiresAt: now + Math.max(1, Number(ttlMs) || DEFAULT_LEASE_TTL_MS) });
        this.store.updateCall(callId, { status: CALL_STATUS.LEASED, leased_at: now });
        return { ok: true, duplicate: false, lease };
      });
    } catch (e) {
      // §12：SQLite contention 不得把裸 SQLITE_BUSY 暴露成"可重试执行"语义；收敛为 LEASE_CONFLICT（fail closed）。
      if (!this.#isBusy(e)) throw e;
      const active = this.store.activeLeaseOfCall(callId);
      result = active ? { ok: false, error: SIDE_EFFECT_ERROR.LEASE_CONFLICT, lease: active } : { ok: false, error: SIDE_EFFECT_ERROR.LEASE_CONFLICT, detail: "SQLITE_CONTENTION" };
      this.#audit({ toolRef: call.toolId, action: "side_effect.lease_contention", decision: "CONFLICT", reasonCode: SIDE_EFFECT_ERROR.LEASE_CONFLICT });
    }
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
  evaluateExecutionEligibility({ context = {}, callId, holderId = null, leaseId = null, requestArgumentsHash = null } = {}) {
    // runtime identity 由 Authority 注入（this.instanceId），普通 caller 不能自报当前 runtime。
    const holderInstanceId = this.instanceId;
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
      lease: lease ? { call_id: lease.callId, lease_id: lease.leaseId, status: lease.status, holder_id: lease.holderId, holder_instance_id: lease.holderInstanceId, expires_at: lease.expiresAt } : null,
      holderId,
      leaseId,
      holderInstanceId,
      planHash: call.planHash,
      argumentsHash: call.argumentsHash,
      requestArgumentsHash,
      preconditionsOk: this.#preconditionsOk(call),
      now,
    });
    if (result.status === ELIGIBILITY.ELIGIBLE) this.#event(call.taskId, "tool.execution_eligible", { callId, toolId: call.toolId });
    return { ok: result.status === ELIGIBILITY.ELIGIBLE, ...result, call };
  }

  /**
   * Crash recovery（fail closed）。
   * RUNNING SideEffectCall → UNKNOWN_EFFECT；并通过 Task Authority 将 Step/Task
   * → BLOCKED / RECOVERY_REQUIRED。**没有 production 开关能跳过 blocking**：
   * blockTask 参数已删除，调用方无法关闭安全策略。
   * 若 TaskService/Task/Step 不可用或状态无法安全 block → 记录安全事件、保持
   * UNKNOWN_EFFECT、禁止 replay/retry，绝不回退成 LEASED/APPROVED/FAILED。
   */
  recoverOnStartup() {
    // runtime identity 只来自 OpenArc 自身；production API 不接受 caller override。
    const instanceId = this.instanceId;
    const running = this.store.callsByStatus(CALL_STATUS.RUNNING);
    const unknown = [];
    const errors = [];
    let recoveredTaskIds = [];
    if (running.length) {
      if (this.taskService && typeof this.taskService.recoverRunning === "function") {
        try {
          const rr = this.taskService.recoverRunning();
          if (rr && rr.ok) recoveredTaskIds = rr.taskIds || [];
          else errors.push({ error: SIDE_EFFECT_ERROR.RECOVERY_REQUIRED, detail: "TASK_RECOVERY_FAILED" });
        } catch {
          errors.push({ error: SIDE_EFFECT_ERROR.RECOVERY_REQUIRED, detail: "TASK_RECOVERY_FAILED" });
        }
      } else {
        errors.push({ error: SIDE_EFFECT_ERROR.RECOVERY_REQUIRED, detail: "TASK_SERVICE_UNAVAILABLE" });
      }
    }
    for (const call of running) {
      // 先无条件进入 UNKNOWN_EFFECT（fail closed）。
      this.store.transactSync(() => this.store.updateCall(call.callId, { status: CALL_STATUS.UNKNOWN_EFFECT, error_code: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT, verification_status: null }));
      this.#audit({ toolRef: call.toolId, action: "side_effect.unknown_effect", decision: CALL_STATUS.UNKNOWN_EFFECT, reasonCode: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT });
      this.#event(call.taskId, "tool.side_effect.unknown_effect", { callId: call.callId, toolId: call.toolId });
      const task = this.taskStore.taskById(call.taskId);
      const step = call.stepId ? this.taskStore.stepById(call.stepId) : null;
      const blocked = !!task && String(task.status) === "BLOCKED" && (!step || String(step.status) === "BLOCKED");
      if (!blocked) {
        const detail = !task ? "TASK_MISSING" : (!step ? "STEP_MISSING" : "TASK_NOT_BLOCKED");
        errors.push({ callId: call.callId, taskId: call.taskId, error: SIDE_EFFECT_ERROR.RECOVERY_REQUIRED, detail });
        this.#audit({ toolRef: call.toolId, action: "side_effect.recovery_blocked", decision: "BLOCKED", reasonCode: detail });
        this.#event(call.taskId, "tool.execution_blocked", { callId: call.callId, reason: SIDE_EFFECT_ERROR.RECOVERY_REQUIRED, detail });
      }
      unknown.push(this.store.callById(call.callId));
    }
    const expiredLeases = [];
    for (const lease of this.store.activeLeases()) {
      // 只有当前 runtime 自己持有的 lease 才保留；其它 instance 的 lease 一律 EXPIRED。
      if (lease.holderInstanceId && lease.holderInstanceId === instanceId) continue;
      this.store.transactSync(() => this.store.updateLease(lease.leaseId, { status: LEASE_STATUS.EXPIRED }));
      expiredLeases.push(lease.leaseId);
    }
    this.lastUnknownEffect = unknown;
    this.lastRecoveryErrors = errors;
    return { ok: errors.length === 0, unknownEffectCalls: unknown, expiredLeases, recoveredTaskIds, errors, instanceId };
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

  /**
   * trusted execution context：user / session / app 全部来自 SideEffectCall 绑定的真实 Task，
   * 绝不重新信任 Harness 或调用方 payload（§11）。
   */
  #executionContext(task) {
    return { sessionRef: task.session_ref, appId: task.app_id, source: "agent", agent: true, requestId: null, actorUserId: task.user_id };
  }

  /** 只结束 lease（release / revoke），不改 call 状态；execution ownership 必须唯一失效。 */
  #finalizeLease(callId, leaseId, status, toolRef = null) {
    if (!leaseId) return null;
    const lease = this.store.leaseById(leaseId);
    if (!lease || lease.callId !== callId || lease.status !== LEASE_STATUS.ACTIVE) return null;
    const now = this.#now();
    const patch = status === LEASE_STATUS.REVOKED ? { status: LEASE_STATUS.REVOKED, revoked_at: now } : { status: LEASE_STATUS.RELEASED, released_at: now };
    const updated = this.store.transactSync(() => this.store.updateLease(leaseId, patch));
    this.#audit({ toolRef, action: status === LEASE_STATUS.REVOKED ? "side_effect.lease_revoked" : "side_effect.lease_released", decision: status, reasonCode: null });
    return updated;
  }

  /** known no-effect：Domain 明确拒绝 / precondition 变化 / verifier 明确未生效 → FAILED，0 retry。 */
  #finishKnownNoEffect({ call, leaseId, error, verificationStatus = null, knownNoEffect = true }) {
    const now = this.#now();
    const status = knownNoEffect ? CALL_STATUS.FAILED : CALL_STATUS.BLOCKED;
    const updated = this.store.transactSync(() => this.store.updateCall(call.callId, { status, error_code: error, completed_at: now, verification_status: verificationStatus }));
    this.#finalizeLease(call.callId, leaseId, LEASE_STATUS.RELEASED, call.toolId);
    this.#audit({ toolRef: call.toolId, action: "side_effect.blocked", decision: status, reasonCode: error });
    this.#event(call.taskId, "tool.side_effect.execution_blocked", { callId: call.callId, toolId: call.toolId, reasonCode: error });
    if (verificationStatus === "FAIL") this.#audit({ toolRef: call.toolId, action: "side_effect.verification_failed", decision: "FAIL", reasonCode: error });
    return { ok: false, executed: true, duplicate: false, mutationCount: 0, call: updated, result: null, verificationStatus, error, knownNoEffect: status === CALL_STATUS.FAILED };
  }

  /**
   * mutation 已 dispatch 但结果无法可靠确认 → UNKNOWN_EFFECT（≠FAILED，绝不 retry）。
   * execution ownership 立即失效（lease REVOKED），Step/Task → BLOCKED / RECOVERY_REQUIRED。
   */
  #finishUnknownEffect({ call, leaseId, detail }) {
    const now = this.#now();
    const updated = this.store.transactSync(() => this.store.updateCall(call.callId, { status: CALL_STATUS.UNKNOWN_EFFECT, error_code: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT, completed_at: now }));
    this.#finalizeLease(call.callId, leaseId, LEASE_STATUS.REVOKED, call.toolId);
    let taskBlocked = false;
    if (this.taskService && typeof this.taskService.blockStep === "function" && call.stepId) {
      const freshTask = this.taskStore.taskById(call.taskId);
      if (freshTask) {
        try {
          const res = this.taskService.blockStep({ context: this.#executionContext(freshTask), taskId: call.taskId, stepId: call.stepId, runId: call.runId, reason: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT, event: "tool.side_effect.unknown_effect", expectedRevision: freshTask.revision });
          taskBlocked = !!(res && res.ok);
        } catch { taskBlocked = false; }
      }
    }
    this.#audit({ toolRef: call.toolId, action: "side_effect.unknown_effect", decision: CALL_STATUS.UNKNOWN_EFFECT, reasonCode: detail || SIDE_EFFECT_ERROR.UNKNOWN_EFFECT });
    this.#event(call.taskId, "tool.side_effect.unknown_effect", { callId: call.callId, toolId: call.toolId, reason: detail || SIDE_EFFECT_ERROR.UNKNOWN_EFFECT });
    if (!taskBlocked) this.#event(call.taskId, "tool.side_effect.execution_blocked", { callId: call.callId, reason: SIDE_EFFECT_ERROR.RECOVERY_REQUIRED });
    return { ok: false, executed: true, duplicate: false, mutationCount: null, call: updated, result: null, verificationStatus: null, error: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT, taskBlocked };
  }

  /**
   * D4-03C2 Closure · claim 事务内的真实 authority snapshot 重校验（TOCTOU → fail closed）。
   *
   * Eligibility(T1) = ELIGIBLE 不是永久 execution authority。Eligibility 与真正 dispatch 之间
   * 任何 persisted authority state 变化（Task/Step/Run/session/app/tool permission/resource
   * permission/useByAgent/approval/lease/precondition）都必须在同一 BEGIN IMMEDIATE 事务内
   * 重新读取并拒绝，0 Domain invocation / 0 mutation。绝不建第二套权限或 execution state。
   */
  #verifyAuthoritySnapshot({ callId, call, expectedLeaseId = null, holderId = null, runtimeInstanceId = null, now }) {
    const failWith = (reason) => ({ ok: false, reason });
    const task = this.taskStore.taskById(call.taskId);
    if (!task) return failWith(SIDE_EFFECT_ERROR.TASK_NOT_FOUND);
    if (task.cancel_requested || String(task.status) === "CANCELLED") return failWith(SIDE_EFFECT_ERROR.TASK_CANCELLED);
    if (String(task.status) !== "RUNNING") return failWith(SIDE_EFFECT_ERROR.TASK_NOT_RUNNING);
    const actor = this.#resolveAgent(this.#executionContext(task));
    if (!actor.ok) return failWith(SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED);
    if (task.user_id !== actor.user.id) return failWith(SIDE_EFFECT_ERROR.TASK_FORBIDDEN);
    const app = this.authService.store && typeof this.authService.store.appById === "function" ? this.authService.store.appById(task.app_id) : null;
    if (!app || String(app.status).toLowerCase() !== "enabled") return failWith(SIDE_EFFECT_ERROR.APP_DISABLED);
    const step = call.stepId ? this.taskStore.stepById(call.stepId) : null;
    if (!step || step.task_id !== call.taskId || String(step.status) !== "RUNNING") return failWith(SIDE_EFFECT_ERROR.STEP_NOT_RUNNING);
    const runs = this.taskStore.harnessRunsOfTask(call.taskId);
    const latestRunId = runs.length ? runs[runs.length - 1].run_id : null;
    if (!call.runId || !latestRunId || call.runId !== latestRunId) return failWith(SIDE_EFFECT_ERROR.STALE_RUN);
    const tool = this.#toolFor(call);
    if (!tool.ok) return failWith(tool.error === "TOOL_DISABLED" ? SIDE_EFFECT_ERROR.TOOL_DISABLED : tool.error);
    if (effectClassForRisk(tool.contract.riskClass) !== String(call.effectClass)) return failWith(SIDE_EFFECT_ERROR.TOOL_VERSION_CHANGED);
    const authorization = this.#authorizeLive({ sessionRef: task.session_ref, appId: task.app_id, preconditions: call.preconditionsSafe }, tool.contract, actor.user.id);
    if (!authorization.ok) return failWith(SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED);
    if (!this.#preconditionsOk(call)) return failWith(SIDE_EFFECT_ERROR.PRECONDITION_CHANGED);
    const approval = this.store.latestApprovalOfCall(callId);
    // claim-time approval binding 不得比 Eligibility 更弱：plan/args/tool/version/effectClass 全部精确匹配。
    const approvalOk = approval && approval.decision === APPROVAL_DECISION.APPROVED && approval.revokedAt == null
      && (approval.expiresAt == null || now < Number(approval.expiresAt))
      && approval.planHash === call.planHash
      && approval.approvedArgumentsHash === call.argumentsHash
      && approval.approvedToolId === call.toolId
      && Number(approval.approvedToolVersion) === Number(call.toolVersion)
      && approval.approvedEffectClass === call.effectClass;
    if (!approvalOk) {
      const reason = !approval ? SIDE_EFFECT_ERROR.APPROVAL_REQUIRED
        : approval.decision === APPROVAL_DECISION.REVOKED ? SIDE_EFFECT_ERROR.APPROVAL_REVOKED
        : (approval.expiresAt != null && now >= Number(approval.expiresAt)) ? SIDE_EFFECT_ERROR.APPROVAL_EXPIRED
        : SIDE_EFFECT_ERROR.PLAN_STALE;
      return failWith(reason);
    }
    // exact lease authority：active lease 必须就是 expectedLeaseId，且 holder + runtime instance 全匹配。
    const lease = this.store.activeLeaseOfCall(callId);
    if (!lease || String(lease.status) !== LEASE_STATUS.ACTIVE) return failWith(SIDE_EFFECT_ERROR.LEASE_REQUIRED);
    if (lease.callId !== callId) return failWith(SIDE_EFFECT_ERROR.LEASE_REQUIRED);
    if (expectedLeaseId != null && lease.leaseId !== expectedLeaseId) return failWith(SIDE_EFFECT_ERROR.LEASE_NOT_HELD);
    if (holderId != null && lease.holderId !== holderId) return failWith(SIDE_EFFECT_ERROR.LEASE_NOT_HELD);
    if (runtimeInstanceId != null && lease.holderInstanceId !== runtimeInstanceId) return failWith(SIDE_EFFECT_ERROR.LEASE_NOT_HELD);
    if (lease.expiresAt != null && now >= Number(lease.expiresAt)) return failWith(SIDE_EFFECT_ERROR.LEASE_EXPIRED);
    return { ok: true, leaseId: lease.leaseId };
  }

  /**
   * D4-03C2 · 受控真实 REVERSIBLE_WRITE 执行入口（只由 OpenArc trusted code 调用，Harness 无权）。
   *
   * 只有显式声明 executionPolicy = CONTROLLED_REVERSIBLE_WRITE 的 contract 才可能执行；
   * 其余 write contract（含 test.write）一律 WRITE_EXECUTION_DISABLED，绝不因为本方法存在
   * 就自动获得执行能力。dispatch Domain mutation 前先原子 claim LEASED → RUNNING，
   * 只有唯一 claim 成功的 executor 才能调用真实 Domain。
   */
  executeSideEffect({ callId = null, leaseId = null, holderId = null, timeoutMs = 15000 } = {}) {
    const want = (error, extra = {}) => ({ ok: false, executed: false, duplicate: false, mutationCount: 0, call: this.store.callById(callId), error, ...extra });
    // runtime identity 只来自 OpenArc 自身（this.instanceId）。调用方提供的任何 holderInstanceId
    // 一律被忽略（本方法不再接受该参数），绝不能用来声明"我是哪个 runtime"。
    const runtimeInstanceId = this.instanceId;
    // 保留 C1 语义：无 authority call 时任何 write 执行入口一律 WRITE_EXECUTION_DISABLED。
    if (!callId) return want(SIDE_EFFECT_ERROR.WRITE_EXECUTION_DISABLED);
    const call = this.store.callById(callId);
    if (!call) return want(SIDE_EFFECT_ERROR.CALL_NOT_FOUND);
    const tool = this.#toolFor(call);
    if (!tool.ok) return want(tool.error === "TOOL_DISABLED" ? SIDE_EFFECT_ERROR.TOOL_DISABLED : tool.error);
    if (tool.contract.executionPolicy !== EXECUTION_POLICY.CONTROLLED_REVERSIBLE_WRITE) return want(SIDE_EFFECT_ERROR.WRITE_EXECUTION_DISABLED);
    // execution ownership = callId + exact leaseId + holderId + this.instanceId。
    if (!leaseId || !holderId) return want(SIDE_EFFECT_ERROR.LEASE_NOT_HELD, { detail: "EXECUTOR_IDENTITY_REQUIRED" });
    if (call.status === CALL_STATUS.SUCCEEDED) return { ok: true, executed: false, duplicate: true, mutationCount: 0, call, result: null, verificationStatus: call.verificationStatus, error: null };
    if (call.status === CALL_STATUS.RUNNING) return want(SIDE_EFFECT_ERROR.EXECUTION_CLAIM_LOST, { duplicate: true });
    if (call.status !== CALL_STATUS.LEASED) return want(SIDE_EFFECT_ERROR.CALL_STATE);

    const task = this.taskStore.taskById(call.taskId);
    if (!task) return want(SIDE_EFFECT_ERROR.TASK_NOT_FOUND);
    const execCtx = this.#executionContext(task);
    const adapter = this.adapterFor ? this.adapterFor({ executionProvider: tool.contract.executionProvider, toolId: tool.contract.toolId }) : null;
    if (!adapter || typeof adapter.execute !== "function" || typeof adapter.verify !== "function") return want(SIDE_EFFECT_ERROR.WRITE_EXECUTION_DISABLED);

    // 执行前完整 eligibility（tool/run/authorization/approval/lease/precondition 全部实时重查）。
    const elig = this.evaluateExecutionEligibility({ context: execCtx, callId, holderId, leaseId });
    if (elig.status !== ELIGIBILITY.ELIGIBLE) {
      this.#audit({ toolRef: call.toolId, action: "side_effect.blocked", decision: "BLOCKED", reasonCode: elig.reasonCode });
      this.#event(call.taskId, "tool.side_effect.execution_blocked", { callId, toolId: call.toolId, reasonCode: elig.reasonCode });
      return want(elig.reasonCode || SIDE_EFFECT_ERROR.CALL_STATE, { eligibility: elig.status });
    }
    const active = this.store.activeLeaseOfCall(callId);
    if (!active) return want(SIDE_EFFECT_ERROR.LEASE_REQUIRED);
    if (active.leaseId !== leaseId) return want(SIDE_EFFECT_ERROR.LEASE_NOT_HELD);
    if (active.holderId !== holderId) return want(SIDE_EFFECT_ERROR.LEASE_NOT_HELD);
    if (active.holderInstanceId !== runtimeInstanceId) return want(SIDE_EFFECT_ERROR.LEASE_NOT_HELD);

    // test-only seam：在 eligibility 与 claim 之间注入真实 authority state 变化（production 为 null）。
    if (this.testHooks && typeof this.testHooks.afterEligibilityBeforeClaim === "function") {
      this.testHooks.afterEligibilityBeforeClaim({ callId, holderId, leaseId, runtimeInstanceId });
    }

    // 原子 claim：LEASED → RUNNING，并在同一 BEGIN IMMEDIATE 事务内重校验 authority snapshot。
    const now = this.#now();
    let claim;
    try {
      claim = this.store.transactSync(() => {
        const fresh = this.store.rawCallById(callId);
        if (!fresh || fresh.status !== CALL_STATUS.LEASED) {
          const st = fresh && fresh.status;
          return { claimed: false, reason: (st === CALL_STATUS.RUNNING || st === CALL_STATUS.SUCCEEDED) ? SIDE_EFFECT_ERROR.EXECUTION_CLAIM_LOST : SIDE_EFFECT_ERROR.CALL_STATE };
        }
        const freshCall = this.store.callById(callId);
        const snap = this.#verifyAuthoritySnapshot({ callId, call: freshCall, expectedLeaseId: leaseId, holderId, runtimeInstanceId, now });
        if (!snap.ok) return { claimed: false, reason: snap.reason };
        this.store.updateCall(callId, { status: CALL_STATUS.RUNNING, started_at: now });
        return { claimed: true, leaseId: snap.leaseId };
      });
    } catch (e) {
      // 真实 cross-connection contention 绝不暴露为可 retry 语义；收敛为 CLAIM_LOST。
      if (!this.#isBusy(e)) throw e;
      claim = { claimed: false, reason: SIDE_EFFECT_ERROR.EXECUTION_CLAIM_LOST };
    }
    if (!claim.claimed) {
      this.#audit({ toolRef: call.toolId, action: "side_effect.blocked", decision: "BLOCKED", reasonCode: claim.reason });
      this.#event(call.taskId, "tool.side_effect.execution_blocked", { callId, toolId: call.toolId, reasonCode: claim.reason });
      return want(claim.reason);
    }
    this.#audit({ toolRef: call.toolId, action: "side_effect.execution_started", decision: CALL_STATUS.RUNNING, reasonCode: null });
    this.#event(call.taskId, "tool.side_effect.execution_started", { callId, toolId: call.toolId, leaseId: claim.leaseId });

    // claim 之后（execution ownership 唯一）才 dispatch Domain mutation。
    return this.#dispatchControlledWrite({ call, tool, execCtx, adapter, leaseId: claim.leaseId, timeoutMs });
  }

  /** claim 成功后的唯一 Domain dispatch + verify + finalize（异步）。 */
  async #dispatchControlledWrite({ call, tool, execCtx, adapter, leaseId, timeoutMs }) {
    // args 只来自持久化的 trusted plan（preconditionsSafe），不来自 Harness。
    const args = call.preconditionsSafe && call.preconditionsSafe.resourceRef ? { resourceRef: call.preconditionsSafe.resourceRef } : {};
    let execResult;
    try {
      const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 15000;
      let timer = null;
      const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("SIDE_EFFECT_TIMEOUT"), { code: "SIDE_EFFECT_TIMEOUT" })), timeout); });
      execResult = await Promise.race([adapter.execute({ context: execCtx, args, contract: tool.contract, preconditions: call.preconditionsSafe }), guard]).finally(() => clearTimeout(timer));
    } catch (e) {
      return this.#finishUnknownEffect({ call, leaseId, detail: (e && e.code) || "SIDE_EFFECT_DISPATCH_ERROR" });
    }
    if (!execResult || execResult.ambiguous === true) return this.#finishUnknownEffect({ call, leaseId, detail: (execResult && execResult.error) || SIDE_EFFECT_ERROR.UNKNOWN_EFFECT });
    if (!execResult.ok) return this.#finishKnownNoEffect({ call, leaseId, error: execResult.error || SIDE_EFFECT_ERROR.DOMAIN_WRITE_FAILED, knownNoEffect: execResult.knownNoEffect !== false });

    // Execution != Verified Effect：必须真实 Domain verification 通过才允许 SUCCEEDED。
    let verdict;
    try { verdict = await adapter.verify({ context: execCtx, args, result: execResult.result, contract: tool.contract }); }
    catch { return this.#finishUnknownEffect({ call, leaseId, detail: "VERIFIER_UNAVAILABLE" }); }
    if (!verdict || verdict.ok !== true) return this.#finishUnknownEffect({ call, leaseId, detail: "VERIFIER_UNAVAILABLE" });
    if (verdict.applied !== true) return this.#finishKnownNoEffect({ call, leaseId, error: SIDE_EFFECT_ERROR.VERIFICATION_FAILED, verificationStatus: "FAIL", knownNoEffect: true });

    const completedAt = this.#now();
    const updated = this.store.transactSync(() => this.store.updateCall(call.callId, { status: CALL_STATUS.SUCCEEDED, verification_status: "PASS", completed_at: completedAt, error_code: null }));
    this.#finalizeLease(call.callId, leaseId, LEASE_STATUS.RELEASED, call.toolId);
    this.#audit({ toolRef: call.toolId, action: "side_effect.verification_passed", decision: "PASS", reasonCode: null });
    this.#event(call.taskId, "tool.side_effect.verification_passed", { callId: call.callId, toolId: call.toolId, verificationStatus: "PASS" });
    this.#audit({ toolRef: call.toolId, action: "side_effect.succeeded", decision: CALL_STATUS.SUCCEEDED, reasonCode: null });
    this.#event(call.taskId, "tool.side_effect.succeeded", { callId: call.callId, toolId: call.toolId });
    return { ok: true, executed: true, duplicate: false, mutationCount: 1, call: updated, result: execResult.result, verificationStatus: "PASS", error: null };
  }

  getCall(callId) { return this.store.callById(callId); }
  listApprovals(callId) { return this.store.approvalsOfCall(callId); }
  listLeases(callId) { return this.store.leasesOfCall(callId); }
}

module.exports = { SideEffectAuthority, sanitizeEffects, sanitizePreconditions };
