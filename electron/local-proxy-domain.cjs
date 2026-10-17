/**
 * 本机代理探测 · 域纯逻辑（无 IO、无网络、无子进程）。
 *
 * 逐字移植（行号为只读源 server/localProxyDetection.ts 的行号）：
 *   · 源:5      GOOGLE_MODELS_URL
 *   · 源:6      VPN_PROCESS（常见代理进程名正则，逐字）
 *   · 源:11-18  parseWindowsLoopbackListeners —— netstat 文本解析，正则与语义逐字
 *   · 源:20-22  parseWindowsProcessNames
 *   · 源:24-29  parseMacLoopbackListeners —— lsof 文本解析（darwin 与 linux 共用）
 *   · 源:31-37  parseMacSystemProxy
 *   · 源:39-45  proxyUrl
 *   · 源:47-54  parseWindowsSystemProxy
 *   · 源:100-101 probe 子进程环境变量（buildProbeEnv）
 *   · 源:98     probe 子进程脚本（buildProbeScript）
 *
 * 源只在 win32 / darwin 有分支；本移植按任务书补 linux：优先 lsof（输出格式与 macOS 同），
 * lsof 不可用时退回 /proc（parseLinuxProcNetLoopbackListeners + parseProcFdTarget + buildInodePidIndex）。
 *
 * 常见代理进程名：mihomo/clash/verge/v2ray/sing-box/singbox/shadowsocks/nekoray/hiddify/flclash/surge。
 * 所有解析函数都是**纯函数**：只吃字符串、只吐数据，可直接单测。
 *
 * 失败形状与 platform 域一致：createLocalProxyError / normalizeLocalProxyError 复用
 * electron/dxos-foundation-errors.cjs 的脱敏与错误规约，不产生第二套错误协议。
 */
"use strict";

const foundationErrors = require("./dxos-foundation-errors.cjs");

/** 源:5 —— 探测目标（Google Gemini 模型列表）。 */
const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/** 源:6 —— 逐字：常见代理进程名。 */
const VPN_PROCESS = /(?:mihomo|clash|verge|v2ray|sing-box|singbox|shadowsocks|nekoray|hiddify|flclash|surge)/i;

/** 源:93 —— 候选上限（.slice(0, 12)）。 */
const MAX_CANDIDATES = 12;

const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 15000;

/** 源:100 —— 探测子进程的 NO_PROXY，回环地址永远直连（不得把探测自身再塞进代理）。 */
const PROBE_NO_PROXY = "127.0.0.1,localhost,::1";

/** linux /proc/net/tcp(6) 的回环地址字面量（每 4 字节小端后的十六进制形态）。 */
const LINUX_LOOPBACK_HEX = Object.freeze({
  4: Object.freeze(["0100007F"]),
  6: Object.freeze([
    "00000000000000000000000001000000", // ::1
    "0000000000000000FFFF00000100007F", // ::ffff:127.0.0.1
  ]),
});

/** 本机代理域自有错误码。与 PLATFORM_* / DXOS_* 并列，不合并（域边界清晰，便于渲染层稳定判别）。 */
const LOCAL_PROXY_ERR_COMMAND_NOT_ALLOWED = "LOCAL_PROXY_COMMAND_NOT_ALLOWED";
const LOCAL_PROXY_ERR_INVALID_INPUT = "LOCAL_PROXY_INVALID_INPUT";
const LOCAL_PROXY_ERR_INTERNAL = "LOCAL_PROXY_INTERNAL";
const LOCAL_PROXY_ERR_DEPENDENCY_UNAVAILABLE = "LOCAL_PROXY_DEPENDENCY_UNAVAILABLE";

const LOCAL_PROXY_ERROR_CODES = Object.freeze([
  LOCAL_PROXY_ERR_COMMAND_NOT_ALLOWED,
  LOCAL_PROXY_ERR_INVALID_INPUT,
  LOCAL_PROXY_ERR_INTERNAL,
  LOCAL_PROXY_ERR_DEPENDENCY_UNAVAILABLE,
]);

