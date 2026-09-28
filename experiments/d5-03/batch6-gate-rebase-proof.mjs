/**
 * D5-03 第六批 · 门禁脚本重基线**先红后绿**反证（假阳性 1 与假阳性 2）。
 *
 * 修正对象：experiments/d5-03/auth-error-visual.mjs 的 V7b。
 *   假阳性 ① 规则体用行号硬切 split("\n").slice(2464, 2472)：第六批把 .auth-error 从 2465 挪到
 *              2471-2478，切片只剩注释 + margin-top（6 条声明里只看得到 1 条）→ 断言恒真。
 *   假阳性 ② 判据 !cssChanged（本批 diff 不含 .css）：本批修复本身就是给 .auth-error 加不透明底，
 *              必然 FAIL —— 属 fail-closed 设计问题（与第五批 R3 同形），不是产品缺陷。
 *
 * 本脚本只做**文本级**对照：真实 src/styles.css + 真实 git diff，变异体全部在内存字符串里构造，
 * 不落盘、不改产品代码、不开 Electron、不碰数据库。所以"验完不留痕"是结构保证（收尾还会复核 git 状态）。
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
const AUDIT = require(path.join(here, "auth-error-css-audit.cjs"));

const LOG = [];
const _log = console.log.bind(console);
console.log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); LOG.push(s); _log(s); };

const gitText = (args) => { try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }).trim(); } catch { return null; } };
const gitOk = (args) => { try { execFileSync("git", ["-C", ROOT, ...args], { stdio: "ignore" }); return true; } catch { return false; } };

const BATCH_BASE = process.env.OPENARC_BATCH_BASE || "d4a3516";
const LEGACY_SLICE = { selectorLine: 2471, startLine: 2465, endLine: 2472 };
const REQUIRED_DECLS = ["margin-top", "font-size", "color", "background", "border-radius", "padding"];

/** 第五批 V7b 的"规则无动效"那一半，逐字复现（行号硬切）。 */
function legacyRuleClause(cssText) {
  const slice = AUDIT.legacyLineSlice(cssText, LEGACY_SLICE.startLine, LEGACY_SLICE.endLine);
  const d = AUDIT.declarationsOf(slice);
  return { pass: !/transition|animation/.test(slice), declarationsCovered: d.count, declarationNames: d.names, hasMotionText: /transition|animation/.test(slice), slicePreview: slice.slice(0, 120) };
}
/** 第五批 V7b 的另一半，逐字复现（!cssChanged）。 */
function legacyCssClause(fileList) { const cssChanged = AUDIT.legacyCssChanged(fileList); return { pass: !cssChanged, cssChanged }; }

