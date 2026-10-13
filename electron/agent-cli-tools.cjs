"use strict";
/**
 * DX OS 移植 · CLI-1 批次：即梦（dreamina / Seedream-系）CLI 生图生视频适配。
 *
 * 源文件：DX OS 0.5.1 `server/cliTools.ts`（1138 行，只读参照）。
 * 本文件逐函数移植：函数名、参数、返回字段与源逐字对应；ESM `export` 改为
 * CJS `module.exports.<同名>`。
 *
 * 与源的显式差异（都是本批次约束要求，不是擅自改动）：
 *   1. 依赖注入：源在模块加载期读 DATA_ROOT、直接 spawn、扫 PATH、Date.now()；
 *      本文件改为 configureAgentCliTools({ spawnImpl, whichImpl, dataDir, clock })。
 *      未注入时回落源默认实现。可选追加 spawnSyncImpl / env / sharpLoader 三个键，
 *      仅为离线测试与宿主替换，不影响源的 4 个必需键。
 *   2. 「CLI 未安装」由源的 throw 改为**返回结构化错误**：
 *      { ok:false, error:"CLI_UNAVAILABLE", detail:"<二进制名 + 探测方式>" }，绝不假成功。
 *   3. sharp 仅惰性 require（源是顶层 import）；缺失时结构化报 SHARP_UNAVAILABLE，
 *      且**不加入 package.json**（见 Dx-B2-RESULT D1 / §7 不擅自新增依赖）。
 *   4. runJimengCli / runProcess 追加可选第 5 参 { signal } 支持取消；前 4 参
 *      与源签名逐字一致。源只有超时 kill，没有取消通道。
 *   5. 源 cliTools.ts 内**不存在** apiQuota / 云计费调用（assertApiModelAccess /
 *      withDirectApiQuota），也**不存在** ffmpeg 调用。后两者分别在
 *      server/apiQuota.ts、server/protocols.ts、server/video/*.ts，
 *      属其它批次，本文件因此无可删除项；此注明即为交付证据。
 *
 * 二进制探测方式（detail 里如实记录）：
 *   JIMENG_BIN / DREAMINA_BIN 环境变量
 *   → 内置 <dataDir>/cli-runtime/jimeng/bin/dreamina（bundledNativeJimeng）
 *   → whichImpl('dreamina' / 'dreamina.exe' / 'dreamina.cmd')
 *   → （Windows）WSL wsl.exe 分支。
 */

