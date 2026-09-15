// D4-03B 标准入口。npm run test:d4-03b
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "d4-03b");
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });
const FILES = [
  "tests/tool-execution-readonly.test.mjs",
  "tests/tool-resource-read.test.mjs",
  "tests/tool-resource-search.test.mjs",
  "tests/tool-execution-cancel.test.mjs",
  "tests/tool-execution-security.test.mjs",
  "tests/tool-execution-migration.test.mjs",
  "tests/tool-dsh-facade.test.mjs",
  "tests/tool-dsh-e2e.test.mjs",
  "tests/tool-dsh-security.test.mjs",
  "tests/tool-dsh-cancel.test.mjs",
  "tests/tool-dsh-lifecycle.test.mjs",
];
let versions = {};
try {
  const store = require(path.join(ROOT, "electron", "identity-store.cjs"));
  const { ToolRegistry } = require(path.join(ROOT, "electron", "tool-registry.cjs"));
  versions = { schemaVersion: store.SCHEMA_VERSION, tools: new ToolRegistry().ids() };
} catch (e) { versions = { error: String((e && e.message) || e) }; }

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...FILES], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
const code = await new Promise((r) => child.on("close", r));
const m = out.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/);
const summary = m ? { tests: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]) } : { tests: 0, pass: 0, fail: 1 };
const report = { ...summary, files: FILES, versions, mode: "READ_ONLY execution", machine: { os: process.platform + " " + os.release(), arch: process.arch, node: process.version }, at: new Date().toISOString() };
fs.writeFileSync(path.join(ART, "d4-03b-gate.json"), JSON.stringify(report, null, 2));
console.log("\n结论：" + (summary.fail === 0 && code === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ ...summary, versions }));
process.exit(summary.fail === 0 && code === 0 ? 0 : 1);
