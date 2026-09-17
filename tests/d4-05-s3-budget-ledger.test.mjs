/**
 * D4-05 · S3（A35 用量到限）——真实 orchestrator + deterministic provider 达到 bounded 预算，
 * 停止自动循环、保留产物、显式续接，账本与实际生效额度一致。
 *
 * 覆盖：
 *   · task.budget_exhausted{kind, consumed, maxCalls} 原消耗保留；
 *   · 账本 additions.amount == 新一轮实际 Model Proxy capability 预算；
 *   · 不因新 step/run 无条件重置成无限或清零历史；
 *   · 追加总数有界（MAX_BUDGET_RESUMES=3）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { TaskService } = require("../electron/task-service.cjs");

const DSH_FINAL = "OPENARC_DSH_TOOL_OK";
const exhaustPlan = () => Array.from({ length: 12 }, (_, i) => ({ id: "call_e" + i, name: "resource_search", args: { query: "e-" + i, limit: 5 } }));
const budgetStopsOf = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "task.budget_exhausted").map((e) => JSON.parse(e.safe_payload));
const grantEventsOf = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "task.budget.granted");

/** step0 成功（Artifact 锚点）+ step1 真实 MODEL_CALLS 预算停止。 */
async function setupModelCallsStop(fx) {
  fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
  const ctx = fx.ctx();
  const t = fx.createTask();
  const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  const s0 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
  const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s0.task.revision });
  const ss0 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: s1.task.revision });
  const dsh = fx.makeDshOrchestrator();
  fx.fp.state.toolLoopPlan = [];
  const r0 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
  assert.equal(r0.ok, true, "step0 必须成功：" + JSON.stringify(r0.error));
  const fresh = fx.taskStore.taskById(t.task.taskId);
  const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fresh.revision });
  fx.fp.state.toolLoopPlan = exhaustPlan();
  const r1 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
  assert.equal(r1.error, "BUDGET_EXHAUSTED", "step1 必须预算停止：" + JSON.stringify(r1));
  return { ctx, taskId: t.task.taskId, s0, s1, dsh };
}

test("D4-05 S3 A35 · 预算到限停止保留产物；续接追加额度 == 新一轮真实 capability 预算、历史保留、base 不重置", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const issued = [];
    const origIssue = fx.proxy.issueCapability.bind(fx.proxy);
    fx.proxy.issueCapability = (args) => { const res = origIssue(args); if (res && res.ok) issued.push(res.capability.maxCalls); return res; };

    const h = await setupModelCallsStop(fx);
    assert.equal(fx.taskStore.taskById(h.taskId).status, "BLOCKED", "预算到限 → Task BLOCKED");
    assert.ok(fx.taskStore.stepsOfTask(h.taskId).some((s) => s.status === "BLOCKED"));
    const runs = fx.taskStore.harnessRunsOfTask(h.taskId);
    assert.equal(runs[runs.length - 1].error_code, "BUDGET_EXHAUSTED", "run error_code = BUDGET_EXHAUSTED");

    const artifactsBefore = fx.taskStore.artifactsOfTask(h.taskId);
    assert.equal(artifactsBefore.length, 1, "预算停止必须保留 step0 Artifact");
    const execsBefore = fx.toolStore.executionsOfTask(h.taskId).length;
    const stops = budgetStopsOf(fx, h.taskId);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].kind, "MODEL_CALLS", JSON.stringify(stops[0]));
    assert.equal(stops[0].consumed, 8, "task.budget_exhausted{consumed} = 真实 capability 消耗 8：" + JSON.stringify(stops[0]));
    assert.equal(stops[0].maxCalls, 8);
    assert.equal(TaskService.policy.autoRetry, 0, "AUTO_RETRY 必须为 0");

    const ledger0 = fx.taskService.getBudgetLedger({ context: h.ctx, taskId: h.taskId }).ledger;
    assert.equal(ledger0.base.MODEL_CALLS, 8);
    assert.equal(ledger0.base.TOOL_CALLS, 8);
    assert.equal(ledger0.base.TOOL_ROUNDS, 4);
    assert.equal(ledger0.additions.length, 0);
    assert.equal(ledger0.resumeCount, 0);
    assert.equal(ledger0.remainingResumes, 3);
    assert.equal(ledger0.consumed.budgetStops.length, 1, "原停止记录保留");
    assert.equal(ledger0.consumed.budgetStops[0].consumed, 8);
    assert.equal(ledger0.consumed.modelCallEnvelopes, fx.taskStore.callsOfTask(h.taskId).length, "modelCallEnvelopes 语义明确（每 step/run 一个信封）");
    assert.ok(!("modelCalls" in ledger0.consumed), "不再暴露语义模糊的 consumed.modelCalls");
    assert.equal(ledger0.resumable, true);

    const elig = fx.taskService.getResumeEligibility({ context: h.ctx, taskId: h.taskId });
    assert.equal(elig.resumable, true);
    assert.equal(elig.kind, "MODEL_CALLS");
    assert.equal(elig.resumeIndex, 1);
    assert.equal(elig.remainingResumes, 3);

    const capsBeforeResume = issued.length;
    fx.fp.state.toolLoopPlan = [];
    const res = await h.dsh.resumeBudgetExhausted({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(res.ok, true, "用户显式续接必须成功：" + JSON.stringify(res.error));
    assert.equal(fx.taskStore.taskById(h.taskId).status, "SUCCEEDED", "续接后新 bounded step 成功收敛");
    assert.equal(fx.toolStore.executionsOfTask(h.taskId).length, execsBefore, "续接不重放旧 tool 请求");
    assert.equal(fx.taskStore.artifactsOfTask(h.taskId).filter((a) => a.step_id === h.s0.step.stepId).length, 1, "旧 Artifact 保留");

    const newCaps = issued.slice(capsBeforeResume);
    assert.equal(newCaps.length, 1, "续接新 run 恰好 1 个新 model capability：" + JSON.stringify(issued));
    const ledger1 = fx.taskService.getBudgetLedger({ context: h.ctx, taskId: h.taskId }).ledger;
    assert.equal(ledger1.resumeCount, 1);
    assert.equal(ledger1.additions.length, 1);
    assert.equal(ledger1.additions[0].kind, "MODEL_CALLS");
    assert.equal(ledger1.additions[0].amount, newCaps[0], "additions.amount == 新一轮实际 capability 预算：" + JSON.stringify({ amount: ledger1.additions[0].amount, cap: newCaps[0] }));
    assert.equal(ledger1.remainingResumes, 2);
    assert.equal(ledger1.base.MODEL_CALLS, 8, "不得因新 step/run 把 base 重置为无限");
    assert.equal(ledger1.base.TOOL_ROUNDS, 4);
    assert.equal(ledger1.consumed.budgetStops.length, 1, "历史停止记录不清零");
    assert.equal(ledger1.consumed.toolExecutions, fx.toolStore.executionsOfTask(h.taskId).length);
    assert.ok(ledger1.additions[0].consumedAtGrant, "consumedAtGrant 快照保留");
    assert.equal(typeof ledger1.additions[0].consumedAtGrant.modelCallEnvelopes, "number");
    assert.equal(ledger1.consumed.modelCallEnvelopes, fx.taskStore.callsOfTask(h.taskId).length);
    assert.ok(ledger1.consumed.modelCallEnvelopes >= ledger1.additions[0].consumedAtGrant.modelCallEnvelopes, "续接不清零历史计数");
    assert.equal(grantEventsOf(fx, h.taskId).length, 1, "只追加一次预算");
    assert.equal(ledger1.resumable, false, "SUCCEEDED 不可续接");
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});

