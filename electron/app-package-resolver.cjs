"use strict";
/**
 * 通用已安装应用包解析 + 只读协议（openarc-app://<appId>/<path>）。
 *
 * 与 canvas-package-resolver.cjs 的关系：
 *   · canvas 仍有专用协议 openarc-canvas://bundle/（渲染层已接入，行为不变）；
 *   · 本模块把同一套"已安装包优先"的安全语义泛化到全部已注册应用：
 *     current.json → 版本目录 → Ed25519 验签 → manifest 合法性（id 必须等于 appId）→
 *     逐文件 sha256 → entry 落盘；任一环失败都不加载该版本，渲染层回退随包内置应用。
 *   · 支持 js-module 与 static-web 两种包形态（入口由 manifest.entry 决定），
 *     因此 market 的 install 对所有应用都能"装到磁盘 -> 真的能加载"。
 *
 * 安全边界（与 canvas 同口径）：
 *   · 只读；只服务 manifest.files 里列过且已验过 sha256 的文件；
 *   · MIME 白名单 + 拒绝目录穿越 / 反斜杠 / NUL / 未知扩展；
 *   · 不返回绝对路径；协议覆盖的 appId 必须是已注册应用（options.isKnownApp 可扩展第三方注册表）。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const domain = require("./market-update-domain.cjs");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

const APP_MIME = Object.freeze({
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
});

const APP_FALLBACK_REASONS = Object.freeze([
  "pointer-missing",
  "pointer-cleared",
  "pointer-invalid",
  "pointer-digest-mismatch",
  "version-dir-missing",
  "manifest-missing",
  "signature-missing",
  "signature-invalid",
  "manifest-invalid",
  "placeholder",
  "entry-missing",
  "file-missing",
  "digest-mismatch",
  "public-key-unavailable",
  "app-unknown",
]);

function sha256Hex(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }

function loadAppPublicKey(keysFile, appId) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch { return { ok: false, reason: "public-key-unavailable", detail: "内置更新公钥文件不可读" }; }
  const value = raw && typeof raw[appId] === "string" ? raw[appId].trim() : "";
  if (!value) return { ok: false, reason: "public-key-unavailable", detail: "app-update-keys.json 缺少 " + appId + " 公钥" };
  const key = domain.toPublicKey(value);
  if (!key) return { ok: false, reason: "public-key-unavailable", detail: appId + " 公钥不是合法 Ed25519 公钥" };
  return { ok: true, key };
}

/** 只读 current.json；缺失 / 内置标记 / 损坏分别给结构化原因。 */
function readAppPointer(stateDir) {
  let text;
  try { text = fs.readFileSync(path.join(stateDir, "current.json"), "utf8"); }
  catch { return { ok: false, reason: "pointer-missing", detail: "current.json 不存在" }; }
  let raw;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: "pointer-invalid", detail: "current.json 不是合法 JSON" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "pointer-invalid", detail: "current.json 不是对象" };
  if (raw.mode === "builtin" && (raw.version == null || raw.version === null)) {
    return { ok: false, reason: "pointer-cleared", detail: "已回退到随包内置版本" };
  }
  const parsed = typeof raw.version === "string" ? domain.parseSemver(raw.version) : null;
  if (!parsed) return { ok: false, reason: "pointer-invalid", detail: "current.json.version 不是合法语义化版本" };
  return { ok: true, version: parsed.version, digest: typeof raw.digest === "string" ? raw.digest : null };
}

