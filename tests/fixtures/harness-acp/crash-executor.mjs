/**
 * D4-03C3 · Crash executor child：真实执行 resource.trash，并在指定的 test-only hook 处 process.exit，
 * 模拟 claim 后 / mutation 后 / verification 后 / SUCCEEDED 后的真实进程死亡。
 */
import { createRequire } from "node:module";
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

let deleteCalls = 0;
const realDelete = resourceService.delete.bind(resourceService);
resourceService.delete = async (a) => { deleteCalls += 1; return realDelete(a); };

const crash = (point) => {
  if (String(args.crashPoint) !== point) return;
  process.stdout.write(JSON.stringify({ type: "crash", point, deleteCalls }) + "\n");
  try { identity.close(); } catch { /* ignore */ }
  process.exit(7);
};
const testHooks = {
  afterClaimBeforeDispatch: () => crash("before_dispatch"),
  afterDomainResultBeforeVerification: () => crash("after_mutation"),
  afterVerificationBeforeFinalPersist: () => crash("after_verification"),
  afterSucceededBeforeLeaseFinalize: () => crash("after_succeeded"),
};
const authority = new SideEffectAuthority({ registry, sideEffectStore, taskStore, toolStore, authService, adapters, clock: () => args.now, taskService, instanceId: args.instanceId, testHooks });
let result;
try { result = await authority.executeSideEffect({ callId: args.callId, leaseId: args.leaseId, holderId: args.holderId, timeoutMs: 20000 }); }
catch (e) { result = { ok: false, error: "THREW", detail: String((e && (e.errstr || e.message)) || e) }; }
process.stdout.write(JSON.stringify({ type: "result", deleteCalls, result: { ok: result.ok, error: result.error, status: result.call && result.call.status, verificationStatus: result.verificationStatus } }) + "\n");
try { identity.close(); } catch { /* ignore */ }
process.exit(0);
