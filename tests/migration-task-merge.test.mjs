/**
 * P2 · 任务表物理合并迁移 —— 成功路径、schema 目标、幂等重放、万行级性能。
 *
 * 被测代码：electron/task-merge-migration.cjs（迁移体）+
 *          electron/identity-store.cjs:1798（#migrate）/ 1812（#applyMigration）/ 1886（applyExplicitMigration）。
 * 本文件只在**库副本**上执行迁移；任务合并不进入生产 MIGRATIONS，生产当前版本为 30。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  DX_TABLES,
  OTHER_CHILD_TABLES,
  TASKS_CHILD_TABLES,
  createSeededV28,
  makeTempDir,
  seedBulkCore,
  seedStandard,
  snapshotV28,
  tableCounts,
} from "./task-merge-fixtures.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { IdentityStore, SCHEMA_VERSION, SchemaTooNewError } = require("../electron/identity-store.cjs");
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

/** 标准夹具：v28 真库 → 复制一份副本 → 在副本上显式迁移。 */
function migrateCopy(dir) {
  const source = createSeededV28(dir);
  const copy = path.join(dir, "copy.db");
  fs.copyFileSync(source, copy);
  const backupDir = path.join(dir, "backup");
  const store = new IdentityStore({ path: copy, backupDir }).open();
  const result = store.applyExplicitMigration(merge.taskMergeMigration);
  return { source, copy, backupDir, store, result };
}

const count = (db, table) => db.prepare("SELECT COUNT(*) AS c FROM " + table).get().c;

test("合并迁移：tasks 50 列 / task_steps 22 列 / task_events 11 列，dx_ 入口变只读视图", () => {
  const dir = freshDir();
  const { store, result } = migrateCopy(dir);
  try {
    assert.deepEqual(result, { applied: true, counts: { tasks: 50, task_steps: 22, task_events: 11 } });
    const db = store.connection;
    assert.equal(db.prepare("PRAGMA table_info(tasks)").all().length, 50);
    assert.equal(db.prepare("PRAGMA table_info(task_steps)").all().length, 22);
    assert.equal(db.prepare("PRAGMA table_info(task_events)").all().length, 11);

    // 目标列名（不是只数个数）
    const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
    for (const col of ["task_id", "user_id", "app_id", "goal", "record_source", "project_id", "instruction", "attempt_no"]) {
      assert.ok(taskCols.includes(col), "tasks 缺少列 " + col);
    }
    const eventCols = db.prepare("PRAGMA table_info(task_events)").all().map((c) => c.name);
    assert.deepEqual(eventCols, [
      "id", "event_id", "task_id", "sequence", "event_type", "type", "message", "safe_payload", "data_json", "created_at", "record_source",
    ]);

    // dx_ 入口全部是只读视图
    for (const view of DX_TABLES) {
      assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(view).type, "view", view + " 必须是视图");
    }

    // 外键自检为空
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    // task_steps / task_events 的 FK 仍指向 tasks 且 ON DELETE CASCADE
    for (const table of ["task_steps", "task_events"]) {
      const fks = db.prepare("PRAGMA foreign_key_list(" + table + ")").all();
      assert.equal(fks.length, 1, table + " 应恰有 1 个外键");
      assert.equal(fks[0].table, "tasks");
      assert.equal(fks[0].from, "task_id");
      assert.equal(fks[0].to, "task_id");
      assert.equal(fks[0].on_delete, "CASCADE");
    }

    // 9 张子表仍全部 FK 指向 tasks(task_id)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type=?").all("table").map((r) => r.name);
    const referencing = new Set();
    for (const table of tables) {
      for (const fk of db.prepare("PRAGMA foreign_key_list(" + JSON.stringify(table) + ")").all()) {
        if (fk.table === "tasks") referencing.add(table);
      }
    }
    assert.deepEqual([...referencing].sort(), [...TASKS_CHILD_TABLES].sort());

    // 索引名齐全（core 原名 + dx 原名 + 判别列索引）
    const indexNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name));
    for (const name of [
      "idx_tasks_user_status", "idx_tasks_app",
      "dx_idx_tasks_queue", "dx_idx_tasks_project", "dx_idx_tasks_creator",
      "dx_idx_tasks_legacy_source", "dx_idx_tasks_parent", "dx_idx_tasks_root_status",
      "idx_tasks_record_source",
      "idx_task_steps_task_seq", "idx_task_steps_task_ordinal",
      "idx_task_events_task_seq", "idx_task_events_task_id",
    ]) {
      assert.ok(indexNames.has(name), "缺少索引 " + name);
    }
  } finally {
    store.close();
  }
});

