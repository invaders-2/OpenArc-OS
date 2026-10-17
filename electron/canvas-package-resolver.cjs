/**
 * Stage 2 · 无限画布 bundle 解析与只读协议。
 *
 * 生效顺序（严格）：
 *   ① <userData>/dxos/apps/canvas/current.json 指向的已安装版本目录
 *        —— 必须整包校验通过：current.json 合法 → 目录存在 → manifest.sig Ed25519 验签
 *           → manifest 合法且 kind:"static-web" 且非占位包 → current.json.digest 与 manifest 原始字节一致
 *           → 逐个文件 sha256 → entry 落盘；
 *        指针被显式写成内置标记（{ mode:"builtin", version:null }，market/update/rollback 的
 *        「回退到内置版本」）时，直接按 fallbackReason "pointer-cleared" 回 ② / ③ —— 不当作损坏；
 *   ② dist/novai-canvas（构建产物）；
 *   ③ public/novai-canvas（随仓库内置，保底/离线）。
 *
 * 回退一律结构化：任何一步失败都返回可枚举的 reason（见 CANVAS_BUNDLE_FALLBACK_REASONS），
 * 由 main.cjs 打结构化日志，并写进响应头；绝不静默 500 或白屏。全部不可用才回 503 + 说明页。
 *
 * 安全语义与 Stage 1 的 handleCanvasProtocol 保持一致：只读、MIME 白名单、拒绝目录穿越、
 * 不带任何凭据；已安装目录与内置 bundle 同等对待（只读、无用户数据）。
 * 验证结果按 (version, digest) 缓存（整包哈希 15MB 级别，逐请求重算不可接受）；
 * current.json 每次请求都重新读取，因此指针被改坏/回滚能立即反映到下一次请求。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const domain = require("./market-update-domain.cjs");
const { resolveDxosPaths } = require("./dxos-foundation-paths.cjs");

/** 与 Stage 1 完全一致的 MIME 白名单（扩展名不入表即 403）。 */
const CANVAS_MIME = Object.freeze({
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
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
});

/** 已安装版本不可用时的结构化回退原因（穷举；测试逐条覆盖）。 */
const CANVAS_BUNDLE_FALLBACK_REASONS = Object.freeze([
  "pointer-missing",
  /** 用户显式回退到内置版本（market/update/rollback 写入的内置标记），不是故障。 */
  "pointer-cleared",
  "pointer-invalid",
  "pointer-digest-mismatch",
  "version-dir-missing",
  "manifest-missing",
  "signature-missing",
  "signature-invalid",
  "manifest-invalid",
  "not-static-web",
  "placeholder",
  "entry-missing",
  "file-missing",
  "digest-mismatch",
  "public-key-unavailable",
]);

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** 读取内置 Ed25519 公钥（resources/app-update-keys.json 的 canvas 字段）。不抛异常。 */
function loadCanvasPublicKey(keysFile) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(keysFile, "utf8")); }
  catch { return { ok: false, reason: "public-key-unavailable", detail: "内置更新公钥不可用（app-update-keys.json 缺失或不可读）" }; }
  const value = raw && typeof raw.canvas === "string" ? raw.canvas.trim() : "";
  if (!value) return { ok: false, reason: "public-key-unavailable", detail: "app-update-keys.json 缺少 canvas 公钥" };
  const key = domain.toPublicKey(value);
  if (!key) return { ok: false, reason: "public-key-unavailable", detail: "canvas 公钥不是合法 Ed25519 公钥" };
  return { ok: true, key };
}

/** 只读 current.json；缺失 / 损坏 / 版本非法一律给结构化原因。 */
function readCanvasPointer(stateDir) {
  const file = path.join(stateDir, "current.json");
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return { ok: false, reason: "pointer-missing", detail: "current.json 不存在" }; }
  let raw;
  try { raw = JSON.parse(text); }
  catch { return { ok: false, reason: "pointer-invalid", detail: "current.json 不是合法 JSON" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "pointer-invalid", detail: "current.json 不是对象" };
  // 显式回退到内置版本的标记：market/update/rollback 写入，属于正常状态而非损坏。
  if (raw.mode === "builtin" && (raw.version == null || raw.version === null)) {
    return { ok: false, reason: "pointer-cleared", detail: "已回退到随包内置版本（current.json.mode=builtin）" };
  }
  const parsed = typeof raw.version === "string" ? domain.parseSemver(raw.version) : null;
  if (!parsed) return { ok: false, reason: "pointer-invalid", detail: "current.json.version 不是合法语义化版本" };
  return { ok: true, version: parsed.version, digest: typeof raw.digest === "string" ? raw.digest : null };
}

