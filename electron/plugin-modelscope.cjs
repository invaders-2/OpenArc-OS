/**
 * B7e2 · ModelScope 可选插件（逐函数移植 server/modelscope.ts:1-153）。
 *
 * 逐函数对应（源文件:行号）：
 *   modelscope.ts:3-16    MODELSCOPE_CN_BASE_URL / GLOBAL_BASE_URL / DEFAULTS_VERSION / IMAGE_MODELS / CHAT_MODELS
 *   modelscope.ts:18-31   ModelScopeLora / MODELSCOPE_DEFAULT_LORAS
 *   modelscope.ts:33-55   normalizeModelScopeLoras
 *   modelscope.ts:57-59   endpoint（baseUrl 归一 + 路径拼接）
 *   modelscope.ts:61-63   imageDataUrl
 *   modelscope.ts:65-77   collectImages（output_images / images / data[]）
 *   modelscope.ts:79-92   loraPayload
 *   modelscope.ts:94-145  runModelScopeImageTask（异步提交 + tasks/{id} 轮询）
 *   modelscope.ts:147-149 generateModelScopeImages
 *   modelscope.ts:151-153 editModelScopeImages
 *
 * 与源文件的差异（任务书硬要求，不是行为漂移）：
 *   · **网络一律经注入 fetch / transport**；未注入即结构化 { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }；
 *   · 访问令牌走 credential-store（ref = modelscope.accessToken），磁盘不落明文；未配置同样结构化不可用；
 *   · 轮询等待走注入 clock（默认真实时钟），远端地址可注入（测试指向本地 127.0.0.1 stub，离线可跑）；
 *   · 返回值沿用源协议形状：成功 { images, raw }，失败 { ok:false, error, detail }（不 throw 到 IPC 出口）。
 *
 * OUT（不引入）：任何 api.dx-os.com / 云发布 / 云端实时房间。
 */

"use strict";

const { INTEGRATION_ERR_UNAVAILABLE, INTEGRATION_ERR_INVALID_INPUT } = require("./plugin-registry.cjs");

// modelscope.ts:3-5 逐字搬运
const MODELSCOPE_CN_BASE_URL = "https://api-inference.modelscope.cn/v1";
const MODELSCOPE_GLOBAL_BASE_URL = "https://api-inference.modelscope.ai/v1";
const MODELSCOPE_DEFAULTS_VERSION = 3;

// modelscope.ts:6-16 逐字搬运
const MODELSCOPE_IMAGE_MODELS = Object.freeze([
  "Tongyi-MAI/Z-Image-Turbo",
  "Qwen/Qwen-Image-2512",
  "Qwen/Qwen-Image-Edit-2511",
  "black-forest-labs/FLUX.2-klein-9B",
]);
const MODELSCOPE_CHAT_MODELS = Object.freeze([
  "Qwen/Qwen3-235B-A22B",
  "Qwen/Qwen3-VL-235B-A22B-Instruct",
  "MiniMax/MiniMax-M2.7:MiniMax",
]);

// modelscope.ts:27-31 逐字搬运
const MODELSCOPE_DEFAULT_LORAS = Object.freeze([
  Object.freeze({ id: "Daniel8152/film", name: "Z-Image Film", target_model: "Tongyi-MAI/Z-Image-Turbo", strength: 0.8, enabled: true, note: "" }),
  Object.freeze({ id: "Daniel8152/Qwen-Image-2512-Film", name: "Qwen Image 2512 Film", target_model: "Qwen/Qwen-Image-2512", strength: 0.8, enabled: true, note: "" }),
  Object.freeze({ id: "Daniel8152/Klein-enhance", name: "Klein enhance", target_model: "black-forest-labs/FLUX.2-klein-9B", strength: 0.8, enabled: true, note: "" }),
]);

const CREDENTIAL_REF = "modelscope.accessToken";
const REQUEST_FAILED = "INTEGRATION_REQUEST_FAILED";

const asStr = (value, max = 4096) => (typeof value === "string" ? value.slice(0, max) : value == null ? "" : String(value).slice(0, max));

