/**
 * Stage 1 · 无限画布在线更新：纯函数域（无 fs / 无网络 / 无 Electron）。
 *
 * 冻结的包格式（openarc-app/v1）：
 *   canvas-<version>.zip 内
 *     manifest.json  { format:"openarc-app/v1", id:"canvas", name, version, build,
 *                      entry:"index.js", styles:["index.css"], files:{ "index.js":sha256, "index.css":sha256 } }
 *     index.js / index.css
 *     manifest.sig   —— 对 manifest.json **原始字节** 的 Ed25519 签名（base64）
 *   校验链：内置公钥验 manifest.sig → 逐个比对 manifest.files 的 sha256；缺签名 / 缺文件即拒绝。
 *
 * 本文件只做纯函数与常量：释放全部"可被测试直接断言"的判定；
 * 落盘 / 下载 / 解压在 market-update-service.cjs。两者都以 market:command 为唯一通道。
 */
"use strict";

const crypto = require("node:crypto");

// ── 统一错误码（任务书冻结） ──
const MARKET_UPDATE_ERR_COMMAND_NOT_ALLOWED = "MARKET_UPDATE_COMMAND_NOT_ALLOWED";
const MARKET_UPDATE_ERR_NOT_READY = "MARKET_UPDATE_NOT_READY";
const MARKET_UPDATE_ERR_INVALID_INPUT = "MARKET_UPDATE_INVALID_INPUT";
const MARKET_UPDATE_ERR_UNAUTHENTICATED = "MARKET_UPDATE_UNAUTHENTICATED";
const MARKET_UPDATE_ERR_NOT_FOUND = "MARKET_UPDATE_NOT_FOUND";
const MARKET_UPDATE_ERR_NO_RELEASE = "MARKET_UPDATE_NO_RELEASE";
const MARKET_UPDATE_ERR_SIGNATURE_INVALID = "MARKET_UPDATE_SIGNATURE_INVALID";
const MARKET_UPDATE_ERR_DIGEST_MISMATCH = "MARKET_UPDATE_DIGEST_MISMATCH";
const MARKET_UPDATE_ERR_HOST_NOT_ALLOWED = "MARKET_UPDATE_HOST_NOT_ALLOWED";
const MARKET_UPDATE_ERR_SOURCE_DIGEST_MISMATCH = "MARKET_UPDATE_SOURCE_DIGEST_MISMATCH";
const MARKET_UPDATE_ERR_DOWNLOAD_FAILED = "MARKET_UPDATE_DOWNLOAD_FAILED";
const MARKET_UPDATE_ERR_CONFLICT = "MARKET_UPDATE_CONFLICT";
/**
 * 保留码。回退到内置版本（2026-10 可靠性修复）之后，rollback 在没有上一版已安装版本时
 * 改为「幂等成功 + 回退内置」，不再返回本码；码本身仍在冻结清单里，避免破坏既有契约与文案表。
 */
const MARKET_UPDATE_ERR_ROLLBACK_UNAVAILABLE = "MARKET_UPDATE_ROLLBACK_UNAVAILABLE";
const MARKET_UPDATE_ERR_UNSUPPORTED = "MARKET_UPDATE_UNSUPPORTED";
/** 有发布包、但渲染层还没有该应用的包加载路径：安装会改变磁盘却永远不生效，因此结构化拒绝。 */
const MARKET_UPDATE_ERR_NOT_LOADABLE = "MARKET_UPDATE_NOT_LOADABLE";
const DXOS_ERR_INTERNAL = "DXOS_ERR_INTERNAL";

