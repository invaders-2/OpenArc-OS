"use strict";
/**
 * 移植：server/protocols.ts 的「对话 / 工具 / 图片理解 / 模型目录」执行器。
 *   callChat           源：DXSRC/server/protocols.ts:3639-3732
 *   streamChat         源：DXSRC/server/protocols.ts:3738-3798
 *   tool 辅助函数      源：DXSRC/server/protocols.ts:3816-3910
 *     （toolDefinitions / parsedToolArguments / geminiFunctionResponse /
 *       mergeNativeMessages / anthropicToolMessages / geminiToolMessages /
 *       openAiSynchronousToolResult / openAiRejectsStreaming）
 *   chatWithTools      源：DXSRC/server/protocols.ts:3917-4110
 *   describeImage      源：DXSRC/server/protocols.ts:6624-6755
 *   fetchModels        源：DXSRC/server/protocols.ts:6758-6760
 *   fetchModelCatalog  源：DXSRC/server/protocols.ts:6763-6794
 *
 * 本地模式无配额计费，已移除 apiQuota 调用：
 *   - callChat:3647      assertApiModelAccess(...)
 *   - streamChat:3746    assertApiModelAccess(...)
 *   - chatWithTools:3927 assertApiModelAccess(...)
 *   withDirectApiQuota 不属本文件（在 image/video 生成路径，本批未移植）。
 *
 * 以下分支在端口/实现未就绪时返回结构化错误，不做假实现：
 *   { ok:false, error:"LEGACY_DEPENDENCY_UNAVAILABLE", detail:"<缺什么>" }
 *   - cli:codex / cli:gemini 的对话、流式对话、图片理解、模型目录 —— B7e2 后续：CLI 端口
 *     （electron/legacy-cli-ports.cjs）已注入则调用，未注入即结构化拒绝
 *   - runninghub 对话 / 流式对话 / 图片理解 —— B7e3 后续：RunningHub 插件端口
 *     （callRunningHubChat / describeRunningHubImage，注入见 electron/plugin-service.cjs）已注入则调用，
 *     未注入即结构化拒绝；runninghub 模型目录仍属未移植批次
 *   - agnes 模型目录（agnesEndpoint.ts 的 normalizeAgnesApiBaseUrl 不在冻结接口内，agnes 原生适配批次）
 *   - apiQuota / withDirectApiQuota（apiQuota.ts 云端计费，本地模式 OUT，已按上文移除）
 *   - sharp 只允许惰性 require 并在缺失时返回结构化错误；本文件未使用 sharp，故未引入。
 *
 * 网络请求统一走 electron/protocol-engine/transport.cjs 的 defaultProtocolTransport；
 * 可通过 setProtocolTransport(transport) 注入 RecordingTransport / ReplayTransport / MockTransport，
 * 便于离线复现与录制。抛出的错误与超时语义与源文件一致。
 *
 * buildChatRequest / normalizeProtocol / PROTOCOLS / joinUrl / buildAuthHeaders /
 * unwrapProviderPayload / parseBody / parseModelCatalog 由 legacy-protocols.cjs（并行任务）提供，本文件只 require。
 */

const { defaultProtocolTransport } = require("./transport.cjs");
const { geminiToolParameters } = require("./geminiToolSchema.cjs");
const {
  PROTOCOLS,
  normalizeProtocol,
  joinUrl,
  buildAuthHeaders,
  buildChatRequest,
  unwrapProviderPayload,
  parseBody,
  parseModelCatalog,
} = require("./legacy-protocols.cjs");

const legacyExecutorPorts = require("../legacy-executor-ports.cjs");

const LEGACY_DEPENDENCY_UNAVAILABLE = "LEGACY_DEPENDENCY_UNAVAILABLE";

