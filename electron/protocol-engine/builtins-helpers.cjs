"use strict";
/**
 * dx-protocol/v2 builtins 共享 helper 与 openai-images 协议对象。
 *
 * 源：DXSRC/protocol-engine/builtins.ts
 *   · 共享 helper：builtins.ts:4-85（ref/literal/openAiMultipartImageFields/agnes 系列/
 *     bearerProvider/imagePoll/apimartTaskIdSelectors/apimartVideoResultSelectors/apimartImageRatio）
 *   · openai-images：builtins.ts:87-294（此前已移植的本地化子集，内容保持不变）
 *   · gpt-best helper：builtins.ts:541-563
 *   · gemini helper：builtins.ts:677-698
 *   · agtoken helper：builtins.ts:1063-1079
 *   · apimartGrokRatios：builtins.ts:1542
 *   · midjourney helper：builtins.ts:1659-1693
 *   · volcengine helper：builtins.ts:1872-1875
 * 本文件不定义 openai-images 之外的模型协议；那 17 个见 builtins-models.cjs。
 */
const { PROTOCOL_V2_SCHEMA } = require("./types.cjs");
const { OPENAI_MINIMAX_VIDEO_PROFILES } = require("./openAiMinimaxProfiles.cjs");

const ref = (value) => ({ ref: value })
const literal = (value) => ({ literal: value })
const openAiMultipartImageFields = () => ({
  $cardinality: {
    from: '{{inputs.images}}',
    zero: {},
    one: { image: { $files: '{{inputs.images}}' } },
    many: { 'image[]': { $files: '{{inputs.images}}' } },
  },
})
const agnesRoundedDuration = { op: 'round', value: { op: 'coalesce', values: [ref('params.duration'), literal(5)] } }
const agnesVideoV2DerivedFields = {
  seconds: { op: 'clamp', value: agnesRoundedDuration, min: 1, max: 18 },
  frameRate: literal(24),
  baseWidth: { op: 'lookup', value: { op: 'coalesce', values: [ref('params.aspect_ratio'), literal('16:9')] }, cases: { '16:9': 1152, '9:16': 648, '4:3': 1024, '3:4': 768, '1:1': 768, '21:9': 1280, '9:21': 544 }, fallback: 1152 },
  baseHeight: { op: 'lookup', value: { op: 'coalesce', values: [ref('params.aspect_ratio'), literal('16:9')] }, cases: { '16:9': 648, '9:16': 1152, '4:3': 768, '3:4': 1024, '1:1': 768, '21:9': 544, '9:21': 1280 }, fallback: 768 },
  scale: { op: 'lookup', value: { op: 'coalesce', values: [ref('params.resolution'), literal('720p')] }, cases: { '480p': 0.625, '720p': 1, '780p': 1, '1080p': 1.5 }, fallback: 1 },
  width: { op: 'roundMultiple', value: { op: 'multiply', values: [ref('derived.baseWidth'), ref('derived.scale')] }, multiple: 8, min: 64 },
  height: { op: 'roundMultiple', value: { op: 'multiply', values: [ref('derived.baseHeight'), ref('derived.scale')] }, multiple: 8, min: 64 },
  target: { op: 'clamp', value: { op: 'multiply', values: [ref('derived.seconds'), ref('derived.frameRate')] }, min: 9, max: 441 },
  frameUnits: { op: 'round', value: { op: 'divide', left: { op: 'subtract', left: ref('derived.target'), right: literal(1) }, right: literal(8) } },
  numFrames: { op: 'clamp', value: { op: 'add', values: [{ op: 'multiply', values: [literal(8), { op: 'max', values: [literal(1), ref('derived.frameUnits')] }] }, literal(1)] }, min: 9, max: 441 },
}
const agnesVideo25DerivedFields = {
  secondsNumber: { op: 'clamp', value: agnesRoundedDuration, min: 4, max: 12 },
  seconds: { op: 'toString', value: ref('derived.secondsNumber') },
  ratio: {
    op: 'lookup', value: { op: 'coalesce', values: [ref('params.aspect_ratio'), literal('16:9')] },
    cases: { '21:9': '21:9', '16:9': '16:9', '4:3': '4:3', '1:1': '1:1', '3:4': '3:4', '9:16': '9:16' }, fallback: '16:9',
  },
}
const agnesTransientRetry = { attempts: 3, delayMs: 2000, backoff: 2, retryStatus: [403, 429, 500, 502, 503, 504], retryNetwork: true }

const bearerProvider = (id, label) => ({
  schemaVersion: 'dx-protocol/v2', kind: 'provider', id, label,
  summary: `${label} Bearer 平台连接协议。`,
  executor: { type: 'declarative', engine: '>=1.0.0' },
  auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ', credentialRef: 'api_key' },
  headers: { Accept: 'application/json' },
  models: { method: 'GET', path: '/v1/models', response: { data: '$.data' } },
})

