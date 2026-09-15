/** D4-03C1/C3 · v12 -> v13（Side-effect Authority 表）与 v13 -> v14（recovery evidence）迁移 + 失败回滚。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createResourceFixture, reopenResourceRuntime, tempRoot } from "./resource-fixtures.mjs";
const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const { DatabaseSync } = require("node:sqlite");

const V13_TABLES = ["side_effect_calls", "tool_approvals", "side_effect_leases"];
const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
const colsOf = (db, name) => db.prepare("PRAGMA table_info(" + name + ")").all().map((c) => c.name);

async function makeV12Db() {
  const root = tempRoot("oa-d4-03c1-mig");
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const fx = await createResourceFixture({ dbPath, storeRoot });
  const snapshot = { users: fx.identity.allUsers().length };
  fx.identity.close();
  const raw = new DatabaseSync(dbPath);
  for (const t of V13_TABLES) raw.exec("DROP TABLE IF EXISTS " + t);
  raw.exec("PRAGMA user_version = 12");
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 12);
  raw.close();
  return { root, dbPath, storeRoot, snapshot };
}

/** 造一个 schema v13 的库：先迁到 current，再去掉 v14 的 recovery_safe 列并回写 user_version。 */
async function makeV13Db() {
  const root = tempRoot("oa-d4-03c3-mig");
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const fx = await createResourceFixture({ dbPath, storeRoot });
  const snapshot = { users: fx.identity.allUsers().length };
  fx.identity.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec("ALTER TABLE side_effect_calls DROP COLUMN recovery_safe");
  raw.exec("PRAGMA user_version = 13");
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 13);
  assert.ok(!colsOf(raw, "side_effect_calls").includes("recovery_safe"), "v13 不应有 recovery_safe");
  raw.close();
  return { root, dbPath, storeRoot, snapshot };
}

test("v12 -> current：side_effect_calls / tool_approvals / side_effect_leases 建立，旧数据完整", async () => {
  const { root, dbPath, storeRoot, snapshot } = await makeV12Db();
  try {
    const reopened = reopenResourceRuntime({ dbPath, storeRoot });
    assert.equal(SCHEMA_VERSION, 14);
    assert.equal(reopened.identity.schemaVersion, SCHEMA_VERSION);
    for (const t of V13_TABLES) assert.equal(hasTable(reopened.identity.connection, t), true, t + " 应存在");
    assert.ok(colsOf(reopened.identity.connection, "side_effect_calls").includes("recovery_safe"), "v14 应有 recovery_safe");
    assert.equal(reopened.identity.allUsers().length, snapshot.users);
    reopened.identity.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("v12 迁移失败 -> 整级回滚：user_version 停 12，v13/v14 结构不残留", async () => {
  const { root, dbPath, storeRoot, snapshot } = await makeV12Db();
  try {
    const failing = new IdentityStore({ path: dbPath, hooks: { onMigration: (v) => { if (v === 13) throw new Error("boom-v13"); } } });
    assert.throws(() => failing.open(), /boom-v13/);
    failing.close();
    const raw = new DatabaseSync(dbPath);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 12);
    for (const t of V13_TABLES) assert.equal(hasTable(raw, t), false, t + " 不应残留");
    assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM users").get().c, snapshot.users);
    raw.close();
    const repaired = reopenResourceRuntime({ dbPath, storeRoot });
    assert.equal(repaired.identity.schemaVersion, SCHEMA_VERSION);
    for (const t of V13_TABLES) assert.equal(hasTable(repaired.identity.connection, t), true, t + " 修复后应存在");
    repaired.identity.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("v13 -> v14：recovery_safe 列建立，旧数据完整", async () => {
  const { root, dbPath, storeRoot, snapshot } = await makeV13Db();
  try {
    const reopened = reopenResourceRuntime({ dbPath, storeRoot });
    assert.equal(reopened.identity.schemaVersion, 14);
    assert.ok(colsOf(reopened.identity.connection, "side_effect_calls").includes("recovery_safe"), "v14 应补上 recovery_safe");
    assert.equal(reopened.identity.allUsers().length, snapshot.users);
    reopened.identity.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("v14 迁移失败 -> 整级回滚：user_version 停 13，recovery_safe 不残留", async () => {
  const { root, dbPath, storeRoot, snapshot } = await makeV13Db();
  try {
    const failing = new IdentityStore({ path: dbPath, hooks: { onMigration: (v) => { if (v === 14) throw new Error("boom-v14"); } } });
    assert.throws(() => failing.open(), /boom-v14/);
    failing.close();
    const raw = new DatabaseSync(dbPath);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 13);
    assert.ok(!colsOf(raw, "side_effect_calls").includes("recovery_safe"), "失败后 recovery_safe 不应残留");
    assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM users").get().c, snapshot.users);
    raw.close();
    // 修复：去掉失败 hook 后可正常升到 14。
    const repaired = reopenResourceRuntime({ dbPath, storeRoot });
    assert.equal(repaired.identity.schemaVersion, 14);
    assert.ok(colsOf(repaired.identity.connection, "side_effect_calls").includes("recovery_safe"));
    repaired.identity.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
