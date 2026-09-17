/**
 * D4-06 Closure · 任务层跨 run 累计预算约束（真实产品 TaskHarnessOrchestrator + 确定性 provider）。
 *
 * capability 仍按 run 签发，但额度不得超过**任务剩余**；run 结束时把真实消耗记入
 * task_budgets（schema v16），再加权的种类不再顺带恢复其他预算。
 *
 * 覆盖 MODEL_CALLS / TOOL_CALLS / TOOL_ROUNDS 三类：
 *   ① 只加一个 kind 时其他两种 remaining 完全保留；
 *   ② 新 run 的实际调用次数受 remaining 约束（不是只账本显示对）；
 *   ③ 多类同时耗尽 → 停因/nextGrant 明确，其他种类不被自动补齐；
 *   ④ 重复/并发续接只追加一次、只产生一个有效运行；
 *   ⑤ 再次耗尽 / 成功副作用不重复；
 *   ⑥ 追加值 == 账本 == 运行时 capability 限制；
 *   ⑦ 正反对照：合法最后一次调用后完成 → 成功；仍需下一次调用但额度不足 → BUDGET_EXHAUSTED{TOOL_CALLS}；
 *   + 旧任务首次建账本采用保守基线（不伪造历史精确余额）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { DEFAULT_MAX_CALLS, MAX_TOOL_ROUNDS } = require("../electron/task-domain.cjs");
const { ToolFacadeBridge } = require("../electron/tool-facade-bridge.cjs");

const DSH_FINAL = "OPENARC_DSH_TOOL_OK";
const SYNTH_FINAL = "OPENARC_TASK_OK";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (fn, ms, detail) => (async () => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();
const searchPlan = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: "call_" + prefix + i, name: "resource_search", args: { query: prefix + "-" + i, limit: 5 } }));
const rounds = (n, prefix) => Array.from({ length: n }, (_, i) => ({ toolId: "resource.search", toolVersion: 1, arguments: { query: prefix + "-" + i, limit: 3 }, proposalId: "tc_" + prefix + "_" + i }));
const stopsOf = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "task.budget_exhausted").map((e) => JSON.parse(e.safe_payload));
const grantsOf = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "task.budget.granted");
const baselineOf = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "task.budget_baseline_created").map((e) => JSON.parse(e.safe_payload));
const ledgerOf = (fx, ctx, taskId) => fx.taskService.getBudgetLedger({ context: ctx, taskId }).ledger;
const runs = (fx, taskId) => fx.taskStore.harnessRunsOfTask(taskId).length;

const sameKinds = (a, b, kinds) => kinds.every((k) => a[k].authorized === b[k].authorized && a[k].consumed === b[k].consumed && a[k].remaining === b[k].remaining);

/** step0 成功（Artifact 锚点）+ step1 真实 dsh 受控 READ → 预算停止；返回 ledger 快照前的 task 状态。 */
async function dshBudgetStop(fx, { step1Plan, verify = DSH_FINAL }) {
  fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
  const ctx = fx.ctx();
  const t = fx.createTask();
  const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  const s0 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
  const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s0.task.revision });
  const ss0 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: s1.task.revision });
  const dsh = fx.makeDshOrchestrator();
  fx.fp.state.toolLoopPlan = [];
  const r0 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: verify } });
  assert.equal(r0.ok, true, "step0 必须成功：" + JSON.stringify(r0.error));
  const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
  fx.fp.state.toolLoopPlan = step1Plan;
  const r1 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: verify } });
  return { ctx, taskId: t.task.taskId, s0, s1, dsh, r0, r1 };
}

/** step0 成功（Artifact 锚点）+ step1 合成轮次预算停止。 */
async function synthBudgetStop(fx, plan) {
  fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
  const ctx = fx.ctx();
  const t = fx.createTask();
  const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  const s0 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { proposeSequence: [], finalText: SYNTH_FINAL }, expectedRevision: started.task.revision });
  const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { proposeSequence: plan, finalText: SYNTH_FINAL }, expectedRevision: s0.task.revision });
  const ss0 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: s1.task.revision });
  const orch = fx.makeToolOrchestrator();
  const r0 = await orch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: s0.step.input, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
  assert.equal(r0.ok, true, "step0 必须成功：" + JSON.stringify(r0.error));
  const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
  const r1 = await orch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: s1.step.input, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
  assert.equal(r1.error, "BUDGET_EXHAUSTED", "step1 必须预算停止：" + JSON.stringify(r1));
  return { ctx, taskId: t.task.taskId, s0, s1, orch, r0, r1 };
}

