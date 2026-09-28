/**
 * D5-03 第四批 · oa-d503b-* 临时 userData 目录的**归属标记 + 清理**。
 *
 * 为什么单独成文件：这类目录是 experiments/d5-03/mcp-policy-e2e.mjs 跑真机验收时
 * mkdtempSync 出来的（Electron 的 --user-data-dir，以及 v20 旧代码的 git-archive 解包树），
 * 一旦脚本被 Ctrl-C / 超时 kill / 崩在收尾之前，就会永久留在 OS 临时目录里。清理这种目录
 * 必须能**证明归属**，否则就有误删别人临时数据的风险。所以：
 *
 *   · 新建目录一律写归属标记 owner.json（脚本名 + runId + pid + 创建时刻 + 用途）；
 *   · 本次运行收尾只删"自己登记过、且标记确实是自己"的目录（cleanupOwnedDirs）；
 *   · 历史孤儿目录走 cleanOrphans，三个条件缺一不删：
 *       (a) 名字以 oa-d503b- 开头（本脚本命名空间）；
 *       (b) 能证明是本脚本产物 —— owner.json 标记 / 目录内含本脚本 userData 的 identity.db /
 *           本脚本 legacy 解包树的形状（electron/identity-bootstrap.cjs + package.json）；
 *       (c) 归属进程已不在 —— 标记里的 pid 已死 / 标记写明 run 已结束 /
 *           无标记时：ps 里没有任何存活进程引用该目录路径，且该 runId 的 run 产物目录已存在；
 *   · 只删 oa-d503b- 前缀，其它前缀一律不碰；不使用 pkill，不使用 shell 通配符扫删；
 *   · 每个删除/跳过都打日志。
 *
 * 命令行（默认 dry-run，加 --apply 才真删）：
 *   node experiments/d5-03/userdata-ownership.cjs --clean-orphans [--apply] [--root DIR] [--runs-dir DIR]
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const MARKER = "owner.json";
const PREFIX = "oa-d503b-";
const SCRIPT = "mcp-policy-e2e";
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_RUNS_DIR = path.join(REPO_ROOT, "artifacts", "d5-03", "runs");
const RUN_TAG = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;
const LEGACY_TREE_NAME = /^oa-d503b-.*-legacy-[A-Za-z0-9]{6}$/;

/** 本进程登记过、确认由我创建的目录（清理只认这份清单）。 */
const OWNED = [];

function isOwnName(name) {
  return typeof name === "string" && name.startsWith(PREFIX);
}

/** 从目录名或 runId 里取 run 记号（<stamp>-<4hex>）：拿不到就没法做 run 归档交叉核对。 */
function tagOf(text) {
  const value = String(text || "");
  const inName = /^oa-d503b-(\d{8}T\d{6}Z-[0-9a-f]{4})-/.exec(value);
  if (inName) return inName[1];
  const bare = /^(\d{8}T\d{6}Z-[0-9a-f]{4})(?:-|$)/.exec(value);
  return bare ? bare[1] : null;
}

function writeOwnerMarker(dir, meta = {}) {
  const marker = {
    script: SCRIPT,
    runId: meta.runId == null ? null : String(meta.runId),
    pid: process.pid,
    createdAt: new Date().toISOString(),
    kind: meta.kind == null ? "userdata" : String(meta.kind),
    prefix: meta.prefix == null ? PREFIX : String(meta.prefix),
  };
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(marker, null, 2) + "\n", { mode: 0o600 });
  return marker;
}

function readOwnerMarker(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, MARKER), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 创建本次运行的临时目录并立刻打归属标记。root 只为离线测试提供沙箱根，生产不传。 */
function createOwnedDir({ prefix = PREFIX, kind = "userdata", runId = null, registry = OWNED, root = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(root, prefix));
  writeOwnerMarker(dir, { kind, runId, prefix });
  registry.push(dir);
  return dir;
}

/** 归属 pid 是否还活着；"标记说 run 已结束"直接算不活。pid 无法判定 → 视为活着（fail-closed）。 */
function ownerPidState(marker) {
  if (!marker) return "unknown";
  if (marker.runEnded === true) return "ended";
  const pid = Number(marker.pid);
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  if (pid === process.pid) return "self";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return err && err.code === "ESRCH" ? "dead" : "alive";
  }
}

