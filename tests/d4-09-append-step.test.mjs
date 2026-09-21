/**
 * D4 Main-Entry Closure-6 · 同一任务追加下一步目标（真实 TaskService / TaskHarnessOrchestrator）。
 *
 * 产品缺口：task/run 每次只创建一个 step；任务成功后没有任何产品入口追加"下一步目标"，
 * 因此"成功出产物 → 后续步骤预算耗尽 → UI 显式续接"在真实 UI 入口不可达。
 *
 * 覆盖：正常路径 / 预算不变 / 拒绝矩阵（含真实 crash 遗留 UNKNOWN_EFFECT 与遗留 active lease）/
 * 同步拒绝形状 / 幂等与并发 / 无额度追加 → 显式续接 / 低信任参考数据。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createToolHarnessFixture, reopenToolHarnessRuntime } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { TaskService } = require("../electron/task-service.cjs");
const { registerTaskIpc } = require("../electron/task-bootstrap.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");
const GATED_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "supervised-executor.mjs");

const SYNTH_FINAL = "OPENARC_TASK_OK";
const DSH_FINAL = "OPENARC_DSH_TOOL_OK";
const KINDS = ["MODEL_CALLS", "TOOL_CALLS", "TOOL_ROUNDS"];
const APPEND_INSTRUCTION = "Continue from the verified prior results. Do not re-issue any previous tool request and do not repeat already completed operations.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (fn, ms, detail) => (async () => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();

const revOf = (fx, taskId) => fx.taskStore.taskById(taskId).revision;
const rowsOf = (fx, taskId) => ({
  steps: fx.taskStore.stepsOfTask(taskId).map((r) => JSON.stringify(r)),
  artifacts: fx.taskStore.artifactsOfTask(taskId).map((r) => JSON.stringify(r)),
  verifications: fx.taskStore.verificationsOfTask(taskId).map((r) => JSON.stringify(r)),
  runs: fx.taskStore.harnessRunsOfTask(taskId).map((r) => JSON.stringify(r)),
});
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const kindSnapshot = (budget) => {
  const out = {};
  for (const k of KINDS) out[k] = { authorized: budget.kinds[k].authorized, consumed: budget.kinds[k].consumed, remaining: budget.kinds[k].remaining };
  return out;
};
const budgetStopEventsOf = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "task.budget_exhausted");
const grantEventsOf = (fx, taskId) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === "task.budget.granted");
const eventsOfType = (fx, taskId, type) => fx.taskStore.eventsOfTask(taskId).filter((e) => e.event_type === type);

/** 真实成功任务：1 个 SUCCEEDED step + 1 Artifact + 1 Verification（合成 ACP 路径，确定性且不重放）。 */
async function succeededTask(fx, goal = "Return exactly: " + SYNTH_FINAL) {
  fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
  const ctx = fx.ctx();
  const t = fx.createTask(goal);
  const orch = fx.makeToolOrchestrator();
  const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput: { proposeSequence: [], finalText: SYNTH_FINAL }, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
  assert.equal(r.ok, true, "初始任务必须成功：" + JSON.stringify(r.error));
  assert.equal(fx.taskStore.taskById(t.task.taskId).status, "SUCCEEDED");
  return { ctx, taskId: t.task.taskId, orch, task: t.task };
}

/** 真实成功任务（消耗 1 个 TOOL_ROUNDS）：合成 ACP 路径执行 1 个受控 READ 后成功。 */
async function succeededTaskAfterOneRound(fx, goal = "Return exactly: " + SYNTH_FINAL) {
  fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
  const ctx = fx.ctx();
  const t = fx.createTask(goal);
  const orch = fx.makeToolOrchestrator();
  const r = await orch.runTask({
    context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision,
    stepInput: { proposeSequence: [{ toolId: "resource.search", toolVersion: 1, arguments: { query: "seed-0", limit: 3 }, proposalId: "tc_seed_0" }], finalText: SYNTH_FINAL },
    verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL },
  });
  assert.equal(r.ok, true, "初始任务必须成功：" + JSON.stringify(r.error));
  assert.equal(fx.taskStore.taskById(t.task.taskId).status, "SUCCEEDED");
  return { ctx, taskId: t.task.taskId, orch, task: t.task };
}

/** 追加拒绝断言：形状 + 绝不新增 step/run + 绝不修改旧行 / revision。 */
function assertAppendRejected(fx, { ctx, taskId, reason, expectedRevision = null }) {
  const before = rowsOf(fx, taskId);
  const rev = revOf(fx, taskId);
  const status = fx.taskStore.taskById(taskId).status;
  const res = fx.taskService.appendStep({ context: ctx, taskId, goal: "下一步目标", expectedRevision: expectedRevision == null ? rev : expectedRevision });
  assert.equal(res.ok, false, "必须拒绝：" + JSON.stringify(res));
  assert.equal(res.error, "APPEND_NOT_ALLOWED", JSON.stringify(res));
  assert.equal(res.reason, reason, JSON.stringify(res));
  assert.equal(revOf(fx, taskId), rev, "拒绝不得改 revision");
  assert.equal(fx.taskStore.taskById(taskId).status, status, "拒绝不得改 task 状态");
  assert.ok(sameRows(before, rowsOf(fx, taskId)), "拒绝不得新增/修改任何 step/artifact/verification/run");
  return res;
}

