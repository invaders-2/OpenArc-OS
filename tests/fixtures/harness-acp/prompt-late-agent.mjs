/**
 * D5-03 第十二批探针：initialize / session/new 正常，`session/prompt` **延迟 N ms 后**才回 end_turn。
 * 延迟从 argv[2] 读（默认 5000）。用于「迟到响应」时序：产品在回包前被取消，迟到结果不得复活终态。
 */
import readline from "node:readline";

const LATE_MS = Number(process.argv[2] || 5000);
const SESSION = "sess_late_" + process.pid;
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

rl.on("line", (line) => {
  const text = String(line).trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } }, agentInfo: { name: "openarc-prompt-late-probe", version: "0.0.1" } } });
  }
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: SESSION } });
  if (msg.method === "session/prompt") {
    const id = msg.id;
    return void setTimeout(() => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OPENARC_TASK_OK" } } } });
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }, LATE_MS);
  }
  if (msg.method === "session/close") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "session/cancel") return;
  if (msg.id != null && msg.method) return send({ jsonrpc: "2.0", id: msg.id, result: {} });
});

process.stdin.resume();
