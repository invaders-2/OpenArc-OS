/**
 * D5-03 第十批探针：initialize 正常回应，session/new **可控**——延迟后回应（模拟迟到响应）或永不回应。
 * 无论哪种都保持进程存活：收敛必须由产品自己的启动预算判定，而不是探针主动退出。
 * 延迟从 argv[2]（毫秒）读；不传 = 永不回应。延迟 0 = 立即回应（启动成功的临界点）。
 */
import readline from "node:readline";

const delayMs = Number(process.argv[2] || 0);
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

rl.on("line", (line) => {
  const text = String(line).trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } }, agentInfo: { name: "openarc-session-new-hold-probe", version: "0.0.1" } } });
  }
  if (msg.method === "session/new") {
    if (delayMs <= 0) return;
    return void setTimeout(() => send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess_hold_" + delayMs } }), delayMs);
  }
  if (msg.method === "session/close") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "session/cancel") return;
  if (msg.method === "session/prompt") return;
  if (msg.id != null && msg.method) return send({ jsonrpc: "2.0", id: msg.id, result: {} });
});

process.stdin.resume();
