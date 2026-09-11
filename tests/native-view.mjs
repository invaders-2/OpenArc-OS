/**
 * D1-01 原生视图验收：拉起真实 Electron，在 tests/fixtures/native-probe 中
 * 于主进程内直接断言窗口生命周期、WebContentsView、会话隔离与几何收拢。
 *
 * 不依赖 Playwright：本环境 Playwright 1.55 与 Chromium 152 的 CDP 握手超时
 * （_electron.launch 与 connectOverCDP 均失败），而主进程断言不需要浏览器驱动。
 *
 * 本机 Chromium 沙箱无法初始化时传：
 *   ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu"
 * 该情形下渲染进程沙箱的运行时强制属于 NOT VERIFIED。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const probeDir = path.join(here, "fixtures", "native-probe");
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

// 执行环境若导出 ELECTRON_RUN_AS_NODE，Electron 会退化成 Node 模式
// （process.type === undefined，require("electron") 拿到 npm 包里的二进制路径字符串），
// 探针会在 app.whenReady 处崩溃。这是环境产物，不是项目缺陷，必须显式剥离。
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

const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!match) {
  console.log("ERROR: 探针未输出结果");
  console.log("stdout:\n" + stdout.slice(0, 2000));
  console.log("stderr:\n" + stderr.slice(0, 2000));
  process.exit(1);
}

const report = JSON.parse(match[1]);
const failed = report.checks.filter((c) => !c.ok);
console.log(
  `\n${report.checks.length - failed.length}/${report.checks.length} native checks passed`,
);
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n"));
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 800));

if (failed.length) {
  console.log("FAILED: " + failed.map((f) => `${f.name} (${f.detail})`).join(" | "));
  process.exit(1);
}
assert.equal(exitCode, 0, `Electron 退出码 ${exitCode}`);
console.log(
  "PASS: 原生窗口生命周期、WebContentsView 真实实例、会话隔离与几何收拢均通过。",
);