/* ============================================================ A 正常路径 + 预算不变 + 事件 */
test("D4-09 A · SUCCEEDED + 1 artifact → appendStep 只新增 1 step；旧行逐行不变、completed_at 保留、账本 0 变化", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const s = await succeededTask(fx);
    const { ctx, taskId } = s;
    const before = {
      rows: rowsOf(fx, taskId),
      task: fx.taskStore.taskById(taskId),
      budgets: kindSnapshot(fx.taskService.getTaskBudget({ context: ctx, taskId })),
      revision: revOf(fx, taskId),
    };
    const elig = fx.taskService.getAppendEligibility({ context: ctx, taskId });
    assert.deepEqual(elig, { ok: true, taskId, appendable: true, reason: null });

    // SUCCEEDED→RUNNING 这条边只属于 AppendStep：startTask / runTask 必须显式拒绝，绝不借它重启已成功任务。
    const startedAgain = fx.taskService.startTask({ context: ctx, taskId, expectedRevision: before.revision });
    assert.equal(startedAgain.ok, false);
    assert.equal(startedAgain.error, "TASK_INVALID_STATE");
    assert.equal(startedAgain.detail, "APPEND_REQUIRED");
    const runAgain = await s.orch.runTask({ context: ctx, taskId, expectedRevision: before.revision, stepInput: { proposeSequence: [], finalText: SYNTH_FINAL }, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(runAgain.ok, false);
    assert.equal(runAgain.error, "TASK_INVALID_STATE");
    assert.equal(fx.taskStore.harnessRunsOfTask(taskId).length, 1, "SUCCEEDED 任务不得被 runTask 起 run");

    const goal = "下一步：输出第二阶段的结论";
    const res = fx.taskService.appendStep({ context: ctx, taskId, goal, expectedRevision: before.revision });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.appendIndex, 1);

    // 只新增一个 step；旧 step/artifact/verification/run 行内容逐行完全一致
    const after = rowsOf(fx, taskId);
    assert.equal(after.steps.length, 2, "只新增 1 个 step");
    assert.deepEqual(after.steps.slice(0, 1), before.rows.steps, "旧 step 行逐行不变");
    assert.deepEqual(after.artifacts, before.rows.artifacts, "旧 artifact 行逐行不变");
    assert.deepEqual(after.verifications, before.rows.verifications, "旧 verification 行逐行不变");
    assert.deepEqual(after.runs, before.rows.runs, "append 本身不得新建 harness run");

    // 新 step 契约
    const step = res.step;
    const oldStep = JSON.parse(before.rows.steps[0]);
    const oldRun = JSON.parse(before.rows.runs[0]);
    const oldArtifact = JSON.parse(before.rows.artifacts[0]);
    assert.equal(step.taskId, taskId, "同一 task");
    assert.notEqual(step.stepId, oldStep.step_id, "新 stepId");
    assert.equal(step.sequence, 2);
    assert.equal(step.kind, "reasoning");
    assert.equal(step.status, "PENDING");
    assert.equal(step.attempt, 1);
    assert.equal(step.maxAttempts, 1);
    assert.deepEqual(Object.keys(step.input).sort(), ["appendIndex", "appended", "fromRunId", "fromStepId", "goal", "instruction", "priorArtifacts"]);
    assert.equal(step.input.appended, true);
    assert.equal(step.input.appendIndex, 1);
    assert.equal(step.input.goal, goal, "input.goal = 新目标");
    assert.equal(step.input.fromStepId, oldStep.step_id);
    assert.equal(step.input.fromRunId, oldRun.run_id);
    assert.equal(step.input.instruction, APPEND_INSTRUCTION);
    assert.deepEqual(step.input.priorArtifacts, [{ artifactId: oldArtifact.artifact_id, type: oldArtifact.type, content: String(oldArtifact.safe_content).slice(0, 2000) }]);

    // task SUCCEEDED → RUNNING；completed_at / started_at 保留；revision 递增
    const task = fx.taskStore.taskById(taskId);
    assert.equal(task.status, "RUNNING");
    assert.equal(task.completed_at, before.task.completed_at, "completed_at 保留");
    assert.equal(task.started_at, before.task.started_at, "started_at 保留");
    assert.equal(task.revision, before.revision + 1, "revision 递增 1");
    assert.equal(res.task.status, "RUNNING");

    // 账本 0 变化
    assert.deepEqual(kindSnapshot(fx.taskService.getTaskBudget({ context: ctx, taskId })), before.budgets, "三类 authorized/consumed/remaining 完全不变");
    assert.deepEqual(res.remaining, { MODEL_CALLS: before.budgets.MODEL_CALLS.remaining, TOOL_CALLS: before.budgets.TOOL_CALLS.remaining, TOOL_ROUNDS: before.budgets.TOOL_ROUNDS.remaining });

    // 事件与审计
    const created = eventsOfType(fx, taskId, "step.created").slice(-1)[0];
    assert.deepEqual(JSON.parse(created.safe_payload), { stepId: step.stepId, sequence: 2, kind: "reasoning", maxAttempts: 1, appended: true, appendIndex: 1 });
    const started = eventsOfType(fx, taskId, "task.started").slice(-1)[0];
    assert.deepEqual(JSON.parse(started.safe_payload), { revision: task.revision, appended: true, appendIndex: 1 });

    // 追加后仍是 PENDING step：再次追加必须 IN_FLIGHT（在途守卫优先于任何状态判定）
    const again = fx.taskService.getAppendEligibility({ context: ctx, taskId });
    assert.equal(again.appendable, false);
    assert.equal(again.reason, "APPEND_IN_FLIGHT");
    assertAppendRejected(fx, { ctx, taskId, reason: "APPEND_IN_FLIGHT" });
  } finally { await fx.close(); }
});

