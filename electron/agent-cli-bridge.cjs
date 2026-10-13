/**
 * CLI-2 · DX OS agent CLI 桥（移植自 DX OS 0.5.1 server/agentCliTools.ts，918 行）。
 *
 * 源：<DX OS.app>/Contents/Resources/app.asar.unpacked/server/agentCliTools.ts
 *     <DX OS.app>/Contents/Resources/app.asar.unpacked/server/geminiCliProtocol.ts（仅 parseAntigravityModels）
 *
 * 为什么做成可注入的桥：源实现直接 spawn 本机 CLI、读写 ~/.codex 与 <DX DATA>/cli-output、
 * 并通过 fetch 访问 Antigravity Tools。OpenArc 主进程要求依赖探测与执行可离线复现，
 * 因此统一由 configureAgentCliBridge({ spawnImpl, whichImpl, dataDir, clock }) 注入 seam：
 *   - 未安装 → { ok:false, error:"CLI_UNAVAILABLE", detail }，绝不假成功；
 *   - 生产默认值取自 node:child_process / node:fs / process.env，测试可全部替换。
 *
 * 移植约定：
 *   - 函数名 / 参数 / 输出字段与源逐字对应（TS 类型注解在 CJS 中移除）。
 *   - 源的 apiQuota / 云计费链路在本文件完全没有出现，因此本端口不引入任何计费/配额写入；
 *     唯一与 "quota" 有关的字符串是源 geminiImageError 的限流文案匹配，按原文保留。
 *   - 端口新增项（源没有的）一律在注释中标注「端口新增」。
 *
 * 移除项（明确 OUT，绝不向 api.dx-os.com 发请求）：
 *   1. agentCliDownloadInfo 的 api.dx-os.com 云端下载端点（源 agentCliTools.ts 的 agentCliDownloadInfo；
 *      本端口副本原 electron/agent-cli-bridge.cjs:352-374）：原实现以
 *      String(deps.env.DX_SOFTWARE_API_URL || "https://api.dx-os.com") 为默认基址，并 GET
 *      /v1/software/com.dxos.cli.<tool>/latest?platform=... 拉取安装包信息。B2 任务明确排除
 *      「一切 api.dx-os.com 调用」，云分发属 OUT，本地模式无对端。改后：不再读取
 *      DX_SOFTWARE_API_URL、不再构造 /v1/software/... 端点、不再调用 fetch，恒返回
 *      { ok:false, error:"AGENT_DEPENDENCY_UNAVAILABLE", detail:"下载端点属云分发（OUT）：本地模式无对端" }。
 */
"use strict";

const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn: nodeSpawn } = require("node:child_process");

const CLI_UNAVAILABLE = "CLI_UNAVAILABLE";

const CODEX_MODELS = ["gpt-5.5"];
const CODEX_IMAGE_MODELS = ["gpt-image-2"];
const CODEX_MODEL_CACHE_MS = 60 * 1000;
const CODEX_MODEL_FALLBACK_CACHE_MS = 30 * 1000;
const GEMINI_IMAGE_MODELS = ["gemini-3.1-flash-image"];
const GEMINI_MODEL_CACHE_MS = 10 * 60 * 1000;
const GEMINI_MODEL_FALLBACK_CACHE_MS = 30 * 1000;
const ANTIGRAVITY_TOOLS_BASE_URL = "http://127.0.0.1:8045";