const { spawn: nodeSpawn, spawnSync: nodeSpawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const nodePath = require("node:path");
const { randomUUID } = require("node:crypto");

/** 源 ROOT = server/ 目录；这里 = electron/ 目录（spawn 的 cwd）。 */
const ROOT = __dirname;

const CLI_UNAVAILABLE = "CLI_UNAVAILABLE";
const SHARP_UNAVAILABLE = "SHARP_UNAVAILABLE";

/** 源 :13 join(tmpdir(), 'DXOS', 'cli-temp')——临时目录与 dataDir 无关，保持源行为。 */
const TEMP_DIR = nodePath.join(os.tmpdir(), "DXOS", "cli-temp");

/** 源 :17-19。 */
const MIN_JIMENG_VERSION = [1, 4, 2];
const JIMENG_TEST_TIMEOUT_MS = 10 * 60 * 1000;
const JIMENG_PROCESS_TIMEOUT_MS = JIMENG_TEST_TIMEOUT_MS;

// ── 依赖注入（本批新增；源为模块级常量与直接调用）────────────────────

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** 源 defaultDataRoot()（dataPaths.ts:8-11）。 */
function defaultDataRoot() {
  const platformRoot = process.env.LOCALAPPDATA || process.env.APPDATA;
  return nodePath.join(platformRoot || os.homedir(), "DX OS", "data");
}

const config = {
  spawnImpl: nodeSpawn,
  spawnSyncImpl: nodeSpawnSync,
  whichImpl: null,
  dataDir: null,
  cliRuntimeDir: null,
  env: null,
  clock: realClock,
  sharpLoader: null,
};

/** 源 DATA_ROOT；configure 的 dataDir 优先。 */
function currentDataDir() {
  return config.dataDir || defaultDataRoot();
}
/** 源 :12 OUTPUT_DIR = dataPath('cli-output')。 */
function outputDir() {
  return nodePath.join(currentDataDir(), "cli-output");
}
/** 源 :14 CLI_RUNTIME_DIR = join(ROOT, 'cli-runtime', 'jimeng')；注入 cliRuntimeDir 优先（测试隔离用）。 */
function cliRuntimeDir() {
  return config.cliRuntimeDir || nodePath.join(ROOT, "cli-runtime", "jimeng");
}
/** 源 :15 CLI_HOME_DIR = dataPath('cli-home', 'jimeng')。 */
function cliHomeDir() {
  return nodePath.join(currentDataDir(), "cli-home", "jimeng");
}
/** 源 :16 CLI_LOGIN_MARKER。 */
function cliLoginMarker() {
  return nodePath.join(cliHomeDir(), ".managed-login.json");
}
/** 源 envValue() 读 process.env；注入 env 后优先注入值。 */
function envSource() {
  return config.env || process.env;
}
function envValue(key) {
  return String(envSource()[key] || "").trim();
}

/** 探测缓存：null = 未探测；refreshJimengProbe() 可强制刷新。 */
let jimengRuntimeCache = null;
let jimengProbeCache = null;
let jimengModelCache = null;
let jimengModelRefresh = null;
let sharpCache = null;

function resetJimengProbe() {
  jimengRuntimeCache = null;
  jimengProbeCache = null;
}

/**
 * 注入依赖并重置探测/模型/sharp 缓存。
 * 参数键：spawnImpl / whichImpl / dataDir / clock（必需语义）；
 *          spawnSyncImpl / env / sharpLoader / cliRuntimeDir（可选扩展）。
 */
function configureAgentCliTools(options) {
  const next = options && typeof options === "object" ? options : {};
  if (next.spawnImpl !== undefined && next.spawnImpl !== null) config.spawnImpl = next.spawnImpl;
  if (next.spawnSyncImpl !== undefined && next.spawnSyncImpl !== null) config.spawnSyncImpl = next.spawnSyncImpl;
  if (next.whichImpl !== undefined) config.whichImpl = next.whichImpl;
  if (next.dataDir !== undefined) config.dataDir = next.dataDir || null;
  if (next.cliRuntimeDir !== undefined) config.cliRuntimeDir = next.cliRuntimeDir || null;
  if (next.env !== undefined) config.env = next.env || null;
  if (next.sharpLoader !== undefined) config.sharpLoader = next.sharpLoader || null;
  if (next.clock !== undefined) {
    const c = next.clock || {};
    config.clock = {
      now: typeof c.now === "function" ? c.now : realClock.now,
      setTimeout: typeof c.setTimeout === "function" ? c.setTimeout : realClock.setTimeout,
      clearTimeout: typeof c.clearTimeout === "function" ? c.clearTimeout : realClock.clearTimeout,
      sleep: typeof c.sleep === "function" ? c.sleep : realClock.sleep,
    };
  }
  resetJimengProbe();
  jimengModelCache = null;
  jimengModelRefresh = null;
  sharpCache = null;
  return { ok: true };
}

/** 还原为源默认实现。 */
function resetAgentCliTools() {
  config.spawnImpl = nodeSpawn;
  config.spawnSyncImpl = nodeSpawnSync;
  config.whichImpl = null;
  config.dataDir = null;
  config.cliRuntimeDir = null;
  config.env = null;
  config.clock = realClock;
  config.sharpLoader = null;
  resetJimengProbe();
  jimengModelCache = null;
  jimengModelRefresh = null;
  sharpCache = null;
}

function getAgentCliToolsConfig() {
  return {
    spawnImpl: config.spawnImpl,
    spawnSyncImpl: config.spawnSyncImpl,
    whichImpl: config.whichImpl,
    dataDir: config.dataDir,
    cliRuntimeDir: config.cliRuntimeDir,
    env: config.env,
    clock: config.clock,
    sharpLoader: config.sharpLoader,
  };
}

/** 源 findOnPath() 的注入入口；未注入 whichImpl 时用源默认扫描。 */
function which(command) {
  if (typeof config.whichImpl === "function") return String(config.whichImpl(command) || "");
  return findOnPath(command);
}

// ── 源 :45-114 目录 / 字符处理 / WSL ─────────────────────────────────

function ensureDirs() {
  const out = outputDir();
  if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function ensureCliHome() {
  const home = cliHomeDir();
  const dirs = [
    home,
    nodePath.join(home, "home"),
    nodePath.join(home, "config"),
    nodePath.join(home, "cache"),
    nodePath.join(home, "data"),
    cliRuntimeDir(),
  ];
  for (const dir of dirs) if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function useWsl() {
  return jimengRuntime().usesWsl;
}

function findOnPath(command) {
  const pathext = process.platform === "win32" ? (envValue("PATHEXT") || ".EXE;.CMD;.BAT").split(";") : [""];
  const names = nodePath.extname(command) ? [command] : pathext.map((ext) => command + ext.toLowerCase()).concat(pathext.map((ext) => command + ext.toUpperCase()));
  for (const dir of envValue("PATH").split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const name of names) {
      const full = nodePath.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }
  return "";
}

function decode(buf) {
  if (!buf.length) return "";
  const zeroBytes = [...buf].filter((value) => value === 0).length;
  const encoding = zeroBytes >= Math.max(2, Math.floor(buf.length / 12)) ? "utf16le" : "utf8";
  return buf.toString(encoding).replace(/^\uFEFF/, "").replace(/\u0000/g, "").trim();
}

function cleanWslStderr(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.replace(/\u0000/g, "").trim()).filter((line) => {
    const low = line.toLowerCase();
    return line && !(low.includes("localhost") && low.includes("wsl") && (low.includes("nat") || low.includes("proxy") || line.includes("代理")));
  }).join("\n").trim();
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function wslBaseArgs(exe) {
  const configured = envValue("JIMENG_WSL_DISTRO");
  let names = [];
  try {
    const proc = config.spawnSyncImpl(exe, ["-l", "-q"], { windowsHide: true, timeout: 5000 });
    names = decode(proc.stdout || Buffer.alloc(0)).split(/\r?\n/).map((line) => line.trim().replace(/^\*/, "").trim()).filter(Boolean);
  } catch {
    names = [];
  }
  if (!names.length) return null;
  if (configured) return names.includes(configured) ? ["-d", configured] : null;
  const ubuntu = names.find((name) => /^Ubuntu($|-)/i.test(name));
  return ubuntu ? ["-d", ubuntu] : ["-d", names[0]];
}

function bundledNativeJimeng() {
  const candidates = process.platform === "win32"
    ? ["dreamina.exe", "dreamina.cmd", "dreamina.bat", "dreamina"]
    : ["dreamina"];
  return candidates.map((name) => nodePath.join(cliRuntimeDir(), "bin", name)).find((file) => fs.existsSync(file)) || "";
}

function bundledWslJimeng() {
  const file = nodePath.join(cliRuntimeDir(), "wsl", "bin", "dreamina");
  return fs.existsSync(file) ? windowsPathToWsl(file) : "";
}

function windowsPathToWsl(value) {
  const m = String(value).replace(/\\/g, "/").match(/^([A-Za-z]):\/(.*)$/);
  return m ? "/mnt/" + m[1].toLowerCase() + "/" + m[2] : String(value).replace(/\\/g, "/");
}

function wslPathToWindows(value) {
  const m = String(value).match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  return m ? m[1].toUpperCase() + ":\\" + m[2].replace(/\//g, "\\") : value;
}

// ── 源 :138-223 运行时解析 + 依赖探测 ───────────────────────────────

function jimengExecutable() {
  return jimengRuntime().command;
}

function jimengRuntimeSource() {
  const runtime = jimengRuntime();
  return {
    mode: runtime.mode,
    path: runtime.path,
    label: runtime.label,
    detail: runtime.detail,
    home: runtime.home,
    launcher: runtime.launcher,
    login_mode: jimengUsesHostLogin(runtime) ? "host" : "isolated",
  };
}

function jimengUsesHostLogin(runtime) {
  return (runtime || jimengRuntime()).mode === "path" || (runtime || jimengRuntime()).mode === "managed-wsl";
}

function sameExecutable(left, right) {
  if (!left || !right) return false;
  try { return nodePath.resolve(left).toLowerCase() === nodePath.resolve(right).toLowerCase(); }
  catch { return left.toLowerCase() === right.toLowerCase(); }
}

function managedJimengLoginStatePresent() {
  if (jimengTokenSnapshot().present || fs.existsSync(cliLoginMarker())) return true;
  // 源 :167-170：保留被日志/账号任务状态绑定的托管 profile，避免升级时错误切到本机安装。
  return fs.existsSync(nodePath.join(cliHomeDir(), "home", ".dreamina_cli", "tasks.db"));
}

function rememberManagedJimengLogin(runtime) {
  if (jimengUsesHostLogin(runtime)) return;
  const marker = cliLoginMarker();
  try { fs.writeFileSync(marker, JSON.stringify({ verifiedAt: config.clock.now(), runtime: runtime.mode }), "utf8"); } catch { /* 源：状态仍可用 */ }
  resetJimengProbe();
}

/** 解析运行时（源 jimengRuntime() 本体，函数名保留源语义 + 缓存）。 */
function resolveJimengRuntime() {
  ensureCliHome();
  const home = nodePath.join(cliHomeDir(), "home");
  const bundled = bundledNativeJimeng();
  // 源 :182-184：有效托管登录凭据把提交与轮询都钉在托管 CLI 上。
  if (bundled && managedJimengLoginStatePresent()) return { command: bundled, binPath: bundled, argsPrefix: [], usesWsl: false, mode: "bundled", label: "OS 内置 CLI", path: bundled, home };

  const configured = envValue("JIMENG_BIN") || envValue("DREAMINA_BIN");
  if (configured && !sameExecutable(configured, bundled)) return { command: configured, binPath: configured, argsPrefix: [], usesWsl: false, mode: "path", label: "本机 dreamina", path: configured, home, detail: "DX OS 独立登录不可用，已使用配置的本机 dreamina 与本机登录态。" };

  const native = [which("dreamina"), which("dreamina.exe"), which("dreamina.cmd")]
    .find((candidate) => candidate && !sameExecutable(candidate, bundled)) || "";
  const wslFlag = envValue("JIMENG_USE_WSL").toLowerCase();
  const forceWsl = ["1", "true", "yes", "on", "wsl"].includes(wslFlag);
  const disableWsl = wslFlag && ["0", "false", "no", "off", "native"].includes(wslFlag);
  if (native && !forceWsl) return { command: native, binPath: native, argsPrefix: [], usesWsl: false, mode: "path", label: "本机 dreamina", path: native, home, detail: "使用本机 dreamina 登录态，无需 API Key。" };

  // 源 :196-198：没有本机安装时保留内置 CLI 供首次登录。
  if (bundled && !forceWsl) return { command: bundled, binPath: bundled, argsPrefix: [], usesWsl: false, mode: "bundled", label: "OS 内置 CLI（待登录）", path: bundled, home, detail: "未检测到 DX OS 独立登录或本机安装；登录后将固定使用此内置 CLI。" };

  const wsl = process.platform === "win32" && !disableWsl ? (which("wsl.exe") || "wsl.exe") : "";
  const wslArgs = wsl ? wslBaseArgs(wsl) : null;
  if (wsl && wslArgs) {
    const bundledWsl = bundledWslJimeng();
    const isBundled = !!bundledWsl;
    return {
      command: wsl,
      binPath: bundledWsl,
      argsPrefix: wslArgs,
      usesWsl: true,
      mode: isBundled ? "bundled-wsl" : "managed-wsl",
      label: isBundled ? "OS 内置 CLI" : "本机 WSL dreamina",
      path: isBundled ? nodePath.join(cliRuntimeDir(), "wsl", "bin", "dreamina") : cliRuntimeDir(),
      detail: isBundled ? "通过 OS 管理的 WSL 启动器运行，登录数据保存在 OS 独立目录。" : "使用本机 dreamina 登录态，无需 API Key。",
      home,
      launcher: wsl,
    };
  }
  return { command: "", binPath: "", argsPrefix: [], usesWsl: false, mode: "missing", label: "未检测到", path: "", home };
}

/** 带缓存的运行时解析；refreshJimengProbe() 可刷新。 */
function jimengRuntime() {
  if (!jimengRuntimeCache) jimengRuntimeCache = resolveJimengRuntime();
  return jimengRuntimeCache;
}

/** 未安装时结构化错误的 detail：二进制名 + 探测方式。 */
function jimengProbeDetail() {
  const configured = envValue("JIMENG_BIN") || envValue("DREAMINA_BIN");
  const steps = [
    "JIMENG_BIN/DREAMINA_BIN 环境变量",
    "内置 " + nodePath.join(cliRuntimeDir(), "bin", "dreamina"),
    "whichImpl('dreamina' / 'dreamina.exe' / 'dreamina.cmd')",
    process.platform === "win32" ? "WSL wsl.exe" : "非 Windows 不启用 WSL 分支",
  ];
  return "dreamina：未找到可执行文件（探测方式：" + steps.join(" → ") + "）" + (configured ? "；已配置 JIMENG_BIN/DREAMINA_BIN=" + configured : "");
}

function cliUnavailable(detail) {
  return { ok: false, error: CLI_UNAVAILABLE, detail: detail || jimengProbeDetail() };
}

function cliUnavailableError() {
  const error = new Error(jimengProbeDetail());
  error.code = CLI_UNAVAILABLE;
  return error;
}

function isCliUnavailable(value) {
  return !!value && typeof value === "object" && value.error === CLI_UNAVAILABLE;
}

/** 缓存探测；force=true 强制重探。 */
function probeJimengCli(force) {
  if (!force && jimengProbeCache) return jimengProbeCache;
  const runtime = jimengRuntime();
  jimengProbeCache = runtime.command
    ? { ok: true, installed: true, exe: runtime.command, runtime: jimengRuntimeSource() }
    : { ok: false, installed: false, error: CLI_UNAVAILABLE, detail: jimengProbeDetail() };
  return jimengProbeCache;
}

/** 刷新探测（清缓存后重探）。 */
function refreshJimengProbe() {
  resetJimengProbe();
  return probeJimengCli(true);
}

/** 源 jimengCliInstalled()。 */
function jimengCliInstalled() {
  return !!jimengExecutable();
}

// ── 源 :225-305 命令行构造与进程执行 ───────────────────────────────

function jimengPathArg(value) {
  return useWsl() ? windowsPathToWsl(value) : value;
}

function jimengCommand(args, exe, loginMode) {
  const runtime = jimengRuntime();
  const executable = exe || jimengExecutable();
  const mode = loginMode || "runtime";
  const useHostLogin = mode === "host" || (mode === "runtime" && jimengUsesHostLogin(runtime));
  if (runtime.usesWsl) {
    if (useHostLogin) {
      const dreaminaLookup = runtime.binPath
        ? "DREAMINA_BIN=" + shellQuote(runtime.binPath)
        : 'DREAMINA_BIN=$(command -v dreamina || find "$HOME" -maxdepth 5 -type f -name dreamina 2>/dev/null | head -n 1)';
      const shellLine = [
        '. "$HOME/.profile" >/dev/null 2>&1 || true',
        '. "$HOME/.bashrc" >/dev/null 2>&1 || true',
        dreaminaLookup,
        'if [ -z "$DREAMINA_BIN" ]; then echo "dreamina CLI not found in WSL" >&2; exit 127; fi',
        '"$DREAMINA_BIN" ' + args.map(shellQuote).join(" "),
      ].join("; ");
      return { command: runtime.command || executable, args: [...runtime.argsPrefix, "-e", "sh", "-lc", shellLine], env: {} };
    }
    const home = cliHomeDir();
    const wslHome = windowsPathToWsl(nodePath.join(home, "home"));
    const wslConfig = windowsPathToWsl(nodePath.join(home, "config"));
    const wslCache = windowsPathToWsl(nodePath.join(home, "cache"));
    const wslData = windowsPathToWsl(nodePath.join(home, "data"));
    const dreaminaLookup = runtime.binPath
      ? "DREAMINA_BIN=" + shellQuote(runtime.binPath)
      : 'DREAMINA_BIN=$(command -v dreamina || find "$ORIGINAL_HOME" -maxdepth 5 -type f -name dreamina 2>/dev/null | head -n 1)';
    const shellLine = [
      'ORIGINAL_HOME="$HOME"',
      '. "$ORIGINAL_HOME/.profile" >/dev/null 2>&1 || true',
      '. "$ORIGINAL_HOME/.bashrc" >/dev/null 2>&1 || true',
      "export HOME=" + shellQuote(wslHome),
      "export USERPROFILE=" + shellQuote(wslHome),
      "export XDG_CONFIG_HOME=" + shellQuote(wslConfig),
      "export XDG_CACHE_HOME=" + shellQuote(wslCache),
      "export XDG_DATA_HOME=" + shellQuote(wslData),
      'mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"',
      dreaminaLookup,
      'if [ -z "$DREAMINA_BIN" ]; then echo "dreamina CLI not found in WSL" >&2; exit 127; fi',
      '"$DREAMINA_BIN" ' + args.map(shellQuote).join(" "),
    ].join("; ");
    return { command: runtime.command || executable, args: [...runtime.argsPrefix, "-e", "sh", "-lc", shellLine], env: {} };
  }
  const home = cliHomeDir();
  const nativeEnv = {
    HOME: nodePath.join(home, "home"),
    USERPROFILE: nodePath.join(home, "home"),
    APPDATA: nodePath.join(home, "config"),
    LOCALAPPDATA: nodePath.join(home, "data"),
    XDG_CONFIG_HOME: nodePath.join(home, "config"),
    XDG_CACHE_HOME: nodePath.join(home, "cache"),
    XDG_DATA_HOME: nodePath.join(home, "data"),
    DREAMINA_HOME: nodePath.join(home, "home"),
  };
  return { command: runtime.command || executable, args, env: useHostLogin ? {} : nativeEnv };
}

function runProcess(command, args, timeoutMs, env, options) {
  const opts = options && typeof options === "object" ? options : {};
  const signal = opts.signal || null;
  return new Promise((resolve, reject) => {
    const child = config.spawnImpl(command, args, { cwd: ROOT, windowsHide: true, env: { ...envSource(), ...(env || {}) } });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) config.clock.clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => {
      try { child.kill(); } catch { /* ignore */ }
      const error = new Error("即梦 CLI 已取消");
      error.code = "ABORTED";
      finish(reject, error);
    };
    timer = config.clock.setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, new Error("即梦 CLI 执行超时"));
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (err) => { finish(reject, err); });
    child.on("close", (code) => {
      const out = decode(Buffer.concat(stdout));
      const err = jimengRuntime().usesWsl ? cleanWslStderr(decode(Buffer.concat(stderr))) : decode(Buffer.concat(stderr));
      if (code !== 0) finish(reject, new Error((err || out || "exit=" + code).slice(0, 1200)));
      else finish(resolve, { stdout: out, stderr: err });
    });
  });
}

function extractJson(text) {
  const source = String(text || "").trim();
  if (!source) return {};
  const parsed = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch !== "{" && ch !== "[") continue;
    try {
      parsed.push({ index: i, value: JSON.parse(source.slice(i)) });
    } catch {
      const end = Math.max(source.lastIndexOf("}"), source.lastIndexOf("]"));
      if (end > i) try { parsed.push({ index: i, value: JSON.parse(source.slice(i, end + 1)) }); } catch { /* ignore */ }
    }
  }
  if (!parsed.length) return { text: source };
  const score = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return 1;
    const keys = new Set(Object.keys(value).map((k) => k.toLowerCase()));
    return ["submit_id", "gen_status", "result_json", "images", "videos", "data", "total_credit"].reduce((sum, key) => sum + (keys.has(key) ? 10 : 0), 0);
  };
  return parsed.sort((a, b) => score(b.value) - score(a.value) || a.index - b.index)[0].value;
}