/* ============================================================ B orchestrator.appendStep 全链 */
test("D4-09 B · orchestrator.appendStep 全链：新 run 只拿任务剩余额度；成功后 2 artifact、旧行保留、0 tool 重放", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.grantTool("ai", ["tool.resource.search", "tool.resource.readMetadata"]);
    const ctx = fx.ctx();
    const t = fx.createTask();
    const dsh = fx.makeDshOrchestrator();
    fx.fp.state.toolLoopPlan = [];
    const r0 = await dsh.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(r0.ok, true, "step0 必须成功：" + JSON.stringify(r0.error));
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "SUCCEEDED");

    const beforeRows = rowsOf(fx, t.task.taskId);
    const beforeBudget = fx.taskService.getTaskBudget({ context: ctx, taskId: t.task.taskId });
    const modelCaps = [];
    const origIssue = fx.proxy.issueCapability.bind(fx.proxy);
    fx.proxy.issueCapability = (args) => { const res = origIssue(args); if (res && res.ok) modelCaps.push(res.capability.maxCalls); return res; };

    const appended = await dsh.appendStep({ context: ctx, taskId: t.task.taskId, goal: "第二阶段：继续处理", expectedRevision: revOf(fx, t.task.taskId), verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
    assert.equal(appended.ok, true, "追加后的 run 必须成功：" + JSON.stringify(appended.error));
    assert.equal(modelCaps[modelCaps.length - 1], beforeBudget.remaining.MODEL_CALLS, "新 run 的 model capability 额度 == 追加时任务剩余：" + JSON.stringify({ caps: modelCaps, before: beforeBudget.remaining }));

    const steps = fx.taskStore.stepsOfTask(t.task.taskId);
    assert.equal(steps.length, 2, "只新增一个 step");
    assert.equal(steps[1].status, "SUCCEEDED");
    assert.equal(fx.taskStore.harnessRunsOfTask(t.task.taskId).length, 2, "只多一个 run");
    assert.deepEqual(rowsOf(fx, t.task.taskId).steps.slice(0, 1), beforeRows.steps, "旧 step 行不变");
    assert.deepEqual(rowsOf(fx, t.task.taskId).artifacts.slice(0, 1), beforeRows.artifacts, "旧 artifact 行不变");
    assert.equal(fx.taskStore.artifactsOfTask(t.task.taskId).length, 2, "追加 run 产出第二个 artifact");
    assert.equal(fx.taskStore.verificationsOfTask(t.task.taskId).length, 2);
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "SUCCEEDED");

    // 追加 step 绝不重放旧 tool 请求：0 execution、0 side-effect call
    assert.equal(fx.toolStore.executionsOfTask(t.task.taskId).filter((e) => e.step_id === steps[1].step_id).length, 0, "追加 step 不得执行任何 tool");
    assert.equal(fx.sideEffectStore.callsOfTask(t.task.taskId).length, 0);
    const afterBudget = fx.taskService.getTaskBudget({ context: ctx, taskId: t.task.taskId });
    assert.equal(afterBudget.kinds.TOOL_CALLS.consumed, beforeBudget.kinds.TOOL_CALLS.consumed, "未使用的 kind 不被牵连");
    assert.equal(afterBudget.kinds.TOOL_ROUNDS.consumed, beforeBudget.kinds.TOOL_ROUNDS.consumed);
  } finally { await fx.close(); }
});

/* ============================================================ C 低信任参考数据 */
test("D4-09 C · 追加 step 的 input 只承载本任务自身 priorArtifacts（≤3、普通 JSON、无 role/system 提升）", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const other = await succeededTask(fx, "任务 B：返回 " + SYNTH_FINAL);
    const otherArtifactIds = fx.taskStore.artifactsOfTask(other.taskId).map((a) => a.artifact_id);
    const a = await succeededTask(fx, "任务 A：返回 " + SYNTH_FINAL);
    fx.fp.state.toolLoopPlan = [];
    const dsh = fx.makeDshOrchestrator();
    for (let i = 0; i < 3; i += 1) {
      const r = await dsh.appendStep({ context: a.ctx, taskId: a.taskId, goal: "追加目标 " + (i + 1), expectedRevision: revOf(fx, a.taskId), verify: { type: "EXACT_TEXT", expected: DSH_FINAL } });
      assert.equal(r.ok, true, JSON.stringify(r.error));
    }
    assert.equal(fx.taskStore.artifactsOfTask(a.taskId).length, 4);
    const res = fx.taskService.appendStep({ context: a.ctx, taskId: a.taskId, goal: "第四个追加目标", expectedRevision: revOf(fx, a.taskId) });
    assert.equal(res.ok, true, JSON.stringify(res));
    const input = res.step.input;
    assert.equal(input.appendIndex, 4, "appendIndex = 历史 appended step 数 + 1");
    const ownIds = fx.taskStore.artifactsOfTask(a.taskId).filter((x) => x.step_id !== res.step.stepId).map((x) => x.artifact_id);
    assert.deepEqual(input.priorArtifacts.map((p) => p.artifactId), ownIds.slice(-3), "只取本任务最后 ≤3 个 artifact");
    assert.equal(input.priorArtifacts.length, 3);
    for (const id of otherArtifactIds) assert.equal(input.priorArtifacts.some((p) => p.artifactId === id), false, "绝不跨任务取 artifact");
    assert.ok(input.priorArtifacts.every((p) => typeof p.content === "string" && p.content.length <= 2000 && ["text", "json"].includes(p.type)));

    // 普通 JSON 数据：绝无 role/system 之类指令提升
    assert.deepEqual(Object.keys(input).sort(), ["appendIndex", "appended", "fromRunId", "fromStepId", "goal", "instruction", "priorArtifacts"]);
    const keys = new Set();
    const walk = (v) => { if (Array.isArray(v)) { v.forEach(walk); return; } if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k); walk(val); } };
    walk(input);
    for (const forbidden of ["role", "system", "messages", "tools", "tool_calls"]) assert.equal(keys.has(forbidden), false, "input 不得出现指令提升键：" + forbidden);
  } finally { await fx.close(); }
});