/** 探测目标的中文标签（源 index.ts:5897 的 target 字段）。 */
const LOCAL_PROXY_TARGET = Object.freeze({
  id: "google-gemini-models",
  label: "Google Gemini 模型列表",
  url: GOOGLE_MODELS_URL,
});

/**
 * desktop:command 白名单（命令表即白名单，未知命令不进入动态 dispatch）。
 *
 *   risk       external —— 本命令在 probe=true 时会访问 generativelanguage.googleapis.com，**会出网**。
 *              任务书要求"网络可达性探测默认关闭"，因此：
 *                · 未显式 probe=true 时只在本机读回环监听/系统代理/环境变量，零出网；
 *                · 命令元数据仍标 external（fail-closed：能出网的命令一律按 external 报）。
 *   credential 恒为 false：探测子进程只带代理地址，不带任何凭据。
 *   network    出网边界的显式声明，供 UI / 审计展示。
 */
const LOCAL_PROXY_COMMANDS = Object.freeze({
  // task-22：手动代理保存 / 清除 / 状态读取（只登记 + 可选出网层应用；不接触凭据）。
  "desktop/proxy/set": {
    risk: "write",
    credential: false,
    probesExternal: false,
    network: Object.freeze({ default: "off", note: "保存代理配置；若宿主注入 applyProxy，会应用到 Electron 网络栈（模型域仍走 model/proxy/set）" }),
    summary: "保存手动代理地址（仅 http/https、无内嵌凭据）；写入 userData 配置（safeStorage 可用时加密），并尽力应用到 Electron 网络栈",
  },
  "desktop/proxy/clear": {
    risk: "delete",
    credential: false,
    probesExternal: false,
    network: Object.freeze({ default: "off", note: "删除手动代理配置并恢复直连" }),
    summary: "清除手动代理配置，并在宿主注入 applyProxy 时恢复 Electron 网络栈直连",
  },
  "desktop/proxy/state": {
    risk: "read",
    credential: false,
    probesExternal: false,
    network: Object.freeze({ default: "off" }),
    summary: "读取手动代理状态：是否已配置、地址、是否已作用到出网层、存储方式",
  },
  // task-8 A：局域网协作（默认关闭；显式 start 才监听 0.0.0.0 随机端口；一次性配对码/令牌）。
  "desktop/lan/status": {
    risk: "read", credential: false, probesExternal: false,
    network: Object.freeze({ default: "off", note: "只读局域网协作状态（不发起网络请求）" }),
    summary: "读取局域网协作状态：是否监听、端口、配对码有效期、在线客户端与令牌数量",
  },
  "desktop/lan/start": {
    risk: "write", credential: false, probesExternal: false,
    network: Object.freeze({ default: "off", note: "显式开启后才在 0.0.0.0 随机端口监听；默认关闭" }),
    summary: "显式开启局域网协作服务（opt-in）：监听 0.0.0.0 随机端口；未配对连接一律拒绝",
  },
  "desktop/lan/stop": {
    risk: "write", credential: false, probesExternal: false,
    network: Object.freeze({ default: "off" }),
    summary: "关闭局域网协作服务并清空配对码 / 令牌 / 房间",
  },
  "desktop/lan/pairing/create": {
    risk: "write", credential: false, probesExternal: false,
    network: Object.freeze({ default: "off" }),
    summary: "生成一次性局域网配对码（10 分钟有效，只返回一次；可绑定单个画布）",
  },
  "desktop/lan/pair": {
    risk: "write", credential: false, probesExternal: false,
    network: Object.freeze({ default: "off" }),
    summary: "用一次性配对码换取局域网令牌（只返回一次；默认只读，可绑定单个画布）",
  },
  // task-22：缓存清理（只删 dxos 下 cache/temp 目录内容；不碰凭据 / 数据库）。
  "desktop/cache/clear": {
    risk: "destructive",
    credential: false,
    probesExternal: false,
    network: Object.freeze({ default: "off" }),
    summary: "扫描并清理 <userData>/dxos 下的 cache/temp/tmp 目录（跳过凭据、数据库与备份），返回释放字节数",
  },
  // task-22：系统更新检查（只检查 / 下载，绝不静默安装）。
  "desktop/update/check": {
    risk: "external",
    credential: false,
    probesExternal: true,
    network: Object.freeze({ default: "off", enableWith: "explicit-call", note: "仅用户显式检查时访问配置的更新源（GitHub Releases / ModelScope）" }),
    summary: "检查系统更新：读取当前版本与可配置的更新源，返回是否有新版本与下载信息（不安装）",
  },
  "desktop/update/download": {
    risk: "external",
    credential: false,
    probesExternal: true,
    network: Object.freeze({ default: "off", enableWith: "explicit-call", note: "只下载安装包到 <userData>/dxos/updates/downloads，不执行、不安装" }),
    summary: "下载系统更新安装包到本地目录（只下载，不静默安装）",
  },
  "desktop/update/source/get": {
    risk: "read",
    credential: false,
    probesExternal: false,
    network: Object.freeze({ default: "off" }),
    summary: "读取系统更新源配置（kind / owner / repo / channel）",
  },
  "desktop/update/source/set": {
    risk: "write",
    credential: false,
    probesExternal: false,
    network: Object.freeze({ default: "off" }),
    summary: "配置系统更新源（github-releases 或 modelscope-repo，只允许白名单仓库与主机）",
  },
  "desktop/proxy/detect": {
    risk: "external",
    credential: false,
    probesExternal: true,
    network: Object.freeze({
      default: "off",
      enableWith: "probe=true",
      method: "POST-equivalent",
      host: "generativelanguage.googleapis.com",
      url: GOOGLE_MODELS_URL,
      note: "仅当显式传入 probe=true 时发起；默认只扫本机回环监听与系统/环境代理设置",
    }),
    summary: "扫描本机回环监听端口并识别常见代理进程（mihomo/clash/v2ray 等）；显式 probe=true 时才访问 Google Gemini 模型列表 URL 验证可达性（会出网）",
  },
});

