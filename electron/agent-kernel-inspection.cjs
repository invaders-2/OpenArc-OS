"use strict";
/**
 * B3b · Agent Run 巡检快照（CJS 移植）。
 *
 * 来源：server/agent-kernel/runInspection.ts:1-306。
 * 逐字对应：run_tree 递归 CTE 子树、expectedScope 越界 403、normalized 节点字段与
 * queue/wall duration、recovery（task_attempts + agent_checkpoints 最新一条）、
 * surfaceArtifact 去重与 unknownBytes、nodeActivity.active/recent(4)、routing 的
 * capability.completed 解析与 intent:provider:model 去重、usage 七项 token 合计、
 * review 状态机与 corrections 对 rejected 结论的取代。
 *
 * 与源的唯一 SQL 差异：源巡检 SQL LEFT JOIN tasks t 取 t.model_calls/t.tool_calls，
 * 但这两项随后被 usage 事件计数无条件覆盖（源 :162-164）。tasks 表结构在 OpenArc
 * 与 DX 冲突（见 docs/dxos-port/Dx-P0-TABLE-CONFLICT.md），故移除该 JOIN，
 * modelCalls/toolCalls 一律由 usageStore 事件推导，结果与源一致。
 *
 * 依赖注入（必须由装配方注入；未注入即抛 AGENT_DEPENDENCY_UNAVAILABLE）：
 *   · usageStore.listAgentUsage   ← server/agent-runtime/usageStore.ts:93
 *   · workspaceStore.artifactReviewState ← server/agent-runtime/workspaceStore.ts:185
 */
const {
  agentDependencyUnavailable,
  agentClock,
  getAgentKernelDependencies,
  requireDb,
} = require("./agent-kernel.cjs");
const { getAgentRun, listAgentRunEvents } = require("./agent-kernel-store.cjs");

function usageMethod(name) {
  const store = getAgentKernelDependencies().usageStore;
  if (!store) throw agentDependencyUnavailable("usageStore");
  if (typeof store[name] !== "function") throw agentDependencyUnavailable(`usageStore.${name}`);
  return store[name].bind(store);
}
function workspaceMethod(name) {
  const store = getAgentKernelDependencies().workspaceStore;
  if (!store) throw agentDependencyUnavailable("workspaceStore");
  if (typeof store[name] !== "function") throw agentDependencyUnavailable(`workspaceStore.${name}`);
  return store[name].bind(store);
}

/** runInspection.ts:74-76 */
function elapsed(from, to) {
  return from === null ? null : Math.max(0, to - from);
}

