/**
 * D5-03 第十二批 · 真实 Electron 取消路径验收（隔离安装，**只启动两次**）。
 *
 * 第一次启动：真实 Electron + 真实 dist/preload/IPC + 真实 createOpenArcRuntime + 真实
 * HarnessAdapter/TaskHarnessOrchestrator；受控慢 Provider（独立进程）；经**产品真实 IPC 入口**
 * `task:command` 的 `task/cancel` 取消一个 provider 已收到请求的任务，记录 runTask 收敛时间与
 * 退出前账本；随后正常退出（复用第十一批的真实退出收尾）。
 * 第二次启动：同一 userData 重开，只读打印库中事实（任务 / 步骤 / run / call 四处）。
 *
 * 判据：runTask 有界返回 HARNESS_CANCELLED；恰好一个 call 且终态 CANCELLED、completed_at 已写、
 * provider_error_code 为空；0 产物；能力撤销；0 孤儿；重开后四处状态一致且仍为 CANCELLED。
 *
 * 运行：node experiments/d5-03/batch12/verify/electron-cancel-e2e.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const APP_DIR = path.join(ROOT, "experiments/d5-03/batch12/verify/app");
const RUN_DIR = process.env.OA_B12_RUN_DIR || path.join(ROOT, "experiments/d5-03/batch12/verify/runs", new Date().toISOString().replace(/[:.]/g, "-"));
const ELECTRON_ARGS = (process.env.OA_B12_ELECTRON_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const LIMIT_MS = Number(process.env.OA_B12_LIMIT_MS || 60000);

fs.mkdirSync(RUN_DIR, { recursive: true });
const checks = [];
const record = (name, ok, detail = "") => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function processTable() {
  try {
    const out = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
    return out.split("\n").map((line) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line); return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : null; }).filter(Boolean);
  } catch { return []; }
}
function descendantsOf(rootPid) {
  const table = processTable();
  const byParent = new Map();
  for (const p of table) { if (!byParent.has(p.ppid)) byParent.set(p.ppid, []); byParent.get(p.ppid).push(p); }
  const out = []; const stack = [rootPid];
  while (stack.length) { const pid = stack.pop(); for (const c of byParent.get(pid) || []) { out.push(c); stack.push(c.pid); } }
  return out;
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

async function launch({ scenario, userDataDir, taskId = null, label }) {
  const outDir = path.join(RUN_DIR, label);
  fs.mkdirSync(outDir, { recursive: true });
  const child = spawn(electronPath, [APP_DIR, "--user-data-dir=" + userDataDir, ...ELECTRON_ARGS], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OPENARC_IDENTITY_ADMIN: "1", OA_B11_SCENARIO: scenario, OA_B11_OUT: outDir, ...(taskId ? { OA_B11_TASK_ID: taskId } : {}) },
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  const t0 = Date.now();
  let descended = 0;
  const poll = setInterval(() => { descended = Math.max(descended, descendantsOf(child.pid).length); }, 50);
  const fuse = setTimeout(() => { for (const p of [child.pid, ...descendantsOf(child.pid).map((x) => x.pid)]) { try { process.kill(p, "SIGKILL"); } catch { /* ignore */ } } }, LIMIT_MS);
  const code = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
  clearInterval(poll); clearTimeout(fuse);
  fs.writeFileSync(path.join(outDir, "stdout.txt"), stdout);
  fs.writeFileSync(path.join(outDir, "stderr.txt"), stderr);
  await sleep(150);
  const leftovers = [child.pid, ...descendantsOf(child.pid).map((x) => x.pid)].filter(pidAlive);
  const readJson = (n) => { try { return JSON.parse(fs.readFileSync(path.join(outDir, n), "utf8")); } catch { return null; } };
  const grab = (re) => { const m = re.exec(stdout); return m ? JSON.parse(m[1]) : null; };
  return {
    label, outDir, exitCode: code, wallMs: Date.now() - t0, descended, leftovers, stdout, stderr,
    preQuit: readJson("pre-quit.json"), converged: grab(/PROBE_RUN_CONVERGED (\{.*\})/), ipcCancel: grab(/PROBE_IPC_CANCEL (\{.*\})/),
    phase: grab(/PROBE_PHASE (\{.*\})/), ipcState: readJson("ipc-state.json"),
  };
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-b12-electron-"));
const first = await launch({ scenario: "ipc-cancel", userDataDir, label: "ipc-cancel" });
record("真实 Electron 退出码 0", first.exitCode === 0, "exit=" + first.exitCode);
record("在途 harness 子进程确实存在过（不是空跑）", first.descended > 0, "maxDescendants=" + first.descended);
record("阶段：provider 已收到请求", !!first.phase && first.phase.ok === true, JSON.stringify(first.phase));
record("真实 IPC task/cancel 返回 ok", !!first.ipcCancel && first.ipcCancel.ok === true, JSON.stringify(first.ipcCancel));

