#!/usr/bin/env node
/**
 * OpenArc OS · 从自写源目录生成随包技能包 ZIP
 *
 * 为什么需要它：resources/bundled-skill-packages/ 下的 ZIP 必须是**可审阅内容**的产物，
 * 不允许手改二进制。这里把每个含 SKILL.md 的顶层源目录，按固定顺序（字典序）打成
 * <目录名>.zip，使用 electron/skill-import.cjs 的 buildZip（store 压缩、零第三方依赖、
 * 不执行包内文件），与产品导入端读到的是同一个 ZIP 语义。
 *
 * 用法：
 *   node scripts/build-bundled-skill-packages.mjs            # 生成/刷新全部
 *   node scripts/build-bundled-skill-packages.mjs --check    # 只校验 ZIP 与源目录一致（CI 用）
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildZip } = require("../electron/skill-import.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = path.join(ROOT, "resources", "bundled-skill-packages");
const SKIP = new Set(["node_modules", ".git"]);

function walk(dir, relative, out) {
  const names = fs.readdirSync(dir).sort();
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const abs = path.join(dir, name);
    const rel = relative ? relative + "/" + name : name;
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(abs, rel, out);
    else if (stat.isFile()) out.push({ name: rel, data: fs.readFileSync(abs) });
  }
}

/** 顶层源目录：含 SKILL.md 的目录（标准包可能把 SKILL.md 放子目录，这里按递归判定）。 */
function sourceDirs() {
  if (!fs.existsSync(PACKAGES_DIR)) return [];
  return fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIP.has(entry.name))
    .map((entry) => entry.name)
    .filter((name) => {
      const stack = [path.join(PACKAGES_DIR, name)];
      while (stack.length) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
          else if (/^SKILL\.md$/i.test(entry.name)) return true;
        }
      }
      return false;
    })
    .sort();
}

/**
 * 打进 ZIP 时**不带源目录前缀**（内容位于包根），这是标准包 `skill.json` + `SKILL.md`
 * 与 Agent Skills 包两种格式都认的布局；源目录名只用于决定 <name>.zip 的文件名。
 */
function buildOne(name) {
  const dir = path.join(PACKAGES_DIR, name);
  const entries = [];
  walk(dir, "", entries);
  if (!entries.length) throw new Error("源目录为空：" + name);
  return buildZip(entries);
}

const checkOnly = process.argv.includes("--check");
const names = sourceDirs();
let written = 0;
let ok = 0;
for (const name of names) {
  const zipPath = path.join(PACKAGES_DIR, name + ".zip");
  const next = buildOne(name);
  if (checkOnly) {
    const current = fs.existsSync(zipPath) ? fs.readFileSync(zipPath) : null;
    if (!current || !current.equals(next)) {
      console.error("[bundled-skill-packages] 不一致：" + name + ".zip（请重新生成）");
      process.exitCode = 1;
    } else {
      ok += 1;
    }
    continue;
  }
  fs.writeFileSync(zipPath, next);
  written += 1;
  console.log("[bundled-skill-packages] " + name + " → " + path.relative(ROOT, zipPath) + " (" + next.length + " B)");
}
if (checkOnly) console.log("[bundled-skill-packages] --check 通过 " + ok + " / " + names.length);
else console.log("[bundled-skill-packages] 生成 " + written + " 个 ZIP");
