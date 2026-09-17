/**
 * Showcase：拉起真实 Electron 跑一遍产品主流程并对真实屏幕截图。
 * 产物落在 artifacts/showcase/，再交给 tests/showcase-report.mjs 生成展示页。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const probeDir = path.join(here, "fixtures", "showcase");
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  console.error("缺少 dist/index.html —— 请先执行 npm run build");
  process.exit(1);
}

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electronPath, [probeDir, ...extraArgs], {
  stdio: ["ignore", "pipe", "pipe"],
  env: childEnv,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += String(d)));
child.stderr.on("data", (d) => (stderr += String(d)));

const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
  child.on("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});

const versionMatch = stdout.match(/VERSIONS (\{.*\})/);
if (versionMatch) console.log("运行时：" + versionMatch[1]);

const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!match) {
  console.log("ERROR: showcase 探针未输出结果");
  console.log("stdout:\n" + stdout.slice(0, 3000));
  console.log("stderr:\n" + stderr.slice(0, 3000));
  process.exit(1);
}

const report = JSON.parse(match[1]);
fs.writeFileSync(path.join(root, "artifacts", "showcase", "report.json"), JSON.stringify(report, null, 2));

const failed = report.checks.filter((c) => !c.ok);
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed`);
console.log(`截图 ${report.shots.length} 张 → artifacts/showcase/`);
if (report.errors.length) console.log("ERRORS:\n" + report.errors.join("\n"));
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 1000));
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => `${f.name} (${f.detail})`).join(" | "));
  process.exit(1);
}
console.log(`PASS: 真实 Electron 全流程跑通（退出码 ${exitCode}）。`);
