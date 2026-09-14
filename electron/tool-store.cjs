/**
 * D4-03A · Tool Proposal / Decision 持久层（同一条 SQLite 连接与事务队列）。
 *
 * 只存安全 projection 与 arguments_hash；**不存 raw provider key / proxy bearer /
 * 完整 raw arguments / absolute path**。tool_decisions 每 proposal 至多一条。
 */
"use strict";
const crypto = require("node:crypto");

const SQL = {
  insertProposal: "INSERT INTO task_tool_proposals (proposal_id, task_id, step_id, run_id, tool_id, tool_version, arguments_safe, arguments_hash, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  proposalById: "SELECT * FROM task_tool_proposals WHERE proposal_id = ?",
  proposalsOfTask: "SELECT * FROM task_tool_proposals WHERE task_id = ? ORDER BY created_at, proposal_id",
  updateProposal: "UPDATE task_tool_proposals SET status = ? WHERE proposal_id = ?",
  insertDecision: "INSERT INTO tool_decisions (decision_id, proposal_id, decision, reason_code, risk_class, approval_required, created_at) VALUES (?,?,?,?,?,?,?)",
  decisionById: "SELECT * FROM tool_decisions WHERE decision_id = ?",
  decisionByProposal: "SELECT * FROM tool_decisions WHERE proposal_id = ?",
  decisionsOfTask: "SELECT d.* FROM tool_decisions d JOIN task_tool_proposals p ON p.proposal_id = d.proposal_id WHERE p.task_id = ? ORDER BY d.created_at",
  insertExecution: "INSERT INTO tool_executions (execution_id, proposal_id, decision_id, task_id, step_id, run_id, tool_id, tool_version, status, started_at, completed_at, result_ref, result_hash, verification_status, error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  executionById: "SELECT * FROM tool_executions WHERE execution_id = ?",
  executionByProposal: "SELECT * FROM tool_executions WHERE proposal_id = ?",
  executionsOfTask: "SELECT * FROM tool_executions WHERE task_id = ? ORDER BY started_at",
  updateExecution: "UPDATE tool_executions SET status = ?, completed_at = ?, result_ref = ?, result_hash = ?, verification_status = ?, error_code = ? WHERE execution_id = ?",
  insertAudit: "INSERT INTO authorization_audit (at, actor_user_id, target_user_id, app_id, department_id, resource_ref, action, decision, reason_code, permission_source, request_id, old_permissions, new_permissions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
};
const PROPOSAL_STATUS_ALL = new Set(["PROPOSED", "VALIDATED", "DENIED", "APPROVAL_REQUIRED", "INVALID", "BLOCKED"]);

const newId = (prefix) => prefix + "_" + crypto.randomBytes(10).toString("base64url");

class ToolStore {
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("ToolStore 需要 IdentityStore");
    this.identity = identity;
    this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
  }
  transactSync(fn) { return this.identity.transactSync(fn); }

  insertProposal({ proposalId = null, taskId, stepId = null, runId = null, toolId, toolVersion, argumentsSafe = null, argumentsHash = null, status = "PROPOSED", createdAt = null }) {
    const id = proposalId || newId("tprop");
    const now = this.clock();
    this.db.prepare(SQL.insertProposal).run(id, String(taskId), stepId, runId, String(toolId), Number(toolVersion), argumentsSafe == null ? null : (typeof argumentsSafe === "string" ? argumentsSafe : JSON.stringify(argumentsSafe)), argumentsHash, String(status), Number(createdAt == null ? now : createdAt));
    return this.proposalById(id);
  }
  proposalById(id) { return this.db.prepare(SQL.proposalById).get(String(id || "")) || null; }
  proposalsOfTask(taskId) { return this.db.prepare(SQL.proposalsOfTask).all(String(taskId || "")); }
  updateProposalStatus(id, status) {
    if (!PROPOSAL_STATUS_ALL.has(String(status))) throw new Error("invalid proposal status: " + status);
    this.db.prepare(SQL.updateProposal).run(String(status), String(id));
    return this.proposalById(id);
  }

  insertDecision({ decisionId = null, proposalId, decision, reasonCode = null, riskClass = null, approvalRequired = false, createdAt = null }) {
    const id = decisionId || newId("tdec");
    const now = this.clock();
    this.db.prepare(SQL.insertDecision).run(id, String(proposalId), String(decision), reasonCode, riskClass, approvalRequired ? 1 : 0, Number(createdAt == null ? now : createdAt));
    return this.decisionById(id);
  }
  decisionById(id) { return this.db.prepare(SQL.decisionById).get(String(id || "")) || null; }
  decisionByProposal(proposalId) { return this.db.prepare(SQL.decisionByProposal).get(String(proposalId || "")) || null; }
  decisionsOfTask(taskId) { return this.db.prepare(SQL.decisionsOfTask).all(String(taskId || "")); }

  // ------------------------------------------------------- Tool Execution（D4-03B）
  insertExecution({ executionId = null, proposalId, decisionId = null, taskId, stepId = null, runId = null, toolId, toolVersion, status = "PENDING", startedAt = null, completedAt = null, resultRef = null, resultHash = null, verificationStatus = null, errorCode = null }) {
    const id = executionId || newId("texec");
    const now = this.clock();
    this.db.prepare(SQL.insertExecution).run(id, String(proposalId), decisionId, String(taskId), stepId, runId, String(toolId), Number(toolVersion), String(status), Number(startedAt == null ? now : startedAt), completedAt, resultRef, resultHash, verificationStatus, errorCode);
    return this.executionById(id);
  }
  executionById(id) { return this.db.prepare(SQL.executionById).get(String(id || "")) || null; }
  executionByProposal(proposalId) { return this.db.prepare(SQL.executionByProposal).get(String(proposalId || "")) || null; }
  executionsOfTask(taskId) { return this.db.prepare(SQL.executionsOfTask).all(String(taskId || "")); }
  updateExecution(id, patch = {}) {
    const cur = this.executionById(id);
    if (!cur) return null;
    this.db.prepare(SQL.updateExecution).run(String(patch.status == null ? cur.status : patch.status), patch.completedAt == null ? cur.completed_at : Number(patch.completedAt), patch.resultRef == null ? cur.result_ref : patch.resultRef, patch.resultHash == null ? cur.result_hash : patch.resultHash, patch.verificationStatus == null ? cur.verification_status : patch.verificationStatus, patch.errorCode == null ? cur.error_code : patch.errorCode, String(id));
    return this.executionById(id);
  }

  /** Tool audit 走 D3 authorization_audit；只记录 action/decision/reason，不含 arguments。*/
  insertToolAudit({ at = null, actorUserId = null, appId = null, toolRef = null, action, decision, reasonCode = null, requestId = null, permissionSource = null }) {
    const now = Number(at == null ? this.clock() : at);
    this.db.prepare(SQL.insertAudit).run(now, actorUserId, null, appId, null, toolRef, String(action), String(decision), reasonCode, permissionSource, requestId, null, null);
  }
}

module.exports = { ToolStore, SQL };
