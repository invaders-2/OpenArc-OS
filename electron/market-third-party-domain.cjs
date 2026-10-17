"use strict";
/**
 * task-19 B · 第三方应用目录的纯函数域（无 fs / 无网络 / 无 Electron）。
 *
 * 目录格式（本地 catalog 与在线源共用）：
 *   {
 *     "format": "openarc-third-party-catalog/v1",
 *     "apps": [{
 *       "id": "notes-plus",                 // 小写字母开头；不能与内置应用重名
 *       "name": "增强文稿",
 *       "version": "0.2.0",                 // 合法 semver，且与包内 manifest.version 一致
 *       "packageUrl": "https://…zip",       // 与 packageFile 二选一；只允许 HTTPS + 白名单主机
 *       "packageFile": "packages/x.zip",    // 本地 catalog 同目录下的相对路径（离线安装）
 *       "sha256": "64 位小写十六进制",        // 下载/读取后必须逐字节匹配
 *       "size": 12345,                      // 可选；用于下载前体积上限提示
 *       "minSystemVersion": "0.1.0",         // 可选；不满足 → 不兼容，绝不安装
 *       "maxSystemVersion": "0.9.0",         // 可选
 *       "entry": "index.js",                // 可选，仅信息展示；真正入口以签名的 manifest 为准
 *       "description": "…", "author": "…", "homepage": "https://…"
 *     }]
 *   }
 *
 * 信任链与官方应用一致：包内 manifest.sig 由 app-update-keys.json 的 <appId> 公钥验签，
 * 再逐个比对 manifest.files 的 sha256；本文件只负责目录/兼容性/URL 形状校验。
 */
const domain = require("./market-update-domain.cjs");

const CATALOG_FORMAT = "openarc-third-party-catalog/v1";
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_THIRD_PARTY_APPS = 200;

const MARKET_THIRDPARTY_ERR_COMMAND_NOT_ALLOWED = "MARKET_THIRDPARTY_COMMAND_NOT_ALLOWED";
const MARKET_THIRDPARTY_ERR_NOT_READY = "MARKET_THIRDPARTY_NOT_READY";
const MARKET_THIRDPARTY_ERR_INVALID_INPUT = "MARKET_THIRDPARTY_INVALID_INPUT";
const MARKET_THIRDPARTY_ERR_UNAUTHENTICATED = "MARKET_THIRDPARTY_UNAUTHENTICATED";
const MARKET_THIRDPARTY_ERR_CATALOG_MISSING = "MARKET_THIRDPARTY_CATALOG_MISSING";
const MARKET_THIRDPARTY_ERR_CATALOG_INVALID = "MARKET_THIRDPARTY_CATALOG_INVALID";
const MARKET_THIRDPARTY_ERR_NOT_FOUND = "MARKET_THIRDPARTY_NOT_FOUND";
const MARKET_THIRDPARTY_ERR_RESERVED_APP = "MARKET_THIRDPARTY_RESERVED_APP";
const MARKET_THIRDPARTY_ERR_NOT_COMPATIBLE = "MARKET_THIRDPARTY_NOT_COMPATIBLE";
const MARKET_THIRDPARTY_ERR_DIGEST_MISMATCH = "MARKET_THIRDPARTY_DIGEST_MISMATCH";
const MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED = "MARKET_THIRDPARTY_DOWNLOAD_FAILED";
const MARKET_THIRDPARTY_ERR_SOURCE_NOT_ALLOWED = "MARKET_THIRDPARTY_SOURCE_NOT_ALLOWED";
const MARKET_THIRDPARTY_ERR_INSTALL_FAILED = "MARKET_THIRDPARTY_INSTALL_FAILED";
const MARKET_THIRDPARTY_ERR_NOT_LOADABLE = "MARKET_THIRDPARTY_NOT_LOADABLE";
const MARKET_THIRDPARTY_ERR_SIGNATURE_INVALID = "MARKET_THIRDPARTY_SIGNATURE_INVALID";
const MARKET_THIRDPARTY_ERR_RESTORE_FAILED = "MARKET_THIRDPARTY_RESTORE_FAILED";
const DXOS_ERR_INTERNAL = "DXOS_ERR_INTERNAL";

const MARKET_THIRDPARTY_ERROR_CODES = Object.freeze([
  MARKET_THIRDPARTY_ERR_COMMAND_NOT_ALLOWED,
  MARKET_THIRDPARTY_ERR_NOT_READY,
  MARKET_THIRDPARTY_ERR_INVALID_INPUT,
  MARKET_THIRDPARTY_ERR_UNAUTHENTICATED,
  MARKET_THIRDPARTY_ERR_CATALOG_MISSING,
  MARKET_THIRDPARTY_ERR_CATALOG_INVALID,
  MARKET_THIRDPARTY_ERR_NOT_FOUND,
  MARKET_THIRDPARTY_ERR_RESERVED_APP,
  MARKET_THIRDPARTY_ERR_NOT_COMPATIBLE,
  MARKET_THIRDPARTY_ERR_DIGEST_MISMATCH,
  MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED,
  MARKET_THIRDPARTY_ERR_SOURCE_NOT_ALLOWED,
  MARKET_THIRDPARTY_ERR_INSTALL_FAILED,
  MARKET_THIRDPARTY_ERR_NOT_LOADABLE,
  MARKET_THIRDPARTY_ERR_SIGNATURE_INVALID,
  MARKET_THIRDPARTY_ERR_RESTORE_FAILED,
]);