/* ============================================================ ① 只加一个 kind，其他两种完全保留 */

test("D4-08 ① MODEL_CALLS 消耗后追加 → TOOL_CALLS / TOOL_ROUNDS remaining 完全保留", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 100 });
  try {
    const h = await dshBudgetStop(fx, { step1Plan: searchPlan(12, "m") });
    assert.equal(h.r1.error, "BUDGET_EXHAUSTED");
    const stops = stopsOf(fx, h.taskId);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].kind, "MODEL_CALLS", JSON.stringify(stops[0]));
    assert.equal(stops[0].observed.model.state, "EXHAUSTED");
    assert.equal(stops[0].observed.tool.state, "ACTIVE", "工具预算未被顺带耗尽");
    const before = ledgerOf(fx, h.ctx, h.taskId).kinds;
    assert.equal(before.MODEL_CALLS.remaining, 0);
    assert.ok(before.TOOL_CALLS.remaining > 0 && before.TOOL_ROUNDS.remaining > 0);

    const g = fx.taskService.grantBudgetResume({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision, kind: "MODEL_CALLS" });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(g.amount, DEFAULT_MAX_CALLS);
    const after = ledgerOf(fx, h.ctx, h.taskId).kinds;
    assert.equal(after.MODEL_CALLS.authorized, before.MODEL_CALLS.authorized + DEFAULT_MAX_CALLS);
    assert.equal(after.MODEL_CALLS.consumed, before.MODEL_CALLS.consumed, "追加只加 authorized，不改 consumed");
    assert.equal(after.MODEL_CALLS.remaining, DEFAULT_MAX_CALLS, "新 run 额度 <= 任务剩余（此处恰好一次追加量）");
    assert.ok(sameKinds(before, after, ["TOOL_CALLS", "TOOL_ROUNDS"]), "其他两种 remaining 完全保留：" + JSON.stringify({ before, after }));
  } finally { await fx.close(); }
});

test("D4-08 ① TOOL_CALLS 消耗后追加 → MODEL_CALLS / TOOL_ROUNDS remaining 完全保留", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 2, modelMaxCalls: 100 });
  try {
    // model 额度显著高于 tool=2，plan 足够长 → 工具先被拒绝，停止归因 TOOL_CALLS，模型不耗尽。
    const h = await dshBudgetStop(fx, { step1Plan: searchPlan(8, "t") });
    assert.equal(h.r1.error, "BUDGET_EXHAUSTED");
    const stops = stopsOf(fx, h.taskId);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].kind, "TOOL_CALLS", JSON.stringify(stops[0]));
    assert.ok(stops[0].observed.tool.exhaustedRejections > 0, "必须有真实预算不足拒绝：" + JSON.stringify(stops[0].observed.tool));
    const before = ledgerOf(fx, h.ctx, h.taskId).kinds;
    assert.equal(before.TOOL_CALLS.remaining, 0);
    assert.ok(before.MODEL_CALLS.remaining > 0 && before.TOOL_ROUNDS.remaining > 0);

    const g = fx.taskService.grantBudgetResume({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision, kind: "TOOL_CALLS" });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(g.amount, 2);
    const after = ledgerOf(fx, h.ctx, h.taskId).kinds;
    assert.equal(after.TOOL_CALLS.authorized, before.TOOL_CALLS.authorized + 2);
    assert.equal(after.TOOL_CALLS.remaining, 2);
    assert.ok(sameKinds(before, after, ["MODEL_CALLS", "TOOL_ROUNDS"]), "其他两种 remaining 完全保留：" + JSON.stringify({ before, after }));
  } finally { await fx.close(); }
});

