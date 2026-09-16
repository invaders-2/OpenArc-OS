/**
 * D4-03C4 · 受监督 executor 测试夹具。
 *
 * 它扮演"受 RuntimeSupervisor 拥有并监督的 executor runtime"：
 *   · 在本进程生命周期内独占 bind <runtimeDir>/executors/<instanceId>.sock（supervisor 的
 *     cross-restart liveness probe 只认这个 OS 事实）；
 *   · 真实 acquireLease + executeSideEffect（真实 Resource Domain mutation）；
 *   · Domain mutation 由一个 stdin gate（"MUTATE"）控制，便于制造
 *     "timeout → UNKNOWN_EFFECT → 进程死亡 → late mutation" 的真实场景。
 *
 * 注意：它**不**调用 RuntimeLifecycleAuthority.observeExit —— 那只能由 production
 * RuntimeSupervisor 的真实 child lifecycle listener 产生。
 */
import { createRequire } from "node:module";
import readline from "node:readline";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
const require = createRequire(import.meta.url);
const { createSideEffectExecutorBundle } = require("../../../electron/side-effect-executor-bundle.cjs");

const args = JSON.parse(process.argv[2] || "{}");
const socketPath = path.join(String(args.runtimeDir), "executors", String(args.instanceId) + ".sock");
fs.mkdirSync(path.dirname(socketPath), { recursive: true });
const server = net.createServer((socket) => { try { socket.end(); } catch { /* ignore */ } });
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve()); });

let gateResolve = null;
const gate = new Promise((r) => { gateResolve = r; });
let deleteCalls = 0;
const bundle = createSideEffectExecutorBundle({
  dbPath: args.dbPath,
  storeRoot: args.storeRoot,
  instanceId: args.instanceId,
  clock: args.now != null ? () => args.now : null,
  resourceServiceWrapper: (svc) => {
    const real = svc.delete.bind(svc);
    svc.delete = async (a) => {
      deleteCalls += 1;
      await gate;
      const out = await real(a);
      process.stdout.write(JSON.stringify({ type: "mutation_done", deleteCalls }) + "\n");
      // Closure-2：真实 late mutation 已落盘后保持挂起，便于观测"尚未 finalize 的旧 executor"。
      if (args.holdAfterMutation) await new Promise(() => {});
      return out;
    };
    return svc;
  },
});

// gate 监听必须在 executeSideEffect 之前就绪：否则 mutation gate 期间收到的 MUTATE 会丢失。
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => { if (String(line).trim() === "MUTATE" && gateResolve) gateResolve(); });

const lease = bundle.authority.acquireLease({ context: {}, callId: args.callId, holderId: args.holderId, ttlMs: 600000 });
const emit = (obj) => new Promise((resolve) => { process.stdout.write(JSON.stringify(obj) + "\n", () => resolve()); });
await emit({ type: "ready", instanceId: args.instanceId, leaseOk: !!lease.ok, leaseError: lease.ok ? null : lease.error });
if (!lease.ok) { process.exit(0); }
const res = await bundle.authority.executeSideEffect({ callId: args.callId, leaseId: lease.lease.leaseId, holderId: args.holderId, timeoutMs: args.timeoutMs || 250 });
await emit({ type: "unknown_effect", status: res.call && res.call.status, quiesced: !!(res.call && res.call.recoverySafe && res.call.recoverySafe.quiesced), deleteCalls });