const THIRDPARTY_COMMANDS = Object.freeze([
  "market/thirdparty/list",
  "market/thirdparty/install",
  "market/thirdparty/rollback",
  "market/thirdparty/source/get",
  "market/thirdparty/source/set",
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_RELATIVE_PATH_RE = /^[A-Za-z0-9._/-]+$/;
function isSafeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("..") && SAFE_RELATIVE_PATH_RE.test(value);
}

function createThirdPartyError(code, message, detail) {
  const error = new Error(String(message == null ? code : message));
  error.name = "ThirdPartyMarketError";
  error.code = MARKET_THIRDPARTY_ERROR_CODES.includes(code) ? code : DXOS_ERR_INTERNAL;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function normalizeThirdPartyError(error) {
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : null;
  if (code && (MARKET_THIRDPARTY_ERROR_CODES.includes(code) || code.startsWith("DXOS_ERR_"))) {
    return { ok: false, error: code, detail: String(error.message || code).slice(0, 400) };
  }
  return { ok: false, error: DXOS_ERR_INTERNAL, detail: String((error && error.message) || error || DXOS_ERR_INTERNAL).slice(0, 400) };
}

function isThirdPartyCommand(command) {
  return typeof command === "string" && THIRDPARTY_COMMANDS.includes(command);
}

function thirdPartyCommandNotAllowed(command) {
  return createThirdPartyError(MARKET_THIRDPARTY_ERR_COMMAND_NOT_ALLOWED, "未知或未授权的第三方市场命令：" + String(command == null ? "" : command));
}

function isReservedAppId(id) {
  return !!domain.normalizeAppId(id);
}

function stringField(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeCatalogApp(raw, options = {}) {
  const fail = (detail) => ({ ok: false, detail });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("第三方应用条目必须是对象");
  const id = stringField(raw.id, 64);
  if (!domain.APP_ID_RE.test(id)) return fail("第三方应用 id 不合法：" + (id || "<empty>"));
  if (isReservedAppId(id)) return fail("第三方应用不能使用内置应用 id：" + id);
  const name = stringField(raw.name, 80);
  if (!name) return fail(id + " 缺少名称");
  const versionParsed = domain.parseSemver(raw.version);
  if (!versionParsed) return fail(id + " 的 version 不是合法语义化版本");
  const packageUrl = stringField(raw.packageUrl, 2000);
  const packageFile = stringField(raw.packageFile, 500);
  if (!!packageUrl === !!packageFile) return fail(id + " 必须且只能声明 packageUrl 或 packageFile 之一");
  if (options.source === "online" && packageFile) return fail(id + " 的在线目录只能使用 packageUrl");
  if (packageFile && !isSafeRelativePath(packageFile)) return fail(id + " 的 packageFile 必须是安全相对路径");
  if (packageUrl) {
    let parsedUrl;
    try { parsedUrl = new URL(packageUrl); } catch { return fail(id + " 的 packageUrl 不是合法 URL"); }
    if (parsedUrl.protocol !== "https:") return fail(id + " 的 packageUrl 只允许 HTTPS");
    try { domain.assertAllowedUrl(parsedUrl.toString(), domain.ALLOWED_HOSTS); }
    catch { return fail(id + " 的 packageUrl 主机不在白名单：" + parsedUrl.hostname); }
  }
  const sha256 = stringField(raw.sha256, 64).toLowerCase();
  if (!SHA256_RE.test(sha256)) return fail(id + " 的 sha256 必须是 64 位小写十六进制");
  let size = null;
  if (raw.size != null) {
    const parsedSize = Number(raw.size);
    if (!Number.isSafeInteger(parsedSize) || parsedSize <= 0 || parsedSize > domain.MAX_PACKAGE_BYTES) return fail(id + " 的 size 超出允许范围");
    size = parsedSize;
  }
  const minParsed = raw.minSystemVersion == null ? null : domain.parseSemver(raw.minSystemVersion);
  if (raw.minSystemVersion != null && !minParsed) return fail(id + " 的 minSystemVersion 不是合法语义化版本");
  const maxParsed = raw.maxSystemVersion == null ? null : domain.parseSemver(raw.maxSystemVersion);
  if (raw.maxSystemVersion != null && !maxParsed) return fail(id + " 的 maxSystemVersion 不是合法语义化版本");
  if (minParsed && maxParsed && domain.compareParsed(minParsed, maxParsed) > 0) return fail(id + " 的 minSystemVersion 大于 maxSystemVersion");
  const homepage = stringField(raw.homepage, 300);
  if (homepage && !/^https:\/\//i.test(homepage)) return fail(id + " 的 homepage 只允许 HTTPS");
  return {
    ok: true,
    value: {
      id, name, version: versionParsed.version, semver: versionParsed,
      packageUrl: packageUrl || null, packageFile: packageFile || null,
      sha256, size, minSystemVersion: minParsed ? minParsed.version : null, maxSystemVersion: maxParsed ? maxParsed.version : null,
      entry: stringField(raw.entry, 200) || null,
      description: stringField(raw.description, 500) || null,
      author: stringField(raw.author, 120) || null,
      homepage: homepage || null,
      source: options.source === "online" ? "online" : "local",
    },
  };
}

/**
 * 目录规范化：逐条校验 + 去重；坏条目进入 rejected，不让一条坏数据拖垮整个目录。
 * format 不匹配 / apps 不是数组才整份拒绝。
 */
function normalizeCatalog(raw, options = {}) {
  const fail = (code, detail) => ({ ok: false, error: createThirdPartyError(code, detail) });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(MARKET_THIRDPARTY_ERR_CATALOG_INVALID, "第三方目录必须是 JSON 对象");
  if (raw.format !== CATALOG_FORMAT) return fail(MARKET_THIRDPARTY_ERR_CATALOG_INVALID, "第三方目录 format 必须是 " + CATALOG_FORMAT);
  if (!Array.isArray(raw.apps)) return fail(MARKET_THIRDPARTY_ERR_CATALOG_INVALID, "第三方目录 apps 必须是数组");
  if (raw.apps.length > MAX_THIRD_PARTY_APPS) return fail(MARKET_THIRDPARTY_ERR_CATALOG_INVALID, "第三方目录条目超过上限");
  const apps = [];
  const rejected = [];
  const seen = new Set();
  for (const item of raw.apps) {
    const normalized = normalizeCatalogApp(item, options);
    if (!normalized.ok) { rejected.push({ id: item && typeof item.id === "string" ? item.id.slice(0, 64) : null, reason: normalized.detail }); continue; }
    if (seen.has(normalized.value.id)) { rejected.push({ id: normalized.value.id, reason: "重复的应用 id" }); continue; }
    seen.add(normalized.value.id);
    apps.push(normalized.value);
  }
  return { ok: true, value: { format: CATALOG_FORMAT, apps, rejected, source: options.source === "online" ? "online" : "local" } };
}

/** 系统版本兼容性；不满足必须拒绝安装（不是警告）。 */
function checkCompatibility(entry, systemVersion) {
  const current = domain.parseSemver(systemVersion);
  if (!current) return { ok: false, detail: "当前系统版本不是合法语义化版本：" + String(systemVersion) };
  if (entry.minSystemVersion && domain.compareSemver(current.version, entry.minSystemVersion) < 0) {
    return { ok: false, detail: "需要系统版本 ≥ " + entry.minSystemVersion + "，当前 " + current.version };
  }
  if (entry.maxSystemVersion && domain.compareSemver(current.version, entry.maxSystemVersion) > 0) {
    return { ok: false, detail: "最高支持系统版本 " + entry.maxSystemVersion + "，当前 " + current.version };
  }
  return { ok: true };
}

function sha256Hex(buffer) {
  return require("node:crypto").createHash("sha256").update(buffer).digest("hex");
}

module.exports = {
  CATALOG_FORMAT, MAX_CATALOG_BYTES, MAX_THIRD_PARTY_APPS,
  MARKET_THIRDPARTY_ERROR_CODES,
  MARKET_THIRDPARTY_ERR_COMMAND_NOT_ALLOWED, MARKET_THIRDPARTY_ERR_NOT_READY,
  MARKET_THIRDPARTY_ERR_INVALID_INPUT, MARKET_THIRDPARTY_ERR_UNAUTHENTICATED,
  MARKET_THIRDPARTY_ERR_CATALOG_MISSING, MARKET_THIRDPARTY_ERR_CATALOG_INVALID,
  MARKET_THIRDPARTY_ERR_NOT_FOUND, MARKET_THIRDPARTY_ERR_RESERVED_APP,
  MARKET_THIRDPARTY_ERR_NOT_COMPATIBLE, MARKET_THIRDPARTY_ERR_DIGEST_MISMATCH,
  MARKET_THIRDPARTY_ERR_DOWNLOAD_FAILED, MARKET_THIRDPARTY_ERR_SOURCE_NOT_ALLOWED,
  MARKET_THIRDPARTY_ERR_INSTALL_FAILED, MARKET_THIRDPARTY_ERR_NOT_LOADABLE,
  MARKET_THIRDPARTY_ERR_SIGNATURE_INVALID, MARKET_THIRDPARTY_ERR_RESTORE_FAILED,
  THIRDPARTY_COMMANDS, isThirdPartyCommand, thirdPartyCommandNotAllowed,
  createThirdPartyError, normalizeThirdPartyError,
  isReservedAppId, normalizeCatalogApp, normalizeCatalog, checkCompatibility, sha256Hex,
};
