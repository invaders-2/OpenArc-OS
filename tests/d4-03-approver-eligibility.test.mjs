/**
 * D4-03 Closure · 批准资格（approver eligibility）+ revokeApproval 状态机。
 *
 * 产品规则（Boss 已批准）：
 *  · 批准人失去对该操作的批准资格时，**尚未开始执行**的批准失效；
 *  · 仅退出登录 / 会话过期**不**自动撤销批准；
 *  · 执行主体（task owner）失权仍走既有 AUTHORIZATION_REVOKED，逐字不变。
 *
 * 信任只来自持久化 approval 行的 actor_user_id（不放宽 renderer 投影）；claim 事务内重判就是执行分界 ——
 * 进入 RUNNING 之后一律不追溯、不改写、不新增中止/回滚能力。
 *
 * 真实 authority + 真实 Resource Domain + 真实 executor 同步点；禁止手工改库代替流程、禁止 sleep 猜同步点。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createSideEffectFixture, TRASH_TOOL } from "./fixtures/harness-acp/side-effect-fixture.mjs";
const require = createRequire(import.meta.url);
const { SIDE_EFFECT_ERROR } = require("../electron/side-effect-domain.cjs");
const { TASK_EVENT, isKnownEventType } = require("../electron/task-domain.cjs");

const INELIGIBLE = SIDE_EFFECT_ERROR.APPROVER_INELIGIBLE;
const UNVERIFIED = SIDE_EFFECT_ERROR.APPROVER_UNVERIFIED;
const REVOKED = SIDE_EFFECT_ERROR.APPROVAL_REVOKED;
const TOO_LATE = "SIDE_EFFECT_APPROVAL_TOO_LATE";

const countDeleteCalls = (sf) => {
  const real = sf.fx.f.resourceService.delete.bind(sf.fx.f.resourceService);
  const box = { calls: 0 };
  sf.fx.f.resourceService.delete = (args) => { box.calls += 1; return real(args); };
  return box;
};
const activeLeasesOf = (store, callId) => store.leasesOfCall(callId).filter((l) => l.status === "ACTIVE");
const decisionsOf = (store, callId) => store.approvalsOfCall(callId).map((a) => a.decision);
const eventsOf = (sf, taskId) => sf.taskStore.eventsOfTask(taskId);
const eventsNamed = (sf, taskId, name) => eventsOf(sf, taskId).filter((e) => e.event_type === name);
const payloadOf = (e) => (e.safe_payload ? JSON.parse(e.safe_payload) : null);
const auditRows = (sf, action) => sf.fx.f.identity.connection.prepare("SELECT action, decision, reason_code FROM authorization_audit WHERE action = ?").all(action);
const adminUserCtx = (sf) => ({ sessionRef: sf.fx.f.sessions.admin, appId: "ai", source: "user" });
const aliceUserCtx = (sf) => ({ sessionRef: sf.fx.f.sessions.alice, appId: "ai", source: "user" });
const ownerCtxOf = (sf, key) => ({ sessionRef: sf.fx.f.sessions[key], appId: "ai", source: "test" });

/** 真实链路：owner 的 task + 真实 resource/授权 + proposal + plan（不手工改库）。 */
async function setupOwnerTrash(sf, { resourceName, ownerKey = "alice" } = {}) {
  const ownerCtx = ownerCtxOf(sf, ownerKey);
  const created = await sf.createResource(resourceName);
  const resourceId = created.resource.resourceId;
  const resourceRef = created.resource.resourceRef;
  const toolGrant = sf.grantTool("ai", ["tool.resource.trash"]);
  sf.authService.grantAppResourcePermission({ context: sf.ctx(), appId: "ai", resourceId, actions: ["resource.delete"] });
  const userGrant = sf.grantUserResource(resourceId, sf.fx.f.users[ownerKey], ["resource.delete", "resource.useByAgent"]);
  assert.equal(userGrant.ok, true, JSON.stringify(userGrant));
  const run = sf.fx.dshRunSetup(ownerCtx);
  return { created, resourceId, resourceRef, ownerCtx, userGrant, toolGrant, taskId: run.taskId, stepId: run.stepId, runId: run.runId };
}