/** 源 findOnPath 的生产实现；测试一律用 whichImpl 覆盖（端口新增，便于离线）。 */
function defaultWhich(command) {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];
  for (const folder of String(process.env.PATH || "").split(process.platform === "win32" ? ";" : ":")) {
    if (!folder) continue;
    for (const extension of extensions) {
      const candidate = path.join(folder, path.extname(command) ? command : command + extension);
      if (nodeFs.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function defaultDataDir() {
  const platformRoot = process.env.LOCALAPPDATA || process.env.APPDATA;
  return path.join(platformRoot || os.homedir(), "DX OS", "data");
}

function createDeps(options = {}) {
  const fsImpl = {
    existsSync: nodeFs.existsSync,
    readFileSync: nodeFs.readFileSync,
    mkdirSync: nodeFs.mkdirSync,
    unlinkSync: nodeFs.unlinkSync,
    writeFileSync: nodeFs.writeFileSync,
    statSync: nodeFs.statSync,
    readdirSync: nodeFs.readdirSync,
    copyFileSync: nodeFs.copyFileSync,
    ...(options.fsImpl || {}),
  };
  return {
    spawnImpl: options.spawnImpl || nodeSpawn,
    whichImpl: options.whichImpl || defaultWhich,
    dataDir: options.dataDir || defaultDataDir(),
    clock: options.clock || (() => Date.now()),
    env: options.env || process.env,
    platform: options.platform || process.platform,
    arch: options.arch || process.arch,
    homedirImpl: options.homedirImpl || os.homedir,
    workspace: options.workspace || path.resolve(__dirname, ".."),
    fetchImpl: options.fetchImpl || globalThis.fetch,
    sharpLoader: options.sharpLoader || (() => import("sharp")),
    fs: fsImpl,
  };
}

let deps = createDeps({});
let geminiModelCache = null;
let codexModelCache = null;
const loginSessions = {
  codex: { proc: null, stdout: "", stderr: "", started_at: 0 },
  gemini: { proc: null, stdout: "", stderr: "", started_at: 0 },
};

function now() { return deps.clock(); }

/**
 * 依赖探测与执行 seam。四个键与 CLI-1 契约一致；其余键为端口新增的可选离线开关。
 * @param {{ spawnImpl?: Function, whichImpl?: Function, dataDir?: string, clock?: Function, env?: object, platform?: string, arch?: string, homedirImpl?: Function, workspace?: string, fetchImpl?: Function, sharpLoader?: Function, fsImpl?: object }} options
 */
function configureAgentCliBridge(options = {}) {
  if (options.spawnImpl !== undefined && typeof options.spawnImpl !== "function") throw new TypeError("spawnImpl 必须是函数");
  if (options.whichImpl !== undefined && typeof options.whichImpl !== "function") throw new TypeError("whichImpl 必须是函数");
  if (options.dataDir !== undefined && (typeof options.dataDir !== "string" || !options.dataDir)) throw new TypeError("dataDir 必须是非空字符串");
  if (options.clock !== undefined && typeof options.clock !== "function") throw new TypeError("clock 必须是函数");
  deps = createDeps(options);
  return getAgentCliBridgeConfig();
}

/** 端口新增：返回当前生效 seam 的非敏感摘要（不含 env 值）。 */
function getAgentCliBridgeConfig() {
  return { dataDir: deps.dataDir, platform: deps.platform, workspace: deps.workspace, spawnInjected: deps.spawnImpl !== nodeSpawn, whichInjected: deps.whichImpl !== defaultWhich };
}

/** 端口新增：测试复位缓存 / 登录会话 / seam。 */
function resetAgentCliBridgeForTests() {
  geminiModelCache = null;
  codexModelCache = null;
  loginSessions.codex = { proc: null, stdout: "", stderr: "", started_at: 0 };
  loginSessions.gemini = { proc: null, stdout: "", stderr: "", started_at: 0 };
  deps = createDeps({});
}

function envValue(...keys) {
  for (const key of keys) {
    const value = String(deps.env[key] || "").trim().replace(/^"|"$/g, "");
    if (value) return value;
  }
  return "";
}

function existsSync(target) { return deps.fs.existsSync(target); }
function homedir() { return deps.homedirImpl(); }
function findOnPath(command) { return deps.whichImpl(command); }

function codexOutputDir() { return path.join(deps.dataDir, "cli-output", "openai"); }
function geminiOutputDir() { return path.join(deps.dataDir, "cli-output", "gemini"); }

function antigravityCandidate() {
  if (deps.platform !== "win32") return findOnPath("agy");
  const root = path.join(deps.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  try {
    const folder = deps.fs.readdirSync(root).filter((name) => /^Google\.AntigravityCLI_/i.test(name)).sort().reverse()[0];
    const candidate = folder ? path.join(root, folder, "agy.exe") : "";
    return candidate && existsSync(candidate) ? candidate : "";
  } catch { return ""; }
}

function antigravityToolsCandidate() {
  const configured = envValue("ANTIGRAVITY_TOOLS_BIN");
  if (configured && existsSync(configured)) return configured;
  if (deps.platform !== "win32") return findOnPath("antigravity-tools");
  const roots = [...new Set([
    path.parse(deps.workspace).root,
    deps.env.SystemDrive ? `${deps.env.SystemDrive}\\` : "",
  ].filter(Boolean))];
  const candidates = [
    ...roots.map((root) => path.join(root, "Program Files", "Antigravity Tools", "antigravity-tools.exe")),
    path.join(deps.env.ProgramFiles || "", "Antigravity Tools", "antigravity-tools.exe"),
    path.join(deps.env.LOCALAPPDATA || "", "Programs", "Antigravity Tools", "antigravity-tools.exe"),
  ];
  const wingetRoot = path.join(deps.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  try {
    for (const folder of deps.fs.readdirSync(wingetRoot).filter((name) => /^lbjlaq\.AntigravityTools_/i.test(name)).sort().reverse()) {
      candidates.push(path.join(wingetRoot, folder, "antigravity-tools.exe"));
    }
  } catch { /* WinGet is optional */ }
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

async function antigravityToolsHealthy(timeoutMs = 1500) {
  try {
    const response = await deps.fetchImpl(`${ANTIGRAVITY_TOOLS_BASE_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

async function ensureAntigravityTools() {
  if (await antigravityToolsHealthy()) return { ready: true, started: false };
  const command = antigravityToolsCandidate();
  if (!command) throw new Error("Antigravity Tools 未运行，且未找到 antigravity-tools.exe；请安装 Tools 或设置 ANTIGRAVITY_TOOLS_BIN。");
  try {
    const child = deps.spawnImpl(command, [], { detached: true, windowsHide: true, stdio: "ignore" });
    child.unref();
  } catch (error) {
    throw new Error(`Antigravity Tools 启动失败：${String((error && error.message) || error)}`);
  }
  const deadline = now() + 10_000;
  while (now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await antigravityToolsHealthy()) return { ready: true, started: true };
  }
  throw new Error("Antigravity Tools 启动后 10 秒内未通过 /health 检查，请确认 8045 端口未被占用。");
}

function codexCandidate() {
  if (deps.platform !== "win32") return findOnPath("codex");
  const candidate = path.join(deps.env.LOCALAPPDATA || "", "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  return candidate && existsSync(candidate) ? candidate : "";
}

function npmJsRuntime(executable, tool) {
  if (!/\.(cmd|ps1)$/i.test(executable)) return null;
  const base = path.dirname(executable);
  const script = tool === "gemini"
    ? path.join(base, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js")
    : path.join(base, "node_modules", "gpt-image-2-skill", "bin", "gpt-image-2-skill.js");
  const node = findOnPath("node");
  if (!node || !existsSync(script)) return null;
  const home = path.join(homedir(), tool === "gemini" ? ".gemini" : ".codex");
  return { command: node, argsPrefix: [script], path: executable, label: "本机 Google Gemini CLI", provider: "gemini", detail: "使用本机安装的 Gemini CLI 与当前 Windows 用户登录态。", mode: "host", home, env: {} };
}

function localGeminiRuntime() {
  const gemini = envValue("GEMINI_BIN") || findOnPath("gemini");
  if (!gemini) return null;
  return npmJsRuntime(gemini, "gemini") || { command: gemini, argsPrefix: [], path: gemini, label: "本机 Google Gemini CLI", provider: "gemini", detail: "使用本机安装的 Gemini CLI 与当前用户登录态。", mode: "host", home: path.join(homedir(), ".gemini"), env: {} };
}

/** 逐字对应源 runtime(tool)：未检测到返回 null（调用方不得据此假成功）。 */
function runtime(tool) {
  if (tool === "codex") {
    const cliPath = envValue("CODEX_BIN") || findOnPath("codex") || codexCandidate();
    return cliPath ? { command: cliPath, argsPrefix: [], path: cliPath, label: "本机 OpenAI Codex CLI", provider: "codex", detail: "使用本机安装的 Codex CLI 与本机登录态；GPT Image 2 Skill 由 DX OS 内置。", mode: "host", home: path.join(homedir(), ".codex"), env: {} } : null;
  }
  const configuredAgy = envValue("ANTIGRAVITY_BIN", "AGY_BIN");
  if (configuredAgy) return { command: configuredAgy, argsPrefix: [], path: configuredAgy, label: "本机 Google Antigravity CLI", provider: "antigravity", detail: "使用本机安装的 Antigravity CLI 与当前 Windows 用户登录态。", mode: "host", home: path.join(homedir(), ".gemini"), env: {} };
  if (envValue("GEMINI_BIN")) return localGeminiRuntime();
  const agy = findOnPath("agy") || antigravityCandidate();
  if (agy) return { command: agy, argsPrefix: [], path: agy, label: "本机 Google Antigravity CLI", provider: "antigravity", detail: "使用本机安装的 Antigravity CLI 与当前 Windows 用户登录态。", mode: "host", home: path.join(homedir(), ".gemini"), env: {} };
  return localGeminiRuntime();
}

/** 端口新增：依赖探测出口。未安装一律 { ok:false, error:"CLI_UNAVAILABLE", detail }。 */
function agentCliRuntime(tool) { return runtime(tool); }

function publicRuntime(rt) {
  return { command: rt.command, argsPrefix: [...rt.argsPrefix], path: rt.path, label: rt.label, provider: rt.provider, detail: rt.detail, mode: rt.mode, home: rt.home };
}

/** 依赖探测出口，与 CLI-1 probeJimengCli 同契约：未安装 → { ok:false, installed:false, error:"CLI_UNAVAILABLE", detail }。 */
function probeAgentCliDependency(tool) {
  const rt = runtime(tool);
  if (!rt) {
    const name = tool === "codex" ? "OpenAI Codex" : "Gemini / Antigravity";
    return { ok: false, installed: false, error: CLI_UNAVAILABLE, detail: `未找到 ${name} CLI（已探测 PATH / CODEX_BIN / ANTIGRAVITY_BIN / AGY_BIN / GEMINI_BIN）。` };
  }
  return { ok: true, installed: true, tool, runtime: publicRuntime(rt) };
}

/** 与 CLI-1 isCliUnavailable 同契约。 */
function isCliUnavailable(value) {
  return !!value && typeof value === "object" && value.error === CLI_UNAVAILABLE;
}

const ABORT_ERR = "ABORT_ERR";

/**
 * 源 agentCliTools.ts:208-224 run(rt, args, timeoutMs, input)；options.signal 为端口新增的取消开关。
 * 超时 / 取消都会先 kill 子进程，再以错误 reject，绝不把超时当成功。
 */
function run(rt, args, timeoutMs = 30000, input = "", options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = deps.spawnImpl(rt.command, [...rt.argsPrefix, ...args], { cwd: deps.workspace, windowsHide: true, env: { ...deps.env, ...rt.env } });
    } catch (error) { reject(error); return; }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const signal = options.signal || null;
    const onAbort = signal ? () => {
      try { child.kill(); } catch { /* already stopped */ }
      const error = new Error(`${rt.label} 调用已取消`);
      error.code = ABORT_ERR;
      finish(reject, error);
    } : null;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    };
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already stopped */ }
      finish(reject, new Error(`${rt.label} 执行超时`));
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => finish(resolve, { stdout: Buffer.concat(stdout).toString("utf8").trim(), stderr: Buffer.concat(stderr).toString("utf8").trim(), code: code == null ? -1 : code }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

/** 移植自 geminiCliProtocol.ts:3-23，逐字保留判定与正则。 */
function parseAntigravityModels(result) {
  const stdout = String(result.stdout || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const output = `${stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    const authRequired = /please sign in to view available models|not authenticated|authentication required/i.test(output);
    return { models: [], loggedIn: authRequired ? false : null, reason: authRequired ? "CLI 要求先登录，请在官方 CLI 中完成登录后刷新模型。" : "CLI 模型查询失败；不能据此判断登录状态。" };
  }
  let models = [];
  try {
    const payload = JSON.parse(stdout);
    const items = Array.isArray(payload) ? payload : payload?.models || payload?.data || [];
    if (Array.isArray(items)) models = items.map((item) => typeof item === "string" ? item : item?.id || item?.model || "").filter((model) => typeof model === "string" && /^[\w][\w.:-]*$/.test(model));
  } catch {
    models = stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(?:[│|*\-]\s*)?((?:gemini|claude|gpt)-[\w.:-]+)(?=\s|[│|]|$)/i);
      return match ? [match[1]] : [];
    });
  }
  models = [...new Set(models)];
  return { models, loggedIn: models.length ? true : null, reason: models.length ? "" : "CLI 未返回可识别的模型列表，登录状态执行时校验。" };
}

function sessionPayload(tool, loggedIn = false) {
  const session = loginSessions[tool];
  const text = [session.stdout, session.stderr].filter(Boolean).join("\n").replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "").trim();
  return { success: true, running: !!session.proc && session.proc.exitCode == null && !loggedIn, logged_in: loggedIn, text, login_url: "", verification_uri: "", user_code: "", started_at: session.started_at };
}

function codexAuthValue(authPath) {
  try {
    const value = JSON.parse(deps.fs.readFileSync(authPath, "utf8"));
    const apiKey = typeof value.OPENAI_API_KEY === "string" ? value.OPENAI_API_KEY.trim() : "";
    const tokens = value.tokens && typeof value.tokens === "object" ? value.tokens : {};
    const codexToken = [tokens.access_token, tokens.id_token].some((token) => typeof token === "string" && token.trim());
    return { apiKey, providerReady: !!apiKey || codexToken };
  } catch {
    return { apiKey: "", providerReady: false };
  }
}

/** 源注释：Build the helper environment without ever putting credentials in argv or logs. */
function codexImageAuthEnv(authPath = path.join(homedir(), ".codex", "auth.json")) {
  if (String(deps.env.OPENAI_API_KEY || "").trim()) return {};
  const { apiKey } = codexAuthValue(authPath);
  return apiKey ? { OPENAI_API_KEY: apiKey } : {};
}

function agentCliInstalled(tool) { return !!runtime(tool); }

/**
 * 移除项（见文件头）：源 agentCliTools.ts 的 agentCliDownloadInfo 走 api.dx-os.com 云分发，
 * 本端口副本原 :352-374 硬编码默认基址并 GET /v1/software/...。该云分发属 OUT，本地模式无对端；
 * 参数与异步契约保持不变，恒返回结构化错误，绝不调用 fetch。
 */
async function agentCliDownloadInfo(tool) {
  return { ok: false, error: "AGENT_DEPENDENCY_UNAVAILABLE", detail: "下载端点属云分发（OUT）：本地模式无对端" };
}

async function agentCliStatus(tool) {
  const rt = runtime(tool);
  if (!rt) return { installed: false, logged_in: false, login_verified_by: "", message: `未找到${tool === "codex" ? " OpenAI Codex" : " Gemini / Antigravity"} CLI` };
  let version = "";
  try {
    const result = await run(rt, ["--version"], 10000);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `exit=${result.code}`);
    version = result.stdout || result.stderr;
  } catch (error) {
    return { installed: false, logged_in: false, login_verified_by: "", runtime: { ...publicRuntime(rt), login_mode: "host" }, message: `${rt.label} 检测失败：${String((error && error.message) || error)}` };
  }
  return agentCliStatusWithRuntime(tool, rt, version);
}

async function agentCliStatusWithRuntime(tool, rt, knownVersion = "") {
  let version = knownVersion;
  if (!version) {
    const result = await run(rt, ["--version"], 10000);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `exit=${result.code}`);
    version = result.stdout || result.stderr;
  }
  let loggedIn = false;
  let loginMessage = "";
  let verifiedBy = "";
  let apiKeyReady = false;
  if (tool === "codex") {
    const status = await run(rt, ["login", "status"], 15000);
    loggedIn = status.code === 0 && /logged in|登录/i.test(`${status.stdout}\n${status.stderr}`);
    apiKeyReady = !!String(deps.env.OPENAI_API_KEY || "").trim() || !!codexAuthValue(path.join(rt.home, "auth.json")).apiKey;
    loginMessage = !loggedIn && apiKeyReady
      ? "Codex CLI 尚未登录；已检测到 OpenAI API Key，可供支持 API Key 的调用链使用。"
      : status.stdout || status.stderr;
    verifiedBy = loggedIn ? "cli" : "";
  } else {
    const cached = geminiModelCache?.key === geminiRuntimeKey(rt) && geminiModelCache.expiresAt > now() ? geminiModelCache : null;
    loggedIn = cached?.loggedIn ?? null;
    loginMessage = loggedIn === true ? "CLI 原生模型查询成功，登录状态已验证。" : loggedIn === false
      ? "CLI 要求先登录，请在官方 CLI 中完成登录后刷新模型。"
      : `${rt.label} 已安装；登录状态执行时校验，不依赖 Antigravity Tools 账号缓存或代理服务。`;
    verifiedBy = loggedIn === null ? "deferred" : "cli-models";
  }
  const helper = tool === "codex" ? gptImageHelperRuntime() : null;
  const imageAuthFile = tool === "codex" ? gptImageAuthFile() : "";
  const imageAuth = tool === "codex" ? codexAuthValue(imageAuthFile).providerReady || !!String(deps.env.OPENAI_API_KEY || "").trim() : false;
  const imageProvider = tool === "codex" && helper ? gptImageAuth(imageAuthFile).provider : undefined;
  return {
    installed: true,
    logged_in: loggedIn,
    cli_version: version.match(/\d+(?:\.\d+)+/)?.[0] || version,
    message: tool === "codex"
      ? `OpenAI Codex CLI 已安装。${helper ? "GPT Image 2 helper 已安装，OpenAI CLI 生图会使用 GPT Image 2。" : "未找到 GPT Image 2 helper，OpenAI CLI 生图不可用。"} 登录状态会在首次执行 codex exec 时由 CLI 校验。`
      : loginMessage,
    login_verified_by: verifiedBy,
    ...(tool === "codex" ? { api_key_available: apiKeyReady } : {}),
    image2_helper_installed: !!helper,
    image2_helper_authenticated: !!helper && imageAuth,
    ...(imageProvider ? { image2_provider: imageProvider } : {}),
    ...(helper ? { image2_helper_path: helper.path, image2_auth_file: imageAuthFile } : {}),
    runtime: { label: rt.label, path: rt.path, mode: rt.mode, detail: rt.detail, home: rt.home, login_mode: "host", provider: rt.provider },
  };
}

async function agentCliLoginStart(tool) {
  if (tool === "gemini") geminiModelCache = null;
  const rt = runtime(tool);
  if (!rt) throw new Error(`未找到 ${tool} CLI`);
  const session = loginSessions[tool];
  if (session.proc && session.proc.exitCode == null) session.proc.kill();
  session.proc = null; session.stdout = ""; session.stderr = ""; session.started_at = now();
  if (deps.platform !== "win32") throw new Error("当前版本请先在系统终端中运行 CLI 完成登录");
  const cliArgs = tool === "codex" ? [...rt.argsPrefix, "login"] : rt.argsPrefix;
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  const command = `& ${quote(rt.command)}${cliArgs.map((arg) => ` ${quote(arg)}`).join("")}`;
  const proc = deps.spawnImpl("powershell.exe", ["-NoExit", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: deps.workspace, detached: true, windowsHide: false, stdio: "ignore", env: { ...deps.env, ...rt.env },
  });
  proc.unref();
  session.proc = proc;
  session.stdout = `已打开系统终端，请在终端中完成 ${tool === "codex" ? "Codex" : "Gemini"} 登录和首次初始化。`;
  return { ...sessionPayload(tool), running: true, terminal_opened: true };
}

async function agentCliLoginStatus(tool) {
  const status = await agentCliStatus(tool);
  const loggedIn = status.logged_in === true;
  const session = loginSessions[tool];
  if (loggedIn && session.proc && session.proc.exitCode == null) session.proc.kill();
  return { ...sessionPayload(tool, loggedIn), logged_in: status.logged_in, raw: status, login_verified_by: status.login_verified_by, running: !loggedIn && !!session.proc && session.proc.exitCode == null };
}

async function agentCliLogout(tool) {
  const session = loginSessions[tool];
  if (session.proc && session.proc.exitCode == null) {
    try { session.proc.kill(); } catch { /* already stopped */ }
  }
  const rt = runtime(tool);
  if (!rt) throw new Error(`未找到 ${tool} CLI`);
  if (tool === "codex") {
    const result = await run(rt, ["logout"], 30000);
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "退出登录失败");
    return { success: true, raw: result };
  }
  return { success: false, manual: true, message: "Gemini / Antigravity CLI 没有统一的安全退出命令，请在已打开的官方 CLI 中执行 /auth 或账户退出。" };
}

async function agentCliHelp(tool, command = "") {
  const rt = runtime(tool);
  if (!rt) throw new Error(`未找到 ${tool} CLI`);
  const allowed = tool === "codex" ? new Set(["", "exec", "login", "logout", "doctor", "mcp", "plugin", "app", "update"]) : new Set(["", "mcp", "extensions", "skills", "hooks"]);
  const value = String(command || "").trim();
  if (!allowed.has(value)) throw new Error("不支持的帮助命令");
  const result = await run(rt, [...(value ? [value] : []), "--help"], 20000);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `exit=${result.code}`);
  return { success: true, command: value, text: result.stdout || result.stderr, raw: result };
}

