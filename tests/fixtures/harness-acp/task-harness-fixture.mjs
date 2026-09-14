/** D4-02C 测试夹具：Task Runtime + Model Proxy + Fake Provider + Orchestrator（真实链路，不 mock service）。 */
import { createRequire } from "node:module";
import path from "node:path";
import { createModelFixture } from "../../model-fixtures.mjs";
import { startFakeProvider } from "../../model-fake-provider.mjs";
const require = createRequire(import.meta.url);
const { ModelProxy } = require("../../../electron/model-proxy.cjs");
const { HarnessAdapter } = require("../../../electron/harness-adapter.cjs");
const { TaskStore } = require("../../../electron/task-store.cjs");
const { TaskService } = require("../../../electron/task-service.cjs");
const { TaskHarnessOrchestrator } = require("../../../electron/task-harness-orchestrator.cjs");

export const PROVIDER_SECRET = "FAKE_PROVIDER_SECRET_D4_02C_PROBE";
export const APPS = { A: "ai", B: "canvas" };
export const EXACT = "OPENARC_TASK_OK";
export const AGENT_DIR = path.join(import.meta.dirname);

export async function createTaskHarnessFixture({ behavior = "exact", dbPath = ":memory:", hooks = null } = {}) {
  const f = await createModelFixture({ dbPath });
  for (const appId of [APPS.A, APPS.B]) f.store.upsertApp({ appId, name: appId, publisher: "test", status: "enabled", builtIn: 0 });
  f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: APPS.A, actions: ["model.view", "model.use", "model.manage", "model.test"] });
  const ctx = (key = "admin", appId = APPS.A) => ({ sessionRef: f.sessions[key], appId, source: "test" });
  const fp = await startFakeProvider({ behavior, secretEcho: null });
  const p = f.modelService.createProvider({ context: ctx(), displayName: "D402CProbe", baseUrl: fp.baseUrl, credentialSecret: PROVIDER_SECRET });
  if (!p.ok) throw new Error("createProvider failed " + JSON.stringify(p));
  const m = f.modelService.createModel({ context: ctx(), providerId: p.provider.providerId, remoteModelId: "remote-fake-1", capabilities: ["chat"] });
  if (!m.ok) throw new Error("createModel failed " + JSON.stringify(m));
  const proxy = new ModelProxy({ modelService: f.modelService, clock: f.clock, ttlMs: 300000 });
  await proxy.start();
  const taskStore = new TaskStore({ identity: f.identity, clock: f.clock });
  const taskService = new TaskService({ identity: f.identity, authService: f.authService, authStore: f.store, taskStore, modelService: f.modelService, clock: f.clock, hooks });
  const realFactory = () => new HarnessAdapter({ modelProxy: proxy });
  const orchestrator = new TaskHarnessOrchestrator({ taskService, adapterFactory: realFactory, clock: f.clock });
  return {
    f, fp, proxy, taskStore, taskService, orchestrator,
    modelConfigId: m.model.configId, providerId: p.provider.providerId, ctx,
    createTask(goal = "Return exactly: " + EXACT, opts = {}) {
      return taskService.createTask({ context: opts.context || ctx(), goal, modelConfigId: m.model.configId });
    },
    makeOrchestrator(adapterFactory, extra = {}) { return new TaskHarnessOrchestrator({ taskService, adapterFactory, clock: f.clock, ...extra }); },
    /** 用最小 ACP agent（tool / permission probe）充当 Harness 进程。 */
    agentFactory(agentFile) { return () => new HarnessAdapter({ modelProxy: proxy, dshBin: process.execPath, dshArgs: [path.join(AGENT_DIR, agentFile)] }); },
    async close() { try { await orchestrator.dispose(); } catch { /* ignore */ } try { await proxy.stop(); } catch { /* ignore */ } try { await fp.close(); } catch { /* ignore */ } f.close(); },
  };
}
