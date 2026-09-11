/**
 * D3-01 · Logout（§13 / §44）。
 *
 * 判据（§44）：
 *   取得 session A → logout A → 之后
 *     · validate(A)         必须 DENY
 *     · 受保护命令(A)       必须 DENY
 *     · restore(A 的 token) 必须 DENY
 *   **仅 UI 返回登录页不算完成**，必须是持久层里的真实撤销。
 */
import { Probe, VERDICT, makeFixture } from "./lib/id.mjs";

const p = new Probe("04-logout", "登出：session 真实撤销，不是跳回登录页");
const cases = [];
const PW = "correct-horse-1";

{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const login = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const ref = login.snapshot.sessionRef;
  const token = (await fx.secrets.read())?.token;

  const before = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "O1 · 登出前 session 有效",
    status: before.ok === true ? VERDICT.PASS : VERDICT.FAIL,
    detail: `valid=${before.valid}`,
  });

  const out = await fx.service.dispatch({ type: "identity/logout", sessionRef: ref });
  cases.push({
    name: "O2 · logout 成功",
    status: out.ok === true ? VERDICT.PASS : VERDICT.FAIL,
    detail: `ok=${out.ok}`,
  });

  const after = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "O3 · 登出后 validate(A) → DENY",
    status: after.ok === false && after.error === "SESSION_REVOKED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(after.error),
  });

  const row = fx.store.sessionByRef(ref);
  cases.push({
    name: "O4 · 持久层里真的写了 revoked_at / revoked_reason（不是 UI 假动作）",
    status: row && row.revoked_at != null && row.revoked_reason === "LOGOUT" ? VERDICT.PASS : VERDICT.FAIL,
    detail: `revoked_at=${row?.revoked_at}, reason=${row?.revoked_reason}`,
  });

  // 用旧 token 尝试"重启恢复"
  const byToken = fx.store.restoreByToken(token);
  cases.push({
    name: "O5 · 拿着已被登出的 token 走重启恢复 → DENY",
    status: byToken.ok === false ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(byToken.error),
  });

  const secretAfter = await fx.secrets.read();
  cases.push({
    name: "O6 · OS 受保护存储里的 token 已清除（重启不能复活）",
    status: secretAfter === null ? VERDICT.PASS : VERDICT.FAIL,
    detail: `stored=${secretAfter === null ? "null" : "仍有值"}`,
  });

  const restore = await fx.service.dispatch({ type: "identity/restore" });
  cases.push({
    name: "O7 · 登出后 identity/restore → DENY（不带任何身份信息）",
    status: restore.ok === false ? VERDICT.PASS : VERDICT.FAIL,
    detail: `${restore.error}${restore.snapshot ? " 且带回了快照（不允许）" : ""}`,
  });

  // 登出不影响别人
  const other = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const second = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  await fx.service.dispatch({ type: "identity/logout", sessionRef: other.snapshot.sessionRef });
  const stillOk = await fx.service.dispatch({ type: "identity/validate", sessionRef: second.snapshot.sessionRef });
  cases.push({
    name: "O8 · 登出一条 session 不影响另一条",
    status: stillOk.ok === true ? VERDICT.PASS : VERDICT.FAIL,
    detail: `另一条=${stillOk.ok ? "仍有效" : stillOk.error}`,
  });

  const twice = await fx.service.dispatch({ type: "identity/logout", sessionRef: other.snapshot.sessionRef });
  cases.push({
    name: "O9 · 重复登出同一条 → DENY（不掩盖「已经失效」这个事实）",
    status: twice.ok === false && twice.error === "SESSION_REVOKED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(twice.error),
  });

  cases.push({
    name: "O10 · 域不变量健康",
    status: fx.store.invariants().length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: fx.store.invariants().join("; "),
  });
  fx.cleanup();
}

p.cases.push(...cases);
p.assertAll(cases);
const r = p.write();
console.log(`\n== 04-logout 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
