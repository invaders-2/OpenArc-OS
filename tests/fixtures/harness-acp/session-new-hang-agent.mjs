/** D4-02C 诊断探针：initialize 正常回应，session/new 永不返回 —— 用于验证启动阶段有没有上界。 */
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

rl.on("line", (line) => {
  const text = String(line).trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } }, agentInfo: { name: "openarc-session-new-hang-probe", version: "0.0.1" } } });
  }
  // session/new 故意永不回应：探针保持存活，看产品启动预算是否覆盖这一段。
  if (msg.method === "session/cancel") return;
});

process.stdin.resume();
