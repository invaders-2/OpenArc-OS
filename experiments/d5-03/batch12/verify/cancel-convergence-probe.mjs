/**
 * D5-03 第十二批 · 红证据探针（诊断，不入门禁）。
 *
 * 复现两件事：
 *   R2  = 用户取消后 model call 留在 STARTED（账本与事实不一致）
 *   HANG = 用户取消后对应 runTask 不返回
 *
 * 做法：真实 HarnessAdapter + 真实 TaskHarnessOrchestrator + 受控慢 Provider（5s 才回），
 * 在 provider 请求真实发出后取消，然后按时点观测：任务 / 步骤 / run / call 状态、
 * runTask 是否收敛、adapter 内部等待点（prompt promise 是否 settle、ACP cancel 是否发出、子进程是否回收）。
 *
 * 用法：node experiments/d5-03/batch12/verify/cancel-convergence-probe.mjs [--mode=sent|cancel-before-request|never|late]
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const { createTaskHarnessFixture } = await import(pathToFileURL(path.join(ROOT, "tests/fixtures/harness-acp/task-harness-fixture.mjs")).href);

const MODE = (process.argv.find((a) => a.startsWith("--mode=")) || "--mode=sent").split("=")[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD_MS = Number(process.env.OA_B12_HOLD_MS || 20000);

const fx = await createTaskHarnessFixture({ behavior: MODE === "never" ? "slow" : "slow" });
const marks = [];
const t0 = Date.now();
const mark = (name, detail = null) => marks.push({ name, detail, atMs: Date.now() - t0 });

const counter = { adapter: null, promptSettled: null, promptError: null, cancelCalls: 0 };
const base = fx.realAgentFactory();
const orch = fx.makeOrchestrator((opts) => {
  const adapter = base(opts);
  counter.adapter = adapter;
  const prompt = adapter.prompt.bind(adapter);
  const cancel = adapter.cancel.bind(adapter);
  adapter.prompt = async (text, o) => {
    mark("adapter:prompt:begin");
    try { const r = await prompt(text, o); counter.promptSettled = { stopReason: r && r.stopReason, events: (r && r.events || []).length }; mark("adapter:prompt:done", counter.promptSettled.stopReason); return r; }
    catch (e) { counter.promptError = String((e && e.code) || (e && e.message) || e).slice(0, 80); mark("adapter:prompt:error", counter.promptError); throw e; }
  };
  adapter.cancel = async () => { counter.cancelCalls += 1; mark("adapter:cancel:call"); const r = await cancel(); mark("adapter:cancel:return", JSON.stringify(r)); return r; };
  return adapter;
}, { startTimeoutMs: 20000, turnTimeoutMs: 180000 });

const ctx = fx.ctx();
const created = fx.createTask("Return exactly: OPENARC_TASK_OK");
let settled = null;
const runPromise = orch.runTask({ context: ctx, taskId: created.task.taskId, expectedRevision: created.task.revision });
runPromise.then((r) => { settled = { ok: r.ok, error: r.error || null, cancelled: !!r.cancelled }; mark("runTask:resolved", settled.error || "ok"); },
  (e) => { settled = { threw: String((e && e.message) || e) }; mark("runTask:threw", settled.threw); });

// 阶段 1：等到 provider 请求真实发出（或按模式提前取消）
if (MODE !== "cancel-before-request") {
  const deadline = Date.now() + 40000;
  while (fx.fp.state.requests < 1 && Date.now() < deadline) await sleep(10);
  mark("provider:request-seen", String(fx.fp.state.requests));
}

const snap = () => {
  const svc = fx.taskService;
  const t = svc.getTask({ context: ctx, taskId: created.task.taskId });
  const steps = svc.getSteps({ context: ctx, taskId: created.task.taskId });
  const runs = svc.getHarnessRuns({ context: ctx, taskId: created.task.taskId });
  const calls = svc.getCalls({ context: ctx, taskId: created.task.taskId });
  return {
    atMs: Date.now() - t0,
    runSettled: settled != null,
    runResult: settled,
    task: t.ok ? { status: t.task.status, cancelRequested: !!t.task.cancelRequested } : null,
    step: steps.ok && steps.items[0] ? steps.items[0].status : null,
    run: runs.ok && runs.items[0] ? { status: runs.items[0].status, errorCode: runs.items[0].errorCode, stopReason: runs.items[0].stopReason } : null,
    call: calls.ok && calls.items[0] ? { status: calls.items[0].status, providerErrorCode: calls.items[0].providerErrorCode } : null,
    promptSettled: counter.promptSettled,
    promptError: counter.promptError,
    childExited: counter.adapter ? counter.adapter.processExited : null,
    capabilities: [...fx.proxy.capabilities.values()].map((c) => c.state),
    providerRequests: fx.fp.state.requests,
    providerClosed: fx.fp.state.closed,
  };
};

const timeline = [snap()];
mark("timeline:0", "pre-cancel");

// 阶段 2：用户取消
const rev = fx.taskService.getTask({ context: ctx, taskId: created.task.taskId }).task.revision;
const cancelRes = await orch.cancel({ context: ctx, taskId: created.task.taskId, expectedRevision: rev });
mark("orch:cancel:return", JSON.stringify({ ok: cancelRes.ok, error: cancelRes.error || null }));
timeline.push(snap());

// 阶段 3：按时点观测收敛
const at = [100, 500, 1000, 3000, 5000, 10000, 20000];
let prev = 0;
for (const ms of at) {
  if (ms > HOLD_MS) break;
  await sleep(ms - prev); prev = ms;
  timeline.push(snap());
}

const out = {
  mode: MODE,
  providerBehavior: "slow(5s)",
  runSettledWithinMs: settled ? timeline.find((s) => s.runSettled).atMs : null,
  cancelReturnedMs: marks.find((m) => m.name === "orch:cancel:return").atMs,
  cancelCalls: counter.cancelCalls,
  timeline,
  marks,
};
console.log(JSON.stringify(out, null, 2));

try { if (counter.adapter && counter.adapter.child) counter.adapter.child.kill("SIGKILL"); } catch { /* ignore */ }
try { await Promise.race([orch.dispose(), sleep(3000)]); } catch { /* ignore */ }
try { await Promise.race([fx.close(), sleep(3000)]); } catch { /* ignore */ }
process.exit(0);