function isGeminiImageModel(model) {
  return /(?:^|[-_.])image(?:$|[-_.])/i.test(model);
}

function defaultGeminiCatalog(error = "", models = ["auto"]) {
  const model_items = models.map((model) => {
    const type = isGeminiImageModel(model) ? "image" : "llm";
    return { model, type, available: true, canonical_model: model, aliases: [], verified_by: "cli-default", caps: [type] };
  });
  return {
    models,
    image_models: model_items.filter((item) => item.type === "image").map((item) => item.model),
    chat_models: model_items.filter((item) => item.type === "llm").map((item) => item.model),
    model_items,
    count: models.length,
    source: "cli-defaults",
    cached: false,
    excluded_items: error ? [{ model: "*", reason: `动态模型发现失败：${error}` }] : [],
    ts: now(),
  };
}

function stringList(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value])
    .map((item) => typeof item === "string" ? item : item && typeof item === "object"
      ? String(item.id || item.name || item.value || item.reasoningEffort || item.reasoning_effort || "") : String(item))
    .map((item) => item.trim()).filter(Boolean);
}

function codexModelItem(raw) {
  if (!raw || typeof raw !== "object" || raw.hidden === true || raw.isHidden === true || raw.visibility === "hidden") return null;
  const model = String(raw.id || raw.model || raw.slug || "").trim();
  if (!model) return null;
  const upgrade = raw.upgradeTo || raw.upgrade_to || raw.upgrade;
  return {
    model,
    ...(String(raw.displayName || raw.display_name || raw.name || "").trim() ? { name: String(raw.displayName || raw.display_name || raw.name).trim() } : {}),
    type: "llm", caps: ["llm"],
    ...(stringList(raw.inputModalities || raw.input_modalities || raw.supportedInputModalities).length
      ? { input_modalities: stringList(raw.inputModalities || raw.input_modalities || raw.supportedInputModalities) } : {}),
    ...(stringList(raw.supportedReasoningEfforts || raw.reasoningLevels || raw.reasoning_levels).length
      ? { reasoning_levels: stringList(raw.supportedReasoningEfforts || raw.reasoningLevels || raw.reasoning_levels) } : {}),
    ...(String(raw.defaultReasoningEffort || raw.default_reasoning_level || "").trim()
      ? { default_reasoning_level: String(raw.defaultReasoningEffort || raw.default_reasoning_level).trim() } : {}),
    ...(raw.isDefault === true || raw.is_default === true ? { is_default: true } : {}),
    ...(upgrade ? { upgrade_to: typeof upgrade === "string" ? upgrade : String(upgrade.id || upgrade.model || "") } : {}),
  };
}