/** B7e2 后续：CLI 协议族端口未注入时的可执行提示（实现见 electron/legacy-cli-ports.cjs）。 */
const CLI_LEGACY_DETAIL = "CLI 端口未注入（需安装对应 CLI，由主进程经 electron/legacy-cli-ports.cjs 注入 cliCodex/cliGemini）";
/** runninghub 对话 / 图片理解端口未注入（B7e3 后续；实现 electron/plugin-runninghub.cjs，注入 electron/plugin-service.cjs）。 */
const RUNNINGHUB_CHAT_LEGACY_DETAIL = "runninghub 端口未注入（需启用 runninghub 插件并配置凭据，由主进程注入 callRunningHubChat / describeRunningHubImage）；未启用时回 LEGACY_DEPENDENCY_UNAVAILABLE";
/** runninghub 模型目录不属本批补口范围，仍如实报未移植。 */
const RUNNINGHUB_CATALOG_LEGACY_DETAIL = "runninghub 模型目录未移植（runninghub.ts 原生适配批次）";
const AGNES_LEGACY_DETAIL = "agnes 原生适配尚未移植（缺少 agnesEndpoint.normalizeAgnesApiBaseUrl，属 W4 其它批次）";

function legacyUnavailable(detail) {
  return { ok: false, error: LEGACY_DEPENDENCY_UNAVAILABLE, detail };
}

let protocolTransport = defaultProtocolTransport;

/** 注入传输实现（默认 transport.cjs 的 defaultProtocolTransport）。返回当前传输。 */
function setProtocolTransport(transport) {
  protocolTransport = transport && typeof transport.fetch === "function" ? transport : defaultProtocolTransport;
  return protocolTransport;
}

function isCliProtocol(proto) {
  return proto === "cli:codex" || proto === "cli:gemini";
}

/** CLI 协议 → legacy 执行器端口名（B7e2 后续）。 */
function cliPortName(proto) {
  if (proto === "cli:codex") return "cliCodex";
  if (proto === "cli:gemini") return "cliGemini";
  return null;
}

/** 取 CLI 端口；未注入返回 null（调用方继续走结构化拒绝）。 */
function cliPort(proto) {
  const name = cliPortName(proto);
  return name ? legacyExecutorPorts.getLegacyExecutorPort(name) : null;
}

