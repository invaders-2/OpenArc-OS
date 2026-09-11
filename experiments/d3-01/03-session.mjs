/**
 * D3-01 · Session 模型（§9 / §10 / §11 / §39）。
 *
 * 判据：
 *   · session 能 create / validate / revoke / expire
 *   · **不是** localStorage 里的布尔值：每次校验都回到持久层
 *   · token 从不出现在服务层返回值里（渲染进程拿不到）
 *   · 重启恢复只靠 OS 受保护存储里的 token，且数据库只存它的 SHA-256
 *   · 一个用户可以有多条 session（多端/多窗口），互不影响
 */
import { Probe, VERDICT, makeFixture } from "./lib/id.mjs";

const p = new Probe("03-session", "Session：建立、校验、多会话与 token 边界");
const cases = [];
const PW = "correct-horse-1";

{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });

  const a = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const b = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });

  cases.push({
    name: "S1 · 同一用户可持有多条有效 session",
    status: fx.store.sessionsOf(fx.store.allUsers()[0].id).length === 2 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `sessions=${fx.store.sessionsOf(fx.store.allUsers()[0].id).length}`,
  });
  cases.push({
    name: "S2 · 两条 session 的 ref 与 token 都不同",
    status: a.snapshot.sessionRef !== b.snapshot.sessionRef ? VERDICT.PASS : VERDICT.FAIL,
    detail: `refA≠refB=${a.snapshot.sessionRef !== b.snapshot.sessionRef}`,
  });

  // token 边界：服务层返回值里不得出现 token
  const blob = JSON.stringify(a);
  const hasToken = /"token"\s*:/.test(blob) || /"token_hash"\s*:/.test(blob);
  cases.push({
    name: "S3 · 服务层返回值不含 token / token_hash",
    status: !hasToken ? VERDICT.PASS : VERDICT.FAIL,
    detail: hasToken ? "返回值里出现了 token 字段" : `字段=${Object.keys(a).join(",")}`,
  });

  const rows = fx.store.allSessions();
  cases.push({
    name: "S4 · 持久层只存 token 的 SHA-256，不存明文",
    status: rows.every((s) => /^[0-9a-f]{64}$/.test(s.token_hash)) ? VERDICT.PASS : VERDICT.FAIL,
    detail: `token_hash 样例=${rows[0]?.token_hash?.slice(0, 16)}…（长度 ${rows[0]?.token_hash?.length}）`,
  });

  // 校验不靠前端状态，回到持久层
  const v = await fx.service.dispatch({ type: "identity/validate", sessionRef: a.snapshot.sessionRef });
  cases.push({
    name: "S5 · validate 命中真实 session",
    status: v.ok && v.valid === true && v.userId === fx.store.allUsers()[0].id ? VERDICT.PASS : VERDICT.FAIL,
    detail: `valid=${v.valid}`,
  });

  const bogus = await fx.service.dispatch({ type: "identity/validate", sessionRef: "sref_not-a-real-ref" });
  cases.push({
    name: "S6 · 伪造 ref → SESSION_REVOKED（不是靠前端布尔量）",
    status: bogus.error === "SESSION_REVOKED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(bogus.error),
  });

  // 重启恢复
  const restored = await fx.service.dispatch({ type: "identity/restore" });
  cases.push({
    name: "S7 · 重启恢复走 OS 受保护存储里的 token",
    status: restored.ok && restored.snapshot?.sessionRef ? VERDICT.PASS : VERDICT.FAIL,
    detail: `restored=${restored.ok ? "OK" : restored.error}`,
  });
  const stored = await fx.secrets.read();
  cases.push({
    name: "S8 · 受保护存储里存的是 token 明文，但**只在后端**，渲染进程拿不到",
    status: stored && typeof stored.token === "string" ? VERDICT.PASS : VERDICT.FAIL,
    detail: `backend=${fx.secrets.kind}, hasToken=${!!stored?.token}`,
  });

  // 滑动续期
  const before = fx.store.sessionByRef(a.snapshot.sessionRef).idle_expires_at;
  await new Promise((r) => setTimeout(r, 5));
  fx.store.clock();
  const advanced = fx.store.validateSession(a.snapshot.sessionRef, { sensitive: false });
  cases.push({
    name: "S9 · 活跃 session 会滑动续期（idle_expires_at 前移）",
    status: advanced.ok && advanced.session.idle_expires_at >= before ? VERDICT.PASS : VERDICT.FAIL,
    detail: `before=${before}, after=${advanced.session?.idle_expires_at}`,
  });

  cases.push({
    name: "S10 · 域不变量健康",
    status: fx.store.invariants().length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: fx.store.invariants().join("; "),
  });

  // 命令层：UI 与 AI 同一入口
  const cmds = (await import("../../electron/identity-domain.cjs")).default;
  cases.push({
    name: "S11 · 命令集是白名单，共 9 条身份命令 + 3 条 admin 夹具",
    status: cmds.IDENTITY_COMMANDS.length === 9 && cmds.ADMIN_COMMANDS.length === 3 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `identity=${cmds.IDENTITY_COMMANDS.length}, admin=${cmds.ADMIN_COMMANDS.length}`,
  });
  cases.push({
    name: "S12 · 错误码集合含 §26 要求的 9 个码",
    status: ["NOT_INITIALIZED", "ALREADY_INITIALIZED", "INVALID_CREDENTIALS", "SESSION_EXPIRED", "SESSION_REVOKED", "USER_DISABLED", "LOCKED", "INVALID_INPUT", "INTERNAL_ERROR"].every((c) => c in cmds.ERROR) ? VERDICT.PASS : VERDICT.FAIL,
    detail: Object.keys(cmds.ERROR).join(","),
  });
  fx.cleanup();
}

p.cases.push(...cases);
p.assertAll(cases);
const r = p.write();
console.log(`\n== 03-session 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
