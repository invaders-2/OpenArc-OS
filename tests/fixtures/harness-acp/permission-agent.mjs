/** D4-02B permission probe：最小 ACP v1 agent，主动发 session/request_permission 以验证 client 一律 reject。 */
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let seq = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

rl.on("line", (line) => {
  const text = String(line).trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } }, agentInfo: { name: "openarc-permission-probe", version: "0.0.1" } } });
  }
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_perm_probe" } });
  if (msg.method === "session/close") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "session/cancel") return;
  if (msg.method === "session/prompt") {
    const promptId = msg.id;
    const sessionId = msg.params && msg.params.sessionId;
    const permId = "perm_" + (seq += 1);
    send({ jsonrpc: "2.0", id: permId, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tc_perm_1", kind: "execute", title: "bash: echo openarc-permission-probe", status: "pending" }, options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }] } });
    const onResponse = (line2) => {
      let m2; try { m2 = JSON.parse(String(line2)); } catch { return; }
      if (m2.id !== permId) return;
      rl.removeListener("line", onResponse);
      const outcome = m2.result && m2.result.outcome ? m2.result.outcome : "unknown";
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission outcome: " + outcome } } } });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    };
    rl.on("line", onResponse);
    return;
  }
  if (msg.id != null && msg.method) return send({ jsonrpc: "2.0", id: msg.id, result: {} });
});

process.stdin.resume();
