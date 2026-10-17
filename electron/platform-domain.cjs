/**
 * B6c · 平台域纯逻辑（无 I/O）：命令白名单 + 风险/凭据属性 + 网络安全出网判定
 * + 供应商测试安全 + 诊断投影脱敏 + 错误规约。
 *
 * 为什么单独一层：platform:command 是本轮新增的顶层 IPC 通道，"哪些命令可被渲染层调用、
 * 每条命令的风险等级、是否触碰凭据、失败时回什么码"必须先在一处冻结，再交给
 * electron/platform-service.cjs 分发、electron/platform-bootstrap.cjs 注册。
 * 命令表本身即白名单：未登记的命令一律 PLATFORM_COMMAND_NOT_ALLOWED，不做动态 dispatch。
 *
 * 逐函数移植自只读源（行号为源文件行号）：
 *   · server/networkSafety.ts:7-11    isVpnSyntheticNetworkAddress
 *   · server/networkSafety.ts:13-39   isPrivateNetworkAddress
 *   · server/developerNetwork.ts:26-29 domainAllowed（**出网治理唯一口径**，不另造一套）
 *   · server/developerNetwork.ts:31-37 validateDeveloperNetworkUrl（HTTPS / 无内嵌凭据 / 443 / 域名白名单）
 *   · server/developerNetwork.ts:39-42 assertPublicDns（DNS 必须是公网地址）
 *   · server/processDiagnostics.ts:19-42 startDesktopParentMonitor
 *   · server/processDiagnostics.ts:59-75 processMemorySnapshot
 *   · server/providerTestSafety.ts:1-24 三个函数逐字移植
 *   · server/appDiagnostics.ts:4-8     sanitize
 *
 * 脱敏/错误规约复用 electron/dxos-foundation-errors.cjs 既有实现，保证 platform 域的失败形状
 * 与 agent / skill / media / model / task 各域一致，不产生第二套错误协议。
 */
"use strict";

const { isIP } = require("node:net");
const { resolve, sep } = require("node:path");
const foundationErrors = require("./dxos-foundation-errors.cjs");

/** 平台域自有错误码。与 DXOS_* / MEDIA_* / AGENT_* 并列，不合并（域边界清晰，便于渲染层稳定判别）。 */
const PLATFORM_ERR_COMMAND_NOT_ALLOWED = "PLATFORM_COMMAND_NOT_ALLOWED";
const PLATFORM_ERR_INVALID_INPUT = "PLATFORM_INVALID_INPUT";
const PLATFORM_ERR_UNAUTHENTICATED = "PLATFORM_UNAUTHENTICATED";
const PLATFORM_ERR_FORBIDDEN = "PLATFORM_FORBIDDEN";
const PLATFORM_ERR_NOT_FOUND = "PLATFORM_NOT_FOUND";
const PLATFORM_ERR_CONFLICT = "PLATFORM_CONFLICT";
const PLATFORM_ERR_DEPENDENCY_UNAVAILABLE = "PLATFORM_DEPENDENCY_UNAVAILABLE";
const PLATFORM_ERR_INTEGRITY_FAILED = "PLATFORM_INTEGRITY_FAILED";
const PLATFORM_ERR_DNS_FAILED = "PLATFORM_DNS_FAILED";
const PLATFORM_ERR_RESTORE_FAILED = "PLATFORM_RESTORE_FAILED";
const PLATFORM_ERR_INTERNAL = "PLATFORM_INTERNAL";

const PLATFORM_ERROR_CODES = Object.freeze([
  PLATFORM_ERR_COMMAND_NOT_ALLOWED,
  PLATFORM_ERR_INVALID_INPUT,
  PLATFORM_ERR_UNAUTHENTICATED,
  PLATFORM_ERR_FORBIDDEN,
  PLATFORM_ERR_NOT_FOUND,
  PLATFORM_ERR_CONFLICT,
  PLATFORM_ERR_DEPENDENCY_UNAVAILABLE,
  PLATFORM_ERR_INTEGRITY_FAILED,
  PLATFORM_ERR_DNS_FAILED,
  PLATFORM_ERR_RESTORE_FAILED,
  PLATFORM_ERR_INTERNAL,
]);

/**
 * platform:command 白名单。
 *   risk       read | use | manage | destructive（与 media-domain.cjs:70 同级定义）
 *   credential 该命令是否会把真实凭据带进执行路径。平台域全部本地处理，恒为 false；
 *              字段保留是为了与其它域的命令表同形 —— 网络安全判定只做地址校验，
 *              从不解析 / 携带 credential-store 里的密钥值。
 *   summary    中文一句话，供 UI 与审计展示。
 */
