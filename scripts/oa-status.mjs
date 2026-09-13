#!/usr/bin/env node
/**
 * OpenArc OS · 统一状态总览（多 worktree / 多对话协作）
 *
 * 为什么需要它：同一个仓库会同时存在多个 worktree（每个对话一个），
 * 一旦出现"两个人往同一个工作目录写"或"某分支有未推送提交却没人知道"，
 * 排查成本极高（本轮已经踩过：分支被切走、别人的 WIP 混进 .app）。
 * 这个脚本把**唯一事实**打成一张表，任何人/任何对话跑一次就知道现状。
 *
 * 用法：npm run oa:status
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const APP = "/Users/wepingli/Desktop/OpenArc OS.app";
const MARKER = path.join(APP, "Contents/Resources/app/openarc-build.json");

const git = (args, cwd = REPO) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    return (e.stdout || "").toString().trim() || "<error>";
  }
};

function worktrees() {
  const raw = git(["worktree", "list", "--porcelain"]);
  const out = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), branch: "", head: "" };
      out.push(cur);
    } else if (line.startsWith("HEAD ") && cur) cur.head = line.slice(5, 13);
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line.startsWith("detached") && cur) cur.branch = "(detached)";
  }
  return out;
}

const rows = [];
const branchSeen = new Map();
for (const wt of worktrees()) {
  const dirty = git(["status", "--porcelain"], wt.path)
    .split("\n")
    .filter((l) => l.trim() && !l.includes("node_modules")).length;
  let unpushed = 0;
  const up = git(["rev-list", "--count", "@{u}..HEAD"], wt.path);
  if (/^\d+$/.test(up)) unpushed = Number(up);
  rows.push({ ...wt, dirty, unpushed });
  const key = wt.branch;
  if (key && key !== "(detached)") branchSeen.set(key, (branchSeen.get(key) || 0) + 1);
}

let marker = null;
try {
  marker = JSON.parse(fs.readFileSync(MARKER, "utf8"));
} catch {
  marker = null;
}

const pad = (s, n) => String(s).padEnd(n);
console.log("OpenArc OS · 统一状态总览");
console.log("=".repeat(84));
console.log(pad("WORKTREE", 42) + pad("BRANCH", 34) + pad("HEAD", 9) + pad("DIRTY", 6) + "UNPUSHED");
for (const r of rows) {
  console.log(pad(r.path, 42) + pad(r.branch || "?", 34) + pad(r.head, 9) + pad(r.dirty, 6) + r.unpushed);
}
console.log("");
console.log("─".repeat(84));
const dupes = [...branchSeen.entries()].filter(([, n]) => n > 1);
if (dupes.length) {
  console.log("⚠️  同一分支被多个 worktree 检出（最容易互相覆盖）：");
  for (const [b, n] of dupes) console.log("   - " + b + " × " + n);
} else {
  console.log("✅ 没有分支被重复检出（一个分支只归一个 worktree）。");
}
const dirtyWts = rows.filter((r) => r.dirty > 0);
console.log("");
console.log(dirtyWts.length ? "⚠️  有未提交改动的工作目录（其他对话的在途工作，别人不要动）：" : "✅ 所有工作目录都干净。");
for (const r of dirtyWts) console.log("   - " + r.path + "  (" + r.dirty + " 项)  branch=" + r.branch);
console.log("");
console.log("📦 当前 .app 的来源：");
if (marker) {
  console.log("   分支 " + marker.branch + " @ " + marker.commit + (marker.dirty ? "  ⚠️ 构建时工作区是脏的（含未提交改动）" : "  ✅ 构建自已提交状态"));
  console.log("   构建时间 " + marker.builtAt);
} else {
  console.log("   未记录（这份 .app 不是用 scripts/sync-app.mjs 构建的，无法判断是否含未提交改动）");
}
console.log("");
console.log("规则见 WORKTREES.md；只从已提交状态构建：npm run oa:app -- <ref>");
