/**
 * B5e · 公共媒体（只做**本地部分**；上传 / 外部图床已删除并在下方逐条注明）。
 *
 * 源 server/publicMedia.ts:1-84：
 *   · :1-13    sharp 依赖 / PublicMedia* 类型 / Litterbox 常量（外部图床）
 *   · :15-37   normalizePublicImageForApimartVideo（本地像素转换，保留）
 *   · :39-65   expectedMediaGroup / verifyDirectMediaUrl（远程直链校验，OUT）
 *   · :67-84   uploadCanvasFreeMedia（litterbox 上传，OUT）
 *
 * 本文件保留：
 *   · 源 :21-37 normalizePublicImageForApimartVideo —— 本地把参考图转成 APIMART 能吃的 JPEG，
 *     sharp 惰性加载；缺失即结构化 MEDIA_DEPENDENCY_UNAVAILABLE，绝不返回假图。
 *   · 本地公共媒体目录 / URL 映射（本仓补充）：<dataDir>/public-media 下的文件名 ⇄
 *     /api/public-media/<id> 相对 URL；绝对路径不出主进程。
 *   · uploadPublicMedia / uploadPublicMediaBytes（本仓补充）：本地文件或渲染层字节 → **只调用宿主注入的
 *     uploader**；本模块不内置任何外部图床地址 / 域名。
 *
 * OUT（云 / 商业化 / 外部图床）逐条注明，已删除不导出：
 *   · :12-13  LITTERBOX_UPLOAD_URL / LITTERBOX_DOWNLOAD_HOST
 *   · :39-41  expectedMediaGroup
 *   · :43-65  verifyDirectMediaUrl（远程直链验证）
 *   · :67-84  uploadCanvasFreeMedia（临时上传到 litterbox）
 * 断言锚点：PUBLIC_MEDIA_UPLOAD_REMOVED = true（测试用）。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createMediaError, MEDIA_ERR_INVALID_INPUT, MEDIA_ERR_NOT_FOUND, MEDIA_ERR_DEPENDENCY_UNAVAILABLE } = require("./media-domain.cjs");

/** 外部上传面已整段移除（源 :67-84）：本模块不内置外部图床，上传只经注入 uploader。 */
const PUBLIC_MEDIA_UPLOAD_REMOVED = true;

/** 扩展名 → 素材 MIME（只覆盖媒体域接受的类型；未知扩展名回 null 交给 uploader 拒绝）。 */
const MEDIA_MIME_BY_EXT = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
});

let extensions = Object.freeze({});

/** 依赖注入：{ dataDir, sharpLoader, clock }。 */
function configurePublicMedia(options) {
  if (options && typeof options === "object") extensions = Object.freeze(Object.assign({}, extensions, options));
  return Object.assign({}, extensions);
}

function effective(options) { return Object.assign({}, extensions, options || {}); }

function publicMediaDir(options) {
  const opts = effective(options);
  if (!opts.dataDir) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "公共媒体目录未装配（缺少 dataDir）", "缺少 dataDir：注入后重试。");
  return path.join(opts.dataDir, "public-media");
}

function resolveSharp(options) {
  const opts = effective(options);
  if (typeof opts.sharpLoader === "function") {
    let loaded;
    try { loaded = opts.sharpLoader(); }
    catch { throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "sharp 未安装，无法转换公共媒体参考图", "缺少 sharp：安装 sharp 后重试。"); }
    if (loaded) return loaded;
  }
  try {
    return require("sharp");
  } catch {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "sharp 未安装，无法转换公共媒体参考图", "缺少 sharp：安装 sharp 后重试。");
  }
}

/** 源 :21-37 normalizePublicImageForApimartVideo（本地转换；非图片原样返回）。 */
async function normalizePublicImageForApimartVideo(input, options) {
  if (!String(input.mime || "").toLowerCase().startsWith("image/")) return input;
  const sharp = resolveSharp(options);
  try {
    const buf = await sharp(input.buf, { animated: false, failOn: "error", limitInputPixels: 268402689 })
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColorspace("srgb")
      .jpeg({ quality: 90, progressive: false, chromaSubsampling: "4:2:0" })
      .toBuffer();
    const stem = String(input.name || "reference").replace(/\.[^.]+$/, "") || "reference";
    return { buf, mime: "image/jpeg", name: stem + ".jpg" };
  } catch (error) {
    throw createMediaError(MEDIA_ERR_INVALID_INPUT, "APIMART 视频参考图「" + (input.name || "image") + "」转换为 JPEG 失败：" + String(error && error.message || error));
  }
}

/** 本地文件名清洗：只允许单层文件名，拒绝路径穿越。 */
function publicMediaFileName(name) {
  const raw = String(name || "").trim();
  if (!raw || raw === "." || raw === ".." || /[\/\\\0\r\n]/.test(raw)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "公共媒体文件名无效");
  return raw;
}

/** 本地列表：{ id, fileName, bytes, mtime, url }；不含绝对路径。 */
function listPublicMedia(options) {
  const dir = publicMediaDir(options);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { return []; }
    if (!stat.isFile()) return [];
    return [{ id: name, fileName: name, bytes: stat.size, mtime: stat.mtimeMs, url: publicMediaUrl(name) }];
  }).sort((a, b) => b.mtime - a.mtime);
}

/** 文件名 → 相对 URL（源没有该映射，本仓本地部分补充）。 */
function publicMediaUrl(fileName) {
  return "/api/public-media/" + encodeURIComponent(publicMediaFileName(fileName));
}

