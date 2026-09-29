/**
 * D5-03 第十一批探针：最小 ACP v1 agent，正常完成一整轮（initialize → session/new → prompt → end_turn）。
 * 用于「正常任务成功」对照组：证明退出收尾没有把正常路径弄坏。
 * 文本从 argv[2] 读（默认 OPENARC_TASK_OK）。
 */
import readline from "node:readline";

const TEXT = process.argv[2] || "OPENARC_TASK_OK";
const SESSION = "sess_echo_" + process.pid;
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

rl.on("line", (line) => {
  const text = String(line).trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } }, agentInfo: { name: "openarc-echo-probe", version: "0.0.1" } } });
  }
  if (msg.method === "session/new") return send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: SESSION } });
  if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: TEXT } } } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
  if (msg.method === "session/close") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "session/cancel") return;
  if (msg.id != null && msg.method) return send({ jsonrpc: "2.0", id: msg.id, result: {} });
});

process.stdin.resume();
