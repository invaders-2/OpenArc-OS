/**
 * Lovart OpenAPI（OpenClaw / Agent Skill）官方协议适配器。
 *
 * 为什么单独一层：Lovart 的 wire 形状与既有两个协议族都不同 —— 鉴权既不是 Bearer 也不是
 * 固定头，而是 AK/SK 的 HMAC-SHA256 请求签名；生成不是一次 POST 就返回结果，而是
 * send → watch（轮询）→ result 三段式。把它塞进 OpenAI 兼容适配器会同时污染错误归一与
 * 轮询语义；因此与 provider-adapter-anthropic.cjs 同构：独立 wire 层，由
 * provider-adapter.cjs#adapterFor / #lovartFor 分发。
 *
 * 协议事实逐行核对自官方仓库 lovartai/lovart-skill（MIT）：
 *   · skills/lovart-skill/scripts/agent_skill.py:80-93    _sign（HMAC 与 5 个签名头）
 *   · …/agent_skill.py:95-148  _request（{code,message,data} 信封、重试策略、重签）
 *   · …/agent_skill.py:331     POST {prefix}/chat（send → thread_id）
 *   · …/agent_skill.py:333-337 GET {prefix}/chat/status | {prefix}/chat/result
 *   · …/agent_skill.py:152-186 project/save | project/validate | mode/*
 *   · …/agent_skill.py:285-331 send 的 body（project_id / attachments / mode / tool_config）
 *   · …/agent_skill.py:246-281 结果形状 items[].artifacts[].content / .type
 *   · …/agent_skill.py:453-497 items[].text（纯文本回复）与 failures[]
 *   · scripts/sync_models.py:115-129  catalog = { data: { tools: [...] } }
 *   · scripts/sync_models.py:39/157-162 category = IMAGE | VIDEO | 3D；name / display_name / is_premium
 *   · scripts/sync_models.py:35  CATALOG_URL = https://lgw.lovart.ai/v1/openapi/tools/catalog
 * 环境默认 base：agent_skill.py:662  LOVART_BASE_URL = https://lgw.lovart.ai。
 *
 * 密钥纪律：AK/SK 以一个 JSON 字符串（{"accessKey":"…","secretKey":"…"}）经既有
 * credential/set 存进 safeStorage；本层只解析、只在进程内用于签名。任何错误 detail 都不
 * 回显明文；parseCredential 的失败原因只报「缺哪个字段」。
 *
 * 与官方 skill 的偏差（逐条理由见 artifacts/dxos-lovart-protocol/REPORT.md；
 * 真实联网复验证据见 artifacts/dxos-lovart-live/REPORT.md）：
 *   1) **不做任何自动重试**。官方 _request 对 404/429/502/503 重试，并把 404 当"路由可能
 *      暂时不对"；404 只会是路径写错，重试会把它掩盖成"慢"。
 *   2) 轮询有**硬上限**（maxPolls / 截止时间）并可被 AbortSignal 取消，绝不无限挂定时器。
 *   3) 产物下载做**主机白名单**：只允许与 provider 同源，或 lgw.lovart.ai / a.lovart.ai。
 *      2026-10-17 真实联网观察到产物 CDN 主机就是 a.lovart.ai（实证见白名单常量注释）；
 *      仍未观察到的主机一律拒绝，绝不静默放行。
 *   4) HTTPS only（回环地址的 http 仅供本地 mock / 单测）。
 *   5) 真站 GET /tools/catalog 是**公开**路由，不能验凭据；model/test 改用签名 POST
 *      /mode/query 探测（见 probeCredential）。
 */
"use strict";

const crypto = require("node:crypto");
const modelDomain = require("./model-domain.cjs");
const imageParams = require("./image-params.cjs");

const ADAPTER_TYPE = "lovart";
const DEFAULT_BASE_URL = "https://lgw.lovart.ai";
const API_PREFIX = "/v1/openapi";
const REQUEST_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) OpenArc-Lovart/1.0";
const MAX_CATALOG_ITEMS = 500;

/** base 环境 / 路径前缀写成常量，避免散落的魔法字符串。 */
const ENDPOINTS = Object.freeze({
  catalog: API_PREFIX + "/tools/catalog",
  projectSave: API_PREFIX + "/project/save",
  projectValidate: API_PREFIX + "/project/validate",
  chat: API_PREFIX + "/chat",
  chatStatus: API_PREFIX + "/chat/status",
  chatResult: API_PREFIX + "/chat/result",
  chatConfirm: API_PREFIX + "/chat/confirm",
  modeSet: API_PREFIX + "/mode/set",
  modeQuery: API_PREFIX + "/mode/query",
  fileUpload: API_PREFIX + "/file/upload",
  artifactUpload: API_PREFIX + "/artifact/upload",
});

/**
 * 能力口径映射：catalog 的 category → 本仓 D4-01 capability。
 * 本仓能力枚举只有 chat / tool-calling / vision-input / image-generation /
 * video-generation / embedding（model-domain.cjs:8）。3D 与音频**没有**对应能力，
 * 如实标注为空数组（不硬塞），由调用方决定是否作为"该服务商枚举不了"的已知限制呈现。
 */
const CATEGORY_CAPABILITIES = Object.freeze({
  IMAGE: Object.freeze(["image-generation"]),
  VIDEO: Object.freeze(["video-generation"]),
  "3D": Object.freeze([]),
  AUDIO: Object.freeze([]),
  CHAT: Object.freeze(["chat"]),
  TEXT: Object.freeze(["chat"]),
  LLM: Object.freeze(["chat"]),
  VISION: Object.freeze(["vision-input"]),
});

/** 本仓能力枚举覆盖不到的 catalog 分类（如实标注，不硬塞）。 */
const UNSUPPORTED_CATEGORIES = Object.freeze(["3D", "AUDIO"]);

/**
 * 产物主机白名单。lgw.lovart.ai 是官方 skill 确认过的 Lovart API 主机
 * （CATALOG_URL，sync_models.py:35）；此外永远允许与 provider 同源的产物。
 *
 * a.lovart.ai 由 2026-10-17 真实联网复验观察到（原先「产物 CDN 主机未观察到、
 * 一律拒绝」的已知限制据此解除）：
 *   · 真实 chat/result 的 items[1].artifacts[0].content =
 *     https://a.lovart.ai/artifacts/agent/rzu0ZnLyMgGCLqa8.png
 *     （证据 artifacts/lovart-live/chat-result.json）
 *   · 经代理 http://127.0.0.1:7897 下载该 URL → HTTP 200，1,722,031 字节，
 *     PNG 魔数 89504e470d0a1a0a，真实像素 1254×1254，
 *     sha256 94662303309ac17dfb20dd87fad6cbc4aafe2c2057f486e1efbb4d47482ec7a5
 *     （证据 artifacts/lovart-live/lovart-real-apple.png、artifacts/dxos-lovart-live/REPORT.md）
 * 仍未观察到的主机（任何第三方 CDN）保持拒绝，绝不静默放行。
 */