function modelPage(payload) {
  const result = payload?.result || payload;
  const raw = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : Array.isArray(result?.items) ? result.items : [];
  return { items: raw.map(codexModelItem).filter((item) => !!item), nextCursor: String(result?.nextCursor || result?.next_cursor || "") };
}

/** 源注释：Query the currently installed Codex service instead of shipping a stale model list. */
function codexAppServerModels(rt) {
  return new Promise((resolve, reject) => {
    const child = deps.spawnImpl(rt.command, [...rt.argsPrefix, "app-server"], { cwd: deps.workspace, windowsHide: true, env: { ...deps.env, ...rt.env } });
    let buffer = "";
    let settled = false;
    let initialized = false;
    let requestId = 1;
    let pages = 0;
    const items = new Map();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already closed */ }
      try { child.kill(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve([...items.values()].slice(0, 500));
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const list = (cursor = "") => {
      if (++pages > 20 || items.size >= 500) return finish();
      requestId += 1;
      send({ method: "model/list", id: requestId, params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
    };
    const timer = setTimeout(() => finish(new Error("Codex app-server 模型查询超时")), 10_000);
    child.stdout.on("data", (chunk) => {
      buffer += Buffer.from(chunk).toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && !initialized) {
          if (message.error) return finish(new Error(String(message.error.message || "Codex app-server 初始化失败")));
          initialized = true;
          send({ method: "initialized", params: {} });
          list();
          continue;
        }
        if (initialized && message.id === requestId) {
          if (message.error) return finish(new Error(String(message.error.message || "Codex app-server 模型查询失败")));
          const page = modelPage(message);
          for (const item of page.items) if (items.size < 500) items.set(item.model, item);
          if (page.nextCursor && items.size < 500) list(page.nextCursor);
          else finish(items.size ? undefined : new Error("Codex app-server 没有返回可见模型"));
        }
      }
    });
    child.stderr.on("data", () => { /* Never expose service diagnostics that may contain local paths. */ });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => { if (!settled) finish(new Error(`Codex app-server 提前退出（${code == null ? -1 : code}）`)); });
    send({ method: "initialize", id: 1, params: { clientInfo: { name: "dx-os", version: "0.3.3" }, capabilities: {} } });
  });
}

