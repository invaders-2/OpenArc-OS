/** D3-04C · resource-index-migration.test —— v5 -> v6（搜索/索引/预览派生表）与失败回滚。 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createResourceFixture, reopenResourceRuntime, tempRoot, pw } from "./resource-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const { DatabaseSync } = require("node:sqlite");

const V6_TABLES = ["resource_search_docs", "resource_search_fts", "resource_index_jobs", "resource_preview_cache"];
const V7_TABLES = ["projects", "project_members", "project_resources", "canvas_boards", "canvas_resource_nodes"];
const V8_TABLES = ["model_providers", "model_configs", "model_defaults", "model_credentials", "model_call_records"];
const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
const isVirtual = (db, name) => String(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name)?.sql || "").includes("VIRTUAL TABLE");

const cleanups = [];
after(() => {
  for (const dir of cleanups) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** 建一个真实 v5 库（D3-04B 现状），带资源与内容。 */
async function makeV5Db() {
  const root = tempRoot("oa-d3-04c-mig");
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const fx = await createResourceFixture({ dbPath, storeRoot });
  const ctx = fx.ctx("alice");
  const r = await fx.resourceService.createResource({ context: ctx, resourceType: "text", name: "Mig Needle", content: "migration-needle body 迁移" });
  assert.equal(r.ok, true);
  await fx.searchService.indexResource(r.resource.resourceId);
  const snapshot = { users: fx.identity.allUsers().length, resources: 1, resourceId: r.resource.resourceId };
  fx.identity.close();

  const raw = new DatabaseSync(dbPath);
  for (const t of [...V6_TABLES, ...V7_TABLES, ...V8_TABLES]) raw.exec("DROP TABLE IF EXISTS " + t);
  raw.exec("PRAGMA user_version = 5");
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 5);
  assert.equal(hasTable(raw, "resource_search_docs"), false);
  raw.close();
  return { root, dbPath, storeRoot, snapshot };
}

test("v5 -> v6：派生表建立，FTS 为 virtual table，资源可重新索引并搜索", () => {
  return (async () => {
    const { root, dbPath, storeRoot, snapshot } = await makeV5Db();
    cleanups.push(root);
    const reopened = reopenResourceRuntime({ dbPath, storeRoot });
    assert.equal(reopened.identity.schemaVersion, SCHEMA_VERSION);
    for (const t of [...V6_TABLES, ...V7_TABLES, ...V8_TABLES]) assert.equal(hasTable(reopened.identity.connection, t), true, t + " 应存在");
    assert.equal(isVirtual(reopened.identity.connection, "resource_search_fts"), true, "FTS 必须是 virtual table");

    const login = await reopened.identity.login({ identifier: "alice@openarc.test", password: pw("alice") });
    assert.equal(login.ok, true);
    const ctx = { sessionRef: login.session.ref, appId: "resource-library" };
    // 权威数据未受损；索引是派生数据，由 search 惰性重建
    const res = await reopened.searchService.search({ context: ctx, query: "migration-needle", limit: 5 });
    assert.equal(res.ok, true);
    assert.equal(res.total, 1);
    assert.equal(res.items[0].resourceId, snapshot.resourceId);
    // 中文也走同一条索引
    const zh = await reopened.searchService.search({ context: ctx, query: "迁移", limit: 5 });
    assert.equal(zh.total, 1);
    reopened.identity.close();
  })();
});

test("v5 -> v6 迁移失败 -> 整级回滚：user_version 保持 5 且派生表不存在", () => {
  return (async () => {
    const { root, dbPath, storeRoot, snapshot } = await makeV5Db();
    cleanups.push(root);
    const failing = new IdentityStore({ path: dbPath, hooks: { onMigration: (v) => { if (v === 6) throw new Error("boom-d3-04c"); } } });
    assert.throws(() => failing.open(), /boom-d3-04c/);
    failing.close();

    const raw = new DatabaseSync(dbPath);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 5);
    for (const t of [...V6_TABLES, ...V7_TABLES, ...V8_TABLES]) assert.equal(hasTable(raw, t), false, t + " 不应存在");
    assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM users").get().c, snapshot.users);
    assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM resource_registry").get().c, snapshot.resources);
    raw.close();

    const ok = reopenResourceRuntime({ dbPath, storeRoot });
    assert.equal(ok.identity.schemaVersion, SCHEMA_VERSION);
    for (const t of [...V6_TABLES, ...V7_TABLES, ...V8_TABLES]) assert.equal(hasTable(ok.identity.connection, t), true);
    ok.identity.close();
  })();
});
