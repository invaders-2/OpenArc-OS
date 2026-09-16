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
} = domain;

const PROMPT_SCHEMA_VERSION = 1;
const DEFAULT_TURN_TIMEOUT_MS = 180000;
const DEFAULT_START_TIMEOUT_MS = 30000;
const DEFAULT_MAX_PERSISTED_EVENTS = 64;
// D4-03D：一个 Harness run 内的 bounded 模型调用预算。混合 READ + WRITE turn 需要
// tool calls + 1 次 final + 1 次 verified-continuation，4 会误伤合法流程；仍然 bounded，
// 且绝不引入 hidden retry（0 retry 由 AUTO_RETRY/failModelCall 语义保证）。
const DEFAULT_MAX_CALLS = 8;
const MAX_TOOL_ROUNDS = 4;

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
    const promptText = buildPrompt({ goal: task.goal, stepInput: effectiveInput, toolsEnabled });

    const runRes = svc.startHarnessRun({ context, taskId, stepId, expectedRevision: task.revision });
    if (!runRes.ok) return runRes;
    task = runRes.task;
    const run = runRes.run;

    let adapter = null;
    let info = null;
    let facade = null;
    try {
      facade = await this.#startToolFacade({ context, taskId, stepId, runId: run.runId });
      adapter = this.#makeAdapter({ context, taskId, stepId, runId: run.runId, modelConfigId: task.modelConfigId, modelConfigVersion: task.modelConfigVersion });
      info = await adapter.start({ context, modelConfigId: task.modelConfigId, maxCalls: DEFAULT_MAX_CALLS, startTimeoutMs: this.startTimeoutMs, requestId: "mreq_" + run.runId, toolFacade: facade });
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
        const code = classifyHarnessError(e);
        const failedCall = svc.failModelCall({ context, taskId, callId, providerErrorCode: code, requestId: modelRequestId, expectedRevision: task.revision });
        const failRev = failedCall.ok ? failedCall.task.revision : task.revision;
        if (code === ERROR.HARNESS_CANCELLED) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: failRev });
        return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: code, event: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT, expectedRevision: failRev });
      }

      let rawEvents = Array.isArray(res.events) ? res.events : [];
      let mapped = mapAcpEvents(rawEvents, { maxPersisted: this.maxPersistedHarnessEvents });
      let usage = summarizeUsage(rawEvents);
      const hasToolEvents = () => rawEvents.some((e) => e && e.type === "tool.proposed");
      const executableProxy = !!(this.toolProxy && this.toolProxy.adapterFor);
      // D4-03B Closure：official dsh 已由 Tool Runtime 执行 plugin.execute() → Tool Facade Bridge；
      // OpenArc 在这里绝不重复执行，只记录 safe ACP events 并等 turn 完成。
      const facadeMode = info.toolExecutionMode === "facade";

      // §33/§34/§63/§65/§89：READ_ONLY Tool 执行循环。每个 proposal 都重新 propose→decide→reauthorize→execute→verify；
      // 结果经 bounded 后续 prompt 交回 Harness 继续推理。无 adapter（D4-03A gate / 无 proxy）维持 gate 语义。
      if (!facadeMode && executableProxy) {
        let round = 0;
        while (hasToolEvents() && round < MAX_TOOL_ROUNDS) {
          round += 1;
          const handled = await this.#handleToolTurn({ context, taskId, stepId, runId: run.runId, rawEvents, mappedEvents: mapped.events, task, expectedRevision: task.revision });
          if (handled.terminal) return handled.terminal;
          task = handled.task;
          let next;
          try {
            next = await adapter.prompt(handled.followupPrompt, { timeoutMs: turnTimeoutMs });
          } catch (e) {
            const code = classifyHarnessError(e);
            const failedCall = svc.failModelCall({ context, taskId, callId, providerErrorCode: code, requestId: modelRequestId, expectedRevision: task.revision });
            const failRev = failedCall.ok ? failedCall.task.revision : task.revision;
            if (code === ERROR.HARNESS_CANCELLED) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: failRev });
            return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: code, event: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT, expectedRevision: failRev });
          }
          res = next;
          rawEvents = Array.isArray(next.events) ? next.events : [];
          mapped = mapAcpEvents(rawEvents, { maxPersisted: this.maxPersistedHarnessEvents });
          usage = summarizeUsage(rawEvents) || usage;
          const latestTask = svc.getTask({ context, taskId });
          if (latestTask.ok) task = latestTask.task;
          if (latestTask.ok && latestTask.task.cancelRequested) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: task.revision });
        }
        if (hasToolEvents()) return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: ERROR.TOOL_EXECUTION_NOT_AVAILABLE, event: TASK_EVENT.TOOL_EXECUTION_BLOCKED, expectedRevision: task.revision });
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
        while (sideRounds < MAX_TOOL_ROUNDS) {
          sideRounds += 1;
          const pending = this.#sideEffectCallsToOrchestrate(stepId, run.runId);
          if (!pending.length) break;
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
            const code = classifyHarnessError(e);
            const failedCall = svc.failModelCall({ context, taskId, callId, providerErrorCode: code, requestId: modelRequestId, expectedRevision: task.revision });
            const failRev = failedCall.ok ? failedCall.task.revision : task.revision;
            if (code === ERROR.HARNESS_CANCELLED) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: failRev });
            return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: code, event: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT, expectedRevision: failRev });
          }
          res = next;
          rawEvents = Array.isArray(next.events) ? next.events : [];
          mapped = mapAcpEvents(rawEvents, { maxPersisted: this.maxPersistedHarnessEvents });
          usage = summarizeUsage(rawEvents) || usage;
          const latestTask = svc.getTask({ context, taskId });
          if (latestTask.ok) task = latestTask.task;
          if (latestTask.ok && latestTask.task.cancelRequested) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: task.revision });
        }
        const leftover = this.#sideEffectCallsToOrchestrate(stepId, run.runId);
        if (leftover.length) return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: "SIDE_EFFECT_APPROVAL_UNRESOLVED", event: TASK_EVENT.TOOL_SIDE_EFFECT_EXECUTION_BLOCKED, expectedRevision: task.revision, alreadyRecorded: true });
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

  /** D4-03B Closure：official dsh run 启动前建 Tool Facade Bridge（随机 loopback port）+ Safe Manifest。*/
  async #startToolFacade({ context, taskId, stepId, runId }) {
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
    return { bridge, manifest, taskId, stepId, runId, maxCalls: cfg.maxCalls, ttlMs: cfg.ttlMs };
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

  async #blockStep({ context, taskId, stepId, runId, reason, event = null, expectedRevision, alreadyRecorded = false }) {
    void alreadyRecorded;
    const svc = this.#service();
    const blocked = svc.blockStep({ context, taskId, stepId, runId, reason, event, expectedRevision });
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

  /** 显式 resume：第一版 DEFERRED；接口保留但不实现自动 replay。*/
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

module.exports = { TaskHarnessOrchestrator, ORCHESTRATOR_ERROR, PROMPT_SCHEMA_VERSION, buildPrompt, mapAcpEvents, classifyHarnessError, sha256 };
