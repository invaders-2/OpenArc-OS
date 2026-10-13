/**
 * CLI-2 · DX OS 小云雀工具桥（移植自 DX OS 0.5.1 server/pippitCliTools.ts，249 行）。
 *
 * 源：<DX OS.app>/Contents/Resources/app.asar.unpacked/server/pippitCliTools.ts
 * 覆盖：pippit-tool-cli 依赖探测 / 登录态 / 积分查询 / 图片·视频生成提交 / 任务续查。
 *
 * 为什么做成可注入的桥：源直接 spawnSync 本机 pippit-tool-cli 并写 <DX DATA>/cli-output/pippit，
 * OpenArc 主进程要求依赖探测与执行可离线复现，因此统一由
 * configurePippitTools({ spawnImpl, spawnSyncImpl, whichImpl, dataDir, clock }) 注入 seam。
 * 未安装 → { ok:false, error:"CLI_UNAVAILABLE", detail }，绝不假成功。
 *
 * 移植约定：
 *   - 函数名 / 参数 / 输出字段与源逐字对应（TS 类型注解在 CJS 中移除）。
 *   - apiQuota / 云计费链路在源文件与本源中都没有出现；本端口不做任何配额写入或扣费，
 *     pippitCredit 仅只读查询积分余额（源 get-credit-balance 的逐字保留）。
 *   - 端口新增项一律在注释中标注「端口新增」。
 */
"use strict";

const fs = require("node:fs");
const nodePath = require("node:path");
const { spawn: nodeSpawn, spawnSync: nodeSpawnSync } = require("node:child_process");

const CLI_UNAVAILABLE = "CLI_UNAVAILABLE";
const PIPPIT_CLI_NAME = "pippit-tool-cli";
const OUTPUT_SUBDIR = ["cli-output", "pippit"];
const IMAGE_MODELS = ["seedream_5.0_pro", "seedream_5.0", "seedream_4.3", "nova2", "seedream_4.5", "seedream_4.1", "seedream_4"];
const VIDEO_MODELS = ["Seedance_2.0_mini_lite", "seedance2.0_vision", "seedance2.0_fast_vision", "Seedance_2.0_mini", "Seedance_2.5"];
const RATIO_IDS = { auto: "0", original: "0", "16:9": "2", "21:9": "13", "9:16": "3", "4:3": "4", "3:4": "5", "1:1": "6" };

function bundledBinDefault() {
  return nodePath.join(__dirname, "cli-runtime", "pippit", "bin", process.platform === "win32" ? "pippit-tool-cli.exe" : "pippit-tool-cli");
}

