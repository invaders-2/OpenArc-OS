/**
 * B7e3 · Agnes 可选插件（逐函数移植 server/agnes.ts:1-196 + server/agnesEndpoint.ts:1-14）。
 *
 * 逐函数对应（源文件:行号）：
 *   agnesEndpoint.ts:1-2    AGNES_GLOBAL_API_BASE_URL / AGNES_CHINA_API_BASE_URL
 *   agnesEndpoint.ts:5-13   normalizeAgnesApiBaseUrl（控制台域名 → API 域名）
 *   agnes.ts:5-8            AGNES_BASE_URL / AGNES_KEY_URL / AGNES_IMAGE_MODELS / AGNES_VIDEO_MODELS
 *   agnes.ts:10-16          endpoint（base 归一 + /v1 去重 + 路径拼接）
 *   agnes.ts:18-24          authHeaders
 *   agnes.ts:26-28          dataUrl
 *   agnes.ts:30-38          imageResults（data[] / images[] / url / image_url / b64_json）
 *   agnes.ts:40-61          runAgnesImage（图片生成 / 编辑共用）
 *   agnes.ts:63-69          generateAgnesImages / editAgnesImages
 *   agnes.ts:71-78          agnesDimensions（像素尺寸 + 8 倍数对齐）
 *   agnes.ts:80-85          agnesFrameCount（v2.0 帧数 / 帧率）
 *   agnes.ts:87-99          videoUrls（递归收集 mp4/webm/mov）
 *   agnes.ts:101-104        taskStatus
 *   agnes.ts:106-196        generateAgnesVideos（2.5 / 2.5 Flash / v2.0 三种请求体 + 轮询）
 *
 * 与源文件的差异（任务书硬要求，不是行为漂移）：
 *   · **网络一律经注入 transport.fetch 或装配时注入的 fetch**；未注入即结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }；
 *   · 流水线方法不 throw 到 IPC 出口：成功返回源协议形状 { images, raw } / { videos, raw }，失败返回 { ok:false, ... }；
 *   · API Key 走 credential-store（ref = agnes.apiKey），磁盘不落明文；provider.api_key 仍可直接传入；
 *   · 轮询等待走注入 clock（执行器传 { now, sleep }；装配默认真实时钟）；
 *   · 未启用插件 / 未配置 Key / 未注入 fetch 一律结构化不可用，绝不假生成。
 *
 * OUT（不引入）：api.dx-os.com、云发布 / 更新、云端实时房间。
 */

"use strict";

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT } = require("./plugin-registry.cjs");

// agnesEndpoint.ts:1-2 逐字搬运
const AGNES_GLOBAL_API_BASE_URL = "https://apihub.agnes-ai.com";
const AGNES_CHINA_API_BASE_URL = "https://api.agnes-ai.cn";

// agnes.ts:5-8 逐字搬运
const AGNES_BASE_URL = AGNES_GLOBAL_API_BASE_URL;
const AGNES_KEY_URL = "https://platform.agnes-ai.com/settings/apiKeys";
const AGNES_IMAGE_MODELS = Object.freeze(["agnes-image-2.1-flash", "agnes-image-2.0-flash"]);
const AGNES_VIDEO_MODELS = Object.freeze(["agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"]);

const CREDENTIAL_REF = "agnes.apiKey";
const REQUEST_FAILED = "INTEGRATION_REQUEST_FAILED";

const asStr = (value, max = 4096) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));

/** agnesEndpoint.ts:5-13 逐字移植。 */
function normalizeAgnesApiBaseUrl(value) {
  const raw = String(value || AGNES_GLOBAL_API_BASE_URL).trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host === "platform.agnes-ai.cn" || host === "www.agnes-ai.cn" || host === "agnes-ai.cn") return AGNES_CHINA_API_BASE_URL;
    if (host === "platform.agnes-ai.com" || host === "www.agnes-ai.com" || host === "agnes-ai.com") return AGNES_GLOBAL_API_BASE_URL;
  } catch { /* 保留原始值，交由正常 URL 校验报错 */ }
  return raw;
}

/** agnes.ts:10-16 逐字移植。 */
function endpoint(baseUrl, path) {
  let base = normalizeAgnesApiBaseUrl(baseUrl);
  const suffix = String(path).replace(/^\/+/, "");
  if (suffix === "agnesapi") base = base.replace(/\/v1$/i, "");
  else if (/^v1\//i.test(suffix)) base = base.replace(/\/v1$/i, "");
  return base + "/" + suffix;
}

/** agnes.ts:18-24 逐字移植。 */
function authHeaders(provider) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: "Bearer " + String((provider && provider.api_key) || "").trim(),
  };
}

