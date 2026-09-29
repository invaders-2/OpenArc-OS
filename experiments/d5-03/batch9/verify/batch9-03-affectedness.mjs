/**
 * D5-03 第九批 · 独立验收 · 第三段（1）：受影响的 D4/任务门禁 —— 机械证据。
 *
 * 方法（全部机械化，不靠印象）：
 *   1) 从 package.json 取所有 D4/任务相关门禁脚本，解析出它们**真实执行**的测试文件清单
 *      （experiments 下各 run-all.mjs 的 FILES 数组 / node --test 参数）；
 *   2) 对每个测试文件做 import/require 传递闭包（含 tests/fixtures/**），
 *      判定它是否真的加载了本批改动的模块（electron/task-harness-orchestrator.cjs / task-domain.cjs）；
 *   3) 判定它是否**能够到达改动的分支**：本批唯一语义改动 = classifyHarnessError 里
 *      code === "HARNESS_START_TIMEOUT" 的返回（old: TURN_TIMEOUT）。只有真正会产生
 *      「启动超时」的用例才受影响（闭包里出现 startTimeoutMs / start-hang-agent.mjs /
 *      HARNESS_START_TIMEOUT）。
 *   4) 只有 (2) 与 (3) 同时成立的门禁才算**真受影响**，必须重跑；其余复用既有证据并写明理由。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const CHANGED = ["electron/task-domain.cjs", "electron/task-harness-orchestrator.cjs"];
// 「改动分支可达」的唯一决定性证据：闭包里存在**真的会产生启动超时**的用例/夹具
// —— 即 spawn start-hang-agent.mjs（initialize 永不返回）的测试或 fixture。
// 单独出现 startTimeoutMs / HARNESS_START_TIMEOUT 字符串不算：前者是产品参数名，后者是产品枚举本身。
const BRANCH_MARKERS = [/start-hang-agent\.mjs/];
const INJECTION_MARKER = /startTimeoutMs\s*[:=]\s*[0-9]/;
const IMPORT_RE = /(?:from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g;

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** 解析一个测试文件的传递闭包（只跟相对路径 / tests 内路径）。 */
function closure(entry, seen = new Set()) {
  const files = new Set();
  const walk = (file) => {
    const key = path.resolve(file);
    if (seen.has(key)) return;
    seen.add(key);
    files.add(rel(key));
    let text = "";
    try { text = fs.readFileSync(key, "utf8"); } catch { return; }
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(text))) {
      const spec = m[1];
      let target = null;
      if (spec.startsWith(".")) target = path.resolve(path.dirname(key), spec);
      else if (spec.startsWith("tests/")) target = path.resolve(ROOT, spec);
      if (!target) continue;
      if (exists(target)) { walk(target); continue; }
      for (const ext of [".mjs", ".cjs", ".js", "/index.mjs", "/index.cjs"]) if (exists(target + ext)) { walk(target + ext); break; }
    }
  };
  walk(entry);
  return [...files].sort();
}

/** 从 run-all.mjs / npm 脚本里取真实执行的测试文件清单。 */
function gateFiles(scriptCmd) {
  const m = /node\s+(?:--test[^\s]*\s+)?(.*)$/.exec(scriptCmd.trim());
  const target = (m ? m[1] : "").trim();
  if (/^experiments\/[\w.-]+\/run-all\.mjs$/.test(target.split(/\s+/)[0])) {
    const runner = path.join(ROOT, target.split(/\s+/)[0]);
    let text = "";
    try { text = fs.readFileSync(runner, "utf8"); } catch { return { runner: rel(runner), files: [], how: "runner-unreadable" }; }
    const arr = /const FILES = \[([\s\S]*?)\];/.exec(text);
    const files = arr ? [...arr[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]).filter((f) => exists(path.join(ROOT, f))) : [];
    return { runner: rel(runner), files, how: arr ? "run-all.mjs FILES[]" : "run-all.mjs(no FILES)" };
  }
  const files = target.split(/\s+/).filter((f) => /\.(mjs|cjs|js)$/.test(f) && exists(path.join(ROOT, f)));
  return { runner: target.split(/\s+/)[0] || null, files, how: "package.json 命令直给" };
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const gates = Object.entries(pkg.scripts).filter(([k]) => /^test:(d4-|d5-03)/.test(k));

const rows = [];
for (const [name, cmd] of gates) {
  const g = gateFiles(cmd);
  const all = new Set();
  for (const f of g.files) for (const x of closure(path.join(ROOT, f))) all.add(x);
  const loadsChanged = CHANGED.filter((c) => all.has(c));
  const branchHits = [...all].filter((f) => !f.startsWith("electron/") && !f.startsWith("src/")).filter((f) => { try { const t = fs.readFileSync(path.join(ROOT, f), "utf8"); return BRANCH_MARKERS.some((re) => re.test(t)) || (INJECTION_MARKER.test(t) && /hang/i.test(t)); } catch { return false; } });
  rows.push({
    gate: name, command: cmd, runner: g.runner, how: g.how, files: g.files, closureFiles: all.size,
    loadsChangedModules: loadsChanged, canReachChangedBranch: branchHits.length > 0, branchEvidenceFiles: branchHits,
    affected: loadsChanged.length > 0 && branchHits.length > 0,
    reason: loadsChanged.length === 0
      ? "闭包内不加载本批改动模块（" + CHANGED.join(" / ") + "）→ 不受影响"
      : (branchHits.length === 0
        ? "加载改动模块，但闭包内没有「启动超时」产生点（没有任何用例 spawn start-hang-agent / 注入极小 startTimeoutMs 的 hang 夹具）→ 改动的分支不可达，行为逐字节不变"
        : "加载改动模块且闭包内含启动超时产生点 → 必须重跑"),
  });
}

const affected = rows.filter((r) => r.affected).map((r) => r.gate);
const out = {
  phase: "D5-03 第九批 · 独立验收 · 受影响性分析",
  testedHead: execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  changedFilesThisBatch: execFileSync("git", ["-C", ROOT, "show", "--stat", "--format=", "HEAD"], { encoding: "utf8" }).trim().split("\n").map((s) => s.trim()).filter(Boolean),
  method: "门禁脚本 → 真实执行文件清单 → import/require 传递闭包 → 是否加载改动模块 × 是否可达改动分支",
  changedModules: CHANGED,
  branchMarkers: BRANCH_MARKERS.map(String),
  gateCount: rows.length,
  affectedGates: affected,
  unaffectedGates: rows.filter((r) => !r.affected).map((r) => r.gate),
  rows,
  at: new Date().toISOString(),
};
fs.writeFileSync(path.join(HERE, "batch9-03-affectedness.json"), JSON.stringify(out, null, 2));
console.log("受影响门禁（必须重跑）：" + JSON.stringify(affected));
console.log("");
for (const r of rows) {
  console.log((r.affected ? "[AFFECTED ] " : "[unaffected] ") + r.gate.padEnd(26) + " files=" + String(r.files.length).padStart(2) + " closure=" + String(r.closureFiles).padStart(3) + " loadsChanged=" + JSON.stringify(r.loadsChangedModules) + " branch=" + r.canReachChangedBranch);
  if (r.branchEvidenceFiles.length) console.log("             分支证据文件：" + r.branchEvidenceFiles.slice(0, 6).join(", "));
}
