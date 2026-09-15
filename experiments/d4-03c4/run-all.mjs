// D4-03C4 Side-effect Final Gate 标准入口。npm run test:d4-03c4
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "d4-03c4");
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });

const FILES = [
  "tests/side-effect-c4-runtime.test.mjs",
  "tests/side-effect-c4-gates.test.mjs",
  "tests/side-effect-c4-dsh-write.test.mjs",
];

function run(cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
  child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
}

let versions = {};
try {
  const store = require(path.join(ROOT, "electron", "identity-store.cjs"));
  const { ToolRegistry } = require(path.join(ROOT, "electron", "tool-registry.cjs"));
  const profile = require(path.join(ROOT, "electron", "dsh-tool-profile.cjs"));
  versions = { schemaVersion: store.SCHEMA_VERSION, tools: new ToolRegistry().ids(), harnessVisibleRead: profile.READ_TOOL_IDS, harnessVisibleWrite: profile.WRITE_TOOL_IDS };
} catch (e) { versions = { error: String((e && e.message) || e) }; }

const tests = await run(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=180000", ...FILES]);
const m = tests.out.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/);
const summary = m ? { tests: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]) } : { tests: 0, pass: 0, fail: 1 };

// Approval UI：真实 Electron + 产品页面 + preload + Trusted Approval Gateway。
const build = await run("npm", ["run", "build"]);
const ui = build.code === 0 ? await run(process.execPath, ["tests/side-effect-approval-ui.mjs"]) : { code: 1, out: "build failed" };
const uiMatch = ui.out.match(/(\d+)\/(\d+) UI checks passed/);
const uiSummary = uiMatch ? { pass: Number(uiMatch[1]), total: Number(uiMatch[2]), ok: uiMatch[1] === uiMatch[2] && ui.code === 0 } : { pass: 0, total: 0, ok: false };

let writeStats = null;
try { writeStats = JSON.parse(fs.readFileSync(path.join(ART, "write-e2e-stats.json"), "utf8")); } catch { writeStats = null; }

const ready = path.join(ART, "approval-ui-ready.json");
fs.writeFileSync(ready, JSON.stringify({ ui: uiSummary, at: new Date().toISOString() }, null, 2));

const report = {
  ...summary,
  ui: uiSummary,
  build: build.code === 0,
  writeE2E: writeStats,
  files: FILES,
  mode: "C4 FINAL GATE (production side-effect runtime: trusted supervisor + supervised executor + trusted approval gateway + official dsh WRITE)",
  versions,
  machine: { os: process.platform + " " + os.release(), arch: process.arch, node: process.version },
  at: new Date().toISOString(),
};
fs.writeFileSync(path.join(ART, "d4-03c4-gate.json"), JSON.stringify(report, null, 2));
const pass = summary.fail === 0 && tests.code === 0 && build.code === 0 && uiSummary.ok;
console.log("\n结论：" + (pass ? "PASS" : "FAIL") + " — " + JSON.stringify({ tests: summary, ui: uiSummary, build: build.code }));
process.exit(pass ? 0 : 1);
