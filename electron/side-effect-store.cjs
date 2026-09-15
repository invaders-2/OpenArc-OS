/**
 * D4-03C1 · Side-effect Authority 持久层（同一条 SQLite 连接与事务队列）。
 *
 * 只存 safe refs / hash / 状态机；不存 credential / capability / raw Authorization /
 * full unsafe payload。UNIQUE(call_id) + UNIQUE(idempotency_key) 保证 authority 唯一。
 */
"use strict";
const crypto = require("node:crypto");

const SQL = {
  insertCall: "INSERT INTO side_effect_calls (call_id, proposal_id, decision_id, task_id, step_id, run_id, tool_id, tool_version, arguments_hash, plan_hash, idempotency_key, effect_class, status, preconditions_safe, expected_effects_safe, created_at, updated_at, authorized_at, approved_at, leased_at, started_at, completed_at, verification_status, error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  callById: "SELECT * FROM side_effect_calls WHERE call_id = ?",
  callByIdempotencyKey: "SELECT * FROM side_effect_calls WHERE idempotency_key = ?",
  callsOfTask: "SELECT * FROM side_effect_calls WHERE task_id = ? ORDER BY created_at, call_id",
  callsByStatus: "SELECT * FROM side_effect_calls WHERE status = ? ORDER BY created_at",
  updateCall: "UPDATE side_effect_calls SET status = ?, updated_at = ?, authorized_at = ?, approved_at = ?, leased_at = ?, started_at = ?, completed_at = ?, verification_status = ?, error_code = ?, recovery_safe = ? WHERE call_id = ?",
  insertApproval: "INSERT INTO tool_approvals (approval_id, call_id, actor_user_id, session_ref, decision, plan_hash, approved_tool_id, approved_tool_version, approved_arguments_hash, approved_effect_class, approved_expected_effects, created_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  approvalById: "SELECT * FROM tool_approvals WHERE approval_id = ?",
  approvalsOfCall: "SELECT * FROM tool_approvals WHERE call_id = ? ORDER BY created_at",
  updateApproval: "UPDATE tool_approvals SET decision = ?, revoked_at = ?, expires_at = ? WHERE approval_id = ?",
  insertLease: "INSERT INTO side_effect_leases (lease_id, call_id, holder_id, holder_instance_id, status, issued_at, expires_at, released_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?)",
  leaseById: "SELECT * FROM side_effect_leases WHERE lease_id = ?",
  leasesOfCall: "SELECT * FROM side_effect_leases WHERE call_id = ? ORDER BY issued_at",
  activeLeaseOfCall: "SELECT * FROM side_effect_leases WHERE call_id = ? AND status = 'ACTIVE' ORDER BY issued_at DESC LIMIT 1",
  activeLeases: "SELECT * FROM side_effect_leases WHERE status = 'ACTIVE' ORDER BY issued_at",
  updateLease: "UPDATE side_effect_leases SET status = ?, released_at = ?, revoked_at = ? WHERE lease_id = ?",
};

const CALL_COLUMNS = new Set(["status", "updated_at", "authorized_at", "approved_at", "leased_at", "started_at", "completed_at", "verification_status", "error_code"]);
const APPROVAL_COLUMNS = new Set(["decision", "revoked_at", "expires_at"]);
const LEASE_COLUMNS = new Set(["status", "released_at", "revoked_at"]);
const CALL_JSON = new Set(["preconditions_safe", "expected_effects_safe", "recovery_safe"]);

const newId = (prefix) => prefix + "_" + crypto.randomBytes(10).toString("base64url");

function parseJson(text) { if (text == null) return null; try { return JSON.parse(text); } catch { return null; } }

