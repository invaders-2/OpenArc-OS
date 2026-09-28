/**
 * D5-03 验收运行隔离助手（门禁证据隔离）。被 mcp-center-e2e.mjs / mcp-policy-e2e.mjs 以 require 载入。
 *
 * 只做三件事，不参与任何 checks 判定：
 *   1) 每次运行一个独立目录 artifacts/d5-03/runs/<runId>/（JSON / 日志 / 截图 / motion 同目录）；
 *   2) 从环境变量基址起递增探测并占住空闲 CDP 端口，收尾只释放本次占的；
 *   3) 源码指纹集（含 missing/modified 如实标注）+ 只追加的运行索引 runs/index.json（另存 index.jsonl 兜底）。
 *
 * 历史约定：旧文档引用的 artifacts/d5-03/<script>.json 不再写入（历史文件原样保留），同名文件改为写在 run 目录内。
 */
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const D503_REL = path.join("artifacts", "d5-03");
const RUNS_REL = path.join(D503_REL, "runs");
const INDEX_SCHEMA = 1;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const sha256_16 = (buf) => sha256(buf).slice(0, 16);
/** 2026-09-24T15:12:33.123Z → 20260924T151233Z（文件名安全，可排序） */
const utcStamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const rel = (root, p) => path.relative(root, p).split(path.sep).join("/");
const readMaybe = (p) => { try { return fs.readFileSync(p); } catch { return null; } };

/* stderr 显式丢弃：git 在非仓库根调用时不该把错误打到验收日志里 */
const GIT_STDIO = ["ignore", "pipe", "pipe"];
function gitText(root, args) {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: GIT_STDIO }).trim(); } catch { return null; }
}
function gitBlob(root, revPath) {
  try { return execFileSync("git", ["-C", root, "cat-file", "blob", revPath], { maxBuffer: 1 << 28, stdio: GIT_STDIO }); } catch { return null; }
}
function lsFiles(root, dir) {
  try { return fs.readdirSync(path.join(root, dir)).filter((f) => fs.statSync(path.join(root, dir, f)).isFile()).sort(); } catch { return []; }
}

/** 被测相关文件全集：electron/mcp-*.cjs + 授权/治理/身份/执行器 + 渲染层 + fixture + 两个验收脚本自身。 */
function d503SourceFiles(root) {
  const files = [
    ...lsFiles(root, "electron").filter((f) => /^mcp-.*\.cjs$/.test(f)).map((f) => "electron/" + f),
    "electron/identity-store.cjs",
    "electron/authorization-store.cjs",
    "electron/authorization-service.cjs",
    "electron/governance-service.cjs",
    "electron/executor-launcher.cjs",
    ...lsFiles(root, "tests/fixtures/mcp").map((f) => "tests/fixtures/mcp/" + f),
    "src/mcp/McpCenter.tsx",
    "experiments/d5-03/mcp-center-e2e.mjs",
    "experiments/d5-03/mcp-policy-e2e.mjs",
  ];
  return [...new Set(files)];
}

/**
 * 每个文件：sha256 前 16 位 + 是否与被测提交一致；提交里没有就如实标 missing-in-commit，工作树没有标 missing-in-worktree。
 */
function collectSourceFingerprint(root, files, testedRevision = "HEAD") {
  const tracked = new Set((gitText(root, ["ls-tree", "-r", "--name-only", testedRevision]) || "").split("\n").filter(Boolean));
  const rows = {};
  for (const f of files) {
    const buf = readMaybe(path.join(root, f));
    const inCommit = tracked.has(f);
    const commitBuf = inCommit ? gitBlob(root, testedRevision + ":" + f) : null;
    const worktreeSha = buf ? sha256_16(buf) : null;
    const commitSha = commitBuf ? sha256_16(commitBuf) : null;
    const status = !buf ? "missing-in-worktree" : (!inCommit ? "untracked" : (worktreeSha === commitSha ? "ok" : "modified"));
    rows[f] = { sha256_16: worktreeSha, inTestedCommit: inCommit, commitSha256_16: commitSha, worktreeMatchesCommit: !!(worktreeSha && commitSha && worktreeSha === commitSha), status };
  }
  const missing = Object.entries(rows).filter(([, v]) => v.status.startsWith("missing")).map(([k]) => k).sort();
  const modified = Object.entries(rows).filter(([, v]) => v.status === "modified" || v.status === "untracked").map(([k]) => k).sort();
  const setSha = sha256(files.slice().sort().map((f) => f + "=" + (rows[f].sha256_16 || rows[f].status)).join("\n"));
  return { testedRevision, files: rows, counts: { total: files.length, ok: Object.values(rows).filter((v) => v.status === "ok").length, missing: missing.length, modified: modified.length }, missingFiles: missing, modifiedFiles: modified, setSha256: setSha };
}