async function planTrashFor(sf, sc) {
  const prop = sf.toolProxy.propose({ context: sc.ownerCtx, taskId: sc.taskId, stepId: sc.stepId, runId: sc.runId, toolId: TRASH_TOOL, toolVersion: 1, arguments: { resourceRef: sc.resourceRef } });
  const p = await sf.authority.planSideEffect({ context: sc.ownerCtx, taskId: sc.taskId, stepId: sc.stepId, runId: sc.runId, toolId: TRASH_TOOL, arguments: { resourceRef: sc.resourceRef }, proposalId: prop.proposal ? prop.proposal.proposalId : null, decisionId: prop.decision ? prop.decision.decisionId : null });
  assert.equal(p.ok, true, JSON.stringify(p));
  return p.call.callId;
}

/** admin 作为"非 owner 的管理员批准人"批准 alice 的 task；返回 APPROVED+LEASED 的真实准备。 */
async function approvedLeasedOwnerCall(sf, { resourceName, ownerKey = "alice" } = {}) {
  const sc = await setupOwnerTrash(sf, { resourceName, ownerKey });
  const callId = await planTrashFor(sf, sc);
  const approved = sf.authority.approveSideEffect({ context: adminUserCtx(sf), callId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const leased = sf.lease(callId, { holderId: "exec_1" });
  assert.equal(leased.ok, true, JSON.stringify(leased));
  return { sc, callId, leaseId: leased.lease.leaseId, approvalId: approved.approval.approvalId };
}

/** 拒绝类收敛的统一断言：call BLOCKED + 0 mutation + 0 ACTIVE lease + Step/Task BLOCKED。 */
function assertRejectedAndConverged({ sf, sc, counter, code }) {
  const call = sf.store.callById(sc.callId || sc);
  assert.equal(call.status, "BLOCKED", JSON.stringify(call));
  assert.equal(call.errorCode, code);
  assert.ok(call.completedAt != null, "拒绝类收敛必须落 completed_at");
  assert.deepEqual(activeLeasesOf(sf.store, call.callId), [], "不得残留 ACTIVE lease");
  assert.deepEqual(decisionsOf(sf.store, call.callId), ["APPROVED"], "拒绝不改写 approval 行");
  assert.equal(counter.calls, 0, "0 Domain mutation");
  assert.equal(sf.precondition(sc.resourceRef).trashed, false);
  assert.equal(sf.taskStore.taskById(sc.taskId).status, "BLOCKED", "Task 必须收敛 BLOCKED");
  assert.equal(sf.taskStore.stepById(sc.stepId).status, "BLOCKED", "Step 必须收敛 BLOCKED");
}

/* ============================================================ T1 批准人失权（DISABLE / 降级） */
test("T1 · 批准人被 DISABLE → eligibility DENIED(APPROVER_INELIGIBLE)，claim 前拒绝、0 mutation、Step/Task BLOCKED", async () => {
  const sf = await createSideEffectFixture();
  try {
    const counter = countDeleteCalls(sf);
    const r = await approvedLeasedOwnerCall(sf, { resourceName: "T1 Approver Disable Target" });
    const before = JSON.stringify(sf.store.callById(r.callId));
    sf.fx.f.identity.setUserStatus(sf.fx.f.users.admin, "DISABLED");
    assert.equal(sf.fx.f.identity.userById(sf.fx.f.users.admin).status, "DISABLED");
    // A.4 第一处：只读 eligibility 必须 DENIED + 新码，且不改任何状态。
    const elig = sf.elig(r.callId, { context: r.sc.ownerCtx, holderId: "exec_1", leaseId: r.leaseId });
    assert.equal(elig.ok, false, JSON.stringify(elig));
    assert.equal(elig.status, "DENIED");
    assert.equal(elig.reasonCode, INELIGIBLE);
    assert.equal(JSON.stringify(sf.store.callById(r.callId)), before, "eligibility 是只读的");
    assert.deepEqual(activeLeasesOf(sf.store, r.callId).map((l) => l.leaseId), [r.leaseId]);
    // A.4 第二处：真实执行入口 → claim 前拒绝并收敛。
    const exec = await sf.authority.executeSideEffect({ callId: r.callId, leaseId: r.leaseId, holderId: "exec_1" });
    assert.equal(exec.ok, false, JSON.stringify(exec));
    assert.equal(exec.error, INELIGIBLE);
    assert.equal(exec.mutationCount, 0);
    assertRejectedAndConverged({ sf, sc: { ...r.sc, callId: r.callId }, counter, code: INELIGIBLE });
    assert.deepEqual(sf.store.leasesOfCall(r.callId).map((l) => l.status), ["REVOKED"]);
    const blockedAudit = auditRows(sf, "side_effect.blocked");
    assert.equal(blockedAudit[blockedAudit.length - 1].reason_code, INELIGIBLE);
    const blockedEvents = eventsNamed(sf, r.sc.taskId, TASK_EVENT.TOOL_SIDE_EFFECT_EXECUTION_BLOCKED);
    assert.equal(payloadOf(blockedEvents[blockedEvents.length - 1]).reasonCode, INELIGIBLE);
    // 收敛后 eligibility 报 BLOCKED/CALL_STATE（call 已不可执行），绝不再宣称可执行。
    const after = sf.elig(r.callId, { context: r.sc.ownerCtx, holderId: "exec_1", leaseId: r.leaseId });
    assert.equal(after.status, "BLOCKED");
    assert.equal(eventsNamed(sf, r.sc.taskId, TASK_EVENT.TOOL_EXECUTION_STARTED).length, 0, "绝不进入 RUNNING");
    console.log("T1 approver disabled: " + JSON.stringify({ elig: { status: elig.status, reasonCode: elig.reasonCode }, exec: { ok: exec.ok, error: exec.error, mutationCount: exec.mutationCount }, call: sf.store.callById(r.callId).status, errorCode: sf.store.callById(r.callId).errorCode, leases: sf.store.leasesOfCall(r.callId).map((l) => l.status), task: sf.taskStore.taskById(r.sc.taskId).status, step: sf.taskStore.stepById(r.sc.stepId).status, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

test("T1-b · 批准人被降级为非 ADMIN 且非 owner → APPROVER_INELIGIBLE（丢失批准范围）", async () => {
  const sf = await createSideEffectFixture();
  try {
    const counter = countDeleteCalls(sf);
    const r = await approvedLeasedOwnerCall(sf, { resourceName: "T1b Approver Demote Target" });
    sf.fx.f.identity.setUserRole(sf.fx.f.users.admin, "MEMBER");
    assert.equal(sf.fx.f.identity.userById(sf.fx.f.users.admin).role, "MEMBER");
    assert.notEqual(sf.taskStore.taskById(r.sc.taskId).user_id, sf.fx.f.users.admin, "必须是非 owner 的批准人");
    const elig = sf.elig(r.callId, { context: r.sc.ownerCtx, holderId: "exec_1", leaseId: r.leaseId });
    assert.equal(elig.status, "DENIED");
    assert.equal(elig.reasonCode, INELIGIBLE);
    const exec = await sf.authority.executeSideEffect({ callId: r.callId, leaseId: r.leaseId, holderId: "exec_1" });
    assert.equal(exec.error, INELIGIBLE);
    assertRejectedAndConverged({ sf, sc: { ...r.sc, callId: r.callId }, counter, code: INELIGIBLE });
    console.log("T1-b approver demoted: " + JSON.stringify({ elig: elig.reasonCode, exec: exec.error, call: sf.store.callById(r.callId).status, task: sf.taskStore.taskById(r.sc.taskId).status, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T2 仅登出 / 会话过期不撤销批准 */
test("T2 · 批准人仅登出（session 撤销）→ 批准仍有效，真实执行成功（不因登出撤销）", async () => {
  const sf = await createSideEffectFixture();
  try {
    const counter = countDeleteCalls(sf);
    const r = await approvedLeasedOwnerCall(sf, { resourceName: "T2 Approver Logout Target" });
    const loggedOut = sf.fx.f.identity.logout(sf.fx.f.sessions.admin);
    assert.equal(loggedOut.ok, true, JSON.stringify(loggedOut));
    assert.ok(sf.fx.f.identity.sessionByRef(sf.fx.f.sessions.admin).revoked_at != null, "admin session 必须真的被撤销");
    // 批准行/决策不受影响。
    assert.deepEqual(decisionsOf(sf.store, r.callId), ["APPROVED"]);
    assert.equal(sf.authority.effectiveApproval(r.callId).effectiveDecision, "APPROVED");
    const elig = sf.elig(r.callId, { context: r.sc.ownerCtx, holderId: "exec_1", leaseId: r.leaseId });
    assert.equal(elig.status, "ELIGIBLE", JSON.stringify(elig));
    const exec = await sf.authority.executeSideEffect({ callId: r.callId, leaseId: r.leaseId, holderId: "exec_1" });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(exec.verificationStatus, "PASS");
    assert.equal(counter.calls, 1, "登出不得阻止已批准的执行");
    assert.equal(sf.precondition(r.sc.resourceRef).trashed, true);
    assert.equal(sf.store.callById(r.callId).status, "SUCCEEDED");
    assert.equal(sf.store.latestApprovalOfCall(r.callId).revokedAt, null, "登出绝不撤销批准");
    console.log("T2 approver logout: " + JSON.stringify({ sessionRevoked: true, approval: sf.authority.effectiveApproval(r.callId).effectiveDecision, elig: elig.status, exec: { ok: exec.ok, verificationStatus: exec.verificationStatus }, call: sf.store.callById(r.callId).status, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T3 执行主体失权：既有路径逐字不变 */
test("T3 · 执行主体（task owner）失权 → 既有 SIDE_EFFECT_AUTHORIZATION_REVOKED 逐字不变（不进入批准人收敛）", async () => {
  const sf = await createSideEffectFixture();
  try {
    const counter = countDeleteCalls(sf);
    const r = await approvedLeasedOwnerCall(sf, { resourceName: "T3 Owner Revoke Target" });
    const revoked = sf.authService.revokeAppResourcePermission({ context: sf.ctx(), grantId: r.sc.toolGrant.grant.grantId });
    assert.equal(revoked.ok, true, JSON.stringify(revoked));
    const elig = sf.elig(r.callId, { context: r.sc.ownerCtx, holderId: "exec_1", leaseId: r.leaseId });
    assert.equal(elig.status, "DENIED");
    assert.equal(elig.reasonCode, SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED);
    const exec = await sf.authority.executeSideEffect({ callId: r.callId, leaseId: r.leaseId, holderId: "exec_1" });
    assert.equal(exec.ok, false, JSON.stringify(exec));
    assert.equal(exec.error, SIDE_EFFECT_ERROR.AUTHORIZATION_REVOKED);
    assert.equal(exec.mutationCount, 0);
    // 既有语义：非批准资格类失败维持 fail closed，不改 call、不回收 lease、不 block Step/Task。
    assert.equal(sf.store.callById(r.callId).status, "LEASED");
    assert.equal(sf.store.callById(r.callId).errorCode, null);
    assert.deepEqual(activeLeasesOf(sf.store, r.callId).map((l) => l.leaseId), [r.leaseId]);
    assert.equal(sf.taskStore.taskById(r.sc.taskId).status, "RUNNING");
    assert.equal(counter.calls, 0);
    console.log("T3 owner revoked: " + JSON.stringify({ elig: elig.reasonCode, exec: { ok: exec.ok, error: exec.error }, call: sf.store.callById(r.callId).status, leases: activeLeasesOf(sf.store, r.callId).length, task: sf.taskStore.taskById(r.sc.taskId).status, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T4 撤销先于 claim */
test("T4 · 撤销先于 claim → call BLOCKED/APPROVAL_REVOKED、lease 收敛、claim/execute 拒绝、0 mutation、Step/Task BLOCKED", async () => {
  const sf = await createSideEffectFixture();
  try {
    const counter = countDeleteCalls(sf);
    const r = await approvedLeasedOwnerCall(sf, { resourceName: "T4 Revoke Before Claim" });
    const rev = sf.authority.revokeApproval({ context: adminUserCtx(sf), callId: r.callId });
    assert.equal(rev.ok, true, JSON.stringify(rev));
    assert.equal(rev.revoked, true);
    assert.equal(rev.callStatus, "BLOCKED");
    assert.equal(rev.approval.decision, "REVOKED");
    assert.ok(rev.approval.revokedAt != null);
    const call = sf.store.callById(r.callId);
    assert.equal(call.status, "BLOCKED");
    assert.equal(call.errorCode, REVOKED);
    assert.ok(call.completedAt != null);
    assert.equal(sf.authority.effectiveApproval(r.callId).effectiveDecision, "REVOKED");
    assert.deepEqual(activeLeasesOf(sf.store, r.callId), []);
    assert.deepEqual(sf.store.leasesOfCall(r.callId).map((l) => l.status), ["REVOKED"]);
    // 撤销后旧批准不可再用：lease / execute 都拒绝，且 0 mutation。
    const leaseAgain = sf.lease(r.callId, { holderId: "exec_1" });
    assert.equal(leaseAgain.ok, false, JSON.stringify(leaseAgain));
    assert.equal(leaseAgain.error, SIDE_EFFECT_ERROR.CALL_STATE);
    const exec = await sf.authority.executeSideEffect({ callId: r.callId, leaseId: r.leaseId, holderId: "exec_1" });
    assert.equal(exec.ok, false, JSON.stringify(exec));
    assert.equal(exec.mutationCount, 0);
    assert.equal(counter.calls, 0);
    assert.equal(sf.precondition(r.sc.resourceRef).trashed, false);
    assert.equal(sf.taskStore.taskById(r.sc.taskId).status, "BLOCKED");
    assert.equal(sf.taskStore.stepById(r.sc.stepId).status, "BLOCKED");
    assert.equal(auditRows(sf, "side_effect.approval_revoked").length, 1);
    const denied = eventsNamed(sf, r.sc.taskId, TASK_EVENT.TOOL_DENIED);
    assert.equal(denied.length, 1);
    assert.equal(payloadOf(denied[0]).reason, REVOKED);
    assert.equal(payloadOf(denied[0]).approvalId, r.approvalId);
    console.log("T4 revoke before claim: " + JSON.stringify({ rev: { ok: rev.ok, revoked: rev.revoked, callStatus: rev.callStatus, approval: rev.approval.decision }, call: call.status, errorCode: call.errorCode, leases: sf.store.leasesOfCall(r.callId).map((l) => l.status), leaseAgain: { ok: leaseAgain.ok, error: leaseAgain.error }, execute: { ok: exec.ok, error: exec.error }, task: sf.taskStore.taskById(r.sc.taskId).status, step: sf.taskStore.stepById(r.sc.stepId).status, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T5 claim 先于撤销 / 失权（真实同步点） */
test("T5 · claim 先于撤销 → 撤销 TOO_LATE、RUNNING 零变化、执行继续收敛真实结果、批准不丢", async () => {
  const hold = { sf: null, rev: null, atRevoke: null, afterRevoke: null };
  const sf = await createSideEffectFixture({
    sideEffectTestHooks: { afterClaimBeforeDispatch: ({ callId }) => {
      hold.atRevoke = JSON.stringify(hold.sf.store.callById(callId));
      hold.rev = hold.sf.authority.revokeApproval({ context: adminUserCtx(hold.sf), callId });
      hold.afterRevoke = JSON.stringify(hold.sf.store.callById(callId));
    } },
  });
  hold.sf = sf;
  try {
    const counter = countDeleteCalls(sf);
    const r = await approvedLeasedOwnerCall(sf, { resourceName: "T5 Revoke After Claim" });
    const exec = await sf.authority.executeSideEffect({ callId: r.callId, leaseId: r.leaseId, holderId: "exec_1" });
    assert.ok(hold.rev, "hook 必须在 RUNNING 同步点真实触发");
    assert.equal(JSON.parse(hold.atRevoke).status, "RUNNING");
    assert.equal(hold.afterRevoke, hold.atRevoke, "撤销那一刻 0 状态变化");
    assert.equal(hold.rev.ok, false, JSON.stringify(hold.rev));
    assert.equal(hold.rev.error, TOO_LATE);
    assert.equal(hold.rev.callStatus, "RUNNING");
    assert.equal(hold.rev.callId, r.callId);
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(exec.verificationStatus, "PASS");
    const call = sf.store.callById(r.callId);
    assert.equal(call.status, "SUCCEEDED");
    assert.equal(call.verificationStatus, "PASS");
    assert.equal(counter.calls, 1, "执行事实不被撤销改写");
    assert.equal(sf.precondition(r.sc.resourceRef).trashed, true);
    assert.deepEqual(sf.store.leasesOfCall(r.callId).map((l) => l.status), ["RELEASED"]);
    assert.deepEqual(decisionsOf(sf.store, r.callId), ["APPROVED"], "TOO_LATE 绝不撤销批准");
    assert.equal(sf.store.latestApprovalOfCall(r.callId).revokedAt, null);
    // 只落 safe audit + safe event（且事件常量已登记，过滤通道不会丢）。
    const audit = auditRows(sf, "side_effect.revoke_too_late");
    assert.equal(audit.length, 1, JSON.stringify(audit));
    assert.equal(audit[0].reason_code, TOO_LATE);
    assert.equal(audit[0].decision, "RUNNING");
    assert.equal(isKnownEventType(TASK_EVENT.TOOL_SIDE_EFFECT_REVOKE_TOO_LATE), true);
    assert.equal(isKnownEventType("tool.side_effect.revoke_too_late"), true);
    const lateEvents = eventsNamed(sf, r.sc.taskId, TASK_EVENT.TOOL_SIDE_EFFECT_REVOKE_TOO_LATE);
    assert.equal(lateEvents.length, 1);
    assert.deepEqual(Object.keys(payloadOf(lateEvents[0])).sort(), ["callId", "observedStatus", "toolId"]);
    assert.equal(payloadOf(lateEvents[0]).observedStatus, "RUNNING");
    assert.equal(eventsNamed(sf, r.sc.taskId, TASK_EVENT.TOOL_DENIED).length, 0, "迟到撤销绝不伪装成已撤销");
    assert.equal(JSON.stringify(payloadOf(lateEvents[0])).includes("/"), false, "payload 不得含路径");
    console.log("T5 revoke after claim: " + JSON.stringify({ revoke: { ok: hold.rev.ok, error: hold.rev.error, callStatus: hold.rev.callStatus }, exec: { ok: exec.ok, verificationStatus: exec.verificationStatus }, call: call.status, leases: sf.store.leasesOfCall(r.callId).map((l) => l.status), approval: sf.authority.effectiveApproval(r.callId).effectiveDecision, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

test("T5-b · claim 之后批准人失权 → 不追溯：执行继续成功，批准行不变", async () => {
  const hold = { sf: null, atClaim: null };
  const sf = await createSideEffectFixture({
    sideEffectTestHooks: { afterClaimBeforeDispatch: ({ callId }) => {
      hold.atClaim = JSON.stringify(hold.sf.store.callById(callId));
      hold.sf.fx.f.identity.setUserStatus(hold.sf.fx.f.users.admin, "DISABLED");
    } },
  });
  hold.sf = sf;
  try {
    const counter = countDeleteCalls(sf);
    const r = await approvedLeasedOwnerCall(sf, { resourceName: "T5b Approver Disable After Claim" });
    const exec = await sf.authority.executeSideEffect({ callId: r.callId, leaseId: r.leaseId, holderId: "exec_1" });
    assert.ok(hold.atClaim, "hook 必须真实触发");
    assert.equal(exec.ok, true, JSON.stringify(exec));
    assert.equal(exec.verificationStatus, "PASS");
    assert.equal(sf.store.callById(r.callId).status, "SUCCEEDED");
    assert.equal(counter.calls, 1, "进入 RUNNING 之后失权不追溯");
    assert.deepEqual(decisionsOf(sf.store, r.callId), ["APPROVED"]);
    assert.equal(sf.store.latestApprovalOfCall(r.callId).revokedAt, null);
    assert.equal(sf.taskStore.taskById(r.sc.taskId).status, "RUNNING", "已执行的事实不产生拒绝收敛");
    console.log("T5-b disable after claim: " + JSON.stringify({ exec: { ok: exec.ok, verificationStatus: exec.verificationStatus }, call: sf.store.callById(r.callId).status, task: sf.taskStore.taskById(r.sc.taskId).status, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T6 撤销状态机边界 */
test("T6 · 撤销状态机边界：重复撤销幂等、非授权 FORBIDDEN、AWAITING_APPROVAL → APPROVAL_REQUIRED、已被 DENY 的 BLOCKED → TOO_LATE", async () => {
  const sf = await createSideEffectFixture();
  try {
    const counter = countDeleteCalls(sf);
    // (a) 重复撤销：幂等 duplicate，零写入。
    const r = await approvedLeasedOwnerCall(sf, { resourceName: "T6a Revoke Duplicate" });
    const first = sf.authority.revokeApproval({ context: adminUserCtx(sf), callId: r.callId });
    assert.equal(first.ok, true, JSON.stringify(first));
    const afterFirst = JSON.stringify(sf.store.callById(r.callId));
    const again = sf.authority.revokeApproval({ context: adminUserCtx(sf), callId: r.callId });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.duplicate, true);
    assert.equal(again.callStatus, "BLOCKED");
    assert.equal(JSON.stringify(sf.store.callById(r.callId)), afterFirst, "重复撤销 0 写入");
    assert.deepEqual(decisionsOf(sf.store, r.callId), ["REVOKED"], "不得写第二行 approval");
    assert.equal(auditRows(sf, "side_effect.approval_revoked").length, 1, "不得重复落 audit");
    assert.equal(eventsNamed(sf, r.sc.taskId, TASK_EVENT.TOOL_DENIED).length, 1, "不得重复落事件");
    // (b) 非授权用户（非 owner 且非 ADMIN）：FORBIDDEN + 零变化。
    const r2 = await approvedLeasedOwnerCall(sf, { resourceName: "T6b Unauthorized", ownerKey: "admin" });
    const before2 = JSON.stringify(sf.store.callById(r2.callId));
    const forbidden = sf.authority.revokeApproval({ context: aliceUserCtx(sf), callId: r2.callId });
    assert.equal(forbidden.ok, false, JSON.stringify(forbidden));
    assert.equal(forbidden.error, SIDE_EFFECT_ERROR.APPROVAL_FORBIDDEN);
    assert.equal(JSON.stringify(sf.store.callById(r2.callId)), before2);
    assert.deepEqual(decisionsOf(sf.store, r2.callId), ["APPROVED"]);
    assert.deepEqual(activeLeasesOf(sf.store, r2.callId).map((l) => l.leaseId), [r2.leaseId]);
    // (c) 还没有批准（陈旧页请求）：APPROVAL_REQUIRED + 零变化。
    const sc3 = await setupOwnerTrash(sf, { resourceName: "T6c Required" });
    const call3 = await planTrashFor(sf, sc3);
    const required = sf.authority.revokeApproval({ context: adminUserCtx(sf), callId: call3 });
    assert.equal(required.ok, false, JSON.stringify(required));
    assert.equal(required.error, SIDE_EFFECT_ERROR.APPROVAL_REQUIRED);
    assert.equal(sf.store.callById(call3).status, "AWAITING_APPROVAL");
    assert.equal(sf.authority.effectiveApproval(call3), null);
    // (d) 已被 DENY 的 BLOCKED 不是撤销：TOO_LATE + 零写入，DENIED 不改写。
    const sc4 = await setupOwnerTrash(sf, { resourceName: "T6d Denied Then Revoke" });
    const call4 = await planTrashFor(sf, sc4);
    assert.equal(sf.deny(call4, { context: adminUserCtx(sf) }).ok, true);
    const before4 = JSON.stringify(sf.store.callById(call4));
    const late = sf.authority.revokeApproval({ context: adminUserCtx(sf), callId: call4 });
    assert.equal(late.ok, false, JSON.stringify(late));
    assert.equal(late.error, TOO_LATE);
    assert.equal(late.callStatus, "BLOCKED");
    assert.equal(JSON.stringify(sf.store.callById(call4)), before4);
    assert.deepEqual(decisionsOf(sf.store, call4), ["DENIED"], "DENIED 决定绝不被撤销改写");
    assert.equal(counter.calls, 0);
    console.log("T6 revoke state machine: " + JSON.stringify({ duplicate: { ok: again.ok, duplicate: again.duplicate, callStatus: again.callStatus }, forbidden: forbidden.error, required: required.error, blockedDenied: { ok: late.ok, error: late.error, callStatus: late.callStatus }, approvals: { a: decisionsOf(sf.store, r.callId), d: decisionsOf(sf.store, call4) }, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T7 终态不被撤销覆盖 */
test("T7 · SUCCEEDED 终态：撤销一律 TOO_LATE、call 逐字不变、无撤销事件", async () => {
  const sf = await createSideEffectFixture();
  try {
    const counter = countDeleteCalls(sf);
    const r = await approvedLeasedOwnerCall(sf, { resourceName: "T7 Succeeded Target" });
    const exec = await sf.authority.executeSideEffect({ callId: r.callId, leaseId: r.leaseId, holderId: "exec_1" });
    assert.equal(exec.ok, true, JSON.stringify(exec));
    const before = JSON.stringify(sf.store.callById(r.callId));
    const rev = sf.authority.revokeApproval({ context: adminUserCtx(sf), callId: r.callId });
    assert.equal(rev.ok, false, JSON.stringify(rev));
    assert.equal(rev.error, TOO_LATE);
    assert.equal(rev.callStatus, "SUCCEEDED");
    assert.equal(JSON.stringify(sf.store.callById(r.callId)), before, "终态逐字不变");
    assert.deepEqual(decisionsOf(sf.store, r.callId), ["APPROVED"]);
    assert.equal(eventsNamed(sf, r.sc.taskId, TASK_EVENT.TOOL_DENIED).length, 0);
    assert.equal(counter.calls, 1);
    console.log("T7 revoke after succeeded: " + JSON.stringify({ revoke: { ok: rev.ok, error: rev.error, callStatus: rev.callStatus }, call: sf.store.callById(r.callId).status, verificationStatus: sf.store.callById(r.callId).verificationStatus, approvals: decisionsOf(sf.store, r.callId), mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

test("T7-b · UNKNOWN_EFFECT：撤销 TOO_LATE、恢复证据逐字段不变、恢复入口保留", async () => {
  const hold = { sf: null, rev: null, recoverySafe: null, callAtRevoke: null };
  const sf = await createSideEffectFixture({
    sideEffectTestHooks: { afterClaimBeforeDispatch: ({ callId }) => {
      hold.sf.fx.sideEffectRuntime.recoverOnStartup();
      hold.recoverySafe = JSON.stringify(hold.sf.store.callById(callId).recoverySafe);
      hold.rev = hold.sf.authority.revokeApproval({ context: adminUserCtx(hold.sf), callId });
      hold.callAtRevoke = JSON.stringify(hold.sf.store.callById(callId));
    } },
  });
  hold.sf = sf;
  try {
    const counter = countDeleteCalls(sf);
    const r = await approvedLeasedOwnerCall(sf, { resourceName: "T7b Unknown Effect Target" });
    const exec = await sf.authority.executeSideEffect({ callId: r.callId, leaseId: r.leaseId, holderId: "exec_1" });
    assert.ok(hold.rev, "hook 必须真实触发");
    assert.equal(hold.rev.ok, false, JSON.stringify(hold.rev));
    assert.equal(hold.rev.error, TOO_LATE);
    assert.equal(hold.rev.callStatus, "UNKNOWN_EFFECT");
    const call = sf.store.callById(r.callId);
    assert.equal(call.status, "UNKNOWN_EFFECT");
    assert.equal(JSON.stringify(call), hold.callAtRevoke, "迟到撤销之后 call 任何字段都不得变化");
    assert.equal(JSON.stringify(call.recoverySafe), hold.recoverySafe, "恢复证据逐字段不变");
    assert.equal(exec.suppressed, true, "迟到结果不得覆盖 recovery 权威");
    assert.equal(counter.calls, 1);
    const rec = sf.taskService.getRecoveryState({ context: r.sc.ownerCtx, taskId: r.sc.taskId });
    assert.equal(rec.applicable, true, "UNKNOWN_EFFECT 恢复入口必须保留");
    assert.equal(rec.calls.length, 1);
    assert.equal(counter.calls, 1);
    console.log("T7-b revoke after unknown effect: " + JSON.stringify({ revoke: { ok: hold.rev.ok, error: hold.rev.error, callStatus: hold.rev.callStatus }, call: call.status, recoverySafe: call.recoverySafe, recoveryApplicable: rec.applicable, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

/* ============================================================ T8 历史批准缺 actor */
test("T8 · 旧批准缺 actor_user_id → APPROVER_UNVERIFIED 保守拒绝（不伪造历史身份）", async () => {
  const sf = await createSideEffectFixture();
  try {
    const counter = countDeleteCalls(sf);
    const sc = await setupOwnerTrash(sf, { resourceName: "T8 Legacy Approval Target" });
    const callId = await planTrashFor(sf, sc);
    const approved = sf.authority.approveSideEffect({ context: adminUserCtx(sf), callId });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    // 真实旧形状：approval 行走真实 store 写入，再把历史遗留的空 actor 置空（不伪造任何身份）。
    sf.fx.f.identity.connection.prepare("UPDATE tool_approvals SET actor_user_id = NULL WHERE approval_id = ?").run(approved.approval.approvalId);
    assert.equal(sf.store.latestApprovalOfCall(callId).actorUserId, null);
    const leased = sf.lease(callId, { holderId: "exec_1" });
    assert.equal(leased.ok, true, JSON.stringify(leased));
    const elig = sf.elig(callId, { context: sc.ownerCtx, holderId: "exec_1", leaseId: leased.lease.leaseId });
    assert.equal(elig.status, "DENIED");
    assert.equal(elig.reasonCode, UNVERIFIED);
    const exec = await sf.authority.executeSideEffect({ callId, leaseId: leased.lease.leaseId, holderId: "exec_1" });
    assert.equal(exec.ok, false, JSON.stringify(exec));
    assert.equal(exec.error, UNVERIFIED);
    assert.equal(exec.mutationCount, 0);
    assertRejectedAndConverged({ sf, sc: { ...sc, callId }, counter, code: UNVERIFIED });
    console.log("T8 legacy approval: " + JSON.stringify({ actorUserId: sf.store.latestApprovalOfCall(callId).actorUserId, elig: { status: elig.status, reasonCode: elig.reasonCode }, exec: { ok: exec.ok, error: exec.error }, call: sf.store.callById(callId).status, errorCode: sf.store.callById(callId).errorCode, leases: sf.store.leasesOfCall(callId).map((l) => l.status), task: sf.taskStore.taskById(sc.taskId).status, mutation: counter.calls }));
  } finally { await sf.fx.close(); }
});