const ARTIFACT_HOST_ALLOWLIST = Object.freeze(["lgw.lovart.ai", "a.lovart.ai"]);
/** 已观察 / 可查证的 Lovart 主机；未列出的 CDN 主机保持拒绝。 */
const OBSERVED_HOSTS = Object.freeze(["lgw.lovart.ai", "a.lovart.ai"]);

function isLoopbackHostname(value) {
  const host = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** 传输守门：远程只允许 https；http 只允许回环（本地 mock / 单测）。 */
function assertTransportAllowed(url) {
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url;
  const error = new Error("lovart-requires-https");
  error.name = "LovartTransportError";
  error.errorCode = modelDomain.ERROR_CODE.ENDPOINT_BLOCKED;
  throw error;
}

/** base 已带 /v1/openapi 时不重复叠加（用户直接填 catalog 前缀也成立）。 */
function resolveUrl(baseUrl, path) {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const suffix = String(path || "");
  if (/\/v1\/openapi$/i.test(base) && suffix.toLowerCase().startsWith(API_PREFIX + "/")) {
    return base + suffix.slice(API_PREFIX.length);
  }
  return base + suffix;
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(resolveUrl(baseUrl, path));
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

/** 解析凭据 JSON。任何失败原因都不回显明文，只回「缺哪个字段」。 */
function parseCredential(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return { ok: false, error: modelDomain.ERROR_CODE.CREDENTIAL_MISSING, detail: "lovart-credential-missing" };
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "lovart-credential-not-json" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "lovart-credential-not-object" };
  }
  const accessKey = typeof parsed.accessKey === "string" ? parsed.accessKey.trim() : "";
  const secretKey = typeof parsed.secretKey === "string" ? parsed.secretKey.trim() : "";
  if (!accessKey) return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "lovart-credential-missing-accessKey" };
  if (!secretKey) return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "lovart-credential-missing-secretKey" };
  return { ok: true, accessKey, secretKey };
}

/** 反向：把两把密钥组合成既有 credential/set 能承载的**单个** secret 字符串。 */
function serializeCredential({ accessKey, secretKey } = {}) {
  return JSON.stringify({ accessKey: String(accessKey == null ? "" : accessKey), secretKey: String(secretKey == null ? "" : secretKey) });
}

/**
 * 官方 _sign（agent_skill.py:80-86）逐字等价：
 *   signature = HMAC_SHA256(secret_key, METHOD + "\n" + path + "\n" + timestamp秒) 的十六进制。
 * timestamp 是**秒级** Unix 字符串；每次尝试都必须重新签名（时间新鲜度）。
 */
function signRequest({ secretKey, method, path, timestamp }) {
  const algorithm = String(method || "GET").toUpperCase();
  const signedPath = String(path);
  const ts = String(timestamp == null ? Math.floor(Date.now() / 1000) : timestamp);
  const signature = crypto
    .createHmac("sha256", String(secretKey == null ? "" : secretKey))
    .update(algorithm + "\n" + signedPath + "\n" + ts, "utf8")
    .digest("hex");
  return { timestamp: ts, signature, method: algorithm, path: signedPath };
}

/** 官方 _sign 返回的 5 个头 + Content-Type；POST 由 buildRequest 追加 Idempotency-Key。 */
function authHeaders({ credential, method, path, timestamp } = {}) {
  if (!credential || credential.ok !== true) {
    const error = new Error("lovart-credential-invalid");
    error.name = "LovartCredentialError";
    error.errorCode = modelDomain.ERROR_CODE.CREDENTIAL_MISSING;
    throw error;
  }
  const signed = signRequest({ secretKey: credential.secretKey, method, path, timestamp });
  return {
    "X-Access-Key": credential.accessKey,
    "X-Timestamp": signed.timestamp,
    "X-Signature": signed.signature,
    "X-Signed-Method": signed.method,
    "X-Signed-Path": signed.path,
    "Content-Type": "application/json",
    "User-Agent": REQUEST_USER_AGENT,
  };
}

/** 单次请求描述符（协议引擎 / 测试可复用）；path 不含 query，签名只覆盖 path。 */
function buildRequest({ baseUrl, credential, method = "GET", path, query = null, body, timestamp, idempotencyKey, fetchImpl = fetch } = {}) {
  const url = buildUrl(baseUrl, path, query);
  assertTransportAllowed(url);
  const signedMethod = String(method || "GET").toUpperCase();
  const headers = authHeaders({ credential, method: signedMethod, path });
  if (signedMethod === "POST" && !headers["Idempotency-Key"]) {
    headers["Idempotency-Key"] = idempotencyKey || crypto.randomUUID().replace(/-/g, "");
  }
  return { method: signedMethod, url: url.toString(), headers, ...(body === undefined ? {} : { body }), redirect: "error", fetchImpl };
}

function abortedResult() { return { ok: false, error: modelDomain.ERROR_CODE.CANCELLED, detail: "lovart-cancelled" }; }

/** 可被 AbortSignal 提前唤醒的 sleep；abort 后由调用方立刻检查 signal.aborted。 */
function sleep(ms, signal) {
  const delay = Number(ms);
  if (!Number.isFinite(delay) || delay <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal && signal.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); }, delay);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorFromStatus(status) { return modelDomain.normalizeError({ status }); }

/**
 * 一次 Lovart HTTP 调用：真签名 → fetch → 解 {code,message,data} 信封。
 * 返回 { ok:true, data, body, httpStatus } 或 { ok:false, error, detail?, httpStatus?, kind? }。
 * 错误 detail 只放服务端 message / HTTP 文案，绝不放密钥。
 */
async function request({ baseUrl, credential, method = "GET", path, query = null, body, signal = null, timeoutMs = 30000, fetchImpl = fetch } = {}) {
  if (!credential || credential.ok !== true) return { ok: false, error: modelDomain.ERROR_CODE.CREDENTIAL_MISSING, detail: "lovart-credential-missing" };
  if (signal && signal.aborted) return abortedResult();
  let built;
  try { built = buildRequest({ baseUrl, credential, method, path, query, body }); }
  catch (error) { return { ok: false, error: error.errorCode || modelDomain.ERROR_CODE.ENDPOINT_BLOCKED, detail: String(error.message || error).slice(0, 120) }; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), Math.max(1, Number(timeoutMs) || 30000));
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(built.url, {
      method: built.method,
      headers: built.headers,
      ...(built.body === undefined ? {} : { body: JSON.stringify(built.body) }),
      signal: controller.signal,
      redirect: "error",
    });
    const text = await response.text().catch(() => "");
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok) {
      const message = payload && (payload.message || payload.error) ? String(payload.message || payload.error) : "HTTP " + response.status;
      return { ok: false, error: errorFromStatus(response.status), detail: message.slice(0, 240), httpStatus: response.status };
    }
    if (payload && typeof payload === "object" && payload.code !== undefined && Number(payload.code) !== 0) {
      return { ok: false, error: modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: String(payload.message || "lovart-error").slice(0, 240), lovartCode: Number(payload.code) };
    }
    const data = payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
    return { ok: true, data, body: payload, httpStatus: response.status };
  } catch (error) {
    if (signal && signal.aborted) return abortedResult();
    if (controller.signal.aborted || String((error && error.message) || "").includes("timeout")) {
      return { ok: false, error: modelDomain.ERROR_CODE.MODEL_TIMEOUT, detail: "lovart-request-timeout" };
    }
    return { ok: false, error: modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE, detail: "lovart-network-error" };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/* ─────────────────────────── catalog / 模型清单 ─────────────────────────── */

function capabilitiesForCategory(category) {
  const key = String(category == null ? "" : category).trim().toUpperCase();
  const mapped = CATEGORY_CAPABILITIES[key];
  return mapped ? [...mapped] : [];
}

/** catalog data → tools 数组；兼容官方 data.tools 与若干等价形状（不猜不编造）。 */
function catalogTools(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.tools)) return data.tools;
  if (data.data && typeof data.data === "object" && Array.isArray(data.data.tools)) return data.data.tools;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.models)) return data.models;
  if (Array.isArray(data.list)) return data.list;
  if (Array.isArray(data.categories)) {
    return data.categories.flatMap((group) => {
      if (!group || !Array.isArray(group.tools)) return [];
      const category = group.category || group.name || null;
      return group.tools.map((tool) => (tool && typeof tool === "object" ? { category, ...tool } : tool));
    });
  }
  return [];
}

