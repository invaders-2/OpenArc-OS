// D4-03C3 Closure 标准入口。npm run test:d4-03c3-closure
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "d4-03c3-closure");
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });
const FILES = [
  "tests/side-effect-migration.test.mjs",
  "tests/side-effect-write-e2e.test.mjs",
  "tests/side-effect-write-gates.test.mjs",
  "tests/side-effect-c2-closure3.test.mjs",
  "tests/side-effect-c3-unknown-effect.test.mjs",
  "tests/side-effect-c3-crash.test.mjs",
  "tests/side-effect-c3-closure.test.mjs",
];
let versions = {};
try {
  const store = require(path.join(ROOT, "electron", "identity-store.cjs"));
  const { ToolRegistry } = require(path.join(ROOT, "electron", "tool-registry.cjs"));
  versions = { schemaVersion: store.SCHEMA_VERSION, tools: new ToolRegistry().ids() };
} catch (e) { versions = { error: String((e && e.message) || e) }; }

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=90000", ...FILES], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
const code = await new Promise((r) => child.on("close", r));
const m = out.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/);
const summary = m ? { tests: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]) } : { tests: 0, pass: 0, fail: 1 };
const report = { ...summary, files: FILES, versions, mode: "C3 CLOSURE (trusted Runtime Quiescence Authority: different instance != dead proof; persisted UNKNOWN_EFFECT upgrade only on observed runtime exit)", machine: { os: process.platform + " " + os.release(), arch: process.arch, node: process.version }, at: new Date().toISOString() };
fs.writeFileSync(path.join(ART, "d4-03c3-closure-gate.json"), JSON.stringify(report, null, 2));
console.log("\n结论：" + (summary.fail === 0 && code === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ ...summary, versions }));
process.exit(summary.fail === 0 && code === 0 ? 0 : 1);
