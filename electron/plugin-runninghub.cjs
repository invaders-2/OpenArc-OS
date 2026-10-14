/**
 * B7e2 · RunningHub 可选插件（逐函数移植 server/runninghub.ts:1-700 的模型执行链与 AI 应用 / 工作流入口）。
 *
 * 逐函数对应（源文件:行号）：
 *   runninghub.ts:13-44    RUNNINGHUB_DEFAULT_BASE_URL / LLM_BASE_URL / MODEL_REGISTRY_URL / FALLBACK_* / ENDPOINT_ALIASES
 *   runninghub.ts:49-53    isRunningHubUrl
 *   runninghub.ts:86-98    normalizeField
 *   runninghub.ts:151-167  providerBase / openApiUrl / key / headers
 *   runninghub.ts:168-181  requestJson（改为接收注入 fetch）
 *   runninghub.ts:183-234  registryItems / modelId / classifyModel / modelLabel / 注册表缓存
 *   runninghub.ts:240-268  fetchRunningHubModels
 *   runninghub.ts:291-315  endpointForModel / runningHubModelDefinition
 *   runninghub.ts:332-343  modelTaskState
 *   runninghub.ts:345-405  buildRunningHubImage/VideoModelRequest / submit / query
 *   runninghub.ts:407-466  schemaField / schemaValue / applySchemaDefaults / applyExplicitSchemaParams / aspectFromSize / resolutionFromSize
 *   runninghub.ts:485-546  uploadBuffer / uploadRunningHubModelReference / uploadRunningHubAsset
 *   runninghub.ts:548-580  runningHubOutputUrls / taskId / waitOpenApi
 *   runninghub.ts:583-615  generateRunningHubImages / editRunningHubImages / generateRunningHubVideos
 *   runninghub.ts:617-665  inferFieldType / fieldsFromWorkflow / isWorkflowGraph / parseRunningHubWorkflowPayload
 *   runninghub.ts:667-700  inspectRunningHubApp / inspectRunningHubWorkflow / submitRunningHubEntry / queryRunningHubTask
 *
 * 与源文件的差异（任务书硬要求，不是行为漂移）：
 *   · **网络一律经注入 transport.fetch 或装配时注入的 fetch**；未注入即结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }；
 *   · 流水线方法不 throw 到 IPC 出口：成功返回源协议形状 { images, raw } / { videos, raw }，失败返回 { ok:false, ... }；
 *   · 凭据（RH币 API Key / 账户余额 API Key）走 credential-store，磁盘不落明文；provider.api_key 仍可直接传入；
 *   · 轮询等待走注入 clock；模型注册表 / LLM / 站点地址可注入（测试指向本地 127.0.0.1 stub，离线可跑）。
 *
 * 声明范围外（内部实现，未暴露 integration 命令）：
 *   · AI 应用 / 工作流入口 inspect / submit / query / upload（源 runninghub.ts:667-700）在本移植里
 *     只是插件内部函数，**未登记为 integration 命令**，渲染层无法直接调用。属当前声明范围外，
 *     待后续按需登记；登记时必须同时补 integration:command 白名单与对应测试，不能只留函数。
 *
 * OUT（不引入）：api.dx-os.com、云发布 / 更新、云端实时房间。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { basename } = require("node:path");

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT } = require("./plugin-registry.cjs");

// runninghub.ts:13-15
const RUNNINGHUB_DEFAULT_BASE_URL = "https://www.runninghub.ai";
const RUNNINGHUB_DEFAULT_LLM_BASE_URL = "https://llm.runninghub.ai/v1";
const RUNNINGHUB_DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/HM-RunningHub/ComfyUI_RH_OpenAPI/main/models_registry.json";

// runninghub.ts:16-17（缓存路径由装配注入的 cacheDir 决定）
const MODEL_REGISTRY_CACHE_FILE_NAME = "runninghub-models.json";
const MODEL_REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// runninghub.ts:18-32 逐字搬运
const FALLBACK_CHAT = ["google/gemini-3.1-flash-lite-preview", "qwen/qwen3-vl-235b-a22b-instruct", "qwen/qwen-plus", "openai/gpt-5.1"];
const FALLBACK_IMAGE = [
  "gpt-image-2.0/text-to-image-channel-low-price",
  "gpt-image-2.0/edit-channel-low-price",
  "gpt-image-2/text-to-image-official-stable",
  "gpt-image-2/image-to-image-official-stable",
  "nano-banana/text-to-image-official-stable",
  "nano-banana/edit-official-stable",
];
const FALLBACK_VIDEO = [
  "google/veo3.1-fast/text-to-video-channel-low-price",
  "sora-2/text-to-video-official-stable",
  "seedance-2.0-global/text-to-video",
  "seedance-2.0-global/image-to-video",
];

// runninghub.ts:33-43 逐字搬运
const ENDPOINT_ALIASES = Object.freeze({
  "gpt-image-2.0/text-to-image-channel-low-price": "rhart-image-g-2/text-to-image",
  "gpt-image-2/text-to-image-channel-low-price": "rhart-image-g-2/text-to-image",
  "gpt-image-2.0/edit-channel-low-price": "rhart-image-g-2/image-to-image",
  "gpt-image-2/edit-channel-low-price": "rhart-image-g-2/image-to-image",
  "gpt-image-2.0/image-to-image-channel-low-price": "rhart-image-g-2/image-to-image",
  "gpt-image-2/image-to-image-channel-low-price": "rhart-image-g-2/image-to-image",
  "nano-banana/text-to-image-channel-low-price": "rhart-image-v1/text-to-image",
  "nano-banana/edit-channel-low-price": "rhart-image-v1/edit",
  "Seedance2.0 Image to Video": "bytedance/seedance-2.0-global/image-to-video",
  "Seedance2.0 Text to Video": "bytedance/seedance-2.0-global/text-to-video",
});

const CREDENTIAL_REFS = Object.freeze({ apiKey: "runninghub.apiKey", walletApiKey: "runninghub.walletApiKey" });
const REQUEST_FAILED = "INTEGRATION_REQUEST_FAILED";

const asStr = (value, max = 4096) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));
const cleanEndpoint = (value) => String(value || "").replace(/^\/?openapi\/v2\//, "").replace(/^\/+/, "");

// runninghub.ts:49-53
function isRunningHubUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" && /(^|\.)runninghub\.(?:ai|cn)$/i.test(parsed.hostname);
  } catch { return false; }
}

// runninghub.ts:151-155
function providerBase(provider, fallbackBaseUrl) {
  return String((provider && provider.base_url) || fallbackBaseUrl || RUNNINGHUB_DEFAULT_BASE_URL)
    .replace(/\/+$/, "")
    .replace(/\/openapi\/v2$/i, "");
}

// runninghub.ts:156-159
function openApiUrl(provider, subPath, fallbackBaseUrl) {
  const base = providerBase(provider, fallbackBaseUrl) + "/openapi/v2";
  return base + "/" + String(subPath || "").replace(/^\/+/, "");
}

// runninghub.ts:183-189
function registryItems(raw) {
  for (const value of [raw, raw && raw.data, raw && raw.models, raw && raw.list, raw && raw.items, raw && raw.records, raw && raw.result]) {
    if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
    for (const nested of [value && value.models, value && value.list, value && value.items, value && value.records, value && value.data]) {
      if (Array.isArray(nested)) return nested;
    }
  }
  return [];
}

// runninghub.ts:190-199
function modelId(item) { return String((item && (item.name_en || item.id || item.name || item.endpoint)) || "").trim(); }
function classifyModel(item) {
  const declared = String((item && (item.output_type || item.outputType)) || "").toLowerCase();
  if (declared === "image" || declared === "video") return declared;
  if (declared === "chat" || declared === "llm" || declared === "text") return "llm";
  const id = modelId(item).toLowerCase();
  if (/(video|veo|sora|seedance|kling)/.test(id)) return "video";
  if (/(image|banana|flux|seedream|rhart-image)/.test(id)) return "image";
  return "llm";
}

// runninghub.ts:201-208
function modelLabel(item, id = modelId(item)) {
  for (const key of ["name_cn", "name_zh", "zh_name", "cn_name", "display_name", "displayName", "title", "label", "nameCn", "nameZh", "chinese_name", "chineseName"]) {
    const value = String((item && item[key]) || "").replace(/\s+/g, " ").trim();
    if (value && value !== id) return value.slice(0, 160);
  }
  const name = String((item && item.name) || "").replace(/\s+/g, " ").trim();
  return name && name !== id && !/^[A-Za-z0-9_./:-]+$/.test(name) ? name.slice(0, 160) : "";
}

// runninghub.ts:86-98
function normalizeField(raw) {
  const nodeId = String((raw && (raw.nodeId || raw.node_id)) || "");
  const fieldName = String((raw && (raw.fieldName || raw.inputName || raw.name)) || "");
  const value = raw && raw.fieldValue != null ? raw.fieldValue : raw && raw.defaultValue != null ? raw.defaultValue : raw && raw.value != null ? raw.value : "";
  const options = Array.isArray(raw && raw.options)
    ? raw.options.map(String)
    : typeof (raw && raw.options) === "string" ? raw.options.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean) : [];
  return {
    ...raw,
    id: String((raw && raw.id) || nodeId + "::" + fieldName),
    nodeId,
    fieldName,
    fieldValue: typeof value === "object" ? JSON.stringify(value) : String(value),
    fieldType: String((raw && raw.fieldType) || inferFieldType(fieldName, value)),
    label: String((raw && raw.label) || fieldName),
    enabled: !(raw && raw.enabled === false),
    options,
  };
}

// runninghub.ts:617-625
function inferFieldType(name, value) {
  const keyName = String(name).toLowerCase();
  if (/image|photo|picture|mask/.test(keyName)) return "IMAGE";
  if (/video/.test(keyName)) return "VIDEO";
  if (/seed/.test(keyName)) return "INT";
  if (typeof value === "boolean" || /^(true|false)$/i.test(String(value))) return "BOOLEAN";
  if (typeof value === "number" || /^-?\d+(\.\d+)?$/.test(String(value))) return "NUMBER";
  return "TEXT";
}

// runninghub.ts:626-637
function fieldsFromWorkflow(workflow) {
  const fields = [];
  if (!workflow || typeof workflow !== "object") return fields;
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== "object" || !node.inputs || typeof node.inputs !== "object") continue;
    for (const [fieldName, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && (typeof value[0] === "string" || typeof value[0] === "number") && typeof value[1] === "number") continue;
      fields.push(normalizeField({ nodeId, fieldName, fieldValue: value, fieldType: inferFieldType(fieldName, value), label: fieldName, enabled: false, group: (node._meta && node._meta.title) || node.class_type || "", required: /image/i.test(fieldName) }));
    }
  }
  return fields;
}

// runninghub.ts:639-642
function isWorkflowGraph(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).some((node) => node && typeof node === "object" && node.inputs && typeof node.inputs === "object");
}

// runninghub.ts:644-665
function parseRunningHubWorkflowPayload(raw) {
  const candidates = [
    raw && raw.data && raw.data.prompt,
    raw && raw.data && raw.data.workflow,
    raw && raw.data && raw.data.workflowJson,
    raw && raw.data && raw.data.data && raw.data.data.prompt,
    raw && raw.prompt,
    raw && raw.workflow,
    raw && raw.workflowJson,
    raw && raw.data,
  ];
  for (const candidate of candidates) {
    let value = candidate;
    for (let depth = 0; depth < 2 && typeof value === "string"; depth += 1) {
      const text = value.trim();
      if (!text) break;
      try { value = JSON.parse(text); } catch { break; }
    }
    if (isWorkflowGraph(value)) return value;
  }
  throw new Error("RunningHub 工作流接口未返回可解析的工作流 JSON：" + JSON.stringify(raw).slice(0, 500));
}

// runninghub.ts:548-568
function runningHubOutputUrls(raw, kind = "image") {
  const out = [];
  const mediaKey = kind === "image" ? /image|file|download|output|result|url/i : /video|file|download|output|result|url/i;
  const directUrlKey = kind === "image"
    ? /^(url|uri|file_?url|download_?url|image_?url|grid_?image_?url)$/i
    : /^(url|uri|file_?url|download_?url|video_?url)$/i;
  const mediaExt = kind === "image" ? /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i : /\.(mp4|webm|mov|m4v|mkv)(\?|#|$)/i;
  const visit = (value, depth = 0, keyHint = "") => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      if (/^data:image\//i.test(value) && kind === "image" && !out.includes(value)) out.push(value);
      else if (/^https?:\/\//i.test(value) && (mediaKey.test(keyHint) || mediaExt.test(value)) && !out.includes(value)) out.push(value);
      return;
    }
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1, keyHint)); return; }
    if (typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (/^(data|results?|outputs?|files?|images?|videos?|content)$/i.test(key) || directUrlKey.test(key)) visit(item, depth + 1, key);
    }
  };
  for (const root of [raw, raw && raw.data]) visit(root);
  return out;
}

// runninghub.ts:569
function taskId(raw) {
  return String((raw && (raw.taskId || raw.task_id || raw.id)) || (raw && raw.data && (raw.data.taskId || raw.data.task_id || raw.data.id)) || "");
}

// runninghub.ts:332-343
function modelTaskState(raw, outputKind, fallbackTaskId = "") {
  const urls = runningHubOutputUrls(raw, outputKind);
  const id = taskId(raw) || fallbackTaskId;
  const status = String((raw && (raw.status || raw.state)) || (raw && raw.data && (raw.data.status || raw.data.state)) || "").trim().toUpperCase();
  const failed = ["FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(status)
    || (raw && raw.code != null && ![0, "0", 804, "804", 813, "813"].includes(raw.code));
  const completed = urls.length > 0 || ["SUCCESS", "SUCCEEDED", "COMPLETED", "DONE", "FINISHED"].includes(status);
  return {
    status: failed ? "FAILED" : completed ? "SUCCESS" : "RUNNING",
    taskId: id,
    urls,
    failReason: String((raw && (raw.msg || raw.message || (raw.error && raw.error.message))) || ""),
    raw,
  };
}

// runninghub.ts:407-466
function schemaOptions(field) {
  return (Array.isArray(field && field.options) ? field.options : []).map((item) => String(item && typeof item === "object" ? item.value : item == null ? "" : item)).filter(Boolean);
}
function schemaField(params, ...keys) {
  const wanted = new Set(keys.map((item) => item.toLowerCase()));
  return params.find((field) => wanted.has(String((field && field.fieldKey) || "").toLowerCase()) || wanted.has(String((field && field.label) || "").toLowerCase()));
}
function schemaValue(field, preferred) {
  const wanted = String(preferred == null ? "" : preferred).trim();
  const options = schemaOptions(field);
  if (wanted && (!options.length || options.includes(wanted))) return wanted;
  if (field && field.defaultValue !== undefined && field.defaultValue !== "") return field.defaultValue;
  return options[0] != null ? options[0] : preferred;
}
function applySchemaDefaults(body, params) {
  for (const field of params) {
    const key = String((field && field.fieldKey) || "").trim();
    if (!key || key in body) continue;
    let value = field && field.defaultValue;
    const options = schemaOptions(field);
    if ((value === undefined || value === "") && field && field.required && options.length) value = options[0];
    if (value === undefined || value === "") continue;
    const type = String((field && field.type) || "").toUpperCase();
    if (type === "BOOLEAN") body[key] = typeof value === "string" ? value.toLowerCase() === "true" : !!value;
    else if (type === "INT" || type === "INTEGER") body[key] = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : value;
    else if (type === "FLOAT" || type === "NUMBER") body[key] = Number.isFinite(Number(value)) ? Number(value) : value;
    else body[key] = value;
  }
}
function applyExplicitSchemaParams(body, schema, values) {
  for (const field of schema) {
    const fieldKey = String((field && (field.fieldKey || field.key)) || "").trim();
    if (!fieldKey || !Object.prototype.hasOwnProperty.call(values, fieldKey) || /^(prompt|image|images|imageUrls?|video|videos|videoUrls?|audio|audios|audioUrls?|reference_?(?:images?|videos?|audios?))$/i.test(fieldKey)) continue;
    const value = values[fieldKey];
    const type = String((field && field.type) || "").toUpperCase();
    if (type === "BOOLEAN") body[fieldKey] = typeof value === "string" ? value.toLowerCase() === "true" : Boolean(value);
    else if (["INT", "INTEGER"].includes(type) && Number.isFinite(Number(value))) body[fieldKey] = Math.trunc(Number(value));
    else if (["FLOAT", "NUMBER"].includes(type) && Number.isFinite(Number(value))) body[fieldKey] = Number(value);
    else body[fieldKey] = schemaValue(field, value);
  }
}
// runninghub.ts:448-466
function aspectFromSize(size, fallback = "1:1") {
  const pair = /^(\d+)x(\d+)$/i.exec(String(size || "").trim());
  if (pair) {
    let a = Number(pair[1]); let b = Number(pair[2]);
    const gcd = (x, y) => (y ? gcd(y, x % y) : x);
    const divisor = gcd(a, b) || 1; a /= divisor; b /= divisor;
    return a + ":" + b;
  }
  return /^\d+\s*:\s*\d+$/.test(String(size || "")) ? String(size).replace(/\s/g, "") : fallback;
}
function resolutionFromSize(size, fallback = "2k") {
  const pair = /^(\d+)x(\d+)$/i.exec(String(size || "").trim());
  if (pair) {
    const edge = Math.max(Number(pair[1]), Number(pair[2]));
    return edge >= 3072 ? "4k" : edge >= 1536 ? "2k" : "1k";
  }
  const raw = String(size || "").trim().toLowerCase();
  return ["1k", "2k", "4k", "480p", "720p", "1080p", "native1080p"].includes(raw) ? raw : fallback;
}
// runninghub.ts:291-294
function endpointForModel(model) {
  const clean = cleanEndpoint(model);
  return ENDPOINT_ALIASES[clean] || clean;
}

function createRunningHubIntegration(options = {}) {
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : null;
  const credentials = options.credentials && typeof options.credentials === "object" ? options.credentials : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const cacheDir = options.cacheDir ? String(options.cacheDir) : null;
  const endpoints = Object.assign({
    baseUrl: RUNNINGHUB_DEFAULT_BASE_URL,
    llm: RUNNINGHUB_DEFAULT_LLM_BASE_URL,
    registry: RUNNINGHUB_DEFAULT_REGISTRY_URL,
  }, options.endpoints && typeof options.endpoints === "object" ? options.endpoints : {});
  const injectedDefinition = typeof options.modelDefinition === "function" ? options.modelDefinition : null;
  const injectedDefinitions = options.modelDefinitions && typeof options.modelDefinitions === "object" ? options.modelDefinitions : null;
  const defaultTimeout = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 180000;

  let memoryRegistryCache = null;

  const credentialsAvailable = () => !!credentials && typeof credentials.available === "function" && credentials.available() === true;

  function unavailable(detail) { return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail }; }

  /** 网络出口：执行器注入的 transport 优先，其次装配注入的 fetch。 */
  function resolveFetch(transport) {
    if (transport && typeof transport.fetch === "function") return transport.fetch;
    return typeof fetchImpl === "function" ? fetchImpl : null;
  }
  function resolveClock(injected) {
    return injected && typeof injected.now === "function" && typeof injected.sleep === "function"
      ? injected
      : { now: () => clock(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  }
  function readStored(ref) {
    if (!credentialsAvailable()) return "";
    try { return asStr(credentials.get(ref), 4096).trim(); } catch { return ""; }
  }
  // runninghub.ts:160-164（provider 优先，其次 credential-store）
  function resolveKey(provider, wallet = false) {
    const p = provider || {};
    const apiKey = asStr(p.api_key, 4096).trim();
    const walletKey = asStr(p.wallet_api_key, 4096).trim();
    const storedApi = readStored(CREDENTIAL_REFS.apiKey);
    const storedWallet = readStored(CREDENTIAL_REFS.walletApiKey);
    return wallet ? (walletKey || storedWallet || apiKey || storedApi) : (apiKey || storedApi || walletKey || storedWallet);
  }
  function authHeaders(key, wallet = false) {
    return { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + (wallet ? key : key) };
  }

  function maskSecret(value) {
    const text = asStr(value, 4096).trim();
    if (!text) return "";
    return text.length <= 8 ? "•".repeat(text.length) : text.slice(0, 4) + "••••" + text.slice(-4);
  }
  function credentialState() {
    const apiKey = readStored(CREDENTIAL_REFS.apiKey);
    const walletKey = readStored(CREDENTIAL_REFS.walletApiKey);
    return {
      safeStorageAvailable: credentialsAvailable(),
      apiKeySet: !!apiKey,
      apiKeyMask: maskSecret(apiKey),
      walletApiKeySet: !!walletKey,
      walletApiKeyMask: maskSecret(walletKey),
    };
  }
  function credentialProbe() {
    if (!credentialsAvailable()) return { ok: null, status: "unknown", detail: "safeStorage 不可用，凭据由 provider.api_key 或系统安全存储提供" };
    const apiKey = readStored(CREDENTIAL_REFS.apiKey);
    const walletKey = readStored(CREDENTIAL_REFS.walletApiKey);
    return apiKey || walletKey
      ? { ok: true, status: "ok", detail: "已配置 RunningHub API Key" }
      : { ok: false, status: "missing", detail: "未配置 RunningHub API Key（credential-store 中无 " + CREDENTIAL_REFS.apiKey + "）" };
  }
  function saveCredential(input = {}) {
    const apiKey = asStr(input.apiKey, 4096).trim();
    const walletApiKey = asStr(input.walletApiKey, 4096).trim();
    if (!apiKey && !walletApiKey) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "apiKey 或 walletApiKey 至少需要一个" };
    if (!credentialsAvailable()) return unavailable("safeStorage 不可用，RunningHub API Key 无法加密保存（为不落明文，本功能停用）");
    if (apiKey) credentials.put(CREDENTIAL_REFS.apiKey, apiKey);
    if (walletApiKey) credentials.put(CREDENTIAL_REFS.walletApiKey, walletApiKey);
    return { ok: true, value: credentialState() };
  }
  function deleteCredential() {
    if (credentialsAvailable()) {
      try { credentials.delete(CREDENTIAL_REFS.apiKey); } catch { /* 忽略 */ }
      try { credentials.delete(CREDENTIAL_REFS.walletApiKey); } catch { /* 忽略 */ }
    }
    return { ok: true, value: credentialState() };
  }
  function status() {
    return {
      ok: true,
      value: {
        fetchInjected: typeof fetchImpl === "function",
        baseUrl: endpoints.baseUrl,
        llmBaseUrl: endpoints.llm,
        registryUrl: endpoints.registry,
        endpointAliases: { ...ENDPOINT_ALIASES },
        ...credentialState(),
      },
    };
  }

  // runninghub.ts:168-181（网络出口改为注入 net）
  async function requestJson(net, url, init, timeoutMs = defaultTimeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await net(url, { ...init, signal: ctrl.signal });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
      if (!response.ok) throw new Error("RunningHub HTTP " + response.status + ": " + (typeof payload === "string" ? payload.slice(0, 500) : JSON.stringify(payload).slice(0, 500)));
      return payload;
    } catch (error) {
      if (ctrl.signal.aborted) throw new Error("RunningHub 请求超时");
      throw error;
    } finally { clearTimeout(timer); }
  }

  // runninghub.ts:213-234
  function registryCachePath() { return cacheDir ? path.join(cacheDir, MODEL_REGISTRY_CACHE_FILE_NAME) : null; }
  function readRegistryCache() {
    if (memoryRegistryCache && memoryRegistryCache.items && memoryRegistryCache.items.length) return memoryRegistryCache;
    const file = registryCachePath();
    if (!file) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const items = registryItems(raw && raw.items);
      if (!items.length) return null;
      memoryRegistryCache = { updatedAt: Number(raw && raw.updatedAt) || 0, items };
      return memoryRegistryCache;
    } catch { return null; }
  }
  function writeRegistryCache(items) {
    if (!items.length) return;
    memoryRegistryCache = { updatedAt: clock(), items };
    const file = registryCachePath();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + "." + process.pid + ".tmp";
      fs.writeFileSync(temp, JSON.stringify(memoryRegistryCache), "utf8");
      fs.renameSync(temp, file);
    } catch { /* 网络结果仍可用于本次请求 */ }
  }
  async function optionalRegistryRequest(net, url, init, timeoutMs) {
    try { return registryItems(await requestJson(net, url, init, timeoutMs)); } catch { return []; }
  }

  // runninghub.ts:240-268
  async function fetchRunningHubModelsArray(provider, timeoutMs, ctx) {
    const net = ctx.net;
    const cached = readRegistryCache();
    const cacheFresh = !!(cached && cached.items && cached.items.length) && clock() - cached.updatedAt < MODEL_REGISTRY_CACHE_TTL_MS;
    const requestTimeout = Math.max(3000, Math.min(12000, Number.isFinite(timeoutMs) ? timeoutMs : 30000));
    const [openApiItems, githubItems, llmItems] = await Promise.all([
      optionalRegistryRequest(net, openApiUrl(provider, "models", endpoints.baseUrl), { headers: authHeaders(ctx.key) }, requestTimeout),
      cacheFresh ? Promise.resolve([]) : optionalRegistryRequest(net, endpoints.registry, { headers: { Accept: "application/json" } }, requestTimeout),
      optionalRegistryRequest(net, String(endpoints.llm).replace(/\/+$/, "") + "/models", { headers: authHeaders(ctx.key) }, requestTimeout),
    ]);
    if (githubItems.length >= 100) writeRegistryCache(githubItems);
    const found = [
      ...(githubItems.length ? githubItems : (cached && cached.items) || []),
      ...openApiItems,
      ...llmItems,
    ];
    const byId = new Map();
    for (const item of found) {
      const id = modelId(item);
      if (id) byId.set(id, { ...(byId.get(id) || {}), ...item });
    }
    for (const id of FALLBACK_CHAT) if (!byId.has(id)) byId.set(id, { name_en: id, output_type: "chat" });
    for (const id of FALLBACK_IMAGE) if (!byId.has(id)) byId.set(id, { name_en: id, output_type: "image" });
    for (const id of FALLBACK_VIDEO) if (!byId.has(id)) byId.set(id, { name_en: id, output_type: "video" });
    return [...byId].map(([model, raw]) => {
      const type = classifyModel(raw);
      return { model, name: modelLabel(raw, model), type, protocol: "runninghub", raw };
    });
  }

  // runninghub.ts:296-315（metadata / 注入定义 → 注册表）
  async function runningHubModelDefinition(provider, model, timeoutMs, ctx) {
    const requested = cleanEndpoint(model);
    const metadata = ctx.metadata;
    if (metadata && typeof metadata === "object" && metadata.endpoint) {
      const parameters = Array.isArray(metadata.parameters) ? metadata.parameters : Array.isArray(metadata.params) ? metadata.params : [];
      return { name_en: requested, endpoint: cleanEndpoint(metadata.endpoint), params: parameters.map((field) => ({ ...field, fieldKey: field.key || field.fieldKey })) };
    }
    const injected = injectedDefinition ? injectedDefinition(requested) : injectedDefinitions ? injectedDefinitions[requested] : undefined;
    if (injected) {
      if (Array.isArray(injected)) return { name_en: requested, endpoint: endpointForModel(requested), params: injected };
      if (typeof injected === "object") {
        const parameters = Array.isArray(injected.params) ? injected.params : Array.isArray(injected.parameters) ? injected.parameters : [];
        return { name_en: requested, endpoint: cleanEndpoint(injected.endpoint) || endpointForModel(requested), params: parameters };
      }
    }
    const items = await fetchRunningHubModelsArray(provider, timeoutMs, ctx);
    const found = items.find((item) => {
      const endpoint = cleanEndpoint(item.raw && item.raw.endpoint);
      return item.model === requested || endpoint === requested;
    });
    const raw = (found && found.raw) || {};
    return {
      ...raw,
      name_en: (found && found.model) || requested,
      endpoint: cleanEndpoint(raw.endpoint) || endpointForModel((found && found.model) || requested),
      params: Array.isArray(raw.params) ? raw.params : [],
    };
  }

  // runninghub.ts:345-369
  async function buildRunningHubImageModelRequest(provider, model, params, referenceUrls, timeoutMs, ctx) {
    const definition = await runningHubModelDefinition(provider, model, Math.min(timeoutMs, 12000), ctx);
    const schema = definition.params || [];
    const body = { prompt: String((params && params.prompt) || "") };
    const size = String((params && params.size) || "");
    const pair = /^(\d+)x(\d+)$/.exec(size);
    const aspectField = schemaField(schema, "aspectRatio", "ratio");
    const resolutionField = schemaField(schema, "resolution");
    if (aspectField) body[String(aspectField.fieldKey)] = schemaValue(aspectField, aspectFromSize(size));
    else if (!schema.length && size.includes(":")) body.aspectRatio = size;
    if (resolutionField) body[String(resolutionField.fieldKey)] = schemaValue(resolutionField, resolutionFromSize(size));
    if (pair) {
      const widthField = schemaField(schema, "width"); const heightField = schemaField(schema, "height");
      if (widthField || !schema.length) body[String((widthField && widthField.fieldKey) || "width")] = Number(pair[1]);
      if (heightField || !schema.length) body[String((heightField && heightField.fieldKey) || "height")] = Number(pair[2]);
    }
    if (referenceUrls && referenceUrls.length) {
      const imageField = schemaField(schema, "imageUrls", "imageUrl", "images", "image");
      const imageKey = String((imageField && imageField.fieldKey) || "imageUrls");
      body[imageKey] = imageField && imageField.multipleInputs !== true && !imageKey.endsWith("s") ? referenceUrls[0] : referenceUrls;
    }
    applyExplicitSchemaParams(body, schema, params || {});
    applySchemaDefaults(body, schema);
    return { model, outputKind: "image", endpoint: definition.endpoint || endpointForModel(model), body };
  }

  // runninghub.ts:371-395
  async function buildRunningHubVideoModelRequest(provider, model, params, references, timeoutMs, ctx) {
    const definition = await runningHubModelDefinition(provider, model, Math.min(timeoutMs, 12000), ctx);
    const schema = definition.params || [];
    const body = { prompt: String((params && params.prompt) || "") };
    const assignCanonical = (value, fallbackKey, ...keys) => {
      const field = schemaField(schema, ...keys);
      if (field) body[String(field.fieldKey || field.key)] = schemaValue(field, value);
      else if (!schema.length) body[fallbackKey] = value;
    };
    assignCanonical(params && params.duration, "duration", "duration", "seconds");
    assignCanonical(params && params.aspect_ratio, "aspectRatio", "aspectRatio", "aspect_ratio", "ratio");
    assignCanonical(params && params.resolution, "resolution", "resolution");
    const assignReferences = (values, fallbackKey, ...keys) => {
      if (!values || !values.length) return;
      const field = schemaField(schema, ...keys);
      const key = String((field && (field.fieldKey || field.key)) || fallbackKey);
      body[key] = field && field.multipleInputs !== true && !key.endsWith("s") ? values[0] : values;
    };
    assignReferences(references && references.images, "imageUrls", "imageUrls", "imageUrl", "images", "image");
    assignReferences(references && references.videos, "videoUrls", "videoUrls", "videoUrl", "videos", "video");
    assignReferences(references && references.audios, "audioUrls", "audioUrls", "audioUrl", "audios", "audio");
    applyExplicitSchemaParams(body, schema, params || {});
    applySchemaDefaults(body, schema);
    return { model, outputKind: "video", endpoint: definition.endpoint || endpointForModel(model), body };
  }

  // runninghub.ts:397-400
  async function submitRunningHubModelRequest(provider, request, timeoutMs, ctx) {
    const raw = await requestJson(ctx.net, openApiUrl(provider, request.endpoint, endpoints.baseUrl), { method: "POST", headers: authHeaders(ctx.key), body: JSON.stringify(request.body) }, timeoutMs);
    return modelTaskState(raw, request.outputKind);
  }
  // runninghub.ts:402-405
  async function queryRunningHubModelTask(provider, id, outputKind, timeoutMs, ctx) {
    const raw = await requestJson(ctx.net, openApiUrl(provider, "query", endpoints.baseUrl), { method: "POST", headers: authHeaders(ctx.key), body: JSON.stringify({ taskId: id }) }, timeoutMs);
    return modelTaskState(raw, outputKind, id);
  }
  // runninghub.ts:570-581
  async function waitOpenApi(provider, id, timeoutMs, ctx, clockOverride) {
    const time = resolveClock(clockOverride);
    const deadline = time.now() + timeoutMs;
    while (time.now() < deadline) {
      await time.sleep(2500);
      const raw = await requestJson(ctx.net, openApiUrl(provider, "query", endpoints.baseUrl), { method: "POST", headers: authHeaders(ctx.key), body: JSON.stringify({ taskId: id }) }, Math.min(60000, timeoutMs));
      const urls = runningHubOutputUrls(raw);
      const status = String((raw && (raw.status || raw.state)) || (raw && raw.data && (raw.data.status || raw.data.state)) || "").toUpperCase();
      if (urls.length || ["SUCCESS", "SUCCEEDED", "COMPLETED", "DONE", "FINISHED"].includes(status)) return raw;
      if (["FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(status)) throw new Error(String((raw && (raw.msg || raw.message)) || "RunningHub 任务失败"));
    }
    throw new Error("RunningHub 任务超时");
  }

  // runninghub.ts:485-522（上传：FormData / Blob，Node 18+ 全局可用）
  async function uploadBuffer(provider, input, ctx, useWallet = true, timeoutMs = 240000) {
    const url = providerBase(provider, endpoints.baseUrl) + "/task/openapi/upload";
    const credentialValue = useWallet ? resolveKey(provider, true) : resolveKey(provider, false);
    if (!credentialValue) throw new Error("未配置 RunningHub API Key");
    const form = new FormData();
    form.append("apiKey", credentialValue);
    form.append("fileType", "input");
    form.append("file", new Blob([new Uint8Array(input.buf)], { type: input.mime || "application/octet-stream" }), input.name || "asset.bin");
    const raw = await requestJson(ctx.net, url, { method: "POST", headers: { Accept: "application/json", Authorization: "Bearer " + credentialValue }, body: form }, timeoutMs);
    const value = String((raw && raw.data && (raw.data.fileName || raw.data.url)) || (raw && (raw.fileName || raw.url)) || "");
    if (!value) throw new Error(String((raw && raw.msg) || "RunningHub 素材上传失败"));
    return value;
  }
  // runninghub.ts:524-544
  async function uploadRunningHubModelReference(provider, input, ctx, timeoutMs = 240000) {
    const publicUrl = String((input && input.publicUrl) || "").trim();
    if (/^https?:\/\//i.test(publicUrl)) return publicUrl;
    const key = resolveKey(provider, true);
    if (!key) throw new Error("未配置 RunningHub API Key");
    const form = new FormData();
    const fileName = basename((input && input.name) || "asset.bin") || "asset.bin";
    form.append("file", new Blob([new Uint8Array(input.buf)], { type: input.mime || "application/octet-stream" }), fileName);
    const raw = await requestJson(ctx.net, openApiUrl(provider, "media/upload/binary", endpoints.baseUrl), { method: "POST", headers: { Accept: "application/json", Authorization: "Bearer " + key }, body: form }, timeoutMs);
    const roots = [raw, raw && raw.data].filter((value) => value && typeof value === "object");
    for (const value of roots) {
      const url = String(value.download_url || value.downloadUrl || value.url || value.fileUrl || value.file_url || "").trim();
      if (/^https?:\/\//i.test(url)) return url;
    }
    throw new Error("RunningHub 模型素材上传未返回 download_url：" + JSON.stringify(raw).slice(0, 500));
  }
  // runninghub.ts:545-547
  async function uploadRunningHubAsset(provider, input, useWallet = true, timeoutMs, transport) {
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），RunningHub 素材上传不可用");
    const key = resolveKey(provider, useWallet);
    if (!key) return unavailable("未配置 RunningHub API Key：" + (useWallet ? "账户余额 API Key" : "RH币 API Key"));
    try {
      const value = await uploadBuffer(provider, input, { net, key }, useWallet, timeoutMs);
      return { ok: true, value: { fileName: value } };
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }

  // runninghub.ts:583-592
  async function generateRunningHubImages(provider, model, params, timeoutMs, transport, clockOverride) {
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），RunningHub 图片生成不可用");
    const key = resolveKey(provider, false);
    if (!key) return unavailable("未配置 RunningHub API Key：请在「集成 · RunningHub」保存，或为 provider 提供 api_key");
    const effectiveTimeout = Number.isFinite(timeoutMs) ? Number(timeoutMs) : defaultTimeout;
    const ctx = { net, key, endpoints, metadata: (params && params.metadata) || options.metadata || null };
    try {
      const refs = (params && params.reference_images) || [];
      const request = await buildRunningHubImageModelRequest(provider, model, params, refs, effectiveTimeout, ctx);
      const state = await submitRunningHubModelRequest(provider, request, effectiveTimeout, ctx);
      let raw = state.raw;
      if (state.taskId && state.status === "RUNNING") raw = await waitOpenApi(provider, state.taskId, effectiveTimeout, ctx, clockOverride);
      const images = runningHubOutputUrls(raw).map((value) => ({
        type: value.startsWith("data:") ? "b64" : "url",
        value: value.startsWith("data:") ? value.split(",")[1] || value : value,
      }));
      if (!images.length) return { ok: false, error: REQUEST_FAILED, detail: "RunningHub 任务完成但没有返回图片：" + JSON.stringify(raw).slice(0, 800) };
      return { images, raw };
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }

  // runninghub.ts:594-598
  async function editRunningHubImages(provider, model, params, inputs, timeoutMs, transport, clockOverride) {
    if (!Array.isArray(inputs) || !inputs.length) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "RunningHub 图像编辑需要至少一张参考图" };
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），RunningHub 图像编辑不可用");
    const key = resolveKey(provider, true);
    if (!key) return unavailable("未配置 RunningHub API Key：请在「集成 · RunningHub」保存，或为 provider 提供 api_key");
    const effectiveTimeout = Number.isFinite(timeoutMs) ? Number(timeoutMs) : defaultTimeout;
    const ctx = { net, key, endpoints, metadata: (params && params.metadata) || options.metadata || null };
    try {
      const imageUrls = await Promise.all(inputs.map((input) => uploadRunningHubModelReference(provider, input, ctx, effectiveTimeout)));
      return generateRunningHubImages(provider, model, { ...(params || {}), reference_images: imageUrls }, effectiveTimeout, transport, clockOverride);
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }

  // runninghub.ts:600-615
  async function generateRunningHubVideos(provider, model, params, timeoutMs, transport, clockOverride) {
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），RunningHub 视频生成不可用");
    const key = resolveKey(provider, false);
    if (!key) return unavailable("未配置 RunningHub API Key：请在「集成 · RunningHub」保存，或为 provider 提供 api_key");
    const effectiveTimeout = Number.isFinite(timeoutMs) ? Number(timeoutMs) : defaultTimeout;
    const ctx = { net, key, endpoints, metadata: (params && params.metadata) || options.metadata || null };
    try {
      const [refs, videoRefs, audioRefs] = await Promise.all([
        Promise.all(((params && params.images) || []).map((item) => uploadRunningHubModelReference(provider, item, ctx, effectiveTimeout))),
        Promise.all(((params && params.videos) || []).map((item) => uploadRunningHubModelReference(provider, item, ctx, effectiveTimeout))),
        Promise.all(((params && params.audios) || []).map((item) => uploadRunningHubModelReference(provider, item, ctx, effectiveTimeout))),
      ]);
      const request = await buildRunningHubVideoModelRequest(provider, model, params, { images: refs, videos: videoRefs, audios: audioRefs }, effectiveTimeout, ctx);
      const state = await submitRunningHubModelRequest(provider, request, effectiveTimeout, ctx);
      let raw = state.raw;
      if (state.taskId && state.status === "RUNNING") raw = await waitOpenApi(provider, state.taskId, effectiveTimeout, ctx, clockOverride);
      const videos = runningHubOutputUrls(raw, "video").map((value) => ({ type: "url", value }));
      if (!videos.length) return { ok: false, error: REQUEST_FAILED, detail: "RunningHub 任务完成但没有返回视频" };
      return { videos, raw };
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }

  // runninghub.ts:240-268 的列表投影（命令 integration/runninghub/models 使用）
  async function listModels(provider, timeoutMs, transport) {
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），RunningHub 模型目录不可用");
    const key = resolveKey(provider, true);
    if (!key) return unavailable("未配置 RunningHub API Key：请在「集成 · RunningHub」保存，或为 provider 提供 api_key");
    try {
      const items = await fetchRunningHubModelsArray(provider, timeoutMs, { net, key, endpoints });
      return { ok: true, value: { items } };
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }

  // runninghub.ts:667-673
  async function inspectRunningHubApp(provider, appId, timeoutMs, transport) {
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），RunningHub AI 应用解析不可用");
    const key = resolveKey(provider, true);
    if (!key) return unavailable("未配置 RunningHub API Key");
    try {
      const url = providerBase(provider, endpoints.baseUrl) + "/api/webapp/apiCallDemo?apiKey=" + encodeURIComponent(key) + "&webappId=" + encodeURIComponent(appId);
      const raw = await requestJson(net, url, { headers: authHeaders(key) }, Number.isFinite(timeoutMs) ? timeoutMs : 30000);
      if (raw && raw.code != null && ![0, "0"].includes(raw.code)) return { ok: false, error: REQUEST_FAILED, detail: String(raw.msg || "RunningHub AI 应用解析失败") };
      return { ok: true, value: (raw && raw.data) || raw };
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }
  // runninghub.ts:674-679
  async function inspectRunningHubWorkflow(provider, workflowId, timeoutMs, transport) {
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），RunningHub 工作流解析不可用");
    const key = resolveKey(provider, true);
    if (!key) return unavailable("未配置 RunningHub API Key");
    try {
      const raw = await requestJson(net, providerBase(provider, endpoints.baseUrl) + "/api/openapi/getJsonApiFormat", { method: "POST", headers: authHeaders(key), body: JSON.stringify({ apiKey: key, workflowId }) }, Number.isFinite(timeoutMs) ? timeoutMs : 30000);
      if (raw && raw.code != null && ![0, "0"].includes(raw.code)) return { ok: false, error: REQUEST_FAILED, detail: String(raw.msg || "RunningHub 工作流解析失败") };
      const workflowJson = parseRunningHubWorkflowPayload(raw);
      return { ok: true, value: { workflowId, fields: fieldsFromWorkflow(workflowJson), workflowJson, raw } };
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }
  // runninghub.ts:680-694
  function sanitizeNodeInfo(fields) {
    return (fields || []).filter((field) => field && field.enabled !== false && field.nodeId && field.fieldName).map((field) => ({ nodeId: String(field.nodeId), fieldName: String(field.fieldName), fieldValue: String(field.fieldValue == null ? "" : field.fieldValue) }));
  }
  async function submitRunningHubEntry(provider, kind, id, fields, useWallet = false, workflow, instanceType = "", transport) {
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），RunningHub 提交不可用");
    const key = resolveKey(provider, useWallet);
    if (!key) return unavailable("未配置 RunningHub API Key");
    try {
      const body = { apiKey: key, nodeInfoList: sanitizeNodeInfo(fields) };
      if (String(instanceType).trim()) body.instanceType = String(instanceType).trim();
      let subPath = "/task/openapi/ai-app/run";
      if (kind === "app") body.webappId = id;
      else { subPath = "/task/openapi/create"; body.workflowId = id; body.addMetadata = true; if (workflow) body.workflow = typeof workflow === "string" ? workflow : JSON.stringify(workflow); }
      const raw = await requestJson(net, providerBase(provider, endpoints.baseUrl) + subPath, { method: "POST", headers: authHeaders(key, useWallet), body: JSON.stringify(body) }, defaultTimeout);
      if (raw && raw.code != null && ![0, "0"].includes(raw.code)) return { ok: false, error: REQUEST_FAILED, detail: String(raw.msg || raw.message || "RunningHub 提交失败") };
      const idOut = taskId(raw);
      if (!idOut) return { ok: false, error: REQUEST_FAILED, detail: "RunningHub 未返回 taskId" };
      return { ok: true, value: { taskId: idOut, raw } };
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }
  // runninghub.ts:695-700
  async function queryRunningHubTask(provider, id, useWallet = false, transport) {
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），RunningHub 任务查询不可用");
    const key = resolveKey(provider, useWallet);
    if (!key) return unavailable("未配置 RunningHub API Key");
    try {
      const raw = await requestJson(net, providerBase(provider, endpoints.baseUrl) + "/task/openapi/outputs", { method: "POST", headers: authHeaders(key, useWallet), body: JSON.stringify({ apiKey: key, taskId: id }) }, 240000);
      const code = raw && raw.code;
      const status = [0, "0"].includes(code) ? "SUCCESS" : [804, "804"].includes(code) ? "RUNNING" : [813, "813"].includes(code) ? "QUEUED" : [805, "805"].includes(code) ? "FAILED" : "UNKNOWN";
      return { ok: true, value: { status, urls: runningHubOutputUrls(raw && raw.data), failReason: (raw && (raw.msg || raw.message)) || "", code, raw } };
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }

  return {
    credentialRefs: CREDENTIAL_REFS,
    constants: Object.freeze({
      RUNNINGHUB_DEFAULT_BASE_URL,
      RUNNINGHUB_DEFAULT_LLM_BASE_URL,
      RUNNINGHUB_DEFAULT_REGISTRY_URL,
      FALLBACK_CHAT,
      FALLBACK_IMAGE,
      FALLBACK_VIDEO,
      ENDPOINT_ALIASES,
    }),
    isRunningHubUrl,
    runningHubOutputUrls,
    taskId,
    modelTaskState,
    parseRunningHubWorkflowPayload,
    fieldsFromWorkflow,
    endpointForModel,
    resolveKey,
    credentialState,
    credentialProbe,
    saveCredential,
    deleteCredential,
    status,
    generateRunningHubImages,
    editRunningHubImages,
    generateRunningHubVideos,
    listModels,
    inspectRunningHubApp,
    inspectRunningHubWorkflow,
    submitRunningHubEntry,
    queryRunningHubTask,
    uploadRunningHubAsset,
  };
}

module.exports = {
  createRunningHubIntegration,
  isRunningHubUrl,
  runningHubOutputUrls,
  modelTaskState,
  endpointForModel,
  parseRunningHubWorkflowPayload,
  fieldsFromWorkflow,
  RUNNINGHUB_DEFAULT_BASE_URL,
  RUNNINGHUB_DEFAULT_LLM_BASE_URL,
  RUNNINGHUB_DEFAULT_REGISTRY_URL,
  ENDPOINT_ALIASES,
  CREDENTIAL_REFS,
};