test("D4-08 ① TOOL_ROUNDS 消耗后追加 → MODEL_CALLS / TOOL_CALLS remaining 完全保留", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const h = await synthBudgetStop(fx, rounds(5, "r"));
    const stops = stopsOf(fx, h.taskId);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].kind, "TOOL_ROUNDS", JSON.stringify(stops[0]));
    assert.equal(stops[0].consumed, MAX_TOOL_ROUNDS);
    const before = ledgerOf(fx, h.ctx, h.taskId).kinds;
    assert.equal(before.TOOL_ROUNDS.remaining, 0);

    const g = fx.taskService.grantBudgetResume({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision, kind: "TOOL_ROUNDS" });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(g.amount, MAX_TOOL_ROUNDS);
    const after = ledgerOf(fx, h.ctx, h.taskId).kinds;
    assert.equal(after.TOOL_ROUNDS.authorized, before.TOOL_ROUNDS.authorized + MAX_TOOL_ROUNDS);
    assert.equal(after.TOOL_ROUNDS.remaining, MAX_TOOL_ROUNDS);
    assert.ok(sameKinds(before, after, ["MODEL_CALLS", "TOOL_CALLS"]), "合成轮次 stop 不消耗 model/tool calls：" + JSON.stringify({ before, after }));
  } finally { await fx.close(); }
});

/* ============================================================ ② 新 run 实际调用次数受 remaining 约束 */

test("D4-08 ② TOOL_CALLS：部分消耗后的新 run 实际受 remaining 约束（capability 额度 == remaining）", async () => {
  const modelCaps = []; const toolCaps = [];
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 3,
    facadeBridgeFactory: (o) => {
      const b = new ToolFacadeBridge(o);
      const orig = b.issueCapability.bind(b);
      b.issueCapability = (args) => { const res = orig(args); if (res && res.ok) toolCaps.push(res.capability.maxCalls); return res; };
      return b;
    },
  });
  try {
    const origIssue = fx.proxy.issueCapability.bind(fx.proxy);
    fx.proxy.issueCapability = (args) => { const res = origIssue(args); if (res && res.ok) modelCaps.push(res.capability.maxCalls); return res; };
    fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
    const ctx = fx.ctx();
    const t = fx.createTask();
    const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const s0 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s0.task.revision });
    const s2 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s1.task.revision });
    const ss0 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: s2.task.revision });
    const dsh = fx.makeDshOrchestrator();

    fx.fp.state.toolLoopPlan = [];
    const r0 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r0.ok, true, JSON.stringify(r0.error));
    // step1：2 个受控 READ（全部合法）→ 消耗 2 个 tool call，任务继续 RUNNING（step2 仍 PENDING）。
    const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
    fx.fp.state.toolLoopPlan = searchPlan(2, "p");
    const r1 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r1.ok, true, "2 个合法 tool call 后成功：" + JSON.stringify(r1.error));
    const beforeStep2 = ledgerOf(fx, ctx, t.task.taskId).kinds;
    assert.equal(beforeStep2.TOOL_CALLS.consumed, 2, JSON.stringify(beforeStep2));
    assert.equal(beforeStep2.TOOL_CALLS.remaining, 1);

    // step2：3 个受控 READ，但任务只剩 1 → 实际只允许 1 次执行。
    const ss2 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
    fx.fp.state.toolLoopPlan = searchPlan(3, "q");
    const r2 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: ss2.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r2.error, "BUDGET_EXHAUSTED", JSON.stringify(r2));
    const step2Execs = fx.toolStore.executionsOfTask(t.task.taskId).filter((e) => e.step_id === s2.step.stepId);
    assert.equal(step2Execs.length, 1, "新 run 实际调用次数受 remaining 约束：" + step2Execs.length);
    assert.equal(toolCaps[toolCaps.length - 1], 1, "step2 工具 capability 额度 == 任务剩余 1：" + JSON.stringify(toolCaps));
    const stop = stopsOf(fx, t.task.taskId).slice(-1)[0];
    assert.equal(stop.kind, "TOOL_CALLS");
    assert.equal(stop.maxCalls, 1, "停止证据的 maxCalls 是本轮真实额度：" + JSON.stringify(stop));
    assert.equal(stop.consumed, 1);
    assert.equal(ledgerOf(fx, ctx, t.task.taskId).kinds.TOOL_CALLS.remaining, 0);
  } finally { await fx.close(); }
});

