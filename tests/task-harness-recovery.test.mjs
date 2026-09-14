/** D4-02C · Crash / Restart：Harness 崩溃 → BLOCKED，0 respawn；进程重启 → RECOVERY_REQUIRED，0 replay。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskHarnessFixture } from "./fixtures/harness-acp/task-harness-fixture.mjs";
import { reopenTaskRuntime } from "./task-fixtures.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = import.meta.dirname;

test("Harness crash E2E：kill child → BLOCKED + HARNESS_PROCESS_EXITED + 0 respawn", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "slow" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const runPromise = fx.orchestrator.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const deadline = Date.now() + 20000;
    while (fx.orchestrator.registry.size === 0 && Date.now() < deadline) await sleep(20);
    assert.equal(fx.orchestrator.registry.size, 1, "harness 已启动");
    const entry = [...fx.orchestrator.registry.values()][0];
    assert.ok(entry.adapter.child && entry.adapter.child.pid, "真实 child pid");
    entry.adapter.child.kill("SIGKILL");

    const r = await runPromise;
    assert.equal(r.ok, false);
    assert.equal(r.error, "HARNESS_PROCESS_EXITED");
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(r.task.status, "BLOCKED");
    const runs = fx.taskService.getHarnessRuns({ context: ctx, taskId: t.task.taskId });
    assert.equal(runs.items.length, 1, "0 respawn / 0 rerun");
    assert.equal(runs.items[0].status, "BLOCKED");
    const events = fx.taskService.getEvents({ context: ctx, taskId: t.task.taskId }).items.map((e) => e.eventType);
    assert.ok(events.includes("harness.run.unknown_effect"));
    assert.ok(!events.includes("task.succeeded"));
    assert.equal(fx.taskService.getArtifacts({ context: ctx, taskId: t.task.taskId }).items.length, 0);
  } finally { await fx.close(); }
});

test("Restart E2E：进程崩溃后重启 → RECOVERY_REQUIRED，0 replay", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-02c-restart-"));
  const dbPath = path.join(dir, "identity.sqlite");
  let state;
  let runtime = null;
  try {
    state = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(HERE, "fixtures", "harness-acp", "restart-writer.mjs"), dbPath], { cwd: path.resolve(HERE, ".."), stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error("writer failed " + code + ": " + err.slice(-400)));
        try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch (e) { reject(new Error("bad writer output: " + out)); }
      });
    });
    assert.ok(state.taskId && state.stepId && state.runId);

    runtime = reopenTaskRuntime({ dbPath });
    const rec = runtime.taskService.recoverRunning();
    assert.equal(rec.ok, true);
    assert.ok(rec.recovered >= 1, "至少恢复一个 RUNNING Task");

    const task = runtime.taskStore.taskById(state.taskId);
    assert.equal(task.status, "BLOCKED");
    const step = runtime.taskStore.stepById(state.stepId);
    assert.equal(step.status, "BLOCKED");
    const runs = runtime.taskStore.harnessRunsOfTask(state.taskId);
    assert.equal(runs.length, 1, "0 replay：未新建 run");
    assert.equal(runs[0].status, "BLOCKED");
    assert.equal(runs[0].error_code, "RECOVERY_REQUIRED");

    const types = runtime.taskStore.eventsOfTask(state.taskId).map((e) => e.event_type);
    assert.ok(types.includes("task.recovery_blocked"));
    assert.ok(types.includes("step.recovery_blocked"));
    assert.ok(types.includes("harness.run.unknown_effect"));
    assert.equal(types.filter((t) => t === "harness.run.started").length, 1, "0 自动 rerun");
    assert.ok(!types.includes("task.succeeded"));
    assert.equal(runtime.taskStore.artifactsOfTask(state.taskId).length, 0);

    const again = runtime.taskService.recoverRunning();
    assert.equal(again.recovered, 0, "recovery 幂等");
  } finally {
    try { runtime?.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
