/**
 * Anthropic Messages 官方协议适配器（x-api-key + anthropic-version: 2023-06-01）。
 *
 * 为什么单独一层：OpenAI 兼容适配器（provider-adapter.cjs）的请求形状是
 * Bearer + /chat/completions + choices[]，而 Anthropic 官方协议是 x-api-key +
 * /v1/messages + content[] 块 + 具名 SSE 事件；把两者塞进同一个函数会互相污染错误归一
 * 与流式解析。这里只做协议本身，凭据只在本层内部使用、绝不回传。
 *
 * 与 provider-adapter.cjs 保持同一形状：chat / chatStream / listModels / mapUsage，
 * 另给协议引擎（provider-protocol-service.cjs）用的 buildRequest / parseChatResponse / readSse。
 *
 * 依据（本仓 node_modules 内的官方向量 @anthropic-ai/sdk 0.123.0，官方文档站对本机
 * 地区拦截、匿名探测 api.anthropic.com 返回 403 "Request not allowed"，见
 * artifacts/dxos-anthropic-protocol/REPORT.md）：
 *   · node_modules/@anthropic-ai/sdk/client.js:841  anthropic-version: '2023-06-01'
 *   · node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:1882  Message.content[]
 *   · …/messages.d.ts:2094-2156  RawMessageStreamEvent（message_start / content_block_start /
 *     content_block_delta / content_block_stop / message_delta / message_stop）
 *   · …/messages.d.ts:2319  TextDelta{ type:'text_delta', text }
 *   · …/messages.d.ts:2859  Usage{ input_tokens, output_tokens, cache_* }
 *   · …/models.d.ts:13-155  GET /v1/models → { data: ModelInfo[] }（id/display_name/max_tokens）
 */
"use strict";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;
const MAX_MODELS = 500;

/** 官方鉴权头：x-api-key（不是 Authorization: Bearer）+ anthropic-version。 */
function authHeaders(apiKey) {
  return {
    "content-type": "application/json",
    accept: "application/json",
    "x-api-key": String(apiKey || ""),
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

/** baseUrl 规范化：base 已带 /v1 时不重复叠加（官方 base 与 /v1 base 都支持）。 */
function endpoint(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/v1$/i.test(base)) return base + path;
  return base + "/v1" + path;
}

/** data URL → Anthropic base64 图片块；http(s) URL → url 图片块。 */
function imageSourceFromUrl(value) {
  const url = String(value == null ? "" : value).trim();
  if (!url) return null;
  const match = url.match(/^data:([^;,]*)?(;[^,]*)?,([\s\S]*)$/i);
  if (match && String(match[2] || "").toLowerCase().split(";").includes("base64")) {
    return { type: "image", source: { type: "base64", media_type: String(match[1] || "image/png").trim() || "image/png", data: match[3].replace(/\s+/g, "") } };
  }
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

function imageBlockFromPart(part) {
  if (part.source && typeof part.source === "object") return { type: "image", source: part.source };
  const encoded = part.base64 ?? part.data;
  if (typeof encoded === "string" && encoded) {
    const declared = String(part.media_type || part.mime || part.mimeType || "image/png").split(";")[0].trim() || "image/png";
    return { type: "image", source: { type: "base64", media_type: declared, data: encoded.replace(/\s+/g, "") } };
  }
  return imageSourceFromUrl(part.dataUrl || part.url || part.image_url);
}

/** 文本归一：字符串原样，数组取全部文本块（用于 system 提取与降级）。 */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((part) => (part && typeof part === "object" ? String(part.text ?? part.content ?? "") : part == null ? "" : String(part)))
    .join("");
}

/** 统一 content → Anthropic content（string | Block[]）。视觉块走官方 image/source 形状。 */
function toAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return String(content);
  const blocks = [];
  for (const part of content) {
    if (part == null) continue;
    if (typeof part !== "object") { blocks.push({ type: "text", text: String(part) }); continue; }
    const type = String(part.type || "").toLowerCase();
    if (type === "text") { blocks.push({ type: "text", text: String(part.text ?? part.content ?? "") }); continue; }
    if (type === "image" || type === "image_url") { const block = imageBlockFromPart(type === "image_url" && part.image_url && typeof part.image_url === "object" ? { ...part, url: part.image_url.url } : part); if (block) blocks.push(block); continue; }
    // tool_use / tool_result / document 等官方块原样透传（形状由调用方负责）。
    blocks.push(part);
  }
  return blocks;
}

