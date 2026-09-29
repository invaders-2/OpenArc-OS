#!/usr/bin/env node
"use strict";
/* Batch8 independent resolver probe. Read-only against product code; writes only into a temp dir. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..");
const ADAPTER = path.join(REPO, "electron", "harness-adapter.cjs");

function line(s) { console.log(s); }
function attempt(label, fn) {
  try { const v = fn(); line("  RESULT: OK -> " + JSON.stringify(v)); return { label, ok: true, value: v }; }
  catch (e) { line("  RESULT: THROW code=" + e.code + " message=" + e.message); return { label, ok: false, code: e.code, message: e.message }; }
}
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d503-b8-probe-"));
line("temp root: " + tmp);
line("adapter:   " + ADAPTER);
line("");

line("=== 1.2 default resolver quadruple (no overrides) ===");
const A = require(ADAPTER);
const quad = {};
quad.runtime = withEnv({ OPENARC_DSH_RUNTIME: undefined, OPENARC_DSH_BIN: undefined }, () => A.resolveDshRuntime());
quad.bin = withEnv({ OPENARC_DSH_RUNTIME: undefined, OPENARC_DSH_BIN: undefined }, () => A.resolveDshBin());
quad.dshVersion = A.dshVersion();
quad.sdkPath = A.resolveAcpSdk();
line("  runtime    = " + quad.runtime);
line("  bin        = " + quad.bin);
line("  dshVersion = " + quad.dshVersion);
line("  sdkPath    = " + quad.sdkPath);
line("  sdkVersion = " + A.resolveAcpSdk() + " -> " + (function(){ try { return require(path.join(path.dirname(path.dirname(quad.sdkPath)),"package.json")).version; } catch(e){ return "ERR "+e.message; } })());
line("  PINNED_DSH_VERSION constant vs actual: " + (quad.dshVersion === "0.1.5-rc.2" ? "MATCH" : "MISMATCH"));
line("  runtime === repo root ? " + (quad.runtime === REPO));
line("  bin exists on disk ? " + fs.existsSync(quad.bin));
line("  DEFAULT_JSON " + JSON.stringify(quad));
line("");

line("=== 1.3a OPENARC_DSH_RUNTIME=<empty temp dir> -> expect DSH_RUNTIME_MISSING ===");
const emptyDir = path.join(tmp, "empty-runtime"); fs.mkdirSync(emptyDir, { recursive: true });
line("  dir contents: " + JSON.stringify(fs.readdirSync(emptyDir)));
attempt("empty-runtime", () => withEnv({ OPENARC_DSH_RUNTIME: emptyDir }, () => A.resolveDshRuntime()));
line("");

line("=== 1.3b OPENARC_DSH_RUNTIME=<temp dir with fake package.json 0.2.0-rc.1> -> expect DSH_VERSION_MISMATCH ===");
const driftDir = path.join(tmp, "drift-runtime");
fs.mkdirSync(path.join(driftDir, "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
fs.writeFileSync(path.join(driftDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.0-rc.1" }, null, 2));
line("  planted: " + path.join(driftDir, "node_modules/@deepseek-ai/dsh/package.json") + " version=0.2.0-rc.1");
attempt("drift-runtime", () => withEnv({ OPENARC_DSH_RUNTIME: driftDir }, () => A.resolveDshRuntime()));
line("");

line("=== 1.3c OPENARC_DSH_RUNTIME=<REAL DSH Desktop shared runtime> -> expect DSH_VERSION_MISMATCH (must NOT adopt) ===");
const SHARED = "/Users/wepingli/Library/Application Support/DSH Desktop/runtime";
line("  shared runtime exists on disk ? " + fs.existsSync(SHARED));
const sharedPkgPath = path.join(SHARED, "node_modules", "@deepseek-ai", "dsh", "package.json");
line("  shared dsh package.json exists ? " + fs.existsSync(sharedPkgPath));
let sharedVer = null; try { sharedVer = JSON.parse(fs.readFileSync(sharedPkgPath, "utf8")).version; } catch (e) {}
line("  shared dsh version = " + sharedVer + "  (expected drift = 0.2.0-rc.1)");
const sharedBin = path.join(SHARED, "node_modules", ".bin", "dsh");
line("  shared bin exists ? " + fs.existsSync(sharedBin));
const resShared = attempt("shared-runtime", () => withEnv({ OPENARC_DSH_RUNTIME: SHARED }, () => A.resolveDshRuntime()));
line("  ALSO resolveDshBin under shared runtime (expect reject too):");
attempt("shared-bin", () => withEnv({ OPENARC_DSH_RUNTIME: SHARED, OPENARC_DSH_BIN: undefined }, () => A.resolveDshBin()));
line("  ALSO OPENARC_DSH_BIN=<shared bin> (expect reject too):");
attempt("shared-bin-override", () => withEnv({ OPENARC_DSH_BIN: sharedBin }, () => A.resolveDshBin()));
line("");
line("RESULT_JSON " + JSON.stringify({ quad, resShared }));