test("D4-08 ② MODEL_CALLS：部分消耗后的新 run 实际受 remaining 约束（无第 remaining+1 次真实请求）", async () => {
  const modelCaps = [];
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 100 });
  try {
    const origIssue = fx.proxy.issueCapability.bind(fx.proxy);
    fx.proxy.issueCapability = (args) => { const res = origIssue(args); if (res && res.ok) modelCaps.push(res.capability.maxCalls); return res; };
    fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
    const ctx = fx.ctx();
    const t = fx.createTask();
    const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const s0 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s0.task.revision });
    const s2 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: s1.task.revision });
    const ss0 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: s2.task.revision });
    const dsh = fx.makeDshOrchestrator();
    // step0：1 次 model 请求成功；step1：再 1 次成功。任务剩余 model = 8 - 2 = 6。
    fx.fp.state.toolLoopPlan = [];
    const r0 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r0.ok, true, JSON.stringify(r0.error));
    const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
    fx.fp.state.toolLoopPlan = [];
    const r1 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r1.ok, true, JSON.stringify(r1.error));
    const before = ledgerOf(fx, ctx, t.task.taskId).kinds;
    assert.equal(before.MODEL_CALLS.remaining, DEFAULT_MAX_CALLS - 2, JSON.stringify(before));

    // step2：长 plan 需要远超 remaining 的 model 请求；proxy 必须只放行 remaining 次。
    const ss2 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
    fx.fp.state.toolLoopPlan = searchPlan(12, "mc");
    const requestsBefore = fx.fp.state.requests;
    const r2 = await dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: ss2.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r2.error, "BUDGET_EXHAUSTED", JSON.stringify(r2));
    assert.equal(modelCaps[modelCaps.length - 1], before.MODEL_CALLS.remaining, "新 run model capability 额度 == 任务剩余：" + JSON.stringify(modelCaps));
    assert.equal(fx.fp.state.requests - requestsBefore, before.MODEL_CALLS.remaining, "真实 provider 请求数 == remaining（无第 remaining+1 次）：" + (fx.fp.state.requests - requestsBefore));
    const stop = stopsOf(fx, t.task.taskId).slice(-1)[0];
    assert.equal(stop.kind, "MODEL_CALLS");
    assert.equal(stop.consumed, before.MODEL_CALLS.remaining);
    assert.equal(stop.maxCalls, before.MODEL_CALLS.remaining);
    assert.equal(ledgerOf(fx, ctx, t.task.taskId).kinds.MODEL_CALLS.remaining, 0);
  } finally { await fx.close(); }
});

test("D4-08 ② TOOL_ROUNDS：部分消耗后的新 run 实际轮数受 remaining 约束", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
    const ctx = fx.ctx();
    const t = fx.createTask();
    const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const s0 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { proposeSequence: [], finalText: SYNTH_FINAL }, expectedRevision: started.task.revision });
    const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { proposeSequence: rounds(2, "a"), finalText: SYNTH_FINAL }, expectedRevision: s0.task.revision });
    const s2 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { proposeSequence: rounds(5, "b"), finalText: SYNTH_FINAL }, expectedRevision: s1.task.revision });
    const ss0 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: s2.task.revision });
    const orch = fx.makeToolOrchestrator();
    const r0 = await orch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: s0.step.input, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(r0.ok, true, JSON.stringify(r0.error));
    const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
    const r1 = await orch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: s1.step.input, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(r1.ok, true, "2 轮后成功：" + JSON.stringify(r1.error));
    const before = ledgerOf(fx, ctx, t.task.taskId).kinds;
    assert.equal(before.TOOL_ROUNDS.consumed, 2);
    assert.equal(before.TOOL_ROUNDS.remaining, MAX_TOOL_ROUNDS - 2);

    const ss2 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
    const r2 = await orch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: ss2.task.revision, stepInput: s2.step.input, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(r2.error, "BUDGET_EXHAUSTED", JSON.stringify(r2));
    const step2Execs = fx.toolStore.executionsOfTask(t.task.taskId).filter((e) => e.step_id === s2.step.stepId);
    assert.equal(step2Execs.length, MAX_TOOL_ROUNDS - 2, "新 run 轮数上界 == 任务剩余 2：" + step2Execs.length);
    const stop = stopsOf(fx, t.task.taskId).slice(-1)[0];
    assert.equal(stop.kind, "TOOL_ROUNDS");
    assert.equal(stop.maxRounds, MAX_TOOL_ROUNDS - 2);
    assert.equal(ledgerOf(fx, ctx, t.task.taskId).kinds.TOOL_ROUNDS.remaining, 0);
  } finally { await fx.close(); }
});