/** 第六批新判据 1：规则体按选择器提取 + 完整 + 无动效（V7c 的静态部分）。 */
function newRuleClause(cssText) {
  const bodies = AUDIT.extractRuleBodies(cssText, ".auth-error");
  const body = bodies.length === 1 ? bodies[0] : "";
  const d = AUDIT.declarationsOf(body);
  return {
    pass: bodies.length === 1 && d.count >= 6 && REQUIRED_DECLS.every((n) => d.names.includes(n))
      && /background\s*:\s*rgb\(var\(--content-rgb\)\s*\/\s*1\)/.test(d.text)
      && !/(^|[;{\s])display\s*:/.test(d.text) && AUDIT.hasMotionDeclaration(body) === false,
    bodies: bodies.length, declarationsCovered: d.count, declarationNames: d.names, hasMotion: AUDIT.hasMotionDeclaration(body), opaqueBackground: /background\s*:\s*rgb\(var\(--content-rgb\)\s*\/\s*1\)/.test(d.text),
  };
}
/** 第六批新判据 2：本批新增 transition/animation 声明数 = 0（V7b 的静态部分）。 */
function newDiffClause(cssDiff) { const a = AUDIT.countAddedMotionDeclarations(cssDiff); return { pass: a.count === 0, addedMotionDeclarations: a.declarations, addedLines: a.addedLines }; }

/**
 * 在 .auth-error 规则体**末尾**追加一条声明（内存变异，不落盘）。
 * 追加点是"规则体最后一条声明之后、闭括号之前"—— 也就是真实开发里新增声明的自然落点。
 * 旧口径的行号切片只覆盖规则体最前面那几行，够不到这里。
 */
function injectDeclaration(cssText, declaration) {
  const lines = cssText.split("\n");
  const start = lines.findIndex((l) => l.trim() === ".auth-error {");
  if (start < 0) throw new Error("找不到 .auth-error 规则头");
  let end = start;
  while (end < lines.length && lines[end].trim() !== "}") end += 1;
  if (end >= lines.length) throw new Error("找不到 .auth-error 规则体的闭括号");
  lines.splice(end, 0, "  " + declaration);
  return lines.join("\n");
}

const CASES = [];
const check = (id, name, ok, expected, actual) => { const row = { id, name, status: ok ? "PASS" : "FAIL", expected, actual, at: new Date().toISOString() }; CASES.push(row); console.log((ok ? "  [PASS] " : "! [FAIL] ") + id + " · " + name + (ok ? "" : " — 期望 " + expected + "，实际 " + JSON.stringify(actual).slice(0, 500))); return ok; };

async function main() {
  const RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "batch6-gate-rebase-proof", basePort: Number(process.env.OA_D503E_PROOF_CDP_PORT || 9951), envBaseVar: "OA_D503E_PROOF_CDP_PORT", userDataPrefixBase: "oa-d503-proof-" });
  const OUTDIR = RUN.runDir;
  console.log("本次运行：" + RUN.runId + " → " + RUN.runDirRel);

  const cssPath = path.join(ROOT, "src/styles.css");
  const realCss = fs.readFileSync(cssPath, "utf8");
  const batchDiffFiles = (gitText(["diff", "--name-only", BATCH_BASE]) || "").split("\n").filter(Boolean);
  const cssDiffFiles = (gitText(["diff", "--name-only", BATCH_BASE, "--", "*.css"]) || "").split("\n").filter(Boolean);
  const cssDiff = gitText(["diff", "--unified=0", BATCH_BASE, "--", "*.css"]) || "";
  const worktreeClean = (gitText(["status", "--porcelain", "--", "src", "electron"]) || "") === "";
  const baseIsAncestor = gitOk(["merge-base", "--is-ancestor", BATCH_BASE, "HEAD"]);

  console.log("\n── 现场 ──");
  console.log("被测提交 HEAD = " + gitText(["rev-parse", "HEAD"]) + "（分支 " + gitText(["rev-parse", "--abbrev-ref", "HEAD"]) + "）");
  console.log("重基线基线 BATCH_BASE = " + BATCH_BASE + "（是 HEAD 祖先：" + baseIsAncestor + "）");
  console.log("本批改动文件（" + batchDiffFiles.length + "）：" + JSON.stringify(batchDiffFiles));
  console.log("其中 .css：" + JSON.stringify(cssDiffFiles) + "；git diff " + BATCH_BASE + " -- '*.css' 新增行数 = " + AUDIT.countAddedMotionDeclarations(cssDiff).addedLines);
  console.log("产品代码（src/、electron/）工作树是否干净：" + worktreeClean);

  /* ── 历史对照：第五批运行时那一次"行号切片恰好命中"的证据 ── */
  const old27eb = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/d5-03/runs/20260928T070627Z-27eb-auth-error-visual/auth-error-visual.json"), "utf8")); } catch { return null; } })();
  const old27ebV7b = old27eb ? (old27eb.checks || []).find((c) => c.name && c.name.startsWith("本批未新增动效的代码级证据")) : null;
  const old27ebSlice = old27ebV7b ? JSON.parse(old27ebV7b.actual).authErrorRule : null;
  console.log("\n── 历史对照（27eb 的 V7b actual.authErrorRule，即第五批那次行号切片真正取到的文本）──");
  console.log(JSON.stringify(old27ebSlice));

  /* ── 假阳性 ①：行号硬切在半空断言下会放过"规则里真加了动效" ── */
  const mutateMotion = injectDeclaration(realCss, "transition: color .16s var(--quick);");
  const mutateAnim = injectDeclaration(realCss, "animation: oa-fade-in .16s ease-out;");
  const mutateBg = injectDeclaration(realCss, "background: rgb(var(--content-rgb) / 0.5);").replace("background: rgb(var(--content-rgb) / 1);", "");
  const rows = [
    { id: "M0", label: "真实工作树 src/styles.css（未变异）", css: realCss, expectOldRule: true, expectNewRule: true, expectNewBg: true },
    { id: "M2", label: "变异：.auth-error 规则体追加 transition: color .16s var(--quick)", css: mutateMotion, expectOldRule: true, expectNewRule: false, expectNewBg: true },
    { id: "M4", label: "变异：.auth-error 规则体追加 animation: oa-fade-in .16s ease-out", css: mutateAnim, expectOldRule: true, expectNewRule: false, expectNewBg: true },
    { id: "M3", label: "变异：不透明底被改回半透明 rgb(var(--content-rgb) / 0.5)", css: mutateBg, expectOldRule: true, expectNewRule: false, expectNewBg: false },
  ];
  console.log("\n── 假阳性 ① 对照：行号硬切（旧） vs 按选择器提取（新）──");
  const matrix = [];
  for (const r of rows) {
    const oldR = legacyRuleClause(r.css);
    const newR = newRuleClause(r.css);
    matrix.push({ id: r.id, label: r.label, legacy: oldR, candidate: newR });
    console.log(r.id + " " + r.label);
    console.log("   旧：pass=" + oldR.pass + " 声明覆盖=" + oldR.declarationsCovered + "/6 " + JSON.stringify(oldR.declarationNames));
    console.log("   新：pass=" + newR.pass + " 声明覆盖=" + newR.declarationsCovered + "/6 hasMotion=" + newR.hasMotion + " opaqueBg=" + newR.opaqueBackground);
  }
  check("P1a", "旧口径（行号硬切）在真实文件上命中：" + rows[0].expectOldRule, legacyRuleClause(realCss).pass === true, "旧判据在真实文件上 PASS（但它只看得到 " + legacyRuleClause(realCss).declarationsCovered + " 条声明）", legacyRuleClause(realCss));
  check("P1b", "旧口径覆盖不全 —— 真实文件 6 条声明里只覆盖 1 条（background/border-radius/padding 都没进切片）", legacyRuleClause(realCss).declarationsCovered === 1 && legacyRuleClause(realCss).hasMotionText === false && AUDIT.declarationsOf(AUDIT.extractRuleBodies(realCss, ".auth-error")[0]).count === 6, "旧切片覆盖 1/6；选择器提取覆盖 6/6", { legacy: legacyRuleClause(realCss), candidate: newRuleClause(realCss) });
  check("P1c", "【假绿复现】变异 M2 在 .auth-error 里真加了 transition，旧口径仍然 PASS（规则体末尾的声明够不到行号切片）", legacyRuleClause(mutateMotion).pass === true && newRuleClause(mutateMotion).pass === false, "旧 PASS（假绿）/ 新 FAIL（抓住）", { legacy: legacyRuleClause(mutateMotion), candidate: newRuleClause(mutateMotion) });
  check("P1d", "【假绿复现】变异 M4 在 .auth-error 里真加了 animation，旧口径仍然 PASS", legacyRuleClause(mutateAnim).pass === true && newRuleClause(mutateAnim).pass === false, "旧 PASS（假绿）/ 新 FAIL（抓住）", { legacy: legacyRuleClause(mutateAnim), candidate: newRuleClause(mutateAnim) });
  check("P1e", "【新判据不为空】变异 M3（不透明底退回半透明）被新判据抓住，旧口径对它无感", newRuleClause(mutateBg).pass === false && legacyRuleClause(mutateBg).pass === true, "新 FAIL / 旧 PASS（旧口径本来也不查底）", { legacy: legacyRuleClause(mutateBg), candidate: newRuleClause(mutateBg) });
  check("P1f", "修正后的新判据在真实工作树上 PASS（先红后绿里的「绿」）", newRuleClause(realCss).pass === true, "选择器提取：bodies=1 / 声明 6/6 / 无动效 / 底=rgb(var(--content-rgb)/1)", newRuleClause(realCss));

  /* ── 假阳性 ②：!cssChanged 在本批必然 FAIL ── */
  console.log("\n── 假阳性 ② 对照：!cssChanged（旧） vs 新增动效声明数=0（新）──");
  const oldCssClause = legacyCssClause(batchDiffFiles);
  const newDiff = newDiffClause(cssDiff);
  console.log("旧：cssChanged=" + oldCssClause.cssChanged + " → pass=" + oldCssClause.pass);
  console.log("新：新增 transition/animation 声明=" + JSON.stringify(newDiff.addedMotionDeclarations) + " → pass=" + newDiff.pass);
  check("P2a", "【假红复现】本批 diff 含 .css（" + JSON.stringify(cssDiffFiles) + "），旧判据 !cssChanged = FAIL —— 而本批的 CSS 改动只是给 .auth-error 加不透明底，没加任何动效", oldCssClause.pass === false && newDiff.pass === true, "旧 FAIL（假红）/ 新 PASS（真绿）", { legacy: oldCssClause, candidate: newDiff, cssDiffFiles, cssDiffPreview: cssDiff.split("\n").filter((l) => l.startsWith("+")).slice(0, 12) });
  check("P2b", "本批（" + BATCH_BASE + "→工作树）新增的 transition/animation 声明数 = 0", newDiff.addedMotionDeclarations.length === 0, "0 条", newDiff);
  check("P2c", "反向自证：把一条 transition 声明喂进同一个 diff 解析器会被数出来（新判据不是恒真）", AUDIT.countAddedMotionDeclarations("+  transition: color .16s var(--quick);\n+  animation: fade .2s;").count === 2, "2 条", AUDIT.countAddedMotionDeclarations("+  transition: color .16s var(--quick);\n+  animation: fade .2s;"));

  /* ── 收尾核对 ── */
  const finalWorktreeClean = (gitText(["status", "--porcelain", "--", "src", "electron"]) || "") === "";
  check("P3", "反证全程未改产品代码（变异只在内存字符串里；src/ 与 electron/ 的 git 状态跑前跑后都干净）", worktreeClean && finalWorktreeClean, "src/ 与 electron/ 无改动", { before: worktreeClean, after: finalWorktreeClean });
  check("P3b", "反证未落任何临时变异文件（只写本次 run 目录）", true, "只写 " + RUN.runDirRel, { runDir: RUN.runDirRel });

  const failed = CASES.filter((c) => c.status === "FAIL").length;
  const out = {
    phase: "D5-03 第六批", title: "门禁脚本重基线先红后绿反证（行号硬切假绿 + !cssChanged 假红）",
    runId: RUN.runId, runDir: RUN.runDirRel, testedCommit: gitText(["rev-parse", "HEAD"]), openarcBranch: gitText(["rev-parse", "--abbrev-ref", "HEAD"]),
    batchBase: BATCH_BASE, batchBaseIsAncestor: baseIsAncestor, batchDiffFiles, cssDiffFiles,
    legacyCriterion: { ruleExtraction: 'split("\\n").slice(2464, 2472) → !/transition|animation/.test(slice)', diff: "!cssChanged（本批 diff 不含 .css）" },
    newCriterion: { ruleExtraction: "按选择器 .auth-error 提取规则体（bodies=1 / 声明完整 / 无 transition|animation / 底=rgb(var(--content-rgb) / 1)）", diff: "本批新增 transition/animation 声明数 = 0，且运行时 V7a 全绿" },
    legacySliceRange: LEGACY_SLICE, historicalV7bFrom27eb: { checks: old27ebV7b ? { status: old27ebV7b.status, actual: old27ebV7b.actual } : null, authErrorRuleText: old27ebSlice },
    mutationMatrix: matrix, checks: CASES, counts: { pass: CASES.length - failed, fail: failed, total: CASES.length },
    boundary: { electronLaunched: false, databaseTouched: false, productCodeChanged: false, filesWritten: [RUN.runDirRel], note: "只做文本级对照；变异体在内存里构造，未落盘。" },
    at: new Date().toISOString(),
  };
  const fin = await RUN.finalize({ out, exitCode: failed === 0 ? 0 : 1, logLines: LOG, cleanup: { strategy: "no-process-spawned", pkillUsed: false, targets: [], leftovers: [] } });
  console.log("\n结论：" + (failed === 0 ? "PASS" : "FAIL") + " — " + JSON.stringify(out.counts));
  console.log("产物：" + fin.artifactPath + "（sha256 " + fin.artifactSha256.slice(0, 16) + "）+ " + fin.logPath);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
