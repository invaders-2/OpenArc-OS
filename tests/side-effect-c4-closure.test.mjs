/**
 * D4-03C4 Closure · Cold-restart Runtime Quiescence Probe must fail closed。
 *
 * 永久规则（D4-03C4 Closure-2 收紧）：
 *   **Probe failure is not death proof.**  **Unix socket pathname existence != process lifetime.**
 *   filesystem unix-socket probe 只回答 ALIVE / UNKNOWN（reachability），没有 PROCESS_DEAD 结论；
 *   ENOENT / stale endpoint / timeout / 任意 OS error / probe 自身异常一律 UNKNOWN → quiesced=false。
 *   只有“同一 supervisor lifetime 的真实 child 'exit'”或“上一次 production supervisor 持久化的
 *   trusted EXITED proof”允许 RuntimeLifecycleAuthority.observeExit()。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createToolHarnessFixture, reopenToolHarnessRuntime } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { RuntimeSupervisor, probeUnixSocket, normalizeProbeResult, LIVENESS } = require("../electron/runtime-supervisor.cjs");
const { RuntimeLifecycleAuthority } = require("../electron/runtime-lifecycle-authority.cjs");
const { ToolRegistry } = require("../electron/tool-registry.cjs");

const SUPERVISOR_SRC = path.join(import.meta.dirname, "..", "electron", "runtime-supervisor.cjs");
const GATED_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "supervised-executor.mjs");
const TRASH = "resource.trash";
// 这里刻意不 unref：probe / rehydrate 的等待必须真正保持 event loop 存活。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (fn, ms, detail = "") => (async () => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();

/* ================================================================== 1. tri-state probe classification */

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

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

/** 永不 connect / 永不 error 的假 socket：让真实 probe 逻辑走到 timeout（真实 OS timer）。 */
function timeoutSocket() {
  return {
    setTimeout(ms) { this.__t = setTimeout(() => { if (this.__timeout) this.__timeout(); }, Math.max(1, Number(ms) || 1)); return this; },
    on(ev, fn) { if (ev === "timeout") this.__timeout = fn; return this; },
    destroy() { if (this.__t) clearTimeout(this.__t); },
  };
}
/** 立刻发出指定 errno 的假 socket。 */
function errorSocket(code) {
  return { setTimeout() { return this; }, on(ev, fn) { if (ev === "error") setImmediate(() => fn(code === undefined ? new Error("boom") : Object.assign(new Error("boom"), { code }))); return this; }, destroy() { /* ignore */ } };
}
/** 立刻 connect 成功的假 socket。 */
function connectSocket() { return { setTimeout() { return this; }, on(ev, fn) { if (ev === "connect") setImmediate(() => fn()); return this; }, destroy() { /* ignore */ } }; }

