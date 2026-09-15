/** D4-03C1 · Side-effect Authority 测试夹具（复用 Tool/Harness fixture，不启动 official dsh）。 */
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);

export const WRITE_TOOL = "test.write";
export const NOVERIFY_TOOL = "test.noverify";
// D4-03C2：第一条 production REVERSIBLE_WRITE tool（真实 Resource Domain）。
export const TRASH_TOOL = "resource.trash";

export async function createSideEffectFixture(opts = {}) {
  const fx = await createToolHarnessFixture({ withAdapters: true, ...opts });
  const authority = fx.sideEffectAuthority;
  const store = fx.sideEffectStore;
  const ctx = () => fx.ctx();
  const userCtx = () => ({ sessionRef: fx.f.sessions.admin, appId: "ai", source: "user" });
  const aliceUserCtx = () => ({ sessionRef: fx.f.sessions.alice, appId: "ai", source: "user" });
  const setupRun = (context = null) => fx.dshRunSetup(context);
  const plan = (toolId, args, run, extra = {}) => authority.planSideEffect({ context: extra.context || fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId, arguments: args, ...extra });
  const approve = (callId, o = {}) => authority.approveSideEffect({ context: o.context || userCtx(), callId, ...(o.ttlMs ? { ttlMs: o.ttlMs } : {}) });
  const deny = (callId, o = {}) => authority.denySideEffect({ context: o.context || userCtx(), callId });
  const revokeApproval = (callId, o = {}) => authority.revokeApproval({ context: o.context || userCtx(), callId });
  const lease = (callId, o = {}) => authority.acquireLease({ context: fx.ctx(), callId, holderId: o.holderId || "exec_1", ...(o.ttlMs ? { ttlMs: o.ttlMs } : {}), ...(o.instanceId ? { instanceId: o.instanceId } : {}), ...(o._leaseId ? { _leaseId: o._leaseId } : {}) });
  const elig = (callId, o = {}) => {
    // D4-03C2 Closure：默认取当前 ACTIVE lease 的 runtime instance（与真实 execution 一致）；
    // 用 o.holderInstanceId: "x" 可显式测试不匹配，o.holderInstanceId: null 可测试缺失。
    const activeLease = authority.store.activeLeaseOfCall(callId);
    return authority.evaluateExecutionEligibility({
      context: o.context || fx.ctx(),
      callId,
      holderId: o.holderId === undefined ? "exec_1" : o.holderId,
      holderInstanceId: o.holderInstanceId === undefined ? (activeLease ? activeLease.holderInstanceId : authority.instanceId) : o.holderInstanceId,
      requestArgumentsHash: o.requestArgumentsHash || null,
    });
  };
  /** 注册 C1 测试专用 REVERSIBLE_WRITE contract + plan-only adapter（绝不 execute）。 */
  function registerResourceWriteTool({ toolId = "test.resourcewrite", requiredPermissions = ["tool.resource.readMetadata"], resourceActions = ["resource.edit"], verificationStrategy = "READ_AFTER_WRITE", idempotencySupport = true } = {}) {
    const contract = {
      toolId, version: 1, displayName: "Resource Write Probe",
      description: "D4-03C1 test-only reversible write plan; never executes a mutation.",
      inputSchema: { type: "object", additionalProperties: false, properties: { resourceRef: { type: "string" }, text: { type: "string", minLength: 1 } }, required: ["resourceRef", "text"] },
      outputSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
      riskClass: "REVERSIBLE_WRITE", sideEffect: "WRITE", requiresApproval: true,
      requiredPermissions, resourceActions, executionProvider: "TestResourceWrite", enabled: true,
      expectedSideEffects: ["never executed in D4-03C1"], idempotencySupport, verificationStrategy, approvalPolicy: "ONE_CALL", leasePolicy: "SINGLE_ACTIVE",
    };
    fx.toolRegistry.register(contract);
    fx.adapters.providers.TestResourceWrite = {
      toolIds: [toolId],
      async prepare() { return { plan: {} }; },
      async plan({ args }) {
        const ref = String((args && args.resourceRef) || "");
        const row = fx.f.authService.store.resourceByRef(ref);
        const version = row ? Number(row.version) : null;
        return { targets: [ref], preconditions: { resourceRef: ref, expectedVersion: version }, expectedEffects: [{ action: "replaceText", resourceRef: ref, expectedVersion: version }] };
      },
    };
    return contract;
  }
  /** D4-03C2：给 app/user 授予 resource.delete + tool.resource.trash，建立真实 trash 场景。 */
  async function setupTrash({ resourceName = "C2 Trash Target", context = null } = {}) {
    const created = await fx.createResource(resourceName);
    const resourceRef = created.resource.resourceRef;
    const resourceId = created.resource.resourceId;
    const toolGrant = fx.grantTool("ai", ["tool.resource.trash"]);
    const appGrant = fx.f.authService.grantAppResourcePermission({ context: fx.f.adminCtx(), appId: "ai", resourceId, actions: ["resource.delete"] });
    const userGrant = fx.grantUserResource(resourceId, fx.f.users.admin, ["resource.delete", "resource.useByAgent"]);
    return { created, resourceRef, resourceId, toolGrant, appGrant, userGrant, run: fx.dshRunSetup(context) };
  }
  /** 只读真实 Domain precondition 快照（测试验证用）。 */
  const precondition = (resourceRef) => fx.f.resourceService.sideEffectPrecondition({ resourceRef });
  /** trusted Domain restore：仅用于证明 trash 可逆，不开放 resource.restore Tool。 */
  const restoreTrash = (resourceRef) => fx.f.resourceService.restore({ context: fx.f.adminCtx(), resourceRef });
  /** 真实 trash authority 流程：proposal → plan → approve → lease。 */
  async function trashFlow({ ref, run, ttlMs = undefined, holderId = "exec_1", instanceId = undefined, proposeArguments = undefined } = {}) {
    const args = proposeArguments || { resourceRef: ref };
    const prop = fx.toolProxy.propose({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, toolVersion: 1, arguments: args });
    const p = await authority.planSideEffect({ context: fx.ctx(), taskId: run.taskId, stepId: run.stepId, runId: run.runId, toolId: TRASH_TOOL, arguments: args, proposalId: prop.proposal ? prop.proposal.proposalId : null, decisionId: prop.decision ? prop.decision.decisionId : null });
    const a = p.ok ? authority.approveSideEffect({ context: userCtx(), callId: p.call.callId, ...(ttlMs ? { ttlMs } : {}) }) : null;
    const l = p.ok ? authority.acquireLease({ context: fx.ctx(), callId: p.call.callId, holderId, ...(instanceId ? { instanceId } : {}) }) : null;
    return { prop, plan: p, approval: a, lease: l, callId: p.ok ? p.call.callId : null };
  }
  return { fx, harness: fx, authority, store, toolStore: fx.toolStore, toolRegistry: fx.toolRegistry, taskStore: fx.taskStore, authService: fx.f.authService, adapters: fx.adapters, toolProxy: fx.toolProxy, taskService: fx.taskService, identity: fx.f.identity, grantTool: fx.grantTool, grantUserResource: fx.grantUserResource, createResource: fx.createResource, ctx, userCtx, aliceUserCtx, setupRun, plan, approve, deny, revokeApproval, lease, elig, registerResourceWriteTool, setupTrash, precondition, restoreTrash, trashFlow };
}