function cachedCodexModels(rt) {
  const payload = JSON.parse(deps.fs.readFileSync(path.join(rt.home, "models_cache.json"), "utf8"));
  const page = modelPage(payload);
  if (!page.items.length) throw new Error("Codex models_cache.json 没有可用模型");
  return page.items.slice(0, 500);
}

async function codexImageModels() {
  const rt = gptImageHelperRuntime();
  if (!rt) throw new Error("未找到 GPT Image 2 helper");
  const authPath = gptImageAuthFile();
  const auth = gptImageAuth(authPath);
  const result = await run({ ...rt, env: { ...rt.env, ...auth.env } }, ["--json", ...auth.args, "models", "list"], 10_000);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `exit=${result.code}`).slice(0, 500));
  const payload = JSON.parse(result.stdout);
  const providers = payload?.providers || payload?.data?.providers || {};
  const provider = providers.codex || providers[auth.provider];
  if (!provider) throw new Error(`图片 helper 未返回 providers.${auth.provider}`);
  const tool = provider.image_generation_tool || provider.imageGenerationTool || {};
  const models = [...new Set([
    ...stringList(tool.delegated_model), ...stringList(tool.delegated_models), ...stringList(provider.image_models),
  ])].filter((model) => /^gpt-image-/i.test(model));
  const rawOperations = stringList(tool.operations || provider.operations).map((operation) => operation.toLowerCase());
  const operations = [];
  if (rawOperations.some((operation) => operation === "generate" || operation === "image.generate")) operations.push("image.generate");
  if (rawOperations.some((operation) => operation === "edit" || operation === "image.edit")) operations.push("image.edit");
  if (!models.length) throw new Error("图片 helper 没有返回图片模型");
  if (!operations.length) throw new Error("图片 helper 没有声明 generate/edit 操作");
  return { models, operations };
}

async function dynamicCodexCatalog() {
  if (codexModelCache && codexModelCache.expiresAt > now()) return { ...codexModelCache.value, cached: true };
  const rt = runtime("codex");
  const excluded_items = [];
  const [liveModels, liveImages] = await Promise.allSettled([
    rt ? codexAppServerModels(rt) : Promise.reject(new Error("未找到 Codex CLI")),
    codexImageModels(),
  ]);
  let chatItems;
  let source = "codex-app-server";
  if (liveModels.status === "fulfilled") chatItems = liveModels.value;
  else {
    excluded_items.push({ model: "*", reason: `Codex 实时目录失败：${String(liveModels.reason?.message || liveModels.reason)}` });
    try {
      if (!rt) throw new Error("未找到 Codex CLI");
      chatItems = cachedCodexModels(rt);
      source = "codex-models-cache";
    } catch (error) {
      chatItems = CODEX_MODELS.map((model, index) => ({ model, type: "llm", caps: ["llm"], ...(index === 0 ? { is_default: true } : {}) }));
      source = "cli-defaults";
      excluded_items.push({ model: "*", reason: `Codex 本地目录失败：${String((error && error.message) || error)}` });
    }
  }
  let imageModels;
  let imageOperations;
  let image_source = "codex-image-helper";
  if (liveImages.status === "fulfilled") {
    imageModels = liveImages.value.models;
    imageOperations = liveImages.value.operations;
  } else {
    imageModels = [...CODEX_IMAGE_MODELS];
    imageOperations = ["image.generate", "image.edit"];
    image_source = "cli-defaults";
    excluded_items.push({ model: "*", reason: `图片实时目录失败：${String(liveImages.reason?.message || liveImages.reason)}` });
  }
  const imageItems = imageModels.map((model) => ({ model, type: "image", caps: ["image"], intents: imageOperations }));
  const model_items = [...chatItems, ...imageItems].filter((item, index, all) => all.findIndex((candidate) => candidate.model === item.model) === index);
  const chat_models = chatItems.map((item) => item.model);
  const models = model_items.map((item) => item.model);
  const catalog = {
    models, chat_models, image_models: imageModels, model_items, count: models.length,
    default_model: chatItems.find((item) => item.is_default)?.model || chat_models[0] || CODEX_MODELS[0],
    source, image_source, image_operations: imageOperations,
    cached: false, excluded_items, ts: now(),
  };
  const live = source === "codex-app-server" && image_source === "codex-image-helper";
  codexModelCache = { value: catalog, expiresAt: now() + (live ? CODEX_MODEL_CACHE_MS : CODEX_MODEL_FALLBACK_CACHE_MS) };
  return catalog;
}

