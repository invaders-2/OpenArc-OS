#!/usr/bin/env node
/**
 * B4e 收口 · 本机 loopback MCP 工具服务（**只在 127.0.0.1 监听**，测试自起自停）。
 *
 *   node loopback-tool-server.mjs --http [--port=0]
 *
 * 与 tests/fixtures/mcp/echo-server.mjs 的差别：本服务**实现 tools/call**，
 * 用来证明"开关开启 + 审批通过后真实 tools/call 到达本机服务并取回结果"。
 * 固定工具：loop_echo（把 {name, arguments} 原样回成文本）。
 *
 * 观测接口（只在 http 模式、仅本机）：GET /__state → JSON 统计（请求数 / 按方法计数 / toolsCall 次数）。
 */
import http from "node:http";
import crypto from "node:crypto";

const SERVER_NAME = "openarc-loopback-tool";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";

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

const PORT = num("--port", 0);

const TOOLS = [
  {
    name: "loop_echo",
    description: "把调用参数原样回显（本机 loopback 测试服务）",
    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" }, text: { type: "string" } }, required: [] },
  },
];

const state = {
  requests: 0,
  byMethod: {},
  toolsCalls: [],
  sessionsCreated: 0,
};

function replyFor(msg) {
  const method = String(msg.method || "");
  if (method === "initialize") {
    state.sessionsCreated += 1;
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: "loopback MCP tool server（仅本机 127.0.0.1）",
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id: msg.id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    const name = msg.params && typeof msg.params.name === "string" ? msg.params.name : "";
    const args = msg.params && msg.params.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
    state.toolsCalls.push({ name, arguments: args });
    if (name !== "loop_echo") {
      return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "UNKNOWN_TOOL:" + name }], isError: true } };
    }
    return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ tool: name, arguments: args }) }] } };
  }
  return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + method } };
}

const server = http.createServer((req, res) => {
  state.requests += 1;
  const pathname = String(req.url || "/").split("?")[0];
  const sendJson = (status, obj, extraHeaders = {}) => {
    if (!res || res.writableEnded) return;
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...extraHeaders });
    res.end(body);
  };
  if (pathname === "/__state") return sendJson(200, { port: server.address() ? server.address().port : null, ...state });
  if (req.method === "GET") return sendJson(405, { jsonrpc: "2.0", error: { code: -32600, message: "GET stream unsupported" } });
  if (req.method !== "POST") return sendJson(405, { jsonrpc: "2.0", error: { code: -32600, message: "Method Not Allowed" } });
  let raw = "";
  req.on("data", (d) => { raw += d; if (raw.length > 1024 * 1024) req.destroy(); });
  req.on("end", () => {
    let msg;
    try {
      msg = JSON.parse(raw || "{}");
    } catch {
      return sendJson(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } });
    }
    const method = String(msg.method || "");
    state.byMethod[method || "(response)"] = (state.byMethod[method || "(response)"] || 0) + 1;
    if (msg.method == null) { res.writeHead(202, { "content-length": 0 }); return res.end(); }
    const headers = {};
    if (method === "initialize") headers["mcp-session-id"] = crypto.randomBytes(12).toString("base64url");
    sendJson(200, replyFor(msg), headers);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write(JSON.stringify({ event: "listening", port, url: "http://127.0.0.1:" + port + "/mcp" }) + "\n");
});
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
