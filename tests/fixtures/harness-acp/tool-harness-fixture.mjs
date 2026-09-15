/** D4-03A 夹具：在 D4-02C Task/Harness 夹具之上叠加 ToolStore / ToolRegistry / ControlledToolProxy。 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskHarnessFixture, APPS, EXACT, PROVIDER_SECRET as TASK_PROVIDER_SECRET } from "./task-harness-fixture.mjs";
import { reopenResourceRuntime } from "../../resource-fixtures.mjs";
const require = createRequire(import.meta.url);
const { TaskStore } = require("../../../electron/task-store.cjs");
const { TaskService } = require("../../../electron/task-service.cjs");
const { ToolStore } = require("../../../electron/tool-store.cjs");
const { ToolRegistry } = require("../../../electron/tool-registry.cjs");
const { ControlledToolProxy } = require("../../../electron/controlled-tool-proxy.cjs");
const { createToolAdapters } = require("../../../electron/tool-adapters.cjs");
const { TaskHarnessOrchestrator } = require("../../../electron/task-harness-orchestrator.cjs");
const { SideEffectStore } = require("../../../electron/side-effect-store.cjs");
const { SideEffectAuthority } = require("../../../electron/side-effect-authority.cjs");
const { SideEffectRuntime } = require("../../../electron/side-effect-runtime.cjs");
const { RuntimeSupervisor } = require("../../../electron/runtime-supervisor.cjs");

export { APPS, EXACT };
export const PROVIDER_SECRET = "FAKE_PROVIDER_SECRET_D4_03A_PROBE";

/**
 * D4-03C4 · 在同一 disk DB / store 上重开 production side-effect runtime（真实 restart）。
 * 不重建用户 / model config，只重建 authority 链 —— 与 production bootstrap 的顺序一致：
 *   recover() = TaskService.recoverRunning() → SideEffectRuntime.recoverOnStartup()
 */
export async function reopenToolHarnessRuntime({ dbPath, storeRoot, runtimeDir, executorEntry = null, approvalWaitMs = 400, instanceId = "inst_restart", clock = null, probeImpl = null } = {}) {
  const clk = typeof clock === "function" ? clock : null;
  const base = reopenResourceRuntime({ dbPath, storeRoot, clock: clk });
  const toolStore = new ToolStore({ identity: base.identity, clock: clk });
  const toolRegistry = new ToolRegistry();
  const adapters = createToolAdapters({ resourceService: base.resourceService, searchService: base.searchService });
  const taskStore = new TaskStore({ identity: base.identity, clock: clk });
  const taskService = new TaskService({ identity: base.identity, authService: base.authService, authStore: base.authStore, taskStore, clock: clk });
  const toolProxy = new ControlledToolProxy({ registry: toolRegistry, toolStore, authService: base.authService, taskStore, adapters, clock: clk });
  const sideEffectStore = new SideEffectStore({ identity: base.identity, clock: clk });
  const supervisor = new RuntimeSupervisor({ runtimeDir, executorEntry, clock: clk, probeImpl });
  await supervisor.rehydrate();
  const sideEffectAuthority = new SideEffectAuthority({ registry: toolRegistry, sideEffectStore, taskStore, toolStore, authService: base.authService, adapters, taskService, instanceId, lifecycle: supervisor, clock: clk });
  const sideEffectRuntime = new SideEffectRuntime({ authority: sideEffectAuthority, supervisor, store: sideEffectStore, taskStore, taskService, toolProxy, registry: toolRegistry, resourceStore: base.resourceStore, authService: base.authService, dbPath, storeRoot, approvalWaitMs, clock: clk });
  return {
    ...base, toolStore, toolRegistry, toolProxy, adapters, taskStore, taskService, sideEffectStore, sideEffectAuthority, supervisor, sideEffectRuntime,
    /** production 顺序的两段 recovery。 */
    recover() { const taskRecovery = taskService.recoverRunning(); const sideEffect = sideEffectRuntime.recoverOnStartup(); return { taskRecovery, sideEffect }; },
    close() { try { supervisor.stop(); } catch { /* ignore */ } try { base.identity.close(); } catch { /* ignore */ } },
  };
}