/** agnes.ts:26-28 逐字移植。 */
function dataUrl(input) {
  return "data:" + (input.mime || "image/png") + ";base64," + input.buf.toString("base64");
}

/** agnes.ts:30-38 逐字移植。 */
function imageResults(payload) {
  const items = Array.isArray(payload && payload.data) ? payload.data : Array.isArray(payload && payload.images) ? payload.images : [];
  return items.flatMap((item) => {
    if (typeof item === "string") return [{ type: "url", value: item }];
    if (item && (item.url || item.image_url)) return [{ type: "url", value: String(item.url || item.image_url) }];
    if (item && item.b64_json) return [{ type: "b64", value: String(item.b64_json) }];
    return [];
  });
}

/** agnes.ts:71-78 逐字移植。 */
function agnesDimensions(aspectRatio = "16:9", resolution = "720p") {
  const [baseWidth, baseHeight] = ({
    "16:9": [1152, 648], "9:16": [648, 1152], "4:3": [1024, 768], "3:4": [768, 1024],
    "1:1": [768, 768], "21:9": [1280, 544], "9:21": [544, 1280],
  })[aspectRatio] || [1152, 768];
  const scale = ({ "480p": 0.625, "720p": 1, "780p": 1, "1080p": 1.5 })[String(resolution).toLowerCase()] || 1;
  return {
    width: Math.max(64, Math.round(baseWidth * scale / 8) * 8),
    height: Math.max(64, Math.round(baseHeight * scale / 8) * 8),
  };
}

/** agnes.ts:80-85 逐字移植。 */
function agnesFrameCount(duration = 5, fps = 24) {
  const seconds = Math.max(1, Math.min(18, Math.round(Number(duration) || 5)));
  const frameRate = Math.max(1, Math.min(60, Math.round(Number(fps) || 24)));
  const target = Math.min(441, Math.max(9, seconds * frameRate));
  return { num_frames: Math.min(441, Math.max(9, 8 * Math.max(1, Math.round((target - 1) / 8)) + 1)), frame_rate: frameRate };
}

/** agnes.ts:87-99 逐字移植。 */
function videoUrls(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) && /\.(mp4|webm|mov)(\?|$)/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) { for (const item of value) videoUrls(item, out, depth + 1); return out; }
  if (typeof value !== "object") return out;
  for (const key of ["video_url", "videoUrl", "url", "output", "outputs", "videos", "result", "data", "metadata"]) {
    if (key in value) videoUrls(value[key], out, depth + 1);
  }
  return out;
}

/** agnes.ts:101-104 逐字移植。 */
function taskStatus(payload) {
  const data = payload && payload.data && typeof payload.data === "object" ? payload.data : payload;
  return String((data && (data.status || data.task_status)) || (payload && payload.status) || "").toUpperCase();
}

