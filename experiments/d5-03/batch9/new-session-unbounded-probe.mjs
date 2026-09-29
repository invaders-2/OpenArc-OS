/**
 * 诊断（非门禁）· 0 次 provider 请求的一条可能路径：
 * harness-adapter.cjs 的 startTimeoutMs 只包 ACP initialize（:272-275），session/new（:278）没有上界。
 * 本脚本用真实 HarnessAdapter + 可控阻塞 session/new 的探针，观察在 startTimeoutMs + 余量之后 run 是否收敛。
 *
 * 用法：node experiments/d5-03/batch9/new-session-unbounded-probe.mjs
 */
import { createTaskHarnessFixture } from "../../../tests/fixtures/harness-acp/task-harness-fixture.mjs";

const START_MS = 700;
const WATCH_MS = 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = process.hrtime.bigint();
const marks = [];
const mark = (name, detail = null) => marks.push({ name, detail, atMs: Number(process.hrtime.bigint() - t0) / 1e6 });
const timeline = () => marks.map((m) => "+" + m.atMs.toFixed(1) + "ms " + m.name + (m.detail == null ? "" : " " + m.detail)).join(" | ");

const fx = await createTaskHarnessFixture();
const counter = { adapter: null };
const base = fx.agentFactory("session-new-hang-agent.mjs");
const orch = fx.makeOrchestrator((opts) => {
  const adapter = base(opts);
  counter.adapter = adapter;
  const start = adapter.start.bind(adapter);
  const prompt = adapter.prompt.bind(adapter);
  adapter.start = async (a) => { mark("adapter:start:begin"); try { const r = await start(a); mark("adapter:start:done"); return r; } catch (e) { mark("adapter:start:error", String(e && e.code || e)); throw e; } };
  adapter.prompt = async (text, o) => { mark("adapter:prompt:begin"); return await prompt(text, o); };
  return adapter;
}, { startTimeoutMs: START_MS });

const ctx = fx.ctx();
const created = fx.createTask();
let settled = null;
const runPromise = orch.runTask({ context: ctx, taskId: created.task.taskId, expectedRevision: created.task.revision });
runPromise.then((r) => { settled = { ok: !!r.ok, error: r && r.error || null }; }, (e) => { settled = { threw: String(e && e.message || e) }; });

const startedAt = Date.now();
while (Date.now() - startedAt < WATCH_MS && settled == null) await sleep(20);
mark("watch:end");

const task = fx.taskService.getTask({ context: ctx, taskId: created.task.taskId });
const runs = fx.taskService.getHarnessRuns({ context: ctx, taskId: created.task.taskId });
const out = {
  startTimeoutMs: START_MS,
  watchedMs: WATCH_MS,
  runSettled: settled != null,
  runResult: settled,
  taskStatus: task.ok ? task.task.status : null,
  runStatus: runs.ok && runs.items.length ? runs.items[0].status : null,
  providerRequests: fx.fp.state.requests,
  childAlive: !!(counter.adapter && counter.adapter.child && !counter.adapter.processExited),
  hasSessionId: counter.adapter ? counter.adapter.sessionId : null,
  promptCalls: marks.filter((m) => m.name === "adapter:prompt:begin").length,
  timeline: timeline(),
};
console.log(JSON.stringify(out, null, 2));

// 有界收尾：run 仍悬挂时 registry 里没有该 run，dispose 杀不到子进程，这里显式收尾。
try { if (counter.adapter && counter.adapter.child) counter.adapter.child.kill("SIGKILL"); } catch { /* ignore */ }
try { await orch.dispose(); } catch { /* ignore */ }
try { await fx.close(); } catch { /* ignore */ }
process.exit(0);