/* ============================================================ ③ 多类同时耗尽 + 不自动补齐 */

test("D4-08 ③ MODEL_CALLS 与 TOOL_CALLS 同时耗尽 → 停因/nextGrant 明确；只追加一种，其他不被补齐", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 2, modelMaxCalls: 6 });
  try {
    const h = await dshBudgetStop(fx, { step1Plan: searchPlan(8, "both") });
    assert.equal(h.r1.error, "BUDGET_EXHAUSTED");
    const stops = stopsOf(fx, h.taskId);
    assert.equal(stops.length, 1);
    const stop = stops[0];
    assert.equal(stop.kind, "TOOL_CALLS", "多类同时耗尽必须沿用 TOOL_CALLS 优先：" + JSON.stringify(stop));
    assert.equal(stop.observed.tool.state, "EXHAUSTED");
    assert.equal(stop.observed.model.state, "EXHAUSTED", "保留 model 也耗尽的证据：" + JSON.stringify(stop.observed));
    const before = ledgerOf(fx, h.ctx, h.taskId).kinds;
    assert.equal(before.MODEL_CALLS.remaining, 0);
    assert.equal(before.TOOL_CALLS.remaining, 0);
    assert.ok(before.TOOL_ROUNDS.remaining > 0, "未使用的 kind 不被牵连");

    const elig = fx.taskService.getResumeEligibility({ context: h.ctx, taskId: h.taskId });
    assert.equal(elig.resumable, true, JSON.stringify(elig));
    assert.equal(elig.kind, "TOOL_CALLS");
    assert.equal(elig.nextGrant.kind, "TOOL_CALLS", "nextGrant = 当前阻塞 kind");
    assert.equal(elig.nextGrant.amount, 2);

    // 续接：只追加 TOOL_CALLS；MODEL_CALLS 仍为 0 → remaining==0 的 used kind 直接停止，且不创建新 run。
    const runsBefore = runs(fx, h.taskId);
    const rr = await h.dsh.resumeBudgetExhausted({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(rr.ok, false, JSON.stringify(rr));
    assert.equal(rr.error, "BUDGET_EXHAUSTED");
    assert.equal(runs(fx, h.taskId), runsBefore, "remaining==0 时绝不创建 run：" + runs(fx, h.taskId));
    const after = ledgerOf(fx, h.ctx, h.taskId).kinds;
    assert.equal(after.MODEL_CALLS.remaining, 0, "MODEL_CALLS 不被自动补齐");
    assert.equal(after.MODEL_CALLS.authorized, before.MODEL_CALLS.authorized, "MODEL authorized 完全不变");
    assert.equal(after.TOOL_CALLS.authorized, before.TOOL_CALLS.authorized + 2, "只加批准的 TOOL_CALLS");
    assert.equal(after.TOOL_CALLS.remaining, 2);
    const stops2 = stopsOf(fx, h.taskId);
    assert.equal(stops2.length, 2);
    assert.equal(stops2[1].kind, "MODEL_CALLS", "保持停止并归因仍为 0 的 used kind：" + JSON.stringify(stops2[1]));
    const elig2 = fx.taskService.getResumeEligibility({ context: h.ctx, taskId: h.taskId });
    assert.equal(elig2.nextGrant.kind, "MODEL_CALLS", "nextGrant 明确切到当前阻塞 kind");
  } finally { await fx.close(); }
});

/* ============================================================ ④ 重复/并发续接只追加一次 */

