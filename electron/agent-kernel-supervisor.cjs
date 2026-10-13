"use strict";
/**
 * B3b · Agent Supervisor（CJS 移植）。
 *
 * 来源：server/agent-kernel/supervisor.ts:1-378。
 * 逐字对应：
 *   · SUPERVISOR_LIMITS = { maxDepth: 3, maxChildrenPerRun: 8, maxParallelPerRoot: 3 }（源 :9）
 *   · validateSpecs 的 key 白名单 / reviewer 依赖上限 / expectedOutputSchema 校验 / 依赖只能前置（:65-81）
 *   · delegateAgentWork 的 profile 校验、capabilityGrantForProfile 交集、request_hash 去重、
 *     子任务创建、prepareAgentTurn 后按 grant+allowedRisks 收窄工具/能力、agent_delegations 落库（:83-169）
 *   · Reviewer Gate 有界闭环与 409/403 语义（:171-277）
 *   · supervisorTree / steer / stop / cancelChildren / notifyParentOfRunTerminal（:279-378）
 *
 * 说明：maxParallelPerRoot=3 与源一致地"只作为导出上限"；源本身不在 supervisor.ts 内做并行
 * 拒绝，真正的并行闸门在 taskStore.claimNextTask（源 taskStore.ts:765-767 的同根 < 3 子查询）。
 *
 * 依赖注入（源直接 import、本仓由 configureAgentKernel 注入；未注入抛 AGENT_DEPENDENCY_UNAVAILABLE）：
 *   · taskStore：createTask/getTask/getProject/appendTaskEvent/cancelTask/refreshTaskInstruction
 *                + setPermissionGrant(taskId, grant, updatedAt)  ← 替源 :155 的 UPDATE tasks
 *                + failQueuedTask(taskId, {...})                 ← 替源 :361 的 UPDATE tasks ... status='queued'
 *   · workspaceStore：ensureRunWorkspace/abandonRunWorkspace/recordReviewerDecision（源 :4）
 *   · schemaValidator：validateJsonSchemaDefinition（源 :5）
 *   · auth：不 import（B4 未落地），只接收 userId 字符串 / 普通对象。
 */
const { createHash, randomUUID } = require("node:crypto");
const {
  agentDependencyUnavailable,
  agentClock,
  getAgentKernelDependencies,
  requireDb,
  withImmediateTransaction,
} = require("./agent-kernel.cjs");
const { prepareAgentTurn } = require("./agent-kernel.cjs");
const { appendAgentRunEvent, cancelAgentRun, createAgentRun, getAgentRun } = require("./agent-kernel-store.cjs");

/** supervisor.ts:9 */
const SUPERVISOR_LIMITS = Object.freeze({ maxDepth: 3, maxChildrenPerRun: 8, maxParallelPerRoot: 3 });

function adapterGroup(name) {
  const value = getAgentKernelDependencies()[name];
  if (!value) throw agentDependencyUnavailable(name);
  return value;
}
function taskMethod(name) {
  const store = adapterGroup("taskStore");
  if (typeof store[name] !== "function") throw agentDependencyUnavailable(`taskStore.${name}`);
  return store[name].bind(store);
}
function workspaceMethod(name) {
  const store = adapterGroup("workspaceStore");
  if (typeof store[name] !== "function") throw agentDependencyUnavailable(`workspaceStore.${name}`);
  return store[name].bind(store);
}
function schemaValidatorMethod(name) {
  const validator = adapterGroup("schemaValidator");
  if (typeof validator[name] !== "function") throw agentDependencyUnavailable(`schemaValidator.${name}`);
  return validator[name].bind(validator);
}

/** supervisor.ts:27-29 */
function jsonArray(value) {
  try { return value ? JSON.parse(value) : []; } catch { return []; }
}

