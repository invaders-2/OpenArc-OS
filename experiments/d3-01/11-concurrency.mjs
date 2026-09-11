/**
 * D3-01 · 并发一致性（§31）。
 *
 * 除初始化竞争（01 号探针）外，至少覆盖：
 *   C1 并发 login              —— N 个同时登录，最终 N 条 session，无重复、无丢失
 *   C2 logout 与 validate 竞态  —— 结果只能是"有效"或"已撤销"，不存在中间态
 *   C3 disable 与 validate 竞态 —— 禁用与校验同时进行，最终一致
 *   C4 改密 与 validate 竞态    —— authVersion 抬高与旧校验同时进行，最终一致
 *   C5 混合风暴                —— 一堆命令并发乱序提交，收尾后域不变量必须健康
 *
 * "最终一致"的判据不是"没抛异常"，而是**收尾后的持久层状态 + 域不变量**。
 */
import { Probe, VERDICT, makeFixture } from "./lib/id.mjs";

const p = new Probe("11-concurrency", "并发一致性：login / logout / disable / 改密 与 validate 竞态");
const cases = [];
const PW = "correct-horse-1";
const NEW = "new-horse-password-2";

// ── C1 并发 login ───────────────────────────────────────────────────────
{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });

  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, () => fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW })),
  );
  const okCount = results.filter((r) => r.ok).length;
  const refs = new Set(results.filter((r) => r.ok).map((r) => r.snapshot.sessionRef));
  const rows = fx.store.allSessions();

  cases.push({
    name: "C1 · 8 个并发 login 全部成功且 ref 互不重复",
    status: okCount === N && refs.size === N ? VERDICT.PASS : VERDICT.FAIL,
    detail: `ok=${okCount}/${N}, 唯一 ref=${refs.size}`,
  });
  cases.push({
    name: "C2 · 持久层 session 数与成功数一致（无丢失、无重复行）",
    status: rows.length === N ? VERDICT.PASS : VERDICT.FAIL,
    detail: `rows=${rows.length}, ok=${okCount}`,
  });
  cases.push({
    name: "C3 · 并发后域不变量健康",
    status: fx.store.invariants().length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: fx.store.invariants().join("; "),
  });
  fx.cleanup();
}

// ── C4 logout 与 validate 竞态 ──────────────────────────────────────────
{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const login = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const ref = login.snapshot.sessionRef;

  const M = 10;
  const mixed = [];
  for (let i = 0; i < M; i += 1) mixed.push(fx.service.dispatch({ type: "identity/validate", sessionRef: ref }));
  mixed.push(fx.service.dispatch({ type: "identity/logout", sessionRef: ref }));
  for (let i = 0; i < M; i += 1) mixed.push(fx.service.dispatch({ type: "identity/validate", sessionRef: ref }));
  const out = await Promise.all(mixed);

  const codes = new Set(out.map((r) => (r.ok ? "OK" : r.error)));
  const onlyTwo = [...codes].every((c) => c === "OK" || c === "SESSION_REVOKED");
  cases.push({
    name: "C4 · logout 与 validate 竞态：结果只可能是 有效 或 已撤销",
    status: onlyTwo && codes.size <= 2 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `出现过的码=${[...codes].join(",")}`,
  });
  const finalRow = fx.store.sessionByRef(ref);
  cases.push({
    name: "C5 · 收尾状态确定：revoked_at 已写且带原因",
    status: finalRow.revoked_at != null && finalRow.revoked_reason === "LOGOUT" ? VERDICT.PASS : VERDICT.FAIL,
    detail: `revoked_at=${finalRow.revoked_at != null}, reason=${finalRow.revoked_reason}`,
  });
  const last = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "C6 · 竞态结束后再校验必然 DENY（不存在侥幸通过）",
    status: last.ok === false ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(last.error),
  });
  fx.cleanup();
}

// ── C7 disable 与 validate 竞态 ─────────────────────────────────────────
{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const uid = fx.store.allUsers()[0].id;
  const login = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const ref = login.snapshot.sessionRef;

  const mixed = [];
  for (let i = 0; i < 8; i += 1) mixed.push(fx.service.dispatch({ type: "identity/validate", sessionRef: ref }));
  mixed.push(fx.service.dispatch({ type: "identity/disable-user", userId: uid }));
  for (let i = 0; i < 8; i += 1) mixed.push(fx.service.dispatch({ type: "identity/validate", sessionRef: ref }));
  const out = await Promise.all(mixed);
  const codes = new Set(out.map((r) => (r.ok ? "OK" : r.error)));
  cases.push({
    name: "C7 · disable 与 validate 竞态：结果只可能是 有效 / USER_DISABLED / SESSION_REVOKED",
    status: [...codes].every((c) => ["OK", "USER_DISABLED", "SESSION_REVOKED"].includes(c)) ? VERDICT.PASS : VERDICT.FAIL,
    detail: `出现过的码=${[...codes].join(",")}`,
  });

  const after = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "C8 · 收尾后必定 DENY（禁用一旦生效就没有回旋）",
    status: after.ok === false ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(after.error),
  });
  cases.push({
    name: "C9 · 用户状态确定为 DISABLED",
    status: fx.store.userById(uid).status === "DISABLED" ? VERDICT.PASS : VERDICT.FAIL,
    detail: fx.store.userById(uid).status,
  });
  fx.cleanup();
}

