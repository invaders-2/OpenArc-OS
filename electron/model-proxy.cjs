/**
 * D4-01 · OpenArc Model Proxy。
 *
 * 唯一 Provider 调用出口：Harness / future internal execution 只拿 endpoint + scoped capability，
 * 永远拿不到 Provider API Key。
 *
 * - bind 127.0.0.1:0（随机端口），绝不 0.0.0.0；
 * - localhost ≠ auth：每个请求必须携带有效 ModelProxyCapability；
 * - 每次请求重新授权（session/user/app/config/provider/model/capability/configVersion）；
 * - 只有受控路由 `POST /v1/chat/completions`，不做通用 HTTP 转发。
 */
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const domain = require("./model-domain.cjs");

const CAP_STATE = Object.freeze({ ISSUED: "ISSUED", ACTIVE: "ACTIVE", EXPIRED: "EXPIRED", EXHAUSTED: "EXHAUSTED", REVOKED: "REVOKED" });
const DEFAULT_TTL_MS = 60 * 1000;

class ModelProxy {
  constructor({ modelService, clock = null, logger = null, ttlMs = DEFAULT_TTL_MS, maxBodyBytes = 1024 * 1024 } = {}) {
    if (!modelService) throw new Error("ModelProxy 需要 ModelService");
    this.modelService = modelService;
    this.clock = typeof clock === "function" ? clock : null;
    this.logger = logger;
    this.ttlMs = ttlMs;
    this.maxBodyBytes = maxBodyBytes;
    this.capabilities = new Map();
    this.server = null;
    this.baseUrl = null;
  }
  #now() { return this.clock ? this.clock() : Date.now(); }

  issueCapability({ context, configId, allowedCapabilities = ["chat"], maxCalls = 1, ttlMs = this.ttlMs } = {}) {
    const resolved = this.modelService.resolveModel({ context, configId, capability: allowedCapabilities[0] || "chat" });
    if (!resolved.ok) return resolved;
    const token = "mpx_" + crypto.randomBytes(24).toString("base64url");
    const cap = {
      capabilityId: "mcap_" + crypto.randomBytes(8).toString("base64url"),
      token,
      nonce: crypto.randomBytes(8).toString("base64url"),
      userId: resolved.snapshot && resolved.snapshot.userId ? resolved.snapshot.userId : null,
      sessionRef: context.sessionRef,
      appId: context.appId,
      modelConfigId: configId || resolved.snapshot.modelConfigId,
      modelConfigVersion: resolved.snapshot.modelConfigVersion,
      allowedCapabilities: [...allowedCapabilities],
      maxCalls: Math.max(1, Number(maxCalls) || 1),
      remaining: Math.max(1, Number(maxCalls) || 1),
      state: CAP_STATE.ISSUED,
      issuedAt: this.#now(),
      expiresAt: this.#now() + Math.max(1, Number(ttlMs) || this.ttlMs),
    };
    this.capabilities.set(token, cap);
    return { ok: true, capability: { capabilityId: cap.capabilityId, token, expiresAt: cap.expiresAt, maxCalls: cap.maxCalls, modelConfigId: cap.modelConfigId, modelConfigVersion: cap.modelConfigVersion } };
  }

  revokeCapability(token) { const c = this.capabilities.get(String(token || "")); if (!c) return { ok: true, changed: false }; c.state = CAP_STATE.REVOKED; return { ok: true, changed: true }; }

  #check(req) {
    const auth = String((req.headers && req.headers.authorization) || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return { ok: false, status: 401, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    const cap = this.capabilities.get(token);
    if (!cap) return { ok: false, status: 401, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    if (cap.state === CAP_STATE.REVOKED) return { ok: false, status: 401, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED };
    if (this.#now() >= cap.expiresAt) { cap.state = CAP_STATE.EXPIRED; return { ok: false, status: 401, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED }; }
    if (cap.remaining <= 0) { cap.state = CAP_STATE.EXHAUSTED; return { ok: false, status: 429, error: domain.ERROR_CODE.PROXY_UNAUTHORIZED, detail: "CAPABILITY_EXHAUSTED" }; }
    cap.remaining -= 1; // 单线程事件循环内原子消费
    cap.state = CAP_STATE.ACTIVE;
    return { ok: true, cap };
  }

  async start() {
    if (this.server) return { baseUrl: this.baseUrl };
    this.server = http.createServer((req, res) => { void this.#handle(req, res); });
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    const port = this.server.address().port;
    this.baseUrl = "http://127.0.0.1:" + port;
    return { baseUrl: this.baseUrl, port };
  }
  async stop() { if (!this.server) return; const s = this.server; this.server = null; this.baseUrl = null; this.capabilities.clear(); await new Promise((r) => s.close(r)); }

  async #handle(req, res) {
    const send = (status, obj) => { if (res.writableEnded || res.destroyed) return; res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return send(404, { ok: false, error: "NOT_FOUND" });
    const check = this.#check(req);
    if (!check.ok) return send(check.status, { ok: false, error: check.error, detail: check.detail || null });
    const cap = check.cap;
    let raw = ""; let tooBig = false;
    await new Promise((resolve) => {
      req.on("data", (d) => { raw += d; if (raw.length > this.maxBodyBytes) { tooBig = true; req.destroy(); } });
      req.on("end", resolve); req.on("close", resolve);
    });
    if (tooBig) return send(413, { ok: false, error: domain.ERROR_CODE.INVALID_INPUT });
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { return send(400, { ok: false, error: domain.ERROR_CODE.INVALID_INPUT }); }
    const capability = String(body.capability || cap.allowedCapabilities[0] || "chat");
    if (!cap.allowedCapabilities.includes(capability)) return send(403, { ok: false, error: domain.ERROR_CODE.CAPABILITY_UNAVAILABLE });
    const context = { sessionRef: cap.sessionRef, appId: cap.appId };
    const resolved = this.modelService.resolveModel({ context, configId: cap.modelConfigId, capability });
    if (!resolved.ok) return send(403, { ok: false, error: resolved.error });
    // config version 变化 → 旧 capability 不再继续请求
    if (cap.modelConfigVersion != null && resolved.snapshot.modelConfigVersion !== cap.modelConfigVersion) return send(403, { ok: false, error: domain.ERROR_CODE.MODEL_CONFIG_UNAVAILABLE, detail: "STALE_CAPABILITY" });
    // 客户端断开（D4-02B cancel）→ 取消在途 Provider 调用，关闭上游连接；不 retry。
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(new Error("client-cancelled")); });
    const result = await this.modelService.chat({ context, configId: cap.modelConfigId, capability, messages: Array.isArray(body.messages) ? body.messages : [], tools: body.tools || null, params: body.params || {}, stream: false, requestId: body.requestId || null, signal: controller.signal });
    if (!result.ok) return send(403, { ok: false, error: result.error });
    return send(200, { ok: true, requestId: result.requestId, text: result.text, toolCalls: result.toolCalls, usage: result.usage, snapshot: result.snapshot });
  }
}

module.exports = { ModelProxy, CAP_STATE };
