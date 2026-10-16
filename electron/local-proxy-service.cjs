/**
 * 本机代理探测 · 装配与分发（唯一执行入口；所有 IO 集中在这一层）。
 *
 * 移植自只读源 server/localProxyDetection.ts:56-115 + server/index.ts:5893-5901：
 *   · 源:56-67  windowsVpnCandidates —— netstat.exe + powershell.exe
 *   · 源:69-94  localProxyCandidates —— configured / env / 平台分支 / 去重 / slice(0,12)
 *   · 源:96-110 probeLocalProxy —— 子进程 + NODE_USE_ENV_PROXY 探测
 *   · 源:112-115 detectLocalProxies —— 候选 → 逐个探测
 *   · 源 index.ts:5893-5901 POST /api/desktop/proxy/detect → 本域 desktop/proxy/detect
 *
 * 边界：
 *   · **只扫回环地址**：win32 只收 127.0.0.1 / [::1] 的 LISTENING；lsof / /proc 同样只收回环。
 *   · **只识别与本机代理相关的进程**：进程名必须命中 VPN_PROCESS（或 linux /proc 下 comm 命中）；
 *     其它进程只用于"哪条回环监听属于哪个 inode"的定位，不保留、不返回其信息。
 *   · **默认零出网**：只有 payload.probe === true 才进入 probeCandidate；否则 network.attempted=false。
 *   · 每个来源的失败都进 unavailable[]，不静默：命令仍结构化成功，失败信息可见。
 *   · 无新增依赖：只用 node:child_process / node:util / node:fs。
 */
"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");

const localProxyDomain = require("./local-proxy-domain.cjs");

const {
  GOOGLE_MODELS_URL,
  VPN_PROCESS,
  MAX_CANDIDATES,
  LOCAL_PROXY_TARGET,
  parseWindowsLoopbackListeners,
  parseWindowsProcessNames,
  parseMacLoopbackListeners,
  parseMacSystemProxy,
  parseWindowsSystemProxy,
  parseLinuxProcNetLoopbackListeners,
  parseProcFdTarget,
  buildInodePidIndex,
  proxyCandidate,
  appendCandidate,
  clampProbeTimeout,
  buildProbeScript,
  buildProbeEnv,
  createLocalProxyError,
  isLocalProxyCommand,
  localProxyCommandNotAllowed,
  normalizeLocalProxyError,
  redactLocalProxyValue,
  listLocalProxyCommands,
  LOCAL_PROXY_ERR_INVALID_INPUT,
} = localProxyDomain;

/** 本文件唯一实现的命令（命令表由 local-proxy-domain.cjs 冻结）。 */
const DETECT_COMMAND = "desktop/proxy/detect";

/** 源 index.ts:5897 的 target / requiresRestart 字段。 */
const PROBE_HOST = "generativelanguage.googleapis.com";
const MAX_PROC_PIDS = 4000;
const MAX_PROC_FDS = 256;

function describeError(error, fallback) {
  if (error && typeof error === "object") {
    const raw = error.stderr || error.code || error.message;
    const text = String(raw == null ? "" : raw).trim();
    return (text || fallback).slice(0, 120);
  }
  const text = String(error == null ? "" : error).trim();
  return (text || fallback).slice(0, 120);
}

function isValidStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function createLocalProxyService(options = {}) {
  const injectedExecFile = typeof options.execFile === "function" ? options.execFile : promisify(execFile);
  const injectedFetch = typeof options.fetch === "function" ? options.fetch : null;
  const injectedFs = options.fs && typeof options.fs.readFileSync === "function" ? options.fs : fs;
  const platform = typeof options.platform === "string" && options.platform ? options.platform : process.platform;
  const baseEnv = options.env && typeof options.env === "object" ? options.env : process.env;
  const execPath = typeof options.execPath === "string" && options.execPath ? options.execPath : process.execPath;
  const getConfiguredProxy = typeof options.getConfiguredProxy === "function" ? options.getConfiguredProxy : () => "";
  const logger = typeof options.logger === "function" ? options.logger : null;

  // -------------------------------------------------------------------------
  // 候选枚举（configured / env / 平台分支）—— 源:69-94
  // -------------------------------------------------------------------------

  /** 源:76 —— 环境变量优先级：HTTPS_PROXY > https_proxy > HTTP_PROXY > http_proxy。 */
  function environmentProxyValue() {
    return baseEnv.HTTPS_PROXY || baseEnv.https_proxy || baseEnv.HTTP_PROXY || baseEnv.http_proxy || "";
  }

  /** 源:71-74 add() 的两个"恒定来源"：当前配置 + 启动环境。 */
  function collectConfiguredAndEnvironment(unavailable) {
    let list = [];
    try {
      list = appendCandidate(list, proxyCandidate(getConfiguredProxy(), "当前设置", "configured"));
    } catch (error) {
      unavailable.push({ source: "当前设置", reason: describeError(error, "读取已配置代理失败") });
    }
    return appendCandidate(list, proxyCandidate(environmentProxyValue(), "启动环境", "env"));
  }

  /** 源:56-67 —— win32：netstat 列回环 LISTENING → powershell 查进程名 → 只留 VPN_PROCESS。 */
  async function collectWindowsVpnCandidates(unavailable) {
    let stdout;
    try {
      ({ stdout } = await injectedExecFile("netstat.exe", ["-ano", "-p", "tcp"], { timeout: 4000, maxBuffer: 2_000_000, windowsHide: true }));
    } catch (error) {
      unavailable.push({ source: "netstat.exe -ano -p tcp", reason: describeError(error, "netstat 不可用") });
      return [];
    }
    const listeners = parseWindowsLoopbackListeners(stdout);
    const pids = [...new Set(listeners.map((item) => item.pid))].slice(0, 200);
    if (!pids.length) return [];
    const command = "Get-Process -Id " + pids.join(",") + " -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id)|$($_.ProcessName)\" }";
    let names;
    try {
      names = parseWindowsProcessNames((await injectedExecFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 4000, maxBuffer: 100_000, windowsHide: true })).stdout);
    } catch (error) {
      unavailable.push({ source: "powershell.exe Get-Process", reason: describeError(error, "进程名查询不可用") });
      return [];
    }
    return listeners
      .filter((item) => VPN_PROCESS.test(names.get(item.pid) || ""))
      .map((item) => proxyCandidate("http://127.0.0.1:" + item.port, names.get(item.pid), "process"))
      .filter(Boolean);
  }

  /** 源:77-82 —— win32：注册表系统代理 + 代理进程。 */
  async function collectWindowsCandidates(unavailable) {
    const out = [];
    try {
      const { stdout } = await injectedExecFile("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { timeout: 3000, maxBuffer: 100_000, windowsHide: true });
      const candidate = proxyCandidate(parseWindowsSystemProxy(stdout), "Windows 系统代理", "system");
      if (candidate) out.push(candidate);
    } catch (error) {
      unavailable.push({ source: "Windows 系统代理", reason: describeError(error, "注册表系统代理不可用") });
    }
    out.push(...await collectWindowsVpnCandidates(unavailable));
    return out;
  }

  /** 源:83-92 —— darwin：scutil 系统代理 + lsof 回环监听进程。 */
  async function collectDarwinCandidates(unavailable) {
    const out = [];
    try {
      const { stdout } = await injectedExecFile("scutil", ["--proxy"], { timeout: 3000, maxBuffer: 100_000 });
      const candidate = proxyCandidate(parseMacSystemProxy(stdout), "macOS 系统代理", "system");
      if (candidate) out.push(candidate);
    } catch (error) {
      unavailable.push({ source: "macOS 系统代理", reason: describeError(error, "scutil 不可用") });
    }
    try {
      const { stdout } = await injectedExecFile("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { timeout: 4000, maxBuffer: 500_000 });
      for (const item of parseMacLoopbackListeners(stdout)) {
        const candidate = proxyCandidate(item.url, item.source, "process");
        if (candidate) out.push(candidate);
      }
    } catch (error) {
      unavailable.push({ source: "lsof -nP -iTCP -sTCP:LISTEN", reason: describeError(error, "lsof 不可用") });
    }
    return out;
  }

  /**
   * linux：优先 lsof（输出列与 macOS 同，parseMacLoopbackListeners 直接复用）；
   * lsof 无结果时退回 /proc。只保留 comm 命中 VPN_PROCESS 的回环监听。
   */
  async function collectLinuxProcCandidates(unavailable) {
    const listeners = [];
    for (const item of [{ family: 4, file: "/proc/net/tcp" }, { family: 6, file: "/proc/net/tcp6" }]) {
      try {
        listeners.push(...parseLinuxProcNetLoopbackListeners(injectedFs.readFileSync(item.file, "utf8"), item.family));
      } catch (error) {
        unavailable.push({ source: item.file, reason: describeError(error, item.file + " 不可读") });
      }
    }
    if (!listeners.length) return [];
    let dirents;
    try {
      dirents = injectedFs.readdirSync("/proc", { withFileTypes: true }).filter((entry) => entry && entry.isDirectory() && /^\d+$/.test(entry.name)).slice(0, MAX_PROC_PIDS);
    } catch (error) {
      unavailable.push({ source: "/proc", reason: describeError(error, "/proc 不可读") });
      return [];
    }
    const wanted = new Map(listeners.map((item) => [item.inode, item]));
    const fdEntries = [];
    for (const dirent of dirents) {
      let fds;
      try { fds = injectedFs.readdirSync("/proc/" + dirent.name + "/fd"); } catch { continue; }
      for (const fd of Array.isArray(fds) ? fds.slice(0, MAX_PROC_FDS) : []) {
        let target;
        try { target = injectedFs.readlinkSync("/proc/" + dirent.name + "/fd/" + fd); } catch { continue; }
        const inode = parseProcFdTarget(target);
        if (inode != null && wanted.has(inode)) fdEntries.push({ pid: Number(dirent.name), target });
      }
    }
    const inodeToPid = buildInodePidIndex(fdEntries);
    const out = [];
    for (const [inode, listener] of wanted) {
      const pid = inodeToPid.get(inode);
      if (!pid) continue;
      let comm = "";
      try { comm = String(injectedFs.readFileSync("/proc/" + pid + "/comm", "utf8")).trim(); } catch { continue; }
      if (!VPN_PROCESS.test(comm)) continue;
      const candidate = proxyCandidate("http://127.0.0.1:" + listener.port, comm, "process");
      if (candidate) out.push(candidate);
    }
    return out;
  }

  async function collectLinuxCandidates(unavailable) {
    const out = [];
    try {
      const { stdout } = await injectedExecFile("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { timeout: 4000, maxBuffer: 500_000 });
      for (const item of parseMacLoopbackListeners(stdout)) {
        const candidate = proxyCandidate(item.url, item.source, "process");
        if (candidate) out.push(candidate);
      }
    } catch (error) {
      unavailable.push({ source: "lsof -nP -iTCP -sTCP:LISTEN", reason: describeError(error, "lsof 不可用") });
    }
    if (out.length) return out;
    return collectLinuxProcCandidates(unavailable);
  }

  /** 源:69-94 主体：三种来源合并 + 去重 + 上限 12。 */
  async function enumerateCandidates() {
    const unavailable = [];
    let candidates = collectConfiguredAndEnvironment(unavailable);
    let platformCandidates = [];
    if (platform === "win32") platformCandidates = await collectWindowsCandidates(unavailable);
    else if (platform === "darwin") platformCandidates = await collectDarwinCandidates(unavailable);
    else platformCandidates = await collectLinuxCandidates(unavailable);
    for (const candidate of platformCandidates) candidates = appendCandidate(candidates, candidate, MAX_CANDIDATES);
    return { candidates, unavailable };
  }

  // -------------------------------------------------------------------------
  // 可达性探测（**仅在显式 probe=true 时进入**）—— 源:96-110
  // -------------------------------------------------------------------------

  /** 注入 fake fetch 的探测路径（测试与嵌入用）；语义与源一致，含"无效的上游响应"。 */
  async function probeWithFetch(candidate, timeoutMs) {
    const started = Date.now();
    try {
      const signal = typeof AbortSignal === "object" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
      const response = await injectedFetch(GOOGLE_MODELS_URL, { method: "GET", signal, proxyUrl: candidate.url });
      const status = Number(response && response.status);
      if (!isValidStatus(status)) throw new Error("无效的上游响应");
      return { ...candidate, reachable: true, status, latencyMs: Date.now() - started };
    } catch (error) {
      const failure = error && typeof error === "object" ? error : {};
      const reason = (failure.cause && failure.cause.code) || failure.code || failure.message || failure.name;
      return { ...candidate, reachable: false, error: String(reason || "连接失败").trim().slice(0, 120) };
    }
  }

  /** 源:96-110 —— 真实路径：起一个独立 node/Electron-run-as-node 子进程带代理环境做 fetch。 */
  async function probeWithChildProcess(candidate, timeoutMs) {
    const started = Date.now();
    try {
      const { stdout } = await injectedExecFile(execPath, ["-e", buildProbeScript(GOOGLE_MODELS_URL, timeoutMs)], {
        env: buildProbeEnv(baseEnv, candidate.url),
        timeout: timeoutMs + 2000,
        maxBuffer: 2000,
        windowsHide: true,
      });
      const status = Number(JSON.parse(String(stdout).trim()).status);
      if (!isValidStatus(status)) throw new Error("无效的上游响应");
      return { ...candidate, reachable: true, status, latencyMs: Date.now() - started };
    } catch (error) {
      return { ...candidate, reachable: false, error: describeError(error, "连接失败") };
    }
  }

  /** 失败一定结构化返回（reachable:false + error），绝不静默成功、绝不抛穿。 */
  async function probeCandidate(candidate, timeoutMs) {
    try {
      return injectedFetch ? await probeWithFetch(candidate, timeoutMs) : await probeWithChildProcess(candidate, timeoutMs);
    } catch (error) {
      return { ...candidate, reachable: false, error: describeError(error, "连接失败") };
    }
  }

  // -------------------------------------------------------------------------
  // 命令体
  // -------------------------------------------------------------------------

  async function detect(payload) {
    const input = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    if (Object.prototype.hasOwnProperty.call(input, "probe") && typeof input.probe !== "boolean") {
      throw createLocalProxyError(LOCAL_PROXY_ERR_INVALID_INPUT, "probe 必须是布尔值（只有显式 true 才发起可达性探测）");
    }
    const probeEnabled = input.probe === true;
    const timeoutMs = clampProbeTimeout(input.timeoutMs);
    const { candidates, unavailable } = await enumerateCandidates();
    const probes = [];
    if (probeEnabled) {
      for (const candidate of candidates) probes.push(await probeCandidate(candidate, timeoutMs));
    }
    return {
      command: DETECT_COMMAND,
      target: LOCAL_PROXY_TARGET,
      requiresRestart: true,
      probeEnabled,
      timeoutMs,
      loopbackOnly: true,
      candidateCount: candidates.length,
      candidates,
      probes,
      unavailable,
      network: probeEnabled
        ? { attempted: true, url: GOOGLE_MODELS_URL, host: PROBE_HOST, via: "candidate-proxy", probed: probes.length }
        : { attempted: false, reason: "probe-not-enabled", url: GOOGLE_MODELS_URL },
    };
  }

  /** 唯一执行入口：白名单 → 分发 → 成功 {ok:true,value} / 失败 normalizeLocalProxyError。 */
  async function execute(command, payload) {
    try {
      if (!isLocalProxyCommand(command) || command !== DETECT_COMMAND) throw localProxyCommandNotAllowed(command);
      return { ok: true, value: redactLocalProxyValue(await detect(payload)) };
    } catch (error) {
      if (logger) { try { logger("[OpenArc local-proxy] " + describeError(error, "执行失败")); } catch { /* 日志失败不改变行为 */ } }
      return normalizeLocalProxyError(error);
    }
  }

  return {
    platform,
    execute,
    detect,
    listCommands: listLocalProxyCommands,
  };
}

module.exports = { createLocalProxyService, DETECT_COMMAND };
