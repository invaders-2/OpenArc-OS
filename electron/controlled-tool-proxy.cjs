/**
 * D4-03A · Controlled Tool Proxy。
 *
 * 永久冻结：**Harness proposes. OpenArc decides. OpenArc executes. OpenArc verifies.**
 *
 * 本阶段只做：validate proposal → resolve tool → authorize actor/app/resource →
 * classify risk（来自 Registry，不来自 payload）→ permission decision →
 * dry-run ExecutionPlan → audit。`execute()` = forbidden；
 * 任何 proposal 最终 executionStatus = NOT_EXECUTED。
 *
 * proposal 的 taskId/stepId/runId/user/session/app 全部来自 OpenArc trusted context；
 * 忽略 Harness payload 自报的 userId/role/appId/permission/approval/risk。
 */
"use strict";
const domain = require("./tool-domain.cjs");
const {
  TOOL_ERROR, DECISION_STATUS, PROPOSAL_STATUS, EXECUTION_STATUS,
  forbiddenArgumentKeys, containsAbsolutePath, fingerprint, projectArguments,
} = domain;

function proposalStatusFor(decision) {
  switch (decision) {
    case DECISION_STATUS.ALLOWED: return PROPOSAL_STATUS.VALIDATED;
    case DECISION_STATUS.APPROVAL_REQUIRED: return PROPOSAL_STATUS.APPROVAL_REQUIRED;
    case DECISION_STATUS.DENIED: return PROPOSAL_STATUS.DENIED;
    case DECISION_STATUS.INVALID: return PROPOSAL_STATUS.INVALID;
    default: return PROPOSAL_STATUS.BLOCKED;
  }
}
function safeProposal(row) {
  if (!row) return null;
  let args = null; try { args = row.arguments_safe ? JSON.parse(row.arguments_safe) : null; } catch { args = null; }
  return { proposalId: row.proposal_id, taskId: row.task_id, stepId: row.step_id || null, runId: row.run_id || null, toolId: row.tool_id, toolVersion: row.tool_version, argumentsSafe: args, argumentsHash: row.arguments_hash || null, status: row.status, createdAt: row.created_at };
}
function safeDecision(row) {
  if (!row) return null;
  return { decisionId: row.decision_id, proposalId: row.proposal_id, status: row.decision, reasonCode: row.reason_code || null, riskClass: row.risk_class || null, approvalRequired: !!row.approval_required, createdAt: row.created_at };
}

class ControlledToolProxy {
  constructor({ registry, toolStore, authService, taskStore, adapters = null, clock = null, logger = null } = {}) {
    if (!registry) throw new Error("ControlledToolProxy 需要 ToolRegistry");
    if (!toolStore) throw new Error("ControlledToolProxy 需要 ToolStore");
    if (!authService) throw new Error("ControlledToolProxy 需要 AuthorizationService");
    if (!taskStore) throw new Error("ControlledToolProxy 需要 TaskStore");
    this.registry = registry;
    this.toolStore = toolStore;
    this.authService = authService;
    this.taskStore = taskStore;
    // §22/§23：executionProvider → 静态 allowlist adapter；绝不从 arguments 解析 module/path。
    this.adapterFor = adapters && typeof adapters.adapterFor === "function" ? adapters.adapterFor : null;
    this.lastExecution = null;
    this.clock = typeof clock === "function" ? clock : (taskStore.clock || (() => Date.now()));
    this.logger = logger;
  }

  #now() { return this.clock(); }

