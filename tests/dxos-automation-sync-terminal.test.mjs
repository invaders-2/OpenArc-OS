/**
 * Y2 · 领星 / 紫鸟同步动作的"终态等待"（对齐源 automationBusinessActions.ts:20-61）。
 *
 * 覆盖任务书验收点（全离线：假作业源 + 假时钟 + 假休眠，0 次网络）：
 *   · 终态 success → 返回源口径结果文案，且启动作业只是内部步骤；
 *   · 终态 failed → 结构化 INTEGRATION_INTERNAL，绝不冒充成功；
 *   · 终态 stopped（用户停止 = 取消）→ 结构化 INTEGRATION_CANCELLED；automation 侧归类为 AUTOMATION_CANCELLED；
 *   · 作业状态丢失 → INTEGRATION_NOT_FOUND；
 *   · 有界超时 → INTEGRATION_INTERNAL，且只轮询一次、不把 running 谎报为完成；
 *   · 等待期间作业被停止 → 下一次轮询即如实归因（取消路径）。
 *
 * 只读源：server/automationBusinessActions.ts:20-61,109-121。
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { IdentityStore } = require("../electron/identity-store.cjs");
const automationStore = require("../electron/automation-store.cjs");
const { createAutomationBundle } = require("../electron/automation-service.cjs");
const { createPluginBundle } = require("../electron/plugin-service.cjs");

const BASE = Date.UTC(2023, 10, 13, 0, 0, 0);
const USER = "u-auto-terminal";
const tmpDirs = [];
const openBundles = [];
const openStores = [];

afterEach(() => {
  automationStore.resetAutomationStoreForTests();
  while (openBundles.length) { const bundle = openBundles.pop(); try { bundle.ziniao.close(); } catch { /* 已关 */ } try { bundle.lingxing.close(); } catch { /* 已关 */ } }
  while (openStores.length) { try { openStores.pop().close(); } catch { /* 已关 */ } }
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(dir); return dir; }
const okProbe = () => ({ ok: true, status: "ok", detail: "" });

function createBundle(overrides = {}) {
  const bundle = createPluginBundle(Object.assign({
    userDataDir: tempDir("dxos-sync-terminal-"),
    safeStorage: null,
    probes: { binary: okProbe, python: okProbe, network: okProbe },
  }, overrides));
  openBundles.push(bundle);
  return bundle;
}

async function enable(bundle, id) {
  const result = await bundle.execute("integration/plugins/enable", { id }, { sessionRef: "s1" });
  assert.equal(result.ok, true, id + " 启用失败：" + JSON.stringify(result));
}

/** 假作业源：start 只回 id；get 恒返回给定作业对象。 */
function terminalSource(job) {
  return { start: () => ({ id: job.id }), get: () => job };
}

const ZINIAO_STORES = [{ selector: "s1", name: "店铺一" }];

// ── 领星：success / failed / 状态丢失 / 超时 ───────────────────────────────
test("领星：先 running 后 complete 才返回成功文案（启动作业仍是内部步骤）", async () => {
  const job = { id: "lx-1", status: "running", cacheDays: 3, rows: 0 };
  let starts = 0;
  let polls = 0;
  let sleeps = 0;
  const source = {
    start() { starts += 1; return { id: job.id }; },
    get(id) { polls += 1; assert.equal(id, job.id); return job; },
  };
  const bundle = createBundle({
    lingxingJobSource: source,
    sleeper: async () => { sleeps += 1; job.status = "complete"; job.rows = 9; },
  });
  await enable(bundle, "lingxing");

  const text = await bundle.automationAdapter.lingxingCacheSync({ days: 3 });
  assert.equal(text, "领星近 3 天数据已缓存，共 9 条");
  assert.equal(starts, 1, "启动作业只发生一次");
  assert.equal(polls, 2, "先看到 running，再看到 complete");
  assert.equal(sleeps, 1);
});

test("领星：作业 error → 结构化 INTEGRATION_INTERNAL，绝不冒充成功", async () => {
  const job = { id: "lx-2", status: "error", cacheDays: 1, rows: 0, error: "领星接口 500" };
  const bundle = createBundle({ lingxingJobSource: terminalSource(job) });
  await enable(bundle, "lingxing");

  await assert.rejects(() => bundle.automationAdapter.lingxingCacheSync({ days: 1 }), (error) => {
    assert.equal(error.code, "INTEGRATION_INTERNAL");
    assert.match(error.message, /领星接口 500/);
    return true;
  });
});

test("领星：作业状态丢失 → INTEGRATION_NOT_FOUND", async () => {
  const bundle = createBundle({ lingxingJobSource: { start: () => ({ id: "lx-3" }), get: () => null } });
  await enable(bundle, "lingxing");

  await assert.rejects(() => bundle.automationAdapter.lingxingCacheSync({ days: 1 }), (error) => {
    assert.equal(error.code, "INTEGRATION_NOT_FOUND");
    assert.match(error.message, /状态已丢失/);
    return true;
  });
});

