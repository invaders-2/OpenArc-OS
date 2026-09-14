/** D4-01 Closure D · 真实 macOS secure backend / 跨进程重启 / capability 失效验收。
 *
 * 依次 spawn 4 个独立 Electron 主进程，共享同一 userData（同一 identity.db + credentials/）：
 *   1) 写 credential v1 + 签发旧 proxy capability
 *   2) 重启：元数据/默认值/App identity 保留；v1 仍可用；replace→v2；旧 capability DENY / 新 capability PASS
 *   3) 重启：replace 结果保留（v2 生效）；delete
 *   4) 重启：delete 结果保留；secure item 缺失 → 安全失败；无安全后端 → 无明文 fallback
 *
 * raw secret 由 harness 生成并经 env 注入子进程，绝不写入任何落盘产物。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import assert from "node:assert/strict";
import { startFakeProvider } from "./model-fake-provider.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const probeDir = path.join(here, "fixtures", "model-keychain-restart-probe");
const ROOT = path.resolve(here, "..");
const ART = path.join(ROOT, "artifacts", "d4-01");
const SECRET_PREFIX = "FAKE_PROVIDER_KEYCHAIN_D401_";
const rand = () => crypto.randomBytes(6).toString("hex");
const V1 = SECRET_PREFIX + rand();
const V2 = SECRET_PREFIX + rand();
const V3 = SECRET_PREFIX + rand();
const SECRETS = [V1, V2, V3];
const at = (h) => String(h || "").replace(/^Bearer\s+/, "");

const report = { title: "D4-01 Closure D · macOS secure backend / restart boundary", at: new Date().toISOString(), phases: [], checks: [], scans: {}, headerLedger: [] };
const record = (name, ok, detail) => { report.checks.push({ name, ok: !!ok, detail: String(detail === undefined ? "" : detail).slice(0, 300) }); };

function runPhase(phase, extraEnv) {
  const env = { ...process.env, ...extraEnv, OA_PHASE: String(phase), OA_USERDATA: userData, OA_PROVIDER_URL: provider.baseUrl };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(electronPath, [probeDir, ...extraArgs], { stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolve) => {
    const t = setTimeout(() => child.kill("SIGKILL"), 240000);
    child.on("exit", (code) => {
      clearTimeout(t);
      const m = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
      if (!m) return resolve({ ok: false, code, stdout, stderr, phase: null });
      try { resolve({ ok: true, code, stdout, stderr, phase: JSON.parse(m[1]) }); }
      catch (e) { resolve({ ok: false, code, stdout, stderr, parseError: String(e.message) }); }
    });
  });
}

const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-01-keychain-"));
const provider = await startFakeProvider({ behavior: "success" });
const ledger = [];
let failure = null;

try {
  // ---------------- phase 1 ----------------
  let before = provider.state.authHeaders.length;
  let r1 = await runPhase(1, { OA_SECRET_V1: V1, OA_SECRET_V2: V2, OA_SECRET_V3: V3 });
  if (!r1.ok) { failure = { phase: 1, detail: (r1.stderr || "").slice(0, 800) }; throw new Error("phase1 spawn/parse failed"); }
  assert.equal(r1.code, 0, "phase1 exit " + r1.code);
  report.phases.push({ phase: 1, checks: r1.phase.checks, errors: r1.phase.errors, state: { ...r1.phase.state, oldToken: "[omitted]" } });
  const p1Headers = provider.state.authHeaders.slice(before);
  ledger.push({ phase: 1, requests: p1Headers.length, order: p1Headers.map((h) => (at(h) === V1 ? "V1" : at(h) === V2 ? "V2" : at(h) === V3 ? "V3" : "OTHER")) });
  record("H1 · phase1 credential 被 Provider 接受（Bearer V1）", p1Headers.length === 2 && p1Headers.every((h) => at(h) === V1), "n=" + p1Headers.length);

  // ---------------- phase 2 ----------------
  before = provider.state.authHeaders.length;
  const r2 = await runPhase(2, {
    OA_SECRET_V1: V1, OA_SECRET_V2: V2, OA_SECRET_V3: V3,
    OA_OLD_TOKEN: r1.phase.state.oldToken, OA_OLD_PORT: String(r1.phase.state.oldPort),
    OA_OLD_EXPIRES: String(r1.phase.state.oldExpiresAt), OA_EXPECT_CONFIG_VERSION: String(r1.phase.state.configVersion),
  });
  if (!r2.ok) { failure = { phase: 2, detail: (r2.stderr || "").slice(0, 800) }; throw new Error("phase2 spawn/parse failed"); }
  assert.equal(r2.code, 0, "phase2 exit " + r2.code);
  report.phases.push({ phase: 2, checks: r2.phase.checks, errors: r2.phase.errors, state: r2.phase.state });
  const p2Headers = provider.state.authHeaders.slice(before);
  ledger.push({ phase: 2, requests: p2Headers.length, order: p2Headers.map((h) => (at(h) === V1 ? "V1" : at(h) === V2 ? "V2" : at(h) === V3 ? "V3" : "OTHER")) });
  record("H2 · phase2 replace 前仍 V1、replace 后 V2（真正生效）", p2Headers.length === 3 && at(p2Headers[0]) === V1 && at(p2Headers[1]) === V1 && at(p2Headers[2]) === V2, "n=" + p2Headers.length);

  // ---------------- phase 3 ----------------
  before = provider.state.authHeaders.length;
  const r3 = await runPhase(3, { OA_SECRET_V1: V1, OA_SECRET_V2: V2, OA_SECRET_V3: V3 });
  if (!r3.ok) { failure = { phase: 3, detail: (r3.stderr || "").slice(0, 800) }; throw new Error("phase3 spawn/parse failed"); }
  assert.equal(r3.code, 0, "phase3 exit " + r3.code);
  report.phases.push({ phase: 3, checks: r3.phase.checks, errors: r3.phase.errors, state: r3.phase.state });
  const p3Headers = provider.state.authHeaders.slice(before);
  ledger.push({ phase: 3, requests: p3Headers.length, order: p3Headers.map((h) => (at(h) === V1 ? "V1" : at(h) === V2 ? "V2" : at(h) === V3 ? "V3" : "OTHER")) });
  record("H3 · phase3 仍用 V2（replace 跨重启生效，未回退 V1）", p3Headers.length === 1 && at(p3Headers[0]) === V2, "n=" + p3Headers.length);
  record("H4 · delete 后不再触达 Provider", provider.state.authHeaders.length === before + 1, "total=" + provider.state.authHeaders.length);

  // ---------------- phase 4 ----------------
  before = provider.state.authHeaders.length;
  const r4 = await runPhase(4, { OA_SECRET_V1: V1, OA_SECRET_V2: V2, OA_SECRET_V3: V3 });
  if (!r4.ok) { failure = { phase: 4, detail: (r4.stderr || "").slice(0, 800) }; throw new Error("phase4 spawn/parse failed"); }
  assert.equal(r4.code, 0, "phase4 exit " + r4.code);
  report.phases.push({ phase: 4, checks: r4.phase.checks, errors: r4.phase.errors, state: r4.phase.state });
  record("H5 · phase4 无任何 Provider 请求（delete / missing 均未发请求）", provider.state.authHeaders.length === before, "delta=" + (provider.state.authHeaders.length - before));

  report.headerLedger = ledger;
} catch (e) {
  record("harness 整体未抛异常", false, String(e && e.message).slice(0, 240));
  if (!failure) failure = { detail: String((e && e.stack) || e).slice(0, 800) };
} finally {
  try { await provider.close(); } catch { /* ignore */ }
}

