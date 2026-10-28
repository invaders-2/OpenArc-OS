/** D4-01 · Provider Adapter（OpenAI-compatible chat）。凭证只在本层内部使用。 */
"use strict";

const imageParams = require("./image-params.cjs");

function parseSseChunk(text) {
  const events = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const data = t.slice(5).trim();
    if (data === "[DONE]") { events.push({ type: "done" }); continue; }
    try { events.push({ type: "json", value: JSON.parse(data) }); } catch { /* skip */ }
  }
  return events;
}

function mapUsage(u) {
  if (!u) return null;
  return { inputTokens: u.prompt_tokens ?? u.input_tokens ?? null, outputTokens: u.completion_tokens ?? u.output_tokens ?? null, totalTokens: u.total_tokens ?? null };
}

async function chat({ baseUrl, apiKey, model, messages, tools, params = {}, stream = false, signal, timeoutMs = 30000, fetchImpl = fetch }) {
  const url = String(baseUrl).replace(/\/$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify({ model, messages, stream: !!stream, ...(tools ? { tools } : {}), ...params }),
      signal: controller.signal,
      redirect: "error", // credentialed cross-origin redirect = DENY
    });
    return { res, timedOut: () => controller.signal.aborted && controller.signal.reason && String(controller.signal.reason.message || controller.signal.reason).includes("timeout") };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}


function mergeToolDelta(toolCalls, deltas) {
  for (const d of deltas || []) {
    const idx = Number(d.index || 0);
    const cur = toolCalls[idx] || (toolCalls[idx] = { id: d.id || null, type: "function", function: { name: "", arguments: "" } });
    if (d.id) cur.id = d.id;
    if (d.function && d.function.name) cur.function.name += d.function.name;
    if (d.function && d.function.arguments) cur.function.arguments += d.function.arguments;
  }
  return toolCalls;
}

/** Provider-neutral streaming：把 Provider SSE 转成统一事件模型。 */
async function chatStream({ baseUrl, apiKey, model, messages, tools, params = {}, signal, timeoutMs = 30000, fetchImpl = fetch, onEvent = () => {} }) {
  const url = String(baseUrl).replace(/\/$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); };
  let res;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + apiKey }, body: JSON.stringify({ model, messages, stream: true, ...(tools ? { tools } : {}), ...params }), signal: controller.signal, redirect: "error" });
  } catch (err) {
    cleanup();
    if (signal && signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    if (controller.signal.aborted || String((err && err.message) || "").includes("timeout")) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    throw err;
  }
  if (!res.ok) { cleanup(); throw Object.assign(new Error("provider-http"), { name: "ProviderHttpError", status: res.status }); }
  onEvent({ type: "response.start" });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ""; let text = ""; const toolCalls = []; let usage = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let obj; try { obj = JSON.parse(data); } catch { continue; }
        if (obj.usage) { usage = mapUsage(obj.usage); onEvent({ type: "usage", usage }); }
        const choice = obj.choices && obj.choices[0];
        if (choice && choice.delta) {
          if (choice.delta.content) { text += choice.delta.content; onEvent({ type: "text.delta", text: choice.delta.content }); }
          if (choice.delta.tool_calls) { mergeToolDelta(toolCalls, choice.delta.tool_calls); onEvent({ type: "tool_call.delta" }); }
        }
      }
    }
  } catch (err) {
    if (signal && signal.aborted) { onEvent({ type: "response.error", error: "CANCELLED", partial: text }); cleanup(); throw Object.assign(new Error("cancelled"), { name: "AbortError" }); }
    if (controller.signal.aborted) { onEvent({ type: "response.error", error: "MODEL_TIMEOUT", partial: text }); cleanup(); throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }
    onEvent({ type: "response.error", error: "PARTIAL_RESPONSE", partial: text });
    cleanup();
    throw Object.assign(new Error("partial"), { name: "PartialError" });
  }
  cleanup();
  onEvent({ type: "response.complete" });
  return { text, toolCalls: toolCalls.filter(Boolean), usage };
}

