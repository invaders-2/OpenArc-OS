/** D4-03C1 Closure · Lease contender child process：等待 barrier 后同时 acquireLease。 */
import { createRequire } from "node:module";
import readline from "node:readline";
const require = createRequire(import.meta.url);
const { IdentityStore } = require("../../../electron/identity-store.cjs");
const { TaskStore } = require("../../../electron/task-store.cjs");
const { ToolRegistry } = require("../../../electron/tool-registry.cjs");
const { SideEffectStore } = require("../../../electron/side-effect-store.cjs");
const { SideEffectAuthority } = require("../../../electron/side-effect-authority.cjs");

const args = JSON.parse(process.argv[2] || "{}");
const identity = new IdentityStore({ path: args.dbPath }).open();
const taskStore = new TaskStore({ identity });
const store = new SideEffectStore({ identity });
const authority = new SideEffectAuthority({ registry: new ToolRegistry(), sideEffectStore: store, taskStore, toolStore: null, authService: {}, adapters: null, clock: args.now != null ? () => args.now : null, taskService: null, instanceId: args.instanceId });

process.stdout.write(JSON.stringify({ type: "ready", holderId: args.holderId }) + "\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (String(line).trim() !== "GO") return;
  let result;
  try {
    result = authority.acquireLease({ context: {}, callId: args.callId, holderId: args.holderId, instanceId: args.instanceId, ttlMs: 60000 });
  } catch (e) {
    result = { ok: false, error: "THREW", detail: String((e && (e.errstr || e.message)) || e) };
  }
  process.stdout.write(JSON.stringify({ type: "result", holderId: args.holderId, result }) + "\n");
  identity.close();
  rl.close();
  process.exit(0);
});
