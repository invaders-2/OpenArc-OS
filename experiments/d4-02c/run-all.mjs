// D4-02C 标准入口。npm run test:d4-02c
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "d4-02c");
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });
const FILES = [
  "tests/task-harness-orchestrator.test.mjs",
  "tests/task-harness-e2e.test.mjs",
  "tests/task-harness-cancel.test.mjs",
  "tests/task-harness-recovery.test.mjs",
  "tests/task-harness-security.test.mjs",
  "tests/task-orchestration-migration.test.mjs",
];
let versions = {};
try {
  const adapter = require(path.join(ROOT, "electron", "harness-adapter.cjs"));
  const runtime = adapter.resolveDshRuntime();
  const sdkPath = adapter.resolveAcpSdk(runtime);
  versions = {
    dsh: adapter.dshVersion(runtime),
    dshBin: adapter.resolveDshBin(runtime),
    acpSdk: sdkPath ? require(path.join(path.dirname(path.dirname(sdkPath)), "package.json")).version : null,
    protocolVersion: adapter.ACP_PROTOCOL_VERSION,
    schemaVersion: require(path.join(ROOT, "electron", "identity-store.cjs")).SCHEMA_VERSION,
  };
} catch (e) { versions = { error: String((e && e.message) || e) }; }

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...FILES], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
const code = await new Promise((r) => child.on("close", r));
const m = out.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/);
const summary = m ? { tests: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]) } : { tests: 0, pass: 0, fail: 1 };
const report = { ...summary, files: FILES, versions, machine: { os: process.platform + " " + os.release(), arch: process.arch, node: process.version }, at: new Date().toISOString() };
fs.writeFileSync(path.join(ART, "d4-02c-gate.json"), JSON.stringify(report, null, 2));
console.log("\n结论：" + (summary.fail === 0 && code === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ ...summary, versions }));
process.exit(summary.fail === 0 && code === 0 ? 0 : 1);
