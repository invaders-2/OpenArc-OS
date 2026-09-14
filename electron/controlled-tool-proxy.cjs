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
  constructor({ registry, toolStore, authService, taskStore, clock = null, logger = null } = {}) {
    if (!registry) throw new Error("ControlledToolProxy 需要 ToolRegistry");
    if (!toolStore) throw new Error("ControlledToolProxy 需要 ToolStore");
    if (!authService) throw new Error("ControlledToolProxy 需要 AuthorizationService");
    if (!taskStore) throw new Error("ControlledToolProxy 需要 TaskStore");
    this.registry = registry;
    this.toolStore = toolStore;
    this.authService = authService;
    this.taskStore = taskStore;
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
