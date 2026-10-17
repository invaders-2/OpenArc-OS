/**
 * task-8 B · 任务双表 v29 合并：启动开关 + 真实库副本迁移 + 备份/回滚/foreign_key_check。
 * 复用 tests/task-merge-fixtures.mjs 的 v28 真库夹具；不启用生产默认迁移。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createSeededV28, makeTempDir, TASKS_CHILD_TABLES } from "./task-merge-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const { createIdentityService } = require("../electron/identity-bootstrap.cjs");
const merge = require("../electron/task-merge-migration.cjs");

const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
function freshDir() { const dir = makeTempDir("oa-task-v29-startup-"); dirs.push(dir); return dir; }
const count = (db, table) => db.prepare("SELECT COUNT(*) AS c FROM " + table).get().c;
const typeOf = (db, name) => (db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name) || {}).type;

test("① 开关：默认关闭 / 文件开关 / 环境变量 / 显式选项优先级", () => {
  const dir = freshDir();
  assert.equal(merge.taskMergeSwitchState({ userDataDir: dir, env: {} }).enabled, false);
  assert.equal(merge.taskMergeSwitchState({ userDataDir: dir, env: {}, enabled: true }).source, "option");
  fs.mkdirSync(path.join(dir, "dxos", "settings"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dxos", "settings", "task-merge-v29.json"), JSON.stringify({ enabled: true }));
  assert.deepEqual({ enabled: merge.taskMergeSwitchState({ userDataDir: dir, env: {} }).enabled, source: "file" }, { enabled: true, source: "file" });
  fs.writeFileSync(path.join(dir, "dxos", "settings", "task-merge-v29.json"), JSON.stringify({ enabled: false }));
  assert.equal(merge.taskMergeSwitchState({ userDataDir: dir, env: { OPENARC_TASK_MERGE_V29: "1" } }).enabled, false, "文件显式关闭优先于 env");
  assert.equal(merge.taskMergeSwitchState({ userDataDir: freshDir(), env: { OPENARC_TASK_MERGE_V29: "1" } }).enabled, true);
});

test("② 真实库副本：开关开启 → 备份 + v29 + foreign_key_check 为空；重启仍可打开且幂等", () => {
  const dir = freshDir();
  const source = createSeededV28(dir);
  const copy = path.join(dir, "copy.db");
  fs.copyFileSync(source, copy);
  const backupDir = path.join(dir, "backup");
  const store = new IdentityStore({ path: copy, backupDir }).open();
  try {
    assert.equal(store.schemaVersion, 28);
    const beforeChildren = Object.fromEntries(TASKS_CHILD_TABLES.map((table) => [table, table === "task_steps"
      ? count(store.connection, "task_steps") + count(store.connection, "dx_task_steps")
      : table === "task_events"
        ? count(store.connection, "task_events") + count(store.connection, "dx_task_events")
        : count(store.connection, table)]));
    const result = merge.applyTaskMergeAtStartup({ store, userDataDir: dir, env: {}, enabled: true });
    assert.equal(result.enabled, true);
    assert.equal(result.applied, true);
    assert.equal(result.state, "v29");
    assert.equal(store.schemaVersion, 29);
    assert.equal(typeOf(store.connection, "dx_tasks"), "view");
    assert.deepEqual(store.connection.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(store.connection.prepare("PRAGMA table_info(tasks)").all().length, 50);
    for (const table of TASKS_CHILD_TABLES) assert.equal(count(store.connection, table), beforeChildren[table], table + " 行数守恒");
    const backup = store.migrationBackups.find((item) => item.version === 29);
    assert.ok(backup && fs.existsSync(backup.path), "必须生成 VACUUM INTO 备份");
    assert.equal(backup.path.startsWith(backupDir), true);

    // 备份文件本身仍是完整 v28
    const restored = new IdentityStore({ path: backup.path, backupDir: path.join(dir, "backup-restore") }).open();
    try {
      assert.equal(restored.schemaVersion, 28);
      assert.equal(typeOf(restored.connection, "dx_tasks"), "table");
      assert.deepEqual(restored.connection.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { restored.close(); }
  } finally { store.close(); }

  // 重启：已合并库允许打开（#migrate 对 v29 的显式合并例外），再次执行幂等。
  const reopened = new IdentityStore({ path: copy, backupDir, allowMergedV29: true }).open();
  try {
    assert.equal(reopened.schemaVersion, 29);
    assert.equal(merge.isTaskMergeApplied(reopened.connection), true);
    const again = merge.applyTaskMergeAtStartup({ store: reopened, userDataDir: dir, env: {}, enabled: true });
    assert.equal(again.applied, false);
    assert.equal(again.reason, "already-merged");
  } finally { reopened.close(); }
});

test("③ 开关关闭：真库副本一个字节不动；失败回滚保留 v28 + 备份", () => {
  const dir = freshDir();
  const source = createSeededV28(dir);
  const copy = path.join(dir, "copy.db");
  fs.copyFileSync(source, copy);
  const store = new IdentityStore({ path: copy, backupDir: path.join(dir, "backup") }).open();
  try {
    const off = merge.applyTaskMergeAtStartup({ store, userDataDir: dir, env: {} });
    assert.equal(off.enabled, false);
    assert.equal(off.applied, false);
    assert.equal(store.schemaVersion, 28);
    assert.equal(typeOf(store.connection, "dx_tasks"), "table");
    assert.equal(store.migrationBackups.length, 0, "关闭时不得备份 / 写库");
  } finally { store.close(); }
});

test("③ 失败回滚：主键冲突 → 不进入 DDL，v28 与全部行保持原样，备份仍在", () => {
  const dir = freshDir();
  const source = createSeededV28(dir);
  const copy = path.join(dir, "copy.db");
  fs.copyFileSync(source, copy);
  const store = new IdentityStore({ path: copy, backupDir: path.join(dir, "backup") }).open();
  try {
    const now = 1_700_000_000_000;
    store.connection.prepare("INSERT INTO dx_tasks(id,project_id,thread_id,title,instruction,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run("core_t1", "p", "t", "冲突", "冲突", "running", now, now);
    const before = Object.fromEntries(["tasks", "task_steps", "task_events", ...TASKS_CHILD_TABLES].map((table) => [table, count(store.connection, table)]));
    const result = merge.applyTaskMergeAtStartup({ store, userDataDir: dir, env: {}, enabled: true });
    assert.equal(result.enabled, true);
    assert.equal(result.applied, false);
    assert.equal(result.state, "v28");
    assert.equal(result.rolledBack, true);
    assert.match(result.error.message, /冲突/);
    assert.equal(store.schemaVersion, 28);
    assert.equal(typeOf(store.connection, "dx_tasks"), "table");
    assert.equal(store.connection.prepare("SELECT type FROM sqlite_master WHERE name = 'tasks_v29'").get(), undefined, "失败不得留下半成品表");
    for (const [table, beforeCount] of Object.entries(before)) assert.equal(count(store.connection, table), beforeCount, table);
    assert.equal(store.migrationBackups.length, 1, "BEGIN 前已备份");
  } finally { store.close(); }
});

test("④ 启动路径：createIdentityService 按开关执行/不执行 v29，失败不阻断启动", () => {
  const enabledDir = freshDir();
  createSeededV28(enabledDir);
  const enabled = createIdentityService({ userDataDir: enabledDir, taskMergeV29: true });
  try {
    assert.equal(enabled.taskMergeV29.applied, true);
    assert.equal(enabled.store.schemaVersion, 29);
    assert.equal(typeOf(enabled.store.connection, "dx_tasks"), "view");
  } finally { enabled.store.close(); }

  const disabledDir = freshDir();
  createSeededV28(disabledDir);
  const disabled = createIdentityService({ userDataDir: disabledDir, taskMergeV29: false });
  try {
    assert.equal(disabled.taskMergeV29.applied, false);
    assert.equal(disabled.store.schemaVersion, 28);
    assert.equal(typeOf(disabled.store.connection, "dx_tasks"), "table");
  } finally { disabled.store.close(); }
});

test("⑤ 装配契约：identity-bootstrap 调用启动执行器；identity-store 只放行已合并的 v29", () => {
  const bootstrap = fs.readFileSync(path.join(process.cwd(), "electron", "identity-bootstrap.cjs"), "utf8");
  assert.ok(bootstrap.includes("applyTaskMergeAtStartup({"));
  assert.ok(bootstrap.includes("taskMergeV29"));
  assert.ok(bootstrap.includes('backupDir: path.join(userDataDir, "dxos", "backups")'));
  const store = fs.readFileSync(path.join(process.cwd(), "electron", "identity-store.cjs"), "utf8");
  assert.ok(store.includes('name = \'dx_tasks\''));
  assert.ok(store.includes('type === "view"'));
});