const MARKET_UPDATE_ERROR_CODES = Object.freeze([
  MARKET_UPDATE_ERR_COMMAND_NOT_ALLOWED,
  MARKET_UPDATE_ERR_NOT_READY,
  MARKET_UPDATE_ERR_INVALID_INPUT,
  MARKET_UPDATE_ERR_UNAUTHENTICATED,
  MARKET_UPDATE_ERR_NOT_FOUND,
  MARKET_UPDATE_ERR_NO_RELEASE,
  MARKET_UPDATE_ERR_SIGNATURE_INVALID,
  MARKET_UPDATE_ERR_DIGEST_MISMATCH,
  MARKET_UPDATE_ERR_HOST_NOT_ALLOWED,
  MARKET_UPDATE_ERR_SOURCE_DIGEST_MISMATCH,
  MARKET_UPDATE_ERR_DOWNLOAD_FAILED,
  MARKET_UPDATE_ERR_CONFLICT,
  MARKET_UPDATE_ERR_ROLLBACK_UNAVAILABLE,
  MARKET_UPDATE_ERR_UNSUPPORTED,
  MARKET_UPDATE_ERR_NOT_LOADABLE,
]);

const MARKET_UPDATE_COMMANDS = Object.freeze([
  "market/update/status",
  "market/update/check",
  "market/update/install",
  "market/update/rollback",
  "market/update/health",
  "market/update/sources",
  "market/update/source/set",
]);

const MARKET_UPDATE_COMMAND_SET = new Set(MARKET_UPDATE_COMMANDS);
function isMarketUpdateCommand(command) { return typeof command === "string" && MARKET_UPDATE_COMMAND_SET.has(command); }

/** 包格式常量。 */
const CANVAS_APP_ID = "canvas";
/** JS 模块形态的固定入口（老格式；manifest 缺 kind 时按此形态校验）。 */
const CANVAS_ENTRY = "index.js";
const CANVAS_STYLE = "index.css";
/**
 * Stage 2 · 包形态。
 *   · js-module（缺省）：Stage 1 冻结的 JS 模块形态 entry:"index.js" + styles:["index.css"]；
 *   · static-web：静态 Web 应用包，entry 指向整棵静态树里的多页入口（画布为 static/canvas-list.html），
 *     files 覆盖要发布的整棵静态树。两种形态共用 format/id/version/build/签名与逐文件 sha256。
 */
const MANIFEST_KIND_JS = "js-module";
const MANIFEST_KIND_STATIC_WEB = "static-web";
const CANVAS_STATIC_ENTRY = "static/canvas-list.html";
const MANIFEST_FORMAT = "openarc-app/v1";
const MANIFEST_NAME = "manifest.json";
const MANIFEST_SIGNATURE_NAME = "manifest.sig";
const DEFAULT_BUILTIN_VERSION = "0.1.0";
const DEFAULT_CHANNEL = "stable";

/**
 * 应用注册表（后端侧）—— 与 src-vue/apps.ts 的 APPS **逐项一致**（tests 会核对 ID 集合）。
 *
 * 取值依据：这里的版本是「随包内置版本」，即当前 OpenArc OS 构建里编译进来的应用代码版本。
 * 本期所有内置应用与 package.json 的构建版本对齐（0.1.0）；画布已经独立发过一次包
 * （dist-updates/canvas-0.1.0.zip），所以它的内置版本同样是 0.1.0。此后每个应用可以按自己的
 * 发布节奏单独递增，互不牵连 —— 这张表就是后端计算 updateAvailable 的基准。
 *
 * 为什么后端也留一份（而不是从渲染层读）：updateAvailable / install 的判定不能由渲染层自报；
 * 前端 apps.ts 的同名字段用于展示，二者由 tests 强制一致。
 */
const APP_BUILTIN_VERSIONS = Object.freeze({
  home: "0.1.0",
  browser: "0.1.0",
  files: "0.1.0",
  "resource-library": "0.1.0",
  canvas: "0.1.0",
  projects: "0.1.0",
  organization: "0.1.0",
  skills: "0.1.0",
  "mcp-center": "0.1.0",
  protocols: "0.1.0",
  settings: "0.1.0",
  trash: "0.1.0",
  chat: "0.1.0",
  automation: "0.1.0",
  market: "0.1.0",
  calendar: "0.1.0",
  notes: "0.1.0",
  photos: "0.1.0",
  music: "0.1.0",
  weather: "0.1.0",
  video: "0.1.0",
  dev: "0.1.0",
  declare: "0.1.0",
  drama: "0.1.0",
  integrations: "0.1.0",
});