export async function createToolHarnessFixture(opts = {}) {
  const base = await createTaskHarnessFixture(opts);
  const toolStore = new ToolStore({ identity: base.f.identity, clock: base.f.clock });
  const toolRegistry = new ToolRegistry();
  // withAdapters=true 才允许真实 READ_ONLY 执行（D4-03B）；默认保持 D4-03A gate 语义。
  const adapters = opts.withAdapters ? createToolAdapters({ resourceService: base.f.resourceService, searchService: base.f.searchService }) : null;
  const toolProxy = new ControlledToolProxy({ registry: toolRegistry, toolStore, authService: base.f.authService, taskStore: base.taskStore, adapters, clock: base.f.clock });
  const sideEffectClock = typeof opts.sideEffectClock === "function" ? opts.sideEffectClock : base.f.clock;
  const sideEffectStore = new SideEffectStore({ identity: base.f.identity, clock: sideEffectClock });
  // D4-03C4：唯一 production side-effect 装配（test 只注入参数，不自己拼 authority 链）。
  const sideEffectRuntimeDir = opts.sideEffectRuntimeDir || fs.mkdtempSync(path.join(os.tmpdir(), "oa-c4-runtime-"));
  const supervisor = new RuntimeSupervisor({ runtimeDir: sideEffectRuntimeDir, clock: sideEffectClock, executorEntry: opts.sideEffectExecutorEntry || null });
  // 测试夹具必须等 production supervisor 完成 rehydrate，否则 quiescence 一律 fail closed。
  await supervisor.rehydrate();
  // 默认 lifecycle = production supervisor；需要精确控制时由测试显式注入 sideEffectLifecycle。
  const sideEffectAuthority = new SideEffectAuthority({ registry: toolRegistry, sideEffectStore, taskStore: base.taskStore, toolStore, authService: base.f.authService, adapters, clock: sideEffectClock, taskService: base.taskService, instanceId: opts.sideEffectInstanceId || "inst_test", lifecycle: opts.sideEffectLifecycle || supervisor, testHooks: opts.sideEffectTestHooks || null });
  const sideEffectRuntime = new SideEffectRuntime({
    authority: sideEffectAuthority, supervisor, store: sideEffectStore,
    taskStore: base.taskStore, taskService: base.taskService, toolProxy,
    registry: toolRegistry, resourceStore: base.f.resourceStore, authService: base.f.authService,
    dbPath: opts.dbPath && opts.dbPath !== ":memory:" ? opts.dbPath : null,
    storeRoot: base.f.storeRoot, clock: sideEffectClock, logger: null,
    ...(opts.sideEffectApprovalWaitMs ? { approvalWaitMs: opts.sideEffectApprovalWaitMs } : {}),
    ...(opts.sideEffectExecutorTimeoutMs ? { executorTimeoutMs: opts.sideEffectExecutorTimeoutMs } : {}),
  });
  return {
    ...base, toolStore, toolRegistry, toolProxy, adapters, sideEffectStore, sideEffectAuthority, supervisor, sideEffectRuntime, sideEffectRuntimeDir,
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
        sideEffectRuntime,
        clock: base.f.clock,
        toolFacade: { enabled: true, toolIds: opts.facadeToolIds || ["resource.read.metadata", "resource.search"], writeToolIds: opts.facadeWriteToolIds || [], maxCalls: opts.facadeMaxCalls || 4, ttlMs: opts.facadeTtlMs || 120000, execTimeoutMs: opts.facadeExecTimeoutMs, bridgeFactory: opts.facadeBridgeFactory },
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
    async close() { try { supervisor.stop(); } catch { /* ignore */ } await base.close(); },
  };
}