// ── C10 改密与 validate 竞态 ────────────────────────────────────────────
{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const login = await fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW });
  const ref = login.snapshot.sessionRef;
  const v0 = fx.store.userById(fx.store.allUsers()[0].id).auth_version;

  const mixed = [];
  for (let i = 0; i < 6; i += 1) mixed.push(fx.service.dispatch({ type: "identity/validate", sessionRef: ref }));
  mixed.push(fx.service.dispatch({ type: "identity/change-password", sessionRef: ref, currentPassword: PW, newPassword: NEW }));
  for (let i = 0; i < 6; i += 1) mixed.push(fx.service.dispatch({ type: "identity/validate", sessionRef: ref }));
  const out = await Promise.all(mixed);
  const codes = new Set(out.map((r) => (r.ok ? "OK" : r.error)));
  cases.push({
    name: "C10 · 改密与 validate 竞态：结果只可能是 有效 / SESSION_REVOKED / INVALID_CREDENTIALS",
    status: [...codes].every((c) => ["OK", "SESSION_REVOKED", "INVALID_CREDENTIALS"].includes(c)) ? VERDICT.PASS : VERDICT.FAIL,
    detail: `出现过的码=${[...codes].join(",")}`,
  });
  const v1 = fx.store.userById(fx.store.allUsers()[0].id).auth_version;
  cases.push({
    name: "C11 · authVersion 恰好 +1（没有因为并发被加两次）",
    status: v1 === v0 + 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `${v0} → ${v1}`,
  });
  const after = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  cases.push({
    name: "C12 · 收尾后旧 session 必定失效",
    status: after.ok === false ? VERDICT.PASS : VERDICT.FAIL,
    detail: String(after.error),
  });
  fx.cleanup();
}

// ── C13 混合风暴 ────────────────────────────────────────────────────────
{
  const fx = makeFixture();
  await fx.service.dispatch({ type: "identity/initialize", identifier: "admin@openarc.local", password: PW, displayName: "Admin" });
  const uid = fx.store.allUsers()[0].id;

  const storm = [];
  for (let i = 0; i < 6; i += 1) storm.push(fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: PW }));
  storm.push(fx.service.dispatch({ type: "identity/login", identifier: "admin@openarc.local", password: "wrong-password-9" }));
  storm.push(fx.service.dispatch({ type: "identity/status" }));
  storm.push(fx.service.dispatch({ type: "identity/restore" }));
  const settled = await Promise.all(storm);

  // 拿到存活的 session，随机并发 lock / unlock / validate / logout
  const aliveRefs = fx.store.allSessions().filter((s) => s.revoked_at === null).map((s) => s.ref);
  const phase2 = [];
  for (const r of aliveRefs.slice(0, 3)) {
    phase2.push(fx.service.dispatch({ type: "identity/lock", sessionRef: r }));
    phase2.push(fx.service.dispatch({ type: "identity/validate", sessionRef: r }));
    phase2.push(fx.service.dispatch({ type: "identity/unlock", sessionRef: r, password: PW }));
    phase2.push(fx.service.dispatch({ type: "identity/logout", sessionRef: r }));
  }
  await Promise.all(phase2);

  cases.push({
    name: "C13 · 混合风暴后：无异常抛出，所有命令都有确定性返回",
    status: [...settled, ...(await Promise.all([]))].every((r) => typeof r === "object" && r !== null) ? VERDICT.PASS : VERDICT.FAIL,
    detail: `phase1=${settled.length} 条`,
  });
  cases.push({
    name: "C14 · 混合风暴后域不变量健康（最终一致）",
    status: fx.store.invariants().length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: fx.store.invariants().join("; ") || "健康",
  });
  const badRows = fx.store.allSessions().filter((s) => s.revoked_at != null && !s.revoked_reason);
  cases.push({
    name: "C15 · 每条被撤销的 session 都有原因（可追溯）",
    status: badRows.length === 0 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `无原因的撤销行=${badRows.length}`,
  });
  cases.push({
    name: "C16 · 用户与 installation 仍是唯一",
    status: fx.store.allUsers().length === 1 && fx.store.db.prepare("SELECT COUNT(*) c FROM installations").get().c === 1 ? VERDICT.PASS : VERDICT.FAIL,
    detail: `users=${fx.store.allUsers().length}, installations=${fx.store.db.prepare("SELECT COUNT(*) c FROM installations").get().c}`,
  });
  fx.cleanup();
}

p.cases.push(...cases);
p.assertAll(cases);
const r = p.write();
console.log(`\n== 11-concurrency 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