/** 源 runJimengCli()：未安装时返回结构化错误（源为 throw）。 */
async function runJimengCli(args, timeoutMs, rawText, loginMode, options) {
  const timeout = timeoutMs === undefined ? 120000 : timeoutMs;
  const raw = rawText === undefined ? false : rawText;
  const mode = loginMode === undefined ? "runtime" : loginMode;
  const exe = jimengExecutable();
  if (!exe) return cliUnavailable();
  const cmd = jimengCommand(args.map(String), exe, mode);
  const result = await runProcess(cmd.command, cmd.args, timeout, cmd.env, options);
  const operation = String(args[0] || "").toLowerCase();
  if (mode === "runtime" && (operation === "user_credit" || operation === "login")) rememberManagedJimengLogin(jimengRuntime());
  if (raw) return { _stdout: result.stdout, _stderr: result.stderr };
  const value = extractJson((result.stdout + "\n" + result.stderr).trim());
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...value, _stdout: result.stdout, ...(result.stderr ? { _stderr: result.stderr } : {}) };
  }
  return value;
}

// ── 源 :345-411 版本 / 状态 / 积分 / 登出 ──────────────────────────

function parseVersion(text) {
  const m = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

async function jimengVersion() {
  for (const flag of ["--version", "-V", "version"]) {
    try {
      const raw = await runJimengCli([flag], 15000, true);
      const text = ((raw._stdout || "") + "\n" + (raw._stderr || "")).trim();
      const version = parseVersion(text);
      if (version) return { version, text };
    } catch { /* try next */ }
  }
  return { version: null, text: "" };
}

function versionOk(version) {
  if (!version) return null;
  for (let i = 0; i < MIN_JIMENG_VERSION.length; i++) {
    if (version[i] > MIN_JIMENG_VERSION[i]) return true;
    if (version[i] < MIN_JIMENG_VERSION[i]) return false;
  }
  return true;
}

async function jimengStatus() {
  const exe = jimengExecutable();
  const runtime = jimengRuntimeSource();
  if (!exe) return { ok: false, error: CLI_UNAVAILABLE, detail: jimengProbeDetail(), installed: false, logged_in: false, message: "未找到 dreamina CLI", runtime };
  const v = await jimengVersion();
  try {
    const raw = await runJimengCli(["user_credit"], 30000);
    return { installed: true, logged_in: true, raw, login_verified_by: "cli", cli_version: v.version ? v.version.join(".") : null, version_ok: versionOk(v.version), min_version: MIN_JIMENG_VERSION.join("."), runtime };
  } catch (e) {
    const token = jimengTokenSnapshot();
    if (token.present) {
      return { installed: true, logged_in: true, token_present: true, login_verified_by: "token", message: "已检测到网页登录凭据，积分检测暂不可用。", credit_error: String(e.message || e), cli_version: v.version ? v.version.join(".") : null, version_ok: versionOk(v.version), min_version: MIN_JIMENG_VERSION.join("."), runtime };
    }
    return { installed: true, logged_in: false, message: String(e.message || e), cli_version: v.version ? v.version.join(".") : null, version_ok: versionOk(v.version), min_version: MIN_JIMENG_VERSION.join("."), runtime };
  }
}

async function jimengCredit() {
  if (!jimengExecutable()) return cliUnavailable();
  try {
    return { success: true, available: true, logged_in: true, raw: await runJimengCli(["user_credit"], 30000) };
  } catch (e) {
    const token = jimengTokenSnapshot();
    if (token.present) {
      return {
        success: true,
        available: false,
        logged_in: true,
        token_present: true,
        message: "已检测到网页登录凭据，但官方 CLI 暂时没有返回可读积分。",
        error: String(e.message || e),
      };
    }
    throw e;
  }
}

async function jimengLogout() {
  if (!jimengExecutable()) return cliUnavailable();
  const raw = await runJimengCli(["logout"], 30000);
  try { fs.unlinkSync(cliLoginMarker()); } catch { /* already absent */ }
  resetJimengProbe();
  return { success: true, raw };
}

// ── 源 :413-550 登录会话 / 帮助 / 模型目录 ─────────────────────────

const jimengLoginSession = { proc: null, stdout: "", stderr: "", started_at: 0 };
let jimengLoginProbe = null;
let jimengLoginProbeAt = 0;
let jimengLoginCheck = null;

function loginText() {
  return [jimengLoginSession.stdout, jimengLoginSession.stderr].map((v) => v.trim()).filter(Boolean).join("\n").trim();
}

function qrFromText(text) {
  const candidates = [...String(text || "").matchAll(/(https?:\/\/[^\s"'<>]+|dreamina:\/\/[^\s"'<>]+|data:image\/[^\s"'<>]+)/g)].map((m) => m[1]);
  return candidates.find((value) => /login|qr/i.test(value) || value.startsWith("data:image") || value.startsWith("dreamina://")) || candidates[0] || "";
}

function jimengTokenSnapshot() {
  const home = cliHomeDir();
  const candidates = [
    nodePath.join(home, "home", ".local", "share", "dreamina", "byted_cli_user_token.json"),
    nodePath.join(home, "home", ".dreamina_cli", "byted_cli_user_token.json"),
    nodePath.join(home, "config", "dreamina", "byted_cli_user_token.json"),
    nodePath.join(home, "data", "dreamina", "byted_cli_user_token.json"),
  ];
  const file = candidates.find((candidate) => {
    try {
      if (!fs.existsSync(candidate)) return false;
      const text = fs.readFileSync(candidate, "utf8");
      if (text.length < 20) return false;
      const parsed = JSON.parse(text);
      const keys = Object.keys(parsed).map((key) => key.toLowerCase());
      return keys.some((key) => /(^|_)(access|refresh|session|auth)?_?token$|cookie/.test(key) && String(parsed[key] || "").length > 20);
    } catch {
      return false;
    }
  }) || "";
  return { present: !!file, path: file };
}

function loginInfoFromText(text) {
  const source = String(text || "");
  const field = (name) => {
    const match = source.match(new RegExp("^\\s*" + name + ":\\s*(.+)$", "mi"));
    return match && match[1] ? match[1].trim() : "";
  };
  return {
    verification_uri: field("verification_uri"),
    user_code: field("user_code"),
    device_code: field("device_code"),
    expires_at: field("expires_at"),
    qr_url: qrFromText(source),
  };
}

async function loginPayload(proc) {
  const text = loginText();
  const info = loginInfoFromText(text);
  return {
    success: true,
    running: (!!proc && proc.exitCode == null) || !!info.device_code,
    text,
    qr_url: info.qr_url,
    login_url: info.verification_uri || info.qr_url,
    verification_uri: info.verification_uri,
    user_code: info.user_code,
    device_code: info.device_code,
    expires_at: info.expires_at,
    started_at: jimengLoginSession.started_at,
  };
}

function attachLoginReaders(proc) {
  proc.stdout.on("data", (chunk) => { jimengLoginSession.stdout += decode(Buffer.from(chunk)) + "\n"; });
  proc.stderr.on("data", (chunk) => { jimengLoginSession.stderr += (jimengRuntime().usesWsl ? cleanWslStderr(decode(Buffer.from(chunk))) : decode(Buffer.from(chunk))) + "\n"; });
}

/** 源 jimengLoginStart()：未安装时返回结构化错误（源为 throw）。 */
async function jimengLoginStart() {
  if (jimengLoginSession.proc && jimengLoginSession.proc.exitCode == null) jimengLoginSession.proc.kill();
  const exe = jimengExecutable();
  if (!exe) return cliUnavailable();
  jimengLoginSession.proc = null;
  jimengLoginSession.stdout = "";
  jimengLoginSession.stderr = "";
  jimengLoginSession.started_at = config.clock.now();
  const cmd = jimengCommand(["login", "--headless"], exe);
  const proc = config.spawnImpl(cmd.command, cmd.args, { cwd: ROOT, windowsHide: true, env: { ...envSource(), ...(cmd.env || {}) } });
  jimengLoginSession.proc = proc;
  attachLoginReaders(proc);
  await config.clock.sleep(2000);
  return loginPayload(proc);
}

async function jimengLoginStatus() {
  const proc = jimengLoginSession.proc;
  const running = !!proc && proc.exitCode == null;
  let logged_in = false;
  let raw = null;
  const payload = await loginPayload(proc);
  const deviceCode = loginInfoFromText(loginText()).device_code;
  if (running && !jimengLoginProbe && config.clock.now() - jimengLoginProbeAt < 5000) {
    return { ...payload, running: true, logged_in: false, raw };
  }
  if (deviceCode) {
    try {
      if (!jimengLoginCheck) {
        jimengLoginCheck = runJimengCli(["login", "checklogin", "--device_code=" + deviceCode], 15000)
          .finally(() => { jimengLoginCheck = null; });
      }
      raw = await jimengLoginCheck;
      logged_in = true;
    } catch {
      logged_in = false;
    }
  } else if (jimengLoginProbe) {
    try {
      raw = await jimengLoginProbe;
      logged_in = true;
    } catch {
      logged_in = false;
    }
  } else {
    jimengLoginProbeAt = config.clock.now();
    jimengLoginProbe = runJimengCli(["user_credit"], 12000)
      .finally(() => { jimengLoginProbe = null; });
    try {
      raw = await jimengLoginProbe;
      logged_in = true;
    } catch {
      logged_in = false;
    }
  }
  const token = jimengTokenSnapshot();
  if (!logged_in && token.present) {
    logged_in = true;
    raw = { token_present: true };
  }
  if (logged_in && proc && proc.exitCode == null) {
    try { proc.kill(); } catch { /* ignore */ }
  }
  return { ...payload, running: (running || !!deviceCode) && !logged_in, logged_in, token_present: token.present, login_verified_by: raw && raw.token_present ? "token" : logged_in ? "cli" : "", raw };
}

/** 源 jimengHelp()：未安装时返回结构化错误（源为 throw）。 */
async function jimengHelp(command) {
  const allowed = new Set(["", "login", "logout", "user_credit", "text2image", "image2image", "image_upscale", "text2video", "image2video", "multimodal2video", "frames2video", "multiframe2video", "list_task", "query_result"]);
  const cmd = String(command || "").trim();
  if (!allowed.has(cmd)) throw new Error("不支持的帮助命令");
  if (!jimengExecutable()) return cliUnavailable();
  const raw = await runJimengCli(cmd ? [cmd, "-h"] : ["-h"], 30000, true);
  if (isCliUnavailable(raw)) return raw;
  return { success: true, command: cmd, text: ((raw._stdout || "") + "\n" + (raw._stderr || "")).trim(), raw };
}

const JIMENG_MODEL_FALLBACK = ["jimeng-5.0Pro", "jimeng-5.0", "jimeng-4.7", "jimeng-4.6", "jimeng-4.5", "jimeng-4.1", "jimeng-4.0", "jimeng-3.1", "jimeng-3.0", "seedance2.5", "seedance2.0fast", "seedance2.0", "seedance2.0mini", "seedance2.0_vip", "seedance2.0fast_vip", "seedance1.5pro", "seedance1.0fast"];

function jimengModelsFromHelp(text) {
  const found = new Set();
  for (const match of String(text || "").matchAll(/\b(3\.0|3\.1|4\.0|4\.1|4\.5|4\.6|4\.7|5\.0Pro|5\.0)\b/g)) found.add("jimeng-" + match[1]);
  for (const match of String(text || "").matchAll(/\b(seedance(?:1\.0fast|1\.5pro|2\.5|2\.0fast_vip|2\.0_vip|2\.0fast|2\.0mini|2\.0))\b/g)) found.add(match[1]);
  const ordered = JIMENG_MODEL_FALLBACK.filter((model) => found.has(model));
  for (const model of found) if (!ordered.includes(model)) ordered.push(model);
  return ordered;
}

async function refreshJimengModels() {
  const commands = ["text2image", "image2image", "text2video", "image2video", "multimodal2video", "frames2video", "multiframe2video"];
  const found = new Set();
  await Promise.allSettled(commands.map(async (command) => {
    try {
      const help = await jimengHelp(command);
      if (isCliUnavailable(help)) return;
      for (const model of jimengModelsFromHelp(help.text || "")) found.add(model);
    } catch { /* help 解析是尽力而为，失败后走下面的回退 */ }
  }));
  const ordered = JIMENG_MODEL_FALLBACK.filter((model) => found.has(model));
  for (const model of found) if (!ordered.includes(model)) ordered.push(model);
  const result = {
    ts: config.clock.now(),
    models: ordered.length ? ordered : JIMENG_MODEL_FALLBACK,
    source: ordered.length ? "cli-help" : "fallback",
  };
  jimengModelCache = result;
  return result;
}

/** 源 jimengModels()：未安装时返回结构化错误（源返回 fallback 目录）。 */
async function jimengModels(force) {
  if (!jimengExecutable()) return cliUnavailable();
  const ttl = 12 * 60 * 60 * 1000;
  const cached = jimengModelCache;
  const fresh = !!cached && config.clock.now() - cached.ts < ttl;
  if (fresh && !force) return { ...cached, cached: true };
  const ensureRefresh = () => {
    if (!jimengModelRefresh) {
      jimengModelRefresh = refreshJimengModels().finally(() => { jimengModelRefresh = null; });
    }
    return jimengModelRefresh;
  };
  if (!force) {
    if (cached) {
      ensureRefresh();
      return { ...cached, cached: true, refreshing: true };
    }
    ensureRefresh();
    return { ts: config.clock.now(), models: JIMENG_MODEL_FALLBACK, source: "fallback", cached: false, refreshing: true };
  }
  const snap = await ensureRefresh();
  return { ...snap, cached: false };
}

// ── 源 :608-661 尺寸 / 比例 / 图片模型 ─────────────────────────────

/** 惰性 require('sharp')；失败给 SHARP_UNAVAILABLE 结构化错误（不加入 package.json）。 */
function requireSharp() {
  if (sharpCache) return sharpCache;
  try {
    sharpCache = config.sharpLoader ? config.sharpLoader() : require("sharp");
    if (!sharpCache) throw new Error("sharp 模块为空");
    return sharpCache;
  } catch (error) {
    const err = new Error("sharp 未安装（惰性 require(\"sharp\") 失败）");
    err.code = SHARP_UNAVAILABLE;
    err.detail = "sharp：惰性 require 失败；按批次约束未加入 package.json（源 Dx-B2-RESULT D1）";
    err.cause = error;
    throw err;
  }
}

function probeSharp() {
  try {
    requireSharp();
    return { ok: true, available: true };
  } catch (error) {
    return { ok: false, error: SHARP_UNAVAILABLE, detail: error.detail };
  }
}

function parseSize(size) {
  const m = String(size || "").match(/(\d+)\D+(\d+)/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1024, height: 1024 };
}

function ratioFromDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "1:1";
  const choices = [[21, 9], [16, 9], [3, 2], [4, 3], [1, 1], [3, 4], [2, 3], [9, 16]];
  const [left, right] = choices.sort((a, b) => Math.abs(width / height - a[0] / a[1]) - Math.abs(width / height - b[0] / b[1]))[0];
  return left + ":" + right;
}

