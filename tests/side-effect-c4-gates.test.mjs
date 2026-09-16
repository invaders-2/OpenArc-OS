/**
 * D4-03C4 · Trusted Approval Gateway + 受控 WRITE production gates。
 *
 * 永久规则：
 *   · Approval 只来自 trusted OpenArc user action；Harness / model / ACP / Renderer 自报字段一律无效；
 *   · Deny / Timeout / Cancel / Revoke / Stale 一律 0 mutation、0 lease、0 execution；
 *   · 只有 Verified Effect 才允许进入 Harness 可见结果。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";

const require = createRequire(import.meta.url);
const { createSideEffectGateway, registerSideEffectIpc } = require("../electron/side-effect-bootstrap.cjs");

const TRASH = "resource.trash";
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });

let seq = 0;
const GATED_EXECUTOR = path.join(import.meta.dirname, "fixtures", "harness-acp", "supervised-executor.mjs");
function waitMessage(box, type, ms) {
  const deadline = Date.now() + ms;
  return (async () => {
    while (Date.now() < deadline) {
      const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");
      const found = RuntimeSupervisor.parseExecutorMessage(box.stdout, type);
      if (found) return found;
      await sleep(20);
    }
    assert.fail("未收到 " + type + "：" + box.stdout + box.stderr);
  })();
}
function waitFor(fn, ms, detail = "") {
  const deadline = Date.now() + ms;
  return (async () => { while (Date.now() < deadline) { if (fn()) return true; await sleep(20); } assert.fail("waitFor 超时：" + detail); })();
}
async function setup({ approvalWaitMs = 400, executorEntry = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c4g-"));
  const fx = await createToolHarnessFixture({
    withAdapters: true, dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"),
    keepData: true, sideEffectRuntimeDir: path.join(root, "runtime"), sideEffectApprovalWaitMs: approvalWaitMs,
    ...(executorEntry ? { sideEffectExecutorEntry: executorEntry } : {}),
  });
  seq += 1;
  const created = await fx.createResource("C4 Gate " + seq);
  const toolGrant = fx.grantTool("ai", ["tool.resource.trash"]);
  const appGrant = fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
  const userGrant = fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
  const run = fx.dshRunSetup();
  return { root, fx, created, toolGrant, appGrant, userGrant, run, resourceRef: created.resource.resourceRef, resourceId: created.resource.resourceId };
}
async function teardown(ctx) { try { await ctx.fx.close(); } catch { /* ignore */ } try { fs.rmSync(ctx.root, { recursive: true, force: true }); } catch { /* ignore */ } }

function propose(ctx, run = null) {
  const r = run || ctx.run;
  return ctx.fx.sideEffectRuntime.proposeWrite({ context: ctx.fx.ctx(), taskId: r.taskId, stepId: r.stepId, runId: r.runId, toolId: TRASH, arguments: { resourceRef: ctx.resourceRef } });
}
const userCtx = (fx) => ({ sessionRef: fx.f.sessions.admin, source: "user" });
function countDelete(fx) {
  const box = { calls: 0 };
  const real = fx.f.resourceService.delete.bind(fx.f.resourceService);
  fx.f.resourceService.delete = (...a) => { box.calls += 1; return real(...a); };
  return box;
}
const trashed = (ctx) => ctx.fx.f.resourceService.sideEffectPrecondition({ resourceRef: ctx.resourceRef }).trashed;

test("Deny → 0 mutation / BLOCKED / 0 lease / 0 execution；Harness 只得到 bounded denied", async () => {
  const ctx = await setup();
  try {
    const dc = countDelete(ctx.fx);
    const planned = await propose(ctx);
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const denied = ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "DENY" });
    assert.equal(denied.ok, true, JSON.stringify(denied));
    const resolved = await ctx.fx.sideEffectRuntime.resolvePendingForStep({ taskId: ctx.run.taskId, stepId: ctx.run.stepId, callIds: [planned.approvalRequestId], timeoutMs: 200 });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.decision, "DENIED");
    assert.equal(ctx.fx.sideEffectStore.callById(planned.approvalRequestId).status, "BLOCKED");
    assert.equal(dc.calls, 0);
    assert.equal(trashed(ctx), false);
    assert.equal(ctx.fx.sideEffectStore.leasesOfCall(planned.approvalRequestId).length, 0);
    assert.equal(ctx.fx.toolStore.executionsOfTask(ctx.run.taskId).length, 0);
  } finally { await teardown(ctx); }
});

