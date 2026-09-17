/**
 * D4-06 · 预算到限停止 + 关联链保留（真实产品 TaskHarnessOrchestrator，不 mock service）。
 *
 * 三条冻结预算（不发明新预算）：
 *   ① Model Proxy capability maxCalls = DEFAULT_MAX_CALLS = 8（每个 Harness run 的 bounded 模型调用）
 *   ② Tool Facade capability maxCalls（atomic reserve；exact duplicate 不二次消耗）
 *   ③ 编排层 MAX_TOOL_ROUNDS = 4（自动 READ tool loop 上界）
 * 停止语义：orchestrator 自己走 blockStep + blockHarnessRun（reason BUDGET_EXHAUSTED + kind），
 * 绝不手工调用 blockStep/blockHarnessRun；已发生的 tool execution / Artifact / Verification / 副作用保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { TaskService } = require("../electron/task-service.cjs");
const { TaskHarnessOrchestrator } = require("../electron/task-harness-orchestrator.cjs");

const MAX_TOOL_ROUNDS = 4;
const sha256 = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (fn, ms, detail) => (async () => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } assert.fail("waitFor 超时：" + detail); })();

/* ① 轮次预算停止：orchestrator 自己在第 5 个 proposal 前退出 loop → blockStep（不手工停）。 */
test("D4-06 · 轮次预算停止：proposeSequence>=5 → 恰好 MAX_TOOL_ROUNDS=4 次执行，Task/Step/Run BLOCKED，AUTO_RETRY=0", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]);
    const baseFactory = fx.agentFactory("tool-proposal-agent.mjs");
    let prompts = 0;
    const countingFactory = (opts) => { const a = baseFactory(opts); const orig = a.prompt.bind(a); a.prompt = async (...args) => { prompts += 1; return orig(...args); }; return a; };
    const ctx = fx.ctx();
    const t = fx.createTask();
    const seq = Array.from({ length: 5 }, (_, i) => ({ toolId: "resource.search", toolVersion: 1, arguments: { query: "round-" + i, limit: 3 }, proposalId: "tc_round_" + i }));
    const orch = fx.makeToolOrchestrator("tool-proposal-agent.mjs", { adapterFactory: countingFactory });
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput: { proposeSequence: seq, finalText: "OPENARC_TASK_OK" }, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });

    const taskId = t.task.taskId;
    const execs = fx.toolStore.executionsOfTask(taskId);
    const props = fx.toolStore.proposalsOfTask(taskId);
    const runs = fx.taskStore.harnessRunsOfTask(taskId);
    const step = fx.taskStore.stepsOfTask(taskId)[0];

    assert.equal(r.ok, false, "预算是硬上界：不得 SUCCEEDED " + JSON.stringify(r.error));
    assert.equal(execs.length, MAX_TOOL_ROUNDS, "恰好执行 MAX_TOOL_ROUNDS=4 步：" + execs.length);
    assert.equal(props.length, MAX_TOOL_ROUNDS, "不产生第 5 个 proposal/execution：" + props.length);
    assert.equal(prompts, MAX_TOOL_ROUNDS + 1, "model prompt = 初始 1 + bounded 4；没有第 5 轮后 prompt：" + prompts);
    assert.equal(fx.taskStore.taskById(taskId).status, "BLOCKED");
    assert.equal(step.status, "BLOCKED");
    assert.ok(runs.length >= 1 && runs.every((x) => x.status !== "RUNNING" && x.status !== "STARTING"), "Harness run 必须收敛：" + JSON.stringify(runs.map((x) => x.status)));
    assert.equal(runs[runs.length - 1].status, "BLOCKED");
    assert.equal(r.error, "BUDGET_EXHAUSTED", "预算停止 reason = BUDGET_EXHAUSTED：" + JSON.stringify(r.error));
    assert.ok(runs.some((x) => x.error_code === "BUDGET_EXHAUSTED"), "停因 = BUDGET_EXHAUSTED");
    const stopEv = fx.taskStore.eventsOfTask(taskId).map((e) => ({ t: e.event_type, p: e.safe_payload ? JSON.parse(e.safe_payload) : null })).find((e) => e.t === "task.budget_exhausted");
    assert.ok(stopEv && stopEv.p && stopEv.p.kind === "TOOL_ROUNDS", "task.budget_exhausted kind=TOOL_ROUNDS：" + JSON.stringify(stopEv));
    assert.equal(TaskService.policy.autoRetry, 0, "AUTO_RETRY 必须为 0");
    // 已发生的 tool execution 仍可查询且归属正确。
    assert.ok(execs.every((e) => e.task_id === taskId && e.step_id === step.step_id && e.status === "SUCCEEDED"), "已发生 execution 保留且归属正确");
    const events = fx.taskStore.eventsOfTask(taskId).map((e) => e.event_type);
    for (const ev of ["task.budget_exhausted", "step.blocked", "task.blocked", "harness.run.blocked"]) assert.ok(events.includes(ev), "缺事件 " + ev + "：" + JSON.stringify(events));
    // 预算停止路径 0 Artifact / 0 Verification（如实“不适用”，不造假记录）。
    assert.equal(fx.taskStore.artifactsOfTask(taskId).length, 0);
    assert.equal(fx.taskStore.verificationsOfTask(taskId).length, 0);
  } finally { await fx.close(); }
});