function ratioFromSize(size) {
  const { width, height } = parseSize(size);
  return ratioFromDimensions(width, height);
}

function jimengImageRatioFromDimensions(width, height) {
  return ratioFromDimensions(width, height);
}

async function jimengReferenceImageRatio(filePath) {
  const sharp = requireSharp();
  const metadata = await sharp(filePath, { animated: false, limitInputPixels: 268402689 }).metadata();
  const autoOrient = metadata.autoOrient;
  const width = Number((autoOrient && autoOrient.width) || metadata.width || 0);
  const height = Number((autoOrient && autoOrient.height) || metadata.height || 0);
  if (!width || !height) throw new Error("无法读取参考图尺寸");
  return ratioFromDimensions(width, height);
}

function normalizeImageModel(model) {
  if (/\b5(?:\.0)?\s*[-_ ]?pro\b/i.test(model)) return "5.0Pro";
  const match = String(model || "").match(/(\d+\.\d+)/);
  return match ? match[1] : "";
}

function imageModelVersion(model, mode) {
  const version = normalizeImageModel(model);
  const allowed = mode === "image2image" ? new Set(["4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro"]) : new Set(["3.0", "3.1", "4.0", "4.1", "4.5", "4.6", "4.7", "5.0", "5.0Pro"]);
  return allowed.has(version) ? version : "";
}

