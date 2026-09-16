/**
 * D4-03C4 · Production side-effect runtime wiring Gate。
 *
 * 永久规则：
 *   · 真实 mutation 只发生在 RuntimeSupervisor 拥有并监督的 executor runtime 里；
 *   · 只有 supervisor 真实观测到 child 'exit'（或恢复上一次 production supervisor
 *     已持久化的 trusted EXITED proof）才允许 quiesced=true；
 *     OS-backed socket probe 只回答 reachability（ALIVE / UNKNOWN），pathname 消失不是死亡证明；
 *     进入内存的 diff / lease 状态 / 时间流逝都不是证明；
 *   · observeExit / registerRuntime 不导出给 Renderer / IPC / ACP / Harness / Tool Facade。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createToolHarnessFixture, reopenToolHarnessRuntime } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RuntimeSupervisor, probeUnixSocket } = require("../electron/runtime-supervisor.cjs");

const GATED_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "supervised-executor.mjs");
const TRASH = "resource.trash";
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });

async function setupEnv({ executorEntry = null, approvalWaitMs = 400, instanceId = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c4-"));
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const runtimeDir = path.join(root, "runtime");
  const fx = await createToolHarnessFixture({
    withAdapters: true, dbPath, storeRoot, keepData: true,
    sideEffectRuntimeDir: runtimeDir, sideEffectExecutorEntry: executorEntry,
    sideEffectApprovalWaitMs: approvalWaitMs, ...(instanceId ? { sideEffectInstanceId: instanceId } : {}),
  });
  return { root, dbPath, storeRoot, runtimeDir, fx, open: (o = {}) => createToolHarnessFixture({ withAdapters: true, dbPath, storeRoot, keepData: true, sideEffectRuntimeDir: runtimeDir, sideEffectExecutorEntry: executorEntry, sideEffectApprovalWaitMs: approvalWaitMs, ...(o.instanceId ? { sideEffectInstanceId: o.instanceId } : {}) }) };
}
async function teardown(env) { try { await env.fx.close(); } catch { /* ignore */ } try { fs.rmSync(env.root, { recursive: true, force: true }); } catch { /* ignore */ } }

let seq = 0;
async function prepare(fx, { name = "C4 Target" } = {}) {
  seq += 1;
  const created = await fx.createResource(name + " " + seq);
  fx.grantTool("ai", ["tool.resource.trash"]);
  fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
  fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
  const run = fx.dshRunSetup();
  const planned = await fx.sideEffectRuntime.proposeWrite({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH, toolVersion: 1, arguments: { resourceRef: created.resource.resourceRef } });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  return { run, callId: planned.approvalRequestId, resourceRef: created.resource.resourceRef, resourceId: created.resource.resourceId };
}
function approve(fx, callId) {
  const r = fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: callId, decision: "APPROVE" });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}
function waitFor(fn, ms, detail = "") {
  const deadline = Date.now() + ms;
  return (async () => {
    while (Date.now() < deadline) { if (fn()) return true; await sleep(20); }
    assert.fail("waitFor 超时：" + detail);
  })();
}
function waitMessage(box, type, ms) {
  const deadline = Date.now() + ms;
  return (async () => {
    while (Date.now() < deadline) {
      const found = RuntimeSupervisor.parseExecutorMessage(box.stdout, type);
      if (found) return found;
      await sleep(20);
    }
    assert.fail("未收到 " + type + "：" + box.stdout + box.stderr);
  })();
}

/* ------------------------------------------------------------------ 1. happy path */

