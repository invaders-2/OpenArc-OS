/**
 * D3-02 探针 06 · 迁移完整性/回滚 / Grant Race / Session Revalidation。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import { Probe, createFixture, tempDbPath } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_SQL } = require("../../electron/identity-store.cjs");
const { AuthorizationStore } = require("../../electron/authorization-store.cjs");
const domain = require("../../electron/authorization-domain.cjs");
const passwords = require("../../electron/password.cjs");
const { DatabaseSync } = require("node:sqlite");

const p = new Probe("06-migration-race-session", "迁移完整性 / Grant Race / Session Revalidation");
const ADMIN_ID = "admin@openarc.test";
const ADMIN_PW = "admin-password-1";
const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

async function seedV1(dbPath) {
  const verifier = await passwords.createVerifier(ADMIN_PW);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA user_version = 1");
  const now = 1700000000000;
  const instId = "inst_probe0000000000000001";
  db.prepare("INSERT INTO installations (singleton,id,status,created_at,initialized_at) VALUES (1,?, 'READY', ?, ?)").run(instId, now, now);
  const teamId = "team_probe000000000000001";
  db.prepare("INSERT INTO teams (id,name,root,created_at) VALUES (?, 'Primary', 1, ?)").run(teamId, now);
  db.prepare(
    "INSERT INTO users (id,installation_id,team_id,identifier,display_name,role,status,auth_version,password_algo,password_params,password_salt,password_hash,password_version,created_at,updated_at) VALUES ('usr_probe0000000000000001',?,?,?, 'Legacy','ADMIN','ACTIVE',1,?,?,?,?,1,?,?)",
  ).run(instId, teamId, ADMIN_ID, verifier.algo, JSON.stringify(verifier.params), verifier.salt, passwords.encodeVerifier(verifier), now, now);
  db.close();
}

// 1. 全新库 → v2
{
  const { dir, dbPath } = tempDbPath("oa-d3-02-probe-");
  try {
    const s = new IdentityStore({ path: dbPath }).open();
    p.assert("全新库 schemaVersion = 2", s.schemaVersion === 2, String(s.schemaVersion));
    const init = await s.initialize({ identifier: ADMIN_ID, password: ADMIN_PW, displayName: "Admin" });
    const login = await s.login({ identifier: ADMIN_ID, password: ADMIN_PW });
    p.assert("v2 上 identity initialize/login 成立", init.ok === true && login.ok === true, "");
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 2. v1 → v2 迁移
{
  const { dir, dbPath } = tempDbPath("oa-d3-02-probe-");
  try {
    await seedV1(dbPath);
    const s = new IdentityStore({ path: dbPath }).open();
    const login = await s.login({ identifier: ADMIN_ID, password: ADMIN_PW });
    const lock = s.lock(login.session.ref);
    const unlocked = await s.unlock(login.session.ref, ADMIN_PW);
    p.assert("v1 → v2 后 login/lock/unlock 成立", s.schemaVersion === 2 && login.ok && lock.ok && unlocked.ok, "");
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 3. 迁移失败 → 整级回滚
{
  const { dir, dbPath } = tempDbPath("oa-d3-02-probe-");
  try {
    await seedV1(dbPath);
    let threw = false;
    const failing = new IdentityStore({ path: dbPath, hooks: { onMigration: (v) => { if (v === 2) throw new Error("boom"); } } });
    try {
      failing.open();
    } catch {
      threw = true;
    }
    failing.close();
    const raw = new DatabaseSync(dbPath);
    const versionKept = raw.prepare("PRAGMA user_version").get().user_version === 1;
    const noV2 = !hasTable(raw, "departments") && !hasTable(raw, "resource_registry");
    const dataKept = raw.prepare("SELECT COUNT(*) AS c FROM users").get().c === 1;
    raw.close();
    p.assert("迁移失败 → 回滚：version 保持 1 / 无 v2 表 / v1 数据完整", threw && versionKept && noV2 && dataKept, "threw=" + threw + " version1=" + versionKept + " noV2=" + noV2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 4. Grant Race
{
  const { dir, dbPath } = tempDbPath("oa-d3-02-probe-");
  const f = await createFixture({ dbPath });
  const second = new IdentityStore({ path: dbPath }).open();
  const store2 = new AuthorizationStore({ identity: second });
  try {
    const rid = f.resources.alpha.resourceId;
    const base = { principalType: "USER", principalId: f.created.erin, resourceId: rid, organizationId: f.orgId };
    await Promise.all([
      f.identity.transact(() => f.store.upsertResourceGrant({ ...base, actions: ["resource.read"] })),
      second.transact(() => store2.upsertResourceGrant({ ...base, actions: ["resource.download"] })),
    ]);
    const rows = f.store.grantsForResource(rid).filter((g) => g.principal_type === "USER" && g.principal_id === f.created.erin);
    const acts = rows.length === 1 ? domain.grantActions(rows[0]) : [];
    p.assert("两连接并发 grant → 单行且动作并集", rows.length === 1 && acts.includes("resource.read") && acts.includes("resource.download"), "rows=" + rows.length);
  } finally {
    second.close();
    f.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 5. Session Revalidation
{
  const f = await createFixture();
  const { svc, ctx, resources } = f;
  try {
    f.identity.logout(f.sessions.dana);
    let r = svc.authorize({ context: ctx("dana", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
    p.assert("revoked session → DENY SESSION_REVOKED", r.decision === "DENY" && r.reasonCode === "SESSION_REVOKED", r.reasonCode);

    f.identity.connection.prepare("UPDATE sessions SET expires_at = 0 WHERE ref = ?").run(f.sessions.charlie);
    r = svc.authorize({ context: ctx("charlie", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
    p.assert("expired session → DENY SESSION_EXPIRED", r.decision === "DENY" && r.reasonCode === "SESSION_EXPIRED", r.reasonCode);

    f.identity.lock(f.sessions.erin);
    r = svc.authorize({ context: ctx("erin", "resource-library"), action: domain.ACTION.READ, resource: resources.designHero.resourceId });
    p.assert("locked session（ACL 允许）→ DENY SESSION_LOCKED / REAUTH", r.decision === "DENY" && r.reasonCode === "SESSION_LOCKED" && r.challenge === "REAUTH", r.reasonCode);
  } finally {
    f.close();
  }
}

p.finish();
if (p.verdict() === "FAIL") process.exitCode = 1;
