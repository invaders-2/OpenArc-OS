"use strict";
/**
 * dx-protocol/v2 工作流执行器：submit → poll → download，捕获、重试、错误归一化。
 * 源：DXSRC/protocol-engine/workflow.ts:1-698 逐条移植。
 * 说明：错误消息里的模板字符串改成拼接，语义不变；其余逻辑保持一致。
 */
const { DEFERRED_INPUT_REF } = require("./compiler.cjs");
const { defaultProtocolClock, defaultProtocolTransport } = require("./transport.cjs");

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

function errorCause(error) {
  return error && typeof error === "object" ? error.cause : undefined;
}

function errorCode(error) {
  for (let current = error, depth = 0; current && depth < 4; current = errorCause(current), depth += 1) {
    const code = current.code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

function describeProtocolError(error) {
  const rootMessage = String((error && error.message) || error);
  const cause = errorCause(error);
  const code = errorCode(error);
  const causeMessage = cause && typeof cause === "object" ? String(cause.message || "") : "";
  return [rootMessage, code && "(" + code + ")", causeMessage && causeMessage !== rootMessage ? causeMessage : ""].filter(Boolean).join(" ");
}

function isRetryableNetworkError(error) {
  const code = errorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  const message = describeProtocolError(error);
  return message === "fetch failed"
    || message.startsWith("协议请求超时")
    || /\b(network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET)\b/i.test(message);
}

function isAmbiguousSubmissionError(error) {
  const message = describeProtocolError(error);
  return isRetryableNetworkError(error) || /协议请求失败 HTTP (?:520|524)\b/.test(message);
}

function defaultAsyncTaskLifetimeMs(intent) {
  if (intent.startsWith("video.")) return 3 * 60 * 60_000;
  return 60 * 60_000;
}

function stablePollJitter(key) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return 0.8 + ((hash >>> 0) / 0xffffffff) * 0.4;
}

function protocolHttpErrorDetail(text, limit = 300) {
  const source = String(text || "");
  if (!/<(?:!doctype|html|head|body|title)\b/i.test(source)) return source.replace(/\s+/g, " ").trim().slice(0, limit);
  const title = (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const plain = (title || source).replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  return plain.slice(0, limit) + "（上游返回了 HTML 网关页面，请检查 API 地址或稍后重试）";
}

function jitteredPollDelay(baseMs, taskId, attempt, maxMs) {
  const jittered = Math.max(1, Math.round(baseMs * stablePollJitter(String(taskId || "task") + ":" + attempt)));
  return maxMs ? Math.min(jittered, maxMs) : jittered;
}

function selectorParts(selector) {
  const parts = [];
  for (const match of selector.slice(1).matchAll(/\.([A-Za-z0-9_-]+)|\[(\d+|\*)]/g)) {
    parts.push(match[1] || (match[2] === "*" ? "*" : Number(match[2])));
  }
  return parts;
}

function select(value, selector) {
  let values = [value];
  let wildcard = false;
  for (const part of selectorParts(selector)) {
    if (part === "*") {
      wildcard = true;
      values = values.flatMap((item) => Array.isArray(item) ? item : []);
    } else if (typeof part === "number") {
      values = values.flatMap((item) => Array.isArray(item) && item.length > part ? [item[part]] : []);
    } else {
      values = values.flatMap((item) => item && typeof item === "object" && Object.prototype.hasOwnProperty.call(item, part) ? [item[part]] : []);
    }
  }
  return wildcard ? values : values[0];
}

function selectFirst(value, selector) {
  const selectors = typeof selector === "string" ? [selector] : Array.isArray(selector) ? selector.map(String) : [];
  for (const candidate of selectors) {
    const selected = select(value, candidate);
    if (selected !== undefined && selected !== null && selected !== "" && !(Array.isArray(selected) && selected.length === 0)) return selected;
  }
  return undefined;
}

function capture(step, payload, captures) {
  for (const [key, selector] of Object.entries(step.capture || {})) {
    const value = selectFirst(payload, selector);
    if (value !== undefined) captures[key] = value;
  }
}

function captureToken(key) {
  const encoded = encodeURIComponent("<capture:" + key + ">");
  return ["<capture:" + key + ">", encoded, encoded.replace(/%3A/gi, ":")];
}

function substituteString(value, captures) {
  let output = value;
  for (const [key, captured] of Object.entries(captures)) {
    for (const token of captureToken(key)) output = output.split(token).join(encodeURIComponent(String(captured)));
  }
  return output;
}

function substitute(value, captures) {
  if (typeof value === "string") return substituteString(value, captures);
  if (Array.isArray(value)) return value.map((item) => substitute(item, captures));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, captures)]));
}

