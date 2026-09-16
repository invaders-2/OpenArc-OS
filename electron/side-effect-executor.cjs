/**
 * D4-03C4 · 受监督的 side-effect executor runtime（production child entry）。
 *
 * 它**才是真正拥有 resource.trash execution 的进程**：claim LEASED → RUNNING、
 * dispatch 真实 Resource Domain mutation、真实 Domain verification 都在这里发生。
 * OpenArc 主进程绝不直接执行 write。
 *
 * 生命周期契约（runtime-supervisor.cjs 依赖它）：
 *   · 在本进程整个生命周期内独占 bind <runtimeDir>/executors/<instanceId>.sock；
 *     它是 reachability 端点，不是 death proof（pathname unlink != process death）。
 *   · 结束前绝不 unlink socket（由下一次同 instanceId 启动或 OS 回收处理）。
 *   · 只从 argv 读取 safe binding；绝不读 arg 之外的 authority 输入。
 */
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { createSideEffectExecutorBundle } = require("./side-effect-executor-bundle.cjs");

function emit(obj) { return new Promise((resolve) => { process.stdout.write(JSON.stringify(obj) + "\n", () => resolve()); }); }

async function bindLifetimeSocket(socketPath) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const server = net.createServer((socket) => { try { socket.end(); } catch { /* ignore */ } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve()); });
  return server;
}

async function main() {
  const args = JSON.parse(process.argv[2] || "{}");
  const { runtimeDir, dbPath, storeRoot, instanceId, callId, holderId, timeoutMs } = args;
  const clock = args.now != null ? () => args.now : null;
  const socketPath = path.join(runtimeDir, "executors", String(instanceId) + ".sock");
  let server;
  try {
    server = await bindLifetimeSocket(socketPath);
  } catch (e) {
    // 不能发布自己的 lifetime endpoint 时**绝不执行 write**：否则 quiescence 归属无法成立。
    await emit({ type: "endpoint_bind_failed", instanceId, reason: String((e && e.code) || "BIND_FAILED") });
    process.exit(3);
  }
  await emit({ type: "ready", instanceId });
  let bundle = null;
  let result = null;
  try {
    bundle = createSideEffectExecutorBundle({ dbPath, storeRoot, instanceId, clock });
    const lease = bundle.authority.acquireLease({ context: {}, callId, holderId, ttlMs: 600000 });
    if (!lease.ok) {
      result = { ok: false, error: lease.error, stage: "acquire_lease" };
    } else {
      const exec = await bundle.authority.executeSideEffect({ callId, leaseId: lease.lease.leaseId, holderId, timeoutMs: Number(timeoutMs) || 15000 });
      result = {
        ok: !!exec.ok,
        error: exec.error || null,
        stage: "execute",
        mutationCount: exec.mutationCount == null ? null : exec.mutationCount,
        callStatus: exec.call ? exec.call.status : null,
        verificationStatus: exec.verificationStatus || null,
        leaseId: lease.lease.leaseId,
      };
    }
  } catch (e) {
    result = { ok: false, error: "EXECUTOR_FAILED", stage: "threw", detail: String((e && (e.errstr || e.message)) || e).slice(0, 200) };
  } finally {
    try { bundle?.close(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
  }
  // stdout 是 pipe：必须等 flush 完成再退出，否则父进程读到空结果。
  await emit({ type: "result", instanceId, result });
  process.exit(0);
}

void main();
