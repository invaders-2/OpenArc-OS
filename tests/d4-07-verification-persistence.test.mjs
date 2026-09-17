/**
 * D4 收口 · 失败 Verification 持久化（PLAN §39）。
 *
 * 真实链路：TaskHarnessOrchestrator → ControlledToolProxy.executeReadOnly
 *   → registry.validateOutput / adapter.verify 失败 → recordVerificationFailure
 *   → 1 条 status=FAIL 的 task_verifications（artifact_id=null，含 type/expected/actual/executionId/stepId/runId）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createToolHarnessFixture, reopenToolHarnessRuntime } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { TaskService } = require("../electron/task-service.cjs");

const FINAL = "OPENARC_TASK_OK";

/** test-only A33 探针：tool contract + adapter 只在测试内注册。 */
function installSizedProbe(fx, { actualSize }) {
  fx.toolRegistry.register({
    toolId: "test.sized",
    version: 1,
    displayName: "Test Sized Output (D4-07 probe)",
    description: "测试专用：产出声明 size，由 adapter.verify 校验；绝不在生产 profile 注册。",
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
  return { r, ctx, taskId: t.task.taskId, task: fx.taskStore.taskById(t.task.taskId), steps: fx.taskStore.stepsOfTask(t.task.taskId), execs: fx.toolStore.executionsOfTask(t.task.taskId), artifacts: fx.taskStore.artifactsOfTask(t.task.taskId), verifications: fx.taskStore.verificationsOfTask(t.task.taskId) };
}

test("D4 收口 · 验证失败 → 1 条 FAIL Verification（type/expected/actual/executionId/step/run），0 Artifact，Step/Task BLOCKED", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const state = installSizedProbe(fx, { actualSize: 7 });
    const out = await runSized(fx, { expectedSize: 10 });
    assert.equal(state.calls, 1, "工具确实报告成功 1 次");

    assert.equal(out.r.error, "TOOL_VERIFICATION_FAILED");
    assert.equal(out.task.status, "BLOCKED");
    assert.equal(out.steps[0].status, "BLOCKED");
    assert.equal(out.artifacts.length, 0, "验证失败 → 0 Artifact");
    assert.equal(out.verifications.length, 1, "验证失败 → 1 条 FAIL Verification：" + out.verifications.length);
    const v = out.verifications[0];
    assert.equal(v.status, "FAIL");
    assert.equal(v.type, "ADAPTER_VERIFY");
    assert.equal(v.artifact_id, null, "FAIL Verification 绝不绑定 Artifact");
    assert.equal(v.task_id, out.taskId);
    assert.equal(v.step_id, out.steps[0].step_id);
    assert.ok(v.run_id, "关联 run");
    assert.equal(v.execution_id, out.execs[0].execution_id, "关联 execution");
    const details = JSON.parse(v.safe_details);
    assert.equal(details.method, "ADAPTER_VERIFY");
    assert.deepEqual(details.expected, { expectedSize: 10, actualSize: 7 });
    assert.deepEqual(details.actual, { label: "box", size: 7 });
    assert.equal(details.evidence.executionId, out.execs[0].execution_id);
    // 只追加证据：Step/Task 终态由执行失败决定，不是被 verification 改写。
    assert.equal(fx.taskStore.verificationsOfTask(out.taskId).filter((x) => x.status === "PASS").length, 0);
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});

test("D4 收口 · 成功路径无回归：1 Artifact + 1 PASS Verification（不产生 FAIL）", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    installSizedProbe(fx, { actualSize: 10 });
    const out = await runSized(fx, { expectedSize: 10 });
    assert.equal(out.r.ok, true, JSON.stringify(out.r.error));
    assert.equal(out.task.status, "SUCCEEDED");
    assert.equal(out.artifacts.length, 1);
    assert.equal(out.verifications.length, 1);
    assert.equal(out.verifications[0].status, "PASS");
    assert.equal(out.verifications[0].artifact_id, out.artifacts[0].artifact_id, "PASS Verification 绑定 Artifact");
    assert.equal(out.verifications[0].artifact_id != null, true);
  } finally { await fx.close(); }
});

