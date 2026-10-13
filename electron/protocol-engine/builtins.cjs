"use strict";
/**
 * 内置 dx-protocol/v2 协议。
 *
 * 源：DXSRC/protocol-engine/builtins.ts:1-2725（2725 行）。
 * 本文件**只完整移植**了：
 *   · 全部 15 个 provider 协议（builtins.ts:2346-2397）
 *   · openai-images 模型协议（builtins.ts:87-294，覆盖 chat/vision/tools/responses/
 *     images.generate/images.edit/video/audio，P2 只需 OpenAI 兼容 + 图像族）
 * 其余 18 个模型协议（gemini、apimart-images、volcengine…）未逐条移植，
 * 只在 BUILTIN_PROTOCOL_METADATA_V2 里登记 id/kind 并标 ported:false —— 不做假实现。
 */
const { PROTOCOL_V2_SCHEMA } = require("./types.cjs");

const { OPENAI_MINIMAX_VIDEO_PROFILES } = require("./openAiMinimaxProfiles.cjs");

const ref = (value) => ({ ref: value });
const literal = (value) => ({ literal: value });

const openAiMultipartImageFields = () => ({
  $cardinality: {
    from: "{{inputs.images}}",
    zero: {},
    one: { image: { $files: "{{inputs.images}}" } },
    many: { "image[]": { $files: "{{inputs.images}}" } },
  },
});

const imagePoll = {
  operation: "image-query", intervalMs: 2500, backoff: 1.25, maxIntervalMs: 8000,
  status: {
    pending: ["queued", "pending", "processing", "in_progress", "running", "created"],
    success: ["completed", "succeeded", "success", "done", "finished"],
    failure: ["failed", "failure", "error", "canceled", "cancelled", "timeout", "rejected"],
  },
};

const bearerProvider = (id, label) => ({
  schemaVersion: PROTOCOL_V2_SCHEMA, kind: "provider", id, label,
  summary: label + " Bearer 平台连接协议。",
  executor: { type: "declarative", engine: ">=1.0.0" },
  auth: { type: "bearer", header: "Authorization", prefix: "Bearer ", credentialRef: "api_key" },
  headers: { Accept: "application/json" },
  models: { method: "GET", path: "/v1/models", response: { data: "$.data" } },
});

