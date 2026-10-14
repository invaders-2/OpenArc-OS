/**
 * B7e1 · ComfyUI 受监督执行测试（全离线：假 runner，无 Electron、无网络、无真实子进程）。
 *
 * 覆盖任务书 item 1 / 2 / 4：
 *   · 可选插件默认关闭 → 执行类命令 INTEGRATION_UNAVAILABLE，且**不启动子进程**；
 *   · 本机缺 Python / ComfyUI → COMFY_DEPENDENCY_UNAVAILABLE，detail 给出 missing + install；
 *   · 提交 / 进度 / 取消 / 超时四条受监督执行路径（假 runner 精确控制 settle）；
 *   · 实例监督 start / stop 同样走受监督 worker；
 *   · 运行返回值无绝对路径。
 *
 * 只读源：electron/comfy-service.cjs、comfy-store.cjs、comfy-domain.cjs、comfy-workflow.cjs、dxos-foundation-runner.cjs。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createComfyBundle } = require("../electron/comfy-service.cjs");

const tmpDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
after(() => { while (tmpDirs.length) { try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* 忽略 */ } } });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const CTX = { sessionRef: "sess-comfy", appId: "ai" };

/** 假 runner：与 dxos-foundation-runner 的 handle 契约同形（result / cancel / pid）。 */
function makeFakeRunner() {
  const starts = [];
  const handles = [];
  function start(spec) {
    let settle;
    const result = new Promise((resolve) => { settle = resolve; });
    const handle = {
      pid: 4000 + starts.length,
      result,
      settled: false,
      cancelled: false,
      cancel(reason) {
        if (handle.settled) return false;
        handle.settled = true;
        handle.cancelled = true;
        settle({ ok: false, code: null, signal: "SIGKILL", stdout: "", stderr: "", truncated: { stdout: false, stderr: false }, timedOut: false, cancelled: true, error: { ok: false, error: "DXOS_ERR_CANCELLED", message: String(reason || "cancelled") }, startedAt: Date.now(), endedAt: Date.now(), durationMs: 1, pid: handle.pid });
        return true;
      },
      finish(outcome) {
        if (handle.settled) return false;
        handle.settled = true;
        settle(Object.assign({ ok: true, code: 0, signal: null, stdout: "", stderr: "", truncated: { stdout: false, stderr: false }, timedOut: false, cancelled: false, error: null, startedAt: Date.now(), endedAt: Date.now(), durationMs: 1, pid: handle.pid }, outcome));
        return true;
      },
      progress(payload) {
        if (typeof spec.onEvent === "function") spec.onEvent({ at: Date.now(), type: "stdout", text: "OPENARC_COMFY_PROGRESS " + JSON.stringify(payload) + "\n" });
      },
      emitResult(envelope) {
        if (typeof spec.onEvent === "function") spec.onEvent({ at: Date.now(), type: "stdout", text: "OPENARC_COMFY_RESULT " + JSON.stringify(envelope) + "\n" });
      },
    };
    starts.push({ op: spec.args[0], spec, handle });
    handles.push(handle);
    return handle;
  }
  return {
    starts,
    handles,
    start,
    cancelAll() { let count = 0; for (const handle of handles) if (handle.cancel("cancelled")) count += 1; return count; },
  };
}

/** 本机依赖齐全的夹具：main.py 与 python 都真实存在（只做存在性校验，不执行）。 */
function makeReadyFixture() {
  const dir = tempDir("dxos-comfy-sup-");
  const root = path.join(dir, "comfy-root");
  fs.mkdirSync(root, { recursive: true });
  const pythonPath = path.join(root, "python3");
  const mainPath = path.join(root, "main.py");
  fs.writeFileSync(pythonPath, "#!/bin/sh\n");
  fs.writeFileSync(mainPath, "# comfyui main\n");
  const runner = makeFakeRunner();
  const bundle = createComfyBundle({ userDataDir: dir, runner, env: {}, instanceTimeoutMs: 5000, runTimeoutMs: 5000 });
  bundle.store.saveConfig({ rootDir: root, pythonPath, mainPath, listen: "127.0.0.1", instances: [{ id: "gpu-0", name: "本机", mode: "local", port: 18188, enabled: true }] });
  return { dir, root, pythonPath, mainPath, runner, bundle };
}

