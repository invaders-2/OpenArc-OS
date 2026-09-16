/**
 * D4-03C4 · Side-effect Runtime（唯一 production 装配）。
 *
 * 把 C1 Authority + C2 Controlled Write + C3 Ambiguous Recovery 收敛成一条不可绕过的
 * production contract：
 *
 *   Harness Proposal → Registry → Schema → Authorization → Risk →
 *   SideEffectPlan(AWAITING_APPROVAL) → Trusted OpenArc User Approval →
 *   Supervised Executor Runtime（lease + claim + exactly-once Domain write + verify）→
 *   Safe Tool Result → Harness 继续推理
 *
 * 永久边界：
 *   · Harness 只能 propose；它看不见本对象，也拿不到 approve / lease / execute；
 *   · Approval 只来自 trusted user action（main process 注入的 authenticated session）；
 *   · 真实 mutation 只发生在 RuntimeSupervisor 拥有并监督的 executor runtime 里，
 *     主进程绝不直接执行 write；
 *   · UNKNOWN_EFFECT 只允许 VERIFY → BLOCK；AUTO_RETRY = 0。
 *
 * 本对象不是第二套 Task / permission / approval / execution state machine：
 * 它只编排既有 authority。
 */
"use strict";
const domain = require("./side-effect-domain.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const {
  CALL_STATUS, CALL_TERMINAL, APPROVAL_DECISION, SIDE_EFFECT_ERROR, DEFAULT_APPROVAL_TTL_MS, fingerprint,
} = domain;

const DEFAULT_APPROVAL_WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 25;
const EXECUTOR_TIMEOUT_MS = 15000;

/** approval 快照 / tool result 只允许 safe 字段。 */
const SAFE_SNAPSHOT_SECRET_RE = /^(secret|token|authorization|api[_-]?key|credential|password|bearer|capability)/i;

function sleep(ms) { return new Promise((r) => { const t = setTimeout(r, Math.max(1, ms)); if (t && t.unref) t.unref(); }); }

function safeToolResult(call) {
  const pre = call && call.preconditionsSafe ? call.preconditionsSafe : {};
  const out = {
    resourceRef: pre.resourceRef || null,
    trashed: true,
    verified: true,
  };
  if (pre.expectedVersion != null) out.version = pre.expectedVersion;
  return out;
}

class SideEffectRuntime {
  constructor({ authority, supervisor, store, taskStore, taskService = null, toolProxy, registry = null, resourceStore = null, authService = null, dbPath = null, storeRoot = null, clock = null, logger = null, approvalWaitMs = DEFAULT_APPROVAL_WAIT_MS, approvalTtlMs = DEFAULT_APPROVAL_TTL_MS, executorTimeoutMs = EXECUTOR_TIMEOUT_MS } = {}) {
    if (!authority) throw new Error("SideEffectRuntime 需要 SideEffectAuthority");
    if (!supervisor) throw new Error("SideEffectRuntime 需要 RuntimeSupervisor");
    if (!toolProxy) throw new Error("SideEffectRuntime 需要 ControlledToolProxy");
    this.authority = authority;
    this.supervisor = supervisor;
    this.store = store || authority.store;
    this.taskStore = taskStore || authority.taskStore;
    this.taskService = taskService || authority.taskService;
    this.toolProxy = toolProxy;
    this.registry = registry || authority.registry;
    this.authService = authService || null;
    this.resourceStore = resourceStore || (authService && authService.store) || null;
    this.dbPath = dbPath;
    this.storeRoot = storeRoot;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    // UI 推送钩子（由 main process bootstrap 注入）；默认 null，不改变 authority 语义。
    this.onApprovalRequested = null;
    this.approvalWaitMs = Math.max(1, Number(approvalWaitMs) || DEFAULT_APPROVAL_WAIT_MS);
    this.approvalTtlMs = Math.max(1, Number(approvalTtlMs) || DEFAULT_APPROVAL_TTL_MS);
    this.executorTimeoutMs = Math.max(1, Number(executorTimeoutMs) || EXECUTOR_TIMEOUT_MS);
  }