test("D4-08 ④ 并发续接 → 只追加一次、只产生一个有效运行", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const h = await synthBudgetStop(fx, rounds(5, "c"));
    const before = ledgerOf(fx, h.ctx, h.taskId).kinds;
    const runsBefore = runs(fx, h.taskId);
    const rev = fx.taskStore.taskById(h.taskId).revision;
    const args = { context: h.ctx, taskId: h.taskId, expectedRevision: rev, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } };
    const results = await Promise.all([h.orch.resumeBudgetExhausted(args), h.orch.resumeBudgetExhausted({ ...args })]);
    assert.equal(results.filter((r) => r.ok === true).length, 1, "恰好一次有效续接：" + JSON.stringify(results.map((r) => [r.ok, r.error])));
    assert.equal(grantsOf(fx, h.taskId).length, 1, "只追加一次预算");
    assert.equal(runs(fx, h.taskId), runsBefore + 1, "只产生一个有效运行");
    const after = ledgerOf(fx, h.ctx, h.taskId).kinds;
    assert.equal(after.TOOL_ROUNDS.authorized, before.TOOL_ROUNDS.authorized + MAX_TOOL_ROUNDS, "只加一次 TOOL_ROUNDS");
    // 成功后再次点击：不可续接，且不再追加。
    const again = await h.orch.resumeBudgetExhausted({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision });
    assert.equal(again.ok, false);
    assert.equal(grantsOf(fx, h.taskId).length, 1);
  } finally { await fx.close(); }
});

/* ============================================================ ⑤ 再次耗尽 + 成功副作用不重复 */

