/**
 * D5-03 第九批 · 独立验收 · 第三段（3）：R1 观察（只观察，不修）
 *
 * R1 = electron/harness-adapter.cjs 的 newSession **没有超时**（启动预算只包 initialize，:272-275；:278 裸 await）。
 * 本探针独立复现：初始化正常、session/new 永不返回 → 注入 700ms 启动预算后观察 run 是否收敛。
 * 对照组：同样 700ms 预算 + initialize 永不返回（start-hang）→ 应在同量级收敛。
 *
 * 用法：node experiments/d5-03/batch9/verify/batch9-04-r1-observation.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createTaskHarnessFixture } from "../../../../tests/fixtures/harness-acp/task-harness-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const require = createRequire(import.meta.url);
const { ERROR } = require(path.join(ROOT, "electron/task-domain.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe({ agentFile, startTimeoutMs, watchMs, label }) {
  const fx = await createTaskHarnessFixture();
  const t0 = process.hrtime.bigint();
  const lifecycle = {};
  let childPid = null; let aliveBeforeDispose = null;
  const marks = [];
  const mark = (name, detail = null) => marks.push({ name, detail, atMs: Number(process.hrtime.bigint() - t0) / 1e6 });
  let orch = null, adapterRef = null;
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const base = fx.agentFactory(agentFile);
    const calls = { starts: 0, prompts: 0 };
    orch = fx.makeOrchestrator((opts) => {
      const a = base(opts);
      adapterRef = a;
      const s = a.start.bind(a), p = a.prompt.bind(a);
      a.start = async (x) => { calls.starts += 1; mark("adapter:start:begin"); try { const r = await s(x); mark("adapter:start:done"); return r; } catch (e) { mark("adapter:start:error", String((e && e.code) || e)); throw e; } };
      a.prompt = async (x, o) => { calls.prompts += 1; return await p(x, o); };
      return a;
    }, { startTimeoutMs, turnTimeoutMs: 60000 });

    const providerBefore = fx.fp.state.requests;
    let settled = null;
    const p = orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    p.then((r) => { settled = { kind: "resolved", atMs: Number(process.hrtime.bigint() - t0) / 1e6, ok: !!r.ok, error: r.error || null, taskStatus: r.task ? r.task.status : null }; mark("runTask:resolved", String(r.error || "ok")); },
           (e) => { settled = { kind: "rejected", atMs: Number(process.hrtime.bigint() - t0) / 1e6, error: String((e && e.message) || e) }; mark("runTask:rejected"); });
    while (settled == null && Number(process.hrtime.bigint() - t0) / 1e6 < watchMs) await sleep(20);
    mark("watch:end");
    const svc = fx.taskService;
    const task = svc.getTask({ context: ctx, taskId: t.task.taskId });
    const runs = svc.getHarnessRuns({ context: ctx, taskId: t.task.taskId });
    const callsRec = svc.getCalls({ context: ctx, taskId: t.task.taskId });
    childPid = adapterRef && adapterRef.child ? adapterRef.child.pid : null;
    aliveBeforeDispose = (() => { if (!childPid) return null; try { process.kill(childPid, 0); return true; } catch { return false; } })();
    const alive = aliveBeforeDispose;
    return {
      label, agentFile, startTimeoutMs, watchMs,
      settledWithinWatchWindow: settled != null,
      settled,
      taskStatus: task.ok ? task.task.status : null,
      runStatus: runs.ok && runs.items[0] ? runs.items[0].status : null,
      runErrorCode: runs.ok && runs.items[0] ? runs.items[0].errorCode : null,
      providerRequestsDelta: fx.fp.state.requests - providerBefore,
      adapterCalls: calls,
      callRecords: callsRec.ok ? callsRec.items.length : null,
      childPid, childAliveAfterWatch: alive, lifecycle,
      load: { loadavg: os.loadavg(), cpus: os.cpus().length, totalmem: os.totalmem() },
      timeline: marks,
    };
  } finally {
    // dispose 后**再**测一次子进程存活：这才是"有没有孤儿"的判据（之前测的是 dispose 前的存活）。
    try { await orch?.dispose(); } catch { /* ignore */ }
    await sleep(300);
    const pidAfter = adapterRef && adapterRef.child ? adapterRef.child.pid : null;
    // kill(pid,0) 对**僵尸**也成功，所以必须看 ps 的 stat：Z = 已退出待父进程回收，不算在跑的孤儿。
    const psState = (pid) => { if (!pid) return null; try { const out = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); return out || "gone"; } catch { return "gone"; } };
    if (lifecycle) {
      lifecycle.childPid = childPid;
      lifecycle.childAliveBeforeDispose = aliveBeforeDispose;
      lifecycle.childPidAfterDispose = pidAfter;
      lifecycle.psStateAfterDispose = psState(pidAfter);
      lifecycle.runningOrphanAfterDispose = !!lifecycle.psStateAfterDispose && lifecycle.psStateAfterDispose !== "gone" && !lifecycle.psStateAfterDispose.startsWith("Z");
      lifecycle.zombieAfterDispose = !!lifecycle.psStateAfterDispose && lifecycle.psStateAfterDispose.startsWith("Z");
    }
    try { await fx.close(); } catch { /* ignore */ }
  }
}