function geminiRuntimeKey(rt) {
  return JSON.stringify([rt.provider, rt.command, rt.argsPrefix, rt.home]);
}

async function agentCliModels(tool) {
  if (tool === "codex") return dynamicCodexCatalog();
  const rt = runtime(tool);
  if (!rt) return defaultGeminiCatalog("未找到 Gemini / Antigravity CLI");
  const key = geminiRuntimeKey(rt);
  if (geminiModelCache?.key === key && geminiModelCache.expiresAt > now()) return { ...geminiModelCache.value, cached: true };
  if (rt.provider !== "antigravity") return defaultGeminiCatalog("Google Gemini CLI 不提供统一的原生模型列表命令；使用自动模型。");
  try {
    const native = parseAntigravityModels(await run(rt, ["models"], 30000));
    const catalog = defaultGeminiCatalog(native.reason, native.models.length ? ["auto", ...native.models.filter((model) => model !== "auto")] : ["auto"]);
    if (native.models.length) {
      catalog.source = "cli-models";
      catalog.model_items.forEach((item) => { item.verified_by = "cli-models"; });
    }
    geminiModelCache = { key, value: catalog, loggedIn: native.loggedIn, expiresAt: now() + (native.models.length ? GEMINI_MODEL_CACHE_MS : GEMINI_MODEL_FALLBACK_CACHE_MS) };
    return catalog;
  } catch (error) {
    const catalog = defaultGeminiCatalog(String((error && error.message) || error));
    geminiModelCache = { key, value: catalog, loggedIn: null, expiresAt: now() + GEMINI_MODEL_FALLBACK_CACHE_MS };
    return catalog;
  }
}

async function agentCliDefaultModel(tool) {
  const catalog = await agentCliModels(tool);
  return String("default_model" in catalog ? catalog.default_model || catalog.chat_models[0] || "" : catalog.chat_models[0] || "");
}

/** 源 agentCliTools.ts:624-668 runAgentCliChat。 */
async function runAgentCliChat(tool, prompt, model = "", timeoutMs = 900000, options = {}) {
  let rt = runtime(tool);
  if (!rt) throw new Error(`未找到 ${tool} CLI`);
  const started = now();
  let result;
  if (tool === "codex") {
    rt = { ...rt, env: { ...rt.env, ...codexImageAuthEnv(path.join(rt.home, "auth.json")) } };
    deps.fs.mkdirSync(codexOutputDir(), { recursive: true });
    const lastMessagePath = path.join(codexOutputDir(), `codex-last-${now()}-${process.pid}.txt`);
    const args = ["exec", "-C", deps.workspace, "--sandbox", options.allowTools ? "workspace-write" : "read-only", "--skip-git-repo-check"];
    if (model && !/^gpt-image/i.test(model)) args.push("--model", model);
    for (const imagePath of (options.imagePaths || []).filter((value) => existsSync(value))) args.push("--image", imagePath);
    args.push("--output-last-message", lastMessagePath, "-");
    try {
      result = await run(rt, args, timeoutMs, String(prompt || ""), options);
      if (result.code === 0 && existsSync(lastMessagePath)) {
        const lastMessage = deps.fs.readFileSync(lastMessagePath, "utf8").replace(/^\uFEFF/, "").trim();
        if (lastMessage) result.stdout = lastMessage;
      }
    } finally {
      try { deps.fs.unlinkSync(lastMessagePath); } catch { /* best-effort temporary output cleanup */ }
    }
  } else if (rt.provider === "antigravity") {
    const args = ["--print-timeout", `${Math.ceil(timeoutMs / 1000)}s`];
    if (model && model !== "auto") args.push("--model", model);
    if (options.allowTools) args.push("--dangerously-skip-permissions");
    const imageNote = (options.imagePaths || []).length ? `\n\n可参考的本地图片路径：\n${options.imagePaths.join("\n")}` : "";
    args.push("-p", `${String(prompt || "")}${imageNote}`);
    result = await run(rt, args, timeoutMs, "", options);
  } else {
    const args = ["--output-format", "json", "--skip-trust"];
    if (model && model !== "auto") args.push("--model", model);
    if (options.allowTools) args.push("--approval-mode", "yolo");
    const imageNote = (options.imagePaths || []).length ? `\n\n可参考的本地图片路径：\n${options.imagePaths.join("\n")}` : "";
    args.push("--prompt", `${String(prompt || "")}${imageNote}`);
    result = await run(rt, args, timeoutMs, "", options);
  }
  if (result.code !== 0) throw new Error(`${rt.label} 调用失败：${(result.stderr || result.stdout || `exit=${result.code}`).slice(0, 1600)}`);
  let text = result.stdout;
  try {
    const raw = JSON.parse(result.stdout);
    text = String(raw.response || raw.text || raw.content || raw.message || result.stdout);
  } catch { /* plain text */ }
  return { text: text.trim(), latencyMs: now() - started, raw: result };
}

function gptImageHelperRuntime() {
  const bundled = deps.platform === "win32" && deps.arch === "x64" ? path.join(__dirname, "cli-runtime", "openai", "bin", "gpt-image-2-skill.exe") : "";
  const helperPath = (bundled && existsSync(bundled) ? bundled : "") || envValue("GPT_IMAGE_2_SKILL_BIN") || findOnPath("gpt-image-2-skill");
  if (!helperPath) return null;
  return npmJsRuntime(helperPath, "gpt-image-2-skill") || {
    command: helperPath,
    argsPrefix: [],
    path: helperPath,
    label: "GPT Image 2 Skill",
    provider: "codex",
    detail: "DX OS 内置 GPT Image 2 Skill helper，复用本机 Codex 登录态。",
    mode: bundled && helperPath === bundled ? "bundled" : "host",
    home: path.join(homedir(), ".codex"),
    env: {},
  };
}