/** ps 快照：一次性取回，避免每个目录都 spawn 一次。取不到 → 返回 null（fail-closed）。 */
function psSnapshot() {
  try {
    return String(execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 8 << 20 }));
  } catch {
    return null;
  }
}

/** 是否有存活进程仍引用这个目录路径（绝不用 pkill，只做只读判断）。 */
function isDirInUse(dir, snapshot) {
  if (snapshot == null) return true;
  const needle = path.resolve(dir);
  for (const line of snapshot.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(" ");
    const pid = Number(trimmed.slice(0, sp));
    if (pid === process.pid) continue;
    if (trimmed.slice(sp + 1).includes(needle)) return true;
  }
  return false;
}

/** 本脚本这次 run 的产物目录是否已归档（用于给"无标记旧产物"补一条 run 已结束的证据）。 */
function runRecordExists(runsDir, tag) {
  if (!runsDir || !tag) return false;
  try {
    return fs.readdirSync(runsDir).some((name) => name.startsWith(tag + "-" + SCRIPT));
  } catch {
    return false;
  }
}

/** 归属证明：owner.json 标记 / 本脚本 userData 的 identity.db / 本脚本 legacy 解包树形状。 */
function ownershipProof({ dir, name, marker }) {
  if (marker && marker.script === SCRIPT) {
    const markerTag = tagOf(marker.runId || "");
    const dirTag = tagOf(name);
    if (markerTag && dirTag && markerTag !== dirTag) return { ok: false, reason: "owner.json 的 runId 与目录名不一致（" + marker.runId + " vs " + name + "）" };
    return { ok: true, kind: "owner-marker", reason: "owner.json 归属标记（pid=" + marker.pid + ", kind=" + marker.kind + "）" };
  }
  if (marker && marker.script !== SCRIPT) return { ok: false, reason: "owner.json 属于别的脚本：" + String(marker.script) };
  if (fs.existsSync(path.join(dir, "identity.db"))) return { ok: true, kind: "identity-db", reason: "目录内含本脚本 userData 特征 identity.db" };
  if (LEGACY_TREE_NAME.test(name) && fs.existsSync(path.join(dir, "electron", "identity-bootstrap.cjs")) && fs.existsSync(path.join(dir, "package.json"))) {
    return { ok: true, kind: "legacy-tree", reason: "本脚本 legacy v20 解包树形状（electron/identity-bootstrap.cjs + package.json）" };
  }
  return { ok: false, reason: "无法证明是本脚本产物" };
}

/** 单个候选目录的三条件判定（纯逻辑，便于离线单测）。 */
function classifyCandidate({ dir, name, marker, dirInUse, runRecord }) {
  if (!isOwnName(name)) return { action: "skip", reason: "前缀不是 " + PREFIX };
  if (dirInUse) return { action: "skip", reason: "仍有存活进程引用该目录（或 ps 不可用）" };
  const proof = ownershipProof({ dir, name, marker });
  if (!proof.ok) return { action: "skip", reason: proof.reason };
  const pidState = ownerPidState(marker);
  if (pidState === "alive" || pidState === "self") return { action: "skip", reason: "归属 pid 仍存活（" + marker.pid + "）" };
  if (pidState === "unknown" && !runRecord) return { action: "skip", reason: "无归属 pid 可查，且拿不到 run 归档证据" };
  return { action: "delete", proof: proof.kind, pidState, reason: proof.reason + "；" + (pidState === "ended" ? "标记显示 run 已结束" : "无存活进程引用 + run 产物已归档") };
}

/** 只在 os.tmpdir() 下、且名字属于本脚本命名空间时才算候选。 */
function listCandidates(root = os.tmpdir()) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    throw new Error("读不到临时根目录 " + root + "：" + String(err && err.message));
  }
  const out = [];
  for (const name of names.sort()) {
    if (!isOwnName(name)) continue;
    const dir = path.join(root, name);
    let stat;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) { out.push({ dir, name, symlink: true }); continue; }
    if (!stat.isDirectory()) { out.push({ dir, name, notDirectory: true }); continue; }
    out.push({ dir, name, symlink: false, notDirectory: false });
  }
  return out;
}

/**
 * 历史孤儿清理。默认 dry-run；apply=true 才真删。每个候选都打一行日志。
 * @returns {{ root:string, apply:boolean, scanned:number, deleted:string[], skipped:Array }}
 */
