/**
 * D3-04C UI 验收：真实 Electron 下的安全预览交付（text/image/thumbnail/pdf/audio/video）+ Trash 拒绝。
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
const probeDir = path.join(here, "fixtures", "resource-preview-ui-probe");
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
  child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
});
const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!match) {
  console.log("ERROR: UI 探针未输出结果");
  console.log("stdout:\n" + stdout.slice(0, 4000));
  console.log("stderr:\n" + stderr.slice(0, 4000));
  process.exit(1);
}
const report = JSON.parse(match[1]);
const failed = report.checks.filter((c) => !c.ok);
console.log("\n" + (report.checks.length - failed.length) + "/" + report.checks.length + " UI checks passed");
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n"));
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 800));
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name + " (" + f.detail + ")").join(" | "));
  process.exit(1);
}
assert.equal(exitCode, 0, "Electron 退出码 " + exitCode);
console.log("PASS: 安全预览交付（text / image+thumbnail / pdf / audio / video）、Range、无路径泄漏、Trash 拒绝在真实 Electron 中全部成立。");