test("合并迁移：行数守恒，core 与 dx 两套状态值都能读", () => {
  const dir = freshDir();
  const { store } = migrateCopy(dir);
  try {
    const db = store.connection;
    assert.equal(count(db, "tasks"), 2, "1 core + 1 dx");
    assert.equal(count(db, "task_steps"), 2);
    assert.equal(count(db, "task_events"), 3, "1 core + 2 dx");
    for (const table of OTHER_CHILD_TABLES) assert.equal(count(db, table), 1, table + " 行数应守恒");

    const core = db.prepare("SELECT * FROM tasks WHERE task_id=?").get("core_t1");
    assert.equal(core.record_source, "core");
    assert.equal(core.status, "RUNNING");
    assert.equal(core.goal, "core 目标");
    assert.equal(core.user_id, "usr_core");

    const dxRow = db.prepare("SELECT * FROM tasks WHERE task_id=?").get("dx_t1");
    assert.equal(dxRow.record_source, "dx");
    assert.equal(dxRow.status, "running");
    assert.equal(dxRow.title, "DX 标题");
    assert.equal(dxRow.instruction, "DX 指令");

    // 旧读路径经只读视图拿到的仍是 DX 列集与 DX 值
    // （node:sqlite 返回 null 原型行，统一转成普通对象再深比较）
    const plain = (rows) => rows.map((row) => ({ ...row }));
    assert.deepEqual(plain(db.prepare("SELECT id,title,status FROM dx_tasks").all()), [
      { id: "dx_t1", title: "DX 标题", status: "running" },
    ]);
    assert.equal(count(db, "dx_task_events"), 2);
    assert.deepEqual(plain(db.prepare("SELECT id,task_id,type,sequence FROM dx_task_events ORDER BY id").all()), [
      { id: 1, task_id: "dx_t1", type: "task.started", sequence: 1 },
      { id: 2, task_id: "dx_t1", type: "task.step", sequence: 2 },
    ]);

    // DX→core 身份桥按值引用 dx id、不参与合并，必须原样保留
    assert.deepEqual(plain(db.prepare("SELECT * FROM dx_task_approval_bridge").all()), [
      {
        dx_task_id: "dx_t1",
        dx_step_id: "dx_s1",
        dx_run_id: "dx_run_1",
        core_task_id: "core_t1",
        core_step_id: "core_s1",
        core_run_id: "core_run_1",
        created_at: 1700000000000,
        updated_at: 1700000000000,
      },
    ]);

    // 分源 CHECK：core 行不得写 DX 状态，dx 行不得写 core 状态
    assert.throws(() => db.prepare("UPDATE tasks SET status='queued' WHERE task_id='core_t1'").run(), /CHECK constraint failed/);
    assert.throws(() => db.prepare("UPDATE tasks SET status='RUNNING' WHERE task_id='dx_t1'").run(), /CHECK constraint failed/);
    // 各侧合法值仍可写
    db.prepare("UPDATE tasks SET status='WAITING' WHERE task_id='core_t1'").run();
    db.prepare("UPDATE tasks SET status='completed' WHERE task_id='dx_t1'").run();
    assert.equal(db.prepare("SELECT status FROM tasks WHERE task_id='core_t1'").get().status, "WAITING");
    assert.equal(db.prepare("SELECT status FROM tasks WHERE task_id='dx_t1'").get().status, "completed");

    // sqlite_sequence：先搬 dx 显式 id 1/2，core 事件随后自然续到 3；新事件从 4 续号
    assert.deepEqual(plain(db.prepare("SELECT name,seq FROM sqlite_sequence WHERE name='task_events'").all()), [
      { name: "task_events", seq: 3 },
    ]);
    const inserted = db
      .prepare("INSERT INTO task_events(task_id,sequence,type,message,created_at,record_source) VALUES (?,?,?,?,?,?)")
      .run("dx_t1", 3, "task.note", "新事件", 1, "dx");
    assert.equal(Number(inserted.lastInsertRowid), 4);
  } finally {
    store.close();
  }
});

