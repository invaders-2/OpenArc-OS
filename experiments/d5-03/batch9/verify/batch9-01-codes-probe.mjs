/**
 * D5-03 第九批 · 独立验收（执行岗）· 第一段：两种超时错误码的真实产品分类路径 + 反向验证 + 竞争。
 *
 * 不 mock 产品：真实 HarnessAdapter（spawn 真实子进程 + 真实 ACP + 真实 SDK）、真实 TaskService、
 * 真实 TaskStore（:memory:）、真实 ModelProxy、真实 TaskHarnessOrchestrator、真实 classifyHarnessError。
 * 唯一的可控项（任务书明确允许）：
 *   · 用既有夹具探针 tests/fixtures/harness-acp/{start,turn}-hang-agent.mjs 充当 Harness 进程；
 *   · 用**构造参数**注入更小的 startTimeoutMs / turnTimeoutMs（产品默认 30000/180000 一字未改）。
 *
 * 反向验证：把产品 orchestrator 源码**复制**到本目录，只在副本里把分类器改回旧映射
 * （HARNESS_START_TIMEOUT → ERROR.HARNESS_TURN_TIMEOUT），跑启动阻塞用例必须变红；验完删除副本。
 *
 * 用法：node experiments/d5-03/batch9/verify/batch9-01-codes-probe.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createTaskHarnessFixture } from "../../../../tests/fixtures/harness-acp/task-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const ELECTRON = path.join(ROOT, "electron");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const fileSha = (p) => sha256(fs.readFileSync(p));

const { classifyHarnessError } = require(path.join(ELECTRON, "task-harness-orchestrator.cjs"));
const { ERROR } = require(path.join(ELECTRON, "task-domain.cjs"));

const ROWS = [], RAW = {};
const row = (id, name, expected, actual, pass, expectRed = false) => {
  const r = { id, name, expected: String(expected), actual: String(actual).slice(0, 2000), pass: !!pass, intentionalRed: !!expectRed };
  ROWS.push(r);
  // 反向验证用例：**故意**期望产品给出旧（错）行为；变红才是通过。
  const tag = expectRed ? (r.pass ? "! [UNEXPECTED-GREEN] " : "  [EXPECTED-RED] ") : (r.pass ? "  [PASS] " : "! [FAIL] ");
  console.log(tag + id + " · " + name + (r.pass && !expectRed ? "" : " — 期望 " + r.expected + "，实际 " + r.actual));
  return r;
};
const eq = (id, name, expected, actual) => row(id, name, JSON.stringify(expected), JSON.stringify(actual), JSON.stringify(expected) === JSON.stringify(actual));

/* ── 进程存活/孤儿观测（只观测，不杀别人的进程） ── */
function psRows() {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" })
      .split("\n").map((l) => { const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m ? { pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], cmd: m[4] } : null; })
      .filter(Boolean);
  } catch { return []; }
}
const pidInfo = (pid) => psRows().find((r) => r.pid === pid) || null;
const pidAlive = (pid) => { const i = pidInfo(pid); return !!i && !i.stat.startsWith("Z"); };

/** 记录本次运行自己 spawn 的 harness 子进程（pid/命令行），收尾逐条证明已消失。 */
function trackingFactory(baseFactory, spawned) {
  return (opts) => {
    const adapter = baseFactory(opts);
    spawned.push(adapter);
    return adapter;
  };
}
async function orphanReport(spawned) {
  const items = spawned.map((a) => {
    const pid = a.child ? a.child.pid : null;
    const info = pid ? pidInfo(pid) : null;
    return {
      pid,
      cmd: info ? info.cmd.slice(0, 160) : null,
      processExitedFlag: a.processExited === true,
      alive: pid ? pidAlive(pid) : false,
      zombie: !!(info && info.stat.startsWith("Z")),
    };
  });
  const scan = psRows().filter((r) => /start-hang-agent\.mjs|turn-hang-agent\.mjs/.test(r.cmd)).map((r) => ({ pid: r.pid, ppid: r.ppid, stat: r.stat, cmd: r.cmd.slice(0, 160) }));
  return { mine: items, leftoverAlive: items.filter((i) => i.alive).map((i) => i.pid), globalScanHits: scan, globalScanCount: scan.length };
}

