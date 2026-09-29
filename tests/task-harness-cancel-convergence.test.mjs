/**
 * D5-03 第十二批 · 用户取消在途模型调用后的完整收敛（R2 + runTask 不返回）。
 *
 * 被测面：真实 HarnessAdapter + 真实 TaskHarnessOrchestrator + 真实 TaskService / TaskStore
 * + 受控慢 Provider；harness 子进程是既有夹具探针（turn-hang / 受控迟到响应）。
 *
 * 判据（每条时序都要）：runTask 有界收敛；**恰好一个** call 且终态明确（取消 → CANCELLED，
 * 绝不写成 Provider 失败：providerErrorCode 必须为空）；completed_at 与安全事件已写；
 * 已 SUCCEEDED / FAILED 的历史 call 不被改写；0 自动重试 / 0 新产物；能力撤销；0 孤儿；
 * 任务 / 步骤 / run / call 终态一致；重复取消幂等。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createTaskHarnessFixture, EXACT } from "./fixtures/harness-acp/task-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONVERGE_LIMIT_MS = 25000;

/** 统一观测：任务 / 步骤 / run / call / 产物 / 事件 / 能力 / 子进程。 */
function observe(fx, ctx, taskId) {
  const svc = fx.taskService;
  const task = svc.getTask({ context: ctx, taskId });
  const steps = svc.getSteps({ context: ctx, taskId });
  const runs = svc.getHarnessRuns({ context: ctx, taskId });
  const calls = svc.getCalls({ context: ctx, taskId });
  const arts = svc.getArtifacts({ context: ctx, taskId });
  const events = svc.getEvents({ context: ctx, taskId });
  return {
    task: task.ok ? task.task : null,
    step: steps.ok && steps.items[0] ? steps.items[0] : null,
    runs: runs.ok ? runs.items : [],
    calls: calls.ok ? calls.items : [],
    artifacts: arts.ok ? arts.items : [],
    events: events.ok ? events.items.map((e) => e.eventType) : [],
    capabilities: [...fx.proxy.capabilities.values()].map((c) => c.state),
  };
}

/** 取消后的通用终态判据（时序无关，逐条断言）。 */
function assertCancelledConvergence({ fx, ctx, taskId, runResult, view, label }) {
  assert.equal(runResult.ok, false, label + "：取消必须 ok=false，实际 " + JSON.stringify(runResult));
  assert.ok(runResult.cancelled || runResult.error === "HARNESS_CANCELLED", label + "：" + JSON.stringify(runResult));
  assert.equal(view.task.status, "CANCELLED", label + "：task");
  assert.equal(view.task.cancelRequested, true, label + "：cancel_requested");
  assert.equal(view.step.status, "CANCELLED", label + "：step");
  assert.equal(view.runs.length, 1, label + "：恰好一个 run");
  assert.equal(view.runs[0].status, "CANCELLED", label + "：run");
  assert.equal(view.calls.length, 1, label + "：恰好一个 call（0 自动重试）");
  assert.equal(view.calls[0].status, "CANCELLED", label + "：call 终态 = CANCELLED（R2 回归点）");
  assert.ok(view.calls[0].completedAt != null, label + "：call 必须写 completed_at");
  assert.equal(view.calls[0].providerErrorCode, null, label + "：取消绝不写成 Provider 失败");
  assert.ok(view.events.includes("model.call.cancelled"), label + "：必须落安全事件 model.call.cancelled");
  assert.ok(!view.events.includes("model.call.failed"), label + "：绝不落 model.call.failed");
  assert.ok(!view.events.includes("model.call.completed"), label + "：绝不落 model.call.completed");
  assert.equal(view.artifacts.length, 0, label + "：0 新产物");
  assert.ok(!view.events.includes("task.succeeded"), label + "：绝不成功");
  for (const c of view.capabilities) assert.equal(c, "REVOKED", label + "：能力必须撤销");
}

/** 等推进到「模型调用信封已建 / provider 已收到请求」等可观察阶段。 */
async function waitFor(pred, limitMs = 20000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) { if (pred()) return true; await sleep(5); }
  return false;
}

