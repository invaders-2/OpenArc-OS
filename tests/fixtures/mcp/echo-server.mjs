#!/usr/bin/env node
/**
 * D5-03 · 受控 MCP 测试服务（自建；不依赖任何第三方服务、只监听 127.0.0.1）。
 *
 * 两种传输：
 *   node echo-server.mjs --stdio
 *   node echo-server.mjs --http [--port=0]        （port=0 时把真实端口打到 stdout）
 *
 * 固定工具集：echo_sum / describe_self（--tool-count=N 另加合成工具，用于分页边界）。
 * **不实现 tools/call**：调用一律回 JSON-RPC -32601 —— 测试服务本身也不提供调用路径。
 *
 * 可控失败模式（供测试断言"失败要说出来"）：
 *   --auth-token=SECRET    HTTP：缺/错 Bearer → 401；stdio：initialize 回 AUTH 错误
 *   --no-response          收到请求后不回应（验证客户端有界超时）
 *   --protocol-version=X   initialize 回这个协议版本（验证客户端记录真实值/拒绝不支持版本）
 *   --tools-page-size=N    tools/list 分页
 *   --tool-count=N         工具总数
 *   --fail-tools-list      tools/list 回 JSON-RPC 错误
 *   --sse                  HTTP 响应走 text/event-stream 单事件（响应后立即结束）
 *   --require-session      HTTP：非 initialize 请求必须带 Mcp-Session-Id
 *
 * D5-03 第三批（streamable HTTP 流式收口）新增：
 *   --sse-stream               POST 的 SSE：先回响应事件，再持续推通知、永不结束
 *   --sse-notify-only          POST 的 SSE：只推通知，永不回匹配响应（验证有界超时）
 *   --sse-split                POST 的 SSE：按 5 字符分片写入（验证跨 chunk 半包拼接）
 *   --sse-event-bytes=N        POST 的 SSE：先发一个 N 字节的单事件（验证事件大小上界）
 *   --sse-drop-after=N         POST 的 SSE：推 N 条通知后 destroy 连接（无响应 → 流中断）
 *   --sse-notify-interval=MS   通知间隔（默认 25ms）
 *   --get-sse                  GET 返回 SSE（server→client 流）
 *   --get-sse-ids               GET 事件带 id:（否则没有 id —— 客户端不许续传）
 *   --get-sse-replay            重连时按 Last-Event-ID 只重放其之后的事件
 *   --get-sse-close-after=N     每条 GET 流发 N 个事件后由服务端 end()（逼出重连）
 *   --get-sse-duplicate         每个事件用同一 id 重发一次（验证客户端去重）
 *   --get-sse-reconnect-404     首次 GET 成功；之后重连一律 404（会话失效信号）
 *   --get-unavailable=STATUS    不支持 GET 流时返回的状态（默认 405）
 *   --server-request-after=N    GET 流第 N 个事件后发一条服务端→客户端请求（sampling）
 *   --session-expire-after=N    第 N+1 个带 session 的请求起返回会话失效（默认 404）
 *   --session-expire-status=S   会话失效状态码（404 / 400，400 时靠 message 判失效）
 *
 * 观测接口（只在 http 模式、仅本机）：GET /__state → JSON 统计，供测试断言服务端实际看到了什么。
 */
import http from "node:http";
import crypto from "node:crypto";

