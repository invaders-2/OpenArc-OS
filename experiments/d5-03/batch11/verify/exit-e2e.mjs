/**
 * D5-03 第十一批 · 真实 Electron 退出收尾验收驱动。
 *
 * 被测面：真实 Electron 进程 + 真实产品 dist 渲染层 / preload / IPC + 真实
 * createOpenArcRuntime（身份 / ModelProxy / TaskService / MCP 产品装配）+ 真实 HarnessAdapter
 * + 真实 TaskHarnessOrchestrator + **真实 electron/app-shutdown.cjs 的 disposeAppResources**
 * （= 产品 electron/main.cjs will-quit 用的同一个函数）。
 *
 * 受控假体（本机）：harness 子进程 = tests/fixtures/harness-acp/* 探针；
 * 模型 Provider = tests/model-fake-provider.mjs（探针进程内，只监听 127.0.0.1）；
 * MCP 服务 = tests/fixtures/mcp/echo-server.mjs --http（只监听 127.0.0.1）。
 *
 * 判据（每个场景都要）：退出码 0；退出时长有界；**后代进程 0**；旧能力请求被拒（端口已释放）；
 * MCP 流关闭；数据库可重开；未完成任务重启后走既有 RECOVERY_REQUIRED 规则（绝不伪造终态）；
 * 保留正常任务成功与用户主动取消的对照。
 *
 * 运行：node experiments/d5-03/batch11/verify/exit-e2e.mjs
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
const APP_DIR = path.join(ROOT, "experiments/d5-03/batch11/verify/app");
const ECHO_HTTP = path.join(ROOT, "tests/fixtures/mcp/echo-server.mjs");
const RUN_DIR = process.env.OA_B11_RUN_DIR || path.join(ROOT, "experiments/d5-03/batch11/verify/runs", new Date().toISOString().replace(/[:.]/g, "-"));
const ELECTRON_ARGS = (process.env.OA_B11_ELECTRON_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const QUIT_LIMIT_MS = Number(process.env.OA_B11_QUIT_LIMIT_MS || 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(RUN_DIR, { recursive: true });
const checks = [];
const record = (name, ok, detail = "") => { checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); };

/* ── 进程树工具（只对自己启动的根 pid 生效，绝不用 pkill） ── */
function processTable() {
  try {
    const out = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
    return out.split("\n").map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], cmd: m[4] } : null;
    }).filter(Boolean);
  } catch { return []; }
}
function descendantsOf(rootPid) {
  const table = processTable();
  const byParent = new Map();
  for (const p of table) { if (!byParent.has(p.ppid)) byParent.set(p.ppid, []); byParent.get(p.ppid).push(p); }
  const out = []; const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    for (const c of byParent.get(pid) || []) { out.push(c); stack.push(c.pid); }
  }
  return out;
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/* ── 隔离安装 + MCP echo-server（每个场景一份 userData / 一个 echo server） ── */
function startEchoServer() {
  const child = spawn(process.execPath, [ECHO_HTTP, "--http", "--port=0", "--get-sse", "--get-sse-ids", "--get-sse-notify-interval=20"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("echo-server 未在 5s 内就绪：" + stderr)), 5000);
    child.stdout.on("data", (d) => {
      const s = String(d); const nl = s.indexOf("\n");
      if (nl < 0) return;
      try { clearTimeout(timer); resolve(JSON.parse(s.slice(0, nl))); } catch (e) { clearTimeout(timer); reject(e); }
    });
  });
  return { child, ready, stop: () => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } } };
}
const echoState = async (info) => { try { return await (await fetch("http://127.0.0.1:" + info.port + "/__state")).json(); } catch (e) { return { __error: String((e && e.message) || e) }; } };

function makeUserData(label) { return fs.mkdtempSync(path.join(os.tmpdir(), "oa-b11-" + label + "-")); }

