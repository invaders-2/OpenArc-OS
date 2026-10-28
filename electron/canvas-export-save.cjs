/**
 * canvas/saveExport：把画布导出的 PNG / JPEG 真正落到下载目录。
 *
 * 为什么需要主进程：Electron 的 file:// 页面里 <a download> 不落盘（弹保存框或静默失败），
 * 渲染层只能"以为"下载成功。导出图片几 MB，走 IPC 传 base64 最省事（不引新依赖、不改协议）。
 *
 * 契约：
 *   入参 { fileName, mime, base64 }
 *   成功 { ok: true, path, fileName, bytes, renamed }
 *   失败 { ok: false, error, detail? }（结构化，不抛异常）
 *
 * 安全与限制：
 *   · 文件名只取 basename，去掉路径分隔符 / 控制字符，限长 120，扩展名白名单 png/jpg；
 *   · mime 白名单 image/png image/jpeg；
 *   · base64 必须严格可解码，空内容拒绝，大小上限默认 200MB；
 *   · 重名自动加 -1 / -2 …（最多到 -999），绝不覆盖已有文件；
 *   · 先写 .part 再 rename，避免半截文件；目录不存在时按需创建。
 */
"use strict";

const fsDefault = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_EXPORT_BYTES = 200 * 1024 * 1024;
const MAX_NAME_LENGTH = 120;
const NAME_LIMIT_ATTEMPTS = 999;
const EXTENSIONS = Object.freeze({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" });
const MIMES = Object.freeze(new Set(["image/png", "image/jpeg"]));

const fail = (error, detail) => ({ ok: false, error, ...(detail === undefined ? {} : { detail }) });

/** 入参 → 安全文件名（含扩展名）；非法一律结构化拒绝 */
function safeExportName(raw) {
  const text = String(raw == null ? "" : raw);
  if (!text.trim()) return fail("INVALID_INPUT", "fileName-empty");
  if (text.length > 400) return fail("INVALID_INPUT", "fileName-too-long");
  // 只取最后一段（Windows / POSIX 分隔符都切），再清掉控制字符与文件系统保留字符
  const base = text.split(/[\\/]/).pop() || "";
  const cleaned = base.replace(/[\u0000-\u001f:"*?<>|]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fail("INVALID_INPUT", "fileName-invalid");
  const ext = (path.extname(cleaned).replace(/^\./, "") || "").toLowerCase();
  if (!EXTENSIONS[ext]) return fail("INVALID_EXTENSION", { allowed: Object.keys(EXTENSIONS) });
  const stem = cleaned.slice(0, Math.max(1, cleaned.length - ext.length - 1)).slice(0, MAX_NAME_LENGTH).trim() || "canvas-export";
  return { ok: true, fileName: stem + "." + ext, ext, mime: EXTENSIONS[ext] };
}

/** base64 → Buffer；严格解码，坏字符 / 空内容拒绝 */
function decodeBase64(raw) {
  if (typeof raw !== "string" || !raw.trim()) return fail("INVALID_INPUT", "base64-empty");
  const text = raw.replace(/^data:[^;]*;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return fail("INVALID_INPUT", "base64-invalid");
  const bytes = Buffer.from(text, "base64");
  if (!bytes.length) return fail("INVALID_INPUT", "base64-empty");
  return { ok: true, bytes };
}

/** 在 dir 里给 fileName 找一个不冲突的名字：name.ext → name-1.ext → name-2.ext … */
function uniqueExportPath(dir, fileName, { exists = fsDefault.existsSync } = {}) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length) || "canvas-export";
  let target = path.join(dir, fileName);
  if (!exists(target)) return { path: target, fileName, renamed: false };
  for (let i = 1; i <= NAME_LIMIT_ATTEMPTS; i += 1) {
    const next = stem + "-" + i + ext;
    target = path.join(dir, next);
    if (!exists(target)) return { path: target, fileName: next, renamed: true };
  }
  return null;
}

/** 默认下载目录：隔离运行用 OPENARC_DOWNLOADS_DIR 覆盖；否则取系统的下载目录（app.getPath） */
function defaultDownloadsDir() {
  const override = String(process.env.OPENARC_DOWNLOADS_DIR || "").trim();
  if (override) return path.resolve(override);
  try {
    // eslint-disable-next-line global-require
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") return app.getPath("downloads");
  } catch { /* 单测里没有 electron 运行时 */ }
  return path.join(os.homedir(), "Downloads");
}

/**
 * @param {{ dir?: string, fsImpl?: typeof fsDefault, maxBytes?: number }} options
 */
function createExportSaver(options = {}) {
  const fsImpl = options.fsImpl || fsDefault;
  const maxBytes = Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_EXPORT_BYTES;
  return async function saveExport({ fileName, mime, base64 } = {}) {
    const dir = options.dir || defaultDownloadsDir();
    if (!dir) return fail("DEPENDENCY_UNAVAILABLE", "no-downloads-dir");
    const named = safeExportName(fileName);
    if (named.ok !== true) return named;
    if (mime != null && String(mime) !== "" && !MIMES.has(String(mime).toLowerCase())) return fail("INVALID_MIME", { allowed: Array.from(MIMES) });
    const decoded = decodeBase64(base64);
    if (decoded.ok !== true) return decoded;
    if (decoded.bytes.length > maxBytes) return fail("LIMIT_EXCEEDED", { maxBytes, bytes: decoded.bytes.length });
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return fail("SAVE_FAILED", "mkdir: " + String((error && error.message) || error).slice(0, 160));
    }
    const target = uniqueExportPath(dir, named.fileName, { exists: (p) => fsImpl.existsSync(p) });
    if (!target) return fail("SAVE_FAILED", "too-many-duplicates");
    const temp = target.path + ".part";
    try {
      fsImpl.writeFileSync(temp, decoded.bytes);
      fsImpl.renameSync(temp, target.path);
    } catch (error) {
      try { fsImpl.rmSync(temp, { force: true }); } catch { /* 清理失败不改变结果 */ }
      return fail("SAVE_FAILED", String((error && error.message) || error).slice(0, 200));
    }
    return { ok: true, path: target.path, fileName: target.fileName, bytes: decoded.bytes.length, renamed: target.renamed, mime: named.mime };
  };
}

module.exports = {
  createExportSaver,
  safeExportName,
  decodeBase64,
  uniqueExportPath,
  defaultDownloadsDir,
  MAX_EXPORT_BYTES,
  MAX_NAME_LENGTH,
  EXTENSIONS,
  MIMES,
};