test("Approval timeout → 0 mutation / call BLOCKED(APPROVAL_TIMEOUT) / 0 retry", async () => {
  const ctx = await setup({ approvalWaitMs: 150 });
  try {
    const dc = countDelete(ctx.fx);
    const planned = await propose(ctx);
    const resolved = await ctx.fx.sideEffectRuntime.resolvePendingForStep({ taskId: ctx.run.taskId, stepId: ctx.run.stepId, callIds: [planned.approvalRequestId], timeoutMs: 120 });
    assert.equal(resolved.ok, false);
    assert.equal(resolved.decision, "TIMEOUT");
    const call = ctx.fx.sideEffectStore.callById(planned.approvalRequestId);
    assert.equal(call.status, "BLOCKED");
    assert.equal(call.errorCode, "SIDE_EFFECT_APPROVAL_TIMEOUT");
    assert.equal(dc.calls, 0);
    assert.equal(trashed(ctx), false);
    assert.equal(ctx.fx.sideEffectStore.leasesOfCall(planned.approvalRequestId).length, 0);
  } finally { await teardown(ctx); }
});

test("Task Cancel While Waiting → 0 mutation / 0 lease / no later approval can execute", async () => {
  const ctx = await setup({ approvalWaitMs: 5000 });
  try {
    const dc = countDelete(ctx.fx);
    const planned = await propose(ctx);
    const waiting = ctx.fx.sideEffectRuntime.resolvePendingForStep({ taskId: ctx.run.taskId, stepId: ctx.run.stepId, callIds: [planned.approvalRequestId], timeoutMs: 5000 });
    await sleep(60);
    const t = ctx.fx.taskService.getTask({ context: ctx.fx.ctx(), taskId: ctx.run.taskId }).task;
    assert.equal(ctx.fx.taskService.cancelTask({ context: ctx.fx.ctx(), taskId: ctx.run.taskId, expectedRevision: t.revision }).ok, true);
    const resolved = await waiting;
    assert.equal(resolved.ok, false);
    assert.equal(resolved.decision, "CANCELLED");
    assert.equal(dc.calls, 0);
    assert.equal(trashed(ctx), false);
    assert.equal(ctx.fx.sideEffectStore.leasesOfCall(planned.approvalRequestId).length, 0);
    const late = ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" });
    assert.equal(late.ok, false, JSON.stringify(late));
    assert.equal(dc.calls, 0);
  } finally { await teardown(ctx); }
});

test("Session Revoked While Waiting → Approve DENY / 0 execution", async () => {
  const ctx = await setup();
  try {
    const planned = await propose(ctx);
    ctx.fx.f.identity.logout(ctx.fx.f.sessions.admin);
    const r = ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" });
    assert.equal(r.ok, false, JSON.stringify(r));
    const resolved = await ctx.fx.sideEffectRuntime.resolvePendingForStep({ taskId: ctx.run.taskId, stepId: ctx.run.stepId, callIds: [planned.approvalRequestId], timeoutMs: 80 });
    assert.equal(resolved.ok, false);
    assert.equal(ctx.fx.sideEffectStore.callById(planned.approvalRequestId).status !== "SUCCEEDED", true);
    assert.equal(trashed(ctx), false);
    assert.equal(ctx.fx.sideEffectStore.leasesOfCall(planned.approvalRequestId).length, 0);
  } finally { await teardown(ctx); }
});

