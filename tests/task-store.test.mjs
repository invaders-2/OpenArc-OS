/** D4-02A · Task persistence / restart / model snapshot / performance smoke。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import { createTaskFixture, reopenTaskRuntime } from "./task-fixtures.mjs";
import { tempDbPath } from "./authorization-fixtures.mjs";
import { startFakeProvider } from "./model-fake-provider.mjs";

const require = createRequire(import.meta.url);
const { SCHEMA_VERSION, SCHEMA_SQL, SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_V4_SQL, SCHEMA_V5_SQL, SCHEMA_V6_SQL, SCHEMA_V7_SQL, SCHEMA_V8_SQL } = require("../electron/identity-store.cjs");
const { DatabaseSync } = require("node:sqlite");

const providers = [];
const SECRET = "FAKE_PROVIDER_CRED_TASK_STORE";
const cleanup = [];
process.on("exit", () => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
after(async () => { for (const p of providers) { try { await p.close(); } catch { /* ignore */ } } });

async function mkModel(f, ctx) {
  const fp = await startFakeProvider({ behavior: "success" });
  providers.push(fp);
  const p = f.modelService.createProvider({ context: ctx, displayName: "StoreFake", baseUrl: fp.baseUrl, credentialSecret: SECRET });
  assert.equal(p.ok, true, JSON.stringify(p));
  const m = f.modelService.createModel({ context: ctx, providerId: p.provider.providerId, remoteModelId: "fake-1", capabilities: ["chat"] });
  assert.equal(m.ok, true, JSON.stringify(m));
  return m.model.configId;
}

test("TS1 · restart persistence：task / step / revision / events / model snapshot 全部恢复", async () => {
  const { dir, dbPath } = tempDbPath("oa-d4-02a-store");
  cleanup.push(dir);
  const f = await createTaskFixture({ dbPath });
  cleanup.push(f.storeRoot, f.sourceDir);
  const A = f.ctx("admin", "ai");
  const modelConfigId = await mkModel(f, A);
  const c = f.taskService.createTask({ context: A, goal: "persist me", modelConfigId });
  assert.equal(c.ok, true, JSON.stringify(c));
  const s = f.taskService.startTask({ context: A, taskId: c.task.taskId, expectedRevision: c.task.revision });
  const cs = f.taskService.createStep({ context: A, taskId: c.task.taskId, kind: "model", expectedRevision: s.task.revision });
  const ss = f.taskService.startStep({ context: A, taskId: c.task.taskId, stepId: cs.step.stepId, expectedRevision: cs.task.revision });
  const revision = ss.task.revision;
  const modelVersion = s.task.modelConfigVersion;
  f.identity.close();

  const rt = reopenTaskRuntime({ dbPath, clock: f.clock });
  try {
    const ctx2 = { sessionRef: f.sessions.admin, appId: "ai" };
    const got = rt.taskService.getTask({ context: ctx2, taskId: c.task.taskId });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.task.status, "RUNNING");
    assert.equal(got.task.revision, revision);
    assert.equal(got.task.modelConfigId, modelConfigId);
    assert.equal(got.task.modelConfigVersion, modelVersion);
    assert.equal(got.task.cancelRequested, false);
    const steps = rt.taskService.getSteps({ context: ctx2, taskId: c.task.taskId });
    assert.equal(steps.items.length, 1);
    assert.equal(steps.items[0].stepId, cs.step.stepId);
    assert.equal(steps.items[0].status, "RUNNING");
    const events = rt.taskService.getEvents({ context: ctx2, taskId: c.task.taskId });
    assert.deepEqual(events.items.map((x) => x.eventType), ["task.created", "task.started", "step.created", "step.started"]);
    assert.deepEqual(events.items.map((x) => x.sequence), [1, 2, 3, 4]);
  } finally {
    rt.close();
  }
});

test("TS2 · cancelRequested / CANCELLED 跨重启持久", async () => {
  const { dir, dbPath } = tempDbPath("oa-d4-02a-cancel");
  cleanup.push(dir);
  const f = await createTaskFixture({ dbPath });
  cleanup.push(f.storeRoot, f.sourceDir);
  const A = f.ctx("admin", "ai");
  const modelConfigId = await mkModel(f, A);
  const c = f.taskService.createTask({ context: A, goal: "cancel me", modelConfigId });
  const s = f.taskService.startTask({ context: A, taskId: c.task.taskId, expectedRevision: c.task.revision });
  const cancelled = f.taskService.cancelTask({ context: A, taskId: c.task.taskId, expectedRevision: s.task.revision });
  assert.equal(cancelled.task.cancelRequested, true);
  const revision = cancelled.task.revision;
  f.identity.close();

  const rt = reopenTaskRuntime({ dbPath, clock: f.clock });
  try {
    const ctx2 = { sessionRef: f.sessions.admin, appId: "ai" };
    const got = rt.taskService.getTask({ context: ctx2, taskId: c.task.taskId });
    assert.equal(got.task.status, "CANCELLED");
    assert.equal(got.task.cancelRequested, true);
    assert.equal(got.task.revision, revision);
    const types = rt.taskService.getEvents({ context: ctx2, taskId: c.task.taskId }).items.map((x) => x.eventType);
    assert.deepEqual(types.slice(-2), ["task.cancel_requested", "task.cancelled"]);
  } finally {
    rt.close();
  }
});

