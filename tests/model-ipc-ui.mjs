/** D4-01 Closure A · model:command IPC Electron 验收。 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const probeDir = path.join(here, "fixtures", "model-ipc-probe");
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);
if (!fs.existsSync(path.join(here, "..", "dist", "index.html"))) { console.error("缺少 dist/index.html"); process.exit(1); }
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
const child = spawn(electronPath, [probeDir, ...extraArgs], { stdio: ["ignore", "pipe", "pipe"], env });
let stdout = ""; let stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
const code = await new Promise((resolve) => { const t = setTimeout(() => child.kill("SIGKILL"), 180000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
const m = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!m) { console.log("ERROR: 未输出结果\n" + stdout.slice(0, 3000) + "\n" + stderr.slice(0, 2000)); process.exit(1); }
const report = JSON.parse(m[1]);
const failed = report.checks.filter((c) => !c.ok);
console.log("\n" + (report.checks.length - failed.length) + "/" + report.checks.length + " IPC checks passed");
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 600));
if (failed.length) { console.log("FAILED: " + failed.map((x) => x.name + " (" + x.detail + ")").join(" | ")); process.exit(1); }
assert.equal(code, 0, "Electron exit " + code);
console.log("PASS: model:command IPC 边界（白名单 / write-only / 无 raw secret）在真实 Electron 中成立。");
