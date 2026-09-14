/**
 * D4-02A · Task Runtime 持久层（SQLite，走 IdentityStore 同一条连接与事务队列）。
 *
 * 只存 metadata 与 append-only event；**不存 raw provider key / proxy bearer /
 * Authorization header**。TaskEvent 的 sequence 由 UNIQUE(task_id, sequence) 与
 * "读 MAX+1 后立刻插入"共同保证严格递增。
 */
"use strict";
const crypto = require("node:crypto");

const SQL = {
  insertTask: "INSERT INTO tasks (task_id, user_id, session_ref, app_id, status, goal, created_at, updated_at, started_at, completed_at, model_config_id, model_config_version, current_step_id, revision, cancel_requested, budget_snapshot, permission_snapshot_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  taskById: "SELECT * FROM tasks WHERE task_id = ?",
  tasksByUser: "SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at",
  tasksByUserApp: "SELECT * FROM tasks WHERE user_id = ? AND app_id = ? ORDER BY created_at",
  allTasks: "SELECT * FROM tasks ORDER BY created_at",
  insertStep: "INSERT INTO task_steps (step_id, task_id, sequence, kind, status, input, output_ref, started_at, completed_at, attempt, max_attempts) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  stepById: "SELECT * FROM task_steps WHERE step_id = ?",
  stepsOfTask: "SELECT * FROM task_steps WHERE task_id = ? ORDER BY sequence",
  maxStepSequence: "SELECT COALESCE(MAX(sequence),0) AS s FROM task_steps WHERE task_id = ?",
  insertCall: "INSERT INTO task_model_calls (call_id, task_id, step_id, model_config_id, model_config_version, request_id, status, started_at, completed_at, usage, provider_error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  callById: "SELECT * FROM task_model_calls WHERE call_id = ?",
  callsOfTask: "SELECT * FROM task_model_calls WHERE task_id = ? ORDER BY started_at",
  insertEvent: "INSERT INTO task_events (event_id, task_id, sequence, event_type, created_at, safe_payload) VALUES (?,?,?,?,?,?)",
  eventById: "SELECT * FROM task_events WHERE event_id = ?",
  eventsOfTask: "SELECT * FROM task_events WHERE task_id = ? ORDER BY sequence",
  maxEventSequence: "SELECT COALESCE(MAX(sequence),0) AS s FROM task_events WHERE task_id = ?",
  insertRun: "INSERT INTO task_harness_runs (run_id, task_id, step_id, status, harness_version, acp_version, model_config_id, model_config_version, started_at, completed_at, stop_reason, error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  runById: "SELECT * FROM task_harness_runs WHERE run_id = ?",
  runsOfTask: "SELECT * FROM task_harness_runs WHERE task_id = ? ORDER BY started_at",
  insertArtifact: "INSERT INTO task_artifacts (artifact_id, task_id, step_id, run_id, type, safe_content, checksum, created_at) VALUES (?,?,?,?,?,?,?,?)",
  artifactById: "SELECT * FROM task_artifacts WHERE artifact_id = ?",
  artifactsOfTask: "SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at",
  insertVerification: "INSERT INTO task_verifications (verification_id, artifact_id, task_id, type, status, safe_details, created_at) VALUES (?,?,?,?,?,?,?)",
  verificationById: "SELECT * FROM task_verifications WHERE verification_id = ?",
  verificationsOfArtifact: "SELECT * FROM task_verifications WHERE artifact_id = ? ORDER BY created_at",
  verificationsOfTask: "SELECT * FROM task_verifications WHERE task_id = ? ORDER BY created_at",
};

const TASK_COLUMNS = new Set(["status", "updated_at", "started_at", "completed_at", "current_step_id", "revision", "cancel_requested", "model_config_id", "model_config_version", "budget_snapshot", "permission_snapshot_ref"]);
const STEP_COLUMNS = new Set(["status", "input", "output_ref", "started_at", "completed_at", "attempt", "max_attempts"]);
const CALL_COLUMNS = new Set(["status", "completed_at", "usage", "provider_error_code", "request_id", "step_id"]);
const TASK_JSON = new Set(["budget_snapshot"]);
const STEP_JSON = new Set(["input"]);
const CALL_JSON = new Set(["usage"]);
const RUN_COLUMNS = new Set(["status", "completed_at", "stop_reason", "error_code", "step_id"]);