test("领星：有界超时 → INTEGRATION_INTERNAL，只轮询一次且不谎报完成", async () => {
  const job = { id: "lx-4", status: "running", cacheDays: 1, rows: 0 };
  let now = BASE;
  let polls = 0;
  const source = { start: () => ({ id: job.id }), get: () => { polls += 1; return job; } };
  const bundle = createBundle({
    lingxingJobSource: source,
    clock: () => now,
    // 一次休眠跨过源 4 小时上限（automationBusinessActions.ts:21）。
    sleeper: async () => { now += 5 * 60 * 60 * 1000; },
  });
  await enable(bundle, "lingxing");

  await assert.rejects(() => bundle.automationAdapter.lingxingCacheSync({ days: 1 }), (error) => {
    assert.equal(error.code, "INTEGRATION_INTERNAL");
    assert.match(error.message, /领星缓存执行超时/);
    return true;
  });
  assert.equal(polls, 1, "超时前只轮询一次");
  assert.equal(job.status, "running", "作业未被谎报为完成");
});

// ── 紫鸟：success 的三种源口径文案 ────────────────────────────────────────
test("紫鸟：completed 的三种源口径文案（automationBusinessActions.ts:48-54）", async () => {
  const cases = [
    { stores: [{ status: "success", files: ["a.xlsx"], file: "a.xlsx" }], expect: "紫鸟下载完成：新增 1 个按日文件，检查 1 个店铺" },
    { stores: [{ status: "skipped", skippedExistingDays: 2 }], expect: "无需启动紫鸟：已检查 1 个店铺，所选日期均已有数据，跳过 2 个已有数据日" },
    { stores: [{ status: "skipped", skippedExistingDays: 0 }], expect: "紫鸟检查完成：1 个店铺没有需要下载的新数据" },
    { stores: [{ status: "success", files: ["a.xlsx"], file: "a.xlsx" }, { status: "skipped", skippedExistingDays: 3 }], expect: "紫鸟下载完成：新增 1 个按日文件，检查 2 个店铺，跳过 3 个已有数据日" },
  ];
  for (const item of cases) {
    const job = { id: "zn-0", status: "completed", stores: item.stores, error: "", message: "" };
    const bundle = createBundle({ ziniaoJobSource: terminalSource(job) });
    await enable(bundle, "ziniao");
    const text = await bundle.automationAdapter.ziniaoDownload({ days: 1, stores: ZINIAO_STORES });
    assert.equal(text, item.expect);
  }
});

// ── 紫鸟：failed / cancelled / 状态丢失 / 超时 / 等待期取消 ────────────────
test("紫鸟：failed → INTEGRATION_INTERNAL，绝不冒充成功", async () => {
  const job = { id: "zn-1", status: "failed", stores: [], error: "紫鸟下载异常结束。", message: "紫鸟下载任务异常结束。" };
  const bundle = createBundle({ ziniaoJobSource: terminalSource(job) });
  await enable(bundle, "ziniao");

  await assert.rejects(() => bundle.automationAdapter.ziniaoDownload({ days: 1, stores: ZINIAO_STORES }), (error) => {
    assert.equal(error.code, "INTEGRATION_INTERNAL");
    assert.match(error.message, /异常结束/);
    return true;
  });
});

test("紫鸟：stopped（用户停止=取消）→ INTEGRATION_CANCELLED，不归为成功也不归为普通失败", async () => {
  const job = { id: "zn-2", status: "stopped", stores: [], error: "", message: "任务已停止，已完成结果已保留。" };
  const bundle = createBundle({ ziniaoJobSource: terminalSource(job) });
  await enable(bundle, "ziniao");

  await assert.rejects(() => bundle.automationAdapter.ziniaoDownload({ days: 1, stores: ZINIAO_STORES }), (error) => {
    assert.equal(error.code, "INTEGRATION_CANCELLED");
    assert.match(error.message, /任务已停止/);
    return true;
  });
});

test("紫鸟：等待期间作业被停止 → 下一次轮询即如实归因取消（取消路径）", async () => {
  const job = { id: "zn-3", status: "running", stores: [], error: "", message: "" };
  let polls = 0;
  const source = { start: () => ({ id: job.id }), get: () => { polls += 1; return job; } };
  const bundle = createBundle({
    ziniaoJobSource: source,
    sleeper: async () => { job.status = "stopped"; job.message = "任务已停止，已完成结果已保留。"; },
  });
  await enable(bundle, "ziniao");

  await assert.rejects(() => bundle.automationAdapter.ziniaoDownload({ days: 1, stores: ZINIAO_STORES }), (error) => {
    assert.equal(error.code, "INTEGRATION_CANCELLED");
    return true;
  });
  assert.equal(polls, 2, "第一次 running，第二次已是 stopped");
});

