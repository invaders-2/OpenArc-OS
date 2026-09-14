/** D4-03B controlled ACP agent：真实 ACP v1 tool_call proposal + 要求 Tool result 才继续。
 *
 * 约定：Step input = { proposeSequence: [{toolId, toolVersion, arguments, proposalId}], finalText }。
 * turn 0 发出第一个 tool_call；之后每个 continuation prompt 必须包含 "Tool result"，否则返回 MISSING_TOOL_RESULT。
 * 只有收到 OpenArc 验证过的 Tool result 后，才发出最终 finalText（默认 OPENARC_TASK_OK）。
 *
 * 这是 test-only、official-ACP-compatible 受控 agent；不打开生产 shell/filesystem/MCP。
 */
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
let turn = 0;
let sequence = [];
let finalText = "OPENARC_TASK_OK";

function readSpec(prompt) {
  for (const l of prompt.split("\n")) {
    if (l.startsWith("Step input: ")) { try { return JSON.parse(l.slice("Step input: ".length)); } catch { return null; } }
  }
  return null;
}

rl.on("line", (line) => {
  const text = String(line).trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } }, agentInfo: { name: "openarc-readonly-tool-probe", version: "0.0.1" } } });
  }
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_readonly_tool" } });
  if (msg.method === "session/close") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "session/cancel") return;
  if (msg.method === "session/prompt") {
    const sessionId = msg.params && msg.params.sessionId;
    const promptId = msg.id;
    const prompt = (msg.params.prompt || []).map((b) => (b && b.text) || "").join("\n");
    const finishText = (t) => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } } });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    };
    const emitTool = (p) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: p.proposalId || ("tc_" + turn), title: p.toolId, kind: "other", status: "pending", rawInput: { toolVersion: p.toolVersion || 1, arguments: p.arguments || {} } } } });
    const endTurn = () => send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });

    if (turn === 0) {
      const spec = readSpec(prompt) || {};
      sequence = Array.isArray(spec.proposeSequence) ? spec.proposeSequence.slice() : (spec.proposeTool ? [spec.proposeTool] : [{ toolId: "test.echo", toolVersion: 1, arguments: { message: "hi" }, proposalId: "tc_default" }]);
      finalText = typeof spec.finalText === "string" ? spec.finalText : "OPENARC_TASK_OK";
      turn = 1;
      if (sequence.length) { emitTool(sequence.shift()); return endTurn(); }
      return finishText(finalText);
    }
    if (!prompt.includes("Tool result")) return finishText("MISSING_TOOL_RESULT");
    turn += 1;
    if (sequence.length) { emitTool(sequence.shift()); return endTurn(); }
    return finishText(finalText);
  }
  if (msg.id != null && msg.method) return send({ jsonrpc: "2.0", id: msg.id, result: {} });
});

process.stdin.resume();