function defaultWhich(command) {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  const names = nodePath.extname(command) ? [command] : extensions.flatMap((extension) => [command + extension.toLowerCase(), command + extension.toUpperCase()]);
  for (const directory of (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":")) {
    for (const name of names) {
      const candidate = nodePath.join(directory, name);
      if (directory && fs.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function createDeps(options = {}) {
  return {
    spawnImpl: options.spawnImpl || nodeSpawn,
    spawnSyncImpl: options.spawnSyncImpl || nodeSpawnSync,
    whichImpl: options.whichImpl || defaultWhich,
    dataDir: options.dataDir || nodePath.join(process.env.LOCALAPPDATA || process.env.APPDATA || require("node:os").homedir(), "DX OS", "data"),
    clock: options.clock || (() => Date.now()),
    env: options.env || process.env,
    platform: options.platform || process.platform,
    bundledBin: options.bundledBin || bundledBinDefault(),
    fs: { existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, ...(options.fsImpl || {}) },
  };
}

let deps = createDeps({});
const pippitLoginSession = { proc: null, startedAt: 0, stdout: "", stderr: "" };

function now() { return deps.clock(); }
function existsSync(target) { return deps.fs.existsSync(target); }
function outputRoot() { return nodePath.join(deps.dataDir, ...OUTPUT_SUBDIR); }

/**
 * 依赖探测与执行 seam。四个键与 CLI-1 契约一致；spawnSyncImpl / bundledBin 等为端口新增离线开关。
 * @param {{ spawnImpl?: Function, spawnSyncImpl?: Function, whichImpl?: Function, dataDir?: string, clock?: Function, env?: object, platform?: string, bundledBin?: string, fsImpl?: object }} options
 */
function configurePippitTools(options = {}) {
  if (options.spawnImpl !== undefined && typeof options.spawnImpl !== "function") throw new TypeError("spawnImpl 必须是函数");
  if (options.spawnSyncImpl !== undefined && typeof options.spawnSyncImpl !== "function") throw new TypeError("spawnSyncImpl 必须是函数");
  if (options.whichImpl !== undefined && typeof options.whichImpl !== "function") throw new TypeError("whichImpl 必须是函数");
  if (options.dataDir !== undefined && (typeof options.dataDir !== "string" || !options.dataDir)) throw new TypeError("dataDir 必须是非空字符串");
  if (options.clock !== undefined && typeof options.clock !== "function") throw new TypeError("clock 必须是函数");
  deps = createDeps(options);
  return getPippitToolsConfig();
}

/** 端口新增：返回当前生效 seam 的非敏感摘要。 */
function getPippitToolsConfig() {
  return { dataDir: deps.dataDir, platform: deps.platform, bundledBin: deps.bundledBin };
}

/** 端口新增：测试复位登录会话 / seam。 */
function resetPippitToolsForTests() {
  pippitLoginSession.proc = null;
  pippitLoginSession.startedAt = 0;
  pippitLoginSession.stdout = "";
  pippitLoginSession.stderr = "";
  deps = createDeps({});
}

/** 源 pippitCliTools.ts:31-38 pippitRuntime()。 */
function pippitRuntime() {
  const configured = String(deps.env.PIPPIT_CLI_BIN || "").trim();
  if (configured && existsSync(configured)) return { path: configured, mode: "configured", label: "配置路径" };
  if (existsSync(deps.bundledBin)) return { path: deps.bundledBin, mode: "bundled", label: "DX OS 内置 CLI" };
  const detected = deps.whichImpl(PIPPIT_CLI_NAME);
  if (detected) return { path: detected, mode: "path", label: "本机 pippit-tool-cli" };
  return { path: "", mode: "missing", label: "未检测到" };
}

function pippitCliInstalled() { return !!pippitRuntime().path; }

/** 依赖探测出口，与 CLI-1 probeJimengCli 同契约：未安装 → { ok:false, installed:false, error:"CLI_UNAVAILABLE", detail }。 */
function probePippitCliDependency() {
  const runtime = pippitRuntime();
  if (!runtime.path) return { ok: false, installed: false, error: CLI_UNAVAILABLE, detail: `未检测到小云雀 CLI（已探测 PIPPIT_CLI_BIN / 内置路径 / PATH 上的 ${PIPPIT_CLI_NAME}）。` };
  return { ok: true, installed: true, runtime };
}

/** 与 CLI-1 isCliUnavailable 同契约。 */
function isCliUnavailable(value) {
  return !!value && typeof value === "object" && value.error === CLI_UNAVAILABLE;
}

function parseJson(text) {
  const source = String(text || "").trim();
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* inspect a larger JSON object below */ }
  }
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(source.slice(start, end + 1)); } catch { /* handled below */ }
  }
  throw new Error(source || "小云雀 CLI 没有返回 JSON。");
}

function run(args, timeout = 30_000) {
  const runtime = pippitRuntime();
  if (!runtime.path) throw new Error("未检测到小云雀 CLI。");
  const result = deps.spawnSyncImpl(runtime.path, args, { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `小云雀 CLI 退出码 ${result.status}`).trim());
  return String(result.stdout || "").trim();
}

function runJson(args, timeout) { return parseJson(run(args, timeout)); }

function version() {
  try { return run(["--version"], 5000).split(/\s+/)[0] || ""; } catch { return ""; }
}

async function pippitStatus() {
  const runtime = pippitRuntime();
  if (!runtime.path) return { installed: false, logged_in: false, cli_version: "", runtime };
  try {
    const status = runJson(["status"], 15_000);
    return { installed: true, cli_version: version(), logged_in: status.logged_in === true, source: String(status.source || ""), runtime: { ...runtime, detail: "网页登录凭证保存在 Windows 安全凭证库；也支持 XYQ_ACCESS_KEY。" }, raw: status };
  } catch (error) {
    return { installed: true, cli_version: version(), logged_in: false, runtime, error: String((error && error.message) || error) };
  }
}

