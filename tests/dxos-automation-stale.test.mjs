/**
 * B6e · 领取前 stale 恢复（对齐源 automations.ts:314-334）+ 单进程本地调度器取舍。
 *
 * 覆盖本轮验收条目：
 *   (a) running 超过 stale 阈值后，下一次 tick/claim 先把它收敛为 failed 并记录原因（含事件审计）
 *   (b) 未超阈值的 running 不被误收敛（含"正好等于阈值"的严格 < 边界）
 *   (c) 启动恢复与 per-tick 恢复不重复处理同一 run（幂等，且不改写先到者的原因）
 *   (d) 恢复不影响待领取的新 run
 *
 * 只读源：electron/automation-store.cjs、automation-service.cjs、automation-domain.cjs。
 * 离线：真实 identity.db（node:sqlite）+ 可推进的假时钟，无 Electron / 无网络 / 无第三方依赖。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { IdentityStore } = require("../electron/identity-store.cjs");
const store = require("../electron/automation-store.cjs");
const { createAutomationBundle } = require("../electron/automation-service.cjs");

/** 2023-11-13T00:00:00Z（上海周一 08:00），与 B6a 测试同一基准，避免时区抖动。 */
const BASE = Date.UTC(2023, 10, 13, 0, 0, 0);
const USER = "u-stale";
/** 测试注入 1 分钟阈值（远小于源默认 10 分钟），假时钟推进即可跨过。 */
const STALE = 60_000;

const tmpDirs = [];
const openStores = [];

afterEach(() => {
  store.resetAutomationStoreForTests();
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeClock(start = BASE) {
  let value = start;
  return { now: () => value, set: (next) => { value = next; }, advance: (ms) => { value += ms; } };
}

function makeAuth() {
  return { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: USER } } : { ok: false, error: "no-session" }) };
}

/**
 * 打开一个 bundle；options.idStore 可复用（模拟同一进程外重启），options.clock 可复用。
 * staleAfterMs 经 createAutomationBundle 注入 store.configureAutomationStore。
 */
function openBundle(options = {}) {
  let idStore = options.idStore || null;
  if (!idStore) {
    const dir = tempDir("dxos-automation-stale-");
    idStore = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
    openStores.push(idStore);
  }
  const clock = options.clock || makeClock();
  const bundle = createAutomationBundle({
    identityStore: idStore,
    authorization: makeAuth(),
    clock: () => clock.now(),
    sleeper: async () => {},
    staleAfterMs: options.staleAfterMs,
  });
  return { idStore, bundle, clock, userId: USER };
}

/** 建一个 once 定义并返回定义 id（next_run_at = at）。 */
function createOnce(at) {
  return store.createAutomation(USER, {
    instruction: "stale 用例",
    schedule: { type: "once", at },
    action: { type: "lingxing_cache_sync", args: {} },
  });
}

// ── 阈值口径 ────────────────────────────────────────────────────────────────
test("stale 阈值：默认常量对齐源 automations.ts:315 的 10 分钟", () => {
  assert.equal(store.DEFAULT_STALE_AFTER_MS, 10 * 60_000);
  assert.equal(store.staleRunMessage(600_000), "运行超过 10 分钟未完成，已判定为中断并置为失败");
});

// ── (a) 超阈值收敛 ──────────────────────────────────────────────────────────
test("(a) stale 恢复：下一次领取前把超阈值 running 收敛为 failed 并记录原因与事件", () => {
  const clock = makeClock();
  const fx = openBundle({ clock, staleAfterMs: STALE });
  const created = createOnce(BASE + 1000);

  clock.set(BASE + 1000);
  const claim = fx.bundle.claimDue();
  assert.ok(claim, "到点应领取到运行");
  assert.equal(claim.run.status, "running");
  assert.equal(claim.run.clientId, "main");
  assert.equal(claim.run.startedAt, BASE + 1000);

  const events = [];
  fx.bundle.setEventSink((event) => events.push(event));

  // 严格小于阈值判定（源 :317 started_at<?）：now = started_at + STALE 仍不算 stale。
  clock.set(BASE + 1000 + STALE);
  assert.equal(fx.bundle.claimDue(), null, "没有可领取的定义");
  assert.equal(store.getRun(USER, claim.run.id).status, "running", "正好等于阈值不得误收敛");

  // 越过阈值：下一次 claim 路径先收敛，再（无候选）返回 null。
  clock.set(BASE + 1000 + STALE + 1);
  assert.equal(fx.bundle.claimDue(), null);

  const run = store.getRun(USER, claim.run.id);
  assert.equal(run.status, "failed", "超阈值 running 必须收敛为终态 failed");
  assert.match(run.error, /运行超过 1 分钟未完成/);
  assert.equal(run.completedAt, BASE + 1000 + STALE + 1);
  const automation = store.getAutomation(USER, created.id);
  assert.equal(automation.lastStatus, "failed");
  assert.equal(automation.lastError, run.error);

  // 事件审计：progress/stale-recovered，带 runId/automationId/原因。
  const staleEvents = events.filter((event) => event.payload && event.payload.phase === "stale-recovered");
  assert.equal(staleEvents.length, 1, "每次收敛恰好一条审计事件");
  assert.equal(staleEvents[0].kind, "progress");
  assert.equal(staleEvents[0].payload.runId, claim.run.id);
  assert.equal(staleEvents[0].payload.automationId, created.id);
  assert.match(staleEvents[0].payload.error, /中断/);

  // 幂等：已收敛的运行不重复处理，也不再发事件。
  const again = store.recoverStaleRuns({ now: clock.now() });
  assert.equal(again.count, 0);
  assert.deepEqual(again.recovered, []);
  assert.equal(events.filter((event) => event.payload && event.payload.phase === "stale-recovered").length, 1);
});

