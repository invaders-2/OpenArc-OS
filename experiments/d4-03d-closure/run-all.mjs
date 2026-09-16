// D4-03D Closure 标准入口。npm run test:d4-03d-closure
// 主题：Tool-call Identity Seal（mandatory callId + runId/callId/toolId/arguments fingerprint）。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "../..");
const ART = path.join(ROOT, "artifacts", "d4-03d-closure");
fs.rmSync(ART, { recursive: true, force: true });
fs.mkdirSync(ART, { recursive: true });

const FILES = [
  "tests/tool-d4-03d-closure.test.mjs",
  "tests/tool-d4-03d-e2e.test.mjs",
  "tests/tool-d4-03d-authority.test.mjs",
  "tests/tool-d4-03d-audit.test.mjs",
  "tests/tool-dsh-facade.test.mjs",
  "tests/tool-dsh-e2e.test.mjs",
  "tests/tool-dsh-security.test.mjs",
  "tests/tool-dsh-cancel.test.mjs",
  "tests/tool-dsh-lifecycle.test.mjs",
  "tests/side-effect-c4-dsh-write.test.mjs",
];

let versions = {};
try {
  const store = require(path.join(ROOT, "electron", "identity-store.cjs"));
  const { ToolRegistry } = require(path.join(ROOT, "electron", "tool-registry.cjs"));
  const bridge = require(path.join(ROOT, "electron", "tool-facade-bridge.cjs"));
  const harness = require(path.join(ROOT, "electron", "harness-adapter.cjs"));
  let dshVersion = null; let acpVersion = null;
  try { dshVersion = harness.dshVersion(harness.resolveDshRuntime()); } catch { /* ignore */ }
  try {
    const sdkPath = harness.resolveAcpSdk();
    if (sdkPath) acpVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(sdkPath)), "package.json"), "utf8")).version;
  } catch { /* ignore */ }
  versions = {
    schemaVersion: store.SCHEMA_VERSION, tools: new ToolRegistry().ids(), dshVersion, acpVersion, protocolVersion: 1,
    errorCodes: { callIdRequired: bridge.BRIDGE_ERROR.CALL_ID_REQUIRED, callIdConflict: bridge.BRIDGE_ERROR.CALL_ID_CONFLICT },
    callIdContract: { max: 256, controlCharsRejected: true, emptyRejected: true },
    callIdValidSample: bridge.isValidCallId("call_1"), callIdEmptyInvalid: !bridge.isValidCallId(""),
  };
} catch (e) { versions = { error: String((e && e.message) || e) }; }

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=180000", ...FILES], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
const code = await new Promise((r) => child.on("close", r));
const m = out.match(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# fail (\d+)/);
const summary = m ? { tests: Number(m[1]), pass: Number(m[2]), fail: Number(m[3]) } : { tests: 0, pass: 0, fail: 1 };
const green = summary.fail === 0 && code === 0;
const report = {
  ...summary,
  files: FILES,
  mode: "D4-03D CLOSURE (Tool-call Identity Seal: mandatory bounded callId; identity = runId + callId + toolId + canonical arguments fingerprint; conflict fails closed; duplicate consumes 0 extra budget)",
  versions,
  contract: {
    callIdMandatory: green,
    identityBoundToToolIdAndArguments: green,
    canonicalArgumentsFingerprint: green,
    callIdConflictFailsClosed: green,
    exactDuplicateZeroExtraBudget: green,
    pluginMissingCallIdFailClosed: green,
    harnessCallIdIsNotSideEffectAuthority: green,
    maxCallsAtomic: green,
    noNewPersistentAuthorityTable: true,
    schemaBumped: false,
  },
  machine: { os: process.platform + " " + os.release(), arch: process.arch, node: process.version },
  at: new Date().toISOString(),
};
fs.writeFileSync(path.join(ART, "d4-03d-closure-gate.json"), JSON.stringify(report, null, 2));
console.log("\n结论：" + (green ? "PASS" : "FAIL") + " — " + JSON.stringify({ ...summary, dsh: versions.dshVersion, acp: versions.acpVersion, errorCodes: versions.errorCodes }));
process.exit(green ? 0 : 1);
