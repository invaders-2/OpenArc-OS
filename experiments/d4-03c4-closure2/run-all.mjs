// D4-03C4 Closure-2 标准入口。npm run test:d4-03c4-closure2
// 唯一主题：Cold-Restart Death Proof（pathname != process lifetime）。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "d4-03c4-closure2");
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });

const FILES = ["tests/side-effect-c4-closure2.test.mjs"];

let versions = {};
try {
  const store = require(path.join(ROOT, "electron", "identity-store.cjs"));
  const { ToolRegistry } = require(path.join(ROOT, "electron", "tool-registry.cjs"));
  const supervisor = require(path.join(ROOT, "electron", "runtime-supervisor.cjs"));
  versions = {
    schemaVersion: store.SCHEMA_VERSION,
    tools: new ToolRegistry().ids(),
    liveness: supervisor.LIVENESS,
    unverifiedPersistedExit: supervisor.UNVERIFIED_PERSISTED_EXIT,
    instanceIdValidation: { acceptsProduction: supervisor.isValidInstanceId("exe_abc123"), rejectsTraversal: !supervisor.isValidInstanceId("../../outside") },
  };
} catch (e) { versions = { error: String((e && e.message) || e) }; }

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=180000", ...FILES], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
const code = await new Promise((r) => child.on("close", r));
const m = out.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/);
const summary = m ? { tests: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]) } : { tests: 0, pass: 0, fail: 1 };
const report = {
  ...summary,
  files: FILES,
  mode: "C4 CLOSURE-2 (Unix socket pathname existence != process lifetime; only a real same-supervisor child exit may observeExit; persisted record has no socketPath; probe path re-derived from validated instanceId)",
  contract: { pathnameHasNoDeathAuthority: true, persistedRecordHasNoDeathAuthority: true, persistedRecordHasNoSocketPath: true, instanceIdValidated: true, schemaBumped: false },
  versions,
  machine: { os: process.platform + " " + os.release(), arch: process.arch, node: process.version },
  at: new Date().toISOString(),
};
fs.writeFileSync(path.join(ART, "d4-03c4-closure2-gate.json"), JSON.stringify(report, null, 2));
console.log("\n结论：" + (summary.fail === 0 && code === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ ...summary, versions }));
process.exit(summary.fail === 0 && code === 0 ? 0 : 1);