test("D4 收口 · 同盘 DB 关闭重开后 FAIL Verification 证据完整可查", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d407v-"));
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const runtimeDir = path.join(root, "rt");
  let fx = null; let rt = null;
  try {
    fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop", dbPath, storeRoot, keepData: true, sideEffectRuntimeDir: runtimeDir });
    installSizedProbe(fx, { actualSize: 7 });
    const out = await runSized(fx, { expectedSize: 10 });
    assert.equal(out.r.error, "TOOL_VERIFICATION_FAILED");
    const taskId = out.taskId; const stepId = out.steps[0].step_id; const runId = out.execs[0].run_id; const executionId = out.execs[0].execution_id;

    await fx.close(); fx = null;
    rt = await reopenToolHarnessRuntime({ dbPath, storeRoot, runtimeDir });
    rt.recover();

    const vers = rt.taskStore.verificationsOfTask(taskId);
    assert.equal(vers.length, 1, "重开后 FAIL Verification 仍在");
    const v = vers[0];
    assert.equal(v.status, "FAIL");
    assert.equal(v.artifact_id, null);
    assert.equal(v.step_id, stepId);
    assert.equal(v.run_id, runId);
    assert.equal(v.execution_id, executionId);
    assert.equal(JSON.parse(v.safe_details).evidence.executionId, executionId);
    assert.equal(rt.taskStore.artifactsOfTask(taskId).length, 0, "重开后 0 Artifact");
    assert.equal(rt.taskStore.taskById(taskId).status, "BLOCKED");
    assert.equal(rt.taskStore.stepById(stepId).status, "BLOCKED");
  } finally {
    try { if (rt) await rt.close(); } catch { /* ignore */ }
    try { if (fx) await fx.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("D4 收口 · 跨用户不可读取 verification / task（TASK_FORBIDDEN）", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    installSizedProbe(fx, { actualSize: 7 });
    const out = await runSized(fx, { expectedSize: 10 });
    assert.equal(out.verifications.length, 1);

    const alice = fx.ctx("alice");
    const denied = fx.taskService.getVerifications({ context: alice, taskId: out.taskId });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "TASK_FORBIDDEN");
    const deniedTask = fx.taskService.getTask({ context: alice, taskId: out.taskId });
    assert.equal(deniedTask.ok, false);
    assert.equal(deniedTask.error, "TASK_FORBIDDEN");
    // owner 仍可读
    const mine = fx.taskService.getVerifications({ context: out.ctx, taskId: out.taskId });
    assert.equal(mine.ok, true);
    assert.equal(mine.items.length, 1);
  } finally { await fx.close(); }
});

test("D4 收口 · recordVerificationFailure 证据脱敏：敏感键/私有路径/capability 前缀/超长字符串；不改 Step/Task", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const run = fx.dshRunSetup();
    const before = fx.taskStore.taskById(run.taskId);
    const saved = fx.taskService.recordVerificationFailure({
      context: run.context, taskId: run.taskId, stepId: run.stepId, runId: run.runId, executionId: "exec_probe_1",
      type: "OUTPUT_SCHEMA",
      expected: { type: "object", token: "mpx_secret_value", nested: { keep: true } },
      actual: { path: "/Users/someone/private/secret.txt", capability: "tpx_secret_value", note: "x".repeat(500), ok: false },
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const v = saved.verification;
    assert.equal(v.status, "FAIL");
    assert.equal(v.artifactId, null);
    assert.equal(v.type, "OUTPUT_SCHEMA");
    assert.equal(v.stepId, run.stepId);
    assert.equal(v.runId, run.runId);
    assert.equal(v.executionId, "exec_probe_1");
    assert.equal(v.details.expected.token, "[REDACTED]");
    assert.equal(v.details.expected.nested.keep, true);
    assert.equal(v.details.actual.path, "[REDACTED_PATH]");
    assert.equal(v.details.actual.capability, "[REDACTED_CAPABILITY]");
    assert.ok(v.details.actual.note.length <= 220, "超长字符串必须截断：" + v.details.actual.note.length);
    assert.equal(v.details.actual.ok, false);
    assert.equal(fx.taskStore.artifactsOfTask(run.taskId).length, 0, "绝不创建 Artifact");
    const after = fx.taskStore.taskById(run.taskId);
    assert.equal(after.status, before.status, "绝不改变 Task 终态");
    assert.equal(after.revision, before.revision, "绝不 bump Task revision");
    assert.equal(fx.taskStore.stepById(run.stepId).status, "RUNNING", "绝不改变 Step 状态");
    const ev = fx.taskStore.eventsOfTask(run.taskId).filter((e) => e.event_type === "verification.completed").map((e) => JSON.parse(e.safe_payload));
    assert.equal(ev.length, 1);
    assert.equal(ev[0].status, "FAIL");
  } finally { await fx.close(); }
});
