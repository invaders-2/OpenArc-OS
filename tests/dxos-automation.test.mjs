/**
 * B6a · 自动化域领域层集成测试（全离线：真实 identity.db（node:sqlite）+ 假时钟，
 * 无 Electron、无网络、无第三方依赖）。
 *
 * 覆盖本轮验收条目：
 *   ① 调度解析：源 daily/weekly/once + B6a 扩展 cron/interval（含时区与锚点）
 *   ② 定义规约：标题 / 动作参数夹取 / workflow_sequence 校验 / retry 规约 / app_action 依赖缺失
 *   ③ 定义 CRUD：create / list / get / update / enable / disable / delete（落 automations 表，级联删 runs）
 *   ④ 调度：假时钟推进后 tick 领取一次运行并落 automation_runs；重复 scheduled_for 不重复触发
 *   ⑤ 失败与重试：一次运行内重试，result 记录真实 attempts；失败落 failed
 *   ⑥ 取消：未开始与运行中都能取消，绝不写 success
 *   ⑦ 业务动作依赖缺失：结构化 AGENT_DEPENDENCY_UNAVAILABLE，绝不假执行
 *   ⑧ 启动恢复：遗留 running 运行置 failed（绝不伪造完成）
 *   ⑨ 中文规则解析（automation/parse）
 *
 * 只读源：electron/automation-domain.cjs、automation-store.cjs、automation-service.cjs、
 *         dxos-foundation-events.cjs、dxos-foundation-errors.cjs。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { IdentityStore } = require("../electron/identity-store.cjs");
const domain = require("../electron/automation-domain.cjs");
const store = require("../electron/automation-store.cjs");
const { createAutomationBundle } = require("../electron/automation-service.cjs");

/** 2023-11-13T00:00:00Z = 上海时间周一 08:00（所有相对断言都以此为准，避免时区抖动）。 */
const BASE = Date.UTC(2023, 10, 13, 0, 0, 0);
const USER = "u-auto";
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

function openBundle(overrides = {}) {
  const dir = tempDir("dxos-automation-");
  const idStore = new IdentityStore({ path: path.join(dir, "identity.db") }).open();
  openStores.push(idStore);
  const clock = overrides.clock || makeClock();
  const bundleOptions = Object.assign({}, overrides.bundle);
  const bundle = createAutomationBundle(Object.assign({
    identityStore: idStore,
    authorization: makeAuth(),
    clock: () => clock.now(),
    sleeper: async () => {},
  }, bundleOptions));
  return { dir, idStore, bundle, clock, userId: USER };
}

const invoke = (bundle, command, payload) => bundle.execute(command, payload || {}, { sessionRef: "sess-auto", requestId: "req-auto" });

function caught(fn) {
  try { fn(); } catch (error) { return error; }
  throw new Error("expected function to throw");
}

