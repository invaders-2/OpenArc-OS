/**
 * 10-16 · 素材库 AI：resource.read.content（只读正文）与 resource.save.text（文本写回，需审批）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
import { createSideEffectFixture } from "./fixtures/harness-acp/side-effect-fixture.mjs";
import { READ_TOOL_IDS, WRITE_TOOL_IDS } from "../electron/dsh-tool-profile.cjs";

const SAVE = "resource.save.text";

test("allowlist：read.content 在只读面、save.text 在写入面", () => {
  assert.ok(READ_TOOL_IDS.includes("resource.read.content"));
  assert.ok(WRITE_TOOL_IDS.includes(SAVE));
  assert.ok(!READ_TOOL_IDS.includes(SAVE));
});

async function readSetup() {
  const fx = await createToolHarnessFixture({ withAdapters: true });
  fx.grantTool("ai", ["tool.resource.readContent"]);
  const ctx = fx.ctx();
  const t = fx.createTask();
  fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
  return { fx, ctx, taskId: t.task.taskId };
}

test("read.content：文本资源返回正文；maxChars 截断并标记 truncated", async () => {
  const { fx, ctx, taskId } = await readSetup();
  try {
    const body = "第一行\n" + "素材库正文".repeat(200);
    const created = await fx.f.resourceService.createResource({ context: fx.f.adminCtx(), resourceType: "text", name: "笔记", content: body });
    assert.equal(created.ok, true, JSON.stringify(created));
    const ref = created.resource.resourceRef;
    fx.toolProxy.propose({ context: ctx, taskId, toolId: "resource.read.content", toolVersion: 1, arguments: { resourceRef: ref }, proposalId: "rc_full" });
    const full = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "rc_full" });
    assert.equal(full.ok, true, JSON.stringify(full));
    assert.equal(full.result.contentKind, "text");
    assert.equal(full.result.text, body);
    assert.equal(full.result.truncated, false);

    fx.toolProxy.propose({ context: ctx, taskId, toolId: "resource.read.content", toolVersion: 1, arguments: { resourceRef: ref, maxChars: 200 }, proposalId: "rc_cut" });
    const cut = await fx.toolProxy.executeReadOnly({ context: ctx, taskId, proposalId: "rc_cut" });
    assert.equal(cut.ok, true, JSON.stringify(cut));
    assert.equal(cut.result.text.length, 200);
    assert.equal(cut.result.truncated, true);
  } finally { await fx.close(); }
});

test("read.content：没有 tool.resource.readContent 授权 → 拒绝且不读内容", async () => {
  const fx = await createToolHarnessFixture({ withAdapters: true });
  try {
    const ctx = fx.ctx();
    const t = fx.createTask();
    fx.taskService.startTask({ context: ctx, taskId: t.task.taskId, expectedRevision: t.task.revision });
    const created = await fx.createResource("无授权");
    let reads = 0;
    const orig = fx.f.resourceService.readTextBounded.bind(fx.f.resourceService);
    fx.f.resourceService.readTextBounded = (...a) => { reads += 1; return orig(...a); };
    fx.toolProxy.propose({ context: ctx, taskId: t.task.taskId, toolId: "resource.read.content", toolVersion: 1, arguments: { resourceRef: created.resource.resourceRef }, proposalId: "rc_deny" });
    const r = await fx.toolProxy.executeReadOnly({ context: ctx, taskId: t.task.taskId, proposalId: "rc_deny" });
    assert.equal(r.ok, false);
    assert.equal(reads, 0);
  } finally { await fx.close(); }
});

async function saveFlow(sfx, run, args) {
  const prop = sfx.toolProxy.propose({ context: sfx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: SAVE, toolVersion: 1, arguments: args });
  const plan = await sfx.authority.planSideEffect({ context: sfx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: SAVE, arguments: args, proposalId: prop.proposal ? prop.proposal.proposalId : null, decisionId: prop.decision ? prop.decision.decisionId : null });
  const approval = plan.ok ? sfx.approve(plan.call.callId) : null;
  const lease = plan.ok ? sfx.lease(plan.call.callId, { holderId: "exec_1" }) : null;
  const l = lease && lease.ok ? lease.lease : null;
  return { prop, plan, approval, lease, callId: plan.ok ? plan.call.callId : null, execId: plan.ok && l ? { callId: plan.call.callId, leaseId: l.leaseId, holderId: l.holderId || "exec_1", holderInstanceId: l.holderInstanceId } : null };
}

test("save.text：Proposal→审批→执行→复读校验，资源库多出一条生成来源的文本资源", async () => {
  const sfx = await createSideEffectFixture();
  try {
    sfx.grantTool("ai", ["tool.resource.saveText"]);
    const run = sfx.setupRun();
    const content = "# 周报\n\n本周完成了素材库 AI 写回。";
    const flow = await saveFlow(sfx, run, { name: "周报", content });
    assert.equal(flow.prop.decisionStatus, "APPROVAL_REQUIRED", JSON.stringify(flow.prop));
    assert.equal(flow.plan.ok, true, JSON.stringify(flow.plan));
    assert.equal(flow.plan.call.effectClass, "REVERSIBLE_WRITE");
    assert.equal(flow.plan.call.preconditionsSafe.name, "周报.md");
    assert.equal(flow.approval.ok, true, JSON.stringify(flow.approval));
    assert.equal(flow.lease.ok, true, JSON.stringify(flow.lease));
    const exec = await sfx.authority.executeSideEffect({ ...flow.execId });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(exec.call.status, "SUCCEEDED");
    assert.equal(exec.call.verificationStatus, "PASS");
    const found = sfx.fx.f.resourceService.generatedByCall({ callId: flow.callId });
    assert.equal(found.found, true);
    const text = await sfx.fx.f.resourceService.readText({ context: sfx.fx.f.adminCtx(), resourceRef: found.resourceRef });
    assert.equal(text.ok, true, JSON.stringify(text));
    assert.equal(text.text, content);

    // 恢复核验：按 callId 判定 APPLIED。
    const adapter = sfx.adapters.adapterFor({ executionProvider: "ResourceContent", toolId: SAVE });
    const rv = await adapter.recoveryVerify({ call: { toolId: SAVE, callId: flow.callId } });
    assert.equal(rv.outcome, "APPLIED");
    const none = await adapter.recoveryVerify({ call: { toolId: SAVE, callId: "sec_never" } });
    assert.equal(none.outcome, "NOT_APPLIED");
  } finally { await sfx.fx.close(); }
});

test("save.text：同一 callId 重放复用已有资源，不产生第二份", async () => {
  const sfx = await createSideEffectFixture();
  try {
    const adapter = sfx.adapters.adapterFor({ executionProvider: "ResourceContent", toolId: SAVE });
    const contract = sfx.toolRegistry.get(SAVE, 1);
    const ctx = sfx.fx.f.adminCtx();
    const args = { name: "重复", content: "同一段内容" };
    const plan = await adapter.plan({ args, contract });
    const a = await adapter.execute({ context: ctx, args, contract, preconditions: plan.preconditions, callId: "sec_same" });
    const b = await adapter.execute({ context: ctx, args, contract, preconditions: plan.preconditions, callId: "sec_same" });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(b.result.reused, true);
    assert.equal(a.result.resourceRef, b.result.resourceRef);
    // 执行只认 plan 里持久化的正文：Harness 入参换了内容也不影响写入的是审批过的那份。
    const d = await adapter.execute({ context: ctx, args: { ...args, content: "被改过" }, contract, preconditions: plan.preconditions, callId: "sec_args" });
    assert.equal(d.ok, true, JSON.stringify(d));
    const dText = await sfx.fx.f.resourceService.readText({ context: ctx, resourceRef: d.result.resourceRef });
    assert.equal(dText.text, "同一段内容");
    // 持久化的正文被篡改（与 plan 的哈希不一致）→ 已知无效果，不写入。
    const c = await adapter.execute({ context: ctx, args, contract, preconditions: { ...plan.preconditions, content: "被改过" }, callId: "sec_other" });
    assert.equal(c.ok, false);
    assert.equal(c.knownNoEffect, true);
  } finally { await sfx.fx.close(); }
});
