#!/usr/bin/env node
/**
 * D5-03 第一批 · 受控 MCP 测试服务（自建；不依赖任何第三方服务）。
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
 *   --sse                  HTTP 响应走 text/event-stream 单事件
 *   --require-session      HTTP：非 initialize 请求必须带 Mcp-Session-Id
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

/** 返回 null 表示"这是通知，不需要响应"。 */
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
// streamable HTTP（单响应）
// ---------------------------------------------------------------------------
function startHttp() {
  const sessions = new Set();
  const server = http.createServer((req, res) => {
    const send = (status, obj, extraHeaders = {}) => {
      if (res.writableEnded) return;
      const body = JSON.stringify(obj);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...extraHeaders });
      res.end(body);
    };
    if (req.method !== "POST") return send(405, { jsonrpc: "2.0", error: { code: -32600, message: "Method Not Allowed" } });
    let raw = "";
    req.on("data", (d) => { raw += d; if (raw.length > 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(raw || "{}");
      } catch {
        return send(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
      }
      const isInitialize = msg.method === "initialize";
      const auth = String(req.headers.authorization || "");
      if (AUTH_TOKEN && auth !== "Bearer " + AUTH_TOKEN) return send(401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" } });
      const sessionId = String(req.headers["mcp-session-id"] || "");
      if (REQUIRE_SESSION && !isInitialize && !sessions.has(sessionId)) return send(400, { jsonrpc: "2.0", error: { code: -32600, message: "Missing or unknown Mcp-Session-Id" } });
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
        headers["mcp-session-id"] = sid;
      }
      if (USE_SSE) {
        const body = "event: message\ndata: " + JSON.stringify(reply) + "\n\n";
        res.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(body), ...headers });
        return res.end(body);
      }
      send(200, reply, headers);
    });
  });
  server.listen(PORT, "127.0.0.1", () => {
    const port = server.address().port;
    process.stdout.write(JSON.stringify({ event: "listening", port, url: "http://127.0.0.1:" + port + "/mcp" }) + "\n");
  });
  process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
}

if (MODE === "http") startHttp();
else startStdio();
