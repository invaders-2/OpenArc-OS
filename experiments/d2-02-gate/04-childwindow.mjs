/** 探针 04：候选 D —— 原生 child 窗口的收益与代价（§6 / §7）。 */
import { runNative, printCases, writeArtifact } from "./lib/gate.mjs";

const report = await runNative("04-childwindow");
const stats = printCases("D2-02A · 候选 D 原生 child 窗口", report);
const file = writeArtifact("04-childwindow.json", report);
console.log("  artifact:", file);
if (stats.failed > 0 || report.errors?.length) process.exit(1);
