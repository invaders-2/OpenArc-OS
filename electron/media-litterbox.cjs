/**
 * 免费临时图床（Litterbox）上传器：主进程唯一出口，渲染层只经 media:command 调用。
 *
 * 为什么单独成文件：media-public-media.cjs 保持"不内置任何外部图床"的边界（PUBLIC_MEDIA_UPLOAD_REMOVED），
 * 图床协议、域名白名单与直链校验只在本文件；上传器由 main.cjs 显式注入，
 * media-service 只把注入的 uploader 往下传，不在命令分支里写死域名。
 *
 * 协议：multipart POST（reqtype=fileupload / time=72h / fileToUpload）→ 纯文本直链。
 * 返回直链必须过两道校验：
 *   · https + hostname === litter.catbox.moe（防图床返回错域名 / 降级 http）；
 *   · Range GET bytes=0-1023 复验 200/206，且 Content-Type 的类型组与素材声明一致。
 * 失败一律走 media-domain 的 createMediaError，保证 media 域信封结构化（code + detail）。
 */
"use strict";

const {
  createMediaError,
  isMediaError,
  MEDIA_ERR_INVALID_INPUT,
  MEDIA_ERR_DEPENDENCY_UNAVAILABLE,
  MEDIA_ERR_TIMEOUT,
} = require("./media-domain.cjs");

const UPLOAD_URL = "https://litterbox.catbox.moe/resources/internals/api.php";
const DOWNLOAD_HOST = "litter.catbox.moe";
const RETENTION = "72h";
const RETENTION_MS = 72 * 60 * 60 * 1000;
const RETENTIONS = Object.freeze({ "1h": 3600000, "12h": 43200000, "24h": 86400000, "72h": RETENTION_MS });
const DEFAULT_TIMEOUT_MS = 240000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const PROBE_RANGE = "bytes=0-1023";
const OCTET_STREAM = "application/octet-stream";
const MEDIA_GROUP_PATTERN = /^(image|video|audio)\//;
const MEDIA_GROUP_LABELS = Object.freeze({ image: "图片", video: "视频", audio: "音频" });

function normalizeMime(mime) {
  return String(mime == null ? "" : mime).split(";")[0].trim().toLowerCase();
}

/** 素材类型组：image / video / audio；其余（含空）为 null。 */
function mediaGroup(mime) {
  const type = normalizeMime(mime);
  return MEDIA_GROUP_PATTERN.test(type) ? type.slice(0, type.indexOf("/")) : null;
}

/** 按 MB 展示上限（用户文案）；精确字节数仍留在 detail。 */
function formatMegabytes(bytes) {
  const mb = Number(bytes) / (1024 * 1024);
  if (mb >= 10) return String(Math.round(mb));
  if (mb >= 1) return String(Math.round(mb * 10) / 10);
  return String(Math.round(mb * 1000) / 1000);
}

function uploadFileName(value) {
  const name = String(value == null ? "" : value).replace(/[\r\n\0]/g, "").trim();
  return name && name !== "." && name !== ".." ? name : "upload";
}

function timeoutError(what) {
  return createMediaError(MEDIA_ERR_TIMEOUT, what + "超时", { timeout: true });
}

function isAbortError(error) {
  return !!error && (error.name === "AbortError" || error.name === "TimeoutError" || error.code === "ABORT_ERR");
}

function dependencyError(what, error) {
  const detail = String(error && (error.message || error.code) || error).slice(0, 300);
  return createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, what + "失败：" + detail, { dependency: "fetchImpl" });
}

/** 单次请求的硬 deadline：超时既 abort（让真实 fetch 停下）也 race 兜底（注入实现可能忽略 signal）。 */
async function runWithTimeout(run, timeoutMs, what) {
  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError(what));
    }, Math.max(1, Math.round(timeoutMs)));
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function buildUploadForm(fileName, bytes, mime, retention = RETENTION) {
  const FormDataCtor = typeof globalThis.FormData === "function" ? globalThis.FormData : null;
  const BlobCtor = typeof globalThis.Blob === "function" ? globalThis.Blob : null;
  if (!FormDataCtor || !BlobCtor) {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "当前运行时不支持 multipart 上传（缺少 FormData / Blob）", { dependency: "FormData" });
  }
  const form = new FormDataCtor();
  form.append("reqtype", "fileupload");
  form.append("time", retention);
  form.append("fileToUpload", new BlobCtor([bytes], { type: mime }), fileName);
  return form;
}

async function uploadResponseText(response) {
  if (!response) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "图床上传无响应", { dependency: "fetchImpl" });
  const status = Number(response.status);
  if (response.ok !== true) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "图床上传失败（HTTP " + (Number.isFinite(status) ? status : "unknown") + "）", { status: Number.isFinite(status) ? status : null });
  if (typeof response.text !== "function") throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "图床上传响应不可读", { dependency: "fetchImpl" });
  const text = String(await response.text()).trim();
  if (!text) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "图床返回了空直链");
  return text;
}

