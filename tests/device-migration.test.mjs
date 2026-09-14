/**
 * D3-03 · device-migration.test
 * v2 → v3：既有 Identity / Authorization 数据必须继续成立；失败必须整级回滚（§53 §54 §55）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { tempDbPath } from "./device-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_SQL, SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const passwords = require("../electron/password.cjs");
const { DatabaseSync } = require("node:sqlite");

const ADMIN_ID = "admin@openarc.test";
const ADMIN_PW = "admin-password-1";
const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** 造一个真实的 **v2** 库：身份 + 对象授权数据都在，且 admin 可以登录。 */
async function seedV2(dbPath) {
  const verifier = await passwords.createVerifier(ADMIN_PW);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.exec(SCHEMA_V2_SQL);
  db.exec("PRAGMA user_version = 2");
  const now = 1700000000000;
  const instId = "inst_mig300000000000000001";
  const teamId = "team_mig300000000000000001";
  db.prepare("INSERT INTO installations (singleton,id,status,created_at,initialized_at) VALUES (1,?,'READY',?,?)").run(instId, now, now);
  db.prepare("INSERT INTO teams (id,name,root,created_at) VALUES (?, 'Primary', 1, ?)").run(teamId, now);
  const userId = "usr_mig300000000000000001";
  db.prepare(
    "INSERT INTO users (id,installation_id,team_id,identifier,display_name,role,status,auth_version,password_algo,password_params,password_salt,password_hash,password_version,created_at,updated_at) VALUES (?,?,?,?, 'Legacy Admin','ADMIN','ACTIVE',1,?,?,?,?,1,?,?)",
  ).run(userId, instId, teamId, ADMIN_ID, verifier.algo, JSON.stringify(verifier.params), verifier.salt, passwords.encodeVerifier(verifier), now, now);
  const deptId = "dept_mig30000000000000001";
  db.prepare("INSERT INTO departments (id, organization_id, name, description, status, created_by, created_at, updated_at) VALUES (?,?, 'Design', '', 'ACTIVE', ?, ?, ?)").run(deptId, teamId, userId, now, now);
  const resId = "res_mig30000000000000001";
  // collection_id 有 FK 指向 collections(id)：必须用 NULL，空字符串会违反外键
  db.prepare(
    "INSERT INTO resource_registry (resource_id, resource_type, owner_user_id, organization_id, department_id, collection_id, scope, parent_resource_id, name, description, tags, version, status, created_at, updated_at) VALUES (?, 'document', ?, ?, ?, NULL, 'DEPARTMENT', '', 'Legacy Doc', '', '[]', 1, 'active', ?, ?)",
  ).run(resId, userId, teamId, deptId, now, now);
  db.prepare("INSERT INTO resource_grants (id, principal_type, principal_id, resource_id, collection_id, resource_type, department_id, scope, actions, permission_set, granted_by, organization_id, created_at, updated_at) VALUES ('grant_mig300000000000001','USER',?,?,'','','','',?,'viewer',?,?,?,?)").run(
    userId,
    resId,
    JSON.stringify(["view"]),
    userId,
    teamId,
    now,
    now,
  );
  db.prepare("INSERT INTO authorization_audit (at, actor_user_id, action, decision, reason_code, request_id) VALUES (?,?, 'resource.view','ALLOW',NULL,'req_legacy_1')").run(now, userId);
  db.close();
  return { instId, teamId, userId, deptId, resId };
}