/**
 * D5-02 · image-generation：**同一条 provider 协议**（openai-compatible /images/generations）。
 * 不新增供应商、不新增付费服务：只有用户已配置且该模型声明了 image-generation 能力时才会走到这里；
 * 能力不支持时 ModelService.resolveModel 直接返回 CAPABILITY_UNAVAILABLE（绝不回落成文本接口）。
 */
async function generateImage({ baseUrl, apiKey, model, prompt, size = null, count = 1, params = {}, signal, timeoutMs = 60000, fetchImpl = fetch }) {
  const url = String(baseUrl).replace(/\/$/, "") + "/images/generations";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal && signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify({ model, prompt: String(prompt || "").slice(0, 4000), n: Math.max(1, Math.min(4, Number(count) || 1)), ...(size ? { size: String(size).slice(0, 32) } : {}), ...params }),
      signal: controller.signal,
      redirect: "error",
    });
    return { res, timedOut: () => controller.signal.aborted && controller.signal.reason && String(controller.signal.reason.message || controller.signal.reason).includes("timeout") };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** 把 provider 的图片响应归一为 [{b64|url}]（两种形态都支持，绝不伪造）。*/
function mapImages(body) {
  const data = (body && Array.isArray(body.data)) ? body.data : (Array.isArray(body) ? body : []);
  return data.slice(0, 4).map((item) => {
    if (!item || typeof item !== "object") return null;
    if (typeof item.b64_json === "string" && item.b64_json) {
      // mime 以返回体声明为准（mime_type/mimeType），缺失时按魔数嗅探，最后才回退 image/png。
      return { b64: item.b64_json, mime: imageParams.resolveImageMime({ declared: item.mime_type || item.mimeType || null, base64: item.b64_json }) };
    }
    if (typeof item.url === "string" && item.url) return { url: item.url };
    return null;
  }).filter(Boolean);
}

/**
 * 10-16 · 拉取服务商的模型清单（OpenAI 兼容 GET /models）。只回 id 与 owned_by，最多 500 条。
 */
