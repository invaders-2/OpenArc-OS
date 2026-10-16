/**
 * Vue「项目」+「组织治理」迁移验收驱动（真实 Electron）。
 *
 * 驱动方式与 experiments/vue-mcp/run.mjs 完全相同：主进程自持窗口 +
 * executeJavaScript，页面换成 dist/vue.html。探针自身在 experiments/vue-governance/main.cjs。
 *
 * 需要先 npm run build。本机沙箱起不来时传：
 *   ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu"
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

if (!fs.existsSync(path.join(ROOT, "dist", "vue.html"))) {
  console.error("缺少 dist/vue.html —— 请先执行 npm run build");
  process.exit(1);
}

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electronPath, [here, ...extraArgs], {
  stdio: ["ignore", "pipe", "pipe"],
  env: childEnv,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += String(d)));
child.stderr.on("data", (d) => (stderr += String(d)));

const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => child.kill("SIGKILL"), 240000);
  child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
});

const versionMatch = stdout.match(/VERSIONS (\{.*\})/);
if (versionMatch) console.log("运行时：" + versionMatch[1]);

const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!match) {
  console.log("ERROR: Vue 治理探针未输出结果");
  console.log("stdout:\n" + stdout.slice(0, 4000));
  console.log("stderr:\n" + stderr.slice(0, 4000));
  process.exit(1);
}

const report = JSON.parse(match[1]);
const failed = report.checks.filter((c) => !c.ok);
const shots = stdout.split("\n").filter((l) => l.startsWith("SHOT "));
console.log("\n" + stdout.split("RESULT ")[0].trimEnd());
if (shots.length) console.log("\n截图：\n" + shots.join("\n"));
console.log("\n" + (report.checks.length - failed.length) + "/" + report.checks.length + " Vue 项目/治理 checks passed");
if (report.missingContract && report.missingContract.length) console.log("缺失契约：" + report.missingContract.join(", "));
if (report.conditionalContract && report.conditionalContract.length) console.log("条件契约（源码存在、本次未触发）：" + report.conditionalContract.join(", "));
if (report.consoleErrors && report.consoleErrors.length) console.log("CONSOLE ERRORS:\n" + report.consoleErrors.join("\n"));
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n"));
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 1600));

if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name + " (" + f.detail + ")").join(" | "));
  process.exit(1);
}
assert.equal(exitCode, 0, "Electron 退出码 " + exitCode);
console.log("PASS: Vue 项目与组织治理（契约全集 / 真实命令 / 基本交互 / 无 console error）在真实 Electron 中成立。");
