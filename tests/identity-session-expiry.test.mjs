/**
 * D5-03 第四批 · 会话自然到期的权威调度（身份侧）。
 *
 * 测的是产品那条线：真实 IdentityStore + 真实 IdentityService（identity-bootstrap
 * 里装配的同一个类），只有时钟与定时器可注入。
 *
 * 覆盖：
 *   · 空闲到期 / 绝对到期 → 落终态 + 新事件（一次）
 *   · 合法活动延长空闲 → 到点前触发只重排，不关任何东西
 *   · 旧会话到期不得关掉随后登录的新会话
 *   · 到期与懒判定同一套判据（同一个码、同一条终结路径）
 *   · 幂等：重复触发只终结一次、只 emit 一次；已终结会话再排程不复活
 *   · 单一定时器（在途 ≤ 1）+ 无 setInterval
 *   · 短有效期覆写的三种情形；默认路径（不注入）一个字节都不变
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeTimers } from "./session-expiry-fixtures.mjs";

const require = createRequire(import.meta.url);
const { IdentityStore, DEFAULT_TTL_MS, DEFAULT_IDLE_MS, SCHEMA_VERSION } = require("../electron/identity-store.cjs");
const { IdentityService } = require("../electron/identity-service.cjs");
const { IdentityLogger } = require("../electron/identity-log.cjs");
const { SessionSecretStore, memoryBackend } = require("../electron/session-secret-store.cjs");
const { createIdentityService, resolveSessionTtlOverride, SESSION_TTL_OVERRIDE } = require("../electron/identity-bootstrap.cjs");
const domain = require("../electron/identity-domain.cjs");

const PW = "correct-horse-1";
const START = 1_700_000_000_000;
const dirs = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d5-03-expiry-"));
  dirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** 可控时钟 + 可控定时器 + 事件记录的真实 store / service。 */
function fixture({ ttlMs, idleMs } = {}) {
  let current = START;
  const clock = () => current;
  const timers = fakeTimers();
  const logger = new IdentityLogger();
  const store = new IdentityStore({ path: ":memory:", clock, ttlMs, idleMs, onAudit: (r) => logger.log(r) }).open();
  const secrets = new SessionSecretStore(memoryBackend());
  const service = new IdentityService({ store, secrets, logger, allowAdmin: true, timers });
  const events = [];
  service.onEvent((e) => events.push(e));
  return {
    store,
    service,
    secrets,
    logger,
    timers,
    events,
    now: () => current,
    advance: (ms) => {
      current += ms;
      return current;
    },
    expired: () => events.filter((e) => e.event === domain.EVENT.SESSION_EXPIRED),
    async login(identifier = "a@b.local", password = PW) {
      const init = await service.dispatch({ type: "identity/initialize", identifier, password, displayName: "A" });
      if (!init.ok && init.error !== "ALREADY_INITIALIZED") throw new Error("initialize failed: " + JSON.stringify(init));
      const res = await service.dispatch({ type: "identity/login", identifier, password });
      assert.equal(res.ok, true, JSON.stringify(res));
      return res.snapshot.sessionRef;
    },
  };
}

const countExpiryAudit = (fx) => fx.store.auditLog().filter((r) => r.event === "expire");

