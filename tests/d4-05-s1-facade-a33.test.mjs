/**
 * D4-05 · S1（A33 产物不符）——official dsh facade 正式链的「拒绝假成功」闸门。
 *
 * 真实链路（无 synthetic ACP agent / 无 dshArgs）：
 *   TaskHarnessOrchestrator → HarnessAdapter(official dsh) → ACP → 受控 plugin
 *   → ToolFacadeBridge → ControlledToolProxy.executeReadOnly（dsh 进程内）
 *   → registry.validateOutput / adapter.verify 如实落 tool_executions + task_verifications
 *   → orchestrator 以**后端记录**为准，拒绝「final text 通过但必需产物验证失败未解决」的假成功。
 *
 * 只在本测试内注册 test-only 探针 tool test.sized / test.broken；绝不进入生产 Registry / allowlist。
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
const EXPECTED = 10;

/** test-only A33 尺寸探针：tool contract + adapter 只在测试内注册。sizes 按调用顺序消费。 */
function installSizedProbe(fx, { sizes = [7] } = {}) {
  fx.toolRegistry.register({
    toolId: "test.sized",
    version: 1,
    displayName: "Test Sized Output (D4-05 A33 facade probe)",
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
    displayName: "Test Broken Output (D4-05 A33 facade probe)",
    description: "测试专用：仅返回执行错误，用于证明普通工具调用错误不被一刀切判失败。",
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

test("D4-05 S1 A33 facade 负例 · 工具报告成功但产物验证失败未解决 → 拒绝假成功（BLOCKED / 0 Artifact / 无自动重试）", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeToolIds: ["test.sized"] });
  try {
    const state = installSizedProbe(fx, { sizes: [7] });
    const out = await runFacade(fx, [{ name: "test_sized", args: { expectedSize: EXPECTED, label: "box" } }]);

    assert.equal(state.calls, 1, "adapter.execute 恰好 1 次（无自动重试）");
    assert.deepEqual(state.results, [{ label: "box", size: 7 }], "工具报告成功且产出尺寸 7");
    assert.ok(out.modelRequests >= 2, "provider 确实发出了 final（模型至少 2 次请求）：" + out.modelRequests);

    assert.equal(out.r.ok, false, "产物验证失败未解决时任务不得成功");
    assert.equal(out.r.error, "TOOL_VERIFICATION_FAILED", "停因必须是 TOOL_VERIFICATION_FAILED：" + out.r.error);
    assert.equal(out.task.status, "BLOCKED", "Task 必须 BLOCKED：" + out.task.status);
    assert.equal(out.steps[0].status, "BLOCKED", "Step 必须 BLOCKED：" + out.steps[0].status);

    assert.equal(out.execs.length, 1, "恰好 1 次 execution：" + out.execs.length);
    assert.equal(out.execs[0].status, "FAILED");
    assert.equal(out.execs[0].verification_status, "FAIL");
    assert.equal(out.execs[0].error_code, "TOOL_VERIFICATION_FAILED");
    assert.equal(out.execs[0].task_id, out.taskId);
    assert.equal(out.execs[0].step_id, out.steps[0].step_id, "execution 归属正确 step");
    assert.ok(out.execs[0].run_id, "execution 归属 run");

    assert.equal(out.artifacts.length, 0, "验证失败 → 0 Artifact");
    assert.equal(out.verifications.length, 1, "验证失败 → 1 条 FAIL Verification：" + out.verifications.length);
    const failVer = out.verifications[0];
    assert.equal(failVer.status, "FAIL");
    assert.equal(failVer.type, "ADAPTER_VERIFY", "检查方法 = ADAPTER_VERIFY：" + failVer.type);
    assert.equal(failVer.artifact_id, null, "失败 Verification 不得绑定 Artifact");
    assert.equal(failVer.task_id, out.taskId);
    assert.equal(failVer.step_id, out.steps[0].step_id, "失败 Verification 关联 step");
    assert.equal(failVer.run_id, out.execs[0].run_id, "失败 Verification 关联同一 run");
    assert.equal(failVer.execution_id, out.execs[0].execution_id, "失败 Verification 关联 execution");

    assert.ok(out.events.includes("tool.verification.failed"), "必须记录 tool.verification.failed：" + JSON.stringify(out.events));
    assert.ok(!out.events.includes("tool.execution_succeeded"), "绝不记录 execution_succeeded");
    assert.ok(!out.events.includes("artifact.created"), "绝不产生 Artifact 事件");
    assert.ok(!out.events.includes("task.succeeded"), "绝不产生 task.succeeded");

    assert.equal(out.proposals.length, 1, "恰好 1 个 proposal（无自动重试）：" + out.proposals.length);
    assert.equal(TaskService.policy.autoRetry, 0, "AUTO_RETRY 必须为 0");
  } finally { await fx.close(); }
});

