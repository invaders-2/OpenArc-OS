/** D5-03 第十批 · R2 同根因排查（诊断，不修）：取消后 in-flight model call 的最终归宿。 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, "../../../..");
const { createTaskHarnessFixture } = await import(pathToFileURL(path.join(REPO, "tests/fixtures/harness-acp/task-harness-fixture.mjs")).href);

const fx = await createTaskHarnessFixture({ behavior: "slow" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = fx.ctx();
const t = fx.createTask();
const orch = fx.makeOrchestrator(fx.realAgentFactory());
const runPromise = orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
let r1 = null;
runPromise.then((r) => { r1 = r; }, (e) => { r1 = { threw: String(e && e.message || e) }; });

const t0 = Date.now();
while (fx.fp.state.requests < 1 && Date.now() - t0 < 30000) await sleep(20);
const callsBefore = fx.taskService.getCalls({ context: ctx, taskId: t.task.taskId }).items.map((c) => ({ id: c.callId, status: c.status }));
const cancel = await orch.cancel({ context: ctx, taskId: t.task.taskId, expectedRevision: fx.taskService.getTask({ context: ctx, taskId: t.task.taskId }).task.revision });
const snap = [];
for (const waitMs of [0, 200, 1000, 3000, 6000]) {
  if (waitMs) await sleep(waitMs === 0 ? 0 : (waitMs - (snap.length ? snap[snap.length - 1].at : 0)));
  const calls = fx.taskService.getCalls({ context: ctx, taskId: t.task.taskId }).items;
  snap.push({ at: waitMs, calls: calls.map((c) => ({ id: c.callId, status: c.status, errorCode: c.errorCode, providerErrorCode: c.providerErrorCode })) });
}
console.log(JSON.stringify({
  probeRequests: fx.fp.state.requests,
  callsBefore,
  cancelOk: cancel.ok,
  cancelError: cancel.error || null,
  runResult: r1,
  runStatus: fx.taskService.getHarnessRuns({ context: ctx, taskId: t.task.taskId }).items.map((r) => ({ status: r.status, errorCode: r.errorCode, stopReason: r.stopReason })),
  taskStatus: fx.taskService.getTask({ context: ctx, taskId: t.task.taskId }).task.status,
  stepStatus: fx.taskService.getSteps({ context: ctx, taskId: t.task.taskId }).items[0].status,
  callTimeline: snap,
}, null, 2));
try { await Promise.race([orch.dispose(), sleep(3000)]); } catch { /* ignore */ }
try { await Promise.race([fx.close(), sleep(3000)]); } catch { /* ignore */ }
process.exit(0);