/** 能力残留：状态 + **行为**（用被撤销的 token 真打 Model Proxy，必须 401）。 */
async function capabilityReport(fx) {
  const entries = [...fx.proxy.capabilities.entries()];
  const states = entries.map(([token, cap]) => ({ capabilityId: cap.capabilityId, state: cap.state, remaining: cap.remaining, binding: cap.binding || null, tokenLen: String(token).length }));
  const probes = [];
  for (const [token] of entries) {
    try {
      const res = await fetch(fx.proxy.baseUrl + "/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ model: "x", messages: [] }) });
      probes.push({ status: res.status, body: (await res.text()).slice(0, 200) });
    } catch (e) { probes.push({ status: null, error: String(e && e.message) }); }
  }
  return {
    issued: states.length,
    states,
    allRevoked: states.length > 0 && states.every((s) => s.state === "REVOKED"),
    behavioralProbes: probes,
    behavioralAll401: probes.length > 0 && probes.every((p) => p.status === 401),
    liveChildRefs: fx.proxy ? null : null,
  };
}

function runsOf(fx, ctx, taskId) {
  const runs = fx.taskService.getHarnessRuns({ context: ctx, taskId });
  return runs.ok ? runs.items : { error: runs.error };
}
function snapshot(fx, ctx, taskId) {
  const task = fx.taskService.getTask({ context: ctx, taskId });
  const calls = fx.taskService.getCalls({ context: ctx, taskId });
  const arts = fx.taskService.getArtifacts({ context: ctx, taskId });
  const evs = fx.taskService.getEvents({ context: ctx, taskId });
  return {
    task: task.ok ? { status: task.task.status, revision: task.task.revision, cancelRequested: task.task.cancelRequested === true } : { error: task.error },
    runs: runsOf(fx, ctx, taskId),
    calls: calls.ok ? calls.items.map((c) => ({ callId: c.callId, status: c.status, providerErrorCode: c.providerErrorCode || null })) : { error: calls.error },
    artifacts: arts.ok ? arts.items.length : { error: arts.error },
    events: evs.ok ? evs.items.filter((e) => /blocked|cancel|unknown_effect/.test(e.eventType)).map((e) => ({ eventType: e.eventType, safePayload: e.safePayload })) : { error: evs.error },
  };
}

/** 一次真实 run：注入预算 + 既有阻塞探针；返回 expected/actual 全量可核对的原始事实。 */
async function runScenario({ id, agentFile, startTimeoutMs, turnTimeoutMs, cancelAtMs = null, cancelAfterPrompt = false, PatchedOrchestrator = null }) {
  const fx = await createTaskHarnessFixture();
  const spawned = [];
  const calls = { starts: 0, prompts: 0 };
  let orch = null;
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const base = fx.agentFactory(agentFile);
    const factory = trackingFactory(base, spawned);
    const counted = (opts) => {
      const a = factory(opts);
      const s = a.start.bind(a), p = a.prompt.bind(a);
      a.start = async (x) => { calls.starts += 1; return await s(x); };
      a.prompt = async (x, o) => { calls.prompts += 1; return await p(x, o); };
      return a;
    };
    orch = PatchedOrchestrator
      ? new PatchedOrchestrator({ taskService: fx.taskService, adapterFactory: counted, clock: fx.f.clock, startTimeoutMs, turnTimeoutMs })
      : fx.makeOrchestrator(counted, { startTimeoutMs, turnTimeoutMs });

    const providerBefore = fx.fp.state.requests;
    const t0 = Date.now();
    const runP = orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    let cancelAt = null, cancelResult = null, promptSeenAt = null, timeline = [];
    if (cancelAtMs != null || cancelAfterPrompt) {
      if (cancelAfterPrompt) {
        const dl = Date.now() + 20000;
        while (calls.prompts < 1 && Date.now() < dl) await sleep(10);
        promptSeenAt = Date.now() - t0;
        timeline.push({ atMs: promptSeenAt, what: "adapter:prompt:begin (prompts=" + calls.prompts + ")" });
        await sleep(120);
      } else {
        await sleep(cancelAtMs);
      }
      cancelAt = Date.now() - t0;
      const fresh = fx.taskService.getTask({ context: ctx, taskId: t.task.taskId });
      cancelResult = await orch.cancel({ context: ctx, taskId: t.task.taskId, expectedRevision: fresh.task ? fresh.task.revision : undefined });
      timeline.push({ atMs: Date.now() - t0, what: "orch.cancel → " + JSON.stringify({ ok: cancelResult.ok, cancelled: !!cancelResult.cancelled, error: cancelResult.error || null }) });
    }
    const runResult = await runP;
    const elapsedMs = Date.now() - t0;
    const afterRun = snapshot(fx, ctx, t.task.taskId);
    await sleep(1500);
    const afterSettle = snapshot(fx, ctx, t.task.taskId);
    const stable = JSON.stringify(afterRun.task) === JSON.stringify(afterSettle.task);
    const caps = await capabilityReport(fx);
    const orphans = await orphanReport(spawned);
    const raw = {
      id, agentFile, startTimeoutMs, turnTimeoutMs, cancelAtMs, cancelAfterPrompt,
      orchestrator: PatchedOrchestrator ? "PATCHED-COPY(old mapping)" : "product",
      elapsedMs,
      cancelAtMsActual: cancelAt, promptSeenAtMs: promptSeenAt, timeline,
      runResult: { ok: !!runResult.ok, error: runResult.error || null, blocked: !!runResult.blocked, cancelled: !!runResult.cancelled, stepStatus: runResult.step ? runResult.step.status : null, taskStatus: runResult.task ? runResult.task.status : null },
      cancelResult: cancelResult ? { ok: cancelResult.ok, cancelled: !!cancelResult.cancelled, error: cancelResult.error || null, taskStatus: cancelResult.task ? cancelResult.task.status : null } : null,
      adapterCalls: calls,
      providerRequests: { before: providerBefore, after: fx.fp.state.requests, delta: fx.fp.state.requests - providerBefore },
      afterRun, afterSettle, statusStableOver1500ms: stable,
      capabilities: caps, orphans,
      budgetsInjected: { startTimeoutMs, turnTimeoutMs },
    };
    RAW[id] = raw;
    return raw;
  } finally {
    try { await orch?.dispose(); } catch { /* ignore */ }
    try { await fx.close(); } catch { /* ignore */ }
  }
}