/** 整包校验已安装版本目录；任一环失败都回结构化 reason。 */
function verifyInstalledCanvas(dir, pointer, publicKey) {
  let manifestBytes;
  try { manifestBytes = fs.readFileSync(path.join(dir, domain.MANIFEST_NAME)); }
  catch { return { ok: false, reason: "manifest-missing", detail: "版本目录缺少 manifest.json" }; }
  let signatureText;
  try { signatureText = fs.readFileSync(path.join(dir, domain.MANIFEST_SIGNATURE_NAME), "utf8").trim(); }
  catch { return { ok: false, reason: "signature-missing", detail: "版本目录缺少 manifest.sig" }; }
  const signature = domain.verifyManifestSignature({ manifestBytes, signatureBase64: signatureText, publicKeyObject: publicKey });
  if (!signature.ok) return { ok: false, reason: "signature-invalid", detail: "manifest.sig 验签失败" };

  let raw;
  try { raw = JSON.parse(manifestBytes.toString("utf8")); }
  catch { return { ok: false, reason: "manifest-invalid", detail: "manifest.json 不是合法 JSON" }; }
  const normalized = domain.normalizeManifest(raw);
  if (!normalized.ok) return { ok: false, reason: "manifest-invalid", detail: normalized.error.message };
  const manifest = normalized.value;
  if (manifest.kind !== domain.MANIFEST_KIND_STATIC_WEB) return { ok: false, reason: "not-static-web", detail: "已安装包不是 static-web 形态" };
  if (manifest.placeholder) return { ok: false, reason: "placeholder", detail: "已安装包是占位包（placeholder=true）" };

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
  return { ok: true, version: manifest.version, digest, entry: manifest.entry, kind: manifest.kind, dir, files: manifest.files };
}

/** 全部不可用时的说明页：避免 iframe 白屏，且不泄露绝对路径。 */
function canvasErrorDocument(resolved) {
  const reason = String(resolved.reason || "unavailable");
  const fallback = String(resolved.fallbackReason || "none");
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<title>无限画布不可用</title></head><body style=\"font-family:system-ui;background:#111;color:#eee;padding:32px\">" +
    "<h1 style=\"margin:0 0 12px\">无限画布暂时不可用</h1>" +
    "<p>没有可用的内置画布 bundle，已安装版本也不可用。请重新安装应用或稍后重试。</p>" +
    "<pre>reason=" + reason + " fallbackReason=" + fallback + "</pre></body></html>";
}

/**
 * @param {{userDataDir:string, distRoot?:string, publicRoot?:string, keysFile?:string,
 *          builtinVersion?:string, entry?:string, logger?:(record:object)=>void}} options
 */
