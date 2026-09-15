/** D4-03A 夹具：在 D4-02C Task/Harness 夹具之上叠加 ToolStore / ToolRegistry / ControlledToolProxy。 */
import { createRequire } from "node:module";
import { createTaskHarnessFixture, APPS, EXACT, PROVIDER_SECRET as TASK_PROVIDER_SECRET } from "./task-harness-fixture.mjs";
const require = createRequire(import.meta.url);
const { ToolStore } = require("../../../electron/tool-store.cjs");
const { ToolRegistry } = require("../../../electron/tool-registry.cjs");
const { ControlledToolProxy } = require("../../../electron/controlled-tool-proxy.cjs");
const { createToolAdapters } = require("../../../electron/tool-adapters.cjs");
const { TaskHarnessOrchestrator } = require("../../../electron/task-harness-orchestrator.cjs");
const { SideEffectStore } = require("../../../electron/side-effect-store.cjs");
const { SideEffectAuthority } = require("../../../electron/side-effect-authority.cjs");

export { APPS, EXACT };
export const PROVIDER_SECRET = "FAKE_PROVIDER_SECRET_D4_03A_PROBE";

export async function createToolHarnessFixture(opts = {}) {
  const base = await createTaskHarnessFixture(opts);
  const toolStore = new ToolStore({ identity: base.f.identity, clock: base.f.clock });
  const toolRegistry = new ToolRegistry();
  // withAdapters=true 才允许真实 READ_ONLY 执行（D4-03B）；默认保持 D4-03A gate 语义。
  const adapters = opts.withAdapters ? createToolAdapters({ resourceService: base.f.resourceService, searchService: base.f.searchService }) : null;
  const toolProxy = new ControlledToolProxy({ registry: toolRegistry, toolStore, authService: base.f.authService, taskStore: base.taskStore, adapters, clock: base.f.clock });
  const sideEffectClock = typeof opts.sideEffectClock === "function" ? opts.sideEffectClock : base.f.clock;
  const sideEffectStore = new SideEffectStore({ identity: base.f.identity, clock: sideEffectClock });
  const sideEffectAuthority = new SideEffectAuthority({ registry: toolRegistry, sideEffectStore, taskStore: base.taskStore, toolStore, authService: base.f.authService, adapters, clock: sideEffectClock, taskService: base.taskService, instanceId: opts.sideEffectInstanceId || "inst_test", testHooks: opts.sideEffectTestHooks || null });
  return {
    ...base, toolStore, toolRegistry, toolProxy, adapters, sideEffectStore, sideEffectAuthority,
    /** 用 synthetic ACP tool proposal fixture 充当 Harness。*/
    makeToolOrchestrator(agentFile = "tool-proposal-agent.mjs", extra = {}) {
      return new TaskHarnessOrchestrator({ taskService: base.taskService, adapterFactory: base.agentFactory(agentFile), toolProxy, clock: base.f.clock, ...extra });
    },
    /** D4-03B Closure：真实 official dsh + managed openarc-acp profile + Tool Facade Bridge。*/
    makeDshOrchestrator(extra = {}) {
      return new TaskHarnessOrchestrator({
        taskService: base.taskService,
        adapterFactory: base.realAgentFactory(),
        toolProxy,
        clock: base.f.clock,
        toolFacade: { enabled: true, toolIds: opts.facadeToolIds || ["resource.read.metadata", "resource.search"], maxCalls: opts.facadeMaxCalls || 4, ttlMs: opts.facadeTtlMs || 120000, execTimeoutMs: opts.facadeExecTimeoutMs, bridgeFactory: opts.facadeBridgeFactory },
        ...extra,
      });
    },
    makeDshAdapter() { return base.realAgentFactory()(); },
    grantTool(appId, actions) { return base.f.authService.grantAppToolPermission({ context: base.ctx("admin"), appId, actions }); },
    async createResource(name = "Tool Target") {
      return base.f.resourceService.createResource({ context: base.f.adminCtx(), resourceType: "text", name, content: "tool-target-body" });
    },
    /** D4-03B Closure：为 Tool Facade 直接调用准备 RUNNING task/step/run（不启动 official dsh）。 */
    dshRunSetup(context = null) {
      const c = context || base.ctx();
      const t = base.taskService.createTask({ context: c, goal: "bridge probe" });
      const st = base.taskService.startTask({ context: c, taskId: t.task.taskId, expectedRevision: t.task.revision });
      const step = base.taskService.createStep({ context: c, taskId: t.task.taskId, kind: "reasoning", input: null, expectedRevision: st.task.revision });
      const ss = base.taskService.startStep({ context: c, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: step.task.revision });
      const run = base.taskService.startHarnessRun({ context: c, taskId: t.task.taskId, stepId: step.step.stepId, expectedRevision: ss.task.revision });
      const mr = base.taskService.markHarnessRunRunning({ context: c, taskId: t.task.taskId, runId: run.run.runId, expectedRevision: run.task.revision });
      return { context: c, taskId: t.task.taskId, stepId: step.step.stepId, runId: run.run.runId, revision: mr.ok ? mr.task.revision : ss.task.revision };
    },
    /** D4-03B Closure：建立 ORGANIZATION 级 model config + default，使非 admin 用户也能走 official dsh。 */
    enableOrgModel() {
      const admin = base.ctx();
      const prov = base.f.modelService.createProvider({ context: admin, displayName: "OrgModelProbe", baseUrl: base.fp.baseUrl, credentialSecret: TASK_PROVIDER_SECRET, scope: "ORGANIZATION" });
      if (!prov.ok) return { ok: false, error: prov.error };
      const model = base.f.modelService.createModel({ context: admin, providerId: prov.provider.providerId, remoteModelId: "remote-fake-1", capabilities: ["chat"], scope: "ORGANIZATION" });
      if (!model.ok) return { ok: false, error: model.error };
      const def = base.f.modelService.setDefault({ context: admin, capability: "chat", configId: model.model.configId, scope: "ORGANIZATION" });
      if (!def.ok) return { ok: false, error: def.error };
      return { ok: true, configId: model.model.configId, providerId: prov.provider.providerId };
    },
    grantUserResource(resourceId, userId, actions) {
      return base.f.authService.grantResourcePermission({ context: base.f.adminCtx(), principalType: "USER", principalId: userId, resourceId, actions });
    },
    async close() { await base.close(); },
  };
}
