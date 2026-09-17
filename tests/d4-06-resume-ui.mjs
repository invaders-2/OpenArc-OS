/**
 * D4-06 Closure · UI 续接 Gate 启动器（真实 Electron + deterministic provider + 真实产品链路）。
 *
 * 主证据来自真实 Renderer UI 动作（Reload / 点击 data-ai-resume），不是直接调用 service。
 * 输出 artifacts/d4-06-resume/resume-ui-gate.json（ignored）；不覆盖 docs/*。
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
const probeDir = path.join(here, "fixtures", "d4-06-resume-probe");

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) { console.error("缺少 dist/index.html —— 请先执行 npm run build"); process.exit(1); }

const COMMAND = process.env.npm_lifecycle_event ? "npm run " + process.env.npm_lifecycle_event : "node tests/d4-06-resume-ui.mjs";
const git = (args) => { try { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim(); } catch { return null; } };
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
const child = spawn(electronPath, [probeDir], { stdio: ["ignore", "pipe", "pipe"], env });
let stdout = ""; let stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
const exitCode = await new Promise((resolve) => { const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 600000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
await provider.close().catch(() => {});

for (const line of stdout.split("\n")) if (line.includes("DIAG")) console.log(line);
console.log("PROVIDER_HISTORY " + JSON.stringify(provider.state.history));
const m = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!m) {
  console.log("ERROR: resume UI 探针未输出结果");
  console.log("stdout:\n" + stdout.slice(0, 4000));
  console.log("stderr:\n" + stderr.slice(0, 3000));
  process.exit(1);
}
const report = JSON.parse(m[1]);
const failed = report.checks.filter((c) => !c.ok);

let gate = sanitize({
  phase: "D4-06-Closure",
  title: "预算停止后的显式续接（真实 UI 路径）",
  testedCommit: git(["rev-parse", "HEAD"]),
  workspaceState: git(["status", "--porcelain"]) || "",
  command: COMMAND,
  env: { electron: report.versions.electron, node: report.versions.node, platform: report.versions.platform, arch: report.versions.arch },
  officialDsh: true,
  productRuntimeBoot: true,
  checks: (report.checks || []).map((c) => ({ name: c.name, expected: c.expected == null ? null : c.expected, actual: c.actual == null ? (c.detail == null ? null : c.detail) : c.actual, ok: c.ok === true })),
  stats: report.stats,
  rendererConsoleErrors: report.secrets.consoleErrors,
  mainUnhandledErrors: report.secrets.mainErrors,
  secretHits: report.secrets.secretHits,
  checksSummary: { total: report.checks.length, pass: report.checks.length - failed.length, fail: failed.length },
  at: new Date().toISOString(),
});
gate.artifactSha256Coverage = "sha256 of canonical JSON (2-space indent) excluding the artifactSha256 field";
gate.artifactSha256 = crypto.createHash("sha256").update(JSON.stringify(gate, null, 2)).digest("hex");
const artifactDir = path.join(ROOT, "artifacts", "d4-06-resume");
fs.mkdirSync(artifactDir, { recursive: true });
const artifactPath = path.join(artifactDir, "resume-ui-gate.json");
fs.writeFileSync(artifactPath, JSON.stringify(gate, null, 2));

console.log("\n" + (report.checks.length - failed.length) + "/" + report.checks.length + " resume UI checks passed");
if (report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n").slice(0, 2000));
if (failed.length) console.log("FAILED: " + failed.map((f) => f.name + " (" + f.detail + ")").join(" | "));
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 1200));
console.log("GATE: " + JSON.stringify({ testedCommit: gate.testedCommit, exitCode, checks: gate.checksSummary, artifactSha256: gate.artifactSha256 }));

const ok = failed.length === 0 && exitCode === 0 && gate.rendererConsoleErrors === 0 && gate.mainUnhandledErrors === 0 && gate.secretHits === 0 && gate.checksSummary.total > 0;
process.exit(ok ? 0 : 1);
