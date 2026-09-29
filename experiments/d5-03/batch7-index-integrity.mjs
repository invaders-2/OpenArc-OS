/**
 * D5-03 第七批 · 运行索引与历史产物的**完整性核对**（只读，不改任何历史文件）。
 *
 * 核对项（逐条给出证据）：
 *   1) runs/index.json 的每一条：artifactPath / logPath 重新算 sha256，必须等于条目里记录的 artifactSha256 / logSha256
 *      —— 这证明**历史 artifact 一条都没被改写**（sha256 是当时的脚本写完后自算并回填索引的）；
 *   2) 每个条目对应的 .sha256 边车文件内容必须等于同一条 sha256；
 *   3) runs/index.jsonl 与 index.json 必须逐条一致（同一 runId 的条目内容相等、无重复、无缺失）；
 *   4) 每个 run 目录必须能在索引里找到对应条目（不许有"没有索引的产物"）。
 *
 * 只读 git / 文件；不启动 Electron；不查库。
 */
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

const CHECKS = [], LOG_LINES = [], NOTES = [], DETAIL = {};
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

const RUNS = path.join(ROOT, RUN_ARTIFACTS.RUNS_REL);

async function main() {
  const RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "batch7-index-integrity", basePort: 9871, envBaseVar: "OA_D503H_INTEGRITY_CDP_PORT", userDataPrefixBase: OWNERSHIP.PREFIX });
  console.log("本次核对（只读）：" + RUN.runId + " → " + RUN.runDirRel);
  const testedCommit = process.env.OPENARC_TESTED_COMMIT || gitText(["rev-parse", "HEAD"]);
  const indexPath = path.join(RUNS, "index.json");
  const jsonlPath = path.join(RUNS, "index.jsonl");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const entries = Array.isArray(index.runs) ? index.runs : [];
  const jsonl = fs.readFileSync(jsonlPath, "utf8").split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l));
  DETAIL.schema = index.schema;
  DETAIL.updatedAt = index.updatedAt;
  DETAIL.entryCount = entries.length;
  DETAIL.jsonlCount = jsonl.length;

  const mismatched = [], missing = [], sidecarBad = [], checked = [];
  for (const e of entries) {
    const ap = path.join(ROOT, e.artifactPath);
    if (!fs.existsSync(ap)) { missing.push({ runId: e.runId, artifactPath: e.artifactPath }); continue; }
    const buf = fs.readFileSync(ap);
    const got = sha256(buf);
    const ok = got === e.artifactSha256;
    if (!ok) mismatched.push({ runId: e.runId, recorded: e.artifactSha256, recomputed: got });
    /* 索引条目**不记录** logSha256（run-artifacts.cjs 的 entry 引用 artifacts.logSha256，而该字段写在 artifact 上），
       所以日志核对以**产物 JSON 里记录的 logSha256** 为准 —— 那才是 finalize 时算出来的值。 */
    let logOk = null, logRecorded = null;
    if (e.logPath && fs.existsSync(path.join(ROOT, e.logPath))) {
      try { logRecorded = JSON.parse(fs.readFileSync(ap, "utf8")).logSha256 || null; } catch { logRecorded = null; }
      logOk = !!logRecorded && sha256(fs.readFileSync(path.join(ROOT, e.logPath))) === logRecorded;
    }
    const sidecar = ap + ".sha256";
    atSidecarCheck: {
      if (!fs.existsSync(sidecar)) { sidecarBad.push({ runId: e.runId, reason: "边车文件缺失" }); break atSidecarCheck; }
      const text = fs.readFileSync(sidecar, "utf8").trim();
      if (!text.startsWith(String(e.artifactSha256))) sidecarBad.push({ runId: e.runId, reason: "边车内容与索引不一致", text: text.slice(0, 90) });
    }
    checked.push({ runId: e.runId, script: e.script, testedCommit: e.testedCommit, artifactSha256: e.artifactSha256, artifactOk: ok, logOk, bytes: buf.length });
  }
  DETAIL.checked = checked.length;
  DETAIL.historicalChecked = checked.filter((c) => c.testedCommit && !String(c.testedCommit).startsWith("ed4502d")).length;
  DETAIL.thisBatchChecked = checked.filter((c) => String(c.testedCommit || "").startsWith("ed4502d")).length;

  record("I1", "索引里每一条产物的 artifactSha256 重新计算后与记录值一致（= 历史 artifact 一条都没被改写）",
    mismatched.length === 0 && missing.length === 0 && checked.length === entries.length,
    "全部一致 + 无缺失",
    JSON.stringify({ entries: entries.length, checked: checked.length, mismatched, missing: missing.slice(0, 5) }));
  record("I2", "其中**本批之前**的历史产物（testedCommit 非 ed4502d）逐条一致 —— 本轮验收只追加、不改写",
    DETAIL.historicalChecked > 0 && checked.filter((c) => c.testedCommit && !String(c.testedCommit).startsWith("ed4502d")).every((c) => c.artifactOk),
    "历史条目全部一致",
    JSON.stringify({ historical: DETAIL.historicalChecked, thisBatch: DETAIL.thisBatchChecked }));
  record("I3", "每个条目的 .sha256 边车文件内容与索引记录一致",
    sidecarBad.length === 0, "无异常", JSON.stringify({ sidecarBad: sidecarBad.slice(0, 5), count: sidecarBad.length }));
  const byId = new Map();
  const dup = [];
  for (const r of jsonl) { if (byId.has(r.runId)) dup.push(r.runId); byId.set(r.runId, r); }
  const diff = [];
  for (const e of entries) {
    const j = byId.get(e.runId);
    if (!j) { diff.push({ runId: e.runId, reason: "index.jsonl 缺这条" }); continue; }
    if (JSON.stringify(j) !== JSON.stringify(e)) diff.push({ runId: e.runId, reason: "两侧条目内容不一致" });
  }
  const extra = [...byId.keys()].filter((id) => !entries.some((e) => e.runId === id));
  record("I4", "index.jsonl 与 index.json 逐条一致（同一 runId 无重复、无缺失、内容相等）—— 只追加索引没有丢过历史项",
    dup.length === 0 && diff.length === 0 && extra.length === 0,
    "无重复 / 无缺失 / 内容相等",
    JSON.stringify({ jsonl: jsonl.length, entries: entries.length, dup, diff: diff.slice(0, 5), extra: extra.slice(0, 5) }));

  const dirs = fs.readdirSync(RUNS).filter((n) => fs.statSync(path.join(RUNS, n)).isDirectory());
  /* 本次运行自己的目录在 finalize 之前就存在，扫描时必然还没进索引 —— 它不是孤儿，排除。 */
  const selfDir = path.basename(RUN.runDir);
  const orphanDirs = dirs.filter((d) => d !== selfDir && !entries.some((e) => e.runId === d));
  const orphanDetail = orphanDirs.map((d) => {
    let files = [];
    try { files = fs.readdirSync(path.join(RUNS, d)); } catch { /* ignore */ }
    return { dir: d, files, hasFinalizedArtifact: files.some((f) => f.endsWith(".json.sha256")) };
  });
  DETAIL.orphanDetail = orphanDetail;
  record("I5", "没有「已 finalize 却没进索引」的运行：每个孤儿目录都不含 artifact 边车（*.json.sha256）",
    orphanDetail.every((o) => !o.hasFinalizedArtifact), "孤儿目录都没有 finalize 产物",
    JSON.stringify({ dirs: dirs.length, entries: entries.length, orphanDetail }));
  if (orphanDetail.length) note("孤儿目录（没有索引条目的 run 目录）如实列出：" + JSON.stringify(orphanDetail) + " —— 它们都是**脚本在 finalize 之前就退出**的运行（崩溃/被中断），不含产物 JSON；本批的两次 affectedness 崩溃运行也在此列（见报告披露）。");

  const logs = checked.filter((c) => c.logOk === false).map((c) => c.runId);
  record("I6", "每条运行日志的 logSha256 也一致（日志同样没被改写）",
    logs.length === 0, "全部一致", JSON.stringify({ logMismatch: logs.slice(0, 10), checked: checked.length }));

  const thisBatch = entries.filter((e) => String(e.testedCommit || "").startsWith("ed4502d"));
  DETAIL.thisBatchRuns = thisBatch.map((e) => ({ runId: e.runId, script: e.script, counts: e.counts, exitCode: e.exitCode, artifactSha256: e.artifactSha256, logSha256: e.logSha256, cleanupSummary: e.cleanupSummary }));
  const missingLogSha = entries.filter((e) => !e.logSha256);
  record("I6b", "索引条目一致地**不记录** logSha256（既有工具缺口：run-artifacts.cjs 的 entry 引用 artifacts.logSha256，而该字段是写在 artifact 上的）；本批不改工具，改以产物 JSON 里的 logSha256 核对日志 —— 历史条目与新条目行为一致",
    missingLogSha.length === entries.length && !fs.readFileSync(indexPath, "utf8").includes("\"logSha256\""),
    "全部条目都缺该字段（一致）",
    JSON.stringify({ entries: entries.length, missingLogSha256: missingLogSha.length, indexHasLogSha256Key: fs.readFileSync(indexPath, "utf8").includes("logSha256") }));
  record("I7", "本批（testedCommit = ed4502d）新增的运行全部满足：有 counts、有 artifactSha256、有 cleanupSummary 且 pkillUsed=false",
    thisBatch.length > 0 && thisBatch.every((e) => e.counts && e.artifactSha256 && e.cleanupSummary && e.cleanupSummary.pkillUsed === false),
    "本批每条都有 counts / sha256 / pkillUsed=false",
    JSON.stringify({ count: thisBatch.length, runs: DETAIL.thisBatchRuns.map((r) => ({ runId: r.runId, counts: r.counts, exitCode: r.exitCode })) }));

  const out = {
    phase: "D5-03 第七批",
    title: "运行索引与历史产物完整性核对（逐条 sha256 复算）",
    runId: RUN.runId, runDir: RUN.runDirRel, startedAt: RUN.startedAt,
    testedCommit, openarcCommit: testedCommit, openarcBranch: gitText(["rev-parse", "--abbrev-ref", "HEAD"]),
    command: "node experiments/d5-03/batch7-index-integrity.mjs",
    scriptSha256: (() => { try { return sha256(fs.readFileSync(path.join(ROOT, "experiments/d5-03/batch7-index-integrity.mjs"))); } catch { return null; } })(),
    evidence: DETAIL,
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    observations: NOTES,
    at: new Date().toISOString(),
  };
  out.exitCode = failed === 0 ? 0 : 1;
  console.log(String.fromCharCode(10) + "结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: failed, total: CHECKS.length }));
  const fin = await RUN.finalize({ out, exitCode: out.exitCode, logLines: LOG_LINES, cleanup: { strategy: "none", leftovers: [], pkillUsed: false } });
  console.log("产物：" + fin.artifactPath + "（sha256 " + fin.artifactSha256.slice(0, 16) + "）");
  return out.exitCode;
}

let exitCode = 2;
try { exitCode = await main(); } catch (e) {
  console.error("核对异常：" + String((e && e.stack) || e));
  exitCode = 2;
}
process.exit(exitCode);
