/** D4-02A 测试夹具：在 Model fixture 之上叠加 TaskStore / TaskService（同一 Identity/Auth/Model 运行时）。 */
import { createRequire } from "node:module";
import { createModelFixture } from "./model-fixtures.mjs";
const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { AuthorizationStore } = require("../electron/authorization-store.cjs");
const { AuthorizationService } = require("../electron/authorization-service.cjs");
const { ModelStore } = require("../electron/model-store.cjs");
const { CredentialStore, memoryCredentialBackend } = require("../electron/credential-store.cjs");
const { ModelService } = require("../electron/model-service.cjs");
const { TaskStore } = require("../electron/task-store.cjs");
const { TaskService } = require("../electron/task-service.cjs");

const APPS = { A: "ai", B: "canvas" };

function seedApps(f) {
  for (const appId of [APPS.A, APPS.B]) f.store.upsertApp({ appId, name: appId, publisher: "test", status: "enabled", builtIn: 0 });
  f.modelService.grantAppModelAccess({ context: f.adminCtx(), appId: APPS.A, actions: ["model.view", "model.use", "model.manage", "model.test"] });
}

export async function createTaskFixture({ dbPath = ":memory:", storeRoot = null } = {}) {
  const f = await createModelFixture({ dbPath, storeRoot });
  seedApps(f);
  const taskStore = new TaskStore({ identity: f.identity, clock: f.clock });
  const taskService = new TaskService({ identity: f.identity, authService: f.authService, authStore: f.store, taskStore, modelService: f.modelService, clock: f.clock });
  const ctx = (key = "admin", appId = APPS.A) => ({ sessionRef: f.sessions[key], appId, source: "test" });
  return { ...f, taskStore, taskService, APPS, ctx };
}

/** 在同一 DB 上重开运行时（模拟进程重启）。 */
export function reopenTaskRuntime({ dbPath, clock = null } = {}) {
  // clock 必须与首开一致：session 校验用注入时钟，否则固定时钟夹具的会话会被 wall-clock 判过期。
  const identity = new IdentityStore({ path: dbPath, clock }).open();
  const authStore = new AuthorizationStore({ identity, clock });
  const authService = new AuthorizationService({ identity, authStore });
  const modelStore = new ModelStore({ identity, clock });
  const credentialStore = new CredentialStore({ store: modelStore, backend: memoryCredentialBackend() });
  const modelService = new ModelService({ identity, authService, authStore, modelStore, credentialStore, clock, timeoutMs: 3000 });
  const taskStore = new TaskStore({ identity, clock });
  const taskService = new TaskService({ identity, authService, authStore, taskStore, modelService, clock });
  return { identity, authStore, authService, modelStore, credentialStore, modelService, taskStore, taskService, close: () => { try { identity.close(); } catch { /* ignore */ } } };
}