const PLATFORM_COMMANDS = Object.freeze({
  // ---- 诊断（源 appDiagnostics.ts / processDiagnostics.ts） ----
  "platform/diagnostics/app": { risk: "read", credential: false, summary: "应用诊断：版本 / 环境 / 数据库 / 迁移 / 存储占用 / 运行时事件（脱敏）" },
  "platform/diagnostics/process": { risk: "read", credential: false, summary: "进程诊断：主进程与受监督子进程清单 + 内存 / 句柄摘要（不含环境变量）" },
  "platform/diagnostics/record": { risk: "manage", credential: false, summary: "记录一条应用运行时事件（脱敏后落 app_runtime_events）" },

  // ---- DX 虚拟文件树：共享盘 / 部门盘 / 子树快照 / 搜索 / 统计（受控只读桥；不返回绝对路径） ----
  "platform/fs/shared/roots": { risk: "read", credential: false, summary: "列出当前用户可见的共享盘 / 部门盘根（public 与 department:*）" },
  "platform/fs/shared/list": { risk: "read", credential: false, summary: "列出共享盘目录子项（安全节点投影，不含 blob / 磁盘路径）" },
  "platform/fs/search": { risk: "read", credential: false, summary: "在可见共享盘子树内按名称 / 内容搜索（结果不含绝对路径）" },
  "platform/fs/stats": { risk: "read", credential: false, summary: "统计可见共享盘子树的字节数与条目数（不含文件名清单）" },
  "platform/fs/snapshot/create": { risk: "manage", credential: false, summary: "为可见子树创建内存快照（只回 snapshotId 与 nodeCount，不回 blob）" },
  "platform/fs/snapshot/restore": { risk: "destructive", credential: false, summary: "恢复本人创建的子树快照（需超管 / owner / 部门管理员）" },

  // ---- 数据保护（源 systemDataProtection.ts） ----
  "platform/data/integrity": { risk: "read", credential: false, summary: "检查 dxos 数据目录 JSON 完整性（不读取凭据目录）" },
  "platform/data/snapshot/create": { risk: "manage", credential: false, summary: "创建系统数据快照（落 <userData>/dxos/backups，排除凭据目录）" },
  "platform/data/snapshot/verify": { risk: "read", credential: false, summary: "校验快照清单与文件 sha256" },
  "platform/data/snapshot/list": { risk: "read", credential: false, summary: "列出本机快照（按创建时间倒序）" },
  "platform/data/snapshot/restore": { risk: "destructive", credential: false, summary: "恢复快照（需 databasesClosed=true；失败自动回滚）" },

  // ---- 网络安全（源 networkSafety.ts + developerNetwork.ts 同口径） ----
  "platform/network/evaluate": { risk: "read", credential: false, summary: "出网判定：HTTPS + 域白名单 + DNS 公网地址校验" },

  // ---- 供应商测试安全（源 providerTestSafety.ts） ----
  "platform/provider/test-check": { risk: "read", credential: false, summary: "供应商测试安全检查：阻断连通性提示词进入计费视频接口" },

  // ---- 健康 ----
  "platform/health": { risk: "read", credential: false, summary: "平台域健康：网络判定引擎 / 快照目录 / 数据库可用性" },
});

/** 风险等级序（数值越大越危险）；UI 排序 / 审批阈值使用。 */
const RISK_LEVELS = Object.freeze({ read: 0, use: 1, manage: 2, destructive: 3 });

function isPlatformCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(PLATFORM_COMMANDS, command);
}

function platformCommandEntry(command) {
  return isPlatformCommand(command) ? PLATFORM_COMMANDS[command] : null;
}

/** 未知命令返回 null（调用方据此判 PLATFORM_COMMAND_NOT_ALLOWED，不猜风险）。 */
function platformCommandRisk(command) {
  const entry = platformCommandEntry(command);
  return entry ? entry.risk : null;
}

function platformCommandRequiresCredential(command) {
  const entry = platformCommandEntry(command);
  return !!(entry && entry.credential);
}

/**
 * 稳定顺序的命令清单（对象字面量声明顺序），供 UI 与测试消费。
 * 注意：IPC 投影把 credential 改名为 needsCredential —— dxos-foundation-errors.redactValue
 * 会把任何含 "credential" 的键当密钥字段掩码（dxos-foundation-mask.cjs:12）。
 */
