/**
 * 探针时序加固工具（只被各探针 run-all.mjs 引用；不进产品构建、不新增依赖）。
 *
 * 背景：门禁机器常与用户自己的 Chrome / OpenArc OS 抢 CPU，loadavg 长期 5-10。
 * 页面计时器与 Playwright 轮询在高负载下会被整体拖慢（30s 的等待可能只推进几秒的状态机），
 * 于是原本"充裕"的硬编码超时（15s/20s/30s）偶发 TimeoutError；崩溃时浏览器不关，
 * 进程还会挂很久才退出，看起来像"跑了几百秒才失败"。
 *
 * 这里只做三件不改变任何断言与场景的事：
 *   1. 超时倍率：OA_PROBE_TIMEOUT_SCALE 显式指定；否则按 1 分钟 loadavg 相对 CPU 核数自适应（1..4 倍）。
 *   2. 有界重试：waitForSelector / goto / waitForFunction 失败后重试有限次，每次打印步骤、选择器与耗时；
 *      用尽后抛出带诊断的错误（不吞异常、不跳过、不改断言）。
 *   3. 崩溃守卫：未捕获异常时先打印"卡在哪一步"，关闭浏览器与本地服务再 exit 1，
 *      避免留下 Chromium 僵尸进程拖住 shell。
 */
import os from "node:os";

const EXPLICIT_SCALE = Number(process.env.OA_PROBE_TIMEOUT_SCALE);
const HAS_EXPLICIT_SCALE = Number.isFinite(EXPLICIT_SCALE) && EXPLICIT_SCALE > 0;
const CPUS = (os.cpus() || []).length || 1;
const LOAD1 = os.loadavg()[0] || 0;

/**
 * 高负载自适应倍率：loadavg1 每 4 个排队进程放大 1 倍（loadavg 0 → ×1，loadavg 8 → ×3），
 * 下限 ×1.25 给空闲时的渲染/编码留余量，上限 ×4 保证"永久卡住"仍会在有界时间内失败。
 * 用 loadavg 而不是 loadavg/cpu：实测 12 核机器 loadavg 6 时，浏览器计时器已经被拖慢数倍，
 * 按核数归一化反而几乎不放大。
 */
function autoScale() {
  return Math.min(4, Math.max(1.25, 1 + LOAD1 / 4));
}

export const TIMEOUT_SCALE = HAS_EXPLICIT_SCALE ? EXPLICIT_SCALE : autoScale();
export const SCALE_SOURCE = HAS_EXPLICIT_SCALE ? "OA_PROBE_TIMEOUT_SCALE" : "loadavg自适应";

/** 单次等待重试次数；总预算仍按放大后的 timeout 均分。 */
const WAIT_ATTEMPTS = Math.max(1, Math.floor(Number(process.env.OA_PROBE_WAIT_ATTEMPTS) || 3));
const NAV_ATTEMPTS = Math.max(1, Math.floor(Number(process.env.OA_PROBE_NAV_ATTEMPTS) || 3));
/** 整场景重试次数：某一步永久卡住时仍会用尽重试后失败，不会无限循环。 */
export const SCENARIO_ATTEMPTS = Math.max(1, Math.floor(Number(process.env.OA_PROBE_SCENARIO_ATTEMPTS) || 2));

export function scaled(ms) {
  return Math.max(1, Math.round(ms * TIMEOUT_SCALE));
}

export function timingSummary() {
  return (
    "超时倍率 ×" + TIMEOUT_SCALE.toFixed(2) + "（来源 " + SCALE_SOURCE +
    "；loadavg1=" + LOAD1.toFixed(2) + "，cpu=" + CPUS +
    "；可用 OA_PROBE_TIMEOUT_SCALE 覆盖）"
  );
}

/* ── 步骤跟踪：失败信息里点名"卡在哪一步" ──────────────────────────────── */
let currentStep = "启动";
export function setStep(name) {
  currentStep = name;
}
export function getStep() {
  return currentStep;
}

/* ── 崩溃守卫：打印卡住的步骤 → 关闭浏览器/本地服务 → exit 1 ────────────── */
const cleanups = [];
export function registerCleanup(fn) {
  cleanups.push(fn);
}
let guardInstalled = false;
export function installCrashGuard() {
  if (guardInstalled) return;
  guardInstalled = true;
  const onFatal = (err) => {
    console.error(String.fromCharCode(10) + "! 探针中断（卡在步骤：" + currentStep + "）");
    console.error((err && err.stack) || String(err));
    console.error("! " + timingSummary());
    Promise.allSettled(cleanups.map((fn) => Promise.resolve().then(fn))).then(() => process.exit(1));
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
}

function firstLine(err) {
  const msg = (err && err.message) ? String(err.message) : String(err);
  return msg.split(String.fromCharCode(10))[0];
}

function waitTag(selector, label) {
  return "选择器 " + selector + (label ? "（页面 " + label + "）" : "");
}

/* ── 有界重试的等待原语 ─────────────────────────────────────────────────── */
export async function boundedWaitForSelector(original, selector, options = {}, label = "") {
  const state = options.state || "visible";
  const timeout = options.timeout || 30000;
  const attempts = Math.max(1, options.attempts || WAIT_ATTEMPTS);
  const perAttempt = Math.max(500, Math.ceil(scaled(timeout) / attempts));
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    const t0 = Date.now();
    try {
      const handle = await original(selector, { ...options, timeout: perAttempt, state });
      if (i > 1) console.log("    ↻ 等待达成 " + waitTag(selector, label) + "（第 " + i + "/" + attempts + " 次，本次 " + (Date.now() - t0) + "ms）");
      return handle;
    } catch (err) {
      lastErr = err;
      console.log("    … 等待未达成 " + waitTag(selector, label) + "（第 " + i + "/" + attempts + " 次，本次 " + (Date.now() - t0) + "ms，state=" + state + "）");
    }
  }
  throw new Error(
    "等待超时：" + waitTag(selector, label) + "；步骤「" + currentStep + "」；已做 " + attempts +
    " 次有界重试、每次上限 " + perAttempt + "ms（基线 " + timeout + "ms × 倍率 " + TIMEOUT_SCALE.toFixed(2) +
    "）。最后一次：" + firstLine(lastErr),
  );
}

