/**
 * D4-03C4 Closure-3 · Durable Exit Proof Authority Seal。
 *
 * 永久规则：
 *   **Persisted data saying "SUPERVISOR_OBSERVED_EXIT" != Supervisor actually observing exit now。**
 *   普通 durable JSON 字段（status / reason / exitCode / signal / endedAt）没有资格成为
 *   process-death Authority；reason 字符串命中任何白名单都不构成 trusted proof。
 *
 *   当前实现里唯一允许 observeExit / quiesced=true 的来源：
 *     同一个仍然活着的 production RuntimeSupervisor 真实观测到的 child.on("exit")。
 *
 *   cold restart 没有 authenticated durable lifecycle proof 时一律 fail closed：
 *     persisted EXITED → UNVERIFIED_PERSISTED_EXIT → quiesced=false
 *     （Call 保持 UNKNOWN_EFFECT，绝不 FAILED / retry / replay）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createToolHarnessFixture, reopenToolHarnessRuntime } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { RuntimeSupervisor, probeUnixSocket, normalizeProbeResult, LIVENESS, UNVERIFIED_PERSISTED_EXIT, isValidInstanceId } = require("../electron/runtime-supervisor.cjs");
const { RuntimeLifecycleAuthority } = require("../electron/runtime-lifecycle-authority.cjs");

const SUPERVISOR_SRC = path.join(import.meta.dirname, "..", "electron", "runtime-supervisor.cjs");
const GATED_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "supervised-executor.mjs");
const LIFETIME_HOLDER = path.join(import.meta.dirname, "fixtures", "harness-acp", "lifetime-holder.mjs");
const TRASH = "resource.trash";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (fn, ms, detail = "") => (async () => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ================================================================== helpers */