test("Production assembly：主进程绝不执行 write；受监督 executor runtime 完成 exactly-once + verified SUCCEEDED", async () => {
  const env = await setupEnv();
  try {
    const { callId, resourceRef } = await prepare(env.fx);
    approve(env.fx, callId);
    let deleteCalls = 0;
    const real = env.fx.f.resourceService.delete.bind(env.fx.f.resourceService);
    env.fx.f.resourceService.delete = (...a) => { deleteCalls += 1; return real(...a); };
    const res = await env.fx.sideEffectRuntime.executeApproved({ callId, holderId: "exec_1" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(env.fx.sideEffectStore.callById(callId).status, "SUCCEEDED");
    assert.equal(env.fx.sideEffectStore.callById(callId).verificationStatus, "PASS");
    assert.equal(env.fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, true);
    assert.equal(deleteCalls, 0, "主进程绝不直接执行 write");
    assert.deepEqual(res.safeResult, { resourceRef, trashed: true, verified: true, version: 1 });
    const records = env.fx.supervisor.snapshot();
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "EXITED", "executor 退出后 supervisor 自动记录 EXITED");
    assert.equal(records[0].reason, "SUPERVISOR_OBSERVED_EXIT");
    assert.equal(env.fx.sideEffectStore.callsOfTask(res.call.taskId).filter((c) => c.toolId === TRASH).length, 1, "exactly one SideEffectCall");
    assert.equal(env.fx.sideEffectStore.leasesOfCall(callId).filter((l) => l.status === "ACTIVE").length, 0, "lease RELEASED");
  } finally { await teardown(env); }
});

/* ------------------------------------------------------------------ 2. trusted quiescence via real exit event */

test("RuntimeSupervisor：executor ACTIVE 时不得 quiesced；真实进程退出后自动成为 quiescence proof（测试不调用 observeExit）", async () => {
  const env = await setupEnv({ executorEntry: GATED_EXECUTOR });
  try {
    const { callId } = await prepare(env.fx);
    approve(env.fx, callId);
    const box = env.fx.supervisor.spawnExecutor({ callId, holderId: "exec_1", dbPath: env.dbPath, storeRoot: env.storeRoot, timeoutMs: 250, now: env.fx.f.clock() });
    assert.equal(box.ok, true, JSON.stringify(box));
    await waitMessage(box, "unknown_effect", 60000);

    // alive 时：quiescence 必须 fail closed。
    const alive = env.fx.supervisor.isQuiesced(box.instanceId);
    assert.equal(alive.quiesced, false, "live executor runtime 不能被声明 quiesced");
    assert.equal(alive.reason, "RUNTIME_STILL_ACTIVE");
    env.fx.sideEffectRuntime.recoverOnStartup();
    assert.equal(env.fx.sideEffectStore.callById(callId).recoverySafe.quiesced, false);
    assert.equal(env.fx.sideEffectStore.callById(callId).recoverySafe.quiescenceReason, "RUNTIME_STILL_ACTIVE");
    const early = await env.fx.sideEffectRuntime.verifyUnknownEffect({ callId });
    assert.equal(early.outcome, "NOT_APPLIED");
    assert.equal(early.resolved, false, "旧 runtime 仍存活时 false-negative 不得 FAILED");
    assert.equal(env.fx.sideEffectStore.callById(callId).status, "UNKNOWN_EFFECT");

    // 真实进程退出 → 只有 production supervisor 的 child lifecycle listener 记录 EXITED。
    box.child.kill("SIGKILL");
    await box.done;
    const dead = env.fx.supervisor.isQuiesced(box.instanceId);
    assert.equal(dead.quiesced, true, JSON.stringify(dead));
    assert.equal(dead.proof.type, "SUPERVISOR_OBSERVED_EXIT");
    assert.equal(env.fx.supervisor.snapshot().find((r) => r.instanceId === box.instanceId).reason, "SUPERVISOR_OBSERVED_EXIT");

    // late mutation（A 在 timeout 之后、被杀之前已提交）→ APPLIED → SUCCEEDED，0 second execution。
    assert.equal(env.fx.sideEffectStore.callById(callId).status, "UNKNOWN_EFFECT");
  } finally { await teardown(env); }
});

test("Two live runtimes：live 旧 runtime 的 late mutation → restart quiescence → APPLIED → SUCCEEDED；0 second execution", async () => {
  const env = await setupEnv({ executorEntry: GATED_EXECUTOR });
  try {
    const { callId, resourceRef } = await prepare(env.fx);
    approve(env.fx, callId);
    const box = env.fx.supervisor.spawnExecutor({ callId, holderId: "exec_1", dbPath: env.dbPath, storeRoot: env.storeRoot, timeoutMs: 250, now: env.fx.f.clock() });
    await waitMessage(box, "unknown_effect", 60000);

    // 放行真实 mutation，然后 kill（该 runtime 不 finalize）。
    box.child.stdin.write("MUTATE\n");
    const done = await waitMessage(box, "mutation_done", 60000);
    assert.equal(done.deleteCalls, 1);
    box.child.kill("SIGKILL");
    await box.done;
    assert.equal(env.fx.supervisor.isQuiesced(box.instanceId).quiesced, true);

    env.fx.sideEffectRuntime.recoverOnStartup();
    const call = env.fx.sideEffectStore.callById(callId);
    assert.equal(call.status, "UNKNOWN_EFFECT", "quiescence 升级不推断 effect");
    assert.equal(call.recoverySafe.quiesced, true);
    assert.equal(call.recoverySafe.source, "cold_restart_confirmed");
    const late = await env.fx.sideEffectRuntime.verifyUnknownEffect({ callId });
    assert.equal(late.outcome, "APPLIED", JSON.stringify(late));
    assert.equal(env.fx.sideEffectStore.callById(callId).status, "SUCCEEDED");
    assert.equal(env.fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, true);
    assert.equal(env.fx.sideEffectStore.callsOfTask(call.taskId).length, 1, "0 second SideEffectCall");
  } finally { await teardown(env); }
});

test("TIMEout → 真实进程死亡（mutation 未发生）→ NOT_APPLIED → FAILED；Task/Step 保持 BLOCKED；0 retry", async () => {
  const env = await setupEnv({ executorEntry: GATED_EXECUTOR });
  try {
    const { callId, resourceRef, run } = await prepare(env.fx);
    approve(env.fx, callId);
    const box = env.fx.supervisor.spawnExecutor({ callId, holderId: "exec_1", dbPath: env.dbPath, storeRoot: env.storeRoot, timeoutMs: 250, now: env.fx.f.clock() });
    await waitMessage(box, "unknown_effect", 60000);
    box.child.kill("SIGKILL");
    await box.done;

    env.fx.sideEffectRuntime.recoverOnStartup();
    const v = await env.fx.sideEffectRuntime.verifyUnknownEffect({ callId });
    assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
    assert.equal(v.resolved, true);
    assert.equal(env.fx.sideEffectStore.callById(callId).status, "FAILED");
    assert.equal(env.fx.sideEffectStore.callById(callId).verificationStatus, "FAIL");
    assert.equal(env.fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "mutation total = 0");
    assert.equal(env.fx.taskStore.taskById(run.taskId).status, "BLOCKED");
    assert.equal(env.fx.taskStore.stepById(run.stepId).status, "BLOCKED");
    assert.equal(env.fx.sideEffectStore.leasesOfCall(callId).filter((l) => l.status === "ACTIVE").length, 0);
  } finally { await teardown(env); }
});

/* ------------------------------------------------------------------ 3. RUNNING cold crash (claim 之后、mutation 之前) */

test("Restart After Claim：RUNNING cold crash → 新 runtime 无 live death proof（persisted EXITED 不是 authority）→ NOT_APPLIED 保持 UNKNOWN_EFFECT + BLOCK", async () => {
  const env = await setupEnv({ executorEntry: GATED_EXECUTOR });
  let reopened = null;
  try {
    const { callId, resourceRef, run } = await prepare(env.fx);
    approve(env.fx, callId);
    // 长 timeout：child claim（LEASED → RUNNING）成功后停在 gate 上，mutation 尚未发生。
    const box = env.fx.supervisor.spawnExecutor({ callId, holderId: "exec_1", dbPath: env.dbPath, storeRoot: env.storeRoot, timeoutMs: 120000, now: env.fx.f.clock() });
    await waitMessage(box, "ready", 60000);
    await waitFor(() => env.fx.sideEffectStore.callById(callId).status === "RUNNING", 60000, "claim 未提交");
    assert.equal(env.fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "mutation 尚未发生");
    box.child.kill("SIGKILL"); // claim 之后的真实进程死亡
    await box.done;
    assert.equal(env.fx.supervisor.isQuiesced(box.instanceId).quiesced, true, "同一 runtime 内真实退出已被 supervisor 观测");

    // 真实 restart：新 runtime 打开同一 disk DB。persisted EXITED 不是 process-death authority。
    await env.fx.close();
    reopened = await reopenToolHarnessRuntime({ dbPath: env.dbPath, storeRoot: env.storeRoot, runtimeDir: env.runtimeDir, executorEntry: GATED_EXECUTOR });
    const rec = reopened.recover();
    assert.equal(reopened.sideEffectStore.callById(callId).status, "UNKNOWN_EFFECT", "0 auto retry / 0 auto replay");
    const q = reopened.sideEffectStore.callById(callId).recoverySafe;
    assert.equal(q.quiesced, false, "cold restart 没有 live trusted death proof：" + JSON.stringify(q));
    assert.equal(reopened.supervisor.isQuiesced(box.instanceId).proof.probeReason, "UNVERIFIED_PERSISTED_EXIT");
    const v = await reopened.sideEffectRuntime.verifyUnknownEffect({ callId });
    assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
    assert.equal(v.resolved, false, "quiescence 未证明 → 绝不 FAILED");
    assert.equal(reopened.sideEffectStore.callById(callId).status, "UNKNOWN_EFFECT", "绝不 FAILED");
    assert.equal(reopened.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false);
    assert.equal(reopened.taskStore.taskById(run.taskId).status, "BLOCKED");
    assert.ok(rec.sideEffect);
  } finally {
    try { if (reopened) await reopened.close(); } catch { /* ignore */ }
    await teardown(env);
  }
});

/* ------------------------------------------------------------------ 4. cross-restart OS-backed rehydrate */

test("Cold restart rehydrate：pathname probe 只回答 reachability；persisted EXITED 无 death authority（只有真 child exit 才 quiesce）", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c4-rehydrate-"));
  try {
    const execDir = path.join(root, "executors");
    fs.mkdirSync(execDir, { recursive: true });

    /** 真实持有一个 unix socket 的 child；SIGKILL 后 socket 文件仍在 = 真实 stale endpoint。 */
    const holdSocket = async (sockPath) => {
      const child = spawn(process.execPath, ["-e", "const net=require('node:net');const s=net.createServer(()=>{});s.listen(process.argv[1],()=>process.stdout.write('ready'));", sockPath], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      const t0 = Date.now();
      while (!out.includes("ready") && Date.now() - t0 < 15000) await sleep(20);
      assert.ok(out.includes("ready"), "socket holder 未就绪：" + out);
      return child;
    };
    const killHolder = async (child) => {
      const done = new Promise((r) => child.on("exit", r));
      child.kill("SIGKILL");
      await done;
    };
    const writeRecord = (id, rec) => fs.writeFileSync(path.join(execDir, id + ".json"), JSON.stringify(rec));

    // (a) pathname probe 只有 ALIVE / UNKNOWN：ENOENT / stale 都绝不是 death proof。
    assert.equal((await probeUnixSocket(path.join(execDir, "missing.sock"))).state, "UNKNOWN", "endpoint 文件不存在也不能证明 process 死亡");
    const livePath = path.join(execDir, "live.sock");
    const holder1 = await holdSocket(livePath);
    assert.equal((await probeUnixSocket(livePath)).state, "ALIVE", "真实 bind 的 socket 被视为存活");
    await killHolder(holder1);
    assert.equal(fs.existsSync(livePath), true, "SIGKILL 后 socket 文件仍在（真实 stale endpoint）");
    assert.equal((await probeUnixSocket(livePath)).state, "UNKNOWN", "listener 被 kill 但 endpoint 文件仍在 → reachability 不确定");
    fs.unlinkSync(livePath);
    assert.equal((await probeUnixSocket(livePath)).state, "UNKNOWN", "pathname 被 unlink 也不能证明 process 死亡");

    // (b) persisted ACTIVE record + 派生 endpoint 不存在 → 仍然 UNKNOWN（ENOENT 不是 death proof）。
    const activeId = "exe_active01";
    writeRecord(activeId, { instanceId: activeId, status: "ACTIVE", socketPath: path.join(execDir, "spoofed-elsewhere.sock"), startedAt: 1, callId: "scall_x", holderId: "e", endedAt: null, exitCode: null, signal: null, reason: null });
    const b = new RuntimeSupervisor({ runtimeDir: root });
    const statsB = await b.rehydrate();
    const vB = b.isQuiesced(activeId);
    assert.equal(vB.quiesced, false, JSON.stringify(vB));
    assert.equal(vB.reason, "LIVENESS_UNKNOWN");
    assert.equal(b.snapshot().find((r) => r.instanceId === activeId).status, "ACTIVE");
    assert.equal(statsB.dead, 0, "pathname probe 绝不产生 dead");
    assert.equal(statsB.unknown, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(execDir, activeId + ".json"), "utf8")).status, "ACTIVE");

    // (c) persisted ACTIVE record + socket 仍存活 → ALIVE，绝不 quiesced。
    const aliveId = "exe_alive001";
    const aliveSock = path.join(execDir, aliveId + ".sock");
    const holder2 = await holdSocket(aliveSock);
    writeRecord(aliveId, { instanceId: aliveId, status: "ACTIVE", socketPath: aliveSock, startedAt: 1, callId: "scall_y", holderId: "e", endedAt: null, exitCode: null, signal: null, reason: null });
    const c = new RuntimeSupervisor({ runtimeDir: root });
    const statsC = await c.rehydrate();
    assert.equal(c.isQuiesced(aliveId).quiesced, false, "存活的上一次 executor 绝不能被声明 quiesced");
    assert.equal(c.isQuiesced(aliveId).reason, "RUNTIME_STILL_ACTIVE");
    assert.equal(statsC.alive, 1);
    assert.equal(statsC.unknown, 1);

    // (c2) legacy socketPath spoof：record 指向真实 live socket，但派生 endpoint 不存在 → 只能 UNKNOWN。
    const spoofId = "exe_spoof001";
    writeRecord(spoofId, { instanceId: spoofId, status: "ACTIVE", socketPath: aliveSock, startedAt: 1, callId: "scall_s", holderId: "e", endedAt: null, exitCode: null, signal: null, reason: null });
    const c2 = new RuntimeSupervisor({ runtimeDir: root });
    const statsC2 = await c2.rehydrate();
    assert.equal(c2.isQuiesced(spoofId).quiesced, false);
    assert.equal(c2.isQuiesced(spoofId).reason, "LIVENESS_UNKNOWN", "persisted socketPath 绝不被采信");
    assert.equal(statsC2.alive, 1, "只有真身 aliveId 是 ALIVE");
    assert.equal(statsC2.unknown, 2);

    // (d) holder 被 SIGKILL、endpoint 文件仍在 → probe UNKNOWN → fail closed（绝不 quiesced / 绝不 observeExit）。
    await killHolder(holder2);
    const d = new RuntimeSupervisor({ runtimeDir: root });
    const statsD = await d.rehydrate();
    const afterKill = d.isQuiesced(aliveId);
    assert.equal(afterKill.quiesced, false, "probe 不确定时绝不允许 quiesced");
    assert.equal(afterKill.reason, "LIVENESS_UNKNOWN");
    assert.equal(statsD.unknown, 3, "UNKNOWN 必须单独计数，不得归入 dead");
    assert.equal(statsD.dead, 0, "pathname probe 绝不产生 dead");
    const persisted = JSON.parse(fs.readFileSync(path.join(execDir, aliveId + ".json"), "utf8"));
    assert.equal(persisted.status, "ACTIVE", "UNKNOWN probe 不得改写 persisted executor record");

    // (e) persisted EXITED（即使 reason=SUPERVISOR_OBSERVED_EXIT）不是 authority → fail closed。
    const exitedId = "exe_exited01";
    writeRecord(exitedId, { instanceId: exitedId, status: "EXITED", startedAt: 1, callId: "scall_z", holderId: "e", endedAt: 9, exitCode: 0, signal: null, reason: "SUPERVISOR_OBSERVED_EXIT" });
    const e = new RuntimeSupervisor({ runtimeDir: root });
    const statsE = await e.rehydrate();
    const vE = e.isQuiesced(exitedId);
    assert.equal(vE.quiesced, false, "persisted EXITED 绝不 quiesce：" + JSON.stringify(vE));
    assert.equal(vE.reason, "LIVENESS_UNKNOWN");
    assert.equal(vE.proof.probeReason, "UNVERIFIED_PERSISTED_EXIT");
    assert.equal(e.snapshot().find((r) => r.instanceId === exitedId).status, "ACTIVE");
    assert.equal(statsE.dead, 0, "persisted EXITED 绝不产生 dead");
    assert.equal(statsE.unverifiedExit, 1);
    assert.equal(statsE.unknown, 4);

    // (f) 其它 reason 的 persisted EXITED 同样 fail closed。
    const untrustedId = "exe_untrust01";
    writeRecord(untrustedId, { instanceId: untrustedId, status: "EXITED", startedAt: 1, endedAt: 9, exitCode: 0, signal: null, reason: "OS_EXECUTOR_ENDPOINT_ABSENT" });
    const f2 = new RuntimeSupervisor({ runtimeDir: root });
    const statsF = await f2.rehydrate();
    assert.equal(f2.isQuiesced(untrustedId).quiesced, false, "任何 persisted EXITED 都不得 quiesce");
    assert.equal(f2.isQuiesced(untrustedId).reason, "LIVENESS_UNKNOWN");
    assert.equal(statsF.dead, 0);
    assert.equal(statsF.unverifiedExit, 2);
    assert.equal(statsF.unknown, 5);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ------------------------------------------------------------------ 5. observeExit boundary */

test("observeExit / registerRuntime 不导出给 authority / Harness / IPC / Tool Facade", async () => {
  const env = await setupEnv();
  try {
    assert.equal(typeof env.fx.sideEffectAuthority.observeExit, "undefined", "authority 绝不能持有 observeExit");
    assert.equal(typeof env.fx.sideEffectAuthority.registerRuntime, "undefined");
    assert.equal(typeof env.fx.sideEffectRuntime.observeExit, "undefined");
    assert.equal(typeof env.fx.sideEffectRuntime.registerRuntime, "undefined");
    // SideEffectAuthority 只拿到一个 { isQuiesced } 面（supervisor 自身不暴露 observeExit）。
    assert.equal(typeof env.fx.supervisor.isQuiesced, "function");
    assert.equal(typeof env.fx.supervisor.observeExit, "undefined", "supervisor 绝不对外暴露 observeExit");
    assert.equal(typeof env.fx.supervisor.registerRuntime, "undefined");
    assert.equal(env.fx.sideEffectAuthority.lifecycle, env.fx.supervisor, "production lifecycle 就是 supervisor");
    // Tool args spoof：quiescence / runtime death 自报一律无效。
    const run = env.fx.dshRunSetup();
    const spoof = await env.fx.sideEffectRuntime.proposeWrite({ context: env.fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH, arguments: { resourceRef: "resource://res_x", runtimeDead: true, quiesced: true, runtimeExited: true, observeExit: true } });
    assert.equal(spoof.ok, false);
    assert.equal(spoof.error, "TOOL_ARGUMENT_INVALID", JSON.stringify(spoof));
  } finally { await teardown(env); }
});

/* ------------------------------------------------------------------ 6. restart while waiting / approved / leased */

test("Restart While WAITING_APPROVAL：pending call → BLOCKED；0 lease / 0 execution / 0 mutation / 0 auto approve", async () => {
  const env = await setupEnv();
  let reopened = null;
  try {
    const { callId, resourceRef } = await prepare(env.fx);
    assert.equal(env.fx.sideEffectStore.callById(callId).status, "AWAITING_APPROVAL");
    await env.fx.close();
    reopened = await reopenToolHarnessRuntime({ dbPath: env.dbPath, storeRoot: env.storeRoot, runtimeDir: env.runtimeDir });
    reopened.recover();
    const call = reopened.sideEffectStore.callById(callId);
    assert.equal(call.status, "BLOCKED", "pending approval 不得跨 restart 复活");
    assert.equal(call.errorCode, "SIDE_EFFECT_APPROVAL_ABANDONED");
    assert.equal(reopened.sideEffectStore.leasesOfCall(callId).length, 0, "0 lease");
    assert.equal(reopened.toolStore.executionsOfTask(call.taskId).length, 0, "0 execution");
    assert.equal(reopened.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "0 mutation");
    // 事后点 Approve 也不得执行（旧 UI 的 late approve 一律 DENY）。
    const late = reopened.sideEffectRuntime.decideApproval({ context: { sessionRef: call.taskId ? reopened.taskStore.taskById(call.taskId).session_ref : null, source: "user" }, approvalRequestId: callId, decision: "APPROVE" });
    assert.equal(late.ok, false, JSON.stringify(late));
    assert.equal(reopened.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false);
  } finally {
    try { if (reopened) await reopened.close(); } catch { /* ignore */ }
    await teardown(env);
  }
});

test("Restart After APPROVED Before Lease：0 automatic execution", async () => {
  const env = await setupEnv();
  let reopened = null;
  try {
    const { callId, resourceRef } = await prepare(env.fx);
    approve(env.fx, callId);
    assert.equal(env.fx.sideEffectStore.callById(callId).status, "APPROVED");
    await env.fx.close();
    reopened = await reopenToolHarnessRuntime({ dbPath: env.dbPath, storeRoot: env.storeRoot, runtimeDir: env.runtimeDir });
    reopened.recover();
    assert.equal(reopened.sideEffectStore.callById(callId).status, "BLOCKED", "Approval 不等于 restart execution authority");
    assert.equal(reopened.sideEffectStore.leasesOfCall(callId).length, 0);
    assert.equal(reopened.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false);
  } finally {
    try { if (reopened) await reopened.close(); } catch { /* ignore */ }
    await teardown(env);
  }
});

test("Restart After Lease Before Claim：旧 lease 不能被新 runtime replay；0 execution", async () => {
  const env = await setupEnv();
  let reopened = null;
  try {
    const { callId, resourceRef } = await prepare(env.fx);
    approve(env.fx, callId);
    const lease = env.fx.sideEffectAuthority.acquireLease({ context: env.fx.ctx(), callId, holderId: "exec_1", ttlMs: 600000 });
    assert.equal(lease.ok, true, JSON.stringify(lease));
    assert.equal(env.fx.sideEffectStore.callById(callId).status, "LEASED");
    await env.fx.close();
    reopened = await reopenToolHarnessRuntime({ dbPath: env.dbPath, storeRoot: env.storeRoot, runtimeDir: env.runtimeDir });
    reopened.recover();
    assert.equal(reopened.sideEffectStore.callById(callId).status, "BLOCKED");
    assert.equal(reopened.sideEffectStore.leasesOfCall(callId).filter((l) => l.status === "ACTIVE").length, 0, "旧 lease 不得保持 ACTIVE");
    assert.equal(reopened.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false);
  } finally {
    try { if (reopened) await reopened.close(); } catch { /* ignore */ }
    await teardown(env);
  }
});

/* ------------------------------------------------------------------ 7. secret scan */

test("C4 runtime secret scan：SideEffectCall / Approval / Lease / runtime evidence / TaskEvent 0 leak", async () => {
  const env = await setupEnv();
  try {
    const { callId } = await prepare(env.fx);
    approve(env.fx, callId);
    const res = await env.fx.sideEffectRuntime.executeApproved({ callId, holderId: "exec_1" });
    assert.equal(res.ok, true, JSON.stringify(res));
    const tables = ["side_effect_calls", "tool_approvals", "side_effect_leases", "task_events", "authorization_audit", "task_tool_proposals", "tool_decisions", "tool_executions"];
    let dump = "";
    for (const t of tables) { try { for (const row of env.fx.f.identity.connection.prepare("SELECT * FROM " + t).all()) dump += JSON.stringify(row) + "\n"; } catch { /* ignore */ } }
    dump += JSON.stringify(env.fx.supervisor.snapshot());
    assert.ok(!dump.includes("mpx_"), "mpx_ 不得落库");
    assert.ok(!dump.includes("tpx_"), "tpx_ 不得落库");
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders/.test(dump), "绝对路径不得落库");
    assert.ok(!dump.includes(env.fx.f.storeRoot), "store root 不得落库");
    assert.ok(!/"(secret|token|authorization|api[_-]?key|credential|password)"/i.test(dump), "credential 形态字段不得出现");
  } finally { await teardown(env); }
});
