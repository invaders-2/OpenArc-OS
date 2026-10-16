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
 * 生成主流程：project（缺省自动建）→ send → watch → result。
 * kind: "image" | "video" | "chat"。返回 { ok, artifacts, text, status, threadId, projectId, polls, failures }。
 */
async function generateComplete({
  baseUrl, apiKey, kind = "image", model = null, prompt = "", projectId = null, mode = null, attachments = null,
  signal = null, fetchImpl = fetch, timeoutMs = 300000, pollIntervalMs = 3000, maxPolls = 100, settleMs = 3000, onEvent = null,
} = {}) {
  const credential = parseCredential(apiKey);
  if (!credential.ok) return credential;
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const startedAt = Date.now();
  const remaining = () => Math.max(1000, Number(timeoutMs || 300000) - (Date.now() - startedAt));

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

  const sent = await sendTask({ baseUrl, credential, prompt, projectId: pid, model, kind, mode, attachments, signal, fetchImpl, timeoutMs: Math.min(60000, remaining()) });
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

module.exports = {
  ADAPTER_TYPE,
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
  downloadArtifact,
  errorCodeFor,
};