/** supervisor.ts:31-39 */
function profileView(row) {
  return {
    id: row.id, name: row.name, description: row.description,
    capabilityScopes: jsonArray(row.capability_scopes_json), modelProfile: row.model_profile,
    allowedRisks: jsonArray(row.allowed_risks_json),
    budget: { modelCalls: row.max_model_calls, toolCalls: row.max_tool_calls },
    systemPrompt: row.system_prompt, builtin: Boolean(row.builtin), enabled: Boolean(row.enabled),
  };
}

/** supervisor.ts:41-43 */
function listAgentProfiles() {
  return requireDb().prepare("SELECT * FROM agent_profiles WHERE enabled=1 ORDER BY builtin DESC,id").all().map(profileView);
}

/** supervisor.ts:45-48 */
function getAgentProfile(id) {
  const row = requireDb().prepare("SELECT * FROM agent_profiles WHERE id=? AND enabled=1").get(id);
  return row ? profileView(row) : undefined;
}

/** supervisor.ts:50-52 */
function matchesScope(capabilityId, scope) {
  return scope.endsWith("*") ? capabilityId.startsWith(scope.slice(0, -1)) : capabilityId === scope;
}

/** supervisor.ts:54-63 */
function capabilityGrantForProfile(parentCapabilityIds, profileId, requested) {
  const profile = getAgentProfile(profileId);
  if (!profile) throw new Error(`Agent Profile 不存在或未启用：${profileId}`);
  const profileAllowed = parentCapabilityIds.filter((id) => profile.capabilityScopes.some((scope) => matchesScope(id, scope)));
  if (!requested?.length) return profileAllowed;
  const grant = [...new Set(requested)];
  const denied = grant.filter((id) => !profileAllowed.includes(id));
  if (denied.length) throw new Error(`子 Agent 请求了未继承的能力：${denied.slice(0, 3).join(", ")}`);
  return grant;
}

/** supervisor.ts:65-81 */
function validateSpecs(specs, existingChildren, depth) {
  if (!specs.length) throw new Error("至少需要一个子 Agent 委派");
  if (existingChildren + specs.length > SUPERVISOR_LIMITS.maxChildrenPerRun) throw new Error(`每个 Run 最多委派 ${SUPERVISOR_LIMITS.maxChildrenPerRun} 个子 Agent`);
  if (depth >= SUPERVISOR_LIMITS.maxDepth) throw new Error(`Agent 委派深度不能超过 ${SUPERVISOR_LIMITS.maxDepth} 层`);
  const keys = new Set();
  for (const spec of specs) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(spec.key) || keys.has(spec.key)) throw new Error(`子任务 key 无效或重复：${spec.key}`);
    if (!spec.instruction?.trim()) throw new Error(`子任务 ${spec.key} 缺少 instruction`);
    if (spec.agentProfileId === "reviewer" && (spec.dependsOn || []).length > 1) throw new Error(`Reviewer ${spec.key} 最多只能依赖一个 Producer；多份产物请分别创建 Reviewer`);
    if (spec.expectedOutputSchema !== undefined) {
      const issues = schemaValidatorMethod("validateJsonSchemaDefinition")(spec.expectedOutputSchema);
      if (issues.length) throw new Error(`子任务 ${spec.key} 的 expectedOutputSchema 无效：${issues[0].path} ${issues[0].message}`);
    }
    for (const dependency of spec.dependsOn || []) if (!keys.has(dependency)) throw new Error(`子任务 ${spec.key} 只能依赖本批次中排在它之前的任务：${dependency}`);
    keys.add(spec.key);
  }
}

