/**
 * D4-05 · S1（A33 产物不符）· 关联修复——按「操作对象 + 验证要求」而非裸 tool_id 判定未解决。
 *
 * 真实链路（无 synthetic ACP agent / 无 dshArgs）：
 *   TaskHarnessOrchestrator → HarnessAdapter(official dsh) → ACP → 受控 plugin
 *   → ToolFacadeBridge → ControlledToolProxy.executeReadOnly（dsh 进程内）
 *   → registry.validateOutput / adapter.verify 如实落 tool_executions + task_verifications
 *   → TaskService.getUnresolvedRequiredVerificationFailures 以 (tool_id, arguments_hash) 关联，
 *     orchestrator 拒绝「对象 A 验证失败未解决但对象 B 的无关 PASS 把它误清除」的假成功。
 *
 * 最终态永远由真实产品 orchestrator / 产品 ToolProxy 决定；本文件不手工设置 Task/Step 终态、
 * 不直写 DB、不新增任何恢复能力。test-only 工具 test.sized / test.broken 只在本测试内注册。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createToolHarnessFixture, reopenToolHarnessRuntime } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { TaskService } = require("../electron/task-service.cjs");

const FINAL = "OPENARC_DSH_TOOL_OK";

/** test-only A33 尺寸探针：tool contract + adapter 只在测试内注册。sizes 按调用顺序消费。 */
function installSizedProbe(fx, { sizes = [7] } = {}) {
  fx.toolRegistry.register({
    toolId: "test.sized",
    version: 1,
    displayName: "Test Sized Output (D4-05 A33 facade association probe)",
    description: "测试专用：产出声明 size，由 adapter.verify 校验期望尺寸；绝不在生产 profile 注册。",
    inputSchema: { type: "object", additionalProperties: false, properties: { expectedSize: { type: "integer", minimum: 0 }, label: { type: "string", minLength: 1, maxLength: 100 } }, required: ["expectedSize"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, size: { type: "integer" } }, required: ["size"] },
    riskClass: "READ_ONLY",
    executionProvider: "testSized",
    enabled: true,
    expectedSideEffects: ["no side effect"],
    requiredPermissions: [],
    resourceActions: [],
  });
  const state = { calls: 0, results: [] };
  fx.adapters.providers.testSized = {
    toolIds: ["test.sized"],
    async prepare() { return { plan: { provider: "testSized" } }; },
    async execute({ args }) {
      state.calls += 1;
      const size = sizes[Math.min(state.calls - 1, sizes.length - 1)];
      const result = { label: String(args.label || "box"), size: Number(size) };
      state.results.push(result);
      // 关键：execute 报告成功；尺寸由 verify 独立核对。
      return { ok: true, result };
    },
    async verify({ args, result }) {
      const ok = !!(result && Number(result.size) === Number(args.expectedSize));
      return { ok, applied: ok, detail: { expectedSize: Number(args.expectedSize), actualSize: result && result.size } };
    },
  };
  return state;
}

/** test-only 普通执行错误探针：execute 直接返回 ok:false，无验证结论。 */
function installBrokenProbe(fx) {
  fx.toolRegistry.register({
    toolId: "test.broken",
    version: 1,
    displayName: "Test Broken Output (D4-05 A33 facade association probe)",
    description: "测试专用：仅返回执行错误，用于证明普通工具调用错误不参与解决判定。",
    inputSchema: { type: "object", additionalProperties: false, properties: { tag: { type: "string", minLength: 1, maxLength: 50 } }, required: ["tag"] },
    outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
    riskClass: "READ_ONLY",
    executionProvider: "testBroken",
    enabled: true,
    expectedSideEffects: ["no side effect"],
    requiredPermissions: [],
    resourceActions: [],
  });
  const state = { calls: 0 };
  fx.adapters.providers.testBroken = {
    toolIds: ["test.broken"],
    async prepare() { return { plan: { provider: "testBroken" } }; },
    async execute() { state.calls += 1; return { ok: false, error: "TOOL_EXECUTION_FAILED" }; },
  };
  return state;
}