// ── 对话（callChat）───────────────────────────────────────────────────
/** 真正发起一次对话调用，返回 { text, latencyMs, raw }。源：protocols.ts:3639-3732 */
async function callChat(provider, model, input, params = {}, timeoutMs = 90000, signal) {
  const proto = normalizeProtocol(provider.protocol);
  if (isCliProtocol(proto)) {
    // B7e2 后续：端口已注入则调用（源 3649-3652），未注入仍结构化拒绝。
    const port = cliPort(proto);
    if (typeof port === "function") return port("chat", { provider, model, input, timeoutMs });
    return legacyUnavailable(CLI_LEGACY_DETAIL);
  }
  if (proto === "runninghub") {
    // 端口已注入则调用源 runninghub.ts:270-278 的实现；未注入仍结构化拒绝。
    const port = legacyExecutorPorts.getLegacyExecutorPort("callRunningHubChat");
    if (typeof port === "function") return port(provider, model, input, params, timeoutMs, protocolTransport);
    return legacyUnavailable(RUNNINGHUB_CHAT_LEGACY_DETAIL);
  }
  const def = PROTOCOLS[proto];
  const req = buildChatRequest(provider, model, input, params);
  const started = Date.now();
  const ctrl = new AbortController();
  const abortFromCaller = () => ctrl.abort(signal && signal.reason);
  if (signal && signal.aborted) abortFromCaller();
  else if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // ── openai 兼容：强制流式 + 累积（修复非流式空 content 的中转站/推理模型）──
    if (def.stream) {
      const body = { ...req.body, stream: true };
      const resp = await protocolTransport.fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const raw = await resp.text();
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 500)}`);
      let text = "";
      let usage;
      let sawSse = false;
      for (const line of raw.split("\n")) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        sawSse = true;
        const data = s.slice(5).trim();
        if (data === "[DONE]") break;
        try {
          const j = JSON.parse(data);
          const choice = j?.choices?.[0];
          const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text;
          if (typeof content === "string") text += content;
          else if (Array.isArray(content)) text += content.map((part) => String(part?.text || part?.content || "")).join("");
          if (j?.usage) usage = j.usage;
        } catch {
          /* 跳过非 JSON 的 SSE 行 */
        }
      }
      // Some OpenAI-compatible gateways (including APIMART models) accept
      // stream=true but still return one synchronous JSON object. Treating it
      // as empty SSE made Canvas LLM runs fail after a successful request.
      if (!text.trim()) {
        try {
          const payload = JSON.parse(raw);
          const parsed = parseBody(req.parse, unwrapProviderPayload(def, payload));
          if (parsed.text) return { ...parsed, latencyMs: Date.now() - started, raw: payload };
        } catch { /* keep the original empty-response diagnostic below */ }
      }
      if (!text.trim()) throw new Error(sawSse ? "LLM 流式响应结束，但没有返回文本内容" : "LLM 返回了无法识别的响应格式");
      return { text: text.trim(), usage, latencyMs: Date.now() - started, raw: { streamed: true } };
    }

    // ── 非流式（anthropic / gemini）──
    const resp = await protocolTransport.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    });
    const t = await resp.text();
    let payload;
    try {
      payload = JSON.parse(t);
    } catch {
      payload = t;
    }
    if (!resp.ok) {
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
      throw new Error(`HTTP ${resp.status}: ${detail.slice(0, 500)}`);
    }
    const parsed = parseBody(req.parse, unwrapProviderPayload(def, payload));
    return { ...parsed, latencyMs: Date.now() - started, raw: payload };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromCaller);
  }
}

// ── 流式对话（streamChat）────────────────────────────────────────────
/**
 * 流式对话：逐块回调 onDelta(增量文本)。
 * openai 协议走真流式；anthropic/gemini 先整段拿到再一次性回调。
 * 源：protocols.ts:3738-3798
 */
async function streamChat(provider, model, input, params = {}, onDelta, timeoutMs = 120000) {
  const proto = normalizeProtocol(provider.protocol);
  if (isCliProtocol(proto)) {
    // 源 3753-3756：CLI 无原生流，走 callChat 后一次性回调；端口已注入即复用。
    const port = cliPort(proto);
    if (typeof port === "function") {
      const result = await port("chat", { provider, model, input, timeoutMs });
      if (result && result.ok === false) return result;
      if (result && result.text) onDelta(result.text);
      return { usage: result && result.usage };
    }
    return legacyUnavailable(CLI_LEGACY_DETAIL);
  }
  if (proto === "runninghub") {
    // runninghub 无原生流（源 runninghub.ts callRunningHubChat 固定 stream:false）：端口已注入即整段回调一次。
    const port = legacyExecutorPorts.getLegacyExecutorPort("callRunningHubChat");
    if (typeof port === "function") {
      const result = await port(provider, model, input, params, timeoutMs, protocolTransport);
      if (result && result.ok === false) return result;
      if (result && result.text) onDelta(result.text);
      return { usage: result && result.usage };
    }
    return legacyUnavailable(RUNNINGHUB_CHAT_LEGACY_DETAIL);
  }
  const def = PROTOCOLS[proto];
  if (!def) throw new Error(`协议 ${proto || provider.protocol} 不支持对话调用`);
  const req = buildChatRequest(provider, model, input, params);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (!def.stream) {
      const r = await callChat(provider, model, input, params, timeoutMs);
      if (r && r.ok === false) return r;
      if (r.text) onDelta(r.text);
      return { usage: r.usage };
    }
    const body = { ...req.body, stream: true };
    const resp = await protocolTransport.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) {
      const t = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${t.slice(0, 400)}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let usage;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          const d = j?.choices?.[0]?.delta;
          if (typeof d?.content === "string" && d.content) onDelta(d.content);
          if (j?.usage) usage = j.usage;
        } catch {
          /* 跳过非 JSON 行 */
        }
      }
    }
    return { usage };
  } finally {
    clearTimeout(timer);
  }
}

// ── 工具调用辅助（源：protocols.ts:3816-3910）────────────────────────
function toolDefinitions(tools, geminiCompatible = false) {
  return (tools || []).flatMap((tool) => tool?.function?.name ? [{
    name: tool.function.name,
    description: tool.function.description || "",
    parameters: geminiCompatible ? geminiToolParameters(tool.function.parameters) : tool.function.parameters || { type: "object", properties: {} },
  }] : []);
}

function parsedToolArguments(value) {
  try { return JSON.parse(String(value || "{}")); } catch { return {}; }
}

function geminiFunctionResponse(value) {
  const content = String(value || "");
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* plain text tool result */ }
  return { content };
}

function mergeNativeMessages(messages) {
  const merged = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === message.role && Array.isArray(previous.content) && Array.isArray(message.content)) previous.content.push(...message.content);
    else merged.push(message);
  }
  return merged;
}

function anthropicToolMessages(messages) {
  return mergeNativeMessages(messages.flatMap((message) => {
    if (message.role === "system") return [];
    if (message.role === "assistant") {
      const blocks = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : [])) if (call.function?.name) {
        blocks.push({ type: "tool_use", id: call.id || `tool_${blocks.length}`, name: call.function.name, input: parsedToolArguments(call.function.arguments) });
      }
      return blocks.length ? [{ role: "assistant", content: blocks }] : [];
    }
    if (message.role === "tool") return [{
      role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id || "", content: String(message.content || "") }],
    }];
    return [{ role: "user", content: [{ type: "text", text: String(message.content || "") }] }];
  }));
}

function geminiToolMessages(messages) {
  const names = new Map();
  for (const message of messages) for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : [])) {
    if (call.id && call.function?.name) names.set(call.id, call.function.name);
  }
  return mergeNativeMessages(messages.flatMap((message) => {
    if (message.role === "system") return [];
    const parts = [];
    if (message.role === "assistant") {
      if (message.content) parts.push({ text: message.content });
      for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : [])) if (call.function?.name) {
        parts.push({ functionCall: { name: call.function.name, args: parsedToolArguments(call.function.arguments) } });
      }
      return parts.length ? [{ role: "model", content: parts }] : [];
    }
    if (message.role === "tool") {
      const name = message.name || names.get(message.tool_call_id || "") || "tool";
      return [{ role: "user", content: [{ functionResponse: { name, response: geminiFunctionResponse(message.content) } }] }];
    }
    parts.push({ text: String(message.content || "") });
    return [{ role: "user", content: parts }];
  })).map((message) => ({ role: message.role, parts: message.content }));
}

function openAiSynchronousToolResult(raw, onDelta) {
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error(`OpenAI 同步响应不是有效 JSON：${raw.slice(0, 400)}`); }
  const message = payload?.choices?.[0]?.message || payload?.choices?.[0]?.delta || {};
  const parts = Array.isArray(message.content) ? message.content : [];
  const content = typeof message.content === "string"
    ? message.content
    : parts.map((part) => typeof part === "string" ? part : String(part?.text || part?.content || "")).join("");
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).flatMap((call, index) => {
    const name = String(call?.function?.name || call?.name || "");
    if (!name) return [];
    const args = call?.function?.arguments ?? call?.arguments ?? "{}";
    return [{ id: String(call?.id || `call_${index}`), name, arguments: typeof args === "string" ? args : JSON.stringify(args) }];
  });
  if (content) onDelta?.(content);
  return { content, toolCalls, ...(payload?.usage === undefined ? {} : { usage: payload.usage }) };
}

function openAiRejectsStreaming(status, detail) {
  return [400, 404, 405, 415, 422, 501].includes(status)
    && /(?:stream(?:ing)?[^\n]{0,80}(?:unsupported|not supported|invalid|unknown|unrecognized|disable|false)|(?:unsupported|not supported)[^\n]{0,80}stream)/i.test(detail);
}

// ── 带工具的一步对话（chatWithTools）─────────────────────────────────
/**
 * 带工具（native function-calling）的一步对话。源：protocols.ts:3917-4110
 */
async function chatWithTools(provider, model, messages, system, tools, timeoutMs = 300000, onDelta, signal) {
  const started = Date.now();
  const rawProtocol = String(provider.protocol || "").trim().toLowerCase();
  let host = "";
  try { host = new URL(provider.base_url).hostname.toLowerCase(); } catch { /* invalid base URL is reported by joinUrl */ }
  const anthropicHost = host === "api.anthropic.com" || host.endsWith(".anthropic.com");
  const geminiHost = host === "generativelanguage.googleapis.com" || host.endsWith(".generativelanguage.googleapis.com");
  const nativeKind = rawProtocol === "anthropic" || rawProtocol === "apimart-claude" || (rawProtocol === "anthropic-chat" && anthropicHost)
    ? "anthropic_messages"
    : rawProtocol === "gemini" || rawProtocol === "apimart-gemini" || ((rawProtocol === "gemini-chat" || rawProtocol === "gemini-http") && geminiHost)
      ? "gemini_content"
      : undefined;
  const normalizedProtocol = normalizeProtocol(provider.protocol);
  const normalizedDef = PROTOCOLS[normalizedProtocol];
  // anthropic-chat/gemini-chat 可能由旧版仅按模型名推断；非官方 Host 优先兼容其 OpenAI wire format。
  const proto = nativeKind
    ? rawProtocol.startsWith("apimart-") ? rawProtocol : nativeKind === "anthropic_messages" ? "anthropic" : "gemini"
    : normalizedDef?.capabilities?.llm?.body !== "openai_chat" ? "openai" : normalizedProtocol;
  const def = PROTOCOLS[proto];
  const llmCapability = def?.capabilities?.llm;
  if (!def || !llmCapability) throw new Error(`协议 ${proto || provider.protocol} 不支持带工具的对话调用`);
  const url = joinUrl(provider.base_url, llmCapability.endpoint.replace("{model}", encodeURIComponent(model)));
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(def.headers || {}),
    ...buildAuthHeaders(def, provider.api_key),
  };
  const definitions = toolDefinitions(tools, nativeKind === "gemini_content" || /^gemini(?:[-/.]|$)/i.test(model));
  const providerTools = definitions.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  const body = {
    model,
    stream: true,
    tools: providerTools,
    tool_choice: "auto",
    messages: [{ role: "system", content: system }, ...messages],
  };
  const ctrl = new AbortController();
  const abortFromCaller = () => ctrl.abort(signal && signal.reason);
  if (signal && signal.aborted) abortFromCaller();
  else if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (nativeKind === "anthropic_messages") {
      const systemText = [system, ...messages.filter((message) => message.role === "system").map((message) => String(message.content || ""))].filter(Boolean).join("\n\n");
      const nativeBody = {
        model, max_tokens: 4096, ...(systemText ? { system: systemText } : {}),
        messages: anthropicToolMessages(messages),
        ...(definitions.length ? { tools: definitions.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })), tool_choice: { type: "auto" } } : {}),
      };
      const resp = await protocolTransport.fetch(url, { method: llmCapability.method || "POST", headers, body: JSON.stringify(nativeBody), signal: ctrl.signal });
      const raw = await resp.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = raw; }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 400)}`);
      payload = unwrapProviderPayload(def, payload);
      const blocks = Array.isArray(payload?.content) ? payload.content : [];
      const content = blocks.filter((block) => block?.type === "text").map((block) => String(block.text || "")).join("");
      const toolCalls = blocks.flatMap((block, index) => block?.type === "tool_use" && block?.name ? [{
        id: String(block.id || `anthropic_${index}`), name: String(block.name), arguments: JSON.stringify(block.input || {}),
      }] : []);
      if (content) onDelta?.(content);
      return { content, toolCalls, ...(payload?.usage === undefined ? {} : { usage: payload.usage }), latencyMs: Date.now() - started };
    }

    if (nativeKind === "gemini_content") {
      const systemMessages = messages.filter((message) => message.role === "system").map((message) => String(message.content || ""));
      const systemText = [system, ...systemMessages].filter(Boolean).join("\n\n");
      const nativeBody = {
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        contents: geminiToolMessages(messages),
        ...(definitions.length ? {
          tools: [{ functionDeclarations: definitions }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        } : {}),
      };
      const resp = await protocolTransport.fetch(url, { method: llmCapability.method || "POST", headers, body: JSON.stringify(nativeBody), signal: ctrl.signal });
      const raw = await resp.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = raw; }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 400)}`);
      payload = unwrapProviderPayload(def, payload);
      const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
      let content = "";
      const toolCalls = [];
      candidates.forEach((candidate, candidateIndex) => {
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        parts.forEach((part, partIndex) => {
          if (typeof part?.text === "string") content += `${content ? "\n" : ""}${part.text}`;
          if (part?.functionCall?.name) toolCalls.push({
            id: `gemini_${candidateIndex}_${partIndex}`, name: String(part.functionCall.name),
            arguments: JSON.stringify(part.functionCall.args || {}),
          });
        });
      });
      if (content) onDelta?.(content);
      return { content, toolCalls, ...(payload?.usageMetadata === undefined ? {} : { usage: payload.usageMetadata }), latencyMs: Date.now() - started };
    }

    let resp = await protocolTransport.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      if (!openAiRejectsStreaming(resp.status, detail)) throw new Error(`HTTP ${resp.status}: ${detail.slice(0, 400)}`);
      resp = await protocolTransport.fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, stream: false }), signal: ctrl.signal });
      const raw = await resp.text().catch(() => "");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 400)}`);
      const sync = openAiSynchronousToolResult(raw, onDelta);
      return { ...sync, latencyMs: Date.now() - started };
    }
    if (!resp.body) throw new Error(`HTTP ${resp.status}: 响应体为空`);
    const contentType = String(resp.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/event-stream")) {
      const raw = await resp.text();
      if (!/^\s*data:/i.test(raw)) {
        const sync = openAiSynchronousToolResult(raw, onDelta);
        return { ...sync, latencyMs: Date.now() - started };
      }
      resp = new Response(raw, { status: resp.status, headers: { "content-type": "text/event-stream" } });
    }
    const responseBody = resp.body;
    if (!responseBody) throw new Error(`HTTP ${resp.status}: 响应体为空`);
    const reader = responseBody.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    let usage;
    const toolMap = new Map();
    const consumeSseLine = (line) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      try {
        const j = JSON.parse(data);
        if (j?.usage !== undefined) usage = j.usage;
        else if (j?.usageMetadata !== undefined) usage = j.usageMetadata;
        const d = j?.choices?.[0]?.delta;
        if (typeof d?.content === "string") {
          content += d.content;
          if (d.content) onDelta?.(d.content);
        }
        if (Array.isArray(d?.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = toolMap.get(idx) || { arguments: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.arguments += tc.function.arguments;
            toolMap.set(idx, cur);
          }
        }
      } catch { /* ignore malformed compatibility chunks */ }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        consumeSseLine(line);
      }
    }
    if (buf.trim()) consumeSseLine(buf.trim());
    const toolCalls = [...toolMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, c]) => ({ id: c.id || `call_${idx}`, name: c.name || "", arguments: c.arguments || "{}" }))
      .filter((c) => c.name);
    return { content, toolCalls, ...(usage === undefined ? {} : { usage }), latencyMs: Date.now() - started };
  } catch (e) {
    if (signal && signal.aborted) throw new DOMException("Agent run cancelled", "AbortError");
    if (ctrl.signal.aborted) throw Object.assign(
      new Error("模型响应超时，请重试，或把要求写得更具体、篇幅更短。"),
      { code: "MODEL_TIMEOUT", statusCode: 504 },
    );
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromCaller);
  }
}