test("D4-05 S1 A33 facade 正对照 · 产物尺寸符合 → Task SUCCEEDED + 1 Artifact + 1 PASS Verification（非一概判失败）", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeToolIds: ["test.sized"] });
  try {
    const state = installSizedProbe(fx, { sizes: [EXPECTED] });
    const out = await runFacade(fx, [{ name: "test_sized", args: { expectedSize: EXPECTED, label: "box" } }]);

    assert.equal(state.calls, 1);
    assert.deepEqual(state.results, [{ label: "box", size: 10 }]);
    assert.ok(out.modelRequests >= 2, "provider 确实发出了 final：" + out.modelRequests);

    assert.equal(out.r.ok, true, "尺寸符合必须成功：" + JSON.stringify(out.r.error));
    assert.equal(out.task.status, "SUCCEEDED", "Task SUCCEEDED：" + out.task.status);
    assert.equal(out.steps[0].status, "SUCCEEDED");
    assert.equal(out.execs.length, 1);
    assert.equal(out.execs[0].status, "SUCCEEDED");
    assert.equal(out.execs[0].verification_status, "PASS");

    assert.equal(out.artifacts.length, 1, "恰好 1 个 Artifact");
    assert.equal(out.verifications.length, 1, "恰好 1 个 Verification");
    const artifact = out.artifacts[0];
    const verification = out.verifications[0];
    assert.equal(verification.artifact_id, artifact.artifact_id, "Verification 绑定同一 Artifact");
    assert.equal(verification.status, "PASS");
    assert.equal(verification.task_id, out.taskId);
    assert.ok(!out.verifications.some((v) => v.status === "FAIL"), "0 条 FAIL Verification");
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});

test("D4-05 S1 A33 facade 有限纠错 · 首次 FAIL 后同 tool 真实 PASS → 成功且旧 FAIL 仍在、不永久禁止成功", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeToolIds: ["test.sized"] });
  try {
    const state = installSizedProbe(fx, { sizes: [7, EXPECTED] });
    const out = await runFacade(fx, [
      { name: "test_sized", args: { expectedSize: EXPECTED, label: "box" } },
      { name: "test_sized", args: { expectedSize: EXPECTED, label: "box" } },
    ]);

    assert.equal(state.calls, 2, "adapter.execute 恰好 2 次（真实复验，非自动重试）");
    assert.deepEqual(state.results, [{ label: "box", size: 7 }, { label: "box", size: 10 }]);

    assert.equal(out.execs.length, 2, "2 次 execution");
    const [first, second] = out.execs;
    assert.equal(first.status, "FAILED");
    assert.equal(first.verification_status, "FAIL");
    assert.equal(first.error_code, "TOOL_VERIFICATION_FAILED");
    assert.equal(second.status, "SUCCEEDED");
    assert.equal(second.verification_status, "PASS");
    assert.equal(second.error_code, null);
    assert.equal(first.tool_id, second.tool_id, "同一 tool_id");
    assert.notEqual(first.execution_id, second.execution_id, "execution_id 不同");

    assert.equal(out.r.ok, true, "真复验通过后必须成功：" + JSON.stringify(out.r.error));
    assert.equal(out.task.status, "SUCCEEDED");
    assert.equal(out.artifacts.length, 1, "恰好 1 个 Artifact");

    // 旧 FAIL Verification 绝不删除：artifact_id=null，execution_id 指向第 1 个 execution。
    const failVers = out.verifications.filter((v) => v.status === "FAIL");
    assert.equal(failVers.length, 1, "旧 FAIL Verification 仍在：" + out.verifications.length);
    assert.equal(failVers[0].type, "ADAPTER_VERIFY");
    assert.equal(failVers[0].artifact_id, null);
    assert.equal(failVers[0].execution_id, first.execution_id, "旧 FAIL 关联第 1 个 execution");

    const passVers = out.verifications.filter((v) => v.status === "PASS");
    assert.equal(passVers.length, 1, "1 条 PASS Verification");
    assert.equal(passVers[0].artifact_id, out.artifacts[0].artifact_id, "PASS Verification 绑定 Artifact");
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});

