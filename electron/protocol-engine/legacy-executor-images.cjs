"use strict";
/**
 * legacy 执行器 · 图片部分。
 * 忠实移植自 DX OS：server/protocols.ts:4244-5371（阅读源，不执行、不修改）。
 *
 * 逐条对应（源文件:行号）：
 *   parseImagePayload                    protocols.ts:4244
 *   isGptBestAsyncImageProvider          protocols.ts:4299
 *   isApibOpenAiImageProvider            protocols.ts:4306
 *   apibImageAspectRatio                 protocols.ts:4313-4333
 *   apibImageResolution                  protocols.ts:4335
 *   imageTaskErrorDetail                 protocols.ts:4347
 *   openAiImageQuality                   protocols.ts:4358
 *   imageTaskId / imageTaskStatus        protocols.ts:4367 / :4388
 *   pollGptBestImageTask                 protocols.ts:4404
 *   requestZkkiImages                    protocols.ts:4436
 *   requestGrok2ApiImages                protocols.ts:4483
 *   usesGenerationEndpointForImageEdit   protocols.ts:4550
 *   prepareApibEditInputs                protocols.ts:4556-4579
 *   editOpenAiCompatibleGenerationImages protocols.ts:4581
 *   apimartImageConfig                   protocols.ts:4970
 *   apimartImageConfigFromParams         protocols.ts:4988
 *   parseApimartImagePayload             protocols.ts:4998
 *   geminiImageParts                     protocols.ts:5011
 *   isApimartGptImage2                   protocols.ts:5023
 *   apimartImageTaskId / apimartImageTaskView protocols.ts:5027 / :5035
 *   generateApimartAsyncImages           protocols.ts:5043
 *   generateApimartImages                protocols.ts:5150
 *   generateGeminiImages                 protocols.ts:5161
 *   volcengineImageSize                  protocols.ts:5210
 *   generateVolcengineImages             protocols.ts:5230
 *   generateImages / generateImagesUnmetered protocols.ts:5273 / :5283
 *   mediaDataUrl                         protocols.ts:5405
 *   uploadApimartMedia（仅 image 分支，委托 legacy-executor-media.cjs）   protocols.ts:5563-5607
 *
 * 与源实现的差异（均为硬约束要求，非行为漂移）：
 *   1. 所有网络请求统一走 electron/protocol-engine/transport.cjs 的 transport.fetch；
 *      轮询等待走可注入 clock（默认 transport.cjs 的 defaultProtocolClock），
 *      替代源里直接使用的全局 fetch / setTimeout / Date.now。
 *   2. 依赖尚在其它批次、不得做假实现的协议分支返回结构化错误：
 *        { ok:false, error:"LEGACY_DEPENDENCY_UNAVAILABLE", detail:"<属哪个批次>" }
 *      - cli:jimeng / jimeng-cli、cli:codex / codex-cli、cli:gemini / gemini-cli
 *        （protocols.ts:5287-5302）→ B7e2 后续：CLI 端口已注入则调用，未注入即结构化拒绝
 *        （electron/legacy-cli-ports.cjs）
 *      - agnes（protocols.ts:5303）→ B7e3 端口（electron/plugin-agnes.cjs）；插件关闭 / 未注入端口即结构化拒绝
 *      - modelscope（protocols.ts:5304）→ modelscope 原生适配批次（B7e2 端口）
 *      - runninghub（protocols.ts:5306）→ runninghub 原生适配批次（B7e2 端口）
 *      - midjourney（protocols.ts:5309）改由 legacy-executor-media.cjs 的 generateMidjourneyImages 接线（W6b）
 *   3. apiQuota 云计费（apiQuota.ts:280 withDirectApiQuota）属云计费批次，尚未移植：
 *      generateImages 不伪造准入/计费，直接执行 unmetered 路径；
 *      接入方需在调用本函数之前自行完成准入与计费。
 *   4. sharp 仅惰性 require（见 loadSharp），且未写入 package.json；
 *      缺失时仅影响「apib.ai 参考图超预算压缩」这一路径，返回结构化错误。
 */

const {
  PROTOCOLS,
  normalizeProtocol,
  normalizeProtocolId,
  joinUrl,
  buildAuthHeaders,
} = require("./legacy-protocols.cjs");
const { defaultProtocolTransport, defaultProtocolClock } = require("./transport.cjs");
const legacyExecutorPorts = require("../legacy-executor-ports.cjs");

const LEGACY_DEPENDENCY_UNAVAILABLE = "LEGACY_DEPENDENCY_UNAVAILABLE";

/** CLI 协议族端口未注入时的结构化拒绝前缀（B7e2 后续；注入/调用见 electron/legacy-cli-ports.cjs）。 */
const CLI_PORT_DETAIL = "CLI 端口未注入（需安装对应 CLI，由主进程经 electron/legacy-cli-ports.cjs 注入 cliJimeng/cliCodex/cliGemini）";

/** 结构化「依赖未移植 / 端口未注入」结果（硬约束 8）。 */
function unavailable(detail) {
  return { ok: false, error: LEGACY_DEPENDENCY_UNAVAILABLE, detail };
}

function resolveTransport(transport) {
  return transport && typeof transport.fetch === "function" ? transport : defaultProtocolTransport;
}

function resolveClock(clock) {
  return clock && typeof clock.now === "function" && typeof clock.sleep === "function"
    ? clock
    : defaultProtocolClock;
}

