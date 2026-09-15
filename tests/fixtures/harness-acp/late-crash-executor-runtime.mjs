/**
 * D4-03C4 · 在 claim 之后真实死亡的 executor runtime（official dsh WRITE chain 用）。
 *
 * crashPoint:
 * 本文件固定 after_mutation：mutation 已提交后进程死亡（late APPLIED recovery 场景）。
 * 只在进程生命周期内独占 bind socket；绝不调用 observeExit。
 */
import { createRequire } from "node:module";
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

const emit = (obj) => new Promise((resolve) => { process.stdout.write(JSON.stringify(obj) + "\n", () => resolve()); });
let bundle = null;
const exitAfter = async (point) => {
  await emit({ type: "executor_crash", point });
  try { bundle?.identity.close(); } catch { /* ignore */ }
  process.exit(9);
};
bundle = createSideEffectExecutorBundle({
  dbPath: args.dbPath,
  storeRoot: args.storeRoot,
  instanceId: args.instanceId,
  clock: args.now != null ? () => args.now : null,
  resourceServiceWrapper: (svc) => {
    const real = svc.delete.bind(svc);
    svc.delete = async (a) => {
      const out = await real(a);
      await exitAfter("after_mutation");
      return out;
    };
    return svc;
  },
});

const lease = bundle.authority.acquireLease({ context: {}, callId: args.callId, holderId: args.holderId, ttlMs: 600000 });
await emit({ type: "ready", instanceId: args.instanceId, leaseOk: !!lease.ok, leaseError: lease.ok ? null : lease.error });
if (!lease.ok) process.exit(0);
await bundle.authority.executeSideEffect({ callId: args.callId, leaseId: lease.lease.leaseId, holderId: args.holderId, timeoutMs: Number(args.timeoutMs) || 60000 });