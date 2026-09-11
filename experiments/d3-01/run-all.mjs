// D3-01 探针总入口。
//
// 逐个 spawn 子进程而不是 import：每个探针各自持有自己的临时目录与 SQLite 连接，
// 串行跑能保证产物不互相覆盖、失败不互相掩盖，任一探针崩溃不会拖垮其余。
//
// 用法：npm run test:d3-01（含 build + 本入口 + 真实 Electron UI 验收）
// 退出码：任一探针 FAIL → 1；PASS / PARTIAL / NOT VERIFIED → 0。
//
// **产物必须先删再跑**：汇总不许读上一轮的产物，否则崩溃的探针会显示"全通过"
// （D2-02 定下的硬规矩）。

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const HERE = import.meta.dirname;
const ART = path.join(HERE, "..", "..", "artifacts", "d3-01");

const PROBES = [
  "01-init-race.mjs",
  "02-login.mjs",
  "03-session.mjs",
  "04-logout.mjs",
  "05-lock-unlock.mjs",
  "06-disable.mjs",
  "07-password-change.mjs",
  "08-expiry.mjs",
  "09-identity-snapshot.mjs",
  "10-secret-redaction.mjs",
  "11-concurrency.mjs",
  "12-credential-backend.mjs",
];

fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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

console.log(`\n${"═".repeat(72)}\nD3-01 探针总览\n${"═".repeat(72)}`);
console.log("探针".padEnd(30) + "结论".padEnd(16) + "计数");
for (const r of results) console.log(r.file.padEnd(30) + r.verdict.padEnd(16) + r.counts);

const failed = results.filter((r) => r.code !== 0 || r.verdict === "FAIL");
const partial = results.filter((r) => r.verdict === "PARTIAL");
console.log(
  `\n合计 ${results.length} 个探针：PASS ${results.filter((r) => r.verdict === "PASS").length} / ` +
    `PARTIAL ${partial.length} / FAIL ${failed.length}`,
);
if (partial.length) {
  console.log("PARTIAL 探针（含 NOT VERIFIED / BLOCKED 项，属诚实结论，不算失败）：");
  for (const r of partial) console.log(`  · ${r.file}`);
}
console.log("提示：真实 Electron UI 验收不在本入口内，需另行执行：npm run test:identity-ui");
console.log("     本机需 ELECTRON_EXTRA_ARGS=\"--no-sandbox --disable-gpu-sandbox --in-process-gpu\"");

process.exit(failed.length ? 1 : 0);