// 源：protocols.ts:5405
function mediaDataUrl(input) {
  return `data:${input.mime || "application/octet-stream"};base64,${input.buf.toString("base64")}`;
}

// 源：protocols.ts:3415-3420。源用 !PROTOCOLS[normalizeProtocol(key,'')] 判定；
// 此处按冻结接口用 normalizeProtocolId(id,'') 做等价判定（legacy-protocols 不导出 assertRunnableProtocol）。
function assertRunnableProtocol(id, surface) {
  const key = String(id || "").trim().toLowerCase();
  if (!key || key === "midjourney") return;
  const runnable = typeof normalizeProtocolId === "function"
    ? normalizeProtocolId(key, "")
    : normalizeProtocol(key, "");
  if (!runnable) throw new Error(`${surface} 协议「${key}」还在待适配，暂时不能直接调用。`);
}

// ── 响应解析 ─────────────────────────────────────────────────────────

// 源：protocols.ts:4242-4297
function parseImagePayload(payload) {
  const images = [];
  const seenObjects = new Set();
  const seenImages = new Set();

  const pushString = (value, typeHint) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return;
    let type = typeHint;
    let normalized = text;
    if (text.startsWith("data:image/")) {
      const comma = text.indexOf(",");
      if (comma < 0) return;
      type = "b64";
      normalized = text.slice(comma + 1);
    } else if (!type) {
      if (/^https?:\/\//i.test(text)) type = "url";
      else if (text.length >= 128 && /^[A-Za-z0-9+/=_-]+$/.test(text)) type = "b64";
    }
    if (!type || !normalized || seenImages.has(`${type}:${normalized}`)) return;
    seenImages.add(`${type}:${normalized}`);
    images.push({ type, value: normalized });
  };

  const visit = (value, depth, typeHint) => {
    if (depth > 7 || value == null) return;
    if (typeof value === "string") {
      pushString(value, typeHint);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, typeHint);
      return;
    }
    if (typeof value !== "object" || seenObjects.has(value)) return;
    seenObjects.add(value);

    visit(value.url, depth + 1, "url");
    visit(value.b64_json, depth + 1, "b64");
    visit(value.b64, depth + 1, "b64");
    visit(value.image_base64, depth + 1, "b64");
    if (typeof value.image === "string") pushString(value.image);
    if (typeof value.image_url === "string") pushString(value.image_url, "url");
    else if (value.image_url && value.image_url.url) visit(value.image_url.url, depth + 1, "url");

    for (const key of ["data", "images", "image", "result", "output", "response"]) {
      const nested = value[key];
      if (nested !== value) visit(nested, depth + 1);
    }
  };

  visit(payload, 0);
  return images;
}

// ── 供应商判定 ───────────────────────────────────────────────────────

// 源：protocols.ts:4299
function isGptBestAsyncImageProvider(provider) {
  try {
    const host = new URL(provider.base_url).hostname.toLowerCase();
    return host === "fhl.mom" || host.endsWith(".fhl.mom") || host === "gpt-best.apifox.cn";
  } catch {
    return false;
  }
}

// 源：protocols.ts:4306
function isApibOpenAiImageProvider(provider) {
  try {
    const host = new URL(provider.base_url).hostname.toLowerCase();
    return host === "apib.ai" || host.endsWith(".apib.ai");
  } catch {
    return false;
  }
}

// ── apib.ai 尺寸/分辨率映射 ──────────────────────────────────────────

// 源：protocols.ts:4313
const APIB_IMAGE_ASPECT_RATIOS = ["16:9", "1:1", "21:9", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16"];

// 源：protocols.ts:4315-4333
function apibImageAspectRatio(value) {
  const raw = String(value || "").trim().toLowerCase().replace("*", "x");
  if (!raw || raw === "auto" || raw === "adaptive") return "auto";
  if (APIB_IMAGE_ASPECT_RATIOS.includes(raw)) return raw;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(?:x|:)\s*(\d+(?:\.\d+)?)$/);
  if (!match) return raw;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return raw;
  const requested = width / height;
  return APIB_IMAGE_ASPECT_RATIOS.reduce((best, candidate) => {
    const [candidateWidth, candidateHeight] = candidate.split(":").map(Number);
    const [bestWidth, bestHeight] = best.split(":").map(Number);
    const candidateDistance = Math.abs(Math.log(requested / (candidateWidth / candidateHeight)));
    const bestDistance = Math.abs(Math.log(requested / (bestWidth / bestHeight)));
    return candidateDistance < bestDistance ? candidate : best;
  });
}

// 源：protocols.ts:4335-4345
function apibImageResolution(value, explicit) {
  const requested = String(explicit || "").trim().toLowerCase();
  if (requested === "1k" || requested === "2k" || requested === "4k") return requested;
  const match = String(value || "").trim().toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) return "1k";
  const width = Number(match[1]);
  const height = Number(match[2]);
  const longEdge = Math.max(width, height);
  const pixels = width * height;
  return longEdge >= 3000 || pixels > 4_500_000 ? "4k" : longEdge >= 1800 || pixels > 1_800_000 ? "2k" : "1k";
}

// 源：protocols.ts:4347
function imageTaskErrorDetail(value, fallback) {
  if (typeof value === "string") return value.trim() || fallback;
  if (value == null) return fallback;
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" ? serialized : fallback;
  } catch {
    return fallback;
  }
}

