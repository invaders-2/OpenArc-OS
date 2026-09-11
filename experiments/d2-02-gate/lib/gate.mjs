/**
 * D2-02 Gate 探针运行器（共用）。
 *
 * 沿用 D1-01 的既定路径：本机 Playwright 1.55 无法与 Electron 44 完成 CDP 握手
 * （`_electron.launch` / `connectOverCDP` 均超时，根因未确认），因此原生层证据
 * 一律走「spawn Electron + 主进程内断言 + stdout 输出 RESULT {...}」。
 *
 * 必须以**目录**启动 Electron（`electron <nativeDir>`）。
 * 传 .cjs 文件路径时 Electron 会退化成 Node 模式：process.type === undefined、
 * require("electron") 返回 npm 包里的二进制路径字符串而不是 API 对象。
 *
 * 本机 Chromium 沙箱无法初始化，需：
 *   ELECTRON_EXTRA_ARGS="--no-sandbox --disable-gpu-sandbox --in-process-gpu"
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
export const electronPath = require("electron");
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultNativeDir = path.join(here, "..", "native");
export const nativeDir = defaultNativeDir;
export const artifactsDir = path.join(here, "..", "..", "..", "artifacts", "d2-02");
export const extraArgs = (process.env.ELECTRON_EXTRA_ARGS || "").split(" ").filter(Boolean);

/**
 * 本机执行环境会把 `ELECTRON_RUN_AS_NODE=1` 导出给子进程。
 * 一旦带上它，Electron 会退化成 Node 模式：
 *   - `process.type === undefined`
 *   - `require("electron")` 返回 npm 包里的二进制路径字符串而不是 API 对象
 *   - 任何主进程探针都在 `app.whenReady` 处崩溃
 * 这是**执行环境产物**，不是项目缺陷。这里显式剥离，避免用它掩盖真实失败。
 */
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}
export const hadRunAsNode = () => !!process.env.ELECTRON_RUN_AS_NODE;

/**
 * 跑一个 native 探针，返回其 RESULT 报告。超时或未输出即抛错。
 *
 * `nativeDir` 可覆盖探针宿主目录 —— D2-02B 的产品侧原生探针
 * （experiments/d2-02/native）复用本函数，从而也复用了 cleanEnv 的剥离逻辑，
 * 不必把 `ELECTRON_RUN_AS_NODE` 那条踩坑记录再抄一遍。
 */
export function runNative(probe, { timeout = 300000, env = {}, nativeDir: dir = defaultNativeDir } = {}) {
  const child = spawn(electronPath, [dir, ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanEnv({ GATE_PROBE: probe, ...env }),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const m = stdout.match(/RESULT (\{[\s\S]*\})\s*$/);
      if (!m) {
        return reject(
          new Error(
            `探针 ${probe} 未输出 RESULT（exit=${code}）\nstdout:\n${stdout.slice(-2500)}\nstderr:\n${stderr.slice(-1500)}`,
          ),
        );
      }
      const report = JSON.parse(m[1]);
      report._stderr = stderr;
      report._exit = code;
      resolve(report);
    });
  });
}

/** 打印一份可读的 case 表。 */
export function printCases(title, report) {
  const cases = report.cases || [];
  const failed = cases.filter((c) => !c.ok);
  console.log(`\n=== ${title} ===`);
  for (const c of cases) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.id}  :: ${c.detail}`);
  if (report.errors?.length) console.log("  PROBE ERRORS:\n" + report.errors.join("\n"));
  console.log(`  -> ${cases.length - failed.length}/${cases.length} 通过`);
  return { passed: cases.length - failed.length, failed: failed.length, total: cases.length };
}

export function writeArtifact(name, payload) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const file = path.join(artifactsDir, name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}