function mapCatalogItem(raw) {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id, displayName: id, category: null, premium: false, suggestedCapabilities: [] } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.name || raw.id || raw.model || raw.modelId || raw.tool || "").trim();
  if (!id) return null;
  const displayName = String(raw.display_name || raw.displayName || raw.title || raw.label || "").trim() || id;
  const rawCategory = raw.category || raw.type || raw.kind || raw.group || null;
  const category = rawCategory == null ? null : String(rawCategory).trim().toUpperCase() || null;
  const premium = raw.is_premium === true || raw.premium === true || raw.isPremium === true;
  return {
    id,
    displayName,
    category,
    premium,
    suggestedCapabilities: capabilitiesForCategory(category),
    unsupportedCapability: category && UNSUPPORTED_CATEGORIES.includes(category) ? category.toLowerCase() : null,
  };
}

/**
 * 面板规格（uiSpec）：模型族 → 画布面板能选的控件值。
 *
 * Lovart 是**对话式**接口：比例 / 清晰度 / 时长 / 有声都是写进提示词的要求
 * （见 generateVideo 的【生成要求】、model-service 的 SIZE_VIA_PROMPT），不是独立 wire 字段。
 * 这里按 catalog 的 category + 已知模型族给出「面板该显示什么」，前端据此决定控件，
 * 不再按模型名交给 PRESETS 猜（那是「联网 / 风格 / 摄影机」假可用的根源）。
 *
 * 字段口径与 provider-adapter-apimart.cjs#uiSpec 一致：
 *   kind / ratios / sizes / batch / maxRefs / i2i / mask
 *   kind / ratios / res / durs / modes / maxRefs / times / audio
 *   显式布尔：search / style / camera / audio；capabilitiesSource 标明来源。
 *
 * 明确的能力边界（不写就是猜，写了 false 就是这条链路不支持）：
 *   · style / camera：图片族 true —— canvas/modelImage 现在会解析并透传，model-service 会把它们
 *     写进提示词的【画面要求】（generateComplete 也消费 params.style/camera，做同样的事）。
 *   · search：恒 false。图片链路没有联网能力（Lovart 的 catalog 也没有联网入口），不冒充。
 *   · batch 恒 [1]：一次对话只出一个结果，适配器不读取 count。
 *   · 视频 audio 只在文档/族契约本身带音轨的族标 true（见 VIDEO_FAMILIES.audio）。
 *   · maxRefs 取适配器真实上限 8（toAttachments 的 max；generateImageEdit 另加 7 张参考）。
 */
