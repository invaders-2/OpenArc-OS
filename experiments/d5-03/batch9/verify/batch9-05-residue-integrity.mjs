/**
 * D5-03 第九批 · 独立验收 · 第三段（4）：残留与历史完整性
 *   ① TMPDIR 下 oa-d503* 残留；② 本任务自己的进程残留；③ artifacts/d5-03/runs/** 历史未被改写（索引 sha256 逐条复算）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const RUNS = path.join(ROOT, "artifacts/d5-03/runs");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const out = { at: new Date().toISOString() };

/* ① TMPDIR 残留 */
const tmp = fs.realpathSync(os.tmpdir());
out.tmpdir = tmp;
out.tmpResidue = fs.readdirSync(tmp).filter((d) => d.startsWith("oa-d503")).map((d) => {
  let owner = null; try { owner = JSON.parse(fs.readFileSync(path.join(tmp, d, "owner.json"), "utf8")); } catch { /* ignore */ }
  return { dir: d, owner, mtime: fs.statSync(path.join(tmp, d)).mtime.toISOString() };
});

/* ② 进程残留（只查本任务自己的标记） */
const ps = execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" });
const PATTERNS = [/batch9-harness-timeout-ui-probe/, /batch9-0[0-9]-/, /start-hang-agent\.mjs/, /turn-hang-agent\.mjs/, /session-new-hang-agent\.mjs/];
out.processResidue = ps.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => PATTERNS.some((re) => re.test(l)));

/* ③ 历史 run 产物完整性：索引逐条复算 sha256 */
const indexPath = path.join(RUNS, "index.json");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const rows = index.runs.map((r) => {
  const artAbs = path.join(ROOT, r.artifactPath);
  const logAbs = path.join(ROOT, r.logPath);
  let artSha = null, logSha = null, artMtime = null;
  try { const b = fs.readFileSync(artAbs); artSha = sha(b); artMtime = fs.statSync(artAbs).mtime.toISOString(); } catch { /* missing */ }
  try { logSha = sha(fs.readFileSync(logAbs)); } catch { /* missing */ }
  return { runId: r.runId, startedAt: r.startedAt, exitCode: r.exitCode, artifactPath: r.artifactPath,
    recordedArtifactSha256: r.artifactSha256 || null, recomputedArtifactSha256: artSha, artifactShaMatches: !!artSha && artSha === r.artifactSha256,
    recordedLogSha256: r.logSha256 || null, recomputedLogSha256: logSha, logShaMatches: !!logSha && logSha === r.logSha256, artifactMtime: artMtime };
});
out.indexEntries = rows.length;
// 只对**索引里真的记了 hash** 的字段判定：早期条目 logSha256=null（当时不记日志摘要），
// 那不算"被改写"，要单独统计，不能混进不一致。
out.indexEntriesWithoutRecordedLogSha = rows.filter((r) => !r.recordedLogSha256).length;
out.indexEntriesWithoutRecordedArtifactSha = rows.filter((r) => !r.recordedArtifactSha256).length;
out.indexMismatches = rows.filter((r) => (r.recordedArtifactSha256 && !r.artifactShaMatches) || (r.recordedLogSha256 && !r.logShaMatches));
out.indexMissingArtifacts = rows.filter((r) => !r.recomputedArtifactSha256);
out.indexEntriesTouchedToday = rows.filter((r) => r.artifactMtime && r.artifactMtime.slice(0, 10) === new Date().toISOString().slice(0, 10));
out.runsDirListing = fs.readdirSync(RUNS).filter((d) => d !== "index.json" && d !== "index.jsonl").length;

/* ④ 本会话内 runs/ 下 mtime 变化过的文件（应只有本批自己的 run 目录 + 索引） */
const cutoff = Date.now() - 3 * 3600 * 1000;
const modified = [];
for (const d of fs.readdirSync(RUNS)) {
  const p = path.join(RUNS, d);
  const st = fs.statSync(p);
  if (st.isDirectory()) { for (const f of fs.readdirSync(p)) { const fp = path.join(p, f); const s2 = fs.statSync(fp); if (s2.mtimeMs > cutoff) modified.push({ file: path.relative(ROOT, fp), mtime: s2.mtime.toISOString() }); } }
  else if (st.mtimeMs > cutoff) modified.push({ file: path.relative(ROOT, p), mtime: st.mtime.toISOString() });
}
out.recentlyModifiedInRuns = modified.sort((a, b) => a.mtime.localeCompare(b.mtime));
out.indexSha256 = sha(fs.readFileSync(indexPath));
out.indexMtime = fs.statSync(indexPath).mtime.toISOString();
fs.writeFileSync(path.join(HERE, "batch9-05-residue-integrity.json"), JSON.stringify(out, null, 2));

console.log("① TMPDIR oa-d503* 残留：" + JSON.stringify(out.tmpResidue));
console.log("② 进程残留：" + (out.processResidue.length ? JSON.stringify(out.processResidue) : "0 条"));
console.log("③ 索引条目 " + out.indexEntries + " 条，sha256 复算不一致 " + out.indexMismatches.length + " 条" + (out.indexMismatches.length ? "：" + JSON.stringify(out.indexMismatches, null, 1) : "（全部一致）"));
const byDir = {};
for (const m of out.recentlyModifiedInRuns) { const d = m.file.split("/").slice(0, -1).join("/"); byDir[d] = (byDir[d] || 0) + 1; }
out.recentlyModifiedByDir = byDir;
out.recentlyModifiedOutsideMyRuns = out.recentlyModifiedInRuns.filter((m) => !/-batch9-/.test(m.file));
console.log("④ 近 3 小时内 runs/ 下被改动的文件（按目录汇总）：" + JSON.stringify(byDir, null, 1));
console.log("④b 其中**不属于本批 batch9 run**的文件：" + JSON.stringify(out.recentlyModifiedOutsideMyRuns));
console.log("index.json sha256=" + out.indexSha256 + " mtime=" + out.indexMtime);
process.exit(out.indexMismatches.length ? 1 : 0);
