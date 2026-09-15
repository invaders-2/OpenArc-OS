/**
 * D4-03C2 Closure · Claim contender child process。
 *
 * 两个 child 代表**同一个合法 executor identity**（同 callId / leaseId / holderId /
 * holderInstanceId），等待 barrier 后同时 executeSideEffect，真实争 LEASED → RUNNING。
 * 只有独立 OS 进程才能在两个 event loop 之间产生真实同时的 BEGIN IMMEDIATE contention。
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
// 与父 runtime 使用同一 trusted clock，否则 fake-clock session 在子进程会显示过期。
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
const authority = new SideEffectAuthority({
  registry, sideEffectStore, taskStore, toolStore, authService, adapters,
  clock: args.now != null ? () => args.now : null,
  taskService, instanceId: args.instanceId,
});

let deleteCalls = 0;
const realDelete = resourceService.delete.bind(resourceService);
// domainDelayMs（test-only）：让 winner 在 claim 之后、真实 mutation 之前停留，
// 使 duplicate invocation 有真实机会在 RUNNING 状态下争 claim（而不是更早的 gate 失败）。
resourceService.delete = async (a) => {
  deleteCalls += 1;
  if (args.domainDelayMs) await new Promise((r) => setTimeout(r, args.domainDelayMs));
  return realDelete(a);
};

process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (String(line).trim() !== "GO") return;
  let result;
  try {
    result = await authority.executeSideEffect({ callId: args.callId, leaseId: args.leaseId, holderId: args.holderId, holderInstanceId: args.holderInstanceId, timeoutMs: 20000 });
  } catch (e) {
    result = { ok: false, error: "THREW", detail: String((e && (e.errstr || e.message)) || e) };
  }
  process.stdout.write(JSON.stringify({
    type: "result",
    deleteCalls,
    result: { ok: result.ok, error: result.error, executed: result.executed, duplicate: result.duplicate, mutationCount: result.mutationCount, status: result.call && result.call.status, verificationStatus: result.verificationStatus },
  }) + "\n");
  identity.close();
  rl.close();
  process.exit(0);
});