/** 只要字符串前缀，非法类型一律当空串（纯函数对非法输入返回空结果，而不是抛出）。 */
const asText = (value) => (typeof value === "string" ? value : "");

// ---------------------------------------------------------------------------
// 逐字移植的解析函数（源 server/localProxyDetection.ts）
// ---------------------------------------------------------------------------

/**
 * 源:11-18 —— 逐字正则与语义：只认 TCP 回环（127.0.0.1 / [::1]）的 LISTENING 行，
 * 端口 1..65535、pid > 0。非字符串输入按空文本处理（空结果，不抛）。
 */
function parseWindowsLoopbackListeners(output) {
  const text = asText(output);
  const listeners = [];
  for (const match of text.matchAll(/^\s*TCP\s+(?:127\.0\.0\.1|\[::1\]):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/gim)) {
    const port = Number(match[1]); const pid = Number(match[2]);
    if (port > 0 && port <= 65535 && pid > 0) listeners.push({ port, pid });
  }
  return listeners;
}

/** 源:20-22 —— 逐字：解析 powershell "Id|ProcessName" 输出。 */
function parseWindowsProcessNames(output) {
  const text = asText(output);
  return new Map([...text.matchAll(/^(\d+)\|([^\r\n|]+)$/gm)].map((match) => [Number(match[1]), match[2].trim()]));
}

/**
 * 源:24-29 —— 逐字：解析 lsof -nP -iTCP -sTCP:LISTEN 输出，只保留命令名命中 VPN_PROCESS 的行。
 * darwin 与 linux 共用（lsof 输出列格式一致）。
 */
