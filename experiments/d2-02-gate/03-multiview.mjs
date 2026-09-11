/** 探针 03：多原生视图、生命周期与会话（§11 / §12 / §13）。 */
import { runNative, printCases, writeArtifact } from "./lib/gate.mjs";

const report = await runNative("03-multiview");
const stats = printCases("D2-02A · 多视图生命周期与会话", report);
const file = writeArtifact("03-multiview.json", report);
console.log("  artifact:", file);
if (stats.failed > 0 || report.errors?.length) process.exit(1);