const imagePoll = {
  operation: 'image-query', intervalMs: 2500, backoff: 1.25, maxIntervalMs: 8000,
  status: {
    pending: ['queued', 'pending', 'processing', 'in_progress', 'running', 'created'],
    success: ['completed', 'succeeded', 'success', 'done', 'finished'],
    failure: ['failed', 'failure', 'error', 'canceled', 'cancelled', 'timeout', 'rejected'],
  },
}

const apimartTaskIdSelectors = [
  '$.task_id', '$.taskId', '$.submit_id', '$.submitId', '$.id',
  '$.data.task_id', '$.data.taskId', '$.data.submit_id', '$.data.submitId', '$.data.id',
  '$.data[0].task_id', '$.data[0].taskId', '$.data[0].submit_id', '$.data[0].submitId', '$.data[0].id',
  '$.data[*].task_id', '$.data[*].taskId', '$.data[*].submit_id', '$.data[*].submitId', '$.data[*].id',
  '$.data.data.task_id', '$.data.data.taskId', '$.data.data.submit_id', '$.data.data.submitId', '$.data.data.id',
  '$.result.task_id', '$.result.taskId', '$.result.submit_id', '$.result.submitId', '$.result.id',
  '$.output.task_id', '$.output.taskId', '$.output.submit_id', '$.output.submitId', '$.output.id',
  '$.task.task_id', '$.task.taskId', '$.task.submit_id', '$.task.submitId', '$.task.id',
]

// APIMart-compatible gateways do not all expose the completed video at the
// same depth. In particular, apib.ai returns data.result.videos[].url as an
// array, so the final wildcard is required to flatten it into standard URLs.
const apimartVideoResultSelectors = [
  '$.video_url', '$.url', '$.data.video_url', '$.data.url',
  '$.data.output', '$.data.outputs[*]',
  '$.data[0].video_url', '$.data[0].url',
  '$.data.result.videos[*].url[*]', '$.data.result.videos[*].url',
  '$.data.result.videos[*].video_url', '$.data.result.video_url', '$.data.result.url',
  '$.result.videos[*].url[*]', '$.result.videos[*].url',
  '$.result.video_url', '$.result.url', '$.output.video_url', '$.output.url',
]

// APIMart accepts all documented ratios, `auto`, and direct pixel dimensions.
// Prefer the v2 canonical aspect ratio, but preserve an explicit legacy size
// instead of silently coercing a valid upstream value to 1:1.
const apimartImageRatio = () => ({
  op: 'coalesce',
  values: [ref('params.aspect_ratio'), ref('params.aspectRatio'), ref('params.size'), literal('1:1')],
})

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

const gptBestQuality = {
  op: 'lookup', value: { op: 'coalesce', values: [ref('params.quality'), literal('auto')] },
  cases: { xhigh: 'xhigh', max: 'max', auto: 'auto', low: 'low', standard: 'medium', medium: 'medium', hd: 'high', high: 'high' }, fallback: 'auto',
}

const gptBestResponse = {
  taskId: ['$.task_id', '$.taskId', '$.id', '$.data.task_id', '$.data.taskId', '$.data.id'],
  status: ['$.status', '$.task_status', '$.data.status', '$.data.task_status'],
  resultUrls: [
    '$.data[*].url', '$.data[*].image_url', '$.images[*].url', '$.images[*].image',
    '$.data.data[*].url', '$.data.data[*].image_url',
    '$.data.data.data[*].url', '$.data.data.data[*].image_url',
    '$.result.data[*].url', '$.result.images[*].url', '$.output.data[*].url',
  ],
  resultData: [
    '$.data[*].b64_json', '$.data[*].image_base64', '$.images[*].b64_json', '$.images[*].image_base64',
    '$.data.data[*].b64_json', '$.data.data[*].image_base64',
    '$.data.data.data[*].b64_json', '$.data.data.data[*].image_base64',
    '$.result.data[*].b64_json', '$.result.images[*].b64_json',
  ],
  errorCode: ['$.error.code', '$.data.error.code', '$.code'],
  errorMessage: ['$.error.message', '$.message', '$.data.error.message', '$.data.fail_reason', '$.data.message'],
}

const geminiImageRatio = () => ({
  op: 'lookup',
  value: { op: 'coalesce', values: [ref('params.aspect_ratio'), ref('params.aspectRatio'), ref('params.size'), literal('1:1')] },
  cases: {
    '1:1': '1:1', '2:3': '2:3', '3:2': '3:2', '3:4': '3:4', '4:3': '4:3',
    '4:5': '4:5', '5:4': '5:4', '9:16': '9:16', '16:9': '16:9', '21:9': '21:9',
    '1024x1024': '1:1', '1024x1536': '2:3', '1536x1024': '3:2',
  },
  fallback: '1:1',
})

const geminiImageSize = () => ({
  op: 'upper',
  value: { op: 'coalesce', values: [ref('params.resolution'), ref('params.imageSize'), literal('1K')] },
})