/**
 * system 提取 + 角色归并：Anthropic 只接受 user/assistant，system 走顶层 system 字段。
 * 显式 system 参数与 system 角色消息合并（\n\n 连接），与 legacy 执行器同一口径。
 */
function buildMessages({ messages, system = null, prompt = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const systems = [];
  if (system != null && String(system).length) systems.push(String(system));
  const out = [];
  for (const message of list) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user").toLowerCase();
    if (role === "system" || role === "developer") { const text = contentToText(message.content); if (text) systems.push(text); continue; }
    out.push({ role: role === "assistant" ? "assistant" : "user", content: toAnthropicContent(message.content) });
  }
  if (!out.length) out.push({ role: "user", content: prompt == null ? "ping" : String(prompt) });
  return { ...(systems.length ? { system: systems.join("\n\n") } : {}), messages: out };
}

/** OpenAI tool 定义（{type:'function',function:{...}}）→ Anthropic tools（name/input_schema）。 */
function toAnthropicTools(tools) {
  if (!Array.isArray(tools)) return null;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
    const name = String(fn.name || tool.name || "").trim();
    if (!name) continue;
    out.push({
      name,
      ...(fn.description ? { description: String(fn.description) } : {}),
      input_schema: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : (fn.input_schema && typeof fn.input_schema === "object" ? fn.input_schema : { type: "object", properties: {} }),
    });
  }
  return out.length ? out : null;
}

function toAnthropicToolChoice(choice) {
  if (!choice) return null;
  if (typeof choice === "string") {
    const value = choice.toLowerCase();
    if (value === "auto") return { type: "auto" };
    if (value === "required" || value === "any") return { type: "any" };
    return null; // none / 未知：不发送 tool_choice
  }
  if (typeof choice === "object" && choice.type === "function" && choice.function && choice.function.name) return { type: "tool", name: String(choice.function.name) };
  return null;
}

/** max_tokens 是官方必填项：缺省 1024，非法值一律回退，绝不发出无 max_tokens 的请求。 */
function resolveMaxTokens(params = {}) {
  const raw = Number(params.max_tokens ?? params.max_completion_tokens);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_TOKENS;
  return Math.max(1, Math.floor(raw));
}

function buildBody({ model, messages, tools = null, params = {}, stream = false, system = null, prompt = null } = {}) {
  const built = buildMessages({ messages, system: system == null ? (params.system == null ? null : params.system) : system, prompt });
  const body = { model: String(model || ""), max_tokens: resolveMaxTokens(params), messages: built.messages };
  if (built.system) body.system = built.system;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.top_p !== undefined) body.top_p = params.top_p;
  if (params.top_k !== undefined) body.top_k = params.top_k;
  if (params.stop !== undefined && params.stop !== null) body.stop_sequences = Array.isArray(params.stop) ? params.stop : [params.stop];
  if (stream) body.stream = true;
  const anthropicTools = toAnthropicTools(tools);
  if (anthropicTools) {
    body.tools = anthropicTools;
    const toolChoice = toAnthropicToolChoice(params.tool_choice);
    if (toolChoice) body.tool_choice = toolChoice;
  }
  return body;
}

/** {input_tokens,output_tokens} → 统一 usage；官方无 total，按 input+output 计算。 */
function mapUsage(usage) {
  if (!usage) return null;
  const input = usage.input_tokens ?? usage.prompt_tokens ?? null;
  const output = usage.output_tokens ?? usage.completion_tokens ?? null;
  const total = usage.total_tokens ?? (typeof input === "number" && typeof output === "number" ? input + output : null);
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

/** tool_use 块 → 既有 OpenAI 形状 tool_calls（模型代理与 agent 侧沿用同一消费口径）。 */
function toolCallsFromBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).flatMap((block, index) => {
    if (!block || block.type !== "tool_use" || !block.name) return [];
    return [{ id: String(block.id || "toolu_" + index), type: "function", function: { name: String(block.name), arguments: JSON.stringify(block.input == null ? {} : block.input) } }];
  });
}

function parseChatResponse(body) {
  const blocks = body && Array.isArray(body.content) ? body.content : [];
  const text = blocks.filter((block) => block && block.type === "text").map((block) => String(block.text || "")).join("");
  return {
    text,
    toolCalls: toolCallsFromBlocks(blocks),
    usage: mapUsage(body && body.usage),
    stopReason: body && body.stop_reason != null ? String(body.stop_reason) : null,
    model: body && body.model ? String(body.model) : undefined,
  };
}

