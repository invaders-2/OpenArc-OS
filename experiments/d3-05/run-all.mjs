// D3-05 标准入口。npm run test:d3-05
// 运行 Identity & Data Gate 的跨域集成测试并产出 artifacts/d3-05/d3-05-gate.json。
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "d3-05");
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });
const FILES = ["tests/d3-05-gate.test.mjs", "tests/d3-05-data-gate.test.mjs"];
const child = spawn(process.execPath, ["--test", ...FILES], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
const code = await new Promise((resolve) => child.on("close", resolve));
const m = out.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/);
const summary = m ? { tests: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]) } : { tests: 0, pass: 0, fail: 1 };
fs.writeFileSync(path.join(ART, "d3-05-gate.json"), JSON.stringify({ ...summary, files: FILES, at: new Date().toISOString() }, null, 2));
console.log("\n结论：" + (summary.fail === 0 && code === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify(summary));
process.exit(summary.fail === 0 && code === 0 ? 0 : 1);
