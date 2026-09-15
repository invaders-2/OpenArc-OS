/**
 * D3-02 · migration.test
 * D3-01 v1 → D3-02 v2：完整性、回滚、幂等、不破坏既有 Identity 数据（§53 §54 §55）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { tempDbPath } from "./authorization-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_SQL, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const passwords = require("../electron/password.cjs");
const { DatabaseSync } = require("node:sqlite");

const ADMIN_ID = "admin@openarc.test";
const ADMIN_PW = "admin-password-1";

const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** 造一个真实的 v1 身份库（含一个已初始化的 admin，可 login）。 */
async function seedV1(dbPath) {
  const verifier = await passwords.createVerifier(ADMIN_PW);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA user_version = 1");
  const now = 1700000000000;
  const instId = "inst_mig000000000000000001";
  db.prepare("INSERT INTO installations (singleton,id,status,created_at,initialized_at) VALUES (1,?, 'READY', ?, ?)").run(instId, now, now);
  const teamId = "team_mig000000000000000001";
  db.prepare("INSERT INTO teams (id,name,root,created_at) VALUES (?, 'Primary', 1, ?)").run(teamId, now);
  const userId = "usr_mig000000000000000001";
  db.prepare(
    "INSERT INTO users (id,installation_id,team_id,identifier,display_name,role,status,auth_version,password_algo,password_params,password_salt,password_hash,password_version,created_at,updated_at) VALUES (?,?,?,?, 'Legacy Admin','ADMIN','ACTIVE',1,?,?,?,?,1,?,?)",
  ).run(userId, instId, teamId, ADMIN_ID, verifier.algo, JSON.stringify(verifier.params), verifier.salt, passwords.encodeVerifier(verifier), now, now);
  db.close();
  return { instId, teamId, userId };
}

test("schema 版本已推进到 v10（D4-02C 在 v9 之上追加 HarnessRun / Artifact / Verification）", () => {
  assert.equal(SCHEMA_VERSION, 13);
});