  #now() { return this.clock(); }
  #audit({ actorUserId = null, appId = null, toolRef = null, action, decision, reasonCode = null }) {
    try { this.toolProxy?.toolStore?.insertToolAudit?.({ at: this.#now(), actorUserId, appId, toolRef, action, decision, reasonCode, requestId: null }); } catch { /* audit 失败不改业务结果 */ }
  }
  #event(taskId, eventType, safePayload = null) {
    try { this.taskStore.appendEvent({ taskId, eventType, safePayload }); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ WRITE proposal route
  /** 只由 OpenArc Tool Facade Bridge 调用：proposal → decision → SideEffectPlan。0 mutation。 */
  async proposeWrite({ context = {}, taskId, stepId = null, runId = null, toolId, toolVersion = null, arguments: args = {}, proposalId = null } = {}) {
    this.#audit({ toolRef: String(toolId == null ? "" : toolId), action: "side_effect.proposed", decision: "PROPOSED", reasonCode: null });
    // version 缺省取 Registry 当前版本；Harness 自报 version 仍受 Registry resolve 约束。
    const versions = this.toolProxy.registry.versionsOf(toolId);
    const effectiveVersion = toolVersion == null ? (versions.length ? versions[versions.length - 1] : null) : toolVersion;
    // §35 duplicate bridge delivery：同一 step + 同一 tool/version + 同一 argumentsHash 的
    // 未收敛 call 必须收敛为同一条 authority，绝不新建第二个 SideEffectCall。
    const argsHash = fingerprint(args == null ? {} : args);
    const sameBinding = this.store.callsOfTask(taskId).find((c) => c.stepId === stepId && c.toolId === String(toolId) && Number(c.toolVersion) === Number(effectiveVersion) && c.argumentsHash === argsHash && !CALL_TERMINAL.includes(String(c.status)));
    if (sameBinding) {
      this.#audit({ toolRef: String(toolId), action: "side_effect.duplicate_delivery", decision: sameBinding.status, reasonCode: null });
      return { ok: true, duplicate: true, call: sameBinding, approvalRequestId: sameBinding.callId };
    }
    const decision = this.toolProxy.propose({ context, taskId, stepId, runId, toolId, toolVersion: effectiveVersion, arguments: args, proposalId });
    if (!decision || decision.ok !== true || !decision.proposal) return { ok: false, error: (decision && decision.reasonCode) || "TOOL_DENIED" };
    if (decision.decisionStatus !== "APPROVAL_REQUIRED") return { ok: false, error: decision.reasonCode || "TOOL_DENIED", decisionStatus: decision.decisionStatus };
    const plan = await this.authority.planSideEffect({
      context, taskId, stepId, runId, toolId, toolVersion: effectiveVersion, arguments: args,
      proposalId: decision.proposal.proposalId,
      decisionId: decision.decision ? decision.decision.decisionId : null,
    });
    if (!plan || !plan.ok) return { ok: false, error: (plan && plan.error) || "SIDE_EFFECT_NO_PLAN" };
    const call = plan.call;
    this.#audit({ toolRef: call.toolId, action: "side_effect.plan_ready", decision: call.status, reasonCode: null });
    this.#audit({ toolRef: call.toolId, action: "side_effect.waiting_approval", decision: call.status, reasonCode: null });
    this.#event(taskId, "tool.side_effect.waiting_approval", { callId: call.callId, toolId: call.toolId, approvalRequestId: call.callId });
    try { if (typeof this.onApprovalRequested === "function") this.onApprovalRequested(this.approvalSnapshot({ approvalRequestId: call.callId })); } catch { /* UI 推送失败不改 authority 结果 */ }
    return { ok: true, duplicate: !!plan.duplicate, call, approvalRequestId: call.callId };
  }

  /** 某个 step 上仍在等待 / 已批准但尚未执行的 call（orchestrator 用它决定是否需要等待）。 */
  pendingApprovalsOfStep(stepId) {
    if (!stepId) return [];
    const out = [];
    for (const status of [CALL_STATUS.AWAITING_APPROVAL, CALL_STATUS.APPROVED, CALL_STATUS.LEASED]) {
      for (const call of this.store.callsByStatus(status)) if (call.stepId === stepId) out.push(call);
    }
    return out;
  }
  /**
   * 本 step/run 上的**全部** side-effect call（任何状态）。
   * Orchestrator 用它判断"这一轮 Harness 是否产生过 write proposal"——
   * 只看 pending 会漏掉"在 turn 期间已被 Deny / timeout / crash 收敛"的 call，
   * 从而错误地把 unverified 结果当成功提交。
   */
  sideEffectCallsOfStep({ stepId, runId = null } = {}) {
    const out = [];
    if (!stepId) return out;
    for (const status of Object.values(CALL_STATUS)) {
      for (const call of this.store.callsByStatus(status)) {
        if (call.stepId !== stepId) continue;
        if (runId && call.runId && call.runId !== runId) continue;
        out.push(call);
      }
    }
    return out;
  }

  pendingApprovalsOfRun(taskId, runId) {
    const out = [];
    for (const status of [CALL_STATUS.AWAITING_APPROVAL, CALL_STATUS.APPROVED, CALL_STATUS.LEASED]) {
      for (const call of this.store.callsByStatus(status)) if (call.taskId === taskId && (!runId || call.runId === runId)) out.push(call);
    }
    return out;
  }

  // ------------------------------------------------------------------ Approval gateway
  /** 只读安全投影：给 Approval UI 的唯一数据来源。绝不含 secret / 绝对路径 / store root。 */
  approvalSnapshot({ approvalRequestId, context = null } = {}) {
    const call = this.store.callById(approvalRequestId);
    // 只有仍可被决定的 approval 才可投影：terminal / BLOCKED / UNKNOWN_EFFECT 一律不可 revive。
    const actionable = [CALL_STATUS.AWAITING_APPROVAL, CALL_STATUS.APPROVED, CALL_STATUS.LEASED];
    if (!call || !actionable.includes(String(call.status))) return null;
    // §44：Renderer 不能指定 actor；快照只在请求来自该 call 所属 Task 的 session 时返回。
    if (context && context.sessionRef) {
      const ownerTask = this.taskStore.taskById(call.taskId);
      if (!ownerTask || String(ownerTask.session_ref) !== String(context.sessionRef)) return null;
    }
    const contract = this.registry.get(call.toolId, call.toolVersion) || {};
    const pre = call.preconditionsSafe || {};
    const ref = pre.resourceRef || null;
    let targetName = null;
    const nameStore = (this.authService && this.authService.store) || this.resourceStore;
    if (ref && nameStore && typeof nameStore.resourceByRef === "function") {
      try { const row = nameStore.resourceByRef(String(ref)); if (row && typeof row.name === "string") targetName = row.name.slice(0, 120); } catch { targetName = null; }
    }
    const approval = this.authority.effectiveApproval(call.callId);
    const allowed = new Set(["approvalRequestId", "status", "toolId", "toolDisplayName", "riskClass", "effectClass", "targetDisplayName", "resourceRef", "expectedEffects", "expectedVersion", "currentVersion", "expiresAt", "requiresApproval"]);
    const snap = {
      approvalRequestId: call.callId,
      status: call.status,
      toolId: call.toolId,
      toolDisplayName: String(contract.displayName || call.toolId).slice(0, 120),
      riskClass: contract.riskClass || null,
      effectClass: call.effectClass,
      targetDisplayName: targetName,
      resourceRef: ref,
      expectedEffects: Array.isArray(call.expectedEffectsSafe) ? call.expectedEffectsSafe.slice(0, 8) : [],
      expectedVersion: pre.expectedVersion == null ? null : Number(pre.expectedVersion),
      currentVersion: pre.expectedVersion == null ? null : Number(pre.expectedVersion),
      expiresAt: approval && approval.expiresAt != null ? Number(approval.expiresAt) : null,
      requiresApproval: true,
    };
    for (const key of Object.keys(snap)) if (!allowed.has(key)) delete snap[key];
    for (const key of Object.keys(snap)) if (SAFE_SNAPSHOT_SECRET_RE.test(key)) delete snap[key];
    return snap;
  }

  /**
   * Trusted user decision。context 由 main process 从 authenticated session 注入；
   * appId 一律从 call 绑定的真实 Task 反推，Renderer 无法选择 actor / app / risk。
   */
  decideApproval({ context = {}, approvalRequestId, decision } = {}) {
    const call = this.store.callById(approvalRequestId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    const task = this.taskStore.taskById(call.taskId);
    if (!task) return { ok: false, error: SIDE_EFFECT_ERROR.TASK_NOT_FOUND };
    const trusted = { sessionRef: context.sessionRef, appId: task.app_id, source: "user", agent: false, requestId: context.requestId || null };
    const act = String(decision || "").toUpperCase();
    if (act === "APPROVE") return this.authority.approveSideEffect({ context: trusted, callId: call.callId, ttlMs: this.approvalTtlMs });
    if (act === "DENY") return this.authority.denySideEffect({ context: trusted, callId: call.callId });
    return { ok: false, error: SIDE_EFFECT_ERROR.INVALID_INPUT };
  }

  // ------------------------------------------------------------------ supervised execution
  /** 把 AWAITING_APPROVAL 的 call 明确收敛为 BLOCKED（超时 / 取消 / 放弃）。0 execute。 */
  #blockPending(callId, reason) {
    const call = this.store.callById(callId);
    if (!call) return null;
    if (CALL_TERMINAL.includes(String(call.status))) return call;
    const updated = this.store.transactSync(() => this.store.updateCall(callId, { status: CALL_STATUS.BLOCKED, error_code: reason, completed_at: this.#now() }));
    this.#audit({ toolRef: call.toolId, action: "side_effect.blocked", decision: "BLOCKED", reasonCode: reason });
    this.#event(call.taskId, "tool.side_effect.execution_blocked", { callId, toolId: call.toolId, reasonCode: reason });
    if (reason === SIDE_EFFECT_ERROR.APPROVAL_ABANDONED) this.#event(call.taskId, "tool.side_effect.approval_abandoned", { callId, toolId: call.toolId, reasonCode: reason });
    return updated;
  }

  /** 受监督 executor runtime 执行一条已 APPROVED 的 call（唯一真实 mutation 入口）。 */
  async executeApproved({ callId, holderId = "oase_1", timeoutMs = null } = {}) {
    const call = this.store.callById(callId);
    if (!call) return { ok: false, error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
    if (call.status === CALL_STATUS.SUCCEEDED) return { ok: true, duplicate: true, call, safeResult: safeToolResult(call) };
    const box = this.supervisor.spawnExecutor({
      callId, holderId,
      dbPath: this.dbPath, storeRoot: this.storeRoot,
      timeoutMs: Number(timeoutMs) || this.executorTimeoutMs,
      now: this.#now(),
    });
    if (!box.ok) {
      // executor admission 失败（launcher unavailable / spawn 失败）：明确收敛 pending call 为 BLOCKED，
      // 绝不留一条仍可被再次触发的 APPROVED call；0 lease / 0 mutation / 0 retry。
      const afterFail = this.store.callById(callId);
      if (afterFail && !CALL_TERMINAL.includes(String(afterFail.status))) this.#blockPending(callId, box.error || SIDE_EFFECT_ERROR.CALL_STATE);
      return { ok: false, error: box.error || SIDE_EFFECT_ERROR.CALL_STATE, call: this.store.callById(callId) };
    }
    // spawn != entered executor：只有真实 ready handshake 之后才允许把这次 spawn 当成执行 runtime。
    // 未 ready 即退出 → EXECUTOR_START_FAILED（fail closed：0 lease / 0 mutation / 0 retry）。
    const ready = box.ready ? await box.ready : { ok: true };
    if (ready.ok !== true) {
      await box.done;
      const spawnLease = this.store.activeLeaseOfCall(callId);
      if (spawnLease && spawnLease.holderInstanceId === box.instanceId) {
        this.authority.recoverAfterExecutorExit({ callId, executorInstanceId: box.instanceId });
      } else {
        const afterSpawn = this.store.callById(callId);
        if (afterSpawn && !CALL_TERMINAL.includes(String(afterSpawn.status))) this.#blockPending(callId, SIDE_EFFECT_ERROR.EXECUTOR_START_FAILED);
      }
      return { ok: false, error: SIDE_EFFECT_ERROR.EXECUTOR_START_FAILED, call: this.store.callById(callId) };
    }
    await box.done;
    const message = RuntimeSupervisor.parseExecutorMessage(box.stdout, "result");
    let after = this.store.callById(callId);
    // executor 真实退出后仍未收敛（crash / kill / ambiguous）→ C3 recovery path，绝不 retry。
    if (after && (after.status === CALL_STATUS.RUNNING || after.status === CALL_STATUS.LEASED)) {
      const active = this.store.activeLeaseOfCall(callId);
      // execution ownership：只有本 runtime spawn 的 executor 才有权收敛这条 call。
      // 其它 runtime 的 ACTIVE lease 一律不许触碰（否则会破坏并发 winner 的执行）。
      if (!active || (box.instanceId && active.holderInstanceId !== box.instanceId)) {
        return { ok: false, claimLost: true, call: after, error: SIDE_EFFECT_ERROR.EXECUTION_CLAIM_LOST };
      }
      const rec = this.authority.recoverAfterExecutorExit({ callId, executorInstanceId: box.instanceId });
      if (rec.status === CALL_STATUS.UNKNOWN_EFFECT) {
        const v = await this.verifyUnknownEffect({ callId });
        after = this.store.callById(callId);
        // §28：一旦经过 UNKNOWN_EFFECT，就绝不再自动续接 Harness —— 即使最终 APPLIED。
        // recovered=true 让 orchestrator 走 BLOCK，而不是把 verified result 交回 dsh。
        return { ok: false, recovered: true, unknownEffect: true, recovery: v, recoveredStatus: after && after.status, call: after, error: (after && after.errorCode) || SIDE_EFFECT_ERROR.UNKNOWN_EFFECT };
      }
      after = this.store.callById(callId);
      return { ok: false, call: after, error: (after && after.errorCode) || SIDE_EFFECT_ERROR.DOMAIN_WRITE_FAILED };
    }
    if (after && after.status === CALL_STATUS.UNKNOWN_EFFECT) {
      const v = await this.verifyUnknownEffect({ callId });
      after = this.store.callById(callId);
      // §28：recovery 驱动的结果绝不自动续接 Harness（Explicit Resume = DEFERRED）。
      return { ok: false, recovered: true, unknownEffect: true, recovery: v, recoveredStatus: after && after.status, call: after, error: (after && after.status === CALL_STATUS.SUCCEEDED ? null : (after && after.errorCode)) || SIDE_EFFECT_ERROR.UNKNOWN_EFFECT };
    }
    const ok = !!(after && after.status === CALL_STATUS.SUCCEEDED);
    return { ok, call: after, executor: message ? message.result : null, safeResult: ok ? safeToolResult(after) : null, error: ok ? null : ((after && after.errorCode) || (message && message.result && message.result.error) || SIDE_EFFECT_ERROR.DOMAIN_WRITE_FAILED) };
  }

  /**
   * Orchestrator 驱动：等待 trusted decision（bounded），再经受监督 executor 执行 + verify。
   * 期间绝不由 Harness / timer 自动批准。
   */
  async resolvePendingForStep({ taskId, stepId, runId = null, callIds = null, timeoutMs = null } = {}) {
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || this.approvalWaitMs);
    const pick = () => {
      const list = callIds && callIds.length ? callIds.map((id) => this.store.callById(id)).filter(Boolean) : this.pendingApprovalsOfStep(stepId);
      return list.length ? list[0] : null;
    };
    for (;;) {
      const task = this.taskStore.taskById(taskId);
      if (!task || task.cancel_requested || task.status === "CANCELLED") {
        const c = pick(); if (c) this.#blockPending(c.callId, SIDE_EFFECT_ERROR.TASK_CANCELLED);
        return { ok: false, decision: "CANCELLED", error: SIDE_EFFECT_ERROR.TASK_CANCELLED };
      }
      const call = pick();
      if (!call) return { ok: false, decision: "NO_PENDING_CALL", error: SIDE_EFFECT_ERROR.CALL_NOT_FOUND };
      if (call.status === CALL_STATUS.AWAITING_APPROVAL) {
        if (Date.now() >= deadline) {
          this.#blockPending(call.callId, SIDE_EFFECT_ERROR.APPROVAL_TIMEOUT);
          return { ok: false, decision: "TIMEOUT", error: SIDE_EFFECT_ERROR.APPROVAL_TIMEOUT, callId: call.callId };
        }
        await sleep(POLL_MS);
        continue;
      }
      // 已被 trusted user / 其它路径执行完成：orchestrator 仍需把 verified result 交回 Harness。
      if (call.status === CALL_STATUS.SUCCEEDED) return { ok: true, decision: "APPROVED", callId: call.callId, call, safeResult: safeToolResult(call) };
      if (call.status === CALL_STATUS.APPROVED || call.status === CALL_STATUS.LEASED) {
        const res = await this.executeApproved({ callId: call.callId, holderId: "oase_1" });
        // 只有**未经 UNKNOWN_EFFECT** 的 direct verified success 才允许回到 Harness。
        if (res.ok && res.recovered !== true) return { ok: true, decision: "APPROVED", callId: call.callId, call: res.call, safeResult: res.safeResult };
        return { ok: false, decision: res.recovered ? "UNKNOWN_EFFECT" : (res.unknownEffect ? "UNKNOWN_EFFECT" : "FAILED"), recovered: !!res.recovered, recoveredStatus: res.recoveredStatus || null, error: res.error, callId: call.callId, call: res.call };
      }
      const denyReasons = { [CALL_STATUS.BLOCKED]: "DENIED", [CALL_STATUS.FAILED]: "FAILED", [CALL_STATUS.CANCELLED]: "CANCELLED" };
      return { ok: false, decision: denyReasons[call.status] || "BLOCKED", error: call.errorCode || SIDE_EFFECT_ERROR.CALL_STATE, callId: call.callId, call };
    }
  }

  // ------------------------------------------------------------------ recovery
  /**
   * 启动恢复（与既有 authority recovery 同一入口，不新建第二套语义）：
   * · RUNNING → UNKNOWN_EFFECT（trusted quiescence 由 supervisor 提供）；
   * · 尚在等待 / 已批准 / 已租用的 pending call 一律明确 BLOCKED，绝不自动 approve / lease / execute / replay。
   */
  recoverOnStartup() {
    const recovered = this.authority.recoverOnStartup();
    const abandoned = [];
    for (const status of [CALL_STATUS.AWAITING_APPROVAL, CALL_STATUS.APPROVED, CALL_STATUS.LEASED]) {
      for (const call of this.store.callsByStatus(status)) {
        const task = this.taskStore.taskById(call.taskId);
        if (task && task.status === "RUNNING" && !task.cancel_requested) continue;
        this.#blockPending(call.callId, SIDE_EFFECT_ERROR.APPROVAL_ABANDONED);
        abandoned.push(call.callId);
      }
    }
    return { ...recovered, abandonedPending: abandoned };
  }
  async verifyUnknownEffect({ callId }) { return this.authority.verifyUnknownEffect({ callId }); }

  /** 只返回当前 session 可见的 pending approval（安全投影，不含其它 session 的请求）。 */
  listPendingApprovals({ context = {} } = {}) {
    const out = [];
    for (const status of [CALL_STATUS.AWAITING_APPROVAL]) {
      for (const call of this.store.callsByStatus(status)) {
        const snap = this.approvalSnapshot({ approvalRequestId: call.callId, context });
        if (snap) out.push(snap);
        if (out.length >= 20) return { ok: true, items: out };
      }
    }
    return { ok: true, items: out };
  }

  snapshot() {
    const calls = [];
    for (const status of Object.values(CALL_STATUS)) for (const c of this.store.callsByStatus(status)) calls.push({ callId: c.callId, toolId: c.toolId, status: c.status, effectClass: c.effectClass });
    return { calls, executors: this.supervisor.snapshot() };
  }
}

module.exports = { SideEffectRuntime, safeToolResult, DEFAULT_APPROVAL_WAIT_MS };
