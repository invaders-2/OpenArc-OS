/**
 * 0.6.1 表结构补齐（v27）与模型明文放行列（v28）回归测试。
 *
 * 证明四件事：
 *   ① 6 张 0.6.1 表（+ user_app_install_state 的 1 个折叠列）确实进入
 *      DXOS_TABLES / DXOS_CREATED_TABLES / DXOS_DDL；
 *   ② dxosDdl() 幂等，列集/索引/外键与 DX 源最终形态一致，且没有指向 OpenArc 既有 5 表的外键；
 *   ③ v26 老库升 v28 补 6 表 + 1 列 + allow_insecure_http，既有数据保留，重放幂等；
 *   ④ DDL 是从源文件机械抽取的（只读源存在时逐字比对，不靠人眼）。
 *
 * 明确排除：api_quota_rules_v2（apiQuota.ts:76-:80）—— 计费配额 v2，属云/计费域，不入移植侧。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const schema = require("../electron/dxos-foundation-schema.cjs");
const { IdentityStore, SCHEMA_VERSION, MIGRATIONS, SchemaTooNewError } = require("../electron/identity-store.cjs");

const NEW_TABLES = Object.freeze([
  "ai_protocol_artifacts",
  "photo_source_visual_features",
  "photo_source_related_rankings",
  "photocraft_projects",
  "photocraft_project_members",
  "app_exchanges",
]);
const NEW_INDEXES = Object.freeze([
  "idx_ai_protocol_artifacts_task",
  "idx_photocraft_projects_owner",
  "idx_photocraft_projects_group",
  "idx_photocraft_project_members_user",
  "idx_app_exchanges_user",
]);
const OPENARC_TABLES = Object.freeze(["tasks", "task_steps", "task_events", "projects", "project_members"]);

/** 只读 DX OS 0.6.1 源；可用 DXOS_SRC 覆盖。源不存在时机械抽取比对整组跳过。 */
const DX_SRC =
  process.env.DXOS_SRC ||
  "/Users/wepingli/Downloads/DXOS-Portable-0.5.1-mac-arm64/.dx-runtime/versions/runtime-0.6.1-c2699917-1363-460d-97c3-da88f6d3fbe5/DX OS.app/Contents/Resources/app.asar.unpacked";
const CCS_DB = path.join(DX_SRC, "server", "ccsDb.ts");
const ARTIFACTS_TS = path.join(DX_SRC, "server", "ai-tasks", "artifacts.ts");

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-dxos-061-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => String(row.name));
}
function indexNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all().map((row) => String(row.name));
}
function columnNames(db, table) {
  return db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => String(row.name));
}
function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function newInMemoryDb() {
  const db = new DatabaseSync(":memory:");
  for (const statement of schema.dxosDdl()) db.exec(statement);
  return db;
}

// ---------------------------------------------------------------------------
// 清单与 DDL
// ---------------------------------------------------------------------------

test("schema：6 张 0.6.1 表进入清单，api_quota_rules_v2 刻意不加", () => {
  assert.equal(schema.DXOS_TABLES.length, 63);
  assert.equal(schema.DXOS_CREATED_TABLES.length, 59);
  for (const table of NEW_TABLES) {
    assert.ok(schema.DXOS_TABLES.includes(table), "DXOS_TABLES 缺 " + table);
    assert.ok(schema.DXOS_CREATED_TABLES.includes(table), "DXOS_CREATED_TABLES 缺 " + table);
    assert.ok(!schema.DXOS_SKIPPED_TABLES.includes(table), table + " 不是被跳过的同名表");
  }
  assert.ok(!schema.DXOS_TABLES.includes("api_quota_rules_v2"), "计费配额表不得进入移植侧清单");
  assert.ok(!schema.DXOS_CREATED_TABLES.includes("api_quota_rules_v2"));
});

test("schema：dxosDdl() 建出 6 表 + 5 索引，重复执行幂等，列集落库", () => {
  const ddl = schema.dxosDdl();
  for (const statement of ddl) {
    assert.match(statement, /^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS)/, statement.slice(0, 80));
  }
  const db = new DatabaseSync(":memory:");
  try {
    for (const statement of ddl) db.exec(statement);
    for (const statement of ddl) db.exec(statement); // 重放
    const tables = tableNames(db);
    for (const table of NEW_TABLES) assert.ok(tables.includes(table), "缺表 " + table);
    const indexes = indexNames(db);
    for (const index of NEW_INDEXES) assert.ok(indexes.includes(index), "缺索引 " + index);
    assert.deepEqual(columnNames(db, "ai_protocol_artifacts"), ["id", "task_id", "kind", "mime", "bytes", "sha256", "source_url", "created_at"]);
    assert.deepEqual(columnNames(db, "photo_source_visual_features"), ["source_id", "updated_ts", "features_json"]);
    assert.deepEqual(columnNames(db, "photo_source_related_rankings"), ["image_id", "catalog_hash", "description_hash", "ranked_ids_json"]);
    assert.deepEqual(columnNames(db, "photocraft_projects"), ["id", "group_id", "owner_id", "title", "source_node_id", "preview_node_id", "state_path", "visibility", "created_at", "updated_at", "deleted_at"]);
    assert.deepEqual(columnNames(db, "photocraft_project_members"), ["project_id", "user_id"]);
    assert.deepEqual(columnNames(db, "app_exchanges"), ["id", "user_id", "request_id", "fingerprint", "result_json", "created_at"]);
    // 折叠列证据：dataset_maker_migrated_at 来自 v52 的 ALTER，必须出现在最终建表语句里
    assert.ok(columnNames(db, "user_app_install_state").includes("dataset_maker_migrated_at"));
  } finally {
    db.close();
  }
});

