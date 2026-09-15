/** D4-03B · v11 -> v12（tool_executions）迁移与失败回滚。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createResourceFixture, reopenResourceRuntime, tempRoot } from "./resource-fixtures.mjs";
const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const { DatabaseSync } = require("node:sqlite");

const V12_TABLES = ["tool_executions"];
const V13_TABLES = ["side_effect_calls", "tool_approvals", "side_effect_leases"];
const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

async function makeV11Db() {
  const root = tempRoot("oa-d4-03b-mig");
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const fx = await createResourceFixture({ dbPath, storeRoot });
  const snapshot = { users: fx.identity.allUsers().length };
  fx.identity.close();
  const raw = new DatabaseSync(dbPath);
  for (const t of [...V12_TABLES, ...V13_TABLES]) raw.exec("DROP TABLE IF EXISTS " + t);
  raw.exec("PRAGMA user_version = 11");
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 11);
  raw.close();
  return { root, dbPath, storeRoot, snapshot };
}

test("v11 -> v12：tool_executions 建立，旧数据完整", async () => {
  const { root, dbPath, storeRoot, snapshot } = await makeV11Db();
  try {
    const reopened = reopenResourceRuntime({ dbPath, storeRoot });
    assert.equal(SCHEMA_VERSION, 14);
    assert.equal(reopened.identity.schemaVersion, SCHEMA_VERSION);
    for (const t of [...V12_TABLES, ...V13_TABLES]) assert.equal(hasTable(reopened.identity.connection, t), true, t + " 应存在");
    assert.equal(reopened.identity.allUsers().length, snapshot.users);
    reopened.identity.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("v12 迁移失败 -> 整级回滚：user_version 停 11，v12 表不残留", async () => {
  const { root, dbPath, storeRoot, snapshot } = await makeV11Db();
  try {
    const failing = new IdentityStore({ path: dbPath, hooks: { onMigration: (v) => { if (v === 12) throw new Error("boom-v12"); } } });
    assert.throws(() => failing.open(), /boom-v12/);
    failing.close();
    const raw = new DatabaseSync(dbPath);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 11);
    for (const t of [...V12_TABLES, ...V13_TABLES]) assert.equal(hasTable(raw, t), false, t + " 不应残留");
    assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM users").get().c, snapshot.users);
    raw.close();
    const repaired = reopenResourceRuntime({ dbPath, storeRoot });
    assert.equal(repaired.identity.schemaVersion, 14);
    for (const t of [...V12_TABLES, ...V13_TABLES]) assert.equal(hasTable(repaired.identity.connection, t), true, t + " 修复后应存在");
    repaired.identity.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
