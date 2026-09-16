/**
 * D4-03C4 Closure-2 · Cold-Restart Death Proof。
 *
 * 永久规则：
 *   **Unix socket pathname existence != process lifetime。**
 *   pathname has been unlinked != bound/open socket process is dead。
 *   因此 filesystem unix-socket probe 只回答 ALIVE / UNKNOWN（reachability），
 *   ENOENT / stale / timeout / 任意 OS error 都不是 executor death proof。
 *
 *   trusted death proof 只来自：
 *     1. 本 supervisor lifetime 内真实的 child process 'exit'；
 *     2. 上一次 production supervisor 在真实 'exit' 后持久化的 trusted EXITED record。
 *
 *   persisted executor record 不保存 socketPath（derived runtime detail，不是 durable authority）；
 *   probe path 每次都由 validated instanceId 重新派生。
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
// 刻意不 unref：probe / rehydrate 的等待必须真正保持 event loop 存活。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (fn, ms, detail = "") => (async () => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ================================================================== helpers */

/** 真实持有一个 unix socket 的 child。 */
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

/* ================================================================== 1. probe 只有 ALIVE / UNKNOWN */

test("pathname probe 只回答 ALIVE / UNKNOWN：ENOENT / stale / timeout / 任意 errno 都不是 death proof", async () => {
  const root = tmpDir("oa-c4c2-probe-");
  let holder = null;
  try {
    const livePath = path.join(root, "live.sock");
    holder = await holdSocket(livePath);
    assert.equal((await probeUnixSocket(livePath)).state, LIVENESS.ALIVE);
    await holder.kill();
    assert.equal(fs.existsSync(livePath), true, "SIGKILL 后 socket 文件仍在（stale endpoint）");
    assert.equal((await probeUnixSocket(livePath)).state, LIVENESS.UNKNOWN, "stale endpoint 不是 death proof");
    fs.unlinkSync(livePath);
    assert.equal((await probeUnixSocket(livePath)).state, LIVENESS.UNKNOWN, "ENOENT 不是 death proof");
    assert.equal((await probeUnixSocket(path.join(root, "never.sock"))).state, LIVENESS.UNKNOWN);
    assert.deepEqual(Object.values(LIVENESS), ["ALIVE", "UNKNOWN"]);
    for (const code of [undefined, "ENOENT", "EACCES", "EMFILE", "ENFILE", "ENOBUFS", "ENOMEM", "ECONNREFUSED", "CUSTOM_TRANSIENT_ERROR"]) {
      const res = await probeUnixSocket("/tmp/oa-c4c2-err.sock", { connectImpl: () => errorSocket(code) });
      assert.equal(res.state, LIVENESS.UNKNOWN, String(code) + " 必须 UNKNOWN：" + JSON.stringify(res));
    }
    const t = await probeUnixSocket("/tmp/oa-c4c2-timeout.sock", { timeoutMs: 20, connectImpl: () => timeoutSocket() });
    assert.equal(t.state, LIVENESS.UNKNOWN);
    assert.equal(t.reason, "PROBE_TIMEOUT");
    assert.equal(normalizeProbeResult(false).state, LIVENESS.UNKNOWN, "legacy boolean 不是 death proof");
    assert.equal(normalizeProbeResult({ state: "DEFINITELY_GONE" }).state, LIVENESS.UNKNOWN, "旧 DEFINITELY_GONE 形态不是 death proof");
    assert.equal(normalizeProbeResult("DEFINITELY_GONE").state, LIVENESS.UNKNOWN);
  } finally {
    try { if (holder && holder.child.exitCode === null && holder.child.signalCode === null) await holder.kill(); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ================================================================== 2. adversarial live-unlink */

test("Adversarial Live-Unlink Gate：Runtime A 仍存活时 unlink 它自己的 socket → 新 supervisor 只能 UNKNOWN，绝不 observeExit", async () => {
  const root = tmpDir("oa-c4c2-unlink-");
  let holder = null;
  try {
    const id = "exe_liveunlink1";
    const sockPath = path.join(root, "executors", id + ".sock");
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });
    holder = await holdSocket(sockPath);
    assert.equal((await probeUnixSocket(sockPath)).state, LIVENESS.ALIVE, "先确认 A 活着");
    writeRecord(root, activeRecord(id, { socketPath: sockPath }));

    // A 仍然存活时删除 pathname。
    fs.unlinkSync(sockPath);
    assert.equal(fs.existsSync(sockPath), false);
    assert.equal(holder.child.exitCode, null, "unlink 不得影响 A 的存活");
    assert.equal(holder.child.signalCode, null);

    const { lifecycle, box } = countingLifecycle();
    const supervisor = new RuntimeSupervisor({ runtimeDir: root, lifecycle });
    const stats = await supervisor.rehydrate();
    assert.equal(box.observeExit, 0, "unlink 绝不产生 observeExit");
    assert.equal(box.registerRuntime, 1);
    assert.equal(supervisor.isQuiesced(id).quiesced, false, "A 仍存活，绝不 quiesced");
    assert.equal(supervisor.isQuiesced(id).reason, "LIVENESS_UNKNOWN");
    assert.equal(supervisor.isQuiesced(id).proof.type, "PROBE_UNCERTAIN");
    assert.equal(stats.dead, 0);
    assert.equal(stats.unknown, 1);
    assert.equal(stats.alive, 0);
    // persisted record 不得被改写。
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "executors", id + ".json"), "utf8")).status, "ACTIVE");
    // A 仍然真的活着：再次 probe（connect 到不存在的 pathname）仍为 UNKNOWN，且 A 可被正常 kill。
    assert.equal((await probeUnixSocket(sockPath)).state, LIVENESS.UNKNOWN);
    await holder.kill();
  } finally {
    try { if (holder && holder.child.exitCode === null && holder.child.signalCode === null) await holder.kill(); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ================================================================== 3. same-supervisor exit proof */

test("Same-supervisor exit proof：真实 child 'exit' → trusted EXITED；cold restart 不再恢复（persisted record 非 authority）", async () => {
  const root = tmpDir("oa-c4c2-exit-");
  let box = null;
  try {
    const supervisor = new RuntimeSupervisor({ runtimeDir: root, executorEntry: LIFETIME_HOLDER });
    // rehydrate 完成后 quiescence 查询才有效（否则 fail closed 成 LIFECYCLE_NOT_READY）。
    await supervisor.rehydrate();
    box = supervisor.spawnExecutor({ callId: "scall_exit1", holderId: "exec_1", dbPath: path.join(root, "x.db"), storeRoot: null });
    assert.equal(box.ok, true, JSON.stringify(box));
    await waitFor(() => RuntimeSupervisor.parseExecutorMessage(box.stdout, "ready"), 20000, "holder 未就绪");
    assert.equal(supervisor.isQuiesced(box.instanceId).quiesced, false);
    assert.equal(supervisor.isQuiesced(box.instanceId).reason, "RUNTIME_STILL_ACTIVE");

    // 只有 production supervisor 的 child lifecycle listener 能产生 trusted proof。
    box.child.kill("SIGKILL");
    await box.done;
    const dead = supervisor.isQuiesced(box.instanceId);
    assert.equal(dead.quiesced, true, JSON.stringify(dead));
    assert.equal(dead.proof.type, "SUPERVISOR_OBSERVED_EXIT");

    const recordPath = path.join(root, "executors", box.instanceId + ".json");
    const raw = fs.readFileSync(recordPath, "utf8");
    const rec = JSON.parse(raw);
    assert.equal(rec.status, "EXITED");
    assert.equal(rec.reason, "SUPERVISOR_OBSERVED_EXIT");
    assert.ok(!("socketPath" in rec), "persisted record 不得含 socketPath");
    assert.ok(!raw.includes(root), "persisted record 不得含 runtimeDir");
    assert.ok(!raw.includes("/"), "persisted record 不得含任何路径");

    // cold restart：persisted EXITED 不再是 authority，绝不再生成 trusted proof。
    const supervisor2 = new RuntimeSupervisor({ runtimeDir: root });
    const stats = await supervisor2.rehydrate();
    const cold = supervisor2.isQuiesced(box.instanceId);
    assert.equal(cold.quiesced, false, "persisted EXITED 不得在 cold restart 变成 trusted death proof");
    assert.equal(cold.reason, "LIVENESS_UNKNOWN");
    assert.equal(cold.proof.probeReason, "UNVERIFIED_PERSISTED_EXIT");
    assert.equal(stats.dead, 0);
    assert.equal(stats.unverifiedExit, 1);
    assert.equal(stats.unknown, 1);
  } finally {
    try { if (box && box.child) box.child.kill("SIGKILL"); } catch { /* ignore */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ================================================================== 4. persisted record trust boundary */

test("Persisted Runtime Record Contract：只含 safe binding，绝不保存 socketPath / 绝对路径 / runtimeDir / dbPath / storeRoot", async () => {
  const root = tmpDir("oa-c4c2-rec-");
  try {
    const supervisor = new RuntimeSupervisor({ runtimeDir: root });
    assert.equal(supervisor.registerExecutor("exe_record01", { callId: "scall_rec1", holderId: "exec_9" }).ok, true);
    const raw = fs.readFileSync(path.join(root, "executors", "exe_record01.json"), "utf8");
    const rec = JSON.parse(raw);
    assert.deepEqual(Object.keys(rec).sort(), ["callId", "endedAt", "exitCode", "holderId", "instanceId", "reason", "signal", "startedAt", "status"].sort());
    assert.ok(!("socketPath" in rec), "record 不得含 socketPath");
    assert.ok(!raw.includes("/"), "record 不得含路径");
    assert.ok(!raw.includes(root));
    assert.equal(rec.instanceId, "exe_record01");
    assert.equal(rec.status, "ACTIVE");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("instanceId Validation：只接受 production 形态；separator / traversal / NUL / absolute / oversized 一律拒绝", async () => {
  for (const id of ["../../outside", "..", "/abs/path", "exe_ok/../x", "exe_ok\\\\x", "exe_ok\u0000x", "e_legacy", "exe_", "", null, undefined, "exe_" + "a".repeat(65), "x".repeat(200)]) {
    assert.equal(isValidInstanceId(id), false, "必须拒绝：" + String(id));
  }
  for (const id of ["exe_a", "exe_abc123", "exe_ABC-xyz_09", "exe_Zm9vYmFy"]) assert.equal(isValidInstanceId(id), true, "必须接受：" + String(id));
  const root = tmpDir("oa-c4c2-valid-");
  try {
    const supervisor = new RuntimeSupervisor({ runtimeDir: root });
    const r = supervisor.registerExecutor("../../escape");
    assert.equal(r.ok, false);
    assert.equal(r.error, "INVALID_INSTANCE_ID");
    assert.deepEqual(fs.readdirSync(path.join(root, "executors")), [], "非法 instanceId 绝不写 record");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Path traversal persisted record：忽略，绝不 probe / persist / observeExit，不能逃出 executorDir", async () => {
  const outside = tmpDir("oa-c4c2-out-");
  const root = tmpDir("oa-c4c2-in-");
  try {
    const execDir = path.join(root, "executors");
    fs.mkdirSync(execDir, { recursive: true });
    // 手工放入 malformed record：instanceId 试图逃出 executorDir，并指向外部一个真实 live socket。
    const outsideSock = path.join(outside, "outside.sock");
    const holder = await holdSocket(outsideSock);
    const evilId = "../../" + path.basename(outside) + "/exe_evil";
    fs.writeFileSync(path.join(execDir, "evil.json"), JSON.stringify(activeRecord(evilId, { socketPath: outsideSock })));
    try {
      const { lifecycle, box } = countingLifecycle();
      const supervisor = new RuntimeSupervisor({ runtimeDir: root, lifecycle });
      const stats = await supervisor.rehydrate();
      assert.equal(box.observeExit, 0, "invalid record 绝不 observeExit");
      assert.equal(box.registerRuntime, 0, "invalid record 绝不 register");
      assert.equal(stats.invalid, 1);
      assert.equal(stats.alive, 0, "绝不 probe 到 executorDir 之外的 live socket");
      assert.equal(stats.unknown, 0);
      assert.equal(stats.dead, 0);
      assert.equal(supervisor.isQuiesced(evilId).quiesced, false);
      // 不得在 executorDir 之外写任何东西。
      assert.deepEqual(fs.readdirSync(execDir).sort(), ["evil.json"]);
      assert.deepEqual(fs.readdirSync(outside).sort(), [path.basename(outsideSock)]);
    } finally { await holder.kill(); }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Legacy socketPath Spoof：persisted socketPath 绝不被采信；probe path 只由 validated instanceId 派生", async () => {
  const root = tmpDir("oa-c4c2-spoof-");
  try {
    const liveId = "exe_spooflive1";
    const liveSock = path.join(root, "executors", liveId + ".sock");
    fs.mkdirSync(path.dirname(liveSock), { recursive: true });
    const holder = await holdSocket(liveSock);
    try {
      // spoof：record 指向真实 live socket，但派生 endpoint 不存在 → 必须 UNKNOWN（不能 ALIVE）。
      writeRecord(root, activeRecord("exe_spoofabs1", { socketPath: liveSock }));
      // 反向 spoof：record 指向不存在的路径，但派生 endpoint 是 live socket → 必须 ALIVE。
      writeRecord(root, activeRecord(liveId, { socketPath: "/some/other/missing.sock" }));
      const supervisor = new RuntimeSupervisor({ runtimeDir: root });
      const stats = await supervisor.rehydrate();
      assert.equal(supervisor.isQuiesced("exe_spoofabs1").quiesced, false);
      assert.equal(supervisor.isQuiesced("exe_spoofabs1").reason, "LIVENESS_UNKNOWN", "spoofed live socketPath 绝不被采信");
      assert.equal(supervisor.isQuiesced(liveId).quiesced, false);
      assert.equal(supervisor.isQuiesced(liveId).reason, "RUNTIME_STILL_ACTIVE", "probe 用派生 path，找到真实 live socket");
      assert.equal(stats.alive, 1);
      assert.equal(stats.unknown, 1);
    } finally { await holder.kill(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("ENOENT without prior EXIT proof → UNKNOWN；ACTIVE cold-restart record 绝不因 pathname probe 变成 EXITED", async () => {
  const root = tmpDir("oa-c4c2-enoent-");
  try {
    const id = "exe_enoent1";
    writeRecord(root, activeRecord(id, { socketPath: "/nonexistent/path.sock" }));
    const { lifecycle, box } = countingLifecycle();
    const supervisor = new RuntimeSupervisor({ runtimeDir: root, lifecycle });
    const stats = await supervisor.rehydrate();
    assert.equal(box.observeExit, 0);
    assert.equal(supervisor.isQuiesced(id).quiesced, false);
    assert.equal(supervisor.isQuiesced(id).reason, "LIVENESS_UNKNOWN");
    assert.equal(supervisor.snapshot().find((r) => r.instanceId === id).status, "ACTIVE");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "executors", id + ".json"), "utf8")).status, "ACTIVE", "persisted record 不得被改写成 EXITED");
    assert.equal(stats.unknown, 1);
    assert.equal(stats.dead, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Persisted EXITED 无 death authority：任何 reason（含 SUPERVISOR_OBSERVED_EXIT / EXECUTOR_SPAWN_FAILED）一律 quiesced=false", async () => {
  const root = tmpDir("oa-c4c2-trusted-");
  try {
    assert.equal(UNVERIFIED_PERSISTED_EXIT, "UNVERIFIED_PERSISTED_EXIT");
    const observedId = "exe_persisted1";
    const spawnFailId = "exe_persisted2";
    const legacyId = "exe_persisted3";
    const forgedId = "exe_persisted4";
    writeRecord(root, exitedRecord(observedId, "SUPERVISOR_OBSERVED_EXIT"));
    writeRecord(root, exitedRecord(spawnFailId, "EXECUTOR_SPAWN_FAILED"));
    writeRecord(root, exitedRecord(legacyId, "OS_EXECUTOR_ENDPOINT_ABSENT"));
    writeRecord(root, { ...exitedRecord(forgedId, "SUPERVISOR_OBSERVED_EXIT"), endedAt: null, exitCode: null, socketPath: "/tmp/forged.sock" });
    const { lifecycle, box } = countingLifecycle();
    const supervisor = new RuntimeSupervisor({ runtimeDir: root, lifecycle });
    const stats = await supervisor.rehydrate();
    for (const id of [observedId, spawnFailId, legacyId, forgedId]) {
      assert.equal(supervisor.isQuiesced(id).quiesced, false, id + " persisted EXITED 绝不许 quiesce");
      assert.equal(supervisor.isQuiesced(id).reason, "LIVENESS_UNKNOWN", id);
      assert.equal(supervisor.isQuiesced(id).proof.probeReason, "UNVERIFIED_PERSISTED_EXIT", id);
      assert.equal(supervisor.snapshot().find((r) => r.instanceId === id).status, "ACTIVE", id + " 内存视图必须 fail closed");
    }
    assert.equal(box.observeExit, 0, "persisted EXITED 绝不调用 observeExit");
    assert.equal(stats.dead, 0);
    assert.equal(stats.unverifiedExit, 4);
    assert.equal(stats.unknown, 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ================================================================== 5. static gates */

test("Static Gate：源码不存在 pathname death authority；registerExecutor 不写 socketPath；probe path 由 validated instanceId 派生", async () => {
  const src = fs.readFileSync(SUPERVISOR_SRC, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert.ok(!/DEFINITELY_GONE/.test(code), "不得存在 DEFINITELY_GONE 死亡结论");
  assert.ok(!/ENDPOINT_ABSENT/.test(code), "不得存在 endpoint-absent death authority");
  assert.ok(!/rec\.socketPath/.test(code), "persisted socketPath 绝不作为 probe 输入");
  assert.ok(!/TRUSTED_EXIT_REASONS/.test(code), "reason 白名单不得作为 death authority");
  assert.ok(/this\.#probe\(this\.socketPath\(instanceId\)\)/.test(code), "probe path 必须由 validated instanceId 派生");
  const regStart = code.indexOf("registerExecutor(");
  const regEnd = code.indexOf("#observeExit(");
  assert.ok(regStart > 0 && regEnd > regStart, "必须能定位 registerExecutor / #observeExit");
  assert.ok(!/socketPath/.test(code.slice(regStart, regEnd)), "registerExecutor 绝不把 socketPath 写进 record");
  const sanitizeStart = code.indexOf("#sanitize(");
  assert.ok(sanitizeStart > 0 && !/socketPath/.test(code.slice(sanitizeStart, code.indexOf("#safeRecord("))), "#sanitize 不得保留 socketPath");
});

/* ================================================================== 6. E2E · live-unlink + UNKNOWN_EFFECT + late mutation */

let seq = 0;
/**
 * 真实盘上场景：Executor A 活着并停在 mutation gate 上。
 *   mode="live_unlinked" ：A 存活时 unlink 它的 lifetime pathname；A 的 late mutation 仍会真实发生。
 *   mode="trusted_exited"：A 被真实 SIGKILL，且上一次 production supervisor 已持久化 trusted EXITED proof。
 * 新 runtime 打开同一 DB 做 recovery，绝不因 pathname 状态创造死亡证据。
 */
async function liveScenario(mode) {
  seq += 1;
  const root = tmpDir("c4c2-");
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const runtimeDir = path.join(root, "runtime");
  const fx = await createToolHarnessFixture({ withAdapters: true, dbPath, storeRoot, keepData: true, sideEffectRuntimeDir: runtimeDir, sideEffectApprovalWaitMs: 400 });
  const created = await fx.createResource("C4C2 Live Target " + seq);
  const resourceRef = created.resource.resourceRef;
  fx.grantTool("ai", ["tool.resource.trash"]);
  fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
  fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
  const run = fx.dshRunSetup();
  const planned = await fx.sideEffectRuntime.proposeWrite({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH, arguments: { resourceRef } });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
  const callId = planned.approvalRequestId;

  const execId = "exe_c4c2" + seq + Math.random().toString(36).slice(2, 5);
  const socketPath = path.join(runtimeDir, "executors", execId + ".sock");
  const box = spawn(process.execPath, [GATED_EXECUTOR, JSON.stringify({ runtimeDir, dbPath, storeRoot, instanceId: execId, callId, holderId: "exec_1", timeoutMs: 120000, holdAfterMutation: true, now: fx.f.clock() })], { stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; let err = "";
  box.stdout.on("data", (d) => { out += d; });
  box.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((r) => box.on("exit", (c) => r(c)));
  await waitFor(() => RuntimeSupervisor.parseExecutorMessage(out, "ready"), 30000, "executor 未就绪：" + err);
  assert.equal(fs.existsSync(socketPath), true, "executor lifetime socket 必须存在");
  await waitFor(() => fx.sideEffectStore.callById(callId).status === "RUNNING", 30000, "claim 未提交");
  assert.equal(box.exitCode, null, "Executor A 必须仍然存活");
  assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "mutation 尚未发生");

  // 模拟"上一次 supervisor 进程已死"：production 形态的 persisted ACTIVE record（无 socketPath）。
  const recordPath = path.join(runtimeDir, "executors", execId + ".json");
  fs.mkdirSync(path.join(runtimeDir, "executors"), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(activeRecord(execId, { callId, holderId: "exec_1" })));
  if (mode === "live_unlinked") {
    // A 仍然存活时 unlink 自己的 lifetime pathname —— 本轮最关键的对抗条件。
    fs.unlinkSync(socketPath);
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(box.exitCode, null, "unlink 不得杀死 A");
  } else {
    // 真实退出，并模拟"上一次 production supervisor 在真实 'exit' 后持久化了 trusted EXITED proof"。
    box.kill("SIGKILL");
    await exited;
    fs.writeFileSync(recordPath, JSON.stringify({ instanceId: execId, status: "EXITED", startedAt: 1, callId, holderId: "exec_1", endedAt: 2, exitCode: null, signal: "SIGKILL", reason: "SUPERVISOR_OBSERVED_EXIT" }));
  }

  const fixedNow = fx.f.clock();
  await fx.close();
  const rt = await reopenToolHarnessRuntime({ dbPath, storeRoot, runtimeDir, clock: () => fixedNow });
  return { root, rt, execId, callId, resourceRef, run, box, exited, storeRoot, dbPath, fixedNow, socketPath, recordPath, getStdout: () => out };
}
async function cleanupScenario(s) {
  try { s.box.kill("SIGKILL"); } catch { /* ignore */ }
  try { await s.exited; } catch { /* ignore */ }
  try { await s.rt.close(); } catch { /* ignore */ }
  try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ }
}

test("E2E · live-unlink + UNKNOWN_EFFECT：A 仍存活 → 绝不 FAILED；late mutation 真实提交 → APPLIED → SUCCEEDED；0 retry / 0 replay", async () => {
  const s = await liveScenario("live_unlinked");
  try {
    const call = () => s.rt.sideEffectStore.callById(s.callId);
    // 新 supervisor 不得因 pathname 消失把 A 判死。
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).quiesced, false, "unlink 不构成 death proof");
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).reason, "LIVENESS_UNKNOWN");
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).proof.type, "PROBE_UNCERTAIN");
    assert.equal(s.rt.supervisor.snapshot().find((r) => r.instanceId === s.execId).status, "ACTIVE");

    const rec = s.rt.recover();
    assert.ok(rec.sideEffect);
    assert.equal(call().status, "UNKNOWN_EFFECT");
    assert.equal(call().recoverySafe.quiesced, false, "quiescence 未证明");
    assert.equal(call().recoverySafe.reason, "LIVENESS_UNKNOWN", JSON.stringify(call().recoverySafe));
    assert.equal(s.rt.taskStore.taskById(s.run.taskId).status, "BLOCKED");
    assert.equal(s.rt.taskStore.stepById(s.run.stepId).status, "BLOCKED");
    const leaseBefore = s.rt.sideEffectStore.leasesOfCall(s.callId).length;
    const callsBefore = s.rt.sideEffectStore.callsOfTask(s.run.taskId).length;

    // early verifier：NOT_APPLIED 但 quiescence 未证明 → 绝不 resolve，绝不 FAILED。
    const early = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
    assert.equal(early.outcome, "NOT_APPLIED", JSON.stringify(early));
    assert.equal(early.resolved, false, "NOT_APPLIED + unproven quiescence 绝不 resolve");
    assert.equal(early.quiesced, false);
    assert.equal(call().status, "UNKNOWN_EFFECT", "绝不提前 FAILED");
    assert.equal(s.rt.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, false, "0 Domain mutation");

    // 放行 A 的真实 late mutation（A 从未死亡；mutation 落盘后按要求保持挂起）。
    let domainDeletes = 0;
    const realDelete = s.rt.resourceService.delete.bind(s.rt.resourceService);
    s.rt.resourceService.delete = async (...a) => { domainDeletes += 1; return realDelete(...a); };
    s.box.stdin.write("MUTATE\n");
    await waitFor(() => !!RuntimeSupervisor.parseExecutorMessage(s.getStdout(), "mutation_done"), 30000, "late mutation 未提交");
    const mutationDone = RuntimeSupervisor.parseExecutorMessage(s.getStdout(), "mutation_done");
    assert.equal(mutationDone.deleteCalls, 1, "A 只执行一次真实 Domain mutation");
    assert.equal(domainDeletes, 0, "recovery runtime 0 Domain replay");
    assert.equal(s.rt.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, true, "A 的真实 late mutation 已落盘");
    // A 在 mutation 后挂起、从未 finalize 自己的 call；现在真实退出。
    s.box.kill("SIGKILL");
    await s.exited;

    const late = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
    assert.equal(late.outcome, "APPLIED", JSON.stringify(late));
    assert.equal(late.resolved, true);
    assert.equal(call().status, "SUCCEEDED", "APPLIED 不依赖 quiescence");
    assert.equal(call().verificationStatus, "PASS");
    assert.equal(s.rt.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, true);
    assert.equal(s.rt.sideEffectStore.callsOfTask(s.run.taskId).length, callsBefore, "0 second SideEffectCall");
    assert.equal(s.rt.sideEffectStore.leasesOfCall(s.callId).length, leaseBefore, "0 lease reacquire");
    assert.equal(s.rt.sideEffectStore.leasesOfCall(s.callId).filter((l) => l.status === "ACTIVE").length, 0, "0 ACTIVE lease");
    // persisted executor JSON 绝对路径扫描（本次 runtime 目录）。
    const persisted = fs.readFileSync(s.recordPath, "utf8");
    assert.ok(!persisted.includes("/"), "persisted record 不得含路径");
    assert.ok(!persisted.includes(s.storeRoot));
    assert.ok(!persisted.includes(s.dbPath));
  } finally { await cleanupScenario(s); }
});

test("E2E · persisted EXITED（真实退出 + trusted-looking reason）：cold restart 仍 fail closed → NOT_APPLIED 保持 UNKNOWN_EFFECT / BLOCK（0 retry / 0 replay）", async () => {
  const s = await liveScenario("trusted_exited");
  try {
    const call = () => s.rt.sideEffectStore.callById(s.callId);
    assert.equal(s.box.exitCode !== null || s.box.signalCode !== null, true, "A 已真实退出");
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).quiesced, false, "persisted EXITED 不是 authority");
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).proof.probeReason, "UNVERIFIED_PERSISTED_EXIT");
    const rec = s.rt.recover();
    assert.ok(rec.sideEffect);
    assert.equal(call().status, "UNKNOWN_EFFECT");
    assert.equal(call().recoverySafe.quiesced, false, JSON.stringify(call().recoverySafe));
    assert.equal(s.rt.taskStore.taskById(s.run.taskId).status, "BLOCKED");
    assert.equal(s.rt.taskStore.stepById(s.run.stepId).status, "BLOCKED");
    const leaseBefore = s.rt.sideEffectStore.leasesOfCall(s.callId).length;
    const callsBefore = s.rt.sideEffectStore.callsOfTask(s.run.taskId).length;
    const v = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
    assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
    assert.equal(v.resolved, false, "NOT_APPLIED + 未证明 quiescence 绝不 resolve");
    assert.equal(call().status, "UNKNOWN_EFFECT", "绝不 FAILED");
    assert.equal(s.rt.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, false, "0 Domain replay");
    assert.equal(s.rt.sideEffectStore.callsOfTask(s.run.taskId).length, callsBefore, "0 second call / 0 retry");
    assert.equal(s.rt.sideEffectStore.leasesOfCall(s.callId).length, leaseBefore, "0 lease reacquire");
    assert.equal(s.rt.sideEffectStore.leasesOfCall(s.callId).filter((l) => l.status === "ACTIVE").length, 0);
  } finally { await cleanupScenario(s); }
});
