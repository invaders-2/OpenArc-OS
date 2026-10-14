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
 *   同 holderId 不同 runtime instance 的 acquire 一律 LEASE_CONFLICT；
 * - UNKNOWN_EFFECT 只允许 VERIFY → BLOCK：真实 read-only 历史合同 Domain verifier 给
 *   APPLIED / NOT_APPLIED / INDETERMINATE；只有 APPLIED 或 (NOT_APPLIED + executionQuiesced)
 *   才 authoritative 收敛，AUTO_RETRY 永远为 0；
 * - executor 落定任何收敛结果（SUCCEEDED / FAILED / BLOCKED / UNKNOWN_EFFECT）前必须在
 *   同一事务内重读 persisted status：另一个 runtime 已收敛（如 RUNNING → UNKNOWN_EFFECT）时，
 *   迟到结果绝不覆盖任何持久化字段，只落 safe 事件 tool.side_effect.late_result_suppressed；
 * - 收敛结果与自身 ACTIVE lease 的终结必在**同一事务**内，绝不留下"终态 + ACTIVE lease"；
 * - acquireLease 的状态判定与租约发放必在**同一事务**内：只对 persisted status ∈
 *   {APPROVED, LEASED} 发放，RUNNING / 任何终态绝不因迟到申请被改写成 LEASED，拒绝路径零写入。
 */
"use strict";
const crypto = require("node:crypto");
const domain = require("./side-effect-domain.cjs");
const toolDomain = require("./tool-domain.cjs");
const {
  CALL_STATUS, EFFECT_CLASS, APPROVAL_DECISION, LEASE_STATUS, ELIGIBILITY, SIDE_EFFECT_ERROR,
  EXECUTION_POLICY, DEFAULT_APPROVAL_TTL_MS, DEFAULT_LEASE_TTL_MS,
  effectClassForRisk, isC1EffectClass, executionPolicyForEffectClass, planHashOf, idempotencyKeyOf, fingerprint,
  evaluateExecutionEligibility,
} = domain;
const { isWellFormedToolId } = toolDomain;

const newId = (prefix) => prefix + "_" + crypto.randomBytes(10).toString("base64url");
const SAFE_EFFECT = /^(secret|token|authorization|api[_-]?key|credential|password|bearer)/i;
/**
 * DENY 只对"尚未进入不可撤回执行阶段"的 call 有资格：LEASED 表示 executor 可能已 spawn
 * 但还没 commit claim，claim 事务会重读 persisted status，所以此刻仍可拒绝。
 * RUNNING 与任何终态（SUCCEEDED / FAILED / BLOCKED / CANCELLED / UNKNOWN_EFFECT）一律迟到。
 */
const DENIABLE_CALL_STATUS = Object.freeze([CALL_STATUS.AWAITING_APPROVAL, CALL_STATUS.APPROVED, CALL_STATUS.LEASED]);
/**
 * acquireLease 的资格状态：只有尚未进入执行阶段（未 claim）的 call 才能发放租约。
 * 判定必须与发放同事务并读 persisted status —— 有效 approval 不等于调用仍可执行，
 * RUNNING / 任何终态绝不能被迟到申请改写回 LEASED。
 */
const isLeasableStatus = (status) => status === CALL_STATUS.APPROVED || status === CALL_STATUS.LEASED;
/** 不可租用时保持既有错误码映射：AWAITING_APPROVAL → APPROVAL_REQUIRED，其余 → CALL_STATE。 */
const leaseRejectError = (status) => (status === CALL_STATUS.AWAITING_APPROVAL ? SIDE_EFFECT_ERROR.APPROVAL_REQUIRED : SIDE_EFFECT_ERROR.CALL_STATE);
/** 迟到 DENY 的显式错误码：只作为 trusted 用户动作的返回值与 audit reason，绝不写进 call.error_code。 */
const DENY_TOO_LATE = "SIDE_EFFECT_APPROVAL_TOO_LATE";
/** 撤销与 DENY 共用同一个迟到错误码：claim 之后的 trusted 用户动作一律显式迟到。 */
const REVOKE_TOO_LATE = DENY_TOO_LATE;
/** 批准资格类失败：claim 之前发现即按"拒绝的等价物"收敛（BLOCKED），而不是留给运行时判 FAILED。 */
const APPROVER_ERRORS = Object.freeze([SIDE_EFFECT_ERROR.APPROVER_INELIGIBLE, SIDE_EFFECT_ERROR.APPROVER_UNVERIFIED]);

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
/**
 * preconditions 只允许 safe refs + version/hash，绝不复制业务对象。
 *
 * D5-01 Closure-2：新增 `url` —— 受控浏览器导航的**目标地址必须随 plan 一起持久化**，
 * 否则 claim 之后就只能从 Harness 入参再取一次，"批准的东西"和"执行的东西"会分叉。
 * `url` 有独立上界（见 PRECONDITION_STRING_MAX），因为它比 resourceRef 长得多。
 */
const PRECONDITION_KEYS = new Set(["resourceRef", "expectedVersion", "expectedHash", "targetRef", "targetType", "registryStatus", "updatedAt", "url",
  // D5-02：画布编辑的**基准 revision + 命令 + 命令指纹**必须随 plan 一起持久化 —— 否则 claim 之后只能从
  // Harness 入参再取一次，"批准的命令"和"执行的任务"会分叉（与 D5-01 的 url 同一口径；execute / verify /
  // recoveryVerify 都只读这份快照，commandFingerprint 还要与画布命令日志**逐字节**比对）。
  "revision", "commandFingerprint", "command"]);
/** 每个 key 的字符串上界；未列出的沿用 300。 */
const PRECONDITION_STRING_MAX = Object.freeze({ url: 2000, commandFingerprint: 2000 });
/** command 是结构化执行入参：与 commandFingerprint 同一预算；超界一律丢弃该 key（fail closed，绝不截断）。 */
const PRECONDITION_OBJECT_MAX = 2000;
function sanitizePreconditions(pre) {
  const out = {};
  if (!pre || typeof pre !== "object") return out;
  for (const [k, v] of Object.entries(pre)) {
    if (!PRECONDITION_KEYS.has(k)) continue;
    if (k === "command") {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      let blob = null;
      try { blob = JSON.stringify(v); } catch { continue; }
      if (typeof blob !== "string" || blob.length > PRECONDITION_OBJECT_MAX) continue;
      out[k] = v;
      continue;
    }
    if (typeof v !== "string") { out[k] = v; continue; }
    const max = PRECONDITION_STRING_MAX[k] == null ? 300 : PRECONDITION_STRING_MAX[k];
    // url 是**执行入参**：截断等于把目标换成另一个地址，所以超界一律丢弃该 key（fail closed），绝不截断。
    if (v.length > max) continue;
    out[k] = max === 300 ? safeString(v, 300) : v;
  }
  return out;
}

