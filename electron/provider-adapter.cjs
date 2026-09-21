/** D4-01 · Provider Adapter（OpenAI-compatible chat）。凭证只在本层内部使用。 */
"use strict";

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
    if (typeof item.b64_json === "string" && item.b64_json) return { b64: item.b64_json, mime: "image/png" };
    if (typeof item.url === "string" && item.url) return { url: item.url };
    return null;
  }).filter(Boolean);
}

module.exports = { chat, chatStream, generateImage, mapImages, parseSseChunk, mapUsage, ADAPTER_TYPE: "openai-compatible" };