test("v2 → 最新 schema 迁移：版本推进、v3 表建立、既有身份与授权数据全部保留", async () => {
  const dbPath = tempDbPath("openarc-d3-03-mig");
  const seeded = await seedV2(dbPath);

  const identity = new IdentityStore({ path: dbPath }).open();
  assert.equal(identity.schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 11); // D4-03A 在 v10 之上追加 Tool Proposal / Decision
  for (const t of ["devices", "device_pairing_credentials", "device_credentials", "device_access", "device_audit"]) {
    assert.equal(hasTable(identity.connection, t), true, "缺少 v3 表 " + t);
  }
  // 既有数据
  assert.equal(identity.connection.prepare("SELECT name FROM departments WHERE id=?").get(seeded.deptId).name, "Design");
  assert.equal(identity.connection.prepare("SELECT name FROM resource_registry WHERE resource_id=?").get(seeded.resId).name, "Legacy Doc");
  assert.equal(identity.connection.prepare("SELECT COUNT(*) c FROM resource_grants").get().c, 1);
  assert.equal(identity.connection.prepare("SELECT reason_code FROM authorization_audit WHERE request_id='req_legacy_1'").get().reason_code, null);
  // 身份系统仍然可用
  const login = await identity.login({ identifier: ADMIN_ID, password: ADMIN_PW });
  assert.equal(login.ok, true, "迁移后必须还能登录");
  identity.close();
});

test("迁移后登记设备可用：v3 表是真实可写的（不是空壳）", async () => {
  const dbPath = tempDbPath("openarc-d3-03-mig2");
  await seedV2(dbPath);
  const identity = new IdentityStore({ path: dbPath }).open();
  const { DeviceStore } = require("../electron/device-store.cjs");
  const { DeviceService } = require("../electron/device-service.cjs");
  const store = new DeviceStore({ identity });
  const svc = new DeviceService({ identity, deviceStore: store, serviceIdentity: "svc_x" });
  const login = await identity.login({ identifier: ADMIN_ID, password: ADMIN_PW });
  const created = svc.createPairing({ context: { sessionRef: login.session.ref, appId: "resource-library" }, ttlMs: 60000 });
  assert.equal(created.ok, true);
  const res = svc.consumePairing({ secret: created.secret, serviceIdentitySeen: "svc_x", deviceIdentity: { displayName: "GPU", fingerprint: "fp_mig" } });
  assert.equal(res.ok, true);
  assert.equal(store.allDevices().length, 1);
  identity.close();
});

test("§55 迁移失败必须整级回滚：user_version 不前进、v3 表不存在", async () => {
  const dbPath = tempDbPath("openarc-d3-03-mig3");
  await seedV2(dbPath);
  const identity = new IdentityStore({
    path: dbPath,
    hooks: {
      onMigration: (version) => {
        if (version === 3) throw new Error("injected migration failure");
      },
    },
  });
  assert.throws(() => identity.open(), /injected migration failure/);
  identity.close();

  const db = new DatabaseSync(dbPath);
  assert.equal(Number(db.prepare("PRAGMA user_version").get().user_version), 2, "失败后版本不得前进");
  for (const t of ["devices", "device_pairing_credentials", "device_credentials", "device_access", "device_audit"]) {
    assert.equal(hasTable(db, t), false, "回滚后不应残留半张表 " + t);
  }
  // 既有数据仍在（说明回滚没有把 v2 一起毁掉）
  assert.ok(db.prepare("SELECT name FROM departments LIMIT 1").get());
  db.close();
});

test("迁移幂等：重复 open 不重复执行、数据不翻倍", async () => {
  const dbPath = tempDbPath("openarc-d3-03-mig4");
  await seedV2(dbPath);
  const a = new IdentityStore({ path: dbPath }).open();
  assert.equal(a.schemaVersion, SCHEMA_VERSION);
  a.close();
  const b = new IdentityStore({ path: dbPath }).open();
  assert.equal(b.schemaVersion, SCHEMA_VERSION);
  assert.equal(b.connection.prepare("SELECT COUNT(*) c FROM departments").get().c, 1);
  b.close();
});

test("版本高于本程序支持的 schema：拒绝打开（不静默降级）", async () => {
  const dbPath = tempDbPath("openarc-d3-03-mig5");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  db.exec(SCHEMA_V2_SQL);
  db.exec(SCHEMA_V3_SQL);
  db.exec("PRAGMA user_version = 99");
  db.close();
  const identity = new IdentityStore({ path: dbPath });
  assert.throws(() => identity.open(), /高于本程序支持/);
  identity.close();
});