function listPlatformCommands() {
  return Object.keys(PLATFORM_COMMANDS).map((command) => ({
    command,
    risk: PLATFORM_COMMANDS[command].risk,
    needsCredential: PLATFORM_COMMANDS[command].credential,
    summary: PLATFORM_COMMANDS[command].summary,
  }));
}

/** 构造带稳定 code 的平台域错误；message 过 foundation 的 redactText。 */
function createPlatformError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "PlatformError";
  err.code = PLATFORM_ERROR_CODES.includes(code) ? code : PLATFORM_ERR_INTERNAL;
  err.detail = detail === undefined ? undefined : foundationErrors.redactValue(detail);
  return err;
}

function isPlatformError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && PLATFORM_ERROR_CODES.includes(err.code);
}

/** 任意值与返回值脱敏：直接复用 foundation 的深度封顶 + 密钥字段掩码 + 绝对路径替换。 */
function redactPlatformValue(value) {
  return foundationErrors.redactValue(value);
}

/** 文本脱敏（源 appDiagnostics.ts:4-8 的 sanitize，改用 foundation 的 redactText 统一口径）。 */
function sanitizePlatformText(value, max = 4000) {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return foundationErrors.redactText(text).slice(0, Math.max(0, max));
}

/** 平台域错误 → 渲染层安全结果。形状与 foundation 一致：{ ok:false, error, message, detail? }。 */
function normalizePlatformError(err) {
  if (isPlatformError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

function platformCommandNotAllowed(command) {
  return createPlatformError(PLATFORM_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 platform 命令：" + String(command == null ? "" : command), { command: command == null ? null : String(command) });
}

/** 渲染层出口：成功 { ok:true, value }；失败 normalizePlatformError。 */
async function toPlatformIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactPlatformValue(value) };
  } catch (err) {
    return normalizePlatformError(err);
  }
}

// ---------------------------------------------------------------------------
// 网络安全（源 networkSafety.ts 逐条移植）
// ---------------------------------------------------------------------------

/**
 * 源 networkSafety.ts:7-11。
 * RFC 2544 benchmarking 段：Clash/Mihomo 等桌面 VPN 客户端用 198.18.0.0/15 回 Fake-IP。
 */
function isVpnSyntheticNetworkAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 198 && (b === 18 || b === 19);
}

/**
 * 源 networkSafety.ts:13-39 —— 逐条相同的网段判定。
 * 注意：非 IP 字面量一律返回 true（"不可判定即视为内网"，fail closed）。
 */
function isPrivateNetworkAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || a === 127
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) {
      const mapped = value.slice(7);
      if (isIP(mapped) === 4) return isPrivateNetworkAddress(mapped);
      const words = mapped.split(":");
      if (words.length === 2) {
        const high = Number.parseInt(words[0] || "", 16);
        const low = Number.parseInt(words[1] || "", 16);
        if (Number.isInteger(high) && Number.isInteger(low)) return isPrivateNetworkAddress((high >> 8) + "." + (high & 255) + "." + (low >> 8) + "." + (low & 255));
      }
    }
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd")
      || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")
      || value.startsWith("ff") || value.startsWith("2001:db8:") || value.startsWith("2001:2:");
  }
  return true;
}

/**
 * 源 developerNetwork.ts:26-29 —— 开发者 App 出网域名白名单的唯一匹配口径。
 *   · 精确：host === pattern；
 *   · 通配：pattern 以 "*." 开头时匹配子域，但**不匹配裸域**（与源逐字一致）。
 * 后续任何开发者 App 出网实现都必须复用本函数，不得另写一套。
 */
function domainAllowed(hostname, patterns) {
  const host = String(hostname || "").toLowerCase();
  const list = Array.isArray(patterns) ? patterns : [];
  return list.some((pattern) => {
    const value = String(pattern || "").toLowerCase();
    return value.startsWith("*.") ? host.endsWith(value.slice(1)) && host !== value.slice(2) : host === value;
  });
}

/**
 * 源 developerNetwork.ts:31-37 validateDeveloperNetworkUrl —— 只放行标准 HTTPS：
 * 协议必须是 https、URL 内不得内嵌 username/password、端口只能是 443（或省略）。
 * 返回解析后的 URL 事实，不发起任何请求。
 */
function evaluateOutboundUrl(raw, policy) {
  let url;
  try {
    url = new URL(String(raw == null ? "" : raw));
  } catch {
    throw createPlatformError(PLATFORM_ERR_INVALID_INPUT, "网络请求 URL 无效");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw createPlatformError(PLATFORM_ERR_INVALID_INPUT, "出网请求只允许标准 HTTPS（无内嵌凭据、端口 443）");
  }
  const domains = policy && Array.isArray(policy.domains) ? policy.domains : [];
  if (!domainAllowed(url.hostname, domains)) {
    throw createPlatformError(PLATFORM_ERR_FORBIDDEN, "域名未在白名单中：" + url.hostname, { host: url.hostname });
  }
  return { url, host: url.hostname.toLowerCase(), origin: url.origin, href: url.toString() };
}