function resolveDeferredInputs(value, uploaded) {
  if (Array.isArray(value)) return value.map((item) => resolveDeferredInputs(item, uploaded));
  if (!value || typeof value !== "object") return value;
  const record = value;
  if (typeof record[DEFERRED_INPUT_REF] === "string") {
    const expression = String(record[DEFERRED_INPUT_REF]);
    const match = /^inputs\.(images|videos|audios|files)\.(\*|\d+)\.(url|name)$/.exec(expression);
    if (!match) throw new Error("协议包含无效的延迟素材引用：" + expression);
    const group = match[1];
    const field = match[3];
    if (match[2] !== "*") return uploaded.get(group + "." + match[2] + "." + field) ?? record.base;
    const base = Array.isArray(record.base) ? [...record.base] : [];
    for (const [key, item] of uploaded) {
      const itemMatch = new RegExp("^" + group + "\\.(\\d+)\\." + field + "$").exec(key);
      if (itemMatch) base[Number(itemMatch[1])] = item;
    }
    return base.filter((item) => item !== undefined && item !== null && item !== "");
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, resolveDeferredInputs(item, uploaded)]));
}

function runtimeRequest(request, captures, uploaded = new Map()) {
  const resolved = resolveDeferredInputs(substitute(request, captures), uploaded);
  if (/%3[cC]capture(?:%3[aA]|:)|<capture:/i.test(JSON.stringify(resolved))) throw new Error("协议请求仍包含未解析的 capture，提交响应可能缺少任务 ID。");
  return resolved;
}

const MAX_MULTIPART_FIELDS = 256;
const MAX_MULTIPART_FILES = 128;
const MAX_MULTIPART_BYTES = 512 * 1024 * 1024;

function multipartFile(value, fallbackName, fallbackMime) {
  const asset = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const dataUrl = String(asset.dataUrl || (typeof value === "string" ? value : ""));
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/s.exec(dataUrl);
  if (!match) throw new Error("multipart 文件必须来自已解析的 Data URL 素材");
  if (match[2].replace(/[\r\n]/g, "").length * .75 > MAX_MULTIPART_BYTES) throw new Error("multipart 单个文件超过 512 MB");
  const bytes = Buffer.from(match[2], "base64");
  const mime = String(asset.mime || match[1] || fallbackMime || "application/octet-stream").replace(/[\r\n]/g, "").slice(0, 200);
  const rawName = String(asset.name || fallbackName || "asset.bin").replace(/[\\/\r\n]/g, "_").slice(0, 240) || "asset.bin";
  return { bytes, mime, name: rawName };
}

function buildProtocolMultipartBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("multipart bodyTemplate 必须渲染为对象");
  const form = new FormData();
  let fieldCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const appendText = (name, item) => {
    fieldCount += 1;
    if (fieldCount > MAX_MULTIPART_FIELDS) throw new Error("multipart 字段不能超过 " + MAX_MULTIPART_FIELDS + " 个");
    const text = typeof item === "string" ? item : JSON.stringify(item);
    form.append(name, text === undefined ? "" : text);
  };
  for (const [name, item] of Object.entries(value)) {
    if (!name || /[\r\n]/.test(name)) throw new Error("multipart 字段名无效");
    const descriptor = item && typeof item === "object" && !Array.isArray(item) ? item : null;
    if (descriptor && ("$file" in descriptor || "$files" in descriptor)) {
      const multiple = "$files" in descriptor;
      const source = multiple ? descriptor.$files : descriptor.$file;
      const values = multiple ? (Array.isArray(source) ? source : [source]) : [Array.isArray(source) ? source[0] : source];
      for (const sourceValue of values) {
        if (sourceValue == null) continue;
        fileCount += 1;
        if (fileCount > MAX_MULTIPART_FILES) throw new Error("multipart 文件不能超过 " + MAX_MULTIPART_FILES + " 个");
        const file = multipartFile(sourceValue, String(descriptor.filename || ""), String(descriptor.mime || ""));
        totalBytes += file.bytes.byteLength;
        if (totalBytes > MAX_MULTIPART_BYTES) throw new Error("multipart 文件总大小不能超过 512 MB");
        form.append(name, new Blob([file.bytes], { type: file.mime }), file.name);
      }
      continue;
    }
    if (Array.isArray(item)) item.forEach((entry) => appendText(name, entry));
    else if (item != null) appendText(name, item);
  }
  return form;
}

function buildProtocolBinaryBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("$binary" in value)) {
    throw new Error('binary bodyTemplate 必须使用 { "$binary": "{{inputs...}}" }');
  }
  const descriptor = value;
  const source = Array.isArray(descriptor.$binary) ? descriptor.$binary[0] : descriptor.$binary;
  if (source == null) throw new Error("binary 请求没有解析到素材");
  const file = multipartFile(source, String(descriptor.filename || ""), String(descriptor.mime || ""));
  return { body: new Blob([file.bytes], { type: file.mime }), mime: file.mime, name: file.name, bytes: file.bytes.byteLength };
}

async function fetchWithTimeout(transport, url, init, timeoutMs, signal) {
  if (signal && signal.aborted) throw new Error("协议任务已取消");
  const controller = new AbortController();
  let rejectCancelled;
  const cancelled = new Promise((_resolve, reject) => { rejectCancelled = reject; });
  const abort = () => { controller.abort(); if (rejectCancelled) rejectCancelled(new Error("协议任务已取消")); };
  if (signal) signal.addEventListener("abort", abort, { once: true });
  let timer;
  try {
    const request = transport.fetch(url, { ...init, signal: controller.signal });
    if (!timeoutMs) return await Promise.race([request, cancelled]);
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("协议请求超时（" + timeoutMs + " ms）")); }, timeoutMs);
    });
    return await Promise.race([request, cancelled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abort);
  }
}