function parseMacLoopbackListeners(output) {
  const text = asText(output);
  return text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(\S+)\s+\d+\s+.*\bTCP\s+(?:127\.0\.0\.1|\[::1\]):(\d+)\s+\(LISTEN\)/);
    return match && VPN_PROCESS.test(match[1]) ? [{ url: "http://127.0.0.1:" + match[2], source: match[1] }] : [];
  });
}

/** 源:31-37 —— 逐字：scutil --proxy 文本解析。 */
function parseMacSystemProxy(output) {
  const text = asText(output);
  const values = Object.fromEntries([...text.matchAll(/^\s*(\w+)\s*:\s*(.*?)\s*$/gm)].map((match) => [match[1], match[2]]));
  if (values.HTTPSEnable !== "1" && values.HTTPEnable !== "1") return "";
  const host = values.HTTPSEnable === "1" ? values.HTTPSProxy : values.HTTPProxy;
  const port = values.HTTPSEnable === "1" ? values.HTTPSPort : values.HTTPPort;
  return proxyUrl(host && port ? "http://" + host + ":" + port : "");
}

/** 源:39-45 —— 逐字：只接受 http/https、必须有主机名、不得内嵌凭据，去掉尾部斜杠。 */
function proxyUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return "";
    return parsed.toString().replace(/\/$/, "");
  } catch { return ""; }
}

/**
 * task-22：手动代理地址校验（比探测用的 proxyUrl 更严格，因为要落配置）。
 * 只接受 http/https 源、必须有主机名、不得内嵌凭据、不得带路径/查询/片段；
 * 返回 {ok,url} 或 {ok:false,reason}（reason 给用户看，不含原始输入里的敏感部分）。
 */
function normalizeManualProxyUrl(value) {
  if (typeof value !== "string" || !value.trim()) return { ok: false, reason: "代理地址不能为空" };
  let parsed;
  try { parsed = new URL(value.trim()); }
  catch { return { ok: false, reason: "代理地址不是合法 URL" }; }
  if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, reason: "代理地址只允许 http:// 或 https://" };
  if (!parsed.hostname) return { ok: false, reason: "代理地址缺少主机名" };
  if (parsed.username || parsed.password) return { ok: false, reason: "代理地址不能内嵌用户名/密码" };
  if (parsed.search || parsed.hash) return { ok: false, reason: "代理地址不能带查询参数或片段" };
  if (parsed.pathname && parsed.pathname !== "/") return { ok: false, reason: "代理地址只能是源（不要带路径）" };
  const port = parsed.port ? ":" + parsed.port : "";
  return { ok: true, url: parsed.protocol + "//" + parsed.hostname + port };
}

/** 源:47-54 —— 逐字：reg query 输出解析（ProxyEnable REG_DWORD 0x1 + ProxyServer）。 */
function parseWindowsSystemProxy(output) {
  const text = asText(output);
  const enabled = /\bProxyEnable\s+REG_DWORD\s+0x1\b/i.test(text);
  const raw = text.match(/\bProxyServer\s+REG_\w+\s+([^\r\n]+)/i)?.[1]?.trim() || "";
  if (!enabled || !raw) return "";
  const https = raw.split(";").find((part) => /^https=/i.test(part))?.split("=")[1];
  const address = https || (raw.includes("=") ? "" : raw);
  return proxyUrl(/^https?:\/\//i.test(address) ? address : "http://" + address);
}

// ---------------------------------------------------------------------------
// linux /proc 回退（源无此分支，按任务书补齐；全部纯函数）
// ---------------------------------------------------------------------------

/**
 * 解析 /proc/net/tcp 或 /proc/net/tcp6 一行行文本，只取回环地址上的 LISTEN 套接字。
 * 字段序：0:sl 1:local_address 2:rem_address 3:st ... 9:inode；st=0A 为 LISTEN。
 */
function parseLinuxProcNetLoopbackListeners(content, family = 4) {
  const text = asText(content);
  const expected = family === 6 ? LINUX_LOOPBACK_HEX[6] : LINUX_LOOPBACK_HEX[4];
  const listeners = [];
  for (const line of text.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 10) continue;
    const separator = tokens[1].indexOf(":");
    if (separator <= 0) continue;
    const address = tokens[1].slice(0, separator).toUpperCase();
    const port = Number.parseInt(tokens[1].slice(separator + 1), 16);
    const inode = Number(tokens[9]);
    if (tokens[3].toUpperCase() !== "0A") continue;
    if (!expected.includes(address)) continue;
    if (!(port > 0 && port <= 65535)) continue;
    if (!(inode > 0)) continue;
    listeners.push({ port, inode, address: family === 6 ? "::1" : "127.0.0.1", family: family === 6 ? 6 : 4 });
  }
  return listeners;
}

