/** 探针 06：双浏览器 + 覆盖层连续压力流程（§39），由产品真实 occlusion 模块驱动。 */
import { runNative, printCases, writeArtifact } from "./lib/gate.mjs";

const report = await runNative("06-stress", { timeout: 420000 });
const stats = printCases("D2-02A · 连续压力流程（15 步）", report);
if (report.summary) {
  console.log("\n  步序与 plan：");
  for (const m of report.summary.modes) console.log("    " + m);
  console.log("  焦点持有者计数：", report.summary.focusOwners.join(" | "));
  console.log(`  采样点 ${report.summary.totalSamples}，不一致 ${report.summary.totalMismatches}`);
}
const file = writeArtifact("06-stress.json", report);
console.log("  artifact:", file);
if (stats.failed > 0 || report.errors?.length) process.exit(1);