/** 反向验证：只在**副本**里把分类器改回旧映射。 */
function makePatchedCopy() {
  const src = fs.readFileSync(path.join(ELECTRON, "task-harness-orchestrator.cjs"), "utf8");
  const OLD_NEW = 'if (code === "HARNESS_START_TIMEOUT") return ERROR.HARNESS_START_TIMEOUT;';
  const OLD_MAP = 'if (code === "HARNESS_START_TIMEOUT") return ERROR.HARNESS_TURN_TIMEOUT;';
  const occurrences = src.split(OLD_NEW).length - 1;
  if (occurrences !== 1) throw new Error("找不到唯一的分类器行，出现次数=" + occurrences);
  const patched = src.replace(OLD_NEW, OLD_MAP).replace(/require\("\.\/([a-z0-9.-]+\.cjs)"\)/g, (m, f) => 'require(' + JSON.stringify(path.join(ELECTRON, f)) + ')');
  const copyPath = path.join(HERE, "patched-orchestrator-OLD-MAPPING.cjs");
  fs.writeFileSync(copyPath, patched);
  const mod = require(copyPath);
  return { copyPath, sha256: fileSha(copyPath), occurrences, firstLine: patched.split("\n").length, TaskHarnessOrchestrator: mod.TaskHarnessOrchestrator, classifyHarnessError: mod.classifyHarnessError, productSha256: fileSha(path.join(ELECTRON, "task-harness-orchestrator.cjs")) };
}

