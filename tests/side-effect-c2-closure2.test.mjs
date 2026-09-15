/**
 * D4-03C2 Closure-2 · Runtime Instance Authority + Exact Lease Binding。
 *
 * 关闭两个 blocker：
 *  1. runtime identity 只来自 SideEffectAuthority.instanceId（caller 不能自报 holderInstanceId）。
 *  2. exact leaseId 必须在 claim 的同一个原子事务内重新验证（旧 lease 不能借新 lease 执行）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createSideEffectFixture, TRASH_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";
import { createToolHarnessFixture } from "./fixtures/harness-acp/tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { SideEffectStore } = require("../electron/side-effect-store.cjs");
const { SideEffectAuthority } = require("../electron/side-effect-authority.cjs");

const CONTENDER = path.join(import.meta.dirname, "fixtures", "harness-acp", "claim-contender.mjs");
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && typeof t.unref === "function") t.unref(); });

function countDeleteCalls(fx) {
  const real = fx.fx.f.resourceService.delete.bind(fx.fx.f.resourceService);
  const box = { calls: 0 };
  fx.fx.f.resourceService.delete = (args) => { box.calls += 1; return real(args); };
  return box;
}

async function readyTrash(opts = {}) {
  const fx = await createSideEffectFixture(opts);
  const sc = await fx.setupTrash();
  const dc = countDeleteCalls(fx);
  const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run, holderId: opts.holderId || "exec_1", instanceId: opts.instanceId });
  const l = flow.lease.lease;
  const execId = { callId: flow.callId, leaseId: l.leaseId, holderId: l.holderId };
  return { fx, sc, dc, flow, execId, l, owner: fx.authority.instanceId };
}
const close = (r) => r.fx.fx.close();

test("Runtime instance authority：Runtime A 拥有 Lease，Runtime B（知道 instA）不能执行", async () => {
  const r = await readyTrash({ sideEffectInstanceId: "instA" });
  try {
    assert.equal(r.owner, "instA");
    assert.equal(r.l.holderInstanceId, "instA");
    // Runtime B：同一 disk store，但 instanceId=instB；即使自报 holderInstanceId="instA" 也无效。
    const authorityB = new SideEffectAuthority({
      registry: r.fx.toolRegistry, sideEffectStore: r.fx.store, taskStore: r.fx.taskStore, toolStore: r.fx.toolStore,
      authService: r.fx.authService, adapters: r.fx.adapters, clock: () => r.fx.fx.f.clock(), taskService: r.fx.taskService, instanceId: "instB",
    });
    const execB = authorityB.executeSideEffect({ ...r.execId, holderInstanceId: "instA" });
    assert.equal(execB.ok, false);
    assert.equal(execB.error, "SIDE_EFFECT_LEASE_NOT_HELD");
    assert.equal(execB.mutationCount, 0);
    assert.equal(r.dc.calls, 0, "Runtime B 绝不能 dispatch Domain");
    assert.equal(r.fx.store.callById(r.execId.callId).status, "LEASED", "Runtime B 从未进入 claim");

    // Runtime A 仍能执行 → 证明拒绝来自 runtime identity，而不是其它 gate。
    const execA = await r.fx.authority.executeSideEffect({ ...r.execId });
    assert.equal(execA.ok, true, JSON.stringify(execA));
    assert.equal(r.dc.calls, 1);
  } finally { await close(r); }
});

test("Exact leaseId authority：missing / wrong leaseId → DENY + 0 mutation，正确 leaseId → 成功", async () => {
  const r = await readyTrash();
  try {
    assert.equal(r.fx.elig(r.execId.callId, { holderId: r.execId.holderId, leaseId: r.execId.leaseId }).status, "ELIGIBLE");
    const missing = r.fx.authority.executeSideEffect({ ...r.execId, leaseId: null });
    assert.equal(missing.error, "SIDE_EFFECT_LEASE_NOT_HELD");
    assert.equal(missing.detail, "EXECUTOR_IDENTITY_REQUIRED");
    const wrong = r.fx.authority.executeSideEffect({ ...r.execId, leaseId: "slease_wrong" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, "SIDE_EFFECT_LEASE_NOT_HELD");
    assert.equal(wrong.mutationCount, 0);
    assert.equal(r.dc.calls, 0);
    // eligibility 也必须拒绝不匹配的 leaseId。
    assert.equal(r.fx.elig(r.execId.callId, { holderId: r.execId.holderId, leaseId: "slease_wrong" }).reasonCode, "SIDE_EFFECT_LEASE_NOT_HELD");
    const ok = await r.fx.authority.executeSideEffect({ ...r.execId });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(r.dc.calls, 1);
  } finally { await close(r); }
});

test("Lease replacement race：lease_A revoke + lease_B acquire（同 holder/同 runtime）→ 旧 lease_A invocation DENY，fresh lease_B 才可执行", async () => {
  let acquiredB = null;
  let hook = null;
  const fx = await createSideEffectFixture({ sideEffectTestHooks: { afterEligibilityBeforeClaim: (info) => { if (hook) hook(info); } } });
  try {
    const sc = await fx.setupTrash();
    const dc = countDeleteCalls(fx);
    const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run });
    const leaseA = flow.lease.lease;
    const execA = { callId: flow.callId, leaseId: leaseA.leaseId, holderId: leaseA.holderId };
    // race 前真实 ELIGIBLE。
    assert.equal(fx.elig(flow.callId, { holderId: leaseA.holderId, leaseId: leaseA.leaseId }).status, "ELIGIBLE");

    // 在 eligibility 之后、claim 之前：revoke lease_A + acquire lease_B（同 holderId / 同 runtime instance）。
    hook = () => {
      assert.equal(fx.authority.revokeLease({ callId: flow.callId, leaseId: leaseA.leaseId }).ok, true);
      const b = fx.authority.acquireLease({ context: fx.ctx(), callId: flow.callId, holderId: leaseA.holderId, ttlMs: 600000 });
      assert.equal(b.ok, true, JSON.stringify(b));
      assert.notEqual(b.lease.leaseId, leaseA.leaseId, "必须是新的 lease authority");
      assert.equal(b.lease.holderId, leaseA.holderId);
      assert.equal(b.lease.holderInstanceId, leaseA.holderInstanceId);
      acquiredB = b.lease;
    };
    const old = await fx.authority.executeSideEffect({ ...execA });
    assert.equal(old.ok, false, JSON.stringify(old));
    assert.equal(old.error, "SIDE_EFFECT_LEASE_NOT_HELD", "旧 lease_A 不能借用 lease_B 执行");
    assert.equal(old.mutationCount, 0);
    assert.equal(dc.calls, 0, "0 Domain invocation");
    assert.equal(fx.store.callById(flow.callId).status, "LEASED", "claim 必须被拒绝");

    // 只有携带 lease_B 的全新 invocation，重新通过完整 gate 后才允许执行。
    const fresh = await fx.authority.executeSideEffect({ callId: flow.callId, leaseId: acquiredB.leaseId, holderId: acquiredB.holderId });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal(fresh.mutationCount, 1);
    assert.equal(dc.calls, 1);
    assert.equal(fx.store.callById(flow.callId).status, "SUCCEEDED");
    assert.equal(fx.store.activeLeaseOfCall(flow.callId), null);
  } finally { await fx.fx.close(); }
});

test("Same-runtime duplicate delivery：同一 runtime 两次 invocation → 1 claim / 1 Domain invocation / 1 mutation", async () => {
  const r = await readyTrash();
  try {
    // 同一 authority / 同一 this.instanceId / 同一 callId+leaseId+holderId 的重复投递。
    const p1 = r.fx.authority.executeSideEffect({ ...r.execId });
    const p2 = r.fx.authority.executeSideEffect({ ...r.execId });
    const [a, b] = await Promise.all([p1, p2]);
    const winners = [a, b].filter((x) => x.ok === true && x.executed === true);
    const losers = [a, b].filter((x) => !(x.ok === true && x.executed === true));
    assert.equal(winners.length, 1, JSON.stringify([a, b]));
    assert.equal(losers.length, 1, JSON.stringify([a, b]));
    assert.equal(losers[0].error, "SIDE_EFFECT_EXECUTION_CLAIM_LOST", JSON.stringify(losers[0]));
    assert.equal(r.dc.calls, 1, "Domain invocation 必须恰好 1");
    assert.equal(r.fx.store.callById(r.execId.callId).status, "SUCCEEDED");
    assert.equal(r.fx.store.activeLeaseOfCall(r.execId.callId), null);
  } finally { await close(r); }
});

test("Cross-runtime non-owner：Runtime B 永远到不了 claim（0 Domain invocation）", async () => {
  const r = await readyTrash({ sideEffectInstanceId: "instA" });
  try {
    const before = r.fx.store.callById(r.execId.callId).status;
    const authorityB = new SideEffectAuthority({
      registry: r.fx.toolRegistry, sideEffectStore: r.fx.store, taskStore: r.fx.taskStore, toolStore: r.fx.toolStore,
      authService: r.fx.authService, adapters: r.fx.adapters, clock: () => r.fx.fx.f.clock(), taskService: r.fx.taskService, instanceId: "instB",
    });
    const execB = authorityB.executeSideEffect({ callId: r.execId.callId, leaseId: r.execId.leaseId, holderId: r.execId.holderId });
    assert.equal(execB.ok, false);
    assert.ok(["SIDE_EFFECT_LEASE_NOT_HELD", "SIDE_EFFECT_LEASE_REQUIRED"].includes(execB.error), execB.error);
    assert.equal(execB.mutationCount, 0);
    assert.equal(r.dc.calls, 0);
    assert.equal(r.fx.store.callById(r.execId.callId).status, before, "call 状态未被改动");
  } finally { await close(r); }
});

test("Claim-time approval exact binding：toolId/version/effectClass 被篡改 → claim DENY", async () => {
  let hook = null;
  const fx = await createSideEffectFixture({ sideEffectTestHooks: { afterEligibilityBeforeClaim: (info) => { if (hook) hook(info); } } });
  try {
    const sc = await fx.setupTrash();
    const dc = countDeleteCalls(fx);
    const flow = await fx.trashFlow({ ref: sc.resourceRef, run: sc.run });
    const l = flow.lease.lease;
    const execId = { callId: flow.callId, leaseId: l.leaseId, holderId: l.holderId };
    assert.equal(fx.elig(flow.callId, { holderId: l.holderId, leaseId: l.leaseId }).status, "ELIGIBLE");
    hook = () => {
      const far = Date.now() + 100_000;
      fx.store.transactSync(() => fx.store.insertApproval({ callId: flow.callId, actorUserId: "u", sessionRef: fx.fx.f.sessions.admin, decision: "APPROVED", planHash: fx.store.callById(flow.callId).planHash, approvedToolId: "other.tool", approvedToolVersion: 1, approvedArgumentsHash: fx.store.callById(flow.callId).argumentsHash, approvedEffectClass: "REVERSIBLE_WRITE", createdAt: far, expiresAt: far + 100_000 }));
    };
    const exec = await fx.authority.executeSideEffect({ ...execId });
    assert.equal(exec.ok, false, JSON.stringify(exec));
    assert.equal(exec.error, "SIDE_EFFECT_PLAN_STALE");
    assert.equal(exec.mutationCount, 0);
    assert.equal(dc.calls, 0);
    assert.equal(fx.store.callById(flow.callId).status, "LEASED");
  } finally { await fx.fx.close(); }
});

/* ---------------------------------------------- real cross-process runtime impersonation */

