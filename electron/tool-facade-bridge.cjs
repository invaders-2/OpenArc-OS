/**
 * D4-03B Closure · OpenArc Tool Facade Bridge。
 *
 * 唯一职责：official dsh Tool Plugin 的 execute() → 本 Bridge → ControlledToolProxy
 * （propose → decision → reauthorize → executeReadOnly → verify）→ safe result。
 *
 * Bridge **不**直接调用 ResourceService/SearchService，绝不持有第二份 Tool Authority。
 * 每个 run 独立随机 loopback port + 独立 `tpx_` capability；capability 只活进程内存，
 * 绝不落 SQLite / TaskEvent / Audit / Artifact / DSH_HOME / manifest / logs。
 */
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const domain = require("./tool-domain.cjs");
const { isWellFormedToolId, fingerprint } = domain;
const { buildBridgeManifest, ROUTE } = require("./tool-registry.cjs");

const CAP_STATE = Object.freeze({ ACTIVE: "ACTIVE", REVOKED: "REVOKED", EXPIRED: "EXPIRED", EXHAUSTED: "EXHAUSTED" });
const TOOL_CAPABILITY_PREFIX = "tpx_";
const DEFAULT_TTL_MS = 120000;
const MAX_BODY_BYTES = 256 * 1024;

const BRIDGE_ERROR = Object.freeze({
  NOT_FOUND: "TOOL_FACADE_NOT_FOUND",
  BAD_REQUEST: "TOOL_FACADE_BAD_REQUEST",
  UNAUTHORIZED: "TOOL_CAPABILITY_UNAUTHORIZED",
  NOT_ALLOWED: "TOOL_NOT_ALLOWED_BY_CAPABILITY",
  EXHAUSTED: "TOOL_CAPABILITY_EXHAUSTED",
  STALE_CONTRACT: "TOOL_CONTRACT_STALE",
  // D4-03D Closure：logical Tool-call identity。
  CALL_ID_REQUIRED: "TOOL_CALL_ID_REQUIRED",
  CALL_ID_CONFLICT: "TOOL_CALL_ID_CONFLICT",
  SCOPE_INVALID: "TOOL_CAPABILITY_SCOPE_INVALID",
  DENIED: "TOOL_DENIED",
  EXECUTION_FAILED: "TOOL_EXECUTION_FAILED",
  // D4-03C4：WRITE proposal 的唯一对外语义。Harness 拿不到执行权。
  APPROVAL_REQUIRED: "SIDE_EFFECT_APPROVAL_REQUIRED",
  SIDE_EFFECT_ROUTE_UNAVAILABLE: "SIDE_EFFECT_ROUTE_UNAVAILABLE",
});

/** 工具结果不得携带绝对路径 / store root / credential 形态。 */
const UNSAFE_STRING_RE = /(^|\s)(\/Users\/|\/private\/|\/var\/folders|C:\\|\\\\[^\\]+\\)/;
const UNSAFE_KEY_RE = domain.FORBIDDEN_ARGUMENT_KEY;

/**
 * D4-03D Closure · logical Tool-call identity 的 callId contract（Harness 不可绕过）。
 * non-empty bounded string，无 NUL / C0 / C1 控制字符；刻意不限制合法 ID 的字符集。
 */
