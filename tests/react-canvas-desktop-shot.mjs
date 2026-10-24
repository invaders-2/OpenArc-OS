/**
 * 真实 Electron 截图：首次初始化 → 登录 → 打开 canvas 窗口 → 截新 React 画布。
 *
 *   npm run build && node tests/react-canvas-desktop-shot.mjs
 * （dist 已是最新时可直接 node tests/react-canvas-desktop-shot.mjs）
 *
 * 隔离：探针把身份库与 Chromium userData 都指向项目内 .tmp-react-canvas-shot-* 临时目录，
 * 结束后连同临时目录一起删除；账号是现场新建的测试账号，不读取任何用户凭据。
 * 本机沙箱起不来时：ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu"。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const probeDir = path.join(here, "fixtures", "react-canvas-shot-probe");
const shot = path.join(root, "artifacts/tapnow-parity/react-canvas/50-desktop-canvas.png");

if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  console.error("缺少 dist/index.html —— 请先执行 npm run build");
  process.exit(1);
}

const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "--no-sandbox --disable-gpu-sandbox --in-process-gpu")
  .split(" ")
  .filter(Boolean);

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

// 探针退出时 Chromium 子进程可能还攥着目录，主进程内的 rmSync 会失败；
// 外层在 Electron 完全退出后再兜底清理项目内临时 profile（只认本项目前缀）。
const cleanupProfiles = () => {
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith(".tmp-react-canvas-shot-")) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  }
};
cleanupProfiles();

const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!match) {
  console.log("ERROR: 截图探针未输出结果");
  console.log("stdout:\n" + stdout.slice(0, 3000));
  console.log("stderr:\n" + stderr.slice(0, 3000));
  process.exit(1);
}

const report = JSON.parse(match[1]);
const failed = report.checks.filter((c) => !c.ok);
console.log("\n" + (report.checks.length - failed.length) + "/" + report.checks.length + " checks passed");
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n"));
if (report.diagnostics && report.diagnostics.consoleErrors && report.diagnostics.consoleErrors.length) {
  console.log("PAGE ERRORS:\n" + report.diagnostics.consoleErrors.join("\n"));
}
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 800));
if (report.screenshot) console.log("截图: " + shot + " (" + report.screenshot.bytes + " bytes)");

if (failed.length || exitCode !== 0) {
  const names = failed.map((f) => f.name + " (" + f.detail + ")").join(" | ");
  console.log("FAILED: " + names + " exit=" + exitCode);
  process.exit(1);
}
console.log("PASS: 真实 Electron 中初始化→登录→打开 canvas 窗口→截取新 React 画布成功。");