function gptImageAuthFile() {
  const configured = envValue("GPT_IMAGE_2_SKILL_AUTH_FILE", "CODEX_AUTH_FILE");
  if (configured) return configured;
  const candidates = [
    path.join(deps.workspace, "API", "openai-gpt-account-auth.json"),
    // 兼容原画布项目的项目级 Codex OAuth 登录；新安装仍优先使用 DX OS 自己的配置或用户目录。
    path.join(path.dirname(deps.workspace), "ComfyUI-API-Modelscope", "API", "openai-gpt-account-auth.json"),
    path.join(homedir(), ".codex", "auth.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[candidates.length - 1];
}

function gptImageAuth(authPath) {
  let value = {};
  try { value = JSON.parse(deps.fs.readFileSync(authPath, "utf8")); } catch { /* missing or invalid auth */ }
  const accessToken = String(value.access_token || value.accessToken || value.tokens?.access_token || value.tokens?.accessToken || "").trim();
  if (accessToken) return { provider: "codex", args: ["--provider", "codex", "--auth-file", authPath], env: {} };
  const apiKey = String(deps.env.OPENAI_API_KEY || value.OPENAI_API_KEY || value.api_key || value.apiKey || "").trim();
  if (apiKey) return { provider: "openai", args: ["--provider", "openai"], env: deps.env.OPENAI_API_KEY ? {} : { OPENAI_API_KEY: apiKey } };
  return { provider: "codex", args: existsSync(authPath) ? ["--provider", "codex", "--auth-file", authPath] : ["--provider", "codex"], env: {} };
}

function gptImageInvocation(model, size, prompt = "", authPath = path.join(homedir(), ".codex", "auth.json")) {
  const auth = gptImageAuth(authPath);
  const requestedModel = String(model || "").trim();
  const selectedModel = requestedModel || (auth.provider === "codex" ? CODEX_MODELS[0] : CODEX_IMAGE_MODELS[0]);
  const requestedSize = String(size || "").trim();
  let selectedSize = requestedSize || "auto";
  if (auth.provider === "codex") {
    const combined = `${selectedSize} ${model} ${prompt}`.toLowerCase();
    const match = selectedSize.match(/(\d{3,5})\s*[x×*]\s*(\d{3,5})/i);
    const longEdge = match ? Math.max(Number(match[1]), Number(match[2])) : 0;
    selectedSize = /(?:^|\D)4k(?:\D|$)|3840/.test(combined) || longEdge >= 3840 ? "4K"
      : /(?:^|\D)2k(?:\D|$)|2048/.test(combined) || longEdge >= 2048 ? "2K"
        : requestedSize || "auto";
  }
  return { ...auth, model: selectedModel, size: selectedSize };
}

function parseImageSize(size) {
  const match = String(size || "").trim().match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function greatestCommonDivisor(a, b) {
  return b ? greatestCommonDivisor(b, a % b) : Math.abs(a);
}

function codexImagePrompt(prompt, size, provider) {
  if (provider !== "codex") return prompt;
  const parsed = parseImageSize(size);
  const quality = gptImageInvocation("", size, prompt, gptImageAuthFile()).size;
  if (!parsed) return `${prompt} 画质要求：目标输出 ${quality} 高分辨率图片。 Image quality requirement: output a ${quality} high-resolution image.`;
  const divisor = greatestCommonDivisor(parsed.width, parsed.height) || 1;
  const ratio = `${parsed.width / divisor}:${parsed.height / divisor}`;
  const orientationZh = parsed.width > parsed.height ? "横版/宽幅" : parsed.height > parsed.width ? "竖版/长幅" : "正方形";
  const orientationEn = parsed.width > parsed.height ? "landscape/wide" : parsed.height > parsed.width ? "portrait/tall" : "square";
  return `${prompt} 画质要求：目标输出 ${quality} 高分辨率图片。画幅要求：必须生成${orientationZh}图片，宽高比 ${ratio}。请不要交换宽高，不要输出反向比例。 Image quality requirement: output a ${quality} high-resolution image. Canvas requirement: generate a ${orientationEn} image with aspect ratio ${ratio}; do not swap width and height.`;
}

async function postprocessCodexImage(targetPath, requestedSize, provider) {
  const size = parseImageSize(requestedSize);
  if (provider !== "codex" || !size || !existsSync(targetPath)) return targetPath;
  const output = targetPath.replace(/(\.[^.]+)?$/, `-resized-${size.width}x${size.height}.png`);
  const { default: sharp } = await deps.sharpLoader();
  await sharp(targetPath).rotate().resize(size.width, size.height, { fit: "cover", position: "centre" }).png().toFile(output);
  return output;
}

function mimeFor(targetPath) {
  const ext = path.extname(targetPath).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
}

async function runCodexImage(command, prompt, model, size, referencePaths = []) {
  const rt = gptImageHelperRuntime();
  if (!rt) throw new Error("未找到 gpt-image-2-skill。请先安装 GPT CLI 附带的 Image 2 Skill helper。");
  deps.fs.mkdirSync(codexOutputDir(), { recursive: true });
  const out = path.join(codexOutputDir(), `gpt-image-${now()}.png`);
  const auth = gptImageAuthFile();
  const selectedAuth = gptImageAuth(auth);
  const driverModel = selectedAuth.provider === "codex" ? await agentCliDefaultModel("codex") : model;
  if (!driverModel) throw new Error("Codex 动态目录没有返回可用的默认 LLM，无法驱动图片 helper。");
  const invocation = gptImageInvocation(driverModel, size, prompt, auth);
  const args = ["--json", ...invocation.args, "images", command, "--prompt", codexImagePrompt(prompt, size, invocation.provider), "--out", out, "--model", invocation.model, "--format", "png", "--size", invocation.size, "--quality", "high"];
  for (const refPath of referencePaths.slice(0, 16)) args.push("--ref-image", refPath);
  if (referencePaths.length && invocation.provider === "openai") args.push("--input-fidelity", "high");
  const result = await run({ ...rt, env: { ...rt.env, ...invocation.env } }, args, 600000);
  if (result.code !== 0 || !existsSync(out)) throw new Error(`GPT Image 2 生成失败：${(result.stderr || result.stdout || `exit=${result.code}`).slice(0, 1600)}`);
  const finalPath = await postprocessCodexImage(out, size, invocation.provider);
  const image = `data:${mimeFor(finalPath)};base64,${deps.fs.readFileSync(finalPath).toString("base64")}`;
  return { images: [image], raw: result };
}

function generateCodexImage(prompt, model = "gpt-image-2", size = "1024x1024") {
  return runCodexImage("generate", prompt, model, size);
}

function editCodexImage(prompt, referencePaths, model = "gpt-image-2", size = "1024x1024") {
  if (!referencePaths.length) throw new Error("GPT Image 2 编辑需要至少一张参考图。");
  return runCodexImage("edit", prompt, model, size, referencePaths);
}

function collectRecentImages(root, sinceMs, depth = 3) {
  if (depth < 0 || !existsSync(root)) return [];
  const found = [];
  try {
    for (const entry of deps.fs.readdirSync(root, { withFileTypes: true })) {
      const targetPath = path.join(root, entry.name);
      if (entry.isDirectory()) found.push(...collectRecentImages(targetPath, sinceMs, depth - 1));
      else if (/\.(?:png|jpe?g|webp|gif)$/i.test(entry.name) && deps.fs.statSync(targetPath).mtimeMs >= sinceMs - 1500) found.push(targetPath);
    }
  } catch { /* best effort artifact discovery */ }
  return found.sort((a, b) => deps.fs.statSync(b).mtimeMs - deps.fs.statSync(a).mtimeMs);
}

function dataUrisFromValue(value, output = []) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\r\n]+/gi)) output.push(match[0].replace(/[\r\n]/g, ""));
  } else if (Array.isArray(value)) {
    for (const item of value) dataUrisFromValue(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) dataUrisFromValue(item, output);
  }
  return [...new Set(output)];
}

