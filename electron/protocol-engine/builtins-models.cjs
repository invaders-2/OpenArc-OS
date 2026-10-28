"use strict";
/**
 * dx-protocol/v2 内置模型协议：openai-images 之外的 18 个（顺序与源文件声明顺序一致）。
 *
 * 源：DXSRC/protocol-engine/builtins.ts
 *   · openai-chat-media  :300-365
 *   · comfly-openai      :367-503
 *   · gemini-generations :505-539
 *   · gpt-best-images    :565-655
 *   · fhl-images         :657-675
 *   · gemini             :700-815
 *   · gemini-general     :865-871（...spread geminiProtocol 后仅改 id/label/summary）
 *   · zkki-images        :817-1061
 *   · agtoken-videos     :1080-1182
 *   · apimart-images     :1184-1657
 *   · midjourney         :1695-1759
 *   · apib-images        :1761-1800
 *   · modelscope-images  :1802-1870
 *   · volcengine         :1877-1971
 *   · volcengine-speech  :1973-2044
 *   · xai                :2046-2162
 *   · minimax            :2164-2344
 *   · agnes              :2400-2714（源 BUILTIN_MODEL_PROTOCOLS_V2 数组内联项）
 *
 * 云协议 OUT（不移植：DX 云能力，见铁律 2）：
 *   · dxos-media  :296-338  模型协议；summary 明写「DX OS 公共 API」，指向 api.dx-os.com。
 *   · dxos-http   :2476     provider 协议；bearerProvider('dxos-http', 'DX OS API')。
 *
 * 共享 helper 见 builtins-helpers.cjs。apimartSeedanceProfile 由
 * apimartImagesProtocol 派生，为避免 require 环按源顺序留在本文件内联。
 */
const {
  ref,
  literal,
  openAiMultipartImageFields,
  openAiImagesProtocol,
  imagePoll,
  agnesRoundedDuration,
  agnesVideoV2DerivedFields,
  agnesVideo25DerivedFields,
  agnesTransientRetry,
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
} = require("./builtins-helpers.cjs");

const openAiChatMediaProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'openai-chat-media', label: 'OpenAI Chat 同步返媒体',
  summary: '供底层仍是 LLM 的图片/视频模型使用：同步调用 /v1/chat/completions，并从 message.content、Markdown、URL、Data URL 或多模态内容块提取媒体。',
  executor: { type: 'declarative', engine: '>=1.0.0' },
  capabilities: ['image.generate', 'image.edit', 'video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference'],
  operations: {
    'image-generate': {
      method: 'POST', path: '/v1/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: { model: '{{model}}', stream: false, messages: [{ role: 'user', content: '{{prompt}}' }] },
      response: {
        resultUrls: ['$.choices[0].message.content', '$.choices[0].message.images[*].url', '$.choices[0].message.content[*].image_url.url', '$.choices[0].message.content[*].url'],
        resultData: ['$.choices[0].message.images[*].b64_json', '$.choices[0].message.content[*].b64_json', '$.choices[0].message.content[*].inline_data.data'],
        resultMimeTypes: ['$.choices[0].message.content[*].inline_data.mime_type'], errorMessage: ['$.error.message', '$.message'],
      },
    },
    'image-edit': {
      method: 'POST', path: '/v1/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', stream: false,
        messages: [{ role: 'user', content: { $concat: [[{ type: 'text', text: '{{prompt}}' }], { $map: { from: '{{inputs.images}}', template: { type: 'image_url', image_url: { url: '{{item.dataUrl}}' } } } }] } }],
      },
      response: {
        resultUrls: ['$.choices[0].message.content', '$.choices[0].message.images[*].url', '$.choices[0].message.content[*].image_url.url', '$.choices[0].message.content[*].url'],
        resultData: ['$.choices[0].message.images[*].b64_json', '$.choices[0].message.content[*].b64_json', '$.choices[0].message.content[*].inline_data.data'],
        resultMimeTypes: ['$.choices[0].message.content[*].inline_data.mime_type'], errorMessage: ['$.error.message', '$.message'],
      },
    },
    'video-generate': {
      method: 'POST', path: '/v1/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', stream: false,
        messages: [{ role: 'user', content: { $concat: [[{ type: 'text', text: '{{prompt}}' }], { $map: { from: '{{inputs.images}}', template: { type: 'image_url', image_url: { url: '{{item.dataUrl}}' } } } }] } }],
      },
      response: {
        resultUrls: ['$.choices[0].message.content', '$.choices[0].message.videos[*].url', '$.choices[0].message.content[*].video_url.url', '$.choices[0].message.content[*].url'],
        errorMessage: ['$.error.message', '$.message'],
      },
    },
  },
  workflows: {
    'image-generate': { submit: 'image-generate', result: { kind: 'image', source: 'resultUrl' } },
    'image-edit': { submit: 'image-edit', result: { kind: 'image', source: 'resultUrl' } },
    'video-generate': { submit: 'video-generate', result: { kind: 'video', source: 'resultUrl' } },
  },
  modelProfiles: {
    fallback: {
      label: 'Chat Completions 同步返媒体', match: [''],
      capabilities: ['image.generate', 'image.edit', 'video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference'],
      workflows: {
        'image.generate': 'image-generate', 'image.edit': 'image-edit',
        'video.generate': 'video-generate', 'video.text_to_video': 'video-generate', 'video.image_to_video': 'video-generate',
        'video.first_last_frame': 'video-generate', 'video.multi_reference': 'video-generate',
      },
      uiSchemas: ['chat-media-image', 'chat-media-video'],
      assets: { images: { mode: 'data_url', maxBytes: 52_428_800, mimeTypes: ['image/*'] } },
      limits: { references: { images: { max: 16 } }, output: { count: { min: 1, max: 4 } } },
    },
  },
  uiSchemas: {
    'chat-media-image': [],
    'chat-media-video': [],
  },
}

// The relay-oriented OpenAI-compatible surface is intentionally broader than
// the official OpenAI model catalogue: relayed Gemini/Seedream image models
// and Seedance/Veo video models share Images/Video Generations contracts.
// Keep this as a separate last-resort model protocol so official, vendor and
// administrator-selected profiles remain authoritative when they match.
const comflyOpenAiProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'comfly-openai', label: 'OpenAI 兼容媒体',
  summary: 'OpenAI 兼容中转站的通用媒体兜底：图片使用 Images Generations，视频使用统一 Video Generations 与任务轮询。',
  executor: { type: 'declarative', engine: '>=1.0.0' },
  capabilities: [
    'image.generate', 'image.edit', 'video.generate', 'video.text_to_video', 'video.image_to_video',
    'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal',
  ],
  operations: {
    'image-generate': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', size: '{{params.size}}',
        aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', response_format: 'url',
      },
      response: {
        taskId: apimartTaskIdSelectors,
        status: ['$.status', '$.task_status', '$.data.status', '$.data.task_status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url', '$.images[*].url', '$.result.images[*].url'],
        resultData: ['$.data[*].b64_json', '$.data[*].image_base64', '$.data[*].base64', '$.images[*].b64_json'],
        resultMimeTypes: ['$.data[*].mime_type', '$.data[*].mimeType'],
        errorMessage: ['$.error.message', '$.message', '$.data.error.message', '$.data.fail_reason'],
      },
    },
    'image-edit': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', image: '{{inputs.images[*].dataUrl}}',
        n: '{{params.n}}', size: '{{params.size}}', aspect_ratio: '{{params.aspect_ratio}}',
        resolution: '{{params.resolution}}', response_format: 'url',
      },
      response: {
        taskId: apimartTaskIdSelectors,
        status: ['$.status', '$.task_status', '$.data.status', '$.data.task_status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url', '$.images[*].url', '$.result.images[*].url'],
        resultData: ['$.data[*].b64_json', '$.data[*].image_base64', '$.data[*].base64', '$.images[*].b64_json'],
        resultMimeTypes: ['$.data[*].mime_type', '$.data[*].mimeType'],
        errorMessage: ['$.error.message', '$.message', '$.data.error.message', '$.data.fail_reason'],
      },
    },
    'image-query': {
      method: 'GET', path: '/v1/images/tasks/{taskId}', requestMode: 'json',
      fallbacks: [
        { path: '/v1/tasks/{taskId}', onStatus: [404, 405] },
        { path: '/tasks/{taskId}', onStatus: [404, 405] },
      ],
      response: {
        status: ['$.status', '$.task_status', '$.data.status', '$.data.task_status'],
        progress: ['$.progress', '$.data.progress'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url', '$.data.data.data[*].url', '$.data.result.images[*].url', '$.result.images[*].url'],
        resultData: ['$.data[*].b64_json', '$.data[*].image_base64', '$.data[*].base64', '$.data.data.data[*].b64_json', '$.result.images[*].b64_json'],
        errorMessage: ['$.error.message', '$.message', '$.data.error.message', '$.data.fail_reason'],
      },
    },
    'video-generate': {
      method: 'POST', path: '/v2/videos/generations', requestMode: 'json', omitEmpty: true,
      fallbacks: [{ path: '/v1/videos/generations', onStatus: [404, 405] }],
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', images: '{{inputs.images[*].dataUrl}}',
        videos: '{{inputs.videos[*].dataUrl}}', audios: '{{inputs.audios[*].dataUrl}}',
        duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}',
        resolution: '{{params.resolution}}', size: '{{params.size}}',
      },
      response: {
        taskId: apimartTaskIdSelectors,
        status: ['$.status', '$.task_status', '$.data.status', '$.data.task_status'],
        resultUrls: apimartVideoResultSelectors,
        errorMessage: ['$.error.message', '$.message', '$.data.error.message', '$.data.fail_reason'],
      },
    },
    'video-query': {
      method: 'GET', path: '/v2/videos/generations/{taskId}', requestMode: 'json',
      fallbacks: [
        { path: '/v1/videos/generations/{taskId}', onStatus: [404, 405] },
        { path: '/v2/tasks/{taskId}', onStatus: [404, 405] },
        { path: '/v1/tasks/{taskId}', onStatus: [404, 405] },
        { path: '/tasks/{taskId}', onStatus: [404, 405] },
      ],
      response: {
        status: ['$.status', '$.task_status', '$.data.status', '$.data.task_status'],
        progress: ['$.progress', '$.data.progress'], resultUrls: apimartVideoResultSelectors,
        errorMessage: ['$.error.message', '$.message', '$.data.error.message', '$.data.fail_reason'],
      },
    },
  },
  workflows: {
    'image-generate': { submit: 'image-generate', poll: { ...imagePoll, operation: 'image-query', maxDurationMs: 900_000 }, result: { kind: 'image', source: 'resultUrl' } },
    'image-edit': { submit: 'image-edit', poll: { ...imagePoll, operation: 'image-query', maxDurationMs: 900_000 }, result: { kind: 'image', source: 'resultUrl' } },
    'video-generate': {
      submit: 'video-generate',
      poll: { operation: 'video-query', intervalMs: 2000, backoff: 2, maxIntervalMs: 8000, maxDurationMs: 1_800_000, status: imagePoll.status },
      result: { kind: 'video', source: 'resultUrl' },
    },
  },
  modelProfiles: {
    fallback: {
      label: 'OpenAI 兼容图片/视频模型', match: [''],
      capabilities: [
        'image.generate', 'image.edit', 'video.generate', 'video.text_to_video', 'video.image_to_video',
        'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal',
      ],
      workflows: {
        'image.generate': 'image-generate', 'image.edit': 'image-edit',
        'video.generate': 'video-generate', 'video.text_to_video': 'video-generate', 'video.image_to_video': 'video-generate',
        'video.first_last_frame': 'video-generate', 'video.multi_reference': 'video-generate',
        'video.video_to_video': 'video-generate', 'video.audio_reference': 'video-generate', 'video.multimodal': 'video-generate',
      },
      uiSchemas: ['comfly-image', 'comfly-video'],
      assets: {
        images: { mode: 'data_url', maxBytes: 52_428_800, mimeTypes: ['image/*'] },
        videos: { mode: 'data_url', maxBytes: 524_288_000, mimeTypes: ['video/*'] },
        audios: { mode: 'data_url', maxBytes: 104_857_600, mimeTypes: ['audio/*'] },
      },
      limits: { references: { images: { max: 16 }, videos: { max: 3 }, audios: { max: 3 } }, output: { count: { min: 1, max: 4 } } },
    },
  },
  uiSchemas: {
    'comfly-image': [
      { key: 'size', label: '图片尺寸', type: 'text', default: '1024x1024' },
      { key: 'aspect_ratio', label: '图片比例', type: 'text', default: '1:1' },
      { key: 'resolution', label: '清晰度', type: 'text', default: '1k' },
    ],
    'comfly-video': [
      { key: 'duration', label: '时长', type: 'number', default: 5, min: 1, max: 60, step: 1 },
      { key: 'aspect_ratio', label: '画面比例', type: 'text', default: '16:9' },
      { key: 'resolution', label: '清晰度', type: 'text', default: '720p' },
    ],
  },
}

/**
 * Relay sites commonly expose Gemini image models through an OpenAI-style
 * Images Generations endpoint instead of Google's native generateContent API.
 * Keep this explicit so administrators never need to misuse the official
 * Gemini protocol for a relay endpoint.
 */
const geminiGenerationsProtocol = {
  ...comflyOpenAiProtocol,
  id: 'gemini-generations',
  label: 'Gemini 中转站 Generations',
  summary: 'Gemini 图片中转协议：文生图与参考图编辑统一使用 JSON 格式的 /v1/images/generations，不使用 Google 官方 generateContent。',
  capabilities: ['image.generate', 'image.edit'],
  operations: {
    'image-generate': comflyOpenAiProtocol.operations['image-generate'],
    'image-edit': comflyOpenAiProtocol.operations['image-edit'],
    'image-query': comflyOpenAiProtocol.operations['image-query'],
  },
  workflows: {
    'image-generate': comflyOpenAiProtocol.workflows['image-generate'],
    'image-edit': comflyOpenAiProtocol.workflows['image-edit'],
  },
  modelProfiles: {
    fallback: {
      label: 'Gemini 中转站图片模型', match: [''],
      capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'image-generate', 'image.edit': 'image-edit' },
      uiSchemas: ['gemini-generations-image'],
      assets: { images: { mode: 'data_url', maxBytes: 52_428_800, mimeTypes: ['image/*'] } },
      limits: { references: { images: { max: 16 } }, output: { count: { min: 1, max: 4 } } },
    },
  },
  uiSchemas: {
    'gemini-generations-image': comflyOpenAiProtocol.uiSchemas['comfly-image'],
  },
}

/** GPT-Best 的 OpenAI Images 扩展：固定使用异步提交并查询嵌套结果。 */
const gptBestImagesProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'gpt-best-images', label: 'GPT-Best Images',
  summary: 'GPT-Best OpenAI Images 扩展：同步兼容、异步提交、multipart 编辑、嵌套 URL/Base64 结果与 GPT Image 2 参数。',
  executor: { type: 'declarative', engine: '>=1.0.0' },
  capabilities: ['image.generate', 'image.edit'],
  operations: {
    'generate-general': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true,
      queryTemplate: { async: true }, headersTemplate: { 'Content-Type': 'application/json' },
      derive: { quality: gptBestQuality },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', quality: '{{derived.quality}}', n: '{{params.n}}' },
      response: gptBestResponse,
    },
    'generate-gpt-image-2': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true,
      queryTemplate: { async: true }, headersTemplate: { 'Content-Type': 'application/json' },
      derive: { quality: gptBestQuality },
      // 逆向分组只保证以下字段；不发送 n/response_format 等扩展字段。
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', quality: '{{derived.quality}}' },
      response: gptBestResponse,
    },
    'edit-general': {
      method: 'POST', path: '/v1/images/edits', requestMode: 'multipart', omitEmpty: true,
      queryTemplate: { async: true }, derive: { quality: gptBestQuality },
      bodyTemplate: { $merge: [
        { model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', quality: '{{derived.quality}}', n: '{{params.n}}' },
        openAiMultipartImageFields(),
      ] },
      response: gptBestResponse,
    },
    'edit-json-generations': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true,
      queryTemplate: { async: true }, headersTemplate: { 'Content-Type': 'application/json' }, derive: { quality: gptBestQuality },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', quality: '{{derived.quality}}', n: '{{params.n}}', image: '{{inputs.images[*].dataUrl}}' },
      response: gptBestResponse,
    },
    'edit-gpt-image-2': {
      method: 'POST', path: '/v1/images/edits', requestMode: 'multipart', omitEmpty: true,
      queryTemplate: { async: true }, derive: { quality: gptBestQuality },
      bodyTemplate: { $merge: [
        { model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', quality: '{{derived.quality}}' },
        openAiMultipartImageFields(),
      ] },
      response: gptBestResponse,
    },
    query: {
      method: 'GET', path: '/v1/images/tasks/{taskId}', requestMode: 'json',
      response: gptBestResponse,
    },
  },
  workflows: {
    generate: { submit: 'generate-general', poll: { ...imagePoll, operation: 'query', maxDurationMs: 900_000 }, result: { kind: 'image', source: 'resultUrl' } },
    'generate-gpt-image-2': { submit: 'generate-gpt-image-2', poll: { ...imagePoll, operation: 'query', maxDurationMs: 900_000 }, result: { kind: 'image', source: 'resultUrl' } },
    edit: { submit: 'edit-general', poll: { ...imagePoll, operation: 'query', maxDurationMs: 900_000 }, result: { kind: 'image', source: 'resultUrl' } },
    'edit-json-generations': { submit: 'edit-json-generations', poll: { ...imagePoll, operation: 'query', maxDurationMs: 900_000 }, result: { kind: 'image', source: 'resultUrl' } },
    'edit-gpt-image-2': { submit: 'edit-gpt-image-2', poll: { ...imagePoll, operation: 'query', maxDurationMs: 900_000 }, result: { kind: 'image', source: 'resultUrl' } },
  },
  modelProfiles: {
    'gpt-image-2': {
      label: 'GPT Image 2', capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate-gpt-image-2', 'image.edit': 'edit-gpt-image-2' }, uiSchemas: ['gpt-best-image'],
      assets: { images: { mode: 'data_url', maxBytes: 26_214_400, mimeTypes: ['image/png', 'image/jpeg', 'image/webp'] } },
      defaults: { size: '1024x1024', quality: 'auto', n: 1 }, limits: { references: { images: { max: 16 } }, output: { count: { min: 1, max: 1 } } },
    },
    'dall-e-3': {
      label: 'DALL·E 3', match: ['dall-e-3'], capabilities: ['image.generate'], workflows: { 'image.generate': 'generate' }, uiSchemas: ['gpt-best-image'],
      defaults: { size: '1024x1024', quality: 'auto', n: 1 },
    },
    'json-images': {
      label: 'GPT-Best JSON Generations Images',
      match: ['nano-banana', 'gemini-', 'qwen-image', 'seedream', 'flux', 'recraft', 'grok-', 'ideogram', 'jimeng', 'kolors', 'photon', 'cogview', 'sora_image'],
      capabilities: ['image.generate', 'image.edit'], workflows: { 'image.generate': 'generate', 'image.edit': 'edit-json-generations' }, uiSchemas: ['gpt-best-image'],
      assets: { images: { mode: 'data_url', maxBytes: 26_214_400, mimeTypes: ['image/png', 'image/jpeg', 'image/webp'] } },
      defaults: { size: '1024x1024', quality: 'auto', n: 1 }, limits: { references: { images: { max: 16 } }, output: { count: { min: 1, max: 10 } } },
    },
    images: {
      label: 'GPT-Best Multipart Edits Images', match: ['gpt-image-', 'dall-e-'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate', 'image.edit': 'edit' }, uiSchemas: ['gpt-best-image'],
      assets: { images: { mode: 'data_url', maxBytes: 26_214_400, mimeTypes: ['image/png', 'image/jpeg', 'image/webp'] } },
      defaults: { size: '1024x1024', quality: 'auto', n: 1 }, limits: { references: { images: { max: 16 } }, output: { count: { min: 1, max: 10 } } },
    },
  },
  uiSchemas: {
    'gpt-best-image': [
      { key: 'size', label: '图片尺寸', type: 'text', default: '1024x1024' },
      { key: 'quality', label: '质量', type: 'select', default: 'auto', options: ['auto', 'low', 'medium', 'high'].map((value) => ({ label: value, value })) },
      { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 10, step: 1 },
    ],
  },
}