/** HTTP 状态 / 网络 / 超时 / 取消 → model-domain 既有错误码（429→RATE_LIMITED、401/403→AUTH_FAILED）。 */
function errorCodeFor({ status = 0, kind = "" } = {}) {
  return require("./model-domain.cjs").normalizeError({ status, kind });
}

/** 流内 error 事件 → HTTP 状态（用于同一套错误归一）。 */
function statusForErrorType(type) {
  const value = String(type || "").toLowerCase();
  if (value.includes("authentication")) return 401;
  if (value.includes("permission")) return 403;
  if (value.includes("not_found")) return 404;
  if (value.includes("request_too_large")) return 413;
  if (value.includes("rate_limit")) return 429;
  if (value.includes("overloaded")) return 529;
  if (value.includes("timeout")) return 504;
  if (value.includes("api_error") || value.includes("internal")) return 500;
  return 400;
}

function providerHttpError(status, detail) {
  return Object.assign(new Error("HTTP " + status + (detail ? ": " + detail : "")), { name: "ProviderHttpError", status });
}

function streamError(errorEvent, statusHint) {
  const payload = errorEvent && errorEvent.error && typeof errorEvent.error === "object" ? errorEvent.error : {};
  const status = statusHint || statusForErrorType(payload.type);
  return providerHttpError(status, String(payload.message || payload.type || "stream error").slice(0, 400));
}

/** 单次请求（非流式入口，供 model-service.chat 复用）。 */
async function chat({ baseUrl, apiKey, model, messages, tools, params = {}, system = null, stream = false, signal, timeoutMs = 30000, fetchImpl = fetch }) {
  const url = endpoint(baseUrl, "/messages");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(buildBody({ model, messages, tools, params, stream: !!stream, system })),
      signal: controller.signal,
      redirect: "error", // credentialed cross-origin redirect = DENY
    });
    return { res, timedOut: () => controller.signal.aborted && controller.signal.reason && String(controller.signal.reason.message || controller.signal.reason).includes("timeout") };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 官方 SSE 解析：具名事件（event: 行）+ data JSON。
 * 逐事件语义：message_start（输入 usage）/content_block_start/content_block_delta
 * (text_delta | input_json_delta)/content_block_stop/message_delta（输出 usage）/
 * message_stop/error。增量只经 onEvent 下发，返回聚合结果。
 */
async function readSse(response, onEvent, signal) {
  const emit = typeof onEvent === "function" ? onEvent : () => {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;
  const blocks = new Map();
  const toolCalls = [];
  emit({ type: "response.start" });

  const mergeUsage = (next = {}) => {
    const input = next.input_tokens !== undefined ? next.input_tokens : (usage ? usage.inputTokens : undefined);
    const output = next.output_tokens !== undefined ? next.output_tokens : (usage ? usage.outputTokens : undefined);
    usage = mapUsage({ input_tokens: input, output_tokens: output });
    return usage;
  };

  const handleEvent = (eventName, data) => {
    let payload; try { payload = JSON.parse(data); } catch { return; }
    if (!payload || typeof payload !== "object") return;
    const type = String(payload.type || eventName || "");
    if (type === "ping") return;
    if (type === "message_start") {
      const message = payload.message && typeof payload.message === "object" ? payload.message : {};
      if (message.usage) emit({ type: "usage", usage: mergeUsage({ input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens }) });
      return;
    }
    if (type === "content_block_start") {
      const block = payload.content_block || {};
      const index = Number(payload.index || 0);
      if (block.type === "tool_use") blocks.set(index, { id: block.id || null, name: block.name || "", json: "" });
      else if (block.type === "text" && block.text) { text += String(block.text); emit({ type: "text.delta", text: String(block.text) }); }
      return;
    }
    if (type === "content_block_delta") {
      const delta = payload.delta || {};
      if (delta.type === "text_delta" && delta.text) { text += String(delta.text); emit({ type: "text.delta", text: String(delta.text) }); return; }
      if (delta.type === "input_json_delta") {
        const index = Number(payload.index || 0);
        const current = blocks.get(index) || (blocks.set(index, { id: null, name: "", json: "" }), blocks.get(index));
        current.json += String(delta.partial_json || "");
        emit({ type: "tool_call.delta" });
      }
      // thinking_delta / signature_delta / citations_delta 不进入可见文本（见 REPORT 遗留）。
      return;
    }
    if (type === "content_block_stop") {
      const index = Number(payload.index || 0);
      const current = blocks.get(index);
      if (current) {
        blocks.delete(index);
        toolCalls.push({ id: current.id || "toolu_" + index, type: "function", function: { name: current.name, arguments: current.json || "{}" } });
      }
      return;
    }
    if (type === "message_delta") {
      const next = payload.usage && typeof payload.usage === "object" ? payload.usage : {};
      emit({ type: "usage", usage: mergeUsage({ input_tokens: next.input_tokens, output_tokens: next.output_tokens }) });
      return;
    }
    if (type === "message_stop") return;
    if (type === "error") throw streamError(payload);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("event:")) { continue; }
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        // data 内自带 type 字段（官方两种写法都发），event: 行仅作兜底。
        handleEvent("", data);
      }
    }
  } catch (error) {
    if (signal && signal.aborted) { emit({ type: "response.error", error: "CANCELLED", partial: text }); throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }
    if (String(error && error.name) === "ProviderHttpError") { emit({ type: "response.error", error: "PROVIDER_HTTP_" + error.status, partial: text }); throw error; }
    emit({ type: "response.error", error: "PARTIAL_RESPONSE", partial: text });
    throw Object.assign(new Error("partial"), { name: "PartialError" });
  }
  // 未收到 content_block_stop 的残留 tool_use 也要落进结果（不丢工具调用）。
  for (const [index, current] of blocks) {
    if (current.name) toolCalls.push({ id: current.id || "toolu_" + index, type: "function", function: { name: current.name, arguments: current.json || "{}" } });
  }
  emit({ type: "response.complete" });
  return { text, toolCalls: toolCalls.filter(Boolean), usage };
}

