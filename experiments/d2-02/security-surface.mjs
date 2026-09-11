/**
 * D2-02B · A13 安全回归运行器（§38）。打的是真实主进程与真实 preload。
 *
 * 与其它产品侧探针一样，靠 top-level await 动态 import gate.mjs ——
 * 因为 extraArgs 是在模块求值时读环境变量的。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { Probe, VERDICT } from "./lib/app.mjs";

const require = createRequire(import.meta.url);
/** 必须用 path.join，不能用 new URL(...).pathname —— 后者会把空格编码成 %20。 */
const nativeDir = path.join(import.meta.dirname, "native");

/** 本机 Chromium 沙箱无法初始化；由外层 runner 兜底，直接单跑时这里再兜一层。 */
if (!process.env.ELECTRON_EXTRA_ARGS)
  process.env.ELECTRON_EXTRA_ARGS = "--no-sandbox --disable-gpu-sandbox --in-process-gpu";

const { runNative, printCases, writeArtifact, hadRunAsNode } = await import("../d2-02-gate/lib/gate.mjs");

const p = new Probe("security-surface", "A13 安全回归 · window.openarc 暴露面与不可信视图");
if (hadRunAsNode()) p.note("执行环境导出了 ELECTRON_RUN_AS_NODE=1，已由 cleanEnv 显式剥离（否则 Electron 会退化成 Node 模式）");

const report = await runNative("02-security-surface", { nativeDir, timeout: 180000 });
const stats = printCases("A13 安全回归", report);
for (const c of report.cases) p.case(c.id, c.ok ? VERDICT.PASS : VERDICT.FAIL, c.ok ? "" : c.detail);
for (const e of report.errors) p.assert("probe.error", false, e);

const verdict = stats.failed || report.errors.length ? VERDICT.FAIL : VERDICT.PASS;
const file = writeArtifact("security-surface.json", { ...report, verdict, counts: stats });
console.log(`\n== ${p.id} 结论：${verdict} — ${JSON.stringify(stats)}`);
console.log(`   产物：${file}`);
process.exit(verdict === VERDICT.FAIL ? 1 : 0);