test("D4-08 ⑤ 续接后再次耗尽 → 正确停止；已成功副作用恰好一次、不重放", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d408-retain-"));
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), keepData: true,
    sideEffectRuntimeDir: path.join(root, "runtime"), sideEffectApprovalWaitMs: 60000, facadeWriteToolIds: ["resource.trash"],
  });
  try {
    const created = await fx.createResource("D4-08 Retained");
    const resourceRef = created.resource.resourceRef;
    const resourceId = created.resource.resourceId;
    fx.grantTool("ai", ["tool.resource.trash", "tool.resource.search", "tool.resource.readMetadata"]);
    assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(fx.grantUserResource(resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);

    const ctx = fx.ctx();
    const t = fx.createTask();
    const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const s0 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { proposeSequence: rounds(5, "keep"), finalText: SYNTH_FINAL }, expectedRevision: s0.task.revision });
    const ss0 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: s1.task.revision });

    // step0：真实受控 WRITE + 真实 approval → 成功副作用 + Artifact。
    fx.fp.state.toolLoopPlan = [{ id: "call_keep_trash", name: "resource_trash", args: { resourceRef } }];
    const dsh = fx.makeDshOrchestrator();
    const p0 = dsh.runStep({ context: ctx, taskId: t.task.taskId, stepId: s0.step.stepId, expectedRevision: ss0.task.revision, stepInput: null, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    await waitFor(() => fx.sideEffectStore.callsOfTask(t.task.taskId).length === 1, 60000, "SideEffectCall 未出现");
    const call = fx.sideEffectStore.callsOfTask(t.task.taskId)[0];
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: call.callId, decision: "APPROVE" }).ok, true);
    const r0 = await p0;
    assert.equal(r0.ok, true, "step0 WRITE 必须成功：" + JSON.stringify(r0.error));
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, true);

    // step1：合成轮次预算停止（step0 的 side-effect loop 已消耗 1 轮 → 只剩 3）。
    const toolOrch = fx.makeToolOrchestrator();
    const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision });
    const r1 = await toolOrch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: ss1.task.revision, stepInput: s1.step.input, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(r1.error, "BUDGET_EXHAUSTED", JSON.stringify(r1));
    const stop1 = stopsOf(fx, t.task.taskId).slice(-1)[0];
    assert.equal(stop1.kind, "TOOL_ROUNDS");
    assert.equal(stop1.maxRounds, MAX_TOOL_ROUNDS - 1, "任务剩余轮次：" + JSON.stringify(stop1));

    // 续接后再次耗尽：续接 step 依然受 remaining 约束，且绝不重放已成功的旧 tool 请求。
    const g1 = fx.taskService.grantBudgetResume({ context: ctx, taskId: t.task.taskId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision, kind: "TOOL_ROUNDS" });
    assert.equal(g1.ok, true, JSON.stringify(g1));
    const gs1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: g1.step.stepId, expectedRevision: g1.task.revision });
    const rr = await toolOrch.runStep({ context: ctx, taskId: t.task.taskId, stepId: g1.step.stepId, expectedRevision: gs1.task.revision, stepInput: { proposeSequence: rounds(5, "again"), finalText: SYNTH_FINAL }, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(rr.error, "BUDGET_EXHAUSTED", "续接后再次耗尽仍正确停止：" + JSON.stringify(rr));
    assert.equal(stopsOf(fx, t.task.taskId).length, 2, "两次停止都留痕");
    assert.equal(fx.sideEffectStore.callsOfTask(t.task.taskId).length, 1, "成功副作用恰好一次，绝不重放");
    assert.equal(fx.sideEffectStore.callById(call.callId).status, "SUCCEEDED");
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, true);
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "BLOCKED");

    // 最终显式追加后收尾；仍不重复副作用。
    const g2 = fx.taskService.grantBudgetResume({ context: ctx, taskId: t.task.taskId, expectedRevision: fx.taskStore.taskById(t.task.taskId).revision, kind: "TOOL_ROUNDS" });
    assert.equal(g2.ok, true, JSON.stringify(g2));
    const gs2 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: g2.step.stepId, expectedRevision: g2.task.revision });
    const fin = await toolOrch.runStep({ context: ctx, taskId: t.task.taskId, stepId: g2.step.stepId, expectedRevision: gs2.task.revision, stepInput: g2.step.input, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(fin.ok, true, "最终续接成功：" + JSON.stringify(fin.error));
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "SUCCEEDED");
    assert.equal(fx.sideEffectStore.callsOfTask(t.task.taskId).length, 1, "副作用仍恰好一次");
  } finally { await fx.close(); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/* ============================================================ ⑥ 追加值 == 账本 == 运行时限制 */

test("D4-08 ⑥ grant 返回值 == 账本 nextGrant/additions == 运行时 capability 额度", async () => {
  const toolCaps = [];
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 2, modelMaxCalls: 100,
    facadeBridgeFactory: (o) => {
      const b = new ToolFacadeBridge(o);
      const orig = b.issueCapability.bind(b);
      b.issueCapability = (args) => { const res = orig(args); if (res && res.ok) toolCaps.push(res.capability.maxCalls); return res; };
      return b;
    },
  });
  try {
    const h = await dshBudgetStop(fx, { step1Plan: searchPlan(8, "ui") });
    const ledger0 = ledgerOf(fx, h.ctx, h.taskId);
    assert.equal(ledger0.nextGrant.kind, "TOOL_CALLS");
    assert.equal(ledger0.nextGrant.amount, 2);
    const g = fx.taskService.grantBudgetResume({ context: h.ctx, taskId: h.taskId, expectedRevision: fx.taskStore.taskById(h.taskId).revision, kind: "TOOL_CALLS" });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.equal(g.amount, ledger0.nextGrant.amount, "grant 实际追加 == 账本 nextGrant.amount");
    const ledger1 = ledgerOf(fx, h.ctx, h.taskId);
    assert.equal(ledger1.additions[0].amount, g.amount, "additions.amount == grant 实际追加");
    assert.equal(ledger1.remaining.TOOL_CALLS, g.amount, "追加后 remaining == 追加量");
    // 新 run 的 capability 额度必须等于账本 remaining。
    const started = fx.taskService.startStep({ context: h.ctx, taskId: h.taskId, stepId: g.step.stepId, expectedRevision: g.task.revision });
    fx.fp.state.toolLoopPlan = [];
    const r = await h.dsh.runStep({ context: h.ctx, taskId: h.taskId, stepId: g.step.stepId, expectedRevision: started.task.revision, stepInput: g.step.input, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(toolCaps[toolCaps.length - 1], ledger1.remaining.TOOL_CALLS, "运行时 capability 额度 == 账本 remaining：" + JSON.stringify({ caps: toolCaps, remaining: ledger1.remaining }));
  } finally { await fx.close(); }
});

/* ============================================================ ⑦ 正反 TOOL_CALLS */

test("D4-08 ⑦ 正：合法最后一次 tool call 后完成 → SUCCEEDED，不得误杀", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 2 });
  try {
    fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
    // plan 恰好 2 == cap：2 次合法调用 + 1 次 final，绝不产生预算不足拒绝。
    fx.fp.state.toolLoopPlan = searchPlan(2, "ok");
    const ctx = fx.ctx();
    const t = fx.createTask();
    const r = await fx.makeDshOrchestrator().runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r.ok, true, "最后一次合法调用完成必须成功：" + JSON.stringify(r.error));
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "SUCCEEDED");
    assert.equal(stopsOf(fx, t.task.taskId).length, 0, "不得写预算停止事件");
    assert.equal(fx.taskStore.artifactsOfTask(t.task.taskId).length, 1, "必须按既有完成契约提交 Artifact");
    assert.equal(fx.taskStore.verificationsOfTask(t.task.taskId).length, 1);
    assert.equal(fx.toolStore.executionsOfTask(t.task.taskId).length, 2, "恰好 2 次真实执行");
    const ledger = ledgerOf(fx, ctx, t.task.taskId);
    assert.equal(ledger.kinds.TOOL_CALLS.consumed, 2);
    assert.equal(ledger.kinds.TOOL_CALLS.remaining, 0);
  } finally { await fx.close(); }
});

