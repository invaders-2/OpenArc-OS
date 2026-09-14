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

const {
  TASK_STATUS, STEP_STATUS, TASK_EVENT, ERROR, ORCHESTRATION_KIND,
  ARTIFACT_TYPE, VERIFICATION_TYPE, ACP_EVENT_MAP, sanitizeEventPayload,
} = domain;

const PROMPT_SCHEMA_VERSION = 1;
const DEFAULT_TURN_TIMEOUT_MS = 180000;
const DEFAULT_START_TIMEOUT_MS = 30000;
const DEFAULT_MAX_PERSISTED_EVENTS = 64;
const DEFAULT_MAX_CALLS = 4;

const ORCHESTRATOR_ERROR = Object.freeze({
  NO_ADAPTER: "ORCHESTRATOR_NO_ADAPTER",
  NOT_RUNNING: "ORCHESTRATOR_NOT_RUNNING",
});

function sha256(text) { return crypto.createHash("sha256").update(String(text)).digest("hex"); }

/** §16/§17 安全 prompt：只放 goal + safe step input + 可选 prior artifact；绝不塞 DB dump / credentials / 全历史。*/
function buildPrompt({ goal, stepInput = null, priorArtifactText = null } = {}) {
  const lines = [];
  lines.push("You are an OpenArc reasoning runtime. Tools are disabled; answer in text only.");
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
  constructor({ taskService, adapterFactory = null, clock = null, logger = null, turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS, startTimeoutMs = DEFAULT_START_TIMEOUT_MS, maxPersistedHarnessEvents = DEFAULT_MAX_PERSISTED_EVENTS } = {}) {
    if (!taskService) throw new Error("TaskHarnessOrchestrator 需要 TaskService");
    this.taskService = taskService;
    this.adapterFactory = adapterFactory;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    this.turnTimeoutMs = turnTimeoutMs;
    this.startTimeoutMs = startTimeoutMs;
    this.maxPersistedHarnessEvents = maxPersistedHarnessEvents;
    this.registry = new Map(); // runId -> { taskId, stepId, capabilityId, adapter }
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
    const promptText = buildPrompt({ goal: task.goal, stepInput: effectiveInput });

    const runRes = svc.startHarnessRun({ context, taskId, stepId, expectedRevision: task.revision });
    if (!runRes.ok) return runRes;
    task = runRes.task;
    const run = runRes.run;

    let adapter = null;
    let info = null;
    try {
      adapter = this.#makeAdapter({ context, taskId, stepId, runId: run.runId, modelConfigId: task.modelConfigId, modelConfigVersion: task.modelConfigVersion });
      info = await adapter.start({ context, modelConfigId: task.modelConfigId, maxCalls: DEFAULT_MAX_CALLS, startTimeoutMs: this.startTimeoutMs, requestId: "mreq_" + run.runId });
    } catch (e) {
      if (adapter) { try { adapter.revokeModelCapability(); } catch { /* ignore */ } try { await adapter.dispose(); } catch { /* ignore */ } }
      return this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: classifyHarnessError(e), event: TASK_EVENT.HARNESS_RUN_UNKNOWN_EFFECT, expectedRevision: task.revision });
    }
    this.registry.set(run.runId, { taskId, stepId, capabilityId: info.capabilityId, adapter });

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

      const rawEvents = Array.isArray(res.events) ? res.events : [];
      const mapped = mapAcpEvents(rawEvents, { maxPersisted: this.maxPersistedHarnessEvents });
      const hasTool = rawEvents.some((e) => e && e.type === "tool.proposed");
      const hasPermission = rawEvents.some((e) => e && (e.type === "permission.requested" || e.type === "permission.rejected"));
      const usage = summarizeUsage(rawEvents);
      const callDone = svc.completeModelCall({ context, taskId, callId, usage: usage || null, requestId: modelRequestId, expectedRevision: task.revision });
      if (callDone.ok) task = callDone.task;

      const latest = svc.getTask({ context, taskId });
      const cancelled = (latest.ok && latest.task.cancelRequested) || res.stopReason === "cancelled";
      if (cancelled) return await this.#finalizeCancelled({ context, taskId, runId: run.runId, expectedRevision: task.revision });

      // §71 Tool proposal：0 execute，Step BLOCKED（绝不 SUCCEEDED）。
      if (hasTool) {
        await this.#recordEvents({ context, taskId, runId: run.runId, events: mapped.events, expectedRevision: task.revision, task });
        const fresh = svc.getTask({ context, taskId });
        return await this.#blockStep({ context, taskId, stepId, runId: run.runId, reason: ERROR.TOOL_EXECUTION_NOT_AVAILABLE, event: TASK_EVENT.HARNESS_TOOL_PROPOSED, expectedRevision: (fresh.ok ? fresh.task.revision : task.revision), alreadyRecorded: true });
      }
      // §22/§72 Permission request：一律 reject，Step BLOCKED。
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
      try { adapter.revokeModelCapability(); } catch { /* ignore */ }
      try { await adapter.dispose(); } catch { /* ignore */ }
      this.registry.delete(run.runId);
    }
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
      try { entry.adapter.revokeModelCapability(); } catch { /* ignore */ }
      try { await entry.adapter.dispose(); } catch { /* ignore */ }
    }
    this.registry.clear();
  }
}

module.exports = { TaskHarnessOrchestrator, ORCHESTRATOR_ERROR, PROMPT_SCHEMA_VERSION, buildPrompt, mapAcpEvents, classifyHarnessError, sha256 };
