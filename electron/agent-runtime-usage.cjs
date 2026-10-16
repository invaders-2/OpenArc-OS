"use strict";
/**
 * B3c · Agent 用量账本（agent_usage_events）。
 *
 * 逐字移植 server/agent-runtime/usageStore.ts:1-100。
 *   · normalizeAgentUsage              -> 多协议 usage 归一
 *   · beginAgentUsage / finishAgentUsage -> model 调用的一次性 start/finish 账
 *   · recordAgentToolUsage             -> browser/app 侧工具调用按 invocationId 幂等记账
 *   · listAgentUsage                   -> 按 runId 列表
 *
 * 依赖替换：源 import { ccsDb } -> 注入 db；源 import runStore -> 注入 taskStore
 * （getAgentRun / appendAgentRunEvent，B3a agent-task-store.cjs）。
 *
 * 云计费（server/apiQuota.ts）属 OUT：源 usageStore.ts 本身已经只写
 * cost=null / costSource='unavailable'，本文件照此保留，不引入任何计费调用。
 * 表 DDL 见 electron/dxos-foundation-schema.cjs:227（v22，含 token 明细列）。
 */
const { requireDependency, runStoreFunction } = require("./agent-runtime-deps.cjs");

function db() {
  return requireDependency("db");
}
function clock() {
  // 每次调用都重新取，允许测试期热替换 clock。
  return requireDependency("clock")();
}
function idFactory() {
  return requireDependency("idFactory")();
}
function getAgentRun(runId) {
  return runStoreFunction("getAgentRun")(runId);
}
function appendAgentRunEvent(runId, type, data) {
  return runStoreFunction("appendAgentRunEvent")(runId, type, data);
}

function token(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

/** 源 usageStore.ts:14-26。兼容 OpenAI / Anthropic / Gemini 三类字段名。 */
function normalizeAgentUsage(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const outer = raw;
  const value = (outer.usage || outer.usageMetadata || (outer.data && (outer.data.usage || outer.data.usageMetadata)) || outer);
  const inputTokens = token(value.prompt_tokens ?? value.input_tokens ?? value.promptTokenCount);
  const outputTokens = token(value.completion_tokens ?? value.output_tokens ?? value.candidatesTokenCount);
  const totalTokens = token(value.total_tokens ?? value.totalTokenCount) ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens || 0) + (outputTokens || 0) : undefined);
  const cachedInputTokens = token(value.prompt_tokens_details?.cached_tokens ?? value.input_tokens_details?.cached_tokens ?? value.cache_read_input_tokens ?? value.cachedContentTokenCount);
  const cacheCreationInputTokens = token(value.cache_creation_input_tokens);
  const reasoningTokens = token(value.completion_tokens_details?.reasoning_tokens ?? value.output_tokens_details?.reasoning_tokens ?? value.thoughtsTokenCount);
  const normalized = { inputTokens, outputTokens, totalTokens, cachedInputTokens, cacheCreationInputTokens, reasoningTokens };
  return Object.values(normalized).some((item) => item !== undefined) ? normalized : undefined;
}

/** 源 usageStore.ts:28-37。 */
function beginAgentUsage(input) {
  const run = getAgentRun(input.runId);
  if (!run || (input.taskId && run.taskId !== input.taskId)) throw new Error("Usage 记录不属于当前 Agent Run");
  const id = idFactory();
  const ts = clock();
  db().prepare("INSERT INTO agent_usage_events(id,invocation_id,run_id,task_id,kind,provider_id,model,tool_name,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'started',?,?)")
    .run(id, id, input.runId, input.taskId || run.taskId || null, input.kind, input.providerId || null, input.model || null, input.toolName || null, ts, ts);
  return { id, startedAt: ts };
}