/** 用 deterministic model plan 驱动 official dsh，跑完整产品 orchestrator + 真实验证链。 */
async function runFacade(fx, plan) {
  fx.fp.state.toolLoopPlan = plan;
  const ctx = fx.ctx();
  const t = fx.createTask();
  const orch = fx.makeDshOrchestrator();
  const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: FINAL } });
  const taskId = t.task.taskId;
  return {
    r, ctx, taskId,
    task: fx.taskStore.taskById(taskId),
    steps: fx.taskStore.stepsOfTask(taskId),
    execs: fx.toolStore.executionsOfTask(taskId),
    proposals: fx.toolStore.proposalsOfTask(taskId),
    events: fx.taskStore.eventsOfTask(taskId).map((e) => e.event_type),
    artifacts: fx.taskStore.artifactsOfTask(taskId),
    verifications: fx.taskStore.verificationsOfTask(taskId),
    modelRequests: fx.fp.state.requests,
  };
}

/** 关联判定投影（真实只读后端契约）。 */
function association(fx, context, taskId) {
  const res = fx.taskService.getUnresolvedRequiredVerificationFailures({ context, taskId });
  assert.equal(res.ok, true, "association projection 必须 ok：" + JSON.stringify(res));
  return res;
}

test("D4-05 S1 A33 关联 · 无关对象：A FAIL 后同工具同步的 B PASS 绝不误清除 A → BLOCKED / 0 Artifact", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeToolIds: ["test.sized"] });
  try {
    // 同一工具、同一步：A 产物尺寸不符（FAIL），B 尺寸符合（PASS）。修复前 B 的 PASS 会误清除 A。
    const state = installSizedProbe(fx, { sizes: [7, 10] });
    const out = await runFacade(fx, [
      { name: "test_sized", args: { expectedSize: 10, label: "A" } },
      { name: "test_sized", args: { expectedSize: 10, label: "B" } },
    ]);

    assert.equal(state.calls, 2, "两次真实 execution（无自动重试）");
    assert.deepEqual(state.results, [{ label: "A", size: 7 }, { label: "B", size: 10 }]);
    assert.ok(out.modelRequests >= 3, "provider 发出了两次 tool 调用与 final：" + out.modelRequests);

    assert.equal(out.r.ok, false, "A 未解决时任务不得成功");
    assert.equal(out.r.error, "TOOL_VERIFICATION_FAILED", "停因 = TOOL_VERIFICATION_FAILED：" + out.r.error);
    assert.equal(out.task.status, "BLOCKED", "Task 必须 BLOCKED：" + out.task.status);
    assert.equal(out.steps[0].status, "BLOCKED", "Step 必须 BLOCKED：" + out.steps[0].status);
    assert.equal(out.artifacts.length, 0, "A 未解决 → 0 Artifact");

    assert.equal(out.execs.length, 2, "2 次 execution：" + out.execs.length);
    const [failExec, passExec] = out.execs;
    assert.equal(failExec.status, "FAILED");
    assert.equal(failExec.verification_status, "FAIL");
    assert.equal(failExec.error_code, "TOOL_VERIFICATION_FAILED");
    assert.equal(passExec.status, "SUCCEEDED");
    assert.equal(passExec.verification_status, "PASS");
    assert.equal(failExec.tool_id, passExec.tool_id, "同一 tool_id");
    assert.notEqual(failExec.execution_id, passExec.execution_id);

    // 关联键来自 proposal.arguments_hash，A/B 不同对象 → 不同 hash。
    const propByHash = new Map(out.proposals.map((p) => [p.proposal_id, p]));
    const argsHashA = propByHash.get(failExec.proposal_id).arguments_hash;
    const argsHashB = propByHash.get(passExec.proposal_id).arguments_hash;
    assert.ok(argsHashA && argsHashB, "两次 proposal 都有 canonical arguments_hash");
    assert.notEqual(argsHashA, argsHashB, "不同对象 canonical arguments 不同 → hash 不同");

    const assoc = association(fx, out.ctx, out.taskId);
    assert.equal(assoc.unresolved.length, 1, "只有 A 未解决：" + JSON.stringify(assoc.unresolved));
    assert.equal(assoc.unresolved[0].toolId, "test.sized");
    assert.equal(assoc.unresolved[0].executionId, failExec.execution_id, "未解决指向 A 的 execution");
    assert.equal(assoc.unresolved[0].errorCode, "TOOL_VERIFICATION_FAILED");
    assert.equal(assoc.unresolved[0].method, "ADAPTER_VERIFY");
    assert.equal(assoc.unresolved[0].argsHash, argsHashA);
    assert.equal(assoc.unresolved[0].linked, true);
    assert.equal(assoc.unresolved[0].stepId, out.steps[0].step_id);
    assert.equal(assoc.unresolved[0].runId, failExec.run_id);
    assert.equal(assoc.resolved.length, 0, "B 的 PASS 没有解决任何 FAIL：" + JSON.stringify(assoc.resolved));
    assert.ok(!assoc.resolved.some((r) => r.failedExecutionId === failExec.execution_id), "A 不得出现在 resolved");

    // A 的 FAIL Verification 仍在（旧记录绝不删除）。
    const failVers = out.verifications.filter((v) => v.status === "FAIL" && v.type === "ADAPTER_VERIFY");
    assert.equal(failVers.length, 1, "A 的 FAIL Verification 仍在");
    assert.equal(failVers[0].execution_id, failExec.execution_id);
    assert.equal(failVers[0].artifact_id, null);

    assert.ok(out.events.includes("tool.verification.failed"), "事件含 tool.verification.failed：" + JSON.stringify(out.events));
    assert.ok(!out.events.includes("task.succeeded"), "绝不 task.succeeded");
    assert.ok(!out.events.includes("artifact.created"), "绝不 artifact.created");
    assert.equal(TaskService.policy.autoRetry, 0, "AUTO_RETRY 必须为 0");
  } finally { await fx.close(); }
});

