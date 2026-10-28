import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const ROOT = path.resolve(import.meta.dirname, "..");
if (!fs.existsSync(path.join(ROOT, "dist/vue.html"))) throw new Error("请先执行 npm run build");
const env = { ...process.env, OPENARC_IDENTITY_ADMIN: "1" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
const extra = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu").split(" ").filter(Boolean);
const child = spawn(electronPath, [path.join(ROOT, "tests/fixtures/upload-consent-probe"), ...extra], { env, stdio: ["ignore", "pipe", "pipe"] });
let stdout = ""; let stderr = "";
child.stdout.on("data", (data) => { stdout += data; });
child.stderr.on("data", (data) => { stderr += data; });
const code = await new Promise((resolve) => { const timer = setTimeout(() => child.kill("SIGKILL"), 120000); child.on("exit", (value) => { clearTimeout(timer); resolve(value); }); });
const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!match) { console.log(stdout.slice(-5000)); console.log(stderr.slice(-3000)); process.exit(1); }
const report = JSON.parse(match[1]);
for (const line of stdout.split("\n")) if (/^PASS|^FAIL/.test(line)) console.log(line);
const failed = report.checks.filter((item) => !item.ok);
console.log(`${report.checks.length - failed.length}/${report.checks.length} checks passed`);
if (report.errors.length) console.log(report.errors.join("\n"));
if (report.screenshots.length) console.log("截图:\n" + report.screenshots.join("\n"));
if (stderr.trim()) console.log(stderr.trim().slice(0, 1200));
if (failed.length || report.errors.length || code !== 0) process.exit(1);
