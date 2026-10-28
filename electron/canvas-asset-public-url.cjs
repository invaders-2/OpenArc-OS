"use strict";
/**
 * canvas/assetPublicUrl：把画布素材换成模型能直接下载的 https 链接。
 *
 * 发给模型的图片 / 视频 / 音频不再走 base64（体积大，模型接口接不住），而是先上传到临时存储拿链接。
 * 上传器由 main.cjs 注入（当前 = media-litterbox.cjs 的 Litterbox 上传器，retention 24h，
 * 自带 https + 域名白名单 + Range 复验）；本文件只管：读素材（走 canvas-service 的权限）→ 去重缓存 → 调上传器。
 *
 *   输入：{ context, canvasId, ref?: "openarc-asset:<id>" | "<id>", dataUrl?: "data:…" }
 *   输出：{ ok: true, url, expiresAt, provider, cached } | { ok: false, error, detail }
 *
 * 同一份内容（sha256）在链接剩余有效期 > 1 小时时直接复用，不重复上传；并发同内容只传一次。
 */
const crypto = require("node:crypto");
const { downloadProtocolArtifact } = require("./protocol-engine/artifactDownload.cjs");

const REUSE_MARGIN_MS = 60 * 60 * 1000;
const CACHE_LIMIT = 500;
const MAX_ASSET_BYTES = 200 * 1024 * 1024;

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg" };

/** data URL → { bytes, mime } */
function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(String(dataUrl || ""));
  if (!m) return null;
  const mime = (m[1] || "application/octet-stream").toLowerCase();
  const bytes = m[3] ? Buffer.from(m[4], "base64") : Buffer.from(decodeURIComponent(m[4]), "utf8");
  return { bytes, mime };
}

function errorOf(error) {
  const code = (error && (error.code || error.error)) || "UPLOAD_FAILED";
  const detail = String((error && (error.message || error.detail)) || error || "").slice(0, 300);
  return { ok: false, error: String(code), detail };
}

/**
 * @param {{ readAsset: Function }} service  canvas-service（复用 readAsset 的权限判定）
 * @param {{ authorize?: Function, uploader: (context: unknown, input: {fileName: string, bytes: Uint8Array, mime: string}) => Promise<{url: string, expiresAt: number, service?: string}>, now?: () => number }} options
 */
function createAssetPublicUrl(service, options = {}) {
  const uploader = options.uploader;
  const authorize = options.authorize;
  const now = options.now || Date.now;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.min(options.maxBytes, MAX_ASSET_BYTES) : MAX_ASSET_BYTES;
  const maxDataUrlChars = Math.ceil(maxBytes * 4 / 3) + 1024;
  /** sha256 → { url, expiresAt, provider } */
  const cache = new Map();
  const inflight = new Map();

  return async function assetPublicUrl({ context, canvasId, ref, dataUrl } = {}) {
    if (typeof uploader !== "function") return { ok: false, error: "DEPENDENCY_UNAVAILABLE", detail: "uploader not injected" };
    if (typeof authorize === "function") { try { await authorize(context); } catch (error) { return errorOf(error); } }
    let decoded = null;
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
      if (dataUrl.length > maxDataUrlChars) return { ok: false, error: "LIMIT_EXCEEDED" };
      decoded = decodeDataUrl(dataUrl);
    } else if (ref) {
      const read = service && typeof service.readAsset === "function" ? service.readAsset({ context, ref: String(ref), maxBytes: maxBytes }) : null;
      if (!read || read.ok !== true || !read.dataUrl) return { ok: false, error: (read && read.error) || "ASSET_UNAVAILABLE" };
      if (read.dataUrl.length > maxDataUrlChars) return { ok: false, error: "LIMIT_EXCEEDED" };
      decoded = decodeDataUrl(read.dataUrl);
    }
    if (!decoded || !decoded.bytes.length) return { ok: false, error: "INVALID_INPUT", detail: "need ref or dataUrl" };
    if (decoded.bytes.byteLength > maxBytes) return { ok: false, error: "LIMIT_EXCEEDED" };

    const key = crypto.createHash("sha256").update(decoded.bytes).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.expiresAt - now() > REUSE_MARGIN_MS) return { ok: true, url: hit.url, expiresAt: hit.expiresAt, provider: hit.provider, cached: true };
    if (inflight.has(key)) return inflight.get(key);

    const job = (async () => {
      try {
        const up = await uploader(context, { fileName: "openarc-" + key.slice(0, 12) + "." + (EXT[decoded.mime] || "bin"), bytes: decoded.bytes, mime: decoded.mime });
        if (!up || typeof up.url !== "string") return { ok: false, error: "UPLOAD_FAILED", detail: "no url" };
        const entry = { url: up.url, expiresAt: Number(up.expiresAt) || now() + 24 * 3600 * 1000, provider: up.service || "upload" };
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
        cache.set(key, entry);
        return { ok: true, url: entry.url, expiresAt: entry.expiresAt, provider: entry.provider, cached: false, canvasId: canvasId || null };
      } catch (error) {
        return errorOf(error);
      }
    })();
    inflight.set(key, job);
    try { return await job; } finally { inflight.delete(key); }
  };
}