/* ② 调用预算边界：Tool Facade atomic reserve。重复请求不二次消耗预算的单元证据见
 *    tests/tool-d4-03d-closure.test.mjs §19 与 tests/tool-dsh-security.test.mjs §85（既有，未改动）。 */
test("D4-06 · 调用预算边界：facade maxCalls=2 → 第 3 个受控 tool call TOOL_CAPABILITY_EXHAUSTED，Domain 执行数<=maxCalls", async () => {
  const { ToolFacadeBridge } = require("../electron/tool-facade-bridge.cjs");
  const bridges = []; const caps = [];
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop", facadeMaxCalls: 2,
    facadeBridgeFactory: (o) => {
      const b = new ToolFacadeBridge(o);
      const orig = b.issueCapability.bind(b);
      // 捕获 run 级 capability 引用（bridge.stop() 会 clear Map，但对象本身保留最终 state/calls）。
      b.issueCapability = (args) => { const res = orig(args); if (res && res.ok) caps.push([...b.capabilities.values()].slice(-1)[0]); return res; };
      bridges.push(b); return b;
    },
  });
  try {
    fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]);
    fx.fp.state.toolLoopPlan = Array.from({ length: 9 }, (_, i) => ({ name: "resource_search", args: { query: "budget-" + i, limit: 5 } }));
    const ctx = fx.ctx();
    const t = fx.createTask();
    const r = await fx.makeDshOrchestrator().runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });

    assert.equal(bridges.length, 1, "每个 run 独立 bridge");
    const bridge = bridges[0];
    assert.equal(bridge.stats.calls, 2, "原子 reserve：只有 2 次消耗预算");
    assert.equal(bridge.stats.domainExecutions, 2, "Domain 执行数不超过 maxCalls");
    assert.equal(caps.length, 1, "run 级 capability 恰好 1 个");
    const cap = caps[0];
    assert.equal(cap.calls, 2, "预算恰好被耗尽（reserve 2 次）");
    assert.equal(cap.maxCalls, 2);
    // run 结束时 orchestrator finally 立即 revokeToolCapability() → REVOKED 覆盖 EXHAUSTED（fail closed）。
    assert.ok(cap.state === "EXHAUSTED" || cap.state === "REVOKED", "capability 终态必须已耗尽/已撤销：" + cap.state);
    const execs = fx.toolStore.executionsOfTask(t.task.taskId);
    assert.equal(execs.length, 2, "只应有 2 个 tool execution：" + execs.length);
    assert.ok(execs.every((e) => e.status === "SUCCEEDED" && e.verification_status === "PASS"));
    const bodies = fx.fp.state.toolLoopBodies.join("\n");
    assert.ok(bodies.includes("TOOL_CAPABILITY_EXHAUSTED"), "第 3 个受控 tool call 必须收到 TOOL_CAPABILITY_EXHAUSTED");
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "BLOCKED", "模型预算耗尽 → 自动循环停止");
    assert.equal(fx.taskStore.artifactsOfTask(t.task.taskId).length, 0);
    assert.equal(fx.taskStore.verificationsOfTask(t.task.taskId).length, 0);
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});