function createCanvasBundleResolver(options = {}) {
  const userDataDir = options.userDataDir ? String(options.userDataDir) : "";
  if (!userDataDir) throw new Error("createCanvasBundleResolver 需要 userDataDir");
  const distRoot = options.distRoot ? String(options.distRoot) : path.join(__dirname, "../dist/novai-canvas");
  const publicRoot = options.publicRoot ? String(options.publicRoot) : path.join(__dirname, "../public/novai-canvas");
  const keysFile = options.keysFile ? String(options.keysFile) : path.join(__dirname, "../resources/app-update-keys.json");
  const logger = typeof options.logger === "function" ? options.logger : null;
  const builtinVersion = typeof options.builtinVersion === "string" && options.builtinVersion ? options.builtinVersion : domain.DEFAULT_BUILTIN_VERSION;
  const entry = typeof options.entry === "string" && options.entry ? options.entry : domain.CANVAS_STATIC_ENTRY;
  const stateDir = path.join(resolveDxosPaths(userDataDir).root, "apps", domain.CANVAS_APP_ID);
  const verifyCache = new Map();
  let publicKeyState = null;
  let lastLogSignature = null;

  function publicKey() {
    if (!publicKeyState) publicKeyState = loadCanvasPublicKey(keysFile);
    return publicKeyState;
  }

  function resolveInstalled() {
    const pointer = readCanvasPointer(stateDir);
    if (!pointer.ok) return { ok: false, reason: pointer.reason, detail: pointer.detail };
    const dir = path.join(stateDir, pointer.version);
    let stat = null;
    try { stat = fs.statSync(dir); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) return { ok: false, reason: "version-dir-missing", detail: "安装目录不存在：" + pointer.version };

    // 目录 mtime 参与缓存键：同版本重装（rename 新目录）后旧结论作废。
    const cacheKey = pointer.version + "|" + (typeof pointer.digest === "string" ? pointer.digest : "") + "|" + stat.mtimeMs;
    const cached = verifyCache.get(cacheKey);
    if (cached) return cached;
    const key = publicKey();
    const result = key.ok
      ? verifyInstalledCanvas(dir, pointer, key.key)
      : { ok: false, reason: key.reason, detail: key.detail };
    verifyCache.set(cacheKey, result);
    return result;
  }

  /** 当前生效来源；installed 优先，其次 dist，最后 public。 */
  function resolve() {
    const installed = resolveInstalled();
    if (installed.ok) {
      return { ok: true, source: "installed", root: installed.dir, version: installed.version, entry: installed.entry, digest: installed.digest, files: installed.files || null, fallbackReason: null, reason: null, detail: null };
    }
    for (const [source, root] of [["dist", distRoot], ["public", publicRoot]]) {
      let stat = null;
      try { stat = fs.statSync(root); } catch { stat = null; }
      if (!stat || !stat.isDirectory()) continue;
      if (!fs.existsSync(path.join(root, entry))) continue;
      return { ok: true, source, root, version: null, entry, digest: null, files: null, fallbackReason: installed.reason, reason: null, detail: installed.detail };
    }
    return { ok: false, source: null, root: null, version: null, entry, digest: null, files: null, fallbackReason: installed.reason, reason: "builtin-missing", detail: installed.detail };
  }

  function logOnce(resolved) {
    if (!logger) return;
    const signature = [resolved.source, resolved.root, resolved.version, resolved.fallbackReason, resolved.reason].join("|");
    if (signature === lastLogSignature) return;
    lastLogSignature = signature;
    try {
      logger({
        event: "canvas-bundle",
        source: resolved.source,
        root: resolved.root,
        version: resolved.version,
        entry: resolved.entry,
        fallbackReason: resolved.fallbackReason,
        reason: resolved.reason,
        builtinVersion: resolved.source && resolved.source !== "installed" ? builtinVersion : null,
        detail: resolved.detail || null,
      });
    } catch { /* 日志失败不改协议结果 */ }
  }

  /** Electron protocol.handle 的回调：request 或 URL 字符串都能吃。 */
  function handle(request) {
    const rawUrl = typeof request === "string" ? request : (request && typeof request.url === "string" ? request.url : "");
    let url;
    try { url = new URL(rawUrl); } catch { return new Response("bad request", { status: 400 }); }
    let rel;
    try { rel = decodeURIComponent(url.pathname).replace(/^[/]+/, ""); }
    catch { return new Response("bad request", { status: 400 }); }
    // 目录穿越 / 绝对路径 / 反斜杠 / NUL 一律拒绝（与 Stage 1 同口径）。
    if (!rel || rel.includes("..") || rel.includes("\\") || rel.includes("\0")) return new Response("forbidden", { status: 403 });
    const ext = path.extname(rel).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(CANVAS_MIME, ext)) return new Response("forbidden", { status: 403 });

    const resolved = resolve();
    logOnce(resolved);
    const headers = { "access-control-allow-origin": "*" };
    if (resolved.source) headers["x-openarc-canvas-source"] = resolved.source;
    if (resolved.version) headers["x-openarc-canvas-version"] = resolved.version;
    if (resolved.fallbackReason) headers["x-openarc-canvas-fallback"] = resolved.fallbackReason;
    if (!resolved.ok) {
      headers["content-type"] = "text/html; charset=utf-8";
      return new Response(canvasErrorDocument(resolved), { status: 503, headers });
    }
    // 已安装版本只服务 manifest.files 里列过（且已逐个验过 sha256）的文件；内置 bundle 保持原语义。
    if (resolved.source === "installed" && (!resolved.files || !Object.prototype.hasOwnProperty.call(resolved.files, rel))) {
      return new Response("not found", { status: 404, headers });
    }
    const base = path.resolve(resolved.root);
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep)) return new Response("forbidden", { status: 403 });
    if (!fs.existsSync(file)) return new Response("not found", { status: 404, headers: { "access-control-allow-origin": "*" } });
    headers["content-type"] = CANVAS_MIME[ext];
    return new Response(fs.readFileSync(file), { status: 200, headers });
  }

  return { stateDir, keysFile, distRoot, publicRoot, entry, handle, resolve };
}

module.exports = {
  CANVAS_MIME,
  CANVAS_BUNDLE_FALLBACK_REASONS,
  loadCanvasPublicKey,
  readCanvasPointer,
  verifyInstalledCanvas,
  createCanvasBundleResolver,
};
