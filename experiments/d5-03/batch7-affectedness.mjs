/**
 * D5-03 第七批 · 受影响性分析（不启动 Electron，不改任何既有门禁的判定）。
 *
 * 只做四件事，全部是机械证据：
 *   1) 列出本批被测提交（HEAD）相对上一提交改了什么（产品文件 / 测试文件 / 逐 hunk 的所属符号）；
 *   2) 对每一段既有门禁的**源码**做标记扫描：是否调用 device/* 命令、是否调用 identity/reset-installation、
 *      是否启动 electron .（会把改动模块加载进来）；给出"是否执行到本批改动的符号"的判定；
 *   3) 把"必须重跑 / 可复用"的结论与理由写成表，并把要复用的那次运行的 runId / counts / exit / sha256 一并取出；
 *   4) 记录工作树状态（本批验收不得改产品代码）。
 *
 * 查库/改库：无。只读 git 与文件。
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RUN_ARTIFACTS = require(path.join(here, "run-artifacts.cjs"));
const OWNERSHIP = require(path.join(here, "userdata-ownership.cjs"));

const CHECKS = [], LOG_LINES = [], EVIDENCE = {}, NOTES = [];
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
function git(args) { try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }).trim(); } catch (e) { return "GIT_FAILED:" + String((e && e.message) || e).slice(0, 200); } }
function readText(rel) { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } }
function jload(rel) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")); } catch { return null; } }

/** 被测提交与上一提交（本批 = HEAD）。 */
const TESTED = "ed4502d";
const GATES = [
  { name: "mcp-reset-e2e", script: "experiments/d5-03/mcp-reset-e2e.mjs", probe: null, decision: "重跑", why: "直接执行 identity/reset-installation（删除集合 4 → 7 张，就是本批改动本身）；机械命中 resetCall>0" },
  { name: "mcp-device-reset-e2e（本批新增）", script: "experiments/d5-03/mcp-device-reset-e2e.mjs", probe: null, decision: "重跑", why: "本批新增的真机门禁：设备三表 + 组织归属；机械命中 deviceCommand>0 / sessionOrgMismatch>0" },
  { name: "device-ui", script: "tests/device-ui.mjs", probe: "tests/fixtures/device-ui-probe/main.cjs", decision: "重跑", why: "设备面真机 UI 门禁：设备命令（device/*）与 DeviceService 构造都在它的执行路径上（机械命中 deviceCommand>0）" },
  { name: "identity-ui", script: "tests/identity-ui.mjs", probe: "tests/fixtures/identity-ui-probe/main.cjs", decision: "重跑（保守）", why: "机械判据 0 命中改动符号，但它驱动的 init/login/restore/lock/logout 正是被改文件 identity-store.cjs 的主路径，而且是 MCP 那几段门禁也依赖的同一段身份流程；跑它即可覆盖那段公共路径（成本 ~1 分钟）" },
  { name: "mcp-center-e2e", script: "experiments/d5-03/mcp-center-e2e.mjs", probe: null, decision: "复用第六批证据", why: "MCP 面：源码 0 命中 device/* 与 reset-installation（不执行本批任何改动符号）；身份公共路径由 identity-ui 的新鲜重跑覆盖" },
  { name: "mcp-stream-e2e", script: "experiments/d5-03/mcp-stream-e2e.mjs", probe: null, decision: "复用第六批证据", why: "同 mcp-center-e2e：0 命中 + 公共路径已覆盖" },
  { name: "mcp-policy-e2e", script: "experiments/d5-03/mcp-policy-e2e.mjs", probe: null, decision: "重跑（保守）", why: "0 命中改动符号，但它是与身份/授权取数最近的 MCP 门禁（43 条）；重跑成本 ~90 秒，不留复用歧义" },
];
/** 标记 → 它落在本批改动的哪个符号上。 */
const MARKERS = {
  deviceCommand: { re: /openarc\.device\.command|device\/(list|get|pairing\.create|pairing\.list|pairing\.revoke|disable|enable|revoke|rename|audit)"/g, symbol: "#sessionGate / createPairing / listPairings / listDevices / getDevice / authorizeDeviceById（device-service.cjs 改动区域）" },
  deviceServiceDirect: { re: /deviceService\.|DeviceService|device-service\.cjs|deviceStore\./g, symbol: "DeviceService（device-service.cjs 改动区域）" },
  resetCall: { re: /identity\/reset-installation"|resetInstallation\(/g, symbol: "resetInstallation / RESET_AUTHORIZATION_DELETE_SQL（identity-store.cjs 改动区域）" },
  resetSqlTable: { re: /RESET_AUTHORIZATION_DELETE_SQL|DELETE FROM (devices|device_credentials|device_pairing_credentials)/g, symbol: "RESET_AUTHORIZATION_DELETE_SQL（identity-store.cjs 改动区域）" },
  sessionOrgMismatch: { re: /SESSION_ORGANIZATION_MISMATCH/g, symbol: "#sessionGate 的自报组织校验（device-service.cjs 改动区域）" },
  bootsElectron: { re: /spawn\(electronPath, \["\.",|require\("electron"\)/g, symbol: "启动 electron .（改动模块在启动期被 require，属加载级影响）" },
};
const countMatches = (text, re) => (text.match(re) || []).length;

function parseHunks(parent, head) {
  const diff = git(["diff", "-U0", parent, head, "--", "electron/"]);
  const hunks = [];
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) { file = line.slice(6); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (m && file) hunks.push({ file, newStart: Number(m[1]), newLines: m[2] === undefined ? 1 : Number(m[2]), context: m[3] || "" });
  }
  return hunks;
}

async function main() {
  const RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "batch7-affectedness", basePort: 9851, envBaseVar: "OA_D503H_AFF_CDP_PORT", userDataPrefixBase: OWNERSHIP.PREFIX });
  console.log("本次分析（不启动 Electron）：" + RUN.runId + " → " + RUN.runDirRel);
  const head = git(["rev-parse", "HEAD"]);
  const parent = git(["rev-parse", "HEAD~1"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const files = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
  const productFiles = files.filter((f) => f.startsWith("electron/") || f.startsWith("src/"));
  const testFiles = files.filter((f) => f.startsWith("tests/"));
  const worktree = git(["status", "--porcelain"]).split("\n").filter(Boolean);
  const hunks = parseHunks(parent, head);
  EVIDENCE.batch = { testedCommit: head, testedPrefix: TESTED, parentCommit: parent, branch, files, productFiles, testFiles, hunks, worktree, numstat: git(["diff", "--numstat", parent, head]) };

  record("A1", "被测提交 = " + TESTED + "（integration/ui-core HEAD），产品面改动只有 electron/device-service.cjs 与 electron/identity-store.cjs",
    head.startsWith(TESTED) && productFiles.join(",") === "electron/device-service.cjs,electron/identity-store.cjs",
    "HEAD 以 " + TESTED + " 开头 + 产品改动 = device-service.cjs + identity-store.cjs",
    JSON.stringify({ head, branch, files, productFiles, testFiles, numstat: EVIDENCE.batch.numstat }));
  const trackedModified = worktree.filter((l) => /^ ?M/.test(l)).map((l) => l.trim());
  const productModified = trackedModified.filter((l) => !l.startsWith("experiments/d5-03/"));
  record("A2", "工作树里没有被本批验收改写的产品代码（已跟踪修改只能是 experiments/d5-03/ 下的门禁/报告）",
    productModified.length === 0,
    "已跟踪修改 ⊆ experiments/d5-03/",
    JSON.stringify({ worktree, trackedModified, productModified }));
  note("本批验收期间工作树里的已跟踪修改：" + JSON.stringify(trackedModified) + "；未跟踪新增：" + JSON.stringify(worktree.filter((l) => l.startsWith("??")).map((l) => l.trim())));

  /* ── B 逐门禁的机械扫描 ── */
  const rows = [];
  for (const g of GATES) {
    const src = readText(g.script);
    const probeSrc = g.probe ? readText(g.probe) : "";
    const all = src + String.fromCharCode(10) + probeSrc;
    const hits = {};
    for (const [key, mk] of Object.entries(MARKERS)) hits[key] = countMatches(all, mk.re);
    const executesChangedSymbol = hits.deviceCommand > 0 || hits.resetCall > 0 || hits.sessionOrgMismatch > 0;
    const row = {
      gate: g.name, script: g.script, probe: g.probe, bytes: src.length + probeSrc.length,
      hits, executesChangedSymbol, bootsElectron: hits.bootsElectron > 0,
      affected: executesChangedSymbol, decision: g.decision, mustRerun: g.decision.startsWith("重跑"), why: g.why,
    };
    rows.push(row);
    console.log("   · " + g.name + "：撞击标记 " + JSON.stringify(hits) + " → " + (row.mustRerun ? "必须重跑" : "可复用"));
  }
  EVIDENCE.gates = rows;
  record("B1", "机械判据：**执行到本批改动符号**的门禁 = 调用 device/* 命令 或 调用 identity/reset-installation 的那几段；其余门禁在源码里 0 命中（不执行 #sessionGate / resetInstallation）",
    rows.filter((r) => r.affected).map((r) => r.gate).sort().join(",") === ["device-ui", "mcp-device-reset-e2e（本批新增）", "mcp-reset-e2e"].sort().join(","),
    "机械命中改动符号的恰好是 mcp-reset-e2e / mcp-device-reset-e2e / device-ui 三段",
    JSON.stringify(rows.map((r) => ({ gate: r.gate, hits: r.hits, executesChangedSymbol: r.executesChangedSymbol, bootsElectron: r.bootsElectron, decision: r.decision }))));
  record("B2", "决定与判据不矛盾：机械命中改动符号的门禁一律重跑；标为「复用第六批证据」的门禁必须**没有**命中改动符号",
    rows.every((r) => (r.affected ? r.mustRerun : true)) && rows.filter((r) => !r.mustRerun).every((r) => !r.affected),
    "复用 ⇒ 未命中改动符号",
    JSON.stringify(rows.map((r) => ({ gate: r.gate, affected: r.affected, decision: r.decision }))));
  record("B3", "所有启动 electron . 的门禁都会在**启动期** require 被改的两个模块（加载级影响，identity-store.cjs 的 RESET_AUTHORIZATION_DELETE_SQL 是模块级常量）；本批以 4 段新鲜重跑（mcp-reset-e2e / mcp-device-reset-e2e / device-ui / identity-ui）覆盖这条公共路径，且它们与复用的 MCP 门禁走**同一个 electron . 入口 + 同一份 dist**",
    rows.filter((r) => r.bootsElectron).length === rows.length && rows.filter((r) => r.mustRerun && r.bootsElectron).length >= 4,
    "全部 7 段都启动 electron .；其中 >= 4 段本批重跑",
    JSON.stringify(rows.map((r) => ({ gate: r.gate, bootsElectron: r.bootsElectron, decision: r.decision }))));

  /* ── C 复用的证据：从只追加索引里取最近一次（第六批，提交 d1ba058） */
  const index = jload(path.join("artifacts", "d5-03", "runs", "index.json"));
  const runs = (index && index.runs) || [];
  const reuse = {};
  for (const name of ["mcp-center-e2e", "mcp-stream-e2e"]) {
    const list = runs.filter((r) => r.script === name).sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
    const last = list[list.length - 1] || null;
    reuse[name] = last ? { runId: last.runId, testedCommit: last.testedCommit, counts: last.counts, exitCode: last.exitCode, artifactSha256: last.artifactSha256, artifactPath: last.artifactPath, finishedAt: last.finishedAt } : null;
  }
  EVIDENCE.reuseCandidates = reuse;
  record("C1", "可复用证据（第六批同提交 d1ba058 上新鲜重跑的那两次）能从只追加索引里取到 runId / counts / exitCode / artifactSha256",
    !!reuse["mcp-center-e2e"] && !!reuse["mcp-stream-e2e"]
      && reuse["mcp-center-e2e"].exitCode === 0 && reuse["mcp-stream-e2e"].exitCode === 0
      && !!reuse["mcp-center-e2e"].artifactSha256 && !!reuse["mcp-stream-e2e"].artifactSha256,
    "两次运行的 runId + counts + exitCode=0 + artifactSha256 都非空",
    JSON.stringify(reuse));
  note("复用只给 mcp-center-e2e / mcp-stream-e2e（MCP 面，源码 0 命中 device/* 与 reset-installation）；mcp-policy-e2e 同样 0 命中但本批仍**重跑**（最贴近身份/授权取数）。复用的两次运行必须连同 runId / counts / exitCode / artifactSha256 写进报告，且 sha256 可回查 —— 本轮验收不改写它们的历史产物。");

  const out = {
    phase: "D5-03 第七批",
    title: "受影响性分析（机械证据：改动 hunk × 各门禁实际执行的代码路径）",
    runId: RUN.runId, runDir: RUN.runDirRel, startedAt: RUN.startedAt,
    testedCommit: head, openarcCommit: head, openarcBranch: branch,
    command: "node experiments/d5-03/batch7-affectedness.mjs",
    scriptSha256: (() => { try { return require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(ROOT, "experiments/d5-03/batch7-affectedness.mjs"))).digest("hex"); } catch { return null; } })(),
    evidence: EVIDENCE,
    table: rows.map((r) => ({ 门禁: r.gate, 是否执行本批改动符号: r.executesChangedSymbol, 是否启动electron: r.bootsElectron, 结论: r.mustRerun ? "重跑" : "复用第六批证据", 理由: r.why })),
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
  console.error("分析异常：" + String((e && e.stack) || e));
  exitCode = 2;
}
process.exit(exitCode);
