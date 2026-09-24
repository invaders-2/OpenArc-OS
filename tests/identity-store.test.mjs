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
const { IdentityStore, SCHEMA_VERSION, SCHEMA_SQL, openDatabase } = require("../electron/identity-store.cjs");
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

test("schema：当前版本有 user_version 与 avatar_ref，且三张主表齐备", () => {
  const fx = fixture();
  assert.equal(fx.store.schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 21);
  for (const t of ["installations", "users", "sessions"])
    assert.ok(fx.store.db.prepare(`SELECT 1 FROM ${t}`).get !== undefined);
  const userCols = fx.store.db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  assert.ok(userCols.includes("avatar_ref"), "当前 users 必须带 avatar_ref");
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

test("迁移：真实的 v1 库升级到当前版本，补齐 avatar_ref 且不丢数据", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d3-test-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "identity.db");

  // 用当前 SCHEMA_SQL 去掉 avatar_ref 行，得到一个真实 v1 形状的库（不是空库）
  const v1Sql = SCHEMA_SQL.replace(/^\s*avatar_ref\s+TEXT[^\n]*\n/m, "");
  assert.ok(!v1Sql.includes("avatar_ref"), "fixture 必须是 v1 形状");
  const legacy = openDatabase(dbPath);
  legacy.exec(v1Sql);
  legacy.exec("PRAGMA user_version = 1");
  legacy.exec("INSERT INTO installations (singleton, id, status, created_at, initialized_at) VALUES (1, 'inst_v1', 'READY', 1, 1)");
  legacy.exec("INSERT INTO teams (id, name, root, created_at) VALUES ('team_v1', 'Primary', 1, 1)");
  legacy.exec(
    `INSERT INTO users (id, installation_id, team_id, identifier, display_name, role, status, auth_version,
                         password_algo, password_params, password_salt, password_hash, password_version, created_at, updated_at)
     VALUES ('usr_v1', 'inst_v1', 'team_v1', 'legacy@x', 'Legacy', 'ADMIN', 'ACTIVE', 1,
             'scrypt', '{}', X'00', 'h', 1, 1, 1)`,
  );
  legacy.close();

  const store = new IdentityStore({ path: dbPath }).open();
  assert.equal(store.schemaVersion, SCHEMA_VERSION, "打开即升级到当前版本");
  const cols = store.db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  assert.ok(cols.includes("avatar_ref"), "ALTER TABLE 必须真的加列");
  const rows = store.allUsers();
  assert.equal(rows.length, 1, "迁移不丢已有用户");
  assert.equal(rows[0].display_name, "Legacy");
  assert.equal(rows[0].avatar_ref, null, "老行新列为 NULL");

  // 升级后的库可以正常改资料
  assert.equal(store.updateProfile({ userId: "usr_v1", avatarRef: "preset:sun" }).ok, true);
  assert.equal(store.userById("usr_v1").avatar_ref, "preset:sun");
  store.close();
});

test("初始化：avatarRef 落库并在登录快照中读回；非法头像被拒且不建安装", async () => {
  const fx = fixture();

  // 非法头像在服务层就被拒，不能留下半个安装 / 半个用户
  const bad = await fx.service.dispatch({
    type: "identity/initialize",
    identifier: "a@b.local",
    password: PW,
    displayName: "A",
    avatarRef: "preset:nope",
  });
  assert.equal(bad.error, "INVALID_INPUT");
  assert.equal(bad.type, "identity/initialize");
  assert.equal(fx.store.status().initialized, false, "非法头像不得留下安装");
  assert.equal(fx.store.userCount(), 0);

  // 合法头像随初始化一次落库
  const ok = await fx.service.dispatch({
    type: "identity/initialize",
    identifier: "a@b.local",
    password: PW,
    displayName: "A",
    avatarRef: "preset:arc",
  });
  assert.equal(ok.ok, true);
  assert.equal(fx.store.allUsers()[0].avatar_ref, "preset:arc", "初始化写入 users.avatar_ref");

  // 登录快照读回同一头像
  const login = await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW });
  assert.equal(login.snapshot.avatarRef, "preset:arc", "快照必须反映落库的头像");

  // 不提供 avatarRef → NULL
  const fx2 = fixture();
  await fx2.service.dispatch({ type: "identity/initialize", identifier: "c@d.local", password: PW, displayName: "C" });
  assert.equal(fx2.store.allUsers()[0].avatar_ref, null, "未提供头像时落 NULL");
});

