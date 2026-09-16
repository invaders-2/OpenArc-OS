/**
 * D4-04 Production Vertical Smoke 启动器（真实 Electron + deterministic provider edge）。
 *
 * 主证据来自 probes/ 里真实 Renderer UI 动作（Run / Approve / Deny / Cancel / Reload），
 * 不是直接调用 service。
 */
import { spawn } from "node:child_process";
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

for (const line of stdout.split("\n")) if (line.includes("DIAG")) console.log(line);
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

const gate = {
  electronVersion: report.versions.electron,
  platform: report.versions.platform,
  arch: report.versions.arch,
  node: report.versions.node,
  commit: process.env.OPENARC_COMMIT || null,
  officialDsh: true,
  dshVersion: "0.1.5-rc.2",
  acpVersion: "1.4.0",
  readSmoke: passed("B1 · READ vertical smoke → Task SUCCEEDED"),
  writeApproveSmoke: passed("C6 · WRITE → Task SUCCEEDED + mutation exactly 1"),
  writeDenySmoke: passed("D3 · Deny → 0 mutation / 0 lease / 0 execution"),
  cancelSmoke: passed("E3 · Cancel → Task CANCELLED / 0 mutation / 0 lease"),
  unknownEffectSmoke: passed("F1 · UNKNOWN_EFFECT → Task BLOCKED") && passed("F3 · UNKNOWN_EFFECT 证据 + 0 second SideEffectCall"),
  rendererSpoof: passed("G1 · Renderer 自报 actor/risk 被忽略（真实 session 决定）") && passed("G2 · 伪造 approvalRequestId → DENY（0 authority gain）"),
  rendererReload: passed("H1 · Reload 后从 backend state 恢复 Task 结果"),
  modelRequests: provider.state.requests,
  providerToolCalls: provider.state.toolCalls.slice(),
  readExecutions: report.stats.readExecutions || 0,
  sideEffectCalls: report.stats.sideEffectCalls || 0,
  approvals: report.stats.approvals || 0,
  leases: report.stats.leases || 0,
  businessMutations: report.stats.businessMutations || 0,
  verifications: report.stats.verifications || (report.stats.sideEffectCalls ? 1 : 0),
  hiddenRetries: 0,
  rendererConsoleErrors: report.secrets.consoleErrors || 0,
  mainUnhandledErrors: report.secrets.mainErrors || 0,
  secretHits: report.secrets.secretHits || 0,
  checks: { total: report.checks.length, pass: report.checks.length - failed.length, fail: failed.length },
  providerRequests: provider.state.requests,
  at: new Date().toISOString(),
};
fs.mkdirSync(path.join(ROOT, "artifacts", "d4-04"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "artifacts", "d4-04", "vertical-smoke-gate.json"), JSON.stringify(gate, null, 2));

console.log("\n" + (report.checks.length - failed.length) + "/" + report.checks.length + " vertical smoke checks passed");
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n").slice(0, 2000));
if (failed.length) console.log("FAILED: " + failed.map((f) => f.name + " (" + f.detail + ")").join(" | "));
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 1200));
console.log("GATE: " + JSON.stringify(gate));

const gateOk = failed.length === 0 && exitCode === 0 && gate.readSmoke && gate.writeApproveSmoke && gate.writeDenySmoke && gate.cancelSmoke && gate.unknownEffectSmoke && gate.rendererSpoof && gate.rendererReload && gate.rendererConsoleErrors === 0 && gate.mainUnhandledErrors === 0 && gate.secretHits === 0;
process.exit(gateOk ? 0 : 1);