function cleanOrphans({ root = os.tmpdir(), apply = false, runsDir = DEFAULT_RUNS_DIR, log = console.log } = {}) {
  const report = { root, apply, scanned: 0, deleted: [], skipped: [] };
  const snapshot = psSnapshot();
  for (const candidate of listCandidates(root)) {
    const { dir, name } = candidate;
    if (candidate.symlink || candidate.notDirectory) {
      report.skipped.push({ name, reason: candidate.symlink ? "符号链接（不跟随、不删）" : "不是目录" });
      log("[SKIP] " + name + " —— " + report.skipped[report.skipped.length - 1].reason);
      continue;
    }
    report.scanned++;
    const marker = readOwnerMarker(dir);
    const dirInUse = isDirInUse(dir, snapshot);
    const runRecord = runRecordExists(runsDir, tagOf(name));
    const verdict = classifyCandidate({ dir, name, marker, dirInUse, runRecord });
    if (verdict.action !== "delete") {
      report.skipped.push({ name, reason: verdict.reason });
      log("[SKIP] " + name + " —— " + verdict.reason);
      continue;
    }
    if (!apply) {
      report.deleted.push(name);
      log("[DRY-RUN] 会删 " + name + " —— 证据：" + verdict.reason);
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(dir)) throw new Error("删除后目录仍存在：" + dir);
    report.deleted.push(name);
    log("[DELETED] " + name + " —— 证据：" + verdict.reason);
  }
  log("[" + (apply ? "APPLY" : "DRY-RUN") + "] " + report.root + "：扫描本命名空间目录 " + report.scanned + " 个，删除 " + report.deleted.length + " 个，跳过 " + report.skipped.length + " 个");
  return report;
}

/**
 * 本次运行自建目录的收尾清理：**只按创建清单 + 自己的标记**，绝不扫描通配符。
 * 目录不在 os.tmpdir() 下、名字不属于本命名空间、标记不是本进程写的 → 一律跳过并记日志。
 * @returns {string[]} 已删除目录的 basename（写入验收产物 cleanup.userDataDirsRemoved）
 */
function cleanupOwnedDirs({ log = console.log, registry = OWNED, root = os.tmpdir() } = {}) {
  const removed = [];
  const rootReal = fs.realpathSync(root);
  while (registry.length) {
    const dir = registry.shift();
    const name = path.basename(dir);
    if (!isOwnName(name)) { log("[KEEP] " + name + " —— 名字不属于本脚本命名空间"); continue; }
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch { continue; }
    if (path.dirname(real) !== rootReal) { log("[KEEP] " + name + " —— 不在清理根目录 " + rootReal + " 下：" + real); continue; }
    const marker = readOwnerMarker(dir);
    if (!marker || marker.script !== SCRIPT || Number(marker.pid) !== process.pid) {
      log("[KEEP] " + name + " —— 归属标记不是本进程写的（不删）");
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(dir)) { log("[FAILED] " + name + " —— 删除后仍存在"); continue; }
    removed.push(name);
    log("[REMOVED] " + name);
  }
  return removed;
}

function main(argv = process.argv.slice(2)) {
  const has = (flag) => argv.includes(flag);
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  if (has("--clean-orphans")) {
    const root = valueOf("--root") || os.tmpdir();
    const runsDir = valueOf("--runs-dir") || DEFAULT_RUNS_DIR;
    const apply = has("--apply");
    console.log("orphan 清理" + (apply ? "（APPLY：真删）" : "（DRY-RUN：只看不删，加 --apply 才真删）") + "：root=" + root + " runsDir=" + runsDir);
    const report = cleanOrphans({ root, runsDir, apply });
    return report.skipped.some((s) => String(s.reason).includes("读不到")) ? 2 : 0;
  }
  console.log("用法：node experiments/d5-03/userdata-ownership.cjs --clean-orphans [--apply] [--root DIR] [--runs-dir DIR]");
  console.log("（默认 dry-run；只处理 " + PREFIX + " 前缀、能证明归属、且归属进程已不在的目录）");
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  MARKER,
  PREFIX,
  SCRIPT,
  DEFAULT_RUNS_DIR,
  OWNED,
  isOwnName,
  tagOf,
  writeOwnerMarker,
  readOwnerMarker,
  createOwnedDir,
  ownerPidState,
  psSnapshot,
  isDirInUse,
  runRecordExists,
  ownershipProof,
  classifyCandidate,
  listCandidates,
  cleanOrphans,
  cleanupOwnedDirs,
  main,
};