// 源：protocols.ts:4358
function openAiImageQuality(provider, model, quality) {
  const value = String(quality || "").trim().toLowerCase();
  if (!value || value === "auto") return "";
  const modernQuality = isApibOpenAiImageProvider(provider) || /^gpt-image(?:-|$)/i.test(String(model || "").trim());
  if (modernQuality && (value === "hd" || value === "ultra")) return "high";
  if (modernQuality && value === "standard") return "medium";
  return value;
}

// 源：protocols.ts:4367
function imageTaskId(payload) {
  const queue = [payload];
  const seen = new Set();
  for (let depth = 0; depth < 6 && queue.length; depth += 1) {
    const level = queue.splice(0);
    for (const value of level) {
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      const found = [value.task_id, value.taskId, value.id]
        .map((item) => String(item || "").trim()).find(Boolean);
      if (found) return found;
      for (const key of ["data", "result", "output", "response"]) {
        const nested = value[key];
        if (Array.isArray(nested)) queue.push(...nested);
        else if (nested && typeof nested === "object") queue.push(nested);
      }
    }
  }
  return "";
}

// 源：protocols.ts:4388
function imageTaskStatus(payload) {
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const status = String(value.status || value.task_status || value.taskStatus || "").trim().toUpperCase();
    if (status) return status;
    const data = value.data;
    if (Array.isArray(data)) queue.push(...data);
    else if (data && typeof data === "object") queue.push(data);
  }
  return "";
}

