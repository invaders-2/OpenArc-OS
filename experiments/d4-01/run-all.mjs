// D4-01 标准入口。npm run test:d4-01
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "d4-01");
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });
const FILES = ["tests/model-service.test.mjs", "tests/model-proxy.test.mjs", "tests/model-proxy-child.test.mjs", "tests/model-service-stream.test.mjs", "tests/model-bootstrap.test.mjs", "tests/model-secret-scan.test.mjs", "tests/model-performance.test.mjs"];
// --test-concurrency=1：performance baseline 不能被并行的其他测试文件污染
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...FILES], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
const code = await new Promise((r) => child.on("close", r));
const m = out.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/);
const summary = m ? { tests: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]) } : { tests: 0, pass: 0, fail: 1 };
fs.writeFileSync(path.join(ART, "d4-01-gate.json"), JSON.stringify({ ...summary, files: FILES, at: new Date().toISOString() }, null, 2));
console.log("\n结论：" + (summary.fail === 0 && code === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify(summary));
process.exit(summary.fail === 0 && code === 0 ? 0 : 1);
