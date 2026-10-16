/**
 * DX OS 0.6.1 · 系统字体域纯逻辑（不含文件 I/O：字节读取由调用方注入）。
 *
 * 逐行移植自只读源 server/systemFonts.ts（行号为源文件行号）：
 *   · :8          MAX_BYTES = 64 MiB —— 单字体字节上限，列表与读取共用
 *   · :11-15      systemFontDirectories（win32 / darwin / linux 三套根目录）
 *   · :16         within（根目录归属判定，防 realpath 逃逸）
 *   · :19-64      fontFamilies（只解析 SFNT name 表；ttcf 集合 / 表目录 / 记录三级边界）
 *   · :66-100     refresh 的缓存规约（TTL 300s、深度 5、1 万项、扩展名白名单、symlink 跳过）
 *   · :90         id = sha256(realpath:size:mtimeMs)
 *   · :103-112    read 的三重校验（id 命中 / realpath 仍在根内 / size+mtime 未变）
 *   · :115-120    HTTP 处理器拆成命令面：GET /api/system/fonts → systemFonts/list，
 *                 GET /api/system/fonts/:id → systemFonts/read（:118 的 id 正则原文保留）
 *
 * 与源的差异（均在对应位置注明理由）：
 *   · 源自己 open(path)；这里把"读一段字节"抽成注入的 read(offset,length)，
 *     让域层保持纯逻辑、可在无文件系统环境下单测，真实 reader 在 service 里。
 *   · 源按 HTTP octet-stream 返回裸字节；本仓 IPC 出口统一 base64url
 *     （沿用 electron/media-service.cjs:367 的既有口径：base64url 不含 '/'，
 *      不会被 foundation 的绝对路径脱敏误伤字体字节）。
 *   · 源 list() 一次返回全表；这里分页（默认/上限 100 条），
 *     因为 foundation redactValue 会把数组截到 100 项（dxos-foundation-errors.cjs:68）。
 *
 * 脱敏 / 错误规约复用 electron/dxos-foundation-errors.cjs，不产生第二套错误协议。
 *
 * OUT：源 systemFonts.ts 只扫本机目录，不依赖 cloudAccount / cloudEntitlement / api.dx-os.com，
 * 本域没有任何云能力需要跳过（对照铁律 3 的 OUT 清单，逐项核对为无）。
 */
"use strict";

const { homedir } = require("node:os");
const { join, sep } = require("node:path");
const foundationErrors = require("./dxos-foundation-errors.cjs");

/** 唯一渲染层入口与下行事件通道（IPC 通道名必须字面量，安全回归探针按字面量扫描）。 */
const SYSTEM_FONTS_COMMAND_CHANNEL = "systemFonts:command";
const SYSTEM_FONTS_EVENT_CHANNEL = "systemFonts:event";
const SYSTEM_FONTS_DOMAIN = "systemFonts";

/** 源 :8 —— 单字体文件上限，扫描与读取共用同一常量，两处判定必须一致。 */
const MAX_FONT_BYTES = 64 * 1024 * 1024;
/** 源 :23 / :44 —— 单次字体表读取上限；超限直接拒绝，不按声明长度分配内存。 */
const MAX_FONT_TABLE_BYTES = 1024 * 1024;
/** 源 :32 —— ttcf 集合字体数上限。 */
const MAX_TTC_COUNT = 256;
/** 源 :38 —— 单张 SFNT 表目录项上限。 */
const MAX_SFNT_TABLES = 512;
/** 源 :46 —— name 表记录数上限。 */
const MAX_NAME_RECORDS = 4096;
/** 源 :50 —— 单条 name 字符串字节上限。 */
const MAX_NAME_BYTES = 2048;
/** 源 :56 —— 入口可见的字体族名长度上限。 */
const MAX_NAME_LENGTH = 200;
/** 源 :72-73 —— 目录递归深度与访问项数上限（大目录不打爆内存 / 不无限递归）。 */
const MAX_SCAN_DEPTH = 5;
const MAX_SCAN_ENTRIES = 10000;
/** 源 :69 —— 目录清单缓存 TTL。 */
const FONT_CACHE_TTL_MS = 300000;
/** 源 :85 —— 只认这四种 SFNT 扩展名，其余文件一律不进目录。 */
const FONT_EXTENSIONS = Object.freeze([".ttf", ".otf", ".ttc", ".otc"]);
/** 源 :118 —— id 正则原文；service 与 bootstrap 都以此为唯一判据。 */
const FONT_ID_RE = /^[a-f0-9]{64}$/;
/** foundation redactValue 的数组上限（dxos-foundation-errors.cjs:68）——分页上限与它对齐。 */
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 100;