// ── (b) 未超阈值不误收敛 ────────────────────────────────────────────────────
test("(b) stale 恢复：未超阈值的 running 不被误收敛", () => {
  const clock = makeClock();
  const fx = openBundle({ clock, staleAfterMs: STALE });
  const created = createOnce(BASE + 1000);
  clock.set(BASE + 1000);
  const claim = fx.bundle.claimDue();
  assert.equal(claim.run.status, "running");

  // 阈值内：无论走 store 直调还是领取路径，都不动它。
  clock.set(BASE + 1000 + STALE - 1);
  assert.equal(store.recoverStaleRuns({ now: clock.now() }).count, 0);
  assert.equal(fx.bundle.claimDue(), null);
  assert.equal(store.getRun(USER, claim.run.id).status, "running");
  assert.equal(store.getAutomation(USER, created.id).lastStatus, "running");

  // 正好等于阈值（严格 <）：仍不收敛。
  clock.set(BASE + 1000 + STALE);
  assert.equal(store.recoverStaleRuns({ now: clock.now() }).count, 0);
  assert.equal(store.getRun(USER, claim.run.id).status, "running");
});

// ── (c) 启动恢复与 per-claim 恢复幂等 ───────────────────────────────────────
test("(c) stale 恢复：启动恢复与 per-tick 恢复不重复处理同一 run（幂等）", () => {
  const clock = makeClock();
  const first = openBundle({ clock, staleAfterMs: STALE });
  const created = createOnce(BASE + 1000);
  clock.set(BASE + 1000);
  const claim = first.bundle.claimDue();
  assert.equal(claim.run.status, "running");

  // 越过阈值后模拟"进程重启"：新 bundle 装配时 recoverInterruptedRuns 先收敛它。
  clock.set(BASE + 1000 + STALE + 1);
  const second = openBundle({ clock, staleAfterMs: STALE, idStore: first.idStore });
  const afterStartup = store.getRun(USER, claim.run.id);
  assert.equal(afterStartup.status, "failed");
  assert.match(afterStartup.error, /主进程曾重启/);

  // per-claim 恢复不再处理同一条（changes=0），也不改写启动恢复的原因。
  const events = [];
  second.bundle.setEventSink((event) => events.push(event));
  const result = store.recoverStaleRuns({ now: clock.now() });
  assert.equal(result.count, 0);
  assert.deepEqual(result.recovered, []);
  assert.equal(second.bundle.claimDue(), null);
  assert.equal(store.getRun(USER, claim.run.id).error, afterStartup.error);
  assert.equal(events.filter((event) => event.payload && event.payload.phase === "stale-recovered").length, 0);
  assert.equal(store.getAutomation(USER, created.id).lastStatus, "failed");
});

// ── (d) 不影响待领取的新 run ────────────────────────────────────────────────
test("(d) stale 恢复：不影响待领取的新 run（同一 tick 先收敛旧 run 再领取新 run）", () => {
  const clock = makeClock();
  const fx = openBundle({ clock, staleAfterMs: STALE });
  const staleAutomation = createOnce(BASE + 1000);
  clock.set(BASE + 1000);
  const staleClaim = fx.bundle.claimDue();
  assert.equal(staleClaim.automation.id, staleAutomation.id);

  // 新定义：到点时尚未领取；下一步 claim 应"先收敛旧的、再领取新的"。
  const freshAutomation = createOnce(BASE + 2000);
  const events = [];
  fx.bundle.setEventSink((event) => events.push(event));
  clock.set(BASE + 1000 + STALE + 1);
  const fresh = fx.bundle.claimDue();
  assert.ok(fresh, "恢复 stale 后仍应领取到新 run");
  assert.equal(fresh.automation.id, freshAutomation.id);
  assert.equal(fresh.run.status, "running");

  assert.equal(store.getRun(USER, staleClaim.run.id).status, "failed");
  assert.equal(store.getAutomation(USER, staleAutomation.id).lastStatus, "failed");
  // 新 run 与它的定义都不受恢复影响。
  assert.equal(store.getRun(USER, fresh.run.id).status, "running");
  assert.equal(store.getAutomation(USER, freshAutomation.id).lastStatus, "running");
  const staleEvents = events.filter((event) => event.payload && event.payload.phase === "stale-recovered");
  assert.equal(staleEvents.length, 1);
  assert.equal(staleEvents[0].payload.runId, staleClaim.run.id);
});
