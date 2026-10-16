/**
 * Vue「MCP 中心」+「Skill 中心」迁移验收驱动（真实 Electron）。
 *
 * 驱动方式与 experiments/vue-resource/run.mjs 完全相同：主进程自持窗口 +
 * executeJavaScript，页面换成 dist/vue.html。探针自身在 experiments/vue-mcp/main.cjs。
 *
 * 额外起一个**真实受控 MCP 服务**（tests/fixtures/mcp/echo-server.mjs --http，只监听
 * 127.0.0.1:0），把它作为 mcp/create 的端点 —— 连接握手与能力/工具发现因此是真实的，
 * 不是假数据。服务就绪后把端口经 OA_VUE_MCP_URL 交给探针主进程。
 *
 * 需要先 npm run build。本机沙箱起不来时传：
 *   ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu"
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
const ROOT = path.resolve(here, "../..");
const ECHO = path.join(ROOT, "tests", "fixtures", "mcp", "echo-server.mjs");
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

if (!fs.existsSync(path.join(ROOT, "dist", "vue.html"))) {
  console.error("缺少 dist/vue.html —— 请先执行 npm run build");
  process.exit(1);
}

const echo = spawn(process.execPath, [ECHO, "--http", "--port=0"], { stdio: ["ignore", "pipe", "pipe"] });
let echoStderr = "";
echo.stderr.on("data", (d) => { echoStderr += String(d); });
let echoInfo;
try {
  echoInfo = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("echo-server 未在 8s 内就绪：" + echoStderr)), 8000);
    echo.stdout.on("data", (d) => {
      buf += String(d);
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try { clearTimeout(timer); resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { clearTimeout(timer); reject(e); }
    });
    echo.on("exit", (code) => { clearTimeout(timer); reject(new Error("echo-server 提前退出：" + code + " " + echoStderr)); });
  });
} catch (e) {
  console.error(String((e && e.message) || e));
  try { echo.kill("SIGKILL"); } catch (err) { /* ignore */ }
  process.exit(1);
}
const mcpUrl = echoInfo.url || ("http://127.0.0.1:" + echoInfo.port + "/mcp");
console.log("MCP 测试服务：" + mcpUrl);

const childEnv = { ...process.env, OA_VUE_MCP_URL: mcpUrl };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electronPath, [here, ...extraArgs], {
  stdio: ["ignore", "pipe", "pipe"],
  env: childEnv,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += String(d)));
child.stderr.on("data", (d) => (stderr += String(d)));

const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => child.kill("SIGKILL"), 240000);
  child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
});

try { echo.kill("SIGKILL"); } catch (e) { /* ignore */ }

const versionMatch = stdout.match(/VERSIONS (\{.*\})/);
if (versionMatch) console.log("运行时：" + versionMatch[1]);

const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!match) {
  console.log("ERROR: Vue MCP 探针未输出结果");
  console.log("stdout:\n" + stdout.slice(0, 4000));
  console.log("stderr:\n" + stderr.slice(0, 4000));
  process.exit(1);
}

const report = JSON.parse(match[1]);
const failed = report.checks.filter((c) => !c.ok);
const shots = stdout.split("\n").filter((l) => l.startsWith("SHOT "));
console.log("\n" + stdout.split("RESULT ")[0].trimEnd());
if (shots.length) console.log("\n截图：\n" + shots.join("\n"));
console.log("\n" + (report.checks.length - failed.length) + "/" + report.checks.length + " Vue MCP/Skill checks passed");
if (report.missingContract && report.missingContract.length) console.log("缺失契约：" + report.missingContract.join(", "));
if (report.consoleErrors && report.consoleErrors.length) console.log("CONSOLE ERRORS:\n" + report.consoleErrors.join("\n"));
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n"));
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 1600));

if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name + " (" + f.detail + ")").join(" | "));
  process.exit(1);
}
assert.equal(exitCode, 0, "Electron 退出码 " + exitCode);
console.log("PASS: Vue MCP 中心与 Skill 中心（契约全集 / 真实握手 / 基本交互 / 无 console error）在真实 Electron 中成立。");