test("App Disabled While Waiting → claim-time snapshot 拒绝；0 mutation", async () => {
  const ctx = await setup();
  try {
    const dc = countDelete(ctx.fx);
    const planned = await propose(ctx);
    assert.equal(ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
    ctx.fx.f.store.setAppStatus("ai", "disabled");
    const res = await ctx.fx.sideEffectRuntime.executeApproved({ callId: planned.approvalRequestId, holderId: "exec_1" });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(dc.calls, 0, "0 Domain invocation");
    assert.equal(trashed(ctx), false);
    assert.equal(ctx.fx.sideEffectStore.callById(planned.approvalRequestId).status === "SUCCEEDED", false);
  } finally { await teardown(ctx); }
});

test("Tool permission revoked While Waiting → 0 mutation", async () => {
  const ctx = await setup();
  try {
    const dc = countDelete(ctx.fx);
    const planned = await propose(ctx);
    assert.equal(ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
    // 用另一条 tool 权限覆盖同一 TOOL scope grant → tool.resource.trash 被撤销。
    assert.equal(ctx.fx.f.authService.grantAppToolPermission({ context: ctx.fx.f.adminCtx(), appId: "ai", actions: ["tool.resource.search"] }).ok, true);
    const res = await ctx.fx.sideEffectRuntime.executeApproved({ callId: planned.approvalRequestId, holderId: "exec_1" });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(dc.calls, 0);
    assert.equal(trashed(ctx), false);
  } finally { await teardown(ctx); }
});

test("useByAgent revoked While Waiting（non-admin actor）→ 0 mutation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c4g-agent-"));
  const fx = await createToolHarnessFixture({ withAdapters: true, dbPath: path.join(root, "identity.db"), storeRoot: path.join(root, "library"), keepData: true, sideEffectRuntimeDir: path.join(root, "runtime") });
  try {
    seq += 1;
    const created = await fx.createResource("C4 AgentUse " + seq);
    const resourceRef = created.resource.resourceRef;
    fx.grantTool("ai", ["tool.resource.trash"]);
    fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
    const grant = fx.f.authService.grantResourcePermission({ context: fx.f.adminCtx(), principalType: "USER", principalId: fx.f.users.alice, resourceId: created.resource.resourceId, actions: ["resource.delete", "resource.useByAgent"] });
    assert.equal(grant.ok, true, JSON.stringify(grant));
    const aliceCtx = { sessionRef: fx.f.sessions.alice, appId: "ai" };
    const run = fx.dshRunSetup(aliceCtx);
    const box = { calls: 0 };
    const real = fx.f.resourceService.delete.bind(fx.f.resourceService);
    fx.f.resourceService.delete = (...a) => { box.calls += 1; return real(...a); };
    const planned = await fx.sideEffectRuntime.proposeWrite({ context: aliceCtx, taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH, arguments: { resourceRef } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.alice, source: "user" }, approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
    // 撤销 useByAgent：同 principal/resource 重新授权时只保留 resource.delete。
    assert.equal(fx.f.authService.revokeResourcePermission({ context: fx.f.adminCtx(), grantId: grant.grant.id }).ok, true);
    const regrant = fx.f.authService.grantResourcePermission({ context: fx.f.adminCtx(), principalType: "USER", principalId: fx.f.users.alice, resourceId: created.resource.resourceId, actions: ["resource.delete"] });
    assert.equal(regrant.ok, true, JSON.stringify(regrant));
    const res = await fx.sideEffectRuntime.executeApproved({ callId: planned.approvalRequestId, holderId: "exec_1" });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(box.calls, 0, "0 Domain invocation");
    assert.equal(fx.f.resourceService.sideEffectPrecondition({ resourceRef }).trashed, false);
  } finally { await fx.close(); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test("Precondition changed While Waiting → SIDE_EFFECT_PRECONDITION_CHANGED；0 write / 不 silent re-plan", async () => {
  const ctx = await setup();
  try {
    const dc = countDelete(ctx.fx);
    const planned = await propose(ctx);
    assert.equal(ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
    const bumped = await ctx.fx.f.resourceService.replaceText({ context: ctx.fx.f.adminCtx(), resourceRef: ctx.resourceRef, text: "edited", expectedVersion: 1 });
    assert.equal(bumped.ok, true, JSON.stringify(bumped));
    const res = await ctx.fx.sideEffectRuntime.executeApproved({ callId: planned.approvalRequestId, holderId: "exec_1" });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(dc.calls, 0);
    assert.equal(ctx.fx.sideEffectStore.callById(planned.approvalRequestId).status === "SUCCEEDED", false);
    // 不 silent re-plan：仍然只有一个 call。
    assert.equal(ctx.fx.sideEffectStore.callsOfTask(ctx.run.taskId).length, 1);
  } finally { await teardown(ctx); }
});

test("Concurrent Approve click → 单一 authoritative approval transition；1 lease / 1 execution", async () => {
  const ctx = await setup();
  try {
    const dc = countDelete(ctx.fx);
    const planned = await propose(ctx);
    const a = ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" });
    const b = ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal([a, b].filter((r) => r.duplicate !== true).length, 1, "只允许一个 authoritative approval transition");
    assert.equal(ctx.fx.sideEffectStore.approvalsOfCall(planned.approvalRequestId).length, 1, "只允许一行 approval");
    const res = await ctx.fx.sideEffectRuntime.executeApproved({ callId: planned.approvalRequestId, holderId: "exec_1" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(dc.calls, 0, "mutation 只发生在 executor runtime");
    assert.equal(trashed(ctx), true);
    assert.equal(ctx.fx.sideEffectStore.leasesOfCall(planned.approvalRequestId).length, 1, "exactly 1 lease");
  } finally { await teardown(ctx); }
});

test("Concurrent Executor → only one claim / only one ACTIVE lease；mutation exactly 1", async () => {
  const ctx = await setup({ executorEntry: GATED_EXECUTOR });
  const boxes = [];
  try {
    const planned = await propose(ctx);
    assert.equal(ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
    // executor #1：真实 claim 后停在 mutation gate 上（claim 已提交、mutation 未发生）。
    const box1 = ctx.fx.supervisor.spawnExecutor({ callId: planned.approvalRequestId, holderId: "exec_1", dbPath: ctx.fx.sideEffectRuntime.dbPath, storeRoot: ctx.fx.f.storeRoot, timeoutMs: 60000, now: ctx.fx.f.clock() });
    boxes.push(box1);
    await waitMessage(box1, "ready", 30000);
    await waitFor(() => ctx.fx.sideEffectStore.callById(planned.approvalRequestId).status === "RUNNING", 30000, "claim 未提交");
    assert.equal(trashed(ctx), false);

    // executor #2：同一 call 的第二个 executor，必须抢不到 execution authority。
    const box2 = ctx.fx.supervisor.spawnExecutor({ callId: planned.approvalRequestId, holderId: "exec_2", dbPath: ctx.fx.sideEffectRuntime.dbPath, storeRoot: ctx.fx.f.storeRoot, timeoutMs: 60000, now: ctx.fx.f.clock() });
    boxes.push(box2);
    const r2 = await waitMessage(box2, "ready", 30000);
    await box2.done;
    assert.equal(r2.leaseOk, false, JSON.stringify(r2));
    assert.ok(["SIDE_EFFECT_LEASE_CONFLICT", "SIDE_EFFECT_CALL_STATE", "SIDE_EFFECT_LEASE_REQUIRED"].includes(r2.leaseError), JSON.stringify(r2));
    assert.equal(trashed(ctx), false, "loser 不得产生任何 mutation");
    assert.equal(ctx.fx.sideEffectStore.callById(planned.approvalRequestId).status, "RUNNING", "winner 的 claim 不得被 loser 破坏");

    // 放行 winner 的真实 mutation。
    box1.child.stdin.write("MUTATE\n");
    const done = await waitMessage(box1, "mutation_done", 30000);
    assert.equal(done.deleteCalls, 1);
    const final = await waitMessage(box1, "unknown_effect", 30000);
    assert.equal(final.status, "SUCCEEDED", JSON.stringify(final));
    box1.child.kill("SIGKILL");
    await box1.done;

    assert.equal(trashed(ctx), true);
    assert.equal(ctx.fx.sideEffectStore.callById(planned.approvalRequestId).status, "SUCCEEDED");
    assert.equal(ctx.fx.sideEffectStore.callsOfTask(ctx.run.taskId).length, 1, "只有一个 SideEffectCall authority");
    assert.equal(ctx.fx.sideEffectStore.leasesOfCall(planned.approvalRequestId).filter((l) => l.status === "ACTIVE").length, 0, "0 ACTIVE lease leak");
    assert.equal(ctx.fx.f.resourceService.sideEffectPrecondition({ resourceRef: ctx.resourceRef }).registryStatus, "deleted");
  } finally {
    for (const b of boxes) { try { b.child.kill("SIGKILL"); } catch { /* ignore */ } }
    await teardown(ctx);
  }
});

test("Approval Revocation Race：APPROVED 后 claim 前 REVOKED → 0 Domain invocation", async () => {
  const ctx = await setup();
  try {
    const dc = countDelete(ctx.fx);
    const planned = await propose(ctx);
    assert.equal(ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
    assert.equal(ctx.fx.sideEffectAuthority.revokeApproval({ context: userCtx(ctx.fx), callId: planned.approvalRequestId }).ok, true);
    const res = await ctx.fx.sideEffectRuntime.executeApproved({ callId: planned.approvalRequestId, holderId: "exec_1" });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(dc.calls, 0);
    assert.equal(trashed(ctx), false);
  } finally { await teardown(ctx); }
});

test("Task Cancel Race：executor eligibility 窗口内 cancel → 0 Domain invocation", async () => {
  const ctx = await setup();
  try {
    const dc = countDelete(ctx.fx);
    const planned = await propose(ctx);
    assert.equal(ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" }).ok, true);
    const execPromise = ctx.fx.sideEffectRuntime.executeApproved({ callId: planned.approvalRequestId, holderId: "exec_1" });
    // executor runtime 启动期间取消 Task（真实 race）。
    const t = ctx.fx.taskService.getTask({ context: ctx.fx.ctx(), taskId: ctx.run.taskId }).task;
    ctx.fx.taskService.cancelTask({ context: ctx.fx.ctx(), taskId: ctx.run.taskId, expectedRevision: t.revision });
    const res = await execPromise;
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(dc.calls, 0, "0 Domain invocation");
    assert.equal(trashed(ctx), false);
  } finally { await teardown(ctx); }
});

test("Harness spoof through production WRITE route → denied / 0 SideEffectCall", async () => {
  const ctx = await setup();
  try {
    for (const spoof of [{ resourceRef: ctx.resourceRef, approved: true }, { resourceRef: ctx.resourceRef, approvalId: "x" }, { resourceRef: ctx.resourceRef, leaseId: "x" }, { resourceRef: ctx.resourceRef, callId: "x" }, { resourceRef: ctx.resourceRef, idempotencyKey: "x" }, { resourceRef: ctx.resourceRef, risk: "READ_ONLY" }, { resourceRef: ctx.resourceRef, requiresApproval: false }]) {
      const r = await ctx.fx.sideEffectRuntime.proposeWrite({ context: ctx.fx.ctx(), taskId: ctx.run.taskId, stepId: ctx.run.stepId, runId: ctx.run.runId, toolId: TRASH, arguments: spoof });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error, "TOOL_ARGUMENT_INVALID", JSON.stringify(r));
    }
    assert.equal(ctx.fx.sideEffectStore.callsOfTask(ctx.run.taskId).length, 0);
    assert.equal(trashed(ctx), false);
  } finally { await teardown(ctx); }
});

test("Duplicate tool delivery → 只有一个 SideEffectCall / 一个 idempotencyKey；0 second mutation", async () => {
  const ctx = await setup();
  try {
    const first = await propose(ctx);
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await propose(ctx);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.duplicate, true);
    assert.equal(second.approvalRequestId, first.approvalRequestId);
    assert.equal(ctx.fx.sideEffectStore.callsOfTask(ctx.run.taskId).length, 1);
  } finally { await teardown(ctx); }
});

/* ------------------------------------------------------------------ gateway / UI trust boundary */

function fakeIpc() {
  const handlers = new Map();
  return {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    invoke: (channel, event, payload) => handlers.get(channel)(event, payload),
    has: (channel) => handlers.has(channel),
  };
}

test("Trusted Approval Gateway：untrusted sender 抛错；unknown command 拒绝；Renderer 自报 actor 被忽略", async () => {
  const ctx = await setup();
  try {
    const gateway = createSideEffectGateway({ sideEffectRuntime: ctx.fx.sideEffectRuntime });
    const ipc = fakeIpc();
    let trusted = false;
    const identity = { current: ctx.fx.f.sessions.admin };
    registerSideEffectIpc({ ipcMain: ipc.ipcMain, service: gateway, identity, isTrusted: () => trusted });
    assert.equal(ipc.has("sideeffect:command"), true);
    await assert.rejects(() => ipc.invoke("sideeffect:command", {}, { type: "sideEffect/listPending" }), /Forbidden/);
    trusted = true;
    assert.equal((await ipc.invoke("sideeffect:command", {}, { type: "sideEffect/nope" })).error, "INVALID_INPUT");
    assert.equal((await ipc.invoke("sideeffect:command", {}, null)).error, "INVALID_INPUT");

    const planned = await propose(ctx);
    const pending = await ipc.invoke("sideeffect:command", {}, { type: "sideEffect/listPending" });
    assert.equal(pending.ok, true);
    assert.equal(pending.items.length, 1);
    assert.equal(pending.items[0].approvalRequestId, planned.approvalRequestId);
    // Renderer 注入 userId / role / appId / sessionRef / risk / planHash → 一律忽略，仍用当前会话。
    const decided = await ipc.invoke("sideeffect:command", {}, { type: "sideEffect/decideApproval", approvalRequestId: planned.approvalRequestId, decision: "APPROVE", userId: "u_attacker", role: "ADMIN", appId: "evil", sessionRef: "sess_evil", riskClass: "READ_ONLY", planHash: "x" });
    assert.equal(decided.ok, true, JSON.stringify(decided));
    const approval = ctx.fx.sideEffectStore.latestApprovalOfCall(planned.approvalRequestId);
    assert.equal(approval.actorUserId, ctx.fx.f.users.admin, "actor 只能来自当前 authenticated session");
    assert.equal(approval.sessionRef, ctx.fx.f.sessions.admin);
    assert.equal(approval.planHash, ctx.fx.sideEffectStore.callById(planned.approvalRequestId).planHash, "planHash 由 main process 推导");
  } finally { await teardown(ctx); }
});

test("Approval Snapshot：safe 投影（无 secret / 路径 / store root）；terminal 或跨 session → 不返回", async () => {
  const ctx = await setup();
  try {
    const planned = await propose(ctx);
    const snap = ctx.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId });
    assert.equal(snap.approvalRequestId, planned.approvalRequestId);
    assert.equal(snap.toolId, TRASH);
    assert.equal(snap.toolDisplayName, "Trash Resource");
    assert.equal(snap.riskClass, "REVERSIBLE_WRITE");
    assert.equal(snap.effectClass, "REVERSIBLE_WRITE");
    assert.equal(snap.resourceRef, ctx.resourceRef);
    assert.equal(snap.targetDisplayName, "C4 Gate " + seq);
    assert.equal(snap.expectedVersion, 1);
    const text = JSON.stringify(snap);
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders/.test(text), "快照不得含绝对路径");
    assert.ok(!text.includes(ctx.fx.f.storeRoot), "快照不得含 store root");
    assert.ok(!/"(secret|token|authorization|api[_-]?key|credential|password|capability)"/i.test(text));
    // §44：跨 session 不得拿到别人的 approval 请求。
    assert.equal(ctx.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId, context: { sessionRef: ctx.fx.f.sessions.alice } }), null);
    // §46：terminal 后刷新 → DENY。
    assert.equal(ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "DENY" }).ok, true);
    assert.equal(ctx.fx.sideEffectRuntime.approvalSnapshot({ approvalRequestId: planned.approvalRequestId }), null);
    const late = ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" });
    assert.equal(late.ok, false, "不得 revive old call");
  } finally { await teardown(ctx); }
});