async function waitFor(predicate, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

// ── ① 调度解析 ─────────────────────────────────────────────────────────────
test("调度解析：源 daily/weekly/once 逐字对齐 + 时区换算", () => {
  assert.deepEqual(domain.normalizeSchedule({ type: "daily", hour: 9, minute: 30 }, { now: BASE }), { type: "daily", hour: 9, minute: 30, timezone: "Asia/Shanghai" });
  assert.deepEqual(domain.normalizeSchedule({ type: "weekly", weekdays: [1, 1, 3], hour: 8, minute: 0 }, { now: BASE }), { type: "weekly", weekdays: [1, 3], hour: 8, minute: 0, timezone: "Asia/Shanghai" });
  assert.throws(() => domain.normalizeSchedule({ type: "once", at: BASE }, { now: BASE }), /必须晚于现在/);
  assert.throws(() => domain.normalizeSchedule({ type: "daily", hour: 24, minute: 0 }, { now: BASE }), /执行时间无效/);
  assert.throws(() => domain.normalizeSchedule({ type: "weekly", weekdays: [], hour: 1, minute: 1 }, { now: BASE }), /需要指定星期/);
  assert.throws(() => domain.normalizeSchedule({ type: "daily", hour: 1, minute: 1, timezone: "Not/AZone" }, { now: BASE }), /无效的时区/);
  assert.throws(() => domain.normalizeSchedule({ type: "nope" }, { now: BASE }), /没有识别到有效/);

  // 源 automations.ts:102-116：上海 08:00 的基准，daily 09:30 = 当日 01:30Z。
  assert.equal(domain.nextRunAt({ type: "daily", hour: 9, minute: 30, timezone: "Asia/Shanghai" }, BASE), BASE + 5400000);
  // 周一 09:00 就在当天（+1h）；周二 09:00 在次日（+25h）；周日 09:00 在 +6 天 +1h。
  assert.equal(domain.nextRunAt({ type: "weekly", weekdays: [1], hour: 9, minute: 0, timezone: "Asia/Shanghai" }, BASE), BASE + 3600000);
  assert.equal(domain.nextRunAt({ type: "weekly", weekdays: [2], hour: 9, minute: 0, timezone: "Asia/Shanghai" }, BASE), BASE + 25 * 3600000);
  assert.equal(domain.nextRunAt({ type: "weekly", weekdays: [0], hour: 9, minute: 0, timezone: "Asia/Shanghai" }, BASE), BASE + 6 * 86400000 + 3600000);
  // once：未到返回 at，已到返回 null。
  assert.equal(domain.nextRunAt({ type: "once", at: BASE + 5000 }, BASE), BASE + 5000);
  assert.equal(domain.nextRunAt({ type: "once", at: BASE + 5000 }, BASE + 6000), null);
});

test("调度解析：cron 5 段语义（字段/步长/范围/日或周）", () => {
  const every15 = domain.parseCronExpression("*/15 * * * *");
  assert.deepEqual([...every15.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.equal(every15.domRestricted, false);
  assert.equal(domain.nextRunAt({ type: "cron", expression: "30 9 * * 1-5", timezone: "Asia/Shanghai" }, BASE), BASE + 5400000);
  // 周日用 0/7 都等价：2023-11-19（周日）09:00 上海。
  assert.equal(domain.nextRunAt({ type: "cron", expression: "0 9 * * 7", timezone: "Asia/Shanghai" }, BASE), BASE + 6 * 86400000 + 3600000);
  // 稀疏表达式：下一个 1 月 1 日 00:00（上海）。
  const newYear = domain.nextRunAt({ type: "cron", expression: "0 0 1 1 *", timezone: "Asia/Shanghai" }, BASE);
  const parts = domain.partsAt(newYear, "Asia/Shanghai");
  assert.equal(parts.year, 2024);
  assert.equal(parts.month, 1);
  assert.equal(parts.day, 1);
  assert.equal(parts.hour, 0);
  // 非法表达式一律结构化拒绝。
  assert.throws(() => domain.parseCronExpression("*/15 * * *"), /必须是 5 段/);
  assert.throws(() => domain.parseCronExpression("61 * * * *"), /超出范围/);
  assert.throws(() => domain.parseCronExpression("*/0 * * * *"), /步长必须是正整数/);
  assert.throws(() => domain.normalizeSchedule({ type: "cron", expression: "bad" }, { now: BASE }), /必须是 5 段/);
});

test("调度解析：interval 锚点对齐（不随领取时间漂移）", () => {
  const schedule = domain.normalizeSchedule({ type: "interval", everyMs: 3600000 }, { now: BASE });
  assert.equal(schedule.anchor, BASE);
  assert.equal(domain.nextRunAt(schedule, BASE), BASE + 3600000);
  assert.equal(domain.nextRunAt(schedule, BASE + 3600000), BASE + 2 * 3600000);
  assert.equal(domain.nextRunAt(schedule, BASE + 2 * 3600000 + 100), BASE + 3 * 3600000);
  // everyMinutes 便捷字段（B6a 解析友好）。
  assert.equal(domain.normalizeSchedule({ type: "interval", everyMinutes: 30 }, { now: BASE }).everyMs, 1800000);
  assert.throws(() => domain.normalizeSchedule({ type: "interval", everyMs: 0 }, { now: BASE }), /必须是正毫秒数/);
});

// ── ② 定义规约 ─────────────────────────────────────────────────────────────
test("定义规约：标题 / 参数夹取 / 联动校验 / retry / app_action 依赖缺失", () => {
  const daily = { type: "daily", hour: 9, minute: 0 };
  const titleDefault = domain.normalizeDefinition({ instruction: "每天早上把领星数据同步一下并写周报", schedule: daily, action: { type: "lingxing_cache_sync", args: { days: 999 } } }, { now: BASE });
  assert.equal(titleDefault.title, "每天早上把领星数据同步一下并写周报".slice(0, 30));
  assert.equal(titleDefault.action.args.days, 180);
  assert.equal(domain.normalizeDefinition({ schedule: daily, action: { type: "ziniao_download", args: { days: 999 } } }, { now: BASE }).action.args.days, 90);
  const notify = domain.normalizeDefinition({ schedule: daily, action: { type: "dingtalk_group_notify", args: { content: "x".repeat(5000) } } }, { now: BASE });
  assert.equal(notify.action.args.content.length, 4000);
  assert.equal(notify.action.args.includeResult, true);
  assert.equal(domain.normalizeDefinition({ schedule: daily, action: { type: "dingtalk_person_notify", args: { content: "hi", includeResult: "false" } } }, { now: BASE }).action.args.includeResult, false);
  assert.throws(() => domain.normalizeDefinition({ schedule: daily, action: { type: "workflow_sequence", args: { actions: [] } } }, { now: BASE }), /至少需要一个/);
  assert.throws(() => domain.normalizeDefinition({ schedule: daily, action: { type: "workflow_sequence", args: { actions: Array.from({ length: 21 }, () => ({ type: "lingxing_cache_sync", args: {} })) } } }, { now: BASE }), /最多支持 20 个/);
  assert.throws(() => domain.normalizeDefinition({ schedule: daily, action: { type: "workflow_sequence", args: { actions: [{ type: "music_play", args: {} }] } } }, { now: BASE }), /暂不支持后台联动/);
  assert.throws(() => domain.normalizeDefinition({ schedule: daily, action: { type: "nope", args: {} } }, { now: BASE }), /没有识别到可执行的动作/);

  const sequence = domain.normalizeDefinition({ schedule: daily, action: { type: "workflow_sequence", args: { actions: [{ type: "lingxing_cache_sync", args: { days: 3 } }] } } }, { now: BASE });
  assert.equal(sequence.action.args.actions.length, 1);
  assert.equal(sequence.action.args.actions[0].args.days, 3);

  // retry：maxAttempts 夹到 1..5，delayMs 夹到 0..600000。
  const retry = domain.normalizeDefinition({ schedule: daily, action: { type: "lingxing_cache_sync", args: {} }, retry: { maxAttempts: 99, delayMs: -5 } }, { now: BASE });
  assert.deepEqual(retry.action.retry, { maxAttempts: 5, delayMs: 0 });
  assert.equal(domain.normalizeDefinition({ schedule: daily, action: { type: "lingxing_cache_sync", args: {} } }, { now: BASE }).action.retry, undefined);

  // app_action（B7）未注入 → 结构化依赖缺失，定义不被放行。
  const err = caught(() => domain.normalizeDefinition({ schedule: daily, action: { type: "app_action", args: { appId: "x", actionId: "y" } } }, { now: BASE }));
  assert.equal(err.code, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(err.detail.dependency, "developerApps");
});

// ── ③ 定义 CRUD ────────────────────────────────────────────────────────────
test("CRUD：create/list/get/update/enable/disable/delete 落 automations 表（级联删 runs）", () => {
  const fx = openBundle();
  const created = store.createAutomation(USER, { instruction: "每日同步", schedule: { type: "daily", hour: 9, minute: 0 }, action: { type: "lingxing_cache_sync", args: { days: 7 } } });
  assert.ok(created.id);
  assert.equal(created.enabled, true);
  assert.equal(created.userId, USER);
  assert.equal(created.nextRunAt, BASE + 3600000); // 上海 08:00 → 今日 09:00
  assert.equal(fx.idStore.connection.prepare("SELECT COUNT(*) AS c FROM automations").get().c, 1);

  const list = store.listAutomations(USER);
  assert.equal(list.length, 1);
  assert.equal(list[0].runs.length, 0);
  assert.equal(store.getAutomation(USER, created.id).id, created.id);

  const renamed = store.updateAutomation(USER, created.id, { title: "改名" });
  assert.equal(renamed.title, "改名");
  assert.equal(renamed.action.args.days, 7);

  const rescheduled = store.updateAutomation(USER, created.id, { schedule: { type: "weekly", weekdays: [2], hour: 8, minute: 0 } });
  assert.equal(rescheduled.schedule.type, "weekly");
  assert.equal(rescheduled.nextRunAt, BASE + 24 * 3600000);

  const disabled = store.updateAutomation(USER, created.id, { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.nextRunAt, null);
  assert.equal(store.listAutomations(USER)[0].enabled, false);
  assert.equal(store.updateAutomation(USER, created.id, { enabled: true }).enabled, true);

  assert.equal(store.deleteAutomation(USER, created.id).deleted, true);
  assert.equal(store.listAutomations(USER).length, 0);
  assert.equal(fx.idStore.connection.prepare("SELECT COUNT(*) AS c FROM automations").get().c, 0);
  assert.throws(() => store.getAutomation(USER, created.id), /自动化任务不存在/);
  assert.throws(() => store.deleteAutomation(USER, created.id), /自动化任务不存在/);
  // 记录完整性：automation_runs 外键 ON DELETE CASCADE 已清空（identity-store.cjs:1704 开了外键）。
  assert.equal(fx.idStore.connection.prepare("SELECT COUNT(*) AS c FROM automation_runs").get().c, 0);
});

// ── ④ 调度 ─────────────────────────────────────────────────────────────────
test("调度：假时钟到点后 tick 领取一次运行并落 automation_runs", async () => {
  const fx = openBundle();
  const calls = [];
  const bundle = createAutomationBundle({
    identityStore: fx.idStore,
    authorization: makeAuth(),
    clock: () => fx.clock.now(),
    sleeper: async () => {},
    integrations: { lingxingCacheSync: async (args) => { calls.push(args); return "领星缓存完成"; } },
  });
  store.createAutomation(USER, { instruction: "每日同步", schedule: { type: "once", at: BASE + 60000 }, action: { type: "lingxing_cache_sync", args: { days: 7 } } });

  assert.equal(await bundle.tick(), null, "未到点不应领取");
  fx.clock.set(BASE + 60000);
  const result = await bundle.tick();
  assert.equal(result.status, "success");
  assert.equal(result.attempts, 1);
  assert.equal(result.result, "领星缓存完成");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].days, 7);

  const runs = store.listRuns(USER, {});
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "success");
  assert.equal(runs[0].clientId, "main");
  assert.deepEqual(JSON.parse(runs[0].result), { attempts: 1, output: "领星缓存完成" });
  const automation = store.getAutomation(USER, runs[0].automationId);
  assert.equal(automation.lastStatus, "success");
  assert.equal(automation.nextRunAt, null); // once 执行完不再有下一次
  assert.equal(await bundle.tick(), null, "同一 scheduled_for 不得重复触发");
  assert.equal(store.listRuns(USER, {}).length, 1);
});

test("调度：interval 每次领取后按锚点推进下一次时间", async () => {
  const fx = openBundle();
  const bundle = createAutomationBundle({
    identityStore: fx.idStore,
    authorization: makeAuth(),
    clock: () => fx.clock.now(),
    sleeper: async () => {},
    integrations: { lingxingCacheSync: async () => "ok" },
  });
  const created = store.createAutomation(USER, { instruction: "每小时", schedule: { type: "interval", everyMs: 3600000 }, action: { type: "lingxing_cache_sync", args: {} } });
  assert.equal(created.nextRunAt, BASE + 3600000);
  fx.clock.set(BASE + 3600000);
  assert.equal((await bundle.tick()).status, "success");
  const after = store.getAutomation(USER, created.id);
  assert.equal(after.nextRunAt, BASE + 2 * 3600000);
  assert.equal(after.enabled, true);
});

// ── ⑤ 失败与重试 ───────────────────────────────────────────────────────────
test("失败与重试：一次运行内重试并记录真实 attempts；最终失败落 failed", async () => {
  const fx = openBundle();
  let attempts = 0;
  const delays = [];
  const bundle = createAutomationBundle({
    identityStore: fx.idStore,
    authorization: makeAuth(),
    clock: () => fx.clock.now(),
    sleeper: async (ms) => { delays.push(ms); },
    integrations: {
      lingxingCacheSync: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("第 " + attempts + " 次失败");
        return "第三次成功";
      },
    },
  });
  const created = store.createAutomation(USER, { instruction: "重试", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: {}, retry: { maxAttempts: 3, delayMs: 2000 } } });
  fx.clock.set(BASE + 1000);
  const ok = await invoke(bundle, "automation/runNow", { automationId: created.id, await: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.value.result.attempts, 3);
  assert.equal(ok.value.result.status, "success");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2000, 2000]);
  assert.equal(store.listRuns(USER, {}).length, 1, "重试仍只落一行运行记录");
  assert.deepEqual(JSON.parse(store.listRuns(USER, {})[0].result), { attempts: 3, output: "第三次成功" });

  // 永远失败：maxAttempts=2 后落 failed，IPC 返回结构化错误，记录保留真实 attempts。
  let always = 0;
  const failing = createAutomationBundle({
    identityStore: fx.idStore,
    authorization: makeAuth(),
    clock: () => fx.clock.now(),
    sleeper: async () => {},
    integrations: { lingxingCacheSync: async () => { always += 1; throw new Error("总是失败"); } },
  });
  const failingAutomation = store.createAutomation(USER, { instruction: "失败", schedule: { type: "once", at: BASE + 2000 }, action: { type: "lingxing_cache_sync", args: {}, retry: { maxAttempts: 2 } } });
  const failed = await invoke(failing, "automation/runNow", { automationId: failingAutomation.id, await: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "AUTOMATION_INTERNAL");
  assert.match(failed.message, /总是失败/);
  assert.equal(always, 2);
  const failedRun = store.listRuns(USER, {}).find((run) => run.automationId === failingAutomation.id);
  assert.equal(failedRun.status, "failed");
  assert.equal(store.getAutomation(USER, failingAutomation.id).lastStatus, "failed");
});

