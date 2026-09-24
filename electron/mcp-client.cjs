/**
 * D5-03 第一批 · 最小 MCP 客户端（JSON-RPC 2.0；stdio + streamable HTTP）。
 *
 * 只实现「连接 + 能力发现」需要的方法：
 *   initialize → notifications/initialized → tools/list（分页有界）。
 * **不实现 tools/call**：本类没有可用的调用路径，callTool() 明确返回
 * MCP_TOOL_INVOCATION_NOT_ENABLED（第一批不开放工具调用）。
 *
 * 约定：
 *   · 子进程只用受控 launcher 启动（createMcpStdioLauncher）：纯 Node 走 child_process；
 *     Electron main 走 child_process + 子进程 ELECTRON_RUN_AS_NODE=1（官方"以 Node 运行"
 *     模式），因为 utilityProcess 句柄没有 stdin、跑不了 stdio 握手（D5-03-D2 实测）。
 *     绝不把 Electron 当 app main 启动；entry/args/env 仍由 mcp-domain 白名单固定映射；
 *   · 每个请求都有超时；close() 一定回收子进程与在途请求（fail-closed，不悬挂）；
 *   · 服务端真实返回的 protocolVersion / serverInfo / capabilities / tools 原样上报，
 *     协议版本不支持时明确报错 —— 不假装成功。
 */
"use strict";

const domain = require("./mcp-domain.cjs");
const { createMcpStdioLauncher } = require("./executor-launcher.cjs");

const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_MAX_TOOLS = 200;
const DEFAULT_MAX_PAGES = 10;
const MAX_BODY_BYTES = 1024 * 1024;
const STDERR_KEEP = 4096;
const CLOSE_GRACE_MS = 800;

function normalizeServerInfo(raw) {
  if (!raw || typeof raw !== "object") return { name: null, version: null };
  return { name: raw.name == null ? null : String(raw.name).slice(0, 120), version: raw.version == null ? null : String(raw.version).slice(0, 60) };
}

/** SSE（text/event-stream）响应体 → JSON-RPC 消息数组。streamable HTTP 允许单响应走 SSE。 */
function parseSse(text) {
  const out = [];
  for (const block of String(text || "").split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* 非 JSON 的 data 行忽略：协议错误由"没有匹配响应"兜底成 MCP_PROTOCOL_ERROR */
    }
  }
  return out;
}