/**
 * 已安装包加载路径（泛化）：每个已注册应用都有加载路径。
 *   · canvas 走历史专用协议 openarc-canvas://bundle/（渲染层已接入，保持不变）；
 *   · 其余应用走通用只读协议 openarc-app://<appId>/（app-package-resolver.cjs），支持
 *     js-module 与 static-web 两种包形态，入口由 manifest.entry 决定。
 * 未在注册表里的 appId 仍然不可安装（normalizeAppId 拒绝），第三方 App 由 task-19 B 的
 * 第三方注册表另行登记后复用同一套加载路径。
 */
const GENERIC_APP_LOADER = "openarc-app";
const APP_PACKAGE_LOADERS = Object.freeze(Object.fromEntries(
  Object.keys(APP_BUILTIN_VERSIONS).map((id) => [id, id === CANVAS_APP_ID ? "openarc-canvas" : GENERIC_APP_LOADER]),
));

/** 应用声明的包形态：画布是历史 static-web；其余应用由安装后的 manifest.kind 决定（预装前不臆造）。 */
const APP_PACKAGE_KINDS = Object.freeze({ canvas: MANIFEST_KIND_STATIC_WEB });

/** appId 语法：小写字母开头，后跟小写字母 / 数字 / 连字符；且必须是注册表里的应用。 */
const APP_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** GitHub Releases 源默认仓库：owner/repo 可配。 */
const DEFAULT_REPOSITORY = Object.freeze({ owner: "invaders-2", repo: "OpenArc-OS" });
/** ModelScope 仓库源默认仓库（用户提供）。 */
const DEFAULT_MODELSCOPE_REPOSITORY = Object.freeze({ owner: "bllack", repo: "OpenArc-OS" });
/** 源注册表 kind；未登记的 kind 一律拒绝。默认源为 ModelScope 仓库（可显式切回 GitHub Releases）。 */
const SOURCE_KINDS = Object.freeze(["github-releases", "modelscope-repo"]);
const DEFAULT_SOURCE_KIND = "modelscope-repo";
/** ModelScope 约定的版本清单路径（仓库内）；保留 canvas 路径作为历史默认。 */
const MODELSCOPE_MANIFEST_PATH = "updates/canvas/latest.json";
/** 泛化后的清单路径：updates/<appId>/latest.json。 */
function modelscopeManifestPath(value) {
  return "updates/" + (normalizeAppId(value) || CANVAS_APP_ID) + "/latest.json";
}
/** 泛化后的资产名约定：<appId>-<version>.zip。 */
function appAssetName(appId, version) {
  return (normalizeAppId(appId) || CANVAS_APP_ID) + "-" + String(version) + ".zip";
}
/** owner/repo 段：只允许字母数字点划下划线；URL / 斜杠一律拒绝。 */
const SOURCE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * 白名单主机（必须 HTTPS），按源分组 —— 每个源只允许访问自己那组：
 *   GitHub Releases：
 *     api.github.com                        Releases API
 *     github.com                            releases/download 资产入口
 *     objects.githubusercontent.com         release 资产重定向落点
 *     github-releases.githubusercontent.com 旧版资产重定向域
 *     release-assets.githubusercontent.com  新版资产重定向域
 *   ModelScope 仓库：
 *     modelscope.cn                         API + 匿名下载入口
 *     cdn-lfs-cn-1.modelscope.cn            LFS 资产重定向落点（2026-10 实测，见 docs）
 * 其余一律拒绝；渲染层无法指定任意 URL，只能给 kind + owner/repo。
 */
