// D3-02 探针总入口。
//
// 逐个 spawn 子进程：每个探针各自持有自己的临时目录与 SQLite 连接，串行跑保证
// 产物不互相覆盖、失败不互相掩盖。**产物必须先删再跑**（D2-02 定下的硬规矩），
// 否则崩溃的探针会显示"全通过"。
//
// 用法：npm run test:d3-02
// 退出码：任一探针 FAIL → 1；PASS / PARTIAL / NOT VERIFIED → 0。
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const HERE = import.meta.dirname;
const ART = path.join(HERE, "..", "..", "artifacts", "d3-02");

const PROBES = [
  "01-authorization-policy.mjs",
  "02-app-authorization.mjs",
  "03-agent-authorization.mjs",
  "04-governance-delegation.mjs",
  "05-query-enumeration.mjs",
  "06-migration-race-session.mjs",
];

fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
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
  console.log("\n" + "═".repeat(72) + "\n▶ " + f + "\n" + "═".repeat(72));
  results.push(await run(f));
}

console.log("\n" + "═".repeat(72) + "\nD3-02 探针总览\n" + "═".repeat(72));
console.log("探针".padEnd(34) + "结论".padEnd(16) + "计数");
for (const r of results) console.log(r.file.padEnd(34) + r.verdict.padEnd(16) + r.counts);

const failed = results.filter((r) => r.code !== 0 || r.verdict === "FAIL");
const partial = results.filter((r) => r.verdict === "PARTIAL");
console.log(
  "\n合计 " + results.length + " 个探针：PASS " + results.filter((r) => r.verdict === "PASS").length +
    " / PARTIAL " + partial.length + " / FAIL " + failed.length,
);
process.exit(failed.length ? 1 : 0);
