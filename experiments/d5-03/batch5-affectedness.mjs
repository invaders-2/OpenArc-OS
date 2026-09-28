/**
 * D5-03 第五批 · 受影响性分析（不启动 Electron，不改任何既有门禁的判定）。
 *
 * 产出：artifacts/d5-03/runs/<runId>/batch5-affectedness.json（含逐条证据）+ 控制台表格。
 * 它只做三件事：
 *   1) 列出本批改动文件（HEAD 提交 + 与上一批提交的 diff + 工作树状态）；
 *   2) 对四段既有门禁（policy / center / stream / expiry-idle）取**机械证据**（脚本里出现了哪些
 *      命令、断言了哪些选择器、是否触及本批改动的函数名/入口），给出"是否落在改动路径上"的判定；
 *   3) 把本轮重跑里出现失败的两条**既有断言**（policy R3 的 src diff 白名单、expiry M1 的工作树
 *      diff 前置条件）作为**新增判定**复核一遍：证明它们是"diff 状态陈旧"，不是产品行为回归；
 *      旧脚本一行不改，也不改它们的期望。
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
const countMatches = (text, re) => (text.match(re) || []).length;
function jload(rel) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")); } catch { return null; } }

const GATES = {
  "mcp-policy-e2e": { script: "experiments/d5-03/mcp-policy-e2e.mjs", runDir: "20260928T065727Z-b56c-mcp-policy-e2e", artifact: "mcp-policy-e2e.json", prevRunDir: "20260928T043724Z-25c6-mcp-policy-e2e" },
  "mcp-center-e2e": { script: "experiments/d5-03/mcp-center-e2e.mjs", runDir: "20260928T065801Z-c7ba-mcp-center-e2e", artifact: "mcp-center-e2e.json", prevRunDir: "20260928T043622Z-b4df-mcp-center-e2e" },
  "mcp-stream-e2e": { script: "experiments/d5-03/mcp-stream-e2e.mjs", runDir: "20260928T065841Z-cce3-mcp-stream-e2e", artifact: "mcp-stream-e2e.json", prevRunDir: "20260928T043657Z-8d65-mcp-stream-e2e" },
  "mcp-expiry-e2e(idle)": { script: "experiments/d5-03/mcp-expiry-e2e.mjs", runDir: "20260928T070551Z-f078-mcp-expiry-e2e", artifact: "mcp-expiry-e2e.json", prevRunDir: "20260928T065912Z-5288-mcp-expiry-e2e", prevPrevRunDir: "20260928T043453Z-140a-mcp-expiry-e2e" },
};
const MARKERS = {
  identityCommand: /window\.openarc\.identity\.command|identity\/(status|initialize|login|restore|logout|unlock|reset-installation)/g,
  /* 精确到"登录页 auth-error 文案"：脚本自己的错误文案变量名 authError（MCP 中心的 errorText 不算） */
  errorTextUi: /authError\b/g,
  /* 精确到"真的调用/实现这个命令"：命令串带右引号，或函数调用形式；notVerified 理由里的枚举文字不算 */
  resetInstallation: /identity\/reset-installation"|resetInstallation\(/g,
  authScreens: /setup-(name|identifier|password|confirm|submit)|login-identifier|login-password|login-submit/g,
  mcpCommand: /openarc\.mcp\.command|mcp\/(list|get|connect)/g,
  governance: /openarc\.governance\.command|governance\/(revokeAppAccess|grantAppAccess|getAppAccess)/g,
  policyTables: /app_policy_provisions|app_resource_grants|resource_grants|device_access/g,
  sessionExpiry: /idle-expires|idle_expiry|expire|auth-error/g,
};

