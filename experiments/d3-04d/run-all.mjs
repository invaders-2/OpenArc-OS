// D3-04D 探针总入口。npm run test:d3-04d
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
const HERE = import.meta.dirname;
const ART = path.join(HERE, "..", "..", "artifacts", "d3-04d");
const PROBES = ["01-governance.mjs", "02-picker.mjs", "03-integration.mjs", "04-security.mjs", "05-performance.mjs"];
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });
const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let out = "";
  child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
  child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
  child.on("close", (code) => { const m = out.match(/结论：(\w+)\s*—\s*(\{[^}]*\})/); resolve({ file, code, verdict: m ? m[1] : "UNKNOWN", counts: m ? m[2] : "{}" }); });
});
const results = [];
for (const f of PROBES) { console.log("\n" + "═".repeat(72) + "\n▶ " + f + "\n" + "═".repeat(72)); results.push(await run(f)); }
console.log("\n" + "═".repeat(72) + "\nD3-04D 探针总览\n" + "═".repeat(72));
for (const r of results) console.log(r.file.padEnd(30) + r.verdict.padEnd(14) + r.counts);
const failed = results.filter((r) => r.code !== 0 || r.verdict === "FAIL");
console.log("\n合计 " + results.length + " 个探针：PASS " + results.filter((r) => r.verdict === "PASS").length + " / FAIL " + failed.length);
process.exit(failed.length ? 1 : 0);
