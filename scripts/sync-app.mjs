#!/usr/bin/env node
/**
 * OpenArc OS · 只从**已提交状态**构建并同步 .app
 *
 * 为什么必须这样：直接从工作区构建会把**未提交的在途改动**一起编进用户正在预览的 .app
 * （本轮真实踩过：另一个对话的 WIP 被编进去，谁都不知道）。这里改成：
 *   在临时 detached worktree 里 checkout 某个 ref → 构建 → 同步 → 删掉临时 worktree。
 * 于是 .app 的内容**永远等于某个 commit**，并在载荷里写下来源标记（oa-status 会读它）。
 *
 * 用法：
 *   node scripts/sync-app.mjs                 # 用当前分支的 HEAD
 *   node scripts/sync-app.mjs <ref>           # 用任意 commit / 分支 / tag
 *   node scripts/sync-app.mjs <ref> --no-restart
 *   node scripts/sync-app.mjs --copy-from /path/to/worktree   # 逃生口：显式从某目录构建
 *   node scripts/sync-app.mjs <ref> --app "/Users/.../OpenArc OS.app"      # 同步到另一个 .app
 *
 * --app 为什么存在：同一个仓库要同时跑两个可并存的 .app（产品 + DX），而"退出/重启"这类
 * 动作天生是全局的（同名就退同名就开）。把目标路径显式传进来，每个 .app 的退出都只认自己的
 * 绝对路径与 bundle id，参照应用不会被误伤。目标 .app 不存在时按同源底座现造一个。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyDshRuntimeClosure } from "./dsh-runtime-closure.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const DEFAULT_APP = "/Users/wepingli/Desktop/OpenArc OS.app";
/** 同源底座：与参照应用同一份 Electron（44.3.0），新建 .app 时直接复制它。 */
const ELECTRON_DIST_APP = path.join(REPO, "node_modules/electron/dist/Electron.app");

const args = process.argv.slice(2);
const noRestart = args.includes("--no-restart");
const copyIdx = args.indexOf("--copy-from");
const copyFrom = copyIdx >= 0 ? args[copyIdx + 1] : null;
const appIdx = args.indexOf("--app");
const appRaw = appIdx >= 0 ? args[appIdx + 1] : null;
if (appIdx >= 0 && (!appRaw || appRaw.startsWith("--") || !appRaw.endsWith(".app"))) {
  console.error('[sync-app] --app 需要一个以 .app 结尾的路径，例如 --app "/Users/wepingli/Desktop/OpenArc OS.app"');
  process.exit(2);
}
const appArg = appRaw ? path.resolve(appRaw) : null;
const APP = appArg || DEFAULT_APP;
const APPX = path.join(APP, "Contents/Resources/app");
const ref = args.find((a) => !a.startsWith("--") && a !== copyFrom && a !== appRaw) || "HEAD";

