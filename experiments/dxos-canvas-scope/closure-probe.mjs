/**
 * DXOS-CANVAS-SCOPE · 只读闭包口径实测（解释器，不写 bundle）。
 *
 * 复用 `experiments/d5-02/vendor-novai-app.mjs` 导出的 `extractStaticRefs`，
 * 用**收窄后**的白名单（canvas-list + smart-canvas）与排除页（canvas.html）跑同一套传递闭包，
 * 证明「只改白名单不够、必须加排除页」，并给出下一包的确切删除清单与逐条引用依据（edges）。
 *
 * 用法：node experiments/dxos-canvas-scope/closure-probe.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const STATIC = path.join(ROOT, "public", "novai-canvas", "static");
const VENDOR = path.join(ROOT, "experiments", "d5-02", "vendor-novai-app.mjs");
const ART = path.join(ROOT, "artifacts", "dxos-canvas-scope");

const NEXT_WHITELIST = ["canvas-list.html", "smart-canvas.html"];
const NEXT_EXCLUDE = ["canvas.html"];

const { extractStaticRefs, EXTRA_KEEP } = await import(pathToFileURL(VENDOR).href);

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p));
  }
  return out;
}

function closure(root, whitelist, exclude) {
  const all = walk(root).map((p) => p.split(path.sep).join("/"));
  const allSet = new Set(all);
  const excluded = new Set(exclude || []);
  const keep = new Set();
  const queue = [];
  const edges = [];
  for (const p of whitelist) {
    if (!allSet.has(p)) throw new Error("白名单页面在源里不存在：" + p);
    keep.add(p); queue.push(p);
  }
  while (queue.length) {
    const rel = queue.shift();
    if (!/\.(html|js|css|json|md|mjs)$/i.test(rel)) continue;
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    for (const raw of extractStaticRefs(text, rel)) {
      const ref = raw.startsWith("static/") ? raw.slice("static/".length) : raw;
      if (!allSet.has(ref) || keep.has(ref) || excluded.has(ref)) continue;
      keep.add(ref); edges.push({ from: rel, to: ref }); queue.push(ref);
    }
  }
  return { all, keep: [...keep].sort(), edges };
}

const before = closure(STATIC, ["canvas-list.html", "canvas.html", "smart-canvas.html"], []);
const after = closure(STATIC, NEXT_WHITELIST, NEXT_EXCLUDE);
// 与 vendor computeKeepSet 同口径：EXTRA_KEEP 是策略保留（页面/标签之外的引用方），不参与删除。
for (const extra of EXTRA_KEEP) { if (after.all.includes(extra) && !after.keep.includes(extra)) { after.keep.push(extra); after.edges.push({ from: "(policy)", to: extra }); } }
after.keep.sort();
const kept = new Set(after.keep);
const dropped = after.all.filter((f) => !kept.has(f)).sort();
const dropEdges = {};
for (const rel of dropped) {
  dropEdges[rel] = before.edges.filter((e) => e.to === rel);
}
const report = {
  generatedAt: new Date().toISOString(),
  source: "public/novai-canvas/static",
  currentWhitelist: ["canvas-list.html", "canvas.html", "smart-canvas.html"],
  nextWhitelist: NEXT_WHITELIST,
  nextExclude: NEXT_EXCLUDE,
  note: "只改白名单不够：extractStaticRefs 仍会从 canvas-list.html 的 kind smart 三元里抽到 /static/canvas.html，必须同时把它放进排除页。",
  before: { files: before.all.length, keep: before.keep.length },
  after: { files: after.all.length, keep: after.keep.length, dropped: dropped.length },
  droppedWithSize: dropped.map((f) => ({ file: f, bytes: fs.statSync(path.join(STATIC, f)).size })),
  droppedEdges: dropEdges,
  keepEdges: after.edges,
};
fs.mkdirSync(ART, { recursive: true });
fs.writeFileSync(path.join(ART, "closure-probe.json"), JSON.stringify(report, null, 2) + "\n");
console.log("[scope] before keep " + before.keep.length + "/" + before.all.length + "；after keep " + after.keep.length + "/" + after.all.length + "；drop " + dropped.length);
for (const item of report.droppedWithSize) console.log("  - " + item.file + "  " + item.bytes + " B");
console.log("[scope] 报告：" + path.relative(ROOT, path.join(ART, "closure-probe.json")));