function testPreset() {
  return {
    name: "单元测试工作流",
    instanceId: "gpu-0",
    workflow: {
      "1": { class_type: "CLIPTextEncode", inputs: { text: "默认" } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
    },
    fields: [{ id: "prompt", label: "提示词", type: "textarea", nodeId: "1", input: "text", required: true }],
    outputs: [{ id: "out", label: "结果", nodeId: "2", type: "image" }],
  };
}

// ── 默认关闭 / 依赖缺失 ──────────────────────────────────────────────────
test("默认关闭：执行类命令回 INTEGRATION_UNAVAILABLE，且不启动任何子进程", async () => {
  const dir = tempDir("dxos-comfy-off-");
  const runner = makeFakeRunner();
  const bundle = createComfyBundle({ userDataDir: dir, runner, env: {} });
  const res = await bundle.execute("comfy/run/start", { presetId: "whatever" }, CTX);
  assert.equal(res.ok, false);
  assert.equal(res.error, "INTEGRATION_UNAVAILABLE");
  const start = await bundle.execute("comfy/instances/start", { instanceId: "gpu-0" }, CTX);
  assert.equal(start.error, "INTEGRATION_UNAVAILABLE");
  assert.equal(runner.starts.length, 0, "关闭状态下绝不假运行");
  const health = await bundle.execute("comfy/health", {}, CTX);
  assert.equal(health.ok, true);
  assert.equal(health.value.enabled, false);
  assert.equal(health.value.commands, 24);
});

test("依赖缺失：启用后仍缺 Python / main.py → COMFY_DEPENDENCY_UNAVAILABLE（missing + install）", async () => {
  const dir = tempDir("dxos-comfy-dep-");
  const runner = makeFakeRunner();
  const bundle = createComfyBundle({ userDataDir: dir, runner, env: {} });
  bundle.store.saveConfig({ rootDir: path.join(dir, "does-not-exist"), instances: [{ id: "gpu-0", mode: "local", port: 18188, enabled: true }] });
  await bundle.execute("comfy/plugin/enable", {}, CTX);
  const res = await bundle.execute("comfy/run/start", { presetId: "builtin-qwen21-text-to-image" }, CTX);
  assert.equal(res.ok, false);
  assert.equal(res.error, "COMFY_DEPENDENCY_UNAVAILABLE");
  assert.ok(Array.isArray(res.detail.missing) && res.detail.missing.length >= 1, "detail.missing 必须列出缺什么");
  assert.match(String(res.detail.install), /ComfyUI/);
  assert.ok(Array.isArray(res.detail.missingIds) && res.detail.missingIds.includes("comfy.python"));
  assert.equal(runner.starts.length, 0, "缺依赖时绝不启动子进程");

  const start = await bundle.execute("comfy/instances/start", { instanceId: "gpu-0" }, CTX);
  assert.equal(start.error, "COMFY_DEPENDENCY_UNAVAILABLE");
  assert.equal(runner.starts.length, 0);
});

test("依赖探测：probe 是只读成功命令，如实报告 missing 与安装指引", async () => {
  const dir = tempDir("dxos-comfy-probe-");
  const runner = makeFakeRunner();
  const bundle = createComfyBundle({ userDataDir: dir, runner, env: {} });
  bundle.store.saveConfig({ rootDir: path.join(dir, "nope") });
  const res = await bundle.execute("comfy/dependencies/probe", {}, CTX);
  assert.equal(res.ok, true);
  assert.equal(res.value.dependencies.length, 3);
  assert.ok(res.value.missing.length >= 1);
  assert.ok(res.value.install.length > 0);
  assert.equal(JSON.stringify(res).includes(dir), false, "绝对路径必须已被脱敏");
});

// ── 提交 / 进度 / 完成 ───────────────────────────────────────────────────
test("受监督运行：提交 → 进度 → 结果完成，事件走 comfy:event P1 信封", async () => {
  const fx = makeReadyFixture();
  await fx.bundle.execute("comfy/plugin/enable", {}, CTX);
  const saved = await fx.bundle.execute("comfy/workflows/save", testPreset(), CTX);
  const presetId = saved.value.workflow.id;
  const events = [];
  fx.bundle.setEventSink((event) => events.push(event));
  const res = await fx.bundle.execute("comfy/run/start", { presetId, values: { prompt: "一只猫" } }, CTX);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.run.status, "queued");
  assert.equal(fx.runner.starts.length, 1);
  assert.equal(fx.runner.starts[0].op, "run", "重活只能走 run 子进程操作");
  assert.equal(fx.runner.starts[0].spec.args[1].endsWith(".json"), true, "spec 经文件传递，不经命令行");

  const handle = fx.runner.starts[0].handle;
  handle.progress({ phase: "submitted", promptId: "p-1", percent: 30 });
  await flush();
  const mid = await fx.bundle.execute("comfy/run/get", { runId: res.value.run.id }, CTX);
  assert.equal(mid.value.run.status, "running");
  assert.equal(mid.value.run.promptId, "p-1");
  assert.ok(mid.value.run.progress >= 30, "进度必须来自受监督子进程回推");

  handle.emitResult({ ok: true, result: { promptId: "p-1", results: [{ name: "x.png", type: "image", nodeId: "2" }] } });
  handle.finish({ ok: true });
  await flush();
  await flush();
  const done = await fx.bundle.execute("comfy/run/get", { runId: res.value.run.id }, CTX);
  assert.equal(done.value.run.status, "completed");
  assert.equal(done.value.run.progress, 100);
  assert.deepEqual(done.value.run.results.map((item) => item.name), ["x.png"]);
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.channel, "comfy:event");
    assert.equal(event.domain, "comfy");
    assert.equal(event.kind, "progress");
    assert.equal(typeof event.sequence, "number");
    assert.equal(typeof event.at, "number");
  }
  assert.ok(events.some((event) => event.payload.phase === "completed"));
});