test("Reachability probe：real ALIVE；真实 stale endpoint（SIGKILL）/ ENOENT 一律 UNKNOWN（pathname 无死亡权威）", async () => {
  const root = tmpDir("oa-c4c-probe-");
  try {
    const livePath = path.join(root, "live.sock");
    const holder = await holdSocket(livePath);
    assert.equal((await probeUnixSocket(livePath)).state, LIVENESS.ALIVE, "connect 成功 = ALIVE");
    await holder.kill();
    assert.equal(fs.existsSync(livePath), true, "SIGKILL 后 socket 文件仍在（真实 stale endpoint）");
    const stale = await probeUnixSocket(livePath);
    assert.equal(stale.state, LIVENESS.UNKNOWN, "stale endpoint 不得被当作 death proof：" + JSON.stringify(stale));
    assert.notEqual(stale.reason, "ENDPOINT_ABSENT");
    fs.unlinkSync(livePath);
    assert.equal((await probeUnixSocket(livePath)).state, LIVENESS.UNKNOWN, "ENOENT（pathname 消失）不是 process death proof");
    assert.equal((await probeUnixSocket(path.join(root, "never.sock"))).state, LIVENESS.UNKNOWN);
    assert.deepEqual(Object.values(LIVENESS), ["ALIVE", "UNKNOWN"], "pathname probe 只有 ALIVE / UNKNOWN 两态");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Tri-state probe：timeout → UNKNOWN（不是 death proof）", async () => {
  const res = await probeUnixSocket("/tmp/oa-c4c-timeout.sock", { timeoutMs: 20, connectImpl: () => timeoutSocket() });
  assert.equal(res.state, LIVENESS.UNKNOWN, JSON.stringify(res));
  assert.equal(res.reason, "PROBE_TIMEOUT");
});

test("Tri-state probe：任意意外 OS error → UNKNOWN（EACCES / EMFILE / ENFILE / ENOBUFS / ECONNREFUSED / 未知 errno / 无 code）", async () => {
  for (const code of ["EACCES", "EMFILE", "ENFILE", "ENOBUFS", "ENOMEM", "ECONNREFUSED", "CUSTOM_TRANSIENT_ERROR", undefined]) {
    const res = await probeUnixSocket("/tmp/oa-c4c-err.sock", { connectImpl: () => errorSocket(code) });
    assert.equal(res.state, LIVENESS.UNKNOWN, code + " 必须 fail closed：" + JSON.stringify(res));
    assert.notEqual(res.reason, "ENDPOINT_ABSENT");
    assert.ok(!String(res.reason).includes("/"), "reason 不得含路径");
  }
});

test("Tri-state probe：probe 自身异常 / 不可信返回值一律 UNKNOWN", async () => {
  assert.equal((await probeUnixSocket("/tmp/x.sock", { connectImpl: () => { throw new Error("kaboom"); } })).state, LIVENESS.UNKNOWN);
  assert.equal((await probeUnixSocket("/tmp/x.sock", { connectImpl: () => null })).state, LIVENESS.UNKNOWN);
  assert.equal((await probeUnixSocket("/tmp/x.sock", { connectImpl: () => ({}) })).state, LIVENESS.UNKNOWN);
  // 旧 boolean 语义绝不能被当成死亡证明。
  assert.equal(normalizeProbeResult(false).state, LIVENESS.UNKNOWN);
  assert.equal(normalizeProbeResult(undefined).state, LIVENESS.UNKNOWN);
  assert.equal(normalizeProbeResult("nonsense").state, LIVENESS.UNKNOWN);
  assert.equal(normalizeProbeResult(true).state, LIVENESS.ALIVE);
  assert.equal((await probeUnixSocket("/tmp/x.sock", { connectImpl: () => connectSocket() })).state, LIVENESS.ALIVE);
});

/* ================================================================== 2. observeExit authority boundary */

function countingLifecycle() {
  const lifecycle = new RuntimeLifecycleAuthority();
  const box = { observeExit: 0, registerRuntime: 0 };
  const realObserve = lifecycle.observeExit.bind(lifecycle);
  const realRegister = lifecycle.registerRuntime.bind(lifecycle);
  lifecycle.observeExit = (...a) => { box.observeExit += 1; return realObserve(...a); };
  lifecycle.registerRuntime = (...a) => { box.registerRuntime += 1; return realRegister(...a); };
  return { lifecycle, box };
}
function persistRecord(dir, rec) {
  fs.mkdirSync(path.join(dir, "executors"), { recursive: true });
  fs.writeFileSync(path.join(dir, "executors", rec.instanceId + ".json"), JSON.stringify(rec));
}
const activeRecord = (instanceId) => ({ instanceId, status: "ACTIVE", socketPath: null, startedAt: 1, callId: "scall_z", holderId: "exec_1", endedAt: null, exitCode: null, signal: null, reason: null });

test("UNKNOWN probe 绝不 observeExit / 绝不 quiesced / 绝不改写 persisted record", async () => {
  const root = tmpDir("oa-c4c-unknown-");
  try {
    const id = "exe_unknown1";
    const rec = { ...activeRecord(id), socketPath: path.join(root, "executors", id + ".sock") };
    persistRecord(root, rec);
    const { lifecycle, box } = countingLifecycle();
    const logs = [];
    const supervisor = new RuntimeSupervisor({ runtimeDir: root, lifecycle, logger: { log: (r) => logs.push(r) }, probeImpl: () => ({ state: LIVENESS.UNKNOWN, reason: "PROBE_TIMEOUT", errno: null }) });
    const stats = await supervisor.rehydrate();
    assert.equal(box.observeExit, 0, "UNKNOWN 绝不能触发 observeExit");
    assert.equal(supervisor.isQuiesced(id).quiesced, false);
    assert.equal(supervisor.isQuiesced(id).reason, "LIVENESS_UNKNOWN");
    assert.equal(stats.unknown, 1);
    assert.equal(stats.dead, 0, "UNKNOWN 不得计入 dead");
    assert.equal(stats.alive, 0);
    const persisted = JSON.parse(fs.readFileSync(path.join(root, "executors", id + ".json"), "utf8"));
    assert.equal(persisted.status, "ACTIVE", "persisted record 必须保持 ACTIVE");
    assert.notEqual(persisted.reason, "OS_EXECUTOR_ENDPOINT_ABSENT");
    // §21：safe 事件；不含绝对路径 / 目录 / secret。
    const text = JSON.stringify(logs);
    assert.ok(text.includes("runtime_liveness_unknown"), "必须记录 safe liveness 事件");
    assert.ok(text.includes(id));
    assert.ok(!text.includes(root), "日志不得含 runtime 目录");
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders/.test(text), "日志不得含绝对路径");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("pathname probe 无权 observeExit：自称 DEFINITELY_GONE / legacy boolean 一律 UNKNOWN；ALIVE → 0 observeExit", async () => {
  const root = tmpDir("oa-c4c-gone-");
  try {
    const claim = "exe_gone1";
    const live = "exe_live1";
    persistRecord(root, { ...activeRecord(claim), socketPath: path.join(root, "executors", claim + ".sock") });
    persistRecord(root, { ...activeRecord(live), socketPath: path.join(root, "executors", live + ".sock") });
    const { lifecycle, box } = countingLifecycle();
    // 即使 probe 自称 "DEFINITELY_GONE" / 旧 boolean false，也绝不是死亡证明。
    const supervisor = new RuntimeSupervisor({ runtimeDir: root, lifecycle, probeImpl: (p) => (String(p).includes(live) ? { state: LIVENESS.ALIVE, reason: "CONNECTED" } : false) });
    const stats = await supervisor.rehydrate();
    assert.equal(box.observeExit, 0, "pathname probe 绝不产生 observeExit");
    assert.equal(supervisor.isQuiesced(claim).quiesced, false, "pathname probe 不得 quiesce");
    assert.equal(supervisor.isQuiesced(claim).reason, "LIVENESS_UNKNOWN");
    assert.equal(supervisor.isQuiesced(live).quiesced, false);
    assert.equal(supervisor.isQuiesced(live).reason, "RUNTIME_STILL_ACTIVE");
    assert.equal(stats.dead, 0);
    assert.equal(stats.alive, 1);
    assert.equal(stats.unknown, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("真实 timeout 经 production probe seam → UNKNOWN → observeExit=0 / quiesced=false", async () => {
  const root = tmpDir("oa-c4c-timeout2-");
  try {
    const id = "exe_timeout1";
    persistRecord(root, { ...activeRecord(id), socketPath: path.join(root, "executors", id + ".sock") });
    const { lifecycle, box } = countingLifecycle();
    // 生产 probe 逻辑 + test-only socket seam：永不 connect / 永不 error。
    const supervisor = new RuntimeSupervisor({
      runtimeDir: root, lifecycle, probeTimeoutMs: 30,
      probeImpl: (p) => probeUnixSocket(p, { timeoutMs: 30, connectImpl: () => timeoutSocket() }),
    });
    const stats = await supervisor.rehydrate();
    assert.equal(box.observeExit, 0, "timeout 永远不能产生 observeExit");
    assert.equal(supervisor.isQuiesced(id).quiesced, false, "timeout 后 quiesced 必须为 false");
    assert.equal(supervisor.isQuiesced(id).reason, "LIVENESS_UNKNOWN");
    assert.equal(stats.unknown, 1);
    assert.equal(stats.dead, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("注入 EACCES / EMFILE / 自定义 errno → UNKNOWN → observeExit=0 / quiesced=false", async () => {
  for (const code of ["EACCES", "EMFILE", "CUSTOM_TRANSIENT_ERROR"]) {
    const root = tmpDir("oa-c4c-errno-");
    try {
      const id = "exe_err1";
      persistRecord(root, { ...activeRecord(id), socketPath: path.join(root, "executors", id + ".sock") });
      const { lifecycle, box } = countingLifecycle();
      const supervisor = new RuntimeSupervisor({ runtimeDir: root, lifecycle, probeImpl: (p) => probeUnixSocket(p, { connectImpl: () => errorSocket(code) }) });
      const stats = await supervisor.rehydrate();
      assert.equal(box.observeExit, 0, code + " 不得触发 observeExit");
      assert.equal(supervisor.isQuiesced(id).quiesced, false, code);
      assert.equal(stats.unknown, 1, code);
      assert.equal(stats.dead, 0, code);
      const persisted = JSON.parse(fs.readFileSync(path.join(root, "executors", id + ".json"), "utf8"));
      assert.notEqual(persisted.reason, "OS_EXECUTOR_ENDPOINT_ABSENT");
      assert.equal(persisted.status, "ACTIVE");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("LIFECYCLE_NOT_READY：rehydrate 完成前 quiesced 必须 false（fail closed）", async () => {
  const root = tmpDir("oa-c4c-notready-");
  try {
    const supervisor = new RuntimeSupervisor({ runtimeDir: root });
    const v = supervisor.isQuiesced("exe_whatever");
    assert.equal(v.quiesced, false);
    assert.equal(v.reason, "LIFECYCLE_NOT_READY");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ================================================================== 3. static gates（timeout / arbitrary error / pathname 消失都不得成为 death proof） */

test("Static Gate：probe 只回答 ALIVE / UNKNOWN（不存在死亡结论）；rehydrate 的 UNKNOWN 分支不调用 observeExit", async () => {
  const src = fs.readFileSync(SUPERVISOR_SRC, "utf8");
  const probeStart = src.indexOf("function probeUnixSocket(");
  const probeEnd = src.indexOf("class RuntimeSupervisor");
  assert.ok(probeStart > 0 && probeEnd > probeStart, "必须能定位 probeUnixSocket");
  const probeSrc = src.slice(probeStart, probeEnd);
  assert.ok(!/observeExit/.test(probeSrc), "probe 内部绝不允许出现 observeExit");
  assert.ok(!/registerRuntime/.test(probeSrc), "probe 内部绝不允许出现 registerRuntime");
  assert.ok(/socket\.on\("timeout", \(\) => finish\(LIVENESS\.UNKNOWN/.test(probeSrc), "timeout handler 必须解析为 UNKNOWN");
  assert.ok(/socket\.on\("error", \(err\) => \{/.test(probeSrc), "error handler 必须显式分类，而不是统一映射成 dead");
  assert.ok(/return finish\(LIVENESS\.UNKNOWN, "UNCERTAIN_LIVENESS:/.test(probeSrc), "任意 OS error（含 ENOENT）必须解析为 UNKNOWN");
  // 去掉注释后的纯代码里不得再有任何 pathname death authority。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert.ok(!/DEFINITELY_GONE/.test(code), "pathname probe 不得再存在 DEFINITELY_GONE 死亡结论");
  assert.ok(!/ENDPOINT_ABSENT/.test(code), "不得存在 endpoint-absent death authority");
  assert.ok(!/done\(/.test(src), "不得存在旧 boolean probe 收敛（done(true/false)）语义");
  assert.ok(!/probeUnixSocket\([^)]*\)\.then\(|state === "DEAD"/.test(src), "不得存在 boolean / DEAD 别名映射");
  // probe path 必须从 validated instanceId 重新派生，绝不信任 persisted record 的 socketPath。
  assert.ok(/this\.#probe\(this\.socketPath\(instanceId\)\)/.test(src), "rehydrate 必须用 this.socketPath(validated instanceId)");
  assert.ok(!/rec\.socketPath/.test(code), "persisted socketPath 绝不作为 probe 输入");
  // rehydrate：UNKNOWN 分支不得调用 observeExit（避免改名规避）。
  const marker = src.indexOf("// UNKNOWN：fail closed");
  assert.ok(marker > 0, "rehydrate 必须有显式 UNKNOWN 分支");
  const branchEnd = src.indexOf("this.#rehydrated = true;", marker);
  assert.ok(branchEnd > marker);
  const unknownBranch = src.slice(marker, branchEnd).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/observeExit/.test(unknownBranch), "UNKNOWN 分支绝不允许 observeExit");
  assert.ok(!/EXITED/.test(unknownBranch), "UNKNOWN 分支不得写 EXITED");
});

/* ================================================================== 4. disk-backed recovery matrix */

let seq = 0;
/**
 * 真实盘上场景：executor 真实 acquire lease 并 claim 到 RUNNING，
 * 然后模拟"拥有它的 supervisor 进程已经不存在"（测试不调用 observeExit），
 * 由真实 production rehydrate 用 tri-state probe 重新判定。
 */
async function scenario(socketMode, { crashAfterMutation = false } = {}) {
  seq += 1;
  // 注意：macOS unix socket 路径上限约 104 字节，temp 前缀必须足够短，否则内核会截断路径。
  const root = tmpDir("c4c-");
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const runtimeDir = path.join(root, "runtime");
  const fx = await createToolHarnessFixture({ withAdapters: true, dbPath, storeRoot, keepData: true, sideEffectRuntimeDir: runtimeDir, sideEffectApprovalWaitMs: 400 });
  const created = await fx.createResource("C4C Target " + seq);
  const resourceRef = created.resource.resourceRef;
  fx.grantTool("ai", ["tool.resource.trash"]);
  fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
  fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
  const run = fx.dshRunSetup();
  const planned = await fx.sideEffectRuntime.proposeWrite({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH, arguments: { resourceRef } });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
  const callId = planned.approvalRequestId;

  // production instanceId 形态：probe path 由它派生，因此必须可校验。
  const execId = "exe_c4c" + seq + Math.random().toString(36).slice(2, 5);
  const socketPath = path.join(runtimeDir, "executors", execId + ".sock");
  const box = spawn(process.execPath, [GATED_EXECUTOR, JSON.stringify({ runtimeDir, dbPath, storeRoot, instanceId: execId, callId, holderId: "exec_1", timeoutMs: 120000, now: fx.f.clock() })], { stdio: ["pipe", "pipe", "pipe"] });
  let out = ""; let err = "";
  box.stdout.on("data", (d) => { out += d; });
  box.stderr.on("data", (d) => { err += d; });
  const exited = new Promise((r) => box.on("exit", (c) => r(c)));
  await waitFor(() => RuntimeSupervisor.parseExecutorMessage(out, "ready"), 30000, "executor 未就绪：" + err);
  assert.equal(fs.existsSync(socketPath), true, "executor lifetime socket 必须存在：" + socketPath);
  await waitFor(() => fx.sideEffectStore.callById(callId).status === "RUNNING", 30000, "claim 未提交");
  if (crashAfterMutation) { box.stdin.write("MUTATE\n"); await waitFor(() => RuntimeSupervisor.parseExecutorMessage(out, "mutation_done"), 30000, "mutation 未提交"); }
  assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, crashAfterMutation);

  // 模拟"上一次 supervisor 进程已死"：它本来会写的 persisted ACTIVE record 留在盘上，且没有任何人 observeExit。
  // socketPath 是 legacy 字段，必须被新 supervisor 完全忽略（probe path 从 instanceId 重新派生）。
  fs.mkdirSync(path.join(runtimeDir, "executors"), { recursive: true });
  const recordPath = path.join(runtimeDir, "executors", execId + ".json");
  fs.writeFileSync(recordPath, JSON.stringify({ instanceId: execId, status: "ACTIVE", socketPath, startedAt: 1, callId, holderId: "exec_1", endedAt: null, exitCode: null, signal: null, reason: null }));

  let keepAlive = false;
  if (socketMode === "alive" || socketMode === "live_unlinked") {
    keepAlive = true; // 旧 runtime 仍存活：它就是 late mutation 的真实来源。
    if (socketMode === "live_unlinked") fs.unlinkSync(socketPath); // pathname 消失 != 进程死亡
  } else {
    box.kill("SIGKILL");
    await exited;
    assert.equal(fs.existsSync(socketPath), true, "SIGKILL 后 stale endpoint 文件必须仍在");
    if (socketMode === "trusted_exited") {
      // 模拟"上一次 production supervisor 在真实 child 'exit' 后持久化了 trusted EXITED proof"。
      // death authority 只能来自这个已发生的 trusted observation，绝不再从 pathname 消失制造。
      fs.writeFileSync(recordPath, JSON.stringify({ instanceId: execId, status: "EXITED", startedAt: 1, callId, holderId: "exec_1", endedAt: 2, exitCode: null, signal: "SIGKILL", reason: "SUPERVISOR_OBSERVED_EXIT" }));
    }
  }
  const fixedNow = fx.f.clock();
  await fx.close();

  // 用与旧 runtime 相同的 trusted clock 重开：session / approval 语义必须一致。
  const rt = await reopenToolHarnessRuntime({ dbPath, storeRoot, runtimeDir, clock: () => fixedNow });
  return { root, rt, execId, callId, resourceRef, run, box, exited, keepAlive, socketPath, storeRoot, dbPath, fixedNow };
}
async function cleanup(s) {
  if (s.keepAlive) { try { s.box.kill("SIGKILL"); } catch { /* ignore */ } try { await s.exited; } catch { /* ignore */ } }
  try { await s.rt.close(); } catch { /* ignore */ }
  try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ }
}
const callOf = (s) => s.rt.sideEffectStore.callById(s.callId);

test("E2E · cold restart + probe UNKNOWN：quiesced=false → NOT_APPLIED 也绝不 FAILED → Call 保持 UNKNOWN_EFFECT / Task·Step BLOCKED / 0 replay", async () => {
  const s = await scenario("unknown");
  try {
    const leaseBefore = s.rt.sideEffectStore.leasesOfCall(s.callId).length;
    const rec = s.rt.recover();
    assert.ok(rec.sideEffect);
    assert.equal(callOf(s).status, "UNKNOWN_EFFECT", "probe UNKNOWN 不得终止 recovery");
    assert.equal(callOf(s).recoverySafe.quiesced, false, "probe UNKNOWN → quiesced 必须为 false");
    assert.equal(callOf(s).recoverySafe.reason, "LIVENESS_UNKNOWN", JSON.stringify(callOf(s).recoverySafe));
    assert.equal(callOf(s).recoverySafe.proof.type, "PROBE_UNCERTAIN");
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).quiesced, false);
    assert.equal(s.rt.taskStore.taskById(s.run.taskId).status, "BLOCKED");
    assert.equal(s.rt.taskStore.stepById(s.run.stepId).status, "BLOCKED");

    const v = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
    assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
    assert.equal(v.resolved, false, "NOT_APPLIED + quiesced=false 绝不能 resolve");
    assert.equal(v.quiesced, false);
    assert.equal(callOf(s).status, "UNKNOWN_EFFECT", "必须保持 UNKNOWN_EFFECT，绝不 FAILED");
    assert.equal(s.rt.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, false, "0 Domain mutation");
    assert.equal(s.rt.sideEffectStore.callsOfTask(s.run.taskId).length, 1, "0 second SideEffectCall");
    assert.equal(s.rt.sideEffectStore.leasesOfCall(s.callId).filter((l) => l.status === "ACTIVE").length, 0, "0 lease reacquire");
    assert.equal(s.rt.sideEffectStore.leasesOfCall(s.callId).length, leaseBefore, "不得新增 lease");
    assert.equal(s.rt.taskStore.taskById(s.run.taskId).status, "BLOCKED");
  } finally { await cleanup(s); }
});

test("Late Effect Safety · probe UNKNOWN：early NOT_APPLIED 绝不 false-negative；随后 APPLIED → SUCCEEDED", async () => {
  const s = await scenario("unknown");
  try {
    s.rt.recover();
    const early = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
    assert.equal(early.outcome, "NOT_APPLIED");
    assert.equal(early.resolved, false);
    assert.equal(callOf(s).status, "UNKNOWN_EFFECT", "绝不能提前 FAILED");

    // 旧 executor 的 late effect 真实出现（trusted Domain，模拟 late-arriving mutation）。
    const del = await s.rt.resourceService.delete({ context: { sessionRef: s.rt.taskStore.taskById(s.run.taskId).session_ref, appId: "ai", source: "agent", agent: true }, resourceRef: s.resourceRef, expectedVersion: 1 });
    assert.equal(del.ok, true, JSON.stringify(del));
    const late = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
    assert.equal(late.outcome, "APPLIED", JSON.stringify(late));
    assert.equal(late.resolved, true);
    assert.equal(callOf(s).status, "SUCCEEDED", "APPLIED 不依赖 quiescence");
    assert.equal(callOf(s).verificationStatus, "PASS");
  } finally { await cleanup(s); }
});

test("E2E · cold restart + persisted trusted EXITED proof：quiesced=true → NOT_APPLIED → FAILED + BLOCK，0 retry", async () => {
  const s = await scenario("trusted_exited");
  try {
    s.rt.recover();
    assert.equal(callOf(s).recoverySafe.quiesced, true, JSON.stringify(callOf(s).recoverySafe));
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).quiesced, true);
    const v = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
    assert.equal(v.outcome, "NOT_APPLIED", JSON.stringify(v));
    assert.equal(v.resolved, true);
    assert.equal(callOf(s).status, "FAILED");
    assert.equal(callOf(s).verificationStatus, "FAIL");
    assert.equal(s.rt.taskStore.taskById(s.run.taskId).status, "BLOCKED");
    assert.equal(s.rt.taskStore.stepById(s.run.stepId).status, "BLOCKED");
    assert.equal(s.rt.sideEffectStore.callsOfTask(s.run.taskId).length, 1, "0 second call / 0 retry");
    assert.equal(s.rt.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, false, "0 Domain replay");
    assert.equal(s.rt.sideEffectStore.leasesOfCall(s.callId).filter((l) => l.status === "ACTIVE").length, 0);
  } finally { await cleanup(s); }
});

test("E2E · cold restart + probe ALIVE（旧 runtime 仍存活）：quiesced=false → NOT_APPLIED 保持 UNKNOWN_EFFECT", async () => {
  const s = await scenario("alive");
  try {
    s.rt.recover();
    assert.equal(callOf(s).status, "UNKNOWN_EFFECT");
    assert.equal(callOf(s).recoverySafe.quiesced, false);
    assert.equal(callOf(s).recoverySafe.reason, "RUNTIME_STILL_ACTIVE", JSON.stringify(callOf(s).recoverySafe));
    assert.equal(s.rt.supervisor.isQuiesced(s.execId).reason, "RUNTIME_STILL_ACTIVE");
    const v = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
    assert.equal(v.outcome, "NOT_APPLIED");
    assert.equal(v.resolved, false);
    assert.equal(callOf(s).status, "UNKNOWN_EFFECT");
    assert.equal(s.rt.resourceService.sideEffectPrecondition({ resourceRef: s.resourceRef }).trashed, false);
  } finally { await cleanup(s); }
});

test("E2E · probe UNKNOWN + verifier INDETERMINATE → 保持 UNKNOWN_EFFECT（不修改 C3 语义）", async () => {
  const s = await scenario("unknown");
  try {
    s.rt.recover();
    // 用一个必然 INDETERMINATE 的恢复路径：把 SideEffectCall 的 precondition 指向不存在的 resource。
    s.rt.sideEffectStore.transactSync(() => s.rt.sideEffectStore.updateCall(s.callId, { recovery_safe: { ...callOf(s).recoverySafe, quiesced: false } }));
    const realPre = s.rt.resourceService.sideEffectPrecondition.bind(s.rt.resourceService);
    s.rt.sideEffectAuthority.adapters = s.rt.sideEffectAuthority.adapters;
    const original = s.rt.resourceService.sideEffectPrecondition;
    s.rt.resourceService.sideEffectPrecondition = () => ({ ok: false, error: "RESOURCE_READ_FAILED" });
    try {
      const v = await s.rt.sideEffectRuntime.verifyUnknownEffect({ callId: s.callId });
      assert.equal(v.outcome, "INDETERMINATE", JSON.stringify(v));
      assert.equal(v.resolved, false);
      assert.equal(callOf(s).status, "UNKNOWN_EFFECT");
    } finally { s.rt.resourceService.sideEffectPrecondition = original; void realPre; }
  } finally { await cleanup(s); }
});
