/**
 * D2-02B · 原生视图生命周期与遮挡结算探针（§11 / §12 / §13 / §17 / §35）。
 *
 * 打的是产品真实模块 `electron/native-view-controller.cjs`，不是等价物 ——
 * 因此它能看到 DOM 侧探针看不到的东西。上一轮它就抓到一处静默失效：
 * 控制器读 `plan.strategy`，而 occlusion.plan() 返回的字段名是 `mode`。
 *
 * 宿主目录用 experiments/d2-02/native（不是 Gate 的那个），
 * 但复用 Gate 的运行器，从而复用 `ELECTRON_RUN_AS_NODE` 剥离逻辑。
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// 必须在 import gate.mjs 之前设置：它在模块求值时就把该变量读成常量。
// 本机 Chromium 沙箱无法初始化（Operation not permitted → GPU 进程挂 → FATAL）。
if (!process.env.ELECTRON_EXTRA_ARGS)
  process.env.ELECTRON_EXTRA_ARGS = "--no-sandbox --disable-gpu-sandbox --in-process-gpu";

const here = path.dirname(fileURLToPath(import.meta.url));
const { runNative, printCases, writeArtifact, hadRunAsNode } = await import("../d2-02-gate/lib/gate.mjs");

const nativeDir = path.join(here, "native");
const report = await runNative("01-lifecycle", { nativeDir });
const stats = printCases("native-view-lifecycle", report);
const verdict = stats.failed ? "FAIL" : report.errors.length ? "PARTIAL" : "PASS";

const file = writeArtifact("native-view-lifecycle.json", {
  id: "native-view-lifecycle",
  title: "原生视图生命周期与遮挡结算（打产品真实控制器）",
  verdict,
  counts: { PASS: stats.passed, FAIL: stats.failed },
  environment: { ...report.env, hadElectronRunAsNode: hadRunAsNode() },
  notes: [
    "本探针直接 require electron/native-view-controller.cjs —— 被结论覆盖的是产品代码本身。",
    "关键守卫：结算结果的 mode 必须落在 live / clip+snapshot / snapshot / hidden 之内；",
    "undefined 说明控制器与 occlusion.plan 的字段口径错位，会让整条遮挡链路静默失效。",
    "未覆盖：真实多显示器、GPU 合成性能、快照在大页面下的耗时。",
  ],
  cases: report.cases,
  probeErrors: report.errors,
  finishedAt: new Date().toISOString(),
});

console.log(`\n== native-view-lifecycle 结论：${verdict} — ${JSON.stringify({ PASS: stats.passed, FAIL: stats.failed })}`);
console.log(`   产物：${fs.realpathSync(file)}`);
process.exit(stats.failed ? 1 : 0);