const newId = (prefix) => prefix + "_" + crypto.randomBytes(10).toString("base64url");

class TaskStore {
  constructor({ identity, clock } = {}) {
    if (!identity) throw new Error("TaskStore 需要 IdentityStore");
    this.identity = identity;
    this.db = identity.connection;
    this.clock = typeof clock === "function" ? clock : identity.clock;
  }
  transactSync(fn) { return this.identity.transactSync(fn); }

  #update(table, idColumn, id, columns, jsonColumns, patch) {
    const sets = []; const vals = [];
    for (const [k, v] of Object.entries(patch || {})) {
      if (!columns.has(k)) continue;
      sets.push(k + " = ?");
      vals.push(jsonColumns.has(k) ? (v == null ? null : JSON.stringify(v)) : (typeof v === "boolean" ? (v ? 1 : 0) : v));
    }
    if (!sets.length) return null;
    vals.push(String(id));
    this.db.prepare("UPDATE " + table + " SET " + sets.join(", ") + " WHERE " + idColumn + " = ?").run(...vals);
    return true;
  }

  insertTask({ taskId, userId, sessionRef = null, appId, status, goal, createdAt, updatedAt, startedAt = null, completedAt = null, modelConfigId = null, modelConfigVersion = null, budgetSnapshot = null, permissionSnapshotRef = null }) {
    const id = taskId || newId("task");
    const now = this.clock();
    this.db.prepare(SQL.insertTask).run(id, String(userId), sessionRef, String(appId), String(status), String(goal), Number(createdAt == null ? now : createdAt), Number(updatedAt == null ? now : updatedAt), startedAt, completedAt, modelConfigId, modelConfigVersion == null ? null : Number(modelConfigVersion), null, 1, 0, budgetSnapshot == null ? null : JSON.stringify(budgetSnapshot), permissionSnapshotRef);
    return this.taskById(id);
  }
  taskById(id) { return this.db.prepare(SQL.taskById).get(String(id || "")) || null; }
  tasksByUser(userId, appId = null) { return (appId == null ? this.db.prepare(SQL.tasksByUser).all(String(userId || "")) : this.db.prepare(SQL.tasksByUserApp).all(String(userId || ""), String(appId))); }
  allTasks() { return this.db.prepare(SQL.allTasks).all(); }
  updateTask(id, patch) { this.#update("tasks", "task_id", id, TASK_COLUMNS, TASK_JSON, patch); return this.taskById(id); }

  insertStep({ stepId = null, taskId, sequence = null, kind = "model", status = "PENDING", input = null, outputRef = null, startedAt = null, completedAt = null, attempt = 1, maxAttempts = 1 }) {
    const id = stepId || newId("step");
    const seq = sequence == null ? this.nextStepSequence(taskId) : Number(sequence);
    this.db.prepare(SQL.insertStep).run(id, String(taskId), seq, String(kind), String(status), input == null ? null : JSON.stringify(input), outputRef, startedAt, completedAt, Number(attempt), Number(maxAttempts));
    return this.stepById(id);
  }
  stepById(id) { return this.db.prepare(SQL.stepById).get(String(id || "")) || null; }
  stepsOfTask(taskId) { return this.db.prepare(SQL.stepsOfTask).all(String(taskId || "")); }
  nextStepSequence(taskId) { return Number(this.db.prepare(SQL.maxStepSequence).get(String(taskId || "")).s) + 1; }
  updateStep(id, patch) { this.#update("task_steps", "step_id", id, STEP_COLUMNS, STEP_JSON, patch); return this.stepById(id); }

  insertCall({ callId = null, taskId, stepId = null, modelConfigId = null, modelConfigVersion = null, requestId = null, status = "STARTED", startedAt = null, completedAt = null, usage = null, providerErrorCode = null }) {
    const id = callId || newId("mcall");
    const now = this.clock();
    this.db.prepare(SQL.insertCall).run(id, String(taskId), stepId, modelConfigId, modelConfigVersion == null ? null : Number(modelConfigVersion), requestId, String(status), Number(startedAt == null ? now : startedAt), completedAt, usage == null ? null : JSON.stringify(usage), providerErrorCode);
    return this.callById(id);
  }
  callById(id) { return this.db.prepare(SQL.callById).get(String(id || "")) || null; }
  callsOfTask(taskId) { return this.db.prepare(SQL.callsOfTask).all(String(taskId || "")); }
  updateCall(id, patch) { this.#update("task_model_calls", "call_id", id, CALL_COLUMNS, CALL_JSON, patch); return this.callById(id); }

  appendEvent({ taskId, eventType, safePayload = null, at = null }) {
    const now = Number(at == null ? this.clock() : at);
    const seq = Number(this.db.prepare(SQL.maxEventSequence).get(String(taskId)).s) + 1;
    const id = newId("tev");
    this.db.prepare(SQL.insertEvent).run(id, String(taskId), seq, String(eventType), now, safePayload == null ? null : JSON.stringify(safePayload));
    return this.eventById(id);
  }
  eventById(id) { return this.db.prepare(SQL.eventById).get(String(id || "")) || null; }
  eventsOfTask(taskId) { return this.db.prepare(SQL.eventsOfTask).all(String(taskId || "")); }
  maxEventSequence(taskId) { return Number(this.db.prepare(SQL.maxEventSequence).get(String(taskId || "")).s); }

  // ------------------------------------------------------- Harness Run（D4-02C）
  insertHarnessRun({ runId = null, taskId, stepId = null, status = "STARTING", harnessVersion = null, acpVersion = null, modelConfigId = null, modelConfigVersion = null, startedAt = null, completedAt = null, stopReason = null, errorCode = null }) {
    const id = runId || newId("hrun");
    const now = this.clock();
    this.db.prepare(SQL.insertRun).run(id, String(taskId), stepId, String(status), harnessVersion, acpVersion, modelConfigId, modelConfigVersion == null ? null : Number(modelConfigVersion), Number(startedAt == null ? now : startedAt), completedAt, stopReason, errorCode);
    return this.harnessRunById(id);
  }
  harnessRunById(id) { return this.db.prepare(SQL.runById).get(String(id || "")) || null; }
  harnessRunsOfTask(taskId) { return this.db.prepare(SQL.runsOfTask).all(String(taskId || "")); }
  updateHarnessRun(id, patch) { this.#update("task_harness_runs", "run_id", id, RUN_COLUMNS, new Set(), patch); return this.harnessRunById(id); }

  // ------------------------------------------------------- Artifact（D4-02C）
  insertArtifact({ artifactId = null, taskId, stepId = null, runId = null, type = "text", safeContent = null, checksum = null, createdAt = null }) {
    const id = artifactId || newId("art");
    const now = this.clock();
    this.db.prepare(SQL.insertArtifact).run(id, String(taskId), stepId, runId, String(type), safeContent, checksum, Number(createdAt == null ? now : createdAt));
    return this.artifactById(id);
  }
  artifactById(id) { return this.db.prepare(SQL.artifactById).get(String(id || "")) || null; }
  artifactsOfTask(taskId) { return this.db.prepare(SQL.artifactsOfTask).all(String(taskId || "")); }

  // ------------------------------------------------------- Verification（D4-02C）
  insertVerification({ verificationId = null, artifactId, taskId, type, status = "PASS", safeDetails = null, createdAt = null }) {
    const id = verificationId || newId("ver");
    const now = this.clock();
    this.db.prepare(SQL.insertVerification).run(id, String(artifactId), String(taskId), String(type), String(status), safeDetails == null ? null : JSON.stringify(safeDetails), Number(createdAt == null ? now : createdAt));
    return this.verificationById(id);
  }
  verificationById(id) { return this.db.prepare(SQL.verificationById).get(String(id || "")) || null; }
  verificationsOfArtifact(artifactId) { return this.db.prepare(SQL.verificationsOfArtifact).all(String(artifactId || "")); }
  verificationsOfTask(taskId) { return this.db.prepare(SQL.verificationsOfTask).all(String(taskId || "")); }
}

module.exports = { TaskStore, SQL };