/**
 * canvas/importRemote：把模型返回的远程结果（https 图片 / 视频 / 音频）下载进资源库。
 * 画布页 CSP 不允许直接显示外链，而且服务商的结果链接会过期；统一由主进程下载后存成 openarc-asset 引用。
 *   输入：{ context, canvasId, url, name? }  输出：{ ok, ref } | { ok: false, error, detail }
 */
const REMOTE_MAX = 200 * 1024 * 1024;
function createImportRemote(service, { downloadImpl = downloadProtocolArtifact, timeoutMs = 180000, maxBytes = REMOTE_MAX, lookup = undefined, connect = undefined, signal = undefined } = {}) {
  return async function importRemote({ context, canvasId, url, name, signal: callSignal } = {}) {
    let parsed; try { parsed = new URL(String(url || "")); } catch { return { ok: false, error: "INVALID_INPUT" }; }
    try {
      const result = await downloadImpl(parsed.toString(), { maxBytes, timeoutMs, lookup, connect, signal: callSignal || signal });
      const buf = result.data;
      if (!buf || !buf.length || buf.length > maxBytes) return { ok: false, error: "LIMIT_EXCEEDED" };
      let mime = String(result.mime || "").split(";")[0].trim().toLowerCase();
      if (mime && mime !== "application/octet-stream" && !/^(image|video|audio)\//.test(mime)) return { ok: false, error: "INVALID_INPUT", detail: "not media" };
      if (!mime || mime === "application/octet-stream") {
        const ext = (parsed.pathname.split(".").pop() || "").toLowerCase();
        mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4" }[ext] || "";
        if (!mime) return { ok: false, error: "INVALID_INPUT", detail: "not media" };
      }
      const out = await service.importAsset({ context, canvasId, name: String(name || "生成结果").slice(0, 80), dataUrl: "data:" + mime + ";base64," + buf.toString("base64") });
      if (!out || out.ok !== true || !out.ref) return out && out.ok === false ? out : { ok: false, error: "IMPORT_FAILED" };
      return { ok: true, ref: out.ref, mime, bytes: buf.length };
    } catch (error) {
      const message = String(error && error.message || error);
      const code = error && error.name === "AbortError" ? "CANCELLED" : /超时/.test(message) ? "TIMEOUT" : /超过大小限制/.test(message) ? "LIMIT_EXCEEDED" : /私网|本机|URL 无效|只允许无凭据/.test(message) ? "INVALID_INPUT" : "DOWNLOAD_FAILED";
      return { ok: false, error: code, detail: message.slice(0, 200) };
    }
  };
}

module.exports = { createAssetPublicUrl, createImportRemote, decodeDataUrl };