/** 字体域自有错误码；与 DXOS_* / MEDIA_* 并列，渲染层可稳定判别。 */
const SYSTEM_FONTS_ERR_COMMAND_NOT_ALLOWED = "SYSTEM_FONTS_COMMAND_NOT_ALLOWED";
const SYSTEM_FONTS_ERR_INVALID_INPUT = "SYSTEM_FONTS_INVALID_INPUT";
const SYSTEM_FONTS_ERR_NOT_FOUND = "SYSTEM_FONTS_NOT_FOUND";
const SYSTEM_FONTS_ERR_TOO_LARGE = "SYSTEM_FONTS_TOO_LARGE";
const SYSTEM_FONTS_ERR_CHANGED = "SYSTEM_FONTS_CHANGED";
const SYSTEM_FONTS_ERR_UNAVAILABLE = "SYSTEM_FONTS_UNAVAILABLE";
const SYSTEM_FONTS_ERR_INTERNAL = "SYSTEM_FONTS_INTERNAL";

const SYSTEM_FONTS_ERROR_CODES = Object.freeze([
  SYSTEM_FONTS_ERR_COMMAND_NOT_ALLOWED,
  SYSTEM_FONTS_ERR_INVALID_INPUT,
  SYSTEM_FONTS_ERR_NOT_FOUND,
  SYSTEM_FONTS_ERR_TOO_LARGE,
  SYSTEM_FONTS_ERR_CHANGED,
  SYSTEM_FONTS_ERR_UNAVAILABLE,
  SYSTEM_FONTS_ERR_INTERNAL,
]);

/**
 * systemFonts:command 白名单。命令表本身即白名单：未登记命令一律 COMMAND_NOT_ALLOWED，
 * 不做动态 dispatch。risk/credential 字段与 media-domain.cjs:76-150 同形，
 * 供 UI 与审计统一消费；两条命令都只读本机字体目录，credential 恒 false。
 */
const SYSTEM_FONTS_COMMANDS = Object.freeze({
  "systemFonts/list": { risk: "read", credential: false, summary: "列出本机系统字体目录（id / 字体族 / 字节数，分页；不读字体字节）" },
  "systemFonts/read": { risk: "read", credential: false, summary: "按 id 读取单个字体文件字节（base64url；单文件上限 64 MB）" },
});

const RISK_LEVELS = Object.freeze({ read: 0, use: 1, manage: 2, destructive: 3 });

function isSystemFontsCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(SYSTEM_FONTS_COMMANDS, command);
}

function systemFontsCommandEntry(command) {
  return isSystemFontsCommand(command) ? SYSTEM_FONTS_COMMANDS[command] : null;
}

function systemFontsCommandRisk(command) {
  const entry = systemFontsCommandEntry(command);
  return entry ? entry.risk : null;
}

function systemFontsCommandRequiresCredential(command) {
  const entry = systemFontsCommandEntry(command);
  return !!(entry && entry.credential);
}

/** 稳定顺序的命令清单；credential 在出口改名 needsCredential（见 platform-domain.cjs:110-122 的注释）。 */
function listSystemFontsCommands() {
  return Object.keys(SYSTEM_FONTS_COMMANDS).map((command) => ({
    command,
    risk: SYSTEM_FONTS_COMMANDS[command].risk,
    needsCredential: SYSTEM_FONTS_COMMANDS[command].credential,
    summary: SYSTEM_FONTS_COMMANDS[command].summary,
  }));
}