test("取消时序 1 · provider 请求发出前取消：call 收敛为 CANCELLED + runTask 有界返回 + 0 产物", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "slow" });
  let orch = null;
  try {
    const ctx = fx.ctx();
    const created = fx.createTask();
    const taskId = created.task.taskId;
    orch = fx.makeOrchestrator(fx.realAgentFactory(), { startTimeoutMs: 20000, turnTimeoutMs: 180000 });
    const runPromise = orch.runTask({ context: ctx, taskId, expectedRevision: created.task.revision });
    assert.ok(await waitFor(() => fx.taskService.getCalls({ context: ctx, taskId }).items.length >= 1), "调用信封已建");
    const t = fx.taskService.getTask({ context: ctx, taskId }).task;
    const cancelled = await orch.cancel({ context: ctx, taskId, expectedRevision: t.revision });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const converged = await Promise.race([runPromise.then((r) => r), sleep(CONVERGE_LIMIT_MS).then(() => null)]);
    assert.ok(converged, "runTask 必须在 " + CONVERGE_LIMIT_MS + "ms 内有界返回");
    assertCancelledConvergence({ fx, ctx, taskId, runResult: converged, view: observe(fx, ctx, taskId), label: "请求前取消" });
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});

test("取消时序 2 · Provider 已收到请求后取消：账本与事实一致、能力撤销、0 孤儿、重开库状态一致", async () => {
  // 真文件库：进程内关掉后再只读重开，核对落库事实（不是只看内存视图）。
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-b12-cancel-"));
  const fx = await createTaskHarnessFixture({ behavior: "slow", dbPath: path.join(dbDir, "identity.sqlite"), keepData: true });
  let orch = null;
  try {
    const ctx = fx.ctx();
    const created = fx.createTask();
    const taskId = created.task.taskId;
    let adapter = null;
    const base = fx.realAgentFactory();
    orch = fx.makeOrchestrator((opts) => { const a = base(opts); adapter = a; return a; }, { startTimeoutMs: 20000, turnTimeoutMs: 180000 });
    const runPromise = orch.runTask({ context: ctx, taskId, expectedRevision: created.task.revision });
    assert.ok(await waitFor(() => fx.fp.state.requests >= 1), "provider 已收到请求");
    const t = fx.taskService.getTask({ context: ctx, taskId }).task;
    const cancelled = await orch.cancel({ context: ctx, taskId, expectedRevision: t.revision });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const converged = await Promise.race([runPromise.then((r) => r), sleep(CONVERGE_LIMIT_MS).then(() => null)]);
    assert.ok(converged, "runTask 有界返回");
    const view = observe(fx, ctx, taskId);
    assertCancelledConvergence({ fx, ctx, taskId, runResult: converged, view, label: "请求后取消" });
    assert.equal(adapter.processExited, true, "harness 子进程已回收（0 孤儿）");
    assert.equal(orch.registry.size, 0, "registry 无残留");
    assert.equal(fx.fp.state.requests, 1, "0 自动重试 / 0 二次请求");

    // 重开数据库：落库状态与内存一致（任务 / 步骤 / run / call 四处）。
    const db = new DatabaseSync(path.join(dbDir, "identity.sqlite"), { readOnly: true });
    try {
      const task = db.prepare("SELECT status, cancel_requested FROM tasks WHERE task_id = ?").get(taskId);
      const step = db.prepare("SELECT status FROM task_steps WHERE task_id = ?").get(taskId);
      const run = db.prepare("SELECT status FROM task_harness_runs WHERE task_id = ?").get(taskId);
      const call = db.prepare("SELECT status, completed_at, provider_error_code FROM task_model_calls WHERE task_id = ?").get(taskId);
      assert.deepEqual({ status: task.status, cancel: task.cancel_requested }, { status: "CANCELLED", cancel: 1 });
      assert.equal(step.status, "CANCELLED");
      assert.equal(run.status, "CANCELLED");
      assert.equal(call.status, "CANCELLED");
      assert.ok(call.completed_at != null, "completed_at 已落库");
      assert.equal(call.provider_error_code, null, "绝不写成 Provider 失败");
    } finally { db.close(); }
  } finally {
    try { await orch?.dispose(); } catch { /* ignore */ }
    await fx.close();
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("取消时序 3 · 正常响应与取消同刻竞争：终态唯一，绝不出现 SUCCEEDED 与 CANCELLED 并存", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "exact", delayMs: 60 });
  let orch = null;
  try {
    const ctx = fx.ctx();
    const created = fx.createTask();
    const taskId = created.task.taskId;
    orch = fx.makeOrchestrator(fx.realAgentFactory(), { startTimeoutMs: 20000, turnTimeoutMs: 180000 });
    const runPromise = orch.runTask({ context: ctx, taskId, expectedRevision: created.task.revision });
    assert.ok(await waitFor(() => fx.fp.state.requests >= 1), "provider 已收到请求");
    const t = fx.taskService.getTask({ context: ctx, taskId }).task;
    const cancelled = await orch.cancel({ context: ctx, taskId, expectedRevision: t.revision });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const converged = await Promise.race([runPromise.then((r) => r), sleep(CONVERGE_LIMIT_MS).then(() => null)]);
    assert.ok(converged, "runTask 有界返回");
    await sleep(500); // 让迟到的正常响应窗口过去
    const view = observe(fx, ctx, taskId);
    assertCancelledConvergence({ fx, ctx, taskId, runResult: converged, view, label: "同刻竞争" });
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});

test("取消时序 4 · Provider 永不回应：runTask 仍有界返回，按真实取消收尾", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "slow" });
  let orch = null;
  try {
    const ctx = fx.ctx();
    const created = fx.createTask();
    const taskId = created.task.taskId;
    // turn-hang 探针：initialize / session-new 正常，session/prompt 永不回应。
    orch = fx.makeOrchestrator(fx.agentFactory("turn-hang-agent.mjs"), { startTimeoutMs: 20000, turnTimeoutMs: 180000 });
    const runPromise = orch.runTask({ context: ctx, taskId, expectedRevision: created.task.revision });
    assert.ok(await waitFor(() => fx.taskService.getCalls({ context: ctx, taskId }).items.length >= 1), "调用信封已建");
    const t = fx.taskService.getTask({ context: ctx, taskId }).task;
    const startedAt = Date.now();
    const cancelled = await orch.cancel({ context: ctx, taskId, expectedRevision: t.revision });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const converged = await Promise.race([runPromise.then((r) => r), sleep(CONVERGE_LIMIT_MS).then(() => null)]);
    const elapsed = Date.now() - startedAt;
    assert.ok(converged, "runTask 必须在 " + CONVERGE_LIMIT_MS + "ms 内返回（agent 不回话也一样）");
    assert.ok(elapsed < 20000, "取消到收敛必须有界且远小于执行预算，实际 " + elapsed + "ms");
    assertCancelledConvergence({ fx, ctx, taskId, runResult: converged, view: observe(fx, ctx, taskId), label: "永不回应" });
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});