/* ③ 保留产物：step1 真实 WRITE 成功（Artifact+Verification+真实 mutation），step2 轮次预算停止。 */
test("D4-06 · 保留产物：step1 成功后 step2 预算停止 → step1 Artifact/Verification/副作用保留，step2 无 Artifact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d406-retain-"));
  const fx = await createToolHarnessFixture({
    withAdapters: true, behavior: "tool-loop",
    dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), keepData: true,
    sideEffectRuntimeDir: path.join(root, "runtime"), sideEffectApprovalWaitMs: 60000,
    facadeWriteToolIds: ["resource.trash"],
  });
  try {
    const created = await fx.createResource("D406 Retained");
    const resourceRef = created.resource.resourceRef;
    const resourceId = created.resource.resourceId;
    fx.grantTool("ai", ["tool.resource.trash", "tool.resource.search"]);
    assert.equal(fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.delete"] }).ok, true);
    assert.equal(fx.grantUserResource(resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]).ok, true);

    const ctx = fx.ctx();
    const t = fx.createTask();
    const started = fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const s1 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: started.task.revision });
    const ss1 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: s1.task.revision });
    // step2 预先 PENDING：step1 commit 不会把 Task 收成 SUCCEEDED。
    const step2Seq = Array.from({ length: 5 }, (_, i) => ({ toolId: "resource.search", toolVersion: 1, arguments: { query: "retain-" + i, limit: 3 }, proposalId: "tc_retain_" + i }));
    const s2 = fx.taskService.createStep({ context: ctx, taskId: t.task.taskId, kind: "reasoning", input: { proposeSequence: step2Seq, finalText: "OPENARC_TASK_OK" }, expectedRevision: ss1.task.revision });

    // step1：真实 official dsh + Tool Facade + 受控 WRITE + 真实用户 approval。
    fx.fp.state.toolLoopPlan = [{ id: "call_retain_trash", name: "resource_trash", args: { resourceRef } }];
    const dshOrch = fx.makeDshOrchestrator();
    const p1 = dshOrch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s1.step.stepId, expectedRevision: s2.task.revision, verify: { type: "EXACT_TEXT", expected: "OPENARC_DSH_TOOL_OK" } });
    await waitFor(() => fx.sideEffectStore.callsOfTask(t.task.taskId).length === 1, 60000, "SideEffectCall 未出现");
    const call = fx.sideEffectStore.callsOfTask(t.task.taskId)[0];
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: call.callId, decision: "APPROVE" }).ok, true);
    const r1 = await p1;
    assert.equal(r1.ok, true, "step1 必须成功：" + JSON.stringify(r1.error));

    const step1 = fx.taskStore.stepsOfTask(t.task.taskId).find((s) => s.step_id === s1.step.stepId);
    const artifactsAfterStep1 = fx.taskStore.artifactsOfTask(t.task.taskId);
    const verifsAfterStep1 = fx.taskStore.verificationsOfTask(t.task.taskId);
    assert.equal(step1.status, "SUCCEEDED");
    assert.equal(artifactsAfterStep1.length, 1, "step1 必有 Artifact");
    assert.equal(verifsAfterStep1.length, 1, "step1 必有 Verification");
    assert.equal(artifactsAfterStep1[0].checksum, sha256(artifactsAfterStep1[0].safe_content), "checksum == sha256(content)");
    assert.equal(verifsAfterStep1[0].artifact_id, artifactsAfterStep1[0].artifact_id, "Verification 绑定同一 Artifact");
    assert.equal(verifsAfterStep1[0].task_id, t.task.taskId);
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "RUNNING", "step2 仍 PENDING：Task 不得提前 SUCCEEDED");
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, true, "step1 已发生真实副作用");
    assert.equal(fx.sideEffectStore.callById(call.callId).status, "SUCCEEDED");
    assert.equal(fx.sideEffectStore.leasesOfCall(call.callId).filter((l) => l.status === "ACTIVE").length, 0, "lease 已释放");

    // step2：轮次预算停止（真实产品 orchestrator 自己停）。
    const fresh = fx.taskStore.taskById(t.task.taskId);
    const ss2 = fx.taskService.startStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: fresh.revision });
    const toolOrch = fx.makeToolOrchestrator();
    const r2 = await toolOrch.runStep({ context: ctx, taskId: t.task.taskId, stepId: s2.step.stepId, expectedRevision: ss2.task.revision, stepInput: s2.step.input, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, "BUDGET_EXHAUSTED");

    const step2 = fx.taskStore.stepsOfTask(t.task.taskId).find((s) => s.step_id === s2.step.stepId);
    assert.equal(step2.status, "BLOCKED");
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "BLOCKED");
    // step1 的产物仍可查询、归属正确；step2 无 Artifact。
    const retainedArtifact = fx.taskStore.artifactsOfTask(t.task.taskId).filter((a) => a.step_id === s1.step.stepId);
    const retainedVerif = fx.taskStore.verificationsOfTask(t.task.taskId).filter((v) => v.artifact_id === artifactsAfterStep1[0].artifact_id);
    assert.equal(retainedArtifact.length, 1, "step1 Artifact 必须保留");
    assert.equal(retainedArtifact[0].task_id, t.task.taskId);
    assert.equal(retainedArtifact[0].checksum, sha256(retainedArtifact[0].safe_content));
    assert.equal(retainedVerif.length, 1, "step1 Verification 必须保留");
    assert.equal(fx.taskStore.artifactsOfTask(t.task.taskId).filter((a) => a.step_id === s2.step.stepId).length, 0, "step2 必须 0 Artifact");
    assert.equal(fx.taskStore.verificationsOfTask(t.task.taskId).filter((v) => v.task_id === t.task.taskId).length, 1);
    const step2Execs = fx.toolStore.executionsOfTask(t.task.taskId).filter((e) => e.step_id === s2.step.stepId);
    assert.equal(step2Execs.length, MAX_TOOL_ROUNDS, "step2 恰好 4 次 execution");
    // 停止不回滚已发生的副作用；也不产生补偿动作。
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, true, "预算停止不得回滚已发生的已提交副作用（不声称回滚）");
    assert.equal(fx.sideEffectStore.callById(call.callId).status, "SUCCEEDED", "已完成的 SideEffectCall 保持 SUCCEEDED");
    assert.equal(fx.sideEffectStore.callsOfTask(t.task.taskId).length, 1, "停止后绝不补发第二个 SideEffectCall");
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally {
    try { await fx.close(); } catch { /* ignore */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/* ④ 执行异常（Domain 抛错）：受控 tool 真实执行失败 → execution FAILED → Step/Task BLOCKED，0 Artifact，0 mutation。 */
test("D4-06 · 执行异常：受控 tool Domain 抛错 → execution FAILED → Step/Task BLOCKED，0 Artifact，无自动重试", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.grantTool("ai", ["tool.resource.search"]);
    fx.f.searchService.search = () => { throw new Error("d4-06 injected domain fault"); };
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeToolOrchestrator();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput: { proposeSequence: [{ toolId: "resource.search", toolVersion: 1, arguments: { query: "boom", limit: 3 }, proposalId: "tc_boom" }], finalText: "OPENARC_TASK_OK" }, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });

    assert.equal(r.ok, false);
    const execs = fx.toolStore.executionsOfTask(t.task.taskId);
    assert.equal(execs.length, 1, "恰好 1 次受控执行（无自动重试）");
    assert.equal(execs[0].status, "FAILED");
    assert.equal(execs[0].error_code, "TOOL_EXECUTION_FAILED");
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "BLOCKED");
    assert.equal(fx.taskStore.stepsOfTask(t.task.taskId)[0].status, "BLOCKED");
    assert.equal(fx.taskStore.artifactsOfTask(t.task.taskId).length, 0, "执行异常 → 0 Artifact");
    assert.equal(fx.taskStore.verificationsOfTask(t.task.taskId).length, 0, "执行异常 → 0 Verification");
    assert.equal(fx.sideEffectStore.callsOfTask(t.task.taskId).length, 0, "执行异常 → 0 SideEffectCall / 0 mutation");
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});

