/** D4-02C · Orchestrator 领域单测：ACP mapping / prompt / block / 原子提交 / 0 execution。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createTaskHarnessFixture, EXACT } from "./fixtures/harness-acp/task-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { mapAcpEvents, buildPrompt, PROMPT_SCHEMA_VERSION } = require("../electron/task-harness-orchestrator.cjs");

function stubFactory({ modelConfigVersion, text = EXACT, behavior = "ok" }) {
  return {
    lastText: null,
    async start() { return { capabilityId: "mcap_stub", modelConfigVersion, dshVersion: "stub-0", sdkVersion: "0.0.0", protocolVersion: 1 }; },
    async prompt(p) {
      this.lastText = p;
      if (behavior === "crash") throw Object.assign(new Error("HARNESS_PROCESS_EXITED"), { code: "HARNESS_PROCESS_EXITED" });
      if (behavior === "timeout") throw Object.assign(new Error("HARNESS_TURN_TIMEOUT"), { code: "HARNESS_TURN_TIMEOUT" });
      const events = [{ type: "text.delta", text }];
      if (behavior === "tool") events.push({ type: "tool.proposed", toolCallId: "tc_stub" });
      if (behavior === "permission") events.push({ type: "permission.requested" });
      return { ok: true, stopReason: "end_turn", text, events };
    },
    async cancel() {},
    revokeModelCapability() {},
    async dispose() {},
  };
}

test("ACP → TaskEvent mapping 显式、聚合 text、丢 reasoning、洪泛有上限", () => {
  const events = [
    { type: "text.delta", text: "OPEN" },
    { type: "text.delta", text: "ARC" },
    { type: "reasoning.delta", text: "private chain of thought" },
    { type: "tool.proposed", toolCallId: "tc1" },
    { type: "plan" },
    { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    { type: "permission.requested" },
    { type: "totally.unknown" },
  ];
  const m = mapAcpEvents(events, { maxPersisted: 32 });
  const types = m.events.map((e) => e.eventType);
  assert.ok(types.includes("harness.text.delta"));
  assert.ok(types.includes("harness.tool_proposed"));
  assert.ok(types.includes("harness.plan"));
  assert.ok(types.includes("harness.usage"));
  assert.ok(types.includes("harness.permission_requested"));
  assert.ok(types.includes("harness.permission_rejected"));
  assert.ok(!m.events.some((e) => JSON.stringify(e).includes("private chain of thought")), "reasoning 不得落库");
  const textEv = m.events.find((e) => e.eventType === "harness.text.delta");
  assert.equal(textEv.safePayload.chars, 7);
  assert.equal(textEv.safePayload.chunks, 2);
  assert.ok(m.dropped >= 1, "未知事件被丢弃");

  const flood = mapAcpEvents(Array.from({ length: 200 }, (_, i) => ({ type: "tool.proposed", toolCallId: "tc" + i })), { maxPersisted: 5 });
  assert.ok(flood.events.length <= 5);
  assert.ok(flood.dropped >= 195);
});

test("prompt 只含 goal + safe input，且 schema 版本冻结", () => {
  const p = buildPrompt({ goal: "Return exactly: " + EXACT, stepInput: { a: 1 } });
  assert.ok(p.includes(EXACT));
  assert.ok(!/authorization|bearer|api[_-]?key|provider secret/i.test(p));
  assert.equal(typeof PROMPT_SCHEMA_VERSION, "number");
});

test("turn 成功：Artifact + Verification PASS → Step/Task SUCCEEDED", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    assert.ok(t.ok, JSON.stringify(t));
    const orch = fx.makeOrchestrator(stubFactory);
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.task.status, "SUCCEEDED");
    assert.equal(r.step.status, "SUCCEEDED");
    assert.equal(r.artifact.content, EXACT);
    assert.equal(r.verification.status, "PASS");
    const arts = fx.taskService.getArtifacts({ context: fx.ctx(), taskId: t.task.taskId });
    assert.equal(arts.items.length, 1);
    assert.equal(arts.items[0].checksum, r.artifact.checksum);
    const runs = fx.taskService.getHarnessRuns({ context: fx.ctx(), taskId: t.task.taskId });
    assert.equal(runs.items.length, 1);
    assert.equal(runs.items[0].status, "SUCCEEDED");
    assert.equal(orch.lastEvidence.runId, runs.items[0].runId);
  } finally { await fx.close(); }
});

test("成功必须 Verification PASS：文本不符 → BLOCKED 且 0 artifact", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    const orch = fx.makeOrchestrator((opts) => stubFactory({ ...opts, text: "WRONG" }));
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    assert.equal(r.ok, false);
    assert.equal(r.error, "VERIFICATION_FAILED");
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(fx.taskService.getArtifacts({ context: fx.ctx(), taskId: t.task.taskId }).items.length, 0);
  } finally { await fx.close(); }
});

test("Artifact 写入失败：Step/Task 绝不 SUCCEEDED，且无 artifact（失败原子性）", async () => {
  let boom = false;
  const fx = await createTaskHarnessFixture({ hooks: { beforeArtifactInsert() { if (boom) throw new Error("injected artifact write failure"); } } });
  try {
    const t = fx.createTask();
    boom = true;
    const orch = fx.makeOrchestrator(stubFactory);
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision, verify: { type: "EXACT_TEXT", expected: EXACT } });
    assert.equal(r.ok, false);
    assert.notEqual(r.task.status, "SUCCEEDED");
    const task = fx.taskService.getTask({ context: fx.ctx(), taskId: t.task.taskId });
    assert.notEqual(task.task.status, "SUCCEEDED");
    const steps = fx.taskService.getSteps({ context: fx.ctx(), taskId: t.task.taskId });
    assert.notEqual(steps.items[0].status, "SUCCEEDED");
    assert.equal(fx.taskService.getArtifacts({ context: fx.ctx(), taskId: t.task.taskId }).items.length, 0);
  } finally { await fx.close(); }
});

test("Harness crash → BLOCKED + HARNESS_PROCESS_EXITED，0 respawn", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    const orch = fx.makeOrchestrator((opts) => stubFactory({ ...opts, behavior: "crash" }));
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.ok, false);
    assert.equal(r.error, "HARNESS_PROCESS_EXITED");
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(r.task.status, "BLOCKED");
    const runs = fx.taskService.getHarnessRuns({ context: fx.ctx(), taskId: t.task.taskId });
    assert.equal(runs.items.length, 1, "0 respawn / 0 rerun");
    assert.equal(runs.items[0].status, "BLOCKED");
  } finally { await fx.close(); }
});

test("turn timeout → BLOCKED + HARNESS_TURN_TIMEOUT，0 第二次 prompt", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    const orch = fx.makeOrchestrator((opts) => stubFactory({ ...opts, behavior: "timeout" }));
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.error, "HARNESS_TURN_TIMEOUT");
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(r.task.status, "BLOCKED");
    assert.equal(fx.taskService.getHarnessRuns({ context: fx.ctx(), taskId: t.task.taskId }).items.length, 1);
  } finally { await fx.close(); }
});

test("Tool proposal → 0 execution + BLOCKED TOOL_EXECUTION_NOT_AVAILABLE", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    const orch = fx.makeOrchestrator((opts) => stubFactory({ ...opts, behavior: "tool" }));
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.error, "TOOL_EXECUTION_NOT_AVAILABLE");
    assert.equal(r.step.status, "BLOCKED");
    assert.equal(fx.taskService.getArtifacts({ context: fx.ctx(), taskId: t.task.taskId }).items.length, 0);
    const events = fx.taskService.getEvents({ context: fx.ctx(), taskId: t.task.taskId }).items.map((e) => e.eventType);
    assert.ok(events.includes("harness.tool_proposed"));
    assert.ok(!events.includes("step.succeeded"));
  } finally { await fx.close(); }
});

test("Permission request → reject + BLOCKED PERMISSION_NOT_AVAILABLE，0 execution", async () => {
  const fx = await createTaskHarnessFixture();
  try {
    const t = fx.createTask();
    const orch = fx.makeOrchestrator((opts) => stubFactory({ ...opts, behavior: "permission" }));
    const r = await orch.runTask({ context: fx.ctx(), taskId: t.task.taskId, expectedRevision: t.task.revision });
    assert.equal(r.error, "PERMISSION_NOT_AVAILABLE");
    assert.equal(r.step.status, "BLOCKED");
    const events = fx.taskService.getEvents({ context: fx.ctx(), taskId: t.task.taskId }).items.map((e) => e.eventType);
    assert.ok(events.includes("harness.permission_requested"));
    assert.ok(events.includes("harness.permission_rejected"));
  } finally { await fx.close(); }
});