// FHL 的旧版稳定适配使用重复的 `image` multipart 字段，而不是官方
// SDK 常见的 `image[]`。两者不能在通用 OpenAI Images 协议里互换，
// 因此保留为独立模型协议；提交、轮询和结果结构仍遵循 Images API。
const fhlImagesProtocol = {
  ...openAiImagesProtocol,
  id: 'fhl-images',
  label: 'FHL Images',
  summary: 'FHL 的 OpenAI Images 兼容协议；图像编辑使用重复 image multipart 字段。',
  operations: {
    ...openAiImagesProtocol.operations,
    'image-edit': {
      ...openAiImagesProtocol.operations['image-edit'],
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', quality: '{{derived.quality}}', n: '{{params.n}}',
        image: { $files: '{{inputs.images}}' }, response_format: 'url',
      },
    },
  },
}

/** Google Gemini Developer API through the broadly supported generateContent surface. */
const geminiProtocol = {
  schemaVersion: 'dx-protocol/v2',
  kind: 'model',
  id: 'gemini',
  label: 'Google Gemini 官方协议',
  summary: 'Gemini Developer API 官方对话、视觉、工具调用及图片生成/编辑协议，统一使用 generateContent。',
  executor: { type: 'declarative', engine: '>=1.0.0' },
  capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools', 'llm.structured_output', 'image.generate', 'image.edit'],
  operations: {
    'llm-chat': {
      method: 'POST', path: '/v1beta/models/{model}:generateContent', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
        generationConfig: { temperature: '{{params.temperature}}', topP: '{{params.top_p}}', maxOutputTokens: { $coalesce: ['{{params.max_output_tokens}}', '{{params.max_tokens}}'] } },
      },
      response: { text: '$.candidates[0].content.parts[0].text', usage: '$.usageMetadata', errorMessage: ['$.error.message', '$.message'] },
    },
    'llm-vision': {
      method: 'POST', path: '/v1beta/models/{model}:generateContent', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        contents: [{ role: 'user', parts: { $concat: [
          [{ text: '{{prompt}}' }],
          { $map: { from: '{{inputs.images}}', template: { inlineData: { mimeType: '{{item.mime}}', data: { $dataUrlBase64: '{{item.dataUrl}}' } } } } },
        ] } }],
        generationConfig: { temperature: '{{params.temperature}}', topP: '{{params.top_p}}', maxOutputTokens: { $coalesce: ['{{params.max_output_tokens}}', '{{params.max_tokens}}'] } },
      },
      response: { text: '$.candidates[0].content.parts[0].text', usage: '$.usageMetadata', errorMessage: ['$.error.message', '$.message'] },
    },
    'llm-tools': {
      method: 'POST', path: '/v1beta/models/{model}:generateContent', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
        tools: [{ functionDeclarations: { $map: { from: '{{params.tools}}', template: { name: '{{item.function.name}}', description: '{{item.function.description}}', parameters: '{{item.function.parameters}}' } } } }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { temperature: '{{params.temperature}}', topP: '{{params.top_p}}', maxOutputTokens: { $coalesce: ['{{params.max_output_tokens}}', '{{params.max_tokens}}'] } },
      },
      response: { text: ['$.candidates[0].content.parts[0].text', '$.candidates[0].content.parts[*].functionCall'], usage: '$.usageMetadata', errorMessage: ['$.error.message', '$.message'] },
    },
    'llm-structured': {
      method: 'POST', path: '/v1beta/models/{model}:generateContent', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: '{{params.response_schema}}', temperature: '{{params.temperature}}', maxOutputTokens: { $coalesce: ['{{params.max_output_tokens}}', '{{params.max_tokens}}'] } },
      },
      response: { text: '$.candidates[0].content.parts[0].text', usage: '$.usageMetadata', errorMessage: ['$.error.message', '$.message'] },
    },
    'generate-content-image': {
      method: 'POST', path: '/v1beta/models/{model}:generateContent', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      derive: { aspectRatio: geminiImageRatio(), imageSize: geminiImageSize() },
      bodyTemplate: {
        contents: [{ role: 'user', parts: [{ text: '{{prompt}}' }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '{{derived.aspectRatio}}', imageSize: '{{derived.imageSize}}' } },
      },
      response: geminiGenerateContentResponse,
    },
    'edit-content-image': {
      method: 'POST', path: '/v1beta/models/{model}:generateContent', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      derive: { aspectRatio: geminiImageRatio(), imageSize: geminiImageSize() },
      bodyTemplate: {
        contents: [{ role: 'user', parts: { $concat: [
          [{ text: '{{prompt}}' }],
          { $map: { from: '{{inputs.images}}', template: { inlineData: { mimeType: '{{item.mime}}', data: { $dataUrlBase64: '{{item.dataUrl}}' } } } } },
        ] } }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '{{derived.aspectRatio}}', imageSize: '{{derived.imageSize}}' } },
      },
      response: geminiGenerateContentResponse,
    },
  },
  workflows: {
    chat: { submit: 'llm-chat', result: { kind: 'text', source: 'response' } },
    vision: { submit: 'llm-vision', result: { kind: 'text', source: 'response' } },
    tools: { submit: 'llm-tools', result: { kind: 'text', source: 'response', mime: 'application/json; charset=utf-8' } },
    structured: { submit: 'llm-structured', result: { kind: 'text', source: 'response', mime: 'application/json; charset=utf-8' } },
    'generate-content': { submit: 'generate-content-image', result: { kind: 'image', source: 'resultUrl' } },
    'edit-content': { submit: 'edit-content-image', result: { kind: 'image', source: 'resultUrl' } },
  },
  modelProfiles: {
    'gemini-3.1-flash-image': {
      label: 'Gemini 3.1 Flash Image', match: ['gemini-3.1-flash-image'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate-content', 'image.edit': 'edit-content' }, uiSchemas: ['gemini-image'],
      assets: { images: { mode: 'data_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] } },
      defaults: { resolution: '1K', mime_type: 'image/png' },
      limits: { references: { images: { max: 14 } }, output: { count: { min: 1, max: 1 } } },
    },
    'gemini-content-image': {
      label: 'Gemini Image (generateContent)', match: ['gemini-2.0-flash-preview-image', 'gemini-2.5-flash-image', 'gemini-3-pro-image'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate-content', 'image.edit': 'edit-content' }, uiSchemas: ['gemini-image'],
      assets: { images: { mode: 'data_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] } },
      defaults: { resolution: '1K' },
      limits: { references: { images: { max: 14 } }, output: { count: { min: 1, max: 1 } } },
    },
    'gemini-language': {
      label: 'Gemini Language', match: ['gemini-'], capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools', 'llm.structured_output'],
      workflows: { 'llm.chat': 'chat', 'llm.chat.vision': 'vision', 'llm.tools': 'tools', 'llm.structured_output': 'structured' }, uiSchemas: ['gemini-language'],
      assets: { images: { mode: 'data_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] } }, defaults: { temperature: 0.7, top_p: 0.95, max_output_tokens: 8192 },
    },
  },
  uiSchemas: {
    'gemini-language': [
      { key: 'temperature', label: '温度', type: 'slider', default: 0.7, min: 0, max: 2, step: 0.1 },
      { key: 'top_p', label: 'Top P', type: 'slider', default: 0.95, min: 0, max: 1, step: 0.05 },
      { key: 'max_output_tokens', label: '最大输出', type: 'number', default: 8192, min: 1, max: 131072 },
    ],
    'gemini-image': [
      { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '1K', options: ['1K', '2K', '4K'].map((value) => ({ label: value, value })) },
    ],
  },
}

/** Gemini-compatible aggregate sites using the Google request/response shape with Bearer auth. */
const geminiGeneralProtocol = {
  ...geminiProtocol,
  id: 'gemini-general',
  label: 'Gemini 通用协议',
  summary: '第三方聚合站 Gemini 通用协议：使用 generateContent 请求体，但由外层 Bearer provider 负责认证。',
}

const zkkiImagesProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'zkki-images', label: 'ZKKI 图片与视频',
  summary: 'ZKKI 统一图片接口，以及 input.media 视频提交、轮询和鉴权下载协议。',
  executor: { type: 'declarative', engine: '>=1.0.0' }, capabilities: [
    'image.generate', 'image.edit', 'video.generate', 'video.text_to_video', 'video.image_to_video',
    'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal',
  ],
  operations: {
    generate: {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json', Prefer: 'respond-async' },
      derive: { size: { op: 'lookup', value: ref('params.size'), cases: { auto: 'auto', '1K': '1K', '1.5K': '1.5K', '2K': '2K', '4K': '4K' }, fallback: '2K' } },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', size: '{{derived.size}}', aspect_ratio: '{{params.aspect_ratio}}', quality: '{{params.quality}}', response_format: 'url' },
      response: { taskId: ['$.id', '$.task_id', '$.data.id', '$.data.task_id'], status: ['$.status', '$.data.status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url'], resultData: '$.data[*].b64_json',
        resultMimeTypes: '$.data[*].mime_type', errorMessage: ['$.error.message', '$.message'] },
    },
    edit: {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json', Prefer: 'respond-async' },
      derive: { size: { op: 'lookup', value: ref('params.size'), cases: { auto: 'auto', '1K': '1K', '1.5K': '1.5K', '2K': '2K', '4K': '4K' }, fallback: '2K' } },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', image: '{{inputs.images[*].dataUrl}}', n: '{{params.n}}', size: '{{derived.size}}', aspect_ratio: '{{params.aspect_ratio}}', quality: '{{params.quality}}', response_format: 'url' },
      response: { taskId: ['$.id', '$.task_id', '$.data.id', '$.data.task_id'], status: ['$.status', '$.data.status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url'], resultData: '$.data[*].b64_json',
        resultMimeTypes: '$.data[*].mime_type', errorMessage: ['$.error.message', '$.message'] },
    },
    'generate-pixel-1k': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', headersTemplate: { 'Content-Type': 'application/json', Prefer: 'respond-async' },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: 1, size: '1K', aspect_ratio: '{{params.aspect_ratio}}', response_format: 'url' },
      response: { taskId: ['$.id', '$.task_id', '$.data.id', '$.data.task_id'], status: ['$.status', '$.data.status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url'], resultData: '$.data[*].b64_json', errorMessage: ['$.error.message', '$.message'] },
    },
    'edit-pixel-1k': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', headersTemplate: { 'Content-Type': 'application/json', Prefer: 'respond-async' },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', image: '{{inputs.images[*].dataUrl}}', n: 1, size: '1K', aspect_ratio: '{{params.aspect_ratio}}', response_format: 'url' },
      response: { taskId: ['$.id', '$.task_id', '$.data.id', '$.data.task_id'], status: ['$.status', '$.data.status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url'], resultData: '$.data[*].b64_json', errorMessage: ['$.error.message', '$.message'] },
    },
    'gemini-generate': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json', Prefer: 'respond-async' },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', aspect_ratio: '{{params.aspect_ratio}}', quality: '{{params.resolution}}', response_format: 'b64_json' },
      response: { taskId: ['$.id', '$.task_id', '$.data.id', '$.data.task_id'], status: ['$.status', '$.data.status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url'], resultData: '$.data[*].b64_json',
        resultMimeTypes: '$.data[*].mime_type', errorMessage: ['$.error.message', '$.message'] },
    },
    'gemini-edit': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json', Prefer: 'respond-async' },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', image: '{{inputs.images[*].dataUrl}}', n: '{{params.n}}', aspect_ratio: '{{params.aspect_ratio}}', quality: '{{params.resolution}}', response_format: 'b64_json' },
      response: { taskId: ['$.id', '$.task_id', '$.data.id', '$.data.task_id'], status: ['$.status', '$.data.status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url'], resultData: '$.data[*].b64_json',
        resultMimeTypes: '$.data[*].mime_type', errorMessage: ['$.error.message', '$.message'] },
    },
    'image-query': {
      method: 'GET', path: '/v1/images/generations/{taskId}', requestMode: 'json',
      response: { taskId: ['$.id', '$.task_id', '$.data.id', '$.data.task_id'], status: ['$.status', '$.data.status'],
        progress: ['$.progress', '$.data.progress'], resultUrls: ['$.data[*].url', '$.data[*].image_url'],
        resultData: '$.data[*].b64_json', resultMimeTypes: '$.data[*].mime_type',
        errorCode: ['$.error.code', '$.data.error.code', '$.code'], errorMessage: ['$.error.message', '$.data.error.message', '$.message'] },
    },
    'video-submit': {
      method: 'POST', path: '/v1/videos', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}',
        input: {
          prompt: '{{prompt}}',
          media: { $concat: [
            { $map: { from: '{{inputs.images}}', template: { type: 'reference_image', url: '{{item.url}}' } } },
            { $map: { from: '{{inputs.videos}}', template: { type: 'reference_video', url: '{{item.url}}' } } },
            { $map: { from: '{{inputs.audios}}', template: { type: 'reference_audio', url: '{{item.url}}' } } },
          ] },
        },
        parameters: {
          duration: '{{params.duration}}', ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}',
          generate_audio: '{{params.generate_audio}}', watermark: '{{params.watermark}}',
        },
      },
      response: {
        taskId: ['$.id', '$.task_id', '$.data.id', '$.data.task_id'], status: ['$.status', '$.data.status'],
        errorCode: ['$.error.code', '$.code'], errorMessage: ['$.error.message', '$.message'],
      },
    },
    'video-query': {
      method: 'GET', path: '/v1/videos/{taskId}', requestMode: 'json',
      response: {
        status: ['$.status', '$.data.status'], progress: ['$.progress', '$.data.progress'],
        errorCode: ['$.error.code', '$.data.error.code', '$.code'], errorMessage: ['$.error.message', '$.data.error.message', '$.message'],
      },
    },
    'video-download': { method: 'GET', path: '/v1/videos/{taskId}/content', responseMode: 'binary' },
  },
  workflows: {
    generate: { submit: 'generate', poll: { operation: 'image-query', intervalMs: 3000, backoff: 1.15, maxIntervalMs: 5000, maxDurationMs: 900000,
      status: { pending: ['queued', 'pending', 'processing', 'in_progress', 'running'], success: ['completed'], failure: ['failed', 'cancelled', 'canceled', 'expired'] } }, result: { kind: 'image', source: 'resultUrl', mime: 'image/png' } },
    edit: { submit: 'edit', poll: { operation: 'image-query', intervalMs: 3000, backoff: 1.15, maxIntervalMs: 5000, maxDurationMs: 900000,
      status: { pending: ['queued', 'pending', 'processing', 'in_progress', 'running'], success: ['completed'], failure: ['failed', 'cancelled', 'canceled', 'expired'] } }, result: { kind: 'image', source: 'resultUrl', mime: 'image/png' } },
    'generate-pixel-1k': { submit: 'generate-pixel-1k', poll: { operation: 'image-query', intervalMs: 3000, backoff: 1.15, maxIntervalMs: 5000, maxDurationMs: 900000,
      status: { pending: ['queued', 'pending', 'processing', 'in_progress', 'running'], success: ['completed'], failure: ['failed', 'cancelled', 'canceled', 'expired'] } }, result: { kind: 'image', source: 'resultUrl', mime: 'image/png' } },
    'edit-pixel-1k': { submit: 'edit-pixel-1k', poll: { operation: 'image-query', intervalMs: 3000, backoff: 1.15, maxIntervalMs: 5000, maxDurationMs: 900000,
      status: { pending: ['queued', 'pending', 'processing', 'in_progress', 'running'], success: ['completed'], failure: ['failed', 'cancelled', 'canceled', 'expired'] } }, result: { kind: 'image', source: 'resultUrl', mime: 'image/png' } },
    'gemini-generate': { submit: 'gemini-generate', poll: { operation: 'image-query', intervalMs: 3000, backoff: 1.15, maxIntervalMs: 5000, maxDurationMs: 900000,
      status: { pending: ['queued', 'pending', 'processing', 'in_progress', 'running'], success: ['completed'], failure: ['failed', 'cancelled', 'canceled', 'expired'] } }, result: { kind: 'image', source: 'resultUrl', mime: 'image/png' } },
    'gemini-edit': { submit: 'gemini-edit', poll: { operation: 'image-query', intervalMs: 3000, backoff: 1.15, maxIntervalMs: 5000, maxDurationMs: 900000,
      status: { pending: ['queued', 'pending', 'processing', 'in_progress', 'running'], success: ['completed'], failure: ['failed', 'cancelled', 'canceled', 'expired'] } }, result: { kind: 'image', source: 'resultUrl', mime: 'image/png' } },
    video: {
      submit: 'video-submit',
      poll: {
        operation: 'video-query', intervalMs: 5000, backoff: 1.2, maxIntervalMs: 10000, maxDurationMs: 600000,
        status: {
          pending: ['queued', 'pending', 'processing', 'in_progress', 'running'],
          success: ['completed'], failure: ['failed', 'cancelled', 'canceled', 'expired'],
        },
      },
      download: 'video-download', result: { kind: 'video', source: 'binary', mime: 'video/mp4' },
    },
  },
  modelProfiles: {
    'gpt-image-2-1k': {
      label: 'ZKKI GPT Image 1K', match: ['gpt-image-2-1k', 'gpt-image-2.5-1k', 'gpt-image-2.5-flare-1k', 'gpt-image-2.5-sunburst-1k'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate-pixel-1k', 'image.edit': 'edit-pixel-1k' }, uiSchemas: ['zkki-image-1k'],
      assets: { images: { mode: 'data_url', maxBytes: 52_428_800, mimeTypes: ['image/*'] } },
      defaults: { aspect_ratio: '1:1' }, limits: { references: { images: { max: 9 } }, output: { count: { min: 1, max: 1 } } },
    },
    'gpt-image': {
      label: 'ZKKI GPT Image', match: ['gpt-image-'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate', 'image.edit': 'edit' }, uiSchemas: ['zkki-image'],
      assets: { images: { mode: 'data_url', maxBytes: 52_428_800, mimeTypes: ['image/*'] } },
      defaults: { size: '2K' }, limits: { references: { images: { max: 9 } }, output: { count: { min: 1, max: 128 } } },
    },
    seedream: {
      label: 'ZKKI Seedream', match: ['dola-seedream', 'doubao-seedream', 'seedream'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate', 'image.edit': 'edit' }, uiSchemas: ['zkki-image'],
      assets: { images: { mode: 'data_url', maxBytes: 52_428_800, mimeTypes: ['image/*'] } },
      defaults: { size: '2K' }, limits: { references: { images: { max: 9 } }, output: { count: { min: 1, max: 128 } } },
    },
    'gemini-image': {
      label: 'ZKKI Gemini Image', match: ['gemini-2.5-flash-image', 'gemini-3-pro-image', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-3.1-flash-lite-image'],
      capabilities: ['image.generate', 'image.edit'], workflows: { 'image.generate': 'gemini-generate', 'image.edit': 'gemini-edit' },
      uiSchemas: ['zkki-gemini-image'], assets: { images: { mode: 'data_url', maxBytes: 52_428_800, mimeTypes: ['image/*'] } },
      defaults: { resolution: '1K', aspect_ratio: '1:1' }, limits: { references: { images: { max: 9 } }, output: { count: { min: 1, max: 1 } } },
    },
    'seedance-2.0-fast-max': {
      label: 'ZKKI Seedance 2.0 Fast MAX', match: ['dreamina-seedance-2-0-fast-260128-max'],
      capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'video', 'video.text_to_video': 'video', 'video.image_to_video': 'video', 'video.multi_reference': 'video', 'video.video_to_video': 'video', 'video.audio_reference': 'video', 'video.multimodal': 'video' },
      uiSchemas: ['zkki-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
      limits: { duration: { min: 4, max: 15, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p'], default: '720p' }, aspect_ratio: { options: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], default: '16:9' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
    },
    'seedance-2.0-mini-max': {
      label: 'ZKKI Seedance 2.0 Mini MAX', match: ['dreamina-seedance-2-0-mini-260615-max'],
      capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'video', 'video.text_to_video': 'video', 'video.image_to_video': 'video', 'video.multi_reference': 'video', 'video.video_to_video': 'video', 'video.audio_reference': 'video', 'video.multimodal': 'video' },
      uiSchemas: ['zkki-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
      limits: { duration: { min: 4, max: 15, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p'], default: '720p' }, aspect_ratio: { options: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'], default: '16:9' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
    },
    'seedance-2.0-mini-hc': {
      label: 'ZKKI Seedance 2.0 Mini HC', match: ['dreamina-seedance-2-0-mini-hc', 'seedance2.0mini'],
      capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'video', 'video.text_to_video': 'video', 'video.image_to_video': 'video', 'video.multi_reference': 'video', 'video.video_to_video': 'video', 'video.audio_reference': 'video', 'video.multimodal': 'video' },
      uiSchemas: ['zkki-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
      limits: { duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p'], default: '720p' }, aspect_ratio: { options: ['1:1', '16:9', '9:16'], default: '16:9' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
    },
    'documented-video-models': {
      label: 'ZKKI 官方视频模型', match: [
        'dreamina-seedance-2-0-fast-hc', 'dreamina-seedance-2-0-hc', 'minimax-h3-max-d', 'minimax-h3-768p-k', 'minimax-h3-c1-k',
        'sd-2-c4', 'sd-2-c5', 'sd-2-c8', 'seedance-2-900-xg', 'seedance-2.0-mini-xg', 'seedance-2.0:i2v-xg',
        'seedance2.0-933-xg', 'seedance2.0-mini-xg', 'videos_900_720p-k', 'wan-3.0', 'seedance-2.0-903x-xg',
        'seedance-2.5-xg', 'sd-2.5-video-k', 'sd_2.5_special_v1-k', 'sd-2-0-v3', 'sd-2-5-v3',
      ],
      capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'video', 'video.text_to_video': 'video', 'video.image_to_video': 'video', 'video.multi_reference': 'video', 'video.video_to_video': 'video', 'video.audio_reference': 'video', 'video.multimodal': 'video' },
      uiSchemas: ['zkki-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: false, watermark: false },
      limits: { duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, references: { images: { max: 30 }, videos: { max: 10 }, audios: { max: 10 } } },
    },
    'seedance-2.0': {
      label: 'ZKKI Seedance 2.0', match: ['dreamina-seedance-2-0', 'seedance2.0'],
      capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'video', 'video.text_to_video': 'video', 'video.image_to_video': 'video', 'video.multi_reference': 'video', 'video.video_to_video': 'video', 'video.audio_reference': 'video', 'video.multimodal': 'video' },
      uiSchemas: ['zkki-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
      limits: { duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p', '1080p', '4k'], default: '720p' }, aspect_ratio: { options: ['1:1', '16:9', '9:16'], default: '16:9' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
    },
    'seedance-2.5': {
      label: 'ZKKI Seedance 2.5', match: ['dreamina-seedance-2-5', 'seedance-2.5', 'seedance2.5'],
      capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'video', 'video.text_to_video': 'video', 'video.image_to_video': 'video', 'video.multi_reference': 'video', 'video.video_to_video': 'video', 'video.audio_reference': 'video', 'video.multimodal': 'video' },
      uiSchemas: ['zkki-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
      limits: { duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p', '1080p', '2k', '4k', 'native1080p'], default: '720p' }, aspect_ratio: { options: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'], default: '16:9' }, references: { images: { max: 30 }, videos: { max: 10 }, audios: { max: 10 } } },
    },
    'seedance-alias': {
      label: 'ZKKI Seedance Alias', match: ['sd-2-', 'sd_2.', 'seedance2.5'],
      capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'video', 'video.text_to_video': 'video', 'video.image_to_video': 'video', 'video.multi_reference': 'video', 'video.video_to_video': 'video', 'video.audio_reference': 'video', 'video.multimodal': 'video' },
      uiSchemas: ['zkki-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
      limits: { duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, references: { images: { max: 30 }, videos: { max: 10 }, audios: { max: 10 } } },
    },
    'global-multi': {
      label: 'ZKKI Global 多模态', match: ['global-standard-multi'],
      capabilities: ['video.generate', 'video.image_to_video', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'video', 'video.image_to_video': 'video', 'video.multi_reference': 'video', 'video.video_to_video': 'video', 'video.audio_reference': 'video', 'video.multimodal': 'video' },
      uiSchemas: ['zkki-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
    },
    'text-to-video': {
      label: 'ZKKI 纯文生视频', match: ['global-standard-t2v'], capabilities: ['video.generate', 'video.text_to_video'],
      workflows: { 'video.generate': 'video', 'video.text_to_video': 'video' }, uiSchemas: ['zkki-video'],
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
      limits: { duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, references: { images: { max: 0 }, videos: { max: 0 }, audios: { max: 0 } } },
    },
    'minimax-h3': {
      label: 'ZKKI MiniMax H3', match: ['minimax-h3-d'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference'],
      workflows: { 'video.generate': 'video', 'video.text_to_video': 'video', 'video.image_to_video': 'video', 'video.multi_reference': 'video' },
      uiSchemas: ['zkki-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] } },
      defaults: { duration: 5, aspect_ratio: 'adaptive', resolution: '768P', generate_audio: false, watermark: false },
      limits: { duration: { min: 4, max: 15, step: 1, integer: true, default: 5 }, resolution: { options: ['2K', '768P'], default: '768P' }, aspect_ratio: { options: ['adaptive', '16:9', '9:16', '1:1'], default: 'adaptive' }, references: { images: { max: 9 }, videos: { max: 0 }, audios: { max: 0 } } },
    },
    omni: {
      label: 'ZKKI Omni', match: ['omni', 'omni-fast'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference'],
      workflows: { 'video.generate': 'video', 'video.text_to_video': 'video', 'video.image_to_video': 'video', 'video.multi_reference': 'video' },
      uiSchemas: ['zkki-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
    },
  },
  uiSchemas: {
    'zkki-image': [{ key: 'size', label: '图片尺寸', type: 'select', default: '2K', options: ['auto', '1K', '1.5K', '2K'].map((value) => ({ label: value, value })) }],
    'zkki-image-1k': [{ key: 'aspect_ratio', label: '图片比例', type: 'select', default: '1:1', options: ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21'].map((value) => ({ label: value, value })) }],
    'zkki-gemini-image': [
      { key: 'aspect_ratio', label: '图片比例', type: 'select', default: '1:1', options: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '图片清晰度', type: 'select', default: '1K', options: ['1K', '2K', '4K'].map((value) => ({ label: value, value })) },
    ],
    'zkki-video': [
      { key: 'duration', label: '时长', type: 'number', default: 5, min: 4, max: 30, step: 1 },
      { key: 'aspect_ratio', label: '画面比例', type: 'select', default: '16:9', options: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '720p', options: ['480p', '720p', '1080p', '2k', '4k', 'native1080p', '768P', '2K'].map((value) => ({ label: value, value })) },
      { key: 'generate_audio', label: '生成音频', type: 'toggle', default: true },
      { key: 'watermark', label: '水印', type: 'toggle', default: false },
    ],
  },
}

const agtokenVideosProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'agtoken-videos', label: 'AGToken 视频',
  summary: 'AGToken 普通统一接口、Seedance Content 和 Wan DashScope 三类异步视频工作流。',
  executor: { type: 'declarative', engine: '>=1.0.0' },
  capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
  operations: {
    'unified-submit': {
      method: 'POST', path: '/v1/video/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: { resolution: { op: 'lower', value: ref('params.resolution') } },
      bodyTemplate: { $merge: [
        {
          model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', size: '{{params.aspect_ratio}}',
          metadata: { resolution: '{{derived.resolution}}', ratio: '{{params.aspect_ratio}}', generate_audio: '{{params.generate_audio}}', watermark: '{{params.watermark}}' },
        },
        { $cardinality: { from: '{{inputs.images[*].url}}', zero: {}, one: { image: '{{item}}' }, many: { images: '{{items}}' } } },
      ] },
      response: { taskId: ['$.task_id', '$.data.task_id'], status: ['$.status', '$.data.status'], resultUrl: ['$.result_url', '$.data.result_url'], errorMessage: ['$.message', '$.error.message', '$.data.message', '$.data.result_url'] },
    },
    'unified-query': {
      method: 'GET', path: '/v1/video/generations/{taskId}', requestMode: 'json', retry: agtokenQueryRetry,
      response: { taskId: ['$.task_id', '$.data.task_id'], status: ['$.status', '$.data.status'], resultUrl: ['$.result_url', '$.data.result_url'], errorCode: ['$.code', '$.error.code'], errorMessage: ['$.message', '$.error.message', '$.data.message', '$.data.result_url'] },
    },
    'seedance-submit': {
      method: 'POST', path: '/api/v3/contents/generations/tasks', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: { resolution: { op: 'lower', value: ref('params.resolution') } },
      bodyTemplate: { $merge: [
        {
          model: '{{model}}',
          content: { $concat: [
            [{ type: 'text', text: '{{prompt}}' }],
            { $map: { from: '{{inputs.images}}', template: { type: 'image_url', image_url: { url: '{{item.url}}' }, role: { $coalesce: ['{{item.role}}', 'reference_image'] } } } },
            { $map: { from: '{{inputs.videos}}', template: { type: 'video_url', video_url: { url: '{{item.url}}' }, role: { $coalesce: ['{{item.role}}', 'reference_video'] } } } },
            { $map: { from: '{{inputs.audios}}', template: { type: 'audio_url', audio_url: { url: '{{item.url}}' }, role: { $coalesce: ['{{item.role}}', 'reference_audio'] } } } },
          ] },
          resolution: '{{derived.resolution}}', ratio: '{{params.aspect_ratio}}', duration: '{{params.duration}}',
          generate_audio: '{{params.generate_audio}}', watermark: '{{params.watermark}}', seed: '{{params.seed}}', return_last_frame: '{{params.return_last_frame}}',
        },
        { $cardinality: {
          from: { $concat: ['{{inputs.videos[*].url}}', '{{inputs.audios[*].url}}'] }, zero: {},
          one: { omni_reference_task_type: '{{params.omni_reference_task_type}}' }, many: { omni_reference_task_type: '{{params.omni_reference_task_type}}' },
        } },
      ] },
      response: { taskId: ['$.id', '$.task_id'], status: ['$.status', '$.task_status'], resultUrl: ['$.content.video_url', '$.video_url'], errorMessage: ['$.message', '$.error.message'] },
    },
    'seedance-query': {
      method: 'GET', path: '/api/v3/contents/generations/tasks/{taskId}', requestMode: 'json', retry: agtokenQueryRetry,
      response: { taskId: ['$.id', '$.task_id'], status: ['$.status', '$.task_status'], resultUrl: ['$.content.video_url', '$.video_url'], errorCode: ['$.code', '$.error.code'], errorMessage: ['$.message', '$.error.message', '$.content.video_url'] },
    },
    'wan-submit': {
      method: 'POST', path: '/api/v1/services/aigc/video-generation/video-synthesis', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
      derive: { resolution: { op: 'upper', value: ref('params.resolution') } },
      bodyTemplate: {
        model: '{{model}}',
        input: {
          prompt: '{{prompt}}', media: { $concat: [
            { $map: { from: '{{inputs.images}}', template: { type: { $coalesce: ['{{item.role}}', 'reference_image'] }, url: '{{item.url}}' } } },
            { $map: { from: '{{inputs.videos}}', template: { type: { $coalesce: ['{{item.role}}', 'reference_video'] }, url: '{{item.url}}' } } },
            { $map: { from: '{{inputs.audios}}', template: { type: { $coalesce: ['{{item.role}}', 'reference_audio'] }, url: '{{item.url}}' } } },
          ] },
        },
        parameters: { resolution: '{{derived.resolution}}', ratio: '{{params.aspect_ratio}}', duration: '{{params.duration}}', audio: '{{params.generate_audio}}', seed: '{{params.seed}}', watermark: '{{params.watermark}}' },
      },
      response: { taskId: ['$.output.task_id', '$.task_id'], status: ['$.output.task_status', '$.task_status'], resultUrl: ['$.output.video_url', '$.video_url'], errorMessage: ['$.message', '$.output.message', '$.error.message'] },
    },
    'wan-query': {
      method: 'GET', path: '/api/v1/tasks/{taskId}', requestMode: 'json', retry: agtokenQueryRetry,
      response: { taskId: ['$.output.task_id', '$.task_id'], status: ['$.output.task_status', '$.task_status'], resultUrl: ['$.output.video_url', '$.video_url'], errorCode: ['$.code', '$.error.code'], errorMessage: ['$.message', '$.output.message', '$.error.message', '$.output.video_url'] },
    },
  },
  workflows: {
    unified: { submit: 'unified-submit', poll: { operation: 'unified-query', intervalMs: 5000, backoff: 1.4, maxIntervalMs: 30000, maxDurationMs: 600000, status: agtokenPollStatus }, result: { kind: 'video', source: 'resultUrl' } },
    seedance: { submit: 'seedance-submit', poll: { operation: 'seedance-query', intervalMs: 5000, backoff: 1.4, maxIntervalMs: 30000, maxDurationMs: 600000, status: agtokenPollStatus }, result: { kind: 'video', source: 'resultUrl' } },
    wan: { submit: 'wan-submit', poll: { operation: 'wan-query', intervalMs: 5000, backoff: 1.4, maxIntervalMs: 30000, maxDurationMs: 600000, status: agtokenPollStatus }, result: { kind: 'video', source: 'resultUrl' } },
  },
  modelProfiles: {
    'seedance-2.0': {
      label: 'AGToken Seedance 2.0', match: ['doubao-seedance-2-0', 'doubao-seedance-2.0'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'], workflows: agtokenSeedanceWorkflows,
      uiSchemas: ['agtoken-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } }, defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
    },
    'seedance-2.5': {
      label: 'AGToken Seedance 2.5', match: ['doubao-seedance-2-5', 'doubao-seedance-2.5'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'], workflows: agtokenSeedanceWorkflows,
      uiSchemas: ['agtoken-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } }, defaults: { duration: 5, aspect_ratio: 'adaptive', resolution: '720p', generate_audio: true, watermark: false, omni_reference_task_type: 'reference' },
    },
    'wan-3.0': {
      label: 'AGToken Wan 3.0', match: ['wan3.0-video'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'], workflows: agtokenWanWorkflows,
      uiSchemas: ['agtoken-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } }, defaults: { duration: 5, aspect_ratio: 'adaptive', resolution: '1080p', generate_audio: true, watermark: false },
    },
    general: {
      label: 'AGToken 统一视频', match: [''], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.multi_reference'], workflows: agtokenVideoWorkflows,
      uiSchemas: ['agtoken-video'], assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] } }, defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
    },
  },
  uiSchemas: {
    'agtoken-video': [
      { key: 'duration', label: '时长', type: 'number', default: 5, min: -1, max: 30, step: 1 },
      { key: 'aspect_ratio', label: '比例', type: 'select', default: 'adaptive', options: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '720p', options: ['480p', '720p', '1080p', '4k'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'generate_audio', label: '生成音频', type: 'toggle', default: true },
      { key: 'watermark', label: '水印', type: 'toggle', default: false },
    ],
  },
}

const apimartImagesProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'apimart-images', label: 'APIMart 图片、视频与语音',
  summary: 'APIMart GPT Image、Seedance、VEO 与官方 TTS 的声明式协议。',
  executor: { type: 'declarative', engine: '>=1.0.0' }, capabilities: ['image.generate', 'image.edit', 'video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal', 'audio.tts'],
  operations: {
    generate: {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: {
        size: apimartImageRatio(),
        resolution: { op: 'lookup', value: { op: 'coalesce', values: [ref('params.resolution'), literal('1k')] }, cases: { '1K': '1k', '1k': '1k', '2K': '2k', '2k': '2k', '4K': '4k', '4k': '4k' }, fallback: '1k' },
      },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', size: '{{derived.size}}', resolution: '{{derived.resolution}}', quality: '{{params.quality}}', output_format: '{{params.output_format}}', output_compression: '{{params.output_compression}}', background: '{{params.background}}', moderation: '{{params.moderation}}', official_fallback: '{{params.official_fallback}}', nsfw_check: '{{params.nsfw_check}}', webhook: '{{params.webhook}}' },
      response: {
        taskId: apimartTaskIdSelectors, status: ['$.data.status', '$.data[*].status', '$.status', '$.task_status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url', '$.data.result.images[*].url[*]', '$.data.result.images[*].url', '$.result.images[*].url[*]', '$.result.images[*].url', '$.output.images[*].url[*]', '$.output.images[*].url'], errorMessage: ['$.data.error.message', '$.data[*].error.message', '$.error.message', '$.message'],
      },
    },
    edit: {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: {
        size: apimartImageRatio(),
        resolution: { op: 'lookup', value: { op: 'coalesce', values: [ref('params.resolution'), literal('1k')] }, cases: { '1K': '1k', '1k': '1k', '2K': '2k', '2k': '2k', '4K': '4k', '4k': '4k' }, fallback: '1k' },
      },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', size: '{{derived.size}}', resolution: '{{derived.resolution}}', quality: '{{params.quality}}', output_format: '{{params.output_format}}', output_compression: '{{params.output_compression}}', background: '{{params.background}}', moderation: '{{params.moderation}}', official_fallback: '{{params.official_fallback}}', image_urls: '{{inputs.images[*].url}}', nsfw_check: '{{params.nsfw_check}}', webhook: '{{params.webhook}}' },
      response: {
        taskId: apimartTaskIdSelectors, status: ['$.data.status', '$.data[*].status', '$.status', '$.task_status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url', '$.data.result.images[*].url[*]', '$.data.result.images[*].url', '$.result.images[*].url[*]', '$.result.images[*].url', '$.output.images[*].url[*]', '$.output.images[*].url'], errorMessage: ['$.data.error.message', '$.data[*].error.message', '$.error.message', '$.message'],
      },
    },
    'gemini-generate': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: {
        size: apimartImageRatio(),
        resolution: { op: 'upper', value: { op: 'coalesce', values: [ref('params.resolution'), ref('params.imageSize'), literal('1K')] } },
      },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', size: '{{derived.size}}', resolution: '{{derived.resolution}}', nsfw_check: '{{params.nsfw_check}}', official_fallback: '{{params.official_fallback}}', google_search: '{{params.google_search}}', google_image_search: '{{params.google_image_search}}', webhook: '{{params.webhook}}' },
      response: {
        taskId: apimartTaskIdSelectors, status: ['$.data.status', '$.data[*].status', '$.status', '$.task_status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url', '$.data.result.images[*].url[*]', '$.data.result.images[*].url'], errorMessage: ['$.data.error.message', '$.data[*].error.message', '$.error.message', '$.message'],
      },
    },
    'gemini-edit': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: {
        size: apimartImageRatio(),
        resolution: { op: 'upper', value: { op: 'coalesce', values: [ref('params.resolution'), ref('params.imageSize'), literal('1K')] } },
      },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', size: '{{derived.size}}', resolution: '{{derived.resolution}}', image_urls: '{{inputs.images[*].url}}', nsfw_check: '{{params.nsfw_check}}', official_fallback: '{{params.official_fallback}}', google_search: '{{params.google_search}}', google_image_search: '{{params.google_image_search}}', webhook: '{{params.webhook}}' },
      response: {
        taskId: apimartTaskIdSelectors, status: ['$.data.status', '$.data[*].status', '$.status', '$.task_status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url', '$.data.result.images[*].url[*]', '$.data.result.images[*].url'], errorMessage: ['$.data.error.message', '$.data[*].error.message', '$.error.message', '$.message'],
      },
    },
    'gemini-lite-generate': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: { size: apimartImageRatio() },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', size: '{{derived.size}}', resolution: '1K', nsfw_check: '{{params.nsfw_check}}', webhook: '{{params.webhook}}' },
      response: {
        taskId: apimartTaskIdSelectors, status: ['$.data.status', '$.data[*].status', '$.status', '$.task_status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url', '$.data.result.images[*].url[*]', '$.data.result.images[*].url'], errorMessage: ['$.data.error.message', '$.data[*].error.message', '$.error.message', '$.message'],
      },
    },
    'gemini-lite-edit': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: { size: apimartImageRatio() },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', size: '{{derived.size}}', resolution: '1K', image_urls: '{{inputs.images[*].url}}', nsfw_check: '{{params.nsfw_check}}', webhook: '{{params.webhook}}' },
      response: {
        taskId: apimartTaskIdSelectors, status: ['$.data.status', '$.data[*].status', '$.status', '$.task_status'],
        resultUrls: ['$.data[*].url', '$.data[*].image_url', '$.data.result.images[*].url[*]', '$.data.result.images[*].url'], errorMessage: ['$.data.error.message', '$.data[*].error.message', '$.error.message', '$.message'],
      },
    },
    'image-query': {
      method: 'GET', path: '/v1/tasks/{taskId}', requestMode: 'json',
      response: {
        status: ['$.data.status', '$.data[*].status', '$.status', '$.task_status'], progress: ['$.data.progress', '$.data[*].progress', '$.progress'],
        resultUrls: ['$.data.result.images[*].url[*]', '$.data.result.images[*].url', '$.data[*].url', '$.data[*].image_url', '$.result.images[*].url[*]', '$.result.images[*].url', '$.output.images[*].url[*]', '$.output.images[*].url'],
        errorCode: ['$.data.error.code', '$.error.code'], errorMessage: ['$.data.error.message', '$.data.fail_reason', '$.error.message', '$.message'],
      },
    },
    // 文档只有 POST /v1/uploads/images（multipart 字段 file）；/v1/uploads/videos|audios|files 不存在。
    // 音视频参考素材只能给公网 URL 或 asset://，所以这里不再声明假的 upload-video / upload-audio。
    'upload-image': {
      method: 'POST', path: '/v1/uploads/images', requestMode: 'multipart', bodyTemplate: { file: { $file: '{{inputs.images}}' } },
      response: { assetUrl: ['$.data.url', '$.url', '$.data.asset_url', '$.asset_url', '$.data.file_url', '$.file_url'] },
    },
    'audio-speech': {
      method: 'POST', path: '/v1/audio/speech', requestMode: 'json', responseMode: 'binary', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: { model: '{{model}}', input: '{{prompt}}', voice: '{{params.voice}}', response_format: '{{params.response_format}}', speed: '{{params.speed}}' },
    },
    'video-query': {
      method: 'GET', path: '/v1/tasks/{taskId}', requestMode: 'json', queryTemplate: { language: 'zh' },
      retry: { attempts: 3, delayMs: 500, backoff: 2, retryStatus: [429, 500, 502, 503, 504], retryNetwork: true },
      fallbacks: [{ path: '/tasks/{taskId}', onStatus: [404, 405] }],
      response: {
        status: ['$.status', '$.task_status', '$.data.status', '$.data.task_status', '$.data[0].status', '$.data[0].task_status'],
        progress: ['$.progress', '$.data.progress', '$.data[0].progress'],
        resultUrls: apimartVideoResultSelectors,
        errorCode: ['$.error.code', '$.data.error.code'], errorMessage: ['$.error.message', '$.message', '$.data.error.message', '$.data.fail_reason'],
      },
    },
    'seedance-submit': {
      method: 'POST', path: '/v1/videos/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: { duration: { op: 'clamp', value: ref('params.duration'), min: 4, max: 15 } },
      bodyTemplate: { $merge: [
        {
          prompt: '{{prompt}}', model: '{{model}}', duration: '{{derived.duration}}', size: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}',
          video_urls: '{{inputs.videos[*].url}}', audio_urls: '{{inputs.audios[*].url}}', generate_audio: '{{params.generate_audio}}', seed: '{{params.seed}}',
          return_last_frame: '{{params.return_last_frame}}', tools: '{{params.tools}}', nsfw_check: '{{params.nsfw_check}}',
        },
        { $cardinality: {
          from: '{{inputs.images[*].role}}',
          zero: { image_urls: '{{inputs.images[*].url}}' },
          one: { image_with_roles: { $map: { from: '{{inputs.images}}', template: { url: '{{item.url}}', role: { $coalesce: ['{{item.role}}', 'reference_image'] } } } } },
          many: { image_with_roles: { $map: { from: '{{inputs.images}}', template: { url: '{{item.url}}', role: { $coalesce: ['{{item.role}}', 'reference_image'] } } } } },
        } },
      ] },
      response: { taskId: apimartTaskIdSelectors, status: ['$.status', '$.task_status', '$.data.status'], resultUrls: ['$.video_url', '$.url', '$.data.video_url', '$.data.url'], errorMessage: ['$.error.message', '$.message'] },
    },
    'veo-lite-submit': {
      method: 'POST', path: '/v1/videos/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: {
        duration: { op: 'clamp', value: ref('params.duration'), min: 4, max: 8 },
        ratio: { op: 'lookup', value: ref('params.aspect_ratio'), cases: { '9:16': '9:16' }, fallback: '16:9' },
        resolutionRaw: { op: 'lower', value: ref('params.resolution') },
        resolution: { op: 'lookup', value: ref('derived.resolutionRaw'), cases: { '4k': '4k', '1080p': '1080p', '1080': '1080p' }, fallback: '720p' },
      },
      bodyTemplate: { prompt: '{{prompt}}', model: 'veo3.1-lite', duration: '{{derived.duration}}', aspect_ratio: '{{derived.ratio}}', resolution: '{{derived.resolution}}', generate_audio: '{{params.generate_audio}}' },
      response: { taskId: apimartTaskIdSelectors, status: ['$.status', '$.task_status', '$.data.status'], resultUrls: ['$.video_url', '$.url', '$.data.video_url', '$.data.url'], errorMessage: ['$.error.message', '$.message'] },
    },
    'veo-fast-submit': {
      method: 'POST', path: '/v1/videos/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: {
        duration: { op: 'clamp', value: ref('params.duration'), min: 4, max: 8 },
        ratio: { op: 'lookup', value: ref('params.aspect_ratio'), cases: { '9:16': '9:16' }, fallback: '16:9' },
        resolutionRaw: { op: 'lower', value: ref('params.resolution') },
        resolution: { op: 'lookup', value: ref('derived.resolutionRaw'), cases: { '4k': '4k', '1080p': '1080p', '1080': '1080p' }, fallback: '720p' },
      },
      bodyTemplate: { $merge: [
        { prompt: '{{prompt}}', model: 'veo3.1-fast', duration: '{{derived.duration}}', aspect_ratio: '{{derived.ratio}}', resolution: '{{derived.resolution}}', generate_audio: '{{params.generate_audio}}' },
        { $cardinality: {
          from: '{{inputs.images[*].url}}', zero: {}, one: { image_urls: '{{items}}' },
          two: { image_urls: '{{items}}', generation_type: 'frame' }, many: { image_urls: '{{items}}', generation_type: 'reference' },
        } },
      ] },
      response: { taskId: apimartTaskIdSelectors, status: ['$.status', '$.task_status', '$.data.status'], resultUrls: ['$.video_url', '$.url', '$.data.video_url', '$.data.url'], errorMessage: ['$.error.message', '$.message'] },
    },
    'veo-quality-submit': {
      method: 'POST', path: '/v1/videos/generations', requestMode: 'json', omitEmpty: true, headersTemplate: { 'Content-Type': 'application/json' },
      derive: {
        duration: { op: 'clamp', value: ref('params.duration'), min: 4, max: 8 },
        ratio: { op: 'lookup', value: ref('params.aspect_ratio'), cases: { '9:16': '9:16' }, fallback: '16:9' },
        resolutionRaw: { op: 'lower', value: ref('params.resolution') },
        resolution: { op: 'lookup', value: ref('derived.resolutionRaw'), cases: { '4k': '4k', '1080p': '1080p', '1080': '1080p' }, fallback: '720p' },
      },
      bodyTemplate: { $merge: [
        { prompt: '{{prompt}}', model: 'veo3.1-quality', duration: '{{derived.duration}}', aspect_ratio: '{{derived.ratio}}', resolution: '{{derived.resolution}}', generate_audio: '{{params.generate_audio}}' },
        { $cardinality: { from: '{{inputs.images[*].url}}', zero: {}, one: { image_urls: '{{items}}' }, two: { image_urls: '{{items}}', generation_type: 'frame' }, many: { image_urls: '{{items}}' } } },
      ] },
      response: { taskId: apimartTaskIdSelectors, status: ['$.status', '$.task_status', '$.data.status'], resultUrls: ['$.video_url', '$.url', '$.data.video_url', '$.data.url'], errorMessage: ['$.error.message', '$.message'] },
    },
  },
  workflows: {
    speech: { submit: 'audio-speech', result: { kind: 'audio', source: 'binary' } },
    generate: { uploads: [{ operation: 'upload-image', inputs: 'images', result: { source: 'assetUrl', target: 'url' } }], submit: 'generate', poll: imagePoll, result: { kind: 'image', source: 'resultUrl' } },
    edit: { uploads: [{ operation: 'upload-image', inputs: 'images', result: { source: 'assetUrl', target: 'url' } }], submit: 'edit', poll: imagePoll, result: { kind: 'image', source: 'resultUrl' } },
    'gemini-generate': { submit: 'gemini-generate', poll: imagePoll, result: { kind: 'image', source: 'resultUrl' } },
    'gemini-edit': { uploads: [{ operation: 'upload-image', inputs: 'images', result: { source: 'assetUrl', target: 'url' } }], submit: 'gemini-edit', poll: imagePoll, result: { kind: 'image', source: 'resultUrl' } },
    'gemini-lite-generate': { submit: 'gemini-lite-generate', poll: imagePoll, result: { kind: 'image', source: 'resultUrl' } },
    'gemini-lite-edit': { uploads: [{ operation: 'upload-image', inputs: 'images', result: { source: 'assetUrl', target: 'url' } }], submit: 'gemini-lite-edit', poll: imagePoll, result: { kind: 'image', source: 'resultUrl' } },
    seedance: { submit: 'seedance-submit', poll: { ...imagePoll, operation: 'video-query', intervalMs: 2000 }, result: { kind: 'video', source: 'resultUrl' } },
    'veo-lite': { submit: 'veo-lite-submit', poll: { ...imagePoll, operation: 'video-query', intervalMs: 2000 }, result: { kind: 'video', source: 'resultUrl' } },
    'veo-fast': { submit: 'veo-fast-submit', poll: { ...imagePoll, operation: 'video-query', intervalMs: 2000 }, result: { kind: 'video', source: 'resultUrl' } },
    'veo-quality': { submit: 'veo-quality-submit', poll: { ...imagePoll, operation: 'video-query', intervalMs: 2000 }, result: { kind: 'video', source: 'resultUrl' } },
  },
  modelProfiles: {
    'gpt-4o-mini-tts': {
      label: 'APIMart GPT-4o Mini TTS', capabilities: ['audio.tts'], workflows: { 'audio.tts': 'speech' }, uiSchemas: ['apimart-speech'],
      defaults: { voice: 'alloy', response_format: 'wav', speed: 1 },
    },
    'gemini-lite-image': {
      label: 'APIMart Gemini 3.1 Flash Lite Image', match: ['gemini-3.1-flash-lite-image', 'nano-banana-2-lite'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'gemini-lite-generate', 'image.edit': 'gemini-lite-edit' }, uiSchemas: ['apimart-gemini-lite-image'],
      assets: { images: { mode: 'upload_operation', maxBytes: 20_971_520, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } },
      defaults: { resolution: '1K' }, limits: { resolution: { options: ['1K'], default: '1K' }, references: { images: { max: 14 } }, output: { count: { min: 1, max: 4 } } },
    },
    'gemini-image': {
      label: 'APIMart Gemini Image', match: ['gemini', 'imagen', 'nano-banana'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'gemini-generate', 'image.edit': 'gemini-edit' }, uiSchemas: ['apimart-gemini-image'],
      assets: { images: { mode: 'upload_operation', maxBytes: 20_971_520, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } },
      defaults: { resolution: '1K' }, limits: { references: { images: { max: 14 } }, output: { count: { min: 1, max: 4 } } },
    },
    'gpt-image-2.5': {
      label: 'APIMart GPT Image 2.5', match: ['gpt-image-2.5'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate', 'image.edit': 'edit' }, uiSchemas: ['apimart-gpt-image-2.5'],
      assets: { images: { mode: 'upload_operation', maxBytes: 20_971_520, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } },
      defaults: { size: 'auto', resolution: '1k', quality: 'auto', output_format: 'png', background: 'auto', moderation: 'auto', official_fallback: false },
      limits: { quality: { options: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'auto' }, references: { images: { max: 16 } }, output: { count: { min: 1, max: 4 } } },
    },
    'gpt-image-2': {
      label: 'APIMart GPT Image 2', match: ['gpt-image-2'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate', 'image.edit': 'edit' }, uiSchemas: ['apimart-gpt-image-2'],
      assets: { images: { mode: 'upload_operation', maxBytes: 20_971_520, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } },
      defaults: { size: 'auto', resolution: '1k', quality: 'auto', official_fallback: false },
      limits: { quality: { options: ['auto', 'low', 'medium', 'high'], default: 'auto' }, references: { images: { max: 16 } }, output: { count: { min: 1, max: 4 } } },
    },
    'gpt-image': {
      label: 'APIMart GPT Image', match: ['gpt-image-'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate', 'image.edit': 'edit' }, uiSchemas: ['apimart-gpt-image'],
      assets: { images: { mode: 'upload_operation', maxBytes: 20_971_520, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } },
      defaults: { size: '1024x1024', resolution: '1k', official_fallback: false }, limits: { references: { images: { max: 15 } }, output: { count: { min: 1, max: 4 } } },
    },
    'veo3.1-lite': {
      label: 'APIMart VEO 3.1 Lite', capabilities: ['video.generate', 'video.text_to_video'], workflows: { 'video.generate': 'veo-lite', 'video.text_to_video': 'veo-lite' },
      uiSchemas: ['apimart-video'], assets: {}, defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p' },
      limits: { duration: { options: [4, 5, 8], default: 5 } },
    },
    'veo3.1-quality': {
      label: 'APIMart VEO 3.1 Quality', capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference'],
      workflows: { 'video.generate': 'veo-quality', 'video.text_to_video': 'veo-quality', 'video.image_to_video': 'veo-quality', 'video.first_last_frame': 'veo-quality', 'video.multi_reference': 'veo-quality' },
      uiSchemas: ['apimart-video'], assets: { images: { mode: 'public_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] } }, defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p' },
      limits: { duration: { options: [4, 5, 8], default: 5 } },
    },
    'veo3.1-pro': {
      label: 'APIMart VEO 3.1 Pro', capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference'],
      workflows: { 'video.generate': 'veo-quality', 'video.text_to_video': 'veo-quality', 'video.image_to_video': 'veo-quality', 'video.first_last_frame': 'veo-quality', 'video.multi_reference': 'veo-quality' },
      uiSchemas: ['apimart-video'], assets: { images: { mode: 'public_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] } }, defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p' },
      limits: { duration: { options: [4, 5, 8], default: 5 } },
    },
    veo: {
      label: 'APIMart VEO 3.1 Fast', match: ['veo3.1'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference'],
      workflows: { 'video.generate': 'veo-fast', 'video.text_to_video': 'veo-fast', 'video.image_to_video': 'veo-fast', 'video.first_last_frame': 'veo-fast', 'video.multi_reference': 'veo-fast' },
      uiSchemas: ['apimart-video'], assets: { images: { mode: 'public_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] } }, defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p' },
      limits: { duration: { options: [4, 5, 8], default: 5 } },
    },
    'seedance-2.0-fast': {
      label: 'APIMart Seedance 2.0 Fast', match: ['seedance-2.0-fast', 'doubao-seedance-2.0-fast'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'seedance', 'video.text_to_video': 'seedance', 'video.image_to_video': 'seedance', 'video.first_last_frame': 'seedance', 'video.multi_reference': 'seedance', 'video.video_to_video': 'seedance', 'video.audio_reference': 'seedance', 'video.multimodal': 'seedance' },
      uiSchemas: ['apimart-seedance-video'], assets: { images: { mode: 'public_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] }, videos: { mode: 'public_url', maxBytes: 524_288_000, mimeTypes: ['video/*'] }, audios: { mode: 'public_url', maxBytes: 104_857_600, mimeTypes: ['audio/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true }, limits: { duration: { min: 4, max: 15, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p'], default: '720p' }, aspect_ratio: { options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'], default: '16:9' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
    },
    'seedance-2.0-mini': {
      label: 'APIMart Seedance 2.0 Mini', match: ['seedance-2.0-mini', 'doubao-seedance-2.0-mini'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'seedance', 'video.text_to_video': 'seedance', 'video.image_to_video': 'seedance', 'video.first_last_frame': 'seedance', 'video.multi_reference': 'seedance', 'video.video_to_video': 'seedance', 'video.audio_reference': 'seedance', 'video.multimodal': 'seedance' },
      uiSchemas: ['apimart-seedance-video'], assets: { images: { mode: 'public_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] }, videos: { mode: 'public_url', maxBytes: 524_288_000, mimeTypes: ['video/*'] }, audios: { mode: 'public_url', maxBytes: 104_857_600, mimeTypes: ['audio/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true }, limits: { duration: { min: 4, max: 15, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p'], default: '720p' }, aspect_ratio: { options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'], default: '16:9' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
    },
    seedance: {
      label: 'APIMart Seedance', match: ['doubao-seedance', 'seedance'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'seedance', 'video.text_to_video': 'seedance', 'video.image_to_video': 'seedance', 'video.first_last_frame': 'seedance', 'video.multi_reference': 'seedance', 'video.video_to_video': 'seedance', 'video.audio_reference': 'seedance', 'video.multimodal': 'seedance' },
      uiSchemas: ['apimart-seedance-video'], assets: {
        images: { mode: 'public_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] }, videos: { mode: 'public_url', maxBytes: 524_288_000, mimeTypes: ['video/*'] }, audios: { mode: 'public_url', maxBytes: 104_857_600, mimeTypes: ['audio/*'] },
      }, defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true },
      limits: { duration: { min: 4, max: 15, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p', '1080p', '4k'], default: '720p' }, aspect_ratio: { options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'], default: '16:9' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
    },
    'minimax-video': {
      label: 'MiniMax / Hailuo Video via APIMart', match: ['minimax-h3', 'minimax-hailuo', 'hailuo'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'seedance', 'video.text_to_video': 'seedance', 'video.image_to_video': 'seedance', 'video.first_last_frame': 'seedance', 'video.multi_reference': 'seedance', 'video.video_to_video': 'seedance', 'video.audio_reference': 'seedance', 'video.multimodal': 'seedance' },
      uiSchemas: ['apimart-seedance-video'], assets: {
        images: { mode: 'public_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] }, videos: { mode: 'public_url', maxBytes: 524_288_000, mimeTypes: ['video/*'] }, audios: { mode: 'public_url', maxBytes: 104_857_600, mimeTypes: ['audio/*'] },
      }, defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true },
      limits: { duration: { min: 4, max: 15, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p', '1080p', '4k'], default: '720p' }, aspect_ratio: { options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'], default: '16:9' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
    },
    'sora-video': {
      label: 'Sora Video via APIMart', match: ['sora-2', 'sora-video'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference'],
      workflows: { 'video.generate': 'seedance', 'video.text_to_video': 'seedance', 'video.image_to_video': 'seedance', 'video.first_last_frame': 'seedance', 'video.multi_reference': 'seedance' },
      uiSchemas: ['apimart-seedance-video'], assets: { images: { mode: 'public_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true },
      limits: { duration: { min: 4, max: 15, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p', '1080p', '4k'], default: '720p' }, aspect_ratio: { options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'], default: '16:9' }, references: { images: { max: 9 }, videos: { max: 0 }, audios: { max: 0 } } },
    },
  },
  uiSchemas: {
    'apimart-speech': [
      { key: 'voice', label: '声音', type: 'select', default: 'alloy', options: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((value) => ({ label: value, value })) },
      { key: 'response_format', label: '格式', type: 'select', default: 'wav', options: ['wav', 'opus', 'aac', 'flac', 'pcm'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'speed', label: '速度', type: 'slider', default: 1, min: 0.25, max: 4, step: 0.05 },
    ],
    'apimart-gpt-image': [
      { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k', '4k'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'nsfw_check', label: '提交前内容审核', type: 'toggle', default: false },
      { key: 'official_fallback', label: '官方渠道兜底', type: 'toggle', default: false },
    ],
    'apimart-gpt-image-2': [
      { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k', '4k'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'quality', label: '质量', type: 'select', default: 'auto', options: ['auto', 'low', 'medium', 'high'].map((value) => ({ label: value, value })) },
      { key: 'nsfw_check', label: '提交前内容审核', type: 'toggle', default: false },
      { key: 'official_fallback', label: '官方渠道兜底', type: 'toggle', default: false },
    ],
    'apimart-gpt-image-2.5': [
      { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k', '4k'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'quality', label: '质量', type: 'select', default: 'auto', options: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ label: value, value })) },
      { key: 'output_format', label: '输出格式', type: 'select', default: 'png', options: ['png', 'jpeg', 'webp'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'output_compression', label: '输出压缩', type: 'number', default: 100, min: 0, max: 100, step: 1 },
      { key: 'background', label: '背景', type: 'select', default: 'auto', options: ['auto', 'transparent', 'opaque'].map((value) => ({ label: value, value })) },
      { key: 'moderation', label: '内容审核强度', type: 'select', default: 'auto', options: ['auto', 'low'].map((value) => ({ label: value, value })) },
      { key: 'nsfw_check', label: '提交前内容审核', type: 'toggle', default: false },
      { key: 'official_fallback', label: '官方渠道兜底', type: 'toggle', default: false },
    ],
    'apimart-gemini-image': [
      { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9', '9:21'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k', '4k'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'google_search', label: '联网搜索增强', type: 'toggle', default: false },
      { key: 'google_image_search', label: '图片搜索增强', type: 'toggle', default: false },
      { key: 'nsfw_check', label: '提交前内容审核', type: 'toggle', default: false },
      { key: 'official_fallback', label: '官方渠道兜底', type: 'toggle', default: false },
    ],
    'apimart-gemini-lite-image': [
      { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '21:9'].map((value) => ({ label: value, value })) },
      { key: 'nsfw_check', label: '提交前内容审核', type: 'toggle', default: false },
    ],
    'apimart-video': [
      { key: 'duration', label: '时长', type: 'number', default: 5, min: 4, max: 30, step: 1 },
      { key: 'aspect_ratio', label: '比例', type: 'select', default: '16:9', options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '720p', options: ['480p', '720p', '1080p', '4k'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'generate_audio', label: '生成音频', type: 'toggle', default: false },
    ],
    'apimart-seedance-video': [
      { key: 'duration', label: '时长', type: 'number', default: 5, min: 4, max: 15, step: 1 },
      { key: 'aspect_ratio', label: '比例', type: 'select', default: '16:9', options: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '720p', options: ['480p', '720p', '1080p', '4k'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'generate_audio', label: '生成音频', type: 'toggle', default: true },
      { key: 'return_last_frame', label: '返回尾帧', type: 'toggle', default: false },
      { key: 'seed', label: '随机种子', type: 'number', default: 0, min: 0, step: 1 },
      { key: 'nsfw_check', label: '提交前内容审核', type: 'toggle', default: false },
    ],
  },
}

apimartImagesProtocol.operations['seedance25-submit'] = {
  ...apimartImagesProtocol.operations['seedance-submit'],
  derive: { duration: { op: 'clamp', value: ref('params.duration'), min: 4, max: 30 } },
}
apimartImagesProtocol.workflows.seedance25 = { ...apimartImagesProtocol.workflows.seedance, submit: 'seedance25-submit' }
const apimartSeedanceProfile = apimartImagesProtocol.modelProfiles.seedance
apimartImagesProtocol.modelProfiles = {
  'seedance-2.5': {
    ...apimartSeedanceProfile,
    label: 'APIMart Seedance 2.5', match: ['doubao-seedance-2.5', 'doubao-seedance-2-5', 'seedance-2.5', 'seedance-2-5', 'seedance2.5'],
    workflows: Object.fromEntries(Object.keys(apimartSeedanceProfile.workflows || {}).map((intent) => [intent, 'seedance25'])),
    limits: { ...apimartSeedanceProfile.limits, duration: { min: 4, max: 30, step: 1, integer: true, default: 5 }, resolution: { options: ['480p', '720p', '1080p'], default: '720p' }, references: { images: { max: 30 }, videos: { max: 10 }, audios: { max: 10 } } },
  },
  ...apimartImagesProtocol.modelProfiles,
}

delete apimartImagesProtocol.modelProfiles['minimax-video']
for (const modelId of ['MiniMax-H3-Max', 'MiniMax-H3', 'MiniMax-Hailuo-02', 'MiniMax-Hailuo-2.3-Fast', 'MiniMax-Hailuo-2.3']) {
  const h3 = modelId.startsWith('MiniMax-H3')
  const max = modelId.endsWith('-Max')
  const fast = modelId.endsWith('-Fast')
  const hailuo02 = modelId.endsWith('-02')
  const resolutions = h3 ? max ? ['480P', '768P', '1080P'] : ['2K', '768P'] : hailuo02 ? ['512p', '768p', '1080p'] : ['768p', '1080p']
  const defaultDuration = h3 || hailuo02 ? 5 : 6
  const operationId = `${modelId.toLowerCase()}-submit`
  const capabilities = h3 ? apimartSeedanceProfile.capabilities : fast ? ['video.image_to_video'] : hailuo02 ? ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame'] : ['video.generate', 'video.text_to_video', 'video.image_to_video']
  apimartImagesProtocol.operations[operationId] = {
    ...apimartImagesProtocol.operations['seedance-submit'],
    derive: { resolution: { op: h3 ? 'upper' : 'lower', value: ref('params.resolution') } },
    bodyTemplate: {
      model: modelId, prompt: '{{prompt}}', duration: '{{params.duration}}', resolution: '{{derived.resolution}}',
      ...(h3 ? {
        aspect_ratio: '{{params.aspect_ratio}}',
        image_with_roles: { $map: { from: '{{inputs.images}}', template: { url: '{{item.url}}', role: { $coalesce: ['{{item.role}}', 'reference_image'] } } } },
        video_urls: '{{inputs.videos[*].url}}', audio_urls: '{{inputs.audios[*].url}}', webhook: '{{params.webhook}}',
        ...(!max ? { watermark: '{{params.watermark}}' } : {}),
      } : {
        first_frame_image: '{{inputs.images[0].url}}', ...(hailuo02 ? { last_frame_image: '{{inputs.images[1].url}}' } : {}),
        prompt_optimizer: '{{params.prompt_optimizer}}', fast_pretreatment: '{{params.fast_pretreatment}}', watermark: '{{params.watermark}}',
      }),
      nsfw_check: '{{params.nsfw_check}}',
    },
  }
  apimartImagesProtocol.workflows[modelId] = { ...apimartImagesProtocol.workflows.seedance, submit: operationId }
  apimartImagesProtocol.modelProfiles[modelId] = {
    label: `APIMart ${modelId}`, match: [modelId.toLowerCase()], capabilities: [...capabilities],
    workflows: Object.fromEntries(capabilities.map((intent) => [intent, modelId])), uiSchemas: [modelId],
    assets: apimartSeedanceProfile.assets,
    defaults: { duration: defaultDuration, resolution: h3 ? max ? '768P' : '2K' : '768p', ...(h3 ? { aspect_ratio: '16:9' } : { prompt_optimizer: true, fast_pretreatment: false }), watermark: false },
    limits: {
      duration: h3 ? { min: max ? 5 : 4, max: 15, integer: true, default: 5 } : { options: [defaultDuration, 10], default: defaultDuration },
      resolution: { options: resolutions, default: h3 ? max ? '768P' : '2K' : '768p' },
      references: { images: { min: fast ? 1 : 0, max: h3 ? 9 : hailuo02 ? 2 : 1 }, videos: { max: h3 ? 3 : 0 }, audios: { max: h3 ? 3 : 0 } },
    },
  }
  apimartImagesProtocol.uiSchemas[modelId] = [
    { key: 'duration', label: '时长（秒）', type: h3 ? 'number' : 'select', default: defaultDuration, min: h3 ? max ? 5 : 4 : defaultDuration, max: h3 ? 15 : 10, step: 1,
      ...(!h3 ? { options: [defaultDuration, 10].map((value) => ({ label: `${value}s`, value })), profiles: { '1080p': { min: defaultDuration, max: defaultDuration, options: [defaultDuration] } } } : {}) },
    { key: 'resolution', label: '分辨率', type: 'select', default: h3 ? max ? '768P' : '2K' : '768p', options: resolutions.map((value) => ({ label: value, value })) },
    ...(h3 ? [{ key: 'aspect_ratio', label: '比例', type: 'select', default: '16:9', options: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].map((value) => ({ label: value, value })) }] : [{ key: 'prompt_optimizer', label: '提示词优化', type: 'toggle', default: true }]),
  ]
}
for (const intent of ['generate', 'edit']) {
  const operationId = `seedream5-${intent}`
  apimartImagesProtocol.operations[operationId] = {
    ...apimartImagesProtocol.operations.generate,
    derive: {
      size: { op: 'coalesce', values: [ref('params.size'), ref('params.aspect_ratio'), ref('params.aspectRatio'), literal('auto')] },
      resolution: { op: 'upper', value: { op: 'coalesce', values: [ref('params.resolution'), literal('1K')] } },
    },
    bodyTemplate: {
      model: '{{model}}', prompt: '{{prompt}}', n: 1, size: '{{derived.size}}', resolution: '{{derived.resolution}}',
      ...(intent === 'edit' ? { image_urls: '{{inputs.images[*].url}}' } : {}),
    },
  }
  apimartImagesProtocol.workflows[operationId] = { ...apimartImagesProtocol.workflows[intent], submit: operationId }
}
apimartImagesProtocol.modelProfiles['seedream-5-pro'] = {
  label: 'APIMart Seedream 5 Pro / Flash',
  match: ['seedream-5-0-pro', 'seedream-5.0-pro', 'doubao-seedream-5-0-pro', 'doubao-seedream-5.0-pro', 'seedream-5-0-flash', 'seedream-5.0-flash', 'doubao-seedream-5-0-flash', 'doubao-seedream-5.0-flash'],
  capabilities: ['image.generate', 'image.edit'], workflows: { 'image.generate': 'seedream5-generate', 'image.edit': 'seedream5-edit' }, uiSchemas: ['apimart-seedream5'],
  assets: { images: { mode: 'upload_operation', mimeTypes: ['image/*'], maxBytes: 30 * 1024 * 1024 } },
  defaults: { resolution: '1K', n: 1 },
  limits: { resolution: { options: ['1k', '1.5k', '2k'], default: '1k' }, references: { images: { max: 10 } }, output: { count: { min: 1, max: 1 } } },
}
apimartImagesProtocol.uiSchemas['apimart-seedream5'] = [
  { key: 'size', label: '尺寸（像素或支持的比例）', type: 'text' },
  { key: 'resolution', label: '分辨率', type: 'select', default: '1k', options: ['1k', '1.5k', '2k'].map((value) => ({ label: value.toUpperCase(), value })) },
  { key: 'n', label: '数量', type: 'number', min: 1, max: 1, default: 1 },
]
// Seedream 4.0 / 4.5 / 5.0-Lite：文档分辨率档位是大写 1K/2K/4K（Lite 只支持 2K/3K/4K）。
// 之前没有专用 profile，会落到通用 generate 发小写 1k，Lite 必错 → 按族补 profile + upper derive。
for (const [profileId, match, resolutions, defaultResolution, label] of [
  ['seedream-5-lite', ['seedream-5-0-lite', 'seedream-5.0-lite', 'doubao-seedream-5-0-lite', 'doubao-seedream-5.0-lite'], ['2K', '3K', '4K'], '2K', 'APIMart Seedream 5.0 Lite'],
  ['seedream-4.5', ['seedream-4.5', 'seedream-4-5', 'doubao-seedream-4.5', 'doubao-seedream-4-5'], ['2K', '4K'], '2K', 'APIMart Seedream 4.5'],
  ['seedream-4', ['seedream-4.0', 'seedream-4-0', 'doubao-seedream-4.0', 'doubao-seedream-4-0', 'seedream-4'], ['1K', '2K', '4K'], '2K', 'APIMart Seedream 4.0'],
]) {
  for (const intent of ['generate', 'edit']) {
    const operationId = profileId + '-' + intent
    apimartImagesProtocol.operations[operationId] = {
      ...apimartImagesProtocol.operations.generate,
      derive: {
        size: { op: 'coalesce', values: [ref('params.size'), ref('params.aspect_ratio'), ref('params.aspectRatio'), literal('auto')] },
        // 大写后按本族档位收敛（如 Lite 传 1K → 2K），避免文档不支持的档位直接 400
        resolution: {
          op: 'lookup',
          value: { op: 'upper', value: { op: 'coalesce', values: [ref('params.resolution'), literal(defaultResolution)] } },
          cases: Object.fromEntries(resolutions.map((value) => [value, value])),
          fallback: defaultResolution,
        },
      },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', size: '{{derived.size}}', resolution: '{{derived.resolution}}',
        ...(intent === 'edit' ? { image_urls: '{{inputs.images[*].url}}' } : {}),
        nsfw_check: '{{params.nsfw_check}}',
      },
    }
    apimartImagesProtocol.workflows[operationId] = { ...apimartImagesProtocol.workflows[intent], submit: operationId }
  }
  apimartImagesProtocol.modelProfiles[profileId] = {
    label, match, capabilities: ['image.generate', 'image.edit'],
    workflows: { 'image.generate': profileId + '-generate', 'image.edit': profileId + '-edit' },
    uiSchemas: [profileId],
    assets: apimartImagesProtocol.modelProfiles['seedream-5-pro'].assets,
    defaults: { size: 'auto', resolution: defaultResolution, n: 1 },
    limits: { resolution: { options: resolutions, default: defaultResolution }, references: { images: { max: 14 } }, output: { count: { min: 1, max: 4 } } },
  }
  apimartImagesProtocol.uiSchemas[profileId] = [
    { key: 'size', label: '尺寸（像素或支持的比例）', type: 'text' },
    { key: 'resolution', label: '分辨率', type: 'select', default: defaultResolution, options: resolutions.map((value) => ({ label: value, value })) },
    { key: 'n', label: '数量', type: 'number', min: 1, max: 4, default: 1 },
    { key: 'nsfw_check', label: '提交前内容审核', type: 'toggle', default: false },
  ]
}
for (const [profileId, maxImages] of [['grok-imagine-image-2.0', 3], ['grok-imagine-image-quality', 3], ['grok-imagine-image', 5], ['grok-imagine-2.0-ext', 0], ['grok-imagine-1.5-apimart', 5], ['grok-imagine-1.5-ext', 5]]) {
  const ext = profileId === 'grok-imagine-2.0-ext'
  const relay15 = profileId.startsWith('grok-imagine-1.5-')
  const official2 = profileId === 'grok-imagine-image-2.0'
  const ratios = relay15 ? ['1:1', '16:9', '9:16', '3:2', '2:3'] : ext ? ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'] : apimartGrokRatios
  for (const intent of (ext ? ['generate'] : ['generate', 'edit'])) {
    const operationId = `${profileId}-${intent}`
    apimartImagesProtocol.operations[operationId] = {
      ...apimartImagesProtocol.operations.generate,
      headersTemplate: { 'Content-Type': 'application/json', 'X-APIMart-Response-Version': '2026-07-27' },
      derive: {
        ratio: apimartImageRatio(),
        resolution: { op: 'lower', value: { op: 'coalesce', values: [ref('params.resolution'), literal('1k')] } },
      },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}',
        [ext || relay15 ? 'size' : 'aspect_ratio']: '{{derived.ratio}}',
        ...(!relay15 ? { resolution: ext ? 'quality' : '{{derived.resolution}}' } : {}),
        ...(ext ? { response_format: 'url' } : {}),
        ...(official2 && intent === 'generate' ? { quality: '{{params.quality}}' } : {}),
        ...(intent === 'edit' ? { image_urls: '{{inputs.images[*].url}}' } : {}),
        nsfw_check: '{{params.nsfw_check}}',
      },
    }
    apimartImagesProtocol.workflows[operationId] = { ...apimartImagesProtocol.workflows[intent], submit: operationId }
  }
  apimartImagesProtocol.modelProfiles[profileId] = {
    label: `APIMart ${profileId}`, match: [profileId], capabilities: ext ? ['image.generate'] : ['image.generate', 'image.edit'],
    workflows: { 'image.generate': `${profileId}-generate`, ...(!ext ? { 'image.edit': `${profileId}-edit` } : {}) },
    uiSchemas: [profileId],
    assets: { images: { mode: 'upload_operation', maxBytes: 20_971_520, mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] } },
    defaults: { aspect_ratio: '1:1', resolution: ext ? 'quality' : '1k', n: 1, ...(official2 ? { quality: 'medium' } : {}) },
    limits: { aspect_ratio: { options: ratios, default: '1:1' }, resolution: ext || relay15 ? { supported: false } : { options: ['1k', '2k'], default: '1k' }, references: { images: { max: maxImages } }, output: { count: { min: 1, max: ext ? 12 : 10 } }, ...(official2 ? { quality: { options: ['low', 'medium'], default: 'medium' } } : {}) },
  }
  apimartImagesProtocol.uiSchemas[profileId] = [
    { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ratios.map((value) => ({ label: value, value })) },
    ...(!ext && !relay15 ? [{ key: 'resolution', label: '分辨率', type: 'select', default: '1k', options: ['1k', '2k'].map((value) => ({ label: value.toUpperCase(), value })) }] : []),
    ...(official2 ? [{ key: 'quality', label: '质量（仅文生图）', type: 'select', default: 'medium', options: [{ label: '低', value: 'low' }, { label: '中', value: 'medium' }] }] : []),
    { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: ext ? 12 : 10, step: 1 },
  ]
}

/** Midjourney is a task/action API, not an OpenAI-compatible image endpoint. */
const midjourneyProtocol = {
  schemaVersion: 'dx-protocol/v2',
  kind: 'model',
  id: 'midjourney',
  label: 'Midjourney 专用协议',
  summary: 'Midjourney Imagine、Edit、Blend 与 U/V、Reroll、Zoom、Pan、Inpaint、Remix 的声明式异步任务协议。',
  executor: { type: 'declarative', engine: '>=1.0.0' },
  capabilities: ['image.generate', 'image.edit', 'image.blend', 'image.upscale', 'image.variation', 'image.low_variation', 'image.high_variation', 'image.reroll', 'image.zoom', 'image.pan', 'image.inpaint', 'image.remix_subtle', 'image.remix_strong', 'tasks.get'],
  operations: {
    'image.generate': midjourneyAction('/v1/midjourney/generations', {
      prompt: '{{prompt}}', size: '{{params.size}}', version: '{{params.version}}', image_urls: '{{inputs.images[*].dataUrl}}',
    }),
    'image.edit': midjourneyAction('/v1/midjourney/generations/edits', {
      prompt: '{{prompt}}', size: '{{params.size}}', image_urls: '{{inputs.images[*].dataUrl}}',
    }),
    'image.blend': midjourneyAction('/v1/midjourney/generations/blend', {
      size: '{{params.size}}', image_urls: '{{inputs.images[*].dataUrl}}',
    }),
    'image.upscale': midjourneyAction('/v1/midjourney/generations/upscale', { task_id: '{{params.task_id}}', index: '{{params.index}}', custom_id: '{{params.custom_id}}' }),
    'image.variation': midjourneyAction('/v1/midjourney/generations/variation', { task_id: '{{params.task_id}}', index: '{{params.index}}', custom_id: '{{params.custom_id}}' }),
    'image.low_variation': midjourneyAction('/v1/midjourney/generations/low-variation', { task_id: '{{params.task_id}}', index: '{{params.index}}', custom_id: '{{params.custom_id}}' }),
    'image.high_variation': midjourneyAction('/v1/midjourney/generations/high-variation', { task_id: '{{params.task_id}}', index: '{{params.index}}', custom_id: '{{params.custom_id}}' }),
    'image.reroll': midjourneyAction('/v1/midjourney/generations/reroll', { task_id: '{{params.task_id}}', custom_id: '{{params.custom_id}}' }),
    'image.zoom': midjourneyAction('/v1/midjourney/generations/zoom', { task_id: '{{params.task_id}}', index: '{{params.index}}', zoom_ratio: '{{params.zoom_ratio}}', custom_id: '{{params.custom_id}}' }),
    'image.pan': midjourneyAction('/v1/midjourney/generations/pan', { task_id: '{{params.task_id}}', index: '{{params.index}}', direction: '{{params.direction}}', custom_id: '{{params.custom_id}}' }),
    'image.inpaint': midjourneyAction('/v1/midjourney/generations/modal', { task_id: '{{params.task_id}}', prompt: '{{prompt}}', mask_url: '{{inputs.images[0].dataUrl}}' }),
    'image.remix_subtle': midjourneyAction('/v1/midjourney/generations/remix-subtle', { task_id: '{{params.task_id}}', index: '{{params.index}}', prompt: '{{prompt}}', custom_id: '{{params.custom_id}}' }),
    'image.remix_strong': midjourneyAction('/v1/midjourney/generations/remix-strong', { task_id: '{{params.task_id}}', index: '{{params.index}}', prompt: '{{prompt}}', custom_id: '{{params.custom_id}}' }),
    'tasks.get': {
      method: 'GET', path: '/v1/midjourney/{taskId}', requestMode: 'path',
      response: midjourneyResponse,
    },
  },
  workflows: {
    'image.generate': midjourneyWorkflow('image.generate'), 'image.edit': midjourneyWorkflow('image.edit'), 'image.blend': midjourneyWorkflow('image.blend'),
    'image.upscale': midjourneyWorkflow('image.upscale'), 'image.variation': midjourneyWorkflow('image.variation'),
    'image.low_variation': midjourneyWorkflow('image.low_variation'), 'image.high_variation': midjourneyWorkflow('image.high_variation'),
    'image.reroll': midjourneyWorkflow('image.reroll'), 'image.zoom': midjourneyWorkflow('image.zoom'), 'image.pan': midjourneyWorkflow('image.pan'),
    'image.inpaint': midjourneyWorkflow('image.inpaint'), 'image.remix_subtle': midjourneyWorkflow('image.remix_subtle'), 'image.remix_strong': midjourneyWorkflow('image.remix_strong'),
    'tasks.get': { submit: 'tasks.get', result: { kind: 'image', source: 'resultUrl' } },
  },
  modelProfiles: {
    midjourney: {
      label: 'Midjourney', match: ['midjourney', 'mj', 'niji'],
      capabilities: ['image.generate', 'image.edit', 'image.blend', 'image.upscale', 'image.variation', 'image.low_variation', 'image.high_variation', 'image.reroll', 'image.zoom', 'image.pan', 'image.inpaint', 'image.remix_subtle', 'image.remix_strong', 'tasks.get'],
      workflows: {
        'image.generate': 'image.generate', 'image.edit': 'image.edit', 'image.blend': 'image.blend', 'image.upscale': 'image.upscale', 'image.variation': 'image.variation',
        'image.low_variation': 'image.low_variation', 'image.high_variation': 'image.high_variation', 'image.reroll': 'image.reroll', 'image.zoom': 'image.zoom',
        'image.pan': 'image.pan', 'image.inpaint': 'image.inpaint', 'image.remix_subtle': 'image.remix_subtle', 'image.remix_strong': 'image.remix_strong', 'tasks.get': 'tasks.get',
      },
      uiSchemas: ['midjourney-generate'],
      assets: { images: { mode: 'data_url', maxBytes: 52_428_800, maxDimension: 2048, mimeTypes: ['image/*'] } },
      defaults: { size: '1:1', version: '6.1', speed: 'relax', index: 1, zoom_ratio: 2 },
      limits: { references: { images: { max: 4 } }, output: { count: { min: 1, max: 4 } } },
    },
  },
  uiSchemas: {
    'midjourney-generate': [
      { key: 'size', label: '比例', type: 'select', default: '1:1', options: ['1:1', '4:3', '3:4', '16:9', '9:16'].map((value) => ({ label: value, value })) },
      { key: 'version', label: '版本', type: 'text', default: '6.1' },
      { key: 'speed', label: '速度', type: 'select', default: 'relax', options: ['relax', 'fast', 'turbo'].map((value) => ({ label: value, value })) },
    ],
  },
}

// apib.ai 常被旧配置标记为 apimart。保留独立模型协议，确保该兼容
// 网关的图片 Profile、参数约束和未来变更不会反向污染 APIMart 官网协议。
const apibImagesProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'apib-images', label: 'APIB 图片',
  summary: 'APIB 的 OpenAI JSON 图片生成与参考图协议；参考图通过 image_urls 提交。',
  executor: { type: 'declarative', engine: '>=1.0.0' }, capabilities: ['image.generate', 'image.edit'],
  operations: {
    generate: apimartImagesProtocol.operations.generate,
    edit: apimartImagesProtocol.operations.edit,
    'image-query': apimartImagesProtocol.operations['image-query'],
    'upload-image': apimartImagesProtocol.operations['upload-image'],
  },
  workflows: {
    generate: apimartImagesProtocol.workflows.generate,
    edit: apimartImagesProtocol.workflows.edit,
  },
  modelProfiles: {
    'gemini-image': {
      label: 'APIB Gemini Image', match: ['gemini', 'imagen', 'nano-banana'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate', 'image.edit': 'edit' }, uiSchemas: ['apib-image'],
      assets: { images: { mode: 'upload_operation', maxBytes: 20_971_520, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } },
      defaults: { size: '1:1', resolution: '1k' }, limits: { references: { images: { max: 9 } }, output: { count: { min: 1, max: 4 } } },
    },
    'gpt-image': {
      label: 'APIB GPT Image', match: ['gpt-image-', 'dall-e-'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate', 'image.edit': 'edit' }, uiSchemas: ['apib-image'],
      assets: { images: { mode: 'upload_operation', maxBytes: 20_971_520, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } },
      defaults: { size: '1:1', resolution: '1k' }, limits: { references: { images: { max: 9 } }, output: { count: { min: 1, max: 4 } } },
    },
    image: {
      label: 'APIB Image', match: [''], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'generate', 'image.edit': 'edit' }, uiSchemas: ['apib-image'],
      assets: { images: { mode: 'upload_operation', maxBytes: 20_971_520, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } },
      defaults: { size: '1:1', resolution: '1k' }, limits: { references: { images: { max: 9 } }, output: { count: { min: 1, max: 4 } } },
    },
  },
  uiSchemas: {
    'apib-image': apimartImagesProtocol.uiSchemas?.['apimart-gpt-image'] || [],
  },
}

const modelScopeImagesProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'modelscope-images', label: 'ModelScope 图片',
  summary: 'ModelScope 异步图片生成、参考图编辑、LoRA 与任务轮询协议。',
  executor: { type: 'declarative', engine: '>=1.0.0' }, capabilities: ['image.generate', 'image.edit'],
  operations: {
    generate: {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json', 'X-ModelScope-Async-Mode': 'true' },
      derive: { loraStrength: { op: 'clamp', value: { op: 'coalesce', values: [ref('params.modelscope_lora_strength'), literal(0.8)] }, min: 0, max: 2 } },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', n: '{{params.n}}',
        loras: { $coalesce: ['{{params.loras}}', { $keyValue: { key: '{{params.modelscope_lora}}', value: '{{derived.loraStrength}}' } }] },
      },
      response: {
        taskId: ['$.task_id', '$.taskId', '$.id'], status: ['$.task_status', '$.status'],
        resultUrls: ['$.output_images[*]', '$.images[*]', '$.data[*].url', '$.data[*].image_url'], resultData: '$.data[*].b64_json',
        errorMessage: ['$.error.message', '$.message'],
      },
    },
    edit: {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json', 'X-ModelScope-Async-Mode': 'true' },
      derive: { loraStrength: { op: 'clamp', value: { op: 'coalesce', values: [ref('params.modelscope_lora_strength'), literal(0.8)] }, min: 0, max: 2 } },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', size: '{{params.size}}', n: '{{params.n}}', image_url: '{{inputs.images[*].dataUrl}}',
        loras: { $coalesce: ['{{params.loras}}', { $keyValue: { key: '{{params.modelscope_lora}}', value: '{{derived.loraStrength}}' } }] },
      },
      response: {
        taskId: ['$.task_id', '$.taskId', '$.id'], status: ['$.task_status', '$.status'],
        resultUrls: ['$.output_images[*]', '$.images[*]', '$.data[*].url', '$.data[*].image_url'], resultData: '$.data[*].b64_json',
        errorMessage: ['$.error.message', '$.message'],
      },
    },
    query: {
      method: 'GET', path: '/v1/tasks/{taskId}', requestMode: 'json',
      headersTemplate: { 'X-ModelScope-Task-Type': 'image_generation' },
      retry: { attempts: 3, delayMs: 500, backoff: 2, retryStatus: [429, 500, 502, 503, 504], retryNetwork: true },
      response: {
        status: ['$.task_status', '$.status'], progress: ['$.progress', '$.data.progress'],
        resultUrls: ['$.output_images[*]', '$.images[*]', '$.data[*].url', '$.data[*].image_url'], resultData: '$.data[*].b64_json',
        errorMessage: ['$.error.message', '$.message'],
      },
    },
  },
  workflows: {
    generate: { submit: 'generate', poll: { operation: 'query', intervalMs: 2000, backoff: 1.25, maxIntervalMs: 8000, maxDurationMs: 900000, status: { pending: ['queued', 'pending', 'processing', 'running'], success: ['succeed', 'succeeded', 'success', 'completed'], failure: ['failed', 'failure', 'error', 'canceled', 'cancelled', 'timeout', 'rejected'] } }, result: { kind: 'image', source: 'resultUrl' } },
    edit: { submit: 'edit', poll: { operation: 'query', intervalMs: 2000, backoff: 1.25, maxIntervalMs: 8000, maxDurationMs: 900000, status: { pending: ['queued', 'pending', 'processing', 'running'], success: ['succeed', 'succeeded', 'success', 'completed'], failure: ['failed', 'failure', 'error', 'canceled', 'cancelled', 'timeout', 'rejected'] } }, result: { kind: 'image', source: 'resultUrl' } },
  },
  modelProfiles: {
    'qwen-image-edit-2511': {
      label: 'Qwen Image Edit 2511', match: ['qwen/qwen-image-edit-2511'],
      capabilities: ['image.generate', 'image.edit'], workflows: { 'image.generate': 'generate', 'image.edit': 'edit' }, uiSchemas: ['modelscope-image'],
      assets: { images: { mode: 'data_url', maxBytes: 20_971_520, maxDimension: 2048, mimeTypes: ['image/*'] } },
      defaults: { size: '1024x1024', n: 1 }, limits: { references: { images: { max: 8 } }, output: { count: { min: 1, max: 8 } } },
    },
    image: {
      label: 'ModelScope Image', match: ['tongyi-mai/z-image', 'qwen/qwen-image', 'musepublic/qwen-image', 'black-forest-labs/flux.2-klein'],
      capabilities: ['image.generate', 'image.edit'], workflows: { 'image.generate': 'generate', 'image.edit': 'edit' }, uiSchemas: ['modelscope-image'],
      assets: { images: { mode: 'data_url', maxBytes: 20_971_520, maxDimension: 4096, mimeTypes: ['image/*'] } },
      defaults: { size: '1024x1024', n: 1 }, limits: { references: { images: { max: 8 } }, output: { count: { min: 1, max: 8 } } },
    },
  },
  uiSchemas: {
    'modelscope-image': [
      { key: 'size', label: '图片尺寸', type: 'select', default: '1024x1024', options: ['1024x1024', '1024x1536', '1536x1024'].map((value) => ({ label: value, value })) },
      { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 8, step: 1 },
    ],
  },
}

/** Volcengine Ark / Doubao official API. */
const volcengineProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'volcengine', label: '火山方舟能力协议',
  summary: '火山方舟兼容对话、Seedream 图片与 Seedance 异步视频的声明式协议。',
  executor: { type: 'declarative', engine: '>=1.0.0' },
  capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools', 'image.generate', 'image.edit', 'video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
  operations: {
    'llm-chat': {
      method: 'POST', path: '/api/v3/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], temperature: '{{params.temperature}}', top_p: '{{params.top_p}}', max_tokens: '{{params.max_tokens}}', tools: '{{params.tools}}', tool_choice: '{{params.tool_choice}}' },
      response: { text: ['$.choices[0].message.content', '$.choices[0].message.tool_calls'], usage: '$.usage', errorMessage: ['$.error.message', '$.message'] },
    },
    'llm-vision': {
      method: 'POST', path: '/api/v3/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: { model: '{{model}}', messages: [{ role: 'user', content: { $concat: [
        [{ type: 'text', text: '{{prompt}}' }],
        { $map: { from: '{{inputs.images}}', template: { type: 'image_url', image_url: { url: '{{item.dataUrl}}' } } } },
      ] } }], temperature: '{{params.temperature}}', top_p: '{{params.top_p}}', max_tokens: '{{params.max_tokens}}' },
      response: { text: '$.choices[0].message.content', usage: '$.usage', errorMessage: ['$.error.message', '$.message'] },
    },
    image: {
      method: 'POST', path: '/api/v3/images/generations', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      derive: { normalizedSize: { op: 'lookup', value: ref('params.size'), cases: { '1k': '1920x1920', '2k': '2048x2048', '4k': '4096x4096', '1024x1024': '1920x1920' } } },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', size: { $coalesce: ['{{derived.normalizedSize}}', '{{params.size}}', '2048x2048'] }, response_format: { $coalesce: ['{{params.response_format}}', 'url'] },
        image: { $map: { from: '{{inputs.images}}', template: { $coalesce: ['{{item.url}}', '{{item.dataUrl}}'] } } },
        watermark: '{{params.watermark}}', seed: '{{params.seed}}', sequential_image_generation: '{{params.sequential_image_generation}}',
      },
      response: { resultUrls: ['$.data[*].url', '$.data[*].image_url'], resultData: '$.data[*].b64_json', errorCode: '$.error.code', errorMessage: ['$.error.message', '$.message'] },
    },
    'video-submit': {
      method: 'POST', path: '/api/v3/contents/generations/tasks', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      derive: {
        duration: { op: 'clamp', value: { op: 'round', value: { op: 'coalesce', values: [ref('params.duration'), literal(5)] } }, min: 1, max: 60 },
        resolution: { op: 'lookup', value: { op: 'lower', value: ref('params.resolution') }, cases: { '480': '480p', '480p': '480p', '720': '720p', '720p': '720p', '1080': '1080p', '1080p': '1080p' } },
      },
      bodyTemplate: {
        model: '{{model}}', content: { $concat: [
          [{ type: 'text', text: '{{prompt}}' }],
          { $map: { from: '{{inputs.images}}', template: { type: 'image_url', image_url: { url: { $coalesce: ['{{item.url}}', '{{item.dataUrl}}'] } }, role: { $coalesce: ['{{item.role}}', 'first_frame'] } } } },
          { $map: { from: '{{inputs.videos}}', template: { type: 'video_url', video_url: { url: '{{item.url}}' }, role: { $coalesce: ['{{item.role}}', 'reference_video'] } } } },
          { $map: { from: '{{inputs.audios}}', template: { type: 'audio_url', audio_url: { url: '{{item.url}}' }, role: { $coalesce: ['{{item.role}}', 'reference_audio'] } } } },
        ] },
        duration: '{{derived.duration}}', ratio: { $coalesce: ['{{params.aspect_ratio}}', '{{params.size}}'] }, resolution: '{{derived.resolution}}',
        watermark: '{{params.watermark}}', generate_audio: '{{params.generate_audio}}', camerafixed: '{{params.camerafixed}}', seed: '{{params.seed}}', return_last_frame: '{{params.return_last_frame}}',
      },
      response: { taskId: ['$.id', '$.task_id', '$.data.id', '$.data.task_id'], status: ['$.status', '$.data.status'], resultUrl: ['$.content.video_url', '$.content.url', '$.data.content.video_url', '$.data.video_url'], errorCode: '$.error.code', errorMessage: ['$.error.message', '$.message'] },
    },
    'video-query': {
      method: 'GET', path: '/api/v3/contents/generations/tasks/{taskId}', requestMode: 'json',
      retry: { attempts: 3, delayMs: 500, backoff: 2, retryStatus: [429, 500, 502, 503, 504], retryNetwork: true },
      response: { taskId: ['$.id', '$.task_id', '$.data.id'], status: ['$.status', '$.data.status'], progress: ['$.progress', '$.data.progress'], resultUrl: ['$.content.video_url', '$.content.url', '$.data.content.video_url', '$.data.video_url'], errorCode: '$.error.code', errorMessage: ['$.error.message', '$.message'] },
    },
  },
  workflows: {
    chat: { submit: 'llm-chat', result: { kind: 'text', source: 'response' } },
    vision: { submit: 'llm-vision', result: { kind: 'text', source: 'response' } },
    image: { submit: 'image', result: { kind: 'image', source: 'resultUrl' } },
    video: { submit: 'video-submit', poll: { operation: 'video-query', intervalMs: 2000, backoff: 1.25, maxIntervalMs: 8000, maxDurationMs: 10 * 60_000, status: { pending: ['queued', 'pending', 'processing', 'running'], success: ['succeeded', 'success', 'completed', 'done'], failure: ['failed', 'failure', 'error', 'canceled', 'cancelled', 'timeout', 'rejected'] } }, result: { kind: 'video', source: 'resultUrl' } },
  },
  modelProfiles: {
    seedream: {
      label: '豆包 Seedream', match: ['doubao-seedream', 'seedream'], capabilities: ['image.generate', 'image.edit'], workflows: { 'image.generate': 'image', 'image.edit': 'image' }, uiSchemas: ['volcengine-image'],
      assets: { images: { mode: 'data_url', maxBytes: 20_971_520, maxDimension: 4096, mimeTypes: ['image/*'] } }, defaults: { size: '2048x2048', response_format: 'url' }, limits: { references: { images: { max: 9 } } },
    },
    seedance: {
      label: '豆包 Seedance', match: ['doubao-seedance', 'seedance'], capabilities: Object.keys(volcengineWorkflows), workflows: volcengineWorkflows, uiSchemas: ['volcengine-video'],
      assets: { images: { mode: 'data_url', maxBytes: 20_971_520, maxDimension: 4096, mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: false, watermark: false },
      limits: { duration: { min: 1, max: 60, step: 1, integer: true, default: 5 }, aspect_ratio: { options: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'], default: '16:9' }, resolution: { options: ['480p', '720p', '1080p'], default: '720p' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
    },
    endpoint: {
      label: '方舟推理接入点', match: [''], capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools', 'image.generate', 'image.edit', ...Object.keys(volcengineWorkflows)],
      workflows: { 'llm.chat': 'chat', 'llm.chat.vision': 'vision', 'llm.tools': 'chat', 'image.generate': 'image', 'image.edit': 'image', ...volcengineWorkflows },
      assets: { images: { mode: 'data_url', maxBytes: 20_971_520, maxDimension: 4096, mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } },
    },
  },
  uiSchemas: {
    'volcengine-image': [
      { key: 'size', label: '尺寸', description: 'Seedream 5.0 建议从 2K 起步。', type: 'select', default: '2048x2048', options: ['2048x2048', '2048x3072', '3072x2048', '4096x4096'].map((value) => ({ label: value, value })) },
    ],
    'volcengine-video': [
      { key: 'duration', label: '视频时长', type: 'number', default: 5, min: 1, max: 60, step: 1 },
      { key: 'aspect_ratio', label: '画面比例', type: 'select', default: '16:9', options: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '输出清晰度', type: 'select', default: '720p', options: ['480p', '720p', '1080p'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'generate_audio', label: '生成音频', type: 'toggle', default: false },
      { key: 'watermark', label: '添加水印', type: 'toggle', default: false },
      { key: 'camerafixed', label: '固定镜头', type: 'toggle', default: false },
    ],
  },
}

/** Volcengine Doubao Speech uses a dedicated host and X-Api-Key, not Ark auth. */
const volcengineSpeechProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'volcengine-speech', label: '豆包语音模型',
  summary: '豆包语音合成 2.0、声音复刻 2.0 与 Seed Audio 1.0 的官方 HTTP 协议。',
  executor: { type: 'declarative', engine: '>=1.0.0' }, capabilities: ['audio.tts', 'audio.music'],
  operations: {
    'tts-unidirectional': {
      method: 'POST', path: '/api/v3/tts/unidirectional', requestMode: 'json', responseMode: 'ndjson', omitEmpty: true, timeoutMs: 300000,
      headersTemplate: {
        'Content-Type': 'application/json', 'X-Api-Resource-Id': '{{model}}', 'X-Api-Request-Id': '{{requestId}}', 'X-Control-Require-Usage-Tokens-Return': '*',
      },
      bodyTemplate: { req_params: {
        text: '{{prompt}}', speaker: '{{params.speaker}}', ssml: '{{params.ssml}}', model: '{{params.voice_model}}',
        audio_params: { format: { $coalesce: ['{{params.response_format}}', 'mp3'] }, sample_rate: { $coalesce: ['{{params.sample_rate}}', 24000] }, speech_rate: '{{params.speech_rate}}', loudness_rate: '{{params.loudness_rate}}', pitch_rate: '{{params.pitch_rate}}' },
        additions: '{{params.additions}}', context_texts: '{{params.context_texts}}', section_id: '{{params.section_id}}',
      } },
      response: { resultData: '$.concatenatedBase64', errorCode: '$.code', errorMessage: '$.message', usage: '$.usage' },
    },
    'audio-create': {
      method: 'POST', path: '/api/v3/tts/create', requestMode: 'json', omitEmpty: true, timeoutMs: 300000,
      headersTemplate: { 'Content-Type': 'application/json', 'X-Api-Request-Id': '{{requestId}}' },
      bodyTemplate: {
        model: 'seed-audio-1.0', text_prompt: '{{prompt}}',
        references: { $concat: [
          [{ speaker: '{{params.speaker}}' }],
          { $map: { from: '{{inputs.audios}}', template: { audio_data: { $dataUrlBase64: '{{item.dataUrl}}' } } } },
          { $map: { from: '{{inputs.images}}', template: { image_data: { $dataUrlBase64: '{{item.dataUrl}}' } } } },
        ] },
        audio_config: { format: { $coalesce: ['{{params.response_format}}', 'mp3'] }, sample_rate: { $coalesce: ['{{params.sample_rate}}', 48000] }, speech_rate: '{{params.speech_rate}}', loudness_rate: '{{params.loudness_rate}}', pitch_rate: '{{params.pitch_rate}}', enable_subtitle: '{{params.enable_subtitle}}' },
        watermark: { aigc_watermark: '{{params.watermark}}' },
      },
      response: { resultUrl: '$.url', resultData: '$.audio', errorCode: '$.code', errorMessage: '$.message' },
    },
  },
  workflows: {
    tts: { submit: 'tts-unidirectional', result: { kind: 'audio', source: 'resultUrl', mime: 'audio/mpeg' } },
    'audio-generate': { submit: 'audio-create', result: { kind: 'audio', source: 'resultUrl', mime: 'audio/mpeg' } },
  },
  modelProfiles: {
    'seed-tts-2.0': {
      label: '豆包语音合成 2.0', capabilities: ['audio.tts'], workflows: { 'audio.tts': 'tts' }, uiSchemas: ['volcengine-tts'],
      defaults: { speaker: 'zh_female_vv_uranus_bigtts', response_format: 'mp3', sample_rate: 24000, speech_rate: 0, loudness_rate: 0, pitch_rate: 0 },
      limits: { text: { maxLength: 3000 } },
    },
    'seed-icl-2.0': {
      label: '豆包声音复刻 2.0', capabilities: ['audio.tts'], workflows: { 'audio.tts': 'tts' }, uiSchemas: ['volcengine-tts'],
      defaults: { response_format: 'mp3', sample_rate: 24000, speech_rate: 0, loudness_rate: 0, pitch_rate: 0 }, limits: { text: { maxLength: 3000 } },
    },
    'seed-audio-1.0': {
      label: '豆包音频生成 1.0', capabilities: ['audio.music'], workflows: { 'audio.music': 'audio-generate' }, uiSchemas: ['volcengine-audio-generate'],
      assets: { audios: { mode: 'data_url', maxBytes: 10_485_760, mimeTypes: ['audio/wav', 'audio/mpeg', 'audio/pcm', 'audio/ogg'] }, images: { mode: 'data_url', maxBytes: 10_485_760, mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] } },
      defaults: { response_format: 'mp3', sample_rate: 48000 }, limits: { text: { maxLength: 3000 }, references: { audios: { max: 3 }, images: { max: 1 } }, duration: { max: 120 } },
    },
  },
  uiSchemas: {
    'volcengine-tts': [
      { key: 'speaker', label: '音色 ID', type: 'text', default: 'zh_female_vv_uranus_bigtts' },
      { key: 'response_format', label: '格式', type: 'select', default: 'mp3', options: ['mp3', 'wav', 'pcm', 'ogg_opus'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'sample_rate', label: '采样率', type: 'select', default: 24000, options: [16000, 24000, 32000, 44100, 48000].map((value) => ({ label: `${value} Hz`, value })) },
      { key: 'speech_rate', label: '语速', type: 'slider', default: 0, min: -50, max: 100, step: 1 },
      { key: 'loudness_rate', label: '音量', type: 'slider', default: 0, min: -50, max: 100, step: 1 },
      { key: 'pitch_rate', label: '音调', type: 'number', default: 0, min: -12, max: 12, step: 1 },
    ],
    'volcengine-audio-generate': [
      { key: 'speaker', label: '参考音色 ID（可选）', type: 'text', default: '' },
      { key: 'response_format', label: '格式', type: 'select', default: 'mp3', options: ['mp3', 'wav', 'pcm', 'ogg_opus'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'sample_rate', label: '采样率', type: 'select', default: 48000, options: [16000, 24000, 32000, 44100, 48000].map((value) => ({ label: `${value} Hz`, value })) },
      { key: 'enable_subtitle', label: '返回字幕时间轴', type: 'toggle', default: false },
      { key: 'watermark', label: 'AIGC 音频水印', type: 'toggle', default: false },
    ],
  },
}

/** Official xAI API (api.x.ai), kept separate from the third-party Grok2API gateway. */
const xaiProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'xai', label: 'Grok 官方能力协议',
  summary: 'Grok 官方 Responses/Chat、Imagine 2.0 图片和 Imagine Video 1.5 异步视频协议。',
  executor: { type: 'declarative', engine: '>=1.0.0' },
  capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools', 'llm.responses', 'llm.structured_output', 'image.generate', 'image.edit', 'video.generate', 'video.text_to_video', 'video.image_to_video'],
  operations: {
    'llm-chat': {
      method: 'POST', path: '/v1/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], temperature: '{{params.temperature}}', max_tokens: '{{params.max_tokens}}', response_format: '{{params.response_format}}' },
      response: { text: '$.choices[0].message.content', usage: '$.usage', errorMessage: ['$.error.message', '$.message'] },
    },
    'llm-vision': {
      method: 'POST', path: '/v1/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: { model: '{{model}}', messages: [{ role: 'user', content: { $concat: [[{ type: 'text', text: '{{prompt}}' }], { $map: { from: '{{inputs.images}}', template: { type: 'image_url', image_url: { url: '{{item.dataUrl}}' } } } }] } }], max_tokens: '{{params.max_tokens}}' },
      response: { text: '$.choices[0].message.content', usage: '$.usage', errorMessage: ['$.error.message', '$.message'] },
    },
    'llm-tools': {
      method: 'POST', path: '/v1/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], tools: '{{params.tools}}', tool_choice: '{{params.tool_choice}}' },
      response: { text: ['$.choices[0].message.content', '$.choices[0].message.tool_calls'], usage: '$.usage', errorMessage: ['$.error.message', '$.message'] },
    },
    'llm-structured': {
      method: 'POST', path: '/v1/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], response_format: '{{params.response_format}}' },
      response: { text: '$.choices[0].message.content', usage: '$.usage', errorMessage: ['$.error.message', '$.message'] },
    },
    'llm-responses': {
      method: 'POST', path: '/v1/responses', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: { model: '{{model}}', input: '{{prompt}}', instructions: '{{params.instructions}}', max_output_tokens: '{{params.max_output_tokens}}', tools: '{{params.tools}}' },
      response: { text: ['$.output_text', '$.output[*].content[*].text'], output: '$.output', usage: '$.usage', errorMessage: ['$.error.message', '$.message'] },
    },
    'image-generate': {
      method: 'POST', path: '/v1/images/generations', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: { model: '{{model}}', prompt: '{{prompt}}', n: '{{params.n}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', quality: '{{params.quality}}', response_format: 'url' },
      response: { resultUrls: ['$.data[*].url', '$.data[*].b64_json'], errorMessage: ['$.error.message', '$.message'] },
    },
    'image-edit': {
      method: 'POST', path: '/v1/images/edits', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}',
        images: { $map: { from: '{{inputs.images}}', template: { type: 'image_url', url: '{{item.dataUrl}}' } } },
        aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', quality: '{{params.quality}}', response_format: 'url',
      },
      response: { resultUrls: ['$.data[*].url', '$.data[*].b64_json'], errorMessage: ['$.error.message', '$.message'] },
    },
    'video-generate': {
      method: 'POST', path: '/v1/videos/generations', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', duration: '{{params.duration}}', aspect_ratio: '{{params.aspect_ratio}}', resolution: '{{params.resolution}}', generate_audio: '{{params.generate_audio}}',
        image: { url: '{{inputs.images[0].dataUrl}}' },
      },
      response: { taskId: '$.request_id', resultUrl: '$.video.url', errorMessage: ['$.error.message', '$.message'] },
    },
    'video-query': {
      method: 'GET', path: '/v1/videos/{taskId}', requestMode: 'json',
      response: { status: '$.status', resultUrl: '$.video.url', errorMessage: ['$.error.message', '$.message'] },
    },
  },
  workflows: {
    'chat': { submit: 'llm-chat', result: { kind: 'text', source: 'response' } },
    'vision': { submit: 'llm-vision', result: { kind: 'text', source: 'response' } },
    'tools': { submit: 'llm-tools', result: { kind: 'text', source: 'response' } },
    'structured': { submit: 'llm-structured', result: { kind: 'text', source: 'response' } },
    'responses': { submit: 'llm-responses', result: { kind: 'text', source: 'response' } },
    'image-generate': { submit: 'image-generate', result: { kind: 'image', source: 'resultUrl' } },
    'image-edit': { submit: 'image-edit', result: { kind: 'image', source: 'resultUrl' } },
    'video-generate': {
      submit: 'video-generate', poll: { operation: 'video-query', intervalMs: 3000, backoff: 1.2, maxIntervalMs: 8000, maxDurationMs: 15 * 60_000, status: { pending: ['pending'], success: ['done'], failure: ['failed', 'expired'] } },
      result: { kind: 'video', source: 'resultUrl' },
    },
  },
  modelProfiles: {
    'grok-imagine-image-2.0': {
      label: 'Grok Imagine Image 2.0', match: ['grok-imagine-image-2.0'], capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'image-generate', 'image.edit': 'image-edit' }, uiSchemas: ['xai-image'],
      assets: { images: { mode: 'data_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] } }, defaults: { n: 1, aspect_ratio: 'auto', resolution: '1k', quality: 'auto' },
      limits: { references: { images: { max: 5 } }, output: { count: { min: 1, max: 10 } } },
    },
    'grok-imagine-video-1.5': {
      label: 'Grok Imagine Video 1.5', match: ['grok-imagine-video-1.5'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video'],
      workflows: { 'video.generate': 'video-generate', 'video.text_to_video': 'video-generate', 'video.image_to_video': 'video-generate' }, uiSchemas: ['xai-video'],
      assets: { images: { mode: 'data_url', maxBytes: 20_971_520, mimeTypes: ['image/*'] } }, defaults: { duration: 8, aspect_ratio: '16:9', resolution: '480p', generate_audio: true },
      limits: { duration: { min: 1, max: 15, step: 1, integer: true, default: 8 }, aspect_ratio: { options: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'], default: '16:9' }, resolution: { options: ['480p', '720p', '1080p'], default: '480p' }, references: { images: { max: 1 } } },
    },
    'grok-text': {
      label: 'Grok Text', match: ['grok-'], capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools', 'llm.responses', 'llm.structured_output'],
      workflows: { 'llm.chat': 'chat', 'llm.chat.vision': 'vision', 'llm.tools': 'tools', 'llm.responses': 'responses', 'llm.structured_output': 'structured' }, uiSchemas: ['xai-chat'],
    },
  },
  uiSchemas: {
    'xai-chat': [
      { key: 'temperature', label: '温度', type: 'slider', default: 0.7, min: 0, max: 2, step: 0.1 },
      { key: 'max_tokens', label: '最大输出', type: 'number', default: 4096, min: 1, max: 131072 },
    ],
    'xai-image': [
      { key: 'aspect_ratio', label: '比例', type: 'select', default: 'auto', options: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '1k', options: ['1k', '2k'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'quality', label: '质量', type: 'select', default: 'auto', options: ['auto', 'low', 'medium'].map((value) => ({ label: value, value })) },
      { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 10, step: 1 },
    ],
    'xai-video': [
      { key: 'duration', label: '时长', type: 'number', default: 8, min: 1, max: 15, step: 1 },
      { key: 'aspect_ratio', label: '比例', type: 'select', default: '16:9', options: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '480p', options: ['480p', '720p', '1080p'].map((value) => ({ label: value.toUpperCase(), value })) },
      { key: 'generate_audio', label: '生成音频', type: 'toggle', default: true },
    ],
  },
}

/** MiniMax official China API (api.minimax.cn). */
const minimaxProtocol = {
  schemaVersion: 'dx-protocol/v2', kind: 'model', id: 'minimax', label: 'MiniMax 官方模型',
  summary: 'MiniMax 官方 M3/M2 对话、image-01 图片、H3 视频和 Speech 语音协议。',
  executor: { type: 'declarative', engine: '>=1.0.0' },
  capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools', 'image.generate', 'image.edit', 'video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal', 'audio.tts'],
  operations: {
    'llm-chat': {
      method: 'POST', path: '/v1/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }],
        temperature: '{{params.temperature}}', top_p: '{{params.top_p}}', max_completion_tokens: { $coalesce: ['{{params.max_completion_tokens}}', '{{params.max_tokens}}'] },
        thinking: '{{params.thinking}}', reasoning_split: '{{params.reasoning_split}}',
      },
      response: { text: '$.choices[0].message.content', usage: '$.usage', errorMessage: ['$.error.message', '$.base_resp.status_msg', '$.message'] },
    },
    'llm-vision': {
      method: 'POST', path: '/v1/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', messages: [{ role: 'user', content: { $concat: [
          [{ type: 'text', text: '{{prompt}}' }],
          { $map: { from: '{{inputs.images}}', template: { type: 'image_url', image_url: { url: '{{item.dataUrl}}', detail: '{{params.detail}}' } } } },
        ] } }],
        temperature: '{{params.temperature}}', top_p: '{{params.top_p}}', max_completion_tokens: { $coalesce: ['{{params.max_completion_tokens}}', '{{params.max_tokens}}'] },
        thinking: '{{params.thinking}}', reasoning_split: '{{params.reasoning_split}}',
      },
      response: { text: '$.choices[0].message.content', usage: '$.usage', errorMessage: ['$.error.message', '$.base_resp.status_msg', '$.message'] },
    },
    'llm-tools': {
      method: 'POST', path: '/v1/chat/completions', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], tools: '{{params.tools}}', tool_choice: '{{params.tool_choice}}',
        temperature: '{{params.temperature}}', top_p: '{{params.top_p}}', max_completion_tokens: { $coalesce: ['{{params.max_completion_tokens}}', '{{params.max_tokens}}'] },
        thinking: '{{params.thinking}}', reasoning_split: '{{params.reasoning_split}}',
      },
      response: { text: ['$.choices[0].message.content', '$.choices[0].message.tool_calls'], usage: '$.usage', errorMessage: ['$.error.message', '$.base_resp.status_msg', '$.message'] },
    },
    'image-generate': {
      method: 'POST', path: '/v1/image_generation', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', aspect_ratio: '{{params.aspect_ratio}}', response_format: 'url', n: '{{params.n}}',
        seed: '{{params.seed}}', prompt_optimizer: '{{params.prompt_optimizer}}', aigc_watermark: '{{params.watermark}}', style: '{{params.style}}',
      },
      response: { resultUrls: '$.data.image_urls[*]', errorCode: ['$.base_resp.status_code', '$.error.code'], errorMessage: ['$.base_resp.status_msg', '$.error.message', '$.message'] },
    },
    'image-edit': {
      method: 'POST', path: '/v1/image_generation', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', aspect_ratio: '{{params.aspect_ratio}}', response_format: 'url', n: '{{params.n}}',
        seed: '{{params.seed}}', prompt_optimizer: '{{params.prompt_optimizer}}', aigc_watermark: '{{params.watermark}}', style: '{{params.style}}',
        subject_reference: { $map: { from: '{{inputs.images}}', template: { type: 'character', image_file: '{{item.url}}' } } },
      },
      response: { resultUrls: '$.data.image_urls[*]', errorCode: ['$.base_resp.status_code', '$.error.code'], errorMessage: ['$.base_resp.status_msg', '$.error.message', '$.message'] },
    },
    'video-submit': {
      method: 'POST', path: '/v2/video_generation', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}',
        content: { $concat: [
          [{ type: 'text', text: '{{prompt}}' }],
          { $map: { from: '{{inputs.images}}', template: { type: 'image_url', image_url: { url: '{{item.url}}' }, role: { $coalesce: ['{{item.role}}', 'reference_image'] } } } },
          { $map: { from: '{{inputs.videos}}', template: { type: 'video_url', video_url: { url: '{{item.url}}' }, role: 'reference_video' } } },
          { $map: { from: '{{inputs.audios}}', template: { type: 'audio_url', audio_url: { url: '{{item.url}}' }, role: 'reference_audio' } } },
        ] },
        resolution: '{{params.resolution}}', duration: '{{params.duration}}', ratio: '{{params.aspect_ratio}}', aigc_watermark: '{{params.watermark}}',
      },
      response: { taskId: '$.task_id', status: '$.status', errorCode: ['$.base_resp.status_code', '$.error.code'], errorMessage: ['$.base_resp.status_msg', '$.error.message', '$.message'] },
    },
    'video-query': {
      method: 'GET', path: '/v2/query/video_generation/{taskId}', requestMode: 'json',
      response: { taskId: '$.task.id', status: '$.task.status', resultUrl: '$.task.content.url', errorCode: ['$.base_resp.status_code', '$.error.code'], errorMessage: ['$.task.error.message', '$.base_resp.status_msg', '$.error.message', '$.message'] },
    },
    'tts': {
      method: 'POST', path: '/v1/t2a_v2', requestMode: 'json', omitEmpty: true,
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}', text: '{{prompt}}', stream: false, output_format: 'url',
        voice_setting: {
          voice_id: { $coalesce: ['{{params.voice_id}}', '{{params.voice}}', 'male-qn-qingse'] }, speed: '{{params.speed}}', vol: '{{params.vol}}', pitch: '{{params.pitch}}', emotion: '{{params.emotion}}',
        },
        audio_setting: { sample_rate: '{{params.sample_rate}}', bitrate: '{{params.bitrate}}', format: '{{params.response_format}}', channel: '{{params.channel}}' },
      },
      response: { resultUrl: '$.data.audio', errorCode: ['$.base_resp.status_code', '$.error.code'], errorMessage: ['$.base_resp.status_msg', '$.error.message', '$.message'] },
    },
  },
  workflows: {
    chat: { submit: 'llm-chat', result: { kind: 'text', source: 'response' } },
    vision: { submit: 'llm-vision', result: { kind: 'text', source: 'response' } },
    tools: { submit: 'llm-tools', result: { kind: 'text', source: 'response' } },
    'image-generate': { submit: 'image-generate', result: { kind: 'image', source: 'resultUrl' } },
    'image-edit': { submit: 'image-edit', result: { kind: 'image', source: 'resultUrl' } },
    'video-generate': {
      submit: 'video-submit', poll: { operation: 'video-query', intervalMs: 5000, backoff: 1.25, maxIntervalMs: 15_000, maxDurationMs: 15 * 60_000, status: { pending: ['queued', 'running'], success: ['succeeded'], failure: ['failed', 'cancelled'] } },
      result: { kind: 'video', source: 'resultUrl' },
    },
    speech: { submit: 'tts', result: { kind: 'audio', source: 'resultUrl' } },
  },
  modelProfiles: {
    'minimax-h3-max': {
      label: 'MiniMax H3-Max', match: ['minimax-h3-max'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame'],
      workflows: { 'video.generate': 'video-generate', 'video.text_to_video': 'video-generate', 'video.image_to_video': 'video-generate', 'video.first_last_frame': 'video-generate' }, uiSchemas: ['minimax-h3-max-video'],
      assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] } }, defaults: { duration: 5, aspect_ratio: '16:9', resolution: '768P', watermark: false },
      limits: { duration: { min: 5, max: 15, step: 1, integer: true, default: 5 }, aspect_ratio: { options: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], default: '16:9' }, resolution: { options: ['480P', '768P'], default: '768P' }, references: { images: { max: 2 }, videos: { max: 0 }, audios: { max: 0 } } },
    },
    'minimax-h3': {
      label: 'MiniMax H3', match: ['minimax-h3'], capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.video_to_video', 'video.audio_reference', 'video.multimodal'],
      workflows: { 'video.generate': 'video-generate', 'video.text_to_video': 'video-generate', 'video.image_to_video': 'video-generate', 'video.first_last_frame': 'video-generate', 'video.multi_reference': 'video-generate', 'video.video_to_video': 'video-generate', 'video.audio_reference': 'video-generate', 'video.multimodal': 'video-generate' }, uiSchemas: ['minimax-video'],
      assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] }, videos: { mode: 'public_url', mimeTypes: ['video/*'] }, audios: { mode: 'public_url', mimeTypes: ['audio/*'] } }, defaults: { duration: 5, aspect_ratio: '16:9', resolution: '768P', watermark: false },
      limits: { duration: { min: 4, max: 15, step: 1, integer: true, default: 5 }, aspect_ratio: { options: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], default: '16:9' }, resolution: { options: ['768P', '2K'], default: '768P' }, references: { images: { max: 9 }, videos: { max: 3 }, audios: { max: 3 } } },
    },
    'minimax-m3': {
      label: 'MiniMax M3', match: ['minimax-m3'], capabilities: ['llm.chat', 'llm.chat.vision', 'llm.tools'],
      workflows: { 'llm.chat': 'chat', 'llm.chat.vision': 'vision', 'llm.tools': 'tools' }, uiSchemas: ['minimax-chat'],
      assets: { images: { mode: 'data_url', maxBytes: 26_214_400, mimeTypes: ['image/*'] } }, defaults: { temperature: 0.7, top_p: 0.95, max_completion_tokens: 8192, reasoning_split: true },
    },
    'minimax-m2': {
      label: 'MiniMax M2', match: ['minimax-m2'], capabilities: ['llm.chat', 'llm.tools'],
      workflows: { 'llm.chat': 'chat', 'llm.tools': 'tools' }, uiSchemas: ['minimax-chat'], defaults: { temperature: 0.7, top_p: 0.95, max_completion_tokens: 8192, reasoning_split: true },
    },
    'image-01-live': {
      label: 'MiniMax image-01-live', match: ['image-01-live'], capabilities: ['image.generate', 'image.edit'], workflows: { 'image.generate': 'image-generate', 'image.edit': 'image-edit' }, uiSchemas: ['minimax-image-live'],
      assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] } }, defaults: { aspect_ratio: '1:1', n: 1, prompt_optimizer: true, watermark: false }, limits: { references: { images: { max: 1 } }, output: { count: { min: 1, max: 9 } } },
    },
    'image-01': {
      label: 'MiniMax image-01', match: ['image-01'], capabilities: ['image.generate', 'image.edit'], workflows: { 'image.generate': 'image-generate', 'image.edit': 'image-edit' }, uiSchemas: ['minimax-image'],
      assets: { images: { mode: 'public_url', mimeTypes: ['image/*'] } }, defaults: { aspect_ratio: '1:1', n: 1, prompt_optimizer: true, watermark: false }, limits: { references: { images: { max: 1 } }, output: { count: { min: 1, max: 9 } } },
    },
    speech: {
      label: 'MiniMax Speech', match: ['speech-'], capabilities: ['audio.tts'], workflows: { 'audio.tts': 'speech' }, uiSchemas: ['minimax-speech'],
      defaults: { voice_id: 'male-qn-qingse', speed: 1, vol: 1, pitch: 0, sample_rate: 32000, bitrate: 128000, response_format: 'mp3', channel: 1 },
    },
  },
  uiSchemas: {
    'minimax-chat': [
      { key: 'temperature', label: '温度', type: 'slider', default: 0.7, min: 0, max: 2, step: 0.1 },
      { key: 'top_p', label: 'Top P', type: 'slider', default: 0.95, min: 0, max: 1, step: 0.05 },
      { key: 'max_completion_tokens', label: '最大输出', type: 'number', default: 8192, min: 1, max: 131072 },
      { key: 'reasoning_split', label: '拆分推理内容', type: 'toggle', default: true },
    ],
    'minimax-image': [
      { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'].map((value) => ({ label: value, value })) },
      { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 9, step: 1 },
      { key: 'prompt_optimizer', label: '提示词优化', type: 'toggle', default: true },
      { key: 'watermark', label: 'AIGC 水印', type: 'toggle', default: false },
      { key: 'seed', label: '随机种子', type: 'number' },
    ],
    'minimax-image-live': [
      { key: 'aspect_ratio', label: '比例', type: 'select', default: '1:1', options: ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'].map((value) => ({ label: value, value })) },
      { key: 'style', label: '风格', type: 'text', default: '' },
      { key: 'n', label: '数量', type: 'number', default: 1, min: 1, max: 9, step: 1 },
      { key: 'prompt_optimizer', label: '提示词优化', type: 'toggle', default: true },
      { key: 'watermark', label: 'AIGC 水印', type: 'toggle', default: false },
    ],
    'minimax-video': [
      { key: 'duration', label: '时长', type: 'number', default: 5, min: 4, max: 15, step: 1 },
      { key: 'aspect_ratio', label: '比例', type: 'select', default: '16:9', options: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '768P', options: ['768P', '2K'].map((value) => ({ label: value, value })) },
      { key: 'watermark', label: 'AIGC 水印', type: 'toggle', default: false },
    ],
    'minimax-h3-max-video': [
      { key: 'duration', label: '时长', type: 'number', default: 5, min: 5, max: 15, step: 1 },
      { key: 'aspect_ratio', label: '比例', type: 'select', default: '16:9', options: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '768P', options: ['480P', '768P'].map((value) => ({ label: value, value })) },
      { key: 'watermark', label: 'AIGC 水印', type: 'toggle', default: false },
    ],
    'minimax-speech': [
      { key: 'voice_id', label: '声音 ID', type: 'text', default: 'male-qn-qingse' },
      { key: 'speed', label: '语速', type: 'slider', default: 1, min: 0.5, max: 2, step: 0.05 },
      { key: 'vol', label: '音量', type: 'slider', default: 1, min: 0, max: 10, step: 0.1 },
      { key: 'pitch', label: '音调', type: 'number', default: 0, min: -12, max: 12, step: 1 },
      { key: 'emotion', label: '情绪', type: 'text', default: '' },
      { key: 'response_format', label: '格式', type: 'select', default: 'mp3', options: ['mp3', 'wav', 'pcm', 'flac'].map((value) => ({ label: value.toUpperCase(), value })) },
    ],
  },
}

const agnesProtocol = {
  schemaVersion: 'dx-protocol/v2',
  kind: 'model',
  id: 'agnes',
  label: 'Agnes AI 图片',
  summary: 'Agnes 图片与已验证视频能力的系统声明式协议；未迁移 Profile/Intent 继续使用 legacy。',
  executor: { type: 'declarative', engine: '>=1.0.0' },
  capabilities: ['image.generate', 'image.edit', 'video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame'],
  operations: {
    'image-generate': {
      method: 'POST',
      path: '/v1/images/generations',
      requestMode: 'json',
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}',
        prompt: '{{prompt}}',
        size: '{{params.size}}',
        extra_body: { response_format: 'url' },
      },
      response: { resultUrls: ['$.data[*].url', '$.data[*].image_url'] },
    },
    'image-edit': {
      method: 'POST',
      path: '/v1/images/generations',
      requestMode: 'json',
      headersTemplate: { 'Content-Type': 'application/json' },
      bodyTemplate: {
        model: '{{model}}',
        prompt: '{{prompt}}',
        size: '{{params.size}}',
        extra_body: { response_format: 'url', image: '{{inputs.images[*].dataUrl}}' },
      },
      response: { resultUrls: ['$.data[*].url', '$.data[*].image_url'] },
    },
    'video-v2-submit': {
      method: 'POST',
      path: '/v1/videos',
      requestMode: 'json',
      headersTemplate: { 'Content-Type': 'application/json' },
      retry: agnesTransientRetry,
      derive: {
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
      },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', width: '{{derived.width}}', height: '{{derived.height}}',
        num_frames: '{{derived.numFrames}}', frame_rate: '{{derived.frameRate}}',
      },
      response: {
        taskId: ['$.video_id', '$.task_id', '$.id'], status: ['$.data.status', '$.status', '$.task_status'],
        resultUrl: ['$.data.video_url', '$.video_url', '$.data.url', '$.url'],
      },
    },
    'video-v2-image-submit': {
      method: 'POST',
      path: '/v1/videos',
      requestMode: 'json',
      headersTemplate: { 'Content-Type': 'application/json' },
      retry: agnesTransientRetry,
      derive: {
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
      },
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', width: '{{derived.width}}', height: '{{derived.height}}',
        num_frames: '{{derived.numFrames}}', frame_rate: '{{derived.frameRate}}', image: '{{inputs.images[0].dataUrl}}',
      },
      response: {
        taskId: ['$.video_id', '$.task_id', '$.id'], status: ['$.data.status', '$.status', '$.task_status'],
        resultUrl: ['$.data.video_url', '$.video_url', '$.data.url', '$.url'],
      },
    },
    'video-v2-keyframe-submit': {
      method: 'POST', path: '/v1/videos', requestMode: 'json', retry: agnesTransientRetry, headersTemplate: { 'Content-Type': 'application/json' },
      derive: agnesVideoV2DerivedFields,
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', width: '{{derived.width}}', height: '{{derived.height}}',
        num_frames: '{{derived.numFrames}}', frame_rate: '{{derived.frameRate}}',
        extra_body: { image: '{{inputs.images[*].dataUrl}}', mode: 'keyframes' },
      },
      response: {
        taskId: ['$.video_id', '$.task_id', '$.id'], status: ['$.data.status', '$.status', '$.task_status'],
        resultUrl: ['$.data.video_url', '$.video_url', '$.data.url', '$.url'],
      },
    },
    'video-2.5-text-submit': {
      method: 'POST', path: '/v1/videos', requestMode: 'json', omitEmpty: true, retry: agnesTransientRetry, headersTemplate: { 'Content-Type': 'application/json' },
      derive: agnesVideo25DerivedFields,
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', mode: 'text', size: '720P', aspect_ratio: '{{derived.ratio}}',
        seconds: '{{derived.seconds}}', n: 1, seed: '{{params.seed}}',
      },
      response: {
        taskId: ['$.video_id', '$.task_id', '$.id'], status: ['$.data.status', '$.status', '$.task_status'],
        resultUrl: ['$.data.video_url', '$.video_url', '$.data.url', '$.url'],
      },
    },
    'video-2.5-reference-submit': {
      method: 'POST', path: '/v1/videos', requestMode: 'json', omitEmpty: true, retry: agnesTransientRetry, headersTemplate: { 'Content-Type': 'application/json' },
      derive: agnesVideo25DerivedFields,
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', mode: 'reference', size: '720P', aspect_ratio: '{{derived.ratio}}',
        seconds: '{{derived.seconds}}', n: 1, images: '{{inputs.images[*].url}}', audios: '{{inputs.audios[*].url}}',
        videos: { $map: { from: '{{inputs.videos}}', template: { url: '{{item.url}}' } } }, seed: '{{params.seed}}',
      },
      response: {
        taskId: ['$.video_id', '$.task_id', '$.id'], status: ['$.data.status', '$.status', '$.task_status'],
        resultUrl: ['$.data.video_url', '$.video_url', '$.data.url', '$.url'],
      },
    },
    'video-2.5-keyframe-submit': {
      method: 'POST', path: '/v1/videos', requestMode: 'json', omitEmpty: true, retry: agnesTransientRetry, headersTemplate: { 'Content-Type': 'application/json' },
      derive: agnesVideo25DerivedFields,
      bodyTemplate: {
        model: '{{model}}', prompt: '{{prompt}}', mode: 'keyframe', size: '720P', aspect_ratio: '{{derived.ratio}}',
        seconds: '{{derived.seconds}}', n: 1,
        first_frame: '{{inputs.images[0].url}}', last_frame: '{{inputs.images[1].url}}', seed: '{{params.seed}}',
      },
      response: {
        taskId: ['$.video_id', '$.task_id', '$.id'], status: ['$.data.status', '$.status', '$.task_status'],
        resultUrl: ['$.metadata.url', '$.data.metadata.url', '$.data.video_url', '$.video_url', '$.data.url', '$.url'],
      },
    },
    'video-v2-query': {
      method: 'GET',
      // Agnes documents a host-root query endpoint even when the configured
      // API base ends in /v1. URL normalization keeps this at /agnesapi.
      path: '/../agnesapi',
      requestMode: 'json',
      queryTemplate: { video_id: '{{captures.taskId}}', model_name: '{{model}}' },
      headersTemplate: { 'Content-Type': 'application/json' },
      retry: agnesTransientRetry,
      fallbacks: [{ path: '/v1/videos/{taskId}', queryTemplate: {}, onStatus: [404] }],
      response: {
        status: ['$.data.status', '$.status', '$.task_status'], progress: ['$.data.progress', '$.progress'],
        resultUrl: ['$.metadata.url', '$.data.metadata.url', '$.data.video_url', '$.video_url', '$.data.url', '$.url'],
        errorCode: ['$.error.code', '$.data.error.code'], errorMessage: ['$.error.message', '$.data.error.message', '$.message'],
      },
    },
  },
  workflows: {
    'image-generate': { submit: 'image-generate', result: { kind: 'image', source: 'resultUrl' } },
    'image-edit': { submit: 'image-edit', result: { kind: 'image', source: 'resultUrl' } },
    'video-v2-text': {
      submit: 'video-v2-submit',
      poll: {
        operation: 'video-v2-query', intervalMs: 5000, backoff: 1.35, maxIntervalMs: 12000,
        status: {
          pending: ['queued', 'pending', 'processing', 'in_progress', 'running'],
          success: ['completed', 'succeeded', 'success'],
          failure: ['failed', 'failure', 'error', 'canceled', 'cancelled', 'timeout', 'rejected'],
        },
      },
      result: { kind: 'video', source: 'resultUrl' },
    },
    'video-v2-image': {
      submit: 'video-v2-image-submit',
      poll: {
        operation: 'video-v2-query', intervalMs: 5000, backoff: 1.35, maxIntervalMs: 12000,
        status: {
          pending: ['queued', 'pending', 'processing', 'in_progress', 'running'],
          success: ['completed', 'succeeded', 'success'],
          failure: ['failed', 'failure', 'error', 'canceled', 'cancelled', 'timeout', 'rejected'],
        },
      },
      result: { kind: 'video', source: 'resultUrl' },
    },
    'video-v2-keyframe': {
      submit: 'video-v2-keyframe-submit',
      poll: {
        operation: 'video-v2-query', intervalMs: 5000, backoff: 1.35, maxIntervalMs: 12000,
        status: {
          pending: ['queued', 'pending', 'processing', 'in_progress', 'running'],
          success: ['completed', 'succeeded', 'success'],
          failure: ['failed', 'failure', 'error', 'canceled', 'cancelled', 'timeout', 'rejected'],
        },
      },
      result: { kind: 'video', source: 'resultUrl' },
    },
    'video-2.5-text': {
      submit: 'video-2.5-text-submit', poll: { ...imagePoll, operation: 'video-v2-query', intervalMs: 5000, maxIntervalMs: 12000 },
      result: { kind: 'video', source: 'resultUrl' },
    },
    'video-2.5-reference': {
      submit: 'video-2.5-reference-submit', poll: { ...imagePoll, operation: 'video-v2-query', intervalMs: 5000, maxIntervalMs: 12000 },
      result: { kind: 'video', source: 'resultUrl' },
    },
    'video-2.5-keyframe': {
      submit: 'video-2.5-keyframe-submit', poll: { ...imagePoll, operation: 'video-v2-query', intervalMs: 5000, maxIntervalMs: 12000 },
      result: { kind: 'video', source: 'resultUrl' },
    },
  },
  modelProfiles: {
    image: {
      label: 'Agnes Image',
      match: ['agnes-image-'],
      capabilities: ['image.generate', 'image.edit'],
      workflows: { 'image.generate': 'image-generate', 'image.edit': 'image-edit' },
      uiSchemas: ['agnes-image'],
      assets: { images: { mode: 'data_url', maxBytes: 52_428_800, mimeTypes: ['image/*'] } },
      defaults: { size: '1024x1024' },
      limits: {
        size: { options: ['1024x1024', '1536x1024', '1024x1536'], default: '1024x1024' },
        references: { images: { max: 8 }, videos: { max: 0 }, audios: { max: 0 } },
      },
    },
    'agnes-video-2.5-flash': {
      label: 'Agnes Video 2.5 Flash', match: ['agnes-video-2.5-flash', 'agnes-video-v2.5-flash'],
      capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference', 'video.audio_reference', 'video.multimodal'],
      workflows: {
        'video.generate': 'video-2.5-text', 'video.text_to_video': 'video-2.5-text',
        'video.image_to_video': 'video-2.5-reference', 'video.first_last_frame': 'video-2.5-keyframe',
        'video.multi_reference': 'video-2.5-reference', 'video.audio_reference': 'video-2.5-reference', 'video.multimodal': 'video-2.5-reference',
      },
      uiSchemas: ['agnes-video-2.5-flash'],
      assets: {
        images: { mode: 'public_url', maxBytes: 15_728_640, mimeTypes: ['image/*'] },
        audios: { mode: 'public_url', maxBytes: 15_728_640, mimeTypes: ['audio/*'] },
      },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p' },
      limits: {
        duration: { min: 4, max: 12, step: 1, integer: true, default: 5 },
        aspect_ratio: { options: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], default: '16:9' },
        resolution: { options: ['720p'], default: '720p' },
        references: { images: { max: 5 }, videos: { max: 0 }, audios: { max: 3 } },
      },
    },
    'agnes-video-2.5': {
      label: 'Agnes Video 2.5', match: ['agnes-video-2.5', 'agnes-video-v2.5'],
      capabilities: [
        'video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.multi_reference',
        'video.video_to_video', 'video.audio_reference', 'video.multimodal',
      ],
      workflows: {
        'video.generate': 'video-2.5-text', 'video.text_to_video': 'video-2.5-text',
        'video.image_to_video': 'video-2.5-reference', 'video.first_last_frame': 'video-2.5-keyframe',
        'video.multi_reference': 'video-2.5-reference', 'video.video_to_video': 'video-2.5-reference',
        'video.audio_reference': 'video-2.5-reference', 'video.multimodal': 'video-2.5-reference',
      },
      uiSchemas: ['agnes-video-2.5'],
      assets: {
        images: { mode: 'public_url', maxBytes: 15_728_640, mimeTypes: ['image/*'] },
        videos: { mode: 'public_url', maxBytes: 52_428_800, mimeTypes: ['video/*'] },
        audios: { mode: 'public_url', maxBytes: 15_728_640, mimeTypes: ['audio/*'] },
      },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p' },
      limits: {
        duration: { min: 4, max: 12, step: 1, integer: true, default: 5 },
        aspect_ratio: { options: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], default: '16:9' },
        resolution: { options: ['720p'], default: '720p' },
        references: { images: { max: 8 }, videos: { max: 1 }, audios: { max: 3 } },
      },
    },
    'video-v2': {
      label: 'Agnes Video v2.0',
      match: ['agnes-video-v2.0'],
      capabilities: ['video.generate', 'video.text_to_video', 'video.image_to_video', 'video.first_last_frame'],
      workflows: {
        'video.generate': 'video-v2-text', 'video.text_to_video': 'video-v2-text', 'video.image_to_video': 'video-v2-image',
        'video.first_last_frame': 'video-v2-keyframe',
      },
      uiSchemas: ['agnes-video-v2'],
      assets: { images: { mode: 'data_url', maxBytes: 52_428_800, mimeTypes: ['image/*'] } },
      defaults: { duration: 5, aspect_ratio: '16:9', resolution: '720p', generate_audio: true, watermark: false },
      limits: {
        duration: { min: 1, max: 18, step: 1, integer: true, default: 5 },
        aspect_ratio: { options: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', '9:21'], default: '16:9' },
        resolution: { options: ['480p', '720p', '1080p'], default: '720p' },
        references: { images: { max: 2 }, videos: { max: 0 }, audios: { max: 0 } },
      },
    },
  },
  uiSchemas: {
    'agnes-image': [
      {
        key: 'size', label: '图片尺寸', type: 'select', default: '1024x1024',
        options: [
          { label: '1:1', value: '1024x1024' },
          { label: '3:2', value: '1536x1024' },
          { label: '2:3', value: '1024x1536' },
        ],
      },
    ],
    'agnes-video-v2': [
      { key: 'duration', label: '视频时长', type: 'number', default: 5, min: 1, max: 18, step: 1 },
      { key: 'aspect_ratio', label: '画面比例', type: 'select', default: '16:9', options: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', '9:21'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '720p', options: ['480p', '720p', '1080p'].map((value) => ({ label: value, value })) },
    ],
    'agnes-video-2.5': [
      { key: 'duration', label: '视频时长', type: 'number', default: 5, min: 4, max: 12, step: 1 },
      { key: 'aspect_ratio', label: '画面比例', type: 'select', default: '16:9', options: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '720p', options: [{ label: '720P', value: '720p' }] },
    ],
    'agnes-video-2.5-flash': [
      { key: 'duration', label: '视频时长', type: 'number', default: 5, min: 4, max: 12, step: 1 },
      { key: 'aspect_ratio', label: '画面比例', type: 'select', default: '16:9', options: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].map((value) => ({ label: value, value })) },
      { key: 'resolution', label: '清晰度', type: 'select', default: '720p', options: [{ label: '720P', value: '720p' }] },
    ],
  },
}

const BUILTIN_MODEL_PROTOCOLS_V2_EXTRA = [
  openAiChatMediaProtocol,
  comflyOpenAiProtocol,
  geminiGenerationsProtocol,
  gptBestImagesProtocol,
  fhlImagesProtocol,
  geminiProtocol,
  geminiGeneralProtocol,
  zkkiImagesProtocol,
  agtokenVideosProtocol,
  apimartImagesProtocol,
  midjourneyProtocol,
  apibImagesProtocol,
  modelScopeImagesProtocol,
  volcengineProtocol,
  volcengineSpeechProtocol,
  xaiProtocol,
  minimaxProtocol,
  agnesProtocol,
];

module.exports = { BUILTIN_MODEL_PROTOCOLS_V2_EXTRA };