test("D4-05 S1 A33 关联 · 同一对象不同验证要求：size-10 FAIL 不被 size-7 的 PASS 清除 → BLOCKED", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeToolIds: ["test.sized"] });
  try {
    // 同一 label=A，但验证要求不同：expectedSize=10 先 FAIL，expectedSize=7 后 PASS。
    const state = installSizedProbe(fx, { sizes: [7, 7] });
    const out = await runFacade(fx, [
      { name: "test_sized", args: { expectedSize: 10, label: "A" } },
      { name: "test_sized", args: { expectedSize: 7, label: "A" } },
    ]);

    assert.equal(state.calls, 2);
    assert.deepEqual(state.results, [{ label: "A", size: 7 }, { label: "A", size: 7 }]);

    assert.equal(out.r.ok, false, "要求不同的 PASS 不得清除 size-10 的 FAIL");
    assert.equal(out.r.error, "TOOL_VERIFICATION_FAILED");
    assert.equal(out.task.status, "BLOCKED");
    assert.equal(out.steps[0].status, "BLOCKED");
    assert.equal(out.artifacts.length, 0);

    assert.equal(out.execs.length, 2);
    const [failExec, passExec] = out.execs;
    assert.equal(failExec.status, "FAILED");
    assert.equal(failExec.verification_status, "FAIL");
    assert.equal(passExec.status, "SUCCEEDED");
    assert.equal(passExec.verification_status, "PASS");

    const propByHash = new Map(out.proposals.map((p) => [p.proposal_id, p]));
    const argsHashFail = propByHash.get(failExec.proposal_id).arguments_hash;
    const argsHashPass = propByHash.get(passExec.proposal_id).arguments_hash;
    assert.notEqual(argsHashFail, argsHashPass, "expectedSize 不同 → canonical hash 不同");

    const assoc = association(fx, out.ctx, out.taskId);
    assert.equal(assoc.unresolved.length, 1, "size-10 的 FAIL 仍未解决：" + JSON.stringify(assoc.unresolved));
    assert.equal(assoc.unresolved[0].executionId, failExec.execution_id);
    assert.equal(assoc.unresolved[0].argsHash, argsHashFail);
    assert.equal(assoc.resolved.length, 0);

    const failVers = out.verifications.filter((v) => v.status === "FAIL");
    assert.equal(failVers.length, 1, "size-10 的 FAIL Verification 仍在");
    assert.equal(failVers[0].execution_id, failExec.execution_id);
    assert.ok(out.events.includes("tool.verification.failed"));
    assert.ok(!out.events.includes("task.succeeded"));
    assert.ok(!out.events.includes("artifact.created"));
  } finally { await fx.close(); }
});

