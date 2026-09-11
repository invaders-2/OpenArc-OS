// D2-01 探针总入口。
//
// 逐个 spawn 子进程而不是 import：每个探针各自持有 Chromium 实例与静态服务，
// 串行跑能保证产物不互相覆盖、失败不互相掩盖，且任一探针崩溃不会拖垮其余。
//
// 用法：npm run test:design-system
// 退出码：任一探针 FAIL → 1；全部 PASS / PARTIAL / NOT VERIFIED → 0。
//
// 注意：D1-04 的 theme-matrix 是**永久回归基线**，不在这里重复调度 ——
// 它有自己的入口且必须能在 D2 之后继续独立运行。D2-01 的任何改动都必须
// 让它继续通过（见 docs/decisions/D2-01-design-system.md §测试）。

import { spawn } from "node:child_process";
import path from "node:path";

const HERE = import.meta.dirname;
const PROBES = [
  "01-token-contract.mjs",
  "02-theme-glass-matrix.mjs",
  "03-component-states.mjs",
  "04-keyboard-a11y.mjs",
  "05-motion-matrix.mjs",
];

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      out += d;
      process.stderr.write(d);
    });
    child.on("close", (code) => {
      const m = out.match(/结论：(\w+)\s*—\s*(\{[^}]*\})/);
      resolve({ file, code, verdict: m?.[1] ?? "UNKNOWN", counts: m?.[2] ?? "{}" });
    });
  });

const results = [];
for (const f of PROBES) {
  console.log(`\n${"═".repeat(72)}\n▶ ${f}\n${"═".repeat(72)}`);
  results.push(await run(f));
}

console.log(`\n${"═".repeat(72)}\nD2-01 探针总览\n${"═".repeat(72)}`);
console.log("探针".padEnd(28) + "结论".padEnd(16) + "计数");
for (const r of results) console.log(r.file.padEnd(28) + r.verdict.padEnd(16) + r.counts);

const failed = results.filter((r) => r.code !== 0 || r.verdict === "FAIL");
const partial = results.filter((r) => r.verdict === "PARTIAL");
console.log(
  `\n合计 ${results.length} 个探针：PASS ${results.filter((r) => r.verdict === "PASS").length} / ` +
    `PARTIAL ${partial.length} / FAIL ${failed.length}`,
);
if (partial.length) {
  console.log("PARTIAL 探针（存在 NOT VERIFIED 项，属诚实结论，不算失败）：");
  for (const r of partial) console.log(`  · ${r.file}`);
}
console.log("提示：D1-04 theme-matrix 是永久回归基线，需另行执行：node experiments/d1-04/theme-matrix.mjs");

process.exit(failed.length ? 1 : 0);