const SERVER_NAME = "openarc-test-echo";
const SERVER_VERSION = "1.4.0";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const args = new Set(process.argv.slice(2));
const valueOf = (name, fallback = null) => {
  for (const raw of process.argv.slice(2)) {
    if (raw === name) return true;
    if (raw.startsWith(name + "=")) return raw.slice(name.length + 1);
  }
  return fallback;
};
const num = (name, fallback) => {
  const v = valueOf(name, null);
  const n = v == null || v === true ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const MODE = args.has("--http") ? "http" : "stdio";
const PORT = num("--port", 0);
const AUTH_TOKEN = valueOf("--auth-token", null);
const NO_RESPONSE = args.has("--no-response");
const PROTOCOL_VERSION = valueOf("--protocol-version", DEFAULT_PROTOCOL_VERSION);
const PAGE_SIZE = Math.max(1, num("--tools-page-size", 50));
const TOOL_COUNT = Math.max(0, num("--tool-count", 0));
const FAIL_TOOLS_LIST = args.has("--fail-tools-list");
const USE_SSE = args.has("--sse");
const REQUIRE_SESSION = args.has("--require-session");
const SSE_STREAM = args.has("--sse-stream");
const SSE_NOTIFY_ONLY = args.has("--sse-notify-only");
const SSE_SPLIT = args.has("--sse-split");
const SSE_EVENT_BYTES = Math.max(0, num("--sse-event-bytes", 0));
const SSE_DROP_AFTER = Math.max(0, num("--sse-drop-after", 0));
const SSE_NOTIFY_INTERVAL = Math.max(1, num("--sse-notify-interval", 25));
const GET_SSE = args.has("--get-sse");
const GET_IDS = args.has("--get-sse-ids");
const GET_REPLAY = args.has("--get-sse-replay");
const GET_CLOSE_AFTER = Math.max(0, num("--get-sse-close-after", 0));
const GET_DUPLICATE = args.has("--get-sse-duplicate");
const GET_RECONNECT_404 = args.has("--get-sse-reconnect-404");
const GET_UNAVAILABLE_STATUS = Math.max(400, num("--get-unavailable", 405));
const GET_INTERVAL = Math.max(1, num("--get-sse-notify-interval", 25));
const SERVER_REQUEST_AFTER = Math.max(0, num("--server-request-after", 0));
const SESSION_EXPIRE_AFTER = Math.max(0, num("--session-expire-after", 0));
const SESSION_EXPIRE_STATUS = num("--session-expire-status", 404) === 400 ? 400 : 404;

/** 固定工具集（顺序稳定，便于断言）。 */
const BASE_TOOLS = [
  {
    name: "echo_sum",
    description: "把两个数字相加并回显（测试服务；不实现调用）",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  },
  {
    name: "describe_self",
    description: "描述本测试服务自身的传输与协议版本",
    inputSchema: { type: "object", properties: { verbose: { type: "boolean" } }, required: [] },
  },
];
const ALL_TOOLS = BASE_TOOLS.concat(
  Array.from({ length: TOOL_COUNT }, (_, i) => ({
    name: "synthetic_tool_" + String(i + 1).padStart(3, "0"),
    description: "分页边界用合成工具",
    inputSchema: { type: "object", properties: { index: { type: "number" } }, required: [] },
  })),
);

const log = (...parts) => process.stderr.write("[echo-server] " + parts.join(" ") + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resultFor(msg) {
  const method = String(msg.method || "");
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, logging: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: "受控测试服务：只支持 initialize / tools/list；不实现 tools/call。",
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id: msg.id, result: {} };
  if (method === "tools/list") {
    if (FAIL_TOOLS_LIST) return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "tools/list disabled by fixture flag" } };
    const cursor = msg.params && msg.params.cursor ? Number(String(msg.params.cursor)) : 0;
    const start = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
    const slice = ALL_TOOLS.slice(start, start + PAGE_SIZE);
    const next = start + PAGE_SIZE < ALL_TOOLS.length ? String(start + PAGE_SIZE) : null;
    const result = { tools: slice };
    if (next) result.nextCursor = next;
    return { jsonrpc: "2.0", id: msg.id, result };
  }
  if (method === "tools/call") {
    // 第一批不开放工具调用：测试服务也不实现，明确回方法不存在。
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: tools/call is not implemented by this controlled fixture" } };
  }
  return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + method } };
}

/** 返回 null 表示"这是通知或响应，不需要回消息"。 */
function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || msg.method == null) return null;
  if (msg.id == null) {
    log("notification", String(msg.method));
    return null;
  }
  return resultFor(msg);
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------
function startStdio() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (AUTH_TOKEN && msg.method === "initialize") {
        if (!NO_RESPONSE) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "Unauthorized: bearer token required" } }) + "\n");
        continue;
      }
      const reply = handleMessage(msg);
      if (NO_RESPONSE || !reply) continue;
      process.stdout.write(JSON.stringify(reply) + "\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
  log("stdio ready");
}

