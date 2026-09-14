/** D4-01 Closure E · Full Secret Scan（真实 Electron Renderer / DOM / safeStorage blob）。
 *
 * 启动真实 Electron 探针，覆盖只有 Renderer + 真实 safeStorage 才能验证的面：
 *   DOM / input / dataset / data-*、preload response、IPC 错误投影、error echo 脱敏、
 *   credentials/<ref>.bin 密文扫描、整个 userData 递归扫描、IdentityLogger。
 *
 * raw secret 只经 env 注入探针（测试 setup 内存），绝不写入任何落盘产物。
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
const ROOT = path.resolve(here, "..");
const probeDir = path.join(here, "fixtures", "model-secret-ui-probe");
const ART = path.join(ROOT, "artifacts", "d4-01");
const SECRET_PREFIX = "FAKE_PROVIDER_SECRET_FULLSCAN_D401_";
const SECRET = SECRET_PREFIX + crypto.randomBytes(9).toString("hex");
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) { console.error("缺少 dist/index.html（请先 npm run build）"); process.exit(1); }

const success = await startFakeProvider({ behavior: "success", secretEcho: SECRET });
const echo = await startFakeProvider({ behavior: "401", secretEcho: SECRET });
const err = await startFakeProvider({ behavior: "500", secretEcho: SECRET });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d4-01-e-ui-"));

const env = { ...process.env, OA_FULLSCAN_SECRET: SECRET, OA_FAKE_BASE_URL: success.baseUrl, OA_ECHO_BASE_URL: echo.baseUrl, OA_ERR_BASE_URL: err.baseUrl, OA_USERDATA: userData };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
const child = spawn(electronPath, [probeDir, ...extraArgs], { stdio: ["ignore", "pipe", "pipe"], env });
let stdout = ""; let stderr = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
const code = await new Promise((resolve) => { const t = setTimeout(() => child.kill("SIGKILL"), 300000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
await Promise.all([success.close(), echo.close(), err.close()]);

const m = stdout.match(/RESULT ([\s\S]*})\s*$/);
if (!m) {
  console.log("ERROR: 未输出结果\n" + stdout.slice(0, 4000) + "\n" + stderr.slice(0, 2000));
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
}
const report = JSON.parse(m[1]);

// 扫描：harness 输出 / userData / artifact
const scanTree = (dir) => {
  const hits = []; let files = 0;
  const visit = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const p = path.join(d, e.name); if (e.isDirectory()) visit(p); else { files += 1; let buf; try { buf = fs.readFileSync(p); } catch { continue; } if (buf.toString("latin1").includes(SECRET)) hits.push(path.relative(dir, p)); } }
  };
  visit(dir);
  return { files, hits };
};
const userDataScan = scanTree(userData);
try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }

report.harness = {
  exitCode: code,
  secretPrefixInStdout: stdout.includes(SECRET_PREFIX),
  secretInStdout: stdout.includes(SECRET),
  secretInStderr: stderr.includes(SECRET),
  secretInArgv: JSON.stringify([probeDir]).includes(SECRET),
  providerGotKey: success.state.authHeaders[0] === "Bearer " + SECRET,
  echoProviderGotKey: echo.state.authHeaders[0] === "Bearer " + SECRET,
  userDataFiles: userDataScan.files,
  userDataHits: userDataScan.hits.length,
};
fs.mkdirSync(ART, { recursive: true });
const serialized = JSON.stringify(report, null, 2);
report.artifactSelfHit = serialized.includes(SECRET);
fs.writeFileSync(path.join(ART, "secret-ui.json"), JSON.stringify(report, null, 2));

const failed = (report.checks || []).filter((c) => !c.ok);
console.log("\n" + ((report.checks || []).length - failed.length) + "/" + (report.checks || []).length + " Electron secret-scan checks passed");
if (report.errors && report.errors.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n"));
if (failed.length) console.log("FAILED: " + failed.map((x) => x.name + " (" + x.detail + ")").join(" | "));
if (stderr.trim()) console.log("stderr:\n" + stderr.trim().slice(0, 800));

const leak = report.harness.secretInStdout || report.harness.secretInStderr || report.harness.userDataHits > 0 || report.artifactSelfHit;
const ok = code === 0 && failed.length === 0 && (report.errors || []).length === 0 && !leak && report.harness.providerGotKey && report.harness.echoProviderGotKey;
console.log(ok ? "PASS: Electron DOM / preload / safeStorage blob / userData 全 Secret Scan 干净。" : "FAIL: D4-01 Closure E Electron secret scan 未通过。");
process.exit(ok ? 0 : 1);