/** 源 usageStore.ts:39-60。幂等：状态已非 started 时返回 already_finished，不覆盖账目。 */
function finishAgentUsage(id, input) {
  const row = db().prepare("SELECT run_id AS runId,created_at AS startedAt FROM agent_usage_events WHERE id=?").get(id);
  if (!row) throw new Error("Usage 调用记录不存在");
  const usage = normalizeAgentUsage(input.usage);
  const ts = clock();
  const latency = Math.max(0, Math.floor(input.latencyMs ?? (ts - row.startedAt)));
  const message = input.error === undefined ? null : String((input.error && input.error.message) || input.error).slice(0, 1000);
  const changed = db().prepare("UPDATE agent_usage_events SET status=?,input_tokens=?,output_tokens=?,total_tokens=?,cached_input_tokens=?,cache_creation_input_tokens=?,reasoning_tokens=?,latency_ms=?,error_message=?,updated_at=?,completed_at=? WHERE id=? AND status='started'")
    .run(input.status, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.totalTokens ?? null, usage?.cachedInputTokens ?? null, usage?.cacheCreationInputTokens ?? null, usage?.reasoningTokens ?? null, latency, message, ts, ts, id);
  if (!changed.changes) return { id, status: "already_finished", usage: undefined, latencyMs: latency, cost: null, costSource: "unavailable" };
  appendAgentRunEvent(row.runId, "usage.recorded", {
    usageId: id, status: input.status, latencyMs: latency,
    inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, totalTokens: usage?.totalTokens,
    cost: null, costSource: "unavailable",
  });
  return { id, status: input.status, usage, latencyMs: latency, cost: null, costSource: "unavailable" };
}

/** 源 usageStore.ts:62-89。invocationId 前缀 runId，重复调用返回 already_recorded。 */
function recordAgentToolUsage(input) {
  const run = getAgentRun(input.runId);
  if (!run) throw new Error("Usage 记录不属于当前 Agent Run");
  const invocationId = input.runId + ":" + String(input.invocationId || "").trim();
  if (!input.invocationId || !input.toolName) throw new Error("客户端工具调用缺少 invocationId 或 toolName");
  const existing = db().prepare("SELECT id FROM agent_usage_events WHERE invocation_id=?").get(invocationId);
  if (existing) return { id: existing.id, status: "already_recorded" };
  const id = idFactory();
  const ts = clock();
  const latency = Math.max(0, Math.floor(Number(input.latencyMs) || 0));
  const message = input.error === undefined ? null : String((input.error && input.error.message) || input.error).slice(0, 1000);
  db().prepare("INSERT INTO agent_usage_events(id,invocation_id,run_id,task_id,kind,provider_id,model,tool_name,status,latency_ms,error_message,created_at,updated_at,completed_at) VALUES (?,?,?,?, 'tool',NULL,NULL,?,?,?,?,?,?,?)")
    .run(id, invocationId, input.runId, run.taskId || null, input.toolName, input.status, latency, message, Math.max(0, ts - latency), ts, ts);
  appendAgentRunEvent(input.runId, "usage.recorded", { usageId: id, status: input.status, latencyMs: latency, toolName: input.toolName, clientHosted: true });
  return { id, status: input.status };
}

/** 源 usageStore.ts:91-100。 */
function listAgentUsage(runIds) {
  if (!runIds.length) return [];
  return db().prepare("SELECT id,run_id AS runId,task_id AS taskId,kind,provider_id AS providerId,model,tool_name AS toolName,status,input_tokens AS inputTokens,output_tokens AS outputTokens,total_tokens AS totalTokens,cached_input_tokens AS cachedInputTokens,cache_creation_input_tokens AS cacheCreationInputTokens,reasoning_tokens AS reasoningTokens,latency_ms AS latencyMs,cost_micros AS costMicros,cost_unit AS costUnit,cost_estimated AS costEstimated,created_at AS createdAt,completed_at AS completedAt FROM agent_usage_events WHERE run_id IN (" + runIds.map(() => "?").join(",") + ") ORDER BY created_at,id")
    .all(...runIds);
}

module.exports = {
  normalizeAgentUsage,
  beginAgentUsage,
  finishAgentUsage,
  recordAgentToolUsage,
  listAgentUsage,
};