function createAgnesIntegration(options = {}) {
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : null;
  const credentials = options.credentials && typeof options.credentials === "object" ? options.credentials : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const defaultTimeout = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 180000;

  const credentialsAvailable = () => !!credentials && typeof credentials.available === "function" && credentials.available() === true;

  function unavailable(detail) { return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail }; }

  /** 网络出口：执行器注入的 transport（{fetch} 或函数）优先，其次装配注入的 fetch。 */
  function resolveFetch(transport) {
    if (transport && typeof transport.fetch === "function") return transport.fetch;
    if (typeof transport === "function") return transport;
    return typeof fetchImpl === "function" ? fetchImpl : null;
  }
  function resolveClock(injected) {
    return injected && typeof injected.now === "function" && typeof injected.sleep === "function"
      ? injected
      : { now: () => clock(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  }
  function readStored() {
    if (!credentialsAvailable()) return "";
    try { return asStr(credentials.get(CREDENTIAL_REF), 4096).trim(); } catch { return ""; }
  }
  /** api_key 解析：provider.api_key 优先，其次 credential-store（无明文落盘）。 */
  function resolveApiKey(provider) {
    const direct = provider && provider.api_key != null ? asStr(provider.api_key, 4096).trim() : "";
    return direct || readStored();
  }
  function maskSecret(value) {
    const text = asStr(value, 4096).trim();
    if (!text) return "";
    return text.length <= 8 ? "•".repeat(text.length) : text.slice(0, 4) + "••••" + text.slice(-4);
  }
  function credentialState() {
    const key = readStored();
    return { safeStorageAvailable: credentialsAvailable(), apiKeySet: !!key, apiKeyMask: maskSecret(key), credentialRef: CREDENTIAL_REF };
  }
  /** 供 plugin-registry 的 credential 依赖探测使用：ok=null 表示"探测不了"，不是"缺失"。 */
  function credentialProbe() {
    if (!credentialsAvailable()) return { ok: null, status: "unknown", detail: "safeStorage 不可用，凭据由 provider.api_key 或系统安全存储提供" };
    const key = readStored();
    return key
      ? { ok: true, status: "ok", detail: "已配置 Agnes API Key" }
      : { ok: false, status: "missing", detail: "未配置 Agnes API Key（credential-store 中无 " + CREDENTIAL_REF + "）" };
  }
  function saveCredential(input = {}) {
    const apiKey = asStr(input.apiKey, 4096).trim();
    if (!apiKey) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "apiKey 不能为空" };
    if (!credentialsAvailable()) return unavailable("safeStorage 不可用，Agnes API Key 无法加密保存（为不落明文，本功能停用）");
    credentials.put(CREDENTIAL_REF, apiKey);
    return { ok: true, value: credentialState() };
  }
  function deleteCredential() {
    if (credentialsAvailable()) { try { credentials.delete(CREDENTIAL_REF); } catch { /* 忽略 */ } }
    return { ok: true, value: credentialState() };
  }
  function status() {
    return {
      ok: true,
      value: {
        fetchInjected: typeof fetchImpl === "function",
        baseUrl: AGNES_BASE_URL,
        keyUrl: AGNES_KEY_URL,
        imageModels: AGNES_IMAGE_MODELS.slice(),
        videoModels: AGNES_VIDEO_MODELS.slice(),
        ...credentialState(),
      },
    };
  }

  /** agnes.ts:40-61 逐字移植（transport → net 函数，错误信息保持源文案）。 */
  async function runAgnesImage(provider, model, params, inputs, timeoutMs, net) {
    const extraBody = { response_format: "url" };
    if (inputs.length) extraBody.image = inputs.map(dataUrl);
    const body = { model, prompt: String((params && params.prompt) || "").trim(), size: (params && params.size) || "1024x1024", extra_body: extraBody };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await net(endpoint(provider && provider.base_url, "/v1/images/generations"), {
        method: "POST", headers: authHeaders(provider), body: JSON.stringify(body), signal: ctrl.signal,
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = text; }
      if (!response.ok) throw new Error("HTTP " + response.status + ": " + (typeof payload === "string" ? payload.slice(0, 500) : JSON.stringify(payload).slice(0, 500)));
      const images = imageResults(payload);
      if (!images.length) throw new Error("Agnes 图片接口未返回图片：" + JSON.stringify(payload).slice(0, 500));
      return { images, raw: payload };
    } catch (error) {
      if (ctrl.signal.aborted) throw new Error("Agnes 图片生成超时，请稍后重试。");
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** agnes.ts:106-196 逐字移植（transport → net 函数 + 注入 clock）。 */
  async function runAgnesVideo(provider, model, params, timeoutMs, net, clockOverride) {
    const time = resolveClock(clockOverride);
    const selectedModel = model || AGNES_VIDEO_MODELS[0];
    const isVideo25Flash = /^agnes-video-(?:v)?2\.5-flash(?:$|[-_])/i.test(selectedModel);
    const isVideo25 = /^agnes-video-(?:v)?2\.5(?:$|[-_])/i.test(selectedModel);
    const imageInputs = ((params && params.images) || []).slice(0, isVideo25Flash ? 5 : 8);
    const images = imageInputs.map(dataUrl);
    const publicReference = (input, label) => {
      const url = String((input && input.publicUrl) || "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("Agnes Video 2.5 的" + label + "必须先转换为公网 URL，不能直接提交本地文件或 Data URL。");
      return url;
    };
    const firstFrameIndex = imageInputs.findIndex((item) => String((item && item.role) || "").toLowerCase() === "first_frame");
    const lastFrameIndex = imageInputs.findIndex((item) => String((item && item.role) || "").toLowerCase() === "last_frame");
    const hasKeyframeRole = firstFrameIndex >= 0 || lastFrameIndex >= 0;
    let body;
    if (isVideo25) {
      const supportedRatios = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
      const requestedRatio = String((params && (params.aspect_ratio || params.size)) || "16:9");
      const seconds = Math.max(4, Math.min(12, Math.round(Number(params && params.duration) || 5)));
      const requestedResolution = String((params && params.resolution) || "720p").toLowerCase();
      const size = isVideo25Flash ? "720P" : ({ "720p": "720P", "1080p": "1080P", "1k": "1K", "2k": "2K" })[requestedResolution] || "720P";
      const hasNonImageReference = Boolean((params && params.audios && params.audios.length) || (params && params.videos && params.videos.length));
      body = {
        model: selectedModel,
        prompt: String((params && params.prompt) || ""),
        mode: hasKeyframeRole && !hasNonImageReference ? "keyframe" : images.length || hasNonImageReference ? "reference" : "text",
        size,
        aspect_ratio: supportedRatios.has(requestedRatio) ? requestedRatio : "16:9",
        seconds: String(seconds),
        n: 1,
      };
    } else {
      // Agnes Video v2.0 使用像素尺寸与帧数；这些字段在 2.5 Flash 中会直接触发 HTTP 400。
      const dimensions = agnesDimensions(String((params && (params.aspect_ratio || params.size)) || "16:9"), String((params && params.resolution) || "720p"));
      const frames = agnesFrameCount(params && params.duration, 24);
      body = { model: selectedModel, prompt: String((params && params.prompt) || ""), width: dimensions.width, height: dimensions.height, ...frames };
    }
    if (isVideo25 && (images.length || (params && params.audios && params.audios.length) || (params && params.videos && params.videos.length))) {
      if (hasKeyframeRole && !(params && params.audios && params.audios.length) && !(params && params.videos && params.videos.length)) {
        if (firstFrameIndex >= 0) body.first_frame = imageInputs[firstFrameIndex].publicUrl || images[firstFrameIndex];
        if (lastFrameIndex >= 0) body.last_frame = imageInputs[lastFrameIndex].publicUrl || images[lastFrameIndex];
      } else {
        if (images.length) body.images = imageInputs.map((item, index) => item.publicUrl || images[index]);
        if (params && params.audios && params.audios.length) body.audios = params.audios.slice(0, 3).map((item) => publicReference(item, "参考音频"));
        if (params && params.videos && params.videos.length) {
          if (isVideo25Flash) throw new Error("Agnes Video 2.5 Flash 不支持参考视频，请改用 Agnes Video 2.5。");
          body.videos = params.videos.slice(0, 1).map((item) => ({ url: publicReference(item, "参考视频") }));
        }
      }
    } else {
      if (images.length === 1) body.image = images[0];
      if (images.length > 1) {
        const multimodal = (params && params.multimodal) || (params && params.images && params.images.some((item) => ["first_frame", "last_frame"].includes(String((item && item.role) || ""))));
        body.extra_body = { image: images, ...(multimodal ? { mode: "keyframes" } : {}) };
      }
    }
    if (params && params.seed !== undefined) body.seed = params.seed;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const submit = await net(endpoint(provider && provider.base_url, "/v1/videos"), { method: "POST", headers: authHeaders(provider), body: JSON.stringify(body), signal: ctrl.signal });
      const text = await submit.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = text; }
      if (!submit.ok) throw new Error("HTTP " + submit.status + ": " + (typeof payload === "string" ? payload.slice(0, 500) : JSON.stringify(payload).slice(0, 500)));
      let urls = videoUrls(payload);
      if (urls.length) return { videos: urls.map((value) => ({ type: "url", value })), raw: payload };
      const videoId = String((payload && (payload.video_id || payload.task_id || payload.id)) || "").trim();
      if (!videoId) throw new Error("Agnes 未返回 video_id：" + JSON.stringify(payload).slice(0, 500));
      let last = payload;
      let delay = 5000;
      while (!ctrl.signal.aborted) {
        await time.sleep(delay);
        const query = new URLSearchParams({ video_id: videoId, model_name: selectedModel });
        let response = await net(endpoint(provider && provider.base_url, "/agnesapi") + "?" + query, { headers: authHeaders(provider), signal: ctrl.signal });
        if (!response.ok) response = await net(endpoint(provider && provider.base_url, "/v1/videos/" + encodeURIComponent(videoId)), { headers: authHeaders(provider), signal: ctrl.signal });
        const resultText = await response.text();
        try { last = JSON.parse(resultText); } catch { last = resultText; }
        if (!response.ok) throw new Error("HTTP " + response.status + ": " + String(resultText).slice(0, 500));
        urls = videoUrls(last);
        if (urls.length) return { videos: urls.map((value) => ({ type: "url", value })), raw: last };
        const status = taskStatus(last);
        if (["FAILED", "FAILURE", "ERROR", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED"].includes(status)) throw new Error("Agnes 视频任务失败：" + JSON.stringify(last).slice(0, 500));
        delay = Math.min(Math.round(delay * 1.35), 12000);
      }
      throw new Error("Agnes 视频生成超时，请稍后重试。");
    } catch (error) {
      if (ctrl.signal.aborted) throw new Error("Agnes 视频生成超时，请稍后重试。");
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** agnes.ts:63-65 + 端口失败归一：成功 { images, raw }，失败 { ok:false, error, detail }。 */
  async function generateAgnesImages(provider, model, params, timeoutMs, transport, clockOverride) {
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），Agnes 图片生成不可用");
    const key = resolveApiKey(provider);
    if (!key) return unavailable("未配置 Agnes API Key：请在「集成 · Agnes」保存，或为 provider 提供 api_key");
    const effectiveTimeout = Number.isFinite(timeoutMs) ? Number(timeoutMs) : defaultTimeout;
    try {
      return await runAgnesImage(Object.assign({}, provider, { api_key: key }), model, params, [], effectiveTimeout, net);
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }

  /** agnes.ts:67-69 逐字移植。 */
  async function editAgnesImages(provider, model, params, inputs, timeoutMs, transport, clockOverride) {
    if (!Array.isArray(inputs) || !inputs.length) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "Agnes 图像编辑需要至少一张参考图" };
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），Agnes 图像编辑不可用");
    const key = resolveApiKey(provider);
    if (!key) return unavailable("未配置 Agnes API Key：请在「集成 · Agnes」保存，或为 provider 提供 api_key");
    const effectiveTimeout = Number.isFinite(timeoutMs) ? Number(timeoutMs) : defaultTimeout;
    try {
      return await runAgnesImage(Object.assign({}, provider, { api_key: key }), model, params, inputs, effectiveTimeout, net);
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }

  /** agnes.ts:106-196 的端口包装。 */
  async function generateAgnesVideos(provider, model, params, timeoutMs, transport, clockOverride) {
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），Agnes 视频生成不可用");
    const key = resolveApiKey(provider);
    if (!key) return unavailable("未配置 Agnes API Key：请在「集成 · Agnes」保存，或为 provider 提供 api_key");
    const effectiveTimeout = Number.isFinite(timeoutMs) ? Number(timeoutMs) : defaultTimeout;
    try {
      return await runAgnesVideo(Object.assign({}, provider, { api_key: key }), model, params, effectiveTimeout, net, clockOverride);
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }

  return {
    credentialRef: CREDENTIAL_REF,
    constants: Object.freeze({
      AGNES_GLOBAL_API_BASE_URL,
      AGNES_CHINA_API_BASE_URL,
      AGNES_BASE_URL,
      AGNES_KEY_URL,
      AGNES_IMAGE_MODELS,
      AGNES_VIDEO_MODELS,
    }),
    normalizeAgnesApiBaseUrl,
    endpoint,
    imageResults,
    agnesDimensions,
    agnesFrameCount,
    videoUrls,
    taskStatus,
    resolveApiKey,
    credentialState,
    credentialProbe,
    saveCredential,
    deleteCredential,
    status,
    generateAgnesImages,
    editAgnesImages,
    generateAgnesVideos,
  };
}

module.exports = {
  createAgnesIntegration,
  normalizeAgnesApiBaseUrl,
  endpoint,
  imageResults,
  agnesDimensions,
  agnesFrameCount,
  videoUrls,
  taskStatus,
  AGNES_GLOBAL_API_BASE_URL,
  AGNES_CHINA_API_BASE_URL,
  AGNES_BASE_URL,
  AGNES_KEY_URL,
  AGNES_IMAGE_MODELS,
  AGNES_VIDEO_MODELS,
  CREDENTIAL_REF,
};
