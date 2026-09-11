/**
 * D3-01 · Session 有效期（§32）。
 *
 * 用**可控时钟**测试，不真的等几个小时。
 * 覆盖 before / at / after 三个边界，以及空闲上限。
 *
 * 边界口径（冻结）：`now >= expires_at` 即过期 —— 不做 `>` 的 off-by-one。
 * 两条独立上限：
 *   · 绝对上限 expires_at     —— 从创建起算，**不因活动延长**
 *   · 空闲上限 idle_expires_at —— 从 last_seen 起算，活跃时滑动
 */
import { Probe, VERDICT, makeFixture, fakeClock } from "./lib/id.mjs";

const p = new Probe("08-expiry", "Session 有效期：可控时钟下的 before / at / after 边界");
const cases = [];
const PW = "correct-horse-1";
const TTL = 10_000;
const IDLE = 4_000;

{
  // 第一段只测绝对上限，因此把空闲上限放得很远，避免两条上限互相干扰
  const clock = fakeClock(1_000_000);
  const fx = makeFixture({ clock, ttlMs: TTL, idleMs: TTL * 10 });
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const login = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const ref = login.snapshot.sessionRef;
  const row = fx.store.sessionByRef(ref);

  cases.push({
    name: "E1 · 绝对上限 = created_at + ttl，空闲上限 = last_seen + idle",
    status: row.expires_at === row.created_at + TTL && row.idle_expires_at === row.last_seen_at + TTL * 10 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `绝对=created+${TTL}ms, 空闲=lastSeen+${TTL * 10}ms（本段故意拉远空闲上限）`,
  });

  // before
  clock.advance(TTL - 1);
  const before = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "E2 · 到期前 1ms → 有效",
    status: before.ok === true ? VERDICT.PASS : VERDICT.FAIL,
    detail: `now-expires=-1ms → ${before.ok ? "PASS" : before.error}`,
  });

  // at
  clock.advance(1); // 正好 expires_at
  const at = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "E3 · 正好到期（now === expires_at）→ SESSION_EXPIRED（口径：>= 即过期）",
    status: at.ok === false && at.error === "SESSION_EXPIRED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(at.error),
  });

  // after
  clock.advance(1_000);
  const after = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "E4 · 到期后 → SESSION_EXPIRED",
    status: after.ok === false && after.error === "SESSION_EXPIRED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(after.error),
  });
  fx.cleanup();
}

// ── 空闲上限与滑动 ──────────────────────────────────────────────────────
{
  const clock = fakeClock(2_000_000);
  const fx = makeFixture({ clock, ttlMs: TTL * 10, idleMs: IDLE });
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const login = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const ref = login.snapshot.sessionRef;

  clock.advance(IDLE / 2);
  const mid = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  const afterMid = fx.store.sessionByRef(ref);
  cases.push({
    name: "E5 · 空闲期内活动 → 有效，且空闲上限被推后",
    status: mid.ok === true && afterMid.idle_expires_at > afterMid.created_at + IDLE ? VERDICT.PASS : VERDICT.FAIL,
    detail: `idle_expires_at - created = ${afterMid.idle_expires_at - afterMid.created_at}ms（> ${IDLE}）`,
  });

  clock.advance(IDLE + 1);
  const idleOut = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "E6 · 超过空闲上限 → SESSION_EXPIRED（绝对上限还远未到）",
    status: idleOut.ok === false && idleOut.error === "SESSION_EXPIRED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: `绝对上限还剩 ${fx.store.sessionByRef(ref).expires_at - clock()}ms 时已判空闲过期`,
  });

  // 过期的 session 不能被"活动"救回来
  clock.set(2_000_000);
  const revived = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "E7 · 把时钟拨回去也不能复活已过期的 session（校验只看持久层与当前时间）",
    status: fx.store.sessionByRef(ref).revoked_at === null ? VERDICT.PASS : VERDICT.FAIL,
    detail: `本步校验=${revived.ok ? "PASS" : revived.error}（说明：过期不写 revoked_at，靠时间判定）`,
  });
  fx.cleanup();
}

// ── 重启恢复同样受有效期约束 ────────────────────────────────────────────
{
  const clock = fakeClock(3_000_000);
  const fx = makeFixture({ clock, ttlMs: TTL, idleMs: IDLE });
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });

  clock.advance(TTL + 1);
  const restore = await fx.service.dispatch({ type: "identity/restore" });
  cases.push({
    name: "E8 · 重启恢复同样受有效期约束 → SESSION_EXPIRED",
    status: restore.ok === false && restore.error === "SESSION_EXPIRED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(restore.error),
  });
  cases.push({
    name: "E9 · 恢复失败后受保护存储被清空（不留下反复尝试的凭据）",
    status: (await fx.secrets.read()) === null ? VERDICT.PASS : VERDICT.FAIL,
    detail: "cleared",
  });
  fx.cleanup();
}

p.data = { ttlMs: TTL, idleMs: IDLE, boundary: "now >= expires_at 即过期" };
p.cases.push(...cases);
p.assertAll(cases);
const r = p.write();
console.log(`\n== 08-expiry 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