function safeCall(row) {
  if (!row) return null;
  return {
    callId: row.call_id,
    proposalId: row.proposal_id || null,
    decisionId: row.decision_id || null,
    taskId: row.task_id,
    stepId: row.step_id || null,
    runId: row.run_id || null,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    argumentsHash: row.arguments_hash || null,
    planHash: row.plan_hash || null,
    idempotencyKey: row.idempotency_key || null,
    effectClass: row.effect_class,
    status: row.status,
    preconditionsSafe: parseJson(row.preconditions_safe),
    expectedEffectsSafe: parseJson(row.expected_effects_safe),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    authorizedAt: row.authorized_at == null ? null : row.authorized_at,
    approvedAt: row.approved_at == null ? null : row.approved_at,
    leasedAt: row.leased_at == null ? null : row.leased_at,
    startedAt: row.started_at == null ? null : row.started_at,
    completedAt: row.completed_at == null ? null : row.completed_at,
    verificationStatus: row.verification_status || null,
    errorCode: row.error_code || null,
    recoverySafe: parseJson(row.recovery_safe),
  };
}
function safeApproval(row) {
  if (!row) return null;
  return {
    approvalId: row.approval_id,
    callId: row.call_id,
    actorUserId: row.actor_user_id || null,
    sessionRef: row.session_ref || null,
    decision: row.decision,
    planHash: row.plan_hash || null,
    approvedToolId: row.approved_tool_id || null,
    approvedToolVersion: row.approved_tool_version == null ? null : row.approved_tool_version,
    approvedArgumentsHash: row.approved_arguments_hash || null,
    approvedEffectClass: row.approved_effect_class || null,
    approvedExpectedEffects: parseJson(row.approved_expected_effects),
    createdAt: row.created_at,
    expiresAt: row.expires_at == null ? null : row.expires_at,
    revokedAt: row.revoked_at == null ? null : row.revoked_at,
  };
}
function safeLease(row) {
  if (!row) return null;
  return {
    leaseId: row.lease_id,
    callId: row.call_id,
    holderId: row.holder_id,
    holderInstanceId: row.holder_instance_id || null,
    status: row.status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at == null ? null : row.expires_at,
    releasedAt: row.released_at == null ? null : row.released_at,
    revokedAt: row.revoked_at == null ? null : row.revoked_at,
  };
}

