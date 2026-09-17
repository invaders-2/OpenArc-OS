/**
 * D4-05 · S1（A33 产物不符）——真实 Tool 执行链的产物尺寸校验。
 *
 * 只在本测试内注册 test-only 探针 tool `test.sized`（期望尺寸 vs 实际尺寸）与对应 adapter；
 * 绝不进入生产 Registry / adapter allowlist。真实链路：
 *   TaskHarnessOrchestrator → ControlledToolProxy.propose → executeReadOnly
 *   → registry.validateOutput → adapter.verify → commitStepSuccess
 *
 * 负例：adapter.execute 报告成功（ok:true）但产物尺寸不符 → verify FAIL
 *       → execution FAILED / TOOL_VERIFICATION_FAILED / verification_status=FAIL
 *       → Task/Step BLOCKED、0 Artifact、0 Verification、无第 2 次 proposal/execution。
 * 正对照：同一工具/同一调用，仅实际尺寸相符 → Task SUCCEEDED、1 Artifact + 1 Verification。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { TaskService } = require("../electron/task-service.cjs");

const sha256 = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const FINAL = "OPENARC_TASK_OK";

/** test-only A33 探针：tool contract + adapter 只在测试内注册。 */
function installSizedProbe(fx, { actualSize }) {
  fx.toolRegistry.register({
    toolId: "test.sized",
    version: 1,
    displayName: "Test Sized Output (D4-05 A33 probe)",
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
  const state = { actualSize, calls: 0, lastResult: null };
  fx.adapters.providers.testSized = {
    toolIds: ["test.sized"],
    async prepare() { return { plan: { provider: "testSized" } }; },
    async execute({ args }) {
      state.calls += 1;
      const size = state.actualSize == null ? Number(args.expectedSize) : Number(state.actualSize);
      state.lastResult = { label: String(args.label || "artifact"), size };
      // 关键：execute 报告成功；尺寸由 verify 独立核对。
      return { ok: true, result: state.lastResult };
    },
    async verify({ args, result }) {
      const ok = !!(result && Number(result.size) === Number(args.expectedSize));
      return { ok, applied: ok, detail: { expectedSize: Number(args.expectedSize), actualSize: result && result.size } };
    },
  };
  return state;
}

async function runSized(fx, { expectedSize }) {
  const ctx = fx.ctx();
  const t = fx.createTask();
  const orch = fx.makeToolOrchestrator();
  const proposalId = "tc_sized_" + crypto.randomBytes(4).toString("hex");
  const stepInput = { proposeSequence: [{ toolId: "test.sized", toolVersion: 1, arguments: { expectedSize, label: "box" }, proposalId }], finalText: FINAL };
  const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput, verify: { type: "EXACT_TEXT", expected: FINAL } });
  return {
    r,
    taskId: t.task.taskId,
    task: fx.taskStore.taskById(t.task.taskId),
    steps: fx.taskStore.stepsOfTask(t.task.taskId),
    execs: fx.toolStore.executionsOfTask(t.task.taskId),
    proposals: fx.toolStore.proposalsOfTask(t.task.taskId),
    events: fx.taskStore.eventsOfTask(t.task.taskId).map((e) => e.event_type),
    artifacts: fx.taskStore.artifactsOfTask(t.task.taskId),
    verifications: fx.taskStore.verificationsOfTask(t.task.taskId),
  };
}

test("D4-05 S1 A33 · 工具报告成功但产物尺寸不符 → TOOL_VERIFICATION_FAILED / Task BLOCKED / 0 Artifact / 无自动重试", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const state = installSizedProbe(fx, { actualSize: 7 });
    const out = await runSized(fx, { expectedSize: 10 });

    // 工具确实报告成功（execute 返回 ok:true），但产物尺寸 7 != 期望 10。
    assert.equal(state.calls, 1, "adapter.execute 恰好被调用 1 次");
    assert.deepEqual(state.lastResult, { label: "box", size: 7 }, "工具报告成功且产出尺寸 7：" + JSON.stringify(state.lastResult));

    assert.equal(out.r.ok, false, "产物不符时任务不得成功");
    assert.equal(out.r.error, "TOOL_VERIFICATION_FAILED", "失败原因必须是验证失败，而不是执行失败：" + out.r.error);
    assert.equal(out.task.status, "BLOCKED", "Task 必须 BLOCKED：" + out.task.status);
    assert.equal(out.steps[0].status, "BLOCKED", "Step 必须 BLOCKED：" + out.steps[0].status);

    assert.equal(out.execs.length, 1, "恰好 1 次 execution（无自动重试）：" + out.execs.length);
    assert.equal(out.execs[0].status, "FAILED", "execution FAILED：" + out.execs[0].status);
    assert.equal(out.execs[0].error_code, "TOOL_VERIFICATION_FAILED");
    assert.equal(out.execs[0].verification_status, "FAIL", "verification_status 必须 FAIL：" + out.execs[0].verification_status);
    assert.equal(out.execs[0].task_id, out.taskId);
    assert.equal(out.execs[0].step_id, out.steps[0].step_id, "execution 归属正确 step");
    assert.equal(out.proposals.length, 1, "不产生第 2 个 proposal：" + out.proposals.length);

    assert.equal(out.artifacts.length, 0, "验证失败 → 0 Artifact");
    assert.equal(out.verifications.length, 0, "验证失败 → 0 Verification");
    assert.ok(out.events.includes("tool.verification.failed"), "必须记录 tool.verification.failed：" + JSON.stringify(out.events));
    assert.ok(!out.events.includes("tool.execution_succeeded"), "绝不记录 execution_succeeded");
    assert.ok(!out.events.includes("artifact.created"), "绝不产生 Artifact 事件");
    assert.equal(TaskService.policy.autoRetry, 0, "AUTO_RETRY 必须为 0");
  } finally { await fx.close(); }
});

test("D4-05 S1 A33 正对照 · 产物尺寸符合 → Task SUCCEEDED + 1 Artifact + 1 Verification（同一链路，非一概判失败）", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const state = installSizedProbe(fx, { actualSize: 10 });
    const out = await runSized(fx, { expectedSize: 10 });

    assert.equal(state.calls, 1);
    assert.deepEqual(state.lastResult, { label: "box", size: 10 });

    assert.equal(out.r.ok, true, "尺寸符合必须成功：" + JSON.stringify(out.r.error));
    assert.equal(out.task.status, "SUCCEEDED", "Task SUCCEEDED：" + out.task.status);
    assert.equal(out.steps[0].status, "SUCCEEDED");

    assert.equal(out.execs.length, 1);
    assert.equal(out.execs[0].status, "SUCCEEDED");
    assert.equal(out.execs[0].verification_status, "PASS", "verification_status PASS：" + out.execs[0].verification_status);

    // 产物/关联链：Artifact 归属 task/step/run，Verification 绑定同一 Artifact。
    assert.equal(out.artifacts.length, 1, "恰好 1 个 Artifact");
    assert.equal(out.verifications.length, 1, "恰好 1 个 Verification");
    const artifact = out.artifacts[0];
    const verification = out.verifications[0];
    assert.equal(artifact.task_id, out.taskId);
    assert.equal(artifact.step_id, out.steps[0].step_id);
    assert.ok(artifact.run_id, "Artifact 必须关联 run");
    assert.equal(artifact.checksum, sha256(artifact.safe_content), "checksum == sha256(content)");
    assert.equal(verification.artifact_id, artifact.artifact_id, "Verification 绑定同一 Artifact");
    assert.equal(verification.task_id, out.taskId);
    assert.equal(verification.status, "PASS");
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});