test("D4-05 S1 A33 关联 · 跨 Step：step1 的 A FAIL 不被 step2 无关 B 的 PASS 清除 → step2 也 BLOCKED", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeToolIds: ["test.sized"] });
  try {
    // 说明（如实）：产品没有跨 step 的「纠错 / 恢复」入口——orchestrator 在首个未解决 FAIL 后会 BLOCK task，
    // 因此无法用 orchestrator 产生 step1 的 FAIL 再继续 step2。这里 step1 的 FAIL 用真实产品
    // ControlledToolProxy.propose + executeReadOnly（真实 registry/adapter/verify 链）直接产生；
    // 未为覆盖测试新增任何恢复能力，也不手工设置终态。step2 仍由真实 official dsh orchestrator 收敛。
    const state = installSizedProbe(fx, { sizes: [7, 10] });
    const ctx = fx.ctx();
    const t = fx.createTask();
    const taskId = t.task.taskId;

    const started = fx.taskService.startTask({ context: ctx, taskId, expectedRevision: t.task.revision });
    assert.equal(started.ok, true, JSON.stringify(started));
    const step1 = fx.taskService.createStep({ context: ctx, taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    assert.equal(step1.ok, true, JSON.stringify(step1));
    const step1Started = fx.taskService.startStep({ context: ctx, taskId, stepId: step1.step.stepId, expectedRevision: step1.task.revision });
    assert.equal(step1Started.ok, true, JSON.stringify(step1Started));

    // step1：产品 proxy 对对象 A 产生真实 FAIL（runId 省略 → 不占用 step2 的 run/预算账本基线）。
    const propA = fx.toolProxy.propose({ context: ctx, taskId, stepId: step1.step.stepId, toolId: "test.sized", toolVersion: 1, arguments: { expectedSize: 10, label: "A" } });
    assert.equal(propA.ok, true, JSON.stringify(propA));
    assert.equal(propA.decisionStatus, "ALLOWED", "READ_ONLY 探针应被允许");
    const execA = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, stepId: step1.step.stepId, proposalId: propA.proposal.proposalId });
    assert.equal(execA.ok, false, "A 必须真实 FAIL");
    assert.equal(execA.executionStatus, "FAILED");
    assert.equal(execA.verificationStatus, "FAIL");
    assert.equal(execA.error, "TOOL_VERIFICATION_FAILED");
    assert.equal(state.calls, 1, "step1 真实执行 1 次");

    const afterStep1 = fx.taskService.getTask({ context: ctx, taskId });
    assert.equal(afterStep1.task.status, "RUNNING", "产品 proxy 不改变 Task 终态（step1 FAIL 仍未解决）");

    // step2：真实 official dsh 对无关对象 B → final；应因 step1 的 A 未解决而 BLOCKED。
    const step2 = fx.taskService.createStep({ context: ctx, taskId, kind: "reasoning", input: null, expectedRevision: afterStep1.task.revision });
    assert.equal(step2.ok, true, JSON.stringify(step2));
    const step2Started = fx.taskService.startStep({ context: ctx, taskId, stepId: step2.step.stepId, expectedRevision: step2.task.revision });
    assert.equal(step2Started.ok, true, JSON.stringify(step2Started));

    fx.fp.state.toolLoopPlan = [{ name: "test_sized", args: { expectedSize: 10, label: "B" } }];
    const orch = fx.makeDshOrchestrator();
    const out = await orch.runStep({ context: ctx, taskId, stepId: step2.step.stepId, expectedRevision: step2Started.task.revision, verify: { type: "EXACT_TEXT", expected: FINAL } });

    assert.equal(state.calls, 2, "step2 真实执行 B 1 次");
    assert.equal(out.ok, false, "step2 不得成功");
    assert.equal(out.error, "TOOL_VERIFICATION_FAILED", "停因 = TOOL_VERIFICATION_FAILED：" + out.error);

    const task = fx.taskStore.taskById(taskId);
    const steps = fx.taskStore.stepsOfTask(taskId);
    const step2Row = steps.find((s) => s.step_id === step2.step.stepId);
    assert.equal(task.status, "BLOCKED", "Task 必须 BLOCKED");
    assert.equal(step2Row.status, "BLOCKED", "step2 必须 BLOCKED（旧 tool_id-only 逻辑会清除 A 而 SUCCEEDED）");

    const execs = fx.toolStore.executionsOfTask(taskId);
    assert.equal(execs.length, 2, "step1 的 A + step2 的 B");
    const execB = execs.find((e) => e.step_id === step2.step.stepId);
    assert.equal(execB.status, "SUCCEEDED");
    assert.equal(execB.verification_status, "PASS");

    const assoc = association(fx, ctx, taskId);
    assert.equal(assoc.unresolved.length, 1, "step1 的 A 仍未解决：" + JSON.stringify(assoc.unresolved));
    assert.equal(assoc.unresolved[0].executionId, execA.execution.executionId);
    assert.equal(assoc.unresolved[0].stepId, step1.step.stepId);
    assert.equal(assoc.resolved.length, 0, "B 的 PASS 没有解决 A：" + JSON.stringify(assoc.resolved));

    assert.equal(fx.taskStore.artifactsOfTask(taskId).length, 0, "无 Artifact");
    const events = fx.taskStore.eventsOfTask(taskId).map((e) => e.event_type);
    assert.ok(!events.includes("task.succeeded"));
    assert.ok(!events.includes("artifact.created"));
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});

