/** 驱动 experiments/dxos-ui-settings/main.cjs（真实 Electron + dist/vue.html），并证明真实 profile 未被改动。 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const artifactDir = path.resolve(here, "../../artifacts/dxos-ui-settings");
fs.mkdirSync(artifactDir, { recursive: true });
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

// ── 真实 profile 快照（mtime + size + sha256），收工比对 ──────────────────────
function walk(dir, base, acc) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) { acc.push({ path: path.relative(base, full), type: "symlink", target: fs.readlinkSync(full) }); continue; }
    if (st.isDirectory()) { walk(full, base, acc); continue; }
    if (st.isFile()) {
      let sha256 = null;
      try { sha256 = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"); } catch { /* unreadable */ }
      acc.push({ path: path.relative(base, full), size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256 });
    }
  }
  return acc;
}
function snapshotDir(dir) {
  if (!fs.existsSync(dir)) return { dir, exists: false, count: 0, files: [] };
  const files = walk(dir, dir, []).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return { dir, exists: true, count: files.length, files };
}
function snapshotFile(file) {
  if (!fs.existsSync(file)) return { file, exists: false };
  const st = fs.statSync(file);
  return { file, exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
}
const HOME = os.homedir();
const SNAP_DIRS = ["openarc-os", "@openarc", "openarc-os-dx"].map((d) => path.join(HOME, "Library", "Application Support", d));
const SNAP_FILES = [path.join(HOME, ".dsh", ".credentials.yaml")];
function snapshotAll() {
  return {
    at: new Date().toISOString(),
    dirs: SNAP_DIRS.map(snapshotDir),
    files: SNAP_FILES.map(snapshotFile),
  };
}
function diffSnapshot(before, after) {
  const changed = [];
  for (let i = 0; i < before.dirs.length; i += 1) {
    const b = before.dirs[i], a = after.dirs[i];
    if (b.exists !== a.exists) { changed.push(b.dir + " exists " + b.exists + "→" + a.exists); continue; }
    if (!b.exists) continue;
    const mapA = new Map(a.files.map((f) => [f.path, f]));
    if (b.files.length !== a.files.length) changed.push(b.dir + " file-count " + b.files.length + "→" + a.files.length);
    for (const f of b.files) {
      const g = mapA.get(f.path);
      if (!g) { changed.push(b.dir + " removed " + f.path); continue; }
      if (f.size !== g.size || f.mtimeMs !== g.mtimeMs || f.sha256 !== g.sha256) changed.push(b.dir + " changed " + f.path);
    }
  }
  for (let i = 0; i < before.files.length; i += 1) {
    const b = before.files[i], a = after.files[i];
    if (b.exists !== a.exists) { changed.push(b.file + " exists " + b.exists + "→" + a.exists); continue; }
    if (!b.exists) continue;
    if (b.size !== a.size || b.mtimeMs !== a.mtimeMs || b.sha256 !== a.sha256) changed.push(b.file + " changed");
  }
  return changed;
}

const before = snapshotAll();
console.log("PROFILE_SNAPSHOT_BEFORE " + JSON.stringify({ at: before.at, dirs: before.dirs.map((d) => ({ dir: d.dir, exists: d.exists, count: d.count })), files: before.files }));

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
const child = spawn(electronPath, [here, ...extraArgs], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
let stdout = "", stderr = "";
const LIVE = process.env.DXOS_LIVE === "1";
child.stdout.on("data", (d) => { stdout += String(d); if (LIVE) process.stdout.write(String(d)); });
child.stderr.on("data", (d) => { stderr += String(d); if (LIVE) process.stderr.write(String(d)); });
const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => child.kill("SIGKILL"), Number(process.env.DXOS_TIMEOUT_MS || 420000));
  child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
});

const after = snapshotAll();
const profileChanges = diffSnapshot(before, after);
console.log("PROFILE_SNAPSHOT_AFTER " + JSON.stringify({ at: after.at, dirs: after.dirs.map((d) => ({ dir: d.dir, exists: d.exists, count: d.count })), files: after.files }));
console.log("PROFILE_UNCHANGED " + JSON.stringify({ unchanged: profileChanges.length === 0, changes: profileChanges }));

if (!LIVE) console.log(stdout.split("RESULT ")[0].trimEnd());

const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
const report = match ? JSON.parse(match[1]) : null;
if (!report) {
  console.log("ERROR: 探针未输出 RESULT");
  console.log("stdout tail:\n" + stdout.slice(-4000));
  console.log("stderr:\n" + stderr.slice(-4000));
  process.exit(1);
}
report.profileSnapshot = { unchanged: profileChanges.length === 0, changes: profileChanges, dirs: after.dirs.map((d) => ({ dir: d.dir, exists: d.exists, count: d.count })), credentials: after.files[0] };
report.stderrTail = stderr.trim().slice(0, 2000);
fs.writeFileSync(path.join(artifactDir, "probe-report.json"), JSON.stringify(report, null, 2));

if (report.consoleErrors?.length) console.log("CONSOLE ERRORS:\n" + report.consoleErrors.join("\n"));
if (report.pageErrors?.length) console.log("PAGE ERRORS:\n" + report.pageErrors.join("\n"));
if (report.errors?.length) console.log("PROBE ERRORS:\n" + report.errors.join("\n"));
const failed = report.checks.filter((c) => !c.ok);
console.log("\n" + (report.checks.length - failed.length) + "/" + report.checks.length + " checks passed");
console.log("SHOTS " + (report.shots || []).length + " · consoleErrors=" + (report.consoleErrors || []).length + " · pageErrors=" + (report.pageErrors || []).length);
if (stderr.trim() && !LIVE) console.log("stderr tail:\n" + stderr.trim().slice(0, 1500));
if (failed.length) console.log("FAILED: " + failed.map((f) => f.name + " (" + f.detail + ")").join(" | "));
if (profileChanges.length) console.log("PROFILE CHANGED: " + profileChanges.slice(0, 10).join(" | "));
console.log("exitCode=" + exitCode);
process.exit(failed.length === 0 && profileChanges.length === 0 && exitCode === 0 ? 0 : 1);