test("取消时序 5 · 迟到 turn 结果：绝不产生成功产物、绝不翻转终态、绝不改写已取消的 call", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "slow" });
  let orch = null;
  try {
    const ctx = fx.ctx();
    const created = fx.createTask("Return exactly: " + EXACT);
    const taskId = created.task.taskId;
    // agent 收下 prompt 后 5s 才回 end_turn —— 取消落在迟到结果之前。
    const base = (opts) => fx.agentFactory("prompt-late-agent.mjs")(opts);
    orch = fx.makeOrchestrator((opts) => { const a = base(opts); a.dshArgs = [a.dshArgs[0], "5000"]; return a; }, { startTimeoutMs: 20000, turnTimeoutMs: 180000 });
    const runPromise = orch.runTask({ context: ctx, taskId, expectedRevision: created.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    assert.ok(await waitFor(() => fx.taskService.getCalls({ context: ctx, taskId }).items.length >= 1), "模型调用信封已建");
    const t = fx.taskService.getTask({ context: ctx, taskId }).task;
    const cancelled = await orch.cancel({ context: ctx, taskId, expectedRevision: t.revision });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const converged = await Promise.race([runPromise.then((r) => r), sleep(CONVERGE_LIMIT_MS).then(() => null)]);
    assert.ok(converged, "runTask 有界返回");
    // 迟到窗口：agent 的 5s 迟到结果 + 收尾余量
    await sleep(6500);
    const view = observe(fx, ctx, taskId);
    assertCancelledConvergence({ fx, ctx, taskId, runResult: converged, view, label: "迟到响应" });
    assert.equal(view.calls.length, 1, "迟到响应绝不新建 call");
    assert.equal(view.runs.length, 1, "迟到响应绝不新建 run");
    assert.equal(view.artifacts.length, 0, "迟到响应绝不产生产物");
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});

test("取消时序 6 · 重复取消幂等：终态不翻转、0 二次收敛、已取消的 call 不被改写", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "slow" });
  let orch = null;
  try {
    const ctx = fx.ctx();
    const created = fx.createTask();
    const taskId = created.task.taskId;
    orch = fx.makeOrchestrator(fx.realAgentFactory(), { startTimeoutMs: 20000, turnTimeoutMs: 180000 });
    const runPromise = orch.runTask({ context: ctx, taskId, expectedRevision: created.task.revision });
    assert.ok(await waitFor(() => fx.fp.state.requests >= 1), "provider 已收到请求");
    const t1 = fx.taskService.getTask({ context: ctx, taskId }).task;
    const c1 = await orch.cancel({ context: ctx, taskId, expectedRevision: t1.revision });
    assert.equal(c1.ok, true, JSON.stringify(c1));
    const converged = await Promise.race([runPromise.then((r) => r), sleep(CONVERGE_LIMIT_MS).then(() => null)]);
    assert.ok(converged, "runTask 有界返回");
    const before = observe(fx, ctx, taskId);
    assertCancelledConvergence({ fx, ctx, taskId, runResult: converged, view: before, label: "首次取消" });
    const callBefore = before.calls[0];

    const t2 = fx.taskService.getTask({ context: ctx, taskId }).task;
    const c2 = await orch.cancel({ context: ctx, taskId, expectedRevision: t2.revision });
    assert.equal(c2.ok, true, JSON.stringify(c2));
    await sleep(300);
    const after = observe(fx, ctx, taskId);
    assert.equal(after.task.status, "CANCELLED");
    assert.equal(after.runs.length, 1, "重复取消绝不新建 run");
    assert.equal(after.calls.length, 1, "重复取消绝不新建 call");
    assert.equal(after.calls[0].status, "CANCELLED");
    assert.equal(after.calls[0].completedAt, callBefore.completedAt, "已取消的 call 不被改写（completed_at 不变）");
    assert.equal(after.calls[0].providerErrorCode, null, "仍不得写成 Provider 失败");
    assert.equal(after.artifacts.length, 0);
    assert.equal(after.events.filter((e) => e === "model.call.cancelled").length, 1, "取消事件恰好一条");
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await fx.close(); }
});