// runTask 收敛：从应用日志里直接观察（探针在 IPC 取消后 await running）
const convergedLine = /PROBE_RUN_CONVERGED (\{.*\})/.exec(first.stdout);
record("runTask 有界返回且为取消", !!convergedLine && JSON.parse(convergedLine[1]).done === "resolved" && JSON.parse(convergedLine[1]).cancelled === true, convergedLine ? convergedLine[1] : "no line");
const converged = convergedLine ? JSON.parse(convergedLine[1]) : null;
record("runTask 收敛 < 25s 上界（实测远小）", !!converged && converged.elapsedMs < 25000, converged ? "elapsedMs=" + converged.elapsedMs : "n/a");

const dbFile = path.join(userDataDir, "identity.db");
const taskId = first.preQuit && first.preQuit.tasks[0] ? first.preQuit.tasks[0].taskId : null;
record("退出前账本：call 唯一且已取消", !!first.preQuit && first.preQuit.tasks[0].calls.length === 1 && first.preQuit.tasks[0].calls[0].status === "CANCELLED", JSON.stringify(first.preQuit && first.preQuit.tasks[0].calls));
record("退出后无孤儿进程", first.leftovers.length === 0, JSON.stringify(first.leftovers));

// 只读重开：四处状态
function readState() {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return {
      integrity: Object.values(db.prepare("PRAGMA integrity_check").get())[0],
      task: db.prepare("SELECT status, cancel_requested FROM tasks WHERE task_id = ?").get(taskId),
      step: db.prepare("SELECT status FROM task_steps WHERE task_id = ?").get(taskId),
      run: db.prepare("SELECT status, error_code FROM task_harness_runs WHERE task_id = ?").get(taskId),
      call: db.prepare("SELECT status, completed_at, provider_error_code FROM task_model_calls WHERE task_id = ?").get(taskId),
      calls: db.prepare("SELECT COUNT(*) AS n FROM task_model_calls WHERE task_id = ?").get(taskId),
      artifacts: db.prepare("SELECT COUNT(*) AS n FROM task_artifacts WHERE task_id = ?").get(taskId),
      events: db.prepare("SELECT event_type FROM task_events WHERE task_id = ? ORDER BY sequence").all(taskId).map((e) => e.event_type),
    };
  } finally { db.close(); }
}
const state = readState();
record("重开库可读（integrity_check ok）", state.integrity === "ok", state.integrity);
record("重开后：task/step/run 三处 CANCELLED", state.task.status === "CANCELLED" && state.step.status === "CANCELLED" && state.run.status === "CANCELLED", JSON.stringify({ task: state.task, step: state.step, run: state.run }));
record("重开后：恰好一个 call 且 CANCELLED + completed_at 已写 + 无 Provider 失败码", state.calls.n === 1 && state.call.status === "CANCELLED" && state.call.completed_at != null && state.call.provider_error_code == null, JSON.stringify({ calls: state.calls, call: state.call }));
record("重开后：0 产物", state.artifacts.n === 0, JSON.stringify(state.artifacts));
record("重开后：有 model.call.cancelled 事件、无 model.call.failed/completed", state.events.includes("model.call.cancelled") && !state.events.includes("model.call.failed") && !state.events.includes("model.call.completed"), JSON.stringify(state.events));

// 第二次启动：真实重启路径读同一 userData（只读观测，防漂移）
const second = await launch({ scenario: "ipc-state", userDataDir, taskId, label: "ipc-state" });
record("第二次启动退出码 0", second.exitCode === 0, "exit=" + second.exitCode);
const st = second.ipcState ? second.ipcState.facts : null;
record("重启后仍是 CANCELLED（取消终态不被恢复流程改写）", !!st && st.taskStatus === "CANCELLED" && st.runs[0].status === "CANCELLED", JSON.stringify(st && { task: st.taskStatus, runs: st.runs, calls: st.calls }));
record("重启后 call 仍 CANCELLED 且无 Provider 失败码", !!st && st.calls.length === 1 && st.calls[0].status === "CANCELLED" && !st.calls[0].providerErrorCode, JSON.stringify(st && st.calls));
record("第二次启动无孤儿", second.leftovers.length === 0, JSON.stringify(second.leftovers));

/* 收尾自检：按命令行标记清掉本批自己起的进程（不用宽泛 pkill，也不动别的应用） */
const MARKERS = ["OpenArc OS-integration/experiments/d5-03/batch12", "OpenArc OS-integration/tests/fixtures/harness-acp"];
function sweep() {
  const hit = processTable().filter((p) => MARKERS.some((m) => p.cmd.includes(m)));
  for (const p of hit) { try { process.kill(p.pid, "SIGKILL"); } catch { /* 已退出 */ } }
  return hit.map((p) => p.pid);
}
sweep();
await sleep(400);
const remaining = processTable().filter((p) => MARKERS.some((m) => p.cmd.includes(m))).map((p) => p.pid);
record("本批无残留进程", remaining.length === 0, JSON.stringify(remaining));

const pass = checks.filter((c) => c.ok).length;
const fail = checks.length - pass;
fs.writeFileSync(path.join(RUN_DIR, "batch12-electron-cancel.json"), JSON.stringify({ at: new Date().toISOString(), counts: { total: checks.length, pass, fail }, checks, taskId, state, converged }, null, 2));
console.log("\n计数：" + JSON.stringify({ total: checks.length, pass, fail }));
console.log("结论：" + (fail === 0 ? "PASS" : "FAIL"));
process.exit(fail === 0 ? 0 : 1);