const CALL_ID_MAX = 256;
const CALL_ID_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
function isValidCallId(value) {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > CALL_ID_MAX) return false;
  if (value.trim().length < 1) return false;
  if (CALL_ID_CONTROL_RE.test(value)) return false;
  return true;
}
function redactUnsafe(value, depth = 0) {
  if (typeof value === "string") return UNSAFE_STRING_RE.test(value) ? "[REDACTED_PATH]" : (value.length > 2048 ? value.slice(0, 2048) + "…" : value);
  if (value == null || typeof value !== "object" || depth > 6) return value;
  if (Array.isArray(value)) return value.slice(0, 64).map((v) => redactUnsafe(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = UNSAFE_KEY_RE.test(k) ? "[REDACTED]" : redactUnsafe(v, depth + 1);
  return out;
}

class ToolFacadeBridge {
  constructor({ toolProxy, manifest = null, sideEffectRuntime = null, clock = null, logger = null, ttlMs = DEFAULT_TTL_MS, execTimeoutMs = 15000 } = {}) {
    if (!toolProxy) throw new Error("ToolFacadeBridge 需要 ControlledToolProxy");
    this.toolProxy = toolProxy;
    this.manifest = manifest;
    // D4-03C4：受控 WRITE proposal route（唯一 side-effect 装配）。绝不在本文件里建立第二套 authority。
    this.sideEffectRuntime = sideEffectRuntime;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    this.ttlMs = Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS);
    this.execTimeoutMs = Math.max(1, Number(execTimeoutMs) || 15000);
    this.capabilities = new Map();
    this.server = null;
    this.baseUrl = null;
    this.stats = { calls: 0, allowed: 0, denied: 0, conflicts: 0, domainExecutions: 0, sideEffectProposals: 0 };
  }

  #now() { return this.clock(); }

  /** official dsh boot 前确认 manifest contractHash == 当前 Registry。 */
  currentManifestHash() {
    const m = this.manifest;
    if (!m) return buildBridgeManifest(this.toolProxy.registry, { readToolIds: this.toolProxy.registry.ids() }).contractHash;
    const routes = m.routes || {};
    const readIds = m.toolIds.filter((id) => routes[id] !== ROUTE.SIDE_EFFECT_PROPOSAL);
    const writeIds = m.toolIds.filter((id) => routes[id] === ROUTE.SIDE_EFFECT_PROPOSAL);
    return buildBridgeManifest(this.toolProxy.registry, { readToolIds: readIds, writeToolIds: writeIds }).contractHash;
  }
  contractFresh() { return !this.manifest || this.manifest.contractHash === this.currentManifestHash(); }

  issueCapability({ context = {}, taskId, stepId = null, runId = null, allowedTools = null, maxCalls = 1, ttlMs = this.ttlMs } = {}) {
    const appId = context.appId;
    const sessionRef = context.sessionRef;
    const task = taskId ? this.toolProxy.taskStore.taskById(taskId) : null;
    if (!task || !sessionRef || !appId || task.app_id !== appId) return { ok: false, error: BRIDGE_ERROR.SCOPE_INVALID };
    const tools = [...new Set((allowedTools || (this.manifest ? this.manifest.toolIds : [])).map(String))].filter(isWellFormedToolId);
    if (!tools.length) return { ok: false, error: BRIDGE_ERROR.SCOPE_INVALID };
    let userId = null;
    try {
      const actor = this.toolProxy.authService.resolveActor({ context: { sessionRef, appId, source: "agent", agent: true } });
      if (actor && actor.ok) userId = actor.user.id;
    } catch { /* actor 解析留给 propose 再判 */ }
    const token = TOOL_CAPABILITY_PREFIX + crypto.randomBytes(24).toString("base64url");
    const cap = {
      capabilityId: "tcap_" + crypto.randomBytes(8).toString("base64url"),
      token, nonce: crypto.randomBytes(8).toString("base64url"),
      userId, sessionRef, appId, taskId, stepId, runId,
      allowedTools: tools,
      maxCalls: Math.max(1, Number(maxCalls) || 1),
      calls: 0,
      callsById: new Map(),
      issuedAt: this.#now(), expiresAt: this.#now() + Math.max(1, Number(ttlMs) || this.ttlMs),
      state: CAP_STATE.ACTIVE,
    };
    this.capabilities.set(token, cap);
    return { ok: true, capability: { capabilityId: cap.capabilityId, token, expiresAt: cap.expiresAt, maxCalls: cap.maxCalls, allowedTools: [...tools], taskId, stepId, runId } };
  }

  revokeCapability(token) {
    const cap = this.capabilities.get(String(token || ""));
    if (!cap) return { ok: true, changed: false };
    cap.state = CAP_STATE.REVOKED;
    return { ok: true, changed: true };
  }
  /** 只回安全状态，供执行绑定断言；绝不暴露 token。 */
  capabilityState(token) {
    const cap = this.capabilities.get(String(token || ""));
    if (!cap) return null;
    return { capabilityId: cap.capabilityId, state: cap.state, calls: cap.calls, maxCalls: cap.maxCalls, taskId: cap.taskId, stepId: cap.stepId, runId: cap.runId, sessionRef: cap.sessionRef, appId: cap.appId };
  }

  async start() {
    if (this.server) return { baseUrl: this.baseUrl };
    this.server = http.createServer((req, res) => { void this.#handle(req, res); });
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.baseUrl = "http://127.0.0.1:" + this.server.address().port;
    return { baseUrl: this.baseUrl, port: this.server.address().port };
  }

  async stop() {
    if (!this.server) { this.capabilities.clear(); this.baseUrl = null; return { ok: true, changed: false }; }
    const s = this.server;
    this.server = null;
    this.baseUrl = null;
    this.capabilities.clear();
    await new Promise((r) => s.close(r));
    return { ok: true, changed: true };
  }

  /**
   * 顺序冻结（D4-03D Closure §21）：
   *   authenticate capability → TTL/state → parse body → validate toolId → validate callId →
   *   contract freshness → compute request fingerprint → identity binding（duplicate / conflict）→
   *   reserve call budget（原子）→ execute route。
   * 绝不 execute first → dedupe later。
   */
  async #handle(req, res) {
    const send = (status, obj) => { if (res.writableEnded || res.destroyed) return; res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method !== "POST" || req.url !== "/tool-call") return send(404, { ok: false, error: BRIDGE_ERROR.NOT_FOUND });
    let raw = ""; let tooBig = false;
    await new Promise((resolve) => { req.on("data", (d) => { raw += d; if (raw.length > MAX_BODY_BYTES) { tooBig = true; req.destroy(); } }); req.on("end", resolve); req.on("close", resolve); });
    if (tooBig) return send(413, { ok: false, error: BRIDGE_ERROR.BAD_REQUEST });

    const auth = String((req.headers && req.headers.authorization) || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const cap = this.capabilities.get(token);
    if (!cap || cap.state === CAP_STATE.REVOKED) return send(401, { ok: false, error: BRIDGE_ERROR.UNAUTHORIZED });
    if (this.#now() >= cap.expiresAt) { cap.state = CAP_STATE.EXPIRED; return send(401, { ok: false, error: BRIDGE_ERROR.UNAUTHORIZED }); }

    let body;
    try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, error: BRIDGE_ERROR.BAD_REQUEST }); }
    const toolId = body && typeof body.toolId === "string" ? body.toolId : "";
    if (!isWellFormedToolId(toolId) || !cap.allowedTools.includes(toolId)) return send(403, { ok: false, error: BRIDGE_ERROR.NOT_ALLOWED });

    // callId 是 mandatory logical Tool-call identity：missing / invalid 在任何 budget / proposal / execution 之前 fail closed。
    const callId = body && typeof body.callId === "string" ? body.callId : "";
    if (!isValidCallId(callId)) return send(400, { ok: false, error: BRIDGE_ERROR.CALL_ID_REQUIRED });
    if (!this.contractFresh()) return send(409, { ok: false, error: BRIDGE_ERROR.STALE_CONTRACT });

    // Tool-call identity = runId + callId + toolId + canonical arguments fingerprint。
    const requestFingerprint = fingerprint({ toolId, arguments: body && body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments) ? body.arguments : {} });
    const existing = cap.callsById.get(callId);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint || existing.toolId !== toolId) {
        // 同一个 callId 不能改变 toolId / canonical arguments：绝不返回旧请求结果，也绝不覆盖原 binding。
        this.stats.conflicts += 1;
        this.stats.denied += 1;
        this.logger?.log?.({ event: "tool-facade-bridge", result: "DENY", error_code: BRIDGE_ERROR.CALL_ID_CONFLICT, tool: toolId });
        return send(409, { ok: false, error: BRIDGE_ERROR.CALL_ID_CONFLICT });
      }
      // exact duplicate：还回同一 safe outcome / await 同一 pending；0 second execution / 0 extra budget。
      const prior = existing.outcome ? existing.outcome : (existing.pending ? await existing.pending : { ok: false, error: BRIDGE_ERROR.EXECUTION_FAILED });
      return send(200, prior || { ok: false, error: BRIDGE_ERROR.EXECUTION_FAILED });
    }

    // 新的 logical call：原子 reserve call budget（check + increment 之间无 await）。
    if (cap.calls >= cap.maxCalls) { cap.state = CAP_STATE.EXHAUSTED; return send(429, { ok: false, error: BRIDGE_ERROR.EXHAUSTED }); }
    cap.calls += 1;
    this.stats.calls += 1;
    let settle = null;
    const pending = new Promise((r) => { settle = r; });
    const binding = { requestFingerprint, toolId, pending, outcome: null };
    cap.callsById.set(callId, binding);

    // §41：客户端（dsh）断开 → 中止在途 Domain 执行，不返回 stale 数据。
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", onClose);
    let outcome;
    try { outcome = await this.#execute(cap, toolId, body.arguments, controller.signal); }
    catch { outcome = { ok: false, error: BRIDGE_ERROR.EXECUTION_FAILED }; }
    finally { res.removeListener("close", onClose); }
    if (outcome.ok) this.stats.allowed += 1; else this.stats.denied += 1;
    binding.outcome = outcome;
    if (settle) settle(outcome);
    this.logger?.log?.({ event: "tool-facade-bridge", result: outcome.ok ? "ALLOW" : "DENY", error_code: outcome.error || null, tool: toolId });
    return send(200, outcome);
  }

  /**
   * Route 由 Tool Registry 权威决定（Harness 不能自报）：
   *   READ_ONLY            → propose → reauthorize → executeReadOnly → verify
   *   SIDE_EFFECT_PROPOSAL → propose → decision → SideEffectPlan(AWAITING_APPROVAL)
   * 两条路由的权限语义**不合并**；WRITE 绝不经过 READ_ONLY execution。
   */
  #routeFor(toolId) {
    const versions = this.toolProxy.registry.versionsOf(toolId);
    const version = versions.length ? versions[versions.length - 1] : null;
    const contract = version == null ? null : this.toolProxy.registry.get(toolId, version);
    if (!contract) return ROUTE.READ_ONLY;
    return contract.riskClass === "READ_ONLY" ? ROUTE.READ_ONLY : ROUTE.SIDE_EFFECT_PROPOSAL;
  }

  /** WRITE proposal route：只生成 SideEffectCall（AWAITING_APPROVAL）。0 mutation / 0 lease / 0 execute。 */
  async #proposeSideEffect(cap, toolId, args) {
    if (!this.sideEffectRuntime) return { ok: false, error: BRIDGE_ERROR.SIDE_EFFECT_ROUTE_UNAVAILABLE };
    const versions = this.toolProxy.registry.versionsOf(toolId);
    const toolVersion = versions.length ? versions[versions.length - 1] : 1;
    const context = { sessionRef: cap.sessionRef, appId: cap.appId, requestId: "treq_" + cap.capabilityId };
    let planned;
    try {
      planned = await this.sideEffectRuntime.proposeWrite({ context, taskId: cap.taskId, stepId: cap.stepId, runId: cap.runId, toolId, toolVersion, arguments: args && typeof args === "object" ? args : {} });
    } catch {
      return { ok: false, error: BRIDGE_ERROR.DENIED };
    }
    if (!planned || !planned.ok) return { ok: false, error: (planned && planned.error) || BRIDGE_ERROR.DENIED };
    this.stats.sideEffectProposals += 1;
    // 绝不返回 success：Harness 只能看到 bounded "approval required"，绝不看到 unverified success。
    return { ok: false, error: BRIDGE_ERROR.APPROVAL_REQUIRED, approvalRequired: true, approvalRequestId: planned.approvalRequestId };
  }

  /** 唯一执行路径：ControlledToolProxy.propose → executeReadOnly。绝不直调 Domain。 */
  async #execute(cap, toolId, args, signal = null) {
    if (this.#routeFor(toolId) === ROUTE.SIDE_EFFECT_PROPOSAL) return this.#proposeSideEffect(cap, toolId, args);
    const context = { sessionRef: cap.sessionRef, appId: cap.appId, requestId: "treq_" + cap.capabilityId };
    const versions = this.toolProxy.registry.versionsOf(toolId);
    const toolVersion = versions.length ? versions[versions.length - 1] : 1;
    const proposal = this.toolProxy.propose({ context, taskId: cap.taskId, stepId: cap.stepId, runId: cap.runId, toolId, toolVersion, arguments: args && typeof args === "object" ? args : {} });
    if (!proposal || !proposal.proposal) return { ok: false, error: (proposal && proposal.reasonCode) || BRIDGE_ERROR.DENIED };
    if (proposal.decisionStatus !== "ALLOWED") return { ok: false, error: proposal.reasonCode || BRIDGE_ERROR.DENIED };
    const task = this.toolProxy.taskStore.taskById(cap.taskId);
    const expectedRevision = task ? task.revision : null;
    const exec = await this.toolProxy.executeReadOnly({ context, taskId: cap.taskId, stepId: cap.stepId, runId: cap.runId, proposalId: proposal.proposal.proposalId, expectedRevision, timeoutMs: this.execTimeoutMs, signal });
    if (!exec.ok) return { ok: false, error: exec.error || BRIDGE_ERROR.EXECUTION_FAILED };
    this.stats.domainExecutions += 1;
    return { ok: true, result: redactUnsafe(exec.result) };
  }
}

module.exports = { ToolFacadeBridge, BRIDGE_ERROR, CAP_STATE, TOOL_CAPABILITY_PREFIX, redactUnsafe, isValidCallId };
