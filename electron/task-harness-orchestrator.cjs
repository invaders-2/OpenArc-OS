/**
 * D4-02C · Task ↔ Harness Orchestrator。
 *
 * 永久边界：**OpenArc = Task Authority，Harness = Ephemeral Reasoning Runtime**。
 * 本文件只做编排：Task → Step → Harness Run → ACP → Model Proxy → ACP updates
 * → safe TaskEvent → Artifact/Verification → Step/Task 终态。
 *
 * 它**没有**第二份 authority：不保存 task/step status、revision、queue、retry、
 * permission state；所有持久 mutation 一律调用 TaskService，绝不直写 SQLite。
 * Harness event 永远不能自己改 Task/Step status；终态只由这里显式决定。
 */
"use strict";
const crypto = require("node:crypto");
const domain = require("./task-domain.cjs");
const { ToolFacadeBridge } = require("./tool-facade-bridge.cjs");
const { buildBridgeManifest } = require("./tool-registry.cjs");

const {
  TASK_STATUS, STEP_STATUS, TASK_EVENT, ERROR, ORCHESTRATION_KIND,
  ARTIFACT_TYPE, VERIFICATION_TYPE, ACP_EVENT_MAP, sanitizeEventPayload,
  BUDGET_KIND, DEFAULT_MAX_CALLS, MAX_TOOL_ROUNDS,
} = domain;

const PROMPT_SCHEMA_VERSION = 1;
const DEFAULT_TURN_TIMEOUT_MS = 180000;
const DEFAULT_START_TIMEOUT_MS = 30000;
const DEFAULT_MAX_PERSISTED_EVENTS = 64;
// D4-03D：一个 Harness run 内的 bounded 模型调用预算。混合 READ + WRITE turn 需要
// tool calls + 1 次 final + 1 次 verified-continuation，4 会误伤合法流程；仍然 bounded，
// 且绝不引入 hidden retry（0 retry 由 AUTO_RETRY/failModelCall 语义保证）。
// D4-06 Closure：bounded 预算常量统一由 task-domain 纯领域层冻结（DEFAULT_MAX_CALLS=8 /
// MAX_TOOL_ROUNDS=4）；本文件只消费，不再各自定义，避免漂移。

const ORCHESTRATOR_ERROR = Object.freeze({
  NO_ADAPTER: "ORCHESTRATOR_NO_ADAPTER",
  NOT_RUNNING: "ORCHESTRATOR_NOT_RUNNING",
});

function sha256(text) { return crypto.createHash("sha256").update(String(text)).digest("hex"); }

/** §16/§17 安全 prompt：只放 goal + safe step input + 可选 prior artifact；绝不塞 DB dump / credentials / 全历史。*/
function buildPrompt({ goal, stepInput = null, priorArtifactText = null, toolsEnabled = false } = {}) {
  const lines = [];
  lines.push(toolsEnabled
    ? "You are an OpenArc reasoning runtime. Only the OpenArc-controlled read-only tools exposed to you may be used; never assume shell, filesystem or network access."
    : "You are an OpenArc reasoning runtime. Tools are disabled; answer in text only.");
  lines.push("Task goal: " + String(goal == null ? "" : goal));
  if (stepInput != null) lines.push("Step input: " + (typeof stepInput === "string" ? stepInput : JSON.stringify(stepInput)).slice(0, 4000));
  if (priorArtifactText != null) lines.push("Prior artifact: " + String(priorArtifactText).slice(0, 2000));
  return lines.join("\n");
}

/**
 * §18 显式 ACP HarnessEvent → safe TaskEvent mapping。
 * §50 reasoning 不落库；§51 text delta 只聚合计数；§54 event flood 上限。
 */
function mapAcpEvents(events = [], { maxPersisted = DEFAULT_MAX_PERSISTED_EVENTS } = {}) {
  const out = [];
  let dropped = 0;
  let textChars = 0; let textChunks = 0;
  for (const e of events) {
    if (!e || !e.type) { dropped += 1; continue; }
    if (e.type === "text.delta") { textChunks += 1; textChars += typeof e.text === "string" ? e.text.length : 0; continue; }
    if (e.type === "reasoning.delta") { dropped += 1; continue; }
    if (e.type === "permission.requested" || e.type === "permission.rejected") {
      if (out.length < maxPersisted) out.push({ eventType: TASK_EVENT.HARNESS_PERMISSION_REQUESTED, safePayload: { acpType: "session/request_permission" } });
      if (out.length < maxPersisted) out.push({ eventType: TASK_EVENT.HARNESS_PERMISSION_REJECTED, safePayload: { acpType: "session/request_permission", outcome: "cancelled" } });
      continue;
    }
    const eventType = ACP_EVENT_MAP[e.type];
    if (!eventType) { dropped += 1; continue; }
    if (out.length >= maxPersisted) { dropped += 1; continue; }
    const payload = { acpType: e.raw || e.type };
    if (e.type === "usage") payload.usage = e.usage || null;
    if (e.type === "tool.proposed") payload.toolCallId = e.toolCallId || null;
    if (e.type === "plan" && Array.isArray(e.plan)) payload.itemCount = e.plan.length;
    out.push({ eventType, safePayload: payload });
  }
  if (textChunks > 0 && out.length < maxPersisted) out.push({ eventType: TASK_EVENT.HARNESS_TEXT_DELTA, safePayload: { chunks: textChunks, chars: textChars } });
  return { events: out, dropped, textChunks, textChars };
}

function summarizeUsage(events = []) {
  for (const e of events) if (e && e.type === "usage" && e.usage) return e.usage;
  return null;
}

function classifyHarnessError(e) {
  const code = String((e && e.code) || "");
  if (code === "HARNESS_PROCESS_EXITED") return ERROR.HARNESS_PROCESS_EXITED;
  if (code === "HARNESS_TURN_TIMEOUT") return ERROR.HARNESS_TURN_TIMEOUT;
  if (code === "HARNESS_CANCELLED") return ERROR.HARNESS_CANCELLED;
  if (code === "HARNESS_START_TIMEOUT") return ERROR.HARNESS_TURN_TIMEOUT;
  if (code === "HARNESS_PROTOCOL_ERROR" || code === "HARNESS_PROTOCOL_UNSUPPORTED") return code;
  if (code === "HARNESS_NOT_STARTED") return code;
  return ERROR.INTERNAL_ERROR;
}

