/**
 * D4-03C3 Closure · Live runtime executor child。
 *
 * 真实执行 resource.trash，但 Domain mutation 由一个 stdin gate（"MUTATE"）控制：
 *  - Authority timeout → Call persisted UNKNOWN_EFFECT(quiesced=false)，child 打印 unknown_effect；
 *  - 父进程可在 mutation 前 kill（→ NOT_APPLIED 场景），或先放行 MUTATE 让 mutation 真正提交
 *    （→ late applied 场景），再 kill。
 * 本 child 绝不 finalize（父进程 kill 后由新的 runtime 做 recovery verification）。
 */
import { createRequire } from "node:module";
import readline from "node:readline";
const require = createRequire(import.meta.url);
const { IdentityStore } = require("../../../electron/identity-store.cjs");
const { AuthorizationStore } = require("../../../electron/authorization-store.cjs");
const { AuthorizationService } = require("../../../electron/authorization-service.cjs");
const { TaskStore } = require("../../../electron/task-store.cjs");
const { TaskService } = require("../../../electron/task-service.cjs");
const { ResourceStore } = require("../../../electron/resource-store.cjs");
const { ManagedStore } = require("../../../electron/resource-fs.cjs");
const { ResourceService } = require("../../../electron/resource-service.cjs");
const { ToolStore } = require("../../../electron/tool-store.cjs");
const { ToolRegistry } = require("../../../electron/tool-registry.cjs");
const { SideEffectStore } = require("../../../electron/side-effect-store.cjs");
const { SideEffectAuthority } = require("../../../electron/side-effect-authority.cjs");
const { createToolAdapters } = require("../../../electron/tool-adapters.cjs");

const args = JSON.parse(process.argv[2] || "{}");
const clock = args.now != null ? () => args.now : undefined;
const identity = new IdentityStore({ path: args.dbPath, clock }).open();
const authStore = new AuthorizationStore({ identity, clock });
const authService = new AuthorizationService({ identity, authStore });
const taskStore = new TaskStore({ identity, clock });
const taskService = new TaskService({ identity, authService, authStore, taskStore, clock });
const resourceStore = new ResourceStore({ identity, clock });
const managedStore = new ManagedStore({ root: args.storeRoot });
managedStore.ensureLayout();
const resourceService = new ResourceService({ identity, resourceStore, managedStore, authService, authStore, clock });
const adapters = createToolAdapters({ resourceService });
const registry = new ToolRegistry();
const toolStore = new ToolStore({ identity, clock });
const sideEffectStore = new SideEffectStore({ identity, clock });

let gateResolve = null;
const gate = new Promise((r) => { gateResolve = r; });
let deleteCalls = 0;
const realDelete = resourceService.delete.bind(resourceService);
resourceService.delete = async (a) => {
  deleteCalls += 1;
  await gate;
  const res = await realDelete(a);
  process.stdout.write(JSON.stringify({ type: "mutation_done", deleteCalls }) + "\n");
  return res;
};

const authority = new SideEffectAuthority({ registry, sideEffectStore, taskStore, toolStore, authService, adapters, clock: () => args.now, taskService, instanceId: args.instanceId });
const result = await authority.executeSideEffect({ callId: args.callId, leaseId: args.leaseId, holderId: args.holderId, timeoutMs: args.timeoutMs || 200 });
process.stdout.write(JSON.stringify({ type: "unknown_effect", status: result.call && result.call.status, quiesced: !!(result.call && result.call.recoverySafe && result.call.recoverySafe.quiesced), deleteCalls }) + "\n");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (String(line).trim() === "MUTATE") { if (gateResolve) gateResolve(); }
});