function imageResolution(model, size, mode) {
  const text = String(model || "").toLowerCase();
  let desired = text.includes("4k") ? "4k" : text.includes("2k") ? "2k" : /1(?:\.5)?k/.test(text) ? "1.5k" : "1.5k";
  if (!/(?:1(?:\.5)?|2|4)k/.test(text)) {
    const { width, height } = parseSize(size);
    const longest = Math.max(width, height);
    desired = longest > 3072 ? "4k" : longest > 1536 ? "2k" : "1.5k";
  }
  const version = normalizeImageModel(model);
  if (mode === "image2image") return version === "5.0Pro" ? desired : desired === "4k" ? "4k" : "2k";
  if (["3.0", "3.1", "5.0Pro"].includes(version)) return version === "5.0Pro" && desired === "4k" ? "4k" : desired === "1.5k" ? "1.5k" : "2k";
  return desired === "4k" ? "4k" : "2k";
}

// ── 源 :663-816 视频模型表 / 约束 / 参数构造 ───────────────────────

const JIMENG_VIDEO_HIGH_RES_MODELS = new Set(["seedance2.0_vip"]);
const JIMENG_VIDEO_MODELS_BY_COMMAND = {
  text2video: new Set(["seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini", "seedance2.5"]),
  image2video: new Set(["seedance1.0fast", "seedance1.5pro", "seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini", "seedance2.5"]),
  multimodal2video: new Set(["seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini", "seedance2.5"]),
  frames2video: new Set(["seedance1.5pro", "seedance2.0", "seedance2.0fast", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini", "seedance2.5"]),
};

function videoModelVersion(model) {
  const low = String(model || "").trim().toLowerCase();
  const versions = ["seedance2.0fast_vip", "seedance2.0_vip", "seedance2.0mini", "seedance2.0fast", "seedance1.0fast", "seedance1.5pro", "seedance2.0", "seedance2.5"];
  return versions.find((item) => {
    const at = low.indexOf(item);
    if (at < 0) return false;
    const before = at > 0 ? low[at - 1] : "";
    const after = low[at + item.length] || "";
    return (!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z0-9]/.test(after));
  }) || "";
}

function videoModelForCommand(model, command) {
  const version = videoModelVersion(model);
  const allowed = JIMENG_VIDEO_MODELS_BY_COMMAND[command];
  if (allowed.has(version)) return version;
  throw new Error("即梦 " + command + " 不支持模型「" + model + "」。可用模型：" + [...allowed].sort().join("、") + "。");
}

function videoResolution(model, resolution) {
  const version = videoModelVersion(model);
  const raw = String(resolution || "720p").trim().toLowerCase();
  const requested = ["4k", "4kp"].includes(raw) ? "4k" : ["1080", "1080p"].includes(raw) ? "1080p" : ["720", "720p"].includes(raw) ? "720p" : ["480", "480p"].includes(raw) ? "480p" : "";
  if (!requested) throw new Error("即梦视频分辨率无效；Seedance 2.5 支持 480p/720p/1080p，seedance2.0_vip 支持 720p/1080p/4k，其余模型仅支持 720p。");
  if (version === "seedance2.5") {
    if (requested === "4k") throw new Error("即梦模型 seedance2.5 只支持 480p、720p 或 1080p，不支持 4k。");
    return requested;
  }
  if (!JIMENG_VIDEO_HIGH_RES_MODELS.has(version) && requested !== "720p") throw new Error("即梦模型 " + (version || model) + " 只支持 720p。");
  return requested;
}

function multiframeResolution(resolution) {
  const raw = String(resolution || "720p").trim().toLowerCase();
  if (["720", "720p"].includes(raw)) return "720p";
  if (["1080", "1080p"].includes(raw)) return "1080p";
  throw new Error("即梦多帧视频只支持 720p 或 1080p。");
}

function videoDuration(duration, model, command) {
  const version = videoModelVersion(model);
  const [low, high] = command === "image2video" && version === "seedance1.0fast" ? [5, 10]
    : ["image2video", "frames2video"].includes(command) && version === "seedance1.5pro" ? [5, 12]
      : version === "seedance2.5" ? [4, 30] : [4, 15];
  const value = duration == null ? Math.max(low, Math.min(high, 5)) : Number(duration);
  if (!Number.isInteger(value) || value < low || value > high) throw new Error("即梦模型 " + (version || model) + " 只支持 " + low + "-" + high + " 秒整数时长。");
  return value;
}

function videoRatio(value) {
  const ratio = String(value || "16:9").trim() || "16:9";
  if (!new Set(["1:1", "3:4", "16:9", "4:3", "9:16", "21:9"]).has(ratio)) throw new Error("即梦视频比例仅支持 1:1、3:4、16:9、4:3、9:16、21:9。");
  return ratio;
}

function transitionDuration(totalDuration, transitionCount) {
  const total = Number(totalDuration) || 0;
  return Math.max(1, Math.min(8, Math.round(total <= 0 ? 3 : total / Math.max(1, transitionCount))));
}

function transitionPrompts(prompt, segments) {
  const values = String(prompt || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (!values.length) return [];
  while (values.length < segments) values.push(values[values.length - 1]);
  return values.slice(0, segments);
}

function buildJimengImageArgs(prompt, model, size, imagePaths, submit, referenceRatio) {
  const useModel = model === undefined ? "jimeng-5.0Pro" : model;
  const useSize = size === undefined ? "1024x1024" : size;
  const images = imagePaths || [];
  const options = submit || {};
  const mode = images.length ? "image2image" : "text2image";
  const version = imageModelVersion(useModel, mode);
  const poll = Math.max(0, Math.min(600, Math.round(Number(options.pollSeconds == null ? 600 : options.pollSeconds) || 0)));
  // 源 :760：新版 dreamina CLI 省略 --ratio 会固定回退 16:9，必须显式传首张参考图比例。
  const args = images.length
    ? ["image2image", "--images=" + images.slice(0, 10).map(jimengPathArg).join(","), "--prompt=" + prompt, "--ratio=" + (referenceRatio || ratioFromSize(useSize)), "--resolution_type=" + imageResolution(useModel, useSize, mode), "--poll=" + poll]
    : ["text2image", "--prompt=" + prompt, "--ratio=" + ratioFromSize(useSize), "--resolution_type=" + imageResolution(useModel, useSize, mode), "--poll=" + poll];
  if (version) args.push("--model_version=" + version);
  return { command: mode, args };
}

function buildJimengVideoArgs(prompt, model, opts) {
  const useModel = model === undefined ? "seedance2.0fast" : model;
  const o = opts || {};
  const requestedVersion = videoModelVersion(useModel);
  const seedance25 = requestedVersion === "seedance2.5";
  const imagePaths = [...(o.imagePaths || []), ...(o.imagePath ? [o.imagePath] : [])].slice(0, seedance25 ? 30 : 20);
  const imageRoles = o.imageRoles || [];
  const videoPaths = (o.videoPaths || []).slice(0, seedance25 ? 10 : 3);
  const audioPaths = (o.audioPaths || []).slice(0, seedance25 ? 10 : 3);
  const poll = Math.max(0, Math.min(600, Math.round(Number(o.pollSeconds == null ? 600 : o.pollSeconds) || 0)));
  let command;
  let args;
  const firstIndex = imageRoles.findIndex((role) => String(role).toLowerCase() === "first_frame");
  const lastIndex = imageRoles.findIndex((role) => String(role).toLowerCase() === "last_frame");
  const explicitFirstLast = firstIndex >= 0 && lastIndex >= 0;
  const selectedModelSupportsMultimodal = JIMENG_VIDEO_MODELS_BY_COMMAND.multimodal2video.has(requestedVersion);
  if (explicitFirstLast) {
    command = "frames2video";
    const version = videoModelForCommand(useModel, command);
    args = [command, "--first=" + jimengPathArg(imagePaths[firstIndex]), "--last=" + jimengPathArg(imagePaths[lastIndex]), "--prompt=" + prompt, "--duration=" + videoDuration(o.duration, version, command), "--poll=" + poll, "--model_version=" + version, "--video_resolution=" + videoResolution(version, o.resolution)];
  } else if (o.multimodal || videoPaths.length || audioPaths.length || (selectedModelSupportsMultimodal && (imagePaths.length >= 2 || (imagePaths.length >= 1 && !!o.aspect_ratio)))) {
    if (!imagePaths.length && !videoPaths.length && !(seedance25 && audioPaths.length)) throw new Error("即梦全能参考至少需要一张图片或一个视频，音频不能单独生成视频；仅 Seedance 2.5 支持纯音频参考。");
    command = "multimodal2video";
    const version = videoModelForCommand(useModel, command);
    args = [command, "--prompt=" + prompt, "--duration=" + videoDuration(o.duration, version, command), "--poll=" + poll, "--ratio=" + videoRatio(o.aspect_ratio), "--model_version=" + version, "--video_resolution=" + videoResolution(version, o.resolution)];
    for (const item of imagePaths.slice(0, seedance25 ? 30 : 9)) args.push("--image=" + jimengPathArg(item));
    for (const item of videoPaths) args.push("--video=" + jimengPathArg(item));
    for (const item of audioPaths) args.push("--audio=" + jimengPathArg(item));
  } else if (imagePaths.length >= 2) {
    command = "multiframe2video";
    const segments = Math.max(1, imagePaths.length - 1);
    const duration = transitionDuration(o.duration, segments);
    args = [command, "--images=" + imagePaths.map(jimengPathArg).join(","), "--poll=" + poll, "--video_resolution=" + multiframeResolution(o.resolution)];
    if (imagePaths.length <= 2) {
      if (String(prompt || "").trim()) args.push("--prompt=" + prompt);
      args.push("--duration=" + duration);
    } else {
      for (const value of transitionPrompts(prompt, segments)) args.push("--transition-prompt=" + value);
      for (let i = 0; i < segments; i++) args.push("--transition-duration=" + duration);
    }
  } else if (imagePaths.length) {
    command = "image2video";
    const version = videoModelForCommand(useModel, command);
    // 源 :808：image2video 的画幅由输入图决定，dreamina 不提供 --ratio。
    args = [command, "--image=" + jimengPathArg(imagePaths[0]), "--prompt=" + prompt, "--duration=" + videoDuration(o.duration, version, command), "--poll=" + poll, "--model_version=" + version, "--video_resolution=" + videoResolution(version, o.resolution)];
  } else {
    command = "text2video";
    const version = videoModelForCommand(useModel, command);
    args = [command, "--prompt=" + prompt, "--duration=" + videoDuration(o.duration, version, command), "--ratio=" + videoRatio(o.aspect_ratio), "--poll=" + poll, "--model_version=" + version, "--video_resolution=" + videoResolution(version, o.resolution)];
  }
  return { command, args };
}

// ── 源 :818-936 媒体解析 / 失败原因 ───────────────────────────────

function submitId(raw) {
  if (!raw || typeof raw !== "object") return "";
  const found = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      if (["submit_id", "submitid", "task_id", "taskid"].includes(key.toLowerCase()) && item) found.push(String(item));
      else visit(item);
    }
  };
  visit(raw);
  return found[0] || "";
}