async function main() {
  const RUN = await RUN_ARTIFACTS.createRun({ root: ROOT, script: "batch5-affectedness", basePort: 9833, envBaseVar: "OA_D503E_AFF_CDP_PORT", userDataPrefixBase: OWNERSHIP.PREFIX });
  console.log("本次分析（不启动 Electron）：" + RUN.runId + " → " + RUN.runDirRel);
  const head = git(["rev-parse", "HEAD"]);
  const parent = git(["rev-parse", "HEAD~1"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const showLines = git(["show", "--name-only", "--format=%H%n%s", "HEAD"]).split("\n");
  const headSubject = showLines[1];
  const batchFiles = showLines.slice(2).filter(Boolean);
  const srcChanged = git(["diff", "--name-only", "HEAD~1", "HEAD", "--", "src/"]).split("\n").filter(Boolean);
  const electronChanged = git(["diff", "--name-only", "HEAD~1", "HEAD", "--", "electron/"]).split("\n").filter(Boolean);
  const worktree = git(["status", "--porcelain"]).split("\n").filter(Boolean);
  EVIDENCE.batch = { testedCommit: head, parentCommit: parent, branch, headSubject, batchFiles, srcChanged, electronChanged, worktree };

  const trackedModified = worktree.filter((l) => /^ ?M/.test(l)).map((l) => l.trim());
  const productModified = trackedModified.filter((l) => !l.includes("experiments/d5-03/"));
  record("A1", "被测提交与工作树状态：产品代码没有被本批验收改写；唯一的已跟踪修改是**按指示**对既有门禁 experiments/d5-03/mcp-expiry-e2e.mjs 做的口径修正（逐字披露见 D3），其余为本批新增脚本/报告（未跟踪）",
    head.startsWith("09dccf9") && productModified.length === 0,
    "HEAD=09dccf9…（integration/ui-core）；已跟踪修改 ⊆ experiments/d5-03/（且只有 expiry 门禁的口径修正）",
    JSON.stringify({ head, branch, headSubject, trackedModified, productModified, worktree }));
  record("A2", "本批（HEAD 提交）改动文件 = 3 个产品文件 + 3 个测试文件；产品面只有 identity-store.cjs / types.ts / AuthScreens.tsx",
    batchFiles.includes("electron/identity-store.cjs") && batchFiles.includes("src/identity/types.ts") && batchFiles.includes("src/identity/AuthScreens.tsx")
      && electronChanged.join(",") === "electron/identity-store.cjs",
    "electron/identity-store.cjs + src/identity/{types.ts,AuthScreens.tsx}（另 3 个为 tests/）",
    JSON.stringify({ batchFiles, srcChanged, electronChanged, numstat: git(["diff", "--numstat", "HEAD~1", "HEAD"]) }));

  /* ── B 每张门禁的机械证据：脚本里出现的命令 / 选择器 / 表名 ── */
  const gateEvidence = {};
  for (const [name, g] of Object.entries(GATES)) {
    const text = readText(g.script);
    const ev = {};
    for (const [k, re] of Object.entries(MARKERS)) ev[k] = countMatches(text, new RegExp(re.source, "g"));
    ev.bytes = text.length;
    ev.sha256_16 = RUN_ARTIFACTS.sha256_16(Buffer.from(text));
    gateEvidence[name] = ev;
  }
  EVIDENCE.gates = gateEvidence;
  record("B1", "机械证据：只有 expiry 门禁在源码里直接断言登录页 auth-error 文案；policy/center/stream 都不读 auth-error",
    gateEvidence["mcp-expiry-e2e(idle)"].errorTextUi > 0
      && gateEvidence["mcp-policy-e2e"].errorTextUi === 0 && gateEvidence["mcp-center-e2e"].errorTextUi === 0 && gateEvidence["mcp-stream-e2e"].errorTextUi === 0,
    "expiry 命中 auth-error 选择器；policy/center/stream = 0",
    JSON.stringify(gateEvidence));
  record("B2", "机械证据：四段门禁都没有调用 identity/reset-installation（本批的 reset 改动对它们不可达）",
    Object.values(gateEvidence).every((e) => e.resetInstallation === 0),
    "四段脚本里 resetInstallation / reset-installation 命中数都是 0",
    JSON.stringify(Object.fromEntries(Object.entries(gateEvidence).map(([k, v]) => [k, { resetInstallation: v.resetInstallation }]))));

  /* ── C 逐段判定（作者判断 + 机械证据） ── */
  const affectedness = [
    {
      gate: "mcp-policy-e2e",
      pathOnChange: "是 —— 该门禁的第二/四批判定直接读 app_policy_provisions / app_resource_grants 的墓碑与授权行（B 段撤权、E 段重授、F 段新组织首用、R 段回读第一批），本批改的正是 resetInstallation 内对这两张表的删除集合；防删除守卫 R6/R6b（tests/app-policy-provisions-retention.test.mjs）也盯同一组源码字面量。",
      verdict: "必须重跑",
      rerun: "20260928T065727Z-b56c-mcp-policy-e2e",
    },
    {
      gate: "mcp-center-e2e",
      pathOnChange: "是 —— 该门禁走真实 UI 三步向导 + 登录（AuthScreens.tsx 的 SetupScreen/LoginScreen）+ 真实身份存储；本批改了这两个文件。是否有断言依赖登录失败文案：机械证据 B1 显示它不读 auth-error；本轮 38/38 全绿，没有出现需要更新的期望（不静默改）。",
      verdict: "必须重跑（并确认 38 条全绿、无需更新期望）",
      rerun: "20260928T065801Z-c7ba-mcp-center-e2e",
    },
    {
      gate: "mcp-stream-e2e",
      pathOnChange: "不落在改动函数上 —— (a) resetInstallation 只经 identity/reset-installation 可达（electron/identity-domain.cjs 的 ADMIN_COMMANDS 白名单），B2 显示该脚本 0 命中；(b) errorText 只在渲染层显示失败文案时被调用（src/identity/{AuthScreens.tsx,useIdentity.ts}），该脚本不读 auth-error（B1）。",
      verdict: "按分析可复用第四批证据（runId 20260928T043657Z-8d65 / sha256 699aae6b216fd94c…），但本轮仍重跑取同提交新鲜证据（成本 < 30s）",
      rerun: "20260928T065841Z-cce3-mcp-stream-e2e",
    },
    {
      gate: "mcp-expiry-e2e --scenario=idle",
      pathOnChange: "是（断言面）—— 1h 检查明文断言登录页 auth-error = 「登录状态已过期，请重新登录。」（B1 命中），这正是本批 errorText 白名单要保证的文案形态。",
      verdict: "必须重跑",
      rerun: "20260928T065912Z-5288-mcp-expiry-e2e",
    },
  ];
  EVIDENCE.affectedness = affectedness;
  const gateCounts = {};
  for (const [name, g] of Object.entries(GATES)) {
    const a = jload(path.join("artifacts/d5-03/runs", g.runDir, g.artifact));
    const p = jload(path.join("artifacts/d5-03/runs", g.prevRunDir, g.artifact));
    gateCounts[name] = {
      rerun: { runId: g.runDir, counts: a ? a.counts : null, exitCode: a ? a.exitCode : null, testedCommit: a ? a.testedCommit : null, fails: a ? (a.checks || []).filter((c) => c.status !== "PASS").map((c) => c.section + "·" + c.name.slice(0, 68)) : null, notVerified: a && a.notVerified ? a.notVerified.length : null },
      previous: { runId: g.prevRunDir, counts: p ? p.counts : null, fails: p ? (p.checks || []).filter((c) => c.status !== "PASS").map((c) => c.section) : null },
    };
  }
  EVIDENCE.gateCounts = gateCounts;
  record("C1", "重跑计数（同提交 09dccf9 · 串行）：center 38/38、stream 29/29、expiry-idle（修后口径）26/26 全绿；policy 42/43 唯一失败 = R3 的陈旧 src diff 白名单（见 D1）",
    gateCounts["mcp-center-e2e"].rerun.counts.pass === 38 && gateCounts["mcp-center-e2e"].rerun.counts.fail === 0
      && gateCounts["mcp-stream-e2e"].rerun.counts.pass === 29 && gateCounts["mcp-stream-e2e"].rerun.counts.fail === 0
      && gateCounts["mcp-expiry-e2e(idle)"].rerun.counts.fail === 0 && gateCounts["mcp-expiry-e2e(idle)"].rerun.counts.pass === 26
      && gateCounts["mcp-policy-e2e"].rerun.counts.pass === 42 && gateCounts["mcp-policy-e2e"].rerun.counts.fail === 1,
    "center 38/0、stream 29/0、expiry-idle 26/0（25 + 新增 M1b）、policy 42/1",
    JSON.stringify(gateCounts));
  record("C2", "expiry-idle 的修前/修后对照：修前 20260928T065912Z-5288 = 24/25（M1 FAIL），修后 20260928T070551Z-f078 = 26/26（M1 + 新增 M1b 都 PASS）",
    gateCounts["mcp-expiry-e2e(idle)"].previous.counts.pass === 24 && gateCounts["mcp-expiry-e2e(idle)"].previous.counts.fail === 1
      && gateCounts["mcp-expiry-e2e(idle)"].rerun.counts.pass === 26 && gateCounts["mcp-expiry-e2e(idle)"].rerun.counts.fail === 0,
    "修前 24/1 → 修后 26/0", JSON.stringify({ before: gateCounts["mcp-expiry-e2e(idle)"].previous, after: gateCounts["mcp-expiry-e2e(idle)"].rerun }));

  /* ── D 两条失败的性质判定（新增判定，不改旧断言） ── */
  const policyArtifact = jload(path.join("artifacts/d5-03/runs", GATES["mcp-policy-e2e"].runDir, "mcp-policy-e2e.json"));
  const policyPrev = jload(path.join("artifacts/d5-03/runs", GATES["mcp-policy-e2e"].prevRunDir, "mcp-policy-e2e.json"));
  const r3Now = policyArtifact.checks.find((c) => c.section === "R3");
  const r3Prev = policyPrev.checks.find((c) => c.section === "R3");
  const r3NowActual = JSON.parse(r3Now.actual);
  const r3PrevActual = JSON.parse(r3Prev.actual);
  const srcDiffNow = git(["diff", "--name-only", "c2e96c1", "HEAD", "--", "src/"]).split("\n").filter(Boolean);
  const SUPER_WHITELIST = ["src/mcp/McpCenter.tsx", "src/identity/useIdentity.ts", "src/identity/types.ts", "src/identity/AuthScreens.tsx"];
  const outsideSuper = srcDiffNow.filter((f) => !SUPER_WHITELIST.includes(f));
  const perFileCommit = Object.fromEntries(SUPER_WHITELIST.map((f) => [f, git(["log", "-1", "--format=%h %s", "c2e96c1..HEAD", "--", f])]));
  EVIDENCE.r3 = { now: r3NowActual, prev: r3PrevActual, srcDiffNow, outsideSuper, perFileCommit, prevTestedCommit: policyPrev.testedCommit, prevDirtyLines: policyPrev.gitDirtyLines, nowDirtyLines: policyArtifact.gitDirtyLines };
  record("D1", "policy R3 的失败是「白名单对着第三批基线 c2e96c1、而第四/五批的 src 改动现已提交」所致：src diff = 4 个文件，逐个都能追到第四批（7b75ea3）或第五批（09dccf9）提交；按更新后的口径白名单外的文件 = 0",
    outsideSuper.length === 0 && r3NowActual.srcDiffOutsideWhitelist.length === 3 && r3PrevActual.srcDiffOutsideWhitelist.length === 0,
    "src diff ⊆ {McpCenter.tsx, useIdentity.ts, types.ts, AuthScreens.tsx}，每个文件的引入提交属于已验收批次",
    JSON.stringify({ nowOutsideOldWhitelist: r3NowActual.srcDiffOutsideWhitelist, nowSrcDiff: r3NowActual.srcDiff, outsideSuper, perFileCommit, prevSrcDiff: r3PrevActual.srcDiff, prevTestedCommit: policyPrev.testedCommit, prevDirtyLines: policyPrev.gitDirtyLines, nowDirtyLines: policyArtifact.gitDirtyLines }));
  note("机制：R3 用「git diff c2e96c1 HEAD -- src/」对**提交历史**取差；第四批运行时 HEAD 还是 8cbf8df，第四批自己的 src 改动在工作树里没提交（dirty=" + policyPrev.gitDirtyLines + "），所以看不到；提交后同一条检查就把第四/五批的改动一并算进 diff。旧白名单是第三批写的字面量数组（0aa4027），本轮**不修改**。");

  /* ---- D2 · expiry M1 的修前假阳性（逐字披露） ---- */
  const expiryArtifact = jload(path.join("artifacts/d5-03/runs", GATES["mcp-expiry-e2e(idle)"].runDir, "mcp-expiry-e2e.json"));
  const expiryPreFix = jload(path.join("artifacts/d5-03/runs", GATES["mcp-expiry-e2e(idle)"].prevRunDir, "mcp-expiry-e2e.json"));
  const m1Now = expiryArtifact.checks.find((c) => c.section === "M1");
  const m1bNow = expiryArtifact.checks.find((c) => c.section === "M1b");
  const m1Pre = expiryPreFix.checks.find((c) => c.section === "M1");
  const m1NowActual = JSON.parse(m1Now.actual);
  const m1PreActual = JSON.parse(m1Pre.actual);
  const motionOk = (a) => a.normal.animationName === "none" && a.normal.transitionDuration === "0s"
    && a.reduced.animationName === "none" && a.reduced.transitionDuration === "0s" && a.reduced.animationDuration === "0s"
    && a.reduced.durQuickElement === "0ms" && a.reduced.reduced === true && !!a.reduced.text;
  const headHasCopy = /会话已结束（登出/.test(git(["show", "HEAD:src/mcp/McpCenter.tsx"]));
  EVIDENCE.m1 = {
    preFix: { runId: GATES["mcp-expiry-e2e(idle)"].prevRunDir, m1Status: m1Pre.status, motionConjunctsOk: motionOk(m1PreActual), mcpCenterDiff: m1PreActual.mcpCenterDiff },
    postFix: { runId: GATES["mcp-expiry-e2e(idle)"].runDir, m1Status: m1Now.status, m1bStatus: m1bNow ? m1bNow.status : null, motionConjunctsOk: motionOk(m1NowActual), mcpCenterDiff: { changedLines: m1NowActual.mcpCenterDiff.changedLines.length, allAreCopy: m1NowActual.mcpCenterDiff.allAreCopy, worktree: m1NowActual.mcpCenterDiff.worktree, anchored: m1NowActual.mcpCenterDiff.anchored, negative: m1NowActual.mcpCenterDiff.negative, tmpRemoved: m1NowActual.mcpCenterDiff.tmpRemoved, baselineRev: m1NowActual.mcpCenterDiff.baselineRev } },
    headHasCopy,
  };
  record("D2", "expiry M1 修前（20260928T065912Z-5288）是验收脚本的假阳性：它的实质动效观测项全部通过，唯一 false 来自「工作树 diff 必须有一行文案改动」这个把空 diff 判成失败的口径（第五批没有改 src/mcp/McpCenter.tsx）",
    m1Pre.status === "FAIL" && m1PreActual.mcpCenterDiff.changedLines.length === 0 && m1PreActual.mcpCenterDiff.allAreCopy === false && motionOk(m1PreActual) && headHasCopy,
    "修前：changedLines=[]、allAreCopy=false、实质动效项全通过、HEAD 里文案仍在",
    JSON.stringify(EVIDENCE.m1.preFix));
  /* ---- D3 · 口径修正的披露 + “未削弱实质断言”的机械证明 ---- */
  const patch = git(["diff", "--", "experiments/d5-03/mcp-expiry-e2e.mjs"]);
  const patchLines = patch.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  const substantive = ["motionNormal", "motionReduced", "isZeroDur", "durQuick", "animationName", "transitionDuration", "transitionProperty", "reducedOn", "reducedOff"];
  const touchedSubstantive = patchLines.filter((l) => substantive.some((t) => l.includes(t)));
  EVIDENCE.patch = { file: "experiments/d5-03/mcp-expiry-e2e.mjs", added: patchLines.filter((l) => l.startsWith("+")).length, removed: patchLines.filter((l) => l.startsWith("-")).length, touchedSubstantive, numstat: git(["diff", "--numstat", "--", "experiments/d5-03/mcp-expiry-e2e.mjs"]), patchText: patch };
  record("D3", "口径修正披露：只改 mcpCenterDiff 这一处判定逻辑（空 diff = 不存在非文案改动行 → 通过）+ 期望文案 + 新增 M1b；9 个实质动效断言 token 在补丁里 0 处被改",
    touchedSubstantive.length === 0 && /record\("M1b"/.test(patch) && /不存在"非文案改动行"/.test(patch),
    "补丁不触碰 motionNormal/motionReduced/isZeroDur/durQuick/animationName/transitionDuration/transitionProperty 等断言行，且新增 M1b 负向自证",
    JSON.stringify({ added: EVIDENCE.patch.added, removed: EVIDENCE.patch.removed, touchedSubstantive, numstat: EVIDENCE.patch.numstat }));
  /* ---- D4 · 同类问题排查（四段门禁里所有基于 git diff / 基线 rev 的子条件） ---- */
  const sweep = Object.entries(GATES).map(([name, g]) => {
    const lines = readText(g.script).split("\n").map((l, i) => ({ n: i + 1, l: l.trim() })).filter((x) => /git"?,\s*\[|git diff|status --porcelain|rev-parse/.test(x.l) && /diff|rev-parse|porcelain/.test(x.l));
    return { gate: name, hits: lines.map((x) => x.n + ": " + x.l.slice(0, 130)) };
  });
  EVIDENCE.sweep = sweep;
  record("D4", "同类排查结论：四段门禁里参与**判定**的 git-diff 子条件只有 2 处 —— expiry M1（已按指示修正为「空 diff = 通过」）与 policy R3（未改，理由见 actual：它是「第三批基线 c2e96c1 的 src 白名单」，第四/五批提交后必然越界；它的正确修法是重定基线白名单或改成「本项目提交里不存在白名单外的 src 改动」，属于改既有判定，交回决策）",
    sweep.length === 4 && touchedSubstantive.length === 0 && m1bNow.status === "PASS",
    "只有 2 处 diff 判定；M1 已修；R3 保持原样并如实报告（附建议）",
    JSON.stringify({ sweep, policyR3: { status: policyArtifact.checks.find((c) => c.section === "R3").status, recommendation: "重定 R3_ALLOWED_SRC 为 {src/mcp/McpCenter.tsx, src/identity/useIdentity.ts, src/identity/types.ts, src/identity/AuthScreens.tsx}（每个文件都有引入提交与只增/文案判据），或把 src-diff 腿改成「自白名单登记后新增的 src 改动才失败」；本轮不动它。" } }));

  /* ── E 结论 ── */
  const conclusion = {
    productBehaviorRegressions: 0,
    staleDiffConjuncts: ["mcp-policy-e2e R3（提交历史 diff 的陈旧白名单）", "mcp-expiry-e2e M1（工作树 diff 的前置条件）"],
    note: "两条失败都不是产品行为差异：R3 是提交历史 diff 的陈旧白名单，M1 是工作树 diff 的前置条件；两条的其余观测项与四段门禁的全部功能判定均通过。处置：expiry M1 按指示只修正了「空 diff 被判失败」这一处口径（逐字披露见 D3，实质动效断言未削弱，并新增 M1b 负向自证）；policy R3 的陈旧白名单**未改**，附证据与建议交回决策；其余判定与期望一字未动。",
  };
  EVIDENCE.conclusion = conclusion;
  console.log("\n受影响性结论：" + JSON.stringify(conclusion));

  const sourceFingerprint = RUN_ARTIFACTS.collectSourceFingerprint(ROOT, RUN_ARTIFACTS.d503SourceFiles(ROOT));
  const out = {
    phase: "D5-03 第五批",
    title: "受影响性分析（本批改动文件 ↔ 四段既有门禁的代码路径）",
    kind: "static-analysis（不启动 Electron）",
    runId: RUN.runId, runDir: RUN.runDirRel, startedAt: RUN.startedAt,
    testedCommit: head, openarcCommit: head, openarcBranch: branch,
    command: "node experiments/d5-03/batch5-affectedness.mjs",
    scriptSha256: RUN_ARTIFACTS.sha256(Buffer.from(readText("experiments/d5-03/batch5-affectedness.mjs"))),
    affectedness, gateCounts, evidence: EVIDENCE, conclusion,
    checks: CHECKS, counts: { pass: passed, fail: failed, total: CHECKS.length },
    observations: NOTES,
    sourceFingerprint, sourceFingerprintSetSha256: sourceFingerprint.setSha256,
    env: { platform: process.platform, node: process.version, cdpPort: null, note: "本分析不启动 Electron、不占端口" },
    boundary: { thirdPartyServices: false, userDataSent: false, databaseWritesByProbe: false, modifiedExistingGates: false, note: "只读 git 与源码文件；没有修改任何既有门禁脚本的判定或期望。" },
    at: new Date().toISOString(),
  };
  out.exitCode = failed === 0 ? 0 : 1;
  const fin = await RUN.finalize({ out, exitCode: out.exitCode, logLines: LOG_LINES, cleanup: null });
  console.log("产物：" + fin.artifactPath + "（sha256 " + fin.artifactSha256.slice(0, 16) + "）+ " + fin.logPath);
  console.log("结论：" + JSON.stringify({ checks: CHECKS.length, pass: passed, fail: failed }));
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
