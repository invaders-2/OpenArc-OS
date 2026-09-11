/**
 * D3-01 · 登录（§12 / §33）。
 *
 * 判据：
 *   · 正确凭据 → 建 session，返回可用快照
 *   · 错误口令 / 不存在标识符 → **同一个** INVALID_CREDENTIALS（不泄漏账号是否存在）
 *   · 两者耗时同量级（不存在即返回会构成时间侧信道）
 *   · identifier 归一化（大小写 / 前后空白不影响唯一性）
 *   · 禁用用户：口令正确才报 USER_DISABLED（顺序不能反）
 *   · 限流：连续失败进入冷却，成功即清零；**永不永久封锁**
 */
import { Probe, VERDICT, makeFixture, bootstrap } from "./lib/id.mjs";

const p = new Probe("02-login", "登录：凭据校验、错误统一、限流退避");
const cases = [];
const PW = "correct-horse-1";

{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "Admin@OpenArc.local", password: PW, displayName: "Admin" });

  const ok = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  cases.push({
    name: "L1 · 正确凭据登录成功并返回快照",
    status: ok.ok && ok.snapshot?.sessionRef ? VERDICT.PASS : VERDICT.FAIL,
    detail: `ok=${!!ok.ok}, ref=${ok.snapshot?.sessionRef ? "有" : "无"}, role=${ok.snapshot?.role}`,
  });
  cases.push({
    name: "L2 · 归一化生效：初始化用 Admin@… 登录用 admin@…",
    status: ok.ok ? VERDICT.PASS : VERDICT.FAIL,
    detail: `identifier=${fx.store.allUsers()[0]?.identifier}`,
  });

  const loggedInRef = ok.snapshot.sessionRef;
  await fx.service.dispatch({ type: "identity/logout", sessionRef: loggedInRef });

  const wrong = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: "wrong-password-9" });
  const missing = await fx.service.dispatch({ type: "identity/login", identifier: "nobody@openarc.local", password: "wrong-password-9" });
  cases.push({
    name: "L3 · 口令错误与标识符不存在返回同一个错误码",
    status: wrong.error === "INVALID_CREDENTIALS" && missing.error === "INVALID_CREDENTIALS" ? VERDICT.PASS : VERDICT.FAIL,
    detail: `wrong=${wrong.error}, missing=${missing.error}`,
  });
  cases.push({
    name: "L4 · 两者都没有回传任何用户字段（不存在枚举）",
    status: !wrong.userId && !missing.userId && !wrong.snapshot && !missing.snapshot ? VERDICT.PASS : VERDICT.FAIL,
    detail: `wrongKeys=${Object.keys(wrong).join(",")}`,
  });

  // 时间侧信道：两条路径都必须跑满一次 KDF
  const t0 = process.hrtime.bigint();
  await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: "wrong-password-9" });
  const tWrong = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  await fx.service.dispatch({ type: "identity/login", identifier: "nobody@openarc.local", password: "wrong-password-9" });
  const tMissing = Number(process.hrtime.bigint() - t1) / 1e6;
  const ratio = Math.max(tWrong, tMissing) / Math.max(1, Math.min(tWrong, tMissing));
  cases.push({
    name: "L5 · 两条失败路径耗时同量级（不存在即返回会构成侧信道）",
    status: ratio < 3 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `wrong=${tWrong.toFixed(1)}ms, missing=${tMissing.toFixed(1)}ms, ratio=${ratio.toFixed(2)}`,
  });

  // 禁用用户：错误口令仍报 INVALID_CREDENTIALS，正确口令才报 USER_DISABLED
  const uid = fx.store.allUsers()[0].id;
  await fx.service.dispatch({ type: "identity/disable-user", userId: uid });
  const disabledWrongPw = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: "wrong-password-9" });
  const disabledRightPw = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  cases.push({
    name: "L6 · 禁用用户 + 错口令 → INVALID_CREDENTIALS（不提前暴露账号状态）",
    status: disabledWrongPw.error === "INVALID_CREDENTIALS" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(disabledWrongPw.error),
  });
  cases.push({
    name: "L7 · 禁用用户 + 对口令牌 → USER_DISABLED",
    status: disabledRightPw.error === "USER_DISABLED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(disabledRightPw.error),
  });
  await fx.service.dispatch({ type: "identity/enable-user", userId: uid });
  fx.cleanup();
}

// ── 限流 ────────────────────────────────────────────────────────────────
{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });

  const results = [];
  for (let i = 0; i < 12; i += 1) {
    results.push(await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: "wrong-password-9" }));
  }
  const firstEight = results.slice(0, 8).filter((r) => r.error === "INVALID_CREDENTIALS").length;
  const throttled = results.filter((r) => r.error === "RATE_LIMITED").length;
  cases.push({
    name: "L8 · 前 8 次失败仍报 INVALID_CREDENTIALS（阈值不是 5 次永久锁）",
    status: firstEight === 8 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `前 8 次中 INVALID_CREDENTIALS=${firstEight}`,
  });
  cases.push({
    name: "L9 · 超过阈值后进入冷却而不是永久封锁",
    status: throttled > 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `RATE_LIMITED=${throttled}/12`,
  });

  const attemptRow = fx.store.db.prepare("SELECT * FROM login_attempts").all()[0];
  const cooldownMs = attemptRow ? attemptRow.cooldown_until - attemptRow.last_failure_at : 0;
  cases.push({
    name: "L10 · 冷却时长有上限（<= 60s），不是永久锁",
    status: cooldownMs > 0 && cooldownMs <= 60_000 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `cooldown=${cooldownMs}ms, failures=${attemptRow?.failures}`,
  });

  // 冷却随时间衰减：把时钟往前推，冷却应当解除
  fx.store.db.prepare("UPDATE login_attempts SET last_failure_at = ?, cooldown_until = ?").run(0, 0);
  const again = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: "wrong-password-9" });
  cases.push({
    name: "L11 · 冷却过期后恢复可尝试（可自愈，不需管理员介入）",
    status: again.error === "INVALID_CREDENTIALS" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(again.error),
  });

  const success = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const after = fx.store.db.prepare("SELECT * FROM login_attempts").all()[0];
  cases.push({
    name: "L12 · 登录成功清零失败计数",
    status: success.ok && after.failures === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `ok=${!!success.ok}, failures=${after?.failures}`,
  });
  fx.cleanup();
}

// ── 输入校验 ────────────────────────────────────────────────────────────
{
  const fx = makeFixture();
  const noInit = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  cases.push({
    name: "L13 · 未初始化时登录 → NOT_INITIALIZED",
    status: noInit.error === "NOT_INITIALIZED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(noInit.error),
  });

  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const empty = await fx.service.dispatch({ type: "identity/login", identifier: "   ", password: PW });
  cases.push({
    name: "L14 · 空标识符 → INVALID_INPUT",
    status: empty.error === "INVALID_INPUT" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(empty.error),
  });
  const unknown = await fx.service.dispatch({ type: "identity/whatever" });
  cases.push({
    name: "L15 · 未知命令 → INVALID_INPUT（命令层白名单）",
    status: unknown.error === "INVALID_INPUT" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(unknown.error),
  });
  fx.cleanup();
}

p.cases.push(...cases);
p.assertAll(cases);
const r = p.write();
console.log(`\n== 02-login 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