/** modelscope.ts:57-59 逐字移植。 */
function endpoint(baseUrl, path) {
  return String(baseUrl || MODELSCOPE_CN_BASE_URL).trim().replace(/\/+$/, "") + "/" + String(path).replace(/^\/+/, "");
}

/** modelscope.ts:61-63 逐字移植。 */
function imageDataUrl(input) {
  return "data:" + (input.mime || "image/png") + ";base64," + input.buf.toString("base64");
}

/** modelscope.ts:65-77 逐字移植。 */
function collectImages(payload) {
  const values = [
    ...(Array.isArray(payload && payload.output_images) ? payload.output_images : []),
    ...(Array.isArray(payload && payload.images) ? payload.images : []),
    ...(Array.isArray(payload && payload.data) ? payload.data.map((item) => (item && (item.url || item.image_url || item.b64_json)) || undefined) : []),
  ].filter(Boolean);
  return values.map((value) => {
    const text = String(value);
    return /^data:image\//i.test(text)
      ? { type: "b64", value: text.replace(/^data:image\/[^;]+;base64,/i, "") }
      : { type: "url", value: text };
  });
}

/** modelscope.ts:79-92 逐字移植。 */
function loraPayload(params) {
  if (params.loras && typeof params.loras === "object" && !Array.isArray(params.loras)) {
    const out = {};
    for (const [id, strength] of Object.entries(params.loras)) {
      const value = Number(strength);
      if (id.trim() && Number.isFinite(value)) out[id.trim()] = Math.max(0, Math.min(2, value));
    }
    if (Object.keys(out).length) return out;
  }
  const id = String(params.modelscope_lora || "").trim();
  if (!id) return undefined;
  const strength = Number(params.modelscope_lora_strength != null ? params.modelscope_lora_strength : 0.8);
  return { [id]: Math.max(0, Math.min(2, Number.isFinite(strength) ? strength : 0.8)) };
}

/** modelscope.ts:33-55 逐字移植。 */
function normalizeModelScopeLoras(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw;
    const id = String(item.id || "").trim().slice(0, 180);
    const target = String(item.target_model || item.model || "").trim().slice(0, 180);
    if (!id || !target || seen.has(target + "\n" + id)) continue;
    seen.add(target + "\n" + id);
    const parsed = Number(item.strength != null ? item.strength : item.default_strength != null ? item.default_strength : 0.8);
    out.push({
      id,
      name: String(item.name || id).trim().replace(/\s+/g, " ").slice(0, 80) || id,
      target_model: target,
      strength: Math.max(0, Math.min(2, Number.isFinite(parsed) ? parsed : 0.8)),
      enabled: item.enabled !== false,
      note: String(item.note || "").trim().slice(0, 300),
    });
  }
  return out;
}

