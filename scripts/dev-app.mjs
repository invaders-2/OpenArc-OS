#!/usr/bin/env node
/**
 * OpenArc OS · 实时预览（一条命令：Vite dev server + 仓库里的 Electron）
 *
 * 解决的问题：`npm run desktop` 每次都要 build + 重启，改一行 CSS 也要等一整轮。
 * 这里让 Electron 直接打开 dev server，渲染层走 Vite HMR —— 存盘即更新。
 *
 * 三条硬约束：
 *   1. **userData 必须隔离**。默认用 `openarc-os-preview`（不是产品的 `openarc-os`）：
 *      公共目录的身份库可能已被别的分支升到更高 schema，本分支打不开会白屏。
 *      用 `--user-data <路径>` 可换。
 *   2. **只有显式设了 OA_DEV_SERVER 才走 dev URL**（见 electron/main.cjs）。
 *      所以这个脚本不影响产品构建 / `npm run oa:app`，它们仍是原来的 file:// 产物。
 *   3. **Ctrl+C 一次收干净**：Vite 与 Electron 各自成进程组，退出时整组 SIGTERM。
 *
 * 额外行为：`electron/` 下的主进程代码没有 HMR，改动后自动重启 Electron
 * （渲染层 HMR 不受影响）；用 `--no-watch` 关掉。
 * 重启要**等旧进程真的退出**再拉新的：同一个 userData 的 Chromium profile
 * 不能两个实例同时打开；也不能用固定延时，Electron 的优雅退出可能比延时还慢。
 *
 * 用法：
 *   npm run dev:app
 *   npm run dev:app -- --port 5180
 *   npm run dev:app -- --user-data "/tmp/oa-preview"
 *   npm run dev:app -- --no-watch
 *   npm run dev:app -- --remote-debugging-port=9223   # 其余参数原样转给 Electron
 *   npm run dev:app -- --app "/Users/.../OpenArc OS.app"      # 用某个 .app 自带的 Electron 预览
 *
 * --app 为什么存在：预览要与发布出去的 .app 共用同一个 Electron 运行时；同时 userData 必须
 * 跟仓库 Electron 的预览目录错开，否则两个实例抢同一个 Chromium profile 会打不开。
 * 它只换运行时二进制与 userData，页面仍加载仓库代码 —— 否则 electron/ 改动重启后加载的
 * 还是 .app 里的旧载荷，热重启就失去意义。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

function defaultUserDataDir() {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openarc-os-preview");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "openarc-os-preview");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "openarc-os-preview");
}

// ── 参数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const passthrough = [];
let port = 5173;
let userDataDir = defaultUserDataDir();
let userDataExplicit = false;
let appBundle = null;
let watchMain = true;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--port") port = Number(argv[++i]);
  else if (arg === "--user-data") {
    userDataDir = path.resolve(argv[++i]);
    userDataExplicit = true;
  } else if (arg === "--app") appBundle = path.resolve(argv[++i]);
  else if (arg === "--no-watch") watchMain = false;
  else passthrough.push(arg);
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("[dev:app] --port 需要一个 1-65535 的端口号");
  process.exit(2);
}
if (appBundle && !appBundle.endsWith(".app")) {
  console.error("[dev:app] --app 需要一个以 .app 结尾的路径");
  process.exit(2);
}
const bundleBinary = appBundle ? path.join(appBundle, "Contents/MacOS/Electron") : null;
if (bundleBinary && !fs.existsSync(bundleBinary)) {
  console.error("[dev:app] 找不到 " + bundleBinary + "（--app 指向的不是一个完整的 .app？）");
  process.exit(2);
}
if (appBundle && !userDataExplicit) {
  const slug = path.basename(appBundle, ".app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  userDataDir = path.join(path.dirname(defaultUserDataDir()), slug + "-preview");
}

const devURL = `http://127.0.0.1:${port}`;
const viteBin = path.join(REPO, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
if (!fs.existsSync(viteBin)) {
  console.error("[dev:app] 找不到 Vite（" + viteBin + "），先 npm install");
  process.exit(2);
}
// --app 时改用该 bundle 自带的 Electron；其余参数与工作目录不变，所以 electron/ 改动重启后仍生效。
const electronPath = bundleBinary || require("electron");

// ── 进程状态 ──────────────────────────────────────────────────────────────
const isPosix = process.platform !== "win32";
let vite = null;
let electronChild = null;
let shuttingDown = false;
let restarting = false;
let restartQueued = false;
let restartTimer = null;
let watcher = null;

function killTree(child, signal = "SIGTERM") {
  if (!child || !child.pid) return;
  try {
    if (isPosix) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* 已经退出 */
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartTimer);
  try {
    watcher?.close();
  } catch {
    /* 没起来 */
  }
  killTree(vite);
  killTree(electronChild);
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ── Vite ──────────────────────────────────────────────────────────────────
function startVite() {
  console.log(`[dev:app] Vite dev server → ${devURL}`);
  vite = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: REPO,
    stdio: "inherit",
    env: process.env,
    detached: isPosix,
  });
  vite.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[dev:app] Vite 退出了（code ${code}）—— 端口被占用？`);
    shutdown(typeof code === "number" ? code : 1);
  });
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok || res.status < 500) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// ── Electron（含主进程自动重启） ──────────────────────────────────────────
/** 从带 ELECTRON_RUN_AS_NODE 的 shell 启动会退化成纯 Node（main.cjs 里 app 为 undefined）；预览必须按 GUI 启动，两种运行时都清掉。 */
function electronEnv() {
  const env = { ...process.env, OA_DEV_SERVER: devURL };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function startElectron() {
  // 第一个参数 "." 是 app path：始终指向仓库，这样主进程代码就是被监听、可重启的那一份。
  const child = spawn(electronPath, [".", `--user-data-dir=${userDataDir}`, ...passthrough], {
    cwd: REPO,
    stdio: "inherit",
    env: electronEnv(),
    detached: isPosix,
  });
  electronChild = child;
  child.on("exit", (code) => {
    if (electronChild === child) electronChild = null;
    if (shuttingDown || child.__restarting) return;
    if (code === 0 || !watchMain) {
      // 正常关窗 / 没开监听：整个 dev:app 收工
      shutdown(typeof code === "number" ? code : 0);
      return;
    }
    console.error("[dev:app] Electron 异常退出。仍在监听 electron/，改一下主进程文件即可自动重启；Ctrl+C 结束。");
  });
}

function restartElectron() {
  if (shuttingDown) return;
  if (restarting) {
    // 上一次重启还没落地，合并成一次
    restartQueued = true;
    return;
  }
  const old = electronChild;
  if (!old) {
    startElectron();
    return;
  }
  restarting = true;
  old.__restarting = true;
  electronChild = null;
  console.log("\n[dev:app] electron/ 有改动 → 自动重启主进程（渲染层 HMR 不受影响）");

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    restarting = false;
    if (shuttingDown) return;
    startElectron();
    if (restartQueued) {
      restartQueued = false;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(restartElectron, 150);
    }
  };

  if (old.exitCode !== null || old.signalCode !== null) {
    killTree(old);
    finish();
    return;
  }
  // 等旧 Electron 真的退出再拉新的：同一个 userData 不能两个实例同时开
  old.once("exit", finish);
  killTree(old);
  setTimeout(() => {
    if (finished) return;
    killTree(old, "SIGKILL");
    finish();
  }, 4000);
}

function scheduleRestart() {
  if (shuttingDown) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restartElectron, 150);
}

function watchMainProcess() {
  if (!watchMain) return;
  try {
    watcher = fs.watch(path.join(REPO, "electron"), { recursive: true }, (_event, filename) => {
      if (filename && !/\.(cjs|mjs|js|json)$/.test(filename)) return;
      scheduleRestart();
    });
  } catch (error) {
    console.error("[dev:app] 主进程自动重启没启用：" + error.message);
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────────
console.log("[dev:app] OpenArc OS 实时预览" + (appBundle ? "（Electron 来自 " + appBundle + "）" : ""));
console.log(`[dev:app] userData   ${userDataDir}（与产品的 openarc-os 隔离）`);
console.log("[dev:app] src/ 改动 → Vite HMR；electron/ 改动 → " + (watchMain ? "自动重启主进程" : "需要手动重启（--no-watch）"));
console.log("[dev:app] Ctrl+C 同时收掉 Vite 与 Electron\n");

startVite();
if (!(await waitForServer(devURL + "/"))) {
  console.error("[dev:app] Vite dev server 没在 30s 内就绪");
  shutdown(1);
} else {
  startElectron();
  watchMainProcess();
}
