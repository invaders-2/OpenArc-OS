/** 探针 02：输入路由与对话框阻断（§9 / §17）。 */
import { runNative, printCases, writeArtifact } from "./lib/gate.mjs";

const report = await runNative("02-input");
const stats = printCases("D2-02A · 输入路由与对话框阻断", report);
const file = writeArtifact("02-input.json", report);
console.log("  artifact:", file);
if (stats.failed > 0 || report.errors?.length) process.exit(1);
