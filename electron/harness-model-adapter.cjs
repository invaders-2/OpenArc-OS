/**
 * D4-02B · OpenArc Harness Model Adapter。
 *
 * 唯一的职责：把 Harness（pi-ai openai-completions，SSE）的模型请求，
 * 转成对 **OpenArc Model Proxy** 的一次请求（非流式 JSON），再把结果转回
 * OpenAI SSE chunk。它**不**实现 Provider auth / routing / retry / SSRF /
 * Credential Store —— 那些全部属于 D4-01。
 *
 * 链路：Harness → 本 Adapter → OpenArc Model Proxy → Provider。
 * Provider Secret 永不进入本进程；它只经 Proxy 内部解析。
 */
"use strict";
const http = require("node:http");

const ERROR = Object.freeze({
  NO_PROXY: "HARNESS_MODEL_PROXY_UNAVAILABLE",
  PROXY_ERROR: "HARNESS_MODEL_PROXY_ERROR",
  BAD_REQUEST: "HARNESS_MODEL_BAD_REQUEST",
});

class HarnessModelAdapter {
  constructor({ modelProxy, logger = null, clock = null, expectedToken = null, requestId = null } = {}) {
    if (!modelProxy) throw new Error("HarnessModelAdapter 需要 ModelProxy");
    this.modelProxy = modelProxy;
    // run 级执行绑定：只接受本 run 签发的 capability，Harness A 的 token 不能用于 Harness B。
    this.expectedToken = expectedToken;
    // OpenArc 生成的 correlation id：与 taskId/stepId/runId 绑定，不由 Harness 自报。
    this.requestId = requestId;
    this.logger = logger;
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.server = null;
    this.baseUrl = null;
    this.stats = { requests: 0, ok: 0, failed: 0 };
  }

  async start() {
    if (this.server) return { baseUrl: this.baseUrl };
    this.server = http.createServer((req, res) => { void this.#handle(req, res); });
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    const port = this.server.address().port;
    this.baseUrl = "http://127.0.0.1:" + port + "/v1";
    return { baseUrl: this.baseUrl, port };
  }

  async stop() {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.baseUrl = null;
    await new Promise((r) => s.close(r));
  }

  async #handle(req, res) {
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method !== "POST" || (req.url !== "/v1/chat/completions" && req.url !== "/chat/completions")) return send(404, { ok: false, error: "NOT_FOUND" });
    const started = this.clock();
    let raw = "";
    await new Promise((resolve) => { req.on("data", (d) => { raw += d; if (raw.length > 4 * 1024 * 1024) req.destroy(); }); req.on("end", resolve); req.on("close", resolve); });
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { return send(400, { error: { message: "invalid json" } }); }
    const auth = req.headers.authorization || "";
    if (this.expectedToken && auth !== "Bearer " + this.expectedToken) { this.stats.failed += 1; return send(401, { error: { message: "CAPABILITY_NOT_BOUND" } }); }
    const proxyUrl = this.modelProxy && this.modelProxy.baseUrl;
    if (!proxyUrl) { this.stats.failed += 1; return send(503, { error: { message: ERROR.NO_PROXY } }); }
    // 客户端（Harness）断开 → 取消对 Model Proxy 的在途请求，进而取消 Provider 调用；不 retry。
    const controller = new AbortController();
    res.on("close", () => { if (!res.writableEnded) controller.abort(new Error("harness-cancelled")); });
    let upstream;
    try {
      upstream = await fetch(proxyUrl + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ messages: Array.isArray(body.messages) ? body.messages : [], tools: body.tools || null, params: body.params || {}, requestId: this.requestId || body.requestId || null }),
        signal: controller.signal,
      });
    } catch {
      this.stats.failed += 1;
      if (controller.signal.aborted) { try { res.destroy(); } catch { /* ignore */ } return; }
      return send(502, { error: { message: ERROR.PROXY_ERROR } });
    }
    const json = await upstream.json().catch(() => ({ ok: false, error: ERROR.PROXY_ERROR }));
    this.stats.requests += 1;
    if (!json.ok) this.stats.failed += 1; else this.stats.ok += 1;
    // 只记录安全 metadata：method / status / error code / timing。绝不记录 prompt / transcript。
    this.logger?.log?.({ event: "harness-model-adapter", result: json.ok ? "ALLOW" : "DENY", error_code: json.error || null, duration_ms: this.clock() - started, detail: { upstream: upstream.status } });

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const model = typeof body.model === "string" ? body.model : "openarc";
    const base = { id: "chatcmpl_openarc_" + this.clock().toString(36), object: "chat.completion.chunk", created: Math.floor(this.clock() / 1000), model };
    const chunk = (delta, finish, usage) => { const o = { ...base, choices: [{ index: 0, delta, finish_reason: finish }] }; if (usage) o.usage = usage; res.write("data: " + JSON.stringify(o) + "\n\n"); };
    if (!json.ok) {
      // 错误经 SSE 以 finish chunk 交付，pi-ai 会映射为 error finish，不做 transport 级重试。
      chunk({ role: "assistant", content: "OpenArc Model Proxy error: " + String(json.error || ERROR.PROXY_ERROR) }, null);
      chunk({}, "error");
      res.write("data: [DONE]\n\n"); res.end(); return;
    }
    chunk({ role: "assistant", content: json.text || "" }, null);
    const toolCalls = Array.isArray(json.toolCalls) ? json.toolCalls : null;
    if (toolCalls && toolCalls.length) {
      chunk({ tool_calls: toolCalls.map((t, i) => ({ index: i, id: t.id || ("call_" + i), type: "function", function: { name: t.function?.name || "", arguments: t.function?.arguments || "{}" } })) }, null);
      chunk({}, "tool_calls");
    } else {
      const u = json.usage || {};
      chunk({}, "stop", { prompt_tokens: u.inputTokens ?? 0, completion_tokens: u.outputTokens ?? 0, total_tokens: u.totalTokens ?? 0 });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

module.exports = { HarnessModelAdapter, HARNESS_MODEL_ADAPTER_ERROR: ERROR };
