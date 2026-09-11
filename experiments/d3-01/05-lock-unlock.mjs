/**
 * D3-01 · Lock / Unlock（§14 / §15 / §16 / §47）。
 *
 * 冻结：**LOCK ≠ LOGOUT**。
 *   Lock   → session 仍有效、身份仍可识别，但受保护命令被 DENY
 *   Logout → session 被撤销，必须重新登录
 *
 * 判据（§47）：
 *   · 锁定后，`sensitive` 校验 → LOCKED；非敏感校验 → 仍有效（身份可识别）
 *   · 错误口令解锁 → DENY，且仍保持锁定
 *   · 正确口令解锁 → 恢复，且 **ref 与 token 都轮换**
 *   · 已撤销的 session 不会被解锁偷偷恢复
 *   · 锁定期不滑动续期（锁屏不是"保持活跃"的理由）
 */
import { createHash } from "node:crypto";
import { Probe, VERDICT, makeFixture } from "./lib/id.mjs";

const p = new Probe("05-lock-unlock", "锁定与解锁：LOCK ≠ LOGOUT，解锁必须重新验证");
const cases = [];
const PW = "correct-horse-1";

{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const login = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const ref = login.snapshot.sessionRef;
  const sessionId = login.snapshot.sessionId;

  const locked = await fx.service.dispatch({ type: "identity/lock", sessionRef: ref });
  cases.push({
    name: "K1 · lock 成功",
    status: locked.ok === true && locked.snapshot?.locked === true ? VERDICT.PASS : VERDICT.FAIL,
    detail: `locked=${locked.snapshot?.locked}`,
  });

  const sensitive = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "K2 · 锁定后受保护命令 → LOCKED（§47 DENY / REQUIRE_REAUTH）",
    status: sensitive.ok === false && sensitive.error === "LOCKED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(sensitive.error),
  });

  const lenient = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref, sensitive: false });
  cases.push({
    name: "K3 · 锁定后身份仍可识别（非敏感校验仍通过）→ LOCK ≠ LOGOUT",
    status: lenient.ok === true && lenient.locked === true ? VERDICT.PASS : VERDICT.FAIL,
    detail: `ok=${lenient.ok}, locked=${lenient.locked}`,
  });

  const row = fx.store.sessionByRef(ref);
  cases.push({
    name: "K4 · session 未被撤销（revoke 与 lock 是两件事）",
    status: row.revoked_at === null && row.locked_at != null ? VERDICT.PASS : VERDICT.FAIL,
    detail: `revoked_at=${row.revoked_at}, locked_at=${row.locked_at}`,
  });

  const idleBefore = fx.store.sessionByRef(ref).idle_expires_at;
  fx.store.validateSession(ref, { sensitive: false });
  const idleAfter = fx.store.sessionByRef(ref).idle_expires_at;
  cases.push({
    name: "K5 · 锁定期不滑动续期",
    status: idleBefore === idleAfter ? VERDICT.PASS : VERDICT.FAIL,
    detail: `before=${idleBefore}, after=${idleAfter}`,
  });

  // 错误口令解锁
  const bad = await fx.service.dispatch({ type: "identity/unlock", sessionRef: ref, password: "wrong-password-9" });
  cases.push({
    name: "K6 · 错误口令解锁 → DENY",
    status: bad.ok === false && bad.error === "INVALID_CREDENTIALS" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(bad.error),
  });
  cases.push({
    name: "K7 · 解锁失败后仍处于锁定状态",
    status: fx.store.sessionByRef(ref)?.locked_at != null ? VERDICT.PASS : VERDICT.FAIL,
    detail: `locked_at=${fx.store.sessionByRef(ref)?.locked_at}`,
  });

  // 正确口令解锁
  const good = await fx.service.dispatch({ type: "identity/unlock", sessionRef: ref, password: PW });
  cases.push({
    name: "K8 · 正确口令解锁 → 恢复",
    status: good.ok === true && good.snapshot?.locked === false ? VERDICT.PASS : VERDICT.FAIL,
    detail: `ok=${good.ok}, locked=${good.snapshot?.locked}`,
  });
  cases.push({
    name: "K9 · 解锁轮换 ref（旧 ref 立即失效）",
    status: good.snapshot.sessionRef !== ref ? VERDICT.PASS : VERDICT.FAIL,
    detail: `old=${ref.slice(0, 14)}…, new=${good.snapshot.sessionRef.slice(0, 14)}…`,
  });
  cases.push({
    name: "K10 · 解锁沿用同一个 session（不是新建一条）",
    status: good.snapshot.sessionId === sessionId ? VERDICT.PASS : VERDICT.FAIL,
    detail: `sessionId 保持=${good.snapshot.sessionId === sessionId}`,
  });
  const oldRefNow = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "K11 · 旧 ref 解锁后不再可用",
    status: oldRefNow.ok === false ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(oldRefNow.error),
  });
  const newToken = (await fx.secrets.read())?.token;
  cases.push({
    name: "K12 · token 也轮换，受保护存储同步更新",
    status: typeof newToken === "string" && fx.store.sessionByTokenHash(hashOf(newToken))?.id === sessionId ? VERDICT.PASS : VERDICT.FAIL,
    detail: `token 已轮换=${!!newToken}`,
  });

  // 已撤销的 session 不得被解锁偷偷恢复
  const current = good.snapshot.sessionRef;
  await fx.service.dispatch({ type: "identity/logout", sessionRef: current });
  const revive = await fx.service.dispatch({ type: "identity/unlock", sessionRef: current, password: PW });
  cases.push({
    name: "K13 · 已登出的 session 不会被解锁偷偷复活",
    status: revive.ok === false && revive.error === "SESSION_REVOKED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(revive.error),
  });

  cases.push({
    name: "K14 · 域不变量健康",
    status: fx.store.invariants().length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: fx.store.invariants().join("; "),
  });
  fx.cleanup();
}

function hashOf(token) {
  // 与 electron/identity-domain.cjs 的 hashToken 同算法
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

p.cases.push(...cases);
p.assertAll(cases);
const r = p.write();
console.log(`\n== 05-lock-unlock 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