// 源：protocols.ts:4404-4434
async function pollGptBestImageTask(provider, taskId, headers, timeoutMs, transport, clock) {
  const net = resolveTransport(transport);
  const time = resolveClock(clock);
  const deadline = time.now() + Math.max(timeoutMs, 14 * 60_000);
  let lastPayload = null;
  while (time.now() < deadline) {
    await time.sleep(2500);
    const taskPath = isGptBestAsyncImageProvider(provider)
      ? `/v1/images/tasks/${encodeURIComponent(taskId)}`
      : `/v1/tasks/${encodeURIComponent(taskId)}`;
    const response = await net.fetch(joinUrl(provider.base_url, taskPath), {
      headers,
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    try { lastPayload = JSON.parse(text); } catch { lastPayload = text; }
    if (!response.ok) throw new Error(`图片任务查询失败 HTTP ${response.status}: ${text.slice(0, 500)}`);
    const images = parseImagePayload(lastPayload);
    if (images.length) return { images, raw: lastPayload };
    const status = imageTaskStatus(lastPayload);
    if (["FAILURE", "FAILED", "ERROR", "CANCELED", "CANCELLED", "REJECTED"].includes(status)) {
      const node = lastPayload && lastPayload.data && typeof lastPayload.data === "object" ? lastPayload.data : lastPayload;
      const fallback = `图片任务失败（${taskId}）`;
      throw new Error(imageTaskErrorDetail((node && (node.fail_reason || node.error || node.message)), fallback));
    }
  }
  throw new Error(`GPT-Best 图片任务仍在处理中（task_id=${taskId}），请稍后重试。`);
}

// 源：protocols.ts:4436-4481
async function requestZkkiImages(provider, model, params, inputs, timeoutMs, transport) {
  const net = resolveTransport(transport);
  const prompt = String(params.prompt || "").trim();
  if (!prompt) throw new Error("缺少 ZKKI 图片生成提示词");
  const references = inputs.slice(0, 9).map((input) => String(input.publicUrl || mediaDataUrl(input)));
  const requestedSize = String(params.size || "2K");
  const size = ["auto", "1K", "1.5K", "2K"].includes(requestedSize) ? requestedSize : "2K";
  const body = {
    model,
    prompt,
    n: Math.max(1, Math.min(128, Number(params.n) || 1)),
    size,
    response_format: String(params.response_format || "url"),
  };
  const aspectRatio = String(params.aspect_ratio || params.aspectRatio || "").trim();
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (params.quality && params.quality !== "auto") body.quality = params.quality;
  if (references.length) body.image = references;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await net.fetch(joinUrl(provider.base_url, "/v1/images/generations"), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...buildAuthHeaders(PROTOCOLS["zkki-model"], provider.api_key) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    if (!response.ok) throw new Error("HTTP " + response.status + ": " + text.slice(0, 500));
    const images = parseImagePayload(payload);
    if (!images.length) throw new Error("ZKKI 图片接口成功，但没有返回图片");
    return { images, raw: payload };
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("ZKKI 图片生成超时，请重试。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 源：protocols.ts:4483-4548
async function requestGrok2ApiImages(provider, model, params, inputs, timeoutMs, transport) {
  const net = resolveTransport(transport);
  if (inputs.length === 0 && !String(params.prompt || "").trim()) throw new Error("缺少图片生成提示词");
  const def = PROTOCOLS[provider.protocol === "xai" ? "xai" : "grok2api"];
  const endpoint = inputs.length ? "/v1/images/edits" : "/v1/images/generations";
  const fallback = apimartImageConfig(params.size);
  const body = {
    model,
    prompt: String(params.prompt || "").trim(),
    n: Math.max(1, Math.min(provider.protocol === "xai" ? 10 : 4, Number(params.n) || 1)),
    // grok2api 会先把图片归档，再用它配置的 PublicBaseURL 返回媒体地址。
    // 该地址在 Docker / 反向代理部署中经常是容器地址或 127.0.0.1，
    // 因此 DX OS 内部调用固定接收 Base64，避免“后台已生成但取不到结果”。
    response_format: "b64_json",
  };
  const aspectRatio = String(params.aspect_ratio || params.aspectRatio || fallback.aspectRatio || "").trim();
  const resolution = String(params.resolution || params.imageSize || "").trim().toLowerCase();
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution === "1k" || resolution === "2k") body.resolution = resolution;
  if (params.quality && params.quality !== "auto") body.quality = params.quality;
  if (inputs.length) {
    const images = inputs.map((input) => ({ url: String(input.publicUrl || mediaDataUrl(input)) }));
    if (images.length === 1) body.image = images[0];
    else body.images = images;
  }
  const ctrl = new AbortController();
  const effectiveTimeoutMs = Math.max(timeoutMs, 15 * 60_000);
  const timer = setTimeout(() => ctrl.abort(), effectiveTimeoutMs);
  try {
    const resp = await net.fetch(joinUrl(provider.base_url, endpoint), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(def.headers || {}), ...buildAuthHeaders(def, provider.api_key) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let raw;
    try { raw = JSON.parse(text); } catch { raw = text; }
    if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + text.slice(0, 500));
    const images = parseImagePayload(raw).map((image) => {
      if (image.type !== "url") return image;
      try {
        const returned = new URL(image.value);
        const configured = new URL(provider.base_url);
        const marker = "/v1/media/images/";
        const markerAt = returned.pathname.indexOf(marker);
        if (markerAt < 0 || returned.origin === configured.origin) return image;
        const configuredPath = configured.pathname.replace(/\/+$/, "");
        const prefix = configuredPath.endsWith("/v1") ? configuredPath.slice(0, -3) : configuredPath;
        return { type: "url", value: configured.origin + prefix + returned.pathname.slice(markerAt) + returned.search };
      } catch { return image; }
    });
    if (!images.length) throw new Error("Grok2API 图片接口成功，但响应中没有 data[].url 或 data[].b64_json：" + text.slice(0, 500));
    return { images, raw };
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("Grok2API 图片" + (inputs.length ? "编辑" : "生成") + "超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 源：protocols.ts:4550-4554
function usesGenerationEndpointForImageEdit(model) {
  const value = String(model || "").trim().toLowerCase();
  return /(?:^|[-_.])(gemini(?:[-_.].*)?image|nano[-_.]?banana)(?:$|[-_.])/.test(value)
    || (/^gemini[-_.]/.test(value) && /image/.test(value));
}

// ── apib.ai 参考图压缩（sharp 惰性 require） ─────────────────────────

// 源：protocols.ts:4556
const APIB_EDIT_MULTIPART_BUDGET = 620_000;

/** 惰性加载 sharp；未安装返回 null（不写 package.json、不静默安装）。 */
function loadSharp() {
  try {
    return require("sharp");
  } catch {
    return null;
  }
}

// 源：protocols.ts:4558-4579
async function prepareApibEditInputs(inputs) {
  if (!inputs.length) return inputs;
  const perImageBudget = Math.max(72_000, Math.floor(APIB_EDIT_MULTIPART_BUDGET / inputs.length));
  if (inputs.reduce((sum, input) => sum + input.buf.length, 0) <= APIB_EDIT_MULTIPART_BUDGET) return inputs;
  const sharp = loadSharp();
  if (!sharp) {
    return unavailable("sharp 缺失：apib.ai 参考图超预算压缩（protocols.ts:4558 prepareApibEditInputs）无法执行；请安装 sharp 或减少参考图体积");
  }
  return Promise.all(inputs.map(async (input, index) => {
    if (input.buf.length <= perImageBudget) return input;
    const source = sharp(input.buf, { failOn: "none" }).rotate().flatten({ background: "#ffffff" });
    for (const quality of [86, 74, 62, 50, 40]) {
      const data = await source.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
      if (data.length <= perImageBudget) {
        return { ...input, buf: data, mime: "image/jpeg", name: "reference-" + (index + 1) + ".jpg" };
      }
    }
    for (const edge of [2048, 1536, 1280, 1024, 768]) {
      const data = await source.clone().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 68, mozjpeg: true }).toBuffer();
      if (data.length <= perImageBudget || edge === 768) {
        return { ...input, buf: data, mime: "image/jpeg", name: "reference-" + (index + 1) + ".jpg" };
      }
    }
    return input;
  }));
}

// 源：protocols.ts:4581-4637
async function editOpenAiCompatibleGenerationImages(provider, model, params, inputs, timeoutMs, transport, clock) {
  const net = resolveTransport(transport);
  const useApibOpenAiCompatibility = isApibOpenAiImageProvider(provider);
  const outboundInputs = useApibOpenAiCompatibility ? await prepareApibEditInputs(inputs.slice(0, 9)) : inputs.slice(0, 9);
  if (!Array.isArray(outboundInputs)) return outboundInputs;
  const references = outboundInputs.map((input) => String(input.publicUrl || mediaDataUrl(input)));
  const body = {
    model,
    prompt: String(params.prompt || "").trim(),
    n: Math.max(1, Math.min(4, Number(params.n) || 1)),
  };
  if (useApibOpenAiCompatibility) {
    body.size = apibImageAspectRatio(params.size);
    body.resolution = apibImageResolution(params.size, params.resolution || params.imageSize);
    body.official_fallback = false;
    body.image_urls = references;
  } else {
    body.image = references;
    if (params.size && params.size !== "auto") body.size = params.size;
  }
  const aspectRatio = String(params.aspect_ratio || params.aspectRatio || "").trim();
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  const quality = openAiImageQuality(provider, model, params.quality);
  if (quality) body.quality = quality;
  if (params.response_format) body.response_format = params.response_format;
  const useAsync = isGptBestAsyncImageProvider(provider);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...buildAuthHeaders(PROTOCOLS.openai, provider.api_key),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await net.fetch(joinUrl(provider.base_url, "/v1/images/generations" + (useAsync ? "?async=true" : "")), {
      method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    if (!response.ok) throw new Error("HTTP " + response.status + ": " + text.slice(0, 500));
    const images = parseImagePayload(payload);
    if (images.length) return { images, raw: payload };
    const taskId = imageTaskId(payload);
    if (taskId) return pollGptBestImageTask(provider, taskId, headers, timeoutMs, net, clock);
    throw new Error("图像接口调用成功，但响应中没有图片：" + text.slice(0, 500));
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("兼容图片编辑请求超时，请重试。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ── APIMart 图片 ─────────────────────────────────────────────────────

// 源：protocols.ts:4970-4986
function apimartImageConfig(size) {
  const raw = String(size || "").trim().toLowerCase().replace("*", "x");
  const match = raw.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) {
    const ratio = raw.match(/^(\d+)\s*:\s*(\d+)$/);
    return { aspectRatio: ratio ? ratio[1] + ":" + ratio[2] : "1:1", imageSize: raw === "4k" ? "4K" : raw === "2k" ? "2K" : "1K" };
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  let a = width;
  let b = height;
  while (b) [a, b] = [b, a % b];
  const edge = Math.max(width, height);
  const pixels = width * height;
  const imageSize = edge >= 2800 || pixels >= 7_000_000 ? "4K" : edge >= 1600 || pixels >= 2_000_000 ? "2K" : "1K";
  return { aspectRatio: Math.round(width / a) + ":" + Math.round(height / a), imageSize };
}

// 源：protocols.ts:4988-4996
function apimartImageConfigFromParams(params) {
  const fallback = apimartImageConfig(params.size);
  const rawImageSize = String(params.resolution || params.imageSize || fallback.imageSize).trim();
  const knownImageSize = rawImageSize.match(/^([124])k$/i);
  return {
    aspectRatio: String(params.aspect_ratio || params.aspectRatio || fallback.aspectRatio),
    imageSize: knownImageSize ? knownImageSize[1] + "K" : rawImageSize,
  };
}

// 源：protocols.ts:4998-5009
function parseApimartImagePayload(payload) {
  const root = payload && payload.candidates ? payload : payload && payload.data && payload.data.candidates ? payload.data : payload;
  const images = [];
  for (const candidate of (root && root.candidates) || []) {
    for (const part of (candidate && candidate.content && candidate.content.parts) || []) {
      const inline = part && (part.inlineData || part.inline_data);
      if (inline && inline.data) images.push({ type: "b64", value: String(inline.data) });
      else if (part && part.image_url && part.image_url.url) images.push({ type: "url", value: String(part.image_url.url) });
    }
  }
  return images;
}

// 源：protocols.ts:5011-5021
function geminiImageParts(prompt, inputs) {
  return [
    ...(inputs || []).map((input) => ({
      inlineData: {
        mimeType: input.mime || "image/png",
        data: input.buf.toString("base64"),
      },
    })),
    { text: String(prompt || "").trim() },
  ];
}

// 源：protocols.ts:5023-5025
function isApimartGptImage2(model) {
  return /^gpt-image-2(?:$|[-._/])/i.test(String(model || "").replace(/^models\//, "").trim());
}

// 源：protocols.ts:5027-5033
function apimartImageTaskId(payload) {
  const roots = [payload, payload && payload.data, payload && payload.result, payload && payload.output]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => value && typeof value === "object");
  return roots.flatMap((value) => [value.task_id, value.taskId, value.submit_id, value.id])
    .map((value) => String(value || "").trim()).find(Boolean) || "";
}

// 源：protocols.ts:5035-5041
function apimartImageTaskView(payload) {
  const data = Array.isArray(payload && payload.data) ? payload.data[0] : payload && payload.data;
  const node = data && typeof data === "object" ? data : payload;
  const status = String((node && (node.status || node.task_status)) || (payload && payload.status) || "").trim().toUpperCase();
  const error = String((node && (node.fail_reason || (node.error && node.error.message) || node.error || node.message)) || (payload && payload.message) || "").trim();
  return { status, error };
}

// 源：protocols.ts:5043-5148
async function generateApimartAsyncImages(provider, model, params, timeoutMs, inputs, transport, clock) {
  const net = resolveTransport(transport);
  const time = resolveClock(clock);
  const def = PROTOCOLS.apimart;
  const base = String(provider.base_url || "").replace(/\/+$/, "").replace(/\/v1(?:beta)?$/i, "");
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(def.headers || {}),
    ...buildAuthHeaders(def, provider.api_key),
  };
  const config = apimartImageConfigFromParams(params);
  const modelName = String(model || "").replace(/^models\//, "");
  const isGptImage2 = isApimartGptImage2(modelName);
  const isSeedream5Pro = /^(?:doubao-)?seedream-5[.-]0-(?:pro|flash)/i.test(modelName);
  const isGrokImage = /^grok-imagine-(?:image|2\.0-ext|1\.5-(?:apimart|ext))/i.test(modelName);
  const isGrokExt = modelName === "grok-imagine-2.0-ext";
  const isGrok15 = modelName.startsWith("grok-imagine-1.5-");
  if (isGrokExt && inputs.length) throw new Error("APIMart Grok 2.0 Ext 不支持参考图，请使用 grok-imagine-image-2.0。");
  if (isGrokImage && inputs.length > (modelName === "grok-imagine-image-2.0" || modelName === "grok-imagine-image-quality" ? 3 : 5)) throw new Error("APIMart Grok 参考图片数量超出当前模型限制。");
  if (isGrokImage && !isGrokExt && !isGrok15 && !["1K", "2K"].includes(config.imageSize.toUpperCase())) throw new Error("APIMart Grok 图片仅支持 1K 或 2K 分辨率。");
  const isGeminiLite = /^(?:gemini-3\.1-flash-lite-image|nano-banana-2-lite)/i.test(modelName);
  const body = {
    model: modelName,
    prompt: String(params.prompt || "").trim(),
    n: Math.max(1, Math.min(4, Math.round(Number(params.n) || 1))),
    size: config.aspectRatio,
    resolution: isGeminiLite ? "1K" : isGptImage2 ? config.imageSize.toLowerCase() : config.imageSize.toUpperCase(),
    ...(isGptImage2 ? { official_fallback: params.official_fallback === true } : params.official_fallback !== undefined ? { official_fallback: params.official_fallback } : {}),
    ...(params.nsfw_check ? { nsfw_check: true } : {}),
    ...(!isGeminiLite && params.google_search ? { google_search: true } : {}),
    ...(!isGeminiLite && params.google_image_search ? { google_image_search: true } : {}),
    ...(params.webhook ? { webhook: params.webhook } : {}),
  };
  if (inputs.length) {
    // 上传实现统一委托 legacy-executor-media.cjs（惰性 require 打破环），避免两份漂移。
    const { uploadApimartMedia } = require("./legacy-executor-media.cjs");
    const imageUrls = [];
    for (const input of inputs.slice(0, isGptImage2 ? 15 : 14)) {
      imageUrls.push(await uploadApimartMedia(provider, { ...input, kind: "image" }, timeoutMs, net));
    }
    body.image_urls = imageUrls;
  }

  if (isSeedream5Pro) {
    body.size = params.size || config.aspectRatio;
    body.n = 1;
    for (const key of ["official_fallback", "google_search", "google_image_search"]) delete body[key];
  }
  if (isGrokImage) {
    for (const key of ["quality", "size", "official_fallback", "google_search", "google_image_search"]) delete body[key];
    body.n = Math.max(1, Math.min(isGrokExt ? 12 : 10, Math.round(Number(params.n) || 1)));
    body[isGrokExt || isGrok15 ? "size" : "aspect_ratio"] = config.aspectRatio;
    body.resolution = isGrokExt ? "quality" : config.imageSize.toLowerCase();
    if (isGrok15) delete body.resolution;
    if (isGrokExt) body.response_format = "url";
    if (modelName === "grok-imagine-image-2.0" && !inputs.length) body.quality = params.quality === "low" ? "low" : "medium";
    headers["X-APIMart-Response-Version"] = "2026-07-27";
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const deadline = time.now() + timeoutMs;
  let lastPayload = null;
  const request = async (url, init) => {
    const response = await net.fetch(url, { ...init, signal: ctrl.signal });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    if (!response.ok) throw new Error("HTTP " + response.status + ": " + (typeof payload === "string" ? payload.slice(0, 500) : JSON.stringify(payload).slice(0, 500)));
    return payload;
  };

  try {
    lastPayload = await request(joinUrl(base, "/v1/images/generations"), { method: "POST", headers, body: JSON.stringify(body) });
    const immediate = parseImagePayload(lastPayload);
    if (immediate.length) return { images: immediate, raw: lastPayload };
    const taskId = apimartImageTaskId(lastPayload);
    if (!taskId) throw new Error("APIMart 图片接口未返回图片或任务 ID：" + JSON.stringify(lastPayload).slice(0, 500));

    const initialDelay = Math.min(10_000, Math.max(25, Math.floor(timeoutMs / 10)));
    const pollInterval = Math.min(5_000, Math.max(25, Math.floor(timeoutMs / 20)));
    await time.sleep(initialDelay);
    while (time.now() < deadline && !ctrl.signal.aborted) {
      lastPayload = await request(joinUrl(base, "/v1/tasks/" + encodeURIComponent(taskId)), { headers: { Accept: "application/json", ...buildAuthHeaders(def, provider.api_key) } });
      const images = parseImagePayload(lastPayload);
      const view = apimartImageTaskView(lastPayload);
      if (images.length && (!view.status || ["SUCCESS", "SUCCESSFUL", "SUCCEED", "SUCCEEDED", "COMPLETED", "COMPLETE", "DONE", "FINISHED", "OK", "READY"].includes(view.status))) {
        return { images, raw: lastPayload };
      }
      if (["FAILURE", "FAILED", "FAIL", "ERROR", "ERRORED", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED", "EXPIRED"].includes(view.status)) {
        throw new Error("APIMart 图片任务失败：" + (view.error || view.status));
      }
      await time.sleep(Math.min(pollInterval, Math.max(0, deadline - time.now())));
    }
    throw new Error("APIMart 图片任务本地等待已结束，远程任务 " + taskId + " 可能仍在处理中，请勿重复提交。");
  } catch (error) {
    if (ctrl.signal.aborted) throw new Error("APIMart 图片任务本地等待已结束；远程任务可能仍在处理中，请勿重复提交。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 源：protocols.ts:5150-5159
async function generateApimartImages(provider, model, params, timeoutMs, inputs, transport, clock) {
  return generateApimartAsyncImages(provider, model, params, timeoutMs, inputs || [], transport, clock);
}

// 源：protocols.ts:5161-5206
async function generateGeminiImages(provider, model, params, timeoutMs, inputs, transport) {
  const net = resolveTransport(transport);
  const def = PROTOCOLS.gemini;
  const modelName = String(model || "").replace(/^models\//, "");
  const url = joinUrl(provider.base_url, "/v1beta/models/" + encodeURIComponent(modelName) + ":generateContent");
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(def.headers || {}),
    ...buildAuthHeaders(def, provider.api_key),
  };
  const body = {
    contents: [{ role: "user", parts: geminiImageParts(String(params.prompt || ""), inputs || []) }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: apimartImageConfigFromParams(params),
    },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await net.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await resp.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    if (!resp.ok) {
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
      throw new Error("HTTP " + resp.status + ": " + detail.slice(0, 500));
    }
    return { images: parseApimartImagePayload(payload), raw: payload };
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error("Gemini 图像生成超时，请重试或换更快的模型。");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 源：protocols.ts:5208-5228
const VOLCENGINE_IMAGE_RATIOS = [[1, 1], [16, 9], [9, 16], [4, 3], [3, 4], [3, 2], [2, 3], [21, 9], [9, 21], [5, 4], [4, 5]];

function volcengineImageSize(size, model) {
  const raw = String(size || "").trim().toLowerCase().replace("*", "x");
  const match = raw.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) return raw === "4k" ? "4096x4096" : raw === "2k" || /seedream/i.test(model || "") ? "2048x2048" : raw || "1024x1024";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!/seedream/i.test(model || "")) return width + "x" + height;
  const ratio = width / Math.max(1, height);
  const [rw, rh] = [...VOLCENGINE_IMAGE_RATIOS].sort((a, b) => Math.abs(ratio - a[0] / a[1]) - Math.abs(ratio - b[0] / b[1]))[0];
  const scale = Math.max(Math.sqrt(3_686_400 / (rw * rh)), 1536 / Math.min(rw, rh));
  const cap = Math.min(1, 4096 / Math.max(rw * scale, rh * scale));
  let targetWidth = Math.max(64, Math.floor(rw * scale * cap / 16) * 16);
  let targetHeight = Math.max(64, Math.floor(rh * scale * cap / 16) * 16);
  while (targetWidth * targetHeight < 3_686_400 && Math.max(targetWidth, targetHeight) <= 4096) {
    if (targetWidth <= targetHeight) targetWidth += 16;
    else targetHeight += 16;
  }
  return targetWidth + "x" + targetHeight;
}

// 源：protocols.ts:5230-5271
async function generateVolcengineImages(provider, model, params, inputs, timeoutMs, transport) {
  const net = resolveTransport(transport);
  const prompt = String(params.prompt || "").trim();
  if (!prompt) throw new Error("缺少图片提示词");
  if (!String(model || "").trim()) throw new Error("缺少 Seedream 图片模型");
  const def = PROTOCOLS.volcengine;
  const url = joinUrl(provider.base_url, "/api/v3/images/generations");
  const body = {
    model,
    prompt,
    size: volcengineImageSize(params.size, model),
    response_format: params.response_format || "url",
  };
  if ((inputs || []).length) body.image = inputs.slice(0, 9).map((input) => input.publicUrl || mediaDataUrl(input));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await net.fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...buildAuthHeaders(def, provider.api_key) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    if (!resp.ok) throw new Error("火山方舟图片接口 HTTP " + resp.status + ": " + text.slice(0, 500));
    const images = parseImagePayload(payload);
    if (!images.length) throw new Error("火山方舟图片接口未返回图片：" + text.slice(0, 500));
    return { images, raw: payload };
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error("火山方舟图片生成超时，请稍后重试。");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 源：protocols.ts:5273-5281（源用 withDirectApiQuota 包 unmetered；见文件头第 3 条）
async function generateImages(provider, model, params, timeoutMs, transport, clock) {
  return generateImagesUnmetered(provider, model, params, timeoutMs === undefined ? 300000 : timeoutMs, transport, clock);
}

// 源：protocols.ts:5283-5365
async function generateImagesUnmetered(provider, model, params, timeoutMs, transport, clock) {
  const net = resolveTransport(transport);
  const rawProto = String(provider.protocol || "").trim().toLowerCase();
  // B7e2 后续：CLI 协议族端口（electron/legacy-cli-ports.cjs）已注入则调用，未注入仍结构化拒绝。
  if (rawProto === "cli:jimeng" || rawProto === "jimeng-cli") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("cliJimeng");
    if (typeof port === "function") return port("image.generate", { provider, model, params, timeoutMs, transport: net, clock });
    return unavailable(CLI_PORT_DETAIL + "：cli:jimeng 图片执行器（protocols.ts:5287 generateJimengImage）");
  }
  if (rawProto === "cli:codex" || rawProto === "codex-cli") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("cliCodex");
    if (typeof port === "function") return port("image.generate", { provider, model, params, timeoutMs, transport: net, clock });
    return unavailable(CLI_PORT_DETAIL + "：cli:codex 图片执行器（protocols.ts:5295 generateCodexImage）");
  }
  if (rawProto === "cli:gemini" || rawProto === "gemini-cli") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("cliGemini");
    if (typeof port === "function") return port("image.generate", { provider, model, params, timeoutMs, transport: net, clock });
    return unavailable(CLI_PORT_DETAIL + "：cli:gemini 图片执行器（protocols.ts:5299 generateGeminiCliImage）");
  }
  // B7e2：端口已注入则调用注入实现；未注入仍返回结构化 LEGACY_DEPENDENCY_UNAVAILABLE（B2 行为不变）。
  if (rawProto === "agnes") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("generateAgnesImages");
    if (typeof port === "function") return port(provider, model, params, timeoutMs, net, clock);
    return unavailable("agnes 原生适配批次：generateAgnesImages（protocols.ts:5303）未移植");
  }
  if (rawProto === "modelscope") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("generateModelScopeImages");
    if (typeof port === "function") return port(provider, model, params, timeoutMs, net, clock);
    return unavailable("modelscope 原生适配批次：generateModelScopeImages（protocols.ts:5304）未移植");
  }
  if (rawProto === "volcengine") return generateVolcengineImages(provider, model, params, [], timeoutMs, net);
  if (rawProto === "runninghub") {
    const port = legacyExecutorPorts.getLegacyExecutorPort("generateRunningHubImages");
    if (typeof port === "function") return port(provider, model, params, timeoutMs, net, clock);
    return unavailable("runninghub 原生适配批次：generateRunningHubImages（protocols.ts:5306）未移植");
  }
  if (rawProto === "xai" || rawProto === "grok2api") return requestGrok2ApiImages(provider, model, params, [], timeoutMs, net);
  if (rawProto === "zkki" || rawProto === "zkki-model") return requestZkkiImages(provider, model, params, [], timeoutMs, net);
  if (rawProto === "midjourney") {
    // media 顶层 require 本文件，必须惰性 require 打破环（源：protocols.ts:5309）。
    const { generateMidjourneyImages } = require("./legacy-executor-media.cjs");
    return generateMidjourneyImages(provider, model, params, timeoutMs, [], { transport: net, clock });
  }
  assertRunnableProtocol(rawProto, "图像生成");
  const proto = normalizeProtocol(provider.protocol);
  const useApibOpenAiCompatibility = isApibOpenAiImageProvider(provider);
  if ((proto === "apimart" || proto === "apimart-gemini" || proto === "apimart-media") && !useApibOpenAiCompatibility) return generateApimartImages(provider, model, params, timeoutMs, [], net, clock);
  if (proto === "gemini") return generateGeminiImages(provider, model, params, timeoutMs, [], net);
  if (proto !== "openai" && !useApibOpenAiCompatibility) {
    throw new Error("图像生成目前只支持 OpenAI 兼容站点，请在「API 设置」里用 openai 协议添加图像模型站点。");
  }
  const def = PROTOCOLS.openai;
  const useGptBestAsync = isGptBestAsyncImageProvider(provider);
  const url = joinUrl(provider.base_url, "/v1/images/generations" + (useGptBestAsync ? "?async=true" : ""));
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(def.headers || {}),
    ...buildAuthHeaders(def, provider.api_key),
  };
  const body = { model, prompt: String(params.prompt || "").trim() };
  if (useApibOpenAiCompatibility) {
    body.size = apibImageAspectRatio(params.size);
    body.resolution = apibImageResolution(params.size, params.resolution || params.imageSize);
    body.official_fallback = false;
  }
  else if (params.size && params.size !== "auto") body.size = params.size;
  const quality = openAiImageQuality(provider, model, params.quality);
  if (quality) body.quality = quality;
  if (params.n) body.n = Math.max(1, Math.min(4, Number(params.n) || 1));
  if (params.response_format) body.response_format = params.response_format;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await net.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await resp.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    if (!resp.ok) {
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
      throw new Error("HTTP " + resp.status + ": " + detail.slice(0, 500));
    }
    const images = parseImagePayload(payload);
    if (images.length) return { images, raw: payload };
    const taskId = imageTaskId(payload);
    if (taskId) return pollGptBestImageTask(provider, taskId, headers, timeoutMs, net, clock);
    return { images: [], raw: payload };
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error("图像生成超时，请重试或换更快的模型。");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  // 任务书要求导出
  generateImages,
  editOpenAiCompatibleGenerationImages,
  generateApimartImages,
  generateGeminiImages,
  generateVolcengineImages,
  volcengineImageSize,
  parseImagePayload,
  parseApimartImagePayload,
  // 同文件内其它可复用件（供接入方与测试使用）
  generateImagesUnmetered,
  requestZkkiImages,
  requestGrok2ApiImages,
  apimartImageConfig,
  apimartImageConfigFromParams,
  apimartImageTaskId,
  apimartImageTaskView,
  isApimartGptImage2,
  geminiImageParts,
  apibImageAspectRatio,
  apibImageResolution,
  isGptBestAsyncImageProvider,
  isApibOpenAiImageProvider,
  openAiImageQuality,
  imageTaskId,
  imageTaskStatus,
  usesGenerationEndpointForImageEdit,
  prepareApibEditInputs,
  LEGACY_DEPENDENCY_UNAVAILABLE,
};
