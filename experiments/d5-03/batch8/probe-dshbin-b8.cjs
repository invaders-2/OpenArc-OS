#!/usr/bin/env node
"use strict";
/* 1.3e: OPENARC_DSH_BIN with a fake dsh executable that belongs to NO dsh install -> must be REJECTED.
   Plus positive control (a real project-owned bin must still be accepted). */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const REPO = path.resolve(__dirname, "..", "..", "..");
const A = require(path.join(REPO, "electron", "harness-adapter.cjs"));

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
function attempt(label, fn) {
  try { const v = fn(); console.log("  [" + label + "] OK -> " + JSON.stringify(v)); return { label, ok: true, value: v }; }
  catch (e) { console.log("  [" + label + "] THROW code=" + e.code + " :: " + e.message); return { label, ok: false, code: e.code, message: e.message }; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d503-b8-bin-"));
console.log("temp root: " + tmp);
console.log("");

/* ---- e1: plain fake executable, no dsh install anywhere above it ---- */
const orphan = path.join(tmp, "orphan", "dsh");
fs.mkdirSync(path.dirname(orphan), { recursive: true });
fs.writeFileSync(orphan, "#!/bin/sh\necho FAKE-DSH\n");
fs.chmodSync(orphan, 0o755);
console.log("=== 1.3e-1 fake bin, belongs to NO dsh install ===");
console.log("  path=" + orphan);
console.log("  executable=" + fs.statSync(orphan).mode.toString(8) + "  realpath=" + fs.realpathSync(orphan));
attempt("orphan-fake-bin", () => withEnv({ OPENARC_DSH_BIN: orphan }, () => A.resolveDshBin()));
console.log("");

/* ---- e2: fake bin that IS walk-up-inside a planted dsh install of the WRONG version ---- */
const plantedRoot = path.join(tmp, "planted-runtime");
const plantedPkg = path.join(plantedRoot, "node_modules", "@deepseek-ai", "dsh", "package.json");
fs.mkdirSync(path.dirname(plantedPkg), { recursive: true });
fs.writeFileSync(plantedPkg, JSON.stringify({ name: "@deepseek-ai/dsh", version: "9.9.9-fake" }));
const plantedBin = path.join(plantedRoot, "node_modules", ".bin", "dsh");
fs.mkdirSync(path.dirname(plantedBin), { recursive: true });
fs.writeFileSync(plantedBin, "#!/bin/sh\necho PLANTED\n");
fs.chmodSync(plantedBin, 0o755);
console.log("=== 1.3e-2 fake bin claiming ownership by a planted 9.9.9-fake install ===");
console.log("  bin=" + plantedBin + "  plantedVersion=9.9.9-fake");
attempt("planted-wrong-version-bin", () => withEnv({ OPENARC_DSH_BIN: plantedBin }, () => A.resolveDshBin()));
console.log("");

/* ---- e3: PATH shadowing must be irrelevant (a fake dsh earlier on PATH) ---- */
console.log("=== 1.3e-3 fake dsh earlier on PATH must NOT be picked up ===");
const pathDir = path.join(tmp, "pathshadow");
fs.mkdirSync(pathDir, { recursive: true });
const shadow = path.join(pathDir, "dsh");
fs.writeFileSync(shadow, "#!/bin/sh\necho SHADOW\n"); fs.chmodSync(shadow, 0o755);
const r3 = withEnv({ PATH: pathDir + ":" + process.env.PATH, OPENARC_DSH_BIN: undefined, OPENARC_DSH_RUNTIME: undefined }, () => A.resolveDshBin());
console.log("  fake on PATH: " + shadow);
console.log("  resolveDshBin() -> " + r3);
console.log("  picked the PATH shadow? " + (String(r3).startsWith(pathDir) ? "YES (FAIL)" : "NO (PASS)"));
console.log("");

/* ---- e4: POSITIVE CONTROL - the real project-owned bin must still be accepted ---- */
const realBin = path.join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
console.log("=== 1.3e-4 positive control: real project-owned dsh bin ===");
console.log("  bin=" + realBin + " exists=" + fs.existsSync(realBin));
attempt("real-project-bin", () => withEnv({ OPENARC_DSH_BIN: realBin }, () => A.resolveDshBin()));
console.log("");

/* ---- e5: runtime without any .bin/dsh -> documented null (not a silent foreign bin) ---- */
const noBinRuntime = path.join(tmp, "valid-version-no-bin");
fs.mkdirSync(path.join(noBinRuntime, "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
fs.writeFileSync(path.join(noBinRuntime, "node_modules", "@deepseek-ai", "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.5-rc.2" }));
console.log("=== 1.3e-5 runtime with correct version but no .bin/dsh ===");
attempt("runtime-without-bin", () => withEnv({ OPENARC_DSH_RUNTIME: noBinRuntime, OPENARC_DSH_BIN: undefined }, () => A.resolveDshBin(noBinRuntime)));