/** 校验已安装版本目录；返回 {ok, version, digest, kind, entry, files, dir, reason, detail}。 */
function verifyInstalledPackage(appId, dir, pointer, publicKey) {
  let manifestBytes;
  try { manifestBytes = fs.readFileSync(path.join(dir, domain.MANIFEST_NAME)); }
  catch { return { ok: false, reason: "manifest-missing", detail: "版本目录缺少 manifest.json" }; }
  let signatureText;
  try { signatureText = fs.readFileSync(path.join(dir, domain.MANIFEST_SIGNATURE_NAME), "utf8").trim(); }
  catch { return { ok: false, reason: "signature-missing", detail: "版本目录缺少 manifest.sig" }; }
  const signature = domain.verifyManifestSignature({ manifestBytes, signatureBase64: signatureText, publicKeyObject: publicKey });
  if (!signature.ok) return { ok: false, reason: "signature-invalid", detail: "manifest.sig 验签失败" };
  let raw;
  try { raw = JSON.parse(manifestBytes.toString("utf8")); } catch { return { ok: false, reason: "manifest-invalid", detail: "manifest.json 不是合法 JSON" }; }
  const normalized = domain.normalizeManifest(raw, { appId, allowUnknownAppId: true });
  if (!normalized.ok) return { ok: false, reason: "manifest-invalid", detail: String((normalized.error && normalized.error.message) || "manifest 非法") };
  const manifest = normalized.value;
  // canvas 还有专用协议 openarc-canvas://（只认 static-web）；通用解析器对 canvas 保持同一形态口径，
  // 否则会出现"通用 health 说可加载、画布协议实际加载不了"的双口径。
  if (appId === domain.CANVAS_APP_ID && manifest.kind !== domain.MANIFEST_KIND_STATIC_WEB) {
    return { ok: false, reason: "not-static-web", detail: "画布已安装包必须是 static-web 形态" };
  }
  if (manifest.placeholder) return { ok: false, reason: "placeholder", detail: "占位包（manifest.placeholder=true）不允许加载" };
  const digest = domain.packageDigest(manifestBytes);
  if (pointer.digest && pointer.digest !== digest) return { ok: false, reason: "pointer-digest-mismatch", detail: "current.json.digest 与 manifest 原始字节不一致" };
  if (!manifest.files[manifest.entry]) return { ok: false, reason: "entry-missing", detail: "manifest.files 不含 entry" };
  for (const [name, hash] of Object.entries(manifest.files)) {
    let data;
    try { data = fs.readFileSync(path.join(dir, name)); }
    catch { return { ok: false, reason: "file-missing", detail: "缺少文件 " + name }; }
    if (sha256Hex(data) !== hash) return { ok: false, reason: "digest-mismatch", detail: "文件摘要不匹配 " + name };
  }
  if (!fs.existsSync(path.join(dir, manifest.entry))) return { ok: false, reason: "entry-missing", detail: "entry 文件未落盘" };
  return { ok: true, version: manifest.version, digest, kind: manifest.kind, entry: manifest.entry, files: manifest.files, dir };
}