async function executeRequest(request, transport, signal, clock = defaultProtocolClock) {
  if (signal && signal.aborted) throw new Error("协议任务已取消");
  const headers = { ...request.headers };
  let body;
  if (request.body !== undefined && !["GET", "HEAD"].includes(request.method)) {
    if (request.requestMode === "json") body = JSON.stringify(request.body);
    else if (request.requestMode === "multipart") {
      for (const key of Object.keys(headers)) if (key.toLowerCase() === "content-type") delete headers[key];
      body = buildProtocolMultipartBody(request.body);
    } else if (request.requestMode === "binary") {
      const binary = buildProtocolBinaryBody(request.body);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["Content-Type"] = binary.mime;
      body = binary.body;
    } else if (typeof request.body === "string" || request.body instanceof Blob || request.body instanceof FormData || request.body instanceof URLSearchParams) body = request.body;
    else body = JSON.stringify(request.body);
  }
  const retry = request.retry;
  const safeToRetry = ["GET", "HEAD"].includes(request.method);
  const totalAttempts = safeToRetry ? Math.max(1, (retry && retry.attempts) || 1) : 1;
  const fetchCandidate = async (url) => {
    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const response = await fetchWithTimeout(transport, url, { method: request.method, headers, body }, request.timeoutMs, signal);
        const retryStatus = (retry && retry.retryStatus) || [];
        if (attempt < totalAttempts && retryStatus.includes(response.status)) {
          void (response.body && response.body.cancel && response.body.cancel());
          const delay = Math.round(((retry && retry.delayMs) || 0) * Math.pow((retry && retry.backoff) || 1, attempt - 1));
          if (delay > 0) await clock.sleep(delay);
          continue;
        }
        return response;
      } catch (error) {
        if (signal && signal.aborted) throw new Error("协议任务已取消");
        if (attempt >= totalAttempts || !retry || retry.retryNetwork !== true) throw error;
        const delay = Math.round((retry.delayMs || 0) * Math.pow(retry.backoff || 1, attempt - 1));
        if (delay > 0) await clock.sleep(delay);
      }
    }
    throw new Error("协议请求重试耗尽");
  };
  const candidates = [{ url: request.url, onStatus: [], onNetworkError: false }, ...(request.fallbacks || [])];
  let response;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      response = await fetchCandidate(candidate.url);
    } catch (error) {
      const next = candidates[index + 1];
      if (next && next.onNetworkError) continue;
      throw error;
    }
    const next = candidates[index + 1];
    if (next && next.onStatus.includes(response.status)) {
      void (response.body && response.body.cancel && response.body.cancel());
      response = undefined;
      continue;
    }
    break;
  }
  if (!response) throw new Error("协议 endpoint fallback 已耗尽");
  const successful = request.successStatus && request.successStatus.length ? request.successStatus.includes(response.status) : response.ok;
  const mode = request.responseMode || "json";
  if (mode === "binary") {
    const data = new Uint8Array(await response.arrayBuffer());
    if (!successful) {
      const detail = Buffer.from(data).toString("utf8").replace(/\s+/g, " ").trim().slice(0, 500);
      throw new Error("协议请求失败 HTTP " + response.status + (detail ? "：" + detail : ""));
    }
    return { payload: data, response };
  }
  const text = await response.text();
  let payload = text;
  if (mode === "json") {
    try { payload = JSON.parse(text); } catch {
      if (!successful) throw new Error("协议请求失败 HTTP " + response.status + "：" + protocolHttpErrorDetail(text));
      throw new Error("协议期望 JSON，但收到不可解析响应：" + text.slice(0, 160));
    }
  } else if (mode === "ndjson") {
    const chunks = [];
    try {
      for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        const value = JSON.parse(line.replace(/^data:\s*/, ""));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("chunk 不是对象");
        chunks.push(value);
      }
    } catch {
      if (!successful) throw new Error("协议请求失败 HTTP " + response.status + "：" + protocolHttpErrorDetail(text));
      throw new Error("协议期望 NDJSON，但收到不可解析响应：" + text.slice(0, 160));
    }
    if (!chunks.length) throw new Error("协议期望 NDJSON，但响应为空");
    const last = chunks[chunks.length - 1];
    const dataChunks = chunks.map((item) => typeof item.data === "string" ? item.data : "").filter(Boolean);
    const concatenatedBase64 = dataChunks.length ? Buffer.concat(dataChunks.map((item) => Buffer.from(item, "base64"))).toString("base64") : "";
    payload = { ...last, ...(concatenatedBase64 ? { concatenatedBase64 } : {}), chunks };
  }
  if (!successful) throw new Error("协议请求失败 HTTP " + response.status + "：" + (typeof payload === "string" ? protocolHttpErrorDetail(payload) : JSON.stringify(payload).slice(0, 300)));
  return { payload, response };
}

function normalizedStatus(value) { return String(value || "").trim().toLowerCase(); }

function checkpointCaptures(captures) {
  const safe = {};
  for (const key of ["taskId", "status", "progress", "errorCode", "errorMessage"]) {
    const value = captures[key];
    if (value !== undefined && value !== null && typeof value !== "object") safe[key] = value;
  }
  return safe;
}

