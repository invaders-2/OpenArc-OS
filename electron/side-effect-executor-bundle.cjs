/**
 * D4-03C4 · Side-effect executor runtime bundle 工厂（OpenArc-owned）。
 *
 * 为什么单独成文件：C4 的 production mutation 必须发生在**受监督的 executor runtime**
 * 里（见 runtime-supervisor.cjs）。production child 与 C4 集成测试都要装同一套 Domain，
 * 若各装一遍，"验证过的那条线"与"产品跑的那条线"就不是同一条。
 *
 * 本工厂只装既有 authority（Identity / Authorization / Task / Resource / Tool / Side-effect），
 * 绝不建立第二套 Task / permission / approval / execution state。
 */
"use strict";
const { IdentityStore } = require("./identity-store.cjs");
const { AuthorizationStore } = require("./authorization-store.cjs");
const { AuthorizationService } = require("./authorization-service.cjs");
const { TaskStore } = require("./task-store.cjs");
const { TaskService } = require("./task-service.cjs");
const { ResourceStore } = require("./resource-store.cjs");
const { ManagedStore } = require("./resource-fs.cjs");
const { ResourceService } = require("./resource-service.cjs");
const { ToolStore } = require("./tool-store.cjs");
const { ToolRegistry } = require("./tool-registry.cjs");
const { SideEffectStore } = require("./side-effect-store.cjs");
const { SideEffectAuthority } = require("./side-effect-authority.cjs");
const { createToolAdapters } = require("./tool-adapters.cjs");

function createSideEffectExecutorBundle({ dbPath, storeRoot, instanceId, clock = null, lifecycle = null, testHooks = null, registry = null, resourceServiceWrapper = null } = {}) {
  if (!dbPath) throw new Error("createSideEffectExecutorBundle 需要 dbPath");
  if (!instanceId) throw new Error("createSideEffectExecutorBundle 需要 instanceId");
  const identity = new IdentityStore({ path: dbPath, clock: clock || undefined }).open();
  const authStore = new AuthorizationStore({ identity, clock });
  const authService = new AuthorizationService({ identity, authStore });
  const taskStore = new TaskStore({ identity, clock });
  const taskService = new TaskService({ identity, authService, authStore, taskStore, clock });
  let resourceService = null;
  if (storeRoot) {
    const managedStore = new ManagedStore({ root: storeRoot });
    managedStore.ensureLayout();
    const resourceStore = new ResourceStore({ identity, clock });
    resourceService = new ResourceService({ identity, resourceStore, managedStore, authService, authStore, clock });
    if (typeof resourceServiceWrapper === "function") resourceService = resourceServiceWrapper(resourceService);
  }
  const adapters = createToolAdapters({ resourceService });
  const toolRegistry = registry || new ToolRegistry();
  const toolStore = new ToolStore({ identity, clock });
  const sideEffectStore = new SideEffectStore({ identity, clock });
  const authority = new SideEffectAuthority({ registry: toolRegistry, sideEffectStore, taskStore, toolStore, authService, adapters, clock: clock || undefined, taskService, instanceId, lifecycle, testHooks });
  return {
    identity, authStore, authService, taskStore, taskService, resourceService, adapters,
    registry: toolRegistry, toolStore, sideEffectStore, authority,
    close() { try { identity.close(); } catch { /* ignore */ } },
  };
}

module.exports = { createSideEffectExecutorBundle };