  #audit({ actorUserId, appId, toolRef, action, decision, reasonCode, requestId }) {
    try { this.toolStore.insertToolAudit({ at: this.#now(), actorUserId, appId, toolRef, action, decision, reasonCode, requestId }); } catch { /* audit 失败不改变业务结果 */ }
  }

  /**
   * 唯一入口。返回 decision + dry-run ExecutionPlan；绝不执行。
   */
  propose({ context = {}, taskId, stepId = null, runId = null, toolId, toolVersion = null, arguments: args = {}, rationale = null, proposalId = null } = {}) {
    const now = this.#now();
    const trusted = { sessionRef: context.sessionRef, appId: context.appId, source: "agent", agent: true, requestId: context.requestId || null };

    // §39 幂等：同一 proposalId 重复送达返回既有 decision，不生成第二个 decision。
    if (proposalId) {
      const existing = this.toolStore.proposalById(proposalId);
      if (existing) {
        const decision = this.toolStore.decisionByProposal(proposalId);
        return { ok: true, duplicate: true, proposal: safeProposal(existing), decision: safeDecision(decision), decisionStatus: decision ? decision.decision : null, reasonCode: decision ? decision.reason_code : null, executionPlan: null, executionStatus: EXECUTION_STATUS.NOT_EXECUTED, executed: false };
      }
    }

    const finalize = ({ decision, reasonCode, contract = null, schemaErrors = null, plan = null, resolvedToolId = null, resolvedVersion = null }) => {
      const safeArgs = contract ? projectArguments(args, contract.inputSchema.properties || {}) : {};
      const argsHash = fingerprint(args == null ? {} : args);
      const status = proposalStatusFor(decision);
      const result = this.toolStore.transactSync(() => {
        const proposal = this.toolStore.insertProposal({ proposalId, taskId: taskId == null ? "" : taskId, stepId, runId, toolId: resolvedToolId || String(toolId == null ? "" : toolId), toolVersion: resolvedVersion == null ? (Number(toolVersion) || 0) : resolvedVersion, argumentsSafe: safeArgs, argumentsHash: argsHash, status, createdAt: now });
        const decisionRow = this.toolStore.insertDecision({ proposalId: proposal.proposal_id, decision, reasonCode: reasonCode || null, riskClass: contract ? contract.riskClass : null, approvalRequired: contract ? !!contract.requiresApproval : false, createdAt: now });
        return { proposal, decisionRow };
      });
      this.#audit({ actorUserId: trusted.actorUserId || null, appId: trusted.appId, toolRef: result.proposal.tool_id, action: "tool.proposed", decision: "PROPOSED", reasonCode: null, requestId: trusted.requestId });
      const outcomeAction = decision === DECISION_STATUS.INVALID ? "tool.validation_failed" : decision === DECISION_STATUS.DENIED ? "tool.authorization_denied" : decision === DECISION_STATUS.APPROVAL_REQUIRED ? "tool.approval_required" : "tool.execution_blocked";
      this.#audit({ actorUserId: trusted.actorUserId || null, appId: trusted.appId, toolRef: result.proposal.tool_id, action: outcomeAction, decision, reasonCode: reasonCode || null, requestId: trusted.requestId });
      return {
        ok: true, duplicate: false,
        proposal: safeProposal(result.proposal),
        decision: safeDecision(result.decisionRow),
        decisionStatus: decision,
        reasonCode: reasonCode || null,
        schemaErrors: schemaErrors || null,
        executionPlan: plan,
        executionStatus: EXECUTION_STATUS.NOT_EXECUTED,
        executed: false,
      };
    };

    // trusted context 必须先解析为 actor（Session Gate）。
    const actor = this.authService.resolveActor({ context: trusted });
    if (!actor.ok) return this.#rejectBeforePersist(TOOL_ERROR.TOOL_FORBIDDEN, actor.error, toolId, toolVersion, taskId, stepId, runId, proposalId, now);

    const task = this.taskStore.taskById(taskId);
    if (!task) return this.#rejectBeforePersist(TOOL_ERROR.INVALID_INPUT, "TASK_NOT_FOUND", toolId, toolVersion, taskId, stepId, runId, proposalId, now);
    trusted.actorUserId = actor.user.id;
    // §75/§76：task/user/app 只来自 OpenArc trusted context + 真实 Task row。
    if (task.user_id !== actor.user.id || task.app_id !== trusted.appId) return this.#rejectBeforePersist(TOOL_ERROR.TOOL_FORBIDDEN, "TASK_FORBIDDEN", toolId, toolVersion, taskId, stepId, runId, proposalId, now, trusted);

    // §42 task 终态 / §43 cancel。
    if (task.status === "SUCCEEDED" || task.status === "FAILED") return this.#finalizeEarly(finalize, DECISION_STATUS.DENIED, TOOL_ERROR.TASK_TERMINAL);
    if (task.status === "CANCELLED" || task.cancel_requested) return this.#finalizeEarly(finalize, DECISION_STATUS.BLOCKED, TOOL_ERROR.TASK_CANCELLED);

    // §41 stale run：proposal 必须属于当前（最新）run。
    if (runId) {
      const runs = this.taskStore.harnessRunsOfTask(taskId);
      if (!runs.some((r) => r.run_id === runId)) return this.#finalizeEarly(finalize, DECISION_STATUS.BLOCKED, TOOL_ERROR.TOOL_PROPOSAL_STALE);
      const latest = runs[runs.length - 1];
      if (latest && latest.run_id !== runId) return this.#finalizeEarly(finalize, DECISION_STATUS.BLOCKED, TOOL_ERROR.TOOL_PROPOSAL_STALE);
    }

    // §14/§45：tool resolve + risk 来自 Registry，Harness payload 无效。
    const resolved = this.registry.resolve(toolId, toolVersion);
    if (!resolved.ok) {
      const decision = resolved.error === TOOL_ERROR.TOOL_ARGUMENT_INVALID ? DECISION_STATUS.INVALID : DECISION_STATUS.DENIED;
      return finalize({ decision, reasonCode: resolved.error, contract: resolved.contract || null, resolvedToolId: String(toolId == null ? "" : toolId), resolvedVersion: Number(toolVersion) || 0 });
    }
    const contract = resolved.contract;

    // §12/§13 schema validation（additionalProperties=false）。
    const validation = this.registry.validateInput(contract, args);
    if (!validation.ok) return finalize({ decision: DECISION_STATUS.INVALID, reasonCode: TOOL_ERROR.TOOL_ARGUMENT_INVALID, contract, schemaErrors: validation.errors });

    // §23/§24 防御性检查：禁止 credential/shell/absolute path。
    const badKeys = forbiddenArgumentKeys(args);
    if (badKeys.length) return finalize({ decision: DECISION_STATUS.INVALID, reasonCode: TOOL_ERROR.TOOL_ARGUMENT_FORBIDDEN_FIELD, contract });
    if (containsAbsolutePath(args)) return finalize({ decision: DECISION_STATUS.INVALID, reasonCode: TOOL_ERROR.TOOL_ARGUMENT_INVALID, contract });

    // §19/§20/§22 资源动作授权：ResourceRef + agent useByAgent。
    const resourceRefs = [];
    for (const action of contract.resourceActions || []) {
      const ref = args && (args.resourceRef || (Array.isArray(args.resourceRefs) ? args.resourceRefs[0] : null));
      if (!ref) return finalize({ decision: DECISION_STATUS.DENIED, reasonCode: TOOL_ERROR.TOOL_RESOURCE_REF_REQUIRED, contract });
      resourceRefs.push(String(ref));
      const authz = this.authService.authorize({ context: trusted, application: { appId: task.app_id }, action, resource: String(ref) });
      if (authz.decision !== "ALLOW") {
        const reasonCode = authz.reasonCode === "AGENT_USE_NOT_AUTHORIZED" ? TOOL_ERROR.TOOL_AGENT_USE_NOT_AUTHORIZED : TOOL_ERROR.TOOL_FORBIDDEN;
        return finalize({ decision: DECISION_STATUS.DENIED, reasonCode, contract });
      }
    }

    // §21 App Principal Tool 权限（同一 D3 app grant，scope=TOOL）。
    for (const perm of contract.requiredPermissions || []) {
      const t = this.authService.authorizeTool({ context: trusted, action: perm });
      if (t.decision !== "ALLOW") return finalize({ decision: DECISION_STATUS.DENIED, reasonCode: TOOL_ERROR.TOOL_APP_NOT_GRANTED, contract });
    }

    // §17/§58 approval policy：risk 决定 decision；本阶段仍 0 执行。
    const plan = this.registry.buildExecutionPlan(contract, args, resourceRefs);
    const decision = contract.requiresApproval ? DECISION_STATUS.APPROVAL_REQUIRED : DECISION_STATUS.ALLOWED;
    const reasonCode = contract.requiresApproval ? TOOL_ERROR.TOOL_APPROVAL_REQUIRED : "ALLOW";
    return finalize({ decision, reasonCode, contract, plan });
  }

  #safeExecution(row) {
    if (!row) return null;
    return { executionId: row.execution_id, proposalId: row.proposal_id, decisionId: row.decision_id || null, taskId: row.task_id, stepId: row.step_id || null, runId: row.run_id || null, toolId: row.tool_id, toolVersion: row.tool_version, status: row.status, startedAt: row.started_at, completedAt: row.completed_at == null ? null : row.completed_at, resultRef: row.result_ref || null, resultHash: row.result_hash || null, verificationStatus: row.verification_status || null, errorCode: row.error_code || null };
  }
  #argsOf(proposal) { try { return proposal && proposal.arguments_safe ? JSON.parse(proposal.arguments_safe) : {}; } catch { return {}; } }

  /** §5/§6/§19/§20/§43：执行前重新授权资源动作 + App Tool 权限（agent=true → useByAgent）。*/
  #authorizeExecution({ trusted, task, contract, args }) {
    for (const action of contract.resourceActions || []) {
      const ref = args && (args.resourceRef || (Array.isArray(args.resourceRefs) ? args.resourceRefs[0] : null));
      if (!ref) return { ok: false, error: TOOL_ERROR.TOOL_RESOURCE_REF_REQUIRED };
      // §99：Resource 在 propose 后被删除/trash → RESOURCE_NOT_AVAILABLE，绝不返回 stale metadata。
      const store = this.authService.store;
      if (store && typeof store.resourceByRef === "function") {
        const row = store.resourceByRef(String(ref));
        const status = row ? String(row.registry_status || row.status || "") : "";
        if (!row || (status && status !== "active")) return { ok: false, error: TOOL_ERROR.RESOURCE_NOT_AVAILABLE };
      }
      const authz = this.authService.authorize({ context: trusted, application: { appId: task.app_id }, action, resource: String(ref) });
      if (authz.decision !== "ALLOW") {
        let reasonCode = TOOL_ERROR.TOOL_FORBIDDEN;
        if (authz.reasonCode === "AGENT_USE_NOT_AUTHORIZED") reasonCode = TOOL_ERROR.TOOL_AGENT_USE_NOT_AUTHORIZED;
        else if (authz.reasonCode === "RESOURCE_NOT_AVAILABLE") reasonCode = TOOL_ERROR.RESOURCE_NOT_AVAILABLE;
        return { ok: false, error: reasonCode };
      }
    }
    for (const perm of contract.requiredPermissions || []) {
      const t = this.authService.authorizeTool({ context: trusted, action: perm });
      if (t.decision !== "ALLOW") return { ok: false, error: TOOL_ERROR.TOOL_APP_NOT_GRANTED };
    }
    return { ok: true };
  }