test("D4-05 S3 A35 · 续接总数有界：MAX_BUDGET_RESUMES=3，第 4 次 RESUME_LIMIT_REACHED、绝不追加", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const h = await setupModelCallsStop(fx);
    let extraStops = 0;
    for (let i = 1; i <= 3; i += 1) {
      const elig = fx.taskService.getResumeEligibility({ context: h.ctx, taskId: h.taskId });
      assert.equal(elig.resumable, true, "第 " + i + " 次续接前可续接：" + JSON.stringify(elig));
      assert.equal(elig.resumeIndex, i);
      assert.equal(elig.remainingResumes, 3 - (i - 1));
      fx.fp.state.toolLoopPlan = exhaustPlan();
      const rr = await h.dsh.resumeBudgetExhausted({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision });
      assert.equal(rr.ok, false, "续接后再次预算停止");
      assert.equal(rr.error, "BUDGET_EXHAUSTED");
      extraStops += 1;
    }
    const ledger = fx.taskService.getBudgetLedger({ context: h.ctx, taskId: h.taskId }).ledger;
    assert.equal(ledger.additions.length, 3, "追加次数上界 3：" + ledger.additions.length);
    assert.equal(ledger.resumeCount, 3);
    assert.equal(ledger.remainingResumes, 0);
    assert.equal(ledger.consumed.budgetStops.length, 1 + extraStops, "每次停止都有真实记录，历史不清零：" + JSON.stringify(ledger.consumed.budgetStops));
    assert.ok(ledger.additions.every((a) => a.amount === 8), "每次追加都是 bounded 同类额度 8：" + JSON.stringify(ledger.additions.map((a) => a.amount)));

    const elig4 = fx.taskService.getResumeEligibility({ context: h.ctx, taskId: h.taskId });
    assert.equal(elig4.resumable, false);
    assert.equal(elig4.reason, "RESUME_LIMIT_REACHED", JSON.stringify(elig4));
    const rr4 = await h.dsh.resumeBudgetExhausted({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision });
    assert.equal(rr4.ok, false);
    assert.equal(rr4.error, "RESUME_LIMIT_REACHED");
    assert.equal(grantEventsOf(fx, h.taskId).length, 3, "第 4 次绝不追加");
    assert.equal(fx.taskStore.stepsOfTask(h.taskId).length, 2 + 3, "只新增 3 个续接 step");
    assert.ok(fx.taskStore.harnessRunsOfTask(h.taskId).every((r) => r.status !== "RUNNING" && r.status !== "STARTING"), "无在途 run");
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});