const openAiImagesProtocol = {
  schemaVersion: PROTOCOL_V2_SCHEMA, kind: "model", id: "openai-images", label: "OpenAI Unified",
  summary: "OpenAI 兼容的 Chat、Responses、视觉/工具/结构化输出，以及 Images 生成、编辑和可选异步任务查询。",
  executor: { type: "declarative", engine: ">=1.0.0" },
  capabilities: ["llm.chat", "llm.chat.vision", "llm.tools", "llm.responses", "llm.structured_output", "image.generate", "image.edit", "video.text_to_video", "video.image_to_video", "audio.tts", "audio.transcribe", "audio.translate"],
  operations: {
    "llm-chat": {
      method: "POST", path: "/v1/chat/completions", requestMode: "json", omitEmpty: true,
      headersTemplate: { "Content-Type": "application/json" },
      bodyTemplate: { model: "{{model}}", messages: [{ role: "user", content: "{{prompt}}" }], temperature: "{{params.temperature}}", top_p: "{{params.top_p}}", max_tokens: "{{params.max_tokens}}" },
      response: { text: "$.choices[0].message.content", usage: "$.usage", errorMessage: ["$.error.message", "$.message"] },
    },
    "llm-vision": {
      method: "POST", path: "/v1/chat/completions", requestMode: "json", omitEmpty: true,
      headersTemplate: { "Content-Type": "application/json" },
      bodyTemplate: { model: "{{model}}", messages: [{ role: "user", content: [{ type: "text", text: "{{prompt}}" }, { type: "image_url", image_url: { url: "{{inputs.images[0].dataUrl}}" } }] }], max_tokens: "{{params.max_tokens}}" },
      response: { text: "$.choices[0].message.content", usage: "$.usage", errorMessage: ["$.error.message", "$.message"] },
    },
    "llm-tools": {
      method: "POST", path: "/v1/chat/completions", requestMode: "json", omitEmpty: true,
      headersTemplate: { "Content-Type": "application/json" },
      bodyTemplate: { model: "{{model}}", messages: [{ role: "user", content: "{{prompt}}" }], tools: "{{params.tools}}", tool_choice: "{{params.tool_choice}}" },
      response: { text: ["$.choices[0].message.content", "$.choices[0].message.tool_calls"], usage: "$.usage", errorMessage: ["$.error.message", "$.message"] },
    },
    "llm-structured": {
      method: "POST", path: "/v1/chat/completions", requestMode: "json", omitEmpty: true,
      headersTemplate: { "Content-Type": "application/json" },
      bodyTemplate: { model: "{{model}}", messages: [{ role: "user", content: "{{prompt}}" }], response_format: "{{params.response_format}}" },
      response: { text: "$.choices[0].message.content", usage: "$.usage", errorMessage: ["$.error.message", "$.message"] },
    },
    "llm-responses": {
      method: "POST", path: "/v1/responses", requestMode: "json", omitEmpty: true,
      headersTemplate: { "Content-Type": "application/json" },
      bodyTemplate: { model: "{{model}}", input: "{{prompt}}", instructions: "{{params.instructions}}", max_output_tokens: "{{params.max_output_tokens}}", tools: "{{params.tools}}" },
      response: { text: ["$.output_text", "$.output[*].content[*].text"], output: "$.output", usage: "$.usage", errorMessage: ["$.error.message", "$.message"] },
    },
    "image-generate": {
      method: "POST", path: "/v1/images/generations", requestMode: "json",
      headersTemplate: { "Content-Type": "application/json" },
      derive: { quality: { op: "lookup", value: ref("params.quality"), cases: { xhigh: "xhigh", max: "max", auto: "auto", low: "low", standard: "medium", medium: "medium", hd: "high", high: "high" } } },
      bodyTemplate: { model: "{{model}}", prompt: "{{prompt}}", size: "{{params.size}}", quality: "{{derived.quality}}", n: "{{params.n}}", response_format: "url" },
      response: {
        taskId: ["$.task_id", "$.taskId", "$.id", "$.data.task_id"], status: ["$.status", "$.task_status", "$.data.status"],
        resultUrls: ["$.data[*].url", "$.data[*].image_url"],
        resultData: ["$.data[*].b64_json", "$.data[*].image_base64"],
        resultMimeTypes: ["$.data[*].mime_type", "$.data[*].mimeType"],
        errorMessage: ["$.error.message", "$.message", "$.data.error.message"],
      },
    },
    "image-edit": {
      method: "POST", path: "/v1/images/edits", requestMode: "multipart",
      derive: { quality: { op: "lookup", value: ref("params.quality"), cases: { xhigh: "xhigh", max: "max", auto: "auto", low: "low", standard: "medium", medium: "medium", hd: "high", high: "high" } } },
      bodyTemplate: { $merge: [
        { model: "{{model}}", prompt: "{{prompt}}", size: "{{params.size}}", quality: "{{derived.quality}}", n: "{{params.n}}", response_format: "url" },
        openAiMultipartImageFields(),
      ] },
      response: {
        taskId: ["$.task_id", "$.taskId", "$.id", "$.data.task_id"], status: ["$.status", "$.task_status", "$.data.status"],
        resultUrls: ["$.data[*].url", "$.data[*].image_url"],
        resultData: ["$.data[*].b64_json", "$.data[*].image_base64"],
        resultMimeTypes: ["$.data[*].mime_type", "$.data[*].mimeType"],
        errorMessage: ["$.error.message", "$.message", "$.data.error.message"],
      },
    },
    "image-query": {
      method: "GET", path: "/v1/images/tasks/{taskId}", requestMode: "json",
      fallbacks: [{ path: "/v1/tasks/{taskId}", queryTemplate: {}, onStatus: [404] }],
      response: {
        status: ["$.status", "$.task_status", "$.data.status"], progress: ["$.progress", "$.data.progress"],
        resultUrls: ["$.data[*].url", "$.data[*].image_url", "$.data.result.images[*].url", "$.result.images[*].url"],
        errorCode: ["$.error.code", "$.data.error.code"], errorMessage: ["$.error.message", "$.message", "$.data.error.message", "$.data.fail_reason"],
      },
    },
    "video-submit": {
      method: "POST", path: "/v1/videos", requestMode: "multipart", omitEmpty: true,
      bodyTemplate: { model: "{{model}}", prompt: "{{prompt}}", seconds: "{{params.duration}}", size: "{{params.size}}", aspect_ratio: "{{params.aspect_ratio}}", resolution: "{{params.resolution}}", input_reference: { $files: "{{inputs.images}}" } },
      response: { taskId: ["$.id", "$.task_id"], status: ["$.status", "$.task_status"], resultUrl: ["$.video_url", "$.url"], errorMessage: ["$.error.message", "$.message"] },
    },
    "video-query": {
      method: "GET", path: "/v1/videos/{taskId}", requestMode: "json",
      response: { status: ["$.status", "$.task_status"], progress: "$.progress", resultUrl: ["$.video_url", "$.url"], errorCode: "$.error.code", errorMessage: ["$.error.message", "$.message"] },
    },
    "video-download": { method: "GET", path: "/v1/videos/{taskId}/content", requestMode: "json", responseMode: "binary" },
    "audio-speech": {
      method: "POST", path: "/v1/audio/speech", requestMode: "json", responseMode: "binary", omitEmpty: true,
      headersTemplate: { "Content-Type": "application/json" },
      bodyTemplate: { model: "{{model}}", input: "{{prompt}}", voice: "{{params.voice}}", response_format: "{{params.response_format}}", speed: "{{params.speed}}" },
    },
    "audio-transcribe": {
      method: "POST", path: "/v1/audio/transcriptions", requestMode: "multipart", omitEmpty: true,
      bodyTemplate: { model: "{{model}}", file: { $files: "{{inputs.audios}}" }, language: "{{params.language}}", prompt: "{{prompt}}", response_format: "json", temperature: "{{params.temperature}}" },
      response: { text: ["$.text", "$.data.text"], errorMessage: ["$.error.message", "$.message"] },
    },
    "audio-translate": {
      method: "POST", path: "/v1/audio/translations", requestMode: "multipart", omitEmpty: true,
      bodyTemplate: { model: "{{model}}", file: { $files: "{{inputs.audios}}" }, prompt: "{{prompt}}", response_format: "json", temperature: "{{params.temperature}}" },
      response: { text: ["$.text", "$.data.text"], errorMessage: ["$.error.message", "$.message"] },
    },
  },
  workflows: {
    chat: { submit: "llm-chat", result: { kind: "text", source: "response", mime: "text/plain; charset=utf-8" } },
    vision: { submit: "llm-vision", result: { kind: "text", source: "response", mime: "text/plain; charset=utf-8" } },
    tools: { submit: "llm-tools", result: { kind: "text", source: "response", mime: "application/json; charset=utf-8" } },
    structured: { submit: "llm-structured", result: { kind: "text", source: "response", mime: "application/json; charset=utf-8" } },
    responses: { submit: "llm-responses", result: { kind: "text", source: "response", mime: "text/plain; charset=utf-8" } },
    generate: { submit: "image-generate", poll: imagePoll, result: { kind: "image", source: "resultUrl" } },
    edit: { submit: "image-edit", poll: imagePoll, result: { kind: "image", source: "resultUrl" } },
    "video-generate": {
      submit: "video-submit", poll: { operation: "video-query", intervalMs: 5000, backoff: 1.25, maxIntervalMs: 10000, maxDurationMs: 1800000, status: { pending: ["queued", "pending", "in_progress", "processing"], success: ["completed", "success", "succeeded"], failure: ["failed", "failure", "error", "cancelled", "canceled"] } },
      download: "video-download", result: { kind: "video", source: "binary", mime: "video/mp4" },
    },
    speech: { submit: "audio-speech", result: { kind: "audio", source: "binary", mime: "audio/mpeg" } },
    transcribe: { submit: "audio-transcribe", result: { kind: "text", source: "response", mime: "text/plain; charset=utf-8" } },
    translate: { submit: "audio-translate", result: { kind: "text", source: "response", mime: "text/plain; charset=utf-8" } },
  },
  modelProfiles: {
    "gpt-4o-mini-tts": { label: "OpenAI Speech", capabilities: ["audio.tts"], workflows: { "audio.tts": "speech" }, uiSchemas: ["openai-speech"] },
    "gpt-4o-transcribe": {
      label: "OpenAI Transcription", match: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe"], capabilities: ["audio.transcribe", "audio.translate"],
      workflows: { "audio.transcribe": "transcribe", "audio.translate": "translate" }, uiSchemas: ["openai-transcription"],
      assets: { audios: { mode: "data_url", maxBytes: 26214400, mimeTypes: ["audio/*"] } }, limits: { references: { audios: { min: 1, max: 1 } } },
    },
    "gpt-5": {
      label: "GPT-5 / Responses", match: ["gpt-5", "o1", "o3", "o4"],
      capabilities: ["llm.chat", "llm.chat.vision", "llm.tools", "llm.responses", "llm.structured_output"],
      workflows: { "llm.chat": "chat", "llm.chat.vision": "vision", "llm.tools": "tools", "llm.responses": "responses", "llm.structured_output": "structured" },
      uiSchemas: ["openai-language"], assets: { images: { mode: "data_url", maxBytes: 26214400, mimeTypes: ["image/*"] } },
    },
    ...Object.fromEntries(OPENAI_MINIMAX_VIDEO_PROFILES.map((profile) => [profile.id, {
      label: profile.label + " / OpenAI Compatible", match: [profile.id],
      capabilities: ["video.text_to_video", "video.image_to_video"],
      workflows: { "video.text_to_video": "video-generate", "video.image_to_video": "video-generate" },
      uiSchemas: ["openai-compatible-video"], limits: profile.limits, defaults: profile.defaults,
      assets: { images: { mode: "data_url", maxBytes: 26214400, mimeTypes: ["image/*"] } },
    }])),
    "gpt-chat": {
      label: "OpenAI Chat", match: ["gpt-4", "chatgpt-", "babbage-", "davinci-", "claude-", "deepseek-", "qwen", "glm-", "kimi-", "moonshot-", "minimax-", "minimax/", "agnes-", "gemini-"],
      capabilities: ["llm.chat", "llm.chat.vision", "llm.tools", "llm.responses", "llm.structured_output"],
      workflows: { "llm.chat": "chat", "llm.chat.vision": "vision", "llm.tools": "tools", "llm.responses": "responses", "llm.structured_output": "structured" },
      uiSchemas: ["openai-language"], assets: { images: { mode: "data_url", maxBytes: 26214400, mimeTypes: ["image/*"] } },
    },
    "gpt-image": {
      label: "GPT Image", match: ["gpt-image-", "dall-e-"], capabilities: ["image.generate", "image.edit"],
      workflows: { "image.generate": "generate", "image.edit": "edit" }, uiSchemas: ["openai-image"],
      assets: { images: { mode: "data_url", maxBytes: 52428800, mimeTypes: ["image/*"] } },
      defaults: { size: "1024x1024" }, limits: { references: { images: { max: 16 } }, output: { count: { min: 1, max: 4 } } },
    },
    sora: {
      label: "OpenAI Sora", match: ["sora-"], capabilities: ["video.text_to_video", "video.image_to_video"],
      workflows: { "video.text_to_video": "video-generate", "video.image_to_video": "video-generate" }, uiSchemas: ["openai-video"],
      assets: { images: { mode: "data_url", maxBytes: 26214400, mimeTypes: ["image/*"] } }, limits: { references: { images: { max: 1 } } },
    },
    tts: { label: "OpenAI Speech", match: ["tts-", "gpt-4o-mini-tts"], capabilities: ["audio.tts"], workflows: { "audio.tts": "speech" }, uiSchemas: ["openai-speech"] },
    whisper: {
      label: "OpenAI Transcription", match: ["whisper-", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"], capabilities: ["audio.transcribe", "audio.translate"],
      workflows: { "audio.transcribe": "transcribe", "audio.translate": "translate" }, uiSchemas: ["openai-transcription"],
      assets: { audios: { mode: "data_url", maxBytes: 26214400, mimeTypes: ["audio/*"] } }, limits: { references: { audios: { min: 1, max: 1 } } },
    },
    compatible: {
      label: "OpenAI Compatible", match: [""],
      capabilities: ["llm.chat", "llm.chat.vision", "llm.tools", "llm.responses", "llm.structured_output", "image.generate", "image.edit", "video.text_to_video", "video.image_to_video", "audio.tts", "audio.transcribe", "audio.translate"],
      workflows: {
        "llm.chat": "chat", "llm.chat.vision": "vision", "llm.tools": "tools", "llm.responses": "responses", "llm.structured_output": "structured",
        "image.generate": "generate", "image.edit": "edit", "video.text_to_video": "video-generate", "video.image_to_video": "video-generate",
        "audio.tts": "speech", "audio.transcribe": "transcribe", "audio.translate": "translate",
      },
      uiSchemas: ["openai-language", "openai-image", "openai-compatible-video", "openai-speech", "openai-transcription"],
      assets: {
        images: { mode: "data_url", maxBytes: 52428800, mimeTypes: ["image/*"] },
        audios: { mode: "data_url", maxBytes: 26214400, mimeTypes: ["audio/*"] },
      },
      limits: { references: { images: { max: 16 }, audios: { max: 1 } }, output: { count: { min: 1, max: 4 } } },
    },
  },
  uiSchemas: {
    "openai-language": [
      { key: "temperature", label: "温度", type: "number", default: 0.7, min: 0, max: 2, step: 0.1 },
      { key: "top_p", label: "Top P", type: "number", default: 1, min: 0, max: 1, step: 0.05 },
      { key: "max_tokens", label: "最大输出", type: "number", default: 2048, min: 1, max: 128000 },
    ],
    "openai-image": [
      { key: "size", label: "图片尺寸", type: "text", default: "1024x1024" },
      { key: "quality", label: "质量", type: "select", default: "auto", options: ["auto", "low", "medium", "high", "xhigh", "max", "standard", "hd"].map((value) => ({ label: value, value })) },
    ],
    "openai-compatible-video": [
      { key: "duration", label: "时长（秒）", type: "number", default: 5, min: 1, max: 30, step: 1 },
      { key: "aspect_ratio", label: "比例", type: "select", default: "16:9", options: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].map((value) => ({ label: value, value })) },
      { key: "resolution", label: "分辨率", type: "select", default: "720p", options: ["480p", "720p", "1080p", "2k", "4k"].map((value) => ({ label: value.toUpperCase(), value })) },
    ],
    "openai-video": [
      { key: "duration", label: "时长（秒）", type: "number", default: 5, min: 1, max: 30, step: 1 },
      { key: "size", label: "尺寸", type: "select", default: "1280x720", options: ["1280x720", "720x1280", "1920x1080", "1080x1920"].map((value) => ({ label: value, value })) },
    ],
    "openai-speech": [
      { key: "voice", label: "声音", type: "select", default: "alloy", options: ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"].map((value) => ({ label: value, value })) },
      { key: "response_format", label: "格式", type: "select", default: "mp3", options: ["mp3", "opus", "aac", "flac", "wav"].map((value) => ({ label: value, value })) },
      { key: "speed", label: "语速", type: "number", default: 1, min: 0.25, max: 4, step: 0.05 },
    ],
    "openai-transcription": [
      { key: "language", label: "语言", type: "text", default: "" },
      { key: "temperature", label: "温度", type: "number", default: 0, min: 0, max: 1, step: 0.1 },
    ],
  },
};

// 源：builtins.ts:2346-2397。逐条照搬。
const BUILTIN_PROVIDER_PROTOCOLS_V2 = [
  {
    schemaVersion: PROTOCOL_V2_SCHEMA, kind: "provider", id: "ollama-http", label: "Ollama",
    summary: "本机或局域网 Ollama 的免密 OpenAI 兼容连接协议。", executor: { type: "declarative", engine: ">=1.0.0" },
    auth: { type: "none" }, headers: { Accept: "application/json" },
    models: { method: "GET", path: "/v1/models", response: { data: "$.data" } },
  },
  bearerProvider("openai-http", "OpenAI Compatible"),
  { ...bearerProvider("aliyun-bailian-http", "阿里云百炼"), summary: "阿里云百炼业务空间专属 OpenAI 兼容协议；API Key 必须与 endpoint 地域一致。" },
  { ...bearerProvider("openai-relay", "OpenAI Relay"), summary: "OpenAI 中转平台连接协议；参考图继续通过 Images Generations JSON 的 image 数组提交，不使用 multipart edits。" },
  bearerProvider("xai-http", "Grok Official API"),
  bearerProvider("minimax-http", "MiniMax Official API"),
  {
    schemaVersion: PROTOCOL_V2_SCHEMA, kind: "provider", id: "gemini-http", label: "Google Gemini Developer API",
    summary: "Google Gemini 官方 API Key 平台协议。", executor: { type: "declarative", engine: ">=1.0.0" },
    auth: { type: "google_api_key", header: "x-goog-api-key", credentialRef: "api_key" }, headers: { Accept: "application/json" },
    models: { method: "GET", path: "/v1beta/models", response: { data: "$.models" } },
  },
  bearerProvider("fhl-http", "FHL"),
  bearerProvider("agtoken-http", "AGToken"),
  bearerProvider("zkki-http", "ZKKI"),
  bearerProvider("apimart-http", "APIMart"),
  bearerProvider("modelscope-http", "ModelScope"),
  { ...bearerProvider("volcengine-http", "火山引擎方舟"), summary: "火山方舟 Bearer API Key 与 /api/v3 模型列表连接协议。", models: { method: "GET", path: "/api/v3/models", response: { data: "$.data" } } },
  {
    schemaVersion: PROTOCOL_V2_SCHEMA, kind: "provider", id: "volcengine-speech-http", label: "豆包语音",
    summary: "豆包语音新版控制台 X-Api-Key 连接协议；与火山方舟 API Key 不通用。", executor: { type: "declarative", engine: ">=1.0.0" },
    auth: { type: "api_key_header", header: "X-Api-Key", credentialRef: "api_key" }, headers: { Accept: "application/json" },
    models: { method: "GET", path: "/api/v3/models", response: { data: "$.data" } }, defaults: { timeoutMs: 300000 },
  },
  {
    schemaVersion: PROTOCOL_V2_SCHEMA, kind: "provider", id: "agnes", label: "Agnes AI",
    summary: "Agnes AI 系统声明式平台协议。", executor: { type: "declarative", engine: ">=1.0.0" },
    auth: { type: "bearer", header: "Authorization", prefix: "Bearer ", credentialRef: "api_key" },
    headers: { Accept: "application/json" },
    models: { method: "GET", path: "/v1/models", response: { data: "$.data" } },
  },
];

const BUILTIN_MODEL_PROTOCOLS_V2 = [openAiImagesProtocol];

/** 源：builtins.ts:2399-2725。未移植的协议只登记身份，供 protocol/list 如实标注。 */
const BUILTIN_PROTOCOL_METADATA_V2 = [
  ...BUILTIN_PROVIDER_PROTOCOLS_V2.map((protocol) => ({ id: protocol.id, kind: "provider", label: protocol.label, ported: true, source: "protocol-engine/builtins.ts" })),
  { id: "openai-images", kind: "model", label: "OpenAI Unified", ported: true, source: "protocol-engine/builtins.ts:87" },
  { id: "openai-chat-media", kind: "model", label: "OpenAI Chat 同步返媒体", ported: false, source: "protocol-engine/builtins.ts:301" },
  { id: "comfly-openai", kind: "model", label: "OpenAI 兼容媒体", ported: false, source: "protocol-engine/builtins.ts:373" },
  { id: "gemini-generations", kind: "model", label: "Gemini Generations", ported: false, source: "protocol-engine/builtins.ts:511" },
  { id: "gpt-best-images", kind: "model", label: "GPT-Best Images", ported: false, source: "protocol-engine/builtins.ts:567" },
  { id: "fhl-images", kind: "model", label: "FHL Images", ported: false, source: "protocol-engine/builtins.ts:660" },
  { id: "gemini", kind: "model", label: "Gemini", ported: false, source: "protocol-engine/builtins.ts:701" },
  { id: "zkki-images", kind: "model", label: "ZKKI 图片与视频", ported: false, source: "protocol-engine/builtins.ts:817" },
  { id: "agtoken-videos", kind: "model", label: "AGToken 视频", ported: false, source: "protocol-engine/builtins.ts:1081" },
  { id: "apimart-images", kind: "model", label: "APIMart 图片、视频与语音", ported: false, source: "protocol-engine/builtins.ts:1185" },
  { id: "midjourney", kind: "model", label: "Midjourney", ported: false, source: "protocol-engine/builtins.ts:1696" },
  { id: "apib-images", kind: "model", label: "APIB 图片", ported: false, source: "protocol-engine/builtins.ts:1764" },
  { id: "modelscope-images", kind: "model", label: "ModelScope 图片", ported: false, source: "protocol-engine/builtins.ts:1803" },
  { id: "volcengine", kind: "model", label: "火山方舟能力协议", ported: false, source: "protocol-engine/builtins.ts:1879" },
  { id: "volcengine-speech", kind: "model", label: "豆包语音模型", ported: false, source: "protocol-engine/builtins.ts:1975" },
  { id: "xai", kind: "model", label: "Grok 官方能力协议", ported: false, source: "protocol-engine/builtins.ts:2048" },
  { id: "minimax", kind: "model", label: "MiniMax 官方模型", ported: false, source: "protocol-engine/builtins.ts:2166" },
  { id: "agnes", kind: "model", label: "Agnes", ported: false, source: "protocol-engine/builtins.ts:2389" },
];

function listBuiltinProtocolsV2() {
  return [...BUILTIN_PROVIDER_PROTOCOLS_V2, ...BUILTIN_MODEL_PROTOCOLS_V2];
}

function getBuiltinProtocolV2(kind, idValue) {
  const id = String(idValue || "").trim().toLowerCase();
  return listBuiltinProtocolsV2().find((protocol) => protocol.kind === kind && protocol.id === id) || null;
}

module.exports = {
  BUILTIN_PROVIDER_PROTOCOLS_V2,
  BUILTIN_MODEL_PROTOCOLS_V2,
  BUILTIN_PROTOCOL_METADATA_V2,
  listBuiltinProtocolsV2,
  getBuiltinProtocolV2,
  openAiImagesProtocol,
  openAiMultipartImageFields,
  bearerProvider,
  imagePoll,
};
