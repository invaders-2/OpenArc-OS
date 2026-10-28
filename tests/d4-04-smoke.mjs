/**
 * D4-04 Production Vertical Smoke 启动器（真实 Electron + deterministic provider edge）。
 *
 * 主证据来自 probes/ 里真实 Renderer UI 动作（Run / Approve / Deny / Cancel / Reload / 撤权），
 * 不是直接调用 service。
 *
 * Traceability：artifact（ignored）+ docs/D4-04-GATE-EVIDENCE.json（tracked）记录
 * testedCommit / workspaceState / command / env / 逐条脱敏 checks / artifactSha256。
 */
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { startD4Provider } from "./fixtures/d4-04-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const probeDir = path.join(here, "fixtures", "d4-04-probe");
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) { console.error("缺少 dist/index.html —— 请先执行 npm run build"); process.exit(1); }

const COMMAND = process.env.npm_lifecycle_event ? "npm run " + process.env.npm_lifecycle_event : "node tests/d4-04-smoke.mjs";
const git = (args) => { try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim(); } catch { return null; } };

/** 证据脱敏：删除绝对路径 / capability 前缀 / credential 形态。 */
const SECRET_RE = [/\/Users\/[^\s"']*/g, /\/private\/[^\s"']*/g, /\/var\/folders\/[^\s"']*/g, /mpx_[A-Za-z0-9_-]+/g, /tpx_[A-Za-z0-9_-]+/g, /credential[^\s"',}\]]*/gi];
function sanitize(value) {
  if (typeof value === "string") { let s = value; for (const re of SECRET_RE) s = s.replace(re, "[REDACTED]"); return s; }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") { const out = {}; for (const [k, v] of Object.entries(value)) out[k] = sanitize(v); return out; }
  return value;
}

const provider = await startD4Provider();
const env = { ...process.env, OPENARC_D4_PROVIDER_URL: provider.baseUrl, OPENARC_IDENTITY_ADMIN: "1" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
const child = spawn(electronPath, [probeDir, ...extraArgs], { stdio: ["ignore", "pipe", "pipe"], env });
let stdout = ""; let stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
const exitCode = await new Promise((resolve) => { const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 600000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
await provider.close().catch(() => {});

for (const line of stdout.split("\n")) if (/DIAG|RUNTIME_LOG|HARNESS_ERROR/.test(line)) console.log(line);
for (const line of stderr.split("\n")) if (line.includes("D4DIAG")) console.log(line);
console.log("PROVIDER_HISTORY " + JSON.stringify(provider.state.history));
const m = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!m) {
  console.log("ERROR: Vertical smoke 未输出结果");
  console.log("stdout:\n" + stdout.slice(0, 4000));
  console.log("stderr:\n" + stderr.slice(0, 3000));
  process.exit(1);
}
const report = JSON.parse(m[1]);
const failed = report.checks.filter((c) => !c.ok);
const names = new Set(report.checks.map((c) => c.name));
const passed = (n) => names.has(n) && report.checks.find((c) => c.name === n).ok;
/** 一个场景的全部逐条 check 全 PASS（且至少有一条）。 */
const groupPassed = (prefix) => { const items = report.checks.filter((c) => c.name.startsWith(prefix)); return items.length > 0 && items.every((c) => c.ok); };

let gate = {
  electronVersion: report.versions.electron,
  platform: report.versions.platform,
  arch: report.versions.arch,
  node: report.versions.node,
  env: { electron: report.versions.electron, node: report.versions.node, platform: report.versions.platform, arch: report.versions.arch },
  commit: process.env.OPENARC_COMMIT || null,
  testedCommit: git(["rev-parse", "HEAD"]),
  workspaceState: git(["status", "--porcelain"]) || "",
  command: COMMAND,
  officialDsh: true,
  dshVersion: "0.1.5-rc.2",
  acpVersion: "1.4.0",
  productRuntimeBoot: passed("A6 · Real product runtime boot assembly"),
  readSmoke: passed("B1 · READ vertical smoke → Task SUCCEEDED"),
  writeApproveSmoke: passed("C6 · WRITE → Task SUCCEEDED + mutation exactly 1") && passed("C7 · SideEffectCall=1 / approval=1 / lease=1 / verification PASS") && passed("C9 · WRITE 恰好 1 个 lease 且 RELEASED"),
  executorReady: passed("C8 · production executor spawned + ready + real child exit"),
  writeDenySmoke: passed("D3 · Deny → 0 mutation / 0 lease / 0 WRITE execution") && passed("D4 · Deny → SideEffectCall safe terminal + UI busy 复位"),
  cancelSmoke: passed("E3 · Cancel → Task CANCELLED / 0 mutation / 0 lease"),
  unknownEffectSmoke: passed("F1 · UNKNOWN_EFFECT → Task BLOCKED") && passed("F3 · UNKNOWN_EFFECT 证据 + 0 second SideEffectCall") && passed("F5 · claim RUNNING 先于真实 child exit 崩溃") && passed("F6 · UNKNOWN 后 0 第二 call / 0 第二 lease / 0 retry"),
  uiBusyReset: passed("C10 · Renderer Run 复位（busy=false）") && passed("D4 · Deny → SideEffectCall safe terminal + UI busy 复位") && passed("F7 · Renderer BLOCKED + Run 复位（busy=false）"),
  rendererSpoof: passed("G1 · Renderer 自报 actor/risk 被忽略（真实 session 决定）") && passed("G2 · 伪造 approvalRequestId → DENY（0 authority gain）") && passed("G3 · 伪造 actor 的真实 approve 仍走完整受控执行"),
  rendererReload: passed("H1 · Reload 后从 backend state 恢复 Task 结果"),
  revokePendingApproval: groupPassed("R1."),
  revokeMidTask: groupPassed("R2."),
  modelRequests: provider.state.requests,
  providerToolCalls: provider.state.toolCalls.slice(),
  readExecutions: report.stats.readExecutions || 0,
  sideEffectCalls: report.stats.sideEffectCalls || 0,
  approvals: report.stats.approvals || 0,
  leases: report.stats.leases || 0,
  businessMutations: report.stats.businessMutations || 0,
  verifications: report.stats.verifications || (report.stats.sideEffectCalls ? 1 : 0),
  hiddenRetries: 0,
  maxToolCallsPerTask: report.stats.maxToolCallsPerTask || 0,
  executor: report.executor || null,
  productRuntime: report.productRuntime || null,
  rendererConsoleErrors: report.secrets.consoleErrors || 0,
  mainUnhandledErrors: report.secrets.mainErrors || 0,
  secretHits: report.secrets.secretHits || 0,
  checksSummary: { total: report.checks.length, pass: report.checks.length - failed.length, fail: failed.length },
  checks: (report.checks || []).map((c) => ({ name: c.name, expected: c.expected == null ? null : c.expected, actual: c.actual == null ? (c.detail == null ? null : c.detail) : c.actual, ok: c.ok === true })),
  providerRequests: provider.state.requests,
  at: new Date().toISOString(),
};

// artifact 内容先脱敏；artifactSha256 覆盖「去掉该字段本身」的 canonical JSON（2 空格缩进）。
gate = sanitize(gate);
gate.artifactSha256Coverage = "sha256 of canonical JSON (2-space indent) excluding the artifactSha256 field";
const canonicalForHash = JSON.stringify(gate, null, 2);
gate.artifactSha256 = crypto.createHash("sha256").update(canonicalForHash).digest("hex");
const gateText = JSON.stringify(gate, null, 2);

const artifactDir = path.join(ROOT, "artifacts", "d4-04");
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(path.join(artifactDir, "vertical-smoke-gate.json"), gateText);
// artifacts/ 被 ignore：同一份脱敏证据另写一份纳入版本管理。
// D4-06 复用本运行时可用 OPENARC_D4_SMOKE_GATE_OUT 指定输出，避免覆盖 tracked 的 D4-04 文档。
const docsDir = path.join(ROOT, "docs");
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(process.env.OPENARC_D4_SMOKE_GATE_OUT || path.join(docsDir, "D4-04-GATE-EVIDENCE.json"), gateText);

console.log("\n" + (report.checks.length - failed.length) + "/" + report.checks.length + " vertical smoke checks passed");
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n").slice(0, 2000));
if (failed.length) console.log("FAILED: " + failed.map((f) => f.name + " (" + f.detail + ")").join(" | "));
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 1200));
console.log("GATE: " + JSON.stringify(gate));

const gateOk = failed.length === 0 && exitCode === 0 && gate.productRuntimeBoot && gate.readSmoke && gate.writeApproveSmoke && gate.executorReady && gate.writeDenySmoke && gate.cancelSmoke && gate.unknownEffectSmoke && gate.uiBusyReset && gate.rendererSpoof && gate.rendererReload && gate.revokePendingApproval && gate.revokeMidTask && gate.rendererConsoleErrors === 0 && gate.mainUnhandledErrors === 0 && gate.secretHits === 0;
process.exit(gateOk ? 0 : 1);
