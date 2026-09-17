/**
 * D4 收口 · 预算一致性（真实产品链路，只用确定性 provider / test-only seam）。
 *
 * 覆盖：
 *   · HarnessAdapter.budgetExhausted：TOOL_CALLS 优先于 MODEL_CALLS，observed 只读脱敏；
 *   · 工具预算真实耗尽不得被当成成功（prompt 产出 final 但 TOOL_CALLS EXHAUSTED → BUDGET_EXHAUSTED{TOOL_CALLS}）；
 *   · getBudgetLedger().base 用 attachBudgetConfig 注入的实际生效额度；
 *   · nextGrant.amount / additions.amount 与该类实际续接额度一致，一次续接只追加一个 kind。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { HarnessAdapter } = require("../electron/harness-adapter.cjs");

const DSH_FINAL = "OPENARC_DSH_TOOL_OK";
const searchPlan = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: "call_" + prefix + i, name: "resource_search", args: { query: prefix + "-" + i, limit: 3 } }));
const budgetStopsOf = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "task.budget_exhausted").map((e) => JSON.parse(e.safe_payload));

test("D4 收口 · budgetExhausted：TOOL_CALLS 优先于 MODEL_CALLS，observed 脱敏且只读", () => {
  const modelStates = new Map([["mpx_secret_model_token", { state: "EXHAUSTED", remaining: 0 }]]);
  const toolStates = new Map([["tpx_secret_tool_token", { state: "EXHAUSTED", calls: 2, maxCalls: 2 }]]);
  const modelProxy = { capabilityState: (t) => modelStates.get(t) || null };
  const bridge = { capabilityState: (t) => toolStates.get(t) || null };

  const both = new HarnessAdapter({ modelProxy });
  both.capability = { token: "mpx_secret_model_token", maxCalls: 8 };
  both.toolFacade = { bridge };
  both.toolCapability = { token: "tpx_secret_tool_token" };
  const r = both.budgetExhausted();
  assert.equal(r.exhausted, true);
  assert.equal(r.kind, "TOOL_CALLS", "两者同时耗尽时必须归因 TOOL_CALLS");
  assert.equal(r.consumed, 2);
  assert.equal(r.maxCalls, 2);
  assert.equal(r.observed.tool.state, "EXHAUSTED");
  assert.equal(r.observed.tool.calls, 2);
  assert.equal(r.observed.tool.remaining, 0);
  assert.equal(r.observed.model.state, "EXHAUSTED", "model 状态也如实观测");
  assert.equal(r.observed.model.maxCalls, 8);
  assert.equal(r.observed.model.calls, 8);
  assert.equal(r.observed.model.remaining, 0);
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes("mpx_") && !dump.includes("tpx_"), "observed 绝不含 capability token：" + dump);
  assert.ok(!dump.includes("token"), "observed 绝不含 token 字段");
  // 只读：capability state 未被改变或消耗。
  assert.deepEqual(modelStates.get("mpx_secret_model_token"), { state: "EXHAUSTED", remaining: 0 });
  assert.deepEqual(toolStates.get("tpx_secret_tool_token"), { state: "EXHAUSTED", calls: 2, maxCalls: 2 });

  const modelOnly = new HarnessAdapter({ modelProxy });
  modelOnly.capability = { token: "mpx_secret_model_token", maxCalls: 8 };
  assert.equal(modelOnly.budgetExhausted().kind, "MODEL_CALLS");

  const none = new HarnessAdapter({ modelProxy });
  none.capability = { token: "unknown", maxCalls: 8 };
  const n = none.budgetExhausted();
  assert.equal(n.exhausted, false);
  assert.equal(n.kind, null);
  assert.equal(n.observed.model.state, null);
});

test("D4 收口 · 工具预算真实耗尽不得当成成功：prompt 产出 final 但 TOOL_CALLS EXHAUSTED → BUDGET_EXHAUSTED{TOOL_CALLS}，0 Artifact", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 1 });
  try {
    fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
    // 2 个受控 READ：第 1 个成功，第 2 个被 capability 429 拒绝（真实 EXHAUSTED），随后模型仍产出 final。
    fx.fp.state.toolLoopPlan = searchPlan(2, "tb");
    const ctx = fx.ctx();
    const t = fx.createTask();
    const r = await fx.makeDshOrchestrator().runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });

    assert.equal(r.ok, false, "工具预算耗尽绝不当成成功：" + JSON.stringify(r.error));
    assert.equal(r.error, "BUDGET_EXHAUSTED");
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "BLOCKED");
    assert.equal(fx.taskStore.stepsOfTask(t.task.taskId)[0].status, "BLOCKED");
    assert.equal(fx.taskStore.artifactsOfTask(t.task.taskId).length, 0, "不得提交 Artifact");
    assert.equal(fx.taskStore.verificationsOfTask(t.task.taskId).length, 0, "该路径无验证失败，不得伪造 Verification");
    assert.equal(fx.toolStore.executionsOfTask(t.task.taskId).length, 1, "只有 1 次真实执行（第 2 次被 capability 429 拒绝，无执行）");
    const stops = budgetStopsOf(fx, t.task.taskId);
    assert.equal(stops.length, 1, "必须写一条 task.budget_exhausted：" + JSON.stringify(stops));
    assert.equal(stops[0].kind, "TOOL_CALLS", "停因必须是 TOOL_CALLS，绝不被 MODEL_CALLS 掩盖：" + JSON.stringify(stops[0]));
    assert.equal(stops[0].maxCalls, 1);
    assert.equal(stops[0].consumed, 1);
    assert.ok(stops[0].observed && stops[0].observed.tool && stops[0].observed.tool.state === "EXHAUSTED", "停因 payload 必须带实际观测证据：" + JSON.stringify(stops[0]));
    assert.ok(!JSON.stringify(stops[0]).includes("tpx_"), "停因 payload 绝不含 capability");
  } finally { await fx.close(); }
});

test("D4 收口 · ledger.base 用实际注入额度；nextGrant/additions 与该类实际额度一致且只追加一个 kind", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 1 });
  try {
    // 真实配置：model=DEFAULT_MAX_CALLS=8 / tool=facade maxCalls=1 / rounds=MAX_TOOL_ROUNDS=4。
    fx.taskService.attachBudgetConfig({ modelMaxCalls: 8, toolMaxCalls: 1, maxToolRounds: 4 });
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

    const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
    fx.fp.state.toolLoopPlan = searchPlan(2, "led");
    const r1 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r1.error, "BUDGET_EXHAUSTED");

    const ledger0 = fx.taskService.getBudgetLedger({ context: ctx, taskId: t.task.taskId }).ledger;
    assert.equal(ledger0.base.MODEL_CALLS, 8, "base 用注入的实际额度");
    assert.equal(ledger0.base.TOOL_CALLS, 1, "base.TOOL_CALLS == facade maxCalls（实际生效额度）：" + JSON.stringify(ledger0.base));
    assert.equal(ledger0.base.TOOL_ROUNDS, 4);
    assert.equal(ledger0.additions.length, 0);
    assert.equal(ledger0.nextGrant.kind, "TOOL_CALLS");
    assert.equal(ledger0.nextGrant.amount, 1, "nextGrant.amount == 该类实际续接额度：" + JSON.stringify(ledger0.nextGrant));

    const elig = fx.taskService.getResumeEligibility({ context: ctx, taskId: t.task.taskId });
    assert.equal(elig.resumable, true, JSON.stringify(elig));
    assert.equal(elig.kind, "TOOL_CALLS");

    fx.fp.state.toolLoopPlan = [];
    const res = await dsh.resumeBudgetExhausted({ context: ctx, taskId: t.task.taskId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(res.ok, true, "续接必须成功：" + JSON.stringify(res.error));

    const ledger1 = fx.taskService.getBudgetLedger({ context: ctx, taskId: t.task.taskId }).ledger;
    assert.equal(ledger1.additions.length, 1, "一次续接只追加一条：" + JSON.stringify(ledger1.additions));
    assert.equal(ledger1.additions[0].kind, "TOOL_CALLS");
    assert.equal(ledger1.additions[0].amount, 1, "additions.amount == 该类实际生效额度：" + JSON.stringify(ledger1.additions[0]));
    assert.ok(ledger1.additions.every((a) => a.kind === "TOOL_CALLS"), "账本绝不混入其他 kind：" + JSON.stringify(ledger1.additions));
    assert.equal(ledger1.base.TOOL_CALLS, 1, "base 不因续接漂移");
    assert.equal(ledger1.consumed.budgetStops.length, 1, "历史停止记录不清零");
  } finally { await fx.close(); }
});
