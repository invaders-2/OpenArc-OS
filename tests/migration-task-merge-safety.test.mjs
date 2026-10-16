/**
 * P2 · 任务表物理合并迁移 —— 失败回滚、备份恢复、反例护栏（CASCADE / 事务内关 FK 无效）。
 *
 * 被测代码：electron/identity-store.cjs:1812（#applyMigration）、1855（#backupBeforeMigration）、
 *          1886（applyExplicitMigration）；迁移体 electron/task-merge-migration.cjs。
 * 反例两个用例是**回归护栏**：复现方案 §7.2 的实测现象，
 * 用来证明"执行器必须在 BEGIN 之前关 FK"不是可选项（不是可选优化）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  TASKS_CHILD_TABLES,
  createSeededV26,
  makeTempDir,
  seedStandard,
  snapshotV26,
} from "./task-merge-fixtures.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { IdentityStore } = require("../electron/identity-store.cjs");
const merge = require("../electron/task-merge-migration.cjs");

const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function freshDir() {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}

function seededCopy(dir) {
  const source = createSeededV26(dir);
  const copy = path.join(dir, "copy.db");
  fs.copyFileSync(source, copy);
  return { source, copy };
}

const count = (db, table) => db.prepare("SELECT COUNT(*) AS c FROM " + table).get().c;

test("反例护栏：FK=ON 时 DROP TABLE tasks 会按 CASCADE 清空全部 9 张子表", () => {
  const dir = freshDir();
  const dbPath = createSeededV26(dir);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const before = {};
    for (const table of TASKS_CHILD_TABLES) {
      before[table] = count(db, table);
      assert.ok(before[table] > 0, table + " 播种后应有行");
    }

    db.exec("DROP TABLE tasks"); // FK=ON，SQLite 会按 ON DELETE CASCADE 静默删子行

    for (const table of TASKS_CHILD_TABLES) {
      assert.equal(count(db, table), 0, table + " 被 CASCADE 清空（这正是必须关 FK 的原因）");
    }
  } finally {
    db.close();
  }
});

test("反例护栏：事务内 PRAGMA foreign_keys=OFF 是 no-op；只有 BEGIN 之前关才有效", () => {
  const dir = freshDir();
  const dbPath = createSeededV26(dir);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON");

    // 正例：BEGIN 之前关，值真的变 0
    db.exec("PRAGMA foreign_keys = OFF");
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 0);
    db.exec("PRAGMA foreign_keys = ON");

    // 反例：事务内关，值仍是 1
    db.exec("BEGIN IMMEDIATE");
    db.exec("PRAGMA foreign_keys = OFF");
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1, "事务内 PRAGMA foreign_keys 不得变 0");
    db.exec("ROLLBACK");
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  } finally {
    db.close();
  }
});

test("失败回滚：迁移体抛错 → user_version 停在 26、dx_tasks 仍是表、9 张子表行数不变、FK 恢复为 ON", () => {
  const dir = freshDir();
  const { copy } = seededCopy(dir);
  const backupDir = path.join(dir, "backup");
  const pre = snapshotV26(copy);

  const store = new IdentityStore({
    path: copy,
    backupDir,
    hooks: {
      onMigration: (version) => {
        if (version === 27) throw new Error("boom-v27");
      },
    },
  }).open();
  try {
    assert.throws(() => store.applyExplicitMigration(merge.taskMergeMigration), /boom-v27/);
    const db = store.connection;
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 26);
    assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name='dx_tasks'").get().type, "table");
    assert.equal(db.prepare("PRAGMA table_info(tasks)").all().length, 17);
    assert.equal(db.prepare("PRAGMA table_info(task_steps)").all().length, 11);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1, "失败后必须恢复 FK=ON");
    // DDL 半成品必须随事务一起消失
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name IN ('tasks_v27','task_steps_v27','task_events_v27')").get().c, 0);
    // 备份在事务前已落盘，可独立打开且与迁移前一致
    assert.equal(store.migrationBackups.length, 1);
    const backupPath = store.migrationBackups[0].path;
    assert.ok(fs.existsSync(backupPath), "backupBefore 必须产出备份文件");
    assert.deepEqual(snapshotV26(backupPath), pre);
  } finally {
    store.close();
  }
  assert.deepEqual(snapshotV26(copy), pre, "回滚后库文件必须回到迁移前的形态");
});

test("备份恢复：真的用备份覆盖回滚，数据与迁移前逐表一致，且能再次成功迁移", () => {
  const dir = freshDir();
  const { copy } = seededCopy(dir);
  const backupDir = path.join(dir, "backup");
  const pre = snapshotV26(copy);

  const store = new IdentityStore({
    path: copy,
    backupDir,
    hooks: {
      onMigration: (version) => {
        if (version === 27) throw new Error("boom-v27");
      },
    },
  }).open();
  assert.throws(() => store.applyExplicitMigration(merge.taskMergeMigration), /boom-v27/);
  const backupPath = store.migrationBackups[0].path;
  store.close();

  // 恢复：覆盖主库前必须清掉 WAL/SHM，否则陈旧 WAL 会覆盖恢复内容
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(copy + suffix, { force: true });
  fs.copyFileSync(backupPath, copy);
  assert.deepEqual(snapshotV26(copy), pre, "备份恢复后的库必须与迁移前一致");

  const restored = new IdentityStore({ path: copy, backupDir }).open();
  try {
    assert.equal(restored.schemaVersion, 26, "恢复出的仍是 v26");
    assert.equal(restored.connection.prepare("SELECT COUNT(*) AS c FROM tasks").get().c, pre.counts.tasks);
    assert.equal(restored.connection.prepare("SELECT COUNT(*) AS c FROM dx_tasks").get().c, pre.counts.dx_tasks);
    const result = restored.applyExplicitMigration(merge.taskMergeMigration);
    assert.equal(result.applied, true, "恢复后的库可以再次成功迁移");
    assert.deepEqual(restored.connection.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    restored.close();
  }
});

test("冲突预检：core 与 dx 同名 task/step id fail closed，库保持 v26", () => {
  const dir = freshDir();
  const dbPath = path.join(dir, "identity.db");
  const builder = new IdentityStore({ path: dbPath }).open();
  seedStandard(builder.connection);
  builder.connection
    .prepare("INSERT INTO tasks (task_id,user_id,app_id,status,goal,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("dup_1", "u", "ai", "PENDING", "g", 1, 1);
  builder.connection
    .prepare("INSERT INTO dx_tasks (id,project_id,thread_id,title,instruction,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("dup_1", "p", "t", "T", "I", "queued", 1, 1);
  builder.connection
    .prepare("INSERT INTO task_steps (step_id,task_id,sequence,kind,status) VALUES (?,?,?,?,?)")
    .run("dup_s1", "core_t1", 2, "model", "PENDING");
  builder.connection
    .prepare("INSERT INTO dx_task_steps (id,task_id,ordinal,title,tool_name,input_json,status,operation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("dup_s1", "dx_t1", 2, "t", "tool", "{}", "queued", "op_dup", 1);
  const conflicts = merge.findTaskMergeConflicts(builder.connection);
  assert.deepEqual(conflicts, { tasks: ["dup_1"], steps: ["dup_s1"] });
  builder.close();

  const copy = path.join(dir, "copy.db");
  fs.copyFileSync(dbPath, copy);
  const store = new IdentityStore({ path: copy, backupDir: path.join(dir, "backup") }).open();
  try {
    assert.throws(
      () => store.applyExplicitMigration(merge.taskMergeMigration),
      (error) => {
        assert.match(error.message, /预检未通过/);
        assert.match(error.message, /tasks 主键冲突 1 条：dup_1/);
        assert.match(error.message, /task_steps 主键冲突 1 条：dup_s1/);
        return true;
      },
    );
    const db = store.connection;
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 26);
    assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name='dx_tasks'").get().type, "table");
    assert.equal(db.prepare("PRAGMA table_info(tasks)").all().length, 17);
  } finally {
    store.close();
  }
});

test("执行器自检：事务内 foreign_key_check 非空 → 整体回滚，临时表与 user_version 都不留", () => {
  const dir = freshDir();
  const { copy } = seededCopy(dir);
  const store = new IdentityStore({ path: copy }).open();
  try {
    const probe = {
      version: 99,
      foreignKeysOff: true,
      foreignKeyCheck: true,
      run(db) {
        // FK 已被执行器在 BEGIN 前关掉，所以这条"悬挂引用"能插进去；
        // 事务内的 foreign_key_check 必须在 COMMIT 前抓住它。
        db.exec("CREATE TABLE fk_probe (child_id TEXT REFERENCES tasks(task_id))");
        db.exec("INSERT INTO fk_probe (child_id) VALUES ('no-such-task')");
        return { probed: true };
      },
    };
    assert.throws(() => store.applyExplicitMigration(probe), /外键自检未通过/);
    const db = store.connection;
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='fk_probe'").get().c, 0);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 26);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  } finally {
    store.close();
  }
});