test("schema：app_exchanges 按 (user_id, request_id) 唯一（appExchange.ts:53/:69 的幂等键）", () => {
  const db = newInMemoryDb();
  try {
    const insert = "INSERT INTO app_exchanges(id,user_id,request_id,fingerprint,result_json,created_at) VALUES (?,?,?,?,?,?)";
    db.prepare(insert).run("exchange_1", "user_1", "request_1", "fp", "{}", 1);
    assert.throws(() => db.prepare(insert).run("exchange_2", "user_1", "request_1", "fp2", "{}", 2), /UNIQUE|constraint/i);
    db.prepare(insert).run("exchange_3", "user_1", "request_2", "fp", "{}", 3);
    db.prepare(insert).run("exchange_4", "user_2", "request_1", "fp", "{}", 4);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM app_exchanges").get().c, 3);
  } finally {
    db.close();
  }
});

test("schema：外键只指向 DX 自己的表，无指向 OpenArc 既有 5 表的外键", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  try {
    for (const statement of schema.dxosDdl()) db.exec(statement);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_list(ai_protocol_artifacts)").all().map((fk) => fk.table), ["ai_protocol_tasks"]);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_list(photocraft_project_members)").all().map((fk) => fk.table), ["photocraft_projects"]);
    for (const table of NEW_TABLES) {
      for (const fk of db.prepare("PRAGMA foreign_key_list(" + table + ")").all()) {
        assert.ok(!OPENARC_TABLES.includes(fk.table), table + " 不应指向 OpenArc 表 " + fk.table);
      }
    }
    // 外键真的生效：ai_protocol_tasks 里没有的任务 id 必须被拒
    assert.throws(
      () => db.prepare("INSERT INTO ai_protocol_artifacts(id,task_id,kind,mime,bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?)").run("artifact_1", "no_such_task", "image", "image/png", 1, "x", 1),
      /FOREIGN KEY|constraint/i,
    );
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

test("迁移：SCHEMA_VERSION 到 28，空库直接建到 28，6 表齐备", () => {
  assert.equal(SCHEMA_VERSION, 28);
  const dir = tempDir();
  const store = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  try {
    assert.equal(store.schemaVersion, 28);
    for (const table of NEW_TABLES) assert.ok(hasTable(store.connection, table), "缺表 " + table);
    assert.ok(columnNames(store.connection, "user_app_install_state").includes("dataset_maker_migrated_at"));
    assert.ok(columnNames(store.connection, "model_providers").includes("allow_insecure_http"), "v28 必须补上明文放行列");
  } finally {
    store.close();
  }
});

/** 造一个真正的「0.6.1 之前」v26 库：跑完 v1..v26，再删掉 v27 才会补的 6 表与 1 列。 */
function buildPre061V26Db(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    if (migration.version > 26) continue;
    if (typeof migration.run === "function") migration.run(db);
    else db.exec(migration.sql);
  }
  db.exec("PRAGMA user_version = 26");
  db.exec("DROP TABLE app_exchanges");
  db.exec("DROP TABLE photocraft_project_members");
  db.exec("DROP TABLE photocraft_projects");
  db.exec("DROP TABLE photo_source_related_rankings");
  db.exec("DROP TABLE photo_source_visual_features");
  db.exec("DROP TABLE ai_protocol_artifacts");
  db.exec("ALTER TABLE user_app_install_state DROP COLUMN dataset_maker_migrated_at");
  db.prepare("INSERT INTO teams (id,name,root,created_at) VALUES (?,?,?,?)").run("team_v26_marker", "Marker", 0, 1);
  return db;
}

