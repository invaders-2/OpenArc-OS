/**
 * D3-03 设备 UI 验收：拉起**真实 Electron**（dist/index.html + 产品 preload +
 * 与产品同一条接线 registerIdentityIpc/device），驱动系统设置 →「设备」pane。
 *
 * 不依赖 Playwright（本环境与 Electron CDP 握手超时，与 identity-ui /
 * authorization-ui 同一替代路径）。
 * 本机沙箱起不来时传 ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu"。
 * 需要先 npm run build。
 *
 * 输出约定：每一项 PASS / FAIL；探针无法在当前环境验证的项**显式**打印
 * NOT VERIFIED 并说明原因，绝不假装通过。
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
const probeDir = path.join(here, "fixtures", "device-ui-probe");
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

if (!fs.existsSync(path.join(here, "..", "dist", "index.html"))) {
  console.error("缺少 dist/index.html —— 请先执行 npm run build");
  process.exit(1);
}

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electronPath, [probeDir, ...extraArgs], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += String(d)));
child.stderr.on("data", (d) => (stderr += String(d)));

const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => child.kill("SIGKILL"), 240000);
  child.on("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});

const versionMatch = stdout.match(/VERSIONS (\{.*\})/);
if (versionMatch) console.log("运行时：" + versionMatch[1]);

const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!match) {
  console.log("ERROR: UI 探针未输出结果");
  console.log("stdout:\n" + stdout.slice(0, 4000));
  console.log("stderr:\n" + stderr.slice(0, 4000));
  process.exit(1);
}

const report = JSON.parse(match[1]);
const failed = report.checks.filter((c) => !c.ok);
// 逐项列出：通过项与失败项都要可见，NOT VERIFIED 单独成段（见下）。
for (const c of report.checks) console.log((c.ok ? "PASS" : "FAIL") + " " + c.name + (c.detail ? " :: " + c.detail : ""));
console.log("\n" + (report.checks.length - failed.length) + "/" + report.checks.length + " UI checks passed");

if (report.notVerified?.length) {
  console.log("NOT VERIFIED (" + report.notVerified.length + "):");
  for (const nv of report.notVerified) console.log("  - " + nv.name + " :: " + nv.reason);
}
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n"));
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 1200));

if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name + " (" + f.detail + ")").join(" | "));
  process.exit(1);
}
assert.equal(exitCode, 0, "Electron 退出码 " + exitCode);
console.log("PASS: 设备 pane 列表 / 状态区分 / 配对 join code / 撤销禁用反馈 / 未知 reasonCode 在真实 Electron 中全部成立。");