  #recordBlockedExecution({ proposal, decision, taskId, stepId, runId, contract, error }) {
    const execution = this.toolStore.transactSync(() => this.toolStore.insertExecution({ proposalId: proposal.proposal_id, decisionId: decision ? decision.decision_id : null, taskId, stepId, runId, toolId: contract.toolId, toolVersion: contract.version, status: "BLOCKED", startedAt: this.#now(), completedAt: this.#now(), errorCode: error }));
    this.#audit({ actorUserId: null, appId: null, toolRef: contract.toolId, action: "tool.execution_blocked", decision: "BLOCKED", reasonCode: error, requestId: null });
    return { ok: false, duplicate: false, executed: false, executionStatus: "BLOCKED", execution: this.#safeExecution(execution), result: null, verificationStatus: null, error };
  }
  #finishExecution({ execution, error, status, verificationStatus = null, auditAction = null }) {
    const updated = this.toolStore.transactSync(() => this.toolStore.updateExecution(execution.execution_id, { status, completedAt: this.#now(), verificationStatus, errorCode: error }));
    this.#audit({ actorUserId: null, appId: null, toolRef: execution.tool_id, action: auditAction || (status === "BLOCKED" ? "tool.execution_blocked" : "tool.execution_failed"), decision: status, reasonCode: error, requestId: null });
    return { ok: false, duplicate: false, executed: false, executionStatus: status, execution: this.#safeExecution(updated), result: null, verificationStatus, error };
  }

  /** D4-03B：真实执行 READ_ONLY Tool。execute 前必须 reauthorize；失败绝不返回数据。*/
  async executeReadOnly({ context = {}, taskId, stepId = null, runId = null, proposalId, expectedRevision = null, signal = null, timeoutMs = 15000 } = {}) {
    const now = this.#now();
    const denied = (error, extra = {}) => ({ ok: false, duplicate: false, executed: false, executionStatus: "NOT_EXECUTED", execution: null, result: null, verificationStatus: null, error, ...extra });
    if (!proposalId || !taskId) return denied(TOOL_ERROR.INVALID_INPUT);
    const proposal = this.toolStore.proposalById(proposalId);
    if (!proposal) return denied(TOOL_ERROR.TOOL_NOT_FOUND);
    const decision = this.toolStore.decisionByProposal(proposalId);
    if (!decision) return denied(TOOL_ERROR.INVALID_INPUT, { detail: "NO_DECISION" });
    if (decision.decision !== DECISION_STATUS.ALLOWED) return denied(decision.decision === DECISION_STATUS.APPROVAL_REQUIRED ? TOOL_ERROR.WRITE_EXECUTION_DISABLED : TOOL_ERROR.TOOL_FORBIDDEN, { decisionStatus: decision.decision });
    const resolved = this.registry.resolve(proposal.tool_id, proposal.tool_version);
    if (!resolved.ok) return denied(resolved.error);
    const contract = resolved.contract;
    if (contract.riskClass !== "READ_ONLY") return denied(TOOL_ERROR.WRITE_EXECUTION_DISABLED);
    if (decision.risk_class && decision.risk_class !== contract.riskClass) return denied(TOOL_ERROR.TOOL_PLAN_STALE);
    const adapter = this.adapterFor ? this.adapterFor({ executionProvider: contract.executionProvider, toolId: contract.toolId }) : null;
    if (!adapter) return denied(TOOL_ERROR.TOOL_NOT_EXECUTABLE);

    // §10 duplicate：返回既有 execution，绝不再调用 Domain。
    const existing = this.toolStore.executionByProposal(proposalId);
    if (existing) return { ok: existing.status === "SUCCEEDED", duplicate: true, executed: existing.status === "SUCCEEDED", executionStatus: existing.status, execution: this.#safeExecution(existing), result: null, verificationStatus: existing.verification_status || null, error: existing.status === "SUCCEEDED" ? null : (existing.error_code || TOOL_ERROR.TOOL_EXECUTION_FAILED) };

    const trusted = { sessionRef: context.sessionRef, appId: context.appId, source: "agent", agent: true, requestId: context.requestId || null };
    const actor = this.authService.resolveActor({ context: trusted });
    if (!actor.ok) return this.#recordBlockedExecution({ proposal, decision, taskId, stepId, runId, contract, error: TOOL_ERROR.TOOL_AUTHORIZATION_REVOKED });
    trusted.actorUserId = actor.user.id;
    const task = this.taskStore.taskById(taskId);
    if (!task || task.user_id !== actor.user.id || task.app_id !== trusted.appId) return this.#recordBlockedExecution({ proposal, decision, taskId, stepId, runId, contract, error: TOOL_ERROR.TOOL_FORBIDDEN });
    if (task.cancel_requested || task.status === "CANCELLED") return this.#recordBlockedExecution({ proposal, decision, taskId, stepId, runId, contract, error: TOOL_ERROR.TASK_CANCELLED });
    if (task.status !== "RUNNING") return this.#recordBlockedExecution({ proposal, decision, taskId, stepId, runId, contract, error: TOOL_ERROR.TOOL_EXECUTION_STALE });
    if (expectedRevision != null && Number(expectedRevision) !== Number(task.revision)) return this.#recordBlockedExecution({ proposal, decision, taskId, stepId, runId, contract, error: TOOL_ERROR.TOOL_EXECUTION_STALE });
    if (stepId) { const step = this.taskStore.stepById(stepId); if (!step || step.task_id !== taskId || step.status !== "RUNNING") return this.#recordBlockedExecution({ proposal, decision, taskId, stepId, runId, contract, error: TOOL_ERROR.TOOL_EXECUTION_STALE }); }
    if (runId) {
      const runs = this.taskStore.harnessRunsOfTask(taskId);
      const latest = runs[runs.length - 1];
      if (!runs.some((r) => r.run_id === runId) || (latest && latest.run_id !== runId)) return this.#recordBlockedExecution({ proposal, decision, taskId, stepId, runId, contract, error: TOOL_ERROR.TOOL_PROPOSAL_STALE });
    }
    const args = this.#argsOf(proposal);
    const auth = this.#authorizeExecution({ trusted, task, contract, args });
    if (!auth.ok) return this.#recordBlockedExecution({ proposal, decision, taskId, stepId, runId, contract, error: auth.error });

    const execution = this.toolStore.transactSync(() => this.toolStore.insertExecution({ proposalId, decisionId: decision.decision_id, taskId, stepId, runId, toolId: contract.toolId, toolVersion: contract.version, status: "RUNNING", startedAt: now }));
    this.#audit({ actorUserId: actor.user.id, appId: trusted.appId, toolRef: contract.toolId, action: "tool.execution_started", decision: "RUNNING", reasonCode: null, requestId: trusted.requestId });

    let execResult = null;
    try {
      await adapter.prepare({ context: trusted, args });
      let timer = null;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("TOOL_TIMEOUT"), { code: TOOL_ERROR.TOOL_TIMEOUT })), Math.max(1, Number(timeoutMs) || 15000)); });
      execResult = await Promise.race([adapter.execute({ context: trusted, args, signal }), timeout]).finally(() => clearTimeout(timer));
    } catch (e) {
      const aborted = !!(signal && signal.aborted);
      const code = aborted ? TOOL_ERROR.TASK_CANCELLED : ((e && e.code) ? e.code : TOOL_ERROR.TOOL_EXECUTION_FAILED);
      return this.#finishExecution({ execution, error: code, status: aborted ? "BLOCKED" : "FAILED" });
    }
    if (signal && signal.aborted) return this.#finishExecution({ execution, error: TOOL_ERROR.TASK_CANCELLED, status: "BLOCKED" });
    if (!execResult || !execResult.ok) return this.#finishExecution({ execution, error: (execResult && execResult.error) || TOOL_ERROR.TOOL_EXECUTION_FAILED, status: "FAILED" });

    // §24/§26/§77：output schema + adapter verify。
    const schemaCheck = this.registry.validateOutput(contract, execResult.result);
    if (!schemaCheck.ok) return this.#finishExecution({ execution, error: TOOL_ERROR.TOOL_OUTPUT_INVALID, status: "FAILED", verificationStatus: "FAIL", auditAction: "tool.verification_failed" });
    const vres = await adapter.verify({ context: trusted, args, result: execResult.result });
    if (!vres || !vres.ok) return this.#finishExecution({ execution, error: TOOL_ERROR.TOOL_VERIFICATION_FAILED, status: "FAILED", verificationStatus: "FAIL", auditAction: "tool.verification_failed" });

    // §39/§41/§42/§43 commit gate：revision / cancel / session / app 任一变化都不得返回数据。
    const freshActor = this.authService.resolveActor({ context: trusted });
    const freshTask = this.taskStore.taskById(taskId);
    if (!freshActor.ok) return this.#finishExecution({ execution, error: TOOL_ERROR.TOOL_AUTHORIZATION_REVOKED, status: "BLOCKED", verificationStatus: "PASS" });
    if (!freshTask || freshTask.cancel_requested || freshTask.status !== "RUNNING") return this.#finishExecution({ execution, error: TOOL_ERROR.TASK_CANCELLED, status: "BLOCKED", verificationStatus: "PASS" });
    if (expectedRevision != null && Number(expectedRevision) !== Number(freshTask.revision)) return this.#finishExecution({ execution, error: TOOL_ERROR.TOOL_EXECUTION_STALE, status: "BLOCKED", verificationStatus: "PASS" });
    if (decision.risk_class && decision.risk_class !== contract.riskClass) return this.#finishExecution({ execution, error: TOOL_ERROR.TOOL_PLAN_STALE, status: "BLOCKED", verificationStatus: "PASS" });

    const resultHash = fingerprint(execResult.result);
    const updated = this.toolStore.transactSync(() => this.toolStore.updateExecution(execution.execution_id, { status: "SUCCEEDED", completedAt: this.#now(), resultRef: contract.toolId, resultHash, verificationStatus: "PASS", errorCode: null }));
    this.#audit({ actorUserId: actor.user.id, appId: trusted.appId, toolRef: contract.toolId, action: "tool.execution_succeeded", decision: "ALLOW", reasonCode: "ALLOW", requestId: trusted.requestId });
    this.lastExecution = this.#safeExecution(updated);
    return { ok: true, duplicate: false, executed: true, executionStatus: "SUCCEEDED", execution: this.#safeExecution(updated), result: execResult.result, verificationStatus: "PASS", error: null };
  }

  #finalizeEarly(finalize, decision, reasonCode) {
    return finalize({ decision, reasonCode });
  }
  /** 极端早退（session/task gate 失败）：也必须留下 proposal/decision 记录与审计；对外 reason 收敛为 reason 码。*/
  #rejectBeforePersist(reason, detail, toolId, toolVersion, taskId, stepId, runId, proposalId, now, trusted = null) {
    const status = reason === TOOL_ERROR.TOOL_FORBIDDEN ? DECISION_STATUS.DENIED : DECISION_STATUS.INVALID;
    const result = this.toolStore.transactSync(() => {
      const proposal = this.toolStore.insertProposal({ proposalId, taskId: taskId == null ? "" : taskId, stepId, runId, toolId: String(toolId == null ? "" : toolId), toolVersion: Number(toolVersion) || 0, argumentsSafe: {}, argumentsHash: fingerprint({}), status: proposalStatusFor(status), createdAt: now });
      const decisionRow = this.toolStore.insertDecision({ proposalId: proposal.proposal_id, decision: status, reasonCode: reason, riskClass: null, approvalRequired: false, createdAt: now });
      return { proposal, decisionRow };
    });
    this.#audit({ actorUserId: (trusted && trusted.actorUserId) || null, appId: (trusted && trusted.appId) || null, toolRef: result.proposal.tool_id, action: "tool.authorization_denied", decision: status, reasonCode: reason, requestId: (trusted && trusted.requestId) || null });
    void detail;
    return { ok: true, duplicate: false, proposal: safeProposal(result.proposal), decision: safeDecision(result.decisionRow), decisionStatus: status, reasonCode: reason, executionPlan: null, executionStatus: EXECUTION_STATUS.NOT_EXECUTED, executed: false };
  }
}

module.exports = { ControlledToolProxy, safeProposal, safeDecision, proposalStatusFor };