class SideEffectStore {
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("SideEffectStore 需要 IdentityStore");
    this.identity = identity;
    this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
  }
  transactSync(fn) { return this.identity.transactSync(fn); }
  #now() { return this.clock(); }

  insertCall({ callId = null, proposalId = null, decisionId = null, taskId, stepId = null, runId = null, toolId, toolVersion, argumentsHash = null, planHash = null, idempotencyKey = null, effectClass, status = "PLANNED", preconditionsSafe = null, expectedEffectsSafe = null, createdAt = null, updatedAt = null, verificationStatus = null, errorCode = null }) {
    const id = callId || newId("scall");
    const now = Number(createdAt == null ? this.#now() : createdAt);
    this.db.prepare(SQL.insertCall).run(id, proposalId, decisionId, String(taskId), stepId, runId, String(toolId), Number(toolVersion), argumentsHash, planHash, idempotencyKey, String(effectClass), String(status), preconditionsSafe == null ? null : JSON.stringify(preconditionsSafe), expectedEffectsSafe == null ? null : JSON.stringify(expectedEffectsSafe), now, Number(updatedAt == null ? now : updatedAt), null, null, null, null, null, verificationStatus, errorCode);
    return this.callById(id);
  }
  callById(id) { return safeCall(this.db.prepare(SQL.callById).get(String(id || ""))); }
  rawCallById(id) { return this.db.prepare(SQL.callById).get(String(id || "")) || null; }
  callByIdempotencyKey(key) { return safeCall(this.db.prepare(SQL.callByIdempotencyKey).get(String(key || ""))); }
  callsOfTask(taskId) { return this.db.prepare(SQL.callsOfTask).all(String(taskId || "")).map(safeCall); }
  callsByStatus(status) { return this.db.prepare(SQL.callsByStatus).all(String(status)).map(safeCall); }
  updateCall(id, patch = {}) {
    const cur = this.rawCallById(id);
    if (!cur) return null;
    const pick = (k) => (Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : cur[k]);
    const json = (k) => (Object.prototype.hasOwnProperty.call(patch, k) ? (patch[k] == null ? null : JSON.stringify(patch[k])) : cur[k]);
    for (const k of Object.keys(patch)) if (!CALL_COLUMNS.has(k) && !CALL_JSON.has(k)) throw new Error("invalid call column: " + k);
    this.db.prepare(SQL.updateCall).run(
      String(pick("status")), Number(pick("updated_at") == null ? this.#now() : pick("updated_at")),
      pick("authorized_at") == null ? null : Number(pick("authorized_at")),
      pick("approved_at") == null ? null : Number(pick("approved_at")),
      pick("leased_at") == null ? null : Number(pick("leased_at")),
      pick("started_at") == null ? null : Number(pick("started_at")),
      pick("completed_at") == null ? null : Number(pick("completed_at")),
      pick("verification_status") == null ? null : String(pick("verification_status")),
      pick("error_code") == null ? null : String(pick("error_code")),
      json("recovery_safe"),
      String(id),
    );
    return this.callById(id);
  }

  insertApproval({ approvalId = null, callId, actorUserId = null, sessionRef = null, decision, planHash = null, approvedToolId = null, approvedToolVersion = null, approvedArgumentsHash = null, approvedEffectClass = null, approvedExpectedEffects = null, createdAt = null, expiresAt = null, revokedAt = null }) {
    const id = approvalId || newId("tappr");
    this.db.prepare(SQL.insertApproval).run(id, String(callId), actorUserId, sessionRef, String(decision), planHash, approvedToolId, approvedToolVersion == null ? null : Number(approvedToolVersion), approvedArgumentsHash, approvedEffectClass, approvedExpectedEffects == null ? null : JSON.stringify(approvedExpectedEffects), Number(createdAt == null ? this.#now() : createdAt), expiresAt == null ? null : Number(expiresAt), revokedAt == null ? null : Number(revokedAt));
    return this.approvalById(id);
  }
  approvalById(id) { return safeApproval(this.db.prepare(SQL.approvalById).get(String(id || ""))); }
  approvalsOfCall(callId) { return this.db.prepare(SQL.approvalsOfCall).all(String(callId || "")).map(safeApproval); }
  latestApprovalOfCall(callId) { const all = this.approvalsOfCall(callId); return all.length ? all[all.length - 1] : null; }
  updateApproval(id, patch = {}) {
    const cur = this.approvalById(id);
    if (!cur) return null;
    for (const k of Object.keys(patch)) if (!APPROVAL_COLUMNS.has(k)) throw new Error("invalid approval column: " + k);
    const pick = (k, fallback) => (Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : fallback);
    this.db.prepare(SQL.updateApproval).run(String(pick("decision", cur.decision)), pick("revoked_at", cur.revokedAt) == null ? null : Number(pick("revoked_at", cur.revokedAt)), pick("expires_at", cur.expiresAt) == null ? null : Number(pick("expires_at", cur.expiresAt)), String(id));
    return this.approvalById(id);
  }

  insertLease({ leaseId = null, callId, holderId, holderInstanceId = null, status = "ACTIVE", issuedAt = null, expiresAt = null, releasedAt = null, revokedAt = null }) {
    const id = leaseId || newId("slease");
    this.db.prepare(SQL.insertLease).run(id, String(callId), String(holderId), holderInstanceId, String(status), Number(issuedAt == null ? this.#now() : issuedAt), expiresAt == null ? null : Number(expiresAt), releasedAt == null ? null : Number(releasedAt), revokedAt == null ? null : Number(revokedAt));
    return this.leaseById(id);
  }
  leaseById(id) { return safeLease(this.db.prepare(SQL.leaseById).get(String(id || ""))); }
  leasesOfCall(callId) { return this.db.prepare(SQL.leasesOfCall).all(String(callId || "")).map(safeLease); }
  activeLeaseOfCall(callId) { return safeLease(this.db.prepare(SQL.activeLeaseOfCall).get(String(callId || ""))); }
  activeLeases() { return this.db.prepare(SQL.activeLeases).all().map(safeLease); }
  updateLease(id, patch = {}) {
    const cur = this.leaseById(id);
    if (!cur) return null;
    for (const k of Object.keys(patch)) if (!LEASE_COLUMNS.has(k)) throw new Error("invalid lease column: " + k);
    const pick = (k, fallback) => (Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : fallback);
    this.db.prepare(SQL.updateLease).run(String(pick("status", cur.status)), pick("released_at", cur.releasedAt) == null ? null : Number(pick("released_at", cur.releasedAt)), pick("revoked_at", cur.revokedAt) == null ? null : Number(pick("revoked_at", cur.revokedAt)), String(id));
    return this.leaseById(id);
  }
}

module.exports = { SideEffectStore, SQL, safeCall, safeApproval, safeLease };
