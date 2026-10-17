#!/usr/bin/env node
/**
 * DXOS-CANVAS-PRUNE · 把 public/novai-canvas 裁剪成「只保留无限画布」。
 *
 * 策略唯一来源 = experiments/d5-02/vendor-novai-app.mjs 的 PAGE_WHITELIST + 依赖闭包
 * （/static/... 引用闭包 + EXTRA_KEEP）。本脚本只做**删除**，不拷贝、不注入，因此在没有上游检出
 * （OA_NOVAI_SRC / /tmp/novai-canvas-src）时也能执行；下次换上游 commit 重跑 vendor 脚本会得到同一结果。
 *
 * 用法：node experiments/dxos-canvas-prune/prune-public.mjs [--check]
 *   --check 只报告将要删什么（dry run），不落盘。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const OUT = path.join(ROOT, "public", "novai-canvas");
const STATIC = path.join(OUT, "static");
const VENDOR = path.join(ROOT, "experiments", "d5-02", "vendor-novai-app.mjs");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-prune");
const CHECK = process.argv.includes("--check");

/** bundle 根必须保留的文件（集成方式的核心：桥/适配/守卫 + 来源记录）。*/
const REQUIRED_ROOT = [
  "openarc-bridge.js",
  "openarc-adapter.js",
  "openarc-canvas-guard.js",
  // 智能画布唯一保留编辑器的命令适配器（第 14 处 vendor 改动；列表页入口全改向它）。
  "openarc-smart-adapter.js",
  // Electron 不支持 window.prompt：列表页与智能画布的重命名都靠它（vendor 脚本逐页注入）。
  "openarc-rename-modal.js",
  "SOURCE.md",
];
/** bundle 根**必须不存在**的文件：非产品外壳 index.html 已零引用（E4 边界测试改到产品页 canvas-list.html），
 *  换上游 commit 重跑 vendor 也不再生成它。留在这里是为了"放回去就报错"，而不是静默通过。
 *  openarc-shell.js 原先只注入那个外壳：外壳删除后全仓零加载，本轮裁决删除（vendor 第 5 步也清旧副本），
 *  同样"放回去就报错"。*/
const FORBIDDEN_ROOT = ["index.html", "openarc-shell.js"];

const vendor = await import(pathToFileURL(VENDOR).href);
const { all, keep, edges } = vendor.computeKeepSet(STATIC);
const dropped = all.filter((f) => !keep.has(f)).sort();
const kept = all.filter((f) => keep.has(f)).sort();
const sizeOf = (rel) => fs.statSync(path.join(STATIC, rel)).size;
const dropBytes = dropped.reduce((s, f) => s + sizeOf(f), 0);
const keptBytes = kept.reduce((s, f) => s + sizeOf(f), 0);

for (const rel of REQUIRED_ROOT) {
  if (!fs.existsSync(path.join(OUT, rel))) throw new Error("必须保留的 bundle 根文件缺失：" + rel);
}
for (const rel of FORBIDDEN_ROOT) {
  if (fs.existsSync(path.join(OUT, rel))) throw new Error("bundle 根不应再有这个文件（已判定零引用，见 PRUNE.md）：" + rel + " —— 请删除它，而不是把它放回来");
}

console.log("[prune] 源 static/ 文件 " + all.length + "；保留 " + kept.length + "；删除 " + dropped.length);
console.log("[prune] 保留 " + keptBytes + " bytes；删除 " + dropBytes + " bytes");
/* 交叉核对 vendor 清单：上游源文件数 / 实际保留 / 已在 vendor 阶段裁掉的数量。
   两个数字都自洽时，才说明「白名单 + 排除页集合 + 闭包」与落盘结果一致。*/
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "experiments", "d5-02", "vendor", "vendor-manifest.json"), "utf8"));
  console.log("[prune] vendor-manifest: 源 " + manifest.sourceFiles + " / 保留 " + manifest.files + " / 裁剪 " + manifest.prunedFiles + "（本次 bundle 内再删 " + dropped.length + "）");
  if (manifest.files !== all.length) throw new Error("vendor-manifest.files(" + manifest.files + ") 与 bundle static 实际文件数(" + all.length + ") 不一致");
  if (manifest.sourceFiles - manifest.prunedFiles !== manifest.files) throw new Error("vendor-manifest 源-裁剪≠保留");
} catch (e) {
  if (e && /不一致|≠/.test(String(e.message))) throw e;
}
for (const f of dropped) console.log("  - " + f + "  (" + sizeOf(f) + " B)");

if (!CHECK) {
  for (const f of dropped) fs.rmSync(path.join(STATIC, f), { force: true });
  // 清掉被删空的目录（只删 static/ 下的空目录，永不删 static/ 本身）
  const pruneEmpty = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      pruneEmpty(p);
      if (fs.readdirSync(p).length === 0) fs.rmSync(p, { recursive: true, force: true });
    }
  };
  pruneEmpty(STATIC);
  fs.mkdirSync(ART, { recursive: true });
  const afterFiles = (function walk(d, base, out = []) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join("/"));
    }
    return out;
  })(STATIC, STATIC);
  const afterBytes = afterFiles.reduce((s, f) => s + fs.statSync(path.join(STATIC, f)).size, 0);
  const report = {
    sourceFiles: all.length,
    keptFiles: kept.length,
    droppedFiles: dropped.length,
    keptBytes,
    dropBytes,
    afterFiles: afterFiles.length,
    afterBytes,
    pageWhitelist: vendor.PAGE_WHITELIST,
    extraKeep: vendor.EXTRA_KEEP,
    dropped,
    kept,
    edges,
  };
  fs.writeFileSync(path.join(ART, "prune-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("[prune] 落盘完成：static/ " + afterFiles.length + " files / " + afterBytes + " bytes");
  console.log("[prune] 报告：" + path.relative(ROOT, path.join(ART, "prune-report.json")));
}