// ── 图片理解（describeImage）─────────────────────────────────────────
/**
 * 把 dataUrl（data:image/...;base64,xxx）连同提示词发给视觉模型，返回文本描述。
 * 源：protocols.ts:6624-6755
 */
async function describeImage(provider, model, dataUrl, prompt, timeoutMs = 120000, outputTokens = 2048, signal) {
  const dataUrls = (Array.isArray(dataUrl) ? dataUrl : [dataUrl]).filter(Boolean);
  if (!dataUrls.length) throw new Error("没有可供模型读取的图片。");
  const proto = normalizeProtocol(provider.protocol);
  if (isCliProtocol(proto)) {
    // B7e2 后续：端口已注入则调用（源 6636-6645），未注入仍结构化拒绝。
    const port = cliPort(proto);
    if (typeof port === "function") return port("describeImage", { provider, model, dataUrls, prompt, timeoutMs });
    return legacyUnavailable(CLI_LEGACY_DETAIL);
  }
  if (proto === "runninghub") {
    // 端口已注入则调用源 runninghub.ts:280-289 的实现；未注入仍结构化拒绝。
    const port = legacyExecutorPorts.getLegacyExecutorPort("describeRunningHubImage");
    if (typeof port === "function") return port(provider, model, dataUrls, prompt, timeoutMs, protocolTransport);
    return legacyUnavailable(RUNNINGHUB_CHAT_LEGACY_DETAIL);
  }
  if (proto === "apimart" || proto === "gemini") {
    const def = PROTOCOLS[proto];
    const modelName = String(model || "").replace(/^models\//, "");
    const endpoint = proto === "apimart"
      ? `https://api.apimart.ai/v1beta/models/${encodeURIComponent(modelName)}:generateContent`
      : joinUrl(provider.base_url, `/v1beta/models/${encodeURIComponent(modelName)}:generateContent`);
    const header = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(def.headers || {}),
      ...buildAuthHeaders(def, provider.api_key),
    };
    const inlineImages = dataUrls.map((url) => {
      const marker = ";base64,";
      const splitAt = url.indexOf(marker);
      const mime = url.startsWith("data:") ? url.slice(5, url.indexOf(";")) || "image/png" : "image/png";
      const encoded = splitAt >= 0 ? url.slice(splitAt + marker.length) : "";
      return encoded ? { inlineData: { mimeType: mime, data: encoded } } : null;
    }).filter(Boolean);
    const body = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          ...inlineImages,
        ],
      }],
      generationConfig: { maxOutputTokens: Math.max(256, Math.min(16384, Math.floor(outputTokens) || 2048)) },
    };
    const ctrl = new AbortController();
    const abortFromCaller = () => ctrl.abort(signal && signal.reason);
    if (signal && signal.aborted) abortFromCaller();
    else if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await protocolTransport.fetch(endpoint, { method: "POST", headers: header, body: JSON.stringify(body), signal: ctrl.signal });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 400)}`);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("返回不是有效 JSON");
      }
      return parseBody("gemini_text", unwrapProviderPayload(def, payload)).text;
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error("图片理解超时，请重试或换视觉模型。");
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abortFromCaller);
    }
  }
  const def = PROTOCOLS[proto];
  const vision = def?.capabilities?.vlm;
  if (!vision) throw new Error(`当前协议 ${proto} 不支持图片理解。`);
  const url = joinUrl(provider.base_url, vision.endpoint.replace("{model}", encodeURIComponent(model)));
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(def.headers || {}),
    ...buildAuthHeaders(def, provider.api_key),
  };
  const decodedImages = dataUrls.map((value) => {
    const match = value.match(/^data:([^;,]+);base64,(.+)$/s);
    return match ? { mime: match[1], data: match[2] } : null;
  }).filter((item) => !!item);
  const body = vision.body === "anthropic_messages"
    ? {
        model,
        max_tokens: Math.max(256, Math.min(16384, Math.floor(outputTokens) || 2048)),
        messages: [{ role: "user", content: [
          ...decodedImages.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } })),
          { type: "text", text: prompt },
        ] }],
      }
    : {
        model,
        stream: false,
        max_tokens: Math.max(256, Math.min(16384, Math.floor(outputTokens) || 2048)),
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          ...dataUrls.map((u) => ({ type: "image_url", image_url: { url: u } })),
        ] }],
      };
  const ctrl = new AbortController();
  const abortFromCaller = () => ctrl.abort(signal && signal.reason);
  if (signal && signal.aborted) abortFromCaller();
  else if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await protocolTransport.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 400)}`);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("返回不是有效 JSON");
    }
    return parseBody(vision.parse, unwrapProviderPayload(def, payload)).text;
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error("图片理解超时，请重试或换视觉模型。");
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abortFromCaller);
  }
}