test("E1 · 空闲到期：登录后排一次定时器（unref），到点落终态并 emit 一次", async () => {
  const fx = fixture({ ttlMs: 60_000, idleMs: 5_000 });
  const ref = await fx.login();

  assert.equal(fx.timers.pending(), 1, "登录后必须恰好有一个在途到期定时器");
  assert.equal(fx.timers.state.lastDelayMs, 5_000, "dueAt = min(expires_at, idle_expires_at) = 空闲上限");
  assert.equal(fx.timers.state.unrefCalls >= 1, true, "定时器必须 unref：进程退出不被它挡住");
  assert.equal(fx.timers.state.intervalCalls, 0, "禁止 setInterval");
  assert.equal(await fx.secrets.read() !== null, true, "登录后 token 在受保护存储里");

  fx.advance(5_000);
  await fx.timers.fire();

  const row = fx.store.sessionByRef(ref);
  assert.notEqual(row.revoked_at, null, "到期必须落成权威事实（事务路径写终态）");
  assert.equal(row.revoked_reason, domain.REVOKE_REASON.EXPIRED);
  assert.equal(fx.expired().length, 1, "只 emit 一次");
  assert.equal(fx.expired()[0].reason, "idle");
  assert.equal(fx.expired()[0].sessionId, row.id, "payload 必须带会话标识");
  assert.equal(fx.expired()[0].sessionRef, ref);
  assert.equal(fx.service.current, null, "到期后服务层不得再持有这条会话");
  assert.equal(await fx.secrets.read(), null, "到期后受保护存储里的 token 必须清掉");
  assert.equal(fx.timers.pending(), 0, "终结后不得留任何到期安排");
  assert.equal(countExpiryAudit(fx).length, 1, "审计里恰好一条 expire");
  assert.deepEqual(fx.store.invariants(), []);
});

test("E2 · 合法活动延长空闲：到点前触发只重排，真到点才终结", async () => {
  const fx = fixture({ ttlMs: 600_000, idleMs: 10_000 });
  const ref = await fx.login();
  assert.equal(fx.timers.state.lastDelayMs, 10_000);

  fx.advance(6_000);
  const touched = await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  assert.equal(touched.ok, true, JSON.stringify(touched));
  assert.equal(fx.store.sessionByRef(ref).idle_expires_at, fx.now() + 10_000, "合法活动把空闲期限延长了");
  assert.equal(fx.timers.state.lastDelayMs, 10_000, "重排的是权威行，不是内存里的旧时间戳");
  assert.equal(fx.timers.pending(), 1);

  // 定时器提前触发（时钟还没到 dueAt）：以权威行为准 —— 只重排，不关任何东西
  await fx.timers.fire();
  assert.equal(fx.expired().length, 0, "没到点不得 emit");
  assert.equal(fx.store.sessionByRef(ref).revoked_at, null, "没到点不得写终态");
  assert.equal(fx.service.current, ref, "没到点不得把会话收掉");
  assert.notEqual(await fx.secrets.read(), null);
  assert.equal(fx.timers.pending(), 1, "只重排：仍然只有一个在途定时器");
  assert.equal(fx.timers.state.lastDelayMs, 10_000);

  // 真正到点
  fx.advance(10_000);
  await fx.timers.fire();
  assert.equal(fx.expired().length, 1);
  assert.equal(fx.expired()[0].reason, "idle");
  assert.equal(fx.store.sessionByRef(ref).revoked_reason, domain.REVOKE_REASON.EXPIRED);
});

test("E3 · 旧会话到期不关随后登录的新会话（旧回调已出队也一样）", async () => {
  const fx = fixture({ ttlMs: 600_000, idleMs: 8_000 });
  const firstRef = await fx.login();
  const stale = fx.timers.history[fx.timers.history.length - 1];
  assert.equal(stale.cleared, false);

  const second = await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW });
  assert.equal(second.ok, true, JSON.stringify(second));
  const secondRef = second.snapshot.sessionRef;
  assert.notEqual(secondRef, firstRef, "重新登录必须是一条新会话");
  assert.equal(stale.cleared, true, "重新登录后旧安排必须被取消");
  assert.equal(fx.timers.pending(), 1, "仍然只有一个在途定时器（新会话的）");

  // 旧回调即使真的被调用（clearTimeout 拦不住已经出队的那一个）：什么都不做
  fx.advance(8_000);
  await stale.fn();
  await fx.timers.settle();

  assert.equal(fx.expired().length, 0, "旧到期不得 emit");
  assert.equal(fx.store.sessionByRef(firstRef).revoked_at, null, "旧到期不得去动别的世代");
  assert.equal(fx.store.sessionByRef(secondRef).revoked_at, null, "旧到期不得终结新会话");
  assert.equal(fx.service.current, secondRef);
  assert.equal(fx.timers.pending(), 1, "新会话自己的安排不受影响");
});