const GITHUB_RELEASES_HOSTS = Object.freeze([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const MODELSCOPE_REPO_HOSTS = Object.freeze([
  "modelscope.cn",
  "cdn-lfs-cn-1.modelscope.cn",
]);
const ALLOWED_HOSTS = Object.freeze([...new Set([...GITHUB_RELEASES_HOSTS, ...MODELSCOPE_REPO_HOSTS])]);

const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REPO_SEGMENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
/**
 * 版本语法（发布友好，2026-10 起）：major.minor[.patch]，允许两段与前导零（发布常写 0.01）。
 * 比较按数值规范化（0.01 ≡ 0.1.0）；version 字段保留原始数字片段（"0.01" 不会变成 "0.1"）。
 * 与旧行为一致：build metadata 丢弃；numeric prerelease 标识符禁止前导零。
 */
const SEMVER_RE = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function createMarketUpdateError(code, message, detail) {
  const err = new Error(String(message == null ? code : message));
  err.name = "MarketUpdateError";
  err.code = MARKET_UPDATE_ERROR_CODES.includes(code) ? code : DXOS_ERR_INTERNAL;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function normalizeMarketUpdateError(err) {
  const code = err && typeof err === "object" && typeof err.code === "string" ? err.code : null;
  if (code && (MARKET_UPDATE_ERROR_CODES.includes(code) || code.startsWith("DXOS_ERR_"))) {
    return { ok: false, error: code, detail: String(err.message || code).slice(0, 400) };
  }
  return { ok: false, error: DXOS_ERR_INTERNAL, detail: String((err && err.message) || err || DXOS_ERR_INTERNAL).slice(0, 400) };
}

function marketUpdateCommandNotAllowed(command) {
  return createMarketUpdateError(
    MARKET_UPDATE_ERR_COMMAND_NOT_ALLOWED,
    "未知或未授权的 market/update 命令：" + String(command == null ? "" : command),
    { command: command == null ? null : String(command) },
  );
}

/**
 * 泛化后的 appId 归一化：缺省（null / ""）保持历史语义 = canvas；其它值必须是注册表里的应用，
 * 且语法为小写 slug。未知应用 / 大写 / 路径片段一律返回 null（调用方结构化为 INVALID_INPUT）。
 */
function normalizeAppId(value) {
  if (value == null || value === "") return CANVAS_APP_ID;
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!APP_ID_RE.test(id)) return null;
  return Object.prototype.hasOwnProperty.call(APP_BUILTIN_VERSIONS, id) ? id : null;
}

/** 注册表里的全部 appId（声明顺序即稳定输出顺序）。 */
function appIds() { return Object.keys(APP_BUILTIN_VERSIONS); }

/** 随包内置版本；appId 非法时回落到 DEFAULT_BUILTIN_VERSION（调用方应先 normalizeAppId）。 */
function builtinVersionForApp(value) {
  const id = normalizeAppId(value);
  return (id && APP_BUILTIN_VERSIONS[id]) || DEFAULT_BUILTIN_VERSION;
}

/** 应用是否可加载已安装包；同时给出协议入口（渲染层拿到的加载路径）。 */
function appLoadSupport(value) {
  const id = normalizeAppId(value);
  const loader = id ? APP_PACKAGE_LOADERS[id] || null : null;
  if (loader) {
    const loadUrl = loader === "openarc-canvas" ? "openarc-canvas://bundle/" : GENERIC_APP_LOADER + "://" + id + "/";
    return { appId: id, loadable: true, loader, loadUrl, reason: null };
  }
  return {
    appId: id,
    loadable: false,
    loader: null,
    loadUrl: null,
    reason: "appId 非法或未注册",
  };
}

/** 应用声明的包形态；未知应用回 null（不臆造）。安装前未声明 kind 的应用由 manifest.kind 决定。 */
function appPackageKind(value) {
  const id = normalizeAppId(value);
  return (id && APP_PACKAGE_KINDS[id]) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 更新源 / 主机白名单
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 只接受 { owner, repo } 两个字段；URL / 域名 / 路径分隔符一律拒绝。
 * 返回 null 表示非法，返回 DEFAULT_REPOSITORY 的副本表示缺省。
 */
function normalizeRepository(value) {
  if (value == null) return { owner: DEFAULT_REPOSITORY.owner, repo: DEFAULT_REPOSITORY.repo };
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const repo = typeof value.repo === "string" ? value.repo.trim() : "";
  if (!REPO_SEGMENT_RE.test(owner) || !REPO_SEGMENT_RE.test(repo)) return null;
  return { owner, repo };
}

function releasesApiUrl(repository) {
  const repo = normalizeRepository(repository) || DEFAULT_REPOSITORY;
  return "https://api.github.com/repos/" + repo.owner + "/" + repo.repo + "/releases?per_page=100";
}

function parseAbsoluteUrl(value) {
  try {
    const url = new URL(String(value));
    return { url, host: url.hostname.toLowerCase().replace(/\.$/, ""), protocol: url.protocol };
  } catch {
    return null;
  }
}

function isAllowedUrl(value, hosts = ALLOWED_HOSTS) {
  const parsed = parseAbsoluteUrl(value);
  return !!parsed && parsed.protocol === "https:" && hosts.includes(parsed.host);
}

function assertAllowedUrl(value, hosts = ALLOWED_HOSTS) {
  const parsed = parseAbsoluteUrl(value);
  if (!parsed) throw createMarketUpdateError(MARKET_UPDATE_ERR_HOST_NOT_ALLOWED, "不是合法的绝对 URL", { host: null });
  if (parsed.protocol !== "https:") throw createMarketUpdateError(MARKET_UPDATE_ERR_HOST_NOT_ALLOWED, "只允许 HTTPS 主机：" + parsed.host, { host: parsed.host });
  if (!hosts.includes(parsed.host)) throw createMarketUpdateError(MARKET_UPDATE_ERR_HOST_NOT_ALLOWED, "主机不在白名单：" + parsed.host, { host: parsed.host });
  return parsed.url.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// 语义化版本
// ─────────────────────────────────────────────────────────────────────────────

function parseSemver(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const stripped = text.startsWith("v") || text.startsWith("V") ? text.slice(1) : text;
  const match = SEMVER_RE.exec(stripped);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  for (const id of prerelease) {
    if (/^\d+$/.test(id) && id.length > 1 && id[0] === "0") return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return {
    major,
    minor,
    patch,
    prerelease,
    version: match[1] + "." + match[2] + (match[3] === undefined ? "" : "." + match[3])
      + (prerelease.length ? "-" + prerelease.join(".") : ""),
  };
}

function compareParsed(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (!ap.length && !bp.length) return 0;
  if (!ap.length) return 1;
  if (!bp.length) return -1;
  const length = Math.max(ap.length, bp.length);
  for (let index = 0; index < length; index += 1) {
    const x = ap[index];
    const y = bp[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) { const xi = Number(x); const yi = Number(y); if (xi !== yi) return xi < yi ? -1 : 1; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 非法版本比较返回 NaN（调用方用 > 0 / === 0 判定，NaN 两边都为 false）。 */
function compareSemver(a, b) {
  const left = typeof a === "string" ? parseSemver(a) : a;
  const right = typeof b === "string" ? parseSemver(b) : b;
  if (!left || !right || typeof left.major !== "number" || typeof right.major !== "number") return Number.NaN;
  return compareParsed(left, right);
}

// ─────────────────────────────────────────────────────────────────────────────
// Release 资产解析与通道选择
// ─────────────────────────────────────────────────────────────────────────────

/** 资产名固定 <appId>-<version>.zip。 */
function parseAppAsset(name, value) {
  if (typeof name !== "string") return null;
  const id = normalizeAppId(value) || CANVAS_APP_ID;
  const match = new RegExp("^" + id + "-(.+)\\.zip$").exec(name);
  if (!match) return null;
  const parsed = parseSemver(match[1]);
  if (!parsed) return null;
  return { appId: id, version: parsed.version, semver: parsed, assetName: name };
}

/** 历史入口：canvas 资产解析（行为不变）。 */
function parseCanvasAsset(name) {
  return parseAppAsset(name, CANVAS_APP_ID);
}

function channelAllows(semver, release, channel) {
  if (channel === "stable") return semver.prerelease.length === 0 && release.prerelease !== true;
  return true;
}

/** 把 GitHub Releases 投影成候选清单（按语义化版本降序）；draft 一律跳过；资产名必须属于该 appId。 */
function collectAppReleases(releases, value, channel = DEFAULT_CHANNEL) {
  const appId = normalizeAppId(value) || CANVAS_APP_ID;
  const out = [];
  if (!Array.isArray(releases)) return out;
  for (const release of releases) {
    if (!release || typeof release !== "object" || release.draft === true) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    for (const asset of assets) {
      const parsed = parseAppAsset(asset && asset.name, appId);
      if (!parsed) continue;
      if (!channelAllows(parsed.semver, release, channel)) continue;
      const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : (typeof asset.url === "string" ? asset.url : "");
      if (!url) continue;
      const size = Number(asset.size);
      const published = Date.parse(release.published_at);
      out.push({
        appId,
        version: parsed.version,
        semver: parsed.semver,
        assetName: parsed.assetName,
        url,
        size: Number.isFinite(size) ? size : 0,
        assetSha256: typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice(7) : null,
        tag: typeof release.tag_name === "string" ? release.tag_name : "",
        notesUrl: typeof release.html_url === "string" ? release.html_url : "",
        publishedAt: Number.isFinite(published) ? published : 0,
        prerelease: parsed.semver.prerelease.length > 0 || release.prerelease === true,
      });
    }
  }
  out.sort((a, b) => compareParsed(b.semver, a.semver));
  return out;
}

/** 历史入口：canvas 候选清单（行为不变）。 */
function collectCanvasReleases(releases, channel = DEFAULT_CHANNEL) {
  return collectAppReleases(releases, CANVAS_APP_ID, channel);
}

function selectLatestAppRelease(releases, value, channel = DEFAULT_CHANNEL) {
  return collectAppReleases(releases, value, channel)[0] || null;
}

function findAppReleaseByVersion(releases, version, value, channel = DEFAULT_CHANNEL) {
  const target = typeof version === "string" ? parseSemver(version) : null;
  if (!target) return null;
  return collectAppReleases(releases, value, channel).find((item) => compareParsed(item.semver, target) === 0) || null;
}

/** 历史入口：canvas 选版（行为不变）。 */
function selectLatestCanvasRelease(releases, channel = DEFAULT_CHANNEL) {
  return selectLatestAppRelease(releases, CANVAS_APP_ID, channel);
}

function findCanvasReleaseByVersion(releases, version, channel = DEFAULT_CHANNEL) {
  return findAppReleaseByVersion(releases, version, CANVAS_APP_ID, channel);
}

// ─────────────────────────────────────────────────────────────────────────────
// manifest / 文件摘要 / 签名
// ─────────────────────────────────────────────────────────────────────────────

/** 单层相对文件名；拒绝绝对路径、盘符、反斜杠、空段、"." 与 ".."。 */
function isSafeEntryName(name) {
  if (typeof name !== "string" || !name || name.length > 200) return false;
  if (name.includes("\u0000") || name.includes("\\")) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  const segments = name.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * 严格校验 manifest；失败返回 { ok:false, error }（error 带 MARKET_UPDATE_* code）。
 * options.appId 缺省 = canvas（历史行为不变）；传入后 manifest.id 必须与之一致。
 */
function normalizeManifest(raw, options = {}) {
  // allowUnknownAppId：第三方注册表已登记但不是内置应用；只允许受信任的安装/解析路径显式开启。
  const requestedAppId = typeof (options && options.appId) === "string" ? options.appId.trim() : "";
  const appId = normalizeAppId(requestedAppId)
    || (options && options.allowUnknownAppId === true && APP_ID_RE.test(requestedAppId) ? requestedAppId : CANVAS_APP_ID);
  const fail = (detail) => ({ ok: false, error: createMarketUpdateError(MARKET_UPDATE_ERR_INVALID_INPUT, detail) });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("manifest 必须是 JSON 对象");
  if (raw.format !== MANIFEST_FORMAT) return fail("manifest.format 必须是 " + MANIFEST_FORMAT);
  if (raw.id !== appId) return fail("manifest.id 必须是 " + appId);
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 120) : "";
  if (!name) return fail("manifest.name 必填");
  const parsed = parseSemver(raw.version);
  if (!parsed) return fail("manifest.version 不是合法语义化版本");
  const build = Number(raw.build);
  if (!Number.isSafeInteger(build) || build < 1) return fail("manifest.build 必须是不小于 1 的整数");
  // kind：缺省 = 老格式 js-module（Stage 1 兼容）；显式 static-web 走静态 Web 应用包。
  let kind = MANIFEST_KIND_JS;
  if (raw.kind != null && raw.kind !== "") {
    if (raw.kind !== MANIFEST_KIND_JS && raw.kind !== MANIFEST_KIND_STATIC_WEB) {
      return fail("manifest.kind 只支持 " + MANIFEST_KIND_JS + " 或 " + MANIFEST_KIND_STATIC_WEB);
    }
    kind = raw.kind;
  }
  // 占位标记：打包脚本 --placeholder 写 true，安装/加载一律拒绝（防止被当真产物发布）。
  const placeholder = raw.placeholder === true;
  if (!raw.files || typeof raw.files !== "object" || Array.isArray(raw.files)) return fail("manifest.files 必须是对象");
  const files = {};
  for (const [file, hash] of Object.entries(raw.files)) {
    if (!isSafeEntryName(file)) return fail("manifest.files 含不安全文件名：" + file);
    if (typeof hash !== "string" || !SHA256_RE.test(hash)) return fail("manifest.files 的 sha256 非法：" + file);
    files[file] = hash;
  }
  if (!Object.keys(files).length) return fail("manifest.files 不能为空");

  if (kind === MANIFEST_KIND_JS) {
    if (raw.entry !== CANVAS_ENTRY) return fail("manifest.entry 必须固定为 " + CANVAS_ENTRY);
    if (!Array.isArray(raw.styles) || raw.styles.length !== 1 || raw.styles[0] !== CANVAS_STYLE) return fail("manifest.styles 必须固定为 [" + CANVAS_STYLE + "]");
    if (!files[CANVAS_ENTRY]) return fail("manifest.files 必须包含 " + CANVAS_ENTRY);
    if (!files[CANVAS_STYLE]) return fail("manifest.files 必须包含 " + CANVAS_STYLE);
    return {
      ok: true,
      value: {
        format: MANIFEST_FORMAT,
        id: appId,
        name,
        version: parsed.version,
        semver: parsed,
        build,
        kind,
        entry: CANVAS_ENTRY,
        styles: [CANVAS_STYLE],
        files,
        placeholder,
      },
    };
  }

  // static-web：entry 是整棵静态树里的多页入口，必须是安全的相对 .html 路径且出现在 files 里。
  const entry = typeof raw.entry === "string" ? raw.entry : "";
  if (!isSafeEntryName(entry)) return fail("manifest.entry 必须是安全的相对路径");
  if (!/\.html$/i.test(entry)) return fail("static-web 的 manifest.entry 必须是 .html 文件");
  if (!files[entry]) return fail("manifest.files 必须包含 entry：" + entry);
  return {
    ok: true,
    value: {
      format: MANIFEST_FORMAT,
      id: appId,
      name,
      version: parsed.version,
      semver: parsed,
      build,
      kind,
      entry,
      styles: [],
      files,
      placeholder,
    },
  };
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** 整包摘要 = manifest.json 原始字节的 sha256（manifest 内已含全部文件摘要）。 */
function packageDigest(manifestBytes) {
  return sha256Hex(manifestBytes);
}

/**
 * 内置公钥的三种形态都接受：
 *   · 32 字节原始 Ed25519 公钥的 base64（keygen 脚本写出）
 *   · SPKI DER 的 base64
 *   · PEM 文本
 */
function toPublicKey(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  try {
    if (text.includes("BEGIN PUBLIC KEY")) return crypto.createPublicKey(text);
    const bytes = Buffer.from(text, "base64");
    if (bytes.length === 32) {
      const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]);
      return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    }
    return crypto.createPublicKey({ key: bytes, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

/** Ed25519 验签：对 manifest.json 原始字节。缺签名 / 公钥不可用一律 ok:false。 */
function verifyManifestSignature({ manifestBytes, signatureBase64, publicKeyBase64 = null, publicKeyObject = null } = {}) {
  if (!Buffer.isBuffer(manifestBytes)) return { ok: false, reason: "manifest-bytes-missing" };
  const key = publicKeyObject || toPublicKey(publicKeyBase64);
  if (!key) return { ok: false, reason: "public-key-unavailable" };
  const signature = Buffer.from(String(signatureBase64 || ""), "base64");
  if (!signature.length) return { ok: false, reason: "signature-missing" };
  try {
    return crypto.verify(null, manifestBytes, key, signature) ? { ok: true } : { ok: false, reason: "signature-invalid" };
  } catch {
    return { ok: false, reason: "signature-invalid" };
  }
}

function signManifestBytes(manifestBytes, privateKey) {
  return crypto.sign(null, manifestBytes, privateKey).toString("base64");
}

module.exports = {
  MARKET_UPDATE_COMMANDS, isMarketUpdateCommand,
  MARKET_UPDATE_ERROR_CODES,
  MARKET_UPDATE_ERR_COMMAND_NOT_ALLOWED, MARKET_UPDATE_ERR_NOT_READY, MARKET_UPDATE_ERR_INVALID_INPUT,
  MARKET_UPDATE_ERR_UNAUTHENTICATED, MARKET_UPDATE_ERR_NOT_FOUND, MARKET_UPDATE_ERR_NO_RELEASE,
  MARKET_UPDATE_ERR_SIGNATURE_INVALID, MARKET_UPDATE_ERR_DIGEST_MISMATCH, MARKET_UPDATE_ERR_HOST_NOT_ALLOWED,
  MARKET_UPDATE_ERR_SOURCE_DIGEST_MISMATCH,
  MARKET_UPDATE_ERR_DOWNLOAD_FAILED, MARKET_UPDATE_ERR_CONFLICT, MARKET_UPDATE_ERR_ROLLBACK_UNAVAILABLE,
  MARKET_UPDATE_ERR_UNSUPPORTED, MARKET_UPDATE_ERR_NOT_LOADABLE, DXOS_ERR_INTERNAL,
  createMarketUpdateError, normalizeMarketUpdateError, marketUpdateCommandNotAllowed, normalizeAppId,
  CANVAS_APP_ID, CANVAS_ENTRY, CANVAS_STYLE, MANIFEST_FORMAT, MANIFEST_NAME, MANIFEST_SIGNATURE_NAME,
  MANIFEST_KIND_JS, MANIFEST_KIND_STATIC_WEB, CANVAS_STATIC_ENTRY,
  APP_BUILTIN_VERSIONS, APP_PACKAGE_LOADERS, APP_PACKAGE_KINDS, GENERIC_APP_LOADER, APP_ID_RE,
  appIds, builtinVersionForApp, appLoadSupport, appPackageKind,
  DEFAULT_BUILTIN_VERSION, DEFAULT_CHANNEL, DEFAULT_REPOSITORY, DEFAULT_MODELSCOPE_REPOSITORY,
  SOURCE_KINDS, DEFAULT_SOURCE_KIND, MODELSCOPE_MANIFEST_PATH, modelscopeManifestPath, appAssetName, SOURCE_SEGMENT_RE,
  GITHUB_RELEASES_HOSTS, MODELSCOPE_REPO_HOSTS, ALLOWED_HOSTS, MAX_PACKAGE_BYTES,
  normalizeRepository, releasesApiUrl, parseAbsoluteUrl, isAllowedUrl, assertAllowedUrl,
  parseSemver, compareSemver, compareParsed,
  parseAppAsset, collectAppReleases, selectLatestAppRelease, findAppReleaseByVersion,
  parseCanvasAsset, collectCanvasReleases, selectLatestCanvasRelease, findCanvasReleaseByVersion,
  isSafeEntryName, normalizeManifest, sha256Hex, packageDigest, toPublicKey, verifyManifestSignature, signManifestBytes,
};