const results = {};
results.control_startHang = await probe({ agentFile: "start-hang-agent.mjs", startTimeoutMs: 700, watchMs: 8000, label: "对照：initialize 永不返回（启动预算确实生效）" });
results.r1_sessionNewHang = await probe({ agentFile: "session-new-hang-agent.mjs", startTimeoutMs: 700, watchMs: 8000, label: "R1：session/new 永不返回（启动预算是否覆盖这一段）" });

const R1 = results.r1_sessionNewHang, C = results.control_startHang;
const checks = [
  { id: "R1-a", name: "对照组（initialize 阻塞）在 8s 观察窗内收敛（证明 700ms 预算是真预算）", expected: true, actual: C.settledWithinWatchWindow, pass: C.settledWithinWatchWindow === true },
  { id: "R1-b", name: "R1 复现：session/new 阻塞时 run 在 700ms 预算 + 8s 观察窗内**未收敛**", expected: false, actual: R1.settledWithinWatchWindow, pass: R1.settledWithinWatchWindow === false },
  { id: "R1-c", name: "R1 期间 run 仍停在 STARTING、task 仍 RUNNING、0 provider 请求、0 prompt", expected: "STARTING/RUNNING/0/0", actual: R1.runStatus + "/" + R1.taskStatus + "/" + R1.providerRequestsDelta + "/" + R1.adapterCalls.prompts, pass: R1.runStatus === "STARTING" && R1.taskStatus === "RUNNING" && R1.providerRequestsDelta === 0 && R1.adapterCalls.prompts === 0 },
  { id: "R1-d", name: "R1 期间 harness 子进程仍存活（无界段）", expected: true, actual: R1.childAliveAfterWatch, pass: R1.childAliveAfterWatch === true },
  // R1-e 是**观察项**（finding），不是本次验收的判据：它记录 R1 的一个后果，本批未授权修 harness-adapter/orchestrator。
  { id: "R1-e", name: "【发现·不属于本批】R1 的 harness 子进程在 orchestrator.dispose() 后仍在运行（registry.set 在 adapter.start() 返回之后，:241；dispose 只遍历 registry，:824-831）", expected: "无在跑的孤儿（对照组成立，R1 场景不成立）", actual: JSON.stringify({ psState: R1.lifecycle.psStateAfterDispose, runningOrphan: R1.lifecycle.runningOrphanAfterDispose, zombie: R1.lifecycle.zombieAfterDispose }), pass: R1.lifecycle.runningOrphanAfterDispose === false, observation: true },
  { id: "R1-f", name: "对照组 dispose 后同样无在跑的孤儿", expected: "无在跑的孤儿", actual: JSON.stringify({ psState: C.lifecycle.psStateAfterDispose, runningOrphan: C.lifecycle.runningOrphanAfterDispose, zombie: C.lifecycle.zombieAfterDispose }), pass: C.lifecycle.runningOrphanAfterDispose === false },
];
for (const c of checks) console.log((c.pass ? "  [PASS] " : "! [FAIL] ") + c.id + " · " + c.name + " — 期望 " + c.expected + "，实际 " + JSON.stringify(c.actual));
const counted = checks.filter((c) => !c.observation);
const findings = checks.filter((c) => c.observation && !c.pass);
const out = {
  phase: "D5-03 第九批 · 独立验收 · R1 观察（newSession 无界）",
  findingsNote: "observation=true 的条目是本次独立验收**发现**（如实记录，不参与判分，也不在本批可写面内修）",
  codeFacts: {
    "electron/harness-adapter.cjs:272-275": "#withTimeout(this.conn.initialize(...), startTimeoutMs, START_TIMEOUT) —— 只有 initialize 有上界",
    "electron/harness-adapter.cjs:278": "const session = await this.conn.newSession({...}) —— **裸 await，无任何超时**",
  },
  injectedStartTimeoutMs: 700,
  productDefaultStartTimeoutMs: (fs.readFileSync(path.join(ROOT, "electron/task-harness-orchestrator.cjs"), "utf8").match(/DEFAULT_START_TIMEOUT_MS = (\d+)/) || [])[1],
  results, checks,
  counts: { total: checks.length, pass: checks.filter((c) => c.pass).length, fail: counted.filter((c) => !c.pass).length, observations: checks.filter((c) => c.observation).length, observationFindings: findings.length },
  findings: findings.map((c) => c.id + " " + c.name + " → " + c.actual),
  reproduced: R1.settledWithinWatchWindow === false,
  at: new Date().toISOString(),
};
fs.writeFileSync(path.join(HERE, "batch9-04-r1-observation.json"), JSON.stringify(out, null, 2));
console.log("");
console.log("R1 复现：" + (out.reproduced ? "是（未收敛）" : "否（已收敛）"));
console.log("R1 阶段时间线：" + R1.timeline.map((m) => "+" + m.atMs.toFixed(1) + "ms " + m.name + (m.detail ? " " + m.detail : "")).join(" | "));
console.log("对照阶段时间线：" + C.timeline.map((m) => "+" + m.atMs.toFixed(1) + "ms " + m.name + (m.detail ? " " + m.detail : "")).join(" | "));
console.log("负载：" + JSON.stringify(R1.load));
console.log("计数：" + JSON.stringify(out.counts));
console.log("观察项（finding）：" + JSON.stringify(out.findings));
process.exit(out.counts.fail ? 1 : 0);
