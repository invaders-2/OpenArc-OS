/**
 * D5-03 第一批 · 根因探针：Electron utilityProcess 的 stdin 到底有没有？
 *
 * 不是产品代码，只是把 electron/executor-launcher.cjs 的 ElectronUtilityProcessLauncher
 * 那三行（utilityProcess.fork(entry, args, { stdio: "pipe" }) → handle.stdin = child.stdin || null）
 * 拿出来单跑一遍，如实打印句柄能力与子进程侧看到的 argv/execPath/stdin。
 *
 * 用法：electron experiments/d5-03/utility-stdin-probe.cjs --no-sandbox --disable-gpu-sandbox --in-process-gpu
 */
"use strict";
const { app, utilityProcess } = require("electron");
const path = require("node:path");

const CHILD = path.join(__dirname, "utility-stdin-probe-child.cjs");

app.whenReady().then(() => {
  const report = { electron: process.versions.electron, node: process.versions.node, mainPid: process.pid };
  let child;
  try {
    child = utilityProcess.fork(CHILD, ["--probe-arg"], { stdio: "pipe", env: { PATH: String(process.env.PATH || "") }, serviceName: "d503-stdin-probe" });
  } catch (err) {
    report.forkError = String((err && err.message) || err);
    process.stdout.write("PROBE=" + JSON.stringify(report) + "\n");
    app.quit();
    return;
  }
  report.childPid = child.pid == null ? null : child.pid;
  report.stdinType = typeof child.stdin;
  report.stdinIsNull = child.stdin === null;
  report.stdinIsUndefined = child.stdin === undefined;
  report.stdinHasWrite = !!(child.stdin && typeof child.stdin.write === "function");
  report.stdoutType = typeof child.stdout;
  report.stdoutHasOn = !!(child.stdout && typeof child.stdout.on === "function");
  report.stderrType = typeof child.stderr;
  report.childKeys = Object.keys(child);
  let stdoutText = "";
  if (child.stdout && typeof child.stdout.on === "function") child.stdout.on("data", (d) => { stdoutText += String(d); });
  if (child.stderr && typeof child.stderr.on === "function") child.stderr.on("data", (d) => { stdoutText += "[stderr]" + String(d); });
  report.wroteToStdin = false;
  if (report.stdinHasWrite) {
    try { child.stdin.write(JSON.stringify({ hello: "from-main" }) + "\n"); report.wroteToStdin = true; } catch (err) { report.stdinWriteError = String((err && err.message) || err); }
  }
  child.on("exit", (code, signal) => { report.childExit = { code, signal }; });
  setTimeout(() => {
    report.childStdout = stdoutText.slice(0, 1200);
    process.stdout.write("PROBE=" + JSON.stringify(report) + "\n");
    try { child.kill(); } catch { /* ignore */ }
    setTimeout(() => app.quit(), 300);
  }, 2000);
});