/** 构造带稳定 code 的字体域错误；message 过 foundation 的 redactText。 */
function createSystemFontsError(code, message, detail) {
  const err = new Error(foundationErrors.redactText(message == null ? code : message));
  err.name = "SystemFontsError";
  err.code = SYSTEM_FONTS_ERROR_CODES.includes(code) ? code : SYSTEM_FONTS_ERR_INTERNAL;
  err.detail = detail === undefined ? undefined : foundationErrors.redactValue(detail);
  return err;
}

function isSystemFontsError(err) {
  return !!err && typeof err === "object" && typeof err.code === "string" && SYSTEM_FONTS_ERROR_CODES.includes(err.code);
}

function redactSystemFontsValue(value) {
  return foundationErrors.redactValue(value);
}

/** 字体域错误 → 渲染层安全结果。形状与 foundation 一致：{ ok:false, error, message, detail? }。 */
function normalizeSystemFontsError(err) {
  if (isSystemFontsError(err)) {
    const out = { ok: false, error: err.code, message: foundationErrors.redactText(err.message || err.code) || err.code };
    if (err.detail !== undefined) out.detail = foundationErrors.redactValue(err.detail);
    return out;
  }
  return foundationErrors.normalizeError(err, { fallbackCode: foundationErrors.DXOS_ERR_INTERNAL });
}

function systemFontsCommandNotAllowed(command) {
  return createSystemFontsError(SYSTEM_FONTS_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的 systemFonts 命令：" + String(command == null ? "" : command), { command: command == null ? null : String(command) });
}

/** 渲染层出口：成功 { ok:true, value }；失败 normalizeSystemFontsError（与 foundation.toIpcResult 同形）。 */
async function toSystemFontsIpcResult(action) {
  try {
    const value = typeof action === "function" ? await action() : await action;
    return { ok: true, value: redactSystemFontsValue(value) };
  } catch (err) {
    return normalizeSystemFontsError(err);
  }
}

/**
 * 下行事件信封。
 * 为什么不用 dxos-foundation-events.createEventChannel：它的 DOMAIN_RE 只允许小写
 * （dxos-foundation-events.cjs:14），而本域命令通道按任务书是 "systemFonts:command"（驼峰），
 * 两条通道必须同名域。这里只复刻同一信封字段（channel/domain/kind/sequence/at/payload），
 * 不另造协议。字体域是只读目录投影，源 systemFonts.ts 无下行事件，属本仓观测性补足。
 */
const SYSTEM_FONTS_EVENT_KINDS = Object.freeze(["progress", "log"]);

function createSystemFontsEvent(options = {}) {
  const kind = SYSTEM_FONTS_EVENT_KINDS.includes(options.kind) ? options.kind : "progress";
  const payload = options.payload && typeof options.payload === "object" ? { ...options.payload } : {};
  return {
    channel: SYSTEM_FONTS_EVENT_CHANNEL,
    domain: SYSTEM_FONTS_DOMAIN,
    kind,
    sequence: Number.isSafeInteger(options.sequence) ? options.sequence : 0,
    at: Number.isFinite(options.at) ? options.at : Date.now(),
    payload,
  };
}

/** 源 :11-15 —— 三平台字体根目录；platform/env/home 可注入以便离线单测。 */
function systemFontDirectories(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || homedir();
  if (platform === "win32") return [join(env.WINDIR || "C:/Windows", "Fonts"), join(env.LOCALAPPDATA || home, "Microsoft/Windows/Fonts")];
  if (platform === "darwin") return ["/System/Library/Fonts", "/Library/Fonts", join(home, "Library/Fonts")];
  return ["/usr/share/fonts", "/usr/local/share/fonts", join(home, ".local/share/fonts"), join(home, ".fonts")];
}

/** 源 :16 —— 根目录归属判定；realpath 之后的落点必须仍在根内（含根自身）。 */
function isWithin(root, target) {
  return target === root || (typeof target === "string" && typeof root === "string" && target.startsWith(root + sep));
}

/** 源 :118 —— id 判据。 */
function isSystemFontId(id) {
  return typeof id === "string" && FONT_ID_RE.test(id);
}

/**
 * 源 :23 —— 单次表读取边界。
 * 先判长度再判绝对位置：超限时直接拒绝，绝不按声明长度分配内存。
 */
function assertFontTableRead(offset, length, maxBytes = MAX_FONT_BYTES, maxTableBytes = MAX_FONT_TABLE_BYTES) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw createSystemFontsError(SYSTEM_FONTS_ERR_INVALID_INPUT, "字体表读取偏移无效");
  }
  if (length > maxTableBytes) throw createSystemFontsError(SYSTEM_FONTS_ERR_TOO_LARGE, "字体表读取超过 1 MB 上限", { length, maxTableBytes });
  if (offset + length > maxBytes) throw createSystemFontsError(SYSTEM_FONTS_ERR_TOO_LARGE, "字体表超出限制", { offset, length, maxBytes });
  return { offset, length };
}

