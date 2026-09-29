/**
 * D5-03 第十一批 · 最小复现：**在 `.then()` 微任务里再调 app.quit()，Electron 44 不会继续退出序列**。
 *
 * 背景：产品 electron/main.cjs 原实现是
 *     app.on("will-quit", (e) => { e.preventDefault(); dispose().then(() => app.quit()); });
 * 实测这条链在收尾完成后**停在 will-quit**：before-quit / will-quit 不再触发、quit 事件不来、
 * 进程只能被外部杀掉。把同一句 app.quit() 放进宏任务（setTimeout / setImmediate）则正常退出。
 *
 * 用法：node experiments/d5-03/batch11/verify/quit-microtask-repro.mjs
 * 输出：两种模式的观测 JSON（每种模式一个真实 Electron 进程，8s 未退出即判挂死并 SIGKILL）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const RUN_DIR = process.env.OA_B11_REPRO_OUT || path.join(ROOT, "experiments/d5-03/batch11/verify/runs", "quit-microtask-repro");
const WATCH_MS = 8000;
fs.mkdirSync(RUN_DIR, { recursive: true });

const APP = path.join(RUN_DIR, "app");
fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(APP, "package.json"), JSON.stringify({ name: "oa-quit-repro", private: true, main: "main.js" }, null, 2));
fs.writeFileSync(path.join(APP, "main.js"), `
const { app, BrowserWindow } = require("electron");
const MODE = process.env.OA_REPRO_MODE || "micro";
const at = () => Date.now();
app.on("before-quit", () => console.log("BEFORE_QUIT@" + at()));
let n = 0;
app.on("will-quit", (e) => {
  n += 1;
  console.log("WILL_QUIT#" + n + "@" + at());
  if (n > 1) return;
  e.preventDefault();
  // 与产品原实现完全同形：收尾（promise）完成后在 .then() 里再调 app.quit()
  Promise.resolve({ ok: true }).then((res) => {
    console.log("DISPOSED@" + at() + " " + JSON.stringify(res));
    if (MODE === "micro") app.quit();
    else setImmediate(() => app.quit());
  });
});
app.on("quit", () => console.log("QUIT@" + at()));
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false });
  w.loadURL("data:text/html,repro");
  setTimeout(() => { console.log("TRIGGER@" + at()); app.quit(); }, 700);
});
`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

async function runMode(mode) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-quit-repro-" + mode + "-"));
  const child = spawn(electronPath, [APP, "--user-data-dir=" + userDataDir, "--no-sandbox", "--disable-gpu-sandbox", "--in-process-gpu"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OA_REPRO_MODE: mode },
  });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  const t0 = Date.now();
  let exited = false; let code = null;
  child.on("close", (c) => { exited = true; code = c; });
  while (!exited && Date.now() - t0 < WATCH_MS) await sleep(50);
  const hung = !exited;
  if (hung) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  await sleep(150);
  return {
    mode, hung, exitCode: code, elapsedMs: Date.now() - t0,
    lifecycle: out.split("\n").filter((l) => /^(TRIGGER|BEFORE_QUIT|WILL_QUIT|DISPOSED|QUIT)@/.test(l)),
    processAliveAfterWatch: pidAlive(child.pid),
  };
}

const micro = await runMode("micro");
const macro = await runMode("macro");
const verdict = {
  at: new Date().toISOString(),
  electron: micro.lifecycle.length ? null : null,
  microtask: micro,
  macrotask: macro,
  conclusion: micro.hung && !macro.hung
    ? "复现成立：微任务里的 app.quit() 停在 will-quit（进程不退出）；宏任务正常退出"
    : "未复现：两种模式行为一致（需重新核对 Electron 版本）",
};
fs.writeFileSync(path.join(RUN_DIR, "quit-microtask-repro.json"), JSON.stringify(verdict, null, 2));
console.log(JSON.stringify(verdict, null, 2));
process.exit(micro.hung && !macro.hung ? 0 : 1);