test("D4-05 S1 A33 关联 · 有效纠错：同对象同要求 FAIL 后再真实 PASS → SUCCEEDED + resolved 关联", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeToolIds: ["test.sized"] });
  try {
    const state = installSizedProbe(fx, { sizes: [7, 10] });
    const out = await runFacade(fx, [
      { name: "test_sized", args: { expectedSize: 10, label: "A" } },
      { name: "test_sized", args: { expectedSize: 10, label: "A" } },
    ]);

    assert.equal(state.calls, 2, "真实复验 2 次（非自动重试）");
    assert.deepEqual(state.results, [{ label: "A", size: 7 }, { label: "A", size: 10 }]);

    assert.equal(out.r.ok, true, "同对象同要求真实 PASS 后必须成功：" + JSON.stringify(out.r.error));
    assert.equal(out.task.status, "SUCCEEDED");
    assert.equal(out.steps[0].status, "SUCCEEDED");
    assert.equal(out.artifacts.length, 1, "恰好 1 个 Artifact");
    assert.equal(out.execs.length, 2);

    const [failExec, passExec] = out.execs;
    assert.equal(failExec.status, "FAILED");
    assert.equal(failExec.verification_status, "FAIL");
    assert.equal(passExec.status, "SUCCEEDED");
    assert.equal(passExec.verification_status, "PASS");

    const propByHash = new Map(out.proposals.map((p) => [p.proposal_id, p]));
    const argsHash = propByHash.get(failExec.proposal_id).arguments_hash;
    assert.equal(propByHash.get(passExec.proposal_id).arguments_hash, argsHash, "同对象同要求 → 同 canonical hash");

    const assoc = association(fx, out.ctx, out.taskId);
    assert.equal(assoc.unresolved.length, 0, "已解决 → 无 unresolved：" + JSON.stringify(assoc.unresolved));
    assert.equal(assoc.resolved.length, 1, "resolved 关联可追溯：" + JSON.stringify(assoc.resolved));
    assert.equal(assoc.resolved[0].toolId, "test.sized");
    assert.equal(assoc.resolved[0].argsHash, argsHash);
    assert.equal(assoc.resolved[0].failedExecutionId, failExec.execution_id);
    assert.equal(assoc.resolved[0].resolvedByExecutionId, passExec.execution_id);
    assert.equal(assoc.resolved[0].method, "ADAPTER_VERIFY");

    // 旧 FAIL Verification 仍在，PASS 绑定 Artifact。
    const failVers = out.verifications.filter((v) => v.status === "FAIL");
    assert.equal(failVers.length, 1, "旧 FAIL Verification 仍在");
    assert.equal(failVers[0].execution_id, failExec.execution_id);
    const passVers = out.verifications.filter((v) => v.status === "PASS");
    assert.equal(passVers.length, 1, "1 条 PASS Verification");
    assert.equal(passVers[0].artifact_id, out.artifacts[0].artifact_id);
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});