/* ============================================================ D 拒绝矩阵（状态 / 身份 / 校验） */
test("D4-09 D · 拒绝矩阵：非 SUCCEEDED、0 artifact、已 cancel、不存在、非法 goal、身份、无副作用账本", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const s = await succeededTask(fx);
    const ctx = s.ctx;

    // 非法 goal：一律 INVALID_INPUT，且不得新增 step / 不得离开 SUCCEEDED
    for (const goal of ["", "   ", "a".repeat(2001), null, 42, { goal: "x" }]) {
      const r = fx.taskService.appendStep({ context: ctx, taskId: s.taskId, goal, expectedRevision: revOf(fx, s.taskId) });
      assert.equal(r.ok, false, "非法 goal 必须拒绝：" + JSON.stringify(goal));
      assert.equal(r.error, "INVALID_INPUT", JSON.stringify(r));
      assert.equal(fx.taskStore.taskById(s.taskId).status, "SUCCEEDED");
      assert.equal(fx.taskStore.stepsOfTask(s.taskId).length, 1);
    }

    // 不存在
    assert.equal(fx.taskService.appendStep({ context: ctx, taskId: "task_missing", goal: "x", expectedRevision: 1 }).error, "TASK_NOT_FOUND");
    // 非 owner（第二个真实用户）与错误 app：读 / 追加都 TASK_FORBIDDEN
    const aliceCtx = { sessionRef: fx.f.sessions.alice, appId: "ai", source: "test" };
    assert.equal(fx.taskService.getTask({ context: aliceCtx, taskId: s.taskId }).error, "TASK_FORBIDDEN");
    assert.equal(fx.taskService.appendStep({ context: aliceCtx, taskId: s.taskId, goal: "x", expectedRevision: revOf(fx, s.taskId) }).error, "TASK_FORBIDDEN");
    assert.equal(fx.taskService.getAppendEligibility({ context: { sessionRef: fx.f.sessions.admin, appId: "canvas", source: "test" }, taskId: s.taskId }).error, "TASK_FORBIDDEN");
    // 陈旧 revision：TASK_REVISION_CONFLICT（先于状态判定）
    const stale = fx.taskService.appendStep({ context: ctx, taskId: s.taskId, goal: "x", expectedRevision: 999999 });
    assert.equal(stale.error, "TASK_REVISION_CONFLICT");
    assert.equal(stale.current, revOf(fx, s.taskId));

    // 无 sideEffectStore → APPEND_EFFECT_STATE_UNAVAILABLE（只读账本未装配）
    const bare = new TaskService({ identity: fx.f.identity, authService: fx.f.authService, authStore: fx.f.store, taskStore: fx.taskStore, clock: fx.f.clock });
    const bareElig = bare.getAppendEligibility({ context: ctx, taskId: s.taskId });
    assert.equal(bareElig.appendable, false);
    assert.equal(bareElig.reason, "APPEND_EFFECT_STATE_UNAVAILABLE");
    assert.equal(bare.appendStep({ context: ctx, taskId: s.taskId, goal: "x", expectedRevision: revOf(fx, s.taskId) }).reason, "APPEND_EFFECT_STATE_UNAVAILABLE");

    // PENDING
    const pending = fx.createTask();
    assertAppendRejected(fx, { ctx, taskId: pending.task.taskId, reason: "APPEND_NOT_SUCCEEDED" });
    assert.equal(fx.taskService.getAppendEligibility({ context: ctx, taskId: pending.task.taskId }).reason, "APPEND_NOT_SUCCEEDED");
    // RUNNING + PENDING step → IN_FLIGHT（在途优先于 NOT_SUCCEEDED）
    const running = fx.createTask();
    const startedRun = fx.taskService.startTask({ context: ctx, taskId: running.task.taskId, expectedRevision: running.task.revision });
    fx.taskService.createStep({ context: ctx, taskId: running.task.taskId, kind: "reasoning", input: null, expectedRevision: startedRun.task.revision });
    assertAppendRejected(fx, { ctx, taskId: running.task.taskId, reason: "APPEND_IN_FLIGHT" });
    // RUNNING 且无 step → NOT_SUCCEEDED
    const runningNoStep = fx.createTask();
    fx.taskService.startTask({ context: ctx, taskId: runningNoStep.task.taskId, expectedRevision: runningNoStep.task.revision });
    assertAppendRejected(fx, { ctx, taskId: runningNoStep.task.taskId, reason: "APPEND_NOT_SUCCEEDED" });
    // BLOCKED
    const blocked = fx.createTask();
    const bStarted = fx.taskService.startTask({ context: ctx, taskId: blocked.task.taskId, expectedRevision: blocked.task.revision });
    const bStep = fx.taskService.createStep({ context: ctx, taskId: blocked.task.taskId, kind: "reasoning", input: null, expectedRevision: bStarted.task.revision });
    const bStepStarted = fx.taskService.startStep({ context: ctx, taskId: blocked.task.taskId, stepId: bStep.step.stepId, expectedRevision: bStep.task.revision });
    fx.taskService.blockStep({ context: ctx, taskId: blocked.task.taskId, stepId: bStep.step.stepId, reason: "HARNESS_TURN_TIMEOUT", expectedRevision: bStepStarted.task.revision });
    assert.equal(fx.taskStore.taskById(blocked.task.taskId).status, "BLOCKED");
    assertAppendRejected(fx, { ctx, taskId: blocked.task.taskId, reason: "APPEND_NOT_SUCCEEDED" });
    // SUCCEEDED 但 0 artifact（真实 completeTask 路径）
    const noArtifact = fx.createTask();
    const nStarted = fx.taskService.startTask({ context: ctx, taskId: noArtifact.task.taskId, expectedRevision: noArtifact.task.revision });
    fx.taskService.completeTask({ context: ctx, taskId: noArtifact.task.taskId, expectedRevision: nStarted.task.revision });
    assert.equal(fx.taskStore.taskById(noArtifact.task.taskId).status, "SUCCEEDED");
    assert.equal(fx.taskStore.artifactsOfTask(noArtifact.task.taskId).length, 0);
    assertAppendRejected(fx, { ctx, taskId: noArtifact.task.taskId, reason: "APPEND_NO_ARTIFACT" });
    assert.equal(fx.taskService.getAppendEligibility({ context: ctx, taskId: noArtifact.task.taskId }).reason, "APPEND_NO_ARTIFACT");
    // 已 cancel → TASK_CANCELLED（不套用 APPEND_* 形状）
    const cancelled = fx.createTask();
    const cancelTaskRes = fx.taskService.cancelTask({ context: ctx, taskId: cancelled.task.taskId, expectedRevision: cancelled.task.revision });
    assert.equal(cancelTaskRes.ok, true);
    const cancelRows = rowsOf(fx, cancelled.task.taskId);
    const cancelAppend = fx.taskService.appendStep({ context: ctx, taskId: cancelled.task.taskId, goal: "x", expectedRevision: revOf(fx, cancelled.task.taskId) });
    assert.equal(cancelAppend.error, "TASK_CANCELLED", JSON.stringify(cancelAppend));
    assert.ok(sameRows(cancelRows, rowsOf(fx, cancelled.task.taskId)), "cancel 后的追加拒绝不得改任何行");
    assert.equal(fx.taskService.getAppendEligibility({ context: ctx, taskId: cancelled.task.taskId }).appendable, false);

    // 最后：合法追加仍可成功（拒绝是 fail-closed，不是把入口关死）
    const okAppend = fx.taskService.appendStep({ context: ctx, taskId: s.taskId, goal: "  合法追加  ", expectedRevision: revOf(fx, s.taskId) });
    assert.equal(okAppend.ok, true, JSON.stringify(okAppend));
    assert.equal(okAppend.step.input.goal, "合法追加", "goal 必须 trim 后写入");
    assert.equal(fx.taskStore.taskById(s.taskId).status, "RUNNING");
  } finally { await fx.close(); }
});

