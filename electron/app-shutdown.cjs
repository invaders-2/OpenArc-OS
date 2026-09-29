/**
 * D5-03 第十一批 · 关闭应用的唯一收尾顺序（真实 electron/main.cjs 与验收 probe host 共享）。
 *
 * 永久规则：
 *   **Harness 在途启动 / 执行必须先被停下（撤销两类能力、回收 harness 子进程与 bridge），
 *   之后才允许停 Model Proxy、关 SQLite。**
 *
 * 为什么单独成文件：与 runtime-boot.cjs 同一条理由 —— 真实 main 与 probe host 各写一遍
 * 关闭顺序就会漂移，于是「probe 通过、真实退出漏收 Harness」这种缺陷永远测不出来。
 *
 * 边界（全部是硬约束）：
 *   · **应用退出不是用户取消**：这里只撤能力 / 停进程 / 关资源，**绝不**写 Task / Step /
 *     Harness Run 状态 —— 未完成任务保持 RUNNING 落库，重启后由既有 recoverRunning()
 *     规则转 BLOCKED + RECOVERY_REQUIRED（绝不伪造 CANCELLED / SUCCEEDED）；
 *   · 每一项都**有界**：单步超时或抛错只留痕，绝不无限等待、绝不跳过后面的关库；
 *   · 重复 quit 安全：调用方（main.cjs）先置标志再 preventDefault，第二次 will-quit 直接
 *     放行，不会出现两套收尾同时跑。
 */
"use strict";

const MCP_DISPOSE_MS = 2000;
const HARNESS_DISPOSE_MS = 8000;

/**
 * 有界等待任意 dispose 类收尾。返回字段与 mcp-bootstrap 的 disposeMcpBounded 同形，
 * 另加 timedOut / error / skipped。
 */
function disposeBounded({ service = null, timeoutMs = 2000, reason = "app-quit", timeoutCode = "DISPOSE_TIMEOUT" } = {}) {
  if (!service || typeof service.dispose !== "function") return Promise.resolve({ ok: true, skipped: true });
  let timer = null;
  const limit = Math.max(0, Number(timeoutMs) || 0);
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: timeoutCode, timeoutCode, timedOut: true }), limit);
  });
  return Promise.race([Promise.resolve().then(() => service.dispose({ reason })), timeout])
    .then((res) => { if (timer) clearTimeout(timer); return res && typeof res === "object" ? res : { ok: true }; })
    .catch((e) => { if (timer) clearTimeout(timer); return { ok: false, error: String((e && e.message) || e) }; });
}

function safeLog(log, message) { try { log(message); } catch { /* 日志失败绝不阻塞退出 */ } }

async function disposeHarnessBounded({ orchestrator = null, timeoutMs = HARNESS_DISPOSE_MS, reason = "app-quit", log = null } = {}) {
  return await disposeBounded({ service: orchestrator, timeoutMs, reason, timeoutCode: "HARNESS_DISPOSE_TIMEOUT" });
}

/**
 * 关应用收尾顺序：MCP（有界 2s）→ Harness（有界）→ modelProxy.stop → store.close。
 * Harness 与 MCP 的收尾**并发**发起：两者的 2s / 8s 预算是两条独立上界，串行会白白相加。
 * 返回 safe 观测（不含任何 secret），供真实退出与 probe 共用一份断言口径。
 */
async function disposeAppResources({ identity = null, orchestrator = null, mcpService = null, log = null, timeoutMs = null } = {}) {
  const harness = orchestrator || (identity && identity.orchestrator) || null;
  const mcp = mcpService || (identity && identity.mcpService) || null;
  const mcpMs = timeoutMs == null ? MCP_DISPOSE_MS : timeoutMs;
  const harnessMs = timeoutMs == null ? HARNESS_DISPOSE_MS : timeoutMs;
  const [mcpRes, harnessRes] = await Promise.all([
    disposeBounded({ service: mcp, timeoutMs: mcpMs, reason: "app-quit", timeoutCode: "DISPOSE_TIMEOUT" }),
    disposeHarnessBounded({ orchestrator: harness, timeoutMs: harnessMs, reason: "app-quit", log }),
  ]);
  safeLog(log, "[openarc] MCP 收尾：" + JSON.stringify({ ok: mcpRes.ok !== false, closed: mcpRes.closed || 0, aborted: mcpRes.aborted || 0, ended: mcpRes.ended || 0, error: mcpRes.error || null, failures: mcpRes.failures || [] }));
  safeLog(log, "[openarc] Harness 收尾：" + JSON.stringify({ ok: harnessRes.ok !== false, timedOut: harnessRes.timedOut === true, error: harnessRes.error || null }));
  let proxyStopped = false;
  try {
    if (identity && identity.modelProxy && typeof identity.modelProxy.stop === "function") { identity.modelProxy.stop(); proxyStopped = true; }
  } catch { /* 已关闭 */ }
  let storeClosed = false;
  try {
    if (identity && identity.store && typeof identity.store.close === "function") { identity.store.close(); storeClosed = true; }
  } catch { /* 已关闭 */ }
  return {
    ok: mcpRes.ok !== false && harnessRes.ok !== false,
    mcp: { ok: mcpRes.ok !== false, closed: mcpRes.closed || 0, aborted: mcpRes.aborted || 0, ended: mcpRes.ended || 0, error: mcpRes.error || null, timedOut: mcpRes.timedOut === true },
    harness: { ok: harnessRes.ok !== false, error: harnessRes.error || null, timedOut: harnessRes.timedOut === true, skipped: harnessRes.skipped === true },
    proxyStopped,
    storeClosed,
    at: Date.now(),
  };
}

module.exports = { disposeBounded, disposeHarnessBounded, disposeAppResources, MCP_DISPOSE_MS, HARNESS_DISPOSE_MS };