test("正常成功对照：取消修复不得影响成功路径（call SUCCEEDED + 产物 + 任务成功）", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "exact" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeOrchestrator(fx.realAgentFactory(), { startTimeoutMs: 20000, turnTimeoutMs: 60000 });
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    assert.equal(r.ok, true, JSON.stringify(r));
    const view = observe(fx, ctx, t.task.taskId);
    assert.equal(view.task.status, "SUCCEEDED");
    assert.equal(view.step.status, "SUCCEEDED");
    assert.equal(view.runs[0].status, "SUCCEEDED");
    assert.equal(view.calls.length, 1);
    assert.equal(view.calls[0].status, "SUCCEEDED", "成功路径的 call 不得被改成取消终态");
    assert.equal(view.calls[0].providerErrorCode, null);
    assert.equal(view.artifacts.length, 1, "成功路径仍有产物");
    assert.ok(view.events.includes("model.call.completed"));
    assert.ok(!view.events.includes("model.call.cancelled"), "成功路径绝不落取消事件");
    await orch.dispose();
  } finally { await fx.close(); }
});

test("历史 call 不被改写：已 FAILED 的旧 call 在后续取消里保持原样", async () => {
  const fx = await createTaskHarnessFixture({ behavior: "500" });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeOrchestrator(fx.realAgentFactory(), { startTimeoutMs: 20000, turnTimeoutMs: 60000 });
    // 第一次：provider 500 → call FAILED（真实失败，且带 providerErrorCode）。
    const first = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(first.ok, false, JSON.stringify(first));
    const failedCalls = fx.taskService.getCalls({ context: ctx, taskId: t.task.taskId }).items;
    assert.equal(failedCalls.length, 1);
    assert.equal(failedCalls[0].status, "FAILED", "真实 Provider 失败仍是 FAILED");
    assert.ok(failedCalls[0].providerErrorCode, "失败原因必须保留：" + JSON.stringify(failedCalls[0]));

    // 第二次：用户取消（同一任务上再发一次取消）→ 已 FAILED 的历史 call 绝不被改写。
    const fresh = fx.taskService.getTask({ context: ctx, taskId: t.task.taskId }).task;
    const c = await orch.cancel({ context: ctx, taskId: t.task.taskId, expectedRevision: fresh.revision });
    assert.equal(c.ok, true, JSON.stringify(c));
    const after = fx.taskService.getCalls({ context: ctx, taskId: t.task.taskId }).items;
    assert.equal(after.length, 1, "0 新 call");
    assert.equal(after[0].status, "FAILED", "已 FAILED 的历史 call 不得被改写成 CANCELLED");
    assert.equal(after[0].providerErrorCode, failedCalls[0].providerErrorCode, "失败原因原样保留");
    assert.equal(after[0].completedAt, failedCalls[0].completedAt, "completed_at 原样保留");
    await orch.dispose();
  } finally { await fx.close(); }
});