class TaskHarnessOrchestrator {
  constructor({ taskService, adapterFactory = null, toolProxy = null, sideEffectRuntime = null, clock = null, logger = null, turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS, startTimeoutMs = DEFAULT_START_TIMEOUT_MS, maxPersistedHarnessEvents = DEFAULT_MAX_PERSISTED_EVENTS, toolFacade = null } = {}) {
    if (!taskService) throw new Error("TaskHarnessOrchestrator 需要 TaskService");
    this.taskService = taskService;
    this.adapterFactory = adapterFactory;
    // D4-03A：可选 Controlled Tool Proxy。无 proxy 时 tool proposal 仍 0 执行。
    this.toolProxy = toolProxy;
    // D4-03C4：唯一 side-effect 装配。仅用于 orchestrate「审批 → 受监督执行 → verified result」，
    // 绝不持有第二份 approval / lease / execution state。
    this.sideEffectRuntime = sideEffectRuntime;
    // D4-03B Closure：official dsh Tool Facade（显式 opt-in；synthetic ACP 路径保持 D4-03B loop）。
    this.toolFacade = toolFacade;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    this.turnTimeoutMs = turnTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.maxPersistedHarnessEvents = maxPersistedHarnessEvents;
    this.registry = new Map(); // runId -> { taskId, stepId, capabilityId, adapter }
    // runId -> Set<callId>：已经作为 verified result 交回过 Harness 的 side-effect call。
    this.resolvedSideEffectCalls = new Map();
    this.lastEvidence = null;
  }

  #service() { return this.taskService; }