function flattenResultValues(value) {
  return Array.isArray(value) ? value.flatMap(flattenResultValues) : value !== undefined && value !== null && value !== "" ? [value] : [];
}

function decodedBase64(value) {
  const raw = String(value || "").trim();
  const dataUrl = /^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/_=-\s]+)$/is.exec(raw);
  const encoded = (dataUrl ? dataUrl[2] : raw).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const data = new Uint8Array(Buffer.from(encoded, "base64"));
  if (!data.length) return null;
  const canonicalInput = encoded.replace(/=+$/, "");
  const canonicalData = Buffer.from(data).toString("base64").replace(/=+$/, "");
  return canonicalInput === canonicalData ? { data, mime: dataUrl ? dataUrl[1] : undefined } : null;
}

function inferredMime(kind, data, declared) {
  if (declared) return declared;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return "image/gif";
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return "image/webp";
  if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return "video/mp4";
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return "audio/mpeg";
  return kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "application/octet-stream";
}

const FALLBACK_BASE64_KEYS = new Set(["b64_json", "image_base64", "imagebase64", "base64", "data_base64"]);
const FALLBACK_URL_KEYS = {
  image: new Set(["url", "image_url", "imageurl"]),
  video: new Set(["url", "video_url", "videourl", "result_url", "resulturl"]),
  audio: new Set(["url", "audio_url", "audiourl", "result_url", "resulturl"]),
  file: new Set(["url", "file_url", "fileurl", "result_url", "resulturl"]),
  text: new Set(),
};

function fallbackMediaValues(payload, kind) {
  const urls = [];
  const data = [];
  let visited = 0;
  const pushTextMedia = (value) => {
    if (kind === "image") {
      for (const match of value.matchAll(/data:image\/[a-z0-9.+-]+(?:;[^,\s]*)?;base64,[a-z0-9+/_=-]+/gi)) data.push(match[0]);
    }
    for (const match of value.matchAll(/https?:\/\/[^\s<>"'\`]+/gi)) {
      const candidate = match[0].replace(/[),.;!?\]}]+$/g, "");
      if (candidate) urls.push(candidate);
    }
  };
  const visit = (value, depth) => {
    if (depth > 16 || visited++ > 20000 || !value) return;
    if (typeof value === "string") { pushTextMedia(value); return; }
    if (typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    const record = value;
    const declaredMime = String(record.mime_type || record.mimeType || "");
    if (declaredMime.startsWith(kind + "/") && typeof record.data === "string") data.push(record.data);
    for (const [rawKey, item] of Object.entries(record)) {
      const key = rawKey.toLowerCase();
      if (FALLBACK_BASE64_KEYS.has(key)) data.push(...flattenResultValues(item));
      else if (FALLBACK_URL_KEYS[kind].has(key)) urls.push(...flattenResultValues(item));
      if (item && typeof item === "object") visit(item, depth + 1);
    }
  };
  visit(payload, 0);
  return { urls, data };
}