function listenExclusive(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(null));
    srv.listen({ port, host, exclusive: true }, () => resolve(srv));
  });
}
function closeServer(srv) {
  return new Promise((resolve) => { try { srv.close(() => resolve(true)); } catch { resolve(false); } });
}

async function createRun({ root, script, basePort, portSpan = 64, envBaseVar = null, userDataPrefixBase = "oa-d503-" }) {
  const startedAt = new Date().toISOString();
  const stamp = utcStamp();
  const rand = crypto.randomBytes(2).toString("hex");
  const tag = stamp + "-" + rand;
  const runsDir = path.join(root, RUNS_REL);
  fs.mkdirSync(runsDir, { recursive: true });
  let runId = tag + "-" + script, runDir = path.join(runsDir, runId), tries = 0;
  while (true) { // run 目录已存在就换一个 id：绝不覆盖别人的 run
    try { fs.mkdirSync(runDir, { recursive: false }); break; } catch (e) {
      if (e && e.code === "EEXIST" && ++tries < 5) { runId = tag + "-" + crypto.randomBytes(2).toString("hex") + "-" + script; runDir = path.join(runsDir, runId); continue; }
      throw e;
    }
  }
  const held = new Map();
  const portProbes = [];
  const run = {
    runId, tag, script, startedAt, root,
    runsDir, runDir, runDirRel: rel(root, runDir),
    jsonPath: path.join(runDir, script + ".json"),
    logPath: path.join(runDir, script + ".log"),
    indexPath: path.join(runsDir, "index.json"),
    userDataPrefix: userDataPrefixBase + tag + "-",
    basePort, envBaseVar, portProbes, ports: [],
    releaseAllPorts,
    /** 从 base 起递增探测并**占住**一个空闲端口；释放由调用方在 Electron 真正 spawn 前执行。 */
    acquirePort,
    finalize,
  };
  return run;

  async function acquirePort(base) {
    for (let p = base; p < base + portSpan; p++) {
      let srv = held.get(p);
      if (!srv) { srv = await listenExclusive(p, "127.0.0.1"); if (!srv) continue; held.set(p, srv); }
      const probe = { requested: base, granted: p, at: new Date().toISOString() };
      portProbes.push(probe);
      if (!run.ports.includes(p)) run.ports.push(p);
      return { port: p, requested: base, release: () => releasePort(p) };
    }
    throw new Error("CDP 端口探测失败：" + base + " 起的 " + portSpan + " 个端口都不可用（env " + envBaseVar + "）");
  }
  async function releasePort(p) {
    const srv = held.get(p);
    if (!srv) return false;
    held.delete(p);
    return await closeServer(srv);
  }
  async function releaseAllPorts() {
    const ports = [...held.keys()];
    for (const p of ports) await releasePort(p);
    return ports;
  }

  /**
   * 写 run JSON + 日志 + 追加索引。out 由脚本构建（checks 等原样），这里只补运行元数据。
   * artifactSha256 写完后自算并回填索引；同一 runId 的索引项绝不改写。
   */
  async function finalize({ out, exitCode, logLines = [], cleanup = null }) {
    await releaseAllPorts();
    const finishedAt = new Date().toISOString();
    const artifact = out && typeof out === "object" ? out : {};
    const artifacts = {
      runId, runDir: run.runDirRel, startedAt, finishedAt, exitCode,
      cdpPort: run.ports[0] ?? null, cdpPorts: run.ports.slice(), cdpPortProbes: portProbes,
      userDataPrefix: run.userDataPrefix, command: artifact.command || process.argv.join(" "), invocation: process.argv.join(" "),
      artifactPath: rel(root, run.jsonPath), logPath: rel(root, run.logPath),
      cleanup,
    };
    if (cleanup) logLines.push("清理（只本次运行的 pid 树）：" + JSON.stringify(cleanup));
    fs.writeFileSync(run.logPath, logLines.join("\n") + "\n");
    const logBuf = fs.readFileSync(run.logPath);
    Object.assign(artifact, artifacts, { logBytes: logBuf.length, logSha256: sha256(logBuf) });
    fs.writeFileSync(run.jsonPath, JSON.stringify(artifact, null, 2));
    const artifactBuf = fs.readFileSync(run.jsonPath);
    const artifactSha256 = sha256(artifactBuf);
    fs.writeFileSync(run.jsonPath + ".sha256", artifactSha256 + "  " + path.basename(run.jsonPath) + "\n");
    const entry = {
      runId, script, scriptPath: "experiments/d5-03/" + script + ".mjs",
      startedAt, finishedAt, exitCode,
      testedCommit: artifact.testedCommit || artifact.openarcCommit || gitText(root, ["rev-parse", "HEAD"]),
      testedBranch: artifact.openarcBranch || gitText(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
      counts: artifact.counts || null,
      notVerifiedCount: Array.isArray(artifact.notVerified) ? artifact.notVerified.length : null,
      cdpPort: run.ports[0] ?? null, cdpPorts: run.ports.slice(), userDataPrefix: run.userDataPrefix,
      command: artifacts.command, env: artifact.env || null,
      sourceFingerprintSetSha256: artifact.sourceFingerprintSetSha256 || null,
      missingFiles: (artifact.sourceFingerprint && artifact.sourceFingerprint.missingFiles) || null,
      modifiedFiles: (artifact.sourceFingerprint && artifact.sourceFingerprint.modifiedFiles) || null,
      runDir: run.runDirRel,
      artifactPath: artifacts.artifactPath, artifactSha256,
      logPath: artifacts.logPath, logSha256: artifacts.logSha256,
      cleanupSummary: cleanup ? { strategy: cleanup.strategy, leftovers: cleanup.leftovers, pkillUsed: cleanup.pkillUsed } : null,
    };
    await appendIndex(root, entry);
    return { ...artifacts, artifactSha256, entry };
  }
}

/** 只追加：同一 runId 绝不重复、绝不改写已有项；index.jsonl 追加兜底，index.json 锁内 tmp+rename 原子替换。 */
async function appendIndex(root, entry) {
  const runsDir = path.join(root, RUNS_REL);
  const indexPath = path.join(runsDir, "index.json");
  const jsonlPath = path.join(runsDir, "index.jsonl");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.appendFileSync(jsonlPath, JSON.stringify(entry) + "\n");
  const lock = indexPath + ".lock";
  let locked = false;
  for (let i = 0; i < 200 && !locked; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); locked = true; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock); } catch { /* ignore */ }
      if (!locked) await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    let doc = { schema: INDEX_SCHEMA, runs: [] };
    if (fs.existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        doc = { schema: parsed.schema || INDEX_SCHEMA, runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
      } catch {
        fs.copyFileSync(indexPath, path.join(runsDir, "index.corrupt-" + entry.runId + ".json")); // 坏文件留档，不丢历史
      }
    }
    if (!doc.runs.some((r) => r && r.runId === entry.runId)) doc.runs.push(entry);
    doc.updatedAt = new Date().toISOString();
    const tmp = indexPath + ".tmp-" + process.pid + "-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, indexPath);
  } finally { if (locked) { try { fs.unlinkSync(lock); } catch { /* ignore */ } } }
  return { indexPath, jsonlPath, locked };
}

/** 旧文档引用兼容：run 目录内的同名 JSON 优先取最新，找不到再退回根目录历史文件。 */
function findLatestRunArtifact(root, script) {
  const runsDir = path.join(root, RUNS_REL);
  const found = [];
  try {
    for (const d of fs.readdirSync(runsDir)) {
      const f = path.join(runsDir, d, script + ".json");
      try { const st = fs.statSync(f); if (st.isFile()) found.push({ file: f, mtimeMs: st.mtimeMs, legacy: false }); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  const newest = (list) => list.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
  const fromRun = newest(found.filter((f) => !f.legacy)); // run 目录优先
  if (fromRun) return fromRun;
  const legacy = path.join(root, D503_REL, script + ".json");
  try { const st = fs.statSync(legacy); if (st.isFile()) found.push({ file: legacy, mtimeMs: st.mtimeMs, legacy: true }); } catch { /* ignore */ }
  return newest(found);
}

module.exports = { createRun, appendIndex, collectSourceFingerprint, d503SourceFiles, findLatestRunArtifact, sha256, sha256_16, utcStamp, D503_REL, RUNS_REL };
