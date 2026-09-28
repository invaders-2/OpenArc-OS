/**
 * D5-03 第六批 · R3 登记表新增项（src/styles.css）的**负向自证**。
 *
 * 授权口径（父 Agent 明确授权 + 附条件）：把 src/styles.css 按第三/五批同形态登记进 R3_REGISTRY，
 * 并用**仓库副本**跑同一个 r3SrcDiffEvaluation 证明每一项都真的能翻成 FAIL。
 *
 * 做法：在 /tmp 下建 4 个**最小 git 仓库**（只放登记表涉及的 5 个 src 文件；base 提交里
 * src/styles.css 用 d4a3516 的旧内容，其余 4 个文件用 HEAD 内容），head 提交分别放：
 *   control  ：HEAD 真实 src/styles.css                       → 期望 PASS
 *   case-i   ：删掉 .auth-error 的不透明内容底                 → 期望 FAIL
 *   case-ii  ：把 .dark 的 --failed-rgb 改成别的值             → 期望 FAIL
 *   case-iii ：在 .auth-error 里加一条 transition              → 期望 FAIL
 * 走 mcp-policy-e2e.mjs 现成的 OA_D503_R3_SELFTEST_ROOTS 入口（不启动 Electron、不建 run 目录）。
 * 跑完立刻删掉 4 个副本，并核对 /tmp 与 /var/folders 下都不留痕。
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const RUN_ARTIFACTS = require(path.join(here, "run-artifacts.cjs"));

const LOG = [];
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG.push(s); _log(s); };
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const gitShow = (rev, file) => execFileSync("git", ["-C", ROOT, "show", rev + ":" + file], { encoding: "utf8", maxBuffer: 1 << 28 });

const FILES = ["src/mcp/McpCenter.tsx", "src/identity/types.ts", "src/identity/useIdentity.ts", "src/identity/AuthScreens.tsx", "src/styles.css", "src/design-system/tokens.css"];
const BASE_STYLES_REV = "d4a3516";

function buildRepo(dir, mutate) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "d503f@local"]);
  git(dir, ["config", "user.name", "d503f"]);
  for (const f of FILES) {
    const abs = path.join(dir, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f === "src/styles.css" ? gitShow(BASE_STYLES_REV, f) : gitShow("HEAD", f));
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const headStyles = gitShow("HEAD", "src/styles.css");
  const headTokens = gitShow("HEAD", "src/design-system/tokens.css");
  const mutated = mutate(headStyles, headTokens);
  fs.writeFileSync(path.join(dir, "src/styles.css"), mutated.content);
  if (mutated.tokens) fs.writeFileSync(path.join(dir, "src/design-system/tokens.css"), mutated.tokens);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "head"]);
  return { dir, mutation: mutated.note, baseRev: "HEAD~1", headRev: "HEAD" };
}

const CASES = [
  { key: "control", expect: "pass", note: "未改动副本（HEAD 真实 src/styles.css）", mutate: (css) => ({ content: css, note: "no-op" }) },
  { key: "case-i", expect: "fail", note: "去掉不透明内容底", mutate: (css) => {
    const out = css.replace(/\n\s*background:\s*rgb\(var\(--content-rgb\)\s*\/\s*1\);/,"");
    if (out === css) throw new Error("case-i 变异没生效：找不到不透明底那一行");
    return { content: out, note: "removed .auth-error background rgb(var(--content-rgb) / 1)" };
  } },
  { key: "case-ii", expect: "fail", note: "深色 --failed-rgb 改值（tokens.css，状态色原值被改）", mutate: (css, tokens) => {
    const out = tokens.replace("--failed-rgb: 255 69 58;", "--failed-rgb: 255 69 59;");
    if (out === tokens) throw new Error("case-ii 变异没生效：找不到深色 --failed-rgb");
    return { content: css, tokens: out, note: "dark --failed-rgb 255 69 58 -> 255 69 59 in design-system/tokens.css" };
  } },
  { key: "case-iii", expect: "fail", note: ".auth-error 里加一条 transition", mutate: (css) => {
    const out = css.replace(".auth-error {\n", ".auth-error {\n  transition: color 160ms ease;\n");
    if (out === css) throw new Error("case-iii 变异没生效：找不到 .auth-error 规则头");
    return { content: out, note: "added transition inside .auth-error" };
  } },
];

async function main() {
  RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "batch6-r3-rebase-proof", basePort: Number(process.env.OA_D503F_R3_CDP || 9931), envBaseVar: "OA_D503F_R3_CDP", userDataPrefixBase: "oa-d503f-r3-" });
  console.log("本次运行：" + RUN.runId + " → " + RUN.runDirRel);
  const tmpRoot = "/tmp/d503f-r3-selftest";
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  const built = [];
  for (const c of CASES) {
    const dir = path.join(tmpRoot, c.key);
    const b = buildRepo(dir, c.mutate);
    built.push({ ...c, ...b });
    console.log("· 建副本 " + c.key + "（" + b.mutation + "）→ " + dir);
  }
  const spec = built.map((b) => ({ root: b.dir, baseRev: b.baseRev, headRev: b.headRev, expect: b.expect, label: b.key + " · " + b.note }));
  let stdout = "", exitCode = null;
  try {
    stdout = execFileSync(process.execPath, [path.join(here, "mcp-policy-e2e.mjs")], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, OA_D503_R3_SELFTEST_ROOTS: JSON.stringify(spec) } });
    exitCode = 0;
  } catch (e) { stdout = String((e && e.stdout) || ""); exitCode = (e && typeof e.status === "number") ? e.status : 2; }
  const lines = stdout.split("\n").filter(Boolean);
  const summary = lines[lines.length - 1] || "";
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try { const j = JSON.parse(line); rows.push({ label: j.label, expect: j.expect, verdict: j.verdict, matched: j.matched, changedSrc: j.changedSrc, outsideRegistry: j.outsideRegistry, failedEntries: j.failedEntries, audit: (j.audits || [])[0] || null }); } catch { /* summary line */ }
  }
  console.log("\n── 逐例结果 ──");
  for (const r of rows) console.log((r.matched ? "[MATCHED] " : "[MISMATCH] ") + r.label + " · expect=" + r.expect + " verdict=" + r.verdict + (r.audit ? " audit=" + JSON.stringify(r.audit) : "") + (r.failedEntries && r.failedEntries.length ? " failed=" + JSON.stringify(r.failedEntries) : ""));
  console.log("harness 末行：" + summary);

  const CHECK = rows.map((r) => ({ name: r.label, expect: r.expect, verdict: r.verdict, matched: r.matched }));
  const allMatched = CHECK.length === CASES.length && CHECK.every((c) => c.matched);
  const passed = allMatched ? CHECK.length : CHECK.filter((c) => c.matched).length;
  console.log("\n结论：" + (allMatched ? "PASS" : "FAIL") + " — " + JSON.stringify({ pass: passed, fail: CHECK.length - passed, total: CHECK.length, harnessExit: exitCode }));

  /* 收尾：删副本 + 核对不留痕 */
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const residueTmp = fs.existsSync(tmpRoot);
  const residueVarfolders = (() => { try { return execFileSync("bash", ["-lc", "ls -d /var/folders/*/*/T/oa-d503f-r3-* 2>/dev/null | head"], { encoding: "utf8" }).trim(); } catch { return ""; } })();
  console.log("收尾：副本目录已删=" + (!residueTmp) + "，/var/folders 下 oa-d503f-r3-* 残留=" + JSON.stringify(residueVarfolders));

  const out = {
    phase: "D5-03 第六批", title: "R3 登记表新增项（src/styles.css）负向自证",
    runId: RUN.runId, runDir: RUN.runDirRel, testedCommit: git(ROOT, ["rev-parse", "HEAD"]), baseStylesRev: BASE_STYLES_REV,
    registryEntry: { file: "src/styles.css", batch: "d1ba058 · 第六批", addOnly: true, requireAdded: [], forbidCode: [], authErrorCssAudit: true },
    cases: built.map((b) => ({ key: b.key, expect: b.expect, note: b.note, mutation: b.mutation, dir: b.dir })),
    results: rows, checks: CHECK, counts: { pass: passed, fail: CHECK.length - passed, total: CHECK.length }, harnessExit: exitCode, harnessSummary: summary,
    residue: { tmpRemoved: !residueTmp, varfolders: residueVarfolders || null },
    boundary: { productCodeChanged: false, electronLaunched: false, databaseTouched: false, note: "只读真实仓库的 blob + 在 /tmp 建最小副本；跑完删除；不启动 Electron。" },
    at: new Date().toISOString(),
  };
  const fin = await RUN.finalize({ out, exitCode: allMatched ? 0 : 1, logLines: LOG, cleanup: { strategy: "no-process-spawned", pkillUsed: false, targets: [], leftovers: [] } });
  console.log("产物：" + fin.artifactPath + "（sha256 " + fin.artifactSha256.slice(0, 16) + "）");
  return allMatched ? 0 : 1;
}
let RUN = null;
process.exit(await main().catch((e) => { console.error("自证异常：" + String((e && e.stack) || e)); return 2; }));