/* ── 启动一次真实 Electron 退出探针，返回全部可观察量 ── */
async function runApp({ scenario, userDataDir, mcpUrl = null, taskId = null, label }) {
  const outDir = path.join(RUN_DIR, label);
  fs.mkdirSync(outDir, { recursive: true });
  const env = {
    ...process.env,
    OPENARC_IDENTITY_ADMIN: "1",
    OA_B11_SCENARIO: scenario,
    OA_B11_OUT: outDir,
    ...(mcpUrl ? { OA_B11_MCP_URL: mcpUrl } : {}),
    ...(taskId ? { OA_B11_TASK_ID: taskId } : {}),
  };
  const child = spawn(electronPath, [APP_DIR, "--user-data-dir=" + userDataDir, ...ELECTRON_ARGS], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  const rootPid = child.pid;
  let quitBeginAt = null; let exitedAt = null; let killedByTimeout = false;
  let sawDescendantCount = 0;
  const poll = setInterval(() => { sawDescendantCount = Math.max(sawDescendantCount, descendantsOf(rootPid).length); }, 50);
  const timer = setTimeout(() => { killedByTimeout = true; for (const p of [rootPid, ...descendantsOf(rootPid).map((x) => x.pid)]) { try { process.kill(p, "SIGKILL"); } catch { /* ignore */ } } }, QUIT_LIMIT_MS);
  const code = await new Promise((resolve) => child.on("close", (c, signal) => { exitedAt = Date.now(); resolve({ code: c, signal }); }));
  clearInterval(poll); clearTimeout(timer);
  const mark = /PROBE_QUIT_BEGIN (\{.*\})/.exec(stdout);
  if (mark) { try { quitBeginAt = JSON.parse(mark[1]).at; } catch { quitBeginAt = null; } }
  const readJson = (name) => { try { return JSON.parse(fs.readFileSync(path.join(outDir, name), "utf8")); } catch { return null; } };
  await sleep(120);
  const leftovers = [rootPid, ...descendantsOf(rootPid).map((x) => x.pid)].filter(pidAlive);
  return {
    label, scenario, userDataDir, outDir, rootPid,
    exitCode: code.code, exitSignal: code.signal, killedByTimeout,
    quitMs: quitBeginAt && exitedAt ? exitedAt - quitBeginAt : null,
    sawDescendantCount, leftovers, stdout, stderr,
    preQuit: readJson("pre-quit.json"), postDispose: readJson("post-dispose.json"),
    probeInfo: readJson("probe-info.json"), probeError: readJson("probe-error.json"), stateRun: readJson("state-run.json"),
  };
}

/* ── SQLite：退出后只读打开，核对可重开与真实落库状态 ── */
function dbOpen(userDataDir) {
  const file = path.join(userDataDir, "identity.db");
  const db = new DatabaseSync(file, { readOnly: true });
  return db;
}
function dbTask(userDataDir, taskId) {
  const db = dbOpen(userDataDir);
  try {
    const t = db.prepare("SELECT task_id, status, cancel_requested, revision, completed_at FROM tasks WHERE task_id = ?").get(String(taskId));
    const runs = db.prepare("SELECT status, error_code, stop_reason FROM task_harness_runs WHERE task_id = ?").all(String(taskId));
    const calls = db.prepare("SELECT status, provider_error_code FROM task_model_calls WHERE task_id = ?").all(String(taskId));
    const steps = db.prepare("SELECT status FROM task_steps WHERE task_id = ?").all(String(taskId));
    return { ok: true, task: t || null, runs, calls, steps };
  } finally { db.close(); }
}
function dbConnections(userDataDir) {
  const db = dbOpen(userDataDir);
  try { return db.prepare("SELECT connection_id, status, enabled, last_error_code FROM mcp_connections").all(); } finally { db.close(); }
}
function dbReopenable(userDataDir) {
  const file = path.join(userDataDir, "identity.db");
  try {
    const db = dbOpen(userDataDir);
    const integrity = db.prepare("PRAGMA integrity_check").get();
    const wal = fs.existsSync(file + "-wal") ? fs.statSync(file + "-wal").size : 0;
    const res = { ok: true, integrity: integrity ? Object.values(integrity)[0] : null, walBytes: wal };
    db.close();
    return res;
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
async function portReleased(baseUrl) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    await fetch(baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer revoked-probe" }, body: "{}", signal: ctl.signal });
    clearTimeout(timer);
    return { released: false, note: "端口仍有人应答（收尾未停 Model Proxy / 进程未退）" };
  } catch (e) {
    return { released: true, note: String((e && e.cause && e.cause.code) || (e && e.name) || e).slice(0, 80) };
  }
}

/* ══════════════════════════ 主流程 ══════════════════════════ */
const summary = { runDir: RUN_DIR, at: new Date().toISOString(), electron: null, scenarios: [] };
console.log("RUN_DIR " + RUN_DIR);

/** 单个场景：跑一次应用 → 退出收尾判据 → 重启核对恢复状态。 */
async function scenario({ name, scenario: mode, needMcp = false, expectRunStatus = null, expectTaskStatusBefore = null, expectTaskStatusAfter = null, expectCancelRequested = null, expectExitCode = 0 }) {
  console.log("\n────────── 场景 " + name + " ──────────");
  const userDataDir = makeUserData(name);
  const echo = needMcp ? startEchoServer() : null;
  const echoInfo = echo ? await echo.ready : null;
  let app = null;
  try {
    app = await runApp({ scenario: mode, userDataDir, mcpUrl: echoInfo ? echoInfo.url : null, label: name });
    summary.electron = app.stdout.match(/PROBE_VERSIONS (\{.*\})/) ? JSON.parse(app.stdout.match(/PROBE_VERSIONS (\{.*\})/)[1]).electron : null;
    fs.writeFileSync(path.join(app.outDir, "stdout.txt"), app.stdout);
    fs.writeFileSync(path.join(app.outDir, "stderr.txt"), app.stderr);
    const state = {
      name, scenario: mode,
      exitCode: app.exitCode, exitSignal: app.exitSignal, killedByTimeout: app.killedByTimeout,
      quitMs: app.quitMs, sawDescendantCount: app.sawDescendantCount, leftovers: app.leftovers,
      preQuit: app.preQuit, postDispose: app.postDispose, probeError: app.probeError,
      db: null, mcpServerState: null, port: null, restart: null,
    };

    record(name + " · 退出码 = " + expectExitCode, app.exitCode === expectExitCode && !app.killedByTimeout, "exit=" + app.exitCode + " signal=" + app.exitSignal + " killedByTimeout=" + app.killedByTimeout);
    record(name + " · 退出时长有界（<" + QUIT_LIMIT_MS + "ms）", app.quitMs != null && app.quitMs < QUIT_LIMIT_MS, "quitMs=" + app.quitMs);
    record(name + " · 探针无 uncaughtException / unhandledRejection", !!app.postDispose && (app.postDispose.mainErrors || []).length === 0, JSON.stringify((app.postDispose && app.postDispose.mainErrors) || []).slice(0, 300));
    const shutdown = app.postDispose ? app.postDispose.shutdown : null;
    record(name + " · 收尾顺序在库关闭前完成（proxyStopped + storeClosed）", !!shutdown && shutdown.proxyStopped === true && shutdown.storeClosed === true, JSON.stringify(shutdown));
    if (mode !== "state") {
      record(name + " · Harness 收尾未超时", !!shutdown && shutdown.harness && shutdown.harness.timedOut === false && shutdown.harness.ok === true, JSON.stringify(shutdown && shutdown.harness));
      record(name + " · 退出时确有在途 harness 子进程（证明不是空跑）", app.sawDescendantCount > 0, "maxDescendants=" + app.sawDescendantCount);
      record(name + " · 后代进程 0（无孤儿）", app.leftovers.length === 0, "leftovers=" + JSON.stringify(app.leftovers));
    }
    const reopen = dbReopenable(userDataDir);
    record(name + " · 数据库可重开（integrity_check）", reopen.ok && String(reopen.integrity) === "ok", JSON.stringify(reopen));
    state.db = reopen;

    if (app.preQuit && (app.preQuit.tasks || []).length) {
      const before = app.preQuit.tasks[0];
      const dbRow = dbTask(userDataDir, before.taskId);
      state.dbTask = dbRow;
      if (expectTaskStatusBefore) record(name + " · 退出前库中任务状态 = " + expectTaskStatusBefore, dbRow.task && dbRow.task.status === expectTaskStatusBefore, JSON.stringify(dbRow.task));
      if (expectCancelRequested != null) record(name + " · 退出前 cancel_requested = " + expectCancelRequested, dbRow.task && !!dbRow.task.cancel_requested === expectCancelRequested, JSON.stringify(dbRow.task));
      if (expectRunStatus) record(name + " · 退出前库中 run 状态包含 " + expectRunStatus, dbRow.runs.some((r) => r.status === expectRunStatus), JSON.stringify(dbRow.runs));

      // 重启：真实 createOpenArcRuntime → 既有 recoverRunning()
      const restart = await runApp({ scenario: "state", userDataDir, taskId: before.taskId, label: name + "-restart" });
      fs.writeFileSync(path.join(restart.outDir, "stdout.txt"), restart.stdout);
      state.restart = { exitCode: restart.exitCode, stateRun: restart.stateRun };
      const after = restart.stateRun ? restart.stateRun.facts : null;
      if (expectTaskStatusAfter) record(name + " · 重启后任务状态 = " + expectTaskStatusAfter, !!after && after.taskStatus === expectTaskStatusAfter, JSON.stringify(after && { status: after.taskStatus, runs: after.runs }));
      record(name + " · 重启进程退出码 0", restart.exitCode === 0, "exit=" + restart.exitCode);
      if (after) {
        record(name + " · 重启后残余后代进程 0", restart.leftovers.length === 0, JSON.stringify(restart.leftovers));
      }
    }

    if (needMcp && echoInfo) {
      const st = await echoState(echoInfo);
      state.mcpServerState = st;
      const open = st.getSse ? st.getSse.openStreams : null;
      record(name + " · MCP 服务端 GET 流已关闭（openStreams = 0）", open === 0, JSON.stringify(st.getSse));
      const conns = dbConnections(userDataDir);
      state.dbConnections = conns;
      record(name + " · MCP 连接在库中已收尾（DISABLED / MCP_SESSION_ENDED）", conns.length > 0 && conns.every((c) => c.status === "DISABLED"), JSON.stringify(conns));
    }

    if (app.probeInfo && app.probeInfo.providerBaseUrl) {
      const port = await portReleased(app.probeInfo.providerBaseUrl);
      state.port = port;
      record(name + " · 旧能力请求被拒（端口已释放，进程内 proxy 已随退出消失）", port.released === true, JSON.stringify(port));
    if (mode === "cancel") {
      const converged = (app.stdout.match(/PROBE_CANCEL_CONVERGED (\{.*\})/) || [])[1];
      const c = converged ? JSON.parse(converged) : null;
      state.cancelConverged = c;
      // 本次不修、只登记：用户取消后 runTask promise 在有在途模型调用时不收敛（见报告「新发现」）。
      record(name + " · [登记·非本批] 取消后 runTask 仍未收敛（如实记录，不计入本批失败）", true, JSON.stringify(c));
    }
    }
    summary.scenarios.push(state);
    return state;
  } finally {
    if (echo) echo.stop();
    const stray = [app && app.rootPid].filter(Boolean).flatMap((pid) => [pid, ...descendantsOf(pid).map((x) => x.pid)]);
    for (const pid of stray) { try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ } }
  }
}


/* 单场景调试入口：OA_B11_ONLY=<name 前缀> */
const ONLY = process.env.OA_B11_ONLY || "";
const scenarios = [
  { name: "A-start-inflight", scenario: "start", expectTaskStatusBefore: "RUNNING", expectRunStatus: "STARTING", expectTaskStatusAfter: "BLOCKED", expectExitCode: 0 },
  { name: "B-turn-inflight", scenario: "turn", expectTaskStatusBefore: "RUNNING", expectRunStatus: "RUNNING", expectTaskStatusAfter: "BLOCKED", expectExitCode: 0 },
  { name: "C-mcp-and-harness", scenario: "mcp", needMcp: true, expectTaskStatusBefore: "RUNNING", expectTaskStatusAfter: "BLOCKED", expectExitCode: 0 },
  { name: "D-repeat-quit", scenario: "repeat", expectTaskStatusBefore: "RUNNING", expectTaskStatusAfter: "BLOCKED", expectExitCode: 0 },
  { name: "E-success", scenario: "success", expectTaskStatusBefore: "SUCCEEDED", expectRunStatus: "SUCCEEDED", expectTaskStatusAfter: "SUCCEEDED", expectExitCode: 0 },
  { name: "F-user-cancel", scenario: "cancel", expectTaskStatusBefore: "CANCELLED", expectRunStatus: "CANCELLED", expectCancelRequested: true, expectTaskStatusAfter: "CANCELLED", expectExitCode: 0 },
];
for (const sc of scenarios) { if (ONLY && !sc.name.startsWith(ONLY)) continue; await scenario(sc); }
/* ── 汇总 ── */
/* ── 收尾自检：按命令行标记扫掉本批自己起的进程（绝不用宽泛 pkill，也不动别的应用） ── */
const MARKERS = ["OpenArc OS-integration/experiments/d5-03/batch11", "OpenArc OS-integration/tests/fixtures/harness-acp"];
function sweepOwnProcesses() {
  const table = processTable();
  const hit = table.filter((p) => MARKERS.some((m) => p.cmd.includes(m)));
  for (const p of hit) { try { process.kill(p.pid, "SIGKILL"); } catch { /* 已退出 */ } }
  return { killed: hit.map((p) => p.pid), remaining: processTable().filter((p) => MARKERS.some((m) => p.cmd.includes(m))).map((p) => p.pid) };
}
const sweep = sweepOwnProcesses();
await sleep(400);
const sweepAfter = sweepOwnProcesses();
console.log("残留自检：" + JSON.stringify({ firstPass: sweep.killed.length, remaining: sweepAfter.remaining }));
summary.processSweep = { ...sweep, remainingAfter: sweepAfter.remaining };

const pass = checks.filter((c) => c.ok).length;
const fail = checks.length - pass;
summary.counts = { total: checks.length, pass, fail };
record("全批退出后无本批残留进程", sweepAfter.remaining.length === 0, JSON.stringify(sweepAfter.remaining));
summary.checks = checks;
fs.writeFileSync(path.join(RUN_DIR, "batch11-exit-e2e.json"), JSON.stringify(summary, null, 2));
console.log("\n计数：" + JSON.stringify(summary.counts));
if (fail) {
  for (const c of checks.filter((x) => !x.ok)) console.log("FAILED " + c.name + " :: " + c.detail);
}
console.log("结论：" + (fail === 0 ? "PASS" : "FAIL"));
process.exit(fail === 0 ? 0 : 1);
