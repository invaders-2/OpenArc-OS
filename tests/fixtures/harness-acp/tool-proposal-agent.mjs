/** D4-03A synthetic ACP tool proposal fixture。
 * 约定：Step input 里带 proposeTool = { toolId, toolVersion, arguments, proposalId }，
 * agent 按此发出 session/update tool_call（title=toolId, rawInput={toolVersion,arguments}）。
 * 这是 test-only Harness fixture；绝不打开生产 shell / filesystem tools。
 */
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

rl.on("line", (line) => {
  const text = String(line).trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } }, agentInfo: { name: "openarc-tool-proposal-probe", version: "0.0.1" } } });
  }
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_tool_proposal" } });
  if (msg.method === "session/close") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "session/cancel") return;
  if (msg.method === "session/prompt") {
    const sessionId = msg.params && msg.params.sessionId;
    const prompt = (msg.params.prompt || []).map((b) => (b && b.text) || "").join("\n");
    let spec = null;
    for (const l of prompt.split("\n")) {
      if (l.startsWith("Step input: ")) { try { spec = JSON.parse(l.slice("Step input: ".length)); } catch { spec = null; } }
    }
    const p = (spec && spec.proposeTool) || { toolId: "test.echo", toolVersion: 1, arguments: { message: "hi" }, proposalId: "tc_default" };
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: p.proposalId || "tc_prop_1", title: p.toolId, kind: "other", status: "pending", rawInput: { toolVersion: p.toolVersion || 1, arguments: p.arguments || {} } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
  if (msg.id != null && msg.method) return send({ jsonrpc: "2.0", id: msg.id, result: {} });
});

process.stdin.resume();