/** 纯判定：给定 DNS 解析结果，是否全部为公网地址（源 developerNetwork.ts:39-42 的判定部分）。 */
function evaluableAddressesArePublic(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  if (!list.length) return { public: false, reason: "DNS_EMPTY", blocked: [] };
  const blocked = list.filter((item) => isPrivateNetworkAddress(String(item && item.address != null ? item.address : item)));
  if (blocked.length) return { public: false, reason: "PRIVATE_ADDRESS", blocked: blocked.map((item) => String(item && item.address != null ? item.address : item)) };
  return { public: true, reason: null, blocked: [] };
}

// ---------------------------------------------------------------------------
// 供应商测试安全（源 providerTestSafety.ts:1-24 逐字移植）
// ---------------------------------------------------------------------------

const CONNECTIVITY_PROBE_PROMPTS = new Set([
  "用一个词回复ok",
  "用一个词回答ok",
  "replywithonewordok",
  "respondwithonewordok",
]);

function isConnectivityProbePrompt(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s，。！？、；：,.!?;:'"`~_-]+/g, "");
  return CONNECTIVITY_PROBE_PROMPTS.has(normalized);
}

/** 源 providerTestSafety.ts:13-19：媒体验证会创建真实计费任务，绝不接受 LLM 连通性探测词。 */
function assertExplicitVideoTestPrompt(value) {
  const prompt = String(value || "").trim();
  if (!prompt) throw createPlatformError(PLATFORM_ERR_INVALID_INPUT, "视频测试会创建真实计费任务，请先输入明确的视频提示词");
  if (isConnectivityProbePrompt(prompt)) throw createPlatformError(PLATFORM_ERR_FORBIDDEN, "已阻止文本连通性提示词进入正式视频接口；验证 AGToken 连通性请使用“验证协议/拉取模型”");
  return prompt;
}

/** 源 providerTestSafety.ts:21-24：不声明分辨率时用最小的 480p，避免默认拉高计费。 */
function conservativeVideoTestResolution(value) {
  const requested = String(value || "").trim().toLowerCase();
  return requested || "480p";
}

const PROVIDER_TEST_KINDS = Object.freeze(["video", "text", "audio", "image"]);

/**
 * 供应商连通性测试前的统一安全检查（对应 server/index.ts:6014-6021 的 test-video 前置语义）。
 *
 * 输入 { kind, prompt?, resolution?, providerOrigin? }：
 *   · 视频类测试是**真实计费任务**，必须有明确提示词，且拒绝连通性探测词（源三函数）；
 *   · providerOrigin 若提供，按 developerNetwork.ts:31-37 同一口径校验：
 *     URL 合法、不内嵌凭据、必须是 https。
 * 返回安全投影（不抛错）：{ allowed, kind, prompt, resolution, reasons[] }。
 */
function checkProviderTest(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const kind = PROVIDER_TEST_KINDS.includes(String(source.kind)) ? String(source.kind) : "text";
  const reasons = [];
  let prompt = String(source.prompt == null ? "" : source.prompt).trim();
  let resolution = null;

  if (source.providerOrigin != null && String(source.providerOrigin).length) {
    let origin = null;
    try { origin = new URL(String(source.providerOrigin)); } catch { reasons.push("PROVIDER_ORIGIN_INVALID"); }
    if (origin) {
      if (origin.username || origin.password) reasons.push("PROVIDER_ORIGIN_HAS_CREDENTIALS");
      if (origin.protocol !== "https:") reasons.push("PROVIDER_ORIGIN_NOT_HTTPS");
    }
  }

  if (kind === "video") {
    if (!prompt) reasons.push("EXPLICIT_PROMPT_REQUIRED");
    else if (isConnectivityProbePrompt(prompt)) reasons.push("CONNECTIVITY_PROBE_BLOCKED");
    resolution = conservativeVideoTestResolution(source.resolution);
  }

  return { allowed: reasons.length === 0, kind, prompt: prompt || null, resolution, reasons };
}

// ---------------------------------------------------------------------------
// 进程诊断（源 processDiagnostics.ts:19-75 的可移植部分）
// ---------------------------------------------------------------------------

