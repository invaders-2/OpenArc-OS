/**
 * D5-03 第十二批 · 取消时序矩阵探针（诊断）。
 *
 * 同一进程内跑 7 个时序（每个一个真实 HarnessAdapter + 真实子进程 + 受控 Provider），
 * 输出每个时序的：runTask 收敛毫秒、call 终态、run/step/task 终态、能力、孤儿、迟到产物。
 *
 * 时序：before-request（请求发出前取消）/ sent（provider 已收到）/ race（正常响应与取消同刻）/
 *       never（provider 永不回应）/ late（迟到响应）/ repeat（重复取消）/ success（正常成功对照）
 *
 * 用法：node experiments/d5-03/batch12/verify/cancel-timing-matrix.mjs
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const { createTaskHarnessFixture } = await import(pathToFileURL(path.join(ROOT, "tests/fixtures/harness-acp/task-harness-fixture.mjs")).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function runCase(name, { behavior = "slow", delayMs = 0, cancelWhen, extraCancel = false }) {
  const fx = await createTaskHarnessFixture({ behavior, delayMs });
  let orch = null;
  const t0 = Date.now();
  const marks = [];
  const mark = (n, d = null) => marks.push({ n, d, atMs: Date.now() - t0 });
  try {
    const ctx = fx.ctx();
    const created = fx.createTask("Return exactly: OPENARC_TASK_OK");
    const taskId = created.task.taskId;
    const counter = { adapter: null, promptSettled: null, promptError: null, cancels: 0 };
    const base = fx.realAgentFactory();
    orch = fx.makeOrchestrator((opts) => {
      const adapter = base(opts);
      counter.adapter = adapter;
      const prompt = adapter.prompt.bind(adapter);
      const cancel = adapter.cancel.bind(adapter);
      adapter.prompt = async (t, o) => {
        try { const r = await prompt(t, o); counter.promptSettled = r && r.stopReason; return r; }
        catch (e) { counter.promptError = String((e && e.code) || (e && e.message) || e).slice(0, 60); throw e; }
      };
      adapter.cancel = async () => { counter.cancels += 1; return await cancel(); };
      return adapter;
    }, { startTimeoutMs: 20000, turnTimeoutMs: 180000 });

    let settled = null; let settledAtMs = null;
    const runPromise = orch.runTask({ context: ctx, taskId, expectedRevision: created.task.revision });
    runPromise.then((r) => { settled = { ok: r.ok, error: r.error || null, cancelled: !!r.cancelled }; settledAtMs = Date.now() - t0; },
      (e) => { settled = { threw: String((e && e.message) || e) }; settledAtMs = Date.now() - t0; });

    const callCount = () => fx.taskService.getCalls({ context: ctx, taskId }).items.length;
    const waitFor = async (pred, limitMs) => { const d = Date.now() + limitMs; while (Date.now() < d) { if (pred()) return true; await sleep(5); } return false; };

    if (cancelWhen === "none") {
      const done = await Promise.race([runPromise.then(() => true), sleep(30000).then(() => false)]);
      mark("runTask:done", done ? "resolved" : "timeout-30s");
      const svc0 = fx.taskService;
      const task0 = svc0.getTask({ context: ctx, taskId }).task;
      const step0 = svc0.getSteps({ context: ctx, taskId }).items[0];
      const runs0 = svc0.getHarnessRuns({ context: ctx, taskId }).items;
      const calls0 = svc0.getCalls({ context: ctx, taskId }).items;
      const arts0 = svc0.getArtifacts({ context: ctx, taskId }).items;
      results.push({
        name, behavior, cancelWhen, extraCancel: false,
        ok: done && settled && settled.ok === true && task0.status === "SUCCEEDED" && step0.status === "SUCCEEDED"
          && runs0[0].status === "SUCCEEDED" && calls0.length === 1 && calls0[0].status === "SUCCEEDED" && arts0.length === 1,
        runTaskConverged: done, runTaskSettledAtMs: settledAtMs, runResult: settled,
        task: { status: task0.status, cancelRequested: !!task0.cancel_requested }, step: step0.status,
        run: { status: runs0[0].status, errorCode: runs0[0].errorCode, stopReason: runs0[0].stopReason },
        calls: calls0.map((c) => ({ status: c.status, providerErrorCode: c.providerErrorCode, completedAt: c.completedAt != null, usage: c.usage || null })),
        artifacts: arts0.length, events: svc0.getEvents({ context: ctx, taskId }).items.map((e) => e.eventType),
        childExited: counter.adapter.processExited, capabilities: [...fx.proxy.capabilities.values()].map((c) => c.state),
        registrySize: orch.registry.size, marks,
      });
      return;
    }

    // 进入取消前的阶段
    if (cancelWhen === "before-request") {
      await waitFor(() => callCount() >= 1, 20000);   // 调用信封已建，provider 尚未收到
    } else if (cancelWhen === "race") {
      await waitFor(() => fx.fp.state.requests >= 1, 20000); // 响应很快就到（delayMs 小），与取消同刻
    } else {
      await waitFor(() => fx.fp.state.requests >= 1, 20000);
    }
    mark("phase:" + cancelWhen, JSON.stringify({ requests: fx.fp.state.requests, calls: callCount() }));

    const rev = fx.taskService.getTask({ context: ctx, taskId }).task.revision;
    const c1 = await orch.cancel({ context: ctx, taskId, expectedRevision: rev });
    mark("cancel#1", JSON.stringify({ ok: c1.ok, error: c1.error || null }));
    if (extraCancel) {
      const t = fx.taskService.getTask({ context: ctx, taskId });
      const c2 = await orch.cancel({ context: ctx, taskId, expectedRevision: t.task.revision });
      mark("cancel#2", JSON.stringify({ ok: c2.ok, error: c2.error || null }));
    }

    const converged = await Promise.race([runPromise.then(() => true), sleep(25000).then(() => false)]);
    mark("runTask:converged", converged ? "resolved" : "timeout-25s");

    // 迟到窗口：等到 provider 的 5s 响应窗口过去，看是否产生成功产物 / 翻转终态
    const lateWindowMs = name === "late" || name === "never" ? 7000 : 2500;
    await sleep(lateWindowMs);

    const svc = fx.taskService;
    const task = svc.getTask({ context: ctx, taskId }).task;
    const step = svc.getSteps({ context: ctx, taskId }).items[0];
    const runs = svc.getHarnessRuns({ context: ctx, taskId }).items;
    const calls = svc.getCalls({ context: ctx, taskId }).items;
    const arts = svc.getArtifacts({ context: ctx, taskId }).items;
    const adapter = counter.adapter;
    results.push({
      name, behavior: behavior + (delayMs ? "+delay" + delayMs : ""), cancelWhen, extraCancel,
      ok: converged && settled && settled.ok === false && calls.length === 1 && calls[0].status === "CANCELLED"
        && calls[0].completedAt != null && calls[0].providerErrorCode == null
        && svc.getEvents({ context: ctx, taskId }).items.some((e) => e.eventType === "model.call.cancelled")
        && !arts.length && task.status === "CANCELLED" && step.status === "CANCELLED" && runs[0].status === "CANCELLED"
        && adapter.processExited === true && [...fx.proxy.capabilities.values()].every((c) => c.state === "REVOKED")
        && orch.registry.size === 0,
      runTaskConverged: converged,
      runTaskSettledAtMs: settledAtMs,
      runResult: settled,
      task: { status: task.status, cancelRequested: !!task.cancel_requested },
      step: step.status,
      run: { status: runs[0].status, errorCode: runs[0].errorCode, stopReason: runs[0].stopReason },
      calls: calls.map((c) => ({ status: c.status, providerErrorCode: c.providerErrorCode, completedAt: c.completedAt != null, usage: c.usage || null })),
      events: svc.getEvents({ context: ctx, taskId }).items.map((e) => e.eventType),
      artifacts: arts.length,
      promptSettled: counter.promptSettled,
      promptError: counter.promptError,
      cancels: counter.cancels,
      childExited: adapter.processExited,
      providerRequests: fx.fp.state.requests,
      providerClosed: fx.fp.state.closed,
      capabilities: [...fx.proxy.capabilities.values()].map((c) => c.state),
      registrySize: orch.registry.size,
      marks,
    });
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.stack) || e).slice(0, 500), marks });
  } finally {
    try { if (orch) await Promise.race([orch.dispose(), sleep(4000)]); } catch { /* ignore */ }
    try { await Promise.race([fx.close(), sleep(4000)]); } catch { /* ignore */ }
  }
}

await runCase("before-request", { cancelWhen: "before-request" });
await runCase("sent", { cancelWhen: "sent" });
await runCase("race", { behavior: "success", delayMs: 60, cancelWhen: "race" });
await runCase("never", { behavior: "slow", cancelWhen: "never" });
await runCase("late", { behavior: "slow", cancelWhen: "sent" });
await runCase("repeat", { cancelWhen: "sent", extraCancel: true });
await runCase("success", { behavior: "exact", cancelWhen: "none" });

console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(0);
