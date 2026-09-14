/**
 * D3-04A/04B · resource-migration.test —— v3 -> current schema / 迁移失败回滚 / 重启持久化。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createResourceFixture, reopenResourceRuntime, tempRoot } from "./resource-fixtures.mjs";
import { pairDevice, pw } from "./device-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const { DatabaseSync } = require("node:sqlite");

const V8_TABLES = ["model_providers", "model_configs", "model_defaults", "model_credentials", "model_call_records"];
const V9_TABLES = ["task_events", "task_model_calls", "task_steps", "tasks"];
const V10_TABLES = ["task_harness_runs", "task_artifacts", "task_verifications"];
const V7_TABLES = ["projects", "project_members", "project_resources", "canvas_boards", "canvas_resource_nodes"];
const V6_TABLES = ["resource_search_docs", "resource_search_fts", "resource_index_jobs", "resource_preview_cache"];
const V5_TABLES = ["resource_recent", "resource_favorites", "resource_tags", "tags"];
const V4_TABLES = ["resource_relations", "resource_versions", "library_resources", "resource_import_jobs", "content_objects"];
const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** 建一个带 identity/department/device 数据的 v4 库，再降级为 v3（模拟 D3-03 现状）。 */
async function makeV3Db() {
  const root = tempRoot("oa-d3-04a-mig");
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const fx = await createResourceFixture({ dbPath, storeRoot });
  await pairDevice(fx, { displayName: "Migration Device" });
  const snapshot = { users: fx.identity.allUsers().length, departments: fx.store.departmentsOfOrg(fx.orgId).length, devices: fx.deviceStore.allDevices().length, orgId: fx.orgId };
  fx.identity.close();
  const raw = new DatabaseSync(dbPath);
  for (const table of V10_TABLES) raw.exec("DROP TABLE IF EXISTS " + table);
  for (const table of V9_TABLES) raw.exec("DROP TABLE IF EXISTS " + table);
  for (const table of V8_TABLES) raw.exec("DROP TABLE IF EXISTS " + table);
  for (const table of V7_TABLES) raw.exec("DROP TABLE IF EXISTS " + table);
  for (const table of V6_TABLES) raw.exec("DROP TABLE IF EXISTS " + table);
  for (const table of V5_TABLES) raw.exec("DROP TABLE IF EXISTS " + table);
  for (const col of ["memory_subtype", "language", "attributes"]) raw.exec("ALTER TABLE library_resources DROP COLUMN " + col);
  for (const table of V4_TABLES) raw.exec("DROP TABLE IF EXISTS " + table);
  raw.exec("PRAGMA user_version = 3");
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 3);
  raw.close();
  return { root, dbPath, storeRoot, snapshot };
}

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

test("v3 -> v4：升级成功且 identity / department / device 数据完整", () => {
  return (async () => {
    const { root, dbPath, storeRoot, snapshot } = await makeV3Db();
    cleanups.push(root);
    const reopened = reopenResourceRuntime({ dbPath, storeRoot });
    assert.equal(reopened.identity.schemaVersion, SCHEMA_VERSION);
    assert.equal(reopened.identity.allUsers().length, snapshot.users);
    assert.equal(reopened.authStore.departmentsOfOrg(snapshot.orgId).length, snapshot.departments);
    assert.equal(reopened.deviceStore.allDevices().length, snapshot.devices);
    for (const table of [...V4_TABLES, ...V5_TABLES, ...V6_TABLES, ...V7_TABLES, ...V8_TABLES, ...V9_TABLES, ...V10_TABLES]) assert.equal(hasTable(reopened.identity.connection, table), true, table + " 应存在");
    reopened.identity.close();
  })();
});

test("迁移失败 -> 整级回滚：user_version 保持 3，v4 表不存在，旧数据完整", () => {
  return (async () => {
    const { root, dbPath, storeRoot, snapshot } = await makeV3Db();
    cleanups.push(root);
    const failing = new IdentityStore({ path: dbPath, hooks: { onMigration: (v) => { if (v === 4) throw new Error("boom-d3-04a"); } } });
    assert.throws(() => failing.open(), /boom-d3-04a/);
    failing.close();

    const raw = new DatabaseSync(dbPath);
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 3);
    assert.equal(hasTable(raw, "content_objects"), false);
    assert.equal(hasTable(raw, "tags"), false);
    assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM users").get().c, snapshot.users);
    assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM devices").get().c, snapshot.devices);
    raw.close();

    const ok = reopenResourceRuntime({ dbPath, storeRoot });
    assert.equal(ok.identity.schemaVersion, SCHEMA_VERSION);
    assert.equal(ok.identity.allUsers().length, snapshot.users);
    ok.identity.close();
  })();
});

test("重启持久化：ResourceRef / metadata / content / grant 在重开后一致", async () => {
  const root = tempRoot("oa-d3-04a-restart");
  cleanups.push(root);
  const dbPath = path.join(root, "identity.db");
  const storeRoot = path.join(root, "library");
  const fx = await createResourceFixture({ dbPath, storeRoot });
  const ctx = fx.ctx("alice");
  const src = fx.writeSource("restart.txt", "persistent content");
  const imp = await fx.resourceService.importManaged({ context: ctx, sourcePath: src, name: "Persistent" });
  assert.equal(imp.ok, true);
  const ref = imp.resource.resourceRef;
  const grant = fx.authService.grantResourcePermission({ context: fx.adminCtx(), principalType: "USER", principalId: fx.users.dana, resourceId: imp.resource.resourceId, permissionSet: "VIEWER" });
  assert.equal(grant.ok, true);
  fx.identity.close();

  const reopened = reopenResourceRuntime({ dbPath, storeRoot });
  const login = await reopened.identity.login({ identifier: "alice@openarc.test", password: pw("alice") });
  assert.equal(login.ok, true);
  const aliceCtx = { sessionRef: login.session.ref, appId: "resource-library" };
  const got = reopened.resourceService.get({ context: aliceCtx, resourceRef: ref });
  assert.equal(got.ok, true);
  assert.equal(got.resource.name, "Persistent");
  const read = await reopened.resourceService.readText({ context: aliceCtx, resourceRef: ref });
  assert.equal(read.text, "persistent content");

  // Grant 在重启后继续生效
  const danaLogin = await reopened.identity.login({ identifier: "dana@openarc.test", password: pw("dana") });
  const danaCtx = { sessionRef: danaLogin.session.ref, appId: "resource-library" };
  const danaRead = await reopened.resourceService.readText({ context: danaCtx, resourceRef: ref });
  assert.equal(danaRead.ok, true);
  // Revoke 后继续失效
  reopened.authService.revokeResourcePermission({ context: { sessionRef: (await reopened.identity.login({ identifier: "admin@openarc.test", password: pw("admin") })).session.ref, appId: "resource-library" }, grantId: grant.grant.id });
  const denied = reopened.resourceService.read({ context: danaCtx, resourceRef: ref });
  assert.equal(denied.ok, false);
  reopened.identity.close();
});
