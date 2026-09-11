/** 仪器校验：先证明测量手段可信，再谈架构。 */
import { runNative, printCases, writeArtifact } from "./lib/gate.mjs";

const report = await runNative("00-instrument");
const stats = printCases("D2-02A · 仪器校验", report);
console.log("  env:", JSON.stringify(report.env));
console.log("  probes:", JSON.stringify(report.probes, null, 1));
const file = writeArtifact("00-instrument.json", report);
console.log("  artifact:", file);

if (stats.failed > 0 || report.errors?.length) process.exit(1);
console.log("\n仪器可用：可以开始做架构实测。");