/** Provider-neutral 流式入口（与 provider-adapter.cjs 的 chatStream 同一形状）。 */
async function chatStream({ baseUrl, apiKey, model, messages, tools, params = {}, system = null, signal, timeoutMs = 30000, fetchImpl = fetch, onEvent = () => {} }) {
  const url = endpoint(baseUrl, "/messages");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); };
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(buildBody({ model, messages, tools, params, stream: true, system })),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (err) {
    cleanup();
    if (signal && signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    if (controller.signal.aborted || String((err && err.message) || "").includes("timeout")) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    throw err;
  }
  if (!res.ok) { cleanup(); throw providerHttpError(res.status); }
  try {
    const parsed = await readSse(res, onEvent, signal);
    cleanup();
    return parsed;
  } catch (error) {
    cleanup();
    if (controller.signal.aborted && !(signal && signal.aborted)) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    throw error;
  }
}

/** 官方模型列表：GET /v1/models（x-api-key + anthropic-version），data[].id。 */
async function listModels({ baseUrl, apiKey, signal, timeoutMs = 15000, fetchImpl = fetch }) {
  const url = endpoint(baseUrl, "/models");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchImpl(url, { method: "GET", headers: authHeaders(apiKey), signal: controller.signal, redirect: "error" });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json().catch(() => null);
    const data = body && Array.isArray(body.data) ? body.data : body && Array.isArray(body.models) ? body.models : Array.isArray(body) ? body : null;
    if (!data) return { ok: false, status: 0, protocol: true };
    const items = data
      .map((item) => (typeof item === "string" ? { id: item } : item && typeof item === "object" ? {
        id: String(item.id || item.model || item.name || ""),
        ownedBy: "anthropic",
        ...(item.display_name || item.displayName ? { displayName: String(item.display_name || item.displayName).slice(0, 120) } : {}),
        ...(Number.isFinite(Number(item.max_tokens)) ? { maxTokens: Number(item.max_tokens) } : {}),
      } : null))
      .filter((item) => item && item.id && item.id.length <= 200)
      .slice(0, MAX_MODELS);
    return { ok: true, items };
  } catch (err) {
    return { ok: false, status: 0, kind: String((err && err.message) || "").includes("timeout") ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** 协议引擎（provider-protocol-service.cjs）用的请求描述符，与 OpenAI 分支同形。 */
function buildRequest({ baseUrl, apiKey, model, messages, tools = null, params = {}, stream = false, system = null, prompt = null } = {}) {
  return {
    method: "POST",
    url: endpoint(baseUrl, "/messages"),
    headers: authHeaders(apiKey),
    body: buildBody({ model, messages, tools, params, stream, system, prompt }),
    redirect: "error",
  };
}

module.exports = {
  ADAPTER_TYPE: "anthropic",
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
  authHeaders,
  buildMessages,
  toAnthropicContent,
  toAnthropicTools,
  buildBody,
  buildRequest,
  parseChatResponse,
  mapUsage,
  errorCodeFor,
  statusForErrorType,
  chat,
  chatStream,
  readSse,
  listModels,
};