test("合并迁移：user_version 28 → 29；降回 28 后重放是空跑，数据不重复不丢失", () => {
  const dir = freshDir();
  const { store } = migrateCopy(dir);
  try {
    const db = store.connection;
    assert.equal(store.schemaVersion, 29);
    const before = {
      tasks: count(db, "tasks"),
      task_steps: count(db, "task_steps"),
      task_events: count(db, "task_events"),
    };

    // 重放守卫：user_version 人为降回 27，但 schema 已是合并形态 → 空跑
    db.exec("PRAGMA user_version = 28");
    const replay = store.applyExplicitMigration(merge.taskMergeMigration);
    assert.deepEqual(replay, { applied: false, reason: "already-merged" });
    assert.equal(store.schemaVersion, 29);
    assert.deepEqual(
      { tasks: count(db, "tasks"), task_steps: count(db, "task_steps"), task_events: count(db, "task_events") },
      before,
      "重放不得重复搬行或丢行",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
  }
});

test("合并迁移：默认不启用、不改 SCHEMA_VERSION；迁移后的副本被生产 open() 以 SCHEMA_TOO_NEW 拒开", () => {
  assert.equal(SCHEMA_VERSION, 30, "生产 SCHEMA_VERSION 为 30；v29 仍只属于显式任务合并");
  const dir = freshDir();
  const { copy, store } = migrateCopy(dir);
  store.close();

  const tooNew = new IdentityStore({ path: copy });
  try {
    assert.throws(
      () => tooNew.open(),
      (error) => {
        assert.ok(error instanceof SchemaTooNewError);
        assert.equal(error.code, "SCHEMA_TOO_NEW");
        assert.equal(error.found, 29);
        assert.equal(error.supported, 30);
        return true;
      },
    );
  } finally {
    tooNew.close();
  }
});

test("合并迁移：万行级数据成功、外键自检为空（记录耗时）", () => {
  const N = 10000;
  const dir = freshDir();
  const dbPath = path.join(dir, "identity.db");
  const builder = new IdentityStore({ path: dbPath }).open();
  seedStandard(builder.connection);
  seedBulkCore(builder.connection, N);
  const before = tableCounts(dbPath, ["tasks", "task_steps", "task_events"]);
  builder.close();

  const copy = path.join(dir, "copy.db");
  fs.copyFileSync(dbPath, copy);

  const startedAt = Date.now();
  const store = new IdentityStore({ path: copy, backupDir: path.join(dir, "backup") }).open();
  const result = store.applyExplicitMigration(merge.taskMergeMigration);
  const elapsedMs = Date.now() - startedAt;
  try {
    assert.equal(result.applied, true);
    const db = store.connection;
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(count(db, "tasks"), before.tasks + 1, "core 存量 + 1 条 dx");
    assert.equal(count(db, "task_steps"), before.task_steps + 1);
    assert.equal(count(db, "task_events"), before.task_events + 2);
    for (const table of OTHER_CHILD_TABLES) assert.equal(count(db, table), 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE record_source='core'").get().c, before.tasks);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE record_source='dx'").get().c, 1);
    // 记录耗时供报告引用（不设机器相关的硬上限）
    console.log(
      "[task-merge perf] core " + before.tasks + " tasks / " + before.task_steps + " steps / " + before.task_events +
        " events + dx 1/1/2, 含 VACUUM INTO 备份：迁移耗时 " + elapsedMs + "ms",
    );
  } finally {
    store.close();
  }
});
