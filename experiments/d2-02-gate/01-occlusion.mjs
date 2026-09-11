/** 探针 01：遮挡与层级（视觉真值 + 真实鼠标输入路由）。 */
import { runNative, printCases, writeArtifact, hadRunAsNode } from "./lib/gate.mjs";

if (hadRunAsNode()) console.log("⚠️ 环境导出过 ELECTRON_RUN_AS_NODE，已在子进程中被剥离");
const report = await runNative("01-occlusion");
const stats = printCases("D2-02A · 遮挡与层级", report);
const file = writeArtifact("01-occlusion.json", report);
console.log("  artifact:", file);
console.log("  截图产物目录: artifacts/d2-02/01-*.png");
if (stats.failed > 0 || report.errors?.length) process.exit(1);
