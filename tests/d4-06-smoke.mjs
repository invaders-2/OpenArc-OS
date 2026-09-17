/**
 * D4-06 Gate 启动器：复用同一份 D4-04 Electron 真实链路（含关联链审计 L1..L15 与执行异常 X / 预算到限 Y 场景）
 * + 预算 Node 测试（tests/d4-06-budget.test.mjs），输出 docs/D4-06-GATE-EVIDENCE.json（脱敏、tracked）。
 *
 * 不覆盖 tracked 的 docs/D4-04-GATE-EVIDENCE.json：内层 d4-04-smoke 经 OPENARC_D4_SMOKE_GATE_OUT 写到临时文件。
 */
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const COMMAND = process.env.npm_lifecycle_event ? "npm run " + process.env.npm_lifecycle_event : "node tests/d4-06-smoke.mjs";
const git = (args) => { try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim(); } catch { return null; } };
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const SECRET_RE = [/\/Users\/[^\s"']*/g, /\/private\/[^\s"']*/g, /\/var\/folders\/[^\s"']*/g, /mpx_[A-Za-z0-9_-]+/g, /tpx_[A-Za-z0-9_-]+/g, /credential[^\s"',}\]]*/gi];
function sanitize(value) {
  if (typeof value === "string") { let s = value; for (const re of SECRET_RE) s = s.replace(re, "[REDACTED]"); return s; }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") { const out = {}; for (const [k, v] of Object.entries(value)) out[k] = sanitize(v); return out; }
  return value;
}
function run(cmd, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}
function parseTap(text) {
  const tests = [];
  let pass = 0; let fail = 0;
  for (const line of String(text).split("\n")) {
    let m = line.match(/^ok \d+ - (.*)$/); if (m) { tests.push({ name: m[1].trim(), ok: true }); continue; }
    m = line.match(/^not ok \d+ - (.*)$/); if (m) { tests.push({ name: m[1].trim(), ok: false }); continue; }
    m = line.match(/^# pass (\d+)/); if (m) pass = Number(m[1]);
    m = line.match(/^# fail (\d+)/); if (m) fail = Number(m[1]);
  }
  return { tests, pass, fail };
}

// 运行前 workspaceState（在任何写入之前）。
const workspaceStateBefore = git(["status", "--porcelain"]) || "";
const testedCommit = git(["rev-parse", "HEAD"]);
const tmpGate = path.join(os.tmpdir(), "d4-06-inner-gate-" + process.pid + ".json");

// ① D4-04 Electron 真实链路（同一份运行；不覆盖 tracked D4-04 文档）。
const d4Run = await run(process.execPath, [path.join(here, "d4-04-smoke.mjs")], { ...process.env, OPENARC_D4_SMOKE_GATE_OUT: tmpGate });
const artifactPath = path.join(ROOT, "artifacts", "d4-04", "vertical-smoke-gate.json");
let inner = null;
try { inner = JSON.parse(fs.readFileSync(tmpGate, "utf8")); } catch { try { inner = JSON.parse(fs.readFileSync(artifactPath, "utf8")); } catch { inner = null; } }
try { fs.rmSync(tmpGate, { force: true }); } catch { /* ignore */ }
const innerRaw = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath) : Buffer.from("");

// ② 预算 Node 测试。
const btRun = await run(process.execPath, ["--test", "--test-concurrency=1", path.join(here, "d4-06-budget.test.mjs"), path.join(here, "d4-06-resume.test.mjs")]);
const budgetTapPath = path.join(ROOT, "artifacts", "d4-06", "budget-tests.tap");
fs.mkdirSync(path.dirname(budgetTapPath), { recursive: true });
fs.writeFileSync(budgetTapPath, btRun.out + btRun.err);
const budget = parseTap(btRun.out);

const innerChecks = inner && Array.isArray(inner.checks) ? inner.checks : [];
const budgetChecks = budget.tests.map((t) => ({ name: "BUDGET · " + t.name, expected: "pass", actual: t.ok ? "pass" : "fail", ok: t.ok }));
const allChecks = [...innerChecks, ...budgetChecks];

let evidence = {
  phase: "D4-06",
  title: "关联链完整性 + 预算到限停止",
  testedCommit,
  workspaceState: workspaceStateBefore,
  command: COMMAND,
  env: inner && inner.env ? inner.env : { electron: null, node: process.versions.node, platform: process.platform, arch: process.arch },
  officialDsh: true,
  reuse: {
    electronRun: "tests/d4-04-smoke.mjs (同一份 Electron 运行，含 linkageAudit L1..L15 与 X/Y 场景)",
    budgetTests: "tests/d4-06-budget.test.mjs",
    resumeTests: "tests/d4-06-resume.test.mjs",
    duplicateBudgetUnitEvidence: ["tests/tool-d4-03d-closure.test.mjs (maxCalls 原子 reserve)", "tests/tool-dsh-security.test.mjs (第 3 次 TOOL_CAPABILITY_EXHAUSTED + 0 Domain call)"],
  },
  electronRun: { exitCode: d4Run.code, checksSummary: inner ? inner.checksSummary : null, artifactSha256: inner ? inner.artifactSha256 : null },
  budgetRun: { exitCode: btRun.code, counts: { pass: budget.pass, fail: budget.fail, tests: budget.tests.length }, tests: budget.tests },
  sourceArtifacts: [
    { path: "artifacts/d4-04/vertical-smoke-gate.json", sha256: sha256(innerRaw) },
    { path: "artifacts/d4-06/budget-tests.tap", sha256: sha256(fs.readFileSync(budgetTapPath)) },
  ],
  checks: allChecks,
  checksSummary: { total: allChecks.length, pass: allChecks.filter((c) => c.ok).length, fail: allChecks.filter((c) => !c.ok).length },
  at: new Date().toISOString(),
};

evidence = sanitize(evidence);
evidence.artifactSha256Coverage = "sha256 of canonical JSON (2-space indent) excluding the artifactSha256 field";
evidence.artifactSha256 = sha256(Buffer.from(JSON.stringify(evidence, null, 2)));
const evidenceText = JSON.stringify(evidence, null, 2);
fs.mkdirSync(path.join(ROOT, "docs"), { recursive: true });
fs.writeFileSync(process.env.OPENARC_D4_06_GATE_OUT || path.join(ROOT, "docs", "D4-06-GATE-EVIDENCE.json"), evidenceText);

console.log("D4-06 electron exit=" + d4Run.code + " budget exit=" + btRun.code);
if (d4Run.code !== 0) console.log("ELECTRON TAIL:\n" + String(d4Run.out).slice(-1500));
if (btRun.code !== 0) console.log("BUDGET TAIL:\n" + String(btRun.out).slice(-1500));
console.log("D4-06 checks " + evidence.checksSummary.pass + "/" + evidence.checksSummary.total + " passed");
const ok = d4Run.code === 0 && btRun.code === 0 && evidence.checksSummary.fail === 0 && evidence.checksSummary.total > 0;
console.log("GATE: " + JSON.stringify({ testedCommit, command: COMMAND, electronExit: d4Run.code, budgetExit: btRun.code, checks: evidence.checksSummary, artifactSha256: evidence.artifactSha256 }));
process.exit(ok ? 0 : 1);