// ── ⑥ 取消 ─────────────────────────────────────────────────────────────────
test("取消：未开始的运行直接置 cancelled，且绝不执行动作", async () => {
  const fx = openBundle();
  let calls = 0;
  const bundle = createAutomationBundle({
    identityStore: fx.idStore,
    authorization: makeAuth(),
    clock: () => fx.clock.now(),
    sleeper: async () => {},
    integrations: { lingxingCacheSync: async () => { calls += 1; return "不应执行"; } },
  });
  store.createAutomation(USER, { instruction: "取消", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: {} } });
  fx.clock.set(BASE + 1000);
  const claim = bundle.claimDue();
  assert.ok(claim);
  const cancelled = bundle.cancelRun(USER, claim.run.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.immediate, true);
  const result = await bundle.runClaimed(claim);
  assert.equal(result.status, "cancelled");
  assert.equal(calls, 0, "取消后不得执行动作");
  const run = store.getRun(USER, claim.run.id);
  assert.equal(run.status, "cancelled");
  assert.notEqual(run.status, "success");
  // 已结束的运行不能再取消。
  const err = caught(() => bundle.cancelRun(USER, claim.run.id));
  assert.equal(err.code, "AUTOMATION_CONFLICT");
});

test("取消：运行中被取消时收敛为 cancelled（不写 success）", async () => {
  const fx = openBundle();
  let release = null;
  let started = false;
  const bundle = createAutomationBundle({
    identityStore: fx.idStore,
    authorization: makeAuth(),
    clock: () => fx.clock.now(),
    sleeper: async () => {},
    integrations: {
      lingxingCacheSync: () => new Promise((resolve) => { started = true; release = () => resolve("迟到结果"); }),
    },
  });
  store.createAutomation(USER, { instruction: "运行中取消", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: {} } });
  fx.clock.set(BASE + 1000);
  const claim = bundle.claimDue();
  const pending = bundle.runClaimed(claim);
  await waitFor(() => started);
  const cancelling = bundle.cancelRun(USER, claim.run.id);
  assert.equal(cancelling.status, "cancelling");
  assert.equal(cancelling.immediate, false);
  release();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(store.getRun(USER, claim.run.id).status, "cancelled");
});