function writeGeminiDataUri(dataUri, index = 0) {
  const match = dataUri.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/is);
  if (!match) throw new Error("Antigravity Tools 返回了无法识别的图片数据。");
  const mime = match[1].toLowerCase();
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" : mime.includes("webp") ? ".webp" : mime.includes("gif") ? ".gif" : ".png";
  deps.fs.mkdirSync(geminiOutputDir(), { recursive: true });
  const targetPath = path.join(geminiOutputDir(), `gemini-image-${now()}-${index}${ext}`);
  const binary = Buffer.from(match[2], "base64");
  if (binary.length < 100) throw new Error("Antigravity Tools 返回的图片数据为空或损坏。");
  deps.fs.writeFileSync(targetPath, binary);
  return targetPath;
}

function geminiImageError(error) {
  const message = String((error && error.message) || error);
  if (/RESOURCE_EXHAUSTED|quota|rate.?limit|capacity|insufficient|429/i.test(message)) {
    return new Error(`Gemini 图像额度不足、触发限流或服务器暂时没有容量，请刷新 Tools 配额或稍后重试。原始信息：${message.slice(0, 500)}`);
  }
  return new Error(message);
}

async function toolsGeminiImage(prompt, referencePaths, model, size, timeoutMs) {
  await ensureAntigravityTools();
  const content = referencePaths.length
    ? [
        { type: "text", text: `${prompt}\n\n编辑要求：只修改提示词明确要求的内容，保留其余主体、背景、构图、相机、比例、光照和细节。目标尺寸或比例：${size || "auto"}。` },
        ...referencePaths.slice(0, 5).map((refPath) => ({ type: "image_url", image_url: { url: `data:${mimeFor(refPath)};base64,${deps.fs.readFileSync(refPath).toString("base64")}` } })),
      ]
    : `${prompt}\n\n目标尺寸或比例：${size || "auto"}。请生成实际图片，不要只返回文字描述。`;
  const response = await deps.fetchImpl(`${ANTIGRAVITY_TOOLS_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ model: model || GEMINI_IMAGE_MODELS[0], stream: false, messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Antigravity Tools 图像请求返回 HTTP ${response.status}：${text.slice(0, 800)}`);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("Antigravity Tools 图像请求返回了无效 JSON。"); }
  const message = payload?.choices?.[0]?.message;
  const dataUris = dataUrisFromValue(message?.content ?? message);
  if (!dataUris.length) throw new Error(`Antigravity Tools 未返回图片数据：${String(message?.content || "").slice(0, 800)}`);
  const paths = dataUris.map((dataUri, index) => writeGeminiDataUri(dataUri, index));
  return {
    images: dataUris,
    output: paths[0],
    outputs: paths,
    source: "antigravity-tools",
    raw: { model: payload?.model || model, finish_reason: payload?.choices?.[0]?.finish_reason },
  };
}

async function agyGeminiImageFallback(prompt, referencePaths, model, size, timeoutMs) {
  deps.fs.mkdirSync(geminiOutputDir(), { recursive: true });
  const since = now();
  const instruction = [
    "请使用 generate_image 工具真正生成图片。",
    referencePaths.length ? `这是图片编辑任务。必须先查看所有参考图：\n${referencePaths.join("\n")}` : "",
    `任务：${prompt}`,
    referencePaths.length ? "只修改明确要求的内容，保留其余主体、背景、构图、相机、比例、光照和细节。" : "",
    `目标尺寸或比例：${size || "auto"}。`,
    "不要修改项目代码或创建文档；只生成最终图片。",
  ].filter(Boolean).join("\n\n");
  const result = await runAgentCliChat("gemini", instruction, model, timeoutMs, { allowTools: true, imagePaths: referencePaths });
  const brainRoot = path.join(homedir(), ".gemini", "antigravity-cli", "brain");
  const reported = `${result.text}\n${result.raw.stderr || ""}`.match(/(?:[A-Za-z]:\\|\/)[^\r\n"'<>]+\.(?:png|jpe?g|webp|gif)/gi) || [];
  const candidates = [...collectRecentImages(brainRoot, since, 4), ...collectRecentImages(geminiOutputDir(), since, 1), ...reported.filter((candidate) => existsSync(candidate))];
  const source = [...new Set(candidates)][0];
  if (!source) throw new Error(`${runtime("gemini")?.label || "Antigravity CLI"} 已返回，但会话产物目录中没有可读取的图片：${result.text.slice(0, 800)}`);
  const output = path.join(geminiOutputDir(), `gemini-image-${now()}${path.extname(source) || ".png"}`);
  if (source !== output) deps.fs.copyFileSync(source, output);
  const image = `data:${mimeFor(output)};base64,${deps.fs.readFileSync(output).toString("base64")}`;
  return { images: [image], output, outputs: [output], source: "agy-generate_image", raw: result.raw };
}

async function runGeminiCliImage(prompt, referencePaths, model, size, timeoutMs) {
  const paths = referencePaths.slice(0, 5);
  for (const refPath of paths) if (!existsSync(refPath)) throw new Error(`参考图不存在：${refPath}`);
  try {
    return await toolsGeminiImage(prompt, paths, model, size, timeoutMs);
  } catch (toolsError) {
    try { return await agyGeminiImageFallback(prompt, paths, model, size, timeoutMs); }
    catch (fallbackError) {
      throw geminiImageError(`Tools 通道失败：${String((toolsError && toolsError.message) || toolsError)}；agy 备用通道失败：${String((fallbackError && fallbackError.message) || fallbackError)}`);
    }
  }
}

function generateGeminiCliImage(prompt, model = GEMINI_IMAGE_MODELS[0], size = "1024x1024", timeoutMs = 900000) {
  return runGeminiCliImage(prompt, [], model || GEMINI_IMAGE_MODELS[0], size, timeoutMs);
}

function editGeminiCliImage(prompt, referencePaths, model = GEMINI_IMAGE_MODELS[0], size = "1024x1024", timeoutMs = 900000) {
  if (!referencePaths.length) throw new Error("Gemini 图片编辑需要至少一张参考图。");
  return runGeminiCliImage(prompt, referencePaths, model || GEMINI_IMAGE_MODELS[0], size, timeoutMs);
}

/** 源注释：Compatibility wrapper for older internal callers. */
function generateGeminiImage(prompt, model = GEMINI_IMAGE_MODELS[0], size = "1024x1024", referencePaths = []) {
  return referencePaths.length
    ? editGeminiCliImage(prompt, referencePaths, model, size)
    : generateGeminiCliImage(prompt, model, size);
}

module.exports = {
  CLI_UNAVAILABLE,
  ABORT_ERR,
  configureAgentCliBridge,
  getAgentCliBridgeConfig,
  resetAgentCliBridgeForTests,
  ensureAntigravityTools,
  parseAntigravityModels,
  codexImageAuthEnv,
  agentCliInstalled,
  agentCliRuntime,
  probeAgentCliDependency,
  isCliUnavailable,
  agentCliDownloadInfo,
  agentCliStatus,
  agentCliLoginStart,
  agentCliLoginStatus,
  agentCliLogout,
  agentCliHelp,
  agentCliModels,
  agentCliDefaultModel,
  runAgentCliChat,
  gptImageInvocation,
  generateCodexImage,
  editCodexImage,
  generateGeminiCliImage,
  editGeminiCliImage,
  generateGeminiImage,
};
