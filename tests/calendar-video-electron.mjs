import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const ROOT = path.resolve(import.meta.dirname, "..");
if (!fs.existsSync(path.join(ROOT, "dist/vue.html"))) throw new Error("请先执行 npm run build");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-calendar-video-two-phase-"));
const extra = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
let failed = false;
async function run(restart) {
  const env = { ...process.env, OPENARC_IDENTITY_ADMIN: "1", OA_2B_USER_DATA: userData, OA_2B_RESTART: restart ? "1" : "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(electronPath, [path.join(ROOT, "tests/fixtures/calendar-video-probe"), ...extra], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((resolve) => { const timer = setTimeout(() => child.kill("SIGKILL"), 180000); child.on("exit", (value) => { clearTimeout(timer); resolve(value); }); });
  const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
  if (!match) { console.log(stdout.slice(-5000)); console.log(stderr.slice(-3000)); return false; }
  const report = JSON.parse(match[1]);
  for (const line of stdout.split("\n")) if (/^PASS|^FAIL/.test(line)) console.log(line);
  const failures = report.checks.filter((item) => !item.ok);
  console.log(`${restart ? "重启" : "首进程"} ${report.checks.length - failures.length}/${report.checks.length} checks passed`);
  console.log(`功能=${report.functional} 视觉=${report.visual} 动效=${report.motion}`);
  if (report.errors.length) console.log(report.errors.join("\n"));
  if (report.screenshots.length) console.log("截图:\n" + report.screenshots.join("\n"));
  if (stderr.trim()) console.log(stderr.trim().slice(0, 1200));
  return code === 0 && !failures.length && !report.errors.length;
}
try {
  if (!await run(false)) failed = true;
  if (!failed && !await run(true)) failed = true;
} finally { fs.rmSync(userData, { recursive: true, force: true }); }
if (failed) process.exit(1);