test("全新数据库直接建到 v8，identity login 成立", async () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const store = new IdentityStore({ path: dbPath }).open();
    assert.equal(store.schemaVersion, SCHEMA_VERSION);
    assert.ok(hasTable(store.connection, "departments"));
    assert.ok(hasTable(store.connection, "resource_registry"));
    assert.ok(hasTable(store.connection, "app_resource_grants"));
    assert.ok(hasTable(store.connection, "authorization_audit"));
    assert.ok(hasTable(store.connection, "devices"));
    assert.ok(hasTable(store.connection, "device_pairing_credentials"));
    assert.ok(hasTable(store.connection, "device_credentials"));
    assert.ok(hasTable(store.connection, "device_access"));
    assert.ok(hasTable(store.connection, "device_audit"));
    assert.ok(hasTable(store.connection, "library_resources"));
    assert.ok(hasTable(store.connection, "content_objects"));
    assert.ok(hasTable(store.connection, "resource_versions"));
    assert.ok(hasTable(store.connection, "resource_import_jobs"));
    assert.ok(hasTable(store.connection, "tags"));
    assert.ok(hasTable(store.connection, "resource_tags"));
    assert.ok(hasTable(store.connection, "resource_favorites"));
    assert.ok(hasTable(store.connection, "resource_recent"));
    for (const t of ["resource_search_docs", "resource_search_fts", "resource_index_jobs", "resource_preview_cache"]) {
      assert.ok(hasTable(store.connection, t), "缺少 v6 表 " + t);
    }
    for (const t of ["projects", "project_members", "project_resources", "canvas_boards", "canvas_resource_nodes"]) {
      assert.ok(hasTable(store.connection, t), "缺少 v7 表 " + t);
    }
    for (const t of ["model_providers", "model_configs", "model_defaults", "model_credentials", "model_call_records"]) {
      assert.ok(hasTable(store.connection, t), "缺少 v8 表 " + t);
    }
    for (const t of ["tasks", "task_steps", "task_model_calls", "task_events"]) {
      assert.ok(hasTable(store.connection, t), "缺少 v9 表 " + t);
    }
    const init = await store.initialize({ identifier: ADMIN_ID, password: ADMIN_PW, displayName: "Admin" });
    assert.equal(init.ok, true);
    const login = await store.login({ identifier: ADMIN_ID, password: ADMIN_PW });
    assert.equal(login.ok, true);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v1 → v3：迁移后 login / lock / unlock 全部成立，身份数据不损", async () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const seeded = await seedV1(dbPath);
    const store = new IdentityStore({ path: dbPath }).open();
    assert.equal(store.schemaVersion, SCHEMA_VERSION);
    assert.equal(store.userById(seeded.userId).identifier, ADMIN_ID);
    assert.ok(hasTable(store.connection, "departments"));
    assert.ok(hasTable(store.connection, "devices"), "v3 表必须一并建立");
    const login = await store.login({ identifier: ADMIN_ID, password: ADMIN_PW });
    assert.equal(login.ok, true);
    const validate = store.validateSession(login.session.ref, { sensitive: true });
    assert.equal(validate.ok, true);
    assert.equal(store.lock(login.session.ref).ok, true);
    const locked = store.validateSession(login.session.ref, { sensitive: true });
    assert.equal(locked.error, "LOCKED");
    const unlocked = await store.unlock(login.session.ref, ADMIN_PW);
    assert.equal(unlocked.ok, true);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移失败 → 整级回滚：user_version 保持 1，v2/v3 表不存在，v1 数据完整", async () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const seeded = await seedV1(dbPath);
    const failing = new IdentityStore({ path: dbPath, hooks: { onMigration: (v) => { if (v === 2) throw new Error("boom-migration"); } } });
    assert.throws(() => failing.open(), /boom-migration/);
    failing.close();

    const raw = new DatabaseSync(dbPath);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(hasTable(raw, "departments"), false);
    assert.equal(hasTable(raw, "resource_registry"), false);
    assert.equal(hasTable(raw, "devices"), false);
    assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM users").get().c, 1);
    assert.equal(raw.prepare("SELECT identifier FROM users WHERE id = ?").get(seeded.userId).identifier, ADMIN_ID);
    raw.close();

    // 修复后可以正常迁移，之前的数据仍在
    const ok = new IdentityStore({ path: dbPath }).open();
    assert.equal(ok.schemaVersion, SCHEMA_VERSION);
    const login = await ok.login({ identifier: ADMIN_ID, password: ADMIN_PW });
    assert.equal(login.ok, true);
    ok.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("重复 open 幂等，不会重复迁移或丢数据", async () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const a = new IdentityStore({ path: dbPath }).open();
    await a.initialize({ identifier: ADMIN_ID, password: ADMIN_PW, displayName: "Admin" });
    a.close();
    const b = new IdentityStore({ path: dbPath }).open();
    assert.equal(b.schemaVersion, SCHEMA_VERSION);
    assert.equal(b.userCount(), 1);
    b.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("v3 级迁移失败 → user_version 停在 2，设备表不残留（§55 强化）", async () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const store = new IdentityStore({ path: dbPath }).open();
    await store.initialize({ identifier: ADMIN_ID, password: ADMIN_PW, displayName: "Admin" });
    store.close();
    // 手工降回 v2 并删掉 v3 + v4 + v5 + v6 表，模拟"已有 v2 库、正要升 v3"
    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE resource_search_fts; DROP TABLE resource_search_docs; DROP TABLE resource_index_jobs; DROP TABLE resource_preview_cache;");
    raw.exec("DROP TABLE project_members; DROP TABLE project_resources; DROP TABLE projects; DROP TABLE canvas_resource_nodes; DROP TABLE canvas_boards;");
    raw.exec("DROP TABLE model_call_records; DROP TABLE model_credentials; DROP TABLE model_defaults; DROP TABLE model_configs; DROP TABLE model_providers;");
    raw.exec("DROP TABLE task_events; DROP TABLE task_model_calls; DROP TABLE task_steps; DROP TABLE tasks;");
    raw.exec("DROP TABLE task_verifications; DROP TABLE task_artifacts; DROP TABLE task_harness_runs;");
    raw.exec("DROP TABLE tool_decisions; DROP TABLE task_tool_proposals;");
    raw.exec("DROP TABLE tool_executions;");
    raw.exec("DROP TABLE side_effect_leases; DROP TABLE tool_approvals; DROP TABLE side_effect_calls;");
    raw.exec("DROP TABLE resource_recent; DROP TABLE resource_favorites; DROP TABLE resource_tags; DROP TABLE tags;");
    raw.exec("ALTER TABLE library_resources DROP COLUMN memory_subtype; ALTER TABLE library_resources DROP COLUMN language; ALTER TABLE library_resources DROP COLUMN attributes;");
    raw.exec("DROP TABLE resource_relations; DROP TABLE resource_versions; DROP TABLE library_resources; DROP TABLE resource_import_jobs; DROP TABLE content_objects;");
    raw.exec("DROP TABLE device_audit; DROP TABLE device_access; DROP TABLE device_credentials; DROP TABLE device_pairing_credentials; DROP TABLE devices;");
    raw.exec("PRAGMA user_version = 2");
    raw.close();

    const failing = new IdentityStore({ path: dbPath, hooks: { onMigration: (v) => { if (v === 3) throw new Error("boom-v3"); } } });
    assert.throws(() => failing.open(), /boom-v3/);
    failing.close();

    const check = new DatabaseSync(dbPath);
    assert.equal(check.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(hasTable(check, "devices"), false);
    assert.equal(hasTable(check, "device_audit"), false);
    assert.equal(hasTable(check, "content_objects"), false);
    assert.equal(hasTable(check, "tags"), false);
    assert.ok(check.prepare("SELECT identifier FROM users LIMIT 1").get());
    check.close();

    const recovered = new IdentityStore({ path: dbPath }).open();
    assert.equal(recovered.schemaVersion, SCHEMA_VERSION);
    assert.ok(hasTable(recovered.connection, "devices"));
    recovered.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