test("参数校验：缺必填字段在编排层拒绝，不启动子进程", async () => {
  const fx = makeReadyFixture();
  await fx.bundle.execute("comfy/plugin/enable", {}, CTX);
  const saved = await fx.bundle.execute("comfy/workflows/save", testPreset(), CTX);
  const res = await fx.bundle.execute("comfy/run/start", { presetId: saved.value.workflow.id, values: {} }, CTX);
  assert.equal(res.ok, false);
  assert.equal(res.error, "COMFY_INVALID_INPUT");
  assert.match(res.message, /请填写提示词/);
  assert.equal(fx.runner.starts.length, 0);
});

// ── 取消 / 超时 ──────────────────────────────────────────────────────────
test("受监督取消：run/cancel 取消句柄并落 cancelled 状态", async () => {
  const fx = makeReadyFixture();
  await fx.bundle.execute("comfy/plugin/enable", {}, CTX);
  const saved = await fx.bundle.execute("comfy/workflows/save", testPreset(), CTX);
  const started = await fx.bundle.execute("comfy/run/start", { presetId: saved.value.workflow.id, values: { prompt: "x" } }, CTX);
  const cancel = await fx.bundle.execute("comfy/run/cancel", { runId: started.value.run.id }, CTX);
  assert.equal(cancel.ok, true);
  assert.equal(cancel.value.cancelled, true);
  await flush();
  const run = await fx.bundle.execute("comfy/run/get", { runId: started.value.run.id }, CTX);
  assert.equal(run.value.run.status, "cancelled");
  assert.equal(fx.runner.starts[0].handle.cancelled, true);
  assert.equal(fx.bundle.activeRunCount(), 0);
});

test("受监督超时：runner timedOut 事实归一成 failed + 超时文案", async () => {
  const fx = makeReadyFixture();
  await fx.bundle.execute("comfy/plugin/enable", {}, CTX);
  const saved = await fx.bundle.execute("comfy/workflows/save", testPreset(), CTX);
  const started = await fx.bundle.execute("comfy/run/start", { presetId: saved.value.workflow.id, values: { prompt: "x" } }, CTX);
  fx.runner.starts[0].handle.finish({ ok: false, timedOut: true });
  await flush();
  await flush();
  const run = await fx.bundle.execute("comfy/run/get", { runId: started.value.run.id }, CTX);
  assert.equal(run.value.run.status, "failed");
  assert.match(run.value.run.error, /超时/);
  assert.equal(fx.bundle.activeRunCount(), 0);
});

test("受监督失败：子进程回结构化错误时运行落 failed 并保留错误码", async () => {
  const fx = makeReadyFixture();
  await fx.bundle.execute("comfy/plugin/enable", {}, CTX);
  const saved = await fx.bundle.execute("comfy/workflows/save", testPreset(), CTX);
  const started = await fx.bundle.execute("comfy/run/start", { presetId: saved.value.workflow.id, values: { prompt: "x" } }, CTX);
  fx.runner.starts[0].handle.emitResult({ ok: false, error: "COMFY_CHILD_FAILED", message: "ComfyUI 执行失败" });
  fx.runner.starts[0].handle.finish({ ok: false, code: 1 });
  await flush();
  await flush();
  const run = await fx.bundle.execute("comfy/run/get", { runId: started.value.run.id }, CTX);
  assert.equal(run.value.run.status, "failed");
  assert.match(run.value.run.error, /执行失败/);
});