test("B7j 取消：runId 为主字段；automationId 仅作可解析别名；缺失 / 错误值结构化拒绝", async () => {
  const fx = openBundle();
  let release = null;
  const bundle = createAutomationBundle({
    identityStore: fx.idStore,
    authorization: makeAuth(),
    clock: () => fx.clock.now(),
    sleeper: async () => {},
    integrations: { lingxingCacheSync: () => new Promise((resolve) => { release = () => resolve("迟到结果"); }) },
  });
  const created = store.createAutomation(USER, { instruction: "取消运行", schedule: { type: "interval", everyMs: 3600000 }, action: { type: "lingxing_cache_sync", args: {} } });
  fx.clock.set(BASE + 1000);

  // 字段缺失：结构化拒绝，并明确该传 runId。
  const missing = await invoke(bundle, "automation/cancel", {});
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "AUTOMATION_INVALID_INPUT");
  assert.match(missing.message, /runId/);

  // automationId 传的是"定义 id"（不是运行记录）：按真实语义解析失败 → 结构化拒绝并指明 runId。
  const wrong = await invoke(bundle, "automation/cancel", { automationId: created.id });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, "AUTOMATION_INVALID_INPUT");
  assert.match(wrong.message, /runId/);
  assert.equal(wrong.detail.received, "automationId");

  // 自然字段 runId：运行中取消。
  release = null;
  const started = await invoke(bundle, "automation/runNow", { automationId: created.id });
  assert.equal(started.ok, true);
  const runId = started.value.run.id;
  assert.equal(await waitFor(() => !!release), true);
  const cancelled = await invoke(bundle, "automation/cancel", { runId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.value.status, "cancelling");
  release();
  assert.equal(await waitFor(() => store.getRun(USER, runId).status === "cancelled"), true);

  // automationId 传"运行记录 id"：历史别名兼容（先解析到运行记录才接受）。
  const created2 = store.createAutomation(USER, { instruction: "别名取消", schedule: { type: "interval", everyMs: 3600000 }, action: { type: "lingxing_cache_sync", args: {} } });
  release = null;
  const started2 = await invoke(bundle, "automation/runNow", { automationId: created2.id });
  const runId2 = started2.value.run.id;
  assert.equal(await waitFor(() => !!release), true);
  const aliasCancel = await invoke(bundle, "automation/cancel", { automationId: runId2 });
  assert.equal(aliasCancel.ok, true);
  assert.equal(aliasCancel.value.status, "cancelling");
  release();
  assert.equal(await waitFor(() => store.getRun(USER, runId2).status === "cancelled"), true);
});

