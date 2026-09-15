/**
 * D4-03C4 · Production side-effect runtime wiring Gate。
 *
 * 永久规则：
 *   · 真实 mutation 只发生在 RuntimeSupervisor 拥有并监督的 executor runtime 里；
 *   · 只有 supervisor 真实观测到进程退出（child 'exit'）或 OS-backed socket 消失，
 *     才允许 quiesced=true；进入内存的 diff / lease 状态 / 时间流逝都不是证明；
 *   · observeExit / registerRuntime 不导出给 Renderer / IPC / ACP / Harness / Tool Facade。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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

test("Restart After Claim：RUNNING cold crash → UNKNOWN_EFFECT → verify → NOT_APPLIED → FAILED + BLOCK", async () => {
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
    assert.equal(env.fx.supervisor.isQuiesced(box.instanceId).quiesced, true, "真实退出已被 supervisor 观测");

    // 真实 restart：新 runtime 打开同一 disk DB。
    await env.fx.close();
    reopened = await reopenToolHarnessRuntime({ dbPath: env.dbPath, storeRoot: env.storeRoot, runtimeDir: env.runtimeDir, executorEntry: GATED_EXECUTOR });
    const rec = reopened.recover();
    assert.equal(reopened.sideEffectStore.callById(callId).status, "UNKNOWN_EFFECT", "0 auto retry / 0 auto replay");
    const q = reopened.sideEffectStore.callById(callId).recoverySafe;
    assert.equal(q.quiesced, true, JSON.stringify(q));
    const v = await reopened.sideEffectRuntime.verifyUnknownEffect({ callId });
    assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
    assert.equal(reopened.sideEffectStore.callById(callId).status, "FAILED");
    assert.equal(reopened.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false);
    assert.equal(reopened.taskStore.taskById(run.taskId).status, "BLOCKED");
    assert.ok(rec.sideEffect);
  } finally {
    try { if (reopened) await reopened.close(); } catch { /* ignore */ }
    await teardown(env);
  }
});

/* ------------------------------------------------------------------ 4. cross-restart OS-backed rehydrate */

test("Cold restart rehydrate：绝不用内存中的旧 authority 自我证明；OS-backed socket 判定才是 proof", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c4-rehydrate-"));
  try {
    const execDir = path.join(root, "executors");
    fs.mkdirSync(execDir, { recursive: true });

    // (a) probe 语义：不存在的 socket / 已关闭的 stale socket → 进程已不存在。
    assert.equal(await probeUnixSocket(path.join(execDir, "missing.sock")), false);
    const livePath = path.join(execDir, "live.sock");
    const server = net.createServer((s) => { try { s.end(); } catch { /* ignore */ } });
    await new Promise((r) => server.listen(livePath, r));
    assert.equal(await probeUnixSocket(livePath), true, "真实 bind 的 socket 被视为存活");
    await new Promise((r) => server.close(r));
    assert.equal(await probeUnixSocket(livePath), false, "listener 消失后 stale socket 不得视为存活");

    // (b) 上一次进程持久化的 ACTIVE record + socket 已消失 → 新 supervisor 判定 EXITED（OS fact）。
    const deadId = "exe_dead0001";
    fs.writeFileSync(path.join(execDir, deadId + ".json"), JSON.stringify({ instanceId: deadId, status: "ACTIVE", socketPath: path.join(execDir, deadId + ".sock"), startedAt: 1, callId: "scall_x", holderId: "e", endedAt: null, exitCode: null, signal: null, reason: null }));
    const fresh = new RuntimeSupervisor({ runtimeDir: root });
    await fresh.rehydrate();
    const verdict = fresh.isQuiesced(deadId);
    assert.equal(verdict.quiesced, true, JSON.stringify(verdict));
    assert.equal(fresh.snapshot().find((r) => r.instanceId === deadId).status, "EXITED");

    // (c) 上一次进程遗留的 record + socket 仍存活 → 只能 ACTIVE，绝不 quiesced。
    const aliveId = "exe_alive001";
    const aliveSock = path.join(execDir, aliveId + ".sock");
    const aliveServer = net.createServer((s) => { try { s.end(); } catch { /* ignore */ } });
    await new Promise((r) => aliveServer.listen(aliveSock, r));
    fs.writeFileSync(path.join(execDir, aliveId + ".json"), JSON.stringify({ instanceId: aliveId, status: "ACTIVE", socketPath: aliveSock, startedAt: 1, callId: "scall_y", holderId: "e", endedAt: null, exitCode: null, signal: null, reason: null }));
    const fresh2 = new RuntimeSupervisor({ runtimeDir: root });
    await fresh2.rehydrate();
    const alive = fresh2.isQuiesced(aliveId);
    assert.equal(alive.quiesced, false, "存活的上一次 executor 绝不能被声明 quiesced");
    assert.equal(alive.reason, "RUNTIME_STILL_ACTIVE");
    await new Promise((r) => aliveServer.close(r));
    const fresh3 = new RuntimeSupervisor({ runtimeDir: root });
    await fresh3.rehydrate();
    assert.equal(fresh3.isQuiesced(aliveId).quiesced, true, "listener 真实消失后才允许 quiesced");
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
