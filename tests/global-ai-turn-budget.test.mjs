/**
 * 全局 AI 会话化 · 每轮补额（perTurnAllowance）。
 *
 * 对话式任务：每追加一轮，把剩余额度补回一份 base（只抬升 authorized，不清零 consumed），
 * 并落一条 task.budget.turn_granted；续接次数按轮计算。默认装配（未开启）语义不变，由 d4-09 覆盖。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { TASK_EVENT } = require("../electron/task-domain.cjs");

const FINAL = "OPENARC_TASK_OK";

async function succeededAfterOneRound(fx) {
  fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
  const ctx = fx.ctx();
  const t = fx.createTask("Return exactly: " + FINAL);
  const orch = fx.makeToolOrchestrator();
  const r = await orch.runTask({
    context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision,
    stepInput: { proposeSequence: [{ toolId: "resource.search", toolVersion: 1, arguments: { query: "seed", limit: 3 }, proposalId: "tc_seed" }], finalText: FINAL },
    verify: { type: "EXACT_TEXT", expected: FINAL },
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  return { ctx, taskId: t.task.taskId, orch };
}

test("perTurnAllowance：追加一轮把已用掉的额度补回一份 base，并记录 turn_granted", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const cfg = fx.taskService.attachBudgetConfig({ modelMaxCalls: 16, toolMaxCalls: 32, maxToolRounds: 8, perTurnAllowance: true });
    assert.equal(cfg.perTurnAllowance, true);
    const { ctx, taskId } = await succeededAfterOneRound(fx);
    const before = fx.taskService.getTaskBudget({ context: ctx, taskId }).kinds;
    assert.ok(before.TOOL_ROUNDS.consumed >= 1, "第一轮应消耗至少 1 个 round");

    const rev = fx.taskStore.taskById(taskId).revision;
    const r = fx.taskService.appendStep({ context: ctx, taskId, goal: "next question", expectedRevision: rev });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = fx.taskService.getTaskBudget({ context: ctx, taskId }).kinds;
    for (const [kind, base] of [["MODEL_CALLS", 16], ["TOOL_CALLS", 32], ["TOOL_ROUNDS", 8]]) {
      assert.equal(after[kind].consumed, before[kind].consumed, kind + " consumed 不变");
      assert.equal(after[kind].remaining, base, kind + " 剩余补回一份 base");
    }
    const turnEvents = fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === TASK_EVENT.TASK_BUDGET_TURN_GRANTED);
    assert.equal(turnEvents.length, 1);
    // 补额不算续接
    assert.equal(fx.taskService.getResumeEligibility({ context: ctx, taskId }).resumeCount, 0);
  } finally { await fx.close(); }
});

test("perTurnAllowance：续接次数只数最后一轮之后的授权", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.taskService.attachBudgetConfig({ modelMaxCalls: 16, toolMaxCalls: 32, maxToolRounds: 8, perTurnAllowance: true });
    const { ctx, taskId } = await succeededAfterOneRound(fx);
    // 模拟上一轮已经续接过 3 次
    for (let i = 0; i < 3; i++) fx.taskStore.appendEvent({ taskId, eventType: TASK_EVENT.TASK_BUDGET_GRANTED, at: Date.now(), safePayload: { amount: 1, kind: "MODEL_CALLS", resumeIndex: i + 1 } });
    assert.equal(fx.taskService.getResumeEligibility({ context: ctx, taskId }).resumeCount, 3);
    const rev = fx.taskStore.taskById(taskId).revision;
    assert.equal(fx.taskService.appendStep({ context: ctx, taskId, goal: "new turn", expectedRevision: rev }).ok, true);
    const e = fx.taskService.getResumeEligibility({ context: ctx, taskId });
    assert.equal(e.resumeCount, 0, "新一轮重新计数");
    assert.equal(e.remainingResumes, 3);
  } finally { await fx.close(); }
});

test("未开启 perTurnAllowance：追加不改账本、不记 turn_granted", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const { ctx, taskId } = await succeededAfterOneRound(fx);
    const before = fx.taskService.getTaskBudget({ context: ctx, taskId }).kinds;
    const rev = fx.taskStore.taskById(taskId).revision;
    assert.equal(fx.taskService.appendStep({ context: ctx, taskId, goal: "next", expectedRevision: rev }).ok, true);
    const after = fx.taskService.getTaskBudget({ context: ctx, taskId }).kinds;
    assert.deepEqual(after.TOOL_ROUNDS, before.TOOL_ROUNDS);
    assert.equal(fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === TASK_EVENT.TASK_BUDGET_TURN_GRANTED).length, 0);
  } finally { await fx.close(); }
});
