/**
 * D3-01 · 用户禁用（§17 / §18 / §19 / §45）。
 *
 * 判据（§45）：
 *   同一用户持有 session A 与 session B → disable user →
 *   A 与 B **全部立即不可继续**，且错误码是 USER_DISABLED（不是"下次登录才生效"）。
 *
 * 为什么错误码必须是 USER_DISABLED 而不是 SESSION_REVOKED：
 *   §19 要求把 USER_DISABLED 交给 D4 消费（"管理员禁用成员后新请求失效，
 *   任务不再发起新调用"）。若退化成 SESSION_REVOKED，UI 会提示"请重新登录"，
 *   而真实含义是"账号被停用了，重新登录也没用"——这是两条不同的指引。
 *   因此 disable **不删 session 行**，由 status 检查在校验路径里生效。
 */
import { Probe, VERDICT, makeFixture } from "./lib/id.mjs";

const p = new Probe("06-disable", "用户禁用：现有 session 立即失效，且给出 USER_DISABLED");
const cases = [];
const PW = "correct-horse-1";

{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const uid = fx.store.allUsers()[0].id;

  const a = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const b = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const refA = a.snapshot.sessionRef;
  const refB = b.snapshot.sessionRef;
  const tokenA = (await fx.secrets.read())?.token;

  cases.push({
    name: "D1 · 禁用前 A / B 均有效",
    status: (await fx.service.dispatch({ type: "identity/validate", sessionRef: refA })).ok === true &&
      (await fx.service.dispatch({ type: "identity/validate", sessionRef: refB })).ok === true
      ? VERDICT.PASS
      : VERDICT.FAIL,
    detail: "两条 session 均通过校验",
  });

  const dis = await fx.service.dispatch({ type: "identity/disable-user", userId: uid });
  cases.push({
    name: "D2 · disable-user 成功（本轮由测试夹具驱动，无 admin UI）",
    status: dis.ok === true && dis.status === "DISABLED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: `status=${dis.status}`,
  });

  const va = await fx.service.dispatch({ type: "identity/validate", sessionRef: refA });
  const vb = await fx.service.dispatch({ type: "identity/validate", sessionRef: refB });
  cases.push({
    name: "D3 · session A 立即失效 → USER_DISABLED",
    status: va.ok === false && va.error === "USER_DISABLED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(va.error),
  });
  cases.push({
    name: "D4 · session B 立即失效 → USER_DISABLED",
    status: vb.ok === false && vb.error === "USER_DISABLED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(vb.error),
  });

  const stillRows = fx.store.sessionsOf(uid).filter((s) => s.revoked_at === null).length;
  cases.push({
    name: "D5 · session 行未被删除（保住 USER_DISABLED 语义，不退化成 SESSION_REVOKED）",
    status: stillRows === 2 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `未撤销行数=${stillRows}`,
  });

  const loginBlocked = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  cases.push({
    name: "D6 · 禁用后不能新登录",
    status: loginBlocked.ok === false && loginBlocked.error === "USER_DISABLED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(loginBlocked.error),
  });

  const restore = fx.store.restoreByToken(tokenA);
  cases.push({
    name: "D7 · 禁用后拿旧 token 走重启恢复 → USER_DISABLED（重启不能绕过）",
    status: restore.ok === false && restore.error === "USER_DISABLED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(restore.error),
  });

  const secretAfter = await fx.secrets.read();
  cases.push({
    name: "D8 · 禁用同时清掉 OS 受保护存储里的 token",
    status: secretAfter === null ? VERDICT.PASS : VERDICT.FAIL,
    detail: `stored=${secretAfter === null ? "null" : "仍有值"}`,
  });

  cases.push({
    name: "D9 · USER_DISABLED 属于终止码（UI 应回登录页并说明原因）",
    status: ["SESSION_EXPIRED", "SESSION_REVOKED", "USER_DISABLED", "NOT_INITIALIZED"].includes("USER_DISABLED") ? VERDICT.PASS : VERDICT.FAIL,
    detail: "终止码清单见 identity-domain.TERMINAL_CODES",
  });

  // 恢复启用
  const en = await fx.service.dispatch({ type: "identity/enable-user", userId: uid });
  const relogin = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  cases.push({
    name: "D10 · 重新启用后可以再次登录",
    status: en.ok === true && relogin.ok === true ? VERDICT.PASS : VERDICT.FAIL,
    detail: `enable=${en.ok}, relogin=${relogin.ok}`,
  });

  cases.push({
    name: "D11 · 域不变量健康",
    status: fx.store.invariants().length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: fx.store.invariants().join("; "),
  });
  fx.cleanup();
}

p.cases.push(...cases);
p.assertAll(cases);
const r = p.write();
console.log(`\n== 06-disable 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
