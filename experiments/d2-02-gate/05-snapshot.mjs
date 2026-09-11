/** 探针 05：快照补齐策略 vs 收缩 vs 整块隐藏（§8 / §10）。 */
import { runNative, printCases, writeArtifact } from "./lib/gate.mjs";

const report = await runNative("05-snapshot");
const stats = printCases("D2-02A · 部分遮挡的三种缓解策略", report);
const file = writeArtifact("05-snapshot.json", report);
console.log("  artifact:", file);
if (stats.failed > 0 || report.errors?.length) process.exit(1);