/** 源 :88 / :109 —— 单字体文件上限（<12 字节连 SFNT 头都放不下，直接不算字体）。 */
function assertFontSize(size, maxBytes = MAX_FONT_BYTES) {
  if (!Number.isSafeInteger(size) || size < 12) throw createSystemFontsError(SYSTEM_FONTS_ERR_INVALID_INPUT, "字体文件不足 12 字节，不是有效 SFNT", { size });
  if (size > maxBytes) throw createSystemFontsError(SYSTEM_FONTS_ERR_TOO_LARGE, "字体文件超过 64 MB 上限", { size, maxBytes });
  return size;
}

/** base64url 出口：与 media-service.cjs:367-370 同一口径，规避路径脱敏误伤字节。 */
function encodeFontBytes(buffer) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw createSystemFontsError(SYSTEM_FONTS_ERR_INVALID_INPUT, "encodeFontBytes 需要字节缓冲");
  return Buffer.from(buffer).toString("base64url");
}

/** 分页参数规整；limit 强制落在 [1, MAX_LIST_LIMIT]，与 foundation 数组截断上限对齐。 */
function normalizePage(options = {}) {
  const rawLimit = Number(options.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(MAX_LIST_LIMIT, Math.floor(rawLimit)) : DEFAULT_LIST_LIMIT;
  const rawOffset = Number(options.offset);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { limit, offset };
}

/**
 * 源 :19-64 fontFamilies —— 只解析边界内的 SFNT name 表，不调用任何 shell / 注册表 / 光栅化库。
 * read(offset, length) => Promise<Buffer>：由 service 注入的真实/假 reader。
 */
async function fontFamilies(read, options = {}) {
  if (typeof read !== "function") throw createSystemFontsError(SYSTEM_FONTS_ERR_INVALID_INPUT, "fontFamilies 需要字节读取函数");
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_FONT_BYTES;
  const maxTableBytes = Number.isSafeInteger(options.maxTableBytes) && options.maxTableBytes > 0 ? options.maxTableBytes : MAX_FONT_TABLE_BYTES;

  const readBounded = async (offset, length) => {
    assertFontTableRead(offset, length, maxBytes, maxTableBytes);
    const buffer = await read(offset, length);
    if (!Buffer.isBuffer(buffer) || buffer.length !== length) throw createSystemFontsError(SYSTEM_FONTS_ERR_INVALID_INPUT, "字体文件不完整");
    return buffer;
  };

  const head = await readBounded(0, 12);
  let offsets = [0];
  if (head.toString("ascii", 0, 4) === "ttcf") {
    const count = head.readUInt32BE(8);
    if (!count || count > MAX_TTC_COUNT) return [];
    const table = await readBounded(12, count * 4);
    offsets = Array.from({ length: count }, (_, index) => table.readUInt32BE(index * 4));
  }

  const names = new Set();
  for (const offset of offsets) {
    const header = await readBounded(offset, 12);
    const count = header.readUInt16BE(4);
    if (!count || count > MAX_SFNT_TABLES) continue;
    const directory = await readBounded(offset + 12, count * 16);
    for (let index = 0; index < count; index++) {
      const p = index * 16;
      if (directory.toString("ascii", p, p + 4) !== "name") continue;
      const size = directory.readUInt32BE(p + 12);
      if (size < 6 || size > maxTableBytes) continue;
      const table = await readBounded(directory.readUInt32BE(p + 8), size);
      const records = table.readUInt16BE(2);
      const strings = table.readUInt16BE(4);
      if (records > MAX_NAME_RECORDS || 6 + records * 12 > table.length) continue;
      const candidates = [];
      for (let n = 0; n < records; n++) {
        const r = 6 + n * 12;
        const platform = table.readUInt16BE(r);
        const language = table.readUInt16BE(r + 4);
        const id = table.readUInt16BE(r + 6);
        const len = table.readUInt16BE(r + 8);
        const start = strings + table.readUInt16BE(r + 10);
        if (![1, 16].includes(id) || start + len > table.length || len > MAX_NAME_BYTES) continue;
        const bytes = table.subarray(start, start + len);
        let name = "";
        if (platform === 0 || platform === 3) { for (let c = 0; c + 1 < bytes.length; c += 2) name += String.fromCharCode(bytes.readUInt16BE(c)); }
        else if (platform === 1) name = bytes.toString("latin1");
        name = name.replace(/[\x00-\x1f\x7f]/g, "").trim();
        if (name && name.length <= MAX_NAME_LENGTH) candidates.push({ name, rank: (id === 16 ? 100 : 0) + (language === 0x409 ? 20 : language === 0 ? 10 : 0) + (platform === 3 ? 5 : 0) });
      }
      candidates.sort((a, b) => b.rank - a.rank);
      if (candidates[0]) names.add(candidates[0].name);
    }
  }
  return [...names];
}

module.exports = {
  SYSTEM_FONTS_COMMAND_CHANNEL,
  SYSTEM_FONTS_EVENT_CHANNEL,
  SYSTEM_FONTS_DOMAIN,
  MAX_FONT_BYTES,
  MAX_FONT_TABLE_BYTES,
  MAX_TTC_COUNT,
  MAX_SFNT_TABLES,
  MAX_NAME_RECORDS,
  MAX_NAME_BYTES,
  MAX_SCAN_DEPTH,
  MAX_SCAN_ENTRIES,
  FONT_CACHE_TTL_MS,
  FONT_EXTENSIONS,
  FONT_ID_RE,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
  SYSTEM_FONTS_ERR_COMMAND_NOT_ALLOWED,
  SYSTEM_FONTS_ERR_INVALID_INPUT,
  SYSTEM_FONTS_ERR_NOT_FOUND,
  SYSTEM_FONTS_ERR_TOO_LARGE,
  SYSTEM_FONTS_ERR_CHANGED,
  SYSTEM_FONTS_ERR_UNAVAILABLE,
  SYSTEM_FONTS_ERR_INTERNAL,
  SYSTEM_FONTS_ERROR_CODES,
  SYSTEM_FONTS_COMMANDS,
  RISK_LEVELS,
  SYSTEM_FONTS_EVENT_KINDS,
  isSystemFontsCommand,
  systemFontsCommandEntry,
  systemFontsCommandRisk,
  systemFontsCommandRequiresCredential,
  listSystemFontsCommands,
  createSystemFontsError,
  isSystemFontsError,
  redactSystemFontsValue,
  normalizeSystemFontsError,
  systemFontsCommandNotAllowed,
  toSystemFontsIpcResult,
  createSystemFontsEvent,
  systemFontDirectories,
  isWithin,
  isSystemFontId,
  assertFontTableRead,
  assertFontSize,
  encodeFontBytes,
  normalizePage,
  fontFamilies,
};
