/**
 * D5-03 第一批 · 最小 MCP 客户端（JSON-RPC 2.0；stdio + streamable HTTP）。
 *
 * 连接与能力发现：initialize → notifications/initialized → tools/list（分页有界）。
 * tools/call：**默认关闭**。callTool() 只有在两个条件同时成立时才发起真实请求：
 *   1) 构造时注入的 invocationGate() === true（= <userData>/dxos/mcp.json 的显式开关）；
 *   2) 本次调用带显式审批凭证 authorization.approval.decision === "ALLOWED"。
 * 任一条件不满足一律 fail closed 返回既有的 MCP_TOOL_INVOCATION_NOT_ENABLED
 * （形状与 D5-03 第一批完全一致，未注入 gate 的客户端行为逐字不变）。
 *
 * 约定：
 *   · 子进程只用受控 launcher 启动（createMcpStdioLauncher）：纯 Node 走 child_process；
 *     Electron main 走 child_process + 子进程 ELECTRON_RUN_AS_NODE=1（官方"以 Node 运行"
 *     模式），因为 utilityProcess 句柄没有 stdin、跑不了 stdio 握手（D5-03-D2 实测）。
 *     绝不把 Electron 当 app main 启动；entry/args/env 仍由 mcp-domain 白名单固定映射；
 *   · 每个请求都有超时；close() 一定回收子进程与在途请求（fail-closed，不悬挂）；
 *   · 服务端真实返回的 protocolVersion / serverInfo / capabilities / tools 原样上报，
 *     协议版本不支持时明确报错 —— 不假装成功。
 *
 * D5-03 第三批（streamable HTTP 流式收口；协议版本仍是 2025-06-18）：
 *   · POST 响应体按 SSE 帧增量解析，**收到与请求 id 匹配的响应立即完成该请求**：
 *     服务端之后继续推通知也不会把请求挂住（这正是第一批 res.text() 的真实缺陷）；
 *   · 单个事件大小有上界（MCP_STREAM_EVENT_TOO_LARGE），不无限缓冲；流在匹配响应前
 *     结束/中断一律 MCP_STREAM_INTERRUPTED —— 请求级绝不自动重发（决定权交回调用方）；
 *   · GET server→client 流：405/404/501/非 event-stream 只是"服务端不支持"，POST 连接照常可用；
 *     支持时有界接收 + 有界退避重连；
 *   · 只有服务端给了 id: 才记 Last-Event-ID 并在重连时发送；没有 id 就不续传、不重放；
 *     同一 (流, id) 的重复事件去重；
 *   · 会话失效（404 / 明确 session 信号）：abort 在途请求与 GET 流，清 session，如实上报。
 */
"use strict";

const domain = require("./mcp-domain.cjs");
const { createMcpStdioLauncher } = require("./executor-launcher.cjs");

const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_MAX_TOOLS = 200;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
const DEFAULT_MAX_STREAM_BYTES = 4 * 1024 * 1024;
const DEFAULT_STREAM_RECONNECT_ATTEMPTS = 3;
const DEFAULT_STREAM_RECONNECT_BACKOFF_MS = 50;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SEEN_EVENT_IDS = 128;
const MAX_NOTIFICATIONS_KEPT = 20;
const STDERR_KEEP = 4096;
const CLOSE_GRACE_MS = 800;
/** GET 返回这些状态 = 服务端不支持 server→client 流；连接（POST）保持可用。 */
const STREAM_UNSUPPORTED_STATUS = Object.freeze([404, 405, 501]);

function normalizeServerInfo(raw) {
  if (!raw || typeof raw !== "object") return { name: null, version: null };
  return { name: raw.name == null ? null : String(raw.name).slice(0, 120), version: raw.version == null ? null : String(raw.version).slice(0, 60) };
}

/**
 * 增量 SSE 帧解析器（跨 chunk 半包靠 feed() 状态拼接）。
 * 只有带 data 的事件才产出；注释（:）/保活行忽略；id 为空表示重置（不续传）。
 */
class SseParser {
  constructor({ maxEventBytes = DEFAULT_MAX_EVENT_BYTES } = {}) {
    this.maxEventBytes = Number(maxEventBytes) > 0 ? Number(maxEventBytes) : DEFAULT_MAX_EVENT_BYTES;
    this.buffer = "";
    this.data = [];
    this.dataBytes = 0;
    this.event = null;
    this.id = null;
    this.lastEventId = null;
    this.error = null;
  }

  /** 喂一段解码后的文本，返回本次完整事件（可能 0 个）。超界时置 this.error。 */
  feed(chunk) {
    const events = [];
    if (this.error) return events;
    this.buffer += String(chunk == null ? "" : chunk);
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#line(line, events);
      if (this.error) return events;
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxEventBytes) this.error = domain.ERROR_CODE.MCP_STREAM_EVENT_TOO_LARGE;
    return events;
  }

  /** 流结束：按 SSE 规范丢弃未以空行收尾的半个事件（半包不算响应）。 */
  end() {
    this.buffer = "";
    this.data = [];
    this.dataBytes = 0;
    this.event = null;
    this.id = null;
  }

  #line(line, events) {
    if (line === "") {
      if (this.data.length) events.push({ event: this.event, data: this.data.join("\n"), id: this.id, lastEventId: this.lastEventId });
      this.data = [];
      this.dataBytes = 0;
      this.event = null;
      this.id = null;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") { this.event = value; return; }
    if (field === "data") {
      this.dataBytes += Buffer.byteLength(value, "utf8");
      if (this.dataBytes > this.maxEventBytes) { this.error = domain.ERROR_CODE.MCP_STREAM_EVENT_TOO_LARGE; return; }
      this.data.push(value);
      return;
    }
    if (field === "id") {
      if (value.includes("\u0000")) return;
      this.id = value;
      this.lastEventId = value === "" ? null : value;
    }
  }
}