class SideEffectAuthority {
  constructor({ registry, sideEffectStore, taskStore, toolStore, authService, adapters = null, clock = null, audit = null, taskService = null, instanceId = null, lifecycle = null, testHooks = null } = {}) {
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
    // trusted Runtime Quiescence / Liveness Authority：唯一能证明"旧 runtime 已死"的来源。
    this.lifecycle = lifecycle && typeof lifecycle.isQuiesced === "function" ? lifecycle : null;
    this.instanceId = instanceId || "runtime_" + crypto.randomBytes(6).toString("base64url");
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
    // latestApprovalOfCall 返回 store 的 safe 投影（camelCase）：读 expires_at 会让过期分支永不成立。
    if (row.decision === APPROVAL_DECISION.APPROVED && row.expiresAt != null && this.#now() >= Number(row.expiresAt)) return { ...row, effectiveDecision: APPROVAL_DECISION.EXPIRED };
    return { ...row, effectiveDecision: row.decision };
  }

  /**
   * 批准人资格（唯一实现）：信任只来自持久化 approval 行的 actor_user_id。
   * 只回答"这条批准此刻是否仍然成立"，因此**只看**身份是否存在 + ACTIVE + 批准范围（owner 或 ADMIN）；
   * 登出 / 会话过期不撤销批准，也不要求批准人拥有执行主体的全部权限（那些由既有 authorization gate 判定）。
   * 缺 actor 的历史批准一律保守拒绝，绝不伪造身份。
   */
  #approverEligibility({ approval, task }) {
    const actorUserId = approval && approval.actorUserId != null ? String(approval.actorUserId) : "";
    if (!actorUserId) return { ok: false, error: SIDE_EFFECT_ERROR.APPROVER_UNVERIFIED };
    const identity = this.authService ? this.authService.identity : null;
    const user = identity && typeof identity.userById === "function" ? identity.userById(actorUserId) : null;
    if (!user) return { ok: false, error: SIDE_EFFECT_ERROR.APPROVER_INELIGIBLE };
    if (String(user.status) !== "ACTIVE") return { ok: false, error: SIDE_EFFECT_ERROR.APPROVER_INELIGIBLE };
    const stillOwner = !!task && String(user.id) === String(task.user_id);
    const stillAdmin = String(user.role) === "ADMIN";
    if (!stillOwner && !stillAdmin) return { ok: false, error: SIDE_EFFECT_ERROR.APPROVER_INELIGIBLE };
    return { ok: true };
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
    // REVERSIBLE_WRITE 沿用 C1 合同（plan 即可，执行再判 policy）；EXTERNAL_SIDE_EFFECT 是 D5-04 新开的
    // 唯一另一类：必须由 contract 显式声明 CONTROLLED_EXTERNAL_EFFECT 才准立项，否则与
    // IRREVERSIBLE / PRIVILEGED 同样 BLOCKED —— 绝不因为存在外部 adapter 就获得执行能力。
    if (effectClass === EFFECT_CLASS.EXTERNAL_SIDE_EFFECT) {
      if (contract.executionPolicy !== EXECUTION_POLICY.CONTROLLED_EXTERNAL_EFFECT) return { ok: false, error: SIDE_EFFECT_ERROR.EFFECT_CLASS_BLOCKED };
    } else if (!isC1EffectClass(effectClass)) {
      return { ok: false, error: SIDE_EFFECT_ERROR.EFFECT_CLASS_BLOCKED };
    }
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
    const now = this.#now();
    const expiresAt = now + Math.max(1, Number(ttlMs) || DEFAULT_APPROVAL_TTL_MS);
    // 批准资格只能由事务内重读的 persisted status 决定：approve 与 deny 是两个并发写者，
    // 事务外读取 + 分两次写会把已被拒绝的决定复活成 APPROVED（DENY 决定被改写）。
    let outcome = null;
    this.store.transactSync(() => {
      const fresh = this.store.callById(callId);
      const observedStatus = fresh ? String(fresh.status) : null;
      if (observedStatus !== CALL_STATUS.AWAITING_APPROVAL && observedStatus !== CALL_STATUS.APPROVED) {
        outcome = { failed: SIDE_EFFECT_ERROR.CALL_STATE, call: fresh };
        return;
      }
      // §36 concurrent approval click：同一绑定下重复 Approve 是幂等的，
      // 只产生一个 authoritative approval transition，绝不第二次 approve。
      if (observedStatus === CALL_STATUS.APPROVED) {
        const prior = this.store.latestApprovalOfCall(callId);
        if (prior && prior.decision === APPROVAL_DECISION.APPROVED && prior.revokedAt == null && prior.planHash === fresh.planHash) {
          outcome = { duplicate: true, call: fresh, approval: prior };
          return;
        }
      }
      const approval = this.store.insertApproval({
        callId, actorUserId: actor.user.id, sessionRef: context.sessionRef, decision: APPROVAL_DECISION.APPROVED, planHash: fresh.planHash,
        approvedToolId: fresh.toolId, approvedToolVersion: fresh.toolVersion, approvedArgumentsHash: fresh.argumentsHash,
        approvedEffectClass: fresh.effectClass, approvedExpectedEffects: fresh.expectedEffectsSafe, createdAt: now, expiresAt,
      });
      outcome = { duplicate: false, call: this.store.updateCall(callId, { status: CALL_STATUS.APPROVED, approved_at: now }), approval };
    });
    if (outcome.failed) return { ok: false, error: outcome.failed };
    if (outcome.duplicate) return { ok: true, duplicate: true, call: outcome.call, approval: outcome.approval };
    this.#audit({ actorUserId: actor.user.id, appId: context.appId, toolRef: call.toolId, action: "side_effect.approved", decision: APPROVAL_DECISION.APPROVED, reasonCode: null });
    this.#event(call.taskId, "tool.approved", { callId, approvalId: outcome.approval.approvalId, expiresAt });
    return { ok: true, call: outcome.call, approval: outcome.approval };
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
    // DENY 的资格只能由事务内重读的 persisted status 决定：DENY 与 claim 是两个并发写者，
    // 事务外的 status 读取会让"执行已开始/已完成"的执行事实被一个用户动作改写。
    let outcome = null;
    this.store.transactSync(() => {
      const fresh = this.store.callById(callId);
      const observedStatus = fresh ? String(fresh.status) : null;
      if (!DENIABLE_CALL_STATUS.includes(observedStatus)) {
        const prior = this.effectiveApproval(callId);
        // 幂等例外：此前同一 DENY 已生效（BLOCKED + DENIED）才是重复点击，其余迟到一律不写。
        outcome = {
          late: true, observedStatus, call: fresh,
          duplicate: observedStatus === CALL_STATUS.BLOCKED && !!prior && prior.effectiveDecision === APPROVAL_DECISION.DENIED,
        };
        return;
      }
      const approval = this.store.insertApproval({ callId, actorUserId: actor.user.id, sessionRef: context.sessionRef, decision: APPROVAL_DECISION.DENIED, planHash: call.planHash, createdAt: now });
      // A-4：BLOCKED 之后不可能再执行，其 ACTIVE lease 必须在同一事务内终结，
      // 否则同一进程内 append/runTask 会被残留 ACTIVE_LEASE 永久拦住。
      const active = this.store.activeLeaseOfCall(callId);
      const revokedLease = active ? this.#finalizeLeaseInTx(callId, active.leaseId, LEASE_STATUS.REVOKED) : null;
      outcome = { late: false, approval, revokedLease, call: this.store.updateCall(callId, { status: CALL_STATUS.BLOCKED, error_code: SIDE_EFFECT_ERROR.APPROVAL_DENIED }) };
    });
    if (outcome.late) {
      // 幂等：绝不报错、绝不写第二行 approval、绝不再改状态。
      if (outcome.duplicate) return { ok: true, duplicate: true, callStatus: outcome.observedStatus, callId, call: outcome.call };
      // 迟到 DENY 绝不中止正在进行的执行、绝不动 lease，也不伪装成"已阻止执行"：
      // 只落 safe audit + safe TaskEvent，供审计，并回显式、稳定、可直接展示的错误码。
      this.#audit({ actorUserId: actor.user.id, appId: context.appId, toolRef: call.toolId, action: "side_effect.deny_too_late", decision: outcome.observedStatus, reasonCode: DENY_TOO_LATE });
      this.#event(call.taskId, "tool.side_effect.deny_too_late", { callId, toolId: call.toolId, observedStatus: outcome.observedStatus });
      return { ok: false, error: DENY_TOO_LATE, callStatus: outcome.observedStatus, callId, call: outcome.call };
    }
    if (outcome.revokedLease) this.#auditLeaseFinalized(call.toolId, LEASE_STATUS.REVOKED);
    this.#audit({ actorUserId: actor.user.id, appId: context.appId, toolRef: call.toolId, action: "side_effect.denied", decision: APPROVAL_DECISION.DENIED, reasonCode: null });
    this.#event(call.taskId, "tool.denied", { callId, approvalId: outcome.approval.approvalId });
    return { ok: true, call: outcome.call, approval: outcome.approval };
  }