function createModelScopeIntegration(options = {}) {
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : null;
  const credentials = options.credentials && typeof options.credentials === "object" ? options.credentials : null;
  const clock = typeof options.clock === "function" ? options.clock : () => Date.now();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 300000;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? Number(options.pollIntervalMs) : 2000;

  const credentialsAvailable = () => !!credentials && typeof credentials.available === "function" && credentials.available() === true;

  function unavailable(detail) { return { ok: false, error: INTEGRATION_ERR_UNAVAILABLE, detail }; }

  /** 解析网络出口：执行器注入的 transport 优先，其次集成装配时注入的 fetch；都没有即不可用。 */
  function resolveFetch(transport) {
    if (transport && typeof transport.fetch === "function") return transport.fetch;
    return typeof fetchImpl === "function" ? fetchImpl : null;
  }

  /** 时钟：执行器注入的 { now, sleep } 优先，其次默认真实时钟。 */
  function resolveClock(injected) {
    return injected && typeof injected.now === "function" && typeof injected.sleep === "function"
      ? injected
      : { now: () => clock(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  }

  function readStored(ref) {
    if (!credentialsAvailable()) return "";
    try { return asStr(credentials.get(ref), 4096).trim(); } catch { return ""; }
  }

  /** 令牌解析：provider.api_key 优先，其次 credential-store（无明文落盘）。 */
  function resolveApiKey(provider) {
    const direct = provider && provider.api_key != null ? asStr(provider.api_key, 4096).trim() : "";
    return direct || readStored(CREDENTIAL_REF);
  }

  function maskSecret(value) {
    const text = asStr(value, 4096).trim();
    if (!text) return "";
    return text.length <= 8 ? "•".repeat(text.length) : text.slice(0, 4) + "••••" + text.slice(-4);
  }

  function credentialState() {
    const token = readStored(CREDENTIAL_REF);
    return {
      safeStorageAvailable: credentialsAvailable(),
      accessTokenSet: !!token,
      accessTokenMask: maskSecret(token),
      credentialRef: CREDENTIAL_REF,
    };
  }

  /** 供 plugin-registry 的 credential 依赖探测使用：ok=null 表示"探测不了"，不是"缺失"。 */
  function credentialProbe() {
    if (!credentialsAvailable()) return { ok: null, status: "unknown", detail: "safeStorage 不可用，凭据由 provider.api_key 或系统安全存储提供" };
    const token = readStored(CREDENTIAL_REF);
    return token
      ? { ok: true, status: "ok", detail: "已配置 ModelScope 访问令牌" }
      : { ok: false, status: "missing", detail: "未配置 ModelScope 访问令牌（credential-store 中无 " + CREDENTIAL_REF + "）" };
  }

  function saveCredential(input = {}) {
    const token = asStr(input.accessToken, 4096).trim();
    if (!token) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "accessToken 不能为空" };
    if (!credentialsAvailable()) return unavailable("safeStorage 不可用，ModelScope 访问令牌无法加密保存（为不落明文，本功能停用）");
    credentials.put(CREDENTIAL_REF, token);
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
        baseUrl: MODELSCOPE_CN_BASE_URL,
        defaultsVersion: MODELSCOPE_DEFAULTS_VERSION,
        imageModels: MODELSCOPE_IMAGE_MODELS.slice(),
        chatModels: MODELSCOPE_CHAT_MODELS.slice(),
        defaultLoras: MODELSCOPE_DEFAULT_LORAS.map((item) => ({ ...item })),
        ...credentialState(),
      },
    };
  }

  // modelscope.ts:94-145 逐函数移植（网络/令牌/时钟改为注入；轮询改为 clock 截止）。
  async function runModelScopeImageTask(provider, model, params, inputs, timeoutMsOverride, transport, clockOverride) {
    const net = resolveFetch(transport);
    if (typeof net !== "function") return unavailable("未注入 fetch（网络访问在主进程统一开关），ModelScope 不可用");
    const token = resolveApiKey(provider || {});
    if (!token) return unavailable("未配置 ModelScope 访问令牌：请在「集成 · ModelScope」保存令牌（写入系统安全存储），或为 provider 提供 api_key");
    const effectiveTimeout = Number.isFinite(timeoutMsOverride) ? Number(timeoutMsOverride) : timeoutMs;
    const time = resolveClock(clockOverride);
    const base = (provider && provider.base_url) || MODELSCOPE_CN_BASE_URL;
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      "X-ModelScope-Async-Mode": "true",
    };
    const body = { model, prompt: String((params && params.prompt) || "").trim() };
    if (params && params.size && params.size !== "auto") body.size = params.size;
    if (params && params.n) body.n = Math.max(1, Math.min(8, Number(params.n) || 1));
    if (inputs && inputs.length) body.image_url = inputs.map(imageDataUrl);
    const loras = loraPayload(params || {});
    if (loras) body.loras = loras;

    const deadline = time.now() + effectiveTimeout;
    try {
      const submit = await net(endpoint(base, "images/generations"), { method: "POST", headers, body: JSON.stringify(body) });
      const submitText = await submit.text();
      let payload;
      try { payload = JSON.parse(submitText); } catch { payload = submitText; }
      if (!submit.ok) {
        return { ok: false, error: REQUEST_FAILED, detail: "HTTP " + submit.status + ": " + (typeof payload === "string" ? payload.slice(0, 500) : JSON.stringify(payload).slice(0, 500)) };
      }
      let images = collectImages(payload);
      if (images.length) return { images, raw: payload };
      const taskId = String((payload && (payload.task_id || payload.taskId || payload.id)) || "").trim();
      if (!taskId) {
        return { ok: false, error: REQUEST_FAILED, detail: "ModelScope 未返回 task_id：" + JSON.stringify(payload).slice(0, 500) };
      }

      let last = payload;
      while (time.now() < deadline) {
        await time.sleep(pollIntervalMs);
        const result = await net(endpoint(base, "tasks/" + encodeURIComponent(taskId)), {
          headers: { ...headers, "X-ModelScope-Task-Type": "image_generation" },
        });
        const text = await result.text();
        try { last = JSON.parse(text); } catch { last = text; }
        if (!result.ok) {
          return { ok: false, error: REQUEST_FAILED, detail: "HTTP " + result.status + ": " + (typeof last === "string" ? last.slice(0, 500) : JSON.stringify(last).slice(0, 500)) };
        }
        images = collectImages(last);
        const status = String((last && (last.task_status || last.status)) || "").toUpperCase();
        if (images.length && (!status || ["SUCCEED", "SUCCEEDED", "SUCCESS", "COMPLETED"].includes(status))) return { images, raw: last };
        if (["FAILED", "FAILURE", "ERROR", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED"].includes(status)) {
          return { ok: false, error: REQUEST_FAILED, detail: "ModelScope 图片任务失败：" + JSON.stringify(last).slice(0, 500) };
        }
      }
      return { ok: false, error: REQUEST_FAILED, detail: "ModelScope 图片生成超时，请稍后重试。" };
    } catch (error) {
      return { ok: false, error: REQUEST_FAILED, detail: asStr((error && error.message) || error, 500) };
    }
  }

  // modelscope.ts:147-149
  async function generateModelScopeImages(provider, model, params, timeoutMsOverride, transport, clockOverride) {
    return runModelScopeImageTask(provider, model, params, [], timeoutMsOverride, transport, clockOverride);
  }

  // modelscope.ts:151-153
  async function editModelScopeImages(provider, model, params, inputs, timeoutMsOverride, transport, clockOverride) {
    if (!Array.isArray(inputs) || !inputs.length) return { ok: false, error: INTEGRATION_ERR_INVALID_INPUT, detail: "ModelScope 图像编辑需要至少一张参考图" };
    return runModelScopeImageTask(provider, model, params, inputs, timeoutMsOverride, transport, clockOverride);
  }

  return {
    credentialRef: CREDENTIAL_REF,
    constants: Object.freeze({
      MODELSCOPE_CN_BASE_URL,
      MODELSCOPE_GLOBAL_BASE_URL,
      MODELSCOPE_DEFAULTS_VERSION,
      MODELSCOPE_IMAGE_MODELS,
      MODELSCOPE_CHAT_MODELS,
      MODELSCOPE_DEFAULT_LORAS,
    }),
    normalizeModelScopeLoras,
    collectImages,
    loraPayload,
    resolveApiKey,
    credentialState,
    credentialProbe,
    saveCredential,
    deleteCredential,
    status,
    generateModelScopeImages,
    editModelScopeImages,
  };
}

module.exports = {
  createModelScopeIntegration,
  normalizeModelScopeLoras,
  collectImages,
  loraPayload,
  endpoint,
  imageDataUrl,
  MODELSCOPE_CN_BASE_URL,
  MODELSCOPE_GLOBAL_BASE_URL,
  MODELSCOPE_DEFAULTS_VERSION,
  MODELSCOPE_IMAGE_MODELS,
  MODELSCOPE_CHAT_MODELS,
  MODELSCOPE_DEFAULT_LORAS,
  CREDENTIAL_REF,
};