// ── ⑦ 业务动作依赖缺失 ─────────────────────────────────────────────────────
test("业务动作依赖缺失：结构化 AGENT_DEPENDENCY_UNAVAILABLE，绝不假执行", async () => {
  const fx = openBundle();
  const bare = createAutomationBundle({ identityStore: fx.idStore, authorization: makeAuth(), clock: () => fx.clock.now(), sleeper: async () => {} });

  const cases = [
    { action: { type: "lingxing_cache_sync", args: {} }, dependency: "integrations" },
    { action: { type: "ziniao_download", args: {} }, dependency: "integrations" },
    { action: { type: "ziniao_data_sync", args: {} }, dependency: "integrations" },
    { action: { type: "dingtalk_group_notify", args: { content: "x" } }, dependency: "integrations" },
    { action: { type: "dingtalk_person_notify", args: { recipient: "u" } }, dependency: "integrations" },
    { action: { type: "music_play", args: {} }, dependency: "desktop" },
    { action: { type: "music_control", args: {} }, dependency: "desktop" },
    { action: { type: "open_app", args: {} }, dependency: "desktop" },
    { action: { type: "agent_instruction", args: { instruction: "写周报" } }, dependency: "agent" },
  ];
  for (const item of cases) {
    const created = store.createAutomation(USER, { instruction: "缺依赖", schedule: { type: "once", at: BASE + 1000 }, action: item.action });
    const result = await invoke(bare, "automation/runNow", { automationId: created.id, await: true });
    assert.equal(result.ok, false, item.action.type + " 必须结构化失败");
    assert.equal(result.error, "AGENT_DEPENDENCY_UNAVAILABLE", item.action.type);
    assert.equal(result.detail.dependency, item.dependency, item.action.type);
    const run = store.listRuns(USER, {}).find((row) => row.automationId === created.id);
    assert.equal(run.status, "failed", item.action.type + " 不得伪造成功");
    assert.match(run.error, /依赖未装配/);
  }

  // 联动流程：子动作缺依赖时保留结构化错误码，并定位到第几步。
  const sequence = store.createAutomation(USER, { instruction: "联动", schedule: { type: "once", at: BASE + 1000 }, action: { type: "workflow_sequence", args: { actions: [{ type: "lingxing_cache_sync", args: {} }] } } });
  const nested = await invoke(bare, "automation/runNow", { automationId: sequence.id, await: true });
  assert.equal(nested.error, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.match(nested.message, /第 1 步执行失败/);

  // 集成适配器存在但方法缺失：依赖名精确到方法。
  const partial = createAutomationBundle({ identityStore: fx.idStore, authorization: makeAuth(), clock: () => fx.clock.now(), sleeper: async () => {}, integrations: {} });
  const partialAutomation = store.createAutomation(USER, { instruction: "半装配", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: {} } });
  const partialResult = await invoke(partial, "automation/runNow", { automationId: partialAutomation.id, await: true });
  assert.equal(partialResult.error, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(partialResult.detail.dependency, "integrations.lingxingCacheSync");

  // app_action：定义期就要开发者 App 适配器。
  const appDef = await invoke(bare, "automation/create", { definition: { instruction: "app", schedule: { type: "once", at: BASE + 1000 }, action: { type: "app_action", args: { appId: "a", actionId: "b" } } } });
  assert.equal(appDef.ok, false);
  assert.equal(appDef.error, "AGENT_DEPENDENCY_UNAVAILABLE");
  assert.equal(appDef.detail.dependency, "developerApps");
});

test("业务动作在适配器注入后真实执行（钉钉 / 桌面 / Agent / 工作流）", async () => {
  const fx = openBundle();
  const seen = [];
  const bundle = createAutomationBundle({
    identityStore: fx.idStore,
    authorization: makeAuth(),
    clock: () => fx.clock.now(),
    sleeper: async () => {},
    integrations: {
      dingtalkGroupNotify: async (channelId, message) => { seen.push(["group", channelId, message.text]); return { ok: true, channel: "运营群" }; },
      dingtalkPersonNotify: async (recipient, text) => { seen.push(["person", recipient, text]); return true; },
      lingxingCacheSync: async () => { seen.push(["lingxing"]); return "领星 OK"; },
    },
    desktop: {
      musicPlay: async (args) => { seen.push(["music", args.query]); return "已播放"; },
      openApp: async (args) => { seen.push(["open", args.app]); return "已打开"; },
    },
    agent: { runInstruction: async (instruction) => { seen.push(["agent", instruction]); return { text: "周报已生成" }; } },
  });
  const run = async (action) => {
    const created = store.createAutomation(USER, { instruction: "动作", schedule: { type: "once", at: BASE + 1000 }, action });
    const result = await invoke(bundle, "automation/runNow", { automationId: created.id, await: true });
    return result;
  };
  const group = await run({ type: "dingtalk_group_notify", args: { channelId: "c1", content: "完成：{{上一步结果}}" } });
  assert.equal(group.ok, true);
  assert.match(group.value.result.result, /运营群/);
  assert.equal(seen[0][0], "group");
  assert.equal(seen[0][2], "完成：");
  const sequence = await run({ type: "workflow_sequence", args: { actions: [{ type: "lingxing_cache_sync", args: {} }, { type: "dingtalk_person_notify", args: { recipient: "u9", content: "同步结果" } }] } });
  assert.equal(sequence.ok, true);
  assert.match(sequence.value.result.result, /1\. 领星 OK/);
  assert.match(sequence.value.result.result, /2\. 钉钉通知已发送给 u9/);
  assert.equal((await run({ type: "open_app", args: { app: "计算器" } })).value.result.result, "已打开");
  assert.equal((await run({ type: "agent_instruction", args: { instruction: "写周报" } })).value.result.result, "周报已生成");
});

// ── ⑧ 启动恢复 ─────────────────────────────────────────────────────────────
test("启动恢复：遗留 running 运行置 failed（绝不伪造完成）", () => {
  const fx = openBundle();
  const bundle = createAutomationBundle({ identityStore: fx.idStore, authorization: makeAuth(), clock: () => fx.clock.now(), sleeper: async () => {} });
  store.createAutomation(USER, { instruction: "恢复", schedule: { type: "once", at: BASE + 1000 }, action: { type: "lingxing_cache_sync", args: {} } });
  fx.clock.set(BASE + 1000);
  const claim = bundle.claimDue();
  assert.equal(claim.run.status, "running");
  assert.equal(store.recoverInterruptedRuns(), 1);
  const run = store.getRun(USER, claim.run.id);
  assert.equal(run.status, "failed");
  assert.match(run.error, /主进程曾重启/);
  assert.equal(store.getAutomation(USER, claim.automation.id).lastStatus, "failed");
  // 幂等：没有 running 时返回 0。
  assert.equal(store.recoverInterruptedRuns(), 0);
});

// ── ⑨ 中文规则解析 ─────────────────────────────────────────────────────────
test("automation/parse：本地规则解析（离线，不调用模型）", async () => {
  const fx = openBundle();
  const bundle = createAutomationBundle({ identityStore: fx.idStore, authorization: makeAuth(), clock: () => fx.clock.now(), sleeper: async () => {} });
  const daily = await invoke(bundle, "automation/parse", { instruction: "每天早上 9 点半播放周杰伦" });
  assert.equal(daily.ok, true);
  assert.equal(daily.value.parsedBy, "rules");
  assert.equal(daily.value.definition.schedule.type, "daily");
  assert.equal(daily.value.definition.schedule.hour, 9);
  // 源 clockFromText（automations.ts:194-203）的 [:：点时] 分支先于 [点半] 命中，因此"9 点半"在源里
  // 就解析成 9:00（includes('半') 那条分支实际不可达）。这里逐字复刻源行为，不"顺手修好"。
  assert.equal(daily.value.definition.schedule.minute, 0);
  assert.equal(daily.value.definition.action.type, "music_play");
  assert.equal(daily.value.definition.action.args.query, "周杰伦");

  const interval = await invoke(bundle, "automation/parse", { instruction: "每30分钟同步一次领星数据" });
  assert.equal(interval.ok, true);
  assert.equal(interval.value.definition.schedule.type, "interval");
  assert.equal(interval.value.definition.schedule.everyMs, 1800000);
  assert.equal(interval.value.definition.action.type, "lingxing_cache_sync");

  const missing = await invoke(bundle, "automation/parse", { instruction: "帮忙写个周报" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "AUTOMATION_INVALID_INPUT");
  assert.match(missing.message, /执行时间/);
});