/** runInspection.ts:78-80 */
function tableExists(name) {
  return Boolean(requireDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/**
 * runInspection.ts:82-305。
 * 稳定只读 DTO：在 Provider 暴露规范化计费 usage 之前，cost 固定为 unavailable。
 */
function inspectAgentRun(runId, observedAt = agentClock(), expectedScope) {
  const db = requireDb();
  const run = getAgentRun(runId);
  if (!run) throw Object.assign(new Error("Agent Run 不存在"), { statusCode: 404 });

  const rows = db.prepare(`WITH RECURSIVE run_tree(id) AS (
      SELECT ?
      UNION ALL
      SELECT child.id FROM agent_runs child JOIN run_tree parent ON child.parent_run_id=parent.id
    )
    SELECT r.id,r.parent_run_id,r.task_id,r.agent_profile_id,r.delegation_depth,r.status,r.goal,r.error_message,
      r.root_run_id,r.project_id,r.app_id,r.session_id,r.user_id,
      r.created_at,r.started_at,r.completed_at,
      COUNT(a.id) AS artifact_count,COALESCE(SUM(a.bytes),0) AS artifact_bytes
    FROM run_tree tree JOIN agent_runs r ON r.id=tree.id
    LEFT JOIN agent_artifacts a ON a.run_id=r.id
    GROUP BY r.id
    ORDER BY r.delegation_depth,r.created_at,r.id`).all(runId);

  if (expectedScope && rows.some((row) =>
    (row.root_run_id || row.id) !== expectedScope.rootRunId
    || row.project_id !== expectedScope.projectId
    || row.app_id !== expectedScope.appId
    || row.session_id !== expectedScope.sessionId
    || row.user_id !== expectedScope.userId
  )) throw Object.assign(new Error("Agent Run 子树超出当前 APP 会话范围"), { statusCode: 403 });

  const normalized = rows.map((row) => {
    const end = row.completed_at ?? observedAt;
    return {
      runId: row.id,
      parentRunId: row.parent_run_id,
      taskId: row.task_id,
      agentProfileId: row.agent_profile_id,
      depth: row.delegation_depth || 0,
      status: row.status,
      goal: row.goal || "",
      errorMessage: row.error_message,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      modelCalls: 0,
      toolCalls: 0,
      queueDurationMs: row.started_at === null ? null : elapsed(row.created_at, row.started_at),
      wallDurationMs: Math.max(0, end - row.created_at),
      artifactCount: Number(row.artifact_count || 0),
      artifactBytes: Number(row.artifact_bytes || 0),
    };
  });
  const recovery = {};
  for (const row of rows) {
    if (!row.task_id) continue;
    const attempt = db.prepare("SELECT attempt_no,status FROM task_attempts WHERE task_id=? ORDER BY attempt_no DESC LIMIT 1").get(row.task_id);
    const checkpoint = db.prepare("SELECT sequence,phase,state_json,created_at FROM agent_checkpoints WHERE task_id=? ORDER BY sequence DESC LIMIT 1").get(row.task_id);
    let state = {};
    try { state = checkpoint ? JSON.parse(checkpoint.state_json) : {}; } catch { /* malformed historical checkpoint */ }
    recovery[row.id] = {
      attemptNo: attempt?.attempt_no || 0,
      attemptStatus: attempt?.status || "none",
      checkpointSequence: checkpoint?.sequence ?? null,
      checkpointPhase: checkpoint?.phase ?? null,
      checkpointAt: checkpoint?.created_at ?? null,
      iteration: typeof state.iteration === "number" ? state.iteration : null,
      nextToolIndex: typeof state.nextToolIndex === "number" ? state.nextToolIndex : null,
    };
  }
  const root = rows[0];
  const end = root.completed_at ?? observedAt;
  const usageEvents = usageMethod("listAgentUsage")(rows.map((row) => row.id));
  const runEvents = new Map(rows.map((row) => [row.id, listAgentRunEvents(row.id)]));
  let unknownArtifactBytes = 0;
  for (const node of normalized) {
    const events = usageEvents.filter((event) => event.runId === node.runId);
    node.modelCalls = events.filter((event) => event.kind === "model").length;
    node.toolCalls = events.filter((event) => event.kind === "tool").length;
    const surfaceArtifacts = [...new Map((runEvents.get(node.runId) || []).flatMap((event) => {
      if (event.type !== "artifact.created" || !event.data || typeof event.data !== "object") return [];
      const data = event.data;
      if (data.surfaceArtifact !== true || !data.artifactId) return [];
      return [[String(data.artifactId), data]];
    })).values()];
    node.artifactCount += surfaceArtifacts.length;
    node.artifactBytes += surfaceArtifacts.reduce((sum, artifact) => sum + (typeof artifact.bytes === "number" ? artifact.bytes : 0), 0);
    unknownArtifactBytes += surfaceArtifacts.filter((artifact) => typeof artifact.bytes !== "number").length;
  }
  const nodeActivity = {};
  const routing = {};
  for (const row of rows) {
    const events = usageEvents.filter((event) => event.runId === row.id);
    const item = (event) => ({
      id: String(event.id), kind: event.kind === "tool" ? "tool" : "model",
      providerId: event.providerId ? String(event.providerId) : null, model: event.model ? String(event.model) : null,
      toolName: event.toolName ? String(event.toolName) : null, startedAt: Number(event.createdAt || 0),
    });
    nodeActivity[row.id] = {
      recorded: { modelCalls: events.filter((event) => event.kind === "model").length, toolCalls: events.filter((event) => event.kind === "tool").length },
      active: row.status === "running" ? events.filter((event) => event.status === "started").map(item) : [],
      recent: [...events].reverse().slice(0, 4).map((event) => ({
        ...item(event), status: String(event.status), completedAt: event.completedAt ? Number(event.completedAt) : null,
        latencyMs: typeof event.latencyMs === "number" ? event.latencyMs : null,
      })),
    };
    const routeEvents = (runEvents.get(row.id) || []).filter((event) => event.type === "capability.completed");
    const routePayloads = routeEvents.map((event) => event.data && typeof event.data === "object" ? event.data : {});
    const activatedIntents = [...new Set(routePayloads.flatMap((payload) => [
      ...(Array.isArray(payload.intents) ? payload.intents.map(String) : []),
      ...(Array.isArray(payload.activated) ? payload.activated.map(String) : []),
    ]).filter((intent) => intent !== "capability_discover"))];
    const selectedTargets = routePayloads.flatMap((payload) => Array.isArray(payload.targets) ? payload.targets : []).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const target = value;
      if (!target.intent || !target.providerId || !target.model) return [];
      return [{
        intent: String(target.intent), providerId: String(target.providerId), providerName: String(target.providerName || target.providerId),
        model: String(target.model), mode: String(target.mode || "unknown"), ...(target.operationId ? { operationId: String(target.operationId) } : {}),
      }];
    });
    routing[row.id] = {
      activatedIntents,
      selectedTargets: [...new Map(selectedTargets.map((target) => [`${target.intent}:${target.providerId}:${target.model}`, target])).values()],
      modelAttempts: events.filter((event) => event.kind === "model").map((event) => ({
        providerId: event.providerId ? String(event.providerId) : null,
        model: event.model ? String(event.model) : null,
        status: String(event.status),
      })),
    };
  }
  const tokenTotal = (key) => {
    const values = usageEvents.map((item) => item[key]).filter((item) => typeof item === "number");
    return values.length ? values.reduce((sum, item) => sum + item, 0) : null;
  };

  const reviewItems = [];
  for (const row of rows) {
    const state = workspaceMethod("artifactReviewState")(row.id);
    if (!state.required || !state.reviewerRunId) continue;
    const stored = db.prepare(`SELECT producer_run_id,reviewer_run_id,decision,feedback,created_at
      FROM agent_artifact_reviews WHERE producer_run_id=? AND reviewer_run_id=?`).get(row.id, state.reviewerRunId);
    reviewItems.push({
      producerRunId: row.id,
      reviewerRunId: state.reviewerRunId,
      state: state.status,
      decision: state.decision ?? null,
      feedback: state.feedback ?? stored?.feedback ?? null,
      reviewedAt: state.reviewedAt ?? stored?.created_at ?? null,
    });
  }
  const summarizeReview = (items) => {
    if (!items.length) return "not_required";
    const states = new Set(items.map((item) => item.state));
    return states.size === 1 ? items[0].state : "mixed";
  };
  let reviewState = summarizeReview(reviewItems);

  let corrections = [];
  if (tableExists("agent_review_corrections")) {
    const correctionRows = db.prepare(`SELECT id,parent_run_id,producer_run_id,reviewer_run_id,
      correction_producer_run_id,correction_reviewer_run_id,attempt,status,feedback,created_at,updated_at
      FROM agent_review_corrections
      WHERE parent_run_id=? OR producer_run_id IN (${rows.map(() => "?").join(",")})
      ORDER BY created_at,attempt,id`).all(runId, ...rows.map((row) => row.id));
    corrections = correctionRows.map((row) => ({
      id: String(row.id), parentRunId: String(row.parent_run_id), producerRunId: String(row.producer_run_id),
      reviewerRunId: String(row.reviewer_run_id), correctionProducerRunId: row.correction_producer_run_id ? String(row.correction_producer_run_id) : null,
      correctionReviewerRunId: row.correction_reviewer_run_id ? String(row.correction_reviewer_run_id) : null,
      attempt: Number(row.attempt || 0), status: String(row.status), feedback: row.feedback ? String(row.feedback) : null,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }));
    if (corrections.some((item) => item.status === "created")) reviewState = "pending";
    else if (corrections.some((item) => item.status.startsWith("skipped_"))) reviewState = "rejected";
    else if (corrections.length) {
      // 已完成的 correction 取代旧 Producer 的拒绝作为当前 Gate 结论；历史仍保留在 items。
      const superseded = new Set(corrections.map((item) => item.producerRunId));
      reviewState = summarizeReview(reviewItems.filter((item) => !superseded.has(item.producerRunId)));
    }
  }

  return {
    run,
    children: normalized.slice(1),
    usage: {
      modelCalls: usageEvents.filter((item) => item.kind === "model").length,
      toolCalls: usageEvents.filter((item) => item.kind === "tool").length,
      recordedInvocations: usageEvents.length,
      failedInvocations: usageEvents.filter((item) => item.status === "failed" || item.status === "cancelled").length,
      inputTokens: tokenTotal("inputTokens"),
      outputTokens: tokenTotal("outputTokens"),
      totalTokens: tokenTotal("totalTokens"),
      cachedInputTokens: tokenTotal("cachedInputTokens"),
      cacheCreationInputTokens: tokenTotal("cacheCreationInputTokens"),
      reasoningTokens: tokenTotal("reasoningTokens"),
      callLatencyMs: usageEvents.reduce((sum, item) => sum + (typeof item.latencyMs === "number" ? item.latencyMs : 0), 0),
      cost: null,
      costSource: "unavailable",
    },
    timing: {
      queueDurationMs: root.started_at === null ? null : elapsed(root.created_at, root.started_at),
      wallDurationMs: Math.max(0, end - root.created_at),
      executionDurationMs: elapsed(root.started_at, end),
    },
    artifacts: {
      count: normalized.reduce((sum, item) => sum + item.artifactCount, 0),
      bytes: normalized.reduce((sum, item) => sum + item.artifactBytes, 0),
      unknownBytes: unknownArtifactBytes,
    },
    review: {
      required: reviewItems.length > 0,
      state: reviewState,
      feedback: reviewItems.flatMap((item) => item.feedback ? [item.feedback] : []),
      items: reviewItems,
    },
    corrections,
    recovery,
    nodeActivity,
    routing,
  };
}

module.exports = { inspectAgentRun };