/* ============================================================ E 同步拒绝形状（appendStepCommand） */
test("D4-09 E · appendStepCommand 同步拒绝形状：非 owner / 过期 revision / 非 SUCCEEDED / 无产物 / 不安全，且 0 新增 0 改动", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const s = await succeededTask(fx);
    const orch = fx.makeToolOrchestrator();
    const pending = fx.createTask();
    const running = fx.createTask();
    const rStarted = fx.taskService.startTask({ context: s.ctx, taskId: running.task.taskId, expectedRevision: running.task.revision });
    fx.taskService.createStep({ context: s.ctx, taskId: running.task.taskId, kind: "reasoning", input: null, expectedRevision: rStarted.task.revision });
    const noArtifact = fx.createTask();
    const nStarted = fx.taskService.startTask({ context: s.ctx, taskId: noArtifact.task.taskId, expectedRevision: noArtifact.task.revision });
    fx.taskService.completeTask({ context: s.ctx, taskId: noArtifact.task.taskId, expectedRevision: nStarted.task.revision });

    const cases = [
      { name: "非 owner", ctx: { sessionRef: fx.f.sessions.alice, appId: "ai", source: "test" }, taskId: s.taskId, expectedRevision: revOf(fx, s.taskId), error: "TASK_FORBIDDEN", reason: undefined },
      { name: "过期 revision", ctx: s.ctx, taskId: s.taskId, expectedRevision: 999999, error: "TASK_REVISION_CONFLICT", reason: undefined },
      { name: "不存在", ctx: s.ctx, taskId: "task_missing", expectedRevision: 1, error: "TASK_NOT_FOUND", reason: undefined },
      { name: "非 SUCCEEDED", ctx: s.ctx, taskId: pending.task.taskId, expectedRevision: pending.task.revision, error: "APPEND_NOT_ALLOWED", reason: "APPEND_NOT_SUCCEEDED" },
      { name: "无产物", ctx: s.ctx, taskId: noArtifact.task.taskId, expectedRevision: revOf(fx, noArtifact.task.taskId), error: "APPEND_NOT_ALLOWED", reason: "APPEND_NO_ARTIFACT" },
      { name: "不安全（在途 step）", ctx: s.ctx, taskId: running.task.taskId, expectedRevision: revOf(fx, running.task.taskId), error: "APPEND_NOT_ALLOWED", reason: "APPEND_IN_FLIGHT" },
    ];
    for (const c of cases) {
      const beforeTask = fx.taskStore.taskById(c.taskId);
      const before = { rows: rowsOf(fx, c.taskId), rev: beforeTask ? beforeTask.revision : null, status: beforeTask ? beforeTask.status : null, runs: fx.taskStore.harnessRunsOfTask(c.taskId).length, steps: fx.taskStore.stepsOfTask(c.taskId).length };
      const cmd = orch.appendStepCommand({ context: c.ctx, taskId: c.taskId, goal: "下一步", expectedRevision: c.expectedRevision });
      assert.equal(cmd.ok, false, c.name + " 必须同步拒绝：" + JSON.stringify(cmd));
      assert.equal(cmd.error, c.error, c.name + "：" + JSON.stringify(cmd));
      if (c.reason) assert.equal(cmd.reason, c.reason, c.name + "：" + JSON.stringify(cmd));
      assert.equal("running" in cmd, false, c.name + " 拒绝不得携带 running");
      const afterTask = fx.taskStore.taskById(c.taskId);
      assert.equal(afterTask ? afterTask.revision : null, before.rev, c.name + " 不得改 revision");
      assert.equal(afterTask ? afterTask.status : null, before.status, c.name + " 不得改状态");
      assert.equal(fx.taskStore.harnessRunsOfTask(c.taskId).length, before.runs, c.name + " 不得新增 run");
      assert.equal(fx.taskStore.stepsOfTask(c.taskId).length, before.steps, c.name + " 不得新增 step");
      assert.ok(sameRows(before.rows, rowsOf(fx, c.taskId)), c.name + " 不得修改任何旧行");
    }

    // 接收 → 同步形状 + 异步运行（running 是唯一异步面）
    const cmd = orch.appendStepCommand({ context: s.ctx, taskId: s.taskId, goal: "接收后异步运行", expectedRevision: revOf(fx, s.taskId), verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(cmd.ok, true, JSON.stringify(cmd));
    assert.equal(cmd.task.status, "RUNNING");
    assert.equal(cmd.step.status, "PENDING");
    assert.equal(typeof cmd.running.then, "function");
    assert.equal(fx.taskStore.stepsOfTask(s.taskId).length, 2);
    const settled = await cmd.running;
    assert.equal(typeof settled.ok, "boolean");
    assert.equal(fx.taskStore.stepsOfTask(s.taskId).length, 2, "接收后异步运行不得再新增 step");
  } finally { await fx.close(); }
});

