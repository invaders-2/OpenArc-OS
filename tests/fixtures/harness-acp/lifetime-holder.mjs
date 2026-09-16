/**
 * D4-03C4 Closure-2 · 只持有 lifetime endpoint 并保持存活的真 child。
 *
 * 用于 same-supervisor exit proof gate：它像 production executor 一样独占 bind
 * <runtimeDir>/executors/<instanceId>.sock，但什么都不执行 —— 这样测试可以只观测
 * "真实 child 'exit'" 是否产生 trusted death proof。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const args = JSON.parse(process.argv[2] || "{}");
const socketPath = path.join(String(args.runtimeDir), "executors", String(args.instanceId) + ".sock");
fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
const server = net.createServer((socket) => { try { socket.end(); } catch { /* ignore */ } });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve()); });
process.stdout.write(JSON.stringify({ type: "ready", instanceId: args.instanceId }) + "\n");
setInterval(() => {}, 1000);