/** supervisor.ts:83-169 */
function delegateAgentWork(parentRunId, userId, rawSpecs, internal) {
  const db = requireDb();
  const parentRun = getAgentRun(parentRunId);
  if (!parentRun?.taskId || !parentRun.projectId) throw new Error("只有绑定项目任务的 Agent Run 才能委派子 Agent");
  if (parentRun.userId && parentRun.userId !== userId) throw new Error("不能代替其他用户委派 Agent");
  if (["completed", "failed", "cancelled"].includes(parentRun.status)) throw new Error("已结束的 Agent Run 不能继续委派");
  const parentTask = taskMethod("getTask")(parentRun.taskId);
  if (!parentTask) throw new Error("父任务不存在");
  if (rawSpecs.length > SUPERVISOR_LIMITS.maxChildrenPerRun) throw new Error(`每次最多委派 ${SUPERVISOR_LIMITS.maxChildrenPerRun} 个子 Agent`);
  const specs = rawSpecs.map((spec) => ({
    ...spec, key: String(spec.key || "").trim(), title: String(spec.title || "").trim().slice(0, 80),
    instruction: String(spec.instruction || "").trim(), agentProfileId: String(spec.agentProfileId || "").trim(),
    dependsOn: Array.isArray(spec.dependsOn) ? spec.dependsOn.map(String) : [],
    capabilityIds: Array.isArray(spec.capabilityIds) ? spec.capabilityIds.map(String) : undefined,
  }));
  for (const spec of specs) if (spec.agentProfileId === "reviewer" && spec.expectedOutputSchema === undefined) {
    spec.expectedOutputSchema = {
      type: "object", additionalProperties: false, required: ["approved", "feedback"],
      properties: { approved: { type: "boolean" }, feedback: { type: "string", minLength: 1, maxLength: 4000 } },
    };
  }
  const existingCount = Number(db.prepare("SELECT COUNT(*) AS value FROM agent_delegations WHERE parent_run_id=?").get(parentRunId).value);
  validateSpecs(specs, existingCount, parentRun.delegationDepth);
  for (const spec of specs) if (spec.expectedOutputSchema !== undefined) {
    const issues = schemaValidatorMethod("validateJsonSchemaDefinition")(spec.expectedOutputSchema);
    if (issues.length) throw Object.assign(new Error(`子任务 ${spec.key} 的 expectedOutputSchema 无效：${issues[0].message}`), { statusCode: 400 });
  }
  const profiles = new Map(specs.map((spec) => [spec.agentProfileId, getAgentProfile(spec.agentProfileId)]));
  for (const [id, profile] of profiles) if (!profile) throw new Error(`Agent Profile 不存在或未启用：${id}`);

  return withImmediateTransaction(db, () => {
    const createdByKey = new Map();
    const created = specs.map((spec, index) => {
      const profile = profiles.get(spec.agentProfileId);
      let grant = capabilityGrantForProfile(parentRun.capabilityIds, spec.agentProfileId, spec.capabilityIds);
      const requestHash = createHash("sha256").update(JSON.stringify({
        instruction: spec.instruction.replace(/\s+/g, " ").trim(), agentProfileId: spec.agentProfileId,
        dependsOn: spec.dependsOn || [], expectedOutputSchema: spec.expectedOutputSchema || null,
        capabilityIds: [...(spec.capabilityIds || [])].sort(),
      })).digest("hex");
      if (db.prepare("SELECT 1 FROM agent_delegations WHERE parent_run_id=? AND request_hash=?").get(parentRunId, requestHash)) {
        throw Object.assign(new Error(`检测到重复委派：${spec.key}`), { statusCode: 409 });
      }
      const dependsOn = (spec.dependsOn || []).map((key) => createdByKey.get(key).taskId);
      const childTask = taskMethod("createTask")({
        projectId: parentRun.projectId, createdBy: userId, threadId: parentTask.thread_id,
        title: spec.title || `${profile.name} · ${spec.key}`, instruction: spec.instruction,
        executionProfile: "thinking", parentTaskId: parentTask.id, rootTaskId: parentTask.root_task_id || parentTask.id,
        agentProfileId: profile.id, delegatedByRunId: parentRunId, dependsOn,
        expectedOutputSchema: spec.expectedOutputSchema, permissionGrant: grant,
        delegationDepth: parentRun.delegationDepth + 1, recordUserMessage: false,
        preferences: {
          providerId: parentTask.preferred_provider_id || undefined, llmModel: parentTask.preferred_llm_model || undefined,
          imageProviderId: parentTask.preferred_image_provider_id || undefined, imageModel: parentTask.preferred_image_model || undefined,
        },
      });
      const prepared = prepareAgentTurn({
        instruction: spec.instruction, entryPoint: parentRun.entryPoint, userId, projectId: parentRun.projectId,
        taskId: childTask.id, sessionId: parentRun.sessionId, appId: parentRun.appId,
        correlationId: parentRun.correlationId, causationId: parentRunId,
        parentRunId, rootRunId: parentRun.rootRunId || parentRun.id, agentProfileId: profile.id,
        delegatedByRunId: parentRunId, delegationDepth: parentRun.delegationDepth + 1,
        preferredProviderId: parentTask.preferred_provider_id || undefined, preferredModel: parentTask.preferred_llm_model || undefined,
      });
      prepared.route.toolDescriptors = prepared.route.toolDescriptors.filter((item) => {
        const capabilityId = item.capabilityId || `${item.source}:${item.sourceId}:${item.name}`;
        return grant.includes(capabilityId) && profile.allowedRisks.includes(item.risk);
      });
      const allowedCapabilityIds = new Set(prepared.route.toolDescriptors.map((item) => item.capabilityId || `${item.source}:${item.sourceId}:${item.name}`));
      grant = grant.filter((id) => allowedCapabilityIds.has(id));
      prepared.capabilities = prepared.capabilities.filter((item) => allowedCapabilityIds.has(item.id));
      const allowedTools = new Set(prepared.route.toolDescriptors.map((item) => item.name));
      prepared.route.tools = prepared.route.tools.filter((item) => allowedTools.has(item.function.name));
      taskMethod("setPermissionGrant")(childTask.id, grant, agentClock());
      prepared.systemPromptAdditions.push(`当前角色：${profile.name}。${profile.systemPrompt}`);
      createAgentRun(prepared, spec.instruction);
      const project = taskMethod("getProject")(parentRun.projectId);
      if (project) workspaceMethod("ensureRunWorkspace")(prepared.trace.runId, project.id, project.root_node_id, userId, internal?.workspaceSeedRunIds?.[spec.key]);
      const delegationId = randomUUID(); const ts = agentClock();
      db.prepare(`INSERT INTO agent_delegations(id,parent_run_id,child_run_id,parent_task_id,child_task_id,agent_profile_id,ordinal,depends_on_json,expected_output_schema,permission_grant_json,status,created_at,updated_at,request_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(delegationId, parentRunId, prepared.trace.runId, parentTask.id, childTask.id, profile.id, existingCount + index + 1, JSON.stringify(dependsOn), spec.expectedOutputSchema === undefined ? null : JSON.stringify(spec.expectedOutputSchema), JSON.stringify(grant), "created", ts, ts, requestHash);
      createdByKey.set(spec.key, { taskId: childTask.id, runId: prepared.trace.runId });
      appendAgentRunEvent(parentRunId, "child.created", { delegationId, key: spec.key, childTaskId: childTask.id, childRunId: prepared.trace.runId, agentProfileId: profile.id, dependsOn });
      return { key: spec.key, delegationId, childTask, childRun: getAgentRun(prepared.trace.runId) };
    });
    return { parentRunId, limits: SUPERVISOR_LIMITS, children: created };
  });
}

/**
 * supervisor.ts:178-182 的注释保留：
 * Reviewer Gate 的有界闭环：首次拒绝新建一次纠正 Run 与二次 Reviewer。
 * 终态 Run 从不复活，所有预算继续累计在同一 root_task_id 下。
 */
function scheduleReviewerCorrectionImpl(reviewerRunId, userId) {
  const db = requireDb();
  const reviewer = getAgentRun(reviewerRunId);
  if (!reviewer?.taskId || reviewer.agentProfileId !== "reviewer" || reviewer.userId !== userId) {
    throw Object.assign(new Error("无效的 Reviewer Run"), { statusCode: 403 });
  }
  const review = db.prepare(`SELECT producer_run_id AS producerRunId,decision,feedback
    FROM agent_artifact_reviews WHERE reviewer_run_id=? ORDER BY created_at DESC LIMIT 1`).get(reviewerRunId);
  if (!review) return { status: "not_rejected" };

  const correctionForReviewer = db.prepare(`SELECT id,parent_run_id AS parentRunId,producer_run_id AS producerRunId
    FROM agent_review_corrections WHERE correction_reviewer_run_id=?`).get(reviewerRunId);
  if (review.decision === "approved") {
    if (!correctionForReviewer) return { status: "not_rejected", producerRunId: review.producerRunId };
    const ts = agentClock();
    db.prepare("UPDATE agent_review_corrections SET status='completed',updated_at=? WHERE id=?").run(ts, correctionForReviewer.id);
    appendAgentRunEvent(correctionForReviewer.parentRunId, "correction.completed", { producerRunId: correctionForReviewer.producerRunId, reviewerRunId });
    return { status: "completed", producerRunId: review.producerRunId };
  }

  const producer = getAgentRun(review.producerRunId);
  if (!producer?.taskId || !producer.parentRunId) return { status: "skipped_parent", producerRunId: review.producerRunId };
  // 拒绝的对象已经是 correction producer，说明这是第二次审查；不得继续生成第三轮。
  const originalCorrection = db.prepare("SELECT id,parent_run_id AS parentRunId FROM agent_review_corrections WHERE correction_producer_run_id=?").get(producer.id);
  if (originalCorrection) {
    db.prepare("UPDATE agent_review_corrections SET status='skipped_attempt',updated_at=? WHERE id=?").run(agentClock(), originalCorrection.id);
    appendAgentRunEvent(originalCorrection.parentRunId, "correction.skipped", { reason: "attempt_limit", producerRunId: producer.id, reviewerRunId });
    return { status: "skipped_attempt", producerRunId: producer.id };
  }
  const existing = db.prepare("SELECT status,correction_producer_run_id AS correctionProducerRunId,correction_reviewer_run_id AS correctionReviewerRunId FROM agent_review_corrections WHERE producer_run_id=?").get(producer.id);
  if (existing) return {
    status: existing.status === "created" ? "created" : existing.status,
    producerRunId: producer.id,
    ...(existing.correctionProducerRunId ? { correctionProducerRunId: existing.correctionProducerRunId } : {}),
    ...(existing.correctionReviewerRunId ? { correctionReviewerRunId: existing.correctionReviewerRunId } : {}),
  };

  const parent = getAgentRun(producer.parentRunId);
  const ts = agentClock();
  const skip = (status, reason) => {
    db.prepare(`INSERT OR IGNORE INTO agent_review_corrections(id,parent_run_id,producer_run_id,reviewer_run_id,attempt,status,feedback,created_at,updated_at)
      VALUES (?,?,?,?,1,?,?,?,?)`).run(randomUUID(), producer.parentRunId, producer.id, reviewerRunId, status, review.feedback || "", ts, ts);
    appendAgentRunEvent(producer.parentRunId, "correction.skipped", { reason, producerRunId: producer.id, reviewerRunId });
    return { status, producerRunId: producer.id };
  };
  if (!parent || ["completed", "failed", "cancelled"].includes(parent.status)) return skip("skipped_parent", "parent_terminal");
  const childCount = Number(db.prepare("SELECT COUNT(*) AS value FROM agent_delegations WHERE parent_run_id=?").get(parent.id).value);
  if (childCount + 2 > SUPERVISOR_LIMITS.maxChildrenPerRun) return skip("skipped_limit", "child_limit");

  const producerTask = taskMethod("getTask")(producer.taskId);
  if (!producerTask) return skip("skipped_parent", "producer_task_missing");
  const grant = (() => { try { return JSON.parse(producerTask.permission_grant_json || "[]"); } catch { return []; } })();
  const schema = (() => { try { return producerTask.expected_output_schema ? JSON.parse(producerTask.expected_output_schema) : undefined; } catch { return undefined; } })();
  const nonce = producer.id.slice(0, 8);
  const producerKey = `correction-${nonce}`;
  const reviewerKey = `correction-review-${nonce}`;
  const feedback = String(review.feedback || "Reviewer 未通过本次产物，请重新检查并修正。").slice(0, 4000);
  const instruction = `${producerTask.instruction}\n\n[Reviewer 单次纠正]\n上一次产物未通过审核。请基于已复制到当前 Workspace 的原产物完成修正，重新登记所有要交付的 Artifact。\n审核反馈：${feedback}`;
  const created = delegateAgentWork(parent.id, userId, [
    {
      key: producerKey, title: `${producerTask.title} · 纠正`, instruction,
      agentProfileId: producer.agentProfileId || "maker", capabilityIds: grant,
      ...(schema === undefined ? {} : { expectedOutputSchema: schema }),
    },
    {
      key: reviewerKey, title: `${producerTask.title} · 二次审核`,
      instruction: `请独立复核纠正后的产物。重点确认以下问题已经解决：${feedback}`,
      agentProfileId: "reviewer", dependsOn: [producerKey],
    },
  ], { workspaceSeedRunIds: { [producerKey]: producer.id } });
  const correctionProducerRunId = created.children[0].childRun.id;
  const correctionReviewerRunId = created.children[1].childRun.id;
  db.prepare(`INSERT INTO agent_review_corrections(id,parent_run_id,producer_run_id,reviewer_run_id,correction_producer_run_id,correction_reviewer_run_id,attempt,status,feedback,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,'created',?,?,?)`).run(randomUUID(), parent.id, producer.id, reviewerRunId, correctionProducerRunId, correctionReviewerRunId, feedback, ts, ts);
  appendAgentRunEvent(parent.id, "review.rejected", { producerRunId: producer.id, reviewerRunId, feedback });
  appendAgentRunEvent(parent.id, "correction.created", { producerRunId: producer.id, correctionProducerRunId, correctionReviewerRunId, attempt: 1 });
  return { status: "created", producerRunId: producer.id, correctionProducerRunId, correctionReviewerRunId };
}

/** supervisor.ts:264-266 */
function scheduleReviewerCorrection(reviewerRunId, userId) {
  return withImmediateTransaction(requireDb(), () => scheduleReviewerCorrectionImpl(reviewerRunId, userId));
}

/** supervisor.ts:268-277：将不可变 Reviewer verdict 与首次纠正链创建放在同一 SQLite 事务中。 */
function recordAndScheduleReviewerDecision(reviewerRunId, output, userId) {
  return withImmediateTransaction(requireDb(), () => {
    const decision = workspaceMethod("recordReviewerDecision")(reviewerRunId, output, userId);
    const correction = decision.decision === "rejected"
      ? scheduleReviewerCorrectionImpl(reviewerRunId, userId)
      : { status: "not_rejected" };
    return { decision, correction };
  });
}

/** supervisor.ts:279-286（原 JOIN tasks 改为经 taskStore.getTask 补齐 task_* 字段） */
function supervisorTree(parentRunId) {
  const db = requireDb();
  const parent = getAgentRun(parentRunId);
  if (!parent) throw new Error("Agent Run 不存在");
  const rows = db.prepare(`SELECT d.*,r.status AS run_status
    FROM agent_delegations d JOIN agent_runs r ON r.id=d.child_run_id
    WHERE d.parent_run_id=? ORDER BY d.ordinal`).all(parentRunId);
  const getTask = taskMethod("getTask");
  const children = rows.map((row) => {
    const task = getTask(row.child_task_id);
    return {
      ...row,
      task_status: task ? task.status : null,
      task_result: task ? task.result : null,
      task_error: task ? task.error_message : null,
    };
  });
  return { parent, limits: SUPERVISOR_LIMITS, children };
}

/** supervisor.ts:288-297 */
function requireDelegatedChild(parentRunId, childRunId, userId) {
  const db = requireDb();
  const parent = getAgentRun(parentRunId);
  if (!parent || (parent.userId && parent.userId !== userId)) throw Object.assign(new Error("没有父 Agent Run 的控制权限"), { statusCode: 403 });
  const delegation = db.prepare("SELECT child_task_id AS childTaskId FROM agent_delegations WHERE parent_run_id=? AND child_run_id=?").get(parentRunId, childRunId);
  if (!delegation) throw Object.assign(new Error("子 Agent 不属于该父 Run"), { statusCode: 404 });
  const child = getAgentRun(childRunId);
  const task = taskMethod("getTask")(delegation.childTaskId);
  if (!child || !task) throw Object.assign(new Error("子 Agent 不存在"), { statusCode: 404 });
  return { parent, child, task };
}

/** supervisor.ts:299-308 */
function steerDelegatedChild(parentRunId, childRunId, userId, instruction) {
  const scoped = requireDelegatedChild(parentRunId, childRunId, userId);
  if (["completed", "failed", "cancelled"].includes(scoped.child.status)) throw Object.assign(new Error("已结束的子 Agent 不能纠偏"), { statusCode: 409 });
  const value = String(instruction || "").trim().slice(0, 4000);
  if (!value) throw Object.assign(new Error("纠偏指令不能为空"), { statusCode: 400 });
  taskMethod("refreshTaskInstruction")(scoped.task.id, userId, `${scoped.task.instruction}\n\n[Supervisor 纠偏]\n${value}`);
  taskMethod("appendTaskEvent")(scoped.task.id, "agent.steer", value);
  appendAgentRunEvent(parentRunId, "child.steered", { childRunId, instruction: value });
  return { childRunId, task: taskMethod("getTask")(scoped.task.id) };
}

/** supervisor.ts:310-320 */
function stopDelegatedChild(parentRunId, childRunId, userId) {
  const scoped = requireDelegatedChild(parentRunId, childRunId, userId);
  if (!["completed", "failed", "cancelled"].includes(scoped.child.status)) {
    try { taskMethod("cancelTask")(scoped.task.id); } catch { /* terminal race */ }
    workspaceMethod("abandonRunWorkspace")(childRunId);
    cancelAgentRun(childRunId);
    appendAgentRunEvent(parentRunId, "child.cancelled", { childRunId });
    notifyParentOfRunTerminal(childRunId);
  }
  return { childRunId, run: getAgentRun(childRunId), task: taskMethod("getTask")(scoped.task.id) };
}

/** supervisor.ts:322-341 */
function cancelDelegatedChildren(parentRunId) {
  const db = requireDb();
  const queue = [parentRunId];
  let cancelled = 0;
  while (queue.length) {
    const current = queue.shift();
    const children = db.prepare("SELECT child_run_id,child_task_id FROM agent_delegations WHERE parent_run_id=?").all(current);
    for (const child of children) {
      queue.push(child.child_run_id);
      const task = taskMethod("getTask")(child.child_task_id);
      if (task && !["completed", "cancelled"].includes(task.status)) {
        try { taskMethod("cancelTask")(task.id); } catch { /* terminal race */ }
      }
      const before = getAgentRun(child.child_run_id);
      cancelAgentRun(child.child_run_id);
      if (before && !["completed", "failed", "cancelled"].includes(before.status)) cancelled++;
      notifyParentOfRunTerminal(child.child_run_id);
    }
  }
  return cancelled;
}

/** supervisor.ts:343-378 */
function notifyParentOfRunTerminal(childRunId) {
  const db = requireDb();
  return withImmediateTransaction(db, () => {
    const delegation = db.prepare("SELECT * FROM agent_delegations WHERE child_run_id=?").get(childRunId);
    const child = getAgentRun(childRunId);
    if (!delegation || !child || !["completed", "failed", "cancelled"].includes(child.status) || delegation.status === child.status) return;
    const ts = agentClock();
    db.prepare("UPDATE agent_delegations SET status=?,updated_at=? WHERE id=?").run(child.status, ts, delegation.id);
    appendAgentRunEvent(delegation.parent_run_id, child.status === "completed" ? "child.completed" : "child.failed", {
      delegationId: delegation.id, childRunId, status: child.status, result: child.result, errorMessage: child.errorMessage,
    });
    if (child.status !== "completed") {
      const queue = [delegation.child_task_id];
      while (queue.length) {
        const failedDependencyTaskId = queue.shift();
        const dependents = db.prepare(`SELECT d.id,d.child_run_id,d.child_task_id FROM agent_delegations d, json_each(d.depends_on_json) dependency
          WHERE d.parent_run_id=? AND d.status='created' AND dependency.value=?`).all(delegation.parent_run_id, failedDependencyTaskId);
        for (const dependent of dependents) {
          const message = `依赖任务 ${failedDependencyTaskId} 未成功完成`;
          taskMethod("failQueuedTask")(dependent.child_task_id, { errorCode: "dependency_failed", errorMessage: message, completedAt: ts, updatedAt: ts });
          db.prepare("UPDATE agent_delegations SET status='failed',updated_at=? WHERE id=?").run(ts, dependent.id);
          const dependentRun = getAgentRun(dependent.child_run_id);
          if (dependentRun && !["completed", "failed", "cancelled"].includes(dependentRun.status)) {
            db.prepare("UPDATE agent_runs SET status='failed',error_message=?,completed_at=?,updated_at=? WHERE id=?")
              .run(message, ts, ts, dependent.child_run_id);
            appendAgentRunEvent(dependent.child_run_id, "failed", { message, code: "dependency_failed" });
          }
          appendAgentRunEvent(delegation.parent_run_id, "child.failed", { delegationId: dependent.id, childRunId: dependent.child_run_id, status: "failed", errorMessage: message });
          queue.push(dependent.child_task_id);
        }
      }
    }
    const remaining = Number(db.prepare("SELECT COUNT(*) AS value FROM agent_delegations WHERE parent_run_id=? AND status NOT IN ('completed','failed','cancelled')").get(delegation.parent_run_id).value);
    if (!remaining) appendAgentRunEvent(delegation.parent_run_id, "children.completed", { children: supervisorTree(delegation.parent_run_id).children.length });
  });
}

module.exports = {
  SUPERVISOR_LIMITS,
  listAgentProfiles,
  getAgentProfile,
  capabilityGrantForProfile,
  delegateAgentWork,
  scheduleReviewerCorrection,
  recordAndScheduleReviewerDecision,
  supervisorTree,
  steerDelegatedChild,
  stopDelegatedChild,
  cancelDelegatedChildren,
  notifyParentOfRunTerminal,
};

/**
 * @typedef {Object} DelegationSpec
 * @property {string} key
 * @property {string} [title]
 * @property {string} instruction
 * @property {string} agentProfileId
 * @property {string[]} [dependsOn]
 * @property {string[]} [capabilityIds]
 * @property {unknown} [expectedOutputSchema]
 *
 * @typedef {{ status: ('created'|'completed'|'not_rejected'|'skipped_attempt'|'skipped_limit'|'skipped_parent'), producerRunId?: string, correctionProducerRunId?: string, correctionReviewerRunId?: string }} ReviewCorrectionResult
 */