test("E4 · 绝对到期：ttl 先到 → reason=absolute", async () => {
  const fx = fixture({ ttlMs: 6_000, idleMs: 60_000 });
  const ref = await fx.login();
  assert.equal(fx.timers.state.lastDelayMs, 6_000, "起约束作用的是绝对上限");

  fx.advance(6_000);
  await fx.timers.fire();

  assert.equal(fx.expired().length, 1);
  assert.equal(fx.expired()[0].reason, "absolute");
  assert.equal(fx.store.sessionByRef(ref).revoked_reason, domain.REVOKE_REASON.EXPIRED);
});

test("E5 · 到期与懒判定同一套判据：两条路径同一个码、同一条终结", async () => {
  const byTimer = fixture({ ttlMs: 60_000, idleMs: 5_000 });
  const timerRef = await byTimer.login();
  byTimer.advance(5_000);
  await byTimer.timers.fire();
  const timerVerdict = await byTimer.service.dispatch({ type: "identity/validate", sessionRef: timerRef });

  const byLazy = fixture({ ttlMs: 60_000, idleMs: 5_000 });
  const lazyRef = await byLazy.login();
  byLazy.advance(5_000);
  const lazyVerdict = await byLazy.service.dispatch({ type: "identity/validate", sessionRef: lazyRef });
  await byLazy.timers.settle();

  assert.equal(timerVerdict.error, "SESSION_EXPIRED");
  assert.equal(lazyVerdict.error, "SESSION_EXPIRED", "命令层不得还认它有效");
  assert.equal(timerVerdict.error, lazyVerdict.error, "定时器路径与懒判定路径必须是同一个码");
  assert.equal(timerVerdict.detail, lazyVerdict.detail);

  // 懒判定看到的到期同样落权威终态、同样只 emit 一次、同样不留安排
  assert.equal(byLazy.store.sessionByRef(lazyRef).revoked_reason, domain.REVOKE_REASON.EXPIRED);
  assert.equal(byLazy.expired().length, 1);
  assert.equal(byLazy.timers.pending(), 0);
  assert.equal(byLazy.service.current, null);

  // 终态之后两条路径的判据仍然一致（都是 SESSION_EXPIRED，不是 SESSION_REVOKED）
  assert.equal(domain.evaluateSession(byTimer.store.sessionByRef(timerRef), byTimer.store.allUsers()[0], byTimer.now()).detail, "idle-expiry");
  assert.equal(domain.evaluateSession(byLazy.store.sessionByRef(lazyRef), byLazy.store.allUsers()[0], byLazy.now()).detail, "idle-expiry");
});

test("E6 · 幂等：重复触发只终结一次、只 emit 一次；对已终结会话再排程不复活", async () => {
  const fx = fixture({ ttlMs: 60_000, idleMs: 4_000 });
  const ref = await fx.login();
  const job = fx.timers.history[fx.timers.history.length - 1];

  fx.advance(4_000);
  await fx.timers.fire();
  assert.equal(fx.expired().length, 1);

  // 同一个回调再触发一次（已经出队的那一个同样算）
  await job.fn();
  await fx.timers.settle();
  assert.equal(fx.expired().length, 1, "重复触发不得 emit 第二次");
  assert.equal(countExpiryAudit(fx).length, 1, "重复触发不得写第二条终态审计");

  // 直接再走一次 store 的终态路径：已经终结的会话不复活、也不再改任何东西
  const again = await fx.store.expireSession(ref, fx.now());
  assert.equal(again.changed, false);
  assert.equal(again.reason, "ended");
  assert.equal(fx.store.sessionByRef(ref).revoked_reason, domain.REVOKE_REASON.EXPIRED);

  // 拿着已终结的 ref 再排程（模拟"又把它设成当前会话"）：不得复活、也不得留安排
  fx.service.current = ref;
  const status = await fx.service.dispatch({ type: "identity/status" });
  assert.equal(status.ok, true);
  assert.equal(fx.timers.pending(), 0, "已终结会话不得再排到期");
  assert.equal(fx.service.current, null);
  assert.equal(fx.expired().length, 1);
});