test("迁移：v26 老库升到 v28 —— 补 6 表 + 1 列 + allow_insecure_http 列，既有数据保留，重放幂等", () => {
  const dir = tempDir();
  const file = path.join(dir, "identity.db");
  const raw = buildPre061V26Db(file);
  assert.equal(hasTable(raw, "app_exchanges"), false, "v26 库不得预置 0.6.1 表");
  assert.ok(!columnNames(raw, "user_app_install_state").includes("dataset_maker_migrated_at"), "v26 库不得预置折叠列");
  raw.close();

  const store = new IdentityStore({ path: file }).open();
  try {
    assert.equal(store.schemaVersion, 28);
    for (const table of NEW_TABLES) assert.ok(hasTable(store.connection, table), "缺表 " + table);
    assert.ok(columnNames(store.connection, "user_app_install_state").includes("dataset_maker_migrated_at"));
    assert.ok(columnNames(store.connection, "model_providers").includes("allow_insecure_http"), "v28 必须补上明文放行列");
    assert.equal(store.connection.prepare("SELECT COUNT(*) AS c FROM teams WHERE id='team_v26_marker'").get().c, 1, "老库数据必须保留");
    // 折叠列补上后可写
    assert.doesNotThrow(() => store.connection.prepare("INSERT INTO app_exchanges(id,user_id,request_id,fingerprint,result_json,created_at) VALUES (?,?,?,?,?,?)").run("exchange_v26", "user_1", "request_1", "fp", "{}", 1));
    // 重放：降回 26 再升，仍是 28 且表还在
    store.connection.exec("PRAGMA user_version = 26");
  } finally {
    store.close();
  }

  const again = new IdentityStore({ path: file }).open();
  try {
    assert.equal(again.schemaVersion, 28);
    assert.ok(hasTable(again.connection, "app_exchanges"));
    assert.equal(again.connection.prepare("SELECT COUNT(*) AS c FROM app_exchanges WHERE id='exchange_v26'").get().c, 1, "重放不得丢数据");
  } finally {
    again.close();
  }

  // 高版本拒开：user_version=29 > 28
  const tooNew = new DatabaseSync(file);
  tooNew.exec("PRAGMA user_version = 29");
  tooNew.close();
  assert.throws(
    () => new IdentityStore({ path: file }).open(),
    (error) => error instanceof SchemaTooNewError && error.code === "SCHEMA_TOO_NEW",
  );
});

// ---------------------------------------------------------------------------
// 机械抽取比对（只读源）
// ---------------------------------------------------------------------------

/** 从源码文本里取 CREATE TABLE <name> (...) 的整块（括号配对，去掉结尾分号）。 */
function extractTable(text, name) {
  const match = new RegExp("CREATE TABLE (?:IF NOT EXISTS )?" + name + " \\(").exec(text);
  assert.ok(match, "源里找不到建表 " + name);
  const open = text.indexOf("(", match.index);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(match.index, i + 1);
    }
  }
  throw new Error("括号不配对：" + name);
}
function extractIndex(text, name) {
  const match = new RegExp("CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?" + name + " [^;]*;").exec(text);
  assert.ok(match, "源里找不到索引 " + name);
  return match[0].replace(/;$/, "");
}
function normalize(statement) {
  return statement
    .replace(/CREATE TABLE IF NOT EXISTS /g, "CREATE TABLE ")
    .replace(/CREATE UNIQUE INDEX IF NOT EXISTS /g, "CREATE UNIQUE INDEX ")
    .replace(/CREATE INDEX IF NOT EXISTS /g, "CREATE INDEX ")
    .replace(/\s+/g, " ")
    .trim();
}

test("schema：DDL 与 0.6.1 源文件机械抽取结果逐字一致", { skip: !fs.existsSync(CCS_DB) || !fs.existsSync(ARTIFACTS_TS) }, () => {
  const ccs = fs.readFileSync(CCS_DB, "utf8");
  const artifacts = fs.readFileSync(ARTIFACTS_TS, "utf8");
  const ddl = schema.dxosDdl();
  const tableBy = new Map();
  const indexBy = new Map();
  for (const statement of ddl) {
    const table = /^CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement);
    if (table) tableBy.set(table[1], statement);
    const index = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/.exec(statement);
    if (index) indexBy.set(index[1], statement);
  }
  // 表：ai_protocol_artifacts 来自 artifacts.ts，其余来自 ccsDb.ts
  for (const table of NEW_TABLES) {
    const source = table === "ai_protocol_artifacts" ? artifacts : ccs;
    assert.equal(normalize(tableBy.get(table)), normalize(extractTable(source, table)), table + " 与源不一致");
  }
  for (const index of NEW_INDEXES) {
    const source = index === "idx_ai_protocol_artifacts_task" ? artifacts : ccs;
    assert.equal(normalize(indexBy.get(index)), normalize(extractIndex(source, index)), index + " 与源不一致");
  }
  // 折叠列来自 ccsDb.ts:1016 的 ALTER
  assert.ok(ccs.includes("ALTER TABLE user_app_install_state ADD COLUMN dataset_maker_migrated_at INTEGER;"), "源里应有 v52 的 ALTER");
  assert.ok(normalize(tableBy.get("user_app_install_state")).includes("dataset_maker_migrated_at INTEGER"), "折叠列必须进入建表语句");
  // api_quota_rules_v2 只在 apiQuota.ts，不在本层 DDL
  assert.ok(!ddl.some((statement) => statement.includes("api_quota_rules_v2")), "计费配额表不得出现在 dxosDdl()");
});