test("TS3 · Model snapshot：config 从 v1 变 v2 后 startModelCall → MODEL_CONFIG_CHANGED（不静默升级）", async () => {
  const f = await createTaskFixture();
  try {
    const A = f.ctx("admin", "ai");
    const modelConfigId = await mkModel(f, A);
    const c = f.taskService.createTask({ context: A, goal: "snapshot", modelConfigId });
    assert.equal(c.task.modelConfigVersion, 1);
    const s = f.taskService.startTask({ context: A, taskId: c.task.taskId, expectedRevision: c.task.revision });
    const bump = f.modelService.updateModel({ context: A, configId: modelConfigId, displayName: "renamed" });
    assert.equal(bump.ok, true, JSON.stringify(bump));
    assert.equal(bump.model.version, 2);
    const call = f.taskService.startModelCall({ context: A, taskId: c.task.taskId, expectedRevision: s.task.revision });
    assert.equal(call.ok, false, JSON.stringify(call));
    assert.equal(call.error, "MODEL_CONFIG_CHANGED");
    assert.equal(call.expected, 1);
    assert.equal(call.current, 2);
    assert.equal(f.taskStore.callsOfTask(c.task.taskId).length, 0, "拒绝时不得留下 call / 不得静默用 v2");
    assert.equal(f.taskStore.taskById(c.task.taskId).revision, s.task.revision, "拒绝时不得 bump revision");
  } finally {
    f.close();
  }
});

test("TS4 · performance smoke：create 100 tasks / append 1000 events / load / list", async () => {
  const f = await createTaskFixture();
  try {
    const A = f.ctx("admin", "ai");
    const modelConfigId = await mkModel(f, A);
    const t0 = performance.now();
    const ids = [];
    for (let i = 0; i < 100; i += 1) {
      const r = f.taskService.createTask({ context: A, goal: "perf-" + i, modelConfigId });
      assert.equal(r.ok, true);
      ids.push(r.task.taskId);
    }
    const createMs = performance.now() - t0;
    const t1 = performance.now();
    f.taskStore.transactSync(() => { for (let i = 0; i < 1000; i += 1) f.taskStore.appendEvent({ taskId: ids[0], eventType: "step.created", safePayload: { i } }); });
    const appendMs = performance.now() - t1;
    const t2 = performance.now();
    const loaded = f.taskService.getTask({ context: A, taskId: ids[0] });
    const loadMs = performance.now() - t2;
    const t3 = performance.now();
    const list = f.taskService.listTasks({ context: A });
    const listMs = performance.now() - t3;
    assert.equal(loaded.ok, true);
    assert.equal(list.items.length, 100);
    assert.equal(f.taskStore.eventsOfTask(ids[0]).length, 1001);
    const seqs = f.taskStore.eventsOfTask(ids[0]).map((e) => e.sequence);
    for (let i = 0; i < seqs.length; i += 1) assert.equal(seqs[i], i + 1);
    console.log("  [D4-02A perf smoke] create100=" + createMs.toFixed(1) + "ms append1000=" + appendMs.toFixed(1) + "ms load=" + loadMs.toFixed(3) + "ms list100=" + listMs.toFixed(3) + "ms  (MEASURED ON TEST MACHINE · NOT SLA)");
  } finally {
    f.close();
  }
});

test("TS5 · migration v8 → v10：追加 Task 与 Harness/Artifact 表；v9 级失败回滚到 8", () => {
  const { dir, dbPath } = tempDbPath("oa-d4-02a-v8");
  cleanup.push(dir);
  // 造一个真实 v8 库
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA foreign_keys = ON");
  for (const sql of [SCHEMA_SQL, SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_V4_SQL, SCHEMA_V5_SQL, SCHEMA_V6_SQL, SCHEMA_V7_SQL, SCHEMA_V8_SQL]) raw.exec(sql);
  raw.exec("PRAGMA user_version = 8");
  raw.close();
  assert.equal(SCHEMA_VERSION, 10);
  const store = new (require("../electron/identity-store.cjs").IdentityStore)({ path: dbPath }).open();
  assert.equal(store.schemaVersion, 10);
  const tables = store.connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ["tasks", "task_steps", "task_model_calls", "task_events", "task_harness_runs", "task_artifacts", "task_verifications"]) assert.ok(tables.includes(t), "缺少表 " + t);
  store.close();

  // v9 级失败 → 整级回滚，user_version 保持 8，task 表不残留
  const { dir: dir2, dbPath: dbPath2 } = tempDbPath("oa-d4-02a-v8-rollback");
  cleanup.push(dir2);
  const raw2 = new DatabaseSync(dbPath2);
  raw2.exec("PRAGMA foreign_keys = ON");
  for (const sql of [SCHEMA_SQL, SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_V4_SQL, SCHEMA_V5_SQL, SCHEMA_V6_SQL, SCHEMA_V7_SQL, SCHEMA_V8_SQL]) raw2.exec(sql);
  raw2.exec("PRAGMA user_version = 8");
  raw2.close();
  let failed = false;
  try {
    new (require("../electron/identity-store.cjs").IdentityStore)({ path: dbPath2, hooks: { onMigration: (v) => { if (v === 9) throw new Error("boom"); } } }).open();
  } catch { failed = true; }
  assert.equal(failed, true);
  const check = new DatabaseSync(dbPath2);
  assert.equal(Number(check.prepare("PRAGMA user_version").get().user_version), 8);
  const t2 = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.equal(t2.some((n) => /^task_/.test(n) || n === "tasks"), false, "失败回滚不得残留 task 表");
  check.close();
});