/** 兼容旧入口：整段文本 → JSON-RPC 消息数组（仍用于批处理与故障注入）。 */
function parseSse(text) {
  const parser = new SseParser({ maxEventBytes: Number.MAX_SAFE_INTEGER });
  const out = [];
  for (const evt of parser.feed(String(text == null ? "" : text) + "\n\n")) {
    try {
      out.push(JSON.parse(evt.data));
    } catch {
      /* 非 JSON 的 data 行忽略：协议错误由"没有匹配响应"兜底 */
    }
  }
  return out;
}

class McpClient {
  constructor({ launcher = null, fetchImpl = null, clock = null, logger = null, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, maxTools = DEFAULT_MAX_TOOLS, maxPages = DEFAULT_MAX_PAGES, maxEventBytes = DEFAULT_MAX_EVENT_BYTES, maxStreamBytes = DEFAULT_MAX_STREAM_BYTES, streamReconnectAttempts = DEFAULT_STREAM_RECONNECT_ATTEMPTS, streamReconnectBackoffMs = DEFAULT_STREAM_RECONNECT_BACKOFF_MS, invocationGate = null, clientName = "openarc-mcp-center", clientVersion = "0.1.0" } = {}) {
    this.launcher = launcher;
    /** 显式开关端口（()=>boolean）。未注入 = 永远关闭：callTool() 不发出任何请求。 */
    this.invocationGate = typeof invocationGate === "function" ? invocationGate : null;
    this.fetchImpl = fetchImpl || (typeof fetch === "function" ? fetch : null);
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    this.requestTimeoutMs = Number(requestTimeoutMs) > 0 ? Number(requestTimeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxTools = Number(maxTools) > 0 ? Number(maxTools) : DEFAULT_MAX_TOOLS;
    this.maxPages = Number(maxPages) > 0 ? Number(maxPages) : DEFAULT_MAX_PAGES;
    this.maxEventBytes = Number(maxEventBytes) > 0 ? Number(maxEventBytes) : DEFAULT_MAX_EVENT_BYTES;
    this.maxStreamBytes = Number(maxStreamBytes) > 0 ? Number(maxStreamBytes) : DEFAULT_MAX_STREAM_BYTES;
    this.streamReconnectAttempts = Number.isFinite(Number(streamReconnectAttempts)) && Number(streamReconnectAttempts) >= 0 ? Number(streamReconnectAttempts) : DEFAULT_STREAM_RECONNECT_ATTEMPTS;
    this.streamReconnectBackoffMs = Number.isFinite(Number(streamReconnectBackoffMs)) && Number(streamReconnectBackoffMs) >= 0 ? Number(streamReconnectBackoffMs) : DEFAULT_STREAM_RECONNECT_BACKOFF_MS;
    this.clientName = String(clientName);
    this.clientVersion = String(clientVersion);
    this.state = "idle";
    this.transport = null;
    this.child = null;
    this.stdioBuffer = "";
    this.stderr = "";
    this.pending = new Map();
    this.seq = 0;
    this.http = null;
    /** 所有在途 HTTP 请求（POST）的 AbortController；close()/会话失效时一并 abort。 */
    this.controllers = new Set();
    /** 后台任务（例如代服务端请求回 -32601 的 POST）：close() 时 abort 并有界等待。 */
    this.background = new Set();
    this.streamTask = null;
    this.sessionExpired = false;
    /** 服务层注入：会话失效时同步收敛连接状态（不依赖下一次 IPC 才发现）。 */
    this.onSessionInvalid = null;
    this.seenEventIds = new Set();
    this.seenEventQueue = [];
    this.sseEvents = 0;
    this.duplicateEvents = 0;
    this.malformedEvents = 0;
    this.unsupportedServerRequests = 0;
    this.notifications = [];
    this.negotiatedProtocolVersion = null;
    this.serverInfo = { name: null, version: null };
    this.capabilities = {};
    /** BEARER secret 只活在客户端内存里；投影/诊断一律经过它脱敏。 */
    this.secret = null;
  }

  // ---------------------------------------------------------------------------
  // 传输
  // ---------------------------------------------------------------------------

  /** stdio：受控 launcher 启动白名单程序（entry/args 来自主进程映射，不来自渲染层；需要真 stdin）。 */
  #openStdio({ endpoint }) {
    if (!endpoint || !endpoint.entry) return { ok: false, error: domain.ERROR_CODE.MCP_LOCAL_SERVER_NOT_ALLOWED };
    const launcher = this.launcher || createMcpStdioLauncher();
    if (!launcher || launcher.available === false) return { ok: false, error: domain.ERROR_CODE.MCP_UNREACHABLE, detail: "launcher-unavailable" };
    let handle;
    try {
      handle = launcher.launch({ entry: endpoint.entry, args: Array.isArray(endpoint.args) ? [...endpoint.args] : [], env: domain.localServerEnv() });
    } catch {
      return { ok: false, error: domain.ERROR_CODE.MCP_UNREACHABLE, detail: "spawn-failed" };
    }
    this.child = handle;
    this.stdioBuffer = "";
    this.stderr = "";
    handle.on("stdout", (chunk) => this.#onStdioData(chunk));
    handle.on("stderr", (chunk) => { this.stderr = (this.stderr + String(chunk)).slice(-STDERR_KEEP); });
    handle.on("error", () => this.#failAll(domain.ERROR_CODE.MCP_UNREACHABLE));
    handle.on("close", () => {
      if (this.state === "open") this.#failAll(domain.ERROR_CODE.MCP_UNREACHABLE);
    });
    return { ok: true };
  }

  #onStdioData(chunk) {
    this.stdioBuffer += String(chunk);
    let index = this.stdioBuffer.indexOf("\n");
    while (index >= 0) {
      const line = this.stdioBuffer.slice(0, index);
      this.stdioBuffer = this.stdioBuffer.slice(index + 1);
      this.#onStdioLine(line);
      index = this.stdioBuffer.indexOf("\n");
    }
    if (this.stdioBuffer.length > MAX_BODY_BYTES) this.stdioBuffer = "";
  }

  #onStdioLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // 非 JSON 行（服务端日志串到 stdout）不进协议状态
    }
    this.#onMessage(msg);
  }

  /** 消息分发：返回 "response" | "server-request" | "notification" | "ignored"。 */
  #onMessage(msg) {
    if (!msg || typeof msg !== "object") return "ignored";
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const slot = this.pending.get(msg.id);
      if (!slot) return "response";
      this.pending.delete(msg.id);
      if (slot.timer) clearTimeout(slot.timer);
      slot.settle(this.#fromMessage(msg));
      return "response";
    }
    if (msg.id != null && msg.method) {
      // 服务端 → 客户端请求（sampling / roots / elicitation）：本批不实现，回错误而不是悬挂。
      this.unsupportedServerRequests += 1;
      this.#respondServerRequest(msg);
      return "server-request";
    }
    if (msg.method) {
      this.notifications.push(String(msg.method).slice(0, 80));
      if (this.notifications.length > MAX_NOTIFICATIONS_KEPT) this.notifications.shift();
      return "notification";
    }
    return "ignored";
  }

  /** 服务端请求一律 -32601：stdio 直接写；HTTP 必须用新的 POST 回过去（否则服务端一直等）。 */
  #respondServerRequest(msg) {
    const payload = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
    if (!this.http) {
      this.#write(payload);
      return;
    }
    const task = this.#httpPost(payload, { expectResponse: false, timeoutMs: Math.min(this.requestTimeoutMs, 2000) })
      .catch(() => ({ ok: false }))
      .finally(() => { this.background.delete(task); });
    this.background.add(task);
  }

  #fromMessage(msg) {
    if (msg.error && typeof msg.error === "object") {
      return { ok: false, error: domain.normalizeError({ jsonrpcCode: Number(msg.error.code) }), jsonrpcCode: Number(msg.error.code) || null, detail: domain.redactSecrets(String(msg.error.message || ""), [this.secret]) };
    }
    return { ok: true, result: msg.result && typeof msg.result === "object" ? msg.result : {} };
  }

  #write(payload) {
    if (this.state !== "open") return { ok: false, error: domain.ERROR_CODE.MCP_UNREACHABLE, detail: "transport-closed" };
    if (this.http) return { ok: true };
    if (!this.child || !this.child.stdin || typeof this.child.stdin.write !== "function") return { ok: false, error: domain.ERROR_CODE.MCP_UNREACHABLE, detail: "stdin-unavailable" };
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n");
      return { ok: true };
    } catch {
      return { ok: false, error: domain.ERROR_CODE.MCP_UNREACHABLE, detail: "stdin-write-failed" };
    }
  }

  #openHttp({ endpoint, credentialSecret, authMode }) {
    let url;
    try {
      url = new URL(String(endpoint && endpoint.url));
    } catch {
      return { ok: false, error: domain.ERROR_CODE.MCP_ENDPOINT_BLOCKED };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: domain.ERROR_CODE.MCP_ENDPOINT_BLOCKED };
    if (!this.fetchImpl) return { ok: false, error: domain.ERROR_CODE.MCP_UNREACHABLE, detail: "fetch-unavailable" };
    this.secret = authMode === domain.AUTH_MODE.BEARER && credentialSecret ? String(credentialSecret) : null;
    this.http = {
      url: url.toString(),
      sessionId: null,
      authMode: authMode === domain.AUTH_MODE.BEARER ? domain.AUTH_MODE.BEARER : domain.AUTH_MODE.NONE,
      streamController: null,
      serverStream: {
        state: "idle",
        supported: null,
        status: 0,
        error: null,
        stopped: false,
        everOpen: false,
        reconnects: 0,
        lastEventId: null,
        lastEventAt: null,
      },
    };
    return { ok: true };
  }

  #authHeaders() {
    const headers = {};
    if (!this.http) return headers;
    if (this.http.authMode === domain.AUTH_MODE.BEARER && this.secret) headers.authorization = "Bearer " + this.secret;
    if (this.http.sessionId) headers["mcp-session-id"] = this.http.sessionId;
    if (this.negotiatedProtocolVersion) headers["mcp-protocol-version"] = this.negotiatedProtocolVersion;
    return headers;
  }

  async #readTextBounded(res, maxBytes) {
    const body = res && res.body;
    if (!body || typeof body[Symbol.asyncIterator] !== "function") {
      const text = res && typeof res.text === "function" ? await res.text() : "";
      return { ok: Buffer.byteLength(String(text), "utf8") <= maxBytes, text: String(text) };
    }
    const decoder = new TextDecoder("utf-8");
    let text = "";
    let bytes = 0;
    for await (const chunk of body) {
      bytes += Number(chunk && chunk.byteLength) || 0;
      if (bytes > maxBytes) return { ok: false, text: "" }; // 跳出即取消流，不无限缓冲
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  }

  /** 不读正文地释放响应体（202/204/不支持/无需响应）。 */
  #drain(res) {
    try {
      if (res && res.body && typeof res.body.cancel === "function") Promise.resolve(res.body.cancel()).catch(() => {});
    } catch {
      /* 已结束或不可取消 */
    }
  }

  /**
   * SSE 帧泵：把响应体按流读取、增量解析并逐事件回调；
   * onEvent 返回 true 表示"已满足，停止读取"（跳出 for-await 会取消响应体，请求立即释放）。
   * 网络/中止异常不在这里吞：由调用方按 timeout / close / session 分类（保证 MCP_TIMEOUT 语义不变）。
   */
  async #pumpEvents(res, { onEvent } = {}) {
    const parser = new SseParser({ maxEventBytes: this.maxEventBytes });
    const decoder = new TextDecoder("utf-8");
    const emit = (events) => {
      for (const evt of events) if (onEvent(evt) === true) return true;
      return false;
    };
    let bytes = 0;
    const body = res && res.body;
    if (body && typeof body[Symbol.asyncIterator] === "function") {
      for await (const chunk of body) {
        bytes += Number(chunk && chunk.byteLength) || 0;
        if (bytes > this.maxStreamBytes) return { error: domain.ERROR_CODE.MCP_STREAM_INTERRUPTED, detail: "stream-too-long" };
        if (emit(parser.feed(decoder.decode(chunk, { stream: true })))) return { stopped: true };
        if (parser.error) return { error: parser.error, detail: "event-too-large" };
      }
      if (emit(parser.feed(decoder.decode()))) return { stopped: true };
    } else {
      const text = res && typeof res.text === "function" ? await res.text() : "";
      if (emit(parser.feed(String(text) + "\n\n"))) return { stopped: true };
    }
    if (parser.error) return { error: parser.error, detail: "event-too-large" };
    return { ended: true };
  }

  /** 事件 → 去重 / 记 id / 分发。channel 用于隔离 POST 流与 GET 流的事件 id 空间。 */
  #acceptEvent(evt, channel) {
    const id = evt && evt.id != null ? String(evt.id) : null;
    if (id != null) {
      const key = channel + "\u0000" + id;
      if (this.seenEventIds.has(key)) {
        this.duplicateEvents += 1;
        return { status: "duplicate" };
      }
      this.seenEventIds.add(key);
      this.seenEventQueue.push(key);
      while (this.seenEventQueue.length > MAX_SEEN_EVENT_IDS) this.seenEventIds.delete(this.seenEventQueue.shift());
    }
    if (channel === "get" && this.http && evt.lastEventId != null) {
      // 只有服务端给过 id: 才记 —— 没 id 就没有可续传位置
      this.http.serverStream.lastEventId = String(evt.lastEventId);
      this.http.serverStream.lastEventAt = this.clock();
    }
    const data = String(evt && evt.data != null ? evt.data : "").trim();
    if (!data) return { status: "ignored" };
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      this.malformedEvents += 1;
      return { status: "malformed" };
    }
    this.sseEvents += 1;
    return { status: this.#onMessage(msg), message: msg };
  }

  /** POST 的 SSE 响应：只等与本次请求 id 匹配的响应，拿到即停。 */
  async #readResponseStream(res, payload) {
    let matched = null;
    const outcome = await this.#pumpEvents(res, {
      onEvent: (evt) => {
        const accepted = this.#acceptEvent(evt, "post");
        const msg = accepted.message;
        if (!msg || msg.id == null || msg.id !== payload.id) return false;
        if (msg.result === undefined && msg.error === undefined) return false;
        matched = msg;
        return true;
      },
    });
    if (matched) return { ok: true, message: matched };
    if (outcome.error) return { ok: false, error: outcome.error, detail: outcome.detail || null };
    return { ok: false, error: domain.ERROR_CODE.MCP_STREAM_INTERRUPTED, detail: "stream-ended-without-response" };
  }

  /** 4xx：先判"会话失效"（404 + 已有 session，或 400 + 明确 session 信号），其余按状态归一化。 */
  async #httpFailure(res) {
    const status = Number(res.status) || 0;
    const hadSession = !!(this.http && this.http.sessionId);
    if (hadSession && (status === 404 || status === 400)) {
      const read = await this.#readTextBounded(res, 4096);
      const body = read.ok ? read.text : "";
      const sessionSignal = status === 404 || /session/i.test(body);
      if (sessionSignal) {
        this.#invalidateSession("session-invalid", { status });
        return { ok: false, error: domain.ERROR_CODE.MCP_SESSION_EXPIRED, status, detail: "session-invalid" };
      }
    }
    this.#drain(res);
    return { ok: false, error: domain.normalizeError({ status }), status };
  }

  /** 会话失效：清 session、停 GET 流、abort 所有在途请求，并如实通知服务层。 */
  #invalidateSession(reason, { status = 0 } = {}) {
    if (this.sessionExpired) return;
    this.sessionExpired = true;
    if (this.http) {
      this.http.sessionId = null;
      const stream = this.http.serverStream;
      stream.error = domain.ERROR_CODE.MCP_SESSION_EXPIRED;
      stream.supported = false;
      stream.stopped = true;
      if (stream.state === "open" || stream.state === "interrupted" || stream.state === "idle") stream.state = "closed";
      if (this.http.streamController) { try { this.http.streamController.abort(); } catch { /* ignore */ } }
    }
    for (const controller of this.controllers) { try { controller.abort(); } catch { /* ignore */ } }
    this.#failAll(domain.ERROR_CODE.MCP_SESSION_EXPIRED, "session-invalid");
    try {
      if (typeof this.onSessionInvalid === "function") this.onSessionInvalid(domain.ERROR_CODE.MCP_SESSION_EXPIRED, { reason, status });
    } catch {
      /* 通知失败不改变"会话已失效"这个事实 */
    }
  }

  /** streamable HTTP：一个 POST 携带一条消息；响应是 JSON、单条 SSE，或长期不结束的 SSE 流。 */
  async #httpPost(payload, { signal = null, timeoutMs = this.requestTimeoutMs, expectResponse = true } = {}) {
    if (!this.http || this.state !== "open") {
      // 会话已失效时，后续请求如实回 MCP_SESSION_EXPIRED（不冒充普通不可达）
      return { ok: false, error: this.sessionExpired ? domain.ERROR_CODE.MCP_SESSION_EXPIRED : domain.ERROR_CODE.MCP_UNREACHABLE, detail: "transport-closed" };
    }
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.#authHeaders() };
    const controller = new AbortController();
    let timedOut = false;
    let streaming = false;
    const onOuterAbort = () => { try { controller.abort(); } catch { /* ignore */ } };
    if (signal) {
      if (signal.aborted) onOuterAbort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; try { controller.abort(); } catch { /* ignore */ } }, Math.max(1, timeoutMs));
    if (typeof timer.unref === "function") timer.unref();
    this.controllers.add(controller);
    try {
      const res = await this.fetchImpl(this.http.url, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal, redirect: "error" });
      const sessionId = res.headers && typeof res.headers.get === "function" ? res.headers.get("mcp-session-id") : null;
      if (sessionId) this.http.sessionId = String(sessionId);
      if (res.status === 202 || res.status === 204) { this.#drain(res); return { ok: true, empty: true, status: res.status }; }
      if (!res.ok) return await this.#httpFailure(res);
      const contentType = res.headers && typeof res.headers.get === "function" ? String(res.headers.get("content-type") || "") : "";
      if (!expectResponse) { this.#drain(res); return { ok: true, empty: true, status: res.status }; }
      if (contentType.includes("text/event-stream")) {
        streaming = true;
        return await this.#readResponseStream(res, payload);
      }
      const read = await this.#readTextBounded(res, MAX_BODY_BYTES);
      if (!read.ok) return { ok: false, error: domain.ERROR_CODE.MCP_PROTOCOL_ERROR, detail: "body-too-large" };
      let messages;
      try {
        messages = [JSON.parse(String(read.text) || "{}")];
      } catch {
        return { ok: false, error: domain.ERROR_CODE.MCP_PROTOCOL_ERROR, detail: "invalid-json" };
      }
      const match = messages.find((m) => m && (m.id === payload.id || (payload.id == null && m.method === undefined))) || (payload.id == null ? messages[0] : null);
      if (!match) return { ok: false, error: domain.ERROR_CODE.MCP_PROTOCOL_ERROR, detail: "no-matching-response" };
      return { ok: true, message: match };
    } catch (err) {
      if (this.sessionExpired) return { ok: false, error: domain.ERROR_CODE.MCP_SESSION_EXPIRED, detail: "session-invalid" };
      if (timedOut) return { ok: false, error: domain.ERROR_CODE.MCP_TIMEOUT };
      if (this.state !== "open") return { ok: false, error: domain.ERROR_CODE.MCP_STREAM_INTERRUPTED, detail: "connection-closed" };
      if (signal && signal.aborted) return { ok: false, error: domain.ERROR_CODE.MCP_TIMEOUT, detail: "cancelled" };
      const detail = domain.redactSecrets(String((err && err.message) || "network"), [this.secret]);
      if (streaming) return { ok: false, error: domain.ERROR_CODE.MCP_STREAM_INTERRUPTED, detail };
      return { ok: false, error: domain.normalizeError({ kind: "unreachable" }), detail };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
      this.controllers.delete(controller);
    }
  }

  // ---------------------------------------------------------------------------
  // GET server→client 流（有界接收 + 有界退避重连）
  // ---------------------------------------------------------------------------

  #streamAllowed() {
    return this.state === "open" && !!this.http && this.http.serverStream.stopped !== true && this.sessionExpired !== true;
  }

  #delay(ms) {
    return new Promise((resolve) => {
      let done = false;
      const controller = this.http && this.http.streamController;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (controller) controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(1, ms));
      if (typeof timer.unref === "function") timer.unref();
      if (controller) {
        if (controller.signal.aborted) return finish();
        controller.signal.addEventListener("abort", finish, { once: true });
      }
    });
  }

  /** 发一次 GET。只有 200 + text/event-stream 才算支持；其余按"不支持/鉴权/网络"分类。 */
  async #openStreamResponse({ reconnecting = false } = {}) {
    const headers = { accept: "text/event-stream", ...this.#authHeaders() };
    const lastEventId = this.http.serverStream.lastEventId;
    if (lastEventId) headers["last-event-id"] = lastEventId; // 无 id 就没有这个头（不续传、不重放）
    const controller = new AbortController();
    this.http.streamController = controller;
    let res;
    try {
      res = await this.fetchImpl(this.http.url, { method: "GET", headers, signal: controller.signal, redirect: "error" });
    } catch (err) {
      return { ok: false, unsupported: false, status: 0, error: this.sessionExpired ? domain.ERROR_CODE.MCP_SESSION_EXPIRED : domain.normalizeError({ kind: "unreachable" }), reason: "network", detail: domain.redactSecrets(String((err && err.message) || "network"), [this.secret]) };
    }
    const status = Number(res.status) || 0;
    if (STREAM_UNSUPPORTED_STATUS.includes(status)) {
      const hadStream = reconnecting || this.http.serverStream.everOpen === true;
      this.#drain(res);
      // 曾经跑通过又回 404：按 MCP 语义是会话失效，而不是"不支持"
      if (status === 404 && hadStream) {
        this.#invalidateSession("get-stream-session-invalid", { status });
        return { ok: false, unsupported: false, status, error: domain.ERROR_CODE.MCP_SESSION_EXPIRED, reason: "session-invalid" };
      }
      return { ok: false, unsupported: true, status, error: null, reason: "get-not-supported" };
    }
    if (status === 401 || status === 403) { this.#drain(res); return { ok: false, unsupported: false, status, error: domain.ERROR_CODE.MCP_AUTH_REQUIRED, reason: "auth" }; }
    if (!res.ok) { this.#drain(res); return { ok: false, unsupported: false, status, error: domain.normalizeError({ status }), reason: "http-" + status }; }
    const contentType = res.headers && typeof res.headers.get === "function" ? String(res.headers.get("content-type") || "") : "";
    if (!contentType.includes("text/event-stream")) { this.#drain(res); return { ok: false, unsupported: true, status, error: null, reason: "not-event-stream" }; }
    return { ok: true, res };
  }

  /** GET 流的接收循环：断开后有界退避重连；只在连接仍开启/未失效时进行。 */
  async #serveServerStream(initialRes) {
    const stream = this.http.serverStream;
    let res = initialRes;
    let attempt = 0;
    try {
      for (;;) {
        if (!this.#streamAllowed()) { stream.state = "closed"; return; }
        if (!res) {
          attempt += 1;
          if (attempt > this.streamReconnectAttempts) {
            stream.state = "unavailable";
            stream.error = stream.error || domain.ERROR_CODE.MCP_STREAM_INTERRUPTED;
            return;
          }
          await this.#delay(this.streamReconnectBackoffMs * attempt);
          if (!this.#streamAllowed()) { stream.state = "closed"; return; }
          const next = await this.#openStreamResponse({ reconnecting: true });
          if (!next.ok) {
            if (next.status) stream.status = next.status;
            if (next.unsupported) { stream.state = "unsupported"; stream.error = null; stream.supported = false; return; }
            if (next.error === domain.ERROR_CODE.MCP_SESSION_EXPIRED) { stream.state = "closed"; stream.error = domain.ERROR_CODE.MCP_SESSION_EXPIRED; return; }
            stream.state = "interrupted";
            stream.error = next.error || domain.ERROR_CODE.MCP_STREAM_INTERRUPTED;
            continue;
          }
          stream.reconnects += 1;
          stream.status = 200;
          stream.error = null;
          res = next.res;
        }
        stream.state = "open";
        stream.everOpen = true;
        let outcome;
        try {
          outcome = await this.#pumpEvents(res, { onEvent: (evt) => { this.#acceptEvent(evt, "get"); return false; } });
        } catch (err) {
          outcome = { error: this.sessionExpired ? domain.ERROR_CODE.MCP_SESSION_EXPIRED : domain.ERROR_CODE.MCP_STREAM_INTERRUPTED, detail: domain.redactSecrets(String((err && err.message) || "stream"), [this.secret]) };
        }
        res = null;
        if (!this.#streamAllowed()) { stream.state = "closed"; return; }
        if (this.sessionExpired || outcome.error === domain.ERROR_CODE.MCP_SESSION_EXPIRED) { stream.state = "closed"; stream.error = domain.ERROR_CODE.MCP_SESSION_EXPIRED; return; }
        stream.state = "interrupted";
        stream.error = outcome.error || domain.ERROR_CODE.MCP_STREAM_INTERRUPTED;
      }
    } catch {
      stream.state = "closed";
      stream.error = stream.error || domain.ERROR_CODE.MCP_STREAM_INTERRUPTED;
    }
  }

  /**
   * 建立 GET server→client 流（无 session 的 stdio 直接返回不支持）。
   * 返回 { ok, supported, status, error, reason }；服务端不支持绝不算连接失败，POST 照常可用。
   */
  async startServerStream() {
    if (!this.http) return { ok: true, supported: false, status: 0, error: null, reason: "transport-stdio" };
    if (this.state !== "open") return { ok: false, supported: false, status: 0, error: domain.ERROR_CODE.MCP_UNREACHABLE, reason: "transport-closed" };
    const stream = this.http.serverStream;
    if (stream.stopped) return { ok: false, supported: false, status: stream.status || 0, error: domain.ERROR_CODE.MCP_STREAM_INTERRUPTED, reason: "stopped" };
    if (stream.state === "open") return { ok: true, supported: true, status: 200, error: null, reason: "already-open" };
    const opened = await this.#openStreamResponse({ reconnecting: false });
    if (!opened.ok) {
      stream.status = opened.status || 0;
      stream.error = opened.error || null;
      stream.supported = false;
      stream.state = opened.unsupported ? "unsupported" : (opened.error === domain.ERROR_CODE.MCP_SESSION_EXPIRED ? "closed" : "unavailable");
      return { ok: true, supported: false, status: stream.status, error: stream.error, reason: opened.reason };
    }
    stream.supported = true;
    stream.status = 200;
    stream.error = null;
    stream.state = "open";
    const task = this.#serveServerStream(opened.res).catch(() => {});
    this.streamTask = task;
    return { ok: true, supported: true, status: 200, error: null, reason: "opened" };
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  async connect({ transport, endpoint, credentialSecret = null, authMode = domain.AUTH_MODE.NONE, signal = null } = {}) {
    if (this.state === "open") await this.close();
    this.state = "connecting";
    this.transport = transport === domain.TRANSPORT.STDIO ? domain.TRANSPORT.STDIO : domain.TRANSPORT.HTTP;
    this.sessionExpired = false;
    this.seenEventIds.clear();
    this.seenEventQueue = [];
    const open = transport === domain.TRANSPORT.STDIO ? this.#openStdio({ endpoint }) : this.#openHttp({ endpoint, credentialSecret, authMode });
    if (!open.ok) {
      this.state = "closed";
      return open;
    }
    if (signal && signal.aborted) {
      await this.close();
      return { ok: false, error: domain.ERROR_CODE.MCP_TIMEOUT, detail: "cancelled" };
    }
    this.state = "open";
    return { ok: true, transport: this.transport };
  }

  #failAll(code, detail = null) {
    for (const [id, slot] of this.pending.entries()) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.settle({ ok: false, error: code, detail });
      this.pending.delete(id);
    }
  }

  async close() {
    const wasOpen = this.state === "open";
    this.state = "closed";
    this.#failAll(domain.ERROR_CODE.MCP_UNREACHABLE, "transport-closed");
    if (this.http) {
      const stream = this.http.serverStream;
      stream.stopped = true;
      if (stream.state === "open" || stream.state === "interrupted" || stream.state === "idle") stream.state = "closed";
      if (this.http.streamController) { try { this.http.streamController.abort(); } catch { /* ignore */ } }
    }
    for (const controller of this.controllers) { try { controller.abort(); } catch { /* ignore */ } }
    this.controllers.clear();
    const streamTask = this.streamTask;
    const background = [...this.background];
    this.streamTask = null;
    const child = this.child;
    this.child = null;
    this.secret = null;
    // 在途流/后台任务有界等待：abort 后应当很快 settle，grace 只是最后兜底（绝不悬挂）。
    if (streamTask || background.length) {
      const grace = new Promise((resolve) => { const t = setTimeout(resolve, CLOSE_GRACE_MS); if (typeof t.unref === "function") t.unref(); });
      await Promise.race([Promise.allSettled([streamTask, ...background].filter(Boolean)), grace]);
    }
    if (child) {
      const alreadyExited = child.exitCode != null || child.signalCode != null;
      const closed = alreadyExited ? Promise.resolve() : new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        try { child.on("close", finish); } catch { finish(); }
        setTimeout(finish, CLOSE_GRACE_MS).unref?.();
      });
      /* 已经退出的子进程不再等 grace，否则 close() 会被无谓地拖慢 */
      try { if (child.stdin && typeof child.stdin.end === "function") child.stdin.end(); } catch { /* ignore */ }
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      await closed;
    }
    return { ok: true, closed: wasOpen };
  }

  // ---------------------------------------------------------------------------
  // 请求
  // ---------------------------------------------------------------------------

  #request(method, params = {}, { signal = null, timeoutMs = this.requestTimeoutMs, expectResponse = true } = {}) {
    if (this.state !== "open") return Promise.resolve({ ok: false, error: this.sessionExpired ? domain.ERROR_CODE.MCP_SESSION_EXPIRED : domain.ERROR_CODE.MCP_UNREACHABLE, detail: "transport-closed" });
    const id = ++this.seq;
    const payload = { jsonrpc: "2.0", id, method, params };
    if (this.http) return this.#httpPost(payload, { signal, timeoutMs, expectResponse }).then((res) => (res.ok ? (res.empty ? { ok: true, result: {} } : this.#fromMessage(res.message)) : res));
    return new Promise((resolve) => {
      let settled = false;
      let onAbort = null;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        settle({ ok: false, error: domain.ERROR_CODE.MCP_TIMEOUT });
      }, Math.max(1, timeoutMs));
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, { settle, timer });
      const written = this.#write(payload);
      if (!written.ok) {
        this.pending.delete(id);
        clearTimeout(timer);
        settle(written);
        return;
      }
      if (signal) {
        onAbort = () => {
          if (this.pending.delete(id)) clearTimeout(timer);
          settle({ ok: false, error: domain.ERROR_CODE.MCP_TIMEOUT, detail: "cancelled" });
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  #notify(method, params = {}, { signal = null } = {}) {
    if (this.state !== "open") return Promise.resolve({ ok: false, error: domain.ERROR_CODE.MCP_UNREACHABLE, detail: "transport-closed" });
    const payload = { jsonrpc: "2.0", method, params };
    if (this.http) return this.#httpPost(payload, { signal, expectResponse: false }).then((res) => (res.ok ? { ok: true } : res));
    return Promise.resolve(this.#write(payload));
  }

  /** initialize + notifications/initialized。返回服务端真实协商结果。 */
  async initialize({ signal = null, timeoutMs = this.requestTimeoutMs } = {}) {
    const res = await this.#request("initialize", { protocolVersion: domain.MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: this.clientName, version: this.clientVersion } }, { signal, timeoutMs });
    if (!res.ok) return res;
    const result = res.result || {};
    const version = domain.classifyProtocolVersion(result.protocolVersion);
    this.serverInfo = normalizeServerInfo(result.serverInfo);
    this.capabilities = domain.normalizeCapabilities(result.capabilities);
    this.negotiatedProtocolVersion = version.protocolVersion;
    if (!version.ok) {
      return { ok: false, error: version.error, protocolVersion: version.protocolVersion, serverInfo: this.serverInfo, capabilities: this.capabilities };
    }
    const notified = await this.#notify("notifications/initialized", {}, { signal });
    if (!notified.ok) return { ok: false, error: domain.ERROR_CODE.MCP_PROTOCOL_ERROR, detail: "initialized-notification-failed", protocolVersion: version.protocolVersion, serverInfo: this.serverInfo, capabilities: this.capabilities };
    return { ok: true, protocolVersion: version.protocolVersion, serverInfo: this.serverInfo, capabilities: this.capabilities };
  }

  /** tools/list 分页发现（页数与工具数都有界；截断如实上报 truncated）。 */
  async listTools({ signal = null, timeoutMs = this.requestTimeoutMs } = {}) {
    const collected = [];
    let cursor = null;
    let pages = 0;
    let truncated = false;
    while (pages < this.maxPages) {
      pages += 1;
      const res = await this.#request("tools/list", cursor ? { cursor } : {}, { signal, timeoutMs });
      if (!res.ok) return { ok: false, error: res.error, pages };
      const result = res.result || {};
      if (Array.isArray(result.tools)) collected.push(...result.tools);
      const next = result.nextCursor == null ? null : String(result.nextCursor);
      if (!next) break;
      cursor = next;
      if (pages >= this.maxPages) truncated = true;
    }
    const snapshot = domain.sanitizeTools(collected, { maxTools: this.maxTools });
    return { ok: true, tools: snapshot.tools, truncated: truncated || snapshot.truncated, pages, rawCount: collected.length, truncatedByTools: snapshot.truncated };
  }

  /** 开关真值：未注入 / 抛错 / 非严格 true 一律 false（fail closed）。 */
  #invocationEnabled() {
    if (typeof this.invocationGate !== "function") return false;
    try { return this.invocationGate() === true; } catch { return false; }
  }

  /** 双条件判据：显式开关开启 + 本次调用带"审批通过"凭证。 */
  #invocationAuthorized(authorization) {
    if (!this.#invocationEnabled()) return false;
    if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) return false;
    const approval = authorization.approval;
    if (!approval || typeof approval !== "object" || Array.isArray(approval)) return false;
    return String(approval.decision == null ? "" : approval.decision).toUpperCase() === "ALLOWED";
  }

  /**
   * tools/call（默认关闭的真实现）。两个条件不满足时同步返回**既有错误码**，不发起任何请求：
   *   开关未开 / 未注入 gate / 审批凭证缺失或非 ALLOWED → MCP_TOOL_INVOCATION_NOT_ENABLED。
   * 满足时发出 JSON-RPC tools/call，把服务端 result 原样投影（content / isError / structuredContent），
   * 协议错误照实回 { ok:false, error }。绝不伪造成功。
   *
   * @param {{name?:string, arguments?:object, signal?:AbortSignal, timeoutMs?:number}} params
   * @param {{approval?:{decision?:string}}|null} authorization 由审批链签发的凭证（调用方负责）
   */
  callTool(params = {}, authorization = null) {
    if (!this.#invocationAuthorized(authorization)) {
      // 与 D5-03 第一批逐字一致的拒绝形状（既有测试用 deepEqual 断言）。
      return { ok: false, error: domain.ERROR_CODE.MCP_TOOL_INVOCATION_NOT_ENABLED };
    }
    const name = params && typeof params.name === "string" ? params.name.trim() : "";
    if (!name) return { ok: false, error: domain.ERROR_CODE.MCP_INVALID_INPUT, detail: "toolName" };
    const args = params && params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    return this.#request("tools/call", { name, arguments: args }, { signal: (params && params.signal) || null, timeoutMs: (params && Number(params.timeoutMs) > 0 ? Number(params.timeoutMs) : this.requestTimeoutMs) })
      .then((res) => {
        if (!res || res.ok !== true) {
          return { ok: false, error: (res && res.error) || domain.ERROR_CODE.MCP_UNREACHABLE, detail: res && res.detail != null ? String(res.detail).slice(0, 300) : undefined };
        }
        const result = res.result && typeof res.result === "object" ? res.result : {};
        return {
          ok: true,
          content: Array.isArray(result.content) ? result.content : [],
          isError: result.isError === true,
          structuredContent: result.structuredContent === undefined ? null : result.structuredContent,
        };
      });
  }

  /** 诊断投影：绝不含 secret / endpoint 凭据；不含原始事件 id（只给"有没有"）。 */
  diagnostics() {
    const stream = this.http
      ? {
        state: this.http.serverStream.state,
        supported: this.http.serverStream.supported,
        status: this.http.serverStream.status,
        error: this.http.serverStream.error,
        reconnects: this.http.serverStream.reconnects,
        hasLastEventId: !!this.http.serverStream.lastEventId,
      }
      : null;
    return {
      state: this.state,
      transport: this.transport || (this.http ? domain.TRANSPORT.HTTP : domain.TRANSPORT.STDIO),
      pending: this.pending.size,
      inflightRequests: this.controllers.size,
      background: this.background.size,
      sessionExpired: this.sessionExpired,
      stream,
      events: { total: this.sseEvents, duplicates: this.duplicateEvents, malformed: this.malformedEvents },
      unsupportedServerRequests: this.unsupportedServerRequests,
      stderr: domain.redactSecrets(this.stderr || "", [this.secret]),
      protocolVersion: this.negotiatedProtocolVersion,
      notifications: this.notifications.slice(-10),
    };
  }
}

module.exports = { McpClient, SseParser, parseSse, normalizeServerInfo, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_MAX_PAGES, DEFAULT_MAX_TOOLS, MAX_BODY_BYTES, DEFAULT_MAX_EVENT_BYTES, DEFAULT_STREAM_RECONNECT_ATTEMPTS };
