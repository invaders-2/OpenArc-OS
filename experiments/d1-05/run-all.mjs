// D1-05 探针批处理运行器。
//
// 顺序执行 experiments/d1-05/ 下的全部探针，汇总各自的结论。
// 之所以要有它：单条探针之间是有依赖的（06 依赖 05 建好的沙箱布局），
// 而且本轮所有结论都必须能一键复现，不能靠"我跑过了"。
//
// 用法：
//   node experiments/d1-05/run-all.mjs
//
// 注意：本机的 /bin/ps 是 setuid 二进制、/usr/bin/security 需要读写钥匙串，
// 在受限沙箱内运行时，03 / 04 / 05 / 06 / 07 可能失败。
// 请在**不受限**的终端里执行本脚本，取证结果才完整。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, ART, VERDICT } from "./lib/probe.mjs";

const HERE = import.meta.dirname;

/** 顺序很重要：05 负责建立 06 依赖的沙箱布局。 */
const SUITE = [
  "01-local-ipc-probe.mjs",
  "02-tls-probe.mjs",
  "03-credential-probe.mjs",
  "04-env-probe.mjs",
  "05-path-probe.mjs",
  "06-isolation-probe.mjs",
  "07-exec-probe.mjs",
  "08-redaction-probe.mjs",
  "09-attack-matrix.mjs",
];

const TIMEOUT_MS = 5 * 60 * 1000;

function run(file) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [path.join(HERE, file)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    cp.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    cp.stderr.on("data", (d) => process.stderr.write(d));
    const timer = setTimeout(() => {
      cp.kill("SIGKILL");
      resolve({ file, code: null, signal: "TIMEOUT", out });
    }, TIMEOUT_MS);
    cp.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ file, code, signal, out });
    });
  });
}

const results = [];
for (const f of SUITE) {
  console.log(`\n${"=".repeat(72)}\n>> ${f}\n${"=".repeat(72)}`);
  const r = await run(f);
  results.push(r);
}

// 汇总：以产物里的 verdict 为准，而不是以退出码为准
const summary = [];
for (const r of results) {
  const id = path.basename(r.file).replace(/-probe\.mjs$/, "").replace(/\.mjs$/, "");
  const artFile = path.join(ART, `${id}.json`);
  let verdict = VERDICT.BLOCKED;
  let counts = {};
  if (fs.existsSync(artFile)) {
    const j = JSON.parse(fs.readFileSync(artFile, "utf8"));
    verdict = j.verdict;
    counts = j.counts;
  }
  summary.push({ probe: path.basename(r.file), verdict, counts, exitCode: r.code, signal: r.signal });
}

console.log(`\n${"=".repeat(72)}\nD1-05 探针汇总\n${"=".repeat(72)}`);
for (const s of summary) {
  console.log(
    `  ${s.verdict.padEnd(13)} ${s.probe.padEnd(26)} ${JSON.stringify(s.counts)}` +
      (s.exitCode !== 0 ? `  (exit ${s.exitCode}${s.signal ? `/${s.signal}` : ""})` : "")
  );
}

const failed = summary.filter((s) => s.verdict === VERDICT.FAIL);
const partial = summary.filter((s) => s.verdict === VERDICT.PARTIAL);
console.log(
  `\n合计：${summary.length} 个探针；FAIL ${failed.length}；PARTIAL ${partial.length}；` +
    `PASS ${summary.filter((s) => s.verdict === VERDICT.PASS).length}。`
);
if (failed.length) {
  console.log(`FAIL 探针：${failed.map((f) => f.probe).join(", ")}`);
  process.exit(1);
}
console.log("提示：PARTIAL 的探针里含有 PARTIAL / BLOCKED / NOT VERIFIED 条目，需要逐条看产物，不要只看总数。");