/** /proc/<pid>/fd/<n> 的 readlink 目标：socket:[inode] → inode，其它一律 null。 */
function parseProcFdTarget(target) {
  const match = /^socket:\[(\d+)\]$/.exec(asText(target).trim());
  if (!match) return null;
  const inode = Number(match[1]);
  return Number.isInteger(inode) && inode > 0 ? inode : null;
}

/**
 * fd 条目 [{ pid, target }] → Map(inode → pid)。
 * 只保留能解析出 socket inode 的条目；同一 inode 谁先出现谁占位。
 */
function buildInodePidIndex(fdEntries) {
  const index = new Map();
  for (const entry of Array.isArray(fdEntries) ? fdEntries : []) {
    if (!entry || typeof entry !== "object") continue;
    const pid = Number(entry.pid);
    const inode = parseProcFdTarget(entry.target);
    if (!Number.isInteger(pid) || pid <= 0 || inode == null) continue;
    if (!index.has(inode)) index.set(inode, pid);
  }
  return index;
}

// ---------------------------------------------------------------------------
// 候选去重 / 时间钳制 / 探测子进程脚本与环境（纯函数）
// ---------------------------------------------------------------------------

/** 把 (地址, 来源, 类别) 归一成候选；地址非法返回 null。 */
function proxyCandidate(value, source, kind = "unknown") {
  const url = proxyUrl(value);
  if (!url) return null;
  return { url, source: String(source == null ? "" : source).slice(0, 120), kind: String(kind) };
}

/** 源 localProxyCandidates 的 add 语义：按 url 去重、上限 MAX_CANDIDATES，返回新数组。 */
function appendCandidate(list, candidate, limit = MAX_CANDIDATES) {
  const current = Array.isArray(list) ? list : [];
  if (!candidate || !candidate.url) return current;
  if (current.length >= limit) return current;
  if (current.some((item) => item.url === candidate.url)) return current;
  return [...current, candidate];
}

function clampProbeTimeout(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(num)));
}

/**
 * 源:98 —— 探测子进程脚本。之所以用子进程而不是主进程内 fetch：
 * Node/Electron 内置 fetch 默认不读 HTTP(S)_PROXY，只有 NODE_USE_ENV_PROXY=1 的独立进程才认代理。
 */
function buildProbeScript(url, timeoutMs) {
  const ms = Math.max(MIN_TIMEOUT_MS, Math.min(timeoutMs, MAX_TIMEOUT_MS));
  return "fetch(" + JSON.stringify(url) + ",{signal:AbortSignal.timeout(" + ms + ")}).then(r=>console.log(JSON.stringify({status:r.status}))).catch(e=>{console.error(e.cause?.code||e.name||'NETWORK_ERROR');process.exitCode=1})";
}