/* ------------------------------------------------------------------ bridge route / static audit */

test("Tool Facade Bridge WRITE route：只产生 SideEffect Proposal；WRITE 绝不经 READ_ONLY execution route", async () => {
  const ctx = await setup();
  let bridge = null;
  try {
    const { ToolFacadeBridge } = require("../electron/tool-facade-bridge.cjs");
    const { buildBridgeManifest, buildWriteToolManifest, ROUTE } = require("../electron/tool-registry.cjs");
    const manifest = buildBridgeManifest(ctx.fx.toolProxy.registry, { readToolIds: ["resource.search", "resource.read.metadata"], writeToolIds: ["resource.trash"] });
    assert.equal(manifest.routes["resource.trash"], ROUTE.SIDE_EFFECT_PROPOSAL, "WRITE 必须走 side-effect proposal route");
    assert.equal(manifest.routes["resource.search"], ROUTE.READ_ONLY);
    // §11：WRITE 不得被塞进 READ_ONLY facade。
    assert.throws(() => buildWriteToolManifest(ctx.fx.toolProxy.registry, { toolIds: ["resource.search"] }), /REVERSIBLE_WRITE/);
    bridge = new ToolFacadeBridge({ toolProxy: ctx.fx.toolProxy, manifest, sideEffectRuntime: ctx.fx.sideEffectRuntime });
    await bridge.start();
    const cap = bridge.issueCapability({ context: ctx.fx.ctx(), taskId: ctx.run.taskId, stepId: ctx.run.stepId, runId: ctx.run.runId, allowedTools: manifest.toolIds, maxCalls: 4 });
    assert.equal(cap.ok, true, JSON.stringify(cap));
    const res = await fetch(bridge.baseUrl + "/tool-call", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + cap.capability.token },
      body: JSON.stringify({ toolId: TRASH, arguments: { resourceRef: ctx.resourceRef }, callId: "c4gate_write_1" }),
    });
    const json = await res.json();
    assert.equal(json.ok, false, JSON.stringify(json));
    assert.equal(json.error, "SIDE_EFFECT_APPROVAL_REQUIRED");
    assert.equal(json.approvalRequired, true);
    assert.equal(bridge.stats.domainExecutions, 0, "WRITE 绝不经 READ_ONLY execution route");
    assert.equal(bridge.stats.sideEffectProposals, 1);
    assert.equal(ctx.fx.toolStore.executionsOfTask(ctx.run.taskId).length, 0, "0 execution row");
    assert.equal(trashed(ctx), false, "0 mutation");
    assert.equal(ctx.fx.sideEffectStore.callsOfTask(ctx.run.taskId).length, 1, "只产生一条 SideEffectCall");
  } finally {
    try { if (bridge) await bridge.stop(); } catch { /* ignore */ }
    await teardown(ctx);
  }
});