function outputFromCaptures(plan, step, captures, payload) {
  const result = step.result || (plan.steps.find((item) => item.result) || {}).result;
  if (!result) return [];
  if (result.source === "response" && result.kind === "text") {
    const value = captures.text ?? (typeof payload === "string" ? payload : undefined);
    if (value !== undefined && value !== null) {
      const text = typeof value === "object" ? JSON.stringify(value) : String(value);
      return [{ kind: "text", mime: result.mime || "text/plain; charset=utf-8", data: Buffer.from(text, "utf8") }];
    }
    return [];
  }
  const resultValue = captures.resultUrls ?? captures.resultUrl;
  let values = flattenResultValues(resultValue);
  if (result.source === "resultUrl") {
    let dataValues = flattenResultValues(captures.resultData);
    if (!values.length && !dataValues.length) {
      const fallback = fallbackMediaValues(payload, result.kind);
      values = fallback.urls;
      dataValues = fallback.data;
    }
    const mimeValues = Array.isArray(captures.resultMimeTypes) ? captures.resultMimeTypes : captures.resultMimeTypes == null || captures.resultMimeTypes === "" ? [] : [captures.resultMimeTypes];
    const urls = values.flatMap((value, index) => {
      const inline = decodedBase64(value);
      if (inline) return [{ kind: result.kind, mime: inferredMime(result.kind, inline.data, String(mimeValues[index] || inline.mime || result.mime || "") || undefined), data: inline.data }];
      const url = String(value);
      if (/^https?:\/\/[^\s]+$/i.test(url)) return [{ kind: result.kind, mime: result.mime, url, sourceUrl: url }];
      const embedded = fallbackMediaValues(url, result.kind);
      return [
        ...embedded.urls.map((item) => ({ kind: result.kind, mime: result.mime, url: String(item), sourceUrl: String(item) })),
        ...embedded.data.flatMap((item) => {
          const decoded = decodedBase64(item);
          return decoded ? [{ kind: result.kind, mime: inferredMime(result.kind, decoded.data, decoded.mime || result.mime), data: decoded.data }] : [];
        }),
      ];
    });
    const inline = dataValues.flatMap((value, index) => {
      const decoded = decodedBase64(value);
      if (decoded) return [{ kind: result.kind, mime: inferredMime(result.kind, decoded.data, String(mimeValues[index] || decoded.mime || result.mime || "") || undefined), data: decoded.data }];
      const url = String(value);
      return /^https?:\/\//i.test(url) ? [{ kind: result.kind, mime: result.mime, url, sourceUrl: url }] : [];
    });
    return [...urls, ...inline];
  }
  if (result.source === "response" && payload !== undefined) return [{ kind: result.kind, mime: result.mime, ...(typeof payload === "string" ? { url: payload } : {}) }];
  return [];
}

async function completedResult(plan, step, captures, raw, transport, signal, clock = defaultProtocolClock, directResponse) {
  let payload = raw;
  let outputs = outputFromCaptures(plan, step, captures, payload);
  const download = plan.steps.find((item) => item.id === "download");
  const submit = plan.steps.find((item) => item.id === "submit");
  const resultSpec = (download && download.result) || (submit && submit.result);
  if (!download && resultSpec && resultSpec.source === "binary" && payload instanceof Uint8Array) {
    outputs = [{ kind: resultSpec.kind, mime: resultSpec.mime || (directResponse && directResponse.headers.get("content-type")) || undefined, data: payload }];
  }
  if (download && resultSpec && resultSpec.source === "binary") {
    const downloaded = await executeRequest(runtimeRequest(download.request, captures), transport, signal, clock);
    payload = downloaded.payload;
    if (!(downloaded.payload instanceof Uint8Array)) throw new Error("下载 operation 没有返回二进制数据");
    outputs = [{ kind: resultSpec.kind, mime: resultSpec.mime || downloaded.response.headers.get("content-type") || undefined, data: downloaded.payload }];
  }
  if (!outputs.length) throw new Error("协议任务已完成，但没有标准化输出");
  return { taskId: captures.taskId ? String(captures.taskId) : undefined, outputs, captures, raw: payload };
}