/* ============================================================ K IPC（同步拒绝 + 异步运行 + task/get 追加投影） */
test("D4-09 K · IPC task/appendStep：拒绝同步返回、接收后立即返回并由 task/result 收敛；task/get 回 appendable/appendReason", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const s = await succeededTask(fx);
    const install = (identity, orchestrator) => {
      const handlers = new Map();
      const events = [];
      registerTaskIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, taskService: fx.taskService, orchestrator, identity, send: (ev) => events.push(ev), hostAppId: "ai" });
      return { command: handlers.get("task:command"), events };
    };
    const owner = install({ current: fx.f.sessions.admin }, s.orch);
    const stranger = install({ current: fx.f.sessions.alice }, s.orch);

    const got = await owner.command({}, { type: "task/get", taskId: s.taskId });
    assert.equal(got.ok, true);
    assert.equal(got.appendable, true, "SUCCEEDED + artifact 必须可追加");
    assert.equal(got.appendReason, null);

    // 非 owner：同步 TASK_FORBIDDEN（绝不先接收再异步回传失败）
    const deniedRows = rowsOf(fx, s.taskId);
    const denied = await stranger.command({}, { type: "task/appendStep", taskId: s.taskId, goal: "下一步", expectedRevision: got.task.revision });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "TASK_FORBIDDEN", JSON.stringify(denied));
    assert.ok(sameRows(deniedRows, rowsOf(fx, s.taskId)), "IPC 拒绝不得改任何行");
    // 过期 revision 同样同步拒绝
    const stale = await owner.command({}, { type: "task/appendStep", taskId: s.taskId, goal: "下一步", expectedRevision: 999999 });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "TASK_REVISION_CONFLICT", JSON.stringify(stale));
    // 空 goal 同步 INVALID_INPUT
    assert.equal((await owner.command({}, { type: "task/appendStep", taskId: s.taskId, goal: "   ", expectedRevision: got.task.revision })).error, "INVALID_INPUT");

    // 接收：缺省 expectedRevision 时用权威 revision；立即返回 RUNNING，整链结果经 task/result 推送
    fx.fp.state.toolLoopPlan = [];
    const dsh = fx.makeDshOrchestrator();
    const ipc = install({ current: fx.f.sessions.admin }, dsh);
    const accepted = await ipc.command({}, { type: "task/appendStep", taskId: s.taskId, goal: "下一步：继续处理" });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(accepted.taskId, s.taskId);
    assert.equal(accepted.status, "RUNNING");
    assert.equal(fx.taskStore.stepsOfTask(s.taskId).length, 2, "接收即已新增 step");
    await waitFor(() => ipc.events.some((e) => e.type === "task/result"), 60000, "task/result 未推送");
    const result = ipc.events.find((e) => e.type === "task/result");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(fx.taskStore.artifactsOfTask(s.taskId).length, 2);

    // 追加 run 收敛后：task/get 仍如实给出追加资格（旧行保留、可再次追加）
    const got2 = await owner.command({}, { type: "task/get", taskId: s.taskId });
    assert.equal(got2.ok, true);
    assert.equal(got2.appendable, true);
    assert.equal(got2.steps.length, 2);
    assert.equal(got2.steps[1].input.appended, true);
    assert.equal(got2.steps[1].input.goal, "下一步：继续处理");
  } finally { await fx.close(); }
});

/* ============================================================ F 幂等 / 并发 */
test("D4-09 F · 同一 revision 连续/并发追加只成功一次、只新增一个 step", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const a = await succeededTask(fx);
    const revA = revOf(fx, a.taskId);
    const first = a.orch.appendStepCommand({ context: a.ctx, taskId: a.taskId, goal: "追加一", expectedRevision: revA });
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = a.orch.appendStepCommand({ context: a.ctx, taskId: a.taskId, goal: "追加二", expectedRevision: revA });
    assert.equal(second.ok, false, "同一 revision 第二次必须被拒：" + JSON.stringify(second));
    assert.ok(["TASK_REVISION_CONFLICT", "APPEND_NOT_ALLOWED"].includes(second.error), JSON.stringify(second));
    await first.running;
    assert.equal(fx.taskStore.stepsOfTask(a.taskId).length, 2, "只新增一个 step");
    assert.equal(fx.taskStore.stepsOfTask(a.taskId).filter((x) => x.input && JSON.parse(x.input).appended === true).length, 1);

    // Promise.all 同一 revision 并发：恰好一个被接收
    const b = await succeededTask(fx);
    fx.fp.state.toolLoopPlan = [];
    const dsh = fx.makeDshOrchestrator();
    const revB = revOf(fx, b.taskId);
    const args = { context: b.ctx, taskId: b.taskId, expectedRevision: revB, verify: { type: "EXACT_TEXT", expected: DSH_FINAL } };
    const results = await Promise.all([dsh.appendStep({ ...args, goal: "并发一" }), dsh.appendStep({ ...args, goal: "并发二" })]);
    assert.equal(results.filter((r) => r.ok === true).length, 1, "恰好一次有效追加：" + JSON.stringify(results.map((r) => [r.ok, r.error])));
    assert.equal(fx.taskStore.stepsOfTask(b.taskId).length, 2, "并发只新增一个 step");
    assert.equal(fx.taskStore.harnessRunsOfTask(b.taskId).length, 2, "只产生一个有效运行");
  } finally { await fx.close(); }
});