test("副作用账本隔离：取消模型调用绝不改写独立的 side-effect call（AWAITING_APPROVAL 原样保留）", async () => {
  const { createSideEffectFixture, WRITE_TOOL } = require("./fixtures/harness-acp/side-effect-fixture.mjs");
  const sf = await createSideEffectFixture();
  const fx = sf.fx;
  let orch = null;
  try {
    const run = sf.setupRun();
    const planning = await sf.plan(WRITE_TOOL, { target: "doc-cancel-b12" }, run);
    assert.equal(planning.ok, true, JSON.stringify(planning));
    const sideCallId = planning.call.callId;
    const sideBefore = sf.store.callById(sideCallId);
    assert.equal(sideBefore.status, "AWAITING_APPROVAL");

    // 同一条任务上再起一次 run 并取消：模型调用被收敛，副作用账本必须原样不动。
    const ctx = sf.ctx();
    const created = fx.taskService.createTask({ context: ctx, goal: "独立账本隔离 [PROBE:TURN]", modelConfigId: fx.modelConfigId });
    assert.equal(created.ok, true, JSON.stringify(created));
    const taskId = created.task.taskId;
    orch = fx.makeOrchestrator(fx.realAgentFactory(), { startTimeoutMs: 20000, turnTimeoutMs: 180000 });
    const runPromise = orch.runTask({ context: ctx, taskId, expectedRevision: created.task.revision });
    assert.ok(await waitFor(() => fx.fp.state.requests >= 1), "provider 已收到请求");
    const t = fx.taskService.getTask({ context: ctx, taskId }).task;
    const cancelled = await orch.cancel({ context: ctx, taskId, expectedRevision: t.revision });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const converged = await Promise.race([runPromise.then((r) => r), sleep(CONVERGE_LIMIT_MS).then(() => null)]);
    assert.ok(converged, "runTask 有界返回");
    assertCancelledConvergence({ fx, ctx, taskId, runResult: converged, view: observe(fx, ctx, taskId), label: "副作用隔离" });

    // 独立账本：状态 / 审批 / 执行记录三处都不被模型调用的取消状态覆盖。
    const sideAfter = sf.store.callById(sideCallId);
    assert.equal(sideAfter.status, "AWAITING_APPROVAL", "副作用 call 不得被改成取消终态");
    assert.equal(sideAfter.completedAt, sideBefore.completedAt, "副作用 call 的完成时间不得被写入");
    assert.equal(String(sideAfter.errorCode || ""), "", "副作用 call 不得被写上错误码");
    assert.equal(sf.store.approvalsOfCall(sideCallId).length, 0, "0 新的审批记录");
    assert.equal(sf.toolStore.executionsOfTask(sideBefore.taskId).length, 0, "0 执行记录（未执行仍是未执行）");
    await orch.dispose();
  } finally { try { await orch?.dispose(); } catch { /* ignore */ } await sf.fx.close(); }
});