// ── 模型目录（fetchModels / fetchModelCatalog）───────────────────────
/** 拉取一个站点可用的模型列表。源：protocols.ts:6758-6760 */
async function fetchModels(provider, timeoutMs = 20000) {
  const catalog = await fetchModelCatalog(provider, timeoutMs);
  if (catalog && catalog.ok === false) return catalog;
  return catalog.map((item) => item.model);
}

/** Pull a model directory while retaining media type, operations and other advertised metadata. 源：protocols.ts:6763-6794 */
async function fetchModelCatalog(provider, timeoutMs = 20000) {
  const proto = normalizeProtocol(provider.protocol);
  if (proto === "runninghub") return legacyUnavailable(RUNNINGHUB_CATALOG_LEGACY_DETAIL);
  if (isCliProtocol(proto)) {
    // B7e2 后续：端口已注入则用 CLI 原生模型目录（agentCliModels），未注入仍结构化拒绝。
    const port = cliPort(proto);
    if (typeof port === "function") return port("models", { provider, model: null, timeoutMs });
    return legacyUnavailable(CLI_LEGACY_DETAIL);
  }
  // MiniMax V2 gateways generally do not expose an OpenAI-style /models API.
  // Keep protocol verification and model import useful without creating a paid task.
  if (proto === "minimax") return [{ model: "MiniMax-H3", type: "llm" }];
  // 豆包语音没有 OpenAI 风格的模型列表接口；这些是官方 HTTP 文档当前公开的资源 ID。
  if (proto === "volcengine-speech") return ["seed-tts-2.0", "seed-icl-2.0", "seed-audio-1.0"].map((model) => ({ model, type: "audio" }));
  if (proto === "agnes") return legacyUnavailable(AGNES_LEGACY_DETAIL);
  const def = PROTOCOLS[proto];
  if (!def) throw new Error(`协议 ${proto || provider.protocol} 不支持模型列表`);
  const url = joinUrl(provider.base_url, def.models.endpoint);
  const headers = {
    Accept: "application/json",
    ...(def.headers || {}),
    ...buildAuthHeaders(def, provider.api_key),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await protocolTransport.fetch(url, { headers, signal: ctrl.signal });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 400)}`);
    const payload = JSON.parse(text);
    return parseModelCatalog(def.models.kind, payload);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  callChat,
  streamChat,
  chatWithTools,
  describeImage,
  fetchModels,
  fetchModelCatalog,
  setProtocolTransport,
  LEGACY_DEPENDENCY_UNAVAILABLE,
};