/** 纯文本直链 → 受信 URL：只接受 https + 固定下载域名（尾点视为同一主机）。 */
function parseDirectUrl(text) {
  let parsed;
  try { parsed = new URL(text); } catch { throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图床返回的不是合法直链"); }
  if (parsed.protocol !== "https:") throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图床直链必须是 https");
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (host !== DOWNLOAD_HOST) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图床直链域名不在允许范围", { host: host });
  return parsed;
}

/** Range GET 复验：状态码 200/206 且 Content-Type 类型组与素材声明一致。 */
async function verifyDirectUrl(parsed, group, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await runWithTimeout(
      (signal) => fetchImpl(parsed.toString(), { method: "GET", headers: { range: PROBE_RANGE }, redirect: "error", signal }),
      timeoutMs,
      "图床直链校验",
    );
  } catch (error) {
    if (isMediaError(error)) throw error;
    if (isAbortError(error)) throw timeoutError("图床直链校验");
    throw dependencyError("图床直链校验请求", error);
  }
  if (!response) throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "图床直链校验无响应", { dependency: "fetchImpl" });
  const status = Number(response.status);
  if (status !== 200 && status !== 206) {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "图床直链校验返回 HTTP " + (Number.isFinite(status) ? status : "unknown"), { status: Number.isFinite(status) ? status : null });
  }
  const mime = normalizeMime(response.headers && typeof response.headers.get === "function" ? response.headers.get("content-type") : "");
  // catbox 对部分扩展名回 octet-stream：类型组无从比对，放行但把事实带回调用方，绝不静默。
  const tolerated = mime === OCTET_STREAM;
  if (!tolerated && mediaGroup(mime) !== group) {
    throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "图床直链 Content-Type 与素材类型不符", { mime: mime || null, expected: group });
  }
  if (response.body && typeof response.body.cancel === "function") {
    try { await response.body.cancel(); } catch { /* 探测响应体已不可取消：不影响结论 */ }
  }
  return { contentType: mime, tolerated: tolerated };
}

/**
 * createLitterboxUploader({ fetchImpl, timeoutMs, maxBytes, retention })
 * → async ({ fileName, bytes, mime }) => { url, service: "litterbox", expiresAt, detail? }
 * fetchImpl 必须由宿主注入（默认不联网）；缺注入即结构化 DEPENDENCY_UNAVAILABLE。
 */
function createLitterboxUploader({ fetchImpl = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, retention = RETENTION } = {}) {
  // 有效期：Litterbox 只接受 1h / 12h / 24h / 72h；其它值回落默认 72h。画布发给模型的链接用 24h。
  const keep = Object.prototype.hasOwnProperty.call(RETENTIONS, retention) ? retention : RETENTION;
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.max(1, Math.round(Number(timeoutMs))) : DEFAULT_TIMEOUT_MS;
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Math.max(1, Math.round(Number(maxBytes))) : DEFAULT_MAX_BYTES;
  return async function uploadToLitterbox({ fileName, bytes, mime } = {}) {
    if (typeof fetchImpl !== "function") {
      throw createMediaError(MEDIA_ERR_DEPENDENCY_UNAVAILABLE, "图床上传未注入 fetchImpl", { dependency: "fetchImpl" });
    }
    const type = normalizeMime(mime);
    const group = mediaGroup(type);
    if (!group) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图床只接受图片 / 音频 / 视频素材", { mime: type || null });
    if (!bytes || typeof bytes.byteLength !== "number") throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图床上传需要素材字节");
    const size = bytes.byteLength;
    if (!size) throw createMediaError(MEDIA_ERR_INVALID_INPUT, "图床上传素材为空");
    if (size > limit) {
      throw createMediaError(
        MEDIA_ERR_INVALID_INPUT,
        (MEDIA_GROUP_LABELS[group] || "素材") + "超过 " + formatMegabytes(limit) + " MB，免费图床不支持这么大的文件",
        { bytes: size, maxBytes: limit },
      );
    }

    const form = buildUploadForm(uploadFileName(fileName), bytes, type, keep);
    let response;
    try {
      response = await runWithTimeout((signal) => fetchImpl(UPLOAD_URL, { method: "POST", body: form, signal }), timeout, "图床上传");
    } catch (error) {
      if (isMediaError(error)) throw error;
      if (isAbortError(error)) throw timeoutError("图床上传");
      throw dependencyError("图床上传请求", error);
    }
    const parsed = parseDirectUrl(await uploadResponseText(response));
    const verification = await verifyDirectUrl(parsed, group, fetchImpl, timeout);
    const result = { url: parsed.toString(), service: "litterbox", expiresAt: Date.now() + RETENTIONS[keep] };
    if (verification.tolerated) result.detail = { contentType: verification.contentType };
    return result;
  };
}

module.exports = { createLitterboxUploader };