async function startProtocolPlan(args) {
  const transport = args.transport || defaultProtocolTransport;
  const clock = args.clock || defaultProtocolClock;
  const captures = {};
  const uploaded = new Map();
  for (const step of args.plan.steps.filter((item) => item.id === "upload")) {
    if (!step.upload) throw new Error("upload step 缺少素材映射声明");
    const response = await executeRequest(runtimeRequest(step.request, captures, uploaded), transport, args.signal, clock);
    const uploadCaptures = {};
    capture(step, response.payload, uploadCaptures);
    const captured = uploadCaptures[step.upload.source];
    if (captured === undefined || captured === null || captured === "") throw new Error("upload operation 未捕获 " + step.upload.source);
    if (typeof captured === "object") throw new Error("upload operation 的 " + step.upload.source + " 必须捕获单个字符串或数字");
    if (step.upload.target === "url" && !/^https?:\/\//i.test(String(captured))) throw new Error("upload operation 返回了无效 URL：" + String(captured).slice(0, 120));
    const field = step.upload.target === "remoteName" ? "name" : "url";
    uploaded.set(step.upload.inputs + "." + step.upload.index + "." + field, String(captured));
    if (args.onEvent) args.onEvent({ type: "upload", inputs: step.upload.inputs, index: step.upload.index, target: step.upload.target });
  }
  const submit = args.plan.steps.find((step) => step.id === "submit");
  if (!submit) throw new Error("协议计划缺少 submit step");
  if (args.onEvent) args.onEvent({ type: "submitting" });
  const submitted = await executeRequest(runtimeRequest(submit.request, captures, uploaded), transport, args.signal, clock);
  capture(submit, submitted.payload, captures);
  if (args.onEvent) args.onEvent({ type: "submitted", ...(captures.taskId ? { taskId: String(captures.taskId) } : {}) });
  const immediate = outputFromCaptures(args.plan, submit, captures, submitted.payload);
  const poll = args.plan.steps.find((step) => step.id === "poll");
  if (immediate.length || !poll || !poll.repeat) {
    const result = await completedResult(args.plan, submit, captures, submitted.payload, transport, args.signal, clock, submitted.response);
    if (args.onEvent) args.onEvent({ type: "completed", outputs: result.outputs });
    return { status: "completed", result };
  }
  try { runtimeRequest(poll.request, captures); }
  catch (error) {
    const preview = typeof submitted.payload === "string" ? submitted.payload : JSON.stringify(submitted.payload);
    throw new Error(String((error && error.message) || error) + " 提交响应：" + String(preview || "").slice(0, 500));
  }
  const intervalMs = poll.repeat.intervalMs;
  const startedAt = args.now ?? Date.now();
  const nextPollAt = startedAt + jitteredPollDelay(intervalMs, captures.taskId, 0, poll.repeat.maxIntervalMs);
  return {
    status: "pending",
    taskId: captures.taskId ? String(captures.taskId) : undefined,
    checkpoint: {
      phase: "poll", captures: checkpointCaptures(captures), attempt: 0, intervalMs,
      nextPollAt, startedAt,
      deadlineAt: startedAt + (poll.repeat.maxDurationMs || defaultAsyncTaskLifetimeMs(args.plan.intent)),
    },
  };
}

async function resumeProtocolPlan(args) {
  const transport = args.transport || defaultProtocolTransport;
  const clock = args.clock || defaultProtocolClock;
  const poll = args.plan.steps.find((step) => step.id === "poll");
  if (!poll || !poll.repeat) throw new Error("协议计划没有可恢复的 poll step");
  const now = args.now ?? Date.now();
  if (now < args.checkpoint.nextPollAt) return { status: "pending", taskId: String(args.checkpoint.captures.taskId || "") || undefined, checkpoint: args.checkpoint };
  const startedAt = Number.isFinite(args.checkpoint.startedAt) ? Number(args.checkpoint.startedAt) : now;
  const deadlineAt = Number.isFinite(args.checkpoint.deadlineAt) ? Number(args.checkpoint.deadlineAt) : startedAt + (poll.repeat.maxDurationMs || defaultAsyncTaskLifetimeMs(args.plan.intent));
  if (now >= deadlineAt) {
    const hours = Math.round((deadlineAt - startedAt) / 36000) / 100;
    throw new Error("协议任务已轮询超过 " + hours + " 小时，远端仍未完成；系统不会重新提交任务");
  }
  const maxAttempts = poll.repeat.maxAttempts || 100000;
  if (args.checkpoint.attempt >= maxAttempts) throw new Error("协议任务轮询超过最大次数 " + maxAttempts);
  const captures = { ...args.checkpoint.captures };
  let response;
  try {
    response = await executeRequest(runtimeRequest(poll.request, captures), transport, args.signal, clock);
  } catch (error) {
    if ((args.signal && args.signal.aborted) || !isRetryableNetworkError(error)) throw error;
    const attempt = args.checkpoint.attempt + 1;
    const intervalMs = Math.min(Math.round(args.checkpoint.intervalMs * (poll.repeat.backoff || 1)), poll.repeat.maxIntervalMs || Number.MAX_SAFE_INTEGER);
    const nextPollAt = now + jitteredPollDelay(intervalMs, captures.taskId, attempt, poll.repeat.maxIntervalMs);
    const message = describeProtocolError(error);
    if (args.onEvent) args.onEvent({ type: "network-retry", message, code: errorCode(error), attempt, nextPollAt });
    return { status: "pending", taskId: captures.taskId ? String(captures.taskId) : undefined, checkpoint: { phase: "poll", captures: checkpointCaptures(captures), attempt, intervalMs, nextPollAt, startedAt, deadlineAt } };
  }
  capture(poll, response.payload, captures);
  const status = normalizedStatus(captures.status);
  const progress = captures.progress == null ? undefined : Number(captures.progress);
  if (args.onEvent) args.onEvent({ type: "progress", status, ...(Number.isFinite(progress) ? { progress } : {}) });
  if (poll.repeat.status.failure.map(normalizedStatus).includes(status)) throw new Error(String(captures.errorMessage || captures.errorCode || "协议任务失败：" + status));
  if (poll.repeat.status.success.map(normalizedStatus).includes(status)) {
    const result = await completedResult(args.plan, poll, captures, response.payload, transport, args.signal, clock, response.response);
    if (args.onEvent) args.onEvent({ type: "completed", outputs: result.outputs });
    return { status: "completed", result };
  }
  if (!poll.repeat.status.pending.map(normalizedStatus).includes(status)) throw new Error("协议返回未知任务状态「" + (status || "empty") + "」");
  const intervalMs = Math.min(Math.round(args.checkpoint.intervalMs * (poll.repeat.backoff || 1)), poll.repeat.maxIntervalMs || Number.MAX_SAFE_INTEGER);
  const nextPollAt = now + jitteredPollDelay(intervalMs, captures.taskId, args.checkpoint.attempt + 1, poll.repeat.maxIntervalMs);
  return { status: "pending", taskId: captures.taskId ? String(captures.taskId) : undefined, checkpoint: { phase: "poll", captures: checkpointCaptures(captures), attempt: args.checkpoint.attempt + 1, intervalMs, nextPollAt, startedAt, deadlineAt } };
}

async function executeProtocolPlan(args) {
  const transport = args.transport || defaultProtocolTransport;
  const clock = args.clock || defaultProtocolClock;
  try {
    let advance = await startProtocolPlan({ plan: args.plan, transport, signal: args.signal, now: clock.now(), clock, onEvent: args.onEvent });
    while (advance.status === "pending") {
      await clock.sleep(Math.max(0, advance.checkpoint.nextPollAt - clock.now()));
      advance = await resumeProtocolPlan({ plan: args.plan, checkpoint: advance.checkpoint, transport, signal: args.signal, now: clock.now(), clock, onEvent: args.onEvent });
    }
    return advance.result;
  } catch (error) {
    const message = String((error && error.message) || error);
    if (args.onEvent) args.onEvent({ type: "failed", message });
    throw error;
  }
}

module.exports = {
  describeProtocolError, isRetryableNetworkError, isAmbiguousSubmissionError,
  buildProtocolMultipartBody, buildProtocolBinaryBody, startProtocolPlan, resumeProtocolPlan, executeProtocolPlan,
  select, selectFirst, checkpointCaptures, outputFromCaptures,
};