function collectMedia(value, out) {
  if (typeof value === "string") {
    const text = value.trim();
    // 源 :835-838：部分 dreamina 构建把 result_json 序列化成 JSON 字符串，
    // 不展开就会把已完成任务永远报成 pending。
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      try {
        collectMedia(JSON.parse(text), out);
        return;
      } catch { /* 继续按普通字符串处理 */ }
    }
    if (text && (text.startsWith("http://") || text.startsWith("https://") || text.startsWith("data:") || text.startsWith("file://") || text.startsWith("/mnt/") || /^[A-Za-z]:[\\/]/.test(text))) out.push(text);
  } else if (Array.isArray(value)) value.forEach((item) => collectMedia(item, out));
  else if (value && typeof value === "object") Object.entries(value).forEach(([, item]) => collectMedia(item, out));
}

function downloadedJimengMedia(submitIdValue, kind) {
  const id = String(submitIdValue || "").trim();
  const out = outputDir();
  if (!id || !fs.existsSync(out)) return [];
  const allowed = kind === "image" ? /\.(png|jpe?g|webp|gif|bmp)$/i
    : kind === "video" ? /\.(mp4|webm|mov|m4v|avi|mkv)$/i
      : /\.(mp3|wav|m4a|aac|flac|ogg)$/i;
  try {
    return fs.readdirSync(out, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(id + "_") && allowed.test(entry.name))
      .map((entry) => nodePath.join(out, entry.name));
  } catch {
    return [];
  }
}