/**
 * 源:100-101 —— 探测子进程环境：把候选代理塞进 HTTP_PROXY/HTTPS_PROXY，删掉 ALL_PROXY。
 * 额外加 ELECTRON_RUN_AS_NODE=1：主进程里 process.execPath 是 Electron 可执行文件，
 * 不带这个开关会启动第二个 Electron 窗口而不是跑脚本；纯 Node 下该变量无副作用。
 */
function buildProbeEnv(baseEnv, proxyUrlValue, extra = {}) {
  const env = { ...(baseEnv && typeof baseEnv === "object" ? baseEnv : {}) };
  env.HTTP_PROXY = proxyUrlValue;
  env.HTTPS_PROXY = proxyUrlValue;
  env.NODE_USE_ENV_PROXY = "1";
  env.NO_PROXY = PROBE_NO_PROXY;
  env.ELECTRON_RUN_AS_NODE = "1";
  delete env.ALL_PROXY;
  for (const [key, value] of Object.entries(extra || {})) env[key] = value;
  return env;
}

// ---------------------------------------------------------------------------
// 错误规约（形状与 platform 域一致）
// ---------------------------------------------------------------------------

function createLocalProxyError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "LocalProxyError";
  err.code = LOCAL_PROXY_ERROR_CODES.includes(code) ? code : LOCAL_PROXY_ERR_INTERNAL;
  err.detail = detail === undefined ? undefined : foundationErrors.redactValue(detail);
  return err;
}

function isLocalProxyError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && LOCAL_PROXY_ERROR_CODES.includes(err.code);
}

function redactLocalProxyValue(value) {
  return foundationErrors.redactValue(value);
}

/** { ok:false, error, message, detail? } —— 与 PLATFORM_* / DXOS_* 失败形状一致。 */
function normalizeLocalProxyError(err) {
  if (isLocalProxyError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

function localProxyCommandNotAllowed(command) {
  return createLocalProxyError(LOCAL_PROXY_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 desktop 命令：" + String(command == null ? "" : command), { command: command == null ? null : String(command) });
}

function isLocalProxyCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(LOCAL_PROXY_COMMANDS, command);
}

function localProxyCommandEntry(command) {
  return isLocalProxyCommand(command) ? LOCAL_PROXY_COMMANDS[command] : null;
}

function localProxyCommandRisk(command) {
  const entry = localProxyCommandEntry(command);
  return entry ? entry.risk : null;
}

function listLocalProxyCommands() {
  return Object.keys(LOCAL_PROXY_COMMANDS).map((command) => ({
    command,
    risk: LOCAL_PROXY_COMMANDS[command].risk,
    credential: LOCAL_PROXY_COMMANDS[command].credential,
    probesExternal: LOCAL_PROXY_COMMANDS[command].probesExternal,
    network: LOCAL_PROXY_COMMANDS[command].network,
    summary: LOCAL_PROXY_COMMANDS[command].summary,
  }));
}

module.exports = {
  GOOGLE_MODELS_URL,
  VPN_PROCESS,
  MAX_CANDIDATES,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  PROBE_NO_PROXY,
  LINUX_LOOPBACK_HEX,
  LOCAL_PROXY_TARGET,
  LOCAL_PROXY_COMMANDS,
  LOCAL_PROXY_ERROR_CODES,
  LOCAL_PROXY_ERR_COMMAND_NOT_ALLOWED,
  LOCAL_PROXY_ERR_INVALID_INPUT,
  LOCAL_PROXY_ERR_INTERNAL,
  LOCAL_PROXY_ERR_DEPENDENCY_UNAVAILABLE,
  parseWindowsLoopbackListeners,
  parseWindowsProcessNames,
  parseMacLoopbackListeners,
  parseMacSystemProxy,
  proxyUrl,
  normalizeManualProxyUrl,
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
  isLocalProxyError,
  redactLocalProxyValue,
  normalizeLocalProxyError,
  localProxyCommandNotAllowed,
  isLocalProxyCommand,
  localProxyCommandEntry,
  localProxyCommandRisk,
  listLocalProxyCommands,
};
