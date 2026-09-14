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

module.exports = { chat, parseSseChunk, mapUsage, ADAPTER_TYPE: "openai-compatible" };