// ---------------------------------------------------------------------------
// streamable HTTP
// ---------------------------------------------------------------------------
function startHttp() {
  const sessions = new Set();
  const state = {
    flags: {
      sse: USE_SSE,
      sseStream: SSE_STREAM,
      sseNotifyOnly: SSE_NOTIFY_ONLY,
      sseSplit: SSE_SPLIT,
      sseEventBytes: SSE_EVENT_BYTES,
      sseDropAfter: SSE_DROP_AFTER,
      getSse: GET_SSE,
      getSseIds: GET_IDS,
      getSseReplay: GET_REPLAY,
      getSseCloseAfter: GET_CLOSE_AFTER,
      getSseDuplicate: GET_DUPLICATE,
      getSseReconnect404: GET_RECONNECT_404,
      getUnavailable: GET_UNAVAILABLE_STATUS,
      serverRequestAfter: SERVER_REQUEST_AFTER,
      sessionExpireAfter: SESSION_EXPIRE_AFTER,
      sessionExpireStatus: SESSION_EXPIRE_STATUS,
      requireSession: REQUIRE_SESSION,
    },
    http: { requests: 0, posts: 0, gets: 0, stateRequests: 0, byMethod: {}, authRejected: 0, sessionRejected: 0, parseErrors: 0 },
    session: { created: 0, scoped: 0, expired: 0 },
    postSse: { streams: 0, openStreams: 0, notifications: 0, bigEvents: 0, splitWrites: 0, droppedByServer: 0, closedByClient: 0 },
    getSse: { requests: 0, opens: 0, rejected: 0, reconnect404: 0, lastEventIdSeen: null, replays: 0, replayedFrom: null, distinctSent: 0, duplicatesSent: 0, lastSeq: 0, closesByServer: 0, openStreams: 0 },
    serverRequests: { sent: 0, responses: [] },
  };

  const server = http.createServer((req, res) => {
    const pathname = String(req.url || "/").split("?")[0];
    state.http.requests += 1;
    if (pathname === "/__state") {
      state.http.stateRequests += 1;
      return sendJson(res, 200, { port: server.address() ? server.address().port : null, ...state });
    }
    if (req.method === "GET") {
      state.http.gets += 1;
      return handleGetStream(req, res);
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32600, message: "Method Not Allowed" } });
    }
    state.http.posts += 1;
    let raw = "";
    req.on("data", (d) => { raw += d; if (raw.length > 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(raw || "{}");
      } catch {
        state.http.parseErrors += 1;
        return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
      }
      const method = String(msg.method || "");
      state.http.byMethod[method || "(response)"] = (state.http.byMethod[method || "(response)"] || 0) + 1;
      const isInitialize = method === "initialize";
      const auth = String(req.headers.authorization || "");
      if (AUTH_TOKEN && auth !== "Bearer " + AUTH_TOKEN) { state.http.authRejected += 1; return sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" } }); }
      const sessionId = String(req.headers["mcp-session-id"] || "");
      if (REQUIRE_SESSION && !isInitialize && !sessions.has(sessionId)) { state.http.sessionRejected += 1; return sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32600, message: "Missing or unknown Mcp-Session-Id" } }); }
      // 客户端回给服务端的响应（例如对服务端请求的 -32601）：记账后 202，不回消息
      if (method === "" && msg.id != null) {
        state.serverRequests.responses.push({ id: msg.id, code: msg.error && typeof msg.error.code === "number" ? msg.error.code : null });
        if (state.serverRequests.responses.length > 20) state.serverRequests.responses.shift();
        res.writeHead(202, { "content-length": 0 });
        return res.end();
      }
      if (SESSION_EXPIRE_AFTER > 0 && !isInitialize && sessions.has(sessionId)) {
        state.session.scoped += 1;
        if (state.session.scoped > SESSION_EXPIRE_AFTER) {
          state.session.expired += 1;
          sessions.delete(sessionId);
          return sendJson(res, SESSION_EXPIRE_STATUS, { jsonrpc: "2.0", id: msg.id == null ? null : msg.id, error: { code: -32600, message: "Mcp-Session-Id is invalid or expired" } });
        }
      }
      const reply = handleMessage(msg);
      if (NO_RESPONSE) return; // 不回应：客户端必须靠自己的超时收敛
      if (!reply) {
        res.writeHead(202, { "content-length": 0 });
        return res.end();
      }
      const headers = {};
      if (isInitialize) {
        const sid = crypto.randomBytes(12).toString("base64url");
        sessions.add(sid);
        state.session.created += 1;
        headers["mcp-session-id"] = sid;
      }
      if (SSE_STREAM || SSE_NOTIFY_ONLY || SSE_SPLIT || SSE_EVENT_BYTES > 0 || SSE_DROP_AFTER > 0) {
        return startPostSseStream(res, reply, headers);
      }
      if (USE_SSE) {
        const body = "event: message\ndata: " + JSON.stringify(reply) + "\n\n";
        res.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(body), ...headers });
        return res.end(body);
      }
      sendJson(res, 200, reply, headers);
    });
  });

  const sendJson = (res, status, obj, extraHeaders = {}) => {
    if (!res || res.writableEnded) return;
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...extraHeaders });
    res.end(body);
  };

  /** POST 的 SSE 流：响应事件之后的持续通知 / 半包 / 超大事件 / 无响应中断都由这里控制。 */
  function startPostSseStream(res, reply, headers) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", ...headers });
    state.postSse.streams += 1;
    state.postSse.openStreams += 1;
    let closed = false;
    let timer = null;
    const stop = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      state.postSse.openStreams = Math.max(0, state.postSse.openStreams - 1);
    };
    res.on("close", () => {
      const wasOpen = !closed;
      stop();
      if (wasOpen) state.postSse.closedByClient += 1;
    });
    const write = (text) => {
      if (closed || res.writableEnded) return false;
      res.write(text);
      return true;
    };
    const notify = () => {
      state.postSse.notifications += 1;
      write("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { from: "post-stream", seq: state.postSse.notifications } }) + "\n\n");
    };
    const run = async () => {
      if (SSE_EVENT_BYTES > 0) {
        state.postSse.bigEvents += 1;
        write("event: message\ndata: " + "x".repeat(SSE_EVENT_BYTES) + "\n\n");
      }
      if (SSE_DROP_AFTER > 0) {
        for (let i = 0; i < SSE_DROP_AFTER && !closed; i += 1) {
          notify();
          await sleep(SSE_NOTIFY_INTERVAL);
        }
        state.postSse.droppedByServer += 1;
        stop();
        try { res.destroy(); } catch { /* 已断开 */ }
        return;
      }
      if (SSE_NOTIFY_ONLY) {
        timer = setInterval(notify, SSE_NOTIFY_INTERVAL);
        if (typeof timer.unref === "function") timer.unref();
        return;
      }
      // 响应之前先来一条通知：证明客户端是"边收边解析"，而不是等整段流结束再解析
      if (SSE_STREAM) notify();
      const frame = "event: message\ndata: " + JSON.stringify(reply) + "\n\n";
      if (SSE_SPLIT) {
        for (let i = 0; i < frame.length; i += 5) {
          if (closed || res.writableEnded) return;
          res.write(frame.slice(i, i + 5));
          state.postSse.splitWrites += 1;
          await sleep(3);
        }
      } else {
        write(frame);
      }
      if (SSE_STREAM) {
        timer = setInterval(notify, SSE_NOTIFY_INTERVAL);
        if (typeof timer.unref === "function") timer.unref();
        return;
      }
      stop();
      if (!res.writableEnded) res.end();
    };
    run().catch(() => {});
  }

  /** GET SSE：server→client 流；405/404/501 = 不支持；带 id 时才具备续传能力。 */
  function handleGetStream(req, res) {
    state.getSse.requests += 1;
    const sessionId = String(req.headers["mcp-session-id"] || "");
    const lastEventIdRaw = req.headers["last-event-id"];
    const lastEventId = lastEventIdRaw == null ? null : String(lastEventIdRaw);
    if (lastEventId != null) state.getSse.lastEventIdSeen = lastEventId;
    if (!GET_SSE) {
      state.getSse.rejected += 1;
      return sendJson(res, GET_UNAVAILABLE_STATUS, { jsonrpc: "2.0", error: { code: -32600, message: "Method Not Allowed" } });
    }
    if (REQUIRE_SESSION && !sessions.has(sessionId)) {
      state.getSse.rejected += 1;
      return sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32600, message: "Missing or unknown Mcp-Session-Id" } });
    }
    if (GET_RECONNECT_404 && state.getSse.opens >= 1) {
      state.getSse.reconnect404 += 1;
      return sendJson(res, 404, { jsonrpc: "2.0", error: { code: -32600, message: "Mcp-Session-Id is invalid or expired" } });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    state.getSse.opens += 1;
    state.getSse.openStreams += 1;
    let seq = state.getSse.lastSeq;
    if (lastEventId != null && /^[0-9]+$/.test(lastEventId) && GET_REPLAY) {
      seq = Number(lastEventId);
      state.getSse.replays += 1;
      state.getSse.replayedFrom = seq;
    }
    let sent = 0;
    let closed = false;
    let timer = null;
    const stop = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      state.getSse.openStreams = Math.max(0, state.getSse.openStreams - 1);
    };
    res.on("close", stop);
    timer = setInterval(() => {
      if (closed || res.writableEnded) return stop();
      if (GET_CLOSE_AFTER > 0 && sent >= GET_CLOSE_AFTER) {
        state.getSse.closesByServer += 1;
        stop();
        res.end();
        return;
      }
      seq += 1;
      sent += 1;
      state.getSse.lastSeq = seq;
      state.getSse.distinctSent += 1;
      const id = GET_IDS ? String(seq) : null;
      const payload = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { seq, from: "get-stream" } });
      const frame = (id != null ? "id: " + id + "\n" : "") + "event: message\ndata: " + payload + "\n\n";
      res.write(frame);
      if (GET_DUPLICATE) {
        res.write(frame);
        state.getSse.duplicatesSent += 1;
      }
      if (SERVER_REQUEST_AFTER > 0 && sent === SERVER_REQUEST_AFTER) {
        state.serverRequests.sent += 1;
        res.write("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: "srv-" + state.serverRequests.sent, method: "sampling/createMessage", params: { maxTokens: 1, messages: [] } }) + "\n\n");
      }
    }, GET_INTERVAL);
    if (typeof timer.unref === "function") timer.unref();
  }

  server.listen(PORT, "127.0.0.1", () => {
    const port = server.address().port;
    process.stdout.write(JSON.stringify({ event: "listening", port, url: "http://127.0.0.1:" + port + "/mcp" }) + "\n");
  });
  process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
}

if (MODE === "http") startHttp();
else startStdio();