async function listModels({ baseUrl, apiKey, signal, timeoutMs = 15000, fetchImpl = fetch }) {
  const url = String(baseUrl).replace(/\/$/, "") + "/models";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: "Bearer " + apiKey },
      signal: controller.signal,
      redirect: "error",
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json().catch(() => null);
    const data = body && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : body && Array.isArray(body.models) ? body.models : null;
    if (!data) return { ok: false, status: 0, protocol: true };
    const items = data
      .map((m) => (typeof m === "string" ? { id: m } : m && typeof m === "object" ? { id: String(m.id || m.name || ""), ownedBy: typeof m.owned_by === "string" ? m.owned_by.slice(0, 80) : null } : null))
      .filter((m) => m && m.id && m.id.length <= 200)
      .slice(0, 500);
    return { ok: true, items };
  } catch (err) {
    return { ok: false, status: 0, kind: String((err && err.message) || "").includes("timeout") ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** 按模型名粗判能力（只作为勾选时的默认值，用户可改；不等于"已验证"）。 */
function guessCapabilities(id) {
  const s = String(id).toLowerCase();
  if (/(image|dall-?e|flux|seedream|stable-?diffusion|sdxl|midjourney|imagen|cogview|wanx|kolors|gpt-image)/.test(s)) return ["image-generation"];
  if (/(video|seedance|kling|veo|sora|hailuo|wan2|cogvideo|vidu)/.test(s)) return ["video-generation"];
  // 配音 / 音乐 / 音效：进画布音频节点（whisper 转写、对话类 audio-preview 不算）
  if (/(suno|lyria|flowmusic|mureka|udio|music|(^|[-_/])tts|text-to-speech|sound-?effect)/.test(s) && !/(whisper|transcri|audio-preview|realtime)/.test(s)) return ["audio-generation"];
  if (/(embed|rerank|whisper|tts|speech|audio|moderation)/.test(s)) return [];
  const caps = ["chat"];
  if (/(vl|vision|4o|4\.1|gpt-5|gemini|claude|qwen-?vl|glm-4v|o3|o4)/.test(s)) caps.push("vision-input");
  return caps;
}

/** OpenAI 兼容响应归一（与既有内联解析逐字一致；模型服务按 adapterType 选用不同实现）。 */
function parseChatResponse(body) {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  return {
    text: message && typeof message.content === "string" ? message.content : "",
    toolCalls: message && Array.isArray(message.tool_calls) ? message.tool_calls : null,
    usage: mapUsage(body && body.usage),
  };
}

/**
 * 通用 OpenAI 兼容站点没有模型规格表：显式上报「没有 spec」，而不是返回一份猜出来的。
 * 上层（electron/model-service.cjs#listModelsForUse）据此把 specSource 标成 'guess'，
 * 画布才会退回「按名字的预设 + 未验证」；有规格的适配器（apimart / lovart）各自覆盖本函数。
 */
function uiSpec() {
  return null;
}

/**
 * adapterType → 适配器实现。只需在新增官方协议时登记一条；
 * 未登记（含 openai-compatible / openai / 空）一律回落本模块的 OpenAI 兼容实现，
 * 保持既有服务商行为逐字不变。
 */
function adapterFor(adapterType, baseUrl) {
  const id = String(adapterType || "").trim().toLowerCase();
  // APIMart（api.apimart.ai / apib.ai）：异步任务协议，按主机自动识别（与 NOVAI is_apimart_provider 同口径）
  if (id === "apimart" || ((!id || id === "openai-compatible" || id === "openai") && /(^|\.)(apimart\.ai|apib\.ai)$/i.test((() => { try { return new URL(String(baseUrl || "")).hostname; } catch { return ""; } })()))) return require("./provider-adapter-apimart.cjs");
  if (id === "anthropic" || id === "anthropic-chat") return require("./provider-adapter-anthropic.cjs");
  if (id === "lovart") return require("./provider-adapter-lovart.cjs");
  if (id === "tripo3d" || id === "tripo") return require("./provider-adapter-tripo.cjs");
  return module.exports;
}

/** provider.protocol → Lovart 适配器；非 lovart 返回 null（调用方走既有分支）。 */
function lovartFor(protocol) {
  const id = String(protocol || "").trim().toLowerCase();
  return id === "lovart" ? require("./provider-adapter-lovart.cjs") : null;
}

/** provider.protocol → 协议引擎用的传输描述符；非 Anthropic 返回 null（调用方走既有 OpenAI 分支）。 */
/** provider.protocol → Tripo3D 适配器；非 Tripo 返回 null。 */
function tripoFor(protocol) {
  const id = String(protocol || "").trim().toLowerCase();
  return id === "tripo3d" || id === "tripo" ? require("./provider-adapter-tripo.cjs") : null;
}

function chatProtocolFor(protocol) {
  const id = String(protocol || "").trim().toLowerCase();
  if (id !== "anthropic" && id !== "anthropic-chat") return null;
  const impl = require("./provider-adapter-anthropic.cjs");
  return { buildRequest: impl.buildRequest, parseResponse: impl.parseChatResponse, readSse: impl.readSse };
}

/**
 * 10-23 · 通用（OpenAI 兼容）图片编辑 / 带参考图生成：工具栏的重绘、擦除、扩图、多角度、重打光、增强、抠图……
 * 按用户选的模型走它自己的接口，不写死服务商：
 *   1) POST /images/edits（multipart，image[] 可多张；第一张若带透明区域即为要改的部分）
 *   2) 服务商没有 /images/edits（404/405/501）时，退回 /chat/completions 多模态对话，从回复里取图片
 * inputs：data: URL 或 https 地址（https 先下载）。返回 { ok, images: [{ b64, mime } | { url }] } 或 { ok:false, error, detail }。
 */
async function editImage({ baseUrl, apiKey, model, prompt, inputs = [], size = null, signal = null, timeoutMs = 300000, fetchImpl = fetch } = {}) {
  const files = [];
  for (const raw of (Array.isArray(inputs) ? inputs : []).slice(0, 8)) {
    const v = String(raw || "");
    const m = /^data:([^;,]+)?;base64,(.*)$/is.exec(v);
    if (m) { files.push({ buf: Buffer.from(m[2] || "", "base64"), mime: m[1] || "image/png" }); continue; }
    if (/^https:\/\//i.test(v)) { try { const r = await fetchImpl(v, { signal }); if (r && r.ok) files.push({ buf: Buffer.from(await r.arrayBuffer()), mime: String(r.headers.get("content-type") || "image/png").split(";")[0] }); } catch { /* 跳过下载失败的参考图 */ } }
  }
  if (!files.length) return { ok: false, error: "INVALID_INPUT", detail: "no-input-image" };
  const base = String(baseUrl).replace(/\/$/, "");
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ctl.abort(signal && signal.reason); if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    // 1) /images/edits
    const form = new FormData();
    form.append("model", String(model || ""));
    form.append("prompt", String(prompt || "").slice(0, 4000));
    if (size) form.append("size", String(size).slice(0, 32));
    const key = files.length > 1 ? "image[]" : "image";
    files.forEach((f, i) => form.append(key, new Blob([f.buf], { type: f.mime }), "input-" + i + "." + ((f.mime.split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png")));
    const res = await fetchImpl(base + "/images/edits", { method: "POST", headers: { authorization: "Bearer " + apiKey }, body: form, signal: ctl.signal, redirect: "error" });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      const items = mapImages(body).filter(Boolean);
      if (items.length) return { ok: true, images: items };
      return { ok: false, error: "PROVIDER_PROTOCOL_ERROR", detail: "edits-no-image" };
    }
    if (![404, 405, 501].includes(res.status)) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: res.status === 401 || res.status === 403 ? "CREDENTIAL_INVALID" : "PROVIDER_ERROR", detail: ("HTTP " + res.status + " " + t).slice(0, 300) };
    }
    // 2) 多模态对话出图（Gemini 图片模型等经中转常见形态）
    const content = [{ type: "text", text: String(prompt || "") }, ...files.map((f) => ({ type: "image_url", image_url: { url: "data:" + f.mime + ";base64," + f.buf.toString("base64") } }))];
    const r2 = await fetchImpl(base + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + apiKey }, body: JSON.stringify({ model, messages: [{ role: "user", content }], stream: false }), signal: ctl.signal, redirect: "error" });
    if (!r2.ok) { const t = await r2.text().catch(() => ""); return { ok: false, error: "PROVIDER_ERROR", detail: ("HTTP " + r2.status + " " + t).slice(0, 300) }; }
    const body = await r2.json().catch(() => null);
    const msg = body && body.choices && body.choices[0] && body.choices[0].message || {};
    const found = [];
    for (const im of Array.isArray(msg.images) ? msg.images : []) { const u = im && (im.image_url && im.image_url.url || im.url); if (u) found.push(u); }
    if (Array.isArray(msg.content)) for (const part of msg.content) { const u = part && (part.image_url && part.image_url.url || (part.type === "image" && part.url)); if (u) found.push(u); }
    const text = typeof msg.content === "string" ? msg.content : "";
    for (const m2 of text.matchAll(/(data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)|!\[[^\]]*\]\((https?:[^)\s]+)\)/g)) found.push(m2[1] || m2[2]);
    const images = found.map((u) => { const d = /^data:([^;,]+);base64,(.*)$/s.exec(u); return d ? { b64: d[2], mime: d[1] } : { url: u }; });
    if (images.length) return { ok: true, images };
    return { ok: false, error: "PROVIDER_PROTOCOL_ERROR", detail: (text || "chat-no-image").slice(0, 300) };
  } catch (error) {
    if (signal && signal.aborted) return { ok: false, error: "CANCELLED" };
    if (ctl.signal.aborted) return { ok: false, error: "MODEL_TIMEOUT" };
    return { ok: false, error: "PROVIDER_UNAVAILABLE", detail: String((error && error.message) || error).slice(0, 200) };
  } finally { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); }
}

module.exports = { chat, chatStream, generateImage, editImage, listModels, guessCapabilities, uiSpec, mapImages, parseSseChunk, mapUsage, parseChatResponse, adapterFor, chatProtocolFor, lovartFor, tripoFor, ADAPTER_TYPE: "openai-compatible" };