function spawnContender(args) {
  const child = spawn(process.execPath, [CONTENDER, JSON.stringify(args)], { stdio: ["pipe", "pipe", "pipe"] });
  const box = { child, ready: false, result: null, deleteCalls: null, stderr: "" };
  let buf = "";
  box.done = new Promise((resolve) => {
    child.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg = null; try { msg = JSON.parse(line); } catch { msg = null; }
        if (!msg) continue;
        if (msg.type === "ready") box.ready = true;
        if (msg.type === "result") { box.result = msg.result; box.deleteCalls = msg.deleteCalls; resolve(true); }
      }
    });
    child.on("exit", () => resolve(box.result != null));
  });
  child.stderr.on("data", (d) => { box.stderr += String(d); });
  child.stdin.on("error", () => { /* child 已退出时忽略 EPIPE */ });
  return box;
}
async function waitReady(box, ms) {
  const deadline = Date.now() + ms;
  while (!box.ready && Date.now() < deadline) await sleep(20);
  assert.ok(box.ready, "executor 未就绪: " + box.stderr);
}
async function waitExit(box, ms) {
  if (box.child.exitCode != null || box.child.signalCode != null) return;
  await Promise.race([new Promise((r) => box.child.once("exit", r)), sleep(ms)]);
}

test("Cross-process impersonation：Runtime B 知道 instA 字符串，仍不能执行 Runtime A 的 lease", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-c2-c2-"));
  const dbPath = path.join(root, "identity.db");
  let state = null;
  const children = [];
  try {
    const fx = await createToolHarnessFixture({ withAdapters: true, dbPath, keepData: true, sideEffectInstanceId: "instA" });
    const created = await fx.createResource("C2 Impersonation Target");
    const resourceRef = created.resource.resourceRef;
    fx.grantTool("ai", ["tool.resource.trash"]);
    fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId: created.resource.resourceId, actions: ["resource.delete"] });
    fx.grantUserResource(created.resource.resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
    const run = fx.dshRunSetup();
    const p = await fx.sideEffectAuthority.planSideEffect({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, arguments: { resourceRef } });
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.equal(fx.sideEffectAuthority.approveSideEffect({ context: { sessionRef: fx.f.sessions.admin, appId: "ai", source: "user" }, callId: p.call.callId }).ok, true);
    const lease = fx.sideEffectAuthority.acquireLease({ context: fx.ctx(), callId: p.call.callId, holderId: "exec_1", ttlMs: 600000 });
    assert.equal(lease.ok, true, JSON.stringify(lease));
    assert.equal(lease.lease.holderInstanceId, "instA");
    state = { storeRoot: fx.f.storeRoot, now: fx.f.clock(), callId: p.call.callId, leaseId: lease.lease.leaseId, resourceRef, holderId: lease.lease.holderId };
    await fx.close();

    // Runtime B（独立进程，instanceId=instB）自报 holderInstanceId="instA" 尝试执行。
    const box = spawnContender({ dbPath, storeRoot: state.storeRoot, callId: state.callId, leaseId: state.leaseId, holderId: state.holderId, instanceId: "instB", attemptInstanceId: "instA", now: state.now, domainDelayMs: 0 });
    children.push(box);
    await waitReady(box, 30000);
    box.child.stdin.write("GO\n");
    const done = await Promise.race([box.done, sleep(45000).then(() => null)]);
    assert.ok(done, "impersonator 超时: " + box.stderr);
    for (const c of children) { try { c.child.kill("SIGKILL"); } catch { /* ignore */ } }
    assert.equal(box.result.ok, false, JSON.stringify(box.result));
    assert.ok(["SIDE_EFFECT_LEASE_NOT_HELD", "SIDE_EFFECT_LEASE_REQUIRED"].includes(box.result.error), box.result.error);
    assert.equal(box.result.executed, false);
    assert.equal(box.result.mutationCount, 0);
    assert.equal(box.deleteCalls, 0, "impersonator 绝不能 dispatch Domain");
    for (const c of children) await waitExit(c, 5000);

    const identity = new IdentityStore({ path: dbPath }).open();
    try {
      const store = new SideEffectStore({ identity });
      assert.equal(store.callById(state.callId).status, "LEASED", "call 未被 impersonator 改动");
      assert.equal(store.leasesOfCall(state.callId).filter((l) => l.status === "ACTIVE").length, 1, "Runtime A 的 lease 仍 ACTIVE");
    } finally { identity.close(); }
  } finally {
    for (const c of children) { try { c.child.kill("SIGKILL"); } catch { /* ignore */ } }
    fs.rmSync(root, { recursive: true, force: true });
    if (state) { try { fs.rmSync(state.storeRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});
