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
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const APP = "/Users/wepingli/Desktop/OpenArc OS.app";
const APPX = path.join(APP, "Contents/Resources/app");

const args = process.argv.slice(2);
const noRestart = args.includes("--no-restart");
const copyIdx = args.indexOf("--copy-from");
const copyFrom = copyIdx >= 0 ? args[copyIdx + 1] : null;
const ref = args.find((a) => !a.startsWith("--") && a !== copyFrom) || "HEAD";

const run = (cmd, argv, cwd = REPO) => execFileSync(cmd, argv, { cwd, stdio: ["ignore", "inherit", "inherit"] });
const out = (cmd, argv, cwd = REPO) => execFileSync(cmd, argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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

fs.rmSync(path.join(APPX, "dist"), { recursive: true, force: true });
fs.rmSync(path.join(APPX, "electron"), { recursive: true, force: true });
fs.mkdirSync(APPX, { recursive: true });
fs.cpSync(path.join(srcDir, "dist"), path.join(APPX, "dist"), { recursive: true });
fs.cpSync(path.join(srcDir, "electron"), path.join(APPX, "electron"), { recursive: true });
fs.copyFileSync(path.join(srcDir, "package.json"), path.join(APPX, "package.json"));

const icon = path.join(srcDir, "build", "icon.icns");
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(APP, "Contents/Resources/electron.icns"));

fs.writeFileSync(
  path.join(APPX, "openarc-build.json"),
  JSON.stringify({ branch, commit, dirty, ref, builtAt: new Date().toISOString(), by: "scripts/sync-app.mjs" }, null, 2),
);

run("codesign", ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements", APP]);
if (!noRestart) {
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
  execFileSync("sleep", ["2"]);
  run("open", ["-a", APP]);
}

if (tmp) run("git", ["worktree", "remove", "--force", tmp]);
console.log("[sync-app] ✅ .app 现在 = " + branch + " @ " + commit + (dirty ? "（含未提交改动）" : "（纯已提交状态）"));