function createAppPackageResolver(options = {}) {
  const userDataDir = options.userDataDir ? String(options.userDataDir) : "";
  if (!userDataDir) throw new Error("createAppPackageResolver 需要 userDataDir");
  const appDir = options.appDir ? String(options.appDir) : path.join(__dirname, "..");
  const keysFile = options.keysFile ? String(options.keysFile) : path.join(appDir, "resources", "app-update-keys.json");
  const logger = typeof options.logger === "function" ? options.logger : null;
  const appsRoot = path.join(resolveDxosPaths(userDataDir).root, "apps");
  // 内置应用始终已知；options.isKnownApp 用于额外登记的应用（第三方注册表）。
  const isKnownApp = (value) => {
    if (domain.normalizeAppId(value)) return true;
    if (typeof options.isKnownApp !== "function") return false;
    try { return !!options.isKnownApp(value); } catch { return false; }
  };
  const verifyCache = new Map();
  const publicKeyCache = new Map();
  const keyFor = (appId) => {
    if (!publicKeyCache.has(appId)) publicKeyCache.set(appId, loadAppPublicKey(keysFile, appId));
    return publicKeyCache.get(appId);
  };
  const stateDir = (appId) => path.join(appsRoot, appId);

  /** 目录签名（只 stat、不哈希）：目录 + manifest + sig + 每个已发布文件。 */
  function directorySignature(dir) {
    const parts = [];
    const add = (file) => {
      try { const stat = fs.statSync(file); parts.push(file + ":" + stat.mtimeMs + ":" + stat.size); }
      catch { parts.push(file + ":missing"); }
    };
    add(dir);
    add(path.join(dir, domain.MANIFEST_NAME));
    add(path.join(dir, domain.MANIFEST_SIGNATURE_NAME));
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, domain.MANIFEST_NAME), "utf8"));
      for (const name of Object.keys(raw && raw.files ? raw.files : {})) add(path.join(dir, name));
    } catch { /* manifest 坏了会由 verify 给结构化原因 */ }
    return parts.join("|");
  }

  /** 已安装包的健康快照（不抛异常；任何失败都是可枚举 reason）。 */
  function installedHealth(appId) {
    if (!isKnownApp(appId)) return { ok: false, reason: "app-unknown", detail: "未注册的应用：" + String(appId) };
    const dirState = stateDir(appId);
    const pointer = readAppPointer(dirState);
    if (!pointer.ok) return { ok: false, reason: pointer.reason, detail: pointer.detail };
    const dir = path.join(dirState, pointer.version);
    let stat = null;
    try { stat = fs.statSync(dir); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) return { ok: false, reason: "version-dir-missing", detail: "安装目录不存在：" + pointer.version };
    // 缓存键必须覆盖每个已发布文件的 mtime/size：只盯目录 mtime 会漏掉"文件内容被改但目录没变"。
    const signature = directorySignature(dir);
    const cacheKey = appId + "|" + pointer.version + "|" + (pointer.digest || "") + "|" + signature;
    if (verifyCache.has(cacheKey)) return verifyCache.get(cacheKey);
    const key = keyFor(appId);
    const result = key.ok ? verifyInstalledPackage(appId, dir, pointer, key.key) : { ok: false, reason: key.reason, detail: key.detail };
    verifyCache.set(cacheKey, result);
    return result;
  }

  /**
   * 健康检查：已安装包是否可加载 + 当前生效来源。
   * effectiveSource=installed 表示协议会服务磁盘包；builtin 表示回退到随包内置应用（正常状态）。
   */
  function health(value) {
    const appId = String(value || "").trim();
    if (!isKnownApp(appId)) return { ok: false, error: domain.MARKET_UPDATE_ERR_INVALID_INPUT, appId, loadable: false, reason: "app-unknown" };
    const installed = installedHealth(appId);
    const support = domain.appLoadSupport(appId);
    const builtinVersion = domain.builtinVersionForApp(appId);
    // 第三方注册表登记的应用没有 domain 的 loader 声明，但同样走 openarc-app://。
    const loader = support.loader || (domain.normalizeAppId(appId) ? null : domain.GENERIC_APP_LOADER);
    const loadUrl = loader === "openarc-canvas" ? "openarc-canvas://bundle/" : "openarc-app://" + appId + "/";
    const result = {
      ok: true,
      appId,
      builtinVersion,
      loader,
      loadUrl,
      effectiveSource: installed.ok ? "installed" : "builtin",
      installedLoadable: installed.ok === true,
      installed: installed.ok
        ? { version: installed.version, digest: installed.digest, kind: installed.kind, entry: installed.entry }
        : { version: null, digest: null, kind: null, entry: null, reason: installed.reason || null, detail: installed.detail || null },
      fallbackReason: installed.ok ? null : (installed.reason || null),
    };
    if (logger) {
      try { logger({ event: "app-package-health", appId, effectiveSource: result.effectiveSource, reason: result.fallbackReason }); } catch { /* 日志失败不改结果 */ }
    }
    return result;
  }

  /** 协议回调：request 或 URL 字符串都能吃。未安装 / 校验失败时返回 404，由渲染层回退内置应用。 */
  function handle(request) {
    const rawUrl = typeof request === "string" ? request : (request && typeof request.url === "string" ? request.url : "");
    let url;
    try { url = new URL(rawUrl); } catch { return new Response("bad request", { status: 400 }); }
    if (url.protocol !== "openarc-app:") return new Response("bad request", { status: 400 });
    const appId = String(url.hostname || "").trim();
    const headers = { "access-control-allow-origin": "*" };
    if (!isKnownApp(appId)) { headers["x-openarc-app-fallback"] = "app-unknown"; return new Response("unknown app", { status: 404, headers }); }
    headers["x-openarc-app-app"] = appId;
    const installed = installedHealth(appId);
    if (!installed.ok) {
      headers["x-openarc-app-source"] = "builtin";
      headers["x-openarc-app-fallback"] = installed.reason || "unavailable";
      return new Response("fallback to builtin", { status: 404, headers });
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname).replace(/^[/]+/, ""); }
    catch { return new Response("bad request", { status: 400, headers }); }
    if (!rel) rel = installed.entry;
    if (!rel || rel.includes("..") || rel.includes("\\") || rel.includes("\0") || !Object.prototype.hasOwnProperty.call(installed.files, rel)) {
      return new Response("not found", { status: 404, headers });
    }
    const extension = path.extname(rel).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(APP_MIME, extension)) return new Response("forbidden", { status: 403, headers });
    const base = path.resolve(installed.dir);
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep)) return new Response("forbidden", { status: 403, headers });
    let data;
    try { data = fs.readFileSync(file); } catch { return new Response("not found", { status: 404, headers }); }
    headers["content-type"] = APP_MIME[extension];
    headers["x-openarc-app-source"] = "installed";
    headers["x-openarc-app-version"] = installed.version;
    headers["x-openarc-app-kind"] = installed.kind;
    return new Response(data, { status: 200, headers });
  }

  return {
    appsRoot,
    keysFile,
    entryFor: (appId) => (installedHealth(appId).ok ? installedHealth(appId).entry : null),
    stateDir,
    health,
    installedHealth,
    handle,
  };
}

module.exports = {
  APP_MIME,
  APP_FALLBACK_REASONS,
  loadAppPublicKey,
  readAppPointer,
  verifyInstalledPackage,
  createAppPackageResolver,
};
