/**
 * D4-04 Closure-2 · Real Product Main Assembly Seal
 *
 * 这个 Gate 专门证明真实 product boot assembly，而不是只证明 probe host：
 *   1. 真实 electron/main.cjs 与 D4-04 probe 调用**同一个** production runtime boot helper；
 *   2. 真实 boot 顺序：createIdentityService < modelProxy.start < runtime ready < 第一次 Task admission；
 *   3. 顺序错误（proxy start 早于 identity 创建）必须 loud fail，绝不被静默吞掉；
 *   4. Electron main 里 utilityProcess 不可用时 executor launcher **必须** fail closed；
 *   5. production 源码不存在 OPENARC_EXECUTOR_FAULT kill-switch；
 *   6. unix socket path 长度回归 + persisted record 无 socketPath。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const { createOpenArcRuntime, startProductModelProxy, ASSEMBLY_ORDER_VIOLATION } = require("../electron/runtime-boot.cjs");
const { NodeChildProcessLauncher, ElectronUtilityProcessLauncher, UnavailableExecutorLauncher, selectExecutorLauncher, createDefaultExecutorLauncher } = require("../electron/executor-launcher.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

const read = (p) => fs.readFileSync(p, "utf8");
const MAIN_SRC = read(path.join(ROOT, "electron", "main.cjs"));
const PROBE_SRC = read(path.join(ROOT, "tests", "fixtures", "d4-04-probe", "main.cjs"));
const BOOT_SRC = read(path.join(ROOT, "electron", "runtime-boot.cjs"));

/* ---------------------------------------------------------------- 1. shared production boot */