test("E7 · 单一定时器：各命令后在途定时器 ≤ 1，且从不使用 setInterval", async () => {
  const fx = fixture({ ttlMs: 600_000, idleMs: 30_000 });
  const ref = await fx.login();
  const seen = [fx.timers.pending()];
  const check = () => {
    assert.equal(fx.timers.pending() <= 1, true, "同一时刻在途定时器必须 ≤ 1，当前 " + fx.timers.pending());
    seen.push(fx.timers.pending());
  };

  await fx.service.dispatch({ type: "identity/status" });
  check();
  await fx.service.dispatch({ type: "identity/validate", sessionRef: ref });
  check();
  await fx.service.dispatch({ type: "identity/lock" });
  check();
  const unlocked = await fx.service.dispatch({ type: "identity/unlock", password: PW });
  assert.equal(unlocked.ok, true, JSON.stringify(unlocked));
  check();
  await fx.service.dispatch({ type: "identity/update-profile", displayName: "A2" });
  check();

  const changed = await fx.service.dispatch({ type: "identity/change-password", currentPassword: PW, newPassword: "new-horse-2" });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(fx.timers.pending(), 0, "改密撤销全部会话后不得留到期安排");

  const again = await fx.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: "new-horse-2" });
  assert.equal(again.ok, true, JSON.stringify(again));
  check();
  await fx.service.dispatch({ type: "identity/logout" });
  assert.equal(fx.timers.pending(), 0, "登出后不得留到期安排");

  assert.equal(fx.timers.state.intervalCalls, 0, "全流程没有一次 setInterval");
  assert.equal(fx.timers.state.unrefCalls, fx.timers.state.setCalls, "每个定时器都必须 unref");
  assert.equal(Math.max(...seen) <= 1, true);
});

test("E8 · 覆写解析：缺 ack / 值非法 / 合法 三种情形，非法一律忽略", () => {
  // ① 什么都没给：默认路径，连日志都不产生
  assert.deepEqual(resolveSessionTtlOverride({ env: {} }), { applied: false, records: [] });

  // ② 只给值、不给 ack 开关 → 忽略并留痕
  const noAck = resolveSessionTtlOverride({ env: { OPENARC_SESSION_IDLE_MS: "3000" } });
  assert.equal(noAck.applied, false);
  assert.equal(noAck.sessionIdleMs, undefined);
  assert.equal(noAck.records.length, 1);
  assert.equal(noAck.records[0].result, "DENY");
  assert.equal(noAck.records[0].error_code, "OVERRIDE_NOT_ACKNOWLEDGED");
  assert.equal(noAck.records[0].message.includes(SESSION_TTL_OVERRIDE.ACK_ENV), true);

  // ③ 给了 ack 但值非法（非整数 / 低于下限 / 负数 / 科学计数）→ 忽略并留痕
  for (const bad of ["abc", "2000.5", "1e4", "-5000", "1999", "  ", "0x10", "999999999999999999999999"]) {
    const res = resolveSessionTtlOverride({ env: { [SESSION_TTL_OVERRIDE.ACK_ENV]: "1", [SESSION_TTL_OVERRIDE.IDLE_ENV]: bad } });
    assert.equal(res.applied, false, "非法值必须忽略：" + JSON.stringify(bad));
    assert.equal(res.sessionIdleMs, undefined);
    if (bad.trim() === "") {
      assert.deepEqual(res.records, [], "空值等于没给：" + JSON.stringify(bad));
      continue;
    }
    assert.equal(res.records[0].result, "DENY");
    assert.equal(res.records[0].error_code, "OVERRIDE_VALUE_INVALID", JSON.stringify(res.records[0]));
  }

  // ④ 合法：恰好下限可以，值原样生效，日志含生效值与原因
  const okMin = resolveSessionTtlOverride({ env: { [SESSION_TTL_OVERRIDE.ACK_ENV]: "1", [SESSION_TTL_OVERRIDE.IDLE_ENV]: String(SESSION_TTL_OVERRIDE.MIN_MS) } });
  assert.equal(okMin.applied, true);
  assert.equal(okMin.sessionIdleMs, SESSION_TTL_OVERRIDE.MIN_MS);
  assert.equal(okMin.sessionTtlMs, undefined, "没给的那一项必须继续走默认");

  const both = resolveSessionTtlOverride({ env: { [SESSION_TTL_OVERRIDE.ACK_ENV]: "1", [SESSION_TTL_OVERRIDE.IDLE_ENV]: "30000", [SESSION_TTL_OVERRIDE.TTL_ENV]: "120000" } });
  assert.equal(both.applied, true);
  assert.equal(both.sessionIdleMs, 30000);
  assert.equal(both.sessionTtlMs, 120000);
  assert.equal(both.records[0].result, "OK");
  assert.equal(both.records[0].message.includes("30000"), true);
  assert.equal(both.records[0].message.includes("120000"), true);
  assert.equal(both.records[0].message.includes("非产品默认值"), true, "生效日志必须让人一眼看出不是默认值");

  // ⑤ ack 值不是 1 → 仍然不算承认
  const wrongAck = resolveSessionTtlOverride({ env: { [SESSION_TTL_OVERRIDE.ACK_ENV]: "true", [SESSION_TTL_OVERRIDE.IDLE_ENV]: "3000" } });
  assert.equal(wrongAck.applied, false);
});