test("资料：store.updateProfile 落库，只在提供字段时更新", async () => {
  const fx = fixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
  const uid = fx.store.allUsers()[0].id;

  const one = fx.store.updateProfile({ userId: uid, displayName: "Alice" });
  assert.equal(one.ok, true);
  assert.equal(fx.store.userById(uid).display_name, "Alice");
  assert.equal(fx.store.userById(uid).avatar_ref, null, "未提供的 avatar 不动");

  const two = fx.store.updateProfile({ userId: uid, avatarRef: "preset:arc" });
  assert.equal(two.ok, true);
  assert.equal(fx.store.userById(uid).display_name, "Alice", "未提供的 displayName 不动");
  assert.equal(fx.store.userById(uid).avatar_ref, "preset:arc");

  // avatarRef: null 是"清除头像"，与"未提供"不同
  assert.equal(fx.store.updateProfile({ userId: uid, avatarRef: null }).ok, true);
  assert.equal(fx.store.userById(uid).avatar_ref, null);

  // 一项都没有 / 用户不存在 → INVALID_INPUT
  assert.equal(fx.store.updateProfile({ userId: uid }).error, "INVALID_INPUT");
  assert.equal(fx.store.updateProfile({ userId: "usr_missing", displayName: "X" }).error, "INVALID_INPUT");
});

test("资料：identity/update-profile 免密码、只认活跃 session，且不撤销 session", async () => {
  const fx = fixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
  const ref = (await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW })).snapshot.sessionRef;
  const uid = fx.store.allUsers()[0].id;
  const events = [];
  fx.service.onEvent((e) => events.push(e));

  // 非法头像 → INVALID_INPUT（全程不需要任何口令）
  assert.equal((await fx.service.dispatch({ type: "identity/update-profile", sessionRef: ref, avatarRef: "preset:nope" })).error, "INVALID_INPUT");

  // 免密码：只给 sessionRef 与要改的字段即可成功，snapshot 是更新后的值
  const ok = await fx.service.dispatch({
    type: "identity/update-profile",
    sessionRef: ref,
    displayName: "Alice",
    avatarRef: "preset:orbit",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.snapshot.displayName, "Alice");
  assert.equal(ok.snapshot.avatarRef, "preset:orbit");
  assert.equal(fx.store.userById(uid).display_name, "Alice");
  assert.equal(fx.store.userById(uid).avatar_ref, "preset:orbit");
  assert.ok(events.some((e) => e.event === "identity/profile-updated"), "应发出 PROFILE_UPDATED 事件");

  // 不撤销 session、不要求重新登录
  assert.equal(fx.store.sessionByRef(ref).revoked_at, null);
  assert.equal((await fx.service.dispatch({ type: "identity/validate", sessionRef: ref })).ok, true);
});

test("资料：无 session 的 update-profile 一律拒绝，identifier 不再是旁路", async () => {
  const fx = fixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
  const uid = fx.store.allUsers()[0].id;

  // 从未登录：就算带上正确的 identifier 也不能改 —— identifier 参数已被彻底忽略
  const noSession = await fx.service.dispatch({ type: "identity/update-profile", identifier: "a@b.local", displayName: "FromLogin" });
  assert.equal(noSession.error, "SESSION_REVOKED");
  assert.equal(fx.store.userById(uid).display_name, "A", "无 session 时不得有任何写入");
  assert.ok(
    fx.store.auditLog().some((r) => r.event === "update-profile" && r.result === "DENY" && r.error_code === "SESSION_REVOKED"),
    "无 session 拒绝也必须留 DENY 审计",
  );

  // 已登出：旧 ref 也不再可用
  const ref = (await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW })).snapshot.sessionRef;
  await fx.service.dispatch({ type: "identity/logout", sessionRef: ref });
  assert.equal((await fx.service.dispatch({ type: "identity/update-profile", sessionRef: ref, displayName: "X" })).error, "SESSION_REVOKED");
  assert.equal(fx.store.userById(uid).display_name, "A");
});