const LOOK_IMAGE_RATIOS = Object.freeze({
  gpt2: ["自适应", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "3:1", "1:3", "21:9", "9:21"],
  gem: ["自适应", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
  gem31: ["自适应", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "5:4", "4:5", "21:9", "1:4", "4:1", "1:8", "8:1"],
  seedream: ["自适应", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "2:1", "1:2", "21:9", "9:21"],
  seed5: ["自适应", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "2:1", "1:2", "21:9"],
  basic7: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"],
});

/** Lovart catalog 的真实 id 形如 generate_image_* / generate_video_*（见 artifacts/lovart-live/tools-catalog.json）。 */
const IMAGE_FAMILIES = Object.freeze([
  { re: /^generate_image_gpt_image_2_5/, ratios: LOOK_IMAGE_RATIOS.gpt2, sizes: ["1K", "2K", "4K"], mask: true },
  { re: /^generate_image_gpt_image_2/, ratios: LOOK_IMAGE_RATIOS.gpt2, sizes: ["1K", "2K", "4K"], mask: true },
  { re: /^generate_image_gpt_image_1_5/, ratios: ["1:1", "3:2", "2:3"], sizes: ["1K"], mask: true },
  { re: /^generate_image_nano_banana_2_1/, ratios: LOOK_IMAGE_RATIOS.gem31, sizes: ["1K", "2K", "4K"] },
  { re: /^generate_image_nano_banana_pro/, ratios: LOOK_IMAGE_RATIOS.gem, sizes: ["1K", "2K", "4K"] },
  { re: /^generate_image_nano_banana_2_lite/, ratios: LOOK_IMAGE_RATIOS.gem, sizes: ["1K"] },
  { re: /^generate_image_nano_banana_2/, ratios: LOOK_IMAGE_RATIOS.gem31, sizes: ["1K", "2K", "4K"] },
  { re: /^generate_image_seedream_v5_pro/, ratios: LOOK_IMAGE_RATIOS.seed5, sizes: ["1K", "1.5K", "2K"] },
  { re: /^generate_image_seedream_v5/, ratios: LOOK_IMAGE_RATIOS.seed5, sizes: ["1K", "2K", "4K"] },
  { re: /^generate_image_seedream_v4_5/, ratios: LOOK_IMAGE_RATIOS.seedream, sizes: ["2K", "4K"] },
  { re: /^generate_image_seedream_v4/, ratios: LOOK_IMAGE_RATIOS.seedream, sizes: ["1K", "2K", "4K"] },
  { re: /^generate_image_luma_uni_1/, ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"], sizes: ["1K", "2K"] },
  { re: /^generate_image_flux_2/, ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"], sizes: ["1K", "2K"] },
  { re: /^generate_image_midjourney/, ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "2:3", "3:2"], sizes: ["2K"] },
  { re: /^generate_image_(ideogram_v4|p_image_ideogram)/, ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"], sizes: ["1K", "2K"] },
  { re: /^generate_image_qwen_image3/, ratios: LOOK_IMAGE_RATIOS.basic7, sizes: ["1K", "2K"] },
]);

const VIDEO_FAMILIES = Object.freeze([
  { re: /^generate_video_seedance_v2_5/, ratios: ["自适应", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], res: ["480p", "720p", "1080p"], durs: [5, 10, 15, 20, 30], modes: ["文生视频", "首帧", "首尾帧", "参考生视频"], maxRefs: 8, audio: true },
  { re: /^generate_video_seedance_v2_0/, ratios: ["自适应", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], res: ["480p", "720p"], durs: [5, 10, 15], modes: ["文生视频", "首帧", "首尾帧", "参考生视频"], maxRefs: 8, audio: true },
  { re: /^generate_video_kling_v3_omni/, ratios: ["16:9", "9:16", "1:1"], res: ["720p", "1080p", "4k"], durs: [5, 10, 15], modes: ["文生视频", "首帧", "首尾帧", "参考生视频"], maxRefs: 8, audio: true },
  { re: /^generate_video_kling_v3/, ratios: ["16:9", "9:16", "1:1"], res: ["720p", "1080p", "4k"], durs: [5, 10, 15], modes: ["文生视频", "首帧", "首尾帧"], maxRefs: 8, audio: true },
  { re: /^generate_video_kling_v2_6/, ratios: ["16:9", "9:16", "1:1"], res: ["720p", "1080p"], durs: [5, 10], modes: ["文生视频", "首帧", "首尾帧"], maxRefs: 8, audio: false },
  { re: /^generate_video_kling_omni_v1/, ratios: ["16:9", "9:16", "1:1"], res: ["720p", "1080p"], durs: [5, 10], modes: ["文生视频", "首帧", "首尾帧"], maxRefs: 8, audio: false },
  { re: /^generate_video_minimax_h3_max/, ratios: ["自适应", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], res: ["480p", "768p", "1080p"], durs: [5, 10, 15], modes: ["文生视频", "首帧", "首尾帧", "参考生视频"], maxRefs: 8, audio: true },
  { re: /^generate_video_minimax_h3/, ratios: ["自适应", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], res: ["768p", "2K"], durs: [5, 10, 15], modes: ["文生视频", "首帧", "首尾帧", "参考生视频"], maxRefs: 8, audio: true },
  { re: /^generate_video_wan_v3/, ratios: ["自适应", "16:9", "4:3", "1:1", "3:4", "9:16"], res: ["480p", "720p", "1080p"], durs: [5, 10, 15, 30], modes: ["文生视频", "首帧", "首尾帧"], maxRefs: 8, audio: true },
  { re: /^generate_video_wan_v2_6/, ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"], res: ["720p", "1080p"], durs: [5, 10, 15], modes: ["文生视频", "首帧"], maxRefs: 8, audio: false },
  { re: /^generate_video_veo3_1/, ratios: ["16:9", "9:16"], res: ["720p", "1080p", "4k"], durs: [8], modes: ["文生视频", "首帧", "首尾帧"], maxRefs: 8, audio: true },
  { re: /^generate_video_veo3/, ratios: ["16:9", "9:16"], res: ["720p", "1080p", "4k"], durs: [8], modes: ["文生视频", "首帧", "首尾帧"], maxRefs: 8, audio: true },
  { re: /^generate_video_hailuo_v2_3/, ratios: [], res: ["768p", "1080p"], durs: [6, 10], modes: ["文生视频", "首帧"], maxRefs: 8, audio: false },
  { re: /^generate_video_vidu_q2/, ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"], res: ["720p", "1080p"], durs: [5, 10], modes: ["文生视频", "首帧", "首尾帧"], maxRefs: 8, audio: false },
  { re: /^generate_video_gemini_omni/, ratios: ["16:9", "9:16"], res: ["360p", "720p", "1080p", "4k"], durs: [5, 10], modes: ["文生视频", "首帧", "首尾帧"], maxRefs: 8, audio: true },
]);

const IMAGE_UI_DEFAULT_REFS = 8;

function lovartImageSpec(family) {
  return {
    kind: "image",
    ratios: [...family.ratios],
    sizes: [...family.sizes],
    batch: [1],
    maxRefs: IMAGE_UI_DEFAULT_REFS,
    i2i: true,
    mask: family.mask === true,
    search: false,
    style: true,
    camera: true,
    audio: false,
    capabilitiesSource: "spec",
  };
}

function lovartVideoSpec(family) {
  return {
    kind: "video",
    ratios: [...family.ratios],
    res: [...family.res],
    durs: [...family.durs],
    modes: [...family.modes],
    maxRefs: family.maxRefs,
    times: [1],
    batch: [1],
    search: false,
    style: false,
    camera: false,
    audio: family.audio === true,
    capabilitiesSource: "spec",
  };
}

/**
 * 模型 id → 画布面板规格。已知族 = spec；只认得出 category 的 id 给**最小 guess 规格**
 * （kind + 显式 false，交给前端显示「未验证」）；完全认不出的返回 null。
 */
function uiSpec(model) {
  const id = String(model == null ? "" : model).trim().toLowerCase();
  if (!id) return null;
  const image = IMAGE_FAMILIES.find((family) => family.re.test(id));
  if (image) return lovartImageSpec(image);
  const video = VIDEO_FAMILIES.find((family) => family.re.test(id));
  if (video) return lovartVideoSpec(video);
  const guessBase = { batch: [1], search: false, style: false, camera: false, audio: false, capabilitiesSource: "guess" };
  if (id.startsWith("generate_image_")) return { kind: "image", ...guessBase };
  if (id.startsWith("generate_video_")) return { kind: "video", ...guessBase };
  return null;
}

/** catalog → 归一模型清单（id / displayName / category / premium / 能力建议）。 */
function mapCatalog(data) {
  const seen = new Set();
  const items = [];
  for (const raw of catalogTools(data)) {
    const item = mapCatalogItem(raw);
    if (!item || seen.has(item.id) || item.id.length > 200) continue;
    seen.add(item.id);
    items.push(item);
    if (items.length >= MAX_CATALOG_ITEMS) break;
  }
  return items;
}

/**
 * provider/models 出口：GET /v1/openapi/tools/catalog。
 * 照常带签名头，但真站该路由是**公开**的（2026-10-17 复验：伪造 AK/SK、甚至不带签名头
 * 都返回 200），所以它只用来取清单，不能用来证明凭据有效。
 */
async function listModels({ baseUrl, apiKey, signal = null, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const credential = parseCredential(apiKey);
  if (!credential.ok) return { ok: false, status: 0, error: credential.error, detail: credential.detail };
  const response = await request({ baseUrl, credential, method: "GET", path: ENDPOINTS.catalog, signal, timeoutMs, fetchImpl });
  if (!response.ok) return { ok: false, status: response.httpStatus || 0, error: response.error, detail: response.detail };
  const items = mapCatalog(response.data).map((item) => ({ ...item, ownedBy: "lovart" }));
  return { ok: true, items };
}

/**
 * model/test 出口（不消耗生成额度）。
 *
 * 为什么不用 catalog：真站的 GET /tools/catalog 是公开路由 —— 2026-10-17 实测用伪造 AK/SK
 * 甚至不带签名头都返回 200，所以它**无法区分有效/无效凭据**。
 * 真正校验签名的是 POST 路由；这里用签名 POST /v1/openapi/mode/query 探测
 * （只读、不消耗额度；实测伪造 AK → HTTP 401 {code:1005,error:"Invalid access key"}）。
 * 兼容：老站点 / 本地 mock 没有该路由（404/405）时回落到 catalog，并在 probe 字段如实标注。
 */
async function probeCredential({ baseUrl, apiKey, signal = null, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const credential = parseCredential(apiKey);
  if (!credential.ok) return { ok: false, error: credential.error, detail: credential.detail, reachable: false, credentialAccepted: false };
  const signed = await request({ baseUrl, credential, method: "POST", path: ENDPOINTS.modeQuery, body: {}, signal, timeoutMs, fetchImpl });
  if (signed.ok) return { ok: true, reachable: true, credentialAccepted: true, probe: "mode/query" };
  if (signed.httpStatus === 404 || signed.httpStatus === 405) {
    const result = await listModels({ baseUrl, apiKey, signal, timeoutMs, fetchImpl });
    if (result.ok) return { ok: true, reachable: true, credentialAccepted: true, modelCount: result.items.length, probe: "catalog" };
    return {
      ok: false,
      error: result.error || modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE,
      detail: result.detail,
      reachable: result.error !== modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE,
      credentialAccepted: result.error !== modelDomain.ERROR_CODE.AUTH_FAILED,
      probe: "catalog",
    };
  }
  return {
    ok: false,
    error: signed.error || modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE,
    detail: signed.detail,
    reachable: signed.error !== modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE,
    credentialAccepted: signed.error !== modelDomain.ERROR_CODE.AUTH_FAILED,
    probe: "mode/query",
  };
}

/* ─────────────────────────── send → watch → result ─────────────────────────── */

function categoryForKind(kind) {
  const value = String(kind || "").toLowerCase();
  if (value === "image") return "IMAGE";
  if (value === "video") return "VIDEO";
  return null;
}

function mediaKindFromUrl(url) {
  const clean = String(url || "").split("?")[0].split("#")[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|avif|heic)$/.test(clean)) return "image";
  if (/\.(mp4|mov|webm|m4v|avi|mkv)$/.test(clean)) return "video";
  return null;
}

/** 结果 items[].artifacts[] → 归一产物；按 kind 过滤，无匹配时如实返回全部。 */
function extractArtifacts(data, kind) {
  const items = data && Array.isArray(data.items) ? data.items : [];
  const all = [];
  for (const item of items) {
    const artifacts = item && Array.isArray(item.artifacts) ? item.artifacts : [];
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== "object") continue;
      const url = String(artifact.content || artifact.url || "").trim();
      if (!url) continue;
      all.push({ url, type: artifact.type ? String(artifact.type).toLowerCase() : null, mime: artifact.mime || artifact.mime_type || null, name: artifact.name || null });
    }
  }
  const wanted = kind === "video" ? "video" : kind === "image" ? "image" : null;
  if (!wanted) return all;
  const matched = all.filter((artifact) => artifact.type === wanted || (!artifact.type && mediaKindFromUrl(artifact.url) === wanted));
  return matched.length ? matched : all;
}

function extractAssistantText(data) {
  const items = data && Array.isArray(data.items) ? data.items : [];
  const texts = [];
  for (const item of items) {
    if (!item || typeof item.text !== "string") continue;
    const value = item.text.trim();
    if (value) texts.push(value);
  }
  return texts.join("\n\n");
}

/** failures[] 只取可展示字段，绝不放凭据。 */
function projectFailures(failures) {
  if (!Array.isArray(failures)) return [];
  return failures.slice(0, 8).map((failure) => ({
    tool: failure && (failure.tool_hint || failure.tool) ? String(failure.tool_hint || failure.tool).slice(0, 120) : null,
    code: failure && failure.code != null ? String(failure.code).slice(0, 40) : null,
    message: failure && failure.message ? String(failure.message).slice(0, 240) : null,
  }));
}

/**
 * watch：轮询 chat/status。
 * 上限 = maxPolls 与墙钟 timeoutMs 的双重封顶；每个等待点都可被 AbortSignal 取消。
 * done 后按官方语义做一次 settle 复查（防子代理尚未启动时线程短暂 done）。
 */
async function watchThread({ baseUrl, credential, threadId, signal, fetchImpl, timeoutMs, pollIntervalMs, maxPolls, settleMs, emit }) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 300000);
  let polls = 0;
  let lastStatus = null;
  for (;;) {
    if (signal && signal.aborted) return abortedResult();
    if (polls >= Math.max(1, Number(maxPolls) || 1)) return { ok: false, error: modelDomain.ERROR_CODE.MODEL_TIMEOUT, detail: "lovart-poll-limit-reached" };
    if (Date.now() >= deadline) return { ok: false, error: modelDomain.ERROR_CODE.MODEL_TIMEOUT, detail: "lovart-poll-deadline-reached" };
    if (polls > 0) {
      await sleep(pollIntervalMs, signal);
      if (signal && signal.aborted) return abortedResult();
    }
    polls += 1;
    const status = await request({ baseUrl, credential, method: "GET", path: ENDPOINTS.chatStatus, query: { thread_id: threadId }, signal, timeoutMs: Math.min(30000, Math.max(1000, deadline - Date.now())), fetchImpl });
    if (!status.ok) return { ...status, polls };
    lastStatus = String((status.data && status.data.status) || "");
    if (typeof emit === "function") emit({ type: "progress", phase: "poll", polls, status: lastStatus });
    if (lastStatus === "abort") return { ok: false, error: modelDomain.ERROR_CODE.CANCELLED, detail: "lovart-thread-abort", status: lastStatus, polls };
    if (lastStatus === "done") {
      const settle = Math.max(0, Number(settleMs) || 0);
      if (settle > 0 && Date.now() + settle < deadline) {
        await sleep(settle, signal);
        if (signal && signal.aborted) return abortedResult();
        const recheck = await request({ baseUrl, credential, method: "GET", path: ENDPOINTS.chatStatus, query: { thread_id: threadId }, signal, timeoutMs: Math.min(30000, Math.max(1000, deadline - Date.now())), fetchImpl });
        if (!recheck.ok) return { ...recheck, polls };
        lastStatus = String((recheck.data && recheck.data.status) || lastStatus);
      }
      if (lastStatus === "done" || lastStatus === "abort") return { ok: true, status: lastStatus, polls };
    }
  }
}

/** send：POST {prefix}/chat，返回 thread_id。 */
async function sendTask({ baseUrl, credential, prompt, projectId, model = null, kind = null, mode = null, attachments = null, signal, fetchImpl, timeoutMs }) {
  const body = { prompt: String(prompt == null ? "" : prompt), project_id: String(projectId) };
  if (attachments) body.attachments = attachments;
  if (mode) body.mode = String(mode);
  const category = categoryForKind(kind);
  if (model && category) body.tool_config = { prefer_tool_categories: { [category]: [String(model)] } };
  const response = await request({ baseUrl, credential, method: "POST", path: ENDPOINTS.chat, body, signal, timeoutMs, fetchImpl });
  if (!response.ok) return response;
  const threadId = String((response.data && response.data.thread_id) || "");
  if (!threadId) return { ok: false, error: modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: "lovart-send-missing-thread-id" };
  return { ok: true, threadId };
}

/**
 * 风格 / 摄影机 / 联网 → 提示词里的【画面要求】片段。
 *
 * model-service 对对话式适配器（SIZE_VIA_PROMPT）已经写过一次；这里再调是给**直接调用本适配器**的
 * 路径兜底。两处共用同一段文案，且都按「提示词里已有 风格：/摄影机：/联网 就不再写」去重，
 * 所以不会重复；没有提供的要求一个都不写（不编造）。
 */
const LOVART_STYLE_MAX = 40;
const LOVART_CAMERA_MAX = 40;

function cameraRequirement(camera) {
  if (!camera || typeof camera !== "object" || Array.isArray(camera)) return null;
  const read = (key) => (camera[key] == null ? "" : String(camera[key]).trim().slice(0, LOVART_CAMERA_MAX));
  const parts = [];
  if (read("body")) parts.push("机身 " + read("body"));
  if (read("lens")) parts.push("镜头 " + read("lens"));
  if (read("focal")) parts.push("焦段 " + (/mm$/i.test(read("focal")) ? read("focal") : read("focal") + "mm"));
  if (read("aperture")) parts.push("光圈 " + read("aperture"));
  return parts.length ? parts.join("，") : null;
}

function withVisualRequirements(prompt, params) {
  const base = String(prompt == null ? "" : prompt);
  const p = params && typeof params === "object" ? params : {};
  const style = typeof p.style === "string" ? p.style.trim().slice(0, LOVART_STYLE_MAX) : "";
  const camera = cameraRequirement(p.camera);
  const clauses = [];
  if (style && !/风格[:：]/.test(base)) clauses.push("风格：" + style);
  if (camera && !/摄影机[:：]/.test(base)) clauses.push("摄影机：" + camera);
  if (p.webSearch === true && !/联网/.test(base)) clauses.push("联网搜索参考资料后再画");
  if (!clauses.length) return base;
  const text = clauses.join("；");
  const marker = "【画面要求】";
  const index = base.lastIndexOf(marker);
  if (index >= 0) {
    const head = base.slice(0, index + marker.length);
    const tail = base.slice(index + marker.length).trimEnd();
    if (tail.endsWith("。")) return head + tail.slice(0, -1) + "；" + text + "。";
    return head + (tail ? tail + "；" : "") + text + "。";
  }
  return base + (base.trim() ? "\n\n" : "") + marker + text + "。";
}

/**
 * 生成主流程：project（缺省自动建）→ send → watch → result。
 * kind: "image" | "video" | "chat"。返回 { ok, artifacts, text, status, threadId, projectId, polls, failures }。
 *
 * params 里的 style / camera / webSearch 会写进提示词的【画面要求】（见 withVisualRequirements）：
 * 对话式接口没有独立字段，这是唯一能让面板选项真正生效的载体。
 */
async function generateComplete({
  baseUrl, apiKey, kind = "image", model = null, prompt = "", projectId = null, mode = null, attachments = null, params = {},
  signal = null, fetchImpl = fetch, timeoutMs = 300000, pollIntervalMs = 3000, maxPolls = 100, settleMs = 3000, onEvent = null,
} = {}) {
  const credential = parseCredential(apiKey);
  if (!credential.ok) return credential;
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const startedAt = Date.now();
  const remaining = () => Math.max(1000, Number(timeoutMs || 300000) - (Date.now() - startedAt));
  const visualPrompt = withVisualRequirements(prompt, params);

  let pid = projectId ? String(projectId) : "";
  if (!pid) {
    const created = await request({
      baseUrl, credential, method: "POST", path: ENDPOINTS.projectSave,
      body: { project_id: "", canvas: "", project_name: "", project_cover_list: [], project_type: 3 },
      signal, timeoutMs: Math.min(30000, remaining()), fetchImpl,
    });
    if (!created.ok) return created;
    pid = String((created.data && created.data.project_id) || "");
    if (!pid) return { ok: false, error: modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: "lovart-project-missing-id" };
  }

  const sent = await sendTask({ baseUrl, credential, prompt: visualPrompt, projectId: pid, model, kind, mode, attachments, signal, fetchImpl, timeoutMs: Math.min(60000, remaining()) });
  if (!sent.ok) return { ...sent, projectId: pid };
  const threadId = sent.threadId;
  emit({ type: "progress", phase: "sent", threadId, projectId: pid });

  const watched = await watchThread({ baseUrl, credential, threadId, signal, fetchImpl, timeoutMs: remaining(), pollIntervalMs, maxPolls, settleMs, emit });
  if (!watched.ok) return { ...watched, threadId, projectId: pid };

  const result = await request({ baseUrl, credential, method: "GET", path: ENDPOINTS.chatResult, query: { thread_id: threadId }, signal, timeoutMs: Math.min(30000, remaining()), fetchImpl });
  if (!result.ok) return { ...result, threadId, projectId: pid };
  const data = result.data && typeof result.data === "object" ? result.data : {};
  if (data.pending_confirmation) {
    return { ok: false, error: modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: "lovart-pending-confirmation", threadId, projectId: pid, status: String(data.final_status || watched.status || "pending_confirmation"), pendingConfirmation: true, polls: watched.polls };
  }
  const artifacts = extractArtifacts(data, kind);
  return {
    ok: true,
    threadId,
    projectId: pid,
    status: String(data.final_status || watched.status || "done"),
    artifacts,
    text: extractAssistantText(data),
    failures: projectFailures(data.failures),
    polls: watched.polls,
    generationSucceeded: artifacts.length > 0,
  };
}

function messageToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === "object" ? String(part.text || part.content || "") : part == null ? "" : String(part))).join("");
  }
  return content == null ? "" : String(content);
}

