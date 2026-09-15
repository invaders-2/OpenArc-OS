/** D4-03C1 · Side-effect Authority 测试夹具（复用 Tool/Harness fixture，不启动 official dsh）。 */
import { createRequire } from "node:module";
import { createToolHarnessFixture } from "./tool-harness-fixture.mjs";
const require = createRequire(import.meta.url);

export const WRITE_TOOL = "test.write";
export const NOVERIFY_TOOL = "test.noverify";

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
  const elig = (callId, o = {}) => authority.evaluateExecutionEligibility({ context: o.context || fx.ctx(), callId, holderId: o.holderId === undefined ? "exec_1" : o.holderId, requestArgumentsHash: o.requestArgumentsHash || null });
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
  return { fx, harness: fx, authority, store, toolStore: fx.toolStore, toolRegistry: fx.toolRegistry, taskStore: fx.taskStore, authService: fx.f.authService, adapters: fx.adapters, toolProxy: fx.toolProxy, taskService: fx.taskService, identity: fx.f.identity, grantTool: fx.grantTool, grantUserResource: fx.grantUserResource, createResource: fx.createResource, ctx, userCtx, aliceUserCtx, setupRun, plan, approve, deny, revokeApproval, lease, elig, registerResourceWriteTool };
}