test("Real Product Main 与 probe 共享唯一 production runtime boot（不允许各自漂移）", () => {
  assert.match(MAIN_SRC, /require\("\.\/runtime-boot\.cjs"\)/, "main.cjs 必须 require runtime-boot");
  assert.match(MAIN_SRC, /createOpenArcRuntime\(\{/, "main.cjs 必须调用 createOpenArcRuntime");
  assert.match(PROBE_SRC, /electron\/runtime-boot\.cjs/, "probe 必须 require 同一个 runtime-boot");
  assert.match(PROBE_SRC, /createOpenArcRuntime\(\{/, "probe 必须调用 createOpenArcRuntime");
  // 旧的 bug 形态：在 identity 创建之前直接 start Model Proxy。
  assert.ok(!/await identity\.modelProxy\.start\(/.test(MAIN_SRC), "main.cjs 不得在 boot helper 之外直接 start modelProxy");
  assert.ok(!/createIdentityService\(/.test(MAIN_SRC), "main.cjs 不得自行 createIdentityService（必须走共享 helper）");
  // 禁止静默吞掉 assembly 顺序 bug 的 try/catch 形态。
  assert.ok(!/try\s*\{\s*await[^}]*modelProxy\.start\(\)[^}]*\}\s*catch\s*\{\s*\}/s.test(MAIN_SRC), "main.cjs 不得用空 catch 吞掉 modelProxy.start");
  // 共享 helper 必须保证顺序：identity 创建早于 proxy start。
  const identityAt = BOOT_SRC.indexOf("createIdentityService({");
  const startAt = BOOT_SRC.indexOf("await startProductModelProxy(identity)");
  assert.ok(identityAt > 0 && startAt > identityAt, "boot helper 必须先创建 identity 再 start proxy");
});

test("共享 helper 的启动顺序：main / probe 都不得绕过 runtime-boot 单独注册 IPC 装配", () => {
  assert.match(PROBE_SRC, /registerIdentityIpc\(/, "probe 使用产品 registerIdentityIpc");
  assert.match(PROBE_SRC, /registerTaskIpc\(/, "probe 使用产品 registerTaskIpc");
  assert.match(MAIN_SRC, /registerIdentityIpc\(/, "main 使用产品 registerIdentityIpc");
  assert.match(MAIN_SRC, /registerTaskIpc\(/, "main 使用产品 registerTaskIpc");
});

test("Probe/Product Equivalence：preload / dist / launcher / Tool Facade 不得漂移", () => {
  assert.match(PROBE_SRC, /electron\/preload\.cjs/, "probe 必须使用产品 preload");
  assert.match(PROBE_SRC, /dist\/index\.html/, "probe 必须使用产品 dist Renderer");
  assert.match(MAIN_SRC, /preload\.cjs/, "main 使用产品 preload");
  assert.match(PROBE_SRC, /createDefaultExecutorLauncher\(\)/, "probe 使用共享 launcher 选择");
  assert.match(MAIN_SRC, /createDefaultExecutorLauncher\(\)/, "main 使用同一个 launcher 选择");
  assert.ok(!/new RuntimeSupervisor\(/.test(PROBE_SRC), "probe 不得自建 supervisor");
  assert.ok(!/new SideEffectRuntime\(/.test(PROBE_SRC), "probe 不得自建 SideEffectRuntime");
  assert.ok(!/createToolHarnessFixture/.test(PROBE_SRC), "probe 不得使用测试夹具装配");
  assert.ok(!/toolFacade\s*:/.test(PROBE_SRC), "probe 不得覆盖 Tool Facade 配置");
});

/* ---------------------------------------------------------------- 2. dynamic boot ordering */

test("Dynamic：createIdentityService seq < modelProxy.start seq < 第一次 Task admission", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d404c2-boot-"));
  let runtime = null;
  try {
    runtime = await createOpenArcRuntime({ userDataDir: dir, safeStorage: null, allowAdmin: true });
    const snap = runtime.snapshot();
    assert.equal(snap.identityCreated, true, JSON.stringify(snap));
    assert.equal(snap.modelProxyStartAttempted, true, JSON.stringify(snap));
    assert.equal(snap.modelProxyStarted, true, "Model Proxy 必须真正 listening：" + JSON.stringify(snap));
    assert.equal(snap.modelProxyListening, true, JSON.stringify(snap));
    const order = snap.bootOrder;
    assert.ok(order.indexOf("identity_created") >= 0, JSON.stringify(order));
    assert.ok(order.indexOf("identity_created") < order.indexOf("model_proxy_start_attempted"), "identity 必须先于 proxy start");
    assert.ok(order.indexOf("model_proxy_start_attempted") < order.indexOf("runtime_ready"), "proxy start attempt 必须先于 runtime ready");
    // 真实 Model Proxy 实例就是 Task Runtime 使用的那一个（Harness Model Adapter 的上游）。
    assert.ok(runtime.identity.modelProxy.server, "proxy 必须真正 listen");
    assert.match(String(runtime.identity.modelProxy.baseUrl), /^http:\/\/127\.0\.0\.1:\d+$/, "proxy 只 bind loopback");
    const admission = runtime.noteTaskAdmission();
    assert.equal(admission.afterProxyStartAttempt, true);
    assert.equal(admission.afterProxyStart, true);
    assert.equal(admission.afterRuntimeReady, true);
  } finally {
    try { await runtime?.identity?.modelProxy?.stop(); } catch { /* ignore */ }
    try { runtime?.identity?.store?.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- 3. regression against original bug */

test("Regression：modelProxy.start 早于 identity 创建必须被检测并 loud fail", async () => {
  await assert.rejects(() => startProductModelProxy(undefined), (e) => e.code === ASSEMBLY_ORDER_VIOLATION, "identity 未创建时 start 必须抛 ASSEMBLY_ORDER_VIOLATION");
  await assert.rejects(() => startProductModelProxy({}), (e) => e.code === ASSEMBLY_ORDER_VIOLATION, "identity 缺少 modelProxy 时必须抛 ASSEMBLY_ORDER_VIOLATION");
  await assert.rejects(() => startProductModelProxy({ modelProxy: {} }), (e) => e.code === ASSEMBLY_ORDER_VIOLATION, "modelProxy 缺少 start 时必须抛 ASSEMBLY_ORDER_VIOLATION");
});

/* ---------------------------------------------------------------- 4. executor launcher fail closed */

test("Electron main：utilityProcess 不可用时 launcher 必须 fail closed（绝不回退 spawn(process.execPath))", () => {
  const unavailable = selectExecutorLauncher({ isElectronMain: true, utilityProcess: null });
  assert.ok(unavailable instanceof UnavailableExecutorLauncher);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, "EXECUTOR_LAUNCHER_UNAVAILABLE");
  assert.throws(() => unavailable.launch({ entry: "/x", args: [], env: {} }), (e) => e.code === "EXECUTOR_LAUNCHER_UNAVAILABLE");
  // utilityProcess 存在但没有 fork 也必须 fail closed。
  assert.equal(selectExecutorLauncher({ isElectronMain: true, utilityProcess: {} }).available, false);
  // 正常 Electron main → utility process launcher。
  const okLauncher = selectExecutorLauncher({ isElectronMain: true, utilityProcess: { fork: () => {} } });
  assert.ok(okLauncher instanceof ElectronUtilityProcessLauncher);
  assert.equal(okLauncher.available, true);
  // 纯 Node → node child launcher（test seam 保留）。
  const nodeLauncher = selectExecutorLauncher({ isElectronMain: false });
  assert.ok(nodeLauncher instanceof NodeChildProcessLauncher);
  assert.equal(nodeLauncher.available, true);
  // 当前进程（Node test）默认也必须是 node launcher。
  assert.ok(createDefaultExecutorLauncher() instanceof NodeChildProcessLauncher);
});

test("RuntimeSupervisor：launcher unavailable → spawnExecutor fail closed（0 runtime / 0 spawn）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d404c2-launcher-"));
  try {
    const supervisor = new RuntimeSupervisor({ runtimeDir: path.join(dir, "rt"), launcher: new UnavailableExecutorLauncher() });
    const box = supervisor.spawnExecutor({ callId: "scall_x", holderId: "oase_1", dbPath: path.join(dir, "db"), storeRoot: null });
    assert.equal(box.ok, false, JSON.stringify(box));
    assert.equal(box.error, "EXECUTOR_LAUNCHER_UNAVAILABLE");
    assert.equal(supervisor.snapshot().length, 0, "不得注册 runtime");
    assert.equal(supervisor.executorEvidence().length, 0, "不得产生 executor evidence");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- 5. no production fault switch */

test("Production 源码 0 处 OPENARC_EXECUTOR_FAULT（kill-switch 已删除）", () => {
  const files = fs.readdirSync(path.join(ROOT, "electron")).filter((f) => f.endsWith(".cjs"));
  const hits = files.filter((f) => read(path.join(ROOT, "electron", f)).includes("OPENARC_EXECUTOR_FAULT"));
  assert.deepEqual(hits, [], "production 源码不得存在 OPENARC_EXECUTOR_FAULT");
  assert.ok(!PROBE_SRC.includes("process.env.OPENARC_EXECUTOR_FAULT"), "probe 不得用 env 注入 fault");
  assert.ok(PROBE_SRC.includes("executorTestHook"), "probe 只能走 constructor-only seam");
});

/* ---------------------------------------------------------------- 6. socket path regression */

test("Socket Path Regression：长 runtimeDir → 短派生 socket 目录；record 无 socketPath", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d404c2-long-"));
  const longDir = path.join(base, "x".repeat(60), "runtime", "side-effects");
  try {
    const natural = path.join(longDir, "executors", "exe_AbCdEfGh.sock");
    assert.ok(Buffer.byteLength(natural) > 104, "前置：自然路径必须越界：" + Buffer.byteLength(natural));
    const supervisor = new RuntimeSupervisor({ runtimeDir: longDir });
    const derived = supervisor.socketPath("exe_AbCdEfGh");
    assert.ok(Buffer.byteLength(derived) <= 104, "派生 socket path 必须落在 unix socket 上限内：" + derived);
    assert.ok(derived.endsWith("exe_AbCdEfGh.sock"), derived);
    supervisor.registerExecutor("exe_AbCdEfGh", { callId: "scall_x", holderId: "oase_1" });
    const rec = JSON.parse(fs.readFileSync(path.join(longDir, "executors", "exe_AbCdEfGh.json"), "utf8"));
    assert.ok(!("socketPath" in rec), "persisted record 不得含 socketPath");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
