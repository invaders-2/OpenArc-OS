import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { startD4Provider } from "./fixtures/d4-04-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const ROOT = path.resolve(import.meta.dirname, "..");
if (!fs.existsSync(path.join(ROOT, "dist/index.html"))) throw new Error("请先执行 npm run build");
const provider = await startD4Provider();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-canvas-agent-two-phase-"));
const extra = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
let failed = false;

async function runProbe(restart) {
  const env = { ...process.env, OPENARC_D4_PROVIDER_URL: provider.baseUrl, OPENARC_IDENTITY_ADMIN: "1", OPENARC_AGENT_USER_DATA: userData, OPENARC_AGENT_RESTART: restart ? "1" : "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(electronPath, [path.join(ROOT, "tests/fixtures/canvas-agent-probe"), ...extra], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const code = await new Promise((resolve) => { const timer = setTimeout(() => child.kill("SIGKILL"), 240000); child.on("exit", (value) => { clearTimeout(timer); resolve(value); }); });
  const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
  if (!match) { console.log(stdout.slice(-5000)); console.log(stderr.slice(-3000)); return false; }
  const report = JSON.parse(match[1]);
  const failures = report.checks.filter((item) => !item.ok);
  for (const line of stdout.split("\n")) if (/^PASS|^FAIL|HARNESS|RUNTIME_LOG/.test(line)) console.log(line);
  console.log(`${restart ? "重启" : "首进程"} ${report.checks.length - failures.length}/${report.checks.length} checks passed`);
  if (report.errors.length) console.log(report.errors.join("\n"));
  if (report.screenshots.length) console.log("截图:\n" + report.screenshots.join("\n"));
  if (stderr.trim()) console.log(stderr.trim().slice(0, 1200));
  return !failures.length && code === 0 && !report.errors.length;
}

try {
  if (!await runProbe(false)) failed = true;
  if (!failed && !await runProbe(true)) failed = true;
} finally {
  await provider.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
}
if (failed) process.exit(1);
