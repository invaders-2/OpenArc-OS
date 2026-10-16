"use strict";
/**
 * B3b · Agent Run 持久化（CJS 移植）。
 *
 * 来源：server/agent-kernel/runStore.ts:1-178。
 * 逐字对应：runView 的可选字段展开、redactSecrets 的 6 层/100 条/12000 字符上限、
 * appendAgentRunEvent 的 (run_id, sequence) 自增与秘密脱敏、transition 的
 * started_at/completed_at CASE 语义、以及四个终态函数"终态不复活"的短路。
 * ccsDb 换成注入的 node:sqlite DatabaseSync（表名 agent_runs / agent_run_events 不变）。
 */
const { randomUUID } = require("node:crypto");
const { requireDb, withImmediateTransaction, agentClock } = require("./agent-kernel.cjs");

/** runStore.ts:20-22 */
const parse = (value, fallback) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};

/** runStore.ts:24-38 */
const secretKey = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|passwd|secret|credential|cookie)/i;
function redactString(value) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
    .replace(/((?:api[-_]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi, "$1[REDACTED]");
}
function redactSecrets(value, depth = 0) {
  if (depth > 6) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value).slice(0, 12000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactSecrets(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .slice(0, 100).map(([key, item]) => [key, secretKey.test(key) ? "[REDACTED]" : redactSecrets(item, depth + 1)]));
  return value;
}

/** runStore.ts:40-63 */
function runView(row) {
  return {
    id: row.id, correlationId: row.correlation_id,
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
    ...(row.agent_profile_id ? { agentProfileId: row.agent_profile_id } : {}),
    ...(row.delegated_by_run_id ? { delegatedByRunId: row.delegated_by_run_id } : {}),
    delegationDepth: row.delegation_depth || 0,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.app_id ? { appId: row.app_id } : {}),
    ...(row.user_id ? { userId: row.user_id } : {}),
    entryPoint: row.entry_point, status: row.status, goal: row.goal,
    context: parse(row.context_json, []), capabilityCount: row.capability_count,
    capabilityIds: parse(row.capability_ids_json, []),
    ...(row.result_json ? { result: parse(row.result_json, null) } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

/** runStore.ts:65-68 */
function getAgentRun(id) {
  const row = requireDb().prepare("SELECT * FROM agent_runs WHERE id=?").get(id);
  return row ? runView(row) : undefined;
}

/** runStore.ts:70-73 */
function findAgentRunByTask(taskId) {
  const row = requireDb().prepare("SELECT * FROM agent_runs WHERE task_id=?").get(taskId);
  return row ? runView(row) : undefined;
}

/** runStore.ts:75-81 */
function listAgentRuns(userId, projectId, limit = 50) {
  const db = requireDb();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  const rows = projectId
    ? db.prepare("SELECT * FROM agent_runs WHERE user_id=? AND project_id=? ORDER BY created_at DESC LIMIT ?").all(userId, projectId, safeLimit)
    : db.prepare("SELECT * FROM agent_runs WHERE user_id=? ORDER BY created_at DESC LIMIT ?").all(userId, safeLimit);
  return rows.map(runView);
}

/** runStore.ts:83-101 */
function appendAgentRunEvent(runId, type, data) {
  const db = requireDb();
  return withImmediateTransaction(db, () => {
    const run = db.prepare("SELECT * FROM agent_runs WHERE id=?").get(runId);
    if (!run) throw new Error("Agent Run 不存在");
    const sequence = Number(db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS value FROM agent_run_events WHERE run_id=?").get(runId).value);
    const safeData = data === undefined ? undefined : redactSecrets(data);
    const event = {
      id: randomUUID(), type, runId, correlationId: run.correlation_id,
      ...(run.causation_id ? { causationId: run.causation_id } : {}),
      ...(run.task_id ? { taskId: run.task_id } : {}),
      ...(run.project_id ? { projectId: run.project_id } : {}),
      ...(run.app_id ? { appId: run.app_id } : {}),
      sequence, timestamp: agentClock(), ...(safeData === undefined ? {} : { data: safeData }),
    };
    db.prepare(`INSERT INTO agent_run_events(id,run_id,sequence,type,correlation_id,causation_id,data_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(event.id, runId, sequence, type, run.correlation_id, run.causation_id, safeData === undefined ? null : JSON.stringify(safeData), event.timestamp);
    return event;
  });
}

/** runStore.ts:103-113 */
function listAgentRunEvents(runId, after = 0) {
  const db = requireDb();
  const rows = db.prepare("SELECT * FROM agent_run_events WHERE run_id=? AND sequence>? ORDER BY sequence").all(runId, Math.max(0, after));
  const run = getAgentRun(runId);
  return rows.map((row) => ({
    id: row.id, type: row.type, runId: row.run_id, correlationId: row.correlation_id,
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
    ...(run?.taskId ? { taskId: run.taskId } : {}), ...(run?.projectId ? { projectId: run.projectId } : {}),
    ...(run?.appId ? { appId: run.appId } : {}), sequence: row.sequence, timestamp: row.created_at,
    ...(row.data_json ? { data: parse(row.data_json, null) } : {}),
  }));
}

/** runStore.ts:115-132 */
function createAgentRun(prepared, goal) {
  const existing = getAgentRun(prepared.trace.runId);
  if (existing) return existing;
  const db = requireDb();
  const ts = prepared.trace.createdAt;
  const context = prepared.context.map(({ id, source, trust }) => ({ id, source, trust }));
  db.prepare(`INSERT INTO agent_runs(id,correlation_id,causation_id,session_id,task_id,project_id,app_id,user_id,entry_point,status,goal,context_json,capability_count,created_at,updated_at,parent_run_id,root_run_id,agent_profile_id,delegated_by_run_id,capability_ids_json,delegation_depth)
    VALUES (?,?,?,?,?,?,?,?,?,'created',?,?,?,?,?,?,?,?,?,?,?)`).run(
    prepared.trace.runId, prepared.trace.correlationId, prepared.trace.causationId || null,
    prepared.trace.sessionId || null, prepared.trace.taskId || null, prepared.trace.projectId || null,
    prepared.trace.appId || null, prepared.trace.userId || null, prepared.trace.entryPoint, redactString(goal).slice(0, 12000),
    JSON.stringify(context), prepared.capabilities.length, ts, ts,
    prepared.trace.parentRunId || null, prepared.trace.rootRunId || prepared.trace.runId,
    prepared.trace.agentProfileId || null, prepared.trace.delegatedByRunId || null,
    JSON.stringify(prepared.capabilities.map((item) => item.id)), prepared.trace.delegationDepth || 0,
  );
  appendAgentRunEvent(prepared.trace.runId, "created", { capabilityCount: prepared.capabilities.length, contextSections: context.map((item) => item.id) });
  return getAgentRun(prepared.trace.runId);
}

/** runStore.ts:134-143 */
function transition(runId, status, fields = {}) {
  const db = requireDb();
  const ts = agentClock();
  const safeResult = fields.result === undefined ? undefined : redactSecrets(fields.result);
  const safeError = fields.error ? redactString(fields.error).slice(0, 12000) : null;
  db.prepare(`UPDATE agent_runs SET status=?, result_json=?, error_message=?, updated_at=?,
    started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END,
    completed_at=CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE completed_at END
    WHERE id=?`).run(status, safeResult === undefined ? null : JSON.stringify(safeResult), safeError, ts, status, ts, status, ts, runId);
  return getAgentRun(runId);
}

/** runStore.ts:145-150 */
function startAgentRun(runId) {
  const current = getAgentRun(runId);
  if (!current || current.status === "running") return current;
  if (["completed", "failed", "cancelled"].includes(current.status)) return current;
  transition(runId, "running"); appendAgentRunEvent(runId, "running"); return getAgentRun(runId);
}

/** runStore.ts:152-154 */
function waitAgentRun(runId, question) {
  transition(runId, "waiting_user"); appendAgentRunEvent(runId, "waiting_user", question ? { question } : undefined); return getAgentRun(runId);
}

/** runStore.ts:156-160 */
function completeAgentRun(runId, result) {
  const current = getAgentRun(runId);
  if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return current;
  transition(runId, "completed", { result }); appendAgentRunEvent(runId, "completed", result); return getAgentRun(runId);
}

/** runStore.ts:162-167 */
function failAgentRun(runId, error) {
  const current = getAgentRun(runId);
  if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return current;
  const message = String(error?.message || error || "Agent Run 执行失败");
  transition(runId, "failed", { error: message }); appendAgentRunEvent(runId, "failed", { message }); return getAgentRun(runId);
}

/** runStore.ts:169-173 */
function cancelAgentRun(runId) {
  const current = getAgentRun(runId);
  if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return current;
  transition(runId, "cancelled"); appendAgentRunEvent(runId, "cancelled"); return getAgentRun(runId);
}

/** runStore.ts:175-178 */
function cancelAgentRunByTask(taskId) {
  const run = findAgentRunByTask(taskId);
  return run ? cancelAgentRun(run.id) : undefined;
}

module.exports = {
  getAgentRun,
  findAgentRunByTask,
  listAgentRuns,
  appendAgentRunEvent,
  listAgentRunEvents,
  createAgentRun,
  startAgentRun,
  waitAgentRun,
  completeAgentRun,
  failAgentRun,
  cancelAgentRun,
  cancelAgentRunByTask,
  redactSecrets,
  redactString,
};