test("D4-05 S1 A33 关联 · 普通工具错误语义不变：execute ok:false（无验证结论）→ 仍 SUCCEEDED", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeToolIds: ["test.broken"] });
  try {
    const state = installBrokenProbe(fx);
    const out = await runFacade(fx, [{ name: "test_broken", args: { tag: "boom" } }]);

    assert.equal(state.calls, 1);
    assert.ok(out.modelRequests >= 2, "provider 确实发出了 final：" + out.modelRequests);
    assert.equal(out.execs.length, 1, "恰好 1 次 execution");
    assert.equal(out.execs[0].status, "FAILED");
    assert.equal(out.execs[0].verification_status == null || out.execs[0].verification_status === "", true, "普通执行错误无验证结论：" + out.execs[0].verification_status);

    const assoc = association(fx, out.ctx, out.taskId);
    assert.equal(assoc.unresolved.length, 0, "验证结论为空不参与判定：" + JSON.stringify(assoc.unresolved));
    assert.equal(assoc.resolved.length, 0);

    assert.equal(out.r.ok, true, "facade 既有语义：普通工具调用错误不整体失败：" + JSON.stringify(out.r.error));
    assert.equal(out.task.status, "SUCCEEDED");
    assert.equal(out.artifacts.length, 1);
    assert.ok(!out.verifications.some((v) => v.status === "FAIL" && (v.type === "OUTPUT_SCHEMA" || v.type === "ADAPTER_VERIFY")));
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});

