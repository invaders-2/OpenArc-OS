/**
 * D5-03 batch13 探针：直接调用公开方法 `executeInProcess` 能否绕过 execution placement 守卫。
 *
 * 判据：对一条 executionProvider = ResourceService 的 resource.trash call，
 *   ok === true 且资源发生真实 mutation（trashed true）  → 绕过成立（红）
 *   ok === false 且 error === SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED 且 0 mutation / 0 lease → 守卫生效（绿）
 *
 * 用法：node inprocess-bypass.mjs [summary.json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolHarnessFixture } from "../../../../tests/fixtures/harness-acp/tool-harness-fixture.mjs";

const TRASH = "resource.trash";
const summaryPath = process.argv[2] || null;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-b13-bypass-"));
const fx = await createToolHarnessFixture({
  withAdapters: true,
  dbPath: path.join(root, "identity.db"),
  storeRoot: path.join(root, "library"),
  keepData: true,
  sideEffectRuntimeDir: path.join(root, "runtime"),
  sideEffectApprovalWaitMs: 5000,
});

const out = {};
function line(k, v) { console.log(k + ": " + (typeof v === "string" ? v : JSON.stringify(v))); out[k] = v; }

try {
  const created = await fx.createResource("Batch13 Bypass Target");
  const resourceRef = created.resource.resourceRef;
  const resourceId = created.resource.resourceId;
  fx.grantTool("ai", ["tool.resource.trash"]);
  fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.delete"] });
  fx.grantUserResource(resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
  const run = fx.dshRunSetup();

  // Domain 真实调用计数（in-process 走 main 进程同一个 ResourceService 实例）。
  const deleteBox = { calls: 0 };
  const realDelete = fx.f.resourceService.delete.bind(fx.f.resourceService);
  fx.f.resourceService.delete = (...a) => { deleteBox.calls += 1; return realDelete(...a); };

  const auditRows = () => fx.f.identity.connection.prepare("SELECT action, decision, reason_code FROM authorization_audit WHERE action LIKE 'side_effect.%' ORDER BY id").all();
  const leaseRows = (callId) => fx.sideEffectStore.leasesOfCall(callId);
  const activeLeases = (callId) => leaseRows(callId).filter((l) => String(l.status) === "ACTIVE").length;
  const domainState = () => {
    const pre = fx.f.resourceService.sideEffectPrecondition({ resourceRef });
    const lib = fx.f.resourceStore.resourceRowById(resourceId);
    const reg = fx.f.store.resourceById(resourceId);
    return {
      preconditionTrashed: pre.trashed,
      preconditionRegistryStatus: pre.registryStatus,
      preconditionVersion: pre.expectedVersion,
      libraryTrashState: lib ? String(lib.trash_state) : null,
      libraryDeletedAt: lib && lib.deleted_at != null ? Number(lib.deleted_at) : null,
      registryStatus: reg ? String(reg.status) : null,
    };
  };

  const planned = await fx.sideEffectRuntime.proposeWrite({
    context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId,
    toolId: TRASH, arguments: { resourceRef },
  });
  const callId = planned.approvalRequestId;
  line("propose.ok", planned.ok);
  line("callId", callId);

  const contract = fx.toolRegistry.get(TRASH, fx.sideEffectStore.callById(callId).toolVersion);
  line("contract.executionProvider", contract && contract.executionProvider);

  const approved = fx.sideEffectRuntime.decideApproval({ context: { sessionRef: fx.f.sessions.admin, source: "user" }, approvalRequestId: callId, decision: "APPROVE" });
  line("approve.ok", approved.ok);
  line("call.status.afterApprove", fx.sideEffectStore.callById(callId).status);

  const before = { domain: domainState(), deleteCalls: deleteBox.calls, leaseCount: leaseRows(callId).length, activeLeaseCount: activeLeases(callId), auditCount: auditRows().length };
  line("before.domain", before.domain);
  line("before.deleteCalls", before.deleteCalls);
  line("before.leaseCount", before.leaseCount);
  line("before.activeLeaseCount", before.activeLeaseCount);
  line("before.auditCount", before.auditCount);

  // 关键：**直接**调公开方法 executeInProcess，不经 executeApproved 分流。
  const res = await fx.sideEffectRuntime.executeInProcess({ callId });
  line("res.ok", res && res.ok);
  line("res.error", res && res.error);
  line("res.inProcess", res && res.inProcess);
  line("res.call.status", res && res.call && res.call.status);

  const after = { domain: domainState(), deleteCalls: deleteBox.calls, leaseCount: leaseRows(callId).length, activeLeaseCount: activeLeases(callId), auditCount: auditRows().length };
  line("after.domain", after.domain);
  line("after.deleteCalls", after.deleteCalls);
  line("after.leaseCount", after.leaseCount);
  line("after.activeLeaseCount", after.activeLeaseCount);
  line("after.auditCount", after.auditCount);
  line("call.status.final", fx.sideEffectStore.callById(callId).status);

  const domainMutated = after.domain.libraryTrashState !== before.domain.libraryTrashState
    || after.domain.preconditionTrashed !== before.domain.preconditionTrashed
    || after.domain.registryStatus !== before.domain.registryStatus;
  line("domainMutated", domainMutated);

  const allAudits = auditRows();
  const placementAudits = allAudits.filter((r) => r.action === "side_effect.execution_placement");
  line("audit.placementRows", placementAudits.map((r) => ({ action: r.action, decision: r.decision, reasonCode: r.reason_code })));

  const bypassProven = res && res.ok === true && domainMutated === true;
  const guardHeld = res && res.ok === false && res.error === "SIDE_EFFECT_IN_PROCESS_NOT_PERMITTED"
    && domainMutated === false && after.activeLeaseCount === 0
    && fx.sideEffectStore.callById(callId).status === "APPROVED";
  line("verdict.bypassProven", bypassProven);
  line("verdict.guardHeld", guardHeld);
  line("verdict", bypassProven ? "RED_BYPASS_PROVEN" : (guardHeld ? "GREEN_GUARD_HELD" : "UNEXPECTED"));

  if (summaryPath) {
    fs.writeFileSync(summaryPath, JSON.stringify({
      probe: "inprocess-bypass",
      toolId: TRASH,
      callId,
      executionProvider: contract && contract.executionProvider,
      directExecuteInProcess: true,
      res: { ok: res && res.ok, error: res && res.error, inProcess: res && res.inProcess, callStatus: res && res.call && res.call.status },
      before, after,
      callStatusFinal: fx.sideEffectStore.callById(callId).status,
      domainMutated,
      placementAudits: placementAudits.map((r) => ({ action: r.action, decision: r.decision, reasonCode: r.reason_code })),
      verdict: bypassProven ? "RED_BYPASS_PROVEN" : (guardHeld ? "GREEN_GUARD_HELD" : "UNEXPECTED"),
    }, null, 2) + "\n");
  }
} finally {
  try { await fx.close(); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}
