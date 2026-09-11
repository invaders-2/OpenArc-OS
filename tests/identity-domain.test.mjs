/**
 * D3-01 · 领域层单元测试（纯函数，无 I/O）。
 * 覆盖：ID 域、错误模型、输入归一化、快照边界、session 判定、限流退避。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const d = require("../electron/identity-domain.cjs");
const pw = require("../electron/password.cjs");

test("ID 域：四个前缀互不重叠，且能按域识别", () => {
  assert.equal(d.ID_PREFIX.INSTALLATION, "inst_");
  assert.equal(d.ID_PREFIX.TEAM, "team_");
  assert.equal(d.ID_PREFIX.USER, "usr_");
  assert.equal(d.ID_PREFIX.SESSION, "ses_");
  assert.equal(d.ID_PREFIX.SESSION_REF, "sref_");
  const uid = d.newId("USER");
  assert.ok(d.isIdOf("USER", uid));
  assert.ok(!d.isIdOf("SESSION", uid));
  assert.ok(!d.isIdOf("DEVICE", uid), "deviceId 不在本轮 ID 域内（属于 D3-03）");
});

test("sessionRef 与 token 是两次独立随机，互不可推导", () => {
  const token = d.newSessionToken();
  const ref = d.newId("SESSION_REF");
  assert.notEqual(token, ref);
  assert.equal(d.hashToken(token).length, 64);
  assert.notEqual(d.hashToken(token), token);
  assert.equal(d.hashRef(ref).length, 16);
});

test("标识符归一化：trim + 小写，控制字符被拒", () => {
  assert.equal(d.normalizeIdentifier("  Admin@OpenArc.Local  "), "admin@openarc.local");
  assert.equal(d.validateIdentifier("  Admin@OpenArc.Local ").ok, true);
  assert.equal(d.validateIdentifier("   ").error, "INVALID_INPUT");
  assert.equal(d.validateIdentifier("a\nb").error, "INVALID_INPUT");
  assert.equal(d.validateIdentifier("a".repeat(300)).error, "INVALID_INPUT");
});

test("错误码集合包含 §26 要求的全部码", () => {
  for (const code of [
    "NOT_INITIALIZED",
    "ALREADY_INITIALIZED",
    "INVALID_CREDENTIALS",
    "SESSION_EXPIRED",
    "SESSION_REVOKED",
    "USER_DISABLED",
    "LOCKED",
    "INVALID_INPUT",
    "INTERNAL_ERROR",
  ])
    assert.ok(code in d.ERROR, `缺少 ${code}`);
});

test("snapshot 白名单：禁止键被静态断言抓住，且受控反证成立", () => {
  const snap = d.identitySnapshot({
    user: { id: "usr_1", display_name: "A", identifier: "a@b", role: "ADMIN", status: "ACTIVE", team_id: "team_1" },
    session: { id: "ses_1", ref: "sref_1", created_at: 1, last_seen_at: 1, expires_at: 2, locked_at: null },
  });
  assert.equal(d.snapshotViolations(snap).length, 0);
  for (const bad of ["password", "password_hash", "salt", "token", "token_hash"]) {
    assert.equal(d.snapshotViolations({ ...snap, [bad]: "x" }).length, 1, `${bad} 应被抓到`);
  }
  assert.ok(!("password_hash" in snap));
  assert.equal(snap.role, "ADMIN");
  assert.equal(snap.locked, false);
  assert.equal(snap.avatarRef, null, "avatarRef 字段先落位，恒为 null");
});

test("session 判定顺序：revoke > expiry > 用户禁用 > authVersion", () => {
  const user = { id: "u", status: "ACTIVE", auth_version: 1 };
  const base = { user_id: "u", revoked_at: null, expires_at: 100, idle_expires_at: 100, auth_version: 1, locked_at: null };
  assert.equal(d.evaluateSession({ ...base, revoked_at: 5 }, user, 10).error, "SESSION_REVOKED");
  assert.equal(d.evaluateSession({ ...base, expires_at: 10 }, user, 10).error, "SESSION_EXPIRED");
  assert.equal(d.evaluateSession({ ...base, idle_expires_at: 9 }, user, 10).error, "SESSION_EXPIRED");
  assert.equal(d.evaluateSession(base, { ...user, status: "DISABLED" }, 10).error, "USER_DISABLED");
  assert.equal(d.evaluateSession({ ...base, auth_version: 0 }, user, 10).error, "SESSION_REVOKED");
  assert.equal(d.evaluateSession(base, user, 10).ok, true);
});

test("受保护命令守卫：锁定算 LOCKED，非敏感校验仍通过", () => {
  const user = { id: "u", status: "ACTIVE", auth_version: 1 };
  const s = { user_id: "u", revoked_at: null, expires_at: 100, idle_expires_at: 100, auth_version: 1, locked_at: 5 };
  assert.equal(d.guardProtected(s, user, 10, { sensitive: true }).error, "LOCKED");
  assert.equal(d.guardProtected(s, user, 10, { sensitive: false }).ok, true);
  assert.ok(d.REAUTH_CODES.includes("LOCKED"));
  assert.ok(d.TERMINAL_CODES.includes("USER_DISABLED"));
  assert.ok(!d.TERMINAL_CODES.includes("LOCKED"), "LOCKED 不该被当成终止态");
});

test("限流：指数退避有上限，绝不永久封锁", () => {
  assert.equal(d.cooldownFor(1), 0);
  assert.equal(d.cooldownFor(d.RATE_LIMIT.MAX_FAILURES - 1), 0);
  const first = d.cooldownFor(d.RATE_LIMIT.MAX_FAILURES);
  assert.ok(first > 0);
  for (let f = d.RATE_LIMIT.MAX_FAILURES; f < d.RATE_LIMIT.MAX_FAILURES + 50; f += 1) {
    assert.ok(d.cooldownFor(f) <= d.RATE_LIMIT.MAX_COOLDOWN_MS, "冷却有上限");
  }
  assert.equal(d.RATE_LIMIT.MAX_FAILURES >= 5, true, "阈值不应低于 5（避免 DoS 式设计）");
  const k1 = d.rateKey("admin@x", "local");
  const k2 = d.rateKey("ADMIN@x", "local");
  assert.equal(k1, k2, "限流键按归一化标识符");
  assert.notEqual(k1, d.rateKey("admin@x", "other"));
});

test("ID 域不含 deviceId（D3-01 不建设备身份）", () => {
  assert.ok(!("DEVICE" in d.ID_PREFIX));
  assert.ok(!d.ALL_COMMANDS.some((c) => c.includes("device")));
});

test("口令 KDF：scrypt 自描述格式，校验与升级判定", async () => {
  const v = await pw.createVerifier("correct-horse-1");
  const enc = pw.encodeVerifier(v);
  assert.match(enc, /^scrypt\$1\$32768\$8\$1\$32\$[\w-]+\$[\w-]+$/);
  assert.equal(await pw.verifyPassword("correct-horse-1", enc), true);
  assert.equal(await pw.verifyPassword("wrong-password-9", enc), false);
  assert.equal(pw.needsUpgrade(enc), false);
  // 参数下调过的 verifier 需要升级
  const weak = await pw.createVerifier("correct-horse-1", { N: 1024, r: 8, p: 1, keylen: 32 });
  assert.equal(pw.needsUpgrade(pw.encodeVerifier(weak)), true);
  // 坏串也要走满一次 KDF（不能因格式错就立刻返回，否则又是一个时间侧信道）
  assert.equal(await pw.verifyPassword("correct-horse-1", "garbage"), false);
  assert.equal(pw.validatePassword("").ok, false);
  assert.equal(pw.validatePassword("1234567").ok, false);
  assert.equal(pw.validatePassword("12345678").ok, true);
});
