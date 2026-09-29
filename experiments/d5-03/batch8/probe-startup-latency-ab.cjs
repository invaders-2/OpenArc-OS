#!/usr/bin/env node
"use strict";
/* Batch8 补做 · 启动延迟 A/B
   Phase 1: <bin> --version            -> 纯可执行冷启动成本
   Phase 2: <bin> --profile acp  + ACP initialize over stdio -> 真实 ACP boot 成本
   两个 bin 交替测量（A/B/A/B…）以抵消时间漂移。DSH_HOME/HOME 一律指向临时目录，
   共享运行时安装目录只读取/执行，绝不写入。 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..");
const PROJ = path.join(REPO, "node_modules", ".bin", "dsh");
const SHARED = path.join(os.homedir(), "Library", "Application Support", "DSH Desktop", "runtime", "node_modules", ".bin", "dsh");
const N = Number(process.argv[2] || 10);
const BOOT_TIMEOUT_MS = 120000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oa-d503-b8-ab-"));
const TMP = tmp;
console.log("temp root (all writes go here): " + tmp);
console.log("project bin: " + PROJ + "  exists=" + fs.existsSync(PROJ));
console.log("shared  bin: " + SHARED + "  exists=" + fs.existsSync(SHARED));
console.log("N = " + N + " per bin per phase (interleaved A/B)");
console.log("");

function baseEnv(tag) {
  const dshHome = path.join(TMP, tag + "-dsh-home-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(path.join(dshHome, "home"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(TMP, tag + "-ws"), { recursive: true });
  const env = {};
  for (const k of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "SHELL"]) if (process.env[k] != null) env[k] = process.env[k];
  env.HOME = path.join(dshHome, "home");
  env.DSH_HOME = dshHome;
  env.DSH_PERMISSION_MODE = "read-only";
  env.DSH_TELEMETRY_MODE = "DISABLED";
  return { env, dshHome };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Phase 1: --version ---------- */
function measureVersion(bin) {
  return new Promise((resolve) => {
    const { env } = baseEnv("v");
    const t0 = process.hrtime.bigint();
    const c = spawn(bin, ["--version"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("exit", (code, sig) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ ms, code, sig, out: out.trim(), err: err.trim().slice(0, 200) });
    });
    c.on("error", (e) => resolve({ ms: null, error: String(e && e.message || e) }));
  });
}

/* ---------- Phase 2: real ACP boot (initialize handshake) ---------- */
function measureAcpBoot(bin) {
  return new Promise((resolve) => {
    const { env } = baseEnv("acp");
    const t0 = process.hrtime.bigint();
    const c = spawn(bin, ["--profile", "acp"], { env, cwd: TMP, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", done = false;
    const finish = (rec) => { if (done) return; done = true; try { c.kill("SIGKILL"); } catch {} resolve(rec); };
    const timer = setTimeout(() => finish({ ms: null, error: "BOOT_TIMEOUT_" + BOOT_TIMEOUT_MS, stderr: stderr.slice(-400) }), BOOT_TIMEOUT_MS);
    let buf = "";
    c.stdout.on("data", (d) => {
      buf += String(d);
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let m = null; try { m = JSON.parse(line); } catch { continue; }
        if (m && m.id === 1 && (m.result !== undefined || m.error !== undefined)) {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          clearTimeout(timer);
          finish({ ms, protocolVersion: m.result && m.result.protocolVersion, error: m.error ? JSON.stringify(m.error) : null });
        }
      }
    });
    c.stderr.on("data", (d) => { stderr += String(d); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    c.on("exit", (code, sig) => {
      if (!done) { clearTimeout(timer); finish({ ms: null, error: "EXITED_BEFORE_INITIALIZE code=" + code + " sig=" + sig, stderr: stderr.slice(-400) }); }
    });
    c.on("error", (e) => { clearTimeout(timer); finish({ ms: null, error: String(e && e.message || e) }); });
    // ACP initialize request (newline-delimited JSON-RPC)
    setTimeout(() => {
      try {
        c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } }) + "\n");
      } catch (e) { finish({ ms: null, error: "stdin write failed: " + e.message }); }
    }, 50);
  });
}

function stats(xs) {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  const mean = sum / v.length;
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  const p = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return { n: v.length, min: +v[0].toFixed(1), p50: +median.toFixed(1), p90: +p(0.9).toFixed(1), max: +v[v.length - 1].toFixed(1), mean: +mean.toFixed(1), sd: +sd.toFixed(1) };
}

(async () => {
  const bins = { project: PROJ, shared: SHARED };

  console.log("=== Phase 1: <bin> --version (interleaved) ===");
  const v = { project: [], shared: [] };
  const vRaw = { project: [], shared: [] };
  for (let i = 0; i < N; i++) {
    for (const tag of ["project", "shared"]) {
      const r = await measureVersion(bins[tag]);
      vRaw[tag].push(r);
      if (typeof r.ms === "number") v[tag].push(r.ms);
      console.log("  iter " + String(i + 1).padStart(2) + "  " + tag.padEnd(7) + " " + (r.ms === null ? "ERR " + r.error : r.ms.toFixed(1) + " ms") + "  out=" + (r.out || "") + (r.err ? " err=" + r.err : ""));
    }
  }
  console.log("");
  console.log("--- Phase 1 stats (ms) ---");
  console.log("  project: " + JSON.stringify(stats(v.project)));
  console.log("  shared : " + JSON.stringify(stats(v.shared)));
  console.log("");

  console.log("=== Phase 2: <bin> --profile acp + ACP initialize (interleaved) ===");
  const b = { project: [], shared: [] };
  const bRaw = { project: [], shared: [] };
  for (let i = 0; i < N; i++) {
    for (const tag of ["project", "shared"]) {
      const r = await measureAcpBoot(bins[tag]);
      bRaw[tag].push(r);
      if (typeof r.ms === "number") b[tag].push(r.ms);
      console.log("  iter " + String(i + 1).padStart(2) + "  " + tag.padEnd(7) + " " + (r.ms === null ? "ERR " + r.error : r.ms.toFixed(1) + " ms") + "  protocolVersion=" + (r.protocolVersion === undefined ? "-" : r.protocolVersion) + (r.error ? "  error=" + r.error : ""));
      await sleep(150);
    }
  }
  console.log("");
  console.log("--- Phase 2 stats (ms) ---");
  console.log("  project: " + JSON.stringify(stats(b.project)));
  console.log("  shared : " + JSON.stringify(stats(b.shared)));
  console.log("");
  console.log("--- raw arrays ---");
  console.log("  phase1 project ms: " + JSON.stringify(v.project.map((x) => +x.toFixed(1))));
  console.log("  phase1 shared  ms: " + JSON.stringify(v.shared.map((x) => +x.toFixed(1))));
  console.log("  phase2 project ms: " + JSON.stringify(b.project.map((x) => +x.toFixed(1))));
  console.log("  phase2 shared  ms: " + JSON.stringify(b.shared.map((x) => +x.toFixed(1))));
  console.log("");
  console.log("--- phase2 failures (if any) ---");
  for (const tag of ["project", "shared"]) for (const r of bRaw[tag]) if (r.ms === null) console.log("  " + tag + ": " + r.error + (r.stderr ? " | stderr tail: " + r.stderr.replace(/\n/g, " / ") : ""));
  console.log("");
  console.log("host load at end: " + JSON.stringify(os.loadavg()) + " cpus=" + os.cpus().length);
  console.log("temp root kept for inspection: " + TMP);
})();