/* ⑤ 执行异常（目标不存在）：READ 目标不存在 → propose DENIED → Step/Task BLOCKED，0 Artifact，0 mutation。 */
test("D4-06 · 执行异常：READ 目标不存在 → proposal DENIED → Step/Task BLOCKED，0 Artifact，0 mutation", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    fx.grantTool("ai", ["tool.resource.readMetadata", "tool.resource.search"]);
    const ctx = fx.ctx();
    const t = fx.createTask();
    const orch = fx.makeToolOrchestrator();
    const r = await orch.runTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision, stepInput: { proposeSequence: [
      { toolId: "resource.search", toolVersion: 1, arguments: { query: "exists", limit: 3 }, proposalId: "tc_ok" },
      { toolId: "resource.read.metadata", toolVersion: 1, arguments: { resourceRef: "resource://res_d4_06_missing" }, proposalId: "tc_missing" },
    ], finalText: "OPENARC_TASK_OK" }, verify: { type: "EXACT_TEXT", expected: "OPENARC_TASK_OK" } });

    assert.equal(r.ok, false);
    assert.equal(fx.taskStore.taskById(t.task.taskId).status, "BLOCKED");
    assert.equal(fx.taskStore.stepsOfTask(t.task.taskId)[0].status, "BLOCKED");
    const decisions = fx.toolStore.decisionsOfTask(t.task.taskId);
    assert.ok(decisions.some((d) => d.decision === "DENIED" && d.reason_code === "RESOURCE_NOT_AVAILABLE"), "目标不存在必须 DENIED：" + JSON.stringify(decisions.map((d) => [d.decision, d.reason_code])));
    assert.equal(fx.toolStore.executionsOfTask(t.task.taskId).filter((e) => e.tool_id === "resource.read.metadata").length, 0, "DENIED 不产生 execution");
    assert.equal(fx.taskStore.artifactsOfTask(t.task.taskId).length, 0);
    assert.equal(fx.taskStore.verificationsOfTask(t.task.taskId).length, 0);
    assert.equal(fx.sideEffectStore.callsOfTask(t.task.taskId).length, 0);
    assert.equal(TaskService.policy.autoRetry, 0);
  } finally { await fx.close(); }
});

/* ⑥ Explicit Resume = DEFERRED（只报告事实，不实现 resume，不判定通过）。 */
test("D4-06 · A35 续接入口现状：orchestrator.resume() 仍返回 EXPLICIT_RESUME_DEFERRED（Explicit Resume = DEFERRED）", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true, behavior: "tool-loop" });
  try {
    const orch = fx.makeDshOrchestrator();
    const res = await orch.resume();
    assert.equal(res.ok, false);
    assert.equal(res.error, "EXPLICIT_RESUME_DEFERRED");
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "electron", "task-harness-orchestrator.cjs"), "utf8");
    assert.ok(src.includes('return { ok: false, error: "EXPLICIT_RESUME_DEFERRED" };'), "产品 resume() 仍为 DEFERRED（无自动 replay）");
  } finally { await fx.close(); }
});