test("紫鸟：作业状态丢失（id 不匹配）→ INTEGRATION_NOT_FOUND", async () => {
  const other = { id: "other", status: "running", stores: [] };
  const bundle = createBundle({ ziniaoJobSource: { start: () => ({ id: "zn-4" }), get: () => other } });
  await enable(bundle, "ziniao");

  await assert.rejects(() => bundle.automationAdapter.ziniaoDownload({ days: 1, stores: ZINIAO_STORES }), (error) => {
    assert.equal(error.code, "INTEGRATION_NOT_FOUND");
    assert.match(error.message, /状态已丢失/);
    return true;
  });
});

test("紫鸟：有界超时 → INTEGRATION_INTERNAL 且不谎报完成", async () => {
  const job = { id: "zn-5", status: "running", stores: [] };
  let now = BASE;
  const source = { start: () => ({ id: job.id }), get: () => job };
  const bundle = createBundle({
    ziniaoJobSource: source,
    clock: () => now,
    // 一次休眠跨过源 8 小时上限（automationBusinessActions.ts:44）。
    sleeper: async () => { now += 9 * 60 * 60 * 1000; },
  });
  await enable(bundle, "ziniao");

  await assert.rejects(() => bundle.automationAdapter.ziniaoDownload({ days: 1, stores: ZINIAO_STORES }), (error) => {
    assert.equal(error.code, "INTEGRATION_INTERNAL");
    assert.match(error.message, /紫鸟下载执行超时/);
    return true;
  });
  assert.equal(job.status, "running", "作业未被谎报为完成");
});

test("紫鸟：paused（需人工处理）→ INTEGRATION_INTERNAL 且带源提示语", async () => {
  const job = { id: "zn-6", status: "paused", stores: [], error: "", message: "「店铺一」连续触发 VC 限流，已停止自动重试；" };
  const bundle = createBundle({ ziniaoJobSource: terminalSource(job) });
  await enable(bundle, "ziniao");

  await assert.rejects(() => bundle.automationAdapter.ziniaoDownload({ days: 1, stores: ZINIAO_STORES }), (error) => {
    assert.equal(error.code, "INTEGRATION_INTERNAL");
    assert.match(error.message, /请在紫鸟 APP 中处理后继续/);
    return true;
  });
});

test("终态等待：超时上限可注入（clock + jobWaitTimeoutMs），超时即抛错", async () => {
  const job = { id: "lx-5", status: "running", cacheDays: 1, rows: 0 };
  let now = BASE;
  const source = { start: () => ({ id: job.id }), get: () => job };
  const bundle = createBundle({
    lingxingJobSource: source,
    clock: () => now,
    jobWaitTimeoutMs: 1000,
    sleeper: async () => { now += 2000; },
  });
  await enable(bundle, "lingxing");

  await assert.rejects(() => bundle.automationAdapter.lingxingCacheSync({ days: 1 }), (error) => {
    assert.match(error.message, /领星缓存执行超时/);
    return true;
  });
});

// ── automation 端到端：取消如实归类到 AUTOMATION_CANCELLED ────────────────
test("automation 端到端：等到 stopped → runNow 归类 AUTOMATION_CANCELLED", async () => {
  const job = { id: "zn-9", status: "running", stores: [], error: "", message: "" };
  const source = { start: () => ({ id: job.id }), get: () => job };
  const pluginBundle = createBundle({
    ziniaoJobSource: source,
    sleeper: async () => { job.status = "stopped"; job.message = "任务已停止，已完成结果已保留。"; },
  });
  await enable(pluginBundle, "ziniao");

  const idStore = new IdentityStore({ path: path.join(tempDir("dxos-sync-terminal-auto-"), "identity.db") }).open();
  openStores.push(idStore);
  const automation = createAutomationBundle({
    identityStore: idStore,
    authorization: { resolveActor: ({ context }) => (context && context.sessionRef ? { ok: true, user: { id: USER } } : { ok: false, error: "no-session" }) },
    clock: () => BASE,
    sleeper: async () => {},
    integrations: pluginBundle.automationAdapter,
  });
  const created = automationStore.createAutomation(USER, {
    instruction: "下载紫鸟",
    schedule: { type: "once", at: BASE + 1000 },
    action: { type: "ziniao_download", args: { days: 1, stores: ZINIAO_STORES } },
  });

  const result = await automation.execute("automation/runNow", { automationId: created.id, await: true }, { sessionRef: "sess-terminal", requestId: "req-terminal" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "AUTOMATION_CANCELLED", "取消必须如实归类，不能是 INTERNAL 或 DEPENDENCY_UNAVAILABLE");
  assert.match(String(result.message), /任务已停止/);
});