function mimeFor(path, kind) {
  const ext = nodePath.extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  return kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png";
}

function mediaValueToDisplay(value, kind) {
  let text = String(value || "").trim();
  if (text.startsWith("http://") || text.startsWith("https://") || text.startsWith("data:")) return text;
  if (text.startsWith("file://")) text = decodeURIComponent(new URL(text).pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
  if (text.startsWith("/mnt/")) text = wslPathToWindows(text);
  if (!fs.existsSync(text)) return "";
  const data = fs.readFileSync(text).toString("base64");
  return "data:" + mimeFor(text, kind) + ";base64," + data;
}

function sleep(ms) {
  return config.clock.sleep(ms);
}

function jimengMediaUrlsFromRaw(raw, kind) {
  const values = [];
  collectMedia(raw, values);
  return [...new Set(values)].map((value) => mediaValueToDisplay(value, kind)).filter(Boolean);
}

function jimengTaskSucceeded(raw) {
  let succeeded = false;
  const visit = (value, key) => {
    const currentKey = key === undefined ? "" : key;
    if (succeeded || value == null) return;
    if (Array.isArray(value)) value.forEach((item) => visit(item, currentKey));
    else if (typeof value === "object") Object.entries(value).forEach(([nestedKey, item]) => visit(item, nestedKey));
    else if (/^(?:gen_status|task_status|status|state)$/i.test(currentKey) && /^(?:success|succeeded|completed|complete|finished|done)$/i.test(String(value).trim())) succeeded = true;
  };
  visit(raw, "");
  return succeeded;
}

function mediaUrlsFromRaw(raw, kind) {
  return jimengMediaUrlsFromRaw(raw, kind);
}

function failedTaskReason(raw) {
  const hits = [];
  const visit = (value, key) => {
    const currentKey = key === undefined ? "" : key;
    if (Array.isArray(value)) value.forEach((item) => visit(item, currentKey));
    else if (value && typeof value === "object") {
      for (const [k, item] of Object.entries(value)) visit(item, k);
    } else if (/status|state|error|message|reason/i.test(currentKey)) {
      const text = String(value == null ? "" : value).trim();
      if (/fail|error|cancel|reject|失败|错误|取消|拒绝/i.test(text)) hits.push({ key: currentKey, text });
    }
  };
  visit(raw, "");
  const generic = /^(fail(?:ed|ure)?|error|cancel(?:ed|led)?|reject(?:ed)?|失败|错误|取消|拒绝)$/i;
  const best = hits
    .sort((a, b) => {
      const aDetail = generic.test(a.text) ? 0 : 1;
      const bDetail = generic.test(b.text) ? 0 : 1;
      const aErrorKey = /error|message|reason/i.test(a.key) ? 1 : 0;
      const bErrorKey = /error|message|reason/i.test(b.key) ? 1 : 0;
      return bDetail - aDetail || bErrorKey - aErrorKey || b.text.length - a.text.length;
    })[0];
  return best ? best.text : "";
}

function jimengFailureMessage(raw) {
  const reason = failedTaskReason(raw);
  if (!reason) return "";
  const id = submitId(raw);
  const task = id ? "（submit_id=" + id + "）" : "";
  if (/^(?:generation failed:\s*)?final generation failed$/i.test(reason)) {
    return "即梦云端未完成生成，可能触发提示词、名人/版权内容审核，或云端生成失败。请调整提示词后重试" + task;
  }
  return "即梦任务失败：" + reason + task;
}

function queueInfo(raw) {
  let found = null;
  const visit = (value) => {
    if (found || value == null) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value !== "object") return;
    if (value.queue_info && typeof value.queue_info === "object" && !Array.isArray(value.queue_info)) {
      found = value.queue_info;
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(raw);
  return found || {};
}

// ── 源 :966-1065 排队中 / 查询 / 任务列表 ──────────────────────────

class JimengPendingError extends Error {
  constructor(submit_id, kind, queue_info, raw) {
    super("即梦任务仍在生成中，submit_id=" + submit_id);
    this.name = "JimengPendingError";
    this.submit_id = submit_id;
    this.kind = kind;
    this.queue_info = queue_info;
    this.raw = raw;
  }
}

function jimengPendingPayload(error) {
  const index = error.queue_info.queue_idx;
  const length = error.queue_info.queue_length;
  const hasQueuePosition = Number.isFinite(Number(index)) && Number(index) > 0
    && Number.isFinite(Number(length)) && Number(length) > 0;
  const queueText = hasQueuePosition
    ? "即梦云端排队中（第 " + index + "/" + length + " 位）"
    : "即梦云端生成中";
  return {
    jimeng_pending: true,
    status: "pending",
    submit_id: error.submit_id,
    kind: error.kind,
    queue_info: error.queue_info,
    queue_index: hasQueuePosition ? Number(index) : undefined,
    queue_total: hasQueuePosition ? Number(length) : undefined,
    queue_status: error.queue_info.queue_status,
    queue_text: queueText,
    updated_at: config.clock.now(),
    message: queueText + "，任务未丢失，可继续查询。submit_id=" + error.submit_id,
  };
}

async function storeOutputs(raw, kind, allowQuery) {
  if (!jimengExecutable()) throw cliUnavailableError();
  const querying = allowQuery === undefined ? true : allowQuery;
  const initialFailure = jimengFailureMessage(raw);
  if (initialFailure) throw new Error(initialFailure);
  const urls = mediaUrlsFromRaw(raw, kind);
  if (urls.length) return urls;
  const id = submitId(raw);
  if (id && querying) {
    const deadline = config.clock.now() + JIMENG_TEST_TIMEOUT_MS;
    let lastRaw = raw;
    let lastError = "";
    while (config.clock.now() < deadline) {
      const remaining = deadline - config.clock.now();
      try {
        const queried = await runJimengCli(["query_result", "--submit_id=" + id, "--download_dir=" + jimengPathArg(outputDir())], Math.min(60000, Math.max(1000, remaining)));
        if (isCliUnavailable(queried)) throw new Error(queried.detail);
        const queriedUrls = mediaUrlsFromRaw(queried, kind);
        if (queriedUrls.length) return queriedUrls;
        lastRaw = queried;
        const failed = jimengFailureMessage(queried);
        if (failed) throw new Error(failed);
      } catch (e) {
        lastError = String(e.message || e);
        if (!/生成中|pending|running|processing|queue|timeout|超时|result|结果|not.*ready/i.test(lastError)) throw e;
      }
      if (config.clock.now() < deadline) await sleep(Math.min(5000, Math.max(500, deadline - config.clock.now())));
    }
    const failed = jimengFailureMessage(lastRaw);
    if (failed) throw new Error(failed);
    if (lastError && !/超时/.test(lastError) && !/pending|running|processing|queue|result|结果|not.*ready/i.test(lastError)) throw new Error(lastError);
    throw new JimengPendingError(id, kind, queueInfo(lastRaw), lastRaw);
  }
  if (id) throw new JimengPendingError(id, kind, queueInfo(raw), raw);
  throw new Error("即梦 CLI 未返回可用" + (kind === "video" ? "视频" : "图片") + "结果");
}

/** 源 queryJimengMedia()：未安装时返回结构化错误。 */
async function queryJimengMedia(submitIdValue, kind) {
  const useKind = kind === undefined ? "image" : kind;
  const id = String(submitIdValue || "").trim();
  if (!id) throw new Error("缺少 submit_id");
  if (!jimengExecutable()) return cliUnavailable();
  let raw;
  try {
    raw = await runJimengCli(["query_result", "--submit_id=" + id, "--download_dir=" + jimengPathArg(outputDir())], 360000);
  } catch (error) {
    const message = String(error.message || error);
    if (/生成中|pending|running|processing|queue|not.*ready|超时/i.test(message)) {
      const pending = new JimengPendingError(id, useKind, {}, { message });
      return { ...jimengPendingPayload(pending), raw: pending.raw };
    } else throw error;
  }
  if (isCliUnavailable(raw)) return raw;
  let urls = mediaUrlsFromRaw(raw, useKind);
  // 源 :1044-1046：query_result 会把文件下载到 OUTPUT_DIR；部分视频模型（如
  // Seedance 2.0 Mini）上报成功却不回显本地路径，这里按 <submit_id>_* 兜底恢复。
  if (!urls.length) urls = downloadedJimengMedia(id, useKind).map((path) => mediaValueToDisplay(path, useKind)).filter(Boolean);
  if (urls.length) return { status: "succeeded", submit_id: id, kind: useKind, urls, raw };
  const failed = jimengFailureMessage(raw);
  if (failed) return { status: "failed", submit_id: id, kind: useKind, error: failed, raw };
  if (jimengTaskSucceeded(raw)) return {
    status: "failed",
    submit_id: id,
    kind: useKind,
    error: "即梦任务已完成，但 CLI 没有返回或下载可读取的" + (useKind === "video" ? "视频" : useKind === "audio" ? "音频" : "图片") + "文件。",
    raw,
  };
  const pending = new JimengPendingError(id, useKind, queueInfo(raw), raw);
  return { ...jimengPendingPayload(pending), raw };
}

/** 源 listJimengTasks()：未安装时返回结构化错误。 */
async function listJimengTasks() {
  if (!jimengExecutable()) return cliUnavailable();
  const raw = await runJimengCli(["list_task"], 30000);
  return { success: true, raw };
}

// ── 源 :1067-1138 生成 / 临时文件 / 放大 ───────────────────────────

/** 源 generateJimengImage()：未安装时返回结构化错误。 */
async function generateJimengImage(prompt, model, size, imagePaths, submit) {
  const useModel = model === undefined ? "jimeng-5.0Pro" : model;
  const useSize = size === undefined ? "1024x1024" : size;
  const images = imagePaths || [];
  const options = submit || {};
  if (!jimengExecutable()) return cliUnavailable();
  ensureDirs();
  try {
    let referenceRatio;
    if (images.length) {
      try { referenceRatio = await jimengReferenceImageRatio(images[0]); }
      catch { referenceRatio = ratioFromSize(useSize); }
    }
    const spec = buildJimengImageArgs(prompt, useModel, useSize, images, options, referenceRatio);
    const raw = await runJimengCli(spec.args, JIMENG_PROCESS_TIMEOUT_MS);
    if (isCliUnavailable(raw)) return raw;
    let urls = mediaUrlsFromRaw(raw, "image");
    if (!urls.length && options.deferPending) {
      const failed = jimengFailureMessage(raw);
      if (failed) throw new Error(failed);
      const id = submitId(raw);
      if (id) throw new JimengPendingError(id, "image", queueInfo(raw), raw);
    }
    if (!urls.length) urls = await storeOutputs(raw, "image");
    return { image: urls[0], images: urls, command: spec.command, raw, submit_id: submitId(raw) || undefined };
  } finally {
    for (const path of images) try { fs.unlinkSync(path); } catch { /* ignore */ }
  }
}

function tempMediaFile(buf, mime, fallbackExt) {
  ensureDirs();
  const type = mime === undefined ? "application/octet-stream" : mime;
  const ext = type.includes("png") ? ".png" : type.includes("jpeg") || type.includes("jpg") ? ".jpg" : type.includes("webp") ? ".webp" : type.includes("mp4") ? ".mp4" : (fallbackExt === undefined ? ".bin" : fallbackExt);
  const file = nodePath.join(TEMP_DIR, randomUUID() + ext);
  fs.writeFileSync(file, buf);
  return file;
}

/** 源 upscaleJimengImage()：未安装时返回结构化错误。 */
async function upscaleJimengImage(imagePath, resolution, submit) {
  const options = submit || {};
  if (!jimengExecutable()) return cliUnavailable();
  ensureDirs();
  const value = String(resolution || "").trim().toLowerCase();
  const normalized = new Set(["2k", "4k", "8k"]).has(value) ? value : "2k";
  try {
    const poll = Math.max(0, Math.min(600, Math.round(Number(options.pollSeconds == null ? 600 : options.pollSeconds) || 0)));
    const raw = await runJimengCli(["image_upscale", "--image=" + jimengPathArg(imagePath), "--resolution_type=" + normalized, "--poll=" + poll], JIMENG_PROCESS_TIMEOUT_MS);
    if (isCliUnavailable(raw)) return raw;
    let images = mediaUrlsFromRaw(raw, "image");
    if (!images.length && options.deferPending) {
      const failed = failedTaskReason(raw);
      if (failed) throw new Error("即梦任务失败：" + failed);
      const id = submitId(raw);
      if (id) throw new JimengPendingError(id, "image", queueInfo(raw), raw);
    }
    if (!images.length) images = await storeOutputs(raw, "image");
    return { image: images[0], images, command: "image_upscale", raw, submit_id: submitId(raw) || undefined };
  } finally {
    try { fs.unlinkSync(imagePath); } catch { /* ignore */ }
  }
}

/** 源 generateJimengVideo()：未安装时返回结构化错误。 */
async function generateJimengVideo(prompt, model, opts) {
  const useModel = model === undefined ? "seedance2.0fast" : model;
  const o = opts || {};
  if (!jimengExecutable()) return cliUnavailable();
  ensureDirs();
  const cleanup = [...(o.imagePaths || []), ...(o.imagePath ? [o.imagePath] : []), ...(o.videoPaths || []), ...(o.audioPaths || [])];
  try {
    const spec = buildJimengVideoArgs(prompt, useModel, o);
    const raw = await runJimengCli(spec.args, JIMENG_PROCESS_TIMEOUT_MS);
    if (isCliUnavailable(raw)) return raw;
    let videos = mediaUrlsFromRaw(raw, "video");
    if (!videos.length && o.deferPending) {
      const failed = failedTaskReason(raw);
      if (failed) throw new Error("即梦任务失败：" + failed);
      const id = submitId(raw);
      if (id) throw new JimengPendingError(id, "video", queueInfo(raw), raw);
    }
    if (!videos.length) videos = await storeOutputs(raw, "video");
    return { videos, command: spec.command, raw, submit_id: submitId(raw) || undefined };
  } finally {
    for (const path of cleanup) try { fs.unlinkSync(path); } catch { /* ignore */ }
  }
}

// ── 导出（源 export 清单 + 本批 DI/探测辅助）───────────────────────

module.exports = {
  // 常量
  CLI_UNAVAILABLE,
  SHARP_UNAVAILABLE,
  MIN_JIMENG_VERSION,
  JIMENG_TEST_TIMEOUT_MS,
  JIMENG_PROCESS_TIMEOUT_MS,
  JIMENG_MODEL_FALLBACK,
  JIMENG_VIDEO_HIGH_RES_MODELS,
  JIMENG_VIDEO_MODELS_BY_COMMAND,
  // 依赖注入
  configureAgentCliTools,
  resetAgentCliTools,
  getAgentCliToolsConfig,
  probeJimengCli,
  refreshJimengProbe,
  probeSharp,
  requireSharp,
  // 源 export 清单（server/cliTools.ts）
  jimengCliInstalled,
  runJimengCli,
  jimengStatus,
  jimengCredit,
  jimengLogout,
  jimengLoginStart,
  jimengLoginStatus,
  jimengHelp,
  jimengModelsFromHelp,
  jimengModels,
  jimengImageRatioFromDimensions,
  buildJimengImageArgs,
  buildJimengVideoArgs,
  jimengMediaUrlsFromRaw,
  jimengTaskSucceeded,
  jimengFailureMessage,
  JimengPendingError,
  jimengPendingPayload,
  queryJimengMedia,
  listJimengTasks,
  generateJimengImage,
  tempMediaFile,
  upscaleJimengImage,
  generateJimengVideo,
  // 源内部函数（同名单列，便于逐函数对照与测试）
  ensureDirs,
  ensureCliHome,
  envValue,
  useWsl,
  findOnPath,
  decode,
  cleanWslStderr,
  shellQuote,
  wslBaseArgs,
  bundledNativeJimeng,
  bundledWslJimeng,
  windowsPathToWsl,
  wslPathToWindows,
  jimengExecutable,
  jimengRuntimeSource,
  jimengUsesHostLogin,
  sameExecutable,
  managedJimengLoginStatePresent,
  rememberManagedJimengLogin,
  jimengRuntime,
  jimengPathArg,
  jimengCommand,
  runProcess,
  extractJson,
  parseVersion,
  jimengVersion,
  versionOk,
  loginText,
  qrFromText,
  jimengTokenSnapshot,
  loginInfoFromText,
  loginPayload,
  attachLoginReaders,
  refreshJimengModels,
  parseSize,
  ratioFromDimensions,
  ratioFromSize,
  normalizeImageModel,
  imageModelVersion,
  imageResolution,
  videoModelVersion,
  videoModelForCommand,
  videoResolution,
  multiframeResolution,
  videoDuration,
  videoRatio,
  transitionDuration,
  transitionPrompts,
  submitId,
  collectMedia,
  downloadedJimengMedia,
  mimeFor,
  mediaValueToDisplay,
  mediaUrlsFromRaw,
  jimengReferenceImageRatio,
  sleep,
  failedTaskReason,
  queueInfo,
  storeOutputs,
  isCliUnavailable,
  cliUnavailable,
  outputDir,
  cliHomeDir,
  cliRuntimeDir,
  currentDataDir,
};