/* ============================================================ G 待批准 */
test("D4-09 G · 遗留 AWAITING_APPROVAL 副作用 → APPEND_SIDE_EFFECT_PENDING，0 新增 step", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d409-g-"));
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), keepData: true,
    sideEffectRuntimeDir: path.join(root, "runtime"), sideEffectApprovalWaitMs: 60000, facadeWriteToolIds: ["resource.trash"],
  });
  try {
    const created = await fx.createResource("D409 Approval Target");
    const resourceRef = created.resource.resourceRef;
    fx.grantTool("ai", ["tool.resource.trash"]);
    assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);

    const run = fx.dshRunSetup();
    const planned = await fx.sideEffectRuntime.proposeWrite({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: "resource.trash", arguments: { resourceRef } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const callId = planned.approvalRequestId;
    assert.equal(fx.sideEffectStore.callById(callId).status, "AWAITING_APPROVAL");

    // 真实审批等待路径：step BLOCKED + task WAITING + run BLOCKED；call 保持未决。
    const waited = fx.taskService.waitForApproval({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, reason: "TOOL_APPROVAL_REQUIRED", expectedRevision: run.revision });
    assert.equal(waited.ok, true, JSON.stringify(waited));
    const runBlocked = fx.taskService.blockHarnessRun({ context: run.context, taskId: run.taskId, runId: run.runId, errorCode: "TOOL_APPROVAL_REQUIRED", stopReason: "approval_required", expectedRevision: waited.task.revision });
    assert.equal(runBlocked.ok, true, JSON.stringify(runBlocked));

    const elig = fx.taskService.getAppendEligibility({ context: run.context, taskId: run.taskId });
    assert.equal(elig.appendable, false);
    assert.equal(elig.reason, "APPEND_SIDE_EFFECT_PENDING", JSON.stringify(elig));
    assertAppendRejected(fx, { ctx: run.context, taskId: run.taskId, reason: "APPEND_SIDE_EFFECT_PENDING" });
    assert.equal(fx.sideEffectStore.callById(callId).status, "AWAITING_APPROVAL", "未决审批不得被追加动作改变");
    assert.equal(fx.taskStore.stepsOfTask(run.taskId).length, 1);
  } finally { await fx.close(); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/* ============================================================ H 遗留 active lease（真实 recovery 收敛） */
test("D4-09 H · LEASED 未 claim 遗留 active lease → APPEND_ACTIVE_LEASE，0 新增 step", async () => {
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", sideEffectApprovalWaitMs: 60000, facadeWriteToolIds: ["resource.trash"],
  });
  try {
    const created = await fx.createResource("D409 Lease Target");
    const resourceRef = created.resource.resourceRef;
    fx.grantTool("ai", ["tool.resource.trash"]);
    assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);

    // 真实 authority 路径：approve → acquireLease（call=LEASED + ACTIVE lease，holder=当前 runtime instance）。
    const run = fx.dshRunSetup();
    const planned = await fx.sideEffectRuntime.proposeWrite({ context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: "resource.trash", arguments: { resourceRef } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const callId = planned.approvalRequestId;
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: callId, decision: "APPROVE" }).ok, true);
    const lease = fx.sideEffectAuthority.acquireLease({ callId, holderId: "oase_1" });
    assert.equal(lease.ok, true, JSON.stringify(lease));
    assert.equal(fx.sideEffectStore.callById(callId).status, "LEASED");
    assert.equal(fx.sideEffectStore.activeLeases().filter((l) => l.callId === callId).length, 1);

    // production 两段 recovery：task/step/run 收敛为 BLOCKED，LEASED call 收敛为 BLOCKED；
    // 但当前 runtime 自己持有的 lease 不会被 EXPIRED（只有其它 instance 的 lease 才 EXPIRED）→ 遗留 active lease。
    const taskRecovery = fx.taskService.recoverRunning();
    assert.equal(taskRecovery.ok, true, JSON.stringify(taskRecovery));
    const rec = fx.sideEffectRuntime.recoverOnStartup();
    assert.ok(rec && Array.isArray(rec.expiredLeases), "recovery 必须执行");
    assert.equal(fx.taskStore.taskById(run.taskId).status, "BLOCKED");
    assert.equal(fx.sideEffectStore.callById(callId).status, "BLOCKED", JSON.stringify(fx.sideEffectStore.callById(callId)));
    assert.equal(fx.sideEffectStore.activeLeases().filter((l) => l.callId === callId).length, 1, "遗留 active lease 必须存在");
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "0 mutation");

    const elig = fx.taskService.getAppendEligibility({ context: run.context, taskId: run.taskId });
    assert.equal(elig.appendable, false, JSON.stringify(elig));
    assert.equal(elig.reason, "APPEND_ACTIVE_LEASE", JSON.stringify(elig));
    assertAppendRejected(fx, { ctx: run.context, taskId: run.taskId, reason: "APPEND_ACTIVE_LEASE" });
    // 同一遗留 lease 也必须继续阻断预算续接（既有守卫不被追加动作绕过）。
    assert.equal(fx.taskService.getResumeEligibility({ context: run.context, taskId: run.taskId }).reason, "RESUME_ACTIVE_LEASE");
  } finally { await fx.close(); }
});