async function boundedWaitForFunction(original, fn, arg, options = {}, label = "") {
  const timeout = (options && options.timeout) || 30000;
  const attempts = Math.max(1, (options && options.attempts) || WAIT_ATTEMPTS);
  const perAttempt = Math.max(500, Math.ceil(scaled(timeout) / attempts));
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    const t0 = Date.now();
    try {
      const handle = await original(fn, arg, { ...(options || {}), timeout: perAttempt });
      if (i > 1) console.log("    ↻ 条件等待达成（页面 " + label + "，第 " + i + "/" + attempts + " 次，本次 " + (Date.now() - t0) + "ms）");
      return handle;
    } catch (err) {
      lastErr = err;
      console.log("    … 条件等待未达成（页面 " + label + "，第 " + i + "/" + attempts + " 次，本次 " + (Date.now() - t0) + "ms）");
    }
  }
  throw new Error(
    "条件等待超时（页面 " + label + "）；步骤「" + currentStep + "」；已做 " + attempts + " 次有界重试、每次上限 " +
    perAttempt + "ms（基线 " + timeout + "ms × 倍率 " + TIMEOUT_SCALE.toFixed(2) + "）。最后一次：" + firstLine(lastErr),
  );
}

/**
 * 给一个 Playwright Page 挂上"按倍率放大 + 有界重试"的等待。
 * 只改等待方式，不改任何断言：选择器/条件原样使用，重试用尽后照旧抛错。
 * 幂等：同一 page 调两次只生效一次。
 */
export function hardenPage(page, label = "page") {
  if (!page || page.__oaHardened) return page;
  page.__oaHardened = true;
  const originalWaitForSelector = page.waitForSelector.bind(page);
  const originalWaitForTimeout = page.waitForTimeout.bind(page);
  const originalWaitForFunction = page.waitForFunction.bind(page);
  const originalGoto = page.goto.bind(page);

  page.setDefaultTimeout(scaled(30000));
  page.setDefaultNavigationTimeout(scaled(60000));

  page.waitForSelector = (selector, options = {}) => boundedWaitForSelector(originalWaitForSelector, selector, options, label);
  page.waitForTimeout = (ms) => originalWaitForTimeout(scaled(ms));
  page.waitForFunction = (fn, arg, options = {}) => boundedWaitForFunction(originalWaitForFunction, fn, arg, options, label);
  page.goto = async (url, options = {}) => {
    const timeout = scaled((options && options.timeout) || 60000);
    let lastErr = null;
    for (let i = 1; i <= NAV_ATTEMPTS; i += 1) {
      const t0 = Date.now();
      try {
        return await originalGoto(url, { waitUntil: "domcontentloaded", ...(options || {}), timeout });
      } catch (err) {
        lastErr = err;
        console.log("    … 导航未完成 " + url + "（第 " + i + "/" + NAV_ATTEMPTS + " 次，本次 " + (Date.now() - t0) + "ms）");
      }
    }
    throw new Error(
      "导航超时：" + url + "；步骤「" + currentStep + "」；已做 " + NAV_ATTEMPTS + " 次有界重试、每次上限 " +
      timeout + "ms。最后一次：" + firstLine(lastErr),
    );
  };
  return page;
}

/** Chromium 启动也做有界重试：高负载下偶发启动失败不应直接判定探针失败。 */
export async function launchChromiumBounded(browserType, options, attempts = NAV_ATTEMPTS) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    const t0 = Date.now();
    try {
      return await browserType.launch(options);
    } catch (err) {
      lastErr = err;
      console.log("    … 启动 Chromium 失败（第 " + i + "/" + attempts + " 次，本次 " + (Date.now() - t0) + "ms）：" + firstLine(err));
    }
  }
  throw new Error("Chromium 启动失败（已做 " + attempts + " 次有界重试）：" + firstLine(lastErr));
}

/**
 * 整场景有界重试。onAttemptStart(i) 用于回滚上一次尝试写入的断言/截图集合，
 * 保证 report 里的断言总数只统计最终成功的那一次（不因重试膨胀、也不跳过任何断言）。
 */
export async function withRetries(label, attempts, run, onAttemptStart) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    setStep(label + "（第 " + i + "/" + attempts + " 次）");
    if (onAttemptStart) onAttemptStart(i);
    const t0 = Date.now();
    try {
      return await run(i);
    } catch (err) {
      lastErr = err;
      const msg = firstLine(err);
      if (i < attempts) console.log("! " + label + " 第 " + i + "/" + attempts + " 次失败（" + (Date.now() - t0) + "ms），重试整个场景：" + msg);
      else console.log("! " + label + " 第 " + i + "/" + attempts + " 次失败（" + (Date.now() - t0) + "ms）：" + msg);
    }
  }
  throw new Error("场景「" + label + "」在 " + attempts + " 次有界重试后仍失败：" + firstLine(lastErr));
}