test("D4-05 S1 A33 关联 · DB 重开一致性：未解决仍 BLOCKED/含 A，有效纠错 resolved 关系仍可查", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa5s1-assoc-"));
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const runtimeDir = path.join(root, "rt");
  let fx = null; let rt = null;
  try {
    fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeToolIds: ["test.sized"], dbPath, storeRoot, keepData: true, sideEffectRuntimeDir: runtimeDir });
    // sizes 按调用顺序消费：task1 A=7 FAIL / B=10 PASS；task2 A=7 FAIL / A=10 PASS。
    installSizedProbe(fx, { sizes: [7, 10, 7, 10] });

    // 未解决场景（无关对象）：A FAIL + B PASS → BLOCKED。
    const blockedOut = await runFacade(fx, [
      { name: "test_sized", args: { expectedSize: 10, label: "A" } },
      { name: "test_sized", args: { expectedSize: 10, label: "B" } },
    ]);
    assert.equal(blockedOut.task.status, "BLOCKED");
    const blockedTaskId = blockedOut.taskId;
    const blockedCtx = blockedOut.ctx;
    const failA = blockedOut.execs.find((e) => e.verification_status === "FAIL");
    assert.ok(failA, "存在 A 的 FAIL execution");

    // 有效纠错场景：同对象同要求 FAIL 后 PASS → SUCCEEDED，记录 resolved 关系。
    const resolvedOut = await runFacade(fx, [
      { name: "test_sized", args: { expectedSize: 10, label: "A" } },
      { name: "test_sized", args: { expectedSize: 10, label: "A" } },
    ]);
    assert.equal(resolvedOut.task.status, "SUCCEEDED");
    const resolvedTaskId = resolvedOut.taskId;
    const resolvedCtx = resolvedOut.ctx;

    const fixtureClock = fx.f.clock;
    await fx.close(); fx = null;
    // 重开必须沿用同一可控时钟，否则注入时钟下的 session 相对真实 wall clock 已过期（非本修复范围）。
    rt = await reopenToolHarnessRuntime({ dbPath, storeRoot, runtimeDir, clock: fixtureClock });
    rt.recover();

    // 未解决：重开后 Task 仍 BLOCKED、unresolved 仍含 A。
    assert.equal(rt.taskStore.taskById(blockedTaskId).status, "BLOCKED", "重开后 Task 仍 BLOCKED");
    const blockedAssoc = rt.taskService.getUnresolvedRequiredVerificationFailures({ context: blockedCtx, taskId: blockedTaskId });
    assert.equal(blockedAssoc.ok, true, JSON.stringify(blockedAssoc));
    assert.equal(blockedAssoc.unresolved.length, 1, "重开后 A 仍未解决：" + JSON.stringify(blockedAssoc.unresolved));
    assert.equal(blockedAssoc.unresolved[0].executionId, failA.execution_id);
    assert.equal(blockedAssoc.unresolved[0].toolId, "test.sized");
    assert.equal(blockedAssoc.unresolved[0].method, "ADAPTER_VERIFY");
    assert.equal(blockedAssoc.resolved.length, 0);
    assert.equal(rt.taskStore.artifactsOfTask(blockedTaskId).length, 0, "重开后仍 0 Artifact");

    // 有效纠错：重开后 resolved 关联仍可查、原始 FAIL Verification 仍在。
    const resolvedAssoc = rt.taskService.getUnresolvedRequiredVerificationFailures({ context: resolvedCtx, taskId: resolvedTaskId });
    assert.equal(resolvedAssoc.ok, true, JSON.stringify(resolvedAssoc));
    assert.equal(resolvedAssoc.unresolved.length, 0);
    assert.equal(resolvedAssoc.resolved.length, 1, "重开后 resolved 关系仍在：" + JSON.stringify(resolvedAssoc.resolved));
    const resolvedFailExec = resolvedOut.execs.find((e) => e.verification_status === "FAIL");
    const resolvedPassExec = resolvedOut.execs.find((e) => e.verification_status === "PASS");
    assert.equal(resolvedAssoc.resolved[0].failedExecutionId, resolvedFailExec.execution_id);
    assert.equal(resolvedAssoc.resolved[0].resolvedByExecutionId, resolvedPassExec.execution_id);
    const reopenedVers = rt.taskStore.verificationsOfTask(resolvedTaskId).filter((v) => v.status === "FAIL");
    assert.equal(reopenedVers.length, 1, "重开后旧 FAIL Verification 仍在");
    assert.equal(reopenedVers[0].execution_id, resolvedFailExec.execution_id);
  } finally {
    try { if (rt) await rt.close(); } catch { /* ignore */ }
    try { if (fx) await fx.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