async function holdSocket(sockPath) {
  const child = spawn(process.execPath, ["-e", "const net=require('node:net');const s=net.createServer(()=>{});s.listen(process.argv[1],()=>process.stdout.write('ready'));", sockPath], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const t0 = Date.now();
  while (!out.includes("ready") && Date.now() - t0 < 15000) await sleep(20);
  assert.ok(out.includes("ready"), "socket holder 未就绪：" + out);
  const done = new Promise((r) => child.on("exit", r));
  return { child, kill: async () => { child.kill("SIGKILL"); await done; } };
}
function timeoutSocket() {
  return {
    setTimeout(ms) { this.__t = setTimeout(() => { if (this.__timeout) this.__timeout(); }, Math.max(1, Number(ms) || 1)); return this; },
    on(ev, fn) { if (ev === "timeout") this.__timeout = fn; return this; },
    destroy() { if (this.__t) clearTimeout(this.__t); },
  };
}
function errorSocket(code) {
  return { setTimeout() { return this; }, on(ev, fn) { if (ev === "error") setImmediate(() => fn(code === undefined ? new Error("boom") : Object.assign(new Error("boom"), { code }))); return this; }, destroy() { /* ignore */ } };
}
function countingLifecycle() {
  const lifecycle = new RuntimeLifecycleAuthority();
  const box = { observeExit: 0, registerRuntime: 0 };
  const realObserve = lifecycle.observeExit.bind(lifecycle);
  const realRegister = lifecycle.registerRuntime.bind(lifecycle);
  lifecycle.observeExit = (...a) => { box.observeExit += 1; return realObserve(...a); };
  lifecycle.registerRuntime = (...a) => { box.registerRuntime += 1; return realRegister(...a); };
  return { lifecycle, box };
}
const activeRecord = (id, extra = {}) => ({ instanceId: id, status: "ACTIVE", startedAt: 1, callId: "scall_z", holderId: "exec_1", endedAt: null, exitCode: null, signal: null, reason: null, ...extra });
const exitedRecord = (id, reason, extra = {}) => ({ instanceId: id, status: "EXITED", startedAt: 1, endedAt: 9, exitCode: 0, signal: null, reason, ...extra });
function writeRecord(root, rec) {
  fs.mkdirSync(path.join(root, "executors"), { recursive: true });
  fs.writeFileSync(path.join(root, "executors", rec.instanceId + ".json"), JSON.stringify(rec));
}

/* ================================================================== 1. real vs forged exit authority */

test("Real Supervisor Exit Proof：同一 supervisor lifetime 的真实 child 'exit' → quiesced=true；cold restart 不再恢复", async () => {
  const root = tmpDir("oa-c4c3-real-");
  let box = null;
  try {
    const supervisor = new RuntimeSupervisor({ runtimeDir: root, executorEntry: LIFETIME_HOLDER });
    await supervisor.rehydrate();
    box = supervisor.spawnExecutor({ callId: "scall_real", holderId: "exec_1", dbPath: path.join(root, "x.db"), storeRoot: null });
    assert.equal(box.ok, true, JSON.stringify(box));
    await waitFor(() => RuntimeSupervisor.parseExecutorMessage(box.stdout, "ready"), 20000, "holder 未就绪");
    assert.equal(supervisor.isQuiesced(box.instanceId).quiesced, false);
    assert.equal(supervisor.isQuiesced(box.instanceId).reason, "RUNTIME_STILL_ACTIVE");

    box.child.kill("SIGKILL");
    await box.done;
    const live = supervisor.isQuiesced(box.instanceId);
    assert.equal(live.quiesced, true, "实时 trusted observation：" + JSON.stringify(live));
    assert.equal(live.proof.type, "SUPERVISOR_OBSERVED_EXIT");

    const rec = JSON.parse(fs.readFileSync(path.join(root, "executors", box.instanceId + ".json"), "utf8"));
    assert.equal(rec.status, "EXITED");
    assert.equal(rec.reason, "SUPERVISOR_OBSERVED_EXIT");
    assert.ok(!("socketPath" in rec));

    // 同一份 persisted record 在 cold restart 里没有 authority。
    const restarted = new RuntimeSupervisor({ runtimeDir: root });
    const stats = await restarted.rehydrate();
    const cold = restarted.isQuiesced(box.instanceId);
    assert.equal(cold.quiesced, false, "persisted EXITED 不得在 cold restart 冒充实时 observation");
    assert.equal(cold.proof.probeReason, UNVERIFIED_PERSISTED_EXIT);
    assert.equal(stats.dead, 0);
    assert.equal(stats.unverifiedExit, 1);
  } finally {
    try { if (box && box.child) box.child.kill("SIGKILL"); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Forged EXITED Record Gate：手工 SUPERVISOR_OBSERVED_EXIT / EXECUTOR_SPAWN_FAILED → observeExit=0 / quiesced=false", async () => {
  const root = tmpDir("oa-c4c3-forge-");
  try {
    const forged = ["exe_forged1", "exe_forged2", "exe_forged3"];
    writeRecord(root, exitedRecord(forged[0], "SUPERVISOR_OBSERVED_EXIT", { callId: "scall_f1", exitCode: 0 }));
    writeRecord(root, exitedRecord(forged[1], "EXECUTOR_SPAWN_FAILED", { callId: "scall_f2", exitCode: null, signal: null }));
    writeRecord(root, exitedRecord(forged[2], "SUPERVISOR_OBSERVED_EXIT", { callId: "scall_f3", endedAt: null, exitCode: null }));
    const { lifecycle, box } = countingLifecycle();
    const supervisor = new RuntimeSupervisor({ runtimeDir: root, lifecycle });
    const stats = await supervisor.rehydrate();
    assert.equal(box.observeExit, 0, "persisted EXITED 绝不调用 observeExit");
    assert.equal(box.registerRuntime, 3, "record 仍然注册为 ACTIVE runtime");
    for (const id of forged) {
      const v = supervisor.isQuiesced(id);
      assert.equal(v.quiesced, false, id + " 伪造 EXITED 必须 fail closed");
      assert.equal(v.reason, "LIVENESS_UNKNOWN", id);
      assert.equal(v.proof.type, "PROBE_UNCERTAIN", id);
      assert.equal(v.proof.probeReason, UNVERIFIED_PERSISTED_EXIT, id);
      assert.equal(supervisor.snapshot().find((r) => r.instanceId === id).status, "ACTIVE", id);
    }
    assert.equal(stats.dead, 0, "reason 白名单不产生 dead");
    assert.equal(stats.unverifiedExit, 3);
    assert.equal(stats.unknown, 3);
    assert.equal(stats.alive, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Persisted EXITED 任何 reason 都不得 observeExit / quiesced；ACTIVE 仍走 reachability probe", async () => {
  const root = tmpDir("oa-c4c3-any-");
  try {
    const reasons = ["SUPERVISOR_OBSERVED_EXIT", "EXECUTOR_SPAWN_FAILED", "OS_EXECUTOR_ENDPOINT_ABSENT", "FORGED", ""];
    reasons.forEach((reason, i) => writeRecord(root, exitedRecord("exe_r" + i, reason)));
    writeRecord(root, activeRecord("exe_activeX", { socketPath: "/nonexistent/legacy.sock" }));
    const { lifecycle, box } = countingLifecycle();
    const supervisor = new RuntimeSupervisor({ runtimeDir: root, lifecycle });
    const stats = await supervisor.rehydrate();
    assert.equal(box.observeExit, 0, "任何 persisted EXITED 都不得 observeExit");
    for (let i = 0; i < reasons.length; i += 1) {
      assert.equal(supervisor.isQuiesced("exe_r" + i).quiesced, false, reasons[i]);
      assert.equal(supervisor.isQuiesced("exe_r" + i).proof.probeReason, UNVERIFIED_PERSISTED_EXIT);
    }
    assert.equal(supervisor.isQuiesced("exe_activeX").quiesced, false, "ACTIVE 仍然 fail closed");
    assert.equal(supervisor.isQuiesced("exe_activeX").reason, "LIVENESS_UNKNOWN");
    assert.equal(stats.dead, 0);
    assert.equal(stats.unverifiedExit, reasons.length);
    assert.equal(stats.unknown, reasons.length + 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Pathname Rules stay frozen：ENOENT / live-unlink / stale / timeout / arbitrary errno 一律 UNKNOWN", async () => {
  const root = tmpDir("oa-c4c3-path-");
  let holder = null;
  try {
    assert.equal((await probeUnixSocket(path.join(root, "never.sock"))).state, LIVENESS.UNKNOWN, "ENOENT 不是 death proof");
    const stalePath = path.join(root, "stale.sock");
    const staleHolder = await holdSocket(stalePath);
    await staleHolder.kill();
    assert.equal(fs.existsSync(stalePath), true);
    assert.equal((await probeUnixSocket(stalePath)).state, LIVENESS.UNKNOWN, "stale endpoint 不是 death proof");
    const livePath = path.join(root, "live.sock");
    holder = await holdSocket(livePath);
    assert.equal((await probeUnixSocket(livePath)).state, LIVENESS.ALIVE);
    fs.unlinkSync(livePath);
    assert.equal(holder.child.exitCode, null, "A 仍存活");
    assert.equal((await probeUnixSocket(livePath)).state, LIVENESS.UNKNOWN, "live-unlink 不是 death proof");
    const t = await probeUnixSocket("/tmp/oa-c4c3-t.sock", { timeoutMs: 20, connectImpl: () => timeoutSocket() });
    assert.equal(t.state, LIVENESS.UNKNOWN);
    for (const code of [undefined, "ENOENT", "EACCES", "EMFILE", "ENFILE", "ENOBUFS", "ENOMEM", "ECONNREFUSED", "CUSTOM"]) {
      assert.equal((await probeUnixSocket("/tmp/oa-c4c3-e.sock", { connectImpl: () => errorSocket(code) })).state, LIVENESS.UNKNOWN, String(code));
    }
    assert.equal(normalizeProbeResult(false).state, LIVENESS.UNKNOWN);
    assert.deepEqual(Object.values(LIVENESS), ["ALIVE", "UNKNOWN"]);
  } finally {
    try { if (holder && holder.child.exitCode === null && holder.child.signalCode === null) await holder.kill(); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Persisted Record Contract Regression：无 socketPath / 绝对路径；instanceId 冻结为 ^exe_[A-Za-z0-9_-]{1,64}$", async () => {
  const root = tmpDir("oa-c4c3-rec-");
  try {
    const supervisor = new RuntimeSupervisor({ runtimeDir: root });
    assert.equal(supervisor.registerExecutor("exe_record01").ok, true);
    const raw = fs.readFileSync(path.join(root, "executors", "exe_record01.json"), "utf8");
    assert.ok(!raw.includes("socketPath"), "record 不得含 socketPath");
    assert.ok(!raw.includes("/"), "record 不得含路径");
    assert.equal(isValidInstanceId("exe_abc123"), true);
    for (const bad of ["../../outside", "/abs", "exe_ok/../x", "exe_ok\\x", "exe_ok\u0000x", "e_legacy", "exe_", "exe_" + "a".repeat(65)]) {
      assert.equal(isValidInstanceId(bad), false, String(bad));
    }
    assert.equal(supervisor.registerExecutor("../../escape").ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ================================================================== 2. static gate */

test("Static Gate：rehydrate 的 EXITED 分支绝无 observeExit / reason 白名单；源码无 TRUSTED_EXIT_REASONS authority", async () => {
  const src = fs.readFileSync(SUPERVISOR_SRC, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert.ok(!/TRUSTED_EXIT_REASONS/.test(code), "不得存在 reason 白名单 authority");
  assert.ok(!/DEFINITELY_GONE/.test(code), "不得存在 pathname death authority");
  assert.ok(/this\.#probe\(this\.socketPath\(instanceId\)\)/.test(code), "probe path 必须由 validated instanceId 派生");
  const exitStart = code.indexOf("if (safe.status === EXECUTOR_STATUS.EXITED) {");
  const probeLine = code.indexOf("this.#probe(this.socketPath(instanceId))");
  assert.ok(exitStart > 0 && probeLine > exitStart, "必须能定位 EXITED 分支");
  const exitBranch = code.slice(exitStart, code.indexOf("this.#records.set(instanceId, safe);", exitStart));
  assert.ok(!/observeExit/.test(exitBranch), "persisted EXITED 分支绝不允许 observeExit");
  assert.ok(/UNVERIFIED_PERSISTED_EXIT/.test(exitBranch), "必须显式标记 UNVERIFIED_PERSISTED_EXIT");
});

/* ================================================================== 3. E2E */

let seq = 0;
function grantResource(fx, created) {
  fx.grantTool("ai", ["tool.resource.trash"]);
  fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
  fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
}
async function prepareCall(fx, label) {
  seq += 1;
  const created = await fx.createResource(label + " " + seq);
  grantResource(fx, created);
  const run = fx.dshRunSetup();
  const planned = await fx.sideEffectRuntime.proposeWrite({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH, arguments: { resourceRef: created.resource.resourceRef } });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
  return { run, callId: planned.approvalRequestId, resourceRef: created.resource.resourceRef };
}

test("E2E · same-lifetime real EXIT + NOT_APPLIED → FAILED（quiesced=true 来自 live observation）", async () => {
  const root = tmpDir("c4c3-same-");
  let fx = null;
  try {
    const dbPath = path.join(root, "identity.db");
    const storeRoot = path.join(root, "library");
    const runtimeDir = path.join(root, "runtime");
    fx = await createToolHarnessFixture({ withAdapters: true, dbPath, storeRoot, keepData: true, sideEffectRuntimeDir: runtimeDir, sideEffectExecutorEntry: GATED_EXECUTOR, sideEffectApprovalWaitMs: 400 });
    const p = await prepareCall(fx, "C4C3 Same");
    const box = fx.supervisor.spawnExecutor({ callId: p.callId, holderId: "exec_1", dbPath, storeRoot, timeoutMs: 250, now: fx.f.clock() });
    assert.equal(box.ok, true, JSON.stringify(box));
    await waitFor(() => RuntimeSupervisor.parseExecutorMessage(box.stdout, "unknown_effect"), 60000, "executor 未到 unknown_effect：" + box.stderr);
    await waitFor(() => fx.sideEffectStore.callById(p.callId).status === "UNKNOWN_EFFECT", 30000, "call 未到 UNKNOWN_EFFECT");
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef: p.resourceRef }).trashed, false, "mutation 未发生");
    // 同一个仍然活着的 supervisor 拥有该 child：真实 kill → 实时 trusted observation。
    box.child.kill("SIGKILL");
    await box.done;
    assert.equal(fx.supervisor.isQuiesced(box.instanceId).quiesced, true, "live observation 必须成立");

    const rec = fx.sideEffectRuntime.recoverOnStartup();
    assert.ok(rec);
    const call = () => fx.sideEffectStore.callById(p.callId);
    assert.equal(call().recoverySafe.quiesced, true, JSON.stringify(call().recoverySafe));
    const v = await fx.sideEffectRuntime.verifyUnknownEffect({ callId: p.callId });
    assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
    assert.equal(v.resolved, true);
    assert.equal(call().status, "FAILED");
    assert.equal(call().verificationStatus, "FAIL");
    assert.equal(fx.taskStore.taskById(p.run.taskId).status, "BLOCKED");
    assert.equal(fx.sideEffectStore.callsOfTask(p.run.taskId).length, 1, "0 second call / 0 retry");
    assert.equal(fx.sideEffectStore.leasesOfCall(p.callId).filter((l) => l.status === "ACTIVE").length, 0);
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef: p.resourceRef }).trashed, false, "0 Domain replay");
  } finally {
    try { if (fx) await fx.close(); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 盘上场景：Executor A 活着并停在 mutation gate。
 *   mode="live_unlinked"   ：A 存活时 unlink 它的 pathname；A 的 late mutation 仍会真实发生。
 *   mode="persisted_exited"：A 真实退出，并留下手工 trusted-looking EXITED record（无 live observer）。
 */
async function liveScenario(mode) {
  const root = tmpDir("c4c3-");
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const runtimeDir = path.join(root, "runtime");
  const fx = await createToolHarnessFixture({ withAdapters: true, dbPath, storeRoot, keepData: true, sideEffectRuntimeDir: runtimeDir, sideEffectApprovalWaitMs: 400 });
  const p = await prepareCall(fx, "C4C3 Live");
  const execId = "exe_c4c3" + seq + Math.random().toString(36).slice(2, 5);
  const socketPath = path.join(runtimeDir, "executors", execId + ".sock");
  const box = spawn(process.execPath, [GATED_EXECUTOR, JSON.stringify({ runtimeDir, dbPath, storeRoot, instanceId: execId, callId: p.callId, holderId: "exec_1", timeoutMs: 120000, holdAfterMutation: true, now: fx.f.clock() })], { stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; let err = "";
  box.stdout.on("data", (d) => { out += d; });
  box.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((r) => box.on("exit", (c) => r(c)));
  await waitFor(() => RuntimeSupervisor.parseExecutorMessage(out, "ready"), 30000, "executor 未就绪：" + err);
  await waitFor(() => fx.sideEffectStore.callById(p.callId).status === "RUNNING", 30000, "claim 未提交");
  assert.equal(box.exitCode, null, "Executor A 必须仍然存活");
  const recordPath = path.join(runtimeDir, "executors", execId + ".json");
  fs.writeFileSync(recordPath, JSON.stringify(activeRecord(execId, { callId: p.callId, holderId: "exec_1" })));
  if (mode === "live_unlinked") {
    fs.unlinkSync(socketPath);
    assert.equal(box.exitCode, null, "unlink 不得杀死 A");
  } else {
    box.kill("SIGKILL");
    await exited;
    fs.writeFileSync(recordPath, JSON.stringify(exitedRecord(execId, "SUPERVISOR_OBSERVED_EXIT", { callId: p.callId, holderId: "exec_1", signal: "SIGKILL" })));
  }
  const fixedNow = fx.f.clock();
  await fx.close();
  const rt = await reopenToolHarnessRuntime({ dbPath, storeRoot, runtimeDir, clock: () => fixedNow });
  return { root, rt, execId, callId: p.callId, resourceRef: p.resourceRef, run: p.run, box, exited, storeRoot, dbPath, fixedNow, recordPath, getStdout: () => out };
}
async function cleanup(s) {
  try { s.box.kill("SIGKILL"); } catch { /* ignore */ }
  try { await s.exited; } catch { /* ignore */ }
  try { await s.rt.close(); } catch { /* ignore */ }
  try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ }
}

test("E2E · live-unlink UNKNOWN：NOT_APPLIED 不 resolve → late mutation APPLIED → SUCCEEDED（0 retry / 0 replay）", async () => {
  const s = await liveScenario("live_unlinked");
  try {
    const call = () => s.rt.sideEffectStore.callById(s.callId);
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).quiesced, false);
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).proof.type, "PROBE_UNCERTAIN");
    s.rt.recover();
    assert.equal(call().status, "UNKNOWN_EFFECT");
    assert.equal(call().recoverySafe.quiesced, false);
    assert.equal(s.rt.taskStore.taskById(s.run.taskId).status, "BLOCKED");
    assert.equal(s.rt.taskStore.stepById(s.run.stepId).status, "BLOCKED");
    const leaseBefore = s.rt.sideEffectStore.leasesOfCall(s.callId).length;
    const callsBefore = s.rt.sideEffectStore.callsOfTask(s.run.taskId).length;
    const early = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
    assert.equal(early.outcome, "NOT_APPLIED", JSON.stringify(early));
    assert.equal(early.resolved, false, "UNKNOWN + NOT_APPLIED 绝不 resolve");
    assert.equal(call().status, "UNKNOWN_EFFECT", "绝不 FAILED");

    let domainDeletes = 0;
    const realDelete = s.rt.resourceService.delete.bind(s.rt.resourceService);
    s.rt.resourceService.delete = async (...a) => { domainDeletes += 1; return realDelete(...a); };
    s.box.stdin.write("MUTATE\n");
    await waitFor(() => !!RuntimeSupervisor.parseExecutorMessage(s.getStdout(), "mutation_done"), 30000, "late mutation 未提交");
    assert.equal(domainDeletes, 0, "recovery runtime 0 Domain replay");

    const late = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
    assert.equal(late.outcome, "APPLIED", JSON.stringify(late));
    assert.equal(late.resolved, true);
    assert.equal(call().status, "SUCCEEDED");
    assert.equal(call().verificationStatus, "PASS");
    assert.equal(s.rt.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, true);
    assert.equal(s.rt.sideEffectStore.callsOfTask(s.run.taskId).length, callsBefore, "0 second SideEffectCall");
    assert.equal(s.rt.sideEffectStore.leasesOfCall(s.callId).length, leaseBefore, "0 lease reacquire");
    assert.equal(s.rt.sideEffectStore.leasesOfCall(s.callId).filter((l) => l.status === "ACTIVE").length, 0);
  } finally { await cleanup(s); }
});

test("E2E · persisted EXITED + UNKNOWN：NOT_APPLIED 保持 UNKNOWN_EFFECT + BLOCK（0 retry / 0 second call / 0 lease / 0 replay）", async () => {
  const s = await liveScenario("persisted_exited");
  try {
    const call = () => s.rt.sideEffectStore.callById(s.callId);
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).quiesced, false, "手工 crafted EXITED 不是 authority");
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).proof.probeReason, UNVERIFIED_PERSISTED_EXIT);
    s.rt.recover();
    assert.equal(call().status, "UNKNOWN_EFFECT");
    assert.equal(call().recoverySafe.quiesced, false);
    assert.equal(s.rt.taskStore.taskById(s.run.taskId).status, "BLOCKED");
    assert.equal(s.rt.taskStore.stepById(s.run.stepId).status, "BLOCKED");
    const leaseBefore = s.rt.sideEffectStore.leasesOfCall(s.callId).length;
    const callsBefore = s.rt.sideEffectStore.callsOfTask(s.run.taskId).length;
    const v = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
    assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
    assert.equal(v.resolved, false);
    assert.equal(call().status, "UNKNOWN_EFFECT", "绝不 FAILED");
    assert.equal(s.rt.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, false, "0 Domain replay");
    assert.equal(s.rt.sideEffectStore.callsOfTask(s.run.taskId).length, callsBefore, "0 second call / 0 retry");
    assert.equal(s.rt.sideEffectStore.leasesOfCall(s.callId).length, leaseBefore, "0 lease reacquire");
    assert.equal(s.rt.sideEffectStore.leasesOfCall(s.callId).filter((l) => l.status === "ACTIVE").length, 0);
    // persisted record 不得被改写。
    assert.equal(JSON.parse(fs.readFileSync(s.recordPath, "utf8")).status, "EXITED", "supervisor 不得改写 persisted hint");
  } finally { await cleanup(s); }
});