async function main() {
  console.log("=== 被测提交 ===");
  const head = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const porcelain = execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" });
  console.log("HEAD=" + head + "\nbranch=" + execFileSync("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim() + "\nstatus=\n" + (porcelain || "(clean)\n"));

  console.log("\n=== A. 分类器（真实产品模块，非单测替身） ===");
  eq("A1", "classifyHarnessError(HARNESS_START_TIMEOUT)", "HARNESS_START_TIMEOUT", classifyHarnessError({ code: "HARNESS_START_TIMEOUT" }));
  eq("A2", "classifyHarnessError(HARNESS_TURN_TIMEOUT)", "HARNESS_TURN_TIMEOUT", classifyHarnessError({ code: "HARNESS_TURN_TIMEOUT" }));
  eq("A3", "ERROR.HARNESS_START_TIMEOUT 枚举存在", "HARNESS_START_TIMEOUT", ERROR.HARNESS_START_TIMEOUT);
  row("A4", "两个码互不改写", "START->START 且 TURN->TURN",
    "START->" + classifyHarnessError({ code: "HARNESS_START_TIMEOUT" }) + " / TURN->" + classifyHarnessError({ code: "HARNESS_TURN_TIMEOUT" }),
    classifyHarnessError({ code: "HARNESS_START_TIMEOUT" }) === "HARNESS_START_TIMEOUT" && classifyHarnessError({ code: "HARNESS_TURN_TIMEOUT" }) === "HARNESS_TURN_TIMEOUT");
  const budget = fs.readFileSync(path.join(ELECTRON, "task-harness-orchestrator.cjs"), "utf8");
  row("A5", "产品默认预算未被改动（30000/180000）",
    "DEFAULT_TURN_TIMEOUT_MS = 180000; DEFAULT_START_TIMEOUT_MS = 30000;",
    (budget.match(/const DEFAULT_TURN_TIMEOUT_MS = \d+;/) || [""])[0] + " " + (budget.match(/const DEFAULT_START_TIMEOUT_MS = \d+;/) || [""])[0],
    /const DEFAULT_TURN_TIMEOUT_MS = 180000;/.test(budget) && /const DEFAULT_START_TIMEOUT_MS = 30000;/.test(budget));

  console.log("\n=== B. 启动阻塞（真实 adapter + 可控阻塞 initialize，注入 startTimeoutMs=1200） ===");
  const B = await runScenario({ id: "B-start-block", agentFile: "start-hang-agent.mjs", startTimeoutMs: 1200, turnTimeoutMs: 60000 });
  eq("B1", "错误码 = HARNESS_START_TIMEOUT", "HARNESS_START_TIMEOUT", B.runResult.error);
  row("B2", "错误码 != HARNESS_TURN_TIMEOUT（不冒充执行超时）", "!= HARNESS_TURN_TIMEOUT", B.runResult.error, B.runResult.error !== "HARNESS_TURN_TIMEOUT");
  eq("B3", "step 终态 BLOCKED", "BLOCKED", B.runResult.stepStatus);
  eq("B4", "task 终态 BLOCKED", "BLOCKED", B.runResult.taskStatus);
  eq("B5", "run 终态 BLOCKED", "BLOCKED", B.afterSettle.runs[0] && B.afterSettle.runs[0].status);
  eq("B6", "run.errorCode = HARNESS_START_TIMEOUT", "HARNESS_START_TIMEOUT", B.afterSettle.runs[0] && B.afterSettle.runs[0].errorCode);
  eq("B7", "run.stopReason = blocked", "blocked", B.afterSettle.runs[0] && B.afterSettle.runs[0].stopReason);
  eq("B8", "run 行恰好 1 条（0 respawn）", 1, B.afterSettle.runs.length);
  eq("B9", "start 调用恰好 1 次", 1, B.adapterCalls.starts);
  eq("B10", "prompt 调用 0 次", 0, B.adapterCalls.prompts);
  eq("B11", "provider 真实 HTTP 请求 0 次", 0, B.providerRequests.delta);
  eq("B12", "TaskService call 记录 0 条", 0, B.afterSettle.calls.length);
  eq("B13", "artifact 0 条", 0, B.afterSettle.artifacts);
  eq("B14", "capability >=1 且全部 REVOKED", true, B.capabilities.issued >= 1 && B.capabilities.allRevoked);
  eq("B15", "capability 行为验证：旧 token 打 Model Proxy 一律 401", true, B.capabilities.behavioralAll401);
  eq("B16", "事件 step.blocked.reason 携带该码", "HARNESS_START_TIMEOUT", (B.afterSettle.events.find((e) => e.eventType === "step.blocked") || {}).safePayload && B.afterSettle.events.find((e) => e.eventType === "step.blocked").safePayload.reason);
  eq("B17", "事件 harness.run.blocked.errorCode 携带该码", "HARNESS_START_TIMEOUT", (() => { const e = B.afterSettle.events.find((x) => x.eventType === "harness.run.blocked"); return e && e.safePayload.errorCode; })());
  row("B18", "有界停止：总耗时与注入预算同量级（< 5x 预算 = 6000ms）", "< 6000ms", B.elapsedMs + "ms", B.elapsedMs < 6000);
  eq("B19", "无自己的孤儿 harness 进程", 0, B.orphans.leftoverAlive.length);
  eq("B20", "终态 1.5s 内稳定（不翻转）", true, B.statusStableOver1500ms);

  console.log("\n=== C. 执行阻塞（真实 adapter + 可控阻塞 prompt，注入 turnTimeoutMs=1200） ===");
  const C = await runScenario({ id: "C-turn-block", agentFile: "turn-hang-agent.mjs", startTimeoutMs: 20000, turnTimeoutMs: 1200 });
  eq("C1", "错误码 = HARNESS_TURN_TIMEOUT", "HARNESS_TURN_TIMEOUT", C.runResult.error);
  row("C2", "错误码 != HARNESS_START_TIMEOUT", "!= HARNESS_START_TIMEOUT", C.runResult.error, C.runResult.error !== "HARNESS_START_TIMEOUT");
  eq("C3", "step/task 终态 BLOCKED", "BLOCKED/BLOCKED", C.runResult.stepStatus + "/" + C.runResult.taskStatus);
  eq("C4", "run 终态 BLOCKED + errorCode/stopReason 正确", "BLOCKED/HARNESS_TURN_TIMEOUT/blocked", (C.afterSettle.runs[0] || {}).status + "/" + (C.afterSettle.runs[0] || {}).errorCode + "/" + (C.afterSettle.runs[0] || {}).stopReason);
  eq("C5", "prompts 恰好 1 次（0 重试）", 1, C.adapterCalls.prompts);
  eq("C6", "start 恰好 1 次", 1, C.adapterCalls.starts);
  eq("C7", "TaskService call 恰好 1 条（0 二次 call）", 1, C.afterSettle.calls.length);
  eq("C8", "call 状态 FAILED + providerErrorCode=HARNESS_TURN_TIMEOUT", "FAILED/HARNESS_TURN_TIMEOUT", (C.afterSettle.calls[0] || {}).status + "/" + (C.afterSettle.calls[0] || {}).providerErrorCode);
  eq("C9", "artifact 0 条", 0, C.afterSettle.artifacts);
  eq("C10", "capability >=1 且全部 REVOKED + 行为 401", true, C.capabilities.issued >= 1 && C.capabilities.allRevoked && C.capabilities.behavioralAll401);
  row("C11", "有界停止：总耗时与注入预算同量级（< 5x 预算 = 6000ms）", "< 6000ms", C.elapsedMs + "ms", C.elapsedMs < 6000);
  eq("C12", "无自己的孤儿 harness 进程", 0, C.orphans.leftoverAlive.length);
  eq("C13", "终态 1.5s 内稳定", true, C.statusStableOver1500ms);

  console.log("\n=== D. 反向验证（分类器改回旧映射，只在副本里） ===");
  const patched = makePatchedCopy();
  console.log("  副本：" + path.relative(ROOT, patched.copyPath) + " sha256=" + patched.sha256 + "（产品文件 sha256=" + patched.productSha256 + "，未被改动）");
  eq("D0", "副本里旧映射确实生效（classifyHarnessError(START)）", "HARNESS_TURN_TIMEOUT", patched.classifyHarnessError({ code: "HARNESS_START_TIMEOUT" }));
  const D = await runScenario({ id: "D-reverse-start-block", agentFile: "start-hang-agent.mjs", startTimeoutMs: 1200, turnTimeoutMs: 60000, PatchedOrchestrator: patched.TaskHarnessOrchestrator });
  row("D1", "【必须变红·反向验证】启动阻塞用例：错误码 = HARNESS_START_TIMEOUT（旧映射下必须给不出该码）", "HARNESS_START_TIMEOUT", D.runResult.error, D.runResult.error === "HARNESS_START_TIMEOUT", true);
  const Dr = RAW["D-reverse-start-block"];
  const E = await runScenario({ id: "E-reverse-turn-block", agentFile: "turn-hang-agent.mjs", startTimeoutMs: 20000, turnTimeoutMs: 1200, PatchedOrchestrator: patched.TaskHarnessOrchestrator });
  row("D2", "【对照保持绿】执行阻塞用例在旧映射下仍是 HARNESS_TURN_TIMEOUT", "HARNESS_TURN_TIMEOUT", E.runResult.error, E.runResult.error === "HARNESS_TURN_TIMEOUT");
  fs.unlinkSync(patched.copyPath);
  const copyGone = !fs.existsSync(patched.copyPath);
  eq("D3", "副本已删除（验完删除）", true, copyGone);
  eq("D4", "产品 orchestrator 文件未被改动（sha256 与副本制作前一致）", patched.productSha256, fileSha(path.join(ELECTRON, "task-harness-orchestrator.cjs")));

  console.log("\n=== E. 竞争：启动阻塞中途取消 / 执行阻塞中途取消 ===");
  const R1 = await runScenario({ id: "R1-race-start", agentFile: "start-hang-agent.mjs", startTimeoutMs: 4000, turnTimeoutMs: 60000, cancelAtMs: 900 });
  const R2 = await runScenario({ id: "R2-race-turn", agentFile: "turn-hang-agent.mjs", startTimeoutMs: 20000, turnTimeoutMs: 20000, cancelAfterPrompt: true });
  for (const [tag, R] of [["R1", R1], ["R2", R2]]) {
    const term = R.afterSettle.task.status;
    row(tag + "1", "终态唯一且属于 {CANCELLED, BLOCKED}", "CANCELLED 或 BLOCKED", term, term === "CANCELLED" || term === "BLOCKED");
    eq(tag + "2", "终态在收敛后 1.5s 内不翻转", true, R.statusStableOver1500ms);
    row(tag + "3", "task 终态与 run 终态一致", "同一终态", "task=" + term + " run=" + ((R.afterSettle.runs[0] || {}).status || "?"), term === ((R.afterSettle.runs[0] || {}).status));
    eq(tag + "4", "0 孤儿进程（本次运行自己 spawn 的 harness 子进程全部消失）", 0, R.orphans.leftoverAlive.length);
    eq(tag + "5", "全局扫描无遗留 hang 探针", 0, R.orphans.globalScanCount);
    eq(tag + "6", "无能力残留：全部 REVOKED 且旧 token 行为上 401", true, R.capabilities.allRevoked && R.capabilities.behavioralAll401);
    row(tag + "7", "取消确实被接受（cancel ok/cancelled）", "ok=true", JSON.stringify(R.cancelResult), !!(R.cancelResult && R.cancelResult.ok));
  }
  row("R3", "R1 取消后 runTask 的最终返回（记录，不判分）", "竞争结果如实记录", JSON.stringify(RAW["R1-race-start"].runResult) + " cancel=" + JSON.stringify(RAW["R1-race-start"].cancelResult), true);
  row("R4", "R2 取消后 runTask 的最终返回（记录，不判分）", "竞争结果如实记录", JSON.stringify(RAW["R2-race-turn"].runResult) + " cancel=" + JSON.stringify(RAW["R2-race-turn"].cancelResult), true);

  console.log("\n=== F. 计数器活性对照（证明“0 次 provider 请求”不是恒零计数器） ===");
  const fx = await createTaskHarnessFixture();
  try {
    const before = fx.fp.state.requests;
    await fetch(fx.fp.baseUrl + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "probe", messages: [] }) });
    const after = fx.fp.state.requests;
    row("F1", "对 fake provider 直发 1 次 HTTP 后计数 +1（计数器活着）", String(before + 1), String(after), after === before + 1);
  } finally { await fx.close(); }

  const failed = ROWS.filter((r) => !r.pass && !r.intentionalRed);
  const expectedReds = ROWS.filter((r) => !r.pass && r.intentionalRed);
  const unexpectedGreens = ROWS.filter((r) => r.pass && r.intentionalRed);
  const out = {
    phase: "D5-03 第九批 · 独立验收 · 第一段（错误码可控阻塞 + 反向验证 + 竞争）",
    testedHead: head, branch: execFileSync("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
    worktreePorcelain: porcelain,
    script: "experiments/d5-03/batch9/verify/batch9-01-codes-probe.mjs",
    scriptSha256: fileSha(fileURLToPath(import.meta.url)),
    productFingerprints: {
      "electron/task-domain.cjs": fileSha(path.join(ELECTRON, "task-domain.cjs")),
      "electron/task-harness-orchestrator.cjs": fileSha(path.join(ELECTRON, "task-harness-orchestrator.cjs")),
      "electron/harness-adapter.cjs": fileSha(path.join(ELECTRON, "harness-adapter.cjs")),
    },
    injectedBudgets: { note: "产品默认 30000/180000 未改；场景均为构造参数注入", scenarios: { B: 1200, C: 1200, D: 1200, E: 1200, R1_start: 4000, R2_turn: 20000 } },
    checks: ROWS,
    counts: { total: ROWS.length, pass: ROWS.filter((r) => r.pass).length, fail: failed.length, expectedRed: expectedReds.length, unexpectedGreen: unexpectedGreens.length },
    failedChecks: failed.map((f) => f.id + " " + f.name),
    expectedRedChecks: expectedReds.map((f) => f.id + " " + f.name + " → actual=" + f.actual),
    unexpectedGreenChecks: unexpectedGreens.map((f) => f.id + " " + f.name),
    raw: RAW,
    deleteProof: { copyDeleted: copyGone, copyPath: path.relative(ROOT, patched.copyPath), copySha256: patched.sha256, productSha256After: fileSha(path.join(ELECTRON, "task-harness-orchestrator.cjs")) },
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(HERE, "batch9-01-codes-probe.json"), JSON.stringify(out, null, 2));
  console.log("\n=== RAW JSON（供逐项复核） ===");
  console.log(JSON.stringify({ checks: ROWS, raw: RAW, counts: out.counts }, null, 1));
  console.log("\n计数：" + JSON.stringify(out.counts));
  console.log("反向验证：期望红 " + expectedReds.length + " 条（D1），意外绿 " + unexpectedGreens.length + " 条");
  process.exit(failed.length || unexpectedGreens.length ? 1 : 0);
}

main().catch((e) => { console.error("PROBE ERROR: " + (e && e.stack || e)); process.exit(2); });
