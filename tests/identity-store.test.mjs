/**
 * D3-01 · 持久层与命令层单元测试。
 *
 * 全部走真实 SQLite（临时目录）与真实 KDF —— 不用 mock 替身，
 * 否则"事务原子性"与"约束"这两件事就变成自说自话。
 * 只有 clock 与路径可注入。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { IdentityStore, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const { IdentityService } = require("../electron/identity-service.cjs");
const { IdentityLogger } = require("../electron/identity-log.cjs");
const { SessionSecretStore, memoryBackend } = require("../electron/session-secret-store.cjs");

const PW = "correct-horse-1";
const dirs = [];

function fixture({ ttlMs, idleMs } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-test-"));
  dirs.push(dir);
  const clock = (() => {
    let now = 1_800_000_000_000;
    const c = () => now;
    c.advance = (ms) => (now += ms);
    return c;
  })();
  const logger = new IdentityLogger();
  const store = new IdentityStore({
    path: path.join(dir, "identity.db"),
    clock,
    ttlMs,
    idleMs,
    onAudit: (r) => logger.log(r),
  }).open();
  const secrets = new SessionSecretStore(memoryBackend());
  const service = new IdentityService({ store, secrets, logger, allowAdmin: true });
  return { store, service, secrets, logger, clock };
}

after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("schema：第一版就有 user_version，且三张主表齐备", () => {
  const fx = fixture();
  assert.equal(fx.store.schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION >= 1, true);
  for (const t of ["installations", "users", "sessions"])
    assert.ok(fx.store.db.prepare(`SELECT 1 FROM ${t}`).get !== undefined);
});

test("初始化：一次性、原子、创建 admin + root team", async () => {
  const fx = fixture();
  const first = await fx.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
  assert.equal(first.ok, true);
  const second = await fx.service.dispatch({ type: "identity/initialize", identifier: "c@d.local", password: PW, displayName: "C" });
  assert.equal(second.error, "ALREADY_INITIALIZED");
  assert.equal(fx.store.allUsers().length, 1);
  assert.equal(fx.store.allTeams().filter((t) => t.root === 1).length, 1);
  assert.deepEqual(fx.store.invariants(), []);
});

test("约束：数据库级唯一 installation 与 identifier（不是靠 UI）", async () => {
  const fx = fixture();
  await fx.store.initialize({ identifier: "a@b.local", password: PW, displayName: "A" });
  // 直接插第二行 installation —— CHECK(singleton=1) 必须拒绝
  assert.throws(() =>
    fx.store.db
      .prepare(`INSERT INTO installations (singleton, id, status, created_at) VALUES (1, 'inst_x', 'READY', 1)`)
      .run(),
  );
  // 重复 identifier —— UNIQUE 必须拒绝
  assert.throws(() =>
    fx.store.db
      .prepare(
        `INSERT INTO users (id, installation_id, team_id, identifier, display_name, role, status, auth_version,
                            password_algo, password_params, password_salt, password_hash, password_version, created_at, updated_at)
         VALUES ('usr_x','inst_1','team_1','a@b.local','X','MEMBER','ACTIVE',1,'scrypt','{}',X'00','h',1,1,1)`,
      )
      .run(),
  );
});

test("登录：正确/错误/禁用三条路径", async () => {
  const fx = fixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
  const ok = await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW });
  assert.equal(ok.ok, true);
  const bad = await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: "wrong-password-9" });
  assert.equal(bad.error, "INVALID_CREDENTIALS");
  const uid = fx.store.allUsers()[0].id;
  await fx.service.dispatch({ type: "identity/disable-user", userId: uid });
  const dis = await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW });
  assert.equal(dis.error, "USER_DISABLED");
});

test("登出：真实撤销，旧 ref 不能再用于任何命令", async () => {
  const fx = fixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
  const login = await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW });
  const ref = login.snapshot.sessionRef;
  await fx.service.dispatch({ type: "identity/logout", sessionRef: ref });
  assert.equal((await fx.service.dispatch({ type: "identity/validate", sessionRef: ref })).error, "SESSION_REVOKED");
  assert.equal((await fx.service.dispatch({ type: "identity/lock", sessionRef: ref })).error, "SESSION_REVOKED");
  assert.equal((await fx.service.dispatch({ type: "identity/logout", sessionRef: ref })).error, "SESSION_REVOKED");
  assert.equal(await fx.secrets.read(), null);
});

test("锁与登出是两件事：锁定时 session 仍有效、身份可识别", async () => {
  const fx = fixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
  const ref = (await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW })).snapshot.sessionRef;
  await fx.service.dispatch({ type: "identity/lock", sessionRef: ref });
  assert.equal((await fx.service.dispatch({ type: "identity/validate", sessionRef: ref })).error, "LOCKED");
  const lenient = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref, sensitive: false });
  assert.equal(lenient.ok, true);
  assert.equal(lenient.locked, true);
  assert.equal(fx.store.sessionByRef(ref).revoked_at, null);
});

test("解锁：错口令 DENY 且保持锁定，对口令牌轮换 ref 与 token", async () => {
  const fx = fixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
  const ref = (await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW })).snapshot.sessionRef;
  await fx.service.dispatch({ type: "identity/lock", sessionRef: ref });
  assert.equal((await fx.service.dispatch({ type: "identity/unlock", sessionRef: ref, password: "wrong-password-9" })).error, "INVALID_CREDENTIALS");
  assert.notEqual(fx.store.sessionByRef(ref).locked_at, null);
  const good = await fx.service.dispatch({ type: "identity/unlock", sessionRef: ref, password: PW });
  assert.equal(good.ok, true);
  assert.notEqual(good.snapshot.sessionRef, ref);
  assert.equal((await fx.service.dispatch({ type: "identity/validate", sessionRef: ref })).error, "SESSION_REVOKED");
});

test("改密：authVersion++ 并撤销全部 session；旧口令失效", async () => {
  const fx = fixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
  const ref = (await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW })).snapshot.sessionRef;
  const v0 = fx.store.userById(fx.store.allUsers()[0].id).auth_version;
  await fx.service.dispatch({ type: "identity/change-password", sessionRef: ref, currentPassword: PW, newPassword: "new-horse-password-2" });
  assert.equal(fx.store.userById(fx.store.allUsers()[0].id).auth_version, v0 + 1);
  assert.equal((await fx.service.dispatch({ type: "identity/validate", sessionRef: ref })).error, "SESSION_REVOKED");
  assert.equal((await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW })).error, "INVALID_CREDENTIALS");
  assert.equal((await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: "new-horse-password-2" })).ok, true);
});

test("有效期：可控时钟下 before / at / after 三个边界", async () => {
  const fx = fixture({ ttlMs: 1000, idleMs: 100_000 });
  await fx.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
  const ref = (await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW })).snapshot.sessionRef;
  fx.clock.advance(999);
  assert.equal((await fx.service.dispatch({ type: "identity/validate", sessionRef: ref })).ok, true);
  fx.clock.advance(1);
  assert.equal((await fx.service.dispatch({ type: "identity/validate", sessionRef: ref })).error, "SESSION_EXPIRED");
  fx.clock.advance(5000);
  assert.equal((await fx.service.dispatch({ type: "identity/validate", sessionRef: ref })).error, "SESSION_EXPIRED");
});

test("admin 命令默认关闭（产品 UI 没有入口）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-test-"));
  dirs.push(dir);
  const store = new IdentityStore({ path: path.join(dir, "i.db") }).open();
  const svc = new IdentityService({ store, secrets: new SessionSecretStore(memoryBackend()) });
  await store.initialize({ identifier: "a@b.local", password: PW, displayName: "A" });
  const uid = store.allUsers()[0].id;
  const res = await svc.dispatch({ type: "identity/disable-user", userId: uid });
  assert.equal(res.error, "INVALID_INPUT");
});

test("重置安装需要显式确认，且无从 UI 静默触发的路径", async () => {
  const fx = fixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
  assert.equal((await fx.service.dispatch({ type: "identity/reset-installation" })).error, "INVALID_INPUT");
  assert.equal((await fx.service.dispatch({ type: "identity/reset-installation", confirm: "delete" })).error, "INVALID_INPUT");
  assert.equal((await fx.service.dispatch({ type: "identity/reset-installation", confirm: "DELETE-ALL-IDENTITY-DATA" })).ok, true);
  assert.equal(fx.store.status().initialized, false);
});
