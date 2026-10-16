#!/usr/bin/env node
/**
 * OpenArc OS · 把画布更新包同步到 ModelScope 仓库（应用默认更新源）。
 *
 * 同步内容（仓库内约定路径）：
 *   updates/canvas/latest.json
 *   updates/canvas/canvas-<version>.zip
 *
 * 实现只用 Node 内置模块 + 系统 git（不新增依赖）：浅克隆 ModelScope 仓库 → 覆盖 updates/ 下的文件
 * → commit → push。凭据只从环境变量 MODELSCOPE_TOKEN 读取（走 Secret），绝不进 argv / 日志。
 *
 * 用法（本机与 CI 同一条命令）：
 *   node scripts/oa-modelscope-sync.mjs --dry-run                       # 只校验产物，不联网
 *   MODELSCOPE_TOKEN=*** node scripts/oa-modelscope-sync.mjs            # 真正同步
 *   node scripts/oa-modelscope-sync.mjs                                 # 没 token → 明确提示「更新源未同步」并跳过
 *
 * 退出码：0 成功 / 跳过 / dry-run；2 参数错；3 产物缺失或摘要不一致；5 git 或网络失败。
 * 没有配置 MODELSCOPE_TOKEN 时**不假装成功**：打印「更新源未同步」并给出后果说明，退出码 0（这一步是可选的）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueOf = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const hasFlag = (flag) => args.includes(flag);
const die = (code, message) => { console.error("[oa-modelscope-sync] " + message); process.exit(code); };
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const updatesDir = path.resolve(valueOf("--updates") || path.join(ROOT, "dist-updates", "updates"));
const owner = valueOf("--owner") || "bllack";
const repo = valueOf("--repo") || "OpenArc-OS";
const branch = valueOf("--branch") || "master";
const dryRun = hasFlag("--dry-run");
const versionArg = valueOf("--version");
const token = process.env.MODELSCOPE_TOKEN || "";
const canvasDir = path.join(updatesDir, "canvas");
const latestFile = path.join(canvasDir, "latest.json");

// ── 产物校验（缺文件 / 摘要不符一律拒绝，不把坏产物推上去） ──────────────────
if (!fs.existsSync(latestFile)) die(3, "找不到 " + latestFile + "（先跑 node scripts/oa-canvas-package.mjs --version <ver> --source dist/novai-canvas）");
let latest;
try { latest = JSON.parse(fs.readFileSync(latestFile, "utf8")); }
catch { die(3, latestFile + " 不是合法 JSON"); }
const version = typeof latest.version === "string" ? latest.version : "";
if (!version) die(3, "latest.json 缺 version");
if (versionArg && version !== versionArg) die(3, "latest.json 的 version=" + version + " 与 --version " + versionArg + " 不一致");
const asset = typeof latest.asset === "string" ? latest.asset : "";
const expectedAsset = "updates/canvas/canvas-" + version + ".zip";
if (asset !== expectedAsset) die(3, "latest.json 的 asset 必须是 " + expectedAsset + "，实际 " + asset);
const zipFile = path.join(canvasDir, path.basename(asset));
if (!fs.existsSync(zipFile)) die(3, "找不到资产 " + zipFile);
const zipBytes = fs.readFileSync(zipFile);
const zipSha = sha256(zipBytes);
if (typeof latest.sha256 !== "string" || latest.sha256.toLowerCase() !== zipSha) {
  die(3, "latest.json.sha256 与资产 zip 不一致：latest=" + latest.sha256 + " / zip=" + zipSha);
}

const summary = [
  "版本：" + version + " / build：" + latest.build,
  "zip：" + zipFile + "（" + zipBytes.length + " 字节 / sha256 " + zipSha + "）",
  "清单：" + latestFile,
  "目标：" + owner + "/" + repo + "#" + branch + " → updates/canvas/",
];

if (dryRun) {
  console.log("[oa-modelscope-sync] dry-run：产物校验通过，未联网、未推送");
  for (const line of summary) console.log("  " + line);
  process.exit(0);
}

if (!token) {
  console.error("[oa-modelscope-sync] 更新源未同步：没有配置 MODELSCOPE_TOKEN，已跳过 ModelScope 同步。");
  console.error("[oa-modelscope-sync] 后果：应用默认更新源是 ModelScope（" + owner + "/" + repo + "），未同步时应用内「检查更新」看不到本版本；");
  console.error("[oa-modelscope-sync]       GitHub Release 仍然可用（可在应用里显式切到 github-releases 源）。");
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        "## ⚠️ 更新源未同步\n\n未配置 `MODELSCOPE_TOKEN` Secret，ModelScope（" + owner + "/" + repo + "）未同步本版本。\n");
    } catch { /* 拿不到 summary 不影响主流程 */ }
  }
  process.exit(0);
}

// ── 用 git 同步（token 只进子进程环境，不进 argv 之外的日志） ────────────────
function sanitize(text) {
  let out = String(text == null ? "" : text);
  if (token) out = out.split(token).join("***").split(encodeURIComponent(token)).join("***");
  return out;
}
function runGit(cwd, gitArgs, { allowFailure = false } = {}) {
  const result = spawnSync("git", gitArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const out = sanitize(result.stdout);
  const err = sanitize(result.stderr);
  if (result.status !== 0 && !allowFailure) {
    die(5, "git " + gitArgs[0] + " 失败（exit=" + result.status + "）：\n" + (err || out).trim().slice(0, 1500));
  }
  return { status: result.status, stdout: out, stderr: err };
}

const remoteUrl = "https://oauth2:" + encodeURIComponent(token) + "@www.modelscope.cn/" + owner + "/" + repo + ".git";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-modelscope-"));
try {
  let cloned = runGit(workDir, ["clone", "--depth", "1", "--branch", branch, remoteUrl, "repo"], { allowFailure: true });
  if (cloned.status !== 0) {
    cloned = runGit(workDir, ["clone", "--depth", "1", remoteUrl, "repo"], { allowFailure: true });
    if (cloned.status !== 0) die(5, "克隆 ModelScope 仓库失败：" + (cloned.stderr || cloned.stdout).trim().slice(0, 1500));
    runGit(path.join(workDir, "repo"), ["checkout", "-B", branch]);
  }
  const repoDir = path.join(workDir, "repo");
  runGit(repoDir, ["lfs", "install", "--local"], { allowFailure: true });

  const targetCanvasDir = path.join(repoDir, "updates", "canvas");
  fs.mkdirSync(targetCanvasDir, { recursive: true });
  fs.copyFileSync(latestFile, path.join(targetCanvasDir, "latest.json"));
  fs.copyFileSync(zipFile, path.join(targetCanvasDir, path.basename(asset)));

  runGit(repoDir, ["add", "--", "updates"]);
  const status = runGit(repoDir, ["status", "--porcelain"]);
  if (!status.stdout.trim()) {
    console.log("[oa-modelscope-sync] ModelScope 仓库已是同一版本，无需推送（" + owner + "/" + repo + "#" + branch + "）");
    process.exit(0);
  }
  runGit(repoDir, ["-c", "user.name=openarc-release-bot", "-c", "user.email=openarc-release-bot@users.noreply.github.com",
    "commit", "-m", "release(canvas): " + version]);
  runGit(repoDir, ["push", "origin", "HEAD:" + branch]);
  console.log("[oa-modelscope-sync] 已同步到 ModelScope：" + owner + "/" + repo + "#" + branch + " → updates/canvas/");
  for (const line of summary) console.log("  " + line);
} finally {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
}