function promptFromMessages(messages) {
  const parts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const text = messageToText(message.content).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

/**
 * 对话面：Lovart 的 /chat 本身就是 agent 线程（send → watch → result），
 * 结果 items[].text 即助手文本。因此 provider/call 对 lovart 走这条线路，
 * 不伪造流式分块（chatStream 只合成一次 text.delta，如实标注）。
 */
async function chatComplete({ baseUrl, apiKey, model = null, messages = [], params = {}, signal = null, fetchImpl = fetch, timeoutMs = 300000, pollIntervalMs = 3000, maxPolls = 100, settleMs = 3000, onEvent = null } = {}) {
  const credential = parseCredential(apiKey);
  if (!credential.ok) return credential;
  const prompt = promptFromMessages(messages) || String((params && params.prompt) || "");
  const out = await generateComplete({ baseUrl, apiKey, kind: "chat", model, prompt, signal, fetchImpl, timeoutMs, pollIntervalMs, maxPolls, settleMs, onEvent });
  if (!out.ok) return out;
  return {
    ok: true,
    text: out.text || "",
    toolCalls: null,
    usage: null,
    artifacts: out.artifacts,
    failures: out.failures,
    threadId: out.threadId,
    projectId: out.projectId,
    status: out.status,
    polls: out.polls,
  };
}

function toThrownError(out) {
  const code = (out && out.error) || modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE;
  const error = new Error(code + (out && out.detail ? ": " + out.detail : ""));
  if (code === modelDomain.ERROR_CODE.CANCELLED) error.name = "AbortError";
  else if (code === modelDomain.ERROR_CODE.MODEL_TIMEOUT) error.name = "TimeoutError";
  else error.name = "ProviderHttpError";
  if (code === modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR) error.status = 0;
  error.errorCode = code;
  return error;
}

/** 与 provider-adapter.cjs#chatStream 同形状（返回 { text, toolCalls, usage }）。 */
async function chatStream({ baseUrl, apiKey, model, messages, params = {}, signal, timeoutMs = 30000, fetchImpl = fetch, onEvent = () => {} } = {}) {
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  emit({ type: "response.start" });
  const out = await chatComplete({ baseUrl, apiKey, model, messages, params, signal, fetchImpl, timeoutMs: Math.max(Number(timeoutMs) || 30000, 60000), onEvent: emit });
  if (!out.ok) { emit({ type: "response.error", error: out.error || "PROVIDER_UNAVAILABLE", partial: "" }); throw toThrownError(out); }
  if (out.text) emit({ type: "text.delta", text: out.text });
  emit({ type: "response.complete" });
  return { text: out.text || "", toolCalls: [], usage: null };
}

/** Upload URLs are attachments, not download targets: require https + Lovart-owned host. */
function isLovartAttachmentUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) return false;
  const host = url.hostname.toLowerCase();
  return host === "lovart.ai" || host.endsWith(".lovart.ai");
}
function safeHost(raw) {
  try { return new URL(String(raw || "")).hostname; } catch { return ""; }
}