class McpClient {
  constructor({ launcher = null, fetchImpl = null, clock = null, logger = null, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, maxTools = DEFAULT_MAX_TOOLS, maxPages = DEFAULT_MAX_PAGES, clientName = "openarc-mcp-center", clientVersion = "0.1.0" } = {}) {
    this.launcher = launcher;
    this.fetchImpl = fetchImpl || (typeof fetch === "function" ? fetch : null);
    this.clock = typeof clock === "function" ? clock : () => Date.now();
    this.logger = logger;
    this.requestTimeoutMs = Number(requestTimeoutMs) > 0 ? Number(requestTimeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxTools = Number(maxTools) > 0 ? Number(maxTools) : DEFAULT_MAX_TOOLS;
    this.maxPages = Number(maxPages) > 0 ? Number(maxPages) : DEFAULT_MAX_PAGES;
    this.clientName = String(clientName);
    this.clientVersion = String(clientVersion);
    this.state = "idle";
    this.child = null;
    this.stdioBuffer = "";
    this.stderr = "";
    this.pending = new Map();
    this.seq = 0;
    this.http = null;
    this.inflight = null;
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

  #onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (slot.timer) clearTimeout(slot.timer);
      slot.settle(this.#fromMessage(msg));
      return;
    }
    if (msg.id != null && msg.method) {
      // 服务端 → 客户端请求（sampling / roots / elicitation）：本批不实现，回错误而不是悬挂。
      this.unsupportedServerRequests += 1;
      this.#write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (msg.method) this.notifications.push(String(msg.method).slice(0, 80));
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
    this.http = { url: url.toString(), sessionId: null, authMode: authMode === domain.AUTH_MODE.BEARER ? domain.AUTH_MODE.BEARER : domain.AUTH_MODE.NONE };
    return { ok: true };
  }

  /** streamable HTTP 单响应：一个 POST 携带一条消息，响应是 JSON 或单条 SSE。 */
  async #httpPost(payload, { signal = null, timeoutMs = this.requestTimeoutMs, expectResponse = true } = {}) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.http.authMode === domain.AUTH_MODE.BEARER && this.secret) headers.authorization = "Bearer " + this.secret;
    if (this.http.sessionId) headers["mcp-session-id"] = this.http.sessionId;
    if (this.negotiatedProtocolVersion) headers["mcp-protocol-version"] = this.negotiatedProtocolVersion;
    const controller = new AbortController();
    let timedOut = false;
    const onOuterAbort = () => { try { controller.abort(); } catch { /* ignore */ } };
    if (signal) {
      if (signal.aborted) onOuterAbort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; try { controller.abort(); } catch { /* ignore */ } }, Math.max(1, timeoutMs));
    if (typeof timer.unref === "function") timer.unref();
    this.inflight = controller;
    try {
      const res = await this.fetchImpl(this.http.url, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal, redirect: "error" });
      const sessionId = res.headers && typeof res.headers.get === "function" ? res.headers.get("mcp-session-id") : null;
      if (sessionId) this.http.sessionId = String(sessionId);
      if (res.status === 202 || res.status === 204) return { ok: true, empty: true, status: res.status };
      if (!res.ok) return { ok: false, error: domain.normalizeError({ status: Number(res.status) || 0 }), status: Number(res.status) || 0 };
      const text = await res.text();
      if (String(text).length > MAX_BODY_BYTES) return { ok: false, error: domain.ERROR_CODE.MCP_PROTOCOL_ERROR, detail: "body-too-large" };
      if (!expectResponse) return { ok: true, empty: true, status: res.status };
      const contentType = res.headers && typeof res.headers.get === "function" ? String(res.headers.get("content-type") || "") : "";
      let messages;
      if (contentType.includes("text/event-stream")) {
        messages = parseSse(text);
        if (!messages.length) return { ok: false, error: domain.ERROR_CODE.MCP_PROTOCOL_ERROR, detail: "empty-sse" };
      } else {
        try {
          messages = [JSON.parse(String(text) || "{}")];
        } catch {
          return { ok: false, error: domain.ERROR_CODE.MCP_PROTOCOL_ERROR, detail: "invalid-json" };
        }
      }
      const match = messages.find((m) => m && (m.id === payload.id || (payload.id == null && m.method === undefined))) || (payload.id == null ? messages[0] : null);
      if (!match) return { ok: false, error: domain.ERROR_CODE.MCP_PROTOCOL_ERROR, detail: "no-matching-response" };
      return { ok: true, message: match };
    } catch (err) {
      if (timedOut) return { ok: false, error: domain.ERROR_CODE.MCP_TIMEOUT };
      if (signal && signal.aborted) return { ok: false, error: domain.ERROR_CODE.MCP_TIMEOUT, detail: "cancelled" };
      return { ok: false, error: domain.normalizeError({ kind: "unreachable" }), detail: domain.redactSecrets(String((err && err.message) || "network"), [this.secret]) };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
      this.inflight = null;
    }
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  async connect({ transport, endpoint, credentialSecret = null, authMode = domain.AUTH_MODE.NONE, signal = null } = {}) {
    if (this.state === "open") await this.close();
    this.state = "connecting";
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
    return { ok: true, transport: transport === domain.TRANSPORT.STDIO ? domain.TRANSPORT.STDIO : domain.TRANSPORT.HTTP };
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
    if (this.inflight) {
      try { this.inflight.abort(); } catch { /* ignore */ }
      this.inflight = null;
    }
    const child = this.child;
    this.child = null;
    this.secret = null;
    this.http = null;
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
    if (this.state !== "open") return Promise.resolve({ ok: false, error: domain.ERROR_CODE.MCP_UNREACHABLE, detail: "transport-closed" });
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

  /**
   * 第一批**不开放工具调用**：没有 tools/call 传输实现，入口一律明确拒绝。
   * 留这个方法是为了让"调用入口"有一个可断言的拒绝点，而不是缺席后靠猜。
   */
  callTool() {
    return { ok: false, error: domain.ERROR_CODE.MCP_TOOL_INVOCATION_NOT_ENABLED };
  }

  /** 诊断投影：绝不含 secret / endpoint 凭据。 */
  diagnostics() {
    return {
      state: this.state,
      transport: this.http ? domain.TRANSPORT.HTTP : domain.TRANSPORT.STDIO,
      pending: this.pending.size,
      unsupportedServerRequests: this.unsupportedServerRequests,
      stderr: domain.redactSecrets(this.stderr || "", [this.secret]),
      protocolVersion: this.negotiatedProtocolVersion,
      notifications: this.notifications.slice(-10),
    };
  }
}

module.exports = { McpClient, parseSse, normalizeServerInfo, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_MAX_PAGES, DEFAULT_MAX_TOOLS, MAX_BODY_BYTES };
