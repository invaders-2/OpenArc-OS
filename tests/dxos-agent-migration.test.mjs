/**
 * B3a · v23（dx_tasks / dx_task_steps / dx_task_events）迁移回归测试。
 *
 * 覆盖：空库直接建到 v23；v22 老库（含既有 OpenArc tasks 数据）升级保留；
 * 跨版本重放幂等；库版本高于程序必须拒开；v23 失败整级回滚；DDL 可重放。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { IdentityStore, SchemaTooNewError, SCHEMA_VERSION, MIGRATIONS } = require("../electron/identity-store.cjs");
const schema = require("../electron/dxos-agent-schema.cjs");

const dirs = [];
function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-b3a-mig-"));
  dirs.push(dir);
  return path.join(dir, "identity.db");
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
const cols = (db, table) => db.prepare("PRAGMA table_info(" + table + ")").all().map((r) => String(r.name));

/** 造一个精确停在 upTo 版本的真实库（逐级执行迁移，run/sql 都走）。 */
function buildDb(file, upTo) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) continue;
    if (typeof migration.run === "function") migration.run(db);
    else db.exec(migration.sql);
  }
  db.exec("PRAGMA user_version = " + upTo);
  return db;
}

test("迁移：SCHEMA_VERSION 推进到 23", () => {
  assert.equal(SCHEMA_VERSION, 26);
});

test("迁移：空库直接建到 v23，dx_ 表存在，OpenArc 既有表不受影响", () => {
  const file = tempDbPath();
  const store = new IdentityStore({ path: file }).open();
  try {
    assert.equal(store.schemaVersion, 26);
    for (const table of schema.DXOS_AGENT_TABLES) assert.ok(hasTable(store.connection, table), "缺少 " + table);
    assert.ok(hasTable(store.connection, "dx_project_roots"));
    assert.ok(hasTable(store.connection, "tasks"));
    assert.ok(hasTable(store.connection, "projects"));
    // OpenArc tasks 是 v9 的原样，没有被 dx_ 列污染
    assert.ok(cols(store.connection, "tasks").includes("task_id"));
    assert.ok(!cols(store.connection, "tasks").includes("execution_profile"));
    assert.ok(!cols(store.connection, "dx_tasks").includes("task_id"), "dx_tasks 是 DX 列集，不含 OpenArc 的 task_id");
    assert.deepEqual(store.connection.prepare("PRAGMA foreign_key_list(dx_tasks)").all(), []);
  } finally {
    store.close();
  }
});

test("迁移：v22 老库升到 v23，既有 OpenArc tasks 数据与列集原样保留", () => {
  const file = tempDbPath();
  const raw = buildDb(file, 22);
  const now = 1700000000000;
  raw.prepare("INSERT INTO tasks (task_id,user_id,app_id,status,goal,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
    "task_b3a_legacy",
    "usr_b3a",
    "ai",
    "SUCCEEDED",
    "legacy-goal",
    now,
    now,
  );
  // 制造一条 DX 侧 v22 数据（threads）验证既有 DX 表也保留
  raw.prepare("INSERT INTO threads(id,project_id,title,visibility,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(
    "thr_b3a_v22",
    "proj_v22",
    "既有对话",
    "project",
    now,
    now,
  );
  raw.close();

  const store = new IdentityStore({ path: file }).open();
  try {
    assert.equal(store.schemaVersion, 26);
    const legacy = store.connection.prepare("SELECT * FROM tasks WHERE task_id=?").get("task_b3a_legacy");
    assert.equal(legacy.goal, "legacy-goal");
    assert.equal(store.connection.prepare("SELECT title FROM threads WHERE id=?").get("thr_b3a_v22").title, "既有对话");
    assert.ok(hasTable(store.connection, "dx_tasks"));
    assert.ok(hasTable(store.connection, "dx_task_steps"));
    assert.ok(hasTable(store.connection, "dx_task_events"));
    assert.equal(store.connection.prepare("SELECT COUNT(*) AS c FROM dx_tasks").get().c, 0, "迁移不伪造任务行");
  } finally {
    store.close();
  }
});

test("迁移：user_version 降回 22 / 21 再重放，dx_ 表与数据不重复不丢失", () => {
  const file = tempDbPath();
  const first = new IdentityStore({ path: file }).open();
  first.connection
    .prepare("INSERT INTO dx_tasks(id,project_id,thread_id,title,instruction,status,resume_safe,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("dx_task_replay", "proj", "thr", "t", "i", "queued", 1, 1, 1);
  first.close();

  for (const downgrade of [22, 21]) {
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA user_version = " + downgrade);
    raw.close();
    const reopened = new IdentityStore({ path: file }).open();
    try {
      assert.equal(reopened.schemaVersion, 26);
      assert.equal(reopened.connection.prepare("SELECT COUNT(*) AS c FROM dx_tasks").get().c, 1, "重放不得重复建行或丢行");
      assert.equal(reopened.connection.prepare("SELECT title FROM dx_tasks WHERE id=?").get("dx_task_replay").title, "t");
    } finally {
      reopened.close();
    }
    // 再次直接重放完整 DDL：IF NOT EXISTS 幂等
    const direct = new DatabaseSync(file);
    for (const statement of schema.dxosAgentDdl()) direct.exec(statement);
    assert.equal(direct.prepare("PRAGMA user_version").get().user_version, 26);
    direct.close();
  }
});

test("迁移：库版本高于程序（user_version=26）必须拒开", () => {
  const file = tempDbPath();
  const raw = buildDb(file, 24);
  raw.exec("PRAGMA user_version = 27");
  raw.close();
  assert.throws(
    () => new IdentityStore({ path: file }).open(),
    (error) => {
      assert.ok(error instanceof SchemaTooNewError);
      assert.equal(error.code, "SCHEMA_TOO_NEW");
      return true;
    },
  );
});

test("迁移：v23 失败时整级回滚，user_version 停在 22 且 dx_ 表不残留", () => {
  const file = tempDbPath();
  const raw = buildDb(file, 22);
  raw.close();

  const failing = new IdentityStore({ path: file, hooks: { onMigration: (version) => { if (version === 23) throw new Error("boom-v23"); } } });
  assert.throws(() => failing.open(), /boom-v23/);
  failing.close();

  const check = new DatabaseSync(file);
  assert.equal(check.prepare("PRAGMA user_version").get().user_version, 22);
  assert.equal(hasTable(check, "dx_tasks"), false);
  assert.equal(hasTable(check, "dx_task_steps"), false);
  assert.equal(hasTable(check, "dx_task_events"), false);
  assert.equal(hasTable(check, "dx_project_roots"), false);
  check.close();

  // 修复后可以正常升到 23
  const ok = new IdentityStore({ path: file }).open();
  assert.equal(ok.schemaVersion, 26);
  assert.ok(hasTable(ok.connection, "dx_tasks"));
  ok.close();
});

test("迁移：v23 只新增表，不改 OpenArc projects/project_members 列", () => {
  const file = tempDbPath();
  const store = new IdentityStore({ path: file }).open();
  try {
    const projectCols = cols(store.connection, "projects");
    assert.deepEqual(projectCols, ["id", "organization_id", "department_id", "owner_user_id", "name", "description", "status", "scope", "created_at", "updated_at"]);
    const memberCols = cols(store.connection, "project_members");
    assert.deepEqual(memberCols, ["project_id", "user_id", "role", "created_at"]);
  } finally {
    store.close();
  }
});
