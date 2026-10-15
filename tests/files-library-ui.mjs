/**
 * Z2 · 访达窗口「加入资源库 / 导出」真机探针运行器。
 *
 * 本轮**不执行任何构建**：默认起一个只监听 127.0.0.1 的 Vite 预览（electron/main.cjs 明确
 * 支持的 OA_DEV_SERVER 模式，vite.config.ts 的 dev 插件会在 dev 期放宽 CSP），
 * 把源码直接喂给真实 electron。也可用 OA_FILES_LIBRARY_USE_DIST=1 改跑 dist/index.html。
 *
 * 产物：artifacts/files-library/*.png（浅/深截图）、files-library-flow.webm（连续录屏）、report.json。
 *
 * 用法：node tests/files-library-ui.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const ART = path.join(ROOT, "artifacts", "files-library");
const probeDir = path.join(here, "fixtures", "files-library-probe");
const electronPath = require("electron");
const USE_DIST = process.env.OA_FILES_LIBRARY_USE_DIST === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(ART, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

let vite = null;
let devURL = process.env.OA_DEV_SERVER || null;
if (!USE_DIST && !devURL) {
  const port = await freePort();
  devURL = "http://127.0.0.1:" + port + "/";
  const viteEnv = Object.assign({}, process.env, { NODE_ENV: "development" });
  vite = spawn(process.execPath, [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    env: viteEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let viteLog = "";
  vite.stdout.on("data", (d) => (viteLog += String(d)));
  vite.stderr.on("data", (d) => (viteLog += String(d)));
  const up = await waitHttp(devURL, 45000);
  if (!up) {
    console.error("Vite 预览未起来（45s）。输出：\n" + viteLog.slice(-1500));
    vite.kill("SIGKILL");
    process.exit(1);
  }
  console.log("Vite 预览：" + devURL + "（仅 127.0.0.1，未执行构建）");
} else if (USE_DIST) {
  if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
    console.error("缺少 dist/index.html");
    process.exit(1);
  }
  console.log("渲染源：dist/index.html（未执行构建）");
} else {
  console.log("复用外部 OA_DEV_SERVER：" + devURL);
}

const childEnv = Object.assign({}, process.env, devURL && !USE_DIST ? { OA_DEV_SERVER: devURL } : {});
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
const child = spawn(electronPath, [probeDir, "--no-sandbox"], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  stdout += String(d);
  process.stdout.write(String(d));
});
child.stderr.on("data", (d) => {
  stderr += String(d);
  process.stderr.write(String(d));
});
const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => child.kill("SIGKILL"), 300000);
  child.on("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
if (vite) {
  try {
    vite.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!match) {
  console.log("ERROR: 探针未输出结果");
  console.log("stdout:\n" + stdout.slice(-4000));
  console.log("stderr:\n" + stderr.slice(-3000));
  process.exit(1);
}
const report = JSON.parse(match[1]);
try {
  fs.writeFileSync(path.join(ART, "report.json"), JSON.stringify(report, null, 2));
} catch {
  /* 报告不是关键路径 */
}
const failed = report.checks.filter((c) => !c.ok);
console.log("");
console.log((report.checks.length - failed.length) + "/" + report.checks.length + " checks passed");
console.log("截图：" + report.screenshots.map((s) => s.file + " (" + s.width + "x" + s.height + ")").join(" · "));
console.log("录屏：" + (report.video || "（无）") + "（帧数 " + report.videoFrames + "）");
console.log("console error=" + report.console.errors.length + " 非本地请求=" + report.network.nonLocal.length);
console.log("白名单命令：resource=" + JSON.stringify(Array.from(new Set(report.commands.resource))) + " files=" + JSON.stringify(Array.from(new Set(report.commands.files))));
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n"));
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name + " (" + f.detail + ")").join(" | "));
  process.exit(1);
}
if (exitCode !== 0) {
  console.log("Electron 退出码 " + exitCode + "\nstderr:\n" + stderr.slice(-1500));
  process.exit(1);
}
console.log("PASS: 访达窗口「加入资源库 / 导出」在真实 Electron 中全部成立。");
console.log("报告：" + path.relative(ROOT, path.join(ART, "report.json")));