// ── 实例监督 ────────────────────────────────────────────────────────────
test("实例监督：start / stop 走受监督 worker，结果原样透出", async () => {
  const fx = makeReadyFixture();
  await fx.bundle.execute("comfy/plugin/enable", {}, CTX);

  const startPromise = fx.bundle.execute("comfy/instances/start", { instanceId: "gpu-0", timeoutMs: 5000 }, CTX);
  await flush();
  assert.equal(fx.runner.starts.at(-1).op, "instance-start");
  fx.runner.starts.at(-1).handle.progress({ phase: "starting", port: 18188 });
  fx.runner.starts.at(-1).handle.emitResult({ ok: true, result: { pid: 4321, port: 18188, url: "http://127.0.0.1:18188", status: "running" } });
  fx.runner.starts.at(-1).handle.finish({ ok: true });
  const started = await startPromise;
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.value.runtime.pid, 4321);
  assert.equal(started.value.runtime.status, "running");
  assert.equal(started.value.bridge.installed, true, "源 comfyui.ts:602 —— 本机启动前安装桥接扩展");
  assert.equal(fs.existsSync(path.join(fx.root, "custom_nodes", "dx_os_bridge", "__init__.py")), true);

  const stopPromise = fx.bundle.execute("comfy/instances/stop", { instanceId: "gpu-0", timeoutMs: 5000 }, CTX);
  await flush();
  assert.equal(fx.runner.starts.at(-1).op, "instance-stop");
  fx.runner.starts.at(-1).handle.emitResult({ ok: true, result: { stopped: true, pid: 4321 } });
  fx.runner.starts.at(-1).handle.finish({ ok: true });
  const stopped = await stopPromise;
  assert.equal(stopped.ok, true);
  assert.equal(stopped.value.runtime.stopped, true);

  // 局域网 / 云端实例不由本应用启动
  const lan = await fx.bundle.execute("comfy/instances/save", { instanceId: "lan-1", name: "局域网", mode: "lan", lanHost: "box.local", port: 18189 }, CTX);
  assert.equal(lan.ok, true);
  const lanStart = await fx.bundle.execute("comfy/instances/start", { instanceId: "lan-1" }, CTX);
  assert.equal(lanStart.error, "COMFY_FORBIDDEN");
});

test("实例监督：缺依赖时 start 在编排层拒绝，实例参数（端口 / 地址）非法时保存被拒", async () => {
  const dir = tempDir("dxos-comfy-inst-");
  const runner = makeFakeRunner();
  const bundle = createComfyBundle({ userDataDir: dir, runner, env: {} });
  await bundle.execute("comfy/plugin/enable", {}, CTX);
  bundle.store.saveConfig({ rootDir: path.join(dir, "nope"), instances: [{ id: "gpu-0", mode: "local", port: 18188, enabled: true }] });
  const res = await bundle.execute("comfy/instances/start", { instanceId: "gpu-0" }, CTX);
  assert.equal(res.error, "COMFY_DEPENDENCY_UNAVAILABLE");
  assert.equal(runner.starts.length, 0);
  const badRemote = await bundle.execute("comfy/instances/save", { instanceId: "r1", mode: "remote", baseUrl: "not-a-url" }, CTX);
  assert.equal(badRemote.error, "COMFY_INVALID_INPUT");
  const badLan = await bundle.execute("comfy/instances/save", { instanceId: "l1", mode: "lan", lanHost: "bad/host" }, CTX);
  assert.equal(badLan.error, "COMFY_INVALID_INPUT");
});

// ── 未认证 / 白名单 ─────────────────────────────────────────────────────
test("未认证会话：comfy 命令一律拒绝；未知命令在服务层也被白名单拦下", async () => {
  const dir = tempDir("dxos-comfy-auth-");
  const runner = makeFakeRunner();
  const bundle = createComfyBundle({ userDataDir: dir, runner, env: {} });
  const unauth = await bundle.execute("comfy/health", {}, {});
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error, "COMFY_UNAUTHENTICATED");
  const denied = await bundle.execute("comfy/nope", {}, CTX);
  assert.equal(denied.error, "COMFY_COMMAND_NOT_ALLOWED");
  assert.equal(runner.starts.length, 0);
});

test("运行记录：list 只回当前会话的记录，run/results 结构稳定", async () => {
  const fx = makeReadyFixture();
  await fx.bundle.execute("comfy/plugin/enable", {}, CTX);
  const saved = await fx.bundle.execute("comfy/workflows/save", testPreset(), CTX);
  const started = await fx.bundle.execute("comfy/run/start", { presetId: saved.value.workflow.id, values: { prompt: "x" } }, CTX);
  const list = await fx.bundle.execute("comfy/run/list", {}, CTX);
  assert.equal(list.ok, true);
  assert.equal(list.value.runs.length, 1);
  const results = await fx.bundle.execute("comfy/run/results", { runId: started.value.run.id }, CTX);
  assert.equal(results.ok, true);
  assert.deepEqual(results.value.results, []);
  const other = await fx.bundle.execute("comfy/run/get", { runId: started.value.run.id }, { sessionRef: "someone-else" });
  assert.equal(other.error, "COMFY_NOT_FOUND", "运行记录按 owner 隔离");
  fx.runner.starts[0].handle.finish({ ok: false, cancelled: true });
  await flush();
  await flush();
});