test("D4-05 S1 A33 facade 普通 READ 错误 · 执行失败但无验证结论 → 不因新闸门一刀切判失败", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeToolIds: ["test.broken"] });
  try {
    const state = installBrokenProbe(fx);
    const out = await runFacade(fx, [{ name: "test_broken", args: { tag: "boom" } }]);

    assert.equal(state.calls, 1);
    assert.ok(out.modelRequests >= 2, "provider 确实发出了 final（工具调用错误由模型续推理）：" + out.modelRequests);

    assert.equal(out.execs.length, 1, "恰好 1 次 execution");
    assert.equal(out.execs[0].status, "FAILED");
    assert.equal(out.execs[0].verification_status == null || out.execs[0].verification_status === "", true, "普通执行错误无验证结论：" + out.execs[0].verification_status);
    assert.ok(!out.verifications.some((v) => v.status === "FAIL" && (v.type === "OUTPUT_SCHEMA" || v.type === "ADAPTER_VERIFY")), "无产物验证 FAIL：" + JSON.stringify(out.verifications.map((v) => ({ t: v.type, s: v.status }))));

    assert.equal(out.r.ok, true, "facade 既有语义：普通工具调用错误不整体失败：" + JSON.stringify(out.r.error));
    assert.equal(out.task.status, "SUCCEEDED", "Task 仍 SUCCEEDED：" + out.task.status);
    assert.equal(out.artifacts.length, 1);
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});

test("D4-05 S1 A33 facade 持久化 · 同一 disk DB 重开后假成功拒绝证据仍可追溯", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa5s1-facade-"));
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const runtimeDir = path.join(root, "rt");
  let fx = null; let rt = null;
  try {
    fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", facadeToolIds: ["test.sized"], dbPath, storeRoot, keepData: true, sideEffectRuntimeDir: runtimeDir });
    installSizedProbe(fx, { sizes: [7] });
    const out = await runFacade(fx, [{ name: "test_sized", args: { expectedSize: EXPECTED, label: "box" } }]);

    assert.equal(out.r.error, "TOOL_VERIFICATION_FAILED");
    assert.equal(out.execs.length, 1);
    const exec0 = out.execs[0];
    const taskId = out.taskId;
    const stepId = out.steps[0].step_id;
    const runId = exec0.run_id;

    await fx.close(); fx = null;
    rt = await reopenToolHarnessRuntime({ dbPath, storeRoot, runtimeDir });
    rt.recover();

    const execs = rt.toolStore.executionsOfTask(taskId);
    assert.equal(execs.length, 1, "重开后 tool_executions 行仍在");
    assert.equal(execs[0].status, "FAILED");
    assert.equal(execs[0].verification_status, "FAIL");
    assert.equal(execs[0].error_code, "TOOL_VERIFICATION_FAILED");

    const events = rt.taskStore.eventsOfTask(taskId).map((e) => e.event_type);
    assert.ok(events.includes("tool.verification.failed"), "持久化的 tool.verification.failed 仍可查：" + JSON.stringify(events));

    const vers = rt.taskStore.verificationsOfTask(taskId);
    const failVers = vers.filter((v) => v.status === "FAIL");
    assert.equal(failVers.length, 1, "重开后 FAIL Verification 仍在：" + vers.length);
    assert.equal(failVers[0].type, "ADAPTER_VERIFY");
    assert.equal(failVers[0].artifact_id, null);
    assert.equal(failVers[0].task_id, taskId);
    assert.equal(failVers[0].step_id, stepId);
    assert.equal(failVers[0].run_id, runId);
    assert.equal(failVers[0].execution_id, exec0.execution_id);

    assert.equal(rt.taskStore.taskById(taskId).status, "BLOCKED", "重开后 Task 仍 BLOCKED");
    assert.equal(rt.taskStore.stepById(stepId).status, "BLOCKED", "重开后 Step 仍 BLOCKED");
    assert.equal(rt.taskStore.artifactsOfTask(taskId).length, 0, "重开后仍 0 Artifact");
  } finally {
    try { if (rt) await rt.close(); } catch { /* ignore */ }
    try { if (fx) await fx.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