/** 文件名 → 绝对路径；越界即 FORBIDDEN/INVALID。 */
function resolvePublicMediaPath(fileName, options) {
  const dir = publicMediaDir(options);
  const resolved = path.resolve(dir, publicMediaFileName(fileName));
  if (resolved !== path.join(path.resolve(dir), path.basename(resolved))) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "公共媒体路径越界");
  if (!fs.existsSync(resolved)) throw createMediaError(MEDIA_ERR_NOT_FOUND, "公共媒体文件不存在");
  return resolved;
}

/**
 * task-25 B16：远端抓取 / 上传只经**显式注入**，默认无网络。
 *   · fetchImpl 必须由宿主注入；allowedHosts 必须是显式 https 白名单（不做"任意公网"）。
 *   · 响应 ≤ 20MB，落本地 public-media 目录，文件名由 sha256 生成，绝不回绝对路径。
 *   · uploader 必须由宿主注入；本模块不内置 Litterbox / 任何图床地址。
 */
async function fetchPublicMedia({ url, fetchImpl = null, allowedHosts = [], maxBytes = 20 * 1024 * 1024 } = {}, options) {
  const opts = effective(options);
  const fetcher = fetchImpl || opts.fetchImpl;
  if (typeof fetcher !== "function") throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "远端抓取未注入 fetchImpl", "缺少 fetchImpl：由宿主显式注入后重试（默认不联网）。");
  let parsed;
  try { parsed = new URL(String(url || "")); } catch { throw createMediaError(MEDIA_ERR_INVALID_INPUT, "公共媒体 URL 无效"); }
  if (parsed.protocol !== "https:") throw createMediaError(MEDIA_ERR_INVALID_INPUT, "公共媒体只允许 https");
  const hosts = (Array.isArray(allowedHosts) && allowedHosts.length ? allowedHosts : opts.allowedHosts || []).map((host) => String(host).toLowerCase());
  if (!hosts.length) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "远端抓取未配置 allowedHosts", "空白名单即拒绝，绝不默认放开公网。");
  if (!hosts.includes(parsed.hostname.toLowerCase())) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "公共媒体主机不在白名单");
  const response = await fetcher(parsed.toString(), { method: "GET", redirect: "error" });
  if (!response || !response.ok) throw createMediaError(MEDIA_ERR_NOT_FOUND, "远端公共媒体抓取失败");
  const length = Number(response.headers && typeof response.headers.get === "function" ? response.headers.get("content-length") : 0);
  if (Number.isFinite(length) && length > maxBytes) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "公共媒体超过大小上限");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "公共媒体为空或超过大小上限");
  const mime = String(response.headers && typeof response.headers.get === "function" ? response.headers.get("content-type") : "application/octet-stream").split(";")[0].trim() || "application/octet-stream";
  if (!/^(image|video|audio)\//.test(mime)) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "公共媒体只接受图片/音频/视频");
  const ext = mime === "image/png" ? ".png" : mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : mime.startsWith("video/") ? ".mp4" : mime.startsWith("audio/") ? ".m4a" : ".bin";
  const name = require("node:crypto").createHash("sha256").update(bytes).digest("hex") + ext;
  const dir = publicMediaDir(opts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes);
  return { id: name, fileName: name, bytes: bytes.length, mime, url: publicMediaUrl(name), fetchedFrom: parsed.hostname };
}

function publicMediaMime(fileName) {
  return MEDIA_MIME_BY_EXT[path.extname(String(fileName || "")).toLowerCase()] || null;
}

function resolveUploader(uploader, options) {
  const impl = uploader || options.uploader;
  if (typeof impl !== "function") throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "公共媒体上传未注入 uploader", "缺少 uploader：由宿主显式注入后重试（本模块不内置外部图床）。");
  return impl;
}

/** 从字节上传：校验文件名 / 字节后只调用注入的 uploader；返回 uploader 的 url 与可选 service / expiresAt。 */
async function uploadPublicMediaBytes({ fileName, bytes, mime = null, uploader = null } = {}, options) {
  const opts = effective(options);
  const impl = resolveUploader(uploader, opts);
  const name = publicMediaFileName(fileName);
  if (!bytes || (typeof bytes.byteLength !== "number" && typeof bytes.length !== "number")) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "公共媒体上传需要素材字节");
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buffer.length) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "公共媒体上传素材为空");
  const type = String(mime == null ? "" : mime).trim() || publicMediaMime(name) || "application/octet-stream";
  const result = await impl({ fileName: name, bytes: buffer, mime: type });
  if (!result || !result.url) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "上传器未返回 URL");
  const media = { fileName: name, url: String(result.url), bytes: buffer.length, mime: type };
  if (result.service != null) media.service = String(result.service);
  if (result.expiresAt != null) media.expiresAt = result.expiresAt;
  return media;
}

/** 本地文件上传：读 public-media 后交给 uploadPublicMediaBytes（MIME 按扩展名推断）。 */
async function uploadPublicMedia({ fileName, uploader = null } = {}, options) {
  const opts = effective(options);
  const impl = resolveUploader(uploader, opts);
  const name = publicMediaFileName(fileName);
  const bytes = fs.readFileSync(resolvePublicMediaPath(name, opts));
  return uploadPublicMediaBytes({ fileName: name, bytes, mime: publicMediaMime(name), uploader: impl }, opts);
}

module.exports = {
  PUBLIC_MEDIA_UPLOAD_REMOVED,
  fetchPublicMedia,
  uploadPublicMedia,
  uploadPublicMediaBytes,
  publicMediaMime,
  configurePublicMedia,
  publicMediaDir,
  normalizePublicImageForApimartVideo,
  publicMediaFileName,
  listPublicMedia,
  publicMediaUrl,
  resolvePublicMediaPath,
  // 源 :12-13 / :39-41 / :43-65 / :67-84（Litterbox 常量、直链校验、上传）为 OUT，已删除。
};
