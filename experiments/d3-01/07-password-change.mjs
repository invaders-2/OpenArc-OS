/**
 * D3-01 · 修改口令（§21 / §46）。
 *
 * 冻结策略：**authVersion++ 且撤销该用户的全部 session（含当前这条）。**
 * 理由见 electron/identity-store.cjs changePassword 的注释。
 *
 * 判据（§46）：
 *   · 登录取得 session A → 改密
 *   · 旧口令登录 → DENY
 *   · 新口令登录 → PASS
 *   · session A 的行为 → 按冻结策略（全撤销）验证：A 立即失效
 *   · 改密本身必须先验证旧口令（错误旧口令 → DENY）
 */
import { Probe, VERDICT, makeFixture } from "./lib/id.mjs";

const p = new Probe("07-password-change", "修改口令：authVersion 提升并撤销全部旧 session");
const cases = [];
const OLD = "correct-horse-1";
const NEW = "new-horse-password-2";

{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: OLD, displayName: "Admin" });
  const uid = fx.store.allUsers()[0].id;
  const a = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: OLD });
  const refA = a.snapshot.sessionRef;
  const v0 = fx.store.userById(uid).auth_version;

  const wrongOld = await fx.service.dispatch({
    type: "identity/change-password",
    sessionRef: refA,
    currentPassword: "wrong-password-9",
    newPassword: NEW,
  });
  cases.push({
    name: "P1 · 旧口令不对 → DENY（改密必须先验证当前凭据）",
    status: wrongOld.ok === false && wrongOld.error === "INVALID_CREDENTIALS" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(wrongOld.error),
  });

  const shortNew = await fx.service.dispatch({
    type: "identity/change-password",
    sessionRef: refA,
    currentPassword: OLD,
    newPassword: "123",
  });
  cases.push({
    name: "P2 · 新口令过短 → INVALID_INPUT",
    status: shortNew.ok === false && shortNew.error === "INVALID_INPUT" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(shortNew.error),
  });

  const changed = await fx.service.dispatch({
    type: "identity/change-password",
    sessionRef: refA,
    currentPassword: OLD,
    newPassword: NEW,
  });
  cases.push({
    name: "P3 · 改密成功",
    status: changed.ok === true ? VERDICT.PASS : VERDICT.FAIL,
    detail: `revokedAllSessions=${changed.revokedAllSessions}`,
  });

  const v1 = fx.store.userById(uid).auth_version;
  cases.push({
    name: "P4 · authVersion 提升",
    status: v1 === v0 + 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `authVersion ${v0} → ${v1}`,
  });

  const validateA = await fx.service.dispatch({ type: "identity/validate", sessionRef: refA });
  cases.push({
    name: "P5 · 旧 session A 立即失效（冻结策略＝全撤销）",
    status: validateA.ok === false ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(validateA.error),
  });

  const oldLogin = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: OLD });
  cases.push({
    name: "P6 · 旧口令登录 → DENY",
    status: oldLogin.ok === false && oldLogin.error === "INVALID_CREDENTIALS" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(oldLogin.error),
  });

  const newLogin = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: NEW });
  cases.push({
    name: "P7 · 新口令登录 → PASS",
    status: newLogin.ok === true ? VERDICT.PASS : VERDICT.FAIL,
    detail: `ok=${newLogin.ok}`,
  });

  const rows = fx.store.sessionsOf(uid);
  const oldRevoked = rows.filter((s) => s.revoked_at != null && s.revoked_reason === "PASSWORD_CHANGED").length;
  cases.push({
    name: "P8 · 全部旧 session 被撤销且原因可追溯",
    status: oldRevoked >= 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `PASSWORD_CHANGED 撤销数=${oldRevoked}`,
  });

  const hash = fx.store.userById(uid).password_hash;
  cases.push({
    name: "P9 · verifier 是 scrypt 自描述串，不含明文",
    status: /^scrypt\$\d+\$\d+\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/.test(hash) && !hash.includes(NEW) ? VERDICT.PASS : VERDICT.FAIL,
    detail: hash.slice(0, 40) + "…",
  });

  cases.push({
    name: "P10 · 域不变量健康",
    status: fx.store.invariants().length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: fx.store.invariants().join("; "),
  });
  fx.cleanup();
}

// ── 多 session 场景：改密必须一次清掉所有设备 ────────────────────────────
{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: OLD, displayName: "Admin" });
  const uid = fx.store.allUsers()[0].id;
  const s1 = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: OLD });
  const s2 = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: OLD });
  const s3 = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: OLD });

  await fx.service.dispatch({ type: "identity/change-password", sessionRef: s1.snapshot.sessionRef, currentPassword: OLD, newPassword: NEW });
  const results = [s1, s2, s3].map((s) => fx.service.dispatch({ type: "identity/validate", sessionRef: s.snapshot.sessionRef }));
  const denied = (await Promise.all(results)).filter((r) => r.ok === false).length;
  cases.push({
    name: "P11 · 改密一次清掉全部 3 条 session（不是只清当前这条）",
    status: denied === 3 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `失效 ${denied}/3`,
  });
  cases.push({
    name: "P12 · 全局撤销后受保护存储也已清空",
    status: (await fx.secrets.read()) === null ? VERDICT.PASS : VERDICT.FAIL,
    detail: "secrets cleared",
  });
  fx.cleanup();
}

p.cases.push(...cases);
p.assertAll(cases);
const r = p.write();
console.log(`\n== 07-password-change 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