test("E9 · 默认路径未变：不注入时仍走 DEFAULT_TTL_MS / DEFAULT_IDLE_MS，schema 仍 21", async () => {
  assert.equal(SCHEMA_VERSION, 30, "当前真实版本 v28");

  // 只给值、不给 ack 开关：解析结果为空 → 装配层拿到的仍是默认
  const ignored = resolveSessionTtlOverride({ env: { OPENARC_SESSION_IDLE_MS: "3000" } });
  const boot = createIdentityService({ userDataDir: tempDir(), safeStorage: null, sessionTtlMs: ignored.sessionTtlMs, sessionIdleMs: ignored.sessionIdleMs });
  try {
    assert.equal(boot.store.ttlMs, DEFAULT_TTL_MS);
    assert.equal(boot.store.idleMs, DEFAULT_IDLE_MS);
    assert.equal(boot.store.schemaVersion, 30);

    await boot.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
    const login = await boot.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW });
    assert.equal(login.ok, true, JSON.stringify(login));
    const row = boot.store.sessionByRef(login.snapshot.sessionRef);
    assert.equal(row.expires_at - row.created_at, DEFAULT_TTL_MS, "默认绝对有效期一个字节都没变");
    assert.equal(row.idle_expires_at - row.created_at, DEFAULT_IDLE_MS, "默认空闲有效期一个字节都没变");
  } finally {
    boot.store.close();
  }

  // 给了 ack 但值非法：同样忽略并回默认
  const bad = resolveSessionTtlOverride({ env: { OPENARC_ALLOW_SESSION_TTL_OVERRIDE: "1", OPENARC_SESSION_IDLE_MS: "500" } });
  const boot2 = createIdentityService({ userDataDir: tempDir(), safeStorage: null, sessionTtlMs: bad.sessionTtlMs, sessionIdleMs: bad.sessionIdleMs });
  try {
    assert.equal(bad.applied, false);
    assert.equal(boot2.store.idleMs, DEFAULT_IDLE_MS);
    assert.equal(boot2.store.ttlMs, DEFAULT_TTL_MS);
  } finally {
    boot2.store.close();
  }
});