const run = (cmd, argv, cwd = REPO) => execFileSync(cmd, argv, { cwd, stdio: ["ignore", "inherit", "inherit"] });
const out = (cmd, argv, cwd = REPO) => execFileSync(cmd, argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const appDisplayName = path.basename(APP, ".app");
/** 载荷名决定 userData 目录：参照应用占着 openarc-os，新 .app 必须错开才能同时运行。 */
const payloadName = slug(appDisplayName);
const bundleId = (() => {
  const suffix = payloadName.replace(/^openarc-os-?/, "");
  return suffix ? "com.openarc.os." + suffix : "com.openarc.os";
})();

/**
 * 目标 .app 不存在时按同源底座现造：
 * 复制 Electron.app 后只改 CFBundleName / CFBundleDisplayName / CFBundleIdentifier，
 * 其余字段（可执行名、图标槽、最低系统版本、版本号）逐字沿用底座。
 * 默认路径不存在时不介入 —— 原有失败行为保持原样。
 */
function createBundle() {
  if (!appArg || fs.existsSync(APP)) return false;
  if (!fs.existsSync(ELECTRON_DIST_APP)) throw new Error("找不到 Electron 底座: " + ELECTRON_DIST_APP);
  console.log("[sync-app] 新建 .app：" + ELECTRON_DIST_APP + " → " + APP);
  execFileSync("ditto", [ELECTRON_DIST_APP, APP], { stdio: ["ignore", "inherit", "inherit"] });
  const plist = path.join(APP, "Contents/Info.plist");
  execFileSync("plutil", ["-replace", "CFBundleName", "-string", appDisplayName, plist]);
  execFileSync("plutil", ["-replace", "CFBundleDisplayName", "-string", appDisplayName, plist]);
  execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", bundleId, plist]);
  console.log("[sync-app] bundle 身份：" + appDisplayName + " / " + bundleId + " / 载荷 " + payloadName);
  return true;
}

/** 只按本 bundle 的绝对路径与 bundle id 定位：按显示名退出有被 AppleScript 模糊匹配到参照应用的风险。 */
function quitRunningApp() {
  if (!appArg) {
    try {
      execFileSync("osascript", ["-e", 'tell application "OpenArc OS" to quit'], { stdio: "ignore" });
    } catch {
      /* 未运行 */
    }
    try {
      execFileSync("pkill", ["-f", "OpenArc OS.app/Contents/MacOS/Electron"], { stdio: "ignore" });
    } catch {
      /* 未运行 */
    }
    return;
  }
  let id = null;
  try {
    id = out("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(APP, "Contents/Info.plist")]);
  } catch {
    /* 没读到 plist 就只剩路径兜底 */
  }
  if (id) {
    try {
      execFileSync("osascript", ["-e", `tell application id "${id}" to quit`], { stdio: "ignore" });
    } catch {
      /* 未运行 */
    }
  }
  try {
    execFileSync("pkill", ["-f", APP + "/Contents/MacOS/Electron"], { stdio: "ignore" });
  } catch {
    /* 未运行 */
  }
}

/** 下载来的包会带隔离标记，不清掉会被 Gatekeeper 拦在启动前。 */
function clearQuarantine() {
  let listing = "";
  try {
    listing = execFileSync("xattr", ["-lr", APP], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return false;
  }
  if (!listing.includes("com.apple.quarantine")) return false;
  execFileSync("xattr", ["-dr", "com.apple.quarantine", APP], { stdio: ["ignore", "inherit", "inherit"] });
  console.log("[sync-app] 已清除 com.apple.quarantine");
  return true;
}

let srcDir = copyFrom;
let tmp = null;
let branch = "?";
let commit = "?";
let dirty = false;

if (copyFrom) {
  branch = out("git", ["branch", "--show-current"], copyFrom) || "(detached)";
  commit = out("git", ["rev-parse", "--short", "HEAD"], copyFrom);
  dirty = out("git", ["status", "--porcelain"], copyFrom).split("\n").filter((l) => l.trim() && !l.includes("node_modules")).length > 0;
  console.log("[sync-app] ⚠️ --copy-from：从工作目录构建，dirty=" + dirty);
} else {
  const resolved = out("git", ["rev-parse", ref]);
  commit = resolved.slice(0, 7);
  branch = out("git", ["rev-parse", "--abbrev-ref", ref]) || "(detached)";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-build-"));
  console.log("[sync-app] 干净检出 " + ref + " (" + commit + ") → " + tmp);
  run("git", ["worktree", "add", "--detach", tmp, resolved]);
  srcDir = tmp;
  try {
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"));
  } catch {
    /* 已存在 */
  }
}

if (!fs.existsSync(path.join(srcDir, "src"))) throw new Error("源目录不像仓库: " + srcDir);
run("npm", ["run", "build"], srcDir);
createBundle();

fs.rmSync(path.join(APPX, "dist"), { recursive: true, force: true });
fs.rmSync(path.join(APPX, "electron"), { recursive: true, force: true });
fs.rmSync(path.join(APPX, "resources"), { recursive: true, force: true });
fs.mkdirSync(APPX, { recursive: true });
fs.cpSync(path.join(srcDir, "dist"), path.join(APPX, "dist"), { recursive: true });
fs.cpSync(path.join(srcDir, "electron"), path.join(APPX, "electron"), { recursive: true });
// 随包资源（本地市场清单 / 随包技能包 / 厂商目录约定）必须在载荷内，
// 否则 market-service.cjs 与 skill-pack.cjs 的 <appDir>/resources 查找在打包后落空。
const srcResources = path.join(srcDir, "resources");
if (fs.existsSync(srcResources)) fs.cpSync(srcResources, path.join(APPX, "resources"), { recursive: true });
fs.copyFileSync(path.join(srcDir, "package.json"), path.join(APPX, "package.json"));

// task-55：打包后的 app 没有仓库 node_modules；DSH harness 必须能在 <app>/node_modules 内
// 找到 PIN 版本的 @deepseek-ai/dsh、ACP SDK、完整依赖闭包与 .bin/dsh。
// 只复制真实依赖闭包（不复制仓库全部 node_modules），并在复制后校验 PIN 版本。
const appNodeModules = path.join(APPX, "node_modules");
fs.rmSync(appNodeModules, { recursive: true, force: true });
const dshRuntime = copyDshRuntimeClosure({ root: srcDir, destNodeModules: appNodeModules });
console.log("[sync-app] DSH runtime closure: " + dshRuntime.packages + " packages, " + (dshRuntime.bytes / 1024 / 1024).toFixed(1) + " MiB, " + dshRuntime.versions.map((v) => v.name + "@" + v.version).join(", "));

// task-66：随包 Node。GUI 由 Finder 启动时 PATH 里没有 node；DSH 绝不能依赖用户 PATH。
// 直接复制当前构建所用 Node（与 dsh 版本兼容）到 app/node_modules/.bin/node，harness 会优先使用它。
const bundledNode = path.join(appNodeModules, ".bin", "node");
try {
  const sourceNode = fs.realpathSync(process.execPath);
  fs.copyFileSync(sourceNode, bundledNode);
  fs.chmodSync(bundledNode, 0o755);
  console.log("[sync-app] bundled node: " + sourceNode + " → " + bundledNode);
} catch (error) {
  throw new Error("无法随包复制 Node: " + ((error && error.message) || error));
}

if (appArg) {
  // 只改载荷这一份拷贝：Electron 用 package.json 的 name 决定 userData 目录，
  // 从而与参照应用各自一份数据、可同时运行；仓库里的 package.json 一个字不动。
  const pkgPath = path.join(APPX, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.name = payloadName;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

const icon = path.join(srcDir, "build", "icon.icns");
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(APP, "Contents/Resources/electron.icns"));

const marker = { branch, commit, dirty, ref, builtAt: new Date().toISOString(), by: "scripts/sync-app.mjs" };
if (appArg) Object.assign(marker, { app: APP, payloadName });
fs.writeFileSync(path.join(APPX, "openarc-build.json"), JSON.stringify(marker, null, 2));

run("codesign", ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements", APP]);
clearQuarantine();
if (!noRestart) {
  quitRunningApp();
  execFileSync("sleep", ["2"]);
  if (appArg) {
    // 从带 ELECTRON_RUN_AS_NODE 的 shell 里 open 会把 .app 当纯 Node 启动后立刻退出；
    // Finder 双击没有这个变量，所以只在 --app 路径上清掉它，默认行为保持原样。
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    execFileSync("open", ["-a", APP], { env, stdio: ["ignore", "inherit", "inherit"] });
  } else {
    run("open", ["-a", APP]);
  }
}

if (tmp) run("git", ["worktree", "remove", "--force", tmp]);
console.log("[sync-app] ✅ .app 现在 = " + branch + " @ " + commit + (dirty ? "（含未提交改动）" : "（纯已提交状态）") + (appArg ? "  → " + APP : ""));
