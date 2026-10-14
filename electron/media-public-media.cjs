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

/** 外部上传面已整段移除（源 :67-84）。 */
const PUBLIC_MEDIA_UPLOAD_REMOVED = true;

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

module.exports = {
  PUBLIC_MEDIA_UPLOAD_REMOVED,
  configurePublicMedia,
  publicMediaDir,
  normalizePublicImageForApimartVideo,
  publicMediaFileName,
  listPublicMedia,
  publicMediaUrl,
  resolvePublicMediaPath,
  // 源 :12-13 / :39-41 / :43-65 / :67-84（Litterbox 常量、直链校验、上传）为 OUT，已删除。
};
