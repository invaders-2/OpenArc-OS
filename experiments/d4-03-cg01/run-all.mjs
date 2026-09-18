// D4-03 CG-01 标准入口：acquireLease 事务内状态保护（新增检查 + 租约/状态完整性回归）。
// npm run test:d4-03-cg01
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "d4-03-cg01");
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });
const FILES = [
  "tests/d4-03-lease-acquire-state-protection.test.mjs",
  "tests/d4-03-lease-state-integrity.test.mjs",
  "tests/d4-03-deny-state-protection.test.mjs",
];
const sha256 = (rel) => {
  try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex"); } catch { return null; }
};
const git = (args) => {
  try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};
// git 不可用（git archive 导出树）时 testedCommit 由 OPENARC_TESTED_COMMIT 显式提供，repoKind=archive。
const gitHead = git(["rev-parse", "HEAD"]);
const testedCommit = process.env.OPENARC_TESTED_COMMIT || gitHead;
const workspaceState = git(["status", "--porcelain"]);
const repoKind = gitHead != null ? "git" : "archive";
let versions = {};
try {
  const store = require(path.join(ROOT, "electron", "identity-store.cjs"));
  const { ToolRegistry } = require(path.join(ROOT, "electron", "tool-registry.cjs"));
  versions = { schemaVersion: store.SCHEMA_VERSION, tools: new ToolRegistry().ids() };
} catch (e) { versions = { error: String((e && e.message) || e) }; }

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=60000", ...FILES], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
const code = await new Promise((r) => child.on("close", r));
const m = out.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/);
const summary = m ? { tests: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]) } : { tests: 0, pass: 0, fail: 1 };
const report = {
  ...summary, files: FILES, versions,
  mode: "CG-01 (acquireLease 事务内重读 persisted status；拒绝路径零写入)",
  testedCommit, workspaceState, repoKind,
  sourceSha256: { "electron/side-effect-authority.cjs": sha256("electron/side-effect-authority.cjs"), "tests/d4-03-lease-acquire-state-protection.test.mjs": sha256("tests/d4-03-lease-acquire-state-protection.test.mjs") },
  machine: { os: process.platform + " " + os.release(), arch: process.arch, node: process.version },
  at: new Date().toISOString(),
};
fs.writeFileSync(path.join(ART, "d4-03-cg01-gate.json"), JSON.stringify(report, null, 2));
console.log("\n结论：" + (summary.fail === 0 && code === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ ...summary, testedCommit, workspaceState, sourceSha256: report.sourceSha256 }));
process.exit(summary.fail === 0 && code === 0 ? 0 : 1);