test("No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点在 allowlisted adapter + controlled execution 内", async () => {
  const root = path.join(import.meta.dirname, "..");
  // Harness / Renderer / Approval UI / ACP plugin / Bridge / Runtime / Supervisor 都不得持有 Domain write。
  const forbidden = [
    "electron/tool-facade-bridge.cjs",
    "electron/side-effect-runtime.cjs",
    "electron/side-effect-bootstrap.cjs",
    "electron/runtime-supervisor.cjs",
    "electron/side-effect-executor.cjs",
    "electron/preload.cjs",
    "electron/harness-adapter.cjs",
    "electron/dsh-openarc-read-tools/index.js",
    "src/approval/ApprovalPrompt.tsx",
  ];
  for (const rel of forbidden) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    assert.ok(!/resourceService\s*\.\s*delete/.test(text), rel + " 不得直接调用 ResourceService.delete");
    assert.ok(!/ResourceService\s*\./.test(text), rel + " 不得持有 ResourceService");
  }
  // 唯一调用点：allowlisted Tool Adapter。
  const adapter = fs.readFileSync(path.join(root, "electron/tool-adapters.cjs"), "utf8");
  assert.equal((adapter.match(/resourceService\.delete\s*\(/g) || []).length, 1, "只允许一个真实 mutation 调用点");
  // 它只能由 SideEffectAuthority 的受控执行路径 dispatch。
  const authority = fs.readFileSync(path.join(root, "electron/side-effect-authority.cjs"), "utf8");
  assert.ok(/adapter\.execute\(/.test(authority), "controlled write 必须经 adapter.execute");
  const proxy = fs.readFileSync(path.join(root, "electron/controlled-tool-proxy.cjs"), "utf8");
  assert.ok(/riskClass !== "READ_ONLY"/.test(proxy) && /adapter\.execute\(/.test(proxy), "READ_ONLY route 必须显式拒绝非 READ_ONLY");
  // 生产 runtime 只经受监督 executor 执行，绝不在主进程 in-process 执行 write。
  const runtime = fs.readFileSync(path.join(root, "electron/side-effect-runtime.cjs"), "utf8");
  assert.ok(/supervisor\.spawnExecutor\(/.test(runtime), "production write 必须经 supervisor.spawnExecutor");
  assert.ok(!/authority\.executeSideEffect\(/.test(runtime), "主进程绝不 in-process 执行 write");
});

test("WRITE tool result 投影只含 safe 字段（无绝对路径 / DB id / lease / capability）", async () => {
  const ctx = await setup();
  try {
    const planned = await propose(ctx);
    ctx.fx.sideEffectRuntime.decideApproval({ context: userCtx(ctx.fx), approvalRequestId: planned.approvalRequestId, decision: "APPROVE" });
    const res = await ctx.fx.sideEffectRuntime.executeApproved({ callId: planned.approvalRequestId, holderId: "exec_1" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(Object.keys(res.safeResult).sort(), ["resourceRef", "trashed", "verified", "version"]);
    const text = JSON.stringify(res.safeResult);
    assert.ok(!/\/Users\/|\/private\/|\/var\/folders/.test(text));
    assert.ok(!text.includes(ctx.fx.f.storeRoot));
    assert.ok(!/slease_|tappr_|scall_/i.test(text), "不得泄漏内部 authority id");
  } finally { await teardown(ctx); }
});