test("D4-08 ⑦ 反：仍需下一次调用但额度不足 → BUDGET_EXHAUSTED{TOOL_CALLS}，0 Artifact", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 2 });
  try {
    fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
    // plan 4 > cap：第 3 个新 logical call 被预算拒绝 → 仍有未完成的工具意图。
    fx.fp.state.toolLoopPlan = searchPlan(4, "no");
    const ctx = fx.ctx();
    const t = fx.createTask();
    const r = await fx.makeDshOrchestrator().runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r.ok, false, "仍有未完成工具意图时不得当成成功");
    assert.equal(r.error, "BUDGET_EXHAUSTED");
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "BLOCKED");
    assert.equal(fx.taskStore.artifactsOfTask(t.task.taskId).length, 0, "不得提交 Artifact");
    const stops = stopsOf(fx, t.task.taskId);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].kind, "TOOL_CALLS", JSON.stringify(stops[0]));
    assert.ok(stops[0].observed.tool.exhaustedRejections > 0);
    assert.ok(!JSON.stringify(stops[0]).includes("tpx_"), "停因 payload 绝不含 capability");
  } finally { await fx.close(); }
});

/* ============================================================ 旧任务保守基线 */

test("D4-08 旧任务首次建账本：不伪造历史精确余额，落 safe baseline 事件；新任务 consumed=0", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
    const ctx = fx.ctx();

    // 新任务（无任何 run）：精确 consumed=0，且无 baseline 事件。
    const fresh = fx.createTask();
    const freshLedger = ledgerOf(fx, ctx, fresh.task.taskId);
    assert.equal(freshLedger.kinds.MODEL_CALLS.consumed, 0);
    assert.equal(freshLedger.kinds.MODEL_CALLS.remaining, DEFAULT_MAX_CALLS);
    assert.equal(baselineOf(fx, fresh.task.taskId).length, 0, "新任务不需要基线事件");

    // 旧任务：已有 harness run 但从未建过 task_budgets 行（模拟 v15 之前的库）。
    const legacy = fx.createTask();
    const started = fx.taskService.startTask({ context: ctx, taskId: legacy.task.taskId, expectedRevision: legacy.task.revision });
    const step = fx.taskService.createStep({ context: ctx, taskId: legacy.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const ss = fx.taskService.startStep({ context: ctx, taskId: legacy.task.taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
    assert.equal(fx.taskService.startHarnessRun({ context: ctx, taskId: legacy.task.taskId, stepId: step.step.stepId, expectedRevision: ss.task.revision }).ok, true);
    assert.equal(fx.taskStore.taskBudgetsOfTask(legacy.task.taskId).length, 0, "触碰前不存在账本行");

    const legacyLedger = ledgerOf(fx, ctx, legacy.task.taskId);
    const base = baselineOf(fx, legacy.task.taskId);
    assert.equal(base.length, 1, "旧任务必须落一条 baseline 事件");
    assert.equal(base[0].precise, false, "基线明确不精确");
    for (const kind of ["MODEL_CALLS", "TOOL_CALLS", "TOOL_ROUNDS"]) {
      const k = legacyLedger.kinds[kind];
      assert.equal(k.authorized, fx.taskService.budgetConfig[kind]);
      assert.equal(k.consumed, k.authorized, "保守基线：缺少可靠消耗证据时不得留出免费额度");
      assert.equal(k.remaining, 0);
    }
    // 基线幂等：再次读取不追加第二条。
    ledgerOf(fx, ctx, legacy.task.taskId);
    assert.equal(baselineOf(fx, legacy.task.taskId).length, 1);
  } finally { await fx.close(); }
});