async function pippitLoginStart() {
  const runtime = pippitRuntime();
  if (!runtime.path) throw new Error("未检测到小云雀 CLI。");
  if (pippitLoginSession.proc && pippitLoginSession.proc.exitCode == null) {
    try { pippitLoginSession.proc.kill(); } catch { /* 已结束 */ }
  }
  pippitLoginSession.proc = null;
  pippitLoginSession.startedAt = now();
  pippitLoginSession.stdout = "";
  pippitLoginSession.stderr = "";
  const child = deps.spawnImpl(runtime.path, ["login"], { cwd: __dirname, windowsHide: true, env: { ...deps.env } });
  pippitLoginSession.proc = child;
  child.stdout?.on("data", (chunk) => { pippitLoginSession.stdout += Buffer.from(chunk).toString("utf8"); });
  child.stderr?.on("data", (chunk) => { pippitLoginSession.stderr += Buffer.from(chunk).toString("utf8"); });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const deadline = now() + 2500;
  while (!pippitLoginUrl() && child.exitCode == null && now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const loginUrl = pippitLoginUrl();
  if (!loginUrl && child.exitCode != null) throw new Error(pippitLoginError() || `小云雀登录进程已退出（${child.exitCode}）。`);
  return {
    started: true, running: child.exitCode == null, terminal_opened: false,
    started_at: pippitLoginSession.startedAt, login_url: loginUrl || undefined,
    text: loginUrl ? "小云雀登录页面已生成，请在浏览器中完成授权。" : "正在生成小云雀登录页面…",
    message: "请在小云雀网页完成授权。",
  };
}

function pippitLoginUrl() {
  return pippitLoginSession.stderr.match(/https:\/\/xyq\.jianying\.com\/cli\/pippit-tool-login\?[^\s"'<>]+/)?.[0] || "";
}

function pippitLoginError() {
  return pippitLoginSession.stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^https?:\/\//.test(line) && !/授权地址|自动打开浏览器|浏览器中完成登录|CLI 将继续等待/.test(line)).at(-1) || "";
}

async function pippitLoginStatus() {
  const status = await pippitStatus();
  const loggedIn = status.logged_in === true;
  const proc = pippitLoginSession.proc;
  if (loggedIn && proc && proc.exitCode == null) {
    try { proc.kill(); } catch { /* 已结束 */ }
  }
  return {
    ...status,
    running: !loggedIn && !!proc && proc.exitCode == null,
    started_at: pippitLoginSession.startedAt || undefined,
    login_url: !loggedIn ? pippitLoginUrl() || undefined : undefined,
    text: loggedIn ? "小云雀登录成功。" : proc && proc.exitCode == null ? "正在等待小云雀网页授权…" : pippitLoginError() || "登录流程已经结束；如果尚未登录，请重新点击“登录账号”。",
    login_verified_by: loggedIn ? "cli" : undefined,
  };
}

async function pippitLogout() {
  if (pippitLoginSession.proc && pippitLoginSession.proc.exitCode == null) {
    try { pippitLoginSession.proc.kill(); } catch { /* 已结束 */ }
  }
  pippitLoginSession.proc = null;
  const raw = runJson(["logout"], 15_000);
  return { success: true, ...raw };
}

/** 源 pippitCliTools.ts:149-152 只读积分查询。 */
async function pippitCredit() {
  const raw = runJson(["get-credit-balance"], 30_000);
  return { success: true, total_remain_amount: String(raw.total_remain_amount ?? "0"), raw };
}

function pippitModels() {
  return {
    models: [...IMAGE_MODELS, ...VIDEO_MODELS],
    model_items: [
      ...IMAGE_MODELS.map((model) => ({ model, type: "image" })),
      ...VIDEO_MODELS.map((model) => ({ model, type: "video" })),
    ],
    count: IMAGE_MODELS.length + VIDEO_MODELS.length,
    source: "bundled-catalog",
  };
}

function submitResult(raw) {
  const threadId = String(raw.thread_id || "");
  const runId = String(raw.run_id || "");
  if (!threadId || !runId) throw new Error("小云雀 CLI 提交成功但没有返回 thread_id/run_id；为避免重复计费，不会自动重试。");
  return { threadId, runId, webThreadLink: raw.web_thread_link ? String(raw.web_thread_link) : undefined, raw };
}

function ratioId(value) { return RATIO_IDS[String(value || "").trim().toLowerCase()] || (/^\d+$/.test(value) ? value : "0"); }

/** 官方 CLI 仅允许 seedream_5.0_pro 携带图片 resolution。 */
function normalizePippitImageResolution(model, resolution) {
  if (String(model || "").trim().toLowerCase() !== "seedream_5.0_pro") return undefined;
  const value = String(resolution || "").trim().toUpperCase();
  return value === "1K" || value === "2K" || value === "4K" ? value : undefined;
}

function buildPippitImageArgs(input) {
  const args = ["generate-image", "--prompt", input.prompt, "--model", input.model, "--ratio", ratioId(input.ratio || "auto"), "--generate-image-count", String(Math.max(1, Math.min(10, Math.round(Number(input.count) || 1))))];
  const resolution = normalizePippitImageResolution(input.model, input.resolution);
  if (resolution) args.push("--resolution", resolution);
  for (const image of (input.images || []).slice(0, 9)) args.push("--image", image);
  return args;
}

function buildPippitVideoArgs(input) {
  const duration = Math.max(1, Math.min(30, Math.round(Number(input.duration) || 5)));
  const args = ["generate-video", "--prompt", input.prompt, "--model", input.model, "--duration", String(duration), "--ratio", input.ratio || "16:9", "--resolution", input.resolution || "720p"];
  if (input.generateType) args.push("--generate-type", String(input.generateType));
  for (const image of (input.images || []).slice(0, 9)) args.push("--image", image);
  for (const video of (input.videos || []).slice(0, 3)) args.push("--video", video);
  for (const audio of (input.audios || []).slice(0, 3)) args.push("--audio", audio);
  return args;
}

function buildPippitVideoUpscaleArgs(input) {
  const args = ["video-super-resolution", "--video", input.video, "--output-resolution", input.outputResolution.toLowerCase()];
  if (input.toolVersion) args.push("--tool-version", input.toolVersion);
  return args;
}

function buildPippitEraseVideoSubtitleArgs(input) {
  return ["erase-video-subtitle", "--video", input.video];
}

async function submitPippitImage(input) {
  return submitResult(runJson(buildPippitImageArgs(input), 10 * 60_000));
}

async function submitPippitVideo(input) {
  return submitResult(runJson(buildPippitVideoArgs(input), 10 * 60_000));
}

async function submitPippitVideoUpscale(input) {
  return submitResult(runJson(buildPippitVideoUpscaleArgs(input), 10 * 60_000));
}

async function submitPippitEraseVideoSubtitle(input) {
  return submitResult(runJson(buildPippitEraseVideoSubtitleArgs(input), 10 * 60_000));
}

function resultPaths(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (!entry || typeof entry !== "object") return [];
    const item = entry;
    const preferred = item.output_path || item.download_url;
    return preferred ? [String(preferred)] : [];
  });
}

/** 源 pippitCliTools.ts:237-249 任务续查。 */
async function queryPippitResult(threadId, runId, taskId = runId) {
  if (!threadId || !runId) throw new Error("小云雀任务缺少 thread_id/run_id；为避免重复计费，不会重新提交。");
  const output = nodePath.join(outputRoot(), String(taskId).replace(/[^a-zA-Z0-9._-]/g, "_"));
  deps.fs.mkdirSync(output, { recursive: true });
  const raw = runJson(["query-result", "--thread-id", threadId, "--run-id", runId, "--download-dir", output], 5 * 60_000);
  return {
    completed: raw.completed === true,
    images: resultPaths(raw.images),
    videos: resultPaths(raw.videos),
    error: raw.error_message ? String(raw.error_message) : undefined,
    raw,
  };
}

module.exports = {
  CLI_UNAVAILABLE,
  configurePippitTools,
  getPippitToolsConfig,
  resetPippitToolsForTests,
  pippitRuntime,
  pippitCliInstalled,
  probePippitCliDependency,
  isCliUnavailable,
  parsePippitJson: parseJson,
  pippitStatus,
  pippitLoginStart,
  pippitLoginStatus,
  pippitLogout,
  pippitCredit,
  pippitModels,
  normalizePippitImageResolution,
  buildPippitImageArgs,
  buildPippitVideoArgs,
  buildPippitVideoUpscaleArgs,
  buildPippitEraseVideoSubtitleArgs,
  submitPippitImage,
  submitPippitVideo,
  submitPippitVideoUpscale,
  submitPippitEraseVideoSubtitle,
  queryPippitResult,
};
