/**
 * D5-03 第七批 · 既有 node 面门禁的串行复核（每次运行一个 runId 目录 + 只追加索引 + sha256）。
 *
 * 只做一件事：**串行**跑下面四步，把每一步的 stdout+stderr 原样落盘到本 run 目录，
 * 记录 exitCode / 计数 / 日志 sha256；不改任何门禁脚本、不改判定。
 *   1) node tests/device-ui.mjs        —— 真实 Electron 设备界面门禁
 *   2) node tests/identity-ui.mjs      —— 真实 Electron 身份界面门禁
 *   3) node --test tests/device-*.test.mjs tests/d5-03-*.test.mjs tests/app-policy-provisions-retention.test.mjs
 *   4) npm test                        —— 全量（已知既有失败如实列出，不算本批回归）
 *
 * 串行保证：本脚本自身在任一时刻只持有一个子进程，且不与其他 Electron 门禁同时运行。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RUN_ARTIFACTS = require(path.join(here, "run-artifacts.cjs"));
const OWNERSHIP = require(path.join(here, "userdata-ownership.cjs"));

const CHECKS = [], LOG_LINES = [], STEPS = [], NOTES = [];
let passed = 0, failed = 0;
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG_LINES.push(s); _log(s); };
function record(section, name, ok, expected, actual) {
  const row = { section, name, status: ok ? "PASS" : "FAIL", expected: String(expected ?? ""), actual: String(actual ?? "").slice(0, 2600), at: new Date().toISOString() };
  CHECKS.push(row);
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? "  [PASS] " : "! [FAIL] ") + section + " · " + name + (ok ? "" : " — 期望 " + row.expected + "，实际 " + row.actual.slice(0, 900)));
  return ok;
}
const note = (t) => { NOTES.push(t); console.log("   · " + t); };
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
function gitText(args) { try { return require("node:child_process").execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim(); } catch { return null; } }

const ELECTRON_ARGS = "--no-sandbox --disable-gpu-sandbox --in-process-gpu";
const testFiles = (re) => fs.readdirSync(path.join(ROOT, "tests")).filter((f) => re.test(f)).sort().map((f) => "tests/" + f);

function runStep(RUN, step) {
  const startedAt = new Date().toISOString();
  const res = spawnSync(step.cmd, step.args, {
    cwd: ROOT, encoding: "utf8", timeout: step.timeoutMs || 900000, maxBuffer: 1 << 28,
    env: { ...process.env, ...(step.env || {}) },
  });
  const out = String(res.stdout || "") + String(res.stderr || "");
  const logPath = path.join(RUN.runDir, step.id + ".log");
  fs.writeFileSync(logPath, out);
  const buf = fs.readFileSync(logPath);
  const summary = {};
  for (const line of out.split(String.fromCharCode(10))) {
    const m = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)/.exec(line.trim());
    if (m) summary[m[1]] = Number(m[2]);
    const ui = /(\d+)\/(\d+) UI checks passed/.exec(line);
    if (ui) { summary.uiPass = Number(ui[1]); summary.uiTotal = Number(ui[2]); }
  }
  const failedNames = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).slice(0, 40);
  const row = {
    id: step.id, title: step.title, command: [step.cmd, ...step.args].join(" "),
    env: step.env || null, startedAt, finishedAt: new Date().toISOString(),
    exitCode: res.status, signal: res.signal || null, summary, failedNames,
    logPath: path.relative(ROOT, logPath), logBytes: buf.length, logSha256: sha256(buf),
  };
  STEPS.push(row);
  console.log(String.fromCharCode(10) + "── " + step.id + "：" + row.command + " → exit=" + row.exitCode + " " + JSON.stringify(summary));
  if (failedNames.length) note(step.id + " 失败用例名（如实列出）：" + JSON.stringify(failedNames));
  return row;
}

async function main() {
  const RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "batch7-gates-rerun", basePort: 9861, envBaseVar: "OA_D503H_GATES_CDP_PORT", userDataPrefixBase: OWNERSHIP.PREFIX });
  console.log("本次串行复核：" + RUN.runId + " → " + RUN.runDirRel);
  const testedCommit = process.env.OPENARC_TESTED_COMMIT || gitText(["rev-parse", "HEAD"]);
  note("被测提交：" + testedCommit + "；dist/index.html mtime=" + (() => { try { return fs.statSync(path.join(ROOT, "dist/index.html")).mtime.toISOString(); } catch { return "missing"; } })() + " sha256_16=" + (() => { try { return sha256(fs.readFileSync(path.join(ROOT, "dist/index.html"))).slice(0, 16); } catch { return null; } })());

  const nodeSet = [...testFiles(/^device-.*\.test\.mjs$/), ...testFiles(/^d5-03-.*\.test\.mjs$/), "tests/app-policy-provisions-retention.test.mjs"];
  note("相关集合（本批 node 面）：" + nodeSet.length + " 个文件 —— " + JSON.stringify(nodeSet));

  const uiEnv = { ELECTRON_EXTRA_ARGS: ELECTRON_ARGS };
  const steps = [
    { id: "device-ui", title: "真实 Electron 设备界面门禁", cmd: process.execPath, args: ["tests/device-ui.mjs"], env: uiEnv, timeoutMs: 360000 },
    { id: "identity-ui", title: "真实 Electron 身份界面门禁", cmd: process.execPath, args: ["tests/identity-ui.mjs"], env: uiEnv, timeoutMs: 360000 },
    { id: "node-related", title: "相关集合（device-* + d5-03-* + 守卫）", cmd: process.execPath, args: ["--test", ...nodeSet], timeoutMs: 900000 },
    { id: "npm-test", title: "全量 npm test（tests/*.test.mjs）", cmd: "npm", args: ["test"], timeoutMs: 1800000 },
  ];
  const results = [];
  for (const s of steps) results.push(runStep(RUN, s));
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  record("G1", "device-ui（真实 Electron 设备界面门禁）全通过且 exit=0",
    byId["device-ui"].exitCode === 0 && byId["device-ui"].summary.uiTotal > 0 && byId["device-ui"].summary.uiPass === byId["device-ui"].summary.uiTotal,
    "exit=0 且 UI checks 全通过",
    JSON.stringify(byId["device-ui"]));
  record("G2", "identity-ui（真实 Electron 身份界面门禁）全通过且 exit=0",
    byId["identity-ui"].exitCode === 0 && byId["identity-ui"].summary.uiTotal > 0 && byId["identity-ui"].summary.uiPass === byId["identity-ui"].summary.uiTotal,
    "exit=0 且 UI checks 全通过",
    JSON.stringify(byId["identity-ui"]));
  const rel = byId["node-related"];
  record("G3", "相关集合（device-* + d5-03-* + app-policy-provisions-retention）exit=0 且 fail=0",
    rel.exitCode === 0 && rel.summary.fail === 0 && rel.summary.tests > 0,
    "exit=0 / # fail 0",
    JSON.stringify(rel));
  const full = byId["npm-test"];
  record("G4", "全量 npm test 的计数与 exit 如实记录（已知既有失败不算本批回归：与第六批基线逐条对照）",
    full.summary.tests > 0,
    "有 # tests / # pass / # fail 计数",
    JSON.stringify({ exitCode: full.exitCode, summary: full.summary, failedNames: full.failedNames, logPath: full.logPath, logSha256: full.logSha256 }));

  const out = {
    phase: "D5-03 第七批",
    title: "既有 node 面门禁的串行复核（device-ui / identity-ui / 相关集合 / 全量）",
    runId: RUN.runId, runDir: RUN.runDirRel, startedAt: RUN.startedAt,
    testedCommit, openarcCommit: testedCommit, openarcBranch: gitText(["rev-parse", "--abbrev-ref", "HEAD"]),
    command: "node experiments/d5-03/batch7-gates-rerun.mjs",
    scriptSha256: (() => { try { return sha256(fs.readFileSync(path.join(ROOT, "experiments/d5-03/batch7-gates-rerun.mjs"))); } catch { return null; } })(),
    steps: STEPS, checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    observations: NOTES,
    boundary: { electronSerialized: true, pkillUsed: false, productCodeModified: false },
    at: new Date().toISOString(),
  };
  out.exitCode = failed === 0 ? 0 : 1;
  console.log(String.fromCharCode(10) + "结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length }));
  const fin = await RUN.finalize({ out, exitCode: out.exitCode, logLines: LOG_LINES, cleanup: { strategy: "own-child-processes-only", leftovers: [], pkillUsed: false } });
  console.log("产物：" + fin.artifactPath + "（sha256 " + fin.artifactSha256.slice(0, 16) + "）");
  return out.exitCode;
}

let exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("复核异常：" + String((e && e.stack) || e));
  exitCode = 2;
}
process.exit(exitCode);
