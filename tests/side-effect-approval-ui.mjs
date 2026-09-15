/**
 * D4-03C4 UI 验收：真实 Electron 驱动产品页面 + preload + Trusted Approval Gateway，
 * 验证最小但 production 的 Approval UI（渲染 / 批准 / 拒绝 / stale / spoof / 0 leak）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const probeDir = path.join(here, "fixtures", "side-effect-ui-probe");
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
  console.log("stdout:\n" + stdout.slice(0, 3000));
  console.log("stderr:\n" + stderr.slice(0, 3000));
  process.exit(1);
}
const report = JSON.parse(match[1]);
const failed = report.checks.filter((c) => !c.ok);
console.log("\n" + (report.checks.length - failed.length) + "/" + report.checks.length + " UI checks passed");
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n"));
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 1200));
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name + " (" + f.detail + ")").join(" | "));
} else {
  console.log("PASS: D4-03C4 Trusted Approval UI 全部成立。");
}
process.exit(failed.length || exitCode !== 0 ? 1 : 0);