test("E10 · 显式注入透传：createIdentityService 的短有效期一路到 store 与会话行", async () => {
  const timers = fakeTimers();
  const boot = createIdentityService({ userDataDir: tempDir(), safeStorage: null, sessionTtlMs: 30_000, sessionIdleMs: 20_000, timers });
  try {
    assert.equal(boot.store.ttlMs, 30_000);
    assert.equal(boot.store.idleMs, 20_000);

    await boot.service.dispatch({ type: "identity/initialize", identifier: "a@b.local", password: PW, displayName: "A" });
    const login = await boot.service.dispatch({ type: "identity/login", identifier: "a@b.local", password: PW });
    assert.equal(login.ok, true, JSON.stringify(login));
    const ref = login.snapshot.sessionRef;
    const row = boot.store.sessionByRef(ref);
    assert.equal(row.expires_at - row.created_at, 30_000);
    assert.equal(row.idle_expires_at - row.created_at, 20_000);

    // 到期调度同一份代码：按权威行排出较短的那条上限（真实时钟下差值略小于注入值）
    assert.equal(timers.pending(), 1);
    assert.equal(timers.state.lastDelayMs <= 20_000, true, "不得越过权威行的空闲上限：" + timers.state.lastDelayMs);
    assert.equal(timers.state.lastDelayMs > 19_000, true, "排的就该是空闲上限：" + timers.state.lastDelayMs);

    // 到期后同样落终态 + 新事件
    const events = [];
    boot.service.onEvent((e) => events.push(e));
    boot.store.db.prepare("UPDATE sessions SET expires_at = ?, idle_expires_at = ? WHERE ref = ?").run(Date.now() - 1, Date.now() - 1, ref);
    const verdict = await boot.service.dispatch({ type: "identity/validate", sessionRef: ref });
    assert.equal(verdict.error, "SESSION_EXPIRED");
    await timers.settle();
    assert.equal(boot.store.sessionByRef(ref).revoked_reason, domain.REVOKE_REASON.EXPIRED);
    assert.equal(events.filter((e) => e.event === domain.EVENT.SESSION_EXPIRED).length, 1);
  } finally {
    boot.store.close();
  }
});

test("E11 · 超长 horizon 分块重排：单次定时不超过 2^31-1，早触发只重排", async () => {
  const HUGE = 2 ** 31 - 1;
  const fx = fixture({ ttlMs: HUGE + 60_000, idleMs: HUGE + 120_000 });
  const ref = await fx.login();
  assert.equal(fx.timers.state.lastDelayMs, HUGE, "单次定时必须封顶在 2^31-1（溢出会立刻触发，那就成了忙循环）");

  await fx.timers.fire();
  assert.equal(fx.expired().length, 0, "一个分块到点不等于到期");
  assert.equal(fx.store.sessionByRef(ref).revoked_at, null);
  assert.equal(fx.service.current, ref);
  assert.equal(fx.timers.pending(), 1, "按权威行重新分块，仍然只有一个在途定时器");
  assert.equal(fx.timers.state.lastDelayMs, HUGE);
});

test("E12 · 产品入口接线：main.cjs 只经解析器读双重开关，并把生效值交给 runtime boot", () => {
  const main = fs.readFileSync(new URL("../electron/runtime-composition.cjs", import.meta.url), "utf8");
  assert.equal(main.includes("resolveSessionTtlOverride({ env: process.env })"), true);
  assert.equal(main.includes('console.log("[openarc] " + record.message)'), true, "生效时必须打一条可见日志");
  assert.equal(main.includes("sessionTtlMs: sessionTtl.sessionTtlMs"), true);
  assert.equal(main.includes("sessionIdleMs: sessionTtl.sessionIdleMs"), true);
  for (const name of [SESSION_TTL_OVERRIDE.ACK_ENV, SESSION_TTL_OVERRIDE.IDLE_ENV, SESSION_TTL_OVERRIDE.TTL_ENV]) {
    assert.equal(main.includes("process.env." + name), false, "main.cjs 不得自己读 " + name + "（唯一入口是解析器）");
  }
  const runtimeBoot = fs.readFileSync(new URL("../electron/runtime-boot.cjs", import.meta.url), "utf8");
  assert.equal(runtimeBoot.includes("sessionTtlMs,"), true);
  assert.equal(runtimeBoot.includes("sessionIdleMs,"), true);
});

