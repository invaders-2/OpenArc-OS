/**
 * D3-01 · 凭据后端 / 运行时（§11 / §28 / §49）。
 *
 * 拉起真实 Electron，在主进程内验证：
 *   · node:sqlite 在 Electron 主进程中可用（持久层技术选型的前提）
 *   · safeStorage 后端（macOS = Keychain，Windows = DPAPI）
 *   · 落盘是密文、权限 0600、clear 后不可恢复
 *
 * **macOS 真实验证 / Windows NOT VERIFIED**：身份领域逻辑可跨平台跑，
 * 但 credential backend 的行为不能从 macOS 外推到 Windows（D1-05 同口径）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { Probe, VERDICT, ensureDirs, ART } from "./lib/id.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const probeDir = path.join(here, "native");
const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

const p = new Probe("12-credential-backend", "凭据后端与运行时：Electron 主进程内的 node:sqlite 与 safeStorage");

const child = spawn(electronPath, [probeDir, ...extraArgs], {
  stdio: ["ignore", "pipe", "pipe"],
  env: childEnv,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += String(d)));
child.stderr.on("data", (d) => (stderr += String(d)));

const timeoutMs = 180_000;
const exitCode = await new Promise((resolve) => {
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.on("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});

const versionMatch = stdout.match(/VERSIONS (\{.*\})/);
const versions = versionMatch ? JSON.parse(versionMatch[1]) : {};
p.note(`运行时：Electron ${versions.electron || "?"} / Node ${versions.node || "?"} / ${versions.platform || "?"}`);

const match = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
if (!match) {
  p.case("Electron 探针输出", VERDICT.BLOCKED, `未拿到 RESULT；exit=${exitCode}`);
  p.case("stderr 摘要", VERDICT.NOT_VERIFIED, stderr.trim().slice(0, 300) || "(空)");
  const r = p.write();
  console.log(`\n== 12-credential-backend 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
  console.log(`   产物：${r.file}`);
  process.exit(0);
}

const report = JSON.parse(match[1]);
for (const c of report.checks) p.case(c.name, c.ok ? VERDICT.PASS : VERDICT.FAIL, c.detail);
for (const e of report.errors) p.note("主进程错误：" + e.slice(0, 300));

if (process.platform !== "darwin" && process.platform !== "win32") {
  p.case("目标平台凭据后端", VERDICT.NOT_VERIFIED, `platform=${process.platform}`);
} else if (process.platform === "win32") {
  p.case("Windows 凭据后端（DPAPI）", VERDICT.NOT_VERIFIED, "本轮无 Windows 主机，未实测");
}

p.data = { versions, electronExitCode: exitCode };
const r = p.write();
console.log(`\n== 12-credential-backend 结论：${r.verdict} — ${JSON.stringify(r.counts)}`);
console.log(`   产物：${r.file}`);
// BLOCKED/NOT VERIFIED 不判失败：诚实标注比假装通过重要
process.exit(r.verdict === VERDICT.FAIL ? 1 : 0);