// ---------------- 汇总 + 落盘扫描 ----------------
const allChecks = [...report.checks, ...report.phases.flatMap((p) => p.checks)];
const failed = allChecks.filter((c) => !c.ok);
const phaseErrors = report.phases.flatMap((p) => p.errors || []);
report.summary = { total: allChecks.length, pass: allChecks.length - failed.length, fail: failed.length, phaseErrors: phaseErrors.length, spawnFailure: failure ? failure.detail : null };
report.scans.secretPrefixHitsInArtifact = 0; // 下面自查后回填

const artifactPath = path.join(ART, "keychain-restart.json");
fs.mkdirSync(ART, { recursive: true });
const serialized = JSON.stringify(report, (k, v) => (k === "oldToken" ? "[omitted]" : v), 2);
let selfHits = 0;
for (const s of SECRETS) if (serialized.includes(s)) selfHits += 1;
if (serialized.includes(SECRET_PREFIX)) selfHits += 1;
report.scans.secretPrefixHitsInArtifact = selfHits;
report.scans.secretValuesInArtifact = SECRETS.filter((s) => serialized.includes(s)).length;
fs.writeFileSync(artifactPath, JSON.stringify(report, (k, v) => (k === "oldToken" ? "[omitted]" : v), 2));

try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }

console.log("\n" + report.summary.pass + "/" + report.summary.total + " D4-01 Closure D checks passed  (artifact: " + path.relative(ROOT, artifactPath) + ")");
if (failed.length) console.log("FAILED: " + failed.map((x) => x.name + " (" + x.detail + ")").join(" | "));
if (phaseErrors.length) console.log("PHASE ERRORS: " + phaseErrors.map((x) => String(x).slice(0, 300)).join(" | "));
if (failure) console.log("SPAWN FAILURE: " + failure.detail);
if (report.scans.secretPrefixHitsInArtifact > 0) console.log("SECRET LEAK: artifact 命中 raw secret 前缀 " + report.scans.secretPrefixHitsInArtifact + " 次");

const pass = failed.length === 0 && phaseErrors.length === 0 && !failure && report.scans.secretPrefixHitsInArtifact === 0;
console.log(pass ? "PASS: 真实 macOS secure backend / 跨进程重启 / capability 失效边界成立。" : "FAIL: D4-01 Closure D 未通过。");
process.exit(pass ? 0 : 1);