  #makeAdapter({ context, taskId, stepId, runId, modelConfigId, modelConfigVersion = null }) {
    if (typeof this.adapterFactory !== "function") throw Object.assign(new Error(ORCHESTRATOR_ERROR.NO_ADAPTER), { code: ORCHESTRATOR_ERROR.NO_ADAPTER });
    return this.adapterFactory({ context, taskId, stepId, runId, modelConfigId, modelConfigVersion });
  }

  /** 全链路入口：createTask 之后调用；严格 PENDING→RUNNING→Step RUNNING→Harness。*/
  async runTask({ context, taskId, expectedRevision, stepInput = null, verify = null, turnTimeoutMs = this.turnTimeoutMs } = {}) {
    const svc = this.#service();
    const started = svc.startTask({ context, taskId, expectedRevision });
    if (!started.ok) return started;
    const created = svc.createStep({ context, taskId, kind: ORCHESTRATION_KIND, input: stepInput, expectedRevision: started.task.revision });
    if (!created.ok) return created;
    const stepStarted = svc.startStep({ context, taskId, stepId: created.step.stepId, expectedRevision: created.task.revision });
    if (!stepStarted.ok) return stepStarted;
    return this.runStep({ context, taskId, stepId: created.step.stepId, expectedRevision: stepStarted.task.revision, stepInput, verify, turnTimeoutMs });
  }

  async runStep({ context, taskId, stepId, expectedRevision, stepInput = null, verify = null, turnTimeoutMs = this.turnTimeoutMs } = {}) {
    const svc = this.#service();
    const loaded = svc.getTask({ context, taskId });
    if (!loaded.ok) return loaded;
    let task = loaded.task;
    if (task.cancel_requested) return { ok: false, error: ERROR.TASK_CANCELLED, task };
    const steps = svc.getSteps({ context, taskId });
    const step = steps.ok ? steps.items.find((s) => s.stepId === stepId) : null;
    if (!step) return { ok: false, error: ERROR.TASK_NOT_FOUND };

    const effectiveInput = stepInput == null ? step.input : stepInput;
    const toolsEnabled = !!(this.toolFacade && this.toolFacade.enabled && this.toolProxy && this.toolProxy.adapterFor);
    const executableProxy = !!(this.toolProxy && this.toolProxy.adapterFor);
    // D4-06 Closure：本 run 会绑定哪些预算种类（只有真正会用到的 kind 才参与 remaining 门控）。
    const readLoopUsed = !toolsEnabled && executableProxy;
    const sideEffectLoopUsed = toolsEnabled && !!this.sideEffectRuntime;
    const usedKinds = [BUDGET_KIND.MODEL_CALLS];
    if (toolsEnabled) usedKinds.push(BUDGET_KIND.TOOL_CALLS);
    if (readLoopUsed || sideEffectLoopUsed) usedKinds.push(BUDGET_KIND.TOOL_ROUNDS);
    const promptText = buildPrompt({ goal: task.goal, stepInput: effectiveInput, toolsEnabled });

    // D4-06 Closure：新 capability 额度 ≤ 任务剩余。任一 "会用到的" kind remaining==0 →
    // 不创建 run、不消耗，直接 BUDGET_EXHAUSTED（保持停止，用户需显式追加该 kind）。
    const budgetRes = svc.getTaskBudget({ context, taskId });
    if (!budgetRes.ok) return budgetRes;
    const remaining = budgetRes.remaining;
    const budgetPriority = [BUDGET_KIND.TOOL_CALLS, BUDGET_KIND.MODEL_CALLS, BUDGET_KIND.TOOL_ROUNDS];
    const blockingKind = budgetPriority.find((k) => usedKinds.includes(k) && remaining[k] <= 0) || null;
    if (blockingKind) {
      return await this.#haltForTaskBudget({ context, taskId, stepId, kind: blockingKind, budget: budgetRes, expectedRevision: task.revision });
    }
    const modelQuota = remaining[BUDGET_KIND.MODEL_CALLS];
    const toolQuota = toolsEnabled ? remaining[BUDGET_KIND.TOOL_CALLS] : null;
    const roundsQuota = Math.max(0, Math.min(MAX_TOOL_ROUNDS, remaining[BUDGET_KIND.TOOL_ROUNDS]));

    const runRes = svc.startHarnessRun({ context, taskId, stepId, expectedRevision: task.revision });
    if (!runRes.ok) return runRes;
    task = runRes.task;
    const run = runRes.run;

    let adapter = null;
    let info = null;
    let facade = null;
    let toolRoundsUsed = 0;
    try {
      facade = await this.#startToolFacade({ context, taskId, stepId, runId: run.runId, maxCalls: toolQuota });
      adapter = this.#makeAdapter({ context, taskId, stepId, runId: run.runId, modelConfigId: task.modelConfigId, modelConfigVersion: task.modelConfigVersion });
      info = await adapter.start({ context, modelConfigId: task.modelConfigId, maxCalls: modelQuota, startTimeoutMs: this.startTimeoutMs, requestId: "mreq_" + run.runId, toolFacade: facade });
    } catch (e) {
      if (adapter) { try { adapter.revokeToolCapability(); } catch { /* ignore */ } try { adapter.revokeModelCapability(); } catch { /* ignore */ } try { await adapter.dispose(); } catch { /* ignore */ } }
      if (facade) { try { await facade.bridge.stop(); } catch { /* ignore */ } }
      return this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: classifyHarnessError(e), event: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT, expectedRevision: task.revision });
    }
    this.registry.set(run.runId, { taskId, stepId, capabilityId: info.capabilityId, adapter, bridge: facade ? facade.bridge : null });

    try {
      // §59/§60：config 变化绝不启动 / 绝不 fallback。
      if (task.modelConfigVersion != null && info.modelConfigVersion !== task.modelConfigVersion) {
        return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: ERROR.MODEL_CONFIG_CHANGED, event: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT, expectedRevision: task.revision });
      }
      const running = svc.markHarnessRunRunning({ context, taskId, runId: run.runId, expectedRevision: task.revision });
      if (!running.ok) return running;
      task = running.task;

      // §55：OpenArc 生成 requestId，与 taskId/stepId/runId 绑定；不由 Harness 自报。
      const modelRequestId = "mreq_" + run.runId;
      const callRes = svc.startModelCall({ context, taskId, stepId, requestId: modelRequestId, expectedRevision: task.revision });
      if (!callRes.ok) return callRes;
      task = callRes.task;
      const callId = callRes.call.callId;

      let res;
      try {
        res = await adapter.prompt(promptText, { timeoutMs: turnTimeoutMs });
      } catch (e) {
        const failure = this.#promptFailure(adapter, e);
        const failedCall = svc.failModelCall({ context, taskId, callId, providerErrorCode: failure.code, requestId: modelRequestId, expectedRevision: task.revision });
        const failRev = failedCall.ok ? failedCall.task.revision : task.revision;
        if (failure.code === ERROR.HARNESS_CANCELLED) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: failRev });
        return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: failure.code, event: failure.event, payload: failure.payload, expectedRevision: failRev });
      }

      let rawEvents = Array.isArray(res.events) ? res.events : [];
      // D4 收口：首个 prompt 成功后工具预算真实耗尽 → 立即停止，绝不当成成功收敛。
      const toolBudgetFirst = this.#toolBudgetExhausted(adapter);
      if (toolBudgetFirst) {
        return await this.#haltForToolBudget({ context, taskId, stepId, runId: run.runId, callId, modelRequestId, rawEvents, budget: toolBudgetFirst, fallbackRevision: task.revision });
      }
      let mapped = mapAcpEvents(rawEvents, { maxPersisted: this.maxPersistedHarnessEvents });
      let usage = summarizeUsage(rawEvents);
      const hasToolEvents = () => rawEvents.some((e) => e && e.type === "tool.proposed");
      // D4-03B Closure：official dsh 已由 Tool Runtime 执行 plugin.execute() → Tool Facade Bridge；
      // OpenArc 在这里绝不重复执行，只记录 safe ACP events 并等 turn 完成。
      const facadeMode = info.toolExecutionMode === "facade";

      // §33/§34/§63/§65/§89：READ_ONLY Tool 执行循环。每个 proposal 都重新 propose→decide→reauthorize→execute→verify；
      // 结果经 bounded 后续 prompt 交回 Harness 继续推理。无 adapter（D4-03A gate / 无 proxy）维持 gate 语义。
      if (!facadeMode && executableProxy) {
        let round = 0;
        while (hasToolEvents() && round < roundsQuota) {
          round += 1;
          toolRoundsUsed = round;
          const handled = await this.#handleToolTurn({ context, taskId, stepId, runId: run.runId, rawEvents, mappedEvents: mapped.events, task, expectedRevision: task.revision });
          if (handled.terminal) return handled.terminal;
          task = handled.task;
          let next;
          try {
            next = await adapter.prompt(handled.followupPrompt, { timeoutMs: turnTimeoutMs });
          } catch (e) {
            const failure = this.#promptFailure(adapter, e);
            const failedCall = svc.failModelCall({ context, taskId, callId, providerErrorCode: failure.code, requestId: modelRequestId, expectedRevision: task.revision });
            const failRev = failedCall.ok ? failedCall.task.revision : task.revision;
            if (failure.code === ERROR.HARNESS_CANCELLED) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: failRev });
            return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: failure.code, event: failure.event, payload: failure.payload, expectedRevision: failRev });
          }
          res = next;
          rawEvents = Array.isArray(next.events) ? next.events : [];
          const toolBudgetLoop = this.#toolBudgetExhausted(adapter);
          if (toolBudgetLoop) return await this.#haltForToolBudget({ context, taskId, stepId, runId: run.runId, callId, modelRequestId, rawEvents, budget: toolBudgetLoop, fallbackRevision: this.#rev(context, taskId, task.revision) });
          mapped = mapAcpEvents(rawEvents, { maxPersisted: this.maxPersistedHarnessEvents });
          usage = summarizeUsage(rawEvents) || usage;
          const latestTask = svc.getTask({ context, taskId });
          if (latestTask.ok) task = latestTask.task;
          if (latestTask.ok && latestTask.task.cancelRequested) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: task.revision });
        }
        if (hasToolEvents()) return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: ERROR.BUDGET_EXHAUSTED, event: TASK_EVENT.TASK_BUDGET_EXHAUSTED, payload: { kind: BUDGET_KIND.TOOL_ROUNDS, consumed: round, maxRounds: roundsQuota, observed: { remaining: this.#remainingEvidence(context, taskId) } }, expectedRevision: task.revision });
      } else if (!facadeMode && hasToolEvents()) {
        // D4-03A gate：proposal 已 ALLOWED 但执行未开放 → 0 execution + BLOCKED / WAITING。
        await this.#recordEvents({ context, taskId, runId: run.runId, events: mapped.events, expectedRevision: task.revision, task });
        const fresh = svc.getTask({ context, taskId });
        const rev = fresh.ok ? fresh.task.revision : task.revision;
        if (!this.toolProxy) {
          return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: ERROR.TOOL_EXECUTION_NOT_AVAILABLE, event: TASK_EVENT.HARNESS_TOOL_PROPOSED, expectedRevision: rev, alreadyRecorded: true });
        }
        const toolEvent = rawEvents.find((e) => e && e.type === "tool.proposed") || {};
        const spec = this.#toolSpec(toolEvent);
        const decision = this.toolProxy.propose({ context, taskId, stepId, runId: run.runId, toolId: spec.toolId, toolVersion: spec.toolVersion, arguments: spec.arguments, proposalId: spec.proposalId });
        const decisionStatus = decision && decision.decisionStatus ? decision.decisionStatus : "BLOCKED";
        const reasonCode = decision && decision.reasonCode ? decision.reasonCode : ERROR.TOOL_FORBIDDEN;
        const toolEvents = [{ eventType: TASK_EVENT.TOOL_PROPOSED, safePayload: { toolId: spec.toolId, toolVersion: spec.toolVersion, proposalId: decision && decision.proposal ? decision.proposal.proposalId : null } },
          { eventType: decisionStatus === "APPROVAL_REQUIRED" ? TASK_EVENT.TOOL_APPROVAL_REQUIRED : decisionStatus === "ALLOWED" ? TASK_EVENT.TOOL_VALIDATED : decisionStatus === "DENIED" || decisionStatus === "INVALID" ? TASK_EVENT.TOOL_DENIED : TASK_EVENT.TOOL_EXECUTION_BLOCKED, safePayload: { proposalId: decision && decision.proposal ? decision.proposal.proposalId : null, decision: decisionStatus, reasonCode, riskClass: decision && decision.decision ? decision.decision.riskClass : null } }];
        await this.#recordEvents({ context, taskId, runId: run.runId, events: toolEvents, expectedRevision: rev });
        const fresh2 = svc.getTask({ context, taskId });
        const rev2 = fresh2.ok ? fresh2.task.revision : rev;
        if (decisionStatus === "APPROVAL_REQUIRED") return await this.#waitForApproval({ context, taskId, stepId, runId: run.runId, reason: reasonCode, expectedRevision: rev2 });
        const reason = decisionStatus === "ALLOWED" ? ERROR.TOOL_EXECUTION_NOT_AVAILABLE : reasonCode;
        return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason, event: TASK_EVENT.TOOL_EXECUTION_BLOCKED, expectedRevision: rev2, alreadyRecorded: true });
      }

      // D4-03C4 · official dsh WRITE proposal → trusted approval → 受监督执行 → verified result。
      // official dsh 只能提出 proposal；OpenArc 在这里等待 trusted user decision，
      // 绝不由 Harness / model text / timer 自动批准，也绝不把 unverified success 交回 Harness。
      if (facadeMode && this.sideEffectRuntime) {
        let sideRounds = 0;
        while (sideRounds < roundsQuota) {
          sideRounds += 1;
          const pending = this.#sideEffectCallsToOrchestrate(stepId, run.runId);
          if (!pending.length) break;
          toolRoundsUsed = sideRounds;
          await this.#recordEvents({ context, taskId, runId: run.runId, events: mapped.events, expectedRevision: task.revision });
          let rev = this.#rev(context, taskId, task.revision);
          const resolution = await this.sideEffectRuntime.resolvePendingForStep({ taskId, stepId, runId: run.runId, callIds: pending.map((c) => c.callId) });
          const freshTask = svc.getTask({ context, taskId });
          const needCancel = resolution.decision === "CANCELLED" || (freshTask.ok && freshTask.task.cancelRequested);
          if (!resolution.ok) {
            if (needCancel) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: freshTask.ok ? freshTask.task.revision : rev });
            // UNKNOWN_EFFECT / FAILED / DENIED / TIMEOUT：0 retry，Harness 必须 STOP。
            return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: resolution.error || ERROR.TOOL_EXECUTION_NOT_AVAILABLE, event: TASK_EVENT.TOOL_SIDE_EFFECT_EXECUTION_BLOCKED, expectedRevision: freshTask.ok ? freshTask.task.revision : rev, alreadyRecorded: true });
          }
          const consumed = this.resolvedSideEffectCalls.get(run.runId) || new Set();
          consumed.add(resolution.callId);
          this.resolvedSideEffectCalls.set(run.runId, consumed);
          // 只有 Verified Effect 才允许回给 Harness；绝不回 unverified success。
          const follow = "OpenArc verified side-effect result (do not re-issue the write):\n" + JSON.stringify(resolution.safeResult).slice(0, 2000) + "\nContinue the task.";
          let next;
          try {
            next = await adapter.prompt(follow, { timeoutMs: turnTimeoutMs });
          } catch (e) {
            const failure = this.#promptFailure(adapter, e);
            const failedCall = svc.failModelCall({ context, taskId, callId, providerErrorCode: failure.code, requestId: modelRequestId, expectedRevision: task.revision });
            const failRev = failedCall.ok ? failedCall.task.revision : task.revision;
            if (failure.code === ERROR.HARNESS_CANCELLED) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: failRev });
            return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: failure.code, event: failure.event, payload: failure.payload, expectedRevision: failRev });
          }
          res = next;
          rawEvents = Array.isArray(next.events) ? next.events : [];
          const toolBudgetSide = this.#toolBudgetExhausted(adapter);
          if (toolBudgetSide) return await this.#haltForToolBudget({ context, taskId, stepId, runId: run.runId, callId, modelRequestId, rawEvents, budget: toolBudgetSide, fallbackRevision: this.#rev(context, taskId, task.revision) });
          mapped = mapAcpEvents(rawEvents, { maxPersisted: this.maxPersistedHarnessEvents });
          usage = summarizeUsage(rawEvents) || usage;
          const latestTask = svc.getTask({ context, taskId });
          if (latestTask.ok) task = latestTask.task;
          if (latestTask.ok && latestTask.task.cancelRequested) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: task.revision });
        }
        const leftover = this.#sideEffectCallsToOrchestrate(stepId, run.runId);
        if (leftover.length) {
          // D4-06 Closure：轮次上界耗尽且有未解决 side-effect → 归因 TOOL_ROUNDS（不伪装成审批未决）。
          if (sideRounds >= roundsQuota) return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: ERROR.BUDGET_EXHAUSTED, event: TASK_EVENT.TASK_BUDGET_EXHAUSTED, payload: { kind: BUDGET_KIND.TOOL_ROUNDS, consumed: sideRounds, maxRounds: roundsQuota, observed: { remaining: this.#remainingEvidence(context, taskId) } }, expectedRevision: task.revision });
          return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: "SIDE_EFFECT_APPROVAL_UNRESOLVED", event: TASK_EVENT.TOOL_SIDE_EFFECT_EXECUTION_BLOCKED, expectedRevision: task.revision, alreadyRecorded: true });
        }
      }

      const hasPermission = rawEvents.some((e) => e && (e.type === "permission.requested" || e.type === "permission.rejected"));
      const callDone = svc.completeModelCall({ context, taskId, callId, usage: usage || null, requestId: modelRequestId, expectedRevision: task.revision });
      if (callDone.ok) task = callDone.task;
      const latest = svc.getTask({ context, taskId });
      const cancelled = (latest.ok && latest.task.cancelRequested) || res.stopReason === "cancelled";
      if (cancelled) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: task.revision });
      if (hasPermission) {
        await this.#recordEvents({ context, taskId, runId: run.runId, events: mapped.events, expectedRevision: task.revision, task });
        const fresh = svc.getTask({ context, taskId });
        return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: ERROR.PERMISSION_NOT_AVAILABLE, event: null, expectedRevision: (fresh.ok ? fresh.task.revision : task.revision), alreadyRecorded: true });
      }

      // §24/§32：只有 turn 完成 + artifact 持久 + verification PASS 才算成功。
      const text = typeof res.text === "string" ? res.text : "";
      const verification = this.#verify({ text, verify });
      await this.#recordEvents({ context, taskId, runId: run.runId, events: mapped.events, expectedRevision: task.revision, task });

      if (!verification.ok) {
        const fresh = svc.getTask({ context, taskId });
        await this.#recordEvents({ context, taskId, runId: run.runId, events: [{ eventType: TASK_EVENT.VERIFICATION_COMPLETED, safePayload: { type: verification.type, status: "FAIL", detail: verification.detail } }], expectedRevision: (fresh.ok ? fresh.task.revision : task.revision), task });
        const fresh2 = svc.getTask({ context, taskId });
        return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: ERROR.VERIFICATION_FAILED, event: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT, expectedRevision: (fresh2.ok ? fresh2.task.revision : task.revision), alreadyRecorded: true });
      }

      // D4-05 Closure · A33：facade 模式下 READ_ONLY 产物验证在 dsh 进程内由 Bridge 完成，
      // orchestrator 必须以后端记录为准，拒绝「验证失败未解决但 final text 通过」的假成功。
      if (typeof svc.getUnresolvedRequiredVerificationFailures === "function") {
        const unresolvedRes = svc.getUnresolvedRequiredVerificationFailures({ context, taskId });
        if (unresolvedRes && unresolvedRes.ok && Array.isArray(unresolvedRes.unresolved) && unresolvedRes.unresolved.length) {
          const first = unresolvedRes.unresolved[0];
          return await this.#blockStep({
            context, taskId, stepId, runId: run.runId,
            reason: ERROR.TOOL_VERIFICATION_FAILED,
            event: TASK_EVENT.TOOL_VERIFICATION_FAILED,
            payload: { toolId: first.toolId, executionId: first.executionId, errorCode: first.errorCode, method: first.method, unresolvedCount: unresolvedRes.unresolved.length },
            expectedRevision: this.#rev(context, taskId, task.revision),
            alreadyRecorded: true,
          });
        }
      }

      const fresh = svc.getTask({ context, taskId });
      const rev = fresh.ok ? fresh.task.revision : task.revision;
      let commit;
      try {
        commit = svc.commitStepSuccess({
          context, taskId, stepId, runId: run.runId,
          artifact: { type: ARTIFACT_TYPE.TEXT, content: text, checksum: sha256(text) },
          verification: { type: verification.type, status: "PASS", details: { expectedHash: verification.expectedHash, actualHash: sha256(text), promptSchemaVersion: PROMPT_SCHEMA_VERSION, inputHash: sha256(promptText) } },
          expectedRevision: rev,
        });
      } catch (e) {
        commit = { ok: false, error: ERROR.ARTIFACT_PERSIST_FAILED, detail: String((e && e.message) || e).slice(0, 120) };
      }
      if (!commit.ok) {
        if (commit.error === ERROR.TASK_CANCELLED) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: rev });
        return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: commit.error || ERROR.ARTIFACT_PERSIST_FAILED, event: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT, expectedRevision: rev, alreadyRecorded: true });
      }
      const done = svc.completeHarnessRun({ context, taskId, runId: run.runId, stopReason: String(res.stopReason || "end_turn"), expectedRevision: commit.task.revision });
      const finalTask = done.ok ? done.task : commit.task;
      this.lastEvidence = {
        taskId, stepId, runId: run.runId,
        modelConfigVersion: info.modelConfigVersion,
        harnessVersion: info.dshVersion || null,
        acpVersion: info.sdkVersion || null,
        protocolVersion: info.protocolVersion || null,
        artifactChecksum: commit.artifact ? commit.artifact.checksum : null,
        verificationStatus: commit.verification ? commit.verification.status : null,
        usage: usage || null,
        stopReason: res.stopReason || null,
        finalTaskRevision: finalTask.revision,
      };
      return { ok: true, task: finalTask, step: commit.step, artifact: commit.artifact, verification: commit.verification, run: done.ok ? done.run : null, stopReason: res.stopReason, usage: usage || null, events: mapped.events };
    } finally {
      // D4-06 Closure：run 结束（成功/失败/block/cancel 都恰好一次）时把真实消耗记入任务级账本。
      // 必须先读 capability 观测（revoke 后就拿不到），失败绝不影响 run 收敛。
      try {
        const consumption = this.#measureConsumption(adapter, toolRoundsUsed);
        if (consumption) svc.recordBudgetConsumption({ context, taskId, consumption });
      } catch { /* ignore */ }
      try { adapter.revokeToolCapability(); } catch { /* ignore */ }
      try { adapter.revokeModelCapability(); } catch { /* ignore */ }
      try { await adapter.dispose(); } catch { /* ignore */ }
      if (facade) { try { await facade.bridge.stop(); } catch { /* ignore */ } }
      this.registry.delete(run.runId);
      this.resolvedSideEffectCalls.delete(run.runId);
    }
  }

  /** 本 step/run 上尚未作为 verified result 交回 Harness 的 side-effect call（任何状态）。 */
  #sideEffectCallsToOrchestrate(stepId, runId) {
    if (!this.sideEffectRuntime || !stepId) return [];
    const done = this.resolvedSideEffectCalls.get(runId) || new Set();
    return this.sideEffectRuntime.sideEffectCallsOfStep({ stepId, runId }).filter((c) => !done.has(c.callId));
  }

  #verify({ text, verify }) {
    const type = verify && verify.type ? String(verify.type) : VERIFICATION_TYPE.SCHEMA_VALID;
    if (type === VERIFICATION_TYPE.EXACT_TEXT) {
      const expected = verify && verify.expected != null ? String(verify.expected) : "";
      if (text !== expected) return { ok: false, type, detail: { expectedHash: sha256(expected), actualHash: sha256(text) } };
      return { ok: true, type, expectedHash: sha256(expected) };
    }
    if (!text || !text.trim()) return { ok: false, type: VERIFICATION_TYPE.SCHEMA_VALID, detail: { reason: "EMPTY_RESULT" } };
    return { ok: true, type: VERIFICATION_TYPE.SCHEMA_VALID };
  }

  #rev(context, taskId, fallback) { const t = this.#service().getTask({ context, taskId }); return t.ok ? t.task.revision : fallback; }

  /**
   * D4-06 Closure：只有 Harness 自报的失败 + 真实 capability 预算状态才能得出 BUDGET_EXHAUSTED。
   * cancel 优先；其余只有 Model Proxy / Tool Facade capability 真实进入 EXHAUSTED 才算预算停止。
   */
  #promptFailure(adapter, e) {
    const code = classifyHarnessError(e);
    if (code === ERROR.HARNESS_CANCELLED) return { code, event: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT, payload: null };
    const budget = adapter && typeof adapter.budgetExhausted === "function" ? adapter.budgetExhausted() : null;
    if (budget && budget.exhausted) {
      return { code: ERROR.BUDGET_EXHAUSTED, event: TASK_EVENT.TASK_BUDGET_EXHAUSTED, payload: this.#budgetPayload(budget.kind, budget) };
    }
    return { code, event: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT, payload: null };
  }

  /** safe 停因 payload：保留实际观测证据（observed 只含 maxCalls/calls/state/remaining，绝无 token）。 */
  #budgetPayload(kind, budget) {
    const payload = { kind, consumed: budget && budget.consumed != null ? budget.consumed : null, maxCalls: budget && budget.maxCalls != null ? budget.maxCalls : null };
    if (budget && budget.observed) payload.observed = budget.observed;
    return payload;
  }

  /**
   * D4-06 Closure：run 内真实消耗。model/tool calls 来自 capability 真实计量；
   * 轮次数来自本次 run 实际执行的 READ / side-effect loop 轮数。绝不估算、绝不重复。
   */
  #measureConsumption(adapter, rounds) {
    if (!adapter || typeof adapter !== "object") return null;
    let model = 0; let tool = 0;
    try {
      const budget = typeof adapter.budgetExhausted === "function" ? adapter.budgetExhausted() : null;
      if (budget && budget.observed) {
        if (budget.observed.model && Number.isFinite(Number(budget.observed.model.calls))) model = Math.max(0, Number(budget.observed.model.calls));
        if (budget.observed.tool && Number.isFinite(Number(budget.observed.tool.calls))) tool = Math.max(0, Number(budget.observed.tool.calls));
      }
    } catch { /* ignore */ }
    return { MODEL_CALLS: model, TOOL_CALLS: tool, TOOL_ROUNDS: Math.max(0, Number(rounds) || 0) };
  }

  /** 只读任务剩余证据（safe：只有三类整数 remaining，绝无 capability/token）。 */
  #remainingEvidence(context, taskId) {
    try {
      const b = this.#service().getTaskBudget({ context, taskId });
      return b.ok ? b.remaining : null;
    } catch { return null; }
  }

  /**
   * D4-06 Closure：run 开始前 remaining==0 → 不创建 run、不消耗，直接 BUDGET_EXHAUSTED。
   * 停因 kind 沿用 TOOL_CALLS > MODEL_CALLS > TOOL_ROUNDS 的确定优先级，并保留三类剩余证据。
   */
  async #haltForTaskBudget({ context, taskId, stepId, kind, budget, expectedRevision }) {
    const kinds = budget && budget.kinds ? budget.kinds : null;
    const observed = {
      kinds,
      remaining: budget ? budget.remaining : null,
      authorized: budget ? budget.authorized : null,
      consumed: budget ? budget.consumed : null,
    };
    return await this.#blockStep({
      context, taskId, stepId, runId: null, reason: ERROR.BUDGET_EXHAUSTED,
      event: TASK_EVENT.TASK_BUDGET_EXHAUSTED,
      payload: {
        kind,
        consumed: budget && budget.consumed ? budget.consumed[kind] : null,
        maxCalls: kinds && kinds[kind] ? kinds[kind].authorized : null,
        maxRounds: kind === BUDGET_KIND.TOOL_ROUNDS && kinds && kinds[kind] ? kinds[kind].authorized : null,
        remaining: 0,
        observed,
      },
      expectedRevision,
    });
  }

  /**
   * 只读判定：Tool Facade capability 真实 EXHAUSTED（不消耗、不改状态）。
   *
   * D4-06 Closure 正反对照：恰好用尽**最后一次合法调用**（capability 达到 maxCalls 但从未拒绝
   * 新调用）不算失败——模型仍可基于已完成的工具结果收尾；只有真实发生"预算不足拒绝"
   * （exhaustedRejections > 0，即仍有未完成的工具意图）才归为 BUDGET_EXHAUSTED{TOOL_CALLS}。
   */
  #toolBudgetExhausted(adapter) {
    if (!adapter || typeof adapter.budgetExhausted !== "function") return null;
    const budget = adapter.budgetExhausted();
    if (!budget || budget.exhausted !== true || budget.kind !== BUDGET_KIND.TOOL_CALLS) return null;
    const rejected = budget.observed && budget.observed.tool && budget.observed.tool.exhaustedRejections;
    if (!(Number(rejected) > 0)) return null;
    return budget;
  }

  /**
   * D4 收口：一次成功 prompt 之后若 TOOL_CALLS 已真实耗尽，立即 BUDGET_EXHAUSTED{TOOL_CALLS} 停止，
   * 0 后续调度、0 成功提交，并写 task.budget_exhausted 事件。模型调用信封如实 complete（非成功提交）。
   */
  async #haltForToolBudget({ context, taskId, stepId, runId, callId = null, modelRequestId = null, rawEvents = [], budget, fallbackRevision }) {
    const svc = this.#service();
    let rev = fallbackRevision;
    if (callId) {
      const usage = summarizeUsage(rawEvents);
      const done = svc.completeModelCall({ context, taskId, callId, usage: usage || null, requestId: modelRequestId, expectedRevision: rev });
      if (done.ok) rev = done.task.revision;
      else rev = this.#rev(context, taskId, rev);
    }
    const mapped = mapAcpEvents(rawEvents, { maxPersisted: this.maxPersistedHarnessEvents });
    await this.#recordEvents({ context, taskId, runId, events: mapped.events, expectedRevision: rev });
    rev = this.#rev(context, taskId, rev);
    return await this.#blockStep({ context, taskId, stepId, runId, reason: ERROR.BUDGET_EXHAUSTED, event: TASK_EVENT.TASK_BUDGET_EXHAUSTED, payload: this.#budgetPayload(BUDGET_KIND.TOOL_CALLS, budget), expectedRevision: rev, alreadyRecorded: true });
  }

  /** D4-03B Closure：official dsh run 启动前建 Tool Facade Bridge（随机 loopback port）+ Safe Manifest。*/
  async #startToolFacade({ context, taskId, stepId, runId, maxCalls = null }) {
    const cfg = this.toolFacade;
    if (!cfg || cfg.enabled !== true) return null;
    const proxy = this.toolProxy;
    if (!proxy || typeof proxy.executeReadOnly !== "function" || !proxy.adapterFor) return null;
    const toolIds = cfg.toolIds && cfg.toolIds.length ? cfg.toolIds : ["resource.read.metadata", "resource.search"];
    // D4-03C4：WRITE proposal tools 只能走 SIDE_EFFECT_PROPOSAL route；未装配 sideEffectRuntime 时绝不暴露。
    const writeToolIds = cfg.writeToolIds && cfg.writeToolIds.length && this.sideEffectRuntime ? cfg.writeToolIds : [];
    const manifest = buildBridgeManifest(proxy.registry, { readToolIds: toolIds, writeToolIds });
    const make = typeof cfg.bridgeFactory === "function" ? cfg.bridgeFactory : (o) => new ToolFacadeBridge(o);
    const bridge = make({ toolProxy: proxy, manifest, sideEffectRuntime: this.sideEffectRuntime, clock: this.clock, logger: this.logger, ttlMs: cfg.ttlMs, execTimeoutMs: cfg.execTimeoutMs });
    await bridge.start();
    // D4-06 Closure：capability 额度 = 任务剩余（不再用固定的 cfg.maxCalls，避免跨 run 顺带恢复预算）。
    const quota = Number.isFinite(Number(maxCalls)) && Number(maxCalls) > 0 ? Number(maxCalls) : cfg.maxCalls;
    return { bridge, manifest, taskId, stepId, runId, maxCalls: quota, ttlMs: cfg.ttlMs };
  }

  /** 一个 Harness turn 内的全部 tool proposals：逐个 propose→decide→(READ_ONLY) execute→verify。*/
  async #handleToolTurn({ context, taskId, stepId, runId, rawEvents, mappedEvents, task, expectedRevision }) {
    const svc = this.#service();
    await this.#recordEvents({ context, taskId, runId, events: mappedEvents, expectedRevision });
    let rev = this.#rev(context, taskId, expectedRevision);
    const toolEvents = rawEvents.filter((e) => e && e.type === "tool.proposed");
    const results = [];
    for (const ev of toolEvents) {
      const spec = this.#toolSpec(ev);
      const decision = this.toolProxy.propose({ context, taskId, stepId, runId, toolId: spec.toolId, toolVersion: spec.toolVersion, arguments: spec.arguments, proposalId: spec.proposalId });
      const decisionStatus = decision && decision.decisionStatus ? decision.decisionStatus : "BLOCKED";
      const reasonCode = decision && decision.reasonCode ? decision.reasonCode : ERROR.TOOL_FORBIDDEN;
      const proposalId = decision && decision.proposal ? decision.proposal.proposalId : spec.proposalId;
      const decisionEvent = decisionStatus === "APPROVAL_REQUIRED" ? TASK_EVENT.TOOL_APPROVAL_REQUIRED : decisionStatus === "ALLOWED" ? TASK_EVENT.TOOL_VALIDATED : decisionStatus === "DENIED" || decisionStatus === "INVALID" ? TASK_EVENT.TOOL_DENIED : TASK_EVENT.TOOL_EXECUTION_BLOCKED;
      await this.#recordEvents({ context, taskId, runId, events: [
        { eventType: TASK_EVENT.TOOL_PROPOSED, safePayload: { toolId: spec.toolId, toolVersion: spec.toolVersion, proposalId } },
        { eventType: decisionEvent, safePayload: { proposalId, decision: decisionStatus, reasonCode, riskClass: decision && decision.decision ? decision.decision.riskClass : null } },
      ], expectedRevision: rev });
      rev = this.#rev(context, taskId, rev);

      if (decisionStatus === "APPROVAL_REQUIRED") return { terminal: await this.#waitForApproval({ context, taskId, stepId, runId, reason: reasonCode, expectedRevision: rev }) };
      if (decisionStatus !== "ALLOWED") return { terminal: await this.#blockStep({ context, taskId, stepId, runId, reason: reasonCode, event: TASK_EVENT.TOOL_EXECUTION_BLOCKED, expectedRevision: rev, alreadyRecorded: true }) };

      // §32：执行前先落 started event（与 execution record 分离）。
      await this.#recordEvents({ context, taskId, runId, events: [{ eventType: TASK_EVENT.TOOL_EXECUTION_STARTED, safePayload: { proposalId, toolId: spec.toolId } }], expectedRevision: rev });
      rev = this.#rev(context, taskId, rev);
      const exec = await this.toolProxy.executeReadOnly({ context, taskId, stepId, runId, proposalId, expectedRevision: rev });
      const executionId = exec.execution ? exec.execution.executionId : null;
      if (exec.ok) {
        await this.#recordEvents({ context, taskId, runId, events: [{ eventType: TASK_EVENT.TOOL_EXECUTION_SUCCEEDED, safePayload: { proposalId, executionId, toolId: exec.execution.toolId, resultHash: exec.execution.resultHash, verificationStatus: exec.verificationStatus } }], expectedRevision: rev });
        rev = this.#rev(context, taskId, rev);
        results.push({ toolId: exec.execution.toolId, result: exec.result });
      } else {
        const failEvent = exec.verificationStatus === "FAIL" ? TASK_EVENT.TOOL_VERIFICATION_FAILED : TASK_EVENT.TOOL_EXECUTION_FAILED;
        await this.#recordEvents({ context, taskId, runId, events: [{ eventType: failEvent, safePayload: { proposalId, executionId, errorCode: exec.error } }], expectedRevision: rev });
        rev = this.#rev(context, taskId, rev);
        return { terminal: await this.#blockStep({ context, taskId, stepId, runId, reason: exec.error || ERROR.TOOL_EXECUTION_FAILED, event: null, expectedRevision: rev, alreadyRecorded: true }) };
      }
    }
    const followupPrompt = "Tool result (OpenArc-controlled, verified):\n" + JSON.stringify(results.map((r) => ({ toolId: r.toolId, result: r.result }))).slice(0, 4000) + "\nContinue the task.";
    const fresh = svc.getTask({ context, taskId });
    return { terminal: null, task: fresh.ok ? fresh.task : task, followupPrompt };
  }

  /** 从 ACP tool.proposed event 抽取 OpenArc 合同字段（测试约定：title=toolId，rawInput={ toolVersion, arguments }）。*/
  #toolSpec(ev) {
    const raw = ev && ev.rawInput && typeof ev.rawInput === "object" ? ev.rawInput : {};
    const toolId = String((ev && (ev.toolId || ev.title)) || "").trim();
    const toolVersion = Number(raw.toolVersion != null ? raw.toolVersion : (ev && ev.toolVersion != null ? ev.toolVersion : 1));
    const toolArguments = raw.arguments && typeof raw.arguments === "object" ? raw.arguments : (raw.args && typeof raw.args === "object" ? raw.args : raw);
    return { toolId, toolVersion, arguments: toolArguments, proposalId: (ev && ev.toolCallId) || null };
  }

  /** Tool 需要审批：Step BLOCKED + Task WAITING（reason 冻结 = TOOL_APPROVAL_REQUIRED）。*/
  async #waitForApproval({ context, taskId, stepId, runId, reason, expectedRevision }) {
    const svc = this.#service();
    const waited = svc.waitForApproval({ context, taskId, stepId, runId, reason, expectedRevision });
    if (!waited.ok) return waited;
    const runApproval = svc.blockHarnessRun({ context, taskId, runId, errorCode: reason, stopReason: "approval_required", expectedRevision: waited.task.revision });
    return { ok: false, error: reason, approvalRequired: true, step: waited.step, task: runApproval.ok ? runApproval.task : waited.task, run: runApproval.ok ? runApproval.run : null };
  }

  async #recordEvents({ context, taskId, runId, events, expectedRevision }) {
    if (!events || !events.length) return { ok: true, added: 0 };
    return this.#service().recordHarnessEvents({ context, taskId, runId, events, expectedRevision, maxEvents: this.maxPersistedHarnessEvents });
  }

  async #blockStep({ context, taskId, stepId, runId, reason, event = null, payload = null, expectedRevision, alreadyRecorded = false }) {
    void alreadyRecorded;
    const svc = this.#service();
    const blocked = svc.blockStep({ context, taskId, stepId, runId, reason, event, payload, expectedRevision });
    if (!blocked.ok) return blocked;
    const runBlocked = svc.blockHarnessRun({ context, taskId, runId, errorCode: reason, stopReason: "blocked", expectedRevision: blocked.task.revision });
    return { ok: false, error: reason, blocked: true, step: blocked.step, task: runBlocked.ok ? runBlocked.task : blocked.task, run: runBlocked.ok ? runBlocked.run : null };
  }

  async #finalizeCancelled({ context, taskId, runId, expectedRevision }) {
    const svc = this.#service();
    const runCancel = svc.cancelHarnessRun({ context, taskId, runId, expectedRevision });
    const rev = runCancel.ok ? runCancel.task.revision : expectedRevision;
    const fin = svc.finalizeCancel({ context, taskId, expectedRevision: rev });
    if (fin.ok) return { ok: false, error: ERROR.HARNESS_CANCELLED, cancelled: true, task: fin.task, run: runCancel.ok ? runCancel.run : null };
    const fresh = svc.getTask({ context, taskId });
    if (fresh.ok && fresh.task.status === TASK_STATUS.CANCELLED) return { ok: false, error: ERROR.HARNESS_CANCELLED, cancelled: true, task: fresh.task };
    return fin;
  }

  /** 用户 cancel：先持久 cancel_requested=1 → ACP cancel → revoke capability → finalize。*/
  async cancel({ context, taskId, expectedRevision } = {}) {
    const svc = this.#service();
    const req = svc.requestCancel({ context, taskId, expectedRevision });
    if (!req.ok) return req;
    let rev = req.task.revision;
    for (const [runId, entry] of this.registry) {
      if (entry.taskId !== taskId) continue;
      try { await entry.adapter.cancel(); } catch { /* ignore */ }
      try { entry.adapter.revokeToolCapability(); } catch { /* ignore */ }
      try { entry.adapter.revokeModelCapability(); } catch { /* ignore */ }
      const cr = svc.cancelHarnessRun({ context, taskId, runId, expectedRevision: rev });
      if (cr.ok) rev = cr.task.revision;
    }
    const runs = svc.getHarnessRuns({ context, taskId });
    if (runs.ok) {
      for (const r of runs.items) {
        if (r.status === "STARTING" || r.status === "RUNNING") {
          const cr = svc.cancelHarnessRun({ context, taskId, runId: r.runId, expectedRevision: rev });
          if (cr.ok) rev = cr.task.revision;
        }
      }
    }
    const fin = svc.finalizeCancel({ context, taskId, expectedRevision: rev });
    if (!fin.ok) return fin;
    return { ok: true, cancelled: true, task: fin.task };
  }

  /**
   * D4-06 Closure · 唯一被解禁的 Explicit Resume：**因 bounded 预算耗尽而停止**、
   * 且**不存在未决副作用**的 task，由用户显式触发。
   *
   * 边界（其他 resume 场景仍 DEFERRED）：
   *   · 后端 TaskService 重新判定 actor/app/owner/stop-reason/side-effect/lease/次数；
   *   · 只新增一个 bounded reasoning step + 一次新 run（新 capability），绝不 replay 旧 tool 请求；
   *   · 旧 step / call / artifact / verification / 副作用全部保留；AUTO_RETRY 恒为 0。
   */
  async resumeBudgetExhausted({ context, taskId, expectedRevision, verify = null, turnTimeoutMs = this.turnTimeoutMs } = {}) {
    const svc = this.#service();
    const eligibility = svc.getResumeEligibility({ context, taskId });
    if (!eligibility.ok) return eligibility;
    if (!eligibility.resumable) return { ok: false, error: eligibility.reason || "RESUME_NOT_ELIGIBLE", resumable: false, stopReason: eligibility.stopReason || null };
    // 追加额度由 TaskService 依该类实际生效额度单事务决定；orchestrator 绝不自报金额。
    const granted = svc.grantBudgetResume({ context, taskId, expectedRevision, kind: eligibility.kind });
    if (!granted.ok) return granted;
    const stepStarted = svc.startStep({ context, taskId, stepId: granted.step.stepId, expectedRevision: granted.task.revision });
    if (!stepStarted.ok) return stepStarted;
    return this.runStep({ context, taskId, stepId: granted.step.stepId, expectedRevision: stepStarted.task.revision, stepInput: granted.step.input, verify, turnTimeoutMs });
  }

  /** 显式 resume（非预算场景）：第一版仍 DEFERRED；接口保留但不实现自动 replay。*/
  async resume() { return { ok: false, error: "EXPLICIT_RESUME_DEFERRED" }; }

  async dispose() {
    for (const entry of this.registry.values()) {
      try { entry.adapter.revokeToolCapability(); } catch { /* ignore */ }
      try { entry.adapter.revokeModelCapability(); } catch { /* ignore */ }
      try { await entry.adapter.dispose(); } catch { /* ignore */ }
    }
    this.registry.clear();
  }
}

module.exports = { TaskHarnessOrchestrator, ORCHESTRATOR_ERROR, PROMPT_SCHEMA_VERSION, buildPrompt, mapAcpEvents, classifyHarnessError, sha256, DEFAULT_MAX_CALLS, MAX_TOOL_ROUNDS };