const geminiGenerateContentResponse = {
  resultData: '$.candidates[*].content.parts[*].inlineData.data',
  resultMimeTypes: '$.candidates[*].content.parts[*].inlineData.mimeType',
  errorCode: ['$.error.code', '$.promptFeedback.blockReason'],
  errorMessage: ['$.error.message', '$.promptFeedback.blockReasonMessage', '$.candidates[0].finishMessage'],
}

const agtokenPollStatus = {
  pending: ['queued', 'pending', 'processing', 'in_progress', 'running'],
  success: ['success', 'succeeded', 'completed'],
  failure: ['failure', 'failed', 'error', 'rejected', 'canceled', 'cancelled', 'timeout'],
}
const agtokenQueryRetry = { attempts: 3, delayMs: 500, backoff: 2, retryStatus: [429, 500, 502, 503, 504], retryNetwork: true }
const agtokenVideoWorkflows = {
  'video.generate': 'unified', 'video.text_to_video': 'unified', 'video.image_to_video': 'unified', 'video.multi_reference': 'unified',
}
const agtokenSeedanceWorkflows = {
  'video.generate': 'seedance', 'video.text_to_video': 'seedance', 'video.image_to_video': 'seedance', 'video.first_last_frame': 'seedance',
  'video.multi_reference': 'seedance', 'video.video_to_video': 'seedance', 'video.audio_reference': 'seedance', 'video.multimodal': 'seedance',
}
const agtokenWanWorkflows = {
  'video.generate': 'unified', 'video.text_to_video': 'unified', 'video.image_to_video': 'wan', 'video.first_last_frame': 'wan',
  'video.multi_reference': 'wan', 'video.video_to_video': 'wan', 'video.audio_reference': 'wan', 'video.multimodal': 'wan',
}

const apimartGrokRatios = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '9:19.5', '19.5:9', '9:20', '20:9', '1:2', '2:1', 'auto']

const midjourneyPoll = {
  operation: 'tasks.get',
  intervalMs: 2_000,
  backoff: 1.25,
  maxIntervalMs: 8_000,
  maxDurationMs: 900_000,
  status: {
    pending: ['queued', 'pending', 'submitted', 'processing', 'running', 'in_progress'],
    success: ['succeed', 'succeeded', 'success', 'completed', 'done', 'finished'],
    failure: ['failed', 'failure', 'error', 'canceled', 'cancelled', 'timeout', 'rejected'],
  },
}

const midjourneyResponse = {
  taskId: apimartTaskIdSelectors,
  status: ['$.data.status', '$.data.task_status', '$.data.taskStatus', '$.data[*].status', '$.data[*].task_status', '$.status', '$.task_status'],
  resultUrls: ['$.data.image_urls[*]', '$.data.imageUrls[*]', '$.data[*].image_urls[*]', '$.data[*].image_url', '$.data.result.images[*].url', '$.data[*].result.images[*].url', '$.data.image_url', '$.data.imageUrl', '$.data.grid_image_url', '$.data.gridImageUrl', '$.image_urls[*]', '$.image_url'],
  errorMessage: ['$.data.error.message', '$.data.fail_reason', '$.data.message', '$.data[*].error.message', '$.data[*].fail_reason', '$.error.message', '$.message'],
}

const midjourneyAction = (path, bodyTemplate) => ({
  method: 'POST',
  path,
  requestMode: 'json',
  omitEmpty: true,
  headersTemplate: { 'Content-Type': 'application/json' },
  bodyTemplate: { ...bodyTemplate, speed: '{{params.speed}}', metadata: { source: 'dx-os-canvas' } },
  response: midjourneyResponse,
})

const midjourneyWorkflow = (submit) => ({
  submit,
  poll: midjourneyPoll,
  result: { kind: 'image', source: 'resultUrl' },
})

const volcengineWorkflows = {
  'video.generate': 'video', 'video.text_to_video': 'video', 'video.image_to_video': 'video', 'video.first_last_frame': 'video',
  'video.multi_reference': 'video', 'video.video_to_video': 'video', 'video.audio_reference': 'video', 'video.multimodal': 'video',
}

module.exports = {
  PROTOCOL_V2_SCHEMA,
  ref,
  literal,
  openAiMultipartImageFields,
  openAiImagesProtocol,
  agnesRoundedDuration,
  agnesVideoV2DerivedFields,
  agnesVideo25DerivedFields,
  agnesTransientRetry,
  bearerProvider,
  imagePoll,
  apimartTaskIdSelectors,
  apimartVideoResultSelectors,
  apimartImageRatio,
  apimartGrokRatios,
  gptBestQuality,
  gptBestResponse,
  geminiImageRatio,
  geminiImageSize,
  geminiGenerateContentResponse,
  agtokenPollStatus,
  agtokenQueryRetry,
  agtokenVideoWorkflows,
  agtokenSeedanceWorkflows,
  agtokenWanWorkflows,
  midjourneyPoll,
  midjourneyResponse,
  midjourneyAction,
  midjourneyWorkflow,
  volcengineWorkflows,
};
