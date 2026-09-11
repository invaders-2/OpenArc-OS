// D1-02 探针用的假 MCP 服务器：只暴露一个无副作用的 echo 工具。
// 严禁在此加入文件写入、命令执行、网络请求等任何有副作用的能力。
// 手写 MCP stdio 协议（initialize / tools/list / tools/call），不引入 SDK。

import { appendFileSync } from "node:fs";

process.stdin.setEncoding("utf8");
let buf = "";

// 可选取证：把收到的每个方法名追加到 $DSH_FAKE_MCP_LOG，用于证实 Harness 确实连上了本服务器。
// 只写探针临时目录，不参与任何业务逻辑。
const LOG = process.env.DSH_FAKE_MCP_LOG;
const trace = (m) => {
  if (!LOG) return;
  try {
    appendFileSync(LOG, m + "\n");
  } catch {
    /* 取证失败不影响探针 */
  }
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const TOOLS = [
  {
    name: "openarc_echo",
    description: "回显输入，无任何副作用。用于验证工具链路是否可被外部控制。",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

function handle(msg) {
  const { id, method, params } = msg;
  trace(method);
  switch (method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "openarc-fake", version: "0.1.0" },
        },
      });
    case "notifications/initialized":
      return; // 通知，无响应
    case "tools/list":
      return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    case "tools/call": {
      const text = params?.arguments?.text ?? "";
      return send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `openarc-echo:${text}` }], isError: false },
      });
    }
    case "shutdown":
      return send({ jsonrpc: "2.0", id, result: {} });
    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
}

process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith("{")) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* 忽略畸形帧 */
    }
  }
});