/** 源 processDiagnostics.ts:59-75 processMemorySnapshot —— 只含进程事实，绝不含环境变量。 */
function processMemorySnapshot(role, event = "sample", metrics = {}, now = Date.now()) {
  const memory = process.memoryUsage();
  return {
    ts: new Date(now).toISOString(),
    event,
    role,
    pid: process.pid,
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    ...(metrics && typeof metrics === "object" ? metrics : {}),
  };
}

function isDesktopParentAlive(pid, killImpl) {
  try {
    (typeof killImpl === "function" ? killImpl : process.kill)(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 源 processDiagnostics.ts:19-42 startDesktopParentMonitor。
 * 父进程消失后自行退出，避免安装/升级直接结束 Electron 时留下孤儿占用端口与 SQLite。
 * 环境变量沿用源的 DX_DESKTOP_PID；未设置时是 no-op（返回只含 stop 的句柄），不产生任何副作用。
 * 计时器 / 探测函数可注入，便于离线单测。
 */
function startDesktopParentMonitor(role, onOrphan, options = {}) {
  const env = options.env || process.env;
  const killImpl = options.killImpl || process.kill;
  const parentPid = Number(env.DX_DESKTOP_PID);
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) return { stop() {} };
  let stopped = false;
  const warn = typeof options.logger === "function" ? options.logger : (message) => console.warn(message);
  const timer = setInterval(() => {
    if (stopped) return;
    if (!isDesktopParentAlive(parentPid, killImpl)) {
      stopped = true;
      clearInterval(timer);
      try { warn("[OpenArc " + role + "] desktop parent " + parentPid + " exited; stopping orphan process"); } catch { /* 日志失败不改变行为 */ }
      try { onOrphan(); } catch { /* 回调失败不改变行为 */ }
    }
  }, options.intervalMs || 1000);
  timer.unref?.();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// 快照路径（源 systemDataProtection.ts:19-27 的路径围栏）
// ---------------------------------------------------------------------------

const SNAPSHOT_ID_RE = /^[a-z0-9][a-z0-9-]{5,100}$/;
const SNAPSHOT_FORMAT = "openarc-system-data-snapshot/v1";

function safeSnapshotId(value) {
  if (!SNAPSHOT_ID_RE.test(String(value == null ? "" : value))) throw createPlatformError(PLATFORM_ERR_INVALID_INPUT, "数据快照 ID 不合法");
  return String(value);
}

/** 解析快照绝对路径并做前缀围栏；越界即抛错（源 systemDataProtection.ts:23-27 的语义）。 */
function snapshotPathWithin(backupsRoot, id) {
  const root = resolve(String(backupsRoot || ""));
  const target = resolve(root, safeSnapshotId(id));
  if (!target.startsWith(root + sep)) throw createPlatformError(PLATFORM_ERR_INVALID_INPUT, "数据快照路径越界");
  return target;
}

module.exports = {
  PLATFORM_COMMANDS,
  PLATFORM_ERROR_CODES,
  SNAPSHOT_FORMAT,
  PROVIDER_TEST_KINDS,
  CONNECTIVITY_PROBE_PROMPTS,
  RISK_LEVELS,
  PLATFORM_ERR_COMMAND_NOT_ALLOWED,
  PLATFORM_ERR_INVALID_INPUT,
  PLATFORM_ERR_UNAUTHENTICATED,
  PLATFORM_ERR_FORBIDDEN,
  PLATFORM_ERR_NOT_FOUND,
  PLATFORM_ERR_CONFLICT,
  PLATFORM_ERR_DEPENDENCY_UNAVAILABLE,
  PLATFORM_ERR_INTEGRITY_FAILED,
  PLATFORM_ERR_DNS_FAILED,
  PLATFORM_ERR_RESTORE_FAILED,
  PLATFORM_ERR_INTERNAL,
  isPlatformCommand,
  platformCommandEntry,
  platformCommandRisk,
  platformCommandRequiresCredential,
  listPlatformCommands,
  createPlatformError,
  isPlatformError,
  redactPlatformValue,
  sanitizePlatformText,
  normalizePlatformError,
  platformCommandNotAllowed,
  toPlatformIpcResult,
  isVpnSyntheticNetworkAddress,
  isPrivateNetworkAddress,
  domainAllowed,
  evaluateOutboundUrl,
  evaluableAddressesArePublic,
  isConnectivityProbePrompt,
  assertExplicitVideoTestPrompt,
  conservativeVideoTestResolution,
  checkProviderTest,
  processMemorySnapshot,
  isDesktopParentAlive,
  startDesktopParentMonitor,
  safeSnapshotId,
  snapshotPathWithin,
};
