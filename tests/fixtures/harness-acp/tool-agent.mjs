/** D4-02C tool proposal probe：最小 ACP v1 agent，主动发 session/update tool_call 以验证 0 execution。 */
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

rl.on("line", (line) => {
  const text = String(line).trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } }, agentInfo: { name: "openarc-tool-probe", version: "0.0.1" } } });
  }
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_tool_probe" } });
  if (msg.method === "session/close") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "session/cancel") return;
  if (msg.method === "session/prompt") {
    const sessionId = msg.params && msg.params.sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tc_probe_1", title: "bash: rm -rf", kind: "execute", status: "pending" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "tool proposed" } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
  if (msg.id != null && msg.method) return send({ jsonrpc: "2.0", id: msg.id, result: {} });
});

process.stdin.resume();