/* ============================================================ I 真实 crash 遗留 UNKNOWN_EFFECT（R5 seam） */
test("D4-09 I · 真实 live-unlinked 崩溃遗留 UNKNOWN_EFFECT → APPEND_UNKNOWN_EFFECT，0 新增 step", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa4u9-"));
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const runtimeDir = path.join(root, "runtime");
  let fx = null; let box = null; let exited = null; let rt = null;
  try {
    fx = await createToolHarnessFixture({ withAdapters: true, dbPath, storeRoot, keepData: true, sideEffectRuntimeDir: runtimeDir, sideEffectApprovalWaitMs: 400 });
    const created = await fx.createResource("D409 Unknown Target");
    const resourceRef = created.resource.resourceRef;
    fx.grantTool("ai", ["tool.resource.trash"]);
    assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);
    const run = fx.dshRunSetup();
    const planned = await fx.sideEffectRuntime.proposeWrite({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: "resource.trash", arguments: { resourceRef } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
    const callId = planned.approvalRequestId;
    const adminSession = fx.f.sessions.admin;

    // 真实受监督 executor runtime：独占 lifetime socket，停在 mutation gate（永不放行）。
    const execId = "exe_a9" + Math.random().toString(36).slice(2, 7);
    const socketPath = path.join(runtimeDir, "executors", execId + ".sock");
    box = spawn(process.execPath, [GATED_EXECUTOR, JSON.stringify({ runtimeDir, dbPath, storeRoot, instanceId: execId, callId, holderId: "exec_1", timeoutMs: 120000, holdAfterMutation: true, now: fx.f.clock() })], { stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; let err = "";
    box.stdout.on("data", (d) => { out += d; });
    box.stderr.on("data", (d) => { err += d; });
    exited = new Promise((r) => box.on("exit", (c) => r(c)));
    await waitFor(() => RuntimeSupervisor.parseExecutorMessage(out, "ready"), 30000, "executor 未就绪：" + err);
    await waitFor(() => fx.sideEffectStore.callById(callId).status === "RUNNING", 30000, "claim 未提交");
    assert.equal(box.exitCode, null, "executor 必须仍然存活");
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false, "mutation 尚未发生");

    const recordPath = path.join(runtimeDir, "executors", execId + ".json");
    fs.mkdirSync(path.join(runtimeDir, "executors"), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify({ instanceId: execId, status: "ACTIVE", startedAt: 1, callId, holderId: "exec_1", endedAt: null, exitCode: null, signal: null, reason: null }));
    if (!fs.existsSync(socketPath)) assert.fail("executor lifetime socket 未出现（path len=" + socketPath.length + "）；out=" + out.slice(0, 200) + " err=" + err.slice(0, 200));
    fs.unlinkSync(socketPath);
    assert.equal(fs.existsSync(socketPath), false, "socket 已 unlink");
    assert.equal(box.exitCode, null, "unlink 不得杀死 executor");

    const fixedNow = fx.f.clock();
    await fx.close(); fx = null;
    rt = await reopenToolHarnessRuntime({ dbPath, storeRoot, runtimeDir, clock: () => fixedNow });
    const rec = rt.recover();
    assert.ok(rec && rec.sideEffect, "recovery 必须执行");
    assert.equal(rt.sideEffectStore.callById(callId).status, "UNKNOWN_EFFECT", JSON.stringify(rt.sideEffectStore.callById(callId)));
    assert.equal(rt.taskStore.taskById(run.taskId).status, "BLOCKED");

    const context = { sessionRef: adminSession, appId: "ai", source: "test" };
    const elig = rt.taskService.getAppendEligibility({ context, taskId: run.taskId });
    assert.equal(elig.appendable, false, JSON.stringify(elig));
    assert.equal(elig.reason, "APPEND_UNKNOWN_EFFECT", JSON.stringify(elig));
    const stepsBefore = rt.taskStore.stepsOfTask(run.taskId).length;
    const res = rt.taskService.appendStep({ context, taskId: run.taskId, goal: "下一步", expectedRevision: rt.taskStore.taskById(run.taskId).revision });
    assert.equal(res.ok, false);
    assert.equal(res.error, "APPEND_NOT_ALLOWED");
    assert.equal(res.reason, "APPEND_UNKNOWN_EFFECT", JSON.stringify(res));
    assert.equal(rt.taskStore.stepsOfTask(run.taskId).length, stepsBefore, "0 新增 step");
    assert.equal(grantEventsOf(rt, run.taskId).length, 0, "追加被拒绝不追加预算");
    // 非预算停止仍是 RESUME_NOT_BUDGET_STOP 之外的 UNKNOWN_EFFECT 拒绝（既有守卫不被追加动作绕过）。
    assert.equal(rt.taskService.getResumeEligibility({ context, taskId: run.taskId }).reason, "RESUME_UNKNOWN_EFFECT_PRESENT");
  } finally {
    try { if (box) box.kill("SIGKILL"); } catch { /* ignore */ }
    try { if (exited) await exited; } catch { /* ignore */ }
    try { if (rt) await rt.close(); } catch { /* ignore */ }
    try { if (fx) await fx.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/* ============================================================ J 无额度追加 → 显式续接 */
test("D4-09 J · 无额度追加：新 step BLOCKED/BUDGET_EXHAUSTED 且 0 空转 run → resumable → grantBudgetResume 后 run 成功", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", maxToolRounds: 1 });
  try {
    const s = await succeededTaskAfterOneRound(fx);
    const { ctx, taskId } = s;
    const before = fx.taskService.getTaskBudget({ context: ctx, taskId });
    assert.equal(before.kinds.TOOL_ROUNDS.consumed, 1);
    assert.equal(before.kinds.TOOL_ROUNDS.remaining, 0, "初次成功后 TOOL_ROUNDS 已用尽");
    const runsBefore = fx.taskStore.harnessRunsOfTask(taskId).length;
    assert.equal(runsBefore, 1);

    const appended = await s.orch.appendStep({ context: ctx, taskId, goal: "下一步：继续处理", expectedRevision: revOf(fx, taskId), verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(appended.ok, false);
    assert.equal(appended.error, "BUDGET_EXHAUSTED", JSON.stringify(appended));
    assert.equal(fx.taskStore.harnessRunsOfTask(taskId).length, runsBefore, "remaining==0 时绝不创建空转 run");
    const steps = fx.taskStore.stepsOfTask(taskId);
    assert.equal(steps.length, 2, "只新增一个 step");
    assert.equal(steps[1].status, "BLOCKED");
    const stops = budgetStopEventsOf(fx, taskId);
    assert.equal(stops.length, 1);
    const stopPayload = JSON.parse(stops[0].safe_payload);
    assert.equal(stopPayload.kind, "TOOL_ROUNDS");
    assert.equal(stopPayload.stepId, steps[1].step_id, "预算停止事件必须归属新 step");
    assert.equal(fx.taskStore.taskById(taskId).status, "BLOCKED");

    // 真实 artifact 使预算停止可被显式续接（no-run 场景也必须给出入口）
    const elig = fx.taskService.getResumeEligibility({ context: ctx, taskId });
    assert.equal(elig.resumable, true, JSON.stringify(elig));
    assert.equal(elig.reason, null);
    assert.equal(elig.kind, "TOOL_ROUNDS", "kind 必须是真实阻塞 kind");
    assert.equal(elig.stopReason, "BUDGET_EXHAUSTED");
    assert.equal(elig.fromStepId, steps[1].step_id);

    // 既有 grantBudgetResume 仍可用；陈旧 revision（resume 之前）追加必须被拒
    const preResumeRevision = revOf(fx, taskId);
    const granted = fx.taskService.grantBudgetResume({ context: ctx, taskId, expectedRevision: preResumeRevision, kind: elig.kind });
    assert.equal(granted.ok, true, JSON.stringify(granted));
    assert.equal(granted.amount, 1, "追加量 == 该类实际生效额度");
    assert.equal(grantEventsOf(fx, taskId).length, 1);
    const stepsAfterGrant = fx.taskStore.stepsOfTask(taskId).length;
    assert.equal(stepsAfterGrant, 3);
    const stale = fx.taskService.appendStep({ context: ctx, taskId, goal: "陈旧追加", expectedRevision: preResumeRevision });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, "TASK_REVISION_CONFLICT", JSON.stringify(stale));
    assert.equal(fx.taskStore.stepsOfTask(taskId).length, stepsAfterGrant, "陈旧 revision 追加不得新增 step");
    assert.equal(fx.taskService.getTaskBudget({ context: ctx, taskId }).kinds.TOOL_ROUNDS.remaining, 1);

    // 后续 run 成功收敛（新 run 只拿 remaining=1）
    const started = fx.taskService.startStep({ context: ctx, taskId, stepId: granted.step.stepId, expectedRevision: granted.task.revision });
    assert.equal(started.ok, true, JSON.stringify(started));
    const run = await s.orch.runStep({ context: ctx, taskId, stepId: granted.step.stepId, expectedRevision: started.task.revision, stepInput: granted.step.input, verify: { type: "EXACT_TEXT", expected: SYNTH_FINAL } });
    assert.equal(run.ok, true, "续接后的 run 必须成功：" + JSON.stringify(run.error));
    assert.equal(fx.taskStore.taskById(taskId).status, "SUCCEEDED");
    assert.equal(fx.taskStore.artifactsOfTask(taskId).length, 2, "首次成功产物 + 续接产物");
    assert.equal(fx.taskStore.harnessRunsOfTask(taskId).length, 2, "续接恰好一个新 run");
    // 续接 run 未发起任何 tool 调用 → 不消耗轮次，只保留追加量。
    assert.equal(fx.taskService.getTaskBudget({ context: ctx, taskId }).kinds.TOOL_ROUNDS.remaining, 1);
  } finally { await fx.close(); }
});