/* ─────────────────────────── 产物下载白名单 ─────────────────────────── */

/** 同源永远允许；否则只看白名单（未观察到的 CDN 主机保持拒绝）。 */
function isAllowedArtifactUrl(raw, providerBaseUrl) {
  let url;
  try { url = new URL(String(raw || "")); } catch { return false; }
  if (url.username || url.password) return false;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) return false;
  if (providerBaseUrl) {
    try { if (new URL(String(providerBaseUrl)).origin === url.origin) return true; } catch { /* 非法 provider base 交给调用方报错 */ }
  }
  const host = url.hostname.toLowerCase();
  return ARTIFACT_HOST_ALLOWLIST.some((allowed) => host === allowed || host.endsWith("." + allowed));
}

/**
 * 产物下载：先过主机白名单，再用注入的 fetchImpl 拉取（带大小上限 + 超时 + 取消）。
 * 不复用协议引擎的 artifactDownload.cjs —— 它按 SSRF 规则一律拒绝回环地址，
 * 而本地 mock / 用户自建的回环站点是合法 provider 同源；白名单已经限定了目标主机。
 */
async function downloadArtifact({ url, providerBaseUrl, fetchImpl = fetch, signal = null, maxBytes = 64 * 1024 * 1024, timeoutMs = 120000 } = {}) {
  if (!isAllowedArtifactUrl(url, providerBaseUrl)) return { ok: false, error: "ARTIFACT_HOST_BLOCKED" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), Math.max(1000, Number(timeoutMs) || 120000));
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "image/*, video/*, application/octet-stream", "User-Agent": REQUEST_USER_AGENT },
    });
    if (!response.ok) return { ok: false, error: errorFromStatus(response.status) };
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) return { ok: false, error: "ARTIFACT_TOO_LARGE" };
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length) return { ok: false, error: "ARTIFACT_EMPTY" };
    if (data.length > maxBytes) return { ok: false, error: "ARTIFACT_TOO_LARGE" };
    const mime = String(response.headers.get("content-type") || "application/octet-stream").split(";")[0];
    return { ok: true, data, mime, sourceUrl: url };
  } catch (error) {
    if (signal && signal.aborted) return { ok: false, error: modelDomain.ERROR_CODE.CANCELLED };
    if (controller.signal.aborted) return { ok: false, error: modelDomain.ERROR_CODE.MODEL_TIMEOUT };
    return { ok: false, error: modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** 状态 / 网络 / 超时 / 取消 → model-domain 既有错误码。 */
function errorCodeFor({ status = 0, kind = "" } = {}) {
  return modelDomain.normalizeError({ status, kind });
}

/** Upload a PNG buffer to Lovart openapi file/upload. Returns a whitelisted CDN URL. */
async function uploadFile({ baseUrl, apiKey, data, mime = "image/png", filename = "mask.png", fetchImpl = fetch, signal = null, timeoutMs = 60000 } = {}) {
  const credential = parseCredential(apiKey);
  if (!credential.ok) return credential;
  if (!data || !data.length) return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "empty-file" };
  const boundary = "----openarc" + crypto.randomBytes(12).toString("hex");
  const head = Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + String(filename).replace(/"/g, "") + "\"\r\nContent-Type: " + mime + "\r\n\r\n");
  const tail = Buffer.from("\r\n--" + boundary + "--\r\n");
  const body = Buffer.concat([head, Buffer.from(data), tail]);
  const url = buildUrl(baseUrl, ENDPOINTS.fileUpload);
  const headers = { ...authHeaders({ credential, method: "POST", path: ENDPOINTS.fileUpload }), "content-type": "multipart/form-data; boundary=" + boundary, "content-length": String(body.length) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), Math.max(1000, Number(timeoutMs) || 60000));
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { method: "POST", headers, body, signal: controller.signal, redirect: "error" });
    const parsed = await response.json().catch(() => null);
    if (!response.ok || !parsed || parsed.code !== 0 || !parsed.data || !parsed.data.url) {
      return { ok: false, error: errorFromStatus(response.status) || modelDomain.ERROR_CODE.PROVIDER_PROTOCOL_ERROR, detail: parsed && parsed.message ? String(parsed.message).slice(0, 200) : "upload-failed" };
    }
    const artifactUrl = String(parsed.data.url);
    if (!isLovartAttachmentUrl(artifactUrl)) return { ok: false, error: "ARTIFACT_HOST_BLOCKED", detail: "uploaded-url", uploadedHost: safeHost(artifactUrl) };
    return { ok: true, url: artifactUrl };
  } catch (error) {
    if (signal && signal.aborted) return { ok: false, error: modelDomain.ERROR_CODE.CANCELLED };
    if (controller.signal.aborted) return { ok: false, error: modelDomain.ERROR_CODE.MODEL_TIMEOUT };
    return { ok: false, error: modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE, detail: String((error && error.message) || error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** Image-to-image via Lovart: transparent-hole PNG upload + attachments=[url]. */
async function generateImageEdit({ baseUrl, apiKey, model, prompt, mode = "redraw", sourceDataUrl, uploadedUrl = null, referenceUrls = [], size = null, ratio = null, signal = null, fetchImpl = fetch, timeoutMs = 300000 } = {}) {
  let uploaded;
  if (uploadedUrl) {
    uploaded = isLovartAttachmentUrl(String(uploadedUrl)) ? { ok: true, url: String(uploadedUrl) } : { ok: false, error: "ARTIFACT_HOST_BLOCKED", detail: "uploaded-url", uploadedHost: safeHost(uploadedUrl) };
  } else {
    const match = /^data:([^;,]+)?;base64,(.*)$/i.exec(String(sourceDataUrl || ""));
    if (!match) return { ok: false, error: modelDomain.ERROR_CODE.INVALID_INPUT, detail: "sourceDataUrl-base64-required" };
    uploaded = await uploadFile({ baseUrl, apiKey, data: Buffer.from(match[2] || "", "base64"), mime: match[1] || "image/png", filename: "masked-" + mode + ".png", fetchImpl, signal });
  }
  if (!uploaded.ok) return uploaded;
  const prompts = {
    erase: "Naturally redraw the transparent-channel area in the image. Do not generate new objects that do not exist in the scene. Blend the transparent area into the surrounding environment.",
    redraw: "Naturally redraw only the transparent-channel area in the image. The last image is the main image with transparency to redraw; keep the original content and aspect ratio of that image.\n\nRedraw prompt: " + String(prompt || ""),
    outpaint: "Seamlessly extend the image into the empty transparent areas around it. Carefully analyze the existing scene. Only generate new content in the transparent regions, blending invisibly with the existing edges.",
  };
  // 尺寸要求：三种模式的模板不一样（outpaint / erase 不吃调用方的 prompt），统一拼在这三种模板之后。
  const requirement = imageParams.withSizeRequirement("", { size, ratio });
  const basePrompt = prompts[mode] || prompts.redraw;
  const finalPrompt = requirement && !basePrompt.includes("【画面要求】") ? basePrompt + "\n\n" + requirement : basePrompt;
  const attachments = [uploaded.url].concat(Array.isArray(referenceUrls) ? referenceUrls.slice(0, 7) : []);
  const out = await generateComplete({ baseUrl, apiKey, kind: "image", model, prompt: finalPrompt, attachments, signal, fetchImpl, timeoutMs });
  if (!out.ok) return out;
  return { ...out, uploadedUrl: uploaded.url };
}

/**
 * 10-23 · 视频生成（图生视频 / 首尾帧 / 参考）：Lovart 是对话式接口——
 *   参考素材先传成 Lovart 自家附件（data: 直接上传；外部 https 先下载再上传；*.lovart.ai 原样用），
 *   比例 / 清晰度 / 时长 / 有声 / 附件角色写进提示词的「生成要求」。
 */
/** 输入素材 → Lovart 附件地址（data: 上传；外部 https 先下载再上传；*.lovart.ai 原样） */
async function toAttachments({ baseUrl, apiKey, inputs = [], signal = null, fetchImpl = fetch, max = 8 } = {}) {
  const attachments = [];
  for (const raw of (Array.isArray(inputs) ? inputs : []).slice(0, max)) {
    const value = String(raw || "");
    if (isLovartAttachmentUrl(value)) { attachments.push(value); continue; }
    let data = null; let mime = "image/png";
    const m = /^data:([^;,]+)?;base64,(.*)$/is.exec(value);
    if (m) { data = Buffer.from(m[2] || "", "base64"); mime = m[1] || mime; }
    else if (/^https:\/\//i.test(value)) {
      try { const res = await fetchImpl(value, { signal }); if (res && res.ok) { data = Buffer.from(await res.arrayBuffer()); mime = String(res.headers.get("content-type") || mime).split(";")[0]; } } catch { /* 下载失败就跳过这一个 */ }
    }
    if (!data || !data.length) continue;
    const ext = (mime.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "png";
    const up = await uploadFile({ baseUrl, apiKey, data, mime, filename: "canvas-input-" + attachments.length + "." + ext, fetchImpl, signal });
    if (!up || !up.ok) return { ok: false, error: (up && up.error) || modelDomain.ERROR_CODE.PROVIDER_UNAVAILABLE, detail: "lovart-upload-input: " + String((up && up.detail) || "") };
    attachments.push(up.url);
  }
  return { ok: true, attachments };
}

/** 10-23 · 带参考图的图片生成 / 编辑（多角度、重打光、增强、抠图、标注改图、图生图）：附件 + 原样提示词 */
async function generateImageWithInputs({ baseUrl, apiKey, model = null, prompt = "", inputs = [], signal = null, fetchImpl = fetch, timeoutMs = 300000 } = {}) {
  const att = await toAttachments({ baseUrl, apiKey, inputs, signal, fetchImpl });
  if (!att.ok) return att;
  return generateComplete({ baseUrl, apiKey, kind: "image", model, prompt: String(prompt || ""), attachments: att.attachments.length ? att.attachments : null, signal, fetchImpl, timeoutMs });
}

async function generateVideo({ baseUrl, apiKey, model = null, prompt = "", inputs = [], params = {}, signal = null, fetchImpl = fetch, timeoutMs = 600000 } = {}) {
  const att = await toAttachments({ baseUrl, apiKey, inputs, signal, fetchImpl });
  if (!att.ok) return att;
  const attachments = att.attachments;
  const p = params && typeof params === "object" ? params : {};
  const roleText = { first_frame: "首帧", last_frame: "尾帧", reference: "参考图", portrait: "人像" };
  const roles = Array.isArray(p.imageRoles) ? p.imageRoles : [];
  const hints = [];
  if (attachments.length) hints.push("附件按顺序：" + attachments.map((_, i) => "第" + (i + 1) + "个=" + (roleText[roles[i]] || "参考素材")).join("，"));
  if (p.ratio) hints.push("画面比例 " + p.ratio);
  if (p.resolution) hints.push("清晰度 " + p.resolution);
  if (p.duration) hints.push("时长 " + p.duration + " 秒");
  if (p.generateAudio === false) hints.push("不要声音");
  if (p.generateAudio === true) hints.push("同时生成声音");
  if (p.multiShot) hints.push("多镜头");
  const base = String(prompt || "");
  return generateComplete({
    baseUrl, apiKey, kind: "video", model,
    prompt: hints.length ? base + "\n\n【生成要求】" + hints.join("；") + "。" : base,
    attachments: attachments.length ? attachments : null, signal, fetchImpl, timeoutMs,
  });
}

module.exports = {
  generateVideo,
  generateImageWithInputs,
  toAttachments,
  uploadFile,
  generateImageEdit,
  ADAPTER_TYPE,
  /** 对话式入口：请求体只有提示词，没有 size / aspect_ratio 字段（尺寸由 model-service 写进提示词）。 */
  SIZE_VIA_PROMPT: true,
  DEFAULT_BASE_URL,
  API_PREFIX,
  ENDPOINTS,
  CATEGORY_CAPABILITIES,
  UNSUPPORTED_CATEGORIES,
  ARTIFACT_HOST_ALLOWLIST,
  OBSERVED_HOSTS,
  REQUEST_USER_AGENT,
  isLoopbackHostname,
  assertTransportAllowed,
  resolveUrl,
  buildUrl,
  parseCredential,
  serializeCredential,
  signRequest,
  authHeaders,
  buildRequest,
  capabilitiesForCategory,
  uiSpec,
  withVisualRequirements,
  IMAGE_FAMILIES,
  VIDEO_FAMILIES,
  catalogTools,
  mapCatalog,
  listModels,
  probeCredential,
  extractArtifacts,
  extractAssistantText,
  watchThread,
  sendTask,
  generateComplete,
  chatComplete,
  chatStream,
  isAllowedArtifactUrl,
  isLovartAttachmentUrl,
  downloadArtifact,
  errorCodeFor,
};
