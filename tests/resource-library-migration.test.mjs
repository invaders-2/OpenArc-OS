/** D3-04B · resource-library-migration.test —— v4 -> v5 升级 / 失败回滚。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createResourceFixture, reopenResourceRuntime, tempRoot } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const { DatabaseSync } = require("node:sqlite");

const V5_TABLES = ["resource_recent", "resource_favorites", "resource_tags", "tags"];
const V6_TABLES = ["resource_search_docs", "resource_search_fts", "resource_index_jobs", "resource_preview_cache"];
const V7_TABLES = ["projects", "project_members", "project_resources", "canvas_boards", "canvas_resource_nodes"];
const V8_TABLES = ["model_providers", "model_configs", "model_defaults", "model_credentials", "model_call_records"];
const V9_TABLES = ["task_events", "task_model_calls", "task_steps", "tasks"];
const V10_TABLES = ["task_harness_runs", "task_artifacts", "task_verifications"];
const V11_TABLES = ["task_tool_proposals", "tool_decisions"];
const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
const hasColumn = (db, table, col) => db.prepare("PRAGMA table_info(" + table + ")").all().some((c) => c.name === col);

const cleanups = [];
after(() => {
  for (const dir of cleanups) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** 建一个带 D3-04A 资源数据的 v5 库，再手工降级为 v4（模拟 D3-04A 现状）。 */
async function makeV4Db() {
  const root = tempRoot("oa-d3-04b-mig");
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const fx = await createResourceFixture({ dbPath, storeRoot });
  const ctx = fx.ctx("alice");
  const src = fx.writeSource("legacy.txt", "legacy content");
  const imp = await fx.resourceService.importManaged({ context: ctx, sourcePath: src, name: "Legacy Resource" });
  const snapshot = { orgId: fx.orgId, users: fx.identity.allUsers().length, departments: fx.store.departmentsOfOrg(fx.orgId).length, resourceId: imp.resource.resourceId, ref: imp.resource.resourceRef };
  fx.identity.close();
  const raw = new DatabaseSync(dbPath);
  for (const t of V11_TABLES) raw.exec("DROP TABLE IF EXISTS " + t);
  for (const t of V10_TABLES) raw.exec("DROP TABLE IF EXISTS " + t);
  for (const t of V9_TABLES) raw.exec("DROP TABLE IF EXISTS " + t);
  for (const t of V7_TABLES) raw.exec("DROP TABLE IF EXISTS " + t);
  for (const t of V8_TABLES) raw.exec("DROP TABLE IF EXISTS " + t);
  for (const t of V6_TABLES) raw.exec("DROP TABLE IF EXISTS " + t);
  for (const t of V5_TABLES) raw.exec("DROP TABLE IF EXISTS " + t);
  for (const col of ["memory_subtype", "language", "attributes"]) raw.exec("ALTER TABLE library_resources DROP COLUMN " + col);
  raw.exec("PRAGMA user_version = 4");
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 4);
  raw.close();
  return { root, dbPath, storeRoot, snapshot };
}

test("v4 -> v5：升级成功，v5 表建立，identity/authorization/resource 数据完整", async () => {
  const { root, dbPath, storeRoot, snapshot } = await makeV4Db();
  cleanups.push(root);
  const reopened = reopenResourceRuntime({ dbPath, storeRoot });
  assert.equal(reopened.identity.schemaVersion, SCHEMA_VERSION);
  assert.equal(reopened.identity.allUsers().length, snapshot.users);
  assert.equal(reopened.authStore.departmentsOfOrg(snapshot.orgId).length, snapshot.departments);
  for (const t of [...V5_TABLES, ...V6_TABLES, ...V7_TABLES, ...V8_TABLES, ...V9_TABLES, ...V10_TABLES, ...V11_TABLES]) assert.equal(hasTable(reopened.identity.connection, t), true, t + " 应存在");
  for (const col of ["memory_subtype", "language", "attributes"]) assert.equal(hasColumn(reopened.identity.connection, "library_resources", col), true, col + " 应存在");
  const login = await reopened.identity.login({ identifier: "alice@openarc.test", password: "alice-password-1" });
  const read = await reopened.resourceService.readText({ context: { sessionRef: login.session.ref, appId: "resource-library" }, resourceRef: snapshot.ref });
  assert.equal(read.ok, true);
  assert.equal(read.text, "legacy content");
  reopened.identity.close();
});

test("v5 级迁移失败 -> user_version 停在 4，v5 表不残留，旧 Resource 仍可读", async () => {
  const { root, dbPath, storeRoot, snapshot } = await makeV4Db();
  cleanups.push(root);
  const failing = new IdentityStore({ path: dbPath, hooks: { onMigration: (v) => { if (v === 5) throw new Error("boom-d3-04b"); } } });
  assert.throws(() => failing.open(), /boom-d3-04b/);
  failing.close();

  const raw = new DatabaseSync(dbPath);
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 4);
  for (const t of [...V5_TABLES, ...V6_TABLES, ...V7_TABLES, ...V8_TABLES]) assert.equal(hasTable(raw, t), false, t + " 不应残留");
  assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM users").get().c, snapshot.users);
  raw.close();

  const repaired = reopenResourceRuntime({ dbPath, storeRoot });
  assert.equal(repaired.identity.schemaVersion, SCHEMA_VERSION);
  const login = await repaired.identity.login({ identifier: "alice@openarc.test", password: "alice-password-1" });
  const read = await repaired.resourceService.readText({ context: { sessionRef: login.session.ref, appId: "resource-library" }, resourceRef: snapshot.ref });
  assert.equal(read.text, "legacy content");
  repaired.identity.close();
});