  /**
   * trusted user 撤销批准（与 DENY 同法的状态机）：资格判定 + 变更同一事务；
   * 仍在"可拒绝、尚未进入不可撤回执行阶段"时撤销生效；claim 之后一律显式迟到、状态零变化。
   */
  revokeApproval({ context = {}, callId } = {}) {
    const actor = this.#resolveTrustedUser(context);
    if (!actor.ok) return { ok: false, error: actor.error };
    const call = this.store.callById(callId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    const task = this.taskStore.taskById(call.taskId);
    if (!task) return { ok: false, error: SIDE_EFFECT_ERROR.TASK_NOT_FOUND };
    if (task.user_id !== actor.user.id && actor.user.role !== "ADMIN") return { ok: false, error: SIDE_EFFECT_ERROR.APPROVAL_FORBIDDEN };
    const now = this.#now();
    // 撤销资格只能由事务内重读的 persisted status 决定：撤销与 claim / approve 是并发写者。
    let outcome = null;
    this.store.transactSync(() => {
      const fresh = this.store.callById(callId);
      const observedStatus = fresh ? String(fresh.status) : null;
      if (observedStatus === CALL_STATUS.APPROVED || observedStatus === CALL_STATUS.LEASED) {
        const latest = this.store.latestApprovalOfCall(callId);
        const approval = latest && latest.decision !== APPROVAL_DECISION.REVOKED
          ? this.store.updateApproval(latest.approvalId, { decision: APPROVAL_DECISION.REVOKED, revoked_at: now })
          : latest;
        // A-4：BLOCKED 之后不可能再执行，其 ACTIVE lease 必须在同一事务内终结。
        const active = this.store.activeLeaseOfCall(callId);
        const revokedLease = active ? this.#finalizeLeaseInTx(callId, active.leaseId, LEASE_STATUS.REVOKED) : null;
        outcome = { revoked: true, revokedLease, approval, call: this.store.updateCall(callId, { status: CALL_STATUS.BLOCKED, error_code: SIDE_EFFECT_ERROR.APPROVAL_REVOKED, completed_at: now }) };
        return;
      }
      if (observedStatus === CALL_STATUS.BLOCKED) {
        const latest = this.store.latestApprovalOfCall(callId);
        // 幂等：此前同一撤销已生效（BLOCKED + REVOKED）→ 零写入；其余 BLOCKED（DENY / 超时）不是撤销。
        outcome = latest && latest.decision === APPROVAL_DECISION.REVOKED
          ? { duplicate: true, observedStatus, call: fresh }
          : { tooLate: true, observedStatus, call: fresh };
        return;
      }
      if (observedStatus === CALL_STATUS.AWAITING_APPROVAL) { outcome = { required: true, observedStatus, call: fresh }; return; }
      outcome = { tooLate: true, observedStatus, call: fresh };
    });
    if (outcome.revoked) {
      if (outcome.revokedLease) this.#auditLeaseFinalized(call.toolId, LEASE_STATUS.REVOKED);
      this.#audit({ actorUserId: actor.user.id, appId: context.appId, toolRef: call.toolId, action: "side_effect.approval_revoked", decision: APPROVAL_DECISION.REVOKED, reasonCode: null });
      this.#event(call.taskId, "tool.denied", { callId, approvalId: outcome.approval ? outcome.approval.approvalId : null, reason: SIDE_EFFECT_ERROR.APPROVAL_REVOKED });
      // 撤销 = 拒绝的等价物：Step/Task 与 DENY / 批准资格失效同口径收敛 BLOCKED。
      this.#blockStepForRejectedCall(call, SIDE_EFFECT_ERROR.APPROVAL_REVOKED);
      return { ok: true, revoked: true, callStatus: CALL_STATUS.BLOCKED, call: outcome.call, approval: outcome.approval };
    }
    if (outcome.duplicate) return { ok: true, duplicate: true, callStatus: outcome.observedStatus, callId, call: outcome.call };
    if (outcome.required) return { ok: false, error: SIDE_EFFECT_ERROR.APPROVAL_REQUIRED, callStatus: outcome.observedStatus, callId, call: outcome.call };
    // claim 之后的撤销绝不中止执行、不动 lease、不覆盖执行事实：只落 safe audit + safe TaskEvent。
    this.#audit({ actorUserId: actor.user.id, appId: context.appId, toolRef: call.toolId, action: "side_effect.revoke_too_late", decision: outcome.observedStatus, reasonCode: REVOKE_TOO_LATE });
    this.#event(call.taskId, "tool.side_effect.revoke_too_late", { callId, toolId: call.toolId, observedStatus: outcome.observedStatus });
    return { ok: false, error: REVOKE_TOO_LATE, callStatus: outcome.observedStatus, callId, call: outcome.call };
  }

  /** 每个 call 至多一个 ACTIVE lease；同一 holder 重复 acquire 幂等返回既有 lease。 */
  acquireLease({ context = {}, callId, holderId, ttlMs = DEFAULT_LEASE_TTL_MS, _leaseId = null } = {}) {
    if (!holderId) return { ok: false, error: SIDE_EFFECT_ERROR.INVALID_INPUT };
    const call = this.store.callById(callId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    if (!isLeasableStatus(call.status)) return { ok: false, error: leaseRejectError(call.status) };
    const now = this.#now();
    let result;
    try {
      result = this.store.transactSync(() => {
        // 事务内重读 persisted status：另一连接可能已把 call 推进到 RUNNING / 终态，
        // 旧读不得继续作为发放租约的依据（有效 approval 不等于调用仍可执行）。
        const fresh = this.store.callById(callId);
        if (!fresh) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
        if (!isLeasableStatus(fresh.status)) return { ok: false, error: leaseRejectError(fresh.status) };
        const active = this.store.activeLeaseOfCall(callId);
        // 过期 lease 的终结推迟到确认可发放新租约之后：任何拒绝路径都零写入，绝不提前改写已有租约。
        let superseded = null;
        if (active) {
          if (active.expiresAt != null && now >= Number(active.expiresAt)) superseded = active;
          // duplicate 必须同时匹配 holderId 与 runtime instance；同 holder 不同 runtime = 不同 executor → CONFLICT。
          else if (active.holderId === holderId && active.holderInstanceId === this.instanceId) return { ok: true, duplicate: true, lease: active };
          else return { ok: false, error: SIDE_EFFECT_ERROR.LEASE_CONFLICT, lease: active };
        }
        const approval = this.store.latestApprovalOfCall(callId);
        // 批准绑定一律对事务内的新快照逐项比对。
        const valid = approval && approval.decision === APPROVAL_DECISION.APPROVED && approval.revokedAt == null && (approval.expiresAt == null || now < Number(approval.expiresAt)) && approval.planHash === fresh.planHash && approval.approvedArgumentsHash === fresh.argumentsHash && approval.approvedToolId === fresh.toolId && Number(approval.approvedToolVersion) === Number(fresh.toolVersion);
        if (!valid) {
          const reason = !approval ? SIDE_EFFECT_ERROR.APPROVAL_REQUIRED
            : approval.decision === APPROVAL_DECISION.REVOKED ? SIDE_EFFECT_ERROR.APPROVAL_REVOKED
            : (approval.expiresAt != null && now >= Number(approval.expiresAt)) ? SIDE_EFFECT_ERROR.APPROVAL_EXPIRED
            : SIDE_EFFECT_ERROR.PLAN_STALE;
          return { ok: false, error: reason };
        }
        if (superseded) this.store.updateLease(superseded.leaseId, { status: LEASE_STATUS.EXPIRED });
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
    // 这里刻意传 persisted decision + 显式 expires_at：纯函数按 (decision 绑定, 时间) 两段判定，
    // 这样过期仍收敛为 APPROVAL_EXPIRED；effectiveDecision 只服务于展示 / 幂等判据，不参与执行判定。
    if (approvalRow) approval = { decision: approvalRow.decision, plan_hash: approvalRow.planHash, approved_arguments_hash: approvalRow.approvedArgumentsHash, approved_tool_id: approvalRow.approvedToolId, approved_tool_version: approvalRow.approvedToolVersion, approved_effect_class: approvalRow.approvedEffectClass, approved_expected_effects: approvalRow.approvedExpectedEffects, expires_at: approvalRow.expiresAt, revoked_at: approvalRow.revokedAt };
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
    // 批准人资格只在整体 ELIGIBLE 之后追加判定：过期 / revoked / 绑定不符等既有码优先（纯函数已按序判定）；
    // 通过前绝不落 execution_eligible 事件，避免"先报可执行、再拒绝"。
    if (result.status === ELIGIBILITY.ELIGIBLE) {
      const approver = this.#approverEligibility({ approval: approvalRow, task });
      if (!approver.ok) return { ok: false, ...result, status: ELIGIBILITY.DENIED, reasonCode: approver.error, call };
      this.#event(call.taskId, "tool.execution_eligible", { callId, toolId: call.toolId });
    }
    return { ok: result.status === ELIGIBILITY.ELIGIBLE, ...result, call };
  }

  /**
   * D4-04 · spawn executor 之前的实时授权 preflight（只读）。
   *
   * executeApproved 若先 spawn，executor 内部 eligibility 才发现撤权，就已经产生
   * 一次 runtime 启动和一个 lease。这里在 spawn 前用真实 AuthorizationService
   * 重查 tool permission + resource action，撤权一律 fail closed（0 spawn / 0 lease / 0 mutation）。
   */
  preflightAuthorization({ callId } = {}) {
    const call = this.store.callById(callId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    const task = this.taskStore.taskById(call.taskId);
    if (!task) return { ok: false, error: SIDE_EFFECT_ERROR.TASK_NOT_FOUND };
    const actor = this.#resolveAgent(this.#executionContext(task));
    if (!actor.ok) return { ok: false, error: SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED };
    const tool = this.#toolFor(call);
    if (!tool.ok) {
      const error = tool.error === "TOOL_DISABLED" ? SIDE_EFFECT_ERROR.TOOL_DISABLED
        : tool.error === "SIDE_EFFECT_TOOL_VERSION_CHANGED" ? SIDE_EFFECT_ERROR.TOOL_VERSION_CHANGED
        : SIDE_EFFECT_ERROR.TOOL_NOT_FOUND;
      return { ok: false, error };
    }
    const authorization = this.#authorizeLive({ sessionRef: task.session_ref, appId: task.app_id, preconditions: call.preconditionsSafe }, tool.contract, actor.user.id);
    if (!authorization.ok) return { ok: false, error: SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED };
    return { ok: true };
  }

  /**
   * D4-03C3 Closure · trusted quiescence proof。
   * 只有 RuntimeLifecycleAuthority 真正观测到 origin runtime 退出才 quiesced=true；
   * 不同 instanceId / 旧 lease EXPIRED / 新进程启动 / 时间流逝 / caller 自报 一律不构成证明。
   */
  #quiescenceProof(originRuntimeInstanceId) {
    const id = originRuntimeInstanceId ? String(originRuntimeInstanceId) : null;
    if (!id) return { quiesced: false, reason: "NO_ORIGIN_RUNTIME", proof: { type: "NO_ORIGIN_RUNTIME" } };
    if (id === this.instanceId) return { quiesced: false, reason: "SELF_RUNTIME_ACTIVE", proof: { type: "SELF_RUNTIME_ACTIVE", instanceId: id } };
    if (!this.lifecycle || typeof this.lifecycle.isQuiesced !== "function") return { quiesced: false, reason: "NO_LIVENESS_AUTHORITY", proof: { type: "NO_LIVENESS_AUTHORITY", instanceId: id } };
    let verdict = null;
    try { verdict = this.lifecycle.isQuiesced(id); } catch { verdict = null; }
    if (!verdict) return { quiesced: false, reason: "LIVENESS_AUTHORITY_UNAVAILABLE", proof: { type: "LIVENESS_AUTHORITY_UNAVAILABLE", instanceId: id } };
    return { quiesced: verdict.quiesced === true, reason: verdict.reason || null, proof: verdict.proof || { type: "UNKNOWN", instanceId: id } };
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
    // D4-03C3 Closure：已持久化 UNKNOWN_EFFECT(quiesced=false) 在真实 cold restart 后，
    // 只有当 trusted RuntimeLifecycleAuthority 能证明 origin runtime 已死，才升级
    // non-authoritative recovery evidence（quiesced=false → true）；Call 状态仍保持 UNKNOWN_EFFECT。
    // 它只回答"旧 execution 是否还可能 late-arrive"，绝不推断 APPLIED / NOT_APPLIED。
    const unresolved = this.store.callsByStatus(CALL_STATUS.UNKNOWN_EFFECT).filter((c) => c.recoverySafe && c.recoverySafe.quiesced === false);
    for (const call of unresolved) {
      const origin = call.recoverySafe.originRuntimeInstanceId || null;
      const q = this.#quiescenceProof(origin);
      this.#audit({ toolRef: call.toolId, action: "side_effect.quiescence_checked", decision: q.quiesced ? "CONFIRMED" : "UNPROVEN", reasonCode: q.reason });
      if (!q.quiesced) {
        this.store.transactSync(() => this.store.updateCall(call.callId, { recovery_safe: { ...call.recoverySafe, quiescenceReason: q.reason, quiescenceProofType: q.proof ? q.proof.type : null, quiescenceCheckedAt: this.#now() } }));
        this.#event(call.taskId, "tool.side_effect.quiescence_unproven", { callId: call.callId, originRuntimeInstanceId: origin, reason: q.reason });
        continue;
      }
      this.store.transactSync(() => this.store.updateCall(call.callId, { recovery_safe: { ...call.recoverySafe, quiesced: true, source: "cold_restart_confirmed", proof: q.proof, quiescenceReason: null, confirmedAt: this.#now() } }));
      this.#audit({ toolRef: call.toolId, action: "side_effect.unknown_effect_quiescence_upgraded", decision: "CONFIRMED", reasonCode: null });
      this.#event(call.taskId, "tool.side_effect.unknown_effect_quiescence_upgraded", { callId: call.callId, originRuntimeInstanceId: origin, proofType: q.proof ? q.proof.type : null });
    }

    for (const call of running) {
      const oldLease = this.store.activeLeaseOfCall(call.callId);
      const originRuntimeInstanceId = (oldLease && oldLease.holderInstanceId) || (call.recoverySafe && call.recoverySafe.originRuntimeInstanceId) || null;
      const originLeaseId = oldLease ? oldLease.leaseId : (call.recoverySafe && call.recoverySafe.originLeaseId) || null;
      const q = this.#quiescenceProof(originRuntimeInstanceId);
      const recovery = { quiesced: q.quiesced, source: q.quiesced ? "cold_restart_confirmed" : "unproven", originRuntimeInstanceId, originLeaseId, proof: q.proof, reason: q.reason, recordedAt: this.#now() };
      // 先无条件进入 UNKNOWN_EFFECT（fail closed）。
      this.store.transactSync(() => this.store.updateCall(call.callId, { status: CALL_STATUS.UNKNOWN_EFFECT, error_code: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT, verification_status: null, recovery_safe: recovery }));
      this.#audit({ toolRef: call.toolId, action: "side_effect.quiescence_checked", decision: q.quiesced ? "CONFIRMED" : "UNPROVEN", reasonCode: q.reason });
      this.#audit({ toolRef: call.toolId, action: "side_effect.unknown_effect", decision: CALL_STATUS.UNKNOWN_EFFECT, reasonCode: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT });
      this.#event(call.taskId, "tool.side_effect.unknown_effect", { callId: call.callId, toolId: call.toolId, originRuntimeInstanceId, quiesced: q.quiesced, proofType: q.proof ? q.proof.type : null });
      this.#event(call.taskId, q.quiesced ? "tool.side_effect.quiescence_confirmed" : "tool.side_effect.quiescence_unproven", { callId: call.callId, originRuntimeInstanceId, reason: q.reason, proofType: q.proof ? q.proof.type : null });
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

  /**
   * D4-03C3 · production UNKNOWN_EFFECT verification path（只读；0 mutation / 0 execute / 0 retry）。
   *
   * SideEffectCall → exact historical Tool Contract → allowlisted adapter → read-only Domain verifier。
   * 三态 APPLIED / NOT_APPLIED / INDETERMINATE：
   *  - APPLIED → SUCCEEDED（desired effect 已存在）；
   *  - NOT_APPLIED **且** executionQuiesced（OpenArc trusted fact）→ FAILED；
   *  - 其它（含 NOT_APPLIED 但未 quiesced、INDETERMINATE、verifier 不可用）→ 保持 UNKNOWN_EFFECT。
   * 绝不依赖 test-only verifier，也绝不因当前 session / tool 失效就跳过 reconciliation。
   */
  async verifyUnknownEffect({ callId } = {}) {
    const call = this.store.callById(callId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    // 已终态：terminal duplicate，绝不产生第二次状态副作用。
    if (call.status === CALL_STATUS.SUCCEEDED || call.status === CALL_STATUS.FAILED) {
      return { ok: true, duplicate: true, resolved: true, outcome: call.recoverySafe ? call.recoverySafe.outcome : null, call };
    }
    if (call.status !== CALL_STATUS.UNKNOWN_EFFECT) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_STATE, call };

    // exact historical contract：不使用 latest version，也不受 disabled / 当前 session 影响。
    const contract = this.registry.get(call.toolId, call.toolVersion);
    if (!contract || !contract.verificationStrategy) return { ok: false, error: SIDE_EFFECT_ERROR.VERIFICATION_NOT_AVAILABLE, call };
    if (effectClassForRisk(contract.riskClass) !== String(call.effectClass)) return { ok: false, error: SIDE_EFFECT_ERROR.VERIFICATION_NOT_AVAILABLE, call };
    const adapter = this.adapterFor ? this.adapterFor({ executionProvider: contract.executionProvider, toolId: contract.toolId }) : null;
    if (!adapter || typeof adapter.recoveryVerify !== "function") return { ok: false, error: SIDE_EFFECT_ERROR.VERIFICATION_NOT_AVAILABLE, call };

    this.#audit({ toolRef: call.toolId, action: "side_effect.verification_started", decision: "RUNNING", reasonCode: null });
    this.#event(call.taskId, "tool.side_effect.verification_started", { callId: call.callId, toolId: call.toolId });

    let verdict = null;
    try { verdict = await adapter.recoveryVerify({ call, contract, preconditions: call.preconditionsSafe, expectedEffects: call.expectedEffectsSafe }); }
    catch { verdict = null; }
    const outcome = verdict && ["APPLIED", "NOT_APPLIED", "INDETERMINATE"].includes(verdict.outcome) ? verdict.outcome : "INDETERMINATE";
    const reason = (verdict && verdict.reason) || "VERIFIER_UNAVAILABLE";
    const detail = (verdict && verdict.detail) || {};

    const recovery = call.recoverySafe || {};
    // executionQuiesced 只能来自 OpenArc trusted evidence（live timeout=false；cold restart=true）。
    const quiesced = recovery.quiesced === true;
    const now = this.#now();
    const terminal = outcome === "APPLIED" ? { status: CALL_STATUS.SUCCEEDED, verificationStatus: "PASS" }
      : (outcome === "NOT_APPLIED" && quiesced) ? { status: CALL_STATUS.FAILED, verificationStatus: "FAIL" } : null;

    const evidence = {
      outcome, reason, quiesced, verifiedAt: now,
      resourceRef: detail.resourceRef || (call.preconditionsSafe && call.preconditionsSafe.resourceRef) || null,
      expectedVersion: call.preconditionsSafe && call.preconditionsSafe.expectedVersion != null ? call.preconditionsSafe.expectedVersion : null,
      currentVersion: detail.currentVersion != null ? detail.currentVersion : null,
    };

    // 单一 authoritative transition：并发 read-only verifier 只会有一个 commit，另一方看到终态。
    let updated = null;
    let lost = false;
    this.store.transactSync(() => {
      const fresh = this.store.callById(callId);
      if (!fresh || fresh.status !== CALL_STATUS.UNKNOWN_EFFECT) { lost = true; updated = fresh; return; }
      // 保留 origin runtime attribution 等 recovery evidence，只合并 verification outcome。
      const merged = { ...(call.recoverySafe || {}), ...evidence };
      if (terminal) updated = this.store.updateCall(callId, { status: terminal.status, verification_status: terminal.verificationStatus, completed_at: now, error_code: terminal.status === CALL_STATUS.SUCCEEDED ? null : reason, recovery_safe: merged });
      else updated = this.store.updateCall(callId, { recovery_safe: merged });
    });
    if (lost) return { ok: true, duplicate: true, resolved: true, outcome: updated && updated.recoverySafe ? updated.recoverySafe.outcome : null, call: updated };

    const resolved = !!terminal;
    const eventByOutcome = { APPLIED: "tool.side_effect.verification_applied", NOT_APPLIED: "tool.side_effect.verification_not_applied", INDETERMINATE: "tool.side_effect.verification_indeterminate" };
    this.#audit({ toolRef: call.toolId, action: resolved ? (terminal.status === CALL_STATUS.SUCCEEDED ? "side_effect.verification_applied" : "side_effect.verification_not_applied") : "side_effect.verification_indeterminate", decision: updated ? updated.status : CALL_STATUS.UNKNOWN_EFFECT, reasonCode: reason });
    this.#event(call.taskId, eventByOutcome[outcome], { callId: call.callId, toolId: call.toolId, outcome, reason, quiesced });
    if (resolved) {
      this.#audit({ toolRef: call.toolId, action: "side_effect.recovery_resolved", decision: terminal.status, reasonCode: reason });
      this.#event(call.taskId, "tool.side_effect.recovery_resolved", { callId: call.callId, toolId: call.toolId, outcome, resolvedStatus: terminal.status });
    }
    return { ok: true, outcome, resolved, quiesced, reason, call: updated, status: updated ? updated.status : null, verificationStatus: terminal ? terminal.verificationStatus : null };
  }

  /**
   * D4-03C4 · 受监督 executor runtime 真实退出后的**单条** call 收敛。
   *
   * 与 recoverOnStartup() 的关键区别：它只处理这一条 call，绝不触碰其它 runtime 的 lease
   * （后者只有在真实 cold restart 时才是正确的）。
   *   · RUNNING（该 executor 已 claim）→ UNKNOWN_EFFECT + trusted quiescence evidence；
   *   · LEASED（该 executor 未 claim 即退出）→ known no effect → FAILED + revoke 自己的 lease。
   * 调用方必须先证明 active lease 属于**自己 spawn 的 executor instance**，否则无权收敛。
   */
  recoverAfterExecutorExit({ callId, executorInstanceId = null } = {}) {
    const call = this.store.callById(callId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    const active = this.store.activeLeaseOfCall(callId);
    if (call.status === CALL_STATUS.LEASED) {
      if (!active || (executorInstanceId && active.holderInstanceId !== executorInstanceId)) return { ok: false, error: SIDE_EFFECT_ERROR.LEASE_NOT_HELD, status: call.status };
      this.#finalizeLease(callId, active.leaseId, LEASE_STATUS.REVOKED, call.toolId);
      const updated = this.store.transactSync(() => this.store.updateCall(callId, { status: CALL_STATUS.FAILED, error_code: SIDE_EFFECT_ERROR.DOMAIN_WRITE_FAILED, completed_at: this.#now() }));
      this.#audit({ toolRef: call.toolId, action: "side_effect.blocked", decision: CALL_STATUS.FAILED, reasonCode: SIDE_EFFECT_ERROR.DOMAIN_WRITE_FAILED });
      this.#event(call.taskId, "tool.side_effect.execution_blocked", { callId, toolId: call.toolId, reasonCode: SIDE_EFFECT_ERROR.DOMAIN_WRITE_FAILED });
      return { ok: true, status: CALL_STATUS.FAILED, knownNoEffect: true, call: updated };
    }
    // A-4：call 已不是 RUNNING（终态或已由其它权威收敛）时绝不改状态，但**属于本次 executor**
    // 的 ACTIVE lease 必须回收 —— 否则同一进程内 append/runTask 会被残留 ACTIVE_LEASE 拦住。
    // 归属证明不足（无 executorInstanceId / 非本 executor）时 fail closed，绝不触碰别人的 lease。
    if (call.status !== CALL_STATUS.RUNNING) {
      const stale = this.store.activeLeaseOfCall(callId);
      if (stale && executorInstanceId && stale.holderInstanceId === executorInstanceId) {
        this.#finalizeLease(callId, stale.leaseId, LEASE_STATUS.REVOKED, call.toolId);
        return { ok: true, status: call.status, leaseFinalized: true, call };
      }
      return { ok: true, status: call.status, call };
    }

    const originRuntimeInstanceId = (active && active.holderInstanceId) || (call.recoverySafe && call.recoverySafe.originRuntimeInstanceId) || executorInstanceId || null;
    const originLeaseId = (active && active.leaseId) || (call.recoverySafe && call.recoverySafe.originLeaseId) || null;
    const q = this.#quiescenceProof(originRuntimeInstanceId);
    const recovery = { quiesced: q.quiesced, source: q.quiesced ? "executor_exit_confirmed" : "unproven", originRuntimeInstanceId, originLeaseId, proof: q.proof, reason: q.reason, recordedAt: this.#now() };
    // A-4 同类：UNKNOWN_EFFECT 与 lease REVOKE 必须同一事务提交，绝不留下可被消费的 ACTIVE lease
    //（否则崩溃残窗经后续 VERIFY 收敛出的终态仍带残留 lease）。
    let revokedLease = null;
    const updated = this.store.transactSync(() => {
      const next = this.store.updateCall(callId, { status: CALL_STATUS.UNKNOWN_EFFECT, error_code: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT, completed_at: this.#now(), verification_status: null, recovery_safe: recovery });
      revokedLease = this.#finalizeLeaseInTx(callId, originLeaseId, LEASE_STATUS.REVOKED);
      return next;
    });
    if (revokedLease) this.#auditLeaseFinalized(call.toolId, LEASE_STATUS.REVOKED);
    this.#audit({ toolRef: call.toolId, action: "side_effect.quiescence_checked", decision: q.quiesced ? "CONFIRMED" : "UNPROVEN", reasonCode: q.reason });
    this.#audit({ toolRef: call.toolId, action: "side_effect.unknown_effect", decision: CALL_STATUS.UNKNOWN_EFFECT, reasonCode: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT });
    this.#event(call.taskId, "tool.side_effect.unknown_effect", { callId, toolId: call.toolId, originRuntimeInstanceId, quiesced: q.quiesced, proofType: q.proof ? q.proof.type : null });
    this.#event(call.taskId, q.quiesced ? "tool.side_effect.quiescence_confirmed" : "tool.side_effect.quiescence_unproven", { callId, originRuntimeInstanceId, reason: q.reason });
    const step = call.stepId ? this.taskStore.stepById(call.stepId) : null;
    if (this.taskService && typeof this.taskService.blockStep === "function" && call.stepId) {
      const freshTask = this.taskStore.taskById(call.taskId);
      if (freshTask) {
        try { this.taskService.blockStep({ context: this.#executionContext(freshTask), taskId: call.taskId, stepId: call.stepId, runId: call.runId, reason: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT, event: "tool.side_effect.unknown_effect", expectedRevision: freshTask.revision }); } catch { /* fail closed：call 已是 UNKNOWN_EFFECT */ }
      }
    }
    void step;
    return { ok: true, status: CALL_STATUS.UNKNOWN_EFFECT, call: updated, quiesced: q.quiesced };
  }

  /**
   * trusted execution context：user / session / app 全部来自 SideEffectCall 绑定的真实 Task，
   * 绝不重新信任 Harness 或调用方 payload（§11）。
   */
  #executionContext(task) {
    return { sessionRef: task.session_ref, appId: task.app_id, source: "agent", agent: true, requestId: null, actorUserId: task.user_id };
  }

  /** 事务内终结 lease：调用方已持有 BEGIN IMMEDIATE（transactSync 不可嵌套），只改 lease 行。 */
  #finalizeLeaseInTx(callId, leaseId, status) {
    if (!leaseId) return null;
    const lease = this.store.leaseById(leaseId);
    if (!lease || lease.callId !== callId || lease.status !== LEASE_STATUS.ACTIVE) return null;
    const now = this.#now();
    const patch = status === LEASE_STATUS.REVOKED ? { status: LEASE_STATUS.REVOKED, revoked_at: now } : { status: LEASE_STATUS.RELEASED, released_at: now };
    return this.store.updateLease(leaseId, patch);
  }
  #auditLeaseFinalized(toolRef, status) {
    this.#audit({ toolRef, action: status === LEASE_STATUS.REVOKED ? "side_effect.lease_revoked" : "side_effect.lease_released", decision: status, reasonCode: null });
  }
  /** 只结束 lease（release / revoke），不改 call 状态；execution ownership 必须唯一失效。 */
  #finalizeLease(callId, leaseId, status, toolRef = null) {
    const updated = this.store.transactSync(() => this.#finalizeLeaseInTx(callId, leaseId, status));
    if (updated) this.#auditLeaseFinalized(toolRef, status);
    return updated;
  }

  /**
   * 批准资格失效 = 拒绝的等价物：claim 之前（AWAITING_APPROVAL / APPROVED / LEASED）发现即收敛 ——
   * call → BLOCKED + code + completed_at，其 ACTIVE lease 在同一事务内终结（A-4 语义），
   * 再落既有 blocked audit/event 并把 Step/Task 收敛 BLOCKED。
   * RUNNING / 任何终态一律不调用（进入执行后不追溯、不改写、不新增中止能力）。
   */
  #blockIneligibleApproval({ call, code }) {
    const now = this.#now();
    let revokedLease = null;
    let updated = null;
    this.store.transactSync(() => {
      const fresh = this.store.callById(call.callId);
      if (!fresh || !DENIABLE_CALL_STATUS.includes(String(fresh.status))) { updated = fresh; return; }
      const active = this.store.activeLeaseOfCall(call.callId);
      revokedLease = active ? this.#finalizeLeaseInTx(call.callId, active.leaseId, LEASE_STATUS.REVOKED) : null;
      updated = this.store.updateCall(call.callId, { status: CALL_STATUS.BLOCKED, error_code: code, completed_at: now });
    });
    if (!updated || String(updated.status) !== CALL_STATUS.BLOCKED) return null;
    if (revokedLease) this.#auditLeaseFinalized(call.toolId, LEASE_STATUS.REVOKED);
    this.#audit({ toolRef: call.toolId, action: "side_effect.blocked", decision: CALL_STATUS.BLOCKED, reasonCode: code });
    this.#event(call.taskId, "tool.side_effect.execution_blocked", { callId: call.callId, toolId: call.toolId, reasonCode: code });
    this.#blockStepForRejectedCall(call, code);
    return updated;
  }

  /** 拒绝类收敛的统一出口：Step/Task → BLOCKED（blockStep 自身落 STEP_BLOCKED / TASK_BLOCKED）。 */
  #blockStepForRejectedCall(call, reason) {
    if (!this.taskService || typeof this.taskService.blockStep !== "function" || !call.stepId) return;
    const freshTask = this.taskStore.taskById(call.taskId);
    if (!freshTask || String(freshTask.status) !== "RUNNING") return;
    try { this.taskService.blockStep({ context: this.#executionContext(freshTask), taskId: call.taskId, stepId: call.stepId, runId: call.runId, reason, expectedRevision: freshTask.revision }); } catch { /* fail closed：call 已是不可执行状态 */ }
  }

  /**
   * S1：迟到结果抑制的唯一出口。效果已发生，但状态权威不属于本 runtime → 只落 safe 事实，
   * 绝不改任何持久化字段，绝不声称成功/终态迁移，也绝不 retry。
   */
  #lateResultSuppressed({ call, observedStatus, mutationCount, error, result = null, extra = null }) {
    this.#audit({ toolRef: call.toolId, action: "side_effect.late_result_suppressed", decision: observedStatus, reasonCode: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT });
    this.#event(call.taskId, "tool.side_effect.late_result_suppressed", { callId: call.callId, toolId: call.toolId, observedStatus });
    return { ok: false, executed: true, duplicate: false, mutationCount, suppressed: true, observedStatus, call, result, verificationStatus: null, error, ...(extra || {}) };
  }

  /** known no-effect：Domain 明确拒绝 / precondition 变化 / verifier 明确未生效 → FAILED，0 retry。 */
  #finishKnownNoEffect({ call, leaseId, error, verificationStatus = null, knownNoEffect = true }) {
    const now = this.#now();
    const status = knownNoEffect ? CALL_STATUS.FAILED : CALL_STATUS.BLOCKED;
    // A-4：终态与其自身 lease 的终结必须同一事务提交，绝不留下"FAILED/BLOCKED + ACTIVE lease"。
    // S1-b：同一事务内先重读 persisted status —— 权威已被别的 runtime 收敛时绝不覆盖任何字段。
    let releasedLease = null;
    const outcome = this.store.transactSync(() => {
      const fresh = this.store.callById(call.callId);
      const observedStatus = fresh ? fresh.status : null;
      if (observedStatus !== CALL_STATUS.RUNNING) {
        releasedLease = this.#finalizeLeaseInTx(call.callId, leaseId, LEASE_STATUS.RELEASED);
        return { suppressed: true, observedStatus, call: fresh };
      }
      const next = this.store.updateCall(call.callId, { status, error_code: error, completed_at: now, verification_status: verificationStatus });
      releasedLease = this.#finalizeLeaseInTx(call.callId, leaseId, LEASE_STATUS.RELEASED);
      return { suppressed: false, observedStatus, call: next };
    });
    if (releasedLease) this.#auditLeaseFinalized(call.toolId, LEASE_STATUS.RELEASED);
    if (outcome.suppressed) return this.#lateResultSuppressed({ call: outcome.call, observedStatus: outcome.observedStatus, mutationCount: 0, error, extra: { knownNoEffect: false } });
    const updated = outcome.call;
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
    // live timeout / ambiguous：底层 operation 可能仍会 late-arrive → quiesced=false。
    // 记录 safe runtime attribution，供后续 cold restart 用 trusted liveness proof 升级（绝不自动推断 effect）。
    const recovery = {
      quiesced: false,
      source: detail === "SIDE_EFFECT_TIMEOUT" ? "live_timeout" : "live_ambiguous",
      originRuntimeInstanceId: this.instanceId,
      originLeaseId: leaseId || null,
      reason: detail || SIDE_EFFECT_ERROR.UNKNOWN_EFFECT,
      recordedAt: now,
    };
    // A-4：UNKNOWN_EFFECT（移交给恢复）与 lease REVOKE 必须同一事务提交 —— 否则进程死在
    // 两者之间时，后续 VERIFY 收敛出的终态仍会带残留 ACTIVE lease（同 SUCCEEDED/FAILED 手法）。
    // S1-b：同一事务内先重读 persisted status —— 权威已被别的 runtime 收敛时绝不覆盖任何字段。
    let revokedLease = null;
    const outcome = this.store.transactSync(() => {
      const fresh = this.store.callById(call.callId);
      const observedStatus = fresh ? fresh.status : null;
      if (observedStatus !== CALL_STATUS.RUNNING) {
        revokedLease = this.#finalizeLeaseInTx(call.callId, leaseId, LEASE_STATUS.REVOKED);
        return { suppressed: true, observedStatus, call: fresh };
      }
      const next = this.store.updateCall(call.callId, { status: CALL_STATUS.UNKNOWN_EFFECT, error_code: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT, completed_at: now, recovery_safe: recovery });
      revokedLease = this.#finalizeLeaseInTx(call.callId, leaseId, LEASE_STATUS.REVOKED);
      return { suppressed: false, observedStatus, call: next };
    });
    if (revokedLease) this.#auditLeaseFinalized(call.toolId, LEASE_STATUS.REVOKED);
    if (outcome.suppressed) return this.#lateResultSuppressed({ call: outcome.call, observedStatus: outcome.observedStatus, mutationCount: null, error: SIDE_EFFECT_ERROR.UNKNOWN_EFFECT, extra: { taskBlocked: false } });
    const updated = outcome.call;
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
    // claim 事务内的 executionPolicy 复核：plan 之后 contract 若被改回纯 REVERSIBLE_WRITE 合同，
    // 旧的 EXTERNAL call 绝不因此获得执行资格。
    const expectedPolicy = executionPolicyForEffectClass(call.effectClass);
    if (!expectedPolicy || tool.contract.executionPolicy !== expectedPolicy) return failWith(SIDE_EFFECT_ERROR.WRITE_EXECUTION_DISABLED);
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
    // 批准人资格重判：claim 事务内重判就是执行分界 —— "判定资格后、claim 前失权"无法漏过；
    // 进入 RUNNING 之后一律不追溯（本方法只在 claim 事务内被调用）。
    const approver = this.#approverEligibility({ approval, task });
    if (!approver.ok) return failWith(approver.error);
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
    // 执行位由 effectClass 精确决定：REVERSIBLE_WRITE→CONTROLLED_REVERSIBLE_WRITE，
    // EXTERNAL_SIDE_EFFECT→CONTROLLED_EXTERNAL_EFFECT；不匹配一律 WRITE_EXECUTION_DISABLED。
    const expectedPolicy = executionPolicyForEffectClass(call.effectClass);
    if (!expectedPolicy || tool.contract.executionPolicy !== expectedPolicy) return want(SIDE_EFFECT_ERROR.WRITE_EXECUTION_DISABLED);
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
      // 批准资格失效由本方法收敛（BLOCKED + lease 终结 + Step/Task BLOCKED）；其余 gate 维持既有 fail-closed 语义。
      const converged = APPROVER_ERRORS.includes(elig.reasonCode) ? this.#blockIneligibleApproval({ call, code: elig.reasonCode }) : null;
      if (!converged) {
        this.#audit({ toolRef: call.toolId, action: "side_effect.blocked", decision: "BLOCKED", reasonCode: elig.reasonCode });
        this.#event(call.taskId, "tool.side_effect.execution_blocked", { callId, toolId: call.toolId, reasonCode: elig.reasonCode });
      }
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
      // claim 事务内重判失权：同样按"拒绝的等价物"收敛（此处 call 仍是 LEASED，绝不产生第二次 dispatch）。
      const converged = APPROVER_ERRORS.includes(claim.reason) ? this.#blockIneligibleApproval({ call, code: claim.reason }) : null;
      if (!converged) {
        this.#audit({ toolRef: call.toolId, action: "side_effect.blocked", decision: "BLOCKED", reasonCode: claim.reason });
        this.#event(call.taskId, "tool.side_effect.execution_blocked", { callId, toolId: call.toolId, reasonCode: claim.reason });
      }
      return want(claim.reason);
    }
    this.#audit({ toolRef: call.toolId, action: "side_effect.execution_started", decision: CALL_STATUS.RUNNING, reasonCode: null });
    this.#event(call.taskId, "tool.side_effect.execution_started", { callId, toolId: call.toolId, leaseId: claim.leaseId });

    // claim 之后（execution ownership 唯一）才 dispatch Domain mutation。
    // D4-04：fault 注入只允许 constructor-only testHooks（production 默认 null），
    // 绝不读 process.env / IPC / Harness / tool args。
    if (this.testHooks && typeof this.testHooks.afterClaimBeforeDispatch === "function") this.testHooks.afterClaimBeforeDispatch({ callId, leaseId: claim.leaseId, holderId });
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
      execResult = await Promise.race([adapter.execute({ context: execCtx, args, contract: tool.contract, preconditions: call.preconditionsSafe, expectedEffects: call.expectedEffectsSafe, callId: call.callId }), guard]).finally(() => clearTimeout(timer));
    } catch (e) {
      return this.#finishUnknownEffect({ call, leaseId, detail: (e && e.code) || "SIDE_EFFECT_DISPATCH_ERROR" });
    }
    if (!execResult || execResult.ambiguous === true) return this.#finishUnknownEffect({ call, leaseId, detail: (execResult && execResult.error) || SIDE_EFFECT_ERROR.UNKNOWN_EFFECT });
    if (!execResult.ok) return this.#finishKnownNoEffect({ call, leaseId, error: execResult.error || SIDE_EFFECT_ERROR.DOMAIN_WRITE_FAILED, knownNoEffect: execResult.knownNoEffect !== false });
    if (this.testHooks && typeof this.testHooks.afterDomainResultBeforeVerification === "function") this.testHooks.afterDomainResultBeforeVerification({ callId: call.callId, execResult });

    // Execution != Verified Effect：必须真实 Domain verification 通过才允许 SUCCEEDED。
    let verdict;
    // verify 与 execute / recoveryVerify 同源：**只读持久化的 trusted plan**。
    // 需要基准 revision 的 verifier（CanvasControl READ_AFTER_WRITE）看不到 preconditions 就只能判 FAIL。
    // expectedEffects 一并交给 verifier：D5-04 的外部 provider 用它做 argsDigest 一致性核对
    // （批准时持久化的 effects 必须与本次执行的 args 完全一致）。
    try { verdict = await adapter.verify({ context: execCtx, args, result: execResult.result, contract: tool.contract, preconditions: call.preconditionsSafe, expectedEffects: call.expectedEffectsSafe }); }
    catch { return this.#finishUnknownEffect({ call, leaseId, detail: "VERIFIER_UNAVAILABLE" }); }
    if (!verdict || verdict.ok !== true) return this.#finishUnknownEffect({ call, leaseId, detail: "VERIFIER_UNAVAILABLE" });
    if (verdict.applied !== true) return this.#finishKnownNoEffect({ call, leaseId, error: SIDE_EFFECT_ERROR.VERIFICATION_FAILED, verificationStatus: "FAIL", knownNoEffect: true });
    if (this.testHooks && typeof this.testHooks.afterVerificationBeforeFinalPersist === "function") this.testHooks.afterVerificationBeforeFinalPersist({ callId: call.callId, verdict });

    const completedAt = this.#now();
    // S1：同一事务内重读 persisted status —— 另一个仍存活的 runtime 可能已把这条 call 收敛为
    // UNKNOWN_EFFECT 并重建权威；迟到结果绝不覆盖权威状态（UNKNOWN_EFFECT 只允许 VERIFY → BLOCK）。
    // A-4：终态写回与自身 lease 的终结必须同一事务提交，绝不留"终态 + ACTIVE lease"窗口。
    let releasedLease = null;
    const finalized = this.store.transactSync(() => {
      const fresh = this.store.callById(call.callId);
      const observedStatus = fresh ? fresh.status : null;
      if (observedStatus !== CALL_STATUS.RUNNING) {
        releasedLease = this.#finalizeLeaseInTx(call.callId, leaseId, LEASE_STATUS.RELEASED);
        return { suppressed: true, observedStatus, call: fresh };
      }
      const next = this.store.updateCall(call.callId, { status: CALL_STATUS.SUCCEEDED, verification_status: "PASS", completed_at: completedAt, error_code: null });
      releasedLease = this.#finalizeLeaseInTx(call.callId, leaseId, LEASE_STATUS.RELEASED);
      return { suppressed: false, observedStatus, call: next };
    });
    if (releasedLease) this.#auditLeaseFinalized(call.toolId, LEASE_STATUS.RELEASED);
    // 名字保留兼容既有引用，但本 seam 现在位于终态事务提交之后（call 终态 + lease 终结已原子落定），
    // 不再是"终态已写、lease 未终结"的崩溃窗口。
    if (this.testHooks && typeof this.testHooks.afterSucceededBeforeLeaseFinalize === "function") this.testHooks.afterSucceededBeforeLeaseFinalize({ callId: call.callId });
    if (finalized.suppressed) {
      return this.#lateResultSuppressed({
        call: finalized.call, observedStatus: finalized.observedStatus, mutationCount: 1, result: execResult.result,
        error: finalized.observedStatus === CALL_STATUS.UNKNOWN_EFFECT ? SIDE_EFFECT_ERROR.UNKNOWN_EFFECT : ((finalized.call && finalized.call.errorCode) || SIDE_EFFECT_ERROR.CALL_STATE),
      });
    }
    this.#audit({ toolRef: call.toolId, action: "side_effect.verification_passed", decision: "PASS", reasonCode: null });
    this.#event(call.taskId, "tool.side_effect.verification_passed", { callId: call.callId, toolId: call.toolId, verificationStatus: "PASS" });
    this.#audit({ toolRef: call.toolId, action: "side_effect.succeeded", decision: CALL_STATUS.SUCCEEDED, reasonCode: null });
    this.#event(call.taskId, "tool.side_effect.succeeded", { callId: call.callId, toolId: call.toolId });
    return { ok: true, executed: true, duplicate: false, mutationCount: 1, call: finalized.call, result: execResult.result, verificationStatus: "PASS", error: null };
  }

  getCall(callId) { return this.store.callById(callId); }
  listApprovals(callId) { return this.store.approvalsOfCall(callId); }
  listLeases(callId) { return this.store.leasesOfCall(callId); }
}

module.exports = { SideEffectAuthority, sanitizeEffects, sanitizePreconditions };
